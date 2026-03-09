/**
 * animals/acquisition.js
 * ----------------------
 * How this fits:
 * - Location: src/agents/skills/animals/acquisition.js
 * - Purpose: Given the current herd + household goals, generate a herd
 *   acquisition plan with:
 *    • suggested actions (purchase, breed, trade, cull, lease),
 *    • counts by species/sex/purpose,
 *    • timeline phases (now / upcoming seasons),
 *    • strategy variants that can drive a root-level swap modal.
 *
 * - Downstream:
 *    • Animal “Now” sessions: this plan can be turned into actionable
 *      SessionRunner sessions (e.g., "Evaluate breeders", "Visit sale barn",
 *      "Quarantine new animals").
 *    • Hub: when familyFundMode=true, export to the Family Fund Hub as a
 *      structured plan that other members can see or support.
 *
 * Swap Modal Integration (logic only here):
 * - This module exposes strategyVariants[] in the plan, such as:
 *    • "Balanced Growth" (default)
 *    • "Budget First"
 *    • "Pasture First"
 *    • "Rapid Expansion"
 * - Your root-level swap modal can present these strategies, show differences
 *   (e.g., purchase count vs breed count), and update chosenStrategyId
 *   while the SessionRunner continues in the background.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/events/eventBus";
import { familyFundMode } from "../../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/* -------------------------------------------------------------------------- */
/* Typedefs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {"goat"|"sheep"|"cattle"|"poultry"|"rabbit"|"pig"|"other"} AnimalSpeciesKey
 */

/**
 * @typedef {"buck"|"ram"|"bull"|"boar"|"cock"|"drake"|"stag"|"male"|"doe"|"ewe"|"cow"|"sow"|"hen"|"female"|"unknown"} AnimalSexKey
 */

/**
 * @typedef {"breeding"|"meat"|"milk"|"eggs"|"fiber"|"guardian"|"pet"|"other"} AnimalPurposeKey
 */

/**
 * Simplified herd member capsule for planning.
 *
 * @typedef {Object} HerdAnimalSummary
 * @property {string} id
 * @property {AnimalSpeciesKey} species
 * @property {AnimalSexKey} sex
 * @property {number} ageMonths
 * @property {AnimalPurposeKey[]} purposes
 * @property {boolean} isBreedingCandidate
 * @property {boolean} isForCull
 */

/**
 * Herd goals supplied by the user or higher-level planner.
 *
 * @typedef {Object} HerdAcquisitionGoals
 * @property {AnimalSpeciesKey} species
 * @property {AnimalPurposeKey[]} targetPurposes              - e.g. ["milk","meat"]
 * @property {number} targetTotal                             - desired total herd size for this species.
 * @property {number} minBreedingFemales                      - desired minimum breeding females.
 * @property {number} minBreedingMales                        - desired minimum breeding males/studs.
 * @property {number} [maxBreedingMales]                      - optional ceiling.
 * @property {number} [rotationYears=4]                       - years to cull/replace breeders.
 * @property {number} [budgetUsd]                             - optional cash budget.
 * @property {string[]} [allowedAcquisitionModes]             - ["purchase","breed","trade","lease","none"].
 * @property {string|null} [dueBy]                            - ISO date by which the target should be met.
 */

/**
 * Context about the homestead capacity and constraints.
 *
 * @typedef {Object} HerdContext
 * @property {number} [pastureCapacityHead]                   - safe grazing capacity (head).
 * @property {number} [housingCapacityHead]                   - shelter-capable capacity.
 * @property {number} [feedCostIndex]                         - relative feed cost (1=baseline).
 * @property {string} [climateZone]                           - e.g. "8a".
 * @property {boolean} [hasIrrigation]
 * @property {boolean} [hasFencingForSpecies]                 - coarse flag; fine-grained checks can be added.
 */

/**
 * Plan action types.
 *
 * @typedef {"purchase"|"breed"|"trade"|"lease"|"cull"|"delay"} AcquisitionActionType
 */

/**
 * One line item in the acquisition plan.
 *
 * @typedef {Object} AcquisitionAction
 * @property {string} id
 * @property {AcquisitionActionType} type
 * @property {AnimalSpeciesKey} species
 * @property {AnimalSexKey|"mixed"} sex
 * @property {AnimalPurposeKey|"mixed"} purpose
 * @property {number} count
 * @property {string} whenPhase                               - "now"|"next-season"|"future"|"after-cull"
 * @property {string} reason                                  - human-friendly explanation.
 * @property {number|null} estCostUsd                         - expected additional cash cost (if applicable).
 * @property {string[]} blockers                              - ["budget","housing","pasture","unknown"].
 * @property {Object} meta                                    - additional detail for UI.
 */

/**
 * Strategy variant for swap modal.
 *
 * @typedef {Object} AcquisitionStrategyVariant
 * @property {string} id
 * @property {string} label
 * @property {string} summary
 * @property {string[]} badges                                - e.g. ["DEFAULT","BUDGET-FIRST"].
 * @property {boolean} autoSelected
 * @property {Partial<AcquisitionPlan>} overrides             - changes applied on top of baseline plan.
 */

/**
 * Top-level acquisition plan.
 *
 * @typedef {Object} AcquisitionPlan
 * @property {string} id
 * @property {AnimalSpeciesKey} species
 * @property {HerdAcquisitionGoals} goals
 * @property {HerdContext} context
 * @property {HerdAnimalSummary[]} herdSnapshot
 * @property {AcquisitionAction[]} actions
 * @property {AcquisitionStrategyVariant[]} strategyVariants
 * @property {string|null} chosenStrategyId
 * @property {string[]} notes
 * @property {Object} meta
 */

/**
 * Options for the planner.
 *
 * @typedef {Object} AcquisitionPlanOptions
 * @property {string} [eventSource="animals"]
 * @property {number} [nowTs]
 * @property {Record<string,string>} [chosenStrategyByPlanId] - For resume; planId -> strategyId.
 */

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emit an SSA event with typed payload.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emit(type, source, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[animals/acquisition] Failed to emit event:", type, err);
  }
}

/**
 * Coerce to finite number or fallback.
 * @param {any} value
 * @param {number} fallback
 * @returns {number}
 */
function numOr(value, fallback) {
  return Number.isFinite(value) ? Number(value) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Herd analysis helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Summarize herd counts for one species by sex and breeder status.
 *
 * @param {HerdAnimalSummary[]} herd
 * @param {AnimalSpeciesKey} species
 * @returns {{
 *   total: number,
 *   breedersFemale: number,
 *   breedersMale: number,
 *   cullCandidates: number
 * }}
 */
function analyzeHerdForSpecies(herd, species) {
  let total = 0;
  let breedersFemale = 0;
  let breedersMale = 0;
  let cullCandidates = 0;

  for (const a of herd) {
    if (a.species !== species) continue;
    total += 1;
    if (a.isForCull) cullCandidates += 1;
    if (a.isBreedingCandidate) {
      const s = a.sex.toLowerCase();
      if (
        s === "doe" ||
        s === "ewe" ||
        s === "cow" ||
        s === "sow" ||
        s === "hen" ||
        s === "female"
      ) {
        breedersFemale += 1;
      } else if (
        s === "buck" ||
        s === "ram" ||
        s === "bull" ||
        s === "boar" ||
        s === "cock" ||
        s === "drake" ||
        s === "stag" ||
        s === "male"
      ) {
        breedersMale += 1;
      }
    }
  }

  return { total, breedersFemale, breedersMale, cullCandidates };
}

/**
 * Rough capacity check: compare target herd against pasture + housing.
 *
 * @param {HerdContext} context
 * @param {number} currentSpeciesTotal
 * @param {number} plannedDelta
 * @returns {string[]} blockers
 */
function computeCapacityBlockers(context, currentSpeciesTotal, plannedDelta) {
  const blockers = [];
  const pastureCap = numOr(context.pastureCapacityHead, Infinity);
  const housingCap = numOr(context.housingCapacityHead, Infinity);

  const projected = currentSpeciesTotal + plannedDelta;
  if (projected > pastureCap) blockers.push("pasture");
  if (projected > housingCap) blockers.push("housing");

  return blockers;
}

/**
 * Estimate cost for purchase/trade/lease actions.
 *
 * NOTE: This is intentionally crude; Dexie or configuration can override
 * with species-specific pricing tables later.
 *
 * @param {AnimalSpeciesKey} species
 * @param {AcquisitionActionType} type
 * @param {number} count
 * @param {HerdContext} context
 * @returns {number|null}
 */
function estimateCostUsd(species, type, count, context) {
  if (!count || count <= 0) return null;
  const basePriceMap = {
    goat: 250,
    sheep: 225,
    cattle: 1500,
    poultry: 15,
    rabbit: 30,
    pig: 350,
    other: 200,
  };

  const base = basePriceMap[species] ?? basePriceMap.other;
  const feedIdx = numOr(context.feedCostIndex, 1);
  const typeFactor = type === "purchase" ? 1 : type === "lease" ? 0.3 : 0.1;

  return Math.round(base * feedIdx * typeFactor * count);
}

/* -------------------------------------------------------------------------- */
/* Strategy variants (for swap modal)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build strategy variants on top of a baseline action list.
 *
 * Strategies:
 *  - Balanced Growth (default)
 *  - Budget First
 *  - Pasture First
 *  - Rapid Expansion
 *
 * Variants are expressed as overrides so the swap modal can preview
 * the differences without re-running heavy logic.
 *
 * @param {AcquisitionAction[]} baseActions
 * @param {HerdAcquisitionGoals} goals
 * @param {HerdContext} context
 * @returns {AcquisitionStrategyVariant[]}
 */
function buildStrategyVariants(baseActions, goals, context) {
  const species = goals.species;
  const baseBudget = numOr(goals.budgetUsd, 0);

  const balanced = /** @type {AcquisitionStrategyVariant} */ ({
    id: "balanced-growth",
    label: "Balanced Growth",
    summary:
      "Mix of breeding and purchase, respecting budget and capacity where possible.",
    badges: ["DEFAULT", "BALANCED"],
    autoSelected: true,
    overrides: {},
  });

  const budgetFirst = /** @type {AcquisitionStrategyVariant} */ ({
    id: "budget-first",
    label: "Budget First",
    summary:
      "Prefer breeding and culling adjustments over new purchases; keep cash outlay low.",
    badges: ["BUDGET-FIRST"],
    autoSelected: false,
    overrides: {
      actions: baseActions.map((a) => {
        if (a.type === "purchase") {
          // Shift some purchases to breeding or delay.
          const half = Math.floor(a.count / 2);
          const delayCount = a.count - half;
          if (half <= 0) {
            return {
              ...a,
              type: "delay",
              whenPhase: "future",
              reason:
                "Budget-first: delay purchase until more cash or support is available.",
              estCostUsd: 0,
            };
          }
          return {
            ...a,
            count: half,
            estCostUsd: a.estCostUsd ? Math.round(a.estCostUsd * 0.5) : null,
            reason:
              "Budget-first: reduce immediate purchases, rely more on breeding and culling.",
          };
        }
        return a;
      }),
      meta: {
        strategyNotes: [
          "Budget-first strategy: reduce purchases; lean on breeding and herd refinement.",
          baseBudget
            ? `Goal: keep added cash costs under $${baseBudget.toFixed(0)}.`
            : "No budget specified; still attempting to reduce cash outlay.",
        ],
      },
    },
  });

  const pastureFirst = /** @type {AcquisitionStrategyVariant} */ ({
    id: "pasture-first",
    label: "Pasture First",
    summary:
      "Prioritize staying under grazing capacity; prefer slower growth and lower headcount.",
    badges: ["PASTURE-FIRST"],
    autoSelected: false,
    overrides: {
      actions: baseActions.map((a) => {
        if (a.type === "purchase") {
          // Delay some or all purchases if context is tight.
          const blockers = computeCapacityBlockers(context, 0, a.count);
          if (blockers.includes("pasture")) {
            return {
              ...a,
              type: "delay",
              whenPhase: "future",
              blockers: [...(a.blockers || []), "pasture"],
              reason:
                "Pasture-first: delay expansion until grazing capacity is improved.",
              estCostUsd: 0,
            };
          }
        }
        return a;
      }),
      meta: {
        strategyNotes: [
          "Pasture-first strategy: keep herd within grazing capacity, even if growth is slower.",
        ],
      },
    },
  });

  const rapidExpansion = /** @type {AcquisitionStrategyVariant} */ ({
    id: "rapid-expansion",
    label: "Rapid Expansion",
    summary:
      "Aggressively reach target herd size; front-load purchases, accept higher cost and capacity pressure.",
    badges: ["RAPID", "HIGH-RISK"],
    autoSelected: false,
    overrides: {
      actions: baseActions.map((a) => {
        if (a.type === "purchase") {
          const extra = Math.ceil(a.count * 0.25);
          const newCount = a.count + extra;
          return {
            ...a,
            count: newCount,
            estCostUsd: a.estCostUsd
              ? Math.round(a.estCostUsd * 1.25)
              : estimateCostUsd(species, "purchase", newCount, context),
            reason:
              "Rapid expansion: front-load purchases to reach target herd faster; monitor pasture and housing closely.",
          };
        }
        return a;
      }),
      meta: {
        strategyNotes: [
          "Rapid expansion strategy: higher cost and risk; ensure pasture, housing, and labor capacity.",
        ],
      },
    },
  });

  return [balanced, budgetFirst, pastureFirst, rapidExpansion];
}

/* -------------------------------------------------------------------------- */
/* Hub export                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Export acquisition plan to Hub (no-throw).
 *
 * @param {AcquisitionPlan} plan
 * @param {string} eventSource
 */
async function exportAcquisitionPlanToHub(plan, eventSource) {
  if (!familyFundMode || !plan) return;
  try {
    const payload = HubPacketFormatter.formatAnimalsAcquisitionPlan(plan, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("animals.acquisition.plan.exported", eventSource, {
      planId: plan.id,
      species: plan.species,
      chosenStrategyId: plan.chosenStrategyId,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[animals/acquisition] Hub export failed (soft):", err);
  }
}

/* -------------------------------------------------------------------------- */
/* Core planner                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the list of acquisition actions for the default (balanced) strategy.
 *
 * @param {HerdAnimalSummary[]} herd
 * @param {HerdAcquisitionGoals} goals
 * @param {HerdContext} context
 * @returns {AcquisitionAction[]}
 */
function buildBalancedActions(herd, goals, context) {
  const { species, minBreedingFemales, minBreedingMales, targetTotal } = goals;

  const { total, breedersFemale, breedersMale, cullCandidates } =
    analyzeHerdForSpecies(herd, species);

  /** @type {AcquisitionAction[]} */
  const actions = [];

  // 1. Cull action if there are explicit cull candidates
  if (cullCandidates > 0) {
    actions.push({
      id: `acq-${species}-cull`,
      type: "cull",
      species,
      sex: "mixed",
      purpose: "mixed",
      count: cullCandidates,
      whenPhase: "now",
      reason:
        "Cull marked animals to free up feed, housing, and improve herd genetics.",
      estCostUsd: null, // might actually be revenue; handled elsewhere
      blockers: [],
      meta: {
        suggestedSessionTitle: "Cull and dispatch marked animals",
      },
    });
  }

  // 2. Breeding stock deficits
  const femaleDeficit = Math.max(0, minBreedingFemales - breedersFemale);
  const maleDeficit = Math.max(0, minBreedingMales - breedersMale);

  if (femaleDeficit > 0) {
    const blockers = computeCapacityBlockers(context, total, femaleDeficit);
    actions.push({
      id: `acq-${species}-breeding-females`,
      type: "purchase",
      species,
      sex: "female",
      purpose: "breeding",
      count: femaleDeficit,
      whenPhase: blockers.length ? "next-season" : "now",
      reason:
        "Acquire additional breeding females to meet minimum herd reproduction capacity.",
      estCostUsd: estimateCostUsd(species, "purchase", femaleDeficit, context),
      blockers,
      meta: {
        notes:
          "Prefer sound feet, udder/teat structure, and parasite resilience.",
      },
    });
  }

  if (maleDeficit > 0) {
    const blockers = computeCapacityBlockers(context, total, maleDeficit);
    actions.push({
      id: `acq-${species}-breeding-males`,
      type: "purchase",
      species,
      sex: "male",
      purpose: "breeding",
      count: maleDeficit,
      whenPhase: blockers.length ? "next-season" : "now",
      reason:
        "Acquire or lease additional breeding males to avoid inbreeding and cover all females.",
      estCostUsd: estimateCostUsd(species, "purchase", maleDeficit, context),
      blockers,
      meta: {
        notes: "Consider rotating sires every few years to control inbreeding.",
      },
    });
  }

  // 3. Total herd size deficits
  const effectiveTotalAfterCull = total - cullCandidates;
  const totalDeficit = Math.max(0, targetTotal - effectiveTotalAfterCull);

  if (totalDeficit > 0) {
    // Split between purchase and breeding: rule-of-thumb ~60% breeding, 40% purchase for balanced.
    const breedCount = Math.max(0, Math.round(totalDeficit * 0.6));
    const purchaseCount = totalDeficit - breedCount;

    if (breedCount > 0) {
      actions.push({
        id: `acq-${species}-breed-growth`,
        type: "breed",
        species,
        sex: "mixed",
        purpose: "breeding",
        count: breedCount,
        whenPhase: "next-season",
        reason:
          "Plan breeding to increase herd size gradually from within the herd.",
        estCostUsd: 0,
        blockers: [],
        meta: {
          notes:
            "Ensure breeding calendar, kidding/lambing/calving support, and pasture for offspring.",
        },
      });
    }

    if (purchaseCount > 0) {
      const blockers = computeCapacityBlockers(
        context,
        effectiveTotalAfterCull,
        purchaseCount
      );
      actions.push({
        id: `acq-${species}-purchase-growth`,
        type: "purchase",
        species,
        sex: "mixed",
        purpose: "mixed",
        count: purchaseCount,
        whenPhase: blockers.length ? "next-season" : "now",
        reason:
          "Purchase additional animals to close the gap between current and target herd size.",
        estCostUsd: estimateCostUsd(
          species,
          "purchase",
          purchaseCount,
          context
        ),
        blockers,
        meta: {
          notes:
            "Consider age mix (weanlings vs yearlings vs mature animals) to match feed and housing capacity.",
        },
      });
    }
  }

  // 4. If no actions were required, add an explicit "no-op" recommendation.
  if (actions.length === 0) {
    actions.push({
      id: `acq-${species}-no-change`,
      type: "delay",
      species,
      sex: "mixed",
      purpose: "mixed",
      count: 0,
      whenPhase: "future",
      reason:
        "Current herd already meets or exceeds the specified goals; no acquisition needed now.",
      estCostUsd: 0,
      blockers: [],
      meta: {
        notes:
          "Revisit this plan after next breeding season or when goals change.",
      },
    });
  }

  return actions;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Plan an animal acquisition strategy for a single species.
 *
 * Emits:
 *  - animals.acquisition.plan.requested
 *  - animals.acquisition.plan.built
 *  - animals.acquisition.plan.exported (on Hub export success)
 *
 * This function does not persist to Dexie. Use planAndStoreAnimalAcquisition()
 * if you want persistence.
 *
 * @param {HerdAnimalSummary[]} herd
 * @param {HerdAcquisitionGoals} goals
 * @param {HerdContext} context
 * @param {AcquisitionPlanOptions} [options]
 * @returns {Promise<AcquisitionPlan>}
 */
export async function planAnimalAcquisition(
  herd,
  goals,
  context,
  options = {}
) {
  const {
    eventSource = "animals",
    nowTs = Date.now(),
    chosenStrategyByPlanId = {},
  } = options;

  if (!goals || !goals.species) {
    throw new Error("planAnimalAcquisition: goals.species is required.");
  }
  const species = goals.species;

  emit("animals.acquisition.plan.requested", eventSource, {
    species,
    targetTotal: goals.targetTotal,
    minBreedingFemales: goals.minBreedingFemales,
    minBreedingMales: goals.minBreedingMales,
  });

  const actions = buildBalancedActions(herd || [], goals, context || {});
  const strategyVariants = buildStrategyVariants(actions, goals, context || {});

  const planId = `acq_${species}_${Math.floor(nowTs / 1000)}`;
  const resumeStrategyId = chosenStrategyByPlanId[planId];

  const chosen =
    (resumeStrategyId &&
      strategyVariants.find((s) => s.id === resumeStrategyId)) ||
    strategyVariants.find((s) => s.autoSelected) ||
    strategyVariants[0];

  const notes = [];

  notes.push(
    `Species: ${species}. Current herd: ${
      herd.filter((h) => h.species === species).length
    } animals; target total: ${goals.targetTotal}.`
  );

  if (goals.budgetUsd) {
    notes.push(
      `Approximate budget: $${goals.budgetUsd.toFixed(
        0
      )} for purchases; feedCostIndex: ${numOr(context.feedCostIndex, 1)}.`
    );
  }

  if (goals.dueBy) {
    notes.push(`Goal date to meet targets: ${goals.dueBy}.`);
  }

  /** @type {AcquisitionPlan} */
  const plan = {
    id: planId,
    species,
    goals,
    context: context || {},
    herdSnapshot: herd || [],
    actions,
    strategyVariants,
    chosenStrategyId: chosen ? chosen.id : null,
    notes,
    meta: {
      createdAt: new Date(nowTs).toISOString(),
      eventSource,
    },
  };

  emit("animals.acquisition.plan.built", eventSource, {
    planId,
    species,
    actionsCount: actions.length,
    chosenStrategyId: plan.chosenStrategyId,
  });

  // Fire-and-forget Hub export
  exportAcquisitionPlanToHub(plan, eventSource).catch(() => {});

  return plan;
}

/**
 * Plan and persist an animal acquisition strategy using Dexie.
 *
 * Dexie expectations (can be adjusted to your db schema):
 *   db.animalsAcquisitionPlans: { id, species, goals, context, actions, ... }
 *
 * Emits:
 *  - animals.acquisition.plan.stored
 *
 * @param {HerdAnimalSummary[]} herd
 * @param {HerdAcquisitionGoals} goals
 * @param {HerdContext} context
 * @param {AcquisitionPlanOptions} [options]
 * @returns {Promise<AcquisitionPlan>}
 */
export async function planAndStoreAnimalAcquisition(
  herd,
  goals,
  context,
  options = {}
) {
  const plan = await planAnimalAcquisition(herd, goals, context, options);

  if (db && db.animalsAcquisitionPlans && db.animalsAcquisitionPlans.put) {
    try {
      await db.animalsAcquisitionPlans.put(plan);
      emit(
        "animals.acquisition.plan.stored",
        options.eventSource || "animals",
        {
          planId: plan.id,
          species: plan.species,
        }
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[animals/acquisition] Failed to store acquisition plan in Dexie:",
        err
      );
    }
  }

  return plan;
}

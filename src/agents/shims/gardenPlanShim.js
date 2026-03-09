// C:\Users\larho\suka-smart-assistant\src\agents\shims\gardenPlanShim.js

/**
 * Garden Plan Shim
 * ----------------
 * Shim around the Reasoner for garden planning, spice/herb suggestions,
 * and IPM/pest playbooks.
 *
 * It replaces the old gardenPlanAgent by:
 * - Accepting garden-related intents
 * - Pulling garden context from selectors
 * - Providing built-in horticulture hints (families, frost, IPM, spice maps)
 *   as *hints* to the Reasoner instead of hard-coding behavior
 * - Selecting a Reasoner mode, building prompts, enforcing budget/gating
 * - Validating Reasoner output against schemas
 * - Normalizing into SSA garden payloads
 * - Emitting standard Reasoner events and optional Hub export
 *
 * This shim does NOT:
 * - Touch UI / DOM
 * - Show toasts or call Glue
 * - Manage timers, sessions, or Dexie directly
 */

/**
 * @typedef {Object} ShimRequest
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {string} intent                 // e.g. "garden.generatePlan", "garden.pestPlaybook"
 * @property {Object} input                  // garden-specific input payload
 * @property {Object} [runtime]              // budget overrides, cache, exportToHub, etc.
 */

/**
 * @typedef {Object} ShimResponse
 * @property {boolean} ok
 * @property {string} mode                   // Reasoner mode used
 * @property {Object} data                   // normalized payload
 * @property {Array<Object>} [warnings]
 * @property {Array<Object>} [debug]
 */

import dayjs from "dayjs";
import { emit } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

// Reasoner runtime support
import { enforceBudget } from "@/reasoner/budget";
import { isGated } from "@/reasoner/gating";
import { checkConfidence } from "@/reasoner/confidence";
import { applyFreshnessRules } from "@/reasoner/freshness";
import { getCachedResponse, setCachedResponse } from "@/reasoner/cache/memo";
import { gardenShimKey } from "@/reasoner/cache/keys";
import { selectModeForIntent } from "@/reasoner/modes/map";
import { validateResponse } from "@/reasoner/modes/validate";
import { buildSystemPrompt } from "@/reasoner/prompts/system";
import { buildTemplatePrompt } from "@/reasoner/prompts/templates";
import { callReasoner } from "@/reasoner/core";

// Context selectors
import { selectGardenContext } from "@/services/selectors/gardenSelectors";

// Hub export (optional)
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

const isoNow = () => dayjs().toISOString();
const lower = (s) => (s || "").toLowerCase().trim();

/* -----------------------------------------------------------------------------
 * Shared horticulture hints (fed into Reasoner as structured hints)
 * -------------------------------------------------------------------------- */

const FAMILY_MAP = {
  tomato: "solanaceae",
  pepper: "solanaceae",
  potato: "solanaceae",
  eggplant: "solanaceae",
  kale: "brassicaceae",
  cabbage: "brassicaceae",
  broccoli: "brassicaceae",
  cauliflower: "brassicaceae",
  radish: "brassicaceae",
  turnip: "brassicaceae",
  bean: "fabaceae",
  pea: "fabaceae",
  chickpea: "fabaceae",
  lentil: "fabaceae",
  carrot: "apiaceae",
  dill: "apiaceae",
  parsley: "apiaceae",
  beet: "amaranthaceae",
  chard: "amaranthaceae",
  spinach: "amaranthaceae",
  onion: "amaryllidaceae",
  garlic: "amaryllidaceae",
  leek: "amaryllidaceae",
  corn: "poaceae",
  wheat: "poaceae",
  cucumber: "cucurbitaceae",
  squash: "cucurbitaceae",
  pumpkin: "cucurbitaceae",
  melon: "cucurbitaceae",
  lettuce: "asteraceae",
};

const FEEDING_CLASS = {
  solanaceae: "heavy",
  cucurbitaceae: "heavy",
  poaceae: "heavy",
  brassicaceae: "medium",
  amaranthaceae: "medium",
  apiaceae: "light",
  amaryllidaceae: "light",
  fabaceae: "light",
  asteraceae: "light",
};

const SPICE_GROW_MAP = {
  thyme: ["Thyme"],
  oregano: ["Oregano"],
  rosemary: ["Rosemary"],
  basil: ["Basil"],
  cilantro: ["Cilantro/Coriander"],
  parsley: ["Parsley"],
  dill: ["Dill"],
  mint: ["Mint"],
  chive: ["Chive"],
  bay_leaf: ["Bay Laurel (container)"],
  lemon: ["Meyer Lemon (container)"],
  lime: ["Key Lime (container)"],
  paprika: ["Sweet Pepper"],
  cayenne: ["Hot Pepper"],
  garlic: ["Garlic"],
  onion: ["Onion", "Green Onion"],
  turmeric: ["Turmeric (container)"],
  ginger: ["Ginger (container)"],
  sumac: ["Staghorn Sumac"],
  tomato_paste: ["Tomato (sauce type)"],
  tomato: ["Tomato"],
  mushroom_powder: ["Wine Cap Mushroom Bed"],
  coriander: ["Cilantro/Coriander"],
  cumin: ["Cumin"],
  sesame: ["Sesame"],
};

const PEST_TIPS = {
  solanaceae: [
    "Scout aphids/flea beetles weekly; yellow sticky cards early.",
    "Row cover until bloom; remove for pollination.",
    "Even moisture + Ca for blossom-end rot prevention.",
  ],
  brassicaceae: [
    "Cover post-sow to block cabbage moths; Bt on active feeding only.",
    "Flea beetles: row cover + radish trap crop on edges.",
  ],
  cucurbitaceae: [
    "Row cover for cucumber beetles; uncover at bloom.",
    "Hand-pick squash bug egg clusters; remove debris.",
  ],
  fabaceae: ["Avoid excess N; trellis; encourage lady beetles."],
  amaryllidaceae: ["Fine mesh for onion maggot; rotate 3+ years; weed clean."],
  asteraceae: ["Tip-burn ≈ Ca/irregular moisture; use shade in heat waves."],
  default: [
    "Scout weekly; sanitize tools; remove diseased tissue.",
    "Support beneficials: diverse flowers; avoid broad-spectrum sprays.",
  ],
};

/**
 * Cuisine → plant hints so the Reasoner can bias plans toward how the
 * household actually eats (Italian, soul food, Caribbean, etc.).
 */
const CUISINE_PLANT_HINTS = {
  italian: {
    key: "italian",
    herbs: ["Basil", "Oregano", "Rosemary", "Parsley", "Thyme"],
    aromatics: ["Garlic", "Onion"],
    veg: ["Tomato", "Sweet Pepper", "Zucchini"],
  },
  mexican: {
    key: "mexican",
    herbs: ["Cilantro/Coriander", "Oregano"],
    aromatics: ["Garlic", "Onion", "Green Onion"],
    veg: ["Tomato", "Hot Pepper", "Sweet Pepper"],
  },
  mediterranean: {
    key: "mediterranean",
    herbs: ["Thyme", "Oregano", "Rosemary", "Parsley", "Mint"],
    aromatics: ["Garlic", "Onion"],
    veg: ["Tomato", "Cucumber", "Eggplant"],
  },
  caribbean: {
    key: "caribbean",
    herbs: ["Thyme", "Cilantro/Coriander"],
    aromatics: ["Garlic", "Onion", "Green Onion"],
    veg: ["Hot Pepper", "Sweet Pepper"],
  },
  soul_food: {
    key: "soul_food",
    herbs: ["Parsley", "Thyme"],
    aromatics: ["Garlic", "Onion"],
    veg: ["Kale", "Collards", "Turnip", "Mustard Greens", "Sweet Pepper"],
  },
};

/**
 * Normalize/alias intents coming from legacy callers.
 * - Old commands: generateGardenPlan, pestPlaybook, suggestPlants, makePlan
 * - New canonical intents: garden.generatePlan, garden.pestPlaybook, etc.
 *
 * @param {string} rawIntentOrCommand
 * @returns {string}
 */
function normalizeIntent(rawIntentOrCommand) {
  const s = String(rawIntentOrCommand || "")
    .trim()
    .toLowerCase();

  const map = {
    generate: "garden.generatePlan",
    generategardenplan: "garden.generatePlan",
    generate_garden_plan: "garden.generatePlan",
    "garden.generateplan": "garden.generatePlan",

    pest: "garden.pestPlaybook",
    pestplaybook: "garden.pestPlaybook",
    pest_playbook: "garden.pestPlaybook",
    "garden.pestplaybook": "garden.pestPlaybook",

    suggestplants: "garden.spiceSuggest",
    suggest_plants: "garden.spiceSuggest",
    "garden.suggestplants": "garden.spiceSuggest",

    makeplan: "garden.skeletonPlan",
    make_plan: "garden.skeletonPlan",
    "garden.makeplan": "garden.skeletonPlan",
  };

  if (map[s]) return map[s];

  if (s.startsWith("garden.")) return s;
  return `garden.${s}`;
}

/**
 * Build structured horticulture hints to pass into the Reasoner.
 * These are *hints*, not deterministic behavior.
 *
 * @returns {{
 *   familyMap: Object,
 *   feedingClass: Object,
 *   spiceGrowMap: Object,
 *   pestTips: Object,
 *   cuisinePlantHints: Object
 * }}
 */
function buildGardenHints() {
  return {
    familyMap: FAMILY_MAP,
    feedingClass: FEEDING_CLASS,
    spiceGrowMap: SPICE_GROW_MAP,
    pestTips: PEST_TIPS,
    cuisinePlantHints: CUISINE_PLANT_HINTS,
  };
}

/**
 * Normalize Reasoner raw output into SSA garden payload.
 * Handles multiple intents:
 *  - garden.generatePlan
 *  - garden.skeletonPlan
 *  - garden.spiceSuggest
 *  - garden.pestPlaybook
 *
 * Assumes schema validation has already passed.
 *
 * @param {string} intent
 * @param {any} raw
 * @returns {{ data: Object, warnings: Object[], debug: Object[] }}
 */
function normalizeGardenOutput(intent, raw) {
  const warnings = [];
  const debug = [];

  if (!raw || typeof raw !== "object") {
    return {
      data: {
        summary: "Reasoner returned empty result.",
        recommendations: [],
        calendarEvents: [],
        gardenUpdates: [],
        nextBestAction: null,
        data: {},
      },
      warnings: [
        {
          type: "emptyResult",
          message: "Reasoner returned no structured payload for garden intent.",
        },
      ],
      debug,
    };
  }

  const baseSummary =
    raw.summary ||
    (intent === "garden.generatePlan"
      ? "Garden plan generated."
      : intent === "garden.skeletonPlan"
      ? "Garden skeleton plan created."
      : intent === "garden.spiceSuggest"
      ? "Spice/herb plant suggestions generated."
      : intent === "garden.pestPlaybook"
      ? "Pest/IPM playbook generated."
      : "Garden output ready.");

  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations
    : [];
  const calendarEvents = Array.isArray(raw.calendarEvents)
    ? raw.calendarEvents
    : [];
  const gardenUpdates = Array.isArray(raw.gardenUpdates)
    ? raw.gardenUpdates
    : [];

  let nextBestAction = raw.nextBestAction || null;
  const extraData = raw.data || {};

  // Ensure we surface conventional update types if the Reasoner followed old agent semantics
  if (
    intent === "garden.spiceSuggest" &&
    !gardenUpdates.some((g) => g.type === "garden.spice_suggestions")
  ) {
    const items = Array.isArray(raw.items) ? raw.items : [];
    gardenUpdates.push({
      type: "garden.spice_suggestions",
      zone: raw.zone || null,
      items,
    });
  }

  if (
    intent === "garden.skeletonPlan" &&
    !gardenUpdates.some((g) => g.type === "garden.plan.skeleton")
  ) {
    gardenUpdates.push({
      type: "garden.plan.skeleton",
      perCrop: raw.perCrop || [],
      events: calendarEvents,
      zone: raw.zone || null,
    });
  }

  if (
    intent === "garden.pestPlaybook" &&
    !gardenUpdates.some((g) => g.type === "garden.pest_playbook")
  ) {
    gardenUpdates.push({
      type: "garden.pest_playbook",
      family: raw.family || raw.cropFamily || null,
      tips: raw.tips || [],
    });
  }

  // If Reasoner did not provide an NBA, we can leave it null; UI will decide
  if (nextBestAction && typeof nextBestAction !== "object") {
    warnings.push({
      type: "invalidNextBestAction",
      message:
        "nextBestAction must be an object or null; received non-object, dropping it.",
    });
    nextBestAction = null;
  }

  const data = {
    summary: baseSummary,
    recommendations,
    calendarEvents,
    gardenUpdates,
    nextBestAction,
    data: extraData,
  };

  debug.push({
    type: "gardenShim.normalize",
    ts: isoNow(),
    intent,
    rawKeys: Object.keys(raw || {}),
  });

  return { data, warnings, debug };
}

/**
 * Main Garden Shim entrypoint.
 *
 * @param {ShimRequest} req
 * @returns {Promise<ShimResponse>}
 */
export async function invokeShim(req) {
  const startedAt = isoNow();
  const warnings = [];
  const debug = [];

  try {
    if (!req || typeof req !== "object") {
      return {
        ok: false,
        mode: "none",
        data: {},
        warnings: [
          {
            type: "badRequest",
            message: "ShimRequest is required and must be an object.",
          },
        ],
        debug,
      };
    }

    const domain = req.domain || "garden";
    const intent = normalizeIntent(req.intent || "");
    const input = req.input || {};
    const runtime = req.runtime || {};

    if (domain !== "garden") {
      return {
        ok: false,
        mode: "none",
        data: {},
        warnings: [
          {
            type: "badDomain",
            message: `Garden shim only supports domain="garden", received "${domain}".`,
          },
        ],
        debug,
      };
    }

    // Emit early invocation event
    emit({
      type: "reasoner.invoked",
      ts: startedAt,
      source: "agents/shims/gardenPlan",
      data: { intent, domain, runtime },
    });

    // Gating
    if (isGated({ domain, intent, runtime })) {
      warnings.push({
        type: "gated",
        message: `Reasoner calls gated for intent "${intent}".`,
      });

      emit({
        type: "reasoner.gated",
        ts: isoNow(),
        source: "agents/shims/gardenPlan",
        data: { intent, domain },
      });

      return {
        ok: false,
        mode: "none",
        data: {},
        warnings,
        debug,
      };
    }

    // Mode selection (e.g. garden.generatePlan.v1, garden.pestPlaybook.v1, etc.)
    const mode =
      selectModeForIntent({
        domain,
        intent,
        input,
      }) || "garden.generatePlan.v1";

    // Budget enforcement
    const budgetInfo = enforceBudget({ domain, intent, mode, runtime });
    if (!budgetInfo.ok) {
      warnings.push({
        type: "budgetExceeded",
        message: budgetInfo.message || "Budget exceeded for garden shim.",
      });

      emit({
        type: "reasoner.budgetExceeded",
        ts: isoNow(),
        source: "agents/shims/gardenPlan",
        data: { intent, domain, mode, budgetInfo },
      });

      return {
        ok: false,
        mode,
        data: {},
        warnings,
        debug,
      };
    }

    // Pull context (beds, zone, frost, crop history, meal signals, possibly cuisine profile, etc.)
    const context = await selectGardenContext({ input, runtime, intent });

    debug.push({
      type: "context.loaded",
      ts: isoNow(),
      keys: Object.keys(context || {}),
    });

    // Freshness rules
    const { context: freshContext, freshnessWarnings } = applyFreshnessRules({
      domain,
      intent,
      mode,
      context,
    });
    if (freshnessWarnings?.length) warnings.push(...freshnessWarnings);

    // Build horticulture hints
    const gardenHints = buildGardenHints();

    // Derive cuisine preferences from input or context
    const cuisinePreferences =
      input.cuisinePreferences ||
      context?.cuisinePreferences ||
      context?.cuisineProfile ||
      null;

    let cuisineKeys = [];
    if (Array.isArray(cuisinePreferences)) {
      cuisineKeys = cuisinePreferences.map((c) => lower(c));
    } else if (cuisinePreferences && typeof cuisinePreferences === "object") {
      if (cuisinePreferences.primary) {
        cuisineKeys.push(lower(cuisinePreferences.primary));
      }
      if (Array.isArray(cuisinePreferences.secondary)) {
        cuisineKeys.push(...cuisinePreferences.secondary.map((c) => lower(c)));
      }
    } else if (typeof cuisinePreferences === "string") {
      cuisineKeys = [lower(cuisinePreferences)];
    }

    // Compose Reasoner payload
    const reasonerPayload = {
      task: intent,
      domain,
      mode,
      input,
      context: freshContext,
      hints: {
        garden: gardenHints,
        cuisine: {
          preferences: cuisineKeys, // e.g. ["soul_food","caribbean"]
          plantHints: CUISINE_PLANT_HINTS, // same shape as in gardenHints for convenience
        },
      },
      meta: {
        requestedAt: startedAt,
        familyFundMode: !!familyFundMode,
      },
    };

    // Cache key + lookup
    const cacheKey = gardenShimKey({ intent, mode, payload: reasonerPayload });
    const cached = await getCachedResponse(cacheKey);
    if (cached) {
      emit({
        type: "reasoner.cachedHit",
        ts: isoNow(),
        source: "agents/shims/gardenPlan",
        data: { intent, mode, cacheKey },
      });

      const {
        data,
        warnings: w2,
        debug: d2,
      } = normalizeGardenOutput(intent, cached);
      if (w2?.length) warnings.push(...w2);
      if (d2?.length) debug.push(...d2);

      return {
        ok: true,
        mode,
        data,
        warnings,
        debug,
      };
    }

    emit({
      type: "reasoner.cachedMiss",
      ts: isoNow(),
      source: "agents/shims/gardenPlan",
      data: { intent, mode, cacheKey },
    });

    // Build prompts
    const systemPrompt = buildSystemPrompt({
      domain: "garden",
      mode,
      extra: {
        // Encourage the Reasoner to leverage the hints instead of inventing wildly
        gardenInstruction:
          "Use the provided familyMap, feedingClass, spiceGrowMap, pestTips, and cuisinePlantHints as strong heuristics " +
          "for planning crop rotations, feeding programs, spice/herb plant suggestions, cuisine-aligned crop choices, and IPM playbooks. " +
          "Prioritize crops and herbs that strongly support the user’s cuisine preferences when designing plans or successions. " +
          "When you deviate from these hints or cuisine preferences, briefly explain why.",
      },
    });

    const userPrompt = buildTemplatePrompt({
      domain: "garden",
      mode,
      intent,
      payload: reasonerPayload,
    });

    // Reasoner call
    const rawResult = await callReasoner({
      mode,
      systemPrompt,
      userPrompt,
      budget: budgetInfo,
      runtime,
    });

    // Confidence check
    const confidence = checkConfidence({
      domain,
      intent,
      mode,
      raw: rawResult,
    });

    if (!confidence.ok) {
      warnings.push({
        type: "lowConfidence",
        message:
          confidence.message ||
          "Reasoner confidence below threshold for garden intent.",
      });

      emit({
        type: "reasoner.lowConfidence",
        ts: isoNow(),
        source: "agents/shims/gardenPlan",
        data: { intent, mode, confidence },
      });
    }

    // Schema validation
    const validation = validateResponse({
      domain,
      intent,
      mode,
      raw: rawResult,
    });
    if (!validation.ok) {
      warnings.push({
        type: "invalidSchema",
        message:
          validation.message || "Reasoner output failed schema validation.",
        details: validation.errors || [],
      });

      emit({
        type: "reasoner.invalidSchema",
        ts: isoNow(),
        source: "agents/shims/gardenPlan",
        data: { intent, mode, errors: validation.errors || [] },
      });

      return {
        ok: false,
        mode,
        data: {},
        warnings,
        debug,
      };
    }

    emit({
      type: "reasoner.validated",
      ts: isoNow(),
      source: "agents/shims/gardenPlan",
      data: { intent, mode },
    });

    // Normalize into SSA garden payload
    const {
      data,
      warnings: w3,
      debug: d3,
    } = normalizeGardenOutput(intent, rawResult);
    if (w3?.length) warnings.push(...w3);
    if (d3?.length) debug.push(...d3);

    // Cache the successful raw result
    await setCachedResponse(cacheKey, rawResult);

    // Emit domain-level event
    const domainEventType =
      intent === "garden.generatePlan"
        ? "garden.plan.generated"
        : intent === "garden.pestPlaybook"
        ? "garden.pest_playbook.generated"
        : intent === "garden.spiceSuggest"
        ? "garden.spice_suggestions.generated"
        : intent === "garden.skeletonPlan"
        ? "garden.plan.skeleton.generated"
        : "garden.output.ready";

    emit({
      type: domainEventType,
      ts: isoNow(),
      source: "agents/shims/gardenPlan",
      data: {
        intent,
        mode,
        summary: data.summary,
      },
    });

    // Optional Hub export for full plans/skeletons
    if (
      familyFundMode &&
      runtime?.exportToHub &&
      (intent === "garden.generatePlan" || intent === "garden.skeletonPlan")
    ) {
      try {
        const packet = HubPacketFormatter.formatGardenPlan({
          intent,
          mode,
          data,
          startedAt,
        });

        await FamilyFundConnector.export(packet);

        emit({
          type: "session.exported",
          ts: isoNow(),
          source: "agents/shims/gardenPlan",
          data: { intent, mode, packetType: "gardenPlan" },
        });
      } catch (e) {
        warnings.push({
          type: "hubExportFailed",
          message:
            e?.message || "Failed to export garden plan to Family Fund Hub.",
        });
      }
    }

    return {
      ok: true,
      mode,
      data,
      warnings,
      debug,
    };
  } catch (err) {
    const message = err?.message || String(err);
    const stack = err?.stack || null;

    emit({
      type: "reasoner.error",
      ts: isoNow(),
      source: "agents/shims/gardenPlan",
      data: { message, stack },
    });

    return {
      ok: false,
      mode: "none",
      data: {},
      warnings: [
        {
          type: "shimError",
          message,
        },
      ],
      debug: [
        ...debug,
        {
          type: "exception",
          ts: isoNow(),
          message,
          stack,
        },
      ],
    };
  }
}

/* -----------------------------------------------------------------------------
 * Optional legacy compatibility wrappers
 * -----------------------------------------------------------------------------
 * These keep the old API surface roughly intact for any modules that still call:
 *   gardenPlanAgent.handle("generate", payload)
 *   gardenPlanAgent.generateGardenPlan(payload)
 *   gardenPlanAgent.pestPlaybook(payload)
 *   gardenPlanAgent.suggestPlants(payload)
 *   gardenPlanAgent.makePlan(payload)
 *
 * Each wrapper simply forwards into invokeShim() with the right intent.
 */

/**
 * Legacy-style router for old calls.
 * @param {string} command
 * @param {Object} payload
 * @returns {Promise<ShimResponse>}
 */
export async function handleLegacy(command, payload = {}) {
  const c = String(command || "")
    .toLowerCase()
    .trim();

  let intent;
  switch (c) {
    case "generate":
    case "generategardenplan":
    case "generate_garden_plan":
      intent = "garden.generatePlan";
      break;
    case "pest":
    case "pestplaybook":
    case "pest_playbook":
      intent = "garden.pestPlaybook";
      break;
    case "suggestplants":
    case "suggest_plants":
      intent = "garden.spiceSuggest";
      break;
    case "makeplan":
    case "make_plan":
      intent = "garden.skeletonPlan";
      break;
    default:
      // Default: treat the command as a raw intent; normalizeIntent() will handle it
      intent = c;
      break;
  }

  return invokeShim({
    domain: "garden",
    intent,
    input: payload,
    runtime: payload?.runtime || {},
  });
}

/**
 * Thin compatibility wrappers mirroring old class methods.
 * These are optional conveniences; they always return ShimResponse.
 */

export async function generateGardenPlan(input = {}) {
  return invokeShim({
    domain: "garden",
    intent: "garden.generatePlan",
    input,
    runtime: input.runtime || {},
  });
}

export async function pestPlaybook(input = {}) {
  return invokeShim({
    domain: "garden",
    intent: "garden.pestPlaybook",
    input,
    runtime: input.runtime || {},
  });
}

export async function suggestPlants(input = {}) {
  return invokeShim({
    domain: "garden",
    intent: "garden.spiceSuggest",
    input,
    runtime: input.runtime || {},
  });
}

export async function makePlan(input = {}) {
  return invokeShim({
    domain: "garden",
    intent: "garden.skeletonPlan",
    input,
    runtime: input.runtime || {},
  });
}

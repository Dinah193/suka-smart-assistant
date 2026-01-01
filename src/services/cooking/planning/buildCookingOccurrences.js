// C:\Users\larho\suka-smart-assistant\src\services\cooking\planning\buildCookingOccurrences.js
/* eslint-disable no-console */

import { normalizeOccurrence } from "@/services/planning/normalizeOccurrence.js";

/**
 * Cooking Planning: buildCookingOccurrences(domain, plan, draft)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → intelligence (meal plan / batch plan) → occurrences → accept → sessions/calendar → automation → (optional) Hub export
 *
 * This file is a COOKING-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Take a cooking plan (and optional draft UI state) and expand it into a list
 *   of time-bounded "occurrences" (one per cook session / meal slot / batch).
 * - Be defensive: tolerate partial plan shapes and drafts.
 * - Stay forward-thinking: support new cooking planning inputs (menu cycles,
 *   batch sessions, leftover cycles, preservation handoffs).
 *
 * Notes:
 * - This file does NOT persist anything and does NOT export to Hub.
 * - IDs are made stable downstream via normalizeOccurrence + ids.js.
 */

const ADAPTER_NAME = "cooking";

/* ------------------------------ Small helpers ------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function isoOrNull(v) {
  if (!v) return null;
  if (typeof v === "string") return v;
  try {
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function minutesToMs(min) {
  const n = Number(min);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 60 * 1000);
}

function addMsToIso(iso, ms) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t + ms).toISOString();
}

/**
 * Attempt to detect "recipes" from multiple possible shapes:
 * - plan.recipes (array)
 * - plan.items (array) where type === 'recipe' or has recipeId
 * - plan.meals[].recipes
 * - draft.selectedRecipes
 */
function collectRecipes(plan, draft) {
  const out = [];
  const push = (r) => {
    if (!r) return;
    if (typeof r === "string") out.push({ id: r, title: r });
    else if (isObj(r)) out.push(r);
  };

  asArray(plan?.recipes).forEach(push);

  asArray(plan?.items).forEach((it) => {
    if (!it) return;
    if (it.type === "recipe" || it.recipeId || it.recipe?.id)
      push(it.recipe || { id: it.recipeId, ...it });
  });

  asArray(plan?.meals).forEach((m) => {
    asArray(m?.recipes).forEach(push);
  });

  asArray(draft?.selectedRecipes).forEach(push);

  // De-dupe by id/title
  const seen = new Set();
  const deduped = [];
  for (const r of out) {
    const key = String(r?.id || r?.recipeId || r?.title || "").trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }
  return deduped;
}

/**
 * Compute a reasonable cooking duration if none is supplied:
 * - prefer plan.durationMin, plan.estimatedMinutes, plan.totalMinutes
 * - else sum recipe times when present
 * - else default to 60 minutes
 */
function estimateDurationMin(plan, recipes, draft) {
  const direct =
    plan?.durationMin ??
    plan?.durationMinutes ??
    plan?.estimatedMinutes ??
    plan?.totalMinutes ??
    draft?.durationMin ??
    draft?.estimatedMinutes;

  const n = Number(direct);
  if (Number.isFinite(n) && n > 0) return Math.round(n);

  // Try recipe-level estimates
  let sum = 0;
  let used = false;
  for (const r of recipes) {
    const rt = Number(
      r?.totalMinutes ??
        r?.estimatedMinutes ??
        r?.timeMinutes ??
        r?.cookTimeMinutes
    );
    if (Number.isFinite(rt) && rt > 0) {
      sum += rt;
      used = true;
    }
  }
  if (used) return Math.max(30, Math.round(sum)); // guard against tiny sums

  return 60;
}

/**
 * Resolve a schedule "startAt" for an occurrence:
 * - prefer explicit per-slot startAt in plan.schedule/plan.occurrences
 * - else plan.startAt / plan.date / plan.day
 * - else draft.startAt
 * - else now
 */
function resolveStartAt(plan, draft, slot) {
  return (
    isoOrNull(slot?.startAt) ||
    isoOrNull(slot?.start) ||
    isoOrNull(plan?.startAt) ||
    isoOrNull(plan?.date) ||
    isoOrNull(plan?.day) ||
    isoOrNull(draft?.startAt) ||
    nowIso()
  );
}

function buildTitle(plan, slot, recipes) {
  const base =
    slot?.title ||
    slot?.name ||
    slot?.label ||
    plan?.title ||
    plan?.name ||
    plan?.label ||
    "Cooking session";

  // Optional: append recipe titles if not already descriptive
  if (recipes?.length) {
    const names = recipes
      .slice(0, 3)
      .map((r) => r?.title || r?.name || r?.label || r?.id)
      .filter(Boolean);

    if (names.length) {
      const suffix = names.join(", ") + (recipes.length > 3 ? "…" : "");
      // Avoid duplication if base already contains a recipe name
      const baseLower = String(base).toLowerCase();
      const anyContained = names.some((n) =>
        baseLower.includes(String(n).toLowerCase())
      );
      return anyContained ? base : `${base}: ${suffix}`;
    }
  }

  return base;
}

function detectMealSlot(slot) {
  // e.g. breakfast/lunch/dinner/snack
  return slot?.mealSlot || slot?.slot || slot?.meal || null;
}

function normalizeEquipment(plan, recipes) {
  const eq = [];
  asArray(plan?.equipment).forEach((e) => eq.push(e));
  for (const r of recipes) {
    asArray(r?.equipment).forEach((e) => eq.push(e));
  }
  // de-dupe
  const seen = new Set();
  const out = [];
  for (const e of eq) {
    const key = String(e?.id || e?.name || e).trim();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(isObj(e) ? e : { name: String(e) });
  }
  return out;
}

function normalizeIngredients(plan, recipes) {
  const ing = [];
  asArray(plan?.ingredients).forEach((i) => ing.push(i));
  for (const r of recipes) {
    asArray(r?.ingredients).forEach((i) => ing.push(i));
  }
  // Keep as-is; downstream cooking session builder can map to inventory
  return ing.filter(Boolean);
}

/* ------------------------------ Main function ------------------------------ */

/**
 * buildCookingOccurrences(domain, plan, draft)
 * ---------------------------------------------------------------------------
 * Returns an array of RAW occurrences. The shared acceptance pipeline will call
 * normalizeOccurrence(domain, plan, occ, adapterName) to ensure stable IDs.
 *
 * Expected "domain" is "cooking" but kept generic so it can be reused if you
 * ever alias cooking under a different domain key.
 */
export default function buildCookingOccurrences(domain, plan, draft) {
  if (!domain || typeof domain !== "string") {
    console.warn("[buildCookingOccurrences] Missing domain");
    return [];
  }
  if (!plan || typeof plan !== "object") {
    console.warn("[buildCookingOccurrences] Missing plan object");
    return [];
  }

  // If plan already provides occurrences (from higher-level planner), accept them.
  // We still enrich with cooking-specific meta where possible.
  const provided = Array.isArray(plan.occurrences) ? plan.occurrences : null;

  const recipes = collectRecipes(plan, draft);
  const durationMin = estimateDurationMin(plan, recipes, draft);
  const equipment = normalizeEquipment(plan, recipes);
  const ingredients = normalizeIngredients(plan, recipes);

  const defaultMeta = {
    // Primary cooking intelligence handles:
    recipes: recipes.map((r) => ({
      id: r?.id || r?.recipeId || null,
      title: r?.title || r?.name || r?.label || null,
      source: r?.source || null,
    })),
    ingredients,
    equipment,
    mealSlot: null,
    durationMin,
    // forward hooks for later intelligence layers:
    constraints: plan?.constraints || draft?.constraints || null,
    dietary: plan?.dietary || draft?.dietary || null,
    leftovers: plan?.leftovers || null,
    preservationHandoff: plan?.preservationHandoff || null, // e.g. "freeze half", "can broth"
  };

  // If occurrences were provided, normalize & enrich them lightly.
  if (provided && provided.length) {
    return provided.map((occ) => {
      const startAt = resolveStartAt(plan, draft, occ);
      const dur = Number(occ?.durationMin ?? occ?.durationMinutes);
      const finalDur =
        Number.isFinite(dur) && dur > 0 ? Math.round(dur) : durationMin;

      const endAt =
        isoOrNull(occ?.endAt) ||
        isoOrNull(occ?.end) ||
        (finalDur ? addMsToIso(startAt, minutesToMs(finalDur)) : null);

      const slotRecipes = collectRecipes(occ, draft);
      const mergedRecipes = slotRecipes.length ? slotRecipes : recipes;

      const title = buildTitle(plan, occ, mergedRecipes);

      return {
        startAt,
        endAt,
        title,
        mealSlot: detectMealSlot(occ),
        meta: {
          ...defaultMeta,
          ...occ?.meta,
          mealSlot: detectMealSlot(occ) || defaultMeta.mealSlot,
          durationMin: finalDur,
          recipes: mergedRecipes.map((r) => ({
            id: r?.id || r?.recipeId || null,
            title: r?.title || r?.name || r?.label || null,
            source: r?.source || null,
          })),
          // allow slot-level overrides
          ingredients: occ?.ingredients || defaultMeta.ingredients,
          equipment: occ?.equipment || defaultMeta.equipment,
        },
      };
    });
  }

  // Otherwise, derive occurrences from schedule slots / meal slots / batch sessions.
  // Supported shapes:
  // - plan.schedule (array of slots)
  // - plan.slots (array)
  // - plan.meals (array; each meal becomes an occurrence)
  // - plan.batch (single or array)
  const scheduleSlots = asArray(plan?.schedule).length
    ? asArray(plan?.schedule)
    : asArray(plan?.slots).length
    ? asArray(plan?.slots)
    : asArray(plan?.meals).length
    ? asArray(plan?.meals)
    : asArray(plan?.batch);

  // If no slots, return a single occurrence.
  if (!scheduleSlots.length) {
    const startAt = resolveStartAt(plan, draft, null);
    const endAt = durationMin
      ? addMsToIso(startAt, minutesToMs(durationMin))
      : null;

    const occ = {
      startAt,
      endAt,
      title: buildTitle(plan, null, recipes),
      mealSlot: null,
      meta: {
        ...defaultMeta,
        mealSlot: null,
      },
    };

    // Return as raw occurrence (accept pipeline normalizes IDs)
    return [occ];
  }

  // Build one occurrence per slot
  const occs = [];
  for (const slot of scheduleSlots) {
    if (!slot) continue;

    const startAt = resolveStartAt(plan, draft, slot);

    const slotRecipes = collectRecipes(slot, draft);
    const mergedRecipes = slotRecipes.length ? slotRecipes : recipes;

    const slotDurationMin = estimateDurationMin(slot, mergedRecipes, draft);
    const durOverride = Number(slot?.durationMin ?? slot?.durationMinutes);
    const finalDur =
      Number.isFinite(durOverride) && durOverride > 0
        ? Math.round(durOverride)
        : slotDurationMin || durationMin;

    const endAt =
      isoOrNull(slot?.endAt) ||
      isoOrNull(slot?.end) ||
      (finalDur ? addMsToIso(startAt, minutesToMs(finalDur)) : null);

    const title = buildTitle(plan, slot, mergedRecipes);
    const mealSlot = detectMealSlot(slot);

    const slotEquipment = normalizeEquipment(slot, mergedRecipes);
    const slotIngredients = normalizeIngredients(slot, mergedRecipes);

    occs.push({
      startAt,
      endAt,
      title,
      mealSlot,
      meta: {
        ...defaultMeta,
        ...slot?.meta,
        mealSlot,
        durationMin: finalDur,
        recipes: mergedRecipes.map((r) => ({
          id: r?.id || r?.recipeId || null,
          title: r?.title || r?.name || r?.label || null,
          source: r?.source || null,
        })),
        ingredients: slotIngredients.length
          ? slotIngredients
          : defaultMeta.ingredients,
        equipment: slotEquipment.length ? slotEquipment : defaultMeta.equipment,
        // forward hooks:
        prepWindow: slot?.prepWindow || null, // e.g. { earliestStartAt, latestStartAt }
        servings: slot?.servings ?? plan?.servings ?? null,
      },
    });
  }

  // If still nothing (slot list was junk), fallback to one.
  if (!occs.length) {
    const startAt = resolveStartAt(plan, draft, null);
    const endAt = durationMin
      ? addMsToIso(startAt, minutesToMs(durationMin))
      : null;

    return [
      {
        startAt,
        endAt,
        title: buildTitle(plan, null, recipes),
        mealSlot: null,
        meta: { ...defaultMeta },
      },
    ];
  }

  // Important: we return normalized occurrences to ensure stable IDs are applied
  // consistently even if downstream callers forget to normalize.
  // (This is safe; normalizeOccurrence will set id using plan + occurrence content.)
  return occs.map((o) => {
    try {
      return normalizeOccurrence(domain, plan, o, ADAPTER_NAME);
    } catch {
      // If normalization fails, return raw occurrence (accept pipeline will handle)
      return o;
    }
  });
}

// C:\Users\larho\suka-smart-assistant\src\services\cooking\planning\buildCookingSessionDraft.js
/* eslint-disable no-console */

import eventBus from "@/services/events/eventBus.js";
import { sessionId as stableSessionId } from "@/services/planning/ids.js";

/**
 * Cooking Planning: buildCookingSessionDraft(domain, occurrence, context)
 * -----------------------------------------------------------------------------
 * Where this fits in SSA pipeline:
 *   imports → normalize → intelligence (meal/cooking plan) → occurrences → session drafts
 *   → acceptPlanApply persists sessions/calendar → automation runtime schedules/suggests
 *   → SessionRunner executes → events → (optional) Hub export handled by accept pipeline.
 *
 * This file is a COOKING-domain adapter helper used by the shared acceptance
 * pipeline (src/services/planning/acceptPlanApply.js).
 *
 * Responsibilities:
 * - Convert a normalized occurrence into a runnable Cooking Session Draft.
 * - Consolidate ALL recipe steps across selected recipes into ONE comprehensive
 *   session flow (StepGraph-style steps), including timers + prep tasks where possible.
 * - Stay defensive: tolerate missing recipe data; emit warnings via eventBus.
 * - Leave extension points: inventory linking, equipment readiness checks,
 *   preservation handoffs, nutrition, and user preference substitutions.
 *
 * Important:
 * - This file does NOT persist data itself.
 * - It may emit non-mutating advisory events (e.g. cooking.session.draft.built, warnings).
 */

/* ------------------------------ Constants ---------------------------------- */

const SOURCE = "services/cooking/planning/buildCookingSessionDraft";

/**
 * Default step timing when missing:
 * - If a step has a timer, use it.
 * - Else allow null (runner can treat as manual).
 */
const DEFAULT_STEP_MINUTES = null;

/* ------------------------------ Small helpers ------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: nowIso(), source: SOURCE, data });
  } catch (e) {
    // Event failures should not stop session drafting
    console.warn(`[${SOURCE}] eventBus.emit failed: ${type}`, e);
  }
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function toText(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (isObj(v) && typeof v.text === "string") return v.text.trim();
  return String(v).trim();
}

function normalizeTimer(raw) {
  // Accept multiple shapes:
  // - number minutes
  // - { minutes } / { seconds } / { ms }
  // - { label, minutes/seconds/ms }
  if (raw == null) return null;

  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return { label: "Timer", ms: Math.round(raw * 60 * 1000) };
  }

  if (!isObj(raw)) return null;

  const label = raw.label || raw.name || "Timer";

  const ms =
    (Number.isFinite(Number(raw.ms)) &&
      Number(raw.ms) > 0 &&
      Math.round(Number(raw.ms))) ||
    (Number.isFinite(Number(raw.seconds)) &&
      Number(raw.seconds) > 0 &&
      Math.round(Number(raw.seconds) * 1000)) ||
    (Number.isFinite(Number(raw.minutes)) &&
      Number(raw.minutes) > 0 &&
      Math.round(Number(raw.minutes) * 60 * 1000));

  if (!ms) return null;
  return { label: String(label), ms };
}

function extractEquipmentFromText(text) {
  // Lightweight heuristic (extension point: replace with proper NLP)
  const t = String(text || "").toLowerCase();
  const hits = [];
  const candidates = [
    "oven",
    "stove",
    "skillet",
    "pan",
    "pot",
    "stockpot",
    "pressure cooker",
    "instant pot",
    "slow cooker",
    "air fryer",
    "mixer",
    "blender",
    "food processor",
    "grill",
    "smoker",
    "thermometer",
    "scale",
    "sheet pan",
    "baking dish",
  ];

  for (const c of candidates) {
    if (t.includes(c)) hits.push({ name: c });
  }

  // de-dupe
  const seen = new Set();
  return hits.filter((x) => {
    const k = x.name;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Pull recipes from occurrence.meta.recipes with optional full recipe objects from context.
 * context can provide:
 * - context.recipeIndex: { [id]: recipeObject }
 * - context.getRecipeById(id): Promise<recipeObject>
 */
async function resolveRecipesFromOccurrence(occurrence, context = {}) {
  const refs = asArray(occurrence?.meta?.recipes).filter(Boolean);

  // Normalize refs: [{id,title,source}, ...]
  const ids = refs
    .map((r) => (typeof r === "string" ? r : r?.id || r?.recipeId))
    .filter(Boolean)
    .map((x) => String(x));

  const recipeIndex = context.recipeIndex || context.recipesById || null;
  const getter =
    typeof context.getRecipeById === "function" ? context.getRecipeById : null;

  const resolved = [];

  for (let i = 0; i < refs.length; i += 1) {
    const ref = refs[i];
    const id = typeof ref === "string" ? ref : ref?.id || ref?.recipeId || null;
    const title =
      typeof ref === "string" ? null : ref?.title || ref?.name || null;

    let recipe = null;
    if (id && recipeIndex && recipeIndex[id]) recipe = recipeIndex[id];
    else if (id && getter) {
      try {
        recipe = await getter(id);
      } catch {
        recipe = null;
      }
    }

    // If we only have a ref, keep a minimal recipe object so steps can still exist (empty)
    resolved.push(
      recipe && isObj(recipe)
        ? recipe
        : {
            id: id ? String(id) : null,
            title: title || (id ? `Recipe ${String(id)}` : "Recipe"),
            steps: [],
            ingredients: [],
            equipment: [],
            meta: { unresolved: true },
          }
    );
  }

  // If no refs, attempt to use context.activeRecipeSelection etc.
  if (!resolved.length) {
    const fallback = asArray(context?.selectedRecipes).filter(Boolean);
    for (const r of fallback) resolved.push(r);
  }

  // Ensure stable IDs
  const out = [];
  const seen = new Set();
  for (const r of resolved) {
    const rid = String(r?.id || r?.recipeId || r?.title || "").trim();
    if (!rid) continue;
    if (seen.has(rid)) continue;
    seen.add(rid);
    out.push({ ...r, id: r?.id || r?.recipeId || null });
  }

  return out;
}

/**
 * Normalize recipe steps from various possible shapes:
 * - recipe.steps: [string | {text, timer, minutes, ...}]
 * - recipe.instructions: [string] or string
 * - recipe.method: string
 */
function normalizeRecipeSteps(recipe) {
  if (!recipe) return [];

  const out = [];

  const pushStep = (raw, idx) => {
    if (raw == null) return;

    if (typeof raw === "string") {
      const text = raw.trim();
      if (!text) return;
      out.push({ text, timer: null, idx });
      return;
    }

    if (isObj(raw)) {
      const text =
        toText(raw.text) ||
        toText(raw.instruction) ||
        toText(raw.step) ||
        toText(raw.description) ||
        toText(raw.action);

      if (!text) return;

      // timer detection
      const timer =
        normalizeTimer(raw.timer) ||
        normalizeTimer(raw.timers?.[0]) ||
        normalizeTimer(raw.duration) ||
        normalizeTimer(raw.time);

      const minutes =
        Number.isFinite(Number(raw.minutes)) && Number(raw.minutes) > 0
          ? Math.round(Number(raw.minutes))
          : null;

      out.push({
        text,
        timer,
        minutes,
        idx,
        meta: raw.meta || null,
      });
      return;
    }
  };

  const steps = asArray(recipe.steps);
  if (steps.length) steps.forEach((s, i) => pushStep(s, i));

  const instructions = recipe.instructions;
  if (!steps.length && instructions) {
    if (typeof instructions === "string") {
      // split naïvely by newlines
      String(instructions)
        .split(/\r?\n+/)
        .map((x) => x.trim())
        .filter(Boolean)
        .forEach((s, i) => pushStep(s, i));
    } else {
      asArray(instructions).forEach((s, i) => pushStep(s, i));
    }
  }

  const method = recipe.method;
  if (!steps.length && !instructions && typeof method === "string") {
    String(method)
      .split(/\r?\n+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .forEach((s, i) => pushStep(s, i));
  }

  return out;
}

/**
 * StepGraph-ish node builder. SSA's SessionRunner can evolve,
 * but we keep a stable "step" contract:
 * {
 *   id, title, text,
 *   kind: "prep"|"cook"|"rest"|"serve"|"cleanup",
 *   timers: [{label, ms}]?,
 *   recipeId?, recipeTitle?,
 *   equipment?, ingredients?,
 *   meta?
 * }
 */
function makeStep({
  id,
  title,
  text,
  kind,
  timers,
  recipeId,
  recipeTitle,
  equipment,
  ingredients,
  meta,
}) {
  return {
    id,
    title: title || null,
    text: text || "",
    kind: kind || "cook",
    timers: Array.isArray(timers) ? timers.filter(Boolean) : [],
    recipeId: recipeId || null,
    recipeTitle: recipeTitle || null,
    equipment: Array.isArray(equipment) ? equipment : [],
    ingredients: Array.isArray(ingredients) ? ingredients : [],
    meta: meta || null,
  };
}

function makeStableStepId(sessionId, recipeId, stepIndex, phase = "cook") {
  // Step IDs should be deterministic within the session.
  const rid = recipeId ? String(recipeId) : "recipe";
  return `${sessionId}::${rid}::${phase}::${stepIndex}`;
}

/**
 * Produce a consolidated flow:
 * - global prep (gather equipment, mise en place)
 * - per-recipe steps in order
 * - global serve + cleanup
 *
 * Extension points:
 * - interleave by dependency graph (oven preheat shared, water boil shared)
 * - merge tasks across recipes (chop onions once)
 */
function buildConsolidatedSteps({ sessionId, occurrence, recipes, context }) {
  const steps = [];

  const occEquipment = asArray(occurrence?.meta?.equipment);
  const occIngredients = asArray(occurrence?.meta?.ingredients);

  const allEquipment = [];
  const allIngredients = [];

  // Collect equipment/ingredients from recipes if present
  for (const r of recipes) {
    asArray(r?.equipment).forEach((e) => allEquipment.push(e));
    asArray(r?.ingredients).forEach((i) => allIngredients.push(i));
  }

  const inferredEquipment = [];
  for (const r of recipes) {
    const rawText = [
      r?.title,
      ...normalizeRecipeSteps(r).map((s) => s.text),
    ].join(" ");
    extractEquipmentFromText(rawText).forEach((e) => inferredEquipment.push(e));
  }

  const equipment = [
    ...occEquipment,
    ...allEquipment,
    ...inferredEquipment,
  ].filter(Boolean);
  const ingredients = [...occIngredients, ...allIngredients].filter(Boolean);

  // Global Prep Step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", 0, "prep"),
      title: "Get set up",
      text: "Gather equipment, clear workspace, wash hands, and set out ingredients (mise en place).",
      kind: "prep",
      timers: [],
      equipment,
      ingredients,
      meta: {
        phase: "prep",
        suggestions: {
          // forward hooks: inventory checks, substitutions, constraints
          checkInventory: true,
          substitutions: !!context?.preferences,
        },
      },
    })
  );

  // Optional: Preheat step (heuristic)
  const shouldPreheat = equipment.some((e) =>
    String(e?.name || e)
      .toLowerCase()
      .includes("oven")
  );
  if (shouldPreheat) {
    steps.push(
      makeStep({
        id: makeStableStepId(sessionId, "global", 1, "prep"),
        title: "Preheat oven (if needed)",
        text: "Preheat the oven to the required temperature for your recipes.",
        kind: "prep",
        timers: [],
        equipment: equipment.filter((e) =>
          String(e?.name || e)
            .toLowerCase()
            .includes("oven")
        ),
        ingredients: [],
        meta: { phase: "prep", optional: true },
      })
    );
  }

  // Per-recipe steps (sequential by default)
  let globalIndex = 0;
  for (const r of recipes) {
    const rid = r?.id || r?.recipeId || r?.title || null;
    const rtitle = r?.title || r?.name || r?.label || "Recipe";

    const rSteps = normalizeRecipeSteps(r);

    if (!rSteps.length) {
      // Still create a placeholder step so session isn't empty.
      steps.push(
        makeStep({
          id: makeStableStepId(
            sessionId,
            rid || "recipe",
            globalIndex++,
            "cook"
          ),
          title: rtitle,
          text: "No detailed steps were found for this recipe. Use your preferred method or edit the recipe to add step-by-step instructions.",
          kind: "cook",
          timers: [],
          recipeId: rid ? String(rid) : null,
          recipeTitle: rtitle,
          equipment: asArray(r?.equipment),
          ingredients: asArray(r?.ingredients),
          meta: { unresolved: true },
        })
      );
      continue;
    }

    // Recipe header step (optional)
    steps.push(
      makeStep({
        id: makeStableStepId(sessionId, rid || "recipe", globalIndex++, "cook"),
        title: `Start: ${rtitle}`,
        text: "Follow the steps below. Timers will appear when specified.",
        kind: "cook",
        timers: [],
        recipeId: rid ? String(rid) : null,
        recipeTitle: rtitle,
        equipment: asArray(r?.equipment),
        ingredients: asArray(r?.ingredients),
        meta: { phase: "recipe_start" },
      })
    );

    for (let i = 0; i < rSteps.length; i += 1) {
      const s = rSteps[i];
      const timers = [];
      if (s?.timer) timers.push(s.timer);

      // If only "minutes" exists but no explicit timer object, convert it.
      if (
        !timers.length &&
        Number.isFinite(Number(s?.minutes)) &&
        Number(s.minutes) > 0
      ) {
        timers.push({
          label: "Timer",
          ms: Math.round(Number(s.minutes) * 60 * 1000),
        });
      }

      steps.push(
        makeStep({
          id: makeStableStepId(
            sessionId,
            rid || "recipe",
            globalIndex++,
            "cook"
          ),
          title: rtitle,
          text: s.text,
          kind: "cook",
          timers,
          recipeId: rid ? String(rid) : null,
          recipeTitle: rtitle,
          equipment: asArray(r?.equipment),
          ingredients: asArray(r?.ingredients),
          meta: {
            recipeStepIndex: i,
            defaultMinutes: DEFAULT_STEP_MINUTES,
            rawMeta: s.meta || null,
          },
        })
      );
    }
  }

  // Serve Step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", globalIndex++, "serve"),
      title: "Serve",
      text: "Plate, garnish, and serve. Note leftovers and any preservation handoffs (freeze, can, dehydrate).",
      kind: "serve",
      timers: [],
      equipment: [],
      ingredients: [],
      meta: {
        phase: "serve",
        preservationHandoff: occurrence?.meta?.preservationHandoff || null,
        leftovers: occurrence?.meta?.leftovers || null,
      },
    })
  );

  // Cleanup Step
  steps.push(
    makeStep({
      id: makeStableStepId(sessionId, "global", globalIndex++, "cleanup"),
      title: "Clean up",
      text: "Wash dishes, wipe surfaces, store leftovers, and reset the kitchen.",
      kind: "cleanup",
      timers: [],
      equipment: [],
      ingredients: [],
      meta: { phase: "cleanup" },
    })
  );

  return steps;
}

/* ------------------------------ Public API ---------------------------------- */

/**
 * buildCookingSessionDraft(domain, occurrence, context)
 * ---------------------------------------------------------------------------
 * Called by shared acceptPlanApply:
 *   buildSessionDraft(domain, occurrence, context)
 */
export default async function buildCookingSessionDraft(
  domain,
  occurrence,
  context = {}
) {
  // Validate
  if (!domain || typeof domain !== "string") {
    emit("cooking.session.draft.error", {
      ok: false,
      error: "domain is required",
    });
    return null;
  }
  if (!occurrence || typeof occurrence !== "object") {
    emit("cooking.session.draft.error", {
      ok: false,
      domain,
      error: "occurrence is required",
    });
    return null;
  }

  // Stable session ID ties to occurrence identity for idempotent acceptance
  const sid = stableSessionId(domain, occurrence);

  // Resolve recipes from occurrence/meta/context
  let recipes = [];
  try {
    recipes = await resolveRecipesFromOccurrence(occurrence, context);
  } catch (e) {
    emit("cooking.session.draft.warning", {
      domain,
      occurrenceId: occurrence?.id || null,
      message: "Failed to resolve recipes from occurrence/context",
      error: e?.message || String(e),
    });
    recipes = [];
  }

  // Build consolidated step flow
  const steps = buildConsolidatedSteps({
    sessionId: sid,
    occurrence,
    recipes,
    context,
  });

  // Pull high-level meta
  const title = occurrence?.title || "Cooking session";
  const startAt = occurrence?.startAt || null;
  const endAt = occurrence?.endAt || null;

  // Forward hooks: inventory checks, nutrition, substitutions, equipment readiness
  const draft = {
    id: sid,
    domain,
    status: "draft",
    title,
    occurrenceId: occurrence?.id || null,
    planId: occurrence?.planId || null,

    // Scheduling window
    startAt,
    endAt,

    // StepGraph-ish
    steps,

    // Optional: global timer registry for runner UI
    // (runner can also derive from step timers)
    timers: steps
      .flatMap((s) => asArray(s.timers).map((t) => ({ ...t, stepId: s.id })))
      .filter(Boolean),

    blockers: [],

    createdAt: nowIso(),
    updatedAt: nowIso(),

    meta: {
      adapter: "cooking",
      source: "buildCookingSessionDraft",
      mealSlot: occurrence?.meta?.mealSlot || null,
      durationMin: occurrence?.meta?.durationMin || null,
      recipes: recipes.map((r) => ({
        id: r?.id || r?.recipeId || null,
        title: r?.title || r?.name || r?.label || null,
        unresolved: !!r?.meta?.unresolved,
      })),
      // Carry forward constraints/preferences so downstream engines can act:
      constraints:
        occurrence?.meta?.constraints || context?.constraints || null,
      dietary: occurrence?.meta?.dietary || context?.dietary || null,
      preferences: context?.preferences || null,
      // Forward hooks:
      inventoryLinking: {
        enabled: true,
        mode: context?.inventoryLinkMode || "suggest", // suggest | reserve | decrement-on-complete
      },
      equipmentReadiness: {
        enabled: true,
        // could later emit equipment.shortage.detected
      },
      preservationHandoff: occurrence?.meta?.preservationHandoff || null,
    },
  };

  // Advisory event: draft built (non-mutating)
  emit("cooking.session.draft.built", {
    ok: true,
    domain,
    sessionId: sid,
    occurrenceId: occurrence?.id || null,
    recipeCount: recipes.length,
    stepCount: steps.length,
  });

  // If any recipes unresolved, emit a warning so UI can prompt user to enrich data.
  const unresolved = recipes
    .filter((r) => r?.meta?.unresolved)
    .map((r) => r?.id || r?.title);
  if (unresolved.length) {
    emit("cooking.session.draft.warning", {
      domain,
      sessionId: sid,
      occurrenceId: occurrence?.id || null,
      message:
        "Some recipes were referenced but not fully resolved from context.",
      unresolved,
    });
  }

  return draft;
}

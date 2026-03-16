/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\planning\mealPlanDraft.js
//
// SSA Meal Plan Draft Builder
// ---------------------------
// Purpose:
//  - Build a deterministic, UI-friendly "meal plan draft" object from:
//      (A) user inputs + rhythm presets,
//      (B) optional recommender outputs (ranked recipes/components),
//      (C) optional farm-to-table pipeline deltas (component demand / target deltas / inventory deltas),
//      (D) optional nutrition preview.
//  - The Meal Planner UI should be able to render a plan WITHOUT being forced
//    to show farm-to-table outputs. Those are attached under `pipeline` and
//    `visibilityHints` so VisibilityRulesEngine can decide what to display.
//
// Notes:
//  - This module is intentionally framework-agnostic (no React).
//  - It does not hard-depend on Dexie or stores.
//  - It produces stable IDs and timestamps.
//  - It includes safe fallbacks and validation.
//
// Expected usage (typical):
//   import { buildMealPlanDraft } from "@/services/planning/mealPlanDraft";
//   const draft = buildMealPlanDraft({ profile, rhythm, days, slots, suggestions, pipeline });
//   MealPlanStore.setPlan(draft)
//
// Exported API:
//  - buildMealPlanDraft(input, opts)
//  - normalizeMealPlanDraft(draft)
//  - validateMealPlanDraft(draft) -> { ok, errors, warnings }
//  - stripPipelineForUI(draft)    -> draft without heavy pipeline payloads
//  - helpers: stableHash32, uid, asArray, clamp, round2
//

/* -------------------------------------------------------------------------- */
/*  Small utilities                                                           */
/* -------------------------------------------------------------------------- */

export function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

export function clamp(n, lo, hi) {
  const x = Number.isFinite(+n) ? +n : lo;
  return Math.max(lo, Math.min(hi, x));
}

export function round2(n) {
  const x = Number.isFinite(+n) ? +n : 0;
  return Math.round(x * 100) / 100;
}

// Stable, tiny 32-bit hash for deterministic IDs (matches your App.jsx helper style)
export function stableHash32(str) {
  const s = String(str || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function uid(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}_${stableHash32(
    `${Math.random()}`,
  )}`;
}

function isoNow() {
  return new Date().toISOString();
}

function safeStr(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function shallowClone(o) {
  return o && typeof o === "object" ? { ...o } : {};
}

function deepCloneJSON(o) {
  try {
    return JSON.parse(JSON.stringify(o ?? null));
  } catch {
    return o ?? null;
  }
}

function pick(obj, keys = []) {
  const o = safeObj(obj);
  const out = {};
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Canonical-ish shapes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A plan "slot" is a named eating opportunity within a day.
 * Example:
 *   { key: "breakfast", label: "Breakfast", kind:"meal", targetKcal: 550 }
 */
function normalizeSlot(slot, idx = 0) {
  const s = safeObj(slot);
  const key = safeStr(s.key, `slot_${idx}`);
  return {
    key,
    label: safeStr(s.label, titleCase(key.replace(/_/g, " "))),
    kind: safeStr(s.kind, "meal"), // meal | snack | beverage | prep | optional
    // Targets: these are optional and safe
    targetKcal: safeNum(s.targetKcal, 0),
    targetProteinG: safeNum(s.targetProteinG, 0),
    targetCarbsG: safeNum(s.targetCarbsG, 0),
    targetFatG: safeNum(s.targetFatG, 0),
    // visibility: can be used to hide breakfast in IF windows, etc.
    enabled: s.enabled !== false,
    notes: s.notes ? safeStr(s.notes, "") : "",
    tags: asArray(s.tags)
      .map((t) => safeStr(t))
      .filter(Boolean),
  };
}

function titleCase(str) {
  return String(str || "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.slice(0, 1).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * A "plan item" is an assignment in a slot (recipe/component).
 * It must remain lightweight for UI and execution.
 */
function normalizePlanItem(item, fallbackKey) {
  const it = safeObj(item);
  const type = safeStr(it.type, "recipe"); // recipe | component | meal | leftover | external
  const id =
    safeStr(it.id, "") ||
    safeStr(it.recipeId, "") ||
    safeStr(it.componentId, "") ||
    uid("item");

  const label =
    safeStr(it.label, "") ||
    safeStr(it.title, "") ||
    safeStr(it.name, "") ||
    (type === "recipe" ? `Recipe ${id}` : `Item ${id}`);

  // Amount/servings: support either `servings` or `qty/unit` semantics
  const servings = safeNum(it.servings ?? it.portions ?? it.yields, 0);
  const qty = safeNum(it.qty, 0);
  const unit = safeStr(it.unit, "");

  // Provide canonical "amount"
  const amount =
    it.amount && typeof it.amount === "object"
      ? {
          value: safeNum(it.amount.value, 0),
          unit: safeStr(it.amount.unit, ""),
        }
      : qty && unit
        ? { value: qty, unit }
        : servings
          ? { value: servings, unit: "serving" }
          : null;

  const tags = asArray(it.tags)
    .map((t) => safeStr(t))
    .filter(Boolean);

  // Optional links for later pipeline/homestead details (not shown by default)
  const links = safeObj(it.links);

  return {
    key: safeStr(it.key, fallbackKey || uid("pi")),
    type,
    id,
    label,
    amount,
    servings: servings || (amount?.unit === "serving" ? amount.value : 0),
    notes: safeStr(it.notes, ""),
    tags,
    // Optional: route to recipe / component in UI
    href: safeStr(it.href, ""),
    // Optional: meta used by engines (kept lightweight)
    meta: shallowClone(it.meta),
    links: shallowClone(links),
  };
}

/* -------------------------------------------------------------------------- */
/*  Pipeline payload normalization (farm-to-table outputs)                      */
/* -------------------------------------------------------------------------- */

function normalizePipeline(pipeline) {
  const p = safeObj(pipeline);

  // Expected optional fields:
  // - componentDemand: { items: [{id,label,qty,unit,source,confidence}...] }
  // - targetDeltas: { items: [{id,label,delta,unit,why}...] }
  // - inventoryDeltas: { items: [{id,label,delta,unit,reason,when}...] }
  //
  // Keep payload intact but normalize the most common properties.
  const normList = (arr) =>
    asArray(arr)
      .map((x) => safeObj(x))
      .map((x) => ({
        id: safeStr(x.id, safeStr(x.itemId, "")),
        label: safeStr(x.label, safeStr(x.name, "")),
        qty: safeNum(
          x.qty ?? x.amount?.value ?? x.value ?? x.delta ?? x.change,
          0,
        ),
        unit: safeStr(x.unit, safeStr(x.amount?.unit, "")),
        delta: safeNum(x.delta ?? x.change ?? 0, 0),
        source: safeStr(x.source, ""),
        why: safeStr(x.why ?? x.reason ?? "", ""),
        confidence: clamp(safeNum(x.confidence, 0), 0, 1),
        meta: shallowClone(x.meta),
      }))
      .filter((x) => x.id || x.label);

  const componentDemand = safeObj(p.componentDemand);
  const targetDeltas = safeObj(p.targetDeltas);
  const inventoryDeltas = safeObj(p.inventoryDeltas);

  return {
    // Keep raw too (in case upstream uses a richer structure)
    raw: deepCloneJSON(p),

    componentDemand: {
      items: normList(componentDemand.items ?? componentDemand.list ?? []),
      summary: safeStr(componentDemand.summary, ""),
    },

    targetDeltas: {
      items: normList(targetDeltas.items ?? targetDeltas.list ?? []),
      summary: safeStr(targetDeltas.summary, ""),
    },

    inventoryDeltas: {
      items: normList(inventoryDeltas.items ?? inventoryDeltas.list ?? []),
      summary: safeStr(inventoryDeltas.summary, ""),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Primary builder                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Build a plan draft
 *
 * input fields (best-effort, all optional):
 *  - profile: { householdId, userId, timezone, locale, cuisinePrefs, tools, ... }
 *  - rhythm:  { preset, window, mealsPerDay, fasting, ... }
 *  - days:    array or number (count)
 *  - startDate: ISO date string or Date
 *  - slots:   array of slot definitions (breakfast/lunch/dinner/snacks)
 *  - suggestions: recommender output (ranked recipes/components per slot/day)
 *  - selections: user-chosen assignments
 *  - nutritionPreview: { totals, perDay, perSlot }
 *  - pipeline: farm-to-table outputs (component demand/target/inventory deltas)
 *  - meta: { title, notes, tags }
 *
 * opts:
 *  - module: "meal_planning" | "homestead" etc. (affects visibility hints only)
 *  - includePipelineInDraft: boolean (default true)
 *  - visibility: { showPipelineByDefault?: boolean } (default false)
 */
export function buildMealPlanDraft(input = {}, opts = {}) {
  const i = safeObj(input);
  const o = safeObj(opts);

  const now = isoNow();

  const profile = safeObj(i.profile);
  const rhythm = safeObj(i.rhythm);

  const locale = safeStr(profile.locale, "en-US");
  const timezone = safeStr(profile.timezone, safeStr(i.timezone, ""));

  const startDate = normalizeStartDate(i.startDate || i.date || now);
  const dayCount = normalizeDayCount(i.days);
  const endDate = addDaysISO(startDate, dayCount - 1);

  const module = normalizeModuleToken(o.module || i.module || "meal_planning");

  const baseId =
    safeStr(i.id, "") ||
    safeStr(i.planId, "") ||
    `plan_${stableHash32(
      [
        profile.householdId || profile.household?.id || "",
        startDate,
        dayCount,
        rhythm.preset || "",
        rhythm.window || "",
        locale,
        module,
      ].join("|"),
    )}`;

  const slots = normalizeSlots(i.slots, rhythm);

  // Build day frames
  const days = buildDays({
    startDate,
    dayCount,
    slots,
    suggestions: i.suggestions,
    selections: i.selections,
  });

  const tags = [
    ...asArray(i.meta?.tags),
    ...asArray(i.tags),
    ...(module ? [`module.${module}`] : []),
  ]
    .map((t) => safeStr(t))
    .filter(Boolean);

  // Pipeline outputs (farm-to-table): attach but do not force UI to show
  const includePipelineInDraft =
    o.includePipelineInDraft !== false && i.pipeline != null;

  const pipeline = includePipelineInDraft
    ? normalizePipeline(i.pipeline)
    : null;

  // Visibility hints: VisibilityRulesEngine can decide.
  const showPipelineByDefault =
    Boolean(o.visibility?.showPipelineByDefault) ||
    Boolean(i.visibility?.showPipelineByDefault) ||
    module === "homestead"; // homestead can show these by default if desired

  const visibilityHints = {
    module,
    // UI should not show farm-to-table sections unless this is true
    showPipelineByDefault,
    // quick flags
    hasPipeline: Boolean(pipeline),
    // allow future gating: compact summary for badges
    pipelineCounts: pipeline
      ? {
          componentDemand: pipeline.componentDemand.items.length,
          targetDeltas: pipeline.targetDeltas.items.length,
          inventoryDeltas: pipeline.inventoryDeltas.items.length,
        }
      : { componentDemand: 0, targetDeltas: 0, inventoryDeltas: 0 },
  };

  // Nutrition preview is optional
  const nutritionPreview = normalizeNutritionPreview(i.nutritionPreview);

  const draft = {
    schemaVersion: "1.0.0",
    kind: "meal_plan_draft",
    id: baseId,
    createdAt: safeStr(i.createdAt, now),
    updatedAt: now,

    meta: {
      title:
        safeStr(i.meta?.title, "") ||
        safeStr(i.title, "") ||
        `Meal Plan (${shortDate(startDate)} → ${shortDate(endDate)})`,
      notes: safeStr(i.meta?.notes, safeStr(i.notes, "")),
      locale,
      timezone: timezone || null,
      tags,
      // identifying
      householdId:
        safeStr(profile.householdId, "") || safeStr(profile.household?.id, ""),
      userId: safeStr(profile.userId, "") || safeStr(profile.user?.id, ""),
    },

    range: {
      startDate,
      endDate,
      dayCount,
    },

    rhythm: {
      preset: safeStr(rhythm.preset, safeStr(i.rhythmPreset, "")),
      window: safeStr(rhythm.window, safeStr(i.window, "")),
      mealsPerDay: safeNum(rhythm.mealsPerDay, safeNum(i.mealsPerDay, 0)),
      fasting: Boolean(rhythm.fasting ?? i.fasting ?? false),
      // Keep raw rhythm config for engines
      config: deepCloneJSON(rhythm),
    },

    slots,

    days,

    // Optional recommender artifacts (kept lightweight)
    suggestions: normalizeSuggestions(i.suggestions),

    // Optional nutrition
    nutritionPreview,

    // Pipeline + rendering hints
    pipeline,
    visibilityHints,

    // Execution scaffolding: used by runners
    execution: {
      status: safeStr(i.execution?.status, "draft"), // draft|accepted|scheduled|executing|completed
      // A runner can create sessions per day/slot; store IDs here after accept/apply
      sessions: asArray(i.execution?.sessions).map((s) => safeObj(s)),
      // UI / audit
      lastAppliedAt: safeStr(i.execution?.lastAppliedAt, ""),
    },
  };

  return normalizeMealPlanDraft(draft);
}

/* -------------------------------------------------------------------------- */
/*  Draft normalization                                                        */
/* -------------------------------------------------------------------------- */

export function normalizeMealPlanDraft(draft) {
  const d = safeObj(draft);

  const meta = safeObj(d.meta);
  const range = safeObj(d.range);

  const startDate = normalizeStartDate(range.startDate || d.startDate);
  const dayCount = normalizeDayCount(range.dayCount || d.dayCount);

  const endDate =
    safeStr(range.endDate, "") || addDaysISO(startDate, dayCount - 1);

  const slots = asArray(d.slots).map(normalizeSlot);
  const days = asArray(d.days).map((day, idx) =>
    normalizeDay(day, idx, startDate, slots),
  );

  const out = {
    schemaVersion: safeStr(d.schemaVersion, "1.0.0"),
    kind: safeStr(d.kind, "meal_plan_draft"),
    id: safeStr(d.id, uid("plan")),
    createdAt: safeStr(d.createdAt, isoNow()),
    updatedAt: safeStr(d.updatedAt, isoNow()),

    meta: {
      title: safeStr(meta.title, "Meal Plan"),
      notes: safeStr(meta.notes, ""),
      locale: safeStr(meta.locale, "en-US"),
      timezone: meta.timezone ? safeStr(meta.timezone, "") : null,
      tags: asArray(meta.tags)
        .map((t) => safeStr(t))
        .filter(Boolean),
      householdId: safeStr(meta.householdId, ""),
      userId: safeStr(meta.userId, ""),
    },

    range: { startDate, endDate, dayCount },

    rhythm: normalizeRhythm(d.rhythm),

    slots,

    days,

    suggestions: normalizeSuggestions(d.suggestions),
    nutritionPreview: normalizeNutritionPreview(d.nutritionPreview),

    pipeline: d.pipeline
      ? normalizePipeline(d.pipeline.raw || d.pipeline)
      : null,

    visibilityHints: normalizeVisibilityHints(d.visibilityHints),

    execution: normalizeExecution(d.execution),
  };

  return out;
}

function normalizeRhythm(rhythm) {
  const r = safeObj(rhythm);
  return {
    preset: safeStr(r.preset, ""),
    window: safeStr(r.window, ""),
    mealsPerDay: safeNum(r.mealsPerDay, 0),
    fasting: Boolean(r.fasting ?? false),
    config: deepCloneJSON(r.config ?? r),
  };
}

function normalizeExecution(execution) {
  const e = safeObj(execution);
  return {
    status: safeStr(e.status, "draft"),
    sessions: asArray(e.sessions).map((s) => safeObj(s)),
    lastAppliedAt: safeStr(e.lastAppliedAt, ""),
  };
}

function normalizeVisibilityHints(h) {
  const x = safeObj(h);
  const module = normalizeModuleToken(x.module);
  const counts = safeObj(x.pipelineCounts);
  return {
    module,
    showPipelineByDefault: Boolean(x.showPipelineByDefault),
    hasPipeline: Boolean(x.hasPipeline),
    pipelineCounts: {
      componentDemand: safeNum(counts.componentDemand, 0),
      targetDeltas: safeNum(counts.targetDeltas, 0),
      inventoryDeltas: safeNum(counts.inventoryDeltas, 0),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Days + slot assignment                                                     */
/* -------------------------------------------------------------------------- */

function normalizeSlots(slotsInput, rhythm) {
  const slotsRaw = asArray(slotsInput);

  // If caller provided slots explicitly, use them.
  if (slotsRaw.length) return slotsRaw.map(normalizeSlot);

  // Otherwise derive from rhythm presets:
  const mealsPerDay = safeNum(rhythm?.mealsPerDay, 0);

  // Default slots:
  // - If mealsPerDay <= 1: lunch/dinner as a single main meal
  // - If 2: lunch + dinner
  // - If 3+: breakfast + lunch + dinner (+ snack optional)
  if (mealsPerDay <= 1) {
    return [normalizeSlot({ key: "main_meal", label: "Main Meal" }, 0)];
  }
  if (mealsPerDay === 2) {
    return [
      normalizeSlot({ key: "lunch", label: "Lunch" }, 0),
      normalizeSlot({ key: "dinner", label: "Dinner" }, 1),
    ];
  }
  const base = [
    normalizeSlot({ key: "breakfast", label: "Breakfast" }, 0),
    normalizeSlot({ key: "lunch", label: "Lunch" }, 1),
    normalizeSlot({ key: "dinner", label: "Dinner" }, 2),
  ];
  if (mealsPerDay >= 4) {
    base.push(
      normalizeSlot({ key: "snack", label: "Snack", kind: "snack" }, 3),
    );
  }
  return base;
}

function buildDays({ startDate, dayCount, slots, suggestions, selections }) {
  const out = [];
  const sug = safeObj(suggestions);
  const sel = safeObj(selections);

  for (let i = 0; i < dayCount; i++) {
    const date = addDaysISO(startDate, i);

    // Build slot assignments:
    const slotItems = {};

    for (const slot of slots) {
      const slotKey = slot.key;

      // Priority for assignments:
      // 1) explicit selections[date][slotKey]
      // 2) suggestions.perDay[date][slotKey]
      // 3) suggestions.perSlot[slotKey][i] (nth day)
      // 4) none
      const chosen =
        sel?.[date]?.[slotKey] ??
        sug?.perDay?.[date]?.[slotKey] ??
        asArray(sug?.perSlot?.[slotKey])[i] ??
        null;

      if (chosen) {
        slotItems[slotKey] = asArray(chosen).map((x, idx) =>
          normalizePlanItem(x, `${date}_${slotKey}_${idx}`),
        );
      } else {
        slotItems[slotKey] = [];
      }
    }

    out.push(
      normalizeDay(
        {
          date,
          slots: slotItems,
          meta: {
            weekday: weekdayName(date),
          },
        },
        i,
        startDate,
        slots,
      ),
    );
  }

  return out;
}

function normalizeDay(day, idx, startDate, slots) {
  const d = safeObj(day);
  const date = normalizeStartDate(
    d.date || (startDate ? addDaysISO(startDate, idx) : isoNow()),
  );

  const slotsObj = safeObj(d.slots);

  const normalizedSlots = {};
  for (const s of slots) {
    const key = s.key;
    normalizedSlots[key] = asArray(slotsObj[key]).map((x, j) =>
      normalizePlanItem(x, `${date}_${key}_${j}`),
    );
  }

  return {
    date,
    slots: normalizedSlots,
    meta: {
      weekday: safeStr(d.meta?.weekday, weekdayName(date)),
      notes: safeStr(d.meta?.notes, ""),
      tags: asArray(d.meta?.tags)
        .map((t) => safeStr(t))
        .filter(Boolean),
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Suggestions + Nutrition preview normalization                               */
/* -------------------------------------------------------------------------- */

function normalizeSuggestions(suggestions) {
  const s = safeObj(suggestions);
  // Keep as lightweight as possible. UI can render ranks and allow "apply".
  // Common shapes supported:
  // - { perDay: { [date]: { [slotKey]: [items...] } } }
  // - { perSlot: { [slotKey]: [items...] } }
  // - { ranked: [items...] }
  const normalizeItem = (x, idx) => {
    const it = safeObj(x);
    return {
      id:
        safeStr(it.id, "") ||
        safeStr(it.recipeId, "") ||
        safeStr(it.componentId, "") ||
        uid("sug"),
      label: safeStr(
        it.label,
        safeStr(it.title, safeStr(it.name, "Suggestion")),
      ),
      type: safeStr(it.type, "recipe"),
      score: round2(safeNum(it.score, safeNum(it.rankScore, 0))),
      rank: safeNum(it.rank, idx + 1),
      reason: safeStr(it.reason, safeStr(it.why, "")),
      tags: asArray(it.tags)
        .map((t) => safeStr(t))
        .filter(Boolean),
      meta: shallowClone(it.meta),
    };
  };

  const perDay = safeObj(s.perDay);
  const outPerDay = {};
  for (const [date, bySlot] of Object.entries(perDay)) {
    outPerDay[date] = {};
    const bs = safeObj(bySlot);
    for (const [slotKey, items] of Object.entries(bs)) {
      outPerDay[date][slotKey] = asArray(items).map(normalizeItem);
    }
  }

  const perSlot = safeObj(s.perSlot);
  const outPerSlot = {};
  for (const [slotKey, items] of Object.entries(perSlot)) {
    outPerSlot[slotKey] = asArray(items).map(normalizeItem);
  }

  const ranked = asArray(s.ranked ?? s.items ?? s.list).map(normalizeItem);

  // If everything empty, return null
  if (
    !Object.keys(outPerDay).length &&
    !Object.keys(outPerSlot).length &&
    ranked.length === 0
  ) {
    return null;
  }

  return {
    perDay: outPerDay,
    perSlot: outPerSlot,
    ranked,
  };
}

function normalizeNutritionPreview(preview) {
  if (!preview) return null;
  const p = safeObj(preview);

  const normMacros = (m) => {
    const x = safeObj(m);
    return {
      kcal: round2(safeNum(x.kcal ?? x.calories, 0)),
      proteinG: round2(safeNum(x.proteinG ?? x.protein ?? 0)),
      carbsG: round2(safeNum(x.carbsG ?? x.carbs ?? 0)),
      fatG: round2(safeNum(x.fatG ?? x.fat ?? 0)),
      fiberG: round2(safeNum(x.fiberG ?? x.fiber ?? 0)),
      sodiumMg: round2(safeNum(x.sodiumMg ?? x.sodium ?? 0)),
    };
  };

  const perDay = safeObj(p.perDay);
  const outPerDay = {};
  for (const [date, macros] of Object.entries(perDay)) {
    outPerDay[date] = normMacros(macros);
  }

  const perSlot = safeObj(p.perSlot);
  const outPerSlot = {};
  for (const [slotKey, macros] of Object.entries(perSlot)) {
    outPerSlot[slotKey] = normMacros(macros);
  }

  return {
    totals: normMacros(p.totals ?? p.total ?? {}),
    perDay: outPerDay,
    perSlot: outPerSlot,
    notes: safeStr(p.notes, ""),
  };
}

/* -------------------------------------------------------------------------- */
/*  Validation                                                                 */
/* -------------------------------------------------------------------------- */

export function validateMealPlanDraft(draft) {
  const d = safeObj(draft);
  const errors = [];
  const warnings = [];

  if (!d.id) errors.push("Missing draft.id");
  if (!d.kind) warnings.push("Missing draft.kind (defaulted by normalize)");
  if (!d.range?.startDate) errors.push("Missing range.startDate");
  if (!d.range?.dayCount) warnings.push("Missing range.dayCount");

  const slots = asArray(d.slots);
  if (!slots.length) errors.push("No slots defined");

  const days = asArray(d.days);
  if (!days.length) warnings.push("No days in draft");

  for (const day of days) {
    if (!day.date) errors.push("Day missing date");
    for (const slot of slots) {
      const list = asArray(day.slots?.[slot.key]);
      for (const item of list) {
        if (!item.id)
          warnings.push(`Item missing id on ${day.date}/${slot.key}`);
        if (!item.label)
          warnings.push(`Item missing label on ${day.date}/${slot.key}`);
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* -------------------------------------------------------------------------- */
/*  UI helpers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Strip heavy pipeline payloads while keeping summary and counts.
 * Useful if you want to keep MealPlanStore light.
 */
export function stripPipelineForUI(draft) {
  const d = normalizeMealPlanDraft(draft);
  if (!d.pipeline) return d;

  const counts = safeObj(d.visibilityHints?.pipelineCounts);
  return {
    ...d,
    pipeline: {
      raw: null,
      componentDemand: {
        items: [],
        summary: d.pipeline.componentDemand.summary,
      },
      targetDeltas: { items: [], summary: d.pipeline.targetDeltas.summary },
      inventoryDeltas: {
        items: [],
        summary: d.pipeline.inventoryDeltas.summary,
      },
    },
    visibilityHints: {
      ...d.visibilityHints,
      hasPipeline: true,
      pipelineCounts: {
        componentDemand: safeNum(counts.componentDemand, 0),
        targetDeltas: safeNum(counts.targetDeltas, 0),
        inventoryDeltas: safeNum(counts.inventoryDeltas, 0),
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Date helpers (ISO date-only)                                               */
/* -------------------------------------------------------------------------- */

function normalizeStartDate(d) {
  if (!d) return isoDateOnly(new Date());
  if (d instanceof Date) return isoDateOnly(d);

  const s = String(d);
  // Accept full ISO and take date portion
  const datePart = s.includes("T") ? s.split("T")[0] : s.split(" ")[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return datePart;

  // Try parse
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return isoDateOnly(parsed);

  return isoDateOnly(new Date());
}

function isoDateOnly(date) {
  const dt = date instanceof Date ? date : new Date(date);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysISO(isoDate, days) {
  const [y, m, d] = String(isoDate)
    .split("-")
    .map((x) => parseInt(x, 10));
  const dt = new Date(y, (m || 1) - 1, d || 1);
  dt.setDate(dt.getDate() + (Number.isFinite(+days) ? +days : 0));
  return isoDateOnly(dt);
}

function normalizeDayCount(days) {
  // can be number OR array of dates/objects
  if (Array.isArray(days)) {
    const n = days.length;
    return clamp(n || 1, 1, 31);
  }
  if (days && typeof days === "object") {
    // { count: 7 } or { dayCount: 7 }
    const n = safeNum(days.count ?? days.dayCount, 0);
    return clamp(n || 1, 1, 31);
  }
  const n = safeNum(days, 0);
  return clamp(n || 7, 1, 31);
}

function weekdayName(isoDate) {
  try {
    const [y, m, d] = String(isoDate)
      .split("-")
      .map((x) => parseInt(x, 10));
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString("en-US", { weekday: "long" });
  } catch {
    return "";
  }
}

function shortDate(isoDate) {
  try {
    const [y, m, d] = String(isoDate)
      .split("-")
      .map((x) => parseInt(x, 10));
    const dt = new Date(y, (m || 1) - 1, d || 1);
    return dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return String(isoDate || "");
  }
}

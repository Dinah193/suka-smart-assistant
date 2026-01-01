// src/contracts/events.js
/**
 * Central event contracts for Suka Smart Assistant
 * -------------------------------------------------
 * - Canonical event names (with backward-compatible aliases)
 * - Minimal runtime payload validation (safe in browser & Node)
 * - Ergonomic wrappers: on(), emit(), once(), off()
 * - Typed-ish JSDoc for editor IntelliSense
 *
 * IMPORTANT:
 * - Prefer these names when emitting/listening.
 * - Legacy names are still supported via ALIASES (logged once).
 * - Keep payloads small; include IDs and summary fields, not entire graphs.
 */

// -------------------------------
// Lightweight validation helpers
// -------------------------------
const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string";
const isBool = (x) => typeof x === "boolean";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const isArr = (x) => Array.isArray(x);
const isDateish = (v) => isStr(v) || v instanceof Date;
const opt = (fn) => (v) => v == null || fn(v);
const oneOf = (...fns) => (v) => fns.some((f) => f(v));
const listOf = (fn) => (v) => isArr(v) && v.every(fn);
const isIn = (choices) => (v) => isStr(v) && choices.includes(v);

/** @typedef {{id:string, title?:string}} MealRef */
/** @typedef {{date:string, slot:string}} SlotRef */
/** @typedef {{id:string, templateId?:string, startsOn?:string|Date, endsOn?:string|Date, meta?:object}} PlanDraft */
/** @typedef {{id:string, lines:number, preview?:string}} GroceryListRef */

/**
 * Basic schema spec:
 *  { required: { key: validatorFn }, optional: { key: validatorFn } }
 * Returns normalized object or throws an Error with details.
 */
function validatePayload(spec, payload, evtName) {
  if (!isObj(payload)) throw new Error(`[events:${evtName}] Payload must be an object`);
  const out = {};
  const req = spec.required || {};
  const optSpec = spec.optional || {};
  const errors = [];

  for (const [k, fn] of Object.entries(req)) {
    const v = payload[k];
    if (!fn(v)) errors.push(`missing/invalid "${k}"`);
    else out[k] = v;
  }
  for (const [k, fn] of Object.entries(optSpec)) {
    const v = payload[k];
    if (v !== undefined) {
      if (!fn(v)) errors.push(`invalid optional "${k}"`);
      else out[k] = v;
    }
  }
  if (errors.length) throw new Error(`[events:${evtName}] ${errors.join(", ")}`);
  return out;
}

// -------------------------------
// Canonical Event Contracts
// -------------------------------
/**
 * Each event has:
 *  - description
 *  - payload: { required, optional } schema validators
 *  - version: bump when payload semantics change
 */
export const EVENTS = {
  // ─────────────────────────────────────────────────────────
  // RECIPE IMPORT / NORMALIZATION / TAGGING
  // ─────────────────────────────────────────────────────────
  "recipe.import.requested": {
    version: 1,
    description: "User or agent requested importing a recipe (URL, file, paste).",
    payload: {
      required: {
        requestId: isStr,
        sourceType: isIn(["url", "file", "paste"]),
      },
      optional: {
        url: opt(isStr),
        filename: opt(isStr),
        mime: opt(isStr),
        raw: opt(isStr), // raw pasted content
        initiatedBy: opt(isIn(["user", "agent", "automation"])),
      },
    },
  },

  "recipe.imported.normalized": {
    version: 1,
    description: "Raw recipe parsed & normalized to contract shape.",
    payload: {
      required: {
        requestId: isStr,
        recipe: (v) => isObj(v) && isStr(v.id), // minimal { id, ... }
      },
      optional: {
        sourceType: opt(isIn(["url", "file", "paste"])),
        url: opt(isStr),
        qualityScore: opt(isNum), // 0..1 confidence
        warnings: opt(listOf(isStr)), // e.g., "missing yield"
      },
    },
  },

  "recipe.tagging.completed": {
    version: 1,
    description: "Classifier/tagger assigned metadata (course, cuisine, effort, diet).",
    payload: {
      required: {
        recipeId: isStr,
      },
      optional: {
        tags: opt(listOf(isStr)),
        classifiers: opt(isObj), // { course, cuisine, effort, dietaryFlags[], allergenProfile[] }
        confidence: opt(isNum),
        durationMs: opt(isNum),
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // INVENTORY LINKS & SHORTAGES
  // ─────────────────────────────────────────────────────────
  "inventory.linked": {
    version: 1,
    description: "A recipe/ingredient/grocery line was linked to an inventory item.",
    payload: {
      required: {
        itemId: isStr, // inventory item id
        linkType: isIn(["recipe.ingredient", "grocery.item", "batch.output"]),
        linkId: isStr, // e.g., ingredientId or groceryItemId
      },
      optional: {
        source: opt(isIn(["import", "author", "nba", "user"])),
        notes: opt(isStr),
      },
    },
  },

  "inventory.shortage.detected": {
    version: 1,
    description: "Planner detected a shortage for upcoming slots; may trigger grocery suggestions.",
    payload: {
      required: {
        shortageId: isStr,
        items: listOf((x) => isObj(x) && isStr(x.id) && isNum(x.missingQty || x.missingQuantity)),
      },
      optional: {
        draftId: opt(isStr),
        slots: opt(listOf((s) => isObj(s) && isStr(s.date) && isStr(s.slot))), // SlotRef[]
        triggeredBy: opt(isIn(["mealplan", "grocery", "inventory", "agent"])),
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // DECIDER & CONFLICT RESOLUTION
  // ─────────────────────────────────────────────────────────
  "decider.invoked": {
    version: 1,
    description: "Decision engine invoked to pick recipes/items/options.",
    payload: {
      required: {
        requestId: isStr,
        source: isIn(["mealPlanner", "vault", "nba"]),
      },
      optional: {
        context: opt(isObj), // e.g., filters, active slot, user prefs
        candidates: opt(listOf((c) => isObj(c) && isStr(c.id))), // recipe ids, etc.
      },
    },
  },

  "planner.conflict.detected": {
    version: 1,
    description: "Detected scheduling/resource conflict (appliance, time, sabbath, allergy).",
    payload: {
      required: {
        conflictId: isStr,
        kind: isIn(["appliance", "time", "sabbath", "allergy", "inventory", "overlap"]),
      },
      optional: {
        draftId: opt(isStr),
        slots: opt(listOf((s) => isObj(s) && isStr(s.date) && isStr(s.slot))),
        details: opt(isObj), // { applianceId?, window?, reason? }
      },
    },
  },

  "decider.resolution.requested": {
    version: 1,
    description: "Ask decider to propose a fix for a detected conflict.",
    payload: {
      required: {
        conflictId: isStr,
        requestId: isStr,
      },
      optional: {
        strategies: opt(listOf(isStr)), // e.g., ["swap-slot","no-cook","leftovers-first"]
        context: opt(isObj),
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // MEAL PLAN LIFECYCLE (existing + new request/apply)
  // ─────────────────────────────────────────────────────────
  "mealplan.draft.requested": {
    version: 1,
    description: "User or agent asked to create a new meal plan draft from a template or rules.",
    payload: {
      required: {
        requestId: isStr,
      },
      optional: {
        templateId: opt(isStr),
        days: opt(isNum),
        startDate: opt(isDateish),
        params: opt(isObj),
        source: opt(isIn(["user", "agent", "automation"])),
      },
    },
  },

  "mealplan.draft.generated": {
    version: 2,
    description: "Draft was generated (may still be unfilled recipes).",
    payload: {
      required: {
        requestId: isStr,
        draft: (v) => isObj(v) && isStr(v.id), // PlanDraft
      },
      optional: {
        templateId: opt(isStr),
        notes: opt(isStr),
      },
    },
  },

  "mealplan.applied": {
    version: 1,
    description: "A draft was applied/loaded into the planner UI.",
    payload: {
      required: {
        draftId: isStr,
      },
      optional: {
        templateId: opt(isStr),
        reason: opt(isStr), // "user-selected", "imported", "autofill"
      },
    },
  },

  "mealplan.updated": {
    version: 2,
    description: "Draft contents changed (slot swaps, clears, autofill writes, etc).",
    payload: {
      required: {
        draft: (v) => isObj(v) && isStr(v.id),
      },
      optional: {
        cause: opt(isIn(["swap", "suggestion", "clear", "clone", "agent"])),
      },
    },
  },

  "mealplan.undo": {
    version: 1,
    description: "Undo action was executed for a plan operation.",
    payload: {
      required: {
        draftId: isStr,
        op: isStr, // operation name reversed
      },
      optional: {
        meta: opt(isObj),
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // GROCERY LIST LIFECYCLE (new names + alias bridge)
  // ─────────────────────────────────────────────────────────
  "grocerylist.requested": {
    version: 1,
    description: "User/agent requested grocery list generation for a plan/dates.",
    payload: {
      required: {
        requestId: isStr,
      },
      optional: {
        draftId: opt(isStr),
        dateRange: opt(
          (r) =>
            isObj(r) &&
            isStr(r.start) &&
            isStr(r.end)
        ),
        options: opt(isObj), // mirrors list.options subset
        source: opt(isIn(["user", "agent", "automation"])),
      },
    },
  },

  "grocerylist.generated": {
    version: 1,
    description: "Grocery list generated.",
    payload: {
      required: {
        requestId: isStr,
        list: (v) => isObj(v) && isStr(v.id), // GroceryListRef (id required, lines optional)
      },
      optional: {
        draftId: opt(isStr),
        lines: opt(isNum),
        preview: opt(isStr),
      },
    },
  },

  // (kept for historical context; alias maps to grocerylist.generated)
  "mealplan.grocerylist.generated": {
    version: 1,
    description: "Deprecated alias for grocerylist.generated.",
    payload: {
      required: { draftId: isStr, list: (v) => isObj(v) && isStr(v.id) },
      optional: { lines: opt(isNum), preview: opt(isStr) },
    },
  },

  // ─────────────────────────────────────────────────────────
  // PREP TASKS / BATCH PREP
  // ─────────────────────────────────────────────────────────
  "prep.tasks.requested": {
    version: 1,
    description: "Request to build prep tasks (from meal plan, batch template, or NBA).",
    payload: {
      required: {
        requestId: isStr,
      },
      optional: {
        draftId: opt(isStr),
        slots: opt(listOf((s) => isObj(s) && isStr(s.date) && isStr(s.slot))), // SlotRef[]
        source: opt(isIn(["mealPlanner", "vault", "nba", "user"])),
        params: opt(isObj), // { includeLabels?, timers?, safety? }
      },
    },
  },

  "prep.tasks.created": {
    version: 1,
    description: "Prep tasks were generated and attached to session or plan.",
    payload: {
      required: {
        requestId: isStr,
        tasks: listOf((t) => isObj(t) && isStr(t.id)),
      },
      optional: {
        sessionId: opt(isStr),
        draftId: opt(isStr),
        summary: opt(isObj), // counts, durations, timers
      },
    },
  },

  // ─────────────────────────────────────────────────────────
  // CALENDAR & SYSTEM TRIGGERS (existing)
// ─────────────────────────────────────────────────────────
  "calendar.synced": {
    version: 2,
    description: "Calendar sync completed. Extended payload includes meals projection.",
    payload: {
      required: {
        scope: isIn(["plan", "week", "day", "all"]),
        triggeredBy: isStr, // "mealplan.commit","inventory.change","manual"
      },
      optional: {
        meals: opt(listOf((m) =>
          isObj(m) &&
          isStr(m.id) &&
          isObj(m.when) &&
          isStr(m.when.date) &&
          isStr(m.when.slot) &&
          (!m.recipe || (isObj(m.recipe) && isStr(m.recipe.id)))
        )),
        // Example: { id, when:{date:"2025-03-10", slot:"Dinner"}, recipe:{id,title?}, kcal?, protein_g?, carbs_g?, fat_g? }
        count: opt(isNum),
      },
    },
  },

  "preferences.changed": {
    version: 1,
    description: "User preferences updated (unit system, sabbath-aware, nutrition goals, etc.).",
    payload: {
      required: {},
      optional: {
        keys: opt(listOf(isStr)), // e.g., ["nutrition.goals","unitSystem"]
      },
    },
  },

  "inventory.updated": {
    version: 1,
    description: "Inventory levels changed; may trigger plan/grocery recompute.",
    payload: {
      required: {},
      optional: {
        items: opt(listOf((x) => isObj(x) && isStr(x.id))),
        reason: opt(isIn(["reserve", "release", "scan", "manual"])),
      },
    },
  },

  "torah.profile.updated": {
    version: 1,
    description: "Torah profile or calendar updated (affects sabbath/holiday-aware scheduling).",
    payload: {
      required: {},
      optional: {
        dateRange: opt(listOf(isStr)), // affected dates (ISO)
      },
    },
  },
};

// -------------------------------------
// Backward-compatible aliases (legacy)
// -------------------------------------
/**
 * Map old event names to new canonical names. We keep them working,
 * log a one-time console.warn to encourage migration.
 */
const ALIASES = {
  // old -> new
  "mealplan.draft.created": "mealplan.draft.generated",
  "mealplan.grocerylist.generated": "grocerylist.generated",
  "prep.tasks.generated": "prep.tasks.created",
  // historical indexing events (prefer new import/normalized/tagging triplet)
  "recipe.consolidated": "recipe.tagging.completed",
};

const warned = new Set();
function warnAlias(oldName, newName) {
  const key = `${oldName}->${newName}`;
  if (warned.has(key)) return;
  warned.add(key);
  try {
    console.warn(`[events] "${oldName}" is deprecated; use "${newName}"`);
  } catch {}
}

// -------------------------------
// Binding to the app event bus
// -------------------------------
/**
 * Create a typed event interface bound to your event bus.
 * The bus is expected to expose on(name, fn) -> off(), and emit(name, payload).
 * We keep it duck-typed so it works with your lightweight bus.
 */
export function bindEvents(eventBus) {
  if (!eventBus || typeof eventBus.on !== "function" || typeof eventBus.emit !== "function") {
    throw new Error("[events] Invalid event bus passed to bindEvents()");
  }

  const _normalizeName = (name) => {
    if (EVENTS[name]) return name;
    if (ALIASES[name]) {
      warnAlias(name, ALIASES[name]);
      return ALIASES[name];
    }
    throw new Error(`[events] Unknown event: "${name}"`);
  };

  const on = (name, handler) => {
    const real = _normalizeName(name);
    if (typeof handler !== "function") throw new Error(`[events:${real}] handler must be a function`);
    return eventBus.on(real, (payload) => {
      // No validation on listen path to avoid throwing inside consumer UI
      handler(payload || {});
    });
  };

  const once = (name, handler) => {
    const real = _normalizeName(name);
    let off = () => {};
    off = eventBus.on(real, (payload) => {
      try { handler(payload || {}); } finally { off?.(); }
    });
    return off;
  };

  const emit = (name, payload = {}) => {
    const real = _normalizeName(name);
    // Validate payload
    const spec = EVENTS[real]?.payload || { required: {}, optional: {} };
    const clean = validatePayload(spec, payload, real);
    return eventBus.emit(real, clean);
  };

  const off = (tokenOrName) => {
    // delegate—some buses return a disposer; otherwise support name-based unsub
    if (typeof tokenOrName === "function") return tokenOrName(); // disposer
    if (typeof eventBus.off === "function") return eventBus.off(tokenOrName);
  };

  return { on, once, emit, off };
}

// -----------------------------------
// Convenience: default bound instance
// -----------------------------------
let _defaultBound;
try {
  const { eventBus } = require("@/services/events/eventBus");
  _defaultBound = bindEvents(eventBus);
} catch {
  _defaultBound = {
    on: () => () => {},
    once: () => () => {},
    emit: () => {},
    off: () => {},
  };
}

/**
 * Default exports – simple wrappers over the bound instance
 * Use these in most app code for brevity:
 *
 * import { onEvent, emitEvent, EVENTS } from "@/contracts/events";
 */
export const onEvent = _defaultBound.on;
export const onceEvent = _defaultBound.once;
export const emitEvent = _defaultBound.emit;
export const offEvent = _defaultBound.off;

// -------------------------------
// Usage examples (docs only)
// -------------------------------
/*
import { emitEvent, onEvent } from "@/contracts/events";

// ── Recipe import → normalize → tag
emitEvent("recipe.import.requested", {
  requestId: "req_imp_001",
  sourceType: "url",
  url: "https://example.com/awesome-stew"
});
emitEvent("recipe.imported.normalized", {
  requestId: "req_imp_001",
  recipe: { id: "rec_awesome_stew" },
  qualityScore: 0.92
});
emitEvent("recipe.tagging.completed", {
  recipeId: "rec_awesome_stew",
  classifiers: { course: "dinner", cuisine: "west-african", effort: "easy" },
  tags: ["stew-forward","one-pot"]
});

// ── Inventory linking + shortage detect
emitEvent("inventory.linked", {
  itemId: "inv_tomato_paste",
  linkType: "recipe.ingredient",
  linkId: "ing_tomato_paste",
  source: "nba"
});
emitEvent("inventory.shortage.detected", {
  shortageId: "short_2025w43",
  items: [{ id: "inv_lamb_cubes", missingQty: 1.5 }],
  draftId: "draft_2025w43",
  triggeredBy: "mealplan"
});

// ── Decider + conflict resolution
emitEvent("decider.invoked", {
  requestId: "decide_01",
  source: "mealPlanner",
  context: { slot: { date: "2025-10-27", slot: "Dinner" } }
});
emitEvent("planner.conflict.detected", {
  conflictId: "conf_sabbath_01",
  kind: "sabbath",
  draftId: "draft_2025w43",
  details: { window: { start: "2025-10-31T17:45:00-05:00", end: "2025-11-01T18:45:00-05:00" } }
});
emitEvent("decider.resolution.requested", {
  conflictId: "conf_sabbath_01",
  requestId: "decide_fix_01",
  strategies: ["no-cook","swap-slot"]
});

// ── Meal plan lifecycle
emitEvent("mealplan.draft.requested", {
  requestId: "req_plan_001",
  templateId: "tpl_7day_dinners_v1",
  days: 7,
  startDate: "2025-10-27",
  source: "user"
});
emitEvent("mealplan.draft.generated", {
  requestId: "req_plan_001",
  draft: { id: "draft_7d_001" }
});
emitEvent("mealplan.applied", { draftId: "draft_7d_001", templateId: "tpl_7day_dinners_v1" });
emitEvent("mealplan.updated", { draft: { id: "draft_7d_001" }, cause: "swap" });
emitEvent("mealplan.undo", { draftId: "draft_7d_001", op: "swap" });

// ── Grocery list lifecycle
emitEvent("grocerylist.requested", {
  requestId: "req_gl_01",
  draftId: "draft_7d_001",
  options: { collapseDuplicates: true }
});
emitEvent("grocerylist.generated", {
  requestId: "req_gl_01",
  draftId: "draft_7d_001",
  list: { id: "gl_7d_001" },
  lines: 42
});

// ── Prep tasks
emitEvent("prep.tasks.requested", {
  requestId: "req_prep_01",
  draftId: "draft_7d_001",
  source: "mealPlanner"
});
emitEvent("prep.tasks.created", {
  requestId: "req_prep_01",
  tasks: [{ id: "tsk_chop_veg" }, { id: "tsk_marinade" }],
  summary: { count: 2, timers: 1 }
});

// ── Calendar & system
emitEvent("calendar.synced", {
  scope: "plan",
  triggeredBy: "mealplan.commit",
  meals: [
    { id: "m1", when: { date: "2025-10-27", slot: "Dinner" }, recipe: { id: "rec_awesome_stew" } }
  ],
  count: 1
});
emitEvent("preferences.changed", { keys: ["nutrition.goals"] });
emitEvent("inventory.updated", { reason: "reserve", items: [{ id: "rice_brown" }] });
emitEvent("torah.profile.updated", { dateRange: ["2025-10-31","2025-11-01"] });

// ── Legacy alias (warns once, then routes to canonical)
emitEvent("mealplan.grocerylist.generated", {
  requestId: "req_gl_legacy",
  draftId: "draft_7d_001",
  list: { id: "gl_legacy" },
  lines: 12
});
*/

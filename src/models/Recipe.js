// src/models/Recipe.js

/**
 * Recipe
 * -----------------------------------------------------------------------------
 * Agent-friendly recipe model with:
 *  - Smart ingredient parsing (quantity/unit detection) + consolidation keys
 *  - Servings scaling (xN or to target servings)
 *  - Macro & kcal rollups (per recipe & per serving)
 *  - Sabbath/Feast suitability flags (Torah-compliant screening)
 *  - Prep graph (dependsOn), multitimer events, station hints for Batch cooking
 *  - Inventory linkage: normalized keys for pantry reservation
 *  - Storage & reheat metadata for freezer-friendly flows
 *  - Clean validate(), toJSON(), and from()
 *
 * Ingredient shape (normalized):
 *   { id, name, qty, unit, note?, section?, key }  // key = normalize(name|unit)
 *
 * Prep step shape:
 *   { id, label, minutes, dependsOn?: string[], station?: string,
 *     timer?: { name, minutes, autoStart?: boolean }, notes?: string }
 */

const DEFAULT_SKILLS = ["cooking", "batching", "sanitation"];
const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const uid = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const toDate = (x) => {
  if (!x) return null;
  const d = x instanceof Date ? x : new Date(x);
  return isNaN(d.getTime()) ? null : d;
};

const kcalFromMinutes = (min) => Math.round((min || 0) * 4.5);

const UNITS = [
  "tsp","teaspoon","teaspoons",
  "tbsp","tablespoon","tablespoons",
  "cup","cups",
  "oz","ounce","ounces",
  "lb","pound","pounds",
  "g","gram","grams",
  "kg","kilogram","kilograms",
  "ml","milliliter","milliliters",
  "l","liter","liters",
  "pinch","clove","cloves","slice","slices","can","cans","package","packages"
];

const UNIT_ALIASES = {
  teaspoon: "tsp", teaspoons: "tsp",
  tbsp: "tbsp", tablespoon: "tbsp", tablespoons: "tbsp",
  ounce: "oz", ounces: "oz",
  pound: "lb", pounds: "lb",
  gram: "g", grams: "g",
  kilogram: "kg", kilograms: "kg",
  milliliter: "ml", milliliters: "ml",
  liter: "l", liters: "l"
};

function normUnit(u) {
  if (!u) return "";
  const s = String(u).toLowerCase().trim();
  if (UNIT_ALIASES[s]) return UNIT_ALIASES[s];
  return s;
}

function ingKey(name, unit = "") {
  return `${String(name || "").trim().toLowerCase()}|${normUnit(unit)}`;
}

function parseQty(q) {
  // supports "1", "1.5", "1/2", "1 1/2"
  if (!q) return 0;
  const s = String(q).trim();
  // "1 1/2"
  const mMix = s.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mMix) {
    return Number(mMix[1]) + Number(mMix[2]) / Number(mMix[3] || 1);
  }
  // fraction "3/4"
  const mFrac = s.match(/^(\d+)\/(\d+)$/);
  if (mFrac) return Number(mFrac[1]) / Number(mFrac[2] || 1);
  // decimal/integer
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function parseIngredientLine(line) {
  // Attempts to parse lines like:
  // "1 1/2 cups almond flour (blanched)"
  // "2 tbsp olive oil"
  // "Salt and pepper to taste"
  if (!line || typeof line !== "string") {
    return { name: "", qty: 0, unit: "", note: "" };
  }
  const raw = line.trim();
  const parts = raw.split(/\s+/);

  // Gather qty tokens at start
  let qtyTokens = [];
  while (parts.length && (/^\d+$/.test(parts[0]) || /^\d+\/\d+$/.test(parts[0]) || /^\d+\.\d+$/.test(parts[0]))) {
    qtyTokens.push(parts.shift());
  }
  if (parts.length >= 2 && /^\d+\/\d+$/.test(parts[0])) {
    qtyTokens.push(parts.shift());
  }
  const qty = parseQty(qtyTokens.join(" "));

  // Unit (if any) next
  let unit = "";
  if (parts.length) {
    const maybeUnit = parts[0].toLowerCase();
    if (UNITS.includes(maybeUnit)) {
      unit = normUnit(parts.shift());
    }
  }

  // Remaining join is name + optional note "(...)"
  const rest = parts.join(" ");
  let name = rest;
  let note = "";
  const noteMatch = rest.match(/\(([^)]+)\)/);
  if (noteMatch) {
    note = noteMatch[1];
    name = rest.replace(/\([^)]+\)/, "").trim();
  }

  // remove "to taste" from name -> note
  if (/to taste/i.test(name)) {
    name = name.replace(/to taste/ig, "").trim();
    note = note ? `${note}; to taste` : "to taste";
  }

  return {
    name: name.trim(),
    qty: qty || 0,
    unit,
    note
  };
}

function estimateMinutesFromText(line) {
  if (!line) return 3;
  const s = line.toLowerCase();

  // explicit "for 20 minutes" style
  const m = s.match(/(\d+)\s*(minutes|min|hrs|hours)/);
  if (m) {
    const n = Number(m[1]);
    if (/hrs|hours/.test(m[2])) return n * 60;
    return n;
  }

  if (/bake|roast|simmer|boil|slow cook|pressure cook/.test(s)) return 20;
  if (/marinate|proof|rest/.test(s)) return 30;
  if (/knead/.test(s)) return 10;
  if (/chop|mix|whisk|dice|prep|blend|season/.test(s)) return 5;
  if (/open|pour|plate|serve/.test(s)) return 2;
  return 3;
}

function topoSort(steps) {
  const map = new Map();
  steps.forEach(s => map.set(s.id, { ...s, deps: new Set(s.dependsOn || []) }));
  const out = [];
  const ready = [];
  for (const [id, node] of map) if (node.deps.size === 0) ready.push(id);

  while (ready.length) {
    const id = ready.shift();
    const node = map.get(id);
    if (!node) continue;
    out.push(node);
    map.delete(id);
    for (const [k, n] of map) {
      if (n.deps.has(id)) {
        n.deps.delete(id);
        if (n.deps.size === 0) ready.push(k);
      }
    }
  }
  for (const [, n] of map) out.push(n);
  return out;
}

function emptyMacros() {
  return { kcal: 0, protein: 0, fat: 0, carbs: 0, fiber: 0 };
}
function sumMacros(a, b) {
  return {
    kcal: (a.kcal || 0) + (b.kcal || 0),
    protein: (a.protein || 0) + (b.protein || 0),
    fat: (a.fat || 0) + (b.fat || 0),
    carbs: (a.carbs || 0) + (b.carbs || 0),
    fiber: (a.fiber || 0) + (b.fiber || 0),
  };
}

/**
 * Torah-diet quick screen (non-exhaustive, string-based).
 * You can swap this for your Paleo Functional Archive dietary engine later.
 */
const FORBIDDEN = [
  "pork","ham","bacon","pepperoni","prosciutto",
  "shellfish","shrimp","lobster","crab","clam","oyster","scallop",
  "catfish","eel"
];
function torahCompliantFromIngredients(ingredients = []) {
  const s = (ingredients || []).map(i => (i.name || "").toLowerCase()).join(" ");
  return !FORBIDDEN.some(w => s.includes(w));
}

class Recipe {
  constructor({
    id,
    name,
    createdBy = null,
    description = "",
    tags = [],                            // e.g., ["sabbath","feast","easy","freezer-friendly","keto"]
    servings = 4,                         // default servings
    yieldUnits = "servings",              // "servings" | "loaves" | etc.

    // ingredients: can be lines (strings) or normalized objects
    ingredients = [],                     // string[] | { name, qty, unit, note?, section? }[]
    instructions = [],                    // array of string steps (kept for display)
    prepSteps = [],                       // structured prep graph (see header)
    supplies = [],                        // inventory items (ids/names)
    tools = [],                           // tool ids/names
    audioUrl = "",                        // optional audio walkthrough
    images = [],                          // optional image urls
    videoUrl = "",                        // optional video walkthrough

    isFeastApproved = false,
    sabbathFriendly = false,              // no active cooking? (cold/held/reheat only)
    freezerFriendly = false,

    allergens = [],                       // ["dairy","gluten","nuts","soy","eggs","fish","shellfish"]
    dietary = [],                         // ["keto","low-carb","paleo","dairy-free","gluten-free"]
    storage = {                           // storage instructions
      fridgeDays: 3, freezerMonths: 3, reheat: "Oven 350°F 15–20 min", notes: ""
    },

    // Nutrition (per-recipe totals and per-serving derived)
    macros = null,                        // { kcal, protein, fat, carbs, fiber } per recipe
    macrosPerServing = null,

    notes = "",

    createdAt = new Date(),
    updatedAt = new Date(),
    archived = false,
  } = {}) {
    this.id = id || `recipe-${uid()}`;
    this.name = name;
    this.createdBy = createdBy;
    this.description = description;
    this.tags = Array.isArray(tags) ? tags : [];

    this.servings = Math.max(1, Number(servings || 1));
    this.yieldUnits = yieldUnits || "servings";

    // Normalize ingredients
    this.ingredients = Array.isArray(ingredients)
      ? ingredients.map((it) => this._normalizeIngredient(it))
      : [];
    this.instructions = Array.isArray(instructions) ? instructions : [];

    this.prepSteps = Array.isArray(prepSteps) ? prepSteps.map((s) => this._normalizeStep(s)) : [];
    this.supplies = Array.isArray(supplies) ? supplies : [];
    this.tools = Array.isArray(tools) ? tools : [];
    this.audioUrl = audioUrl || "";
    this.images = Array.isArray(images) ? images : [];
    this.videoUrl = videoUrl || "";

    this.isFeastApproved = !!isFeastApproved;
    this.sabbathFriendly = !!sabbathFriendly;
    this.freezerFriendly = !!freezerFriendly;

    this.allergens = Array.isArray(allergens) ? allergens : [];
    this.dietary = Array.isArray(dietary) ? dietary : [];
    this.storage = storage || { fridgeDays: 3, freezerMonths: 3, reheat: "", notes: "" };

    this.macros = macros || emptyMacros();
    this.macrosPerServing = macrosPerServing || null;

    this.notes = notes || "";
    this.createdAt = toDate(createdAt) || new Date();
    this.updatedAt = toDate(updatedAt) || new Date();
    this.archived = !!archived;

    // Auto-tag Torah compliant if passing quick screen and not explicitly tagged otherwise
    if (torahCompliantFromIngredients(this.ingredients) && !this.tags.includes("torah-compliant")) {
      this.tags.push("torah-compliant");
    }
  }

  /* ------------------------------ Normalizers ------------------------------ */

  _normalizeIngredient(row) {
    if (typeof row === "string") {
      const p = parseIngredientLine(row);
      return {
        id: uid(),
        name: p.name,
        qty: p.qty,
        unit: p.unit,
        note: p.note || "",
        section: null,
        key: ingKey(p.name, p.unit),
      };
    }
    const name = row.name || "";
    const qty = row.qty != null ? Number(row.qty) : parseQty(row.quantity);
    const unit = normUnit(row.unit || row.uom || "");
    return {
      id: row.id || uid(),
      name: name,
      qty: Number.isFinite(qty) ? qty : 0,
      unit,
      note: row.note || "",
      section: row.section || null,
      key: row.key || ingKey(name, unit),
    };
  }

  _normalizeStep(s) {
    const id = s.id || `step-${uid()}`;
    const minutes = Math.max(1, Number(s.minutes || estimateMinutesFromText(s.label || s)));
    return {
      id,
      label: s.label || (typeof s === "string" ? s : "Step"),
      minutes,
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
      station: s.station || null,
      timer: s.timer
        ? {
            name: s.timer.name || s.label || "Timer",
            minutes: Math.max(1, Number(s.timer.minutes || minutes)),
            autoStart: !!s.timer.autoStart,
          }
        : undefined,
      notes: s.notes || ""
    };
  }

  /* -------------------------------- Mutations -------------------------------- */

  addIngredient(input) {
    const ing = this._normalizeIngredient(input);
    this.ingredients.push(ing);
    this.updatedAt = new Date();
  }

  removeIngredient(idOrName) {
    this.ingredients = this.ingredients.filter(
      (i) => i.id !== idOrName && i.name !== idOrName
    );
    this.updatedAt = new Date();
  }

  addInstruction(step) {
    if (typeof step === "string" && step.trim()) {
      this.instructions.push(step.trim());
      // Also seed a prep step estimate for multitimer UI
      this.prepSteps.push(this._normalizeStep({ label: step.trim() }));
      this.updatedAt = new Date();
    }
  }

  addPrepStep(step) {
    this.prepSteps.push(this._normalizeStep(step));
    this.updatedAt = new Date();
  }

  linkTool(toolId) {
    if (!this.tools.includes(toolId)) {
      this.tools.push(toolId);
      this.updatedAt = new Date();
    }
  }

  linkSupply(supplyNameOrId) {
    if (!this.supplies.includes(supplyNameOrId)) {
      this.supplies.push(supplyNameOrId);
      this.updatedAt = new Date();
    }
  }

  tag(label) {
    const l = String(label || "").trim();
    if (l && !this.tags.includes(l)) {
      this.tags.push(l);
      this.updatedAt = new Date();
    }
  }

  untag(label) {
    this.tags = this.tags.filter((t) => t !== label);
    this.updatedAt = new Date();
  }

  markAsFeastApproved() {
    this.isFeastApproved = true;
    if (!this.tags.includes("feast-approved")) this.tags.push("feast-approved");
    this.updatedAt = new Date();
  }

  setSabbathFriendly(val = true) {
    this.sabbathFriendly = !!val;
    if (val && !this.tags.includes("sabbath-friendly")) this.tags.push("sabbath-friendly");
    this.updatedAt = new Date();
  }

  archive() {
    this.archived = true;
    this.updatedAt = new Date();
  }

  /* --------------------------------- Logic ---------------------------------- */

  /**
   * Scale ingredient quantities by factor (e.g., 2x) or to a target serving count.
   * If `targetServings` is provided, `factor` is derived from (target / current).
   */
  scaleServings({ factor = null, targetServings = null } = {}) {
    const f = targetServings
      ? Math.max(0.01, Number(targetServings) / Math.max(1, this.servings))
      : Math.max(0.01, Number(factor || 1));
    this.ingredients = this.ingredients.map((i) => ({
      ...i,
      qty: Math.round((i.qty || 0) * f * 100) / 100
    }));
    this.servings = targetServings ? Math.max(1, Math.round(targetServings)) : this.servings;
    // scale macros if present
    if (this.macros && !this._macrosAreZero(this.macros)) {
      this.macros = {
        kcal: Math.round((this.macros.kcal || 0) * f),
        protein: Math.round((this.macros.protein || 0) * f),
        fat: Math.round((this.macros.fat || 0) * f),
        carbs: Math.round((this.macros.carbs || 0) * f),
        fiber: Math.round((this.macros.fiber || 0) * f),
      };
    }
    this._derivePerServingMacros();
    this.updatedAt = new Date();
  }

  _macrosAreZero(m) {
    return !m || Object.values(m).every((v) => !v || v === 0);
  }

  /**
   * Compute/refresh macros from a nutrition DB.
   * nutritionDB: Map or object keyed by normalized ingredient name -> per-unit macros for given unit
   *   Example entry: { unit:"g", per:100, kcal:350, protein:12, fat:2, carbs:70, fiber:10 }
   *   We convert qty/unit to the DB unit via simple heuristics (extend later).
   */
  computeMacros(nutritionDB = {}) {
    let total = emptyMacros();

    for (const ing of this.ingredients) {
      const keyBase = String(ing.name || "").trim().toLowerCase();
      const entry = nutritionDB[keyBase];
      if (!entry) continue;

      // crude conversions (extend as needed)
      let qtyInDbUnit = ing.qty || 0;
      if (entry.unit && entry.per) {
        // If entry is per 100 g and ing is "cups", we’d need density; assume 1 cup ~ 240 g fallback.
        if (entry.unit === "g") {
          if (ing.unit === "cup") qtyInDbUnit = (ing.qty || 0) * 240;
          else if (ing.unit === "tbsp") qtyInDbUnit = (ing.qty || 0) * 15;
          else if (ing.unit === "tsp") qtyInDbUnit = (ing.qty || 0) * 5;
          else if (ing.unit === "oz") qtyInDbUnit = (ing.qty || 0) * 28.35;
          else if (ing.unit === "lb") qtyInDbUnit = (ing.qty || 0) * 453.59;
          else qtyInDbUnit = (ing.qty || 0); // already grams or unknown (assume gram)
        }
        const factor = qtyInDbUnit / entry.per;
        total = sumMacros(total, {
          kcal: factor * (entry.kcal || 0),
          protein: factor * (entry.protein || 0),
          fat: factor * (entry.fat || 0),
          carbs: factor * (entry.carbs || 0),
          fiber: factor * (entry.fiber || 0),
        });
      }
    }

    // Round
    Object.keys(total).forEach((k) => (total[k] = Math.round(total[k])));

    this.macros = total;
    this._derivePerServingMacros();
    this.updatedAt = new Date();
    return { total, perServing: this.macrosPerServing };
  }

  _derivePerServingMacros() {
    const s = Math.max(1, this.servings || 1);
    const m = this.macros || emptyMacros();
    this.macrosPerServing = {
      kcal: Math.round((m.kcal || 0) / s),
      protein: Math.round((m.protein || 0) / s),
      fat: Math.round((m.fat || 0) / s),
      carbs: Math.round((m.carbs || 0) / s),
      fiber: Math.round((m.fiber || 0) / s),
    };
    return this.macrosPerServing;
  }

  /** Group and sum ingredients by key (for Inventory reservations & grocery lists) */
  consolidatedIngredients() {
    const map = new Map();
    for (const i of this.ingredients) {
      const k = i.key || ingKey(i.name, i.unit);
      if (!map.has(k)) {
        map.set(k, { key: k, name: i.name, unit: i.unit, qty: 0, items: [] });
      }
      const row = map.get(k);
      row.qty += Number(i.qty || 0);
      row.items.push(i);
    }
    const out = Array.from(map.values());
    out.forEach((r) => (r.qty = Math.round(r.qty * 100) / 100));
    return out;
  }

  /** Build a topologically-sorted prep list + a flat list of multitimer events */
  buildPrepGraph() {
    const steps = this.prepSteps.map((s) => this._normalizeStep(s));
    const sorted = topoSort(steps);
    const timers = sorted
      .filter((s) => s.timer)
      .map((s) => ({
        id: `tmr-${s.id}`,
        name: s.timer.name || s.label,
        minutes: s.timer.minutes,
        autoStart: !!s.timer.autoStart
      }));
    const totalMinutes = sorted.reduce((acc, s) => acc + (s.minutes || 0), 0);
    return {
      steps: sorted,
      timers,
      effort: { minutes: totalMinutes, kcal: kcalFromMinutes(totalMinutes) }
    };
  }

  /** Return a compact “assignment” payload for WorkerTasks (role=cook) */
  toWorkerTaskPayload({ when = null } = {}) {
    const graph = this.buildPrepGraph();
    const label = `Cook: ${this.name}`;
    return {
      taskId: this.id,
      task: {
        id: this.id,
        name: label,
        task: `${label} (${this.servings} ${this.yieldUnits})`,
        source: "cooking",
        requiredSkills: DEFAULT_SKILLS,
        effort: graph.effort,
        priorityScore: 60,
        dueHint: when || null,
        metadata: {
          tools: this.tools,
          supplies: this.supplies,
          sabbathFriendly: this.sabbathFriendly,
          feastApproved: this.isFeastApproved
        }
      },
      role: "cook",
      due: when || null
    };
  }

  /** High-level suitability report for Feast/Sabbath planning UIs */
  feastSuitability() {
    return {
      torahCompliant: torahCompliantFromIngredients(this.ingredients),
      sabbathFriendly: !!this.sabbathFriendly,
      feastApproved: !!this.isFeastApproved,
      freezerFriendly: !!this.freezerFriendly
    };
  }

  /** Parse plain-text instructions to step objects with time estimates */
  parseInstructions() {
    if (!Array.isArray(this.instructions)) return [];
    return this.instructions
      .filter((line) => typeof line === "string" && line.trim() !== "")
      .map((line, idx) => ({
        step: idx + 1,
        description: line.trim(),
        estimatedTime: estimateMinutesFromText(line),
      }));
  }

  /* -------------------------------- Validation -------------------------------- */

  validate() {
    const errors = [];

    if (!this.name || String(this.name).trim() === "") {
      errors.push("Recipe must have a name.");
    }

    if (!Array.isArray(this.ingredients) || this.ingredients.length === 0) {
      errors.push("At least one ingredient is required.");
    } else {
      this.ingredients.forEach((i, idx) => {
        if (!i.name || String(i.name).trim() === "") {
          errors.push(`Ingredient #${idx + 1} is missing a name.`);
        }
        if (i.qty == null || isNaN(Number(i.qty))) {
          errors.push(`Ingredient #${idx + 1} has invalid quantity.`);
        }
      });
    }

    if (!Array.isArray(this.instructions) || this.instructions.length === 0) {
      // allow instruction-less recipes if prepSteps exist
      if (!Array.isArray(this.prepSteps) || this.prepSteps.length === 0) {
        errors.push("Instructions or prep steps are required.");
      }
    }

    // Torah screen (soft warning)
    if (!torahCompliantFromIngredients(this.ingredients)) {
      if (!this.tags.includes("non-torah")) this.tags.push("non-torah");
    }

    return errors;
  }

  /* ----------------------------- Serialization ----------------------------- */

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      createdBy: this.createdBy,
      description: this.description,
      tags: this.tags,
      servings: this.servings,
      yieldUnits: this.yieldUnits,

      ingredients: this.ingredients,
      instructions: this.instructions,
      prepSteps: this.prepSteps,
      supplies: this.supplies,
      tools: this.tools,
      audioUrl: this.audioUrl,
      images: this.images,
      videoUrl: this.videoUrl,

      isFeastApproved: this.isFeastApproved,
      sabbathFriendly: this.sabbathFriendly,
      freezerFriendly: this.freezerFriendly,

      allergens: this.allergens,
      dietary: this.dietary,
      storage: this.storage,

      macros: this.macros,
      macrosPerServing: this.macrosPerServing,

      notes: this.notes,
      createdAt: this.createdAt ? new Date(this.createdAt).toISOString() : null,
      updatedAt: this.updatedAt ? new Date(this.updatedAt).toISOString() : null,
      archived: this.archived
    };
  }

  static from(obj = {}) {
    return new Recipe({
      ...obj,
      createdAt: obj.createdAt ? new Date(obj.createdAt) : new Date(),
      updatedAt: obj.updatedAt ? new Date(obj.updatedAt) : new Date(),
      // Ensure normalization runs:
      ingredients: Array.isArray(obj.ingredients) ? obj.ingredients : [],
      prepSteps: Array.isArray(obj.prepSteps) ? obj.prepSteps : [],
      instructions: Array.isArray(obj.instructions) ? obj.instructions : []
    });
  }
}

export default Recipe;

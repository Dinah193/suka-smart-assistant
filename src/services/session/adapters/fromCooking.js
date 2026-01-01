// C:\Users\larho\suka-smart-assistant\src\services\session\adapters\fromCooking.js
// Cooking → Scheduler Adapter
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ this adapter converts COOKING domain
//            │             │               objects (recipes/mealplan items) into a
//            │             │               scheduler-friendly session draft.
//            │             └─ domain intelligence (ingredients, equipment, timing)
//            └─ imports from recipe sites / meal planners
//
// What this module does
// ---------------------
// • Provides a pure function `mapCookingToSession(input)` that normalizes a
//   cooking job into a scheduler-ready draft.
// • Wires event handlers to:
//     - respond("adapter/cooking/map") → returns mapped draft
//     - on("cooking/requestSession")   → maps and emits "cooking/draftReady"
// • Emits canonical events via eventBus; upstream bus ensures payload shape:
//     { type, ts, source, data } with ISO timestamps
// • If a session draft is produced (household data), mirrors to Hub when
//   featureFlags.familyFundMode=true (fail-silent).
//
// Notes
// -----
// • Forward-compatible: flexible schema with `meta` for future domains
//   (preservation, animals, storehouse).
// • Defensive: validates input, returns early on errors.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb.default || eb.eventBus || eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/eventBus.js");
    eventBus = eb.default || eb.eventBus || eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {}, on: () => () => {}, respond: () => () => {} };
    Events = {};
  }
}

let featureFlags = {};
try {
  featureFlags = require("@/config/featureFlags").default || require("@/config/featureFlags");
} catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/Famil yFundConnector");
} catch {
  // optional
}

/* ---------------------------------- API ------------------------------------ */
/**
 * Initialize adapter: sets up eventBus glue and RPC responder.
 */
export function initCookingAdapter() {
  // RPC: map cooking → session draft
  if (eventBus?.respond) {
    eventBus.respond("adapter/cooking/map", async (payload) => {
      try {
        const draft = mapCookingToSession(payload);
        return { ok: true, draft };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // Main glue: when cooking engines request a session, map and emit draft
  eventBus.on(Events?.COOKING_REQUEST_SESSION || "cooking/requestSession", ({ data }) => {
    try {
      const draft = mapCookingToSession(data);
      emit(Events?.COOKING_DRAFT_READY || "cooking/draftReady", { draft });
      // optional hub mirror (creating a draft is a household data change)
      exportToHubIfEnabled({
        type: "cooking/draftReady",
        ts: new Date().toISOString(),
        source: "adapter.cooking",
        data: { draft },
      });
    } catch (e) {
      emit(Events?.SESSION_ERROR || "session/error", {
        domain: "cooking",
        error: String(e?.message || e),
        input: safeSmall(data),
      });
    }
  }, { priority: 1 });
}

/**
 * Pure adapter: Map a COOKING source object → scheduler session draft.
 * Accepts flexible input shapes from recipe/import/mealplan.
 *
 * @param {object} input
 * @returns {SchedulerDraft}
 */
export function mapCookingToSession(input = {}) {
  // 1) Normalize source
  const src = normalizeCookingInput(input);

  // 2) Build derived fields
  const durationMin = deriveDurationMin(src);
  const window = deriveWindow(src, durationMin);
  const equipment = deriveEquipment(src);
  const ingredients = deriveIngredients(src);
  const rolesNeeded = deriveRoles(src);
  const steps = deriveSteps(src);
  const outdoor = inferOutdoor(equipment);

  // 3) Compose draft
  /** @type {SchedulerDraft} */
  const draft = {
    id: src.sessionId || genId(),
    domain: "cooking",
    title: src.title || buildTitle(src),
    location: "kitchen",
    outdoor,
    durationMin,
    flexibilityMin: src.flexibilityMin ?? 30,
    window, // { startISO?, endISO? } possibly undefined; scheduler can fill
    equipment, // [{ deviceId?, kind, title }]
    ingredients, // [{ id|sku|name, qty, unit }]
    rolesNeeded, // e.g., [{ role:"cook", count:1 }]
    steps,
    meta: {
      recipeId: src.recipeId,
      mealId: src.mealId,
      servings: src.servings,
      allergens: src.allergens,
      sourceUrl: src.sourceUrl,
      tags: src.tags,
      nutrition: src.nutrition,
      priority: src.priority,
      planContext: pick(src, ["planDate", "slot", "dayPart"]),
      // Hints for other services:
      weatherSensitive: outdoor,
      pantryPreferred: true,
    },
  };

  // 4) Minimal validation
  if (!Array.isArray(draft.ingredients)) draft.ingredients = [];
  if (draft.durationMin <= 0) throw new Error("Invalid duration for cooking draft");

  return draft;
}

/* ---------------------------- Types (JSDoc only) --------------------------- */
/**
 * @typedef {Object} SchedulerDraft
 * @property {string} id
 * @property {"cooking"} domain
 * @property {string} title
 * @property {string} [location]
 * @property {boolean} [outdoor]
 * @property {number} durationMin
 * @property {number} [flexibilityMin]
 * @property {{startISO?:string,endISO?:string}} [window]
 * @property {Array<{deviceId?:string, kind?:string, title?:string}>} [equipment]
 * @property {Array<{id?:string, sku?:string, name?:string, qty?:number, unit?:string}>} [ingredients]
 * @property {Array<{role:string, count?:number}>} [rolesNeeded]
 * @property {Array<{idx:number, label:string, estMin?:number}>} [steps]
 * @property {Object} meta
 */

/* ------------------------------ Derivers ----------------------------------- */
function normalizeCookingInput(x = {}) {
  // Accept multiple shapes:
  // - { recipe, mealplan, time, meta }
  // - direct fields (title, steps, equipment, ingredients, etc.)
  const r = x.recipe || x;
  const meal = x.meal || x.mealplan || {};
  const time = x.time || {};
  const meta = x.meta || r.meta || {};

  return {
    recipeId: String(r.id || meta.recipeId || ""),
    mealId: String(meal.id || meta.mealId || ""),
    sessionId: String(meta.sessionId || r.sessionId || ""),
    title: String(r.title || meal.title || meta.title || "Cooking Session"),
    sourceUrl: r.url || r.sourceUrl || meta.sourceUrl,
    servings: num(r.servings ?? meta.servings ?? meal.servings ?? 0) || undefined,
    tags: arr(r.tags || meta.tags),
    nutrition: isPojo(r.nutrition) ? r.nutrition : undefined,
    allergens: arr(meta.allergens || r.allergens),
    // timing
    prepMin: minutesFrom(r.prepTime || meta.prepTime),
    cookMin: minutesFrom(r.cookTime || meta.cookTime),
    restMin: minutesFrom(r.restTime || meta.restTime),
    totalMin: minutesFrom(r.totalTime || meta.totalTime),
    // plan window
    start: firstISO(time.start, meta.start, meal.start),
    end: firstISO(time.end, meta.end, meal.end),
    planDate: firstISO(meal.planDate, meta.planDate),
    dayPart: meal.dayPart || meta.dayPart, // breakfast/lunch/dinner
    slot: meal.slot || meta.slot,          // A/B/C etc.
    priority: rankPriority(meta.priority || meal.priority),
    flexibilityMin: num(meta.flexibilityMin),
    // domain payloads
    ingredients: arr(r.ingredients || meta.ingredients),
    steps: arr(r.steps || meta.steps),
    equipment: arr(r.equipment || meta.equipment),
    methods: arr(r.methods || meta.methods),
  };
}

function deriveDurationMin(src) {
  if (num(src.totalMin)) return clamp(num(src.totalMin), 5, 12 * 60);
  const parts = [src.prepMin, src.cookMin, src.restMin].map(num).filter(Boolean);
  if (!parts.length) return 45; // default single-dish
  return clamp(parts.reduce((a, b) => a + b, 0), 5, 12 * 60);
}

function deriveWindow(src, durationMin) {
  const s = isISO(src.start) ? src.start : null;
  const e = isISO(src.end) ? src.end : (s ? new Date(Date.parse(s) + durationMin * 60000).toISOString() : null);
  if (!s && !e) return undefined;
  return { startISO: s || undefined, endISO: e || undefined };
}

function deriveEquipment(src) {
  // Normalize to { deviceId?, kind?, title? }
  const out = [];
  for (const eq of src.equipment || []) {
    out.push({
      deviceId: eq?.deviceId ? String(eq.deviceId) : undefined,
      kind: eq?.kind ? String(eq.kind) : guessKindFrom(eq?.name || eq?.title),
      title: eq?.title || eq?.name || undefined,
    });
  }
  // Methods imply equipment (grill, smoker, oven, stovetop, sous-vide)
  for (const m of src.methods || []) {
    const kind = methodToKind(String(m));
    if (kind && !out.some(o => o.kind === kind)) out.push({ kind, title: labelForKind(kind) });
  }
  return out;
}

function deriveIngredients(src) {
  const out = [];
  for (const ing of src.ingredients || []) {
    const id = String(ing?.id || ing?.sku || ing?.name || "");
    const name = String(ing?.name || "");
    const sku = ing?.sku ? String(ing?.sku) : undefined;
    const qty = num(ing?.qty || ing?.quantity);
    const unit = String(ing?.unit || ing?.uom || "");
    if (!id && !name) continue;
    out.push({ id: id || undefined, sku, name: name || undefined, qty: qty || undefined, unit: unit || undefined });
  }
  return out;
}

function deriveRoles(src) {
  // Single primary cook; expand in future for helpers / butcher / baker
  const base = [{ role: "cook", count: 1 }];
  // If grilling/smoker or heavy-lift methods present, suggest helper
  const methods = (src.methods || []).map((m) => String(m).toLowerCase());
  const needsHelper = methods.some((m) => /smoke|grill|whole|butcher|pressure canner/.test(m));
  if (needsHelper) base.push({ role: "helper", count: 1 });
  return base;
}

function deriveSteps(src) {
  const arrSteps = Array.isArray(src.steps) && src.steps.length
    ? src.steps
    : guessStepsFromMethods(src);
  return arrSteps.map((s, i) => ({
    idx: i + 1,
    label: String(s?.label || s?.text || s || `Step ${i + 1}`),
    estMin: num(s?.estMin),
  }));
}

function inferOutdoor(equipment) {
  const kinds = new Set((equipment || []).map((e) => (e.kind || "").toLowerCase()));
  return ["grill", "smoker", "firepit"].some((k) => kinds.has(k));
}

/* ------------------------------- Helpers ----------------------------------- */
function methodToKind(m) {
  const s = m.toLowerCase();
  if (s.includes("grill")) return "grill";
  if (s.includes("smok")) return "smoker";
  if (s.includes("sous")) return "sous-vide";
  if (s.includes("bake") || s.includes("roast")) return "oven";
  if (s.includes("stir") || s.includes("saute") || s.includes("sauté") || s.includes("boil")) return "stovetop";
  if (s.includes("pressure canner")) return "pressure-canner";
  return null;
}
function labelForKind(k) {
  const map = {
    grill: "Grill",
    smoker: "Smoker",
    oven: "Oven",
    "sous-vide": "Sous-vide",
    stovetop: "Stovetop",
    "pressure-canner": "Pressure Canner",
  };
  return map[k] || k;
}
function guessKindFrom(name) {
  const s = String(name || "").toLowerCase();
  if (/smok/.test(s)) return "smoker";
  if (/grill/.test(s)) return "grill";
  if (/oven/.test(s)) return "oven";
  if (/stove|burner|rangetop/.test(s)) return "stovetop";
  if (/sous/.test(s)) return "sous-vide";
  if (/pressure canner|canner/.test(s)) return "pressure-canner";
  return undefined;
}
function guessStepsFromMethods(src) {
  const m = (src.methods || []).map((x) => String(x).toLowerCase()).join(" ");
  const steps = [];
  if (/marinat/.test(m)) steps.push({ label: "Marinate ingredients", estMin: 30 });
  if (/chop|dice|slice/.test(m)) steps.push({ label: "Prep and chop produce", estMin: 15 });
  if (/preheat|bake|roast|grill|smok/.test(m)) steps.push({ label: "Preheat equipment", estMin: 10 });
  steps.push({ label: "Cook dish", estMin: Math.max(15, num(src.cookMin) || 30) });
  if (/rest|cool/.test(m)) steps.push({ label: "Rest / cool", estMin: num(src.restMin) || 5 });
  return steps.length ? steps : [{ label: "Prepare and cook", estMin: num(src.totalMin) || 45 }];
}
function buildTitle(src) {
  const base = src.title || "Cooking Session";
  const servings = src.servings ? ` • ${src.servings} servings` : "";
  return `${base}${servings}`;
}

/* ------------------------------ eventBus I/O -------------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "adapter.cooking" });
}

/* -------------------------- Hub (optional mirror) -------------------------- */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const pkt = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(pkt);
  } catch { /* fail-silent */ }
}

/* --------------------------------- Utils ----------------------------------- */
function num(n) { return Number.isFinite(n) ? n : Number.isFinite(+n) ? +n : undefined; }
function minutesFrom(v) {
  if (!v && v !== 0) return undefined;
  if (Number.isFinite(v)) return v;
  const s = String(v).trim().toLowerCase();
  // Support ISO 8601 duration (PT1H30M), "1h 30m", "90", "45m"
  const iso = /^p(t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?)$/i.exec(s);
  if (iso) {
    const h = +(iso[2] || 0), m = +(iso[3] || 0), sec = +(iso[4] || 0);
    return h * 60 + m + Math.round(sec / 60);
  }
  const hm = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/.exec(s);
  if (hm && (hm[1] || hm[2])) return (+(hm[1] || 0)) * 60 + +(hm[2] || 0);
  const n = +s;
  return Number.isFinite(n) ? n : undefined;
}
function clamp(n, lo, hi) {
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}
function firstISO(...vals) { return vals.find(isISO) || undefined; }
function isISO(s) { return typeof s === "string" && !Number.isNaN(Date.parse(s)); }
function arr(v) { return Array.isArray(v) ? v : []; }
function isPojo(v) { return v && typeof v === "object" && v.constructor === Object; }
function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}
function rankPriority(v) {
  const s = String(v || "").toLowerCase();
  if (["high", "urgent", "1"].includes(s)) return "high";
  if (["low", "3"].includes(s)) return "low";
  return "normal";
}
function genId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function safeSmall(obj) {
  try {
    const s = JSON.stringify(obj);
    return s && s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch { return "[unserializable]"; }
}

/* --------------------------------- Exports --------------------------------- */
export default {
  initCookingAdapter,
  mapCookingToSession,
};

// C:\Users\larho\suka-smart-assistant\src\services\session\adapters\fromPreservation.js
// Preservation → Scheduler Adapter
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ this adapter converts PRESERVATION
//            │             │               jobs (canning, fermenting, curing,
//            │             │               dehydrating, freezing, smoke-preserve)
//            │             │               into scheduler-ready session drafts.
//            └─ imports from recipes/videos/how-to or garden/animals yields
//
// What this module does
// ---------------------
// • `mapPreservationToSession(input)` → normalize a preservation job into a
//   single scheduler draft with ingredients (consumables), equipment, steps,
//   and safety-aware hints (pressure vs water-bath, salt %, etc.)
// • Event glue:
//     - respond("adapter/preservation/map")  → { ok, draft }
//     - on("preservation/requestSession")    → emits:
//           • "preservation/draftReady" (domain event)
//           • "session/draftReady"          (shared tray)
// • Emits canonical events via shared eventBus (wrapped upstream to {type,ts,source,data})
// • Optional Hub mirror when featureFlags.familyFundMode=true (fail-silent)
//
// Forward-looking
// ---------------
// • Supports extensions: smokehouse/curing cabinet, freeze-dryer, vacuum sealer
// • Weather aware: outdoor canning/smoking marks `weatherSensitive=true`
// • Inventory alignment: jars, lids, rings, vinegar, sugar, salt, pectin, ice
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
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {
  // optional
}

/* ---------------------------------- API ------------------------------------ */
export function initPreservationAdapter() {
  // RPC: preservation → session draft
  if (eventBus?.respond) {
    eventBus.respond("adapter/preservation/map", async (payload) => {
      try {
        const draft = mapPreservationToSession(payload);
        return { ok: true, draft };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // Main glue: engines/UX ask for a preservation session draft
  eventBus.on("preservation/requestSession", ({ data }) => {
    try {
      const draft = mapPreservationToSession(data);
      emit("preservation/draftReady", { draft });
      emit(Events?.SESSION_DRAFT_READY || "session/draftReady", { draft });

      exportToHubIfEnabled({
        type: "preservation/draftReady",
        ts: new Date().toISOString(),
        source: "adapter.preservation",
        data: { draft },
      });
    } catch (e) {
      emit(Events?.SESSION_ERROR || "session/error", {
        domain: "preservation",
        error: String(e?.message || e),
        input: safeSmall(data),
      });
    }
  }, { priority: 1 });
}

/**
 * Pure adapter: Map a PRESERVATION source object → scheduler session draft.
 * Accepts flexible inputs from recipes, garden harvests, butcher yields, etc.
 *
 * @param {object} input
 * @returns {SchedulerDraft}
 */
export function mapPreservationToSession(input = {}) {
  // 1) Normalize source
  const src = normalizePresInput(input);

  // 2) Derive fields
  const method = inferMethod(src);
  const durationMin = deriveDurationMin(src, method);
  const window = deriveWindow(src, durationMin);
  const equipment = deriveEquipment(src, method);
  const ingredients = deriveConsumables(src, method);
  const rolesNeeded = deriveRoles(src, method);
  const steps = deriveSteps(src, method);
  const safety = deriveSafetyFlags(src, method);
  const outdoor = ["smoke-preserve", "water-bath-canner:outdoor", "pressure-canner:outdoor"].includes(method) ||
                  hasKind(equipment, "smoker");

  // 3) Compose scheduler draft
  /** @type {SchedulerDraft} */
  const draft = {
    id: src.sessionId || genId(),
    domain: "preservation",
    title: buildTitle(src, method),
    location: outdoor ? "outdoor" : "kitchen",
    outdoor,
    noisy: hasKind(equipment, "smoker") || hasKind(equipment, "dehydrator"),
    durationMin,
    flexibilityMin: src.flexibilityMin ?? 45,
    window, // { startISO?, endISO? }
    equipment,              // [{ deviceId?, kind?, title? }]
    ingredients,            // consumables mapped to scheduler "ingredients"
    rolesNeeded,            // e.g., [{ role:"preserver", count:1 }, { role:"helper", count:1 }]
    steps,
    meta: {
      method,                           // canonical method id
      batch: src.batch,                 // { units, weightKg?, jars? }
      sourceUrl: src.sourceUrl,
      recipeId: src.recipeId,
      hazards: safety.hazards,          // ["botulismRiskLowAcid", ...]
      priority: src.priority,
      tags: src.tags,
      // signals to other services
      weatherSensitive: outdoor || method === "smoke-preserve",
      quietSensitive: false,
      planContext: pick(src, ["planDate", "slot", "dayPart"]),
      requiresCooling: /water-bath|pressure-canner|smoke/.test(method),
      requiresDeviceCooldown: hasKind(equipment, "pressure-canner") || hasKind(equipment, "smoker"),
    },
  };

  if (draft.durationMin <= 0) throw new Error("Invalid duration for preservation draft");
  return draft;
}

/* ---------------------------- Types (JSDoc only) --------------------------- */
/**
 * @typedef {Object} SchedulerDraft
 * @property {string} id
 * @property {"preservation"} domain
 * @property {string} title
 * @property {string} [location]
 * @property {boolean} [outdoor]
 * @property {boolean} [noisy]
 * @property {number} durationMin
 * @property {number} [flexibilityMin]
 * @property {{startISO?:string,endISO?:string}} [window]
 * @property {Array<{deviceId?:string, kind?:string, title?:string}>} [equipment]
 * @property {Array<{id?:string, sku?:string, name?:string, qty?:number, unit?:string}>} [ingredients]
 * @property {Array<{role:string, count?:number}>} [rolesNeeded]
 * @property {Array<{idx:number, label:string, estMin?:number}>} [steps]
 * @property {Object} meta
 */

/* -------------------------------- Derivers --------------------------------- */
function normalizePresInput(x = {}) {
  // Supported shapes:
  // - { recipe, harvest, yield, time, meta }
  // - direct fields: method, jars, heads, brinePct, saltPct, sugarPct, etc.
  const r = x.recipe || x;
  const meta = x.meta || r.meta || {};
  const time = x.time || {};

  // batch: { jars: {size:'pint|quart|half-pint', count}, weightKg }
  const batch = isPojo(r.batch) ? r.batch
              : isPojo(meta.batch) ? meta.batch
              : undefined;

  return {
    recipeId: String(r.id || meta.recipeId || ""),
    sessionId: String(meta.sessionId || r.sessionId || ""),
    title: String(r.title || meta.title || "Preservation Session"),
    sourceUrl: r.url || r.sourceUrl || meta.sourceUrl,
    tags: arr(r.tags || meta.tags),
    priority: rankPriority(meta.priority || r.priority),
    method: methodAlias(r.method || meta.method),
    // parameters
    acidPct: num(r.acidPct ?? meta.acidPct),    // vinegar % for pickles
    saltPct: num(r.saltPct ?? meta.saltPct),    // fermentation or brine %
    sugarPct: num(r.sugarPct ?? meta.sugarPct), // jams/jellies
    brinePct: num(r.brinePct ?? meta.brinePct),
    headspaceMm: num(r.headspaceMm ?? meta.headspaceMm),
    altitudeM: num(meta.altitudeM),             // adjust processing time if provided
    batch,
    // timing
    totalMin: minutesFrom(r.totalTime || meta.totalTime),
    // window
    start: firstISO(time.start, meta.start),
    end: firstISO(time.end, meta.end),
    planDate: firstISO(meta.planDate),
    dayPart: meta.dayPart,
    slot: meta.slot,
    flexibilityMin: num(meta.flexibilityMin),
    // domain payloads
    ingredients: arr(r.ingredients || meta.ingredients), // produce + consumables
    equipment: arr(r.equipment || meta.equipment),
    steps: arr(r.steps || meta.steps),
  };
}

function inferMethod(src) {
  const m = String(src.method || "").toLowerCase();
  if (!m) {
    // Guess from ingredients/steps/title
    const t = `${src.title} ${JSON.stringify(src.steps)} ${JSON.stringify(src.ingredients)}`.toLowerCase();
    if (/dehydrat|dry/.test(t)) return "dehydrate";
    if (/freeze[- ]?dry/.test(t)) return "freeze-dry";
    if (/pickle|water[- ]?bath/.test(t)) return "water-bath-canner";
    if (/pressure/.test(t)) return "pressure-canner";
    if (/ferment|kraut|kimchi|brine/.test(t)) return "ferment";
    if (/jam|jelly|pectin/.test(t)) return "jam-jelly";
    if (/smok(e|ing)/.test(t)) return "smoke-preserve";
    if (/vac(uum)?\s*seal/.test(t)) return "vacuum-seal";
    if (/freeze/.test(t)) return "freeze";
    return "general-preserve";
  }
  return methodAlias(m);
}
function methodAlias(m) {
  const s = String(m || "").toLowerCase().trim();
  const map = {
    "waterbath": "water-bath-canner",
    "water-bath": "water-bath-canner",
    "wbc": "water-bath-canner",
    "pc": "pressure-canner",
    "pressure": "pressure-canner",
    "smoke": "smoke-preserve",
    "freeze-drier": "freeze-dry",
  };
  return map[s] || s;
}

function deriveDurationMin(src, method) {
  if (num(src.totalMin)) return clamp(num(src.totalMin), 10, 12 * 60);
  // Heuristics by method + batch size
  const jars = src.batch?.jars?.count || 0;
  const weightKg = num(src.batch?.weightKg) || 0;
  switch (method) {
    case "pressure-canner": return clamp(30 + jars * 8, 45, 240);
    case "water-bath-canner": return clamp(20 + jars * 6, 30, 180);
    case "jam-jelly": return clamp(30 + jars * 4, 30, 150);
    case "ferment": return clamp(40 + Math.ceil(weightKg) * 8, 30, 120);
    case "dehydrate": return clamp(30 + Math.ceil(weightKg) * 10, 30, 300);
    case "freeze-dry": return clamp(45 + Math.ceil(weightKg) * 15, 60, 720);
    case "smoke-preserve": return clamp(60 + Math.ceil(weightKg) * 15, 90, 720);
    case "vacuum-seal": return clamp(20 + Math.ceil(weightKg) * 4, 15, 120);
    case "freeze": return clamp(20 + Math.ceil(weightKg) * 3, 15, 90);
    default: return 60;
  }
}

function deriveWindow(src, durationMin) {
  const s = isISO(src.start) ? src.start : null;
  const e = isISO(src.end) ? src.end : (s ? new Date(Date.parse(s) + durationMin * 60000).toISOString() : null);
  if (!s && !e) return undefined;
  return { startISO: s || undefined, endISO: e || undefined };
}

function deriveEquipment(src, method) {
  const norm = (eq) => ({
    deviceId: eq?.deviceId ? String(eq.deviceId) : undefined,
    kind: eq?.kind ? String(eq.kind) : guessKind(eq?.name || eq?.title),
    title: eq?.title || eq?.name || undefined,
  });

  const header = (src.equipment || []).map(norm);
  const implied = [];
  if (method === "water-bath-canner") implied.push({ kind: "water-bath-canner", title: "Water-Bath Canner" });
  if (method === "pressure-canner")   implied.push({ kind: "pressure-canner", title: "Pressure Canner" });
  if (method === "jam-jelly")         implied.push({ kind: "stovetop", title: "Stovetop / Stockpot" });
  if (method === "dehydrate")         implied.push({ kind: "dehydrator", title: "Dehydrator" });
  if (method === "freeze-dry")        implied.push({ kind: "freeze-dryer", title: "Freeze Dryer" });
  if (method === "smoke-preserve")    implied.push({ kind: "smoker", title: "Smoker" });
  if (method === "vacuum-seal")       implied.push({ kind: "vacuum-sealer", title: "Vacuum Sealer" });
  if (method === "freeze")            implied.push({ kind: "freezer", title: "Freezer Space" });

  const all = [...header, ...implied.map(norm)];
  return dedupByKey(all, (e) => e.deviceId || e.kind || e.title);
}

function deriveConsumables(src, method) {
  // Map to scheduler "ingredients" for inventory checks
  const normalize = (item) => {
    const id = String(item?.id || item?.sku || item?.name || "");
    const name = String(item?.name || "");
    const sku = item?.sku ? String(item.sku) : undefined;
    const qty = num(item?.qty || item?.quantity);
    const unit = String(item?.unit || item?.uom || "");
    return (id || name) ? { id: id || undefined, sku, name: name || undefined, qty: qty || undefined, unit: unit || undefined } : null;
  };

  const head = (src.ingredients || []).map(normalize).filter(Boolean);
  const implied = [];

  // Common preservation supplies (heuristic, scaled by batch)
  const jars = src.batch?.jars?.count || 0;
  const size = String(src.batch?.jars?.size || "").toLowerCase();

  if (jars) {
    implied.push({ name: `Mason jar ${size || "pint"} (case)`, qty: Math.ceil(jars / 12), unit: "case" });
    implied.push({ name: "Lids (new)", qty: jars, unit: "ea" });
    implied.push({ name: "Rings", qty: jars, unit: "ea" });
  }

  if (method === "water-bath-canner") {
    implied.push({ name: "White vinegar (5%)", qty: 1, unit: "L" });
    if (!hasNamed(head, /pectin|sure[-\s]?jell/i) && /jam|jelly/.test(String(src.title).toLowerCase())) {
      implied.push({ name: "Pectin", qty: 1, unit: "box" });
    }
  }
  if (method === "jam-jelly") {
    implied.push({ name: "Sugar", qty: 2, unit: "kg" });
    implied.push({ name: "Pectin", qty: 1, unit: "box" });
    implied.push({ name: "Citric acid", qty: 1, unit: "pkt" });
  }
  if (method === "ferment") {
    implied.push({ name: "Salt (non-iodized)", qty: 1, unit: "kg" });
    implied.push({ name: "Airlock lids / weights", qty: 1, unit: "set" });
  }
  if (method === "dehydrate" || method === "freeze-dry") {
    implied.push({ name: "Sheet liners / trays", qty: 1, unit: "set" });
  }
  if (method === "vacuum-seal") {
    implied.push({ name: "Vacuum sealer bags/roll", qty: 1, unit: "roll" });
  }
  if (method === "freeze") {
    implied.push({ name: "Freezer bags / containers", qty: 1, unit: "box" });
    implied.push({ name: "Labels", qty: 1, unit: "sheet" });
  }
  if (method === "smoke-preserve") {
    implied.push({ name: "Wood chips/chunks", qty: 1, unit: "bag" });
  }

  return mergeConsumables([...head, ...implied]);
}

function deriveRoles(src, method) {
  const base = [{ role: "preserver", count: 1 }];
  const manyJars = (src.batch?.jars?.count || 0) > 12;
  const heavy = method === "pressure-canner" || method === "smoke-preserve" || method === "freeze-dry";
  if (manyJars || heavy) base.push({ role: "helper", count: 1 });
  return base;
}

function deriveSteps(src, method) {
  // Prefer explicit steps
  if (Array.isArray(src.steps) && src.steps.length) {
    return src.steps.map((s, i) => ({
      idx: i + 1,
      label: String(s?.label || s?.text || s || `Step ${i + 1}`),
      estMin: num(s?.estMin),
    }));
  }

  // Otherwise, synthesize a sane flow
  const steps = [];
  if (/water-bath-canner|pressure-canner|jam-jelly/.test(method)) {
    steps.push({ label: "Sanitize jars & lids", estMin: 15 });
  }
  if (method === "ferment") {
    steps.push({ label: "Prepare brine / salt produce", estMin: 15 });
  } else {
    steps.push({ label: "Prep produce / trim", estMin: 20 });
  }

  switch (method) {
    case "water-bath-canner":
      steps.push({ label: "Cook / pack jars", estMin: 20 });
      steps.push({ label: "Process in water-bath", estMin: 30 });
      steps.push({ label: "Cool & check seals", estMin: 30 });
      break;
    case "pressure-canner":
      steps.push({ label: "Hot pack jars", estMin: 25 });
      steps.push({ label: "Process in pressure canner (includes vent)", estMin: 45 });
      steps.push({ label: "Cool & de-pressurize", estMin: 30 });
      break;
    case "jam-jelly":
      steps.push({ label: "Cook to gel point", estMin: 25 });
      steps.push({ label: "Fill jars & water-bath (short)", estMin: 20 });
      steps.push({ label: "Cool & set", estMin: 30 });
      break;
    case "ferment":
      steps.push({ label: "Pack crock / jars", estMin: 15 });
      steps.push({ label: "Fit airlock / weights", estMin: 10 });
      break;
    case "dehydrate":
      steps.push({ label: "Slice & pre-treat (optional)", estMin: 20 });
      steps.push({ label: "Load dehydrator trays", estMin: 15 });
      steps.push({ label: "Dry to target moisture", estMin: 30 });
      break;
    case "freeze-dry":
      steps.push({ label: "Pre-freeze / load trays", estMin: 20 });
      steps.push({ label: "Run freeze-dry cycle", estMin: 45 });
      break;
    case "vacuum-seal":
      steps.push({ label: "Portion & bag", estMin: 20 });
      steps.push({ label: "Vacuum & seal", estMin: 15 });
      break;
    case "freeze":
      steps.push({ label: "Portion & package", estMin: 20 });
      steps.push({ label: "Label & freeze", estMin: 10 });
      break;
    case "smoke-preserve":
      steps.push({ label: "Brine/dry rub & pellicle", estMin: 30 });
      steps.push({ label: "Load smoker, maintain temp", estMin: 45 });
      steps.push({ label: "Cool & package", estMin: 20 });
      break;
    default:
      steps.push({ label: "Prepare & package", estMin: 30 });
  }
  return steps.map((s, i) => ({ idx: i + 1, ...s }));
}

function deriveSafetyFlags(src, method) {
  const hazards = [];
  const title = String(src.title || "").toLowerCase();
  const lowAcidProduce = /(green bean|carrot|meat|stock|broth|corn|peas|beet|soup|pumpkin)/.test(title);
  if (lowAcidProduce && method === "water-bath-canner") hazards.push("botulismRiskLowAcid"); // nudge planner, not a validator
  if (method === "pressure-canner") hazards.push("pressureVesselHot");
  if (method === "smoke-preserve") hazards.push("outdoorFireHeat");
  if (method === "ferment" && (num(src.saltPct) || 0) < 2) hazards.push("lowSaltFerment");
  return { hazards };
}

/* -------------------------------- Helpers ---------------------------------- */
function hasKind(eq = [], kind) { return (eq || []).some(e => String(e.kind || "").toLowerCase() === String(kind)); }
function hasNamed(list, re) { return (list || []).some(i => re.test(String(i?.name || ""))); }
function guessKind(name) {
  const s = String(name || "").toLowerCase();
  if (/pressure/.test(s)) return "pressure-canner";
  if (/water[-\s]?bath/.test(s)) return "water-bath-canner";
  if (/dehydrat/.test(s)) return "dehydrator";
  if (/freeze[-\s]?dry/.test(s)) return "freeze-dryer";
  if (/vac(uum)?\s*seal/.test(s)) return "vacuum-sealer";
  if (/smok/.test(s)) return "smoker";
  if (/stove|stockpot|rangetop/.test(s)) return "stovetop";
  if (/freez/.test(s)) return "freezer";
  return undefined;
}
function buildTitle(src, method) {
  const base = src.title || "Preservation Session";
  const b = src.batch?.jars?.count ? ` • ${src.batch.jars.count} jars` : src.batch?.weightKg ? ` • ${src.batch.weightKg}kg` : "";
  return `${base}${b || ""} (${methodLabel(method)})`;
}
function methodLabel(m) {
  const map = {
    "water-bath-canner": "Water-Bath",
    "pressure-canner": "Pressure Canner",
    "jam-jelly": "Jam/Jelly",
    "ferment": "Ferment",
    "dehydrate": "Dehydrate",
    "freeze-dry": "Freeze-Dry",
    "vacuum-seal": "Vacuum Seal",
    "freeze": "Freeze",
    "smoke-preserve": "Smoke-Preserve",
    "general-preserve": "Preserve",
  };
  return map[m] || m;
}

/* ------------------------------ eventBus I/O -------------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "adapter.preservation" });
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
  const out = {}; for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}
function rankPriority(v) {
  const s = String(v || "").toLowerCase();
  if (["high", "urgent", "1"].includes(s)) return "high";
  if (["low", "3"].includes(s)) return "low";
  return "normal";
}
function dedupByKey(arr, getKey) {
  const out = []; const seen = new Set();
  for (const it of arr) {
    const k = getKey(it);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(it);
  }
  return out;
}
function mergeConsumables(items) {
  // Deduplicate by id/sku/name and sum qty
  const byKey = new Map();
  for (const c of items) {
    if (!c) continue;
    const key = c.id || c.sku || c.name;
    if (!key) continue;
    const prev = byKey.get(key);
    if (prev) {
      const a = num(prev.qty) || 0, b = num(c.qty) || 0;
      byKey.set(key, { ...prev, qty: (a + b) || undefined });
    } else {
      byKey.set(key, c);
    }
  }
  return Array.from(byKey.values());
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
  initPreservationAdapter,
  mapPreservationToSession,
};

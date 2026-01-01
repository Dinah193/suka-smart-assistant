// C:\Users\larho\suka-smart-assistant\src\services\session\adapters\fromAnimal.js
// Animals / Butchery → Scheduler Adapter
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ this adapter converts ANIMAL domain
//            │             │               jobs (husbandry care, butchery,
//            │             │               processing, egg collection, hoof care)
//            │             │               into scheduler-ready session drafts.
//            └─ imports from herd logs / breeding plans / how-to videos
//
// What this module does
// ---------------------
// • `mapAnimalToSession(input)` → normalize an animal/butchery job into a single
//   scheduler draft with equipment, consumables, roles, steps, and safety flags.
// • Event glue:
//     - respond("adapter/animals/map")  → { ok, draft }
//     - on("animals/requestSession")    → emits:
//           • "animals/draftReady" (domain event)
//           • "session/draftReady"  (shared tray for scheduler)
// • Emits canonical events via shared eventBus (it wraps to { type, ts, source, data }).
// • Optional Hub mirroring (featureFlags.familyFundMode=true).
//
// Forward-looking
// ---------------
// • Covers poultry processing (scalder/plucker), small stock (rabbits/goats),
//   large animal tasks (hoof trim, deworm, AI), dairy chores, and vet visits.
// • Weather-aware and people/equipment aware (outdoor, noisy, sharp tools).
// • Inventory alignment: ice, bags, salt, sanitizer, blades, twine, feed meds.
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
export function initAnimalsAdapter() {
  // RPC: animals → session draft
  if (eventBus?.respond) {
    eventBus.respond("adapter/animals/map", async (payload) => {
      try {
        const draft = mapAnimalToSession(payload);
        return { ok: true, draft };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // Main glue: engines/UX ask for an animal/butchery session draft
  eventBus.on("animals/requestSession", ({ data }) => {
    try {
      const draft = mapAnimalToSession(data);
      emit("animals/draftReady", { draft });
      emit(Events?.SESSION_DRAFT_READY || "session/draftReady", { draft });

      // Optional Hub mirror (creating a draft affects household planning data)
      exportToHubIfEnabled({
        type: "animals/draftReady",
        ts: new Date().toISOString(),
        source: "adapter.animals",
        data: { draft },
      });
    } catch (e) {
      emit(Events?.SESSION_ERROR || "session/error", {
        domain: "animals",
        error: String(e?.message || e),
        input: safeSmall(data),
      });
    }
  }, { priority: 1 });
}

/**
 * Pure adapter: Map an ANIMALS source object → scheduler session draft.
 * Accepts flexible inputs from herd logs, slaughter plans, or ad-hoc animal tasks.
 *
 * @param {object} input
 * @returns {SchedulerDraft}
 */
export function mapAnimalToSession(input = {}) {
  // 1) Normalize source
  const src = normalizeAnimalInput(input);

  // 2) Derive fields
  const kind = inferWorkKind(src); // "butchery" | "care" | "milking" | "collection" | "vet"
  const durationMin = deriveDurationMin(src, kind);
  const window = deriveWindow(src, durationMin);
  const equipment = deriveEquipment(src, kind);
  const ingredients = deriveConsumables(src, kind);
  const rolesNeeded = deriveRoles(src, kind);
  const steps = deriveSteps(src, kind);
  const safety = deriveSafetyFlags(src, kind);
  const location = deriveLocation(src, kind);
  const outdoor = kind !== "milking" && kind !== "collection" ? true : !!src.outdoor; // most butchery/care outdoors
  const noisy = hasKind(equipment, "plucker") || hasKind(equipment, "compressor") || hasKind(equipment, "generator");

  // 3) Compose scheduler draft
  /** @type {SchedulerDraft} */
  const draft = {
    id: src.sessionId || genId(),
    domain: "animals",
    title: buildTitle(src, kind),
    location,
    outdoor,
    noisy,
    durationMin,
    flexibilityMin: src.flexibilityMin ?? (kind === "butchery" ? 90 : 30),
    window,                  // { startISO?, endISO? }
    equipment,               // [{ deviceId?, kind?, title? }]
    ingredients,             // consumables mapped to scheduler "ingredients"
    rolesNeeded,             // e.g., [{ role:"butcher", count:1 }, { role:"handler", count:1 }]
    steps,                   // normalized with estimates
    meta: {
      herdId: src.herdId,
      animals: src.animals,          // [{ id, tag, species, count }]
      processorId: src.processorId,  // off-site processor (if any)
      tags: src.tags,
      priority: src.priority,
      planContext: pick(src, ["planDate", "slot", "dayPart"]),
      hazards: safety.hazards,
      weatherSensitive: outdoor,
      quietSensitive: false,
      refrigerationCritical: kind === "butchery" || /chill|cooler/i.test(JSON.stringify(steps)),
      wasteDisposalPlan: src.wasteDisposalPlan || undefined,
    },
  };

  if (draft.durationMin <= 0) throw new Error("Invalid duration for animal/butchery draft");
  return draft;
}

/* ---------------------------- Types (JSDoc only) --------------------------- */
/**
 * @typedef {Object} SchedulerDraft
 * @property {string} id
 * @property {"animals"} domain
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

/* ------------------------------ Derivers ----------------------------------- */
function normalizeAnimalInput(x = {}) {
  // Supported shapes:
  // - { herd, plan, task, time, meta }
  // - direct fields: species, count, weightClass, operation (e.g., "poultry-process")
  const herd = x.herd || {};
  const plan = x.plan || x;
  const meta = x.meta || plan.meta || {};
  const time = x.time || {};

  const animals = Array.isArray(plan.animals) ? plan.animals
                 : Array.isArray(herd.animals) ? herd.animals
                 : (Number.isFinite(plan.count) || Number.isFinite(meta.count))
                   ? [{ id: meta.animalId, tag: meta.tag, species: plan.species || meta.species, count: plan.count || meta.count }]
                   : [];

  return {
    sessionId: String(meta.sessionId || plan.sessionId || ""),
    herdId: String(herd.id || meta.herdId || ""),
    title: String(plan.title || meta.title || "Animal Session"),
    tags: arr(plan.tags || meta.tags),
    priority: rankPriority(meta.priority || plan.priority),
    species: String(plan.species || meta.species || ""),
    operation: String(plan.operation || meta.operation || ""), // "poultry-process" | "hoof-trim" | "vet-visit" | ...
    processorId: plan.processorId || meta.processorId,
    animals,
    // Quantities
    count: Number.isFinite(plan.count) ? +plan.count : Number.isFinite(meta.count) ? +meta.count : undefined,
    weightClass: String(plan.weightClass || meta.weightClass || ""), // "broiler", "market", "cull", etc.
    // Timing
    totalMin: minutesFrom(plan.totalTime || meta.totalTime),
    start: firstISO(time.start, meta.start, plan.start),
    end: firstISO(time.end, meta.end, plan.end),
    planDate: firstISO(plan.planDate, meta.planDate),
    dayPart: plan.dayPart || meta.dayPart,
    slot: plan.slot || meta.slot,
    flexibilityMin: num(meta.flexibilityMin),
    // Domain payloads
    equipment: arr(plan.equipment || meta.equipment),
    consumables: arr(plan.consumables || plan.supplies || meta.consumables),
    steps: arr(plan.steps || meta.steps),
    wasteDisposalPlan: meta.wasteDisposalPlan,
    outdoor: meta.outdoor,
  };
}

function inferWorkKind(src) {
  const op = String(src.operation || "").toLowerCase();
  const title = String(src.title || "").toLowerCase();
  const text = `${op} ${title}`;
  if (/process|butcher|slaughter|dispatch/.test(text)) return "butchery";
  if (/milk|milking|dairy/.test(text)) return "milking";
  if (/collect|egg/.test(text)) return "collection";
  if (/vet|vaccin|deworm|ai\b|insemination|hoof|trim|shear|tag|band/.test(text)) return "care";
  return "care";
}

function deriveDurationMin(src, kind) {
  if (num(src.totalMin)) return clamp(num(src.totalMin), 10, 12 * 60);
  const count = num(src.count) || (Array.isArray(src.animals) ? (src.animals[0]?.count || src.animals.length) : 1);
  switch (kind) {
    case "butchery":
      // Rough heuristics per head (poultry faster, large stock longer)
      if (/chicken|turkey|duck|poultry|broiler|layer/i.test(src.species)) return clamp(20 + (count * 12), 30, 8 * 60);
      if (/rabbit/i.test(src.species)) return clamp(30 + (count * 15), 45, 8 * 60);
      return clamp(90 + (count * 60), 90, 12 * 60); // goats/sheep/pigs/etc.
    case "milking":
      return clamp(20 + (count * 8), 20, 180);
    case "collection":
      return clamp(10 + (count * 2), 10, 120);
    case "care":
    default:
      return clamp(20 + (count * 10), 15, 240);
  }
}

function deriveWindow(src, durationMin) {
  const s = isISO(src.start) ? src.start : null;
  const e = isISO(src.end) ? src.end : (s ? new Date(Date.parse(s) + durationMin * 60000).toISOString() : null);
  if (!s && !e) return undefined;
  return { startISO: s || undefined, endISO: e || undefined };
}

function deriveEquipment(src, kind) {
  const norm = (eq) => ({
    deviceId: eq?.deviceId ? String(eq.deviceId) : undefined,
    kind: eq?.kind ? String(eq.kind) : guessKind(eq?.name || eq?.title),
    title: eq?.title || eq?.name || undefined,
  });

  const header = (src.equipment || []).map(norm);
  const implied = [];

  if (kind === "butchery") {
    implied.push({ kind: "knife-set", title: "Butcher Knives" });
    implied.push({ kind: "bone-saw", title: "Bone Saw" });
    if (/poultry|chicken|turkey|duck|broiler|layer/i.test(src.species)) {
      implied.push({ kind: "scalder", title: "Scalder" });
      implied.push({ kind: "plucker", title: "Plucker" });
    }
    implied.push({ kind: "cooler", title: "Ice Cooler" });
    implied.push({ kind: "table", title: "Sanitary Table" });
    implied.push({ kind: "hose", title: "Hose / Water" });
  } else if (kind === "milking") {
    implied.push({ kind: "milking-stand", title: "Milking Stand" });
    implied.push({ kind: "pulsator", title: "Milker / Pulsator" });
  } else if (kind === "care") {
    if (/hoof|trim/i.test(String(src.operation))) implied.push({ kind: "hoof-trimmer", title: "Hoof Trimmer" });
    if (/shear/i.test(String(src.operation))) implied.push({ kind: "shears", title: "Shears" });
    implied.push({ kind: "chute", title: "Handling Chute / Halter" });
  }

  const all = [...header, ...implied.map(norm)];
  return dedupByKey(all, (e) => e.deviceId || e.kind || e.title);
}

function deriveConsumables(src, kind) {
  // Map to scheduler "ingredients" for inventory checks
  const normalize = (item) => {
    const id = String(item?.id || item?.sku || item?.name || "");
    const name = String(item?.name || "");
    const sku = item?.sku ? String(item.sku) : undefined;
    const qty = num(item?.qty || item?.quantity);
    const unit = String(item?.unit || item?.uom || "");
    return (id || name) ? { id: id || undefined, sku, name: name || undefined, qty: qty || undefined, unit: unit || undefined } : null;
  };

  const head = (src.consumables || []).map(normalize).filter(Boolean);
  const implied = [];

  if (kind === "butchery") {
    implied.push({ name: "Ice", qty: 2, unit: "bags" });
    implied.push({ name: "Trash bags / liners", qty: 2, unit: "roll" });
    implied.push({ name: "Sanitizer / bleach", qty: 1, unit: "L" });
    implied.push({ name: "Butcher paper / bags", qty: 1, unit: "roll" });
    implied.push({ name: "Labels & marker", qty: 1, unit: "set" });
    implied.push({ name: "Twine", qty: 1, unit: "roll" });
    implied.push({ name: "Sharpening steel", qty: 1, unit: "ea" });
  } else if (kind === "milking") {
    implied.push({ name: "Teat dip / wipes", qty: 1, unit: "pack" });
    implied.push({ name: "Filter papers", qty: 1, unit: "box" });
    implied.push({ name: "Sanitizer", qty: 1, unit: "L" });
  } else if (kind === "care") {
    if (/deworm|vaccin/i.test(String(src.operation))) implied.push({ name: "Syringes / meds", qty: 1, unit: "kit" });
    if (/hoof|trim/i.test(String(src.operation))) implied.push({ name: "Hoof blocks / glue", qty: 1, unit: "kit" });
  }

  return mergeConsumables([...head, ...implied]);
}

function deriveRoles(src, kind) {
  const base = [{ role: kind === "butchery" ? "butcher" : "handler", count: 1 }];
  const count = num(src.count) || 1;
  if (kind === "butchery") {
    base.push({ role: "helper", count: count > 5 ? 2 : 1 });
    if (/large|goat|sheep|pig|beef|cow|steer/i.test(src.species)) base.push({ role: "adult-supervisor", count: 1 });
  } else if (kind === "care") {
    if (/vet|vaccin|ai|insemination/i.test(String(src.operation))) base.push({ role: "vet-tech", count: 1 });
  }
  return base;
}

function deriveSteps(src, kind) {
  // Prefer explicit steps
  if (Array.isArray(src.steps) && src.steps.length) {
    return src.steps.map((s, i) => ({
      idx: i + 1,
      label: String(s?.label || s?.text || s || `Step ${i + 1}`),
      estMin: num(s?.estMin),
    }));
  }

  const steps = [];
  switch (kind) {
    case "butchery":
      if (/poultry|chicken|turkey|duck|broiler|layer/i.test(src.species)) {
        steps.push({ label: "Set up scalder/plucker & sanitize area", estMin: 20 });
        steps.push({ label: "Dispatch & bleed", estMin: 20 });
        steps.push({ label: "Scald & pluck", estMin: 30 });
        steps.push({ label: "Eviscerate & rinse", estMin: 30 });
        steps.push({ label: "Chill in ice bath & package", estMin: 30 });
      } else {
        steps.push({ label: "Set up tools, tables, sanitation", estMin: 30 });
        steps.push({ label: "Stun/dispatch & bleed", estMin: 30 });
        steps.push({ label: "Skin & eviscerate", estMin: 60 });
        steps.push({ label: "Breakdown & package", estMin: 60 });
        steps.push({ label: "Chill & clean-down", estMin: 30 });
      }
      break;
    case "milking":
      steps.push({ label: "Prep animal & sanitize", estMin: 10 });
      steps.push({ label: "Milk / filter", estMin: 20 });
      steps.push({ label: "Cool milk & clean equipment", estMin: 15 });
      break;
    case "collection":
      steps.push({ label: "Nest checks / egg collection", estMin: 15 });
      steps.push({ label: "Wash/sort/record", estMin: 15 });
      break;
    case "care":
    default:
      steps.push({ label: "Set up chute/halter & tools", estMin: 10 });
      steps.push({ label: toTitle(src.operation || "Perform care procedure"), estMin: 20 });
      steps.push({ label: "Record treatment & clean-down", estMin: 10 });
      break;
  }
  return steps.map((s, i) => ({ idx: i + 1, ...s }));
}

function deriveSafetyFlags(src, kind) {
  const hazards = [];
  if (kind === "butchery") {
    hazards.push("sharpTools");
    hazards.push("biohazardWaste");
    hazards.push("temperatureCritical");
  }
  if (kind === "care" && /vaccin|med|ai|insemination/i.test(String(src.operation))) {
    hazards.push("needlesMeds");
  }
  if (hasKind(deriveEquipment(src, kind), "scalder")) hazards.push("hotLiquids");
  if (hasKind(deriveEquipment(src, kind), "plucker")) hazards.push("pinchHazard");
  return { hazards };
}

function deriveLocation(src, kind) {
  if (kind === "milking") return "milking parlor";
  if (kind === "collection") return "coop / henhouse";
  if (kind === "butchery") return "butchery area";
  return "barnyard";
}

/* -------------------------------- Helpers ---------------------------------- */
function hasKind(eq = [], kind) { return (eq || []).some(e => String(e.kind || "").toLowerCase() === String(kind)); }
function guessKind(name) {
  const s = String(name || "").toLowerCase();
  if (/plucker/.test(s)) return "plucker";
  if (/scald/.test(s)) return "scalder";
  if (/cooler|ice/.test(s)) return "cooler";
  if (/knife|butcher/.test(s)) return "knife-set";
  if (/saw/.test(s)) return "bone-saw";
  if (/table/.test(s)) return "table";
  if (/hose|water/.test(s)) return "hose";
  if (/milking|pulsator|vacuum/.test(s)) return "pulsator";
  if (/stand/.test(s)) return "milking-stand";
  if (/compressor/.test(s)) return "compressor";
  if (/generator/.test(s)) return "generator";
  if (/chute|halter/.test(s)) return "chute";
  if (/shear/.test(s)) return "shears";
  if (/hoof/.test(s)) return "hoof-trimmer";
  return undefined;
}
function buildTitle(src, kind) {
  const base = src.title || (kind === "butchery" ? "Butchery Session" : "Animal Session");
  const sp = src.species ? ` • ${toTitle(src.species)}` : "";
  const cnt = num(src.count) ? ` × ${src.count}` : "";
  return `${base}${sp}${cnt}`;
}

/* ------------------------------ eventBus I/O -------------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "adapter.animals" });
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
function toTitle(s) { return String(s || "").replace(/\b\w/g, c => c.toUpperCase()); }

/* --------------------------------- Exports --------------------------------- */
export default {
  initAnimalsAdapter,
  mapAnimalToSession,
};

// C:\Users\larho\suka-smart-assistant\src\services\session\adapters\fromGarden.js
// Garden → Scheduler Adapter
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ this adapter converts GARDEN domain
//            │             │               objects (plans/tasks/seed imports)
//            │             │               into scheduler-ready session drafts.
//            └─ imports from seed catalogs / garden planners / videos/how-to
//
// What this module does
// ---------------------
// • `mapGardenToSession(input)` → normalize garden work into a single Session draft
// • Event glue:
//     - respond("adapter/garden/map")  → { ok, draft }
//     - on("garden/requestSession")    → maps and emits:
//           • "garden/draftReady" (domain event)
//           • "session/draftReady"    (shared tray, for immediate scheduling)
// • Emits canonical events via shared eventBus (wrapping to { type, ts, source, data })
// • Optional Hub mirror when featureFlags.familyFundMode=true (fail-silent)
//
// Design notes
// ------------
// • Forward-looking: covers sow/transplant, amend, irrigate, trellis, harvest,
//   pest control, pruning, compost, cover crops, and preservation-prep hooks.
// • Weather-aware hints: marks `outdoor=true`, `weatherSensitive=true` and
//   annotates potential blockers (frost/wind/heavy rain) for the planner.
// • Inventory alignment: consumables (seed, soil, amendments, mulch) → `ingredients`
//   so the prereq checker can ask inventory/check and detect shortages.
// -----------------------------------------------------------------------------

/* --------------------------------- Imports --------------------------------- */
let eventBus, Events;
try {
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb.default || eb.eventBus || eb;
  Events = eb.Events || {};
} catch {
  try {
    const eb = require("@/services/events/eventBus.js");
    eventBus = eb.default || eb.eventBus || eb;
    Events = eb.Events || {};
  } catch {
    eventBus = { emit: () => {}, on: () => () => {}, respond: () => () => {} };
    Events = {};
  }
}

let featureFlags = {};
try {
  featureFlags =
    require("@/config/featureFlags").default ||
    require("@/config/featureFlags");
} catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch {
  // optional
}

/* ---------------------------------- API ------------------------------------ */
/** Initialize adapter wiring */
export function initGardenAdapter() {
  // RPC: garden → session draft
  if (eventBus?.respond) {
    eventBus.respond("adapter/garden/map", async (payload) => {
      try {
        const draft = mapGardenToSession(payload);
        return { ok: true, draft };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // Main glue: engines/UX ask for a garden session draft
  eventBus.on(
    "garden/requestSession",
    ({ data }) => {
      try {
        const draft = mapGardenToSession(data);
        // emit domain draft (for domain UIs)
        emit("garden/draftReady", { draft });
        // also emit to shared tray immediately
        emit(Events?.SESSION_DRAFT_READY || "session/draftReady", { draft });

        // optional hub mirror (creating a draft is a household data change)
        exportToHubIfEnabled({
          type: "garden/draftReady",
          ts: new Date().toISOString(),
          source: "adapter.garden",
          data: { draft },
        });
      } catch (e) {
        emit(Events?.SESSION_ERROR || "session/error", {
          domain: "garden",
          error: String(e?.message || e),
          input: safeSmall(data),
        });
      }
    },
    { priority: 1 }
  );

  // Convenience: if a plan generation event fires with a concrete task, map it
  eventBus.on(
    Events?.GARDEN_PLAN_GENERATE_REQ || "garden/plan.generate.requested",
    ({ data }) => {
      // If the request already carries concrete work items with a time window,
      // generate a draft so it can be placed quickly.
      const src = data || {};
      const hasConcrete =
        (Array.isArray(src?.tasks) && src.tasks.length) ||
        (Array.isArray(src?.beds) && src.beds.length) ||
        (Array.isArray(src?.crops) && src.crops.length);
      if (!hasConcrete) return;
      try {
        const draft = mapGardenToSession(src);
        emit("garden/draftReady", { draft });
        emit(Events?.SESSION_DRAFT_READY || "session/draftReady", { draft });
        exportToHubIfEnabled({
          type: "garden/draftReady",
          ts: new Date().toISOString(),
          source: "adapter.garden",
          data: { draft },
        });
      } catch {}
    }
  );
}

/**
 * Pure adapter: Map a GARDEN source object → scheduler session draft.
 * Accepts flexible input shapes from garden planners, seed imports, or ad-hoc tasks.
 *
 * @param {object} input
 * @returns {SchedulerDraft}
 */
export function mapGardenToSession(input = {}) {
  // 1) Normalize source
  const src = normalizeGardenInput(input);

  // 2) Derived fields
  const durationMin = deriveDurationMin(src);
  const window = deriveWindow(src, durationMin);
  const equipment = deriveEquipment(src);
  const ingredients = deriveConsumables(src);
  const rolesNeeded = deriveRoles(src);
  const steps = deriveSteps(src);
  const location = deriveLocation(src);
  const tags = src.tags || [];
  const outdoor = true;

  // 3) Compose scheduler draft
  /** @type {SchedulerDraft} */
  const draft = {
    id: src.sessionId || genId(),
    domain: "garden",
    title: buildTitle(src),
    location,
    outdoor,
    noisy: inferNoisy(equipment, steps),
    durationMin,
    flexibilityMin: src.flexibilityMin ?? 60,
    window, // { startISO?, endISO? }
    equipment, // [{ deviceId?, kind?, title? }]
    ingredients, // consumables mapped to scheduler "ingredients"
    rolesNeeded, // e.g., [{ role:"gardener", count:1 }]
    steps, // normalized with estimates
    meta: {
      planId: src.planId,
      sourceUrl: src.sourceUrl,
      tags,
      plots: src.plots,
      beds: src.beds, // [{ id?, name, areaM2? }]
      crops: src.crops, // [{ crop, cultivar?, qty? }]
      hazards: src.hazards, // e.g., "thorns", "pesticide"
      priority: src.priority,
      planContext: pick(src, ["planDate", "slot", "dayPart"]),
      weatherSensitive: true, // signals service will annotate/follow-up
      frostSensitive: src.frostSensitive,
      windSensitive: src.windSensitive,
      heavyRainSensitive: src.heavyRainSensitive,
    },
  };

  // 4) Minimal validation
  if (draft.durationMin <= 0)
    throw new Error("Invalid duration for garden draft");

  return draft;
}

/* ---------------------------- Types (JSDoc only) --------------------------- */
/**
 * @typedef {Object} SchedulerDraft
 * @property {string} id
 * @property {"garden"} domain
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
 * @property {Array<{idx:number, label:string, estMin?:number, bed?:string, crop?:string}>} [steps]
 * @property {Object} meta
 */

/* ------------------------------ Derivers ----------------------------------- */
function normalizeGardenInput(x = {}) {
  // Supported shapes:
  // - { plan, tasks, crops, beds, plots, time, meta }
  // - seed import rows; ad-hoc task { title, action, crop, bed, ... }
  const plan = x.plan || x;
  const meta = x.meta || plan.meta || {};
  const time = x.time || {};

  // Flatten tasks; allow strings or objects
  const tasks = Array.isArray(x.tasks)
    ? x.tasks
    : Array.isArray(plan.tasks)
    ? plan.tasks
    : [];

  // Crops: [{crop:"Tomato", cultivar:"Sungold", qty:6, unit:"plants"}]
  const crops = Array.isArray(x.crops)
    ? x.crops
    : Array.isArray(plan.crops)
    ? plan.crops
    : [];

  // Beds/plots
  const beds = Array.isArray(x.beds)
    ? x.beds
    : Array.isArray(plan.beds)
    ? plan.beds
    : [];

  const plots = Array.isArray(x.plots)
    ? x.plots
    : Array.isArray(plan.plots)
    ? plan.plots
    : [];

  return {
    planId: String(plan.id || meta.planId || ""),
    sessionId: String(meta.sessionId || plan.sessionId || ""),
    title: String(plan.title || meta.title || "Garden Work"),
    sourceUrl: plan.url || plan.sourceUrl || meta.sourceUrl,
    tags: arr(plan.tags || meta.tags),
    priority: rankPriority(meta.priority || plan.priority),
    // timing
    totalMin: minutesFrom(plan.totalTime || meta.totalTime),
    // plan window
    start: firstISO(time.start, meta.start, plan.start),
    end: firstISO(time.end, meta.end, plan.end),
    planDate: firstISO(plan.planDate, meta.planDate),
    dayPart: plan.dayPart || meta.dayPart,
    slot: plan.slot || meta.slot,
    flexibilityMin: num(meta.flexibilityMin),
    // domain payloads
    tasks,
    crops,
    beds,
    plots,
    equipment: arr(plan.equipment || meta.equipment),
    consumables: arr(plan.consumables || plan.supplies || meta.consumables),
    hazards: arr(meta.hazards || plan.hazards),
    // sensitivity flags (help weather + scheduler)
    frostSensitive: meta.frostSensitive ?? inferFrostSensitive(tasks, crops),
    windSensitive: meta.windSensitive ?? inferWindSensitive(tasks),
    heavyRainSensitive:
      meta.heavyRainSensitive ?? inferHeavyRainSensitive(tasks),
  };
}

function deriveDurationMin(src) {
  if (num(src.totalMin)) return clamp(num(src.totalMin), 10, 8 * 60);
  const fromTasks = (src.tasks || []).reduce(
    (acc, t) => acc + (num(t?.estMin) || guessTaskMinutes(t)),
    0
  );
  const fromCrops = (src.crops || []).reduce(
    (acc, c) => acc + guessCropMinutes(c),
    0
  );
  const sum = fromTasks || fromCrops;
  return clamp(sum || 60, 10, 8 * 60);
}

function deriveWindow(src, durationMin) {
  const s = isISO(src.start) ? src.start : null;
  const e = isISO(src.end)
    ? src.end
    : s
    ? new Date(Date.parse(s) + durationMin * 60000).toISOString()
    : null;
  if (!s && !e) return undefined;
  return { startISO: s || undefined, endISO: e || undefined };
}

function deriveEquipment(src) {
  // Header equipment
  const head = (src.equipment || []).map((eq) => ({
    deviceId: eq?.deviceId ? String(eq.deviceId) : undefined,
    kind: eq?.kind ? String(eq.kind) : guessDeviceKind(eq?.name || eq?.title),
    title: eq?.title || eq?.name || undefined,
  }));

  // Tasks-derived (e.g., tiller, hoe, spade, shovel, rake, trellis, irrigation timer)
  const fromTasks = (src.tasks || []).flatMap((t) =>
    arr(t.equipment).map((eq) => ({
      deviceId: eq?.deviceId ? String(eq.deviceId) : undefined,
      kind: eq?.kind ? String(eq.kind) : guessDeviceKind(eq?.name || eq?.title),
      title: eq?.title || eq?.name || undefined,
    }))
  );

  const all = [...head, ...fromTasks];
  return dedupByKey(all, (e) => e.deviceId || e.kind || e.title);
}

function deriveConsumables(src) {
  // Normalize to scheduler's "ingredients" for inventory checks
  const normalize = (item) => {
    const id = String(item?.id || item?.sku || item?.name || "");
    const name = String(item?.name || "");
    const sku = item?.sku ? String(item.sku) : undefined;
    const qty = num(item?.qty || item?.quantity);
    const unit = String(item?.unit || item?.uom || "");
    return id || name
      ? {
          id: id || undefined,
          sku,
          name: name || undefined,
          qty: qty || undefined,
          unit: unit || undefined,
        }
      : null;
  };

  const head = (src.consumables || []).map(normalize).filter(Boolean);
  const fromTasks = (src.tasks || []).flatMap((t) =>
    arr(t.consumables).map(normalize).filter(Boolean)
  );
  const inferred = inferConsumablesFromTasks(src.tasks, src.crops);

  return mergeConsumables([...head, ...fromTasks, ...inferred]);
}

function deriveRoles(src) {
  // One gardener; add helper based on scope/weight
  const base = [{ role: "gardener", count: 1 }];
  const heavy = (src.tasks || []).some((t) =>
    /till|double dig|move soil|haul|mulch/i.test(String(t?.label || t))
  );
  const long = (num(src.totalMin) || 0) > 120 || (src.crops || []).length > 6;
  if (heavy || long) base.push({ role: "helper", count: 1 });
  return base;
}

function deriveSteps(src) {
  // Prefer explicit tasks
  const tasks =
    Array.isArray(src.tasks) && src.tasks.length
      ? src.tasks
      : guessTasksFromCrops(src);
  return tasks.map((t, i) => ({
    idx: i + 1,
    label: String(t?.label || t?.text || t || `Task ${i + 1}`),
    estMin: num(t?.estMin) || guessTaskMinutes(t),
    bed: t?.bed || t?.zone || undefined,
    crop: t?.crop || undefined,
  }));
}

function deriveLocation(src) {
  const names = new Set(
    (src.beds || []).map((b) => String(b?.name || "").trim()).filter(Boolean)
  );
  if (names.size)
    return `garden: ${Array.from(names).slice(0, 3).join(", ")}${
      names.size > 3 ? "…" : ""
    }`;
  return "garden";
}

/* ------------------------------- Heuristics -------------------------------- */
function inferFrostSensitive(tasks, crops) {
  const text = (
    (tasks || []).map((t) => String(t?.label || t)).join(" ") +
    " " +
    (crops || []).map((c) => c?.crop).join(" ")
  ).toLowerCase();
  return /(transplant|seed|sow|tomato|pepper|basil|cucumber|squash|melon|bean)/.test(
    text
  );
}
function inferWindSensitive(tasks) {
  return (tasks || []).some((t) =>
    /trellis|stake|prune fruit|spray/i.test(String(t?.label || t))
  );
}
function inferHeavyRainSensitive(tasks) {
  return (tasks || []).some((t) =>
    /till|double dig|apply fertilizer|spray/i.test(String(t?.label || t))
  );
}

function guessTaskMinutes(t) {
  const s = String(t?.label || t || "").toLowerCase();
  if (/till|double dig/.test(s)) return 60;
  if (/mulch|haul|compost/.test(s)) return 40;
  if (/transplant|plant|sow|seed/.test(s)) return 30;
  if (/trellis|stake|prune/.test(s)) return 25;
  if (/weed/.test(s)) return 30;
  if (/irrigat|water/.test(s)) return 20;
  if (/harvest/.test(s)) return 30;
  return 20;
}
function guessCropMinutes(c) {
  const qty = num(c?.qty) || 1;
  const crop = String(c?.crop || "").toLowerCase();
  if (/tomato|pepper|eggplant/.test(crop)) return 10 * qty;
  if (/leaf|lettuce|spinach|kale/.test(crop)) return 4 * qty;
  if (/root|carrot|beet|radish|onion|garlic/.test(crop)) return 6 * qty;
  return 5 * qty;
}

function guessTasksFromCrops(src) {
  const out = [];
  for (const c of src.crops || []) {
    const crop = String(c?.crop || "crop");
    if (/seed|sow/i.test(String(c?.action || ""))) {
      out.push({
        label: `Direct sow ${crop}`,
        crop,
        estMin: guessCropMinutes(c),
      });
    } else if (/transplant|plant/i.test(String(c?.action || ""))) {
      out.push({
        label: `Transplant ${crop}`,
        crop,
        estMin: guessCropMinutes(c),
      });
    } else {
      out.push({ label: `Tend ${crop}`, crop, estMin: guessCropMinutes(c) });
    }
  }
  if (!out.length) {
    out.push({
      label: "General garden maintenance (weed/water/inspect)",
      estMin: 45,
    });
  }
  return out;
}

function inferConsumablesFromTasks(tasks = [], crops = []) {
  const out = [];
  const text = tasks
    .map((t) => String(t?.label || t))
    .join(" ")
    .toLowerCase();
  if (/fertiliz|feed/.test(text))
    out.push({ name: "All-purpose fertilizer", qty: 1, unit: "kg" });
  if (/lime/.test(text)) out.push({ name: "Garden lime", qty: 1, unit: "kg" });
  if (/mulch/.test(text)) out.push({ name: "Mulch", qty: 3, unit: "bags" });
  if (/trellis|stake/.test(text))
    out.push({ name: "Twine / ties", qty: 1, unit: "roll" });
  if (/spray/.test(text))
    out.push({ name: "Sprayer solution", qty: 1, unit: "L" });
  // Seeds from crops
  for (const c of crops) {
    if (/sow|seed|direct/i.test(String(c?.action || ""))) {
      out.push({ name: `${c.crop} seed`, qty: 1, unit: "pkt" });
    }
  }
  return out;
}

/* ------------------------------- Helpers ----------------------------------- */
function guessDeviceKind(name) {
  const s = String(name || "").toLowerCase();
  if (/till|tiller/.test(s)) return "tiller";
  if (/hoe/.test(s)) return "hoe";
  if (/spade|shovel/.test(s)) return "spade";
  if (/rake/.test(s)) return "rake";
  if (/pruner|shear/.test(s)) return "pruner";
  if (/sprayer/.test(s)) return "sprayer";
  if (/mower|trimmer/.test(s)) return "mower";
  if (/irrigation|timer|hose|nozzle/.test(s)) return "irrigation";
  return undefined;
}

function inferNoisy(equipment, steps) {
  const kinds = new Set(
    (equipment || []).map((e) => (e.kind || "").toLowerCase())
  );
  if (kinds.has("tiller") || kinds.has("mower")) return true;
  const noisyStep = (steps || []).some((s) =>
    /till|mow|blower/i.test(String(s.label || ""))
  );
  return noisyStep;
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
      const a = num(prev.qty) || 0,
        b = num(c.qty) || 0;
      byKey.set(key, { ...prev, qty: a + b || undefined });
    } else {
      byKey.set(key, c);
    }
  }
  return Array.from(byKey.values());
}

function dedupByKey(arr, getKey) {
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    const k = getKey(it);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/* ------------------------------ eventBus I/O -------------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "adapter.garden" });
}

/* -------------------------- Hub (optional mirror) -------------------------- */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags || !featureFlags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const pkt = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(pkt);
  } catch {
    /* fail-silent */
  }
}

/* --------------------------------- Utils ----------------------------------- */
function num(n) {
  return Number.isFinite(n) ? n : Number.isFinite(+n) ? +n : undefined;
}
function minutesFrom(v) {
  if (!v && v !== 0) return undefined;
  if (Number.isFinite(v)) return v;
  const s = String(v).trim().toLowerCase();
  const iso = /^p(t(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?)$/i.exec(s);
  if (iso) {
    const h = +(iso[2] || 0),
      m = +(iso[3] || 0),
      sec = +(iso[4] || 0);
    return h * 60 + m + Math.round(sec / 60);
  }
  const hm = /(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/.exec(s);
  if (hm && (hm[1] || hm[2])) return +(hm[1] || 0) * 60 + +(hm[2] || 0);
  const n = +s;
  return Number.isFinite(n) ? n : undefined;
}
function clamp(n, lo, hi) {
  const x = Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, x));
}
function firstISO(...vals) {
  return vals.find(isISO) || undefined;
}
function isISO(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s));
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function pick(obj, keys) {
  const out = {};
  for (const k of keys)
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}
function rankPriority(v) {
  const s = String(v || "").toLowerCase();
  if (["high", "urgent", "1"].includes(s)) return "high";
  if (["low", "3"].includes(s)) return "low";
  return "normal";
}
function genId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function safeSmall(obj) {
  try {
    const s = JSON.stringify(obj);
    return s && s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

/* --------------------------------- Exports --------------------------------- */
export default {
  initGardenAdapter,
  mapGardenToSession,
};

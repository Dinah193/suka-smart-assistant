// C:\Users\larho\suka-smart-assistant\src\services\session\adapters\fromCleaning.js
// Cleaning → Scheduler Adapter
// -----------------------------------------------------------------------------
// ROLE IN PIPELINE
// imports → intelligence → automation → (optional) hub export
//            │             │            └─ this adapter converts CLEANING domain
//            │             │               objects (tasklists/routines) into a
//            │             │               scheduler-friendly session draft.
//            └─ imports from checklists, videos/how-to, or user templates
//
// What this module does
// ---------------------
// • Provides a pure function `mapCleaningToSession(input)` that normalizes a
//   cleaning job into a scheduler-ready draft.
// • Wires event handlers to:
//     - respond("adapter/cleaning/map") → returns mapped draft
//     - on("cleaning/requestSession")   → maps and emits "cleaning/draftReady"
// • Emits canonical events via eventBus; upstream bus ensures payload shape:
//     { type, ts, source, data } with ISO timestamps
// • If a session draft is produced (household data), mirrors to Hub when
//   featureFlags.familyFundMode=true (fail-silent).
//
// Design notes
// ------------
// • Forward-compatible: flexible schema with `meta` (zones, hazards, allergens,
//   sensitivity, noise profile) and domain-neutral fields (ingredients→consumables).
// • Defensive: validates input, clamps durations, adds sensible defaults.
// • Quiet-hours aware: marks noisy sessions so the scheduler can place them;
//   *does not* reschedule here—just annotates.
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
/**
 * Initialize adapter: sets up eventBus glue and RPC responder.
 */
export function initCleaningAdapter() {
  // RPC: map cleaning → session draft
  if (eventBus?.respond) {
    eventBus.respond("adapter/cleaning/map", async (payload) => {
      try {
        const draft = mapCleaningToSession(payload);
        return { ok: true, draft };
      } catch (e) {
        return { ok: false, error: String(e?.message || e) };
      }
    });
  }

  // Main glue: when cleaning engines request a session, map and emit draft
  eventBus.on(
    Events?.CLEANING_REQUEST_SESSION || "cleaning/requestSession",
    ({ data }) => {
      try {
        const draft = mapCleaningToSession(data);
        emit(Events?.CLEANING_DRAFT_READY || "cleaning/draftReady", { draft });
        // optional hub mirror (creating a draft is a household data change)
        exportToHubIfEnabled({
          type: "cleaning/draftReady",
          ts: new Date().toISOString(),
          source: "adapter.cleaning",
          data: { draft },
        });
      } catch (e) {
        emit(Events?.SESSION_ERROR || "session/error", {
          domain: "cleaning",
          error: String(e?.message || e),
          input: safeSmall(data),
        });
      }
    },
    { priority: 1 }
  );
}

/**
 * Pure adapter: Map a CLEANING source object → scheduler session draft.
 * Accepts flexible input shapes from routines/templates/imports.
 *
 * @param {object} input
 * @returns {SchedulerDraft}
 */
export function mapCleaningToSession(input = {}) {
  // 1) Normalize source (accept many shapes)
  const src = normalizeCleaningInput(input);

  // 2) Derived fields
  const durationMin = deriveDurationMin(src);
  const window = deriveWindow(src, durationMin);
  const equipment = deriveEquipment(src);
  const consumables = deriveConsumables(src);
  const rolesNeeded = deriveRoles(src);
  const steps = deriveSteps(src);
  const zones = deriveZones(src);
  const noisy = inferNoisy(equipment, steps);
  const outdoor = zones.some((z) =>
    /garage|porch|patio|deck|exterior|yard/i.test(z.name || "")
  );

  // 3) Compose scheduler draft
  /** @type {SchedulerDraft} */
  const draft = {
    id: src.sessionId || genId(),
    domain: "cleaning",
    title: buildTitle(src, zones),
    location: "household",
    outdoor,
    noisy,
    durationMin,
    flexibilityMin: src.flexibilityMin ?? 30,
    window, // { startISO?, endISO? }
    equipment, // [{ deviceId?, kind?, title? }]
    ingredients: consumables, // align with scheduler field name
    rolesNeeded, // e.g., [{ role:"cleaner", count:1 }]
    steps, // normalized steps with estimates
    meta: {
      routineId: src.routineId,
      sourceUrl: src.sourceUrl,
      allergens: src.allergens,
      tags: src.tags,
      sensitivity: src.sensitivity, // "fragranceFree"|"bleachOk"|...
      zones,
      hazards: src.hazards, // e.g., "ammonia", "bleach", "wetFloor"
      priority: src.priority,
      planContext: pick(src, ["planDate", "slot", "dayPart"]),
      quietSensitive: noisy, // hint for calendar/people device placement
    },
  };

  // 4) Minimal validation
  if (draft.durationMin <= 0)
    throw new Error("Invalid duration for cleaning draft");

  return draft;
}

/* ---------------------------- Types (JSDoc only) --------------------------- */
/**
 * @typedef {Object} SchedulerDraft
 * @property {string} id
 * @property {"cleaning"} domain
 * @property {string} title
 * @property {string} [location]
 * @property {boolean} [outdoor]
 * @property {boolean} [noisy]
 * @property {number} durationMin
 * @property {number} [flexibilityMin]
 * @property {{startISO?:string,endISO?:string}} [window]
 * @property {Array<{deviceId?:string, kind?:string, title?:string}>} [equipment
 * @property {Array<{id?:string, sku?:string, name?:string, qty?:number, unit?:string}>} [ingredients] // consumables
 * @property {Array<{role:string, count?:number}>} [rolesNeeded]
 * @property {Array<{idx:number, label:string, estMin?:number, zone?:string}>} [steps]
 * @property {Object} meta
 */

/* ------------------------------ Derivers ----------------------------------- */
function normalizeCleaningInput(x = {}) {
  // Supported shapes:
  // - { routine, checklist, time, meta }
  // - direct fields: title, zones, tasks, equipment, consumables
  const r = x.routine || x;
  const checklist = x.checklist || r.checklist || {};
  const time = x.time || {};
  const meta = x.meta || r.meta || {};

  // Flatten tasks; allow [{label, zone, estMin, equipment, consumables}] or string[]
  const tasks = Array.isArray(r.tasks)
    ? r.tasks
    : Array.isArray(checklist.tasks)
    ? checklist.tasks
    : [];

  return {
    routineId: String(r.id || meta.routineId || ""),
    sessionId: String(meta.sessionId || r.sessionId || ""),
    title: String(r.title || meta.title || "Cleaning Session"),
    sourceUrl: r.url || r.sourceUrl || meta.sourceUrl,
    tags: arr(r.tags || meta.tags),
    allergens: arr(meta.allergens || r.allergens),
    sensitivity: meta.sensitivity || "fragranceFree",
    priority: rankPriority(meta.priority || r.priority),
    // Timing
    totalMin: minutesFrom(r.totalTime || meta.totalTime),
    // plan window
    start: firstISO(time.start, meta.start),
    end: firstISO(time.end, meta.end),
    planDate: firstISO(meta.planDate),
    dayPart: meta.dayPart,
    slot: meta.slot,
    flexibilityMin: num(meta.flexibilityMin),
    // Domain payloads
    tasks,
    zones: arr(r.zones || meta.zones || checklist.zones),
    equipment: arr(r.equipment || meta.equipment),
    consumables: arr(r.consumables || r.supplies || meta.consumables),
    hazards: arr(meta.hazards || r.hazards),
  };
}

function deriveDurationMin(src) {
  if (num(src.totalMin)) return clamp(num(src.totalMin), 5, 8 * 60);
  // Otherwise sum task estimates; fallback 45
  const sum = (src.tasks || []).reduce(
    (acc, t) => acc + (num(t?.estMin) || 0),
    0
  );
  return clamp(sum || 45, 5, 8 * 60);
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
  // Normalize to { deviceId?, kind?, title? }
  const fromHeader = (src.equipment || []).map((eq) => ({
    deviceId: eq?.deviceId ? String(eq.deviceId) : undefined,
    kind: eq?.kind ? String(eq.kind) : guessDeviceKind(eq?.name || eq?.title),
    title: eq?.title || eq?.name || undefined,
  }));

  // Tasks may add equipment
  const fromTasks = (src.tasks || []).flatMap((t) =>
    arr(t.equipment).map((eq) => ({
      deviceId: eq?.deviceId ? String(eq.deviceId) : undefined,
      kind: eq?.kind ? String(eq.kind) : guessDeviceKind(eq?.name || eq?.title),
      title: eq?.title || eq?.name || undefined,
    }))
  );

  // Deduplicate by (deviceId || kind || title)
  const all = [...fromHeader, ...fromTasks];
  const unique = [];
  const seen = new Set();
  for (const e of all) {
    const key = e.deviceId || e.kind || e.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }
  return unique;
}

function deriveConsumables(src) {
  // Normalize to ingredients field name expected by scheduler; maps to inventory
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

  const fromHeader = (src.consumables || []).map(normalize).filter(Boolean);
  const fromTasks = (src.tasks || []).flatMap((t) =>
    arr(t.consumables).map(normalize).filter(Boolean)
  );
  // Dedup by id/sku/name; sum quantities when same id/sku
  const byKey = new Map();
  for (const c of [...fromHeader, ...fromTasks]) {
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

function deriveRoles(src) {
  // One cleaner, add helper if zones > 5 or duration > 2h
  const base = [{ role: "cleaner", count: 1 }];
  const zonesCount = (src.zones || []).length;
  const long = (num(src.totalMin) || 0) > 120 || zonesCount > 5;
  if (long) base.push({ role: "helper", count: 1 });
  // If hazards include bleach/ammonia → require adult
  if ((src.hazards || []).some((h) => /bleach|ammonia|acid/i.test(String(h)))) {
    base.push({ role: "adult-supervisor", count: 1 });
  }
  return base;
}

function deriveSteps(src) {
  // Prefer explicit task list
  const tasks =
    Array.isArray(src.tasks) && src.tasks.length
      ? src.tasks
      : guessTasksFromZones(src);
  return tasks.map((t, i) => ({
    idx: i + 1,
    label: String(t?.label || t?.text || t || `Task ${i + 1}`),
    estMin: num(t?.estMin),
    zone: t?.zone || undefined,
  }));
}

function deriveZones(src) {
  // Normalize zones to { name, priority?, notes? }
  const zones = (src.zones || [])
    .map((z) => ({
      name: String(z?.name || z || ""),
      priority: rankPriority(z?.priority || "normal"),
      notes: z?.notes ? String(z.notes) : undefined,
    }))
    .filter((z) => z.name);

  // Derive from tasks if empty
  if (!zones.length) {
    const names = new Set(
      (src.tasks || []).map((t) => String(t?.zone || "").trim()).filter(Boolean)
    );
    return Array.from(names).map((n) => ({ name: n, priority: "normal" }));
  }
  return zones;
}

function inferNoisy(equipment, steps) {
  const kinds = new Set(
    (equipment || []).map((e) => (e.kind || "").toLowerCase())
  );
  const noisyEq = [
    "vacuum",
    "shop-vac",
    "carpet-cleaner",
    "pressure-washer",
    "blower",
  ];
  if (noisyEq.some((k) => kinds.has(k))) return true;
  // heuristic: steps mention "vacuum", "scrub with machine"
  const noisyStep = (steps || []).some((s) =>
    /vacuum|extractor|machine scrub/i.test(String(s.label || ""))
  );
  return noisyStep;
}

/* ------------------------------- Helpers ----------------------------------- */
function guessDeviceKind(name) {
  const s = String(name || "").toLowerCase();
  if (/vac(uum)?/.test(s)) return "vacuum";
  if (/mop|steam/.test(s)) return "mop";
  if (/extractor|carpet/.test(s)) return "carpet-cleaner";
  if (/washer|pressure/.test(s)) return "pressure-washer";
  if (/squeegee|window/.test(s)) return "window-tools";
  if (/blower/.test(s)) return "blower";
  return undefined;
}

function guessTasksFromZones(src) {
  // Provide a generic workflow if tasks aren’t listed
  const zones = deriveZones(src);
  if (!zones.length)
    return [{ label: "General tidy + wipe surfaces", estMin: 20 }];
  return zones.flatMap((z) => [
    { label: `Tidy ${z.name}`, zone: z.name, estMin: 10 },
    { label: `Dust & wipe ${z.name}`, zone: z.name, estMin: 10 },
    { label: `Floors: vacuum/mop ${z.name}`, zone: z.name, estMin: 10 },
  ]);
}

function buildTitle(src, zones) {
  const base = src.title || "Cleaning Session";
  const zoneText =
    zones && zones.length
      ? ` • ${zones
          .slice(0, 3)
          .map((z) => z.name)
          .join(", ")}${zones.length > 3 ? "…" : ""}`
      : "";
  return `${base}${zoneText}`;
}

/* ------------------------------ eventBus I/O -------------------------------- */
function emit(type, data) {
  if (!eventBus?.emit) return;
  eventBus.emit(type, data, { source: "adapter.cleaning" });
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
  initCleaningAdapter,
  mapCleaningToSession,
};

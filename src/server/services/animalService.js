// C:\Users\larho\suka-smart-assistant\src\server\services\animalService.js
//
// Suka Smart Assistant — Animal Service (dynamic)
//
// Goals:
//  - Central orchestration for livestock/pets: roster, care queue, health logs,
//    breeding, feed, milking, butchering, and calendar/task bridges.
//  - Graceful optional integrations: inventoryService, calendarService, WorkerTasks
//  - Sabbath/quiet-hour awareness for scheduled events (same nudge used elsewhere).
//
// Swap the in-memory store with your DB by replacing the `store` adapter at the bottom.
//
// Exports (any you don't use can be ignored by controllers):
//   listAnimals({ userId, q?, tags? })
//   upsertAnimals(animals[])           -> insert/update (by animal.id)
//   getCareQueue({ userId, rangeDays?=3 }) -> maintenance/care queue for UI/agents
//   recordFeeding({ userId, animalId, feedSku, qty, unit, notes? })
//   recordMilking({ userId, animalId, qty, unit, notes? })
//   recordButchering({ userId, animalId, outputs:[{ sku, qty, unit, notes? }], notes? })
//   recordHealth({ userId, animalId, tempC?, weightKg?, notes?, tags?[] })
//   scheduleVetVisit({ userId, animalId, whenISO, title?, notes? })
//   suggestBreedingWindow({ species, lastHeatISO?, cycleDays?, afterISO?, slots?=3 })
//   predictDueDate({ species, bredOnISO })           // returns { dueISO, gestationDays }
//   computeFeedNeeds({ userId, days?=7 })            // herd-level estimate
//   getHistory({ userId, animalId, limit?=50 })      // mixed event log
//
//   (helpers used internally by controllers/agents but exported for convenience)
//   calendarize({ provider?, calendarId?, events:[] }) // best-effort
//   createWorkerTasks(items[])                        // best-effort
//
// Notes:
//  - All functions try/catch their optional integrations and never throw on missing deps.
//  - Timezone default: America/Chicago (configurable via GENERIC_TIMEZONE).
//

import { randomUUID as uuidv4 } from "crypto";

const DEFAULT_TZ = process.env.GENERIC_TIMEZONE || "America/Chicago";

/* ----------------------- Optional dynamic integrations ---------------------- */
let calendarService = null;
let inventoryService = null;
let WorkerTasks = null;

try {
  const mod = await import("../services/calendarService.js");
  calendarService = mod?.default || mod;
} catch {}
try {
  const mod = await import("../services/inventoryService.js");
  inventoryService = mod?.default || mod;
} catch {}
try {
  const mod = await import("../../managers/WorkerTasks.js");
  WorkerTasks = mod?.default || mod;
} catch {}

/* --------------------------------- Helpers --------------------------------- */
const DAY = 86400000;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const toISO = (d) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString());
const parseBool = (v, d=false) => (typeof v === "boolean" ? v :
  v == null ? d : ["1","true","yes","y"].includes(String(v).toLowerCase()));
const inQuietHours = (date, { start=21, end=7 } = {}) => {
  const h = date.getHours(); return start < end ? (h>=start && h<end) : (h>=start || h<end);
};
const isSabbath = (date, { avoidSabbath=true, saturdayAsSabbath=false } = {}) =>
  avoidSabbath && (saturdayAsSabbath ? date.getDay()===6 : date.getDay()===6);
function nudgeToAllowed(date, { avoidSabbath=true, saturdayAsSabbath=false, quietHours={start:21,end:7}, defaultHour=10 } = {}) {
  let d = new Date(date); let guard=0;
  while ((isSabbath(d, { avoidSabbath, saturdayAsSabbath }) || inQuietHours(d, quietHours)) && guard<14) {
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate()+1, defaultHour, 0, 0, 0); guard++;
  }
  return d;
}

/** Species defaults (can be overridden per-animal/species in future DB) */
const SPECIES = {
  cow:    { gestationDays: 283, cycleDays: 21, feedKgPerDay: 12,  milkUnit: "l"  },
  goat:   { gestationDays: 150, cycleDays: 21, feedKgPerDay: 2.5, milkUnit: "l"  },
  sheep:  { gestationDays: 152, cycleDays: 17, feedKgPerDay: 2.0, milkUnit: "l"  },
  chicken:{ gestationDays: 21,  cycleDays: 1,  feedKgPerDay: 0.12, milkUnit: null},
  pig:    { gestationDays: 115, cycleDays: 21, feedKgPerDay: 2.5, milkUnit: null},
};

/* --------------------------------- Store ----------------------------------- */
/** Minimal in-memory store; replace with DB adapter as needed. */
const store = {
  animals: new Map(), // id -> { id, name, species, sex, tags[], dobISO?, notes?, userId }
  history: new Map(), // animalId -> [{ id, tsISO, type, data }]
};

function putAnimal(animal) {
  const now = new Date();
  const existing = store.animals.get(animal.id);
  const merged = { ...existing, ...animal, updatedAt: now.toISOString(), createdAt: existing?.createdAt || now.toISOString() };
  store.animals.set(merged.id, merged);
  return merged;
}

function addHistory(animalId, type, data) {
  const arr = store.history.get(animalId) || [];
  const evt = { id: uuidv4(), tsISO: new Date().toISOString(), type, data };
  arr.unshift(evt); // newest first
  store.history.set(animalId, arr);
  return evt;
}

/* ------------------------------ Core functions ----------------------------- */

/** List animals with optional text/tags filter */
export async function listAnimals({ userId, q, tags } = {}) {
  const all = [...store.animals.values()].filter(a => !userId || a.userId === userId);
  const byQ = q ? all.filter(a =>
    (a.name||"").toLowerCase().includes(q.toLowerCase()) ||
    (a.species||"").toLowerCase().includes(q.toLowerCase()) ||
    (a.tags||[]).some(t => t.toLowerCase().includes(q.toLowerCase()))
  ) : all;
  const byTags = Array.isArray(tags) && tags.length ? byQ.filter(a => (a.tags||[]).some(t => tags.includes(t))) : byQ;
  return byTags;
}

/** Upsert 1..N animals */
export async function upsertAnimals(animals=[]) {
  const arr = Array.isArray(animals) ? animals : [animals];
  const saved = arr.map(a => putAnimal({ id: a.id || uuidv4(), ...a }));
  return saved;
}

/** Mixed log history */
export async function getHistory({ userId, animalId, limit = 50 }) {
  const check = store.animals.get(animalId);
  if (userId && check && check.userId !== userId) return [];
  return (store.history.get(animalId) || []).slice(0, clamp(limit, 1, 500));
}

/** Generate care queue for UI/agents (feed, water, clean, health checks, milk) */
export async function getCareQueue({ userId, rangeDays = 3 } = {}) {
  const now = new Date();
  const horizon = new Date(now.getTime() + clamp(rangeDays, 1, 14)*DAY);
  const items = [];

  for (const a of store.animals.values()) {
    if (userId && a.userId !== userId) continue;
    const base = { animalId: a.id, name: a.name, species: a.species, priority: "medium", source: "animal" };

    // Daily feed
    items.push({
      ...base, icon: "🪵", task: `Feed ${a.name || a.species}`, recommendedRole: "farm hand",
      requiredSkills: ["animal care","feeding"], due: toISO(now)
    });

    // Water check
    items.push({
      ...base, icon: "💧", task: `Check water for ${a.name || a.species}`, recommendedRole: "farm hand",
      requiredSkills: ["animal care"], due: toISO(now)
    });

    // Milking (species with milk)
    if (SPECIES[a.species]?.milkUnit && (a.tags||[]).includes("lactating")) {
      items.push({
        ...base, icon: "🥛", task: `Milk ${a.name}`, recommendedRole: "milker",
        requiredSkills: ["milking","sanitation"], due: toISO(now)
      });
    }

    // Breeding due date reminder
    const hist = store.history.get(a.id) || [];
    const bredEvt = hist.find(h => h.type === "breeding");
    if (bredEvt) {
      const gest = getGestationDays(a.species);
      const due = new Date(new Date(bredEvt.data.bredOnISO).getTime() + gest*DAY);
      if (due <= horizon) {
        items.push({
          ...base, icon: "🐣", task: `Due soon: ${a.name} (${a.species})`, recommendedRole: "farm hand",
          requiredSkills: ["birthing assistance"], due: toISO(due), priority: "high"
        });
      }
    }

    // Clean stall/coop every 3 days (simple cadence)
    items.push({
      ...base, icon: "🧹", task: `Clean stall/coop for ${a.name || a.species}`, recommendedRole: "gardener",
      requiredSkills: ["cleaning","sanitation"], due: toISO(new Date(now.getTime() + 3*DAY))
    });
  }

  return items;
}

/** Feeding: consume inventory; log event */
export async function recordFeeding({ userId, animalId, feedSku, qty, unit, notes }) {
  const a = store.animals.get(animalId);
  if (!a) throw new Error("Animal not found");

  let receipt = null;
  if (inventoryService?.applyDelta) {
    try {
      receipt = await inventoryService.applyDelta({
        userId, sku: String(feedSku), qty: -Math.abs(qty), unit: String(unit),
        reason: "consume", location: "barn",
        meta: { source: "animal.feeding", animalId, notes }
      });
    } catch {}
  }
  const evt = addHistory(animalId, "feeding", { feedSku, qty, unit, notes, inventoryReceipt: receipt });
  return { ok: true, event: evt, inventory: receipt };
}

/** Milking: add inventory (milk); log event */
export async function recordMilking({ userId, animalId, qty, unit, notes }) {
  const a = store.animals.get(animalId);
  if (!a) throw new Error("Animal not found");
  const milkSku = `milk-${a.species || "unknown"}`;

  let receipt = null;
  if (inventoryService?.applyDelta) {
    try {
      receipt = await inventoryService.applyDelta({
        userId, sku: milkSku, qty: Math.abs(qty), unit: String(unit || SPECIES[a.species]?.milkUnit || "l"),
        reason: "add", location: "fridge",
        meta: { source: "animal.milking", animalId, notes }
      });
    } catch {}
  }
  const evt = addHistory(animalId, "milking", { qty, unit: unit || SPECIES[a.species]?.milkUnit || "l", notes, inventoryReceipt: receipt });
  return { ok: true, event: evt, inventory: receipt };
}

/** Butchering: add multiple outputs; log event; spawn tasks (wrap/label/freeze) */
export async function recordButchering({ userId, animalId, outputs = [], notes }) {
  const a = store.animals.get(animalId);
  if (!a) throw new Error("Animal not found");

  const receipts = [];
  if (inventoryService?.applyDeltas || inventoryService?.applyDelta) {
    try {
      if (inventoryService.applyDeltas) {
        receipts.push(
          ...(await inventoryService.applyDeltas(
            outputs.map(o => ({
              userId, sku: String(o.sku), qty: Math.abs(o.qty), unit: String(o.unit),
              reason: "add", location: "freezer",
              meta: { source: "animal.butchering", animalId, notes: o.notes || notes }
            }))
          ))
        );
      } else {
        for (const o of outputs) {
          receipts.push(await inventoryService.applyDelta({
            userId, sku: String(o.sku), qty: Math.abs(o.qty), unit: String(o.unit),
            reason: "add", location: "freezer",
            meta: { source: "animal.butchering", animalId, notes: o.notes || notes }
          }));
        }
      }
    } catch {}
  }

  const evt = addHistory(animalId, "butchering", { outputs, notes, inventoryReceipts: receipts });

  // Optional WorkerTasks to wrap/label
  const created = [];
  if (WorkerTasks?.assignTaskToWorker) {
    try {
      const t = {
        id: `wrap-${animalId}-${Date.now()}`,
        name: `Wrap/label ${a.name || a.species} cuts`,
        task: `Wrap, label, and freeze packages (${outputs.map(o=>o.sku).join(", ")}).`,
        source: "animal",
        requiredSkills: ["butcher","labeling","freezer-org"],
        priorityScore: 80,
        metadata: { animalId }
      };
      created.push(await WorkerTasks.assignTaskToWorker({ taskId: t.id, task: t, role: "butcher" }));
    } catch {}
  }

  return { ok: true, event: evt, inventory: receipts, tasks: created };
}

/** Generic health entry */
export async function recordHealth({ userId, animalId, tempC, weightKg, notes, tags = [] }) {
  const a = store.animals.get(animalId);
  if (!a) throw new Error("Animal not found");
  const data = { userId, tempC, weightKg, notes, tags };
  const evt = addHistory(animalId, "health", data);
  return { ok: true, event: evt };
}

/** Schedule vet visit via calendarService (Sabbath/quiet-aware) */
export async function scheduleVetVisit({ userId, animalId, whenISO, title, notes, sabbathAware = true, saturdayAsSabbath = false }) {
  const a = store.animals.get(animalId);
  if (!a) throw new Error("Animal not found");
  if (!calendarService?.createEvent && !calendarService?.createEventsBatch) {
    return { ok: false, error: "calendarService not available" };
  }
  const start = sabbathAware ? nudgeToAllowed(new Date(whenISO)) : new Date(whenISO);
  const end = new Date(start.getTime() + 60 * 60_000);
  const ev = {
    title: title || `Vet: ${a.name || a.species}`,
    description: notes || "",
    start: toISO(start),
    end: toISO(end),
    timezone: DEFAULT_TZ,
    metadata: { source: "animal.vet", animalId, userId }
  };
  try {
    let result;
    if (calendarService.createEventsBatch) {
      result = await calendarService.createEventsBatch({ provider: "local", calendarId: "household", events: [ev], upsert: true });
    } else {
      result = await calendarService.createEvent({ provider: "local", calendarId: "household", data: ev, upsert: true });
    }
    return { ok: true, event: result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Breeding helpers */
function getGestationDays(species) { return SPECIES[species]?.gestationDays || 150; }
function getCycleDays(species)     { return SPECIES[species]?.cycleDays || 21; }

export async function suggestBreedingWindow({ species, lastHeatISO, cycleDays, afterISO, slots = 3 } = {}) {
  const cd = Number(cycleDays) || getCycleDays(species) || 21;
  const start = new Date(afterISO || lastHeatISO || new Date());
  const picks = [];
  let cursor = new Date(start);
  for (let i=0; i<slots; i++) {
    cursor = new Date(cursor.getTime() + cd*DAY);
    // heuristic: peak fertility ~ day 0-1 around heat
    const s = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate(), 6, 0, 0, 0);
    const e = new Date(s.getTime() + 24*60*60_000);
    picks.push({ start: toISO(s), end: toISO(e) });
  }
  return { ok: true, windows: picks, meta: { species, cycleDays: cd } };
}

export async function predictDueDate({ species, bredOnISO }) {
  const gest = getGestationDays(species);
  const due = new Date(new Date(bredOnISO).getTime() + gest*DAY);
  return { ok: true, dueISO: toISO(due), gestationDays: gest };
}

/** Compute herd feed needs for N days (rough estimate) */
export async function computeFeedNeeds({ userId, days = 7 } = {}) {
  const nDays = clamp(days, 1, 60);
  const animals = [...store.animals.values()].filter(a => !userId || a.userId === userId);
  const bySpecies = {};
  for (const a of animals) {
    const f = SPECIES[a.species]?.feedKgPerDay || 1.0;
    bySpecies[a.species] = (bySpecies[a.species] || 0) + f * nDays;
  }
  return { ok: true, days: nDays, bySpecies, totalKg: Object.values(bySpecies).reduce((s,x)=>s+x,0) };
}

/* ------------------------ Bridges: calendar & tasks ------------------------ */

export async function calendarize({
  provider = "local",
  calendarId = "household",
  events = [],
  sabbathAware = true,
  saturdayAsSabbath = false,
  quietHours = { start: 21, end: 7 },
  defaultHour = 10
} = {}) {
  if (!calendarService?.createEventsBatch && !calendarService?.createEvent) {
    return { ok: false, error: "calendarService not available" };
  }
  const norm = events.map((e, i) => {
    const s = sabbathAware ? nudgeToAllowed(new Date(e.start), { avoidSabbath: true, saturdayAsSabbath, quietHours, defaultHour }) : new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(s.getTime() + 60*60_000);
    return {
      title: e.title || `Animal Event #${i+1}`,
      description: e.description || "",
      start: toISO(s),
      end: toISO(end),
      timezone: DEFAULT_TZ,
      allDay: false,
      location: e.location || "",
      reminders: e.reminders || [{ minutes: 10, method: "popup" }],
      metadata: { source: "animal", ...(e.metadata || {}) },
      externalId: e.externalId || `animal-${s.toISOString()}-${i}`
    };
  });
  try {
    let result;
    if (calendarService.createEventsBatch) {
      result = await calendarService.createEventsBatch({ provider, calendarId, events: norm, upsert: true });
    } else {
      result = [];
      for (const ev of norm) result.push(await calendarService.createEvent({ provider, calendarId, data: ev, upsert: true }));
    }
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function createWorkerTasks(items = []) {
  if (!WorkerTasks?.assignTaskToWorker) return { ok: false, error: "WorkerTasks not available" };
  const created = [];
  for (const it of items) {
    try {
      created.push(await WorkerTasks.assignTaskToWorker({
        taskId: it.id || `animal-${Date.now()}`,
        task: {
          id: it.id, name: it.name, task: it.task,
          source: it.source || "animal",
          requiredSkills: it.requiredSkills || ["animal care"],
          priorityScore: it.priorityScore || 60,
          metadata: it.metadata || {}
        },
        role: it.role || "farm hand"
      }));
    } catch {}
  }
  return { ok: true, created };
}

/* --------------------------------- Seeds ----------------------------------- */
// Optional: small seeding hook so UI has something to show during dev
if (process.env.NODE_ENV !== "production" && store.animals.size === 0) {
  const seed = [
    { id: uuidv4(), name: "Daisy", species: "cow", userId: "demo", tags: ["lactating"], notes: "Gentle" },
    { id: uuidv4(), name: "Maple", species: "goat", userId: "demo", tags: ["lactating"] },
    { id: uuidv4(), name: "Chirpy", species: "chicken", userId: "demo", tags: ["layer"] },
  ];
  for (const a of seed) putAnimal(a);
}

/* --------------------------------- Adapter --------------------------------- */
// If you later add a DB, replace above store helpers with your repository.
// Keep function signatures stable so controllers/n8n flows continue to work.

export default {
  listAnimals,
  upsertAnimals,
  getCareQueue,
  recordFeeding,
  recordMilking,
  recordButchering,
  recordHealth,
  scheduleVetVisit,
  suggestBreedingWindow,
  predictDueDate,
  computeFeedNeeds,
  getHistory,
  calendarize,
  createWorkerTasks
};

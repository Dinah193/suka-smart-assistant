// C:\Users\larho\suka-smart-assistant\src\store\AnimalStore.js
/**
 * AnimalStore (dynamic, agent- & Sabbath-aware)
 * ---------------------------------------------
 * Central state + utilities for household animal care.
 *
 * Goals this serves:
 * - Provide a single source of truth for animals, feed schedules, and care logs
 * - Integrate softly with: DexieDB, animalAgent, inventoryAgent, n8n, sockets
 * - Emit domain events the orchestrator/rules can react to (see shared/ontology EVENTS)
 * - Sabbath-aware: avoid scheduling non-essential tasks during Sabbath
 * - Works offline; gracefully falls back when a dependency is missing
 *
 * Tables expected in Dexie (best-effort; will no-op if missing):
 *  - animals:         { id, name, species, breed?, count, notes?, active, createdAtISO, updatedAtISO, meta? }
 *  - animalLogs:      { id, animalId, type: 'feed'|'water'|'clean'|'health'|'misc', atISO, qty?, unit?, notes?, meta? }
 *  - feedPlans:       { id, animalId, schedule: { times: ['07:00','18:00'], qty: { value, unit } }, feedKey?, notes?, active }
 *
 * Public API:
 *  - init()
 *  - listAnimals({ active? })
 *  - getAnimal(id)
 *  - upsertAnimal(data)
 *  - archiveAnimal(id)
 *  - getFeedPlan(animalId) / setFeedPlan(animalId, plan)
 *  - recordLog({ animalId, type, qty?, unit?, notes?, meta? })
 *  - recordFeeding({ animalId, qty, unit, notes? })
 *  - computeDailyFeedNeeds({ date?, includeInactive? }) => [{ animalId, need: {value,unit}, feedKey? }]
 *  - syncInventoryReservations(needs)
 *  - todaysReminders({ now? }) => [{ atISO, label, animalId, type }]
 *  - subscribe(fn) / unsubscribe(fn)
 */

import DexieDB from "@/db";
import { v4 as uuidv4 } from "uuid";

// -------------------- Safe dynamic imports --------------------
async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      // @vite-ignore
      const mod = await import(p);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}
function safeNowISO() { return new Date().toISOString(); }
function toISODate(d = new Date()) { const x = new Date(d); x.setHours(0,0,0,0); return x.toISOString(); }

let EVENTS = {};
(async () => {
  const ont = await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
  EVENTS = ont?.EVENTS || {};
})();

function safeGetSocket() {
  try {
    // eslint-disable-next-line import/no-unresolved
    const sock = require("@/server/services/socket");
    return sock?.socket || sock?.getSocket?.() || null;
  } catch { return null; }
}

// Sabbath helper (use ontology.sabbath if available)
async function isSabbath(now = new Date()) {
  try {
    const ont = await safeImportMany(["@/shared/ontology.js", "@/shared/ontology"]);
    const win = ont?.sabbath?.(now);
    if (win?.startISO && win?.endISO) {
      return now >= new Date(win.startISO) && now < new Date(win.endISO);
    }
  } catch {}
  // Fallback Fri 18:00 → Sat 18:00
  const day = now.getDay();
  const fri18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((5 - day + 7) % 7), 18, 0, 0, 0);
  const sat18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((6 - day + 7) % 7), 18, 0, 0, 0);
  return now >= fri18 && now < sat18;
}

// -------------------- Minimal in-memory event hub --------------------
const _subs = new Set();
function emit(event, payload) {
  for (const fn of _subs) {
    try { fn(event, payload); } catch {}
  }
  // Broadcast to window + socket if present
  try { window.dispatchEvent?.(new CustomEvent(event, { detail: payload })); } catch {}
  try { safeGetSocket()?.emit?.(event, payload); } catch {}
}

// -------------------- Internal helpers --------------------
function parseTimeToToday(timeHHMM, base = new Date()) {
  const [hh, mm] = String(timeHHMM || "07:00").split(":").map(Number);
  const d = new Date(base);
  d.setHours(hh || 0, mm || 0, 0, 0);
  return d;
}

function qtyToString(q) {
  if (!q || q.value == null) return "";
  const v = Number(q.value);
  const u = q.unit || "";
  if (!isFinite(v)) return "";
  return `${v}${u ? ` ${u}` : ""}`;
}

// -------------------- Inventory sync (best-effort) --------------------
async function syncInventoryReservations(needs = [], { reason = "animal-feed" } = {}) {
  const inv = await safeImportMany(["@/agents/inventoryAgent.js", "@/agents/inventoryAgent"]);
  if (!inv?.handleCommand) return { ok: false, error: "inventoryAgent not available" };
  try {
    await inv.handleCommand("reserveItems", {
      lines: needs
        .filter((n) => n?.need?.value > 0 && n.feedKey)
        .map((n) => ({
          key: n.feedKey,
          qty: n.need.value,
          unit: n.need.unit || "g",
          reason,
          meta: { animalId: n.animalId, date: toISODate(new Date()) },
        })),
    });
    emit("inventory:delta", { at: safeNowISO(), reason, needs });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

// -------------------- n8n notifier (optional) --------------------
async function notifyN8n(event, payload) {
  const n8n = await safeImportMany(["@/services/n8nClient.js", "@/services/n8nClient"]);
  try {
    await n8n?.runWorkflowByName?.("Suka: Animal Event", { event, payload }, {
      idempotencyKey: `${event}:${payload?.animalId || ""}:${payload?.atISO || ""}`,
    });
  } catch {}
}

// -------------------- Core Store --------------------
const AnimalStore = {
  async init() {
    // Optionally warm any caches / migrate data later
    emit("animals:init", { at: safeNowISO() });
    return true;
  },

  /* ---------- Query ---------- */
  async listAnimals({ active = true } = {}) {
    try {
      let all = await DexieDB.animals.toArray();
      if (active != null) all = all.filter((a) => !!a.active === !!active);
      // sort by name asc
      return all.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    } catch {
      return [];
    }
  },

  async getAnimal(id) {
    try {
      return await DexieDB.animals.get(id);
    } catch {
      return null;
    }
  },

  /* ---------- Upsert / Archive ---------- */
  async upsertAnimal(data) {
    const id = data.id || uuidv4();
    const base = {
      id,
      name: data.name || "Unnamed",
      species: data.species || "animal",
      breed: data.breed || null,
      count: Number(data.count ?? 1) || 1,
      notes: data.notes || "",
      active: data.active !== false,
      meta: data.meta || {},
      updatedAtISO: safeNowISO(),
    };
    if (!data.id) base.createdAtISO = base.updatedAtISO;

    try {
      await DexieDB.animals.put(base);
      emit("animals:changed", { id, op: "upsert", item: base });
      notifyN8n("animal.upsert", { animalId: id, species: base.species }).catch(() => {});
      return base;
    } catch (e) {
      return null;
    }
  },

  async archiveAnimal(id) {
    try {
      const a = await DexieDB.animals.get(id);
      if (!a) return false;
      a.active = false;
      a.updatedAtISO = safeNowISO();
      await DexieDB.animals.put(a);
      emit("animals:changed", { id, op: "archive" });
      notifyN8n("animal.archive", { animalId: id }).catch(() => {});
      return true;
    } catch {
      return false;
    }
  },

  /* ---------- Feed Plans ---------- */
  async getFeedPlan(animalId) {
    try {
      return await DexieDB.feedPlans.get(animalId);
    } catch {
      return null;
    }
  },

  /**
   * plan = {
   *   schedule: { times: ['07:00','18:00'], qty: { value, unit: 'g' } },
   *   feedKey?: 'feed.chicken.layer',
   *   notes?: string,
   *   active?: boolean
   * }
   */
  async setFeedPlan(animalId, plan = {}) {
    const doc = {
      id: animalId,
      animalId,
      schedule: plan.schedule || { times: ["07:00", "18:00"], qty: { value: 120, unit: "g" } },
      feedKey: plan.feedKey || null,
      notes: plan.notes || "",
      active: plan.active !== false,
      updatedAtISO: safeNowISO(),
    };
    try {
      await DexieDB.feedPlans.put(doc);
      emit("animals:feedPlan:changed", { animalId, doc });
      notifyN8n("animal.feedPlan.set", { animalId, schedule: doc.schedule }).catch(() => {});
      return doc;
    } catch {
      return null;
    }
  },

  /* ---------- Logs ---------- */
  async recordLog({ animalId, type, qty = null, unit = null, notes = "", meta = {} }) {
    const log = {
      id: uuidv4(),
      animalId,
      type, // 'feed'|'water'|'clean'|'health'|'misc'
      atISO: safeNowISO(),
      qty: qty != null ? Number(qty) : null,
      unit: unit || null,
      notes,
      meta,
    };
    try {
      await DexieDB.animalLogs.put(log);
      emit("animals:log", log);
      notifyN8n("animal.log", log).catch(() => {});
      // Orchestrator hint for cleanliness/feeding milestones
      if (type === "clean") {
        safeGetSocket()?.emit?.(EVENTS?.SESSION?.FINISHED?.CLEANING || "SESSION.FINISHED.CLEANING", { at: log.atISO, from: "animal-clean" });
      }
      return log;
    } catch {
      return null;
    }
  },

  async recordFeeding({ animalId, qty, unit = "g", notes = "" }) {
    const log = await this.recordLog({ animalId, type: "feed", qty, unit, notes });
    // Optionally deduct from inventory immediately if feedKey known
    try {
      const plan = await this.getFeedPlan(animalId);
      if (plan?.feedKey && qty > 0) {
        const inv = await safeImportMany(["@/agents/inventoryAgent.js", "@/agents/inventoryAgent"]);
        await inv?.handleCommand?.("deductItems", {
          lines: [{ key: plan.feedKey, qty, unit, reason: "animal-feed", meta: { animalId } }],
        });
        emit("inventory:delta", { at: safeNowISO(), reason: "animal-feed", lines: [{ key: plan.feedKey, qty, unit }] });
      }
    } catch {}
    return log;
  },

  /* ---------- Computations ---------- */
  /**
   * Compute daily feed needs for active animals (sum of plan qty * times).
   * Returns [{ animalId, need: {value,unit}, feedKey? }]
   */
  async computeDailyFeedNeeds({ date = new Date(), includeInactive = false } = {}) {
    let animals = await this.listAnimals({ active: !includeInactive });
    const out = [];
    for (const a of animals) {
      const plan = await this.getFeedPlan(a.id);
      if (!plan || plan.active === false) continue;
      const times = plan.schedule?.times || [];
      const qty = plan.schedule?.qty || { value: 0, unit: "g" };
      const total = Number(qty.value || 0) * Math.max(1, times.length);
      out.push({ animalId: a.id, need: { value: total, unit: qty.unit || "g" }, feedKey: plan.feedKey || null });
    }
    return out;
  },

  /**
   * Generate simple reminders for today's feed/water/clean tasks.
   * Sabbath-aware: on Sabbath, only include essential tasks (feed/water).
   */
  async todaysReminders({ now = new Date() } = {}) {
    const sabbath = await isSabbath(now);
    const animals = await this.listAnimals({ active: true });
    const reminders = [];
    for (const a of animals) {
      const plan = await this.getFeedPlan(a.id);
      const times = plan?.schedule?.times || ["07:00", "18:00"];
      for (const t of times) {
        const when = parseTimeToToday(t, now);
        reminders.push({
          atISO: when.toISOString(),
          label: `Feed ${a.name} (${qtyToString(plan?.schedule?.qty)})`,
          animalId: a.id,
          type: "feed",
          essential: true,
        });
      }
      if (!sabbath) {
        // Non-essential reminders (clean/housing check) skipped on Sabbath
        reminders.push({
          atISO: parseTimeToToday("15:00", now).toISOString(),
          label: `Check housing for ${a.name}`,
          animalId: a.id,
          type: "clean-check",
          essential: false,
        });
      }
    }
    // Sort by time
    reminders.sort((x, y) => new Date(x.atISO) - new Date(y.atISO));
    return reminders;
  },

  /* ---------- Side-effect helpers ---------- */
  /**
   * Reserve feed for tomorrow (call nightly). Sabbath-aware: if tomorrow is Sabbath,
   * only reserve essential feed, and skip non-essential supplies.
   */
  async reserveTomorrowFeed() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const sabbathTomorrow = await isSabbath(tomorrow);
    const needs = await this.computeDailyFeedNeeds({});
    const essentialNeeds = sabbathTomorrow ? needs : needs; // all feed is essential
    return syncInventoryReservations(essentialNeeds, { reason: "animal-feed:tomorrow" });
  },

  /* ---------- Subscribe ---------- */
  subscribe(fn) { _subs.add(fn); return () => _subs.delete(fn); },
  unsubscribe(fn) { _subs.delete(fn); },

  /* ---------- Utilities exposed ---------- */
  syncInventoryReservations,
};

export default AnimalStore;

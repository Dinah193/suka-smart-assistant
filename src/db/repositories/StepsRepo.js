// C:\Users\larho\suka-smart-assistant\src\db\repositories\StepsRepo.js
/* eslint-disable no-console */

/**
 * StepsRepo
 * -----------------------------------------------------------------------------
 * Role in pipeline:
 * - Imports → Intelligence → Automation → (optional) Hub export
 * - Steps are the atomic, actionable units that make up a Session (cooking,
 *   cleaning, garden, animal, preservation, storehouse). Engines synthesize
 *   steps from imports/recipes/plans; automation schedules & executes them.
 * - This repo persists, queries, and mutates step records. Any mutation emits
 *   { type, ts, source, data } events via the shared eventBus so runtimes
 *   (timers, schedulers, UI overlays) respond immediately. If familyFundMode
 *   is ON, changes are optionally formatted & forwarded to the Hub (best-effort).
 *
 * Design goals:
 * - Defensive & domain-agnostic schema
 * - Efficient: batch operations, reorder, partial patch, common status helpers
 * - Forward-thinking: extensible fields (doneness/aromatics/equipment/mediaRefs)
 */

let db = null;
try {
  // Expect a Dexie instance with a "steps" table (and optional "sessions").
  const mod = require("@/db");
  db = mod?.default || mod?.db || mod;
} catch {}

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {}

let featureFlags = { familyFundMode: false };
try {
  featureFlags = require("@/config/featureFlags.json");
} catch {}

let HubPacketFormatter = null;
try {
  const mod = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = mod?.default || mod;
} catch {}

let FamilyFundConnector = null;
try {
  const mod = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = mod?.default || mod;
} catch {}

const SOURCE = "db/StepsRepo";

/* ----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function isoNow() {
  return new Date().toISOString();
}

function uuid(prefix = "step") {
  try {
    return globalThis?.crypto?.randomUUID?.() || `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  } catch {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function emit(type, data) {
  try {
    eventBus.emit({ type, ts: isoNow(), source: SOURCE, data });
  } catch (err) {
    console.warn("[StepsRepo] event emit failed:", err);
  }
}

/**
 * Optional Hub export (silent fail). Only called for mutating operations.
 */
async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode || !HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.formatStepChange?.(payload) || payload;
    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    console.warn("[StepsRepo] Hub export failed (silent):", err?.message || err);
  }
}

/**
 * Dexie guards
 */
function ensureDB() {
  if (!db || typeof db !== "object" || !db.steps) {
    throw new Error("Dexie 'db.steps' table not available. Ensure '@/db' exports a Dexie with a 'steps' table.");
  }
}

/**
 * Normalize a step record into a safe, domain-agnostic shape.
 * Notes:
 *  - position is sortable within a sessionId (float ok for reordering gaps)
 *  - status: draft | queued | ready | in_progress | paused | completed | skipped | canceled | failed
 */
function normalizeStep(input = {}) {
  if (!input || typeof input !== "object") return { ok: false, error: "Invalid step payload." };

  const now = isoNow();
  const allowedStatuses = new Set([
    "draft",
    "queued",
    "ready",
    "in_progress",
    "paused",
    "completed",
    "skipped",
    "canceled",
    "failed",
  ]);

  const record = {
    id: input.id || uuid(),
    sessionId: input.sessionId || null, // required for most flows; but repo tolerates null for drafts
    domain: String(input.domain || "").trim() || "general",

    // Ordering within session
    position: typeof input.position === "number" ? input.position : Number(input.position) || 0,

    title: String(input.title || "").trim() || "Untitled Step",
    description: String(input.description || "").trim() || "",
    status: allowedStatuses.has(input.status) ? input.status : "draft",

    // Timing & schedule
    planned: {
      // expected durations in seconds (or ms if you prefer—keep consistent app-wide)
      durationSec: Number(input?.planned?.durationSec) || 0,
      earliestStart: input?.planned?.earliestStart || null, // ISO
      latestFinish: input?.planned?.latestFinish || null,   // ISO
    },

    actual: {
      startedAt: input?.actual?.startedAt || null, // ISO
      endedAt: input?.actual?.endedAt || null,     // ISO
      durationSec: Number(input?.actual?.durationSec) || 0,
      pauseCount: Number(input?.actual?.pauseCount) || 0,
    },

    // Dependencies & effects
    prerequisites: Array.isArray(input.prerequisites) ? input.prerequisites : [], // [stepId]
    inventoryEffects: Array.isArray(input.inventoryEffects) ? input.inventoryEffects : [], // [{ itemId, delta, reason }]
    equipment: Array.isArray(input.equipment) ? input.equipment : [], // ["sheet-pan", "6qt-pot"]

    // Cooking/cleaning specifics (extensible)
    parameters: {
      temperature: input?.parameters?.temperature ?? null, // e.g., 375F / 190C or "medium-high"
      doneness: input?.parameters?.doneness ?? null,       // user pref snapshot (e.g., "medium-rare", "streak-free glass")
      aromatics: Array.isArray(input?.parameters?.aromatics) ? input.parameters.aromatics : [], // ["lemon", "eucalyptus"]
      targetVisuals: Array.isArray(input?.parameters?.targetVisuals) ? input.parameters.targetVisuals : [], // ["golden-brown", "streak-free"]
      moisture: input?.parameters?.moisture ?? null,       // garden/animals/cleaning step control
    },

    // Hints / media
    hints: Array.isArray(input.hints) ? input.hints : [], // ["preheat oven 10min early", "start pot to boil 8min early"]
    mediaRefs: Array.isArray(input.mediaRefs) ? input.mediaRefs : [], // [{type:"image"|"video", url, atSec?}]

    // Task timers & alerts
    timer: {
      // ephemeral UI timer suggestion: countdownSec, alertAt, recurringChimeSec
      countdownSec: Number(input?.timer?.countdownSec) || 0,
      alertAt: input?.timer?.alertAt || null, // ISO
      recurringChimeSec: Number(input?.timer?.recurringChimeSec) || 0,
    },

    // Meta & links
    createdAt: input.createdAt || now,
    updatedAt: now,
    householdId: input.householdId || null,
    origin: input.origin || null, // engine, import url, user action, etc.
    metadata: input.metadata && typeof input.metadata === "object" ? input.metadata : {},
  };

  if (!record.sessionId) {
    // We allow drafts without sessionId; engines can attach later.
    // But warn here for developer visibility (not fatal).
    // console.warn("[StepsRepo.normalize] Missing sessionId for step:", record.id);
  }

  return { ok: true, record };
}

/* ----------------------------------------------------------------------------
 * Repo
 * -------------------------------------------------------------------------- */

const StepsRepo = {
  /**
   * create(step)
   * Inserts a new step.
   */
  async create(step) {
    ensureDB();
    const res = normalizeStep(step);
    if (!res.ok) return { ok: false, error: res.error };

    const record = res.record;
    try {
      await db.steps.put(record);
      const payload = { action: "create", step: record };
      emit("step.created", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: record };
    } catch (err) {
      console.error("[StepsRepo.create] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * bulkCreate(steps[])
   * Efficient multi-insert.
   */
  async bulkCreate(list = []) {
    ensureDB();
    if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "Nothing to create." };
    const ready = [];
    for (const s of list) {
      const res = normalizeStep(s);
      if (res.ok) ready.push(res.record);
    }
    if (!ready.length) return { ok: false, error: "No valid steps." };

    try {
      const ids = await db.steps.bulkPut(ready);
      const payload = { action: "bulkCreate", count: ready.length, steps: ready.map(s => s.id) };
      emit("step.bulk_created", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: Array.isArray(ids) ? ids : ready.map(s => s.id) };
    } catch (err) {
      console.error("[StepsRepo.bulkCreate] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * getById(id)
   */
  async getById(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };
    try {
      const row = await db.steps.get(id);
      return row ? { ok: true, data: row } : { ok: false, error: "Not found." };
    } catch (err) {
      console.error("[StepsRepo.getById] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * list(filters)
   * - Supports filters: sessionId, domain, status, from, to, limit, offset, sortBy, sortDir
   */
  async list(opts = {}) {
    ensureDB();
    const {
      sessionId = null,
      domain = null,
      status = null,
      from = null, // createdAt lower bound
      to = null,   // createdAt upper bound
      limit = 200,
      offset = 0,
      sortBy = "position", // sensible within session
      sortDir = "asc",
    } = opts;

    try {
      let coll = db.steps.toCollection();

      if (sessionId) {
        coll = coll.and(s => s.sessionId === sessionId);
      }
      if (domain) {
        coll = coll.and(s => s.domain === domain);
      }
      if (status) {
        const set = Array.isArray(status) ? new Set(status) : new Set([status]);
        coll = coll.and(s => set.has(s.status));
      }
      if (from) {
        coll = coll.and(s => (s.createdAt || "") >= from);
      }
      if (to) {
        coll = coll.and(s => (s.createdAt || "") < to);
      }

      const dir = sortDir === "asc" ? 1 : -1;
      const arr = await coll.sortBy(sortBy).then(a => (dir === 1 ? a : a.reverse()));
      const slice = arr.slice(offset, offset + limit);

      return { ok: true, data: { total: arr.length, items: slice, offset, limit } };
    } catch (err) {
      console.error("[StepsRepo.list] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * bySession(sessionId)
   */
  async bySession(sessionId, opts = {}) {
    return this.list({ ...opts, sessionId });
  },

  /**
   * update(id, next)
   * Full replace (with normalization), retaining id & createdAt.
   */
  async update(id, next) {
    ensureDB();
    if (!id || !next || typeof next !== "object") return { ok: false, error: "Invalid update payload." };

    const current = await db.steps.get(id);
    if (!current) return { ok: false, error: "Not found." };

    const res = normalizeStep({ ...next, id, createdAt: current.createdAt });
    if (!res.ok) return { ok: false, error: res.error };

    try {
      await db.steps.put(res.record);
      const payload = { action: "update", step: res.record };
      emit("step.updated", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: res.record };
    } catch (err) {
      console.error("[StepsRepo.update] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * patch(id, partial)
   * Shallow merge.
   */
  async patch(id, partial = {}) {
    ensureDB();
    if (!id || typeof partial !== "object") return { ok: false, error: "Invalid patch payload." };

    try {
      const current = await db.steps.get(id);
      if (!current) return { ok: false, error: "Not found." };

      const merged = { ...current, ...partial, id, updatedAt: isoNow() };
      await db.steps.put(merged);
      const payload = { action: "patch", step: merged, fields: Object.keys(partial) };
      emit("step.patched", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: merged };
    } catch (err) {
      console.error("[StepsRepo.patch] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * upsert(step)
   */
  async upsert(step = {}) {
    ensureDB();
    const id = step?.id;
    if (!id) return this.create(step);
    const exists = await db.steps.get(id);
    return exists ? this.patch(id, step) : this.create(step);
  },

  /**
   * remove(id)
   */
  async remove(id) {
    ensureDB();
    if (!id) return { ok: false, error: "Missing id." };

    try {
      const current = await db.steps.get(id);
      if (!current) return { ok: false, error: "Not found." };

      await db.steps.delete(id);
      const payload = { action: "delete", id, step: current };
      emit("step.deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { id } };
    } catch (err) {
      console.error("[StepsRepo.remove] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /**
   * bulkRemove(ids[])
   */
  async bulkRemove(ids = []) {
    ensureDB();
    if (!Array.isArray(ids) || !ids.length) return { ok: false, error: "Nothing to remove." };
    try {
      await db.steps.bulkDelete(ids);
      const payload = { action: "bulkDelete", ids };
      emit("step.bulk_deleted", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: ids };
    } catch (err) {
      console.error("[StepsRepo.bulkRemove] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /* --------------------------------------------------------------------------
   * Ordering helpers
   * ------------------------------------------------------------------------ */

  /**
   * reorderWithinSession(sessionId, orderedStepIds)
   * Assigns incremental positions to the provided steps within a Dexie transaction.
   * Positions are set to 10, 20, 30... to allow mid-inserts later.
   */
  async reorderWithinSession(sessionId, orderedStepIds = []) {
    ensureDB();
    if (!sessionId) return { ok: false, error: "Missing sessionId." };
    if (!Array.isArray(orderedStepIds) || !orderedStepIds.length) {
      return { ok: false, error: "No steps provided." };
    }

    try {
      const tx = db.transaction("rw", db.steps, async () => {
        let pos = 10;
        for (const id of orderedStepIds) {
          const row = await db.steps.get(id);
          if (row && row.sessionId === sessionId) {
            await db.steps.update(id, { position: pos, updatedAt: isoNow() });
            pos += 10;
          }
        }
      });
      await tx;

      const payload = { action: "reorder", sessionId, order: orderedStepIds };
      emit("step.reordered", payload);
      await exportToHubIfEnabled(payload);
      return { ok: true, data: { sessionId, order: orderedStepIds } };
    } catch (err) {
      console.error("[StepsRepo.reorderWithinSession] failed:", err);
      return { ok: false, error: err?.message || String(err) };
    }
  },

  /* --------------------------------------------------------------------------
   * Status transitions — standardized hooks for automation runtime
   * ------------------------------------------------------------------------ */

  async queue(id) {
    const res = await this.patch(id, { status: "queued" });
    if (res.ok) {
      const payload = { action: "status.queued", id };
      emit("step.queued", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async ready(id) {
    const res = await this.patch(id, { status: "ready" });
    if (res.ok) {
      const payload = { action: "status.ready", id };
      emit("step.ready", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async start(id, startedAtISO = isoNow()) {
    const res = await this.patch(id, { status: "in_progress", actual: { ...(await this._getActual(id)), startedAt: startedAtISO } });
    if (res.ok) {
      const payload = { action: "status.started", id, startedAt: startedAtISO };
      emit("step.started", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async pause(id) {
    const actual = await this._getActual(id);
    const res = await this.patch(id, { status: "paused", actual: { ...actual, pauseCount: (actual?.pauseCount || 0) + 1 } });
    if (res.ok) {
      const payload = { action: "status.paused", id };
      emit("step.paused", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async resume(id) {
    const res = await this.patch(id, { status: "in_progress" });
    if (res.ok) {
      const payload = { action: "status.resumed", id };
      emit("step.resumed", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async complete(id, endedAtISO = isoNow()) {
    const actual = await this._getActual(id);
    const duration = computeDurationSec(actual?.startedAt, endedAtISO, actual?.durationSec);
    const res = await this.patch(id, {
      status: "completed",
      actual: { ...actual, endedAt: endedAtISO, durationSec: duration },
    });
    if (res.ok) {
      const payload = { action: "status.completed", id, endedAt: endedAtISO };
      emit("step.completed", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async skip(id, reason = null) {
    const res = await this.patch(id, { status: "skipped", metadata: { ...(await this._getMeta(id)), skipReason: reason } });
    if (res.ok) {
      const payload = { action: "status.skipped", id, reason };
      emit("step.skipped", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async cancel(id, reason = null) {
    const res = await this.patch(id, { status: "canceled", metadata: { ...(await this._getMeta(id)), cancelReason: reason } });
    if (res.ok) {
      const payload = { action: "status.canceled", id, reason };
      emit("step.canceled", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async fail(id, reason = null) {
    const res = await this.patch(id, { status: "failed", metadata: { ...(await this._getMeta(id)), failReason: reason } });
    if (res.ok) {
      const payload = { action: "status.failed", id, reason };
      emit("step.failed", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  /* --------------------------------------------------------------------------
   * Timer / schedule helpers
   * ------------------------------------------------------------------------ */

  async attachTimer(id, { countdownSec = 0, alertAt = null, recurringChimeSec = 0 } = {}) {
    const step = await this.getById(id);
    if (!step.ok) return step;
    const current = step.data;
    const next = {
      timer: {
        countdownSec: Number(countdownSec) || 0,
        alertAt: alertAt || current?.timer?.alertAt || null,
        recurringChimeSec: Number(recurringChimeSec) || 0,
      },
    };
    const res = await this.patch(id, next);
    if (res.ok) {
      const payload = { action: "timer.attach", id, timer: res.data.timer };
      emit("step.timer_attached", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async rescheduleWindow(id, { earliestStart = null, latestFinish = null } = {}) {
    const step = await this.getById(id);
    if (!step.ok) return step;
    const curPlanned = step.data?.planned || {};
    const res = await this.patch(id, {
      planned: {
        ...curPlanned,
        earliestStart: earliestStart ?? curPlanned.earliestStart ?? null,
        latestFinish: latestFinish ?? curPlanned.latestFinish ?? null,
      },
    });
    if (res.ok) {
      const payload = { action: "reschedule.window", id, planned: res.data.planned };
      emit("step.rescheduled", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  /* --------------------------------------------------------------------------
   * Domain-specific enrichers (lightweight, optional)
   * ------------------------------------------------------------------------ */

  async setParameters(id, parameters = {}) {
    const step = await this.getById(id);
    if (!step.ok) return step;
    const next = { parameters: { ...(step.data.parameters || {}), ...parameters } };
    const res = await this.patch(id, next);
    if (res.ok) {
      const payload = { action: "parameters.set", id, parameters: res.data.parameters };
      emit("step.parameters_set", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async addHints(id, hints = []) {
    if (!Array.isArray(hints) || !hints.length) return { ok: false, error: "No hints to add." };
    const step = await this.getById(id);
    if (!step.ok) return step;
    const merged = Array.from(new Set([...(step.data.hints || []), ...hints]));
    const res = await this.patch(id, { hints: merged });
    if (res.ok) {
      const payload = { action: "hints.add", id, hints };
      emit("step.hints_added", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  async recordInventoryEffects(id, effects = []) {
    if (!Array.isArray(effects) || !effects.length) return { ok: false, error: "No effects." };
    const step = await this.getById(id);
    if (!step.ok) return step;
    const merged = [ ...(step.data.inventoryEffects || []), ...effects ];
    const res = await this.patch(id, { inventoryEffects: merged });
    if (res.ok) {
      const payload = { action: "inventory.effects_recorded", id, count: effects.length };
      emit("step.inventory_effects_recorded", payload);
      exportToHubIfEnabled(payload);
    }
    return res;
  },

  /* --------------------------------------------------------------------------
   * Private helpers
   * ------------------------------------------------------------------------ */

  async _getActual(id) {
    try {
      const row = await db.steps.get(id);
      return row?.actual || {};
    } catch {
      return {};
    }
  },

  async _getMeta(id) {
    try {
      const row = await db.steps.get(id);
      return row?.metadata || {};
    } catch {
      return {};
    }
  },
};

/* ----------------------------------------------------------------------------
 * Helper: compute duration in seconds (safe if timestamps are missing)
 * -------------------------------------------------------------------------- */
function computeDurationSec(startISO, endISO, fallback = 0) {
  if (!startISO || !endISO) return fallback || 0;
  try {
    const s = new Date(startISO).getTime();
    const e = new Date(endISO).getTime();
    if (Number.isFinite(s) && Number.isFinite(e) && e >= s) {
      return Math.round((e - s) / 1000);
    }
    return fallback || 0;
  } catch {
    return fallback || 0;
  }
}

export default StepsRepo;

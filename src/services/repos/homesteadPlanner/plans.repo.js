/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\homesteadPlanner\plans.repo.js
//
// SSA • Homestead Planner Plans Repository
// -----------------------------------------------------------------------------
// A "Plan" is the Homestead Planner’s top-level artifact that ties together:
//  - inputs (household context + selected catalogs/rules)
//  - preferences (resolved/merged preferences used by the plan)
//  - targets (approved or proposed targets generated/edited)
//  - derived outputs (gaps/actions/feasibility summaries)
//  - optional linked batches (work sessions to execute)
//  - optional inventory reservations (staging)
//
// This repo is the persistence backbone for Homestead Planner plans.
// It is Dexie-first, table-name tolerant, browser-safe, and emits eventBus events.
//
// Recommended Dexie tables (db.js):
//  - homesteadPlannerPlans: "&id, householdId, userId, status, pinned, updatedAt, createdAt, title"
//  - homesteadPlannerPlanHistory: "++pk, id, householdId, userId, at"
// Optional:
//  - homesteadPlannerPlanPins: "&id, householdId, userId, pinnedAt"
//
// Notes
//  - Plans can be household-wide or user-specific (userId null).
//  - "current plan" can be identified by pinned=true or by page state.
//  - Plan IDs are unique within a household scope.
//
// -----------------------------------------------------------------------------
// Usage
//  import { homesteadPlannerPlansRepo as hpPlans } from "@/services/repos/homesteadPlanner/plans.repo";
//  const plan = await hpPlans.createPlan({ householdId, title:"Winter Plan" });
//  await hpPlans.setPlanStatus({ householdId, planId: plan.id, status:"approved" });
//  const list = await hpPlans.listPlans({ householdId, status:"draft" });
//
// -----------------------------------------------------------------------------

const DEFAULT_SOURCE = "services/repos/homesteadPlanner/plans.repo";

/** Events (keep stable) */
export const HP_PLANS_EVENTS = Object.freeze({
  UPSERTED: "homesteadPlanner.plans.upserted",
  DELETED: "homesteadPlanner.plans.deleted",
  STATUS_CHANGED: "homesteadPlanner.plans.statusChanged",
  PINNED: "homesteadPlanner.plans.pinned",
  UNPINNED: "homesteadPlanner.plans.unpinned",
});

/** Primary table candidates */
const TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerPlans",
  "plannerPlans",
  "plans",
]);

/** History table candidates */
const HISTORY_TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerPlanHistory",
  "plannerPlanHistory",
  "planHistory",
]);

/** Optional separate pins table */
const PINS_TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerPlanPins",
  "plannerPlanPins",
  "planPins",
]);

/** KV fallback */
const KV_TABLE_CANDIDATES = Object.freeze(["kv", "settings", "appSettings"]);

/** Plan lifecycle */
const PLAN_STATUS = Object.freeze([
  "draft",
  "proposed",
  "approved",
  "active",
  "completed",
  "archived",
  "cancelled",
]);

/** Helpers */
function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function jclone(x) {
  return x == null ? x : JSON.parse(JSON.stringify(x));
}
function nowISO() {
  return new Date().toISOString();
}
function normalizeStr(v) {
  return v == null ? null : String(v).trim() || null;
}
function normalizeKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^\w:.-]/g, "");
}
function clampEnum(val, allowed, fallback) {
  return allowed.includes(val) ? val : fallback;
}
function clampNumOrNull(v, min, max) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, n));
}
function stripUndefined(x) {
  if (Array.isArray(x)) return x.map(stripUndefined);
  if (!isObj(x)) return x;

  const out = {};
  for (const [k, v] of Object.entries(x)) {
    if (v === undefined) continue;
    out[k] = stripUndefined(v);
  }
  return out;
}
function deepMerge(dst, src) {
  if (!isObj(dst)) dst = {};
  if (!isObj(src)) return dst;

  const out = { ...dst };
  for (const [k, v] of Object.entries(src)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

/** Create a short random id (browser-safe) */
function randomId(prefix = "plan") {
  const rnd =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Math.random()
          .toString(16)
          .slice(2)}`;
  return `${prefix}_${rnd.replace(/-/g, "").slice(0, 18)}`;
}

/** Lazy-load db and eventBus */
async function getDbAndBus() {
  let db = null;
  let eventBus = null;

  try {
    const mod = await import("@/services/db");
    db = mod.db || mod.default || null;
  } catch {
    try {
      const mod = await import("../../db");
      db = mod.db || mod.default || null;
    } catch {
      // ignore
    }
  }

  try {
    const mod = await import("@/services/events/eventBus");
    eventBus = mod.eventBus || mod.default || null;
  } catch {
    try {
      const mod = await import("../../events/eventBus");
      eventBus = mod.eventBus || mod.default || null;
    } catch {
      // ignore
    }
  }

  return { db, eventBus };
}

function hasTable(db, name) {
  try {
    if (!db || !db.tables) return false;
    return db.tables.some((t) => t && t.name === name);
  } catch {
    return false;
  }
}
function pickFirstExistingTable(db, candidates) {
  for (const n of candidates) if (hasTable(db, n)) return n;
  return null;
}

function emit(bus, evt, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(evt, payload);
    else if (typeof bus.publish === "function") bus.publish(evt, payload);
  } catch (e) {
    console.warn(`[HP plans] event emit failed: ${evt}`, e);
  }
}

/** Stable plan record id (household scoped) */
export function makeHomesteadPlannerPlanId({ householdId, planId } = {}) {
  const hid = String(householdId || "").trim();
  const pid = String(planId || "").trim();
  if (!hid) throw new Error("householdId is required");
  if (!pid) throw new Error("planId is required");
  return `${hid}::${pid}`;
}

/** Defaults */
export function getHomesteadPlannerPlanDefaults() {
  return {
    schemaVersion: 1,

    status: "draft",
    pinned: false,

    title: null,
    subtitle: null,
    notes: "",

    tags: [],
    visibility: "household", // household|private|shared (open set)
    // optional date horizon
    context: {
      startISO: null,
      horizonDays: null,
      cuisineKey: null,
      rotationKeys: [],
      ruleSetKey: null,
    },

    // snapshots of planning artifacts (kept lightweight; heavy artifacts can live elsewhere)
    snapshots: {
      // "inputs" can store what the planner ran with (selected catalogs/rules)
      inputs: null,
      // resolved preferences for this plan run
      preferences: null,
      // targets used/approved
      targets: null,
      // summary outputs
      outputs: {
        feasibility: null,
        gaps: [],
        actions: [],
        notes: [],
      },
    },

    // links to other artifacts (tables or IDs)
    links: {
      batchIds: [], // array of local batch IDs (not global composite)
      reservationPlanId: null, // if using inventory reservations scoped by planId
      relatedPlanIds: [],
    },

    // audit + UI helpers
    computed: {
      score: null, // optional
      lastRunAt: null,
      lastRunSummary: null,
    },
  };
}

export function sanitizeHomesteadPlannerPlan(plan) {
  const d = getHomesteadPlannerPlanDefaults();
  const merged = deepMerge(d, isObj(plan) ? plan : {});
  const out = stripUndefined(merged);

  out.status = clampEnum(String(out.status || "").trim(), PLAN_STATUS, "draft");
  out.pinned = !!out.pinned;

  out.title = normalizeStr(out.title);
  out.subtitle = normalizeStr(out.subtitle);
  out.notes =
    typeof out.notes === "string" ? out.notes : String(out.notes ?? "");

  out.tags = Array.isArray(out.tags)
    ? out.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];
  out.visibility = normalizeStr(out.visibility) || "household";

  out.context = out.context || {};
  out.context.startISO = normalizeStr(out.context.startISO);
  out.context.horizonDays = clampNumOrNull(out.context.horizonDays, 1, 366);
  out.context.cuisineKey = normalizeStr(out.context.cuisineKey);
  out.context.rotationKeys = Array.isArray(out.context.rotationKeys)
    ? out.context.rotationKeys.map(normalizeKey).filter(Boolean)
    : [];
  out.context.ruleSetKey = normalizeStr(out.context.ruleSetKey);

  // snapshots (keep JSON-safe)
  out.snapshots = out.snapshots || {};
  out.snapshots.inputs =
    isObj(out.snapshots.inputs) || Array.isArray(out.snapshots.inputs)
      ? out.snapshots.inputs
      : out.snapshots.inputs ?? null;
  out.snapshots.preferences =
    isObj(out.snapshots.preferences) || Array.isArray(out.snapshots.preferences)
      ? out.snapshots.preferences
      : out.snapshots.preferences ?? null;
  out.snapshots.targets =
    isObj(out.snapshots.targets) || Array.isArray(out.snapshots.targets)
      ? out.snapshots.targets
      : out.snapshots.targets ?? null;

  out.snapshots.outputs = out.snapshots.outputs || {};
  out.snapshots.outputs.feasibility = out.snapshots.outputs.feasibility ?? null;
  out.snapshots.outputs.gaps = Array.isArray(out.snapshots.outputs.gaps)
    ? out.snapshots.outputs.gaps.map((x) =>
        isObj(x) ? stripUndefined(x) : { text: String(x) }
      )
    : [];
  out.snapshots.outputs.actions = Array.isArray(out.snapshots.outputs.actions)
    ? out.snapshots.outputs.actions.map((x) =>
        isObj(x) ? stripUndefined(x) : { text: String(x) }
      )
    : [];
  out.snapshots.outputs.notes = Array.isArray(out.snapshots.outputs.notes)
    ? out.snapshots.outputs.notes.map((x) =>
        isObj(x) ? stripUndefined(x) : { text: String(x) }
      )
    : [];

  out.links = out.links || {};
  out.links.batchIds = Array.isArray(out.links.batchIds)
    ? out.links.batchIds.map(String).filter(Boolean)
    : [];
  out.links.reservationPlanId = normalizeStr(out.links.reservationPlanId);
  out.links.relatedPlanIds = Array.isArray(out.links.relatedPlanIds)
    ? out.links.relatedPlanIds.map(String).filter(Boolean)
    : [];

  out.computed = out.computed || {};
  out.computed.score = clampNumOrNull(out.computed.score, -1e9, 1e9);
  out.computed.lastRunAt = normalizeStr(out.computed.lastRunAt);
  out.computed.lastRunSummary =
    out.computed.lastRunSummary == null
      ? null
      : String(out.computed.lastRunSummary);

  if (!Number.isFinite(Number(out.schemaVersion))) out.schemaVersion = 1;
  return out;
}

/**
 * Repo factory
 *   const repo = createHomesteadPlannerPlansRepo({ db, eventBus })
 */
export function createHomesteadPlannerPlansRepo(deps = {}) {
  const injectedDb = deps.db || null;
  const injectedBus = deps.eventBus || null;

  async function resolve() {
    if (injectedDb || injectedBus)
      return { db: injectedDb, eventBus: injectedBus };
    return getDbAndBus();
  }

  async function resolveStorage(db) {
    const primary = pickFirstExistingTable(db, TABLE_CANDIDATES);
    const history = pickFirstExistingTable(db, HISTORY_TABLE_CANDIDATES);
    const pins = pickFirstExistingTable(db, PINS_TABLE_CANDIDATES);
    const kv = pickFirstExistingTable(db, KV_TABLE_CANDIDATES);
    return { primary, history, pins, kv };
  }

  function buildRecordId(householdId, planId) {
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim();
    if (!pid) throw new Error("planId is required");
    return `${hid}::${pid}`;
  }

  function buildKVKey(id) {
    return `homesteadPlanner.plan.${id}`;
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async function getPlan({ householdId, planId } = {}) {
    const { db } = await resolve();
    if (!db) return null;

    const { primary, kv } = await resolveStorage(db);
    const id = buildRecordId(householdId, planId);

    if (primary) {
      const rec = await db.table(primary).get(id);
      if (!rec) return null;
      return sanitizeHomesteadPlannerPlan(
        rec.plan || rec.value || rec.data || rec
      );
    }

    if (kv) {
      const keyA = buildKVKey(id);
      const row =
        (await db.table(kv).get(keyA)) ||
        (await db.table(kv).get(`hpPlan:${id}`)) ||
        null;
      if (!row) return null;
      return sanitizeHomesteadPlannerPlan(
        row.value || row.val || row.data || null
      );
    }

    return null;
  }

  async function listPlans({
    householdId,
    userId = null,
    status = null,
    pinned = null,
    tag = null,
    query = null,
    limit = 200,
    sort = "updatedAt", // updatedAt|createdAt|title|status
  } = {}) {
    const { db } = await resolve();
    if (!db) return [];

    const { primary } = await resolveStorage(db);
    if (!primary) return []; // KV not queryable reliably

    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const uid = userId == null ? null : String(userId).trim();

    const t = db.table(primary);

    let rows = [];
    try {
      const idx = t.schema?.idxByName || {};
      const canHouse = !!idx["householdId"];

      if (canHouse) {
        rows = await t.where("householdId").equals(hid).toArray();
      } else {
        rows = await t.toArray();
        rows = rows.filter((r) => String(r.householdId || "").trim() === hid);
      }
    } catch {
      rows = [];
    }

    if (uid != null)
      rows = rows.filter((r) => String(r.userId || "").trim() === uid);
    if (status)
      rows = rows.filter(
        (r) => String(r.status || "").trim() === String(status).trim()
      );
    if (pinned != null) rows = rows.filter((r) => !!r.pinned === !!pinned);

    if (tag) {
      const tg = String(tag).trim();
      rows = rows.filter((r) => Array.isArray(r.tags) && r.tags.includes(tg));
    }

    if (query) {
      const q = String(query).toLowerCase();
      rows = rows.filter((r) => {
        const title = String(r.title || "").toLowerCase();
        const notes = String(r.notes || "").toLowerCase();
        const subtitle = String(r.subtitle || "").toLowerCase();
        return title.includes(q) || subtitle.includes(q) || notes.includes(q);
      });
    }

    // Sort
    if (sort === "title") {
      rows.sort((a, b) =>
        String(a.title || "").localeCompare(String(b.title || ""))
      );
    } else if (sort === "status") {
      rows.sort((a, b) =>
        String(a.status || "").localeCompare(String(b.status || ""))
      );
    } else if (sort === "createdAt") {
      rows.sort((a, b) =>
        String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
      );
    } else {
      rows.sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
      );
    }

    rows = rows.slice(0, Math.max(0, Number(limit) || 200));

    return rows.map((r) =>
      sanitizeHomesteadPlannerPlan(r.plan || r.value || r.data || r)
    );
  }

  async function getPinnedPlan({ householdId, userId = null } = {}) {
    const plans = await listPlans({
      householdId,
      userId,
      pinned: true,
      limit: 20,
    });
    // If multiple pinned, return most recently updated
    if (!plans.length) return null;
    return plans[0];
  }

  // ---------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------

  async function upsertPlan({
    householdId,
    planId,
    userId = null,
    patch = {},
    replace = false,
    source = DEFAULT_SOURCE,
    reason = "upsert",
    emitEvents = true,
    writeHistory = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim();
    if (!pid) throw new Error("planId is required");
    const uid = userId == null ? null : String(userId).trim();

    const id = buildRecordId(hid, pid);
    const at = nowISO();

    const current = !replace
      ? await getPlan({ householdId: hid, planId: pid })
      : null;
    const base = current || getHomesteadPlannerPlanDefaults();
    const next = sanitizeHomesteadPlannerPlan(
      replace
        ? deepMerge(getHomesteadPlannerPlanDefaults(), patch)
        : deepMerge(base, patch)
    );

    if (!db) {
      if (emitEvents) {
        emit(eventBus, HP_PLANS_EVENTS.UPSERTED, {
          householdId: hid,
          userId: uid,
          planId: pid,
          id,
          updatedAt: at,
          source,
          reason,
          plan: jclone(next),
          persistence: "none",
        });
      }
      return next;
    }

    const { primary, history, kv } = await resolveStorage(db);

    if (primary) {
      const t = db.table(primary);

      const record = {
        id,
        householdId: hid,
        planId: pid,
        userId: uid,
        status: next.status,
        pinned: !!next.pinned,
        title: next.title,
        subtitle: next.subtitle,
        tags: jclone(next.tags),
        notes: next.notes,
        visibility: next.visibility,
        context: jclone(next.context),
        plan: jclone(next),
        schemaVersion: Number(next.schemaVersion) || 1,
        source,
        reason,
        createdAt: at,
        updatedAt: at,
      };

      await db.transaction(
        "rw",
        t,
        ...(history && writeHistory ? [db.table(history)] : []),
        async () => {
          const prev = await t.get(id);
          if (prev && prev.createdAt) record.createdAt = prev.createdAt;

          // Preserve userId if already set and not overwritten
          if (prev && prev.userId && record.userId == null)
            record.userId = prev.userId;

          await t.put(record);

          if (history && writeHistory) {
            await db.table(history).add({
              id,
              householdId: hid,
              planId: pid,
              userId: record.userId,
              at,
              source,
              reason,
              status: record.status,
              pinned: record.pinned,
              title: record.title,
              plan: jclone(next),
            });
          }
        }
      );

      if (emitEvents) {
        emit(eventBus, HP_PLANS_EVENTS.UPSERTED, {
          householdId: hid,
          userId: record.userId,
          planId: pid,
          id,
          updatedAt: at,
          status: next.status,
          pinned: !!next.pinned,
          source,
          reason,
          plan: jclone(next),
          persistence: "table",
          table: primary,
        });
      }

      return next;
    }

    if (kv) {
      const t = db.table(kv);
      const keyA = buildKVKey(id);
      const keyB = `hpPlan:${id}`;

      await db.transaction("rw", t, async () => {
        const existingA = await t.get(keyA);
        const existingB = existingA ? null : await t.get(keyB);
        const keyToUse = existingB ? keyB : keyA;

        const baseRow = existingB || existingA || { key: keyToUse };
        const out = {
          ...baseRow,
          key: baseRow.key ?? keyToUse,
          id: baseRow.id ?? baseRow.key ?? keyToUse,
          value: jclone(next),
          status: next.status,
          pinned: !!next.pinned,
          title: next.title,
          updatedAt: at,
          source,
          reason,
        };
        await t.put(out);
      });

      if (emitEvents) {
        emit(eventBus, HP_PLANS_EVENTS.UPSERTED, {
          householdId: hid,
          userId: uid,
          planId: pid,
          id,
          updatedAt: at,
          status: next.status,
          pinned: !!next.pinned,
          source,
          reason,
          plan: jclone(next),
          persistence: "kv",
          table: kv,
        });
      }

      return next;
    }

    if (emitEvents) {
      emit(eventBus, HP_PLANS_EVENTS.UPSERTED, {
        householdId: hid,
        userId: uid,
        planId: pid,
        id,
        updatedAt: at,
        status: next.status,
        pinned: !!next.pinned,
        source,
        reason,
        plan: jclone(next),
        persistence: "none",
      });
    }

    return next;
  }

  async function createPlan({
    householdId,
    userId = null,
    planId = null,
    title = "New Homestead Plan",
    subtitle = null,
    notes = "",
    tags = [],
    status = "draft",
    pinned = false,
    context = {},
    snapshots = {},
    links = {},
    source = DEFAULT_SOURCE,
    reason = "create",
    emitEvents = true,
  } = {}) {
    const pid = String(planId || "").trim() || randomId("plan");
    const patch = sanitizeHomesteadPlannerPlan({
      ...getHomesteadPlannerPlanDefaults(),
      status,
      pinned,
      title,
      subtitle,
      notes,
      tags,
      context: deepMerge(getHomesteadPlannerPlanDefaults().context, context),
      snapshots: deepMerge(
        getHomesteadPlannerPlanDefaults().snapshots,
        snapshots
      ),
      links: deepMerge(getHomesteadPlannerPlanDefaults().links, links),
      computed: { lastRunAt: null },
    });

    const saved = await upsertPlan({
      householdId,
      planId: pid,
      userId,
      patch,
      replace: true,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    return { id: pid, ...saved };
  }

  async function deletePlan({
    householdId,
    planId,
    source = DEFAULT_SOURCE,
    reason = "delete",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    if (!db) return true;

    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim();
    if (!pid) throw new Error("planId is required");

    const id = buildRecordId(hid, pid);
    const at = nowISO();

    const { primary, kv, pins } = await resolveStorage(db);

    if (pins) {
      // remove pin row if exists
      try {
        await db.table(pins).delete(id);
      } catch {
        // ignore
      }
    }

    if (primary) {
      await db.table(primary).delete(id);
      if (emitEvents) {
        emit(eventBus, HP_PLANS_EVENTS.DELETED, {
          householdId: hid,
          planId: pid,
          id,
          updatedAt: at,
          source,
          reason,
          persistence: "table",
          table: primary,
        });
      }
      return true;
    }

    if (kv) {
      const t = db.table(kv);
      await t.delete(buildKVKey(id));
      await t.delete(`hpPlan:${id}`);
      if (emitEvents) {
        emit(eventBus, HP_PLANS_EVENTS.DELETED, {
          householdId: hid,
          planId: pid,
          id,
          updatedAt: at,
          source,
          reason,
          persistence: "kv",
          table: kv,
        });
      }
      return true;
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Status + pinning
  // ---------------------------------------------------------------------------

  async function setPlanStatus({
    householdId,
    planId,
    status,
    source = DEFAULT_SOURCE,
    reason = "status_change",
    emitEvents = true,
  } = {}) {
    const nextStatus = clampEnum(
      String(status || "").trim(),
      PLAN_STATUS,
      "draft"
    );

    const updated = await upsertPlan({
      householdId,
      planId,
      patch: { status: nextStatus },
      replace: false,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    const { eventBus } = await resolve();
    if (emitEvents) {
      emit(eventBus, HP_PLANS_EVENTS.STATUS_CHANGED, {
        householdId: String(householdId),
        planId: String(planId),
        id: buildRecordId(String(householdId), String(planId)),
        status: nextStatus,
        updatedAt: nowISO(),
        source,
        reason,
      });
    }

    return updated;
  }

  /**
   * Pin one plan for a household (optionally user-specific).
   * Behavior:
   *  - Unpins any other pinned plans in the same household/user scope.
   *  - Pins the requested plan.
   */
  async function pinPlan({
    householdId,
    planId,
    userId = null,
    source = DEFAULT_SOURCE,
    reason = "pin",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim();
    if (!pid) throw new Error("planId is required");
    const uid = userId == null ? null : String(userId).trim();
    const at = nowISO();

    // If no db, just set pinned flag on the plan we can read (best-effort)
    if (!db) {
      const updated = await upsertPlan({
        householdId: hid,
        planId: pid,
        userId: uid,
        patch: { pinned: true },
        replace: false,
        source,
        reason,
        emitEvents,
        writeHistory: true,
      });
      if (emitEvents) {
        emit(eventBus, HP_PLANS_EVENTS.PINNED, {
          householdId: hid,
          userId: uid,
          planId: pid,
          pinnedAt: at,
          source,
          reason,
        });
      }
      return updated;
    }

    const { primary, pins } = await resolveStorage(db);
    if (!primary) {
      // fallback: just set pinned true for this plan
      const updated = await upsertPlan({
        householdId: hid,
        planId: pid,
        userId: uid,
        patch: { pinned: true },
        replace: false,
        source,
        reason,
        emitEvents,
        writeHistory: true,
      });
      if (emitEvents) {
        emit(eventBus, HP_PLANS_EVENTS.PINNED, {
          householdId: hid,
          userId: uid,
          planId: pid,
          pinnedAt: at,
          source,
          reason,
        });
      }
      return updated;
    }

    const t = db.table(primary);

    // Unpin others (same household + same user scope)
    await db.transaction(
      "rw",
      t,
      ...(pins ? [db.table(pins)] : []),
      async () => {
        let rows = [];
        try {
          const idx = t.schema?.idxByName || {};
          if (idx["householdId"])
            rows = await t.where("householdId").equals(hid).toArray();
          else rows = await t.toArray();
        } catch {
          rows = [];
        }

        const inScope = rows.filter((r) => {
          const rh = String(r.householdId || "").trim() === hid;
          const ru = uid == null ? true : String(r.userId || "").trim() === uid;
          return rh && ru;
        });

        for (const r of inScope) {
          const isTarget = String(r.planId || "").trim() === pid;
          const shouldPin = isTarget;
          if (!!r.pinned !== shouldPin) {
            const rid =
              r.id || buildRecordId(hid, String(r.planId || "").trim());
            await t.update(rid, {
              pinned: shouldPin,
              updatedAt: at,
              source,
              reason: `${reason}:auto_unpin_others`,
            });
          }
        }

        if (pins) {
          // store a separate pin row for fast lookups if desired
          const id = buildRecordId(hid, pid);
          await db.table(pins).put({
            id,
            householdId: hid,
            userId: uid,
            planId: pid,
            pinnedAt: at,
            source,
            reason,
            updatedAt: at,
          });
        }
      }
    );

    const updated = await getPlan({ householdId: hid, planId: pid });

    if (emitEvents) {
      emit(eventBus, HP_PLANS_EVENTS.PINNED, {
        householdId: hid,
        userId: uid,
        planId: pid,
        pinnedAt: at,
        source,
        reason,
      });
    }

    return updated;
  }

  async function unpinPlan({
    householdId,
    planId,
    source = DEFAULT_SOURCE,
    reason = "unpin",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim();
    if (!pid) throw new Error("planId is required");

    const at = nowISO();

    const updated = await upsertPlan({
      householdId: hid,
      planId: pid,
      patch: { pinned: false },
      replace: false,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    if (db) {
      const { pins } = await resolveStorage(db);
      if (pins) {
        try {
          await db.table(pins).delete(buildRecordId(hid, pid));
        } catch {
          // ignore
        }
      }
    }

    if (emitEvents) {
      emit(eventBus, HP_PLANS_EVENTS.UNPINNED, {
        householdId: hid,
        planId: pid,
        unpinnedAt: at,
        source,
        reason,
      });
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Snapshot helpers (for planner outputs)
  // ---------------------------------------------------------------------------

  async function setPlanSnapshots({
    householdId,
    planId,
    inputs = undefined,
    preferences = undefined,
    targets = undefined,
    outputs = undefined,
    lastRunAt = undefined,
    lastRunSummary = undefined,
    source = DEFAULT_SOURCE,
    reason = "set_snapshots",
    emitEvents = true,
  } = {}) {
    const patch = {
      snapshots: {
        ...(inputs !== undefined ? { inputs } : {}),
        ...(preferences !== undefined ? { preferences } : {}),
        ...(targets !== undefined ? { targets } : {}),
        ...(outputs !== undefined ? { outputs } : {}),
      },
      computed: {
        ...(lastRunAt !== undefined ? { lastRunAt } : {}),
        ...(lastRunSummary !== undefined ? { lastRunSummary } : {}),
      },
    };

    return upsertPlan({
      householdId,
      planId,
      patch,
      replace: false,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });
  }

  async function linkBatchToPlan({
    householdId,
    planId,
    batchId,
    source = DEFAULT_SOURCE,
    reason = "link_batch",
    emitEvents = true,
  } = {}) {
    const plan = await getPlan({ householdId, planId });
    if (!plan) throw new Error("Plan not found");

    const next = Array.from(
      new Set([...(plan.links?.batchIds || []), String(batchId)])
    ).filter(Boolean);

    return upsertPlan({
      householdId,
      planId,
      patch: { links: { batchIds: next } },
      replace: false,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });
  }

  async function unlinkBatchFromPlan({
    householdId,
    planId,
    batchId,
    source = DEFAULT_SOURCE,
    reason = "unlink_batch",
    emitEvents = true,
  } = {}) {
    const plan = await getPlan({ householdId, planId });
    if (!plan) throw new Error("Plan not found");

    const next = (plan.links?.batchIds || []).filter(
      (id) => String(id) !== String(batchId)
    );

    return upsertPlan({
      householdId,
      planId,
      patch: { links: { batchIds: next } },
      replace: false,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });
  }

  return Object.freeze({
    // ids/defaults
    makeId: makeHomesteadPlannerPlanId,
    defaults: getHomesteadPlannerPlanDefaults,
    sanitize: sanitizeHomesteadPlannerPlan,

    // reads
    getPlan,
    listPlans,
    getPinnedPlan,

    // writes
    createPlan,
    upsertPlan,
    deletePlan,
    setPlanStatus,
    pinPlan,
    unpinPlan,

    // snapshot helpers
    setPlanSnapshots,
    linkBatchToPlan,
    unlinkBatchFromPlan,
  });
}

/** Default singleton repo */
export const homesteadPlannerPlansRepo = createHomesteadPlannerPlansRepo();

/* -----------------------------------------------------------------------------
Example usage
------------------------------------------------------------------------------
import { homesteadPlannerPlansRepo as hpPlans } from "@/services/repos/homesteadPlanner/plans.repo";

// Create
const plan = await hpPlans.createPlan({
  householdId,
  title: "Winter Provisioning Plan",
  context: { startISO: new Date().toISOString(), horizonDays: 90, cuisineKey: "aai" },
});

// Save snapshots after running planner
await hpPlans.setPlanSnapshots({
  householdId,
  planId: plan.id,
  inputs: { selections, options },
  preferences: resolvedPrefs,
  targets: targets,
  outputs: { feasibility, gaps, actions, notes: [] },
  lastRunAt: new Date().toISOString(),
  lastRunSummary: "Planner run completed; 12 gaps; 8 actions.",
});

// Pin current plan
await hpPlans.pinPlan({ householdId, planId: plan.id });

// List
const plans = await hpPlans.listPlans({ householdId, pinned: true });

----------------------------------------------------------------------------- */

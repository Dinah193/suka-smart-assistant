/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\repos\homesteadPlanner\batches.repo.js
//
// SSA • Homestead Planner Batches Repository
// -----------------------------------------------------------------------------
// What is a "Batch" here?
//  - A planned or executed batch job tied to homesteading/provisioning targets.
//  - Examples:
//      • Pressure canning session
//      • Dehydrating run
//      • Bulk cooking session
//      • Butchery day
//      • Milling/grinding day
//      • Fermentation start
//      • Packaging/labeling run
//
// Why the Homestead Planner needs batches
//  - Turn targets and gaps into scheduled work units with inputs/outputs.
//  - Create plan-scoped reservations (optional) before execution.
//  - Track progress and outcomes in a consistent structure.
//
// Design goals
//  - Browser-safe (Vite) — no Node imports
//  - Dexie-backed; tolerant of missing table names (KV fallback)
//  - Deterministic defaults + sanitization
//  - Atomic upserts + optional history
//  - EventBus emissions for UI/automation sync
//
// Recommended Dexie tables (db.js):
//  - homesteadPlannerBatches: "&id, householdId, planId, status, type, scheduledFor, updatedAt"
//  - homesteadPlannerBatchHistory: "++pk, id, householdId, planId, at"
//  - (optional) homesteadPlannerBatchRuns: "&id, batchId, startedAt, endedAt"
//
// This repo auto-detects tables and adapts.
//
// -----------------------------------------------------------------------------
// Usage
//  import { homesteadPlannerBatchesRepo as hpBatches } from "@/services/repos/homesteadPlanner/batches.repo";
//  const list = await hpBatches.listBatches({ householdId, planId });
//  const batch = await hpBatches.createBatch({ householdId, planId, type:"pressure_canning", ... });
//  await hpBatches.setBatchStatus({ householdId, planId, batchId: batch.id, status:"scheduled" });
//
// -----------------------------------------------------------------------------

const DEFAULT_SOURCE = "services/repos/homesteadPlanner/batches.repo";

/** Events (keep stable) */
export const HP_BATCH_EVENTS = Object.freeze({
  UPSERTED: "homesteadPlanner.batches.upserted",
  DELETED: "homesteadPlanner.batches.deleted",
  STATUS_CHANGED: "homesteadPlanner.batches.statusChanged",
  RUN_STARTED: "homesteadPlanner.batches.run.started",
  RUN_ENDED: "homesteadPlanner.batches.run.ended",
});

/** Primary table candidates */
const TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerBatches",
  "plannerBatches",
  "batches",
]);

/** History table candidates */
const HISTORY_TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerBatchHistory",
  "plannerBatchHistory",
  "batchHistory",
]);

/** Optional run tracking table candidates */
const RUNS_TABLE_CANDIDATES = Object.freeze([
  "homesteadPlannerBatchRuns",
  "plannerBatchRuns",
  "batchRuns",
]);

/** KV fallback */
const KV_TABLE_CANDIDATES = Object.freeze(["kv", "settings", "appSettings"]);

/** Batch lifecycle */
const BATCH_STATUS = Object.freeze([
  "draft",
  "planned", // planned but not scheduled
  "scheduled", // has schedule date/time
  "in_progress",
  "paused",
  "completed",
  "cancelled",
  "archived",
]);

/** Common batch types (open set; these are defaults) */
export const BATCH_TYPES = Object.freeze([
  "pressure_canning",
  "water_bath_canning",
  "dehydrating",
  "freezing",
  "fermenting",
  "curing_smoking",
  "butchery",
  "bulk_cooking",
  "milling_grinding",
  "packaging_labeling",
  "inventory_audit",
  "garden_harvest",
  "animal_care_round",
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
function normalizeUnit(u) {
  const s = String(u || "")
    .trim()
    .toLowerCase();
  if (!s) return "count";
  const map = {
    ct: "count",
    ea: "count",
    each: "count",
    lb: "lb",
    lbs: "lb",
    oz: "oz",
    g: "g",
    kg: "kg",
    l: "l",
    ml: "ml",
    gal: "gal",
    gallon: "gal",
    qts: "qt",
    qt: "qt",
    pt: "pt",
  };
  return map[s] || s;
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
    console.warn(`[HP batches] event emit failed: ${evt}`, e);
  }
}

/** Stable batch id */
export function makeHomesteadPlannerBatchId({
  householdId,
  planId,
  batchId,
} = {}) {
  const hid = String(householdId || "").trim();
  if (!hid) throw new Error("householdId is required");
  const pid = String(planId || "").trim() || "__current__";
  const bid = String(batchId || "").trim();
  if (!bid) throw new Error("batchId is required");
  return `${hid}::${pid}::${bid}`;
}

/** Create a short random id (browser-safe) */
function randomId(prefix = "batch") {
  // crypto is available in browsers; fallback to Math.random
  const rnd =
    globalThis.crypto && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Math.random().toString(16).slice(2)}${Math.random()
          .toString(16)
          .slice(2)}`;
  return `${prefix}_${rnd.replace(/-/g, "").slice(0, 18)}`;
}

/** Defaults */
export function getHomesteadPlannerBatchDefaults() {
  return {
    schemaVersion: 1,

    // identity (stored separately in record but included here too)
    status: "draft",
    type: "bulk_cooking",

    title: null,
    notes: "",

    // schedule & execution
    scheduledFor: null, // ISO
    dueBy: null, // ISO (optional)
    startedAt: null,
    endedAt: null,

    // optional "session" style planning
    durationMinutesEstimate: null,
    effortLevel: "medium", // low|medium|high (open set)
    location: null, // kitchen, garden, smokehouse, etc.

    // inputs/outputs
    // lines: { inputs: [{ key, qty, unit, lotId?, location?, meta? }], outputs: [...] }
    lines: {
      inputs: [],
      outputs: [],
      byproducts: [],
      tools: [], // [{ key, label?, qty?, notes? }]
    },

    // linkage to targets/gaps/actions
    links: {
      targetKeys: [], // e.g., component keys or crop/species keys
      gapIds: [],
      actionIds: [],
    },

    // execution checkpoints
    checklist: {
      prep: [],
      steps: [],
      cleanup: [],
    },

    // results
    results: {
      // e.g., actual yields, notes, photos, QC
      yields: [],
      issues: [],
    },

    // computed helpers
    computed: {
      totals: {
        inputsByKey: {}, // key -> { unit -> qty }
        outputsByKey: {}, // key -> { unit -> qty }
      },
    },
  };
}

function sanitizeLineArray(arr) {
  const out = [];
  const src = Array.isArray(arr) ? arr : [];
  for (const ln of src) {
    if (!isObj(ln)) continue;
    const key = normalizeKey(ln.key);
    if (!key) continue;
    const qty = clampNumOrNull(ln.qty, 0, 1e12) ?? 0;
    const unit = normalizeUnit(ln.unit);
    const lotId = normalizeStr(ln.lotId);
    const location = normalizeStr(ln.location);
    const meta = isObj(ln.meta) ? ln.meta : undefined;

    out.push(
      stripUndefined({
        key,
        qty,
        unit,
        ...(lotId ? { lotId } : {}),
        ...(location ? { location } : {}),
        ...(meta ? { meta } : {}),
      })
    );
  }
  return out;
}

function computeTotals(lines) {
  const totals = {};
  for (const ln of lines) {
    const k = ln.key;
    const u = normalizeUnit(ln.unit);
    if (!totals[k]) totals[k] = {};
    totals[k][u] = (totals[k][u] || 0) + (clampNumOrNull(ln.qty, 0, 1e12) ?? 0);
  }
  return totals;
}

export function sanitizeHomesteadPlannerBatch(batch) {
  const d = getHomesteadPlannerBatchDefaults();
  const merged = deepMerge(d, isObj(batch) ? batch : {});
  const out = stripUndefined(merged);

  out.status = clampEnum(
    String(out.status || "").trim(),
    BATCH_STATUS,
    "draft"
  );
  out.type = normalizeStr(out.type) || "bulk_cooking";
  out.title = normalizeStr(out.title);
  out.notes =
    typeof out.notes === "string" ? out.notes : String(out.notes ?? "");

  out.scheduledFor = normalizeStr(out.scheduledFor);
  out.dueBy = normalizeStr(out.dueBy);
  out.startedAt = normalizeStr(out.startedAt);
  out.endedAt = normalizeStr(out.endedAt);

  out.durationMinutesEstimate = clampNumOrNull(
    out.durationMinutesEstimate,
    0,
    7 * 24 * 60
  );
  out.effortLevel = normalizeStr(out.effortLevel) || "medium";
  out.location = normalizeStr(out.location);

  // Lines
  out.lines = out.lines || {};
  out.lines.inputs = sanitizeLineArray(out.lines.inputs);
  out.lines.outputs = sanitizeLineArray(out.lines.outputs);
  out.lines.byproducts = sanitizeLineArray(out.lines.byproducts);

  // Tools
  out.lines.tools = Array.isArray(out.lines.tools)
    ? out.lines.tools
        .map((t) => {
          if (!isObj(t)) return null;
          const key = normalizeKey(t.key ?? t.label ?? "tool");
          if (!key) return null;
          return stripUndefined({
            key,
            label:
              typeof t.label === "string"
                ? t.label
                : t.label == null
                ? undefined
                : String(t.label),
            qty: clampNumOrNull(t.qty, 0, 1e6),
            notes:
              typeof t.notes === "string"
                ? t.notes
                : t.notes == null
                ? undefined
                : String(t.notes),
          });
        })
        .filter(Boolean)
    : [];

  // Links
  out.links = out.links || {};
  out.links.targetKeys = Array.isArray(out.links.targetKeys)
    ? out.links.targetKeys.map(normalizeKey).filter(Boolean)
    : [];
  out.links.gapIds = Array.isArray(out.links.gapIds)
    ? out.links.gapIds.map(String).filter(Boolean)
    : [];
  out.links.actionIds = Array.isArray(out.links.actionIds)
    ? out.links.actionIds.map(String).filter(Boolean)
    : [];

  // Checklist sections
  const normChecklist = (v) =>
    Array.isArray(v)
      ? v
          .map((x) => (isObj(x) ? stripUndefined(x) : { text: String(x) }))
          .filter(Boolean)
      : [];
  out.checklist = out.checklist || {};
  out.checklist.prep = normChecklist(out.checklist.prep);
  out.checklist.steps = normChecklist(out.checklist.steps);
  out.checklist.cleanup = normChecklist(out.checklist.cleanup);

  // Results
  const normResults = (v) =>
    Array.isArray(v)
      ? v.map((x) => (isObj(x) ? stripUndefined(x) : { text: String(x) }))
      : [];
  out.results = out.results || {};
  out.results.yields = normResults(out.results.yields);
  out.results.issues = normResults(out.results.issues);

  // Computed totals
  out.computed = out.computed || {};
  out.computed.totals = {
    inputsByKey: computeTotals(out.lines.inputs),
    outputsByKey: computeTotals(out.lines.outputs),
  };

  if (!Number.isFinite(Number(out.schemaVersion))) out.schemaVersion = 1;
  return out;
}

/**
 * Repo factory
 *   const repo = createHomesteadPlannerBatchesRepo({ db, eventBus })
 */
export function createHomesteadPlannerBatchesRepo(deps = {}) {
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
    const runs = pickFirstExistingTable(db, RUNS_TABLE_CANDIDATES);
    const kv = pickFirstExistingTable(db, KV_TABLE_CANDIDATES);
    return { primary, history, runs, kv };
  }

  function buildId(householdId, planId, localBatchId) {
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim() || "__current__";
    const bid = String(localBatchId || "").trim();
    if (!bid) throw new Error("localBatchId is required");
    return `${hid}::${pid}::${bid}`;
  }

  function buildKVKey(id) {
    return `homesteadPlanner.batch.${id}`;
  }

  // ---------------------------------------------------------------------------
  // CRUD
  // ---------------------------------------------------------------------------

  async function getBatch({ householdId, planId = null, batchId } = {}) {
    const { db } = await resolve();
    if (!db) return null;

    const { primary, kv } = await resolveStorage(db);

    const pid = String(planId || "").trim() || "__current__";
    const localId = String(batchId || "").trim();
    if (!localId) throw new Error("batchId is required");

    const id = buildId(householdId, pid, localId);

    if (primary) {
      const rec = await db.table(primary).get(id);
      if (!rec) return null;
      return sanitizeHomesteadPlannerBatch(
        rec.batch || rec.value || rec.data || rec
      );
    }

    if (kv) {
      const keyA = buildKVKey(id);
      const row =
        (await db.table(kv).get(keyA)) ||
        (await db.table(kv).get(`hpBatch:${id}`)) ||
        null;
      if (!row) return null;
      return sanitizeHomesteadPlannerBatch(
        row.value || row.val || row.data || null
      );
    }

    return null;
  }

  async function listBatches({
    householdId,
    planId = null,
    status = null,
    type = null,
    sinceISO = null,
    limit = 500,
    sort = "scheduledFor", // scheduledFor|updatedAt|createdAt
  } = {}) {
    const { db } = await resolve();
    if (!db) return [];

    const { primary } = await resolveStorage(db);
    if (!primary) return []; // KV not queryable reliably

    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim() || "__current__";

    let rows = [];
    const t = db.table(primary);

    // Attempt indexed query by householdId and planId when possible; else scan.
    try {
      const idx = t.schema?.idxByName || {};
      const canHouse = !!idx["householdId"];
      const canPlan = !!idx["planId"];

      if (canHouse && canPlan) {
        // where householdId, then filter planId
        rows = await t.where("householdId").equals(hid).toArray();
        rows = rows.filter((r) => String(r.planId || "").trim() === pid);
      } else {
        rows = await t.toArray();
        rows = rows.filter(
          (r) =>
            String(r.householdId || "").trim() === hid &&
            String(r.planId || "").trim() === pid
        );
      }
    } catch {
      rows = [];
    }

    if (status)
      rows = rows.filter(
        (r) => String(r.status || "").trim() === String(status).trim()
      );
    if (type)
      rows = rows.filter(
        (r) => String(r.type || "").trim() === String(type).trim()
      );
    if (sinceISO)
      rows = rows.filter(
        (r) => String(r.updatedAt || "").trim() >= String(sinceISO).trim()
      );

    const key =
      sort === "updatedAt"
        ? "updatedAt"
        : sort === "createdAt"
        ? "createdAt"
        : "scheduledFor";
    rows.sort((a, b) =>
      String(b[key] || "").localeCompare(String(a[key] || ""))
    );

    const sliced = rows.slice(0, Math.max(0, Number(limit) || 500));
    return sliced.map((r) =>
      sanitizeHomesteadPlannerBatch(r.batch || r.value || r.data || r)
    );
  }

  async function createBatch({
    householdId,
    planId = null,
    type = "bulk_cooking",
    title = null,
    notes = "",
    scheduledFor = null,
    dueBy = null,
    payload = {}, // partial batch override
    source = DEFAULT_SOURCE,
    reason = "create",
    emitEvents = true,
    writeHistory = true,
  } = {}) {
    const localBatchId = randomId("batch");
    const pid = String(planId || "").trim() || "__current__";

    const batch = sanitizeHomesteadPlannerBatch({
      ...getHomesteadPlannerBatchDefaults(),
      type,
      title,
      notes,
      scheduledFor,
      dueBy,
      ...payload,
      status: payload.status || "draft",
    });

    await upsertBatch({
      householdId,
      planId: pid,
      batchId: localBatchId,
      patch: batch,
      replace: true,
      source,
      reason,
      emitEvents,
      writeHistory,
    });

    return { id: localBatchId, ...batch };
  }

  async function upsertBatch({
    householdId,
    planId = null,
    batchId,
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
    const pid = String(planId || "").trim() || "__current__";
    const localId = String(batchId || "").trim();
    if (!localId) throw new Error("batchId is required");

    const id = buildId(hid, pid, localId);
    const at = nowISO();

    const nextBatch = sanitizeHomesteadPlannerBatch(
      replace
        ? patch
        : deepMerge(
            (await (async () =>
              db
                ? await getBatch({
                    householdId: hid,
                    planId: pid,
                    batchId: localId,
                  })
                : null)()) || getHomesteadPlannerBatchDefaults(),
            patch
          )
    );

    if (!db) {
      if (emitEvents) {
        emit(eventBus, HP_BATCH_EVENTS.UPSERTED, {
          householdId: hid,
          planId: pid,
          batchId: localId,
          id,
          updatedAt: at,
          source,
          reason,
          batch: jclone(nextBatch),
          persistence: "none",
        });
      }
      return nextBatch;
    }

    const { primary, history, kv } = await resolveStorage(db);

    if (primary) {
      const t = db.table(primary);
      const record = {
        id,
        householdId: hid,
        planId: pid,
        batchId: localId, // optional separate id field
        status: nextBatch.status,
        type: nextBatch.type,
        title: nextBatch.title,
        scheduledFor: nextBatch.scheduledFor,
        dueBy: nextBatch.dueBy,
        startedAt: nextBatch.startedAt,
        endedAt: nextBatch.endedAt,
        batch: jclone(nextBatch),
        schemaVersion: Number(nextBatch.schemaVersion) || 1,
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
          await t.put(record);

          if (history && writeHistory) {
            await db.table(history).add({
              id,
              householdId: hid,
              planId: pid,
              batchId: localId,
              at,
              source,
              reason,
              status: record.status,
              type: record.type,
              batch: jclone(nextBatch),
            });
          }
        }
      );

      if (emitEvents) {
        emit(eventBus, HP_BATCH_EVENTS.UPSERTED, {
          householdId: hid,
          planId: pid,
          batchId: localId,
          id,
          updatedAt: at,
          status: nextBatch.status,
          type: nextBatch.type,
          source,
          reason,
          batch: jclone(nextBatch),
          persistence: "table",
          table: primary,
        });
      }

      return nextBatch;
    }

    if (kv) {
      const t = db.table(kv);
      const keyA = buildKVKey(id);
      const keyB = `hpBatch:${id}`;

      await db.transaction("rw", t, async () => {
        const existingA = await t.get(keyA);
        const existingB = existingA ? null : await t.get(keyB);
        const keyToUse = existingB ? keyB : keyA;

        const baseRow = existingB || existingA || { key: keyToUse };
        const out = {
          ...baseRow,
          key: baseRow.key ?? keyToUse,
          id: baseRow.id ?? baseRow.key ?? keyToUse,
          value: jclone(nextBatch),
          status: nextBatch.status,
          type: nextBatch.type,
          updatedAt: at,
          source,
          reason,
        };
        await t.put(out);
      });

      if (emitEvents) {
        emit(eventBus, HP_BATCH_EVENTS.UPSERTED, {
          householdId: hid,
          planId: pid,
          batchId: localId,
          id,
          updatedAt: at,
          status: nextBatch.status,
          type: nextBatch.type,
          source,
          reason,
          batch: jclone(nextBatch),
          persistence: "kv",
          table: kv,
        });
      }

      return nextBatch;
    }

    if (emitEvents) {
      emit(eventBus, HP_BATCH_EVENTS.UPSERTED, {
        householdId: hid,
        planId: pid,
        batchId: localId,
        id,
        updatedAt: at,
        status: nextBatch.status,
        type: nextBatch.type,
        source,
        reason,
        batch: jclone(nextBatch),
        persistence: "none",
      });
    }

    return nextBatch;
  }

  async function deleteBatch({
    householdId,
    planId = null,
    batchId,
    source = DEFAULT_SOURCE,
    reason = "delete",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    if (!db) return true;

    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim() || "__current__";
    const localId = String(batchId || "").trim();
    if (!localId) throw new Error("batchId is required");

    const id = buildId(hid, pid, localId);
    const at = nowISO();

    const { primary, kv } = await resolveStorage(db);

    if (primary) {
      await db.table(primary).delete(id);
      if (emitEvents) {
        emit(eventBus, HP_BATCH_EVENTS.DELETED, {
          householdId: hid,
          planId: pid,
          batchId: localId,
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
      await t.delete(`hpBatch:${id}`);
      if (emitEvents) {
        emit(eventBus, HP_BATCH_EVENTS.DELETED, {
          householdId: hid,
          planId: pid,
          batchId: localId,
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
  // Status transitions + run tracking
  // ---------------------------------------------------------------------------

  async function setBatchStatus({
    householdId,
    planId = null,
    batchId,
    status,
    source = DEFAULT_SOURCE,
    reason = "status_change",
    emitEvents = true,
  } = {}) {
    const nextStatus = clampEnum(
      String(status || "").trim(),
      BATCH_STATUS,
      "draft"
    );
    const patch = { status: nextStatus };

    // Auto-fill timestamps when entering/leaving in_progress/completed
    if (nextStatus === "in_progress") patch.startedAt = nowISO();
    if (nextStatus === "completed" || nextStatus === "cancelled")
      patch.endedAt = nowISO();

    const updated = await upsertBatch({
      householdId,
      planId,
      batchId,
      patch,
      replace: false,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    const { eventBus } = await resolve();
    if (emitEvents) {
      emit(eventBus, HP_BATCH_EVENTS.STATUS_CHANGED, {
        householdId: String(householdId),
        planId: String(planId || "__current__"),
        batchId: String(batchId),
        id: buildId(
          String(householdId),
          String(planId || "__current__"),
          String(batchId)
        ),
        status: nextStatus,
        updatedAt: nowISO(),
        source,
        reason,
      });
    }

    return updated;
  }

  async function startBatchRun({
    householdId,
    planId = null,
    batchId,
    runId = null,
    source = DEFAULT_SOURCE,
    reason = "run_start",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim() || "__current__";
    const localId = String(batchId || "").trim();
    if (!localId) throw new Error("batchId is required");

    const { runs } = db ? await resolveStorage(db) : { runs: null };

    const startedAt = nowISO();
    const rid = runId || randomId("run");
    const batchGlobalId = buildId(hid, pid, localId);

    // Update batch status to in_progress (sets startedAt)
    await setBatchStatus({
      householdId: hid,
      planId: pid,
      batchId: localId,
      status: "in_progress",
      source,
      reason,
      emitEvents,
    });

    if (db && runs) {
      const t = db.table(runs);
      await t.put({
        id: `${batchGlobalId}::${rid}`,
        batchId: batchGlobalId,
        runId: rid,
        startedAt,
        endedAt: null,
        source,
        reason,
        createdAt: startedAt,
        updatedAt: startedAt,
      });
    }

    if (emitEvents) {
      emit(eventBus, HP_BATCH_EVENTS.RUN_STARTED, {
        householdId: hid,
        planId: pid,
        batchId: localId,
        id: batchGlobalId,
        runId: rid,
        startedAt,
        source,
        reason,
      });
    }

    return { runId: rid, startedAt };
  }

  async function endBatchRun({
    householdId,
    planId = null,
    batchId,
    runId,
    statusAfter = "completed", // completed|paused|cancelled
    source = DEFAULT_SOURCE,
    reason = "run_end",
    emitEvents = true,
  } = {}) {
    const { db, eventBus } = await resolve();
    const hid = String(householdId || "").trim();
    if (!hid) throw new Error("householdId is required");
    const pid = String(planId || "").trim() || "__current__";
    const localId = String(batchId || "").trim();
    if (!localId) throw new Error("batchId is required");

    const batchGlobalId = buildId(hid, pid, localId);
    const endedAt = nowISO();

    const nextStatus = clampEnum(
      String(statusAfter || "").trim(),
      BATCH_STATUS,
      "completed"
    );

    // Update batch status + endedAt when appropriate
    await setBatchStatus({
      householdId: hid,
      planId: pid,
      batchId: localId,
      status: nextStatus,
      source,
      reason,
      emitEvents,
    });

    if (db) {
      const { runs } = await resolveStorage(db);
      if (runs && runId) {
        const t = db.table(runs);
        const rid = String(runId).trim();
        const pk = `${batchGlobalId}::${rid}`;
        try {
          await t.update(pk, {
            endedAt,
            updatedAt: endedAt,
            statusAfter: nextStatus,
            source,
            reason,
          });
        } catch {
          // if no row existed, create it
          await t.put({
            id: pk,
            batchId: batchGlobalId,
            runId: rid,
            startedAt: null,
            endedAt,
            statusAfter: nextStatus,
            source,
            reason,
            createdAt: endedAt,
            updatedAt: endedAt,
          });
        }
      }
    }

    if (emitEvents) {
      emit(eventBus, HP_BATCH_EVENTS.RUN_ENDED, {
        householdId: hid,
        planId: pid,
        batchId: localId,
        id: batchGlobalId,
        runId: runId ? String(runId) : null,
        endedAt,
        statusAfter: nextStatus,
        source,
        reason,
      });
    }

    return { endedAt, statusAfter: nextStatus };
  }

  // ---------------------------------------------------------------------------
  // Planner-specific helpers
  // ---------------------------------------------------------------------------

  /**
   * Derive reservation lines from a batch (inputs only).
   * Useful when you want to hold ingredients/materials for the batch.
   */
  function toReservationLinesFromBatch(batch) {
    const b = sanitizeHomesteadPlannerBatch(batch);
    return b.lines.inputs.map((ln) => ({
      key: ln.key,
      qty: ln.qty,
      unit: ln.unit,
      ...(ln.lotId ? { lotId: ln.lotId } : {}),
      ...(ln.location ? { location: ln.location } : {}),
      ...(ln.meta ? { meta: ln.meta } : {}),
    }));
  }

  /**
   * Creates/updates a batch and optionally asks inventory repo to reserve inputs.
   * This is best-effort: if inventory repo not available, batch still saves.
   */
  async function upsertBatchWithOptionalReservation({
    householdId,
    planId = null,
    batchId,
    patch = {},
    replace = false,
    reserveInputs = false,
    reservationStatus = "active",
    source = DEFAULT_SOURCE,
    reason = "upsert_with_reserve",
    emitEvents = true,
  } = {}) {
    const saved = await upsertBatch({
      householdId,
      planId,
      batchId,
      patch,
      replace,
      source,
      reason,
      emitEvents,
      writeHistory: true,
    });

    if (!reserveInputs) return saved;

    try {
      const invMod = await import("./inventory.repo");
      const invRepo =
        invMod?.homesteadPlannerInventoryRepo ||
        invMod?.createHomesteadPlannerInventoryRepo?.();
      if (!invRepo || typeof invRepo.upsertReservation !== "function")
        return saved;

      const lines = toReservationLinesFromBatch(saved);
      // planId is used as reservation scope; for batch-level reservation you might use `${planId}::${batchId}`
      const effectivePlanId = String(planId || "__current__");

      await invRepo.upsertReservation({
        householdId,
        planId: effectivePlanId,
        patch: {
          status: reservationStatus,
          lines,
          notes: `Auto-reserve inputs for batch ${batchId || ""}`.trim(),
        },
        replace: false,
        source,
        reason: `${reason}:reserve_inputs`,
        emitEvents,
      });
    } catch (e) {
      console.warn("[HP batches] reserveInputs failed (non-fatal)", e);
    }

    return saved;
  }

  return Object.freeze({
    // defaults/sanitize
    defaults: getHomesteadPlannerBatchDefaults,
    sanitize: sanitizeHomesteadPlannerBatch,

    // CRUD
    getBatch,
    listBatches,
    createBatch,
    upsertBatch,
    deleteBatch,

    // status/runs
    setBatchStatus,
    startBatchRun,
    endBatchRun,

    // helpers
    toReservationLinesFromBatch,
    upsertBatchWithOptionalReservation,
  });
}

/** Default singleton repo */
export const homesteadPlannerBatchesRepo = createHomesteadPlannerBatchesRepo();

/* -----------------------------------------------------------------------------
Example usage
------------------------------------------------------------------------------
import { homesteadPlannerBatchesRepo as hpBatches } from "@/services/repos/homesteadPlanner/batches.repo";

// Create a canning batch
const b = await hpBatches.createBatch({
  householdId,
  planId: "plan_2026_01_10_001",
  type: "pressure_canning",
  title: "Canning chicken stock",
  scheduledFor: new Date().toISOString(),
  payload: {
    lines: {
      inputs: [{ key: "chicken_bones", qty: 12, unit: "lb" }, { key: "mason_jar_quart", qty: 24, unit: "count" }],
      outputs: [{ key: "canned_stock_quart", qty: 24, unit: "count" }],
      tools: [{ key: "pressure_canner", label: "Pressure Canner" }],
    },
    checklist: { steps: ["Make stock", "Fill jars", "Process 25 min @ pressure"] },
  },
});

// Reserve inputs (best-effort) and set scheduled
await hpBatches.upsertBatchWithOptionalReservation({
  householdId,
  planId: "plan_2026_01_10_001",
  batchId: b.id,
  patch: { status: "scheduled" },
  reserveInputs: true,
});

// Start a run
const run = await hpBatches.startBatchRun({ householdId, planId: "plan_2026_01_10_001", batchId: b.id });

// End run & complete
await hpBatches.endBatchRun({ householdId, planId: "plan_2026_01_10_001", batchId: b.id, runId: run.runId, statusAfter: "completed" });

----------------------------------------------------------------------------- */

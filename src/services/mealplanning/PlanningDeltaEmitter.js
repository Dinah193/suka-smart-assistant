/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\mealplanning\PlanningDeltaEmitter.js
//
// PlanningDeltaEmitter — background delta computation + persistence (Dexie)
// ----------------------------------------------------------------------
// Goal:
//   - ALWAYS compute planning deltas in the background (farm-to-table outputs)
//   - Store deltas in Dexie when possible (local-first)
//   - Expose ONLY a tiny, non-overwhelming hint to Meal Planner UI:
//       “Homestead Planner has updated targets”
//
// How it works (safe + soft-wired):
//   - Subscribes to chain events (MealPlanEngine emits mealplan.draft.updated, etc.)
//   - Extracts any optional pipeline payload (component demand / target deltas / inventory deltas)
//   - Normalizes + persists a compact "planning delta snapshot" record
//   - Emits a small hint event (no payload flood)
//
// Notes:
//   - This module does NOT decide UI rendering; it only stores deltas + emits a hint.
//   - VisibilityRulesEngine (or UI) can use the hint to show a single badge/line.
//   - Fully defensive: works even if db tables don’t exist (falls back to in-memory).

/* ------------------------------ Soft Imports ------------------------------ */
let _db = null;
async function getDb() {
  if (_db) return _db;

  const candidates = [
    "@/services/db",
    "@/services/db.js",
    "../db",
    "../db.js",
    "../../services/db",
    "../../services/db.js",
  ];

  for (const p of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const mod = require(p);
      _db = mod?.db || mod?.default || mod;
      if (_db) return _db;
    } catch {}
  }

  _db = null;
  return null;
}

let _eventBus = { emit: () => {}, on: () => () => {} };
function getEventBus() {
  if (getEventBus._resolved) return _eventBus;

  const candidates = [
    "@/services/events/eventBus",
    "@/services/events/eventBus.js",
    "../events/eventBus",
    "../events/eventBus.js",
    "../../services/events/eventBus",
    "../../services/events/eventBus.js",
  ];

  for (const p of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const mod = require(p);
      const eb = mod?.default || mod?.eventBus || mod;
      if (eb?.emit) {
        _eventBus = eb;
        break;
      }
    } catch {}
  }

  getEventBus._resolved = true;
  return _eventBus;
}

/* ----------------------------- Small Utilities ---------------------------- */
function nowIso() {
  return new Date().toISOString();
}
function makeId(prefix = "delta") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}
function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
function safeStr(v, fallback = "") {
  if (v == null) return fallback;
  const s = String(v).trim();
  return s.length ? s : fallback;
}
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function deepCloneJSON(o) {
  try {
    return JSON.parse(JSON.stringify(o ?? null));
  } catch {
    return o ?? null;
  }
}
function microtask(fn) {
  if (typeof queueMicrotask === "function") queueMicrotask(fn);
  else Promise.resolve().then(fn);
}
function idle(fn, timeout = 700) {
  if (typeof window !== "undefined" && window?.requestIdleCallback) {
    window.requestIdleCallback(() => fn(), { timeout });
    return;
  }
  setTimeout(fn, 0);
}

/* -------------------------------------------------------------------------- */
/* Delta normalization                                                         */
/* -------------------------------------------------------------------------- */

function normalizeDeltaItem(x) {
  const o = safeObj(x);
  return {
    id: safeStr(o.id, safeStr(o.itemId, "")),
    label: safeStr(o.label, safeStr(o.name, "")),
    qty: safeNum(o.qty ?? o.amount?.value ?? o.value ?? 0, 0),
    unit: safeStr(o.unit, safeStr(o.amount?.unit, "")),
    delta: safeNum(o.delta ?? o.change ?? 0, 0),
    source: safeStr(o.source, ""),
    why: safeStr(o.why ?? o.reason ?? "", ""),
    meta: safeObj(o.meta),
  };
}

function normalizePipelinePayload(pipeline) {
  const p = safeObj(pipeline);
  const normalizeGroup = (g) => {
    const gg = safeObj(g);
    const items = asArray(gg.items ?? gg.list ?? gg.deltas ?? [])
      .map(normalizeDeltaItem)
      .filter((it) => it.id || it.label);
    return { items, summary: safeStr(gg.summary, "") };
  };

  return {
    raw: deepCloneJSON(p),
    componentDemand: normalizeGroup(p.componentDemand),
    targetDeltas: normalizeGroup(p.targetDeltas),
    inventoryDeltas: normalizeGroup(p.inventoryDeltas),
  };
}

function countsFromPipeline(p) {
  if (!p) return { componentDemand: 0, targetDeltas: 0, inventoryDeltas: 0 };
  return {
    componentDemand: asArray(p.componentDemand?.items).length,
    targetDeltas: asArray(p.targetDeltas?.items).length,
    inventoryDeltas: asArray(p.inventoryDeltas?.items).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Dexie persistence (best-effort)                                             */
/* -------------------------------------------------------------------------- */

// We’ll use the first table found from this list.
const DELTA_TABLE_CANDIDATES = [
  "planningDeltas",
  "plannerDeltas",
  "homesteadDeltas",
  "pipelineDeltas",
  "mealPlanningDeltas",
];

async function getDeltaTable(db) {
  if (!db) return null;
  for (const t of DELTA_TABLE_CANDIDATES) {
    if (db?.[t] && typeof db[t].put === "function") return db[t];
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Hint state (tiny, non-overwhelming)                                         */
/* -------------------------------------------------------------------------- */

const _state = {
  started: false,
  // latest hint per household/person (keys below)
  hintByKey: new Map(), // key = `${householdId}::${personId}`
  // minimal in-memory delta store when no Dexie table exists
  memoryDeltas: new Map(), // key -> latest delta row
  // throttling
  lastEmitAtByKey: new Map(), // key -> timestamp
};

function makeKey({ householdId, personId }) {
  return `${safeStr(householdId, "household")}::${safeStr(personId, "person")}`;
}

function setHint(key, hintRow) {
  _state.hintByKey.set(key, hintRow);
  return hintRow;
}

function getHintForKey(key) {
  return _state.hintByKey.get(key) || null;
}

function emitHint(key, payload) {
  const eb = getEventBus();

  // Throttle to avoid spam if drafts update frequently.
  const now = Date.now();
  const last = _state.lastEmitAtByKey.get(key) || 0;
  if (now - last < 1500) return; // 1.5s throttle

  _state.lastEmitAtByKey.set(key, now);

  try {
    eb.emit({
      type: "homestead.targets.updated.hint",
      ts: nowIso(),
      source: "PlanningDeltaEmitter",
      data: payload,
    });
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[PlanningDeltaEmitter] emit hint failed", e);
  }
}

/* -------------------------------------------------------------------------- */
/* Core background compute + persist                                           */
/* -------------------------------------------------------------------------- */

async function persistDeltaRow(row) {
  const db = await getDb();
  const table = await getDeltaTable(db);

  if (table) {
    try {
      await table.put(row);
      return { persisted: true, tableName: table?.name || "unknown" };
    } catch (e) {
      if (import.meta?.env?.DEV)
        console.warn("[PlanningDeltaEmitter] Dexie put failed", e);
    }
  }

  // fallback: in-memory
  const key = makeKey(row);
  _state.memoryDeltas.set(key, row);
  return { persisted: false, tableName: null };
}

function extractPipelineFromEvent(evt) {
  const d = safeObj(evt?.data);
  const draft = safeObj(d?.draft);
  const pipeline =
    draft?.pipeline ||
    d?.pipeline ||
    d?.farmToTable ||
    d?.farm_to_table ||
    null;

  return {
    householdId: safeStr(
      d.householdId,
      safeStr(draft.householdId, "household"),
    ),
    personId: safeStr(d.personId, safeStr(draft.personId, "person")),
    mealPlanId: safeStr(d.mealPlanId, safeStr(draft.id, "")),
    targetsId: safeStr(d.targetsId, safeStr(draft.targetsId, "")),
    pipeline,
    updatedAt: safeStr(d.updatedAt, safeStr(draft.updatedAt, nowIso())),
  };
}

async function computeAndStoreFromMealPlanUpdate(evt) {
  const extracted = extractPipelineFromEvent(evt);
  const key = makeKey(extracted);

  // If there is no pipeline, do nothing (still no UI overwhelm).
  if (!extracted.pipeline) return null;

  const normalized = normalizePipelinePayload(extracted.pipeline);
  const counts = countsFromPipeline(normalized);

  // If pipeline exists but empty lists, still store for Homestead Planner to read.
  const row = {
    id: makeId("planning_delta"),
    kind: "farm_to_table_pipeline",
    createdAt: nowIso(),
    updatedAt: nowIso(),

    householdId: extracted.householdId,
    personId: extracted.personId,

    // linkage
    mealPlanId: extracted.mealPlanId || null,
    targetsId: extracted.targetsId || null,

    // small metadata so UI can keep it tiny
    counts,
    hasMeaningfulDeltas:
      counts.componentDemand + counts.targetDeltas + counts.inventoryDeltas > 0,

    // the actual deltas (kept in Dexie, not shoved into UI)
    payload: normalized,

    // trace
    source: "mealplan.draft.updated",
  };

  await persistDeltaRow(row);

  // Update hint state (tiny line only)
  const hint = setHint(key, {
    key,
    householdId: extracted.householdId,
    personId: extracted.personId,
    message: "Homestead Planner has updated targets",
    at: nowIso(),
    // keep this minimal; UI can render a dot/badge
    level: "info",
    // allow consumers to deep-link if they want
    link: "/homestead",
  });

  emitHint(key, {
    householdId: hint.householdId,
    personId: hint.personId,
    message: hint.message,
    at: hint.at,
    level: hint.level,
    link: hint.link,
  });

  return row;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

export const PlanningDeltaEmitter = {
  /**
   * Start background listeners once (idempotent).
   * Safe even if eventBus/db aren’t present.
   */
  start() {
    if (_state.started) return () => {};
    _state.started = true;

    const eb = getEventBus();
    if (!eb || typeof eb.on !== "function") {
      if (import.meta?.env?.DEV)
        console.warn(
          "[PlanningDeltaEmitter] eventBus.on not available; background deltas disabled",
        );
      return () => {};
    }

    const onMealDraft = (evt) => {
      // Compute in idle time to reduce UI jank
      idle(() => {
        microtask(async () => {
          try {
            await computeAndStoreFromMealPlanUpdate(evt);
          } catch (e) {
            if (import.meta?.env?.DEV)
              console.warn("[PlanningDeltaEmitter] compute failed", e);
          }
        });
      });
    };

    // Listen to the main draft update event (primary source of pipeline payload)
    const offA = eb.on("mealplan.draft.updated", onMealDraft) || (() => {});

    // Optional: if you later emit pipeline-only updates, we can listen too.
    const offB =
      eb.on("farm_to_table.pipeline.updated", onMealDraft) || (() => {});

    // Return unified unsubscribe
    return () => {
      try {
        offA();
      } catch {}
      try {
        offB();
      } catch {}
    };
  },

  /**
   * Tiny hint getter (non-overwhelming).
   * UI can poll or subscribe to "homestead.targets.updated.hint".
   */
  getHint({ householdId = "household", personId = "person" } = {}) {
    const key = makeKey({ householdId, personId });
    return getHintForKey(key);
  },

  /**
   * Mark the hint as acknowledged/cleared (so UI can hide badge).
   */
  clearHint({ householdId = "household", personId = "person" } = {}) {
    const key = makeKey({ householdId, personId });
    _state.hintByKey.delete(key);
    return true;
  },

  /**
   * Retrieve latest delta snapshot (for Homestead Planner / advanced view),
   * without forcing Meal Planner UI to render details.
   */
  async getLatestDeltas({
    householdId = "household",
    personId = "person",
  } = {}) {
    const key = makeKey({ householdId, personId });

    const db = await getDb();
    const table = await getDeltaTable(db);

    if (table) {
      // best-effort: query by household/person if indexed; fallback to scan
      try {
        // Try common compound index patterns if your schema has them:
        //   [householdId+personId]
        //   householdId, personId
        if (typeof table.where === "function") {
          // Attempt compound where first
          try {
            const rows = await table
              .where("[householdId+personId]")
              .equals([householdId, personId])
              .toArray();
            if (rows?.length) {
              rows.sort((a, b) =>
                String(b.updatedAt || b.createdAt || "").localeCompare(
                  String(a.updatedAt || a.createdAt || ""),
                ),
              );
              return rows[0] || null;
            }
          } catch {}

          // Fallback: filter by personId
          try {
            const rows = await table
              .where("personId")
              .equals(personId)
              .toArray();
            const filtered = (rows || []).filter(
              (r) => String(r?.householdId || "") === String(householdId || ""),
            );
            filtered.sort((a, b) =>
              String(b.updatedAt || b.createdAt || "").localeCompare(
                String(a.updatedAt || a.createdAt || ""),
              ),
            );
            return filtered[0] || null;
          } catch {}
        }
      } catch {}

      // Last resort: full scan (kept rare)
      try {
        const rows = await table.toCollection().toArray();
        const filtered = (rows || []).filter(
          (r) =>
            String(r?.householdId || "") === String(householdId || "") &&
            String(r?.personId || "") === String(personId || ""),
        );
        filtered.sort((a, b) =>
          String(b.updatedAt || b.createdAt || "").localeCompare(
            String(a.updatedAt || a.createdAt || ""),
          ),
        );
        return filtered[0] || null;
      } catch {}
    }

    // fallback: in-memory
    return _state.memoryDeltas.get(key) || null;
  },

  /**
   * Manual push API (optional):
   * If your farm-to-table engine computes deltas elsewhere, you can call this
   * with the payload and we’ll persist + emit only the tiny hint.
   */
  async ingestPipeline({
    householdId = "household",
    personId = "person",
    targetsId = null,
    mealPlanId = null,
    pipeline,
    source = "manual.ingest",
  } = {}) {
    if (!pipeline) return null;

    const key = makeKey({ householdId, personId });

    const normalized = normalizePipelinePayload(pipeline);
    const counts = countsFromPipeline(normalized);

    const row = {
      id: makeId("planning_delta"),
      kind: "farm_to_table_pipeline",
      createdAt: nowIso(),
      updatedAt: nowIso(),
      householdId,
      personId,
      targetsId,
      mealPlanId,
      counts,
      hasMeaningfulDeltas:
        counts.componentDemand + counts.targetDeltas + counts.inventoryDeltas >
        0,
      payload: normalized,
      source,
    };

    await persistDeltaRow(row);

    const hint = setHint(key, {
      key,
      householdId,
      personId,
      message: "Homestead Planner has updated targets",
      at: nowIso(),
      level: "info",
      link: "/homestead",
    });

    emitHint(key, {
      householdId: hint.householdId,
      personId: hint.personId,
      message: hint.message,
      at: hint.at,
      level: hint.level,
      link: hint.link,
    });

    return row;
  },
};

export default PlanningDeltaEmitter;

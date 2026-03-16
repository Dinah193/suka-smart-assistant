// File: src/services/selectors/gardenSelectors.js
// SSA — Garden Selectors (production-ready)
//
// Purpose
// - Deterministic selectors for the Garden domain.
// - Centralize all "read model" logic so UI/pages/engines can query the same way.
// - Works with Dexie (preferred), but degrades gracefully if tables are missing.
// - Zero network calls. Pure-ish. No side-effects (except optional safe DB reads).
//
// Design notes
// - These selectors are intentionally conservative and schema-flexible because
//   your DB is evolving. They try multiple candidate tables/fields.
// - Returned objects include both data + lightweight meta signals when helpful.
// - Use these from shims, planners, dashboards, and KPIs.
//
// Expected DB (best effort)
// - db.gardenTasks or db.tasks (with domain="garden")
// - db.gardenPlans or db.plans (with domain="garden")
// - db.gardenHarvests or db.harvests
// - db.inventory / storehouse items (optional cross-domain)
//
// If your SSA DB uses different names, add the table name to CANDIDATE_TABLES
// below without changing the selector signatures.

import {
  nowMs,
  toISODateTimeLocal,
  safeDate,
} from "@/engines/scheduling/scheduleHelpers";
import { emit } from "@/services/events/eventBus";

/* ------------------------------ utils ------------------------------ */

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function asArray(v) {
  return Array.isArray(v) ? v : v ? [v] : [];
}

function safeNum(v, fallback = 0) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  const nn = safeNum(n, 0);
  return Math.min(max, Math.max(min, nn));
}

function normStr(v) {
  return String(v ?? "").trim();
}

function normLower(v) {
  return normStr(v).toLowerCase();
}

function tryPick(obj, keys, fallback = undefined) {
  if (!isObj(obj)) return fallback;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return fallback;
}

function toDayKey(d) {
  const dt = safeDate(d || new Date());
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseMaybeDate(v) {
  if (!v) return null;
  const d = safeDate(v);
  return Number.isFinite(d?.getTime?.()) ? d : null;
}

function isDexieTable(t) {
  return (
    !!t && (typeof t.toArray === "function" || typeof t.where === "function")
  );
}

function getDbFromAny(provided) {
  // allow passing db explicitly, or fall back to window.__SSA_DB__ if you’ve used that pattern
  if (provided) return provided;
  if (typeof window !== "undefined" && window.__SSA_DB__)
    return window.__SSA_DB__;
  return null;
}

function hasWhere(t) {
  return t && typeof t.where === "function";
}

function isTruthy(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function computeTaskStatus(t) {
  // Normalize status across evolving schemas
  const status = normLower(tryPick(t, ["status", "state"], "")) || "";
  const completed =
    isTruthy(tryPick(t, ["completed", "isCompleted", "done"], false)) ||
    status === "done" ||
    status === "completed" ||
    status === "complete";
  const canceled =
    isTruthy(tryPick(t, ["canceled", "isCanceled"], false)) ||
    status === "canceled" ||
    status === "cancelled";
  const deferred =
    status === "deferred" || status === "postponed" || status === "snoozed";
  const blocked =
    status === "blocked" || isTruthy(tryPick(t, ["blocked"], false));

  if (canceled) return "canceled";
  if (completed) return "done";
  if (blocked) return "blocked";
  if (deferred) return "deferred";
  if (status) return status;
  return "open";
}

function normalizeGardenTask(t) {
  const id = tryPick(t, ["id", "taskId", "key"], null) ?? null;
  const domain = normLower(tryPick(t, ["domain"], "garden"));
  const title =
    normStr(tryPick(t, ["title", "name", "label"], "")) || "Garden task";

  const due =
    parseMaybeDate(
      tryPick(t, ["dueAt", "due", "dueDate", "scheduledFor"], null)
    ) || null;

  const created =
    parseMaybeDate(tryPick(t, ["createdAt", "created", "created_at"], null)) ||
    null;

  const status = computeTaskStatus(t);

  // common garden fields
  const crop = normStr(tryPick(t, ["crop", "plant", "variety"], ""));
  const bed = normStr(tryPick(t, ["bed", "plot", "zone", "location"], ""));
  const qty = tryPick(t, ["qty", "count", "amount"], undefined);
  const unit = normStr(tryPick(t, ["unit"], "")) || undefined;

  const tags = asArray(tryPick(t, ["tags", "intentTags"], []))
    .map((x) => normStr(x))
    .filter(Boolean);

  return {
    ...t,
    id,
    domain: domain || "garden",
    title,
    status,
    dueAt: due ? due.toISOString() : null,
    createdAt: created ? created.toISOString() : null,
    crop: crop || undefined,
    bed: bed || undefined,
    qty: qty === "" ? undefined : qty,
    unit,
    tags,
  };
}

function normalizeHarvest(h) {
  const id = tryPick(h, ["id", "harvestId", "key"], null) ?? null;
  const crop =
    normStr(tryPick(h, ["crop", "plant", "variety", "itemKey"], "")) ||
    "harvest";
  const when =
    parseMaybeDate(
      tryPick(
        h,
        ["date", "harvestedAt", "harvestDate", "ts", "createdAt"],
        null
      )
    ) || null;

  const qty = safeNum(
    tryPick(h, ["qty", "quantity", "amount", "weight"], 0),
    0
  );
  const unit =
    normStr(tryPick(h, ["unit"], "")) ||
    tryPick(h, ["weightUnit"], "") ||
    "unit";

  const preserved = isTruthy(tryPick(h, ["preserved", "isPreserved"], false));
  const movedToRootCellar = isTruthy(
    tryPick(h, ["movedToRootCellar", "rootCellar"], false)
  );

  return {
    ...h,
    id,
    crop,
    harvestedAt: when ? when.toISOString() : null,
    qty,
    unit: unit || "unit",
    preserved,
    movedToRootCellar,
  };
}

/* ------------------------------ candidate tables ------------------------------ */

const CANDIDATE_TABLES = {
  // tasks
  tasks: ["gardenTasks", "tasks", "plannerTasks", "sessionTasks"],

  // plans
  plans: ["gardenPlans", "plans", "plantingPlans"],

  // harvest logs
  harvests: ["gardenHarvests", "harvests", "harvestLog", "harvestLogs"],

  // inventory/storehouse (optional)
  inventory: ["inventory", "storehouse", "storehouseItems", "inventoryItems"],
};

function getFirstTable(db, names) {
  if (!db) return null;
  for (const n of names) {
    const t = db[n];
    if (isDexieTable(t)) return { name: n, table: t };
  }
  return null;
}

async function tableToArraySafe(tableRef) {
  if (!tableRef?.table) return [];
  try {
    return await tableRef.table.toArray();
  } catch {
    return [];
  }
}

async function whereEqSafe(tableRef, key, value) {
  if (!tableRef?.table) return [];
  try {
    const t = tableRef.table;
    if (!hasWhere(t)) return [];
    // Dexie: where(key).equals(value).toArray()
    return await t.where(key).equals(value).toArray();
  } catch {
    return [];
  }
}

async function filterSafe(tableRef, predicate) {
  if (!tableRef?.table) return [];
  try {
    const arr = await tableRef.table.toArray();
    return arr.filter(predicate);
  } catch {
    return [];
  }
}

/* ------------------------------ public selectors ------------------------------ */

/**
 * Get "today" garden tasks.
 * - Supports either a dedicated gardenTasks table OR a generic tasks table with domain="garden".
 */
export async function selectGardenTasksForDay({
  db,
  date = new Date(),
  householdId = null,
  userId = null,
  includeDone = false,
  includeCanceled = false,
  includeDeferred = true,
  limit = 200,
} = {}) {
  const _db = getDbFromAny(db);
  const dayKey = toDayKey(date);

  const taskTable = getFirstTable(_db, CANDIDATE_TABLES.tasks);
  if (!taskTable) {
    return {
      ok: true,
      items: [],
      meta: {
        reason: "no_task_table",
        date: dayKey,
        table: null,
      },
    };
  }

  // Strategy:
  // 1) If tasks are keyed by "dayKey" or "date", prefer that.
  // 2) Else use dueAt/dueDate range.
  // 3) Else return domain-filtered tasks without date filter.
  let rows = [];

  // household filter (best-effort)
  const householdKey = householdId || null;
  const userKey = userId || null;

  // Try common day fields: dayKey, dateKey, day
  const dayFieldCandidates = ["dayKey", "dateKey", "day", "date"];
  for (const f of dayFieldCandidates) {
    // only attempt where() if indexes exist; if not indexed, Dexie will throw.
    // we catch and continue.
    const byDay = await whereEqSafe(taskTable, f, dayKey);
    if (byDay.length) {
      rows = byDay;
      break;
    }
  }

  if (!rows.length) {
    // Try dueAt ISO date prefix
    const all = await tableToArraySafe(taskTable);
    const start = safeDate(`${dayKey}T00:00:00`);
    const end = safeDate(`${dayKey}T23:59:59.999`);
    const startMs = start.getTime();
    const endMs = end.getTime();

    rows = all.filter((t) => {
      const domain = normLower(tryPick(t, ["domain"], "garden"));
      // If this is a generic tasks table, keep only garden domain.
      const domainOk =
        domain === "garden" ||
        domain === "homestead.garden" ||
        domain === "plants" ||
        domain === "planting";
      if (!domainOk) return false;

      const dueRaw = tryPick(
        t,
        ["dueAt", "due", "dueDate", "scheduledFor", "when"],
        null
      );
      const due = parseMaybeDate(dueRaw);
      if (due) {
        const ms = due.getTime();
        return ms >= startMs && ms <= endMs;
      }

      // If no due date, include only if explicitly tagged as "today"
      const tags = asArray(tryPick(t, ["tags", "intentTags"], []))
        .map((x) => normLower(x))
        .filter(Boolean);
      return tags.includes("today") || tags.includes("day:" + dayKey);
    });
  }

  // Apply household/user filters if present
  if (householdKey) {
    rows = rows.filter((t) => {
      const hid = tryPick(t, ["householdId", "household_id"], null);
      return hid == null ? true : String(hid) === String(householdKey);
    });
  }
  if (userKey) {
    rows = rows.filter((t) => {
      const uid = tryPick(t, ["userId", "user_id"], null);
      return uid == null ? true : String(uid) === String(userKey);
    });
  }

  // Normalize + status filters
  let items = rows.map(normalizeGardenTask);

  items = items.filter((t) => {
    const st = t.status;
    if (!includeCanceled && st === "canceled") return false;
    if (!includeDone && st === "done") return false;
    if (!includeDeferred && st === "deferred") return false;
    return true;
  });

  // sort by dueAt then createdAt
  items.sort((a, b) => {
    const da = a.dueAt ? safeDate(a.dueAt).getTime() : Number.POSITIVE_INFINITY;
    const dbb = b.dueAt
      ? safeDate(b.dueAt).getTime()
      : Number.POSITIVE_INFINITY;
    if (da !== dbb) return da - dbb;

    const ca = a.createdAt ? safeDate(a.createdAt).getTime() : 0;
    const cb = b.createdAt ? safeDate(b.createdAt).getTime() : 0;
    return ca - cb;
  });

  if (Number.isFinite(limit) && limit > 0) items = items.slice(0, limit);

  return {
    ok: true,
    items,
    meta: {
      date: dayKey,
      table: taskTable.name,
      total: items.length,
    },
  };
}

/**
 * Get open/past-due garden tasks (for KPIs / nudges).
 */
export async function selectGardenTaskKpis({
  db,
  householdId = null,
  date = new Date(),
} = {}) {
  const _db = getDbFromAny(db);
  const taskTable = getFirstTable(_db, CANDIDATE_TABLES.tasks);

  if (!taskTable) {
    return {
      ok: true,
      kpis: {
        open: 0,
        dueToday: 0,
        overdue: 0,
        doneToday: 0,
      },
      meta: { reason: "no_task_table" },
    };
  }

  const dayKey = toDayKey(date);
  const start = safeDate(`${dayKey}T00:00:00`);
  const end = safeDate(`${dayKey}T23:59:59.999`);
  const startMs = start.getTime();
  const endMs = end.getTime();
  const now = safeDate(date).getTime();

  let rows = await tableToArraySafe(taskTable);

  // Filter garden domain best-effort
  rows = rows.filter((t) => {
    const domain = normLower(tryPick(t, ["domain"], "garden"));
    return (
      domain === "garden" ||
      domain === "homestead.garden" ||
      domain === "plants" ||
      domain === "planting"
    );
  });

  if (householdId) {
    rows = rows.filter((t) => {
      const hid = tryPick(t, ["householdId", "household_id"], null);
      return hid == null ? true : String(hid) === String(householdId);
    });
  }

  const items = rows.map(normalizeGardenTask);

  let open = 0;
  let dueToday = 0;
  let overdue = 0;
  let doneToday = 0;

  for (const t of items) {
    const st = t.status;
    const due = t.dueAt ? safeDate(t.dueAt).getTime() : null;

    if (st === "done") {
      // Count done today by completedAt or by dueAt if no completedAt
      const completedAt = parseMaybeDate(
        tryPick(t, ["completedAt", "completed_at"], null)
      );
      const ms = completedAt ? completedAt.getTime() : due ?? null;
      if (ms != null && ms >= startMs && ms <= endMs) doneToday += 1;
      continue;
    }
    if (st === "canceled") continue;

    open += 1;

    if (due != null) {
      if (due >= startMs && due <= endMs) dueToday += 1;
      if (due < now) overdue += 1;
    }
  }

  return {
    ok: true,
    kpis: { open, dueToday, overdue, doneToday },
    meta: { table: taskTable.name, date: dayKey },
  };
}

/**
 * Harvest summary (today, last 7 days, totals by crop).
 */
export async function selectHarvestSummary({
  db,
  householdId = null,
  days = 7,
  date = new Date(),
  limitCrops = 30,
} = {}) {
  const _db = getDbFromAny(db);
  const harvestTable = getFirstTable(_db, CANDIDATE_TABLES.harvests);

  if (!harvestTable) {
    return {
      ok: true,
      summary: {
        today: [],
        lastNDays: [],
        totalsByCrop: [],
      },
      meta: { reason: "no_harvest_table" },
    };
  }

  const end = safeDate(date);
  const endMs = end.getTime();

  const start = new Date(endMs - clamp(days, 1, 3650) * 24 * 60 * 60 * 1000);
  const startMs = start.getTime();

  const dayKey = toDayKey(end);
  const todayStart = safeDate(`${dayKey}T00:00:00`);
  const todayEnd = safeDate(`${dayKey}T23:59:59.999`);
  const todayStartMs = todayStart.getTime();
  const todayEndMs = todayEnd.getTime();

  let rows = await tableToArraySafe(harvestTable);

  if (householdId) {
    rows = rows.filter((h) => {
      const hid = tryPick(h, ["householdId", "household_id"], null);
      return hid == null ? true : String(hid) === String(householdId);
    });
  }

  const normalized = rows.map(normalizeHarvest).filter((h) => {
    const ms = h.harvestedAt ? safeDate(h.harvestedAt).getTime() : null;
    if (ms == null) return false;
    return ms >= startMs && ms <= endMs;
  });

  const today = normalized.filter((h) => {
    const ms = h.harvestedAt ? safeDate(h.harvestedAt).getTime() : null;
    return ms != null && ms >= todayStartMs && ms <= todayEndMs;
  });

  // totals by crop
  const byCrop = new Map(); // crop -> { crop, qty, unit, preservedCount, movedToRootCellarCount, entries }
  for (const h of normalized) {
    const crop = normLower(h.crop) || "harvest";
    const cur = byCrop.get(crop) || {
      crop,
      qty: 0,
      unit: h.unit || "unit",
      preservedCount: 0,
      movedToRootCellarCount: 0,
      entries: 0,
    };
    cur.qty += safeNum(h.qty, 0);
    cur.entries += 1;
    if (h.preserved) cur.preservedCount += 1;
    if (h.movedToRootCellar) cur.movedToRootCellarCount += 1;
    byCrop.set(crop, cur);
  }

  let totalsByCrop = Array.from(byCrop.values());
  totalsByCrop.sort((a, b) => b.qty - a.qty);
  totalsByCrop = totalsByCrop.slice(0, clamp(limitCrops, 1, 200));

  return {
    ok: true,
    summary: {
      today,
      lastNDays: normalized,
      totalsByCrop,
    },
    meta: { table: harvestTable.name, days, date: toDayKey(date) },
  };
}

/**
 * Garden plan overview (planting plan lines, upcoming events).
 */
export async function selectGardenPlanOverview({
  db,
  householdId = null,
  includeArchived = false,
  limit = 50,
} = {}) {
  const _db = getDbFromAny(db);
  const planTable = getFirstTable(_db, CANDIDATE_TABLES.plans);

  if (!planTable) {
    return {
      ok: true,
      plans: [],
      meta: { reason: "no_plan_table" },
    };
  }

  let rows = await tableToArraySafe(planTable);

  // Filter garden domain best-effort if plans are shared
  rows = rows.filter((p) => {
    const domain = normLower(tryPick(p, ["domain"], "garden"));
    return (
      domain === "garden" ||
      domain === "homestead.garden" ||
      domain === "plants" ||
      domain === "planting" ||
      domain === "plan"
    );
  });

  if (householdId) {
    rows = rows.filter((p) => {
      const hid = tryPick(p, ["householdId", "household_id"], null);
      return hid == null ? true : String(hid) === String(householdId);
    });
  }

  if (!includeArchived) {
    rows = rows.filter(
      (p) => !isTruthy(tryPick(p, ["archived", "isArchived"], false))
    );
  }

  // Normalize lightly
  const plans = rows
    .map((p) => {
      const id = tryPick(p, ["id", "planId", "key"], null) ?? null;
      const title =
        normStr(tryPick(p, ["title", "name", "label"], "")) || "Garden plan";
      const createdAt = parseMaybeDate(
        tryPick(p, ["createdAt", "created_at"], null)
      );
      const updatedAt = parseMaybeDate(
        tryPick(p, ["updatedAt", "updated_at"], null)
      );
      const lines = asArray(tryPick(p, ["lines", "crops", "items"], []));
      const season =
        normStr(tryPick(p, ["season", "seasonTag"], "")) || undefined;
      const status =
        normLower(tryPick(p, ["status", "state"], "active")) || "active";

      return {
        ...p,
        id,
        title,
        status,
        season,
        linesCount: lines.length,
        createdAt: createdAt ? createdAt.toISOString() : null,
        updatedAt: updatedAt ? updatedAt.toISOString() : null,
      };
    })
    .sort((a, b) => {
      const ua = a.updatedAt ? safeDate(a.updatedAt).getTime() : 0;
      const ub = b.updatedAt ? safeDate(b.updatedAt).getTime() : 0;
      return ub - ua;
    })
    .slice(0, clamp(limit, 1, 500));

  return {
    ok: true,
    plans,
    meta: { table: planTable.name, total: plans.length },
  };
}

/**
 * Cross-domain: basic "next actions" suggestions from tasks + plan.
 * Emits a lightweight event if requested (optional).
 */
export async function selectGardenNextActions({
  db,
  householdId = null,
  date = new Date(),
  max = 6,
  emitEvent = false,
} = {}) {
  const [tasksRes, kpiRes] = await Promise.all([
    selectGardenTasksForDay({
      db,
      householdId,
      date,
      includeDone: false,
      includeCanceled: false,
      includeDeferred: true,
      limit: 200,
    }),
    selectGardenTaskKpis({ db, householdId, date }),
  ]);

  const tasks = asArray(tasksRes?.items);
  const kpis = kpiRes?.kpis || {
    open: 0,
    dueToday: 0,
    overdue: 0,
    doneToday: 0,
  };

  // Priority heuristic:
  // - overdue first
  // - then due today
  // - then open/deferred
  const now = safeDate(date).getTime();
  const scored = tasks
    .map((t) => {
      const due = t.dueAt ? safeDate(t.dueAt).getTime() : null;
      let score = 10;

      if (t.status === "blocked") score -= 4;
      if (t.status === "deferred") score -= 2;

      if (due != null && due < now) score += 20; // overdue
      else if (due != null) score += 10; // has due date

      if (t.crop) score += 2;
      if (t.bed) score += 1;

      return { task: t, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, clamp(max, 1, 50))
    .map((x) => x.task);

  const result = {
    ok: true,
    actions: scored,
    meta: {
      date: toDayKey(date),
      kpis,
    },
  };

  if (emitEvent) {
    try {
      emit({
        type: "garden.nextActions.selected",
        ts: toISODateTimeLocal(new Date()),
        source: "services/selectors/gardenSelectors",
        data: {
          householdId: householdId || null,
          date: toDayKey(date),
          actions: scored.map((t) => ({
            id: t.id || null,
            title: t.title,
            status: t.status,
            dueAt: t.dueAt,
            crop: t.crop,
            bed: t.bed,
          })),
          kpis,
        },
      });
    } catch {
      // non-fatal
    }
  }

  return result;
}

/**
 * Garden "context" selector expected by gardenPlanShim:
 * A single, stable payload that shims/agents can use without calling multiple selectors.
 */
export async function selectGardenContext({
  db,
  householdId = null,
  userId = null,
  date = new Date(),
  days = 7,
  includePlans = true,
  includeHarvest = true,
  includeTasks = true,
  includeNextActions = true,
  limits = {
    tasks: 200,
    plans: 50,
    nextActions: 6,
    crops: 30,
  },
} = {}) {
  const dayKey = toDayKey(date);

  const tasksP = includeTasks
    ? selectGardenTasksForDay({
        db,
        date,
        householdId,
        userId,
        includeDone: false,
        includeCanceled: false,
        includeDeferred: true,
        limit: limits?.tasks ?? 200,
      })
    : Promise.resolve({ ok: true, items: [], meta: { skipped: true } });

  const kpisP = selectGardenTaskKpis({ db, householdId, date });

  const plansP = includePlans
    ? selectGardenPlanOverview({
        db,
        householdId,
        includeArchived: false,
        limit: limits?.plans ?? 50,
      })
    : Promise.resolve({ ok: true, plans: [], meta: { skipped: true } });

  const harvestP = includeHarvest
    ? selectHarvestSummary({
        db,
        householdId,
        days,
        date,
        limitCrops: limits?.crops ?? 30,
      })
    : Promise.resolve({
        ok: true,
        summary: { today: [], lastNDays: [], totalsByCrop: [] },
        meta: { skipped: true },
      });

  const nextActionsP = includeNextActions
    ? selectGardenNextActions({
        db,
        householdId,
        date,
        max: limits?.nextActions ?? 6,
        emitEvent: false,
      })
    : Promise.resolve({ ok: true, actions: [], meta: { skipped: true } });

  const [tasksRes, kpisRes, plansRes, harvestRes, nextActionsRes] =
    await Promise.all([tasksP, kpisP, plansP, harvestP, nextActionsP]);

  return {
    ok: true,
    ctx: {
      domain: "garden",
      date: dayKey,
      householdId: householdId || null,
      userId: userId || null,

      // Primary payloads
      tasks: asArray(tasksRes?.items),
      nextActions: asArray(nextActionsRes?.actions),
      kpis: kpisRes?.kpis || {
        open: 0,
        dueToday: 0,
        overdue: 0,
        doneToday: 0,
      },
      plans: asArray(plansRes?.plans),
      harvest: harvestRes?.summary || {
        today: [],
        lastNDays: [],
        totalsByCrop: [],
      },

      // Lightweight meta (useful for audit/debug)
      meta: {
        generatedAt: toISODateTimeLocal(new Date()),
        nowMs: nowMs(),
        sources: {
          tasks: tasksRes?.meta || null,
          kpis: kpisRes?.meta || null,
          plans: plansRes?.meta || null,
          harvest: harvestRes?.meta || null,
          nextActions: nextActionsRes?.meta || null,
        },
      },
    },
  };
}

/* ------------------------------ optional exports for test/dev ------------------------------ */

export const __gardenSelectors = {
  normalizeGardenTask,
  normalizeHarvest,
  toDayKey,
};

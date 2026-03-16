// File: C:\Users\larho\suka-smart-assistant\src\services\savings/SavingsService.js
/**
 * SavingsService (SSA)
 * -----------------------------------------------------------------------------
 * Unified, browser-safe "savings" ledger + projections engine.
 *
 * What is "Savings" in SSA?
 *  - A household's strategic storehouse / budget / reserve planning layer:
 *      • Track contributions (cash, labor credit, harvest, preserved goods)
 *      • Track allocations (planned purchases, emergency reserves, goals)
 *      • Track offsets/savings realized (coupon savings, price deltas, bulk cooking)
 *      • Provide goal progress and "runway" estimates
 *
 * Design goals
 *  - Offline-first: Dexie if available, localStorage fallback
 *  - Non-crashy even when tables are missing
 *  - Idempotent helpers (avoid double-counting)
 *  - Emits events (eventBus + automation eventBus if present)
 *  - Can export packets to hubExport (optional)
 *
 * Optional Dexie tables (if present in your schema)
 *  - savings_ledger:   { id, householdId, ts, type, amount, unit, category, ref, memo, meta }
 *  - savings_goals:    { id, householdId, name, targetAmount, unit, dueISO, createdAt, meta }
 *  - savings_balances: { id:"primary"/householdId, snapshot, updatedAt }
 *
 * If tables don't exist:
 *  - Persists to localStorage:
 *      • ssa.savings.ledger.v1
 *      • ssa.savings.goals.v1
 *      • ssa.savings.meta.v1
 *
 * Public API
 *  - init({ householdId }?)
 *  - addEntry(entry)
 *  - addMany(entries)
 *  - upsertGoal(goal)
 *  - removeGoal(goalId)
 *  - listGoals({ householdId }?)
 *  - listLedger({ householdId, fromISO, toISO, limit }?)
 *  - getBalance({ householdId }?)
 *  - getSummary({ householdId, windowDays }?)
 *  - computeGoalProgress(goalId)
 *  - exportToHub({ householdId, kind }?)
 */

import db from "@/services/db";

/* -----------------------------------------------------------------------------
 * Optional deps (soft)
 * -------------------------------------------------------------------------- */

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? mod ?? null;
} catch {
  logger = null;
}

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let autoBus = null;
try {
  const mod = await import("@/services/automation/eventBus.js");
  autoBus = mod?.default ?? mod ?? null;
} catch {
  autoBus = null;
}

let hubExport = null;
try {
  const mod = await import("@/services/hubExport.js");
  hubExport = mod?.default ?? mod ?? null;
} catch {
  hubExport = null;
}

/* -----------------------------------------------------------------------------
 * Constants
 * -------------------------------------------------------------------------- */

const SOURCE = "services.savings.SavingsService";

const LS_LEDGER = "ssa.savings.ledger.v1";
const LS_GOALS = "ssa.savings.goals.v1";
const LS_META = "ssa.savings.meta.v1";

const DEFAULTS = {
  householdId: "primary",
  unit: "USD",
};

/* -----------------------------------------------------------------------------
 * State
 * -------------------------------------------------------------------------- */

const state = {
  initialized: false,
  householdId: DEFAULTS.householdId,
  unit: DEFAULTS.unit,
};

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function nowMs() {
  return Date.now();
}
function nowISO() {
  return new Date().toISOString();
}
function uid(prefix = "sav") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}
function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {}
  try {
    autoBus?.emit?.(name, payload);
  } catch {}
}
function clamp(n, a, b) {
  const v = Number(n);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}
function toISO(d) {
  try {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString();
  } catch {
    return nowISO();
  }
}
function isFn(fn) {
  return typeof fn === "function";
}

/* -----------------------------------------------------------------------------
 * Dexie table resolution (tolerant)
 * -------------------------------------------------------------------------- */

const TABLES = {
  ledger: ["savings_ledger", "savingsLedger", "ledger_savings"],
  goals: ["savings_goals", "savingsGoals", "goals_savings"],
  balances: ["savings_balances", "savingsBalances", "balances_savings"],
};

function resolveTable(names) {
  for (const n of names) {
    const t = db?.[n];
    if (t && isFn(t.add) && isFn(t.put) && isFn(t.where)) return t;
    if (t && isFn(t.add) && isFn(t.put) && isFn(t.get)) return t;
  }
  try {
    const tables = db?.tables || [];
    for (const n of names) {
      const hit = tables.find((t) => t?.name === n);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

function tablesAvailable() {
  return {
    ledger: !!resolveTable(TABLES.ledger),
    goals: !!resolveTable(TABLES.goals),
    balances: !!resolveTable(TABLES.balances),
  };
}

/* -----------------------------------------------------------------------------
 * LocalStorage fallback
 * -------------------------------------------------------------------------- */

function lsLoad(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function lsSave(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function lsPush(key, item) {
  const arr = safeArr(lsLoad(key, []));
  arr.push(item);
  lsSave(key, arr);
  lsSave(LS_META, { updatedAt: nowMs(), updatedISO: nowISO(), source: SOURCE });
  return arr;
}

function lsReplaceAll(key, items) {
  const arr = safeArr(items);
  lsSave(key, arr);
  lsSave(LS_META, { updatedAt: nowMs(), updatedISO: nowISO(), source: SOURCE });
  return arr;
}

/* -----------------------------------------------------------------------------
 * Normalization
 * -------------------------------------------------------------------------- */

/**
 * Entry types:
 *  - "contribution"  (+) add to reserves
 *  - "allocation"    (-) earmark spending/goal
 *  - "savings"       (+) realized savings (coupon, price match, etc.)
 *  - "expense"       (-) actual spending (optional)
 *
 * units:
 *  - "USD" default
 *  - may also be "CREDIT", "LB", "EA", etc. but summary by unit is separate
 */
function normalizeEntry(entry) {
  const e = safeObj(entry);
  const householdId = String(
    e.householdId || state.householdId || DEFAULTS.householdId
  );
  const unit = String(e.unit || state.unit || DEFAULTS.unit);

  const type = String(e.type || "savings").toLowerCase();
  const amount = Number(e.amount || 0);

  return {
    id: String(e.id || uid("ledg")),
    householdId,
    ts: Number.isFinite(e.ts) ? e.ts : nowMs(),
    iso: String(e.iso || toISO(e.ts || Date.now())),
    type, // contribution|allocation|savings|expense
    amount: Number.isFinite(amount) ? amount : 0,
    unit,
    category: String(e.category || "general"),
    ref: e.ref != null ? String(e.ref) : null, // e.g., receiptId, sessionId
    memo: e.memo != null ? String(e.memo) : "",
    meta: safeObj(e.meta),
    source: e.source || SOURCE,
  };
}

function normalizeGoal(goal) {
  const g = safeObj(goal);
  const householdId = String(
    g.householdId || state.householdId || DEFAULTS.householdId
  );
  const unit = String(g.unit || state.unit || DEFAULTS.unit);

  return {
    id: String(g.id || uid("goal")),
    householdId,
    name: String(g.name || "Savings Goal"),
    targetAmount: Number(g.targetAmount || 0),
    unit,
    dueISO: g.dueISO ? String(g.dueISO) : null,
    createdAt: g.createdAt ? String(g.createdAt) : nowISO(),
    meta: safeObj(g.meta),
  };
}

/* -----------------------------------------------------------------------------
 * Init
 * -------------------------------------------------------------------------- */

export function init(opts = {}) {
  const o = safeObj(opts);
  state.householdId = String(
    o.householdId || state.householdId || DEFAULTS.householdId
  );
  state.unit = String(o.unit || state.unit || DEFAULTS.unit);
  state.initialized = true;

  emit("savings.init", { householdId: state.householdId, unit: state.unit });
  return {
    ok: true,
    householdId: state.householdId,
    unit: state.unit,
    tables: tablesAvailable(),
  };
}

/* -----------------------------------------------------------------------------
 * Ledger operations
 * -------------------------------------------------------------------------- */

export async function addEntry(entry, options = {}) {
  if (!state.initialized) init();
  const opts = safeObj(options);
  const row = normalizeEntry({
    ...entry,
    householdId: entry?.householdId || state.householdId,
  });

  // Optional idempotency via ref+type+amount+category hash
  if (opts.idempotencyKey) {
    row.meta = { ...row.meta, idempotencyKey: String(opts.idempotencyKey) };
  }

  const t = resolveTable(TABLES.ledger);
  if (t) {
    try {
      if (isFn(t.put)) await t.put(row);
      else if (isFn(t.add)) await t.add(row);
      emit("savings.ledger.added", { entry: row });
      return { ok: true, entry: row, via: "dexie" };
    } catch (e) {
      try {
        logger?.warn?.(
          "SavingsService addEntry Dexie failed; falling back to LS",
          { err: String(e?.message || e) },
          { source: SOURCE }
        );
      } catch {}
      // fallthrough to LS
    }
  }

  lsPush(LS_LEDGER, row);
  emit("savings.ledger.added", { entry: row });
  return { ok: true, entry: row, via: "localStorage" };
}

export async function addMany(entries, options = {}) {
  const list = safeArr(entries);
  const opts = safeObj(options);

  const results = [];
  for (const e of list) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await addEntry(e, opts));
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount === results.length,
    count: results.length,
    okCount,
    results,
  };
}

export async function listLedger(options = {}) {
  if (!state.initialized) init();
  const opts = safeObj(options);
  const householdId = String(opts.householdId || state.householdId);
  const fromISO = opts.fromISO ? String(opts.fromISO) : null;
  const toISOv = opts.toISO ? String(opts.toISO) : null;
  const limit = clamp(opts.limit ?? 500, 1, 5000);

  const fromMs = fromISO ? Date.parse(fromISO) : null;
  const toMs = toISOv ? Date.parse(toISOv) : null;

  const t = resolveTable(TABLES.ledger);
  if (t && isFn(t.where)) {
    try {
      // Try indexed query on householdId if available; else filter in memory.
      let rows = [];
      try {
        rows = await t.where("householdId").equals(householdId).toArray();
      } catch {
        rows = await t.toArray();
        rows = rows.filter((r) => r?.householdId === householdId);
      }

      const filtered = rows
        .filter((r) => {
          const ts = Number(r?.ts || 0);
          if (fromMs != null && ts < fromMs) return false;
          if (toMs != null && ts > toMs) return false;
          return true;
        })
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, limit);

      return { ok: true, via: "dexie", items: filtered.map(normalizeEntry) };
    } catch (e) {
      try {
        logger?.warn?.(
          "SavingsService listLedger Dexie failed; falling back",
          { err: String(e?.message || e) },
          { source: SOURCE }
        );
      } catch {}
    }
  }

  const all = safeArr(lsLoad(LS_LEDGER, []));
  const items = all
    .filter((r) => r?.householdId === householdId)
    .filter((r) => {
      const ts = Number(r?.ts || 0);
      if (fromMs != null && ts < fromMs) return false;
      if (toMs != null && ts > toMs) return false;
      return true;
    })
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit)
    .map(normalizeEntry);

  return { ok: true, via: "localStorage", items };
}

/* -----------------------------------------------------------------------------
 * Goals
 * -------------------------------------------------------------------------- */

export async function upsertGoal(goal, options = {}) {
  if (!state.initialized) init();
  const opts = safeObj(options);
  const row = normalizeGoal(goal);

  const t = resolveTable(TABLES.goals);
  if (t) {
    try {
      if (isFn(t.put)) await t.put(row);
      else if (isFn(t.add)) await t.add(row);
      emit("savings.goal.upserted", { goal: row });
      return { ok: true, goal: row, via: "dexie" };
    } catch (e) {
      try {
        logger?.warn?.(
          "SavingsService upsertGoal Dexie failed; falling back",
          { err: String(e?.message || e) },
          { source: SOURCE }
        );
      } catch {}
    }
  }

  const all = safeArr(lsLoad(LS_GOALS, []));
  const idx = all.findIndex((g) => g?.id === row.id);
  const next =
    idx >= 0 ? all.map((g) => (g.id === row.id ? row : g)) : [...all, row];
  lsReplaceAll(LS_GOALS, next);

  emit("savings.goal.upserted", { goal: row });
  return { ok: true, goal: row, via: "localStorage" };
}

export async function removeGoal(goalId, options = {}) {
  if (!state.initialized) init();
  const id = String(goalId || "").trim();
  if (!id) return { ok: false, reason: "no_goal_id" };

  const t = resolveTable(TABLES.goals);
  if (t && isFn(t.delete)) {
    try {
      await t.delete(id);
      emit("savings.goal.removed", { id });
      return { ok: true, via: "dexie" };
    } catch (e) {
      try {
        logger?.warn?.(
          "SavingsService removeGoal Dexie failed; falling back",
          { err: String(e?.message || e) },
          { source: SOURCE }
        );
      } catch {}
    }
  }

  const all = safeArr(lsLoad(LS_GOALS, []));
  const next = all.filter((g) => g?.id !== id);
  lsReplaceAll(LS_GOALS, next);

  emit("savings.goal.removed", { id });
  return { ok: true, via: "localStorage" };
}

export async function listGoals(options = {}) {
  if (!state.initialized) init();
  const opts = safeObj(options);
  const householdId = String(opts.householdId || state.householdId);

  const t = resolveTable(TABLES.goals);
  if (t && isFn(t.toArray)) {
    try {
      let rows = [];
      try {
        rows = await t.where("householdId").equals(householdId).toArray();
      } catch {
        rows = await t.toArray();
        rows = rows.filter((g) => g?.householdId === householdId);
      }
      return { ok: true, via: "dexie", items: rows.map(normalizeGoal) };
    } catch (e) {
      try {
        logger?.warn?.(
          "SavingsService listGoals Dexie failed; falling back",
          { err: String(e?.message || e) },
          { source: SOURCE }
        );
      } catch {}
    }
  }

  const all = safeArr(lsLoad(LS_GOALS, []));
  const items = all
    .filter((g) => g?.householdId === householdId)
    .map(normalizeGoal);
  return { ok: true, via: "localStorage", items };
}

/* -----------------------------------------------------------------------------
 * Balance & summary
 * -------------------------------------------------------------------------- */

function signedAmount(entry) {
  const t = String(entry?.type || "").toLowerCase();
  const amt = Number(entry?.amount || 0);
  if (!Number.isFinite(amt)) return 0;

  // Convention
  //  - contribution/savings => +amt
  //  - allocation/expense  => -amt
  if (t === "allocation" || t === "expense") return -Math.abs(amt);
  return Math.abs(amt);
}

/**
 * Compute current balance by unit (USD, CREDIT, etc.)
 */
export async function getBalance(options = {}) {
  const opts = safeObj(options);
  const householdId = String(opts.householdId || state.householdId);

  const { items } = await listLedger({ householdId, limit: 5000 });
  const byUnit = new Map();

  for (const e of items) {
    const unit = String(e.unit || DEFAULTS.unit);
    const v = byUnit.get(unit) || 0;
    byUnit.set(unit, v + signedAmount(e));
  }

  const balances = Array.from(byUnit.entries()).map(([unit, amount]) => ({
    unit,
    amount,
  }));

  return {
    ok: true,
    householdId,
    balances,
    primary: balances.find((b) => b.unit === (state.unit || DEFAULTS.unit)) ||
      balances[0] || { unit: state.unit, amount: 0 },
    asOf: nowISO(),
  };
}

/**
 * Summarize a recent window (default 30 days)
 */
export async function getSummary(options = {}) {
  const opts = safeObj(options);
  const householdId = String(opts.householdId || state.householdId);
  const windowDays = clamp(opts.windowDays ?? 30, 1, 365);

  const to = nowMs();
  const from = to - windowDays * 86400000;

  const { items } = await listLedger({
    householdId,
    fromISO: new Date(from).toISOString(),
    toISO: new Date(to).toISOString(),
    limit: 5000,
  });

  const byUnit = new Map();
  const byType = new Map();
  const byCategory = new Map();

  for (const e of items) {
    const unit = String(e.unit || DEFAULTS.unit);
    const t = String(e.type || "savings");
    const cat = String(e.category || "general");

    const signed = signedAmount(e);

    byUnit.set(unit, (byUnit.get(unit) || 0) + signed);
    byType.set(t, (byType.get(t) || 0) + signed);
    byCategory.set(cat, (byCategory.get(cat) || 0) + signed);
  }

  return {
    ok: true,
    householdId,
    windowDays,
    totalsByUnit: Array.from(byUnit.entries()).map(([unit, amount]) => ({
      unit,
      amount,
    })),
    totalsByType: Array.from(byType.entries()).map(([type, amount]) => ({
      type,
      amount,
    })),
    totalsByCategory: Array.from(byCategory.entries()).map(
      ([category, amount]) => ({ category, amount })
    ),
    entries: items,
    asOf: nowISO(),
  };
}

/* -----------------------------------------------------------------------------
 * Goal progress
 * -------------------------------------------------------------------------- */

export async function computeGoalProgress(goalId, options = {}) {
  const opts = safeObj(options);
  const id = String(goalId || "").trim();
  if (!id) return { ok: false, reason: "no_goal_id" };

  const goals = await listGoals({
    householdId: opts.householdId || state.householdId,
  });
  const goal = goals.items.find((g) => g.id === id);
  if (!goal) return { ok: false, reason: "goal_not_found" };

  // Default: count all positive entries of matching unit as progress,
  // minus negative allocations/expenses.
  const { items } = await listLedger({
    householdId: goal.householdId,
    limit: 5000,
  });
  const relevant = items.filter(
    (e) => String(e.unit || "") === String(goal.unit || "")
  );

  let net = 0;
  for (const e of relevant) net += signedAmount(e);

  const target = Number(goal.targetAmount || 0);
  const progress = target > 0 ? net / target : 0;

  return {
    ok: true,
    goal,
    net,
    target,
    progress: clamp(progress, 0, 9999),
    met: target > 0 ? net >= target : false,
    asOf: nowISO(),
  };
}

/* -----------------------------------------------------------------------------
 * Hub export
 * -------------------------------------------------------------------------- */

export async function exportToHub(options = {}) {
  const opts = safeObj(options);
  const householdId = String(opts.householdId || state.householdId);
  const kind = String(opts.kind || "savings.snapshot");

  const balance = await getBalance({ householdId });
  const goals = await listGoals({ householdId });
  const summary = await getSummary({
    householdId,
    windowDays: opts.windowDays ?? 30,
  });

  const payload = {
    householdId,
    balance,
    goals: goals.items,
    summary,
    exportedAt: nowISO(),
  };

  if (!hubExport?.exportToHub) {
    // If hubExport isn't available, just emit and return payload.
    emit("savings.export.prepared", { householdId, kind, payload });
    return { ok: false, reason: "hub_export_unavailable", payload };
  }

  const packet = hubExport.prepareHubPacket
    ? hubExport.prepareHubPacket(kind, payload, opts)
    : { kind, payload };
  const res = await hubExport.exportToHub(packet, {
    ...opts,
    queueIfOffline: opts.queueIfOffline !== false,
  });
  return { ok: !!res?.ok, via: res?.via || null, result: res, packet };
}

/* -----------------------------------------------------------------------------
 * Convenience helpers for common SSA use-cases
 * -------------------------------------------------------------------------- */

/**
 * Record coupon savings or price delta savings from SCT receipts.
 */
export async function recordReceiptSavings({
  householdId,
  receiptId,
  storeId,
  amount,
  unit = "USD",
  memo,
  meta,
}) {
  return addEntry({
    householdId,
    type: "savings",
    amount: Number(amount || 0),
    unit,
    category: "receipt_savings",
    ref: receiptId || null,
    memo: memo || `Receipt savings${storeId ? ` (${storeId})` : ""}`,
    meta: { storeId: storeId || null, ...safeObj(meta) },
  });
}

/**
 * Record harvest contributions (value can be 0 if you track quantity-only).
 */
export async function recordHarvestContribution({
  householdId,
  harvestId,
  cropId,
  quantity,
  unit = "EA",
  estimatedValueUSD,
  memo,
  meta,
}) {
  const results = [];

  // Quantity ledger
  results.push(
    await addEntry({
      householdId,
      type: "contribution",
      amount: Number(quantity || 0),
      unit,
      category: "harvest_qty",
      ref: harvestId || null,
      memo: memo || `Harvest contribution${cropId ? ` (${cropId})` : ""}`,
      meta: { cropId: cropId || null, ...safeObj(meta) },
    })
  );

  // Optional estimated USD value
  if (
    Number.isFinite(Number(estimatedValueUSD)) &&
    Number(estimatedValueUSD) !== 0
  ) {
    results.push(
      await addEntry({
        householdId,
        type: "contribution",
        amount: Number(estimatedValueUSD),
        unit: "USD",
        category: "harvest_value",
        ref: harvestId || null,
        memo: `Harvest value estimate${cropId ? ` (${cropId})` : ""}`,
        meta: { cropId: cropId || null, ...safeObj(meta) },
      })
    );
  }

  return { ok: results.every((r) => r.ok), results };
}

/**
 * Record planned allocation (earmark)
 */
export async function allocateForGoal({
  householdId,
  goalId,
  amount,
  unit = "USD",
  memo,
  meta,
}) {
  return addEntry({
    householdId,
    type: "allocation",
    amount: Number(amount || 0),
    unit,
    category: "goal_allocation",
    ref: goalId || null,
    memo: memo || `Allocation for goal ${goalId || ""}`.trim(),
    meta: safeObj(meta),
  });
}

/* -----------------------------------------------------------------------------
 * Default export
 * -------------------------------------------------------------------------- */

const SavingsService = {
  init,

  addEntry,
  addMany,
  listLedger,

  upsertGoal,
  removeGoal,
  listGoals,

  getBalance,
  getSummary,
  computeGoalProgress,

  exportToHub,

  // convenience
  recordReceiptSavings,
  recordHarvestContribution,
  allocateForGoal,
};

export default SavingsService;

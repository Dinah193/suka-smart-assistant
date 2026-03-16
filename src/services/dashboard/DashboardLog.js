// File: src/services/dashboard/DashboardLog.js
/**
 * DashboardLog
 * -----------------------------------------------------------------------------
 * SSA dashboard-safe logging + in-app event feed.
 *
 * Purpose
 *  - Provide a lightweight logger that:
 *      • is browser-safe (no Node imports)
 *      • can be used by services without hard UI dependencies
 *      • optionally persists logs to Dexie (if a table exists)
 *      • emits events to eventBus for UI dashboards
 *      • provides filtering + KPI-friendly queries
 *
 * Design
 *  - "Log entries" are small structured objects:
 *      { id, ts, level, source, message, data, tags, domain }
 *
 * Integration
 *  - Optional eventBus at "@/services/events/eventBus"
 *  - Optional Dexie db at "@/services/db"
 *    • Tries to resolve a best-fit table for logs:
 *        dashboard_logs | dashboardLogs | logs | appLogs
 *
 * Notes
 *  - This module must never crash builds.
 *  - If Dexie table not found or errors occur, it falls back to in-memory ring buffer.
 */

import db from "@/services/db";
import { liveQuery } from "dexie";

/* -----------------------------------------------------------------------------
 * Optional eventBus
 * -------------------------------------------------------------------------- */

let eventBus = null;
try {
  eventBus = (await import("@/services/events/eventBus")).default ?? null;
} catch {
  eventBus = null;
}

const SOURCE = "dashboard.DashboardLog";

const DEFAULTS = Object.freeze({
  maxMemory: 500, // ring buffer size if no DB or DB fails
  maxMessageLen: 1000,
  maxDataLen: 8000, // stringified data clamp
  persistDefault: true,
});

/* -----------------------------------------------------------------------------
 * Table resolution
 * -------------------------------------------------------------------------- */

const TABLE_CANDIDATES = [
  "dashboard_logs",
  "dashboardLogs",
  "logs",
  "appLogs",
  "eventLogs",
];

function resolveTable(dexieDb) {
  if (!dexieDb) return null;

  for (const k of TABLE_CANDIDATES) {
    const t = dexieDb[k];
    if (t && typeof t.toCollection === "function") return t;
  }

  try {
    const tables = dexieDb.tables || [];
    const exact = tables.find((t) =>
      TABLE_CANDIDATES.some(
        (c) => String(t?.name || "").toLowerCase() === c.toLowerCase()
      )
    );
    if (exact) return exact;

    const fuzzy = tables.find((t) => /log/i.test(String(t?.name || "")));
    return fuzzy || null;
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * In-memory ring buffer fallback
 * -------------------------------------------------------------------------- */

const mem = {
  items: [],
};

function ringPush(entry) {
  mem.items.push(entry);
  if (mem.items.length > DEFAULTS.maxMemory) {
    mem.items.splice(0, mem.items.length - DEFAULTS.maxMemory);
  }
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

function nowMs() {
  return Date.now();
}

function genId(prefix = "log") {
  const rnd = Math.random().toString(16).slice(2);
  return `${prefix}_${nowMs().toString(16)}_${rnd}`;
}

function clampStr(s, max) {
  const str = String(s ?? "");
  if (str.length <= max) return str;
  return str.slice(0, max) + `…(truncated ${str.length - max})`;
}

function safeObject(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function normalizeLevel(level) {
  const l = String(level || "info").toLowerCase();
  if (l === "warn" || l === "warning") return "warn";
  if (l === "err" || l === "error") return "error";
  if (l === "debug") return "debug";
  if (l === "trace") return "trace";
  return "info";
}

function normalizeTags(tags) {
  return safeArray(tags)
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 30);
}

function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {
    // ignore
  }
}

function safeStringifyData(data) {
  if (data == null) return null;
  if (typeof data === "string") return clampStr(data, DEFAULTS.maxDataLen);
  try {
    const s = JSON.stringify(data);
    return clampStr(s, DEFAULTS.maxDataLen);
  } catch {
    return clampStr(String(data), DEFAULTS.maxDataLen);
  }
}

/* -----------------------------------------------------------------------------
 * Core write path
 * -------------------------------------------------------------------------- */

async function persist(entry) {
  const t = resolveTable(db);
  if (!t) return false;
  try {
    await t.put(entry);
    return true;
  } catch {
    return false;
  }
}

function makeEntry(level, message, data, opts = {}) {
  const ts = nowMs();
  const entry = {
    id: opts.id ?? genId("log"),
    ts,
    level: normalizeLevel(level),
    source: opts.source ?? opts.module ?? SOURCE,
    domain: opts.domain ?? null,
    message: clampStr(String(message ?? ""), DEFAULTS.maxMessageLen),
    data: data == null ? null : safeObject(data),
    dataText: data == null ? null : safeStringifyData(data), // useful for search + debugging
    tags: normalizeTags(opts.tags),
  };

  // common correlation fields
  if (opts.runId) entry.runId = String(opts.runId);
  if (opts.sessionId) entry.sessionId = String(opts.sessionId);
  if (opts.userId) entry.userId = String(opts.userId);
  if (opts.householdId) entry.householdId = String(opts.householdId);

  return entry;
}

async function write(level, message, data, opts = {}) {
  const entry = makeEntry(level, message, data, opts);

  // emit to UI immediately
  emit("dashboard.log", entry);

  // store in ring buffer always (so UI can show logs without DB)
  ringPush(entry);

  const persistWanted =
    opts.persist !== false && DEFAULTS.persistDefault !== false;
  if (persistWanted) {
    const ok = await persist(entry);
    if (!ok) {
      // keep in-memory; optionally notify once
      emit("dashboard.log.persist.failed", {
        id: entry.id,
        ts: entry.ts,
        source: entry.source,
      });
    }
  }

  return entry;
}

/* -----------------------------------------------------------------------------
 * Query helpers (best-effort)
 * -------------------------------------------------------------------------- */

async function readAllFromDb() {
  const t = resolveTable(db);
  if (!t) return null;
  try {
    return await t.toArray();
  } catch {
    return null;
  }
}

function filterEntries(entries, opts = {}) {
  const {
    level,
    source,
    domain,
    tag,
    query,
    sinceMs,
    untilMs,
    limit = 200,
    sortDir = "desc",
  } = opts;

  const lvl = level ? normalizeLevel(level) : null;
  const src = source ? String(source).toLowerCase() : null;
  const dom = domain ? String(domain).toLowerCase() : null;
  const tg = tag ? String(tag).toLowerCase() : null;
  const q = query ? String(query).toLowerCase() : null;

  const out = (entries || [])
    .filter((e) => (lvl ? normalizeLevel(e.level) === lvl : true))
    .filter((e) =>
      src
        ? String(e.source || "")
            .toLowerCase()
            .includes(src)
        : true
    )
    .filter((e) =>
      dom
        ? String(e.domain || "")
            .toLowerCase()
            .includes(dom)
        : true
    )
    .filter((e) =>
      tg ? safeArray(e.tags).some((x) => String(x).toLowerCase() === tg) : true
    )
    .filter((e) => (sinceMs != null ? Number(e.ts) >= Number(sinceMs) : true))
    .filter((e) => (untilMs != null ? Number(e.ts) <= Number(untilMs) : true))
    .filter((e) => {
      if (!q) return true;
      const blob = [
        e.message,
        e.source,
        e.domain,
        ...(safeArray(e.tags) || []),
        e.dataText,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return blob.includes(q);
    });

  const dir = String(sortDir).toLowerCase() === "asc" ? 1 : -1;
  out.sort((a, b) => (Number(a.ts) - Number(b.ts)) * dir);

  const l = Math.max(0, Number(limit) || 0);
  return l ? out.slice(0, l) : out;
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

const DashboardLog = {
  /* ----- writers ----- */
  log: (message, data, opts) => write("info", message, data, opts),
  info: (message, data, opts) => write("info", message, data, opts),
  warn: (message, data, opts) => write("warn", message, data, opts),
  error: (message, data, opts) => write("error", message, data, opts),
  debug: (message, data, opts) => write("debug", message, data, opts),
  trace: (message, data, opts) => write("trace", message, data, opts),

  /* ----- read/query ----- */

  /**
   * Best-effort list. Prefers DB if present, else memory buffer.
   */
  async list(opts = {}) {
    const dbRows = await readAllFromDb();
    const entries = dbRows || mem.items;
    return filterEntries(entries, opts);
  },

  /**
   * KPIs for dashboard:
   *  - counts by level (sinceMs window)
   */
  async kpis(opts = {}) {
    const sinceMs = opts.sinceMs ?? nowMs() - 24 * 60 * 60 * 1000;
    const entries = await this.list({ sinceMs, limit: 0, sortDir: "desc" });

    const byLevel = entries.reduce((acc, e) => {
      const l = normalizeLevel(e.level);
      acc[l] = (acc[l] || 0) + 1;
      return acc;
    }, {});

    return {
      generatedAt: nowMs(),
      sinceMs,
      total: entries.length,
      byLevel,
    };
  },

  /**
   * Clear memory buffer (does not clear DB).
   */
  clearMemory() {
    mem.items = [];
    emit("dashboard.log.cleared", { where: "memory" });
  },

  /**
   * Clear DB table if present.
   */
  async clearDb() {
    const t = resolveTable(db);
    if (!t) return false;
    try {
      await t.clear();
      emit("dashboard.log.cleared", { where: "db", table: t.name });
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Returns which backend(s) are available.
   */
  backend() {
    const t = resolveTable(db);
    return {
      dexie: !!t,
      tableName: t?.name ?? null,
      memory: true,
      memoryMax: DEFAULTS.maxMemory,
    };
  },

  /* ----- reactive helpers ----- */

  /**
   * Use with dexie-react-hooks useLiveQuery:
   *   const rows = useLiveQuery(DashboardLog.makeLiveList({ level:'error' }), [dep], [])
   */
  makeLiveList(opts = {}) {
    return () =>
      liveQuery(async () => {
        return await DashboardLog.list(opts);
      });
  },
};

export default DashboardLog;

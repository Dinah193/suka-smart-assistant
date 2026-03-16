// src/components/pinboard/ResolveStatusList.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {
  Icons = {
    CheckCircle2: () => null,
    XCircle: () => null,
    Clock: () => null,
    AlertTriangle: () => null,
    Info: () => null,
    RefreshCcw: () => null,
    Trash2: () => null,
    Search: () => null,
    Filter: () => null,
    ChevronDown: () => null,
    ChevronUp: () => null,
    Download: () => null,
    Upload: () => null,
    Zap: () => null,
    ListChecks: () => null,
    Sparkles: () => null,
    UtensilsCrossed: () => null,
    Soup: () => null,
    PinOff: () => null,
    LayoutGrid: () => null,
    CalendarDays: () => null,
    ExternalLink: () => null,
    ShieldAlert: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/events/eventBus").eventBus || eventBus;
} catch {}

let automation = null;
try {
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

let useMealPlanStore = () => ({
  retryAction: null, // optional (entry) => Promise<void> | void
});
try {
  useMealPlanStore =
    require("@/store/MealPlanStore").useMealPlanStore || useMealPlanStore;
} catch {}

/* ---------------------------------- Helpers --------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const STORAGE_KEY = "suka.resolveStatus.ui.v1";
const LOG_KEY = "suka.resolveStatus.log.v1";
const nowISO = () => new Date().toISOString();

const TYPE_META = {
  plan: { label: "Plan", icon: Icons.UtensilsCrossed },
  batch: { label: "Batch", icon: Icons.Soup },
  unpin: { label: "Unpin", icon: Icons.PinOff },
  template: { label: "Template", icon: Icons.LayoutGrid },
  conflict: { label: "Conflict", icon: Icons.ListChecks },
  grocery: { label: "Grocery", icon: Icons.ListChecks },
  standards: { label: "Standards", icon: Icons.ShieldAlert },
  other: { label: "Other", icon: Icons.Info },
};

const STATUS_META = {
  pending: { label: "Pending", tone: "muted", icon: Icons.Clock },
  ok: { label: "Resolved", tone: "ok", icon: Icons.CheckCircle2 },
  partial: { label: "Partial", tone: "warn", icon: Icons.AlertTriangle },
  failed: { label: "Failed", tone: "error", icon: Icons.XCircle },
  skipped: { label: "Skipped", tone: "muted", icon: Icons.ChevronDown },
};

function hydrate(entry = {}) {
  const type = TYPE_META[entry.type] ? entry.type : "other";
  const status = STATUS_META[entry.status] ? entry.status : "pending";
  return {
    id: entry.id || `rs-${Math.random().toString(36).slice(2, 8)}`,
    type,
    status,
    title: entry.title || entry.message || "Action",
    message: entry.message || "",
    count: Number(entry.count || 0),
    when: entry.when || nowISO(),
    link: entry.link || null,
    meta: entry.meta || {},
  };
}

function saveLog(list) {
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list.slice(0, 500))); // cap
  } catch {}
}
function loadLog() {
  try {
    return JSON.parse(localStorage.getItem(LOG_KEY) || "[]");
  } catch {
    return [];
  }
}

/* ---------------------------------- Component --------------------------------- */
export default function ResolveStatusList({
  /** Optional: externally supplied items. If omitted, this component listens to eventBus and builds its own list. */
  items,
  /** Called when a row is clicked/opened */
  onOpen, // (entry) => void
  /** Optional: override retry logic per row */
  onRetry, // (entry) => Promise<void> | void
  /** Optional: initial collapsed state for details */
  defaultCollapsed = false,
  className,
}) {
  const {
    CheckCircle2,
    XCircle,
    Clock,
    AlertTriangle,
    Info,
    RefreshCcw,
    Trash2,
    Search,
    Filter,
    ChevronDown,
    ChevronUp,
    Download,
    Upload,
    Zap,
    ExternalLink,
  } = Icons;

  const ChevronDownIcon = ChevronDown || (() => null);
  const ChevronUpIcon = ChevronUp || (() => null);

  const mealPlan = useMealPlanStore();

  /* ----------------------------------- State ---------------------------------- */
  const [log, setLog] = useState(() =>
    Array.isArray(items) ? items.map(hydrate) : loadLog()
  );
  const [q, setQ] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("open"); // open|ok|failed|all
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [busy, setBusy] = useState(false);

  // Persist UI settings (not the log—log is persisted separately)
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (saved.typeFilter) setTypeFilter(saved.typeFilter);
      if (saved.statusFilter) setStatusFilter(saved.statusFilter);
      if (typeof saved.collapsed === "boolean") setCollapsed(saved.collapsed);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ typeFilter, statusFilter, collapsed })
      );
    } catch {}
  }, [typeFilter, statusFilter, collapsed]);

  // When items prop changes, replace our log
  useEffect(() => {
    if (Array.isArray(items)) {
      setLog(items.map(hydrate));
    }
  }, [items]);

  // EventBus ingestion (when items prop is not controlling)
  useEffect(() => {
    if (Array.isArray(items)) return; // controlled externally

    const add = (e) =>
      setLog((prev) => {
        const next = [hydrate(e), ...prev];
        saveLog(next);
        return next;
      });

    const mark = (predicate, patch) =>
      setLog((prev) => {
        const next = prev.map((x) => (predicate(x) ? { ...x, ...patch } : x));
        saveLog(next);
        return next;
      });

    const handlers = [
      // Pinboard bulk actions
      [
        "pinboard.plan",
        (e) =>
          add({
            type: "plan",
            status: "ok",
            title: "Added to plan",
            count: e?.count,
            when: nowISO(),
          }),
      ],
      [
        "pinboard.batch",
        (e) =>
          add({
            type: "batch",
            status: "ok",
            title: "Added to batch queue",
            count: e?.count,
            when: nowISO(),
          }),
      ],
      [
        "pinboard.unpin",
        (e) =>
          add({
            type: "unpin",
            status: "ok",
            title: "Unpinned",
            count: e?.count,
            when: nowISO(),
          }),
      ],

      // Planner conflicts
      [
        "meals.planner.conflicts.summary",
        (e) =>
          add({
            type: "conflict",
            status: e?.total ? "partial" : "ok",
            title: e?.total
              ? `Conflicts detected (${e.total})`
              : "No conflicts",
            message: e?.high ? `${e.high} high` : "",
            when: nowISO(),
          }),
      ],
      [
        "meals.planner.conflict.resolved",
        (e) =>
          add({
            type: "conflict",
            status: "ok",
            title: "Conflict resolved",
            message: e?.type,
            when: nowISO(),
          }),
      ],
      [
        "meals.planner.conflict.resolveAll",
        (e) =>
          add({
            type: "conflict",
            status: "ok",
            title: "Resolve all complete",
            message: `${e?.total || 0} processed`,
            when: nowISO(),
          }),
      ],

      // Grocery add
      [
        "meals.grocery.added",
        (e) =>
          add({
            type: "grocery",
            status: "ok",
            title: "Grocery items added",
            count: e?.count,
            when: nowISO(),
          }),
      ],

      // Template apply/preview
      [
        "meals.plan.applyTemplate",
        (e) =>
          add({
            type: "template",
            status: "ok",
            title: "Template applied",
            message: e?.title,
            when: nowISO(),
          }),
      ],
      [
        "meals.plan.previewTemplate",
        (e) =>
          add({
            type: "template",
            status: "pending",
            title: "Preview template",
            when: nowISO(),
          }),
      ],

      // Batch add (from RecipeCard)
      [
        "meals.batch.added",
        (e) =>
          add({
            type: "batch",
            status: "ok",
            title: "Added to batch",
            message: e?.title,
            when: nowISO(),
          }),
      ],

      // Generic error hook
      [
        "error",
        (e) =>
          add({
            type: "other",
            status: "failed",
            title: e?.title || "Error",
            message: e?.message || "",
            when: nowISO(),
          }),
      ],
    ];

    handlers.forEach(([evt, fn]) => eventBus.on(evt, fn));
    return () => handlers.forEach(([evt, fn]) => eventBus.off(evt, fn));
  }, [items]);

  /* --------------------------------- Filters --------------------------------- */
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();

    return log.filter((row) => {
      const typeOk = typeFilter === "all" || row.type === typeFilter;
      const statusOk =
        statusFilter === "all" ||
        (statusFilter === "open"
          ? row.status === "pending" ||
            row.status === "partial" ||
            row.status === "failed"
          : row.status === statusFilter);
      const textOk =
        !needle ||
        [row.title, row.message, row.meta?.reason, row.meta?.detail]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle);

      return typeOk && statusOk && textOk;
    });
  }, [log, q, typeFilter, statusFilter]);

  const counts = useMemo(() => {
    const c = {
      total: log.length,
      ok: 0,
      failed: 0,
      pending: 0,
      partial: 0,
      open: 0,
    };
    for (const r of log) {
      c[r.status] = (c[r.status] || 0) + 1;
    }
    c.open = (c.pending || 0) + (c.partial || 0) + (c.failed || 0);
    return c;
  }, [log]);

  const progress = useMemo(() => {
    if (!log.length) return 0;
    const resolved = log.filter((r) => r.status === "ok").length;
    return Math.round((resolved / log.length) * 100);
  }, [log]);

  /* --------------------------------- Actions --------------------------------- */
  async function retry(entry) {
    try {
      setBusy(true);
      // Prefer external retry; else store; else automation
      if (typeof onRetry === "function") await onRetry(entry);
      else if (typeof mealPlan.retryAction === "function")
        await mealPlan.retryAction(entry);
      else if (automation?.runTemplate)
        await automation.runTemplate("meals.generic.retry", { entry });
      // Mark ok if we reached here without throwing
      setLog((prev) => {
        const next = prev.map((r) =>
          r.id === entry.id ? { ...r, status: "ok", when: nowISO() } : r
        );
        saveLog(next);
        return next;
      });
    } catch (e) {
      // Keep failed but update timestamp
      setLog((prev) => {
        const next = prev.map((r) =>
          r.id === entry.id
            ? {
                ...r,
                status: "failed",
                when: nowISO(),
                meta: { ...r.meta, reason: e?.message || "Retry failed" },
              }
            : r
        );
        saveLog(next);
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  async function retryAllFailed() {
    const todo = filtered.filter(
      (r) =>
        r.status === "failed" ||
        r.status === "partial" ||
        r.status === "pending"
    );
    if (!todo.length) return;
    setBusy(true);
    for (const entry of todo) {
      // eslint-disable-next-line no-await-in-loop
      await retry(entry);
    }
    setBusy(false);
  }

  function clearAll() {
    setLog([]);
    saveLog([]);
  }

  function exportLog() {
    try {
      const payload = JSON.stringify(log, null, 2);
      const blob = new Blob([payload], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `resolve-log-${Date.now()}.json`;
      link.click();
    } catch {}
  }

  /* ---------------------------------- UI bits --------------------------------- */
  const ToneBadge = ({ status }) => {
    const meta = STATUS_META[status] || STATUS_META.pending;
    const Icon = meta.icon || Info;
    const tone =
      status === "ok"
        ? "bg-emerald-50 text-emerald-700 border-emerald-200"
        : status === "failed"
        ? "bg-rose-50 text-rose-700 border-rose-200"
        : status === "partial"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-gray-50 text-gray-700 border-gray-200";
    return (
      <span
        className={cx(
          "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border",
          tone
        )}
      >
        <Icon className="w-3 h-3" />
        {meta.label}
      </span>
    );
  };

  const TypePill = ({ type }) => {
    const meta = TYPE_META[type] || TYPE_META.other;
    const Icon = meta.icon || Info;
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border bg-gray-50 text-gray-700 border-gray-200">
        <Icon className="w-3 h-3" />
        {meta.label}
      </span>
    );
  };

  const Row = ({ row }) => {
    return (
      <div
        className="rounded-xl border border-gray-200 bg-white p-3 flex items-start justify-between gap-3"
        role="button"
        tabIndex={0}
        onClick={() => onOpen?.(row)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen?.(row)}
        aria-label={`Open ${row.title}`}
      >
        <div className="flex items-start gap-3">
          <ToneBadge status={row.status} />
          <div>
            <div className="text-sm font-medium text-gray-900">{row.title}</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {row.message}
              {row.count ? (
                <span className="ml-1 text-gray-500">• {row.count}</span>
              ) : null}
              <span className="ml-1 text-gray-400">
                • {new Date(row.when).toLocaleString()}
              </span>
            </div>
            {!collapsed && row.meta && (row.meta.reason || row.meta.detail) ? (
              <div className="mt-1 text-[11px] text-gray-500">
                {row.meta.reason || row.meta.detail}
              </div>
            ) : null}
            <div className="mt-1 flex items-center gap-1">
              <TypePill type={row.type} />
              {row.link ? (
                <a
                  href={row.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-900"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="w-3 h-3" />
                  Open
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {row.status === "failed" ||
          row.status === "partial" ||
          row.status === "pending" ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                retry(row);
              }}
              disabled={busy}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs bg-white border-gray-300 hover:bg-gray-50 disabled:opacity-60"
              title="Retry"
            >
              <RefreshCcw className="w-4 h-4" /> Retry
            </button>
          ) : null}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setLog((prev) => {
                const next = prev.filter((x) => x.id !== row.id);
                saveLog(next);
                return next;
              });
            }}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-xs bg-white border-gray-300 hover:bg-gray-50"
            title="Remove from list"
          >
            <Trash2 className="w-4 h-4" /> Remove
          </button>
        </div>
      </div>
    );
  };

  /* ------------------------------------ JSX ----------------------------------- */
  return (
    <section
      className={cx("w-full", className)}
      aria-label="Resolution status list"
    >
      {/* Header */}
      <div className="rounded-2xl border bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white p-3 mb-3">
        <div className="flex items-center gap-3">
          {/* Progress */}
          <div className="flex-1">
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
              <span>Progress</span>
              <span>
                {counts.ok} ok • {counts.open} open • {counts.failed || 0}{" "}
                failed
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
              <div
                className={cx(
                  "h-full",
                  progress >= 100
                    ? "bg-emerald-600"
                    : progress >= 60
                    ? "bg-emerald-400"
                    : progress > 0
                    ? "bg-amber-400"
                    : "bg-gray-300"
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={retryAllFailed}
              disabled={busy || !filtered.some((r) => r.status !== "ok")}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-gray-300 text-sm hover:bg-gray-50 disabled:opacity-50"
              title="Retry all shown"
            >
              <Zap className="w-4 h-4" />
              Retry all
            </button>
            <button
              type="button"
              onClick={exportLog}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-gray-300 text-sm hover:bg-gray-50"
            >
              <Download className="w-4 h-4" />
              Export
            </button>
            <button
              type="button"
              onClick={() => setCollapsed((v) => !v)}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-gray-300 text-sm hover:bg-gray-50"
            >
              {collapsed ? (
                <ChevronDownIcon className="w-4 h-4" />
              ) : (
                <ChevronUpIcon className="w-4 h-4" />
              )}
              {collapsed ? "Show details" : "Hide details"}
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border bg-white border-rose-300 text-rose-700 text-sm hover:bg-rose-50"
              title="Clear all"
            >
              <Trash2 className="w-4 h-4" />
              Clear
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-3 flex flex-col md:flex-row md:items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-gray-500 absolute left-3 top-2.5" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search activity…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2 py-1 rounded border border-gray-300 text-sm"
            >
              <option value="open">Open</option>
              <option value="ok">Resolved</option>
              <option value="failed">Failed</option>
              <option value="all">All</option>
            </select>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500">Type</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              className="px-2 py-1 rounded border border-gray-300 text-sm"
            >
              <option value="all">All</option>
              {Object.keys(TYPE_META).map((t) => (
                <option key={t} value={t}>
                  {TYPE_META[t].label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* List */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {filtered.length ? (
          filtered.map((row) => <Row key={row.id} row={row} />)
        ) : (
          <div className="col-span-full rounded-xl border border-dashed p-6 text-center text-sm text-gray-600 bg-white">
            No activity yet. When you use <strong>Plan</strong>,{" "}
            <strong>Batch</strong>, apply a <strong>Template</strong>, or run{" "}
            <strong>Resolve all</strong> in the planner, you’ll see results
            here.
          </div>
        )}
      </div>

      {/* Footer tip */}
      <div className="mt-3 text-[11px] text-gray-500 flex items-center gap-2">
        <Filter className="w-3 h-3" />
        Tip: filter to <em>Open</em> to focus on pending/failed items; use{" "}
        <kbd className="px-1 border rounded bg-white">Retry all</kbd> after
        fixing settings (e.g., inventory or standards).
      </div>
    </section>
  );
}

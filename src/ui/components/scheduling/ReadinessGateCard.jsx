// C:\Users\larho\suka-smart-assistant\src\ui\components\scheduling\ReadinessGateCard.jsx
// -----------------------------------------------------------------------------
// SSA UI — ReadinessGateCard
// Lists upcoming T-x gates for sessions and shows pass/fail results per gate.
// Designed to pair with GatekeeperController (readiness checks & contingencies).
//
// How this fits the pipeline:
//   imports → intelligence → automation → (optional) hub export → **UI**
//   This component is *read-only*. It renders gate outcomes and emits a small
//   set of UI events so other panels can react (e.g., open a detail drawer).
//
// Props:
//   - gates: Array<GateLike> (see shape below)
//   - title?: string (default "Readiness Gates")
//   - timezone?: IANA tz string (default "America/Chicago")
//   - nowISO?: string override of now
//   - onRefresh?: () => void    (optional, e.g., to re-fetch gates)
//   - onInspectGate?: (gate) => void
//   - filter?: "all" | "pending" | "failed" (default "pending")
//
// GateLike shape (typical):
//   {
//     id: "sess_123@T-30",
//     sessionId: "sess_123",
//     sessionTitle: "Roast Chicken",
//     domain: "cooking",
//     gate: { label: "T-30", minutes: 30 },
//     atISO: "2025-11-09T01:30:00.000Z",
//     status: "pending" | "passed" | "failed",
//     checks: [
//       { id: "inv", label: "Inventory ready", pass: true, severity: "info", detail: "" },
//       { id: "equip", label: "Equipment available", pass: false, severity: "warn", detail: "Oven busy" },
//       ...
//     ]
//   }
//
// Events emitted (via eventBus) with payload { type, ts, source, data }:
//   - ui.readinessGate.inspect
//   - ui.readinessGate.refresh
//
// No third-party date libs; TailwindCSS + lucide-react icons.
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Circle,
  AlertTriangle,
  Info,
  RefreshCw,
  Filter,
} from "lucide-react";

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  // Defensive dynamic import; component still works if bus not present.
  // eslint-disable-next-line import/no-unresolved
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_) {}

const SRC = "ui.components.scheduling.ReadinessGateCard";

export default function ReadinessGateCard({
  gates = [],
  title = "Readiness Gates",
  timezone = "America/Chicago",
  nowISO,
  onRefresh,
  onInspectGate,
  filter = "pending",
}) {
  const [localFilter, setLocalFilter] = useState(filter);
  const now = useMemo(() => new Date(nowISO || Date.now()), [nowISO]);

  // Optional auto-refresh on relevant runtime events
  useEffect(() => {
    const interesting = new Set([
      "gatekeeper.resolve.completed",
      "gatekeeper.reschedule.moved",
      "inventory.updated",
      "inventory.shortage.detected",
      "risk.session.action.applied",
    ]);
    const handler = (evt) => {
      if (evt && interesting.has(evt.type)) {
        if (typeof onRefresh === "function") onRefresh();
      }
    };
    if (eventBus && typeof eventBus.on === "function") {
      eventBus.on(handler);
      return () => eventBus.off && eventBus.off(handler);
    }
  }, [onRefresh]);

  const filtered = useMemo(() => {
    const arr = Array.isArray(gates) ? gates.slice() : [];
    arr.sort((a, b) => safeDate(a.atISO) - safeDate(b.atISO)); // soonest first
    switch (localFilter) {
      case "failed":
        return arr.filter(
          (g) =>
            g.status === "failed" ||
            (g.checks || []).some((c) => c && c.pass === false)
        );
      case "pending":
        return arr.filter((g) => g.status === "pending");
      default:
        return arr;
    }
  }, [gates, localFilter]);

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white shadow-sm">
      <Header
        title={title}
        timezone={timezone}
        now={now}
        filter={localFilter}
        onFilterChange={setLocalFilter}
        onRefresh={() => {
          if (typeof onRefresh === "function") onRefresh();
          try {
            eventBus.emit({
              type: "ui.readinessGate.refresh",
              ts: isoNow(),
              source: SRC,
              data: {},
            });
          } catch (_) {}
        }}
      />

      {filtered.length === 0 ? (
        <EmptyState filter={localFilter} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {filtered.map((g) => (
            <GateRow
              key={g.id || `${g.sessionId}@${g.gate?.label || g.atISO}`}
              gate={g}
              timezone={timezone}
              now={now}
              onInspect={() => {
                if (typeof onInspectGate === "function") onInspectGate(g);
                try {
                  eventBus.emit({
                    type: "ui.readinessGate.inspect",
                    ts: isoNow(),
                    source: SRC,
                    data: { id: g.id, sessionId: g.sessionId },
                  });
                } catch (_) {}
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function Header({ title, timezone, now, filter, onFilterChange, onRefresh }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-slate-50 rounded-t-2xl">
      <div className="flex items-center gap-2">
        <Clock className="w-4 h-4 text-slate-500" />
        <span className="font-semibold text-slate-700">{title}</span>
        <span className="text-xs text-slate-500">
          {fmtDate(now, timezone)}{" "}
          <span className="text-slate-400">({timezone})</span>
        </span>
      </div>
      <div className="flex items-center gap-2">
        <div className="relative">
          <button
            className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
            title="Filter"
          >
            <Filter className="w-3.5 h-3.5" />
            Filter
          </button>
          <div className="absolute right-0 mt-1 w-36 rounded-xl border bg-white shadow p-1 text-xs z-10 invisible group-hover:visible hidden">
            {/* reserved for future dropdown */}
          </div>
        </div>
        <FilterTabs value={filter} onChange={onFilterChange} />
        <button
          onClick={onRefresh}
          title="Refresh"
          className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
      </div>
    </div>
  );
}

function FilterTabs({ value, onChange }) {
  const base = "px-2 py-1 rounded-lg text-xs";
  const active = "bg-slate-800 text-white";
  const idle = "bg-slate-100 text-slate-700 hover:bg-slate-200";
  return (
    <div className="flex gap-1">
      <button
        className={`${base} ${value === "pending" ? active : idle}`}
        onClick={() => onChange("pending")}
      >
        Pending
      </button>
      <button
        className={`${base} ${value === "failed" ? active : idle}`}
        onClick={() => onChange("failed")}
      >
        Failed
      </button>
      <button
        className={`${base} ${value === "all" ? active : idle}`}
        onClick={() => onChange("all")}
      >
        All
      </button>
    </div>
  );
}

function GateRow({ gate, timezone, now, onInspect }) {
  const start = safeDate(gate.atISO);
  const mins = Math.max(0, Math.round((start - now.getTime()) / 60000));
  const dueIn = mins === 0 ? "now" : `in ${mins}m`;
  const b = badge(gate.domain);

  const status = gate.status || deriveStatus(gate);
  const statusChip = chip(status);

  return (
    <li className="px-4 py-3 hover:bg-slate-50">
      <div className="flex items-start gap-3">
        {/* Domain / gate label */}
        <div className="min-w-[56px]">
          <span
            className={`inline-flex items-center justify-center text-[10px] font-semibold rounded-md px-2 py-1 ${b.bg} ${b.text}`}
          >
            {gate.gate?.label || "T-x"}
          </span>
        </div>

        {/* Main */}
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span className="text-slate-800 text-sm font-medium line-clamp-1">
              {gate.sessionTitle || "(untitled session)"}
            </span>
            <span
              className={`text-[10px] rounded px-1.5 py-0.5 ${statusChip.bg} ${statusChip.text}`}
            >
              {statusChip.label}
            </span>
            <span className="text-[11px] text-slate-500">
              {fmtTime(start, timezone)}{" "}
              <span className="text-slate-400">({dueIn})</span>
            </span>
          </div>

          {/* Checks */}
          <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
            {(gate.checks || []).map((c) => (
              <CheckPill key={c.id || c.label} check={c} />
            ))}
            {(gate.checks || []).length === 0 && (
              <div className="text-[12px] text-slate-500 flex items-center gap-1">
                <Info className="w-3.5 h-3.5" /> No checks attached to this
                gate.
              </div>
            )}
          </div>
        </div>

        {/* Inspect */}
        <div className="flex items-center">
          <button
            onClick={onInspect}
            className="text-xs rounded-lg border border-slate-200 px-2 py-1 text-slate-700 hover:bg-slate-100"
          >
            Inspect
          </button>
        </div>
      </div>
    </li>
  );
}

function CheckPill({ check }) {
  const pass = !!check.pass;
  const Sev = iconForSev(check.severity, pass);
  const bg = pass
    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
    : check.severity === "error"
    ? "bg-rose-50 text-rose-700 border-rose-200"
    : "bg-amber-50 text-amber-700 border-amber-200";
  return (
    <div
      className={`flex items-center gap-1.5 text-[12px] border rounded-md px-2 py-1 ${bg}`}
      title={check.detail || ""}
    >
      <Sev className="w-3.5 h-3.5" />
      <span className="truncate">{check.label || "Check"}</span>
      {check.actionSuggestion && !pass && (
        <span className="truncate text-[11px] opacity-80">
          • {check.actionSuggestion}
        </span>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function badge(domain) {
  switch (String(domain || "general").toLowerCase()) {
    case "cooking":
      return { bg: "bg-emerald-100", text: "text-emerald-800" };
    case "cleaning":
      return { bg: "bg-sky-100", text: "text-sky-800" };
    case "garden":
      return { bg: "bg-lime-100", text: "text-lime-800" };
    case "animal":
      return { bg: "bg-amber-100", text: "text-amber-900" };
    case "preservation":
      return { bg: "bg-fuchsia-100", text: "text-fuchsia-800" };
    case "storehouse":
      return { bg: "bg-indigo-100", text: "text-indigo-800" };
    default:
      return { bg: "bg-slate-100", text: "text-slate-800" };
  }
}

function chip(status) {
  switch (status) {
    case "passed":
      return {
        label: "Passed",
        bg: "bg-emerald-100",
        text: "text-emerald-800",
      };
    case "failed":
      return { label: "Failed", bg: "bg-rose-100", text: "text-rose-800" };
    default:
      return { label: "Pending", bg: "bg-slate-100", text: "text-slate-800" };
  }
}

function iconForSev(sev, pass) {
  if (pass) return CheckCircle2;
  switch (sev) {
    case "error":
      return XCircle;
    case "warn":
      return AlertTriangle;
    default:
      return Circle;
  }
}

function deriveStatus(gate) {
  const checks = gate.checks || [];
  if (
    checks.some(
      (c) =>
        c &&
        c.pass === false &&
        (c.severity === "error" || c.severity === "warn")
    )
  )
    return "failed";
  if (checks.length > 0 && checks.every((c) => c && c.pass === true))
    return "passed";
  return "pending";
}

function fmtDate(d, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "short",
    day: "2-digit",
  });
  return dtf.format(d);
}
function fmtTime(epochMs, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return dtf.format(epochMs);
}
function safeDate(iso) {
  const t = Date.parse(iso || "");
  return Number.isFinite(t) ? t : Date.now() + 365 * 24 * 3600 * 1000; // push invalid to far future so they sort last
}
function isoNow() {
  return new Date().toISOString();
}

// -----------------------------------------------------------------------------
// Empty State
// -----------------------------------------------------------------------------

function EmptyState({ filter }) {
  const msg =
    filter === "failed"
      ? "No failed gates right now."
      : filter === "pending"
      ? "No pending gates right now."
      : "No gates to show.";
  return (
    <div className="py-10 text-center text-slate-500">
      <Info className="w-4 h-4 inline mr-1 align-[-2px]" />
      {msg}
    </div>
  );
}

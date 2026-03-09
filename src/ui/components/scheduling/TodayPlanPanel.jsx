// C:\Users\larho\suka-smart-assistant\src\ui\components\scheduling\TodayPlanPanel.jsx
// -----------------------------------------------------------------------------
// SSA UI — TodayPlanPanel
// Shows each session’s planned start, deadline, and uncertainty bars (P50/P80/P95)
// across the current day timeline.
//
// How this fits the pipeline:
//   imports → intelligence → automation → (optional) hub export → **UI**
//   This component visualizes the automation outcome: sessions admitted & planned
//   by the scheduling engine. It is *read-only* and does not mutate data. It can
//   listen to runtime events via eventBus to refresh its view.
//
// Props:
//   - sessions: Array<SessionLike> where each item can include:
//       {
//         id, title, domain, status, priority,
//         plannedStartISO, deadlineISO, plannedEndISO?,
//         estimatedMinutes,
//         uncertainty?: { p50?: number, p80?: number, p95?: number }, // minutes
//         meta?: { kind?: string }
//       }
//   - timezone?: IANA tz string (default "America/Chicago")
//   - nowISO?: string (ISO for "now"; default new Date().toISOString())
//   - compact?: boolean (denser row height)
//   - onSelect?: (session) => void
//   - onRefresh?: () => void    // optional callback after eventBus tick
//
// Events (emitted to eventBus with { type, ts, source, data }):
//   - ui.todayPlan.select
//
// Defensive design notes:
//   - If uncertainty is missing, falls back to estimatedMinutes as P50.
//   - Robust to missing plannedStartISO or deadlineISO; such rows render at top with warnings.
//   - Does not crash if eventBus/config are unavailable.
//
// Dependencies: TailwindCSS, lucide-react (icons). No 3rd-party date libs.
// -----------------------------------------------------------------------------

import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Timer,
  ScanLine,
  Info,
  RefreshCw,
} from "lucide-react";

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  // Defensive import; panel still works if bus not present.
  // eslint-disable-next-line import/no-unresolved
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_) {}

const SOURCE = "ui.components.scheduling.TodayPlanPanel";
const DAY_MIN = 24 * 60;

export default function TodayPlanPanel({
  sessions = [],
  timezone = "America/Chicago",
  nowISO,
  compact = false,
  onSelect,
  onRefresh,
}) {
  const now = useMemo(() => new Date(nowISO || Date.now()), [nowISO]);
  const [highlightNow, setHighlightNow] = useState(true);

  // Optionally refresh on relevant runtime events
  useEffect(() => {
    const types = [
      "admission.created",
      "admission.updated",
      "scheduler.tick.completed",
      "scheduler.autoplan.completed",
      "gatekeeper.resolve.completed",
      "gatekeeper.reschedule.moved",
    ];
    const handler = (evt) => {
      if (!evt || !evt.type) return;
      if (types.includes(evt.type)) {
        if (typeof onRefresh === "function") onRefresh();
      }
    };
    if (eventBus && typeof eventBus.on === "function") {
      eventBus.on(handler);
      return () => eventBus.off && eventBus.off(handler);
    }
  }, [onRefresh]);

  const day = useMemo(() => {
    const d = toParts(now, timezone);
    return { y: d.year, m: d.month, d: d.day };
  }, [now, timezone]);

  // Preprocess sessions for the day view
  const rows = useMemo(() => {
    const mapped = (Array.isArray(sessions) ? sessions : []).map((s) =>
      toRow(s, timezone, day)
    );
    // Sort by start then deadline then priority desc
    mapped.sort((a, b) => {
      if (a.hasTimes && b.hasTimes) {
        if (a.startMin !== b.startMin) return a.startMin - b.startMin;
        if (a.deadlineMin !== b.deadlineMin)
          return a.deadlineMin - b.deadlineMin;
      } else if (a.hasTimes !== b.hasTimes) {
        return a.hasTimes ? -1 : 1;
      }
      return (b.priority || 0) - (a.priority || 0);
    });
    return mapped;
  }, [sessions, timezone, day]);

  const nowMarkerPct = useMemo(() => {
    const mins = minutesSinceStartOfDay(now, timezone);
    return clamp01(mins / DAY_MIN) * 100;
  }, [now, timezone]);

  return (
    <div className="w-full rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <Header
        timezone={timezone}
        day={day}
        onToggleNow={() => setHighlightNow((v) => !v)}
        highlightNow={highlightNow}
        onRefreshClick={onRefresh}
      />

      {/* Timeline header ruler */}
      <TimelineHeader timezone={timezone} />

      <div className="relative">
        {/* Now marker */}
        {highlightNow && (
          <div
            className="absolute top-0 bottom-0 w-px bg-fuchsia-500/70 z-10"
            style={{ left: `${nowMarkerPct}%` }}
            aria-hidden
          />
        )}

        {/* Rows */}
        <ul className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <EmptyState />
          ) : (
            rows.map((row) => (
              <Row
                key={row.id || row.title + row.startMin}
                row={row}
                compact={compact}
                onClick={() => handleSelect(row, onSelect)}
              />
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function Header({ timezone, day, onToggleNow, highlightNow, onRefreshClick }) {
  const label = `${pad2(day.m)}/${pad2(day.d)}/${day.y}`;
  return (
    <div className="flex items-center justify-between px-4 py-3 bg-slate-50">
      <div className="flex items-center gap-2">
        <ScanLine className="w-4 h-4 text-slate-500" />
        <span className="font-semibold text-slate-700">Today’s Plan</span>
        <span className="text-xs text-slate-500">• {label}</span>
        <span className="text-xs text-slate-400">({timezone})</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onRefreshClick}
          title="Refresh"
          className="inline-flex items-center gap-1 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs text-slate-600 hover:bg-slate-100"
        >
          <RefreshCw className="w-3.5 h-3.5" /> Refresh
        </button>
        <button
          onClick={onToggleNow}
          className={`inline-flex items-center gap-1 rounded-xl border px-2.5 py-1.5 text-xs ${
            highlightNow
              ? "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-700"
              : "border-slate-200 text-slate-600 hover:bg-slate-100"
          }`}
        >
          <Clock className="w-3.5 h-3.5" />
          Now
        </button>
      </div>
    </div>
  );
}

function TimelineHeader({ timezone }) {
  const marks = useMemoHourMarks(timezone);
  return (
    <div className="relative h-8 bg-white border-y border-slate-100">
      {marks.map((m) => (
        <div
          key={m.min}
          className="absolute top-0 bottom-0 flex flex-col items-center text-[10px] text-slate-400"
          style={{ left: `${(m.min / DAY_MIN) * 100}%` }}
        >
          <div className="h-4 w-px bg-slate-200" />
          <div className="mt-0.5">{m.label}</div>
        </div>
      ))}
    </div>
  );
}

function Row({ row, compact, onClick }) {
  const height = compact ? "h-14" : "h-16";
  const density = compact ? "text-[11px]" : "text-xs";

  return (
    <li className={`relative ${height} px-3 group`}>
      {/* Track */}
      <div className="absolute inset-y-2 left-24 right-3 rounded-md bg-slate-50" />

      {/* Title & meta */}
      <div className="absolute left-3 top-1.5 bottom-1.5 w-20">
        <div className="flex flex-col h-full justify-between">
          <div className="text-[13px] font-medium text-slate-800 line-clamp-2 pr-2">
            <span
              className={`inline-block px-1.5 py-0.5 mr-1 rounded-md text-white ${domainBadge(
                row.domain
              )}`}
            >
              {domainShort(row.domain)}
            </span>
            {row.title}
          </div>
          <div className={`${density} text-slate-500 flex items-center gap-1`}>
            <Timer className="w-3 h-3" />
            <span>{row.estimatedMinutes}m</span>
            {row.priority != null && (
              <span className="ml-1 rounded px-1 bg-slate-100 text-slate-600">
                P{row.priority}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Bars layer */}
      <Bars row={row} />

      {/* Deadline marker text */}
      <div
        className="absolute -top-1 text-[10px] text-slate-500"
        style={{ left: `calc(${row.deadlinePct}% + 24px)` }}
      >
        due {row.deadlineLabel}
      </div>

      {/* Warnings */}
      {!row.hasTimes && (
        <div className="absolute right-3 top-2 text-amber-600 flex items-center gap-1 text-xs">
          <AlertTriangle className="w-4 h-4" /> Missing start/deadline
        </div>
      )}

      {/* Click catcher */}
      <button
        type="button"
        onClick={onClick}
        className="absolute inset-0 focus:outline-none focus:ring-2 focus:ring-fuchsia-400/50 rounded-md"
        aria-label={`Open ${row.title}`}
      />
    </li>
  );
}

function Bars({ row }) {
  // P95 back-most, then P80, then P50 front-most
  const baseStyle = "absolute inset-y-3 rounded-md";
  return (
    <>
      {/* Deadline vertical line */}
      <div
        className="absolute inset-y-2 w-px bg-rose-400/80"
        style={{ left: `calc(${row.deadlinePct}% + 24px)` }}
        aria-hidden
      />

      {/* P95 */}
      <div
        className={`${baseStyle} bg-indigo-200/50`}
        style={{
          left: `calc(${row.p95.leftPct}% + 24px)`,
          width: `${row.p95.widthPct}%`,
        }}
        title={`P95 window ${row.p95.label}`}
      />
      {/* P80 */}
      <div
        className={`${baseStyle} bg-sky-300/60`}
        style={{
          left: `calc(${row.p80.leftPct}% + 24px)`,
          width: `${row.p80.widthPct}%`,
        }}
        title={`P80 window ${row.p80.label}`}
      />
      {/* P50 */}
      <div
        className={`${baseStyle} bg-emerald-400/70`}
        style={{
          left: `calc(${row.p50.leftPct}% + 24px)`,
          width: `${row.p50.widthPct}%`,
        }}
        title={`P50 window ${row.p50.label}`}
      />

      {/* Start tick */}
      <div
        className="absolute inset-y-2 w-px bg-slate-300"
        style={{ left: `calc(${row.startPct}% + 24px)` }}
        aria-hidden
      />
    </>
  );
}

function EmptyState() {
  return (
    <li className="py-12 text-center text-slate-500">
      <Info className="w-4 h-4 inline mr-1 align-[-2px]" />
      Nothing scheduled for today (yet).
    </li>
  );
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function handleSelect(row, onSelect) {
  if (typeof onSelect === "function") onSelect(row.original);
  try {
    eventBus.emit({
      type: "ui.todayPlan.select",
      ts: new Date().toISOString(),
      source: SOURCE,
      data: { id: row.id, domain: row.domain },
    });
  } catch (_) {}
}

function toRow(s, timezone, day) {
  const startMin = minutesFromIsoOnDay(s.plannedStartISO, timezone, day);
  const deadlineMin = minutesFromIsoOnDay(s.deadlineISO, timezone, day);

  const hasTimes = startMin != null && deadlineMin != null;

  // Fallback uncertainty: P50 = estimated, P80 = +30%, P95 = +60% (clamped)
  const est = safeInt(s.uncertainty?.p50, s.estimatedMinutes || 0);
  const p50min = clampPos(est);
  const p80min = clampPos(s.uncertainty?.p80 ?? Math.round(est * 1.3));
  const p95min = clampPos(s.uncertainty?.p95 ?? Math.round(est * 1.6));

  const p50 = spanToPct(startMin ?? 0, p50min);
  const p80 = spanToPct(startMin ?? 0, p80min);
  const p95 = spanToPct(startMin ?? 0, p95min);

  const deadlinePct = deadlineMin != null ? (deadlineMin / DAY_MIN) * 100 : 0;
  const startPct = startMin != null ? (startMin / DAY_MIN) * 100 : 0;

  return {
    id: s.id || s.sessionId,
    title: s.title || s.name || "(untitled)",
    domain: s.domain || "general",
    priority: s.priority,
    status: s.status,
    estimatedMinutes: s.estimatedMinutes || est || 0,

    // timeline math
    hasTimes,
    startMin: startMin ?? 0,
    deadlineMin: deadlineMin ?? 0,
    startPct,
    deadlinePct,
    p50,
    p80,
    p95,
    deadlineLabel: deadlineMin != null ? minutesToClock(deadlineMin) : "--:--",

    original: s,
  };
}

function spanToPct(startMin, durMin) {
  const s = clampRange(startMin, 0, DAY_MIN);
  const e = clampRange(startMin + durMin, 0, DAY_MIN);
  const leftPct = (s / DAY_MIN) * 100;
  const widthPct = Math.max(0.5, ((e - s) / DAY_MIN) * 100);
  return {
    leftPct,
    widthPct,
    label: `${minutesToClock(s)}–${minutesToClock(e)}`,
  };
}

function minutesToClock(min) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return `${pad2(h)}:${pad2(m)}`;
}

function minutesFromIsoOnDay(iso, timezone, day) {
  if (!iso) return null;
  const parts = toParts(new Date(iso), timezone);
  if (parts.year !== day.y || parts.month !== day.m || parts.day !== day.d) {
    // Not today → clamp to null so we still draw but flag missing
    return null;
  }
  return parts.hour * 60 + parts.minute;
}

function minutesSinceStartOfDay(d, timezone) {
  const parts = toParts(d, timezone);
  return parts.hour * 60 + parts.minute + parts.second / 60;
}

function toParts(d, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(d instanceof Date ? d : new Date(d));
  const map = Object.fromEntries(parts.map((p) => [p.type, Number(p.value)]));
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
  };
}

// Styling helpers
function domainBadge(domain) {
  switch (String(domain || "general").toLowerCase()) {
    case "cooking":
      return "bg-emerald-600";
    case "cleaning":
      return "bg-sky-600";
    case "garden":
      return "bg-lime-600";
    case "animal":
      return "bg-amber-600";
    case "preservation":
      return "bg-fuchsia-600";
    case "storehouse":
      return "bg-indigo-600";
    default:
      return "bg-slate-600";
  }
}
function domainShort(domain) {
  switch (String(domain || "gen").toLowerCase()) {
    case "cooking":
      return "CK";
    case "cleaning":
      return "CL";
    case "garden":
      return "GD";
    case "animal":
      return "AN";
    case "preservation":
      return "PR";
    case "storehouse":
      return "SH";
    default:
      return "GN";
  }
}

// Small utils
function clampPos(n) {
  const x = Number(n) || 0;
  return x < 0 ? 0 : x;
}
function clampRange(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function safeInt(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback || 0;
}

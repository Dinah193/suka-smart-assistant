// File: C:\Users\larho\suka-smart-assistant\src\ui\components\scheduling\ResourceConflictModal.jsx
import React, { useEffect, useMemo, useReducer, useRef, useCallback } from "react";
import PropTypes from "prop-types";

// 🔌 Shared services (assumed to exist per SSA conventions)
import eventBus from "../../../services/eventBus";
import featureFlags from "../../../config/featureFlags";
import HubPacketFormatter from "../../../hub/HubPacketFormatter";
import FamilyFundConnector from "../../../hub/FamilyFundConnector";

/**
 * ResourceConflictModal
 * ---------------------------------------------------------------------------------
 * Purpose
 *  - Resolve overlaps when the same resource (device or person) is double-booked
 *    across sessions/tasks (e.g., the oven or "Alex" is required in two places).
 *
 * Pipeline Fit (imports → intelligence → automation → (optional) hub export)
 *  - Upstream planners/engines detect conflicts and emit `schedule.resource.conflict`
 *    with details about the overlapping sessions/tasks and resources.
 *  - This modal presents actionable resolution strategies (shift, reassign, split,
 *    queue, allow parallel with constraints, or ignore with note).
 *  - On confirm, emits a normalized event back onto the eventBus
 *    { type, ts, source, data } for the automation runtime to recompute schedules.
 *  - If the resolution changes household data (most do), it also calls
 *    exportToHubIfEnabled(payload) to optionally forward to the Hub (Family Fund).
 *
 * Forward-thinking
 *  - Strategy registry allows adding new conflict resolution methods per domain.
 *  - Defensive checks & simple built-ins (time shift, resource reassign, queueing).
 *  - Neutral to domain — works for cooking/cleaning/garden/animals/storehouse.
 */

const SOURCE = "ui.ResourceConflictModal";
const nowISO = () => new Date().toISOString();

function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(packet);
  } catch {
    // fail silently (Hub optional)
  }
}

// --------------------------------------
// Utilities
// --------------------------------------
function fmtTimeRange(aISO, bISO) {
  try {
    const a = new Date(aISO);
    const b = new Date(bISO);
    const opts = { hour: "2-digit", minute: "2-digit" };
    return `${a.toLocaleTimeString([], opts)}–${b.toLocaleTimeString([], opts)}`;
  } catch {
    return `${aISO}–${bISO}`;
  }
}

function msFromMinutes(mins) {
  const n = Number(mins);
  return Number.isFinite(n) ? Math.round(n * 60 * 1000) : 0;
}

function normalizeConflict(conflict) {
  // Defensive normalization of shape expected by the UI
  const c = conflict ?? {};
  return {
    id: c.id || c.conflictId || `${c.resourceId || "res"}:${c.start || ""}`,
    domain: c.domain || "general",
    // The primary resource in conflict (device or person)
    resource: {
      id: c.resource?.id || c.resourceId || "unknown",
      type: c.resource?.type || c.resourceType || "device", // 'device' | 'person' | 'space'
      name: c.resource?.name || c.resourceName || "Unknown resource",
      traits: c.resource?.traits || [], // e.g., ["heat","stovetop"], ["adult","lift>50lb"]
    },
    // The overlapping bookings
    overlaps: Array.isArray(c.overlaps) ? c.overlaps : (c.bookings || []),
    window: {
      start: c.window?.start || c.start || null,
      end: c.window?.end || c.end || null,
    },
    suggestions: c.suggestions || {}, // { shiftMins?: number[], reassignTo?: Resource[], queue?: boolean }
    constraints: c.constraints || {}, // e.g., { minTemp: 350, mustBeAdult: true }
    note: c.note || "",
  };
}

// --------------------------------------
// Strategy Registry (extensible)
// --------------------------------------
const STRATEGIES = [
  {
    key: "shift",
    label: "Shift time",
    description: "Move one of the tasks by a small offset to remove overlap.",
    requires: { offsetMins: true },
    collect: (state) => ({
      action: "shift",
      targetBookingId: state.targetBookingId,
      offsetMs: msFromMinutes(state.offsetMins || 5),
      direction: state.offsetDirection || "after", // "before" | "after"
    }),
  },
  {
    key: "reassign",
    label: "Reassign resource",
    description: "Use an equivalent device/person for one of the tasks.",
    requires: { targetResourceId: true },
    collect: (state) => ({
      action: "reassign",
      targetBookingId: state.targetBookingId,
      toResourceId: state.targetResourceId,
    }),
  },
  {
    key: "split",
    label: "Split task",
    description: "Divide the task into two sequential parts to fit the gap.",
    requires: { splitRatio: true },
    collect: (state) => ({
      action: "split",
      targetBookingId: state.targetBookingId,
      ratio: Number(state.splitRatio) || 0.5, // 0.0..1.0
    }),
  },
  {
    key: "queue",
    label: "Queue on resource",
    description: "Line up tasks to run back-to-back on the same resource.",
    requires: { queueOrder: true },
    collect: (state) => ({
      action: "queue",
      order: state.queueOrder, // array of bookingIds in order
    }),
  },
  {
    key: "parallel",
    label: "Allow parallel w/ guard",
    description:
      "Run both if constraints allow (e.g., different racks, supervised adult).",
    requires: { guardNote: true },
    collect: (state) => ({
      action: "allow_parallel",
      guard: state.guardNote || "supervised",
    }),
  },
  {
    key: "ignore",
    label: "Ignore (acknowledge)",
    description: "Ignore this conflict this time and continue.",
    requires: {},
    collect: () => ({
      action: "ignore_once",
    }),
  },
];

// --------------------------------------
// Reducer for form state
// --------------------------------------
const initialForm = {
  strategyKey: "shift",
  targetBookingId: "",
  // shift
  offsetMins: 5,
  offsetDirection: "after",
  // reassign
  targetResourceId: "",
  // split
  splitRatio: 0.5,
  // queue
  queueOrder: [],
  // parallel
  guardNote: "",
};

function formReducer(state, action) {
  switch (action.type) {
    case "INIT":
      return { ...initialForm, ...action.payload };
    case "SET":
      return { ...state, [action.key]: action.value };
    case "SET_QUEUE_ORDER":
      return { ...state, queueOrder: action.value };
    default:
      return state;
  }
}

// --------------------------------------
// Component
// --------------------------------------
export default function ResourceConflictModal({
  isOpen,
  onClose,
  conflict,
  alternatives, // { resources?: [{id,name,type,traits}], shiftMins?: number[] }
}) {
  const c = useMemo(() => normalizeConflict(conflict), [conflict]);
  const [form, dispatch] = useReducer(formReducer, initialForm);
  const overlayRef = useRef(null);
  const dialogRef = useRef(null);

  // initialize defaults when opening
  useEffect(() => {
    if (!isOpen) return;
    const firstBookingId = c.overlaps?.[0]?.bookingId || "";
    dispatch({
      type: "INIT",
      payload: {
        targetBookingId: firstBookingId,
        offsetMins:
          (alternatives?.shiftMins && alternatives.shiftMins[0]) || 5,
        queueOrder: (c.overlaps || []).map((o) => o.bookingId),
      },
    });
  }, [isOpen, c.overlaps, alternatives?.shiftMins]);

  // basic focus trap & escape handling
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose?.();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "enter") {
        e.preventDefault();
        confirmResolution();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, form]);

  const confirmResolution = useCallback(() => {
    const strat = STRATEGIES.find((s) => s.key === form.strategyKey);
    if (!strat) return;

    // Collect resolution details per strategy
    const details = strat.collect(form);

    // Compose normalized payload
    const payload = {
      type: "schedule.resource.resolution",
      ts: nowISO(),
      source: SOURCE,
      data: {
        conflictId: c.id,
        resource: c.resource,
        window: c.window,
        domain: c.domain,
        overlaps: c.overlaps,
        resolution: {
          strategy: strat.key,
          ...details,
        },
      },
    };

    // Emit to eventBus for automation runtime to apply
    try {
      eventBus.emit(payload.type, payload);
      eventBus.emit("ui.action", payload); // analytics stream
    } catch {
      // swallow, UI shouldn't crash on bus errors
    }

    // Most resolution strategies change household data → export (optional)
    if (strat.key !== "ignore") {
      exportToHubIfEnabled(payload);
    }

    onClose?.();
  }, [form, c, onClose]);

  if (!isOpen) return null;

  // Derived lists
  const reassignables = (alternatives?.resources || []).filter((r) =>
    isCompatible(c.resource, r, c.constraints)
  );

  const shiftOptions = (alternatives?.shiftMins || [5, 10, 15, 30]).map((m) => ({
    value: m,
    label: `±${m} min`,
  }));

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[1000] flex items-end sm:items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rcm-title"
    >
      <div
        ref={dialogRef}
        className="w-full sm:max-w-2xl bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 overflow-hidden"
      >
        <header className="px-4 py-3 border-b border-slate-200 flex items-center justify-between bg-slate-50">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-red-500 animate-pulse" />
            <h2 id="rcm-title" className="text-sm font-semibold text-slate-900">
              Resource conflict detected — resolve overlap
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-600 hover:text-slate-900 text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        {/* Conflict summary */}
        <section className="px-4 py-3 space-y-2">
          <SummaryCard conflict={c} />
        </section>

        {/* Strategy selector */}
        <section className="px-4 pb-2">
          <StrategySelector
            strategies={STRATEGIES}
            value={form.strategyKey}
            onChange={(v) => dispatch({ type: "SET", key: "strategyKey", value: v })}
          />
        </section>

        {/* Strategy-specific controls */}
        <section className="px-4 py-2 space-y-3">
          <BookingPicker
            overlaps={c.overlaps}
            value={form.targetBookingId}
            onChange={(v) => dispatch({ type: "SET", key: "targetBookingId", value: v })}
          />

          {form.strategyKey === "shift" && (
            <ShiftControls
              options={shiftOptions}
              offsetMins={form.offsetMins}
              direction={form.offsetDirection}
              onOffsetChange={(v) => dispatch({ type: "SET", key: "offsetMins", value: Number(v) })}
              onDirectionChange={(v) => dispatch({ type: "SET", key: "offsetDirection", value: v })}
            />
          )}

          {form.strategyKey === "reassign" && (
            <ReassignControls
              current={c.resource}
              options={reassignables}
              value={form.targetResourceId}
              onChange={(v) => dispatch({ type: "SET", key: "targetResourceId", value: v })}
            />
          )}

          {form.strategyKey === "split" && (
            <SplitControls
              ratio={form.splitRatio}
              onChange={(v) => dispatch({ type: "SET", key: "splitRatio", value: Number(v) })}
            />
          )}

          {form.strategyKey === "queue" && (
            <QueueControls
              overlaps={c.overlaps}
              order={form.queueOrder}
              onChange={(v) => dispatch({ type: "SET_QUEUE_ORDER", value: v })}
            />
          )}

          {form.strategyKey === "parallel" && (
            <ParallelControls
              value={form.guardNote}
              onChange={(v) => dispatch({ type: "SET", key: "guardNote", value: v })}
            />
          )}
        </section>

        {/* Footer */}
        <footer className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
          <p className="text-[11px] text-slate-600">
            Tip: Press <kbd className="px-1 border rounded">Ctrl/⌘</kbd> +{" "}
            <kbd className="px-1 border rounded">Enter</kbd> to confirm.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-lg border border-slate-300 bg-white hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              onClick={confirmResolution}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700"
            >
              Apply resolution
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

ResourceConflictModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func,
  conflict: PropTypes.shape({
    id: PropTypes.string,
    conflictId: PropTypes.string,
    domain: PropTypes.string,
    resource: PropTypes.object,
    resourceId: PropTypes.string,
    resourceType: PropTypes.string,
    resourceName: PropTypes.string,
    overlaps: PropTypes.array,
    bookings: PropTypes.array,
    window: PropTypes.object,
    start: PropTypes.string,
    end: PropTypes.string,
    suggestions: PropTypes.object,
    constraints: PropTypes.object,
    note: PropTypes.string,
  }),
  alternatives: PropTypes.shape({
    resources: PropTypes.arrayOf(
      PropTypes.shape({
        id: PropTypes.string.isRequired,
        name: PropTypes.string.isRequired,
        type: PropTypes.string,
        traits: PropTypes.arrayOf(PropTypes.string),
      })
    ),
    shiftMins: PropTypes.arrayOf(PropTypes.number),
  }),
};

// --------------------------------------
// Subcomponents
// --------------------------------------
function SummaryCard({ conflict }) {
  const { resource, overlaps, window, domain } = conflict;
  return (
    <div className="rounded-xl border border-slate-200 p-3 bg-slate-50/60">
      <div className="text-sm font-medium text-slate-900">
        {resource.name} <span className="text-xs text-slate-500">({resource.type})</span>
      </div>
      <div className="text-xs text-slate-600 mt-1">
        Domain: <span className="font-medium">{domain}</span>
        {window?.start && window?.end && (
          <>
            {" · "}Window: <span className="font-mono">{fmtTimeRange(window.start, window.end)}</span>
          </>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {(overlaps || []).map((b) => (
          <li
            key={b.bookingId}
            className="text-xs text-slate-800 flex items-center justify-between gap-2 bg-white rounded-lg border border-slate-200 px-2 py-1"
          >
            <span className="truncate">
              <span className="font-medium">{b.label || b.taskName || b.sessionName || "Task"}</span>{" "}
              <span className="text-slate-500">#{b.bookingId}</span>
              {b.sessionId && <span className="text-slate-500"> · S:{b.sessionId}</span>}
            </span>
            <span className="font-mono text-[11px] text-slate-700">
              {b.start && b.end ? fmtTimeRange(b.start, b.end) : "unscheduled"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
SummaryCard.propTypes = { conflict: PropTypes.object.isRequired };

function StrategySelector({ strategies, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {strategies.map((s) => {
        const active = value === s.key;
        return (
          <button
            key={s.key}
            onClick={() => onChange(s.key)}
            className={`px-3 py-1.5 text-xs rounded-lg border ${
              active
                ? "bg-blue-600 text-white border-blue-700"
                : "bg-white text-slate-900 border-slate-300 hover:bg-slate-50"
            }`}
            title={s.description}
          >
            {s.label}
          </button>
        );
      })}
    </div>
  );
}
StrategySelector.propTypes = {
  strategies: PropTypes.array.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};

function BookingPicker({ overlaps, value, onChange }) {
  const items = overlaps || [];
  if (items.length <= 1) return null;
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-700">Target task:</label>
      <select
        className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {items.map((b) => (
          <option key={b.bookingId} value={b.bookingId}>
            {(b.label || b.taskName || "Task")} #{b.bookingId}
          </option>
        ))}
      </select>
    </div>
  );
}
BookingPicker.propTypes = {
  overlaps: PropTypes.array,
  value: PropTypes.string,
  onChange: PropTypes.func.isRequired,
};

function ShiftControls({ options, offsetMins, direction, onOffsetChange, onDirectionChange }) {
  return (
    <div className="flex items-center flex-wrap gap-2">
      <label className="text-xs text-slate-700">Offset:</label>
      <select
        className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white"
        value={offsetMins}
        onChange={(e) => onOffsetChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      <label className="text-xs text-slate-700 ml-2">Direction:</label>
      <select
        className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white"
        value={direction}
        onChange={(e) => onDirectionChange(e.target.value)}
      >
        <option value="before">Before</option>
        <option value="after">After</option>
      </select>
    </div>
  );
}
ShiftControls.propTypes = {
  options: PropTypes.array.isRequired,
  offsetMins: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  direction: PropTypes.string.isRequired,
  onOffsetChange: PropTypes.func.isRequired,
  onDirectionChange: PropTypes.func.isRequired,
};

function ReassignControls({ current, options, value, onChange }) {
  if (!options.length) {
    return (
      <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
        No compatible alternates available for reassignment.
      </div>
    );
  }
  return (
    <div className="flex items-center flex-wrap gap-2">
      <span className="text-xs text-slate-700">
        Current: <span className="font-medium">{current.name}</span>
      </span>
      <label className="text-xs text-slate-700 ml-2">Reassign to:</label>
      <select
        className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">— select —</option>
        {options.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name} {r.type ? `(${r.type})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}
ReassignControls.propTypes = {
  current: PropTypes.object.isRequired,
  options: PropTypes.array.isRequired,
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};

function SplitControls({ ratio, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-700">Split ratio:</label>
      <input
        type="number"
        min="0.1"
        max="0.9"
        step="0.1"
        value={ratio}
        onChange={(e) => onChange(e.target.value)}
        className="text-xs border border-slate-300 rounded-lg px-2 py-1 w-20"
      />
      <span className="text-[11px] text-slate-600">First part share (0.1–0.9)</span>
    </div>
  );
}
SplitControls.propTypes = {
  ratio: PropTypes.oneOfType([PropTypes.number, PropTypes.string]).isRequired,
  onChange: PropTypes.func.isRequired,
};

function ParallelControls({ value, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-slate-700">Guard/Note:</label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g., different racks, adult supervision"
        className="text-xs border border-slate-300 rounded-lg px-2 py-1 flex-1"
      />
    </div>
  );
}
ParallelControls.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
};

function QueueControls({ overlaps, order, onChange }) {
  // Lightweight reordering (first/last) without DnD; extend later
  const ids = (overlaps || []).map((o) => o.bookingId);
  const current = order && order.length === ids.length ? order : ids;

  const move = (id, dir) => {
    const idx = current.indexOf(id);
    if (idx < 0) return;
    const copy = [...current];
    const swapIdx = dir === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= copy.length) return;
    [copy[idx], copy[swapIdx]] = [copy[swapIdx], copy[idx]];
    onChange(copy);
  };

  return (
    <div className="space-y-1">
      <div className="text-xs text-slate-700">Queue order:</div>
      <ul className="space-y-1">
        {current.map((id) => {
          const b = (overlaps || []).find((o) => o.bookingId === id);
          return (
            <li
              key={id}
              className="flex items-center justify-between gap-2 bg-white rounded-lg border border-slate-200 px-2 py-1"
            >
              <span className="text-xs text-slate-800 truncate">
                {(b?.label || b?.taskName || "Task")} #{id}
              </span>
              <span className="flex items-center gap-1">
                <button
                  onClick={() => move(id, "up")}
                  className="text-[11px] px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-50"
                >
                  ↑
                </button>
                <button
                  onClick={() => move(id, "down")}
                  className="text-[11px] px-2 py-0.5 rounded border border-slate-300 hover:bg-slate-50"
                >
                  ↓
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
QueueControls.propTypes = {
  overlaps: PropTypes.array,
  order: PropTypes.array.isRequired,
  onChange: PropTypes.func.isRequired,
};

// --------------------------------------
// Compatibility check (single-use helper)
// --------------------------------------
function isCompatible(fromResource, toResource, constraints = {}) {
  if (!toResource || !fromResource) return false;
  // Simple heuristic: match type, and if constraints exist, ensure traits cover them.
  if (fromResource.type && toResource.type && fromResource.type !== toResource.type) {
    return false;
  }
  if (constraints.mustBeAdult && !(toResource.traits || []).includes("adult")) return false;
  if (constraints.minTemp && !(toResource.traits || []).includes("heat")) return false;
  // More sophisticated matching can be added (capacity, power, rack-level, etc.)
  return true;
}

// --------------------------------------
// Event subscription (optional integration point)
// --------------------------------------
// You may show this modal reactively by listening to the conflict event here,
// but typically a parent container opens it and passes `conflict` prop.
// Example hookup elsewhere:
// eventBus.on("schedule.resource.conflict", (e) => setModal({open: true, conflict: e.data}))

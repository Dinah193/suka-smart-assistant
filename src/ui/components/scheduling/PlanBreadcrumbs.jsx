// File: C:\Users\larho\suka-smart-assistant\src\ui\components\scheduling\PlanBreadcrumbs.jsx
import React, { useEffect, useMemo, useReducer, useRef, useCallback } from "react";
import PropTypes from "prop-types";

// 🔌 Shared services (assumed to exist per SSA conventions)
import eventBus from "../../../services/eventBus";
import featureFlags from "../../../config/featureFlags";
import HubPacketFormatter from "../../../hub/HubPacketFormatter";
import FamilyFundConnector from "../../../hub/FamilyFundConnector";

/**
 * PlanBreadcrumbs
 * ---------------------------------------------------------------------------------
 * Purpose
 *  - Visual "why" trail for plan changes. Shows a compact, navigable history of
 *    schedule/session edits with reason codes (user/system), impacts, and links.
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export)
 *  - Upstream engines/planners (intelligence) and UI actions (automation triggers)
 *    emit normalized change events (e.g., `schedule.plan.recomputed`,
 *    `schedule.adjust_time`, `schedule.resource.resolution`, `session.task.split`,
 *    `inventory.shortage.detected` driving a plan change).
 *  - This component subscribes, normalizes them into "breadcrumbs", and renders a
 *    timeline. It can also emit actions:
 *      • revert to a given changeId → `schedule.plan.revert` (changes data → optional Hub export)
 *      • annotate a change → `schedule.plan.annotate` (changes data → optional Hub export)
 *      • open details → `ui.plan.open_change`
 *  - All emissions use the normalized payload shape { type, ts, source, data } (ISO ts).
 *
 * Forward-thinking / extensibility
 *  - Event registry allows adding new change sources without touching core logic.
 *  - Works across domains (cooking/cleaning/garden/animals/storehouse).
 *  - Defensive input checks and single-file helpers for small utilities.
 */

const SOURCE = "ui.PlanBreadcrumbs";
const nowISO = () => new Date().toISOString();

function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(packet);
  } catch {
    // fail silently — Hub is optional plumbing
  }
}

// ----------------------------------------------------------------------------------
// Event registry — add new change event types here to be captured in breadcrumbs.
// ----------------------------------------------------------------------------------
/**
 * Each registry entry:
 * {
 *   type: "event.name",
 *   select: (raw) => ({ changeId, planId, sessionId, domain, reason, impact, links })
 * }
 * - `impact` is a small descriptor { minutesAdded?: number, minutesSaved?: number, items?: string[] }
 */
const CHANGE_EVENTS = [
  "schedule.plan.recomputed",
  "schedule.adjust_time",
  "schedule.reschedule_item",
  "schedule.autofit",
  "schedule.resource.resolution",
  "session.task.split",
  "session.task.skip",
  "timer.overrun",
  "schedule.overrun.detected",
  "inventory.shortage.detected",
  "garden.harvest.logged",
  "meal.executed",
].map((t) => ({ type: t, select: (e) => normalizeChangeEvent(t, e) }));

// ----------------------------------------------------------------------------------
// Reducer: maintain per-plan breadcrumbs (bounded length)
// ----------------------------------------------------------------------------------
const initialState = { items: [], max: 25 };

function reducer(state, action) {
  switch (action.type) {
    case "PUSH": {
      const item = action.item;
      if (!item?.changeId) return state;

      // De-dupe by changeId (latest wins)
      const existingIdx = state.items.findIndex((i) => i.changeId === item.changeId);
      let next = [...state.items];
      if (existingIdx >= 0) {
        next[existingIdx] = { ...next[existingIdx], ...item };
      } else {
        next.unshift(item);
      }
      if (next.length > state.max) next = next.slice(0, state.max);
      return { ...state, items: next };
    }
    case "CLEAR":
      return { ...state, items: [] };
    default:
      return state;
  }
}

// ----------------------------------------------------------------------------------
// Component
// ----------------------------------------------------------------------------------
export default function PlanBreadcrumbs({
  planId,          // optional; if omitted, show all for sessionId
  sessionId,       // optional; if omitted, show all plan events encountered
  domain = "general",
  maxItems = 25,
  compact = false,
  className = "",
}) {
  const [state, dispatch] = useReducer(reducer, { ...initialState, max: maxItems });
  const liveRef = useRef(null);

  // Subscribe to relevant change events
  useEffect(() => {
    const offs = CHANGE_EVENTS.map(({ type, select }) =>
      eventBus.on(type, (evt) => {
        const normalized = select(evt);
        if (!normalized) return;

        // Filter for planId/sessionId if provided
        if (planId && normalized.planId && normalized.planId !== planId) return;
        if (sessionId && normalized.sessionId && normalized.sessionId !== sessionId) return;

        dispatch({ type: "PUSH", item: normalized });
        announceLive(`${normalized.reason.code}: ${normalized.reason.message}`, liveRef);
      })
    );

    return () => {
      offs.forEach((off) => {
        try {
          off?.();
        } catch {
          /* noop */
        }
      });
    };
  }, [planId, sessionId]);

  // Derived visible list
  const items = state.items;
  const title = useMemo(() => {
    if (planId) return `Plan ${planId}`;
    if (sessionId) return `Session ${sessionId}`;
    return "Recent changes";
  }, [planId, sessionId]);

  // Emit helper
  const emit = useCallback((type, data, { exportToHub = false } = {}) => {
    const payload = { type, ts: nowISO(), source: SOURCE, data };
    try {
      eventBus.emit(type, payload);
      eventBus.emit("ui.action", payload);
    } catch {
      // swallow
    }
    if (exportToHub) exportToHubIfEnabled(payload);
  }, []);

  // Actions
  const revertChange = useCallback(
    (change) => {
      if (!change?.changeId) return;
      emit(
        "schedule.plan.revert",
        {
          changeId: change.changeId,
          planId: change.planId || planId,
          sessionId: change.sessionId || sessionId,
          domain: change.domain || domain,
          reason: { code: "USER_REVERT", message: "Revert to state before changeId" },
        },
        { exportToHub: true }
      );
    },
    [emit, planId, sessionId, domain]
  );

  const annotateChange = useCallback(
    (change) => {
      const note = prompt("Add a short note for this change (optional):", "");
      if (note === null) return; // cancelled
      emit(
        "schedule.plan.annotate",
        {
          changeId: change.changeId,
          planId: change.planId || planId,
          sessionId: change.sessionId || sessionId,
          domain: change.domain || domain,
          note: String(note || "").slice(0, 240),
        },
        { exportToHub: true }
      );
    },
    [emit, planId, sessionId, domain]
  );

  const openDetails = useCallback(
    (change) => {
      emit("ui.plan.open_change", {
        changeId: change.changeId,
        planId: change.planId || planId,
        sessionId: change.sessionId || sessionId,
        domain: change.domain || domain,
      });
    },
    [emit, planId, sessionId, domain]
  );

  if (items.length === 0) {
    return (
      <div className={`text-xs text-slate-500 ${className}`}>
        <span className="sr-only" ref={liveRef} aria-live="polite" aria-atomic="true" />
        No changes yet.
      </div>
    );
  }

  return (
    <div className={`print:hidden ${className}`}>
      <div className={`flex items-center justify-between ${compact ? "mb-1" : "mb-2"}`}>
        <div className="flex items-center gap-2">
          <span className="inline-flex h-2 w-2 rounded-full bg-slate-400" />
          <h3 className="text-xs font-semibold text-slate-800">
            {title} — why this plan looks like it does
          </h3>
        </div>
        <button
          onClick={() => dispatch({ type: "CLEAR" })}
          className="text-[11px] text-slate-600 hover:text-slate-900"
          aria-label="Clear change breadcrumbs"
        >
          Clear
        </button>
      </div>

      <ol className={`relative ${compact ? "space-y-1" : "space-y-2"} pl-4`}>
        {/* Vertical rail */}
        <span
          aria-hidden="true"
          className="absolute left-1 top-0 bottom-0 w-px bg-slate-200"
        />
        {items.map((c) => (
          <li key={c.changeId} className="relative">
            {/* Node dot */}
            <span
              aria-hidden="true"
              className={`absolute -left-[7px] top-2 h-2 w-2 rounded-full ${severityDot(c.reason?.severity)}`}
            />
            <div className="rounded-lg border border-slate-200 bg-white p-2.5 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-900 truncate">
                    {labelForType(c.type)}{" "}
                    <span className="text-[10px] text-slate-500 font-normal">
                      · {new Date(c.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-700">
                    <Reason reason={c.reason} />
                  </div>

                  {/* Impact chips */}
                  {hasImpact(c.impact) && (
                    <ImpactChips impact={c.impact} />
                  )}

                  {/* Links (optional) */}
                  {Array.isArray(c.links) && c.links.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {c.links.map((lnk) => (
                        <button
                          key={lnk.key}
                          onClick={() =>
                            emit("ui.navigate", {
                              to: lnk.to,
                              params: lnk.params || {},
                              origin: SOURCE,
                            })
                          }
                          className="text-[10px] px-1.5 py-0.5 rounded border border-slate-300 bg-slate-50 hover:bg-slate-100"
                          title={lnk.title || lnk.key}
                        >
                          {lnk.label || lnk.key}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {/* Row actions */}
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    onClick={() => openDetails(c)}
                    className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50"
                    title="Open details"
                  >
                    Details
                  </button>
                  <button
                    onClick={() => annotateChange(c)}
                    className="text-[11px] px-2 py-1 rounded border border-slate-300 bg-white hover:bg-slate-50"
                    title="Add note"
                  >
                    Note
                  </button>
                  <button
                    onClick={() => revertChange(c)}
                    className="text-[11px] px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                    title="Revert plan to before this change"
                  >
                    Revert
                  </button>
                </div>
              </div>
            </div>
          </li>
        ))}
      </ol>

      {/* ARIA live region for brief announcements */}
      <span className="sr-only" ref={liveRef} aria-live="polite" aria-atomic="true" />
    </div>
  );
}

PlanBreadcrumbs.propTypes = {
  planId: PropTypes.string,
  sessionId: PropTypes.string,
  domain: PropTypes.string,
  maxItems: PropTypes.number,
  compact: PropTypes.bool,
  className: PropTypes.string,
};

// ----------------------------------------------------------------------------------
// Subcomponents
// ----------------------------------------------------------------------------------
function Reason({ reason }) {
  if (!reason) return <span>Unspecified reason.</span>;
  const sev = (reason.severity || "low").toLowerCase();
  const sevClass =
    sev === "high" ? "text-red-700" : sev === "medium" ? "text-amber-700" : "text-emerald-700";
  return (
    <>
      <span className={`font-semibold ${sevClass}`}>{reason.code || "REASON"}</span>
      {": "}
      <span>{reason.message || "No description provided."}</span>
      {reason.actor && (
        <>
          {" "}
          <span className="text-slate-500">({reason.actor})</span>
        </>
      )}
    </>
  );
}
Reason.propTypes = { reason: PropTypes.object };

function ImpactChips({ impact }) {
  const chips = [];
  if (Number.isFinite(impact?.minutesAdded) && impact.minutesAdded > 0) {
    chips.push({
      key: "minAdd",
      label: `+${impact.minutesAdded} min`,
    });
  }
  if (Number.isFinite(impact?.minutesSaved) && impact.minutesSaved > 0) {
    chips.push({
      key: "minSave",
      label: `-${impact.minutesSaved} min`,
    });
  }
  if (Array.isArray(impact?.items) && impact.items.length > 0) {
    chips.push({
      key: "items",
      label: `${impact.items.length} item${impact.items.length > 1 ? "s" : ""}`,
    });
  }
  if (impact?.note) {
    chips.push({ key: "note", label: impact.note });
  }

  if (chips.length === 0) return null;

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {chips.map((c) => (
        <span
          key={c.key}
          className="text-[10px] px-1.5 py-0.5 rounded-full border border-slate-200 bg-slate-50 text-slate-700"
        >
          {c.label}
        </span>
      ))}
    </div>
  );
}
ImpactChips.propTypes = { impact: PropTypes.object };

// ----------------------------------------------------------------------------------
// Normalization & helpers
// ----------------------------------------------------------------------------------
/**
 * Convert diverse upstream events into a unified breadcrumb model:
 * {
 *   changeId: string,
 *   ts: ISOString,
 *   type: string,        // original event type
 *   planId?: string,
 *   sessionId?: string,
 *   domain: string,
 *   reason: { code, message, severity: 'low'|'medium'|'high', actor: 'user'|'system' },
 *   impact?: { minutesAdded?, minutesSaved?, items?: string[], note?: string },
 *   links?: [{ key, label, to, params, title }]
 * }
 */
function normalizeChangeEvent(type, evt) {
  try {
    const data = evt?.data ?? evt ?? {};
    const ts = evt?.ts || nowISO();

    // Craft a stable-ish change id (prefer upstream id, otherwise composite hash)
    const upstreamId =
      data.changeId ||
      data.id ||
      data.timerId ||
      data.taskId ||
      data.itemId ||
      data.sessionId ||
      data.planId;
    const changeId = upstreamId ? `${type}:${String(upstreamId)}` : `${type}:${ts}`;

    const base = {
      changeId,
      ts,
      type,
      planId: data.planId,
      sessionId: data.sessionId,
      domain: data.domain || guessDomain(type, data),
      links: [],
      reason: buildReason(type, data),
      impact: buildImpact(type, data),
    };

    // Optional deep links (UI can handle these routes)
    if (data.sessionId) {
      base.links.push({
        key: "session",
        label: "Open session",
        to: "/cooking/play/:id", // neutral; router can remap per domain
        params: { id: data.sessionId, domain: base.domain },
        title: "Open the affected session",
      });
    }
    if (data.taskId) {
      base.links.push({
        key: "task",
        label: "View task",
        to: "/tasks/:id",
        params: { id: data.taskId, domain: base.domain },
        title: "Open the affected task",
      });
    }

    return base;
  } catch {
    return null;
  }
}

function buildReason(type, d) {
  // Prefer upstream payload reason if well-formed
  const r = d?.reason;
  if (r && (r.code || r.message)) {
    return {
      code: String(r.code || codeFor(type)),
      message: String(r.message || messageFor(type, d)),
      severity: (r.severity || severityFor(type, d)).toLowerCase(),
      actor: r.actor || (d?.userId ? "user" : "system"),
    };
  }
  return {
    code: codeFor(type),
    message: messageFor(type, d),
    severity: severityFor(type, d),
    actor: d?.userId ? "user" : "system",
  };
}

function buildImpact(type, d) {
  switch (type) {
    case "schedule.adjust_time":
      return {
        minutesAdded: toMinutes(d?.addMs),
        note: "Manual time adjustment",
      };
    case "schedule.reschedule_item":
      return { note: "Item moved in schedule" };
    case "schedule.autofit":
      return { note: "Autofit applied (compress/defer)" };
    case "session.task.split":
      return { note: "Task split into two parts" };
    case "session.task.skip":
      return { note: "Task skipped" };
    case "timer.overrun":
    case "schedule.overrun.detected":
      return {
        minutesAdded: toMinutes(Math.max(0, (d?.deltaMs ?? 0))),
        note: "Overrun detected",
      };
    case "inventory.shortage.detected":
      return { items: Array.isArray(d?.items) ? d.items : [], note: "Inventory shortage" };
    case "garden.harvest.logged":
      return { note: "Harvest logged" };
    case "meal.executed":
      return { note: "Meal completed" };
    case "schedule.resource.resolution":
      return { note: `Resource resolution: ${d?.resolution?.strategy || "unknown"}` };
    default:
      return undefined;
  }
}

function codeFor(type) {
  switch (type) {
    case "schedule.plan.recomputed":
      return "RECOMPUTE";
    case "schedule.adjust_time":
      return "TIME_ADJUST";
    case "schedule.reschedule_item":
      return "RESCHEDULE";
    case "schedule.autofit":
      return "AUTOFIT";
    case "schedule.resource.resolution":
      return "RESOURCE";
    case "session.task.split":
      return "SPLIT";
    case "session.task.skip":
      return "SKIP";
    case "timer.overrun":
    case "schedule.overrun.detected":
      return "OVERRUN";
    case "inventory.shortage.detected":
      return "SHORTAGE";
    case "garden.harvest.logged":
      return "HARVEST";
    case "meal.executed":
      return "COMPLETE";
    default:
      return "CHANGE";
  }
}

function messageFor(type, d) {
  switch (type) {
    case "schedule.plan.recomputed":
      return "Plan recomputed by engine.";
    case "schedule.adjust_time":
      return `Added ${toMinutes(d?.addMs)} min to step.`;
    case "schedule.reschedule_item":
      return "Item rescheduled to a new slot.";
    case "schedule.autofit":
      return "Autofit applied to recover timeline.";
    case "schedule.resource.resolution":
      return `Resolved resource overlap (${d?.resolution?.strategy || "strategy"}).`;
    case "session.task.split":
      return `Task split with ratio ${Number(d?.ratio || d?.resolution?.ratio || 0.5)}`;
    case "session.task.skip":
      return "Task skipped.";
    case "timer.overrun":
    case "schedule.overrun.detected":
      return `Running late by ~${formatDelta(d?.deltaMs)}`;
    case "inventory.shortage.detected":
      return "Shortage impacted plan.";
    case "garden.harvest.logged":
      return "Harvest affected storehouse/plan.";
    case "meal.executed":
      return "Meal executed (final).";
    default:
      return "Plan changed.";
  }
}

function severityFor(type, d) {
  switch (type) {
    case "timer.overrun":
    case "schedule.overrun.detected":
      return (d?.deltaMs ?? 0) > 7 * 60 * 1000 ? "high" : "medium";
    case "inventory.shortage.detected":
      return "high";
    case "schedule.resource.resolution":
      return "medium";
    case "schedule.autofit":
      return "medium";
    case "session.task.skip":
      return "medium";
    case "schedule.adjust_time":
    case "schedule.reschedule_item":
      return "low";
    case "meal.executed":
    case "garden.harvest.logged":
      return "low";
    default:
      return "low";
  }
}

function guessDomain(type, d) {
  if (d?.domain) return d.domain;
  if (/meal|cook|timer/i.test(type)) return "cooking";
  if (/garden|harvest/i.test(type)) return "garden";
  if (/inventory|shortage/i.test(type)) return "storehouse";
  return "general";
}

function toMinutes(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n / 60000));
}

function formatDelta(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "n/a";
  const s = Math.max(0, Math.round(n / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function severityDot(sev = "low") {
  const s = String(sev).toLowerCase();
  if (s === "high") return "bg-red-500";
  if (s === "medium") return "bg-amber-500";
  return "bg-emerald-500";
}

function announceLive(msg, ref) {
  try {
    if (!ref?.current) return;
    ref.current.textContent = msg;
    setTimeout(() => {
      if (ref.current) ref.current.textContent = "";
    }, 800);
  } catch {
    // noop
  }
}

// File: C:\Users\larho\suka-smart-assistant\src\ui\components\scheduling\RiskActionsStrip.jsx
import React, {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useCallback,
} from "react";
import PropTypes from "prop-types";

// 🔌 Shared services (assumed to exist per project conventions)
import eventBus from "../../../services/events/eventBus";
import featureFlags from "../../../config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

/**
 * RiskActionsStrip
 * ---------------------------------------------------------------------------------
 * Purpose
 *  - Surface real-time, actionable prompts whenever a schedule, session, or task
 *    runs late (an "overrun"). This keeps the user in control and feeds the
 *    automation engine with accurate adjustments.
 *
 * Pipeline fit (imports → intelligence → automation → hub export)
 *  - Upstream engines (CookingSessionEngine, CleaningSessionEngine, GardenSessionEngine, etc.)
 *    detect overruns and emit events like `session.task.overrun` or `timer.overrun`.
 *  - This UI listens to those events and renders mitigation choices (add time,
 *    split step, skip, reschedule, auto-fit).
 *  - On user action, we emit normalized events: { type, ts, source, data } back to the
 *    eventBus so the automation runtime can recompute schedules or sessions.
 *  - If an action changes household data (e.g., reschedule, adjust estimates),
 *    we also call exportToHubIfEnabled(...) to optionally forward the update to the Hub.
 *
 * Forward-thinking / extensibility
 *  - Easily add new actionable mitigations via ACTION_BUILDERS.
 *  - Dedupe and manage multiple concurrent overruns via a reducer queue.
 *  - Listens to a small, extensible set of overrun topic names.
 *
 * Accessibility / UX
 *  - Keyboard shortcuts for primary actions.
 *  - ARIA live region for timely announcements.
 *  - Non-blocking: collapsible, auto-dismiss with undo window.
 */

// -----------------------------------------
// Constants & helpers
// -----------------------------------------
const SOURCE = "ui.RiskActionsStrip";

const OVERRUN_EVENTS = [
  "session.task.overrun", // {sessionId, taskId, plannedMs, elapsedMs, deltaMs, domain}
  "timer.overrun", // {timerId, label, plannedMs, elapsedMs, deltaMs, sessionId?, taskId?, domain?}
  "schedule.overrun.detected", // {scheduleId, itemId, plannedStart, plannedEnd, now, deltaMs, domain}
];

const AUTO_DISMISS_MS = 15000; // default window before collapsing an overrun card
const MAX_VISIBLE = 3; // keep the strip compact

const nowISO = () => new Date().toISOString();

function safeNumber(n, fallback = 0) {
  return Number.isFinite(n) ? n : fallback;
}

function formatMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

function exportToHubIfEnabled(payload) {
  // Silent no-op if feature is off or plumbing fails
  if (!featureFlags?.familyFundMode) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(packet);
  } catch {
    // fail silently by design
  }
}

// -----------------------------------------
// Reducer for overrun items
// -----------------------------------------
/**
 * Each overrun item:
 * {
 *   id: string,                 // stable dedupe key (sessionId:taskId or timerId, etc.)
 *   domain: 'cooking'|'cleaning'|'garden'|'animals'|'storehouse'|string,
 *   title: string,
 *   detail: string,
 *   deltaMs: number,
 *   payload: object,            // original data from event
 *   ts: ISOString,              // first seen
 *   lastUpdate: ISOString       // last event update
 * }
 */
function itemsReducer(state, action) {
  switch (action.type) {
    case "ADD_OR_UPDATE": {
      const incoming = action.item;
      if (!incoming?.id) return state;
      const idx = state.items.findIndex((i) => i.id === incoming.id);
      let items = [...state.items];

      if (idx >= 0) {
        // Update existing
        items[idx] = {
          ...items[idx],
          ...incoming,
          deltaMs: safeNumber(incoming.deltaMs, items[idx].deltaMs),
          payload: { ...items[idx].payload, ...incoming.payload },
          lastUpdate: nowISO(),
        };
      } else {
        // Insert new at the top
        items.unshift({
          ...incoming,
          deltaMs: safeNumber(incoming.deltaMs, 0),
          ts: nowISO(),
          lastUpdate: nowISO(),
        });
      }

      // Dedupe & clamp visible length
      const deduped = [];
      const seen = new Set();
      for (const it of items) {
        if (!seen.has(it.id)) {
          seen.add(it.id);
          deduped.push(it);
        }
        if (deduped.length >= state.maxVisible) break;
      }
      return { ...state, items: deduped };
    }
    case "DISMISS": {
      const id = action.id;
      return { ...state, items: state.items.filter((i) => i.id !== id) };
    }
    case "CLEAR":
      return { ...state, items: [] };
    default:
      return state;
  }
}

// -----------------------------------------
// Action builders (extensible)
// -----------------------------------------
/**
 * Each builder returns:
 * {
 *   key: string,
 *   label: string,
 *   title?: string,
 *   hotkey?: string,
 *   intent: 'adjust'|'skip'|'split'|'pause'|'reschedule'|'autofit',
 *   onClick: (item) => void
 * }
 */
function buildAddFiveMinAction(onEmit) {
  return {
    key: "add5",
    label: "+5 min",
    title: "Add 5 minutes to this step/timer",
    hotkey: "A",
    intent: "adjust",
    onClick: (item) => {
      const payload = {
        type: "schedule.adjust_time",
        ts: nowISO(),
        source: SOURCE,
        data: {
          reason: "user.add_time",
          addMs: 5 * 60 * 1000,
          overrunRef: item,
        },
      };
      onEmit(payload, { exportToHub: true });
    },
  };
}

function buildSkipStepAction(onEmit) {
  return {
    key: "skip",
    label: "Skip",
    title: "Skip this step and continue",
    hotkey: "S",
    intent: "skip",
    onClick: (item) => {
      const payload = {
        type: "session.task.skip",
        ts: nowISO(),
        source: SOURCE,
        data: {
          reason: "user.skip_task_overrun",
          overrunRef: item,
        },
      };
      onEmit(payload, { exportToHub: true });
    },
  };
}

function buildSplitStepAction(onEmit) {
  return {
    key: "split",
    label: "Split",
    title: "Split remaining work into two smaller steps",
    hotkey: "P",
    intent: "split",
    onClick: (item) => {
      const payload = {
        type: "session.task.split",
        ts: nowISO(),
        source: SOURCE,
        data: {
          reason: "user.split_due_to_overrun",
          overrunRef: item,
        },
      };
      onEmit(payload, { exportToHub: true });
    },
  };
}

function buildRescheduleAction(onEmit) {
  return {
    key: "resched",
    label: "Reschedule",
    title: "Move this task later and auto-fit plan",
    hotkey: "R",
    intent: "reschedule",
    onClick: (item) => {
      const payload = {
        type: "schedule.reschedule_item",
        ts: nowISO(),
        source: SOURCE,
        data: {
          mode: "auto_fit",
          reason: "user.reschedule_overrun",
          overrunRef: item,
        },
      };
      onEmit(payload, { exportToHub: true });
    },
  };
}

function buildAutofitAction(onEmit) {
  return {
    key: "autofit",
    label: "Auto-fit",
    title: "Let SSA compress/expand neighbors to recover",
    hotkey: "F",
    intent: "autofit",
    onClick: (item) => {
      const payload = {
        type: "schedule.autofit",
        ts: nowISO(),
        source: SOURCE,
        data: {
          strategy: "compress_neighbors|defer_low_priority",
          reason: "user.autofit_overrun",
          overrunRef: item,
        },
      };
      onEmit(payload, { exportToHub: true });
    },
  };
}

function buildPauseAllTimersAction(onEmit) {
  return {
    key: "pauseall",
    label: "Pause all",
    title: "Pause all active timers",
    hotkey: "U",
    intent: "pause",
    onClick: (item) => {
      const payload = {
        type: "timer.pause_all",
        ts: nowISO(),
        source: SOURCE,
        data: {
          reason: "user.pause_all_from_overrun",
          overrunRef: item,
        },
      };
      onEmit(payload, { exportToHub: false });
    },
  };
}

// -----------------------------------------
// Main component
// -----------------------------------------
const initialState = { items: [], maxVisible: MAX_VISIBLE };

export default function RiskActionsStrip({
  className = "",
  autoDismissMs = AUTO_DISMISS_MS,
  injectOverrun, // optional: { id, domain, title, detail, deltaMs, payload }
  compact = false,
}) {
  const [state, dispatch] = useReducer(itemsReducer, initialState);
  const liveRegionRef = useRef(null);

  // Emit wrapper to centralize bus + hub behavior
  const emitAction = useCallback((payload, opts = { exportToHub: false }) => {
    // Defensive payload shape
    if (!payload || typeof payload !== "object") return;
    if (!payload.type) return;

    // Bus first
    try {
      eventBus.emit(payload.type, payload);
      eventBus.emit("ui.action", payload); // generic fan-out for analytics
    } catch {
      // swallow
    }

    // Optional hub export (only for data-changing actions)
    if (opts.exportToHub) exportToHubIfEnabled(payload);
  }, []);

  // Build actions (stable)
  const ACTIONS = useMemo(
    () => [
      buildAddFiveMinAction(emitAction),
      buildSkipStepAction(emitAction),
      buildSplitStepAction(emitAction),
      buildRescheduleAction(emitAction),
      buildAutofitAction(emitAction),
      buildPauseAllTimersAction(emitAction),
    ],
    [emitAction]
  );

  // Subscribe to overrun events
  useEffect(() => {
    const unsubscribers = OVERRUN_EVENTS.map((evt) =>
      eventBus.on(evt, (e) => {
        const formatted = normalizeOverrunEvent(evt, e);
        if (!formatted) return;
        dispatch({ type: "ADD_OR_UPDATE", item: formatted });
        announceLive(
          `${formatted.title}: running late by ${formatMs(formatted.deltaMs)}`
        );
      })
    );
    return () =>
      unsubscribers.forEach((off) => {
        try {
          off?.();
        } catch {
          /* noop */
        }
      });
  }, []);

  // Controlled injection hook
  useEffect(() => {
    if (!injectOverrun) return;
    const { id, domain, title, detail, deltaMs, payload } = injectOverrun || {};
    if (!id || !title) return;
    dispatch({
      type: "ADD_OR_UPDATE",
      item: {
        id,
        domain: domain || "general",
        title,
        detail: detail || "",
        deltaMs: safeNumber(deltaMs, 0),
        payload: payload || {},
      },
    });
  }, [injectOverrun]);

  // Auto-dismiss timers per item
  useEffect(() => {
    if (autoDismissMs <= 0) return;
    const timers = state.items.map((item) =>
      setTimeout(() => {
        dispatch({ type: "DISMISS", id: item.id });
      }, autoDismissMs)
    );
    return () => timers.forEach((t) => clearTimeout(t));
  }, [state.items, autoDismissMs]);

  // Keyboard shortcuts (when strip is visible)
  useEffect(() => {
    if (state.items.length === 0) return;
    const handler = (e) => {
      const key = e.key?.toUpperCase();
      const top = state.items[0];
      const match = ACTIONS.find((a) => a.hotkey === key);
      if (match) {
        e.preventDefault();
        match.onClick(top);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [state.items, ACTIONS]);

  // Live region announce
  const announceLive = (msg) => {
    if (!liveRegionRef.current) return;
    liveRegionRef.current.textContent = msg;
    // Clear after a beat to allow re-announcement of similar text
    setTimeout(() => {
      if (liveRegionRef.current) liveRegionRef.current.textContent = "";
    }, 1000);
  };

  if (state.items.length === 0) {
    return (
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        ref={liveRegionRef}
      />
    );
  }

  return (
    <div className={`w-full ${compact ? "" : "px-3"} print:hidden`}>
      <div
        className={`
          flex flex-col gap-2 rounded-2xl shadow-md border
          bg-amber-50 border-amber-200
          ${compact ? "p-2" : "p-3"}
        `}
        role="region"
        aria-label="Schedule risk and overrun actions"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="inline-flex h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
            <h3 className="text-sm font-semibold text-amber-900">
              Running late — recover your plan
            </h3>
          </div>
          <button
            onClick={() => dispatch({ type: "CLEAR" })}
            className="text-xs text-amber-800/80 hover:text-amber-900 underline"
            aria-label="Dismiss all overrun prompts"
          >
            Dismiss all
          </button>
        </div>

        {state.items.map((item) => (
          <OverrunCard
            key={item.id}
            item={item}
            actions={ACTIONS}
            onDismiss={() => dispatch({ type: "DISMISS", id: item.id })}
          />
        ))}
      </div>

      {/* ARIA live region for announcements */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        ref={liveRegionRef}
      />
    </div>
  );
}

RiskActionsStrip.propTypes = {
  className: PropTypes.string,
  autoDismissMs: PropTypes.number,
  injectOverrun: PropTypes.shape({
    id: PropTypes.string.isRequired,
    domain: PropTypes.string,
    title: PropTypes.string.isRequired,
    detail: PropTypes.string,
    deltaMs: PropTypes.number,
    payload: PropTypes.object,
  }),
  compact: PropTypes.bool,
};

// -----------------------------------------
// Presentational subcomponent
// -----------------------------------------
function OverrunCard({ item, actions, onDismiss }) {
  const { title, detail, deltaMs, domain } = item;

  // Intent grouping for button order
  const primary = actions.filter((a) =>
    ["adjust", "autofit"].includes(a.intent)
  );
  const secondary = actions.filter((a) =>
    ["reschedule", "split", "skip"].includes(a.intent)
  );
  const utility = actions.filter((a) => a.intent === "pause");

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border bg-white/70 backdrop-blur p-3 border-amber-200"
      role="group"
      aria-label={`${domain ?? "task"} overrun options`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-amber-900 truncate">
            {title}
          </div>
          <div className="text-xs text-amber-800/80 mt-0.5 line-clamp-2">
            {detail || "This step is taking longer than expected."}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-200"
            title={`Overrun of ${formatMs(deltaMs)}`}
          >
            +{formatMs(deltaMs)}
          </span>
          <button
            onClick={onDismiss}
            className="text-xs text-amber-800/80 hover:text-amber-900"
            aria-label="Dismiss this prompt"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {primary.map((a) => (
          <ActionButton key={a.key} a={a} item={item} priority="primary" />
        ))}
        {secondary.map((a) => (
          <ActionButton key={a.key} a={a} item={item} priority="secondary" />
        ))}
        {utility.map((a) => (
          <ActionButton key={a.key} a={a} item={item} priority="utility" />
        ))}
      </div>

      <div className="text-[10px] text-amber-700/80">
        Shortcuts: {actions.map((a) => `${a.label} [${a.hotkey}]`).join(" • ")}
      </div>
    </div>
  );
}

OverrunCard.propTypes = {
  item: PropTypes.object.isRequired,
  actions: PropTypes.array.isRequired,
  onDismiss: PropTypes.func.isRequired,
};

function ActionButton({ a, item, priority }) {
  const styles =
    priority === "primary"
      ? "bg-amber-600 text-white hover:bg-amber-700"
      : priority === "secondary"
      ? "bg-amber-100 text-amber-900 hover:bg-amber-200 border border-amber-200"
      : "bg-white text-amber-900 hover:bg-amber-50 border border-amber-200";

  return (
    <button
      onClick={() => a.onClick(item)}
      title={a.title}
      className={`text-xs px-3 py-1 rounded-lg ${styles} focus:outline-none focus:ring-2 focus:ring-amber-400`}
      aria-keyshortcuts={a.hotkey}
      data-intent={a.intent}
      data-action={a.key}
    >
      {a.label}
    </button>
  );
}

ActionButton.propTypes = {
  a: PropTypes.shape({
    key: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    title: PropTypes.string,
    hotkey: PropTypes.string,
    intent: PropTypes.string.isRequired,
    onClick: PropTypes.func.isRequired,
  }).isRequired,
  item: PropTypes.object.isRequired,
  priority: PropTypes.oneOf(["primary", "secondary", "utility"]).isRequired,
};

// -----------------------------------------
// Event normalization
// -----------------------------------------
function normalizeOverrunEvent(evtType, e) {
  try {
    if (!e || typeof e !== "object") return null;

    // Allow both direct payload or wrapped { type, data }
    const data = e.data ?? e;

    // Compute a stable id to dedupe prompts
    const id =
      data?.taskId && data?.sessionId
        ? `${data.sessionId}:${data.taskId}`
        : data?.timerId
        ? `timer:${data.timerId}`
        : data?.scheduleId && data?.itemId
        ? `sched:${data.scheduleId}:${data.itemId}`
        : null;

    if (!id) return null;

    const domain =
      data?.domain ||
      (data?.label?.toLowerCase().includes("boil") ? "cooking" : "general");

    // Human title/detail
    const title =
      data?.label ||
      (data?.taskId
        ? `Task ${data.taskId}`
        : data?.itemId
        ? `Item ${data.itemId}`
        : "Late step");

    const planned = safeNumber(data?.plannedMs ?? 0, 0);
    const elapsed = safeNumber(data?.elapsedMs ?? 0, 0);
    const deltaMs = safeNumber(data?.deltaMs ?? elapsed - planned, 0);

    const detail = buildDetail(evtType, data, deltaMs);

    return {
      id,
      domain,
      title,
      detail,
      deltaMs,
      payload: data,
    };
  } catch {
    return null;
  }
}

function buildDetail(evtType, data, deltaMs) {
  const base = `${evtType.replaceAll(".", " ")} • +${formatMs(deltaMs)}`;
  if (data?.label) return `${base} • ${data.label}`;
  if (data?.taskId) return `${base} • Task ${data.taskId}`;
  return base;
}

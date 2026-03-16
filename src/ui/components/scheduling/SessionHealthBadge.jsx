// File: C:\Users\larho\suka-smart-assistant\src\ui\components\scheduling\SessionHealthBadge.jsx
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import PropTypes from "prop-types";

// 🔌 Shared services (assumed to exist per SSA conventions)
import eventBus from "../../../services/events/eventBus";
import featureFlags from "../../../config/featureFlags";
import HubPacketFormatter from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

/**
 * SessionHealthBadge
 * ---------------------------------------------------------------------------------
 * Purpose
 *  - Compact green/amber/red indicator for a session's "health" with a hover/focus
 *    tooltip listing reasons (risks, overruns, shortages, conflicts).
 *
 * Pipeline fit (imports → intelligence → automation → (optional) hub export)
 *  - Upstream engines compute health signals and emit `session.health.updated`.
 *  - This badge renders the summary and exposes small actions:
 *      • "Auto-fit plan" → emits `schedule.autofit` (changes schedule → optional Hub export)
 *      • "Acknowledge"   → emits `session.health.ack` (analytics only)
 *      • "Open details"  → emits `ui.session.open_details` (UI navigation / analytics)
 *  - All emissions use normalized payload shape { type, ts, source, data } (ISO ts).
 *
 * Forward-thinking
 *  - Domain-agnostic; accepts domain in props & events (cooking/cleaning/garden/animals/storehouse).
 *  - Extensible reason taxonomy (severity, code, message, meta).
 *  - Defensive: safe defaults, no crashes on malformed input, ARIA-friendly tooltip.
 */

const SOURCE = "ui.SessionHealthBadge";
const nowISO = () => new Date().toISOString();

// Optional: export schedule-changing actions to Hub (Family Fund) if enabled.
function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    FamilyFundConnector.send(packet);
  } catch {
    // fail silently by design
  }
}

/**
 * Compute overall health level from reasons:
 * - red   if any reason.severity === 'high'
 * - amber if none high but any 'medium'
 * - green otherwise
 */
function computeHealthLevel(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  const hasHigh = list.some(
    (r) => (r?.severity || "").toLowerCase() === "high"
  );
  if (hasHigh) return "red";
  const hasMed = list.some(
    (r) => (r?.severity || "").toLowerCase() === "medium"
  );
  if (hasMed) return "amber";
  return "green";
}

function classFor(level) {
  switch (level) {
    case "red":
      return {
        dot: "bg-red-600",
        ring: "ring-red-200",
        text: "text-red-700",
        bg: "bg-red-50",
        border: "border-red-200",
      };
    case "amber":
      return {
        dot: "bg-amber-500",
        ring: "ring-amber-200",
        text: "text-amber-800",
        bg: "bg-amber-50",
        border: "border-amber-200",
      };
    default:
      return {
        dot: "bg-emerald-600",
        ring: "ring-emerald-200",
        text: "text-emerald-700",
        bg: "bg-emerald-50",
        border: "border-emerald-200",
      };
  }
}

/**
 * Normalize incoming health record into:
 * {
 *   sessionId, domain, level, reasons: [{ code, severity, message, meta }],
 *   updatedAt
 * }
 */
function normalizeHealth(h) {
  if (!h || typeof h !== "object") {
    return {
      sessionId: undefined,
      domain: "general",
      level: "green",
      reasons: [],
      updatedAt: nowISO(),
    };
  }
  const reasons = Array.isArray(h.reasons) ? h.reasons : [];
  const level = h.level || computeHealthLevel(reasons);
  return {
    sessionId: h.sessionId,
    domain: h.domain || "general",
    level,
    reasons,
    updatedAt: h.updatedAt || nowISO(),
  };
}

export default function SessionHealthBadge({
  sessionId,
  domain = "general",
  health, // optional initial health object { level?, reasons? }
  showLabel = true,
  className = "",
}) {
  const [state, setState] = useState(() =>
    normalizeHealth({ ...(health || {}), sessionId, domain })
  );
  const [open, setOpen] = useState(false);
  const tooltipRef = useRef(null);
  const triggerRef = useRef(null);

  // Subscribe to health updates for this session (or general updates tagged with sessionId)
  useEffect(() => {
    const off = eventBus.on("session.health.updated", (e) => {
      const data = e?.data || e;
      if (!data) return;
      if (sessionId && data.sessionId !== sessionId) return;
      setState((prev) =>
        normalizeHealth({
          ...prev,
          ...data,
          sessionId: data.sessionId || prev.sessionId || sessionId,
          domain: data.domain || prev.domain || domain,
        })
      );
    });

    // Also degrade health based on certain runtime risks (optional patterns)
    const offOverrun = eventBus.on("schedule.overrun.detected", (e) => {
      const d = e?.data || {};
      if (sessionId && d.sessionId !== sessionId) return;
      // Add a medium risk reason if not present
      setState((prev) => {
        const reasons = prev.reasons || [];
        const code = "OVERRUN";
        const exists = reasons.some((r) => r.code === code);
        const newReasons = exists
          ? reasons
          : [
              ...reasons,
              {
                code,
                severity: "medium",
                message: `Running late by ~${formatDelta(d?.deltaMs)}`,
                meta: { deltaMs: d?.deltaMs },
              },
            ];
        return normalizeHealth({ ...prev, reasons: newReasons });
      });
    });

    return () => {
      try {
        off?.();
      } catch {}
      try {
        offOverrun?.();
      } catch {}
    };
  }, [sessionId, domain]);

  // Derive classes & label
  const level = state.level || computeHealthLevel(state.reasons);
  const cls = useMemo(() => classFor(level), [level]);
  const label =
    level === "green"
      ? "On track"
      : level === "amber"
      ? "At risk"
      : "Attention";

  // Actions
  const emit = useCallback((type, data, { exportToHub = false } = {}) => {
    const payload = { type, ts: nowISO(), source: SOURCE, data };
    try {
      eventBus.emit(type, payload);
      eventBus.emit("ui.action", payload);
    } catch {
      // swallow; UI shouldn't break on bus emission errors
    }
    if (exportToHub) exportToHubIfEnabled(payload);
  }, []);

  const handleAutofit = useCallback(() => {
    emit(
      "schedule.autofit",
      {
        sessionId: state.sessionId || sessionId,
        domain: state.domain || domain,
        strategy: "compress_neighbors|defer_low_priority",
        reason: "user.request_from_health_badge",
      },
      { exportToHub: true }
    );
    setOpen(false);
  }, [emit, state.sessionId, state.domain, sessionId, domain]);

  const handleAck = useCallback(() => {
    emit("session.health.ack", {
      sessionId: state.sessionId || sessionId,
      domain: state.domain || domain,
      level,
      ackTs: nowISO(),
    });
    setOpen(false);
  }, [emit, state.sessionId, sessionId, state.domain, domain, level]);

  const handleOpenDetails = useCallback(() => {
    emit("ui.session.open_details", {
      sessionId: state.sessionId || sessionId,
      domain: state.domain || domain,
      focus: "health",
    });
    setOpen(false);
  }, [emit, state.sessionId, sessionId, state.domain, domain]);

  // Tooltip open/close handlers (hover + keyboard)
  const onEnter = () => setOpen(true);
  const onLeave = (e) => {
    // Close only if leaving both trigger and tooltip regions
    if (
      e?.relatedTarget &&
      (triggerRef.current?.contains(e.relatedTarget) ||
        tooltipRef.current?.contains(e.relatedTarget))
    ) {
      return;
    }
    setOpen(false);
  };

  return (
    <div className={`relative inline-flex items-center ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
        onClick={handleOpenDetails}
        aria-describedby={`health-tip-${sessionId || "gen"}`}
        className={`group flex items-center gap-1.5 rounded-full px-2 py-1 border ${cls.border} ${cls.bg} ${cls.text} ring-1 ${cls.ring} hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1`}
      >
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${cls.dot} shadow`}
          aria-hidden="true"
        />
        {showLabel && (
          <span className="text-[11px] font-medium tracking-wide">{label}</span>
        )}
      </button>

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        id={`health-tip-${sessionId || "gen"}`}
        role="tooltip"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        className={`${
          open
            ? "opacity-100 translate-y-0 pointer-events-auto"
            : "opacity-0 -translate-y-1 pointer-events-none"
        } transition-all duration-150 absolute z-50 top-[110%] left-1/2 -translate-x-1/2 min-w-[260px] max-w-[340px]
           rounded-xl border ${cls.border} ${cls.bg} shadow-lg`}
      >
        <div className="p-3">
          <div
            className={`text-xs font-semibold ${cls.text} flex items-center justify-between`}
          >
            <span>Session health</span>
            <span className="text-[10px] opacity-70">
              {new Date(state.updatedAt || nowISO()).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </div>

          <ul className="mt-2 space-y-1.5">
            {(state.reasons || []).length === 0 ? (
              <li className="text-[11px] text-slate-600">
                No issues detected.
              </li>
            ) : (
              (state.reasons || []).map((r, idx) => (
                <li
                  key={`${r.code || "R"}-${idx}`}
                  className="text-[11px] text-slate-700 flex items-start gap-2"
                >
                  <span
                    className={`mt-1 h-1.5 w-1.5 rounded-full ${
                      r.severity === "high"
                        ? "bg-red-500"
                        : r.severity === "medium"
                        ? "bg-amber-500"
                        : "bg-emerald-500"
                    }`}
                    aria-hidden="true"
                  />
                  <span className="leading-snug">
                    <span className="font-medium">{r.code || "ISSUE"}:</span>{" "}
                    {r.message || "Unspecified"}
                  </span>
                </li>
              ))
            )}
          </ul>

          {/* Quick actions */}
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              onClick={handleAck}
              className="text-[11px] px-2 py-1 rounded-md border border-slate-300 bg-white hover:bg-slate-50"
            >
              Acknowledge
            </button>
            <button
              onClick={handleAutofit}
              className="text-[11px] px-2 py-1 rounded-md bg-blue-600 text-white hover:bg-blue-700"
              disabled={level === "green"}
              title={
                level === "green"
                  ? "No autofit needed"
                  : "Let SSA adjust schedule"
              }
            >
              Auto-fit plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

SessionHealthBadge.propTypes = {
  sessionId: PropTypes.string,
  domain: PropTypes.string,
  health: PropTypes.shape({
    sessionId: PropTypes.string,
    domain: PropTypes.string,
    level: PropTypes.oneOf(["green", "amber", "red"]),
    updatedAt: PropTypes.string,
    reasons: PropTypes.arrayOf(
      PropTypes.shape({
        code: PropTypes.string, // e.g., 'OVERRUN', 'SHORTAGE', 'CONFLICT'
        severity: PropTypes.oneOf(["low", "medium", "high"]),
        message: PropTypes.string,
        meta: PropTypes.object,
      })
    ),
  }),
  showLabel: PropTypes.bool,
  className: PropTypes.string,
};

// ----------------------
// Small helpers
// ----------------------
function formatDelta(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return "n/a";
  const s = Math.max(0, Math.round(n / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${r}s` : `${r}s`;
}

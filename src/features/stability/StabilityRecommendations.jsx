// C:\Users\larho\suka-smart-assistant\src\features\stability\StabilityRecommendations.jsx

/**
 * StabilityRecommendations
 *
 * Component: Lists targeted, human-readable suggestions based on weak areas
 * in SSA stability (device capabilities, guards, session resilience, etc.).
 *
 * How this fits:
 * - Pairs with StabilityDashboardView, StabilityRadarChart, and
 *   StabilityHistoryTimeline as the “what should I do next?” panel.
 * - Read-only: it does not start/stop sessions or guards, so it cannot
 *   interfere with the SessionRunner’s background behavior.
 *
 * Data contract (flexible, future-proof):
 * - props.dimensions?: Array<{
 *      key: string;                 // e.g. "device", "guards", "session"
 *      label?: string;
 *      score: number;               // 0–1
 *   }>
 * - props.deviceCaps?: {
 *      wakeLock?: string;           // "available" | "unavailable" | "degraded" | "unknown"
 *      notifications?: string;
 *      speech?: string;
 *      mediaSession?: string;
 *      docPictureInPicture?: string;
 *      serviceWorker?: string;
 *   }
 * - props.guardStatus?: {
 *      sabbath?: string; quietHours?: string; weather?: string;
 *      inventory?: string; battery?: string;
 *   }
 * - props.onSuggestionClick?: (suggestion: StabilitySuggestion) => void
 *
 * The component will:
 * - Identify weak dimensions (score < ~0.7) and low device/guard readiness.
 * - Generate friendly, actionable suggestions grouped by category.
 * - Show a reassuring “You’re in good shape” message when all key areas are solid.
 */

import React, { useMemo, useState, useEffect } from "react";

/**
 * @typedef {Object} StabilityDimension
 * @property {string} key
 * @property {string} [label]
 * @property {number} score
 */

/**
 * @typedef {Object} StabilitySuggestion
 * @property {string} id
 * @property {"device"|"guards"|"session"|"background"|"integration"|"general"} category
 * @property {"critical"|"important"|"nice-to-have"} priority
 * @property {string} title
 * @property {string} description
 * @property {string[]} actions
 */

const DEFAULT_DIMENSIONS = /** @type {StabilityDimension[]} */ ([
  { key: "device", label: "Device", score: 0.5 },
  { key: "guards", label: "Guards", score: 0.5 },
  { key: "session", label: "Session Runner", score: 0.5 },
  { key: "background", label: "Background", score: 0.5 },
  { key: "integration", label: "Integration", score: 0.5 },
]);

/**
 * @param {{
 *  dimensions?: StabilityDimension[],
 *  deviceCaps?: Record<string, string>,
 *  guardStatus?: Record<string, string>,
 *  onSuggestionClick?: (s: StabilitySuggestion) => void,
 *  className?: string,
 * }} props
 */
function StabilityRecommendations({
  dimensions,
  deviceCaps,
  guardStatus,
  onSuggestionClick,
  className = "",
}) {
  const [showHelpModal, setShowHelpModal] = useState(false);

  /** -----------------------------------------------------------------------
   *  Normalize inputs
   * --------------------------------------------------------------------- */

  const normalizedDims = useMemo(() => {
    const list =
      Array.isArray(dimensions) && dimensions.length
        ? dimensions
        : DEFAULT_DIMENSIONS;

    return list.map((d) => ({
      key: d.key || "dim",
      label: d.label || d.key || "Dimension",
      score: clampScore(d.score),
    }));
  }, [dimensions]);

  const deviceCapsSafe = deviceCaps || {};
  const guardStatusSafe = guardStatus || {};

  /** -----------------------------------------------------------------------
   *  Build suggestions
   * --------------------------------------------------------------------- */

  const suggestions = useMemo(() => {
    /** @type {StabilitySuggestion[]} */
    const all = [];

    // 1) Dimensional weaknesses from the radar-style scores
    normalizedDims.forEach((dim) => {
      const { key, label, score } = dim;
      const severity = classifySeverity(score);

      if (severity === "ok") return;

      const pct = Math.round(score * 100);

      if (key === "device") {
        all.push({
          id: `dim-device-${pct}`,
          category: "device",
          priority: severityToPriority(severity),
          title: "Improve device engagement features",
          description: `Your device stability score (${pct}%) suggests wake-lock, notifications, or voice features may not be fully available or configured.`,
          actions: [
            "Enable notifications for this site in your browser or device settings.",
            "Keep your device plugged in during long cooking or preservation sessions.",
            "On supported browsers, allow screen wake-lock so the display stays on while sessions run.",
          ],
        });
      } else if (key === "guards") {
        all.push({
          id: `dim-guards-${pct}`,
          category: "guards",
          priority: severityToPriority(severity),
          title: "Tighten or tune your guard rules",
          description: `Guard stability (${pct}%) indicates some sessions are being blocked or interrupted by Sabbath, quiet hours, weather, or inventory conditions.`,
          actions: [
            "Review quiet-hours so essential tasks (like animal care) can still run when needed.",
            "Align Sabbath constraints with your automation defaults so nothing starts at the wrong time.",
            "Make sure inventory levels are accurate so sessions don’t start and then fail mid-way.",
          ],
        });
      } else if (key === "session") {
        all.push({
          id: `dim-session-${pct}`,
          category: "session",
          priority: severityToPriority(severity),
          title: "Make SessionRunner smoother to use",
          description: `Session stability (${pct}%) shows that sessions may be getting paused, skipped, or aborted more than expected.`,
          actions: [
            "Keep steps short and clear so it’s easy to stay on track during busy household moments.",
            "Turn on voice guidance where possible so you can follow steps hands-free.",
            "Use the 'Now' buttons on domain pages to only start sessions when you’re actually ready.",
          ],
        });
      } else if (key === "background") {
        all.push({
          id: `dim-background-${pct}`,
          category: "background",
          priority: severityToPriority(severity),
          title: "Strengthen background behavior",
          description: `Background stability (${pct}%) suggests timers or sessions may be disrupted when you switch tabs or apps.`,
          actions: [
            "Avoid closing the browser tab while a session is running; you can still navigate within SSA.",
            "Allow notifications so you get updates even when you’re on another screen.",
            "Keep the browser window visible on devices where background timers are more restricted.",
          ],
        });
      } else if (key === "integration") {
        all.push({
          id: `dim-integration-${pct}`,
          category: "integration",
          priority: severityToPriority(severity),
          title: "Tighten Family Fund integration (optional)",
          description: `Integration stability (${pct}%) indicates some analytics or exports may not be configured yet.`,
          actions: [
            "If using FamilyFundMode, confirm your Hub connection details are set correctly.",
            "Schedule periodic reviews of session analytics to see what’s working for your household.",
            "If not using the Hub, you can ignore this and let SSA run standalone.",
          ],
        });
      } else {
        all.push({
          id: `dim-${key}-${pct}`,
          category: "general",
          priority: severityToPriority(severity),
          title: `Improve ${label} stability`,
          description: `${label} is scoring around ${pct}%. There may be configuration or usage patterns worth reviewing.`,
          actions: [
            "Review settings for this area under your stability tools.",
            "Check recent history entries for patterns in failures or interruptions.",
          ],
        });
      }
    });

    // 2) Device capability-specific suggestions
    buildDeviceSuggestions(deviceCapsSafe).forEach((s) => all.push(s));

    // 3) Guard-specific suggestions
    buildGuardSuggestions(guardStatusSafe).forEach((s) => all.push(s));

    // If nothing is weak, give a positive reinforcement suggestion
    if (all.length === 0) {
      all.push({
        id: "all-good",
        category: "general",
        priority: "nice-to-have",
        title: "You’re in great shape",
        description:
          "Your stability scores, device capabilities, and guards all look healthy. SSA is well-positioned to keep sessions running smoothly.",
        actions: [
          "Use the 'Now' buttons regularly to see how well sessions hold up in real life.",
          "Explore long-running sessions (like batch cooking or canning) to fully benefit from stability features.",
        ],
      });
    }

    // Sort by priority (critical → important → nice-to-have)
    return all.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
  }, [normalizedDims, deviceCapsSafe, guardStatusSafe]);

  /** -----------------------------------------------------------------------
   *  Small UX helpers
   * --------------------------------------------------------------------- */

  const handleSuggestionClick = (s) => {
    if (typeof onSuggestionClick === "function") {
      try {
        onSuggestionClick(s);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[StabilityRecommendations] onSuggestionClick failed", err);
      }
    }
  };

  useEffect(() => {
    const onKeyDown = (evt) => {
      if (evt.key === "Escape") {
        setShowHelpModal(false);
      }
    };
    if (showHelpModal) {
      window.addEventListener("keydown", onKeyDown);
    }
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showHelpModal]);

  /** -----------------------------------------------------------------------
   *  Render
   * --------------------------------------------------------------------- */

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5 ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">
            Stability recommendations
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            Targeted suggestions to make sessions more resilient while your
            SessionRunner continues running in the background.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowHelpModal(true)}
          className="text-[11px] text-slate-500 hover:text-slate-700 underline underline-offset-2"
        >
          How these are generated
        </button>
      </div>

      <ul className="space-y-3 max-h-80 overflow-y-auto pr-1 text-sm">
        {suggestions.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => handleSuggestionClick(s)}
              className="w-full text-left rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 hover:bg-slate-50 hover:border-slate-200 transition-colors"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="inline-flex items-center rounded-full bg-slate-900 text-white px-2 py-0.5 text-[11px] font-medium">
                      {categoryLabel(s.category)}
                    </span>
                    <PriorityBadge priority={s.priority} />
                  </div>
                  <p className="text-sm font-medium text-slate-900">
                    {s.title}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {s.description}
                  </p>
                </div>
              </div>
              <ul className="mt-2 space-y-1.5 text-xs text-slate-600 list-disc list-inside">
                {s.actions.map((a, idx) => (
                  <li key={`${s.id}-action-${idx}`}>{a}</li>
                ))}
              </ul>
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-[11px] text-slate-500">
        These suggestions are informational only. Updating your SessionRunner
        settings, guard services, or device permissions will gradually improve
        scores on the Stability Dashboard and Radar.
      </p>

      {showHelpModal && (
        <StabilityRecommendationsHelpModal onClose={() => setShowHelpModal(false)} />
      )}
    </div>
  );
}

/** -------------------------------------------------------------------------
 *  Sub-components
 * ---------------------------------------------------------------------- */

/**
 * @param {{ priority: "critical"|"important"|"nice-to-have" }} props
 */
function PriorityBadge({ priority }) {
  let label = "Nice to have";
  let classes =
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium";

  if (priority === "critical") {
    label = "High impact";
    classes += " bg-red-50 text-red-700 border-red-200";
  } else if (priority === "important") {
    label = "Important";
    classes += " bg-amber-50 text-amber-700 border-amber-200";
  } else {
    label = "Nice to have";
    classes += " bg-slate-50 text-slate-600 border-slate-200";
  }

  return (
    <span className={classes}>
      <span
        className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
          priority === "critical"
            ? "bg-red-500"
            : priority === "important"
            ? "bg-amber-500"
            : "bg-slate-400"
        }`}
      />
      {label}
    </span>
  );
}

/**
 * Small modal explaining how recommendations are calculated.
 *
 * This is a local, informational modal — it does NOT interact with
 * SessionRunner and will not impact background timers or wake-lock.
 *
 * @param {{ onClose: () => void }} props
 */
function StabilityRecommendationsHelpModal({ onClose }) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60"
      role="dialog"
      aria-modal="true"
      aria-label="Stability recommendation details"
    >
      <div className="relative w-full max-w-md mx-4 my-6 bg-white rounded-2xl shadow-xl border border-slate-200">
        <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-slate-100">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              How recommendations are generated
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              SSA looks at your stability dimensions, device capabilities, and
              guard statuses to suggest the next best tweaks.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Close"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>
        <div className="px-4 py-4 space-y-3 text-sm text-slate-700">
          <p>
            Each recommendation is based on one or more “weak spots” detected
            in:
          </p>
          <ul className="list-disc list-inside space-y-1 text-sm">
            <li>
              <span className="font-medium">Radar dimensions:</span> device
              readiness, guard behavior, session resilience, background
              behavior, and Hub integration.
            </li>
            <li>
              <span className="font-medium">Device capabilities:</span> whether
              wake-lock, notifications, voice, or Picture-in-Picture are
              available or restricted.
            </li>
            <li>
              <span className="font-medium">Guards:</span> Sabbath, quiet
              hours, weather, inventory, and battery checks that can stop or
              delay sessions.
            </li>
          </ul>
          <p className="text-xs text-slate-500">
            You can safely read and follow these tips while your SessionRunner
            is active; they don&apos;t interfere with any running sessions.
          </p>
        </div>
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** -------------------------------------------------------------------------
 *  Suggestion builders
 * ---------------------------------------------------------------------- */

/**
 * @param {Record<string,string>} caps
 * @returns {StabilitySuggestion[]}
 */
function buildDeviceSuggestions(caps) {
  /** @type {StabilitySuggestion[]} */
  const out = [];

  const notifications = caps.notifications;
  if (notifications && notifications !== "available") {
    out.push({
      id: "cap-notifications",
      category: "device",
      priority: notifications === "unavailable" ? "critical" : "important",
      title: "Enable notifications for step alerts",
      description:
        "SSA can send gentle alerts when steps change, timers finish, or sessions pause — but only if notifications are allowed.",
      actions: [
        "Allow notifications for this site in your browser settings.",
        "On mobile, ensure system notification settings for your browser are enabled.",
        "Once enabled, run a short test session to confirm you see step-change notifications.",
      ],
    });
  }

  const wakeLock = caps.wakeLock;
  if (wakeLock && wakeLock !== "available") {
    out.push({
      id: "cap-wakelock",
      category: "device",
      priority: "important",
      title: "Keep the screen awake during long sessions",
      description:
        "Without wake-lock, some devices may dim or lock the screen, making it easy to lose track of steps.",
      actions: [
        "Consider increasing your device’s auto-lock timeout during long cooking or preservation sessions.",
        "If your browser supports it, allow screen wake-lock when prompted by SSA.",
      ],
    });
  }

  const speech = caps.speech;
  if (speech && speech !== "available") {
    out.push({
      id: "cap-speech",
      category: "device",
      priority: "nice-to-have",
      title: "Use voice guidance when possible",
      description:
        "Text-to-speech lets SSA read steps aloud so your hands can stay on the task instead of the screen.",
      actions: [
        "Use an up-to-date desktop or mobile browser that supports SpeechSynthesis.",
        "If voice feels distracting, keep it off for now and rely on visual cues and notifications.",
      ],
    });
  }

  const pip = caps.docPictureInPicture;
  if (pip && pip !== "available") {
    out.push({
      id: "cap-pip",
      category: "background",
      priority: "nice-to-have",
      title: "Consider a browser with mini control window support",
      description:
        "On some desktop browsers, SSA can float a tiny control HUD above other windows using Document Picture-in-Picture.",
      actions: [
        "If you frequently multitask on desktop, try a Chromium-based browser with Picture-in-Picture support.",
        "Even without PiP, you can keep the SessionRunner on a side of the screen while using other tools.",
      ],
    });
  }

  const sw = caps.serviceWorker;
  if (sw && sw !== "available") {
    out.push({
      id: "cap-serviceworker",
      category: "background",
      priority: "important",
      title: "Upgrade to a browser with Service Worker support",
      description:
        "Service workers help SSA keep notifications and some background logic running more reliably.",
      actions: [
        "Use a modern browser that supports service workers for best stability.",
        "If you must use an older browser, keep the SSA tab visible during critical sessions.",
      ],
    });
  }

  return out;
}

/**
 * @param {Record<string,string>} guards
 * @returns {StabilitySuggestion[]}
 */
function buildGuardSuggestions(guards) {
  /** @type {StabilitySuggestion[]} */
  const out = [];

  if (guards.sabbath === "failing" || guards.sabbath === "degraded") {
    out.push({
      id: "guard-sabbath",
      category: "guards",
      priority: "critical",
      title: "Align Sabbath guard with your automation rules",
      description:
        "Sessions may be trying to start during the Sabbath when they shouldn’t, or being blocked when they should be allowed.",
      actions: [
        "Review your Sabbath guard configuration so it matches your actual practice (start/end times, domains affected).",
        "Decide which domains (e.g., animals vs. cleaning) are allowed during Sabbath, and update the guard list.",
      ],
    });
  }

  if (guards.quietHours === "failing" || guards.quietHours === "degraded") {
    out.push({
      id: "guard-quietHours",
      category: "guards",
      priority: "important",
      title: "Tune quiet hours to your household rhythm",
      description:
        "If quiet hours are too strict, important tasks may be delayed; if too loose, alerts may disrupt rest.",
      actions: [
        "Ensure quiet hours start and end when your household is actually resting.",
        "Mark low-noise domains (like planning / storehouse updates) as allowed during quiet hours if needed.",
      ],
    });
  }

  if (guards.weather === "failing" || guards.weather === "degraded") {
    out.push({
      id: "guard-weather",
      category: "guards",
      priority: "important",
      title: "Improve weather-aware scheduling",
      description:
        "Outdoor tasks like garden work or animal care may be clashing with poor conditions.",
      actions: [
        "Verify your weather provider or manual checks are accurate for your location.",
        "Schedule outdoor tasks earlier or later in the day based on typical patterns in your area.",
      ],
    });
  }

  if (guards.inventory === "failing" || guards.inventory === "degraded") {
    out.push({
      id: "guard-inventory",
      category: "guards",
      priority: "critical",
      title: "Keep inventory in sync with reality",
      description:
        "Sessions that start without enough ingredients or supplies will stall or produce poor results.",
      actions: [
        "Regularly reconcile your storehouse inventory with what’s physically on hand.",
        "Use SSA’s batch imports and scanning tools to keep counts updated with minimal manual entry.",
        "Flag key ingredients and supplies that should always trigger a restock reminder when low.",
      ],
    });
  }

  if (guards.battery === "failing" || guards.battery === "degraded") {
    out.push({
      id: "guard-battery",
      category: "device",
      priority: "critical",
      title: "Protect sessions from low battery interruptions",
      description:
        "Low battery during long sessions can cause unexpected browser shutdowns and lost progress.",
      actions: [
        "Plug your device in before starting long-running sessions like canning, smoking, or batch cooking.",
        "Keep a visual habit of checking battery level when the SessionRunner opens.",
      ],
    });
  }

  return out;
}

/** -------------------------------------------------------------------------
 *  Misc helpers
 * ---------------------------------------------------------------------- */

/**
 * @param {number} value
 * @returns {number}
 */
function clampScore(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * @param {number} score
 * @returns {"ok"|"warn"|"poor"}
 */
function classifySeverity(score) {
  const s = clampScore(score);
  if (s >= 0.75) return "ok";
  if (s >= 0.45) return "warn";
  return "poor";
}

/**
 * @param {"ok"|"warn"|"poor"} severity
 * @returns {"critical"|"important"|"nice-to-have"}
 */
function severityToPriority(severity) {
  if (severity === "poor") return "critical";
  if (severity === "warn") return "important";
  return "nice-to-have";
}

/**
 * @param {"critical"|"important"|"nice-to-have"} priority
 * @returns {number}
 */
function priorityRank(priority) {
  if (priority === "critical") return 0;
  if (priority === "important") return 1;
  return 2;
}

/**
 * @param {"device"|"guards"|"session"|"background"|"integration"|"general"} cat
 * @returns {string}
 */
function categoryLabel(cat) {
  switch (cat) {
    case "device":
      return "Device";
    case "guards":
      return "Guards";
    case "session":
      return "Session Runner";
    case "background":
      return "Background";
    case "integration":
      return "Integration";
    default:
      return "General";
  }
}

export default StabilityRecommendations;

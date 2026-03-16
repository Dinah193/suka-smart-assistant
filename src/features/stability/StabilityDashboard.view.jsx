// C:\Users\larho\suka-smart-assistant\src\features\stability\StabilityDashboard.view.jsx

/**
 * StabilityDashboardView
 *
 * Main stability dashboard UI for SSA.
 *
 * Purpose:
 * - Give users (and you, the builder) a single place to see:
 *   • Session resilience status (running session, checkpoints, last resume).
 *   • Guard readiness (Sabbath, Quiet Hours, Weather, Inventory).
 *   • Device capabilities for engagement (Wake Lock, Notifications, Speech, Media Session, PiP).
 *   • Background / worker health checks (where available).
 * - Provide an ergonomic, “control center” style overview with a modal for deep-dive details.
 *
 * How this fits:
 * - Read-only UI that surfaces what the SessionRunner + guards + browser can do.
 * - Emits a “session.test.request” event to let a SessionRunner listener spin up a test session.
 * - Shows live updates when session.* events fire on the eventBus.
 *
 * Notes:
 * - This file doesn’t own the SessionRunner modal; it just interacts with it via events.
 * - The root-level SessionRunner overlay (mounted in App.jsx or similar) should:
 *    • keep running when the user navigates away,
 *    • use Wake Lock / Notifications / PiP as configured,
 *    • listen for the “session.test.request” event from this dashboard.
 */

import React, { useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom";

import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

// Defensive optional chaining helpers in case imports change shape later
const safeEventBus = {
  emit: (...args) => {
    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit(...args);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[StabilityDashboard] eventBus.emit failed", err);
    }
  },
  on: (type, handler) => {
    try {
      if (eventBus && typeof eventBus.on === "function") {
        eventBus.on(type, handler);
        return () => {
          if (eventBus && typeof eventBus.off === "function") {
            eventBus.off(type, handler);
          }
        };
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[StabilityDashboard] eventBus.on failed", err);
    }
    return () => {};
  },
};

const INITIAL_CAPS = {
  wakeLock: "unknown",
  notifications: "unknown",
  speech: "unknown",
  mediaSession: "unknown",
  docPictureInPicture: "unknown",
  serviceWorker: "unknown",
};

const INITIAL_GUARDS = {
  sabbath: "unknown",
  quietHours: "unknown",
  weather: "unknown",
  inventory: "unknown",
  battery: "unknown",
};

function StabilityDashboardView() {
  const [deviceCaps, setDeviceCaps] = useState(INITIAL_CAPS);
  const [guardStatus, setGuardStatus] = useState(INITIAL_GUARDS);
  const [lastSessionEvent, setLastSessionEvent] = useState(null);
  const [runningSession, setRunningSession] = useState(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailModalTab, setDetailModalTab] = useState("device");
  const [isFamilyFundMode, setIsFamilyFundMode] = useState(false);

  /** -----------------------------------------------------------------------
   *  Derived status helpers
   * --------------------------------------------------------------------- */

  const overallHealth = useMemo(() => {
    const caps = Object.values(deviceCaps);
    const guards = Object.values(guardStatus);

    const hasUnknownCaps = caps.includes("unknown");
    const hasBadCaps = caps.includes("unavailable");
    const hasWarnCaps = caps.includes("degraded");

    const hasUnknownGuards = guards.includes("unknown");
    const hasBadGuards = guards.includes("failing");
    const hasWarnGuards = guards.includes("degraded");

    if (hasBadCaps || hasBadGuards) return "at-risk";
    if (hasWarnCaps || hasWarnGuards) return "limited";
    if (hasUnknownCaps && hasUnknownGuards) return "checking";
    return "stable";
  }, [deviceCaps, guardStatus]);

  const overallHealthLabel = {
    "at-risk": "At Risk",
    limited: "Limited",
    checking: "Checking",
    stable: "Stable",
  }[overallHealth];

  const overallHealthBadgeClasses = {
    "at-risk": "bg-red-100 text-red-800 border-red-300",
    limited: "bg-amber-100 text-amber-800 border-amber-300",
    checking: "bg-slate-100 text-slate-700 border-slate-300",
    stable: "bg-emerald-100 text-emerald-800 border-emerald-300",
  }[overallHealth];

  /** -----------------------------------------------------------------------
   *  Capability + guard checks
   * --------------------------------------------------------------------- */

  useEffect(() => {
    // Feature flags
    try {
      if (typeof familyFundMode === "boolean") {
        setIsFamilyFundMode(familyFundMode);
      } else if (typeof familyFundMode === "function") {
        setIsFamilyFundMode(!!familyFundMode());
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[StabilityDashboard] familyFundMode read failed", err);
    }

    // Device capability probing (purely read-only)
    const caps = { ...INITIAL_CAPS };

    // Wake Lock
    if ("wakeLock" in (navigator || {})) {
      caps.wakeLock = "available";
    } else {
      caps.wakeLock = "unavailable";
    }

    // Notifications
    if ("Notification" in window) {
      const perm = window.Notification.permission;
      if (perm === "granted") caps.notifications = "available";
      else if (perm === "denied") caps.notifications = "unavailable";
      else caps.notifications = "degraded"; // "default"
    } else {
      caps.notifications = "unavailable";
    }

    // Speech synthesis
    if ("speechSynthesis" in window) {
      caps.speech = "available";
    } else {
      caps.speech = "unavailable";
    }

    // Media Session
    if ("mediaSession" in navigator) {
      caps.mediaSession = "available";
    } else {
      caps.mediaSession = "unavailable";
    }

    // Document Picture-in-Picture (Chromium)
    if (
      "documentPictureInPicture" in window ||
      "DocumentPictureInPicture" in window
    ) {
      caps.docPictureInPicture = "available";
    } else {
      caps.docPictureInPicture = "unavailable";
    }

    // Service Worker
    if ("serviceWorker" in navigator) {
      caps.serviceWorker = "available";
    } else {
      caps.serviceWorker = "unavailable";
    }

    setDeviceCaps(caps);

    // Guards: here we just mark we “don’t know yet” and rely on guard
    // services to emit better statuses via the eventBus if/when you add them.
    const guards = { ...INITIAL_GUARDS };

    // Battery as a guard: we can probe if supported
    if ("getBattery" in navigator) {
      guards.battery = "checking";
      // eslint-disable-next-line no-undef
      navigator.getBattery().then(
        (battery) => {
          const level = battery.level; // 0–1
          setGuardStatus((prev) => ({
            ...prev,
            battery: level < 0.2 ? "failing" : level < 0.4 ? "degraded" : "ok",
          }));
        },
        () => {
          setGuardStatus((prev) => ({
            ...prev,
            battery: "unknown",
          }));
        }
      );
    } else {
      guards.battery = "unknown";
    }

    setGuardStatus((prev) => ({ ...guards, ...prev }));
  }, []);

  /** -----------------------------------------------------------------------
   *  Session event subscription
   * --------------------------------------------------------------------- */

  useEffect(() => {
    const unsubscribeStarted = safeEventBus.on(
      "session.started",
      (payload = {}) => {
        setLastSessionEvent({
          type: "session.started",
          ts: payload.ts || new Date().toISOString(),
          data: payload.data || payload,
        });
        setRunningSession(payload.data?.session || payload.session || null);
      }
    );

    const unsubscribeStepChanged = safeEventBus.on(
      "session.step.changed",
      (payload = {}) => {
        setLastSessionEvent({
          type: "session.step.changed",
          ts: payload.ts || new Date().toISOString(),
          data: payload.data || payload,
        });
        if (payload.data?.session || payload.session) {
          setRunningSession(payload.data?.session || payload.session);
        }
      }
    );

    const unsubscribeStateEvents = [
      "session.paused",
      "session.resumed",
      "session.completed",
      "session.aborted",
      "session.exported",
    ].map((type) =>
      safeEventBus.on(type, (payload = {}) => {
        setLastSessionEvent({
          type,
          ts: payload.ts || new Date().toISOString(),
          data: payload.data || payload,
        });
        if (type === "session.completed" || type === "session.aborted") {
          setRunningSession(null);
        } else if (payload.data?.session || payload.session) {
          setRunningSession(payload.data?.session || payload.session);
        }
      })
    );

    return () => {
      unsubscribeStarted();
      unsubscribeStepChanged();
      unsubscribeStateEvents.forEach((u) => u && u());
    };
  }, []);

  /** -----------------------------------------------------------------------
   *  Actions
   * --------------------------------------------------------------------- */

  const handleRequestNotificationPermission = async () => {
    if (!("Notification" in window) || !window.Notification.requestPermission) {
      return;
    }
    try {
      const perm = await window.Notification.requestPermission();
      setDeviceCaps((prev) => ({
        ...prev,
        notifications:
          perm === "granted"
            ? "available"
            : perm === "denied"
            ? "unavailable"
            : "degraded",
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        "[StabilityDashboard] Notification.requestPermission error",
        err
      );
    }
  };

  const handleEmitTestSession = () => {
    const ts = new Date().toISOString();
    const sessionId = `stability-test-${ts}`;

    const debugSession = {
      id: sessionId,
      domain: "cooking",
      title: "Stability Test Session",
      source: { type: "manual", refId: null },
      steps: [
        {
          id: `${sessionId}-1`,
          title: "Short Countdown",
          desc: "A 15 second timer to test wake-lock, notifications, and controls.",
          durationSec: 15,
          blockers: [],
          metadata: {
            tempTargetF: 0,
            donenessCue: "timer",
            cueNotes:
              "You should see/read/hear step-change cues from SessionRunner.",
          },
        },
        {
          id: `${sessionId}-2`,
          title: "Extended Timer",
          desc: "A 45 second timer to test background resilience and PiP.",
          durationSec: 45,
          blockers: [],
          metadata: {
            tempTargetF: 0,
            donenessCue: "timer",
            cueNotes:
              "Navigate around the app and confirm the runner persists.",
          },
        },
      ],
      prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
      status: "pending",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null,
      },
      analytics: { skippedSteps: [], adjustments: [] },
      createdAt: ts,
      updatedAt: ts,
    };

    safeEventBus.emit({
      type: "session.test.request",
      ts,
      source: "stability.dashboard",
      data: { session: debugSession },
    });
  };

  const openDetailModal = (tab = "device") => {
    setDetailModalTab(tab);
    setDetailModalOpen(true);
  };

  const closeDetailModal = () => {
    setDetailModalOpen(false);
  };

  /** -----------------------------------------------------------------------
   *  Render helpers
   * --------------------------------------------------------------------- */

  const renderCapStatusPill = (value) => {
    let classes =
      "inline-flex items-center px-2.5 py-0.5 rounded-full border text-xs font-medium";
    let label = value;

    switch (value) {
      case "available":
        classes += " bg-emerald-50 text-emerald-700 border-emerald-200";
        label = "Available";
        break;
      case "unavailable":
        classes += " bg-red-50 text-red-700 border-red-200";
        label = "Unavailable";
        break;
      case "degraded":
        classes += " bg-amber-50 text-amber-700 border-amber-200";
        label = "Needs attention";
        break;
      case "checking":
        classes += " bg-slate-50 text-slate-700 border-slate-200";
        label = "Checking…";
        break;
      case "ok":
        classes += " bg-emerald-50 text-emerald-700 border-emerald-200";
        label = "OK";
        break;
      case "failing":
        classes += " bg-red-50 text-red-700 border-red-200";
        label = "Failing";
        break;
      case "unknown":
      default:
        classes += " bg-slate-50 text-slate-500 border-slate-200";
        label = "Unknown";
        break;
    }

    return <span className={classes}>{label}</span>;
  };

  const renderRunningSessionSummary = () => {
    if (!runningSession) {
      return (
        <p className="text-sm text-slate-500">
          No session is currently running. Start a new session from any domain
          page or use the{" "}
          <button
            type="button"
            onClick={handleEmitTestSession}
            className="text-indigo-600 hover:text-indigo-800 font-medium underline-offset-2 hover:underline"
          >
            Run stability test session
          </button>{" "}
          button.
        </p>
      );
    }

    const stepIndex =
      typeof runningSession.progress?.currentStepIndex === "number"
        ? runningSession.progress.currentStepIndex
        : 0;
    const totalSteps = Array.isArray(runningSession.steps)
      ? runningSession.steps.length
      : 0;
    const currentStep =
      Array.isArray(runningSession.steps) && runningSession.steps[stepIndex]
        ? runningSession.steps[stepIndex]
        : null;

    return (
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500">
              Active session
            </p>
            <p className="text-sm font-medium text-slate-900">
              {runningSession.title || "Untitled session"}
            </p>
          </div>
          <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700 border border-indigo-100">
            {runningSession.domain || "–"}
          </span>
        </div>
        <div className="text-sm text-slate-600">
          <p>
            Step {stepIndex + 1} of {totalSteps}
            {currentStep ? ` — ${currentStep.title}` : ""}
          </p>
          <p className="text-xs text-slate-500 mt-1">
            Status:{" "}
            <span className="font-medium text-slate-800">
              {runningSession.status || "running"}
            </span>
          </p>
        </div>
      </div>
    );
  };

  const renderLastEvent = () => {
    if (!lastSessionEvent) {
      return (
        <p className="text-sm text-slate-500">
          No recent session events. Start a session to see live event telemetry
          here.
        </p>
      );
    }
    const { type, ts } = lastSessionEvent;
    return (
      <div className="space-y-1">
        <p className="text-sm font-medium text-slate-900">{type}</p>
        <p className="text-xs text-slate-500">
          {new Date(ts).toLocaleString(undefined, {
            hour: "numeric",
            minute: "2-digit",
            second: "2-digit",
            year: "numeric",
            month: "short",
            day: "numeric",
          })}
        </p>
        <p className="text-xs text-slate-500">
          Stream: <span className="font-mono text-[11px]">session.*</span>
        </p>
      </div>
    );
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-50">
      <div className="max-w-6xl mx-auto px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900">
              Stability &amp; Resilience
            </h1>
            <p className="mt-1 text-sm text-slate-600 max-w-xl">
              See how well Suka Smart Assistant can keep sessions running in the
              background, stay in sync across pages, and keep your household
              flows stable.
            </p>
          </div>
          <div className="flex flex-col items-end gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Overall stability
              </span>
              <span
                className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${overallHealthBadgeClasses}`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full mr-1.5"
                  aria-hidden="true"
                />
                {overallHealthLabel}
              </span>
            </div>
            <button
              type="button"
              onClick={handleEmitTestSession}
              className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-300" />
              Run stability test session
            </button>
          </div>
        </header>

        {/* Main grid */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mb-6">
          {/* Session overview */}
          <section className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Session resilience
              </h2>
              <button
                type="button"
                onClick={() => openDetailModal("session")}
                className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
              >
                View details
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1.5">
                  Active Runner
                </h3>
                <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                  {renderRunningSessionSummary()}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500 mb-1.5">
                  Last session event
                </h3>
                <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
                  {renderLastEvent()}
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-slate-500">
              Tip: Open a cooking, cleaning, garden, animals, or preservation
              page and use its <span className="font-semibold">Now</span>{" "}
              button. The SessionRunner modal should stay active even as you
              navigate back here.
            </p>
          </section>

          {/* Family Fund / integration badge */}
          <section className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Integration Mode
              </h2>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    Family Fund bridge
                  </p>
                  <p className="text-sm text-slate-700">
                    {isFamilyFundMode
                      ? "Session analytics will be exported when completed."
                      : "SSA is running standalone (no export required)."}
                  </p>
                </div>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                    isFamilyFundMode
                      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                      : "bg-slate-50 text-slate-600 border-slate-200"
                  }`}
                >
                  <span
                    className={`inline-block w-2 h-2 rounded-full mr-1.5 ${
                      isFamilyFundMode ? "bg-emerald-500" : "bg-slate-400"
                    }`}
                  />
                  {isFamilyFundMode ? "FamilyFundMode: ON" : "Standalone mode"}
                </span>
              </div>
              <p className="text-xs text-slate-500">
                This dashboard is read-only. Export behavior is controlled by
                the SessionRunner and Hub connector services.
              </p>
            </div>
          </section>
        </div>

        {/* Secondary grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {/* Device capabilities */}
          <section className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Device capabilities
              </h2>
              <button
                type="button"
                onClick={() => openDetailModal("device")}
                className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
              >
                View details
              </button>
            </div>
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Screen Wake Lock</dt>
                <dd>{renderCapStatusPill(deviceCaps.wakeLock)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Notifications</dt>
                <dd className="flex items-center gap-2">
                  {renderCapStatusPill(deviceCaps.notifications)}
                  {deviceCaps.notifications !== "available" &&
                    deviceCaps.notifications !== "unavailable" && (
                      <button
                        type="button"
                        onClick={handleRequestNotificationPermission}
                        className="text-xs text-indigo-600 hover:text-indigo-800 underline underline-offset-2"
                      >
                        Enable
                      </button>
                    )}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Voice (TTS)</dt>
                <dd>{renderCapStatusPill(deviceCaps.speech)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Media Session</dt>
                <dd>{renderCapStatusPill(deviceCaps.mediaSession)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Mini-window (PiP)</dt>
                <dd>{renderCapStatusPill(deviceCaps.docPictureInPicture)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Service Worker</dt>
                <dd>{renderCapStatusPill(deviceCaps.serviceWorker)}</dd>
              </div>
            </dl>
          </section>

          {/* Guard status */}
          <section className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Guard checks
              </h2>
              <button
                type="button"
                onClick={() => openDetailModal("guards")}
                className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
              >
                View details
              </button>
            </div>
            <dl className="space-y-2.5 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Sabbath guard</dt>
                <dd>{renderCapStatusPill(guardStatus.sabbath)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Quiet hours</dt>
                <dd>{renderCapStatusPill(guardStatus.quietHours)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Weather</dt>
                <dd>{renderCapStatusPill(guardStatus.weather)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Inventory</dt>
                <dd>{renderCapStatusPill(guardStatus.inventory)}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-slate-600">Battery</dt>
                <dd>{renderCapStatusPill(guardStatus.battery)}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-slate-500">
              These values will improve once dedicated guard services emit{" "}
              <span className="font-mono text-[11px]">guard.*</span> events
              (e.g. <span className="font-mono text-[11px]">guard.sabbath</span>
              ).
            </p>
          </section>

          {/* Background services / explanation */}
          <section className="bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2 mb-3">
              <h2 className="text-sm font-semibold text-slate-900">
                Background behavior
              </h2>
              <button
                type="button"
                onClick={() => openDetailModal("background")}
                className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
              >
                View details
              </button>
            </div>
            <ul className="space-y-2.5 text-sm text-slate-700">
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span>
                  Session timers should continue even if this page is closed, as
                  long as the browser tab is still open.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span>
                  Notifications (if enabled) will show step hints and actions
                  (Pause / Next) when the SessionRunner is active.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="mt-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                <span>
                  On supported devices, a mini control HUD can appear via
                  Document Picture-in-Picture so sessions stay visible while you
                  multitask.
                </span>
              </li>
            </ul>
          </section>
        </div>
      </div>

      {/* Deep-dive modal (local to this page, UX-focused) */}
      {detailModalOpen &&
        ReactDOM.createPortal(
          <StabilityDetailModal
            activeTab={detailModalTab}
            onClose={closeDetailModal}
            deviceCaps={deviceCaps}
            guardStatus={guardStatus}
            runningSession={runningSession}
          />,
          document.body
        )}
    </div>
  );
}

/**
 * StabilityDetailModal
 *
 * A focus-trapped, full-screen modal styled similarly to the rest of SSA.
 * This modal is specific to the Stability Dashboard, but follows the same
 * visual language as the SessionRunner overlay:
 *  - Full-viewport, scrim background.
 *  - Keyboard accessible (Esc closes it).
 *  - Tabbed inner layout for device / guards / background docs.
 */
function StabilityDetailModal({
  activeTab,
  onClose,
  deviceCaps,
  guardStatus,
  runningSession,
}) {
  const [tab, setTab] = useState(activeTab || "device");

  useEffect(() => {
    setTab(activeTab || "device");
  }, [activeTab]);

  useEffect(() => {
    const onKeyDown = (evt) => {
      if (evt.key === "Escape") {
        evt.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tabButtonBase =
    "px-3 py-1.5 text-xs font-medium rounded-full border transition-colors";
  const tabButtonActive = "bg-indigo-600 text-white border-indigo-600";
  const tabButtonInactive =
    "bg-white text-slate-600 border-slate-200 hover:bg-slate-50";

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60"
      role="dialog"
      aria-modal="true"
      aria-label="Stability details"
    >
      <div className="relative w-full max-w-4xl mx-4 my-6 bg-white rounded-2xl shadow-xl border border-slate-200">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-slate-100">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">
              Stability details
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 max-w-md">
              Deep-dive into how SSA keeps your sessions stable, including
              device capabilities, guard checks, and background behavior.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Close"
          >
            <span className="sr-only">Close</span>
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        {/* Tabs */}
        <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab("device")}
            className={`${tabButtonBase} ${
              tab === "device" ? tabButtonActive : tabButtonInactive
            }`}
          >
            Device
          </button>
          <button
            type="button"
            onClick={() => setTab("guards")}
            className={`${tabButtonBase} ${
              tab === "guards" ? tabButtonActive : tabButtonInactive
            }`}
          >
            Guards
          </button>
          <button
            type="button"
            onClick={() => setTab("session")}
            className={`${tabButtonBase} ${
              tab === "session" ? tabButtonActive : tabButtonInactive
            }`}
          >
            Session Runner
          </button>
          <button
            type="button"
            onClick={() => setTab("background")}
            className={`${tabButtonBase} ${
              tab === "background" ? tabButtonActive : tabButtonInactive
            }`}
          >
            Background
          </button>
        </div>

        {/* Content */}
        <div className="px-4 py-4 max-h-[70vh] overflow-y-auto text-sm">
          {tab === "device" && <DeviceDetailView deviceCaps={deviceCaps} />}
          {tab === "guards" && <GuardsDetailView guardStatus={guardStatus} />}
          {tab === "session" && (
            <SessionDetailView runningSession={runningSession} />
          )}
          {tab === "background" && <BackgroundDetailView />}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
          <p className="text-[11px] text-slate-500">
            Changes here are informational only. To modify behavior, adjust
            settings in the SessionRunner and guard services.
          </p>
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

function DeviceDetailView({ deviceCaps }) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-900">
        Device capabilities
      </h3>
      <p className="text-sm text-slate-600">
        SSA uses these browser features to keep sessions stable, visible, and
        interactive while you cook, clean, garden, care for animals, or run
        preservation batches.
      </p>
      <ul className="space-y-3 text-sm text-slate-700">
        <li>
          <span className="font-medium">Screen Wake Lock:</span> Prevents your
          device from sleeping while timers are running so you don’t lose your
          place in the session.
        </li>
        <li>
          <span className="font-medium">Notifications:</span> Sends step
          changes, “time to stir,” and other nudges even if you switch tabs.
        </li>
        <li>
          <span className="font-medium">Voice (TTS):</span> Reads steps out loud
          so you can keep your hands free, especially for messy kitchen or barn
          tasks.
        </li>
        <li>
          <span className="font-medium">Media Session:</span> Lets hardware
          buttons (like play/pause or next) control the SessionRunner on
          supported devices.
        </li>
        <li>
          <span className="font-medium">Document Picture-in-Picture:</span>{" "}
          Opens a tiny floating window with controls so you can see the current
          step while using other apps.
        </li>
        <li>
          <span className="font-medium">Service Worker:</span> Keeps
          notifications and some logic humming along, even when the page is in
          the background.
        </li>
      </ul>
      <pre className="mt-3 text-[11px] bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto">
        {JSON.stringify(deviceCaps, null, 2)}
      </pre>
    </div>
  );
}

function GuardsDetailView({ guardStatus }) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-900">Guard checks</h3>
      <p className="text-sm text-slate-600">
        Guards are safety and sanity checks that decide whether a session should
        run right now: Sabbath boundaries, quiet hours, weather constraints,
        inventory readiness, and more.
      </p>
      <ul className="space-y-3 text-sm text-slate-700">
        <li>
          <span className="font-medium">Sabbath guard:</span> Keeps certain
          activities from auto-starting on the Sabbath, depending on your
          configuration.
        </li>
        <li>
          <span className="font-medium">Quiet hours:</span> Reduces noisy alerts
          and defers loud tasks when your household should be resting.
        </li>
        <li>
          <span className="font-medium">Weather:</span> Checks conditions for
          outdoor work like gardening, animal tasks, or line-drying laundry.
        </li>
        <li>
          <span className="font-medium">Inventory:</span> Confirms you have
          enough ingredients or supplies before committing to a session.
        </li>
        <li>
          <span className="font-medium">Battery:</span> Warns when your device
          is too low for long sessions so you can plug in first.
        </li>
      </ul>
      <pre className="mt-3 text-[11px] bg-slate-900 text-slate-100 rounded-lg p-3 overflow-x-auto">
        {JSON.stringify(guardStatus, null, 2)}
      </pre>
    </div>
  );
}

function SessionDetailView({ runningSession }) {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-900">
        Session Runner overview
      </h3>
      <p className="text-sm text-slate-600">
        The SessionRunner is a full-screen modal (mounted at the app root) that
        walks you through every step of a cooking, cleaning, garden, animal, or
        preservation session. It keeps timers, voice prompts, and cues aligned
        even if you navigate across different pages.
      </p>
      <ul className="space-y-3 text-sm text-slate-700">
        <li>
          <span className="font-medium">Keyboard shortcuts:</span> Space to
          pause/resume, N for next step, P for previous step.
        </li>
        <li>
          <span className="font-medium">Checkpoints:</span> The runner writes to
          Dexie after every step change and every 10 seconds while running, so
          it can recover from reloads.
        </li>
        <li>
          <span className="font-medium">Events:</span> It emits{" "}
          <span className="font-mono text-[11px]">session.started</span>,{" "}
          <span className="font-mono text-[11px]">session.step.changed</span>,
          and more to power analytics and Hub exports.
        </li>
      </ul>
      <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50/70 p-3">
        <h4 className="text-xs font-semibold text-slate-800 mb-2">
          Current session snapshot
        </h4>
        {runningSession ? (
          <pre className="text-[11px] bg-slate-900 text-slate-100 rounded-md p-3 overflow-x-auto">
            {JSON.stringify(
              {
                id: runningSession.id,
                domain: runningSession.domain,
                title: runningSession.title,
                status: runningSession.status,
                progress: runningSession.progress,
              },
              null,
              2
            )}
          </pre>
        ) : (
          <p className="text-xs text-slate-500">
            No session is currently running. Use a domain page’s{" "}
            <span className="font-semibold">Now</span> button or the stability
            test button to start one.
          </p>
        )}
      </div>
    </div>
  );
}

function BackgroundDetailView() {
  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-900">
        Background behavior
      </h3>
      <p className="text-sm text-slate-600">
        Once the SessionRunner starts, its job is to stay alive and helpful even
        if you click around different tools in SSA. This is where the stability
        features all come together.
      </p>
      <ul className="space-y-3 text-sm text-slate-700">
        <li>
          <span className="font-medium">Timers &amp; checkpoints:</span> A
          worker or timer loop keeps time and writes to Dexie so that reloading
          the tab or temporarily losing connection doesn&apos;t lose the
          session.
        </li>
        <li>
          <span className="font-medium">Notifications:</span> Step-change,
          pause, and completion notifications keep you updated if you’re on a
          different page or another app.
        </li>
        <li>
          <span className="font-medium">Mini HUD (PiP):</span> When supported, a
          tiny floating control panel can show the current step and controls
          above other windows, especially helpful on desktop while browsing
          recipes or watching videos.
        </li>
        <li>
          <span className="font-medium">Hub export (optional):</span> When a
          session finishes, SSA writes analytics and, if FamilyFundMode is on,
          exports a summary packet to your Hub for household history.
        </li>
      </ul>
      <p className="text-xs text-slate-500">
        Implementation details live in the SessionRunner, wake-lock helper,
        worker scripts, and Hub connector. This panel is your human-readable
        status window.
      </p>
    </div>
  );
}

export default StabilityDashboardView;

// C:\Users\larho\suka-smart-assistant\src\features\session\SessionRunnerModal.jsx

import React, { useMemo, useState } from "react";
import { useSessionRunner } from "./useSessionRunner";
import { DOMAIN_META } from "./sessionSelectors"; // if you created this; otherwise re-create a local map

// If DOMAIN_META is not exported from sessionSelectors, you can inline it here:
// const DOMAIN_META = { ...same as in sessionSelectors.js... };

const DOMAIN_OPTIONS = [
  "cooking",
  "cleaning",
  "garden_planning",
  "garden_care",
  "garden_harvest",
  "storehouse",
  "animals_acquisition",
  "animals_care",
  "animals_butchery",
  "preservation",
];

const DEFAULT_SOURCE = "features/session/SessionRunnerModal";

/**
 * Simple helper to convert textarea -> steps array
 */
function parseStepsFromText(text, domainKey) {
  if (!text) return [];
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label) => ({ label, domain: domainKey }));
}

/**
 * Suggested starter steps per domain for “Quick Session Builder”.
 * This gives users a friendly, opinionated starting point.
 */
function getSuggestedStepsForDomain(domainKey) {
  switch (domainKey) {
    case "cleaning":
      return [
        "Gather cleaning supplies",
        "Clear and declutter surfaces",
        "Dust high to low",
        "Wipe counters and tables",
        "Sweep or vacuum floors",
        "Mop floors (if needed)",
        "Take out trash",
      ];
    case "garden_planning":
      return [
        "Review current crops and beds",
        "Check frost dates and seasonal calendar",
        "Decide planting priorities",
        "Sketch bed layout",
        "Create seed/planting list",
      ];
    case "garden_care":
      return [
        "Walk the garden and inspect plants",
        "Check soil moisture",
        "Water beds or containers as needed",
        "Weed high-priority beds",
        "Prune damaged or diseased leaves",
        "Apply mulch or compost where needed",
      ];
    case "garden_harvest":
      return [
        "Gather baskets and harvest tools",
        "Harvest ripe produce bed by bed",
        "Sort produce (store / cook / preserve)",
        "Log harvest into storehouse inventory",
        "Set aside items for meals and preservation",
      ];
    case "storehouse":
      return [
        "Check current pantry & freezer inventory",
        "Review upcoming meal plan",
        "Identify gaps by grocery section (produce, dairy, etc.)",
        "Draft grocery list by section",
        "Flag priority replenishments for this week",
      ];
    case "cooking":
      return [
        "Review recipes and ingredients",
        "Preheat oven / equipment",
        "Prep ingredients (wash, chop, measure)",
        "Start longest-time item first",
        "Cook remaining items in parallel",
        "Plate or portion meals",
        "Log leftovers into storehouse inventory",
      ];
    case "animals_acquisition":
      return [
        "Confirm source and health records",
        "Prepare housing and quarantine area",
        "Transport animals safely",
        "Intake check (weight, condition, ID tags)",
        "Update herd/animal profiles",
      ];
    case "animals_care":
      return [
        "Observe animals for health changes",
        "Feed according to schedule",
        "Refresh water and check systems",
        "Clean pens / bedding",
        "Log health notes and treatments",
      ];
    case "animals_butchery":
      return [
        "Prepare butchery area and tools",
        "Humanely dispatch animal following your protocol",
        "Bleed and hang carcass",
        "Eviscerate and chill carcass",
        "Break down into primary cuts",
        "Package and label cuts",
        "Log weights into cut sheet & storehouse",
      ];
    case "preservation":
      return [
        "Review produce/meats ready to preserve",
        "Choose methods (canning, freezing, curing, dehydrating)",
        "Prep jars/containers and equipment",
        "Process food according to method",
        "Label and date all items",
        "Log preserved goods into storehouse",
      ];
    default:
      return ["Define your first step", "Add as many steps as you need"];
  }
}

/**
 * Build a human-friendly default title for the quick session builder.
 */
function getDefaultTitleForDomain(domainKey) {
  const meta = DOMAIN_META[domainKey] || DOMAIN_META.generic;
  return meta.label || "Household Session";
}

/**
 * SessionRunnerModal
 *
 * - Shows the active session (if any) with step list, controls, progress.
 * - When no active session, shows a “Quick Session Builder” form.
 * - Supports:
 *   • multi-domain sessions (cleaning, garden, storehouse, meals, animals, preservation)
 *   • reverse planning (target completion)
 *   • saving favorites
 *   • saving recurring schedules
 */
export default function SessionRunnerModal({
  isOpen,
  onClose,
  initialDomain = "cooking",
}) {
  const {
    activeSession,
    isRunning,
    isPaused,
    currentStep,
    stats,
    progress,
    error,
    favorites,
    schedules,
    startSession,
    startReverseGeneratedSession,
    completeCurrentStep,
    pauseSession,
    resumeSession,
    cancelSession,
    markFavorite,
    saveSchedule,
  } = useSessionRunner({ autoResume: true });

  const [builderDomain, setBuilderDomain] = useState(initialDomain);
  const [builderTitle, setBuilderTitle] = useState(
    getDefaultTitleForDomain(initialDomain)
  );
  const [builderStepsText, setBuilderStepsText] = useState(
    getSuggestedStepsForDomain(initialDomain).join("\n")
  );
  const [scheduleMode, setScheduleMode] = useState("now"); // now | scheduled | reverse
  const [scheduleStartsAt, setScheduleStartsAt] = useState("");
  const [scheduleTargetCompletion, setScheduleTargetCompletion] = useState("");
  const [scheduleTitle, setScheduleTitle] = useState("");
  const [scheduleRRule, setScheduleRRule] = useState(""); // e.g. "FREQ=WEEKLY;BYDAY=MO,WE,FR"
  const [builderBusy, setBuilderBusy] = useState(false);
  const [saveFavoriteBusy, setSaveFavoriteBusy] = useState(false);
  const [saveScheduleBusy, setSaveScheduleBusy] = useState(false);

  const domainMeta = useMemo(() => {
    if (!activeSession) return DOMAIN_META[builderDomain] || DOMAIN_META.generic;
    return DOMAIN_META[activeSession.domain] || DOMAIN_META.generic;
  }, [activeSession, builderDomain]);

  const isFavorite =
    activeSession &&
    favorites?.some((fav) => fav.sessionId === activeSession.id);

  if (!isOpen) return null;

  const handleClose = () => {
    onClose && onClose();
  };

  /**
   * Handle change of domain in the builder:
   * update title + suggested steps.
   */
  const handleBuilderDomainChange = (e) => {
    const value = e.target.value;
    setBuilderDomain(value);
    setBuilderTitle(getDefaultTitleForDomain(value));
    setBuilderStepsText(getSuggestedStepsForDomain(value).join("\n"));
  };

  /**
   * Build a raw session object for the runner from builder form.
   */
  const buildRawSessionFromBuilder = () => {
    const steps = parseStepsFromText(builderStepsText, builderDomain);
    return {
      title: builderTitle || getDefaultTitleForDomain(builderDomain),
      domain: builderDomain,
      icon: (DOMAIN_META[builderDomain] || DOMAIN_META.generic).icon,
      source: "user",
      steps,
      meta: {
        grocerySections:
          builderDomain === "storehouse"
            ? DOMAIN_META.storehouse?.grocerySections || []
            : [],
      },
    };
  };

  /**
   * Run session based on builder & scheduleMode
   */
  const handleStartFromBuilder = async () => {
    setBuilderBusy(true);
    try {
      const rawSession = buildRawSessionFromBuilder();

      if (scheduleMode === "reverse" && scheduleTargetCompletion) {
        await startReverseGeneratedSession(rawSession, scheduleTargetCompletion, {
          scheduleOptions: {
            mode: "reverse",
            targetCompletion: scheduleTargetCompletion,
          },
          source: DEFAULT_SOURCE,
        });
      } else if (scheduleMode === "scheduled" && scheduleStartsAt) {
        await startSession(rawSession, {
          scheduleOptions: {
            mode: "scheduled",
            startsAt: scheduleStartsAt,
          },
          source: DEFAULT_SOURCE,
        });
      } else {
        await startSession(rawSession, {
          scheduleOptions: { mode: "now" },
          source: DEFAULT_SOURCE,
        });
      }
    } finally {
      setBuilderBusy(false);
    }
  };

  /**
   * Save current active session as favorite
   */
  const handleSaveFavorite = async () => {
    if (!activeSession) return;
    setSaveFavoriteBusy(true);
    try {
      await markFavorite(activeSession.id, activeSession.title);
    } finally {
      setSaveFavoriteBusy(false);
    }
  };

  /**
   * Save a recurring schedule for the active session
   */
  const handleSaveSchedule = async () => {
    if (!activeSession || !scheduleRRule) return;
    setSaveScheduleBusy(true);
    try {
      await saveSchedule({
        title: scheduleTitle || `${activeSession.title} Schedule`,
        domain: activeSession.domain || "generic",
        sessionTemplateId: activeSession.id,
        recurrenceRule: scheduleRRule,
        startsAt:
          activeSession.schedule?.startsAt ||
          new Date().toISOString(),
        meta: {
          createdFrom: "SessionRunnerModal",
        },
      });
      // Optional: clear fields after save
      // setScheduleTitle("");
      // setScheduleRRule("");
    } finally {
      setSaveScheduleBusy(false);
    }
  };

  const handleNextStep = async () => {
    await completeCurrentStep();
  };

  const handlePauseResume = async () => {
    if (!activeSession) return;
    if (isRunning && !isPaused) {
      await pauseSession();
    } else {
      await resumeSession(activeSession.id);
    }
  };

  const handleCancelSession = async () => {
    if (!activeSession) return;
    await cancelSession("user_cancelled_from_modal");
  };

  const activeScheduleMode = activeSession?.schedule?.mode || null;
  const isReverseSession = activeScheduleMode === "reverse";

  const scheduleInfo = (() => {
    if (!activeSession) return null;
    const { schedule = {} } = activeSession;
    const start = schedule.startsAt
      ? new Date(schedule.startsAt).toLocaleString()
      : null;
    const end = schedule.endsAt
      ? new Date(schedule.endsAt).toLocaleString()
      : null;
    const target = schedule.targetCompletion
      ? new Date(schedule.targetCompletion).toLocaleString()
      : null;

    return { start, end, target, mode: schedule.mode || "now" };
  })();

  return (
    <div className="ssa-session-modal-backdrop">
      <div className="ssa-session-modal">
        {/* Header */}
        <div className="ssa-session-modal-header">
          <div className="ssa-session-modal-title">
            <span className="ssa-session-modal-icon">
              {domainMeta.icon}
            </span>
            <div className="ssa-session-modal-heading-text">
              <h2>
                {activeSession
                  ? activeSession.title || domainMeta.label
                  : "Start a Household Session"}
              </h2>
              <p className="ssa-session-modal-subtitle">
                {activeSession
                  ? domainMeta.label
                  : "Plan and run sessions for cleaning, garden, storehouse, meals, animals, and preservation."}
              </p>
            </div>
          </div>
          <button
            type="button"
            className="ssa-session-modal-close"
            onClick={handleClose}
          >
            ✕
          </button>
        </div>

        {/* Error banner */}
        {error && (
          <div className="ssa-session-modal-error">
            <span>Something went wrong: {String(error)}</span>
          </div>
        )}

        <div className="ssa-session-modal-body">
          {/* LEFT: Active Session View (if any) */}
          <div className="ssa-session-modal-main">
            {activeSession ? (
              <>
                {/* Status & progress */}
                <div className="ssa-session-status-row">
                  <div className="ssa-session-status-pill">
                    {isRunning && !isPaused && "Running"}
                    {isPaused && "Paused"}
                    {!isRunning &&
                      !isPaused &&
                      activeSession.status === "completed" &&
                      "Completed"}
                  </div>
                  {isReverseSession && (
                    <div className="ssa-session-status-pill reverse">
                      Reverse Planned
                    </div>
                  )}
                  {isFavorite && (
                    <div className="ssa-session-status-pill favorite">
                      ★ Favorite
                    </div>
                  )}
                </div>

                <div className="ssa-session-progress-bar-wrapper">
                  <div className="ssa-session-progress-bar">
                    <div
                      className="ssa-session-progress-bar-fill"
                      style={{ width: `${progress || 0}%` }}
                    />
                  </div>
                  <div className="ssa-session-progress-text">
                    {stats.completedSteps}/{stats.totalSteps} steps completed
                  </div>
                </div>

                {/* Schedule info */}
                {scheduleInfo && (
                  <div className="ssa-session-schedule-info">
                    <div>
                      <strong>Mode:</strong> {scheduleInfo.mode}
                    </div>
                    {scheduleInfo.start && (
                      <div>
                        <strong>Starts:</strong> {scheduleInfo.start}
                      </div>
                    )}
                    {scheduleInfo.target && (
                      <div>
                        <strong>Target Completion:</strong>{" "}
                        {scheduleInfo.target}
                      </div>
                    )}
                    {scheduleInfo.end && (
                      <div>
                        <strong>Ends:</strong> {scheduleInfo.end}
                      </div>
                    )}
                  </div>
                )}

                {/* Steps list */}
                <div className="ssa-session-steps">
                  <h3>Steps</h3>
                  <ul>
                    {activeSession.steps?.map((step, idx) => {
                      const isCurrent =
                        currentStep && currentStep.id === step.id;
                      return (
                        <li
                          key={step.id || idx}
                          className={[
                            "ssa-session-step",
                            `status-${step.status}`,
                            isCurrent ? "current" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          <div className="ssa-session-step-main">
                            <span className="ssa-session-step-label">
                              {step.label || `Step ${idx + 1}`}
                            </span>
                            {step.description && (
                              <span className="ssa-session-step-description">
                                {step.description}
                              </span>
                            )}
                          </div>
                          <div className="ssa-session-step-status">
                            {step.status}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* Controls */}
                <div className="ssa-session-controls">
                  <button
                    type="button"
                    className="ssa-button primary"
                    onClick={handleNextStep}
                    disabled={!isRunning && !isPaused}
                  >
                    {stats.completedSteps + 1 > stats.totalSteps
                      ? "Finish"
                      : "Next Step"}
                  </button>
                  <button
                    type="button"
                    className="ssa-button"
                    onClick={handlePauseResume}
                    disabled={!activeSession}
                  >
                    {isRunning && !isPaused ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    className="ssa-button ghost"
                    onClick={handleCancelSession}
                    disabled={!activeSession}
                  >
                    Cancel Session
                  </button>
                </div>

                {/* Favorites & schedule actions */}
                <div className="ssa-session-secondary-actions">
                  <button
                    type="button"
                    className="ssa-button"
                    onClick={handleSaveFavorite}
                    disabled={!activeSession || saveFavoriteBusy}
                  >
                    {isFavorite ? "Update Favorite" : "Save as Favorite"}
                  </button>

                  <div className="ssa-session-schedule-editor">
                    <div className="ssa-session-schedule-fields">
                      <input
                        type="text"
                        value={scheduleTitle}
                        onChange={(e) => setScheduleTitle(e.target.value)}
                        placeholder="Schedule title (optional)"
                        className="ssa-input"
                      />
                      <input
                        type="text"
                        value={scheduleRRule}
                        onChange={(e) => setScheduleRRule(e.target.value)}
                        placeholder="RRULE e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR"
                        className="ssa-input"
                      />
                    </div>
                    <button
                      type="button"
                      className="ssa-button"
                      onClick={handleSaveSchedule}
                      disabled={!scheduleRRule || saveScheduleBusy}
                    >
                      Save Recurring Schedule
                    </button>
                  </div>
                </div>
              </>
            ) : (
              // No active session: show quick builder
              <div className="ssa-session-builder">
                <h3>Quick Session Builder</h3>
                <div className="ssa-form-row">
                  <label>Domain</label>
                  <select
                    value={builderDomain}
                    onChange={handleBuilderDomainChange}
                    className="ssa-select"
                  >
                    {DOMAIN_OPTIONS.map((key) => {
                      const meta = DOMAIN_META[key] || DOMAIN_META.generic;
                      return (
                        <option key={key} value={key}>
                          {meta.icon} {meta.label}
                        </option>
                      );
                    })}
                  </select>
                </div>

                <div className="ssa-form-row">
                  <label>Session Title</label>
                  <input
                    type="text"
                    className="ssa-input"
                    value={builderTitle}
                    onChange={(e) => setBuilderTitle(e.target.value)}
                    placeholder={getDefaultTitleForDomain(builderDomain)}
                  />
                </div>

                <div className="ssa-form-row">
                  <label>Steps (one per line)</label>
                  <textarea
                    className="ssa-textarea"
                    rows={8}
                    value={builderStepsText}
                    onChange={(e) => setBuilderStepsText(e.target.value)}
                  />
                  <div className="ssa-helper-text">
                    Use short, action-oriented steps like well-designed cooking,
                    cleaning, or garden apps. You can always adjust during the
                    session.
                  </div>
                </div>

                <div className="ssa-form-row ssa-schedule-mode-row">
                  <label>Schedule Mode</label>
                  <div className="ssa-radio-group">
                    <label>
                      <input
                        type="radio"
                        value="now"
                        checked={scheduleMode === "now"}
                        onChange={() => setScheduleMode("now")}
                      />
                      Start now
                    </label>
                    <label>
                      <input
                        type="radio"
                        value="scheduled"
                        checked={scheduleMode === "scheduled"}
                        onChange={() => setScheduleMode("scheduled")}
                      />
                      Start at…
                    </label>
                    <label>
                      <input
                        type="radio"
                        value="reverse"
                        checked={scheduleMode === "reverse"}
                        onChange={() => setScheduleMode("reverse")}
                      />
                      Finish by… (reverse)
                    </label>
                  </div>
                </div>

                {scheduleMode === "scheduled" && (
                  <div className="ssa-form-row">
                    <label>Start at</label>
                    <input
                      type="datetime-local"
                      className="ssa-input"
                      value={scheduleStartsAt}
                      onChange={(e) => setScheduleStartsAt(e.target.value)}
                    />
                  </div>
                )}

                {scheduleMode === "reverse" && (
                  <div className="ssa-form-row">
                    <label>Target completion time</label>
                    <input
                      type="datetime-local"
                      className="ssa-input"
                      value={scheduleTargetCompletion}
                      onChange={(e) =>
                        setScheduleTargetCompletion(e.target.value)
                      }
                    />
                    <div className="ssa-helper-text">
                      SSA will work backwards from this time to schedule your
                      steps, similar to how well-designed cooking & productivity
                      tools plan backwards from “serve time”.
                    </div>
                  </div>
                )}

                <div className="ssa-session-builder-actions">
                  <button
                    type="button"
                    className="ssa-button primary"
                    onClick={handleStartFromBuilder}
                    disabled={builderBusy}
                  >
                    {scheduleMode === "reverse"
                      ? "Reverse Plan & Start"
                      : "Start Session"}
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* RIGHT: Simple info rail (optional) */}
          <div className="ssa-session-modal-sidebar">
            <h4>Tips & Context</h4>
            <ul className="ssa-session-tips-list">
              <li>
                <strong>Cleaning:</strong> Build repeatable resets for rooms so
                you can turn them into favorite sessions and recurring
                schedules.
              </li>
              <li>
                <strong>Garden:</strong> Use separate planning, care, and
                harvest sessions so SSA can chain actions into meals and
                preservation.
              </li>
              <li>
                <strong>Storehouse & Groceries:</strong> Build sessions that
                think in grocery sections (produce, dairy, pantry) for smart
                lists and inventory updates.
              </li>
              <li>
                <strong>Animals:</strong> Capture acquisition, daily care, and
                butchery as distinct sessions so your records and storehouse
                data stay in sync.
              </li>
              <li>
                <strong>Preservation:</strong> Reverse-plan these sessions from
                your desired “all jars processed by…” time.
              </li>
            </ul>

            {/* Optional small glance at total favorites / schedules */}
            <div className="ssa-session-sidebar-stats">
              <div>
                <strong>Favorites:</strong> {favorites?.length || 0}
              </div>
              <div>
                <strong>Schedules:</strong> {schedules?.length || 0}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="ssa-session-modal-footer">
          <button
            type="button"
            className="ssa-button ghost"
            onClick={handleClose}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

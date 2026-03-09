// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\FeastDayAlignmentCalculator\FeastDayAlignmentCalculator.view.jsx

/**
 * Feast Day Alignment Calculator View
 *
 * How this fits:
 * - UI wrapper around FeastDayAlignmentCalculator.shim.js.
 * - Lets the user:
 *    • choose Gregorian year and toggles,
 *    • compute feast dates from HebrewMonthStartCalendar output,
 *    • see a feast calendar with prep windows and domain hints,
 *    • emit “suggested prep sessions” that the SessionRunner can pick up.
 *
 * Integration notes:
 * - Expect `baseMonthStartData` from HebrewMonthStartCalendar.shim/view.
 * - Mount this inside the Calendar tools area, OR in a dedicated route.
 * - To keep prep sessions running across navigation, the *SessionRunner*
 *   itself must be mounted at the App root via a portal. This view only
 *   emits events and suggested session payloads.
 */

import React, { useCallback, useMemo, useState } from "react";
import { runFeastDayAlignmentCalculator } from "./FeastDayAlignmentCalculator.shim";
import { emit } from "@/services/events/eventBus";

/**
 * @typedef {import("./FeastDayAlignmentCalculator.schema.json").input} FeastAlignmentInput
 * @typedef {import("./FeastDayAlignmentCalculator.schema.json").output} FeastAlignmentOutput
 */

/**
 * @param {{
 *   baseMonthStartData?: FeastAlignmentInput["baseMonthStartData"];
 *   defaultGregorianYear?: number;
 *   defaultHebrewYear?: number;
 *   defaultMonthStartMethod?: FeastAlignmentInput["monthStartMethod"];
 * }} props
 */
function FeastDayAlignmentCalculatorView(props) {
  const {
    baseMonthStartData,
    defaultGregorianYear,
    defaultHebrewYear,
    defaultMonthStartMethod,
  } = props;

  const [gregorianYear, setGregorianYear] = useState(
    defaultGregorianYear || new Date().getFullYear()
  );
  const [hebrewYear, setHebrewYear] = useState(defaultHebrewYear || "");
  const [monthStartMethod, setMonthStartMethod] = useState(
    defaultMonthStartMethod || "fullMoon"
  );
  const [includeMinorFeasts, setIncludeMinorFeasts] = useState(false);

  const [result, setResult] = useState(
    /** @type {FeastAlignmentOutput | null} */ (null)
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedFeastCode, setSelectedFeastCode] = useState(null);

  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const hasMonthStartData =
    Array.isArray(baseMonthStartData) && baseMonthStartData.length > 0;

  const selectedFeast = useMemo(() => {
    if (!result || !selectedFeastCode) return null;
    return result.feasts.find((f) => f.code === selectedFeastCode) || null;
  }, [result, selectedFeastCode]);

  const handleCompute = useCallback(async () => {
    if (!hasMonthStartData) return;

    setLoading(true);
    setError("");
    setResult(null);

    try {
      /** @type {FeastAlignmentInput} */
      const input = {
        gregorianYear: Number(gregorianYear),
        hebrewYear: hebrewYear ? Number(hebrewYear) : undefined,
        monthStartMethod,
        baseMonthStartData: baseMonthStartData || [],
        includeMinorFeasts,
        timezone,
      };

      const output = await runFeastDayAlignmentCalculator(input);
      setResult(output);
      if (output.feasts.length > 0) {
        setSelectedFeastCode(output.feasts[0].code);
      } else {
        setSelectedFeastCode(null);
      }
    } catch (err) {
      console.error("FeastDayAlignmentCalculator error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "Something went wrong while computing feast dates."
      );
    } finally {
      setLoading(false);
    }
  }, [
    baseMonthStartData,
    gregorianYear,
    hebrewYear,
    hasMonthStartData,
    includeMinorFeasts,
    monthStartMethod,
    timezone,
  ]);

  /**
   * Emit a suggested session for a single feast.
   * SessionRunner / sessions service will pick this up and persist + run.
   */
  const handlePlanPrepSession = useCallback((feast) => {
    if (!feast || !feast.gregorianStartDate) return;

    const ts = new Date().toISOString();
    const sessionId = `feast-prep-${feast.code}-${feast.gregorianStartDate}`;

    const domain = "storehouse"; // central “prep” domain; steps will touch cooking/cleaning/etc.

    const steps = [
      {
        id: `${sessionId}-inventory`,
        title: `Check storehouse for ${feast.label}`,
        desc: `Review grains, oil, wine/juice, meat, and staple items needed for ${feast.label}. Note any shortages.`,
        durationSec: 20 * 60,
        blockers: ["inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Focus on pantry and freezer checks.",
        },
      },
      {
        id: `${sessionId}-menu`,
        title: `Plan feast menu & tasks`,
        desc: `Draft menu, assign cooking and cleaning tasks, and map out what can be prepared in advance for ${feast.label}.`,
        durationSec: 30 * 60,
        blockers: [],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Use SSA meal planning tools if available.",
        },
      },
      {
        id: `${sessionId}-cleanup`,
        title: "Set house in order",
        desc: `Schedule and begin pre-feast cleaning tasks so the home is ready before ${feast.label} begins.`,
        durationSec: 30 * 60,
        blockers: ["quietHours", "sabbath"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Respect quiet hours and sabbath guardrails.",
        },
      },
    ];

    const sessionPayload = {
      id: sessionId,
      domain,
      title: `${feast.label} Prep Session`,
      source: {
        type: "import",
        refId: feast.code,
      },
      steps,
      prefs: {
        voiceGuidance: true,
        haptic: true,
        autoAdvance: false,
      },
      status: "pending",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null,
      },
      analytics: {
        skippedSteps: [],
        adjustments: [],
      },
      createdAt: ts,
      updatedAt: ts,
    };

    emit({
      type: "session.suggested",
      ts,
      source: "features/calculators/calendar/FeastDayAlignmentCalculator.view",
      data: {
        session: sessionPayload,
        feastCode: feast.code,
        feastLabel: feast.label,
        feastStart: feast.gregorianStartDate,
      },
    });
  }, []);

  const handlePlanAllPrepSessions = useCallback(() => {
    if (!result || !Array.isArray(result.feasts)) return;
    result.feasts
      .filter((f) => f.requiresPrepSession && f.gregorianStartDate)
      .forEach((f) => handlePlanPrepSession(f));
  }, [handlePlanPrepSession, result]);

  return (
    <div className="ssa-panel ssa-calendar-panel">
      <header className="ssa-panel-header">
        <div>
          <h2 className="ssa-panel-title">Feast Day Alignment</h2>
          <p className="ssa-panel-subtitle">
            Align your chosen Hebrew month-start method with scripture-based
            feast dates, then spin up preparation sessions across your
            storehouse, kitchen, and home.
          </p>
        </div>
        <div className="ssa-panel-actions">
          <button
            type="button"
            className="ssa-btn ssa-btn-primary"
            onClick={handleCompute}
            disabled={!hasMonthStartData || loading}
          >
            {loading ? "Computing…" : "Compute Feast Dates"}
          </button>
        </div>
      </header>

      {!hasMonthStartData && (
        <div className="ssa-alert ssa-alert-warning">
          <h3>Month start data required</h3>
          <p>
            This calculator depends on{" "}
            <strong>Hebrew Month Start Calendar</strong> output. Run that
            calculator first, then open this tool so it can receive{" "}
            <code>baseMonthStartData</code>.
          </p>
        </div>
      )}

      {error && (
        <div className="ssa-alert ssa-alert-error">
          <p>{error}</p>
        </div>
      )}

      <section className="ssa-grid ssa-grid-cols-1 md:ssa-grid-cols-3 ssa-gap-4 ssa-mt-4">
        {/* LEFT: Controls */}
        <div className="ssa-card ssa-col-span-1">
          <div className="ssa-card-header">
            <h3 className="ssa-card-title">Alignment Settings</h3>
            <p className="ssa-card-subtitle">
              Choose the year and method you&apos;re using for month starts.
            </p>
          </div>
          <div className="ssa-card-body ssa-space-y-4">
            <div>
              <label className="ssa-label">
                Gregorian Year
                <input
                  type="number"
                  className="ssa-input"
                  value={gregorianYear}
                  onChange={(e) =>
                    setGregorianYear(e.target.valueAsNumber || gregorianYear)
                  }
                  min={1900}
                  max={2600}
                />
              </label>
            </div>
            <div>
              <label className="ssa-label">
                Hebrew Year (optional override)
                <input
                  type="number"
                  className="ssa-input"
                  value={hebrewYear}
                  onChange={(e) => setHebrewYear(e.target.value)}
                  placeholder="Auto-derive from month starts"
                  min={5000}
                  max={8000}
                />
              </label>
            </div>
            <div>
              <label className="ssa-label">
                Month Start Method
                <select
                  className="ssa-select"
                  value={monthStartMethod}
                  onChange={(e) =>
                    setMonthStartMethod(
                      /** @type {FeastAlignmentInput["monthStartMethod"]} */ (
                        e.target.value
                      )
                    )
                  }
                >
                  <option value="fullMoon">
                    Full Moon (your system default)
                  </option>
                  <option value="firstVisibleCrescent">
                    First Visible Crescent
                  </option>
                  <option value="newMoonDark">Conjunction (Dark Moon)</option>
                  <option value="noMeridianCross">
                    Moon does not cross meridian at night
                  </option>
                </select>
              </label>
              <p className="ssa-help-text">
                These options should match your Hebrew Month Start calculator
                rules.
              </p>
            </div>
            <div className="ssa-flex ssa-items-center ssa-gap-2">
              <input
                id="includeMinorFeasts"
                type="checkbox"
                className="ssa-checkbox"
                checked={includeMinorFeasts}
                onChange={(e) => setIncludeMinorFeasts(e.target.checked)}
              />
              <label htmlFor="includeMinorFeasts" className="ssa-label-inline">
                Include minor feasts (Purim, Hanukkah)
              </label>
            </div>
            <div>
              <p className="ssa-text-xs ssa-text-muted">
                Timezone: <strong>{timezone}</strong>
              </p>
            </div>
            <div className="ssa-divider" />
            <button
              type="button"
              className="ssa-btn ssa-btn-outline w-full"
              onClick={handlePlanAllPrepSessions}
              disabled={
                !result || !result.feasts.some((f) => f.requiresPrepSession)
              }
            >
              Plan Prep Sessions for All Major Feasts
            </button>
          </div>
        </div>

        {/* MIDDLE: Feast list */}
        <div className="ssa-card ssa-col-span-1 md:ssa-col-span-1">
          <div className="ssa-card-header">
            <h3 className="ssa-card-title">Feast Calendar</h3>
            <p className="ssa-card-subtitle">
              Scroll to see all aligned feasts and choose one for detailed prep.
            </p>
          </div>
          <div className="ssa-card-body ssa-space-y-2 ssa-max-h-[28rem] ssa-overflow-y-auto">
            {!result && (
              <p className="ssa-text-sm ssa-text-muted">
                Once you compute feast dates, they will appear here as a
                scrollable list.
              </p>
            )}
            {result &&
              result.feasts.map((feast) => (
                <button
                  key={feast.code}
                  type="button"
                  onClick={() => setSelectedFeastCode(feast.code)}
                  className={
                    "ssa-feast-list-item ssa-w-full ssa-text-left" +
                    (selectedFeastCode === feast.code
                      ? " ssa-feast-list-item--active"
                      : "")
                  }
                >
                  <div className="ssa-flex ssa-justify-between ssa-items-center">
                    <div>
                      <div className="ssa-text-sm ssa-font-semibold">
                        {feast.label}
                      </div>
                      <div className="ssa-text-xs ssa-text-muted">
                        {feast.gregorianStartDate
                          ? feast.gregorianEndDate &&
                            feast.gregorianEndDate !== feast.gregorianStartDate
                            ? `${feast.gregorianStartDate} → ${feast.gregorianEndDate}`
                            : feast.gregorianStartDate
                          : "Date unavailable"}
                      </div>
                    </div>
                    <div className="ssa-text-right">
                      <span className="ssa-badge ssa-badge-pill">
                        {feast.category || "appointedTime"}
                      </span>
                      {feast.requiresPrepSession && (
                        <span className="ssa-badge ssa-badge-outline ssa-ml-1">
                          Prep session
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))}
          </div>
        </div>

        {/* RIGHT: Detail & prep modal-like panel */}
        <div className="ssa-card ssa-col-span-1">
          <div className="ssa-card-header">
            <h3 className="ssa-card-title">
              {selectedFeast ? selectedFeast.label : "Feast Detail & Prep"}
            </h3>
            <p className="ssa-card-subtitle">
              View Hebrew and Gregorian alignment, plus recommended prep
              domains.
            </p>
          </div>
          <div className="ssa-card-body ssa-space-y-3">
            {!selectedFeast && (
              <p className="ssa-text-sm ssa-text-muted">
                Select a feast from the middle list to see details and create a
                prep session.
              </p>
            )}

            {selectedFeast && (
              <>
                <div className="ssa-grid ssa-grid-cols-2 ssa-gap-2">
                  <div>
                    <div className="ssa-label-inline">Gregorian:</div>
                    <div className="ssa-text-sm">
                      {selectedFeast.gregorianStartDate ? (
                        selectedFeast.gregorianEndDate &&
                        selectedFeast.gregorianEndDate !==
                          selectedFeast.gregorianStartDate ? (
                          <>
                            {selectedFeast.gregorianStartDate} →{" "}
                            {selectedFeast.gregorianEndDate}
                          </>
                        ) : (
                          selectedFeast.gregorianStartDate
                        )
                      ) : (
                        <span className="ssa-text-muted">Unavailable</span>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="ssa-label-inline">Hebrew:</div>
                    <div className="ssa-text-sm">
                      Month {selectedFeast.hebrewMonthIndex}, day{" "}
                      {selectedFeast.hebrewDay} (span{" "}
                      {selectedFeast.hebrewSpanDays} day
                      {selectedFeast.hebrewSpanDays > 1 ? "s" : ""})
                    </div>
                  </div>
                  <div>
                    <div className="ssa-label-inline">Category:</div>
                    <div className="ssa-text-sm">{selectedFeast.category}</div>
                  </div>
                  <div>
                    <div className="ssa-label-inline">Prep Domains:</div>
                    <div className="ssa-flex ssa-flex-wrap ssa-gap-1 ssa-mt-1">
                      {selectedFeast.prepSessionHints?.length ? (
                        selectedFeast.prepSessionHints.map((hint) => (
                          <span
                            key={hint}
                            className="ssa-badge ssa-badge-soft ssa-text-xs"
                          >
                            {hint}
                          </span>
                        ))
                      ) : (
                        <span className="ssa-text-xs ssa-text-muted">
                          None specifically recommended
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {selectedFeast.notes && (
                  <div className="ssa-feast-notes-box">
                    <div className="ssa-text-xs ssa-font-semibold ssa-mb-1">
                      Alignment Notes
                    </div>
                    <p className="ssa-text-xs ssa-leading-snug">
                      {selectedFeast.notes}
                    </p>
                  </div>
                )}

                <div className="ssa-divider" />

                <div className="ssa-flex ssa-flex-col ssa-gap-2">
                  <button
                    type="button"
                    className="ssa-btn ssa-btn-primary"
                    disabled={!selectedFeast.requiresPrepSession}
                    onClick={() => handlePlanPrepSession(selectedFeast)}
                  >
                    {selectedFeast.requiresPrepSession
                      ? "Create Prep Session for This Feast"
                      : "Prep Session Optional for This Feast"}
                  </button>
                  <p className="ssa-text-xs ssa-text-muted">
                    When you create a prep session, the SessionRunner will
                    handle timers, voice cues, and notifications. This panel is
                    your planning “HUD” for feast alignment; the full-screen
                    SessionRunner modal sits at the app root so it can keep
                    running even as you navigate elsewhere.
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export default FeastDayAlignmentCalculatorView;

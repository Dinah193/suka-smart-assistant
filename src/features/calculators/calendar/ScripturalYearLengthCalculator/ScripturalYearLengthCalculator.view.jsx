// C:\Users\larho\suka-smart-assistant\src\features\calculators\calendar\ScripturalYearLengthCalculator\ScripturalYearLengthCalculator.view.jsx

/**
 * ScripturalYearLengthCalculator.view.jsx
 *
 * How this fits:
 * - UI wrapper around ScripturalYearLengthCalculator.shim.js.
 * - Lets the user:
 *   - choose cycle type (solar / lunar / luni-solar),
 *   - set a reference date (start of the scriptural year),
 *   - choose a month-start rule + leap-year handling,
 *   - see a structured year layout with months and day counts.
 *
 * - Outputs can feed:
 *   - HebrewMonthStartCalendar → month-by-month rendering,
 *   - FeastDayAlignmentCalculator → feast alignment + prep windows,
 *   - garden / storehouse planners for seasonal planning,
 *   - session generators for cooking/cleaning/preservation flows.
 *
 * - This is a *view only* calculator; it doesn’t run a SessionRunner itself
 *   but can emit events that other parts of SSA use to spawn sessions.
 */

import React, { useState, useEffect, useMemo } from "react";
import { emit as emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runScripturalYearLengthCalculator } from "./ScripturalYearLengthCalculator.shim";

// Small helpers --------------------------------------------------------------

/**
 * @returns {string} YYYY-MM-DD for today
 */
function todayIso() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Parse an ISO date (YYYY-MM-DD) into { year, month, day }
 */
function splitIso(iso) {
  if (!iso || typeof iso !== "string") return null;
  const parts = iso.split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts.map((p) => parseInt(p, 10));
  if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null;
  return { year: y, month: m, day: d };
}

// Main component -------------------------------------------------------------

const ScripturalYearLengthCalculatorView = () => {
  const initialToday = useMemo(() => todayIso(), []);
  const initialParts = splitIso(initialToday) || {
    year: new Date().getFullYear(),
    month: 1,
    day: 1,
  };

  const [cycleType, setCycleType] = useState("luniSolar");
  const [referenceIso, setReferenceIso] = useState(initialToday);
  const [monthStartMethod, setMonthStartMethod] = useState("fullMoon");
  const [avivRuleEnabled, setAvivRuleEnabled] = useState(true);
  const [intercalationRule, setIntercalationRule] = useState("auto");
  const [baseMonthStartDate, setBaseMonthStartDate] = useState("");

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [showDetailModal, setShowDetailModal] = useState(false);

  // Basic “location” stub; you can wire this to user profile / browser later.
  const location = useMemo(
    () => ({
      lat: 32.0,
      lon: -86.5,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    }),
    []
  );

  useEffect(() => {
    // Emit simple “viewed” telemetry once.
    emitEvent({
      type: "calculator.viewed",
      ts: new Date().toISOString(),
      source: "calendar.ScripturalYearLengthCalculator.view",
      data: {
        cycleType,
        referenceIso,
        monthStartMethod,
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCompute = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    setLoading(true);
    setError(null);

    const ref = splitIso(referenceIso) || {
      year: initialParts.year,
      month: initialParts.month,
      day: initialParts.day,
    };

    const request = {
      id: `scripturalYear-${Date.now()}`,
      source: "calendar.ScripturalYearLengthCalculator.view",
      input: {
        cycleType,
        referenceYear: ref.year,
        referenceMonth: ref.month,
        referenceDay: ref.day,
        monthStartMethod,
        avivRuleEnabled,
        intercalationRule,
        baseMonthStartDate: baseMonthStartDate || undefined,
        location,
      },
      context: {
        locale: navigator.language || "en-US",
      },
    };

    emitEvent({
      type: "planningGraph.calculator.requested",
      ts: new Date().toISOString(),
      source: "calendar.ScripturalYearLengthCalculator.view",
      data: {
        moduleId: "calendar.ScripturalYearLengthCalculator",
        request,
      },
    });

    try {
      const response = await runScripturalYearLengthCalculator(request);

      if (!response || !response.ok || !response.output) {
        const msg =
          (response && response.error) || "Unknown error calculating year.";
        setError(msg);
        setResult(null);

        emitEvent({
          type: "planningGraph.calculator.failed",
          ts: new Date().toISOString(),
          source: "calendar.ScripturalYearLengthCalculator.view",
          data: {
            moduleId: "calendar.ScripturalYearLengthCalculator",
            error: msg,
          },
        });
      } else {
        setResult(response.output);

        emitEvent({
          type: "planningGraph.calculator.succeeded",
          ts: new Date().toISOString(),
          source: "calendar.ScripturalYearLengthCalculator.view",
          data: {
            moduleId: "calendar.ScripturalYearLengthCalculator",
            output: response.output,
          },
        });
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      setError(msg);
      setResult(null);

      emitEvent({
        type: "planningGraph.calculator.error",
        ts: new Date().toISOString(),
        source: "calendar.ScripturalYearLengthCalculator.view",
        data: {
          moduleId: "calendar.ScripturalYearLengthCalculator",
          message: msg,
        },
      });
    } finally {
      setLoading(false);
    }
  };

  const handlePlanSeasonsNow = () => {
    if (!result) return;

    // Hint to the planner / session system that we want season-planning next.
    emitEvent({
      type: "planningGraph.nextSteps.requested",
      ts: new Date().toISOString(),
      source: "calendar.ScripturalYearLengthCalculator.view",
      data: {
        fromNode: "scripturalYearLength",
        yearLabel: result.yearLabel,
        anchorDates: result.anchorDates,
        months: result.months,
        familyFundMode,
      },
    });

    // Downstream logic can open a SessionRunner with gardening, storehouse,
    // cooking / cleaning prep sessions based on this structure.
  };

  const daysInYear = result ? result.daysInYear : null;

  return (
    <div className="ssa-card ssa-card--calculator ssa-card--calendar">
      <div className="ssa-card__header">
        <div>
          <h2 className="ssa-card__title">Scriptural Year Length</h2>
          <p className="ssa-card__subtitle">
            Define how your scriptural year is structured so the rest of SSA can
            align feasts, planting, and storehouse seasons.
          </p>
        </div>
        <button
          type="button"
          className="ssa-btn ssa-btn--ghost ssa-btn--sm"
          onClick={() => setShowDetailModal(true)}
          disabled={!result}
        >
          View Year Detail
        </button>
      </div>

      {/* Form */}
      <form
        className="ssa-form ssa-grid ssa-grid--2col"
        onSubmit={handleCompute}
      >
        <div className="ssa-form__field">
          <label className="ssa-form__label" htmlFor="cycleType">
            Cycle Type
          </label>
          <select
            id="cycleType"
            className="ssa-form__select"
            value={cycleType}
            onChange={(e) => setCycleType(e.target.value)}
          >
            <option value="solar">Solar (365-ish days)</option>
            <option value="lunar">Lunar (12 lunar months)</option>
            <option value="luniSolar">Luni-Solar (leap years possible)</option>
          </select>
          <p className="ssa-form__hint">
            Choose the underlying rhythm you&apos;re using for your year.
          </p>
        </div>

        <div className="ssa-form__field">
          <label className="ssa-form__label" htmlFor="referenceIso">
            Reference Date
          </label>
          <input
            id="referenceIso"
            type="date"
            className="ssa-form__input"
            value={referenceIso}
            onChange={(e) => setReferenceIso(e.target.value)}
          />
          <p className="ssa-form__hint">
            Typically the start of your first month of the year.
          </p>
        </div>

        <div className="ssa-form__field">
          <label className="ssa-form__label" htmlFor="monthStartMethod">
            Month Start Rule
          </label>
          <select
            id="monthStartMethod"
            className="ssa-form__select"
            value={monthStartMethod}
            onChange={(e) => setMonthStartMethod(e.target.value)}
          >
            <option value="fullMoon">Full Moon (User default)</option>
            <option value="firstVisibleCrescent">First Visible Crescent</option>
            <option value="conjunction">Conjunction (astronomical new)</option>
            <option value="moonDoesNotCrossMeridian">
              Moon Does Not Cross Meridian
            </option>
          </select>
          <p className="ssa-form__hint">
            This ties into the Hebrew Month Start calculator.
          </p>
        </div>

        <div className="ssa-form__field">
          <label className="ssa-form__label">Leap-Year Rule</label>
          <div className="ssa-form__radio-group">
            <label className="ssa-form__radio">
              <input
                type="radio"
                name="intercalationRule"
                value="auto"
                checked={intercalationRule === "auto"}
                onChange={(e) => setIntercalationRule(e.target.value)}
              />
              <span>Auto pattern</span>
            </label>
            <label className="ssa-form__radio">
              <input
                type="radio"
                name="intercalationRule"
                value="noLeap"
                checked={intercalationRule === "noLeap"}
                onChange={(e) => setIntercalationRule(e.target.value)}
              />
              <span>No leap years</span>
            </label>
            <label className="ssa-form__radio">
              <input
                type="radio"
                name="intercalationRule"
                value="forceLeap"
                checked={intercalationRule === "forceLeap"}
                onChange={(e) => setIntercalationRule(e.target.value)}
              />
              <span>Force leap year</span>
            </label>
          </div>
          <p className="ssa-form__hint">
            Simple placeholder rules. You can later swap in exact aviv /
            intercalation logic.
          </p>
        </div>

        <div className="ssa-form__field">
          <label className="ssa-form__label" htmlFor="baseMonthStartDate">
            Override Base Month Start (optional)
          </label>
          <input
            id="baseMonthStartDate"
            type="date"
            className="ssa-form__input"
            value={baseMonthStartDate}
            onChange={(e) => setBaseMonthStartDate(e.target.value)}
          />
          <p className="ssa-form__hint">
            If set, this overrides the reference date as Month 1 / Day 1.
          </p>
        </div>

        <div className="ssa-form__field ssa-form__field--inline">
          <label className="ssa-form__checkbox">
            <input
              type="checkbox"
              checked={avivRuleEnabled}
              onChange={(e) => setAvivRuleEnabled(e.target.checked)}
            />
            <span>Enable Aviv-based leap logic (conceptual)</span>
          </label>
          <p className="ssa-form__hint">
            Kept simple in this shim; just a flag that future logic can use.
          </p>
        </div>

        <div className="ssa-form__actions ssa-grid__span-2">
          <button
            type="submit"
            className="ssa-btn ssa-btn--primary"
            disabled={loading}
          >
            {loading ? "Computing…" : "Compute Scriptural Year"}
          </button>

          <button
            type="button"
            className="ssa-btn ssa-btn--outline"
            disabled={!result}
            onClick={handlePlanSeasonsNow}
          >
            Plan Seasons Now
          </button>
        </div>
      </form>

      {/* Result summary */}
      <div className="ssa-result ssa-result--compact">
        {error && (
          <div className="ssa-alert ssa-alert--error">
            <p>{error}</p>
          </div>
        )}

        {!error && !result && !loading && (
          <div className="ssa-empty">
            <p>
              Configure your cycle and reference date, then run the calculator
              to see your scriptural year layout.
            </p>
          </div>
        )}

        {!error && result && (
          <div className="ssa-result__content">
            <div className="ssa-result__summary">
              <h3 className="ssa-result__title">{result.yearLabel}</h3>
              <div className="ssa-result__stats">
                <div className="ssa-stat">
                  <span className="ssa-stat__label">Days in Year</span>
                  <span className="ssa-stat__value">
                    {daysInYear != null ? daysInYear : "—"}
                  </span>
                </div>
                <div className="ssa-stat">
                  <span className="ssa-stat__label">Leap Year</span>
                  <span className="ssa-stat__value">
                    {result.isLeapYear ? "Yes" : "No"}
                  </span>
                </div>
                <div className="ssa-stat">
                  <span className="ssa-stat__label">Months</span>
                  <span className="ssa-stat__value">
                    {Array.isArray(result.months) ? result.months.length : "—"}
                  </span>
                </div>
              </div>
              <div className="ssa-result__anchors">
                <div>
                  <span className="ssa-tag ssa-tag--soft">Year Start</span>
                  <span className="ssa-result__anchor">
                    {result.anchorDates?.yearStart || "—"}
                  </span>
                </div>
                <div>
                  <span className="ssa-tag ssa-tag--soft">Mid-Year</span>
                  <span className="ssa-result__anchor">
                    {result.anchorDates?.midYearMarker || "—"}
                  </span>
                </div>
                <div>
                  <span className="ssa-tag ssa-tag--soft">Year End</span>
                  <span className="ssa-result__anchor">
                    {result.anchorDates?.yearEnd || "—"}
                  </span>
                </div>
              </div>
            </div>

            {/* Month table (compact) */}
            <div className="ssa-result__table-wrapper">
              <table className="ssa-table ssa-table--compact">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Month</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Days</th>
                  </tr>
                </thead>
                <tbody>
                  {result.months.map((m) => (
                    <tr key={m.index}>
                      <td>{m.index}</td>
                      <td>
                        {m.name}
                        {m.isIntercalary && (
                          <span className="ssa-tag ssa-tag--tiny ssa-tag--accent">
                            Leap
                          </span>
                        )}
                      </td>
                      <td>{m.startDate}</td>
                      <td>{m.endDate}</td>
                      <td>{m.days}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Detail modal */}
      {showDetailModal && result && (
        <div className="ssa-modal ssa-modal--backdrop">
          <div className="ssa-modal__dialog ssa-modal__dialog--lg">
            <div className="ssa-modal__header">
              <h3 className="ssa-modal__title">
                Scriptural Year Structure – Detail
              </h3>
              <button
                type="button"
                className="ssa-modal__close"
                onClick={() => setShowDetailModal(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="ssa-modal__body">
              <p className="ssa-modal__lead">
                Use this overview to line up feasts, planting seasons, and
                preservation sessions. Other calculators can consume this layout
                through the Planning Graph.
              </p>

              <div className="ssa-grid ssa-grid--2col">
                <div>
                  <h4 className="ssa-section-title">Year Summary</h4>
                  <ul className="ssa-list">
                    <li>
                      <strong>Label:</strong> {result.yearLabel}
                    </li>
                    <li>
                      <strong>Days:</strong> {result.daysInYear}
                    </li>
                    <li>
                      <strong>Leap Year:</strong>{" "}
                      {result.isLeapYear ? "Yes" : "No"}
                    </li>
                    <li>
                      <strong>Start:</strong>{" "}
                      {result.anchorDates?.yearStart || "—"}
                    </li>
                    <li>
                      <strong>Mid-Year:</strong>{" "}
                      {result.anchorDates?.midYearMarker || "—"}
                    </li>
                    <li>
                      <strong>End:</strong> {result.anchorDates?.yearEnd || "—"}
                    </li>
                  </ul>
                </div>
                <div>
                  <h4 className="ssa-section-title">How SSA Uses This</h4>
                  <ul className="ssa-list ssa-list--bulleted">
                    <li>
                      <strong>Feast alignment:</strong> feeds the Feast Day
                      Alignment calculator.
                    </li>
                    <li>
                      <strong>Garden seasons:</strong> anchors sowing/harvest
                      windows by scriptural month.
                    </li>
                    <li>
                      <strong>Storehouse &amp; preservation:</strong> staggers
                      sessions around yearly cycles.
                    </li>
                    <li>
                      <strong>Household rhythm:</strong> supports cleaning and
                      prep cycles tied to high days.
                    </li>
                  </ul>
                </div>
              </div>

              <h4 className="ssa-section-title">Month-by-Month View</h4>
              <div className="ssa-result__table-wrapper ssa-result__table-wrapper--scroll">
                <table className="ssa-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Month</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Days</th>
                      <th>Intercalary</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.months.map((m) => (
                      <tr key={`detail-${m.index}`}>
                        <td>{m.index}</td>
                        <td>{m.name}</td>
                        <td>{m.startDate}</td>
                        <td>{m.endDate}</td>
                        <td>{m.days}</td>
                        <td>{m.isIntercalary ? "Yes" : "No"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="ssa-modal__footer">
              <button
                type="button"
                className="ssa-btn ssa-btn--primary"
                onClick={() => {
                  handlePlanSeasonsNow();
                  setShowDetailModal(false);
                }}
              >
                Send to Season Planner
              </button>
              <button
                type="button"
                className="ssa-btn ssa-btn--ghost"
                onClick={() => setShowDetailModal(false)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ScripturalYearLengthCalculatorView;

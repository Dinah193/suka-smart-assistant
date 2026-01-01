// C:\Users\larho\suka-smart-assistant\src\features\calculators\stability\HouseholdStabilityCalculator\HouseholdStabilityCalculator.view.jsx

import React, { useState, useMemo } from "react";
import * as stabilityShim from "./HouseholdStabilityCalculator.shim";

/**
 * HouseholdStabilityCalculatorView
 *
 * How this fits:
 * - UI front-end for the Household Stability Calculator node.
 * - Collects household metrics (storehouse, meals, routines, finance, etc.),
 *   calls the Stability shim, and visualizes:
 *     - overall stability index + band,
 *     - domain subscores,
 *     - alerts and “next best action” recommendations.
 * - Recommendations are surfaced as “Now” buttons that a parent can bind to
 *   SessionRunner by passing `onPlayNow`.
 *
 * Integration points:
 * - Parent route can:
 *   - pass `initialInput` to pre-fill metrics for a selected period,
 *   - handle `onResult(output)` to update PlanningGraph / Dexie,
 *   - handle `onPlayNow(recommendation, output)` to open SessionRunner with
 *     a session template.
 */

const SHIM_RUN =
  typeof stabilityShim.run === "function"
    ? stabilityShim.run
    : stabilityShim.default && typeof stabilityShim.default.run === "function"
    ? stabilityShim.default.run
    : null;

// Small helpers -------------------------------------------------------------

const todayISO = () => new Date().toISOString().slice(0, 10);

function getDefaultPeriod() {
  const now = new Date();
  const year = now.getFullYear();
  return {
    yearLabel: `Household Year ${year}`,
    startDate: `${year}-01-01`,
    endDate: `${year}-12-31`,
  };
}

function normalizeInitialInput(initialInput) {
  const period = initialInput?.period || getDefaultPeriod();
  const metrics = initialInput?.metrics || {};
  const flags = initialInput?.flags || {};

  return {
    period: {
      yearLabel: period.yearLabel || getDefaultPeriod().yearLabel,
      startDate: period.startDate || getDefaultPeriod().startDate,
      endDate: period.endDate || getDefaultPeriod().endDate,
    },
    metrics: {
      storehouseMonthsCovered: metrics.storehouseMonthsCovered ?? 0,
      mealReadinessScore: metrics.mealReadinessScore ?? 50,
      cleaningCoverageScore: metrics.cleaningCoverageScore ?? 50,
      gardenSupportScore: metrics.gardenSupportScore ?? 50,
      preservationCapacityScore: metrics.preservationCapacityScore ?? 50,
      financialMarginScore: metrics.financialMarginScore ?? 50,
      routineConsistencyScore: metrics.routineConsistencyScore ?? 50,
      healthBaselineScore: metrics.healthBaselineScore ?? 50,
      relationshipSupportScore: metrics.relationshipSupportScore ?? 50,
      crisisLoadScore: metrics.crisisLoadScore ?? 50,
      sabbathProtectionScore: metrics.sabbathProtectionScore ?? 50,
    },
    flags: {
      sabbathGuardRespected: !!flags.sabbathGuardRespected,
      quietHoursRespected: !!flags.quietHoursRespected,
      feastCalendarAligned: !!flags.feastCalendarAligned,
    },
    notes: initialInput?.notes || "",
  };
}

/**
 * Main View Component
 *
 * @param {{
 *  initialInput?: any;
 *  onResult?: (output: any) => void;
 *  onPlayNow?: (recommendation: any, output: any) => void;
 *  className?: string;
 * }} props
 */
export default function HouseholdStabilityCalculatorView({
  initialInput,
  onResult,
  onPlayNow,
  className = "",
}) {
  const [form, setForm] = useState(() => normalizeInitialInput(initialInput));
  const [result, setResult] = useState(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [error, setError] = useState(null);
  const [showDetails, setShowDetails] = useState(false);

  const nodeKey = "household-stability";

  const bandBadgeClass = useMemo(() => {
    if (!result) return "ssa-badge ssa-badge-muted";
    switch (result.band) {
      case "thriving":
        return "ssa-badge ssa-badge-success";
      case "stable":
        return "ssa-badge ssa-badge-good";
      case "developing":
        return "ssa-badge ssa-badge-warn";
      case "fragile":
        return "ssa-badge ssa-badge-attention";
      case "critical":
      default:
        return "ssa-badge ssa-badge-danger";
    }
  }, [result]);

  const handlePeriodChange = (field, value) => {
    setForm((prev) => ({
      ...prev,
      period: {
        ...prev.period,
        [field]: value,
      },
    }));
  };

  const handleMetricChange = (field, value) => {
    setForm((prev) => ({
      ...prev,
      metrics: {
        ...prev.metrics,
        [field]: value === "" ? "" : Number(value),
      },
    }));
  };

  const handleFlagToggle = (field) => {
    setForm((prev) => ({
      ...prev,
      flags: {
        ...prev.flags,
        [field]: !prev.flags[field],
      },
    }));
  };

  const handleNotesChange = (value) => {
    setForm((prev) => ({
      ...prev,
      notes: value,
    }));
  };

  const handleCalculate = async () => {
    if (!SHIM_RUN) {
      setError(
        "Household Stability shim is not available. Ensure HouseholdStabilityCalculator.shim.js exports a `run` function."
      );
      return;
    }

    setIsCalculating(true);
    setError(null);

    try {
      const inputPayload = {
        period: {
          yearLabel: form.period.yearLabel,
          startDate: form.period.startDate || todayISO(),
          endDate: form.period.endDate || todayISO(),
        },
        metrics: {
          ...form.metrics,
        },
        flags: {
          ...form.flags,
        },
        notes: form.notes || undefined,
      };

      const response = await SHIM_RUN({
        nodeKey,
        payload: { input: inputPayload },
        context: {},
      });

      const output = response?.output || null;
      setResult(output);

      if (typeof onResult === "function" && output) {
        onResult(output);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("HouseholdStabilityCalculatorView: calculation error", err);
      setError(err?.message || "An unexpected error occurred while calculating stability.");
    } finally {
      setIsCalculating(false);
    }
  };

  const handlePlayNow = (recommendation) => {
    if (!result) return;

    if (typeof onPlayNow === "function") {
      onPlayNow(recommendation, result);
      return;
    }

    // Fallback: log the intent; SessionRunner wiring can be added by parent.
    // eslint-disable-next-line no-console
    console.log("[SSA] Play Now (stability recommendation)", {
      recommendation,
      result,
    });
  };

  const subScores = result?.subScores || {};

  return (
    <div className={`ssa-calculator-view ssa-card ${className}`}>
      {/* Header / Summary */}
      <header className="ssa-card-header">
        <div className="ssa-card-header-main">
          <h2 className="ssa-card-title">Household Stability Index</h2>
          <p className="ssa-card-subtitle">
            Blend storehouse, meals, routines, finances, health, and relationships into a single
            stability picture—then turn weak spots into “Now” sessions.
          </p>
        </div>

        <div className="ssa-card-header-metrics">
          <div className="ssa-kpi">
            <div className="ssa-kpi-label">Stability Index</div>
            <div className="ssa-kpi-value">
              {result ? result.stabilityIndex : "–"}
              {result && <span className="ssa-kpi-unit">/100</span>}
            </div>
          </div>
          <div className="ssa-kpi">
            <div className="ssa-kpi-label">Band</div>
            <div className={bandBadgeClass}>{result ? result.band.toUpperCase() : "N/A"}</div>
          </div>
        </div>
      </header>

      {/* Body: Form + Results */}
      <div className="ssa-card-body ssa-grid ssa-grid-cols-1 md:ssa-grid-cols-2 ssa-gap-6">
        {/* Left: Inputs */}
        <section className="ssa-panel">
          <h3 className="ssa-section-title">1. Period & Metrics</h3>

          <div className="ssa-field-group">
            <label className="ssa-label" htmlFor="period-yearLabel">
              Period label
            </label>
            <input
              id="period-yearLabel"
              type="text"
              className="ssa-input"
              value={form.period.yearLabel}
              onChange={(e) => handlePeriodChange("yearLabel", e.target.value)}
              placeholder="e.g., Household Year 2025"
            />
          </div>

          <div className="ssa-grid ssa-grid-cols-2 ssa-gap-3">
            <div className="ssa-field-group">
              <label className="ssa-label" htmlFor="period-startDate">
                Start date
              </label>
              <input
                id="period-startDate"
                type="date"
                className="ssa-input"
                value={form.period.startDate}
                onChange={(e) => handlePeriodChange("startDate", e.target.value)}
              />
            </div>
            <div className="ssa-field-group">
              <label className="ssa-label" htmlFor="period-endDate">
                End date
              </label>
              <input
                id="period-endDate"
                type="date"
                className="ssa-input"
                value={form.period.endDate}
                onChange={(e) => handlePeriodChange("endDate", e.target.value)}
              />
            </div>
          </div>

          <div className="ssa-divider" />

          <h4 className="ssa-section-subtitle">Core metrics</h4>

          <div className="ssa-grid ssa-grid-cols-2 ssa-gap-3">
            <MetricField
              id="storehouseMonthsCovered"
              label="Storehouse coverage (months)"
              hint="Approximate months of core staples (grains, beans, oils, etc.)."
              value={form.metrics.storehouseMonthsCovered}
              min={0}
              max={24}
              step={0.1}
              onChange={handleMetricChange}
            />
            <MetricField
              id="mealReadinessScore"
              label="Meal readiness (0–100)"
              hint="How easily can you produce simple, nourishing meals?"
              value={form.metrics.mealReadinessScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="cleaningCoverageScore"
              label="Cleaning coverage (0–100)"
              hint="Are key zones and routines under control?"
              value={form.metrics.cleaningCoverageScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="routineConsistencyScore"
              label="Routine consistency (0–100)"
              hint="How consistent are daily/weekly rhythms?"
              value={form.metrics.routineConsistencyScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="gardenSupportScore"
              label="Garden support (0–100)"
              hint="How much does your garden support meals/pantry?"
              value={form.metrics.gardenSupportScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="preservationCapacityScore"
              label="Preservation capacity (0–100)"
              hint="Tools & skills for canning, dehydrating, freezing, etc."
              value={form.metrics.preservationCapacityScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="financialMarginScore"
              label="Financial margin (0–100)"
              hint="Buffer in budget for unexpected needs."
              value={form.metrics.financialMarginScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="healthBaselineScore"
              label="Health baseline (0–100)"
              hint="Overall household health & energy."
              value={form.metrics.healthBaselineScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="relationshipSupportScore"
              label="Relationship support (0–100)"
              hint="Supportive relationships / community nearby."
              value={form.metrics.relationshipSupportScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="crisisLoadScore"
              label="Crisis/chaos load (0–100)"
              hint="Higher = more chaos/crisis currently."
              value={form.metrics.crisisLoadScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
            <MetricField
              id="sabbathProtectionScore"
              label="Sabbath protection (0–100)"
              hint="How well do you protect weekly rest windows?"
              value={form.metrics.sabbathProtectionScore}
              min={0}
              max={100}
              onChange={handleMetricChange}
            />
          </div>

          <div className="ssa-divider" />

          <h4 className="ssa-section-subtitle">Flags</h4>

          <div className="ssa-flag-list">
            <FlagToggle
              id="flag-sabbathGuardRespected"
              label="Sabbath guard respected"
              description="Sabbath sessions are protected and honored in planning."
              checked={form.flags.sabbathGuardRespected}
              onToggle={() => handleFlagToggle("sabbathGuardRespected")}
            />
            <FlagToggle
              id="flag-quietHoursRespected"
              label="Quiet hours respected"
              description="Early/late hours are lightly loaded or reserved for rest."
              checked={form.flags.quietHoursRespected}
              onToggle={() => handleFlagToggle("quietHoursRespected")}
            />
            <FlagToggle
              id="flag-feastCalendarAligned"
              label="Feast calendar aligned"
              description="Household plan is aligned with your scriptural calendar."
              checked={form.flags.feastCalendarAligned}
              onToggle={() => handleFlagToggle("feastCalendarAligned")}
            />
          </div>

          <div className="ssa-field-group">
            <label className="ssa-label" htmlFor="stability-notes">
              Notes (optional)
            </label>
            <textarea
              id="stability-notes"
              className="ssa-textarea"
              rows={3}
              value={form.notes}
              placeholder="Capture any context (e.g., recent moves, illness, job changes)."
              onChange={(e) => handleNotesChange(e.target.value)}
            />
          </div>

          {error && <div className="ssa-alert ssa-alert-error">{error}</div>}

          <div className="ssa-actions-row">
            <button
              type="button"
              className="ssa-btn ssa-btn-primary"
              onClick={handleCalculate}
              disabled={isCalculating}
            >
              {isCalculating ? "Calculating…" : "Calculate Stability"}
            </button>

            {result && (
              <button
                type="button"
                className="ssa-btn ssa-btn-ghost"
                onClick={() => setShowDetails((prev) => !prev)}
              >
                {showDetails ? "Hide details" : "View details"}
              </button>
            )}
          </div>
        </section>

        {/* Right: Results */}
        <section className="ssa-panel">
          <h3 className="ssa-section-title">2. Stability Snapshot</h3>

          {!result && (
            <div className="ssa-empty-state">
              <p className="ssa-empty-title">No stability score yet.</p>
              <p className="ssa-empty-body">
                Fill in your household metrics and click <strong>Calculate Stability</strong> to see
                your index, domain strengths, and “Now” suggestions.
              </p>
            </div>
          )}

          {result && (
            <>
              <div className="ssa-result-summary">
                <p className="ssa-result-text">{result.statusSummary}</p>
                <p className="ssa-result-meta">
                  Generated: <span>{new Date(result.generatedAt || Date.now()).toLocaleString()}</span>
                </p>
              </div>

              <div className="ssa-grid ssa-grid-cols-2 ssa-gap-3 ssa-mt-3">
                <SubScoreBadge label="Food & Storehouse" value={subScores.food} />
                <SubScoreBadge label="Calendar & Rhythm" value={subScores.calendar} />
                <SubScoreBadge label="Routines & Cleaning" value={subScores.routine} />
                <SubScoreBadge label="Health & Capacity" value={subScores.health} />
                <SubScoreBadge label="Finance & Buffer" value={subScores.finance} />
                <SubScoreBadge label="Relationships & Support" value={subScores.relationships} />
              </div>

              {/* Alerts */}
              <div className="ssa-section-block ssa-mt-4">
                <h4 className="ssa-section-subtitle">Alerts</h4>
                {(!result.alerts || result.alerts.length === 0) && (
                  <p className="ssa-muted">No major alerts detected for this period.</p>
                )}

                {result.alerts && result.alerts.length > 0 && (
                  <ul className="ssa-alert-list">
                    {result.alerts.map((alert) => (
                      <li
                        key={alert.code}
                        className={`ssa-alert-chip ssa-alert-chip-${alert.level || "info"}`}
                      >
                        <span className="ssa-alert-chip-label">{alert.code}</span>
                        <span className="ssa-alert-chip-message">{alert.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Recommendations / Next Best Actions */}
              <div className="ssa-section-block ssa-mt-4">
                <h4 className="ssa-section-subtitle">Next Best Actions</h4>
                {(!result.recommendations || result.recommendations.length === 0) && (
                  <p className="ssa-muted">
                    No specific recommendations yet. Adjust metrics or notes to see what SSA suggests.
                  </p>
                )}

                {result.recommendations && result.recommendations.length > 0 && (
                  <ul className="ssa-recommendation-list">
                    {result.recommendations.map((rec) => (
                      <li key={rec.id} className="ssa-recommendation-item">
                        <div className="ssa-recommendation-main">
                          <div className="ssa-recommendation-label-row">
                            <span className="ssa-recommendation-label">{rec.label}</span>
                            <span className={`ssa-pill ssa-pill-domain-${rec.domain}`}>
                              {rec.domain}
                            </span>
                          </div>
                          {rec.priority && (
                            <span className={`ssa-pill ssa-pill-priority-${rec.priority}`}>
                              {rec.priority.toUpperCase()}
                            </span>
                          )}
                        </div>
                        <div className="ssa-recommendation-actions">
                          <button
                            type="button"
                            className="ssa-btn ssa-btn-now"
                            onClick={() => handlePlayNow(rec)}
                          >
                            Now
                          </button>
                          {rec.sessionTemplateKey && (
                            <span className="ssa-recommendation-template">
                              Template: <code>{rec.sessionTemplateKey}</code>
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Optional detail panel (text-based “modal” within the card) */}
              {showDetails && (
                <div className="ssa-details-panel ssa-mt-4">
                  <h4 className="ssa-section-subtitle">How to read this score</h4>
                  <ul className="ssa-details-list">
                    <li>
                      <strong>Food & Storehouse</strong> weighs your months of staples, meal
                      readiness, garden support, and preservation tools.
                    </li>
                    <li>
                      <strong>Calendar & Rhythm</strong> blends feast alignment, Sabbath protection,
                      routine consistency, and how heavy your crisis load is.
                    </li>
                    <li>
                      <strong>Routines & Cleaning</strong> measures whether daily/weekly patterns and
                      key zones are under control.
                    </li>
                    <li>
                      <strong>Finance & Buffer</strong> looks at your financial margin and how your
                      storehouse supports that buffer.
                    </li>
                    <li>
                      <strong>Health & Relationships</strong> reflect your capacity to keep going and
                      the support around you.
                    </li>
                  </ul>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Small presentational components                                           */
/* -------------------------------------------------------------------------- */

function MetricField({ id, label, hint, value, min, max, step = 1, onChange }) {
  return (
    <div className="ssa-field-group">
      <label className="ssa-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        className="ssa-input"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(id, e.target.value)}
      />
      {hint && <p className="ssa-hint">{hint}</p>}
    </div>
  );
}

function FlagToggle({ id, label, description, checked, onToggle }) {
  return (
    <label htmlFor={id} className="ssa-flag-toggle">
      <input
        id={id}
        type="checkbox"
        className="ssa-flag-toggle-input"
        checked={checked}
        onChange={onToggle}
      />
      <span className="ssa-flag-toggle-body">
        <span className="ssa-flag-toggle-label">{label}</span>
        {description && <span className="ssa-flag-toggle-description">{description}</span>}
      </span>
    </label>
  );
}

function SubScoreBadge({ label, value }) {
  const val = typeof value === "number" && !Number.isNaN(value) ? value : null;
  let cls = "ssa-subscore-badge";

  if (val !== null) {
    if (val >= 80) cls += " ssa-subscore-high";
    else if (val >= 60) cls += " ssa-subscore-mid";
    else if (val >= 40) cls += " ssa-subscore-low";
    else cls += " ssa-subscore-critical";
  }

  return (
    <div className={cls}>
      <div className="ssa-subscore-label">{label}</div>
      <div className="ssa-subscore-value">{val !== null ? `${Math.round(val)}/100` : "–"}</div>
    </div>
  );
}

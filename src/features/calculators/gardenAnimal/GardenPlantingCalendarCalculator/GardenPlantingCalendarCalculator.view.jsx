// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\GardenPlantingCalendarCalculator\GardenPlantingCalendarCalculator.view.jsx

import React, { useState, useMemo } from "react";
import { runGardenPlantingCalendarCalculatorShim } from "./GardenPlantingCalendarCalculator.shim";
import eventBus from "@/services/eventBus";

/**
 * GardenPlantingCalendarCalculatorView
 *
 * UI for viewing and adjusting planting calendar data, then
 * generating planting/harvest events that can be turned into
 * runnable "garden" sessions via the SessionRunner pipeline.
 *
 * Props:
 * - initialPayload?: { context, inputs, outputs }
 * - onPayloadChange?: (payload) => void
 * - onResult?: (result) => void
 */
export default function GardenPlantingCalendarCalculatorView({
  initialPayload,
  onPayloadChange,
  onResult
}) {
  const [payload, setPayload] = useState(() =>
    initialPayload && typeof initialPayload === "object"
      ? initialPayload
      : getDefaultPayload()
  );
  const [result, setResult] = useState(() =>
    initialPayload && initialPayload.outputs ? initialPayload : null
  );
  const [isComputing, setIsComputing] = useState(false);
  const [error, setError] = useState("");

  const inputs = payload.inputs || {};
  const climate = inputs.climate || {};
  const calendar = inputs.calendar || {};
  const crops = Array.isArray(inputs.crops) ? inputs.crops : [];

  const outputs = (result && result.outputs) || {
    plantingWindows: [],
    harvestWindows: [],
    calendarEvents: [],
    summary: {
      totalCropsPlanned: 0,
      totalPlantingEvents: 0,
      totalHarvestWindows: 0,
      notes: ""
    }
  };

  const sortedPlantingWindows = useMemo(
    () =>
      [...outputs.plantingWindows].sort((a, b) =>
        (a.startDate || "").localeCompare(b.startDate || "")
      ),
    [outputs.plantingWindows]
  );

  const sortedHarvestWindows = useMemo(
    () =>
      [...outputs.harvestWindows].sort((a, b) =>
        (a.startDate || "").localeCompare(b.startDate || "")
      ),
    [outputs.harvestWindows]
  );

  const upcomingEvents = useMemo(
    () =>
      [...outputs.calendarEvents].sort((a, b) =>
        (a.date || "").localeCompare(b.date || "")
      ),
    [outputs.calendarEvents]
  );

  async function handleRecalculate() {
    setIsComputing(true);
    setError("");
    try {
      const next = await runGardenPlantingCalendarCalculatorShim(payload, {
        eventBus,
        featureFlags: { familyFundMode: false } // view-level default; real flagging happens upstream
      });
      setResult(next);
      if (onResult) onResult(next);
      if (onPayloadChange) onPayloadChange(next);
      setPayload(next);
    } catch (err) {
      console.error("GardenPlantingCalendarCalculatorView error:", err);
      setError("Unable to recompute planting calendar. Please check inputs.");
    } finally {
      setIsComputing(false);
    }
  }

  function updateInputs(partial) {
    const next = {
      ...payload,
      inputs: {
        ...payload.inputs,
        ...partial
      }
    };
    setPayload(next);
    if (onPayloadChange) onPayloadChange(next);
  }

  function handleClimateChange(field, value) {
    const nextClimate = { ...climate, [field]: value };
    updateInputs({ climate: nextClimate });
  }

  function handleCalendarChange(field, value) {
    const nextCalendar = { ...calendar, [field]: value };
    updateInputs({ calendar: nextCalendar });
  }

  function handleCropChange(index, field, value) {
    const nextCrops = [...crops];
    const current = nextCrops[index] || {};
    nextCrops[index] = {
      ...current,
      [field]:
        field === "daysToMaturity" ||
        field === "successionIntervalDays" ||
        field === "maxSuccessions"
          ? toInt(value, "")
          : value
    };
    updateInputs({ crops: nextCrops });
  }

  function handleAddCrop() {
    const nextCrops = [
      ...crops,
      {
        cropId: `crop-${Date.now()}`,
        name: "",
        daysToMaturity: "",
        frostSensitivity: "tender",
        successionEnabled: false,
        successionIntervalDays: 7,
        maxSuccessions: 1,
        targetUse: "fresh"
      }
    ];
    updateInputs({ crops: nextCrops });
  }

  function handleRemoveCrop(index) {
    const nextCrops = crops.filter((_, i) => i !== index);
    updateInputs({ crops: nextCrops });
  }

  /**
   * Launch a garden session for the selected planting or harvest window.
   * Emits a "session.requested" event that SessionRunner can consume.
   */
  function handleLaunchSession(windowItem, type) {
    if (!windowItem) return;
    const ts = new Date().toISOString();

    const session = buildGardenSessionFromWindow(windowItem, type);

    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit({
          type: "session.requested",
          ts,
          source: "calculators/garden/GardenPlantingCalendarCalculator.view",
          data: { session }
        });
      }
    } catch (err) {
      console.warn(
        "[GardenPlantingCalendarCalculator.view] emit failed:",
        err
      );
    }
  }

  const summary = outputs.summary || {};

  return (
    <div className="ssa-calculator-card">
      <header className="ssa-calculator-header">
        <div>
          <h2 className="ssa-calculator-title">Garden Planting Calendar</h2>
          <p className="ssa-calculator-subtitle">
            Connect climate, Hebrew calendar, and crops to generate planting
            and harvest windows that link directly into your SSA garden sessions.
          </p>
        </div>
        <div className="ssa-calculator-actions">
          <button
            type="button"
            className="ssa-button-secondary"
            onClick={handleRecalculate}
            disabled={isComputing}
          >
            {isComputing ? "Calculating…" : "Recalculate Calendar"}
          </button>
          {/* High-level "Now" CTA: resolve to nearest upcoming planting event */}
          <button
            type="button"
            className="ssa-button-primary"
            onClick={() => {
              const next = findNextEvent(upcomingEvents, "planting");
              if (next) handleLaunchSession(next, "planting");
            }}
            disabled={upcomingEvents.length === 0}
          >
            Planting Now
          </button>
        </div>
      </header>

      {error && <div className="ssa-alert-error">{error}</div>}

      {/* Top inputs grid */}
      <section className="ssa-calculator-grid">
        {/* Climate & Calendar */}
        <div className="ssa-panel">
          <h3 className="ssa-panel-title">Climate & Calendar</h3>
          <div className="ssa-field-group">
            <label className="ssa-field">
              <span className="ssa-field-label">Last Frost Date</span>
              <input
                type="date"
                className="ssa-input"
                value={climate.lastFrostDate || ""}
                onChange={(e) =>
                  handleClimateChange("lastFrostDate", e.target.value)
                }
              />
            </label>
            <label className="ssa-field">
              <span className="ssa-field-label">First Frost Date</span>
              <input
                type="date"
                className="ssa-input"
                value={climate.firstFrostDate || ""}
                onChange={(e) =>
                  handleClimateChange("firstFrostDate", e.target.value)
                }
              />
            </label>
          </div>

          <div className="ssa-field-group">
            <label className="ssa-field">
              <span className="ssa-field-label">Year</span>
              <input
                type="number"
                className="ssa-input"
                value={calendar.year || ""}
                onChange={(e) =>
                  handleCalendarChange("year", toInt(e.target.value, ""))
                }
              />
            </label>
          </div>

          <div className="ssa-field-group">
            <label className="ssa-checkbox">
              <input
                type="checkbox"
                checked={!!calendar.alignWithFeastDays}
                onChange={(e) =>
                  handleCalendarChange("alignWithFeastDays", e.target.checked)
                }
              />
              <span>Highlight harvest windows that align with feast days</span>
            </label>
          </div>

          <p className="ssa-helper-text">
            Hebrew calendar calculations and feast-day mappings are handled
            upstream. This view simply consumes those mapped Gregorian dates
            and shows where your harvest overlaps them.
          </p>
        </div>

        {/* Crops configuration */}
        <div className="ssa-panel">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Crops & Succession Plan</h3>
            <button
              type="button"
              className="ssa-button-ghost"
              onClick={handleAddCrop}
            >
              + Add Crop
            </button>
          </div>

          {crops.length === 0 ? (
            <p className="ssa-empty-state">
              No crops defined yet. Add at least one crop to generate a planting
              calendar.
            </p>
          ) : (
            <div className="ssa-table-wrapper ssa-table-wrapper--compact">
              <table className="ssa-table">
                <thead>
                  <tr>
                    <th>Crop</th>
                    <th>Days to Maturity</th>
                    <th>Frost Sensitivity</th>
                    <th>Succession</th>
                    <th>Target Use</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {crops.map((crop, idx) => (
                    <tr key={crop.cropId || idx}>
                      <td>
                        <input
                          type="text"
                          className="ssa-input ssa-input-sm"
                          value={crop.name || ""}
                          onChange={(e) =>
                            handleCropChange(idx, "name", e.target.value)
                          }
                          placeholder="e.g., Roma tomato"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          className="ssa-input ssa-input-sm"
                          value={crop.daysToMaturity ?? ""}
                          onChange={(e) =>
                            handleCropChange(
                              idx,
                              "daysToMaturity",
                              e.target.value
                            )
                          }
                          min={0}
                        />
                      </td>
                      <td>
                        <select
                          className="ssa-input ssa-input-sm"
                          value={crop.frostSensitivity || "tender"}
                          onChange={(e) =>
                            handleCropChange(
                              idx,
                              "frostSensitivity",
                              e.target.value
                            )
                          }
                        >
                          <option value="frost-hardy">Frost-hardy</option>
                          <option value="frost-tolerant">Frost-tolerant</option>
                          <option value="tender">Tender</option>
                          <option value="very-tender">Very tender</option>
                        </select>
                      </td>
                      <td>
                        <div className="ssa-flex-col-gap-xs">
                          <label className="ssa-checkbox">
                            <input
                              type="checkbox"
                              checked={!!crop.successionEnabled}
                              onChange={(e) =>
                                handleCropChange(
                                  idx,
                                  "successionEnabled",
                                  e.target.checked
                                )
                              }
                            />
                            <span>Enable</span>
                          </label>
                          <div className="ssa-field-inline">
                            <span className="ssa-field-label-sm">
                              Interval (days)
                            </span>
                            <input
                              type="number"
                              className="ssa-input ssa-input-xs"
                              value={crop.successionIntervalDays ?? ""}
                              onChange={(e) =>
                                handleCropChange(
                                  idx,
                                  "successionIntervalDays",
                                  e.target.value
                                )
                              }
                              min={0}
                            />
                          </div>
                          <div className="ssa-field-inline">
                            <span className="ssa-field-label-sm">Max runs</span>
                            <input
                              type="number"
                              className="ssa-input ssa-input-xs"
                              value={crop.maxSuccessions ?? ""}
                              onChange={(e) =>
                                handleCropChange(
                                  idx,
                                  "maxSuccessions",
                                  e.target.value
                                )
                              }
                              min={1}
                            />
                          </div>
                        </div>
                      </td>
                      <td>
                        <select
                          className="ssa-input ssa-input-sm"
                          value={crop.targetUse || "fresh"}
                          onChange={(e) =>
                            handleCropChange(idx, "targetUse", e.target.value)
                          }
                        >
                          <option value="fresh">Fresh</option>
                          <option value="preservation">Preservation</option>
                          <option value="mixed">Mixed</option>
                          <option value="seed">Seed saving</option>
                        </select>
                      </td>
                      <td className="ssa-cell-actions">
                        <button
                          type="button"
                          className="ssa-icon-button"
                          onClick={() => handleRemoveCrop(idx)}
                          aria-label="Remove crop"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Summary strip */}
      <section className="ssa-summary-strip">
        <div className="ssa-summary-item">
          <span className="ssa-summary-label">Crops Planned</span>
          <span className="ssa-summary-value">
            {summary.totalCropsPlanned ?? crops.length}
          </span>
        </div>
        <div className="ssa-summary-item">
          <span className="ssa-summary-label">Planting Windows</span>
          <span className="ssa-summary-value">
            {summary.totalPlantingEvents ?? sortedPlantingWindows.length}
          </span>
        </div>
        <div className="ssa-summary-item">
          <span className="ssa-summary-label">Harvest Windows</span>
          <span className="ssa-summary-value">
            {summary.totalHarvestWindows ?? sortedHarvestWindows.length}
          </span>
        </div>
        {summary.notes && (
          <div className="ssa-summary-notes">
            <span className="ssa-summary-label">Notes</span>
            <p className="ssa-summary-text">{summary.notes}</p>
          </div>
        )}
      </section>

      {/* Results grid: planting & harvest windows, plus calendar events */}
      <section className="ssa-results-grid">
        {/* Planting windows */}
        <div className="ssa-panel">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Planting Windows</h3>
          </div>
          {sortedPlantingWindows.length === 0 ? (
            <p className="ssa-empty-state">
              No planting windows yet. Provide climate, calendar, and crop info,
              then recompute.
            </p>
          ) : (
            <div className="ssa-table-wrapper ssa-table-wrapper--scroll">
              <table className="ssa-table ssa-table-sm">
                <thead>
                  <tr>
                    <th>Date Range</th>
                    <th>Crop</th>
                    <th>Bed</th>
                    <th>Season</th>
                    <th>Succession</th>
                    <th>Flags</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedPlantingWindows.map((w) => (
                    <tr key={w.windowId}>
                      <td>
                        <div className="ssa-cell-stack">
                          <span>
                            {w.startDate} → {w.endDate}
                          </span>
                          <span className="ssa-cell-sub">
                            Safe: {w.earliestSafeDate} – {w.latestSafeDate}
                          </span>
                        </div>
                      </td>
                      <td>{w.cropName}</td>
                      <td>{w.bedId || "Any bed"}</td>
                      <td className="ssa-badge-capitalize">{w.season}</td>
                      <td>{(w.successionIndex ?? 0) + 1}</td>
                      <td>
                        {Array.isArray(w.flags) && w.flags.length > 0 ? (
                          <div className="ssa-badge-row">
                            {w.flags.map((flag) => (
                              <span key={flag} className="ssa-badge-muted">
                                {flag.replace(/-/g, " ")}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="ssa-cell-sub">Normal</span>
                        )}
                      </td>
                      <td className="ssa-cell-actions">
                        <button
                          type="button"
                          className="ssa-button-link"
                          onClick={() => handleLaunchSession(w, "planting")}
                        >
                          Start Bed Prep Session
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Harvest windows */}
        <div className="ssa-panel">
          <div className="ssa-panel-header">
            <h3 className="ssa-panel-title">Harvest Windows</h3>
          </div>
          {sortedHarvestWindows.length === 0 ? (
            <p className="ssa-empty-state">
              No harvest windows yet. They will appear once planting windows are
              computed.
            </p>
          ) : (
            <div className="ssa-table-wrapper ssa-table-wrapper--scroll">
              <table className="ssa-table ssa-table-sm">
                <thead>
                  <tr>
                    <th>Date Range</th>
                    <th>Crop</th>
                    <th>Bed</th>
                    <th>Target Use</th>
                    <th>Feast Alignment</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {sortedHarvestWindows.map((w) => (
                    <tr key={w.windowId}>
                      <td>
                        {w.startDate} → {w.endDate}
                      </td>
                      <td>{w.cropName}</td>
                      <td>{w.bedId || "Any bed"}</td>
                      <td className="ssa-badge-capitalize">
                        {w.targetUse || "mixed"}
                      </td>
                      <td>
                        {Array.isArray(w.alignedFeastDays) &&
                        w.alignedFeastDays.length > 0 ? (
                          <div className="ssa-badge-column">
                            {w.alignedFeastDays.map((fd) => (
                              <span
                                key={fd.feastId || fd.date}
                                className="ssa-badge-accent"
                              >
                                {fd.name} ({fd.date})
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="ssa-cell-sub">None</span>
                        )}
                      </td>
                      <td className="ssa-cell-actions">
                        <button
                          type="button"
                          className="ssa-button-link"
                          onClick={() => handleLaunchSession(w, "harvest")}
                        >
                          Plan Harvest Session
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Timeline-style events */}
      <section className="ssa-panel ssa-panel--spacious">
        <div className="ssa-panel-header">
          <h3 className="ssa-panel-title">Calendar Events & “Now” Options</h3>
          <p className="ssa-panel-subtitle">
            These events can feed into your SessionRunner and storehouse plans.
          </p>
        </div>
        {upcomingEvents.length === 0 ? (
          <p className="ssa-empty-state">
            No calendar events yet. Recalculate after adding crops and climate
            info.
          </p>
        ) : (
          <ul className="ssa-timeline">
            {upcomingEvents.map((ev) => (
              <li key={ev.eventId} className="ssa-timeline-item">
                <div className="ssa-timeline-date">{ev.date}</div>
                <div className="ssa-timeline-content">
                  <div className="ssa-timeline-header">
                    <span className="ssa-timeline-title">{ev.title}</span>
                    <span className="ssa-badge-outline">
                      {ev.kind || "event"}
                    </span>
                  </div>
                  {ev.notes && (
                    <p className="ssa-timeline-notes">{ev.notes}</p>
                  )}
                  <div className="ssa-timeline-meta">
                    {ev.cropId && (
                      <span className="ssa-cell-sub">Crop: {ev.cropId}</span>
                    )}
                    {ev.bedId && (
                      <span className="ssa-cell-sub">Bed: {ev.bedId}</span>
                    )}
                  </div>
                  <div className="ssa-timeline-actions">
                    <button
                      type="button"
                      className="ssa-button-secondary ssa-button-xs"
                      onClick={() => handleLaunchSession(ev, "event")}
                    >
                      Run Session for This
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

function getDefaultPayload() {
  const now = new Date();
  return {
    context: {
      nodeKey: "gardenPlantingCalendar",
      version: "1.0.0"
    },
    inputs: {
      climate: {
        lastFrostDate: "",
        firstFrostDate: "",
        zone: "",
        notes: ""
      },
      calendar: {
        year: now.getFullYear(),
        alignWithFeastDays: true,
        feastDays: []
      },
      crops: [],
      gardenLayout: {
        beds: []
      }
    },
    outputs: null
  };
}

/**
 * Build a minimal garden session object from a planting or harvest window
 * or from a generic calendar event.
 * @param {object} windowItem
 * @param {"planting"|"harvest"|"event"} type
 * @returns {object} session object compatible with SessionRunner
 */
function buildGardenSessionFromWindow(windowItem, type) {
  const id = `garden-session-${Date.now()}`;
  const isPlanting = type === "planting";
  const isHarvest = type === "harvest";

  const title = isPlanting
    ? `Plant ${windowItem.cropName || "crops"}`
    : isHarvest
    ? `Harvest ${windowItem.cropName || "crops"}`
    : windowItem.title || "Garden task";

  const baseStepId = (name) =>
    `${id}-${name}-${Math.random().toString(36).slice(2, 7)}`;

  const steps = [];

  if (isPlanting) {
    steps.push(
      {
        id: baseStepId("prep-bed"),
        title: "Prep bed / containers",
        desc: "Weed, amend soil, and set up irrigation for this bed before planting.",
        durationSec: 20 * 60,
        blockers: ["weather", "inventory"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Stop when bed is level, moist, and free of large clumps."
        }
      },
      {
        id: baseStepId("sow"),
        title: "Sow seeds / transplant seedlings",
        desc: "Plant according to packet depth and spacing. Label rows clearly.",
        durationSec: 25 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Ensure firm seed-to-soil contact and good spacing."
        }
      },
      {
        id: baseStepId("water-in"),
        title: "Water in planting",
        desc: "Water gently until soil is evenly moist but not waterlogged.",
        durationSec: 10 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Check for pooling; adjust flow as needed."
        }
      }
    );
  } else if (isHarvest) {
    steps.push(
      {
        id: baseStepId("inspect"),
        title: "Inspect crop for ripeness",
        desc: "Check color, firmness, and aroma. Harvest only what is ripe.",
        durationSec: 15 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "texture",
          cueNotes: "Skip any damaged or diseased produce."
        }
      },
      {
        id: baseStepId("harvest"),
        title: "Harvest and sort",
        desc: "Harvest into clean containers. Sort for fresh use vs. preservation.",
        durationSec: 30 * 60,
        blockers: ["weather"],
        metadata: {
          tempTargetF: 0,
          donenessCue: "timer",
          cueNotes: "Keep produce shaded and cool while working."
        }
      }
    );
  } else {
    // Generic event-based session
    steps.push({
      id: baseStepId("task"),
      title: title,
      desc: windowItem.notes || "Garden task from planting calendar.",
      durationSec: 20 * 60,
      blockers: ["weather"],
      metadata: {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: ""
      }
    });
  }

  return {
    id,
    domain: "garden",
    title,
    source: {
      type: "gardenPlan",
      refId: windowItem.windowId || windowItem.eventId || null
    },
    steps,
    prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null
    },
    analytics: {
      skippedSteps: [],
      adjustments: []
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function findNextEvent(events, preferredKind) {
  if (!Array.isArray(events) || events.length === 0) return null;
  const todayStr = new Date().toISOString().slice(0, 10);

  const preferred = events
    .filter((ev) => ev.kind === preferredKind && ev.date >= todayStr)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  if (preferred.length > 0) return preferred[0];

  const fallback = events
    .filter((ev) => ev.date >= todayStr)
    .sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  return fallback[0] || events[0];
}

function toInt(value, fallback) {
  if (value === "" || value === null || value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

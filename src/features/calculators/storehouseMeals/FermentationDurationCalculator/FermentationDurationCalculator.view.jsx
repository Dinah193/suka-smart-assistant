// C:\Users\larho\suka-smart-assistant\src\features\calculators\storehouseMeals\FermentationDurationCalculator\FermentationDurationCalculator.view.jsx

/**
 * FermentationDurationCalculator.view.jsx
 *
 * HOW THIS FITS:
 * - UI wrapper for the FermentationDurationCalculator shim.
 * - Lets the user define a fermentation batch (kraut, pickles, wine, beer, etc.),
 *   compute a schedule, and visualize phases + ready windows.
 * - Exposes a “Start Guidance Session” / “Now” CTA that emits a
 *   `session.request.fromFermentationDuration` event, which your global
 *   SessionRunner listener can use to open the SessionRunner modal.
 *
 * This component:
 *   1. Collects inputs (product, batch size, method, temp, style).
 *   2. Calls runFermentationDurationCalculator from the shim.
 *   3. Renders schedule, ready window, storage move, and hints.
 *   4. Emits a session request event wired into the global runner.
 */

import React, { useState } from "react";
import { emit as emitEvent } from "@/services/eventBus";
import { runFermentationDurationCalculator } from "./FermentationDurationCalculator.shim";

/**
 * @typedef {Object} FermentationFormState
 * @property {string} productType
 * @property {number | ""} batchSize
 * @property {string} unit
 * @property {string} method
 * @property {string} temperatureUnit
 * @property {number | ""} temperatureMin
 * @property {number | ""} temperatureMax
 * @property {string} targetStyle
 * @property {number | ""} saltPct
 * @property {string} starterType
 * @property {number | ""} desiredShelfLifeDays
 */

/**
 * Main view component for fermentation planning.
 *
 * @param {Object} props
 * @param {Function} [props.onResult] - Optional callback invoked with calculator result.
 */
export default function FermentationDurationCalculatorView({ onResult }) {
  const [form, setForm] = useState(
    /** @type {FermentationFormState} */ ({
      productType: "cabbage",
      batchSize: "",
      unit: "jar",
      method: "brined",
      temperatureUnit: "F",
      temperatureMin: 65,
      temperatureMax: 72,
      targetStyle: "tangy",
      saltPct: 2.5,
      starterType: "",
      desiredShelfLifeDays: 60
    })
  );

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  const hasResult = !!result?.data?.outputs;
  const outputs = result?.data?.outputs || {};
  const schedule = outputs.schedule || [];
  const targetReadyWindow = outputs.targetReadyWindow || null;
  const storageShift = outputs.storageShift || null;
  const sessionSuggestions = outputs.sessionSuggestions || [];

  function handleChange(e) {
    const { name, value } = e.target;

    if (["batchSize", "temperatureMin", "temperatureMax", "saltPct", "desiredShelfLifeDays"].includes(name)) {
      setForm((prev) => ({
        ...prev,
        [name]: value === "" ? "" : Number(value)
      }));
      return;
    }

    setForm((prev) => ({
      ...prev,
      [name]: value
    }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const payload = buildPayloadFromForm(form);
      const result = await runFermentationDurationCalculator({ data: payload });
      setResult(result);
      if (typeof onResult === "function") {
        onResult(result);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function handleStartSessionClick() {
    if (!hasResult || !sessionSuggestions.length) return;

    const ts = new Date().toISOString();
    const source = "ui/FermentationDurationCalculator.view";

    // Minimal selection logic: if multiple sessions, pick the earliest
    const selected = [...sessionSuggestions].sort((a, b) => {
      const da = a.scheduledFor ? new Date(a.scheduledFor).getTime() : 0;
      const db = b.scheduledFor ? new Date(b.scheduledFor).getTime() : 0;
      return da - db;
    });

    emitEvent({
      type: "session.request.fromFermentationDuration",
      ts,
      source,
      data: {
        schedule,
        targetReadyWindow,
        storageShift,
        sessionSuggestions: selected,
        origin: "FermentationDurationCalculator",
        // optional hint: domain/prefs so SessionRunner can pre-fill
        sessionMeta: {
          domain: "preservation",
          title: `Ferment: ${form.productType}`,
          sourceType: "manual"
        }
      }
    });
  }

  return (
    <div className="flex flex-col gap-6 w-full max-w-6xl mx-auto">
      {/* Header */}
      <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            Fermentation Planner
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Define your batch, temperature, and style to generate a fermentation schedule,
            ready window, and gentle reminders that can flow into your SessionRunner.
          </p>
        </div>

        <button
          type="button"
          onClick={handleStartSessionClick}
          disabled={!hasResult || !sessionSuggestions.length}
          className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium shadow-sm transition-colors
          ${
            hasResult && sessionSuggestions.length
              ? "bg-emerald-600 text-white hover:bg-emerald-700"
              : "bg-slate-200 text-slate-500 cursor-not-allowed"
          }`}
        >
          {hasResult ? "Start Guidance Session" : "Calculate First to Start Session"}
        </button>
      </header>

      {/* Content */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Form */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 sm:p-5 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wide">
            Batch Setup
          </h2>

          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            {/* Product */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Product Type
                </label>
                <input
                  type="text"
                  name="productType"
                  value={form.productType}
                  onChange={handleChange}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="e.g. cabbage, cucumbers, wine"
                />
              </div>

              <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate-700">
                    Batch Size
                  </label>
                  <input
                    type="number"
                    name="batchSize"
                    value={form.batchSize}
                    onChange={handleChange}
                    min={0}
                    step="0.1"
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                    placeholder="e.g. 5"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate-700">
                    Unit
                  </label>
                  <select
                    name="unit"
                    value={form.unit}
                    onChange={handleChange}
                    className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  >
                    <option value="jar">jar(s)</option>
                    <option value="quart">quart(s)</option>
                    <option value="liter">liter(s)</option>
                    <option value="kg">kg</option>
                    <option value="lb">lb</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Method & Style */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Method
                </label>
                <select
                  name="method"
                  value={form.method}
                  onChange={handleChange}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="brined">Brined</option>
                  <option value="dry_salted">Dry-Salted</option>
                  <option value="starter_based">Starter-Based</option>
                  <option value="wild">Wild</option>
                  <option value="other">Other</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Target Style
                </label>
                <select
                  name="targetStyle"
                  value={form.targetStyle}
                  onChange={handleChange}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="mild">Mild</option>
                  <option value="tangy">Tangy</option>
                  <option value="sour">Very Sour</option>
                  <option value="crisp">Crisp</option>
                  <option value="soft">Soft</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Salt % (optional)
                </label>
                <input
                  type="number"
                  name="saltPct"
                  value={form.saltPct}
                  onChange={handleChange}
                  min={0}
                  max={25}
                  step="0.1"
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="e.g. 2.5"
                />
              </div>
            </div>

            {/* Temperature */}
            <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr_1fr] gap-4 items-end">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Temp Unit
                </label>
                <select
                  name="temperatureUnit"
                  value={form.temperatureUnit}
                  onChange={handleChange}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                >
                  <option value="F">°F</option>
                  <option value="C">°C</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Temp Min
                </label>
                <input
                  type="number"
                  name="temperatureMin"
                  value={form.temperatureMin}
                  onChange={handleChange}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Temp Max
                </label>
                <input
                  type="number"
                  name="temperatureMax"
                  value={form.temperatureMax}
                  onChange={handleChange}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                />
              </div>
            </div>

            {/* Starter & Shelf life */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Starter Type (optional)
                </label>
                <input
                  type="text"
                  name="starterType"
                  value={form.starterType}
                  onChange={handleChange}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="e.g. whey, brine from previous batch"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-700">
                  Desired Shelf Life (days, optional)
                </label>
                <input
                  type="number"
                  name="desiredShelfLifeDays"
                  value={form.desiredShelfLifeDays}
                  onChange={handleChange}
                  min={0}
                  className="border border-slate-300 rounded-md px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  placeholder="e.g. 60"
                />
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <p className="text-[11px] text-slate-500">
                Tip: Start with your everyday kraut and tweak style & temp to see how your schedule shifts.
              </p>
              <button
                type="submit"
                disabled={loading}
                className={`inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium shadow-sm transition-colors
                ${loading ? "bg-slate-300 text-slate-600" : "bg-emerald-600 text-white hover:bg-emerald-700"}`}
              >
                {loading ? "Calculating…" : "Calculate Schedule"}
              </button>
            </div>
          </form>
        </section>

        {/* Right: Results */}
        <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 sm:p-5 flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-slate-800 uppercase tracking-wide">
            Schedule & Ready Window
          </h2>

          {!hasResult && (
            <div className="flex-1 flex flex-col items-center justify-center text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg p-4">
              <p>Run a calculation to see suggested fermentation phases, checkpoints, and ready windows.</p>
            </div>
          )}

          {hasResult && (
            <>
              {/* Ready window + storage shift summary */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border border-emerald-100 rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-emerald-800 uppercase tracking-wide mb-1">
                    Ready Window
                  </h3>
                  {targetReadyWindow ? (
                    <div className="text-xs text-slate-700 space-y-1">
                      <p>
                        <span className="font-medium">Start:</span>{" "}
                        {formatDateTime(targetReadyWindow.start)}
                      </p>
                      <p>
                        <span className="font-medium">End:</span>{" "}
                        {formatDateTime(targetReadyWindow.end)}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-1">
                        This is when your ferment should be at peak flavor and texture.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">No ready window calculated.</p>
                  )}
                </div>

                <div className="border border-sky-100 rounded-lg p-3">
                  <h3 className="text-xs font-semibold text-sky-800 uppercase tracking-wide mb-1">
                    Move to Cold Storage
                  </h3>
                  {storageShift ? (
                    <div className="text-xs text-slate-700 space-y-1">
                      <p>
                        <span className="font-medium">Move At:</span>{" "}
                        {formatDateTime(storageShift.moveAt)}
                      </p>
                      <p>
                        <span className="font-medium">Location:</span>{" "}
                        {storageShift.targetStorage || "Fermentation Shelf / Fridge"}
                      </p>
                      <p className="text-[11px] text-slate-500 mt-1">
                        SessionRunner can remind you when it&apos;s time to move jars/crocks.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500">No storage shift calculated.</p>
                  )}
                </div>
              </div>

              {/* Timeline of phases */}
              <div className="mt-2">
                <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide mb-2">
                  Fermentation Phases
                </h3>
                <ol className="space-y-3">
                  {schedule.map((phase) => (
                    <li
                      key={phase.phaseId}
                      className="border border-slate-200 rounded-lg p-3 flex flex-col gap-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-slate-800">
                            {phase.label}
                          </p>
                          <p className="text-[11px] text-slate-500">
                            {formatDateTime(phase.startAt)} → {formatDateTime(phase.endAt)} •{" "}
                            {phase.durationDays} day(s)
                          </p>
                        </div>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                          {phase.phaseId}
                        </span>
                      </div>

                      {Array.isArray(phase.checkpoints) && phase.checkpoints.length > 0 && (
                        <div className="border-t border-slate-100 pt-2">
                          <p className="text-[11px] font-medium text-slate-700 mb-1">
                            Checkpoints
                          </p>
                          <ul className="space-y-1">
                            {phase.checkpoints.map((cp) => (
                              <li
                                key={`${cp.id}-${cp.offsetDays}`}
                                className="flex items-start gap-2 text-[11px] text-slate-600"
                              >
                                <span className="mt-[3px] h-1.5 w-1.5 rounded-full bg-emerald-500" />
                                <span>
                                  <span className="font-medium">{cp.label}</span>{" "}
                                  <span className="text-slate-500">
                                    (Day +{cp.offsetDays}
                                    {cp.preferredTimeOfDay ? `, ${cp.preferredTimeOfDay}` : ""})
                                  </span>
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </div>

              {/* Session suggestions list */}
              {sessionSuggestions.length > 0 && (
                <div className="mt-3 border-t border-slate-100 pt-3">
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">
                      Suggested Guidance Sessions
                    </h3>
                    <span className="text-[10px] text-slate-500">
                      {sessionSuggestions.length} suggestion
                      {sessionSuggestions.length !== 1 ? "s" : ""}
                    </span>
                  </div>

                  <ul className="space-y-2 max-h-40 overflow-y-auto pr-1">
                    {sessionSuggestions.map((s) => (
                      <li
                        key={s.id}
                        className="border border-slate-200 rounded-md px-2 py-1.5 text-[11px] flex flex-col gap-0.5"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium text-slate-800">{s.title}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                            {s.kind}
                          </span>
                        </div>
                        {s.scheduledFor && (
                          <p className="text-[10px] text-slate-500">
                            Scheduled: {formatDateTime(s.scheduledFor)}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>

                  <p className="text-[11px] text-slate-500 mt-2">
                    Use <span className="font-medium">Start Guidance Session</span> to send one
                    or more of these into the SessionRunner, where timers, toasts, and voice cues
                    can guide you step by step.
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/**
 * Format an ISO string for friendly display.
 *
 * @param {string} iso
 * @returns {string}
 */
function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

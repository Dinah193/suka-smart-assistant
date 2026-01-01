// C:\Users\larho\suka-smart-assistant\src\features\calculators\gardenAnimal\IrrigationCalculator\IrrigationCalculator.view.jsx

import React, { useMemo, useState } from "react";
// When you generate IrrigationCalculator.hooks.js, implement this hook there.
// For now, the import is here so the view will wire in automatically.
import { useIrrigationCalculator } from "./IrrigationCalculator.hooks";

/**
 * IrrigationCalculator.view
 * -------------------------
 * How this fits:
 * - UI shell for the IrrigationCalculator node in the Planning Graph.
 * - Lets the user:
 *    • review inferred weekly water requirements,
 *    • inspect upcoming irrigation events,
 *    • launch irrigation sessions via a “Now” CTA.
 * - Does NOT own persistence or SessionRunner; it delegates:
 *    • to useIrrigationCalculator() for data + actions,
 *    • to whatever the hook uses for SessionRunner integration.
 *
 * Expectations for useIrrigationCalculator():
 * - Signature: const { inputs, outputs, schedule, status, handlers } = useIrrigationCalculator(props?);
 * - handlers MUST include:
 *    • handleRunNowForEvent(eventId)
 *    • handleRunAllNow()
 *    • handleRecalculate()
 *    • handleInputChange(path, value)  (optional – for future editable inputs)
 */

function IrrigationCalculatorView(props) {
  const {
    inputs,
    outputs,
    schedule,
    status,
    handlers,
  } = useIrrigationCalculator(props);

  const [selectedEventId, setSelectedEventId] = useState(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);

  const {
    perBedInchesPerWeek = {},
    perZoneGallonsPerWeek = {},
    totalGallonsPerWeek = 0,
  } = outputs?.waterRequirements || {};

  const scheduleForSelectedEvent = useMemo(() => {
    if (!Array.isArray(schedule) || !selectedEventId) return null;
    return schedule.find((evt) => evt.eventId === selectedEventId) || null;
  }, [schedule, selectedEventId]);

  const isBusy = status?.isRunning || status?.isLoading;
  const errorMessage = status?.errorMessage || null;

  const handleOpenModal = () => {
    setShowScheduleModal(true);
  };

  const handleCloseModal = () => {
    setShowScheduleModal(false);
    setSelectedEventId(null);
  };

  const handleRunAllNow = () => {
    if (handlers && typeof handlers.handleRunAllNow === "function") {
      handlers.handleRunAllNow();
    }
  };

  const handleRunEventNow = (eventId) => {
    if (handlers && typeof handlers.handleRunNowForEvent === "function") {
      handlers.handleRunNowForEvent(eventId);
    }
  };

  const handleRecalculate = () => {
    if (handlers && typeof handlers.handleRecalculate === "function") {
      handlers.handleRecalculate();
    }
  };

  return (
    <div className="ssa-panel ssa-irr-calc flex flex-col gap-4 rounded-xl border border-slate-700 bg-slate-900/70 p-4 text-slate-50">
      {/* Header */}
      <header className="flex flex-col gap-2 border-b border-slate-700 pb-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Irrigation Planner
          </h2>
          <p className="mt-1 text-xs text-slate-300">
            Plan weekly irrigation by zone and bed, then launch guided
            irrigation sessions that run inside your SessionRunner modal.
          </p>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 md:mt-0">
          <button
            type="button"
            onClick={handleRecalculate}
            disabled={isBusy}
            className="inline-flex items-center rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isBusy ? "Calculating…" : "Recalculate"}
          </button>
          <button
            type="button"
            onClick={handleOpenModal}
            className="inline-flex items-center rounded-md bg-sky-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-sky-500"
          >
            View Schedule
          </button>
          <button
            type="button"
            onClick={handleRunAllNow}
            disabled={isBusy || !schedule || schedule.length === 0}
            className="inline-flex items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-800/60"
          >
            Now: Run Next Irrigation
          </button>
        </div>
      </header>

      {/* Error */}
      {errorMessage && (
        <div className="rounded-md border border-red-500/70 bg-red-900/40 px-3 py-2 text-xs text-red-100">
          {errorMessage}
        </div>
      )}

      {/* Summary Row */}
      <section className="grid gap-3 md:grid-cols-3">
        <SummaryCard
          title="Weekly water use"
          primary={`${roundTo(totalGallonsPerWeek || 0, 1)} gal / week`}
          subtitle="All beds & zones combined"
        />
        <SummaryCard
          title="Irrigation zones"
          primary={Object.keys(perZoneGallonsPerWeek || {}).length || "—"}
          subtitle="Active zones in this plan"
        />
        <SummaryCard
          title="Planned events"
          primary={schedule?.length ? schedule.length : "—"}
          subtitle="Within the current planning horizon"
        />
      </section>

      {/* Per-zone breakdown */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Zone breakdown
          </h3>
          <span className="text-[10px] text-slate-400">
            1 in over 1 ft² ≈ 0.623 gallons
          </span>
        </div>

        {Object.keys(perZoneGallonsPerWeek || {}).length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            No irrigation zones found. Add beds with zone IDs in your garden
            plan to see zone-level recommendations.
          </p>
        ) : (
          <div className="mt-3 grid gap-2 md:grid-cols-2">
            {Object.entries(perZoneGallonsPerWeek).map(([zoneId, gallons]) => (
              <div
                key={zoneId}
                className="flex flex-col rounded-md border border-slate-800 bg-slate-950/40 p-2"
              >
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-100">
                    Zone {zoneId}
                  </div>
                  <div className="text-xs text-slate-300">
                    {roundTo(gallons, 1)} gal / week
                  </div>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full bg-sky-500 transition-all"
                    style={{
                      width: buildZoneBarWidth(
                        gallons,
                        totalGallonsPerWeek || 0
                      ),
                    }}
                  />
                </div>
                <div className="mt-1 text-[10px] text-slate-400">
                  Based on current beds, soil, climate, and preferences.
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Per-bed depth table */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Bed irrigation depth
          </h3>
          <span className="text-[10px] text-slate-400">
            Target weekly inches per bed (approximate)
          </span>
        </div>

        {Object.keys(perBedInchesPerWeek || {}).length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            No beds found for this calculator. Once you define beds in your
            garden planner, this table will show targets per bed.
          </p>
        ) : (
          <div className="mt-2 max-h-48 overflow-auto rounded border border-slate-800">
            <table className="min-w-full text-left text-[11px]">
              <thead className="bg-slate-950/70 text-slate-300">
                <tr>
                  <th className="px-2 py-1 font-medium">Bed ID</th>
                  <th className="px-2 py-1 font-medium">Weekly depth (in)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800 bg-slate-950/30">
                {Object.entries(perBedInchesPerWeek).map(([bedId, inches]) => (
                  <tr key={bedId}>
                    <td className="px-2 py-1 text-slate-100">{bedId}</td>
                    <td className="px-2 py-1 text-slate-200">
                      {roundTo(inches, 2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Compact schedule preview */}
      <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Upcoming irrigation events
          </h3>
          <button
            type="button"
            onClick={handleOpenModal}
            className="text-[11px] font-medium text-sky-400 hover:text-sky-300"
          >
            Open full schedule
          </button>
        </div>

        {!schedule || schedule.length === 0 ? (
          <p className="mt-2 text-xs text-slate-400">
            No irrigation events generated yet for the current horizon. Run the
            calculator or adjust your garden inputs.
          </p>
        ) : (
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            {schedule.slice(0, 4).map((evt) => (
              <button
                key={evt.eventId}
                type="button"
                onClick={() => {
                  setSelectedEventId(evt.eventId);
                  setShowScheduleModal(true);
                }}
                className="flex flex-col rounded-md border border-slate-800 bg-slate-950/50 p-2 text-left hover:border-sky-500/60 hover:bg-slate-900"
              >
                <div className="flex items-center justify-between">
                  <div className="text-[11px] font-semibold text-slate-100">
                    Zone {evt.zoneId}
                  </div>
                  <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200">
                    {formatLocalDayAndTime(evt.startDateTimeLocal)}
                  </span>
                </div>
                <div className="mt-1 text-[11px] text-slate-200">
                  {roundTo(evt.expectedDepthIn || 0, 2)} in,{" "}
                  {roundTo(evt.expectedVolumeGallons || 0, 1)} gal,{" "}
                  {roundTo(evt.durationMinutes || 0, 1)} min
                </div>
                {evt.priority === "low" && (
                  <div className="mt-1 text-[10px] text-amber-300">
                    Low priority (rain expected)
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Full schedule modal */}
      {showScheduleModal && (
        <IrrigationScheduleModal
          schedule={schedule}
          selectedEventId={selectedEventId}
          onSelectEvent={setSelectedEventId}
          onClose={handleCloseModal}
          onRunEventNow={handleRunEventNow}
          onRunAllNow={handleRunAllNow}
          isBusy={isBusy}
          detailEvent={scheduleForSelectedEvent}
        />
      )}
    </div>
  );
}

/**
 * Simple KPI-like card used in summary row.
 */
function SummaryCard({ title, primary, subtitle }) {
  return (
    <div className="flex flex-col rounded-lg border border-slate-800 bg-slate-950/60 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
        {title}
      </div>
      <div className="mt-1 text-base font-semibold text-slate-50">
        {primary}
      </div>
      {subtitle && (
        <div className="mt-0.5 text-[11px] text-slate-400">{subtitle}</div>
      )}
    </div>
  );
}

/**
 * Full schedule + "Now" controls modal.
 * This is a local planner view; the long-running behavior is handled by the
 * global SessionRunner once a "Now" action is triggered via hooks.
 */
function IrrigationScheduleModal({
  schedule,
  selectedEventId,
  onSelectEvent,
  onClose,
  onRunEventNow,
  onRunAllNow,
  isBusy,
  detailEvent,
}) {
  const hasEvents = Array.isArray(schedule) && schedule.length > 0;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70">
      <div className="relative flex h-[90vh] w-[95vw] max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-950/95 shadow-2xl">
        {/* Modal header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2.5">
          <div>
            <h3 className="text-sm font-semibold text-slate-50">
              Irrigation schedule
            </h3>
            <p className="text-[11px] text-slate-400">
              Review events and start guided irrigation sessions. Once started,
              the SessionRunner will stay active as you move through the app.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onRunAllNow}
              disabled={!hasEvents || isBusy}
              className="inline-flex items-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-900/60"
            >
              Now: Next event
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center rounded-md border border-slate-600 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-800"
            >
              Close
            </button>
          </div>
        </div>

        {/* Modal body: list + detail */}
        <div className="flex flex-1 flex-col divide-y divide-slate-800 md:flex-row md:divide-x md:divide-y-0">
          {/* Left – list of events */}
          <div className="flex-1 overflow-auto p-3">
            {!hasEvents ? (
              <p className="text-xs text-slate-400">
                No irrigation events were generated. Adjust your garden inputs
                or planning horizon and recalculate.
              </p>
            ) : (
              <div className="space-y-2">
                {schedule.map((evt) => {
                  const isSelected = evt.eventId === selectedEventId;
                  return (
                    <button
                      key={evt.eventId}
                      type="button"
                      onClick={() => onSelectEvent(evt.eventId)}
                      className={`flex w-full flex-col rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
                        isSelected
                          ? "border-sky-500 bg-sky-900/40"
                          : "border-slate-800 bg-slate-900/60 hover:border-sky-500/70 hover:bg-slate-900"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-50">
                          Zone {evt.zoneId}
                        </span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200">
                          {formatLocalDayAndTime(evt.startDateTimeLocal)}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-slate-200">
                        <span>
                          Depth: {roundTo(evt.expectedDepthIn || 0, 2)} in
                        </span>
                        <span>
                          Volume: {roundTo(evt.expectedVolumeGallons || 0, 1)}{" "}
                          gal
                        </span>
                        <span>
                          Duration: {roundTo(evt.durationMinutes || 0, 1)} min
                        </span>
                      </div>
                      {evt.priority === "low" && (
                        <div className="mt-1 text-[10px] text-amber-300">
                          Low priority – rain likely; you may skip.
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Right – details + Now button */}
          <div className="w-full border-t border-slate-800 bg-slate-950/80 p-3 md:w-80 md:border-l md:border-t-0">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
              Event details
            </h4>

            {!detailEvent ? (
              <p className="mt-2 text-xs text-slate-400">
                Select an irrigation event to see details, then use{" "}
                <span className="font-semibold text-slate-100">Now</span> to
                start a guided irrigation session.
              </p>
            ) : (
              <>
                <div className="mt-2 rounded-md border border-slate-800 bg-slate-900/80 p-2 text-xs text-slate-100">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">
                      Zone {detailEvent.zoneId}
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-200">
                      {formatLocalDayAndTime(detailEvent.startDateTimeLocal)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-200">
                    <div>
                      <span className="font-medium">Depth: </span>
                      {roundTo(detailEvent.expectedDepthIn || 0, 2)} in
                    </div>
                    <div>
                      <span className="font-medium">Volume: </span>
                      {roundTo(detailEvent.expectedVolumeGallons || 0, 1)} gal
                    </div>
                    <div>
                      <span className="font-medium">Duration: </span>
                      {roundTo(detailEvent.durationMinutes || 0, 1)} min
                    </div>
                    {Array.isArray(detailEvent.bedIds) &&
                      detailEvent.bedIds.length > 0 && (
                        <div className="mt-1">
                          <span className="font-medium">Beds: </span>
                          <span className="text-slate-100">
                            {detailEvent.bedIds.join(", ")}
                          </span>
                        </div>
                      )}
                    {detailEvent.notes && (
                      <div className="mt-1 text-[11px] text-slate-300">
                        {detailEvent.notes}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-3 rounded-md border border-slate-800 bg-slate-900/80 p-2 text-[11px] text-slate-200">
                  <div className="font-semibold text-slate-100">
                    What happens when you press{" "}
                    <span className="text-emerald-300">Now</span>:
                  </div>
                  <ul className="mt-1 list-disc pl-4">
                    <li>
                      A garden-domain session is created from this event
                      (start, monitor, stop).
                    </li>
                    <li>
                      The SessionRunner full-screen modal opens and keeps the
                      timer running even if you navigate to other SSA pages.
                    </li>
                    <li>
                      Step changes emit <code className="text-[10px]">
                        session.step.changed
                      </code>{" "}
                      events and optional notifications.
                    </li>
                  </ul>
                </div>

                <button
                  type="button"
                  onClick={() => onRunEventNow(detailEvent.eventId)}
                  disabled={isBusy}
                  className="mt-3 inline-flex w-full items-center justify-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-900/60"
                >
                  Now: Run this irrigation session
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Helpers
 */

function roundTo(value, decimals) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function buildZoneBarWidth(gallons, totalGallons) {
  if (typeof gallons !== "number" || gallons <= 0 || totalGallons <= 0) {
    return "0%";
  }
  const pct = Math.min(100, Math.max(5, (gallons / totalGallons) * 100));
  return `${pct}%`;
}

function formatLocalDayAndTime(isoString) {
  if (!isoString) return "Unknown";
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return "Invalid date";

  const dayOptions = { weekday: "short", month: "short", day: "numeric" };
  const timeOptions = { hour: "numeric", minute: "2-digit" };

  const day = d.toLocaleDateString(undefined, dayOptions);
  const time = d.toLocaleTimeString(undefined, timeOptions);
  return `${day} • ${time}`;
}

export default IrrigationCalculatorView;

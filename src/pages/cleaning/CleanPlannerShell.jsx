/* eslint-disable no-console */
// src/pages/Cleaning/CleanPlannerShell.jsx
//
// CleanPlannerShell — “Decide for me”, conflict resolver, and helper tools
// ----------------------------------------------------------------------------------
// • Central shell for planning cleaning sessions (routines + deep cleans + ad-hoc)
// • Inputs: preferred window, energy level, residents-at-home flag, Sabbath guard
// • “Decide for me” builds a draft plan using simple scoring + your templates
// • Conflict Resolver finds overlaps vs. existing tasks and offers auto-fixes
// • Batch/Prep consolidation (e.g., share tools/chemicals per zone)
// • Quick links: Supplies shortages → Jump to Grocery; Collect → import checklists
// • Emits events and degrades gracefully if services aren’t wired yet
//
// Inspirations: Asana’s “smart suggestions”, Linear’s clean layout, Notion’s simple toggles

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  addMinutes,
  format,
  isAfter,
  isBefore,
  isToday,
  parseISO,
} from "date-fns";

// ---------------- Defensive service/context imports ----------------
let eventBus;
try {
  eventBus = require("../../services/events/eventBus").default;
} catch {
  eventBus = {
    emit: (...args) =>
      console.debug("[CleanPlannerShell:eventBus.emit]", ...args),
    on: () => () => {},
  };
}

let useMilestoneState;
try {
  useMilestoneState = require("../../app/hooks/useMilestoneState").default;
} catch {
  useMilestoneState = () => ({ recordMilestone: () => {} });
}

let SettingsContext;
try {
  SettingsContext =
    require("../../components/context/SettingsContext").SettingsContext;
} catch {
  SettingsContext = React.createContext({
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sabbathGuard: false,
    sabbathWindow: { startDow: 5, startHour: 18, endDow: 6, endHour: 19 },
  });
}

let PlanDraftContext;
try {
  PlanDraftContext =
    require("../../components/context/PlanDraftContext").PlanDraftContext;
} catch {
  PlanDraftContext = React.createContext({
    selectedDateISO: new Date().toISOString(),
    tasks: [],
    setTasks: () => {},
  });
}

let scheduleHelpers = {};
try {
  scheduleHelpers = require("../../engines/scheduling/scheduleHelpers.js");
} catch {
  /* noop */
}

let estimateEngine;
try {
  estimateEngine = require("../../engines/estimates/estimateEngine.js");
} catch {
  estimateEngine = {
    estimate: (t) => ({ timeMinutes: t?.estMinutes || 30, cost: null }),
  };
}

let planTemplates;
try {
  planTemplates = require("../../engines/planning/planTemplates.js");
} catch {
  planTemplates = {
    // Minimal fallback cleaning templates
    getTemplates: () => [
      {
        id: "quick-kitchen",
        title: "Quick Reset: Kitchen",
        domain: "cleaning",
        zone: "kitchen",
        estMinutes: 20,
        checklist: ["Dishes", "Wipe counters", "Sweep/Mop spot"],
      },
      {
        id: "bath-boost",
        title: "Bathroom Boost",
        domain: "cleaning",
        zone: "bathroom",
        estMinutes: 25,
        checklist: ["Toilet", "Sink", "Mirror", "Tub spot clean"],
      },
      {
        id: "living-tidy",
        title: "Living Area Tidy",
        domain: "cleaning",
        zone: "living",
        estMinutes: 15,
        checklist: ["Declutter", "Surfaces", "Vacuum"],
      },
      {
        id: "deep-fridge",
        title: "Deep Clean: Fridge",
        domain: "cleaning",
        zone: "kitchen",
        estMinutes: 40,
        checklist: ["Remove items", "Wipe shelves", "Discard old"],
      },
    ],
  };
}

let prepConsolidationEngine;
try {
  prepConsolidationEngine = require("../../engines/planning/prepConsolidationEngine.js");
} catch {
  prepConsolidationEngine = {
    consolidate: (tasks) => {
      // naive example: group by zone to suggest batching
      const byZone = new Map();
      for (const t of tasks) {
        const z = t.zone || "general";
        if (!byZone.has(z)) byZone.set(z, []);
        byZone.get(z).push(t);
      }
      return Array.from(byZone.entries()).map(([zone, items]) => ({
        key: `zone:${zone}`,
        label: `Batch tools & supplies for ${zone} (${items.length})`,
        items,
      }));
    },
  };
}

let TaskPlanView;
try {
  TaskPlanView = require("../../components/tasks/TaskPlanView.jsx").default;
} catch {
  TaskPlanView = () => (
    <div className="rounded-2xl border p-6 text-sm text-gray-600">
      TaskPlanView missing; install src/components/tasks/TaskPlanView.jsx
    </div>
  );
}

// ---------------- Utility helpers ----------------
const withinSabbath = (
  now = new Date(),
  window = { startDow: 5, startHour: 18, endDow: 6, endHour: 19 }
) => {
  const dow = now.getDay();
  const hr = now.getHours();
  if (dow === window.startDow && hr >= window.startHour) return true;
  if (dow === window.endDow && hr < window.endHour) return true;
  return false;
};

const pretty = (iso) => {
  try {
    const d = parseISO(iso);
    return `${format(d, "EEE, MMM d")} ${isToday(d) ? "(Today)" : ""}`;
  } catch {
    return "Selected Day";
  }
};

// Find overlaps between candidate tasks and existing tasks
function detectConflicts({ candidates, existing }) {
  const conflicts = [];
  const toSpan = (t) => {
    const start = parseISO(t.start);
    const end = addMinutes(start, Number(t.estMinutes || 30));
    return { id: t.id, start, end, title: t.title };
  };
  const cSpans = candidates
    .filter((t) => t.start)
    .map(toSpan)
    .sort((a, b) => a.start - b.start);
  const eSpans = existing
    .filter((t) => t.start)
    .map(toSpan)
    .sort((a, b) => a.start - b.start);

  let i = 0,
    j = 0;
  while (i < cSpans.length && j < eSpans.length) {
    const c = cSpans[i];
    const e = eSpans[j];
    const overlap = !(isBefore(c.end, e.start) || isAfter(c.start, e.end));
    if (overlap) conflicts.push({ candidate: c, existing: e });
    if (isBefore(c.end, e.end)) i++;
    else j++;
  }
  return conflicts;
}

// Simple scorer for cleaning templates based on inputs
function scoreTemplate(t, prefs) {
  let s = 0;
  if (prefs.energy === "low" && (t.estMinutes || 30) <= 20) s += 2;
  if (prefs.energy === "medium" && (t.estMinutes || 30) <= 35) s += 2;
  if (prefs.energy === "high" && (t.estMinutes || 30) > 30) s += 2;
  if (prefs.zones.size === 0 || prefs.zones.has(t.zone)) s += 2;
  if (
    prefs.cleaningGoals.includes("sanitation") &&
    /bath|kitchen/.test(t.zone || "")
  )
    s += 1;
  if (prefs.residentsHome === false && /living|bath|kitchen/.test(t.zone || ""))
    s += 1; // empty rooms bonus
  return s;
}

function generateDraft({ dateISO, startTime, endTime, prefs }) {
  // Create ISO window
  const start = parseISO(
    `${format(parseISO(dateISO), "yyyy-MM-dd")}T${startTime}:00`
  );
  const end = parseISO(
    `${format(parseISO(dateISO), "yyyy-MM-dd")}T${endTime}:00`
  );

  // Candidate templates
  const templates = (planTemplates.getTemplates?.() || []).filter(
    (t) => t.domain === "cleaning"
  );
  const ranked = templates
    .map((t) => ({ ...t, _score: scoreTemplate(t, prefs) }))
    .sort((a, b) => b._score - a._score);

  // Pack tasks into window (greedy)
  const draft = [];
  let cursor = start;
  for (const tpl of ranked) {
    const est =
      tpl.estMinutes || estimateEngine.estimate?.(tpl)?.timeMinutes || 30;
    const nextEnd = addMinutes(cursor, est);
    if (isAfter(nextEnd, end)) continue;

    draft.push({
      id: `clean:${cryptoId()}`,
      title: tpl.title,
      domain: "cleaning",
      date: format(cursor, "yyyy-MM-dd"),
      start: format(cursor, "yyyy-MM-dd'T'HH:mm:ss"),
      estMinutes: est,
      zone: tpl.zone,
      checklist: tpl.checklist || [],
      priority: prefs.energy === "high" ? "high" : "normal",
      tags: ["auto-planned"],
    });
    cursor = nextEnd;
  }
  return draft;
}

function cryptoId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID)
    return crypto.randomUUID();
  return "id-" + Math.random().toString(36).slice(2, 9);
}

// ---------------- Component ----------------
export default function CleanPlannerShell() {
  const { sabbathGuard, sabbathWindow } = React.useContext(SettingsContext);
  const { selectedDateISO, tasks, setTasks } =
    React.useContext(PlanDraftContext);
  const { recordMilestone } = useMilestoneState();

  const [windowStart, setWindowStart] = useState("09:00");
  const [windowEnd, setWindowEnd] = useState("12:00");
  const [energy, setEnergy] = useState("medium"); // low | medium | high
  const [residentsHome, setResidentsHome] = useState(true);
  const [zones, setZones] = useState(
    new Set(["kitchen", "bathroom", "living"])
  );
  const [goals, setGoals] = useState(["sanitation"]); // sanitation | tidy | deep
  const [draft, setDraft] = useState([]);
  const [conflicts, setConflicts] = useState([]);
  const [showConflictModal, setShowConflictModal] = useState(false);
  const [showConsolidation, setShowConsolidation] = useState(true);
  const [shortageCount, setShortageCount] = useState(0);

  // Listen for shortages summary to surface helpful “Supplies” CTA
  useEffect(() => {
    const off = eventBus.on?.("supplies.shortages.update", (payload) => {
      const n = Array.isArray(payload?.items)
        ? payload.items.filter(
            (r) => r.domain === "cleaning" || r.domain === "hygiene"
          ).length
        : 0;
      setShortageCount(n);
    });
    return () => off?.();
  }, []);

  const prefs = useMemo(
    () => ({
      energy,
      residentsHome,
      zones,
      cleaningGoals: goals,
    }),
    [energy, residentsHome, zones, goals]
  );

  // Decide for me
  const handleDecide = useCallback(() => {
    const disabled = sabbathGuard && withinSabbath(new Date(), sabbathWindow);
    if (disabled) {
      eventBus.emit("ui.toast", {
        variant: "warning",
        message: "Sabbath guard active: planning blocked.",
      });
      return;
    }
    const draftPlan = generateDraft({
      dateISO: selectedDateISO,
      startTime: windowStart,
      endTime: windowEnd,
      prefs,
    });

    // Detect conflicts vs. all existing tasks (any domain)
    const conflictsFound = detectConflicts({
      candidates: draftPlan,
      existing: tasks || [],
    });
    setDraft(draftPlan);
    setConflicts(conflictsFound);
    setShowConflictModal(conflictsFound.length > 0);

    recordMilestone?.({
      key: "clean_decide_for_me",
      meta: { count: draftPlan.length, conflicts: conflictsFound.length },
    });
    eventBus.emit("analytics.emit", {
      type: "decide.clean",
      payload: { count: draftPlan.length },
    });
  }, [
    selectedDateISO,
    windowStart,
    windowEnd,
    prefs,
    tasks,
    sabbathGuard,
    sabbathWindow,
    recordMilestone,
  ]);

  // Apply draft into plan (after conflicts resolved)
  const applyDraft = () => {
    setTasks?.((prev) => [...(prev || []), ...draft]);
    eventBus.emit("ui.toast", {
      variant: "success",
      message: `Scheduled ${draft.length} cleaning task(s)`,
    });
    recordMilestone?.({
      key: "clean_plan_applied",
      meta: { count: draft.length },
    });
    setDraft([]);
    setConflicts([]);
    setShowConflictModal(false);
  };

  // Quick conflict resolutions
  const shiftCandidate = (id, minutes = 10) => {
    setDraft((prev) =>
      prev.map((t) => {
        if (t.id !== id) return t;
        const iso = parseISO(t.start);
        const moved = addMinutes(iso, minutes);
        return { ...t, start: format(moved, "yyyy-MM-dd'T'HH:mm:ss") };
      })
    );
  };

  const shortenCandidate = (id, minutes = 5) => {
    setDraft((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, estMinutes: Math.max(10, (t.estMinutes || 30) - minutes) }
          : t
      )
    );
  };

  const dropCandidate = (id) => {
    setDraft((prev) => prev.filter((t) => t.id !== id));
  };

  // Recheck conflicts when draft changes
  useEffect(() => {
    if (!draft.length) {
      setConflicts([]);
      return;
    }
    const c = detectConflicts({ candidates: draft, existing: tasks || [] });
    setConflicts(c);
  }, [draft, tasks]);

  // Consolidation suggestions (batching)
  const consolidation = useMemo(
    () =>
      showConsolidation && draft.length
        ? prepConsolidationEngine.consolidate?.(draft) || []
        : [],
    [showConsolidation, draft]
  );

  // ---------------- Render ----------------
  const dayHeader = pretty(selectedDateISO);

  const zoneList = [
    "kitchen",
    "bathroom",
    "living",
    "bedrooms",
    "laundry",
    "entry",
    "office",
  ];

  return (
    <div className="w-full max-w-7xl mx-auto p-4 sm:p-6">
      {/* Header */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            Cleaning Planner
          </h1>
          <p className="text-gray-600">
            Build a realistic session plan, resolve conflicts, and batch work by
            zone.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {shortageCount > 0 ? (
            <button
              type="button"
              onClick={() => {
                eventBus.emit("ui.navigate", { panel: "SuppliesPanel" });
                eventBus.emit("ui.panel.open", { id: "SUPPLIES" });
              }}
              className="rounded-xl border px-3 py-2 text-sm bg-amber-50 border-amber-200 text-amber-900"
              title="We noticed cleaning/hygiene shortages"
            >
              {shortageCount} supply shortage{shortageCount > 1 ? "s" : ""} →
              Review
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => {
              eventBus.emit("ui.navigate", { panel: "CollectOrganize" });
              eventBus.emit("ui.panel.open", { id: "COLLECT" });
            }}
            className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
            title="Import checklists, videos, PDFs"
          >
            Import sources
          </button>

          <button
            type="button"
            onClick={handleDecide}
            className="rounded-xl border border-black bg-gray-900 text-white px-3 py-2 text-sm hover:opacity-90"
          >
            Decide for me
          </button>
        </div>
      </div>

      {/* Preferences */}
      <section className="mt-4 rounded-2xl border p-4">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Time window
            </label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="time"
                value={windowStart}
                onChange={(e) => setWindowStart(e.target.value)}
                className="rounded-xl border px-3 py-2 text-sm"
              />
              <span className="text-gray-500">to</span>
              <input
                type="time"
                value={windowEnd}
                onChange={(e) => setWindowEnd(e.target.value)}
                className="rounded-xl border px-3 py-2 text-sm"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Energy level
            </label>
            <div className="mt-1 flex gap-2">
              {["low", "medium", "high"].map((lvl) => (
                <button
                  key={lvl}
                  type="button"
                  onClick={() => setEnergy(lvl)}
                  className={[
                    "rounded-full border px-3 py-1.5 text-sm capitalize",
                    energy === lvl
                      ? "bg-gray-900 text-white border-black"
                      : "bg-white hover:bg-gray-50",
                  ].join(" ")}
                >
                  {lvl}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Residents at home
            </label>
            <div className="mt-1 flex gap-2">
              <button
                type="button"
                onClick={() => setResidentsHome(true)}
                className={[
                  "rounded-full border px-3 py-1.5 text-sm",
                  residentsHome
                    ? "bg-gray-900 text-white border-black"
                    : "bg-white hover:bg-gray-50",
                ].join(" ")}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setResidentsHome(false)}
                className={[
                  "rounded-full border px-3 py-1.5 text-sm",
                  !residentsHome
                    ? "bg-gray-900 text-white border-black"
                    : "bg-white hover:bg-gray-50",
                ].join(" ")}
              >
                No
              </button>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="md:col-span-2">
            <label className="block text-sm font-medium text-gray-700">
              Target zones
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              {zoneList.map((z) => {
                const on = zones.has(z);
                return (
                  <button
                    key={z}
                    type="button"
                    onClick={() =>
                      setZones((prev) => {
                        const n = new Set(prev);
                        if (n.has(z)) n.delete(z);
                        else n.add(z);
                        return n;
                      })
                    }
                    className={[
                      "rounded-full border px-3 py-1.5 text-sm capitalize",
                      on
                        ? "bg-gray-900 text-white border-black"
                        : "bg-white hover:bg-gray-50",
                    ].join(" ")}
                  >
                    {z}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700">
              Goals
            </label>
            <div className="mt-1 flex flex-wrap gap-2">
              {["sanitation", "tidy", "deep"].map((g) => {
                const on = goals.includes(g);
                return (
                  <button
                    key={g}
                    type="button"
                    onClick={() =>
                      setGoals((prev) =>
                        prev.includes(g)
                          ? prev.filter((x) => x !== g)
                          : [...prev, g]
                      )
                    }
                    className={[
                      "rounded-full border px-3 py-1.5 text-sm capitalize",
                      on
                        ? "bg-gray-900 text-white border-black"
                        : "bg-white hover:bg-gray-50",
                    ].join(" ")}
                  >
                    {g}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      {/* Draft & Suggestions */}
      <section className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="rounded-2xl border p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">
                {dayHeader} • Draft Cleaning Plan
              </h2>
              <div className="text-xs text-gray-500">
                {draft.length
                  ? `${draft.length} task${draft.length > 1 ? "s" : ""}`
                  : "No draft yet"}
              </div>
            </div>

            <div className="mt-3">
              {draft.length ? (
                <TaskPlanView
                  dateISO={selectedDateISO}
                  tasks={draft}
                  readOnly
                />
              ) : (
                <div className="rounded-xl border border-dashed p-8 text-center text-gray-600">
                  Click <strong>Decide for me</strong> to generate a draft plan
                  for this window.
                </div>
              )}
            </div>

            <div className="mt-3 flex items-center justify-end gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={showConsolidation}
                  onChange={(e) => setShowConsolidation(e.target.checked)}
                />
                Show consolidation suggestions
              </label>

              <button
                type="button"
                onClick={applyDraft}
                disabled={!draft.length || conflicts.length > 0}
                className={[
                  "rounded-xl border px-3 py-2 text-sm",
                  !draft.length || conflicts.length > 0
                    ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                    : "bg-gray-900 text-white border-black hover:opacity-90",
                ].join(" ")}
                title={
                  !draft.length
                    ? "No draft"
                    : conflicts.length
                    ? "Resolve conflicts first"
                    : "Apply to plan"
                }
              >
                Apply to plan
              </button>
            </div>
          </div>
        </div>

        {/* Right rail: Consolidation & Tools */}
        <aside className="space-y-4">
          <div className="rounded-2xl border p-4">
            <h3 className="font-semibold">Consolidation</h3>
            {!consolidation.length ? (
              <p className="mt-1 text-sm text-gray-600">No suggestions yet.</p>
            ) : (
              <ul className="mt-2 space-y-2">
                {consolidation.map((g) => (
                  <li key={g.key} className="rounded-xl border p-3 bg-white">
                    <div className="text-sm font-medium">{g.label}</div>
                    <div className="mt-1 text-xs text-gray-600">
                      {g.items.map((t, i) => (
                        <span key={t.id}>
                          {t.title}
                          {i < g.items.length - 1 ? ", " : ""}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-2xl border p-4">
            <h3 className="font-semibold">Helpful tools</h3>
            <div className="mt-2 grid gap-2">
              <button
                type="button"
                onClick={() => {
                  eventBus.emit("ui.navigate", { panel: "SuppliesPanel" });
                  eventBus.emit("ui.panel.open", { id: "SUPPLIES" });
                }}
                className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm text-left"
              >
                Review cleaning supplies{" "}
                {shortageCount ? `(${shortageCount})` : ""}
              </button>
              <button
                type="button"
                onClick={() => {
                  eventBus.emit("ui.navigate", { panel: "CollectOrganize" });
                  eventBus.emit("ui.panel.open", { id: "COLLECT" });
                }}
                className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm text-left"
              >
                Import checklists / PDFs / videos
              </button>
              <button
                type="button"
                onClick={() =>
                  eventBus.emit("ui.navigate", { panel: "TaskPlanView" })
                }
                className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm text-left"
              >
                Open full Task Board
              </button>
            </div>
          </div>
        </aside>
      </section>

      {/* Conflict Resolver Modal */}
      {showConflictModal ? (
        <ConflictResolverModal
          conflicts={conflicts}
          onClose={() => setShowConflictModal(false)}
          onShift={(id, mins) => shiftCandidate(id, mins)}
          onShorten={(id, mins) => shortenCandidate(id, mins)}
          onDrop={(id) => dropCandidate(id)}
          onResolved={() => {
            const still = detectConflicts({
              candidates: draft,
              existing: tasks || [],
            });
            if (still.length === 0) {
              setShowConflictModal(false);
              eventBus.emit("ui.toast", {
                variant: "success",
                message: "All conflicts resolved",
              });
            } else {
              setConflicts(still);
            }
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------- Subcomponents ----------------
function ConflictResolverModal({
  conflicts,
  onClose,
  onShift,
  onShorten,
  onDrop,
  onResolved,
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl rounded-2xl bg-white shadow-xl border"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b px-4 py-3 flex items-center justify-between">
          <h3 className="font-semibold">Resolve Conflicts</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-sm underline decoration-dotted hover:decoration-solid"
          >
            Close
          </button>
        </div>

        <div className="max-h-[60vh] overflow-auto p-4">
          {!conflicts.length ? (
            <div className="text-sm text-gray-600">No conflicts.</div>
          ) : (
            <ul className="space-y-3">
              {conflicts.map((c, idx) => (
                <li
                  key={`${c.candidate.id}-${idx}`}
                  className="rounded-xl border p-3"
                >
                  <div className="text-sm">
                    <div className="font-medium text-gray-900">
                      Draft: {c.candidate.title}
                    </div>
                    <div className="text-gray-600">
                      {format(c.candidate.start, "h:mmaaa")} –{" "}
                      {format(c.candidate.end, "h:mmaaa")}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Conflicts with{" "}
                      <span className="font-medium">{c.existing.title}</span> (
                      {format(c.existing.start, "h:mmaaa")}–
                      {format(c.existing.end, "h:mmaaa")})
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-1.5 text-sm"
                      onClick={() => {
                        onShift(c.candidate.id, 10);
                        onResolved();
                      }}
                    >
                      Shift +10m
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-1.5 text-sm"
                      onClick={() => {
                        onShift(c.candidate.id, -10);
                        onResolved();
                      }}
                    >
                      Shift −10m
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-1.5 text-sm"
                      onClick={() => {
                        onShorten(c.candidate.id, 5);
                        onResolved();
                      }}
                    >
                      Shorten −5m
                    </button>
                    <button
                      type="button"
                      className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-1.5 text-sm"
                      onClick={() => {
                        onDrop(c.candidate.id);
                        onResolved();
                      }}
                    >
                      Remove task
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t px-4 py-3 text-xs text-gray-500">
          Tip: If many conflicts remain, widen the time window or reduce
          zones/goals.
        </div>
      </div>
    </div>
  );
}

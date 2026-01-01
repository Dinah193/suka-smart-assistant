// src/components/garden/planner/ConflictResolverBar.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------ Defensive imports ------------------------------ */
let automation = null;
try {
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch (_) {}

let GardenQueueManager = null;
try {
  // @ts-ignore
  GardenQueueManager = require("@/managers/GardenQueueManager").default || null;
} catch (_) {}

let ReminderManager = null;
try {
  // @ts-ignore
  ReminderManager = require("@/managers/ReminderManager").default || null;
} catch (_) {}

let scheduleHelpers = null;
try {
  // @ts-ignore
  scheduleHelpers = require("@/engines/scheduleHelpers").default || require("@/engines/scheduleHelpers") || null;
} catch (_) {}

let useGardenStore = null;
try {
  // @ts-ignore
  useGardenStore = require("@/stores/gardenStore").useGardenStore || null;
} catch (_) {}

let useSettingsStore = null;
try {
  // @ts-ignore
  useSettingsStore = require("@/stores/settingsStore").useSettingsStore || null;
} catch (_) {}

let NBAInvokeButton = null;
try {
  // shared NBA buttons
  NBAInvokeButton =
    (require("@/components/animals/common/NBAInvokeButton.jsx").default) ||
    (require("@/components/cleaning/common/NBAInvokeButton.jsx").default) ||
    (require("@/components/meals/common/NBAInvokeButton.jsx").default) ||
    null;
} catch (_) {}

/* ------------------------------------ Utils ------------------------------------ */
const emit = (type, detail) => {
  if (automation?.emit) automation.emit(type, detail);
  window.dispatchEvent(new CustomEvent(type, { detail }));
};

const uid = () => Math.random().toString(36).slice(2, 10);

const fmtDateTime = (d) => {
  if (!d) return "—";
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(+x)) return "—";
  return x.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

const ymd = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(+x)) return "0000-00-00";
  const m = `${x.getMonth() + 1}`.padStart(2, "0");
  const day = `${x.getDate()}`.padStart(2, "0");
  return `${x.getFullYear()}-${m}-${day}`;
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/* --------------------------- Conflict evaluation core --------------------------- */
/**
 * We support a minimal, extensible set of conflict types:
 *  - "time-overlap": same bed/time window intersects another task
 *  - "frost-window": violates frost/window filter (needs after/before)
 *  - "rotation": bed history suggests avoid same family too soon
 *  - "prep-missing": task flagged requires prep but has no pre-steps
 */
function analyzeConflicts(task, ctx) {
  const conflicts = [];

  const bedId = task.bedId || task.bed || task.bedName;
  const start = new Date(task.targetDate || task.date || task.when || Date.now());
  const minutes = Number.isFinite(task.durationMin) ? task.durationMin : (task.minutes ?? 60);
  const end = new Date(start.getTime() + minutes * 60000);

  // 1) Time overlap in same bed (very simple pass)
  const sameDay = (ctx?.scheduled || []).filter(
    (t) => (t.bedId || t.bed || t.bedName) === bedId && overlaps(start, end, t)
  );
  if (sameDay.length) {
    conflicts.push({
      type: "time-overlap",
      severity: "warn",
      with: sameDay.map((t) => ({
        id: t.id,
        title: `${t.kind || t.type || "task"}: ${t.cropName || t.crop || "crop"}`,
        window: [new Date(t.targetDate || t.date || Date.now()), durationOf(t)]
      })),
      message: `Bed is busy for ${sameDay.length} other task(s) near ${fmtDateTime(start)}.`,
    });
  }

  // 2) Frost window violation (if settings present)
  const lastFrost = toDate(ctx?.settings?.garden?.frost?.last);
  if (lastFrost && task.kind !== "harvest") {
    const diffDays = Math.floor((start - lastFrost) / 86400000);
    const mode = ctx?.filters?.mode;
    if (mode === "after-last" && diffDays < (ctx?.filters?.daysA ?? 0)) {
      conflicts.push({
        type: "frost-window",
        severity: "danger",
        message: `Scheduled ${diffDays}d after last frost but requires ≥ ${ctx?.filters?.daysA ?? 0}d.`,
      });
    }
    if (mode === "before-last" && diffDays > (ctx?.filters?.daysA ?? -1)) {
      conflicts.push({
        type: "frost-window",
        severity: "danger",
        message: `Scheduled ${diffDays}d after last frost but must be ≤ ${ctx?.filters?.daysA ?? -1}d.`,
      });
    }
    if (mode === "between") {
      const a = ctx?.filters?.daysA ?? -14;
      const b = ctx?.filters?.daysB ?? 21;
      if (diffDays < a || diffDays > b) {
        conflicts.push({
          type: "frost-window",
          severity: "danger",
          message: `Needs ${a}…${b}d of last frost; currently ${diffDays}d.`,
        });
      }
    }
  }

  // 3) Rotation simple check (avoid same family if seen last season)
  const family = task.cropFamily || task.family || null;
  if (family && bedId && ctx?.bedHistory?.[bedId]?.lastFamilies?.includes(family)) {
    conflicts.push({
      type: "rotation",
      severity: "warn",
      message: `Recent ${family} family in this bed; consider another bed to avoid disease/pest buildup.`,
    });
  }

  // 4) Prep missing
  if ((task.requiresPrep || task.needsPreStep) && !task.preSteps?.length) {
    conflicts.push({
      type: "prep-missing",
      severity: "info",
      message: "Task requires pre-steps but none are attached.",
    });
  }

  return conflicts;
}

function overlaps(start, end, other) {
  const oStart = new Date(other.targetDate || other.date || other.when || Date.now());
  const oEnd = new Date(oStart.getTime() + (durationOf(other) * 60000));
  return oStart < end && oEnd > start;
}
function durationOf(t) {
  return Number.isFinite(t.durationMin) ? t.durationMin : (t.minutes ?? 60);
}
function toDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d;
  const x = new Date(d);
  return isNaN(+x) ? null : x;
}

/* ------------------------------ Suggestion engine ------------------------------ */
function buildSuggestions(task, ctx, conflicts) {
  const out = [];
  const start = new Date(task.targetDate || task.date || task.when || Date.now());
  const minutes = durationOf(task);
  const bedId = task.bedId || task.bed || task.bedName;

  // A) Reschedule: next free window (via scheduleHelpers if available)
  const nextWin =
    scheduleHelpers?.nextWindow?.({ scope: "garden", kind: task.kind, bedId, minutes, from: start }) ||
    new Date(start.getTime() + 2 * 3600 * 1000); // +2h fallback
  out.push({
    key: "resched-next",
    label: `Reschedule → ${fmtDateTime(nextWin)}`,
    detail: "Finds the next available slot.",
    apply: () => ({
      type: "planner.task.reschedule",
      payload: { id: task.id, date: nextWin }
    }),
  });

  // B) Reassign bed: propose 2 alternatives by free capacity
  const beds = (ctx?.beds || []).filter((b) => (b.id || b.name) !== bedId).slice(0, 2);
  for (const b of beds) {
    out.push({
      key: `reassign-${b.id || b.name}`,
      label: `Move to bed: ${b.name || b.id}`,
      detail: "Relieves overlap / rotation issues.",
      apply: () => ({
        type: "planner.task.reassignBed",
        payload: { id: task.id, bedId: b.id || b.name, bedName: b.name || b.id }
      }),
    });
  }

  // C) Split task (first half today, remainder tomorrow)
  if (minutes >= 40) {
    const half = Math.floor(minutes / 2);
    const tmr = new Date(start.getTime() + 24 * 3600 * 1000);
    out.push({
      key: "split-50",
      label: "Split 50/50 (today + tomorrow)",
      detail: `Break into ${half}m today, ${minutes - half}m tomorrow.`,
      apply: () => ({
        type: "planner.task.split",
        payload: {
          id: task.id,
          parts: [
            { date: start, minutes: half },
            { date: tmr, minutes: minutes - half }
          ]
        }
      }),
    });
  }

  // D) Allow overlap w/ note
  if (conflicts.some((c) => c.type === "time-overlap")) {
    out.push({
      key: "allow-overlap",
      label: "Allow overlap (add note)",
      detail: "Marks as intentional so runtime won't flag it again.",
      apply: () => ({
        type: "planner.task.annotate",
        payload: { id: task.id, note: "[override] overlap allowed" }
      }),
    });
  }

  // E) Adjust for frost window (after/before/between)
  if (conflicts.some((c) => c.type === "frost-window") && ctx?.settings?.garden?.frost?.last) {
    const last = new Date(ctx.settings.garden.frost.last);
    const A = ctx?.filters?.daysA ?? 0;
    const B = ctx?.filters?.daysB ?? A;
    const mode = ctx?.filters?.mode ?? "after-last";
    let proposed = new Date(last.getTime());
    if (mode === "after-last") proposed = new Date(last.getTime() + A * 86400000);
    if (mode === "before-last") proposed = new Date(last.getTime() + A * 86400000);
    if (mode === "between") proposed = new Date(last.getTime() + clamp(A, -90, 90) * 86400000);
    out.push({
      key: "frost-adjust",
      label: `Move to frost-safe: ${fmtDateTime(proposed)}`,
      detail: `Realigns with your frost window rule (${mode}).`,
      apply: () => ({
        type: "planner.task.reschedule",
        payload: { id: task.id, date: proposed }
      }),
    });
  }

  // F) Add pre-step timer (for soak/sterilize/tray mix)
  if ((task.requiresPrep || task.needsPreStep) && !(task.preSteps?.length)) {
    const preMins = 30;
    const preStart = new Date(start.getTime() - preMins * 60000);
    out.push({
      key: "add-pre-step",
      label: `Add pre-step: ${preMins}m before`,
      detail: "Creates a timed pre-step with countdown.",
      apply: () => ({
        type: "planner.task.addPreStep",
        payload: {
          id: task.id,
          preSteps: [{ kind: "prep", title: "Prep step", minutes: preMins, startAt: preStart }]
        }
      })
    });
  }

  // G) Rotation: suggest alternate bed tagged for rotation OK
  if (conflicts.some((c) => c.type === "rotation")) {
    const candidate = (ctx?.beds || []).find((b) => (b.tags || []).includes("rotation-ok"));
    if (candidate) {
      out.push({
        key: "rotation-bed",
        label: `Move to rotation-OK bed: ${candidate.name}`,
        detail: "Resolves recent family repetition.",
        apply: () => ({
          type: "planner.task.reassignBed",
          payload: { id: task.id, bedId: candidate.id || candidate.name, bedName: candidate.name }
        })
      });
    }
  }

  return out;
}

/* --------------------------------- UI Helpers --------------------------------- */
function SeverityBadge({ sev }) {
  const map = {
    info: "border-blue-300 text-blue-700 bg-blue-50",
    warn: "border-amber-300 text-amber-700 bg-amber-50",
    danger: "border-red-300 text-red-700 bg-red-50",
  };
  return <span className={`text-[10px] border px-2 py-0.5 rounded-full ${map[sev] || ""}`}>{sev}</span>;
}

function SuggestionButton({ sug, onApply }) {
  return (
    <button
      type="button"
      className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
      onClick={() => onApply(sug)}
      title={sug.detail}
    >
      {sug.label}
    </button>
  );
}

/* -------------------------------- Main Component ------------------------------- */
export default function ConflictResolverBar() {
  const garden = useGardenStore ? useGardenStore() : null;
  const settings = useSettingsStore ? useSettingsStore() : null;

  const [open, setOpen] = useState(false);
  const [focusTask, setFocusTask] = useState(null);   // the task being resolved
  const [conflicts, setConflicts] = useState([]);     // list of conflict entries
  const [suggestions, setSuggestions] = useState([]); // actionable fixes
  const [status, setStatus] = useState(null);

  const ctx = useMemo(() => {
    const scheduled = garden?.planner?.tasks || [];
    const beds = garden?.plots || garden?.library?.plots || [];
    const filters = garden?.decider?.filters || {};
    const bedHistory = garden?.bedHistory || {}; // e.g., { bedId: { lastFamilies: ['brassica'] } }
    return { scheduled, beds, filters, settings, bedHistory };
  }, [garden, settings]);

  // Listen for open signals
  useEffect(() => {
    const onReq = (e) => {
      const t = e.detail?.item || e.detail?.task || null;
      if (!t) return;
      const list = analyzeConflicts(t, ctx);
      setFocusTask(t);
      setConflicts(list);
      setSuggestions(buildSuggestions(t, ctx, list));
      setOpen(true);
      emit("ui.panel.opened", { id: "conflict-resolver", taskId: t.id, conflicts: list.length });
    };
    window.addEventListener("garden.decider.conflict.request", onReq);
    // Also open when a user explicitly opens a task
    window.addEventListener("garden.task.open", onReq);
    return () => {
      window.removeEventListener("garden.decider.conflict.request", onReq);
      window.removeEventListener("garden.task.open", onReq);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx]);

  // Recompute if context changes while open
  useEffect(() => {
    if (!open || !focusTask) return;
    const list = analyzeConflicts(focusTask, ctx);
    setConflicts(list);
    setSuggestions(buildSuggestions(focusTask, ctx, list));
  }, [open, focusTask, ctx]);

  const applySuggestion = (sug) => {
    const action = sug.apply?.();
    if (!action) return;

    if (GardenQueueManager?.queue) {
      GardenQueueManager.queue(action);
    } else {
      emit("planner.action.simulated", action);
    }

    // UI feedback + undo pattern
    setStatus({ id: uid(), kind: "success", message: "Applied." });
    emit("ui.toast", { kind: "success", message: "Applied change." });
    emit("ui.undo", {
      message: "Change applied.",
      actionLabel: "Undo",
      action: { type: "planner.undo", payload: { from: action } }
    });

    // Recompute conflicts after apply (optimistic)
    const list = analyzeConflicts(focusTask, ctx);
    setConflicts(list);
    setSuggestions(buildSuggestions(focusTask, ctx, list));
    if (list.length === 0) {
      // Optionally auto-close when resolved
      setTimeout(() => setOpen(false), 600);
    }
  };

  const scheduleFollowup = () => {
    if (!focusTask) return;
    const when =
      new Date((focusTask.targetDate || focusTask.date || Date.now())) ||
      new Date(Date.now() + 86400000);
    if (!ReminderManager?.schedule) {
      emit("garden.reminder.simulated", { kind: "followup", id: focusTask.id });
      setStatus({ id: uid(), kind: "info", message: "Reminder simulated (manager missing)." });
      return;
    }
    ReminderManager.schedule({
      title: `Check conflict resolutions for ${focusTask.cropName || focusTask.crop || "task"}`,
      notes: "Auto-scheduled from ConflictResolverBar",
      date: when,
      tags: ["garden", "conflict-resolver"]
    });
    setStatus({ id: uid(), kind: "success", message: "Follow-up reminder scheduled." });
  };

  const close = () => setOpen(false);

  /* ------------------------------------- UI ------------------------------------- */
  if (!open || !focusTask) return null;

  const crop = focusTask.cropName || focusTask.crop || "Unknown crop";
  const bed = focusTask.bedName || focusTask.bed || "Unassigned";
  const when = fmtDateTime(focusTask.targetDate || focusTask.date);

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40"
      role="dialog"
      aria-label="Garden Conflict Resolver"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/10"
        onClick={close}
        aria-hidden
      />

      {/* Panel */}
      <div className="relative mx-auto max-w-6xl p-3">
        <div className="rounded-2xl border bg-white shadow-xl p-4 md:p-5">
          {/* Header */}
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm text-gray-500">Resolving</div>
              <div className="text-base md:text-lg font-semibold text-gray-900">
                {focusTask.kind || focusTask.type || "task"} • {crop} <span className="text-gray-400">→</span> {bed}
              </div>
              <div className="text-xs text-gray-500">{when}</div>
            </div>

            <div className="flex items-center gap-2">
              {NBAInvokeButton ? (
                <NBAInvokeButton
                  scope="garden"
                  intent="conflict.resolver"
                  label="NBA"
                  payload={{ taskId: focusTask.id, conflicts }}
                  className="!px-3 !py-2"
                />
              ) : (
                <button
                  className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
                  onClick={() => emit("nba.requested", { scope: "garden", from: "ConflictResolverBar", taskId: focusTask.id })}
                >
                  Request NBA
                </button>
              )}
              <button
                className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={scheduleFollowup}
                title="Schedule a follow-up reminder"
              >
                Follow-up
              </button>
              <button
                className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={close}
                aria-label="Close resolver"
              >
                Close
              </button>
            </div>
          </div>

          {/* Conflicts list */}
          {conflicts.length ? (
            <div className="mb-3">
              <div className="text-sm font-medium text-gray-700 mb-1">
                {conflicts.length} issue{conflicts.length===1?"":"s"} detected
              </div>
              <ul className="space-y-2">
                {conflicts.map((c, idx) => (
                  <li key={idx} className="rounded-xl border p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <SeverityBadge sev={c.severity} />
                      <div className="text-sm font-medium text-gray-800 capitalize">
                        {c.type.replace("-", " ")}
                      </div>
                    </div>
                    <div className="text-sm text-gray-600">{c.message}</div>

                    {c.type === "time-overlap" && c.with?.length ? (
                      <div className="mt-2 text-xs text-gray-500">
                        Overlaps with:
                        <ul className="list-disc ml-5">
                          {c.with.map((w) => {
                            const wStart = w.window?.[0] instanceof Date ? w.window[0] : new Date();
                            const wMin = Number.isFinite(w.window?.[1]) ? w.window[1] : 60;
                            const wEnd = new Date(wStart.getTime() + wMin * 60000);
                            return (
                              <li key={w.id}>
                                {w.title} — {fmtDateTime(wStart)} to {fmtDateTime(wEnd)}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div className="mb-3 rounded-xl border p-3 bg-green-50 text-green-800 text-sm">
              No issues detected. You can still adjust scheduling or bed assignment below.
            </div>
          )}

          {/* Suggestions */}
          <div>
            <div className="text-sm font-medium text-gray-700 mb-2">Suggested fixes</div>
            {suggestions.length ? (
              <div className="flex flex-wrap gap-2">
                {suggestions.map((s) => (
                  <SuggestionButton key={s.key} sug={s} onApply={applySuggestion} />
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-500">No automatic fixes available. Try editing the task manually.</div>
            )}
          </div>

          {/* Status / Toast (inline) */}
          <div className="mt-3 min-h-[24px]">
            {status ? (
              <div
                className={`inline-block rounded-lg px-3 py-1.5 text-sm ${
                  status.kind === "success"
                    ? "bg-green-50 text-green-700 border border-green-200"
                    : status.kind === "error"
                    ? "bg-red-50 text-red-700 border border-red-200"
                    : "bg-gray-50 text-gray-700 border border-gray-200"
                }`}
              >
                {status.message}
              </div>
            ) : null}
          </div>

          {/* Footer helper */}
          <div className="mt-2 text-[11px] text-gray-500">
            Tip: Fixes are queued to your planner via <code>GardenQueueManager</code>. Use the global Undo to revert if needed.
          </div>
        </div>
      </div>
    </div>
  );
}

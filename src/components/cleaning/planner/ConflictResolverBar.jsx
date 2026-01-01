/* eslint-disable no-console */
// src/components/cleaning/planner/ConflictResolverBar.jsx
// Cleaning Planner — Conflict Resolver Bar
//
// Design goals (aligned with your system):
// - Detect & surface conflicts for planned cleaning sessions (time overlap, Sabbath, supplies, zone in use, cooldown, etc.)
// - Offer smart one-click resolutions: Shift, Split, Snooze, Swap, Reassign, Auto-Resolve
// - Respect Sabbath Guard + Quiet Hours + Household Calendar busy times
// - Defensive against missing services (eventBus, NBA, Reminders, Calendar, Inventory, Automation)
// - Emits events: cleaning:planner:conflict:* and returns a resolution plan via onApply callback
// - Compact, keyboard-friendly, works inside sticky planner headers
//
// Props:
//   conflicts: Array<Conflict>  (see Conflict shape below)
//   onApply?: (plan) => void    // receives a { actions: [...], meta } resolution plan
//   onIgnore?: (conflictId) => void
//   onMute?: (conflictId) => void
//   assignees?: string[]        // optional list of household members for quick reassign
//   calendarBusy?: Array<{ start: string|Date, end: string|Date, title?: string }>   // extra busy times
//   quietHours?: { start: number, end: number }  // 0-23 local hours to avoid (e.g., {start:21,end:7})
//   sabbath?: { enabled?: boolean, start?: string, end?: string } // ISO strings for next Sabbath window
//   now?: Date                  // for testing/time travel
//   className?: string
//   compact?: boolean
//
// Conflict shape:
//   {
//     id: string,
//     title: string,
//     zone?: string,
//     start?: string|Date,
//     end?: string|Date,
//     durationMin?: number,
//     priority?: number,          // higher = more important
//     assignee?: string,
//     reason: Array<"time-overlap"|"sabbath"|"supply-missing"|"zone-occupied"|"cooldown"|"energy-low"|"proofing"|"marinating"|"chill-chain">,
//     blockers?: {
//       supplies?: Array<{name:string, qty?:number, unit?:string, inventoryId?:string}>,
//       zones?: string[],
//       withTasks?: string[]      // ids/titles of overlapping tasks
//     },
//     severity?: "low"|"med"|"high"
//   }

import React, { useEffect, useMemo, useState } from "react";

/* ------------------------- helpers & services ------------------------- */
function cx(...a) {
  return a.filter(Boolean).join(" ");
}

const Svc = {
  bus: () => window?.eventBus || window?.ssa?.eventBus || null,
  nba: () => window?.ssa?.services?.nba || window?.NBAOrchestrator || null,
  reminders: () => window?.ssa?.services?.reminders || window?.ReminderManager || null,
  calendar: () => window?.ssa?.services?.calendar || null,
  inventory: () => window?.ssa?.services?.inventory || window?.InventoryManager || null,
  automation: () => window?.ssa?.services?.automation || window?.automation || null,
  toast(msg) {
    try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); }
  }
};

function toDate(x) {
  if (!x) return null;
  try { return x instanceof Date ? x : new Date(x); } catch { return null; }
}
function fmtTime(d) {
  try { return new Date(d).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return "—"; }
}
function within(d, start, end) {
  const t = +d; return t >= +start && t <= +end;
}
function overlaps(aStart, aEnd, bStart, bEnd) {
  return +aStart < +bEnd && +bStart < +aEnd;
}
function addMin(d, m) {
  const dt = new Date(d); dt.setMinutes(dt.getMinutes() + m); return dt;
}
function clampToQuietHours(dt, quiet) {
  if (!quiet) return dt;
  const h = dt.getHours();
  const { start, end } = quiet; // e.g., 21->7
  if (start < end) {
    if (h >= start && h < end) { const nd = new Date(dt); nd.setHours(end, 0, 0, 0); return nd; }
  } else {
    // wraps midnight
    if (h >= start || h < end) { const nd = new Date(dt); nd.setHours(end, 0, 0, 0); if (h >= start) nd.setDate(nd.getDate() + 1); return nd; }
  }
  return dt;
}
function avoidSabbath(dt, sabbath) {
  if (!sabbath?.enabled) return dt;
  const s = toDate(sabbath.start); const e = toDate(sabbath.end);
  if (s && e && within(dt, s, e)) {
    const nd = new Date(e); nd.setMinutes(nd.getMinutes() + 5); return nd;
  }
  return dt;
}
function nextFreeSlot({ start, durationMin, busy = [], quietHours, sabbath }) {
  if (!start) start = new Date();
  let candidate = new Date(start);
  candidate = clampToQuietHours(candidate, quietHours);
  candidate = avoidSabbath(candidate, sabbath);

  // slide until no overlap with busy set or sabbath/quiet window
  let attempts = 0;
  while (attempts++ < 500) {
    const candEnd = addMin(candidate, durationMin || 30);
    const hitBusy = busy.some((b) => overlaps(candidate, candEnd, toDate(b.start), toDate(b.end)));
    const hitSabbath = sabbath?.enabled && within(candidate, toDate(sabbath.start), toDate(sabbath.end));
    const candAfterQuiet = quietHours ? clampToQuietHours(candidate, quietHours) : candidate;
    if (!hitBusy && !hitSabbath && +candAfterQuiet === +candidate) return { start: candidate, end: candEnd };
    // otherwise push to end of the nearest blocking window
    let jumpTo = candEnd;
    busy.forEach((b) => {
      const bs = toDate(b.start), be = toDate(b.end);
      if (overlaps(candidate, candEnd, bs, be)) jumpTo = new Date(Math.max(+jumpTo, +be));
    });
    if (sabbath?.enabled) {
      const s = toDate(sabbath.start), e = toDate(sabbath.end);
      if (overlaps(candidate, candEnd, s, e)) jumpTo = new Date(Math.max(+jumpTo, +e));
    }
    candidate = clampToQuietHours(jumpTo, quietHours);
    candidate = avoidSabbath(candidate, sabbath);
  }
  const end = addMin(candidate, durationMin || 30);
  return { start: candidate, end };
}

const DUR = { "<10m": 10, "10–20m": 20, "20–40m": 40, "40–60m": 60, "60m+": 75 };

/* ------------------------------ UI bits ------------------------------ */
function Pill({ children, tone = "default" }) {
  const tones = {
    default: "border",
    warn: "border-amber-300 bg-amber-50",
    danger: "border-red-300 bg-red-50",
    ok: "border-emerald-300 bg-emerald-50"
  };
  return <span className={cx("inline-block rounded-full px-2 py-0.5 text-[11px] border", tones[tone])}>{children}</span>;
}

function Menu({ label = "Resolve", children }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={() => setOpen(o => !o)}>
        {label}
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-2 min-w-56 rounded-xl border bg-white p-2 shadow">
          <div className="max-h-80 overflow-auto">{children}</div>
          <div className="mt-2 text-right">
            <button className="text-xs text-gray-500 hover:underline" onClick={() => setOpen(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RowAction({ title, desc, onClick }) {
  return (
    <button
      type="button"
      className="w-full rounded-lg px-2 py-2 text-left hover:bg-gray-50"
      onClick={onClick}
      title={desc}
    >
      <div className="text-xs font-medium">{title}</div>
      {desc ? <div className="text-[11px] text-gray-500">{desc}</div> : null}
    </button>
  );
}

/* --------------------------- Main component -------------------------- */
export default function ConflictResolverBar({
  conflicts = [],
  onApply,
  onIgnore,
  onMute,
  assignees = [],
  calendarBusy = [],
  quietHours = { start: 21, end: 7 },
  sabbath = { enabled: false, start: null, end: null },
  now = new Date(),
  className,
  compact = false,
}) {
  const high = conflicts.filter(c => c.severity === "high").length;
  const med = conflicts.filter(c => c.severity === "med").length;
  const low = conflicts.filter(c => c.severity === "low" || !c.severity).length;

  useEffect(() => {
    if (!conflicts.length) return;
    try { Svc.bus()?.emit?.("cleaning:planner:conflict:show", { count: conflicts.length }); } catch {}
  }, [conflicts.length]);

  const busy = useMemo(() => {
    const cBusy = conflicts
      .filter(c => c.reason?.includes("time-overlap"))
      .flatMap(c => (c.blockers?.withTasks || []).map(() => ({ start: c.start, end: c.end })));
    return [...calendarBusy, ...cBusy];
  }, [calendarBusy, conflicts]);

  /* ---------------------- Resolution recipe builders ---------------------- */
  function planShift(conflict, minutes = 30) {
    const start = toDate(conflict?.start) || now;
    const slot = nextFreeSlot({
      start: addMin(start, minutes),
      durationMin: conflict.durationMin || guessDur(conflict),
      busy, quietHours, sabbath
    });
    return {
      actions: [{ type: "reschedule", id: conflict.id, start: slot.start.toISOString(), end: slot.end.toISOString() }],
      meta: { strategy: "shift", minutes, conflictId: conflict.id }
    };
  }

  function planSplit(conflict, parts = [0.5, 0.5]) {
    const total = conflict.durationMin || guessDur(conflict);
    const first = Math.max(10, Math.round(total * parts[0]));
    const second = Math.max(10, total - first);
    const start = toDate(conflict?.start) || now;
    const slot1 = nextFreeSlot({ start, durationMin: first, busy, quietHours, sabbath });
    const slot2 = nextFreeSlot({
      start: addMin(slot1.end, 60), // leave buffer
      durationMin: second, busy, quietHours, sabbath
    });
    return {
      actions: [
        { type: "split", id: conflict.id, into: 2 },
        { type: "reschedule", id: `${conflict.id}:part1`, start: slot1.start.toISOString(), end: slot1.end.toISOString() },
        { type: "reschedule", id: `${conflict.id}:part2`, start: slot2.start.toISOString(), end: slot2.end.toISOString() }
      ],
      meta: { strategy: "split", conflictId: conflict.id, parts: [first, second] }
    };
  }

  function planSnooze(conflict, minutes = 15) {
    const start = toDate(conflict?.start) || now;
    const slot = nextFreeSlot({
      start: addMin(start, minutes),
      durationMin: conflict.durationMin || guessDur(conflict),
      busy, quietHours, sabbath
    });
    return {
      actions: [{ type: "reschedule", id: conflict.id, start: slot.start.toISOString(), end: slot.end.toISOString() }],
      meta: { strategy: "snooze", minutes, conflictId: conflict.id }
    };
  }

  function planSwap(conflict, withTaskId) {
    return {
      actions: [{ type: "swap", a: conflict.id, b: withTaskId }],
      meta: { strategy: "swap", conflictId: conflict.id, withTaskId }
    };
  }

  function planReassign(conflict, toAssignee) {
    return {
      actions: [{ type: "reassign", id: conflict.id, assignee: toAssignee }],
      meta: { strategy: "reassign", conflictId: conflict.id, toAssignee }
    };
  }

  function planSupplyReserve(conflict) {
    const lines = (conflict.blockers?.supplies || []).map(s => ({
      item: s.inventoryId || s.name,
      qty: s.qty || 1,
      unit: s.unit || ""
    }));
    return {
      actions: [{ type: "inventory.reserve", id: conflict.id, lines }],
      meta: { strategy: "reserve-supplies", conflictId: conflict.id }
    };
  }

  function planAuto(conflict) {
    // priority: sabbath → shift past sabbath; supply missing → reserve; time overlap → next free; zone occupied → split
    if (conflict.reason?.includes("sabbath")) return planShift(conflict, 60);
    if (conflict.reason?.includes("supply-missing")) return planSupplyReserve(conflict);
    if (conflict.reason?.includes("zone-occupied")) return planSplit(conflict);
    if (conflict.reason?.includes("time-overlap")) return planShift(conflict, 30);
    if (conflict.reason?.includes("cooldown")) return planSnooze(conflict, 90);
    if (conflict.reason?.includes("proofing") || conflict.reason?.includes("marinating")) return planSnooze(conflict, 30);
    return planShift(conflict, 20);
  }

  function guessDur(c) {
    if (typeof c.durationMin === "number") return c.durationMin;
    if (typeof c.duration === "string" && DUR[c.duration]) return DUR[c.duration];
    return 30;
  }

  /* -------------------------- side-effects glue -------------------------- */
  function dispatchPlan(plan) {
    // Try to execute or forward the plan defensively
    try { Svc.bus()?.emit?.("cleaning:planner:conflict:resolve", plan); } catch {}
    try { Svc.nba()?.suggest?.("cleaning.conflict.resolve", plan); } catch {}
    try {
      // Patch common actions
      plan.actions?.forEach(a => {
        if (a.type === "reschedule") {
          Svc.reminders()?.schedule?.({
            title: "Adjusted: Cleaning Task",
            when: a.start,
            notes: `Auto-resolved conflict • Ends ${fmtTime(a.end)}`
          });
        }
        if (a.type === "inventory.reserve") {
          Svc.inventory()?.reserveBatch?.(a.lines) || Svc.inventory()?.reserve?.({ lines: a.lines });
        }
      });
    } catch {}
    onApply?.(plan);
    Svc.toast("Applied resolution");
  }

  /* ------------------------------- UI render ------------------------------ */
  if (!conflicts.length) return null;

  return (
    <div
      className={cx(
        "rounded-2xl border p-3 shadow-sm bg-white",
        compact ? "text-xs" : "text-sm",
        className
      )}
      role="region"
      aria-label="Conflict Resolver"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-semibold">Planner Conflicts</span>
          <Pill tone={high ? "danger" : "default"}>{high} high</Pill>
          <Pill tone={med ? "warn" : "default"}>{med} med</Pill>
          <Pill>{low} low</Pill>
          <span className="truncate text-gray-600">
            {conflicts.length} total • Quiet {quietHours.start}:00 → {quietHours.end}:00
            {sabbath?.enabled && sabbath.start && sabbath.end
              ? ` • Sabbath ${fmtTime(sabbath.start)} → ${fmtTime(sabbath.end)}`
              : ""}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-lg bg-black px-3 py-2 text-xs text-white hover:opacity-90"
            onClick={() => {
              // Auto resolve *all* by severity order
              const plan = {
                actions: [],
                meta: { strategy: "auto-batch", count: conflicts.length }
              };
              conflicts
                .slice()
                .sort((a, b) => (sevRank(b.severity) - sevRank(a.severity)))
                .forEach(c => { plan.actions.push(...planAuto(c).actions); });
              dispatchPlan(plan);
            }}
            title="Let the assistant choose fixes for all conflicts"
          >
            Auto-Resolve All
          </button>

          <Menu label="Bulk">
            <RowAction
              title="Snooze 15m"
              desc="Push all conflicted tasks by 15 minutes"
              onClick={() => dispatchPlan({
                actions: conflicts.map(c => planSnooze(c, 15).actions[0]),
                meta: { strategy: "bulk-snooze-15", count: conflicts.length }
              })}
            />
            <RowAction
              title="Shift to next free slot"
              desc="Move all to the next available window"
              onClick={() => dispatchPlan({
                actions: conflicts.map(c => planShift(c, 30).actions[0]),
                meta: { strategy: "bulk-shift", count: conflicts.length }
              })}
            />
            <RowAction
              title="Split long tasks"
              desc="Break tasks ≥ 60m into two sessions today + later"
              onClick={() => dispatchPlan({
                actions: conflicts.flatMap(c => (guessDur(c) >= 60 ? planSplit(c).actions : planSnooze(c, 10).actions)),
                meta: { strategy: "bulk-split-or-snooze", count: conflicts.length }
              })}
            />
          </Menu>
        </div>
      </div>

      {/* List */}
      <div className="mt-3 grid gap-2">
        {conflicts.map((c) => {
          const start = toDate(c.start) || now;
          const end = toDate(c.end) || addMin(start, c.durationMin || guessDur(c));
          const tone = c.severity === "high" ? "danger" : c.severity === "med" ? "warn" : "default";
          return (
            <div key={c.id} className="rounded-xl border p-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{c.title || "Task"}</span>
                    {c.zone ? <Pill>{c.zone}</Pill> : null}
                    <Pill tone={tone}>{c.severity || "low"}</Pill>
                    {c.reason?.map((r) => <Pill key={r}>{prettyReason(r)}</Pill>)}
                  </div>
                  <div className="text-[11px] text-gray-600">
                    {fmtTime(start)}–{fmtTime(end)} • {c.assignee ? `Assignee: ${c.assignee}` : "Unassigned"}
                  </div>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Menu label="Resolve">
                    <RowAction
                      title="Shift 30m"
                      desc="Move to the next gap after 30 minutes"
                      onClick={() => dispatchPlan(planShift(c, 30))}
                    />
                    <RowAction
                      title="Snooze 15m"
                      desc="Delay slightly to clear overlap"
                      onClick={() => dispatchPlan(planSnooze(c, 15))}
                    />
                    <RowAction
                      title="Split in two"
                      desc="Break into two sessions with buffer"
                      onClick={() => dispatchPlan(planSplit(c))}
                    />
                    {c.blockers?.withTasks?.length ? (
                      <div className="px-2 pt-1 pb-2 text-[11px] text-gray-500">Swap with…</div>
                    ) : null}
                    {c.blockers?.withTasks?.map((tId) => (
                      <RowAction
                        key={tId}
                        title={`Swap with ${String(tId).slice(0, 18)}…`}
                        onClick={() => dispatchPlan(planSwap(c, tId))}
                      />
                    ))}
                    {!!assignees.length && (
                      <>
                        <div className="px-2 pt-1 pb-2 text-[11px] text-gray-500">Reassign to…</div>
                        {assignees.map((a) => (
                          <RowAction key={a} title={a} onClick={() => dispatchPlan(planReassign(c, a))} />
                        ))}
                      </>
                    )}
                    {c.reason?.includes("supply-missing") ? (
                      <RowAction
                        title="Reserve missing supplies"
                        desc="Create an inventory reservation for required items"
                        onClick={() => dispatchPlan(planSupplyReserve(c))}
                      />
                    ) : null}
                    <RowAction
                      title="Auto-resolve"
                      desc="Let the assistant choose the best fix"
                      onClick={() => dispatchPlan(planAuto(c))}
                    />
                  </Menu>

                  <button
                    type="button"
                    className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
                    onClick={() => { onIgnore?.(c.id); Svc.bus()?.emit?.("cleaning:planner:conflict:ignore", { id: c.id }); }}
                  >
                    Ignore
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
                    onClick={() => { onMute?.(c.id); Svc.bus()?.emit?.("cleaning:planner:conflict:mute", { id: c.id }); }}
                  >
                    Mute
                  </button>
                </div>
              </div>

              {c.blockers?.supplies?.length ? (
                <div className="mt-2 text-[11px] text-gray-700">
                  Missing: {c.blockers.supplies.map(s => s.name).join(", ")}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Footer tip */}
      <div className="mt-2 text-[11px] text-gray-500">
        Tip: Auto-Resolve respects Sabbath & quiet hours. Use Split for high-effort tasks to keep momentum without burnout.
      </div>
    </div>
  );
}

/* ------------------------------- utils -------------------------------- */
function sevRank(s) { return s === "high" ? 3 : s === "med" ? 2 : 1; }
function prettyReason(r) {
  switch (r) {
    case "time-overlap": return "Time overlap";
    case "sabbath": return "Sabbath guard";
    case "supply-missing": return "Supply missing";
    case "zone-occupied": return "Zone busy";
    case "cooldown": return "Cooldown";
    case "energy-low": return "Energy low";
    case "proofing": return "Proofing in progress";
    case "marinating": return "Marinating in progress";
    case "chill-chain": return "Cold chain";
    default: return r;
  }
}

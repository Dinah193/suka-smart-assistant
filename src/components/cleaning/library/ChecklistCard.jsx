/* eslint-disable no-console */
// src/components/cleaning/library/ChecklistCard.jsx
// Cleaning Library → Checklist Card
//
// Built for Suka Smart Assistant goals:
// - Reusable card for cleaning routines/checklists (zone/frequency/intensity/duration/PPE)
// - Progress tracking with partial completion + optimistic UI
// - Supplies section with (defensive) Inventory sync + "Build Prep Kit"
// - Quick actions: Start, Queue, Schedule, Print, Export, Duplicate, Edit
// - Badges for risks/needs (MoistureRisk, FoodPrepSafe, Biohazard, PPE)
// - Defensive against missing global services (eventBus, NBA, automation, reminders, inventory)
// - Compact mode and accessible controls
//
// Props:
//   checklist: {
//     id, title, zone, frequency, intensity, duration, estMinutes, version,
//     tags?: string[], badges?: string[],
//     supplies?: Array<{name:string, qty?:string, unit?:string, inventoryId?:string}>,
//     items: Array<{ id:string, label:string, hint?:string, est?:number, done?:boolean, ppe?:string[] }>
//     lastDoneAt?: number|Date,
//     notes?: string
//   }
//   progress?: { [itemId]: boolean }        // optional external progress map
//   onProgressChange?: (nextProgress) => void
//   onStart?: (checklist) => void
//   onQueue?: (checklist) => void
//   onSchedule?: (checklist) => void
//   onEdit?: (checklist) => void
//   onDuplicate?: (checklist) => void
//   onExport?: (checklist) => void
//   onPrint?: (checklist) => void
//   onArchive?: (checklist) => void
//   compact?: boolean
//   className?: string
//
// Notes:
// - Emits eventBus events: cleaning:library:start | queue | schedule | progress:update
// - If present, calls window.ssa.services.reminders.schedule(...) on Schedule
// - If present, calls window.ssa.services.inventory.reserve() from Supplies "Reserve" action
// - If present, calls NBA suggest on Start

import React, { useEffect, useMemo, useState } from "react";

/** classNames helper */
function cx(...a) {
  return a.filter(Boolean).join(" ");
}

/** Safe services access */
const Svc = {
  bus: () => window?.eventBus || window?.ssa?.eventBus || null,
  nba: () => window?.ssa?.services?.nba || window?.NBAOrchestrator || null,
  reminders: () => window?.ssa?.services?.reminders || window?.ReminderManager || null,
  automation: () => window?.ssa?.services?.automation || window?.automation || null,
  inventory: () => window?.ssa?.services?.inventory || window?.InventoryManager || null,
  toast(msg) {
    try {
      window?.ssa?.ui?.toast?.(msg);
    } catch {
      console.log("[toast]", msg);
    }
  },
  track(ev, data) {
    try {
      window?.ssa?.analytics?.track?.(ev, data);
    } catch {}
  },
};

/** Format helpers */
function fmtDate(d) {
  try {
    const dt = typeof d === "number" ? new Date(d) : d ? new Date(d) : null;
    if (!dt || isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}
const DUR_MAP = { "<10m": 10, "10–20m": 20, "20–40m": 40, "40–60m": 60, "60m+": 75 };
function estFromLabel(label, fallback = 30) {
  return DUR_MAP[label] || fallback;
}

/** Badge pill */
function Pill({ children }) {
  return <span className="inline-block rounded-full border px-2 py-0.5 text-[11px]">{children}</span>;
}

/** Progress bar */
function Progress({ value = 0 }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
      <div
        className="h-full rounded-full bg-black transition-all"
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

/** Collapsible section */
function Disclosure({ title, defaultOpen = false, children, right }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="rounded-xl border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="text-sm font-medium">{title}</span>
        <div className="flex items-center gap-3">
          {right}
          <span className="text-xs text-gray-500">{open ? "Hide" : "Show"}</span>
        </div>
      </button>
      {open && <div className="border-t p-3">{children}</div>}
    </div>
  );
}

/** Checklist item row */
function ItemRow({ item, checked, onToggle, compact }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-gray-50">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-black"
        checked={!!checked}
        onChange={(e) => onToggle?.(item.id, e.target.checked)}
      />
      <div className="flex-1">
        <div className="text-sm">{item.label}</div>
        {item.hint && <div className="text-xs text-gray-500">{item.hint}</div>}
        {!compact && item.ppe?.length ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {item.ppe.map((p) => (
              <Pill key={p}>{p}</Pill>
            ))}
          </div>
        ) : null}
      </div>
      {!compact && typeof item.est === "number" && (
        <div className="ml-2 shrink-0 text-xs text-gray-500">{item.est}m</div>
      )}
    </label>
  );
}

/** Supplies list with defensive Inventory hooks */
function Supplies({ list = [], onReserve, onKit }) {
  if (!list.length) return <div className="text-xs text-gray-500">No supplies listed.</div>;
  return (
    <div className="flex flex-col gap-2">
      <ul className="space-y-1">
        {list.map((s, idx) => (
          <li key={`${s.name}-${idx}`} className="flex items-center justify-between gap-2">
            <div className="text-sm">
              {s.name}
              {s.qty ? (
                <span className="text-gray-500"> — {s.qty}{s.unit ? ` ${s.unit}` : ""}</span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="rounded border px-2 py-1 text-xs hover:bg-gray-50"
                onClick={() => onReserve?.(s)}
                title="Reserve from inventory"
              >
                Reserve
              </button>
              <a
                href={s.inventoryId ? `#/inventory/item/${s.inventoryId}` : "#"}
                className={cx(
                  "rounded border px-2 py-1 text-xs",
                  s.inventoryId ? "hover:bg-gray-50" : "pointer-events-none opacity-50"
                )}
                onClick={(e) => {
                  if (!s.inventoryId) e.preventDefault();
                }}
                title={s.inventoryId ? "Open inventory item" : "No linked inventory"}
              >
                View
              </a>
            </div>
          </li>
        ))}
      </ul>
      <div className="pt-1">
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
          onClick={onKit}
          title="Create a prep kit with these supplies"
        >
          Build Prep Kit
        </button>
      </div>
    </div>
  );
}

export default function ChecklistCard({
  checklist,
  progress,
  onProgressChange,
  onStart,
  onQueue,
  onSchedule,
  onEdit,
  onDuplicate,
  onExport,
  onPrint,
  onArchive,
  compact = false,
  className,
}) {
  const {
    id,
    title,
    zone,
    frequency,
    intensity,
    duration,
    estMinutes,
    version,
    badges = [],
    tags = [],
    supplies = [],
    items = [],
    lastDoneAt,
    notes,
  } = checklist || {};

  // Internal optimistic progress (merged with external)
  const [local, setLocal] = useState(() => {
    const init = {};
    (items || []).forEach((i) => (init[i.id] = !!i.done));
    return init;
  });
  const merged = useMemo(() => ({ ...local, ...(progress || {}) }), [local, progress]);

  const total = items?.length || 0;
  const doneCount = useMemo(
    () => Object.values(merged).filter(Boolean).length,
    [merged]
  );
  const pct = total ? Math.round((doneCount / total) * 100) : 0;

  useEffect(() => {
    onProgressChange?.(merged);
    try {
      Svc.bus()?.emit?.("cleaning:library:progress:update", { id, progress: merged });
      Svc.track("cleaning:library:progress:update", { id, pct });
    } catch {}
  }, [merged, id, pct, onProgressChange]);

  const est = typeof estMinutes === "number" ? estMinutes : estFromLabel(duration);

  function toggleItem(itemId, checked) {
    setLocal((p) => ({ ...p, [itemId]: !!checked }));
  }

  // Actions (defensive glue)
  function doStart() {
    onStart?.(checklist);
    try {
      Svc.bus()?.emit?.("cleaning:library:start", { checklist });
      Svc.nba()?.suggest?.("cleaning.session.start", { checklist });
      Svc.track("cleaning:library:start", { id });
      Svc.toast("Started checklist");
    } catch {}
  }
  function doQueue() {
    onQueue?.(checklist);
    try {
      Svc.bus()?.emit?.("cleaning:library:queue", { checklist });
      Svc.track("cleaning:library:queue", { id });
      Svc.toast("Added to queue");
    } catch {}
  }
  function doSchedule() {
    onSchedule?.(checklist);
    try {
      const when = suggestWhen(frequency);
      Svc.reminders()?.schedule?.({
        title: `Clean: ${title}`,
        notes: `Zone ${zone} • ${intensity} • ${duration}`,
        when,
        metadata: { kind: "cleaning", zone, frequency, estMinutes: est },
      });
      Svc.bus()?.emit?.("cleaning:library:schedule", { checklist, when });
      Svc.track("cleaning:library:schedule", { id, when });
      Svc.toast("Scheduled with reminder");
    } catch {}
  }
  function doExport() {
    onExport?.(checklist);
    Svc.track("cleaning:library:export", { id });
  }
  function doPrint() {
    if (onPrint) onPrint(checklist);
    else window?.print?.();
    Svc.track("cleaning:library:print", { id });
  }
  function doDuplicate() {
    onDuplicate?.(checklist);
    Svc.track("cleaning:library:duplicate", { id });
  }
  function doEdit() {
    onEdit?.(checklist);
  }
  function doArchive() {
    onArchive?.(checklist);
    Svc.track("cleaning:library:archive", { id });
  }

  // Supplies glue
  function reserveSupply(s) {
    try {
      Svc.inventory()?.reserve?.({ item: s.inventoryId || s.name, qty: s.qty || 1, unit: s.unit });
      Svc.toast(`Reserved ${s.name}`);
    } catch {
      Svc.toast("Inventory not connected");
    }
  }
  function buildKit() {
    try {
      Svc.inventory()?.createKit?.({
        name: `Prep Kit — ${title}`,
        lines: supplies.map((s) => ({
          item: s.inventoryId || s.name,
          qty: s.qty || 1,
          unit: s.unit || "",
        })),
      });
      Svc.toast("Prep Kit created");
    } catch {
      Svc.toast("Inventory not connected");
    }
  }

  return (
    <div className={cx("rounded-2xl border bg-white p-4 shadow-sm", className)}>
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold" title={title || "Checklist"}>
            {title || "Checklist"}
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
            {zone && <Pill>{zone}</Pill>}
            {frequency && <Pill>{frequency}</Pill>}
            {intensity && <Pill>{intensity}</Pill>}
            {duration && <Pill>{duration}</Pill>}
            {version && <Pill>v{version}</Pill>}
            {badges?.map((b) => (
              <Pill key={b}>{b}</Pill>
            ))}
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <button className="rounded-lg bg-black px-3 py-2 text-xs text-white hover:opacity-90" onClick={doStart}>
            Start
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={doQueue}>
            Queue
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={doSchedule}>
            Schedule
          </button>
          <div className="h-5 w-px bg-gray-200" />
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={doPrint}>
            Print
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={doExport}>
            Export
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={doDuplicate}>
            Duplicate
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={doEdit}>
            Edit
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs text-red-600 hover:bg-red-50" onClick={doArchive}>
            Archive
          </button>
        </div>
      </div>

      {/* Meta row */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-600">
        <span title="Estimated time">
          Est: <strong>{est}m</strong>
        </span>
        <span>•</span>
        <span>
          Last done: <strong>{fmtDate(lastDoneAt)}</strong>
        </span>
        {!!tags?.length && (
          <>
            <span>•</span>
            <div className="flex flex-wrap items-center gap-1">
              {tags.map((t) => (
                <Pill key={t}>#{t}</Pill>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Progress */}
      <div className="mt-3">
        <Progress value={pct} />
        <div className="mt-1 text-right text-[11px] text-gray-500">{doneCount}/{total} complete</div>
      </div>

      {/* Items */}
      <div className={cx("mt-3 grid gap-1", compact ? "grid-cols-1" : "grid-cols-1")}>
        {(items || []).map((it) => (
          <ItemRow
            key={it.id}
            item={it}
            checked={!!merged[it.id]}
            onToggle={toggleItem}
            compact={compact}
          />
        ))}
      </div>

      {/* Supplies */}
      <div className="mt-4">
        <Disclosure
          title="Supplies"
          defaultOpen={!compact}
          right={<span className="text-xs text-gray-500">{supplies?.length || 0} items</span>}
        >
          <Supplies list={supplies} onReserve={reserveSupply} onKit={buildKit} />
        </Disclosure>
      </div>

      {/* Notes */}
      {notes ? (
        <div className="mt-3 rounded-xl border bg-gray-50 p-3 text-xs text-gray-700">
          {notes}
        </div>
      ) : null}
    </div>
  );
}

/** Heuristic scheduler for frequency strings */
function suggestWhen(frequency) {
  try {
    const now = new Date();
    const d = new Date(now);
    const f = String(frequency || "").toLowerCase();
    if (f.includes("daily")) {
      d.setDate(now.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    } else if (f.includes("weekly")) {
      d.setDate(now.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    } else if (/(biweekly|monthly|quarterly|seasonal|annual)/i.test(f)) {
      // next Saturday 10am
      const day = now.getDay(); // 0=Sun
      const toSat = (6 - day + 7) % 7 || 7;
      d.setDate(now.getDate() + toSat);
      d.setHours(10, 0, 0, 0);
    } else {
      d.setHours(18, 0, 0, 0); // this evening
    }
    return d.toISOString();
  } catch {
    return new Date(Date.now() + 3600_000).toISOString();
  }
}

/* eslint-disable no-console */
// library/ProcedureCard.jsx
//
// Procedure Card (Library)
// - Designed for animal care procedures: deworming, vaccination, butchery batches, cleaning routines, etc.
// - Inspired by high-signal cards (Notion, Linear, GitHub PR list) for scan-ability + quick actions.
//
// Goals
// - Compact, readable, keyboard-friendly, and works without external UI libs (Tailwind only)
// - Defensive integrations (eventBus, analytics, reminders) — operate even if absent
// - Clear display of kind/action, duration, supplies, tags, steps, and source attribution
// - Optimistic quick actions: Open, Queue, Schedule, Edit, Duplicate, Version
// - Optional “next due” signal if recurrence and lastPerformedAt are provided
//
// Props
// - item: Procedure
// - compact?: boolean
// - onOpen?: (item) => void
// - onEdit?: (item) => void
// - onDuplicate?: (item) => void
// - onQueue?: (items: Procedure[]|Procedure) => void
// - onSchedule?: (items: Procedure[]|Procedure) => void
// - onVersion?: (item, { action: "new"|"upgrade"|"downgrade" }) => void
// - onDelete?: (item) => void
// - onShare?: (item) => void
// - className?: string
//
// Procedure (suggested)
// {
//   id: string,
//   title: string,
//   description?: string,
//   images?: string[],
//   kind?: "Poultry"|"Sheep"|"Goat"|"Beef"|"Rabbit"|"Fish",
//   action?: "Feed"|"Water"|"Deworm"|"Vaccinate"|"Clean"|"Inspect"|"Butcher"|"Package",
//   tags?: string[],
//   supplies?: Array<{name:string, qty?:number, unit?:string, inventoryId?:string}>,
//   durationMin?: number,
//   steps?: string[],
//   url?: string,                          // source url or canonical link
//   source?: { site?: string, author?: string, publishedAt?: string|null },
//   version?: { current?: string, parentId?: string|null, notes?: string },
//   lastPerformedAt?: string|null,         // ISO
//   recurrence?: { every?: string },       // e.g. "90d", "6m", "1y"
//   createdAt?: number, updatedAt?: number
// }

import React, { useMemo } from "react";

function cx(...a){ return a.filter(Boolean).join(" "); }
const KIND_COLORS = {
  Poultry: "border-amber-300 text-amber-700",
  Sheep: "border-emerald-300 text-emerald-700",
  Goat: "border-lime-300 text-lime-700",
  Beef: "border-red-300 text-red-700",
  Rabbit: "border-rose-300 text-rose-700",
  Fish: "border-sky-300 text-sky-700",
};
const ACTION_COLORS = {
  Deworm: "border-purple-300 text-purple-700",
  Vaccinate: "border-indigo-300 text-indigo-700",
  Butcher: "border-stone-300 text-stone-700",
  Package: "border-slate-300 text-slate-700",
  Clean: "border-teal-300 text-teal-700",
  Inspect: "border-gray-300 text-gray-700",
  Feed: "border-yellow-300 text-yellow-700",
  Water: "border-blue-300 text-blue-700",
};

function getServices() {
  return {
    bus: () => (window?.eventBus || window?.ssa?.eventBus || null),
    analytics: () => (window?.ssa?.analytics || null),
    reminders: () => (window?.ssa?.services?.reminders || window?.ReminderManager || null),
    toast(msg){ try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); } }
  };
}

/* ------------------------------ format helpers ------------------------------ */
function Badge({ children, toneClasses="border-gray-300 text-gray-700", title }) {
  return (
    <span title={title} className={cx("inline-block rounded-full border px-2 py-0.5 text-[11px]", toneClasses)}>
      {children}
    </span>
  );
}
function IconButton({ title, onClick, children, disabled }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      className={cx(
        "rounded-lg border px-2 py-1 text-xs hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
function fmtDuration(n){
  if (typeof n !== "number" || isNaN(n)) return "—";
  return `${n} min`;
}
function fmtDate(iso){
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"})}`;
  } catch { return "—"; }
}
function suppliesSummary(supplies){
  if (!Array.isArray(supplies) || supplies.length===0) return "";
  return supplies
    .map(s => (typeof s === "string" ? s : `${s.name}${s.qty ? ` ${s.qty}` : ""}${s.unit ? ` ${s.unit}` : ""}`))
    .join(", ");
}
function parseEvery(everyStr){
  // "90d", "6m", "1y"
  if (!everyStr) return null;
  const m = String(everyStr).match(/^(\d+)\s*([dmy])$/i);
  if (!m) return null;
  const count = Number(m[1]); const unit = m[2].toLowerCase();
  const msPerDay = 24*60*60*1000;
  if (unit === "d") return count*msPerDay;
  if (unit === "m") return Math.round(count*30.4375)*msPerDay; // approx
  if (unit === "y") return Math.round(count*365.25)*msPerDay; // approx
  return null;
}
function computeNextDue(lastISO, everyStr){
  const delta = parseEvery(everyStr);
  if (!delta) return null;
  try{
    const last = lastISO ? new Date(lastISO).getTime() : Date.now();
    const next = new Date(last + delta);
    return next;
  }catch{ return null; }
}

/* ---------------------------------- card ---------------------------------- */
export default function ProcedureCard({
  item,
  compact = false,
  onOpen,
  onEdit,
  onDuplicate,
  onQueue,
  onSchedule,
  onVersion,
  onDelete,
  onShare,
  className
}) {
  const Services = useMemo(()=>getServices(),[]);

  const {
    id,
    title,
    description,
    images = [],
    kind,
    action,
    tags = [],
    supplies = [],
    durationMin,
    steps = [],
    url,
    source,
    version,
    lastPerformedAt,
    recurrence,
    updatedAt
  } = item || {};

  const toneKind = KIND_COLORS[kind] || "border-gray-300 text-gray-700";
  const toneAction = ACTION_COLORS[action] || "border-gray-300 text-gray-700";
  const cover = images?.[0];

  const nextDue = computeNextDue(lastPerformedAt || null, recurrence?.every || null);
  const dueBadge = nextDue
    ? <Badge toneClasses="border-emerald-300 text-emerald-700" title={`Next due ${nextDue.toLocaleDateString()}`}>Next due: {nextDue.toLocaleDateString()}</Badge>
    : null;

  const handleOpen = () => {
    if (onOpen) return onOpen(item);
    if (url) window.open(url, "_blank", "noreferrer");
  };
  const handleQueue = () => {
    onQueue?.(item);
    Services.bus()?.emit?.("animals:library:procedure:queue", { id });
    Services.analytics()?.track?.("animals:library:procedure:queue", { id });
    Services.toast?.("Queued");
  };
  const handleSchedule = () => {
    onSchedule?.(item);
    try {
      // Schedule for tomorrow 9am as a sane default
      const d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0);
      Services.reminders()?.schedule?.({
        title: `Animals: ${action || "Task"} ${kind || ""}`.trim(),
        notes: title,
        when: d.toISOString(),
        metadata: { id, url, kind, action }
      });
    } catch {}
    Services.bus()?.emit?.("animals:library:procedure:schedule", { id });
    Services.analytics()?.track?.("animals:library:procedure:schedule", { id });
    Services.toast?.("Scheduled");
  };
  const handleEdit = () => {
    onEdit?.(item);
    Services.bus()?.emit?.("animals:library:procedure:edit", { id });
  };
  const handleDuplicate = () => {
    onDuplicate?.(item);
    Services.bus()?.emit?.("animals:library:procedure:duplicate", { id });
    Services.analytics()?.track?.("animals:library:procedure:duplicate", { id });
    Services.toast?.("Duplicated");
  };
  const handleVersion = (type) => {
    onVersion?.(item, { action: type });
    Services.bus()?.emit?.("animals:library:procedure:version", { id, type });
    Services.analytics()?.track?.("animals:library:procedure:version", { id, type });
  };
  const handleDelete = () => {
    const ok = window.confirm("Delete this procedure? This cannot be undone.");
    if (!ok) return;
    onDelete?.(item);
    Services.bus()?.emit?.("animals:library:procedure:delete", { id });
    Services.analytics()?.track?.("animals:library:procedure:delete", { id });
    Services.toast?.("Deleted");
  };
  const handleShare = () => {
    onShare?.(item);
    try {
      const shareUrl = url || (typeof window !== "undefined" ? window.location.href : "");
      navigator?.clipboard?.writeText?.(shareUrl);
      Services.toast?.("Link copied");
    } catch {}
    Services.bus()?.emit?.("animals:library:procedure:share", { id });
    Services.analytics()?.track?.("animals:library:procedure:share", { id });
  };

  return (
    <div className={cx("group relative grid gap-3 rounded-2xl border bg-white p-3 shadow-sm", className)}>
      {/* Header Row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className="cursor-pointer truncate text-sm font-semibold hover:underline"
            title={title}
            onClick={handleOpen}
          >
            {title || "Untitled Procedure"}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
            {kind ? <Badge toneClasses={toneKind}>{kind}</Badge> : null}
            {action ? <Badge toneClasses={toneAction}>{action}</Badge> : null}
            {typeof durationMin === "number" ? <Badge toneClasses="border-amber-300 text-amber-700">{fmtDuration(durationMin)}</Badge> : null}
            {!!steps.length ? <Badge toneClasses="border-gray-300 text-gray-700">{steps.length} step{steps.length===1?"":"s"}</Badge> : null}
            {source?.site ? <Badge>{source.site}</Badge> : null}
            {version?.current ? <Badge toneClasses="border-violet-300 text-violet-700">v{version.current}</Badge> : null}
            {dueBadge}
          </div>
        </div>

        {/* Cover (optional) */}
        {cover ? (
          <button
            type="button"
            className="h-16 w-24 overflow-hidden rounded-xl border"
            onClick={handleOpen}
            title="Open"
          >
            <img src={cover} alt="" className="h-full w-full object-cover" />
          </button>
        ) : null}
      </div>

      {/* Body */}
      {!compact && (
        <>
          <div className="text-xs text-gray-700 line-clamp-3">{description || "—"}</div>

          {(tags.length || supplies.length) ? (
            <div className="flex flex-wrap items-start gap-4 text-[11px]">
              {tags.length ? (
                <div className="flex flex-wrap gap-1">
                  {tags.slice(0, 8).map((t) => (
                    <span key={t} className="rounded-full bg-gray-100 px-2 py-0.5">#{t}</span>
                  ))}
                  {tags.length > 8 ? <span className="text-gray-500">+{tags.length - 8}</span> : null}
                </div>
              ) : null}
              {supplies.length ? (
                <div className="min-w-0 flex-1 truncate">
                  <span className="font-medium">Supplies:</span>{" "}
                  <span title={suppliesSummary(supplies)} className="truncate align-middle inline-block max-w-full">
                    {suppliesSummary(supplies)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* Source line */}
          {(source?.author || source?.publishedAt) ? (
            <div className="text-[11px] text-gray-500">
              {source?.author ? `By ${source.author}` : ""}{source?.author && source?.publishedAt ? " • " : ""}
              {source?.publishedAt ? `Published ${fmtDate(source.publishedAt)}` : ""}
            </div>
          ) : null}
        </>
      )}

      {/* Footer actions */}
      <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <IconButton title="Open" onClick={handleOpen}>Open</IconButton>
          <IconButton title="Queue" onClick={handleQueue}>Queue</IconButton>
          <IconButton title="Schedule" onClick={handleSchedule}>Schedule</IconButton>
          <IconButton title="Edit" onClick={handleEdit}>Edit</IconButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <IconButton title="Duplicate" onClick={handleDuplicate}>Duplicate</IconButton>
          <IconButton title="New version" onClick={()=>handleVersion("new")}>New ver.</IconButton>
          <IconButton title="Share link" onClick={handleShare}>Share</IconButton>
          <IconButton title="Delete" onClick={handleDelete}>Delete</IconButton>
        </div>
      </div>

      {/* Meta strip */}
      <div className="flex items-center justify-between text-[11px] text-gray-500">
        <div className="flex items-center gap-2">
          {updatedAt ? <span>Updated {new Date(updatedAt).toLocaleDateString()}</span> : null}
          {lastPerformedAt ? <span>Last done {fmtDate(lastPerformedAt)}</span> : null}
          {recurrence?.every ? <span>Every {recurrence.every}</span> : null}
        </div>
        {url ? (
          <a className="truncate text-gray-500 underline decoration-dotted underline-offset-2 hover:text-gray-700" href={url} target="_blank" rel="noreferrer">
            Source
          </a>
        ) : null}
      </div>
    </div>
  );
}

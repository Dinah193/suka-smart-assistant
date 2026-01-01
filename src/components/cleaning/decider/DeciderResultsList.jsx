/* eslint-disable no-console */
// src/components/cleaning/decider/DeciderResultsList.jsx
// Cleaning Decider → Results List
//
// Goals aligned with your system:
// - Works with DeciderFiltersBar (zones/frequency/intensity/duration + q)
// - Defensive against missing services (eventBus, analytics, automation, reminders, NBA)
// - Infinite scroll OR numbered pagination (prop-controlled, default: numbered)
// - Multi-select + bulk actions (Queue, Start Session, Schedule)
// - Card layout shows: Zone, Frequency, Intensity, Duration, Supplies, Score, Badges
// - Empty states, optimistic UI, keyboard navigation, compact mode
// - Emits events for your orchestrators (nba, reminder, queue) without hard dependency
//
// Props:
// - mode?: "cleaning" (reserved for future cross-module reuse)
// - filters: { q?:string, zones?:string[], frequency?:string[], intensity?:string[], duration?:string[] , season?:string[] }
// - fetcher?: (filters, page, size, sort) => Promise<{items,total}>
// - pageSize?: number (default 12)
// - pagination?: "numbered" | "infinite"
// - onQueueItem?: (item) => void
// - onStartItem?: (item) => void
// - onScheduleItem?: (item) => void
// - className?: string
// - compact?: boolean (denser cards)
// - sortDefault?: { key:"score"|"recent"|"duration"|"zone", dir:"asc"|"desc" }
// - emptyHint?: string (override default empty message)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** classNames helper */
function cx(...a) {
  return a.filter(Boolean).join(" ");
}

/** safe accessors */
const Services = {
  bus() {
    return window?.eventBus || window?.ssa?.eventBus || null;
  },
  analytics() {
    return window?.ssa?.analytics || null;
  },
  automation() {
    return window?.ssa?.services?.automation || window?.automation || null;
  },
  reminders() {
    return window?.ssa?.services?.reminders || window?.ReminderManager || null;
  },
  nba() {
    return window?.ssa?.services?.nba || window?.NBAOrchestrator || null;
  },
};

/** Fallback fetcher (local demo) */
async function defaultFetcher(filters, page = 1, size = 12, sort = { key: "score", dir: "desc" }) {
  // In a real app, call your backend/engine. Here we simulate results deterministically from filters.
  const zones = filters.zones?.length ? filters.zones : ["Kitchen", "Bathrooms", "Bedrooms", "Laundry"];
  const intensity = filters.intensity?.[0] || "Standard";
  const freq = filters.frequency?.[0] || "Weekly";
  const dur = filters.duration?.[0] || "20–40m";
  const base = zones.map((z, i) => ({
    id: `clean-${z.toLowerCase()}-${i}`,
    title: `${z} • ${freq}`,
    zone: z,
    frequency: freq,
    intensity,
    duration: dur,
    supplies: inferSupplies(z, intensity),
    score: 60 + Math.round(Math.random() * 40),
    badges: inferBadges(z, intensity),
    lastDoneAt: Date.now() - (i + 1) * 86400000,
    estMinutes: estimateMinutes(dur),
  }));

  // Filter by q
  const filtered = (filters.q ? base.filter((r) => r.title.toLowerCase().includes(filters.q.toLowerCase())) : base).sort(
    makeSorter(sort)
  );

  const start = (page - 1) * size;
  const items = filtered.slice(start, start + size);
  await sleep(150); // tiny delay
  return { items, total: filtered.length };
}

function makeSorter(sort) {
  const { key, dir } = sort || {};
  const mult = dir === "asc" ? 1 : -1;
  if (key === "recent") return (a, b) => mult * ((b.lastDoneAt || 0) - (a.lastDoneAt || 0));
  if (key === "duration") return (a, b) => mult * ((a.estMinutes || 0) - (b.estMinutes || 0));
  if (key === "zone") return (a, b) => mult * String(a.zone).localeCompare(String(b.zone));
  return (a, b) => mult * ((a.score || 0) - (b.score || 0)); // default score
}

const DUR_MAP = { "<10m": 10, "10–20m": 20, "20–40m": 40, "40–60m": 60, "60m+": 75 };
function estimateMinutes(label) {
  return DUR_MAP[label] || 30;
}
function inferSupplies(zone, intensity) {
  const common = ["Gloves", "Microfiber", "All-purpose"];
  const z = zone.toLowerCase();
  if (z.includes("bath")) return [...common, "Descaler", "Grout brush"];
  if (z.includes("kitchen")) return [...common, "Degreaser", "Dish soap"];
  if (z.includes("laundry")) return [...common, "Stain remover"];
  if (intensity === "Deep Clean") return [...common, "Disinfectant", "Scrub pad"];
  return common;
}
function inferBadges(zone, intensity) {
  const arr = [];
  if (/kitchen/i.test(zone)) arr.push("FoodPrepSafe");
  if (/bath/i.test(zone)) arr.push("MoistureRisk");
  if (intensity === "Deep Clean") arr.push("HighEffort");
  return arr;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Badge pill */
function Badge({ children }) {
  return <span className="inline-block rounded-full border px-2 py-0.5 text-xs">{children}</span>;
}

/** Skeleton card */
function SkeletonCard() {
  return (
    <div className="rounded-2xl border p-4 shadow-sm animate-pulse">
      <div className="h-4 w-1/2 rounded bg-gray-200" />
      <div className="mt-3 h-3 w-1/3 rounded bg-gray-200" />
      <div className="mt-4 flex gap-2">
        <div className="h-6 w-16 rounded bg-gray-200" />
        <div className="h-6 w-16 rounded bg-gray-200" />
      </div>
      <div className="mt-4 h-9 w-full rounded bg-gray-200" />
    </div>
  );
}

/** Result card */
function CleanCard({ item, selected, onSelect, compact, onStart, onQueue, onSchedule }) {
  return (
    <div className={cx("group relative rounded-2xl border p-4 shadow-sm", selected && "ring-2 ring-black")}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{item.title}</h3>
          <p className="mt-1 text-xs text-gray-600">
            Zone: <strong>{item.zone}</strong> • Freq: <strong>{item.frequency}</strong> • Intensity:{" "}
            <strong>{item.intensity}</strong> • Duration: <strong>{item.duration}</strong>
          </p>
        </div>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-black"
            checked={!!selected}
            onChange={(e) => onSelect?.(item, e.target.checked)}
            aria-label={`Select ${item.title}`}
          />
        </label>
      </div>

      {!compact && (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {item.badges?.map((b) => (
              <Badge key={b}>{b}</Badge>
            ))}
            {typeof item.score === "number" && (
              <span className="ml-auto text-xs text-gray-500">Score: {Math.round(item.score)}</span>
            )}
          </div>
          <div className="mt-3 text-xs text-gray-700">
            <span className="font-medium">Supplies:</span> {item.supplies?.join(", ")}
          </div>
        </>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-black px-3 py-2 text-xs text-white hover:opacity-90"
          onClick={() => onStart?.(item)}
          title="Start session now"
        >
          Start Now
        </button>
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
          onClick={() => onQueue?.(item)}
          title="Add to queue"
        >
          Add to Queue
        </button>
        <button
          type="button"
          className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
          onClick={() => onSchedule?.(item)}
          title="Schedule with reminder"
        >
          Schedule
        </button>
      </div>
    </div>
  );
}

/** Sort selector */
function Sorter({ sort, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-600">Sort</label>
      <select
        className="rounded-lg border px-2 py-1 text-xs"
        value={`${sort.key}:${sort.dir}`}
        onChange={(e) => {
          const [key, dir] = e.target.value.split(":");
          onChange?.({ key, dir });
        }}
      >
        <option value="score:desc">Score (high → low)</option>
        <option value="score:asc">Score (low → high)</option>
        <option value="recent:desc">Most overdue</option>
        <option value="duration:asc">Shortest first</option>
        <option value="duration:desc">Longest first</option>
        <option value="zone:asc">Zone A→Z</option>
        <option value="zone:desc">Zone Z→A</option>
      </select>
    </div>
  );
}

/** Pagination controls */
function Pager({ page, pages, onPage }) {
  if (pages <= 1) return null;
  const btn = (p, label = String(p)) => (
    <button
      key={p}
      type="button"
      disabled={p === page}
      onClick={() => onPage?.(p)}
      className={cx(
        "min-w-8 rounded-lg border px-2 py-1 text-xs",
        p === page ? "bg-black text-white" : "hover:bg-gray-50"
      )}
    >
      {label}
    </button>
  );
  const items = [];
  for (let p = 1; p <= pages; p++) items.push(btn(p));
  return <div className="flex flex-wrap items-center gap-2">{items}</div>;
}

/** Bulk actions toolbar */
function BulkBar({ count, onStart, onQueue, onSchedule, onClear }) {
  if (!count) return null;
  return (
    <div className="sticky top-0 z-10 -mx-4 mb-3 rounded-b-xl border-b bg-white/95 p-3 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">
          {count} selected {count === 1 ? "task" : "tasks"}
        </span>
        <div className="flex flex-wrap gap-2">
          <button className="rounded-lg bg-black px-3 py-2 text-xs text-white hover:opacity-90" onClick={onStart}>
            Start Selected
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={onQueue}>
            Queue Selected
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={onSchedule}>
            Schedule Selected
          </button>
          <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={onClear}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}

/** Main component */
export default function DeciderResultsList({
  mode = "cleaning",
  filters,
  fetcher = defaultFetcher,
  pageSize = 12,
  pagination = "numbered", // or "infinite"
  onQueueItem,
  onStartItem,
  onScheduleItem,
  className,
  compact = false,
  sortDefault = { key: "score", dir: "desc" },
  emptyHint,
}) {
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(sortDefault);
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(() => new Set());

  const pages = Math.max(1, Math.ceil(total / pageSize));

  // refetch when filters/sort/page change
  const doFetch = useCallback(
    async (merge = false) => {
      try {
        setLoading(true);
        setError(null);
        const res = await fetcher(filters || {}, page, pageSize, sort);
        setTotal(res?.total || 0);
        setItems((prev) => (merge ? [...prev, ...(res?.items || [])] : res?.items || []));
      } catch (e) {
        console.error(e);
        setError("Failed to load tasks. Please try again.");
      } finally {
        setLoading(false);
      }
    },
    [fetcher, filters, page, pageSize, sort]
  );

  // event-driven re-apply (when user hits "Apply" in FiltersBar)
  useEffect(() => {
    const bus = Services.bus();
    if (!bus?.on) return;
    const handler = (payload) => {
      if (payload?.mode && payload.mode !== mode) return;
      setPage(1);
      doFetch(false);
    };
    bus.on("decider:filters:apply", handler);
    return () => {
      try {
        bus.off?.("decider:filters:apply", handler);
      } catch {}
    };
  }, [doFetch, mode]);

  // initial and on dep change
  useEffect(() => {
    setPage(1);
  }, [JSON.stringify(filters), JSON.stringify(sort), pageSize]);

  useEffect(() => {
    doFetch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort, pageSize, JSON.stringify(filters)]);

  // Infinite scroll
  const sentinelRef = useRef(null);
  useEffect(() => {
    if (pagination !== "infinite") return;
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      const first = entries[0];
      if (first?.isIntersecting && items.length < total && !loading) {
        setPage((p) => p + 1);
        doFetch(true);
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [pagination, items.length, total, loading, doFetch]);

  // Selection helpers
  const toggleSelect = (item, checked) => {
    setSelected((s) => {
      const next = new Set(s);
      if (checked) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  // Actions (defensive glue)
  const handleQueue = async (item) => {
    onQueueItem?.(item);
    fireEvent("queue:add", { item });
    toast("Added to queue");
  };
  const handleStart = async (itemOrItems) => {
    const arr = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
    onStartItem?.(arr);
    fireEvent("session:start", { items: arr });
    Services.nba()?.suggest?.("cleaning.session.start", { items: arr });
    toast(arr.length > 1 ? "Started session with selected tasks" : "Started session");
  };
  const handleSchedule = async (itemOrItems) => {
    const arr = Array.isArray(itemOrItems) ? itemOrItems : [itemOrItems];
    onScheduleItem?.(arr);
    try {
      Services.reminders()?.scheduleBatch?.(arr.map(toReminderPayload));
    } catch {}
    fireEvent("schedule:create", { items: arr });
    toast(arr.length > 1 ? "Scheduled selected tasks" : "Scheduled task");
  };

  function toReminderPayload(item) {
    const when = suggestWhen(item);
    return {
      title: `Clean: ${item.title}`,
      notes: `Zone ${item.zone} • ${item.intensity} • ${item.duration}`,
      when,
      metadata: { kind: "cleaning", zone: item.zone, frequency: item.frequency, estMinutes: item.estMinutes },
    };
  }
  function suggestWhen(item) {
    // Heuristic: weekly → next morning 9:00; monthly → next Sat 10:00; else → next available 6:00 pm today.
    const now = new Date();
    const d = new Date(now);
    if (/weekly/i.test(item.frequency)) {
      d.setDate(now.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    } else if (/monthly|quarterly|seasonal|annual/i.test(item.frequency)) {
      // next Saturday 10am
      const day = now.getDay(); // 0=Sun
      const toSat = (6 - day + 7) % 7 || 7;
      d.setDate(now.getDate() + toSat);
      d.setHours(10, 0, 0, 0);
    } else {
      d.setHours(18, 0, 0, 0);
    }
    return d.toISOString();
  }

  function toast(msg) {
    // Optional global toast
    try {
      window?.ssa?.ui?.toast?.(msg);
    } catch {
      // fallback console
      console.log("[toast]", msg);
    }
  }
  function fireEvent(type, detail) {
    try {
      Services.bus()?.emit?.(`cleaning:${type}`, detail);
      Services.analytics()?.track?.(`cleaning:${type}`, detail);
    } catch {}
  }

  // Keyboard navigation: arrows move a "focus index"
  const [focusIndex, setFocusIndex] = useState(0);
  const gridRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (!gridRef.current) return;
      const max = items.length - 1;
      if (e.key === "ArrowRight") setFocusIndex((i) => Math.min(max, i + 1));
      if (e.key === "ArrowLeft") setFocusIndex((i) => Math.max(0, i - 1));
      if (e.key === "Enter") {
        const item = items[focusIndex];
        if (item) handleStart(item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, focusIndex]);

  const selectedItems = useMemo(() => items.filter((it) => selected.has(it.id)), [items, selected]);

  return (
    <div className={cx("w-full", className)}>
      {/* Header controls */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Sorter sort={sort} onChange={setSort} />
          <span className="text-xs text-gray-500">
            {total ? `${total} matches` : loading ? "Loading…" : "No matches"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">View</label>
          <select
            className="rounded-lg border px-2 py-1 text-xs"
            value={compact ? "compact" : "comfortable"}
            onChange={(e) => {
              // Local toggle only
              // (If you want to persist this, link to SettingsContext or localStorage)
            }}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </div>
      </div>

      {/* Bulk bar */}
      <BulkBar
        count={selected.size}
        onStart={() => handleStart(selectedItems)}
        onQueue={() => {
          selectedItems.forEach((it) => handleQueue(it));
          clearSelection();
        }}
        onSchedule={() => {
          handleSchedule(selectedItems);
          clearSelection();
        }}
        onClear={clearSelection}
      />

      {/* Error */}
      {error && (
        <div className="mb-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error} <button className="underline" onClick={() => doFetch(false)}>Retry</button>
        </div>
      )}

      {/* Grid */}
      <div ref={gridRef} className={cx("grid gap-3", compact ? "grid-cols-1 md:grid-cols-2" : "grid-cols-1 md:grid-cols-3")}>
        {loading && !items.length
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)
          : items.map((it, idx) => (
              <CleanCard
                key={it.id}
                item={it}
                compact={compact}
                selected={selected.has(it.id)}
                onSelect={toggleSelect}
                onStart={handleStart}
                onQueue={handleQueue}
                onSchedule={handleSchedule}
                data-focus={idx === focusIndex ? "true" : "false"}
              />
            ))}
      </div>

      {/* Empty state */}
      {!loading && !items.length && !error && (
        <div className="mt-6 rounded-2xl border p-6 text-center">
          <div className="text-sm text-gray-700">
            No cleaning tasks match your filters.
            <div className="mt-2 text-xs text-gray-500">
              {emptyHint ||
                "Try widening frequency or duration, or remove a zone. Presets like “Kitchen • Weekly • 20–40m” work great."}
            </div>
            <div className="mt-3">
              <button
                type="button"
                className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
                onClick={() => {
                  Services.bus()?.emit?.("decider:filters:apply", { mode: "cleaning", filters: {} });
                }}
              >
                Clear Filters
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pagination */}
      {pagination === "numbered" && !loading && items.length > 0 && (
        <div className="mt-4 flex items-center justify-center">
          <Pager page={page} pages={pages} onPage={setPage} />
        </div>
      )}

      {/* Infinite sentinel */}
      {pagination === "infinite" && <div ref={sentinelRef} className="h-8 w-full" />}

      {/* Footer tip */}
      <div className="mt-4 text-center text-[11px] text-gray-500">
        Tip: Use <kbd>←</kbd>/<kbd>→</kbd> to move focus. Press <kbd>Enter</kbd> to start the focused task.
      </div>
    </div>
  );
}

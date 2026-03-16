// src/components/meals/decider/DeciderResultsList.jsx
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {}

let eventBus = null;
try {
  eventBus = require("@/services/events/eventBus").eventBus || null;
} catch {}

let automation = null;
try {
  automation = require("@/services/automation/runtime").automation || null;
} catch {}

let useMealPlanStore = () => null;
try {
  const mod = require("@/store/MealPlanStore");
  useMealPlanStore = mod.useMealPlanStore || useMealPlanStore;
} catch {}

let DeciderExplainBadge = null;
try {
  DeciderExplainBadge = require("./DeciderExplainBadge.jsx").default || null;
} catch {}

let DeciderQuickActions = null;
try {
  DeciderQuickActions = require("./DeciderQuickActions.jsx").default || null;
} catch {}

/* Optional virtualization */
let VariableSizeList = null;
try {
  VariableSizeList = require("react-window").VariableSizeList || null;
} catch {}

/* --------------------------------- Utilities --------------------------------- */
const clamp = (n, a = 0, b = 100) =>
  Math.max(a, Math.min(b, Number.isFinite(n) ? n : a));
const cx = (...xs) => xs.filter(Boolean).join(" ");
const groupBy = (items, fn) =>
  (items || []).reduce((acc, it) => {
    const k = fn(it);
    (acc[k] = acc[k] || []).push(it);
    return acc;
  }, {});
const fmtMoney = (v) =>
  typeof v === "number" && !Number.isNaN(v)
    ? v.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      })
    : "—";

/* --------------------------------- Skeletons --------------------------------- */
const CardSkeleton = () => (
  <div className="rounded-2xl border p-3 bg-white/60 animate-pulse">
    <div className="h-4 w-1/3 bg-gray-200 rounded mb-2" />
    <div className="h-3 w-1/2 bg-gray-200 rounded mb-2" />
    <div className="flex gap-2 mb-3">
      <div className="h-5 w-16 bg-gray-200 rounded" />
      <div className="h-5 w-16 bg-gray-200 rounded" />
      <div className="h-5 w-16 bg-gray-200 rounded" />
    </div>
    <div className="h-24 bg-gray-100 rounded" />
  </div>
);

/* -------------------------------- Result Card -------------------------------- */
const ResultCard = ({
  item,
  dense = false,
  onSelect,
  householdId = "default",
}) => {
  const store = useMealPlanStore ? useMealPlanStore() : null;
  const {
    UtensilsCrossed = () => null,
    CalendarClock = () => null,
    Package = () => null,
    DollarSign = () => null,
    Tag = () => null,
    Pin = () => null,
    Lock = () => null,
    ExternalLink = () => null,
  } = Icons;

  const score = clamp(item?.totalScore ?? 0);
  const invPct = clamp(item?.inventory?.matchPct ?? 0);
  const cook = item?.estCookMins || item?.cookMins || item?.timeMins;
  const cost = item?.budget?.estCost;

  const badgeTone =
    score >= 85
      ? "bg-emerald-600"
      : score >= 70
      ? "bg-green-600"
      : score >= 55
      ? "bg-yellow-600"
      : score >= 40
      ? "bg-orange-600"
      : "bg-rose-600";

  const handleSelect = () => {
    onSelect?.(item);
    try {
      eventBus?.emit?.("meals.decider.result.selected", {
        id: item?.id,
        householdId,
        ts: Date.now(),
      });
      automation?.runTemplate?.("meals.decider.result.selected", {
        decision: item,
        householdId,
      });
      store?.setActiveDecision?.(item); // optional
    } catch {}
  };

  return (
    <div className="rounded-2xl border p-3 bg-white/80 backdrop-blur hover:shadow-sm transition">
      {/* title row */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <UtensilsCrossed className="w-4 h-4 opacity-80" />
            <button
              onClick={handleSelect}
              className="text-base md:text-lg font-semibold truncate text-left hover:underline"
              title={item?.title || "Meal"}
            >
              {item?.title || "Meal"}
            </button>
            {item?.pinned ? (
              <span
                title="Pinned"
                className="inline-flex items-center text-[10px] px-1 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded"
              >
                <Pin className="w-3 h-3 mr-1" /> Pinned
              </span>
            ) : null}
            {item?.locked ? (
              <span
                title="Locked"
                className="inline-flex items-center text-[10px] px-1 py-0.5 bg-gray-100 text-gray-700 border border-gray-200 rounded"
              >
                <Lock className="w-3 h-3 mr-1" /> Locked
              </span>
            ) : null}
          </div>
          <div className="text-xs text-gray-600 mt-0.5">
            {item?.slot ? (
              <span className="mr-2">
                Slot: <span className="font-medium">{item.slot}</span>
              </span>
            ) : null}
            {item?.date ? <span className="mr-2">• {item.date}</span> : null}
            {typeof cost === "number" ? (
              <span className="mr-2">• Est {fmtMoney(cost)}</span>
            ) : null}
            {Number.isFinite(invPct) ? (
              <span className="mr-2">• {invPct}% on-hand</span>
            ) : null}
            {item?.calendar?.feastDay ? (
              <span className="text-blue-700">• {item.calendar.feastDay}</span>
            ) : null}
          </div>
        </div>

        {/* quick score */}
        <div
          className={`shrink-0 inline-flex items-center gap-2 text-white ${badgeTone} px-2.5 py-1 rounded-full`}
        >
          <span className="text-xs">Score</span>
          <span className="font-semibold text-sm">{score}</span>
        </div>
      </div>

      {/* meta chips */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {cook ? (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border">
            <CalendarClock className="w-3.5 h-3.5" /> ~{cook} min
          </span>
        ) : null}
        <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border">
          <Package className="w-3.5 h-3.5" /> {invPct}% on-hand
        </span>
        {typeof cost === "number" ? (
          <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border">
            <DollarSign className="w-3.5 h-3.5" /> {fmtMoney(cost)}
          </span>
        ) : null}
        {(item?.tags || []).slice(0, 5).map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border bg-gray-50"
          >
            <Tag className="w-3 h-3" /> {t}
          </span>
        ))}
        {item?.provenance?.url ? (
          <a
            href={item.provenance.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs px-2 py-1 rounded border hover:bg-gray-50"
            title="Open source"
          >
            Source <ExternalLink className="w-3 h-3" />
          </a>
        ) : null}
      </div>

      {/* explain + actions */}
      <div className="mt-3 grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="lg:col-span-2">
          {DeciderQuickActions ? (
            <DeciderQuickActions
              decision={item}
              householdId={householdId}
              dense={dense}
            />
          ) : (
            <div className="text-xs text-gray-500 border rounded p-3">
              Quick actions unavailable.
            </div>
          )}
        </div>
        <div className="lg:col-span-1 flex items-start justify-end">
          {DeciderExplainBadge ? (
            <DeciderExplainBadge decision={item} size="sm" />
          ) : (
            <div className="text-xs text-gray-500 border rounded p-3">
              Explanation unavailable.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* --------------------------- Group Header Component --------------------------- */
const GroupHeader = ({ title, count }) => (
  <div className="sticky top-0 z-10 bg-white/90 backdrop-blur border-y py-1.5 px-2 mb-2 flex items-center justify-between">
    <div className="text-xs font-semibold tracking-wide uppercase text-gray-600">
      {title}
    </div>
    <div className="text-[11px] text-gray-500">
      {count} result{count === 1 ? "" : "s"}
    </div>
  </div>
);

/* --------------------------------- Empty view -------------------------------- */
const EmptyState = ({ onRetry }) => {
  const { Search = () => null, Sparkles = () => null } = Icons;
  return (
    <div className="rounded-2xl border p-6 text-center bg-white/60">
      <div className="mx-auto w-10 h-10 rounded-full border flex items-center justify-center mb-3">
        <Search className="w-5 h-5 text-gray-600" />
      </div>
      <div className="font-semibold">No matching meals (yet)</div>
      <p className="text-sm text-gray-600 mt-1">
        Try loosening filters, switching presets, or importing a few new recipes
        in <span className="font-medium">Collect</span>.
      </p>
      <div className="mt-3 flex items-center justify-center gap-2">
        <button
          className="px-3 py-1.5 rounded-md border hover:bg-gray-50 text-sm"
          onClick={onRetry}
        >
          <Sparkles className="w-4 h-4 inline-block mr-1" />
          Refresh
        </button>
      </div>
    </div>
  );
};

/* ------------------------------- Main component ------------------------------ */
/**
 * DeciderResultsList
 *
 * Props:
 * - items: Decision[]   (see DeciderExplainBadge docs)
 * - loading?: boolean
 * - error?: string
 * - onSelect?: (item) => void
 * - onLoadMore?: () => void           // infinite load trigger
 * - canLoadMore?: boolean
 * - groupBy?: "none" | "day" | "slot"
 * - householdId?: string
 * - dense?: boolean
 * - virtualHeight?: number            // height for virtual list viewport
 */
const DeciderResultsList = ({
  items = [],
  loading = false,
  error = "",
  onSelect,
  onLoadMore,
  canLoadMore = false,
  groupBy: groupMode = "none",
  householdId = "default",
  dense = false,
  virtualHeight = 560,
}) => {
  const listRef = useRef(null);
  const loadMoreRef = useRef(null);

  // Observe load-more sentinel
  useEffect(() => {
    if (!onLoadMore || !canLoadMore) return;
    const el = loadMoreRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { root: null, threshold: 0.1 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onLoadMore, canLoadMore]);

  // Event: first paint
  useEffect(() => {
    try {
      eventBus?.emit?.("meals.decider.results.rendered", {
        count: items.length,
        ts: Date.now(),
      });
      automation?.runTemplate?.("meals.decider.results.rendered", {
        count: items.length,
      });
    } catch {}
  }, [items.length]);

  const groups = useMemo(() => {
    if (!items?.length || groupMode === "none") return null;
    if (groupMode === "slot")
      return groupBy(items, (x) => x.slot || "Unslotted");
    if (groupMode === "day")
      return groupBy(items, (x) => x.date || "Unscheduled");
    return null;
  }, [items, groupMode]);

  const flat = useMemo(() => {
    if (!groups) return items;
    return Object.entries(groups).flatMap(([k, arr]) => [
      { __group: true, key: k, count: arr.length },
      ...arr,
    ]);
  }, [groups, items]);

  /* ------------------------------- Virtual sizes ------------------------------ */
  const getItemSize = useCallback(
    (index) => {
      const row = flat[index];
      if (row?.__group) return 36; // group header
      // rough size—dense / regular variance
      return dense ? 250 : 300;
    },
    [flat, dense]
  );

  /* ------------------------------------ UI ----------------------------------- */
  if (error) {
    return (
      <div className="rounded-2xl border p-4 bg-rose-50 border-rose-200 text-rose-800 text-sm">
        {error}
      </div>
    );
  }

  if (loading && (!items || items.length === 0)) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <CardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!loading && (!items || items.length === 0)) {
    return (
      <EmptyState
        onRetry={() => eventBus?.emit?.("meals.decider.results.refresh")}
      />
    );
  }

  /* ----------- Virtualized list (if available) or graceful grid fallback ------ */
  if (VariableSizeList) {
    return (
      <div className="rounded-2xl border bg-white/60">
        <VariableSizeList
          ref={listRef}
          height={virtualHeight}
          width={"100%"}
          itemCount={flat.length + (canLoadMore ? 1 : 0)}
          itemSize={(i) => (i === flat.length ? 64 : getItemSize(i))}
          className="rounded-2xl"
        >
          {({ index, style }) => {
            if (index === flat.length) {
              return (
                <div style={style} className="flex items-center justify-center">
                  {canLoadMore ? (
                    <div
                      ref={loadMoreRef}
                      className="text-xs text-gray-600 border rounded px-3 py-2 bg-white/70"
                    >
                      Loading more…
                    </div>
                  ) : null}
                </div>
              );
            }
            const row = flat[index];
            if (row?.__group) {
              return (
                <div style={style}>
                  <GroupHeader title={row.key} count={row.count} />
                </div>
              );
            }
            return (
              <div style={style} className="p-2">
                <ResultCard
                  item={row}
                  onSelect={onSelect}
                  householdId={householdId}
                  dense={dense}
                />
              </div>
            );
          }}
        </VariableSizeList>
      </div>
    );
  }

  // Fallback: responsive grid + sentinel
  return (
    <>
      {groups ? (
        <div className="space-y-6">
          {Object.entries(groups).map(([k, arr]) => (
            <section key={k}>
              <GroupHeader title={k} count={arr.length} />
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {arr.map((x) => (
                  <ResultCard
                    key={x.id || x.title}
                    item={x}
                    onSelect={onSelect}
                    householdId={householdId}
                    dense={dense}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {items.map((x) => (
            <ResultCard
              key={x.id || x.title}
              item={x}
              onSelect={onSelect}
              householdId={householdId}
              dense={dense}
            />
          ))}
        </div>
      )}

      {canLoadMore ? (
        <div className="flex items-center justify-center mt-3">
          <button
            ref={loadMoreRef}
            className="px-3 py-1.5 rounded-md border hover:bg-gray-50 text-sm"
            onClick={onLoadMore}
          >
            Load more
          </button>
        </div>
      ) : null}
    </>
  );
};

export default DeciderResultsList;

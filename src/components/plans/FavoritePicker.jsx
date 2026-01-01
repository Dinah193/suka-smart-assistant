// FavoritePicker — domain-aware, searchable picker for Featured + My Plans + Favorites
// - Users can select one or many plans, heart/unheart, and clone featured to "My Plans"
// - Uses useFavoritePlans hook if available, otherwise falls back to PlanStorageRouter
// - Emits canonical events and NBA signals; keyboard-accessible; domain & tag filters
/* eslint-disable no-console */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* --------------------------------- Imports -------------------------------- */
let useFavoritePlans = null;
try {
  const mod = require("@/hooks/useFavoritePlans");
  useFavoritePlans = mod?.default || null;
} catch (_e) {}

let SavePlanButton = null;
try {
  const mod = require("@/components/plans/SavePlanButton.jsx");
  SavePlanButton = mod?.default || null;
} catch (_e) {}

let eventBus = { on(){}, off(){}, emit(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let automation = null;
try {
  const rt = require("@/services/automation/runtime");
  automation = rt?.automation || rt?.default || null;
} catch (_e) {}

let PlanStorageFactory = null;
try {
  const psr = require("@/managers/storage/PlanStorageRouter");
  PlanStorageFactory = psr?.createPlanStorageRouter || null;
} catch (_e) {}

const isBrowser = typeof window !== "undefined";

/* --------------------------------- Icons ---------------------------------- */
const IconSearch = (p) => (
  <svg viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <path d="M15.5 14h-.79l-.28-.27a6.471 6.471 0 10-.71.71l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
  </svg>
);

const IconHeart = ({ filled, className }) =>
  filled ? (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.1 21.35l-.1.1-.11-.1C7.14 17.24 4 14.39 4 10.99 4 8.58 5.99 6.6 8.4 6.6c1.33 0 2.61.57 3.6 1.49a5.12 5.12 0 013.6-1.49c2.41 0 4.4 1.98 4.4 4.39 0 3.4-3.14 6.25-7.9 10.36z" />
    </svg>
  ) : (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 6.6c-1.33 0-2.61.57-3.6 1.49A5.12 5.12 0 008.8 6.6C6.39 6.6 4.4 8.58 4.4 11c0 3.4 3.14 6.25 7.9 10.36C17.06 17.25 20.2 14.4 20.2 11c0-2.42-1.99-4.4-4.4-4.4zm0-1.6c3.31 0 6 2.69 6 6 0 3.97-3.8 7.34-8.97 12.04L12 23l-.03-.03C6.8 18.34 3 14.97 3 11c0-3.31 2.69-6 6-6 1.76 0 3.35.76 4.47 1.97A6.96 6.96 0 0116 5z" />
    </svg>
  );

const IconTag = (p) => (
  <svg viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <path d="M20.59 13.41L12 22 2 12l8.59-8.59A2 2 0 0112.99 3H20v7.01a2 2 0 01-.59 1.4zM7 9a2 2 0 100-4 2 2 0 000 4z" />
  </svg>
);

/* ------------------------------ Helper utils ------------------------------ */
const DOMAINS = ["meals", "cleaning", "garden", "animals", "inventory", "health"];
const classNames = (...xs) => xs.filter(Boolean).join(" ");
const chipColors = ["bg-blue-50 text-blue-700", "bg-rose-50 text-rose-700", "bg-emerald-50 text-emerald-700", "bg-amber-50 text-amber-800"];

function useDebouncedValue(value, delay = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/* ------------------------------- Plan Card -------------------------------- */
function PlanCard({
  plan,
  selected,
  onSelectToggle,
  onFavoriteToggle,
  userId,
  domain,
}) {
  const mine = plan?.meta?.source === "user" && plan?.meta?.createdBy === userId;
  const featured = plan?.meta?.source === "featured";
  const tagColor = (i) => chipColors[i % chipColors.length];

  return (
    <div
      className={classNames(
        "rounded-2xl border p-4 hover:shadow-sm transition focus-within:ring-2 focus-within:ring-offset-2",
        selected ? "border-blue-500 ring-2 ring-blue-200" : "border-gray-200"
      )}
      role="option"
      aria-selected={selected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onSelectToggle?.(plan);
      }}
      onClick={() => onSelectToggle?.(plan)}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 px-2 py-0.5 text-xs">
              {plan.domain || domain}
            </span>
            {mine && <span className="text-xs text-emerald-700 bg-emerald-50 rounded-full px-1.5 py-0.5">Mine</span>}
            {featured && <span className="text-xs text-purple-700 bg-purple-50 rounded-full px-1.5 py-0.5">Featured</span>}
          </div>
          <h4 className="mt-1 font-semibold text-sm md:text-base line-clamp-1">{plan.title || "Untitled Plan"}</h4>
          {plan.summary && <p className="mt-1 text-xs md:text-sm text-gray-600 line-clamp-2">{plan.summary}</p>}
          {!!(plan.tags?.length) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {plan.tags.slice(0, 5).map((t, i) => (
                <span key={t} className={classNames("inline-flex items-center gap-1 text-xs rounded-full px-2 py-0.5", tagColor(i))}>
                  <IconTag className="h-3 w-3" /> {t}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={plan.isFavorite ? "Remove from favorites" : "Add to favorites"}
            title={plan.isFavorite ? "Remove from favorites" : "Add to favorites"}
            className={classNames(
              "rounded-full border transition inline-flex items-center justify-center",
              "h-9 w-9",
              plan.isFavorite ? "bg-rose-50 border-rose-200" : "bg-white border-gray-200 hover:bg-gray-50"
            )}
            onClick={(e) => { e.stopPropagation(); onFavoriteToggle?.(plan); }}
          >
            <IconHeart className={classNames("h-5 w-5", plan.isFavorite ? "fill-rose-600" : "fill-gray-500")} filled={!!plan.isFavorite} />
          </button>

          {SavePlanButton ? (
            <SavePlanButton
              plan={plan}
              userId={userId}
              domain={domain}
              variant="outline"
              compact
              showFavoriteHeart={false}
              onAfterSave={() => {}}
            />
          ) : null}

          <input
            type="checkbox"
            className="h-4 w-4 accent-blue-600"
            aria-label="Select plan"
            checked={!!selected}
            onChange={(e) => { e.stopPropagation(); onSelectToggle?.(plan); }}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ FavoritePicker ---------------------------- */
/**
 * @param {object} props
 * @param {string} props.userId
 * @param {string=} props.domain                     default "meals"
 * @param {"all"|"mine"|"featured"|"favorites"=} props.mode initial tab filter
 * @param {boolean=} props.multi                     allow multi-select
 * @param {function(Array=):void=} props.onConfirm   called with selected plan objects
 * @param {function(object|Array):void=} props.onSelect called when selection toggles
 * @param {string[]=} props.initialTags
 * @param {string=} props.className
 * @param {boolean=} props.showDomainFilter
 */
export default function FavoritePicker({
  userId = "anon",
  domain = "meals",
  mode = "all",
  multi = true,
  onConfirm,
  onSelect,
  initialTags = [],
  className,
  showDomainFilter = true,
}) {
  const hasHook = typeof useFavoritePlans === "function";
  const [localDomain, setLocalDomain] = useState(domain);
  const [tab, setTab] = useState(mode);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 250);
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState(initialTags);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  // ----------------------- Hook-based manager (preferred) --------------------
  const hook = hasHook
    ? useFavoritePlans({
        userId,
        domain: localDomain,
        only: tab,            // "all" | "mine" | "featured" | "favorites"
        search: debouncedQuery,
        tags,
      })
    : null;

  // ---------------------- Fallback: PlanStorageRouter path -------------------
  const routerRef = useRef(null);
  const [routerReady, setRouterReady] = useState(false);
  const [fallbackLoading, setFallbackLoading] = useState(false);
  const [fallbackItems, setFallbackItems] = useState([]);
  const [fallbackSnapshot, setFallbackSnapshot] = useState({ favoriteCount: 0, myPlanCount: 0 });

  useEffect(() => {
    let alive = true;
    (async () => {
      if (routerRef.current || !PlanStorageFactory) return setRouterReady(!!routerRef.current);
      try {
        const r = await PlanStorageFactory({ userId });
        routerRef.current = r;
      } catch (_e) {
        routerRef.current = null;
      } finally {
        if (alive) setRouterReady(!!routerRef.current);
      }
    })();
    return () => { alive = false; };
  }, [userId]);

  const router = () => routerRef.current;

  const refreshFallback = useCallback(async () => {
    if (!routerReady || !router()) return;
    setFallbackLoading(true);
    try {
      const scopeMine = await router().listPlans({ scope: "user", userId, domain: localDomain, includeDeleted: false, limit: 1000 });
      const scopeFeatured = await router().listPlans({ scope: "global", domain: localDomain, includeDeleted: false, limit: 1000 });
      const favs = await router().listFavorites({ userId, domain: localDomain, limit: 1000 });
      const favSet = new Set((favs || []).map((p) => p.id));

      // Merge sets based on tab
      let pool = [];
      if (tab === "mine") pool = scopeMine;
      else if (tab === "featured") pool = scopeFeatured;
      else if (tab === "favorites") pool = (scopeMine.concat(scopeFeatured)).filter((p) => favSet.has(p.id));
      else pool = scopeMine.concat(scopeFeatured);

      // Basic search + tag filter locally
      const q = (debouncedQuery || "").toLowerCase();
      if (q) {
        pool = pool.filter((p) => {
          const hay = [p.title, p.summary, (p.tags || []).join(" ")].join(" ").toLowerCase();
          return hay.includes(q);
        });
      }
      if (tags?.length) {
        pool = pool.filter((p) => (p.tags || []).some((t) => tags.includes(t)));
      }

      // Mark favorites for UI
      const items = pool.map((p) => ({ ...p, isFavorite: favSet.has(p.id) }));

      // Snapshot counts
      const snapshot = {
        favoriteCount: favSet.size,
        myPlanCount: scopeMine.length,
      };

      setFallbackItems(items);
      setFallbackSnapshot(snapshot);
    } catch (err) {
      console.warn("[FavoritePicker] fallback refresh error:", err);
    } finally {
      setFallbackLoading(false);
    }
  }, [routerReady, userId, localDomain, tab, debouncedQuery, JSON.stringify(tags)]);

  useEffect(() => {
    if (!hasHook) refreshFallback();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasHook, refreshFallback]);

  // Unified state surface
  const state = hasHook
    ? (hook?.state || { loading: false, items: [], favorites: [], snapshot: null })
    : { loading: fallbackLoading, items: fallbackItems, favorites: [], snapshot: fallbackSnapshot };

  const refresh = hasHook ? (hook?.refresh || (() => {})) : refreshFallback;

  // Hook ops or router ops
  const toggleFavorite = async ({ planId, domain: dom }) => {
    if (hasHook && hook?.toggleFavorite) return hook.toggleFavorite({ planId, domain: dom });
    if (!routerReady || !router()) return;
    const res = await router().toggleFavorite({ planId, userId, domain: dom });
    eventBus.emit?.("favorite.updated", { planId, userId, favorite: !!res?.favorite, domain: dom });
    await refreshFallback();
    return res;
  };

  const adoptFeatured = async ({ userId: uid, domain: dom, planId, favorite }) => {
    if (hasHook && hook?.adoptFeatured) return hook.adoptFeatured({ userId: uid, domain: dom, planId, favorite });
    if (!routerReady || !router()) return;
    // clone: load featured → save as user scope
    const featured = await router().getPlan(planId, { scope: "global" });
    if (!featured) throw new Error("Featured plan not found");
    const copy = {
      ...featured,
      id: undefined, // let router assign
      domain: featured.domain || dom,
      meta: { ...(featured.meta || {}), source: "user", createdBy: uid },
    };
    const saved = await router().savePlan(copy, { scope: "user", userId: uid, favorite: !!favorite });
    try { router().afterSaveOrchestrate?.(saved); } catch (_e) {}
    return saved;
  };

  // keyboard focus ring
  const listRef = useRef(null);

  // refresh when filters change
  useEffect(() => {
    refresh?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localDomain, tab, debouncedQuery, JSON.stringify(tags)]);

  const items = state.items || [];
  const empty = !state.loading && items.length === 0;

  function handleSelectToggle(plan) {
    const next = new Set(selectedIds);
    if (multi) {
      if (next.has(plan.id)) next.delete(plan.id);
      else next.add(plan.id);
    } else {
      next.clear();
      next.add(plan.id);
    }
    setSelectedIds(next);
    const payload = multi ? items.filter((p) => next.has(p.id)) : plan;
    onSelect?.(payload);
  }

  async function handleFavoriteToggle(plan) {
    try {
      await toggleFavorite({ planId: plan.id, domain: plan.domain || localDomain });
      eventBus.emit?.("toast.show", {
        level: "success",
        title: plan.isFavorite ? "Removed from favorites" : "Added to favorites",
        message: plan.title || "Plan",
        ts: Date.now(),
      });
      refresh?.();
    } catch (err) {
      eventBus.emit?.("toast.show", {
        level: "error",
        title: "Favorite failed",
        message: String(err?.message || err),
        ts: Date.now(),
      });
    }
  }

  function handleAddTag() {
    const t = (tagInput || "").trim();
    if (!t) return;
    if (!tags.includes(t)) setTags((xs) => [...xs, t]);
    setTagInput("");
  }

  function handleRemoveTag(tag) {
    setTags((xs) => xs.filter((t) => t !== tag));
  }

  async function handleQuickAdopt() {
    const first = items.find((p) => selectedIds.has(p.id) && p.meta?.source === "featured");
    if (!first) return;
    await adoptFeatured?.({ userId, domain: first.domain || localDomain, planId: first.id, favorite: true });
    eventBus.emit?.("toast.show", {
      level: "success",
      title: "Saved to My Plans",
      message: "Plan cloned and added to favorites.",
      ts: Date.now(),
    });
    refresh?.();
  }

  function confirmSelection() {
    const chosen = items.filter((p) => selectedIds.has(p.id));
    onConfirm?.(chosen);
    automation?.emit?.("nba.signal", { kind: "favoritepicker.confirm", userId, domain: localDomain, count: chosen.length, ts: Date.now() });
  }

  const selectedCount = selectedIds.size;

  /* --------------------------------- Render -------------------------------- */
  return (
    <div className={classNames("w-full", className)}>
      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2 md:gap-3">
        {/* Tabs */}
        <div className="inline-flex rounded-xl border p-1 bg-white">
          {["all", "mine", "featured", "favorites"].map((k) => (
            <button
              key={k}
              type="button"
              className={classNames(
                "px-3 py-1.5 text-sm rounded-lg",
                tab === k ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-50"
              )}
              onClick={() => setTab(k)}
              aria-pressed={tab === k}
            >
              {k === "all" ? "All" : k.charAt(0).toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>

        {/* Domain filter */}
        {showDomainFilter && (
          <div className="relative">
            <select
              className="rounded-xl border px-3 py-1.5 text-sm bg-white"
              value={localDomain}
              onChange={(e) => setLocalDomain(e.target.value)}
            >
              {DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Search box */}
        <div className="relative flex-1 min-w-[220px] max-w-lg">
          <IconSearch className="h-5 w-5 absolute left-3 top-2.5 fill-gray-500" />
          <input
            className="w-full rounded-xl border pl-10 pr-3 py-2 text-sm"
            placeholder="Search plans (title, summary)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search plans"
          />
        </div>

        {/* Tags input */}
        <div className="flex items-center gap-1">
          <input
            className="rounded-xl border px-3 py-2 text-sm"
            placeholder="Add tag filter"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
            aria-label="Add tag filter"
          />
          <button
            type="button"
            className="rounded-xl bg-gray-100 border px-3 py-2 text-sm hover:bg-gray-200"
            onClick={handleAddTag}
          >
            Add
          </button>
        </div>

        {/* Selected counter + actions */}
        <div className="ml-auto flex items-center gap-2">
          {selectedCount > 0 && (
            <>
              <span className="text-sm text-gray-600">{selectedCount} selected</span>
              <button
                type="button"
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={() => setSelectedIds(new Set())}
              >
                Clear
              </button>
              <button
                type="button"
                className="rounded-xl bg-blue-600 text-white px-3 py-2 text-sm hover:bg-blue-700"
                onClick={confirmSelection}
              >
                Use Selected
              </button>
            </>
          )}
        </div>
      </div>

      {/* Active tag filters */}
      {!!tags.length && (
        <div className="mt-2 flex flex-wrap gap-2">
          {tags.map((t, i) => (
            <span key={t} className={classNames("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs", chipColors[i % chipColors.length])}>
              <IconTag className="h-3 w-3" />
              {t}
              <button
                className="ml-1 rounded-full px-1 hover:bg-black/10"
                aria-label={`Remove tag ${t}`}
                onClick={() => handleRemoveTag(t)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Grid list */}
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable={multi}
        className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
      >
        {state.loading && (
          <>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-gray-200 p-4 animate-pulse">
                <div className="h-4 w-24 bg-gray-200 rounded mb-2" />
                <div className="h-5 w-3/4 bg-gray-200 rounded mb-2" />
                <div className="h-4 w-full bg-gray-200 rounded mb-2" />
                <div className="h-4 w-2/3 bg-gray-200 rounded" />
              </div>
            ))}
          </>
        )}

        {!state.loading &&
          items.map((plan) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              selected={selectedIds.has(plan.id)}
              onSelectToggle={handleSelectToggle}
              onFavoriteToggle={handleFavoriteToggle}
              userId={userId}
              domain={localDomain}
            />
          ))}

        {empty && (
          <div className="col-span-full">
            <div className="rounded-2xl border border-dashed p-8 text-center">
              <p className="text-sm text-gray-600">
                No plans found. Try a different search, remove filters, or switch tabs.
              </p>
              {tab !== "featured" && (
                <p className="mt-2 text-xs text-gray-500">
                  Tip: Save any featured plan to your library using “Save to My Plans.”
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="mt-4 flex items-center justify-between">
        <div className="text-xs text-gray-500">
          {(state?.snapshot?.favoriteCount ?? 0)} favorites • {(state?.snapshot?.myPlanCount ?? 0)} in My Plans
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            onClick={() => refresh?.()}
          >
            Refresh
          </button>
          <button
            type="button"
            className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
            onClick={handleQuickAdopt}
            disabled={[...selectedIds].every((id) => items.find((p) => p.id === id)?.meta?.source !== "featured")}
            title="Clone selected featured plan into My Plans and favorite it"
          >
            Quick Adopt & Favorite
          </button>
          <button
            type="button"
            className="rounded-xl bg-blue-600 text-white px-3 py-2 text-sm hover:bg-blue-700"
            onClick={confirmSelection}
            disabled={selectedCount === 0}
          >
            Use Selected
          </button>
        </div>
      </div>
    </div>
  );
}

// src/components/meals/RecipePickerDrawer.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";

// Optional stores — component gracefully degrades if missing.
let useRecipeStore, usePreferencesStore, useFoodStore, useInventoryStore;
try { useRecipeStore = require("@/store/RecipeStore").useRecipeStore; } catch {}
try { usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore; } catch {}
try { useFoodStore = require("@/store/FoodStore").useFoodStore; } catch {}
try { useInventoryStore = require("@/store/InventoryStore").useInventoryStore; } catch {}

/** LocalStorage fallback for favorites when store not wired */
const FAV_LS_KEY = "suka.recipe.favorites";

export default function RecipePickerDrawer({
  open,
  onClose,
  onSelect,                 // (recipeRef) => void
  defaultFilters = {},      // e.g., { mealSlot:"Dinner", tags:[], mode:"Home", cuisine:"" }
}) {
  const prefs = usePreferencesStore?.() || {};
  const recipesStore = useRecipeStore?.();
  const food = useFoodStore?.() || {};
  const inv = useInventoryStore?.() || { items: [] };

  // --- Search & filter state -------------------------------------------------
  const [query, setQuery] = useState("");
  const [slot, setSlot] = useState(defaultFilters.mealSlot || "Any");
  const [cuisine, setCuisine] = useState(defaultFilters.cuisine || "");
  const [mode, setMode] = useState(defaultFilters.mode || "Home"); // Home | Street | FoodTruck
  const [tags, setTags] = useState(defaultFilters.tags || []);
  const [onlyOnHand, setOnlyOnHand] = useState(false);
  const [hideShellfish, setHideShellfish] = useState(true);
  const [hidePork, setHidePork] = useState(true);

  // --- Household favorites / related controls --------------------------------
  const [viewKind, setViewKind] = useState("all"); // "all" | "favorites" | "related"
  const [boostFavs, setBoostFavs] = useState(true);
  const [simThreshold, setSimThreshold] = useState(0.35); // 0..1; used when "related" view

  // --- Results, paging, and busy state ---------------------------------------
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const listRef = useRef(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  // --- Favorites (from store or LS fallback) ---------------------------------
  const [favIds, setFavIds] = useState(() => getFavsFallback());
  const favSet = useMemo(() => new Set(
    recipesStore?.favorites?.map?.(f => f.id) || favIds
  ), [recipesStore?.favorites, favIds]);

  useEffect(() => {
    if (!open) return;
    // Pull latest favorites from store/automation when opening
    const fetchFavs = async () => {
      if (recipesStore?.listFavorites) {
        try {
          const list = await recipesStore.listFavorites();
          if (Array.isArray(list)) {
            const ids = list.map(r => r.id);
            setFavIds(ids);
            saveFavsFallback(ids);
          }
        } catch {}
      } else if (automation) {
        // optional fallback via automation
        try {
          const res = await automation("recipes.favorites.list", {});
          const ids = Array.isArray(res?.items) ? res.items.map(r => r.id) : getFavsFallback();
          setFavIds(ids);
          saveFavsFallback(ids);
        } catch {}
      }
    };
    fetchFavs();
  }, [open, recipesStore?.listFavorites]);

  // re-fetch results on criteria changes
  useEffect(() => {
    if (!open) return;
    setPage(0);
    setRows([]);
    setHasMore(true);
    setActiveIndex(-1);
    fetchPage(0, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, slot, cuisine, mode, tags.join("|"), onlyOnHand, hideShellfish, hidePork, viewKind, simThreshold, boostFavs]);

  // live updates: recipes/inventory/prefs/favorites
  useEffect(() => {
    const offA = eventBus?.on?.("recipes.updated", () => softRefresh());
    const offB = eventBus?.on?.("inventory.updated", () => softRefresh());
    const offC = eventBus?.on?.("preferences.changed", () => softRefresh());
    const offD = eventBus?.on?.("favorites.updated", (ids) => { setFavIds(Array.isArray(ids) ? ids : getFavsFallback()); softRefresh(); });
    return () => { offA?.(); offB?.(); offC?.(); offD?.(); };
  }, []);

  const softRefresh = () => fetchPage(0, true);

  // --- Fetch a page (store → automation → mock) ------------------------------
  const fetchPage = useCallback(async (nextPage, replace = false) => {
    if (!open) return;
    setBusy(true);
    const payload = {
      q: query.trim(),
      page: nextPage,
      pageSize: 24,
      filters: {
        slot: slot === "Any" ? null : slot,
        cuisine: cuisine || null,
        mode, // Home | Street | FoodTruck
        tags,
        onlyOnHand,
        exclude: { shellfish: hideShellfish, pork: hidePork },
      },
    };

    let data = null;
    if (recipesStore?.search) {
      data = await recipesStore.search(payload);
    } else if (automation) {
      data = await automation("recipes.search", payload);
    }
    if (!data) data = mockSearch(payload); // WA-forward fallback

    const items = Array.isArray(data?.items) ? data.items : [];

    // Household-aware post-processing (filter + ranking)
    const enriched = rankAndFilter(items, {
      viewKind,
      boostFavs,
      simThreshold,
      favSet,
    });

    setRows((prev) => replace ? enriched : [...prev, ...enriched]);
    setHasMore(Boolean(items.length && items.length >= (data?.pageSize || payload.pageSize)));
    setPage(nextPage);
    setBusy(false);
    emitProgress?.("recipes.search.page", { page: nextPage, size: items.length, viewKind });
  }, [open, query, slot, cuisine, mode, tags, onlyOnHand, hideShellfish, hidePork, viewKind, simThreshold, boostFavs, recipesStore, favSet]);

  // infinite scroll
  useEffect(() => {
    if (!open) return;
    const div = listRef.current;
    if (!div) return;
    const onScroll = () => {
      if (!hasMore || busy) return;
      const nearBottom = div.scrollTop + div.clientHeight >= div.scrollHeight - 200;
      if (nearBottom) fetchPage(page + 1, false);
    };
    div.addEventListener("scroll", onScroll);
    return () => div.removeEventListener("scroll", onScroll);
  }, [open, listRef, page, hasMore, busy, fetchPage]);

  // keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (["ArrowDown","ArrowUp","Enter","Escape"].includes(e.key)) e.preventDefault();
      if (e.key === "ArrowDown") setActiveIndex((i) => Math.min(rows.length - 1, i + 1));
      if (e.key === "ArrowUp") setActiveIndex((i) => Math.max(0, i - 1));
      if (e.key === "Enter" && rows[activeIndex]) doSelect(rows[activeIndex]);
      if (e.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, rows, activeIndex]);

  // inventory index for "mostly on hand"
  const invIndex = useMemo(() => {
    const map = new Map();
    for (const i of inv.items || []) {
      const key = `${(i.name || "").toLowerCase()}::${i.unit || "ea"}`;
      map.set(key, (map.get(key) || 0) + Number(i.qty ?? 0));
    }
    return map;
  }, [inv.items]);

  const filteredRows = useMemo(() => {
    if (!onlyOnHand) return rows;
    return rows.filter((r) => isMostlyOnHand(r, invIndex));
  }, [rows, onlyOnHand, invIndex]);

  // Tag suggestions (West African forward + street foods)
  const suggestedTags = useMemo(() => ([
    "jollof","suya","waakye","fufu","egusi","thieb","puff-puff","kelewele","plantain","groundnut","shito",
    "street-food","food-truck","grill","stew","one-pot","batch",
    "high-protein","gluten-free","dairy-free","low-sodium","kosher-style",
  ]), []);

  // actions -------------------------------------------------------------------
  const doSelect = (recipe) => {
    if (!recipe) return;
    const ref = mkRecipeRef(recipe);
    onSelect?.(ref);
    eventBus?.emit?.("recipes.selected", { id: ref.id, slot, mode });
    onClose?.();
  };

  const adaptRecipe = async (recipe) => {
    const base = mkRecipeRef(recipe);
    setBusy(true);
    const fn = async () => {
      const result = await automation?.("recipe.adapt", {
        id: base.id,
        targetCuisine: cuisine || null,
        targetMode: mode || "Home",
        slot: slot === "Any" ? null : slot,
        prefs: {
          hideShellfish, hidePork,
          nutritionGoals: prefs?.nutritionGoals || food?.goals || null,
          householdFavorites: Array.from(favSet),
        },
      });
      const adapted = result?.recipe ? mkRecipeRef(result.recipe) : { ...base, title: annotateTitle(base.title, cuisine, mode) };
      onSelect?.(adapted);
      eventBus?.emit?.("recipes.adapted", { fromId: base.id, toId: adapted.id, cuisine, mode, slot });
      onClose?.();
    };
    await sabbathGuard(fn)();
    setBusy(false);
  };

  // toggle favorite
  const toggleFavorite = async (recipe) => {
    const id = recipe?.id;
    if (!id) return;
    let nextIds = new Set(favSet);
    if (nextIds.has(id)) nextIds.delete(id); else nextIds.add(id);

    // optimistic UI
    setFavIds(Array.from(nextIds));
    saveFavsFallback(Array.from(nextIds));
    eventBus?.emit?.("favorites.updated", Array.from(nextIds));

    try {
      if (recipesStore?.toggleFavorite) {
        await recipesStore.toggleFavorite(id);
      } else if (automation) {
        await automation("recipes.favorites.toggle", { id });
      }
    } catch {
      // rollback on failure (best-effort)
    }
  };

  // UI ------------------------------------------------------------------------
  if (!open) return null;

  return (
    <div className={cx(
      "fixed inset-0 z-40",
      "bg-black/40 backdrop-blur-[1px]",
      "flex justify-end"
    )} role="dialog" aria-modal="true">
      <div className="w-[92%] sm:w-[620px] h-full bg-base-100 border-l border-base-200 shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-base-200 flex items-center justify-between">
          <div>
            <div className="text-lg font-semibold">Pick a Recipe</div>
            <div className="text-xs text-base-content/70">
              West African–forward • favorites-aware • filter by slot, cuisine, mode • adapt for fusion or street/food-truck
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {/* Controls */}
        <div className="p-3 border-b border-base-200">
          <form onSubmit={(e) => { e.preventDefault(); fetchPage(0, true); }} className="grid grid-cols-1 sm:grid-cols-12 gap-2">
            <input
              className="input input-bordered input-sm sm:col-span-6"
              placeholder="Search recipes, ingredients, tags…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select className="select select-bordered select-sm sm:col-span-3" value={slot} onChange={(e) => setSlot(e.target.value)}>
              {["Any","Breakfast","Lunch","Dinner","Snack"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="select select-bordered select-sm sm:col-span-3" value={mode} onChange={(e) => setMode(e.target.value)}>
              {["Home","Street","FoodTruck"].map(m => <option key={m} value={m}>{m}</option>)}
            </select>

            {/* Cuisine with West African focus */}
            <select className="select select-bordered select-sm sm:col-span-5" value={cuisine} onChange={(e) => setCuisine(e.target.value)}>
              <option value="">Cuisine: Any</option>
              <optgroup label="West African">
                <option>Ghanaian</option>
                <option>Nigerian</option>
                <option>Senegalese</option>
                <option>Ivorian</option>
                <option>Sierra Leonean</option>
                <option>Liberian</option>
                <option>Cameroonian</option>
                <option>West African (Regional)</option>
              </optgroup>
              <optgroup label="Popular">
                <option>American</option><option>Italian</option><option>Mexican</option>
                <option>Indian</option><option>Mediterranean</option><option>Caribbean</option>
                <option>African (Other)</option><option>Middle Eastern</option><option>Thai</option>
              </optgroup>
            </select>

            <TagSelector
              className="sm:col-span-7"
              selected={tags}
              suggestions={suggestedTags}
              onChange={setTags}
            />

            {/* Household Favorites controls */}
            <div className="sm:col-span-12 grid grid-cols-1 sm:grid-cols-12 gap-2">
              <select
                className="select select-bordered select-sm sm:col-span-4"
                value={viewKind}
                onChange={(e) => setViewKind(e.target.value)}
                title="Scope"
              >
                <option value="all">Show: All</option>
                <option value="favorites">Show: Household Favorites</option>
                <option value="related">Show: Related to Favorites</option>
              </select>

              <label className="sm:col-span-4 flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="toggle toggle-sm" checked={boostFavs} onChange={(e) => setBoostFavs(e.target.checked)} />
                Boost favorites & related
              </label>

              {viewKind === "related" && (
                <div className="sm:col-span-4 flex items-center gap-2">
                  <span className="text-xs text-base-content/70">Similarity</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={simThreshold}
                    onChange={(e) => setSimThreshold(Number(e.target.value))}
                    className="range range-xs w-full"
                    title="Minimum similarity to favorites"
                  />
                </div>
              )}
            </div>

            {/* Dietary + inventory toggles */}
            <div className="sm:col-span-12 flex flex-wrap items-center gap-3 mt-1">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="toggle toggle-sm" checked={onlyOnHand} onChange={(e) => setOnlyOnHand(e.target.checked)} />
                Only show recipes mostly covered by inventory
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="toggle toggle-sm" checked={hideShellfish} onChange={(e) => setHideShellfish(e.target.checked)} />
                Hide shellfish
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" className="toggle toggle-sm" checked={hidePork} onChange={(e) => setHidePork(e.target.checked)} />
                Hide pork
              </label>
              <div className="ml-auto flex items-center gap-2">
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Search</button>
                <button type="button" className="btn btn-outline btn-sm" onClick={() => { setQuery(""); setTags([]); setCuisine(""); setOnlyOnHand(false); setViewKind("all"); }}>Reset</button>
              </div>
            </div>
          </form>
        </div>

        {/* Content list */}
        <div ref={listRef} className="flex-1 overflow-auto p-3 space-y-3">
          {filteredRows.length === 0 && (
            <EmptyState
              onScan={() => triggerScan()}
              onImportUrl={() => importFromUrl()}
              onManual={() => manualEntry()}
            />
          )}

          {/* If we're boosting, softly announce the household awareness */}
          {boostFavs && favSet.size > 0 && (
            <div className="text-xs text-base-content/70">
              Personalizing with your household favorites ({favSet.size}).
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {filteredRows.map((r, idx) => (
              <RecipeCard
                key={r.id}
                recipe={r}
                favorite={favSet.has(r.id)}
                active={idx === activeIndex}
                onPick={() => doSelect(r)}
                onAdapt={() => adaptRecipe(r)}
                onToggleFavorite={() => toggleFavorite(r)}
                draggable
              />
            ))}
          </div>

          {busy && <div className="text-center text-sm text-base-content/70">Loading…</div>}
          {!busy && hasMore && filteredRows.length > 0 && (
            <div className="text-center">
              <button className="btn btn-ghost btn-sm" onClick={() => fetchPage(page + 1, false)}>Load more</button>
            </div>
          )}
        </div>

        {/* Footer quick actions */}
        <div className="p-3 border-t border-base-200 flex items-center justify-between">
          <div className="text-xs text-base-content/70">
            Tips: Press <kbd className="kbd kbd-xs">↓</kbd>/<kbd className="kbd kbd-xs">↑</kbd> to navigate, <kbd className="kbd kbd-xs">Enter</kbd> to pick, <kbd className="kbd kbd-xs">Esc</kbd> to close.
          </div>
          <div className="flex items-center gap-2">
            <button className="btn btn-outline btn-sm" onClick={() => importFromUrl()}>Import URL</button>
            <button className="btn btn-outline btn-sm" onClick={() => triggerScan()}>Scan Barcode</button>
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );

  /* ------------------------------
      helpers that call automations
     ------------------------------*/
  async function triggerScan() {
    setBusy(true);
    const fn = async () => {
      const result = await automation?.("recipes.scanBarcode", { intent: "add-recipe" });
      if (result?.recipe) doSelect(result.recipe);
      setBusy(false);
    };
    await sabbathGuard(fn)();
  }

  async function importFromUrl() {
    const url = prompt("Paste a recipe URL to import:");
    if (!url) return;
    setBusy(true);
    const fn = async () => {
      const result = await automation?.("recipes.importFromUrl", { url });
      if (result?.recipe) doSelect(result.recipe);
      setBusy(false);
    };
    await sabbathGuard(fn)();
  }

  async function manualEntry() {
    const result = await automation?.("recipes.manualStart", { slot });
    if (result?.recipe) doSelect(result.recipe);
  }
}

/* ========================================================================== */
/* Subcomponents                                                              */
/* ========================================================================== */

function RecipeCard({ recipe, onPick, onAdapt, onToggleFavorite, favorite, active, draggable }) {
  const n = recipe.nutrition || {};
  const kcal = Math.round(n.calories || 0);
  const macros = `P${Math.round(n.protein || 0)} / C${Math.round(n.carbs || 0)} / F${Math.round(n.fat || 0)}`;
  const tags = recipe.tags || [];

  const handleDragStart = (e) => {
    if (!draggable) return;
    const ref = mkRecipeRef(recipe);
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("text/plain", JSON.stringify({ t: "RECIPE_CARD", id: ref.id }));
  };

  return (
    <div
      className={cx(
        "rounded-xl border p-3 bg-base-100 hover:border-base-300 transition",
        active && "ring-2 ring-primary/40",
        recipe.mode === "FoodTruck" && "border-accent/60",
        "border-base-200"
      )}
      draggable={draggable}
      onDragStart={handleDragStart}
      title={recipe.title}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-semibold truncate">{recipe.title}</div>
          <div className="text-xs text-base-content/70 mt-0.5 truncate">
            {recipe.cuisine || "—"} • {recipe.slot || "Any"} • {recipe.mode || "Home"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={cx("btn btn-ghost btn-xs", favorite && "text-error")}
            title={favorite ? "Unfavorite" : "Favorite"}
            aria-label={favorite ? "Unfavorite" : "Favorite"}
            onClick={onToggleFavorite}
          >
            {favorite ? "♥" : "♡"}
          </button>
          <span className="badge badge-ghost">{Math.max(1, recipe.servings || 1)} sv</span>
        </div>
      </div>

      <div className="mt-2 text-xs text-base-content/70">
        {kcal} kcal • {macros}
      </div>

      {tags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.slice(0,5).map(t => <span key={t} className="badge badge-ghost badge-sm">{t}</span>)}
          {tags.length > 5 && <span className="badge badge-ghost badge-sm">+{tags.length-5}</span>}
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button className="btn btn-primary btn-xs" onClick={onPick}>Add</button>
        <button className="btn btn-outline btn-xs" onClick={onAdapt} title="Adapt/fuse to chosen cuisine or mode">Adapt</button>
      </div>
    </div>
  );
}

function TagSelector({ className, selected, suggestions, onChange }) {
  const [text, setText] = useState("");
  const add = (t) => {
    const v = (t || text).trim();
    if (!v) return;
    if (!selected.includes(v)) onChange?.([...selected, v]);
    setText("");
  };
  const remove = (t) => onChange?.(selected.filter((x) => x !== t));

  return (
    <div className={cx("flex items-center gap-2", className)}>
      <div className="flex flex-wrap items-center gap-1 border border-base-300 rounded-lg px-2 py-1 min-h-10 bg-base-100">
        {selected.map((t) => (
          <span key={t} className="badge badge-ghost gap-1">
            {t}
            <button className="ml-1 text-error" onClick={() => remove(t)} aria-label={`Remove ${t}`}>✕</button>
          </span>
        ))}
        <input
          className="input input-xs focus:outline-none border-none grow"
          placeholder="Add tag…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
      </div>
      <details className="dropdown">
        <summary className="btn btn-ghost btn-xs">Suggest</summary>
        <ul className="menu dropdown-content bg-base-100 rounded-box z-[1] w-56 p-2 shadow max-h-64 overflow-auto">
          {suggestions.map((s) => (
            <li key={s}>
              <button onClick={() => add(s)}>{s}</button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function EmptyState({ onScan, onImportUrl, onManual }) {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-8 text-center bg-base-100">
      <div className="text-lg font-semibold">No recipes found</div>
      <p className="text-sm text-base-content/70 mt-1">
        Try different filters — or add one now.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={onManual}>Add Manually</button>
        <button className="btn btn-outline btn-sm" onClick={onImportUrl}>Import from URL</button>
        <button className="btn btn-outline btn-sm" onClick={onScan}>Scan Barcode</button>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* Household-aware ranking/filtering                                          */
/* ========================================================================== */

function rankAndFilter(items, { viewKind, boostFavs, simThreshold, favSet }) {
  if (!items?.length) return [];

  // Build a "profile" from the current favorites found within items (quick client-side)
  const favItems = items.filter(i => favSet.has(i.id));
  const profile = makeProfile(favItems);

  // Score each item by similarity to the profile
  const scored = items.map(r => {
    const sim = similarityToProfile(r, profile);
    const isFav = favSet.has(r.id);
    let score = sim;

    if (boostFavs) {
      if (isFav) score += 0.5;               // strong boost for actual favorites
      else score += Math.min(0.4, sim * 0.6); // softer boost for "related"
    }

    return { ...r, _sim: sim, _isFav: isFav, _score: score };
  });

  // Filter by view
  let out = scored;
  if (viewKind === "favorites") out = out.filter(x => x._isFav);
  if (viewKind === "related")   out = out.filter(x => !x._isFav && x._sim >= simThreshold);

  // Sort by score desc, fallback to title
  out.sort((a, b) => (b._score - a._score) || (a.title || "").localeCompare(b.title || ""));
  return out;
}

function makeProfile(favItems) {
  const tags = new Map(), ings = new Map(), cuisines = new Map(), slots = new Map(), modes = new Map();
  for (const r of favItems || []) {
    for (const t of (r.tags || [])) tags.set(t.toLowerCase(), (tags.get(t.toLowerCase()) || 0) + 1);
    for (const ing of (r.ingredients || [])) {
      const k = (ing.name || "").toLowerCase();
      if (k) ings.set(k, (ings.get(k) || 0) + 1);
    }
    if (r.cuisine) cuisines.set(r.cuisine, (cuisines.get(r.cuisine) || 0) + 1);
    if (r.slot)    slots.set(r.slot, (slots.get(r.slot) || 0) + 1);
    if (r.mode)    modes.set(r.mode, (modes.get(r.mode) || 0) + 1);
  }
  return { tags, ings, cuisines, slots, modes, size: Math.max(1, favItems?.length || 0) };
}

function similarityToProfile(recipe, p) {
  if (!p || !p.size) return 0;

  // simple weighted overlap score (0..1)
  let t = 0, max = 0;

  const norm = (s) => (s || "").toLowerCase();

  // tags (0.4)
  const rtags = (recipe.tags || []).map(norm);
  const tagHit = rtags.reduce((acc, t1) => acc + (p.tags.has(t1) ? 1 : 0), 0);
  t += (tagHit / Math.max(1, rtags.length)) * 0.4;
  max += 0.4;

  // ingredients (0.3)
  const ring = (recipe.ingredients || []).map(i => norm(i.name));
  const ingHit = ring.reduce((acc, n) => acc + (p.ings.has(n) ? 1 : 0), 0);
  t += (ingHit / Math.max(1, ring.length)) * 0.3;
  max += 0.3;

  // cuisine (0.2)
  if (recipe.cuisine && p.cuisines.has(recipe.cuisine)) t += 0.2;
  max += 0.2;

  // slot/mode (0.1)
  let sm = 0;
  if (recipe.slot && p.slots.has(recipe.slot)) sm += 0.06;
  if (recipe.mode && p.modes.has(recipe.mode)) sm += 0.04;
  t += sm; max += 0.1;

  return Math.min(1, t / Math.max(0.0001, max));
}

/* ========================================================================== */
/* Helpers                                                                    */
/* ========================================================================== */

function mkRecipeRef(any) {
  return {
    id: any.id || any._id || `recipe-${Math.random().toString(36).slice(2, 9)}`,
    title: any.title || any.name || "Recipe",
    servings: any.servings || any.yield || 1,
    nutrition: any.nutrition || any.macros || null, // {calories, protein, carbs, fat}
    slot: any.slot || "Any",
    cuisine: any.cuisine || "",
    mode: any.mode || "Home",
    tags: Array.isArray(any.tags) ? any.tags : [],
    ingredients: Array.isArray(any.ingredients) ? any.ingredients : [],
  };
}

function annotateTitle(title, cuisine, mode) {
  const parts = [title];
  if (cuisine) parts.push(`(${cuisine})`);
  if (mode && mode !== "Home") parts.push(`[${mode}]`);
  return parts.join(" ");
}

function isMostlyOnHand(recipe, invIndex) {
  const ings = recipe.ingredients || [];
  if (!ings.length) return false;
  let covered = 0;
  for (const ing of ings) {
    const key = `${(ing.name || "").toLowerCase()}::${ing.unit || "ea"}`;
    const onHand = invIndex.get(key) || 0;
    if (onHand >= Number(ing.qty || 0)) covered += 1;
  }
  return covered / ings.length >= 0.6; // configurable 60%
}

/** West African–forward mock search with a few global street foods */
function mockSearch({ q, page, pageSize, filters }) {
  const waMode = filters?.mode || "Home";
  const slot = filters?.slot || "Any";

  const base = [
    // West African mains / bowls
    {
      id: "wa-1",
      title: "Jollof Rice with Chicken",
      cuisine: "West African (Regional)",
      slot: "Dinner",
      mode: waMode,
      nutrition: { calories: 620, protein: 32, carbs: 78, fat: 18 },
      servings: 4,
      tags: ["jollof", "one-pot", "family"],
      ingredients: [
        { name: "rice", qty: 2, unit: "cup" },
        { name: "tomato paste", qty: 1, unit: "can" },
        { name: "chicken", qty: 1, unit: "lb" },
        { name: "onion", qty: 1, unit: "ea" },
      ],
    },
    {
      id: "wa-2",
      title: "Ghanaian Waakye Plate",
      cuisine: "Ghanaian",
      slot: "Lunch",
      mode: waMode,
      nutrition: { calories: 540, protein: 24, carbs: 85, fat: 12 },
      servings: 3,
      tags: ["waakye", "beans-and-rice", "batch"],
      ingredients: [
        { name: "rice", qty: 2, unit: "cup" },
        { name: "black-eyed peas", qty: 1, unit: "cup" },
        { name: "gari", qty: 0.5, unit: "cup" },
      ],
    },
    {
      id: "wa-3",
      title: "Senegalese Thieboudienne (Ceebu Jën)",
      cuisine: "Senegalese",
      slot: "Dinner",
      mode: waMode,
      nutrition: { calories: 680, protein: 36, carbs: 92, fat: 18 },
      servings: 4,
      tags: ["thieb", "fish", "one-pot"],
      ingredients: [
        { name: "fish", qty: 1, unit: "lb" },
        { name: "rice", qty: 2, unit: "cup" },
        { name: "tomato", qty: 4, unit: "ea" },
        { name: "cassava", qty: 1, unit: "ea" },
      ],
    },

    // Soups / swallow
    {
      id: "wa-4",
      title: "Nigerian Egusi Soup with Fufu",
      cuisine: "Nigerian",
      slot: "Dinner",
      mode: waMode,
      nutrition: { calories: 710, protein: 34, carbs: 62, fat: 34 },
      servings: 4,
      tags: ["egusi", "swallow", "stew"],
      ingredients: [
        { name: "egusi seeds", qty: 1, unit: "cup" },
        { name: "spinach", qty: 1, unit: "bunch" },
        { name: "goat", qty: 1, unit: "lb" },
      ],
    },
    {
      id: "wa-5",
      title: "Light Soup with Fufu",
      cuisine: "Ghanaian",
      slot: "Dinner",
      mode: waMode,
      nutrition: { calories: 560, protein: 28, carbs: 68, fat: 16 },
      servings: 4,
      tags: ["fufu", "stew", "comfort"],
      ingredients: [
        { name: "cassava", qty: 2, unit: "ea" },
        { name: "plantain", qty: 2, unit: "ea" },
        { name: "chicken", qty: 1, unit: "lb" },
      ],
    },

    // Street snacks
    {
      id: "wa-6",
      title: "Suya Beef Skewers",
      cuisine: "Nigerian",
      slot: "Dinner",
      mode: "Street",
      nutrition: { calories: 420, protein: 36, carbs: 8, fat: 26 },
      servings: 4,
      tags: ["suya", "grill", "street-food", "high-protein"],
      ingredients: [
        { name: "beef", qty: 1, unit: "lb" },
        { name: "groundnut powder", qty: 0.5, unit: "cup" },
        { name: "onion", qty: 1, unit: "ea" },
      ],
    },
    {
      id: "wa-7",
      title: "Kelewele (Spiced Fried Plantains)",
      cuisine: "Ghanaian",
      slot: "Snack",
      mode: "Street",
      nutrition: { calories: 360, protein: 3, carbs: 56, fat: 14 },
      servings: 4,
      tags: ["kelewele", "plantain", "street-food"],
      ingredients: [
        { name: "plantain", qty: 4, unit: "ea" },
        { name: "ginger", qty: 1, unit: "tbsp" },
      ],
    },
    {
      id: "wa-8",
      title: "Puff-Puff",
      cuisine: "Nigerian",
      slot: "Snack",
      mode: "Street",
      nutrition: { calories: 290, protein: 5, carbs: 44, fat: 10 },
      servings: 6,
      tags: ["puff-puff", "street-food", "sweet"],
      ingredients: [
        { name: "flour", qty: 2, unit: "cup" },
        { name: "yeast", qty: 1, unit: "tbsp" },
        { name: "sugar", qty: 0.25, unit: "cup" },
      ],
    },

    // Bowls / trucks with regional twist
    {
      id: "wa-9",
      title: "Grilled Chicken Yassa Bowl",
      cuisine: "Senegalese",
      slot: "Lunch",
      mode: "FoodTruck",
      nutrition: { calories: 520, protein: 40, carbs: 58, fat: 14 },
      servings: 2,
      tags: ["yassa", "bowl", "food-truck"],
      ingredients: [
        { name: "chicken", qty: 1, unit: "lb" },
        { name: "onion", qty: 2, unit: "ea" },
        { name: "rice", qty: 1, unit: "cup" },
      ],
    },

    // A couple of non-WA street staples for variety
    {
      id: "sf-1",
      title: "Taco al Pastor (Street)",
      cuisine: "Mexican",
      slot,
      mode: "Street",
      nutrition: { calories: 480, protein: 24, carbs: 46, fat: 22 },
      servings: 3,
      tags: ["street-food", "grill", "quick"],
      ingredients: [
        { name: "pork", qty: 1, unit: "lb" },
        { name: "tortilla", qty: 8, unit: "ea" },
      ],
    },
    {
      id: "sf-2",
      title: "Falafel Wrap (Food Truck)",
      cuisine: "Middle Eastern",
      slot: "Lunch",
      mode: "FoodTruck",
      nutrition: { calories: 540, protein: 18, carbs: 68, fat: 18 },
      servings: 2,
      tags: ["food-truck", "vegetarian", "quick"],
      ingredients: [
        { name: "chickpeas", qty: 1.5, unit: "cup" },
        { name: "pita", qty: 2, unit: "ea" },
      ],
    },
  ];

  const matches = base
    .filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()) || (r.tags || []).some(t => t.includes(q.toLowerCase())))
    .filter((r) => !filters?.slot || r.slot === filters.slot)
    .filter((r) => !filters?.cuisine || r.cuisine === filters.cuisine);

  const start = page * pageSize;
  const items = matches.slice(start, start + pageSize);
  return { items, pageSize };
}

/* -------- Favorites fallback (LS) ------- */
function getFavsFallback() {
  try { const raw = localStorage.getItem(FAV_LS_KEY); return raw ? JSON.parse(raw) : []; } catch { return []; }
}
function saveFavsFallback(ids) {
  try { localStorage.setItem(FAV_LS_KEY, JSON.stringify(ids || [])); } catch {}
}

// src/components/meals/RecipeVault.jsx
/**
 * RecipeVault
 *
 * DOMAIN ROLE (WEB OF MEANING):
 * - Primary domain: cooking / meals.
 * - Connected domains: storehouse/provisioning, grocery/pricebook, garden (future), animals (future).
 *
 * CONCEPT:
 * - This is the household’s recipe “storehouse of ideas”:
 *   a place to keep flows that can be woven into meal rhythms and provision cycles.
 *
 * TOOL MODE:
 * - Works as a standalone recipe library:
 *   search, filter, tags, favorites, import, export, send to grocery list.
 *
 * STEWARDSHIP MODE:
 * - Same UI, but events and payloads are richer so other domains can react:
 *   - storehouse posture (inventory) responds to recipes added to rhythms.
 *   - grocery/provision lists reflect chosen recipes.
 *   - future insights can detect patterns in cycles, seasons, and storehouse impact.
 *
 * KEY HOOKS:
 * - Inventory-aware filter: “only show recipes mostly covered by storehouse”.
 * - eventBus emissions for:
 *   - grocery updates,
 *   - meal rhythm / plan updates,
 *   - favorites changes,
 *   - vault usage telemetry (for future insights).
 *
 * TODO[seasons]:
 * - Integrate seasonality engine (seasonRules.config) to:
 *   - highlight recipes that align with current season/feast windows,
 *   - optionally add an “In-season ingredients only” toggle.
 *
 * TODO[dependencies]:
 * - Allow recipes to declare upstream domains (e.g., “dependsOn: garden, animals”)
 *   so dependencyMap can surface where yields should come from.
 *
 * TODO[insights]:
 * - Emit “recipes.vault.insights.ready” with summarized patterns
 *   (e.g., heavy grain usage before feasts, strong reliance on a small set of proteins).
 */

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";

// 🔗 Vault pipeline & compliance
import {
  prepareArtifactForVault,
  saveArtifactToVault,
} from "@/services/vault/VaultSavePipeline";
import { COMPLIANCE_STATUS } from "@/services/compliance/ComplianceContract";
import HouseholdComplianceWizard from "@/features/compliance/HouseholdComplianceWizard";

// Optional dependencies (works without them)
let NBAToolbar;
try {
  NBAToolbar = require("./NBAToolbar.jsx").default;
} catch {}

let useRecipeStore, useInventoryStore, usePreferencesStore, useFoodStore;
try {
  useRecipeStore = require("@/store/RecipeStore").useRecipeStore;
} catch {}
try {
  useInventoryStore = require("@/store/InventoryStore").useInventoryStore;
} catch {}
try {
  usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore;
} catch {}
try {
  useFoodStore = require("@/store/FoodStore").useFoodStore;
} catch {}

const FAV_LS_KEY = "suka.recipe.favorites";

export default function RecipeVault({
  initialQuery = "",
  defaultMode = "Home", // Home | Street | FoodTruck
  onOpenRecipe, // (recipeId) => void
  onAddToMealRhythm, // ({recipe, dayKey?, slot?}) => void   // renamed from "Plan" in spirit, still optional
  // MODE CONTEXT
  stewardshipMode = false, // false = TOOL MODE, true = STEWARDSHIP MODE
  currentSeasonLabel, // e.g. "Spring Planting", "Lean Season", "Feast Season"
  currentCycleLabel = "Everyday meal rhythm", // e.g. "Weeknight cycle", "Sabbath-eve rhythm"
}) {
  const recipesStore = useRecipeStore?.();
  const invStore = useInventoryStore?.();
  const prefsStore = usePreferencesStore?.();
  const foodStore = useFoodStore?.();

  const modeContext = stewardshipMode ? "stewardship" : "tool";

  // Household identity (for vault pipeline)
  const currentHouseholdId =
    prefsStore?.currentHouseholdId ||
    prefsStore?.householdId ||
    invStore?.householdId ||
    "default";

  // ------------------- Query / Facets -------------------
  const [q, setQ] = useState(initialQuery);
  const [mode, setMode] = useState(defaultMode); // kitchen context: Home | Street | FoodTruck rhythms
  const [slot, setSlot] = useState("Any");
  const [cuisine, setCuisine] = useState("");
  const [tags, setTags] = useState([]);
  const [onlyOnHand, setOnlyOnHand] = useState(false);
  const [hideShellfish, setHideShellfish] = useState(true);
  const [hidePork, setHidePork] = useState(true);
  const [sortKey, setSortKey] = useState("relevance"); // relevance|alpha|calories|protein
  const [viewKind, setViewKind] = useState("all"); // all|favorites|related
  const [boostFavs, setBoostFavs] = useState(true);
  const [simThreshold, setSimThreshold] = useState(0.35);

  // ------------------- UI State -------------------------
  const [layout, setLayout] = useState("grid"); // 'grid' | 'list'
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const listRef = useRef(null);

  // ✅ Compliance wizard state for “Adapt to Household”
  const [showComplianceWizard, setShowComplianceWizard] = useState(false);
  const [pendingArtifact, setPendingArtifact] = useState(null);

  // Favorites (store → automation → localStorage)
  const [favIds, setFavIds] = useState(() => getFavsFallback());
  const favSet = useMemo(
    () => new Set(recipesStore?.favorites?.map?.((f) => f.id) || favIds),
    [recipesStore?.favorites, favIds]
  );

  // Nutrition goals (for future adapt prompts / insight hooks)
  const goals = useMemo(() => {
    const g = prefsStore?.nutritionGoals || foodStore?.goals || {};
    return {
      calories: num(g.calories, 2000),
      protein: num(g.protein, 75),
      carbs: num(g.carbs, 250),
      fat: num(g.fat, 70),
    };
  }, [prefsStore?.nutritionGoals, foodStore?.goals]);

  // ------------------- Boot / events --------------------
  useEffect(() => {
    (async () => {
      // Pull favorites when landing
      if (recipesStore?.listFavorites) {
        try {
          const list = await recipesStore.listFavorites();
          if (Array.isArray(list)) {
            const ids = list.map((r) => r.id);
            setFavIds(ids);
            saveFavsFallback(ids);
          }
        } catch {}
      } else if (automation) {
        try {
          const res = await automation("recipes.favorites.list", {});
          const ids = Array.isArray(res?.items)
            ? res.items.map((r) => r.id)
            : getFavsFallback();
          setFavIds(ids);
          saveFavsFallback(ids);
        } catch {}
      }

      // Telemetry: vault opened (for insights engine later)
      eventBus?.emit?.("recipes.vault.opened", {
        context: modeContext,
        ts: new Date().toISOString(),
      });
    })();
  }, [recipesStore?.listFavorites, modeContext]);

  // Refresh on filters
  useEffect(() => {
    setPage(0);
    setRows([]);
    setHasMore(true);
    fetchPage(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    q,
    mode,
    slot,
    cuisine,
    tags.join("|"),
    onlyOnHand,
    hideShellfish,
    hidePork,
    viewKind,
    simThreshold,
    boostFavs,
    sortKey,
  ]);

  // Live updates from related domains
  useEffect(() => {
    const offA = eventBus?.on?.("recipes.updated", () => softRefresh());
    // When storehouse/inventory shifts, re-check which recipes are mostly covered
    const offB = eventBus?.on?.("inventory.updated", () => softRefresh());
    const offC = eventBus?.on?.("favorites.updated", (ids) => {
      setFavIds(Array.isArray(ids) ? ids : getFavsFallback());
      softRefresh();
    });
    return () => {
      offA?.();
      offB?.();
      offC?.();
    };
  }, []);

  const softRefresh = () => fetchPage(0, true);

  // ------------------- Fetch page -----------------------
  const fetchPage = useCallback(
    async (nextPage, replace) => {
      setBusy(true);
      const payload = {
        q: q.trim(),
        page: nextPage,
        pageSize: 36,
        filters: {
          mode,
          slot: slot === "Any" ? null : slot,
          cuisine: cuisine || null,
          tags,
          onlyOnHand,
          exclude: { shellfish: hideShellfish, pork: hidePork },
        },
        // NOTE: goals and modeContext can be used by a smarter backend in future
        goals,
        modeContext,
      };

      let data = null;
      if (recipesStore?.search) {
        data = await recipesStore.search(payload);
      } else if (automation) {
        data = await automation("recipes.search", payload);
      }
      if (!data) data = mockSearch(payload); // West African–forward fallback

      let items = Array.isArray(data?.items) ? data.items : [];

      // Household-aware re-rank + filter
      items = rankAndFilter(items, {
        viewKind,
        boostFavs,
        simThreshold,
        favSet,
      });

      // Sorting
      items = sortItems(items, sortKey, favSet);

      setRows((prev) => (replace ? items : [...prev, ...items]));
      setHasMore(
        Boolean(
          items.length && items.length >= (data?.pageSize || payload.pageSize)
        )
      );
      setBusy(false);
      setPage(nextPage);

      emitProgress?.("recipes.vault.page", {
        nextPage,
        count: items.length,
        context: modeContext,
        season: currentSeasonLabel || null,
        cycle: currentCycleLabel || null,
      });
    },
    [
      q,
      mode,
      slot,
      cuisine,
      tags,
      onlyOnHand,
      hideShellfish,
      hidePork,
      viewKind,
      simThreshold,
      boostFavs,
      sortKey,
      recipesStore,
      favSet,
      goals,
      modeContext,
      currentSeasonLabel,
      currentCycleLabel,
    ]
  );

  // Infinite scroll
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      if (!hasMore || busy) return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200)
        fetchPage(page + 1, false);
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [listRef, page, hasMore, busy, fetchPage]);

  // Inventory index (storehouse posture)
  const invIndex = useMemo(() => {
    const map = new Map();
    for (const i of invStore?.items || []) {
      const key = `${(i.name || "").toLowerCase()}::${i.unit || "ea"}`;
      map.set(key, (map.get(key) || 0) + Number(i.qty ?? 0));
    }
    return map;
  }, [invStore?.items]);

  const visibleRows = useMemo(() => {
    if (!onlyOnHand) return rows;
    return rows.filter((r) => isMostlyOnHand(r, invIndex));
  }, [rows, onlyOnHand, invIndex]);

  // Light future-insight hook: vault composition
  useEffect(() => {
    // TODO[intelligence]: Use this hook to emit high-level vault composition
    // e.g., which ingredients dominate, how many recipes are storehouse-covered, etc.
    // eventBus?.emit?.("recipes.vault.insights.ready", { ... });
  }, [visibleRows.length, onlyOnHand, modeContext]);

  // Bulk selection
  const allChecked =
    visibleRows.length > 0 && visibleRows.every((r) => selected.has(r.id));
  const toggleAll = (checked) => {
    const next = new Set(selected);
    if (checked) visibleRows.forEach((r) => next.add(r.id));
    else visibleRows.forEach((r) => next.delete(r.id));
    setSelected(next);
  };

  // ------------------- Vault save pipeline hook -------------------
  /**
   * Capture the raw recipe input from the UI (title, ingredients, steps, etc.),
   * run it through the vault pipeline (normalize → StepGraph → compliance),
   * and either:
   *  - open the HouseholdComplianceWizard if not COMPLIANT, or
   *  - save directly to the Vault when COMPLIANT.
   *
   * This sits in the imports → intelligence → vault → automation chain.
   */
  const handleSaveRecipe = useCallback(
    async (rawInput) => {
      if (!rawInput || typeof rawInput !== "object") return;

      const householdId = currentHouseholdId || "default";

      try {
        // Step 1: normalize + StepGraph + compliance
        const { artifact, compliance } = await prepareArtifactForVault({
          domain: "cooking",
          householdId,
          rawInput,
        });

        const status = compliance?.status || COMPLIANCE_STATUS.NEEDS_REVIEW;

        // Step 2: if there are conflicts, open the shared wizard
        if (status !== COMPLIANCE_STATUS.COMPLIANT) {
          setPendingArtifact({ artifact, compliance });
          setShowComplianceWizard(true);
          return;
        }

        // Step 3: save directly to the Vault
        await saveArtifactToVault({
          domain: "cooking",
          householdId,
          artifact,
        });

        softRefresh();

        eventBus?.emit?.("recipes.vault.savedViaPipeline", {
          context: modeContext,
          recipeId: artifact.id,
          complianceStatus: status,
        });
      } catch (err) {
        // Defensive: pipeline should not break the Vault UI
        // eslint-disable-next-line no-console
        console.error("[RecipeVault] handleSaveRecipe failed", err);
      }
    },
    [currentHouseholdId, modeContext, softRefresh]
  );

  // Actions (import/export/etc.) – kitchen & storehouse flows
  const actions = [
    {
      key: "importUrl",
      label: "Import from URL",
      intent: "outline",
      onClick: () => importFromUrl(),
      tooltip: "Pull a recipe into your vault from a link",
      guardSabbath: true,
    },
    {
      key: "scan",
      label: "Scan Package",
      intent: "outline",
      onClick: () => scanBarcode(),
      tooltip: "Scan packaging to plant a recipe",
      guardSabbath: true,
    },
    {
      key: "manual",
      label: "Add Recipe by Hand",
      intent: "outline",
      onClick: () => manualEntry(),
      tooltip: "Shape a new recipe directly",
    },
    {
      key: "exportCSV",
      label: "Export CSV",
      intent: "ghost",
      onClick: () => exportCSV(),
      tooltip: "Export visible recipes for your records",
    },
    {
      key: "sendGrocery",
      label: "Send to Provision List",
      onClick: () => bulkSendToGrocery(),
      disabled: selected.size === 0,
    },
    {
      key: "delete",
      label: "Remove from Vault",
      intent: "danger",
      onClick: () => bulkDelete(),
      disabled: selected.size === 0,
      confirm: "Remove selected recipes from your vault?",
    },
  ];

  return (
    <>
      <div className="rounded-2xl border border-base-200 bg-base-100 shadow-md overflow-hidden">
        {/* Header */}
        <div className="p-4 border-b border-base-200 flex items-center justify-between gap-3">
          <div>
            <div className="text-xl font-semibold">Recipe Vault</div>
            <div className="text-xs text-base-content/70">
              Household recipes for your meal rhythms
              {currentSeasonLabel && (
                <>
                  {" "}
                  • Season:{" "}
                  <span className="font-medium">{currentSeasonLabel}</span>
                </>
              )}
              {stewardshipMode ? (
                <> • Connected to storehouse & feast planning</>
              ) : (
                <> • Works alone now, ready to be woven later</>
              )}
            </div>
          </div>
          {NBAToolbar ? (
            <NBAToolbar actions={actions} size="sm" />
          ) : (
            <div className="flex items-center gap-2">
              {actions.map((a) => (
                <button
                  key={a.key}
                  className={cx(
                    "btn btn-sm",
                    a.intent === "danger"
                      ? "btn-error"
                      : a.intent === "outline"
                      ? "btn-outline"
                      : "btn-ghost"
                  )}
                  onClick={a.onClick}
                  disabled={a.disabled}
                  title={a.tooltip}
                >
                  {a.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Filters */}
        <div className="p-3 border-b border-base-200">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-2">
            <input
              className="input input-bordered input-sm lg:col-span-4"
              placeholder="Search recipes, ingredients, tags…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <select
              className="select select-bordered select-sm lg:col-span-2"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
            >
              {["Home", "Street", "FoodTruck"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <select
              className="select select-bordered select-sm lg:col-span-2"
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
            >
              {["Any", "Breakfast", "Lunch", "Dinner", "Snack"].map((s) => (
                <option key={s}>{s}</option>
              ))}
            </select>
            <select
              className="select select-bordered select-sm lg:col-span-2"
              value={cuisine}
              onChange={(e) => setCuisine(e.target.value)}
            >
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
                <option>American</option>
                <option>Mexican</option>
                <option>Indian</option>
                <option>Mediterranean</option>
                <option>Caribbean</option>
                <option>African (Other)</option>
                <option>Middle Eastern</option>
                <option>Thai</option>
              </optgroup>
            </select>
            <SortSelect
              className="lg:col-span-2"
              value={sortKey}
              onChange={setSortKey}
            />
            <TagEditor
              className="lg:col-span-12"
              value={tags}
              onChange={setTags}
            />
            <div className="lg:col-span-12 flex flex-wrap items-center gap-3">
              <ScopeSelect value={viewKind} onChange={setViewKind} />
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={boostFavs}
                  onChange={(e) => setBoostFavs(e.target.checked)}
                />
                Boost favorites & related
              </label>
              {viewKind === "related" && (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-base-content/70">
                    Similarity
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={simThreshold}
                    onChange={(e) => setSimThreshold(Number(e.target.value))}
                    className="range range-xs w-40"
                  />
                </div>
              )}
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={onlyOnHand}
                  onChange={(e) => setOnlyOnHand(e.target.checked)}
                />
                Only show recipes mostly covered by storehouse
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={hideShellfish}
                  onChange={(e) => setHideShellfish(e.target.checked)}
                />
                Hide shellfish
              </label>
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  className="toggle toggle-sm"
                  checked={hidePork}
                  onChange={(e) => setHidePork(e.target.checked)}
                />
                Hide pork
              </label>

              <div className="ml-auto flex items-center gap-2">
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setLayout(layout === "grid" ? "list" : "grid")}
                  title="Toggle layout"
                >
                  {layout === "grid" ? "List" : "Grid"}
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    setQ("");
                    setTags([]);
                    setCuisine("");
                    setOnlyOnHand(false);
                    setViewKind("all");
                    setSortKey("relevance");
                  }}
                >
                  Reset filters
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Bulk bar */}
        <div className="px-3 py-2 border-b border-base-200 flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="checkbox checkbox-sm"
              checked={allChecked}
              onChange={(e) => toggleAll(e.target.checked)}
            />
            Select all visible
          </label>
          <div className="text-xs text-base-content/70">
            {selected.size} chosen for this cycle
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              className="btn btn-ghost btn-xs"
              disabled={selected.size === 0}
              onClick={() => bulkSendToGrocery()}
            >
              Send to Provision List
            </button>
            <button
              className="btn btn-ghost btn-xs"
              disabled={selected.size === 0}
              onClick={() => bulkAddToMealRhythm()}
            >
              Weave into Meal Rhythm
            </button>
            <button
              className="btn btn-error btn-xs"
              disabled={selected.size === 0}
              onClick={() => bulkDelete()}
            >
              Remove from Vault
            </button>
          </div>
        </div>

        {/* Content */}
        <div ref={listRef} className="max-h-[65vh] overflow-auto p-3">
          {!!visibleRows.length && (
            <div
              className={cx(
                layout === "grid"
                  ? "grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3"
                  : "space-y-2"
              )}
            >
              {visibleRows.map((r) =>
                layout === "grid" ? (
                  <VaultCard
                    key={r.id}
                    recipe={r}
                    checked={selected.has(r.id)}
                    onChecked={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        v ? next.add(r.id) : next.delete(r.id);
                        return next;
                      })
                    }
                    favorite={favSet.has(r.id)}
                    onToggleFavorite={() => toggleFavorite(r)}
                    onOpen={() => onOpenRecipe?.(r.id)}
                    onAdd={() => onAddToMealRhythm?.({ recipe: r, slot })}
                    onSendGrocery={() => sendRecipeToGrocery(r)}
                  />
                ) : (
                  <VaultRow
                    key={r.id}
                    recipe={r}
                    checked={selected.has(r.id)}
                    onChecked={(v) =>
                      setSelected((prev) => {
                        const next = new Set(prev);
                        v ? next.add(r.id) : next.delete(r.id);
                        return next;
                      })
                    }
                    favorite={favSet.has(r.id)}
                    onToggleFavorite={() => toggleFavorite(r)}
                    onOpen={() => onOpenRecipe?.(r.id)}
                    onAdd={() => onAddToMealRhythm?.({ recipe: r, slot })}
                    onSendGrocery={() => sendRecipeToGrocery(r)}
                  />
                )
              )}
            </div>
          )}

          {!busy && visibleRows.length === 0 && (
            <EmptyVault
              onManual={() => manualEntry()}
              onImportUrl={() => importFromUrl()}
              onScan={() => scanBarcode()}
            />
          )}

          {busy && (
            <div className="text-center text-sm text-base-content/70 mt-2">
              Loading…
            </div>
          )}

          {!busy && hasMore && visibleRows.length > 0 && (
            <div className="text-center mt-2">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => fetchPage(page + 1, false)}
              >
                Load more
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ✅ Shared Adapt-to-Household compliance wizard */}
      {showComplianceWizard && pendingArtifact && (
        <HouseholdComplianceWizard
          domain="cooking"
          artifact={pendingArtifact.artifact}
          compliance={pendingArtifact.compliance}
          onResolve={async (adaptedArtifact) => {
            const householdId = currentHouseholdId || "default";

            try {
              await saveArtifactToVault({
                domain: "cooking",
                householdId,
                artifact: adaptedArtifact,
              });

              eventBus?.emit?.("recipes.vault.complianceResolvedAndSaved", {
                context: modeContext,
                recipeId: adaptedArtifact.id,
                complianceStatus: COMPLIANCE_STATUS.COMPLIANT,
              });

              softRefresh();
            } finally {
              setShowComplianceWizard(false);
              setPendingArtifact(null);
            }
          }}
          onCancel={() => {
            setShowComplianceWizard(false);
            setPendingArtifact(null);
          }}
        />
      )}
    </>
  );

  // ------------------- Actions impl ---------------------
  async function importFromUrl() {
    const url = prompt("Paste a recipe URL to import into your vault:");
    if (!url) return;
    setBusy(true);
    const fn = async () => {
      const res = await automation?.("recipes.importFromUrl", { url });
      if (res?.recipe) {
        softRefresh();
        eventBus?.emit?.("recipes.vault.importedFromUrl", {
          context: modeContext,
          recipeId: res.recipe.id,
        });
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  }

  async function scanBarcode() {
    setBusy(true);
    const fn = async () => {
      const res = await automation?.("recipes.scanBarcode", {
        intent: "add-recipe",
      });
      if (res?.recipe) {
        softRefresh();
        eventBus?.emit?.("recipes.vault.scannedPackage", {
          context: modeContext,
          recipeId: res.recipe.id,
        });
      }
      setBusy(false);
    };
    await sabbathGuard(fn)();
  }

  async function manualEntry() {
    // Existing automation flow still supported.
    // If backend returns a rawInput payload, we send it through the vault pipeline.
    const res = await automation?.("recipes.manualStart", {
      slot: slot === "Any" ? null : slot,
    });

    if (res?.rawInput) {
      // New pipeline-aware flow
      await handleSaveRecipe(res.rawInput);
      return;
    }

    if (res?.recipe) {
      // Backward-compatible legacy path
      softRefresh();
      eventBus?.emit?.("recipes.vault.manualCreated", {
        context: modeContext,
        recipeId: res.recipe.id,
      });
    }
  }

  function exportCSV() {
    const header = [
      "id",
      "title",
      "cuisine",
      "slot",
      "mode",
      "servings",
      "calories",
      "protein",
      "carbs",
      "fat",
      "tags",
    ];
    const rowsCsv = visibleRows.map((r) =>
      [
        r.id,
        csv(r.title),
        r.cuisine || "",
        r.slot || "",
        r.mode || "",
        r.servings || 1,
        Math.round(r.nutrition?.calories || 0),
        Math.round(r.nutrition?.protein || 0),
        Math.round(r.nutrition?.carbs || 0),
        Math.round(r.nutrition?.fat || 0),
        (r.tags || []).join(";"),
      ].join(",")
    );
    const blob = new Blob([[header.join(","), ...rowsCsv].join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "recipes.csv";
    a.click();
    URL.revokeObjectURL(url);

    eventBus?.emit?.("recipes.vault.exportedCsv", {
      context: modeContext,
      count: visibleRows.length,
    });
  }

  async function bulkSendToGrocery() {
    const ids = Array.from(selected);
    const payload = { recipeIds: ids };
    await automation?.("grocery.addFromRecipes", payload);
    eventBus?.emit?.("grocery.updated");
    eventBus?.emit?.("recipes.vault.sentToProvisionList", {
      context: modeContext,
      recipeIds: ids,
    });
  }

  async function bulkAddToMealRhythm() {
    const ids = Array.from(selected);
    const res = await automation?.("meal.bulkAddRecipes", {
      recipeIds: ids,
      slot: slot === "Any" ? null : slot,
    });
    if (res?.ok) {
      eventBus?.emit?.("mealPlan.updated", {
        scope: "all",
        reason: "bulk.add",
        context: modeContext,
      });
      eventBus?.emit?.("recipes.vault.wovenIntoMealRhythm", {
        recipeIds: ids,
        slot: slot === "Any" ? null : slot,
        context: modeContext,
      });
    }
  }

  async function bulkDelete() {
    if (!confirm("Remove selected recipes from your vault?")) return;
    const ids = Array.from(selected);
    if (recipesStore?.deleteMany) {
      await recipesStore.deleteMany(ids);
    } else if (automation) {
      await automation("recipes.deleteMany", { ids });
    }
    setSelected(new Set());
    softRefresh();
    eventBus?.emit?.("recipes.vault.removedMany", {
      context: modeContext,
      recipeIds: ids,
    });
  }

  async function sendRecipeToGrocery(recipe) {
    await automation?.("grocery.addFromRecipe", { recipeId: recipe.id });
    eventBus?.emit?.("grocery.updated");
    eventBus?.emit?.("recipes.vault.sentSingleToProvisionList", {
      context: modeContext,
      recipeId: recipe.id,
    });
  }

  async function toggleFavorite(recipe) {
    const id = recipe?.id;
    if (!id) return;
    const next = new Set(favSet);
    let favored;
    if (next.has(id)) {
      next.delete(id);
      favored = false;
    } else {
      favored = true;
      next.add(id);
    }
    const arr = Array.from(next);
    setFavIds(arr);
    saveFavsFallback(arr);
    eventBus?.emit?.("favorites.updated", arr);
    eventBus?.emit?.("recipes.vault.favoriteToggled", {
      context: modeContext,
      recipeId: id,
      favored,
    });

    try {
      if (recipesStore?.toggleFavorite) await recipesStore.toggleFavorite(id);
      else if (automation) await automation("recipes.favorites.toggle", { id });
    } catch {}
  }
}

/* ------------------------------ Subcomponents ------------------------------ */

function SortSelect({ className, value, onChange }) {
  return (
    <select
      className={cx("select select-bordered select-sm", className)}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="relevance">Sort: Household fit</option>
      <option value="alpha">Sort: A → Z</option>
      <option value="calories">Sort: Calories</option>
      <option value="protein">Sort: Protein</option>
    </select>
  );
}

function ScopeSelect({ value, onChange }) {
  return (
    <select
      className="select select-bordered select-sm"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="all">Show: All recipes</option>
      <option value="favorites">Show: Household favorites</option>
      <option value="related">Show: Related to favorites</option>
    </select>
  );
}

function TagEditor({ className, value, onChange }) {
  const [text, setText] = useState("");
  const suggestions = [
    "jollof",
    "suya",
    "waakye",
    "fufu",
    "egusi",
    "thieb",
    "puff-puff",
    "kelewele",
    "plantain",
    "groundnut",
    "shito",
    "street-food",
    "food-truck",
    "grill",
    "stew",
    "one-pot",
    "batch",
    "high-protein",
    "gluten-free",
    "dairy-free",
    "low-sodium",
    "kosher-style",
  ];
  const add = (t) => {
    const v = (t || text).trim();
    if (!v) return;
    if (!value.includes(v)) onChange?.([...value, v]);
    setText("");
  };
  const remove = (t) => onChange?.(value.filter((x) => x !== t));
  return (
    <div className={cx("flex items-center gap-2", className)}>
      <div className="flex flex-wrap items-center gap-1 border border-base-300 rounded-lg px-2 py-1 min-h-10 bg-base-100">
        {value.map((t) => (
          <span key={t} className="badge badge-ghost gap-1">
            {t}
            <button
              className="ml-1 text-error"
              onClick={() => remove(t)}
              aria-label={`Remove ${t}`}
            >
              ✕
            </button>
          </span>
        ))}
        <input
          className="input input-xs focus:outline-none border-none grow"
          placeholder="Add tag…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
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

function VaultCard({
  recipe,
  checked,
  onChecked,
  favorite,
  onToggleFavorite,
  onOpen,
  onAdd,
  onSendGrocery,
}) {
  const n = recipe.nutrition || {};
  return (
    <div className="rounded-xl border border-base-200 bg-base-100 p-3 hover:border-base-300 transition">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            className="checkbox checkbox-sm"
            checked={checked}
            onChange={(e) => onChecked(e.target.checked)}
          />
          <div className="min-w-0">
            <div className="font-semibold truncate">{recipe.title}</div>
            <div className="text-xs text-base-content/70 mt-0.5 truncate">
              {recipe.cuisine || "—"} • {recipe.slot || "Any"} •{" "}
              {recipe.mode || "Home"}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            className={cx("btn btn-ghost btn-xs", favorite && "text-error")}
            title={favorite ? "Remove from favorites" : "Mark as favorite"}
            onClick={onToggleFavorite}
          >
            {favorite ? "♥" : "♡"}
          </button>
          <span className="badge badge-ghost">
            {Math.max(1, recipe.servings || 1)} sv
          </span>
        </div>
      </div>
      <div className="mt-2 text-xs text-base-content/70">
        {Math.round(n.calories || 0)} kcal • P{Math.round(n.protein || 0)} / C
        {Math.round(n.carbs || 0)} / F{Math.round(n.fat || 0)}
      </div>
      {recipe.tags?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {recipe.tags.slice(0, 5).map((t) => (
            <span key={t} className="badge badge-ghost badge-sm">
              {t}
            </span>
          ))}
          {recipe.tags.length > 5 && (
            <span className="badge badge-ghost badge-sm">
              +{recipe.tags.length - 5}
            </span>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button className="btn btn-primary btn-xs" onClick={onAdd}>
          Weave into Meal Rhythm
        </button>
        <button className="btn btn-outline btn-xs" onClick={onSendGrocery}>
          Provision List
        </button>
        <button className="btn btn-ghost btn-xs" onClick={onOpen}>
          Open
        </button>
      </div>
    </div>
  );
}

function VaultRow({
  recipe,
  checked,
  onChecked,
  favorite,
  onToggleFavorite,
  onOpen,
  onAdd,
  onSendGrocery,
}) {
  const n = recipe.nutrition || {};
  return (
    <div className="rounded-lg border border-base-200 bg-base-100 p-2 flex items-center gap-3">
      <input
        type="checkbox"
        className="checkbox checkbox-sm"
        checked={checked}
        onChange={(e) => onChecked(e.target.checked)}
      />
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate">{recipe.title}</div>
        <div className="text-xs text-base-content/70 truncate">
          {recipe.cuisine || "—"} • {recipe.slot || "Any"} •{" "}
          {recipe.mode || "Home"}
        </div>
      </div>
      <div className="text-xs text-base-content/70 w-48 shrink-0">
        {Math.round(n.calories || 0)} kcal • P{Math.round(n.protein || 0)} / C
        {Math.round(n.carbs || 0)} / F{Math.round(n.fat || 0)}
      </div>
      <div className="shrink-0 flex items-center gap-2">
        <button
          className={cx("btn btn-ghost btn-xs", favorite && "text-error")}
          title={favorite ? "Remove from favorites" : "Mark as favorite"}
          onClick={onToggleFavorite}
        >
          {favorite ? "♥" : "♡"}
        </button>
        <span className="badge badge-ghost">
          {Math.max(1, recipe.servings || 1)} sv
        </span>
        <button className="btn btn-primary btn-xs" onClick={onAdd}>
          Rhythm
        </button>
        <button className="btn btn-outline btn-xs" onClick={onSendGrocery}>
          Provision
        </button>
        <button className="btn btn-ghost btn-xs" onClick={onOpen}>
          Open
        </button>
      </div>
    </div>
  );
}

function EmptyVault({ onManual, onImportUrl, onScan }) {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-10 text-center bg-base-100">
      <div className="text-lg font-semibold">No recipes match this view</div>
      <p className="text-sm text-base-content/70 mt-1">
        Adjust your filters — or plant a new recipe in your vault.
      </p>
      <div className="mt-4 flex items-center justify-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={onManual}>
          Add Recipe by Hand
        </button>
        <button className="btn btn-outline btn-sm" onClick={onImportUrl}>
          Import from URL
        </button>
        <button className="btn btn-outline btn-sm" onClick={onScan}>
          Scan Package
        </button>
      </div>
    </div>
  );
}

/* ------------------------------ Ranking / Sorting -------------------------- */

function rankAndFilter(items, { viewKind, boostFavs, simThreshold, favSet }) {
  if (!items?.length) return [];
  const favItems = items.filter((i) => favSet.has(i.id));
  const profile = makeProfile(favItems);

  const scored = items.map((r) => {
    const sim = similarityToProfile(r, profile);
    const isFav = favSet.has(r.id);
    let score = sim;
    if (boostFavs) {
      if (isFav) score += 0.5;
      else score += Math.min(0.4, sim * 0.6);
    }
    return { ...r, _sim: sim, _isFav: isFav, _score: score };
  });

  let out = scored;
  if (viewKind === "favorites") out = out.filter((x) => x._isFav);
  if (viewKind === "related")
    out = out.filter((x) => !x._isFav && x._sim >= simThreshold);

  return out;
}

function sortItems(items, sortKey, favSet) {
  const arr = [...items];
  switch (sortKey) {
    case "alpha":
      arr.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
      break;
    case "calories":
      arr.sort(
        (a, b) => num(a.nutrition?.calories) - num(b.nutrition?.calories)
      );
      break;
    case "protein":
      arr.sort((a, b) => num(b.nutrition?.protein) - num(a.nutrition?.protein));
      break;
    default:
      arr.sort(
        (a, b) =>
          b._score - a._score || (a.title || "").localeCompare(b.title || "")
      );
      break;
  }
  return arr;
}

function makeProfile(favItems) {
  const tags = new Map(),
    ings = new Map(),
    cuisines = new Map(),
    slots = new Map(),
    modes = new Map();
  for (const r of favItems || []) {
    for (const t of r.tags || [])
      tags.set(t.toLowerCase(), (tags.get(t.toLowerCase()) || 0) + 1);
    for (const ing of r.ingredients || []) {
      const k = (ing.name || "").toLowerCase();
      if (k) ings.set(k, (ings.get(k) || 0) + 1);
    }
    if (r.cuisine) cuisines.set(r.cuisine, (cuisines.get(r.cuisine) || 0) + 1);
    if (r.slot) slots.set(r.slot, (slots.get(r.slot) || 0) + 1);
    if (r.mode) modes.set(r.mode, (modes.get(r.mode) || 0) + 1);
  }
  return {
    tags,
    ings,
    cuisines,
    slots,
    modes,
    size: Math.max(1, favItems?.length || 0),
  };
}

function similarityToProfile(recipe, p) {
  if (!p || !p.size) return 0;
  const norm = (s) => (s || "").toLowerCase();
  let t = 0,
    max = 0;

  // tags (0.4)
  const rtags = (recipe.tags || []).map(norm);
  const tagHit = rtags.reduce((acc, t1) => acc + (p.tags.has(t1) ? 1 : 0), 0);
  t += (tagHit / Math.max(1, rtags.length)) * 0.4;
  max += 0.4;

  // ingredients (0.3)
  const ring = (recipe.ingredients || []).map((i) => norm(i.name));
  const ingHit = ring.reduce((acc, n) => acc + (p.ings.has(n) ? 1 : 0), 0);
  t += (ingHit / Math.max(1, ring.length)) * 0.3;
  max += 0.3;

  // cuisine (0.2)
  if (recipe.cuisine && p.cuisines.has(recipe.cuisine)) {
    t += 0.2;
  }
  max += 0.2;

  // slot/mode (0.1)
  let sm = 0;
  if (recipe.slot && p.slots.has(recipe.slot)) sm += 0.06;
  if (recipe.mode && p.modes.has(recipe.mode)) sm += 0.04;
  t += sm;
  max += 0.1;

  return Math.min(1, t / Math.max(0.0001, max));
}

/* ------------------------------ Helpers ----------------------------------- */

function isMostlyOnHand(recipe, invIndex) {
  const ings = recipe.ingredients || [];
  if (!ings.length) return false;
  let covered = 0;
  for (const ing of ings) {
    const key = `${(ing.name || "").toLowerCase()}::${ing.unit || "ea"}`;
    const onHand = invIndex.get(key) || 0;
    if (onHand >= Number(ing.qty || 0)) covered += 1;
  }
  return covered / ings.length >= 0.6; // 60% coverage threshold
}

function getFavsFallback() {
  try {
    const raw = localStorage.getItem(FAV_LS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
function saveFavsFallback(ids) {
  try {
    localStorage.setItem(FAV_LS_KEY, JSON.stringify(ids || []));
  } catch {}
}

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function csv(v) {
  return String(v || "").includes(",")
    ? `"${String(v).replace(/"/g, '""')}"`
    : String(v || "");
}

/**
 * West African–forward mock dataset with street-food variety,
 * when no store/automation is available.
 *
 * NOTE: This is TOOL MODE friendly, but still uses storehouse language
 *       where possible and can be replaced by a real backend later.
 */
function mockSearch({ q, page, pageSize, filters }) {
  const waMode = filters?.mode || "Home";
  const slot = filters?.slot || "Any";
  const base = [
    // WA mains
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
    // soups/swallow
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
    // street snacks
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
    // food truck bowls
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
    // global street variety
    {
      id: "sf-1",
      title: "Taco al Pastor (Street)",
      cuisine: "Mexican",
      slot: slot,
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
    .filter(
      (r) =>
        !q ||
        r.title.toLowerCase().includes(q.toLowerCase()) ||
        (r.tags || []).some((t) => t.toLowerCase().includes(q.toLowerCase()))
    )
    .filter((r) => !filters?.slot || r.slot === filters.slot)
    .filter((r) => !filters?.cuisine || r.cuisine === filters.cuisine)
    .filter((r) => !filters?.exclude?.pork || !includesIng(r, "pork"))
    .filter(
      (r) =>
        !filters?.exclude?.shellfish &&
        !includesIng(r, "shrimp") &&
        !includesIng(r, "prawn")
    );

  const start = page * pageSize;
  const items = matches.slice(start, start + pageSize);
  return { items, pageSize };

  function includesIng(rec, needle) {
    return (rec.ingredients || []).some((i) =>
      (i.name || "").toLowerCase().includes(needle)
    );
  }
}

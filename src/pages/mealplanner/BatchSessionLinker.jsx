// src/pages/MealPlanning/BatchSessionLinker.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * BatchSessionLinker — dynamic, alias-safe
 * Purpose
 *  Link selected recipes (dragged/checked from Recipe Vault) into a
 *  Batch Session draft for the Session Planner.
 *
 * Highlights
 *  - Auto/Manual modes, Undo, NBA toolbar
 *  - Shellfish guard (Torah profile), Sabbath hands-off guard
 *  - Consolidates ingredients; totals nutrition & macro %
 *  - Estimates duration & “timers envelope” for MultiTimerPanel
 *  - Emits eventBus → inventory map, prep tasks, grocery list, planner
 *  - Drag-and-drop target (HTML5) for RECIPE_CARD objects
 *  - Optional persistence via BatchSessionStore (if available)
 *  - Keyboard shortcuts: L (link), U (undo)
 */

//////////////////////////////////////////
// Defensive imports (soft dependencies)
//////////////////////////////////////////
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  eventBus = require("@/services/events/eventBus").eventBus || eventBus;
} catch {}

let automation = {};
let emitProgress = () => {};
let emitDraftApproved = () => {};
try {
  const rt = require("@/services/automation/runtime");
  automation = rt.automation ?? {};
  emitProgress = rt.emitProgress ?? (() => {});
  emitDraftApproved = rt.emitDraftApproved ?? (() => {});
} catch {}

let RecipeStore = {};
try {
  RecipeStore = require("@/store/RecipeStore");
} catch {}
let InventoryStore = {};
try {
  InventoryStore = require("@/store/InventoryStore");
} catch {}
let PreferencesStore = {};
try {
  PreferencesStore = require("@/store/PreferencesStore");
} catch {}
let BatchSessionStore = {};
try {
  BatchSessionStore = require("@/store/BatchSessionStore");
} catch {}

let nutritionEngine;
try {
  nutritionEngine = require("@/services/nutrition/nutritionEngine");
} catch {}

let css = { cx: (...a) => a.filter(Boolean).join(" ") };
try {
  css = {
    cx:
      require("@/utils/css").classNames ||
      ((...a) => a.filter(Boolean).join(" ")),
  };
} catch {}

let fmt = {
  duration: (min) => `${Math.round(min)} min`,
  qty: (n) => (Number.isFinite(n) ? Number(n.toFixed(2)) : n),
};
try {
  fmt = { ...fmt, ...require("@/utils/format") };
} catch {}

let useBatchQueue = () => ({ queue: [], clear: () => {} });
try {
  useBatchQueue = require("@/context/BatchQueueContext").useBatchQueue;
} catch {}

//////////////////////////////////////////
// Guards, helpers, and calculators
//////////////////////////////////////////
const nowIso = () => new Date().toISOString();

const sabbathGuard = (profile) => {
  const active = profile?.torahProfile?.sabbath?.isActive;
  const handsOff = profile?.torahProfile?.sabbath?.handsOffCooking === true;
  return !(active && handsOff);
};

const shellfishFilter = (recipes, profile) => {
  const allow = profile?.torahProfile?.shellfishAllowed === true;
  if (allow) return { filtered: recipes || [], removed: [] };
  const removed = [];
  const filtered = (recipes || []).filter((r) => {
    const tagHit =
      Array.isArray(r?.tags) &&
      r.tags.some((t) => `${t}`.toLowerCase().includes("shellfish"));
    if (tagHit) removed.push(r);
    return !tagHit;
  });
  return { filtered, removed };
};

const consolidateIngredients = (recipes = []) => {
  const map = new Map();
  for (const r of recipes) {
    for (const ing of r?.ingredients || []) {
      const key = `${(ing.name || "").trim().toLowerCase()}::${(ing.unit || "")
        .trim()
        .toLowerCase()}`;
      const prev = map.get(key) || { ...ing, qty: 0 };
      map.set(key, { ...prev, qty: (prev.qty || 0) + (Number(ing.qty) || 0) });
    }
  }
  return Array.from(map.values()).map((x) => ({ ...x, qty: fmt.qty(x.qty) }));
};

const estimateMinutes = (recipes = []) => {
  // Heuristic: base 10 per recipe + 2 per step, min 15
  let total = 0;
  for (const r of recipes) {
    const steps = Array.isArray(r?.steps) ? r.steps.length : 4;
    total += 10 + steps * 2;
  }
  return Math.max(15, total);
};

const totalNutrition = (recipes = [], prefs = {}) => {
  if (nutritionEngine?.computeSessionTotals) {
    return nutritionEngine.computeSessionTotals(recipes, prefs);
  }
  const base = {
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0,
    fiber: 0,
    sugar: 0,
    sodium: 0,
  };
  for (const r of recipes) {
    const n = r?.nutrition || {};
    base.calories += Number(n.calories) || 0;
    base.protein += Number(n.protein) || 0;
    base.carbs += Number(n.carbs) || 0;
    base.fat += Number(n.fat) || 0;
    base.fiber += Number(n.fiber) || 0;
    base.sugar += Number(n.sugar) || 0;
    base.sodium += Number(n.sodium) || 0;
  }
  const calFromProtein = base.protein * 4;
  const calFromCarbs = base.carbs * 4;
  const calFromFat = base.fat * 9;
  const calTotal = Math.max(1, calFromProtein + calFromCarbs + calFromFat);
  return {
    ...base,
    proteinPct: Math.round((calFromProtein / calTotal) * 100),
    carbsPct: Math.round((calFromCarbs / calTotal) * 100),
    fatPct: Math.round((calFromFat / calTotal) * 100),
  };
};

//////////////////////////////////////////
// UI tiny bits
//////////////////////////////////////////
const Tag = ({ children, tone = "zinc" }) => (
  <span
    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium border-${tone}-300 text-${tone}-700 bg-${tone}-50`}
  >
    {children}
  </span>
);

const Stat = ({ label, value }) => (
  <div className="flex flex-col">
    <span className="text-xs text-zinc-500">{label}</span>
    <span className="text-sm font-semibold">{value}</span>
  </div>
);

//////////////////////////////////////////
// Component
//////////////////////////////////////////
export default function BatchSessionLinker({
  incomingRecipes = undefined,
  mode = "manual",
  onLinked = () => {},
}) {
  const dropZoneRef = useRef(null);
  const { queue, clear } = useBatchQueue();

  const [prefs, setPrefs] = useState(() => {
    try {
      return PreferencesStore?.getPreferences?.() || {};
    } catch {
      return {};
    }
  });

  const [draft, setDraft] = useState(null);
  const [removedByShellfish, setRemovedByShellfish] = useState([]);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]);
  const [toast, setToast] = useState(null); // {type, msg, actionLabel, onAction}

  // Build source list (incoming > queue)
  const sourceRecipes = useMemo(() => {
    const base =
      Array.isArray(incomingRecipes) && incomingRecipes.length
        ? incomingRecipes
        : queue;
    const { filtered, removed } = shellfishFilter(base, prefs);
    setRemovedByShellfish(removed);
    return filtered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingRecipes, queue, prefs?.torahProfile?.shellfishAllowed]);

  // Derived
  const consolidated = useMemo(
    () => consolidateIngredients(sourceRecipes),
    [sourceRecipes]
  );
  const totalMins = useMemo(
    () => estimateMinutes(sourceRecipes),
    [sourceRecipes]
  );
  const nutritionTotals = useMemo(
    () => totalNutrition(sourceRecipes, prefs),
    [sourceRecipes, prefs]
  );
  const isSabbathBlocked = useMemo(() => !sabbathGuard(prefs), [prefs]);

  //////////////////////////////////////////
  // Events: keep prefs fresh on global changes
  //////////////////////////////////////////
  useEffect(() => {
    const refresh = () => {
      try {
        setPrefs(PreferencesStore?.getPreferences?.() || {});
      } catch {}
    };
    const handlers = [
      ["preferences.changed", refresh],
      ["recipe.consolidated", refresh],
      ["inventory.updated", refresh],
      ["calendar.synced", refresh],
    ];
    handlers.forEach(([e, fn]) => eventBus.on(e, fn));
    return () => handlers.forEach(([e, fn]) => eventBus.off(e, fn));
  }, []);

  //////////////////////////////////////////
  // Drag-and-drop target (RECIPE_CARD)
  //////////////////////////////////////////
  const parseDroppedData = (dt) => {
    // Support: "application/x-recipe" JSON or text with JSON {type:"RECIPE_CARD", data:{...}}
    try {
      const types = Array.from(dt.types || []);
      if (types.includes("application/x-recipe")) {
        const raw = dt.getData("application/x-recipe");
        return JSON.parse(raw);
      }
      const text = dt.getData("text/plain");
      const maybe = JSON.parse(text);
      return maybe?.type === "RECIPE_CARD" ? maybe.data : null;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const el = dropZoneRef.current;
    if (!el) return;
    const prevent = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const onDrop = (e) => {
      prevent(e);
      const data = parseDroppedData(e.dataTransfer);
      if (!data) return;
      // Allow store to ingest, else merge locally
      try {
        RecipeStore?.upsert?.(data);
      } catch {}
      // Push into queue if context provides one
      try {
        eventBus.emit("batch.queue.added", { at: nowIso(), recipe: data });
      } catch {}
      setToast({
        type: "info",
        msg: `Added "${data?.title || data?.name || "Recipe"}" to selection.`,
      });
    };

    ["dragenter", "dragover", "dragleave", "drop"].forEach((t) =>
      el.addEventListener(t, prevent)
    );
    el.addEventListener("drop", onDrop);
    return () => {
      ["dragenter", "dragover", "dragleave", "drop"].forEach((t) =>
        el.removeEventListener(t, prevent)
      );
      el.removeEventListener("drop", onDrop);
    };
  }, []);

  //////////////////////////////////////////
  // Actions
  //////////////////////////////////////////
  const persistDraft = useCallback((draftSession) => {
    try {
      BatchSessionStore?.saveDraft?.(draftSession.id, draftSession);
    } catch {}
  }, []);

  const linkToBatchSession = useCallback(async () => {
    if (isSabbathBlocked) {
      setToast({
        type: "warning",
        msg: "Sabbath hands-off is active. You can review, but cannot start a new batch session.",
      });
      return;
    }
    if (!sourceRecipes?.length) {
      setToast({
        type: "info",
        msg: "Select or drag recipes from Recipe Vault to start a batch.",
      });
      return;
    }
    setBusy(true);
    try {
      emitProgress?.({
        id: "batch.link",
        at: nowIso(),
        message: "Linking recipes into a session draft...",
      });

      const draftSession = {
        id: `batch_${Date.now()}`,
        createdAt: nowIso(),
        mode, // auto | manual
        status: "draft",
        recipes: sourceRecipes,
        consolidatedIngredients: consolidated,
        estimates: {
          totalMinutes: totalMins,
          timersEnvelope: Math.max(1, Math.ceil(totalMins / 5)),
        },
        nutritionTotals,
        preferencesSnapshot: prefs,
        nextBestAction: "Open Session Planner",
        _meta: {
          removedByShellfishCount: removedByShellfish.length,
          source: "BatchSessionLinker",
          version: 2,
        },
      };

      // Undo
      setUndoStack((s) => [...s, { type: "link", payload: draftSession }]);

      // Emit glue
      eventBus.emit("recipe.consolidated", {
        at: nowIso(),
        planId: draftSession.id,
        items: consolidated,
      });
      eventBus.emit("batch.session.linked", {
        at: nowIso(),
        draft: draftSession,
      });

      // Kick inventory mapping & prep tasks
      eventBus.emit("inventory.sync.requested", {
        at: nowIso(),
        planId: draftSession.id,
        items: consolidated,
        context: "batch",
      });
      eventBus.emit("tasks.prep.generated", {
        at: nowIso(),
        planId: draftSession.id,
        recipes: sourceRecipes,
      });

      // Persist (optional store)
      persistDraft(draftSession);

      // Automation (no-ops if not wired)
      automation?.record?.("batch.linked", {
        id: draftSession.id,
        count: sourceRecipes.length,
      });
      emitDraftApproved?.({ id: draftSession.id, type: "batch", mode });

      setDraft(draftSession);
      setToast({
        type: "success",
        msg:
          removedByShellfish.length > 0
            ? `Session draft ready. (${removedByShellfish.length} recipe(s) skipped by shellfish guard.)`
            : "Session draft ready.",
        actionLabel: "Open Session Planner",
        onAction: () =>
          eventBus.emit("ui.open", {
            panel: "BatchSessionPlanner",
            planId: draftSession.id,
          }),
      });

      onLinked?.(draftSession);

      if (mode === "manual") clear?.();
    } catch (err) {
      console.error("[BatchSessionLinker] link error", err);
      setToast({
        type: "error",
        msg: "Could not link recipes. Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }, [
    isSabbathBlocked,
    sourceRecipes,
    mode,
    consolidated,
    totalMins,
    nutritionTotals,
    prefs,
    removedByShellfish.length,
    persistDraft,
    clear,
    onLinked,
  ]);

  const undoLast = useCallback(() => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));
    if (last.type === "link") {
      eventBus.emit("batch.session.unlinked", {
        at: nowIso(),
        id: last.payload?.id,
      });
      setDraft(null);
      setToast({ type: "info", msg: "Link undone." });
    }
  }, [undoStack]);

  //////////////////////////////////////////
  // Keyboard shortcuts
  //////////////////////////////////////////
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key.toLowerCase() === "l") linkToBatchSession();
      if (e.key.toLowerCase() === "u") undoLast();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [linkToBatchSession, undoLast]);

  //////////////////////////////////////////
  // Render helpers
  //////////////////////////////////////////
  const EmptyState = () => (
    <div className="rounded-2xl border border-dashed p-6 text-center">
      <div className="mb-2 text-lg font-semibold">No recipes linked yet</div>
      <p className="mx-auto max-w-md text-sm text-zinc-600">
        Drag recipes from <span className="font-medium">Recipe Vault</span>, or
        check multiple and choose{" "}
        <span className="font-medium">“Add to Batch.”</span> We’ll consolidate
        ingredients, compute nutrition, and set you up for the Session Planner.
      </p>
      <div className="mt-4 flex justify-center gap-2">
        <button
          className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50"
          onClick={() => eventBus.emit("ui.open", { panel: "RecipeVault" })}
        >
          Open Recipe Vault
        </button>
        <button
          className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90"
          onClick={linkToBatchSession}
          disabled={busy}
        >
          Link Selected
        </button>
      </div>
      <div className="mt-3 text-xs text-zinc-500">
        Tip: paste a URL or drop a screenshot to import a recipe quickly.
      </div>
    </div>
  );

  const ShellfishNotice = () =>
    removedByShellfish.length > 0 ? (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {removedByShellfish.length} recipe(s) were skipped by your shellfish
        preference.{" "}
        <button
          className="underline"
          onClick={() =>
            eventBus.emit("ui.open", {
              panel: "Preferences",
              tab: "Torah Profile",
            })
          }
        >
          Review Torah Profile
        </button>
        .
      </div>
    ) : null;

  const Toast = () =>
    toast ? (
      <div
        className={css.cx(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg",
          toast.type === "success" && "bg-green-600 text-white",
          toast.type === "warning" && "bg-yellow-600 text-white",
          toast.type === "error" && "bg-red-600 text-white",
          toast.type === "info" && "bg-zinc-900 text-white"
        )}
      >
        <div className="text-sm">{toast.msg}</div>
        {toast.actionLabel && toast.onAction ? (
          <button
            className="mt-2 rounded-lg border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
            onClick={toast.onAction}
          >
            {toast.actionLabel}
          </button>
        ) : null}
      </div>
    ) : null;

  //////////////////////////////////////////
  // UI
  //////////////////////////////////////////
  const hasRecipes = !!(sourceRecipes && sourceRecipes.length);

  return (
    <section className="flex flex-col gap-4" ref={dropZoneRef}>
      {/* Header + NBA */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">Batch Session Linker</h2>
          <Tag tone={mode === "auto" ? "violet" : "zinc"}>
            {mode === "auto" ? "auto" : "manual"}
          </Tag>
          {isSabbathBlocked && <Tag tone="violet">Sabbath hands-off</Tag>}
        </div>
        <div className="flex items-center gap-2">
          <button
            className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50"
            onClick={() =>
              eventBus.emit("ui.open", {
                panel: "BatchSessionPlanner",
                focus: "overview",
              })
            }
          >
            Open Session Planner
          </button>
          <button
            className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90"
            onClick={linkToBatchSession}
            disabled={busy || isSabbathBlocked}
            title={
              isSabbathBlocked
                ? "Sabbath hands-off is active"
                : "Create draft from selected recipes (L)"
            }
          >
            {busy ? "Linking…" : "Link Selected"}
          </button>
          <button
            className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50"
            onClick={undoLast}
            disabled={!undoStack.length}
            title="Undo last action (U)"
          >
            Undo
          </button>
        </div>
      </header>

      {/* Notices */}
      {isSabbathBlocked ? (
        <div className="rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 text-xs text-violet-900">
          Sabbath hands-off prevents starting new batch work. Planning is
          allowed; timers won’t start.
        </div>
      ) : null}
      <ShellfishNotice />

      {/* Main Content */}
      {!hasRecipes ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* Left: Selected Recipes */}
          <div className="lg:col-span-7">
            <div className="rounded-2xl border p-4">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-sm font-semibold">
                  Selected Recipes{" "}
                  <span className="text-zinc-400">
                    ({sourceRecipes.length})
                  </span>
                </div>
                <button
                  className="text-xs underline"
                  onClick={() =>
                    eventBus.emit("ui.open", { panel: "RecipeVault" })
                  }
                >
                  Add / Remove
                </button>
              </div>

              <ul className="space-y-2">
                {sourceRecipes.map((r) => (
                  <li key={r.id} className="rounded-2xl border p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {r.title || r.name || "Untitled recipe"}
                        </div>
                        <div className="text-xs text-zinc-500">
                          {Array.isArray(r.tags) && r.tags.length
                            ? r.tags.slice(0, 6).join(" • ")
                            : "—"}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-xs text-zinc-500">
                          {fmt.duration(estimateMinutes([r]))}
                        </span>
                        <button
                          className="rounded-lg border px-2 py-1 text-xs hover:bg-zinc-50"
                          onClick={() =>
                            eventBus.emit("ui.open", {
                              panel: "RecipeDetail",
                              id: r.id,
                            })
                          }
                        >
                          View
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-zinc-50 p-3 text-xs text-zinc-600">
                <span>Drag more recipes here to add.</span>
                <span className="ml-2 rounded bg-zinc-200 px-1.5 py-0.5">
                  Drop target
                </span>
              </div>
            </div>
          </div>

          {/* Right: Consolidation, Totals, Actions */}
          <div className="lg:col-span-5">
            <div className="rounded-2xl border p-4">
              {/* Consolidated ingredients */}
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-semibold">
                  Consolidated Ingredients
                </div>
                <div className="flex items-center gap-3">
                  <button
                    className="text-xs underline"
                    onClick={() =>
                      eventBus.emit("ui.open", {
                        panel: "BatchInventoryMap",
                        items: consolidated,
                      })
                    }
                  >
                    Map to Inventory
                  </button>
                  <button
                    className="text-xs underline"
                    onClick={() =>
                      eventBus.emit("grocerylist.requested", {
                        at: nowIso(),
                        context: "batch",
                        planId: draft?.id,
                        items: consolidated,
                        recipes: sourceRecipes,
                      })
                    }
                  >
                    Send to Grocery List
                  </button>
                </div>
              </div>

              {consolidated.length === 0 ? (
                <div className="rounded-lg border border-dashed p-3 text-xs text-zinc-600">
                  No ingredients detected.
                </div>
              ) : (
                <ul className="max-h-52 space-y-1 overflow-auto pr-1">
                  {consolidated.map((ing, idx) => (
                    <li
                      key={`${ing.name}-${ing.unit}-${idx}`}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="truncate">{ing.name}</span>
                      <span className="shrink-0 text-zinc-500">
                        {fmt.qty(Number(ing.qty))} {ing.unit || ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}

              <div className="my-4 h-px bg-zinc-100" />

              {/* Session stats */}
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Est. Duration" value={fmt.duration(totalMins)} />
                <Stat
                  label="Calories"
                  value={fmt.qty(nutritionTotals.calories)}
                />
                <Stat
                  label="Protein (g)"
                  value={fmt.qty(nutritionTotals.protein)}
                />
                <Stat
                  label="Carbs (g)"
                  value={fmt.qty(nutritionTotals.carbs)}
                />
                <Stat label="Fat (g)" value={fmt.qty(nutritionTotals.fat)} />
                <Stat
                  label="Fiber (g)"
                  value={fmt.qty(nutritionTotals.fiber)}
                />
              </div>

              {/* Macro bars */}
              <div className="mt-3 rounded-xl bg-zinc-50 p-3">
                <div className="mb-2 text-xs font-semibold">Macro Split</div>
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200">
                    <div
                      className="h-full bg-zinc-900"
                      style={{ width: `${nutritionTotals.proteinPct || 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-zinc-600">
                    {nutritionTotals.proteinPct || 0}%
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200">
                    <div
                      className="h-full bg-zinc-700"
                      style={{ width: `${nutritionTotals.carbsPct || 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-zinc-600">
                    {nutritionTotals.carbsPct || 0}%
                  </span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200">
                    <div
                      className="h-full bg-zinc-500"
                      style={{ width: `${nutritionTotals.fatPct || 0}%` }}
                    />
                  </div>
                  <span className="text-[10px] text-zinc-600">
                    {nutritionTotals.fatPct || 0}%
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-zinc-500">
                  Default goals: USDA standard{" "}
                  <button
                    className="underline"
                    onClick={() =>
                      eventBus.emit("ui.open", {
                        panel: "Preferences",
                        tab: "Nutrition",
                      })
                    }
                  >
                    (customize)
                  </button>
                </div>
              </div>

              {/* Actions */}
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                <button
                  className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50"
                  onClick={() =>
                    eventBus.emit("ui.open", {
                      panel: "PrepChecklistGenerator",
                      planId: draft?.id,
                      recipes: sourceRecipes,
                    })
                  }
                >
                  Generate Prep Checklist
                </button>
                <div className="flex items-center gap-2">
                  <button
                    className="rounded-xl border px-3 py-2 text-sm hover:bg-zinc-50"
                    onClick={() =>
                      eventBus.emit("ui.open", {
                        panel: "LabelPrinter",
                        planId: draft?.id,
                      })
                    }
                  >
                    Labels
                  </button>
                  <button
                    className="rounded-xl bg-black px-3 py-2 text-sm text-white hover:opacity-90"
                    onClick={() =>
                      eventBus.emit("ui.open", {
                        panel: "BatchSessionPlanner",
                        planId: draft?.id,
                      })
                    }
                  >
                    Next: {draft?.nextBestAction || "Open Session Planner"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast ? (
        <div
          className={css.cx(
            "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg",
            toast.type === "success" && "bg-green-600 text-white",
            toast.type === "warning" && "bg-yellow-600 text-white",
            toast.type === "error" && "bg-red-600 text-white",
            toast.type === "info" && "bg-zinc-900 text-white"
          )}
        >
          <div className="text-sm">{toast.msg}</div>
          {toast.actionLabel && toast.onAction ? (
            <button
              className="mt-2 rounded-lg border border-white/20 px-2 py-1 text-xs hover:bg-white/10"
              onClick={toast.onAction}
            >
              {toast.actionLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// C:\Users\larho\suka-smart-assistant\src\pages\MealPlanning\RecipeDeciderPanel.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { format } from "date-fns";

/**
 * RecipeDeciderPanel.jsx — Decision assistant for picking recipes fast
 * --------------------------------------------------------------------------------
 * What it does
 *  - Surfaces the best candidates for a meal slot (breakfast/lunch/dinner/snack) or a batch.
 *  - Smart filters: time, difficulty, tags, macros window, pantry-availability, rating.
 *  - Scores each recipe against user prefs + current inventory; sorts by fit.
 *  - “Decide for me” button (auto-pick) + compare tray to break ties.
 *  - Emits events for: add-to-plan (specific date/slot), send-to-batch, open detail, grocery list.
 *  - Sabbath guard (hands-off) & Torah-profile shellfish awareness.
 *  - Undo pattern, compact list mode, keyboard shortcuts, drag-to-target.
 *
 * Inspirations
 *  - Airbnb “filter chips” + instant results
 *  - Amazon “compare” tray
 *  - Linear.app keyboard-first feel (quick actions)
 *
 * Soft deps (guarded):
 *  - eventBus "@/services/events/eventBus"  -> on/off/emit
 *  - runtime "@/services/automation/runtime" -> record/emitProgress (optional)
 *  - stores "@/store/RecipeStore", "@/store/InventoryStore", "@/store/PreferencesStore"
 *  - nutrition "@/services/nutrition/nutritionEngine"
 *  - utils "@/utils/css", "@/utils/format"
 *  - context "@/context/BatchQueueContext" -> useBatchQueue
 */

/* -------------------------------- Defensive imports -------------------------------- */
let eventBus = { on: () => {}, off: () => {}, emit: () => {} };
try {
  eventBus = require("@/services/events/eventBus").eventBus || eventBus;
} catch {}

let automation = {};
let emitProgress = () => {};
try {
  const rt = require("@/services/automation/runtime");
  automation = rt.automation ?? {};
  emitProgress = rt.emitProgress ?? (() => {});
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

let useBatchQueue = () => ({ add: () => {} });
try {
  useBatchQueue = require("@/context/BatchQueueContext").useBatchQueue;
} catch {}

/* -------------------------------- Helpers & guards -------------------------------- */
const cx = css.cx;
const nowIso = () => new Date().toISOString();
const uid = (p = "r") => `${p}_${Math.random().toString(36).slice(2)}`;

const sabbathBlocked = (profile) => {
  const active = profile?.torahProfile?.sabbath?.isActive;
  const handsOff = profile?.torahProfile?.sabbath?.handsOffCooking === true;
  return !!(active && handsOff);
};

const shellfishBlocked = (recipe, profile) => {
  const allow = profile?.torahProfile?.shellfishAllowed === true;
  if (allow) return false;
  const tags = (recipe?.tags || []).map((t) => `${t}`.toLowerCase());
  return tags.some((t) => t.includes("shellfish"));
};

const getAllRecipes = () => {
  try {
    const xs = RecipeStore?.list?.() || RecipeStore?.getAll?.() || [];
    if (Array.isArray(xs) && xs.length) return xs;
  } catch {}
  // fallback demo set
  return [
    {
      id: "r1",
      title: "Oatmeal & Berries",
      time: 12,
      rating: 4.6,
      tags: ["breakfast", "veg"],
      nutrition: { protein: 12, carbs: 38, fat: 5, calories: 280 },
      ingredients: [{ name: "oats", qty: 1, unit: "cup" }],
    },
    {
      id: "r2",
      title: "Chicken Salad",
      time: 18,
      rating: 4.2,
      tags: ["lunch", "gluten-free"],
      nutrition: { protein: 30, carbs: 10, fat: 14, calories: 330 },
      ingredients: [{ name: "chicken", qty: 300, unit: "g" }],
    },
    {
      id: "r3",
      title: "Lamb Doner Bowl",
      time: 35,
      rating: 4.8,
      tags: ["dinner", "fusion"],
      nutrition: { protein: 34, carbs: 42, fat: 18, calories: 520 },
      ingredients: [{ name: "lamb", qty: 300, unit: "g" }],
    },
    {
      id: "r4",
      title: "Greek Yogurt Cup",
      time: 3,
      rating: 4.4,
      tags: ["snack"],
      nutrition: { protein: 17, carbs: 8, fat: 4, calories: 150 },
      ingredients: [{ name: "yogurt", qty: 1, unit: "cup" }],
    },
  ];
};

const getPantryCounts = () => {
  try {
    return InventoryStore?.getPantry?.() || {};
  } catch {
    return {};
  }
};

const normalizeMacros = (n) => {
  if (!n) return { protein: 0, carbs: 0, fat: 0, calories: 0 };
  const protein = Number(n.protein) || 0;
  const carbs = Number(n.carbs) || 0;
  const fat = Number(n.fat) || 0;
  const calories = Number(n.calories) || 0;
  return { protein, carbs, fat, calories };
};

const macroScore = (recipe, prefTargets = {}) => {
  // Prefs could hold target P/C/F percentages or grams; we’ll score closeness (lower diff = better)
  const n = normalizeMacros(recipe?.nutrition);
  const t = prefTargets?.targets || {};
  const want = {
    protein: Number(t.protein) || 0,
    carbs: Number(t.carbs) || 0,
    fat: Number(t.fat) || 0,
    calories: Number(t.calories) || 0,
  };
  const diff =
    Math.abs(n.protein - want.protein) * 1.0 +
    Math.abs(n.carbs - want.carbs) * 0.6 +
    Math.abs(n.fat - want.fat) * 0.8 +
    Math.abs(n.calories - want.calories) * 0.2;
  // Convert to score (smaller diff → higher score). Clamp >= 0.
  return Math.max(0, 100 - Math.min(100, diff / 5));
};

const pantryScore = (recipe, pantry) => {
  if (!recipe?.ingredients?.length) return 0;
  let have = 0;
  for (const ing of recipe.ingredients) {
    const k = (ing.name || "").trim().toLowerCase();
    if (pantry[k]) have++;
  }
  return (have / recipe.ingredients.length) * 100; // 0…100
};

const timeScore = (recipe, maxMinutes) => {
  if (!maxMinutes) return 50;
  if (!recipe?.time) return 40;
  const t = recipe.time;
  if (t <= maxMinutes) return 100 - (t / maxMinutes) * 30; // closer to limit slightly penalized
  return Math.max(0, 60 - (t - maxMinutes) * 5);
};

const tagScore = (recipe, wantedTags) => {
  if (!wantedTags?.length) return 50;
  const rtags = new Set((recipe?.tags || []).map((t) => `${t}`.toLowerCase()));
  const hits = wantedTags.filter((t) => rtags.has(`${t}`.toLowerCase())).length;
  return (hits / Math.max(1, wantedTags.length)) * 100;
};

const ratingScore = (recipe) => {
  const r = Number(recipe?.rating) || 0;
  return Math.min(100, r * 20); // 5★ → 100
};

const computeScore = (recipe, { prefs, pantry, filters }) => {
  const weights = {
    macro: 0.36,
    pantry: 0.22,
    time: 0.18,
    tags: 0.14,
    rating: 0.1,
  };
  const s =
    weights.macro * macroScore(recipe, prefs) +
    weights.pantry * pantryScore(recipe, pantry) +
    weights.time * timeScore(recipe, filters.maxTime) +
    weights.tags * tagScore(recipe, filters.tags) +
    weights.rating * ratingScore(recipe);
  return Math.round(s);
};

/* ---------------------------------- UI bits ---------------------------------- */
const Button = ({
  variant = "default",
  size = "md",
  className,
  children,
  ...props
}) => {
  const variants = {
    default: "bg-blue-600 text-white hover:bg-blue-700",
    outline: "border border-zinc-300 hover:bg-zinc-50",
    ghost: "hover:bg-zinc-100",
    danger: "bg-red-600 text-white hover:bg-red-700",
    secondary: "bg-zinc-900 text-white hover:bg-zinc-800",
  };
  const sizes = { sm: "h-8 px-2", md: "h-10 px-3", icon: "h-9 w-9 p-0" };
  return (
    <button
      className={cx(
        "rounded-md text-sm",
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};
const Input = (p) => (
  <input
    className={cx("h-9 w-full rounded-md border border-zinc-300 px-3 text-sm")}
    {...p}
  />
);
const Select = (p) => (
  <select
    className="h-9 w-full rounded-md border border-zinc-300 bg-white px-2 text-sm"
    {...p}
  />
);
const Card = ({ className, children }) => (
  <div className={cx("rounded-xl border bg-white shadow-sm", className)}>
    {children}
  </div>
);
const CardHeader = ({ className, children }) => (
  <div className={cx("px-4 pt-4", className)}>{children}</div>
);
const CardTitle = ({ className, children }) => (
  <div className={cx("text-lg font-semibold", className)}>{children}</div>
);
const CardContent = ({ className, children }) => (
  <div className={cx("px-4 pb-4", className)}>{children}</div>
);
const Badge = ({ children, tone = "zinc" }) => (
  <span
    className={`inline-flex items-center rounded px-2 py-0.5 text-xs border border-${tone}-300 bg-${tone}-50 text-${tone}-800`}
  >
    {children}
  </span>
);

/* ---------------------------------- Component ---------------------------------- */
export default function RecipeDeciderPanel({
  // Optional seed (e.g., date & slot context from CalendarPreview)
  date = null, // JS Date
  slot = "dinner", // "breakfast" | "lunch" | "dinner" | "snack"
  intent = "single", // "single" | "batch"
}) {
  const { add: addToBatch } = useBatchQueue();
  const searchRef = useRef(null);

  // prefs + sabbath
  const [prefs, setPrefs] = useState(() => {
    try {
      return PreferencesStore?.getPreferences?.() || {};
    } catch {
      return {};
    }
  });
  const isSabbath = sabbathBlocked(prefs);

  // filters & ui
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState({
    maxTime: slot === "dinner" ? 40 : slot === "breakfast" ? 15 : 25,
    tags: [slot],
    minRating: 0,
    difficulty: "any", // any | easy | moderate | hard
    macros: { minProtein: 0, maxCalories: 900 },
  });
  const [compact, setCompact] = useState(false);
  const [compare, setCompare] = useState([]); // selected recipe ids
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(false);
  const [undoStack, setUndoStack] = useState([]);

  // data
  const [recipes, setRecipes] = useState(() => getAllRecipes());
  const pantry = useMemo(() => getPantryCounts(), []);

  // refresh hooks
  useEffect(() => {
    const refresh = () => {
      try {
        setRecipes(getAllRecipes());
      } catch {}
    };
    const refreshPrefs = () => {
      try {
        setPrefs(PreferencesStore?.getPreferences?.() || {});
      } catch {}
    };
    const handlers = [
      ["recipe.vault.updated", refresh],
      ["inventory.updated", refresh],
      ["preferences.changed", refreshPrefs],
    ];
    handlers.forEach(([e, fn]) => eventBus.on(e, fn));
    return () => handlers.forEach(([e, fn]) => eventBus.off(e, fn));
  }, []);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
      if (e.key.toLowerCase() === "f") searchRef.current?.focus();
      if (e.key.toLowerCase() === "d") decideForMe();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // filtering + scoring
  const filtered = useMemo(() => {
    let list = recipes.slice();

    // hard blocks
    list = list.filter((r) => !shellfishBlocked(r, prefs));

    // text
    if (query) {
      const q = query.toLowerCase();
      list = list.filter(
        (r) =>
          r.title?.toLowerCase().includes(q) ||
          (r.tags || []).some((t) => `${t}`.toLowerCase().includes(q))
      );
    }

    // tags
    if (filters.tags?.length) {
      const want = new Set(filters.tags.map((t) => `${t}`.toLowerCase()));
      list = list.filter((r) =>
        (r.tags || []).some((t) => want.has(`${t}`.toLowerCase()))
      );
    }

    // time
    if (filters.maxTime)
      list = list.filter((r) => !r.time || r.time <= filters.maxTime);

    // rating
    if (filters.minRating > 0)
      list = list.filter((r) => (Number(r.rating) || 0) >= filters.minRating);

    // macros
    if (filters.macros?.minProtein) {
      list = list.filter(
        (r) => (Number(r?.nutrition?.protein) || 0) >= filters.macros.minProtein
      );
    }
    if (filters.macros?.maxCalories) {
      list = list.filter(
        (r) =>
          (Number(r?.nutrition?.calories) || 0) <= filters.macros.maxCalories
      );
    }

    // difficulty is optional (if recipes carry it)
    if (filters.difficulty !== "any") {
      list = list.filter(
        (r) => !r.difficulty || r.difficulty === filters.difficulty
      );
    }

    // score
    const scored = list.map((r) => ({
      ...r,
      __score: computeScore(r, { prefs, pantry, filters }),
    }));
    scored.sort((a, b) => b.__score - a.__score);
    return scored;
  }, [recipes, prefs, pantry, filters, query]);

  const topPick = filtered[0];

  /* ------------------------------- Actions ------------------------------- */
  const decideForMe = useCallback(() => {
    if (!filtered.length) {
      setToast({
        type: "info",
        msg: "No matches with current filters. Try widening your search.",
      });
      return;
    }
    const pick = filtered[0];
    setCompare([pick.id]);
    setToast({ type: "success", msg: `Picked: ${pick.title}` });
  }, [filtered]);

  const addToPlan = useCallback(
    (recipe) => {
      if (isSabbath) {
        setToast({
          type: "warning",
          msg: "Sabbath hands-off is active. You can review but not schedule tasks.",
        });
        return;
      }
      const planPayload = {
        at: nowIso(),
        date: date
          ? format(date, "yyyy-MM-dd")
          : format(new Date(), "yyyy-MM-dd"),
        slot,
        recipe,
      };
      eventBus.emit("mealplan.add.requested", planPayload);
      setUndoStack((s) => [...s, { type: "plan.add", payload: planPayload }]);
      setToast({
        type: "success",
        msg: `Added to ${slot} on ${planPayload.date}.`,
        actionLabel: "Undo",
        onAction: () => undo(),
      });
      automation?.record?.("decider.added_to_plan", {
        recipeId: recipe.id,
        slot,
        date: planPayload.date,
      });
    },
    [date, slot, isSabbath]
  );

  const sendToBatch = useCallback(
    (recipe) => {
      try {
        addToBatch?.({ ...recipe, from: "RecipeDeciderPanel" });
        eventBus.emit("batch.queue.added", { at: nowIso(), recipe });
        setToast({ type: "success", msg: "Sent to Batch Queue." });
      } catch {
        setToast({ type: "error", msg: "Could not add to Batch Queue." });
      }
    },
    [addToBatch]
  );

  const openDetail = (id) =>
    eventBus.emit("ui.open", { panel: "RecipeDetail", id });

  const compareToggle = (id) => {
    setCompare((xs) =>
      xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id].slice(0, 4)
    );
  };

  const clearFilters = () => {
    setFilters({
      maxTime: slot === "dinner" ? 40 : slot === "breakfast" ? 15 : 25,
      tags: [slot],
      minRating: 0,
      difficulty: "any",
      macros: { minProtein: 0, maxCalories: 900 },
    });
    setQuery("");
  };

  const undo = () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    setUndoStack((s) => s.slice(0, -1));

    if (last.type === "plan.add") {
      eventBus.emit("mealplan.remove.requested", {
        at: nowIso(),
        date: last.payload.date,
        slot: last.payload.slot,
        recipeId: last.payload.recipe?.id,
      });
      setToast({ type: "info", msg: "Removed from plan." });
    }
  };

  /* ------------------------------ Subcomponents ------------------------------ */
  const Toast = () =>
    toast ? (
      <div
        className={cx(
          "fixed bottom-4 right-4 z-50 max-w-sm rounded-xl px-4 py-3 shadow-lg text-white",
          toast.type === "success" && "bg-green-600",
          toast.type === "info" && "bg-zinc-900",
          toast.type === "warning" && "bg-amber-600",
          toast.type === "error" && "bg-red-600"
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

  const FilterBar = () => (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        ref={searchRef}
        placeholder="Search recipes… (press F to focus)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <Select
        value={filters.maxTime}
        onChange={(e) =>
          setFilters((f) => ({ ...f, maxTime: Number(e.target.value) || 0 }))
        }
        title="Max prep time"
      >
        {[10, 15, 20, 25, 30, 40, 60].map((m) => (
          <option key={m} value={m}>
            ≤ {m} min
          </option>
        ))}
      </Select>
      <Select
        multiple
        value={filters.tags}
        onChange={(e) =>
          setFilters((f) => ({
            ...f,
            tags: Array.from(e.target.selectedOptions).map((o) => o.value),
          }))
        }
        title="Tags"
      >
        {[
          "breakfast",
          "lunch",
          "dinner",
          "snack",
          "veg",
          "gluten-free",
          "fusion",
          "kid-friendly",
        ].map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
      <Select
        value={filters.minRating}
        onChange={(e) =>
          setFilters((f) => ({ ...f, minRating: Number(e.target.value) }))
        }
        title="Min rating"
      >
        {[0, 3, 3.5, 4, 4.5].map((r) => (
          <option key={r} value={r}>
            ≥ {r}★
          </option>
        ))}
      </Select>
      <Select
        value={filters.difficulty}
        onChange={(e) =>
          setFilters((f) => ({ ...f, difficulty: e.target.value }))
        }
        title="Difficulty"
      >
        {["any", "easy", "moderate", "hard"].map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </Select>
      <Input
        type="number"
        min={0}
        max={200}
        value={filters.macros.minProtein}
        onChange={(e) =>
          setFilters((f) => ({
            ...f,
            macros: { ...f.macros, minProtein: Number(e.target.value) || 0 },
          }))
        }
        placeholder="Min protein (g)"
        title="Min protein (g)"
      />
      <Input
        type="number"
        min={0}
        max={2000}
        value={filters.macros.maxCalories}
        onChange={(e) =>
          setFilters((f) => ({
            ...f,
            macros: { ...f.macros, maxCalories: Number(e.target.value) || 0 },
          }))
        }
        placeholder="Max calories"
        title="Max calories"
      />
      <Button variant="outline" onClick={clearFilters}>
        Reset
      </Button>
      <Button
        variant="secondary"
        onClick={decideForMe}
        title="Decide for me (D)"
      >
        Decide for me
      </Button>
      <Button variant="outline" onClick={() => setCompact((v) => !v)}>
        {compact ? "Grid" : "Compact"}
      </Button>
    </div>
  );

  const MacroPill = ({ n }) => {
    const p = normalizeMacros(n);
    return (
      <div className="flex items-center gap-2 text-[11px] text-zinc-600">
        <span>P {fmt.qty(p.protein)}g</span>
        <span>C {fmt.qty(p.carbs)}g</span>
        <span>F {fmt.qty(p.fat)}g</span>
        <Badge tone="zinc">{fmt.qty(p.calories)} kcal</Badge>
      </div>
    );
  };

  const RecipeRow = ({ r }) => {
    const blocked = shellfishBlocked(r, prefs);
    return (
      <li className="rounded-xl border p-3 hover:bg-zinc-50">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-semibold">{r.title}</div>
              {blocked && <Badge tone="amber">shellfish</Badge>}
              <Badge tone="zinc">{r.time ? fmt.duration(r.time) : "—"}</Badge>
              <Badge tone="zinc">{r.rating ?? "—"}★</Badge>
              <Badge tone="zinc">Score {r.__score}</Badge>
            </div>
            <div className="mt-1 text-[11px] text-zinc-500">
              {(r.tags || []).slice(0, 6).join(" • ") || "—"}
            </div>
            <div className="mt-2">
              <MacroPill n={r.nutrition} />
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => openDetail(r.id)}
            >
              View
            </Button>
            <Button variant="outline" size="sm" onClick={() => sendToBatch(r)}>
              Batch
            </Button>
            <Button
              size="sm"
              onClick={() => addToPlan(r)}
              disabled={isSabbath}
              title={isSabbath ? "Sabbath hands-off is active" : "Add to plan"}
            >
              Add to Plan
            </Button>
            <button
              className={cx(
                "rounded-md border px-2 py-1 text-xs",
                compare.includes(r.id)
                  ? "bg-zinc-900 text-white"
                  : "hover:bg-zinc-100"
              )}
              onClick={() => compareToggle(r.id)}
              title="Compare"
            >
              {compare.includes(r.id) ? "In Compare" : "Compare"}
            </button>
          </div>
        </div>
      </li>
    );
  };

  const CompareTray = () => {
    if (!compare.length) return null;
    const selected = filtered.filter((r) => compare.includes(r.id));
    return (
      <div className="rounded-xl border bg-zinc-50 p-3">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-semibold">
            Compare ({selected.length})
          </div>
          <Button variant="ghost" size="sm" onClick={() => setCompare([])}>
            Clear
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          {selected.map((r) => (
            <div key={r.id} className="rounded-lg border bg-white p-2">
              <div className="text-xs font-semibold">{r.title}</div>
              <div className="mt-1 text-[11px] text-zinc-600">
                {r.time ? fmt.duration(r.time) : "—"} • {r.rating ?? "—"}★ •
                Score {r.__score}
              </div>
              <div className="mt-2">
                <MacroPill n={r.nutrition} />
              </div>
              <div className="mt-2 flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => addToPlan(r)}
                  disabled={isSabbath}
                >
                  Plan
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => sendToBatch(r)}
                >
                  Batch
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openDetail(r.id)}
                >
                  View
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  /* ---------------------------------- UI ---------------------------------- */
  return (
    <section className="flex flex-col gap-4">
      <Toast />

      {/* Header */}
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-zinc-900" />
          <h2 className="text-xl font-semibold">Recipe Decider</h2>
          <Badge tone="zinc">
            {slot} • {date ? format(date, "EEE, MMM d") : "no date"}
          </Badge>
          {isSabbath && <Badge tone="violet">Sabbath hands-off</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => eventBus.emit("ui.open", { panel: "RecipeVault" })}
          >
            Open Recipe Vault
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={decideForMe}
            title="Decide for me (D)"
          >
            Decide for me
          </Button>
        </div>
      </header>

      {/* Filters */}
      <Card>
        <CardContent className="py-4">
          <FilterBar />
        </CardContent>
      </Card>

      {/* Top pick callout */}
      {topPick ? (
        <Card>
          <CardHeader className="py-3">
            <CardTitle className="text-sm">Top Pick</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-semibold">{topPick.title}</div>
              <div className="mt-1 text-[11px] text-zinc-600">
                {topPick.time ? fmt.duration(topPick.time) : "—"} •{" "}
                {topPick.rating ?? "—"}★ • Score {topPick.__score}
              </div>
              <div className="mt-2">
                <MacroPill n={topPick.nutrition} />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => openDetail(topPick.id)}
              >
                View
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => sendToBatch(topPick)}
              >
                Batch
              </Button>
              <Button
                size="sm"
                onClick={() => addToPlan(topPick)}
                disabled={isSabbath}
              >
                Add to Plan
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Results */}
      <Card>
        <CardHeader className="flex items-center justify-between py-3">
          <CardTitle className="text-sm">Matches</CardTitle>
          <div className="text-xs text-zinc-500">
            {filtered.length} result(s)
          </div>
        </CardHeader>
        <CardContent>
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed p-6 text-center text-sm text-zinc-600">
              No matches. Try clearing filters or browsing the{" "}
              <button
                className="underline"
                onClick={() =>
                  eventBus.emit("ui.open", { panel: "RecipeVault" })
                }
              >
                Recipe Vault
              </button>
              .
            </div>
          ) : compact ? (
            <ul className="divide-y">
              {filtered.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {r.title}
                    </div>
                    <div className="text-[11px] text-zinc-500">
                      {r.time ? fmt.duration(r.time) : "—"} • {r.rating ?? "—"}★
                      • Score {r.__score}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => openDetail(r.id)}
                    >
                      View
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => sendToBatch(r)}
                    >
                      Batch
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => addToPlan(r)}
                      disabled={isSabbath}
                    >
                      Plan
                    </Button>
                    <button
                      className={cx(
                        "rounded-md border px-2 py-1 text-xs",
                        compare.includes(r.id)
                          ? "bg-zinc-900 text-white"
                          : "hover:bg-zinc-100"
                      )}
                      onClick={() => compareToggle(r.id)}
                    >
                      {compare.includes(r.id) ? "In Compare" : "Compare"}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="grid grid-cols-1 gap-2">
              {filtered.map((r) => (
                <RecipeRow key={r.id} r={r} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Compare tray */}
      <CompareTray />
    </section>
  );
}

/* -------------------------------- Lightweight TESTS -------------------------------- */
(function runRecipeDeciderTestsOnce() {
  if (typeof window === "undefined") return;
  if (window.__RECIPE_DECIDER_TESTS__) return;
  window.__RECIPE_DECIDER_TESTS__ = true;

  const expect = (cond, msg) =>
    cond
      ? console.log("[RecipeDecider TEST PASS]", msg)
      : console.error("[RecipeDecider TEST FAIL]", msg);

  const demo = {
    nutrition: { protein: 30, carbs: 10, fat: 14, calories: 330 },
    time: 20,
    rating: 4.5,
    tags: ["lunch"],
  };
  const prefs = { targets: { protein: 30, carbs: 20, fat: 15, calories: 500 } };
  const pantry = { chicken: 1, oats: 1 };
  const filters = { maxTime: 25, tags: ["lunch"] };

  const m = macroScore(demo, prefs);
  expect(m > 50, "macroScore > 50 for close match");

  const ts = timeScore(demo, 25);
  expect(ts > 50, "timeScore > 50 under limit");

  const score = computeScore(demo, { prefs, pantry, filters });
  expect(score > 50, "overall computeScore above threshold");
})();

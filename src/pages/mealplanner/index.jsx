/* eslint-disable no-console */
// src/pages/MealPlanning/index.jsx

import React, { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import { automation } from "@/services/automation/runtime";

/* ----------------------------- Event bus (compatible) ----------------------------- */
// NOTE: We now use the shim at src/services/events/eventBus.js
let on = () => {};
let emit = () => {};

(async () => {
  try {
    const mod = await import("@/services/events/eventBus");
    const bus = mod.eventBus || mod.default || mod;

    if (bus?.on && bus?.emit) {
      // subscribe helper
      on = bus.on.bind(bus);

      // emit helper (normalize into envelope when possible)
      emit = (type, payload) => {
        try {
          bus.emit("event", {
            type,
            payload,
            ts: new Date().toISOString(),
            source: "ui/meal-planning",
          });
        } catch {
          // fallback to raw type if shim doesn't support the envelope
          bus.emit(type, payload);
        }
      };
    }
  } catch (err) {
    console.error("[MealPlanning] Failed to load eventBus shim", err);
  }
})();

/* ---------------------------------- Safe imports ---------------------------------- */
async function tryImport(path) {
  try {
    // eslint-disable-next-line no-undef
    return await import(/* @vite-ignore */ path);
  } catch {
    return null;
  }
}

let mealAgent = null;
let scenarios = null;
let labelsCfg = null;
let gardenPlanAgent = null;
let preservationAgent = null;
let animalsAgent = null; // optional; we’ll emit events even if absent
let cleaningShim = null; // NEW — cleaning domain shim/agent
let storehouseShim = null; // NEW — storehouse/stock planning shim/agent

(async () => {
  mealAgent =
    (await tryImport("@/agents/shims/mealPlanningShim"))?.default ||
    (await tryImport("@/agents/mealPlanningAgent"))?.default ||
    (await tryImport("@/agents/mealPlanningAgent"));

  scenarios =
    (await tryImport("@/services/analytics/scenarios")) ||
    (await tryImport("@/services/analytics/scenarios/index"));

  labelsCfg =
    (await tryImport("@/services/labels/templates.todo")) ||
    (await tryImport("@/services/labels/templates"));

  gardenPlanAgent =
    (await tryImport("@/agents/shims/gardenPlanShim"))?.default ||
    (await tryImport("@/agents/gardenPlanAgent"))?.default ||
    (await tryImport("@/agents/gardenPlanAgent"));

  preservationAgent =
    (await tryImport("@/agents/shims/preservationShim"))?.default ||
    (await tryImport("@/agents/preservationAgent"))?.default ||
    (await tryImport("@/agents/preservationAgent"))?.preservationAgent;

  animalsAgent =
    (await tryImport("@/agents/shims/animalsShim"))?.default ||
    (await tryImport("@/agents/animalsAgent"))?.default ||
    (await tryImport("@/agents/animals/animalsAgent"));

  cleaningShim =
    (await tryImport("@/agents/shims/cleaningShim"))?.default ||
    (await tryImport("@/agents/cleaningAgent"))?.default ||
    (await tryImport("@/agents/cleaning/cleaningAgent"));

  storehouseShim =
    (await tryImport("@/agents/shims/storehouseShim"))?.default ||
    (await tryImport("@/agents/storehouseAgent"))?.default ||
    (await tryImport("@/agents/storehouse/storehouseAgent"));
})();

/* ---------------------------------- UI Helpers ---------------------------------- */
const isoNow = () => new Date().toISOString();
const fmt = (n) => (Number.isFinite(Number(n)) ? Number(n).toLocaleString() : "—");
const badgeCls =
  "inline-flex items-center rounded-xl border px-2.5 py-0.5 text-xs font-medium";

const PRESETS = [
  { key: "7", label: "7d" },
  { key: "30", label: "30d" },
  { key: "60", label: "60d" },
  { key: "90", label: "90d" },
  { key: "custom", label: "Custom" },
];

function Section({ title, subtitle, right, children }) {
  return (
    <section className="rounded-2xl border border-base-200 bg-base-100 shadow-lg p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg md:text-xl font-semibold">{title}</h2>
          {subtitle ? (
            <p className="text-base-content/60 text-sm mt-0.5">{subtitle}</p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function CTA({ label, onClick, icon, variant = "primary", disabled = false }) {
  const map = {
    primary: "btn btn-primary",
    ghost: "btn btn-ghost",
    secondary: "btn btn-secondary",
    danger: "btn btn-error",
  };
  return (
    <button
      className={`${map[variant]} rounded-2xl`}
      onClick={onClick}
      disabled={disabled}
      type="button"
      aria-label={label}
      title={label}
    >
      {icon ? <span className="mr-2">{icon}</span> : null}
      {label}
    </button>
  );
}
function EmptyState({ title, subtitle, primary, secondary = [] }) {
  return (
    <div className="text-base-content/70 flex flex-col items-center justify-center gap-3 p-8">
      <div className="text-xl font-semibold">{title}</div>
      {subtitle ? <div className="text-sm">{subtitle}</div> : null}
      <div className="mt-2 flex items-center gap-2">
        {primary ? <CTA label={primary.label} onClick={primary.onClick} /> : null}
        {secondary.map((s, i) => (
          <CTA key={i} label={s.label} onClick={s.onClick} variant="ghost" />
        ))}
      </div>
    </div>
  );
}

/* --------------------------- Dashboard Tiles (NEW) --------------------------- */
function Tile({ title, blurb, actions, accent = "primary" }) {
  const ring =
    accent === "primary"
      ? "ring-primary/20"
      : accent === "secondary"
      ? "ring-secondary/20"
      : "ring-accent/20";
  return (
    <div
      className={`rounded-2xl border p-4 transition-all hover:shadow-lg hover:ring-4 ${ring}`}
    >
      <div className="text-base font-semibold">{title}</div>
      <p className="text-sm text-base-content/60 mt-1">{blurb}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {actions?.map((a, i) => (
          <CTA
            key={i}
            variant={a.variant || "secondary"}
            label={a.label}
            onClick={a.onClick}
            disabled={a.disabled}
          />
        ))}
      </div>
    </div>
  );
}

/* -------------------------- Grocery section heuristics -------------------------- */
function categorizeGroceryItemName(name) {
  const n = String(name || "").toLowerCase();

  if (
    /(lettuce|spinach|kale|greens|apple|banana|grape|berry|tomato|cucumber|onion|garlic|pepper|carrot|potato|herb|cilantro|parsley|basil|celery|broccoli|cabbage)/.test(
      n
    )
  ) {
    return "Produce";
  }
  if (
    /(chicken|beef|pork|lamb|turkey|sausage|ground beef|steak|roast|ham)/.test(n)
  ) {
    return "Meat & Poultry";
  }
  if (/(fish|salmon|tilapia|shrimp|cod|tuna)/.test(n)) {
    return "Seafood";
  }
  if (/(milk|cheese|yogurt|butter|cream|half[- ]and[- ]half)/.test(n)) {
    return "Dairy";
  }
  if (/\begg(s)?\b/.test(n)) {
    return "Eggs";
  }
  if (
    /(rice|flour|sugar|oil|olive oil|canola|corn oil|salt|pasta|noodle|beans|lentil|chickpea|spice|seasoning|cereal|oats|oatmeal|cornmeal|baking powder|baking soda|yeast)/.test(
      n
    )
  ) {
    return "Pantry & Baking";
  }
  if (/(frozen|ice cream|frozen peas|frozen corn|frozen veg|pizza)/.test(n)) {
    return "Frozen";
  }
  if (/(bread|bun|bagel|tortilla|pita|roll)/.test(n)) {
    return "Bakery";
  }
  if (
    /(soap|detergent|foil|wrap|paper towel|napkin|cleaner|bleach|sponge|trash bag)/.test(
      n
    )
  ) {
    return "Household & Cleaning";
  }
  return "Other";
}

function groupGroceryBySection(list) {
  const buckets = {};
  (list || []).forEach((item) => {
    const section = categorizeGroceryItemName(item.name);
    if (!buckets[section]) buckets[section] = [];
    buckets[section].push(item);
  });
  return Object.entries(buckets).map(([section, items]) => ({ section, items }));
}

/* --------------------------------- Page Component --------------------------------- */
export default function MealPlanningIndex() {
  const [loading, setLoading] = useState(false);
  const [plan, setPlan] = useState(null);
  const [calendar, setCalendar] = useState([]);
  const [grocery, setGrocery] = useState([]);
  const [macroSummary, setMacroSummary] = useState(null);
  const [runs, setRuns] = useState([]);
  const [bundles, setBundles] = useState([]);
  const [toast, setToast] = useState(null);

  // timeframe controls
  const [preset, setPreset] = useState("7");
  const [customStart, setCustomStart] = useState(dayjs().format("YYYY-MM-DD"));
  const [customEnd, setCustomEnd] = useState(
    dayjs().add(29, "day").format("YYYY-MM-DD")
  );
  const [people, setPeople] = useState(4);
  const [useInventory, setUseInventory] = useState(true);

  // NEW: user favorites (plan + prep)
  const [favoritePlans, setFavoritePlans] = useState([]);
  const [favoritePreps, setFavoritePreps] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await mealAgent?.handleCommand?.("getCurrentPlan");
        if (res?.mealPlan) {
          setPlan(res.mealPlan);
          setCalendar(res.calendarEvents || []);
          setMacroSummary(
            res?.data?.macroSummary || res?.mealPlan?._macroSummary || null
          );
          setGrocery(
            (res?.mealPlan?.groceryList || res?.data?.shoppingList || []).map(
              (i) => ({
                name: i.name || i.key,
                qty: i.qty,
                unit: i.unit || "",
              })
            )
          );
        }
      } finally {
        setLoading(false);
      }
    })();

    (async () => {
      const b = await mealAgent?.listBundles?.();
      const rows =
        b?.mealPlanningUpdates
          ?.find?.((x) => x.type === "meal.bundle_index")
          ?.bundles || [];
      setBundles(rows);
    })();

    on("recipes.consolidated", () =>
      setToast({
        kind: "info",
        text: "Recipes updated — consider re-running your plan.",
      })
    );
    on("inventory.updated", () =>
      setToast({
        kind: "info",
        text: "Inventory changed — your shopping list may improve.",
      })
    );
    on("calendar.synced", () =>
      setToast({ kind: "success", text: "Calendar synced." })
    );
    on("torah.profile.updated", () =>
      setToast({
        kind: "info",
        text: "Torah profile updated — we’ll respect changes going forward.",
      })
    );

    (async () => {
      try {
        const list = scenarios?.getRunsSnapshot?.() || [];
        setRuns(list.slice(0, 6));
      } catch {}
    })();

    // Load favorites from localStorage
    try {
      const storedPlans = localStorage.getItem("suka:mealFavorites");
      if (storedPlans) {
        setFavoritePlans(JSON.parse(storedPlans));
      }
      const storedPreps = localStorage.getItem("suka:prepFavorites");
      if (storedPreps) {
        setFavoritePreps(JSON.parse(storedPreps));
      }
    } catch {
      // ignore parse errors
    }
  }, []);

  /* --------------------------------- favorites helpers --------------------------------- */
  function persistFavorites(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore
    }
  }

  const hasPlan = !!plan?.plan?.length || !!plan?.days?.length;
  const prepItems = (plan?._calendarEvents || calendar || []).slice(0, 8);

  function saveFavoritePlan() {
    if (!hasPlan) {
      setToast({
        kind: "info",
        text: "Generate a plan before saving favorites.",
      });
      return;
    }
    const name = window.prompt(
      "Name this favorite meal plan:",
      "Sabbath + Week Plan"
    );
    if (!name) return;

    const fav = {
      id: `${Date.now()}`,
      name,
      createdAt: isoNow(),
      summary: plan?.summary || null,
      plan,
      grocery,
      calendar,
      macroSummary,
    };

    setFavoritePlans((prev) => {
      const next = [fav, ...prev];
      persistFavorites("suka:mealFavorites", next);
      return next;
    });
    setToast({ kind: "success", text: "Meal plan saved as favorite." });
  }

  function applyFavoritePlan(id) {
    const fav = favoritePlans.find((f) => f.id === id);
    if (!fav) return;
    setPlan(fav.plan);
    setGrocery(fav.grocery || []);
    setCalendar(fav.calendar || []);
    setMacroSummary(fav.macroSummary || null);
    setToast({ kind: "success", text: `Loaded favorite plan: ${fav.name}` });
  }

  function deleteFavoritePlan(id) {
    setFavoritePlans((prev) => {
      const next = prev.filter((f) => f.id !== id);
      persistFavorites("suka:mealFavorites", next);
      return next;
    });
  }

  function saveFavoritePrep() {
    if (!prepItems.length) {
      setToast({ kind: "info", text: "No prep items to save yet." });
      return;
    }
    const name = window.prompt(
      "Name this favorite prep schedule:",
      "Weekly Batch Prep"
    );
    if (!name) return;

    const fav = {
      id: `${Date.now()}`,
      name,
      createdAt: isoNow(),
      events: prepItems,
      meta: {
        people,
        useInventory,
        windowDays: calcDuration(),
      },
    };

    setFavoritePreps((prev) => {
      const next = [fav, ...prev];
      persistFavorites("suka:prepFavorites", next);
      return next;
    });
    setToast({ kind: "success", text: "Prep schedule saved as favorite." });
  }

  function applyFavoritePrep(id) {
    const fav = favoritePreps.find((f) => f.id === id);
    if (!fav) return;
    setCalendar(fav.events || []);
    setToast({
      kind: "success",
      text: `Loaded favorite prep schedule: ${fav.name}`,
    });
  }

  function deleteFavoritePrep(id) {
    setFavoritePreps((prev) => {
      const next = prev.filter((f) => f.id !== id);
      persistFavorites("suka:prepFavorites", next);
      return next;
    });
  }

  /* --------------------------------- actions --------------------------------- */
  const canPrint = useMemo(
    () =>
      !!labelsCfg &&
      Array.isArray(labelsCfg?.presets) &&
      labelsCfg.presets.length > 0 &&
      (plan?.groceryList?.length || 0) + (calendar?.length || 0) > 0,
    [labelsCfg, plan, calendar]
  );

  function calcDuration() {
    if (preset !== "custom") return Number(preset);
    const s = dayjs(customStart);
    const e = dayjs(customEnd);
    const days = Math.max(1, e.diff(s, "day") + 1);
    return days;
  }

  function durationString(days) {
    return days >= 365 ? `${Math.round(days / 365)}-year` : `${days}-day`;
  }

  async function runGeneratePlan() {
    const days = calcDuration();
    const duration = durationString(days);

    setLoading(true);
    try {
      const res = await mealAgent?.handleCommand?.("generatePlan", {
        prompt:
          days <= 7
            ? "Balanced meals using pantry first."
            : `Balanced ${duration} plan using pantry first; auto-batch staples.`,
        duration,
        budgetMode: "balanced",
        budgetLimit: null,
        useInventory,
        people,
        options: { saveAsDraft: true, autoSync: false },
        settings: { seasonality: true },
      });

      if (res?.mealPlan) {
        setPlan(res.mealPlan);
        setCalendar(res.calendarEvents || []);
        setGrocery(res?.data?.shoppingList || res?.mealPlan?.groceryList || []);
        setMacroSummary(
          res?.data?.macroSummary || res?.mealPlan?._macroSummary || null
        );
        setToast({
          kind: "success",
          text: `Generated ${duration} plan (saved as draft).`,
        });

        // Notify automation runtime + event bus (shared orchestration)
        try {
          automation?.emit?.("event", {
            type: "meal.plan.generated",
            ts: isoNow(),
            source: "ui/meal-planning",
            data: { durationDays: days, people, useInventory },
          });
        } catch {}

        emit("meal.plan.generated", {
          durationDays: days,
          people,
          useInventory,
          at: isoNow(),
        });

        // Kick off background forecasts (1–3 year) for garden, animals, preservation, cleaning, storehouse
        queueBackgroundForecasts({ baseDays: days, plan: res.mealPlan });
      } else {
        setToast({
          kind: "error",
          text: "Could not generate a plan right now.",
        });
      }
    } finally {
      setLoading(false);
    }
  }

  async function doBundleStart(bundleId) {
    const days = calcDuration();
    setLoading(true);
    try {
      const res = await mealAgent?.handleCommand?.("createPlanFromBundle", {
        bundleId,
        durationDays: days,
        options: { saveAsDraft: true },
        settings: { seasonality: true },
      });
      if (res?.mealPlan) {
        setPlan(res.mealPlan);
        setCalendar(res.calendarEvents || []);
        setGrocery(res?.data?.shoppingList || res?.mealPlan?.groceryList || []);
        setMacroSummary(
          res?.data?.macroSummary || res?.mealPlan?._macroSummary || null
        );
        setToast({
          kind: "success",
          text: `Bundle plan created for ${days} days.`,
        });

        emit("meal.plan.generated", {
          durationDays: days,
          bundleId,
          at: isoNow(),
        });

        queueBackgroundForecasts({ baseDays: days, plan: res.mealPlan });
      }
    } finally {
      setLoading(false);
    }
  }

  function doOpenScenarios() {
    emit("ui.goto", { to: "/analytics/scenarios" });
  }
  function doOpenShopping() {
    emit("ui.goto", { to: "/shopping" });
  }
  function doPrintLabels() {
    emit("flow.labels.buildFromMealPlan");
  }
  function doSharePlan() {
    emit("sharing.open", {
      subject: "Meal Plan",
      payload: { plan, calendar, grocery },
    });
  }
  function doSaveToStore() {
    emit("mealplan.save.requested", { plan, at: isoNow(), source: "ui" });
    setToast({ kind: "success", text: "Plan saved." });
  }

  /* ----------- COLLECT • DECIDE • PLAN tile actions (NEW) ----------- */
  // Collect
  const doOpenCollectOrganizer = () =>
    emit("ui.open", { panel: "CollectOrganize", scope: "all" });
  const doOpenPinterestWizard = () =>
    emit("ui.open", {
      panel: "PinterestImportWizard",
      mode: "boards",
      include: "all",
    });
  const doImportFromUrl = () =>
    emit("import.requested", {
      source: "url",
      at: isoNow(),
      scope: "recipes|ideas|products",
    });
  const doScanPhoto = () =>
    emit("import.requested", {
      source: "photo",
      at: isoNow(),
      scope: "recipes|labels|receipts",
    });

  // Decide
  const decideForMe = (slot = inferSlotByNow()) => {
    emit("ui.open", {
      panel: "RecipeDecider",
      date: new Date(),
      slot,
      intent: "single",
      autoPick: true,
    });
    emit("decider.decide.requested", { slot, at: isoNow() });
  };
  function inferSlotByNow() {
    const h = new Date().getHours();
    if (h < 11) return "breakfast";
    if (h < 16) return "lunch";
    return "dinner";
  }

  // Plan
  const openMealPlanner = () => emit("ui.goto", { to: "/meal-planner" });
  const planFromBundles = () =>
    emit("ui.goto", { to: "/tier2/household/meals#bundles" });

  /* ----------------------------- background forecasts ----------------------------- */
  async function queueBackgroundForecasts({ baseDays = 30, plan: mealPlan }) {
    try {
      // derive a horizon ladder: 1-year, 2-year, 3-year (animals, perennials, preservation capacity)
      const horizons = [365, 730, 1095];

      // Signal other systems regardless of agent presence
      emit("forecast.requested", {
        at: isoNow(),
        scopes: ["garden", "animals", "preservation", "storehouse", "cleaning"],
        horizons,
        baseDays,
      });

      try {
        automation?.emit?.("event", {
          type: "forecast.requested",
          ts: isoNow(),
          source: "ui/meal-planning",
          data: {
            scopes: [
              "garden",
              "animals",
              "preservation",
              "storehouse",
              "cleaning",
            ],
            horizons,
            baseDays,
          },
        });
      } catch {
        // non-blocking
      }

      // GARDEN: prioritize fruit trees / perennials for multi-year (zone-aware)
      const zone = (mealPlan?.meta?.location?.zone || "").toString();
      const crops = pickGardenCropsFromPlan(mealPlan); // coarse mapping from ingredients → crops
      for (const years of [1, 2, 3]) {
        const horizonDays = years * 365;
        await gardenPlanAgent?.handle?.("generateGardenPlan", {
          location: { zone },
          beds: [], // your app can inject real beds via store
          crops,
          planGoals: { startDate: isoNow(), successions: 2 },
          options: {
            horizonDays,
            rotation: { minYearsBetweenSameFamily: 3 },
            useMealPlanSignals: true,
          },
          // If your meal agent already computes weights, the garden agent will also try to fetch them
        });
      }

      // PRESERVATION: suggest capacity cadence aligned to extended plan
      await preservationAgent?.actions?.planJobs?.({
        household: { shellfishAllowed: true }, // household profile can be resolved inside the agent
        jobs: inferPreservationJobsFromPlan(mealPlan),
        options: { whenISO: isoNow() },
      });

      // ANIMALS (optional): feed + butchery horizon
      const animalSignals = inferAnimalFeedSignals(mealPlan);
      emit("animals.forecast.requested", {
        at: isoNow(),
        horizonDays: 1095,
        signals: animalSignals,
      });
      try {
        await animalsAgent?.handle?.("forecastFromMealPlan", {
          mealPlan,
          horizonDays: 1095,
          signals: animalSignals,
        });
      } catch {
        // ignore, optional
      }

      // CLEANING (optional): dish/load cadence from meal density
      try {
        const totalMeals = (mealPlan?.plan || mealPlan?.days || []).reduce(
          (acc, d) => {
            const meals =
              d.meals ||
              [d.breakfast, d.lunch, d.dinner, ...(d.snacks || [])].filter(
                Boolean
              );
            return acc + meals.length;
          },
          0
        );
        const cleaningPayload = {
          at: isoNow(),
          horizonDays: baseDays,
          totalMeals,
          people,
          intensity: totalMeals / Math.max(1, baseDays),
        };
        emit("cleaning.forecast.requested", cleaningPayload);
        await cleaningShim?.handle?.("forecastFromMealPlan", {
          mealPlan,
          forecast: cleaningPayload,
        });
      } catch {
        // non-blocking
      }

      // STOREHOUSE: multi-window stock plan from grocery signals
      try {
        const groceryList =
          mealPlan?.groceryList || (Array.isArray(grocery) ? grocery : []);
        const stockContext = {
          at: isoNow(),
          horizons,
          baseDays,
          groceryList,
        };
        emit("storehouse.stockplan.requested", stockContext);
        await storehouseShim?.handle?.("buildStockPlan", {
          mealPlan,
          groceryList,
          horizons,
          baseDays,
        });
      } catch {
        // silent — optional
      }

      // Subtle UX: a single info toast that work was queued
      setToast({
        kind: "info",
        text: "Background forecasts queued for garden, animals, preservation, cleaning, and storehouse.",
      });
    } catch {
      // silent—non-blocking
    }
  }

  // Map ingredients → likely crops (very light heuristic; your agents can refine)
  function pickGardenCropsFromPlan(mealPlan) {
    const key = (s) => String(s || "").toLowerCase();
    const seen = new Map();
    const push = (name, meta = {}) => {
      const k = key(name);
      if (!k) return;
      if (!seen.has(k)) seen.set(k, { name, ...meta });
    };
    const days = mealPlan?.plan || mealPlan?.days || [];
    for (const d of days) {
      const meals =
        d.meals ||
        [d.breakfast, d.lunch, d.dinner, ...(d.snacks || [])].filter(Boolean);
      for (const m of meals) {
        for (const ing of m.ingredients || []) {
          const n = key(ing.name || ing.key);
          if (
            [
              "tomato",
              "basil",
              "kale",
              "cucumber",
              "pepper_bell",
              "onion",
              "garlic",
              "carrot",
              "lettuce",
              "spinach",
            ].some((t) => n.includes(t))
          ) {
            push(n.split("_")[0]);
          }
        }
      }
    }
    return Array.from(seen.values()).map((c) => ({
      name: c.name,
      transplant: /tomato|pepper|eggplant/.test(c.name),
      smallSeed: /carrot|lettuce|spinach|kale/.test(c.name),
      frostTolerance: /tomato|cucumber|pepper/.test(c.name)
        ? "tender"
        : /kale|spinach|lettuce|onion|garlic/.test(c.name)
        ? "hardy"
        : "semi",
      daysToMaturity: /tomato/.test(c.name)
        ? 75
        : /cucumber/.test(c.name)
        ? 60
        : 55,
    }));
  }

  function inferPreservationJobsFromPlan(mealPlan) {
    const jobs = [];
    const days = mealPlan?.plan || mealPlan?.days || [];
    let idx = 1;
    for (const d of days) {
      const meals =
        d.meals ||
        [d.breakfast, d.lunch, d.dinner, ...(d.snacks || [])].filter(Boolean);
      let hasTomato = false;
      let hasCuke = false;
      for (const m of meals) {
        for (const ing of m.ingredients || []) {
          const n = String(ing.name || ing.key || "").toLowerCase();
          if (n.includes("tomato")) hasTomato = true;
          if (n.includes("cucumber") || n.includes("cuke")) hasCuke = true;
        }
      }
      if (hasTomato && idx % 7 === 0) {
        jobs.push({
          id: `job-tomato-${idx}`,
          name: "Tomato Sauce (Canning)",
          primary: "produce",
          category: "pickle",
          method: { type: "canning" },
          ingredients: [{ sku: "VEG-TOMATO", qty: 5, unit: "kg" }],
          leadTimes: { bottleDays: 0 },
        });
      }
      if (hasCuke && idx % 10 === 0) {
        jobs.push({
          id: `job-cuke-${idx}`,
          name: "Pickled Cucumbers",
          primary: "produce",
          category: "pickle",
          method: { type: "pickle", targetPH: 3.6, salinityPct: 5 },
          ingredients: [{ sku: "VEG-CUCUMBER", qty: 2, unit: "kg" }],
          leadTimes: { restHours: 12, ageDays: 3 },
        });
      }
      idx++;
    }
    return jobs.slice(0, 6);
  }

  function inferAnimalFeedSignals(mealPlan) {
    // Stub: use total plan length & staple grains/legumes references as a proxy for feed + butchery planning
    const days = (mealPlan?.plan || mealPlan?.days || []).length || 0;
    return {
      planDays: days,
      proxies: {
        grainsDemand: days > 60 ? "high" : days > 30 ? "medium" : "low",
        legumesDemand: days > 60 ? "medium" : "low",
      },
    };
  }

  /* ----------------------------------- render bits ----------------------------------- */
  function MacroCard() {
    const m = plan?.summary?.perDay || macroSummary?.perDay || null;
    const pct =
      macroSummary?.pctPerDay || plan?.summary?.pctPerDay || null;
    if (!m) return null;
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border p-3">
          <div className="text-xs text-base-content/60">Calories/day</div>
          <div className="text-lg font-semibold">{fmt(m.calories)}</div>
        </div>
        <div className="rounded-xl border p-3">
          <div className="text-xs text-base-content/60">Protein (g)</div>
          <div className="text-lg font-semibold">
            {fmt(m.protein_g)}{" "}
            {pct ? (
              <span className="text-xs text-base-content/60">
                ({fmt(pct.protein_pct)}%)
              </span>
            ) : null}
          </div>
        </div>
        <div className="rounded-xl border p-3">
          <div className="text-xs text-base-content/60">Carbs (g)</div>
          <div className="text-lg font-semibold">
            {fmt(m.carbs_g)}{" "}
            {pct ? (
              <span className="text-xs text-base-content/60">
                ({fmt(pct.carbs_pct)}%)
              </span>
            ) : null}
          </div>
        </div>
        <div className="rounded-xl border p-3">
          <div className="text-xs text-base-content/60">Fat (g)</div>
          <div className="text-lg font-semibold">
            {fmt(m.fat_g)}{" "}
            {pct ? (
              <span className="text-xs text-base-content/60">
                ({fmt(pct.fat_pct)}%)
              </span>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  function ScenariosStrip() {
    if (!runs?.length) return null;
    return (
      <div className="flex w-full overflow-x-auto gap-2 py-1">
        {runs.map((r) => {
          const label =
            scenarios
              ?.getScenarioRegistrySnapshot?.()
              .find?.((s) => s.id === r.scenarioId)?.label || r.scenarioId;
          return (
            <div key={r.id} className="shrink-0 rounded-xl border px-3 py-2">
              <div className="text-xs text-base-content/60">{label}</div>
              <div className="text-sm font-semibold">
                run · {dayjs(r.at).fromNow?.() || dayjs(r.at).format("MM/DD")}
              </div>
              <div className="text-[10px] text-base-content/60">
                cost {fmt(r.metrics?.cost?.total)} · miss{" "}
                {fmt(r.metrics?.availability?.missingItems?.length)}
              </div>
            </div>
          );
        })}
        <CTA
          variant="ghost"
          label="Compare"
          onClick={() =>
            emit("ui.goto", { to: "/analytics/scenarios/compare" })
          }
        />
      </div>
    );
  }

  const grocerySections = useMemo(
    () => groupGroceryBySection(grocery),
    [grocery]
  );

  /* -------------------------------------- UI -------------------------------------- */
  return (
    <div className="mx-auto max-w-7xl p-4 md:p-6 space-y-6">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">Meal Planning</h1>
          <p className="text-base-content/60 text-sm">
            Plan 7 / 30 / 60 / 90 days—or choose a custom window. Background
            forecasts feed your garden, animals, preservation, cleaning, and
            storehouse.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CTA label="Generate Plan" onClick={runGeneratePlan} />
          <CTA variant="secondary" label="Scenarios" onClick={doOpenScenarios} />
          <CTA variant="ghost" label="Shopping" onClick={doOpenShopping} />
        </div>
      </div>

      {/* NEW: Dashboard Tiles — Collect • Decide • Plan */}
      <Section
        title="Get Started"
        subtitle="Move from inspiration → decision → organized plan."
      >
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Tile
            title="Collect"
            blurb="Import ideas from Pinterest, URLs, and photos. Organize boards into the right Suka modules."
            accent="secondary"
            actions={[
              {
                label: "Open Collector",
                onClick: doOpenCollectOrganizer,
                variant: "secondary",
              },
              {
                label: "Import Pinterest",
                onClick: doOpenPinterestWizard,
                variant: "ghost",
              },
              { label: "Paste URL", onClick: doImportFromUrl, variant: "ghost" },
              { label: "Scan Photo", onClick: doScanPhoto, variant: "ghost" },
            ]}
          />
          <Tile
            title="Decide"
            blurb="Short on time? Let Suka pick a meal for now (or the whole week)."
            accent="primary"
            actions={[
              {
                label: "Decide For Me",
                onClick: () => decideForMe(),
                variant: "secondary",
              },
              {
                label: "Breakfast",
                onClick: () => decideForMe("breakfast"),
                variant: "ghost",
              },
              {
                label: "Lunch",
                onClick: () => decideForMe("lunch"),
                variant: "ghost",
              },
              {
                label: "Dinner",
                onClick: () => decideForMe("dinner"),
                variant: "ghost",
              },
            ]}
          />
          <Tile
            title="Plan"
            blurb="Generate a draft from pantry-first signals and sync to your calendar."
            accent="accent"
            actions={[
              {
                label: "Open Planner",
                onClick: openMealPlanner,
                variant: "secondary",
              },
              {
                label: "Use a Bundle",
                onClick: planFromBundles,
                variant: "ghost",
              },
              {
                label: "Generate Draft",
                onClick: runGeneratePlan,
                variant: "ghost",
              },
            ]}
          />
        </div>
      </Section>

      {/* Toast */}
      {toast ? (
        <div
          role="status"
          className={`alert ${
            toast.kind === "error"
              ? "alert-error"
              : toast.kind === "success"
              ? "alert-success"
              : "alert-info"
          } rounded-2xl`}
        >
          <span>{toast.text}</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setToast(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Timeframe controls */}
      <Section
        title="Timeframe"
        subtitle="Choose a planning window; custom dates supported."
        right={
          <div className="flex items-center gap-2">
            <label className="input input-bordered rounded-2xl flex items-center gap-2">
              <span className="text-xs">People</span>
              <input
                aria-label="People"
                type="number"
                className="grow"
                value={people}
                min={1}
                onChange={(e) =>
                  setPeople(Math.max(1, Number(e.target.value || 1)))
                }
              />
            </label>
            <label className="label cursor-pointer gap-2">
              <span className="text-xs text-base-content/60">Use Pantry</span>
              <input
                type="checkbox"
                className="toggle"
                checked={useInventory}
                onChange={(e) => setUseInventory(e.target.checked)}
              />
            </label>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              className={`rounded-xl border px-3 py-2 text-sm ${
                preset === p.key ? "border-primary" : "border-base-200"
              }`}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
          {preset === "custom" ? (
            <div className="flex items-center gap-2">
              <input
                type="date"
                className="input input-bordered rounded-2xl"
                value={customStart}
                onChange={(e) => setCustomStart(e.target.value)}
              />
              <span>to</span>
              <input
                type="date"
                className="input input-bordered rounded-2xl"
                value={customEnd}
                onChange={(e) => setCustomEnd(e.target.value)}
              />
            </div>
          ) : null}
          <CTA label="Generate" onClick={runGeneratePlan} />
        </div>
      </Section>

      {/* Quick-start bundles */}
      {!hasPlan ? (
        <Section
          title="Quick Start"
          subtitle="Kick off with a curated bundle (respects your timeframe)."
          right={
            <CTA
              variant="ghost"
              label="Browse all"
              onClick={() =>
                emit("ui.goto", { to: "/tier2/household/meals#bundles" })
              }
            />
          }
        >
          {bundles.length ? (
            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3">
              {bundles.slice(0, 6).map((b) => (
                <button
                  key={b.id}
                  onClick={() => doBundleStart(b.id)}
                  className="rounded-xl border p-3 text-left hover:border-primary transition-colors"
                >
                  <div className="text-sm font-semibold">{b.label}</div>
                  <div className="text-xs text-base-content/60 line-clamp-2">
                    {b.description || "Bundle"}
                  </div>
                  <div className="mt-2">
                    {(b.tags || []).slice(0, 3).map((t) => (
                      <span
                        key={t}
                        className={`${badgeCls} border-base-200 mr-1 mt-1`}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No bundles yet"
              subtitle="Import or define bundles in your Recipe Vault."
              primary={{ label: "Generate Plan", onClick: runGeneratePlan }}
            />
          )}
        </Section>
      ) : null}

      {/* Current plan */}
      <Section
        title={hasPlan ? "Current Plan" : "No Plan Yet"}
        subtitle={
          hasPlan
            ? plan?.summary ||
              `${(plan?.days || plan?.plan?.length || 0)} day plan`
            : "Create a plan to see meals, macros, shopping, and prep schedule."
        }
        right={
          hasPlan ? (
            <div className="flex items-center gap-2">
              <CTA variant="secondary" label="Save" onClick={doSaveToStore} />
              <CTA
                variant="ghost"
                label="Save as Favorite"
                onClick={saveFavoritePlan}
              />
              <CTA variant="ghost" label="Share" onClick={doSharePlan} />
              <CTA
                variant="ghost"
                label="Labels"
                onClick={doPrintLabels}
                disabled={!canPrint}
              />
            </div>
          ) : null
        }
      >
        {hasPlan ? (
          <>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              {(plan.badges || []).map((b) => (
                <span key={b} className={`${badgeCls} border-base-200`}>
                  {b}
                </span>
              ))}
            </div>
            <MacroCard />
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 mt-4">
              {(plan.plan || plan.days || []).slice(0, 9).map((d, idx) => {
                const meals =
                  d.meals ||
                  [d.breakfast, d.lunch, d.dinner, ...(d.snacks || [])].filter(
                    Boolean
                  );
                return (
                  <div key={idx} className="rounded-xl border p-3">
                    <div className="text-sm font-semibold">
                      Day {d.day || idx + 1} ·{" "}
                      {dayjs(d.date).format("MMM D")}
                    </div>
                    <ul className="mt-2 space-y-1">
                      {meals.map((m, i) => (
                        <li key={i} className="text-sm">
                          • <span className="font-medium">{m.title}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <EmptyState
            title="Plan your window"
            subtitle="Use your pantry first, then fill the gaps."
            primary={{ label: "Generate Plan", onClick: runGeneratePlan }}
            secondary={[
              { label: "Scenarios", onClick: doOpenScenarios },
              { label: "Open Shopping", onClick: doOpenShopping },
            ]}
          />
        )}
      </Section>

      {/* Favorite Plans */}
      {favoritePlans.length ? (
        <Section
          title="Favorite Plans"
          subtitle="Your saved, re-usable meal plans and schedules."
        >
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {favoritePlans.map((fav) => (
              <div
                key={fav.id}
                className="rounded-xl border p-3 flex flex-col gap-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold">{fav.name}</div>
                    <div className="text-[11px] text-base-content/60">
                      Saved {dayjs(fav.createdAt).format("MMM D, h:mm A")}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs"
                    onClick={() => deleteFavoritePlan(fav.id)}
                  >
                    ✕
                  </button>
                </div>
                {fav.summary ? (
                  <div className="text-xs text-base-content/70 line-clamp-2">
                    {typeof fav.summary === "string"
                      ? fav.summary
                      : fav.summary?.label || ""}
                  </div>
                ) : null}
                <div className="mt-1 flex items-center gap-2">
                  <CTA
                    variant="secondary"
                    label="Load"
                    onClick={() => applyFavoritePlan(fav.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Prep schedule */}
      {hasPlan ? (
        <Section
          title="Prep Schedule"
          subtitle="Batch-cook staples, Sabbath-aware holds, and calendar sync."
          right={
            <div className="flex items-center gap-2">
              <CTA
                variant="ghost"
                label="Save as Favorite"
                onClick={saveFavoritePrep}
              />
              <CTA
                variant="ghost"
                label="Open Calendar"
                onClick={() => emit("ui.goto", { to: "/calendar" })}
              />
            </div>
          }
        >
          {prepItems.length ? (
            <>
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                {prepItems.map((ev, i) => (
                  <div key={i} className="rounded-xl border p-3">
                    <div className="text-sm font-semibold">{ev.title}</div>
                    <div className="text-xs text-base-content/60">
                      {dayjs(ev.datetime || ev.startISO).format(
                        "ddd, MMM D h:mm A"
                      )}
                    </div>
                    {ev.guard?.blocked ? (
                      <div className="text-xs mt-1 text-warning">
                        Sabbath hold — move earlier/later.
                      </div>
                    ) : null}
                    {ev.notes ? (
                      <div className="text-xs mt-2">{ev.notes}</div>
                    ) : null}
                  </div>
                ))}
              </div>
              {favoritePreps.length ? (
                <div className="mt-4 border-t pt-4">
                  <h3 className="text-sm font-semibold mb-2">
                    Favorite Prep Schedules
                  </h3>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    {favoritePreps.map((fav) => (
                      <div
                        key={fav.id}
                        className="rounded-xl border p-3 flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div>
                            <div className="text-sm font-semibold">
                              {fav.name}
                            </div>
                            <div className="text-[11px] text-base-content/60">
                              Saved{" "}
                              {dayjs(fav.createdAt).format("MMM D, h:mm A")}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn btn-ghost btn-xs"
                            onClick={() => deleteFavoritePrep(fav.id)}
                          >
                            ✕
                          </button>
                        </div>
                        <div className="text-[11px] text-base-content/60">
                          {fav.events?.length || 0} prep items ·{" "}
                          {fav.meta?.windowDays
                            ? `${fav.meta.windowDays} days`
                            : ""}
                        </div>
                        <CTA
                          variant="secondary"
                          label="Load schedule"
                          onClick={() => applyFavoritePrep(fav.id)}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <EmptyState
              title="No prep items yet"
              subtitle="Batch steps and make-ahead tasks show here."
              primary={{ label: "Generate Plan", onClick: runGeneratePlan }}
            />
          )}
        </Section>
      ) : null}

      {/* Shopping list */}
      {hasPlan ? (
        <Section
          title="Shopping List"
          subtitle="Built from your plan and adjusted by pantry. Grouped by grocery section to inspire storehouse stock planning."
          right={
            <div className="flex items-center gap-2">
              <CTA
                variant="secondary"
                label="Open Shopping"
                onClick={doOpenShopping}
              />
              <CTA
                variant="ghost"
                label="Storehouse Plan"
                onClick={() =>
                  emit("storehouse.stockplan.requested", {
                    at: isoNow(),
                    sections: grocerySections,
                  })
                }
              />
            </div>
          }
        >
          {grocery?.length ? (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {grocerySections.map((section) => (
                <div
                  key={section.section}
                  className="rounded-xl border p-3 flex flex-col gap-2"
                >
                  <div className="text-sm font-semibold mb-1">
                    {section.section}
                  </div>
                  {section.items.slice(0, 12).map((i, idx) => (
                    <div
                      key={`${i.name}-${idx}`}
                      className="rounded-lg border border-base-200 p-2 text-sm flex items-center justify-between"
                    >
                      <span className="truncate">{i.name}</span>
                      <span className="text-base-content/60">
                        {fmt(i.qty)} {i.unit || ""}
                      </span>
                    </div>
                  ))}
                  {section.items.length > 12 ? (
                    <div className="text-[11px] text-base-content/60 mt-1">
                      +{section.items.length - 12} more
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              title="Nothing to buy"
              subtitle="Your pantry covers this plan 🎉"
              primary={{ label: "Print Labels", onClick: doPrintLabels }}
            />
          )}
        </Section>
      ) : null}

      {/* Scenarios */}
      <Section
        title="Scenarios"
        subtitle="Run what-ifs (budget, local vs. store, time windows) and compare outcomes."
        right={
          <CTA
            variant="ghost"
            label="Open Scenarios"
            onClick={doOpenScenarios}
          />
        }
      >
        <ScenariosStrip />
        {!runs?.length ? (
          <EmptyState
            title="No scenario runs yet"
            subtitle="Try Budget tiers or Shellfish on/off to see trade-offs quickly."
            primary={{ label: "Open Scenarios", onClick: doOpenScenarios }}
          />
        ) : null}
      </Section>

      {/* Footer */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-base-content/60">
        <div>Last refreshed: {dayjs().format("MMM D, h:mm A")}</div>
        <div className="flex items-center gap-2">
          <button
            className="link"
            onClick={() => emit("ui.goto", { to: "/labels" })}
          >
            Labels
          </button>
          <span>·</span>
          <button
            className="link"
            onClick={() => emit("ui.goto", { to: "/analytics" })}
          >
            Analytics
          </button>
          <span>·</span>
          <button
            className="link"
            onClick={() => emit("ui.goto", { to: "/garden" })}
          >
            Garden
          </button>
        </div>
      </div>

      {/* Loading overlay */}
      {loading ? (
        <div className="fixed inset-0 bg-base-100/60 backdrop-blur-sm flex items-center justify-center z-40">
          <div className="rounded-2xl border bg-base-100 p-6 shadow-2xl">
            <div className="loading loading-spinner loading-lg" />
          </div>
        </div>
      ) : null}
    </div>
  );
}

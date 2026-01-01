// src/hooks/useOnboardingProgress.js
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Suka — Onboarding Progress Hook
 *
 * Goals:
 * - Track first-run tasks that unlock the system's value (vision -> meals -> cleaning -> inventory).
 * - Be resilient: detect completions via global CustomEvents AND by peeking into stores (optional, lazy).
 * - Be automation-first: each step has an `intent` that your runtime can act on.
 * - Persist across sessions (localStorage) with schema versioning.
 *
 * Exposes:
 *  - steps: [{ id, title, desc, status, weight, intent, action(), skip(), done(), detect() }]
 *  - percent, completedCount, totalWeight, remainingWeight
 *  - nextStep: next actionable step object or null
 *  - markDone(id), markSkipped(id, reason), reset(), resumeNext()
 *  - state: raw persisted model
 */

const STORAGE_KEY = "suka.onboarding.v1";
const SCHEMA = 1;

// Small debounce so we don't thrash localStorage on rapid updates
const debounce = (fn, ms = 120) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.schema !== SCHEMA) return null;
    return parsed;
  } catch {
    return null;
  }
}
const saveStateDebounced = debounce((state) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {}
}, 80);

/* -------------------------- Optional Store Probes ------------------------- */
/** These are defensive; if a store/module isn't present, we just return null. */
async function probeStores() {
  const res = {};
  // Vision
  try {
    const mod = await import(/* @vite-ignore */ "@/context/VisionContext").catch(() => null);
    const useVision = mod?.useVision;
    if (useVision) {
      const o = useVision.getState ? useVision.getState()?.options : null;
      res.visionSaved = !!(o && (o.mode?.length || o.goals?.length || o.constraints?.length || o.dietary?.length));
      res.weeklyHrs = o?.weeklyHrs ?? null;
    }
  } catch {}

  // Recipes
  try {
    const mod = await import(/* @vite-ignore */ "@/store/RecipeStore").catch(() => null);
    const s = mod?.useRecipes?.getState?.();
    res.hasRecipe = !!(s?.items?.length);
  } catch {}

  // Meal plan
  try {
    const mod = await import(/* @vite-ignore */ "@/store/MealPlanStore").catch(() => null);
    const s = mod?.useMealPlan?.getState?.();
    res.mealsPlanned = Number(s?.week?.items?.length || 0);
    res.hasRhythm = !!s?.rhythm;
  } catch {}

  // Cleaning
  try {
    const mod = await import(/* @vite-ignore */ "@/store/CleaningStore").catch(() => null);
    const s = mod?.useCleaning?.getState?.();
    res.cleaningGenerated = Number(s?.today?.tasks?.length || 0) > 0;
  } catch {}

  // Inventory
  try {
    const mod = await import(/* @vite-ignore */ "@/store/InventoryStore").catch(() => null);
    const s = mod?.useInventory?.getState?.();
    res.inventoryItems = Number(s?.all?.length || 0);
  } catch {}

  // Calendar (optional)
  try {
    const mod = await import(/* @vite-ignore */ "@/services/calendar/state").catch(() => null);
    res.calendarLinked = !!mod?.isLinked?.();
  } catch {}

  // Notifications (optional)
  try {
    res.notificationsEnabled = typeof Notification !== "undefined" && Notification.permission === "granted";
  } catch {}

  return res;
}

/* ------------------------------- Hook Core -------------------------------- */
export function useOnboardingProgress() {
  const [state, setState] = useState(() => {
    const loaded = loadState();
    return (
      loaded || {
        schema: SCHEMA,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        completed: {}, // { [id]: timestamp }
        skipped: {}, // { [id]: { at, reason } }
        meta: {}, // misc metrics
      }
    );
  });

  const save = useCallback(
    (next) => {
      const model = typeof next === "function" ? next(state) : next;
      setState(model);
      saveStateDebounced(model);
    },
    [state]
  );

  /* ---------- Global event listeners that mark steps as done ---------- */
  useEffect(() => {
    const mark = (id) => markDone(id);
    const handlers = [
      ["vision:updated", () => mark("household_profile")],
      ["recipes:imported", () => mark("scan_recipe")],
      ["mealPlan:opened", () => mark("open_meal_planner")],
      ["mealPlan:rhythm:created", () => mark("create_meal_rhythm")],
      ["cleaning:generated", () => mark("generate_cleaning")],
      ["inventory:item:added", () => mark("add_inventory")],
      ["calendar:linked", () => mark("link_calendar")],
      ["notifications:enabled", () => mark("enable_notifications")],
    ];
    handlers.forEach(([evt, fn]) => window.addEventListener(evt, fn));
    return () => handlers.forEach(([evt, fn]) => window.removeEventListener(evt, fn));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Periodic store probes (lazy, safe) ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      const p = await probeStores();
      if (!alive) return;
      if (p.visionSaved) markDone("household_profile");
      if (p.hasRecipe) markDone("scan_recipe");
      if (p.mealsPlanned > 0) markDone("open_meal_planner");
      if (p.hasRhythm) markDone("create_meal_rhythm");
      if (p.cleaningGenerated) markDone("generate_cleaning");
      if (p.inventoryItems > 0) markDone("add_inventory");
      if (p.calendarLinked) markDone("link_calendar");
      if (p.notificationsEnabled) markDone("enable_notifications");
    })();
    const t = setInterval(async () => {
      const p = await probeStores();
      if (p.mealsPlanned > 0) markDone("open_meal_planner");
    }, 15_000); // light touch
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Step Model ---------- */
  const stepsModel = useMemo(
    () => [
      {
        id: "household_profile",
        title: "Save your Household Vision",
        desc: "Mode, goals, constraints, dietary notes, weekly hours, budget.",
        weight: 18,
        intent: "vision/open", // your page handles collapsing/editing; save triggers vision:updated
        detect: (s) => !!s.completed.household_profile,
      },
      {
        id: "scan_recipe",
        title: "Scan or import a recipe",
        desc: "Use the recipe consolidator to normalize one recipe.",
        weight: 12,
        intent: "recipes/scan",
        detect: (s) => !!s.completed.scan_recipe,
      },
      {
        id: "create_meal_rhythm",
        title: "Create a weekly meal rhythm",
        desc: "Batch nights + fasting/feast windows (e.g., 16:8).",
        weight: 16,
        intent: "mealPlan/rhythm/suggest",
        detect: (s) => !!s.completed.create_meal_rhythm,
      },
      {
        id: "open_meal_planner",
        title: "Open the Meal Planner",
        desc: "Generate your first plan with your vision.",
        weight: 12,
        intent: "mealPlan/open",
        detect: (s) => !!s.completed.open_meal_planner,
      },
      {
        id: "generate_cleaning",
        title: "Generate a cleaning session",
        desc: "Rhythm-aware 60–90 minute focus block.",
        weight: 12,
        intent: "cleaning/generate",
        detect: (s) => !!s.completed.generate_cleaning,
      },
      {
        id: "add_inventory",
        title: "Add one inventory item",
        desc: "Start tracking pantry/freezer essentials.",
        weight: 10,
        intent: "inventory/open",
        detect: (s) => !!s.completed.add_inventory,
      },
      {
        id: "enable_notifications",
        title: "Enable notifications",
        desc: "Get nudges for timers, batch sessions and reminders.",
        weight: 10,
        intent: "notifications/enable",
        detect: (s) => !!s.completed.enable_notifications,
      },
      {
        id: "link_calendar",
        title: "Link your calendar (optional)",
        desc: "Block out batch nights and Moedim automatically.",
        weight: 10,
        optional: true,
        intent: "calendar/link",
        detect: (s) => !!s.completed.link_calendar,
      },
    ],
    []
  );

  const steps = useMemo(() => {
    return stepsModel.map((m) => {
      const completed = !!state.completed[m.id];
      const skipped = !!state.skipped[m.id];
      const status = completed ? "done" : skipped ? "skipped" : "pending";
      return {
        ...m,
        status,
        completedAt: state.completed[m.id],
        skippedAt: state.skipped[m.id]?.at,
        skipReason: state.skipped[m.id]?.reason,
        action: () => emitIntent(m.intent),
        done: () => markDone(m.id),
        skip: (reason) => markSkipped(m.id, reason),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  /* ---------- Aggregates ---------- */
  const totals = useMemo(() => {
    const totalWeight = stepsModel.reduce((a, s) => a + (s.weight || 0), 0);
    const completedWeight = stepsModel.reduce((a, s) => a + (state.completed[s.id] ? s.weight || 0 : 0), 0);
    const completedCount = Object.keys(state.completed).length;
    const percent = totalWeight > 0 ? Math.round((completedWeight / totalWeight) * 100) : 0;
    const remainingWeight = Math.max(0, totalWeight - completedWeight);
    return { percent, completedCount, totalWeight, remainingWeight };
  }, [state.completed, stepsModel]);

  const nextStep = useMemo(() => {
    // prioritize required items; then optional
    const required = steps.filter((s) => s.status === "pending" && !s.optional);
    if (required.length) return required[0];
    const optional = steps.filter((s) => s.status === "pending" && s.optional);
    return optional[0] || null;
  }, [steps]);

  /* ---------- Commands ---------- */
  const markDone = useCallback(
    (id) => {
      save((prev) => {
        if (prev.completed[id]) return prev;
        const next = {
          ...prev,
          completed: { ...prev.completed, [id]: Date.now() },
          updatedAt: Date.now(),
        };
        // analytics hook
        window.dispatchEvent(new CustomEvent("onboarding:step:done", { detail: { id } }));
        return next;
      });
    },
    [save]
  );

  const markSkipped = useCallback(
    (id, reason = "user_skipped") => {
      save((prev) => {
        const next = {
          ...prev,
          skipped: { ...prev.skipped, [id]: { at: Date.now(), reason } },
          updatedAt: Date.now(),
        };
        window.dispatchEvent(new CustomEvent("onboarding:step:skipped", { detail: { id, reason } }));
        return next;
      });
    },
    [save]
  );

  const reset = useCallback(() => {
    const fresh = { schema: SCHEMA, startedAt: Date.now(), updatedAt: Date.now(), completed: {}, skipped: {}, meta: {} };
    setState(fresh);
    saveStateDebounced(fresh);
    window.dispatchEvent(new CustomEvent("onboarding:reset"));
  }, []);

  const resumeNext = useCallback(() => {
    if (!nextStep) return;
    emitIntent(nextStep.intent);
  }, [nextStep]);

  /* ---------- Intent emitter (matches your app pattern) ---------- */
  const emitIntent = useCallback((intent, detail) => {
    if (!intent) return;
    window.dispatchEvent(new CustomEvent("automation:intent", { detail: { intent, ...(detail || {}) } }));
    // Try optional runtime
    (async () => {
      try {
        const mod = await import(/* @vite-ignore */ "@/services/automation/runtime").catch(() => null);
        const runtime = mod?.automation || mod?.default || null;
        if (runtime?.emitIntent) await runtime.emitIntent(intent, detail || {});
      } catch {}
    })();
  }, []);

  return {
    steps,
    percent: totals.percent,
    completedCount: totals.completedCount,
    totalWeight: totals.totalWeight,
    remainingWeight: totals.remainingWeight,
    nextStep,
    markDone,
    markSkipped,
    reset,
    resumeNext,
    state,
  };
}

export default useOnboardingProgress;

/* ------------------------------ Usage Notes -------------------------------
1) Progress header:
   const ob = useOnboardingProgress();
   <ProgressMeter
     label="Getting set up"
     variant="linear"
     value={ob.percent}
     target={100}
     showPercent
     milestones={[
       { at: 25, label: "Vision" },
       { at: 50, label: "Meals" },
       { at: 75, label: "Cleaning" },
       { at: 100, label: "Done" },
     ]}
     actions={[
       ob.nextStep
         ? { label: `Do: ${ob.nextStep.title}`, icon: "→", onClick: ob.resumeNext, kind: "primary" }
         : { label: "Review steps", icon: "✓", intent: "onboarding/review" },
     ]}
   />

2) Checklist UI:
   {ob.steps.map(step => (
     <SectionCard
       key={step.id}
       title={step.title}
       subtitle={step.desc}
       badge={step.status === "done" ? "Done" : step.optional ? "Optional" : null}
       actions={
         step.status === "pending"
           ? [
               { label: "Do it", icon: "▶", onClick: step.action, kind: "primary" },
               { label: "Skip", icon: "⤼", onClick: () => step.skip("user_skipped") },
             ]
           : []
       }
     />
   ))}

3) Marking done from your flows:
   - Dispatch events in your features when actions complete:
     window.dispatchEvent(new CustomEvent("recipes:imported"));
     window.dispatchEvent(new CustomEvent("mealPlan:rhythm:created"));
     window.dispatchEvent(new CustomEvent("cleaning:generated"));
--------------------------------------------------------------------------- */

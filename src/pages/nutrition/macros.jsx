// C:\Users\larho\suka-smart-assistant\src\pages\nutrition\macros.jsx
/**
 * Route: /nutrition/macros
 *
 * What’s new vs. prior version:
 * - Reads & writes Nutrition goals (USDA/custom) with Undo
 * - Imports plan template goals (incl. Daniel Fast) when available
 * - Uses MacroRingsGroup for polished, animated macro viz
 * - Event-driven: listens to plan updates; emits suggest-swap actions
 * - Scope toggle (Plan / Week / Day) with gaps + “Next best action”
 * - Still gracefully falls back if agent/stores are missing
 */

import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";
import dayjs from "dayjs";

// ---------- Soft deps (graceful fallbacks) ----------
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { invoke: async () => {} };

let useNutritionStore = () => ({
  goals: null,
  setGoals: async () => {},
  templates: {
    balanced: {
      calories: 2000,
      protein_g: 100,
      carbs_g: 250,
      fat_g: 67,
      fiber_g: 30,
      sugar_g: 50,
      sodium_mg: 2000,
      satfat_g: 18,
    },
    highProtein: {
      calories: 2100,
      protein_g: 150,
      carbs_g: 200,
      fat_g: 70,
      fiber_g: 30,
      sugar_g: 45,
      sodium_mg: 2000,
      satfat_g: 18,
    },
    vegan: {
      calories: 2000,
      protein_g: 85,
      carbs_g: 300,
      fat_g: 60,
      fiber_g: 35,
      sugar_g: 60,
      sodium_mg: 1900,
      satfat_g: 14,
    },
  },
  refresh: async () => {},
});
let usePreferencesStore = () => ({ sabbathAware: true });
try {
  eventBus = require("@/services/events/eventBus").eventBus;
} catch {}
try {
  automation = require("@/services/automation/runtime").automation;
} catch {}
try {
  useNutritionStore = require("@/store/NutritionStore").useNutritionStore;
} catch {}
try {
  usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore;
} catch {}

// Optional central registry (for Daniel Fast etc.)
let MEAL_PLAN_TEMPLATES;
try {
  MEAL_PLAN_TEMPLATES =
    require("@/services/mealplanning/MealPlanTemplates").MEAL_PLAN_TEMPLATES;
} catch {}

// UI (shadcn)
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { toast } from "@/components/ui/use-toast";
import { Skeleton } from "@/components/ui/skeleton";

import { MacroRingsGroup } from "@/pages/nutrition/MacroRing.jsx";

// + Shared wiring layer (new canonical nutrition store + events)
import { useNutritionStore as useSharedNutritionStore } from "@/services/nutrition/nutritionStore";
import {
  NUTRITION_EVENTS,
  onNutritionEvent,
} from "@/services/nutrition/nutritionEvents";

// ---------- Prefer feature page if present ----------
const FeatureMacroPage = React.lazy(async () => {
  try {
    const mod = await import(
      "@/features/nutrition/pages/MacroCalculatorPage.jsx"
    );
    return { default: mod.default || mod };
  } catch {
    return { default: InlineMacroCalculator };
  }
});

// ---------- Utils (pure) ----------
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const toFixed = (n, d = 0) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

function pct(part, whole) {
  const w = Number(whole) || 0;
  if (w <= 0) return 0;
  return (Number(part) || 0) / w;
}
function kcalFromMacros({ proteinG = 0, carbsG = 0, fatG = 0 }) {
  return (
    proteinG * KCAL_PER_G.protein +
    carbsG * KCAL_PER_G.carbs +
    fatG * KCAL_PER_G.fat
  );
}
function gramsFromPctAndCalories(calories, { pPct, cPct, fPct }) {
  const cals = Number(calories) || 0;
  const P = clamp01(pPct);
  const C = clamp01(cPct);
  const F = clamp01(fPct);
  const total = P + C + F || 1;
  const nP = P / total,
    nC = C / total,
    nF = F / total;
  return {
    proteinG: (cals * nP) / KCAL_PER_G.protein,
    carbsG: (cals * nC) / KCAL_PER_G.carbs,
    fatG: (cals * nF) / KCAL_PER_G.fat,
  };
}

// Normalize many plan shapes -> { days:[{date?,label?,totals,meals}], planTotals }
function normalizePlanForMacros(plan) {
  if (!plan) return { days: [], planTotals: null };
  const outDays = [];

  const getMacros = (obj) => {
    if (!obj) return null;
    const n = obj.nutrition || obj.macros || null;
    if (
      n &&
      (Number(n.calories) ||
        Number(n.proteinG) ||
        Number(n.carbsG) ||
        Number(n.fatG))
    ) {
      return {
        calories: safeNum(n.calories, 0),
        proteinG: safeNum(n.proteinG, 0),
        carbsG: safeNum(n.carbsG, 0),
        fatG: safeNum(n.fatG, 0),
      };
    }
    if (
      Number(obj.calories) ||
      Number(obj.proteinG) ||
      Number(obj.carbsG) ||
      Number(obj.fatG)
    ) {
      return {
        calories: safeNum(obj.calories, 0),
        proteinG: safeNum(obj.proteinG, 0),
        carbsG: safeNum(obj.carbsG, 0),
        fatG: safeNum(obj.fatG, 0),
      };
    }
    return null;
  };

  const totalMacros = (items) => {
    const acc = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
    for (const it of items || []) {
      const m = getMacros(it);
      if (m) {
        acc.calories += m.calories || 0;
        acc.proteinG += m.proteinG || 0;
        acc.carbsG += m.carbsG || 0;
        acc.fatG += m.fatG || 0;
      }
    }
    return acc;
  };

  if (Array.isArray(plan.plan)) {
    for (const d of plan.plan) {
      const meals = Array.isArray(d.meals) ? d.meals : [];
      const dayTotals = getMacros(d) || totalMacros(meals);
      outDays.push({
        date: d.date || null,
        label: d.day != null ? `Day ${d.day}` : d.label || null,
        meals: meals.map((m) => ({
          title: m.title || m.name || "Meal",
          macros: getMacros(m),
        })),
        totals: dayTotals,
      });
    }
  }
  if (Array.isArray(plan.days)) {
    for (const d of plan.days) {
      const mealObjs = [
        ...(d.breakfast ? [{ ...d.breakfast, _slot: "Breakfast" }] : []),
        ...(d.lunch ? [{ ...d.lunch, _slot: "Lunch" }] : []),
        ...(d.dinner ? [{ ...d.dinner, _slot: "Dinner" }] : []),
        ...(d.snacks || []).map((s, i) => ({ ...s, _slot: `Snack ${i + 1}` })),
      ];
      const meals = mealObjs.map((m) => ({
        title: m.title || m._slot || "Meal",
        macros: getMacros(m),
      }));
      const totals = getMacros(d) || totalMacros(meals);
      outDays.push({
        date: d.date || null,
        label: d.label || (d.date ? dayjs(d.date).format("ddd") : null),
        meals,
        totals,
      });
    }
  }

  const planTotals =
    getMacros(plan) ||
    (outDays.length
      ? outDays.reduce(
          (acc, d) => ({
            calories: acc.calories + safeNum(d?.totals?.calories, 0),
            proteinG: acc.proteinG + safeNum(d?.totals?.proteinG, 0),
            carbsG: acc.carbsG + safeNum(d?.totals?.carbsG, 0),
            fatG: acc.fatG + safeNum(d?.totals?.fatG, 0),
          }),
          { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }
        )
      : null);

  return { days: outDays, planTotals };
}

function computeGaps(totals = {}, targets = {}) {
  if (!targets) return {};
  return {
    calories: (targets.calories ?? 0) - (totals.calories ?? 0),
    protein_g:
      (targets.protein_g ?? 0) - (totals.protein_g ?? totals.proteinG ?? 0),
    carbs_g: (targets.carbs_g ?? 0) - (totals.carbs_g ?? totals.carbsG ?? 0),
    fat_g: (targets.fat_g ?? 0) - (totals.fat_g ?? totals.fatG ?? 0),
  };
}

// ---------- Inline fallback page ----------
function InlineMacroCalculator() {
  const { goals, setGoals, templates, refresh } = useNutritionStore();
  const { sabbathAware } = usePreferencesStore();

  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState(null);
  const [plan, setPlan] = useState(null);

  // Targets UI state (linked to NutritionStore goals when available)
  const initialCalories = goals?.calories ?? 2000;
  const [mode, setMode] = useState("percent"); // 'percent' | 'grams'
  const [calTarget, setCalTarget] = useState(initialCalories);
  const [pPct, setPPct] = useState(() => {
    if (goals?.protein_g && initialCalories)
      return (goals.protein_g * KCAL_PER_G.protein) / initialCalories;
    return 0.3;
  });
  const [cPct, setCPct] = useState(() => {
    if (goals?.carbs_g && initialCalories)
      return (goals.carbs_g * KCAL_PER_G.carbs) / initialCalories;
    return 0.4;
  });
  const [fPct, setFPct] = useState(() => {
    if (goals?.fat_g && initialCalories)
      return (goals.fat_g * KCAL_PER_G.fat) / initialCalories;
    return 0.3;
  });
  const [pG, setPG] = useState(goals?.protein_g ?? 150);
  const [cG, setCG] = useState(goals?.carbs_g ?? 180);
  const [fG, setFG] = useState(goals?.fat_g ?? 67);

  const prevGoalsRef = useRef(goals);

  // Pull current plan via agent (dynamic import helper if needed)
  useEffect(() => {
    let canceled = false;
    async function boot() {
      setLoading(true);
      setLoadErr(null);
      try {
        let mealMod;
        try {
          mealMod = await import("@/agents/mealPlanningAgent");
        } catch {
          const util = await import("@/utils/dynImport");
          const { loadFromSrc } = util;
          mealMod = await loadFromSrc([
            "/src/agents/mealPlanningShim.js",
            "/src/agents/mealPlanningShim.jsx",
            "/src/agents/mealPlanningAgent.ts",
            "/src/agents/mealPlanningAgent.tsx",
          ]);
        }
        const mealAgent = mealMod?.default || mealMod;
        if (!mealAgent?.handleCommand)
          throw new Error("mealPlanningAgent.handleCommand not available");
        if (canceled) return;
        const res = await mealAgent.handleCommand("getCurrentPlan", {});
        if (canceled) return;
        setPlan(res?.mealPlan || res?.plan || null);
      } catch (e) {
        if (!canceled) setLoadErr(e?.message || String(e));
      } finally {
        if (!canceled) setLoading(false);
      }
    }
    boot();
    // refresh plan when updated elsewhere
    const off = eventBus.on("mealplan.updated", ({ draft }) => {
      if (!draft) return;
      setPlan((cur) => cur || draft); // prefer explicit reload later
    });
    return () => {
      canceled = true;
      off?.();
    };
  }, []);

  // Normalize plan
  const normalized = useMemo(() => normalizePlanForMacros(plan), [plan]);

  // Choose scope (Plan | Week(7) | Day(1))
  const [scope, setScope] = useState("plan"); // 'plan' | 'week' | 'day'
  const scopedDays = useMemo(() => {
    if (!normalized.days.length) return [];
    if (scope === "day") return normalized.days.slice(0, 1);
    if (scope === "week") return normalized.days.slice(0, 7);
    return normalized.days;
  }, [normalized.days, scope]);

  // Target grams from UI mode
  const targetGrams = useMemo(() => {
    if (mode === "grams") return { proteinG: pG, carbsG: cG, fatG: fG };
    return gramsFromPctAndCalories(calTarget, { pPct, cPct, fPct });
  }, [mode, calTarget, pPct, cPct, fPct, pG, cG, fG]);
  const targetAsGoals = {
    calories:
      mode === "grams"
        ? kcalFromMacros({ proteinG: pG, carbsG: cG, fatG: fG })
        : calTarget,
    protein_g: Math.round(targetGrams.proteinG || 0),
    carbs_g: Math.round(targetGrams.carbsG || 0),
    fat_g: Math.round(targetGrams.fatG || 0),
  };

  // Totals for scoped range
  const totals = useMemo(() => {
    if (!scopedDays.length)
      return { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
    return scopedDays.reduce(
      (acc, d) => ({
        calories: acc.calories + safeNum(d?.totals?.calories, 0),
        proteinG: acc.proteinG + safeNum(d?.totals?.proteinG, 0),
        carbsG: acc.carbsG + safeNum(d?.totals?.carbsG, 0),
        fatG: acc.fatG + safeNum(d?.totals?.fatG, 0),
      }),
      { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 }
    );
  }, [scopedDays]);

  // Presets (merge store + central templates, including Daniel Fast if present)
  const availablePresets = useMemo(() => {
    const base = { ...(templates || {}) };
    if (MEAL_PLAN_TEMPLATES?.danielFast?.nutritionTemplate) {
      base.danielFast = MEAL_PLAN_TEMPLATES.danielFast.nutritionTemplate;
    }
    if (MEAL_PLAN_TEMPLATES?.balanced?.nutritionTemplate && !base.balanced) {
      base.balanced = MEAL_PLAN_TEMPLATES.balanced.nutritionTemplate;
    }
    if (
      MEAL_PLAN_TEMPLATES?.highProtein?.nutritionTemplate &&
      !base.highProtein
    ) {
      base.highProtein = MEAL_PLAN_TEMPLATES.highProtein.nutritionTemplate;
    }
    if (
      MEAL_PLAN_TEMPLATES?.mediterranean?.nutritionTemplate &&
      !base.mediterranean
    ) {
      base.mediterranean = MEAL_PLAN_TEMPLATES.mediterranean.nutritionTemplate;
    }
    if (MEAL_PLAN_TEMPLATES?.vegan?.nutritionTemplate && !base.vegan) {
      base.vegan = MEAL_PLAN_TEMPLATES.vegan.nutritionTemplate;
    }
    return base;
  }, [templates]);

  // Import goals from current plan template (if any)
  useEffect(() => {
    const off = eventBus.on("mealplan.draft.created", ({ draft }) => {
      const t = draft?.meta?.nutritionTemplate;
      if (!t) return;
      toast({
        title: "Template goals available",
        description: `Import nutrition targets from “${
          draft?.meta?.name || "Plan"
        }”?`,
        action: (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              prevGoalsRef.current = goals;
              applyGoals(t);
              toast({
                title: "Imported",
                description: "Goals updated from plan template.",
              });
            }}
          >
            Import
          </Button>
        ),
      });
    });
    return () => off?.();
  }, [goals]);

  const applyGoals = (g) => {
    // live update editor controls to reflect the incoming preset
    setCalTarget(g.calories ?? calTarget);
    if (mode === "grams") {
      setPG(g.protein_g ?? pG);
      setCG(g.carbs_g ?? cG);
      setFG(g.fat_g ?? fG);
    } else {
      const cals = g.calories ?? calTarget;
      const pPctNew = cals
        ? ((g.protein_g || 0) * KCAL_PER_G.protein) / cals
        : pPct;
      const cPctNew = cals
        ? ((g.carbs_g || 0) * KCAL_PER_G.carbs) / cals
        : cPct;
      const fPctNew = cals ? ((g.fat_g || 0) * KCAL_PER_G.fat) / cals : fPct;
      setPPct(clamp01(pPctNew));
      setCPct(clamp01(cPctNew));
      setFPct(clamp01(fPctNew));
    }
  };

  const saveGoals = async () => {
    prevGoalsRef.current = goals;
    try {
      await setGoals?.(targetAsGoals);
      await automation.invoke?.("nutrition.goals.saved", {
        goals: targetAsGoals,
      });
      eventBus.emit("preferences.changed");
      toast({
        title: "Saved",
        description: "Nutrition goals updated.",
        action: (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await setGoals?.(prevGoalsRef.current);
              eventBus.emit("preferences.changed");
              toast({ title: "Reverted" });
            }}
          >
            Undo
          </Button>
        ),
      });
    } catch {
      toast({ title: "Save failed", description: "Could not save goals." });
    }
  };

  const applyPreset = (key) => {
    const p = availablePresets[key];
    if (!p) return;
    prevGoalsRef.current = goals;
    applyGoals(p);
    toast({
      title: "Preset applied",
      description: `Applied ${key === "danielFast" ? "Daniel Fast" : key}.`,
      action: (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            if (prevGoalsRef.current) applyGoals(prevGoalsRef.current);
            toast({ title: "Reverted" });
          }}
        >
          Undo
        </Button>
      ),
    });
  };

  // Suggestion hooks
  const suggestSwaps = () => {
    // compute macro % for the scoped totals to feed MacroRingsGroup + agents
    const totalsForGroup = {
      protein_g: totals.proteinG || 0,
      carbs_g: totals.carbsG || 0,
      fat_g: totals.fatG || 0,
      calories: totals.calories || 0,
    };
    eventBus.emit("nutrition.suggestSwap", {
      scope: { type: scope, days: scopedDays.map((d) => d.date || d.label) },
      targets: targetAsGoals,
      gaps: computeGaps(totalsForGroup, targetAsGoals),
    });
    toast({
      title: "Suggestions queued",
      description: "We’ll look for swaps to better hit your targets.",
    });
  };

  const sabbathTag = sabbathAware ? (
    <Badge variant="secondary">Sabbath-aware</Badge>
  ) : null;

  // ---- UI ----
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Macro Calculator</h1>
          <p className="text-sm text-muted-foreground">
            Tune your macro targets and compare with your current plan. Click
            rings to inspect and trigger nutrition-aligned swaps.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {sabbathTag}
          <Button
            size="sm"
            variant="outline"
            onClick={() => eventBus.emit("ui.open", { id: "NutritionPanel" })}
          >
            Open Full Nutrition
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4">
        {/* LEFT: Targets + Plan Status */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-lg">Targets</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-3">
                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">Mode</Label>
                  <Select value={mode} onValueChange={setMode}>
                    <SelectTrigger className="w-[200px] h-9">
                      <SelectValue placeholder="Mode" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">
                        Percent of Calories
                      </SelectItem>
                      <SelectItem value="grams">Grams</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">
                    Calories / day
                  </Label>
                  <Input
                    className="h-9 w-40"
                    type="number"
                    min={0}
                    value={calTarget}
                    onChange={(e) => setCalTarget(safeNum(e.target.value, 0))}
                    disabled={mode === "grams"}
                  />
                </div>

                <div className="grid gap-1">
                  <Label className="text-xs text-muted-foreground">
                    Apply preset
                  </Label>
                  <Select onValueChange={applyPreset}>
                    <SelectTrigger className="w-[220px] h-9">
                      <SelectValue placeholder="Choose a preset…" />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(availablePresets).map((k) => (
                        <SelectItem key={k} value={k}>
                          {k === "danielFast"
                            ? "Daniel Fast"
                            : k === "highProtein"
                            ? "High-Protein"
                            : k === "balanced"
                            ? "Balanced"
                            : k === "mediterranean"
                            ? "Mediterranean"
                            : k === "vegan"
                            ? "Vegan"
                            : k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="ml-auto">
                  <Button size="sm" onClick={saveGoals}>
                    Save as My Goals
                  </Button>
                </div>
              </div>

              <Separator />

              {mode === "percent" ? (
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <Label className="text-sm">Protein %</Label>
                    <Input
                      className="h-9"
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(pPct * 100)}
                      onChange={(e) =>
                        setPPct(clamp01(Number(e.target.value) / 100))
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-sm">Carbs %</Label>
                    <Input
                      className="h-9"
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(cPct * 100)}
                      onChange={(e) =>
                        setCPct(clamp01(Number(e.target.value) / 100))
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-sm">Fat %</Label>
                    <Input
                      className="h-9"
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(fPct * 100)}
                      onChange={(e) =>
                        setFPct(clamp01(Number(e.target.value) / 100))
                      }
                    />
                  </div>
                </div>
              ) : (
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <Label className="text-sm">Protein (g)</Label>
                    <Input
                      className="h-9"
                      type="number"
                      value={pG}
                      onChange={(e) => setPG(safeNum(e.target.value, 0))}
                    />
                  </div>
                  <div>
                    <Label className="text-sm">Carbs (g)</Label>
                    <Input
                      className="h-9"
                      type="number"
                      value={cG}
                      onChange={(e) => setCG(safeNum(e.target.value, 0))}
                    />
                  </div>
                  <div>
                    <Label className="text-sm">Fat (g)</Label>
                    <Input
                      className="h-9"
                      type="number"
                      value={fG}
                      onChange={(e) => setFG(safeNum(e.target.value, 0))}
                    />
                  </div>
                </div>
              )}

              <div className="rounded-md border p-3 text-sm">
                <div className="grid grid-cols-4 gap-2">
                  <div>
                    Target kcal: <b>{toFixed(targetAsGoals.calories, 0)}</b>
                  </div>
                  <div>
                    Protein: <b>{targetAsGoals.protein_g} g</b>
                  </div>
                  <div>
                    Carbs: <b>{targetAsGoals.carbs_g} g</b>
                  </div>
                  <div>
                    Fat: <b>{targetAsGoals.fat_g} g</b>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Plan Status</CardTitle>
                <div className="flex items-center gap-2">
                  <Label className="text-xs text-muted-foreground">Scope</Label>
                  <Select value={scope} onValueChange={setScope}>
                    <SelectTrigger className="h-8 w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="day">Day</SelectItem>
                      <SelectItem value="week">Week</SelectItem>
                      <SelectItem value="plan">Plan</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {loading ? (
                <div className="grid grid-cols-3 gap-3">
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                </div>
              ) : loadErr ? (
                <div className="text-sm text-rose-600">Error: {loadErr}</div>
              ) : !plan ? (
                <div className="text-sm text-muted-foreground">
                  No current meal plan was found. Choose a template in Meal
                  Planning then return here.
                </div>
              ) : (
                <>
                  <div className="text-sm text-muted-foreground">
                    {normalized.days.length
                      ? `Loaded ${normalized.days.length} day(s) from the current plan.`
                      : `Plan loaded, but it does not include per-day macro data.`}
                  </div>

                  {/* Macro rings vs targets */}
                  <MacroRingsGroup
                    totals={{
                      protein_g: totals.proteinG || 0,
                      carbs_g: totals.carbsG || 0,
                      fat_g: totals.fatG || 0,
                      calories: totals.calories || 0,
                    }}
                    targets={{
                      protein_g: targetAsGoals.protein_g,
                      carbs_g: targetAsGoals.carbs_g,
                      fat_g: targetAsGoals.fat_g,
                      calories: targetAsGoals.calories,
                    }}
                  />

                  {/* Gaps */}
                  <div className="rounded-md border p-3 text-sm">
                    <div className="font-medium mb-1">
                      Gaps vs targets ({scope})
                    </div>
                    <div className="grid grid-cols-4 gap-2">
                      <div>
                        Kcal:{" "}
                        <b>
                          {toFixed(
                            (targetAsGoals.calories || 0) -
                              (totals.calories || 0),
                            0
                          )}
                        </b>
                      </div>
                      <div>
                        Protein:{" "}
                        <b>
                          {toFixed(
                            targetAsGoals.protein_g - (totals.proteinG || 0),
                            0
                          )}{" "}
                          g
                        </b>
                      </div>
                      <div>
                        Carbs:{" "}
                        <b>
                          {toFixed(
                            targetAsGoals.carbs_g - (totals.carbsG || 0),
                            0
                          )}{" "}
                          g
                        </b>
                      </div>
                      <div>
                        Fat:{" "}
                        <b>
                          {toFixed(targetAsGoals.fat_g - (totals.fatG || 0), 0)}{" "}
                          g
                        </b>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button size="sm" onClick={suggestSwaps}>
                        Suggest Swaps
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() =>
                          eventBus.emit("ui.open", { id: "MealPlanEditor" })
                        }
                      >
                        Open Meal Plan
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          automation.invoke?.("export.macrosReport", {
                            scope,
                            totals,
                            targets: targetAsGoals,
                          })
                        }
                      >
                        Export Report
                      </Button>
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {/* Per-day table */}
          {!!normalized.days.length && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-lg">
                  Per-Day Macros vs Targets
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40 text-left">
                        <th className="px-3 py-2">Day</th>
                        <th className="px-3 py-2">Calories</th>
                        <th className="px-3 py-2">Protein</th>
                        <th className="px-3 py-2">Carbs</th>
                        <th className="px-3 py-2">Fat</th>
                        <th className="px-3 py-2">P%</th>
                        <th className="px-3 py-2">C%</th>
                        <th className="px-3 py-2">F%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {normalized.days.map((d, idx) => {
                        const t = d.totals || {};
                        const kc = Number(t.calories) || kcalFromMacros(t);
                        const p = safeNum(t.proteinG, 0);
                        const c = safeNum(t.carbsG, 0);
                        const f = safeNum(t.fatG, 0);
                        const pP = pct(p * KCAL_PER_G.protein, kc);
                        const cP = pct(c * KCAL_PER_G.carbs, kc);
                        const fP = pct(f * KCAL_PER_G.fat, kc);
                        const label =
                          d.label ||
                          (d.date
                            ? dayjs(d.date).format("ddd, MMM D")
                            : `Day ${idx + 1}`);

                        const deltaP = p - (targetAsGoals.protein_g || 0);
                        const deltaC = c - (targetAsGoals.carbs_g || 0);
                        const deltaF = f - (targetAsGoals.fat_g || 0);

                        return (
                          <tr key={idx} className="border-b last:border-0">
                            <td className="px-3 py-2 align-top">{label}</td>
                            <td className="px-3 py-2 align-top">
                              {kc ? toFixed(kc, 0) : "—"}
                              <div className="text-[11px] text-muted-foreground">
                                vs {toFixed(targetAsGoals.calories || 0, 0)}{" "}
                                kcal
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top">
                              {toFixed(p, 0)} g
                              <div
                                className={
                                  deltaP >= 0
                                    ? "text-[11px] text-emerald-600"
                                    : "text-[11px] text-amber-600"
                                }
                              >
                                {deltaP >= 0 ? "+" : ""}
                                {toFixed(deltaP, 0)} g vs target
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top">
                              {toFixed(c, 0)} g
                              <div
                                className={
                                  deltaC >= 0
                                    ? "text-[11px] text-emerald-600"
                                    : "text-[11px] text-amber-600"
                                }
                              >
                                {deltaC >= 0 ? "+" : ""}
                                {toFixed(deltaC, 0)} g vs target
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top">
                              {toFixed(f, 0)} g
                              <div
                                className={
                                  deltaF >= 0
                                    ? "text-[11px] text-emerald-600"
                                    : "text-[11px] text-amber-600"
                                }
                              >
                                {deltaF >= 0 ? "+" : ""}
                                {toFixed(deltaF, 0)} g vs target
                              </div>
                            </td>
                            <td className="px-3 py-2 align-top">
                              {toFixed(pP * 100, 0)}%
                            </td>
                            <td className="px-3 py-2 align-top">
                              {toFixed(cP * 100, 0)}%
                            </td>
                            <td className="px-3 py-2 align-top">
                              {toFixed(fP * 100, 0)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* RIGHT: Actions & Guidance */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Quick Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button size="sm" className="w-full" onClick={suggestSwaps}>
                Suggest Nutrition-Aligned Swaps
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => eventBus.emit("ui.open", { id: "RecipeVault" })}
              >
                Explore Recipes
              </Button>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    automation.invoke?.("export.macrosReport", {
                      scope,
                      totals,
                      targets: targetAsGoals,
                      format: "pdf",
                    })
                  }
                >
                  Export PDF
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    automation.invoke?.("export.macrosReport", {
                      scope,
                      totals,
                      targets: targetAsGoals,
                      format: "csv",
                    })
                  }
                >
                  Export CSV
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    eventBus.emit("export.print", { id: "MacrosPage" })
                  }
                >
                  Print
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Tips</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground space-y-2">
              <p>
                Presets include <b>Balanced</b>, <b>High-Protein</b>,{" "}
                <b>Mediterranean</b>, <b>Vegan</b>, and <b>Daniel Fast</b> when
                that template is active.
              </p>
              <p>
                Saved goals propagate to the <i>Nutrition Peek</i> and inform
                swap suggestions across your plan.
              </p>
              <p>
                Sabbath-aware agents (if enabled) prefer hands-off adjustments.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ---------- Page export ----------
export default function Macros() {
  // Shared wiring layer: canonical store + decoupled events
  const { actions, selectors } = useSharedNutritionStore();
  const active = selectors.getActivePerson();

  useEffect(() => {
    actions.bootstrap();
    const unsubPromise = actions.wireSubscriptions();
    const unsub2Promise = onNutritionEvent(
      NUTRITION_EVENTS.PROFILE_UPDATED,
      () => {}
    );
    return () => {
      void unsubPromise.then((unsub) => unsub && unsub());
      void unsub2Promise.then((unsub) => unsub && unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onChangeActivityLevel(nextLevel) {
    if (!active?.id) return;
    // emits PROFILE_UPDATED + MEALPLAN_PREFERENCES_APPLIED
    await actions.updateActivityLevel(active.id, nextLevel);
    // optionally recompute macros right after change
    await actions.runMacros(active.id);
  }

  async function onRecomputeMacros() {
    if (!active?.id) return;
    await actions.runMacros(active.id);
  }

  return (
    <Suspense
      fallback={
        <div className="p-6 text-sm text-muted-foreground">
          Loading Macro Calculator…
        </div>
      }
    >
      {/* keep your existing Macros UI */}
      {/* call onChangeActivityLevel(level) when user updates activity */}
      {/* call onRecomputeMacros() from your calculate button */}
      <FeatureMacroPage />
    </Suspense>
  );
}

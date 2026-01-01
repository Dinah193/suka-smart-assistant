// src/pages/MealPlanning/MealPlanNutritiionPeek.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";
import { toast } from "@/components/ui/use-toast"; // shadcn/ui toast wrapper (assumed)
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";

// Optional stores (gracefully degrade if not present)
let useMealPlanStore = () => ({ getSelectedScope: () => null, getMealsForScope: () => [] });
let useNutritionStore = () => ({ goals: null, setGoals: () => {}, templates: {}, refresh: async () => {} });
let usePreferencesStore = () => ({ unitSystem: "imperial", dietary: {}, sabbathAware: true });

try { useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore; } catch {}
try { useNutritionStore = require("@/store/NutritionStore").useNutritionStore; } catch {}
try { usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore; } catch {}

/** USDA-ish default daily targets (fallback) */
const USDA_DEFAULTS = Object.freeze({
  calories: 2000,
  protein_g: 50,     // 10–35% kcal; set reasonable midpoint baseline
  carbs_g: 275,      // ~55% of kcal
  fat_g: 70,         // ~31% of kcal
  fiber_g: 28,
  sugar_g: 50,
  sodium_mg: 2300,
  satfat_g: 20,
});

/** Convert grams to kcal by macro */
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };

/** Compute totals + macro split from a list of meals/recipes */
function aggregateNutrition(items = []) {
  const base = {
    calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0,
    fiber_g: 0, sugar_g: 0, sodium_mg: 0, satfat_g: 0,
  };
  for (const it of items) {
    const n = it?.nutrition || {};
    base.calories += n.calories || 0;
    base.protein_g += n.protein_g || 0;
    base.carbs_g += n.carbs_g || 0;
    base.fat_g += n.fat_g || 0;
    base.fiber_g += n.fiber_g || 0;
    base.sugar_g += n.sugar_g || 0;
    base.sodium_mg += n.sodium_mg || 0;
    base.satfat_g += n.satfat_g || 0;
  }
  const kcalProtein = base.protein_g * KCAL_PER_G.protein;
  const kcalCarbs = base.carbs_g * KCAL_PER_G.carbs;
  const kcalFat = base.fat_g * KCAL_PER_G.fat;
  const kcalTotal = Math.max(1, base.calories || (kcalProtein + kcalCarbs + kcalFat));

  const macrosPct = {
    protein: Math.round((kcalProtein / kcalTotal) * 100),
    carbs: Math.round((kcalCarbs / kcalTotal) * 100),
    fat: Math.round((kcalFat / kcalTotal) * 100),
  };

  return { totals: base, macrosPct, kcalBreakdown: { kcalProtein, kcalCarbs, kcalFat, kcalTotal } };
}

/** Merge user goals with defaults. */
function resolveGoals(userGoals, dietary = {}) {
  // You can branch for keto/low-carb/high-protein presets via dietary.profile
  const base = { ...USDA_DEFAULTS, ...(userGoals || {}) };
  if (dietary?.profile === "keto") {
    // Simple example preset; real logic likely lives in NutritionStore templates
    const calories = base.calories;
    const fat = Math.round((0.7 * calories) / KCAL_PER_G.fat);
    const protein = Math.round((0.25 * calories) / KCAL_PER_G.protein);
    const carbs = Math.round((0.05 * calories) / KCAL_PER_G.carbs);
    return { ...base, fat_g: fat, protein_g: protein, carbs_g: carbs };
  }
  return base;
}

/** Little ring chart via SVG arc — single series percentage */
function Ring({ pct = 0, label = "", value = "", title = "" }) {
  const radius = 22;
  const stroke = 6;
  const circumference = 2 * Math.PI * radius;
  const dash = Math.min(100, Math.max(0, pct)) / 100 * circumference;

  return (
    <div className="flex items-center gap-3">
      <svg width="60" height="60" viewBox="0 0 60 60" role="img" aria-label={`${title} ${pct}%`}>
        <circle cx="30" cy="30" r={radius} strokeWidth={stroke} fill="none" className="text-muted/30" stroke="currentColor" opacity={0.2}/>
        <circle
          cx="30" cy="30" r={radius} strokeWidth={stroke} fill="none"
          strokeDasharray={`${dash} ${circumference - dash}`}
          strokeLinecap="round"
          className="text-primary"
          stroke="currentColor"
          transform="rotate(-90 30 30)"
        />
      </svg>
      <div className="leading-tight">
        <div className="text-sm text-muted-foreground">{label}</div>
        <div className="text-lg font-semibold">{value}</div>
        <div className="text-xs text-muted-foreground">{pct}%</div>
      </div>
    </div>
  );
}

/** Compare totals vs goals and produce status chips */
function GoalRow({ name, unit = "", value = 0, goal = 0, preferAtMost = true }) {
  const pct = goal ? Math.round((value / goal) * 100) : 0;
  const within = preferAtMost ? value <= goal : value >= goal; // e.g. fiber is "at least"
  const badgeTone = within ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700";
  const trend = within ? "On track" : (preferAtMost ? "Over" : "Under");
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="text-sm">{name}</div>
      <div className="flex items-center gap-2">
        <span className="text-sm tabular-nums">{Math.round(value)}{unit}</span>
        <span className="text-xs text-muted-foreground">/ {Math.round(goal)}{unit}</span>
        <Badge className={cx("ml-1", badgeTone)}>{trend}</Badge>
        <span className="text-xs text-muted-foreground">{pct}%</span>
      </div>
    </div>
  );
}

/**
 * MealPlanNutritiionPeek
 * Right-rail peek that summarizes nutrition for the current selection:
 * - Scope aware: session/day/plan/week depending on current selection in MealPlanStore
 * - Auto vs Manual sessions tagged
 * - Listens to events: recipe.consolidated, mealplan.updated, inventory.updated, preferences.changed
 * - Undo when switching goal templates
 */
export default function MealPlanNutritiionPeek({ className }) {
  const { getSelectedScope, getMealsForScope, modeLabel } = useMealPlanStore();
  const { goals, setGoals, templates = {}, refresh } = useNutritionStore();
  const { unitSystem, dietary, sabbathAware } = usePreferencesStore();

  const [useCustomGoals, setUseCustomGoals] = useState(Boolean(goals));
  const [activeTemplate, setActiveTemplate] = useState(null);
  const prevGoalsRef = useRef(goals);

  // Grab current selection & meals
  const scope = getSelectedScope ? getSelectedScope() : null; // {type: "session"|"day"|"week"|"plan", id}
  const meals = getMealsForScope ? getMealsForScope(scope) : [];

  // Compute nutrition
  const { totals, macrosPct, kcalBreakdown } = useMemo(() => aggregateNutrition(meals), [meals]);

  // Resolve targets (merge user goals or USDA)
  const targets = useMemo(
    () => resolveGoals(useCustomGoals ? goals : null, dietary),
    [useCustomGoals, goals, dietary]
  );

  // Listen to event updates to auto-refresh
  useEffect(() => {
    const subs = [
      "recipe.consolidated",
      "mealplan.updated",
      "inventory.updated",
      "preferences.changed",
      "calendar.synced",
      "session.generated",
      "session.finalized",
    ].map((evt) => eventBus.on(evt, async () => {
      try { await refresh?.(); } catch {}
    }));

    return () => { subs.forEach((off) => off?.()); };
  }, [refresh]);

  // Sabbath guard tag (non-blocking visual cue)
  const sabbathTag = sabbathAware ? <Badge variant="secondary" className="ml-2">Sabbath-aware</Badge> : null;

  // Apply a goal template with Undo
  const applyTemplate = (key) => {
    const tmpl = templates?.[key];
    if (!tmpl) return;
    const prev = prevGoalsRef.current;
    prevGoalsRef.current = goals;
    setUseCustomGoals(true);
    setGoals?.(tmpl);
    setActiveTemplate(key);
    toast({
      title: "Goals updated",
      description: `Applied ${key} template.`,
      action: (
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setGoals?.(prev);
            setActiveTemplate(null);
            toast({ title: "Reverted", description: "Restored previous goals." });
          }}
        >
          Undo
        </Button>
      ),
    });
  };

  // Export (stubbed) — you likely have a shared export service already
  const exportSummary = async () => {
    try {
      await automation.invoke?.("export.nutritionSummary", { scope, totals, targets, macrosPct });
      toast({ title: "Exported", description: "Nutrition summary exported." });
    } catch (e) {
      toast({ title: "Export failed", description: "Could not export summary." });
    }
  };

  // Empty state
  if (!meals?.length) {
    return (
      <Card className={cx("sticky top-4 p-0", className)}>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2">
            Nutrition Peek
            <Badge variant="outline">Empty</Badge>
            {sabbathTag}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          No meals in the current selection. Add recipes to your session/day to see totals and macro split.
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => eventBus.emit("ui.open", { id: "RecipeVault" })}>Open Recipe Vault</Button>
            <Button size="sm" variant="outline" onClick={() => eventBus.emit("ui.open", { id: "MealPlanEditor" })}>Plan Meals</Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // helpers
  const chip = (text) => <Badge variant="secondary">{text}</Badge>;
  const scopeLabel = (() => {
    if (!scope) return "Selection";
    let base = scope.type ? scope.type.charAt(0).toUpperCase() + scope.type.slice(1) : "Selection";
    if (typeof modeLabel === "function") base += ` • ${modeLabel(scope)}`;
    return base;
  })();

  // A11y labels
  const ariaScope = `${scopeLabel} nutrition overview`;

  return (
    <Card className={cx("sticky top-4", className)} aria-label={ariaScope}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              Nutrition Peek
              {chip(scopeLabel)}
              {sabbathTag}
            </CardTitle>
            <div className="mt-1 text-xs text-muted-foreground">
              Live totals for your current selection. Updates on recipe, plan, or inventory changes.
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">USDA</span>
              <Switch
                checked={useCustomGoals}
                onCheckedChange={(v) => setUseCustomGoals(Boolean(v))}
                aria-label="Toggle custom goals"
              />
              <span className="text-xs text-muted-foreground">Custom</span>
            </div>
            <Button size="sm" variant="outline" onClick={exportSummary}>Export</Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Macro rings */}
        <div className="grid grid-cols-3 gap-3">
          <Ring title="Protein share" pct={macrosPct.protein} label="Protein" value={`${Math.round(totals.protein_g)} g`} />
          <Ring title="Carb share" pct={macrosPct.carbs} label="Carbs" value={`${Math.round(totals.carbs_g)} g`} />
          <Ring title="Fat share" pct={macrosPct.fat} label="Fat" value={`${Math.round(totals.fat_g)} g`} />
        </div>

        <div className="flex items-center justify-between">
          <div className="text-sm">
            <div className="font-medium">Calories</div>
            <div className="text-muted-foreground text-xs">Total from meals in selection</div>
          </div>
          <div className="text-right">
            <div className="text-xl font-semibold tabular-nums">{Math.round(totals.calories || kcalBreakdown.kcalTotal)} kcal</div>
            <div className="text-xs text-muted-foreground">
              P:{Math.round(kcalBreakdown.kcalProtein)} C:{Math.round(kcalBreakdown.kcalCarbs)} F:{Math.round(kcalBreakdown.kcalFat)}
            </div>
          </div>
        </div>

        <Separator />

        {/* Goals comparison */}
        <div>
          <div className="flex items-center justify-between">
            <div className="font-medium">Daily Targets</div>
            <div className="flex items-center gap-2">
              {activeTemplate ? <Badge>Template: {activeTemplate}</Badge> : null}
              {/* Quick templates if available */}
              {templates?.balanced && (
                <Button size="xs" variant="secondary" onClick={() => applyTemplate("balanced")}>Balanced</Button>
              )}
              {templates?.keto && (
                <Button size="xs" variant="secondary" onClick={() => applyTemplate("keto")}>Keto</Button>
              )}
              {templates?.highProtein && (
                <Button size="xs" variant="secondary" onClick={() => applyTemplate("highProtein")}>High-Protein</Button>
              )}
            </div>
          </div>

          <div className="mt-2 space-y-1.5">
            <GoalRow name="Calories" unit=" kcal" value={totals.calories || kcalBreakdown.kcalTotal} goal={targets.calories} />
            <GoalRow name="Protein" unit=" g" value={totals.protein_g} goal={targets.protein_g} preferAtMost={false} />
            <GoalRow name="Carbs" unit=" g" value={totals.carbs_g} goal={targets.carbs_g} />
            <GoalRow name="Fat" unit=" g" value={totals.fat_g} goal={targets.fat_g} />
            <GoalRow name="Fiber" unit=" g" value={totals.fiber_g} goal={targets.fiber_g} preferAtMost={false} />
            <GoalRow name="Sugar" unit=" g" value={totals.sugar_g} goal={targets.sugar_g} />
            <GoalRow name="Sodium" unit=" mg" value={totals.sodium_mg} goal={targets.sodium_mg} />
            <GoalRow name="Sat. Fat" unit=" g" value={totals.satfat_g} goal={targets.satfat_g} />
          </div>
        </div>

        <Separator />

        {/* Actions / Next Best Action */}
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">
            Next best action is based on goal gaps. We’ll suggest tweaks from your Recipe Vault.
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => eventBus.emit("nutrition.suggestSwap", { scope, gaps: computeGaps(totals, targets) })}
            >
              Suggest Swaps
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => eventBus.emit("ui.open", { id: "NutritionPanel" })}
            >
              Open Full Nutrition
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => eventBus.emit("ui.open", { id: "MealPlanEditor" })}
            >
              Edit Plan
            </Button>
          </div>
        </div>

        {/* Footnotes */}
        <div className="pt-1 text-[11px] leading-snug text-muted-foreground">
          * Macros are shown as a percentage of total kcal for the current selection (session/day/week/plan).
          Targets default to USDA-like baselines unless custom goals or templates are applied.
        </div>
      </CardContent>
    </Card>
  );
}

/** Compute gaps to drive “Next Best Action” */
function computeGaps(totals, targets) {
  const gap = (k) => (targets[k] ?? 0) - (totals[k] ?? 0);
  return {
    calories: gap("calories"),
    protein_g: gap("protein_g"),
    carbs_g: gap("carbs_g"),
    fat_g: gap("fat_g"),
    fiber_g: gap("fiber_g"),
    sugar_g: gap("sugar_g"),
    sodium_mg: gap("sodium_mg"),
    satfat_g: gap("satfat_g"),
  };
}

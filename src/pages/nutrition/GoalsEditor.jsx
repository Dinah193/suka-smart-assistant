// src/pages/nutrition/GoalsEditor.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

// Soft deps (graceful fallbacks)
let eventBus = { emit: () => {}, on: () => () => {} };
let automation = { invoke: async () => {} };
let useNutritionStore = () => ({
  goals: null,
  setGoals: () => {},
  templates: {
    balanced: { calories: 2000, protein_g: 100, carbs_g: 250, fat_g: 67, fiber_g: 30, sugar_g: 50, sodium_mg: 2000, satfat_g: 18 },
    highProtein: { calories: 2100, protein_g: 150, carbs_g: 200, fat_g: 70, fiber_g: 30, sugar_g: 45, sodium_mg: 2000, satfat_g: 18 },
    keto: null, // computed below
    vegan: { calories: 2000, protein_g: 85, carbs_g: 300, fat_g: 60, fiber_g: 35, sugar_g: 60, sodium_mg: 1900, satfat_g: 14 },
    danielFast: { calories: 2000, protein_g: 75, carbs_g: 300, fat_g: 45, fiber_g: 35, sugar_g: 60, sodium_mg: 1800, satfat_g: 12 },
  },
  refresh: async () => {},
});
let usePreferencesStore = () => ({ sabbathAware: true, unitSystem: "imperial" });
let useMealPlanStore = () => ({ getActiveDraft: () => null });

try { eventBus = require("@/services/events/eventBus").eventBus; } catch {}
try { automation = require("@/services/automation/runtime").automation; } catch {}
try { useNutritionStore = require("@/store/NutritionStore").useNutritionStore; } catch {}
try { usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore; } catch {}
try { useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore; } catch {}

// Optional central registry (if present) to stay consistent with Meal templates
let MEAL_PLAN_TEMPLATES;
try { MEAL_PLAN_TEMPLATES = require("@/services/mealplanning/MealPlanTemplates").MEAL_PLAN_TEMPLATES; } catch {}

// UI (shadcn style)
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Slider } from "@/components/ui/slider";
import { toast } from "@/components/ui/use-toast";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

const USDA_DEFAULTS = Object.freeze({
  calories: 2000,
  protein_g: 50,   // baseline; users often raise
  carbs_g: 275,
  fat_g: 70,
  fiber_g: 28,
  sugar_g: 50,
  sodium_mg: 2300,
  satfat_g: 20,
});

const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };
const clampNum = (v, min, max) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : 0));
const cx = (...a) => a.filter(Boolean).join(" ");

function pctSplitFromGoals(g) {
  const kP = (g.protein_g || 0) * KCAL_PER_G.protein;
  const kC = (g.carbs_g || 0) * KCAL_PER_G.carbs;
  const kF = (g.fat_g || 0) * KCAL_PER_G.fat;
  const total = Math.max(1, g.calories || (kP + kC + kF));
  return {
    protein: Math.round((kP / total) * 100),
    carbs: Math.round((kC / total) * 100),
    fat: Math.round((kF / total) * 100),
    total,
  };
}
function gramsFromPct(calories, pPct, cPct, fPct) {
  const kP = (pPct / 100) * calories;
  const kC = (cPct / 100) * calories;
  const kF = (fPct / 100) * calories;
  return {
    protein_g: Math.round(kP / KCAL_PER_G.protein),
    carbs_g: Math.round(kC / KCAL_PER_G.carbs),
    fat_g: Math.round(kF / KCAL_PER_G.fat),
  };
}

export default function GoalsEditor({ className }) {
  const { goals, setGoals, templates, refresh } = useNutritionStore();
  const { sabbathAware } = usePreferencesStore();
  const { getActiveDraft } = useMealPlanStore();

  const [useCustom, setUseCustom] = useState(Boolean(goals));
  const [local, setLocal] = useState(() => ({ ...(goals || USDA_DEFAULTS) }));
  const [linkMacros, setLinkMacros] = useState(true); // slider ↔ grams
  const [preset, setPreset] = useState(""); // active preset label
  const [activeTab, setActiveTab] = useState("macros");

  const prevRef = useRef(goals || USDA_DEFAULTS);

  // Build a merged preset list (NutritionStore + MealPlanTemplates meta)
  const availablePresets = useMemo(() => {
    const base = { ...(templates || {}) };
    if (MEAL_PLAN_TEMPLATES?.danielFast?.nutritionTemplate) {
      base.danielFast = MEAL_PLAN_TEMPLATES.danielFast.nutritionTemplate;
    }
    if (!base.keto) {
      // simple keto heuristic from calories if missing
      const cal = (goals?.calories || local.calories || 2000);
      base.keto = gramsFromPct(cal, 25, 5, 70); // default 25/5/70
      base.keto.calories = cal;
      base.keto.fiber_g = 30; base.keto.sugar_g = 35; base.keto.sodium_mg = 2000; base.keto.satfat_g = 18;
    }
    return base;
  }, [templates, local.calories, goals]);

  // Keep USDA if toggled off custom
  useEffect(() => {
    if (!useCustom) setLocal({ ...USDA_DEFAULTS });
  }, [useCustom]);

  // Listen for plan/template changes and offer import
  useEffect(() => {
    const off = eventBus.on("mealplan.draft.created", ({ draft }) => {
      const t = draft?.meta?.nutritionTemplate;
      if (t) {
        toast({
          title: "Template goals available",
          description: `Import nutrition targets from “${draft?.meta?.name || "Plan"}”?`,
          action: (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                prevRef.current = local;
                setUseCustom(true);
                setLocal((cur) => ({ ...cur, ...t }));
                setPreset(draft?.templateId || draft?.meta?.templateId || "template");
                toast({ title: "Imported", description: "Goals updated from plan template." });
              }}
            >
              Import
            </Button>
          ),
        });
      }
    });
    return () => off?.();
  }, [local]);

  // Recompute grams if calories or percentages change while linked
  const split = useMemo(() => pctSplitFromGoals(local), [local]);

  const setCal = (v) => {
    const calories = clampNum(v, 1000, 4500);
    if (linkMacros) {
      // keep same macro percentages, recompute grams
      const { protein_g, carbs_g, fat_g } = gramsFromPct(calories, split.protein, split.carbs, split.fat);
      setLocal((g) => ({ ...g, calories, protein_g, carbs_g, fat_g }));
    } else {
      setLocal((g) => ({ ...g, calories }));
    }
  };

  const setPct = (key, pct) => {
    // keep sum to ~100 by normalizing remaining two
    let p = split.protein, c = split.carbs, f = split.fat;
    if (key === "protein") p = pct;
    if (key === "carbs") c = pct;
    if (key === "fat") f = pct;
    const sum = Math.max(1, p + c + f);
    const np = Math.round((p / sum) * 100);
    const nc = Math.round((c / sum) * 100);
    const nf = 100 - np - nc;
    const grams = gramsFromPct(local.calories, np, nc, nf);
    setLocal((g) => ({ ...g, ...grams }));
  };

  const setGram = (key, grams) => {
    const value = clampNum(grams, 0, 999);
    setLocal((g) => ({ ...g, [key]: value }));
  };

  const applyPreset = (name) => {
    const p = availablePresets[name];
    if (!p) return;
    prevRef.current = local;
    setUseCustom(true);
    // allow partial presets (we merge to keep user’s other micronutrients if any)
    const merged = { ...local, ...p };
    setLocal(merged);
    setPreset(name);
    toast({
      title: "Goals updated",
      description: `Applied ${name} preset.`,
      action: (
        <Button size="sm" variant="outline" onClick={() => { setLocal(prevRef.current); setPreset(""); toast({ title: "Reverted" }); }}>
          Undo
        </Button>
      ),
    });
  };

  const resetUSDA = () => {
    prevRef.current = local;
    setUseCustom(false);
    setLocal({ ...USDA_DEFAULTS });
    setPreset("");
    toast({
      title: "Reset",
      description: "Reverted to USDA-style defaults.",
      action: <Button size="sm" variant="outline" onClick={() => { setUseCustom(true); setLocal(prevRef.current); toast({ title: "Reverted" }); }}>Undo</Button>,
    });
  };

  const save = async () => {
    prevRef.current = goals || USDA_DEFAULTS;
    try {
      await setGoals?.(local);
      await automation.invoke?.("nutrition.goals.saved", { goals: local });
      eventBus.emit("preferences.changed");
      toast({
        title: "Saved",
        description: "Nutrition goals updated.",
        action: <Button size="sm" variant="outline" onClick={() => { setGoals?.(prevRef.current); eventBus.emit("preferences.changed"); toast({ title: "Reverted" }); }}>Undo</Button>,
      });
    } catch {
      toast({ title: "Save failed", description: "Could not save goals." });
    }
  };

  const importFromActivePlan = () => {
    const draft = getActiveDraft?.();
    const t = draft?.meta?.nutritionTemplate;
    if (!t) {
      toast({ title: "No template on plan", description: "Open a plan template to import its goals." });
      return;
    }
    prevRef.current = local;
    setUseCustom(true);
    setLocal((cur) => ({ ...cur, ...t }));
    setPreset(draft?.templateId || draft?.meta?.templateId || "template");
    toast({ title: "Imported from plan" });
  };

  // UI bits
  const sabbathTag = sabbathAware ? <Badge variant="secondary">Sabbath-aware</Badge> : null;

  const PctSlider = ({ label, value, onChange, aria }) => (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm">{label}</span>
        <span className="text-sm tabular-nums">{value}%</span>
      </div>
      <Slider value={[value]} onValueChange={([v]) => onChange(v)} step={1} min={0} max={90} aria-label={aria}/>
    </div>
  );

  const NumberRow = ({ id, label, suffix = "", value, onChange, min = 0, max = 9999 }) => (
    <div className="grid grid-cols-[140px_1fr] items-center gap-3">
      <Label htmlFor={id} className="text-sm text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={id} inputMode="numeric" value={value} onChange={(e) => onChange(Number(e.target.value || 0))}
               className="h-9 w-32 tabular-nums" />
        <span className="text-xs text-muted-foreground">{suffix}</span>
      </div>
    </div>
  );

  return (
    <div className={className}>
      <Card className="sticky top-0 z-10">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                Nutrition Goals
                {useCustom ? <Badge>Custom</Badge> : <Badge variant="outline">USDA</Badge>}
                {preset ? <Badge variant="outline">Preset: {preset}</Badge> : null}
                {sabbathTag}
              </CardTitle>
              <div className="text-xs text-muted-foreground mt-1">
                Set daily targets; link macros to adjust by percentages, or edit grams directly. You can import from a plan template (e.g., Daniel Fast).
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">USDA</span>
                <Switch checked={useCustom} onCheckedChange={(v) => setUseCustom(!!v)} aria-label="Toggle custom goals"/>
                <span className="text-xs text-muted-foreground">Custom</span>
              </div>
              <Button size="sm" onClick={save}>Save</Button>
              <Button size="sm" variant="outline" onClick={resetUSDA}>Reset</Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <Card className="mt-3">
        <CardContent className="space-y-4">
          {/* Presets */}
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label className="text-xs text-muted-foreground">Apply Preset</Label>
              <div className="flex gap-2">
                <Select onValueChange={applyPreset}>
                  <SelectTrigger className="h-9 w-56">
                    <SelectValue placeholder="Choose a preset…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(availablePresets).map((k) => (
                      <SelectItem key={k} value={k}>
                        {k === "danielFast" ? "Daniel Fast" :
                         k === "highProtein" ? "High-Protein" :
                         k === "balanced" ? "Balanced" :
                         k === "mediterranean" ? "Mediterranean" :
                         k === "vegan" ? "Vegan" :
                         k === "keto" ? "Keto" : k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={importFromActivePlan}>Import From Plan</Button>
              </div>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Link Macro %</Label>
              <Switch checked={linkMacros} onCheckedChange={(v) => setLinkMacros(!!v)} />
            </div>
          </div>

          <Separator />

          {/* Calories + Macro % / grams */}
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="macros">Macros</TabsTrigger>
              <TabsTrigger value="limits">Limits</TabsTrigger>
            </TabsList>

            <TabsContent value="macros" className="mt-4 space-y-5">
              {/* Calories */}
              <NumberRow
                id="calories"
                label="Calories"
                suffix="kcal"
                value={local.calories ?? 2000}
                onChange={setCal}
              />

              {/* Macro split */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {/* By Percentage */}
                <div className="rounded-lg border p-3">
                  <div className="mb-2 text-sm font-medium">Macro Percentages</div>
                  <div className="space-y-4">
                    <PctSlider label={`Protein (${local.protein_g ?? 0} g)`} value={pctSplitFromGoals(local).protein} onChange={(v) => setPct("protein", v)} aria="Protein percentage"/>
                    <PctSlider label={`Carbs (${local.carbs_g ?? 0} g)`} value={pctSplitFromGoals(local).carbs} onChange={(v) => setPct("carbs", v)} aria="Carbohydrates percentage"/>
                    <PctSlider label={`Fat (${local.fat_g ?? 0} g)`} value={pctSplitFromGoals(local).fat} onChange={(v) => setPct("fat", v)} aria="Fat percentage"/>
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    Sum normalizes to 100%. Grams auto-recalculate from calories.
                  </div>
                </div>

                {/* By Grams */}
                <div className="rounded-lg border p-3">
                  <div className="mb-2 text-sm font-medium">Macro Grams</div>
                  <div className="space-y-3">
                    <NumberRow id="protein" label="Protein" suffix="g" value={local.protein_g ?? 0} onChange={(v) => setGram("protein_g", v)} />
                    <NumberRow id="carbs" label="Carbs" suffix="g" value={local.carbs_g ?? 0} onChange={(v) => setGram("carbs_g", v)} />
                    <NumberRow id="fat" label="Fat" suffix="g" value={local.fat_g ?? 0} onChange={(v) => setGram("fat_g", v)} />
                  </div>
                  <div className="mt-3 text-xs text-muted-foreground">
                    Current % • P:{split.protein}% C:{split.carbs}% F:{split.fat}%
                  </div>
                </div>
              </div>
            </TabsContent>

            {/* Limits and fiber */}
            <TabsContent value="limits" className="mt-4 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <NumberRow id="fiber" label="Fiber (≥)" suffix="g" value={local.fiber_g ?? 0} onChange={(v) => setLocal((g) => ({ ...g, fiber_g: clampNum(v, 0, 200) }))} />
                <NumberRow id="sugar" label="Sugar (≤)" suffix="g" value={local.sugar_g ?? 0} onChange={(v) => setLocal((g) => ({ ...g, sugar_g: clampNum(v, 0, 300) }))} />
                <NumberRow id="sodium" label="Sodium (≤)" suffix="mg" value={local.sodium_mg ?? 0} onChange={(v) => setLocal((g) => ({ ...g, sodium_mg: clampNum(v, 0, 6000) }))} />
                <NumberRow id="satfat" label="Saturated Fat (≤)" suffix="g" value={local.satfat_g ?? 0} onChange={(v) => setLocal((g) => ({ ...g, satfat_g: clampNum(v, 0, 200) }))} />
              </div>
            </TabsContent>
          </Tabs>

          <Separator />

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={save}>Save Goals</Button>
            <Button size="sm" variant="outline" onClick={() => eventBus.emit("ui.open", { id: "NutritionPanel" })}>
              Open Full Nutrition
            </Button>
            <Button size="sm" variant="ghost" onClick={() => eventBus.emit("ui.open", { id: "RecipeVault" })}>
              Recipe Vault
            </Button>
            <div className="ml-auto text-xs text-muted-foreground">
              Changes propagate to Nutrition Peek and suggestions.
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

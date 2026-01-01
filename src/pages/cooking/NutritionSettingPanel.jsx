// src/pages/cooking/NutritionSettingPanel.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ---------------- Soft deps (graceful fallbacks) ---------------- */
let automation = { invoke: async () => {} };
let eventBus = { emit: () => {}, on: () => () => {} };
let emitEvent = (..._) => {};
try { automation = require("@/services/automation/runtime").automation; } catch {}
try { eventBus = require("@/services/events/eventBus").eventBus; } catch {}
try { emitEvent = require("@/contracts/events").emitEvent; } catch {}

let useNutritionStore = () => ({
  goals: null,            // { calories, protein_g, carbs_g, fat_g, ... }
  setGoals: async () => {},
  constraints: {          // dietary filters for cooking/planning
    includeTags: [], excludeTags: [], denyIngredients: [], allowIngredients: [], cookingMethodsPrefer: []
  },
  setConstraints: async () => {},
  refresh: async () => {},
  templates: {
    balanced: { calories: 2000, protein_g: 100, carbs_g: 250, fat_g: 67, fiber_g: 30, sugar_g: 50, sodium_mg: 2000, satfat_g: 18 },
    highProtein: { calories: 2100, protein_g: 150, carbs_g: 200, fat_g: 70, fiber_g: 30, sugar_g: 45, sodium_mg: 2000, satfat_g: 18 },
    vegan: { calories: 2000, protein_g: 85, carbs_g: 300, fat_g: 60, fiber_g: 35, sugar_g: 60, sodium_mg: 1900, satfat_g: 14 },
  },
});
let usePreferencesStore = () => ({ sabbathAware: true, unitSystem: "imperial" });
let useMealPlanStore = () => ({ getActiveDraft: () => null });
let useCookingSessionStore = () => ({
  getActiveSession: () => null,                 // current cooking session
  setSessionNutritionOverrides: async () => {}, // write per-session overrides
  clearSessionNutritionOverrides: async () => {},
});
try { useNutritionStore = require("@/store/NutritionStore").useNutritionStore; } catch {}
try { usePreferencesStore = require("@/store/PreferencesStore").usePreferencesStore; } catch {}
try { useMealPlanStore = require("@/store/MealPlanStore").useMealPlanStore; } catch {}
try { useCookingSessionStore = require("@/store/CookingSessionStore").useCookingSessionStore; } catch {}

// Optional central registry to stay in sync with Meal templates (Daniel Fast, etc.)
let MEAL_PLAN_TEMPLATES;
try { MEAL_PLAN_TEMPLATES = require("@/services/mealplanning/MealPlanTemplates").MEAL_PLAN_TEMPLATES; } catch {}

// Macro rings
let MacroRingsGroup = () => null;
try { MacroRingsGroup = require("@/pages/nutrition/MacroRing.jsx").MacroRingsGroup; } catch {}

/* ---------------- UI (shadcn) ---------------- */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "@/components/ui/use-toast";
import { Checkbox } from "@/components/ui/checkbox";

/* ---------------- Utils ---------------- */
const KCAL_PER_G = { protein: 4, carbs: 4, fat: 9 };
const toFixed = (n, d = 0) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/* USDA-ish baseline for reset */
const USDA_DEFAULTS = Object.freeze({
  calories: 2000, protein_g: 50, carbs_g: 275, fat_g: 70, fiber_g: 28, sugar_g: 50, sodium_mg: 2300, satfat_g: 20,
});

/* ---------------- Component ---------------- */
export default function NutritionSettingPanel({ className }) {
  const { goals, setGoals, constraints, setConstraints, templates, refresh } = useNutritionStore();
  const { sabbathAware } = usePreferencesStore();
  const { getActiveDraft } = useMealPlanStore();
  const { getActiveSession, setSessionNutritionOverrides, clearSessionNutritionOverrides } = useCookingSessionStore();

  const session = getActiveSession?.() || null;

  // local state (goals)
  const [local, setLocal] = useState(() => ({ ...(goals || USDA_DEFAULTS) }));
  const [mode, setMode] = useState("grams"); // 'grams' | 'percent'
  const [calories, setCalories] = useState(local.calories || 2000);
  const [pG, setPG] = useState(local.protein_g ?? 100);
  const [cG, setCG] = useState(local.carbs_g ?? 250);
  const [fG, setFG] = useState(local.fat_g ?? 67);
  const [pPct, setPPct] = useState(30);
  const [cPct, setCPct] = useState(40);
  const [fPct, setFPct] = useState(30);

  // local state (constraints)
  const [incl, setIncl] = useState(constraints?.includeTags || []);
  const [excl, setExcl] = useState(constraints?.excludeTags || []);
  const [deny, setDeny] = useState(constraints?.denyIngredients || []);
  const [allow, setAllow] = useState(constraints?.allowIngredients || []);
  const [methods, setMethods] = useState(constraints?.cookingMethodsPrefer || []);
  const [notes, setNotes] = useState("");

  const prevGoalsRef = useRef(goals || USDA_DEFAULTS);
  const prevConstraintsRef = useRef(constraints);

  // compute goals from percent mode
  const targetFromPct = useMemo(() => {
    const sum = Math.max(1, pPct + cPct + fPct);
    const nP = (pPct / sum) * calories;
    const nC = (cPct / sum) * calories;
    const nF = (fPct / sum) * calories;
    return {
      calories,
      protein_g: Math.round(nP / KCAL_PER_G.protein),
      carbs_g: Math.round(nC / KCAL_PER_G.carbs),
      fat_g: Math.round(nF / KCAL_PER_G.fat),
    };
  }, [pPct, cPct, fPct, calories]);

  const targets = mode === "percent"
    ? targetFromPct
    : { calories: Math.round((pG * 4 + cG * 4 + fG * 9)), protein_g: pG, carbs_g: cG, fat_g: fG };

  // ring totals (we only show targets here; live totals come from Cooking session’s selections elsewhere)
  const totalsForRings = useMemo(() => ({
    protein_g: 0, carbs_g: 0, fat_g: 0, calories: 0,
  }), []);

  // merged templates (include Daniel Fast & friends)
  const availablePresets = useMemo(() => {
    const base = { ...(templates || {}) };
    if (MEAL_PLAN_TEMPLATES?.danielFast?.nutritionTemplate) base.danielFast = MEAL_PLAN_TEMPLATES.danielFast.nutritionTemplate;
    if (MEAL_PLAN_TEMPLATES?.balanced?.nutritionTemplate && !base.balanced) base.balanced = MEAL_PLAN_TEMPLATES.balanced.nutritionTemplate;
    if (MEAL_PLAN_TEMPLATES?.mediterranean?.nutritionTemplate && !base.mediterranean) base.mediterranean = MEAL_PLAN_TEMPLATES.mediterranean.nutritionTemplate;
    if (MEAL_PLAN_TEMPLATES?.highProtein?.nutritionTemplate && !base.highProtein) base.highProtein = MEAL_PLAN_TEMPLATES.highProtein.nutritionTemplate;
    if (MEAL_PLAN_TEMPLATES?.vegan?.nutritionTemplate && !base.vegan) base.vegan = MEAL_PLAN_TEMPLATES.vegan.nutritionTemplate;
    return base;
  }, [templates]);

  // listen to plan template creation (offer import)
  useEffect(() => {
    const off = eventBus.on?.("mealplan.draft.generated", ({ draft }) => {
      const t = draft?.meta?.nutritionTemplate;
      if (!t) return;
      toast({
        title: "Plan template detected",
        description: "Import its nutrition targets here?",
        action: (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              prevGoalsRef.current = { ...(goals || USDA_DEFAULTS) };
              applyGoals(t);
              toast({ title: "Imported from plan template" });
            }}
          >
            Import
          </Button>
        ),
      });
    });
    return () => off?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals]);

  function applyGoals(g) {
    setLocal((cur) => ({ ...cur, ...g }));
    setCalories(g.calories ?? calories);
    setPG(g.protein_g ?? pG);
    setCG(g.carbs_g ?? cG);
    setFG(g.fat_g ?? fG);
    if (g.calories) {
      const cals = g.calories;
      const p = g.protein_g || 0, c = g.carbs_g || 0, f = g.fat_g || 0;
      const pPctNew = c ? ((p * KCAL_PER_G.protein) / cals) * 100 : 30;
      const cPctNew = ((c * KCAL_PER_G.carbs) / cals) * 100;
      const fPctNew = ((f * KCAL_PER_G.fat) / cals) * 100;
      setPPct(clamp(Math.round(pPctNew), 0, 90));
      setCPct(clamp(Math.round(cPctNew), 0, 90));
      setFPct(clamp(Math.round(fPctNew), 0, 90));
    }
  }

  const saveAsDefaults = async () => {
    prevGoalsRef.current = goals || USDA_DEFAULTS;
    try {
      await setGoals?.(targets);
      emitEvent?.("preferences.changed", { keys: ["nutrition.goals"] });
      toast({
        title: "Saved",
        description: "Default nutrition goals updated.",
        action: (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await setGoals?.(prevGoalsRef.current);
              emitEvent?.("preferences.changed", { keys: ["nutrition.goals"] });
              toast({ title: "Reverted" });
            }}
          >
            Undo
          </Button>
        ),
      });
    } catch {
      toast({ title: "Save failed", description: "Could not save your defaults." });
    }
  };

  const applyToSession = async () => {
    try {
      await setSessionNutritionOverrides?.(session?.id, targets, {
        includeTags: incl, excludeTags: excl, denyIngredients: deny, allowIngredients: allow, cookingMethodsPrefer: methods,
      });
      toast({
        title: "Applied to session",
        description: "Cooking session will use these targets & filters.",
        action: (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await clearSessionNutritionOverrides?.(session?.id);
              toast({ title: "Session overrides cleared" });
            }}
          >
            Undo
          </Button>
        ),
      });
    } catch {
      toast({ title: "Apply failed", description: "Could not apply to the session." });
    }
  };

  const applyPreset = (name) => {
    const p = availablePresets[name];
    if (!p) return;
    const prev = { ...local, calories, protein_g: pG, carbs_g: cG, fat_g: fG };
    applyGoals(p);
    toast({
      title: "Preset applied",
      description: name === "danielFast" ? "Daniel Fast" : name,
      action: (
        <Button size="sm" variant="outline" onClick={() => { applyGoals(prev); toast({ title: "Reverted" }); }}>
          Undo
        </Button>
      ),
    });
  };

  const saveConstraints = async () => {
    prevConstraintsRef.current = constraints;
    try {
      await setConstraints?.({
        includeTags: incl, excludeTags: excl, denyIngredients: deny, allowIngredients: allow, cookingMethodsPrefer: methods,
      });
      emitEvent?.("preferences.changed", { keys: ["nutrition.constraints"] });
      toast({
        title: "Filters saved",
        description: "Dietary filters updated.",
        action: (
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              await setConstraints?.(prevConstraintsRef.current);
              emitEvent?.("preferences.changed", { keys: ["nutrition.constraints"] });
              toast({ title: "Reverted" });
            }}
          >
            Undo
          </Button>
        ),
      });
    } catch {
      toast({ title: "Save failed", description: "Could not save filters." });
    }
  };

  const importFromPlan = () => {
    const draft = getActiveDraft?.();
    const t = draft?.meta?.nutritionTemplate;
    if (!t) {
      toast({ title: "No template attached", description: "Open a plan template to import its targets here." });
      return;
    }
    applyGoals(t);
    toast({ title: "Imported from plan" });
  };

  const resetUSDA = () => {
    const prev = { ...local, calories, protein_g: pG, carbs_g: cG, fat_g: fG };
    applyGoals(USDA_DEFAULTS);
    toast({
      title: "Reset",
      description: "Reverted to USDA-style defaults.",
      action: <Button size="sm" variant="outline" onClick={() => { applyGoals(prev); toast({ title: "Reverted" }); }}>Undo</Button>,
    });
  };

  const sabbathTag = sabbathAware ? <Badge variant="secondary">Sabbath-aware</Badge> : null;

  /* ---------------- Render ---------------- */
  return (
    <div className={className}>
      <Card className="sticky top-0 z-10">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="flex items-center gap-2">
                Nutrition Settings
                {session?.id ? <Badge variant="outline">Session</Badge> : <Badge variant="outline">Global</Badge>}
                {sabbathTag}
              </CardTitle>
              <div className="text-xs text-muted-foreground mt-1">
                Set macro targets & diet filters to guide cooking suggestions, swaps, and timers.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => eventBus.emit("ui.open", { id: "GoalsEditor" })}>
                Open Goals Editor
              </Button>
              <Button size="sm" onClick={saveAsDefaults}>Save Defaults</Button>
            </div>
          </div>
        </CardHeader>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-4 mt-3">
        {/* LEFT: Goals */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Targets</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Mode</Label>
                <Select value={mode} onValueChange={setMode}>
                  <SelectTrigger className="h-9 w-[200px]">
                    <SelectValue placeholder="Mode" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="grams">Grams</SelectItem>
                    <SelectItem value="percent">Percent of Calories</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Apply Preset</Label>
                <Select onValueChange={applyPreset}>
                  <SelectTrigger className="h-9 w-[220px]">
                    <SelectValue placeholder="Choose a preset…" />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.keys(availablePresets).map((k) => (
                      <SelectItem key={k} value={k}>
                        {k === "danielFast" ? "Daniel Fast" :
                         k === "highProtein" ? "High-Protein" :
                         k === "balanced" ? "Balanced" :
                         k === "mediterranean" ? "Mediterranean" :
                         k === "vegan" ? "Vegan" : k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1">
                <Label className="text-xs text-muted-foreground">Import</Label>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={importFromPlan}>From Plan</Button>
                  <Button size="sm" variant="ghost" onClick={resetUSDA}>Reset USDA</Button>
                </div>
              </div>

              <div className="ml-auto">
                <Button size="sm" onClick={applyToSession} disabled={!session?.id}>
                  Apply to Session
                </Button>
              </div>
            </div>

            <Separator />

            {mode === "grams" ? (
              <div className="grid gap-3 md:grid-cols-4">
                <div>
                  <Label className="text-sm">Protein (g)</Label>
                  <Input className="h-9" type="number" value={pG} onChange={(e) => setPG(clamp(safeNum(e.target.value, 0), 0, 999))} />
                </div>
                <div>
                  <Label className="text-sm">Carbs (g)</Label>
                  <Input className="h-9" type="number" value={cG} onChange={(e) => setCG(clamp(safeNum(e.target.value, 0), 0, 999))} />
                </div>
                <div>
                  <Label className="text-sm">Fat (g)</Label>
                  <Input className="h-9" type="number" value={fG} onChange={(e) => setFG(clamp(safeNum(e.target.value, 0), 0, 999))} />
                </div>
                <div>
                  <Label className="text-sm">Target kcal</Label>
                  <Input
                    className="h-9"
                    type="number"
                    value={pG * 4 + cG * 4 + fG * 9}
                    readOnly
                  />
                </div>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-4">
                <div>
                  <Label className="text-sm">Calories/day</Label>
                  <Input className="h-9" type="number" value={calories} onChange={(e) => setCalories(clamp(safeNum(e.target.value, 0), 0, 6000))} />
                </div>
                <div>
                  <Label className="text-sm">Protein %</Label>
                  <Input className="h-9" type="number" value={pPct} onChange={(e) => setPPct(clamp(safeNum(e.target.value, 0), 0, 90))} />
                </div>
                <div>
                  <Label className="text-sm">Carbs %</Label>
                  <Input className="h-9" type="number" value={cPct} onChange={(e) => setCPct(clamp(safeNum(e.target.value, 0), 0, 90))} />
                </div>
                <div>
                  <Label className="text-sm">Fat %</Label>
                  <Input className="h-9" type="number" value={fPct} onChange={(e) => setFPct(clamp(safeNum(e.target.value, 0), 0, 90))} />
                </div>

                <div className="md:col-span-4 rounded-md border p-3 text-sm">
                  <div className="grid grid-cols-4 gap-2">
                    <div>Target kcal: <b>{toFixed(targets.calories, 0)}</b></div>
                    <div>Protein: <b>{targets.protein_g} g</b></div>
                    <div>Carbs: <b>{targets.carbs_g} g</b></div>
                    <div>Fat: <b>{targets.fat_g} g</b></div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* RIGHT: Macro Rings + Quick actions */}
        <div className="space-y-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Macro Overview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <MacroRingsGroup
                totals={totalsForRings}
                targets={{
                  protein_g: targets.protein_g,
                  carbs_g: targets.carbs_g,
                  fat_g: targets.fat_g,
                  calories: targets.calories,
                }}
                compact
              />
              <div className="text-xs text-muted-foreground">
                These targets guide “Suggest Swaps” and agent picks in Cooking.
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => {
                    emitEvent?.("nutrition.suggestSwap", {
                      scope: { type: "session", id: session?.id || null },
                      targets,
                      gaps: { protein_g: targets.protein_g, carbs_g: targets.carbs_g, fat_g: targets.fat_g, calories: targets.calories },
                    });
                    toast({ title: "Suggestions queued" });
                  }}
                >
                  Suggest Swaps
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => eventBus.emit("ui.open", { id: "RecipeVault" })}
                >
                  Explore Recipes
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Filters */}
      <Card className="mt-3">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Dietary Filters for Cooking</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Tabs defaultValue="tags">
            <TabsList>
              <TabsTrigger value="tags">Tags</TabsTrigger>
              <TabsTrigger value="ingredients">Ingredients</TabsTrigger>
              <TabsTrigger value="methods">Methods</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
            </TabsList>

            <TabsContent value="tags" className="mt-3 space-y-3">
              <TagEditor
                label="Include tags (prefer)"
                value={incl}
                onChange={setIncl}
                placeholder="e.g., whole-grain, legumes, high-fiber"
              />
              <TagEditor
                label="Exclude tags"
                value={excl}
                onChange={setExcl}
                placeholder="e.g., ultra-processed, dessert"
              />
            </TabsContent>

            <TabsContent value="ingredients" className="mt-3 space-y-3">
              <TagEditor
                label="Disallow ingredients"
                value={deny}
                onChange={setDeny}
                placeholder="e.g., shellfish, pork, caffeine, leaven"
              />
              <TagEditor
                label="Allow ingredients (whitelist)"
                value={allow}
                onChange={setAllow}
                placeholder="e.g., lentils, brown rice, quinoa"
              />
            </TabsContent>

            <TabsContent value="methods" className="mt-3">
              <TagEditor
                label="Preferred methods"
                value={methods}
                onChange={setMethods}
                placeholder="e.g., saute, steam, roast"
              />
            </TabsContent>

            <TabsContent value="notes" className="mt-3">
              <Label className="text-sm">Notes for agents</Label>
              <Textarea
                placeholder="Any substitutions, allergies, or time constraints for this session…"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </TabsContent>
          </Tabs>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={saveConstraints}>Save Filters</Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                // Daniel Fast quick toggle for filters
                const df = MEAL_PLAN_TEMPLATES?.danielFast?.constraints;
                if (!df) { toast({ title: "Daniel Fast template not found" }); return; }
                const prev = { incl, excl, deny, allow, methods };
                setIncl(df.includeTags || []);
                setExcl(df.excludeTags || []);
                setDeny(df.denyIngredients || []);
                setAllow(df.allowIngredients || []);
                setMethods(df.cookingMethodsPrefer || []);
                toast({
                  title: "Daniel Fast filters applied",
                  action: <Button size="sm" variant="outline" onClick={() => {
                    setIncl(prev.incl); setExcl(prev.excl); setDeny(prev.deny); setAllow(prev.allow); setMethods(prev.methods);
                    toast({ title: "Reverted" });
                  }}>Undo</Button>,
                });
              }}
            >
              Apply Daniel Fast Filters
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                emitEvent?.("preferences.changed", { keys: ["nutrition.constraints", "nutrition.goals"] });
                eventBus.emit("ui.open", { id: "BatchSessionPlanner" });
              }}
            >
              Build Batch Session
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <Card className="mt-3">
        <CardContent className="py-3 flex flex-wrap items-center gap-3">
          <div className="text-xs text-muted-foreground">
            Changes influence the Cooking assistant, meal suggestions, and timers. Sabbath-aware logic prefers hands-off steps.
          </div>
          <div className="ml-auto flex items-center gap-3">
            <Checkbox
              id="applyNow"
              onCheckedChange={(v) => v && applyToSession()}
            />
            <Label htmlFor="applyNow" className="text-xs">Apply to current session now</Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------- Small helpers ---------------- */
function TagEditor({ label, value = [], onChange, placeholder }) {
  const [input, setInput] = useState("");
  const add = () => {
    const v = (input || "").trim();
    if (!v) return;
    const parts = v.split(",").map((s) => s.trim()).filter(Boolean);
    const next = Array.from(new Set([...(value || []), ...parts]));
    onChange(next);
    setInput("");
  };
  const remove = (idx) => onChange((value || []).filter((_, i) => i !== idx));

  return (
    <div className="space-y-2">
      <Label className="text-sm">{label}</Label>
      <div className="flex gap-2">
        <Input
          className="h-9"
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
        />
        <Button size="sm" onClick={add}>Add</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(value || []).map((t, i) => (
          <span key={`${t}-${i}`} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
            {t}
            <button className="text-muted-foreground hover:text-rose-600" onClick={() => remove(i)}>✕</button>
          </span>
        ))}
        {(!value || value.length === 0) && <span className="text-xs text-muted-foreground">None</span>}
      </div>
    </div>
  );
}

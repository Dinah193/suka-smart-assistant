/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\nutrition\BMI.jsx
/**
 * Route: /nutrition/bmi
 *
 * Interactive BMI + Profile Editor (SSA)
 * -----------------------------------------------------------------------------
 * Goals:
 * - Let user edit/save PersonProfile (name/sex/age/height/weight/activity)
 * - On save: persist to Dexie via shared nutritionStore, set active person,
 *   compute BMI derivation, and emit events so Macros/Micros react immediately.
 * - Defensive imports: page still renders if shared store/events are missing.
 *
 * Cross-tool wiring:
 * - actions.savePersonProfile(...)  -> emits PROFILE_UPDATED
 * - actions.runBmi(personId)        -> emits BMI_COMPUTED (+ TOOLRUN_LOGGED)
 * - wireSubscriptions()             -> listens to TARGETS/CONSTRAINTS/ACTIVE changes
 */

import React, { useEffect, useMemo, useState } from "react";

// UI (shadcn) — keep lightweight and compatible with your repo
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/components/ui/use-toast";

// + Shared wiring layer (required)
import { useNutritionStore } from "@/services/nutrition/nutritionStore";
import {
  NUTRITION_EVENTS,
  onNutritionEvent,
} from "@/services/nutrition/nutritionEvents";

// ----------------------------- Small helpers --------------------------------
const safeNum = (v, fb = null) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
};

const round = (n, d = 1) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  const p = 10 ** d;
  return Math.round(x * p) / p;
};

function computeBmiLocal(heightCm, weightKg) {
  const h = Number(heightCm);
  const w = Number(weightKg);
  if (!h || !w || !Number.isFinite(h) || !Number.isFinite(w)) return null;
  const m = h / 100;
  const bmi = w / (m * m);
  const v = round(bmi, 1);
  let category = "unknown";
  if (v < 18.5) category = "underweight";
  else if (v < 25) category = "normal";
  else if (v < 30) category = "overweight";
  else category = "obese";
  return { bmi: v, category };
}

function bmiBadgeVariant(category) {
  if (category === "normal") return "secondary";
  if (category === "underweight") return "outline";
  if (category === "overweight") return "default";
  if (category === "obese") return "destructive";
  return "outline";
}

// ------------------------------- Page ---------------------------------------
export default function BMI() {
  // + required shared store usage
  const { actions, selectors } = useNutritionStore();
  const active = selectors.getActivePerson();
  const derived = selectors.getDerived?.() || { bmi: null };

  // Local UI state (kept simple; you can swap to your existing UI anytime)
  const [name, setName] = useState("");
  const [sex, setSex] = useState("unknown");
  const [age, setAge] = useState("");
  const [heightCm, setHeightCm] = useState("");
  const [weightKg, setWeightKg] = useState("");
  const [activityLevel, setActivityLevel] = useState("moderate");

  const [saving, setSaving] = useState(false);

  // Derived preview (local) while typing (even before saving)
  const bmiPreview = useMemo(
    () => computeBmiLocal(heightCm, weightKg),
    [heightCm, weightKg]
  );

  // Keep form synced with active person when it changes
  useEffect(() => {
    setName(String(active?.name || ""));
    setSex(String(active?.sex || "unknown"));
    setAge(active?.age == null ? "" : String(active.age));
    setHeightCm(active?.heightCm == null ? "" : String(active.heightCm));
    setWeightKg(active?.weightKg == null ? "" : String(active.weightKg));
    setActivityLevel(String(active?.activityLevel || "moderate"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  useEffect(() => {
    actions.bootstrap();
    const unsubPromise = actions.wireSubscriptions();

    // Example: react to active person changes while on BMI page
    const unsub2Promise = onNutritionEvent(
      NUTRITION_EVENTS.ACTIVE_PERSON_CHANGED,
      () => {
        // no-op (wire point): if you want, you can show a toast:
        // toast({ title: "Active profile changed", description: "BMI editor updated." });
      }
    );

    return () => {
      void unsubPromise.then((unsub) => unsub && unsub());
      void unsub2Promise.then((unsub) => unsub && unsub());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // + required handler
  async function onSaveProfile(profilePatch) {
    // profilePatch: { name, age, heightCm, weightKg, sex, activityLevel, ... }
    setSaving(true);
    try {
      const saved = await actions.savePersonProfile(profilePatch, {
        setActive: true,
      });
      if (saved?.id) {
        // store BMI derivation + emit BMI_COMPUTED
        await actions.runBmi(saved.id);

        toast({
          title: "Profile saved",
          description: "BMI updated and shared across Macros/Micros.",
        });
      } else {
        toast({ title: "Save failed", description: "No profile was saved." });
      }
      return saved;
    } catch (e) {
      toast({
        title: "Save failed",
        description: e?.message || String(e),
      });
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function onClickSave() {
    const profilePatch = {
      id: active?.id || undefined, // keep the active id if present
      name: String(name || "Household Member"),
      sex: String(sex || "unknown"),
      age: age === "" ? null : safeNum(age, null),
      heightCm: heightCm === "" ? null : safeNum(heightCm, null),
      weightKg: weightKg === "" ? null : safeNum(weightKg, null),
      activityLevel: String(activityLevel || "moderate"),
    };
    await onSaveProfile(profilePatch);
  }

  async function onRecomputeBmi() {
    const pid = active?.id;
    if (!pid) return;
    await actions.runBmi(pid);
    toast({ title: "BMI recalculated" });
  }

  async function onResetDefaults() {
    const pid = active?.id;
    if (!pid) return;
    await actions.resetToDefaults(pid);
    toast({
      title: "Reset complete",
      description: "Targets/constraints reset to defaults.",
    });
  }

  // Show BMI result from store derivations if present, otherwise local preview
  const bmiFromStore = derived?.bmi || null;
  const bmiShown = bmiFromStore?.bmi != null ? bmiFromStore : bmiPreview;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">BMI</h1>
        <p className="text-sm text-muted-foreground">
          Save a profile once and your Macros/Micros tools update automatically
          through the shared nutrition store.
        </p>
      </header>

      <div className="grid gap-4">
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="text-lg">Profile</CardTitle>
                <div className="text-xs text-muted-foreground">
                  Active:{" "}
                  <span className="font-medium">{active?.name || "None"}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onRecomputeBmi}
                  disabled={!active?.id || saving}
                >
                  Recompute BMI
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={onResetDefaults}
                  disabled={!active?.id || saving}
                >
                  Reset to defaults
                </Button>
                <Button size="sm" onClick={onClickSave} disabled={saving}>
                  {saving ? "Saving…" : "Save Profile"}
                </Button>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <div className="grid gap-1">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Household Member"
                />
              </div>

              <div className="grid gap-1">
                <Label>Sex</Label>
                <Select value={sex} onValueChange={setSex}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="female">Female</SelectItem>
                    <SelectItem value="male">Male</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                    <SelectItem value="unknown">Prefer not to say</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1">
                <Label>Age</Label>
                <Input
                  type="number"
                  min={0}
                  value={age}
                  onChange={(e) => setAge(e.target.value)}
                  placeholder="e.g. 35"
                />
              </div>

              <div className="grid gap-1">
                <Label>Activity level</Label>
                <Select value={activityLevel} onValueChange={setActivityLevel}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sedentary">Sedentary</SelectItem>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="moderate">Moderate</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="very_active">Very Active</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-1">
                <Label>Height (cm)</Label>
                <Input
                  type="number"
                  min={0}
                  value={heightCm}
                  onChange={(e) => setHeightCm(e.target.value)}
                  placeholder="e.g. 165"
                />
              </div>

              <div className="grid gap-1">
                <Label>Weight (kg)</Label>
                <Input
                  type="number"
                  min={0}
                  value={weightKg}
                  onChange={(e) => setWeightKg(e.target.value)}
                  placeholder="e.g. 75"
                />
              </div>
            </div>

            <Separator />

            <div className="flex flex-wrap items-center gap-3">
              <div className="text-sm">
                BMI:{" "}
                <span className="font-semibold">
                  {bmiShown?.bmi != null ? bmiShown.bmi : "—"}
                </span>
              </div>

              {bmiShown?.category ? (
                <Badge
                  variant={bmiBadgeVariant(bmiShown.category)}
                  className="capitalize"
                >
                  {bmiShown.category}
                </Badge>
              ) : (
                <Badge variant="outline">Enter height + weight</Badge>
              )}

              {bmiFromStore?.bmi != null ? (
                <span className="text-xs text-muted-foreground">
                  from saved derivations
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">
                  preview (not saved yet)
                </span>
              )}
            </div>

            <div className="text-xs text-muted-foreground">
              Saving a profile emits{" "}
              <code>
                {String(
                  NUTRITION_EVENTS.PROFILE_UPDATED ||
                    "nutrition.profile.updated"
                )}
              </code>
              , and BMI compute emits{" "}
              <code>
                {String(
                  NUTRITION_EVENTS.BMI_COMPUTED || "nutrition.bmi.computed"
                )}
              </code>
              . Macros/Micros pages can refresh instantly without tight
              coupling.
            </div>
          </CardContent>
        </Card>

        {/* keep your existing BMI UI */}
        {/* call onSaveProfile(...) from your Save button */}
      </div>
    </div>
  );
}

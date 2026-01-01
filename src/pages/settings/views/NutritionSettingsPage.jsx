// src/pages/settings/views/NutritionSettingsPage.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { automation, emitProgress } from "@/services/automation/runtime";
import { sabbathGuard } from "@/services/guardrails/sabbathGuard";
import { classNames } from "@/utils/css";

// Optional stores (graceful fallback if absent)
import { useNutritionStore } from "@/store/NutritionStore";     // optional
import { useFoodStore } from "@/store/FoodStore";               // optional (allergens/avoids/torah)
import { useMealPlanningStore } from "@/store/MealPlanningStore"; // optional (macro alignment)
import { useCalendarStore } from "@/store/CalendarStore";       // optional

/* -------------------------------------------------------------------------- */
/* UI atoms                                                                   */
/* -------------------------------------------------------------------------- */
const SectionCard = ({ title, subtitle, right, children }) => (
  <div className="rounded-2xl shadow-md border border-base-200 bg-base-100">
    <div className="flex items-start justify-between p-5 border-b border-base-200">
      <div>
        <h3 className="text-lg font-semibold">{title}</h3>
        {subtitle ? <p className="text-sm opacity-70 mt-1">{subtitle}</p> : null}
      </div>
      {right}
    </div>
    <div className="p-5">{children}</div>
  </div>
);

const Row = ({ label, hint, children }) => (
  <div className="flex items-start justify-between py-3">
    <div className="pr-4">
      <p className="font-medium">{label}</p>
      {hint ? <p className="text-sm opacity-70">{hint}</p> : null}
    </div>
    <div className="flex flex-wrap items-center gap-3">{children}</div>
  </div>
);

const Toggle = ({ checked, onChange, disabled }) => (
  <input
    type="checkbox"
    className="toggle toggle-primary"
    checked={!!checked}
    onChange={(e) => onChange(e.target.checked)}
    disabled={disabled}
  />
);

const Select = ({ value, onChange, options = [], disabled, className = "w-56" }) => (
  <select
    className={classNames("select select-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    disabled={disabled}
  >
    {options.map((o) => (
      <option key={(o.value ?? o) + ""} value={o.value ?? o}>
        {o.label ?? o}
      </option>
    ))}
  </select>
);

const Input = ({ value, onChange, placeholder, disabled, className = "w-64", type = "text" }) => (
  <input
    type={type}
    className={classNames("input input-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const Textarea = ({ value, onChange, placeholder, disabled, className = "w-full" }) => (
  <textarea
    className={classNames("textarea textarea-bordered", className)}
    value={value ?? ""}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    disabled={disabled}
  />
);

const Chip = ({ children }) => (
  <span className="px-2 py-1 rounded-full text-xs bg-base-200">{children}</span>
);

const GhostButton = (props) => (
  <button {...props} className={classNames("btn btn-ghost btn-sm", props.className)} />
);
const PrimaryButton = (props) => (
  <button {...props} className={classNames("btn btn-primary", props.className)} />
);
const SubtleButton = (props) => (
  <button {...props} className={classNames("btn btn-outline btn-sm", props.className)} />
);
const DangerButton = (props) => (
  <button {...props} className={classNames("btn btn-error btn-sm", props.className)} />
);

const Divider = () => <div className="border-t border-base-200 my-4" />;

const InlineNotice = ({ tone = "info", children }) => {
  const toneClass =
    tone === "success"
      ? "alert-success"
      : tone === "warning"
      ? "alert-warning"
      : tone === "error"
      ? "alert-error"
      : "alert-info";
  return <div className={classNames("alert", toneClass)}>{children}</div>;
};

const Skeleton = ({ lines = 3 }) => (
  <div className="animate-pulse space-y-3">
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className="h-4 bg-base-200 rounded" />
    ))}
  </div>
);

/* -------------------------------------------------------------------------- */
/* Undo stack                                                                 */
/* -------------------------------------------------------------------------- */
function useUndoStack() {
  const stack = useRef([]);
  const push = (revert, descr = "Change") => {
    stack.current.push(revert);
    return {
      message: `${descr} applied`,
      undo: () => {
        const fn = stack.current.pop();
        if (fn) fn();
      },
    };
  };
  return { push };
}

/* -------------------------------------------------------------------------- */
/* Event-driven glue                                                          */
/* -------------------------------------------------------------------------- */
const EVENT_KEYS = [
  "health.metrics.synced",  // wearables or manual entries changed
  "recipe.consolidated",    // nutrition tags/servings updated
  "inventory.updated",      // pantry swap suggestions (protein/fiber sources)
  "calendar.synced",        // surface success
  "preferences.changed",    // units/time windows updates
  "torah.profile.updated"   // dietary rules alignment
];

function useAutomationGlue(onEvent) {
  useEffect(() => {
    const offFns = [];
    EVENT_KEYS.forEach((k) => {
      const off = automation?.on?.(k, (payload) => onEvent?.(k, payload));
      if (off) offFns.push(off);
    });
    return () => offFns.forEach((f) => f?.());
  }, [onEvent]);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */
function cmFromFeetInches(feet, inches) {
  const f = parseInt(feet || "0", 10) || 0;
  const i = parseInt(inches || "0", 10) || 0;
  return Math.round((f * 12 + i) * 2.54);
}
function kgFromLbs(lbs) {
  return Math.round(((parseFloat(lbs || "0") || 0) / 2.20462) * 10) / 10;
}
function lbsFromKg(kg) {
  return Math.round(((parseFloat(kg || "0") || 0) * 2.20462) * 10) / 10;
}
function kcalTDEE({ sex, age, heightCm, weightKg, activity = "moderate" }) {
  // Mifflin-St Jeor
  const s = sex === "female" ? -161 : 5;
  const bmr = Math.round(10 * weightKg + 6.25 * heightCm - 5 * age + s);
  const factors = { sedentary: 1.2, light: 1.375, moderate: 1.55, active: 1.725, athlete: 1.9 };
  return Math.round(bmr * (factors[activity] || 1.55));
}
function macroCalories({ calories, macroSplit }) {
  const { proteinPct, fatPct, carbPct } = macroSplit;
  const p = Math.round((calories * proteinPct) / 4);
  const f = Math.round((calories * fatPct) / 9);
  const c = Math.round((calories * carbPct) / 4);
  return { proteinG: p, fatG: f, carbsG: c };
}

/* -------------------------------------------------------------------------- */
/* Main Page                                                                  */
/* -------------------------------------------------------------------------- */
export default function NutritionSettingsPage() {
  const nutrition = useNutritionStore?.() ?? {};
  const food = useFoodStore?.() ?? {};
  const meal = useMealPlanningStore?.() ?? {};
  const calendar = useCalendarStore?.() ?? {};

  const loading = nutrition.loading || false;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);
  const [banners, setBanners] = useState([]);
  const undo = useUndoStack();

  /* ------------------------------ State ----------------------------------- */
  // Units & profile
  const [units, setUnits] = useState(nutrition.units || "imperial"); // imperial|metric
  const [sex, setSex] = useState(nutrition.sex || "male"); // male|female
  const [birthYear, setBirthYear] = useState(nutrition.birthYear || 1990);
  const [heightFeet, setHeightFeet] = useState(nutrition.heightFeet || "5");
  const [heightInches, setHeightInches] = useState(nutrition.heightInches || "10");
  const [heightCm, setHeightCm] = useState(nutrition.heightCm || 178);
  const [weightLbs, setWeightLbs] = useState(nutrition.weightLbs || 180);
  const [weightKg, setWeightKg] = useState(nutrition.weightKg || 82);
  const [activity, setActivity] = useState(nutrition.activity || "moderate"); // sedentary|light|moderate|active|athlete

  // Goals
  const [goal, setGoal] = useState(nutrition.goal || "recompose"); // cut|maintain|recompose|gain
  const [weeklyRate, setWeeklyRate] = useState(nutrition.weeklyRate ?? 0.5); // lb/wk (negative for cut)
  const [macroPreset, setMacroPreset] = useState(nutrition.macroPreset || "balanced"); // balanced|high-protein|mediterranean|keto|custom
  const [macroSplit, setMacroSplit] = useState(
    nutrition.macroSplit || { proteinPct: 0.30, fatPct: 0.30, carbPct: 0.40 }
  );
  const [fiberTarget, setFiberTarget] = useState(nutrition.fiberTarget ?? 30); // g/day
  const [sodiumCap, setSodiumCap] = useState(nutrition.sodiumCap ?? 2300); // mg/day

  // Micronutrient focus (coach nudges menu toward these)
  const [microFocus, setMicroFocus] = useState(
    nutrition.microFocus || ["iron", "vitamin D", "magnesium"]
  );

  // Hydration & fasting
  const [hydrationTargetMl, setHydrationTargetMl] = useState(nutrition.hydrationTargetMl ?? 2800);
  const [hydrationReminders, setHydrationReminders] = useState(nutrition.hydrationReminders ?? true);
  const [fastingPreset, setFastingPreset] = useState(nutrition.fastingPreset || "none"); // none|14-10|16-8|12-12|custom
  const [eatingWindow, setEatingWindow] = useState(nutrition.eatingWindow || { start: "11:00", end: "19:00" });

  // Safety & dietary alignment
  const [respectTorahMode, setRespectTorahMode] = useState(nutrition.respectTorahMode ?? true);
  const [honorAllergens, setHonorAllergens] = useState(nutrition.honorAllergens ?? true);
  const [medicalFlags, setMedicalFlags] = useState(
    nutrition.medicalFlags || { pregnancy: false, diabetes: false, celiac: false, hypertension: false }
  );

  // Supplements (simple schedule generator)
  const [supplements, setSupplements] = useState(
    nutrition.supplements || [
      { name: "Vitamin D3", dose: "2000 IU", time: "morning" },
      { name: "Magnesium Glycinate", dose: "200 mg", time: "evening" },
    ]
  );

  // Calendar & sharing
  const [syncToCalendar, setSyncToCalendar] = useState(nutrition.syncToCalendar ?? true);
  const [sabbathBlock, setSabbathBlock] = useState(nutrition.sabbathBlock ?? true);
  const [shareSummary, setShareSummary] = useState(nutrition.shareSummary ?? false);

  /* --------------------------- Derived previews --------------------------- */
  const age = useMemo(() => {
    const yr = parseInt(birthYear || "1990", 10);
    const now = new Date().getFullYear();
    return Math.max(0, now - yr);
  }, [birthYear]);

  const heightPreviewCm = useMemo(() => {
    return units === "imperial" ? cmFromFeetInches(heightFeet, heightInches) : parseInt(heightCm || "0", 10) || 0;
  }, [units, heightFeet, heightInches, heightCm]);

  const weightPreviewKg = useMemo(() => {
    return units === "imperial" ? kgFromLbs(weightLbs) : parseFloat(weightKg || "0") || 0;
  }, [units, weightLbs, weightKg]);

  const tdee = useMemo(() => kcalTDEE({ sex, age, heightCm: heightPreviewCm, weightKg: weightPreviewKg, activity }), [sex, age, heightPreviewCm, weightPreviewKg, activity]);

  const calorieTarget = useMemo(() => {
    // Weekly rate in lb/wk -> ~500 kcal/day deficit/surplus per lb
    const delta = Math.round((parseFloat(weeklyRate || "0") || 0) * 500);
    // cut: negative; gain: positive; maintain: 0; recompose: small deficit with higher protein
    let adjust = 0;
    if (goal === "cut") adjust = -Math.abs(delta || 500);
    else if (goal === "gain") adjust = Math.abs(delta || 250);
    else if (goal === "recompose") adjust = -250;
    return Math.max(1200, tdee + adjust);
  }, [tdee, weeklyRate, goal]);

  const macroG = useMemo(() => {
    const preset = macroPreset;
    let split = macroSplit;
    if (preset !== "custom") {
      split =
        preset === "high-protein"
          ? { proteinPct: 0.35, fatPct: 0.25, carbPct: 0.40 }
          : preset === "mediterranean"
          ? { proteinPct: 0.25, fatPct: 0.35, carbPct: 0.40 }
          : preset === "keto"
          ? { proteinPct: 0.25, fatPct: 0.70, carbPct: 0.05 }
          : { proteinPct: 0.30, fatPct: 0.30, carbPct: 0.40 };
    }
    return macroCalories({ calories: calorieTarget, macroSplit: split });
  }, [macroPreset, macroSplit, calorieTarget]);

  /* -------------------------- Event-driven glue --------------------------- */
  useAutomationGlue((event, payload) => {
    if (event === "health.metrics.synced") {
      addBanner({
        key: "recompute-targets",
        tone: "info",
        text: "Health metrics synced. Recompute targets to stay aligned.",
        actions: [{ label: "Recompute Targets", fn: () => handleGenerate("targets") }],
      });
    }
    if (event === "recipe.consolidated") {
      addBanner({
        key: "rebuild-nutrition-plan",
        tone: "info",
        text: "Recipes updated. Rebuild nutrition plan for macro/micro coverage.",
        actions: [{ label: "Rebuild Plan", fn: () => handleGenerate("plan") }],
      });
    }
    if (event === "inventory.updated") {
      addBanner({
        key: "pantry-protein",
        tone: "warning",
        text: "Pantry changed. Consider swapping proteins/fiber sources.",
        actions: [{ label: "Refresh Shopping", fn: () => handleGenerate("shopping") }],
      });
    }
    if (event === "calendar.synced") {
      addBanner({ key: "cal-synced", tone: "success", text: "Nutrition reminders synced to calendar.", dismissible: true });
    }
    if (event === "torah.profile.updated") {
      addBanner({
        key: "dietary-align",
        tone: "info",
        text: "Dietary profile changed. Rebuild plan to honor new rules.",
        actions: [{ label: "Rebuild Plan", fn: () => handleGenerate("plan") }],
      });
    }
  });

  function addBanner(b) {
    setBanners((prev) => (prev.find((x) => x.key === b.key) ? prev : [...prev, b]));
  }
  function dismissBanner(key) {
    setBanners((prev) => prev.filter((b) => b.key !== key));
  }

  /* ------------------------------ Persistence ----------------------------- */
  const optimisticSave = async (partial, descr = "Settings") => {
    const prev = {
      units, sex, birthYear, heightFeet, heightInches, heightCm, weightLbs, weightKg, activity,
      goal, weeklyRate, macroPreset, macroSplit, fiberTarget, sodiumCap,
      microFocus, hydrationTargetMl, hydrationReminders, fastingPreset, eatingWindow,
      respectTorahMode, honorAllergens, medicalFlags,
      supplements, syncToCalendar, sabbathBlock, shareSummary,
    };

    // apply optimistic
    Object.entries(partial).forEach(([k, v]) => {
      switch (k) {
        case "units": setUnits(v); break;
        case "sex": setSex(v); break;
        case "birthYear": setBirthYear(v); break;
        case "heightFeet": setHeightFeet(v); break;
        case "heightInches": setHeightInches(v); break;
        case "heightCm": setHeightCm(v); break;
        case "weightLbs": setWeightLbs(v); break;
        case "weightKg": setWeightKg(v); break;
        case "activity": setActivity(v); break;

        case "goal": setGoal(v); break;
        case "weeklyRate": setWeeklyRate(v); break;
        case "macroPreset": setMacroPreset(v); break;
        case "macroSplit": setMacroSplit(v); break;
        case "fiberTarget": setFiberTarget(v); break;
        case "sodiumCap": setSodiumCap(v); break;

        case "microFocus": setMicroFocus(v); break;

        case "hydrationTargetMl": setHydrationTargetMl(v); break;
        case "hydrationReminders": setHydrationReminders(v); break;
        case "fastingPreset": setFastingPreset(v); break;
        case "eatingWindow": setEatingWindow(v); break;

        case "respectTorahMode": setRespectTorahMode(v); break;
        case "honorAllergens": setHonorAllergens(v); break;
        case "medicalFlags": setMedicalFlags(v); break;

        case "supplements": setSupplements(v); break;
        case "syncToCalendar": setSyncToCalendar(v); break;
        case "sabbathBlock": setSabbathBlock(v); break;
        case "shareSummary": setShareSummary(v); break;

        default: break;
      }
    });

    const { undo: revert } = undo.push(() => setStateFrom(prev)(), descr);

    setBusy(true);
    try {
      if (nutrition.saveSettings) {
        await nutrition.saveSettings({ ...prev, ...partial });
      } else {
        await automation.request?.("nutrition.saveSettings", { ...prev, ...partial });
      }

      setToast({ tone: "success", text: `${descr} saved`, action: { label: "Undo", fn: () => revert() } });
      emitProgress?.("settings.saved", { scope: "nutrition", nextBestAction: suggestNBA(partial) });

      // propagate dietary-impactful changes
      if ("respectTorahMode" in partial || "honorAllergens" in partial) {
        automation.emit?.("torah.profile.updated", { effectiveDate: new Date().toISOString() });
      }
    } catch (e) {
      revert();
      setToast({ tone: "error", text: `Failed to save ${descr}.` });
    } finally {
      setBusy(false);
    }
  };

  function setStateFrom(prev) {
    return () => {
      setUnits(prev.units); setSex(prev.sex); setBirthYear(prev.birthYear);
      setHeightFeet(prev.heightFeet); setHeightInches(prev.heightInches); setHeightCm(prev.heightCm);
      setWeightLbs(prev.weightLbs); setWeightKg(prev.weightKg); setActivity(prev.activity);

      setGoal(prev.goal); setWeeklyRate(prev.weeklyRate); setMacroPreset(prev.macroPreset);
      setMacroSplit(prev.macroSplit); setFiberTarget(prev.fiberTarget); setSodiumCap(prev.sodiumCap);

      setMicroFocus(prev.microFocus);

      setHydrationTargetMl(prev.hydrationTargetMl); setHydrationReminders(prev.hydrationReminders);
      setFastingPreset(prev.fastingPreset); setEatingWindow(prev.eatingWindow);

      setRespectTorahMode(prev.respectTorahMode); setHonorAllergens(prev.honorAllergens); setMedicalFlags(prev.medicalFlags);

      setSupplements(prev.supplements); setSyncToCalendar(prev.syncToCalendar);
      setSabbathBlock(prev.sabbathBlock); setShareSummary(prev.shareSummary);
    };
  }

  const suggestNBA = (partial) => {
    if ("macroPreset" in partial || "macroSplit" in partial || "goal" in partial || "weeklyRate" in partial)
      return { label: "Recompute Targets", action: () => handleGenerate("targets") };
    if ("microFocus" in partial || "fiberTarget" in partial || "sodiumCap" in partial)
      return { label: "Rebuild Nutrition Plan", action: () => handleGenerate("plan") };
    if ("supplements" in partial)
      return { label: "Build Supplement Schedule", action: () => handleGenerate("supplement-schedule") };
    if ("syncToCalendar" in partial)
      return { label: "Sync Reminders", action: () => handleSync("nutrition") };
    if ("shareSummary" in partial)
      return { label: "Send Nutrition Summary", action: () => handleShareSummary() };
    if ("respectTorahMode" in partial || "honorAllergens" in partial)
      return { label: "Re-score Recipes", action: () => handleGenerate("recs") };
    return { label: "Open Meal Planner", action: () => openMealPlanner() };
  };

  /* -------------------------------- Actions -------------------------------- */
  const handleGenerate = async (scope) => {
    const task = async () => {
      setBusy(true);
      try {
        if (nutrition.generate) {
          await nutrition.generate(scope);
        } else {
          await automation.request?.("nutrition.generate", { scope });
        }
        setToast({ tone: "success", text: `${labelForScope(scope)} generated.` });
      } catch {
        setToast({ tone: "error", text: `Failed to generate ${labelForScope(scope)}.` });
      } finally {
        setBusy(false);
      }
    };
    await sabbathGuard(task, { allowReadOnly: false });
  };

  const handleSync = async (scope = "nutrition") => {
    const task = async () => {
      try {
        if (nutrition.syncNow) {
          await nutrition.syncNow(scope);
        } else {
          await automation.request?.("calendar.sync", { scope });
        }
        automation.emit?.("calendar.synced", { scope });
        setToast({ tone: "success", text: "Nutrition reminders synced to calendar." });
      } catch {
        setToast({ tone: "error", text: "Calendar sync failed." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const handleShareSummary = async () => {
    const task = async () => {
      try {
        await automation.request?.("sharing.family.nutritionSummary", {
          includeTargets: true,
          includeHydration: true,
          includeFastingWindow: true,
          includeSupplements: true,
        });
        setToast({ tone: "success", text: "Nutrition summary sent to family view." });
      } catch {
        setToast({ tone: "error", text: "Could not send nutrition summary." });
      }
    };
    await sabbathGuard(task, { allowReadOnly: true });
  };

  const openMealPlanner = () => automation.emit?.("ui.navigate", { to: "/tier2/household/meals" });

  const labelForScope = (scope) =>
    ({
      targets: "nutrition targets",
      plan: "nutrition plan",
      shopping: "shopping list",
      "supplement-schedule": "supplement schedule",
      recs: "recipe scores",
    }[scope] || scope);

  /* ------------------------------- Lifecycle ------------------------------ */
  useEffect(() => {
    nutrition.fetchSettings?.();
  }, []); // eslint-disable-line

  /* ---------------------------------- UI ---------------------------------- */
  return (
    <div className="max-w-6xl mx-auto px-4 md:px-6 lg:px-2 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Nutrition Settings</h1>
          <p className="opacity-70">
            Define your profile, goals, macro split, micronutrient focus, hydration & fasting. Optimistic saves with Undo.
          </p>
        </div>
        <div className="flex gap-2">
          <GhostButton onClick={() => handleGenerate("targets")}>Recompute Targets</GhostButton>
          <PrimaryButton onClick={() => handleGenerate("plan")}>Rebuild Nutrition Plan</PrimaryButton>
        </div>
      </div>

      {/* Event-driven banners */}
      {banners.map((b) => (
        <InlineNotice key={b.key} tone={b.tone}>
          <div className="flex items-center justify-between w-full">
            <span>{b.text}</span>
            <div className="flex items-center gap-2">
              {b.actions?.map((a, i) => (
                <SubtleButton key={i} onClick={a.fn}>{a.label}</SubtleButton>
              ))}
              {b.dismissible !== false && (
                <GhostButton onClick={() => dismissBanner(b.key)}>Dismiss</GhostButton>
              )}
            </div>
          </div>
        </InlineNotice>
      ))}

      {/* Units & Profile */}
      <SectionCard
        title="Units & Profile"
        subtitle="Accurate profile improves target calculations. Change units anytime."
      >
        {loading ? (
          <Skeleton lines={4} />
        ) : (
          <>
            <Row label="Units">
              <Select
                value={units}
                onChange={(v) => optimisticSave({ units: v }, "Units")}
                options={[{value:"imperial",label:"Imperial (lb/ft)"},{value:"metric",label:"Metric (kg/cm)"}]}
              />
            </Row>

            <Row label="Sex & Birth Year">
              <Select
                value={sex}
                onChange={(v)=>optimisticSave({ sex: v }, "Sex")}
                options={[{value:"male",label:"Male"},{value:"female",label:"Female"}]}
              />
              <Input
                type="number"
                className="w-28"
                value={String(birthYear)}
                onChange={(v)=>optimisticSave({ birthYear: parseInt(v || "1990", 10) }, "Birth year")}
                placeholder="1990"
              />
              <Chip>{age} yrs</Chip>
            </Row>

            {units === "imperial" ? (
              <Row label="Height (ft/in)">
                <Input className="w-20" value={String(heightFeet)} onChange={(v)=>optimisticSave({ heightFeet: v }, "Height")} placeholder="5" />
                <Input className="w-20" value={String(heightInches)} onChange={(v)=>optimisticSave({ heightInches: v }, "Height")} placeholder="10" />
                <Chip>{heightPreviewCm} cm</Chip>
              </Row>
            ) : (
              <Row label="Height (cm)">
                <Input className="w-28" value={String(heightCm)} onChange={(v)=>optimisticSave({ heightCm: parseInt(v||"0",10) }, "Height")} placeholder="178" />
                <Chip>{Math.floor(heightCm/2.54/12)}′{Math.round((heightCm/2.54)%12)}″</Chip>
              </Row>
            )}

            {units === "imperial" ? (
              <Row label="Weight (lb)">
                <Input className="w-28" value={String(weightLbs)} onChange={(v)=>optimisticSave({ weightLbs: parseFloat(v||"0") }, "Weight")} placeholder="180" />
                <Chip>{weightPreviewKg} kg</Chip>
              </Row>
            ) : (
              <Row label="Weight (kg)">
                <Input className="w-28" value={String(weightKg)} onChange={(v)=>optimisticSave({ weightKg: parseFloat(v||"0") }, "Weight")} placeholder="82" />
                <Chip>{lbsFromKg(weightKg)} lb</Chip>
              </Row>
            )}

            <Row label="Activity Level">
              <Select
                value={activity}
                onChange={(v)=>optimisticSave({ activity: v }, "Activity")}
                options={[
                  {value:"sedentary",label:"Sedentary"},
                  {value:"light",label:"Lightly active"},
                  {value:"moderate",label:"Moderately active"},
                  {value:"active",label:"Active"},
                  {value:"athlete",label:"Athlete"},
                ]}
              />
              <Divider />
              <Chip>TDEE est: {tdee} kcal/day</Chip>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Goals & Macros */}
      <SectionCard
        title="Goals & Macros"
        subtitle="Pick a goal and macro preset, or customize your split. Preview updates instantly."
      >
        {loading ? (
          <Skeleton lines={5} />
        ) : (
          <>
            <Row label="Goal & Weekly Rate" hint="Positive to gain, negative to cut (lb/wk)">
              <Select
                value={goal}
                onChange={(v)=>optimisticSave({ goal: v }, "Goal")}
                options={[
                  { value:"cut", label:"Cut (fat loss)" },
                  { value:"maintain", label:"Maintain" },
                  { value:"recompose", label:"Recompose" },
                  { value:"gain", label:"Lean gain" },
                ]}
              />
              <Input
                type="number"
                className="w-28"
                value={String(weeklyRate)}
                onChange={(v)=>optimisticSave({ weeklyRate: parseFloat(v||"0") }, "Weekly rate")}
                placeholder="0.5"
              />
              <Chip>Daily target: {calorieTarget} kcal</Chip>
            </Row>

            <Row label="Macro Preset">
              <Select
                value={macroPreset}
                onChange={(v)=>optimisticSave({ macroPreset: v }, "Macro preset")}
                options={[
                  { value:"balanced", label:"Balanced (30/30/40)" },
                  { value:"high-protein", label:"High Protein (35/25/40)" },
                  { value:"mediterranean", label:"Mediterranean (25/35/40)" },
                  { value:"keto", label:"Keto (25/70/5)" },
                  { value:"custom", label:"Custom" },
                ]}
              />
            </Row>

            <Row label="Custom Split" hint="Protein / Fat / Carbs">
              <Input
                className="w-24"
                value={String(Math.round((macroSplit.proteinPct || 0) * 100))}
                onChange={(v)=>optimisticSave({ macroSplit: { ...macroSplit, proteinPct: Math.max(0, Math.min(1, (parseInt(v||"0",10)||0)/100)) } }, "Macro split")}
                placeholder="30"
                disabled={macroPreset !== "custom"}
              />
              <span className="opacity-60">%</span>
              <Input
                className="w-24"
                value={String(Math.round((macroSplit.fatPct || 0) * 100))}
                onChange={(v)=>optimisticSave({ macroSplit: { ...macroSplit, fatPct: Math.max(0, Math.min(1, (parseInt(v||"0",10)||0)/100)) } }, "Macro split")}
                placeholder="30"
                disabled={macroPreset !== "custom"}
              />
              <span className="opacity-60">%</span>
              <Input
                className="w-24"
                value={String(Math.round((macroSplit.carbPct || 0) * 100))}
                onChange={(v)=>optimisticSave({ macroSplit: { ...macroSplit, carbPct: Math.max(0, Math.min(1, (parseInt(v||"0",10)||0)/100)) } }, "Macro split")}
                placeholder="40"
                disabled={macroPreset !== "custom"}
              />
              <span className="opacity-60">%</span>
              <Chip>{macroG.proteinG}g P • {macroG.fatG}g F • {macroG.carbsG}g C</Chip>
            </Row>

            <Row label="Fiber & Sodium">
              <Input
                type="number"
                className="w-28"
                value={String(fiberTarget)}
                onChange={(v)=>optimisticSave({ fiberTarget: Math.max(10, parseInt(v||"10",10)) }, "Fiber target")}
                placeholder="30"
              />
              <span className="opacity-60">g/day</span>
              <Input
                type="number"
                className="w-28"
                value={String(sodiumCap)}
                onChange={(v)=>optimisticSave({ sodiumCap: Math.max(1000, parseInt(v||"1000",10)) }, "Sodium cap")}
                placeholder="2300"
              />
              <span className="opacity-60">mg/day</span>
              <SubtleButton onClick={() => handleGenerate("targets")}>Recompute Targets</SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Micronutrient Focus */}
      <SectionCard
        title="Micronutrient Focus"
        subtitle="We’ll nudge the plan toward foods rich in your focus nutrients."
      >
        {loading ? <Skeleton lines={3} /> : (
          <>
            <Row label="Focus Nutrients" hint="Comma-separated">
              <Input
                className="w-[36rem]"
                value={(microFocus || []).join(", ")}
                onChange={(v)=>optimisticSave({ microFocus: v.split(",").map(s=>s.trim()).filter(Boolean) }, "Micronutrient focus")}
                placeholder="iron, vitamin D, magnesium"
              />
              <SubtleButton onClick={() => handleGenerate("plan")}>Rebuild Plan</SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Hydration & Fasting */}
      <SectionCard
        title="Hydration & Fasting"
        subtitle="Daily water target and optional time-restricted eating window."
      >
        {loading ? <Skeleton lines={3} /> : (
          <>
            <Row label="Hydration">
              <Input
                type="number"
                className="w-28"
                value={String(hydrationTargetMl)}
                onChange={(v)=>optimisticSave({ hydrationTargetMl: Math.max(1000, parseInt(v||"1000",10)) }, "Hydration target")}
                placeholder="2800"
              />
              <span className="opacity-60">ml/day</span>
              <Toggle
                checked={hydrationReminders}
                onChange={(v)=>optimisticSave({ hydrationReminders: v }, "Hydration reminders")}
              />
              <span className="opacity-70 text-sm">Reminders</span>
            </Row>

            <Row label="Fasting Preset">
              <Select
                value={fastingPreset}
                onChange={(v)=>optimisticSave({ fastingPreset: v }, "Fasting preset")}
                options={[
                  { value:"none", label:"None" },
                  { value:"12-12", label:"12:12" },
                  { value:"14-10", label:"14:10" },
                  { value:"16-8", label:"16:8" },
                  { value:"custom", label:"Custom" },
                ]}
              />
              <Input
                className="w-28"
                value={eatingWindow.start}
                onChange={(v)=>optimisticSave({ eatingWindow: { ...eatingWindow, start: v } }, "Eating window")}
                placeholder="11:00"
                disabled={fastingPreset !== "custom" && fastingPreset !== "none"}
              />
              <span className="opacity-60">to</span>
              <Input
                className="w-28"
                value={eatingWindow.end}
                onChange={(v)=>optimisticSave({ eatingWindow: { ...eatingWindow, end: v } }, "Eating window")}
                placeholder="19:00"
                disabled={fastingPreset !== "custom" && fastingPreset !== "none"}
              />
              <SubtleButton onClick={() => handleGenerate("plan")}>Rebuild Plan</SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Alignment & Safety */}
      <SectionCard
        title="Alignment & Safety"
        subtitle="Honor dietary rules and medical considerations. Not medical advice."
      >
        {loading ? <Skeleton lines={3} /> : (
          <>
            <Row label="Respect Torah Mode">
              <Toggle checked={respectTorahMode} onChange={(v)=>optimisticSave({ respectTorahMode: v }, "Respect Torah mode")} />
              <SubtleButton onClick={() => handleGenerate("recs")}>Re-score Recipes</SubtleButton>
            </Row>
            <Row label="Honor Allergens from Food Settings">
              <Toggle checked={honorAllergens} onChange={(v)=>optimisticSave({ honorAllergens: v }, "Honor allergens")} />
            </Row>
            <Row label="Medical Considerations" hint="Affects suggestions and sodium/sugar caps">
              <label className="label cursor-pointer gap-2">
                <input type="checkbox" className="checkbox checkbox-sm"
                  checked={!!medicalFlags.pregnancy}
                  onChange={(e)=>optimisticSave({ medicalFlags: { ...medicalFlags, pregnancy: e.target.checked } }, "Medical flag")} />
                <span className="text-sm">Pregnancy</span>
              </label>
              <label className="label cursor-pointer gap-2">
                <input type="checkbox" className="checkbox checkbox-sm"
                  checked={!!medicalFlags.diabetes}
                  onChange={(e)=>optimisticSave({ medicalFlags: { ...medicalFlags, diabetes: e.target.checked } }, "Medical flag")} />
                <span className="text-sm">Diabetes</span>
              </label>
              <label className="label cursor-pointer gap-2">
                <input type="checkbox" className="checkbox checkbox-sm"
                  checked={!!medicalFlags.celiac}
                  onChange={(e)=>optimisticSave({ medicalFlags: { ...medicalFlags, celiac: e.target.checked } }, "Medical flag")} />
                <span className="text-sm">Celiac</span>
              </label>
              <label className="label cursor-pointer gap-2">
                <input type="checkbox" className="checkbox checkbox-sm"
                  checked={!!medicalFlags.hypertension}
                  onChange={(e)=>optimisticSave({ medicalFlags: { ...medicalFlags, hypertension: e.target.checked } }, "Medical flag")} />
                <span className="text-sm">Hypertension</span>
              </label>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Supplements */}
      <SectionCard
        title="Supplements"
        subtitle="Define a simple schedule; we can sync reminders."
        right={<SubtleButton onClick={() => handleGenerate("supplement-schedule")} disabled={busy}>Build Schedule</SubtleButton>}
      >
        {loading ? <Skeleton lines={3} /> : (
          <>
            {(supplements || []).map((s, i) => (
              <div key={i} className="rounded-xl border border-base-200 p-3 mb-2">
                <div className="flex flex-wrap gap-2 items-center">
                  <Input className="w-40" value={s.name} onChange={(v)=>updateSupplement(i, { ...s, name: v })} placeholder="Name" />
                  <Input className="w-32" value={s.dose} onChange={(v)=>updateSupplement(i, { ...s, dose: v })} placeholder="Dose" />
                  <Select
                    value={s.time || "morning"}
                    onChange={(v)=>updateSupplement(i, { ...s, time: v })}
                    options={["morning","noon","evening","bedtime"].map(x=>({ value:x, label:x.charAt(0).toUpperCase()+x.slice(1) }))}
                  />
                  <DangerButton onClick={()=>removeSupplement(i)}>Remove</DangerButton>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <SubtleButton onClick={()=>addSupplement()}>+ Add Supplement</SubtleButton>
            </div>
          </>
        )}
      </SectionCard>

      {/* Calendar & Sharing */}
      <SectionCard title="Calendar & Sharing" subtitle="Sync reminders and share a concise nutrition summary.">
        {loading ? <Skeleton lines={3} /> : (
          <>
            <Row label="Sync to Calendar" hint="Hydration reminders, fasting window, supplement times">
              <Toggle checked={syncToCalendar} onChange={(v)=>optimisticSave({ syncToCalendar: v }, "Calendar sync")} />
              <SubtleButton onClick={() => handleSync("nutrition")}>Sync now</SubtleButton>
            </Row>
            <Row label="Sabbath Guard" hint="Avoid creating/editing events during Sabbath; read-only allowed">
              <Toggle checked={sabbathBlock} onChange={(v)=>optimisticSave({ sabbathBlock: v }, "Sabbath guard")} />
            </Row>
            <Row label="Share Nutrition Summary" hint="Targets, fasting window, hydration & supplements">
              <Toggle checked={shareSummary} onChange={(v)=>optimisticSave({ shareSummary: v }, "Share nutrition summary")} />
              <SubtleButton onClick={handleShareSummary}>Send now</SubtleButton>
            </Row>
          </>
        )}
      </SectionCard>

      {/* Recommended Next Steps */}
      <SectionCard title="Recommended Next Steps" subtitle="One tap to keep momentum.">
        <div className="flex flex-wrap gap-2">
          <PrimaryButton onClick={() => handleGenerate("targets")} disabled={busy}>Recompute Targets</PrimaryButton>
          <SubtleButton onClick={() => handleGenerate("plan")} disabled={busy}>Rebuild Nutrition Plan</SubtleButton>
          <SubtleButton onClick={() => handleGenerate("supplement-schedule")} disabled={busy}>Build Supplement Schedule</SubtleButton>
          <SubtleButton onClick={() => handleSync("nutrition")} disabled={busy}>Sync to Calendar</SubtleButton>
        </div>
      </SectionCard>

      {/* Toast */}
      {toast && (
        <div className="toast toast-end z-50">
          <div
            className={classNames(
              "alert",
              toast.tone === "success"
                ? "alert-success"
                : toast.tone === "warning"
                ? "alert-warning"
                : toast.tone === "error"
                ? "alert-error"
                : "alert-info"
            )}
          >
            <div className="flex items-center gap-3">
              <span>{toast.text}</span>
              {toast.action ? (
                <button className="btn btn-xs" onClick={() => toast.action.fn?.()}>
                  {toast.action.label}
                </button>
              ) : null}
              <button className="btn btn-ghost btn-xs" onClick={() => setToast(null)}>✕</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  /* --------------------------- Supplements CRUD --------------------------- */
  function addSupplement() {
    const next = [...(supplements || []), { name: "", dose: "", time: "morning" }];
    optimisticSave({ supplements: next }, "Supplement");
  }
  function updateSupplement(idx, s) {
    const next = (supplements || []).map((x, i) => (i === idx ? s : x));
    optimisticSave({ supplements: next }, "Supplement");
  }
  function removeSupplement(idx) {
    const next = (supplements || []).filter((_, i) => i !== idx);
    optimisticSave({ supplements: next }, "Supplement");
  }
}

/* -------------------------------------------------------------------------- */
/* Notes for integrators                                                      */
/*
Optional NutritionStore shape (graceful fallback if missing):
  useNutritionStore(): {
    loading?: boolean
    units?: "imperial"|"metric"
    sex?: "male"|"female"
    birthYear?: number
    heightFeet?: string
    heightInches?: string
    heightCm?: number
    weightLbs?: number
    weightKg?: number
    activity?: "sedentary"|"light"|"moderate"|"active"|"athlete"

    goal?: "cut"|"maintain"|"recompose"|"gain"
    weeklyRate?: number
    macroPreset?: "balanced"|"high-protein"|"mediterranean"|"keto"|"custom"
    macroSplit?: { proteinPct:number, fatPct:number, carbPct:number }
    fiberTarget?: number
    sodiumCap?: number

    microFocus?: string[]
    hydrationTargetMl?: number
    hydrationReminders?: boolean
    fastingPreset?: "none"|"12-12"|"14-10"|"16-8"|"custom"
    eatingWindow?: { start:string, end:string }

    respectTorahMode?: boolean
    honorAllergens?: boolean
    medicalFlags?: { pregnancy?:boolean, diabetes?:boolean, celiac?:boolean, hypertension?:boolean }

    supplements?: Array<{ name:string, dose?:string, time?:"morning"|"noon"|"evening"|"bedtime" }>
    syncToCalendar?: boolean
    sabbathBlock?: boolean
    shareSummary?: boolean

    // methods:
    fetchSettings?: () => Promise<void>
    saveSettings?: (settings) => Promise<void>
    generate?: (scope:"targets"|"plan"|"shopping"|"supplement-schedule"|"recs") => Promise<void>
    syncNow?: (scope:"nutrition") => Promise<void>
  }

Automation fallbacks (used if store fns are absent):
  automation.request("nutrition.saveSettings", payload)
  automation.request("nutrition.generate", { scope })
  automation.request("calendar.sync", { scope: "nutrition" })
  automation.request("sharing.family.nutritionSummary", { includeTargets, includeHydration, includeFastingWindow, includeSupplements })
  automation.on("event", handler)
  automation.emit("ui.navigate", { to:"/tier2/household/meals" })
  automation.emit("calendar.synced", { scope:"nutrition" })

Event-driven glue listens to:
  health.metrics.synced -> recompute targets
  recipe.consolidated   -> rebuild nutrition plan
  inventory.updated     -> refresh shopping (protein/fiber swaps)
  calendar.synced       -> success banner
  torah.profile.updated -> rebuild plan honoring rules

Undo pattern:
  Optimistic saves push a revert callback; toast includes Undo.

Design system:
  Tailwind + DaisyUI; consistent atoms with other Settings views.
*/

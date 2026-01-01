import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * MacroPercentCalculator
 * -----------------------------------------------------------------------------
 * Goals:
 *  - Super-intuitive macro % planner with presets and sliders that always sum to 100%
 *  - Protein targeting by body weight (US default ft+in/lb; supports Metric)
 *  - Manual calories or quick estimate (Mifflin-St Jeor) without leaving the page
 *  - Per-meal breakdown + “Apply to Meal Planner” emit
 *  - Persist last choices (localStorage) and allow JSON export
 *  - Works across Suka Fitness & Defense Platform (onApply callback)
 *
 * Props:
 *  - onApply?: (plan) => void   // called with normalized plan payload
 *  - defaultCalories?: number
 *  - defaultMealsPerDay?: number
 *  - defaultPresetKey?: string   // "balanced" | "keto" | "lowcarb" | "highprotein" | "custom"
 *  - storageKey?: string         // default: "macroCalc:v1"
 */

const btnBase =
  "inline-flex items-center justify-center rounded-xl border bg-white px-4 py-2 font-medium shadow-[0_6px_0_rgba(0,0,0,0.2),0_1px_4px_rgba(0,0,0,0.15)] active:translate-y-[4px] active:shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_2px_rgba(0,0,0,0.25)] transition-all";
const card =
  "rounded-3xl p-5 bg-gradient-to-b from-slate-50 to-slate-200 border border-slate-300 shadow-[0_10px_0_rgba(0,0,0,0.15),0_2px_8px_rgba(0,0,0,0.15)]";

const PRESETS = {
  balanced: { label: "Balanced 30/30/40", protein: 30, fat: 30, carbs: 40 },
  highprotein: { label: "High-Protein 40/30/30", protein: 40, fat: 30, carbs: 30 },
  lowcarb: { label: "Low-Carb 35/40/25", protein: 35, fat: 40, carbs: 25 },
  keto: { label: "Keto 20/70/10", protein: 20, fat: 70, carbs: 10 },
  custom: { label: "Custom", protein: 30, fat: 30, carbs: 40 },
};

const clamp = (n, min, max) => Math.min(max, Math.max(min, Number.isFinite(n) ? n : 0));
const round1 = (n) => Math.round(n * 10) / 10;
const round0 = (n) => Math.round(n);

/** Convert lb↔kg and in/ft ↔ cm helpers */
const lbToKg = (lb) => lb * 0.45359237;
const kgToLb = (kg) => kg / 0.45359237;
const inToCm = (inches) => inches * 2.54;
const cmToIn = (cm) => cm / 2.54;

/** Mifflin-St Jeor quick estimate */
function estimateCalories({ sex = "female", age = 35, heightCm = 165, weightKg = 75, activity = "moderate" }) {
  const s = sex === "male" ? 5 : -161;
  const bmr = 10 * weightKg + 6.25 * heightCm - 5 * age + s;
  const mult = {
    sedentary: 1.2,
    light: 1.375,
    moderate: 1.55,
    very: 1.725,
    athlete: 1.9,
  }[activity] || 1.55;
  return Math.round(bmr * mult);
}

/** Auto-balance macro sliders so sum = 100, prioritizing “others” */
function rebalance({ p, f, c }, changedKey) {
  let total = p + f + c;
  if (total === 100) return { protein: p, fat: f, carbs: c };

  const keys = ["protein", "fat", "carbs"];
  const others = keys.filter((k) => k !== changedKey);
  const map = { protein: p, fat: f, carbs: c };

  if (total > 100) {
    let excess = total - 100;
    for (const k of others) {
      const take = Math.min(map[k], excess / others.length);
      map[k] -= take;
    }
  } else {
    let deficit = 100 - total;
    for (const k of others) {
      map[k] += deficit / others.length;
    }
  }
  // final clamp and normalize tiny float drift
  map.protein = clamp(map.protein, 0, 100);
  map.fat = clamp(map.fat, 0, 100);
  map.carbs = clamp(map.carbs, 0, 100);
  const fix = map.protein + map.fat + map.carbs;
  if (fix !== 100) {
    // push or pull from carbs as the most flexible by default
    const diff = 100 - fix;
    map.carbs = clamp(map.carbs + diff, 0, 100);
  }
  return map;
}

export default function MacroPercentCalculator({
  onApply,
  defaultCalories = 2200,
  defaultMealsPerDay = 3,
  defaultPresetKey = "balanced",
  storageKey = "macroCalc:v1",
}) {
  // ----- units & body inputs -----
  const [unit, setUnit] = useState("us"); // 'us' or 'metric' (US default per your standard)
  const [sex, setSex] = useState("female");
  const [age, setAge] = useState(35);

  const [ft, setFt] = useState(5);
  const [inch, setInch] = useState(6);
  const [cm, setCm] = useState(168);

  const [lb, setLb] = useState(180);
  const [kg, setKg] = useState(81.6);

  const heightCm = useMemo(() => (unit === "us" ? inToCm(ft * 12 + inch) : cm), [unit, ft, inch, cm]);
  const weightKg = useMemo(() => (unit === "us" ? lbToKg(lb) : kg), [unit, lb, kg]);

  // ----- macro + calories -----
  const [calories, setCalories] = useState(defaultCalories);
  const [meals, setMeals] = useState(defaultMealsPerDay);
  const [preset, setPreset] = useState(defaultPresetKey); // keys from PRESETS

  const [proteinPct, setProteinPct] = useState(PRESETS[defaultPresetKey]?.protein ?? 30);
  const [fatPct, setFatPct] = useState(PRESETS[defaultPresetKey]?.fat ?? 30);
  const [carbPct, setCarbPct] = useState(PRESETS[defaultPresetKey]?.carbs ?? 40);

  // ----- protein targeting by body weight -----
  const [useProteinByWeight, setUseProteinByWeight] = useState(true);
  const [proteinPerLb, setProteinPerLb] = useState(0.8); // g per lb (range 0.6–1.2 typical)
  const [proteinPerKg, setProteinPerKg] = useState(1.8); // g per kg (range ~1.2–2.6)

  // ----- activity for estimate -----
  const [activity, setActivity] = useState("moderate");

  // ----- persistence -----
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const saved = JSON.parse(raw);
        setUnit(saved.unit ?? "us");
        setSex(saved.sex ?? "female");
        setAge(saved.age ?? 35);
        setFt(saved.ft ?? 5);
        setInch(saved.inch ?? 6);
        setCm(saved.cm ?? 168);
        setLb(saved.lb ?? 180);
        setKg(saved.kg ?? 81.6);
        setCalories(saved.calories ?? defaultCalories);
        setMeals(saved.meals ?? defaultMealsPerDay);
        setPreset(saved.preset ?? defaultPresetKey);
        setProteinPct(saved.proteinPct ?? proteinPct);
        setFatPct(saved.fatPct ?? fatPct);
        setCarbPct(saved.carbPct ?? carbPct);
        setUseProteinByWeight(saved.useProteinByWeight ?? true);
        setProteinPerLb(saved.proteinPerLb ?? 0.8);
        setProteinPerKg(saved.proteinPerKg ?? 1.8);
        setActivity(saved.activity ?? "moderate");
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const payload = {
      unit,
      sex,
      age,
      ft,
      inch,
      cm,
      lb,
      kg,
      calories,
      meals,
      preset,
      proteinPct,
      fatPct,
      carbPct,
      useProteinByWeight,
      proteinPerLb,
      proteinPerKg,
      activity,
    };
    try {
      localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch {}
  }, [
    unit,
    sex,
    age,
    ft,
    inch,
    cm,
    lb,
    kg,
    calories,
    meals,
    preset,
    proteinPct,
    fatPct,
    carbPct,
    useProteinByWeight,
    proteinPerLb,
    proteinPerKg,
    activity,
    storageKey,
  ]);

  // ----- preset setter -----
  function applyPreset(key) {
    setPreset(key);
    const p = PRESETS[key] ?? PRESETS.custom;
    setProteinPct(p.protein);
    setFatPct(p.fat);
    setCarbPct(p.carbs);
  }

  // ----- macro % adjustments with auto-balance -----
  function handleMacroChange(which, val) {
    const v = clamp(val, 0, 100);
    if (which === "protein") {
      const next = rebalance({ p: v, f: fatPct, c: carbPct }, "protein");
      setProteinPct(next.protein);
      setFatPct(next.fat);
      setCarbPct(next.carbs);
    } else if (which === "fat") {
      const next = rebalance({ p: proteinPct, f: v, c: carbPct }, "fat");
      setProteinPct(next.protein);
      setFatPct(next.fat);
      setCarbPct(next.carbs);
    } else {
      const next = rebalance({ p: proteinPct, f: fatPct, c: v }, "carbs");
      setProteinPct(next.protein);
      setFatPct(next.fat);
      setCarbPct(next.carbs);
    }
    setPreset("custom");
  }

  // ----- grams calculations -----
  // If using protein-by-weight: compute protein grams first; then back-solve protein% and assign fat/carbs by current ratio.
  const computed = useMemo(() => {
    let kcal = clamp(calories, 800, 6000);
    let pPct = proteinPct;
    let fPct = fatPct;
    let cPct = carbPct;

    // 1g protein = 4 kcal, 1g carbs = 4 kcal, 1g fat = 9 kcal
    let proteinG;
    if (useProteinByWeight) {
      proteinG = unit === "us" ? lb * proteinPerLb : kg * proteinPerKg;
      const proteinKcal = proteinG * 4;
      pPct = clamp((proteinKcal / kcal) * 100, 5, 60); // keep within sane range
      // Recompute others respecting current ratio between F & C
      const otherPct = 100 - pPct;
      const fcSum = fatPct + carbPct || 1;
      fPct = (fatPct / fcSum) * otherPct;
      cPct = (carbPct / fcSum) * otherPct;
    }

    // Final grams from percentages
    const proteinKcal = (pPct / 100) * kcal;
    const fatKcal = (fPct / 100) * kcal;
    const carbKcal = (cPct / 100) * kcal;

    const P = proteinG ?? proteinKcal / 4;
    const F = fatKcal / 9;
    const C = carbKcal / 4;

    return {
      calories: kcal,
      pct: { protein: pPct, fat: fPct, carbs: cPct },
      grams: { protein: P, fat: F, carbs: C },
      perMeal: {
        protein: P / meals,
        fat: F / meals,
        carbs: C / meals,
      },
    };
  }, [
    calories,
    proteinPct,
    fatPct,
    carbPct,
    useProteinByWeight,
    proteinPerLb,
    proteinPerKg,
    lb,
    kg,
    unit,
    meals,
  ]);

  // ----- quick estimate handler -----
  function handleEstimate() {
    const kcal = estimateCalories({ sex, age, heightCm, weightKg, activity });
    setCalories(kcal);
  }

  // ----- export + apply -----
  function handleExport() {
    const plan = buildPlanPayload();
    const blob = new Blob([JSON.stringify(plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "macro-plan.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  function buildPlanPayload() {
    return {
      meta: {
        source: "Suka Smart Assistant",
        module: "Nutrition",
        tool: "MacroPercentCalculator",
        timestamp: new Date().toISOString(),
        preset,
      },
      user: {
        unit,
        sex,
        age,
        heightCm,
        weightKg,
        height: unit === "us" ? { ft, inch } : { cm },
        weight: unit === "us" ? { lb } : { kg },
        activity,
      },
      targets: {
        calories: computed.calories,
        macrosPct: computed.pct,
        macrosG: computed.grams,
        mealsPerDay: meals,
      },
      rules: {
        proteinByWeight: useProteinByWeight,
        proteinPerLb,
        proteinPerKg,
      },
      // Handoff hints for other modules:
      intents: {
        mealPlanner: {
          action: "seed-plan",
          note: "Distribute macros across recipes/snacks respecting per-meal grams.",
        },
        fitnessDefense: {
          action: "sync-macros",
          note: "Use protein target to inform post-workout targets.",
        },
      },
    };
  }

  function handleApply() {
    const plan = buildPlanPayload();
    if (typeof onApply === "function") onApply(plan);
    // Optional: toast/UI feedback could be handled by parent
  }

  // ----- UI helpers -----
  const MacroRow = ({ label, pct, grams, perMeal, onChange }) => {
    return (
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <div className="font-semibold">{label}</div>
          <div className="text-sm tabular-nums">
            {round1(pct)}% • {round0(grams)} g/day • {round0(perMeal)} g/meal
          </div>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(pct)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-indigo-600"
        />
      </div>
    );
  };

  return (
    <div className={`${card} max-w-4xl mx-auto`}>
      <div className="flex items-center justify-between gap-4 mb-4">
        <h2 className="text-2xl font-extrabold tracking-tight">Macro Percent Calculator</h2>
        <div className="flex gap-2">
          <button onClick={handleExport} className={`${btnBase} text-slate-800`}>
            Export JSON
          </button>
          <button onClick={handleApply} className={`${btnBase} bg-indigo-600 text-white border-indigo-700`}>
            Apply to Meal Planner
          </button>
        </div>
      </div>

      {/* Presets */}
      <div className="mb-5">
        <div className="text-sm font-semibold mb-2">Presets</div>
        <div className="flex flex-wrap gap-2">
          {Object.entries(PRESETS).map(([key, val]) => (
            <button
              key={key}
              onClick={() => applyPreset(key)}
              className={`${btnBase} ${preset === key ? "bg-indigo-600 text-white border-indigo-700" : ""}`}
              title={val.label}
            >
              {val.label}
            </button>
          ))}
        </div>
      </div>

      {/* Calories + meals */}
      <div className="grid md:grid-cols-3 gap-4 mb-6">
        <div className="p-4 bg-white rounded-2xl border">
          <div className="font-semibold mb-2">Daily Calories</div>
          <input
            type="number"
            className="w-full rounded-xl border px-3 py-2"
            value={calories}
            min={800}
            max={6000}
            onChange={(e) => setCalories(clamp(Number(e.target.value), 800, 6000))}
          />
          <div className="mt-3 text-xs text-slate-600">Range 800–6000 kcal</div>
        </div>

        <div className="p-4 bg-white rounded-2xl border">
          <div className="font-semibold mb-2">Meals per Day</div>
          <input
            type="number"
            className="w-full rounded-xl border px-3 py-2"
            value={meals}
            min={1}
            max={8}
            onChange={(e) => setMeals(clamp(Number(e.target.value), 1, 8))}
          />
          <div className="mt-3 text-xs text-slate-600">We’ll show grams per meal.</div>
        </div>

        <div className="p-4 bg-white rounded-2xl border">
          <div className="font-semibold mb-2">Quick Estimate</div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            <select className="rounded-xl border px-2 py-1" value={sex} onChange={(e) => setSex(e.target.value)}>
              <option value="female">Female</option>
              <option value="male">Male</option>
            </select>
            <select className="rounded-xl border px-2 py-1" value={activity} onChange={(e) => setActivity(e.target.value)}>
              <option value="sedentary">Sedentary</option>
              <option value="light">Light</option>
              <option value="moderate">Moderate</option>
              <option value="very">Very Active</option>
              <option value="athlete">Athlete</option>
            </select>
          </div>
          <div className="grid grid-cols-3 gap-2 mb-2">
            <input
              type="number"
              className="rounded-xl border px-2 py-1"
              value={age}
              min={12}
              max={100}
              onChange={(e) => setAge(clamp(Number(e.target.value), 12, 100))}
              placeholder="Age"
              title="Age"
            />
            {unit === "us" ? (
              <>
                <input
                  type="number"
                  className="rounded-xl border px-2 py-1"
                  value={ft}
                  min={3}
                  max={7}
                  onChange={(e) => setFt(clamp(Number(e.target.value), 3, 7))}
                  placeholder="ft"
                  title="Height (ft)"
                />
                <input
                  type="number"
                  className="rounded-xl border px-2 py-1"
                  value={inch}
                  min={0}
                  max={11}
                  onChange={(e) => setInch(clamp(Number(e.target.value), 0, 11))}
                  placeholder="in"
                  title="Height (in)"
                />
              </>
            ) : (
              <input
                type="number"
                className="rounded-xl border px-2 py-1 col-span-2"
                value={cm}
                min={120}
                max={220}
                onChange={(e) => setCm(clamp(Number(e.target.value), 120, 220))}
                placeholder="cm"
                title="Height (cm)"
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 mb-2">
            {unit === "us" ? (
              <input
                type="number"
                className="rounded-xl border px-2 py-1 col-span-2"
                value={lb}
                min={70}
                max={600}
                onChange={(e) => setLb(clamp(Number(e.target.value), 70, 600))}
                placeholder="lb"
                title="Weight (lb)"
              />
            ) : (
              <input
                type="number"
                className="rounded-xl border px-2 py-1 col-span-2"
                value={kg}
                min={32}
                max={275}
                onChange={(e) => setKg(clamp(Number(e.target.value), 32, 275))}
                placeholder="kg"
                title="Weight (kg)"
              />
            )}
          </div>
          <div className="flex items-center justify-between gap-2">
            <button onClick={handleEstimate} className={`${btnBase} w-full`}>
              Estimate Calories
            </button>
            <button
              onClick={() => setUnit(unit === "us" ? "metric" : "us")}
              className={`${btnBase} w-36`}
              title="Toggle Units"
            >
              {unit === "us" ? "US (ft/in/lb)" : "Metric (cm/kg)"}
            </button>
          </div>
        </div>
      </div>

      {/* Protein targeting by bodyweight */}
      <div className="mb-6 p-4 bg-white rounded-2xl border">
        <div className="flex items-center justify-between mb-2">
          <div className="font-semibold">Protein Targeting</div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={useProteinByWeight}
              onChange={(e) => setUseProteinByWeight(e.target.checked)}
            />
            <span>Use body-weight formula</span>
          </label>
        </div>
        {useProteinByWeight ? (
          <div className="grid md:grid-cols-3 gap-3">
            {unit === "us" ? (
              <div className="p-3 border rounded-xl">
                <div className="text-sm mb-1">g protein per lb (0.6–1.2)</div>
                <input
                  type="range"
                  min={0.6}
                  max={1.2}
                  step={0.05}
                  value={proteinPerLb}
                  onChange={(e) => setProteinPerLb(Number(e.target.value))}
                  className="w-full accent-indigo-600"
                />
                <div className="text-sm mt-1">{proteinPerLb.toFixed(2)} g/lb</div>
                <div className="text-xs text-slate-600 mt-1">
                  Tip: 0.8–1.0 g/lb covers most strength & fat-loss goals.
                </div>
              </div>
            ) : (
              <div className="p-3 border rounded-xl">
                <div className="text-sm mb-1">g protein per kg (1.2–2.6)</div>
                <input
                  type="range"
                  min={1.2}
                  max={2.6}
                  step={0.1}
                  value={proteinPerKg}
                  onChange={(e) => setProteinPerKg(Number(e.target.value))}
                  className="w-full accent-indigo-600"
                />
                <div className="text-sm mt-1">{proteinPerKg.toFixed(1)} g/kg</div>
                <div className="text-xs text-slate-600 mt-1">
                  Tip: ~1.8–2.2 g/kg common for recomp/defense readiness.
                </div>
              </div>
            )}
            <div className="md:col-span-2 p-3 border rounded-xl">
              <div className="text-sm">
                We’ll calculate protein grams from your body weight, then auto-fit fat & carbs to keep 100% total.
              </div>
              <div className="text-xs text-slate-600 mt-2">
                Your current protein % will update dynamically as calories or weight change.
              </div>
            </div>
          </div>
        ) : (
          <div className="text-sm text-slate-700">
            Using direct macro percentages below (protein slider).
          </div>
        )}
      </div>

      {/* Macro sliders */}
      <div className="mb-4 p-4 bg-white rounded-2xl border">
        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <MacroRow
              label="Protein"
              pct={computed.pct.protein}
              grams={computed.grams.protein}
              perMeal={computed.perMeal.protein}
              onChange={(v) => handleMacroChange("protein", v)}
            />
            <MacroRow
              label="Fat"
              pct={computed.pct.fat}
              grams={computed.grams.fat}
              perMeal={computed.perMeal.fat}
              onChange={(v) => handleMacroChange("fat", v)}
            />
            <MacroRow
              label="Carbs"
              pct={computed.pct.carbs}
              grams={computed.grams.carbs}
              perMeal={computed.perMeal.carbs}
              onChange={(v) => handleMacroChange("carbs", v)}
            />
          </div>
          <div className="p-4 border rounded-2xl bg-slate-50">
            <div className="font-semibold mb-2">Summary</div>
            <ul className="text-sm space-y-1">
              <li>
                Calories: <span className="font-semibold">{computed.calories}</span> kcal
              </li>
              <li>
                Protein: <span className="font-semibold">{round1(computed.pct.protein)}%</span> &nbsp;|&nbsp;{" "}
                <span className="font-semibold">{round0(computed.grams.protein)}g</span> / day &nbsp;|&nbsp;{" "}
                {round0(computed.perMeal.protein)} g/meal
              </li>
              <li>
                Fat: <span className="font-semibold">{round1(computed.pct.fat)}%</span> &nbsp;|&nbsp;{" "}
                <span className="font-semibold">{round0(computed.grams.fat)}g</span> / day &nbsp;|&nbsp;{" "}
                {round0(computed.perMeal.fat)} g/meal
              </li>
              <li>
                Carbs: <span className="font-semibold">{round1(computed.pct.carbs)}%</span> &nbsp;|&nbsp;{" "}
                <span className="font-semibold">{round0(computed.grams.carbs)}g</span> / day &nbsp;|&nbsp;{" "}
                {round0(computed.perMeal.carbs)} g/meal
              </li>
            </ul>
            <div className="mt-3 text-xs text-slate-600">
              Need recipe ideas? After applying, use “Suggest from Meal Plan” to auto-match recipes to your targets.
            </div>
          </div>
        </div>
      </div>

      {/* Cross-module CTAs */}
      <div className="flex flex-wrap gap-2">
        <button onClick={handleApply} className={`${btnBase} bg-indigo-600 text-white border-indigo-700`}>
          Apply to Meal Planner
        </button>
        <a href="/tier2/household/meals" className={`${btnBase}`}>
          Open Meals Dashboard
        </a>
        <a href="/fitness/programs" className={`${btnBase}`}>
          Workout Programs
        </a>
      </div>
    </div>
  );
}

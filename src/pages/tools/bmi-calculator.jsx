import React, { useMemo, useState, useRef, useEffect } from "react";

/* ---------- Shared pop UI (no special unicode escapes) ---------- */
const btnBase =
  "inline-flex items-center justify-center rounded-xl border bg-white px-4 py-2 font-medium shadow-[0_6px_0_rgba(0,0,0,0.2),0_1px_4px_rgba(0,0,0,0.15)] active:translate-y-[4px] active:shadow-[0_2px_0_rgba(0,0,0,0.25),0_1px_2px_rgba(0,0,0,0.25)] transition-all";
const card =
  "rounded-3xl p-4 bg-gradient-to-b from-slate-50 to-slate-200 border border-slate-300 shadow-[0_10px_0_rgba(0,0,0,0.15),0_2px_8px_rgba(0,0,0,0.15)]";
const cardSoft =
  "rounded-3xl p-4 bg-gradient-to-b from-white to-slate-50 border border-slate-200 shadow-[0_8px_0_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.12)]";

function Input({ className = "", ...props }) {
  return (
    <input
      className={`h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm outline-none focus:ring-2 focus:ring-indigo-400 ${className}`}
      {...props}
    />
  );
}
function SmallInput({ className = "", ...props }) {
  return (
    <input
      className={`h-8 rounded-xl border border-slate-300 bg-white px-2 text-sm outline-none focus:ring-2 focus:ring-indigo-400 ${className}`}
      {...props}
    />
  );
}
function KeyBtn({ children, onClick, className = "", title, disabled }) {
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={`${btnBase} ${
        disabled ? "opacity-60 cursor-not-allowed" : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

/* --------------------------- BMI utilities --------------------------- */
const clampNum = (n) => (Number.isFinite(+n) ? +n : 0);
const round1 = (n) => Math.round(n * 10) / 10;

function toKg(lb) {
  return clampNum(lb) * 0.45359237;
}
function toLb(kg) {
  return clampNum(kg) / 0.45359237;
}
function cmToM(cm) {
  return clampNum(cm) / 100;
}
function ftInToM(ft, inch) {
  return (clampNum(ft) * 12 + clampNum(inch)) * 0.0254;
}

function bmiCategory(bmi) {
  if (!Number.isFinite(bmi) || bmi <= 0) return null;
  if (bmi < 18.5)
    return {
      key: "underweight",
      label: "Underweight",
      color: "text-amber-700",
    };
  if (bmi < 25)
    return { key: "normal", label: "Normal", color: "text-emerald-700" };
  if (bmi < 30)
    return { key: "overweight", label: "Overweight", color: "text-orange-700" };
  return { key: "obese", label: "Obesity", color: "text-rose-700" };
}

function healthyWeightRangeForHeightM(heightM) {
  if (!heightM) return null;
  const lo = 18.5 * heightM * heightM;
  const hi = 24.9 * heightM * heightM;
  return { kg: { lo, hi }, lb: { lo: toLb(lo), hi: toLb(hi) } };
}

function macrosSuggestion(bmi, catKey) {
  if (!bmi || !catKey)
    return {
      title: "Plan your nutrition",
      body: "Dial in a daily macro target to support your health goals.",
      button: "Open Macro Calculator",
    };
  switch (catKey) {
    case "underweight":
      return {
        title: "Build up thoughtfully",
        body: "A small calorie surplus with solid protein can help. Use the Macro Calculator to set targets.",
        button: "Plan Surplus in Macro Calculator",
      };
    case "normal":
      return {
        title: "Maintain smartly",
        body: "Keep protein adequate and balance carbs/fats around your activity. Set your macros to maintain.",
        button: "Maintain with Macro Calculator",
      };
    case "overweight":
      return {
        title: "Cut with control",
        body: "A modest deficit with higher protein preserves muscle. Use the Macro Calculator to set a plan.",
        button: "Set Deficit in Macro Calculator",
      };
    case "obese":
      return {
        title: "Start strong, stay safe",
        body: "Structured nutrition helps. Set a sustainable macro plan—then track meals in your Macro tool.",
        button: "Start Macro Plan",
      };
    default:
      return {
        title: "Plan your nutrition",
        body: "Use the Macro Calculator to set daily targets.",
        button: "Open Macro Calculator",
      };
  }
}

/* ------------------------- The BMI Calculator ------------------------- */
export default function BMICalculatorPage({
  macrosRoute = "/nutrition",
  workoutsRoute = "/fitness/programs",
  onOpenMacros,
  onOpenWorkouts,
}) {
  // US by default
  const [unit, setUnit] = useState("us"); // 'us' | 'metric'
  const lastUnitRef = useRef("us");

  // Metric fields (kept for toggle conversion)
  const [cm, setCm] = useState(170);
  const [kg, setKg] = useState(70);
  // US fields (defaults shown first)
  const [ft, setFt] = useState(5);
  const [inch, setInch] = useState(8);
  const [lb, setLb] = useState(154);

  // Convert values when switching unit so the numbers represent the same body
  useEffect(() => {
    const prev = lastUnitRef.current;
    if (prev === unit) return;

    if (unit === "metric") {
      // from US to metric
      const m = ftInToM(ft, inch);
      setCm(Math.round(m * 100));
      setKg(Math.round(toKg(lb) * 10) / 10);
    } else {
      // from metric to US
      const m = cmToM(cm);
      const totalIn = m / 0.0254;
      const newFt = Math.floor(totalIn / 12);
      const newIn = Math.round(totalIn - newFt * 12);
      setFt(newFt);
      setInch(newIn);
      setLb(Math.round(toLb(kg)));
    }
    lastUnitRef.current = unit;
  }, [unit, cm, kg, ft, inch, lb]);

  const heightM = useMemo(
    () => (unit === "metric" ? cmToM(cm) : ftInToM(ft, inch)),
    [unit, cm, ft, inch]
  );
  const weightKg = useMemo(
    () => (unit === "metric" ? clampNum(kg) : toKg(lb)),
    [unit, kg, lb]
  );

  const bmi = useMemo(
    () => (heightM && weightKg ? weightKg / (heightM * heightM) : 0),
    [heightM, weightKg]
  );
  const cat = bmiCategory(bmi);
  const range = healthyWeightRangeForHeightM(heightM);
  const suggestion = macrosSuggestion(bmi, cat?.key);

  function goMacros() {
    const ctx = {
      bmi: round1(bmi),
      category: cat?.key || null,
      unit,
      heightM,
      weightKg,
      source: "bmi-page",
    };
    if (typeof onOpenMacros === "function") return onOpenMacros(ctx);
    try {
      window.dispatchEvent(
        new CustomEvent("suka:navigate", {
          detail: { route: macrosRoute, context: ctx },
        })
      );
    } catch {}
    const params = new URLSearchParams({
      bmi: String(round1(bmi)),
      category: String(cat?.key || ""),
    });
    try {
      window.location.href = `${macrosRoute}?${params.toString()}`;
    } catch {}
  }

  function goWorkouts() {
    const ctx = {
      bmi: round1(bmi) || null,
      category: cat?.key || null,
      unit,
      heightM,
      weightKg,
      source: "bmi-page",
    };
    if (typeof onOpenWorkouts === "function") return onOpenWorkouts(ctx);
    try {
      window.dispatchEvent(
        new CustomEvent("suka:navigate", {
          detail: { route: workoutsRoute, context: ctx },
        })
      );
    } catch {}
    try {
      window.location.href = workoutsRoute;
    } catch {}
  }

  const reset = () => {
    setUnit("us");
    setFt(5);
    setInch(8);
    setLb(154);
    setCm(170);
    setKg(70);
  };

  const disableCalc = !heightM || !weightKg;

  return (
    <div className="space-y-6 p-4 max-w-3xl mx-auto">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">BMI Calculator</h1>
        <div className="flex gap-2">
          <button
            className={`${btnBase} ${
              unit === "us" ? "ring-2 ring-indigo-400" : ""
            }`}
            onClick={() => setUnit("us")}
          >
            US
          </button>
          <button
            className={`${btnBase} ${
              unit === "metric" ? "ring-2 ring-indigo-400" : ""
            }`}
            onClick={() => setUnit("metric")}
          >
            Metric
          </button>
          <KeyBtn onClick={reset}>Reset</KeyBtn>
        </div>
      </header>

      {/* Inputs */}
      <section className={card}>
        <div className="font-semibold mb-2">Your measurements</div>

        {unit === "metric" ? (
          <>
            <div className="grid grid-cols-[max-content_14rem_8rem_auto] items-center gap-2 py-1">
              <label className="w-36 text-sm text-slate-700 text-right pr-3">
                Height
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                value={cm}
                onChange={(e) => setCm(+e.target.value)}
              />
              <div className="text-sm text-slate-600">cm</div>
              <div className="flex gap-2">
                <KeyBtn onClick={() => setCm((v) => v + 1)}>+1</KeyBtn>
                <KeyBtn onClick={() => setCm((v) => Math.max(0, v - 1))}>
                  -1
                </KeyBtn>
              </div>
            </div>

            <div className="grid grid-cols-[max-content_14rem_8rem_auto] items-center gap-2 py-1">
              <label className="w-36 text-sm text-slate-700 text-right pr-3">
                Weight
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                value={kg}
                onChange={(e) => setKg(+e.target.value)}
              />
              <div className="text-sm text-slate-600">kg</div>
              <div className="flex gap-2">
                <KeyBtn onClick={() => setKg((v) => v + 1)}>+1</KeyBtn>
                <KeyBtn onClick={() => setKg((v) => Math.max(0, v - 1))}>
                  -1
                </KeyBtn>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-[max-content_14rem_8rem_auto] items-center gap-2 py-1">
              <label className="w-36 text-sm text-slate-700 text-right pr-3">
                Height
              </label>
              <div className="flex gap-2">
                <SmallInput
                  type="number"
                  inputMode="numeric"
                  value={ft}
                  onChange={(e) => setFt(+e.target.value)}
                  className="w-16"
                />
                <span className="self-center text-sm text-slate-600">ft</span>
                <SmallInput
                  type="number"
                  inputMode="numeric"
                  value={inch}
                  onChange={(e) => setInch(+e.target.value)}
                  className="w-16"
                />
                <span className="self-center text-sm text-slate-600">in</span>
              </div>
              <div className="text-sm text-slate-600">ft + in</div>
              <div className="flex gap-2">
                <KeyBtn
                  onClick={() => {
                    setInch((v) => {
                      const ni = v + 1;
                      if (ni >= 12) {
                        setFt((f) => f + 1);
                        return 0;
                      }
                      return ni;
                    });
                  }}
                >
                  +1 in
                </KeyBtn>
                <KeyBtn
                  onClick={() => {
                    setInch((v) => {
                      if (v > 0) return v - 1;
                      setFt((f) => Math.max(0, f - 1));
                      return 11;
                    });
                  }}
                >
                  -1 in
                </KeyBtn>
              </div>
            </div>

            <div className="grid grid-cols-[max-content_14rem_8rem_auto] items-center gap-2 py-1">
              <label className="w-36 text-sm text-slate-700 text-right pr-3">
                Weight
              </label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.1"
                value={lb}
                onChange={(e) => setLb(+e.target.value)}
              />
              <div className="text-sm text-slate-600">lb</div>
              <div className="flex gap-2">
                <KeyBtn onClick={() => setLb((v) => v + 1)}>+1</KeyBtn>
                <KeyBtn onClick={() => setLb((v) => Math.max(0, v - 1))}>
                  -1
                </KeyBtn>
              </div>
            </div>
          </>
        )}
      </section>

      {/* Result */}
      <section className={cardSoft}>
        <div className="font-semibold mb-2">Your BMI</div>
        {!heightM || !weightKg ? (
          <div className="text-sm text-slate-500">
            Enter your height and weight to see your BMI.
          </div>
        ) : (
          <>
            <div className="text-3xl font-bold">
              {round1(bmi)}{" "}
              <span className="ml-2 text-base font-medium text-slate-500">
                {unit === "metric" ? "(kg/m²)" : "(lb/in²)"}
              </span>
            </div>
            {cat && (
              <div className={`mt-1 text-sm font-semibold ${cat.color}`}>
                Category: {cat.label}
              </div>
            )}
            {range && (
              <div className="mt-2 text-sm text-slate-700">
                Healthy weight range for your height:{" "}
                {unit === "metric" ? (
                  <span className="font-semibold">
                    {round1(range.kg.lo)}–{round1(range.kg.hi)} kg
                  </span>
                ) : (
                  <span className="font-semibold">
                    {round1(range.lb.lo)}–{round1(range.lb.hi)} lb
                  </span>
                )}
              </div>
            )}
            <div className="mt-3 text-xs text-slate-500">
              Note: BMI is a population metric—less accurate for athletes, older
              adults, and people with high lean mass. It isn't a diagnosis. If
              you have a medical condition, talk to a clinician before changing
              diet or training.
            </div>
          </>
        )}
      </section>

      {/* Suggest Macro Calculator + Workouts */}
      <section className={card}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="text-lg font-semibold">{suggestion.title}</div>
            <div className="text-sm text-slate-700">{suggestion.body}</div>
            <div className="text-xs text-slate-500">
              Browse or build your own free workout programs.
            </div>
          </div>
          <div className="flex gap-2">
            <KeyBtn
              onClick={goMacros}
              disabled={disableCalc}
              className="text-base text-slate-900"
            >
              {suggestion.button}
            </KeyBtn>
            <KeyBtn onClick={goWorkouts} className="text-base text-slate-900">
              Workout Programs
            </KeyBtn>
          </div>
        </div>
      </section>
    </div>
  );
}

// Dev-only sanity checks for utilities (no test runner needed)
try {
  const h = ftInToM(5, 8); // ~1.7272m
  const w = toKg(154); // ~69.9kg
  const calcBmi = w / (h * h);
  if (Math.abs(calcBmi - 23.4) > 0.5) {
    console.warn("BMI self-check drift:", calcBmi);
  }
} catch {}

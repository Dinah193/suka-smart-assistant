// C:\Users\larho\suka-smart-assistant\src\pages\calculators\health\bmi.jsx

/**
 * BMI Calculator Route
 *
 * How this fits:
 * - Hosts the BMI calculator UI and a “Next Steps” panel that turns BMI
 *   insight into concrete household actions:
 *   • stability flows (daily rhythm + weight goals),
 *   • movement/training sessions (martial arts / walks),
 *   • nutrition & storehouse planning.
 * - Uses the shared calculatorRunner so all runs are tracked and can feed
 *   the Planning Graph and SessionRunner automation.
 * - Emits events via the global eventBus so other services can:
 *   • generate sessions (cooking, training, etc.),
 *   • suggest planning flows,
 *   • export to the Hub when familyFundMode is enabled.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
// BMI view component (create if not present yet)
import BMICalculatorView from "@/features/calculators/health/BMICalculator.view";

const CALCULATOR_ID = "bmi-basic";

/**
 * @typedef {Object} BmiResult
 * @property {number} bmi
 * @property {string} category - e.g. "underweight"|"normal"|"overweight"|"obese"
 * @property {{ min: number, max: number } | null} [idealWeightRange]
 * @property {number} [heightCm]
 * @property {number} [weightKg]
 * @property {Object<string, any>} [meta]
 */

function BmiNextStepsPanel({ result, loadingNext, onRequestSession }) {
  const navigate = useNavigate();
  const hasResult = !!result;

  /** @type {{ title: string, desc: string, cta: string, onClick: () => void, id?: string, disabled?: boolean }[]} */
  const actions = useMemo(() => {
    if (!hasResult) {
      return [
        {
          title: "Start with your BMI",
          desc: "Enter height and weight on the left to see your BMI and general category. Once you have a result, tailored next steps will appear here.",
          cta: "Calculate first",
          onClick: () => {
            const el = document.querySelector("#bmi-calculator-root");
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          },
          disabled: false,
        },
      ];
    }

    return [
      {
        id: "stability-daily-rhythm",
        title: "Create a Stable Daily Rhythm",
        desc: "Use your BMI category to design a gentle daily rhythm that supports long-term health: meals, movement, and sleep routines.",
        cta: "Open Stability Dashboard",
        onClick: () => {
          emitBmiNextStepSelected("stability-daily-rhythm", result);
          navigate("/stability");
        },
      },
      {
        id: "movement-session",
        title: "Plan a Movement / Training Session",
        desc: "Turn BMI insights into a practical movement plan: walks, martial arts blocks, household tasks that safely raise heart rate.",
        cta: "Start a Movement Session",
        onClick: () => {
          emitBmiNextStepSelected("movement-session", result);
          if (typeof onRequestSession === "function") {
            onRequestSession(result);
          }
        },
      },
      {
        id: "nutrition-alignment",
        title: "Align Nutrition & Storehouse with Goals",
        desc: "Use BMI and target range to nudge meal planning, macro calculators, and storehouse goals in the right direction.",
        cta: "Open Nutrition Tools",
        onClick: () => {
          emitBmiNextStepSelected("nutrition-alignment", result);
          // Adjust routes as needed once all tools are wired
          navigate("/calculators/health/macros");
        },
      },
    ];
  }, [hasResult, navigate, onRequestSession, result]);

  return (
    <aside className="w-full lg:w-80 xl:w-96 flex-shrink-0">
      <div className="bg-slate-900/60 border border-slate-700 rounded-2xl shadow-lg p-4 lg:p-5 flex flex-col h-full">
        <header className="mb-3">
          <h2 className="text-lg font-semibold text-slate-50">
            Next Steps
          </h2>
          <p className="text-xs text-slate-400 mt-1">
            SSA can turn your BMI result into stability flows, movement
            sessions, and gentle nutrition adjustments that fit your household.
          </p>
        </header>

        {loadingNext && (
          <div className="flex items-center gap-2 text-xs text-slate-300 mb-3">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Preparing suggestions…
          </div>
        )}

        <div className="space-y-3 overflow-y-auto pr-1">
          {actions.map((action, idx) => (
            <button
              key={action.id || idx}
              type="button"
              onClick={action.onClick}
              disabled={action.disabled || loadingNext}
              className={[
                "w-full text-left rounded-xl border border-slate-700/70",
                "bg-slate-800/60 hover:bg-slate-800 focus:outline-none",
                "focus-visible:ring-2 focus-visible:ring-emerald-400/70",
                "transition-all px-3 py-3 flex flex-col gap-1",
                (action.disabled || loadingNext) ? "opacity-70 cursor-not-allowed" : "cursor-pointer",
              ].join(" ")}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-50">
                  {action.title}
                </span>
                <span className="text-[10px] uppercase tracking-wide text-emerald-300/90">
                  {action.cta}
                </span>
              </div>
              <p className="text-xs text-slate-400 leading-snug">
                {action.desc}
              </p>
            </button>
          ))}
        </div>

        {hasResult && (
          <footer className="mt-4 border-t border-slate-800 pt-3">
            <p className="text-[10px] text-slate-500 leading-snug">
              Tip: Any next step can trigger sessions and flows the SessionRunner
              will guide you through with timers, cues, and notifications.
            </p>
          </footer>
        )}
      </div>
    </aside>
  );
}

/**
 * Emit an event when the user selects a BMI next-step action.
 *
 * @param {string} actionId
 * @param {BmiResult} result
 */
function emitBmiNextStepSelected(actionId, result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.bmi.nextStep.selected",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.bmi",
      data: {
        calculatorId: CALCULATOR_ID,
        actionId,
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[bmi.jsx] Failed to emit calculator.bmi.nextStep.selected",
      err
    );
  }
}

/**
 * Request a runnable session from automation/SessionRunner based on BMI.
 *
 * This only emits a request event; the actual SessionRunner modal is managed
 * at the app root, which will:
 *  - Construct a Session object from this payload,
 *  - persist to Dexie,
 *  - open the SessionRunner modal.
 *
 * @param {BmiResult} result
 */
function requestBmiSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.bmi.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.bmi",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "health", // conceptual; Session builder can map this to movement/meal sessions
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[bmi.jsx] Failed to emit calculator.bmi.session.requested",
      err
    );
  }
}

/**
 * Mobile-friendly “Use in Session Now” button that reuses the same
 * session.requested event wiring as the Next Steps panel.
 */
function BmiNowButton({ result, onRequestSession }) {
  if (!result) return null;

  return (
    <div className="lg:hidden mt-3">
      <button
        type="button"
        onClick={() => onRequestSession && onRequestSession(result)}
        className="inline-flex items-center justify-center w-full rounded-xl px-4 py-2.5 text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/30 transition"
      >
        Use This BMI in a Session Now
      </button>
    </div>
  );
}

/**
 * Route component: BMI Calculator + Next Steps.
 */
export default function BmiCalculatorPage() {
  /** @type {[BmiResult|null, React.Dispatch<React.SetStateAction<BmiResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "BMI Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handle calculator submission from the BMI view.
   *
   * @param {Object} input - Input payload from BMICalculatorView.
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.health.bmi",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error("BMI calculator did not return a result object.");
      }

      /** @type {BmiResult} */
      const normalized = {
        bmi: Number(calcResult.bmi || 0),
        category: calcResult.category || "unknown",
        idealWeightRange: calcResult.idealWeightRange || null,
        heightCm: calcResult.heightCm,
        weightKg: calcResult.weightKg,
        meta: calcResult.meta || {},
      };

      setResult(normalized);

      // Micro feedback for the Next Steps panel
      setLoadingNext(true);
      setTimeout(() => setLoadingNext(false), 350);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[bmi.jsx] BMI calculator error", err);
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the BMI calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleRequestSession = useCallback((bmiResult) => {
    if (!bmiResult) return;
    requestBmiSession(bmiResult);
  }, []);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Body Mass Index (BMI) Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Calculate your BMI and category, then let SSA turn that insight
              into gentle, sustainable changes through stability flows,
              movement sessions, and nutrition planning.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Connected to Planning Graph
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-cyan-400" />
              SessionRunner Ready
            </span>
          </div>
        </header>

        {/* Main layout */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <main
            id="bmi-calculator-root"
            className="flex-1 w-full bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6"
          >
            <BMICalculatorView
              calculatorId={CALCULATOR_ID}
              onCalculate={handleCalculate}
              isRunning={isRunning}
              lastResult={result}
            />

            {error && (
              <div className="mt-4 rounded-xl border border-red-500/60 bg-red-950/60 px-3 py-2 text-xs text-red-100">
                {error}
              </div>
            )}

            {result && !error && (
              <section className="mt-4 rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-3">
                <h2 className="text-sm font-semibold text-slate-100 mb-2">
                  Snapshot
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">BMI</span>
                    <span className="text-slate-50 font-semibold">
                      {result.bmi.toFixed(1)}
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">Category</span>
                    <span className="text-slate-50 font-semibold capitalize">
                      {result.category}
                    </span>
                  </div>
                  {result.idealWeightRange && (
                    <div className="flex flex-col">
                      <span className="text-slate-400 mb-0.5">
                        Target Weight Range
                      </span>
                      <span className="text-slate-50 font-semibold">
                        {Math.round(result.idealWeightRange.min)} –{" "}
                        {Math.round(result.idealWeightRange.max)} kg
                      </span>
                    </div>
                  )}
                </div>
              </section>
            )}

            <BmiNowButton
              result={result}
              onRequestSession={handleRequestSession}
            />
          </main>

          {/* Right-side: Next Steps */}
          <BmiSidebarWrapper>
            <BmiNextStepsPanel
              result={result}
              loadingNext={loadingNext}
              onRequestSession={handleRequestSession}
            />
          </BmiSidebarWrapper>
        </div>
      </div>
    </div>
  );
}

/**
 * Wrapper kept separate for future layout tweaks (if you decide to add
 * stability widgets, hints, etc., around the BMI Next Steps panel).
 */
function BmiSidebarWrapper({ children }) {
  return children;
}

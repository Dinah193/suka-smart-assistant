// C:\Users\larho\suka-smart-assistant\src\pages\calculators\health\micronutrients.jsx

/**
 * Micronutrient Calculator Route
 *
 * How this fits:
 * - Hosts the MicronutrientCalculator UI and a “Next Steps” panel that
 *   converts micronutrient insight into concrete household actions:
 *   • storehouse alignment (what to stock more of),
 *   • meal planning nudges (what recipes to prioritize),
 *   • garden plans (what to grow for specific deficiencies),
 *   • preservation projects (canning/drying key foods).
 * - Uses the shared calculatorRunner so all runs are tracked and can feed
 *   the Planning Graph and SessionRunner automation.
 * - Emits events via the global eventBus so other services can:
 *   • generate sessions (cooking, preservation, garden tasks),
 *   • suggest planning flows,
 *   • export to the Hub when familyFundMode is enabled.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
// Micronutrient view component (create if not present yet)
import MicronutrientCalculatorView from "@/features/calculators/health/MicronutrientCalculator.view";

const CALCULATOR_ID = "micronutrients-daily";

/**
 * @typedef {Object} MicronutrientGap
 * @property {string} id             - e.g. "iron", "vitaminD"
 * @property {string} name           - Human readable label.
 * @property {"low"|"borderline"|"ok"|"high"} status
 * @property {number} current        - current intake (e.g. mg/day)
 * @property {number} target        - target intake (e.g. mg/day)
 * @property {string[]} [foodHints]  - example foods that help.
 */

/**
 * @typedef {Object} MicronutrientResult
 * @property {number} coverageScore         - 0–100 overall coverage percentage
 * @property {MicronutrientGap[]} gaps      - list of nutrients with low/borderline
 * @property {Object<string, any>} [meta]   - any extra details from calculator
 */

function MicronutrientNextStepsPanel({ result, loadingNext, onRequestSession }) {
  const navigate = useNavigate();
  const hasResult = !!result;

  /** @type {{ id?: string, title: string, desc: string, cta: string, onClick: () => void, disabled?: boolean }[]} */
  const actions = useMemo(() => {
    if (!hasResult) {
      return [
        {
          title: "Start with your daily micronutrients",
          desc: "Enter what you currently eat, and SSA will estimate your micronutrient coverage. Once you have a result, targeted suggestions will appear here.",
          cta: "Calculate first",
          onClick: () => {
            const el = document.querySelector("#micronutrients-calculator-root");
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
        id: "storehouse-alignment",
        title: "Align Storehouse with Micronutrient Gaps",
        desc: "Turn low or borderline nutrients into smart storehouse goals so staple foods quietly cover more of your needs.",
        cta: "Open Storehouse Planning",
        onClick: () => {
          emitMicronutrientNextStepSelected("storehouse-alignment", result);
          navigate("/tier2/household/storehouse"); // adjust path to your actual route
        },
      },
      {
        id: "meal-planning-nudges",
        title: "Update Meal Plans Around Key Nutrients",
        desc: "Nudge weekly meals toward dishes rich in iron, vitamin D, magnesium, and other flagged nutrients at the household level.",
        cta: "Open Meal Planner",
        onClick: () => {
          emitMicronutrientNextStepSelected("meal-planning-nudges", result);
          navigate("/tier2/household/meals"); // adjust as needed
        },
      },
      {
        id: "garden-and-preservation",
        title: "Grow & Preserve Your Missing Nutrients",
        desc: "Map low nutrients to crops and preservation projects so your garden and pantry slowly close the gaps.",
        cta: "Plan Garden & Batches",
        onClick: () => {
          emitMicronutrientNextStepSelected("garden-and-preservation", result);
          navigate("/tier2/household/garden"); // or a dedicated planner page
        },
      },
      {
        id: "micronutrient-session",
        title: "Turn Micronutrient Gaps into a Session",
        desc: "Generate a short “micronutrient focus” session that walks you through picking recipes, updating lists, and scheduling tasks.",
        cta: "Start a Focus Session",
        onClick: () => {
          emitMicronutrientNextStepSelected("micronutrient-session", result);
          if (typeof onRequestSession === "function") {
            onRequestSession(result);
          }
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
            SSA uses your micronutrient coverage to steer storehouse goals,
            meal plans, garden choices, and even preservation batches—without
            overwhelming you.
          </p>
        </header>

        {loadingNext && (
          <div className="flex items-center gap-2 text-xs text-slate-300 mb-3">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Preparing nutrient-aware suggestions…
          </div>
        )}

        <div className="space-y-3 overflow-y-auto pr-1">
          {actions.map((action) => (
            <button
              key={action.id || action.title}
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
              Tip: Micronutrient-aware sessions can be mixed with batch cooking,
              garden tasks, and storehouse updates in the SessionRunner, so you
              improve health while doing things you already planned to do.
            </p>
          </footer>
        )}
      </div>
    </aside>
  );
}

/**
 * Emit an event when the user selects a micronutrient next-step action.
 *
 * @param {string} actionId
 * @param {MicronutrientResult} result
 */
function emitMicronutrientNextStepSelected(actionId, result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.micronutrients.nextStep.selected",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.micronutrients",
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
      "[micronutrients.jsx] Failed to emit calculator.micronutrients.nextStep.selected",
      err
    );
  }
}

/**
 * Request a runnable session from automation/SessionRunner based on
 * micronutrient insight.
 *
 * This only emits a request event; the actual SessionRunner modal is managed
 * at the app root, which will:
 *  - Construct a Session object from this payload,
 *  - persist to Dexie,
 *  - open the SessionRunner modal.
 *
 * @param {MicronutrientResult} result
 */
function requestMicronutrientSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.micronutrients.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.micronutrients",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "storehouse", // Planning engine can branch into cooking/garden/preservation
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[micronutrients.jsx] Failed to emit calculator.micronutrients.session.requested",
      err
    );
  }
}

/**
 * Mobile-friendly “Use in Session Now” button mirroring the Next Steps
 * session action for smaller screens.
 */
function MicronutrientsNowButton({ result, onRequestSession }) {
  if (!result) return null;

  return (
    <div className="lg:hidden mt-3">
      <button
        type="button"
        onClick={() => onRequestSession && onRequestSession(result)}
        className="inline-flex items-center justify-center w-full rounded-xl px-4 py-2.5 text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/30 transition"
      >
        Use These Micronutrients in a Session Now
      </button>
    </div>
  );
}

/**
 * Route component: Micronutrient Calculator + Next Steps.
 */
export default function MicronutrientCalculatorPage() {
  /** @type {[MicronutrientResult|null, React.Dispatch<React.SetStateAction<MicronutrientResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Micronutrient Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handle calculator submission from the Micronutrient view.
   *
   * @param {Object} input - Input payload from MicronutrientCalculatorView.
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(
        CALCULATOR_ID,
        input,
        {
          source: "pages.calculators.health.micronutrients",
          emitEvents: true,
        }
      );

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Micronutrient calculator did not return a result object."
        );
      }

      /** @type {MicronutrientResult} */
      const normalized = {
        coverageScore: Number(calcResult.coverageScore || 0),
        gaps: Array.isArray(calcResult.gaps) ? calcResult.gaps : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);

      setLoadingNext(true);
      setTimeout(() => setLoadingNext(false), 350);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[micronutrients.jsx] Micronutrient calculator error", err);
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the micronutrient calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleRequestSession = useCallback((microsResult) => {
    if (!microsResult) return;
    requestMicronutrientSession(microsResult);
  }, []);

  const worstGapLabel = useMemo(() => {
    if (!result || !Array.isArray(result.gaps) || !result.gaps.length) {
      return null;
    }
    const lowish = result.gaps.filter(
      (g) => g.status === "low" || g.status === "borderline"
    );
    if (!lowish.length) return null;
    return lowish[0].name || lowish[0].id;
  }, [result]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Daily Micronutrient Coverage
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Estimate how well your current meals cover key vitamins and
              minerals, then let SSA gently steer storehouse, meal plans, and
              garden choices to close the gaps over time.
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
            id="micronutrients-calculator-root"
            className="flex-1 w-full bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6"
          >
            <MicronutrientCalculatorView
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
                  Coverage Snapshot
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">
                      Overall Coverage
                    </span>
                    <span className="text-slate-50 font-semibold">
                      {Math.round(result.coverageScore)}%
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">Gaps</span>
                    <span className="text-slate-50 font-semibold">
                      {Array.isArray(result.gaps) ? result.gaps.length : 0}
                    </span>
                  </div>
                  {worstGapLabel && (
                    <div className="flex flex-col">
                      <span className="text-slate-400 mb-0.5">
                        Top Priority Nutrient
                      </span>
                      <span className="text-slate-50 font-semibold">
                        {worstGapLabel}
                      </span>
                    </div>
                  )}
                </div>
                {Array.isArray(result.gaps) && result.gaps.length > 0 && (
                  <p className="mt-2 text-[11px] text-slate-400 leading-snug">
                    SSA will use this profile to suggest recipes, crops, and
                    storehouse items that quietly boost these nutrients without
                    forcing a full diet overhaul.
                  </p>
                )}
              </section>
            )}

            <MicronutrientsNowButton
              result={result}
              onRequestSession={handleRequestSession}
            />
          </main>

          {/* Right-side: Next Steps */}
          <MicronutrientSidebarWrapper>
            <MicronutrientNextStepsPanel
              result={result}
              loadingNext={loadingNext}
              onRequestSession={handleRequestSession}
            />
          </MicronutrientSidebarWrapper>
        </div>
      </div>
    </div>
  );
}

/**
 * Wrapper kept separate for future layout tweaks (if you decide to add
 * micronutrient “cards”, seasonal hints, or cross-links to other calculators).
 */
function MicronutrientSidebarWrapper({ children }) {
  return children;
}

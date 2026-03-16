// C:\Users\larho\suka-smart-assistant\src\pages\calculators\health\hair-protein.jsx

/**
 * Hair Protein Calculator Route
 *
 * How this fits:
 * - Hosts the HairProteinCalculator UI and a “Next Steps” panel that turns
 *   hair protein needs into concrete household actions:
 *   • protein-aware meal planning,
 *   • storehouse & price-book focus on key protein sources,
 *   • batch cooking sessions for high-protein staples,
 *   • optional hair-care routine sessions (washing/protective styling).
 * - Uses the shared calculatorRunner so all runs are tracked and can feed
 *   the Planning Graph and SessionRunner automation.
 * - Emits events via the global eventBus so other services can:
 *   • generate cooking / storehouse / hair-routine sessions,
 *   • suggest planning flows,
 *   • export to the Hub when familyFundMode is enabled.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import eventBus from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
// Hair protein view component (create if not present yet)
import HairProteinCalculatorView from "@/features/calculators/health/HairProteinCalculator.view.jsx";

const CALCULATOR_ID = "hair-protein-requirement";

/**
 * @typedef {Object} HairProteinResult
 * @property {number} dailyGramsTarget     - target grams of protein per day
 * @property {number} gapGrams             - how many grams short (can be negative if over)
 * @property {"low"|"borderline"|"ok"|"high"} status
 * @property {string[]} [foodHints]        - suggested protein sources
 * @property {Object<string, any>} [meta]  - any extra details from calculator
 */

function HairProteinNextStepsPanel({ result, loadingNext, onRequestSession }) {
  const navigate = useNavigate();
  const hasResult = !!result;

  /** @type {{ id?: string, title: string, desc: string, cta: string, onClick: () => void, disabled?: boolean }[]} */
  const actions = useMemo(() => {
    if (!hasResult) {
      return [
        {
          title: "Start with your hair protein needs",
          desc: "Tell SSA about your hair goals, shedding/breakage, and current meals so it can estimate how much protein your hair is actually getting.",
          cta: "Calculate first",
          onClick: () => {
            const el = document.querySelector("#hair-protein-calculator-root");
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
        id: "meal-planning-protein",
        title: "Align Meal Plans with Hair Protein Needs",
        desc: "Prioritize breakfasts, lunches, and dinners that quietly hit your hair-safe protein range without forcing a complete diet overhaul.",
        cta: "Open Meal Planner",
        onClick: () => {
          emitHairProteinNextStepSelected("meal-planning-protein", result);
          navigate("/tier2/household/meals"); // adjust path as needed
        },
      },
      {
        id: "storehouse-protein-focus",
        title: "Focus Storehouse on Protein Staples",
        desc: "Favor affordable protein sources in your storehouse goals so your hair gets what it needs even in tight seasons.",
        cta: "Open Storehouse Planning",
        onClick: () => {
          emitHairProteinNextStepSelected("storehouse-protein-focus", result);
          navigate("/tier2/household/storehouse"); // adjust as needed
        },
      },
      {
        id: "batch-cooking-protein",
        title: "Batch Cook Hair-Friendly Protein Staples",
        desc: "Create a batch cooking session for stews, soups, and meat/legume bases that keep protein on hand all week.",
        cta: "Plan a Batch Session",
        onClick: () => {
          emitHairProteinNextStepSelected("batch-cooking-protein", result);
          navigate("/tier2/household/meals"); // same planner; session engine will handle details
        },
      },
      {
        id: "hair-routine-session",
        title: "Pair Diet with a Hair-Care Routine",
        desc: "Generate a mini hair-care routine session (wash days, protective styles, low-manipulation days) that syncs with your nutrition plan.",
        cta: "Start a Hair Session",
        onClick: () => {
          emitHairProteinNextStepSelected("hair-routine-session", result);
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
          <h2 className="text-lg font-semibold text-slate-50">Next Steps</h2>
          <p className="text-xs text-slate-400 mt-1">
            SSA turns your hair protein estimate into calm nudges: how to eat,
            stock, and plan your week so your hair has what it needs to grow and
            recover from styling.
          </p>
        </header>

        {loadingNext && (
          <div className="flex items-center gap-2 text-xs text-slate-300 mb-3">
            <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
            Preparing hair-aware suggestions…
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
                action.disabled || loadingNext
                  ? "opacity-70 cursor-not-allowed"
                  : "cursor-pointer",
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
              Tip: Hair protein sessions can run inside the SessionRunner with
              cooking, shopping, and wash-day tasks all in one place—so you
              strengthen your hair while doing things you were going to do
              anyway.
            </p>
          </footer>
        )}
      </div>
    </aside>
  );
}

/**
 * Emit an event when the user selects a hair-protein next-step action.
 *
 * @param {string} actionId
 * @param {HairProteinResult} result
 */
function emitHairProteinNextStepSelected(actionId, result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.hairProtein.nextStep.selected",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.hair-protein",
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
      "[hair-protein.jsx] Failed to emit calculator.hairProtein.nextStep.selected",
      err
    );
  }
}

/**
 * Request a runnable session from automation/SessionRunner based on
 * hair-protein insight.
 *
 * This only emits a request event; the actual SessionRunner modal is managed
 * at the app root, which will:
 *  - Construct a Session object from this payload,
 *  - persist to Dexie,
 *  - open the SessionRunner modal.
 *
 * @param {HairProteinResult} result
 */
function requestHairProteinSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.hairProtein.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.hair-protein",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "storehouse", // planning runtime can mix in cooking and “self-care” domains
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[hair-protein.jsx] Failed to emit calculator.hairProtein.session.requested",
      err
    );
  }
}

/**
 * Mobile-friendly “Use in Session Now” button mirroring the Next Steps
 * session action for smaller screens.
 */
function HairProteinNowButton({ result, onRequestSession }) {
  if (!result) return null;

  return (
    <div className="lg:hidden mt-3">
      <button
        type="button"
        onClick={() => onRequestSession && onRequestSession(result)}
        className="inline-flex items-center justify-center w-full rounded-xl px-4 py-2.5 text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/30 transition"
      >
        Use This Hair Protein Plan in a Session Now
      </button>
    </div>
  );
}

/**
 * Route component: Hair Protein Calculator + Next Steps.
 */
export default function HairProteinCalculatorPage() {
  /** @type {[HairProteinResult|null, React.Dispatch<React.SetStateAction<HairProteinResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Hair Protein Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handle calculator submission from the HairProtein view.
   *
   * @param {Object} input - Input payload from HairProteinCalculatorView.
   */
  const handleCalculate = useCallback(async (input) => {
    setIsRunning(true);
    setError(null);

    try {
      const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
        source: "pages.calculators.health.hair-protein",
        emitEvents: true,
      });

      if (!calcResult || typeof calcResult !== "object") {
        throw new Error(
          "Hair protein calculator did not return a result object."
        );
      }

      /** @type {HairProteinResult} */
      const normalized = {
        dailyGramsTarget: Number(calcResult.dailyGramsTarget || 0),
        gapGrams: Number(calcResult.gapGrams || 0),
        status:
          calcResult.status === "low" ||
          calcResult.status === "borderline" ||
          calcResult.status === "ok" ||
          calcResult.status === "high"
            ? calcResult.status
            : "ok",
        foodHints: Array.isArray(calcResult.foodHints)
          ? calcResult.foodHints
          : [],
        meta: calcResult.meta || {},
      };

      setResult(normalized);

      setLoadingNext(true);
      setTimeout(() => setLoadingNext(false), 350);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[hair-protein.jsx] Hair protein calculator error", err);
      setError(
        err && err.message
          ? err.message
          : "There was a problem running the hair protein calculator."
      );
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleRequestSession = useCallback((hairResult) => {
    if (!hairResult) return;
    requestHairProteinSession(hairResult);
  }, []);

  const statusLabel = useMemo(() => {
    if (!result) return null;
    switch (result.status) {
      case "low":
        return "Low (Hair at Risk)";
      case "borderline":
        return "Borderline (Needs Attention)";
      case "ok":
        return "OK (Within Range)";
      case "high":
        return "High (Monitor Intake)";
      default:
        return null;
    }
  }, [result]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Hair Protein Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Estimate how much protein your hair actually needs based on your
              body, shedding/breakage patterns, and styling habits. SSA then
              ties that into your meals, storehouse, and batches—so your hair
              regimen is backed by what you eat.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-900/80 px-3 py-1 border border-slate-700">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Linked to Meal & Storehouse Planning
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
            id="hair-protein-calculator-root"
            className="flex-1 w-full bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6"
          >
            <HairProteinCalculatorView
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
                  Hair Protein Snapshot
                </h2>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">
                      Daily Protein Target
                    </span>
                    <span className="text-slate-50 font-semibold">
                      {Math.round(result.dailyGramsTarget)} g/day
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">Current Gap</span>
                    <span className="text-slate-50 font-semibold">
                      {result.gapGrams > 0
                        ? `+${Math.round(result.gapGrams)} g needed`
                        : result.gapGrams < 0
                        ? `${Math.round(result.gapGrams)} g above target`
                        : "On target"}
                    </span>
                  </div>
                  {statusLabel && (
                    <div className="flex flex-col">
                      <span className="text-slate-400 mb-0.5">Status</span>
                      <span className="text-slate-50 font-semibold">
                        {statusLabel}
                      </span>
                    </div>
                  )}
                </div>
                {Array.isArray(result.foodHints) &&
                  result.foodHints.length > 0 && (
                    <p className="mt-2 text-[11px] text-slate-400 leading-snug">
                      Suggested protein sources:{" "}
                      <span className="text-slate-200">
                        {result.foodHints.join(", ")}
                      </span>
                    </p>
                  )}
                <p className="mt-2 text-[11px] text-slate-400 leading-snug">
                  SSA will use this profile to prioritize recipes, storehouse
                  items, and batch sessions that support both your body and your
                  hair—so length and thickness are a by-product of how the whole
                  house eats.
                </p>
              </section>
            )}

            <HairProteinNowButton
              result={result}
              onRequestSession={handleRequestSession}
            />
          </main>

          {/* Right-side: Next Steps */}
          <HairProteinSidebarWrapper>
            <HairProteinNextStepsPanel
              result={result}
              loadingNext={loadingNext}
              onRequestSession={handleRequestSession}
            />
          </HairProteinSidebarWrapper>
        </div>
      </div>
    </div>
  );
}

/**
 * Wrapper kept separate for future layout tweaks (if you decide to add
 * hair-specific cards, seasonality hints, or cross-links to other calculators).
 */
function HairProteinSidebarWrapper({ children }) {
  return children;
}

// C:\Users\larho\suka-smart-assistant\src\pages\calculators\health\macros.jsx

/**
 * Macro Calculator Route
 *
 * How this fits:
 * - This route hosts the Daily Macro Requirement Calculator UI plus a
 *   “Next Steps” panel that nudges the user into concrete planning:
 *   storehouse goals, batch cooking, and stability flows.
 * - It uses the calculator shim/runner infrastructure so all calculator
 *   executions are tracked and can feed into the Planning Graph and
 *   SessionRunner automation.
 * - It emits events via the global eventBus so automation, analytics,
 *   and SessionRunner logic can respond (e.g., create sessions,
 *   suggest flows, export to Hub when familyFundMode is enabled).
 *
 * Notes:
 * - Calculator ID is "daily-macros" to match calculatorRegistry.
 * - This page does NOT directly manage the SessionRunner modal; it
 *   simply emits events and delegates “Now” execution to upstream
 *   automation/SessionRunner wiring at the app root.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { runCalculator } from "@/services/calculators/calculatorRunner";
// If you created a dedicated view component for macros:
import MacroCalculatorView from "@/features/calculators/health/MacroCalculator.view";
// If not yet created, you can temporarily point to a generic calculator shell.

// Optional: if/when you wire result persistence or queries, you can import:
// import { saveCalculatorResult } from "@/services/calculators/calculatorResultStore";

const CALCULATOR_ID = "daily-macros";

/**
 * @typedef {Object} MacroResult
 * @property {number} calories
 * @property {number} proteinGrams
 * @property {number} carbsGrams
 * @property {number} fatGrams
 * @property {Object<string, any>} [meta] - Any additional calculator-specific data
 */

function MacroNextStepsPanel({ result, loadingNext, onRequestSession }) {
  const navigate = useNavigate();

  const hasResult = !!result;

  /** @type {{ title: string, desc: string, cta: string, onClick: () => void, disabled?: boolean }[]} */
  const actions = useMemo(() => {
    if (!hasResult) {
      return [
        {
          title: "Start with your daily macros",
          desc: "Fill in your details on the left and calculate your daily macro needs. Once you have a result, you’ll see tailored next steps here.",
          cta: "Calculate first",
          onClick: () => {
            const el = document.querySelector("#macro-calculator-root");
            if (el) {
              el.scrollIntoView({ behavior: "smooth", block: "start" });
            }
          },
          disabled: false,
        },
      ];
    }

    // When we have a result, show three core “next steps”
    return [
      {
        id: "storehouse-annual-macros",
        title: "Convert to Annual Storehouse Targets",
        desc: "Turn your daily macros into 3/6/12-month storehouse targets so you know how much food to keep on hand.",
        cta: "Open Storehouse Planner",
        onClick: () => {
          // Emit an event; a planner page or automation can respond.
          emitMacroNextStepSelected("storehouse-annual-macros", result);
          navigate("/tier2/household/storehouse"); // adjust route if needed
        },
      },
      {
        id: "batch-cooking-session",
        title: "Plan a Batch Cooking Session",
        desc: "Use your macro targets to design a batch cooking session that hits your protein, carb, and fat goals with real meals.",
        cta: "Start Batch Plan",
        onClick: () => {
          emitMacroNextStepSelected("batch-cooking-session", result);
          if (typeof onRequestSession === "function") {
            onRequestSession(result);
          }
        },
      },
      {
        id: "stability-flow",
        title: "Stability: Lock In a Daily Rhythm",
        desc: "Generate a simple, repeatable daily meal rhythm that supports long-term health and household stability.",
        cta: "Run Stability Flow",
        onClick: () => {
          emitMacroNextStepSelected("stability-flow", result);
          // Navigation target can be updated once Stability Dashboard route is live.
          navigate("/stability");
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
            SSA can turn your macro numbers into concrete plans: storehouse
            goals, batch cooking sessions, and stability flows.
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
              Tip: Any next step you choose can trigger sessions and flows that
              the SessionRunner will guide you through with timers, cues, and
              notifications.
            </p>
          </footer>
        )}
      </div>
    </aside>
  );
}

/**
 * Emit a standard event when the user picks a macro next-step action.
 *
 * @param {string} actionId
 * @param {MacroResult} result
 */
function emitMacroNextStepSelected(actionId, result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.macros.nextStep.selected",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.macros",
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
      "[macros.jsx] Failed to emit calculator.macros.nextStep.selected",
      err
    );
  }
}

/**
 * Request a runnable session from automation/SessionRunner based on macro result.
 *
 * This does not open the SessionRunner itself; it only emits a request event.
 * Automation logic listening to this event can:
 *  - Build a session object matching the Session contract.
 *  - Persist it to Dexie.
 *  - Open the SessionRunner modal anchored at the app root.
 *
 * @param {MacroResult} result
 */
function requestMacroSession(result) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    eventBus.emit({
      type: "calculator.macros.session.requested",
      ts: new Date().toISOString(),
      source: "pages.calculators.health.macros",
      data: {
        calculatorId: CALCULATOR_ID,
        domain: "cooking", // primary domain for macro-driven sessions
        result,
        familyFundMode: !!familyFundMode,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[macros.jsx] Failed to emit calculator.macros.session.requested",
      err
    );
  }
}

/**
 * Route component: Macro Calculator + Next Steps.
 */
export default function MacroCalculatorPage() {
  /** @type {[MacroResult|null, React.Dispatch<React.SetStateAction<MacroResult|null>>]} */
  const [result, setResult] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [loadingNext, setLoadingNext] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    document.title = "Daily Macro Calculator | Suka Smart Assistant";
  }, []);

  /**
   * Handle calculator submission from the view component.
   *
   * @param {Object} input - Calculator input payload from the view.
   */
  const handleCalculate = useCallback(
    async (input) => {
      setIsRunning(true);
      setError(null);

      try {
        const { result: calcResult } = await runCalculator(CALCULATOR_ID, input, {
          source: "pages.calculators.health.macros",
          emitEvents: true,
        });

        if (!calcResult || typeof calcResult !== "object") {
          throw new Error("Macro calculator did not return a result object.");
        }

        /** @type {MacroResult} */
        const normalized = {
          calories: Number(calcResult.calories || 0),
          proteinGrams: Number(calcResult.proteinGrams || 0),
          carbsGrams: Number(calcResult.carbsGrams || 0),
          fatGrams: Number(calcResult.fatGrams || 0),
          meta: calcResult.meta || {},
        };

        setResult(normalized);

        // Optionally persist; can be wired later if desired.
        // await saveCalculatorResult(CALCULATOR_ID, normalized, {
        //   context: { source: "macros-route" },
        // });

        // Briefly set loadingNext to true to show micro-feedback in the panel.
        setLoadingNext(true);
        setTimeout(() => setLoadingNext(false), 350);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[macros.jsx] Macro calculator error", err);
        setError(
          err && err.message
            ? err.message
            : "There was a problem running the macro calculator."
        );
      } finally {
        setIsRunning(false);
      }
    },
    []
  );

  const handleRequestSession = useCallback(
    (macroResult) => {
      if (!macroResult) return;
      requestMacroSession(macroResult);
    },
    []
  );

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-slate-950/90 text-slate-50">
      <div className="mx-auto max-w-6xl px-4 py-6 lg:py-8">
        {/* Header */}
        <header className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
              Daily Macro Requirement Calculator
            </h1>
            <p className="mt-1 text-sm text-slate-400 max-w-2xl">
              Calculate the calories, protein, carbs, and fats your household
              members need each day. SSA can then convert these numbers into
              storehouse goals, batch cooking plans, and stability flows.
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

        {/* Main layout: calculator + next steps */}
        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <main
            id="macro-calculator-root"
            className="flex-1 w-full bg-slate-900/70 border border-slate-700 rounded-2xl shadow-xl p-4 lg:p-6"
          >
            <MacroCalculatorView
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
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">Calories</span>
                    <span className="text-slate-50 font-semibold">
                      {Math.round(result.calories || 0).toLocaleString()} kcal
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">Protein</span>
                    <span className="text-slate-50 font-semibold">
                      {Math.round(result.proteinGrams || 0)} g
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">Carbs</span>
                    <span className="text-slate-50 font-semibold">
                      {Math.round(result.carbsGrams || 0)} g
                    </span>
                  </div>
                  <div className="flex flex-col">
                    <span className="text-slate-400 mb-0.5">Fats</span>
                    <span className="text-slate-50 font-semibold">
                      {Math.round(result.fatGrams || 0)} g
                    </span>
                  </div>
                </div>
              </section>
            )}
          </main>

          <StabilityHintStrip />

          <StabilityMacroNowButton result={result} onRequestSession={handleRequestSession} />

          <StabilitySeparator />

          {/* Right-side: Next Steps */}
          <StabilitySidebarWrapper>
            <MacroNextStepsPanel
              result={result}
              loadingNext={loadingNext}
              onRequestSession={handleRequestSession}
            />
          </StabilitySidebarWrapper>
        </div>
      </div>
    </div>
  );
}

/**
 * Tiny “hint strip” component to visually connect macros to stability.
 * Safe to remove if you want a simpler layout; kept isolated for clarity.
 */
function StabilityHintStrip() {
  return null;
}

/**
 * Wrapper to allow layout tweaks separately from the core NextStepsPanel.
 */
function StabilitySidebarWrapper({ children }) {
  return children;
}

/**
 * Optional “Now” button anchored near the calculator for immediate sessions.
 * For now, this just emits the same session.requested event as the Next Steps
 * panel; the actual SessionRunner modal is managed at the app root.
 */
function StabilityMacroNowButton({ result, onRequestSession }) {
  if (!result) return null;

  return (
    <div className="lg:hidden mt-3">
      <button
        type="button"
        onClick={() => onRequestSession && onRequestSession(result)}
        className="inline-flex items-center justify-center w-full rounded-xl px-4 py-2.5 text-sm font-semibold bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-lg shadow-emerald-500/30 transition"
      >
        Use These Macros in a Session Now
      </button>
    </div>
  );
}

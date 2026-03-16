// C:\Users\larho\suka-smart-assistant\src\pages\planning\food-stabilization.jsx
// -----------------------------------------------------------------------------
// FoodStabilizationPlanningPage
//
// How this fits the SSA system:
// - Lives under /planning as a “meta” page that orchestrates a multi-week
//   “food stabilization” plan using SSA’s domains:
//   • storehouse (pantry, freezers, long-term storage)
//   • cooking (practical meal cycles from what you have)
//   • garden & animals (production that feeds the storehouse)
//   • preservation (canning, freezing, drying, curing)
// - It does NOT run timers itself. Instead, it:
//   • exposes clear “Now” CTAs that emit `session.requestNext` events,
//   • hints relevant domains so the root-level SessionRunner can decide
//     which session to run next,
//   • relies on the SessionRunner (mounted at app root) to:
//       - keep running across navigation,
//       - use wake-lock, notifications, PiP, and Web Worker timers,
//       - persist checkpoints in Dexie and auto-resume.
//
// Contracts used here:
// - eventBus.emitEvent({ type, ts, source, data })
// - featureFlags.familyFundMode (boolean)
// - Session domains: cooking | cleaning | garden | animals | preservation | storehouse
//
// This page also includes a local “Flow overview” modal explaining how the
// food stabilization plan works. That modal is *not* the global SessionRunner.
// -----------------------------------------------------------------------------

import React, { useCallback, useState } from "react";
import { emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/**
 * Emit a “play the next runnable session now” request for Food Stabilization.
 *
 * The SessionRunner listener should:
 *   - look at domainHints + focusArea,
 *   - choose the next appropriate session from Dexie or in-memory drafts,
 *   - if multiple sessions are valid, use its own selector UI,
 *   - open the global SessionRunner modal and keep it alive across navigation.
 *
 * @param {("cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse")[]} domainHints
 * @param {string} focusArea Short label like "pantry-audit", "30-day-staples", etc.
 */
function requestNextSession(domainHints, focusArea) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "FoodStabilizationPlanningPage",
      data: {
        domainHints,
        reason: "food-stabilization",
        focusArea,
        meta: {
          page: "planning/food-stabilization",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[FoodStabilizationPlanning] Failed to emit session.requestNext",
      err
    );
  }
}

/**
 * Local modal describing the full Food Stabilization flow.
 * This is NOT the SessionRunner — just a static info helper for this page.
 */
function FoodStabilizationFlowModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Modal content */}
      <div className="relative z-50 w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/70 px-5 py-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <h2 className="text-sm font-semibold text-slate-100">
            Food Stabilization Flow Overview
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-300 text-xs hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-emerald-400"
          >
            ✕
          </button>
        </div>

        <div className="space-y-3 text-[11px] text-slate-300">
          <p>
            This planner guides a{" "}
            <span className="font-semibold text-emerald-300">
              Food Stabilization
            </span>{" "}
            process: making sure your household can eat well and calmly from the
            storehouse for weeks at a time, using what you actually like and can
            afford.
          </p>

          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              <span className="font-semibold">Baseline:</span> quickly scan your
              pantry, fridge, and freezers using small{" "}
              <span className="font-semibold text-emerald-300">
                storehouse sessions
              </span>{" "}
              instead of a giant inventory day.
            </li>
            <li>
              <span className="font-semibold">Stabilize 30 days:</span> build a
              rotation of meals using what you already have, plus a few reliable
              staples, with{" "}
              <span className="font-semibold text-emerald-300">
                cooking sessions
              </span>{" "}
              that the SessionRunner keeps on track.
            </li>
            <li>
              <span className="font-semibold">Tie in garden & animals:</span>{" "}
              align planting, harvest, and animal processing so your own
              production feeds your shelf-stable plan.
            </li>
            <li>
              <span className="font-semibold">Preserve & buffer:</span> run
              preservation sessions (canning, freezing, drying, curing) to
              create a simple buffer of ready meals and ingredients.
            </li>
          </ol>

          <p>
            Every time you hit a “Now” button, the global SessionRunner opens,
            runs your tasks with timers and cues, and stays active even if you
            switch pages or open other SSA tools.
          </p>

          {familyFundMode && (
            <p className="text-emerald-200/80">
              With <span className="font-semibold">Family Fund Mode</span>{" "}
              enabled, completed storehouse / cooking / preservation sessions
              can export anonymous analytics to your Hub, showing how your
              household&apos;s food resilience changes over seasons and years.
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"
          >
            Let&apos;s Stabilize
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Reusable phase card for the Food Stabilization flow.
 */
function PhaseCard({ title, subtitle, description, bullets, ctaLabel, onNow }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40 flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
        {subtitle && (
          <p className="text-[11px] text-slate-400 mt-0.5">{subtitle}</p>
        )}
      </div>
      {description && (
        <p className="text-[11px] text-slate-300">{description}</p>
      )}
      {bullets && bullets.length > 0 && (
        <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-300">
          {bullets.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onNow}
          className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 shadow-md shadow-emerald-500/25 hover:bg-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-slate-950"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-900 animate-pulse" />
          <span>{ctaLabel}</span>
        </button>
        <span className="text-[11px] text-slate-500">
          Opens in the SessionRunner modal and keeps running if you navigate
          away.
        </span>
      </div>
    </div>
  );
}

function FoodStabilizationPlanningPage() {
  const [flowOpen, setFlowOpen] = useState(false);

  // CTA handlers for different focus areas
  const handleNowFullPlan = useCallback(() => {
    requestNextSession(
      ["storehouse", "cooking", "preservation", "garden", "animals"],
      "food-stabilization-plan"
    );
  }, []);

  const handleNowPantryScan = useCallback(() => {
    requestNextSession(["storehouse"], "pantry-audit");
  }, []);

  const handleNow30DayMeals = useCallback(() => {
    requestNextSession(["cooking", "storehouse"], "30-day-rotation");
  }, []);

  const handleNowGardenAnimals = useCallback(() => {
    requestNextSession(
      ["garden", "animals", "storehouse"],
      "production-alignment"
    );
  }, []);

  const handleNowPreservation = useCallback(() => {
    requestNextSession(["preservation", "storehouse"], "preservation-buffer");
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-50 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              Food Stabilization Planner
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl">
              Build a calm, repeatable food system for your household—so you can
              eat well from the storehouse for weeks at a time, using routines
              powered by the SessionRunner.
            </p>
          </div>

          {/* Top-level “Now” CTA for the full plan */}
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={handleNowFullPlan}
              className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 shadow-md shadow-emerald-500/30 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-slate-950 transition"
            >
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-900 animate-pulse" />
              <span>Start Food Stabilization Now</span>
            </button>
            <p className="text-[11px] text-slate-500">
              Opens the next runnable{" "}
              <span className="font-semibold text-slate-300">
                storehouse / cooking / preservation / garden / animals
              </span>{" "}
              session in the SessionRunner.
            </p>
          </div>
        </div>
      </header>

      {/* Family Fund banner */}
      {familyFundMode && (
        <div className="bg-emerald-500/10 border-b border-emerald-500/40">
          <div className="mx-auto max-w-6xl px-4 py-2 text-xs text-emerald-100 flex items-center gap-2">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
            <span className="font-semibold">Family Fund Mode is ON.</span>
            <span className="text-emerald-200/80">
              Completed food stabilization sessions can be exported to the Hub
              to show how your storehouse and meal stability change over time.
            </span>
          </div>
        </div>
      )}

      {/* Main content */}
      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-6 grid gap-6 lg:grid-cols-[minmax(0,2.1fr)_minmax(0,1.4fr)]">
          {/* Left: Phases / flows */}
          <section className="space-y-4">
            {/* Intro / overview */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-4 md:p-5 shadow-lg shadow-slate-950/40 flex flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">
                    1. Understand your food baseline
                  </h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Start with a simple picture of what&apos;s in your
                    storehouse and how long it can feed your household.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setFlowOpen(true)}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-950/60 px-2.5 py-1 text-[11px] text-slate-300 hover:border-emerald-400 hover:text-emerald-200 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                >
                  <span className="text-xs">ⓘ</span>
                  <span>View full flow</span>
                </button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-[11px] text-slate-400 mb-1">
                    Storehouse & stability calculators
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-300">
                    <li>Storehouse / pantry duration estimates</li>
                    <li>Household Stability snapshot (food & finances)</li>
                    <li>Macro & calorie planner for realistic meals</li>
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href="/calculators/storehouse/duration"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Storehouse Duration
                    </a>
                    <a
                      href="/calculators/stability/household-stability"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Stability Dashboard
                    </a>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-[11px] text-slate-400 mb-1">
                    Quick food map
                  </p>
                  <p className="text-[11px] text-slate-300 mb-1">
                    Walk your pantry, fridge, and freezers with a 10–15 minute
                    session instead of a full-day inventory.
                  </p>
                  <button
                    type="button"
                    onClick={handleNowPantryScan}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-500/70 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-200 hover:bg-emerald-500/20"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
                    Run Pantry / Freezer Scan Session
                  </button>
                </div>
              </div>
            </div>

            {/* Phase 1: 7-day calm-from-storehouse */}
            <PhaseCard
              title="2. Phase One – 7-Day Calm-from-Storehouse"
              subtitle="Prove to yourself that you can eat well from what you have."
              description="Use the next 7 days to build confidence that your storehouse can feed your family without panic buying or last-minute fast food."
              bullets={[
                "Choose 3–4 dinners and 2–3 breakfasts that use current pantry and freezer items.",
                "Use the macro / calorie planner to check that meals are balanced enough.",
                "Run short cooking + storehouse sessions to cook once and eat twice (leftovers / next-day lunches).",
              ]}
              ctaLabel="Run a 7-Day Rotation Cooking Session"
              onNow={handleNow30DayMeals}
            />

            {/* Phase 2: 30-day staples plan */}
            <PhaseCard
              title="3. Phase Two – 30-Day Staple Meal Rotation"
              subtitle="Create a simple 30-day pattern and stock to match."
              description="Once 7 days feels manageable, extend your plan to 30 days with a small list of staples you always try to keep on hand."
              bullets={[
                "List 10–15 core meals everyone generally likes that rely on staples.",
                "Use your storehouse calculators to see how much grain, beans, fats, and proteins support 30 days.",
                "Run storehouse sessions to re-balance shelves (e.g., more beans, rice, or canned tomatoes).",
              ]}
              ctaLabel="Run a 30-Day Storehouse Planning Session"
              onNow={handleNow30DayMeals}
            />

            {/* Phase 3: Garden & animals integration */}
            <PhaseCard
              title="4. Phase Three – Garden & Animals Feeding the Storehouse"
              subtitle="Let your production fill the same shelves your meals pull from."
              description="Align garden planting times, animal processing, and preservation with the meals you’ve already stabilized so you don’t grow or raise random food."
              bullets={[
                "Mark which meals can be supplied (fully or partly) by your garden and animals.",
                "Plan a small set of crops and animals that plug directly into your 30-day rotation.",
                "Run garden / animals sessions focused on tasks that support those meals first.",
              ]}
              ctaLabel="Run a Garden / Animals Alignment Session"
              onNow={handleNowGardenAnimals}
            />

            {/* Phase 4: Preservation buffer */}
            <PhaseCard
              title="5. Phase Four – Preservation Buffer Weekend"
              subtitle="Turn fresh or bulk ingredients into shelf-stable backups."
              description="Use canning, freezing, dehydrating, or curing to create a gentle buffer of ready meals and components without overwhelming yourself."
              bullets={[
                "Pick 2–3 recipes from your stabilized meal list that preserve well.",
                "Plan one weekend session for canning, freezing, or drying.",
                "Label and log preserved items so the storehouse calculators can reflect them.",
              ]}
              ctaLabel="Run a Preservation / Buffer Session"
              onNow={handleNowPreservation}
            />
          </section>

          {/* Right: Food stabilization mini dashboard + links */}
          <section className="space-y-4">
            {/* Mini dashboard */}
            <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-4 md:p-5 shadow-xl shadow-emerald-950/50">
              <h2 className="text-sm font-semibold text-emerald-100 mb-2">
                Food Stabilization Snapshot
              </h2>
              <p className="text-[11px] text-emerald-100/80">
                Use this as a small mental checklist while you build the plan.
                Later, you can connect it to analytics if you want more
                automation.
              </p>

              <div className="mt-3 grid gap-2 text-[11px] text-emerald-100/90">
                <div className="flex items-center justify-between">
                  <span>Can we eat calmly for 7 days from home?</span>
                  <span className="rounded-full bg-emerald-900/70 px-2 py-0.5 border border-emerald-400/60 text-[10px]">
                    Aim: Yes, with meals we like
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>30-day staple meal rotation</span>
                  <span className="text-emerald-50 font-semibold">
                    (build on Phase Two)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Production feeding shelves</span>
                  <span className="text-emerald-50 font-semibold">
                    Garden / animals mapped to meals
                  </span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={handleNowFullPlan}
                  className="inline-flex items-center gap-2 rounded-full border border-emerald-300/80 bg-emerald-900/40 px-3 py-1.5 text-[11px] font-medium text-emerald-100 hover:bg-emerald-800/70 focus:outline-none focus:ring-1 focus:ring-emerald-300"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-200" />
                  Resume Food Stabilization Session
                </button>
                <span className="text-[11px] text-emerald-100/80">
                  SessionRunner auto-resumes if a food stabilization session is
                  still running.
                </span>
              </div>
            </div>

            {/* Helpful tools / links */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5 shadow-lg shadow-slate-950/50">
              <h2 className="text-sm font-semibold text-slate-100 mb-2">
                Helpful tools for food stabilization
              </h2>
              <ul className="space-y-2 text-[11px] text-slate-300">
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>
                    <span className="font-semibold">Storehouse Duration:</span>{" "}
                    estimate how long your current pantry, fridge, and freezer
                    can feed your household at different meal patterns.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                  <span>
                    <span className="font-semibold">
                      Macro & Calorie Planner:
                    </span>{" "}
                    design core meals that work with your goals and fit your
                    shelves.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
                  <span>
                    <span className="font-semibold">
                      Pricebook / Scan-Compare:
                    </span>{" "}
                    if enabled elsewhere in SSA, use it to choose affordable,
                    repeatable staples for your 30-day plan.
                  </span>
                </li>
                {familyFundMode && (
                  <li className="flex gap-2">
                    <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-indigo-400" />
                    <span>
                      <span className="font-semibold">Family Fund Hub:</span>{" "}
                      later, view how often you run food-related sessions and
                      how your storehouse trends (months of coverage,
                      categories, etc.) change over time.
                    </span>
                  </li>
                )}
              </ul>

              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href="/calculators/storehouse/duration"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Storehouse Duration Calculator
                </a>
                <a
                  href="/calculators/health/macros"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Macro & Calorie Planner
                </a>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Local informational modal */}
      <FoodStabilizationFlowModal
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
      />
    </div>
  );
}

export default FoodStabilizationPlanningPage;

// C:\Users\larho\suka-smart-assistant\src\pages\planning\health-reset.jsx
// -----------------------------------------------------------------------------
// HealthResetPlanningPage
//
// How this fits the SSA system:
// - Lives under /planning as a “meta” page that orchestrates a 7–30 day
//   “health reset” using SSA’s calculators and domain sessions.
// - It does NOT run timers itself. Instead, it:
//   • points the user to key calculators (BMI, macros, micronutrients, stability),
//   • exposes clear “Now” CTAs that emit `session.requestNext` events,
//   • lets the root-level SessionRunner resolve and open the next runnable
//     cooking / cleaning / garden / animals / preservation / storehouse session.
// - The SessionRunner (mounted at app root in App.jsx) is responsible for:
//   • wake-lock, notifications, PiP mini HUD,
//   • Dexie checkpoints + auto-resume,
//   • emitting session.started / step.changed / completed / aborted / exported.
//
// Contracts used here:
// - eventBus.emitEvent({ type, ts, source, data })
// - featureFlags.familyFundMode (boolean)
// - Session domains: cooking | cleaning | garden | animals | preservation | storehouse
//
// This page also includes a local “Flow overview” modal explaining how the
// health reset works. That modal is purely informational and NOT the global
// SessionRunner UI.
// -----------------------------------------------------------------------------

import React, { useCallback, useState } from "react";
import { emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/**
 * Emit a “play the next runnable session now” request.
 *
 * The SessionRunner listener should:
 *   - look at domainHints + focusArea,
 *   - choose the next appropriate session from Dexie / memory,
 *   - if multiple sessions are valid, prompt its own selector,
 *   - open the SessionRunner modal that stays mounted across navigation.
 *
 * @param {("cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse")[]} domainHints
 * @param {string} focusArea Short label like "meal-prep", "sleep-routine", etc.
 */
function requestNextSession(domainHints, focusArea) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "HealthResetPlanningPage",
      data: {
        domainHints,
        reason: "health-reset",
        focusArea,
        meta: {
          page: "planning/health-reset",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[HealthResetPlanning] Failed to emit session.requestNext",
      err
    );
  }
}

/**
 * Local modal describing the full health reset flow.
 * NOT the SessionRunner — this is just a static info helper.
 */
function HealthResetFlowModal({ open, onClose }) {
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
            Health Reset Flow Overview
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
            This page guides a{" "}
            <span className="font-semibold text-emerald-300">
              7–30 day health reset
            </span>{" "}
            using the tools already inside Suka Smart Assistant. Instead of
            tracking everything manually, you use sessions and calculators that
            link directly to food, cleaning, sleep, and daily movement.
          </p>

          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              <span className="font-semibold">Baseline:</span> use the{" "}
              <span className="font-semibold text-slate-100">
                Body & Nutrition
              </span>{" "}
              calculators and the{" "}
              <span className="font-semibold text-slate-100">
                Household Stability
              </span>{" "}
              snapshot to see where you&apos;re starting.
            </li>
            <li>
              <span className="font-semibold">7-Day Core Habits:</span> use the
              buttons on this page to launch short{" "}
              <span className="font-semibold text-emerald-300">
                cooking, cleaning, and bedtime sessions
              </span>{" "}
              that the SessionRunner keeps alive across navigation.
            </li>
            <li>
              <span className="font-semibold">Extend to 30 Days:</span> after
              the first week, you can repeat successful sessions or schedule
              gentler sessions for maintenance.
            </li>
          </ol>

          <p>
            Every time you hit a “Now” button, the global SessionRunner modal
            opens, runs your tasks with timers and cues, and stays active even
            if you switch pages or open another tool.
          </p>

          {familyFundMode && (
            <p className="text-emerald-200/80">
              With <span className="font-semibold">Family Fund Mode</span>{" "}
              enabled, completed sessions can export anonymous analytics to your
              Hub so you can see how your household&apos;s health routines
              improve over time.
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"
          >
            Let&apos;s Reset
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Small reusable card for a health reset phase.
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

function HealthResetPlanningPage() {
  const [flowOpen, setFlowOpen] = useState(false);

  const handleNowCoreMeals = useCallback(() => {
    requestNextSession(["cooking", "storehouse"], "core-meals");
  }, []);

  const handleNowEnvironment = useCallback(() => {
    requestNextSession(["cleaning"], "sleep-environment");
  }, []);

  const handleNowMovement = useCallback(() => {
    requestNextSession(["garden", "animals"], "daily-movement");
  }, []);

  const handleNowPreservation = useCallback(() => {
    requestNextSession(["preservation", "storehouse"], "batch-prep");
  }, []);

  const handleNow7Day = useCallback(() => {
    requestNextSession(
      [
        "cooking",
        "cleaning",
        "garden",
        "animals",
        "preservation",
        "storehouse",
      ],
      "7-day-health-reset"
    );
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-50 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              Health Reset Planner
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl">
              Orchestrate a 7–30 day “health reset” using SSA&apos;s cooking,
              cleaning, garden, animal care, and storehouse tools—powered by the
              SessionRunner so your routines stay on track.
            </p>
          </div>

          {/* Top-level “Now” CTA for full flow */}
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={handleNow7Day}
              className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 shadow-md shadow-emerald-500/30 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-slate-950 transition"
            >
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-900 animate-pulse" />
              <span>Start 7-Day Health Reset Now</span>
            </button>
            <p className="text-[11px] text-slate-500">
              Opens the next runnable{" "}
              <span className="font-semibold text-slate-300">
                cooking / cleaning / garden / animals / preservation /
                storehouse
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
              Completed health reset sessions can be exported to the Hub to show
              how your household&apos;s health routines grow over time.
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
                    1. Understand your baseline
                  </h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Start with a clear picture of where your body and household
                    stand today.
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
                    Body & nutrition calculators
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-300">
                    <li>BMI / body composition check</li>
                    <li>Daily macro + calorie planner</li>
                    <li>Micronutrient baseline (vitamins & minerals)</li>
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href="/calculators/health/body-overview"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Body Overview
                    </a>
                    <a
                      href="/calculators/health/nutrition"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Nutrition Planner
                    </a>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-[11px] text-slate-400 mb-1">
                    Household stability snapshot
                  </p>
                  <p className="text-[11px] text-slate-300 mb-1">
                    Check your food, cleaning, time, garden, animals, and
                    finances in one place.
                  </p>
                  <a
                    href="/calculators/stability/household-stability"
                    className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                  >
                    Open Household Stability Dashboard
                  </a>
                </div>
              </div>
            </div>

            {/* Phase 1: Food & hydration */}
            <PhaseCard
              title="2. Phase One – Food & Hydration (Days 1–3)"
              subtitle="Simple, calm meals that nourish instead of drain."
              description="Anchor your reset with predictable meals and enough water. Use storehouse ingredients you already have and keep prep straightforward."
              bullets={[
                "Plan 1–2 core breakfasts and dinners that can repeat for a few days.",
                "Make sure each day hits your target protein and fiber numbers.",
                "Prep water bottles or jugs so you aren't chasing hydration.",
              ]}
              ctaLabel="Run a Core Meals Session Now"
              onNow={handleNowCoreMeals}
            />

            {/* Phase 2: Sleep environment & light cleaning */}
            <PhaseCard
              title="3. Phase Two – Sleep & Environment (Days 2–4)"
              subtitle="Clear just enough visual noise to let your nervous system settle."
              description="Light, targeted cleaning around your sleep and recovery spaces makes the entire reset feel easier without a full-house overhaul."
              bullets={[
                "Choose 1–2 zones: bedroom, bathroom, and/or kitchen landing spot.",
                "Run short, timed cleaning sessions instead of all-day marathons.",
                "Set up a simple bedtime routine (dim lights, warm drink, low screens).",
              ]}
              ctaLabel="Run a Sleep Environment Cleaning Session"
              onNow={handleNowEnvironment}
            />

            {/* Phase 3: Movement & outdoors */}
            <PhaseCard
              title="4. Phase Three – Daily Movement & Outdoors (Days 3–7)"
              subtitle="Let garden, animals, and chores double as gentle movement."
              description="Use tasks you already need to do—watering, feeding, small projects—as structured movement blocks, instead of treating exercise as something extra."
              bullets={[
                "Schedule a 10–20 minute garden or yard block each day.",
                "If you have animals, fold feeding and simple training into your reset.",
                "On low-energy days, walk the property or house instead of skipping movement.",
              ]}
              ctaLabel="Run a Movement / Garden Session"
              onNow={handleNowMovement}
            />

            {/* Optional: Batch prep & preservation */}
            <PhaseCard
              title="5. Optional – Batch Prep & Preservation Weekend"
              subtitle="Lock in the gains from your reset with a simple batch cook."
              description="Once your core meals and routines feel easier, use a weekend block to batch-cook or preserve a few key items so future you has support."
              bullets={[
                "Pick 2–3 recipes for meals you actually liked during the reset.",
                "Use a batch cooking or preservation session to turn them into freezer/ pantry backups.",
                "Label portions clearly with dates and any special instructions.",
              ]}
              ctaLabel="Run a Batch Prep / Preservation Session"
              onNow={handleNowPreservation}
            />
          </section>

          {/* Right: Small dashboard + next steps */}
          <section className="space-y-4">
            {/* Mini status card */}
            <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-4 md:p-5 shadow-xl shadow-emerald-950/50">
              <h2 className="text-sm font-semibold text-emerald-100 mb-2">
                Health Reset Status
              </h2>
              <p className="text-[11px] text-emerald-100/80">
                Use this card as a simple self-check. You can later connect it
                to logs or analytics if you want more automation.
              </p>

              <div className="mt-3 grid gap-2 text-[11px] text-emerald-100/90">
                <div className="flex items-center justify-between">
                  <span>Today&apos;s priority</span>
                  <span className="rounded-full bg-emerald-900/70 px-2 py-0.5 border border-emerald-400/60 text-[10px]">
                    Choose in the main phases
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Sessions completed this week</span>
                  <span className="text-emerald-50 font-semibold">
                    (tracked by SessionRunner)
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>How you feel right now</span>
                  <span className="text-emerald-50 font-semibold">
                    Quick 0–10 in your head
                  </span>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap gap-2 items-center">
                <button
                  type="button"
                  onClick={handleNow7Day}
                  className="inline-flex items-center gap-2 rounded-full border border-emerald-300/80 bg-emerald-900/40 px-3 py-1.5 text-[11px] font-medium text-emerald-100 hover:bg-emerald-800/70 focus:outline-none focus:ring-1 focus:ring-emerald-300"
                >
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-200" />
                  Resume Health Reset Session
                </button>
                <span className="text-[11px] text-emerald-100/80">
                  SessionRunner auto-resumes if a reset session is still
                  running.
                </span>
              </div>
            </div>

            {/* Helpful links card */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5 shadow-lg shadow-slate-950/50">
              <h2 className="text-sm font-semibold text-slate-100 mb-2">
                Helpful tools for your reset
              </h2>
              <ul className="space-y-2 text-[11px] text-slate-300">
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>
                    <span className="font-semibold">
                      Macro & calorie planner:
                    </span>{" "}
                    design simple rotation meals that hit your targets using
                    what you already have.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                  <span>
                    <span className="font-semibold">
                      Household Stability Dashboard:
                    </span>{" "}
                    revisit your weakest area after a week and see if your score
                    nudged up.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
                  <span>
                    <span className="font-semibold">Sleep routine notes:</span>{" "}
                    keep a tiny notebook or SSA note about what helps you wind
                    down (lighting, timing, foods).
                  </span>
                </li>
                {familyFundMode && (
                  <li className="flex gap-2">
                    <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-indigo-400" />
                    <span>
                      <span className="font-semibold">Family Fund Hub:</span>{" "}
                      later, you can pull graphs showing how often you run
                      health-related sessions and what changed in your food,
                      cleaning, and stability scores.
                    </span>
                  </li>
                )}
              </ul>

              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href="/calculators/health/macros"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Macro & Calorie Calculator
                </a>
                <a
                  href="/calculators/health/micronutrients"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Micronutrient Planner
                </a>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Local informational modal */}
      <HealthResetFlowModal
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
      />
    </div>
  );
}

export default HealthResetPlanningPage;

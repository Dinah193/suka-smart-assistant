// C:\Users\larho\suka-smart-assistant\src\pages\planning\garden-season.jsx
// -----------------------------------------------------------------------------
// GardenSeasonPlanningPage
//
// How this fits the SSA system:
// - Lives under /planning as a “meta” page that orchestrates a full
//   “garden season setup” using SSA domains:
//   • garden       – bed layout, crop plans, succession planting
//   • animals      – manure, grazing rotation, pest helpers
//   • storehouse   – seed inventory, amendments, harvest targets
//   • preservation – planned preservation flows for peak harvest
//   • cleaning     – tools, irrigation checks, shed / work area reset
//
// - It does NOT run timers itself. Instead, it:
//   • exposes “Now” CTAs that emit `session.requestNext` events,
//   • hints relevant domains so the root-level SessionRunner can decide
//     which session to run next,
//   • relies on the SessionRunner (mounted at app root) to:
//       - keep running across navigation,
//       - use wake-lock, notifications, PiP, and Web Worker timers,
//       - persist checkpoints in Dexie and auto-resume,
//       - emit session.* events and optionally export to the Hub.
//
// Contracts used here:
// - eventBus.emitEvent({ type, ts, source, data })
// - featureFlags.familyFundMode (boolean)
// - Session domains: cooking | cleaning | garden | animals | preservation | storehouse
//
// This page also includes a local “Flow overview” modal explaining how the
// garden season setup flow works. That modal is *not* the global SessionRunner.
// -----------------------------------------------------------------------------

import React, { useCallback, useState } from "react";
import { emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/**
 * Emit a “play the next runnable session now” request for Garden Season Setup.
 *
 * The SessionRunner listener should:
 *   - look at domainHints + focusArea,
 *   - choose the next appropriate session from Dexie or drafts,
 *   - if multiple sessions are valid, use its own selector UI,
 *   - open the global SessionRunner modal and keep it alive across navigation.
 *
 * @param {("cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse")[]} domainHints
 * @param {string} focusArea Short label like "bed-layout", "seed-start", etc.
 */
function requestNextSession(domainHints, focusArea) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "GardenSeasonPlanningPage",
      data: {
        domainHints,
        reason: "garden-season-setup",
        focusArea,
        meta: {
          page: "planning/garden-season",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[GardenSeasonPlanning] Failed to emit session.requestNext",
      err
    );
  }
}

/**
 * Local modal describing the full Garden Season Setup flow.
 * This is NOT the SessionRunner — just info for this page.
 */
function GardenSeasonFlowModal({ open, onClose }) {
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
            Garden Season Setup Flow Overview
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
              Garden Season Setup
            </span>{" "}
            process so your beds, seeds, water, and animals all point toward the
            same harvest and storehouse goals.
          </p>

          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              <span className="font-semibold">Set your targets:</span> decide
              which crops matter most this season and how they support your
              storehouse and meal plans.
            </li>
            <li>
              <span className="font-semibold">Lay out beds & rotations:</span>{" "}
              map where crops will grow, how they rotate, and where animals or
              cover crops fit.
            </li>
            <li>
              <span className="font-semibold">
                Schedule seed starts & planting:
              </span>{" "}
              align indoor starts, direct sowing, and succession planting with
              frost dates and your calendar.
            </li>
            <li>
              <span className="font-semibold">Water & infrastructure:</span> run
              short sessions to check irrigation, tools, and pathways before the
              rush starts.
            </li>
            <li>
              <span className="font-semibold">
                Harvest & preservation plan:
              </span>{" "}
              connect expected harvest windows to preservation and meal flows so
              food doesn&apos;t go to waste.
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
              enabled, completed garden-season sessions can export anonymous
              analytics to your Hub, helping you see how garden planning and
              harvest success change year by year.
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"
          >
            Let&apos;s Plan the Season
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Reusable phase card for the Garden Season flow.
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

function GardenSeasonPlanningPage() {
  const [flowOpen, setFlowOpen] = useState(false);

  // CTA handlers for different focus areas
  const handleNowFullPlan = useCallback(() => {
    requestNextSession(
      ["garden", "animals", "storehouse", "preservation", "cleaning"],
      "garden-season-setup-plan"
    );
  }, []);

  const handleNowTargets = useCallback(() => {
    requestNextSession(["garden", "storehouse"], "garden-season-targets");
  }, []);

  const handleNowBedsRotations = useCallback(() => {
    requestNextSession(["garden", "animals"], "bed-layout-and-rotations");
  }, []);

  const handleNowSeedSchedule = useCallback(() => {
    requestNextSession(
      ["garden", "storehouse"],
      "seed-start-and-planting-calendar"
    );
  }, []);

  const handleNowWaterInfra = useCallback(() => {
    requestNextSession(["cleaning", "garden"], "water-tools-infrastructure");
  }, []);

  const handleNowHarvestPreserve = useCallback(() => {
    requestNextSession(
      ["garden", "preservation", "storehouse"],
      "harvest-and-preservation-plan"
    );
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-50 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              Garden Season Setup
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl">
              Map your garden season from seeds to storehouse—beds, rotations,
              animals, water, and harvest flows—powered by the SessionRunner so
              the work stays organized.
            </p>
          </div>

          {/* Top-level “Now” CTA for full plan */}
          <div className="flex flex-col items-end gap-1">
            <button
              type="button"
              onClick={handleNowFullPlan}
              className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 shadow-md shadow-emerald-500/30 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-slate-950 transition"
            >
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-900 animate-pulse" />
              <span>Start Garden Season Setup Now</span>
            </button>
            <p className="text-[11px] text-slate-500">
              Opens the next runnable{" "}
              <span className="font-semibold text-slate-300">
                garden / animals / storehouse / preservation / cleaning
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
              Completed garden-season sessions can be exported to the Hub to
              show how your garden and storehouse trends change over years.
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
                    1. Set garden goals & targets
                  </h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Decide what this season should do for your household:
                    calories, flavor, medicine, animal feed, or all of the
                    above.
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
                    Planning & calculator tools
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-300">
                    <li>Seed viability & germination estimator</li>
                    <li>Season length & frost window overview</li>
                    <li>Storehouse targets linked to crops</li>
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href="/calculators/garden/seed-viability"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Seed Viability Calculator
                    </a>
                    <a
                      href="/calculators/garden/season-length"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Season Length Planner
                    </a>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-[11px] text-slate-400 mb-1">
                    Quick goal-setting session
                  </p>
                  <p className="text-[11px] text-slate-300 mb-1">
                    Use a short planning session to set top crops, yield goals,
                    and how they connect to meals and the storehouse.
                  </p>
                  <button
                    type="button"
                    onClick={handleNowTargets}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-500/70 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-200 hover:bg-emerald-500/20"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
                    Run Garden Goals Session
                  </button>
                </div>
              </div>
            </div>

            {/* Phase 1: Beds & rotations */}
            <PhaseCard
              title="2. Phase One – Beds, Rotations, and Space"
              subtitle="Give every crop and creature a clear place to go."
              description="Lay out beds, rows, containers, and animal paths so your garden feels intentional instead of random."
              bullets={[
                "Sketch current and planned beds, paths, and trellises.",
                "Assign crops by bed with simple rotations (heavy feeders, legumes, roots, etc.).",
                "Mark where animals, compost, or cover crops will cycle through.",
              ]}
              ctaLabel="Run a Bed Layout & Rotation Session"
              onNow={handleNowBedsRotations}
            />

            {/* Phase 2: Seed start & planting schedule */}
            <PhaseCard
              title="3. Phase Two – Seed Start & Planting Schedule"
              subtitle="Plan when each crop begins and where it moves."
              description="Align indoor starts, direct sowing, and succession planting with your frost dates and calendar, so you aren’t rushing all at once."
              bullets={[
                "List crops that need indoor seed starting vs direct sowing.",
                "Use season length tools to pick start dates and transplant windows.",
                "Plan at least one succession for key crops (greens, beans, etc.) if possible.",
              ]}
              ctaLabel="Run a Seed & Planting Calendar Session"
              onNow={handleNowSeedSchedule}
            />

            {/* Phase 3: Water & infrastructure */}
            <PhaseCard
              title="4. Phase Three – Water, Tools, and Infrastructure"
              subtitle="Check systems before the season gets busy."
              description="Use short sessions to test hoses, timers, rainwater systems, tools, and pathways so they support you instead of fighting you."
              bullets={[
                "Test irrigation lines, timers, and watering cans for leaks or clogs.",
                "Sharpen or clean tools; set up a simple tool staging area.",
                "Check paths and gates so you can move with wheelbarrows or animals easily.",
              ]}
              ctaLabel="Run a Water & Tools Check Session"
              onNow={handleNowWaterInfra}
            />

            {/* Phase 4: Harvest & preservation alignment */}
            <PhaseCard
              title="5. Phase Four – Harvest Windows & Preservation Plan"
              subtitle="Match expected harvests to storehouse and preservation flows."
              description="Look ahead to peak harvest weeks and line up preservation or bulk cooking sessions so food lands where it should: on plates or shelves."
              bullets={[
                "Estimate harvest windows for major crops using planting dates.",
                "Pair crops with preservation methods (canning, freezing, drying, fermenting).",
                "Schedule tentative preservation weekends or evenings around those windows.",
              ]}
              ctaLabel="Run a Harvest & Preservation Planning Session"
              onNow={handleNowHarvestPreserve}
            />
          </section>

          {/* Right: Garden mini dashboard + links */}
          <section className="space-y-4">
            {/* Mini dashboard */}
            <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-4 md:p-5 shadow-xl shadow-emerald-950/50">
              <h2 className="text-sm font-semibold text-emerald-100 mb-2">
                Garden Season Snapshot
              </h2>
              <p className="text-[11px] text-emerald-100/80">
                Use this as a small mental checklist while you set up the
                season. Later, you can connect it to analytics if you want.
              </p>

              <div className="mt-3 grid gap-2 text-[11px] text-emerald-100/90">
                <div className="flex items-center justify-between">
                  <span>Frost dates & season window set</span>
                  <span className="rounded-full bg-emerald-900/70 px-2 py-0.5 border border-emerald-400/60 text-[10px]">
                    Calendar + season length ready
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Beds & rotations decided</span>
                  <span className="text-emerald-50 font-semibold">
                    Space assigned by crop
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Seed starting & planting schedule</span>
                  <span className="text-emerald-50 font-semibold">
                    Dates penciled in
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Water & tools checked</span>
                  <span className="text-emerald-50 font-semibold">
                    Systems tested
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Harvest & preservation plan</span>
                  <span className="text-emerald-50 font-semibold">
                    Windows & methods mapped
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
                  Resume Garden Season Session
                </button>
                <span className="text-[11px] text-emerald-100/80">
                  SessionRunner auto-resumes if a garden season session is still
                  running.
                </span>
              </div>
            </div>

            {/* Helpful tools / links */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5 shadow-lg shadow-slate-950/50">
              <h2 className="text-sm font-semibold text-slate-100 mb-2">
                Helpful tools for garden season setup
              </h2>
              <ul className="space-y-2 text-[11px] text-slate-300">
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>
                    <span className="font-semibold">
                      Seed Viability Calculator:
                    </span>{" "}
                    check which seed lots are worth trusting before you commit
                    trays or rows.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                  <span>
                    <span className="font-semibold">
                      Season Length & Calendar:
                    </span>{" "}
                    align frost dates and planting windows with your household
                    calendar and feast days.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
                  <span>
                    <span className="font-semibold">
                      Storehouse & Meal tools:
                    </span>{" "}
                    link key crops to the meals and shelf items they support so
                    you plant with purpose.
                  </span>
                </li>
                {familyFundMode && (
                  <li className="flex gap-2">
                    <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-indigo-400" />
                    <span>
                      <span className="font-semibold">Family Fund Hub:</span>{" "}
                      later, see how garden production, preservation, and
                      storehouse coverage change across seasons.
                    </span>
                  </li>
                )}
              </ul>

              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href="/calculators/garden/seed-viability"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Seed Viability Calculator
                </a>
                <a
                  href="/calculators/garden/season-length"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Season Length Planner
                </a>
                <a
                  href="/calculators/storehouse/duration"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Storehouse Duration
                </a>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Local informational modal */}
      <GardenSeasonFlowModal
        open={flowOpen}
        onClose={() => setFlowOpen(false)}
      />
    </div>
  );
}

export default GardenSeasonPlanningPage;

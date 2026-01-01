// C:\Users\larho\suka-smart-assistant\src\pages\planning\feast-prep.jsx
// -----------------------------------------------------------------------------
// FeastPrepPlanningPage
//
// How this fits the SSA system:
// - Lives under /planning as a “meta” page that orchestrates a multi-week
//   “feast preparation” flow using SSA domains:
//   • storehouse  – ingredients, offerings, serving supplies
//   • cooking     – menu trials, batch cooking, reheating plans
//   • cleaning    – zones schedule, guest spaces, dining areas
//   • garden      – harvest timing, bouquet / décor, herbs
//   • animals     – meat planning, timing, butchery sessions
//   • preservation – make-ahead components, leftovers, post-feast reset
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
// feast prep flow works. That modal is *not* the global SessionRunner.
// -----------------------------------------------------------------------------

import React, { useCallback, useState } from "react";
import { emitEvent } from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";

/**
 * Emit a “play the next runnable session now” request for Feast Preparation.
 *
 * The SessionRunner listener should:
 *   - look at domainHints + focusArea,
 *   - choose the next appropriate session from Dexie or drafts,
 *   - if multiple sessions are valid, use its own selector UI,
 *   - open the global SessionRunner modal and keep it alive across navigation.
 *
 * @param {("cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse")[]} domainHints
 * @param {string} focusArea Short label like "feast-menu", "guest-zones", etc.
 */
function requestNextSession(domainHints, focusArea) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "FeastPrepPlanningPage",
      data: {
        domainHints,
        reason: "feast-preparation",
        focusArea,
        meta: {
          page: "planning/feast-prep",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[FeastPrepPlanning] Failed to emit session.requestNext", err);
  }
}

/**
 * Local modal describing the full Feast Preparation flow.
 * This is NOT the SessionRunner — just info for this page.
 */
function FeastPrepFlowModal({ open, onClose }) {
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
            Feast Preparation Flow Overview
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
              Feast Preparation
            </span>{" "}
            process for major feast days and special gatherings. The goal is to
            protect your peace: fewer last-minute scrambles and more time to
            enjoy the day.
          </p>

          <ol className="list-decimal list-inside space-y-1.5">
            <li>
              <span className="font-semibold">Fix the dates and theme:</span>{" "}
              confirm the feast timing from your calendar tools and decide what
              the day should feel like (quiet / joyful / village-style, etc.).
            </li>
            <li>
              <span className="font-semibold">Align menu and storehouse:</span>{" "}
              use storehouse and nutrition tools to build a menu that matches
              your shelves and your people&apos;s needs.
            </li>
            <li>
              <span className="font-semibold">Prepare the home:</span> run short
              cleaning sessions by zone so guest and household areas are ready
              without burnout.
            </li>
            <li>
              <span className="font-semibold">Garden & animals:</span> time
              harvests and animal processing so fresh items land exactly when
              needed, not weeks too early or a day too late.
            </li>
            <li>
              <span className="font-semibold">Preserve & reset:</span> use
              preservation sessions to handle leftovers and rotate the
              storehouse after the feast, so you start the next cycle strong.
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
            enabled, completed feast-related sessions can export anonymous
            analytics to your Hub, helping you refine menus, timelines, and
            resource use from feast to feast.
          </p>
        )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-full bg-emerald-500 px-4 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-300"
          >
            Let&apos;s Prepare
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Reusable phase card for the Feast Preparation flow.
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

function FeastPrepPlanningPage() {
  const [flowOpen, setFlowOpen] = useState(false);

  // CTA handlers for different focus areas
  const handleNowFullPlan = useCallback(() => {
    requestNextSession(
      ["storehouse", "cooking", "cleaning", "garden", "animals", "preservation"],
      "feast-preparation-plan"
    );
  }, []);

  const handleNowDatesTheme = useCallback(() => {
    requestNextSession(["storehouse"], "feast-dates-and-theme");
  }, []);

  const handleNowMenu = useCallback(() => {
    requestNextSession(["cooking", "storehouse"], "feast-menu-and-rotation");
  }, []);

  const handleNowHousePrep = useCallback(() => {
    requestNextSession(["cleaning"], "feast-zone-cleaning");
  }, []);

  const handleNowGardenAnimals = useCallback(() => {
    requestNextSession(["garden", "animals", "storehouse"], "feast-garden-animals");
  }, []);

  const handleNowPreservationReset = useCallback(() => {
    requestNextSession(["preservation", "storehouse"], "feast-leftovers-reset");
  }, []);

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-50 flex flex-col">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur-sm">
        <div className="mx-auto max-w-6xl px-4 py-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl md:text-2xl font-semibold tracking-tight">
              Feast Preparation Planner
            </h1>
            <p className="text-sm text-slate-400 max-w-2xl">
              Plan and run your feast days with calm: align dates, menu,
              storehouse, cleaning, garden, animals, and preservation—powered by
              the SessionRunner so the work stays organized.
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
              <span>Start Feast Prep Now</span>
            </button>
            <p className="text-[11px] text-slate-500">
              Opens the next runnable{" "}
              <span className="font-semibold text-slate-300">
                storehouse / cooking / cleaning / garden / animals / preservation
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
              Completed feast prep sessions can be exported to the Hub to help
              you refine timing, menus, and resource use for future feasts.
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
                    1. Fix dates, theme, and scale
                  </h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Confirm when your feast falls this cycle and what kind of
                    gathering you&apos;re hosting: quiet household, extended
                    family, or full village.
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
                    Calendar & year-length tools
                  </p>
                  <ul className="list-disc list-inside space-y-1 text-[11px] text-slate-300">
                    <li>Scriptural year length & feast timing</li>
                    <li>Household calendar overview for the feast week</li>
                    <li>Offering planning tied to actual resources</li>
                  </ul>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a
                      href="/calculators/calendar/scriptural-year-length"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Scriptural Year Length
                    </a>
                    <a
                      href="/calculators/calendar/biblical-offering"
                      className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                    >
                      Open Biblical Offering Planner
                    </a>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
                  <p className="text-[11px] text-slate-400 mb-1">
                    Quick feast scope session
                  </p>
                  <p className="text-[11px] text-slate-300 mb-1">
                    Use a short planning session to decide guest list, time
                    window, and the feel of the day so later choices are easier.
                  </p>
                  <button
                    type="button"
                    onClick={handleNowDatesTheme}
                    className="inline-flex items-center gap-1 rounded-full border border-emerald-500/70 bg-emerald-500/10 px-3 py-1.5 text-[11px] text-emerald-200 hover:bg-emerald-500/20"
                  >
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
                    Run Feast Scope Session
                  </button>
                </div>
              </div>
            </div>

            {/* Phase 1: Menu & storehouse alignment */}
            <PhaseCard
              title="2. Phase One – Menu & Storehouse Alignment"
              subtitle="Build a feast menu that your shelves and people can support."
              description="Start with what you already have and what your household actually eats. Then add special feast dishes on top of a stable base."
              bullets={[
                "List required elements (bread, wine/juice, key feast dishes, staples).",
                "Use storehouse and nutrition tools to build a menu that matches current inventory.",
                "Plan make-ahead dishes and day-of dishes so the kitchen workload is realistic.",
              ]}
              ctaLabel="Run a Feast Menu Planning Session"
              onNow={handleNowMenu}
            />

            {/* Phase 2: House prep & guest comfort */}
            <PhaseCard
              title="3. Phase Two – House Preparation & Guest Comfort"
              subtitle="Prepare zones in layers so you don't burn out."
              description="Instead of an all-at-once cleaning marathon, use short, timed sessions focused on the rooms that matter most for the feast."
              bullets={[
                "Identify feast-critical zones: entry, bathrooms, dining, serving, kids' area.",
                "Schedule 15–30 minute cleaning sessions across the week instead of one huge day.",
                "Set up tableware, seating, and lighting in advance where possible.",
              ]}
              ctaLabel="Run a Feast Zone Cleaning Session"
              onNow={handleNowHousePrep}
            />

            {/* Phase 3: Garden & animals contributions */}
            <PhaseCard
              title="4. Phase Three – Garden & Animals Feeding the Feast"
              subtitle="Time harvest and animals so they support the menu."
              description="Use garden and animal sessions to bring herbs, vegetables, and meat into the feast at the right time, instead of guessing."
              bullets={[
                "Mark which feast dishes can be supplied by garden or animals.",
                "Plan harvest and processing sessions in the days/weeks before the feast.",
                "Use smaller sessions to prep herbs, stock, broth, and cuts ahead of time.",
              ]}
              ctaLabel="Run a Garden / Animals Feast Session"
              onNow={handleNowGardenAnimals}
            />

            {/* Phase 4: Preservation & post-feast reset */}
            <PhaseCard
              title="5. Phase Four – Preservation & Post-Feast Reset"
              subtitle="Handle leftovers and reset the storehouse calmly."
              description="Plan preservation sessions for leftovers and a light cleaning / storehouse reset so the feast doesn't leave you drained."
              bullets={[
                "Decide beforehand which leftovers will become ready meals (freezer, canning, drying).",
                "Run a preservation session 1–2 days after the feast to handle extra food safely.",
                "Use a short storehouse session to rotate older items and re-balance shelves.",
              ]}
              ctaLabel="Run a Leftovers / Storehouse Reset Session"
              onNow={handleNowPreservationReset}
            />
          </section>

          {/* Right: Feast mini dashboard + links */}
          <section className="space-y-4">
            {/* Mini dashboard */}
            <div className="rounded-2xl border border-emerald-500/50 bg-emerald-500/10 p-4 md:p-5 shadow-xl shadow-emerald-950/50">
              <h2 className="text-sm font-semibold text-emerald-100 mb-2">
                Feast Prep Snapshot
              </h2>
              <p className="text-[11px] text-emerald-100/80">
                Use this as a small mental checklist while you prepare. Later,
                you can connect it to actual analytics if you want automation.
              </p>

              <div className="mt-3 grid gap-2 text-[11px] text-emerald-100/90">
                <div className="flex items-center justify-between">
                  <span>Dates & theme confirmed</span>
                  <span className="rounded-full bg-emerald-900/70 px-2 py-0.5 border border-emerald-400/60 text-[10px]">
                    Calendar & offerings aligned
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Menu & storehouse alignment</span>
                  <span className="text-emerald-50 font-semibold">
                    Core dishes mapped to shelves
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>House prep progress</span>
                  <span className="text-emerald-50 font-semibold">
                    Zones scheduled via sessions
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span>Post-feast reset plan</span>
                  <span className="text-emerald-50 font-semibold">
                    Preservation & storehouse reset ready
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
                  Resume Feast Prep Session
                </button>
                <span className="text-[11px] text-emerald-100/80">
                  SessionRunner auto-resumes if a feast prep session is still
                  running.
                </span>
              </div>
            </div>

            {/* Helpful tools / links */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 md:p-5 shadow-lg shadow-slate-950/50">
              <h2 className="text-sm font-semibold text-slate-100 mb-2">
                Helpful tools for feast preparation
              </h2>
              <ul className="space-y-2 text-[11px] text-slate-300">
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  <span>
                    <span className="font-semibold">Scriptural Year & Calendar:</span>{" "}
                    see exactly where the feast sits in the year and how much
                    time you have to prepare.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-sky-400" />
                  <span>
                    <span className="font-semibold">Biblical Offering Planner:</span>{" "}
                    match offerings to real resources in your storehouse and
                    fields instead of guessing.
                  </span>
                </li>
                <li className="flex gap-2">
                  <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-fuchsia-400" />
                  <span>
                    <span className="font-semibold">Macro / Nutrition tools:</span>{" "}
                    keep feast meals joyful but still kind to your people&apos;s
                    bodies (especially those with health needs).
                  </span>
                </li>
                {familyFundMode && (
                  <li className="flex gap-2">
                    <span className="mt-[3px] inline-block h-1.5 w-1.5 rounded-full bg-indigo-400" />
                    <span>
                      <span className="font-semibold">Family Fund Hub:</span>{" "}
                      later, see feast-to-feast trends in how much food you
                      needed, how early you started, and which sessions helped
                      the most.
                    </span>
                  </li>
                )}
              </ul>

              <div className="mt-3 flex flex-wrap gap-2">
                <a
                  href="/calculators/calendar/scriptural-year-length"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Scriptural Year Length
                </a>
                <a
                  href="/calculators/calendar/biblical-offering"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Biblical Offering Planner
                </a>
                <a
                  href="/calculators/health/macros"
                  className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                >
                  Open Macro & Nutrition Planner
                </a>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Local informational modal */}
      <FeastPrepFlowModal open={flowOpen} onClose={() => setFlowOpen(false)} />
    </div>
  );
}

export default FeastPrepPlanningPage;

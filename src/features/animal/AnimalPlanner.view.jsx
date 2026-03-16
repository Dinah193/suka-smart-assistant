// C:\Users\larho\suka-smart-assistant\src\features\animal\AnimalPlanner.view.jsx
// -----------------------------------------------------------------------------
// AnimalPlannerView
//
// How this fits the SSA system:
// - This is a feature-level view for planning animal acquisition, breeding,
//   and usage (meat, dairy, eggs, fiber, labor).
// - It is meant to be embedded in an Animals page (e.g. /animals/planner)
//   or a broader Homestead / Planning section.
//
// - It does NOT run timers or sessions directly. Instead, it:
//   • exposes “Now” CTAs that emit `session.requestNext` with domain hints
//     focused on animals, garden, storehouse, preservation, and cooking,
//   • expects the global SessionRunner (mounted at app root) to:
//       - choose and launch the next runnable session,
//       - keep running across navigation,
//       - use wake-lock, notifications, Web Worker timers, PiP, etc.,
//       - write checkpoints to Dexie and auto-resume,
//       - emit session.* events and optionally export to the Hub.
//
// Contracts used here:
// - eventBus.emitEvent({ type, ts, source, data })
// - featureFlags.familyFundMode (boolean)
// - Session domains: cooking | cleaning | garden | animals | preservation | storehouse
//
// Extension points:
// - You can pass a `summary` prop with real stats (current herd sizes, egg
//   counts, etc.). This component will render graceful defaults if no data is
//   provided.
// - You can later wire the “Open details” links to actual dashboards or
//   calculators (yield curves, meat breakdown, feed calculators, etc.).
// -----------------------------------------------------------------------------

import React, { useCallback } from "react";
import { emitEvent } from "@/services/events/eventBus";
import { familyFundMode } from "@/config/featureFlags";

/**
 * Emit a “play the next runnable session now” request for animal planning.
 *
 * The SessionRunner listener should:
 *   - look at domainHints + focusArea,
 *   - choose the next appropriate animals-related session from Dexie/drafts,
 *   - if multiple sessions are valid, use its own selector UI,
 *   - open the global SessionRunner modal and keep it alive across navigation.
 *
 * @param {("cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse")[]} domainHints
 * @param {string} focusArea Short label like "animal-acquisition", "breeding-calendar", etc.
 */
function requestNextSession(domainHints, focusArea) {
  try {
    const ts = new Date().toISOString();
    emitEvent({
      type: "session.requestNext",
      ts,
      source: "AnimalPlannerView",
      data: {
        domainHints,
        reason: "animal-planning",
        focusArea,
        meta: {
          feature: "animal/AnimalPlanner",
        },
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[AnimalPlannerView] Failed to emit session.requestNext",
      err
    );
  }
}

/**
 * Small stat pill used in the top summary row.
 *
 * @param {{ label: string, value: string, hint?: string }} props
 */
function StatPill({ label, value, hint }) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-2 flex flex-col gap-0.5 shadow-md shadow-slate-950/40">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-slate-500">
          {label}
        </span>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" />
      </div>
      <span className="text-sm font-semibold text-slate-50">{value}</span>
      {hint && <span className="text-[10px] text-slate-400">{hint}</span>}
    </div>
  );
}

/**
 * Reusable planning card section.
 */
function PlanningCard({
  title,
  subtitle,
  description,
  bullets,
  onNow,
  nowLabel,
  children,
}) {
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

      {children}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {onNow && (
          <button
            type="button"
            onClick={onNow}
            className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 shadow-md shadow-emerald-500/25 hover:bg-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-300 focus:ring-offset-2 focus:ring-offset-slate-950"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-900 animate-pulse" />
            <span>{nowLabel || "Run a Session Now"}</span>
          </button>
        )}
        <span className="text-[11px] text-slate-500">
          Opens in the SessionRunner modal and keeps running if you navigate
          away.
        </span>
      </div>
    </div>
  );
}

/**
 * @typedef {Object} AnimalPlannerSummary
 * @property {string} [meatPipeline]    Human-readable line about current / planned meat animals.
 * @property {string} [eggsDairy]       Human-readable line about egg & dairy animals.
 * @property {string} [fiberLabor]      Human-readable line about fiber & work animals.
 * @property {string} [focusNote]       General note about current animal focus.
 */

/**
 * AnimalPlannerView
 *
 * @param {{ summary?: AnimalPlannerSummary }} props
 */
function AnimalPlannerView({ summary }) {
  const safeSummary = summary || {};
  const meatPipeline = safeSummary.meatPipeline || "No pipeline mapped yet";
  const eggsDairy = safeSummary.eggsDairy || "No steady egg/dairy plan yet";
  const fiberLabor =
    safeSummary.fiberLabor || "No fiber or work animals planned";
  const focusNote =
    safeSummary.focusNote ||
    "Use this planner to map animals to real uses: meals, milk, eggs, fiber, and work.";

  const handleNowAcquisition = useCallback(() => {
    requestNextSession(
      ["animals", "storehouse", "garden"],
      "animal-acquisition-plan"
    );
  }, []);

  const handleNowBreeding = useCallback(() => {
    requestNextSession(["animals", "storehouse"], "animal-breeding-calendar");
  }, []);

  const handleNowUsage = useCallback(() => {
    requestNextSession(
      ["animals", "cooking", "preservation", "storehouse"],
      "animal-usage-flow"
    );
  }, []);

  const handleNowRiskResilience = useCallback(() => {
    requestNextSession(
      ["animals", "storehouse", "garden"],
      "animal-risk-resilience"
    );
  }, []);

  return (
    <div className="w-full flex flex-col gap-4 md:gap-5">
      {/* Header / context */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-base md:text-lg font-semibold tracking-tight text-slate-50">
            Animal Planner – Acquisition, Breeding, & Usage
          </h1>
          <p className="text-[11px] md:text-[12px] text-slate-400 max-w-xl">
            Map how animals enter, move through, and leave your household: from
            chicks and lambs to breeding adults and finally to meals, milk,
            eggs, fiber, or work power—connected to your storehouse and garden
            goals.
          </p>
        </div>

        {familyFundMode && (
          <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[10px] text-emerald-100 max-w-xs">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-300" />
              <span className="font-semibold">Family Fund Mode is ON.</span>
            </div>
            <p>
              Completed animal-planning sessions can export anonymous analytics
              to your Hub, so you can see meat, egg, and milk trends over time.
            </p>
          </div>
        )}
      </div>

      {/* Top summary row */}
      <section className="grid gap-2 md:grid-cols-4">
        <StatPill
          label="Meat pipeline"
          value={meatPipeline}
          hint="Which animals are moving toward butcher weight, and when."
        />
        <StatPill
          label="Eggs & dairy"
          value={eggsDairy}
          hint="Layers, dairy animals, and expected daily yield."
        />
        <StatPill
          label="Fiber & labor"
          value={fiberLabor}
          hint="Sheep/goats for fiber, animals for hauling or guarding."
        />
        <div className="rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-2 flex flex-col justify-between shadow-md shadow-slate-950/40">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">
            Current focus
          </span>
          <p className="text-[11px] text-slate-200 mt-0.5">{focusNote}</p>
          <span className="mt-1 text-[10px] text-slate-500">
            Tip: Start with one small improvement (e.g., egg cycle) instead of
            all animals at once.
          </span>
        </div>
      </section>

      {/* Main planning layout */}
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.8fr)_minmax(0,1.4fr)]">
        {/* Left: main flows */}
        <div className="space-y-4">
          {/* Acquisition & on-ramp */}
          <PlanningCard
            title="1. Acquisition & On-Ramp"
            subtitle="Decide what animals to bring in, why, and how they'll be housed and fed."
            description="Plan intentional acquisitions instead of impulse buys. Tie each animal type to a clear role in your system and make sure you have housing, feed, and exit plans ready."
            bullets={[
              "Choose species and breeds that match your climate, feed, and goals.",
              "Define how many animals your land, time, and budget can actually support.",
              "Prepare housing, fencing, and starter feed before animals arrive.",
            ]}
            onNow={handleNowAcquisition}
            nowLabel="Run Acquisition Planning Session"
          >
            <div className="grid gap-2 md:grid-cols-2 text-[11px] text-slate-300">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Acquisition reasons
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Meat (quick turnover vs. slow growers)</li>
                  <li>Eggs or milk (steady daily yield)</li>
                  <li>Fiber, guarding, or hauling/work</li>
                </ul>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Quick links
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <a
                    href="/calculators/storehouse/duration"
                    className="inline-flex items-center rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                  >
                    Storehouse Duration
                  </a>
                  <a
                    href="/features/calculators/storehouseMeals/MeatBreakdown"
                    className="inline-flex items-center rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                  >
                    Meat Breakdown Calculator
                  </a>
                </div>
              </div>
            </div>
          </PlanningCard>

          {/* Breeding & calendar */}
          <PlanningCard
            title="2. Breeding Calendar & Replacement Strategy"
            subtitle="Keep your herd or flock at the right size without chaos."
            description="Plan when animals breed, when babies arrive, and when they leave the system. Align births with forage peaks, weather windows, and your butcher/preservation capacity."
            bullets={[
              "Choose breeding windows that match pasture, feed, and shelter limits.",
              "Plan how many females and males you need to maintain your target numbers.",
              "Define cull/replacement rules so decisions are easier under stress.",
            ]}
            onNow={handleNowBreeding}
            nowLabel="Run Breeding Calendar Session"
          >
            <div className="grid gap-2 md:grid-cols-2 text-[11px] text-slate-300">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Breeding patterns
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Single annual breeding vs staggered cycles</li>
                  <li>Align births with mild weather and forage peaks</li>
                  <li>Group animals by age class for easier decisions</li>
                </ul>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Exit & replacement
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Cull for age, health, temperament, or productivity</li>
                  <li>Plan butcher dates and preservation weekends</li>
                  <li>Mark keepers early to avoid last-minute stress</li>
                </ul>
              </div>
            </div>
          </PlanningCard>

          {/* Usage & flow */}
          <PlanningCard
            title="3. Usage Flow – Meat, Milk, Eggs, Fiber, and Work"
            subtitle="Make sure every animal has a clear job and exit plan."
            description="Connect animals directly to menus, storehouse items, and work tasks so they’re not just pets eating money."
            bullets={[
              "Map which animals supply which foods on which weeks or seasons.",
              "Decide how much milk/eggs/fiber you actually need to justify each animal.",
              "Connect butcher dates to batch cooking and preservation sessions.",
            ]}
            onNow={handleNowUsage}
            nowLabel="Run Usage & Flow Session"
          >
            <div className="grid gap-2 md:grid-cols-3 text-[11px] text-slate-300">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Food flows
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Weekly eggs & milk into meal plans</li>
                  <li>Quarterly meat into batch cooking sessions</li>
                  <li>Bone & organ use into broths and special recipes</li>
                </ul>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Preservation
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Curing, smoking, and freezing plans</li>
                  <li>Pressure canning sessions for shelf-stable meat</li>
                  <li>Rendered fat, stocks, and broth storage</li>
                </ul>
              </div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Fiber & work
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  <li>Shearing intervals and fiber storage</li>
                  <li>Guard animals or hauling animals workload</li>
                  <li>Rotate work to protect animal health</li>
                </ul>
              </div>
            </div>
          </PlanningCard>
        </div>

        {/* Right: risk, resilience, and “Now” shortcuts */}
        <div className="space-y-4">
          {/* Risk & resilience card */}
          <PlanningCard
            title="4. Risk & Resilience"
            subtitle="Plan for disease, feed shocks, and sudden changes."
            description="A calm plan for worst days makes good days easier. Decide what you’ll do if you need to shrink the herd, lose a feed source, or face vet issues."
            bullets={[
              "Define your minimum and maximum animal counts for different scenarios.",
              "Have a short list of animals to sell or butcher first if feed gets tight.",
              "Plan isolation, quarantine, and basic medical response steps.",
            ]}
            onNow={handleNowRiskResilience}
            nowLabel="Run Risk & Resilience Session"
          >
            <div className="mt-1 grid gap-2 text-[11px] text-slate-300">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-2.5">
                <p className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
                  Related dashboards
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <a
                    href="/calculators/storehouse/duration"
                    className="inline-flex items-center rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                  >
                    Storehouse Duration
                  </a>
                  <a
                    href="/planning/food-stabilization"
                    className="inline-flex items-center rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                  >
                    Food Stabilization Flow
                  </a>
                  <a
                    href="/planning/garden-season"
                    className="inline-flex items-center rounded-full border border-slate-700 bg-slate-900 px-2.5 py-1 text-[10px] text-slate-200 hover:border-emerald-400 hover:text-emerald-200"
                  >
                    Garden Season Setup
                  </a>
                </div>
              </div>
            </div>
          </PlanningCard>

          {/* Quick “Now” shortcut panel */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg shadow-slate-950/50 flex flex-col gap-3">
            <h2 className="text-sm font-semibold text-slate-100">
              Quick Animal Planning Sessions
            </h2>
            <p className="text-[11px] text-slate-300">
              Use these shortcuts if you only have 10–20 minutes. The
              SessionRunner keeps the session alive even if you click around to
              other SSA tools.
            </p>
            <div className="grid gap-2 text-[11px] text-slate-200">
              <button
                type="button"
                onClick={handleNowAcquisition}
                className="inline-flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 hover:border-emerald-400 hover:bg-slate-900"
              >
                <span>Fast: clarify next animal acquisition</span>
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                  Now
                </span>
              </button>
              <button
                type="button"
                onClick={handleNowBreeding}
                className="inline-flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 hover:border-emerald-400 hover:bg-slate-900"
              >
                <span>Fast: update breeding / birth calendar</span>
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                  Now
                </span>
              </button>
              <button
                type="button"
                onClick={handleNowUsage}
                className="inline-flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 hover:border-emerald-400 hover:bg-slate-900"
              >
                <span>Fast: map next butcher / usage block</span>
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
                  Now
                </span>
              </button>
            </div>
            <p className="text-[10px] text-slate-500">
              Tip: Once you finish a session, the analytics layer can later show
              you patterns like how many meat animals per year actually reached
              the freezer vs. what you planned.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

export default AnimalPlannerView;

// src/components/meals/IntegratedTaskParser.jsx
/**
 * IntegratedTaskParser  (name kept for now, but we speak in terms of steps/flows)
 *
 * DOMAIN ROLE (WEB OF MEANING):
 * - Primary domain: cooking / meals (steps for preparing dishes).
 * - Connected domains:
 *   - storehouse/provisioning (cooling, portioning, freezing/canning),
 *   - cleaning/hygiene (cleanup cycles, dish flow),
 *   - garden/animals (scraps → compost or feed),
 *   - feasts/events (aligning flows to a serving window).
 *
 * CONCEPT:
 * - Take a set of recipes for a batch or feast and turn them into
 *   integrated *household steps*:
 *   - prep steps across recipes can be grouped,
 *   - cooking steps show the heat rhythm,
 *   - cooling/storehouse steps show preservation rhythm,
 *   - cleanup/compost steps close the cycle back toward the garden.
 *
 * TOOL MODE:
 * - Given only `recipes`, parses a combined step list on the fly.
 * - No external dependencies required.
 *
 * STEWARDSHIP MODE:
 * - When `stewardshipMode` and `sessionId` are present, emits events to
 *   the eventBus and can notify downstream planners (storehouse,
 *   cleaning, garden) that integrated steps are ready.
 *
 * EVENTS:
 * - planning.integratedSteps.updated
 *   - Fired whenever the integrated steps are recalculated.
 * - planning.integratedSteps.sentToStorehouse
 * - planning.integratedSteps.sentToCleaning
 * - planning.integratedSteps.sentToGarden
 *
 * TODO[seasons]:
 * - Accept seasonal context (e.g. feast window, Sabbath prep window)
 *   and annotate steps with `seasonTag` so other domains can prioritize.
 *
 * TODO[dependencies]:
 * - Use dependencyMap/intelligence layer to better classify steps
 *   instead of purely keyword heuristics.
 *
 * TODO[insights]:
 * - Summaries about:
 *   - how many steps land in each domain/phase,
 *   - which recipes generate the biggest cleaning/preservation burden,
 *   - average prep vs cooking vs cleanup time for a given feast cycle.
 */

import React, { useEffect, useMemo, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";

export default function IntegratedTaskParser({
  recipes = [],                // [{ id, title, steps?, ingredients?, slot?, mode?, tags? }]
  stewardshipMode = false,     // false = TOOL MODE, true = STEWARDSHIP MODE
  sessionId = null,            // cooking/batch session id
  seasonContext = null,        // optional { seasonKey, feastKey, dayLabel, ... }
  onStepsParsed,               // (steps) => void
  onAttachTimers,              // optional: (timerPresets) => feed MultiTimerPanel
  onSyncStorehouse,            // optional: (storehouseSteps) => void
}) {
  const [viewGrouping, setViewGrouping] = useState("phase"); // 'phase' | 'domain'
  const [includeCleanup, setIncludeCleanup] = useState(true);
  const [includeCompost, setIncludeCompost] = useState(true);

  // Derived label for mode
  const modeContext = stewardshipMode ? "stewardship" : "tool";

  // --------------- Parse integrated steps from recipes ---------------

  const integrated = useMemo(() => {
    const options = {
      includeCleanup,
      includeCompost,
      seasonContext,
    };
    const steps = parseIntegratedSteps(recipes, options);

    // Optional presets for MultiTimerPanel: only for cooking/storehouse steps
    const timerPresets = steps
      .filter((s) => ["cook", "storehouse"].includes(s.phase) && s.estimatedMinutes > 0)
      .map((s) => ({
        id: `timer-from-step-${s.id}`,
        label: s.label,
        channel: s.phase === "storehouse" ? "storehouse" : s.feastAligned ? "feast" : "immediate",
        totalSeconds: s.estimatedMinutes * 60,
        recipeId: s.recipeId,
        stepLabel: s.label,
        sessionId,
      }));

    return { steps, timerPresets };
  }, [JSON.stringify(recipes), includeCleanup, includeCompost, JSON.stringify(seasonContext), sessionId]);

  const { steps, timerPresets } = integrated;

  // Grouping for UI
  const grouped = useMemo(() => {
    if (viewGrouping === "domain") {
      return groupByDomain(steps);
    }
    return groupByPhase(steps);
  }, [steps, viewGrouping]);

  const summary = useMemo(() => summarizeSteps(steps), [steps]);

  // --------------- Emit updates + notify parent / automation ----------

  useEffect(() => {
    if (onStepsParsed) onStepsParsed(steps);
    if (onAttachTimers && timerPresets.length) onAttachTimers(timerPresets);

    // Core event: integrated steps updated
    eventBus?.emit?.("planning.integratedSteps.updated", {
      context: modeContext,
      sessionId,
      seasonContext,
      summary,
      stepsCount: steps.length,
    });

    // TODO[insights]: automation?.("intelligence.planning.integratedSteps.update", {
    //   context: modeContext,
    //   sessionId,
    //   steps,
    //   summary,
    // });
  }, [JSON.stringify(steps), JSON.stringify(timerPresets), modeContext, sessionId, JSON.stringify(seasonContext)]);

  // --------------- Actions to send slices to other domains ------------

  async function handleSendToStorehouse() {
    const storehouseSteps = steps.filter((s) => s.domain === "storehouse");
    if (!storehouseSteps.length) return;

    onSyncStorehouse?.(storehouseSteps);

    eventBus?.emit?.("planning.integratedSteps.sentToStorehouse", {
      context: modeContext,
      sessionId,
      count: storehouseSteps.length,
    });

    // TODO: call into storehouse planning engine when ready.
    // await automation?.("storehouse.integratedSteps.apply", { sessionId, steps: storehouseSteps });
  }

  async function handleSendToCleaning() {
    const cleaningSteps = steps.filter((s) => s.domain === "cleaning");
    if (!cleaningSteps.length) return;

    eventBus?.emit?.("planning.integratedSteps.sentToCleaning", {
      context: modeContext,
      sessionId,
      count: cleaningSteps.length,
    });

    // TODO: cleaning rhythm engine integration:
    // await automation?.("cleaning.integratedSteps.apply", { sessionId, steps: cleaningSteps });
  }

  async function handleSendToGarden() {
    const gardenSteps = steps.filter((s) => s.domain === "garden");
    if (!gardenSteps.length) return;

    eventBus?.emit?.("planning.integratedSteps.sentToGarden", {
      context: modeContext,
      sessionId,
      count: gardenSteps.length,
    });

    // TODO: garden/compost planner integration:
    // await automation?.("garden.integratedSteps.apply", { sessionId, steps: gardenSteps });
  }

  // --------------- Render ---------------------------------------------

  const showEmpty = !steps.length;

  return (
    <div className="rounded-2xl border border-base-200 bg-base-100 shadow-md flex flex-col min-h-[260px]">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-base-200 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
            Integrated Steps View
          </div>
          <div className="text-xs text-base-content/70 truncate">
            Joined-up steps across recipes: prep, cooking, storehouse, cleanup, and compost —
            shaped into a single meal cycle.
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-base-content/60">
          <span className="px-2 py-1 rounded-full bg-base-200">
            {summary.total} steps in this cycle
          </span>
          <span className="px-2 py-1 rounded-full bg-base-200">
            {summary.byPhase.cook || 0} heat steps • {summary.byPhase.storehouse || 0} storehouse steps
          </span>
        </div>
      </div>

      {/* Controls */}
      <div className="px-4 py-2 border-b border-base-200 flex flex-wrap items-center gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="font-medium">View rhythm as:</span>
          <div className="join">
            <button
              className={cx(
                "btn btn-xs join-item",
                viewGrouping === "phase" ? "btn-primary" : "btn-ghost"
              )}
              onClick={() => setViewGrouping("phase")}
            >
              Phases
            </button>
            <button
              className={cx(
                "btn btn-xs join-item",
                viewGrouping === "domain" ? "btn-primary" : "btn-ghost"
              )}
              onClick={() => setViewGrouping("domain")}
            >
              Domains
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={includeCleanup}
              onChange={(e) => setIncludeCleanup(e.target.checked)}
            />
            <span>Include cleanup steps</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              className="checkbox checkbox-xs"
              checked={includeCompost}
              onChange={(e) => setIncludeCompost(e.target.checked)}
            />
            <span>Include compost/leftover steps</span>
          </label>
        </div>
        {seasonContext && (
          <div className="ml-auto flex items-center gap-2 text-[11px]">
            <span className="px-2 py-1 rounded-full bg-base-200">
              {seasonContext.feastKey ? `Feast: ${seasonContext.feastKey}` : seasonContext.dayLabel || "Seasonal cycle"}
            </span>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 p-4 overflow-auto">
        {showEmpty ? (
          <EmptySteps />
        ) : (
          <div className="space-y-4">
            {grouped.map((group) => (
              <StepGroup key={group.key} group={group} />
            ))}
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="px-4 py-3 border-t border-base-200 flex flex-wrap items-center gap-2 text-xs">
        <button
          className="btn btn-outline btn-xs"
          onClick={handleSendToStorehouse}
          disabled={!steps.some((s) => s.domain === "storehouse")}
        >
          Send cooling & storage steps to Storehouse
        </button>
        <button
          className="btn btn-outline btn-xs"
          onClick={handleSendToCleaning}
          disabled={!steps.some((s) => s.domain === "cleaning")}
        >
          Send cleanup steps to Cleaning rhythm
        </button>
        <button
          className="btn btn-outline btn-xs"
          onClick={handleSendToGarden}
          disabled={!steps.some((s) => s.domain === "garden")}
        >
          Send scraps/compost to Garden
        </button>
        <div className="ml-auto text-[11px] text-base-content/60">
          {sessionId ? (
            <>Linked to session: {sessionId}</>
          ) : (
            <>No session attached — parsing this as a one-time meal cycle.</>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Subcomponents ------------------------------ */

function StepGroup({ group }) {
  return (
    <div className="border border-base-200 rounded-xl bg-base-100">
      <div className="px-3 py-2 border-b border-base-200 flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-wide">
            {group.label}
          </span>
          <span className="text-[11px] text-base-content/70">
            {group.count} step{group.count === 1 ? "" : "s"} • {group.domainsLabel}
          </span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-base-content/60">
          {group.estimateMinutes > 0 && (
            <span className="px-2 py-1 rounded-full bg-base-200">
              ~{group.estimateMinutes} min
            </span>
          )}
        </div>
      </div>
      <div className="p-2 space-y-1">
        {group.steps.map((s) => (
          <StepRow key={s.id} step={s} />
        ))}
      </div>
    </div>
  );
}

function StepRow({ step }) {
  const {
    label,
    phase,
    domain,
    recipeTitle,
    estimatedMinutes,
    feastAligned,
  } = step;

  const phaseColor =
    phase === "prep"
      ? "badge-info"
      : phase === "cook"
      ? "badge-primary"
      : phase === "storehouse"
      ? "badge-success"
      : phase === "clean"
      ? "badge-warning"
      : "badge-ghost";

  const domainLabel = {
    cooking: "Cooking",
    storehouse: "Storehouse",
    cleaning: "Cleaning",
    garden: "Garden/Compost",
  }[domain];

  return (
    <div className="rounded-lg px-2 py-1 flex items-center gap-2 hover:bg-base-200/40 transition">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={cx("badge badge-xs", phaseColor)}>
            {humanPhase(phase)}
          </span>
          <span className="text-xs font-medium truncate">{label}</span>
        </div>
        <div className="text-[11px] text-base-content/70 mt-0.5 flex flex-wrap items-center gap-2">
          {recipeTitle && <span className="truncate">From: {recipeTitle}</span>}
          <span className="px-1.5 py-0.5 rounded-full bg-base-200">
            {domainLabel}
          </span>
          {estimatedMinutes > 0 && (
            <span>~{estimatedMinutes} min</span>
          )}
          {feastAligned && (
            <span className="text-[10px] uppercase tracking-wide text-base-content/60">
              Aligned to feast window
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptySteps() {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-6 text-center bg-base-100">
      <div className="text-sm font-semibold">
        No integrated steps yet
      </div>
      <p className="text-xs text-base-content/70 mt-1 max-w-md mx-auto">
        Once you select recipes for a batch or feast, this view will weave their
        prep, cooking, storehouse, and cleanup into a single household rhythm.
      </p>
    </div>
  );
}

/* ------------------------------ Parsing Logic ------------------------------ */

/**
 * Step shape produced by parser:
 * {
 *   id: string,
 *   recipeId: string,
 *   recipeTitle: string,
 *   phase: "prep" | "cook" | "storehouse" | "clean" | "garden",
 *   domain: "cooking" | "storehouse" | "cleaning" | "garden",
 *   label: string,
 *   estimatedMinutes: number,
 *   feastAligned: boolean,
 *   order: number,
 * }
 */
function parseIntegratedSteps(recipes, { includeCleanup, includeCompost, seasonContext }) {
  if (!Array.isArray(recipes) || !recipes.length) return [];

  const steps = [];
  let orderCounter = 0;

  const feastAligned = Boolean(seasonContext?.feastKey);

  for (const recipe of recipes) {
    const baseTitle = recipe?.title || "Untitled dish";
    const rid = recipe?.id || baseTitle;

    // If explicit step data is present, parse it directly.
    if (Array.isArray(recipe.steps) && recipe.steps.length) {
      for (const rawStep of recipe.steps) {
        const text = typeof rawStep === "string" ? rawStep : rawStep.text || "";
        if (!text.trim()) continue;

        const phase = classifyPhase(text);
        const domain = phaseToDomain(phase);
        const minutes = inferMinutes(rawStep, text);

        steps.push({
          id: `r-${rid}-s-${orderCounter}`,
          recipeId: rid,
          recipeTitle: baseTitle,
          phase,
          domain,
          label: normalizeLabel(text),
          estimatedMinutes: minutes,
          feastAligned,
          order: orderCounter++,
        });
      }
    } else {
      // No steps? Create a minimal rhythm so the householder still has a flow.
      const baseMinutes = inferBaseMinutes(recipe);

      const minimal = [
        {
          phase: "prep",
          domain: "cooking",
          label: `Gather and prep ingredients for ${baseTitle}`,
          estimatedMinutes: Math.round(baseMinutes * 0.3),
        },
        {
          phase: "cook",
          domain: "cooking",
          label: `Cook ${baseTitle}`,
          estimatedMinutes: Math.round(baseMinutes * 0.5),
        },
        {
          phase: "storehouse",
          domain: "storehouse",
          label: `Cool and portion any leftover ${baseTitle} for storehouse`,
          estimatedMinutes: Math.round(baseMinutes * 0.2),
        },
      ];

      minimal.forEach((m) => {
        steps.push({
          id: `r-${rid}-s-${orderCounter}`,
          recipeId: rid,
          recipeTitle: baseTitle,
          phase: m.phase,
          domain: m.domain,
          label: m.label,
          estimatedMinutes: m.estimatedMinutes,
          feastAligned,
          order: orderCounter++,
        });
      });
    }

    // Cleanup & compost as closing rhythm for the dish
    if (includeCleanup) {
      steps.push({
        id: `r-${rid}-cleanup-${orderCounter}`,
        recipeId: rid,
        recipeTitle: baseTitle,
        phase: "clean",
        domain: "cleaning",
        label: `Wash dishes and wipe surfaces after working on ${baseTitle}`,
        estimatedMinutes: 5,
        feastAligned,
        order: orderCounter++,
      });
    }
    if (includeCompost) {
      steps.push({
        id: `r-${rid}-compost-${orderCounter}`,
        recipeId: rid,
        recipeTitle: baseTitle,
        phase: "garden",
        domain: "garden",
        label: `Collect suitable scraps from ${baseTitle} for compost or animal feed`,
        estimatedMinutes: 3,
        feastAligned,
        order: orderCounter++,
      });
    }
  }

  // Sort by phase order first (prep → cook → storehouse → clean → garden), then by order index
  const phaseOrder = { prep: 0, cook: 1, storehouse: 2, clean: 3, garden: 4 };
  steps.sort((a, b) => {
    const pa = phaseOrder[a.phase] ?? 99;
    const pb = phaseOrder[b.phase] ?? 99;
    if (pa !== pb) return pa - pb;
    return a.order - b.order;
  });

  return steps;
}

function classifyPhase(text) {
  const t = (text || "").toLowerCase();
  if (matchAny(t, ["preheat", "chop", "slice", "dice", "marinate", "mix", "whisk", "season", "prep"])) {
    return "prep";
  }
  if (matchAny(t, ["bake", "roast", "fry", "sauté", "boil", "simmer", "grill", "cook", "pressure cook"])) {
    return "cook";
  }
  if (matchAny(t, ["cool", "chill", "freeze", "refrigerate", "portion", "jar", "can", "vacuum seal", "store"])) {
    return "storehouse";
  }
  if (matchAny(t, ["wash dishes", "wash pots", "wipe", "clean", "scrub", "clear counter", "rinse"])) {
    return "clean";
  }
  if (matchAny(t, ["compost", "scraps", "peels", "feed", "chicken", "goats", "pigs"])) {
    return "garden";
  }
  // Default assumption: most cooking instructions are prep/cook
  if (matchAny(t, ["add", "stir", "combine", "pour"])) return "cook";
  return "prep";
}

function phaseToDomain(phase) {
  switch (phase) {
    case "storehouse":
      return "storehouse";
    case "clean":
      return "cleaning";
    case "garden":
      return "garden";
    default:
      return "cooking";
  }
}

function inferMinutes(step, text) {
  if (typeof step === "object" && typeof step.minutes === "number" && step.minutes > 0) {
    return step.minutes;
  }
  const m = (text || "").match(/(\d+)\s*(minutes|min|mins|hours|hrs|hr)/i);
  if (m) {
    const val = Number(m[1] || 0);
    if (!Number.isFinite(val) || val <= 0) return 0;
    if (/hour|hr/i.test(m[2] || "")) return val * 60;
    return val;
  }
  return 0;
}

function inferBaseMinutes(recipe) {
  const n = Number(recipe?.estimatedMinutes || recipe?.totalMinutes || 45);
  return Number.isFinite(n) && n > 0 ? n : 45;
}

function normalizeLabel(text) {
  const t = (text || "").trim();
  if (!t) return "Household step";
  // Keep it simple; full wording comes from the recipe.
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function matchAny(str, needles) {
  return needles.some((n) => str.includes(n));
}

/* ------------------------------ Grouping & Summary ------------------------ */

function groupByPhase(steps) {
  const groupsMap = new Map(); // phase -> { key, label, steps }
  const phaseLabel = {
    prep: "Prep & gathering",
    cook: "Heat & cooking",
    storehouse: "Cooling & storehouse",
    clean: "Cleaning rhythm",
    garden: "Compost & scraps",
  };
  const phaseOrder = { prep: 0, cook: 1, storehouse: 2, clean: 3, garden: 4 };

  for (const s of steps) {
    const key = s.phase;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        key,
        label: phaseLabel[key] || key,
        steps: [],
      });
    }
    groupsMap.get(key).steps.push(s);
  }

  const groups = Array.from(groupsMap.values());
  for (const g of groups) {
    g.count = g.steps.length;
    g.estimateMinutes = g.steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
    const domains = new Set(g.steps.map((s) => s.domain));
    g.domainsLabel = Array.from(domains)
      .map((d) => ({ cooking: "Cooking", storehouse: "Storehouse", cleaning: "Cleaning", garden: "Garden/Compost" }[d] || d))
      .join(" • ");
  }

  groups.sort((a, b) => (phaseOrder[a.key] ?? 99) - (phaseOrder[b.key] ?? 99));
  return groups;
}

function groupByDomain(steps) {
  const groupsMap = new Map(); // domain -> { key, label, steps }
  const domainLabel = {
    cooking: "Cooking steps",
    storehouse: "Storehouse & preservation steps",
    cleaning: "Cleaning & dish flow",
    garden: "Garden/compost & animal feed",
  };

  for (const s of steps) {
    const key = s.domain;
    if (!groupsMap.has(key)) {
      groupsMap.set(key, {
        key,
        label: domainLabel[key] || key,
        steps: [],
      });
    }
    groupsMap.get(key).steps.push(s);
  }

  const groups = Array.from(groupsMap.values());
  for (const g of groups) {
    g.count = g.steps.length;
    g.estimateMinutes = g.steps.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
    const phases = new Set(g.steps.map((s) => s.phase));
    g.domainsLabel = Array.from(phases)
      .map((p) => humanPhase(p))
      .join(" • ");
  }

  // simple order: cooking, storehouse, cleaning, garden
  const order = { cooking: 0, storehouse: 1, cleaning: 2, garden: 3 };
  groups.sort((a, b) => (order[a.key] ?? 99) - (order[b.key] ?? 99));
  return groups;
}

function summarizeSteps(steps) {
  const summary = {
    total: steps.length,
    byPhase: {},
    byDomain: {},
  };
  for (const s of steps) {
    summary.byPhase[s.phase] = (summary.byPhase[s.phase] || 0) + 1;
    summary.byDomain[s.domain] = (summary.byDomain[s.domain] || 0) + 1;
  }
  return summary;
}

function humanPhase(phase) {
  switch (phase) {
    case "prep":
      return "Prep";
    case "cook":
      return "Cook";
    case "storehouse":
      return "Storehouse";
    case "clean":
      return "Clean";
    case "garden":
      return "Compost";
    default:
      return phase;
  }
}

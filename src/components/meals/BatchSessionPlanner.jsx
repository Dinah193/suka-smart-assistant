// src/components/meals/BatchSessionPlanner.jsx
/**
 * BatchSessionPlanner
 *
 * DOMAIN ROLE (WEB OF MEANING):
 * - Primary domain: cooking / meals (batch cooking sessions).
 * - Connected domains: storehouse/provisioning (freezer/root-cellar), preservation,
 *   feasts/events, garden/animals (future yields).
 *
 * CONCEPT:
 * - This is where the householder shapes a batch cooking "session" as part of a meal rhythm
 *   and storehouse cycle, not just a pile of tasks.
 *
 * TOOL MODE:
 * - Works standalone:
 *   - Accepts dropped recipes (React DnD "RECIPE_CARD").
 *   - Lets the user name the session, pick a rhythm (e.g., “Weeknight”, “Feast prep”),
 *     and choose focus: cook-for-now vs cook-for-storehouse.
 *   - Summarizes servings and simple yield posture.
 *
 * STEWARDSHIP MODE:
 * - Same UI, but emits richer events so other domains can respond:
 *   - storehouse can project how much will move to freezer/root-cellar.
 *   - feasts/events can see a “pre-feast” session approaching.
 *   - SessionRunner can start a cooking session that spans domains.
 *
 * EVENTS:
 * - batchSession.queue.updated
 * - batchSession.savedDraft
 * - batchSession.startRequested
 *
 * TODO[seasons]:
 * - Integrate seasonal engine to suggest:
 *   - in-season ingredients,
 *   - feast windows (e.g., upcoming Sabbaths/feasts) as presets for sessionRhythm.
 *
 * TODO[dependencies]:
 * - Allow sessions to declare upstream dependencies:
 *   - “requires frozen chicken from storehouse”,
 *   - “pairs with preservation: pressure canning”.
 *
 * TODO[insights]:
 * - Emit a roll-up for the insights engine:
 *   - total protein/yield,
 *   - reliance on storehouse vs fresh,
 *   - which rhythms are most used across months.
 */

import React, { useMemo, useState } from "react";
import { useDrop } from "react-dnd";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";

// Optional: hook into a shared BatchQueue store if present
let useBatchQueue;
try {
  useBatchQueue = require("@/store/BatchQueueStore").useBatchQueue;
} catch {}

/**
 * Props:
 * - stewardshipMode: boolean      // false = TOOL MODE, true = STEWARDSHIP MODE
 * - currentSeasonLabel: string    // e.g. "Spring Planting", "Feast Season"
 * - currentCycleLabel: string     // e.g. "Weeknight rhythm"
 * - queuedRecipes: Recipe[]       // optional override; else comes from useBatchQueue
 * - onQueueChange(nextQueue)      // called when recipes are added/removed/reordered
 * - onSessionCreated(session)     // called after a draft session is saved
 * - onRequestRunSession(session)  // called when householder presses "Start Session Now"
 */
export default function BatchSessionPlanner({
  stewardshipMode = false,
  currentSeasonLabel,
  currentCycleLabel = "Everyday meal rhythm",
  queuedRecipes: queuedRecipesProp,
  onQueueChange,
  onSessionCreated,
  onRequestRunSession,
}) {
  const queueStore = useBatchQueue?.();
  const queuedRecipes =
    queuedRecipesProp ??
    queueStore?.recipes ??
    [];

  const [sessionName, setSessionName] = useState("Batch Cooking Session");
  const [sessionRhythm, setSessionRhythm] = useState("weeknight"); // weeknight | feast-prep | storehouse-replenish | mutual-aid
  const [focusStorehouse, setFocusStorehouse] = useState(true);
  const [focusImmediateMeals, setFocusImmediateMeals] = useState(true);
  const [notes, setNotes] = useState("");

  const [busy, setBusy] = useState(false);

  const modeContext = stewardshipMode ? "stewardship" : "tool";

  // React DnD: accept recipes dropped from RecipeVault (type: "RECIPE_CARD")
  const [, dropRef] = useDrop({
    accept: "RECIPE_CARD",
    drop: (item) => {
      const recipe = item?.recipe || item;
      if (!recipe || !recipe.id) return;
      handleAddRecipe(recipe);
    },
  });

  const totals = useMemo(() => {
    let servings = 0;
    let calories = 0;
    let protein = 0;
    queuedRecipes.forEach((r) => {
      const sv = Number(r.servings || 1);
      const n = r.nutrition || {};
      servings += sv;
      calories += (n.calories || 0) * sv;
      protein += (n.protein || 0) * sv;
    });
    return {
      servings,
      calories: Math.round(calories),
      protein: Math.round(protein),
    };
  }, [queuedRecipes]);

  const sessionDraft = useMemo(
    () => ({
      id: null, // will be set by automation/session engine
      domain: "cooking.batch",
      name: sessionName,
      rhythm: sessionRhythm,
      focus: {
        immediateMeals: focusImmediateMeals,
        storehouse: focusStorehouse,
      },
      season: currentSeasonLabel || null,
      cycleLabel: currentCycleLabel,
      recipes: queuedRecipes.map((r) => ({
        id: r.id,
        title: r.title,
        servings: r.servings || 1,
        slot: r.slot || null,
        mode: r.mode || null,
      })),
      yieldSummary: totals,
      notes,
      createdAt: new Date().toISOString(),
      modeContext,
    }),
    [
      sessionName,
      sessionRhythm,
      focusImmediateMeals,
      focusStorehouse,
      currentSeasonLabel,
      currentCycleLabel,
      queuedRecipes,
      totals,
      notes,
      modeContext,
    ]
  );

  // ------------------- Handlers -------------------

  function handleAddRecipe(recipe) {
    const exists = queuedRecipes.some((r) => r.id === recipe.id);
    const next = exists
      ? queuedRecipes
      : [...queuedRecipes, recipe];

    if (onQueueChange) onQueueChange(next);
    else if (queueStore?.setRecipes) queueStore.setRecipes(next);

    eventBus?.emit?.("batchSession.queue.updated", {
      context: modeContext,
      reason: "add",
      recipeId: recipe.id,
      queueSize: next.length,
    });
  }

  function handleRemoveRecipe(id) {
    const next = queuedRecipes.filter((r) => r.id !== id);

    if (onQueueChange) onQueueChange(next);
    else if (queueStore?.setRecipes) queueStore.setRecipes(next);

    eventBus?.emit?.("batchSession.queue.updated", {
      context: modeContext,
      reason: "remove",
      recipeId: id,
      queueSize: next.length,
    });
  }

  async function handleSaveDraft() {
    if (!queuedRecipes.length) {
      alert("Add at least one recipe to shape a batch session.");
      return;
    }

    setBusy(true);
    try {
      const res = await automation?.("sessions.saveDraft", {
        session: sessionDraft,
      });

      const saved = res?.session || {
        ...sessionDraft,
        id: res?.id || null,
      };

      eventBus?.emit?.("batchSession.savedDraft", {
        session: saved,
      });

      // TODO[insights]: hook for progression/skill engines:
      // eventBus?.emit?.("progression.stewardship.sessionPlanned", { domain: "cooking", session: saved });

      onSessionCreated?.(saved);
    } finally {
      setBusy(false);
    }
  }

  async function handleStartNow() {
    if (!queuedRecipes.length) {
      alert("Add at least one recipe before starting the session.");
      return;
    }

    setBusy(true);
    try {
      // Ask automation/session runner to start a cooking session
      const res = await automation?.("sessions.start", {
        domain: "cooking.batch",
        session: sessionDraft,
      });

      const runningSession = res?.session || sessionDraft;

      eventBus?.emit?.("batchSession.startRequested", {
        session: runningSession,
      });

      // Let SessionRunner or parent open the actual runner UI
      onRequestRunSession?.(runningSession);
    } finally {
      setBusy(false);
    }
  }

  // ------------------- Render -------------------

  return (
    <div
      ref={dropRef}
      className={cx(
        "rounded-2xl border border-base-200 bg-base-100 shadow-md flex flex-col",
        "min-h-[260px]"
      )}
    >
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-base-200 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
            Batch Session Planner
          </div>
          <div className="text-xs text-base-content/70 truncate">
            Shape a cooking session that serves your meal rhythm and storehouse
            {currentSeasonLabel && (
              <>
                {" "}
                • Season:{" "}
                <span className="font-medium">
                  {currentSeasonLabel}
                </span>
              </>
            )}
            {stewardshipMode ? (
              <> • Connected to storehouse & feast planning</>
            ) : (
              <> • Standalone — ready to connect later</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-base-content/70">
          <span className="px-2 py-1 rounded-full bg-base-200">
            {queuedRecipes.length} recipes in this session
          </span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 flex flex-col gap-4 flex-1">
        {/* Top row: basic session framing */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="space-y-1">
            <label className="label-text text-xs font-medium">
              Session name
            </label>
            <input
              className="input input-bordered input-sm w-full"
              value={sessionName}
              onChange={(e) => setSessionName(e.target.value)}
              placeholder="e.g. Sabbath-eve stews & grain pots"
            />
          </div>

          <div className="space-y-1">
            <label className="label-text text-xs font-medium">
              Meal rhythm
            </label>
            <select
              className="select select-bordered select-sm w-full"
              value={sessionRhythm}
              onChange={(e) => setSessionRhythm(e.target.value)}
            >
              <option value="weeknight">
                Weeknight cycle (simple daily rhythm)
              </option>
              <option value="feast-prep">
                Feast prep (before Sabbaths & feasts)
              </option>
              <option value="storehouse-replenish">
                Storehouse replenish (freeze/can for later)
              </option>
              <option value="mutual-aid">
                Mutual-aid cooking day (sharing with others)
              </option>
            </select>
            {currentCycleLabel && (
              <div className="text-[11px] text-base-content/60">
                Current cycle:{" "}
                <span className="font-medium">{currentCycleLabel}</span>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label className="label-text text-xs font-medium">
              Focus of this session
            </label>
            <div className="flex flex-col gap-1 text-xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={focusImmediateMeals}
                  onChange={(e) =>
                    setFocusImmediateMeals(e.target.checked)
                  }
                />
                <span>
                  Cook for this week&apos;s meals
                </span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  className="checkbox checkbox-xs"
                  checked={focusStorehouse}
                  onChange={(e) =>
                    setFocusStorehouse(e.target.checked)
                  }
                />
                <span>
                  Build up storehouse (freezer/root cellar)
                </span>
              </label>
            </div>
          </div>
        </div>

        {/* Middle: queue + yield summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {/* Queue list */}
          <div className="md:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <div className="text-xs font-medium uppercase tracking-wide text-base-content/70">
                Recipes in this session
              </div>
              <div className="text-[11px] text-base-content/60">
                Drop recipes here from your Recipe Vault
              </div>
            </div>
            <div className="border border-dashed border-base-300 rounded-xl p-2 min-h-[84px] bg-base-100">
              {queuedRecipes.length === 0 ? (
                <div className="text-[11px] text-base-content/60 text-center py-4">
                  No recipes added yet. Drop cards from your Recipe Vault
                  or use any &quot;Send to Batch&quot; controls to begin
                  shaping this session.
                </div>
              ) : (
                <ul className="space-y-1 text-xs">
                  {queuedRecipes.map((r) => (
                    <li
                      key={r.id}
                      className="flex items-center justify-between gap-2 px-2 py-1 rounded-lg bg-base-200/60"
                    >
                      <div className="min-w-0">
                        <div className="font-medium truncate">
                          {r.title}
                        </div>
                        <div className="text-[11px] text-base-content/70 truncate">
                          {r.cuisine || "—"} • {r.slot || "Any"} •{" "}
                          {r.mode || "Home"}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="badge badge-ghost badge-xs">
                          {Math.max(1, r.servings || 1)} sv
                        </span>
                        <button
                          className="btn btn-ghost btn-xs"
                          onClick={() => handleRemoveRecipe(r.id)}
                          title="Remove from this session"
                        >
                          ✕
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Yield summary */}
          <div className="space-y-2">
            <div className="text-xs font-medium uppercase tracking-wide text-base-content/70">
              Yield snapshot
            </div>
            <div className="rounded-xl border border-base-200 bg-base-100 p-3 text-xs space-y-1">
              <div className="flex items-center justify-between">
                <span>Total servings</span>
                <span className="font-semibold">
                  {totals.servings}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Approx. calories cooked</span>
                <span className="font-semibold">
                  {totals.calories.toLocaleString()} kcal
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span>Approx. protein cooked</span>
                <span className="font-semibold">
                  {totals.protein.toLocaleString()} g
                </span>
              </div>
              <div className="mt-2 text-[11px] text-base-content/60">
                In stewardship mode, this yield can inform your
                storehouse posture and future provision insights.
              </div>
            </div>
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <label className="label-text text-xs font-medium">
            Session notes (e.g., who you are feeding, feast prep, or
            preservation plans)
          </label>
          <textarea
            className="textarea textarea-bordered textarea-xs w-full"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Example: Double the stews and freeze half for lean weeks. Prep Sabbath soups and grain pots. Reserve bones for stock."
          />
        </div>
      </div>

      {/* Footer actions */}
      <div className="px-4 py-3 border-t border-base-200 flex items-center gap-3">
        <button
          className="btn btn-outline btn-sm"
          onClick={handleSaveDraft}
          disabled={busy || !queuedRecipes.length}
        >
          Save Session Draft
        </button>
        <button
          className="btn btn-primary btn-sm"
          onClick={handleStartNow}
          disabled={busy || !queuedRecipes.length}
        >
          Start Session Now
        </button>
        <div className="ml-auto text-[11px] text-base-content/60">
          {stewardshipMode ? (
            <>This session will echo into storehouse & rhythms.</>
          ) : (
            <>Standalone view — no storehouse changes yet.</>
          )}
        </div>
      </div>
    </div>
  );
}

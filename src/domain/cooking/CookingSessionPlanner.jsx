// src/domain/cooking/CookingSessionPlanner.jsx
//
// CookingSessionPlanner
// ---------------------
// UI orchestrator for turning Cooking UI input → Vault artifact → StepGraph → Session.
//
// Pipeline role (front-end side):
//   1. User fills Cooking UI (ingredients, steps, options).
//   2. CookingSessionPlanner calls VaultSavePipeline.saveArtifactToVault({ domain: "cooking" }).
//      - imports → normalize → StepGraph → classification → compliance → save to Vault → (optional) Hub export
//   3. If compliance status = "needsReview"/"blocked":
//      - emit "adapt wizard" callback so UI can help user edit the recipe.
//   4. If compliant or user forces save:
//      - call RecipeSessionEngine.createCookingSession(...) to create & persist a session.
//      - session is then ready for SessionRunner / automation runtime.
//
// NOTE:
// - This component *does not* directly talk to Dexie/DB or the Hub.
//   All persistence + Hub export is handled by VaultSavePipeline & RecipeSessionEngine.
// - It *does* emit UI-level events on the shared eventBus so analytics/automation
//   can observe planning behavior without coupling to UI internals.

import React, { useState } from "react";

import { emitEvent } from "../../services/eventBus";
import { saveArtifactToVault } from "../../services/vault/VaultSavePipeline";
import { createCookingSession } from "./RecipeSessionEngine";
import { COMPLIANCE_STATUS } from "../../services/compliance/ComplianceContract";

const MODULE_SOURCE = "domain.cooking.CookingSessionPlanner";

/**
 * Props:
 * - householdId: string | null
 * - initialRawInput: optional raw cooking input from UI (ingredients, steps, etc.)
 * - existingArtifact: optional pre-normalized cooking artifact (e.g., loaded from Vault)
 * - onSessionCreated: (session, context) => void
 * - onRequireAdaptWizard: (artifact, ctx) => void
 */
export default function CookingSessionPlanner({
  householdId,
  initialRawInput = null,
  existingArtifact = null,
  onSessionCreated,
  onRequireAdaptWizard,
}) {
  const [scheduledFor, setScheduledFor] = useState("");
  const [label, setLabel] = useState("");
  const [playNow, setPlayNow] = useState(true);
  const [forceSave, setForceSave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lastStatus, setLastStatus] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;

    setBusy(true);
    setError("");
    setLastStatus(null);

    const ts = new Date().toISOString();
    const hId = normalizeHouseholdId(householdId);

    emitSafe({
      type: "ui.cooking.session.plan.requested",
      ts,
      source: MODULE_SOURCE,
      data: {
        householdId: hId,
        playNow,
        hasExistingArtifact: !!existingArtifact,
        hasInitialRawInput: !!initialRawInput,
        scheduledFor,
      },
    });

    try {
      // 1) Save or re-evaluate artifact via VaultSavePipeline
      const vaultResult = await saveArtifactToVault({
        domain: "cooking",
        householdId: hId,
        rawInput: existingArtifact ? null : initialRawInput,
        options: {
          forceSave,
        },
      });

      setLastStatus(vaultResult.status || null);

      const artifact =
        vaultResult?.artifact || existingArtifact || initialRawInput || null;

      if (!artifact) {
        throw new Error(
          "Vault did not return an artifact; cannot create session."
        );
      }

      // 2) Compliance decision: do we need adaptation?
      if (vaultResult.needsAdaptation && !forceSave) {
        emitSafe({
          type: "ui.cooking.session.plan.needsAdaptation",
          ts: new Date().toISOString(),
          source: MODULE_SOURCE,
          data: {
            householdId: hId,
            complianceStatus: vaultResult.status,
          },
        });

        if (typeof onRequireAdaptWizard === "function") {
          onRequireAdaptWizard(artifact, {
            householdId: hId,
            compliance: vaultResult.compliance,
            classifiedItems: vaultResult.classifiedItems || [],
          });
        }

        setBusy(false);
        return;
      }

      // 3) Create cooking session from artifact
      const sessionLabel =
        label && label.trim()
          ? label.trim()
          : artifact.title || "Cooking Session";

      const {
        session,
        stepGraph,
        error: sessionError,
      } = await createCookingSession({
        householdId: hId,
        artifact,
        sessionOptions: {
          label: sessionLabel,
          scheduledFor: playNow ? new Date() : scheduledFor || null,
        },
        options: {
          persist: true,
        },
      });

      if (sessionError) {
        throw new Error(sessionError);
      }

      emitSafe({
        type: "ui.cooking.session.plan.completed",
        ts: new Date().toISOString(),
        source: MODULE_SOURCE,
        data: {
          householdId: hId,
          sessionId: session?.id || null,
          artifactId: session?.artifactId || null,
          scheduledFor: session?.scheduledFor || null,
          status: session?.status || null,
        },
      });

      // 4) Notify parent
      if (typeof onSessionCreated === "function") {
        onSessionCreated(session, {
          artifact,
          stepGraph,
          compliance: vaultResult.compliance || null,
          classifiedItems: vaultResult.classifiedItems || [],
        });
      }

      // OPTIONAL: if playNow, parent can immediately open SessionRunner modal.
    } catch (err) {
      const msg =
        err && typeof err.message === "string"
          ? err.message
          : "Failed to plan cooking session.";
      setError(msg);

      emitSafe({
        type: "ui.cooking.session.plan.failed",
        ts: new Date().toISOString(),
        source: MODULE_SOURCE,
        data: {
          householdId: normalizeHouseholdId(householdId),
          reason: msg,
        },
      });
    } finally {
      setBusy(false);
    }
  };

  const complianceLabel = (() => {
    if (!lastStatus) return null;
    if (lastStatus === COMPLIANCE_STATUS.COMPLIANT) {
      return "Compliant";
    }
    if (lastStatus === COMPLIANCE_STATUS.NEEDS_REVIEW) {
      return "Needs Review";
    }
    if (lastStatus === COMPLIANCE_STATUS.BLOCKED) {
      return "Blocked";
    }
    return lastStatus;
  })();

  return (
    <form
      onSubmit={handleSubmit}
      className="cooking-session-planner space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
    >
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-slate-800">
          Plan Cooking Session
        </h2>
        <p className="text-sm text-slate-500">
          SSA will normalize your recipe, check it against your household
          profile, and create a multi-timer session ready for the SessionRunner.
        </p>
      </header>

      <div className="space-y-3">
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-slate-700">
            Session label
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Sabbath Dinner Batch, Weekly Prep"
            className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
          />
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
            <input
              type="checkbox"
              checked={playNow}
              onChange={(e) => setPlayNow(e.target.checked)}
              className="h-4 w-4"
            />
            Play immediately after creation
          </label>

          <div className="flex flex-col gap-1 sm:items-end">
            <label className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Schedule (optional)
            </label>
            <input
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              disabled={playNow}
              className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-100 sm:w-auto"
            />
            <p className="text-xs text-slate-400">
              Leave empty for &quot;as soon as possible.&quot;
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
          <span className="font-semibold text-slate-700">
            Compliance &amp; Adaptation
          </span>
          <p>
            SSA will check this recipe against your household profile
            (Torah/diet, allergens, cleaning/garden bans, health goals). If it{" "}
            <span className="font-semibold">needs review</span> or is{" "}
            <span className="font-semibold">blocked</span>, you&apos;ll be asked
            to adapt it before it becomes a session.
          </p>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={forceSave}
              onChange={(e) => setForceSave(e.target.checked)}
              className="h-4 w-4"
            />
            Force save even if flagged{" "}
            <span className="font-semibold">(expert use only)</span>
          </label>
          {complianceLabel && (
            <p className="text-xs">
              Last compliance status:{" "}
              <span className="font-semibold">{complianceLabel}</span>
            </p>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-400">
          SSA pipeline: UI → Vault → StepGraph → Session → Runner
        </div>
        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-wait disabled:bg-indigo-400"
        >
          {busy ? "Planning..." : playNow ? "Plan & Play" : "Plan Session"}
        </button>
      </div>
    </form>
  );
}

/* --------------------------------- Helpers ---------------------------------- */

function normalizeHouseholdId(householdId) {
  if (!householdId || typeof householdId !== "string") return "default";
  const trimmed = householdId.trim();
  return trimmed || "default";
}

function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;

  try {
    emitEvent(payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[CookingSessionPlanner] Failed to emit event", err);
    }
  }
}

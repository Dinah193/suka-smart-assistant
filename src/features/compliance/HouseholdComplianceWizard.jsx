// src/features/compliance/HouseholdComplianceWizard.jsx
//
// HouseholdComplianceWizard
// -------------------------
// Shared “Adapt to Household” wizard component.
//
// Pipeline role:
//   VaultSavePipeline → ComplianceEngine → (status = needsReview|blocked)
//   → <HouseholdComplianceWizard /> → user adapts artifact
//   → onResolve(adaptedArtifact) → VaultSavePipeline re-runs
//     StepGraph + Compliance + Save → (optional) Hub export
//
// This component is intentionally domain-agnostic but domain-aware:
//   - It receives a domain ("cooking" | "cleaning" | "garden" | "animals").
//   - It reads compliance metadata (hardViolations, softConflicts, allergenRisks).
//   - It provides simple, opinionated tools to adapt artifacts:
//       • Swap ingredient/material (e.g., pork → beef/lamb; bleach → peroxide)
//       • Remove step/ingredient/material
//       • Mark as “guest-only / blocked for household”
//   - It emits events for observability via the shared eventBus.
//
// IMPORTANT: This component does NOT persist any data and does NOT export to Hub.
// Those responsibilities live in VaultSavePipeline and SessionEngines.

import React, { useEffect, useMemo, useState } from "react";
import { emitEvent } from "../../services/eventBus";

const MODULE_SOURCE = "features.compliance.HouseholdComplianceWizard";

/**
 * Props:
 *  - domain: "cooking" | "cleaning" | "garden" | "animals"
 *  - artifact: normalized artifact object (from domain adapter)
 *  - compliance: { status, hardViolations, softConflicts, allergenRisks }
 *  - onResolve: (adaptedArtifact) => void
 *  - onCancel: () => void
 */
export default function HouseholdComplianceWizard({
  domain,
  artifact,
  compliance,
  onResolve,
  onCancel,
}) {
  const [adaptations, setAdaptations] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const normalizedDomain = normalizeDomain(domain);

  const entries = useMemo(
    () => buildViolationEntries(normalizedDomain, compliance),
    [normalizedDomain, compliance]
  );

  useEffect(() => {
    const ts = new Date().toISOString();
    emitSafe({
      type: "compliance.wizard.opened",
      ts,
      source: MODULE_SOURCE,
      data: {
        domain: normalizedDomain,
        artifactId: artifact?.id || null,
        complianceStatus: compliance?.status || null,
        hardCount: entries.hard.length,
        softCount: entries.soft.length,
        allergenCount: entries.allergen.length,
      },
    });
  }, [normalizedDomain, artifact, compliance, entries]);

  const handleChangeAction = (entryKey, action) => {
    setAdaptations((prev) => ({
      ...prev,
      [entryKey]: {
        ...(prev[entryKey] || {}),
        action,
      },
    }));
  };

  const handleChangeSwapValue = (entryKey, value) => {
    setAdaptations((prev) => ({
      ...prev,
      [entryKey]: {
        ...(prev[entryKey] || {}),
        action: prev[entryKey]?.action || "swap",
        replacementName: value,
      },
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (submitting) return;

    setSubmitting(true);
    setError("");

    try {
      const allEntries = [
        ...entries.hard,
        ...entries.soft,
        ...entries.allergen,
      ];

      const adapted = applyAdaptationsToArtifact({
        domain: normalizedDomain,
        artifact,
        entries: allEntries,
        adaptations,
      });

      const ts = new Date().toISOString();
      emitSafe({
        type: "compliance.wizard.resolved",
        ts,
        source: MODULE_SOURCE,
        data: {
          domain: normalizedDomain,
          artifactId: artifact?.id || null,
          complianceStatusBefore: compliance?.status || null,
          entriesCount: allEntries.length,
        },
      });

      if (typeof onResolve === "function") {
        onResolve(adapted);
      }
    } catch (err) {
      const msg =
        err && typeof err.message === "string"
          ? err.message
          : "Failed to apply compliance adaptations.";
      setError(msg);

      const ts = new Date().toISOString();
      emitSafe({
        type: "compliance.wizard.failed",
        ts,
        source: MODULE_SOURCE,
        data: {
          domain: normalizedDomain,
          artifactId: artifact?.id || null,
          reason: msg,
        },
      });
    } finally {
      setSubmitting(false);
    }
  };

  const hasViolations =
    entries.hard.length || entries.soft.length || entries.allergen.length;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 px-4 py-8">
      <form
        onSubmit={handleSubmit}
        className="max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-xl"
      >
        <header className="flex items-start justify-between border-b border-slate-200 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">
              Adapt to Household Profile
            </h2>
            <p className="mt-1 text-xs text-slate-500">
              SSA detected items in this {normalizedDomain} artifact that
              conflict with your household&apos;s Torah, diet, allergy, or
              product constraints. Adjust them so this artifact can safely be
              used in sessions.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <span className="sr-only">Close</span>✕
          </button>
        </header>

        <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4 text-sm">
          {!hasViolations && (
            <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-800">
              SSA did not find any conflicts for this artifact. You can save as
              is, or cancel.
            </div>
          )}

          {hasViolations && (
            <>
              <ComplianceSummaryHeader
                domain={normalizedDomain}
                compliance={compliance}
                entries={entries}
              />

              <ViolationSection
                title="Hard Violations"
                subtitle="These directly conflict with your household profile and are blocked unless adapted."
                entries={entries.hard}
                domain={normalizedDomain}
                adaptations={adaptations}
                onChangeAction={handleChangeAction}
                onChangeSwapValue={handleChangeSwapValue}
              />

              <ViolationSection
                title="Soft Conflicts"
                subtitle="These are not strictly blocked, but they go against preferences or health goals."
                entries={entries.soft}
                domain={normalizedDomain}
                adaptations={adaptations}
                onChangeAction={handleChangeAction}
                onChangeSwapValue={handleChangeSwapValue}
              />

              <ViolationSection
                title="Allergen Risks"
                subtitle="Known or suspected allergen risks. Consider swapping or marking guest-only."
                entries={entries.allergen}
                domain={normalizedDomain}
                highlight="allergen"
                adaptations={adaptations}
                onChangeAction={handleChangeAction}
                onChangeSwapValue={handleChangeSwapValue}
              />
            </>
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-5 py-3 text-xs">
          <div className="flex flex-col gap-1 text-slate-500">
            <span>
              SSA pipeline: Vault → Compliance → Adapt Wizard → Vault re-check →
              StepGraph &amp; Sessions.
            </span>
            <span className="text-[11px]">
              Changes here mark the artifact as needing a new StepGraph before
              sessions run.
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:cursor-wait disabled:bg-indigo-400"
            >
              {submitting ? "Applying..." : "Apply Changes & Continue"}
            </button>
          </div>
        </footer>
      </form>
    </div>
  );
}

/* ------------------------------ Subcomponents -------------------------------- */

function ComplianceSummaryHeader({ domain, compliance, entries }) {
  const statusLabel = compliance?.status || "needsReview";
  const hardCount = entries.hard.length;
  const softCount = entries.soft.length;
  const allergenCount = entries.allergen.length;

  return (
    <section className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-1">
          <span className="font-semibold uppercase tracking-wide">
            Household Compliance: {statusLabel}
          </span>
          <span className="text-[11px] text-amber-800/90">
            Domain: {domain}. Update this artifact so it respects your
            household&apos;s Torah, diet, cleaning, and health constraints.
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-red-700">
            Hard: {hardCount}
          </span>
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-orange-700">
            Soft: {softCount}
          </span>
          <span className="rounded-full bg-rose-100 px-2 py-0.5 text-rose-700">
            Allergens: {allergenCount}
          </span>
        </div>
      </div>
    </section>
  );
}

function ViolationSection({
  title,
  subtitle,
  entries,
  domain,
  highlight,
  adaptations,
  onChangeAction,
  onChangeSwapValue,
}) {
  if (!entries.length) return null;

  return (
    <section className="space-y-2">
      <header>
        <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
        <p className="text-xs text-slate-500">{subtitle}</p>
      </header>

      <div className="space-y-2">
        {entries.map((entry) => (
          <ViolationRow
            key={entry.key}
            entry={entry}
            domain={domain}
            highlight={highlight}
            adaptation={adaptations[entry.key]}
            onChangeAction={onChangeAction}
            onChangeSwapValue={onChangeSwapValue}
          />
        ))}
      </div>
    </section>
  );
}

function ViolationRow({
  entry,
  domain,
  highlight,
  adaptation,
  onChangeAction,
  onChangeSwapValue,
}) {
  const action = adaptation?.action || "swap";
  const replacementName = adaptation?.replacementName || "";
  const suggestions = getDomainSwapSuggestions(domain, entry);

  const badgeClass =
    highlight === "allergen"
      ? "bg-rose-100 text-rose-700 border-rose-200"
      : entry.kind === "hard"
      ? "bg-red-100 text-red-700 border-red-200"
      : "bg-orange-100 text-orange-700 border-orange-200";

  return (
    <div className="flex flex-col gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5 text-xs">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] ${badgeClass}`}
            >
              {entry.kind === "hard"
                ? "Hard Violation"
                : entry.kind === "soft"
                ? "Soft Conflict"
                : "Allergen Risk"}
            </span>
            <span className="font-semibold text-slate-800">
              {entry.itemName}
            </span>
          </div>
          {entry.reason && (
            <span className="text-[11px] text-slate-600">
              Reason: {entry.reason}
            </span>
          )}
          {entry.tags && Object.keys(entry.tags).length > 0 && (
            <span className="text-[11px] text-slate-500">
              Tags:{" "}
              {Object.entries(entry.tags)
                .filter(([, v]) => Boolean(v))
                .map(([k]) => k)
                .join(", ")}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-md bg-white px-2 py-2 text-[11px] text-slate-700">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-slate-800">Action:</span>

          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`action-${entry.key}`}
              value="swap"
              checked={action === "swap"}
              onChange={() => onChangeAction(entry.key, "swap")}
            />
            Swap to a safer alternative
          </label>

          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`action-${entry.key}`}
              value="remove"
              checked={action === "remove"}
              onChange={() => onChangeAction(entry.key, "remove")}
            />
            Remove from this artifact
          </label>

          <label className="flex items-center gap-1">
            <input
              type="radio"
              name={`action-${entry.key}`}
              value="guestOnly"
              checked={action === "guestOnly"}
              onChange={() => onChangeAction(entry.key, "guestOnly")}
            />
            Mark as guest-only / blocked for household
          </label>
        </div>

        {action === "swap" && (
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-slate-700">
              Swap &quot;{entry.itemName}&quot; for:
            </label>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center">
              <input
                type="text"
                value={replacementName}
                onChange={(e) => onChangeSwapValue(entry.key, e.target.value)}
                placeholder="e.g. turkey bacon, oxygen cleaner, hand-weeding"
                className="flex-1 rounded-md border border-slate-300 px-2 py-1 text-xs outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
              />
              {!!suggestions.length && (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-[10px] text-slate-500">
                    Suggestions:
                  </span>
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => onChangeSwapValue(entry.key, s)}
                      className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-700 hover:bg-slate-100"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {action === "guestOnly" && (
          <p className="text-[11px] text-slate-500">
            SSA will mark this item as guest-only / blocked for household
            members. It will not be recommended in standard sessions, but may
            appear in special, explicitly guest-only contexts.
          </p>
        )}

        {action === "remove" && (
          <p className="text-[11px] text-slate-500">
            SSA will attempt to remove this item from ingredients/materials and
            related steps in this artifact.
          </p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Adaptation Logic ----------------------------- */

/**
 * Apply all adaptations to the artifact:
 *   - The exact mutation rules are domain-specific but conservative.
 *   - We avoid throwing if shapes differ; we just attempt best-effort edits.
 *
 * After changes, the artifact.sessionMeta.stepGraphReady is set to false so
 * VaultSavePipeline/SessionEngines will rebuild the StepGraph.
 */
function applyAdaptationsToArtifact({
  domain,
  artifact,
  entries,
  adaptations,
}) {
  if (!artifact || typeof artifact !== "object") return artifact;

  const clone = deepClone(artifact);
  const entryByKey = new Map(entries.map((e) => [e.key, e]));

  for (const [key, adaptation] of Object.entries(adaptations || {})) {
    const entry = entryByKey.get(key);
    if (!entry || !adaptation) continue;

    switch (domain) {
      case "cooking":
        adaptCookingArtifact(clone, entry, adaptation);
        break;
      case "cleaning":
        adaptCleaningArtifact(clone, entry, adaptation);
        break;
      case "garden":
        adaptGardenArtifact(clone, entry, adaptation);
        break;
      case "animals":
        adaptAnimalArtifact(clone, entry, adaptation);
        break;
      default:
        adaptGenericArtifact(clone, entry, adaptation);
        break;
    }
  }

  // force StepGraph rebuild on next save
  if (!clone.sessionMeta || typeof clone.sessionMeta !== "object") {
    clone.sessionMeta = { stepGraphReady: false, compliance: null };
  } else {
    clone.sessionMeta.stepGraphReady = false;
  }

  return clone;
}

function adaptCookingArtifact(artifact, entry, adaptation) {
  const action = adaptation.action || "swap";
  const replacementName = (adaptation.replacementName || "").trim();
  const targetName = normalizeName(entry.itemName);

  // top-level ingredients
  if (Array.isArray(artifact.ingredients)) {
    artifact.ingredients = adaptItemArrayByName(
      artifact.ingredients,
      targetName,
      action,
      replacementName
    );
  }

  // tasks[*].ingredients
  if (Array.isArray(artifact.tasks)) {
    artifact.tasks = artifact.tasks.map((task) => {
      if (!task || typeof task !== "object") return task;
      if (Array.isArray(task.ingredients)) {
        task.ingredients = adaptItemArrayByName(
          task.ingredients,
          targetName,
          action,
          replacementName
        );
      }
      return task;
    });
  }

  // consumes
  if (Array.isArray(artifact.consumes)) {
    artifact.consumes = adaptItemArrayByName(
      artifact.consumes,
      targetName,
      action,
      replacementName
    );
  }
}

function adaptCleaningArtifact(artifact, entry, adaptation) {
  const action = adaptation.action || "swap";
  const replacementName = (adaptation.replacementName || "").trim();
  const targetName = normalizeName(entry.itemName);

  if (Array.isArray(artifact.materials)) {
    artifact.materials = adaptItemArrayByName(
      artifact.materials,
      targetName,
      action,
      replacementName
    );
  }

  if (Array.isArray(artifact.tasks)) {
    artifact.tasks = artifact.tasks.map((task) => {
      if (!task || typeof task !== "object") return task;
      if (Array.isArray(task.materials)) {
        task.materials = adaptItemArrayByName(
          task.materials,
          targetName,
          action,
          replacementName
        );
      }
      return task;
    });
  }

  if (Array.isArray(artifact.consumes)) {
    artifact.consumes = adaptItemArrayByName(
      artifact.consumes,
      targetName,
      action,
      replacementName
    );
  }
}

function adaptGardenArtifact(artifact, entry, adaptation) {
  const action = adaptation.action || "swap";
  const replacementName = (adaptation.replacementName || "").trim();
  const targetName = normalizeName(entry.itemName);

  if (Array.isArray(artifact.materials)) {
    artifact.materials = adaptItemArrayByName(
      artifact.materials,
      targetName,
      action,
      replacementName
    );
  }

  if (Array.isArray(artifact.tasks)) {
    artifact.tasks = artifact.tasks.map((task) => {
      if (!task || typeof task !== "object") return task;
      if (Array.isArray(task.materials)) {
        task.materials = adaptItemArrayByName(
          task.materials,
          targetName,
          action,
          replacementName
        );
      }
      return task;
    });
  }

  if (Array.isArray(artifact.consumes)) {
    artifact.consumes = adaptItemArrayByName(
      artifact.consumes,
      targetName,
      action,
      replacementName
    );
  }
}

function adaptAnimalArtifact(artifact, entry, adaptation) {
  const action = adaptation.action || "swap";
  const replacementName = (adaptation.replacementName || "").trim();
  const targetName = normalizeName(entry.itemName);

  if (Array.isArray(artifact.materials)) {
    artifact.materials = adaptItemArrayByName(
      artifact.materials,
      targetName,
      action,
      replacementName
    );
  }

  if (Array.isArray(artifact.procedures)) {
    artifact.procedures = artifact.procedures.map((proc) => {
      if (!proc || typeof proc !== "object") return proc;
      if (Array.isArray(proc.materials)) {
        proc.materials = adaptItemArrayByName(
          proc.materials,
          targetName,
          action,
          replacementName
        );
      }
      return proc;
    });
  }

  if (Array.isArray(artifact.consumes)) {
    artifact.consumes = adaptItemArrayByName(
      artifact.consumes,
      targetName,
      action,
      replacementName
    );
  }
}

/**
 * Fallback for unknown shapes: lightly search common fields and update.
 */
function adaptGenericArtifact(artifact, entry, adaptation) {
  const action = adaptation.action || "swap";
  const replacementName = (adaptation.replacementName || "").trim();
  const targetName = normalizeName(entry.itemName);

  for (const key of Object.keys(artifact)) {
    const value = artifact[key];
    if (!Array.isArray(value)) continue;

    artifact[key] = adaptItemArrayByName(
      value,
      targetName,
      action,
      replacementName
    );
  }
}

/**
 * Adapt an array of items by normalized name:
 *  - action === "swap": rename item.name / item.label
 *  - action === "remove": filter out item
 *  - action === "guestOnly": mark metadata flags without removing
 */
function adaptItemArrayByName(items, targetName, action, replacementName) {
  const out = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      out.push(item);
      continue;
    }

    const currentName =
      (typeof item.name === "string" && item.name) ||
      (typeof item.label === "string" && item.label) ||
      "";
    const normalized = normalizeName(currentName);

    if (!currentName || normalized !== targetName) {
      out.push(item);
      continue;
    }

    if (action === "remove") {
      // skip this item
      continue;
    }

    if (action === "swap" && replacementName) {
      const updated = { ...item };
      if (typeof updated.name === "string" || !("name" in updated)) {
        updated.name = replacementName;
      } else if (typeof updated.label === "string" || !("label" in updated)) {
        updated.label = replacementName;
      }

      updated.metadata = {
        ...(updated.metadata || {}),
        adaptedFrom: currentName,
        adaptedReason: "householdCompliance",
      };

      out.push(updated);
      continue;
    }

    if (action === "guestOnly") {
      const updated = { ...item };
      updated.metadata = {
        ...(updated.metadata || {}),
        guestOnly: true,
        blockedForHousehold: true,
        adaptedReason: "householdCompliance",
      };
      out.push(updated);
      continue;
    }

    // default: leave as is
    out.push(item);
  }

  return out;
}

/* ------------------------------- Suggestions --------------------------------- */

function getDomainSwapSuggestions(domain, entry) {
  const tags = entry.tags || {};
  const suggestions = [];

  if (domain === "cooking") {
    if (tags.isPork) {
      suggestions.push("turkey bacon", "beef bacon", "lamb sausage");
    }
    if (tags.isShellfish) {
      suggestions.push("white fish (cod)", "tilapia", "pollock");
    }
    if (tags.isBlood || tags.containsBlood) {
      suggestions.push("well-drained kosher-style meat", "vegetable protein");
    }
    if (tags.isSeedOil) {
      suggestions.push("olive oil", "avocado oil", "butter or ghee");
    }
    if (tags.isUltraProcessed) {
      suggestions.push("whole ingredient alternative", "homemade version");
    }
  } else if (domain === "cleaning") {
    if (tags.isBleach) {
      suggestions.push("oxygen cleaner", "hydrogen peroxide", "unscented soap");
    }
    if (tags.isFragrance || tags.isScented) {
      suggestions.push("unscented cleaner", "soap + baking soda");
    }
    if (tags.isAmmonia) {
      suggestions.push("vinegar-based cleaner", "castile soap");
    }
  } else if (domain === "garden") {
    if (tags.isHerbicide) {
      suggestions.push("mulch + hand-weeding", "flame weeder (where safe)");
    }
    if (tags.isPesticide) {
      suggestions.push("neem oil", "insecticidal soap", "row covers");
    }
    if (tags.isInvasiveRisk) {
      suggestions.push("native equivalent species");
    }
  } else if (domain === "animals") {
    if (tags.isNonTorahFeed) {
      suggestions.push("Torah-compliant feed mix", "pasture-based forage");
    }
    if (tags.isDrugRestricted) {
      suggestions.push("vet-approved alternative", "herbal support protocol");
    }
  }

  if (entry.kind === "allergen" || tags.isAllergen) {
    suggestions.push("allergen-free alternative", "omit and rebalance recipe");
  }

  // fallback generic
  if (!suggestions.length) {
    suggestions.push("safer household-approved alternative");
  }

  // de-duplicate
  return Array.from(new Set(suggestions));
}

/* ------------------------------ Compliance Utils ----------------------------- */

function buildViolationEntries(domain, compliance) {
  const meta = compliance || {};
  const hardList = Array.isArray(meta.hardViolations)
    ? meta.hardViolations
    : [];
  const softList = Array.isArray(meta.softConflicts) ? meta.softConflicts : [];
  const allergenList = Array.isArray(meta.allergenRisks)
    ? meta.allergenRisks
    : [];

  return {
    hard: hardList.map((v, index) =>
      normalizeViolationEntry(domain, v, index, "hard")
    ),
    soft: softList.map((v, index) =>
      normalizeViolationEntry(domain, v, index, "soft")
    ),
    allergen: allergenList.map((v, index) =>
      normalizeViolationEntry(domain, v, index, "allergen")
    ),
  };
}

/**
 * Expected input violation shape (best-effort):
 *  - { id, itemId, itemName, name, label, reason, message, severity, tags }
 */
function normalizeViolationEntry(domain, raw, index, kind) {
  const safe = raw && typeof raw === "object" ? raw : {};

  const itemName =
    (typeof safe.itemName === "string" && safe.itemName.trim()) ||
    (typeof safe.name === "string" && safe.name.trim()) ||
    (typeof safe.label === "string" && safe.label.trim()) ||
    "Unknown item";

  const reason =
    (typeof safe.reason === "string" && safe.reason.trim()) ||
    (typeof safe.message === "string" && safe.message.trim()) ||
    "";

  const tags = safe.tags && typeof safe.tags === "object" ? safe.tags : {};

  return {
    key: safe.id || `${kind}-${index}`,
    kind,
    domain,
    itemId: safe.itemId || null,
    itemName,
    reason,
    severity: safe.severity || (kind === "hard" ? "high" : "medium"),
    tags,
    raw: safe,
  };
}

/* --------------------------------- Helpers ----------------------------------- */

function normalizeDomain(domain) {
  if (!domain || typeof domain !== "string") return "cooking";
  const d = domain.toLowerCase();
  if (d === "cleaning" || d === "garden" || d === "animals") return d;
  return "cooking";
}

function normalizeName(name) {
  if (!name || typeof name !== "string") return "";
  return name.trim().toLowerCase();
}

function deepClone(obj) {
  try {
    // structuredClone if available
    // eslint-disable-next-line no-undef
    if (typeof structuredClone === "function") {
      // @ts-ignore
      return structuredClone(obj);
    }
  } catch {
    // ignore fall-through to JSON clone
  }
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return obj;
  }
}

/**
 * Safe wrapper for eventBus emit.
 *
 * @param {{ type: string, ts: string, source: string, data: any }} payload
 */
function emitSafe(payload) {
  if (typeof emitEvent !== "function") return;
  try {
    emitEvent(payload);
  } catch (err) {
    if (typeof console !== "undefined") {
      console.warn("[HouseholdComplianceWizard] Failed to emit event", err);
    }
  }
}

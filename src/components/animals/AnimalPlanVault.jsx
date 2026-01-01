// C:\Users\larho\suka-smart-assistant\src\components\animals\AnimalPlanVault.jsx
/* eslint-disable no-console */
/**
 * AnimalPlanVault
 * -----------------------------------------------------------------------------
 * Purpose
 * - Vault for animal-care protocols (feeding, health, slaughter/processing).
 * - Lets the household store reusable “protocol artifacts” for animals.
 *
 * How this fits the pipeline
 * - imports → intelligence → automation → (optional) hub export
 *
 * 1. Imports
 *    - Protocols may come from:
 *      • user-entered text
 *      • scraped how-to pages
 *      • uploaded files (PDF, DOC, etc. — via upstream importers)
 *    - Upstream importers should normalize into a `rawInput` structure and
 *      pass it into `handleSaveAnimalProtocol(rawInput)`.
 *
 * 2. Intelligence
 *    - `prepareArtifactForVault` (external service) converts rawInput →
 *      normalized `artifact` and runs domain-specific compliance checks:
 *        • Non-clean feeds
 *        • Disallowed meds / drugs
 *        • Slaughter / processing practices that conflict with the household
 *          profile (e.g., Torah / “clean” profile).
 *    - It returns `{ artifact, compliance }`.
 *    - If `compliance.status !== COMPLIANT`, this component:
 *        • Stores the pending artifact
 *        • Opens a “compliance wizard” to show classifier tags and details
 *        • Lets the user either cancel or confirm saving anyway
 *
 * 3. Automation
 *    - When a protocol artifact is saved:
 *        • Emit `animals.protocol.saved` on the shared eventBus and automation
 *          runtime with payload: { householdId, artifact, compliance }.
 *        • Other engines (AnimalSessionEngine, Inventory, Storehouse, etc.)
 *          can listen and:
 *          - generate care sessions
 *          - update feed/med inventory expectations
 *          - suggest slaughter/preservation schedules
 *
 * 4. (Optional) Hub export
 *    - If featureFlags.familyFundMode === true:
 *        • `exportToHubIfEnabled` formats payload using HubPacketFormatter
 *          and passes it to FamilyFundConnector.
 *        • All failures are silent (SSA remains source of truth).
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";

/* ----------------------------- Safe imports ---------------------------------- */

// eventBus (soft import)
let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const eb = require("@/services/eventBus");
  eventBus = eb?.eventBus || eb?.default || eventBus;
} catch {}

// automation runtime
let automation = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/services/automation/runtime");
  automation = mod.automation || mod.default || automation;
} catch {}

// feature flags
let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/services/featureFlags");
  featureFlags = mod.featureFlags || mod.default || featureFlags;
} catch {}

// hub helpers
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const f = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = f.default || f;
} catch {}
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const c = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = c.default || c;
} catch {}

// household context
let useHouseholdContext = () => ({
  currentHouseholdId: "demo-household",
});
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/store/HouseholdStore");
  useHouseholdContext =
    mod.useHouseholdContext || mod.useHouseholdStore || useHouseholdContext;
} catch {}

// artifact helpers (prep + vault)
let prepareArtifactForVault = async () => ({
  artifact: null,
  compliance: { status: "UNKNOWN", flags: [] },
});
let saveArtifactToVault = async () => {};
let loadArtifactsFromVault = async () => [];
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const prep = require("@/services/artifacts/prepareArtifactForVault");
  prepareArtifactForVault =
    prep.prepareArtifactForVault || prep.default || prep;
} catch {}
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vault = require("@/services/artifacts/ArtifactVaultRepo");
  saveArtifactToVault =
    vault.saveArtifactToVault ||
    vault.save ||
    vault.default ||
    saveArtifactToVault;
  loadArtifactsFromVault =
    vault.loadArtifactsFromVault || vault.list || loadArtifactsFromVault;
} catch {}

// compliance constants
const COMPLIANCE_STATUS = {
  COMPLIANT: "COMPLIANT",
  NEEDS_REVIEW: "NEEDS_REVIEW",
  BLOCKED: "BLOCKED",
};
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("@/constants/compliance");
  if (mod.COMPLIANCE_STATUS) {
    Object.assign(COMPLIANCE_STATUS, mod.COMPLIANCE_STATUS);
  }
} catch {}

/* ------------------------------ Small utilities ------------------------------ */

const cls = (...xs) => xs.filter(Boolean).join(" ");

const FIELD_INPUT_CLASS =
  "w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-emerald-500";

const TAG_CLASSES = {
  "non-clean-feed": "bg-red-50 text-red-800 border-red-200",
  "disallowed-med": "bg-amber-50 text-amber-800 border-amber-200",
  "slaughter-conflict": "bg-purple-50 text-purple-800 border-purple-200",
};

/**
 * emitEvent
 * - Sends a standardized payload to both automation runtime and eventBus.
 */
function emitEvent(type, payload = {}) {
  const evt = {
    type,
    ts: new Date().toISOString(),
    source: "ui/animals/planVault",
    data: {
      domain: "animals",
      ...payload,
    },
  };

  try {
    automation?.emit?.("event", evt);
  } catch (err) {
    console.warn("[AnimalPlanVault] automation emit failed:", err);
  }
  try {
    eventBus?.emit?.("event", evt);
  } catch (err) {
    console.warn("[AnimalPlanVault] eventBus emit failed:", err);
  }
}

/**
 * exportToHubIfEnabled
 * - Used for actions that change household data (saved protocols).
 * - Respects featureFlags.familyFundMode.
 * - Fails silently if hub is unavailable.
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const formatter =
      HubPacketFormatter.formatSession ||
      HubPacketFormatter.formatArtifact ||
      HubPacketFormatter.format ||
      HubPacketFormatter.default ||
      null;
    const connector =
      FamilyFundConnector.send ||
      FamilyFundConnector.export ||
      FamilyFundConnector.default ||
      null;

    if (!formatter || !connector) return;

    const packet = formatter(payload);
    await connector(packet);
  } catch (err) {
    console.warn(
      "[AnimalPlanVault] exportToHubIfEnabled failed:",
      err?.message || err
    );
  }
}

/**
 * extractClassifierFlags
 * - Normalizes compliance flags into a simple array of:
 *   { code, label, severity, details }
 */
function extractClassifierFlags(compliance) {
  if (!compliance) return [];
  const raw = compliance.flags || compliance.issues || [];
  if (!Array.isArray(raw)) return [];

  return raw.map((flag, idx) => {
    if (typeof flag === "string") {
      return {
        code: flag,
        label: flag.replace(/[_-]/g, " "),
        severity: "info",
        details: "",
        _idx: idx,
      };
    }
    return {
      code: flag.code || `flag_${idx}`,
      label:
        flag.label ||
        flag.message ||
        flag.code?.replace?.(/[_-]/g, " ") ||
        "Compliance issue",
      severity: flag.severity || "info",
      details: flag.details || flag.explanation || "",
      _idx: idx,
    };
  });
}

/* ------------------------------ Compliance badge ----------------------------- */

function ComplianceBadge({ status }) {
  if (!status) return null;
  let text = status;
  let style = "bg-stone-100 text-stone-700 border-stone-200";

  if (status === COMPLIANCE_STATUS.COMPLIANT) {
    text = "Compliant";
    style = "bg-emerald-50 text-emerald-800 border-emerald-200";
  } else if (status === COMPLIANCE_STATUS.NEEDS_REVIEW) {
    text = "Needs review";
    style = "bg-amber-50 text-amber-800 border-amber-200";
  } else if (status === COMPLIANCE_STATUS.BLOCKED) {
    text = "Blocked";
    style = "bg-red-50 text-red-800 border-red-200";
  }

  return (
    <span
      className={cls(
        "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border",
        style
      )}
    >
      {text}
    </span>
  );
}

/* ------------------------------- Compliance Wizard --------------------------- */

function ComplianceWizardModal({
  open,
  artifact,
  compliance,
  onCancel,
  onConfirm,
}) {
  if (!open || !artifact || !compliance) return null;

  const flags = extractClassifierFlags(compliance);

  const nonClean = flags.filter((f) =>
    /non[-_]?clean|unclean/i.test(f.code + " " + f.label)
  );
  const meds = flags.filter((f) => /(med|drug)/i.test(f.code + " " + f.label));
  const slaughter = flags.filter((f) =>
    /(slaughter|processing|butcher)/i.test(f.code + " " + f.label)
  );

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl max-w-2xl w-full mx-4 p-6">
        <h2 className="text-xl font-semibold text-amber-800 mb-2">
          Review animal care protocol for compliance
        </h2>
        <p className="text-sm text-stone-600 mb-4">
          This protocol triggered one or more classifier warnings. Review them
          carefully before adding it to your household vault.
        </p>

        <div className="mb-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold text-stone-800">Protocol:</span>
            <span className="text-stone-700">
              {artifact.title || artifact.name || "Untitled protocol"}
            </span>
            <ComplianceBadge status={compliance.status} />
          </div>
          {artifact.species && (
            <div className="text-xs text-stone-500 mt-1">
              Species: {artifact.species} | Category:{" "}
              {artifact.category || artifact.kind || "general"}
            </div>
          )}
        </div>

        <div className="grid gap-3 md:grid-cols-3 text-sm mb-4">
          <div className="border border-stone-200 rounded-xl p-3">
            <div className="font-semibold mb-1">
              Non-clean feeds (classifier)
            </div>
            {nonClean.length ? (
              <ul className="list-disc pl-4 space-y-1">
                {nonClean.map((f) => (
                  <li key={f._idx}>
                    <span>{f.label}</span>
                    {f.details && (
                      <div className="text-xs text-stone-500">{f.details}</div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-500">
                No feed warnings detected.
              </p>
            )}
          </div>
          <div className="border border-stone-200 rounded-xl p-3">
            <div className="font-semibold mb-1">Disallowed meds / drugs</div>
            {meds.length ? (
              <ul className="list-disc pl-4 space-y-1">
                {meds.map((f) => (
                  <li key={f._idx}>
                    <span>{f.label}</span>
                    {f.details && (
                      <div className="text-xs text-stone-500">{f.details}</div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-500">
                No medication warnings detected.
              </p>
            )}
          </div>
          <div className="border border-stone-200 rounded-xl p-3">
            <div className="font-semibold mb-1">
              Slaughter / processing conflicts
            </div>
            {slaughter.length ? (
              <ul className="list-disc pl-4 space-y-1">
                {slaughter.map((f) => (
                  <li key={f._idx}>
                    <span>{f.label}</span>
                    {f.details && (
                      <div className="text-xs text-stone-500">{f.details}</div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-500">
                No slaughter / processing conflicts detected.
              </p>
            )}
          </div>
        </div>

        {compliance.message && (
          <div className="mb-3 text-xs text-stone-600">
            <span className="font-semibold">Classifier note: </span>
            {compliance.message}
          </div>
        )}

        <div className="flex items-center justify-between mt-4">
          <div className="text-xs text-stone-500 max-w-xs">
            Your household profile (clean animals, acceptable meds, allowed
            slaughter methods) is used to classify protocols. Update that in
            Household Settings if needed.
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={onConfirm}>
              Save protocol anyway
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =============================================================================
   MAIN COMPONENT
   ============================================================================= */

export default function AnimalPlanVault() {
  const { currentHouseholdId } = useHouseholdContext();

  const [protocols, setProtocols] = useState([]);
  const [loading, setLoading] = useState(true);

  const [title, setTitle] = useState("");
  const [species, setSpecies] = useState("cattle");
  const [category, setCategory] = useState("feeding");
  const [rawText, setRawText] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [ok, setOk] = useState(false);

  // compliance wizard
  const [pendingArtifact, setPendingArtifact] = useState(null);
  const [pendingCompliance, setPendingCompliance] = useState(null);
  const [showComplianceWizard, setShowComplianceWizard] = useState(false);

  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");

  const hasFormContent = useMemo(
    () => !!(title.trim() || rawText.trim() || notes.trim()),
    [title, rawText, notes]
  );

  // Load protocols for this household
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const list = await loadArtifactsFromVault({
          domain: "animals",
          householdId: currentHouseholdId,
        });
        if (!cancelled && Array.isArray(list)) {
          setProtocols(list);
        }
      } catch (err) {
        console.warn("[AnimalPlanVault] loadArtifactsFromVault failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentHouseholdId]);

  const resetForm = () => {
    setTitle("");
    setSpecies("cattle");
    setCategory("feeding");
    setRawText("");
    setNotes("");
  };

  /**
   * Save animal care protocols
   *
   * NOTE (per your instruction): This preserves the core structure of the
   * handler you provided. Only minimal additions are:
   *  - storing compliance in state for the wizard
   *  - emitting events / exporting to hub after a compliant save
   */
  const handleSaveAnimalProtocol = useCallback(
    async (rawInput) => {
      const householdId = currentHouseholdId;

      const { artifact, compliance } = await prepareArtifactForVault({
        domain: "animals",
        householdId,
        rawInput,
      });

      // Store compliance info so the wizard can show classifier tags
      setPendingCompliance(compliance || null);

      if (compliance.status !== COMPLIANCE_STATUS.COMPLIANT) {
        setPendingArtifact({ artifact, compliance });
        setShowComplianceWizard(true);

        emitEvent("animals.protocol.complianceRequired", {
          householdId,
          artifactPreview: {
            id: artifact.id,
            title: artifact.title,
            species: artifact.species,
            category: artifact.category,
          },
          compliance,
        });

        return;
      }

      await saveArtifactToVault({
        domain: "animals",
        householdId,
        artifact,
      });

      // Emit events + optional hub export on successful, compliant save
      emitEvent("animals.protocol.saved", {
        householdId,
        artifact,
        compliance,
      });

      exportToHubIfEnabled({
        type: "animals.protocol.saved",
        domain: "animals",
        source: "AnimalPlanVault",
        data: {
          householdId,
          artifact,
          compliance,
        },
      });

      // Refresh local list
      try {
        const list = await loadArtifactsFromVault({
          domain: "animals",
          householdId,
        });
        if (Array.isArray(list)) {
          setProtocols(list);
        }
      } catch (err) {
        console.warn("[AnimalPlanVault] reload after save failed:", err);
      }
    },
    [currentHouseholdId]
  );

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!rawText.trim() && !title.trim()) return;

    setSaving(true);
    setOk(false);

    try {
      const rawInput = {
        title: title || "Untitled animal protocol",
        species,
        category, // feeding | health | slaughter | cleaning | general
        body: rawText,
        notes,
        source: "user/manual",
      };

      await handleSaveAnimalProtocol(rawInput);

      setOk(true);
      resetForm();
      setTimeout(() => setOk(false), 1000);
    } catch (err) {
      console.warn("[AnimalPlanVault] submit failed:", err);
    } finally {
      setSaving(false);
    }
  };

  const filteredProtocols = useMemo(() => {
    const q = search.toLowerCase();
    return (protocols || []).filter((p) => {
      if (filterCategory !== "all") {
        const cat = (p.category || p.kind || "").toLowerCase();
        if (cat !== filterCategory) return false;
      }
      if (!q) return true;
      const haystack =
        (p.title || "") +
        " " +
        (p.species || "") +
        " " +
        (p.category || "") +
        " " +
        (p.summary || "") +
        " " +
        (p.notes || "");
      return haystack.toLowerCase().includes(q);
    });
  }, [protocols, search, filterCategory]);

  const onConfirmComplianceSave = async () => {
    if (!pendingArtifact) {
      setShowComplianceWizard(false);
      return;
    }
    const { artifact, compliance } = pendingArtifact;
    const householdId = currentHouseholdId;

    try {
      await saveArtifactToVault({
        domain: "animals",
        householdId,
        artifact,
      });

      emitEvent("animals.protocol.saved", {
        householdId,
        artifact,
        compliance,
      });

      exportToHubIfEnabled({
        type: "animals.protocol.saved",
        domain: "animals",
        source: "AnimalPlanVault",
        data: {
          householdId,
          artifact,
          compliance,
        },
      });

      const list = await loadArtifactsFromVault({
        domain: "animals",
        householdId,
      });
      if (Array.isArray(list)) {
        setProtocols(list);
      }
    } catch (err) {
      console.warn("[AnimalPlanVault] confirm save failed:", err);
    } finally {
      setShowComplianceWizard(false);
      setPendingArtifact(null);
      setPendingCompliance(null);
    }
  };

  const onCancelComplianceSave = () => {
    setShowComplianceWizard(false);
    setPendingArtifact(null);
    setPendingCompliance(null);
  };

  /* ---------------------------------- Render --------------------------------- */

  return (
    <div className="card bg-white/95 border border-emerald-200 rounded-2xl shadow-sm p-5 space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-emerald-800">
            🐄 Animal Plan Vault
          </h2>
          <p className="text-sm text-stone-600">
            Save feeding, health, and slaughter/processing protocols. Classifier
            tags non-clean feeds, disallowed meds/drugs, and practices that
            conflict with your household profile.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-stone-500">
          <span>
            Household:
            <span className="font-mono ml-1">{currentHouseholdId}</span>
          </span>
          {ok && (
            <span className="text-emerald-600 font-semibold">✓ Saved</span>
          )}
        </div>
      </div>

      {/* Editor + List */}
      <div className="grid gap-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.1fr)]">
        {/* Left: Editor */}
        <form
          onSubmit={onSubmit}
          className="space-y-4 border border-emerald-100 rounded-2xl p-4 bg-emerald-50/40"
        >
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-semibold text-emerald-900 text-sm">
              New animal-care protocol
            </span>
            <ComplianceBadge status={pendingCompliance?.status} />
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-stone-800">Title</span>
              <input
                className={FIELD_INPUT_CLASS}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g., Sabbath-friendly milking routine"
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-stone-800">Species</span>
              <select
                className={FIELD_INPUT_CLASS}
                value={species}
                onChange={(e) => setSpecies(e.target.value)}
              >
                <option value="cattle">Cattle</option>
                <option value="sheep">Sheep</option>
                <option value="goats">Goats</option>
                <option value="poultry">Poultry</option>
                <option value="fish">Fish</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="font-medium text-stone-800">Category</span>
              <select
                className={FIELD_INPUT_CLASS}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                <option value="feeding">Feeding</option>
                <option value="health">Health / meds</option>
                <option value="slaughter">Slaughter / processing</option>
                <option value="cleaning">Barn cleaning</option>
                <option value="general">General care</option>
              </select>
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-stone-800">Protocol steps</span>
            <textarea
              className={FIELD_INPUT_CLASS}
              rows={8}
              value={rawText}
              onChange={(e) => setRawText(e.target.value)}
              placeholder={
                "Describe the protocol in clear steps.\n" +
                "- Include feeds, meds, handling, slaughter/butchery details.\n" +
                "- The classifier will tag non-clean feeds, disallowed meds, and conflicts with your profile."
              }
            />
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-stone-800">Notes (optional)</span>
            <textarea
              className={FIELD_INPUT_CLASS}
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes, seasonal variations, or references."
            />
          </label>

          <div className="flex items-center justify-between pt-2">
            <div className="text-xs text-stone-500 max-w-xs">
              Imported how-to pages and videos can also be normalized into
              protocols and saved here by the ImportRouter. Those will pass
              through the same classifier pipeline.
            </div>
            <div className="flex items-center gap-2">
              {hasFormContent && (
                <button
                  type="button"
                  className="btn text-xs"
                  onClick={resetForm}
                >
                  Clear
                </button>
              )}
              <button
                type="submit"
                className="btn primary"
                disabled={saving || !hasFormContent}
                aria-busy={saving}
              >
                {saving ? "Saving…" : "Save protocol"}
              </button>
            </div>
          </div>
        </form>

        {/* Right: Saved protocols */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-emerald-900 text-sm">
              Saved protocols
            </span>
            <div className="flex gap-2 items-center text-xs">
              <input
                className={cls(FIELD_INPUT_CLASS, "h-7 text-xs")}
                placeholder="Search…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <select
                className={cls(FIELD_INPUT_CLASS, "h-7 text-xs w-[8.5rem]")}
                value={filterCategory}
                onChange={(e) => setFilterCategory(e.target.value)}
              >
                <option value="all">All categories</option>
                <option value="feeding">Feeding</option>
                <option value="health">Health / meds</option>
                <option value="slaughter">Slaughter</option>
                <option value="cleaning">Cleaning</option>
                <option value="general">General</option>
              </select>
            </div>
          </div>

          <div className="border border-emerald-100 rounded-2xl p-3 bg-white/80 max-h-[420px] overflow-auto">
            {loading ? (
              <p className="text-xs text-stone-400">Loading protocols…</p>
            ) : filteredProtocols.length ? (
              <ul className="space-y-2 text-sm">
                {filteredProtocols.map((p) => {
                  const flags = extractClassifierFlags(p.compliance);
                  return (
                    <li
                      key={p.id || p._id || Math.random()}
                      className="border border-emerald-100 rounded-xl p-3 bg-white shadow-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-stone-900">
                              {p.title || p.name || "Untitled protocol"}
                            </span>
                            <ComplianceBadge status={p.compliance?.status} />
                          </div>
                          <div className="text-xs text-stone-500 mt-1">
                            Species: {p.species || "—"} · Category:{" "}
                            {p.category || p.kind || "—"}
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1 justify-end max-w-[40%]">
                          {flags.map((f) => {
                            const key =
                              (f.code || "")
                                .toLowerCase()
                                .replace(/\s+/g, "-") || "";
                            const baseClass =
                              TAG_CLASSES[key] ||
                              "bg-stone-50 text-stone-700 border-stone-200";
                            return (
                              <span
                                key={f._idx}
                                className={cls(
                                  "inline-flex items-center px-1.5 py-0.5 rounded-full text-[0.65rem] border",
                                  baseClass
                                )}
                                title={f.details || ""}
                              >
                                {f.label}
                              </span>
                            );
                          })}
                        </div>
                      </div>
                      {p.summary && (
                        <p className="text-xs text-stone-600 mt-1">
                          {p.summary}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-xs text-stone-400">
                No protocols saved yet. Add your feeding, health, and
                slaughter/processing routines on the left.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Compliance wizard modal */}
      <ComplianceWizardModal
        open={showComplianceWizard}
        artifact={pendingArtifact?.artifact || null}
        compliance={pendingArtifact?.compliance || null}
        onCancel={onCancelComplianceSave}
        onConfirm={onConfirmComplianceSave}
      />
    </div>
  );
}

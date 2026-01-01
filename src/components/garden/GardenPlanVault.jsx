// C:\Users\larho\suka-smart-assistant\src\components\garden\GardenPlanVault.jsx
/* eslint-disable no-console */

/**
 * GardenPlanVault
 * -----------------------------------------------------------------------------
 * Purpose
 *   UI component for saving and managing Garden plans as vault artifacts.
 *
 * How this fits in SSA pipeline
 *   imports → intelligence → automation → (optional) hub export
 *
 *   - imports:
 *       Garden plans can come from a Garden Planner UI, external seed catalogs,
 *       or previous seasons’ plans. The raw plan is passed in as `rawInput`.
 *
 *   - intelligence:
 *       handleSaveGardenPlan() normalizes the raw plan into a vault-ready
 *       artifact via `prepareArtifactForVault({ domain: "garden", ... })`.
 *       The garden classifier + compliance check catch:
 *         • banned chemicals
 *         • invasives
 *         • planting in wrong seasons (soft conflict)
 *
 *   - automation:
 *       Once compliant (or overridden), artifacts are persisted via
 *       `saveArtifactToVault` and emitted on `eventBus` as
 *       `garden.plan.saved`. Other engines (GardenSessionEngine, Storehouse,
 *       Preservation, etc.) can listen and generate sessions or follow-ups.
 *
 *   - (optional) hub export:
 *       When featureFlags.familyFundMode === true, successful saves are also
 *       formatted via HubPacketFormatter and sent through FamilyFundConnector
 *       so the Suka Village Family Fund Hub can reason about household garden
 *       capacity, seasonality, and inputs/outputs. SSA remains the source of
 *       truth and sends outbound snapshots only.
 */

import React, { useEffect, useMemo, useState } from "react";
import "@/styles/household.css";

/* ----------------------- Soft/defensive shared imports ---------------------- */

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch {
  console.warn("[GardenPlanVault] eventBus not available, falling back noop.");
}

let automation = {
  on: () => () => {},
  request: async () => null,
  emitEvent: () => {},
};
try {
  const a = require("@/services/automation/runtime");
  automation = a?.default || a || automation;
} catch {
  console.warn("[GardenPlanVault] automation runtime not available.");
}

let featureFlags = { familyFundMode: false };
try {
  const ff = require("@/services/featureFlags");
  featureFlags = ff?.default || ff?.featureFlags || featureFlags;
} catch {
  console.warn("[GardenPlanVault] featureFlags not available, defaulting.");
}

// Artifact helpers
let prepareArtifactForVault = async () => {
  throw new Error("prepareArtifactForVault not wired");
};
let saveArtifactToVault = async () => {
  throw new Error("saveArtifactToVault not wired");
};
let listArtifactsFromVault = async () => [];
let deleteArtifactFromVault = async () => false;

try {
  const mod = require("@/services/artifacts/prepareArtifactForVault");
  prepareArtifactForVault = mod?.default || mod || prepareArtifactForVault;
} catch {
  console.warn("[GardenPlanVault] prepareArtifactForVault not found.");
}
try {
  const mod = require("@/services/artifacts/vault");
  const m = mod?.default || mod || {};
  if (m.saveArtifactToVault) saveArtifactToVault = m.saveArtifactToVault;
  if (m.listArtifactsFromVault)
    listArtifactsFromVault = m.listArtifactsFromVault;
  if (m.deleteArtifactFromVault)
    deleteArtifactFromVault = m.deleteArtifactFromVault;
} catch {
  console.warn("[GardenPlanVault] vault service not found.");
}

// Compliance constants
let COMPLIANCE_STATUS = {
  COMPLIANT: "COMPLIANT",
  SOFT_CONFLICT: "SOFT_CONFLICT",
  BLOCKED: "BLOCKED",
};
try {
  const c = require("@/services/compliance/constants");
  const cc = c?.default || c;
  if (cc?.COMPLIANCE_STATUS) COMPLIANCE_STATUS = cc.COMPLIANCE_STATUS;
} catch {
  console.warn("[GardenPlanVault] COMPLIANCE_STATUS fallback in use.");
}

// Hub helpers
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  const f = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = f?.default || f;
} catch {
  console.warn("[GardenPlanVault] HubPacketFormatter not available.");
}
try {
  const conn = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = conn?.default || conn;
} catch {
  console.warn("[GardenPlanVault] FamilyFundConnector not available.");
}

/* ------------------------------ Hub exporter -------------------------------- */

/**
 * exportToHubIfEnabled
 *  - Called after we successfully save a garden plan.
 *  - Checks featureFlags.familyFundMode and fails silently if Hub is offline
 *    or helpers are missing.
 */
async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    const ts = new Date().toISOString();
    const base = {
      ts,
      domain: "garden",
      eventType: "garden.plan.saved",
      payload,
    };

    let packet = base;
    if (HubPacketFormatter) {
      if (typeof HubPacketFormatter.formatGardenArtifact === "function") {
        packet = HubPacketFormatter.formatGardenArtifact(base);
      } else if (typeof HubPacketFormatter.format === "function") {
        packet = HubPacketFormatter.format("gardenArtifact", base);
      }
    }

    if (FamilyFundConnector && typeof FamilyFundConnector.send === "function") {
      await FamilyFundConnector.send("household.garden.planSaved", packet);
    }
  } catch (e) {
    console.warn("[GardenPlanVault] exportToHubIfEnabled failed (soft):", e);
  }
}

/* -------------------------------- UI Atoms ---------------------------------- */

function Card({ className = "", children, style }) {
  return (
    <div className={`sv-card ${className}`} style={style}>
      {children}
    </div>
  );
}

function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  title,
  className = "",
}) {
  const v =
    variant === "ghost"
      ? "sv-btn--ghost"
      : variant === "outline"
      ? "sv-btn--outline"
      : "sv-btn--primary";
  return (
    <button
      className={`sv-btn ${v} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function SectionHeader({ icon, title, sub, right }) {
  return (
    <div className="sv-sectionHead sv-row sv-justify-between sv-align-start">
      <div>
        <div className="sv-row sv-align-center sv-gap">
          {icon ? <span className="sv-sectionHead__icon">{icon}</span> : null}
          <h2 className="sv-sectionHead__title">{title}</h2>
        </div>
        {sub ? <p className="sv-muted sv-text-sm">{sub}</p> : null}
      </div>
      {right}
    </div>
  );
}

const Toast = ({ tone = "info", text, action, onClose }) => (
  <div className={`sv-toast sv-toast--${tone}`}>
    <span>{text}</span>
    {action && (
      <button className="sv-btn sv-btn--outline sv-btn--sm" onClick={action.fn}>
        {action.label}
      </button>
    )}
    <button className="sv-btn sv-btn--ghost sv-btn--sm" onClick={onClose}>
      ✕
    </button>
  </div>
);

const Banner = ({ tone = "info", children, onDismiss }) => (
  <div className={`sv-banner sv-banner--${tone}`}>
    <div className="sv-banner__content">{children}</div>
    {onDismiss && (
      <button className="sv-btn sv-btn--ghost sv-btn--sm" onClick={onDismiss}>
        Dismiss
      </button>
    )}
  </div>
);

/* --------------------------- Compliance Wizard ------------------------------ */

/**
 * ComplianceWizard
 *  - Shows the result of garden classifier + compliance checks.
 *  - Highlights banned chemicals, invasives, and season conflicts when present.
 *  - Let user:
 *      • cancel and go back to planner, or
 *      • save with overrides for SOFT_CONFLICT status.
 */
function ComplianceWizard({
  open,
  artifact,
  compliance,
  onCancel,
  onOverrideSave,
}) {
  if (!open || !artifact || !compliance) return null;

  const status = compliance.status;
  const bannedChemicals = compliance.bannedChemicals || [];
  const invasives = compliance.invasives || [];
  const seasonConflicts =
    compliance.seasonConflicts || compliance.seasonIssues || [];

  const isSoft =
    status === COMPLIANCE_STATUS.SOFT_CONFLICT ||
    status === "SOFT_CONFLICT" ||
    status === "soft_conflict";
  const isBlocked =
    status === COMPLIANCE_STATUS.BLOCKED ||
    status === "BLOCKED" ||
    status === "blocked";

  return (
    <div className="sv-modal" style={{ zIndex: 110 }}>
      <Card className="sv-modal__card sv-pad">
        <div className="sv-modal__head">
          <div>
            <div className="sv-modal__title">Review Garden Compliance</div>
            <div className="sv-muted sv-text-sm">
              We scan for banned chemicals, invasive species, and out-of-season
              plantings before saving to your household vault.
            </div>
          </div>
        </div>

        <div className="sv-modal__body sv-stack">
          <div className="sv-row sv-gap sv-align-center">
            <span className="sv-badge">Status: {status || "UNKNOWN"}</span>
            {isBlocked && (
              <span className="sv-badge sv-badge--danger">
                Blocked — must resolve
              </span>
            )}
            {isSoft && (
              <span className="sv-badge sv-badge--warn">
                Soft conflict — can override
              </span>
            )}
          </div>

          {bannedChemicals.length > 0 && (
            <div className="sv-block">
              <div className="sv-caption caps sv-danger">
                Banned Chemicals Detected
              </div>
              <ul className="sv-list sv-text-sm">
                {bannedChemicals.map((c) => (
                  <li key={c.code || c.name || String(c)}>
                    {c.name || c.code || String(c)}
                    {c.reason ? (
                      <span className="sv-muted"> — {c.reason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {invasives.length > 0 && (
            <div className="sv-block">
              <div className="sv-caption caps sv-danger">
                Invasive Species Flagged
              </div>
              <ul className="sv-list sv-text-sm">
                {invasives.map((p) => (
                  <li key={p.scientificName || p.name || String(p)}>
                    {p.name || p.scientificName || String(p)}
                    {p.region ? (
                      <span className="sv-muted"> • region: {p.region}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {seasonConflicts.length > 0 && (
            <div className="sv-block">
              <div className="sv-caption caps sv-warn">
                Season Timing Conflicts
              </div>
              <ul className="sv-list sv-text-sm">
                {seasonConflicts.map((s, idx) => (
                  <li key={idx}>
                    {s.crop || s.plant || "Plant"} —{" "}
                    {s.message ||
                      `planned for ${s.plannedSeason || "?"}, recommended ${
                        s.recommendedSeason || "?"
                      }`}
                  </li>
                ))}
              </ul>
              <p className="sv-muted sv-text-xs">
                These are usually soft conflicts: you may be using a greenhouse,
                row covers, or other season extension methods.
              </p>
            </div>
          )}

          {Array.isArray(compliance.messages) &&
            compliance.messages.length > 0 && (
              <div className="sv-block">
                <div className="sv-caption caps">Notes</div>
                <ul className="sv-list sv-text-sm">
                  {compliance.messages.map((m, idx) => (
                    <li key={idx}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

          <p className="sv-muted sv-text-xs">
            Tip: you can adjust plant choice, chemicals, or timing in your
            Garden Planner, then try saving again.
          </p>
        </div>

        <div className="sv-row sv-justify-end sv-gap sv-pad">
          <Button variant="ghost" onClick={onCancel}>
            Back to Planner
          </Button>
          {isSoft && (
            <Button
              variant="outline"
              onClick={() => onOverrideSave(artifact, compliance)}
            >
              Save with overrides
            </Button>
          )}
          {isBlocked && (
            <Button variant="outline" disabled>
              Save blocked
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

/* --------------------------- Helper: format dates --------------------------- */

function formatDate(ts) {
  if (!ts) return "—";
  try {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

/* ------------------------------ Main component ------------------------------ */

/**
 * GardenPlanVault
 *
 * Props:
 *   - householdId?: string
 *       Optional; if not provided, component attempts to resolve via automation.
 *
 *   - getCurrentPlan?: () => any
 *       Optional; when present, the "Save current plan" CTA will call this to
 *       get the raw garden plan structure (the same one the Garden Planner uses).
 *
 *   - onPlanSelected?: (artifact) => void
 *       Optional; called when the user clicks "Load to planner" for a saved plan.
 */
export default function GardenPlanVault({
  householdId: householdIdProp,
  getCurrentPlan,
  onPlanSelected,
}) {
  const [householdId, setHouseholdId] = useState(householdIdProp || null);
  const [plans, setPlans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState(null);
  const [banner, setBanner] = useState(null);

  const [pendingArtifact, setPendingArtifact] = useState(null);
  const [pendingCompliance, setPendingCompliance] = useState(null);
  const [showComplianceWizard, setShowComplianceWizard] = useState(false);
  const [saving, setSaving] = useState(false);

  /* ---------------------------- Resolve household --------------------------- */

  useEffect(() => {
    setHouseholdId(householdIdProp || householdId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdIdProp]);

  useEffect(() => {
    if (householdId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await automation.request?.("household.current", {});
        if (!cancelled && res?.id) setHouseholdId(res.id);
      } catch {
        // Soft failure; user will need to pass householdId via props.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [householdId]);

  /* ----------------------------- Load vault data ---------------------------- */

  const loadPlans = async () => {
    if (!householdId) return;
    setLoading(true);
    try {
      const list = await listArtifactsFromVault({
        domain: "garden",
        householdId,
      });
      setPlans(Array.isArray(list) ? list : []);
    } catch (e) {
      console.warn("[GardenPlanVault] listArtifactsFromVault failed:", e);
      setPlans([]);
      setBanner({
        tone: "error",
        text: "Couldn’t load garden plans from vault.",
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!householdId) return;
    loadPlans();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [householdId]);

  /* -------------------------- Derived vault metadata ------------------------ */

  const stats = useMemo(() => {
    const total = plans.length;
    const seasons = new Set();
    const tags = new Set();
    plans.forEach((p) => {
      const meta = p.metadata || p.meta || {};
      if (Array.isArray(meta.seasons)) {
        meta.seasons.forEach((s) => s && seasons.add(s));
      }
      if (Array.isArray(p.tags)) {
        p.tags.forEach((t) => t && tags.add(t));
      }
    });
    return {
      total,
      seasons: Array.from(seasons),
      tags: Array.from(tags),
    };
  }, [plans]);

  /* ------------------------- Save garden plans (core) ----------------------- */

  async function handleSaveGardenPlan(rawInput) {
    if (!householdId) {
      setToast({
        tone: "error",
        text: "No household selected. Please pick or create a household first.",
      });
      return;
    }
    if (!prepareArtifactForVault || !saveArtifactToVault) {
      setToast({
        tone: "error",
        text: "Vault services are not available right now.",
      });
      return;
    }

    setSaving(true);
    setToast(null);

    try {
      const { artifact, compliance } = await prepareArtifactForVault({
        domain: "garden",
        householdId,
        rawInput,
      });

      if (!artifact) {
        throw new Error("No artifact returned from prepareArtifactForVault");
      }

      const status = compliance?.status;
      const isCompliant =
        !status ||
        status === COMPLIANCE_STATUS.COMPLIANT ||
        status === "COMPLIANT";

      if (!isCompliant) {
        // Compliance wizard flow for soft / blocked conflicts
        setPendingArtifact(artifact);
        setPendingCompliance(compliance);
        setShowComplianceWizard(true);

        // Also show a banner hint
        setBanner({
          tone: "warning",
          text: "Garden plan needs compliance review before saving.",
        });
        return;
      }

      // Happy path: directly save
      const saved = await saveArtifactToVault({
        domain: "garden",
        householdId,
        artifact,
      });

      const artifactId = saved?.id || artifact.id;
      const ts = new Date().toISOString();

      // SSA event bus (consistent payload shape inside data)
      eventBus.emit?.("garden.plan.saved", {
        type: "garden.plan.saved",
        ts,
        source: "ui/GardenPlanVault",
        data: {
          householdId,
          artifactId,
          artifact: saved || artifact,
          compliance,
        },
      });

      // Automation runtime hint
      try {
        automation.emitEvent?.("garden.plan.saved", {
          householdId,
          artifactId,
          artifact: saved || artifact,
          compliance,
          ts,
        });
      } catch (e) {
        console.warn("[GardenPlanVault] automation.emitEvent failed:", e);
      }

      // Optional Hub export
      exportToHubIfEnabled({
        householdId,
        artifactId,
        artifact: saved || artifact,
        compliance,
      });

      setToast({
        tone: "success",
        text: "Garden plan saved to vault.",
      });

      // Refresh vault list
      await loadPlans();

      if (typeof onPlanSelected === "function") {
        onPlanSelected(saved || artifact);
      }
    } catch (e) {
      console.error("[GardenPlanVault] handleSaveGardenPlan error:", e);
      setToast({
        tone: "error",
        text: "Couldn’t save garden plan. Try again after adjusting it.",
      });
    } finally {
      setSaving(false);
    }
  }

  /**
   * When the user chooses "Save with overrides" in compliance wizard:
   *  - We persist the artifact anyway, but the compliance object is kept so
   *    downstream engines and analytics can see what was overridden.
   */
  const handleComplianceOverrideSave = async (artifact, compliance) => {
    if (!householdId || !artifact) return;
    setShowComplianceWizard(false);
    setSaving(true);

    try {
      const saved = await saveArtifactToVault({
        domain: "garden",
        householdId,
        artifact: {
          ...artifact,
          complianceOverride: true,
        },
      });

      const artifactId = saved?.id || artifact.id;
      const ts = new Date().toISOString();

      eventBus.emit?.("garden.plan.saved", {
        type: "garden.plan.saved",
        ts,
        source: "ui/GardenPlanVault",
        data: {
          householdId,
          artifactId,
          artifact: saved || artifact,
          compliance,
          override: true,
        },
      });

      try {
        automation.emitEvent?.("garden.plan.saved", {
          householdId,
          artifactId,
          artifact: saved || artifact,
          compliance,
          override: true,
          ts,
        });
      } catch (e) {
        console.warn("[GardenPlanVault] automation.emitEvent failed:", e);
      }

      exportToHubIfEnabled({
        householdId,
        artifactId,
        artifact: saved || artifact,
        compliance,
        override: true,
      });

      setToast({
        tone: "success",
        text: "Garden plan saved with overrides.",
      });
      setPendingArtifact(null);
      setPendingCompliance(null);

      await loadPlans();

      if (typeof onPlanSelected === "function") {
        onPlanSelected(saved || artifact);
      }
    } catch (e) {
      console.error("[GardenPlanVault] handleComplianceOverrideSave error:", e);
      setToast({
        tone: "error",
        text: "Couldn’t save with overrides. Try adjusting your plan.",
      });
    } finally {
      setSaving(false);
    }
  };

  /* --------------------------- Delete / select plans ------------------------ */

  const handleDeletePlan = async (planId) => {
    if (!householdId || !planId) return;
    try {
      const ok = await deleteArtifactFromVault({
        domain: "garden",
        householdId,
        id: planId,
      });
      if (!ok) {
        setToast({
          tone: "error",
          text: "Couldn’t delete garden plan.",
        });
        return;
      }
      setToast({
        tone: "info",
        text: "Garden plan removed from vault.",
      });
      await loadPlans();
    } catch (e) {
      console.error("[GardenPlanVault] handleDeletePlan error:", e);
      setToast({
        tone: "error",
        text: "Error removing plan. Try again.",
      });
    }
  };

  const handleLoadToPlanner = (plan) => {
    if (typeof onPlanSelected === "function") {
      onPlanSelected(plan);
    } else {
      // Fallback: emit event for a Garden Planner to listen to
      const ts = new Date().toISOString();
      eventBus.emit?.("garden.plan.selected", {
        type: "garden.plan.selected",
        ts,
        source: "ui/GardenPlanVault",
        data: {
          householdId,
          artifactId: plan.id,
          artifact: plan,
        },
      });
    }
  };

  /* -------------------------------- Render ---------------------------------- */

  return (
    <div className="sv-stack">
      <Card className="sv-pad sv-block">
        <SectionHeader
          icon="🌱"
          title="Garden Plan Vault"
          sub="Save, review, and reuse garden layouts, rotations, and succession plans."
          right={
            <div className="sv-row sv-gap sv-align-center">
              <span className="sv-caption">
                {stats.total} saved • seasons:{" "}
                {stats.seasons.length ? stats.seasons.join(", ") : "—"}
              </span>
            </div>
          }
        />

        {banner && (
          <Banner tone={banner.tone} onDismiss={() => setBanner(null)}>
            {banner.text}
          </Banner>
        )}

        <div className="sv-row sv-gap sv-wrap sv-align-center sv-pad-y-sm">
          <Button
            onClick={() => {
              if (!getCurrentPlan) {
                setToast({
                  tone: "info",
                  text: "Connect this vault to your Garden Planner to save plans.",
                });
                return;
              }
              const raw = getCurrentPlan();
              if (!raw) {
                setToast({
                  tone: "error",
                  text: "No current garden plan found in planner.",
                });
                return;
              }
              handleSaveGardenPlan(raw);
            }}
            disabled={saving || !getCurrentPlan}
            title={
              getCurrentPlan
                ? "Save the current garden planner state into the vault"
                : "Wire getCurrentPlan() to enable saving"
            }
          >
            {saving ? "Saving…" : "Save current plan"}
          </Button>
          <Button
            variant="outline"
            onClick={loadPlans}
            disabled={loading || !householdId}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </Button>
          <span className="sv-caption">
            Household:{" "}
            {householdId ? (
              <code className="sv-code">{householdId}</code>
            ) : (
              <span className="sv-muted">none</span>
            )}
          </span>
        </div>

        <div className="sv-divider" />

        {plans.length === 0 ? (
          <div className="sv-empty sv-text-sm">
            <p className="sv-muted">
              No garden plans saved yet. Build one in your Garden Planner, then
              use <strong>“Save current plan”</strong> to store a compliant
              artifact here.
            </p>
          </div>
        ) : (
          <div className="sv-stack-sm">
            {plans.map((plan) => {
              const meta = plan.metadata || plan.meta || {};
              const seasons = Array.isArray(meta.seasons) ? meta.seasons : [];
              const tags = Array.isArray(plan.tags) ? plan.tags : [];
              const compliance = plan.compliance || meta.compliance;
              const status = compliance?.status;
              const isSoft =
                status === COMPLIANCE_STATUS.SOFT_CONFLICT ||
                status === "SOFT_CONFLICT";

              return (
                <div
                  key={plan.id}
                  className="sv-row sv-justify-between sv-align-start sv-card sv-pad"
                  style={{ borderRadius: 10 }}
                >
                  <div className="sv-stack-xxs">
                    <div className="sv-row sv-gap sv-align-center">
                      <div className="sv-strong">
                        {plan.title || meta.title || "Garden Plan"}
                      </div>
                      {status && (
                        <span
                          className={`sv-badge ${
                            status === COMPLIANCE_STATUS.COMPLIANT
                              ? "sv-badge--success"
                              : isSoft
                              ? "sv-badge--warn"
                              : "sv-badge--danger"
                          }`}
                        >
                          {status}
                        </span>
                      )}
                    </div>
                    <div className="sv-caption sv-muted">
                      Saved {formatDate(plan.createdAt || plan.savedAt)} •
                      seasons:{" "}
                      {seasons.length ? seasons.join(", ") : "not specified"}
                      {tags.length ? (
                        <>
                          {" "}
                          • tags:{" "}
                          <span className="sv-italic">{tags.join(", ")}</span>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="sv-stack-xxs sv-align-end">
                    <Button
                      variant="primary"
                      onClick={() => handleLoadToPlanner(plan)}
                    >
                      Load to planner
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => handleDeletePlan(plan.id)}
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* Compliance wizard modal */}
      <ComplianceWizard
        open={showComplianceWizard}
        artifact={pendingArtifact}
        compliance={pendingCompliance}
        onCancel={() => {
          setShowComplianceWizard(false);
        }}
        onOverrideSave={handleComplianceOverrideSave}
      />

      {/* Toast */}
      {toast && (
        <div className="sv-toastWrap">
          <Toast
            tone={toast.tone}
            text={toast.text}
            action={toast.action}
            onClose={() => setToast(null)}
          />
        </div>
      )}
    </div>
  );
}

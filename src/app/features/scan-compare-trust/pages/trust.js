// C:\Users\larho\suka-smart-assistant\src\app\features\scan-compare-trust\pages\trust.js
//
// Scan • Compare • Trust – Trust Rules Page
// -----------------------------------------
// This page is the “trust brain” for the Scan • Compare • Trust feature.
// It lets users:
//   - See and tweak their household trust rules (ingredients, packaging,
//     brand history, store rules).
//   - Review how past decisions shaped those rules.
//   - Launch a “Now” session that applies these rules live in a
//     storehouse/cooking/preservation context via the shared SessionRunner.
//
// How this fits into the SessionRunner system
// -------------------------------------------
// - The SessionRunner modal is mounted at the app root (App.jsx) via a
//   SessionRunnerProvider + Portal, so it survives route changes.
// - This page *only* talks to SessionRunner via the useSessionRunner hook.
// - “Apply Rules Now” CTA resolves to the next runnable session with
//   domainHint = ["storehouse", "cooking", "preservation"].
// - If a session is already running, the CTA becomes
//   “Return to live session” and simply focuses the runner.
//
// Assumed existing code:
//   src/app/shared/session/SessionRunnerContext.jsx (or .js)
//   that exports:
//
//     export function useSessionRunner() {
//       return {
//         isRunning: boolean,
//         currentSessionSummary: {
//           id: string,
//           title: string,
//           domain: string,
//           currentStepTitle?: string | null,
//         } | null,
//         openNextRunnableSession: (options?: {
//           domainHint?: string | string[],
//           allowSelector?: boolean,
//         }) => void,
//         focusRunner: () => void,
//       };
//     }
//
// Adjust import paths as needed if your structure differs.

import React, { useMemo } from "react";
import { format as formatDate } from "date-fns";
import { useSessionRunner } from "../../../shared/session/SessionRunnerContext";

/**
 * @typedef {Object} TrustRule
 * @property {string} id
 * @property {string} category
 * @property {string} rule
 * @property {string} impact
 * @property {boolean} enabled
 */

/**
 * @typedef {Object} TrustEvent
 * @property {string} id
 * @property {string} dateISO
 * @property {string} product
 * @property {string} outcome
 * @property {string} note
 */

/**
 * TrustPage
 * ---------
 * Main UI component for /features/scan-compare-trust/trust.
 * Renders:
 *   - Session awareness + “Now” CTA banner.
 *   - Left: Household trust rules.
 *   - Middle: Ingredient risk matrix (simplified).
 *   - Right: Brand/store history.
 *   - Bottom: Recent trust-driven decisions.
 */
export default function TrustPage() {
  // --- SessionRunner integration -------------------------------------------

  /** @type {ReturnType<typeof useSessionRunner> | null} */
  let sessionApi = null;
  try {
    sessionApi = useSessionRunner();
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[ScanCompareTrust/Trust] useSessionRunner unavailable:",
        err
      );
    }
  }

  const isRunnerAvailable = Boolean(sessionApi);
  const isRunning = sessionApi?.isRunning ?? false;
  const currentSessionSummary = sessionApi?.currentSessionSummary ?? null;

  /**
   * Handle “Apply Rules Now” CTA click:
   * - If session already running: just focus it.
   * - Else: open next runnable session with storehouse/cooking/preservation
   *   as hints.
   */
  const handleNowClick = () => {
    if (!sessionApi) return;

    if (sessionApi.isRunning) {
      sessionApi.focusRunner?.();
      return;
    }

    const domainHint = ["storehouse", "cooking", "preservation"];

    sessionApi.openNextRunnableSession?.({
      domainHint,
      allowSelector: true,
    });
  };

  // --- Demo data (replace later with Dexie-backed trusted rules) -----------

  /** @type {TrustRule[]} */
  const trustRules = useMemo(
    () => [
      {
        id: "r1",
        category: "Ingredients",
        rule: "Avoid added sugar in pantry staples",
        impact:
          "SSA will prefer no-sugar options for sauces, broths, and snacks.",
        enabled: true,
      },
      {
        id: "r2",
        category: "Packaging",
        rule: "Prefer glass or BPA-free cans when possible",
        impact:
          "SSA will rank glass-jar and BPA-free options higher for long-term storehouse items.",
        enabled: true,
      },
      {
        id: "r3",
        category: "Oils & Fats",
        rule: "Avoid seed oils (soy, canola, corn, etc.)",
        impact:
          "SSA will suggest alternatives using olive, avocado, butter, or animal fats where possible.",
        enabled: true,
      },
      {
        id: "r4",
        category: "Brand & Store",
        rule: "Flag brands with repeated quality issues",
        impact:
          "SSA will lower trust scores and show warnings for these brands during sessions.",
        enabled: true,
      },
      {
        id: "r5",
        category: "Budget",
        rule: "Prefer unit price below household thresholds",
        impact:
          "SSA will highlight items that land within price/oz limits set for each category.",
        enabled: true,
      },
    ],
    []
  );

  /** @type {TrustEvent[]} */
  const recentTrustEvents = useMemo(
    () => [
      {
        id: "e1",
        dateISO: new Date().toISOString(),
        product: "Organic Tomato Sauce – Big Box Brand",
        outcome: "Rejected (added sugar + seed oils)",
        note: "SSA suggested crushed tomatoes + seasoning instead.",
      },
      {
        id: "e2",
        dateISO: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString(),
        product: "Local Reserve Crushed Tomatoes (No Salt Added)",
        outcome: "Approved (trusted choice)",
        note: "Added as default for all recipes calling for tomato base.",
      },
      {
        id: "e3",
        dateISO: new Date(Date.now() - 1000 * 60 * 60 * 24 * 2).toISOString(),
        product: "Budget Broth – Store Brand",
        outcome: "Flagged (unknown ingredient sourcing)",
        note: "SSA lowered trust score and recommended making broth at home.",
      },
    ],
    []
  );

  // Ingredient risk matrix – demo data
  const riskMatrix = useMemo(
    () => [
      {
        ingredient: "High-fructose corn syrup",
        risk: "High",
        reason: "Ultra-processed sweetener",
      },
      {
        ingredient: "Hydrogenated oils",
        risk: "High",
        reason: "Trans fats / heart health",
      },
      {
        ingredient: "Natural flavors (unspecified)",
        risk: "Medium",
        reason: "Opaque sourcing",
      },
      {
        ingredient: "Citric acid",
        risk: "Low",
        reason: "Generally safe; watch for sensitivity",
      },
      {
        ingredient: "Sea salt",
        risk: "Low",
        reason: "Preferred to iodized for some households",
      },
    ],
    []
  );

  // --- Render ---------------------------------------------------------------

  return (
    <div className="sct-trust-page">
      {/* Top banner: trust brain + Now CTA */}
      <section className="sct-trust-header-card">
        <div className="sct-trust-header-main">
          <h1 className="sct-trust-title">Household Trust Rules</h1>
          <p className="sct-trust-subtitle">
            Define what “trustworthy” means for your household so Suka Smart
            Assistant can enforce it during shopping, cooking, and preservation
            sessions.
          </p>

          <div className="sct-trust-session-row">
            <div className="sct-trust-session-status">
              {isRunnerAvailable ? (
                isRunning && currentSessionSummary ? (
                  <>
                    <span className="session-pill session-pill--active">
                      Live session: {currentSessionSummary.title}
                    </span>
                    {currentSessionSummary.currentStepTitle && (
                      <span className="session-pill session-pill--step">
                        Now: {currentSessionSummary.currentStepTitle}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="session-pill session-pill--idle">
                    No live session running.
                  </span>
                )
              ) : (
                <span className="session-pill session-pill--warn">
                  Session runner not available. Check SessionRunnerProvider
                  setup.
                </span>
              )}
            </div>

            <div className="sct-trust-session-cta">
              <button
                type="button"
                className="btn btn-primary btn-now-session"
                onClick={handleNowClick}
                disabled={!isRunnerAvailable}
                aria-disabled={!isRunnerAvailable}
              >
                {isRunnerAvailable
                  ? isRunning
                    ? "Return to live session"
                    : "Apply rules in a live session now"
                  : "Session runner unavailable"}
              </button>
              <p className="sct-trust-session-hint">
                The live session will keep running in the background even if you
                navigate away. Use this page to tune the rules that guide SSA’s
                recommendations.
              </p>
            </div>
          </div>
        </div>

        <div className="sct-trust-header-meta">
          <div className="sct-meta-chip">
            <span className="sct-meta-label">Today</span>
            <span className="sct-meta-value">
              {formatDate(new Date(), "MMM d, yyyy")}
            </span>
          </div>
          <div className="sct-meta-chip">
            <span className="sct-meta-label">Profile</span>
            <span className="sct-meta-value">Scan • Compare • Trust</span>
          </div>
        </div>
      </section>

      {/* Main 3-column layout */}
      <section className="sct-trust-grid">
        {/* Column 1: Rules */}
        <article className="sct-column sct-column--rules">
          <header className="sct-column-header">
            <h2>Core Household Rules</h2>
            <p className="sct-column-subtitle">
              SSA uses these rules to compute trust scores and rank products.
            </p>
          </header>

          <div className="sct-rules-list">
            {trustRules.map((rule) => (
              <div
                key={rule.id}
                className={
                  "sct-rule-card" +
                  (rule.enabled
                    ? " sct-rule-card--enabled"
                    : " sct-rule-card--disabled")
                }
              >
                <div className="sct-rule-header">
                  <span className="sct-tag sct-tag--category">
                    {rule.category}
                  </span>
                  <label className="sct-toggle">
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={(e) => {
                        // Wire this to Dexie/settings later.
                        // eslint-disable-next-line no-console
                        console.log(
                          "[ScanCompareTrust/Trust] TODO: toggle rule enabled:",
                          rule.id,
                          e.target.checked
                        );
                      }}
                    />
                    <span className="sct-toggle-slider" />
                  </label>
                </div>

                <p className="sct-rule-text">{rule.rule}</p>
                <p className="sct-rule-impact">
                  <strong>SSA impact:</strong> {rule.impact}
                </p>
              </div>
            ))}
          </div>
        </article>

        {/* Column 2: Ingredient risk matrix */}
        <article className="sct-column sct-column--matrix">
          <header className="sct-column-header">
            <h2>Ingredient Risk Matrix</h2>
            <p className="sct-column-subtitle">
              A quick view of how SSA currently scores common ingredients.
            </p>
          </header>

          <div className="sct-matrix-card">
            <table className="sct-matrix-table">
              <thead>
                <tr>
                  <th>Ingredient</th>
                  <th>Risk</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {riskMatrix.map((row) => (
                  <tr key={row.ingredient}>
                    <td>{row.ingredient}</td>
                    <td>
                      <span
                        className={
                          "sct-risk-pill " +
                          (row.risk === "High"
                            ? "sct-risk-pill--high"
                            : row.risk === "Medium"
                            ? "sct-risk-pill--medium"
                            : "sct-risk-pill--low")
                        }
                      >
                        {row.risk}
                      </span>
                    </td>
                    <td>{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <p className="sct-matrix-footnote">
              These are starting points. As your household logs decisions, SSA
              can refine this matrix for your specific needs and sensitivities.
            </p>

            <button
              type="button"
              className="btn btn-secondary btn-ghost"
              onClick={() => {
                // Hook into a dedicated matrix editor later.
                // eslint-disable-next-line no-console
                console.log(
                  "[ScanCompareTrust/Trust] TODO: open ingredient matrix editor"
                );
              }}
            >
              Edit matrix details
            </button>
          </div>
        </article>

        {/* Column 3: Brand & store trust */}
        <article className="sct-column sct-column--brands">
          <header className="sct-column-header">
            <h2>Brand & Store History</h2>
            <p className="sct-column-subtitle">
              Track which brands and stores your household favors or avoids.
            </p>
          </header>

          <div className="sct-brand-card">
            <h3 className="sct-brand-section-title">Preferred brands</h3>
            <ul className="sct-brand-list">
              <li>Local Reserve (pantry staples)</li>
              <li>Heritage Fields (tomato & vegetable line)</li>
              <li>Village Mills (flour & grains)</li>
            </ul>

            <h3 className="sct-brand-section-title">Caution list</h3>
            <ul className="sct-brand-list sct-brand-list--caution">
              <li>Big Box Brand (sauces & snacks – added sugar / seed oils)</li>
              <li>Budget Broth Store Brand (opaque sourcing)</li>
            </ul>

            <button
              type="button"
              className="btn btn-secondary btn-ghost"
              onClick={() => {
                // Wire this into a brand/store editor & Dexie store.
                // eslint-disable-next-line no-console
                console.log(
                  "[ScanCompareTrust/Trust] TODO: open brand/store editor"
                );
              }}
            >
              Edit brand & store trust
            </button>

            <p className="sct-brand-footnote">
              During live sessions, SSA will highlight preferred brands and
              place warnings next to caution-list brands before you add them to
              your storehouse.
            </p>
          </div>
        </article>
      </section>

      {/* Recent trust-driven decisions */}
      <section className="sct-trust-events">
        <header className="sct-events-header">
          <h2>Recent Trust-Based Decisions</h2>
          <p>
            SSA learns each time you approve, reject, or flag a product. These
            events are used to refine your rules and future recommendations.
          </p>
        </header>

        <div className="sct-events-timeline">
          {recentTrustEvents.map((evt) => (
            <div key={evt.id} className="sct-event-row">
              <div className="sct-event-date">
                {formatDate(new Date(evt.dateISO), "MMM d")}
              </div>
              <div className="sct-event-body">
                <p className="sct-event-product">{evt.product}</p>
                <p className="sct-event-outcome">{evt.outcome}</p>
                <p className="sct-event-note">{evt.note}</p>
              </div>
            </div>
          ))}
        </div>

        <footer className="sct-events-footer">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleNowClick}
            disabled={!isRunnerAvailable}
          >
            {isRunnerAvailable
              ? isRunning
                ? "Return to live session"
                : "Apply these rules in a live session"
              : "Session runner unavailable"}
          </button>

          <p className="sct-events-footnote">
            When you complete or abort a session, SSA should write analytics
            records linked to these rules. Those analytics can later be exported
            to the Family Fund Hub whenever <code>familyFundMode</code> is
            enabled.
          </p>
        </footer>
      </section>
    </div>
  );
}

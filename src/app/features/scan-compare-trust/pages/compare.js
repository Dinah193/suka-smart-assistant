// C:\Users\larho\suka-smart-assistant\src\app\features\scan-compare-trust\pages\compare.js
//
// Scan • Compare • Trust – Compare Page
// -------------------------------------
// This page is the main “comparison workbench” for the Scan • Compare • Trust
// feature. It lets users line up scanned products, compare price/unit,
// ingredients, and trust signals, and then:
//   - Mark a “trusted choice” for the cart/storehouse.
//   - Trigger a “Now” session that guides them live (SSA SessionRunner)
//     through a purchase/stock-up run tied to the storehouse/cooking domains.
//
// How this fits into the SessionRunner system
// -------------------------------------------
// - The actual SessionRunner modal is mounted at the app root (e.g. in App.jsx)
//   via a SessionRunnerProvider + Portal, so it survives route changes.
// - This page only *invokes* the runner via the useSessionRunner hook.
// - The "Shop / Decide Now" CTA calls openNextRunnableSession(...) with a
//   domainHint of "storehouse" (and optionally "cooking") so the runner
//   chooses the next runnable session relevant to shopping/stocking.
// - If a session is already running, the CTA becomes "Return to live session"
//   and simply re-opens/focuses the runner.
//
// Requirements touched here
// -------------------------
// - Prominent “Now” CTA on this domain page.
// - The CTA resolves to “the next runnable session” via SessionRunner API.
// - If the hook or API is missing, we fail safely with a console warning and
//   a disabled button, not a runtime crash.
//
// NOTE: This file assumes you have already created:
//   - src/app/shared/session/SessionRunnerContext.jsx (or .js) that exports:
//       function useSessionRunner(): {
//         isRunning: boolean,
//         currentSessionSummary: { id, title, domain, currentStepTitle } | null,
//         openNextRunnableSession: (options?: {
//            domainHint?: string | string[],
//            allowSelector?: boolean
//         }) => void,
//         focusRunner: () => void
//       }
//
// You can adjust the import path/names to match your actual implementation.

/* eslint-disable react-hooks/rules-of-hooks */

import React, { useMemo } from "react";
import { format as formatDate } from "date-fns";
import { useSessionRunner } from "../../../shared/session/SessionRunnerContext";

/**
 * @typedef {Object} ComparedItem
 * @property {string} id
 * @property {string} name
 * @property {string} brand
 * @property {string} sizeDisplay
 * @property {number} unitPrice
 * @property {string} unitLabel
 * @property {number} trustScore
 * @property {string[]} flags
 * @property {boolean} isFromScan
 * @property {boolean} isStoreBrand
 */

/**
 * Helper to format trust scores as a simple label.
 * @param {number} score 0–100
 * @returns {string}
 */
function trustLabel(score) {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Good";
  if (score >= 60) return "Okay";
  if (score > 0) return "Caution";
  return "Unknown";
}

/**
 * Helper to pick a simple traffic-light class for trust scores.
 * These are semantic class names; you can style them in your CSS.
 * @param {number} score
 * @returns {string}
 */
function trustClass(score) {
  if (score >= 90) return "trust-pill trust-pill--high";
  if (score >= 75) return "trust-pill trust-pill--medium";
  if (score >= 60) return "trust-pill trust-pill--low";
  if (score > 0) return "trust-pill trust-pill--warn";
  return "trust-pill trust-pill--unknown";
}

/**
 * ComparePage
 * -----------
 * Main UI component for /features/scan-compare-trust/compare.
 * Renders:
 *   - Session awareness + “Now” CTA banner.
 *   - A three-column comparison grid: scanned item, alternatives, decision.
 */
export default function ComparePage() {
  // --- SessionRunner integration -------------------------------------------

  /** @type {ReturnType<typeof useSessionRunner> | null} */
  let sessionApi = null;
  try {
    // If the provider isn't mounted yet, this may throw; we guard it.
    sessionApi = useSessionRunner();
  } catch (err) {
    // Fail-safe: log and keep UI usable without the runner.
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn(
        "[ScanCompareTrust/Compare] useSessionRunner unavailable:",
        err
      );
    }
  }

  const isRunnerAvailable = Boolean(sessionApi);
  const isRunning = sessionApi?.isRunning ?? false;
  const currentSessionSummary = sessionApi?.currentSessionSummary ?? null;

  /**
   * Handle “Now” CTA click:
   * - If a session is already running, just focus/open it.
   * - Otherwise, ask SessionRunner to resolve the next runnable session
   *   for storehouse/cooking-related work.
   */
  const handleNowClick = () => {
    if (!sessionApi) return;

    if (sessionApi.isRunning) {
      sessionApi.focusRunner?.();
      return;
    }

    // Hint that we're on a "shopping / stock-up" page.
    const domainHint = ["storehouse", "cooking"];

    sessionApi.openNextRunnableSession?.({
      domainHint,
      allowSelector: true,
    });
  };

  // --- Demo data for the comparison grid -----------------------------------
  // In real SSA, these will come from Dexie + the Scan • Compare • Trust engine.

  /** @type {ComparedItem} */
  const scannedItem = useMemo(
    () => ({
      id: "scanned-1",
      name: "Organic Tomato Sauce",
      brand: "Big Box Brand",
      sizeDisplay: "24 oz jar",
      unitPrice: 0.13,
      unitLabel: "per oz",
      trustScore: 62,
      flags: ["Added sugar", "Seed oils", "Plastic-lined lid"],
      isFromScan: true,
      isStoreBrand: false,
    }),
    []
  );

  /** @type {ComparedItem[]} */
  const alternatives = useMemo(
    () => [
      {
        id: "alt-1",
        name: "Crushed Tomatoes (No Salt Added)",
        brand: "Local Reserve",
        sizeDisplay: "28 oz can",
        unitPrice: 0.1,
        unitLabel: "per oz",
        trustScore: 92,
        flags: ["BPA-free", "No sugar", "Short ingredient list"],
        isFromScan: false,
        isStoreBrand: true,
      },
      {
        id: "alt-2",
        name: "Fire-Roasted Tomatoes",
        brand: "Heritage Fields",
        sizeDisplay: "15 oz can",
        unitPrice: 0.15,
        unitLabel: "per oz",
        trustScore: 80,
        flags: ["No sugar", "Olive oil", "Glass jar option"],
        isFromScan: false,
        isStoreBrand: false,
      },
    ],
    []
  );

  const trustedChoice = alternatives[0];

  // --- Render ---------------------------------------------------------------

  return (
    <div className="sct-compare-page">
      {/* Top banner with session awareness + Now CTA */}
      <section className="sct-compare-header-card">
        <div className="sct-compare-header-main">
          <h1 className="sct-compare-title">Scan • Compare • Trust</h1>
          <p className="sct-compare-subtitle">
            Line up your options, pick the most trustworthy product, and let
            Suka Smart Assistant guide your shopping or stock-up session.
          </p>

          <div className="sct-compare-session-row">
            <div className="sct-compare-session-status">
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

            <div className="sct-compare-session-cta">
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
                    : "Shop / Decide Now"
                  : "Session runner unavailable"}
              </button>
              <p className="sct-compare-session-hint">
                The live session will stay active even if you navigate to other
                SSA pages. You can always come back here to adjust your choices.
              </p>
            </div>
          </div>
        </div>

        <div className="sct-compare-header-meta">
          <div className="sct-meta-chip">
            <span className="sct-meta-label">Today</span>
            <span className="sct-meta-value">
              {formatDate(new Date(), "MMM d, yyyy")}
            </span>
          </div>
          <div className="sct-meta-chip">
            <span className="sct-meta-label">Mode</span>
            <span className="sct-meta-value">Storehouse / Shopping</span>
          </div>
        </div>
      </section>

      {/* Comparison workspace */}
      <section className="sct-compare-grid">
        {/* Column 1: Scanned item */}
        <article className="sct-column sct-column--scanned">
          <header className="sct-column-header">
            <h2>Scanned Item</h2>
            <span className="sct-tag sct-tag--scan">From barcode scan</span>
          </header>

          <div className="sct-product-card">
            <div className="sct-product-header">
              <h3 className="sct-product-name">{scannedItem.name}</h3>
              <p className="sct-product-brand">{scannedItem.brand}</p>
            </div>

            <dl className="sct-product-meta">
              <div className="sct-product-meta-row">
                <dt>Size</dt>
                <dd>{scannedItem.sizeDisplay}</dd>
              </div>
              <div className="sct-product-meta-row">
                <dt>Unit price</dt>
                <dd>
                  ${scannedItem.unitPrice.toFixed(2)} {scannedItem.unitLabel}
                </dd>
              </div>
              <div className="sct-product-meta-row">
                <dt>Trust score</dt>
                <dd>
                  <span className={trustClass(scannedItem.trustScore)}>
                    {trustLabel(scannedItem.trustScore)} ·{" "}
                    {scannedItem.trustScore}%
                  </span>
                </dd>
              </div>
            </dl>

            <div className="sct-product-flags">
              <p className="sct-flags-label">Watch-outs</p>
              <ul>
                {scannedItem.flags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            </div>

            <footer className="sct-product-footer">
              <button
                type="button"
                className="btn btn-secondary btn-ghost"
                onClick={() => {
                  // NOTE: Wire this to your “Rescan” / “Replace from scan” logic.
                  // eslint-disable-next-line no-console
                  console.log(
                    "[ScanCompareTrust/Compare] TODO: Rescan/replace item"
                  );
                }}
              >
                Rescan / Replace
              </button>
            </footer>
          </div>
        </article>

        {/* Column 2: Alternatives */}
        <article className="sct-column sct-column--alternatives">
          <header className="sct-column-header">
            <h2>Alternatives</h2>
            <p className="sct-column-subtitle">
              SSA-flagged options based on price/unit, ingredients, and trust
              rules.
            </p>
          </header>

          <div className="sct-alt-list">
            {alternatives.map((item) => (
              <div
                key={item.id}
                className={
                  "sct-alt-card" +
                  (item.id === trustedChoice.id ? " sct-alt-card--trusted" : "")
                }
              >
                <div className="sct-alt-header">
                  <h3 className="sct-product-name">{item.name}</h3>
                  <p className="sct-product-brand">
                    {item.brand}
                    {item.isStoreBrand && (
                      <span className="sct-tag sct-tag--store">
                        Store brand
                      </span>
                    )}
                  </p>
                </div>

                <dl className="sct-product-meta">
                  <div className="sct-product-meta-row">
                    <dt>Size</dt>
                    <dd>{item.sizeDisplay}</dd>
                  </div>
                  <div className="sct-product-meta-row">
                    <dt>Unit price</dt>
                    <dd>
                      ${item.unitPrice.toFixed(2)} {item.unitLabel}
                    </dd>
                  </div>
                  <div className="sct-product-meta-row">
                    <dt>Trust score</dt>
                    <dd>
                      <span className={trustClass(item.trustScore)}>
                        {trustLabel(item.trustScore)} · {item.trustScore}%
                      </span>
                    </dd>
                  </div>
                </dl>

                <div className="sct-product-flags">
                  <p className="sct-flags-label">Highlights</p>
                  <ul>
                    {item.flags.map((flag) => (
                      <li key={flag}>{flag}</li>
                    ))}
                  </ul>
                </div>

                {item.id === trustedChoice.id && (
                  <div className="sct-trusted-ribbon">
                    <span>Trusted choice</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </article>

        {/* Column 3: Decision & notes */}
        <article className="sct-column sct-column--decision">
          <header className="sct-column-header">
            <h2>Decision & Notes</h2>
            <p className="sct-column-subtitle">
              Capture why you chose this item so future SSA sessions can learn
              your household’s rules.
            </p>
          </header>

          <div className="sct-decision-card">
            <h3 className="sct-decision-title">
              Plan: Add{" "}
              <span className="sct-decision-product">{trustedChoice.name}</span>{" "}
              to storehouse
            </h3>

            <ul className="sct-decision-summary">
              <li>
                <strong>Reason:</strong> Best combination of price/unit and
                trust score.
              </li>
              <li>
                <strong>Storehouse rule:</strong> Prefer no-sugar, BPA-free,
                short ingredient list options.
              </li>
              <li>
                <strong>SSA impact:</strong> Future sessions will recommend
                similar products when recipes call for “tomato base.”
              </li>
            </ul>

            <label className="sct-notes-label" htmlFor="decision-notes">
              Add a quick note (optional)
            </label>
            <textarea
              id="decision-notes"
              className="sct-notes-textarea"
              rows={5}
              placeholder="Example: Use this brand for all stews and sauces. Only buy sale price under $0.12/oz."
              onChange={(e) => {
                // Hook this to Dexie + rules engine as needed.
                // eslint-disable-next-line no-console
                console.log(
                  "[ScanCompareTrust/Compare] TODO: persist decision notes:",
                  e.target.value
                );
              }}
            />

            <div className="sct-decision-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  // Wire into your storehouse + pricing rules engine.
                  // eslint-disable-next-line no-console
                  console.log(
                    "[ScanCompareTrust/Compare] TODO: commit decision & update rules"
                  );
                }}
              >
                Save decision & update rules
              </button>

              <button
                type="button"
                className="btn btn-secondary btn-ghost"
                onClick={handleNowClick}
                disabled={!isRunnerAvailable}
              >
                {isRunnerAvailable
                  ? isRunning
                    ? "Return to live session"
                    : "Start storehouse session now"
                  : "Session runner unavailable"}
              </button>
            </div>

            <p className="sct-decision-footnote">
              When you start a session from here, SSA can weave this decision
              into your storehouse planning and shopping route, then export
              results to the Family Fund Hub when <code>familyFundMode</code> is
              enabled.
            </p>
          </div>
        </article>
      </section>
    </div>
  );
}

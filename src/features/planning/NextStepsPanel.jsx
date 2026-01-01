// C:\Users\larho\suka-smart-assistant\src\features\planning\NextStepsPanel.jsx

/**
 * NextStepsPanel
 * ---------------
 * How this fits SSA:
 * - This panel is the *UI face* of the Planning Graph "Next Steps" logic.
 * - After a user finishes a calculator/planner/tool, we want to show:
 *     • Suggested next calculators/planners (nodes in the graph).
 *     • Runnable sessions that can be launched *now* (cooking, cleaning,
 *       garden, animals, preservation, storehouse).
 * - It uses `useNextSteps` under the hood to:
 *     • Inspect outbound edges from the current node.
 *     • Match those neighbors against the latest result object.
 *     • Attach runnable sessions per target domain.
 *
 * Integration points:
 * - Pass in:
 *     • `nodeId` or `node` (Planning Graph node),
 *     • `result` (output from the node you just ran),
 *     • `sessions` (candidate sessions from Dexie).
 * - Wire callbacks:
 *     • `onLaunchSession(session)` → open SessionRunner modal at app root.
 *     • `onOpenNode(node)` → navigate to appropriate planner/calculator page.
 *
 * NOTE:
 * - This panel does NOT create/own the SessionRunner modal. It simply surfaces
 *   a clear "Now" CTA for parents to hook into their global SessionRunner.
 */

/* eslint-disable no-console */

import React, { useMemo, useState, useCallback } from "react";
import { useNextSteps } from "./useNextSteps";

/**
 * @typedef {import("./useNextSteps").NextStepRecommendation} NextStepRecommendation
 */

/**
 * @typedef {Object} NextStepsPanelProps
 * @property {string} [nodeId]
 * @property {import("./usePlanningGraph").PlanningNode} [node]
 * @property {any} [result]
 * @property {import("./useNextSteps").SessionLike[]} [sessions]
 * @property {string} [domainOverride]
 * @property {number} [limit]
 * @property {(session: import("./useNextSteps").SessionLike) => void} [onLaunchSession]
 * @property {(node: import("./usePlanningGraph").PlanningNode) => void} [onOpenNode]
 * @property {string} [title]
 * @property {boolean} [compact]
 */

/**
 * Small helper to format an ISO date into a human-readable short representation.
 * Safe: returns empty string on invalid input.
 *
 * @param {string|undefined|null} iso
 * @returns {string}
 */
function formatDateShort(iso) {
  if (!iso || typeof iso !== "string") return "";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  try {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

/**
 * Map domain to a human-friendly label.
 *
 * @param {string|undefined} domain
 * @returns {string}
 */
function prettyDomain(domain) {
  switch (domain) {
    case "cooking":
      return "Cooking";
    case "cleaning":
      return "Cleaning";
    case "garden":
      return "Garden";
    case "animals":
      return "Animal Care";
    case "preservation":
      return "Preservation";
    case "storehouse":
      return "Storehouse";
    default:
      return domain || "General";
  }
}

/**
 * Map recommendation type to a short label.
 *
 * @param {NextStepRecommendation["type"]} type
 * @returns {string}
 */
function prettyRecType(type) {
  if (type === "session") return "Session";
  return "Planner";
}

/**
 * Pill label for node kind.
 *
 * @param {string|undefined} kind
 * @returns {string}
 */
function prettyKind(kind) {
  if (!kind) return "";
  if (kind === "calculator") return "Calculator";
  if (kind === "planner") return "Planner";
  if (kind === "sessionTemplate") return "Session Template";
  return kind[0]?.toUpperCase() + kind.slice(1);
}

/**
 * Main reusable panel component.
 *
 * @param {NextStepsPanelProps} props
 */
export function NextStepsPanel(props) {
  const {
    nodeId,
    node,
    result,
    sessions,
    domainOverride,
    limit,
    onLaunchSession,
    onOpenNode,
    title = "Suggested Next Steps",
    compact = false,
  } = props || {};

  const [detailRecId, setDetailRecId] = useState(null);

  const { node: resolvedNode, hasGraph, recommendations, debug } = useNextSteps({
    nodeId,
    node,
    result,
    sessions,
    domainOverride,
    limit,
  });

  const handleLaunchSession = useCallback(
    (session) => {
      if (!session) return;
      if (typeof onLaunchSession === "function") {
        onLaunchSession(session);
      } else if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[NextStepsPanel] onLaunchSession not provided; session:",
          session
        );
      }
    },
    [onLaunchSession]
  );

  const handleOpenNode = useCallback(
    (targetNode) => {
      if (!targetNode) return;
      if (typeof onOpenNode === "function") {
        onOpenNode(targetNode);
      } else if (process.env.NODE_ENV !== "production") {
        console.warn(
          "[NextStepsPanel] onOpenNode not provided; node:",
          targetNode
        );
      }
    },
    [onOpenNode]
  );

  const detailRec = useMemo(
    () =>
      detailRecId
        ? recommendations.find((r) => r.id === detailRecId) || null
        : null,
    [detailRecId, recommendations]
  );

  const handleCloseDetail = useCallback(() => {
    setDetailRecId(null);
  }, []);

  const rootTitle = useMemo(() => {
    if (!resolvedNode) return title;
    const nodeTitle = resolvedNode.title || resolvedNode.id;
    return `${title}${nodeTitle ? ` · ${nodeTitle}` : ""}`;
  }, [title, resolvedNode]);

  const hasRecs = recommendations && recommendations.length > 0;

  return (
    <section
      className={`next-steps-panel ${compact ? "next-steps-panel--compact" : ""}`}
      aria-label="Suggested next steps"
    >
      <div className="next-steps-panel__header">
        <div className="next-steps-panel__header-main">
          <h2 className="next-steps-panel__title">{rootTitle}</h2>
          {resolvedNode && (
            <div className="next-steps-panel__node-meta">
              <span className="next-steps-panel__node-domain">
                {prettyDomain(resolvedNode.domain)}
              </span>
              {resolvedNode.kind && (
                <span className="next-steps-panel__node-kind">
                  {prettyKind(resolvedNode.kind)}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="next-steps-panel__header-side">
          <span className="next-steps-panel__badge">
            {hasRecs ? `${recommendations.length} suggestions` : "No suggestions yet"}
          </span>
        </div>
      </div>

      <div className="next-steps-panel__body">
        {!hasGraph && (
          <div className="next-steps-panel__empty next-steps-panel__empty--warning">
            <p>
              Planning Graph is not loaded yet. Once your calculators and planners
              are wired into the graph, you&apos;ll see recommended next steps here.
            </p>
          </div>
        )}

        {hasGraph && !resolvedNode && (
          <div className="next-steps-panel__empty">
            <p>
              No current context node. Pass <code>nodeId</code> or <code>node</code>{" "}
              into <code>&lt;NextStepsPanel /&gt;</code> to see recommendations.
            </p>
          </div>
        )}

        {hasGraph && resolvedNode && !hasRecs && (
          <div className="next-steps-panel__empty">
            <p>
              There are no specific recommended next actions based on this result.
            </p>
            <p className="next-steps-panel__hint">
              You can still explore your household tools or start a new session from
              your domain dashboards.
            </p>
          </div>
        )}

        {hasGraph && resolvedNode && hasRecs && (
          <ul className="next-steps-panel__list">
            {recommendations.map((rec) => {
              const nodeLabel = rec.node?.title || rec.node?.id || "Unnamed node";
              const domainLabel = prettyDomain(rec.node?.domain || resolvedNode.domain);
              const typeLabel = prettyRecType(rec.type);
              const kindLabel = prettyKind(rec.node?.kind);
              const createdShort = formatDateShort(rec.primarySession?.createdAt);

              return (
                <li key={rec.id} className="next-steps-panel__item">
                  <article className="next-steps-card">
                    <header className="next-steps-card__header">
                      <div className="next-steps-card__title-row">
                        <span className="next-steps-card__type-pill">
                          {typeLabel}
                        </span>
                        {kindLabel && (
                          <span className="next-steps-card__kind-pill">
                            {kindLabel}
                          </span>
                        )}
                        <span className="next-steps-card__domain-pill">
                          {domainLabel}
                        </span>
                      </div>
                      <h3 className="next-steps-card__title">{nodeLabel}</h3>
                    </header>

                    <div className="next-steps-card__content">
                      {rec.reasons && rec.reasons.length > 0 && (
                        <ul className="next-steps-card__reasons">
                          {rec.reasons.map((reason, idx) => (
                            <li
                              key={`${rec.id}-reason-${idx}`}
                              className="next-steps-card__reason"
                            >
                              {reason}
                            </li>
                          ))}
                        </ul>
                      )}

                      {rec.primarySession && (
                        <div className="next-steps-card__session-snippet">
                          <div className="next-steps-card__session-label">
                            Runnable session:
                          </div>
                          <div className="next-steps-card__session-main">
                            <span className="next-steps-card__session-title">
                              {rec.primarySession.title}
                            </span>
                            <span className="next-steps-card__session-meta">
                              {rec.primarySession.status === "paused"
                                ? "Paused"
                                : "Ready"}
                              {createdShort && ` · ${createdShort}`}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>

                    <footer className="next-steps-card__footer">
                      <div className="next-steps-card__actions">
                        {rec.primarySession && (
                          <button
                            type="button"
                            className="next-steps-card__btn next-steps-card__btn--primary"
                            onClick={() => handleLaunchSession(rec.primarySession)}
                          >
                            Play Session Now
                          </button>
                        )}

                        <button
                          type="button"
                          className="next-steps-card__btn next-steps-card__btn--ghost"
                          onClick={() => handleOpenNode(rec.node)}
                        >
                          Open Planner
                        </button>

                        <button
                          type="button"
                          className="next-steps-card__btn next-steps-card__btn--link"
                          onClick={() => setDetailRecId(rec.id)}
                        >
                          Details
                        </button>
                      </div>

                      <div className="next-steps-card__score">
                        Score: {Math.round(rec.score)}
                      </div>
                    </footer>
                  </article>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Optional debug block, can be styled/hidden via CSS if desired */}
      {process.env.NODE_ENV !== "production" && (
        <details className="next-steps-panel__debug">
          <summary>Debug (Planning Graph)</summary>
          <pre className="next-steps-panel__debug-pre">
            {JSON.stringify(debug, null, 2)}
          </pre>
        </details>
      )}

      {/* Detail Modal (local to this panel, NOT the SessionRunner modal) */}
      {detailRec && (
        <NextStepsDetailModal
          recommendation={detailRec}
          onLaunchSession={handleLaunchSession}
          onOpenNode={handleOpenNode}
          onClose={handleCloseDetail}
        />
      )}
    </section>
  );
}

/**
 * Lightweight detail modal for a single recommendation.
 * This is a local UI overlay (not the global SessionRunner modal).
 *
 * @param {{
 *   recommendation: NextStepRecommendation,
 *   onLaunchSession: (session: import("./useNextSteps").SessionLike) => void,
 *   onOpenNode: (node: import("./usePlanningGraph").PlanningNode) => void,
 *   onClose: () => void
 * }} props
 */
function NextStepsDetailModal(props) {
  const { recommendation, onLaunchSession, onOpenNode, onClose } = props || {};

  const node = recommendation?.node || null;
  const nodeLabel = node?.title || node?.id || "Unnamed node";
  const domainLabel = prettyDomain(node?.domain);
  const kindLabel = prettyKind(node?.kind);
  const typeLabel = prettyRecType(recommendation?.type);
  const createdShort = formatDateShort(recommendation?.primarySession?.createdAt);

  const handleOverlayClick = useCallback(
    (evt) => {
      if (evt.target === evt.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  const handleKeyDown = useCallback(
    (evt) => {
      if (evt.key === "Escape") {
        evt.stopPropagation();
        onClose();
      }
    },
    [onClose]
  );

  return (
    <div
      className="next-steps-modal__backdrop"
      role="presentation"
      onClick={handleOverlayClick}
      onKeyDown={handleKeyDown}
    >
      <div
        className="next-steps-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="next-steps-modal-title"
      >
        <header className="next-steps-modal__header">
          <div className="next-steps-modal__pills">
            <span className="next-steps-modal__pill">{typeLabel}</span>
            {kindLabel && (
              <span className="next-steps-modal__pill next-steps-modal__pill--muted">
                {kindLabel}
              </span>
            )}
            <span className="next-steps-modal__pill next-steps-modal__pill--domain">
              {domainLabel}
            </span>
          </div>
          <h2 id="next-steps-modal-title" className="next-steps-modal__title">
            {nodeLabel}
          </h2>
          <button
            type="button"
            className="next-steps-modal__close"
            onClick={onClose}
            aria-label="Close details"
          >
            ×
          </button>
        </header>

        <div className="next-steps-modal__body">
          {recommendation.reasons && recommendation.reasons.length > 0 && (
            <section className="next-steps-modal__section">
              <h3 className="next-steps-modal__section-title">Why this is suggested</h3>
              <ul className="next-steps-modal__reasons">
                {recommendation.reasons.map((reason, idx) => (
                  <li key={`${recommendation.id}-detail-reason-${idx}`}>
                    {reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {recommendation.viaEdge && (
            <section className="next-steps-modal__section">
              <h3 className="next-steps-modal__section-title">
                Graph relation
              </h3>
              <p className="next-steps-modal__text">
                Relation: <code>{recommendation.viaEdge.relation || "unknown"}</code>
                {recommendation.viaEdge.meta?.phase && (
                  <>
                    {" "}
                    · Phase: <code>{recommendation.viaEdge.meta.phase}</code>
                  </>
                )}
              </p>
            </section>
          )}

          {recommendation.primarySession && (
            <section className="next-steps-modal__section">
              <h3 className="next-steps-modal__section-title">
                Runnable session
              </h3>
              <div className="next-steps-modal__session">
                <div className="next-steps-modal__session-main">
                  <div className="next-steps-modal__session-title">
                    {recommendation.primarySession.title}
                  </div>
                  <div className="next-steps-modal__session-meta">
                    Status: {recommendation.primarySession.status}
                    {createdShort && ` · Created ${createdShort}`}
                  </div>
                </div>
                {recommendation.sessions.length > 1 && (
                  <div className="next-steps-modal__session-note">
                    + {recommendation.sessions.length - 1} other related session
                    {recommendation.sessions.length > 2 ? "s" : ""}
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        <footer className="next-steps-modal__footer">
          <div className="next-steps-modal__footer-actions">
            {recommendation.primarySession && (
              <button
                type="button"
                className="next-steps-modal__btn next-steps-modal__btn--primary"
                onClick={() => onLaunchSession(recommendation.primarySession)}
              >
                Play Session Now
              </button>
            )}
            <button
              type="button"
              className="next-steps-modal__btn next-steps-modal__btn--ghost"
              onClick={() => node && onOpenNode(node)}
            >
              Open Planner
            </button>
          </div>
          <button
            type="button"
            className="next-steps-modal__btn next-steps-modal__btn--link"
            onClick={onClose}
          >
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

export default NextStepsPanel;

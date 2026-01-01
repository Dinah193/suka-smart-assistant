// C:\Users\larho\suka-smart-assistant\src\features\stability\StabilityHistoryTimeline.jsx

/**
 * StabilityHistoryTimeline
 *
 * Component: visualizes stability over time as a vertical timeline.
 *
 * How this fits:
 * - Lives in the Stability feature area (e.g., under the Stability Dashboard).
 * - Shows historical “stability snapshots” derived from session analytics,
 *   guard events, and device capability checks.
 * - Listens to session events (completed/aborted) so you always see fresh data
 *   while the SessionRunner continues running in the background.
 *
 * Data contract (flexible, future-proof):
 * - Props:
 *   • entries?: StabilityHistoryEntry[]
 *   • maxItems?: number (default 20)
 *   • fetchHistory?: () => Promise<StabilityHistoryEntry[]>  // optional Dexie integration
 *   • onSelectEntry?: (entry: StabilityHistoryEntry) => void // optional parent hook
 *
 * - StabilityHistoryEntry:
 *   {
 *     id: string;
 *     ts: string; // ISO timestamp
 *     label: string; // human summary (e.g. "Cooking sessions")
 *     domain?: "cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"|string;
 *     score: number; // 0–1 (0=poor, 1=excellent), used for health classification
 *     healthStatus?: "stable"|"limited"|"at-risk"|"checking";
 *     meta?: {
 *       sessionsStarted?: number;
 *       sessionsCompleted?: number;
 *       guardFailures?: number;
 *       battery?: number; // 0–1
 *       notes?: string;
 *     };
 *   }
 *
 * Integration points:
 * - Dexie:
 *   • Pass a `fetchHistory` prop that reads from your sessions / analytics stores
 *     and resolves to an array of StabilityHistoryEntry.
 * - Session events:
 *   • This component subscribes to `session.completed` and `session.aborted`
 *     via the eventBus and appends a lightweight “event-derived” entry so you
 *     can see stability trend changes in real time.
 * - SessionRunner:
 *   • This is a read-only visualization. It does not change SessionRunner behavior
 *     and will not interfere with background timers, wake-lock, or PiP.
 */

import React, { useEffect, useMemo, useState } from "react";
import eventBus from "@/services/eventBus";

/**
 * @typedef {Object} StabilityHistoryMeta
 * @property {number} [sessionsStarted]
 * @property {number} [sessionsCompleted]
 * @property {number} [guardFailures]
 * @property {number} [battery] // 0–1
 * @property {string} [notes]
 */

/**
 * @typedef {Object} StabilityHistoryEntry
 * @property {string} id
 * @property {string} ts
 * @property {string} label
 * @property {string} [domain]
 * @property {number} score
 * @property {"stable"|"limited"|"at-risk"|"checking"} [healthStatus]
 * @property {StabilityHistoryMeta} [meta]
 */

/**
 * @param {{
 *  entries?: StabilityHistoryEntry[],
 *  maxItems?: number,
 *  fetchHistory?: () => Promise<StabilityHistoryEntry[]>,
 *  onSelectEntry?: (entry: StabilityHistoryEntry) => void,
 *  className?: string,
 * }} props
 */
function StabilityHistoryTimeline({
  entries,
  maxItems = 20,
  fetchHistory,
  onSelectEntry,
  className = "",
}) {
  const [history, setHistory] = useState(/** @type {StabilityHistoryEntry[]} */ ([]));
  const [loading, setLoading] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState(
    /** @type {StabilityHistoryEntry|null} */ (null)
  );
  const [errorMsg, setErrorMsg] = useState("");

  /** -----------------------------------------------------------------------
   *  Initial load (Dexie-backed or default sample)
   * --------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;

    const applyEntries = (incoming) => {
      if (cancelled) return;
      const normalized = normalizeEntries(incoming);
      setHistory((prev) => {
        if (!prev || prev.length === 0) return normalized;
        // If caller provides entries, they are assumed canonical and replace.
        return normalized;
      });
    };

    if (Array.isArray(entries) && entries.length > 0) {
      applyEntries(entries);
      return () => {
        cancelled = true;
      };
    }

    if (typeof fetchHistory === "function") {
      setLoading(true);
      fetchHistory()
        .then((list) => {
          applyEntries(list || []);
          setErrorMsg("");
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[StabilityHistoryTimeline] fetchHistory failed", err);
          setErrorMsg("Unable to load full history. Showing recent local events only.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    } else {
      // Soft fallback with local sample data so the component is safe even
      // when you haven’t wired Dexie yet.
      const demo = buildDemoHistory();
      applyEntries(demo);
    }

    return () => {
      cancelled = true;
    };
  }, [entries, fetchHistory]);

  /** -----------------------------------------------------------------------
   *  Live updates from session events
   * --------------------------------------------------------------------- */

  useEffect(() => {
    const addEventEntry = (payload, type) => {
      const ts = payload?.ts || new Date().toISOString();
      const session =
        payload?.data?.session || payload?.session || payload?.data || {};
      const domain = session.domain || "unknown";
      const status = session.status || (type === "session.aborted" ? "aborted" : "completed");

      const scoreGuess = estimateScoreFromSession(session, type);
      const healthStatus = classifyHealth(scoreGuess);

      /** @type {StabilityHistoryEntry} */
      const entry = {
        id: `${type}-${ts}`,
        ts,
        label:
          type === "session.completed"
            ? `Session completed (${domain})`
            : `Session aborted (${domain})`,
        domain,
        score: scoreGuess,
        healthStatus,
        meta: {
          sessionsStarted: 1,
          sessionsCompleted: status === "completed" ? 1 : 0,
          guardFailures: Array.isArray(session?.analytics?.adjustments)
            ? session.analytics.adjustments.filter((a) => a?.type === "guard").length
            : 0,
          notes:
            type === "session.completed"
              ? "Session finished; analytics recorded."
              : "Session aborted; review guard and device conditions.",
        },
      };

      setHistory((prev) => {
        const next = [entry, ...(prev || [])];
        return next.slice(0, maxItems * 2); // keep a reasonable cap
      });
    };

    const offCompleted = subscribeEvent("session.completed", (payload) =>
      addEventEntry(payload, "session.completed")
    );
    const offAborted = subscribeEvent("session.aborted", (payload) =>
      addEventEntry(payload, "session.aborted")
    );

    return () => {
      offCompleted();
      offAborted();
    };
  }, [maxItems]);

  /** -----------------------------------------------------------------------
   *  Sorting & trimming
   * --------------------------------------------------------------------- */

  const orderedHistory = useMemo(() => {
    const list = Array.isArray(history) ? [...history] : [];
    list.sort((a, b) => {
      const tA = Date.parse(a.ts || "") || 0;
      const tB = Date.parse(b.ts || "") || 0;
      return tB - tA; // newest first
    });
    return list.slice(0, maxItems);
  }, [history, maxItems]);

  /** -----------------------------------------------------------------------
   *  Rendering helpers
   * --------------------------------------------------------------------- */

  const handleRowClick = (entry) => {
    setSelectedEntry(entry);
    if (typeof onSelectEntry === "function") {
      try {
        onSelectEntry(entry);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[StabilityHistoryTimeline] onSelectEntry failed", err);
      }
    }
  };

  const healthBadge = (entry) => {
    const health = entry.healthStatus || classifyHealth(entry.score);
    let label = "Unknown";
    let classes =
      "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium";

    if (health === "stable") {
      label = "Stable";
      classes += " bg-emerald-50 text-emerald-700 border-emerald-200";
    } else if (health === "limited") {
      label = "Limited";
      classes += " bg-amber-50 text-amber-700 border-amber-200";
    } else if (health === "at-risk") {
      label = "At risk";
      classes += " bg-red-50 text-red-700 border-red-200";
    } else if (health === "checking") {
      label = "Checking";
      classes += " bg-slate-50 text-slate-600 border-slate-200";
    }

    return (
      <span className={classes}>
        <span
          className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${
            health === "stable"
              ? "bg-emerald-500"
              : health === "limited"
              ? "bg-amber-500"
              : health === "at-risk"
              ? "bg-red-500"
              : "bg-slate-400"
          }`}
        />
        {label}
      </span>
    );
  };

  const domainPill = (entry) => {
    if (!entry.domain) return null;
    const title = entry.domain.charAt(0).toUpperCase() + entry.domain.slice(1);
    return (
      <span className="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 border border-slate-100">
        {title}
      </span>
    );
  };

  return (
    <div
      className={`bg-white rounded-xl shadow-sm border border-slate-100 p-4 sm:p-5 ${className}`}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-900">
          Stability history
        </h2>
        {loading && (
          <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
            Loading…
          </span>
        )}
      </div>

      {errorMsg && (
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <p className="text-xs text-amber-800">{errorMsg}</p>
        </div>
      )}

      {orderedHistory.length === 0 ? (
        <p className="text-sm text-slate-500">
          No stability history recorded yet. Once sessions complete or are
          aborted, their stability impact will appear here.
        </p>
      ) : (
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-3 sm:left-4 top-0 bottom-0 w-px bg-slate-200" />

          <ol className="space-y-3 max-h-80 overflow-y-auto pr-1">
            {orderedHistory.map((entry, idx) => {
              const tsLabel = formatTimestamp(entry.ts);
              const scorePct = `${Math.round(clampScore(entry.score) * 100)}%`;

              return (
                <li
                  key={entry.id || `${entry.ts}-${idx}`}
                  className="relative pl-8 sm:pl-10"
                >
                  {/* Node dot */}
                  <span
                    className="absolute left-1.5 sm:left-2.5 top-3 inline-flex h-3.5 w-3.5 items-center justify-center"
                    aria-hidden="true"
                  >
                    <span className="h-3 w-3 rounded-full bg-white border border-slate-300" />
                    <span className="absolute h-1.5 w-1.5 rounded-full bg-indigo-500" />
                  </span>

                  <button
                    type="button"
                    onClick={() => handleRowClick(entry)}
                    className="w-full text-left rounded-lg border border-transparent hover:border-slate-200 hover:bg-slate-50/80 px-2.5 py-2 transition-colors"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs text-slate-500">{tsLabel}</p>
                        <p className="text-sm font-medium text-slate-900 truncate">
                          {entry.label || "Session activity"}
                        </p>
                        <div className="mt-1 flex flex-wrap items-center gap-2">
                          {domainPill(entry)}
                          {healthBadge(entry)}
                          <span className="inline-flex items-center rounded-full bg-slate-900 text-white px-2 py-0.5 text-[11px] font-medium">
                            {scorePct}
                          </span>
                        </div>
                      </div>
                    </div>
                    {entry.meta?.notes && (
                      <p className="mt-1 text-xs text-slate-500 line-clamp-2">
                        {entry.meta.notes}
                      </p>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <p className="mt-3 text-[11px] text-slate-500">
        This timeline reflects historical stability snapshots for your
        household sessions. It does not interrupt the SessionRunner; it simply
        listens to session events and analytics records.
      </p>

      {selectedEntry && (
        <StabilityHistoryDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
        />
      )}
    </div>
  );
}

/**
 * Modal for inspecting a single stability history entry in detail.
 * Follows the same visual language as other SSA modals.
 *
 * @param {{ entry: StabilityHistoryEntry, onClose: () => void }} props
 */
function StabilityHistoryDetailModal({ entry, onClose }) {
  useEffect(() => {
    const onKeyDown = (evt) => {
      if (evt.key === "Escape") {
        evt.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const tsLabel = formatTimestamp(entry.ts);
  const scorePct = `${Math.round(clampScore(entry.score) * 100)}%`;
  const health = entry.healthStatus || classifyHealth(entry.score);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/60"
      role="dialog"
      aria-modal="true"
      aria-label="Stability entry details"
    >
      <div className="relative w-full max-w-md mx-4 my-6 bg-white rounded-2xl shadow-xl border border-slate-200">
        <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-slate-100">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              Stability snapshot
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">{tsLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-slate-200 text-slate-500 hover:bg-slate-50 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            aria-label="Close"
          >
            <span aria-hidden="true">&times;</span>
          </button>
        </div>

        <div className="px-4 py-4 space-y-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">
              Label
            </p>
            <p className="text-sm font-medium text-slate-900">
              {entry.label || "Session activity"}
            </p>
          </div>

          {entry.domain && (
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">
                  Domain
                </p>
                <p className="text-sm text-slate-800">
                  {entry.domain.charAt(0).toUpperCase() + entry.domain.slice(1)}
                </p>
              </div>
              <span className="inline-flex items-center rounded-full bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600 border border-slate-100">
                {entry.domain}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">
                Stability score
              </p>
              <p className="text-sm font-semibold text-slate-900">
                {scorePct}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-slate-500 mb-0.5">
                Health
              </p>
              <p className="text-sm font-semibold text-slate-900">
                {health === "stable"
                  ? "Stable"
                  : health === "limited"
                  ? "Limited"
                  : health === "at-risk"
                  ? "At risk"
                  : "Checking"}
              </p>
            </div>
          </div>

          {entry.meta && (
            <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50/70 p-3">
              <p className="text-xs font-semibold text-slate-700 mb-2">
                Event metrics
              </p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
                {typeof entry.meta.sessionsStarted === "number" && (
                  <>
                    <dt>Sessions started</dt>
                    <dd className="text-right">
                      {entry.meta.sessionsStarted}
                    </dd>
                  </>
                )}
                {typeof entry.meta.sessionsCompleted === "number" && (
                  <>
                    <dt>Sessions completed</dt>
                    <dd className="text-right">
                      {entry.meta.sessionsCompleted}
                    </dd>
                  </>
                )}
                {typeof entry.meta.guardFailures === "number" && (
                  <>
                    <dt>Guard failures</dt>
                    <dd className="text-right">
                      {entry.meta.guardFailures}
                    </dd>
                  </>
                )}
                {typeof entry.meta.battery === "number" && (
                  <>
                    <dt>Battery at event</dt>
                    <dd className="text-right">
                      {Math.round(clampScore(entry.meta.battery) * 100)}%
                    </dd>
                  </>
                )}
              </dl>
              {entry.meta.notes && (
                <p className="mt-2 text-[11px] text-slate-500">
                  {entry.meta.notes}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-slate-100 bg-slate-50/60 rounded-b-2xl">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** -------------------------------------------------------------------------
 *  Utility helpers
 * ---------------------------------------------------------------------- */

/**
 * Normalize incoming entries to the StabilityHistoryEntry contract.
 * @param {StabilityHistoryEntry[] | any} list
 * @returns {StabilityHistoryEntry[]}
 */
function normalizeEntries(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((raw, idx) => {
      const ts =
        typeof raw.ts === "string" && raw.ts.trim()
          ? raw.ts
          : new Date().toISOString();
      const score = clampScore(raw.score);
      /** @type {StabilityHistoryEntry} */
      const entry = {
        id:
          typeof raw.id === "string" && raw.id.trim()
            ? raw.id
            : `hist-${ts}-${idx}`,
        ts,
        label: raw.label || "Session activity",
        domain: raw.domain,
        score,
        healthStatus: raw.healthStatus || classifyHealth(score),
        meta: raw.meta || {},
      };
      return entry;
    })
    .filter((e) => !!e.id);
}

/**
 * Build a small demo history set so the component renders nicely
 * even before you wire Dexie analytics.
 * @returns {StabilityHistoryEntry[]}
 */
function buildDemoHistory() {
  const now = Date.now();
  const daysAgo = (d) => new Date(now - d * 24 * 60 * 60 * 1000).toISOString();

  return [
    {
      id: "demo-1",
      ts: daysAgo(0),
      label: "Cooking / Cleaning sessions",
      domain: "cooking",
      score: 0.86,
      healthStatus: "stable",
      meta: {
        sessionsStarted: 5,
        sessionsCompleted: 5,
        guardFailures: 0,
        notes: "Smooth cooking + light evening cleaning; no guard conflicts.",
      },
    },
    {
      id: "demo-2",
      ts: daysAgo(1),
      label: "Garden & animals",
      domain: "garden",
      score: 0.72,
      healthStatus: "stable",
      meta: {
        sessionsStarted: 3,
        sessionsCompleted: 2,
        guardFailures: 1,
        notes: "One early-morning gardening session was deferred due to quiet hours.",
      },
    },
    {
      id: "demo-3",
      ts: daysAgo(3),
      label: "Storehouse & preservation",
      domain: "preservation",
      score: 0.55,
      healthStatus: "limited",
      meta: {
        sessionsStarted: 4,
        sessionsCompleted: 3,
        guardFailures: 1,
        notes: "Low device battery interrupted a long canning session.",
      },
    },
    {
      id: "demo-4",
      ts: daysAgo(5),
      label: "High activity day",
      domain: "cleaning",
      score: 0.38,
      healthStatus: "at-risk",
      meta: {
        sessionsStarted: 7,
        sessionsCompleted: 4,
        guardFailures: 3,
        notes:
          "Multiple tasks tried to start during Sabbath/quiet hours; consider adjusting automation rules.",
      },
    },
  ];
}

/**
 * Subscribe to an eventBus event in a defensive way.
 * @param {string} type
 * @param {(payload: any) => void} handler
 * @returns {() => void} unsubscribe
 */
function subscribeEvent(type, handler) {
  try {
    if (eventBus && typeof eventBus.on === "function") {
      eventBus.on(type, handler);
      return () => {
        if (eventBus && typeof eventBus.off === "function") {
          eventBus.off(type, handler);
        }
      };
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[StabilityHistoryTimeline] subscribeEvent failed", type, err);
  }
  return () => {};
}

/**
 * Clamp a numeric score to [0, 1].
 * @param {number} value
 * @returns {number}
 */
function clampScore(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Classify stability health from score.
 * @param {number} score
 * @returns {"stable"|"limited"|"at-risk"|"checking"}
 */
function classifyHealth(score) {
  const s = clampScore(score);
  if (s === 0) return "checking";
  if (s >= 0.8) return "stable";
  if (s >= 0.5) return "limited";
  return "at-risk";
}

/**
 * Rough heuristic: estimate a stability score from a session event.
 * You can later wire this directly to your real analytics scoring logic.
 *
 * @param {any} session
 * @param {"session.completed"|"session.aborted"} type
 * @returns {number}
 */
function estimateScoreFromSession(session, type) {
  if (!session || typeof session !== "object") {
    return type === "session.completed" ? 0.6 : 0.3;
  }

  const skippedCount = Array.isArray(session.analytics?.skippedSteps)
    ? session.analytics.skippedSteps.length
    : 0;
  const guardAdjustCount = Array.isArray(session.analytics?.adjustments)
    ? session.analytics.adjustments.filter((a) => a?.type === "guard").length
    : 0;

  // Simple scoring heuristic:
  let base = type === "session.completed" ? 0.7 : 0.4;
  base -= skippedCount * 0.05;
  base -= guardAdjustCount * 0.07;

  return clampScore(base);
}

/**
 * Format timestamp into a user-friendly string.
 * @param {string} ts
 * @returns {string}
 */
function formatTimestamp(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default StabilityHistoryTimeline;

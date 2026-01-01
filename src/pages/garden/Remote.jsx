// C:\Users\larho\suka-smart-assistant\src\pages\garden\Remote.jsx
//
// GardenRemotePage
// -----------------
// This page is a "remote control" surface for garden sessions.
// It does NOT create sessions itself (that happens in Garden/Play.jsx, planners,
// or automation). Instead, it:
//
//  • Listens to the shared eventBus for session.* events.
//  • Shows active / recently active GARDEN sessions.
//  • Lets the user send remote commands (pause, resume, next, previous,
//    complete) to the SessionRunner.
//
// How this fits into the SSA pipeline
// -----------------------------------
// imports → intelligence → automation → (optional) Hub export
//
// • imports:
//   Garden imports (seed packets, planting guides, bed layouts, harvest logs)
//   are handled elsewhere by ImportRouter and garden domain engines.
//   This page is on the *execution* side.
//
// • intelligence:
//   The garden intelligence layer has already turned imports + weather +
//   calendar into structured sessions (watering, harvest, weeding, inspection).
//   This page reflects those sessions as remote-controllable items.
//
// • automation:
//   When you tap remote controls, this page emits commands like:
//     - session.remote.command
//   with data { sessionId, command, domain: "garden", reason }.
//   The automation runtime / SessionRunner should listen for these commands
//   and perform the actual pause/resume/next/previous/complete actions,
//   then emit session.paused, session.resumed, session.step.changed,
//   session.completed, etc.
//
// • optional Hub export:
//   This page itself does not mutate inventory/storehouse or directly persist
//   session data. Hub exports for completed sessions should be handled by the
//   SessionRunner or garden domain engines so all domains behave consistently.
//
// Forward-thinking notes
// ----------------------
// • This pattern mirrors CleaningRemote and can be generalized later into a
//   multi-domain Remote cockpit.
// • The subscription helper defensively supports multiple eventBus signatures,
//   so eventBus can evolve without breaking this page.

import React, { useEffect, useMemo, useState } from "react";
import eventBus from "../../services/events/eventBus";

/**
 * @typedef {Object} RemoteSessionSummary
 * @property {string} id
 * @property {string} title
 * @property {"cooking"|"cleaning"|"garden"|"animals"|"preservation"|"storehouse"} domain
 * @property {"pending"|"running"|"paused"|"completed"|"aborted"} status
 * @property {string|null} currentStepTitle
 * @property {number|null} currentStepIndex
 * @property {string|null} startedAt
 * @property {string|null} lastEventTs
 * @property {string|null} sourceLabel
 */

const nowISO = () => new Date().toISOString();

/**
 * Emit a structured event onto the shared eventBus.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emitEvent(type, source, data) {
  if (!eventBus || typeof eventBus.emit !== "function") {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[GardenRemotePage] eventBus.emit not available");
    }
    return;
  }

  eventBus.emit({
    type,
    ts: nowISO(),
    source,
    data,
  });
}

/**
 * Subscribe to all events on the eventBus, if supported.
 * Returns an unsubscribe function.
 *
 * We defensively support a few likely signatures:
 *   - eventBus.subscribe(handler)
 *   - eventBus.on(handler)
 *   - eventBus.on("*", handler)
 *
 * @param {(evt: { type: string; ts: string; source: string; data: any }) => void} handler
 * @returns {() => void}
 */
function subscribeToEventBus(handler) {
  if (!eventBus) {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.warn("[GardenRemotePage] eventBus not available");
    }
    return () => {};
  }

  // eventBus.subscribe(handler)
  if (typeof eventBus.subscribe === "function") {
    eventBus.subscribe(handler);
    return () => {
      if (typeof eventBus.unsubscribe === "function") {
        eventBus.unsubscribe(handler);
      }
    };
  }

  // eventBus.on(handler)
  if (typeof eventBus.on === "function" && eventBus.on.length === 1) {
    eventBus.on(handler);
    return () => {
      if (typeof eventBus.off === "function") {
        eventBus.off(handler);
      }
    };
  }

  // eventBus.on("*", handler)
  if (typeof eventBus.on === "function" && eventBus.on.length >= 2) {
    try {
      eventBus.on("*", handler);
      return () => {
        if (typeof eventBus.off === "function") {
          eventBus.off("*", handler);
        }
      };
    } catch (err) {
      if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console
        console.warn(
          "[GardenRemotePage] Failed to subscribe with eventBus.on('*', handler):",
          err
        );
      }
    }
  }

  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn("[GardenRemotePage] No compatible subscription API found");
  }
  return () => {};
}

/**
 * Update or insert a RemoteSessionSummary based on an incoming event.
 *
 * @param {RemoteSessionSummary[]} sessions
 * @param {{ type: string; ts: string; source: string; data: any }} evt
 * @returns {RemoteSessionSummary[]}
 */
function reduceSessionsFromEvent(sessions, evt) {
  const { type, ts, data } = evt;
  if (!data || !data.domain || data.domain !== "garden") return sessions;

  const id = data.id || (data.session && data.session.id);
  if (!id) return sessions;

  const existing = sessions.find((s) => s.id === id);

  /** @type {Partial<RemoteSessionSummary>} */
  const patch = { lastEventTs: ts };

  if (type === "session.started") {
    patch.status = "running";
    patch.title = data.title || existing?.title || "Garden session";
    patch.domain = "garden";
    patch.startedAt = data.startedAt || data.requestedAt || nowISO();
    patch.currentStepTitle =
      data.currentStepTitle || existing?.currentStepTitle || null;
    patch.currentStepIndex =
      typeof data.currentStepIndex === "number"
        ? data.currentStepIndex
        : existing?.currentStepIndex ?? null;
    if (!existing?.sourceLabel && data.source) {
      if (data.source.type === "gardenPlan") {
        patch.sourceLabel = "Garden plan";
      } else if (data.source.type === "import") {
        patch.sourceLabel = "Imported";
      } else {
        patch.sourceLabel = data.source.type;
      }
    }
  } else if (type === "session.step.changed") {
    patch.currentStepTitle =
      data.currentStepTitle ?? existing?.currentStepTitle ?? null;
    patch.currentStepIndex =
      typeof data.currentStepIndex === "number"
        ? data.currentStepIndex
        : existing?.currentStepIndex ?? null;
    patch.status = existing?.status ?? "running";
  } else if (type === "session.paused") {
    patch.status = "paused";
  } else if (type === "session.resumed") {
    patch.status = "running";
  } else if (type === "session.completed") {
    patch.status = "completed";
  } else if (type === "session.aborted") {
    patch.status = "aborted";
  } else {
    // Not a session lifecycle event we care about.
    return sessions;
  }

  const nextSessions = [...sessions];
  const idx = nextSessions.findIndex((s) => s.id === id);

  if (idx === -1) {
    /** @type {RemoteSessionSummary} */
    const base = {
      id,
      title: patch.title || "Garden session",
      domain: "garden",
      status: patch.status || "pending",
      currentStepTitle: patch.currentStepTitle ?? null,
      currentStepIndex:
        typeof patch.currentStepIndex === "number"
          ? patch.currentStepIndex
          : null,
      startedAt: patch.startedAt || null,
      lastEventTs: patch.lastEventTs || ts,
      sourceLabel: patch.sourceLabel || null,
    };
    nextSessions.push(base);
  } else {
    nextSessions[idx] = {
      ...nextSessions[idx],
      ...patch,
    };
  }

  // Keep recent sessions visible for now; pruning can be added later.
  return nextSessions;
}

/**
 * Human-friendly label for session status.
 * @param {RemoteSessionSummary["status"]} status
 */
function statusLabel(status) {
  switch (status) {
    case "running":
      return "In progress";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "aborted":
      return "Stopped";
    case "pending":
    default:
      return "Pending";
  }
}

/**
 * GardenRemotePage component
 */
export default function GardenRemotePage() {
  const [sessions, setSessions] = useState(
    /** @type {RemoteSessionSummary[]} */ ([])
  );
  const [lastCommandMsg, setLastCommandMsg] = useState("");

  // Subscribe to session events from the eventBus.
  useEffect(() => {
    const handler = (evt) => {
      if (!evt || !evt.type) return;
      const relevantTypes = new Set([
        "session.started",
        "session.step.changed",
        "session.paused",
        "session.resumed",
        "session.completed",
        "session.aborted",
      ]);
      if (!relevantTypes.has(evt.type)) return;
      setSessions((prev) => reduceSessionsFromEvent(prev, evt));
    };

    const unsubscribe = subscribeToEventBus(handler);
    return () => {
      unsubscribe();
    };
  }, []);

  const gardenSessions = useMemo(
    () => sessions.filter((s) => s.domain === "garden"),
    [sessions]
  );

  /**
   * Issue a remote command to the SessionRunner for a particular session.
   *
   * Commands:
   *   - "pause"
   *   - "resume"
   *   - "next"
   *   - "previous"
   *   - "complete"
   *
   * @param {string} sessionId
   * @param {"pause"|"resume"|"next"|"previous"|"complete"} command
   */
  const sendRemoteCommand = (sessionId, command) => {
    if (!sessionId || !command) return;

    emitEvent("session.remote.command", "garden.remote", {
      sessionId,
      command,
      domain: "garden",
      reason: "userRemoteControl",
    });

    const labelMap = {
      pause: "Paused",
      resume: "Resumed",
      next: "Advanced to next step",
      previous: "Moved to previous step",
      complete: "Marked as completed",
    };

    setLastCommandMsg(`${labelMap[command]} garden session ${sessionId}.`);
  };

  return (
    <div className="garden-remote-page">
      {/* Header */}
      <section className="garden-remote-header">
        <div>
          <h1 className="page-title">Garden Remote</h1>
          <p className="page-subtitle">
            Live control panel for garden sessions. Perfect on a phone or spare
            screen while SSA guides watering, harvest, weeding, and inspection
            sessions in real time.
          </p>
        </div>
        {lastCommandMsg && (
          <div className="status-banner" aria-live="polite">
            {lastCommandMsg}
          </div>
        )}
      </section>

      {/* Sessions list */}
      <section className="garden-remote-list">
        {gardenSessions.length === 0 ? (
          <div className="empty-state">
            <p>No active or recent garden sessions detected.</p>
            <p className="empty-hint">
              Start a session from <strong>Garden &gt; Play</strong> or from a
              garden planner. Once it emits <code>session.started</code>, it
              will appear here.
            </p>
          </div>
        ) : (
          gardenSessions.map((session) => (
            <article key={session.id} className="garden-remote-card">
              <header className="garden-remote-card-header">
                <div>
                  <h2>{session.title}</h2>
                  <p className="source-label">
                    {session.sourceLabel || "Garden session"}
                  </p>
                </div>
                <span
                  className={
                    "status-pill status-pill--" + (session.status || "pending")
                  }
                >
                  {statusLabel(session.status)}
                </span>
              </header>

              <div className="garden-remote-body">
                <p className="current-step">
                  <strong>Current step: </strong>
                  {session.currentStepTitle
                    ? session.currentStepTitle
                    : "N/A (waiting to start or already finished)"}
                </p>
                {typeof session.currentStepIndex === "number" && (
                  <p className="current-step-index">
                    Step #{session.currentStepIndex + 1}
                  </p>
                )}
                <p className="timestamps">
                  {session.startedAt && (
                    <>
                      <span>
                        Started:{" "}
                        {new Date(session.startedAt).toLocaleTimeString()}
                      </span>
                      {" · "}
                    </>
                  )}
                  {session.lastEventTs && (
                    <span>
                      Last update:{" "}
                      {new Date(session.lastEventTs).toLocaleTimeString()}
                    </span>
                  )}
                </p>
              </div>

              <footer className="garden-remote-controls">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => sendRemoteCommand(session.id, "previous")}
                  disabled={
                    session.status === "completed" ||
                    session.status === "aborted"
                  }
                >
                  ◀ Previous
                </button>
                {session.status === "paused" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => sendRemoteCommand(session.id, "resume")}
                  >
                    ▶ Resume
                  </button>
                ) : session.status === "running" ||
                  session.status === "pending" ? (
                  <button
                    type="button"
                    className="btn btn-warning"
                    onClick={() => sendRemoteCommand(session.id, "pause")}
                  >
                    ⏸ Pause
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={true}
                  >
                    Session ended
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => sendRemoteCommand(session.id, "next")}
                  disabled={
                    session.status === "completed" ||
                    session.status === "aborted"
                  }
                >
                  Next ▶
                </button>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => sendRemoteCommand(session.id, "complete")}
                  disabled={
                    session.status === "completed" ||
                    session.status === "aborted"
                  }
                >
                  ✓ Complete
                </button>
              </footer>
            </article>
          ))
        )}
      </section>

      {/* Explanation / notes */}
      <section className="garden-remote-footer">
        <h2>How this garden remote works</h2>
        <ol className="garden-remote-steps">
          <li>
            Other parts of SSA (Garden Play, planners, automation) create garden
            sessions and emit <code>session.started</code> events.
          </li>
          <li>
            This page listens for <code>session.started</code>,{" "}
            <code>session.step.changed</code>, <code>session.paused</code>,{" "}
            <code>session.resumed</code>, <code>session.completed</code>, and{" "}
            <code>session.aborted</code> and shows them here.
          </li>
          <li>
            When you press a control button, this page emits a{" "}
            <code>session.remote.command</code> event with the command and
            session ID. The SessionRunner / automation runtime performs the real
            action and emits further session.* events.
          </li>
          <li>
            Inventory updates (e.g., harvest logs, preserved yield) and Hub
            exports are handled centrally by garden engines and the
            SessionRunner, so this view can stay thin and focused on control.
          </li>
        </ol>
        <p className="garden-remote-note">
          Later, this remote can be extended with{" "}
          <strong>weather-aware hints</strong> (e.g., “Rain in 30 minutes, pause
          watering?”), <strong>harvest weight shortcuts</strong>, and a combined
          remote for cooking, garden, animals, cleaning, and preservation
          sessions.
        </p>
      </section>
    </div>
  );
}

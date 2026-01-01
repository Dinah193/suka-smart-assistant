// C:\Users\larho\suka-smart-assistant\src\pages\animals\Remote.jsx
//
// AnimalsRemotePage
// ------------------
// This page is a "remote control" surface for animal-care sessions.
// It does NOT create sessions itself (that happens in Animals/Play.jsx,
// planners, or automation). Instead, it:
//
//  • Listens to the shared eventBus for session.* events.
//  • Shows active / recently active ANIMALS sessions.
//  • Lets the user send remote commands (pause, resume, next, previous,
//    complete) to the SessionRunner.
//
// How this fits into the SSA pipeline
// -----------------------------------
// imports → intelligence → automation → (optional) Hub export
//
// • imports:
//   Animal imports (care guides, vet schedules, butchery plans, pasture maps)
//   are handled elsewhere by ImportRouter and animals domain engines.
//   This page lives purely on the *execution* side.
//
// • intelligence:
//   The animals intelligence layer has already turned imports + weather +
//   calendar + herd/flock configuration into structured sessions (morning
//   check, feeding round, egg collection, pasture check, etc.).
//   This remote simply reflects those sessions as controllable items.
//
// • automation:
//   When you tap remote controls, this page emits commands like:
//     - session.remote.command
//   with data { sessionId, command, domain: "animals", reason }.
//   The automation runtime / SessionRunner listens for these commands and
//   performs the actual pause/resume/next/previous/complete actions,
//   then emits session.paused, session.resumed, session.step.changed,
//   session.completed, etc.
//
// • optional Hub export:
//   This page itself does not mutate inventory/storehouse or directly persist
//   session data. Hub exports for completed sessions are handled centrally
//   in the SessionRunner / domain engines so all domains behave consistently.
//
// Forward-thinking notes
// ----------------------
// • Mirrors CleaningRemote and GardenRemote; you can later unify these into
//   a global "Household Remote" with domain filters.
// • The subscription helper defensively supports multiple eventBus
//   signatures, so eventBus can evolve without breaking this page.

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
      console.warn("[AnimalsRemotePage] eventBus.emit not available");
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
      console.warn("[AnimalsRemotePage] eventBus not available");
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
          "[AnimalsRemotePage] Failed to subscribe with eventBus.on('*', handler):",
          err
        );
      }
    }
  }

  if (process.env.NODE_ENV !== "production") {
    // eslint-disable-next-line no-console
    console.warn("[AnimalsRemotePage] No compatible subscription API found");
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
  if (!data || !data.domain || data.domain !== "animals") return sessions;

  const id = data.id || (data.session && data.session.id);
  if (!id) return sessions;

  const existing = sessions.find((s) => s.id === id);

  /** @type {Partial<RemoteSessionSummary>} */
  const patch = { lastEventTs: ts };

  if (type === "session.started") {
    patch.status = "running";
    patch.title = data.title || existing?.title || "Animal-care session";
    patch.domain = "animals";
    patch.startedAt = data.startedAt || data.requestedAt || nowISO();
    patch.currentStepTitle =
      data.currentStepTitle || existing?.currentStepTitle || null;
    patch.currentStepIndex =
      typeof data.currentStepIndex === "number"
        ? data.currentStepIndex
        : existing?.currentStepIndex ?? null;
    if (!existing?.sourceLabel && data.source) {
      if (data.source.type === "animalTask") {
        patch.sourceLabel = "Animal task";
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
      title: patch.title || "Animal-care session",
      domain: "animals",
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

  // Keep recent sessions visible; pruning / archival can be added later.
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
 * AnimalsRemotePage component
 */
export default function AnimalsRemotePage() {
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

  const animalSessions = useMemo(
    () => sessions.filter((s) => s.domain === "animals"),
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

    emitEvent("session.remote.command", "animals.remote", {
      sessionId,
      command,
      domain: "animals",
      reason: "userRemoteControl",
    });

    const labelMap = {
      pause: "Paused",
      resume: "Resumed",
      next: "Advanced to next step",
      previous: "Moved to previous step",
      complete: "Marked as completed",
    };

    setLastCommandMsg(`${labelMap[command]} animal session ${sessionId}.`);
  };

  return (
    <div className="animals-remote-page">
      {/* Header */}
      <section className="animals-remote-header">
        <div>
          <h1 className="page-title">Animals Remote</h1>
          <p className="page-subtitle">
            Live control panel for animal-care sessions. Use this on a phone or
            spare screen while SSA guides checks, feeding rounds, egg
            collection, and pasture walks in real time.
          </p>
        </div>
        {lastCommandMsg && (
          <div className="status-banner" aria-live="polite">
            {lastCommandMsg}
          </div>
        )}
      </section>

      {/* Sessions list */}
      <section className="animals-remote-list">
        {animalSessions.length === 0 ? (
          <div className="empty-state">
            <p>No active or recent animal-care sessions detected.</p>
            <p className="empty-hint">
              Start a session from <strong>Animals &gt; Play</strong> or from an
              animals planner. Once it emits <code>session.started</code>, it
              will appear here.
            </p>
          </div>
        ) : (
          animalSessions.map((session) => (
            <article key={session.id} className="animals-remote-card">
              <header className="animals-remote-card-header">
                <div>
                  <h2>{session.title}</h2>
                  <p className="source-label">
                    {session.sourceLabel || "Animal-care session"}
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

              <div className="animals-remote-body">
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

              <footer className="animals-remote-controls">
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
      <section className="animals-remote-footer">
        <h2>How this animals remote works</h2>
        <ol className="animals-remote-steps">
          <li>
            Other parts of SSA (Animals Play, planners, automation) create
            animal-care sessions and emit <code>session.started</code> events.
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
            Inventory updates (e.g., milk/egg/meat yields, feed usage),
            storehouse logs, and Hub exports are handled centrally by animal
            domain engines and the SessionRunner so this view stays thin and
            focused on control.
          </li>
        </ol>
        <p className="animals-remote-note">
          In future versions, this remote can surface{" "}
          <strong>health alerts</strong> (e.g., “Temperature spike, check
          water?”), quick yield logging (milk/eggs), and shortcuts to schedule
          vet or butchery sessions directly from abnormal observations.
        </p>
      </section>
    </div>
  );
}

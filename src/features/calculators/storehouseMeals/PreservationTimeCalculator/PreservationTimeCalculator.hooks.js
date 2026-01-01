/* eslint-disable no-console */
/**
 * PreservationTimeCalculator.hooks.js
 *
 * Hooks to integrate Preservation Time Calculator outputs with the SSA SessionRunner.
 *
 * HOW THIS FITS:
 * - These hooks bridge the calculator → SessionRunner → (optional) Hub export.
 * - They do NOT run timers themselves; they emit session objects and listen for
 *   session lifecycle events via the global event bus.
 *
 * Core flows:
 * 1) usePreservationSessionBuilder
 *    - Takes a calculator result (from PreservationTimeCalculator.shim.js)
 *    - Builds a SessionRunner-compatible session object from sessionTemplateOverride.
 *
 * 2) usePreservationNowLauncher
 *    - Uses the builder to emit `session.requested` with the new session.
 *    - SessionRunner at the app root can then:
 *        * persist to Dexie
 *        * open its full-screen modal
 *        * keep timers, wake-lock, notifications running across navigation.
 *
 * 3) usePreservationSessionExport
 *    - Listens for session.completed / session.aborted events for domain === "preservation"
 *    - When familyFundMode === true, builds a Hub payload and sends via FamilyFundConnector.
 *    - Emits `session.exported` on successful Hub export.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import * as eventBus from "@/services/eventBus";
import { familyFundMode } from "@/services/featureFlags";
import { HubPacketFormatter, FamilyFundConnector } from "@/services/hub";

// Prefer named emit if present, otherwise fall back to a generic export.
const emit =
  typeof eventBus.emit === "function"
    ? eventBus.emit
    : (payload) => {
        console.warn(
          "[PreservationTimeCalculator.hooks] eventBus.emit missing; falling back to console only.",
          payload
        );
      };

/**
 * Safe subscription helper that works with different eventBus shapes.
 *
 * @param {(evt: { type: string, ts: string, source: string, data: any }) => void} handler
 * @returns {() => void} unsubscribe
 */
function subscribe(handler) {
  if (typeof eventBus.on === "function") {
    return eventBus.on(handler);
  }
  if (typeof eventBus.subscribe === "function") {
    const sub = eventBus.subscribe(handler);
    if (typeof sub === "function") return sub;
    if (sub && typeof sub.unsubscribe === "function") return () => sub.unsubscribe();
  }
  console.warn(
    "[PreservationTimeCalculator.hooks] No eventBus.on/subscribe; events will not be received."
  );
  return () => {};
}

/**
 * Build a SessionRunner-compatible session object from a calculator result.
 *
 * @param {object|null} calculatorResult
 * @returns {object|null} session
 */
function buildSessionFromCalculatorResult(calculatorResult) {
  if (!calculatorResult || !calculatorResult.output) return null;

  const { output } = calculatorResult;
  const template = output.sessionTemplateOverride;
  if (!template || !Array.isArray(template.steps) || template.steps.length === 0) {
    return null;
  }

  const createdAt = new Date().toISOString();

  return {
    id: template.id || `preservation-${Date.now()}`,
    domain: "preservation",
    title: template.title || "Preservation session",
    source: {
      type: "manual",
      refId: null
    },
    steps: template.steps.map((step, index) => ({
      id: step.id || `step-${index + 1}`,
      title: step.title || `Step ${index + 1}`,
      desc: step.desc || "",
      durationSec: typeof step.durationSec === "number" ? step.durationSec : 0,
      blockers: Array.isArray(step.blockers) ? step.blockers : ["inventory"],
      metadata: step.metadata || {
        tempTargetF: 0,
        donenessCue: "timer",
        cueNotes: ""
      }
    })),
    prefs: {
      voiceGuidance: true,
      haptic: true,
      autoAdvance: false
    },
    status: "pending",
    progress: {
      currentStepIndex: 0,
      elapsedSec: 0,
      startedAt: null,
      pausedAt: null
    },
    analytics: {
      skippedSteps: [],
      adjustments: []
    },
    createdAt,
    updatedAt: createdAt
  };
}

/**
 * usePreservationSessionBuilder
 *
 * Given the latest calculator result (from the shim), builds a SessionRunner
 * session draft and exposes it for the UI or automation logic.
 *
 * @param {object|null} calculatorResult
 * @returns {{
 *   sessionDraft: object|null,
 *   canBuildSession: boolean,
 *   rebuild: () => object|null
 * }}
 */
export function usePreservationSessionBuilder(calculatorResult) {
  const sessionDraft = useMemo(
    () => buildSessionFromCalculatorResult(calculatorResult),
    [calculatorResult]
  );

  const rebuild = useCallback(() => buildSessionFromCalculatorResult(calculatorResult), [
    calculatorResult
  ]);

  return {
    sessionDraft,
    canBuildSession: !!sessionDraft,
    rebuild
  };
}

/**
 * usePreservationNowLauncher
 *
 * Hook to expose a “Now” action that:
 * - validates the presence of a sessionDraft
 * - emits session.requested to the global eventBus
 * - (optionally) can also emit an immediate session.started if you want to
 *   auto-start when SessionRunner picks it up.
 *
 * Typically used in the PreservationTimeCalculator.view or on the
 * preservation / storehouse pages for a “Run Now” CTA.
 *
 * @param {object|null} sessionDraft
 * @param {string} [sourceTag="PreservationTimeCalculatorView"]
 */
export function usePreservationNowLauncher(sessionDraft, sourceTag = "PreservationTimeCalculator") {
  const [isLaunching, setIsLaunching] = useState(false);

  const launchNow = useCallback(() => {
    if (!sessionDraft) {
      console.warn(
        "[usePreservationNowLauncher] No sessionDraft available; did the calculator run yet?"
      );
      return;
    }

    setIsLaunching(true);
    const ts = new Date().toISOString();

    try {
      // Core request for SessionRunner
      emit({
        type: "session.requested",
        ts,
        source: sourceTag,
        data: {
          session: sessionDraft
        }
      });

      // Optional “optimistic” started event – comment out if you want
      // SessionRunner to be the only source of session.started.
      emit({
        type: "session.started",
        ts,
        source: `${sourceTag}.hooks`,
        data: {
          sessionId: sessionDraft.id,
          domain: sessionDraft.domain
        }
      });
    } catch (err) {
      console.error("[usePreservationNowLauncher] Failed to emit session.requested", err);
    } finally {
      setIsLaunching(false);
    }
  }, [sessionDraft, sourceTag]);

  return {
    launchNow,
    isLaunching
  };
}

/**
 * Internal helper to send preservation session analytics to the Hub.
 *
 * @param {object} sessionEvent
 * @returns {Promise<void>}
 */
async function exportPreservationSessionToHub(sessionEvent) {
  if (!familyFundMode) return;

  try {
    const envelope = HubPacketFormatter.formatSessionAnalytics({
      domain: "preservation",
      eventType: sessionEvent.type,
      timestamp: sessionEvent.ts,
      payload: sessionEvent.data
    });

    await FamilyFundConnector.send(envelope);

    emit({
      type: "session.exported",
      ts: new Date().toISOString(),
      source: "PreservationTimeCalculator.hooks",
      data: {
        domain: "preservation",
        originalEventType: sessionEvent.type,
        sessionId: sessionEvent.data?.sessionId || null
      }
    });
  } catch (err) {
    // Fail silently per spec (no user-facing error, but log to console).
    console.warn(
      "[PreservationTimeCalculator.hooks] Failed to export preservation session to Hub",
      err
    );
  }
}

/**
 * usePreservationSessionExport
 *
 * Hook that listens for completion/abort events on preservation sessions
 * and triggers optional Hub export when familyFundMode is enabled.
 *
 * Usage:
 * - Mount once at app root (e.g., in App.jsx or a top-level provider)
 *   so that all preservation sessions benefit from analytics & export.
 *
 * Events observed:
 * - session.completed
 * - session.aborted
 */
export function usePreservationSessionExport() {
  useEffect(() => {
    const unsubscribe = subscribe(async (evt) => {
      if (!evt || !evt.type || !evt.data) return;

      const isPreservation =
        evt.data.domain === "preservation" ||
        evt.data.session?.domain === "preservation";

      if (!isPreservation) return;

      if (evt.type === "session.completed" || evt.type === "session.aborted") {
        // Ensure we always have a sessionId in data for downstream consumers.
        const sessionId =
          evt.data.sessionId || evt.data.session?.id || evt.data.id || null;

        const normalizedEvent = {
          ...evt,
          data: {
            ...evt.data,
            sessionId
          }
        };

        await exportPreservationSessionToHub(normalizedEvent);
      }
    });

    return () => {
      try {
        unsubscribe();
      } catch (err) {
        console.warn(
          "[PreservationTimeCalculator.hooks] Error while unsubscribing from eventBus",
          err
        );
      }
    };
  }, []);
}

/**
 * usePreservationSessionStatus
 *
 * Optional QoL hook if you want local UI (e.g., “Now” button) to reflect
 * whether a preservation session is currently running or paused without
 * querying Dexie directly.
 *
 * It listens for:
 * - session.started
 * - session.step.changed
 * - session.paused
 * - session.resumed
 * - session.completed
 * - session.aborted
 *
 * And keeps a tiny in-memory snapshot of the latest status for
 * domain === "preservation".
 *
 * @returns {{
 *   activeSessionId: string|null,
 *   status: "idle"|"running"|"paused"|"completed"|"aborted",
 *   lastUpdated: string|null
 * }}
 */
export function usePreservationSessionStatus() {
  const [state, setState] = useState({
    activeSessionId: null,
    status: "idle",
    lastUpdated: null
  });

  useEffect(() => {
    const handler = (evt) => {
      if (!evt || !evt.type || !evt.data) return;

      const domain =
        evt.data.domain || evt.data.session?.domain || evt.data.sessionDomain;
      if (domain !== "preservation") return;

      const sessionId =
        evt.data.sessionId || evt.data.session?.id || evt.data.id || null;

      let statusUpdate = null;

      switch (evt.type) {
        case "session.started":
          statusUpdate = "running";
          break;
        case "session.step.changed":
        case "session.resumed":
          statusUpdate = "running";
          break;
        case "session.paused":
          statusUpdate = "paused";
          break;
        case "session.completed":
          statusUpdate = "completed";
          break;
        case "session.aborted":
          statusUpdate = "aborted";
          break;
        default:
          break;
      }

      if (!statusUpdate) return;

      setState({
        activeSessionId: sessionId,
        status: statusUpdate,
        lastUpdated: evt.ts || new Date().toISOString()
      });
    };

    const unsubscribe = subscribe(handler);
    return () => {
      try {
        unsubscribe();
      } catch (err) {
        console.warn(
          "[PreservationTimeCalculator.hooks] Error during unsubscribe in usePreservationSessionStatus",
          err
        );
      }
    };
  }, []);

  return state;
}

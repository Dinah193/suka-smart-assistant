// src/hooks/useAutomationVersion.js
import { useSyncExternalStore } from "react";
import { automation as runtimeAutomation } from "@/services/automation/runtime";

/**
 * useAutomationVersion
 * -----------------------------------------------------------------------------
 * A tiny, stable primitive snapshot for React that ticks only when the
 * automation runtime meaningfully changes. Designed to:
 *  - Avoid render loops (distinctUntilChanged).
 *  - Survive SSR/CSR races (safe server snapshot).
 *  - Work even if the automation runtime hasn't fully booted (poll fallback).
 *
 * Assumptions about automation runtime (we handle variance gracefully):
 *  - Preferred: automation.subscribe(listener) -> () => unsubscribe
 *  - Also supported (best-effort): automation.on("change", listener) & .off(...)
 *  - Version source: automation.version OR automation.getVersion()
 */

function getAutomation() {
  // Wrap in try/catch in case the module side-effects throw during hydration.
  try {
    return runtimeAutomation || {};
  } catch {
    return {};
  }
}

function readVersion(automationObj) {
  const a = automationObj || {};
  const v =
    (typeof a.getVersion === "function" ? a.getVersion() : a.version) ?? 0;
  // Force a number so React diffing is predictable.
  return Number.isFinite(v) ? v : 0;
}

/**
 * subscribeDistinct
 * - Normalizes subscription across various runtime shapes.
 * - Ensures the provided callback is only invoked when the version *actually* changes.
 * - Falls back to a short polling loop if no subscription mechanism exists yet.
 */
function subscribeDistinct(automationObj, onChange) {
  let last = readVersion(automationObj);

  // Wrap the callback so we only notify React when the version changed.
  const maybeNotify = () => {
    const next = readVersion(automationObj);
    if (next !== last) {
      last = next;
      onChange();
    }
  };

  // 1) Preferred: subscribe(cb) -> unsubscribe
  if (automationObj && typeof automationObj.subscribe === "function") {
    const unsub = automationObj.subscribe(maybeNotify);
    // Some runtimes call back very frequently—defend via distinct check above.
    return typeof unsub === "function" ? unsub : () => {};
  }

  // 2) EventEmitter-style: on/off("change", cb)
  if (
    automationObj &&
    typeof automationObj.on === "function" &&
    typeof automationObj.off === "function"
  ) {
    automationObj.on("change", maybeNotify);
    // In case the runtime also emits more granular events, listen to a few common aliases.
    if (typeof automationObj.on === "function") {
      try {
        automationObj.on("version", maybeNotify);
        automationObj.on("templates:update", maybeNotify);
        automationObj.on("runtime:update", maybeNotify);
      } catch {
        /* noop */
      }
    }
    return () => {
      try {
        automationObj.off("change", maybeNotify);
        automationObj.off("version", maybeNotify);
        automationObj.off("templates:update", maybeNotify);
        automationObj.off("runtime:update", maybeNotify);
      } catch {
        /* noop */
      }
    };
  }

  // 3) Fallback: short polling loop (only used when no subscription exists yet)
  // Keep interval short for snappy UI but lightweight enough for idle tabs.
  const interval = setInterval(maybeNotify, 400);
  return () => clearInterval(interval);
}

export default function useAutomationVersion() {
  const automationObj = getAutomation();

  // getSnapshot: runs on the client to provide current value.
  const getSnapshot = () => readVersion(automationObj);

  // getServerSnapshot: used during SSR; must be static & serializable.
  // 0 is a safe baseline; the client will resubscribe and reconcile.
  const getServerSnapshot = () => 0;

  // subscribe: normalize and distinct-notify changes.
  const subscribe = (cb) => subscribeDistinct(automationObj, cb);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// C:\Users\larho\suka-smart-assistant\src\ui\modals\RootPortal.jsx
// Root-level Portal host for SSA modals (SessionRunner, pickers, etc.)
// -----------------------------------------------------------------------------
// HOW THIS FITS THE PIPELINE
// This file provides a single, app-wide portal container so session modals
// (e.g., SessionRunner) stay mounted across route changes and can keep timers,
// wake-lock, notifications, and progress intact while the user navigates.
// It also broadcasts UI modal open/close events on the event bus so other
// subsystems (toasts, banners, guards) can react without tight coupling.
//
// USAGE
// 1) Mount once near the root of your app (e.g., in App.jsx):
//      import { RootPortalMount } from "@/ui/modals/RootPortal";
//      ...
//      <RootPortalMount />
//
// 2) Render any modal content through the portal:
//      import { RootPortal, openRootModal, closeRootModal } from "@/ui/modals/RootPortal";
//      ...
//      useEffect(() => { openRootModal("SessionRunner"); return () => closeRootModal("SessionRunner"); }, []);
//      return (
//        <RootPortal>
//          <YourModalComponent />
//        </RootPortal>
//      );
//
// NOTES
// - Body scroll is locked while ≥1 root modal is open.
// - Emits UI modal events through the event bus with canonical envelope:
//     { type, ts, source, data }  (source="RootPortal")
// - Safe on SSR: no-ops when document is undefined.
// -----------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Prefer your project's alias. Your event bus lives at services/events/eventBus.js.
import eventBus, { Events } from "@/services/events/eventBus";

/** DOM id for the singleton portal element */
const PORTAL_ID = "ssa-root-portal";

/** Tracks how many modals are currently "open" globally */
let openCount = 0;

/** Original body overflow so we can restore after scroll lock */
let originalBodyOverflow = "";

/** SSR guard */
const hasDOM = () => typeof window !== "undefined" && typeof document !== "undefined";

/** Create (or retrieve) the singleton portal element. */
function ensureContainer() {
  if (!hasDOM()) return null;
  let el = document.getElementById(PORTAL_ID);
  if (el) return el;

  el = document.createElement("div");
  el.id = PORTAL_ID;
  // Minimal baseline styles; modals should still manage their own z-index layering.
  el.setAttribute("data-ssa-root-portal", "true");
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.zIndex = "2147483600"; // just below max int, stays above app chrome
  el.style.pointerEvents = "none"; // children enable pointerEvents as needed
  el.style.display = "contents";  // avoid extra stacking if children manage layering
  document.body.appendChild(el);
  return el;
}

/** Lock body scroll when at least one root modal is open. */
function lockBodyScroll() {
  if (!hasDOM()) return;
  if (openCount === 1) { // just transitioned 0 -> 1
    originalBodyOverflow = document.body.style.overflow || "";
    document.body.style.overflow = "hidden";
    document.body.classList.add("ssa-has-root-modal");
  }
}

/** Unlock body scroll when the last root modal closes. */
function unlockBodyScroll() {
  if (!hasDOM()) return;
  if (openCount === 0) {
    document.body.style.overflow = originalBodyOverflow;
    document.body.classList.remove("ssa-has-root-modal");
  }
}

/**
 * Announce modal open on the event bus (canonical envelope handled by the bus).
 * @param {string} reason - logical source (e.g., "SessionRunner", "Picker")
 */
export function openRootModal(reason = "unknown") {
  openCount = Math.max(0, openCount + 1);
  lockBodyScroll();
  try {
    eventBus.emit(Events.UI_MODAL_OPEN, { reason, openCount }, { source: "RootPortal" });
  } catch {
    // non-fatal
  }
}

/**
 * Announce modal close on the event bus.
 * @param {string} reason - logical source (e.g., "SessionRunner", "Picker")
 */
export function closeRootModal(reason = "unknown") {
  openCount = Math.max(0, openCount - 1);
  if (openCount === 0) unlockBodyScroll();
  try {
    eventBus.emit(Events.UI_MODAL_CLOSE, { reason, openCount }, { source: "RootPortal" });
  } catch {
    // non-fatal
  }
}

/**
 * Ensure the portal container exists for the lifetime of the app.
 * Mount exactly once at the top of your app tree (e.g., in App.jsx).
 */
export function RootPortalMount() {
  // useLayoutEffect to create the container before paint to avoid flicker.
  useLayoutEffect(() => {
    ensureContainer();
  }, []);

  // Nothing to render; this component's job is to ensure the container exists.
  return null;
}

/**
 * Render children into the root portal.
 * Children should enable pointer events themselves (e.g., a modal root <div style={{pointerEvents:'auto'}}>).
 */
export function RootPortal({ children }) {
  const [container, setContainer] = useState(null);

  useEffect(() => {
    setContainer(ensureContainer());
  }, []);

  if (!hasDOM() || !container) return null;
  return createPortal(children, container);
}

/**
 * Hook to get a ref to the portal element in rare cases where you need
 * to manually append a non-React node (e.g., external library).
 */
export function useRootPortalElement() {
  const ref = useRef(null);
  useEffect(() => {
    ref.current = ensureContainer();
  }, []);
  return ref;
}

/**
 * Convenience component: wraps content with automatic open/close bookkeeping.
 * Useful for modals that should increment/decrement the global open counter
 * on mount/unmount without extra boilerplate.
 *
 * Example:
 *   <RootModalFrame reason="SessionRunner">
 *     <YourModal .../>
 *   </RootModalFrame>
 */
export function RootModalFrame({ reason = "unknown", children }) {
  useEffect(() => {
    openRootModal(reason);
    return () => closeRootModal(reason);
  }, [reason]);

  // Ensure pointer events are enabled at the modal's root.
  return (
    <RootPortal>
      <div style={{ pointerEvents: "auto" }}>
        {children}
      </div>
    </RootPortal>
  );
}

export default RootPortal;

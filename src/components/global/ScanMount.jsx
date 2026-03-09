/* eslint-disable no-console */
// src/components/global/ScanMount.jsx
// Mounts a global Scan • Compare • Trust FAB + Bottom Sheet via a React Portal.
// - Hotkeys: [Shift+S] toggle, [Esc] close
// - Emits DOM CustomEvents: 'scan:open', 'scan:close', 'scan:start', 'scan:import', 'scan:compare'
// - Listens for 'scan:result' to show a tiny toast
// - Sabbath/Quiet-hours guard (non-blocking config hook)
// - Tailwind-friendly and pairs with styles/scan.css

import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";
import { createPortal } from "react-dom";
import "@/app/features/scan-compare-trust/styles/scan.css";

// Lazy adapters — your project already has these or is adding them.
// They’re optional; we guard rendering if they’re missing.
const LazyScanner = React.lazy(() =>
  import("@/app/features/scan-compare-trust/components/Scanner.jsx").catch(
    () => ({ default: () => null })
  )
);
const LazyScanSheet = React.lazy(() =>
  import("@/app/features/scan-compare-trust/components/ScanSheet.jsx").catch(
    () => ({ default: () => null })
  )
);

// Optional: tiny runtime config hook (quiet hours, sabbath guard)
function useSukaConfig() {
  // If you have a real config store, swap this out.
  const cfg = window?.sukaConfig ?? {};
  return {
    sabbathGuard: cfg.sabbathGuard ?? {
      enabled: false,
      start: "Friday 18:00",
      end: "Saturday 19:00",
    },
    quietHours: cfg.quietHours ?? {
      enabled: false,
      start: "22:00",
      end: "07:00",
    },
  };
}

function nowInRange(startHHmm, endHHmm, d = new Date()) {
  const [sh, sm] = String(startHHmm).split(":").map(Number);
  const [eh, em] = String(endHHmm).split(":").map(Number);
  const n = new Date(d);
  const s = new Date(d);
  s.setHours(sh || 0, sm || 0, 0, 0);
  const e = new Date(d);
  e.setHours(eh || 0, em || 0, 0, 0);
  if (s <= e) return n >= s && n <= e; // same-day window
  return n >= s || n <= e; // overnight window
}

function isSabbathActive({ enabled, start, end }, d = new Date()) {
  if (!enabled) return false;
  // Very lightweight: if day/time falls between named ranges.
  // (Your gardenExecutor has a stronger Sabbath guard; this is a UI nudge only.)
  const dow = d.getDay(); // 0 Sun .. 6 Sat
  // Default: Fri evening to Sat evening
  const fri = new Date(d);
  fri.setDate(d.getDate() - ((dow + 2) % 7)); // previous Friday
  const sat = new Date(fri);
  sat.setDate(fri.getDate() + 1);
  const inFri = new Date(fri);
  const inSat = new Date(sat);
  return (
    (nowInRange(start || "18:00", "23:59", d) &&
      d.toDateString() === fri.toDateString()) ||
    (nowInRange("00:00", end || "19:00", d) &&
      d.toDateString() === sat.toDateString())
  );
}

function useEventBus() {
  return useMemo(
    () => ({
      emit: (name, detail = {}) => {
        document.dispatchEvent(new CustomEvent(name, { detail }));
      },
      on: (name, handler) => {
        document.addEventListener(name, handler);
        return () => document.removeEventListener(name, handler);
      },
    }),
    []
  );
}

export default function ScanMount() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("scan"); // 'scan' | 'compare' | 'favorites'
  const [toast, setToast] = useState(null);
  const portalRef = useRef(null);
  const { sabbathGuard, quietHours } = useSukaConfig();
  const bus = useEventBus();

  // Mount portal root
  useEffect(() => {
    const div = document.createElement("div");
    div.setAttribute("id", "scan-mount-root");
    document.body.appendChild(div);
    portalRef.current = div;
    setMounted(true);
    return () => {
      document.body.removeChild(div);
      portalRef.current = null;
      setMounted(false);
    };
  }, []);

  // Hotkeys
  useEffect(() => {
    const onKey = (e) => {
      // Ignore while typing
      const tag = (e.target?.tagName || "").toLowerCase();
      if (["input", "textarea"].includes(tag) || e.target?.isContentEditable)
        return;

      if (e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        toggle();
      }
      if (e.key === "Escape" && open) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Listen for scanner results to show a toast
  useEffect(() => {
    const off = bus.on("scan:result", (e) => {
      const msg = e?.detail?.message || "Scan complete";
      showToast(msg);
    });
    return off;
  }, [bus]);

  function showToast(message, ms = 2200) {
    setToast(String(message));
    const t = setTimeout(() => setToast(null), ms);
    return () => clearTimeout(t);
  }

  function guardMessage() {
    const now = new Date();
    if (sabbathGuard?.enabled && isSabbathActive(sabbathGuard, now)) {
      return "Sabbath guard is active. Scanning is paused.";
    }
    if (
      quietHours?.enabled &&
      nowInRange(quietHours.start, quietHours.end, now)
    ) {
      return "Quiet hours are active. Camera/OCR muted.";
    }
    return null;
  }

  function toggle() {
    if (open) return close();
    const msg = guardMessage();
    if (msg) showToast(msg);
    setOpen(true);
    bus.emit("scan:open", { tab });
  }
  function close() {
    setOpen(false);
    bus.emit("scan:close", {});
  }

  // Sheet actions
  const startBarcodeScan = () => {
    const msg = guardMessage();
    if (msg) showToast(msg);
    setTab("scan");
    setOpen(true);
    bus.emit("scan:start", { mode: "barcode" });
  };
  const startPhotoOCR = () => {
    const msg = guardMessage();
    if (msg) showToast(msg);
    setTab("scan");
    setOpen(true);
    bus.emit("scan:start", { mode: "photo-ocr" });
  };
  const importPDF = () => {
    setTab("scan");
    setOpen(true);
    bus.emit("scan:import", { kind: "pdf" });
  };
  const openCompare = () => {
    setTab("compare");
    setOpen(true);
    bus.emit("scan:compare", {});
  };
  const openFavorites = () => {
    setTab("favorites");
    setOpen(true);
    bus.emit("favorites:open", { scope: "scan-sessions" });
  };

  if (!mounted || !portalRef.current) return null;

  return createPortal(
    <>
      {/* FAB */}
      <button
        className="scan-fab"
        data-state={open ? "active" : "idle"}
        aria-label="Open scanner"
        onClick={toggle}
      >
        {/* Simple icon (Tailwind) */}
        <svg
          width="26"
          height="26"
          viewBox="0 0 24 24"
          role="img"
          aria-hidden="true"
        >
          <path
            d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M7 12h1m2 0h1m2 0h1"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        {/* optional mini-badge for queued items/errors (hook up via bus if desired) */}
        {/* <span className="badge">2</span> */}
      </button>

      {/* Scrim */}
      <div className="scan-sheet-scrim" data-open={open} onClick={close} />

      {/* Bottom Sheet */}
      <section
        className="scan-sheet"
        data-open={open}
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-sheet-title"
      >
        <div className="scan-handle" aria-hidden="true" />

        <div className="scan-content">
          {/* Sticky bar: Tabs + Attribution cluster placeholder */}
          <div className="scan-sticky">
            <div className="flex items-center justify-between gap-2">
              <div className="inline-flex rounded-full border border-[var(--scan-border)] p-1">
                {["scan", "compare", "favorites"].map((k) => (
                  <button
                    key={k}
                    onClick={() => setTab(k)}
                    className={`px-3 py-1 rounded-full text-sm ${
                      tab === k
                        ? "bg-[var(--scan-badge-bg)] text-[var(--scan-badge-tx)]"
                        : "text-[var(--scan-text)]"
                    }`}
                    aria-pressed={tab === k}
                  >
                    {k === "scan"
                      ? "Scan"
                      : k === "compare"
                      ? "Compare"
                      : "Favorites"}
                  </button>
                ))}
              </div>

              {/* SourceAttribution hook (optional): */}
              <div className="scan-attrib">
                <span className="scan-badge">Scan • Compare • Trust</span>
              </div>
            </div>
          </div>

          {/* Panels */}
          <div className="scan-grid mt-2">
            {tab === "scan" && (
              <div className="scan-card p-3">
                <div className="flex items-center justify-between mb-2">
                  <h2 id="scan-sheet-title" className="text-base font-semibold">
                    Scan Items
                  </h2>
                  <button
                    onClick={close}
                    className="fav-toggle"
                    aria-label="Close scan panel"
                  >
                    ✕
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    onClick={startBarcodeScan}
                    className="scan-chip"
                    data-variant="success"
                  >
                    Barcode
                  </button>
                  <button onClick={startPhotoOCR} className="scan-chip">
                    Photo / Doc OCR
                  </button>
                  <button onClick={importPDF} className="scan-chip">
                    Import PDF Ad
                  </button>
                </div>

                <div className="scan-divider" />

                <Suspense fallback={<div className="scan-skel h-32 w-full" />}>
                  {/* Scanner mounts camera/live decoding if available; else shows a hint */}
                  <LazyScanner
                    onResult={(payload) => {
                      bus.emit("scan:result", {
                        message: payload?.label || "Item captured",
                        payload,
                      });
                    }}
                  />
                </Suspense>
              </div>
            )}

            {tab === "compare" && (
              <div className="scan-card p-3">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-base font-semibold">Compare & Rank</h2>
                  <button onClick={openFavorites} className="scan-chip">
                    Favorites →
                  </button>
                </div>

                <Suspense fallback={<div className="scan-skel h-40 w-full" />}>
                  {/* ScanSheet should show ranked rows + reasons + actions (add to plan, watch, etc.) */}
                  <LazyScanSheet onClose={close} />
                </Suspense>
              </div>
            )}

            {tab === "favorites" && (
              <div className="scan-card p-3">
                <div className="flex items-center justify-between mb-2">
                  <h2 className="text-base font-semibold">Your Favorites</h2>
                  <button onClick={openCompare} className="scan-chip">
                    Back to Compare
                  </button>
                </div>
                {/* Minimal empty state – hook into your real Favorites panel */}
                <div className="scan-empty">
                  Save sessions, schedules, or items while scanning to see them
                  here.
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Tiny toast */}
      <div
        className="scan-toast"
        data-open={!!toast}
        role="status"
        aria-live="polite"
      >
        {toast}
      </div>
    </>,
    portalRef.current
  );
}

// src/components/shared/ConfirmBar.jsx
// A dynamic, accessible sticky confirmation bar inspired by best-in-class UX
// (e.g., Notion, Figma). It supports guardrails, async states, destructive
// actions with type-to-confirm, and keyboard shortcuts. Self-contained—no
// alias imports.

import React, { useEffect, useMemo, useRef, useState } from "react";

const cx = (...xs) => xs.filter(Boolean).join(" ");

/**
 * Props
 * - open: boolean                                // show/hide bar
 * - onConfirm: (ctx) => Promise<void> | void     // called when confirmed
 * - onCancel: () => void                         // called when canceled/closed
 * - confirmLabel?: string                        // default "Save"
 * - cancelLabel?: string                         // default "Discard"
 * - variant?: "primary" | "accent" | "danger"   // button palette
 * - busy?: boolean                               // external busy lock
 * - disabled?: boolean                           // external disable
 * - message?: string                             // inline message
 * - children?: React.ReactNode                   // custom content left-aligned
 * - sticky?: boolean                             // true => fixed to bottom of viewport
 * - guards?: Array<{ ok: boolean, label: string, help?: string }>
 *      Guard examples: split == 100%, has at least one meal, etc.
 * - requireType?: string | null                  // if set (e.g., "DELETE"), user must type to enable
 * - requireAckLabel?: string | null              // checkbox label that must be checked
 * - countdownMs?: number                         // optional delay before enabling confirm (e.g., dangerous)
 * - enterToConfirm?: boolean                     // default true
 * - escToCancel?: boolean                        // default true
 * - onAfterConfirm?: () => void                  // optional callback after resolve
 * - compact?: boolean                            // reduced height/density
 */
export default function ConfirmBar({
  open,
  onConfirm,
  onCancel,
  confirmLabel = "Save",
  cancelLabel = "Discard",
  variant = "primary",
  busy = false,
  disabled = false,
  message = "",
  children,
  sticky = true,
  guards = [],
  requireType = null,
  requireAckLabel = null,
  countdownMs = 0,
  enterToConfirm = true,
  escToCancel = true,
  onAfterConfirm,
  compact = false,
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [ack, setAck] = useState(false);
  const [typed, setTyped] = useState("");
  const [msLeft, setMsLeft] = useState(Math.max(0, countdownMs || 0));
  const timerRef = useRef(null);

  // start/clear countdown
  useEffect(() => {
    if (!open) { clearTimer(); setMsLeft(Math.max(0, countdownMs || 0)); return; }
    if (countdownMs > 0) startTimer(countdownMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, countdownMs]);

  function startTimer(ms) {
    clearTimer();
    const started = Date.now();
    timerRef.current = setInterval(() => {
      const diff = ms - (Date.now() - started);
      setMsLeft(Math.max(0, diff));
      if (diff <= 0) clearTimer();
    }, 100);
  }
  function clearTimer() { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } }
  useEffect(() => () => clearTimer(), []);

  const hasGuards = (guards && guards.length) > 0;
  const guardOk = useMemo(() => guards.every(g => !!g.ok), [guards]);
  const needsType = !!requireType;
  const typeOk = !needsType || typed.trim() === String(requireType).trim();
  const needsAck = !!requireAckLabel;
  const ackOk = !needsAck || !!ack;
  const countdownOk = msLeft <= 0;

  const canConfirm = open && !busy && !isBusy && !disabled && guardOk && typeOk && ackOk && countdownOk;

  // keyboard shortcuts
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (escToCancel && e.key === "Escape") { e.preventDefault(); onCancel?.(); }
      if (enterToConfirm && e.key === "Enter") {
        // avoid submitting if an input is active and type requirements unmet
        const tag = (e.target?.tagName || "").toLowerCase();
        const isFormEl = ["input", "textarea", "select"].includes(tag);
        if (isFormEl && needsType && !typeOk) return;
        if (canConfirm) { e.preventDefault(); handleConfirm(); }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, canConfirm, escToCancel, enterToConfirm, needsType, typeOk]);

  // async confirm wrapper
  const handleConfirm = async () => {
    if (!canConfirm) return;
    try {
      setIsBusy(true);
      await onConfirm?.({ typed, ack });
      onAfterConfirm?.();
    } finally {
      setIsBusy(false);
    }
  };

  if (!open) return null;

  const palette = variantPalette(variant);
  const holderCls = sticky
    ? "fixed bottom-0 left-0 right-0 z-40"
    : "relative";

  const content = (
    <div className={cx(
      "mx-auto max-w-screen-lg",
      compact ? "p-2" : "p-3"
    )}>
      <div className={cx(
        "rounded-2xl border bg-base-100 shadow-xl backdrop-blur",
        compact ? "px-3 py-2" : "px-4 py-3"
      )}>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          {/* Left: message / custom children */}
          <div className="flex-1 min-w-0">
            {message && <div className="text-sm font-medium truncate" title={message}>{message}</div>}
            {children}
            {hasGuards && !guardOk && (
              <div className="mt-1 text-[11px] text-warning">
                Please resolve the following before continuing:
                <ul className="list-disc ml-4">
                  {guards.filter(g => !g.ok).map((g, i) => (
                    <li key={i}>{g.label}{g.help ? <span className="opacity-70"> — {g.help}</span> : null}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Right: controls */}
          <div className="flex items-center gap-2 sm:ml-auto">
            {needsAck && (
              <label className="flex items-center gap-1 text-xs">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>{requireAckLabel}</span>
              </label>
            )}
            {needsType && (
              <input
                className="input input-sm w-32"
                placeholder={`Type ${requireType}`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}

            <button
              className={cx(
                "btn btn-sm",
                palette.confirm,
                (!canConfirm || isBusy) && "btn-disabled opacity-60"
              )}
              onClick={handleConfirm}
              disabled={!canConfirm || isBusy}
            >
              {isBusy ? (
                <span className="inline-flex items-center gap-1">
                  <Spinner />
                  {confirmLabel}
                </span>
              ) : (
                <>{confirmLabel}{!countdownOk && ` (${formatCountdown(msLeft)})`}</>
              )}
            </button>
            <button
              className={cx("btn btn-sm", palette.cancel)}
              onClick={() => onCancel?.()}
            >
              {cancelLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className={holderCls} role="region" aria-label="Confirmation Bar">
      {content}
    </div>
  );
}

/* --------------------------------------------------------------------------
   Visual helpers
---------------------------------------------------------------------------- */
function variantPalette(variant) {
  switch (variant) {
    case "danger":
      return { confirm: "btn-error text-white", cancel: "btn-ghost" };
    case "accent":
      return { confirm: "btn-accent text-white", cancel: "btn-ghost" };
    default:
      return { confirm: "btn-primary text-white", cancel: "btn-ghost" };
  }
}

function Spinner() {
  return (
    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path>
    </svg>
  );
}

/* --------------------------------------------------------------------------
   Utilities + tests (non-UI)
---------------------------------------------------------------------------- */
export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${s}s`;
}

export function canProceed({ open, busy, disabled, guardOk, typeOk, ackOk, countdownOk }) {
  return !!(open && !busy && !disabled && guardOk && typeOk && ackOk && countdownOk);
}

// Minimal assertions
function assert(name, cond) { if (!cond) throw new Error("Test failed: " + name); }
export function runConfirmBarTests() {
  assert("formatCountdown floors up", formatCountdown(999) === "1s" && formatCountdown(1) === "1s");
  const base = { open: true, busy: false, disabled: false, guardOk: true, typeOk: true, ackOk: true, countdownOk: true };
  assert("canProceed true base", canProceed(base) === true);
  assert("canProceed false when guard fails", canProceed({ ...base, guardOk: false }) === false);
  assert("canProceed false when countdown not done", canProceed({ ...base, countdownOk: false }) === false);
}

if (typeof process === "undefined" || process?.env?.NODE_ENV !== "production") {
  try { runConfirmBarTests(); } catch (e) { console.error("ConfirmBar tests:", e); }
}

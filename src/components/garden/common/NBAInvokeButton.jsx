// src/components/garden/common/NBAInvokeButton.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------ Defensive imports ------------------------------ */
let automation = null;
try {
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch (_) {}

let GardenQueueManager = null;
try {
  // @ts-ignore
  GardenQueueManager = require("@/managers/GardenQueueManager").default || null;
} catch (_) {}

let useSettingsStore = null;
try {
  // @ts-ignore
  useSettingsStore = require("@/stores/settingsStore").useSettingsStore || null;
} catch (_) {}

/* ------------------------------------ Utils ------------------------------------ */
const uid = () => Math.random().toString(36).slice(2, 10);
const emit = (type, detail) => {
  if (automation?.emit) automation.emit(type, detail);
  window.dispatchEvent(new CustomEvent(type, { detail }));
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const kbd = (e) => {
  // Normalize a compact accelerator label for tooltips
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("⌘");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.key && !["Control", "Alt", "Shift", "Meta"].includes(e.key)) parts.push(e.key.toUpperCase());
  return parts.join(" + ");
};

/* ----------------------------- Suggestion renderer ----------------------------- */
/**
 * We expect suggestions in the flexible shape:
 * {
 *   id, label, detail, confidence (0..1), kind: "plan"|"remind"|"adjust"|"info",
 *   action?: { type, payload }, preview?: { type, payload }, explain?: string
 * }
 * but we also map looser shapes (string, arrays, etc.).
 */
function normalizeSuggestions(raw) {
  if (!raw) return [];
  let arr = Array.isArray(raw) ? raw : (raw.items || raw.suggestions || []);
  if (!Array.isArray(arr)) arr = [];
  return arr.map((s, i) => {
    if (typeof s === "string") {
      return { id: `s-${i}`, label: s, detail: "", confidence: 0.5, kind: "info" };
    }
    return {
      id: s.id || `s-${i}`,
      label: s.label || s.title || "Suggestion",
      detail: s.detail || s.subtitle || "",
      confidence: clamp(Number(s.confidence ?? 0.5), 0, 1),
      kind: s.kind || s.category || "info",
      action: s.action || null,
      preview: s.preview || null,
      explain: s.explain || s.reason || "",
      raw: s,
    };
  });
}

function ConfidenceBar({ v = 0.5 }) {
  const pct = `${Math.round(clamp(v, 0, 1) * 100)}%`;
  return (
    <div className="h-1 w-24 bg-gray-100 rounded-full overflow-hidden" title={`Confidence: ${pct}`}>
      <div className="h-1 bg-gray-900" style={{ width: pct }} />
    </div>
  );
}

/* ----------------------------------- Popover ----------------------------------- */
function useOutsideClose(ref, onClose) {
  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose?.();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [ref, onClose]);
}

/* ------------------------------------ Main ------------------------------------- */
export default function NBAInvokeButton({
  scope = "garden",
  intent = "decider",
  payload = null,
  label = "NBA",
  variant = "button", // "button" | "icon" | "ghost"
  size = "sm",        // "xs" | "sm" | "md"
  className = "",
  disabled = false,
  hotkey = "Alt+n",
  onApplied,          // (suggestion, actionResult) => void
}) {
  const settings = useSettingsStore ? useSettingsStore() : null;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [error, setError] = useState(null);
  const popRef = useRef(null);
  useOutsideClose(popRef, () => setOpen(false));

  const sizeClasses = {
    xs: "text-xs px-2 py-1",
    sm: "text-sm px-3 py-1.5",
    md: "text-sm px-3.5 py-2",
  }[size] || "text-sm px-3 py-1.5";

  const variantClasses =
    variant === "icon"
      ? "rounded-md border hover:bg-gray-50"
      : variant === "ghost"
      ? "rounded-md hover:bg-gray-50"
      : "rounded-lg border hover:bg-gray-50";

  const hotkeyLabel = (hotkey || "").replace("+", " + ");

  const ask = async () => {
    if (disabled || busy) return;
    setBusy(true);
    setError(null);

    const convo = {
      id: uid(),
      scope,
      intent,
      payload: payload || {},
      context: {
        // Send a light context for better NBA prompts
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        location: settings?.location || settings?.profile?.location || null,
        frost: settings?.garden?.frost || null,
        ui: { page: window.location.pathname, hash: window.location.hash || "" },
      },
    };

    emit("nba.requested", convo);

    try {
      // Preferred: synchronous invoke that returns suggestions
      let res = null;
      if (automation?.invoke) {
        res = await automation.invoke("nba.suggest", convo);
      }

      // Fallback: wait for an event response within 300ms
      if (!res) {
        res = await new Promise((resolve) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true;
              resolve(null);
            }
          }, 300);
          const handler = (e) => {
            const d = e.detail || {};
            if (d?.scope === scope && d?.intent === intent) {
              if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(d);
              }
            }
          };
          window.addEventListener("nba.suggestions", handler, { once: true });
        });
      }

      const list = normalizeSuggestions(res);
      setSuggestions(list);
      setOpen(true);
      emit("ui.panel.opened", { id: "nba.popover", scope, intent, count: list.length });
      if (!list.length) setError("No suggestions right now. Try adjusting filters or context.");
    } catch (e) {
      console.error(e);
      setError("NBA failed. Please try again.");
      emit("ui.toast", { kind: "error", message: "NBA failed." });
    } finally {
      setBusy(false);
    }
  };

  const apply = async (sug) => {
    // Apply action via GardenQueueManager or automation.emit
    const action = sug.action;
    if (!action) {
      emit("ui.toast", { kind: "info", message: "No direct action for this suggestion." });
      return;
    }
    try {
      if (GardenQueueManager?.queue) {
        GardenQueueManager.queue(action);
      } else {
        emit("planner.action.simulated", action);
      }
      emit("ui.toast", { kind: "success", message: "Applied." });
      emit("ui.undo", {
        message: "Action applied.",
        actionLabel: "Undo",
        action: { type: "planner.undo", payload: { from: action } },
      });
      onApplied?.(sug, { ok: true });
      // Keep popover open so user can apply multiple; or close on plan actions:
      if ((action.type || "").startsWith("planner.")) setOpen(false);
    } catch (e) {
      console.error(e);
      emit("ui.toast", { kind: "error", message: "Apply failed." });
      onApplied?.(sug, { ok: false, error: e });
    }
  };

  const preview = (sug) => {
    const p = sug.preview;
    if (!p) {
      emit("ui.toast", { kind: "info", message: "No preview available." });
      return;
    }
    emit("ui.preview.request", { ...p, meta: { from: "NBAInvokeButton", scope, intent } });
  };

  const explain = (sug) => {
    const msg = sug.explain || "No explanation provided.";
    emit("ui.toast", { kind: "info", message: msg });
  };

  // Keyboard accelerator (scoped to page, not global if inputs focused)
  useEffect(() => {
    if (!hotkey) return;
    const [mod, keyRaw] = hotkey.toLowerCase().split("+");
    const wantedKey = (keyRaw || "").trim();
    const handler = (e) => {
      const isEditable =
        ["INPUT", "TEXTAREA"].includes(e.target?.tagName) || e.target?.isContentEditable;
      if (isEditable) return;
      const pass =
        (mod === "alt" ? e.altKey : mod === "ctrl" ? e.ctrlKey : mod === "meta" ? e.metaKey : false) &&
        e.key.toLowerCase() === wantedKey;
      if (pass) {
        e.preventDefault();
        ask();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [hotkey]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ------------------------------------ UI ------------------------------------- */
  return (
    <div className={`relative inline-block ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        className={`${variantClasses} ${sizeClasses} inline-flex items-center gap-1 disabled:opacity-50`}
        onClick={ask}
        disabled={disabled || busy}
        title={`Next Best Action (${hotkeyLabel})`}
        aria-haspopup="menu"
        aria-expanded={open ? "true" : "false"}
      >
        {/* Minimal icon (sparkles) */}
        <span aria-hidden>✨</span>
        {variant !== "icon" && <span>{busy ? "Thinking…" : label}</span>}
      </button>

      {/* Popover */}
      {open && (
        <div
          ref={popRef}
          className="absolute right-0 mt-2 w-[22rem] max-h-[70vh] overflow-auto rounded-xl border bg-white shadow-xl z-30"
          role="menu"
          aria-label="NBA suggestions"
        >
          <div className="p-3 border-b">
            <div className="text-sm font-semibold text-gray-800">Suggestions</div>
            <div className="text-xs text-gray-500">
              Scope: <b>{scope}</b> • Intent: <b>{intent}</b>
            </div>
          </div>

          {error ? (
            <div className="p-3 text-sm text-red-700 bg-red-50">{error}</div>
          ) : null}

          {(!suggestions || !suggestions.length) && !error ? (
            <div className="p-3 text-sm text-gray-500">No suggestions right now.</div>
          ) : (
            <ul className="p-2">
              {suggestions.map((s) => (
                <li key={s.id} className="p-2 rounded-lg hover:bg-gray-50">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium text-gray-800">{s.label}</div>
                      {s.detail ? (
                        <div className="text-xs text-gray-600">{s.detail}</div>
                      ) : null}
                    </div>
                    <ConfidenceBar v={s.confidence} />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-md border px-2.5 py-1 text-xs hover:bg-gray-50"
                      onClick={() => apply(s)}
                      title="Apply this action"
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className="rounded-md border px-2.5 py-1 text-xs hover:bg-gray-50"
                      onClick={() => preview(s)}
                      title="Preview without applying"
                    >
                      Preview
                    </button>
                    <button
                      type="button"
                      className="rounded-md border px-2.5 py-1 text-xs hover:bg-gray-50"
                      onClick={() => explain(s)}
                      title="Why this?"
                    >
                      Explain
                    </button>
                    <span className="ml-auto inline-block text-[10px] px-2 py-0.5 rounded-full border text-gray-600">
                      {s.kind}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="p-2 border-t flex items-center justify-between">
            <button
              type="button"
              className="rounded-md border px-2.5 py-1 text-xs hover:bg-gray-50"
              onClick={() => {
                emit("nba.feedback.request", { scope, intent, items: suggestions });
              }}
            >
              Give feedback
            </button>
            <button
              type="button"
              className="rounded-md border px-2.5 py-1 text-xs hover:bg-gray-50"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

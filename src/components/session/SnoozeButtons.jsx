/* eslint-disable no-console */
// src/components/session/SnoozeButtons.jsx
import React, { useMemo, useState, Suspense } from "react";

/* ------------------------------ Design tokens ------------------------------ */
const cx = (...c) => c.filter(Boolean).join(" ");
const WRAP = "inline-flex items-center gap-1.5";
const BTN =
  "inline-flex items-center gap-1 rounded-2xl px-2.5 py-1.5 text-xs font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:
    "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-gray-700";

/* ----------------------------- Defensive imports ---------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch (_) {}

let useFavoriteSessions = null;
try {
  const mod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions = mod?.useFavoriteSessions || mod?.default || null;
} catch (_) {}

let SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(() =>
    import("@/components/session/SaveSessionModal.jsx")
  );
} catch (_) {}

/* ---------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    AlarmPlus: L.AlarmPlus,
    Clock: L.Clock3,
    BellOff: L.BellOff,
    More: L.MoreHorizontal,
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    Check: L.Check,
    ChevronDown: L.ChevronDown,
  };
} catch (_) {
  I = {
    AlarmPlus: () => <span>⏰</span>,
    Clock: () => <span>🕒</span>,
    BellOff: () => <span>🔕</span>,
    More: () => <span>⋯</span>,
    Star: () => <span>★</span>,
    StarOff: () => <span>☆</span>,
    Save: () => <span>💾</span>,
    Check: () => <span>✔</span>,
    ChevronDown: () => <span>▾</span>,
  };
}

/* ---------------------------------- Utils ---------------------------------- */
function toastSafe(message, variant = "success") {
  try {
    eventBus.emit("ui.toast", { message, variant });
  } catch (_) {
    if (variant === "error") console.warn(message);
    else console.log(message);
  }
}

/* -------------------------------- Component -------------------------------- */
/**
 * SnoozeButtons
 * ---------------------------------------------------------------------------
 * Compact controls to snooze/dismiss a *fired item* (alarm/timer/step).
 * Emits canonical events to your orchestrator and also session-scoped events
 * when a sessionId is provided.
 *
 * Props:
 *  - domain: "meals"|"garden"|"animals"|"cleaning"|...
 *  - itemId: string (alarm/timer/step id that fired)  **required**
 *  - sessionId?: string (if this fired item belongs to a session)
 *  - sessionTitle?: string (pretty name for Save/Favorite)
 *  - presets?: string[] (offsets like ["+5m","+10m","+30m"])
 *  - showFavorite?: boolean (default true) — favorite THIS session (not plan)
 *  - showSave?: boolean (default true) — save session (uses modal if present)
 *  - className?: string
 *  - compact?: boolean
 */
export default function SnoozeButtons({
  domain = "meals",
  itemId,
  sessionId = null,
  sessionTitle = "My Session",
  presets = ["+5m", "+10m", "+30m"],
  showFavorite = true,
  showSave = true,
  className = "",
  compact = false,
}) {
  const [saveOpen, setSaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Session favorites (separate from plans)
  const favApi = useFavoriteSessions ? useFavoriteSessions(domain) : null;
  const isFavInit = !!(sessionId && favApi?.isFavorite?.(sessionId));
  const [isFav, setIsFav] = useState(isFavInit);

  const toggleFavoriteSession = async () => {
    if (!sessionId) {
      toastSafe("No session to favorite.", "error");
      return;
    }
    try {
      if (favApi?.toggleFavorite) {
        const next = await favApi.toggleFavorite(sessionId, {
          id: sessionId,
          title: sessionTitle,
          domain,
        });
        setIsFav(!!next);
      } else {
        const next = !isFav;
        setIsFav(next);
        eventBus.emit("session.favorite.toggled", {
          domain,
          sessionId,
          next,
          meta: { title: sessionTitle },
          source: "SnoozeButtons",
        });
      }
      toastSafe(
        isFav
          ? "Removed from favorite sessions."
          : "Added to favorite sessions."
      );
    } catch (e) {
      console.warn("[SnoozeButtons] favorite toggle failed", e);
      toastSafe("Could not update favorite sessions.", "error");
    }
  };

  const doSnooze = (offset) => {
    if (!itemId) {
      toastSafe("Missing item id.", "error");
      return;
    }
    setBusy(true);
    try {
      // Fired-item level (generic)
      eventBus.emit?.("fireditem.snooze.requested", {
        domain,
        itemId,
        offset,
        sessionId: sessionId || undefined,
        source: "SnoozeButtons",
      });
      // Session-scoped hint (optional)
      if (sessionId) {
        eventBus.emit?.("session.snooze.requested", {
          domain,
          sessionId,
          itemId,
          offset,
          source: "SnoozeButtons",
        });
      }
      toastSafe(`Snoozed ${offset}.`);
    } finally {
      setBusy(false);
    }
  };

  const dismiss = () => {
    if (!itemId) return;
    setBusy(true);
    try {
      eventBus.emit?.("fireditem.dismiss.requested", {
        domain,
        itemId,
        sessionId: sessionId || undefined,
        source: "SnoozeButtons",
      });
      if (sessionId) {
        eventBus.emit?.("session.alert.dismissed", {
          domain,
          sessionId,
          itemId,
          source: "SnoozeButtons",
        });
      }
      toastSafe("Dismissed.");
    } finally {
      setBusy(false);
    }
  };

  const customSnooze = async () => {
    const v = prompt("Snooze for how many minutes?", "15");
    if (!v) return;
    const n = Number(String(v).trim());
    if (!Number.isFinite(n) || n <= 0) {
      toastSafe("Enter a positive number of minutes.", "error");
      return;
    }
    doSnooze(`+${Math.round(n)}m`);
  };

  const openSaveSession = () => {
    if (!sessionId) {
      toastSafe("No active session to save.", "error");
      return;
    }
    setSaveOpen(true);
    eventBus.emit?.("session.save.modal.opened", {
      domain,
      sessionId,
      source: "SnoozeButtons",
    });
  };

  return (
    <div
      className={cx(WRAP, compact && "gap-1", className)}
      role="group"
      aria-label="Snooze controls"
    >
      {/* Quick snooze chips */}
      {presets.slice(0, 3).map((off) => (
        <button
          key={off}
          type="button"
          className={cx(BTN, VAR.subtle, compact && "px-2 py-1")}
          onClick={() => doSnooze(off)}
          disabled={busy}
          aria-label={`Snooze ${off.replace("+", "plus ")}`}
        >
          <I.AlarmPlus className="h-3.5 w-3.5" />
          <span>{off}</span>
        </button>
      ))}

      {/* Custom & Dismiss */}
      <details className="relative">
        <summary
          className={cx(
            BTN,
            VAR.ghost,
            "cursor-pointer list-none [&::-webkit-details-marker]:hidden",
            compact && "px-2 py-1"
          )}
        >
          <I.More className="h-3.5 w-3.5" />
          {!compact && <span>More</span>}
        </summary>
        <div className="absolute right-0 z-20 mt-2 min-w-[14rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
          <MenuItem
            onClick={customSnooze}
            icon={<I.Clock className="h-4 w-4" />}
            label="Custom snooze…"
          />
          <div className="h-px bg-gray-100" />
          <MenuItem
            onClick={dismiss}
            icon={<I.BellOff className="h-4 w-4" />}
            label="Dismiss"
          />
          {(showFavorite || showSave) && <div className="h-px bg-gray-100" />}
          {showFavorite && (
            <MenuItem
              onClick={toggleFavoriteSession}
              icon={
                isFav ? (
                  <I.Star className="h-4 w-4 text-amber-500" />
                ) : (
                  <I.StarOff className="h-4 w-4" />
                )
              }
              label={isFav ? "Unfavorite session" : "Favorite session"}
            />
          )}
          {showSave && (
            <MenuItem
              onClick={openSaveSession}
              icon={<I.Save className="h-4 w-4" />}
              label="Save session…"
            />
          )}
        </div>
      </details>

      {/* Save Session modal (lazy preferred) */}
      {saveOpen &&
        (SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={saveOpen}
              onClose={() => setSaveOpen(false)}
              defaultTitle={sessionTitle}
              domain={domain}
              sessionId={sessionId}
              onSaved={(saved) => {
                eventBus.emit?.("session.saved", {
                  from: "SnoozeButtons",
                  saved,
                });
                toastSafe("Session saved.");
                setSaveOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={domain}
            sessionId={sessionId}
            defaultTitle={sessionTitle}
            onClose={() => setSaveOpen(false)}
            onSaved={(saved) => {
              eventBus.emit?.("session.saved", {
                from: "SnoozeButtons",
                saved,
              });
              toastSafe("Session saved.");
              setSaveOpen(false);
            }}
          />
        ))}
    </div>
  );
}

/* -------------------------------- Subcomponents ----------------------------- */
function MenuItem({ onClick, label, icon = null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-50 flex items-center gap-2"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/* ------------------------------ Inline Save modal --------------------------- */
function InlineSaveSession({
  domain,
  sessionId,
  defaultTitle,
  onClose,
  onSaved,
}) {
  const [name, setName] = useState(defaultTitle || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!sessionId) {
      toastSafe("No active session to save.", "error");
      return;
    }
    setBusy(true);
    try {
      const payload = { id: sessionId, domain, title: name, notes };
      eventBus.emit?.("session.save.requested", {
        payload,
        source: "SnoozeButtons",
      });
      onSaved?.(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Save session"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">
            Save Session
          </h3>
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Title
        </label>
        <input
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Session title"
        />

        <label className="mt-4 block text-sm font-medium text-gray-700">
          Notes
        </label>
        <textarea
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What should future-you remember?"
        />

        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={onClose}>
            Cancel
          </button>
          <button
            className={cx(BTN, VAR.primary)}
            onClick={submit}
            disabled={busy}
          >
            <I.Check className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

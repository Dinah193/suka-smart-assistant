/* eslint-disable no-console */
// src/components/session/SessionStartButton.jsx
import React, { useEffect, useMemo, useState, Suspense } from "react";

/* ------------------------------ Design tokens ------------------------------ */
const cx = (...c) => c.filter(Boolean).join(" ");
const BTN =
  "inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium shadow-sm transition active:translate-y-px focus:outline-none focus:ring-2 focus:ring-offset-2";
const VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle: "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
};
const SIZE = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-base",
};
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-0.5 text-[11px] font-medium text-gray-700";

/* ----------------------------- Defensive imports ---------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch (_) {}

let automation = null;
try {
  const a = require("@/services/automation/runtime");
  automation = a?.automation || a?.default || null;
} catch (_) {}

let useFavoriteSessions = null;
try {
  const mod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions = mod?.useFavoriteSessions || mod?.default || null;
} catch (_) {}

let SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(() => import("@/components/sessions/SaveSessionModal.jsx"));
} catch (_) {}

/* ----------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Play: L.Play,
    Sparkles: L.Sparkles,
    Clock: L.Clock3,
    Calendar: L.Calendar,
    AlarmPlus: L.AlarmPlus,
    More: L.MoreHorizontal,
    AlertTriangle: L.AlertTriangle,
    Shield: L.ShieldCheck,
    Check: L.Check,
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    X: L.X,
  };
} catch (_) {
  I = {
    Play: () => <span>▶</span>,
    Sparkles: () => <span>✦</span>,
    Clock: () => <span>🕒</span>,
    Calendar: () => <span>📅</span>,
    AlarmPlus: () => <span>⏰</span>,
    More: () => <span>⋯</span>,
    AlertTriangle: () => <span>⚠</span>,
    Shield: () => <span>🛡</span>,
    Check: () => <span>✔</span>,
    Star: () => <span>★</span>,
    StarOff: () => <span>☆</span>,
    Save: () => <span>💾</span>,
    X: () => <span>✕</span>,
  };
}

/* ----------------------------------- Utils ---------------------------------- */
function toastSafe(message, variant = "success") {
  try {
    eventBus.emit("ui.toast", { message, variant });
  } catch (_) {
    if (variant === "error") console.warn(message);
    else console.log(message);
  }
}

const riskIcon = (k) => {
  switch (k) {
    case "inventory":
      return <span className="inline-block h-3.5 w-3.5">🛒</span>;
    case "weather":
      return <span className="inline-block h-3.5 w-3.5">⛈</span>;
    case "time":
      return <span className="inline-block h-3.5 w-3.5">🕒</span>;
    case "appliance":
      return <span className="inline-block h-3.5 w-3.5">🥶</span>;
    default:
      return <span className="inline-block h-3.5 w-3.5">⚠</span>;
  }
};

const safeFile = (name = "session") =>
  String(name).toLowerCase().replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-");

/* ---------------------------------- Component --------------------------------- */
/**
 * SessionStartButton
 * -----------------------------------------------------------------------------
 * A compact, intelligent start button that:
 *  - Runs preflight checks (inventory/weather/time/appliances) & shows a confirmation
 *  - Starts immediately OR schedules for later (Start in 5m / 10m / custom time)
 *  - Lets users favorite/save THEIR sessions (separate from plans)
 *  - Emits your canonical events and degrades gracefully
 *
 * Props:
 *  - domain: string                               (e.g. "meals"|"garden"|"animals"|"cleaning")
 *  - sessionId?: string                           (if omitted, listeners can attach one on start)
 *  - title?: string                               (for favorite/save UX)
 *  - variant?: "primary"|"subtle"|"ghost"         (default "primary")
 *  - size?: "sm"|"md"|"lg"                        (default "md")
 *  - fullWidth?: boolean                           (default false)
 *  - showMenu?: boolean                            (default true)  // split menu with extra actions
 *  - showFavorite?: boolean                         (default true)
 *  - showSave?: boolean                             (default true)
 *  - className?: string
 *  - onStarted?: (payload) => void
 */
export default function SessionStartButton({
  domain = "meals",
  sessionId: sessionIdProp = null,
  title = "Session",
  variant = "primary",
  size = "md",
  fullWidth = false,
  showMenu = true,
  showFavorite = true,
  showSave = true,
  className = "",
  onStarted = () => {},
}) {
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionId, setSessionId] = useState(sessionIdProp);
  const [preflight, setPreflight] = useState({ ok: true, guards: [] }); // {ok:boolean, guards:[{kind,label,detail}]}
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  /* ------------------------------ Session favorites ------------------------------ */
  const favApi = useFavoriteSessions ? useFavoriteSessions(domain) : null;
  const [isFav, setIsFav] = useState(() => (!!sessionId && !!favApi?.isFavorite?.(sessionId)) || false);

  useEffect(() => {
    if (favApi && sessionId) setIsFav(!!favApi.isFavorite?.(sessionId));
  }, [favApi, sessionId]);

  const toggleFavoriteSession = async () => {
    try {
      const id = sessionId || "__pending__";
      if (favApi?.toggleFavorite) {
        const next = await favApi.toggleFavorite(id, { id, title, domain });
        setIsFav(!!next);
      } else {
        const next = !isFav;
        setIsFav(next);
        eventBus.emit("session.favorite.toggled", {
          domain,
          sessionId: id,
          next,
          meta: { title },
          source: "SessionStartButton",
        });
      }
      toastSafe(isFav ? "Removed from favorite sessions." : "Added to favorite sessions.");
    } catch (e) {
      console.warn("[SessionStartButton] favorite toggle failed", e);
      toastSafe("Could not update favorite sessions.", "error");
    }
  };

  /* ---------------------------------- Preflight ---------------------------------- */
  const runPreflight = async () => {
    // Let automation/runtime do a proper readiness check; fall back to OK
    try {
      setBusy(true);
      const result =
        (await automation?.preflight?.check?.({ domain, sessionId })) ||
        { ok: true, guards: [] };
      setPreflight(result);
      setBusy(false);
      return result;
    } catch (e) {
      console.warn("[SessionStartButton] preflight failed (soft-OK)", e);
      setBusy(false);
      return { ok: true, guards: [] };
    }
  };

  /* ----------------------------------- Start ----------------------------------- */
  const doStartNow = async () => {
    const pf = await runPreflight();
    if (!pf.ok && (pf.guards || []).length > 0) {
      setConfirmOpen(true);
      return;
    }
    startEmit();
  };

  const startEmit = () => {
    setBusy(true);
    try {
      eventBus.emit?.("session.start.requested", {
        domain,
        sessionId: sessionId || undefined,
        source: "SessionStartButton",
        reply: (s) => {
          if (s?.id && !sessionId) setSessionId(s.id);
          onStarted?.(s || { domain, sessionId: s?.id || sessionId });
        },
      });
      toastSafe("Starting…");
    } finally {
      setBusy(false);
      setConfirmOpen(false);
      setMenuOpen(false);
    }
  };

  /* -------------------------------- Schedule -------------------------------- */
  const scheduleOffset = (offset = "+5m") => {
    setBusy(true);
    try {
      eventBus.emit?.("session.schedule.requested", {
        domain,
        offset,
        sessionId: sessionId || undefined,
        title,
        source: "SessionStartButton",
      });
      toastSafe(`Scheduled ${offset}.`);
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  };

  const scheduleAt = () => {
    const value = prompt("Start at (HH:MM, 24h)", "18:00");
    if (!value) return;
    const [hh, mm] = String(value).split(":").map((n) => Number(n));
    if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) {
      toastSafe("Enter a valid time like 18:00.", "error");
      return;
    }
    const now = new Date();
    const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
    if (when <= now) when.setDate(when.getDate() + 1); // tomorrow if time elapsed
    eventBus.emit?.("session.schedule.at.requested", {
      domain,
      atISO: when.toISOString(),
      sessionId: sessionId || undefined,
      title,
      source: "SessionStartButton",
    });
    toastSafe(`Scheduled for ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
    setMenuOpen(false);
  };

  /* -------------------------------- Save session ------------------------------- */
  const openSaveSession = () => {
    setSaveOpen(true);
    eventBus.emit?.("session.save.modal.opened", { domain, sessionId: sessionId || "__pending__", source: "SessionStartButton" });
  };

  /* ---------------------------------- Render ---------------------------------- */
  const classes = cx(
    BTN,
    VAR[variant] || VAR.primary,
    SIZE[size] || SIZE.md,
    fullWidth && "w-full justify-center",
    className
  );

  return (
    <div className="relative inline-flex items-stretch">
      {/* Primary start button */}
      <button
        type="button"
        className={classes}
        onClick={doStartNow}
        disabled={busy}
        aria-label="Start session"
        title="Start session"
      >
        <I.Play className="h-4 w-4" />
        <span>Start</span>
      </button>

      {/* Split menu for more actions */}
      {showMenu && (
        <details
          open={menuOpen}
          onToggle={(e) => setMenuOpen(e.currentTarget.open)}
          className="relative ml-1"
        >
          <summary
            className={cx(
              BTN,
              VAR.subtle,
              SIZE[size] || SIZE.md,
              "cursor-pointer list-none [&::-webkit-details-marker]:hidden"
            )}
            aria-label="More start options"
            title="More start options"
          >
            <I.More className="h-4 w-4" />
          </summary>

          <div className="absolute right-0 z-50 mt-2 min-w-[16rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
            <MenuItem onClick={doStartNow} icon={<I.Sparkles className="h-4 w-4" />} label="Start now" />
            <MenuItem onClick={() => scheduleOffset("+5m")} icon={<I.AlarmPlus className="h-4 w-4" />} label="Start in +5m" />
            <MenuItem onClick={() => scheduleOffset("+10m")} icon={<I.AlarmPlus className="h-4 w-4" />} label="Start in +10m" />
            <MenuItem onClick={() => scheduleOffset("+30m")} icon={<I.AlarmPlus className="h-4 w-4" />} label="Start in +30m" />
            <MenuItem onClick={scheduleAt} icon={<I.Calendar className="h-4 w-4" />} label="Start at…" />
            <div className="h-px bg-gray-100" />

            {showFavorite && (
              <MenuItem
                onClick={toggleFavoriteSession}
                icon={isFav ? <I.Star className="h-4 w-4 text-amber-500" /> : <I.StarOff className="h-4 w-4" />}
                label={isFav ? "Unfavorite session" : "Favorite session"}
              />
            )}
            {showSave && (
              <MenuItem onClick={openSaveSession} icon={<I.Save className="h-4 w-4" />} label="Save session…" />
            )}
          </div>
        </details>
      )}

      {/* Preflight confirm modal */}
      {confirmOpen && (
        <ConfirmPreflight
          title={title}
          preflight={preflight}
          onCancel={() => setConfirmOpen(false)}
          onStart={startEmit}
        />
      )}

      {/* Save session modal (lazy preferred) */}
      {saveOpen && (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={saveOpen}
              onClose={() => setSaveOpen(false)}
              defaultTitle={title}
              domain={domain}
              sessionId={sessionId || "__pending__"}
              onSaved={(saved) => {
                eventBus.emit?.("session.saved", { from: "SessionStartButton", saved });
                toastSafe("Session saved.");
                setSaveOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={domain}
            sessionId={sessionId || "__pending__"}
            defaultTitle={title}
            onClose={() => setSaveOpen(false)}
            onSaved={(saved) => {
              eventBus.emit?.("session.saved", { from: "SessionStartButton", saved });
              toastSafe("Session saved.");
              setSaveOpen(false);
            }}
          />
        )
      )}
    </div>
  );
}

/* -------------------------------- Subcomponents ------------------------------ */
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

function ConfirmPreflight({ title, preflight, onCancel, onStart }) {
  const guards = Array.isArray(preflight?.guards) ? preflight.guards : [];
  const ok = !!preflight?.ok;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Preflight confirmation"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    >
      <div className="w-[96vw] max-w-lg overflow-hidden rounded-3xl border border-gray-200 bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-gray-200 bg-gradient-to-r from-white to-gray-50 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-gray-900">Ready to start “{title}”?</h3>
            <p className="mt-0.5 text-xs text-gray-600">
              {ok ? "All checks passed." : "We found a few things to consider before starting."}
            </p>
          </div>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={onCancel} aria-label="Close">
            <I.X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          {guards.length === 0 ? (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-3 text-emerald-900 text-sm">
              <div className="flex items-center gap-2">
                <I.Check className="h-4 w-4" />
                <span>Looks good! You can start now.</span>
              </div>
            </div>
          ) : (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
              <div className="mb-2 flex items-center gap-2 text-amber-800">
                <I.AlertTriangle className="h-4 w-4" />
                <span className="text-sm font-medium">Heads up</span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {guards.slice(0, 6).map((g, i) => (
                  <span key={i} className={CHIP} title={g.detail || g.label}>
                    {riskIcon(g.kind)}
                    <span>{g.label}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button className={cx(BTN, VAR.subtle)} onClick={onCancel}>
            Cancel
          </button>
          <button className={cx(BTN, VAR.primary)} onClick={onStart}>
            <I.Play className="h-4 w-4" />
            Start now
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Inline Save modal --------------------------- */
function InlineSaveSession({ domain, sessionId, defaultTitle, onClose, onSaved }) {
  const [name, setName] = useState(defaultTitle || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const payload = { id: sessionId, domain, title: name, notes };
      eventBus.emit?.("session.save.requested", { payload, source: "SessionStartButton" });
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
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Save Session</h3>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={onClose} aria-label="Close">
            <I.X className="h-4 w-4" />
          </button>
        </div>

        <label className="mt-4 block text-sm font-medium text-gray-700">Title</label>
        <input
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Session title"
        />

        <label className="mt-4 block text-sm font-medium text-gray-700">Notes</label>
        <textarea
          className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="What should future-you remember?"
        />

        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={onClose}>Cancel</button>
          <button className={cx(BTN, VAR.primary)} onClick={submit} disabled={busy}>
            <I.Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

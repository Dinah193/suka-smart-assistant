/* eslint-disable no-console */
// src/components/session/PauseSafetyModal.jsx
import React, { useEffect, useMemo, useState, Suspense } from "react";

/* ------------------------------ Design tokens ------------------------------ */
const cx = (...c) => c.filter(Boolean).join(" ");
const WRAP =
  "fixed inset-0 z-50 grid place-items-center bg-black/40 backdrop-blur supports-[backdrop-filter]:bg-black/30";
const CARD =
  "w-[96vw] max-w-2xl rounded-3xl border border-gray-200 bg-white shadow-2xl overflow-hidden";
const BTN =
  "inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle: "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  warn: "bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-gray-700";
const FIELD =
  "w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600";

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

/* ---------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Pause: L.Pause,
    Play: L.Play,
    Shield: L.ShieldCheck,
    Clock: L.Clock3,
    Info: L.Info,
    Alert: L.AlertTriangle,
    CloudLightning: L.CloudLightning,
    ShoppingCart: L.ShoppingCart,
    ThermometerSnowflake: L.ThermometerSnowflake,
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    Plus: L.Plus,
    AlarmPlus: L.AlarmPlus,
    Download: L.Download,
    X: L.X,
  };
} catch (_) {
  I = {
    Pause: () => <span>⏸</span>,
    Play: () => <span>▶</span>,
    Shield: () => <span>🛡</span>,
    Clock: () => <span>🕒</span>,
    Info: () => <span>ℹ</span>,
    Alert: () => <span>⚠</span>,
    CloudLightning: () => <span>⛈</span>,
    ShoppingCart: () => <span>🛒</span>,
    ThermometerSnowflake: () => <span>🥶</span>,
    Star: () => <span>★</span>,
    StarOff: () => <span>☆</span>,
    Save: () => <span>💾</span>,
    Plus: () => <span>＋</span>,
    AlarmPlus: () => <span>⏰</span>,
    Download: () => <span>⬇</span>,
    X: () => <span>✕</span>,
  };
}

/* ---------------------------------- Utils ---------------------------------- */
const prettyMMSS = (sec = 0) => {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
};
function toastSafe(message, variant = "success") {
  try {
    eventBus.emit("ui.toast", { message, variant });
  } catch (_) {
    if (variant === "error") console.warn(message);
    else console.log(message);
  }
}
const safeFile = (name = "session") =>
  String(name).toLowerCase().replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-");

/* -------------------------------- Component -------------------------------- */
/**
 * PauseSafetyModal
 * -----------------------------------------------------------------------------
 * A sticky, inviting modal that appears when pausing. Summarizes current step,
 * time left, risks, and offers:
 *  - Continue (resume)
 *  - Freeze (hard pause timers)
 *  - Safety Pause (pause + safety actions: power-down/lock/alerts)
 *  - Quick actions: +5m extend, Snooze +10m, Export snapshot, Favorite/Save Session
 *
 * Props:
 *  - isOpen: boolean
 *  - onClose: () => void
 *  - domain: "meals"|"garden"|"animals"|"cleaning"|...
 *  - sessionId: string
 *  - step?: { id, title, notes, remainingSec, idx, total }
 *  - etaISO?: string
 *  - guards?: [{kind:"inventory"|"weather"|"time"|"appliance"|..., label, detail}]
 *  - sessionTitle?: string
 */
export default function PauseSafetyModal({
  isOpen,
  onClose,
  domain = "meals",
  sessionId,
  step = null,
  etaISO = null,
  guards = [],
  sessionTitle = "Active Session",
}) {
  const [freezeNote, setFreezeNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  /* --------------------------- Favorite THIS SESSION -------------------------- */
  const favApi = useFavoriteSessions ? useFavoriteSessions(domain) : null;
  const [isFav, setIsFav] = useState(() => (!!sessionId && !!favApi?.isFavorite?.(sessionId)) || false);
  useEffect(() => {
    if (favApi && sessionId) setIsFav(!!favApi.isFavorite?.(sessionId));
  }, [favApi, sessionId]);

  const toggleFavorite = async () => {
    if (!sessionId) return;
    try {
      if (favApi?.toggleFavorite) {
        const next = await favApi.toggleFavorite(sessionId, { id: sessionId, title: sessionTitle, domain });
        setIsFav(!!next);
      } else {
        const next = !isFav;
        setIsFav(next);
        eventBus.emit("session.favorite.toggled", {
          domain,
          sessionId,
          next,
          meta: { title: sessionTitle },
          source: "PauseSafetyModal",
        });
      }
      toastSafe(isFav ? "Removed from favorite sessions." : "Added to favorite sessions.");
    } catch (e) {
      console.warn("[PauseSafetyModal] favorite toggle failed", e);
      toastSafe("Could not update favorite sessions.", "error");
    }
  };

  /* --------------------------------- Actions -------------------------------- */
  const resume = () => {
    eventBus.emit?.("session.start.requested", { domain, sessionId, source: "PauseSafetyModal" });
    onClose?.();
  };

  const freeze = () => {
    eventBus.emit?.("session.pause.requested", {
      domain,
      sessionId,
      reason: "user",
      mode: "freeze", // listeners can interpret as hard pause (stop timers)
      note: freezeNote || undefined,
      source: "PauseSafetyModal",
    });
    onClose?.();
  };

  const safetyPause = () => {
    // Ask orchestrator to apply safety policies (power-down, lock, alerts, timers paused)
    eventBus.emit?.("session.pause.requested", {
      domain,
      sessionId,
      reason: "safety",
      mode: "safety",
      note: freezeNote || undefined,
      options: { applySafetyPolicies: true },
      source: "PauseSafetyModal",
    });
    // Optional: downstream listeners act on these granular intents
    eventBus.emit?.("safety.actions.requested", {
      domain,
      sessionId,
      intents: ["appliance.powerdown", "hazard.lockout", "notify.user"],
      source: "PauseSafetyModal",
    });
    onClose?.();
  };

  const extend = (offset = "+5m") => {
    eventBus.emit?.("session.extend.requested", { domain, sessionId, offset, stepId: step?.id, source: "PauseSafetyModal" });
    toastSafe(`Extended ${offset}.`);
  };

  const snooze = (offset = "+10m") => {
    eventBus.emit?.("session.snooze.requested", { domain, sessionId, offset, source: "PauseSafetyModal" });
    toastSafe(`Snoozed ${offset}.`);
  };

  const saveSession = () => {
    if (!sessionId) {
      toastSafe("No active session to save.", "error");
      return;
    }
    setSaveOpen(true);
    eventBus.emit?.("session.save.modal.opened", { domain, sessionId, source: "PauseSafetyModal" });
  };

  const exportSnapshot = () => {
    if (!sessionId) return;
    setSaving(true);
    try {
      const fallback = { id: sessionId, domain, title: sessionTitle, step, etaISO };
      eventBus.emit?.("session.snapshot.requested", {
        sessionId,
        domain,
        source: "PauseSafetyModal",
        reply: (snapshot) => {
          const data = snapshot || fallback;
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${safeFile(sessionTitle)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          toastSafe("Downloaded session snapshot.");
          setSaving(false);
        },
      });
      // If no listener responds in your app, it still downloads via fallback after ~tick
      setTimeout(() => {
        if (saving) {
          const blob = new Blob([JSON.stringify(fallback, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${safeFile(sessionTitle)}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          setSaving(false);
        }
      }, 350);
    } catch (e) {
      console.warn("[PauseSafetyModal] export failed", e);
      toastSafe("Export failed.", "error");
      setSaving(false);
    }
  };

  /* --------------------------------- Derived -------------------------------- */
  const timeLeft = prettyMMSS(step?.remainingSec ?? 0);
  const idx = step?.idx ?? 0;
  const total = step?.total ?? 0;
  const eta = useMemo(() => {
    if (!etaISO) return null;
    try {
      const d = new Date(etaISO);
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    } catch {
      return null;
    }
  }, [etaISO]);

  const riskIcon = (k) => {
    switch (k) {
      case "inventory": return <I.ShoppingCart className="h-3.5 w-3.5" />;
      case "weather": return <I.CloudLightning className="h-3.5 w-3.5" />;
      case "time": return <I.Clock className="h-3.5 w-3.5" />;
      case "appliance": return <I.ThermometerSnowflake className="h-3.5 w-3.5" />;
      default: return <I.Alert className="h-3.5 w-3.5" />;
    }
  };

  if (!isOpen) return null;

  return (
    <div className={WRAP} role="dialog" aria-modal="true" aria-label="Pause options">
      <div className={CARD}>
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200 bg-gradient-to-r from-white to-gray-50 px-5 py-4">
          <div className="min-w-0">
            <h3 className="truncate text-base sm:text-lg font-semibold text-gray-900">
              Pause Session
            </h3>
            <p className="mt-0.5 text-xs text-gray-600">
              Choose how you want to pause. You can freeze timers or activate safety policies.
            </p>
          </div>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={onClose} aria-label="Close">
            <I.X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          {/* Step + Time */}
          <div className="rounded-2xl border border-gray-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-3">
              <span className={CHIP}>
                <I.Clock className="h-3.5 w-3.5" />
                {timeLeft}
              </span>
              {total > 0 && (
                <span className={CHIP}>
                  <I.Info className="h-3.5 w-3.5" />
                  Step {Math.min(idx + 1, total)} / {total}
                </span>
              )}
              {eta && (
                <span className={CHIP}>
                  <I.Clock className="h-3.5 w-3.5" />
                  ETA {eta}
                </span>
              )}

              {/* Session favorite & save */}
              <div className="ml-auto flex items-center gap-2">
                <button
                  className={cx(BTN, VAR.ghost, "px-3")}
                  onClick={toggleFavorite}
                  aria-pressed={isFav}
                  title={isFav ? "Unfavorite session" : "Favorite session"}
                >
                  {isFav ? <I.Star className="h-4 w-4 text-amber-500" /> : <I.StarOff className="h-4 w-4" />}
                </button>
                <button className={cx(BTN, VAR.subtle)} onClick={saveSession}>
                  <I.Save className="h-4 w-4" />
                  <span>Save session</span>
                </button>
              </div>
            </div>

            <div className="mt-3">
              <p className="text-sm font-medium text-gray-900 truncate">{step?.title || sessionTitle}</p>
              {step?.notes && <p className="mt-1 text-sm text-gray-600 line-clamp-3">{step.notes}</p>}
            </div>
          </div>

          {/* Risks / Guards */}
          {guards?.length > 0 && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-amber-800">
                <I.Alert className="h-4 w-4" />
                <span className="text-sm font-medium">Heads up</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {guards.slice(0, 6).map((g, i) => (
                  <span key={i} className={CHIP} title={g.detail || g.label}>
                    {riskIcon(g.kind)}
                    <span>{g.label}</span>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Pause note */}
          <div>
            <label className="block text-sm font-medium text-gray-700">Add a note (optional)</label>
            <input
              className={FIELD}
              value={freezeNote}
              onChange={(e) => setFreezeNote(e.target.value)}
              placeholder="e.g., waiting for oven to preheat, dog needs out, etc."
            />
          </div>

          {/* Quick actions */}
          <div className="flex flex-wrap items-center gap-2">
            <button className={cx(BTN, VAR.ghost)} onClick={() => extend("+5m")}>
              <I.Plus className="h-4 w-4" />
              Extend +5m
            </button>
            <button className={cx(BTN, VAR.ghost)} onClick={() => snooze("+10m")}>
              <I.AlarmPlus className="h-4 w-4" />
              Snooze +10m
            </button>
            <button className={cx(BTN, VAR.ghost)} onClick={exportSnapshot} disabled={saving}>
              <I.Download className="h-4 w-4" />
              Export snapshot
            </button>
          </div>
        </div>

        {/* Footer actions */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
          <button className={cx(BTN, VAR.subtle)} onClick={resume}>
            <I.Play className="h-4 w-4" />
            Continue
          </button>
          <button className={cx(BTN, VAR.warn)} onClick={freeze}>
            <I.Pause className="h-4 w-4" />
            Freeze
          </button>
          <button className={cx(BTN, VAR.danger)} onClick={safetyPause}>
            <I.Shield className="h-4 w-4" />
            Safety Pause
          </button>
        </div>
      </div>

      {/* Save session modal (lazy preferred) */}
      {saveOpen && (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={saveOpen}
              onClose={() => setSaveOpen(false)}
              defaultTitle={sessionTitle}
              domain={domain}
              sessionId={sessionId}
              onSaved={(saved) => {
                eventBus.emit?.("session.saved", { from: "PauseSafetyModal", saved });
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
              eventBus.emit?.("session.saved", { from: "PauseSafetyModal", saved });
              toastSafe("Session saved.");
              setSaveOpen(false);
            }}
          />
        )
      )}
    </div>
  );
}

/* --------------------------------- Inline Save ------------------------------ */
function InlineSaveSession({ domain, sessionId, defaultTitle, onClose, onSaved }) {
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
      eventBus.emit?.("session.save.requested", { payload, source: "PauseSafetyModal" });
      onSaved?.(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={WRAP} role="dialog" aria-modal="true" aria-label="Save session">
      <div className={CARD}>
        <div className="flex items-center justify-between border-b border-gray-200 bg-white px-5 py-4">
          <h3 className="text-base font-semibold">Save Session</h3>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={onClose}><I.X className="h-4 w-4" /></button>
        </div>
        <div className="px-5 py-4">
          <label className="block text-sm font-medium text-gray-700">Title</label>
          <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} placeholder="Session title" />

          <label className="mt-4 block text-sm font-medium text-gray-700">Notes</label>
          <textarea className={cx(FIELD, "min-h-[96px]")} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What should future-you remember?" />
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-5 py-3">
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

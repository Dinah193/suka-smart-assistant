/* eslint-disable no-console */
// src/components/session/SessionBanner.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* ------------------------------ Style tokens ------------------------------ */
const cx = (...c) => c.filter(Boolean).join(" ");
const WRAP =
  "fixed bottom-0 left-0 right-0 z-40 border-t border-gray-200 bg-white/95 backdrop-blur supports-[backdrop-filter]:bg-white/80";
const INNER = "mx-auto max-w-7xl px-4 sm:px-6 lg:px-8";
const BTN =
  "inline-flex items-center gap-2 rounded-2xl px-3 sm:px-4 py-2 text-sm font-medium shadow-sm transition active:translate-y-px focus:outline-none focus:ring-2 focus:ring-offset-2";
const VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle: "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-gray-700";

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

/** FAVORITES — SESSIONS (not plans) */
let useFavoriteSessions = null;
try {
  const mod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions = mod?.useFavoriteSessions || mod?.default || null;
} catch (_) {}

/** SAVE SESSION modal (optional, modal-first) */
let SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(() => import("@/components/sessions/SaveSessionModal.jsx"));
} catch (_) {}

/* --------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Play: L.Play,
    Pause: L.Pause,
    Check: L.Check,
    Skip: L.SkipForward,
    Clock: L.Clock3,
    Plus: L.Plus,
    AlarmPlus: L.AlarmPlus,
    Calendar: L.Calendar,
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    Download: L.Download,
    ChevronUp: L.ChevronUp,
    ChevronDown: L.ChevronDown,
    AlertTriangle: L.AlertTriangle,
    CloudLightning: L.CloudLightning,
    ShoppingCart: L.ShoppingCart,
    ThermometerSnowflake: L.ThermometerSnowflake,
    Info: L.Info,
    MoreHorizontal: L.MoreHorizontal,
  };
} catch (_) {
  I = {
    Play: () => <span>▶</span>,
    Pause: () => <span>⏸</span>,
    Check: () => <span>✔</span>,
    Skip: () => <span>≫</span>,
    Clock: () => <span>🕒</span>,
    Plus: () => <span>＋</span>,
    AlarmPlus: () => <span>⏰</span>,
    Calendar: () => <span>📅</span>,
    Star: () => <span>★</span>,
    StarOff: () => <span>☆</span>,
    Save: () => <span>💾</span>,
    Download: () => <span>⬇</span>,
    ChevronUp: () => <span>▴</span>,
    ChevronDown: () => <span>▾</span>,
    AlertTriangle: () => <span>⚠</span>,
    CloudLightning: () => <span>⛈</span>,
    ShoppingCart: () => <span>🛒</span>,
    ThermometerSnowflake: () => <span>🥶</span>,
    Info: () => <span>ℹ</span>,
    MoreHorizontal: () => <span>⋯</span>,
  };
}

/* --------------------------------- Utils ---------------------------------- */
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

/* -------------------------------- Component -------------------------------- */
/**
 * SessionBanner — sticky banner showing current/next step & countdown.
 *
 * Props:
 *  - domain: "meals"|"garden"|"animals"|"cleaning"|...
 *  - sessionId?: string (optional; if omitted, will bind to the latest active session from events)
 *  - sessionTitle?: string (nice label for saving/favoriting)
 *  - collapsedDefault?: boolean
 */
export default function SessionBanner({
  domain = "meals",
  sessionId: sessionIdProp = null,
  sessionTitle: sessionTitleProp = null,
  collapsedDefault = false,
}) {
  const [collapsed, setCollapsed] = useState(collapsedDefault);

  /* ------------------------------- Session state ----------------------------- */
  const [sessionId, setSessionId] = useState(sessionIdProp);
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(null); // { id, title, notes, durationSec, remainingSec, idx, total }
  const [etaISO, setEtaISO] = useState(null);
  const [progressPct, setProgressPct] = useState(0);
  const [guards, setGuards] = useState([]); // [{kind, label, detail}]
  const [busy, setBusy] = useState(false);
  const [sessionMeta, setSessionMeta] = useState({ title: sessionTitleProp || "Active Session", description: "" });

  // internal ticking if orchestrator doesn't emit ticks
  const tickRef = useRef(null);

  /* --------------------------- Favorites (SESSIONS) -------------------------- */
  const favApi = useFavoriteSessions ? useFavoriteSessions(domain) : null;
  const [isFav, setIsFav] = useState(() => (!!sessionId && !!favApi?.isFavorite?.(sessionId)) || false);

  useEffect(() => {
    if (favApi && sessionId) {
      setIsFav(!!favApi.isFavorite?.(sessionId));
    }
  }, [favApi, sessionId]);

  const toggleFavoriteSession = async () => {
    if (!sessionId) {
      toastSafe("No active session to favorite.", "error");
      return;
    }
    try {
      if (favApi?.toggleFavorite) {
        const next = await favApi.toggleFavorite(sessionId, {
          id: sessionId,
          title: sessionMeta.title,
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
          meta: sessionMeta,
          source: "SessionBanner",
        });
      }
      toastSafe(isFav ? "Removed from favorite sessions." : "Added to favorite sessions.");
    } catch (e) {
      console.warn("[SessionBanner] toggle favorite session failed", e);
      toastSafe("Could not update favorite sessions.", "error");
    }
  };

  /* ----------------------------- Save Session UX ----------------------------- */
  const [saveOpen, setSaveOpen] = useState(false);
  const openSaveSession = () => {
    if (!sessionId) {
      toastSafe("No active session to save.", "error");
      return;
    }
    setSaveOpen(true);
    eventBus.emit?.("session.save.modal.opened", { domain, sessionId, source: "SessionBanner" });
  };

  /* -------------------------------- Subscriptions ---------------------------- */
  useEffect(() => {
    const onState = (payload) => {
      const s = payload?.session || payload;
      if (!s) return;

      if (!sessionIdProp) setSessionId(s.id);
      setActive(!!s.active);

      // Session label/meta
      const metaTitle =
        s.title ||
        s.planTitle || // orchestrator may pass-through
        sessionTitleProp ||
        (s.domain ? `${s.domain[0].toUpperCase()}${s.domain.slice(1)} Session` : "Active Session");
      setSessionMeta({
        title: metaTitle,
        description: s.description || s.notes || "",
      });

      // step summary
      const st = s.currentStep || s.nextStep || null;
      const index = st?.index ?? st?.idx ?? 0;
      const total = s.totalSteps ?? st?.total ?? 0;
      const pct = typeof s.progressPct === "number"
        ? s.progressPct
        : total > 0
          ? Math.round((index / total) * 100)
          : 0;

      setStep(
        st
          ? {
              id: st.id || `step:${index}`,
              title: st.title || "Next step",
              notes: st.notes || "",
              durationSec: st.durationSec ?? st.seconds ?? 0,
              remainingSec: st.remainingSec ?? st.remaining ?? st.durationSec ?? 0,
              idx: index,
              total,
            }
          : null
      );
      setProgressPct(Math.max(0, Math.min(100, pct)));

      // ETA
      setEtaISO(s.etaISO || null);
    };

    const onTick = (payload) => {
      if (payload?.sessionId && sessionId && payload.sessionId !== sessionId) return;
      if (typeof payload?.remainingSec === "number") {
        setStep((prev) => (prev ? { ...prev, remainingSec: payload.remainingSec } : prev));
      } else if (typeof payload?.stepRemainingSec === "number") {
        setStep((prev) => (prev ? { ...prev, remainingSec: payload.stepRemainingSec } : prev));
      }
      if (typeof payload?.progressPct === "number") setProgressPct(Math.max(0, Math.min(100, payload.progressPct)));
      if (payload?.etaISO) setEtaISO(payload.etaISO);
    };

    const onConflict = (p) => {
      const labelMap = {
        time: "Schedule conflict",
        appliance: "Appliance busy",
        weather: "Weather risk",
        biohazard: "Safety hold",
      };
      pushGuard({ kind: p?.kind || "time", label: labelMap[p?.kind] || "Conflict", detail: p?.detail || "" });
    };

    const onShortage = (p) => {
      const items = (p?.items || []).slice(0, 3).map((i) => i?.name || i?.sku || "item").join(", ");
      pushGuard({ kind: "inventory", label: "Short on supplies", detail: items });
    };

    const onWeather = (p) => {
      pushGuard({ kind: "weather", label: "Weather alert", detail: p?.title || p?.severity || "" });
    };

    const pushGuard = (g) => {
      setGuards((arr) => {
        const next = [g, ...arr].slice(0, 5);
        return dedupeGuards(next);
      });
    };

    const off1 = eventBus.on?.("session.state.changed", onState) || (() => {});
    const off2 = eventBus.on?.("session.tick", onTick) || (() => {});
    const off3 = eventBus.on?.("planner.conflict.detected", onConflict) || (() => {});
    const off4 = eventBus.on?.("inventory.shortage.detected", onShortage) || (() => {});
    const off5 = eventBus.on?.("weather.alert.updated", onWeather) || (() => {});
    return () => {
      off1?.(); off2?.(); off3?.(); off4?.(); off5?.();
    };
  }, [sessionId, sessionIdProp, sessionTitleProp]);

  // Fallback timer if no orchestrator ticks
  useEffect(() => {
    clearInterval(tickRef.current);
    if (!active || !step) return;
    tickRef.current = setInterval(() => {
      setStep((prev) => (prev ? { ...prev, remainingSec: Math.max(0, (prev.remainingSec ?? 0) - 1) } : prev));
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [active, step?.id]);

  /* --------------------------------- Actions -------------------------------- */
  const start = () => {
    setBusy(true);
    eventBus.emit?.("session.start.requested", { domain, sessionId, source: "SessionBanner" });
    setActive(true);
    setBusy(false);
  };

  const pause = () => {
    setBusy(true);
    eventBus.emit?.("session.pause.requested", { domain, sessionId, reason: "user", source: "SessionBanner" });
    setActive(false);
    setBusy(false);
  };

  const completeStep = () => {
    setBusy(true);
    eventBus.emit?.("session.step.complete.requested", {
      domain, sessionId, stepId: step?.id, source: "SessionBanner",
    });
    setBusy(false);
  };

  const skipStep = () => {
    setBusy(true);
    eventBus.emit?.("session.step.advance.requested", {
      domain, sessionId, stepId: step?.id, reason: "skip", source: "SessionBanner",
    });
    setBusy(false);
  };

  const snooze = (offset = "+10m") => {
    setBusy(true);
    eventBus.emit?.("session.snooze.requested", { domain, sessionId, offset, source: "SessionBanner" });
    toastSafe(`Snoozed ${offset}.`);
    setBusy(false);
  };

  const extend = (offset = "+5m") => {
    setBusy(true);
    eventBus.emit?.("session.extend.requested", { domain, sessionId, offset, stepId: step?.id, source: "SessionBanner" });
    toastSafe(`Extended ${offset}.`);
    setBusy(false);
  };

  const addToCalendar = () => {
    eventBus.emit?.("calendar.write.requested", {
      domain,
      sessionId,
      title: sessionMeta.title || "Session",
      source: "SessionBanner",
      options: { pushReminders: true },
    });
    toastSafe("Added to calendar (requested).");
  };

  const openBlockers = () => {
    eventBus.emit?.("planner.conflicts.panel.open", { domain, sessionId, source: "SessionBanner" });
  };

  const openInventory = () => {
    eventBus.emit?.("inventory.signals.open", { domain, sessionId, source: "SessionBanner" });
  };

  const exportSessionJSON = () => {
    if (!sessionId) {
      toastSafe("No active session to export.", "error");
      return;
    }
    try {
      // Ask runtime to provide the latest snapshot, but also provide a minimal fallback.
      const fallback = {
        id: sessionId,
        domain,
        title: sessionMeta.title,
        step,
        progressPct,
        etaISO,
      };
      eventBus.emit?.("session.snapshot.requested", {
        sessionId,
        domain,
        source: "SessionBanner",
        reply: (snapshot) => {
          const data = snapshot || fallback;
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = `${safeFile(sessionMeta.title || "session")}.json`;
          a.click();
          URL.revokeObjectURL(a.href);
          toastSafe("Downloaded session JSON.");
        },
      });
    } catch (e) {
      console.warn("[SessionBanner] export failed", e);
      toastSafe("Export failed.", "error");
    }
  };

  /* --------------------------------- Derived -------------------------------- */
  const bannerTitle = step?.title || sessionMeta.title || "Active Session";
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
      default: return <I.AlertTriangle className="h-3.5 w-3.5" />;
    }
  };

  /* --------------------------------- Render -------------------------------- */
  return (
    <div className={WRAP} role="region" aria-label="Session controls">
      {/* Progress bar */}
      <div className="h-1 w-full bg-gray-100">
        <div
          className="h-1 bg-indigo-600 transition-[width] ease-out"
          style={{ width: `${Math.max(0, Math.min(100, progressPct))}%` }}
          aria-hidden="true"
        />
      </div>

      <div className={cx(INNER, "py-3 sm:py-3.5")}>
        <div className="flex flex-wrap items-center gap-3">
          {/* Collapse */}
          <button
            className={cx(BTN, VAR.ghost, "px-2")}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Expand session banner" : "Collapse session banner"}
          >
            {collapsed ? <I.ChevronUp className="h-4 w-4" /> : <I.ChevronDown className="h-4 w-4" />}
          </button>

          {/* Title + index */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-gray-900">{bannerTitle}</span>
              {total > 0 ? (
                <span className={CHIP}>
                  <I.Info className="h-3.5 w-3.5" />
                  Step {Math.min(idx + 1, total)} / {total}
                </span>
              ) : null}
              {eta ? (
                <span className={CHIP}>
                  <I.Clock className="h-3.5 w-3.5" />
                  ETA {eta}
                </span>
              ) : null}
            </div>

            {!collapsed && (
              <p className="mt-0.5 line-clamp-2 text-xs text-gray-600">{step?.notes || sessionMeta.description || ""}</p>
            )}
          </div>

          {/* Countdown */}
          <div className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-3 py-1.5">
            <I.Clock className="h-4 w-4 text-gray-700" />
            <span className="tabular-nums font-mono text-base">{prettyMMSS(step?.remainingSec ?? 0)}</span>
          </div>

          {/* Primary controls */}
          {active ? (
            <button className={cx(BTN, VAR.subtle)} onClick={pause} disabled={busy} aria-label="Pause session">
              <I.Pause className="h-4 w-4" />
              <span className="hidden xs:inline">Pause</span>
            </button>
          ) : (
            <button className={cx(BTN, VAR.primary)} onClick={start} disabled={busy} aria-label="Resume session">
              <I.Play className="h-4 w-4" />
              <span className="hidden xs:inline">Resume</span>
            </button>
          )}

          <button className={cx(BTN, VAR.subtle)} onClick={completeStep} disabled={!step || busy} aria-label="Complete step">
            <I.Check className="h-4 w-4" />
            <span className="hidden xs:inline">Complete</span>
          </button>

          <button className={cx(BTN, VAR.ghost)} onClick={skipStep} disabled={!step || busy} aria-label="Skip step">
            <I.Skip className="h-4 w-4" />
            <span className="hidden xs:inline">Skip</span>
          </button>

          <div className="hidden sm:flex items-center gap-2">
            <button className={cx(BTN, VAR.ghost)} onClick={() => extend("+5m")} aria-label="Add 5 minutes">
              <I.Plus className="h-4 w-4" />
              +5m
            </button>
            <button className={cx(BTN, VAR.ghost)} onClick={() => snooze("+10m")} aria-label="Snooze 10 minutes">
              <I.AlarmPlus className="h-4 w-4" />
              +10m
            </button>
          </div>

          {/* More menu */}
          <details className="relative">
            <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
              <I.MoreHorizontal className="h-4 w-4" />
              <span className="hidden sm:inline">More</span>
            </summary>
            <div className="absolute right-0 z-50 mt-2 min-w-[16rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
              <MenuItem onClick={() => extend("+15m")} label="Extend +15m" />
              <MenuItem onClick={() => extend("+30m")} label="Extend +30m" />
              <div className="h-px bg-gray-100" />
              <MenuItem onClick={addToCalendar} icon={<I.Calendar className="h-4 w-4" />} label="Add to calendar" />
              <div className="h-px bg-gray-100" />
              <MenuItem onClick={openBlockers} icon={<I.AlertTriangle className="h-4 w-4" />} label="Open conflicts panel" />
              <MenuItem onClick={openInventory} icon={<I.ShoppingCart className="h-4 w-4" />} label="Check inventory signals" />
              <div className="h-px bg-gray-100" />
              <MenuItem onClick={toggleFavoriteSession} icon={isFav ? <I.Star className="h-4 w-4 text-amber-500" /> : <I.StarOff className="h-4 w-4" />} label={isFav ? "Unfavorite session" : "Favorite session"} />
              <MenuItem onClick={openSaveSession} icon={<I.Save className="h-4 w-4" />} label="Save session…" />
              <MenuItem onClick={exportSessionJSON} icon={<I.Download className="h-4 w-4" />} label="Export session (.json)" />
            </div>
          </details>
        </div>

        {/* Guards / blockers */}
        {!collapsed && guards?.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {guards.slice(0, 4).map((g, i) => (
              <button
                key={i}
                className={cx(CHIP, "hover:bg-gray-100")}
                onClick={g.kind === "inventory" ? openInventory : openBlockers}
                title={g.detail || g.label}
              >
                {riskIcon(g.kind)}
                <span>{g.label}</span>
              </button>
            ))}
            {guards.length > 4 && (
              <span className={CHIP}>
                <I.Info className="h-3.5 w-3.5" />
                +{guards.length - 4} more
              </span>
            )}
          </div>
        )}
      </div>

      {/* Save Session modal (lazy preferred) */}
      {saveOpen && (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={saveOpen}
              onClose={() => setSaveOpen(false)}
              defaultTitle={sessionMeta.title || "My Session"}
              domain={domain}
              sessionId={sessionId}
              onSaved={(saved) => {
                eventBus.emit?.("session.saved", { from: "SessionBanner", saved });
                toastSafe("Session saved.");
                setSaveOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={domain}
            sessionId={sessionId}
            defaultTitle={sessionMeta.title}
            defaultNotes={sessionMeta.description}
            onClose={() => setSaveOpen(false)}
            onSaved={(saved) => {
              eventBus.emit?.("session.saved", { from: "SessionBanner", saved });
              toastSafe("Session saved.");
              setSaveOpen(false);
            }}
          />
        )
      )}
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

function InlineSaveSession({ domain, sessionId, defaultTitle, defaultNotes, onClose, onSaved }) {
  const [name, setName] = useState(defaultTitle || "");
  const [notes, setNotes] = useState(defaultNotes || "");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!sessionId) {
      toastSafe("No active session to save.", "error");
      return;
    }
    setBusy(true);
    try {
      const payload = { id: sessionId, domain, title: name, notes };
      eventBus.emit?.("session.save.requested", { payload, source: "SessionBanner" });
      onSaved?.(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div className="w-[95vw] max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold">Save Session</h3>
        <p className="mt-1 text-sm text-gray-600">Save this session to your library.</p>

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
          placeholder="What should future-you remember about this session?"
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

/* --------------------------------- Helpers --------------------------------- */
function dedupeGuards(arr) {
  const seen = new Set();
  return arr.filter((g) => {
    const key = `${g.kind}:${g.label}:${g.detail || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeFile(name = "session") {
  return String(name).toLowerCase().replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-");
}

/* eslint-disable no-console */
// src/components/session/ChainTimeline.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* ------------------------------ Design tokens ------------------------------ */
const cx = (...c) => c.filter(Boolean).join(" ");
const WRAP = "rounded-3xl border border-gray-200 bg-white shadow-sm";
const BTN =
  "inline-flex items-center gap-2 rounded-2xl px-3 py-1.5 text-sm font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 active:translate-y-px";
const VAR = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle: "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const CHIP =
  "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2.5 py-1 text-xs font-medium text-gray-700";
const TAG =
  "inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-700";

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
    Anchor: L.Anchor,
    Play: L.Play,
    Pause: L.Pause,
    Check: L.Check,
    Skip: L.SkipForward,
    Clock: L.Clock3,
    Calendar: L.Calendar,
    Edit: L.Pencil,
    Drag: L.GripVertical,
    Info: L.Info,
    Star: L.Star,
    StarOff: L.StarOff,
    Save: L.Save,
    Sparkles: L.Sparkles,
    Download: L.Download,
    AlertTriangle: L.AlertTriangle,
    CloudLightning: L.CloudLightning,
    ShoppingCart: L.ShoppingCart,
    ThermometerSnowflake: L.ThermometerSnowflake,
    X: L.X,
    More: L.MoreHorizontal,
    ArrowRight: L.ArrowRight,
  };
} catch (_) {
  I = {
    Anchor: () => <span>⚓</span>,
    Play: () => <span>▶</span>,
    Pause: () => <span>⏸</span>,
    Check: () => <span>✔</span>,
    Skip: () => <span>≫</span>,
    Clock: () => <span>🕒</span>,
    Calendar: () => <span>📅</span>,
    Edit: () => <span>✎</span>,
    Drag: () => <span>⋮⋮</span>,
    Info: () => <span>ℹ</span>,
    Star: () => <span>★</span>,
    StarOff: () => <span>☆</span>,
    Save: () => <span>💾</span>,
    Sparkles: () => <span>✦</span>,
    Download: () => <span>⬇</span>,
    AlertTriangle: () => <span>⚠</span>,
    CloudLightning: () => <span>⛈</span>,
    ShoppingCart: () => <span>🛒</span>,
    ThermometerSnowflake: () => <span>🥶</span>,
    X: () => <span>✕</span>,
    More: () => <span>⋯</span>,
    ArrowRight: () => <span>→</span>,
  };
}

/* ---------------------------------- Utils ---------------------------------- */
const safeFile = (name = "session-chain") =>
  String(name).toLowerCase().replace(/[^a-z0-9-_]+/gi, "-").replace(/-+/g, "-");

function toastSafe(message, variant = "success") {
  try {
    eventBus.emit("ui.toast", { message, variant });
  } catch (_) {
    if (variant === "error") console.warn(message);
    else console.log(message);
  }
}

/** Status color helpers */
const statusHue = (s) => {
  switch (s) {
    case "done": return "bg-emerald-600";
    case "running": return "bg-indigo-600";
    case "blocked": return "bg-amber-500";
    case "error": return "bg-rose-600";
    default: return "bg-gray-300";
  }
};
const nodeRing = (type, active) =>
  cx(
    "ring-2",
    active ? "ring-indigo-500" : "ring-gray-200",
    type === "anchor" ? "ring-offset-2" : "ring-offset-1"
  );

const guardIcon = (k) => {
  switch (k) {
    case "inventory": return <I.ShoppingCart className="h-3.5 w-3.5" />;
    case "weather": return <I.CloudLightning className="h-3.5 w-3.5" />;
    case "time": return <I.Clock className="h-3.5 w-3.5" />;
    case "appliance": return <I.ThermometerSnowflake className="h-3.5 w-3.5" />;
    default: return <I.AlertTriangle className="h-3.5 w-3.5" />;
  }
};

/* ---------------------------------- Types ---------------------------------- */
/**
 * Chain node shape (expected from orchestrator or prop):
 * {
 *   id: string,
 *   type: "anchor" | "action",
 *   title: string,
 *   subtitle?: string,
 *   etaSec?: number,
 *   status?: "pending"|"running"|"done"|"blocked"|"error",
 *   guards?: [{kind,label,detail}],
 *   params?: object
 * }
 */

/* -------------------------------- Component -------------------------------- */
/**
 * ChainTimeline – visual chain of anchors → actions with inline controls.
 *
 * Props:
 *  - domain: "meals"|"garden"|"animals"|"cleaning"|...
 *  - sessionId: string
 *  - chain?: ChainNode[]   (optional; if absent, will request via bus)
 *  - title?: string        (session display title)
 *  - enableReorder?: boolean (drag-to-reorder, emits chain.reorder.requested)
 *  - compact?: boolean
 */
export default function ChainTimeline({
  domain = "meals",
  sessionId,
  chain: chainProp = null,
  title: titleProp = "Session Chain",
  enableReorder = false,
  compact = false,
}) {
  const [chain, setChain] = useState(() => chainProp || []);
  const [activeId, setActiveId] = useState(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState(titleProp);
  const [progressPct, setProgressPct] = useState(0);
  const [busy, setBusy] = useState(false);
  const scrollerRef = useRef(null);

  /* ----------------------------- Favorites (session) ----------------------------- */
  const favApi = useFavoriteSessions ? useFavoriteSessions(domain) : null;
  const [fav, setFav] = useState(() => (!!sessionId && !!favApi?.isFavorite?.(sessionId)) || false);
  useEffect(() => {
    if (favApi && sessionId) setFav(!!favApi.isFavorite?.(sessionId));
  }, [favApi, sessionId]);

  const toggleFavoriteSession = async () => {
    if (!sessionId) {
      toastSafe("No session to favorite.", "error");
      return;
    }
    try {
      if (favApi?.toggleFavorite) {
        const next = await favApi.toggleFavorite(sessionId, { id: sessionId, title: sessionTitle, domain });
        setFav(!!next);
      } else {
        const next = !fav;
        setFav(next);
        eventBus.emit("session.favorite.toggled", {
          domain,
          sessionId,
          next,
          meta: { title: sessionTitle },
          source: "ChainTimeline",
        });
      }
      toastSafe(fav ? "Removed from favorite sessions." : "Added to favorite sessions.");
    } catch (e) {
      console.warn("[ChainTimeline] favorite toggle failed", e);
      toastSafe("Could not update favorite sessions.", "error");
    }
  };

  /* ------------------------------ Save session UX ------------------------------ */
  const [saveOpen, setSaveOpen] = useState(false);
  const openSave = () => {
    if (!sessionId) {
      toastSafe("No session to save.", "error");
      return;
    }
    setSaveOpen(true);
    eventBus.emit?.("session.save.modal.opened", { domain, sessionId, source: "ChainTimeline" });
  };

  /* ------------------------------ Orchestration I/O ------------------------------ */
  // Apply incoming state from orchestrator
  useEffect(() => {
    const apply = (s) => {
      if (!s) return;
      if (Array.isArray(s.chain)) setChain(s.chain);
      if (typeof s.progressPct === "number") setProgressPct(Math.max(0, Math.min(100, s.progressPct)));
      if (s.title) setSessionTitle(s.title);
      if (s.currentNodeId) setActiveId(s.currentNodeId);
    };

    const onChain = (payload) => {
      const s = payload?.session || payload;
      if (!s || (s.id && sessionId && s.id !== sessionId)) return;
      apply(s);
    };

    const offA = eventBus.on?.("session.state.changed", onChain) || (() => {});
    const offB = eventBus.on?.("chain.state.changed", onChain) || (() => {});

    // If chain not provided, request a snapshot once
    if (!chainProp) {
      eventBus.emit?.("chain.snapshot.requested", {
        sessionId,
        domain,
        source: "ChainTimeline",
        reply: (snapshot) => apply(snapshot),
      });
    }

    return () => { offA?.(); offB?.(); };
  }, [sessionId, chainProp]);

  // Smooth-scroll to active node when it changes
  useEffect(() => {
    if (!activeId || !scrollerRef.current) return;
    const el = scrollerRef.current.querySelector(`[data-node-id="${CSS.escape(activeId)}"]`);
    if (el) el.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [activeId]);

  /* --------------------------------- Actions --------------------------------- */
  const start = () => {
    setBusy(true);
    eventBus.emit?.("session.start.requested", { domain, sessionId, source: "ChainTimeline" });
    setBusy(false);
  };
  const pause = () => {
    setBusy(true);
    eventBus.emit?.("session.pause.requested", { domain, sessionId, reason: "user", source: "ChainTimeline" });
    setBusy(false);
  };
  const completeNode = (node) => {
    setBusy(true);
    eventBus.emit?.("session.step.complete.requested", {
      domain,
      sessionId,
      stepId: node?.id,
      source: "ChainTimeline",
    });
    setBusy(false);
  };
  const skipNode = (node) => {
    setBusy(true);
    eventBus.emit?.("session.step.advance.requested", {
      domain,
      sessionId,
      stepId: node?.id,
      reason: "skip",
      source: "ChainTimeline",
    });
    setBusy(false);
  };
  const jumpHere = (node) => {
    setBusy(true);
    eventBus.emit?.("session.jump.requested", {
      domain,
      sessionId,
      stepId: node?.id,
      source: "ChainTimeline",
    });
    setActiveId(node?.id || null);
    setBusy(false);
  };
  const runAction = (node) => {
    setBusy(true);
    eventBus.emit?.("chain.action.execute.requested", {
      domain,
      sessionId,
      nodeId: node?.id,
      params: node?.params || {},
      source: "ChainTimeline",
    });
    setBusy(false);
  };
  const previewAction = (node) => {
    eventBus.emit?.("chain.action.preview.requested", {
      domain,
      sessionId,
      nodeId: node?.id,
      params: node?.params || {},
      source: "ChainTimeline",
    });
  };
  const openAnchor = (node) => {
    eventBus.emit?.("session.anchor.open", { domain, sessionId, anchorId: node?.id, source: "ChainTimeline" });
  };
  const addToCalendar = () => {
    eventBus.emit?.("calendar.write.requested", {
      domain,
      sessionId,
      title: sessionTitle,
      source: "ChainTimeline",
      options: { pushReminders: true },
    });
    toastSafe("Added to calendar (requested).");
  };
  const exportChain = () => {
    const fallback = { id: sessionId, domain, title: sessionTitle, chain };
    eventBus.emit?.("chain.snapshot.requested", {
      sessionId,
      domain,
      source: "ChainTimeline",
      reply: (snap) => {
        const data = snap || fallback;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${safeFile(sessionTitle)}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toastSafe("Downloaded chain JSON.");
      },
    });
  };

  /* ------------------------------ Drag-to-reorder ----------------------------- */
  const dragItem = useRef(null);
  const onDragStart = (e, idx) => {
    if (!enableReorder) return;
    dragItem.current = idx;
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e) => enableReorder && e.preventDefault();
  const onDrop = (e, idx) => {
    if (!enableReorder) return;
    e.preventDefault();
    const from = dragItem.current;
    dragItem.current = null;
    if (from == null || from === idx) return;
    const next = [...chain];
    const [moved] = next.splice(from, 1);
    next.splice(idx, 0, moved);
    setChain(next);
    // notify orchestrator
    eventBus.emit?.("chain.reorder.requested", {
      domain,
      sessionId,
      order: next.map((n) => n.id),
      source: "ChainTimeline",
    });
  };

  /* --------------------------------- Derived --------------------------------- */
  const computedProgress = useMemo(() => {
    if (progressPct) return progressPct;
    const total = chain.length || 0;
    if (!total) return 0;
    const done = chain.filter((n) => n.status === "done").length;
    return Math.round((done / total) * 100);
  }, [progressPct, chain]);

  const activeNode = useMemo(() => chain.find((n) => n.id === activeId) || null, [chain, activeId]);

  /* ---------------------------------- Render --------------------------------- */
  return (
    <section className={WRAP} aria-label="Chain timeline">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-gradient-to-r from-white to-gray-50 px-4 py-3 rounded-t-3xl">
        <div className="min-w-0">
          <h3 className="truncate text-sm sm:text-base font-semibold text-gray-900">{sessionTitle}</h3>
          <div className="mt-1 flex items-center gap-2">
            <span className={CHIP}>
              <I.Info className="h-3.5 w-3.5" />
              {computedProgress}% complete
            </span>
            <span className={TAG}>{domain}</span>
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Start/Pause use current active node to infer running/pause. We’ll rely on orchestrator state if you wire it. */}
          <button className={cx(BTN, VAR.primary)} onClick={start}>
            <I.Play className="h-4 w-4" />
            Start
          </button>
          <button className={cx(BTN, VAR.subtle)} onClick={pause}>
            <I.Pause className="h-4 w-4" />
            Pause
          </button>

          <button className={cx(BTN, VAR.ghost)} onClick={toggleFavoriteSession} aria-pressed={fav} title={fav ? "Unfavorite session" : "Favorite session"}>
            {fav ? <I.Star className="h-4 w-4 text-amber-500" /> : <I.StarOff className="h-4 w-4" />}
          </button>

          <button className={cx(BTN, VAR.subtle)} onClick={openSave}>
            <I.Save className="h-4 w-4" />
            Save
          </button>

          <details className="relative">
            <summary className={cx(BTN, VAR.ghost, "cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
              <I.More className="h-4 w-4" />
            </summary>
            <div className="absolute right-0 z-10 mt-2 min-w-[14rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
              <MenuItem onClick={addToCalendar} icon={<I.Calendar className="h-4 w-4" />} label="Add to calendar" />
              <div className="h-px bg-gray-100" />
              <MenuItem onClick={exportChain} icon={<I.Download className="h-4 w-4" />} label="Export chain (.json)" />
            </div>
          </details>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 w-full bg-gray-100">
        <div
          className="h-1 bg-indigo-600 transition-[width] ease-out"
          style={{ width: `${Math.max(0, Math.min(100, computedProgress))}%` }}
          aria-hidden="true"
        />
      </div>

      {/* Timeline scroller */}
      <div ref={scrollerRef} className="overflow-x-auto px-4 py-4">
        <ol className="relative mx-auto flex min-w-max items-stretch gap-6">
          {chain.map((node, idx) => (
            <li
              key={node.id || idx}
              data-node-id={node.id}
              draggable={enableReorder}
              onDragStart={(e) => onDragStart(e, idx)}
              onDragOver={onDragOver}
              onDrop={(e) => onDrop(e, idx)}
              className="group relative flex items-center gap-3"
              role="group"
              aria-label={`${node.type} ${node.title}`}
            >
              {/* Connector line (left) */}
              {idx > 0 && (
                <div className="absolute left-[-12px] top-1/2 h-[2px] w-3 translate-y-[-1px] bg-gray-200" aria-hidden="true" />
              )}

              {/* Node */}
              <button
                type="button"
                className={cx(
                  "relative flex items-center gap-3 rounded-2xl border bg-white px-3 py-2 text-left transition hover:shadow-sm",
                  node.type === "anchor" ? "border-indigo-200" : "border-gray-200",
                  nodeRing(node.type, node.id === activeId)
                )}
                onClick={() => {
                  setActiveId(node.id);
                  setDetailsOpen(true);
                  if (node.type === "anchor") {
                    eventBus.emit?.("session.anchor.open", { domain, sessionId, anchorId: node.id, source: "ChainTimeline" });
                  }
                }}
              >
                <div
                  className={cx(
                    "grid h-8 w-8 place-items-center rounded-xl",
                    node.type === "anchor" ? "bg-indigo-50" : "bg-gray-50",
                    node.status ? "" : "border border-gray-200"
                  )}
                  title={node.type}
                >
                  {node.type === "anchor" ? <I.Anchor className="h-4 w-4 text-indigo-700" /> : <I.Sparkles className="h-4 w-4 text-gray-700" />}
                </div>

                <div className="min-w-[12rem] max-w-[18rem]">
                  <p className="truncate text-sm font-medium text-gray-900">{node.title || (node.type === "anchor" ? "Anchor" : "Action")}</p>
                  {node.subtitle && <p className="truncate text-xs text-gray-600">{node.subtitle}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-1">
                    {node.status && (
                      <span className={cx("h-1.5 w-1.5 rounded-full", statusHue(node.status))} title={node.status} />
                    )}
                    {typeof node.etaSec === "number" && (
                      <span className={TAG}>
                        <I.Clock className="mr-1 inline-block h-3 w-3" />
                        ~{Math.max(0, Math.round(node.etaSec / 60))}m
                      </span>
                    )}
                    {(node.guards || []).slice(0, 2).map((g, i) => (
                      <span key={i} className={TAG} title={g.detail || g.label}>
                        {guardIcon(g.kind)}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Drag handle */}
                {enableReorder && (
                  <div className="ml-2 hidden cursor-grab text-gray-400 group-hover:block" title="Drag to reorder">
                    <I.Drag className="h-4 w-4" />
                  </div>
                )}
              </button>

              {/* Connector arrow (right) */}
              {idx < chain.length - 1 && (
                <div className="absolute right-[-16px] top-1/2 translate-y-[-9px] text-gray-300" aria-hidden="true">
                  <I.ArrowRight className="h-4 w-4" />
                </div>
              )}
            </li>
          ))}

          {chain.length === 0 && (
            <div className="text-sm text-gray-500">No steps yet. Generate a draft or start a session.</div>
          )}
        </ol>
      </div>

      {/* Details drawer */}
      {detailsOpen && activeNode && (
        <DetailsDrawer
          node={activeNode}
          onClose={() => setDetailsOpen(false)}
          onRun={() => runAction(activeNode)}
          onPreview={() => previewAction(activeNode)}
          onComplete={() => completeNode(activeNode)}
          onSkip={() => skipNode(activeNode)}
          onJump={() => jumpHere(activeNode)}
        />
      )}

      {/* Save Session modal (lazy first) */}
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
                eventBus.emit?.("session.saved", { from: "ChainTimeline", saved });
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
              eventBus.emit?.("session.saved", { from: "ChainTimeline", saved });
              toastSafe("Session saved.");
              setSaveOpen(false);
            }}
          />
        )
      )}
    </section>
  );
}

/* ------------------------------- Subcomponents ------------------------------ */
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

function DetailsDrawer({ node, onClose, onRun, onPreview, onComplete, onSkip, onJump }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 grid place-items-end bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="w-full max-w-xl rounded-t-3xl border border-gray-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-gray-900">{node.title}</p>
            {node.subtitle && <p className="text-xs text-gray-600">{node.subtitle}</p>}
          </div>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={onClose} aria-label="Close">
            <I.X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-4 py-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {node.status && (
              <span className={CHIP}>
                <span className={cx("h-1.5 w-1.5 rounded-full", statusHue(node.status))} />
                <span className="capitalize">{node.status}</span>
              </span>
            )}
            {typeof node.etaSec === "number" && (
              <span className={CHIP}>
                <I.Clock className="h-3.5 w-3.5" />
                ~{Math.max(0, Math.round(node.etaSec / 60))}m
              </span>
            )}
            {(node.guards || []).slice(0, 4).map((g, i) => (
              <span key={i} className={CHIP} title={g.detail || g.label}>
                {guardIcon(g.kind)}
                <span>{g.label}</span>
              </span>
            ))}
          </div>

          {node.params && Object.keys(node.params).length > 0 && (
            <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
              <p className="mb-2 text-xs font-semibold text-gray-700">Parameters</p>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
                {Object.entries(node.params).map(([k, v]) => (
                  <div key={k} className="text-xs">
                    <dt className="font-medium text-gray-700">{k}</dt>
                    <dd className="text-gray-600">{String(v)}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {node.type === "action" ? (
              <>
                <button className={cx(BTN, VAR.primary)} onClick={onRun}>
                  <I.Play className="h-4 w-4" />
                  Run
                </button>
                <button className={cx(BTN, VAR.subtle)} onClick={onPreview}>
                  <I.Info className="h-4 w-4" />
                  Preview
                </button>
                <button className={cx(BTN, VAR.subtle)} onClick={onComplete}>
                  <I.Check className="h-4 w-4" />
                  Complete
                </button>
                <button className={cx(BTN, VAR.ghost)} onClick={onSkip}>
                  <I.Skip className="h-4 w-4" />
                  Skip
                </button>
              </>
            ) : (
              <>
                <button className={cx(BTN, VAR.primary)} onClick={onJump}>
                  <I.Play className="h-4 w-4" />
                  Jump here
                </button>
                <button className={cx(BTN, VAR.subtle)} onClick={onPreview}>
                  <I.Info className="h-4 w-4" />
                  Open anchor
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- Inline Save ------------------------------- */
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
      eventBus.emit?.("session.save.requested", { payload, source: "ChainTimeline" });
      onSaved?.(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30">
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">Save Session</h3>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={onClose}><I.X className="h-4 w-4" /></button>
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

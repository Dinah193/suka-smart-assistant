/* eslint-disable no-console */
// src/components/toasts/InlineToastAnchor.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* --------------------------------- Tokens ---------------------------------- */
const cx = (...a) => a.filter(Boolean).join(" ");
const WRAP = "pointer-events-none w-full"; // container doesn’t steal clicks except inside toasts
const SLOT = "pointer-events-auto flex flex-col gap-2"; // actual clickable area
const CARD = "rounded-2xl border px-3 py-2 shadow-md bg-white";
const CHIP = "inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white/80 px-2 py-0.5 text-[11px] font-medium text-gray-700";
const BTN  = "inline-flex items-center gap-2 rounded-xl px-2.5 py-1.5 text-xs font-medium shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2";
const VAR  = {
  subtle:  "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost:   "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  danger:  "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
  warn:    "bg-amber-500 text-white hover:bg-amber-600 focus:ring-amber-600",
  success: "bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-600",
};
const ROW = "flex items-center gap-2";
const TEXT = "text-[13px] leading-snug text-gray-900";

/* ----------------------------- Defensive imports ---------------------------- */
let eventBus = { emit(){}, on(){}, off(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
} catch(_){}

let automation = null;
try {
  const a = require("@/services/automation/runtime");
  automation = a && (a.automation || a.default) || null;
} catch(_){}

/* Favorites: Sessions (user-owned) */
let useFavoriteSessions = null;
try {
  const favMod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions = favMod && (favMod.useFavoriteSessions || favMod.default) || null;
} catch(_){}

/* Lazy Save Session modal (optional) */
let SaveSessionModalLazy = null;
try {
  SaveSessionModalLazy = React.lazy(() => import("@/components/sessions/SaveSessionModal.jsx"));
} catch(_){}

/* ----------------------------------- Icons ---------------------------------- */
let I = {};
try {
  const L = require("lucide-react");
  I = {
    Check: L.Check, X: L.X, Undo: L.Undo2, ArrowRight: L.ArrowRight,
    Star: L.Star, StarOff: L.StarOff, Save: L.Save, Clock: L.Clock3,
    Alert: L.AlertTriangle, Info: L.Info, Play: L.Play,
  };
} catch(_){
  I = new Proxy({}, { get(){ return () => <span/>; }});
}

/* ---------------------------------- Utils ---------------------------------- */
const now = () => Date.now();
const nowISO = () => new Date().toISOString();
const isReducedMotion = () => {
  try { return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch(_){ return false; }
};
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toastId = () => "toast:"+Math.random().toString(36).slice(2,9);
function toMs(v, def=6000){
  if (!v) return def;
  if (typeof v === "number") return v;
  if (typeof v === "string"){
    // +20m, +5s, 5000
    if (/^\d+$/.test(v)) return Number(v);
    const m = v.match(/^\+?(\d+)(ms|s|m|h)$/i);
    if (m){
      const n = Number(m[1]); const u = m[2].toLowerCase();
      return u === "ms" ? n : u === "s" ? n*1000 : u === "m" ? n*60000 : n*3600000;
    }
  }
  return def;
}
function toastVariantClasses(variant){
  if (variant === "error") return "border-rose-200";
  if (variant === "warn")  return "border-amber-200";
  if (variant === "success") return "border-emerald-200";
  return "border-gray-200";
}
function toastBadge(variant){
  if (variant === "error") return <span className={cx(CHIP,"border-rose-300 text-rose-700")}><I.Alert className="h-3 w-3" /> Error</span>;
  if (variant === "warn")  return <span className={cx(CHIP,"border-amber-300 text-amber-700")}><I.Alert className="h-3 w-3" /> Warning</span>;
  if (variant === "success") return <span className={cx(CHIP,"border-emerald-300 text-emerald-700")}><I.Check className="h-3 w-3" /> Success</span>;
  return <span className={CHIP}><I.Info className="h-3 w-3" /> Info</span>;
}

/* =============================== Toast Anchor =============================== */
/**
 * InlineToastAnchor
 *
 * Mount this where you want toasts to appear (e.g., top-right of a page section).
 * Listens for `ui.toast` events with payload:
 * {
 *   id?, message, variant?: "info|success|warn|error",
 *   ttl?: number|string, sticky?: boolean,
 *   actions?: [{ label, event?:string, payload?:any, variant? }],
 *   step?: { id, title, canUndo?, canComplete? },
 *   session?: { idOrTitle, domain? },
 *   meta?: { ...anything } // passed to analytics/logs
 * }
 */
export default function InlineToastAnchor(props){
  const position = props.position || "top-right"; // "top-right" | "top-left" | "bottom-right" | "bottom-left"
  const domain = props.domain || "session";
  const maxVisible = clamp(Number(props.maxVisible || 4), 1, 12);

  // queue = [{id, createdAt, message, variant, ttl, sticky, ...meta}]
  const [queue, setQueue] = useState([]);
  const timersRef = useRef(new Map()); // id -> { timeout, endAt, paused }
  const hoverRef  = useRef(new Set()); // ids hovered to pause

  // Favorites/session save state
  let favApi = null;
  try { favApi = useFavoriteSessions ? useFavoriteSessions(domain) : null; } catch(_){}
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveDefaults, setSaveDefaults] = useState({ id: "__pending__", title: "My Session" });

  /* ------------------------------- Bus wiring ------------------------------- */
  useEffect(() => {
    const onToast = (p={}) => {
      // Normalize
      const id = p.id || toastId();
      const ttl = p.sticky ? 0 : toMs(p.ttl, 6000);
      const item = {
        id, message: p.message || "—", variant: p.variant || "info", ttl,
        sticky: !!p.sticky, actions: Array.isArray(p.actions) ? p.actions : [],
        step: p.step || null, session: p.session || null, meta: p.meta || {},
        createdAt: now(), domain: p.session && p.session.domain ? p.session.domain : domain
      };
      setQueue((cur) => [item, ...cur].slice(0, 50));
      startTimer(item);
      // lightweight analytics trail (optional)
      try { eventBus.emit && eventBus.emit("ui.analytics", { kind:"toast.show", at: nowISO(), item }); } catch(_){}
    };

    try { eventBus.on && eventBus.on("ui.toast", onToast); } catch(_){}

    return () => { try { eventBus.off && eventBus.off("ui.toast", onToast); } catch(_){} };
  }, [domain]);

  /* ------------------------------- Timers ----------------------------------- */
  function startTimer(toast){
    stopTimer(toast.id);
    if (!toast.ttl || toast.ttl <= 0) return; // sticky or no auto-dismiss
    if (isReducedMotion()) return; // respect users
    const endAt = now() + toast.ttl;
    const timeout = window.setTimeout(() => dismiss(toast.id), toast.ttl);
    timersRef.current.set(toast.id, { timeout, endAt, paused:false, remaining: toast.ttl });
  }
  function stopTimer(id){
    const t = timersRef.current.get(id);
    if (t && t.timeout){ window.clearTimeout(t.timeout); }
    timersRef.current.delete(id);
  }
  function pauseTimer(id){
    const t = timersRef.current.get(id);
    if (!t || t.paused) return;
    const remaining = Math.max(0, t.endAt - now());
    window.clearTimeout(t.timeout);
    timersRef.current.set(id, { ...t, paused:true, remaining });
  }
  function resumeTimer(id){
    const t = timersRef.current.get(id);
    if (!t || !t.paused) return;
    const timeout = window.setTimeout(() => dismiss(id), t.remaining);
    timersRef.current.set(id, { ...t, paused:false, timeout, endAt: now() + t.remaining });
  }

  /* -------------------------------- Actions --------------------------------- */
  function dismiss(id){
    stopTimer(id);
    setQueue((cur) => cur.filter((x) => x.id !== id));
  }

  function handleAction(toast, action){
    try {
      // If action specifies a bus event, emit it.
      if (action && action.event){
        eventBus.emit && eventBus.emit(action.event, Object.assign({ from:"InlineToastAnchor", toastId: toast.id }, action.payload || {}));
      }
      // Built-ins: step/session helpers
      if (toast.step){
        if (action.label === "Mark done" || action.event === "step.complete.requested"){
          const p = { stepId: toast.step.id, source:"InlineToastAnchor" };
          if (automation && automation.steps && automation.steps.complete) automation.steps.complete(p);
          else eventBus.emit && eventBus.emit("step.complete.requested", p);
        }
        if (action.label === "Undo" || action.event === "step.undo.requested"){
          const p = { stepId: toast.step.id, source:"InlineToastAnchor" };
          if (automation && automation.steps && automation.steps.undo) automation.steps.undo(p);
          else eventBus.emit && eventBus.emit("step.undo.requested", p);
        }
        if (action.label === "Go to step" || action.event === "step.open.requested"){
          eventBus.emit && eventBus.emit("step.open.requested", { stepId: toast.step.id, source:"InlineToastAnchor" });
        }
      }
      if (toast.session && (action.label === "Start session" || action.event === "session.start.requested")){
        const idOrTitle = toast.session.idOrTitle || "";
        const p = { idOrTitle, domain: toast.session.domain || domain, source:"InlineToastAnchor" };
        if (automation && automation.sessions && automation.sessions.start){
          const maybe = automation.sessions.start(p);
          if (maybe && typeof maybe.then === "function"){ maybe.then(()=>{}); }
        } else {
          eventBus.emit && eventBus.emit("session.start.requested", p);
        }
      }
      // Close unless sticky
      if (!toast.sticky) dismiss(toast.id);
    } catch(e){
      try { eventBus.emit && eventBus.emit("ui.toast", { message:"Action failed.", variant:"error", ttl: 4000 }); } catch(_){}
    }
  }

  /* --------------------------- Session favorite/save ------------------------- */
  function toggleFavoriteSession(idOrTitle){
    if (!idOrTitle) {
      try { eventBus.emit && eventBus.emit("ui.toast", { message:"Enter a session id or title first.", variant:"warn", ttl: 3000 }); } catch(_){}
      return;
    }
    try {
      if (favApi && favApi.toggleFavorite){
        const next = favApi.toggleFavorite(idOrTitle, { id: idOrTitle, title: String(idOrTitle), domain });
        if (next && typeof next.then === "function"){
          next.then((v)=> eventBus.emit && eventBus.emit("ui.toast", { message: v ? "Added to favorites." : "Removed from favorites.", variant:"success", ttl: 2600 }));
        } else {
          eventBus.emit && eventBus.emit("ui.toast", { message: next ? "Added to favorites." : "Removed from favorites.", variant:"success", ttl: 2600 });
        }
      } else {
        // emit a best-effort event if hook isn’t present
        eventBus.emit && eventBus.emit("session.favorite.toggled", { domain, sessionId: idOrTitle, next: true, source:"InlineToastAnchor" });
      }
    } catch(_){
      eventBus.emit && eventBus.emit("ui.toast", { message:"Favorite update failed.", variant:"error", ttl: 3000 });
    }
  }

  function openSaveSession(idOrTitle, titleGuess){
    const title = String(titleGuess || idOrTitle || "My Session");
    setSaveDefaults({ id: idOrTitle || "__pending__", title });
    setSaveOpen(true);
    try {
      eventBus.emit && eventBus.emit("session.save.modal.opened", { domain, sessionId: idOrTitle || "__pending__", source:"InlineToastAnchor" });
    } catch(_){}
  }

  /* --------------------------------- Layout --------------------------------- */
  const posClasses = useMemo(() => {
    const base = "fixed z-50 p-3 sm:p-4";
    if (position === "top-left") return base + " top-3 left-3";
    if (position === "bottom-left") return base + " bottom-3 left-3";
    if (position === "bottom-right") return base + " bottom-3 right-3";
    return base + " top-3 right-3";
  }, [position]);

  const visible = queue.slice(0, maxVisible);

  return (
    <>
      <div className={cx(WRAP, posClasses)} aria-live="polite" aria-relevant="additions text">
        <div className={SLOT}>
          {visible.map((t) => {
            const isHovered = hoverRef.current.has(t.id);
            return (
              <article
                key={t.id}
                role="status"
                aria-label={String(t.variant || "info")}
                className={cx(CARD, toastVariantClasses(t.variant))}
                onMouseEnter={() => { hoverRef.current.add(t.id); pauseTimer(t.id); }}
                onMouseLeave={() => { hoverRef.current.delete(t.id); resumeTimer(t.id); }}
              >
                {/* Header row */}
                <div className={ROW}>
                  {toastBadge(t.variant)}
                  {t.step ? <span className={CHIP}><I.Clock className="h-3 w-3" /> step</span> : null}
                  {t.session && t.session.idOrTitle ? <span className={CHIP}>session: {String(t.session.idOrTitle).slice(0,40)}</span> : null}
                  <div className="ml-auto flex items-center gap-1">
                    {t.session && t.session.idOrTitle ? (
                      <>
                        {/* Favorite session */}
                        <button
                          className={cx(BTN, VAR.ghost, "px-2")}
                          title="Favorite session"
                          onClick={()=>toggleFavoriteSession(t.session.idOrTitle)}
                        >
                          <I.Star className="h-4 w-4 text-amber-500" />
                        </button>
                        {/* Save session */}
                        <button
                          className={cx(BTN, VAR.subtle, "px-2")}
                          title="Save session"
                          onClick={()=>openSaveSession(t.session.idOrTitle, t.meta && t.meta.sessionTitle)}
                        >
                          <I.Save className="h-4 w-4" />
                        </button>
                      </>
                    ) : null}
                    {/* Dismiss */}
                    <button className={cx(BTN, VAR.ghost, "px-2")} aria-label="Dismiss" onClick={()=>dismiss(t.id)}>
                      <I.X className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Body */}
                <div className={cx(TEXT, "mt-1")}>{t.message}</div>

                {/* Step controls */}
                {t.step ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {t.step.canComplete !== false ? (
                      <button
                        className={cx(BTN, VAR.success)}
                        onClick={() => handleAction(t, { label:"Mark done", event:"step.complete.requested" })}
                      >
                        <I.Check className="h-4 w-4" /> Mark done
                      </button>
                    ) : null}
                    {t.step.canUndo ? (
                      <button
                        className={cx(BTN, VAR.subtle)}
                        onClick={() => handleAction(t, { label:"Undo", event:"step.undo.requested" })}
                      >
                        <I.Undo className="h-4 w-4" /> Undo
                      </button>
                    ) : null}
                    <button
                      className={cx(BTN, VAR.ghost)}
                      onClick={() => handleAction(t, { label:"Go to step", event:"step.open.requested" })}
                    >
                      <I.ArrowRight className="h-4 w-4" /> View step
                    </button>
                  </div>
                ) : null}

                {/* Custom action row */}
                {Array.isArray(t.actions) && t.actions.length ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {t.actions.map((a, idx) => (
                      <button
                        key={idx}
                        className={cx(
                          BTN,
                          a.variant === "danger" ? VAR.danger :
                          a.variant === "primary" ? VAR.primary :
                          a.variant === "warn" ? VAR.warn : VAR.subtle
                        )}
                        onClick={() => handleAction(t, a)}
                      >
                        {a.icon ? a.icon : null}
                        {a.label || "Do"}
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* Footer micro row */}
                <div className="mt-2 flex items-center justify-between">
                  <span className="text-[10px] text-gray-500">{new Date(t.createdAt).toLocaleTimeString()}</span>
                  {!t.sticky && t.ttl ? (
                    <span className="text-[10px] text-gray-500">{isHovered ? "paused" : `${Math.ceil((timersRef.current.get(t.id)?.remaining || t.ttl)/1000)}s`}</span>
                  ) : <span className="text-[10px] text-gray-500">sticky</span>}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {/* Save Session modal (lazy preferred) */}
      {saveOpen ? (
        SaveSessionModalLazy ? (
          <Suspense fallback={null}>
            <SaveSessionModalLazy
              isOpen={true}
              onClose={()=>setSaveOpen(false)}
              domain={domain}
              sessionId={String(saveDefaults.id || "__pending__")}
              defaultTitle={String(saveDefaults.title || "My Session")}
              onSaved={(saved)=>{
                try { eventBus.emit && eventBus.emit("session.saved", { from:"InlineToastAnchor", saved }); } catch(_){}
                // gently celebrate
                try { eventBus.emit && eventBus.emit("ui.toast", { message:"Session saved.", variant:"success", ttl: 2200 }); } catch(_){}
                setSaveOpen(false);
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveSession
            domain={domain}
            sessionId={String(saveDefaults.id || "__pending__")}
            defaultTitle={String(saveDefaults.title || "My Session")}
            onClose={()=>setSaveOpen(false)}
            onSaved={(saved)=>{
              try { eventBus.emit && eventBus.emit("session.saved", { from:"InlineToastAnchor", saved }); } catch(_){}
              try { eventBus.emit && eventBus.emit("ui.toast", { message:"Session saved.", variant:"success", ttl: 2200 }); } catch(_){}
              setSaveOpen(false);
            }}
          />
        )
      ) : null}
    </>
  );
}

/* ---------------------------- Inline Save (Fallback) ------------------------ */
function InlineSaveSession(props){
  const [name, setName] = useState(props.defaultTitle || "");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  function submit(){
    setBusy(true);
    try {
      const payload = { id: props.sessionId, domain: props.domain, title: name, notes };
      try { eventBus.emit && eventBus.emit("session.save.requested", { payload, source: "InlineToastAnchor" }); } catch(_){}
      props.onSaved && props.onSaved(payload);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label="Save session"
      onClick={(e)=>{ if (e.target === e.currentTarget) props.onClose && props.onClose(); }}
    >
      <div className="w-[95vw] max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900">Save Session</h3>
          <button className={cx(BTN, VAR.ghost, "px-2")} onClick={props.onClose} aria-label="Close"><I.X className="h-4 w-4" /></button>
        </div>

        <label className="mt-4 block text-sm font-medium text-gray-700">Title</label>
        <input className="w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
               value={name} onChange={(e)=>setName(e.target.value)} placeholder="Session title" />

        <label className="mt-4 block text-sm font-medium text-gray-700">Notes</label>
        <textarea className="w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600 min-h-[96px]"
                  value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="What should future-you remember?" />

        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VAR.ghost)} onClick={props.onClose}>Cancel</button>
          <button className={cx(BTN, VAR.primary)} onClick={submit} disabled={busy}>
            <I.Save className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

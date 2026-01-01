/* eslint-disable no-console */
// src/components/animals/common/NBAInvokeButton.jsx
//
// Animals → Common → NBAInvokeButton
//
// Purpose
// - One smart button to fetch "Next Best Actions" (NBA) from your orchestrator.
// - Click = quick suggest (applies top pick via onResult); long-press or caret = open menu.
// - Defensive: works if NBA service is missing (falls back to local heuristics).
// - Keyboard-friendly (Ctrl/Cmd+J), optimistic UI, compact + beautiful (Tailwind only).
// - Emits analytics + event bus signals without hard dependencies.
//
// Inspiration
// - Linear's quick actions, GitHub command palette, Notion AI's inline menu.
//
// Props
// - context?: any                         // current selection or page context to hint NBA
// - scope?: "library"|"decider"|"planner"|"logs"|"any"   // hint for orchestrator
// - variant?: "primary"|"secondary"|"ghost"              // visual style
// - size?: "sm"|"md"|"lg"
// - label?: string                        // button label (default "Next Best Action")
// - autoOpen?: boolean                    // open menu on mount (e.g., coachmark moment)
// - disabled?: boolean
// - cooldownMs?: number                   // prevent spam (default 1500ms)
// - onResult?: (choice) => void           // when user picks a suggestion
// - onError?: (err) => void
// - className?: string
//
// Suggestion shape (suggested)
// {
//   id: string,
//   title: string,                         // human label
//   subtitle?: string,
//   icon?: string,                         // optional emoji or icon name
//   confidence?: number,                   // 0..1
//   action?: string,                       // e.g., "queue", "schedule", "open", "edit", "import"
//   payload?: any,                         // domain payload (items to queue, schedule params, etc.)
//   meta?: { group?: string, kind?: string, requires?: string[] }
// }
//
// Integration contract (if NBA service exists)
// - window.ssa.services.nba?.suggest(context, { scope }) -> Promise<{ suggestions: Suggestion[] }>
//   or window.NBAOrchestrator?.suggest(...)
// - If missing, a local heuristic suggestions list is built.
//
// Events / Analytics
// - "animals:nba:invoke"        { scope }
// - "animals:nba:suggestions"   { count, scope }
// - "animals:nba:select"        { id, action, confidence, scope }
// - "animals:nba:error"         { message, scope }
//

import React, { useEffect, useMemo, useRef, useState } from "react";

/* --------------------------------- utils --------------------------------- */
function cx(...a){ return a.filter(Boolean).join(" "); }
function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function pct(n){ return `${Math.round(clamp((n ?? 0)*100, 0, 100))}%`; }

function getServices() {
  return {
    bus: () => (window?.eventBus || window?.ssa?.eventBus || null),
    analytics: () => (window?.ssa?.analytics || null),
    nba: () => (window?.ssa?.services?.nba || window?.NBAOrchestrator || null),
    reminders: () => (window?.ssa?.services?.reminders || window?.ReminderManager || null),
    toast(msg){ try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); } }
  };
}

function nextBusinessMorningISO(hour = 9) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/* ------------------------------ UI primitives ----------------------------- */
function Spinner({ className }) {
  return (
    <svg className={cx("h-4 w-4 animate-spin", className)} viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none"></circle>
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4A4 4 0 008 12H4z"></path>
    </svg>
  );
}

function CaretDown({ className }) {
  return (
    <svg className={cx("h-3 w-3", className)} viewBox="0 0 20 20" fill="currentColor">
      <path d="M5.23 7.21a.75.75 0 011.06.02L10 10.207l3.71-2.977a.75.75 0 11.94 1.166l-4.2 3.368a.75.75 0 01-.94 0l-4.2-3.368a.75.75 0 01.02-1.166z" />
    </svg>
  );
}

/* Simple anchored popover (no portal; self-contained) */
function Popover({ open, anchorRef, onClose, children, align = "right" }) {
  const ref = useRef(null);
  useEffect(()=>{
    const onDoc = (e)=>{ if (!open) return; if (!ref.current) return; if (!anchorRef?.current) return;
      if (!ref.current.contains(e.target) && !anchorRef.current.contains(e.target)) onClose?.();
    };
    document.addEventListener("mousedown", onDoc);
    return ()=>document.removeEventListener("mousedown", onDoc);
  }, [open, onClose, anchorRef]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      className={cx(
        "absolute z-50 mt-1 min-w-[280px] rounded-xl border bg-white p-2 shadow-xl",
        align === "right" ? "right-0" : "left-0"
      )}
      style={{ maxWidth: 360 }}
    >
      {children}
    </div>
  );
}

/* ------------------------------- heuristics ------------------------------- */
function heuristicSuggestions(context, scope) {
  // Lightweight, context-aware local fallbacks when NBA orchestrator is unavailable.
  // We keep things opinionated but safe.
  const items = Array.isArray(context?.items) ? context.items : [];
  const kinds = new Set(items.map(i=>i.kind).filter(Boolean));
  const actions = new Set(items.map(i=>i.action).filter(Boolean));
  const many = items.length >= 3;

  const suggestions = [];

  // 1) If Feed/Water on list → queue & schedule water run
  if (actions.has("Water") || actions.has("Feed")) {
    suggestions.push({
      id: "quick-water-run",
      icon: "💧",
      title: "Schedule water run for tomorrow 9:00",
      subtitle: kinds.size ? `For ${Array.from(kinds).join(", ")}` : "All pens",
      confidence: 0.62,
      action: "schedule",
      payload: { when: nextBusinessMorningISO(9), items }
    });
  }

  // 2) Health attention
  if (actions.has("Deworm") || actions.has("Vaccinate") || actions.has("Inspect")) {
    suggestions.push({
      id: "health-week-plan",
      icon: "🩺",
      title: "Create Health Week plan",
      subtitle: "Group inspect/vaccinate/deworm into an efficient route",
      confidence: 0.66,
      action: "plan-health",
      payload: { window: "this-week", actions: ["Inspect","Vaccinate","Deworm"], items }
    });
  }

  // 3) Butchery batching
  if (actions.has("Butcher") || actions.has("Package")) {
    suggestions.push({
      id: "butchery-batch",
      icon: "🔪",
      title: "Batch butchery & packaging",
      subtitle: "Reserve a single block and prep supplies list",
      confidence: 0.71,
      action: "merge-batch",
      payload: { blockMin: many ? 120 : 60, items }
    });
  }

  // 4) Clean follow-up
  if (actions.has("Clean") && !actions.has("Inspect")) {
    suggestions.push({
      id: "post-clean-inspect",
      icon: "🧼",
      title: "Schedule post-clean inspection",
      subtitle: "Quick checkpoints tomorrow afternoon",
      confidence: 0.58,
      action: "schedule",
      payload: { when: nextBusinessMorningISO(15), items, action: "Inspect" }
    });
  }

  // Always add a safe generic
  suggestions.push({
    id: "review-queue",
    icon: "⚡",
    title: "Queue selected tasks",
    subtitle: items.length ? `${items.length} item${items.length===1?"":"s"}` : "No specific selection",
    confidence: 0.5,
    action: "queue",
    payload: { items }
  });

  return { suggestions };
}

/* ---------------------------------- main ---------------------------------- */
export default function NBAInvokeButton({
  context = {},
  scope = "any",
  variant = "primary",
  size = "md",
  label = "Next Best Action",
  autoOpen = false,
  disabled = false,
  cooldownMs = 1500,
  onResult,
  onError,
  className
}) {
  const Services = useMemo(()=>getServices(),[]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [error, setError] = useState("");
  const [list, setList] = useState([]); // suggestions
  const [ts, setTs] = useState(0);      // last fetch timestamp (ms)
  const anchorRef = useRef(null);
  const longPressRef = useRef(null);

  const sizes = {
    sm: "h-8 px-2 text-xs rounded-lg",
    md: "h-9 px-3 text-xs rounded-lg",
    lg: "h-10 px-3 text-sm rounded-xl",
  }[size] || "h-9 px-3 text-xs rounded-lg";

  const variants = {
    primary: "bg-black text-white hover:opacity-90 border border-black",
    secondary: "bg-white text-black border hover:bg-gray-50",
    ghost: "bg-transparent text-black border hover:bg-gray-50",
  }[variant] || "bg-black text-white hover:opacity-90 border border-black";

  // Keyboard shortcut: Ctrl/Cmd + J
  useEffect(()=>{
    const onKey = (e)=>{
      const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase()==="j") {
        e.preventDefault();
        handleQuickInvoke(); // quick suggest
      }
    };
    window.addEventListener("keydown", onKey);
    return ()=>window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, busy]);

  useEffect(()=>{
    if (autoOpen) {
      fetchSuggestions(true).then(()=> setOpen(true));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cooldownActive = Date.now() < cooldownUntil;

  async function fetchSuggestions(isBackground = false) {
    setError("");
    if (!isBackground) setBusy(true);
    Services.bus()?.emit?.("animals:nba:invoke", { scope });
    Services.analytics()?.track?.("animals:nba:invoke", { scope });

    try {
      const svc = Services.nba();
      let res;
      if (svc?.suggest) {
        res = await svc.suggest(context, { scope });
      } else {
        res = heuristicSuggestions(context, scope);
      }
      const suggestions = Array.isArray(res?.suggestions) ? res.suggestions : [];
      setList(suggestions);
      setTs(Date.now());
      Services.analytics()?.track?.("animals:nba:suggestions", { scope, count: suggestions.length });
      return suggestions;
    } catch (e) {
      console.error(e);
      const msg = (e && (e.message || e.toString())) || "NBA fetch failed";
      setError(msg);
      onError?.(e);
      Services.bus()?.emit?.("animals:nba:error", { scope, message: msg });
      Services.analytics()?.track?.("animals:nba:error", { scope, message: msg });
      return [];
    } finally {
      if (!isBackground) setBusy(false);
    }
  }

  function applyChoice(choice) {
    try {
      onResult?.(choice);
      Services.bus()?.emit?.("animals:nba:select", { id: choice?.id, action: choice?.action, confidence: choice?.confidence, scope });
      Services.analytics()?.track?.("animals:nba:select", { id: choice?.id, action: choice?.action, confidence: choice?.confidence, scope });

      // Opportunistic helper actions (non-breaking):
      if (choice?.action === "schedule" && choice?.payload?.when) {
        try {
          Services.reminders()?.schedule?.({
            title: choice?.title || "Next Best Action",
            notes: choice?.subtitle || "",
            when: choice.payload.when,
            metadata: { scope, id: choice?.id }
          });
        } catch {}
      }

      Services.toast?.("Action applied");
      setOpen(false);
      setCooldownUntil(Date.now() + cooldownMs);
    } catch (e) {
      console.error(e);
      onError?.(e);
    }
  }

  async function handleQuickInvoke() {
    if (disabled || busy || cooldownActive) return;
    // If we have fresh suggestions (<10s), use them; otherwise fetch.
    const fresh = Date.now() - ts < 10_000 && list.length;
    const suggestions = fresh ? list : await fetchSuggestions(true);
    const top = suggestions[0];
    if (!top) {
      Services.toast?.("No suggestions right now");
      setOpen(true);
      return;
    }
    applyChoice(top);
  }

  async function openMenu() {
    if (disabled || busy) return;
    if (!list.length || Date.now() - ts > 10_000) {
      await fetchSuggestions(true);
    }
    setOpen((v)=>!v);
  }

  // Long-press opens the menu (touch/mouse).
  function onPressStart() {
    if (disabled) return;
    longPressRef.current = setTimeout(()=> openMenu(), 350);
  }
  function onPressEnd() {
    if (longPressRef.current) clearTimeout(longPressRef.current);
    longPressRef.current = null;
  }

  /* --------------------------------- render -------------------------------- */
  return (
    <div className={cx("relative inline-flex", className)} ref={anchorRef}>
      {/* primary button */}
      <button
        type="button"
        disabled={disabled || busy || cooldownActive}
        className={cx(
          "inline-flex items-center gap-2 transition",
          sizes,
          variants,
          (disabled || cooldownActive) && "opacity-60 cursor-not-allowed"
        )}
        title={cooldownActive ? "Please wait a moment…" : "Click for best action (Ctrl/Cmd+J). Long-press to open menu."}
        onClick={handleQuickInvoke}
        onMouseDown={onPressStart}
        onMouseUp={onPressEnd}
        onMouseLeave={onPressEnd}
        onTouchStart={onPressStart}
        onTouchEnd={onPressEnd}
        aria-label={label}
      >
        {busy ? <Spinner /> : <span>✨</span>}
        <span className="truncate">{label}</span>
      </button>

      {/* caret to always open menu */}
      <button
        type="button"
        className={cx(
          "ml-1 inline-flex items-center justify-center border px-2",
          sizes,
          "bg-white hover:bg-gray-50"
        )}
        disabled={disabled || busy}
        title="Open suggestions"
        onClick={openMenu}
        aria-label="Open suggestions"
      >
        <CaretDown />
      </button>

      {/* popover menu */}
      <div className="relative">
        <Popover open={open} anchorRef={anchorRef} onClose={()=>setOpen(false)} align="right">
          <div className="mb-1 flex items-center justify-between">
            <div className="text-xs font-medium">Suggestions</div>
            <button
              className="rounded-lg border px-2 py-1 text-[11px] hover:bg-gray-50"
              onClick={()=>fetchSuggestions(false)}
              disabled={busy}
              title="Refresh"
            >
              {busy ? "Fetching…" : "Refresh"}
            </button>
          </div>

          {error ? (
            <div className="mb-2 rounded-lg border border-red-200 bg-red-50 p-2 text-[12px] text-red-700">
              {error}
            </div>
          ) : null}

          {!list.length && !busy ? (
            <div className="rounded-lg border p-3 text-center text-[12px] text-gray-600">
              No suggestions yet. Try refreshing or adjusting your selection.
            </div>
          ) : null}

          <div className="max-h-[320px] overflow-auto">
            {list.map((sug)=>(
              <button
                key={sug.id}
                className="group flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-gray-50"
                onClick={()=>applyChoice(sug)}
              >
                <div className="mt-0.5 text-base leading-none">{sug.icon || "⚡"}</div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate text-sm font-medium">{sug.title}</div>
                    {typeof sug.confidence === "number" ? (
                      <div className="flex items-center gap-1 text-[10px] text-gray-500">
                        <span>{pct(sug.confidence)}</span>
                        <span className="inline-block h-1.5 w-14 overflow-hidden rounded bg-gray-200">
                          <span
                            className="block h-1.5 bg-black"
                            style={{ width: pct(sug.confidence) }}
                          />
                        </span>
                      </div>
                    ) : null}
                  </div>
                  {sug.subtitle ? (
                    <div className="truncate text-[11px] text-gray-600">{sug.subtitle}</div>
                  ) : null}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-gray-500">
                    {sug.action ? <span className="rounded-full border px-2 py-0.5">action: {sug.action}</span> : null}
                    {sug.meta?.group ? <span className="rounded-full border px-2 py-0.5">{sug.meta.group}</span> : null}
                    {sug.meta?.kind ? <span className="rounded-full border px-2 py-0.5">{sug.meta.kind}</span> : null}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="mt-2 flex items-center justify-between">
            <div className="text-[11px] text-gray-500">
              Tip: Use <code>{"Ctrl/Cmd+J"}</code> for quick suggest.
            </div>
            <button
              className="rounded-lg border px-2 py-1 text-[11px] hover:bg-gray-50"
              onClick={()=>setOpen(false)}
            >
              Close
            </button>
          </div>
        </Popover>
      </div>
    </div>
  );
}

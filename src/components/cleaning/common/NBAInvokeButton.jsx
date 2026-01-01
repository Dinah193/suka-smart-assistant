/* eslint-disable no-console */
// src/components/cleaning/common/NBAInvokeButton.jsx
// Cleaning — Next Best Action Invoke Button
//
// Goals aligned with Suka Smart Assistant:
// - One-tap "Suggest Next Steps" for cleaning (respecting zone/frequency/intensity)
// - Strategy dropdown (Auto, Quick Clean, Reset Kitchen, Bathroom Refresh, Laundry Catch-up,
//   Zone Rotation, Deep Clean) + context-driven payload
// - Preview suggestion count when NBA.preview is available
// - Keyboard shortcut: Alt/Option + N (invoke last strategy)
// - Defensive against missing services (eventBus, nba, analytics, reminders, automation)
// - Emits events: cleaning:nba:invoke, cleaning:nba:applied; tracks analytics
// - Compact mode, loading states, and accessible menu
//
// Props:
//   strategy?: string                   // initial strategy key (default: "auto")
//   getContext?: () => object           // function to pull current UI filters/selection/context
//   onSuggestions?: (suggestions) => void  // consume returned suggestions (if any)
//   onApply?: (planOrSuggestions) => void  // hook to auto-apply or inspect
//   variant?: "primary" | "secondary" | "ghost"
//   size?: "sm" | "md"
//   compact?: boolean
//   className?: string
//   disabled?: boolean
//   mode?: "cleaning" | "meals" | "garden" | "animal"  // defaults to "cleaning"
//   label?: string                      // override button label
//   withDropdown?: boolean              // show strategy menu (default true)
//   hotkey?: string                     // override hotkey (e.g., "Alt+n")
//
// Usage:
//   <NBAInvokeButton
//     strategy="auto"
//     getContext={() => ({ filters, selectedTaskIds, householdId })}
//     onSuggestions={(list) => setDrawer({ open: true, list })}
//   />

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* ------------------------------- utils ------------------------------- */
function cx(...a) { return a.filter(Boolean).join(" "); }
function parseHotkey(hk = "Alt+n") {
  const parts = String(hk).toLowerCase().split("+");
  return {
    alt: parts.includes("alt") || parts.includes("option"),
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    meta: parts.includes("meta") || parts.includes("cmd") || parts.includes("command"),
    shift: parts.includes("shift"),
    key: parts[parts.length - 1].replace("alt","").replace("ctrl","").replace("meta","").replace("shift","") || "n",
  };
}

/* ------------------------------ services ----------------------------- */
const Svc = {
  bus: () => window?.eventBus || window?.ssa?.eventBus || null,
  nba: () => window?.ssa?.services?.nba || window?.NBAOrchestrator || null,
  analytics: () => window?.ssa?.analytics || null,
  reminders: () => window?.ssa?.services?.reminders || window?.ReminderManager || null,
  toast(msg) { try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); } },
};

/* ----------------------------- strategies ---------------------------- */
const STRATEGIES = [
  { key: "auto",             label: "Auto (smart pick)", desc: "Let assistant choose based on score, time & friction." },
  { key: "quick-clean",      label: "Quick Clean",       desc: "Fast wins under 20 minutes across zones." },
  { key: "reset-kitchen",    label: "Reset Kitchen",     desc: "High-splash zone reset: dishes, surfaces, floor." },
  { key: "bathroom-refresh", label: "Bathroom Refresh",  desc: "Sinks, toilet swish, mirror, quick mop." },
  { key: "laundry-catchup",  label: "Laundry Catch-up",  desc: "Scan hampers → sort & start first load." },
  { key: "zone-rotation",    label: "Zone Rotation",     desc: "Push neglected zone back into rhythm." },
  { key: "deep-clean",       label: "Deep Clean",        desc: "Select one high-impact deep task this week." },
];

/* Map to NBA intents (cleaning domain) */
function mapStrategyToIntent(key = "auto") {
  switch (key) {
    case "quick-clean": return "cleaning.nba.quick";
    case "reset-kitchen": return "cleaning.nba.kitchen.reset";
    case "bathroom-refresh": return "cleaning.nba.bathroom.refresh";
    case "laundry-catchup": return "cleaning.nba.laundry.catchup";
    case "zone-rotation": return "cleaning.nba.zone.rotation";
    case "deep-clean": return "cleaning.nba.deep";
    case "auto":
    default: return "cleaning.nba.auto";
  }
}

/* ---------------------------- small widgets -------------------------- */
function Caret() {
  return (
    <svg viewBox="0 0 20 20" className="h-3 w-3" aria-hidden="true">
      <path d="M5 7l5 6 5-6H5z" />
    </svg>
  );
}

function Spinner({ size = "sm" }) {
  const s = size === "sm" ? "h-4 w-4" : "h-5 w-5";
  return (
    <svg className={cx("animate-spin", s)} viewBox="0 0 24 24" aria-label="Loading">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" />
      <path className="opacity-75" d="M4 12a8 8 0 018-8" fill="currentColor" />
    </svg>
  );
}

/* ------------------------------ main --------------------------------- */
export default function NBAInvokeButton({
  strategy: strategyProp = "auto",
  getContext,
  onSuggestions,
  onApply,
  variant = "primary",
  size = "md",
  compact = false,
  className,
  disabled = false,
  mode = "cleaning",
  label,
  withDropdown = true,
  hotkey = "Alt+n",
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(null);
  const [lastStrategy, setLastStrategy] = useState(strategyProp);

  const btnRef = useRef(null);
  const hk = useMemo(() => parseHotkey(hotkey), [hotkey]);

  // Preview count when idle (debounced-ish on strategy change)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const nba = Svc.nba();
        if (!nba?.preview) { setCount(null); return; }
        const payload = buildPayload(lastStrategy, getContext?.(), mode);
        const res = await nba.preview?.(payload);
        if (!cancelled) setCount(Array.isArray(res) ? res.length : (res?.count ?? null));
      } catch {
        if (!cancelled) setCount(null);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStrategy, mode]);

  // Hotkey: Alt/Opt+N to invoke last strategy
  useEffect(() => {
    const onKey = (e) => {
      const key = String(e.key || "").toLowerCase();
      if ((!!hk.alt === e.altKey) && (!!hk.ctrl === e.ctrlKey) && (!!hk.meta === e.metaKey) && (!!hk.shift === e.shiftKey) && key === hk.key) {
        e.preventDefault();
        invoke(lastStrategy);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hk, lastStrategy]); // eslint-disable-line react-hooks/exhaustive-deps

  const styles = useMemo(() => {
    const base = "inline-flex items-center gap-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-black/30";
    const sizes = size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm";
    const variants = {
      primary: "bg-black text-white hover:opacity-90 disabled:opacity-50",
      secondary: "border hover:bg-gray-50 disabled:opacity-50",
      ghost: "hover:bg-gray-50 disabled:opacity-50",
    };
    return {
      root: cx(base, sizes, variants[variant], className),
      menuBtn: cx("rounded-lg border px-2 py-1 text-xs hover:bg-gray-50"),
      badge: "ml-1 rounded-full border px-1.5 py-0.5 text-[10px]",
    };
  }, [variant, size, className]);

  const menu = useMemo(() => STRATEGIES, []);

  const buildPayload = useCallback((key, context, modeArg) => {
    const intent = mapStrategyToIntent(key);
    const ctx = context || {};
    // Normalize expected context fields; tolerate missing:
    const normalized = {
      mode: modeArg || "cleaning",
      intent,
      filters: ctx.filters || {},
      selectedIds: ctx.selectedTaskIds || ctx.selectedIds || [],
      householdId: ctx.householdId || ctx.household || undefined,
      nowIso: new Date().toISOString(),
      // Hints derived from decider/planner patterns:
      hints: {
        respectSabbath: !!ctx.sabbath?.enabled,
        quietHours: ctx.quietHours || { start: 21, end: 7 },
        targetZones: ctx.filters?.zones || ctx.zones || [],
        frequency: ctx.filters?.frequency || ctx.frequency || [],
        intensity: ctx.filters?.intensity || ctx.intensity || [],
        duration: ctx.filters?.duration || ctx.duration || [],
      },
    };
    return normalized;
  }, []);

  async function invoke(key) {
    if (disabled || busy) return;
    const nba = Svc.nba();
    const hasAPI = !!nba?.suggest;
    const payload = buildPayload(key, getContext?.(), mode);

    setBusy(true);
    Svc.bus()?.emit?.("cleaning:nba:invoke", { strategy: key, payload });
    Svc.analytics()?.track?.("cleaning:nba:invoke", { strategy: key });

    try {
      let suggestions = null;
      if (hasAPI) {
        suggestions = await nba.suggest(payload); // expected: array or plan
      } else {
        // graceful local fallback: suggest a generic quick routine
        suggestions = fallbackSuggest(payload);
      }

      onSuggestions?.(suggestions);
      // Auto-apply hook if caller wants
      onApply?.(suggestions);

      Svc.bus()?.emit?.("cleaning:nba:applied", { strategy: key, suggestions });
      Svc.toast(labelFor(key) + " ready");
      setLastStrategy(key);
    } catch (e) {
      console.error(e);
      Svc.toast("Couldn’t fetch suggestions");
    } finally {
      setBusy(false);
    }
  }

  function fallbackSuggest(payload) {
    const zones = payload?.hints?.targetZones?.length ? payload.hints.targetZones : ["Kitchen", "Bathrooms"];
    const firstZone = zones[0];
    return [
      {
        id: `nbaf-${firstZone}-reset`,
        title: `Reset ${firstZone}`,
        steps: [
          "Clear surfaces",
          "Spray & wipe counters",
          "Spot-sweep / quick mop",
        ],
        estMinutes: 15,
        zone: firstZone,
        frequency: "As-Needed",
        intensity: "Tidy",
      },
    ];
  }

  function labelFor(key) {
    return STRATEGIES.find((s) => s.key === key)?.label || "Suggest";
  }

  return (
    <div className="relative inline-flex">
      <button
        ref={btnRef}
        type="button"
        className={styles.root}
        onClick={() => invoke(lastStrategy)}
        disabled={disabled || busy}
        title={label || "Next Best Action"}
        aria-busy={busy ? "true" : "false"}
      >
        {busy ? <Spinner size={size === "sm" ? "sm" : "md"} /> : null}
        <span>{label || "Suggest Next Step"}</span>
        {typeof count === "number" ? (
          <span className={styles.badge} aria-label="Suggestion count">{count}</span>
        ) : null}
        {withDropdown && (
          <span className="ml-1 opacity-70" aria-hidden="true"><Caret /></span>
        )}
      </button>

      {withDropdown && (
        <div className="relative">
          {/* Simple anchored menu */}
          {open && (
            <div
              className="absolute right-0 z-20 mt-2 w-64 rounded-xl border bg-white p-2 shadow-lg"
              role="menu"
              aria-label="NBA strategy menu"
            >
              {menu.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  role="menuitem"
                  className={cx(
                    "w-full rounded-lg px-3 py-2 text-left hover:bg-gray-50",
                    m.key === lastStrategy && "ring-1 ring-black/20"
                  )}
                  onClick={() => { setOpen(false); invoke(m.key); }}
                  title={m.desc}
                >
                  <div className="text-xs font-medium">{m.label}</div>
                  <div className="text-[11px] text-gray-500">{m.desc}</div>
                </button>
              ))}
            </div>
          )}
          {/* Invisible toggle target next to button to avoid nested buttons */}
          <button
            type="button"
            className="ml-2 rounded-lg border px-2 py-1 text-xs hover:bg-gray-50"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={open ? "true" : "false"}
            title="Choose strategy"
          >
            Strategy
          </button>
        </div>
      )}
    </div>
  );
}

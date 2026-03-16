// C:\Users\larho\suka-smart-assistant\src\components\homestead\DismissibleTip.jsx
//
// DismissibleTip
// --------------
// A deterministic, local-first tip/coachmark component with "Don't show again" support.
//
// Persistence:
// - Prefers homestead_visibility_state repo (src/services/repos/homestead/visibilityState.repo.js)
// - Falls back to localStorage if repo is unavailable
//
// State shape (flexible; adapts safely):
// - dismissedTips: { [tipKey: string]: true }
// OR
// - dismissed: { [tipKey: string]: true }
// OR
// - dismissedPanels / dismissedSections style maps (we store under dismissedTips by default)
//
// Props:
// - householdId?: string (recommended)
// - tipKey: string (required) unique identifier for this tip
// - title?: ReactNode
// - children: ReactNode (tip content)
// - icon?: ReactNode
// - tone?: "info" | "success" | "warning" | "danger" | "neutral" (default "info")
// - compact?: boolean (default false)
// - showClose?: boolean (default true)   // closes for this session (unless dontShowAgain is clicked)
// - showDontShowAgain?: boolean (default true)
// - dontShowAgainLabel?: string (default "Don't show again")
// - closeLabel?: string (default "Close")
// - onDismiss?: (ctx) => void            // called when "Don't show again" is set
// - onClose?: () => void                 // called when the tip is closed (session-level hide)
// - className?: string
//
// Notes:
// - "Close" hides for current mount only.
// - "Don't show again" persists dismissal.
//
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as VisibilityStateRepo from "@/services/repos/homestead/visibilityState.repo";

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function safeJsonParse(str, fallback) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function storageKey(householdId) {
  return `ssa.homestead.visibilityState::${String(householdId || "anonymous")}`;
}

function readLocal(householdId) {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(storageKey(householdId));
  if (!raw) return null;
  return safeJsonParse(raw, null);
}

function writeLocal(householdId, nextState) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(householdId),
      JSON.stringify(nextState),
    );
  } catch {
    // ignore
  }
}

async function repoGet(householdId) {
  try {
    if (typeof VisibilityStateRepo.getByHouseholdId === "function") {
      return await VisibilityStateRepo.getByHouseholdId(String(householdId));
    }
    if (typeof VisibilityStateRepo.getState === "function") {
      return await VisibilityStateRepo.getState(String(householdId));
    }
    return null;
  } catch {
    return null;
  }
}

async function repoUpsert(householdId, patch) {
  try {
    if (typeof VisibilityStateRepo.upsertByHouseholdId === "function") {
      return await VisibilityStateRepo.upsertByHouseholdId(
        String(householdId),
        patch,
      );
    }
    if (typeof VisibilityStateRepo.saveState === "function") {
      return await VisibilityStateRepo.saveState(String(householdId), patch);
    }
    return null;
  } catch {
    return null;
  }
}

function ensureObj(x) {
  return x && typeof x === "object" ? x : {};
}

function deepClone(obj) {
  return obj ? safeJsonParse(JSON.stringify(obj), obj) : obj;
}

function getPath(obj, path, fallback) {
  try {
    const parts = path.split(".");
    let cur = obj;
    for (const p of parts) {
      if (!cur || typeof cur !== "object") return fallback;
      cur = cur[p];
    }
    return cur == null ? fallback : cur;
  } catch {
    return fallback;
  }
}

function setPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function DefaultIcon() {
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-black/5"
    >
      💡
    </span>
  );
}

function toneClasses(tone) {
  switch (tone) {
    case "success":
      return {
        wrap: "border-emerald-200 bg-emerald-50",
        title: "text-emerald-900",
        body: "text-emerald-900/80",
        btn: "bg-emerald-900 text-white hover:bg-emerald-900/90",
      };
    case "warning":
      return {
        wrap: "border-amber-200 bg-amber-50",
        title: "text-amber-950",
        body: "text-amber-950/80",
        btn: "bg-amber-900 text-white hover:bg-amber-900/90",
      };
    case "danger":
      return {
        wrap: "border-red-200 bg-red-50",
        title: "text-red-950",
        body: "text-red-950/80",
        btn: "bg-red-700 text-white hover:bg-red-700/90",
      };
    case "neutral":
      return {
        wrap: "border-black/10 bg-white",
        title: "text-black",
        body: "text-black/70",
        btn: "bg-black text-white hover:bg-black/90",
      };
    case "info":
    default:
      return {
        wrap: "border-sky-200 bg-sky-50",
        title: "text-sky-950",
        body: "text-sky-950/80",
        btn: "bg-sky-900 text-white hover:bg-sky-900/90",
      };
  }
}

function Button({
  children,
  onClick,
  disabled,
  variant = "ghost",
  className,
  type = "button",
}) {
  const base =
    "inline-flex items-center justify-center rounded-lg px-3 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-black/20 disabled:opacity-50";
  const variants = {
    ghost: "bg-transparent hover:bg-black/5",
    subtle: "bg-black/5 hover:bg-black/10",
    primary: "bg-black text-white hover:bg-black/90",
  };
  return (
    <button
      type={type}
      className={cx(base, variants[variant], className)}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export default function DismissibleTip({
  householdId,
  tipKey,
  title,
  children,
  icon,
  tone = "info",
  compact = false,
  showClose = true,
  showDontShowAgain = true,
  dontShowAgainLabel = "Don't show again",
  closeLabel = "Close",
  onDismiss,
  onClose,
  className,
}) {
  if (!tipKey) {
    throw new Error("[DismissibleTip] tipKey is required");
  }

  const hId = String(householdId || "anonymous");
  const mountedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [state, setState] = useState(null);
  const [closed, setClosed] = useState(false);

  // Load visibility state (repo → local)
  useEffect(() => {
    let alive = true;
    setLoading(true);

    (async () => {
      const repoState = await repoGet(hId);
      const localState = readLocal(hId);

      const base = repoState ||
        localState || {
          householdId: hId,
          updatedAt: nowIso(),
          dismissedTips: {},
        };

      if (!alive) return;

      setState(base);
      setLoading(false);
      mountedRef.current = true;
    })();

    return () => {
      alive = false;
    };
  }, [hId]);

  const isDismissed = useMemo(() => {
    const s = ensureObj(state);

    const dismissedTips = ensureObj(getPath(s, "dismissedTips", {}));
    if (dismissedTips[tipKey] === true) return true;

    // Back-compat fallbacks
    const dismissed = ensureObj(getPath(s, "dismissed", {}));
    if (dismissed[tipKey] === true) return true;

    const dismissedPanels = ensureObj(getPath(s, "dismissedPanels", {}));
    if (dismissedPanels[tipKey] === true) return true;

    // Also allow a nested dismissedTips map under a "homestead" namespace if someone used it
    const homesteadDismissedTips = ensureObj(
      getPath(s, "homestead.dismissedTips", {}),
    );
    if (homesteadDismissedTips[tipKey] === true) return true;

    return false;
  }, [state, tipKey]);

  async function persistPatch(mutator) {
    const prev = ensureObj(state);
    const next = deepClone(prev) || {};
    next.householdId = next.householdId || hId;
    next.updatedAt = nowIso();

    mutator(next);

    setState(next);

    writeLocal(hId, next);
    await repoUpsert(hId, next);
  }

  function handleClose() {
    setClosed(true);
    if (typeof onClose === "function") onClose();
  }

  function handleDontShowAgain() {
    void persistPatch((draft) => {
      const base = ensureObj(getPath(draft, "dismissedTips", {}));
      base[tipKey] = true;
      setPath(draft, "dismissedTips", base);
    });

    setClosed(true);

    if (typeof onDismiss === "function") {
      onDismiss({
        householdId: hId,
        tipKey,
        dismissedAt: nowIso(),
      });
    }
  }

  if (loading) return null;
  if (closed) return null;
  if (isDismissed) return null;

  const t = toneClasses(tone);

  return (
    <div
      className={cx(
        "rounded-xl border p-4 shadow-sm",
        t.wrap,
        compact ? "p-3" : "p-4",
        className,
      )}
      role="note"
      aria-label={typeof title === "string" ? title : "Tip"}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0">{icon || <DefaultIcon />}</div>

        <div className="min-w-0 flex-1">
          {title ? (
            <div className={cx("text-sm font-bold", t.title)}>{title}</div>
          ) : null}

          <div className={cx("mt-1 text-sm leading-relaxed", t.body)}>
            {children}
          </div>

          {showClose || showDontShowAgain ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {showDontShowAgain ? (
                <Button
                  variant="primary"
                  onClick={handleDontShowAgain}
                  className={t.btn}
                >
                  {dontShowAgainLabel}
                </Button>
              ) : null}

              {showClose ? (
                <Button variant="ghost" onClick={handleClose}>
                  {closeLabel}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

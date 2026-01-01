// src/components/meals/decider/DeciderQuickActions.jsx
import React, { useEffect, useMemo, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try { Icons = require("lucide-react"); } catch {}

let eventBus = null;
try { eventBus = require("@/services/eventBus").eventBus || null; } catch {}

let automation = null;
try { automation = require("@/services/automation/runtime").automation || null; } catch {}

let useMealPlanStore = () => null;
try {
  const mod = require("@/store/MealPlanStore");
  useMealPlanStore = mod.useMealPlanStore || useMealPlanStore;
} catch {}

let useInventoryStore = () => null;
try {
  const mod = require("@/store/InventoryStore");
  useInventoryStore = mod.useInventoryStore || useInventoryStore;
} catch {}

let Exporter = null;
try {
  // optional export util (household menu format)
  Exporter = require("@/utils/exporters/HouseholdMenuExporter").default || null;
} catch {}

/* --------------------------------- Utilities --------------------------------- */
const clamp = (n, a = 0, b = 100) => Math.max(a, Math.min(b, Number.isFinite(n) ? n : a));
const asUsd = (v) =>
  typeof v === "number" && !Number.isNaN(v)
    ? v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 })
    : "—";

const noopToast = (level, message) => console[level === "error" ? "error" : "log"](message);
let toast = { success: (m) => noopToast("log", m), error: (m) => noopToast("error", m), info: (m) => noopToast("log", m) };
try {
  toast = require("react-toastify").toast || toast;
} catch {}

/* ------------------------------ Sabbath/Feast check --------------------------- */
/** Callers pass sabbathGuard and feast context in props.decision.calendar */
const isInSabbathWindow = (decision) => !!decision?.calendar?.sabbathGuard;
const feastDayLabel = (decision) => decision?.calendar?.feastDay || null;

/* ------------------------------- Main component ------------------------------ */
/**
 * DeciderQuickActions
 *
 * A compact action bar for a chosen meal decision.
 *
 * Props:
 * - decision: {
 *     id, title, slot, date,
 *     recipeId, estCookMins, budget?: { estCost },
 *     inventory?: { matchPct },
 *     calendar?: { sabbathGuard?: boolean, feastDay?: string },
 *     tags?: string[]
 *   }
 * - householdId?: string
 * - onAction?: (type, payload) => void    // fires after internal emit/automation
 * - dense?: boolean
 */
const DeciderQuickActions = ({ decision, householdId = "default", onAction, dense = false }) => {
  const store = useMealPlanStore ? useMealPlanStore() : null;
  const invStore = useInventoryStore ? useInventoryStore() : null;

  const [locked, setLocked] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [liked, setLiked] = useState(false);
  const [disliked, setDisliked] = useState(false);
  const [busy, setBusy] = useState(false);

  const sabbathNow = isInSabbathWindow(decision);
  const feastLabel = feastDayLabel(decision);

  const {
    Plus = () => null,
    RotateCw = () => null,
    ArrowLeftRight = () => null,
    Soup = () => null,
    ShoppingCart = () => null,
    Lock = () => null,
    Unlock = () => null,
    Pin = () => null,
    PinOff = () => null,
    ThumbsUp = () => null,
    ThumbsDown = () => null,
    CalendarPlus = () => null,
    Upload = () => null,
    Timer = () => null,
    ShieldCheck = () => null,
    Sparkles = () => null,
    Info = () => null,
  } = Icons;

  /* --------------------------------- Emit helper ------------------------------ */
  const emit = (type, payload) => {
    try { eventBus?.emit?.(`meals.decider.quick.${type}`, payload); } catch {}
    try { automation?.runTemplate?.(`meals.decider.quick.${type}`, payload); } catch {}
    onAction?.(type, payload);
  };

  /* --------------------------------- Core actions ----------------------------- */
  const doAddToPlan = async (mode = "add") => {
    if (!decision) return;
    const payload = { mode, decision, householdId, ts: Date.now() };
    try {
      setBusy(true);
      // optional direct store integration, when present
      if (store?.addToPlan && mode === "add") {
        store.addToPlan(decision);
      } else if (store?.replaceInPlan && mode === "replace") {
        store.replaceInPlan(decision.slot, decision.date, decision);
      }
      emit(mode === "replace" ? "replace" : "add", payload);
      toast.success(mode === "replace" ? "Replaced in plan." : "Added to plan.");
    } catch (e) {
      toast.error("Could not update plan.");
    } finally {
      setBusy(false);
    }
  };

  const doSwap = () => {
    const payload = { decision, householdId, ts: Date.now() };
    emit("swap.start", payload);
    toast.info("Select a meal to swap with…");
    // A swap flow can be handled by a modal/listener elsewhere.
  };

  const doBatchCook = () => {
    const payload = { decision, householdId, ts: Date.now() };
    try {
      eventBus?.emit?.("batch.queue.add", { recipeId: decision?.recipeId, title: decision?.title, qty: 1 });
    } catch {}
    emit("batch.added", payload);
    toast.success("Added to Batch Cooking Queue.");
  };

  const doGrocery = () => {
    const payload = { decision, householdId, ts: Date.now() };
    try {
      eventBus?.emit?.("grocery.list.addDecision", payload);
    } catch {}
    emit("grocery", payload);
    toast.success("Sent to Grocery List.");
  };

  const doCopyNextWeek = () => {
    const payload = { decision, householdId, ts: Date.now() };
    try {
      eventBus?.emit?.("meals.plan.copyToNextWeek", payload);
    } catch {}
    emit("copyNextWeek", payload);
    toast.success("Copied to next week.");
  };

  const doExportMenu = async () => {
    const payload = { householdId, ts: Date.now(), format: "householdMenu" };
    try {
      if (Exporter) {
        await Exporter.exportCurrent(householdId);
        toast.success("Household Menu exported.");
      } else {
        // Fallback: let a listener handle this
        eventBus?.emit?.("meals.plan.export.householdMenu", payload);
        toast.info("Export requested.");
      }
      emit("export", payload);
    } catch {
      toast.error("Export failed.");
    }
  };

  const doCookNow = () => {
    if (sabbathNow) {
      toast.info("Sabbath Guard is active — switching to Reheat/Cold prep mode.");
      emit("cookNow.blockedBySabbath", { decision, householdId });
      return;
    }
    const payload = { decision, householdId, ts: Date.now() };
    try { eventBus?.emit?.("meals.session.start", payload); } catch {}
    emit("cookNow", payload);
    toast.success("Cooking session started.");
  };

  /* -------------------------- Preferences: pin/lock/like ---------------------- */
  const toggleLock = () => {
    const next = !locked;
    setLocked(next);
    emit(next ? "lock" : "unlock", { decisionId: decision?.id, locked: next, householdId });
    toast.info(next ? "Locked into slot." : "Unlocked.");
  };

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    emit(next ? "pin" : "unpin", { decisionId: decision?.id, pinned: next, householdId });
    toast.info(next ? "Pinned to top." : "Unpinned.");
  };

  const setLike = (v) => {
    setLiked(v);
    if (v) setDisliked(false);
    emit("like", { decisionId: decision?.id, liked: v, householdId });
  };

  const setDislike = (v) => {
    setDisliked(v);
    if (v) setLiked(false);
    emit("dislike", { decisionId: decision?.id, disliked: v, householdId });
  };

  /* --------------------------------- Derived UI -------------------------------- */
  const cost = decision?.budget?.estCost;
  const inv = clamp(decision?.inventory?.matchPct ?? 0);

  /* ----------------------------------- UI ------------------------------------- */
  const Btn = ({ title, onClick, disabled, icon: Ico, children }) => (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 ${dense ? "py-1 text-xs" : "py-1.5 text-sm"} hover:bg-gray-50 disabled:opacity-40`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {Ico ? <Ico className={dense ? "w-3.5 h-3.5" : "w-4 h-4"} /> : null}
      {children}
    </button>
  );

  return (
    <div className={`rounded-xl border p-3 bg-white/80 backdrop-blur`}>
      {/* Header summary row */}
      <div className="flex items-center justify-between mb-2">
        <div className="min-w-0">
          <div className="text-sm font-medium truncate">{decision?.title || "Meal"}</div>
          <div className="text-xs text-gray-600">
            {decision?.slot || "—"} {decision?.date ? `• ${decision.date}` : ""}
            {typeof cost === "number" ? <> • Est {asUsd(cost)}</> : null}
            {Number.isFinite(inv) ? <> • {inv}% on-hand</> : null}
            {feastLabel ? <> • <span className="text-blue-700">{feastLabel}</span></> : null}
          </div>
        </div>
        {sabbathNow ? (
          <div className="inline-flex items-center gap-1 text-[11px] text-emerald-700">
            <ShieldCheck className="w-3.5 h-3.5" />
            Sabbath Guard
          </div>
        ) : null}
      </div>

      {/* Primary action group */}
      <div className="flex flex-wrap items-center gap-2">
        <Btn title="Add to plan" onClick={() => doAddToPlan("add")} icon={Plus} disabled={busy}>Add</Btn>
        <Btn title="Replace in plan" onClick={() => doAddToPlan("replace")} icon={RotateCw} disabled={busy}>Replace</Btn>
        <Btn title="Swap with another meal" onClick={doSwap} icon={ArrowLeftRight}>Swap</Btn>
        <Btn title="Start cooking session" onClick={doCookNow} icon={Soup} disabled={busy}>Cook now</Btn>
        <Btn title="Add to Batch Cooking Queue" onClick={doBatchCook} icon={Sparkles}>Batch</Btn>
        <Btn title="Send ingredients to Grocery List" onClick={doGrocery} icon={ShoppingCart}>Grocery</Btn>
      </div>

      {/* Secondary controls */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Btn title={locked ? "Unlock slot" : "Lock into slot"} onClick={toggleLock} icon={locked ? Unlock : Lock}>
          {locked ? "Unlock" : "Lock"}
        </Btn>
        <Btn title={pinned ? "Unpin from top" : "Pin to top"} onClick={togglePin} icon={pinned ? PinOff : Pin}>
          {pinned ? "Unpin" : "Pin"}
        </Btn>
        <Btn title="I like this" onClick={() => setLike(!liked)} icon={ThumbsUp}>
          {liked ? "Liked" : "Like"}
        </Btn>
        <Btn title="Not a good fit" onClick={() => setDislike(!disliked)} icon={ThumbsDown}>
          {disliked ? "Disliked" : "Dislike"}
        </Btn>
        <Btn title="Copy to next week" onClick={doCopyNextWeek} icon={CalendarPlus}>Next week</Btn>
        <Btn title="Export Household Menu" onClick={doExportMenu} icon={Upload}>Export menu</Btn>
        {decision?.estCookMins ? (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-600">
            <Timer className="w-3.5 h-3.5" />
            ~{decision.estCookMins} min
          </span>
        ) : null}
      </div>

      {/* Helper note */}
      <div className="mt-2 text-[11px] text-gray-500 flex items-start gap-1.5">
        <Info className="w-3.5 h-3.5 mt-[2px]" />
        <span>
          “Cook now” respects Sabbath Guard; on feast days we’ll keep feast-aligned dishes visible and prefer make-ahead or reheat options.
        </span>
      </div>
    </div>
  );
};

export default DeciderQuickActions;

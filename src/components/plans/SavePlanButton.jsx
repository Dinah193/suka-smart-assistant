// SavePlanButton — Save/adopt user plans + toggle favorites (domain-aware, event-driven)
/* eslint-disable no-console */
import React, { useEffect, useMemo, useRef, useState } from "react";

/* --------------------------------- Imports -------------------------------- */
let useFavoritePlans = null;
try {
  const mod = require("@/hooks/useFavoritePlans");
  useFavoritePlans = mod?.default || null;
} catch (_e) {}

let eventBus = { on(){}, off(){}, emit(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let automation = null;
try {
  const rt = require("@/services/automation/runtime");
  automation = rt?.automation || rt?.default || null;
} catch (_e) {}

let PlanStorageFactory = null; // fallback when hook is unavailable
try {
  const psr = require("@/managers/storage/PlanStorageRouter");
  PlanStorageFactory = psr?.createPlanStorageRouter || null;
} catch (_e) {}

let FavoritePlanEditorModal = null;
try {
  const mod = require("@/components/plans/FavoritePlanEditorModal.jsx");
  FavoritePlanEditorModal = mod?.default || null;
} catch (_e) {}

const isBrowser = typeof window !== "undefined";

/* ------------------------------- SVG Icons -------------------------------- */
function IconHeart({ filled, className }) {
  return filled ? (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12.1 21.35l-.1.1-.11-.1C7.14 17.24 4 14.39 4 10.99 4 8.58 5.99 6.6 8.4 6.6c1.33 0 2.61.57 3.6 1.49a5.12 5.12 0 013.6-1.49c2.41 0 4.4 1.98 4.4 4.39 0 3.4-3.14 6.25-7.9 10.36z" />
    </svg>
  ) : (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 6.6c-1.33 0-2.61.57-3.6 1.49A5.12 5.12 0 008.8 6.6C6.39 6.6 4.4 8.58 4.4 11c0 3.4 3.14 6.25 7.9 10.36C17.06 17.25 20.2 14.4 20.2 11c0-2.42-1.99-4.4-4.4-4.4zm0-1.6c3.31 0 6 2.69 6 6 0 3.97-3.8 7.34-8.97 12.04L12 23l-.03-.03C6.8 18.34 3 14.97 3 11c0-3.31 2.69-6 6-6 1.76 0 3.35.76 4.47 1.97A6.96 6.96 0 0116 5z" />
    </svg>
  );
}
function IconSave({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M17 3H5a2 2 0 00-2 2v14l4-4h10a2 2 0 002-2V5a2 2 0 00-2-2zm-3 6H7V7h7v2z" />
    </svg>
  );
}
function IconChevron({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5.23 7.21a.75.75 0 011.06.02L10 10.17l3.71-2.94a.75.75 0 01.92 1.18l-4.2 3.33a.75.75 0 01-.92 0l-4.2-3.33a.75.75 0 01-.02-1.06z" />
    </svg>
  );
}

/* ------------------------------- Component -------------------------------- */
/**
 * @param {object} props
 * @param {object} props.plan          The plan object (featured or user-authored)
 * @param {string} props.userId        User id for scoping saves & favorites
 * @param {string} props.domain        Domain (meals|cleaning|garden|animals|...)
 * @param {"solid"|"outline"|"ghost"} [props.variant="solid"]
 * @param {boolean} [props.compact=false]
 * @param {function=} props.onAfterSave (savedPlan)=>void
 * @param {boolean=} props.showFavoriteHeart
 * @param {boolean=} props.preferModal  Primary click opens modal (default: true)
 * @param {boolean=} props.showAdvancedJson Pass-through to modal JSON editor
 */
export default function SavePlanButton({
  plan,
  userId = "anon",
  domain = "meals",
  variant = "solid",
  compact = false,
  onAfterSave,
  showFavoriteHeart = true,
  preferModal = true,
  showAdvancedJson = false,
}) {
  const hasHook = typeof useFavoritePlans === "function";

  // ----------------------- Hook-based manager (if any) -----------------------
  const {
    state,
    saveUserPlan: hookSaveUserPlan,
    adoptFeatured: hookAdoptFeatured,
    toggleFavorite: hookToggleFavorite,
    get: hookGet,
  } = hasHook
    ? useFavoritePlans({ userId, domain, only: "all" })
    : {
        state: { items: [], loading: false },
        saveUserPlan: null,
        adoptFeatured: null,
        toggleFavorite: null,
        get: null,
      };

  // ---------------------- Fallback: PlanStorageRouter -----------------------
  const routerRef = useRef(null);
  const [routerReady, setRouterReady] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (routerRef.current || !PlanStorageFactory) return setRouterReady(!!routerRef.current);
      try {
        const router = await PlanStorageFactory({ userId });
        routerRef.current = router;
      } catch (_e) {
        routerRef.current = null;
      } finally {
        if (alive) setRouterReady(!!routerRef.current);
      }
    })();
    return () => { alive = false; };
  }, [userId]);

  const getRouter = () => routerRef.current;

  // ----------------------------- Derived state ------------------------------
  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [fallbackFavorite, setFallbackFavorite] = useState(!!plan?.isFavorite);
  const btnRef = useRef(null);

  const source = plan?.meta?.source || "featured";
  const createdBy = plan?.meta?.createdBy || null;
  const isMine = source === "user" && createdBy === userId;

  // Discover current favorite state
  const isFavorite = useMemo(() => {
    if (hasHook) {
      const fromList = (state?.items || []).find((p) => p.id === plan?.id);
      if (fromList) return !!fromList.isFavorite;
      return !!plan?.isFavorite;
    }
    return fallbackFavorite;
  }, [hasHook, state?.items, plan?.id, plan?.isFavorite, fallbackFavorite]);

  // If we’re on the router fallback, try to sync favorite on mount/plan change
  useEffect(() => {
    let alive = true;
    (async () => {
      if (hasHook || !routerReady || !plan?.id) return;
      try {
        const favs = await getRouter().listFavorites({ userId, domain, limit: 1000 });
        const found = !!(favs || []).find((p) => p.id === plan.id);
        if (alive) setFallbackFavorite(found);
      } catch (_e) {}
    })();
    return () => { alive = false; };
  }, [hasHook, routerReady, userId, domain, plan?.id]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen || !isBrowser) return;
    const onDoc = (e) => {
      const pop = document.getElementById(getMenuId());
      if (!btnRef.current || !pop) return;
      if (!pop.contains(e.target) && !btnRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const getMenuId = () => `saveplan-menu-${plan?.id || "new"}`;

  const label = isMine ? "Edit & Save" : "Save to My Plans";
  const title = isMine ? "Open editor to update your plan" : "Open editor to create your own copy";

  // ------------------------------- Styles -----------------------------------
  const styleBase =
    "inline-flex items-center gap-2 rounded-xl border text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 transition";
  const styleSolid =
    "bg-blue-600 text-white border-blue-600 hover:bg-blue-700 focus-visible:ring-blue-500";
  const styleOutline =
    "bg-white text-blue-700 border-blue-600 hover:bg-blue-50 focus-visible:ring-blue-500";
  const styleGhost =
    "bg-transparent text-blue-700 border-transparent hover:bg-blue-50 focus-visible:ring-blue-500";
  const pad = compact ? "px-3 py-1.5" : "px-4 py-2";
  const btnClass =
    styleBase +
    " " +
    pad +
    " " +
    (variant === "outline" ? styleOutline : variant === "ghost" ? styleGhost : styleSolid);

  // ----------------------------- Helpers (save) -----------------------------
  async function saveWithHookOrRouter(nextPlan, { favorite = false } = {}) {
    // Prefer hook if available; otherwise fall back to PlanStorageRouter
    if (hasHook && hookSaveUserPlan && hookAdoptFeatured) {
      if (isMine) return hookSaveUserPlan(nextPlan);
      return hookAdoptFeatured({
        planId: nextPlan?.id || plan.id,
        domain: nextPlan?.domain || domain,
        favorite,
      });
    }

    // Fallback via PlanStorageRouter
    const router = getRouter();
    if (!router) throw new Error("Storage not ready");

    if (isMine) {
      return router.savePlan(
        {
          ...(nextPlan || plan),
          domain: (nextPlan?.domain || plan?.domain || domain),
          meta: {
            ...((nextPlan || plan)?.meta || {}),
            source: "user",
            createdBy: userId,
          },
        },
        { scope: "user", userId, overwrite: false, favorite }
      );
    } else {
      const base = nextPlan || plan;
      const cloned = {
        ...base,
        id: undefined, // let router normalize a new id
        domain: base?.domain || domain,
        title: base?.title || "Untitled Plan",
        meta: { ...(base?.meta || {}), source: "user", createdBy: userId },
      };
      const saved = await router.savePlan(cloned, { scope: "user", userId, overwrite: false, favorite });
      try { router.afterSaveOrchestrate?.(saved); } catch (_e) {}
      return saved;
    }
  }

  async function toggleFavoriteWithHookOrRouter(planId, dom) {
    if (hasHook && hookToggleFavorite) return hookToggleFavorite({ planId, domain: dom });
    const router = getRouter();
    if (!router) throw new Error("Storage not ready");
    const res = await router.toggleFavorite({ planId, userId, domain: dom });
    setFallbackFavorite(!!res?.favorite);
    return res;
  }

  async function getWithHookOrRouter(planId, dom) {
    if (hasHook && hookGet) return hookGet({ planId, domain: dom });
    const router = getRouter();
    if (!router) return null;
    const userCopy = await router.getPlan(planId, { scope: "user", userId });
    if (userCopy) return userCopy;
    return router.getPlan(planId, { scope: "global" });
  }

  // ------------------------------- Handlers ---------------------------------
  async function handleSave(options = { favorite: false }) {
    if (!plan) return;
    setBusy(true);
    try {
      const nextPlan = isMine
        ? {
            ...plan,
            userId,
            domain: plan.domain || domain,
            meta: { ...(plan.meta || {}), source: "user", createdBy: userId },
          }
        : plan;

      const saved = await saveWithHookOrRouter(nextPlan, { favorite: !!options.favorite });

      // Orchestration & analytics pulses
      try {
        automation?.emit?.("nba.signal", {
          kind: options.favorite ? "plan.saved.favorite" : "plan.saved",
          domain: saved?.domain || domain,
          userId,
          planId: saved?.id || plan?.id,
          ts: Date.now(),
        });
        eventBus.emit?.("plan.saved", {
          id: saved?.id,
          domain: saved?.domain || domain,
          scope: saved?.scope || (isMine ? `user:${userId}` : "user:unknown"),
          userId,
          version: saved?.meta?.version,
          at: Date.now(),
        });
      } catch (_e) {}

      // Toasts
      eventBus.emit?.("toast.show", {
        level: "success",
        title: isMine ? "Plan saved" : "Saved to My Plans",
        message: options.favorite ? "Plan saved and added to favorites." : "Your changes are preserved.",
        ts: Date.now(),
      });

      setMenuOpen(false);
      onAfterSave && onAfterSave(saved);
    } catch (err) {
      console.warn("[SavePlanButton] save error:", err);
      eventBus.emit?.("toast.show", {
        level: "error",
        title: "Could not save",
        message: String(err?.message || err),
        ts: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleToggleFavorite() {
    if (!plan?.id) {
      // If the plan hasn’t been saved yet, open the editor so the user can save first.
      if (FavoritePlanEditorModal) setEditorOpen(true);
      return;
    }
    setBusy(true);
    try {
      await toggleFavoriteWithHookOrRouter(plan.id, plan.domain || domain);
      const updated = await getWithHookOrRouter(plan.id, plan.domain || domain);
      eventBus.emit?.("toast.show", {
        level: "success",
        title: (updated?.isFavorite || isFavorite) ? "Added to favorites" : "Removed from favorites",
        message: plan.title || "Plan",
        ts: Date.now(),
      });
    } catch (err) {
      eventBus.emit?.("toast.show", {
        level: "error",
        title: "Favorite failed",
        message: String(err?.message || err),
        ts: Date.now(),
      });
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------- Render -----------------------------------
  const storageReady = hasHook || routerReady; // enable save only when some storage path is ready

  return (
    <div className="inline-flex items-center gap-2">
      {/* Primary Save / Open Editor with split-menu */}
      <div className="relative">
        <div className="inline-flex shadow-sm rounded-xl">
          <button
            ref={btnRef}
            type="button"
            className={btnClass + (busy ? " opacity-80 cursor-wait" : "")}
            aria-label={title}
            title={title}
            disabled={busy || !storageReady || !plan}
            onClick={() => {
              if (FavoritePlanEditorModal && preferModal) setEditorOpen(true);
              else handleSave({ favorite: false });
            }}
          >
            <IconSave className="h-4 w-4" />
            <span>{isMine ? "Edit & Save" : "Save to My Plans"}</span>
          </button>

          {/* Split chevron */}
          <button
            type="button"
            className={
              (variant === "outline"
                ? "border-blue-600 text-blue-700"
                : variant === "ghost"
                ? "border-transparent text-blue-700"
                : "border-blue-600 text-white") +
              " border-l px-2 rounded-r-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 " +
              (variant === "solid" ? "focus-visible:ring-blue-500" : "focus-visible:ring-blue-500")
            }
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-controls={getMenuId()}
            onClick={() => setMenuOpen((v) => !v)}
            title={isMine ? "More save options" : "Save options"}
            disabled={busy || !storageReady || !plan}
          >
            <IconChevron className="h-4 w-4" />
          </button>
        </div>

        {/* Popover menu */}
        {menuOpen && (
          <div
            id={getMenuId()}
            role="menu"
            className="absolute z-50 mt-2 w-60 rounded-xl border bg-white shadow-lg p-1"
            style={{ minWidth: 220 }}
          >
            <button
              role="menuitem"
              className="w-full text-left px-3 py-2 rounded-lg hover:bg-blue-50"
              onClick={() => {
                setMenuOpen(false);
                if (FavoritePlanEditorModal) setEditorOpen(true);
                else handleSave({ favorite: false });
              }}
              disabled={busy || !storageReady}
            >
              {isMine ? "Open Editor" : "Open Editor (Save to My Plans)"}
              <div className="text-xs text-gray-500">
                {isMine ? "Edit details, tags, steps & save" : "Create a private copy, tweak, then save"}
              </div>
            </button>

            <div className="my-1 border-t" />

            {/* Quick actions keep power users fast */}
            {!isMine && (
              <button
                role="menuitem"
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-blue-50"
                onClick={() => handleSave({ favorite: false })}
                disabled={busy || !storageReady}
              >
                Quick Save to My Plans
                <div className="text-xs text-gray-500">Clone now without opening the editor</div>
              </button>
            )}
            <button
              role="menuitem"
              className="w-full text-left px-3 py-2 rounded-lg hover:bg-blue-50"
              onClick={() => handleSave({ favorite: true })}
              disabled={busy || !storageReady}
            >
              Quick Save & Favorite
              <div className="text-xs text-gray-500">Save and add to Favorites for quick access</div>
            </button>
            {isMine && (
              <button
                role="menuitem"
                className="w-full text-left px-3 py-2 rounded-lg hover:bg-blue-50"
                onClick={() => handleSave({ favorite: false })}
                disabled={busy || !storageReady}
              >
                Quick Save Changes
                <div className="text-xs text-gray-500">Save your current plan immediately</div>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Heart toggle */}
      {showFavoriteHeart && plan?.id && (
        <button
          type="button"
          onClick={handleToggleFavorite}
          aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
          title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          className={
            "inline-flex items-center justify-center rounded-full border " +
            (compact ? "h-8 w-8" : "h-10 w-10") +
            " transition " +
            (isFavorite
              ? "bg-rose-50 border-rose-200 hover:bg-rose-100"
              : "bg-white border-gray-200 hover:bg-gray-50")
          }
          disabled={busy || !storageReady}
        >
          <IconHeart
            filled={isFavorite}
            className={(compact ? "h-4 w-4" : "h-5 w-5") + " " + (isFavorite ? "fill-rose-600" : "fill-gray-500")}
          />
        </button>
      )}

      {/* Editor modal (defensive) */}
      {editorOpen && FavoritePlanEditorModal ? (
        <FavoritePlanEditorModal
          open={editorOpen}
          plan={plan}
          userId={userId}
          domain={plan?.domain || domain}
          onClose={() => setEditorOpen(false)}
          onSaved={(saved) => {
            onAfterSave?.(saved);
            try {
              eventBus.emit?.("plan.saved.ui", {
                userId,
                domain: saved?.domain || domain,
                planId: saved?.id || plan?.id,
                ts: Date.now(),
              });
            } catch (_e) {}
          }}
          showAdvancedJson={showAdvancedJson}
        />
      ) : null}
    </div>
  );
}

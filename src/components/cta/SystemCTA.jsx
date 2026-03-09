/* eslint-disable no-console */
// src/components/cta/SystemCTA.jsx
import React, { useEffect, useMemo, useRef, useState, Suspense } from "react";

/* --------------------------------- Tokens --------------------------------- */
const cx = (...c) => c.filter(Boolean).join(" ");
const BTN =
  "inline-flex items-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium shadow-sm transition active:translate-y-px focus:outline-none focus:ring-2 focus:ring-offset-2";
const VARIANTS = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-600",
  subtle:
    "bg-white text-gray-900 hover:bg-gray-50 border border-gray-200 focus:ring-indigo-600",
  ghost: "bg-transparent text-gray-700 hover:bg-gray-100 focus:ring-indigo-600",
  danger: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-600",
};
const WRAP =
  "w-full flex flex-wrap items-center gap-2 sm:gap-3 rounded-3xl bg-white/70 backdrop-blur supports-[backdrop-filter]:bg-white/60 p-3 sm:p-4 border border-gray-200";

/* ----------------------------- Defensive imports ----------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch (_) {}

let automation = null;
try {
  const a = require("@/services/automation/runtime");
  automation = a?.automation || a?.default || null;
} catch (_) {}

let useFavoritePlans = null;
try {
  const mod = require("@/hooks/useFavoritePlans");
  useFavoritePlans = mod?.useFavoritePlans || mod?.default || null;
} catch (_) {}

let usePlanStorageRouter = null;
try {
  const mod = require("@/services/storage/PlanStorageRouter");
  usePlanStorageRouter = mod?.usePlanStorageRouter || mod?.default || null;
} catch (_) {}

let SavePlanModalLazy = null;
try {
  // Optional modal—only if you have it. Otherwise we'll use a minimal inline modal.
  SavePlanModalLazy = React.lazy(() =>
    import("@/components/plans/SavePlanModal.jsx")
  );
} catch (_) {}

/* --------------------------------- Icons (defensive via lucide-react) --------------------------------- */
let Icons = {};
try {
  const L = require("lucide-react");
  Icons = {
    Play: L.Play || (() => <span>▶</span>),
    Pause: L.Pause || (() => <span>⏸</span>),
    Plus: L.Plus || (() => <span>＋</span>),
    Calendar: L.Calendar || (() => <span>📅</span>),
    Star: L.Star || (() => <span>★</span>),
    StarOff: L.StarOff || (() => <span>☆</span>),
    Save: L.Save || (() => <span>💾</span>),
    MoreHorizontal: L.MoreHorizontal || (() => <span>⋯</span>),
    Check: L.Check || (() => <span>✔</span>),
    Share: L.Share2 || (() => <span>⤴</span>),
    Download: L.Download || (() => <span>⬇</span>),
  };
} catch (_) {
  Icons = {
    Play: () => <span>▶</span>,
    Pause: () => <span>⏸</span>,
    Plus: () => <span>＋</span>,
    Calendar: () => <span>📅</span>,
    Star: () => <span>★</span>,
    StarOff: () => <span>☆</span>,
    Save: () => <span>💾</span>,
    MoreHorizontal: () => <span>⋯</span>,
    Check: () => <span>✔</span>,
    Share: () => <span>⤴</span>,
    Download: () => <span>⬇</span>,
  };
}

/* ---------------------------------- Helpers --------------------------------- */
const domainToDraftEvent = (domain) => {
  // Reuse your existing catalog; no new names required.
  switch (domain) {
    case "meals":
      return "mealplan.draft.requested";
    case "garden":
      return "gardenplan.draft.requested"; // if you use gardenplan.* in your app
    case "animals":
      return "animalplan.draft.requested";
    case "cleaning":
      return "cleanplan.draft.requested";
    default:
      return "workplan.draft.requested";
  }
};

const defaultPlanId = (plan) =>
  plan?.id ||
  plan?._id ||
  plan?.slug ||
  `plan:${Math.random().toString(36).slice(2, 9)}`;

/* -------------------------------- Component --------------------------------- */
/**
 * SystemCTA
 * -----------------------------------------------------------------------------
 * Universal CTA bar for any domain plan. Emits canonical events & integrates with:
 * - Favorites (useFavoritePlans) — user can favorite ANY plan (fixed or user-made)
 * - Save Plan modal (lazy import) OR inline backup save dialog
 * - Session controls (start/pause)
 * - Calendar write (calendarSync.js listener)
 * - Export/share stubs for cloud/local (Drive, device file)
 *
 * Props:
 *  - domain: "meals"|"garden"|"animals"|"cleaning"|...
 *  - plan: object with at least { id?, title?, meta? }
 *  - compact: boolean (UI density)
 *  - className: string
 *  - onAction: (name, payload) => void (optional callback mirror)
 *  - variant: "primary"|"subtle"|'ghost' (color emphasis of main action)
 */
export default function SystemCTA({
  domain = "meals",
  plan = null,
  compact = false,
  className = "",
  onAction = null,
  variant = "primary",
}) {
  const planId = useMemo(() => defaultPlanId(plan), [plan]);
  const title = plan?.title || humanizeDomain(domain);

  /* --------------------------- Favorites (defensive) -------------------------- */
  const favApi = useFavoritePlans ? useFavoritePlans(domain) : null;
  const isFav = !!favApi?.isFavorite?.(planId);
  const [favLocal, setFavLocal] = useState(isFav);

  useEffect(() => {
    setFavLocal(isFav);
  }, [isFav]);

  /* ------------------------------- Save Modal -------------------------------- */
  const [saveOpen, setSaveOpen] = useState(false);
  const openSave = () => setSaveOpen(true);
  const closeSave = () => setSaveOpen(false);

  /* ---------------------------- Storage Router hook --------------------------- */
  const storage = usePlanStorageRouter ? usePlanStorageRouter() : null;

  /* ---------------------------------- State ---------------------------------- */
  const [busy, setBusy] = useState(false);
  const [sessionActive, setSessionActive] = useState(false);
  const pendingRef = useRef(false);

  /* --------------------------------- Handlers -------------------------------- */
  const mirror = (name, payload = {}) => {
    onAction?.(name, payload);
  };

  const emit = (name, payload = {}) => {
    try {
      eventBus.emit(name, payload);
    } catch (e) {
      console.warn("[SystemCTA] emit failed", name, e);
    }
    mirror(name, payload);
  };

  const handleDraft = async () => {
    const evt = domainToDraftEvent(domain);
    setBusy(true);
    try {
      emit(evt, {
        domain,
        params: {
          source: "SystemCTA",
          planId,
          title,
        },
      });
      toastSafe("Draft requested.");
    } finally {
      setBusy(false);
    }
  };

  const handleStartSession = async () => {
    setBusy(true);
    pendingRef.current = true;
    try {
      // Your existing orchestrator listens to "session.start.requested"
      emit("session.start.requested", {
        domain,
        planId,
        title,
        source: "SystemCTA",
      });
      setSessionActive(true);
      toastSafe("Session started.");
    } finally {
      pendingRef.current = false;
      setBusy(false);
    }
  };

  const handlePauseSession = async () => {
    setBusy(true);
    try {
      // Uses your pausePolicies + offsetParser plumbing (listeners side)
      emit("session.pause.requested", {
        domain,
        planId,
        reason: "user",
        source: "SystemCTA",
      });
      setSessionActive(false);
      toastSafe("Session paused.");
    } finally {
      setBusy(false);
    }
  };

  const handleWriteCalendar = () => {
    // calendarSync.js should subscribe and create the events
    emit("calendar.write.requested", {
      domain,
      planId,
      title,
      source: "SystemCTA",
      options: { pushReminders: true },
    });
    toastSafe("Added to calendar (requested).");
  };

  const handleFavoriteToggle = async () => {
    if (!favApi?.toggleFavorite) {
      // Fallback: emit an event so a handler can persist
      const next = !favLocal;
      setFavLocal(next);
      emit("plan.favorite.toggled", {
        domain,
        planId,
        next,
        source: "SystemCTA",
      });
      toastSafe(next ? "Added to favorites." : "Removed from favorites.");
      return;
    }
    try {
      const next = await favApi.toggleFavorite(planId, plan);
      setFavLocal(!!next);
      toastSafe(next ? "Added to favorites." : "Removed from favorites.");
    } catch (e) {
      console.warn("[SystemCTA] toggleFavorite failed", e);
      toastSafe("Could not update favorites.", true);
    }
  };

  const handleSave = () => {
    // Prefer your shared SavePlanModal; else use inline minimal save
    setSaveOpen(true);
    emit("plan.save.modal.opened", { domain, planId, source: "SystemCTA" });
  };

  const handleExport = async (kind = "device") => {
    // Device = download .json; drive = Google Drive; cloud = your backend
    try {
      const payload = {
        domain,
        planId,
        title,
        plan,
        source: "SystemCTA",
      };
      switch (kind) {
        case "drive":
          emit("plan.export.requested", { ...payload, target: "google-drive" });
          toastSafe("Export to Google Drive requested.");
          break;
        case "cloud":
          emit("plan.export.requested", { ...payload, target: "cloud" });
          toastSafe("Cloud export requested.");
          break;
        default: {
          // Device: download JSON right here if router provides helper
          if (storage?.downloadJson) {
            await storage.downloadJson(
              `${safeFileName(title)}.json`,
              plan || { id: planId, domain, title }
            );
          } else {
            // Fallback: fire an event for a listener to handle
            emit("plan.export.requested", { ...payload, target: "device" });
          }
          toastSafe("Downloaded plan JSON.");
        }
      }
    } catch (e) {
      console.warn("[SystemCTA] export failed", e);
      toastSafe("Export failed.", true);
    }
  };

  const handleShare = () => {
    emit("plan.share.requested", {
      domain,
      planId,
      title,
      source: "SystemCTA",
    });
    if (navigator?.share) {
      try {
        navigator.share({
          title,
          text: `${title} — ${domain}`,
          url: window?.location?.href,
        });
      } catch (_) {}
    }
    toastSafe("Share initiated.");
  };

  /* ------------------------------ Next Best Action ----------------------------- */
  const [nbaLabel, setNbaLabel] = useState("Next Best Action");
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Pull a hint from your automation runtime if it exists
      try {
        const hint = (await automation?.nba?.suggest?.({
          domain,
          planId,
          plan,
        })) || { label: null };
        if (!cancelled && hint?.label) setNbaLabel(hint.label);
      } catch (_) {}
    })();
    return () => {
      cancelled = true;
    };
  }, [domain, planId]);

  const handleNBA = () => {
    emit("nba.requested", { domain, planId, plan, source: "SystemCTA" });
  };

  /* --------------------------------- Render --------------------------------- */
  return (
    <div
      className={cx(WRAP, compact && "p-2 gap-2", className)}
      role="group"
      aria-label={`${title} actions`}
    >
      {/* Primary actions */}
      <button
        type="button"
        className={cx(BTN, VARIANTS[variant])}
        onClick={handleDraft}
        disabled={busy}
        aria-label={`Generate ${domain} draft`}
      >
        <Icons.Plus className="h-4 w-4" />
        <span className="hidden xs:inline">Generate Draft</span>
        <span className="xs:hidden">Draft</span>
      </button>

      {sessionActive ? (
        <button
          type="button"
          className={cx(BTN, VARIANTS.subtle)}
          onClick={handlePauseSession}
          disabled={busy}
          aria-label="Pause session"
        >
          <Icons.Pause className="h-4 w-4" />
          <span>Pause</span>
        </button>
      ) : (
        <button
          type="button"
          className={cx(BTN, VARIANTS.subtle)}
          onClick={handleStartSession}
          disabled={busy}
          aria-label="Start session"
        >
          <Icons.Play className="h-4 w-4" />
          <span>Start</span>
        </button>
      )}

      <button
        type="button"
        className={cx(BTN, VARIANTS.subtle)}
        onClick={handleWriteCalendar}
        disabled={busy}
        aria-label="Add to calendar"
      >
        <Icons.Calendar className="h-4 w-4" />
        <span>Calendar</span>
      </button>

      {/* Favorites + Save */}
      <button
        type="button"
        className={cx(BTN, VARIANTS.ghost)}
        onClick={handleFavoriteToggle}
        aria-pressed={favLocal}
        aria-label={favLocal ? "Remove from favorites" : "Add to favorites"}
      >
        {favLocal ? (
          <Icons.Star className="h-4 w-4" />
        ) : (
          <Icons.StarOff className="h-4 w-4" />
        )}
        <span className="hidden sm:inline">
          {favLocal ? "Favorited" : "Favorite"}
        </span>
      </button>

      <button
        type="button"
        className={cx(BTN, VARIANTS.ghost)}
        onClick={handleSave}
        aria-label="Save plan"
      >
        <Icons.Save className="h-4 w-4" />
        <span className="hidden sm:inline">Save</span>
      </button>

      {/* Secondary (more) */}
      <div className="relative ml-auto">
        <details className="group">
          <summary
            className={cx(
              BTN,
              VARIANTS.ghost,
              "cursor-pointer list-none [&::-webkit-details-marker]:hidden"
            )}
          >
            <Icons.MoreHorizontal className="h-4 w-4" />
            <span className="hidden sm:inline">More</span>
          </summary>
          <div className="absolute right-0 z-20 mt-2 min-w-[14rem] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
            <MenuItem onClick={handleNBA} label={nbaLabel} />
            <div className="h-px bg-gray-100" />
            <MenuItem
              onClick={() => handleExport("device")}
              icon={<Icons.Download className="h-4 w-4" />}
              label="Export to device (.json)"
            />
            <MenuItem
              onClick={() => handleExport("drive")}
              icon={<Icons.Download className="h-4 w-4" />}
              label="Export to Google Drive"
            />
            <MenuItem
              onClick={() => handleExport("cloud")}
              icon={<Icons.Download className="h-4 w-4" />}
              label="Export to Cloud"
            />
            <div className="h-px bg-gray-100" />
            <MenuItem
              onClick={handleShare}
              icon={<Icons.Share className="h-4 w-4" />}
              label="Share…"
            />
          </div>
        </details>
      </div>

      {/* Save Modal (lazy preferred, else inline) */}
      {saveOpen &&
        (SavePlanModalLazy ? (
          <Suspense fallback={<InlineSaveModalFallback onCancel={closeSave} />}>
            <SavePlanModalLazy
              isOpen={saveOpen}
              onClose={closeSave}
              defaultTitle={title}
              domain={domain}
              plan={plan || { id: planId, title, domain }}
              onSaved={(saved) => {
                toastSafe("Plan saved.");
                emit("plan.saved", {
                  domain,
                  planId: saved?.id || planId,
                  saved,
                  source: "SystemCTA",
                });
                closeSave();
              }}
            />
          </Suspense>
        ) : (
          <InlineSaveModal
            title={title}
            domain={domain}
            plan={plan || { id: planId, title, domain }}
            onCancel={closeSave}
            onSaved={(saved) => {
              toastSafe("Plan saved.");
              emit("plan.saved", {
                domain,
                planId: saved?.id || planId,
                saved,
                source: "SystemCTA",
              });
              closeSave();
            }}
          />
        ))}
    </div>
  );
}

/* -------------------------------- Subcomponents ------------------------------- */
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

function InlineSaveModalFallback({ onCancel }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/30"
    >
      <div className="w-[95vw] max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <div className="animate-pulse h-6 w-40 bg-gray-200 rounded mb-4" />
        <div className="space-y-2">
          <div className="h-10 bg-gray-100 rounded" />
          <div className="h-10 bg-gray-100 rounded" />
        </div>
        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VARIANTS.ghost)} onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function InlineSaveModal({ title, domain, plan, onCancel, onSaved }) {
  const [name, setName] = useState(title || "");
  const [desc, setDesc] = useState(plan?.description || "");
  const [busy, setBusy] = useState(false);

  const saveLocal = async () => {
    setBusy(true);
    try {
      // Persist via event; a handler can save to IndexedDB/Dexie or remote
      eventBus.emit("plan.save.requested", {
        domain,
        payload: { ...plan, title: name, description: desc },
        source: "SystemCTA",
      });
      onSaved?.({ ...plan, title: name, description: desc });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/30"
    >
      <div className="w-[95vw] max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold mb-4">Save Plan</h3>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Title
        </label>
        <input
          className="w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name your plan"
        />
        <label className="block text-sm font-medium text-gray-700 mt-4 mb-1">
          Description (optional)
        </label>
        <textarea
          className="w-full rounded-xl border border-gray-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-600"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={3}
          placeholder="What makes this plan special?"
        />
        <div className="mt-6 flex justify-end gap-2">
          <button className={cx(BTN, VARIANTS.ghost)} onClick={onCancel}>
            Cancel
          </button>
          <button
            className={cx(BTN, VARIANTS.primary)}
            onClick={saveLocal}
            disabled={busy}
          >
            <Icons.Check className="h-4 w-4" />
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Utils ---------------------------------- */
function toastSafe(msg, isError = false) {
  // If you have a toast system, emit an event it listens to:
  try {
    eventBus.emit("ui.toast", {
      message: msg,
      variant: isError ? "error" : "success",
    });
  } catch (_) {
    // Fallback
    if (isError) console.warn(msg);
    else console.log(msg);
  }
}

function humanizeDomain(d) {
  try {
    return (d || "Plan").replace(/^\w/, (c) => c.toUpperCase()) + " Plan";
  } catch (_) {
    return "Plan";
  }
}

function safeFileName(name = "plan") {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/-+/g, "-");
}

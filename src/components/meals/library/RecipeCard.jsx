// src/components/meals/library/RecipeCard.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch (_) {
  Icons = {
    Star: () => null,
    StarOff: () => null,
    Pin: () => null,
    PinOff: () => null,
    Clock: () => null,
    Soup: () => null,
    Sparkles: () => null,
    CheckCircle2: () => null,
    XCircle: () => null,
    AlertTriangle: () => null,
    PlusCircle: () => null,
    ExternalLink: () => null,
    ChefHat: () => null,
    ImageIcon: () => null,
    Tags: () => null,
    MoreHorizontal: () => null,
    Heart: () => null,
    HeartOff: () => null,
    UtensilsCrossed: () => null,
    ListChecks: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/events/eventBus").eventBus || eventBus;
} catch {}

let useBatchQueue = () => ({
  add: () => {},
  remove: () => {},
  contains: () => false,
});
try {
  useBatchQueue =
    require("@/features/meals/BatchQueueProvider").useBatchQueue ||
    useBatchQueue;
} catch {}

let InventoryMonitor = {
  checkRecipe: () => ({ status: "unknown", missingCount: 0 }),
};
try {
  InventoryMonitor =
    require("@/managers/InventoryMonitor").default ||
    require("@/managers/InventoryMonitor") ||
    InventoryMonitor;
} catch {}

let usePersonalFoodStandards = () => ({ standards: {} });
try {
  usePersonalFoodStandards =
    require("@/app/context/HouseholdSettingsContext")
      .usePersonalFoodStandards || usePersonalFoodStandards;
} catch {}

/* ---------------------------------- Helpers --------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");
const fmtMin = (m) => (!m ? "—" : `${m}m`);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const safeArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const fallbackImg =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='400'><rect width='100%' height='100%' fill='#f3f4f6'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='Arial' font-size='18' fill='#9ca3af'>No photo</text></svg>`
  );

/** Standards check (very lightweight, expand as needed) */
function checkStandards(recipe = {}, standards = {}) {
  // Ex: noPork + lamb/beef only + goat allowed flags
  const tags = new Set(
    (recipe.tags || []).map((t) => (typeof t === "string" ? t : t.id))
  );
  if (
    standards?.noPork &&
    (tags.has("pork") || /pork/i.test(recipe.title || ""))
  ) {
    return { ok: false, reason: "Pork" };
  }
  if (standards?.lambBeefOnly) {
    const allowed = ["lamb", "beef", "goat"];
    const hasForbidden =
      tags.has("chicken") ||
      tags.has("turkey") ||
      tags.has("fish") ||
      tags.has("seafood") ||
      /chicken|fish|turkey|seafood/i.test(recipe.title || "");
    if (hasForbidden) return { ok: false, reason: "Lamb/Beef only" };
    const hasAllowed = allowed.some(
      (x) => tags.has(x) || new RegExp(x, "i").test(recipe.title || "")
    );
    return { ok: !!hasAllowed, reason: hasAllowed ? null : "No allowed meat" };
  }
  // If no strict rules triggered:
  return { ok: true, reason: null };
}

/* ------------------------------- Rating stars ------------------------------- */
const Stars = ({ value = 0, outOf = 5, className }) => {
  const { Star, StarOff } = Icons;
  const v = clamp(value, 0, outOf);
  return (
    <div className={cx("flex items-center", className)}>
      {Array.from({ length: outOf }).map((_, i) =>
        i < v ? (
          <Star key={i} className="w-4 h-4 text-amber-500" />
        ) : (
          <StarOff key={i} className="w-4 h-4 text-gray-300" />
        )
      )}
    </div>
  );
};

/* ---------------------------------- Card ------------------------------------ */
export default function RecipeCard({
  recipe = {},
  dense = false,
  inventoryAware = false,
  showMacros = true,
  showTags = true,
  onOpen, // (recipe) => void
  onEdit, // (recipe) => void
  onPlan, // (recipe) => void (send to MealPlan)
  onTogglePin, // (id, nextVal)
  onToggleFavorite, // (id, nextVal)
  className,
}) {
  const {
    id,
    title = "Untitled recipe",
    image,
    rating = 0,
    difficulty, // easy|med|hard
    prepMinutes = 0,
    cookMinutes = 0,
    totalMinutes = (prepMinutes || 0) + (cookMinutes || 0),
    macros = {}, // { kcal, protein, carbs, fat }
    tags = [],
    pinned = false,
    favorite = false,
    batchReady = false,
    servings,
    source = {}, // { type:'vault|web|scan|import', url }
    updatedAt,
  } = recipe;

  const {
    Star,
    Pin,
    PinOff,
    Clock,
    Soup,
    Sparkles,
    CheckCircle2,
    XCircle,
    AlertTriangle,
    PlusCircle,
    ExternalLink,
    ChefHat,
    ImageIcon,
    Tags,
    MoreHorizontal,
    Heart,
    HeartOff,
    UtensilsCrossed,
    ListChecks,
  } = Icons;

  const { add, contains } = useBatchQueue();
  const { standards } = usePersonalFoodStandards();

  const [invStatus, setInvStatus] = useState({
    status: "unknown",
    missingCount: 0,
  });
  const standardsCheck = useMemo(
    () => checkStandards(recipe, standards),
    [recipe, standards]
  );
  const inBatch = contains?.(id);

  useEffect(() => {
    if (!inventoryAware || !InventoryMonitor?.checkRecipe) return;
    try {
      const res = InventoryMonitor.checkRecipe(recipe);
      setInvStatus(res || { status: "unknown", missingCount: 0 });
    } catch (e) {
      console.warn("[RecipeCard] inventory check failed:", e);
    }
  }, [inventoryAware, recipe]);

  const difficultyLabel = difficulty ? difficulty : null;
  const timeBadge = totalMinutes || prepMinutes || cookMinutes;

  const kcal = Number(macros?.kcal) || 0;
  const protein = Number(macros?.protein) || 0;
  const carbs = Number(macros?.carbs) || 0;
  const fat = Number(macros?.fat) || 0;

  function doAddToBatch() {
    try {
      add?.({
        id,
        title,
        source: "RecipeCard",
        recipe,
      });
      eventBus.emit("meals.batch.added", { id, title });
    } catch (e) {
      console.error("[RecipeCard] addToBatch failed", e);
    }
  }

  function openDetail() {
    if (typeof onOpen === "function") onOpen(recipe);
    eventBus.emit("meals.recipe.open", { id, title });
  }

  function togglePin() {
    if (typeof onTogglePin === "function") onTogglePin(id, !pinned);
    eventBus.emit("meals.recipe.pin.toggled", { id, next: !pinned });
  }

  function toggleFavorite() {
    if (typeof onToggleFavorite === "function") onToggleFavorite(id, !favorite);
    eventBus.emit("meals.recipe.favorite.toggled", { id, next: !favorite });
  }

  function openSource(e) {
    e?.stopPropagation?.();
    if (source?.url) window.open(source.url, "_blank", "noopener,noreferrer");
  }

  /* ------------------------------- Badges row -------------------------------- */
  const inventoryBadge =
    invStatus.status === "ok" ? (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200">
        <CheckCircle2 className="w-3 h-3" /> On hand
      </span>
    ) : invStatus.status === "missing" ? (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-amber-50 text-amber-700 border border-amber-200">
        <AlertTriangle className="w-3 h-3" />
        {invStatus.missingCount || 1} missing
      </span>
    ) : inventoryAware ? (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-gray-50 text-gray-600 border border-gray-200">
        <ListChecks className="w-3 h-3" />
        Check inv.
      </span>
    ) : null;

  const standardsBadge = standardsCheck.ok ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-50 text-emerald-700 border border-emerald-200">
      <Sparkles className="w-3 h-3" /> Fits Standards
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-rose-50 text-rose-700 border border-rose-200">
      <XCircle className="w-3 h-3" /> {standardsCheck.reason || "Not allowed"}
    </span>
  );

  const batchBadge = batchReady ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-indigo-50 text-indigo-700 border border-indigo-200">
      <Soup className="w-3 h-3" /> Batch-ready
    </span>
  ) : null;

  const difficultyBadge = difficultyLabel ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-sky-50 text-sky-700 border border-sky-200 capitalize">
      <ChefHat className="w-3 h-3" /> {difficultyLabel}
    </span>
  ) : null;

  const timePill = timeBadge ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-gray-50 text-gray-700 border border-gray-200">
      <Clock className="w-3 h-3" />{" "}
      {fmtMin(totalMinutes || prepMinutes || cookMinutes)}
    </span>
  ) : null;

  /* ---------------------------------- View ----------------------------------- */
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={openDetail}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && openDetail()}
      className={cx(
        "group relative overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm hover:shadow-md transition focus:outline-none focus:ring-2 focus:ring-emerald-500",
        dense ? "p-3" : "p-4",
        className
      )}
      aria-label={`Open ${title}`}
    >
      {/* Pin / Favorite */}
      <div className="absolute top-2 right-2 z-10 flex items-center gap-1">
        <button
          type="button"
          title={pinned ? "Unpin" : "Pin"}
          onClick={(e) => {
            e.stopPropagation();
            togglePin();
          }}
          className={cx(
            "rounded-full p-1 border transition",
            pinned
              ? "bg-emerald-600 border-emerald-600 text-white"
              : "bg-white/90 backdrop-blur border-gray-200 text-gray-700 hover:bg-gray-50"
          )}
        >
          {pinned ? (
            <Pin className="w-4 h-4" />
          ) : (
            <PinOff className="w-4 h-4" />
          )}
        </button>

        <button
          type="button"
          title={favorite ? "Unfavorite" : "Favorite"}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite();
          }}
          className={cx(
            "rounded-full p-1 border transition",
            favorite
              ? "bg-rose-600 border-rose-600 text-white"
              : "bg-white/90 backdrop-blur border-gray-200 text-gray-700 hover:bg-gray-50"
          )}
        >
          {favorite ? (
            <Heart className="w-4 h-4" />
          ) : (
            <HeartOff className="w-4 h-4" />
          )}
        </button>
      </div>

      {/* Media */}
      <div
        className={cx(
          "mb-3 rounded-xl overflow-hidden bg-gray-100",
          dense ? "h-36" : "h-44"
        )}
      >
        {image ? (
          <img
            src={image}
            alt=""
            className="w-full h-full object-cover transition group-hover:scale-[1.02]"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <img
              src={fallbackImg}
              alt=""
              className="w-full h-full object-cover"
            />
            <ImageIcon className="absolute w-6 h-6 text-gray-400" />
          </div>
        )}
      </div>

      {/* Title */}
      <h3
        className={cx(
          "line-clamp-2 font-semibold text-gray-900",
          dense ? "text-sm" : "text-base"
        )}
      >
        {title}
      </h3>

      {/* Rating + Servings */}
      <div className="mt-1 flex items-center justify-between">
        <Stars value={rating} />
        {servings ? (
          <span className="text-xs text-gray-500">{servings} servings</span>
        ) : (
          <span className="text-xs text-transparent select-none">.</span>
        )}
      </div>

      {/* Badges */}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {timePill}
        {difficultyBadge}
        {batchBadge}
        {inventoryBadge}
        {standardsBadge}
      </div>

      {/* Macros Peek */}
      {showMacros && (
        <div className="mt-3 grid grid-cols-4 gap-2 text-[11px]">
          <div className="rounded-lg border px-2 py-1 text-center">
            <div className="font-semibold">{kcal || "—"}</div>
            <div className="text-gray-500">kcal</div>
          </div>
          <div className="rounded-lg border px-2 py-1 text-center">
            <div className="font-semibold">{protein || "—"}</div>
            <div className="text-gray-500">P</div>
          </div>
          <div className="rounded-lg border px-2 py-1 text-center">
            <div className="font-semibold">{carbs || "—"}</div>
            <div className="text-gray-500">C</div>
          </div>
          <div className="rounded-lg border px-2 py-1 text-center">
            <div className="font-semibold">{fat || "—"}</div>
            <div className="text-gray-500">F</div>
          </div>
        </div>
      )}

      {/* Tags */}
      {showTags && safeArr(tags).length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {safeArr(tags)
            .slice(0, 5)
            .map((t, i) => {
              const label =
                typeof t === "string" ? t : t?.label || t?.id || "tag";
              return (
                <span
                  key={`${id}-tag-${i}`}
                  className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-700"
                >
                  {label}
                </span>
              );
            })}
          {safeArr(tags).length > 5 ? (
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-gray-200 bg-gray-50 text-gray-500">
              +{safeArr(tags).length - 5}
            </span>
          ) : null}
        </div>
      )}

      {/* Footer Actions */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Add to Batch */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              doAddToBatch();
            }}
            className={cx(
              "inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm transition",
              inBatch
                ? "bg-indigo-600 border-indigo-600 text-white"
                : "bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
            )}
            title={inBatch ? "In Batch Queue" : "Add to Batch Queue"}
          >
            <PlusCircle className="w-4 h-4" />
            {inBatch ? "In Batch" : "Batch"}
          </button>

          {/* Plan (send to Meal Plan) */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (typeof onPlan === "function") onPlan(recipe);
              eventBus.emit("meals.plan.add", { id, title });
            }}
            className="inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm bg-white border-gray-300 text-gray-800 hover:bg-gray-50"
            title="Plan this meal"
          >
            <UtensilsCrossed className="w-4 h-4" />
            Plan
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Source link */}
          {source?.url ? (
            <button
              type="button"
              onClick={openSource}
              className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
              title="Open source"
            >
              <ExternalLink className="w-4 h-4" />
              Source
            </button>
          ) : null}

          {/* Edit */}
          {typeof onEdit === "function" ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(recipe);
                eventBus.emit("meals.recipe.edit", { id, title });
              }}
              className="inline-flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900"
              title="Edit"
            >
              <MoreHorizontal className="w-4 h-4" />
              Edit
            </button>
          ) : null}
        </div>
      </div>

      {/* Subtext */}
      <div className="mt-2 flex items-center justify-between text-[11px] text-gray-500">
        <div className="flex items-center gap-1">
          <Tags className="w-3 h-3" />
          {(source?.type || "vault").toUpperCase()}
        </div>
        {updatedAt ? (
          <div>Updated {new Date(updatedAt).toLocaleDateString()}</div>
        ) : (
          <span>&nbsp;</span>
        )}
      </div>
    </article>
  );
}

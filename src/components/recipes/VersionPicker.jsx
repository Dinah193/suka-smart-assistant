// src/components/recipes/VersionPicker.jsx
/* eslint-disable no-console */
import React, { useEffect, useMemo, useState } from "react";

/* ------------------------------- Defensive deps ------------------------------- */
let Icons = {};
try {
  Icons = require("lucide-react");
} catch {
  Icons = {
    GitBranch: () => null,
    GitCompare: () => null,
    Star: () => null,
    StarOff: () => null,
    Check: () => null,
    X: () => null,
    Clock: () => null,
    ChefHat: () => null,
    Flame: () => null,
    Gauge: () => null,
    Utensils: () => null,
    Info: () => null,
    Plus: () => null,
  };
}

let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  eventBus = require("@/services/eventBus").eventBus || eventBus;
} catch {}

/* Optional: read/write household prefs for default versions */
let useHouseholdPrefs = () => ({
  getDefaultRecipeVersion: () => null,
  setDefaultRecipeVersion: () => {},
});
try {
  useHouseholdPrefs =
    require("@/app/context/HouseholdSettingsContext").useHouseholdPrefs || useHouseholdPrefs;
} catch {}

/* ---------------------------------- Helpers --------------------------------- */
const cx = (...xs) => xs.filter(Boolean).join(" ");

function summarize(r = {}) {
  const ingredients = (r.ingredients || []).length;
  const steps = (r.instructions || []).length;
  const kcal = r?.macros?.kcal ?? undefined;
  const mins = Number(r.totalMinutes || r.prepMinutes || r.cookMinutes || 0);
  const rating = Number(r.rating || 0);
  const ratingCount = Number(r.ratingCount || 0);
  return { ingredients, steps, kcal, mins, rating, ratingCount };
}

function diffSummary(a = {}, b = {}) {
  const A = summarize(a);
  const B = summarize(b);
  const delta = (k) => (B[k] ?? 0) - (A[k] ?? 0);
  return {
    ingredients: delta("ingredients"),
    steps: delta("steps"),
    mins: delta("mins"),
    kcal: (B.kcal ?? 0) - (A.kcal ?? 0),
    rating: (B.rating || 0) - (A.rating || 0),
    ratingCount: (B.ratingCount || 0) - (A.ratingCount || 0),
  };
}

function friendlyDelta(n, suffix = "") {
  if (n == null || Number.isNaN(n)) return "";
  if (n === 0) return "±0" + suffix;
  return (n > 0 ? "+" : "") + n + suffix;
}

/* Persist default per-household + recipe group (by canonical URL host + title) */
function defaultKey(primary = {}, householdId = "default") {
  const site = (primary?.source?.site || "site").toLowerCase();
  const name = (primary?.title || "recipe").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
  return `suka.recipe.defaultVersion.${householdId}.${site}.${name}`;
}

/* ---------------------------------- Badge ----------------------------------- */
export function VersionStackBadge({ count = 2, className }) {
  const { GitBranch } = Icons;
  if (count <= 1) return null;
  return (
    <span
      title={`${count} versions available`}
      className={cx(
        "inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-white border-gray-200 text-gray-700 shadow-sm",
        className
      )}
    >
      <GitBranch className="w-3 h-3" />
      ×{count}
    </span>
  );
}

/* --------------------------------- Picker ----------------------------------- */
export default function VersionPicker({
  /** The primary recipe record (current) */
  primary,
  /** All versions for this recipe cluster (primary first preferred but not required) */
  versions = [],
  /** Optional: household id for per-household default persistence */
  householdId = "default",
  /** Optional: called when user switches to a different version */
  onSelectVersion, // (recipe) => void
  /** Optional: called when a default is made */
  onMakeDefault, // (recipe) => void
  /** Optional: disable compare panel by default */
  compareInitiallyOpen = false,
  className,
}) {
  const {
    GitCompare, Star, StarOff, Check, X, Clock, ChefHat, Flame, Gauge, Utensils, Info,
  } = Icons;

  const prefs = useHouseholdPrefs();

  const sortedVersions = useMemo(() => {
    const arr = [...versions];
    // Ensure primary first
    arr.sort((a, b) => (a?.id === primary?.id ? -1 : b?.id === primary?.id ? 1 : 0));
    return arr;
  }, [versions, primary?.id]);

  const [currentId, setCurrentId] = useState(primary?.id);
  const [defaultId, setDefaultId] = useState(() => {
    const key = defaultKey(primary, householdId);
    const local = typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
    return local || prefs.getDefaultRecipeVersion?.(primary?.id) || null;
  });
  const [showCompare, setShowCompare] = useState(compareInitiallyOpen);

  useEffect(() => {
    setCurrentId(primary?.id);
  }, [primary?.id]);

  const current = useMemo(() => sortedVersions.find((r) => r.id === currentId) || primary, [sortedVersions, currentId, primary]);
  const isDefault = (r) => (defaultId ? r?.id === defaultId : r?.id === primary?.id);

  function makeDefault(r) {
    const key = defaultKey(primary, householdId);
    try {
      window.localStorage.setItem(key, r?.id);
    } catch {}
    prefs.setDefaultRecipeVersion?.(primary?.id, r?.id);
    setDefaultId(r?.id);
    onMakeDefault?.(r);
    eventBus.emit("recipe.version.defaultSet", { primaryId: primary?.id, versionId: r?.id });
  }

  function choose(r) {
    setCurrentId(r?.id);
    onSelectVersion?.(r);
    eventBus.emit("recipe.version.selected", { primaryId: primary?.id, versionId: r?.id });
  }

  if (!primary || !sortedVersions.length) {
    return (
      <div className={cx("rounded-xl border border-dashed p-4 text-sm text-gray-600 bg-white", className)}>
        No other versions found for this recipe.
      </div>
    );
  }

  const count = sortedVersions.length;
  const base = summarize(primary);

  return (
    <section className={cx("w-full", className)} aria-label="Recipe versions">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 text-sm text-gray-800">
          <VersionStackBadge count={count} />
          <span className="font-medium">Versions</span>
          <span className="text-gray-500">•</span>
          <span className="text-xs text-gray-500">
            Default: <strong>{isDefault(primary) ? "Current" : "Custom"}</strong>
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowCompare((v) => !v)}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border bg-white border-gray-300 text-xs hover:bg-gray-50"
          title={showCompare ? "Hide compare" : "Show compare"}
        >
          <GitCompare className="w-4 h-4" />
          {showCompare ? "Hide compare" : "Compare"}
        </button>
      </div>

      {/* Rail */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        {sortedVersions.map((r) => {
          const s = summarize(r);
          const del = diffSummary(primary, r);
          const selected = r.id === currentId;

          return (
            <div
              key={r.id || r.url}
              className={cx(
                "group relative rounded-2xl border bg-white p-3 shadow-sm hover:shadow-md transition",
                selected ? "border-emerald-600 ring-2 ring-emerald-500" : "border-gray-200"
              )}
              role="button"
              tabIndex={0}
              onClick={() => choose(r)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && choose(r)}
              aria-label={`Choose version ${r.title}`}
            >
              {/* Badge: default */}
              {isDefault(r) ? (
                <span className="absolute left-2 top-2 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-emerald-600 text-white">
                  <Star className="w-3 h-3" /> default
                </span>
              ) : null}

              {/* Media */}
              <div className="h-28 rounded-lg overflow-hidden bg-gray-100 mb-2">
                {r.image ? (
                  <img src={r.image} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-gray-500">No photo</div>
                )}
              </div>

              {/* Title */}
              <div className="line-clamp-2 text-sm font-semibold text-gray-900">{r.title || "Untitled"}</div>
              <div className="text-[11px] text-gray-500 truncate">{r?.source?.site || r?.source?.url || ""}</div>

              {/* Summary chips */}
              <div className="mt-2 flex flex-wrap items-center gap-1">
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-gray-50 border-gray-200">
                  <Utensils className="w-3 h-3" /> {s.ingredients}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-gray-50 border-gray-200">
                  <ChefHat className="w-3 h-3" /> {s.steps}
                </span>
                {s.mins ? (
                  <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-gray-50 border-gray-200">
                    <Clock className="w-3 h-3" /> {s.mins}m
                  </span>
                ) : null}
                {s.kcal ? (
                  <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border bg-gray-50 border-gray-200">
                    <Flame className="w-3 h-3" /> {s.kcal} kcal
                  </span>
                ) : null}
              </div>

              {/* Actions */}
              <div className="mt-3 flex items-center justify-between">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    choose(r);
                  }}
                  className="text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white border-gray-300 hover:bg-gray-50"
                >
                  <Check className="w-4 h-4" /> Use this
                </button>

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    makeDefault(r);
                  }}
                  className={cx(
                    "text-xs inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border bg-white hover:bg-gray-50",
                    isDefault(r) ? "border-emerald-300 text-emerald-700" : "border-gray-300"
                  )}
                  title="Set as household default"
                >
                  {isDefault(r) ? <Star className="w-4 h-4" /> : <StarOff className="w-4 h-4" />}
                  Default
                </button>
              </div>

              {/* Inline mini compare deltas */}
              {showCompare ? (
                <div className="mt-2 grid grid-cols-4 gap-1 text-[10px] text-gray-600">
                  <div className="rounded border bg-gray-50 border-gray-200 px-1 py-0.5 text-center">
                    <div className="font-medium">Ing</div>
                    <div className="text-gray-800">{friendlyDelta(del.ingredients)}</div>
                  </div>
                  <div className="rounded border bg-gray-50 border-gray-200 px-1 py-0.5 text-center">
                    <div className="font-medium">Steps</div>
                    <div className="text-gray-800">{friendlyDelta(del.steps)}</div>
                  </div>
                  <div className="rounded border bg-gray-50 border-gray-200 px-1 py-0.5 text-center">
                    <div className="font-medium">Time</div>
                    <div className="text-gray-800">{friendlyDelta(del.mins, "m")}</div>
                  </div>
                  <div className="rounded border bg-gray-50 border-gray-200 px-1 py-0.5 text-center">
                    <div className="font-medium">Kcal</div>
                    <div className="text-gray-800">{friendlyDelta(del.kcal)}</div>
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Footnote */}
      <div className="mt-3 text-[11px] text-gray-500 flex items-center gap-2">
        <Info className="w-3 h-3" />
        Your default version will be used first when planning. You can always switch per-meal.
      </div>
    </section>
  );
}

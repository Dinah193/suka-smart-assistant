/* eslint-disable no-console */
// PriceUnitsToggle.jsx — unit display, strategy toggle, favorites, export/import
import React, { useEffect, useMemo, useRef, useState } from "react";

// ---- Safe imports (graceful if modules not present) ----
let getPriceNormalizerSingleton = null;
let getPriceComparatorSingleton = null;
try {
  ({
    getPriceNormalizerSingleton,
  } = require("@/features/scan-compare-trust/services/pricing/PriceNormalizer"));
} catch (_) {}
try {
  ({
    getPriceComparatorSingleton,
  } = require("@/features/scan-compare-trust/services/pricing/PriceComparator"));
} catch (_) {}

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require
  eventBus = require("@/services/events/eventBus");
} catch (_) {}

function useServices() {
  return useMemo(() => {
    const normalizer = getPriceNormalizerSingleton
      ? getPriceNormalizerSingleton({ eventBus })
      : null;
    const comparator = getPriceComparatorSingleton
      ? getPriceComparatorSingleton({ eventBus })
      : null;
    return { normalizer, comparator };
  }, []);
}

/**
 * Props:
 *  - compact?: boolean
 *  - onProfileChanged?: (profile) => void
 *  - onStrategyChanged?: (strategy) => void
 *  - className?: string
 *  - showStrategyToggle?: boolean  (default: true)
 *  - showExportImport?: boolean    (default: true)
 */
export default function PriceUnitsToggle({
  compact,
  onProfileChanged,
  onStrategyChanged,
  className = "",
  showStrategyToggle = true,
  showExportImport = true,
}) {
  const { normalizer, comparator } = useServices();

  const [profile, setProfile] = useState(
    () => normalizer?.getActiveProfile() || null
  );
  const [strategy, setStrategy] = useState(
    () => comparator?.getActiveProfile?.()?.strategy || "auto"
  );
  const [savingFav, setSavingFav] = useState(false);
  const [favorites, setFavorites] = useState(
    () => normalizer?.listFavoriteProfiles?.() || []
  );
  const fileRef = useRef(null);

  // --- bus sync
  useEffect(() => {
    const offs = [
      eventBus.on?.("pricing:normalizer:profile:activated", () => {
        const p = normalizer?.getActiveProfile();
        if (p) setProfile({ ...p });
      }),
      eventBus.on?.("pricing:normalizer:profile:imported", () => {
        const p = normalizer?.getActiveProfile();
        if (p) setProfile({ ...p });
        setFavorites(normalizer?.listFavoriteProfiles?.() || []);
      }),
      eventBus.on?.("pricing:normalizer:profile:favorited", () => {
        setFavorites(normalizer?.listFavoriteProfiles?.() || []);
      }),
      eventBus.on?.("pricing:normalizer:profile:favorite:removed", () => {
        setFavorites(normalizer?.listFavoriteProfiles?.() || []);
      }),
      eventBus.on?.("pricing:profile:activated", () => {
        // Comparator profile changed elsewhere
        try {
          const cp = comparator?.getActiveProfile?.();
          if (cp?.strategy) setStrategy(cp.strategy);
        } catch (_) {}
      }),
    ].filter(Boolean);
    return () => {
      offs.forEach((off) => off?.());
    };
  }, [normalizer, comparator]);

  if (!normalizer || !profile) {
    return (
      <div
        className={`rounded-xl border border-gray-200 p-3 text-sm text-gray-500 ${className}`}
      >
        Price unit settings unavailable.
      </div>
    );
  }

  const compactCls = compact ? "px-3 py-2" : "px-4 py-3";

  // ---- helpers
  function toast(text, kind = "success") {
    eventBus.emit?.("ui:toast", { kind, text });
  }

  function updateProfile(patch) {
    const next = {
      ...profile,
      ...patch,
      showPerHundred: {
        ...profile.showPerHundred,
        ...(patch.showPerHundred || {}),
      },
    };
    setProfile(next);
    normalizer.setActiveProfile(next);
    toast("Unit preferences updated.");
    onProfileChanged?.(next);
    // nudge scans to re-render unit labels
    eventBus.emit?.("pricing:display:changed", { ts: Date.now() });
  }

  function updateStrategy(next) {
    setStrategy(next);
    try {
      const cp = comparator?.getActiveProfile?.() || {};
      comparator?.setActiveProfile?.({ ...cp, strategy: next });
      eventBus.emit?.("pricing:profile:activated", { ts: Date.now() });
      onStrategyChanged?.(next);
      toast(`Comparison strategy: ${labelForStrategy(next)}`);
    } catch (e) {
      // comparator may be optional
    }
    // downstream panels can re-rank if they want
    eventBus.emit?.("pricing:strategy:changed", {
      strategy: next,
      ts: Date.now(),
    });
  }

  async function handleSaveFavorite() {
    try {
      setSavingFav(true);
      const labelDefault = `${profile.label || "Household"} — ${
        profile.preferredSystem
      } • ${profile.showPerHundred.mass ? "per100g" : "g"}/${
        profile.showPerHundred.volume ? "per100mL" : "mL"
      }`;
      // eslint-disable-next-line no-alert
      const label =
        window.prompt("Save favorite as…", labelDefault) || labelDefault;
      const id = normalizer.saveFavoriteProfile(label);
      setFavorites(normalizer.listFavoriteProfiles());
      toast("Favorite saved.");
      // Optional: emit a lightweight bookmark event (mirrors 'save favorite sessions')
      eventBus.emit?.("favorites:saved", {
        type: "pricing.normalizer",
        id,
        label,
        ts: Date.now(),
      });
    } finally {
      setSavingFav(false);
    }
  }

  function applyFavorite(id) {
    const fav = (favorites || []).find((f) => f.id === id);
    if (!fav) return;
    normalizer.setActiveProfile(fav);
    const p = normalizer.getActiveProfile();
    setProfile({ ...p });
    toast("Favorite applied.");
    onProfileChanged?.(p);
  }

  function deleteFavorite(id) {
    if (!id) return;
    // eslint-disable-next-line no-alert
    const ok = window.confirm("Delete this favorite?");
    if (!ok) return;
    const done = normalizer.removeFavoriteProfile(id);
    if (done) {
      setFavorites(normalizer.listFavoriteProfiles());
      toast("Favorite deleted.");
    }
  }

  function exportProfile() {
    try {
      const data = normalizer.exportProfile();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(profile.label || "unit-profile").replace(
        /\s+/g,
        "_"
      )}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast("Profile exported.");
    } catch (e) {
      toast("Export failed.", "error");
    }
  }

  function importProfileFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result || "{}"));
        normalizer.importProfile(data);
        const p = normalizer.getActiveProfile();
        setProfile({ ...p });
        toast("Profile imported.");
        onProfileChanged?.(p);
      } catch (e) {
        toast("Invalid profile file.", "error");
      }
    };
    reader.readAsText(file);
  }

  // ---- render pieces
  const compactGroup =
    "inline-flex items-center gap-2 rounded-xl border border-gray-200 p-1";
  const btnBase = "rounded-lg px-2.5 py-1 text-xs font-medium transition";
  const favs = favorites || [];

  return (
    <div
      className={`flex w-full flex-col gap-2 rounded-2xl border border-gray-200 bg-white shadow-sm ${className}`}
      role="group"
      aria-label="Price unit settings"
    >
      {/* header */}
      <div className={`flex items-center justify-between ${compactCls}`}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900">
            Unit & Strategy
          </span>
          <span
            className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
            title="Active profile"
          >
            {profile.label || "Household Normalization"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Favorites quick actions */}
          <FavoriteSelect
            favorites={favs}
            onApply={applyFavorite}
            onDelete={deleteFavorite}
          />
          <button
            type="button"
            onClick={handleSaveFavorite}
            disabled={savingFav}
            className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-800 hover:bg-gray-100 disabled:opacity-60"
            title="Save current settings as a favorite"
          >
            <StarIcon className="h-4 w-4" />
            Save Favorite
          </button>

          {showExportImport && (
            <>
              <button
                type="button"
                onClick={exportProfile}
                className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                title="Export current profile to JSON"
              >
                Export
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-100"
                title="Import a profile from JSON"
              >
                Import
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(e) => importProfileFromFile(e.target.files?.[0])}
              />
            </>
          )}
        </div>
      </div>

      {/* controls */}
      <div
        className={`flex flex-wrap items-center justify-between gap-3 ${compactCls} pt-0`}
      >
        {/* System selector */}
        <div
          className={compactGroup}
          role="radiogroup"
          aria-label="Measurement system"
        >
          {["auto", "metric", "imperial"].map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => updateProfile({ preferredSystem: opt })}
              className={`${btnBase} ${
                profile.preferredSystem === opt
                  ? "bg-gray-900 text-white"
                  : "text-gray-700 hover:bg-gray-100"
              }`}
              aria-pressed={profile.preferredSystem === opt}
            >
              {opt === "auto"
                ? "Auto"
                : opt === "metric"
                ? "Metric"
                : "Imperial"}
            </button>
          ))}
        </div>

        {/* Per-100 toggles */}
        <div className={compactGroup} aria-label="Per-100 display toggles">
          <button
            type="button"
            onClick={() =>
              updateProfile({
                showPerHundred: { mass: !profile.showPerHundred.mass },
              })
            }
            className={`${btnBase} ${
              profile.showPerHundred.mass
                ? "bg-emerald-600 text-white"
                : "text-gray-700 hover:bg-gray-100"
            }`}
            aria-pressed={profile.showPerHundred.mass}
            title="Toggle per-100g vs per-g"
          >
            {profile.showPerHundred.mass ? "per 100g" : "per g"}
          </button>

          <button
            type="button"
            onClick={() =>
              updateProfile({
                showPerHundred: { volume: !profile.showPerHundred.volume },
              })
            }
            className={`${btnBase} ${
              profile.showPerHundred.volume
                ? "bg-sky-600 text-white"
                : "text-gray-700 hover:bg-gray-100"
            }`}
            aria-pressed={profile.showPerHundred.volume}
            title="Toggle per-100mL vs per-mL"
          >
            {profile.showPerHundred.volume ? "per 100mL" : "per mL"}
          </button>
        </div>

        {/* Strategy toggle (PriceComparator) */}
        {showStrategyToggle && (
          <div className={compactGroup} aria-label="Comparison strategy">
            {["auto", "per100g", "per100mL", "perUnit"].map((opt) => (
              <button
                key={opt}
                type="button"
                onClick={() => updateStrategy(opt)}
                className={`${btnBase} ${
                  strategy === opt
                    ? "bg-indigo-600 text-white"
                    : "text-gray-700 hover:bg-gray-100"
                }`}
                aria-pressed={strategy === opt}
                title={`Compare by ${labelForStrategy(opt)}`}
              >
                {labelForStrategy(opt)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- small subcomponents & icons

function FavoriteSelect({ favorites, onApply, onDelete }) {
  if (!favorites?.length) {
    return (
      <span className="hidden items-center rounded-xl border border-gray-200 px-3 py-2 text-xs text-gray-500 md:inline-flex">
        No favorites yet
      </span>
    );
  }
  return (
    <div className="relative">
      <details className="group inline-block">
        <summary className="flex cursor-pointer list-none items-center gap-1 rounded-xl border border-gray-200 px-3 py-2 text-xs font-semibold text-gray-700 hover:bg-gray-100">
          Favorites
          <ChevronDown className="h-4 w-4 transition group-open:rotate-180" />
        </summary>
        <div className="absolute right-0 z-10 mt-1 w-72 rounded-xl border border-gray-200 bg-white p-2 shadow-lg">
          <ul className="max-h-60 overflow-auto text-sm">
            {favorites.map((f) => (
              <li
                key={f.id}
                className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-gray-50"
              >
                <button
                  type="button"
                  onClick={() => onApply?.(f.id)}
                  className="truncate text-left text-gray-800 hover:underline"
                  title={f.label}
                >
                  {f.label}
                </button>
                <button
                  type="button"
                  onClick={() => onDelete?.(f.id)}
                  className="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                  title="Delete favorite"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      </details>
    </div>
  );
}

function labelForStrategy(s) {
  if (s === "per100g") return "per 100g";
  if (s === "per100mL") return "per 100mL";
  if (s === "perUnit") return "per unit";
  return "Auto";
}

function StarIcon(props) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M10 2.5l2.472 5.007 5.528.804-4 3.898.944 5.505L10 15.75l-4.944 2.964.944-5.505-4-3.898 5.528-.804L10 2.5z" />
    </svg>
  );
}
function ChevronDown(props) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 10.06l3.71-2.83a.75.75 0 1 1 .92 1.18l-4.17 3.18a.75.75 0 0 1-.92 0L5.21 8.41a.75.75 0 0 1 .02-1.2z" />
    </svg>
  );
}

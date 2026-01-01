// C:\Users\larho\suka-smart-assistant\src\features\import\ImportPreviewCard.jsx
// Dynamic, event-aware preview card for imported items
// -----------------------------------------------------------------------------
// UPDATED to cover **your full domains**:
//  - cleaning (plans, zone routines, declutter sessions)
//  - garden planning (seeds/rows/zone/co-op)
//  - garden CARE / MAINTENANCE (watering, weeding, fertilizing, pest, pruning)
//  - garden HARVEST (yield logs → inventory/cooking)
//  - storehouse stock planning (grocery sections for inspiration)
//  - meal planning
//  - animal acquisition, care, and butchery (animalPlan + animalCare + animalButchery)
//  - inventory / scan-compare-trust
//
// GOALS from your project chats:
// 1. “Well-executed website” preview of what just got imported.
// 2. Let the USER save their OWN favorite sessions/schedules — not just system ones.
// 3. Support reverse generation → “Export / Share / Sell / Send to Hub” button.
// 4. Integrate with shared orchestration:
//      - listen: import.queue.updated, import.queue.done, import.service.completed, import.normalized
//      - emit: import.preview.favorite, import.preview.reverse, automation.schedule.request
// 5. Fit into your overarching UI style: tight card, action row, domain badge, deep-link to right page.
// 6. Show domain-specific fields (cleaning tasks, garden seeds, harvest items, storehouse sections, animals).
// -----------------------------------------------------------------------------

import React, { useEffect, useState, useCallback } from "react";
import { ImportService } from "./ImportService";

const isBrowser = typeof window !== "undefined";

// domain → color classes (extend to new domains)
const DOMAIN_COLORS = {
  recipe: "bg-emerald-100 text-emerald-800",
  mealPlan: "bg-blue-100 text-blue-800",
  gardenPlan: "bg-lime-100 text-lime-800",
  gardenCare: "bg-green-100 text-green-800",
  gardenHarvest: "bg-amber-100 text-amber-800",
  cleaningSession: "bg-indigo-100 text-indigo-800",
  storehouseGoal: "bg-orange-100 text-orange-800",
  storehouseStockPlan: "bg-orange-100 text-orange-800",
  animalPlan: "bg-rose-100 text-rose-800",
  animalCare: "bg-pink-100 text-pink-800",
  animalButchery: "bg-red-100 text-red-800",
  inventoryUpdate: "bg-slate-100 text-slate-800",
  default: "bg-slate-100 text-slate-800",
};

// tiny utility
function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

// pick a nice label for *all* your new domains
function domainLabel(type) {
  switch (type) {
    case "recipe":
      return "Recipe";
    case "mealPlan":
      return "Meal Plan";
    case "gardenPlan":
      return "Garden Plan";
    case "gardenCare":
      return "Garden Care";
    case "gardenHarvest":
      return "Garden Harvest";
    case "cleaningSession":
      return "Cleaning Plan";
    case "storehouseGoal":
      return "Storehouse Goal";
    case "storehouseStockPlan":
      return "Storehouse Stock Plan";
    case "animalPlan":
      return "Animal Plan";
    case "animalCare":
      return "Animal Care";
    case "animalButchery":
      return "Animal Butchery";
    case "inventoryUpdate":
      return "Inventory Update";
    default:
      return "Imported Item";
  }
}

// icon set (text emoji for now – swap with lucide later)
function domainIcon(type) {
  switch (type) {
    case "recipe":
      return "🍲";
    case "mealPlan":
      return "🗓️";
    case "gardenPlan":
      return "🌱";
    case "gardenCare":
      return "🪴";
    case "gardenHarvest":
      return "🧺";
    case "cleaningSession":
      return "🧼";
    case "storehouseGoal":
      return "🏛️";
    case "storehouseStockPlan":
      return "🛒";
    case "animalPlan":
      return "🐑";
    case "animalCare":
      return "🩺";
    case "animalButchery":
      return "🔪";
    case "inventoryUpdate":
      return "📦";
    default:
      return "📥";
  }
}

// infer where to deep-link
function domainLink(type) {
  switch (type) {
    case "recipe":
    case "mealPlan":
      return "/tier2/household/meals";
    case "gardenPlan":
    case "gardenCare":
    case "gardenHarvest":
      return "/tier2/household/garden";
    case "cleaningSession":
      return "/tier2/household/chores";
    case "storehouseGoal":
    case "storehouseStockPlan":
      return "/tier2/household/storehouse";
    case "animalPlan":
    case "animalCare":
    case "animalButchery":
      return "/tier2/household/animals";
    case "inventoryUpdate":
      return "/tier2/household/inventory";
    default:
      return null;
  }
}

export default function ImportPreviewCard({
  item: propItem,
  onFavorite,
  onReverse,
  onSchedule,
  compact = false,
}) {
  const [item, setItem] = useState(() => propItem || null);
  const [saving, setSaving] = useState(false);
  const [reversePayload, setReversePayload] = useState(null);
  const [showDetails, setShowDetails] = useState(false);

  // subscribe to global imports when no propItem is given
  useEffect(() => {
    if (propItem) return undefined;
    if (!isBrowser) return undefined;

    const handler = (ev) => {
      const { normalized } = ev.detail || {};
      if (normalized) {
        setItem(normalized);
        setReversePayload(null);
      }
    };

    const doneHandler = (ev) => {
      const { normalized } = ev.detail || {};
      if (normalized) {
        setItem(normalized);
        setReversePayload(null);
      }
    };

    window.addEventListener("import.service.completed", handler);
    window.addEventListener("import.queue.done", doneHandler);
    window.addEventListener("import.normalized", handler);

    return () => {
      window.removeEventListener("import.service.completed", handler);
      window.removeEventListener("import.queue.done", doneHandler);
      window.removeEventListener("import.normalized", handler);
    };
  }, [propItem]);

  const handleFavorite = useCallback(() => {
    if (!item) return;
    setSaving(true);
    try {
      const favs = ImportService.saveAsFavorite(item);
      if (typeof onFavorite === "function") {
        onFavorite(item, favs);
      }
      if (isBrowser) {
        window.dispatchEvent(
          new CustomEvent("import.preview.favorite", {
            detail: { item, favorites: favs },
          }),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[ImportPreviewCard] favorite failed:", err);
    } finally {
      setSaving(false);
    }
  }, [item, onFavorite]);

  const handleReverse = useCallback(() => {
    if (!item) return;
    const reversed = ImportService.reverse(item);
    setReversePayload(reversed);
    if (typeof onReverse === "function") {
      onReverse(item, reversed);
    }
    if (isBrowser) {
      window.dispatchEvent(
        new CustomEvent("import.preview.reverse", {
          detail: { item, reversed },
        }),
      );
    }
  }, [item, onReverse]);

  const handleSchedule = useCallback(() => {
    if (!item) return;
    // infer domain → action for automation runtime
    const domainToAction = {
      recipe: "run-imported",
      mealPlan: "hydrate-meal-plan",
      gardenPlan: "hydrate-garden-plan",
      gardenCare: "run-garden-care",
      gardenHarvest: "process-harvest",
      cleaningSession: "run-cleaning-session",
      storehouseGoal: "recalculate-storehouse",
      storehouseStockPlan: "recalculate-storehouse",
      animalPlan: "run-animal-plan",
      animalCare: "run-animal-care",
      animalButchery: "run-animal-butchery",
      inventoryUpdate: "apply-inventory-update",
    };
    const action = domainToAction[item.type] || "run-imported";

    const schedule = {
      id: `import-${item.id}-once`,
      type: item.type,
      frequency: "once",
      runAt: Date.now() + 5 * 60 * 1000,
    };

    if (typeof onSchedule === "function") {
      onSchedule(item, schedule);
    }

    if (isBrowser) {
      window.dispatchEvent(
        new CustomEvent("automation.schedule.request", {
          detail: {
            source: "import.preview.card",
            normalized: item,
            schedule,
            session: {
              domain: item.type,
              action,
              payload: item,
            },
          },
        }),
      );
    }
  }, [item, onSchedule]);

  if (!item) {
    // empty state
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/70 p-4 text-sm text-slate-500">
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-full bg-slate-200/80 flex items-center justify-center text-lg">
            📥
          </div>
          <div>
            <div className="font-semibold text-slate-600">No imports yet</div>
            <div>Import something (file, bookmarklet, Pinterest, Scan • Compare • Trust) to preview it here.</div>
          </div>
        </div>
      </div>
    );
  }

  const domainClass = DOMAIN_COLORS[item.type] || DOMAIN_COLORS.default;
  const badgeLabel = domainLabel(item.type);
  const icon = domainIcon(item.type);
  const link = domainLink(item.type);

  // domain-specific little previews
  const renderBody = () => {
    if (item.type === "recipe") {
      return (
        <>
          <div className="font-medium text-slate-700">Ingredients:</div>
          <div className="line-clamp-2">
            {(item.ingredients || [])
              .slice(0, 5)
              .map((ing) => (typeof ing === "string" ? ing : ing?.name || ""))
              .filter(Boolean)
              .join(", ") || "—"}
          </div>
        </>
      );
    }

    if (item.type === "mealPlan") {
      return (
        <>
          <div className="font-medium text-slate-700">Days:</div>
          <div className="line-clamp-2">
            {(item.days || []).slice(0, 3).map((d) => d?.date || "Day").join(", ") || "—"}
          </div>
        </>
      );
    }

    if (item.type === "gardenPlan") {
      return (
        <>
          <div className="font-medium text-slate-700">Seeds / Rows:</div>
          <div className="line-clamp-2">
            {(item.seeds || item.rows || [])
              .slice(0, 5)
              .map((s) => s?.name || s?.title || s)
              .filter(Boolean)
              .join(", ") || "—"}
          </div>
          {item.zone ? <div className="text-[11px] text-slate-500">Zone: {item.zone}</div> : null}
        </>
      );
    }

    if (item.type === "gardenCare") {
      return (
        <>
          <div className="font-medium text-slate-700">Tasks:</div>
          <div className="line-clamp-2">
            {(item.tasks || [])
              .slice(0, 5)
              .map((t) => t?.task || t?.title || t?.name)
              .filter(Boolean)
              .join(", ") || "—"}
          </div>
        </>
      );
    }

    if (item.type === "gardenHarvest") {
      return (
        <>
          <div className="font-medium text-slate-700">Harvest:</div>
          <div className="line-clamp-2">
            {(item.harvest || [])
              .slice(0, 5)
              .map((h) => `${h?.crop || h?.name} (${h?.qty ?? 1}${h?.unit ? ` ${h.unit}` : ""})`)
              .filter(Boolean)
              .join(", ") || "—"}
          </div>
        </>
      );
    }

    if (item.type === "cleaningSession") {
      return (
        <>
          <div className="font-medium text-slate-700">Cleaning Tasks:</div>
          <div className="line-clamp-2">
            {(item.tasks || [])
              .slice(0, 5)
              .map((t) => `${t?.task || t?.title || "Task"}${t?.room ? ` @ ${t.room}` : ""}`)
              .join("; ") || "—"}
          </div>
        </>
      );
    }

    if (item.type === "storehouseGoal" || item.type === "storehouseStockPlan") {
      return (
        <>
          <div className="font-medium text-slate-700">Storehouse Items (by section):</div>
          <div className="line-clamp-2">
            {(item.items || [])
              .slice(0, 5)
              .map((it) => {
                const nm = it?.name || it?.item || "Item";
                const sec = it?.section || it?.category;
                return sec ? `${nm} [${sec}]` : nm;
              })
              .join(", ") || "—"}
          </div>
        </>
      );
    }

    if (item.type === "animalPlan" || item.type === "animalCare" || item.type === "animalButchery") {
      return (
        <>
          <div className="font-medium text-slate-700">Animals:</div>
          <div className="line-clamp-2">
            {(item.animals || item.entries || item.animalEntries || [])
              .slice(0, 5)
              .map((a) => a?.name || a?.breed || a?.type || "Animal")
              .join(", ") || "—"}
          </div>
          {item.breedsByGeo?.length ? (
            <div className="text-[11px] text-slate-500">
              Breeds for your geo: {item.breedsByGeo.slice(0, 3).join(", ")}
            </div>
          ) : null}
        </>
      );
    }

    if (item.type === "inventoryUpdate") {
      return (
        <>
          <div className="font-medium text-slate-700">Updates:</div>
          <div className="line-clamp-2">
            {(item.updates || [])
              .slice(0, 5)
              .map((u) => `${u?.sku || u?.name || "item"} → ${u?.qty || u?.quantity || u?.delta || ""}`)
              .join("; ") || "—"}
          </div>
        </>
      );
    }

    // fallback
    return <div className="text-xs text-slate-500">No preview for this type.</div>;
  };

  return (
    <div
      className={classNames(
        "flex flex-col rounded-xl border border-slate-200 bg-white/80 shadow-sm",
        compact ? "p-3 gap-2" : "p-4 gap-3",
      )}
    >
      {/* header */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center text-lg">
            {icon}
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-800 leading-tight">
              {item.title || item.name || "Imported Item"}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {item.source?.kind ? `from ${item.source.kind}` : "imported"}
              {item.source?.boardTitle ? ` • ${item.source.boardTitle}` : ""}
            </div>
          </div>
        </div>
        <span
          className={classNames(
            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
            domainClass,
          )}
        >
          {badgeLabel}
        </span>
      </div>

      {/* body */}
      {!compact && (
        <div className="mt-2 text-xs text-slate-600 space-y-1">
          {renderBody()}
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            className="mt-2 text-[11px] text-slate-500 underline underline-offset-2 hover:text-slate-700"
          >
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <pre className="mt-1 max-h-36 overflow-auto rounded bg-slate-50 p-2 text-[10px] leading-4 text-slate-700">
              {JSON.stringify(item, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* action bar */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* Save favorite */}
        <button
          type="button"
          onClick={handleFavorite}
          className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-slate-400/40"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save as Favorite"}
        </button>

        {/* Reverse / export */}
        <button
          type="button"
          onClick={handleReverse}
          className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
        >
          Reverse / Export
        </button>

        {/* Schedule */}
        <button
          type="button"
          onClick={handleSchedule}
          className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 ring-1 ring-blue-100 hover:bg-blue-100"
        >
          Schedule
        </button>

        {/* Deep link */}
        {link ? (
          <a href={link} className="ml-auto text-[11px] text-slate-500 hover:text-slate-700">
            Open {domainLabel(item.type)} →
          </a>
        ) : null}
      </div>

      {/* reverse payload display (quick copy) */}
      {reversePayload && (
        <div className="mt-2 rounded-lg bg-slate-50 p-2">
          <div className="text-[10px] font-semibold text-slate-600 mb-1">Exported / Shareable Payload</div>
          <pre className="max-h-28 overflow-auto text-[10px] leading-4 text-slate-700">
            {JSON.stringify(reversePayload, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

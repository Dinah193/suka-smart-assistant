// C:\Users\larho\suka-smart-assistant\src\features\import\ImportPreviewModal.jsx
// Dynamic, event-aware IMPORT PREVIEW MODAL
// -----------------------------------------------------------------------------
// UPDATED to your latest scope:
//  - cleaning (plans, room/zone rotations, declutter)
//  - garden planning (seeds/rows/zone/co-op)
//  - garden CARE / MAINTENANCE (watering, weeding, fertilizing, pest control)
//  - garden HARVEST (yield → inventory → cooking/preserving)
//  - storehouse stock planning (with grocery-section-style items)
//  - meal planning
//  - animal acquisition, care, and butchery (animalPlan, animalCare, animalButchery)
//  - inventory / scan-compare-trust
//
// It now:
//  ✓ listens to import.service.completed, import.queue.done, import.preview.open
//  ✓ saves USER-OWNED favorites (not just system)
//  ✓ supports reverse generation (export/share/sell/send to hub)
//  ✓ forwards schedules to automation.runtime (automation.schedule.request)
//  ✓ deep-links to the right Tier 2 pages
//  ✓ is styled like well-executed dashboards (clean header, tabs, action-row)
//  ✓ stays in sync with ImportPreviewCard (so you can use them together)
// -----------------------------------------------------------------------------

import React, { useEffect, useState, useCallback } from "react";
import ImportPreviewCard from "./ImportPreviewCard";
import { ImportService } from "./ImportService";

const isBrowser = typeof window !== "undefined";

function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

// map domain → deep link (extended for all your domains)
function getDomainLink(item) {
  const type = item?.type;
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

// map domain → sensible automation action
function getDomainAction(item) {
  const type = item?.type;
  const mapping = {
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
  return mapping[type] || "run-imported";
}

export default function ImportPreviewModal() {
  const [open, setOpen] = useState(false);
  const [item, setItem] = useState(null);
  const [activeTab, setActiveTab] = useState("summary");
  const [reversePayload, setReversePayload] = useState(null);
  const [saving, setSaving] = useState(false);

  // auto-subscribe to events
  useEffect(() => {
    if (!isBrowser) return undefined;

    // open with specific item
    const openHandler = (ev) => {
      const { item: incoming } = ev.detail || {};
      if (incoming) {
        setItem(incoming);
        setReversePayload(null);
        setOpen(true);
        setActiveTab("summary");
      }
    };

    // open on any successful import (if not already open)
    const importCompleteHandler = (ev) => {
      const { normalized } = ev.detail || {};
      if (normalized) {
        setItem(normalized);
        setReversePayload(null);
        setOpen(true);
        setActiveTab("summary");
      }
    };

    // queue done (import.queue.done)
    const queueDoneHandler = (ev) => {
      const { normalized } = ev.detail || {};
      if (normalized) {
        setItem(normalized);
        setReversePayload(null);
        setOpen(true);
        setActiveTab("summary");
      }
    };

    window.addEventListener("import.preview.open", openHandler);
    window.addEventListener("import.service.completed", importCompleteHandler);
    window.addEventListener("import.queue.done", queueDoneHandler);

    return () => {
      window.removeEventListener("import.preview.open", openHandler);
      window.removeEventListener("import.service.completed", importCompleteHandler);
      window.removeEventListener("import.queue.done", queueDoneHandler);
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setItem(null);
    setReversePayload(null);
  }, []);

  // user-owned favorites
  const handleFavorite = useCallback(() => {
    if (!item) return;
    setSaving(true);
    try {
      const favs = ImportService.saveAsFavorite(item);
      if (isBrowser) {
        window.dispatchEvent(
          new CustomEvent("import.preview.favorite", {
            detail: { item, favorites: favs },
          }),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[ImportPreviewModal] save favorite failed:", err);
    } finally {
      setSaving(false);
    }
  }, [item]);

  // reverse / export / share-to-hub
  const handleReverse = useCallback(() => {
    if (!item) return;
    const reversed = ImportService.reverse(item);
    setReversePayload(reversed);
    if (isBrowser) {
      window.dispatchEvent(
        new CustomEvent("import.preview.reverse", {
          detail: { item, reversed },
        }),
      );
    }
    setActiveTab("share");
  }, [item]);

  // schedule (with domain-aware action)
  const handleSchedule = useCallback(() => {
    if (!item) return;
    const action = getDomainAction(item);

    const schedule = {
      id: `import-${item.id}-once`,
      runAt: Date.now() + 5 * 60 * 1000,
      frequency: "once",
      type: item.type,
      label: item.title || item.name || "Imported Item",
    };

    if (isBrowser) {
      window.dispatchEvent(
        new CustomEvent("automation.schedule.request", {
          detail: {
            source: "import.preview.modal",
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

    // show feedback in modal
    setActiveTab("summary");
  }, [item]);

  const renderDomainLink = () => {
    if (!item) return null;
    const link = getDomainLink(item);
    if (!link) return null;
    return (
      <a
        href={link}
        className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
      >
        Open {item.type === "storehouseStockPlan" ? "Storehouse" : item.type === "cleaningSession" ? "Chores" : "Page"} →
      </a>
    );
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-slate-950/40 backdrop-blur-sm">
      {/* modal shell */}
      <div className="relative flex h-[90vh] w-[min(1080px,94vw)] flex-col overflow-hidden rounded-2xl bg-white shadow-xl ring-1 ring-slate-900/5">
        {/* header */}
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-6 py-4 bg-white/80">
          <div className="flex flex-col gap-1">
            <div className="text-sm font-semibold text-slate-900 leading-tight">
              {item?.title || item?.name || "Imported Item"}
            </div>
            <div className="text-xs text-slate-500 flex gap-2 items-center">
              <span>
                {item?.source?.kind ? `From ${item.source.kind}` : "Imported"}
                {item?.source?.boardTitle ? ` • ${item.source.boardTitle}` : ""}
              </span>
              {renderDomainLink()}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleFavorite}
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              disabled={saving}
            >
              {saving ? "Saving..." : "Save as Favorite"}
            </button>
            <button
              type="button"
              onClick={handleReverse}
              className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              Reverse / Export
            </button>
            <button
              type="button"
              onClick={handleSchedule}
              className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 ring-1 ring-blue-100 hover:bg-blue-100"
            >
              Schedule
            </button>
            <button
              type="button"
              onClick={close}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:text-slate-700"
            >
              ✕
            </button>
          </div>
        </div>

        {/* tabs */}
        <div className="flex items-center gap-2 border-b border-slate-100 px-6 py-2 bg-slate-50/60">
          <button
            type="button"
            onClick={() => setActiveTab("summary")}
            className={classNames(
              "rounded-md px-3 py-1.5 text-xs font-medium",
              activeTab === "summary" ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700",
            )}
          >
            Summary
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("raw")}
            className={classNames(
              "rounded-md px-3 py-1.5 text-xs font-medium",
              activeTab === "raw" ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700",
            )}
          >
            Raw Payload
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("share")}
            className={classNames(
              "rounded-md px-3 py-1.5 text-xs font-medium",
              activeTab === "share" ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700",
            )}
          >
            Share / Sell
          </button>
          <div className="ml-auto text-[11px] text-slate-400">
            Tip: Imported items auto-sync to Meals, Garden, Cleaning, Storehouse, and Animals pages for editing.
          </div>
        </div>

        {/* content */}
        <div className="flex-1 overflow-auto bg-slate-50/40">
          {activeTab === "summary" && (
            <div className="p-6">
              {/* reuse the card for consistent styling & domain-specific previews */}
              <ImportPreviewCard item={item} compact={false} />
            </div>
          )}

          {activeTab === "raw" && (
            <div className="h-full p-6">
              <div className="text-xs font-semibold text-slate-600 mb-2">Raw / Normalized Payload</div>
              <pre className="h-[60vh] overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-5 text-slate-100">
                {JSON.stringify(item, null, 2)}
              </pre>
            </div>
          )}

          {activeTab === "share" && (
            <div className="p-6 space-y-4">
              <div className="text-xs font-semibold text-slate-600">
                Export / Reverse-Generated Payload (share / sell / send to hub)
              </div>
              {!reversePayload ? (
                <div className="text-xs text-slate-500">
                  Click <span className="font-semibold">"Reverse / Export"</span> in the header to generate a shareable
                  payload.
                </div>
              ) : (
                <>
                  <pre className="max-h-[40vh] overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-5 text-slate-100">
                    {JSON.stringify(reversePayload, null, 2)}
                  </pre>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        if (!isBrowser) return;
                        try {
                          navigator.clipboard.writeText(JSON.stringify(reversePayload, null, 2));
                        } catch {
                          // ignore
                        }
                      }}
                      className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
                    >
                      Copy JSON
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!isBrowser) return;
                        window.dispatchEvent(
                          new CustomEvent("import.preview.share-to-hub", {
                            detail: { payload: reversePayload, source: "import.preview.modal" },
                          }),
                        );
                      }}
                      className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 ring-1 ring-emerald-100 hover:bg-emerald-100"
                    >
                      Send to Family Fund Hub
                    </button>
                  </div>
                  <div className="text-[10px] text-slate-400">
                    You can store this payload or list it for sale/sharing in your co-op / marketplace.
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

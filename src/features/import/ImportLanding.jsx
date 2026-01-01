// C:\Users\larho\suka-smart-assistant\src\features\import\ImportLanding.jsx
// High-level landing / dashboard for ALL imports
// -----------------------------------------------------------------------------
// UPDATED to your 10/30 scope:
//  - cleaning imports (room/zone, declutter, recurring routines)
//  - garden planning (seeds/rows/zone/co-op)
//  - garden CARE / MAINTENANCE (watering, weeding, fertilizing, pest)
//  - garden HARVEST (yield → inventory → cooking/preserving)
//  - storehouse stock planning (with grocery-section inspiration)
//  - meal planning
//  - animal acquisition, care, and butchery
//  - inventory / scan-compare-trust
//
// WHAT THIS PAGE DOES NOW
// - Presents a single “Imports” page like a polished SaaS dashboard.
// - Shows: Recent Imports, Active Queue, User Favorites (user-owned, not just system).
// - Lets user:
//     ✓ enqueue new import from source
//     ✓ process queue
//     ✓ save/import as favorite
//     ✓ reverse-generate
//     ✓ open the full-screen ImportPreviewModal
//     ✓ send to hub / co-op (via events, handled by modal / other listeners)
// - Integrates with shared orchestration events
//     - listens for: import.queue.updated, import.service.completed,
//                    import.favorite.saved, import.preview.favorite
//     - emits: import.preview.open
// - Keeps “plan with others / co-op” in mind
//
// NEW: we expanded the quick-add and list badges to surface the NEW DOMAINS you added:
//   cleaningSession, gardenCare, gardenHarvest, storehouseGoal, storehouseStockPlan,
//   animalPlan, animalCare, animalButchery
// -----------------------------------------------------------------------------

import React, { useEffect, useState, useCallback } from "react";
import { ImportService } from "./ImportService";
import { ImportQueueManager } from "./ImportQueueManager";
import ImportPreviewCard from "./ImportPreviewCard";
import ImportPreviewModal from "./ImportPreviewModal";

const isBrowser = typeof window !== "undefined";

function classNames(...arr) {
  return arr.filter(Boolean).join(" ");
}

// OPTIONAL: domain → nice badge text (used in lists)
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
      return "Butchery Plan";
    case "inventoryUpdate":
      return "Inventory Update";
    default:
      return type || "Imported";
  }
}

export default function ImportLanding() {
  const [recents, setRecents] = useState(() => ImportService.getRecent?.() || []);
  const [favorites, setFavorites] = useState(() => ImportService.getFavorites?.() || []);
  const [queueState, setQueueState] = useState(() => ImportQueueManager.getState?.() || { items: [] });
  const [filter, setFilter] = useState("all"); // all | queue | favorites | recent
  const [showAddPanel, setShowAddPanel] = useState(false);

  // subscribe to updates from queue + service
  useEffect(() => {
    if (!isBrowser) return undefined;

    const onQueueUpdated = (ev) => {
      setQueueState(ev.detail?.state || ImportQueueManager.getState());
    };
    const onServiceCompleted = () => {
      setRecents(ImportService.getRecent());
    };
    const onFavorite = () => {
      setFavorites(ImportService.getFavorites());
    };

    window.addEventListener("import.queue.updated", onQueueUpdated);
    window.addEventListener("import.service.completed", onServiceCompleted);
    window.addEventListener("import.favorite.saved", onFavorite);
    window.addEventListener("import.preview.favorite", onFavorite);

    return () => {
      window.removeEventListener("import.queue.updated", onQueueUpdated);
      window.removeEventListener("import.service.completed", onServiceCompleted);
      window.removeEventListener("import.favorite.saved", onFavorite);
      window.removeEventListener("import.preview.favorite", onFavorite);
    };
  }, []);

  // queue actions
  const handleProcessNext = useCallback(async () => {
    await ImportQueueManager.processNext();
  }, []);

  const handleProcessAll = useCallback(async () => {
    await ImportQueueManager.processAll();
  }, []);

  // quick enqueue (expanded for your new domains)
  const handleQuickEnqueue = useCallback((sourceType) => {
    switch (sourceType) {
      case "file": {
        const payload = {
          title: "Imported File Demo",
          ingredients: ["Water", "Salt", "Flour"],
        };
        ImportQueueManager.enqueue("file", payload, { saveAsFavorite: false });
        break;
      }
      case "pinterest": {
        // could be recipes + garden + care
        ImportQueueManager.enqueue("pinterest", {
          boardTitle: "My Meal & Garden Ideas",
          detectedType: "mealPlan",
          days: [],
        });
        break;
      }
      case "scan-compare-trust": {
        // inventory style
        ImportQueueManager.enqueue("scan-compare-trust", {
          updates: [{ name: "Tomato Sauce", qty: 4 }],
          store: "Sams",
        });
        break;
      }
      case "cleaning-plan": {
        ImportQueueManager.enqueue("cleaning-plan", {
          type: "cleaning-plan",
          title: "Zone Cleaning – Kitchen",
          tasks: [
            { task: "Wipe counters", freq: "DAILY", room: "Kitchen" },
            { task: "Mop floor", freq: "WEEKLY", room: "Kitchen" },
          ],
        });
        break;
      }
      case "garden-plan": {
        ImportQueueManager.enqueue("garden-plan", {
          type: "garden-plan",
          title: "Spring Garden 2026",
          seeds: [{ name: "Tomatoes" }, { name: "Cucumbers" }, { name: "Okra" }],
          zone: "8b",
        });
        break;
      }
      case "garden-care": {
        ImportQueueManager.enqueue("garden-care", {
          type: "garden-care",
          title: "Weekly Garden Care",
          tasks: [
            { task: "Water raised beds", when: "2025-11-01" },
            { task: "Check for pests", when: "2025-11-02" },
          ],
        });
        break;
      }
      case "garden-harvest": {
        ImportQueueManager.enqueue("garden-harvest", {
          type: "garden-harvest",
          title: "October Harvest",
          items: [
            { crop: "Tomatoes", qty: 10, unit: "lb" },
            { crop: "Peppers", qty: 4, unit: "lb" },
          ],
        });
        break;
      }
      case "storehouse": {
        ImportQueueManager.enqueue("bookmarklet", {
          __importType: "storehouseGoal",
          title: "Winter Storehouse – Grocery Sections",
          // grocery-section inspiration
          items: [
            { name: "Grains: Flour 50 lb" },
            { name: "Canned: Tomatoes 24 cans" },
            { name: "Frozen: Mixed veg 12 bags" },
            { name: "Cleaning: Dish soap 3" },
          ],
          target: "storehouse",
        });
        break;
      }
      case "animals": {
        ImportQueueManager.enqueue("bookmarklet", {
          __importType: "animalPlan",
          title: "Meat Production 2026",
          animals: [
            { name: "Lamb", count: 6, butcheryMonth: "2026-06" },
            { name: "Goat", count: 4, butcheryMonth: "2026-07" },
          ],
          breedsByGeo: [
            { region: "Southeast US", breeds: ["Kiko", "Boer cross", "Dorper"] },
          ],
        });
        break;
      }
      default: {
        // fallback bookmarklet → recipe
        ImportQueueManager.enqueue("bookmarklet", {
          title: "Bookmarklet Recipe",
          ingredients: ["Ingredient 1", "Ingredient 2"],
          steps: ["Do a thing", "Do another thing"],
        });
      }
    }
  }, []);

  const openPreview = useCallback((item) => {
    if (!isBrowser) return;
    window.dispatchEvent(new CustomEvent("import.preview.open", { detail: { item } }));
  }, []);

  const handleReverseFromList = useCallback((item) => {
    const reversed = ImportService.reverse(item);
    if (!isBrowser) return;
    window.dispatchEvent(new CustomEvent("import.preview.reverse", { detail: { item, reversed } }));
    // open modal to show export
    window.dispatchEvent(new CustomEvent("import.preview.open", { detail: { item } }));
  }, []);

  const handleFavoriteFromList = useCallback((item) => {
    ImportService.saveAsFavorite(item);
    setFavorites(ImportService.getFavorites());
  }, []);

  // filter helpers
  const pendingItems = (queueState.items || []).filter((i) => i.status === "pending");
  const processingItems = (queueState.items || []).filter((i) => i.status === "processing");
  const failedItems = (queueState.items || []).filter((i) => i.status === "failed");

  const renderQueueSection = () => (
    <div className="rounded-xl bg-white/80 shadow-sm border border-slate-200 p-4 flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Import Queue</div>
          <div className="text-xs text-slate-500">
            {pendingItems.length} pending • {processingItems.length} processing • {failedItems.length} failed
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={handleProcessNext}
            className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
            disabled={!pendingItems.length}
          >
            Run next
          </button>
          <button
            type="button"
            onClick={handleProcessAll}
            className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-xs font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            disabled={!pendingItems.length}
          >
            Run all
          </button>
        </div>
      </div>
      <div className="space-y-2 overflow-auto">
        {(queueState.items || []).length === 0 && (
          <div className="text-xs text-slate-400">Nothing in the queue. Try importing from a source.</div>
        )}
        {(queueState.items || []).map((it) => (
          <div
            key={it.id}
            className={classNames(
              "flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs",
              it.status === "pending" ? "bg-slate-50" : "",
              it.status === "processing" ? "bg-blue-50/80" : "",
              it.status === "done" ? "bg-emerald-50/80" : "",
              it.status === "failed" ? "bg-rose-50/80" : "",
            )}
          >
            <div className="flex flex-col gap-0.5">
              <div className="font-medium text-slate-700 line-clamp-1">
                {it.opts?.label || it.payload?.title || it.payload?.name || "Queued import"}
              </div>
              <div className="text-[10px] text-slate-500">
                {domainLabel(it.payload?.__importType || it.payload?.type || it.sourceType)} • {it.sourceType} • {it.status}
              </div>
            </div>
            <div className="flex gap-1">
              {it.status === "done" && it.normalized && (
                <>
                  <button
                    type="button"
                    onClick={() => openPreview(it.normalized)}
                    className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                  >
                    View
                  </button>
                  <button
                    type="button"
                    onClick={() => handleFavoriteFromList(it.normalized)}
                    className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                  >
                    Fav
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReverseFromList(it.normalized)}
                    className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                  >
                    ↩︎
                  </button>
                </>
              )}
              {it.status === "pending" && (
                <button
                  type="button"
                  onClick={() => ImportQueueManager.processOne(it.id)}
                  className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                >
                  Run
                </button>
              )}
              {it.status === "failed" && (
                <button
                  type="button"
                  onClick={() => ImportQueueManager.processOne(it.id)}
                  className="rounded bg-white/80 px-2 py-1 text-[10px] text-rose-600 ring-1 ring-rose-200 hover:bg-rose-50"
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                onClick={() => ImportQueueManager.remove(it.id)}
                className="rounded bg-transparent px-2 py-1 text-[10px] text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderRecentSection = () => (
    <div className="rounded-xl bg-white/80 shadow-sm border border-slate-200 p-4 flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Recent Imports</div>
          <div className="text-xs text-slate-500">{recents.length} total</div>
        </div>
        <button
          type="button"
          onClick={() => setRecents(ImportService.getRecent())}
          className="text-[11px] text-slate-400 hover:text-slate-600"
        >
          Refresh
        </button>
      </div>
      <div className="space-y-3 overflow-auto">
        {recents.length === 0 && <div className="text-xs text-slate-400">No imports yet.</div>}
        {recents.map((r) => (
          <div key={r.id} className="rounded-lg bg-slate-50/70 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col">
                <div className="text-xs font-medium text-slate-700 line-clamp-1">
                  {r.title || "Imported Item"}
                </div>
                <div className="text-[10px] text-slate-500">
                  {domainLabel(r.type)} • {r.at ? new Date(r.at).toLocaleString() : ""}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => openPreview(r)}
                  className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                >
                  View
                </button>
                <button
                  type="button"
                  onClick={() => handleFavoriteFromList(r)}
                  className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                >
                  Fav
                </button>
                <button
                  type="button"
                  onClick={() => handleReverseFromList(r)}
                  className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                >
                  ↩︎
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  const renderFavoritesSection = () => (
    <div className="rounded-xl bg-white/80 shadow-sm border border-slate-200 p-4 flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">User Favorites</div>
          <div className="text-xs text-slate-500">{favorites.length} saved</div>
        </div>
        <button
          type="button"
          onClick={() => setFavorites(ImportService.getFavorites())}
          className="text-[11px] text-slate-400 hover:text-slate-600"
        >
          Refresh
        </button>
      </div>
      <div className="space-y-3 overflow-auto">
        {favorites.length === 0 && <div className="text-xs text-slate-400">No favorites yet.</div>}
        {favorites.map((f) => (
          <div key={f.id} className="rounded-lg bg-slate-50/70 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex flex-col">
                <div className="text-xs font-medium text-slate-700 line-clamp-1">
                  {f.title || f.payload?.title || "Favorite Item"}
                </div>
                <div className="text-[10px] text-slate-500">
                  {domainLabel(f.type || f.payload?.type)} •{" "}
                  {f.createdAt ? new Date(f.createdAt).toLocaleString() : ""}
                </div>
              </div>
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => openPreview(f.payload || f)}
                  className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                >
                  View
                </button>
                <button
                  type="button"
                  onClick={() => handleReverseFromList(f.payload || f)}
                  className="rounded bg-white/80 px-2 py-1 text-[10px] text-slate-600 ring-1 ring-slate-200 hover:bg-slate-100"
                >
                  ↩︎
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <>
      <div className="w-full h-full flex flex-col gap-4">
        {/* hero / header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-slate-900 leading-tight">Imports</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Pull in data from bookmarklets, uploads, Pinterest, scan • compare • trust, garden & animal planners,
              storehouse templates, and cleaning routines — then normalize, queue, schedule, favorite, or share.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setShowAddPanel((v) => !v)}
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
            >
              + New import
            </button>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-md border border-slate-200 bg-white px-2 py-1.5 text-xs text-slate-700"
            >
              <option value="all">Show all</option>
              <option value="queue">Queue only</option>
              <option value="recent">Recent only</option>
              <option value="favorites">Favorites only</option>
            </select>
          </div>
        </div>

        {/* quick add panel */}
        {showAddPanel && (
          <div className="rounded-xl bg-slate-50/80 border border-slate-200 p-3 flex flex-wrap gap-2">
            <div className="text-[11px] font-medium text-slate-700 basis-full">Quick add to queue:</div>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("bookmarklet")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              From Bookmarklet
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("file")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              From File
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("pinterest")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              From Pinterest
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("scan-compare-trust")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              From Scan • Compare • Trust
            </button>
            {/* NEW quicks for your other domains */}
            <button
              type="button"
              onClick={() => handleQuickEnqueue("cleaning-plan")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              Cleaning Plan
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("garden-plan")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              Garden Plan
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("garden-care")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              Garden Care
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("garden-harvest")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              Garden Harvest
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("storehouse")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              Storehouse Stock Plan
            </button>
            <button
              type="button"
              onClick={() => handleQuickEnqueue("animals")}
              className="rounded bg-white px-3 py-1.5 text-[11px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
            >
              Animal Plan / Butchery
            </button>
          </div>
        )}

        {/* content grid */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 h-[calc(100vh-210px)]">
          {/* left: queue or all */}
          <div className={classNames("col-span-1 flex flex-col gap-4", filter !== "queue" ? "" : "xl:col-span-3")}>
            {(filter === "all" || filter === "queue") && renderQueueSection()}
          </div>

          {/* middle: recent */}
          {(filter === "all" || filter === "recent") && (
            <div className="col-span-1 flex flex-col gap-4">{renderRecentSection()}</div>
          )}

          {/* right: favorites */}
          {(filter === "all" || filter === "favorites") && (
            <div className="col-span-1 flex flex-col gap-4">{renderFavoritesSection()}</div>
          )}
        </div>

        {/* latest compact preview */}
        <div className="mt-4">
          <ImportPreviewCard compact />
        </div>
      </div>

      {/* modal lives here */}
      <ImportPreviewModal />
    </>
  );
}

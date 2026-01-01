// C:\Users\larho\suka-smart-assistant\src\features\pwa\OfflineQueueBadge.jsx
// Suka Smart Assistant – Offline Queue Badge (domain-aware)
// -----------------------------------------------------------------------------
// Shows how many PWA/bookmarklet imports are waiting, and replays them into the
// app using the *same* orchestration events as the rest of your import pipeline.
// Now aware of: cleaning, garden planning, garden care, harvest, storehouse stock,
// meal planning, and animal acquisition/care/butchery.
// -----------------------------------------------------------------------------

import React, { useEffect, useState, useCallback } from "react";

const isBrowser = typeof window !== "undefined";
const BOOKMARKLET_KEY = "suka.bookmarklet.offlineQueue.v1";

export default function OfflineQueueBadge() {
  const [count, setCount] = useState(0);
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [pulling, setPulling] = useState(false);

  // ------------------------- helpers -------------------------
  const getBookmarkletQueue = () => {
    if (!isBrowser) return [];
    try {
      const raw = window.localStorage.getItem(BOOKMARKLET_KEY);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      // shape: [{at, payload}]
      return arr.map((e) => e.payload || e).filter(Boolean);
    } catch {
      return [];
    }
  };

  const clearBookmarkletQueue = () => {
    if (!isBrowser) return;
    try {
      window.localStorage.removeItem(BOOKMARKLET_KEY);
    } catch {
      /* ignore */
    }
  };

  // ------------------------- init + SW listener -------------------------
  useEffect(() => {
    if (!isBrowser) return undefined;

    // initial: pull bookmarklet queue
    const bmInitial = getBookmarkletQueue();
    if (bmInitial.length) {
      setItems((prev) => {
        const merged = [...bmInitial, ...prev];
        setCount(merged.length);
        return merged;
      });
    }

    // if no SW, at least show bookmarklet
    if (!("serviceWorker" in navigator)) return undefined;

    const handler = (event) => {
      const data = event.data || {};

      // PWA/SW just sent us offline batch
      if (data.type === "pwa-offline-imports" || data.type === "suka:offline-imports") {
        const arr = (data.items || []).map((it) => it.payload || it);
        const bm = getBookmarkletQueue();
        const merged = [...arr, ...bm];
        setItems(merged);
        setCount(merged.length);
      }

      // single PWA share just arrived
      if (data.type === "pwa-share-received" && data.payload) {
        const bm = getBookmarkletQueue();
        const merged = [data.payload, ...bm, ...items];
        setItems(merged);
        setCount(merged.length);
      }
    };

    navigator.serviceWorker.ready.then((reg) => {
      if (!reg.active) return;
      // ask SW for offline imports
      reg.active.postMessage({ type: "suka:get-offline-imports" });
    });

    navigator.serviceWorker?.addEventListener?.("message", handler);

    return () => {
      navigator.serviceWorker?.removeEventListener?.("message", handler);
    };
  }, [items]);

  // ------------------------- domain-aware replay -------------------------
  // we keep this tiny so all replay calls go through a single function
  const dispatchImport = (payload) => {
    const sourceType =
      payload.__importType === "mealPlan"
        ? "pwa-share-target"
        : payload.source?.kind || "bookmarklet";

    // base import event (same as bookmarklet / share-receiver)
    window.dispatchEvent(
      new CustomEvent("import.queue.enqueue", {
        detail: {
          sourceType,
          payload,
          opts: {
            saveAsFavorite: !!payload.saveAsFavorite,
            schedule: payload.schedule || null,
            session: payload.session || null,
            label: payload.title,
          },
        },
      }),
    );

    // open preview
    window.dispatchEvent(
      new CustomEvent("import.service.completed", {
        detail: { normalized: payload },
      }),
    );

    // auto-open preview for user to edit if it’s domain-heavy
    if (
      payload.__importType === "cleaningPlan" ||
      payload.__importType === "gardenPlan" ||
      payload.__importType === "gardenCare" ||
      payload.__importType === "harvestPlan" ||
      payload.__importType === "storehouseStock" ||
      payload.__importType === "animalPlan" ||
      payload.__importType === "butcherySession"
    ) {
      window.dispatchEvent(
        new CustomEvent("import.preview.open", {
          detail: { item: payload },
        }),
      );
    }

    // schedule → forward to automation runtime
    if (payload.schedule) {
      window.dispatchEvent(
        new CustomEvent("automation.schedule.request", {
          detail: {
            source: "pwa.offline.badge",
            normalized: payload,
            schedule: payload.schedule,
            session:
              payload.session ||
              {
                domain: payload.__importType || payload.type,
                action: "run-imported",
                payload,
              },
          },
        }),
      );
    }

    // favorite → tell import layer
    if (payload.saveAsFavorite) {
      window.dispatchEvent(
        new CustomEvent("import.preview.favorite", {
          detail: { item: payload },
        }),
      );
    }
  };

  // replay everything we have
  const replayAll = useCallback(() => {
    if (!isBrowser) return;
    setPulling(true);

    // re-ask SW (so it pushes anything it still has)
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.ready.then((reg) => {
        if (reg.active) {
          reg.active.postMessage({ type: "suka:get-offline-imports" });
        }
      });
    }

    // immediate replay of what we already have in memory
    items.forEach((payload) => {
      dispatchImport(payload);
    });

    // clear bookmarklet
    clearBookmarkletQueue();
    setItems([]);
    setCount(0);
    setPulling(false);
    setOpen(false);
  }, [items]);

  // smart replay → run ones with schedule first, then the rest
  const smartReplay = useCallback(() => {
    if (!isBrowser) return;
    const withSchedule = items.filter((it) => it.schedule);
    const withoutSchedule = items.filter((it) => !it.schedule);

    withSchedule.forEach((payload) => {
      dispatchImport(payload);
    });
    withoutSchedule.forEach((payload) => {
      dispatchImport(payload);
    });

    clearBookmarkletQueue();
    setItems([]);
    setCount(0);
    setOpen(false);
  }, [items]);

  const clearAll = useCallback(() => {
    clearBookmarkletQueue();
    setItems([]);
    setCount(0);
    setOpen(false);
  }, []);

  if (!count) return null;

  return (
    <>
      {/* floating badge */}
      <div
        className="fixed bottom-4 left-4 z-[9999] flex items-center gap-2 rounded-full bg-slate-900/90 px-3 py-1.5 text-xs text-white shadow-lg ring-1 ring-slate-800/50 cursor-pointer hover:bg-slate-900"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-slate-900 text-[11px] font-semibold">
          {count}
        </span>
        <span className="leading-tight">
          Offline imports
          <span className="block text-[10px] text-slate-200/70">Tap to sync</span>
        </span>
      </div>

      {/* panel */}
      {open && (
        <div className="fixed bottom-16 left-4 z-[9999] w-[344px] max-h-[52vh] overflow-auto rounded-xl bg-white shadow-2xl border border-slate-200 p-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-semibold text-slate-900">
                Offline imports ({count})
              </div>
              <div className="text-[10px] text-slate-500">
                PWA share-target, bookmarklet, scan/PDF while app was closed.
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-6 w-6 inline-flex items-center justify-center rounded-full bg-slate-100 text-slate-500 hover:text-slate-700"
            >
              ✕
            </button>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={replayAll}
              disabled={pulling}
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-slate-700 disabled:opacity-60"
            >
              {pulling ? "Replaying…" : "Replay all"}
            </button>
            <button
              type="button"
              onClick={smartReplay}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/90 px-3 py-1.5 text-[10px] font-medium text-white hover:bg-emerald-500"
            >
              Smart replay
            </button>
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1 rounded-md bg-white px-3 py-1.5 text-[10px] font-medium text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
            >
              Clear
            </button>
          </div>

          <div className="space-y-2">
            {items.map((it) => {
              const domain = it.__importType || it.type || "unknown";
              const isSched = !!it.schedule;
              const isFav = !!it.saveAsFavorite;

              // prettier domain label
              const label = domainLabel(domain);

              return (
                <div
                  key={it.id || it.url || Math.random().toString(36).slice(2)}
                  className="rounded-lg bg-slate-50 p-2"
                >
                  <div className="text-[11px] font-medium text-slate-800 truncate">
                    {it.title || it.source?.url || "Shared item"}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1 items-center text-[9px] text-slate-500">
                    <span className="inline-flex items-center gap-1 rounded-full bg-white/60 px-2 py-[1px]">
                      {label}
                    </span>
                    {it.source?.kind && <span>• {it.source.kind}</span>}
                    {isSched && <span className="text-emerald-500">• scheduled</span>}
                    {isFav && <span className="text-amber-500">• favorite</span>}
                  </div>
                  <div className="mt-1 flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        dispatchImport(it);
                        setItems((prev) => prev.filter((x) => x !== it));
                        setCount((c) => Math.max(0, c - 1));
                      }}
                      className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 text-[9px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                    >
                      Import
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        window.dispatchEvent(
                          new CustomEvent("import.preview.reverse", {
                            detail: { item: it, reversed: { ...it, reversedAt: Date.now() } },
                          }),
                        );
                        window.dispatchEvent(
                          new CustomEvent("import.preview.open", {
                            detail: { item: it },
                          }),
                        );
                      }}
                      className="inline-flex items-center gap-1 rounded bg-white px-2 py-1 text-[9px] text-slate-700 ring-1 ring-slate-200 hover:bg-slate-100"
                    >
                      ↩︎ Reverse
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

// turn "__importType" into a nicer chip
function domainLabel(domain) {
  switch (domain) {
    case "cleaningPlan":
      return "Cleaning plan";
    case "gardenPlan":
      return "Garden plan";
    case "gardenCare":
      return "Garden care";
    case "harvestPlan":
      return "Harvest";
    case "storehouseStock":
      return "Storehouse stock";
    case "storehouseGoal":
      return "Storehouse goal";
    case "mealPlan":
      return "Meal plan";
    case "animalAcquisition":
      return "Animal acquisition";
    case "animalPlan":
      return "Animal plan";
    case "butcherySession":
      return "Butchery";
    case "inventoryUpdate":
      return "Inventory update";
    case "recipe":
      return "Recipe";
    default:
      return domain;
  }
}

// C:\Users\larho\suka-smart-assistant\src\features\pwa\ShareReceiver.jsx
// Suka Smart Assistant – PWA Share Receiver (extended, now wired to shareCaptureHandler)
//
// WHAT CHANGED
// - We now actually call the client-side import handler you created at
//   src/import/shareCaptureHandler.js
// - Flow is now:
//     SW → ShareReceiver → captureFromShareTarget(...) → server /api/import
//     → (we still normalize locally for queue/preview) → emit UI events
//
// WHY
// - This keeps the whole SSA pipeline consistent with the server-side route you wrote
//   (src/server/routes/import.js).
// - SW or PWA may only give us partial data — we send the *envelope* to the server
//   so the real ImportService can do cross-domain normalization + eventing.
// - We still keep your existing local normalization (normalizeSharedPayload) so the
//   UI can show something instantly, even before/if the server replies.
//

import React, { useEffect, useState, useCallback } from "react";
import { ImportService } from "@/features/import/ImportService";
import { ImportQueueManager } from "@/features/import/ImportQueueManager";
import ImportPreviewModal from "@/features/import/ImportPreviewModal";

// 🔗 NEW: use the actual client handler
// (path matches what you asked for: src/import/shareCaptureHandler.js)
import {
  captureFromShareTarget,
  buildImportEnvelope,
  guessDomain,
} from "@/import/shareCaptureHandler";

const isBrowser = typeof window !== "undefined";

const DEFAULT_IMPORT_PREFS = {
  autoOpenPreview: true,
  autoSaveFavorite: false,
  autoSchedule: false,
  autoScheduleRule: "once+5min",
  reverseMeta: {
    shareTarget: "family-fund-hub",
    includeShare: true,
    format: "json",
  },
};

function loadImportPrefs() {
  if (!isBrowser) return { ...DEFAULT_IMPORT_PREFS };
  try {
    const raw = window.localStorage.getItem("suka.import.settings.v1");
    return raw ? { ...DEFAULT_IMPORT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_IMPORT_PREFS };
  } catch {
    return { ...DEFAULT_IMPORT_PREFS };
  }
}

export default function ShareReceiver() {
  const [latest, setLatest] = useState(null);
  const [banner, setBanner] = useState(null);
  const [prefs, setPrefs] = useState(() => loadImportPrefs());

  // listen for in-app import settings changes (user-owned favorites/schedules)
  useEffect(() => {
    if (!isBrowser) return undefined;
    const handler = (ev) => {
      const { settings } = ev.detail || {};
      if (settings) {
        setPrefs((prev) => ({ ...prev, ...settings }));
      }
    };
    window.addEventListener("import.settings.changed", handler);
    return () => {
      window.removeEventListener("import.settings.changed", handler);
    };
  }, []);

  // on mount → ask SW for any offline imports it cached while app was closed
  useEffect(() => {
    if (!isBrowser || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.ready.then((reg) => {
      if (!reg.active) return;
      reg.active.postMessage({ type: "suka:get-offline-imports" });
    });
  }, []);

  // listen for SW broadcasts
  useEffect(() => {
    if (!isBrowser) return undefined;

    const onMessage = (event) => {
      const data = event.data || {};

      // single item
      if (data.type === "pwa-share-received" && data.payload) {
        handleIncomingShare(data.payload);
      }

      // explicit offline pull
      if (data.type === "suka:offline-imports" && Array.isArray(data.items)) {
        data.items.forEach((it) => {
          handleIncomingShare(it.payload || it);
        });
      }

      // background sync push
      if (data.type === "pwa-offline-imports" && Array.isArray(data.items)) {
        data.items.forEach((it) => {
          handleIncomingShare(it.payload || it);
        });
      }
    };

    navigator.serviceWorker?.addEventListener?.("message", onMessage);

    return () => {
      navigator.serviceWorker?.removeEventListener?.("message", onMessage);
    };
  }, [prefs, handleIncomingShare]);

  const handleIncomingShare = useCallback(
    async (raw) => {
      // 🔑 1) First, send it through your *real* share handler
      // so it goes to /api/import and into the SSA pipeline.
      // We wrap in try/catch to keep UI resilient.
      let remote = null;
      try {
        remote = await captureFromShareTarget(raw, {
          endpoint: "/api/import",
          // let handler do domain guess, but we can hint:
          forceDomain: raw?.__importType || undefined,
        });
      } catch {
        // ignore, we still proceed with local normalization
      }

      // 🔑 2) Local normalize so UI (queue/preview) sees it right now
      const normalized = normalizeSharedPayload(raw, prefs);

      // if server told us what domain it ended up with, sync it
      if (remote && remote.ok && remote.domain && !normalized.__importType) {
        normalized.__importType = remote.domain;
      }

      // if server sent back a normalized object, keep it for preview
      if (remote && remote.ok && remote.server && remote.server.normalized) {
        normalized.serverNormalized = remote.server.normalized;
      }

      // 3) enqueue into your import queue (so ImportLanding, ImportPreview, etc. see it)
      try {
        ImportQueueManager.enqueue(normalized.source?.kind || "pwa-share-target", normalized, {
          saveAsFavorite: normalized.saveAsFavorite,
          schedule: normalized.schedule || null,
          session: normalized.session || null,
          label: normalized.title,
        });
      } catch {
        // swallow – UI still shows preview
      }

      // 4) persist as favorite if user asked
      if (normalized.saveAsFavorite) {
        try {
          ImportService.saveAsFavorite(normalized);
        } catch {
          // swallow
        }
      }

      // 5) forward schedule/session to your automation runtime
      if (normalized.schedule) {
        window.dispatchEvent(
          new CustomEvent("automation.schedule.request", {
            detail: {
              source: "pwa.share.receiver",
              normalized,
              schedule: normalized.schedule,
              session:
                normalized.session ||
                {
                  domain: normalized.__importType || normalized.type,
                  action: "run-imported",
                  payload: normalized,
                },
            },
          }),
        );
      }

      // 6) let other panels know an import just completed
      window.dispatchEvent(
        new CustomEvent("import.service.completed", {
          detail: {
            normalized,
          },
        }),
      );

      // 7) UI feedback
      setLatest(normalized);
      setBanner({
        message: "Shared item imported.",
        detail: normalized.title || normalized.source?.url,
      });

      // 8) auto open preview if user wants
      if (prefs.autoOpenPreview) {
        window.dispatchEvent(
          new CustomEvent("import.preview.open", {
            detail: { item: normalized },
          }),
        );
      }
    },
    [prefs],
  );

  // auto-hide banner
  useEffect(() => {
    if (!banner) return undefined;
    const t = setTimeout(() => setBanner(null), 8000);
    return () => clearTimeout(t);
  }, [banner]);

  return (
    <>
      {banner && (
        <div className="fixed bottom-4 right-4 z-[9999] max-w-sm rounded-xl bg-slate-900/90 px-4 py-3 text-xs text-white shadow-lg ring-1 ring-slate-700/30 flex items-start gap-3">
          <div className="mt-0.5 text-lg">📥</div>
          <div className="flex-1">
            <div className="font-semibold leading-tight">{banner.message}</div>
            {banner.detail && <div className="text-slate-200/80 truncate">{banner.detail}</div>}
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="mt-2 text-[10px] underline underline-offset-2 text-slate-200/70"
            >
              Close
            </button>
          </div>
        </div>
      )}

      {/* keep preview mounted so events work */}
      <ImportPreviewModal />

      {/* optional debug */}
      {false && latest && (
        <div className="fixed bottom-24 right-4 z-[9999] w-[320px] rounded-xl bg-white shadow-lg border border-slate-200 p-3 text-[10px] text-slate-700 overflow-auto max-h-[40vh]">
          <pre>{JSON.stringify(latest, null, 2)}</pre>
        </div>
      )}
    </>
  );
}

/**
 * Normalize all the different shapes the SW can send us:
 * - plain recipe-ish share
 * - pinterest meal plan
 * - garden/seed pages
 * - store/grocery circulars (→ storehouse stock planning)
 * - livestock / animal plan links
 * - cleaning blog posts / checklists
 */
function normalizeSharedPayload(raw, prefs) {
  const base = typeof raw === "string" ? { text: raw } : raw || {};
  const type = base.__importType || inferTypeFromBase(base);

  const normalized = {
    __importType: type,
    id: base.id || "pwa-" + Math.random().toString(36).slice(2),
    title: base.title || base.text || "Shared item",
    source: base.source || {
      kind: "pwa-share",
      url: base.url || "",
      title: base.title || "",
    },
    meta: {
      ...base.meta,
      sharedAt: base.meta?.sharedAt || Date.now(),
    },
    saveAsFavorite: typeof base.saveAsFavorite === "boolean" ? base.saveAsFavorite : !!prefs.autoSaveFavorite,
    reverseMeta: base.reverseMeta || prefs.reverseMeta,
  };

  // attach schedule based on prefs
  if (prefs.autoSchedule && !base.schedule) {
    normalized.schedule = buildSchedule(prefs.autoScheduleRule, normalized);
  } else if (base.schedule) {
    normalized.schedule = base.schedule;
  }

  // ─────────────────────────────────────────────────────────
  // domain-specific population
  // ─────────────────────────────────────────────────────────
  if (type === "recipe") {
    normalized.ingredients =
      base.ingredients || (base.text ? base.text.split(/\r?\n/).filter(Boolean).slice(0, 40) : []);
    normalized.steps = base.steps || [];
  }

  if (type === "mealPlan") {
    normalized.days =
      base.days ||
      [
        {
          date: null,
          meals: [base.title || base.text || "Shared Meal"],
        },
      ];
    normalized.collaborative = true;
  }

  // ✅ garden plan (beds/rows/seeds)
  if (type === "gardenPlan") {
    normalized.seeds =
      base.seeds ||
      (base.text
        ? base.text.split(/\r?\n/).filter(Boolean).map((n) => ({ name: n }))
        : []);
    normalized.rows = base.rows || [];
    normalized.zone = base.zone || base.meta?.zone || null;
    normalized.coop = typeof base.coop === "boolean" ? base.coop : true;
  }

  // ✅ garden care (recurring tasks → weed, water, prune)
  if (type === "gardenCare") {
    normalized.tasks =
      base.tasks ||
      [
        { title: "Water beds", cadence: "2x/week" },
        { title: "Weed beds", cadence: "weekly" },
      ];
    normalized.coop = true;
  }

  // ✅ harvest plan (one-time or seasonal)
  if (type === "harvestPlan") {
    normalized.harvest =
      base.harvest ||
      [
        { crop: "Tomatoes", method: "fresh/can", targetDate: null },
        { crop: "Greens", method: "dehydrate/freeze", targetDate: null },
      ];
  }

  // ✅ storehouse stock planning — grocery section inspiration
  if (type === "storehouseStock" || type === "storehouseGoal") {
    normalized.items =
      base.items ||
      [
        { item: "Grains → flour, cornmeal, oats", section: "Dry goods", quantity: null },
        { item: "Proteins → lamb, beef, goat", section: "Frozen/Butchery", quantity: null },
        { item: "Oils & Fats", section: "Pantry", quantity: null },
      ];
    // you can derive a schedule (weekly restock) here
    if (!normalized.schedule) {
      normalized.schedule = buildSchedule("weekly-restock", normalized);
    }
  }

  // ✅ cleaning plan (daily/weekly/zone)
  if (type === "cleaningPlan") {
    normalized.tasks =
      base.tasks ||
      (base.text
        ? base.text.split(/\r?\n/).filter(Boolean).map((t) => ({ title: t, cadence: "weekly" }))
        : [
            { title: "Kitchen – counters & sink", cadence: "daily" },
            { title: "Floors – high traffic", cadence: "2x/week" },
            { title: "Bathrooms – wipe & mirrors", cadence: "2x/week" },
          ]);
  }

  // ✅ animal acquisition / care / butchery
  if (type === "animalAcquisition" || type === "animalPlan" || type === "butcherySession") {
    normalized.animals =
      base.animals ||
      [
        {
          name: "Lamb",
          species: "sheep",
          qty: 1,
          tasks:
            type === "butcherySession"
              ? ["Slaughter", "Bleed", "Quarter", "Package"]
              : ["Feed", "Water"],
        },
      ];

    // carry over your “reverse from recipe” idea
    if (base.reverseFrom) {
      normalized.reverseFrom = base.reverseFrom;
    }

    // breeds by geo if provided
    if (base.breedsByGeo) {
      normalized.breedsByGeo = base.breedsByGeo;
    }
  }

  // ✅ inventory updates (pdf/csv shared to PWA)
  if (type === "inventoryUpdate") {
    normalized.updates = base.updates || [];
  }

  return normalized;
}

function inferTypeFromBase(base) {
  const lower = (base.title || base.text || base.url || "").toLowerCase();

  // pinterest → meal plan
  if (lower.includes("pinterest.com")) return "mealPlan";

  // obvious recipe
  if (lower.includes("recipe") || lower.includes("ingredients")) return "recipe";

  // garden / seed
  if (lower.includes("seed") || lower.includes("garden") || lower.includes("burpee") || lower.includes("nursery")) {
    // if user said "care" / "prune" / "water" in text → gardenCare
    if (lower.includes("care") || lower.includes("prune") || lower.includes("water")) {
      return "gardenCare";
    }
    return "gardenPlan";
  }

  // harvest words
  if (lower.includes("harvest") || lower.includes("picking schedule")) {
    return "harvestPlan";
  }

  // cleaning options
  if (
    lower.includes("cleaning") ||
    lower.includes("declutter") ||
    lower.includes("bathroom") ||
    lower.includes("kitchen") ||
    lower.includes("laundry day")
  ) {
    return "cleaningPlan";
  }

  // storehouse / pantry / prep / grocery list
  if (
    lower.includes("storehouse") ||
    lower.includes("pantry") ||
    lower.includes("restock") ||
    lower.includes("grocery") ||
    lower.includes("freezer meal stockup")
  ) {
    return "storehouseStock";
  }

  // animals / butchery
  if (
    lower.includes("goat") ||
    lower.includes("sheep") ||
    lower.includes("lamb") ||
    lower.includes("cattle") ||
    lower.includes("butcher") ||
    lower.includes("butchery")
  ) {
    if (lower.includes("butcher") || lower.includes("cut sheet")) return "butcherySession";
    return "animalPlan";
  }

  // files → likely inventory
  if (Array.isArray(base.files) && base.files.length) return "inventoryUpdate";

  // default
  return "recipe";
}

function buildSchedule(rule, item) {
  if (rule === "once+5min") {
    return {
      id: `pwa-${item.id}-once5`,
      frequency: "once",
      runAt: Date.now() + 5 * 60 * 1000,
    };
  }

  if (rule === "daily@9") {
    const now = new Date();
    const runAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9, 0, 0).getTime();
    return {
      id: `pwa-${item.id}-daily9`,
      frequency: "daily",
      runAt,
    };
  }

  if (rule === "weekly-restock") {
    return {
      id: `pwa-${item.id}-wkrestock`,
      frequency: "weekly",
      // next week, same time
      runAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
    };
  }

  // default
  return {
    id: `pwa-${item.id}-once`,
    frequency: "once",
    runAt: Date.now() + 2 * 60 * 1000,
  };
}

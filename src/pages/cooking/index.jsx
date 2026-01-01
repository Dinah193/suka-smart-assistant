/* eslint-disable no-console */

/**
 * SSA • Cooking Page (Interactive Module)
 * -----------------------------------------------------------------------------
 * REQUIRED (1) User Flows (what users can do here)
 * - Generate: build a consolidated Cooking Draft from Meal Plan / Packs.
 * - Review: open Draft modal; print; save favorite; save schedule template.
 * - Run: “Cook Now” deep-links to Play; “Now” opens SessionRunner (persisted).
 * - Stream: open Overlay (local BroadcastChannel) + optional room (RTC/WS).
 *
 * NEW Interactive Library (Dexie-backed)
 * - Create: save current Draft into “Cooking Plans” library (Dexie).
 * - Read: list plans; search; filter by status/tag; sort by updatedAt.
 * - Update: edit title/tags/notes; mark completed/uncompleted (optimistic UI).
 * - Delete: delete plan (with undo via optimistic revert).
 *
 * REQUIRED (2) Data Contract (Dexie record schema this module reads/writes)
 * CookingPlanRecord (table: cookingPlans)
 * {
 *   id: string,
 *   householdId: string|null,
 *   title: string,
 *   tags: string[],              // stored as array in app; persisted as JSON string fallback if needed
 *   status: "active"|"completed"|"archived",
 *   notes: string,
 *   draftId: string|null,        // original draft id if available
 *   draft: object|null,          // snapshot of the cooking draft (stations/steps/timers/etc.)
 *   metrics: object|null,        // { totalRecipes:number, estMinutes:number, steps:number }
 *   completedAt: string|null,    // ISO
 *   createdAt: string,           // ISO
 *   updatedAt: string            // ISO
 * }
 *
 * REQUIRED (3) State Model
 * - Local state: controls (filters/search), generation prefs, draft, library list,
 *   edit sheet state, toasts/banners/errors/busy/progress, room connection.
 * - Derived state: filteredPlans, constraintSummary, stationKeys, visibleStations.
 * - Validation: title required for plan save; tags normalized; safe JSON parsing.
 * - Optimistic UI: plan create/update/delete/completion toggles update UI first,
 *   then persist; reverts + toast on failure.
 * - Error states: db unavailable, table missing, CRUD failure -> local fallback + toast.
 *
 * REQUIRED (4) Persistence (Dexie CRUD with soft-import)
 * - Soft-import db; if missing or table missing, use localStorage fallback repo.
 * - Includes seed handling: if table empty on first load, seed a sample plan.
 *
 * REQUIRED (5) EventBus
 * - Emits standardized events on every mutation (create/update/delete/complete).
 *   Payload envelope:
 *   {
 *     type: string,
 *     ts: string (ISO),
 *     source: "cooking-page",
 *     data: { ...domainPayload }
 *   }
 *
 * REQUIRED (6) Wiring
 * - export default CookingPage
 * - safe fallbacks for db/eventBus/runner/repo so routing never breaks.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useId,
  useRef,
} from "react";
import { useNavigate } from "react-router-dom";

import {
  automation,
  emitProgress,
  emitDraftApproved,
} from "@/services/automation/runtime";

import CookingSessionPlanner from "./CookingSessionPlanner.jsx";
import MultiTimerPanel from "./MultiTimerPanel.jsx";
import NutritionPanel from "@/components/food/NutritionPanel.jsx"; // right-rail nutrition peek

import "./cooking.css";

import QuickAddModal from "@/components/quickadd/QuickAddModal";
import QuickAddEngine from "@/services/quickadd/QuickAddEngine";

// Quick Add engine (Cooking) — SAFE singleton (no hooks)
let qaSingleton = null;
function getQuickAdd() {
  if (qaSingleton) return qaSingleton;
  qaSingleton =
    QuickAddEngine?.get?.() ||
    QuickAddEngine?.default?.get?.() ||
    QuickAddEngine ||
    null;
  return qaSingleton;
}

/* ------------------ NEW: Nutrition wiring (soft-import) ------------------- */
let nutritionEvents = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  nutritionEvents =
    require("@/services/nutrition/nutritionEvents.js")?.default ||
    require("@/services/nutrition/nutritionEvents.js");
} catch {}

let NutritionStore = null;
try {
  // Your shared reducer/store (or hook) module for nutrition state
  // eslint-disable-next-line global-require, import/no-unresolved
  NutritionStore =
    require("@/services/nutrition/nutritionStore")?.default ||
    require("@/services/nutrition/nutritionStore");
} catch {}

let NutritionRepo = null;
try {
  // Dexie-backed repo: getActivePerson / setActivePerson / upsert person/targets/constraints
  // eslint-disable-next-line global-require, import/no-unresolved
  NutritionRepo =
    require("@/services/nutrition/nutritionRepo")?.default ||
    require("@/services/nutrition/nutritionRepo");
} catch {}

/* ------------------------- Shared orchestration glue ------------------------ */
let eventBus = {
  emit: (...a) => console.debug("[cooking:index:eventBus.emit]", ...a),
  on: () => () => {},
};

// Standardized cooking-page signals (no coupling: other tools can subscribe)
const COOKING_EVENTS = Object.freeze({
  planDraftSaved: "cooking.plan.draft.saved",
  planDraftApplied: "cooking.plan.draft.applied",
  planUpdated: "cooking.plan.updated",
  planRemoved: "cooking.plan.removed",
  nowSessionRequested: "cooking.now.requested",
});

function emitCookingEvent(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[CookingPage] eventBus.emit failed:", e);
  }
}

try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require, import/no-unresolved
    const eb2 = require("@/services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {
    try {
      // eslint-disable-next-line global-require
      const eb3 = require("../../services/events/eventBus");
      eventBus = eb3?.default || eb3?.eventBus || eb3 || eventBus;
    } catch {}
  }
}

/* --------------------- Soft/defensive optional imports --------------------- */
let draftToPlay = (d) => d;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/session/draftToPlay");
  draftToPlay = mod?.default || mod || draftToPlay;
} catch {}

let rtcClient = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/realtime/rtcClient");
  rtcClient = mod?.default || mod || rtcClient;
} catch {}

let wsFallback = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/realtime/wsFallback");
  wsFallback = mod?.default || mod || wsFallback;
} catch {}

/* NEW: Sessions repo + runner opener (used by “Now” CTA) */
let SessionsRepo = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/session/SessionsRepo");
  SessionsRepo = mod?.default || mod || SessionsRepo;
} catch {}

let openRunner = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/features/session-runner/openRunner");
  openRunner = mod?.default || mod || openRunner;
} catch {}

/* NEW: Hub export + feature flags (optional) */
let featureFlags = { familyFundMode: false };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const ff = require("@/services/featureFlags");
  featureFlags = ff?.default || ff?.featureFlags || featureFlags;
} catch {}

let HubPacketFormatter = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/hub/HubPacketFormatter");
  HubPacketFormatter = mod?.default || mod || HubPacketFormatter;
} catch {}

let FamilyFundConnector = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const mod = require("@/services/hub/FamilyFundConnector");
  FamilyFundConnector = mod?.default || mod || FamilyFundConnector;
} catch {}

/**
 * Optional helper: when we create/update a runnable cooking session,
 * also format & export it to the Hub when familyFundMode=true.
 * Failures are intentionally silent.
 */
function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const envelope = {
      type: payload.type || "session.cooking.updated",
      ts: new Date().toISOString(),
      source: payload.source || "cooking-page",
      data: payload.data || payload,
    };

    const pkt = HubPacketFormatter?.toPacket
      ? HubPacketFormatter.toPacket(envelope)
      : HubPacketFormatter(envelope);

    const send =
      FamilyFundConnector?.send ||
      FamilyFundConnector?.push ||
      FamilyFundConnector?.publish;

    if (typeof send === "function") {
      Promise.resolve(send(pkt)).catch(() => {});
    }
  } catch (e) {
    console.warn("[cooking:index] hub export failed (soft):", e?.message || e);
  }
}

/* -------------------------------------------------------------------------- */
/* NEW: Dexie soft-import + CookingPlans repo (Dexie first, localStorage fallback)
 * -------------------------------------------------------------------------- */
function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function safeJsonParse(v, fallback) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

async function safeImportDb() {
  // Return a Dexie db instance if present, else null.
  const candidates = [
    "@/db",
    "@/db/index",
    "@/db/index.js",
    "@/services/db",
    "@/services/db/index",
    "../../db",
    "../../db/index",
  ];

  for (const p of candidates) {
    try {
      // eslint-disable-next-line global-require, import/no-unresolved
      const mod = require(p);
      const db =
        mod?.db || mod?.default || mod?.SSA_DB || mod?.ssaDb || mod || null;
      if (db) return db;
    } catch {}
  }
  return null;
}

function makeCookingPlansRepo({ emit, toast }) {
  // Normalize plan shapes + ensure IDs exist
  const ensurePlan = (p) => {
    if (!p || typeof p !== "object") return null;
    const id =
      p.id ||
      p.planId ||
      crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random()}`;
    return { ...p, id };
  };

  // Emit helper (keeps repo pure and consistent)
  const _emit = (name, payload) => {
    try {
      emit?.(name, payload);
    } catch {}
  };

  const LS_KEY = "ssa.cookingPlans.v1";

  const lsLoad = () => safeJsonParse(localStorage.getItem(LS_KEY) || "[]", []);
  const lsSave = (rows) => localStorage.setItem(LS_KEY, JSON.stringify(rows));

  const normalize = (rec) => {
    const tagsArr = Array.isArray(rec.tags)
      ? rec.tags
      : typeof rec.tags === "string"
      ? safeJsonParse(rec.tags, [])
      : [];
    return {
      ...rec,
      tags: tagsArr.filter(Boolean),
    };
  };

  const emitMutation = (type, data) => {
    const payload = {
      type,
      ts: new Date().toISOString(),
      source: "cooking-page",
      data,
    };
    emit?.(type, payload);
    // also keep a "domain channel" for generic listeners
    eventBus.emit?.("cooking.plan.mutated", payload);
  };

  let dexie = null;
  let dexieReady = false;
  let dexieHasTable = false;

  const init = async () => {
    dexie = await safeImportDb();
    dexieReady = !!dexie;

    // "Seed handling if table missing" in practice: detect and fallback.
    // Dexie cannot add stores at runtime without a schema version upgrade.
    // So if cookingPlans table isn't present, we use localStorage fallback.
    try {
      dexieHasTable = !!dexie?.tables?.some?.(
        (t) => t?.name === "cookingPlans"
      );
    } catch {
      dexieHasTable = false;
    }

    // Seed: if empty (Dexie or LS), seed one sample plan.
    try {
      const now = new Date().toISOString();
      const seed = {
        id: makeId("plan"),
        householdId: null,
        title: "Sample Plan • Weeknight Batch",
        tags: ["Dinner", "Prep"],
        status: "active",
        notes: "Tip: Save your generated draft here so you can rerun it later.",
        draftId: null,
        draft: null,
        metrics: { totalRecipes: 0, estMinutes: 0, steps: 0 },
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      if (dexieReady && dexieHasTable) {
        const count = await dexie.table("cookingPlans").count();
        if (count === 0) await dexie.table("cookingPlans").add(seed);
      } else {
        const rows = lsLoad();
        if (rows.length === 0) {
          lsSave([seed]);
        }
      }
    } catch {
      // silent
    }

    return { dexieReady, dexieHasTable };
  };

  const list = async () => {
    try {
      if (dexieReady && dexieHasTable) {
        const rows = await dexie
          .table("cookingPlans")
          .orderBy("updatedAt")
          .reverse()
          .toArray();
        return rows.map(normalize);
      }
    } catch (e) {
      console.warn("[cookingPlans] Dexie list failed:", e?.message || e);
    }
    return lsLoad()
      .map(normalize)
      .sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
      );
  };

  const create = async (record) => {
    const now = new Date().toISOString();
    const rec = normalize({
      ...record,
      id: record.id || makeId("plan"),
      createdAt: record.createdAt || now,
      updatedAt: now,
    });

    // optimistic event
    emitMutation("cooking.plan.created", { plan: rec });

    try {
      if (dexieReady && dexieHasTable) {
        await dexie.table("cookingPlans").add({
          ...rec,
          tags: rec.tags, // Dexie can store arrays; if your schema uses string, adjust in db snippet below
        });
        return rec;
      }
    } catch (e) {
      console.warn("[cookingPlans] Dexie create failed:", e?.message || e);
    }

    const rows = lsLoad();
    rows.unshift(rec);
    lsSave(rows.slice(0, 500));
    toast?.({ tone: "info", text: "Saved (local fallback)." });
    return rec;
  };

  const update = async (id, patch) => {
    const now = new Date().toISOString();

    // optimistic mutation payload uses "patch" + id
    emitMutation("cooking.plan.updated", { id, patch });

    try {
      if (dexieReady && dexieHasTable) {
        await dexie.table("cookingPlans").update(id, {
          ...patch,
          tags: Array.isArray(patch.tags) ? patch.tags : undefined,
          updatedAt: now,
        });
        const fresh = await dexie.table("cookingPlans").get(id);
        return normalize(fresh || { id, ...patch, updatedAt: now });
      }
    } catch (e) {
      console.warn("[cookingPlans] Dexie update failed:", e?.message || e);
    }

    const rows = lsLoad();
    const idx = rows.findIndex((r) => r.id === id);
    if (idx >= 0) {
      rows[idx] = normalize({ ...rows[idx], ...patch, updatedAt: now });
      lsSave(rows);
      return rows[idx];
    }
    return null;
  };

  const remove = async (id) => {
    emitMutation("cooking.plan.deleted", { id });

    try {
      if (dexieReady && dexieHasTable) {
        await dexie.table("cookingPlans").delete(id);
        return true;
      }
    } catch (e) {
      console.warn("[cookingPlans] Dexie delete failed:", e?.message || e);
    }

    const rows = lsLoad();
    lsSave(rows.filter((r) => r.id !== id));
    return true;
  };

  const toggleCompleted = async (id, nextCompleted) => {
    const patch = nextCompleted
      ? { status: "completed", completedAt: new Date().toISOString() }
      : { status: "active", completedAt: null };

    emitMutation(
      nextCompleted ? "cooking.plan.completed" : "cooking.plan.restored",
      { id }
    );

    return update(id, patch);
  };

  return { init, list, create, update, remove, toggleCompleted };
}

/* -------------------------------------------------------------------------- */
/* Streaming overlay helpers */
/* -------------------------------------------------------------------------- */
const STREAM_CHANNEL = "sv-cooking-stream"; // also used by Play/Remote

function buildOverlayPayload({ draft, stationFilter, title, streamerSafe }) {
  const stations = draft?.stations || [];
  const stepsAll = draft?.steps || [];
  const timersAll = draft?.timers || [];

  const steps =
    stationFilter && stationFilter !== "all"
      ? stepsAll.filter((s) =>
          s.stationKey
            ? s.stationKey === stationFilter
            : s.station === stationFilter
        )
      : stepsAll;

  const timers =
    stationFilter && stationFilter !== "all"
      ? timersAll.filter((t) =>
          t.stationKey
            ? t.stationKey === stationFilter
            : t.station === stationFilter
        )
      : timersAll;

  const queue = steps.filter((s) => !s.done);
  const currentStep = queue[0] || steps[0] || null;
  const nextStep = queue[1] || steps[1] || null;

  return {
    kind: "overlay:update",
    at: Date.now(),
    title: title || draft?.title || "Cooking Session",
    stationFilter: stationFilter || "all",
    streamerSafe: !!streamerSafe,
    metrics: draft?.metrics || {},
    stations: stations.map((s) => ({ key: s.key, label: s.label })),
    steps: steps.map((s) => ({
      id: s.id,
      label: s.label,
      station: s.station,
      stationKey: s.stationKey,
      estMin: s.estMin,
      done: !!s.done,
    })),
    timers: timers.map((t) => ({
      id: t.id,
      label: t.label,
      station: t.station,
      seconds: t.seconds,
      startedAt: t.startedAt || null,
      running: !!t.running,
    })),
    focus: {
      currentStep: currentStep
        ? {
            id: currentStep.id,
            label: currentStep.label,
            station: currentStep.station,
            estMin: currentStep.estMin,
          }
        : null,
      nextStep: nextStep
        ? {
            id: nextStep.id,
            label: nextStep.label,
            station: nextStep.station,
            estMin: nextStep.estMin,
          }
        : null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fallback Draft (when worker/agent unavailable) */
/* -------------------------------------------------------------------------- */
function makeFallbackDraft({ title, windowRange, includeTags, preferences }) {
  const id = `draft_local_${Date.now()}`;

  const cuisines = preferences?.cuisines || [];
  const proteins = preferences?.proteins || [];
  const equipment = preferences?.equipment || [];

  const stations = (equipment.length ? equipment : ["Stovetop", "Oven"])
    .slice(0, 4)
    .map((e, i) => ({
      key: String(e).toLowerCase().replace(/\s+/g, "-"),
      label: e,
      tools: [],
      order: i + 1,
    }));

  const steps = [];
  const totalRecipes = Math.max(2, Math.min(6, proteins.length || 3));

  for (let i = 0; i < totalRecipes; i += 1) {
    const cuisine = cuisines[i % Math.max(1, cuisines.length)] || "Balanced";
    const protein = proteins[i % Math.max(1, proteins.length)] || "Chicken";
    const station = stations[i % stations.length];

    steps.push({
      id: `${id}_step_${i + 1}`,
      label: `${cuisine} ${protein} prep`,
      station: station.label,
      stationKey: station.key,
      estMin: 10 + (i % 3) * 5,
      done: false,
    });

    steps.push({
      id: `${id}_step_${i + 1}_cook`,
      label: `Cook ${protein} (${cuisine})`,
      station: station.label,
      stationKey: station.key,
      estMin: 15 + (i % 4) * 5,
      done: false,
    });
  }

  const timers = steps
    .filter((s) => /Cook/.test(s.label))
    .slice(0, 3)
    .map((s, i) => ({
      id: `${id}_tm_${i + 1}`,
      label: s.label.replace("Cook ", ""),
      station: s.station,
      seconds: 5 * 60 + i * 120,
      startedAt: null,
      running: false,
    }));

  return {
    id,
    title: title || "Cooking Session",
    createdAt: new Date().toISOString(),
    window: windowRange,
    selection: [],
    stations,
    steps,
    timers,
    inventory: { pulls: [], missing: [] },
    metrics: {
      totalRecipes,
      estMinutes: steps.reduce((acc, s) => acc + (s.estMin || 0), 0),
      includeTags,
    },
    preferences,
    draftType: "cooking",
    source: "local-fallback",
  };
}

/* -------------------------------------------------------------------------- */
/* Worker client — SAFE LISTENERS + UNSUBS
 * -------------------------------------------------------------------------- */
function createAgentsClient() {
  let worker = null;
  try {
    worker = new Worker(new URL("@/workers/agentsWorker.js", import.meta.url), {
      type: "module",
    });
  } catch (e) {
    console.warn(
      "[agentsClient] worker unavailable, enabling local fallback:",
      e?.message || e
    );
  }

  let seq = 0;
  const pending = new Map();
  const listeners = {
    progress: new Set(),
    draft: new Set(),
    log: new Set(),
    error: new Set(),
    calendarSyncReq: new Set(),
    result: new Set(),
  };

  const callSet = (set, data) => {
    set.forEach((fn) => {
      try {
        if (typeof fn === "function") fn(data);
      } catch (e) {
        console.error("[agentsClient] listener error:", e);
      }
    });
  };

  if (worker) {
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const { id, type, data } = msg;

      switch (type) {
        case "PROGRESS":
          callSet(listeners.progress, data);
          emitProgress(data.taskId, data.phase, data.pct);
          break;

        case "DRAFT_READY":
          callSet(listeners.draft, data);
          automation.emitEvent("draft.ready", {
            draft: data.draft,
            draftType: data.draftType,
          });

          eventBus.emit?.("prep.tasks.requested", {
            params: {
              domain: "meal",
              draftType: "cooking",
              draftId: data?.draft?.id,
            },
          });

          eventBus.emit?.("session.generated", {
            type: "session.generated",
            ts: new Date().toISOString(),
            source: "cooking-page",
            data: {
              domain: "cooking",
              draftId: data?.draft?.id,
              stepGraphMode: data?.stepGraphMode || "vault",
              metrics: data?.draft?.metrics || {},
            },
          });
          break;

        case "REQUEST_CALENDAR_SYNC":
          callSet(listeners.calendarSyncReq, data);
          automation.emitEvent("draft.calendarSync.request", data);
          break;

        case "LOG":
          callSet(listeners.log, data);
          break;

        case "ERROR":
          callSet(listeners.error, data);
          break;

        case "RESULT": {
          callSet(listeners.result, data);
          const p = pending.get(id);
          if (p) {
            pending.delete(id);
            p.resolve(data);
          }
          break;
        }

        default:
          break;
      }

      const p = pending.get(id);
      if (p && type === "ERROR") {
        pending.delete(id);
        p.reject(new Error(data?.message || "Worker error"));
      }
    };
  }

  const call = (type, payload) => {
    const id = `w:${++seq}:${type}`;
    if (!worker) return Promise.reject(new Error("worker-unavailable"));
    const out = new Promise((resolve, reject) =>
      pending.set(id, { resolve, reject })
    );
    worker.postMessage({ id, type, payload });
    return out;
  };

  const registrar = (set) => (fn) => {
    if (typeof fn !== "function") return () => {};
    set.add(fn);
    return () => set.delete(fn);
  };

  return {
    onProgress: registrar(listeners.progress),
    onDraft: registrar(listeners.draft),
    onCalendarSyncRequest: registrar(listeners.calendarSyncReq),
    onLog: registrar(listeners.log),
    onError: registrar(listeners.error),
    onResult: registrar(listeners.result),

    init: async (preload = []) => {
      if (!worker) return { ok: false, fallback: true };
      try {
        return await call("INIT", { preload });
      } catch {
        return { ok: false, fallback: true };
      }
    },

    listRecipePacks: async () => {
      try {
        const res = await call("RUN_AGENT", {
          name: "recipePacks.list",
          input: {},
          options: {},
        });
        const packs = res?.data?.packs;
        return Array.isArray(packs) ? packs : [];
      } catch (e) {
        console.warn(
          "[agentsClient] listRecipePacks fallback:",
          e?.message || e
        );
        return [];
      }
    },

    generateFromPlan: async (
      windowRange,
      includeTags,
      servingsOverride,
      title,
      preferences,
      packIds = [],
      stepGraphOptions = {}
    ) => {
      const stepGraph = {
        mode: "vault",
        domain: "cooking",
        tags: includeTags,
        artifactWindow: windowRange,
        ...stepGraphOptions,
      };

      const opts = {
        scope: "cooking",
        opts: {
          consolidation: { window: windowRange, includeTags, servingsOverride },
          cooking: {
            preferences: {
              ...preferences,
              includePacks: packIds,
              autoImportFromPlan: true,
            },
          },
          stepGraph,
        },
      };

      eventBus.emit?.("session.generate.requested", {
        type: "session.generate.requested",
        ts: new Date().toISOString(),
        source: "cooking-page",
        data: {
          domain: "cooking",
          windowRange,
          tags: includeTags,
          prefsSummary: {
            sabbathAware: !!preferences?.sabbathAware,
            batchMode: preferences?.batchMode,
          },
          stepGraphMode: stepGraph.mode,
        },
      });

      try {
        eventBus.emit?.("mealplan.draft.requested", {
          params: { domain: "meal", source: "cooking-page" },
        });

        const result = await call("GENERATE_SESSIONS", opts);
        return result;
      } catch (e) {
        console.warn(
          "[agentsClient] falling back to local draft:",
          e?.message || e
        );

        const fallbackDraft = makeFallbackDraft({
          title,
          windowRange,
          includeTags,
          preferences: { ...preferences, includePacks: packIds },
        });

        const taskId = `local-${Date.now()}`;
        callSet(listeners.progress, {
          taskId,
          phase: "draft:cooking:fallback",
          pct: 100,
        });

        callSet(listeners.draft, {
          draft: fallbackDraft,
          draftType: "cooking",
        });
        automation.emitEvent?.("draft.ready", {
          draft: fallbackDraft,
          draftType: "cooking",
        });

        eventBus.emit?.("session.generate.fallback", {
          type: "session.generate.fallback",
          ts: new Date().toISOString(),
          source: "cooking-page",
          data: {
            domain: "cooking",
            draftId: fallbackDraft.id,
            reason: e?.message || "worker-unavailable",
            stepGraphMode: "local-fallback",
          },
        });

        return {
          ok: true,
          data: { draftId: fallbackDraft.id, fallback: true },
        };
      }
    },

    approve: (draftId, calendar) =>
      call("APPROVE_SESSION", { draftId, calendar }),

    shutdown: () => {
      try {
        worker?.terminate?.();
      } catch {}
      try {
        Object.values(listeners).forEach((s) => s.clear());
      } catch {}
      pending.clear();
    },
  };
}

/* --------------------------- Realtime Room Client -------------------------- */
function useRoomConnection(initialRoom) {
  const [room, setRoom] = useState(initialRoom || "");
  const [connected, setConnected] = useState(false);
  const [clientType, setClientType] = useState(null); // "rtc" | "ws" | null
  const clientRef = useRef(null);

  const join = async (nextRoom) => {
    const target = (nextRoom || room || "").trim();
    if (!target) return { ok: false, reason: "Missing room" };

    try {
      await clientRef.current?.leave?.();
    } catch {}

    let client = null;

    if (rtcClient) {
      try {
        client = await rtcClient.join(target);
        setClientType("rtc");
      } catch (e) {
        console.warn("[room] rtc failed, trying ws:", e?.message || e);
      }
    }

    if (!client && wsFallback) {
      client = await wsFallback.join(target);
      setClientType("ws");
    }

    if (!client) {
      setConnected(false);
      return { ok: false, reason: "no-client" };
    }

    clientRef.current = client;
    setConnected(true);
    return { ok: true };
  };

  const leave = async () => {
    try {
      await clientRef.current?.leave?.();
    } catch {}
    clientRef.current = null;
    setConnected(false);
    setClientType(null);
  };

  const send = async (payload) => {
    if (!connected || !clientRef.current) return false;
    try {
      await clientRef.current.send({ channel: STREAM_CHANNEL, payload });
      return true;
    } catch (e) {
      console.warn("[room] send failed:", e?.message || e);
      return false;
    }
  };

  const subscribe = (handler) => {
    if (!connected || !clientRef.current) return () => {};
    try {
      return clientRef.current.subscribe(STREAM_CHANNEL, handler);
    } catch {
      return () => {};
    }
  };

  return { room, setRoom, connected, clientType, join, leave, send, subscribe };
}

/* -------------------------------------------------------------------------- */
/* Tiny UI atoms */
/* -------------------------------------------------------------------------- */
function Card({ children, className = "" }) {
  return <div className={`sv-card ${className}`}>{children}</div>;
}

function SectionHeader({ icon, title, sub, right }) {
  return (
    <div className="sv-sectionHead">
      <div
        className="sv-sectionHead__row"
        style={{ justifyContent: "space-between", alignItems: "center" }}
      >
        <div className="sv-sectionHead__row">
          {icon ? <span className="sv-sectionHead__icon">{icon}</span> : null}
          <h2 className="sv-sectionHead__title">{title}</h2>
        </div>
        {right}
      </div>
      {sub ? <p className="sv-muted">{sub}</p> : null}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  className = "",
  ...rest
}) {
  return (
    <label className={`sv-field ${className}`}>
      {label ? <span className="sv-field__label">{label}</span> : null}
      <input
        type={type}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="sv-input"
        {...rest}
      />
    </label>
  );
}

function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
  className = "",
  title,
}) {
  const variantClass =
    variant === "ghost"
      ? "sv-btn--ghost"
      : variant === "outline"
      ? "sv-btn--outline"
      : "sv-btn--primary";

  return (
    <button
      className={`sv-btn ${variantClass} ${className}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

function Chip({ active, children, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`sv-chip ${active ? "is-active" : ""}`}
    >
      {children}
    </button>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="sv-toggle">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="sv-toggle__thumb" />
      <span className="sv-toggle__label">{label}</span>
    </label>
  );
}

function ProgressBar({ pct }) {
  const v = Math.max(0, Math.min(100, Math.round(pct || 0)));
  return (
    <div className="sv-progress">
      <div className="sv-progress__bar" style={{ width: `${v}%` }} />
    </div>
  );
}

function Select({ label, value, onChange, options }) {
  return (
    <label className="sv-field">
      {label ? <span className="sv-field__label">{label}</span> : null}
      <select
        className="sv-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Slider({
  label,
  value,
  min = 0,
  max = 10,
  step = 1,
  onChange,
  caption,
}) {
  return (
    <div className="sv-field">
      <div className="sv-field__label sv-row sv-justify-between">
        <span>{label}</span>
        <span className="sv-badge">{value}</span>
      </div>
      <input
        className="sv-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {caption ? <div className="sv-caption">{caption}</div> : null}
    </div>
  );
}

const Banner = ({ tone = "info", children, onDismiss }) => (
  <div className={`sv-banner sv-banner--${tone}`}>
    <div className="sv-banner__content">{children}</div>
    {onDismiss && (
      <button
        className="sv-btn sv-btn--ghost sv-btn--sm"
        onClick={onDismiss}
        type="button"
      >
        Dismiss
      </button>
    )}
  </div>
);

const Toast = ({ tone = "info", text, action, onClose }) => (
  <div className={`sv-toast sv-toast--${tone}`}>
    <span>{text}</span>
    {action && (
      <button
        className="sv-btn sv-btn--outline sv-btn--sm"
        onClick={action.fn}
        type="button"
      >
        {action.label}
      </button>
    )}
    <button
      className="sv-btn sv-btn--ghost sv-btn--sm"
      onClick={onClose}
      type="button"
    >
      ✕
    </button>
  </div>
);

/* ---------- NEW lightweight UI bits for progressive disclosure ---------- */
function Sheet({ open, title, onClose, children, width = 520 }) {
  if (!open) return null;
  return (
    <div
      className="sv-modal"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,.28)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        className="sv-card"
        style={{
          width,
          maxWidth: "100%",
          height: "100%",
          overflow: "auto",
          padding: 16,
          boxShadow: "0 10px 30px rgba(0,0,0,.2)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sv-row sv-justify-between sv-align-center sv-block">
          <div className="sv-sectionHead__title">{title}</div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function FilterButton({ label, summary, onClick }) {
  return (
    <button
      type="button"
      className="sv-btn sv-btn--outline"
      onClick={onClick}
      title={label}
    >
      <span className="sv-strong">{label}</span>
      {summary ? (
        <span className="sv-caption" style={{ marginLeft: 8, opacity: 0.7 }}>
          {summary}
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers */
/* -------------------------------------------------------------------------- */
const CUISINES = [
  "Soul Food",
  "Caribbean",
  "West African",
  "Nigerian",
  "Ghanaian",
  "Ethiopian",
  "Cajun",
  "Creole",
  "Mediterranean",
  "Levantine",
  "BBQ",
  "Herb-Garlic",
  "Citrus-Chili",
  "Asian Fusion",
  "Indian",
  "Thai",
  "Korean",
  "Tex-Mex",
  "Italian",
  "French",
  "Middle Eastern",
];

const PROTEINS = [
  "Beef",
  "Lamb",
  "Goat",
  "Chicken",
  "Turkey",
  "Fish",
  "Shellfish",
  "Eggs",
  "Beans/Lentils",
  "Tofu/Plant",
];

const EQUIPMENT = [
  "Oven",
  "Stovetop",
  "Grill",
  "Smoker",
  "Air Fryer",
  "Instant Pot/Pressure",
  "Dehydrator",
  "Sous Vide",
  "Dutch Oven",
  "Wok",
];

const DIETARY = [
  "Avoid gluten",
  "Avoid dairy",
  "Avoid nuts",
  "Vegan",
  "Vegetarian",
  "Low-sodium",
  "Low-sugar",
];

const DONENESS_OPTIONS = {
  redMeat: [
    { value: "rare", label: "Rare" },
    { value: "medium-rare", label: "Medium-rare" },
    { value: "medium", label: "Medium" },
    { value: "medium-well", label: "Medium-well" },
    { value: "well", label: "Well-done" },
  ],
  poultry: [
    { value: "juicy-done", label: "Juicy • Done" },
    { value: "well", label: "Well-done" },
  ],
  fish: [
    { value: "just-opaque", label: "Just opaque" },
    { value: "medium", label: "Medium" },
    { value: "well", label: "Well-done" },
  ],
  eggs: [
    { value: "soft", label: "Soft" },
    { value: "jammy", label: "Jammy" },
    { value: "hard", label: "Hard" },
  ],
  pasta: [
    { value: "al-dente", label: "Al dente" },
    { value: "tender", label: "Tender" },
  ],
  riceBeans: [
    { value: "separate", label: "Separate grains" },
    { value: "tender", label: "Tender" },
    { value: "soft", label: "Soft" },
  ],
  veg: [
    { value: "tender-crisp", label: "Tender-crisp" },
    { value: "tender", label: "Tender" },
    { value: "soft", label: "Soft" },
  ],
};

const DEFAULT_DONENESS = {
  redMeat: "medium",
  poultry: "juicy-done",
  fish: "just-opaque",
  eggs: "jammy",
  pasta: "al-dente",
  riceBeans: "tender",
  veg: "tender-crisp",
};

function RecipePackPicker({ packs, selected, onToggle }) {
  if (!packs?.length) {
    return (
      <div className="sv-muted sv-text-sm">
        No packs found yet. (You can still generate from Meal Plan.)
      </div>
    );
  }

  return (
    <div className="sv-wrap">
      {packs.map((p) => {
        const isActive = selected.includes(p.id);
        return (
          <button
            type="button"
            key={p.id}
            className={`sv-chip ${isActive ? "is-active" : ""}`}
            onClick={() => onToggle(p.id)}
            title={p.description || p.title}
          >
            {p.title || p.name || "Pack"}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Overlay helpers: detect mode & query params */
/* -------------------------------------------------------------------------- */
function useQueryParams() {
  if (typeof window === "undefined") return new URLSearchParams("");
  return new URLSearchParams(window.location.search);
}

function useOverlayMode() {
  const params = useQueryParams();
  return params.get("overlay") === "1";
}

function useOverlayRoomParam() {
  const params = useQueryParams();
  const code = params.get("room");
  return code ? code.trim() : "";
}

/* -------------------------------------------------------------------------- */
/* Overlay Window (Browser Source) — supports ?overlay=1&room=ABCD */
/* -------------------------------------------------------------------------- */
function formatMMSS(total) {
  const s = Math.max(0, Math.floor(total));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function CookingOverlaySurface() {
  const [state, setState] = useState(null);
  const [now, setNow] = useState(Date.now());
  const roomParam = useOverlayRoomParam();
  const roomConn = useRoomConnection(roomParam);

  useEffect(() => {
    let unsub = null;
    let bc = null;

    const handler = (msg) => {
      const payload = msg?.payload || msg;
      if (payload?.kind === "overlay:update") setState(payload);
    };

    const setup = async () => {
      if (roomParam) {
        const { ok } = await roomConn.join(roomParam);
        if (ok) {
          unsub = roomConn.subscribe((m) => handler(m));
          return;
        }
      }
      bc = new BroadcastChannel(STREAM_CHANNEL);
      bc.onmessage = (ev) => handler(ev.data);
    };

    setup();

    const id = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      clearInterval(id);
      try {
        unsub?.();
      } catch {}
      try {
        roomConn.leave?.();
      } catch {}
      try {
        bc?.close?.();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomParam]);

  const timers = (state?.timers || []).map((t) => {
    const total = Number(t.seconds || 0);
    let remaining = total;
    if (t.running && t.startedAt) {
      const elapsed = Math.floor((now - t.startedAt) / 1000);
      remaining = Math.max(0, total - elapsed);
    }
    return { ...t, remaining };
  });

  const current = state?.focus?.currentStep;
  const next = state?.focus?.nextStep;

  return (
    <div className="sv-overlay">
      <div className="sv-overlay__bar">
        <div className="sv-overlay__title">
          {state?.title || "Cooking Session"}
        </div>
        <div className="sv-overlay__meta">
          {state?.stationFilter && state.stationFilter !== "all"
            ? `Station: ${state.stationFilter}`
            : "All Stations"}
          {roomParam ? ` • room ${roomParam}` : ""}
        </div>
      </div>

      <div className="sv-overlay__content">
        <div className="sv-overlay__left">
          <div className="sv-overlay__panel">
            <div className="sv-overlay__panelTitle">Current Step</div>
            <div className="sv-overlay__step">
              {current ? (
                <>
                  <div className="sv-overlay__stepMain">{current.label}</div>
                  {current.station ? (
                    <div className="sv-overlay__stepSub">
                      @ {current.station}
                    </div>
                  ) : null}
                  {current.estMin ? (
                    <div className="sv-overlay__pill">~{current.estMin}m</div>
                  ) : null}
                </>
              ) : (
                <div className="sv-overlay__muted">Waiting for first step…</div>
              )}
            </div>
          </div>

          <div className="sv-overlay__panel">
            <div className="sv-overlay__panelTitle">Next</div>
            <div className="sv-overlay__step sv-overlay__step--small">
              {next ? (
                <>
                  <div className="sv-overlay__stepMain">{next.label}</div>
                  {next.station ? (
                    <div className="sv-overlay__stepSub">@ {next.station}</div>
                  ) : null}
                  {next.estMin ? (
                    <div className="sv-overlay__pill">~{next.estMin}m</div>
                  ) : null}
                </>
              ) : (
                <div className="sv-overlay__muted">No upcoming step</div>
              )}
            </div>
          </div>
        </div>

        <div className="sv-overlay__right">
          <div className="sv-overlay__panel">
            <div className="sv-overlay__panelTitle">Timers</div>
            <div className="sv-overlay__timers">
              {timers.length ? (
                timers.map((t) => (
                  <div
                    key={t.id}
                    className={`sv-overlay__timer ${
                      t.running ? "is-running" : ""
                    }`}
                  >
                    <div className="sv-overlay__timerLabel">{t.label}</div>
                    <div className="sv-overlay__timerTime">
                      {formatMMSS(t.remaining ?? t.seconds ?? 0)}
                    </div>
                    {t.station ? (
                      <div className="sv-overlay__timerSub">@ {t.station}</div>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="sv-overlay__muted">No timers running</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {current || next ? (
        <div className="sv-overlay__ticker">
          {current ? `Now: ${current.label}` : "Ready"} •{" "}
          {next ? `Next: ${next.label}` : "No next step"}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Draft modal */
/* -------------------------------------------------------------------------- */
function DraftModal({
  open,
  onClose,
  draft,
  onApprove,
  onScheduleCleanup,
  onSaveFavorite,
  onSaveSchedule,
  onCookNow,
}) {
  if (!open || !draft) return null;

  const minutes = draft?.metrics?.estMinutes || 0;
  const timers = draft?.timers || [];
  const pulls = draft?.inventory?.pulls || [];
  const missing = draft?.inventory?.missing || [];
  const stations = draft?.stations || [];
  const steps = draft?.steps || [];

  const handlePrint = () => {
    const w = window.open("", "_blank", "width=960,height=700");
    if (!w) return;

    const list = (arr, empty = "None") =>
      arr?.length
        ? `<ul>${arr.map((x) => `<li>${x}</li>`).join("")}</ul>`
        : `<div style="opacity:.6">${empty}</div>`;

    const stationList = list(
      stations.map(
        (s) =>
          `${s.label}${
            s.tools?.length ? ` — tools: ${s.tools.join(", ")}` : ""
          }`
      )
    );

    const timerList = list(
      timers.map(
        (t) =>
          `${t.label} — ${Math.round((t.seconds ?? 0) / 60)} min${
            t.station ? ` @ ${t.station}` : ""
          }`
      )
    );

    const pullList = list(
      pulls.map(
        (p) =>
          `${p.label} — ${p.need}${p.unit ? ` ${p.unit}` : ""} (have ${p.have})`
      ),
      "No pulls"
    );

    const missingList = list(
      missing.map(
        (m) => `${m.label} — need ${m.short}${m.unit ? ` ${m.unit}` : ""}`
      ),
      "All set"
    );

    const stepList = list(
      steps.map(
        (s) =>
          `${s.label}${s.station ? ` — ${s.station}` : ""}${
            s.estMin ? ` • ~${s.estMin}m` : ""
          }`
      ),
      "No steps"
    );

    w.document.write(`
      <html>
        <head>
          <title>${draft.title || "Cooking Session"}</title>
          <style>
            body{font-family:system-ui,-apple-system,Inter,Segoe UI,Roboto,Arial,sans-serif;padding:24px}
            h1,h2{margin:.2em 0}
            .muted{opacity:.7}
            .grid{display:grid;gap:16px;grid-template-columns:1fr 1fr}
            ul{margin:.3em 0 .8em 1.2em}
            .no-print{@media print{display:none}}
          </style>
        </head>
        <body>
          <div class="no-print" style="text-align:right;margin-bottom:8px">
            <button onclick="window.print()">Print</button>
          </div>
          <h1>${draft.title || "Cooking Session"}</h1>
          <div class="muted">
            ${draft.metrics?.totalRecipes ?? 0} recipes • ${
      steps.length
    } steps • ~${minutes} min
          </div>
          <div class="grid">
            <section><h2>Stations</h2>${stationList}</section>
            <section><h2>Timers</h2>${timerList}</section>
            <section><h2>Pull from pantry</h2>${pullList}</section>
            <section><h2>Missing</h2>${missingList}</section>
          </div>
          <section><h2>Steps</h2>${stepList}</section>
        </body>
      </html>
    `);
    w.document.close();
  };

  return (
    <div className="sv-modal">
      <Card className="sv-modal__card">
        <div className="sv-modal__head">
          <div>
            <div className="sv-modal__title">
              {draft.title || "Cooking Session"}
            </div>
            <div className="sv-muted">
              {draft.metrics?.totalRecipes ?? 0} recipes • {steps.length} steps
              • ~{minutes} min
            </div>
          </div>
        </div>

        <div className="sv-grid-2 sv-modal__body">
          <Card className="sv-pad">
            <SectionHeader title="Stations" />
            <ul className="sv-list">
              {stations.map((s) => (
                <li key={s.key}>
                  <span className="sv-strong">{s.label}</span>
                  {s.tools?.length ? ` — tools: ${s.tools.join(", ")}` : ""}
                </li>
              ))}
              {!stations.length && <li className="sv-muted">None</li>}
            </ul>
          </Card>

          <Card className="sv-pad">
            <SectionHeader title="Timers" />
            <ul className="sv-list">
              {timers.map((t) => (
                <li key={t.id}>
                  {t.label} — {Math.round((t.seconds ?? 0) / 60)} min{" "}
                  {t.station ? `@ ${t.station}` : ""}
                </li>
              ))}
              {!timers.length && <li className="sv-muted">None</li>}
            </ul>
          </Card>

          <Card className="sv-pad sv-span-2">
            <SectionHeader title="Inventory" />
            <div className="sv-grid-2">
              <div>
                <div className="sv-subtitle">Pull from pantry</div>
                <ul className="sv-list">
                  {pulls.map((p, i) => (
                    <li key={`${p.key || p.label}-${i}`}>
                      {p.label} — {p.need} {p.unit ? `${p.unit}` : ""} (have{" "}
                      {p.have})
                    </li>
                  ))}
                  {!pulls.length && <li className="sv-muted">No pulls</li>}
                </ul>
              </div>

              <div>
                <div className="sv-subtitle">Missing</div>
                <ul className="sv-list">
                  {missing.map((m, i) => (
                    <li key={`${m.key || m.label}-${i}`} className="sv-danger">
                      {m.label} — need {m.short} {m.unit ? `${m.unit}` : ""}
                    </li>
                  ))}
                  {!missing.length && <li className="sv-muted">All set</li>}
                </ul>
              </div>
            </div>
          </Card>

          <Card className="sv-pad sv-span-2">
            <SectionHeader
              title="Steps"
              sub="Grouped by station in the main view; shown flat here for a quick scan."
            />
            <ol className="sv-list sv-list--decimal">
              {steps.map((s) => (
                <li key={s.id}>
                  <span className="sv-strong">{s.label}</span>
                  {s.station ? (
                    <span className="sv-muted"> — {s.station}</span>
                  ) : null}
                  {s.estMin ? (
                    <span className="sv-muted"> • ~{s.estMin}m</span>
                  ) : null}
                </li>
              ))}
              {!steps.length && (
                <li className="sv-muted">No steps populated</li>
              )}
            </ol>
          </Card>
        </div>

        <div className="sv-row sv-justify-end sv-pad">
          <Button variant="outline" onClick={handlePrint}>
            Print
          </Button>
          <Button variant="outline" onClick={() => onSaveFavorite?.(draft)}>
            Save Favorite
          </Button>
          <Button variant="outline" onClick={() => onSaveSchedule?.(draft)}>
            Save Schedule
          </Button>
          <Button
            variant="outline"
            onClick={onScheduleCleanup}
            title="Add a 5-minute cleanup block to Calendar"
          >
            Schedule Cleanup
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button onClick={() => onApprove(draft)}>Approve &amp; Sync</Button>
          <Button
            onClick={() => onCookNow?.(draft)}
            title="Open the hands-busy Play screen"
          >
            Cook Now
          </Button>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* NEW — “Swap” modal to pick a session to run NOW */
/* -------------------------------------------------------------------------- */
function SessionSwapModal({ open, onClose, sessions = [], onSelect }) {
  if (!open) return null;
  const total = sessions.length;
  const next = sessions[0];

  return (
    <div className="sv-modal" style={{ zIndex: 90 }}>
      <div className="sv-card sv-pad" style={{ width: 520, maxWidth: "92vw" }}>
        <div
          className="sv-row sv-justify-between sv-align-center"
          style={{ marginBottom: 8 }}
        >
          <div className="sv-strong">Cook Now</div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>

        <div
          className="sv-stack-sm"
          style={{
            background: "linear-gradient(180deg,#2b1d12,rgba(0,0,0,0.2))",
            borderRadius: 16,
            padding: 16,
          }}
        >
          <div className="sv-row sv-justify-between sv-align-center">
            <div className="sv-muted">You’re starting</div>
            <div className="sv-badge">
              {total} session{total === 1 ? "" : "s"} available
            </div>
          </div>
          <div className="sv-row sv-align-end" style={{ gap: 8 }}>
            <div className="sv-display">{total}</div>
            <div className="sv-muted">runnable</div>
          </div>
          {next ? (
            <div className="sv-caption">
              Next up: <span className="sv-strong">{next.title}</span> •{" "}
              {next.steps?.length ?? 0} steps
            </div>
          ) : null}
        </div>

        <div
          className="sv-stack"
          style={{ marginTop: 12, maxHeight: 260, overflow: "auto" }}
        >
          {sessions.map((s) => (
            <div
              key={s.id}
              className="sv-row sv-justify-between sv-align-center sv-card sv-pad"
              style={{ borderRadius: 12 }}
            >
              <div>
                <div className="sv-strong">{s.title || "Cooking Session"}</div>
                <div className="sv-muted sv-text-sm">
                  {s?.steps?.length ?? 0} steps •{" "}
                  {s?.prefs?.voiceGuidance ? "Voice" : "Silent"} •{" "}
                  {s?.progress?.startedAt ? "Resume" : "Fresh"}
                </div>
              </div>
              <Button onClick={() => onSelect(s)}>Start</Button>
            </div>
          ))}
          {!sessions.length && (
            <div className="sv-muted">No saved sessions found.</div>
          )}
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button
            onClick={() => (sessions[0] ? onSelect(sessions[0]) : onClose())}
          >
            Start Selected
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* NEW: Cooking Plans (Dexie) Panel + Edit Sheet */
/* -------------------------------------------------------------------------- */
function PlanEditSheet({ open, plan, onClose, onSave }) {
  const [title, setTitle] = useState(plan?.title || "");
  const [tags, setTags] = useState((plan?.tags || []).join(", "));
  const [notes, setNotes] = useState(plan?.notes || "");

  useEffect(() => {
    setTitle(plan?.title || "");
    setTags((plan?.tags || []).join(", "));
    setNotes(plan?.notes || "");
  }, [plan?.id]);

  if (!open || !plan) return null;

  const tagArr = tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 25);

  const isValid = title.trim().length >= 2;

  return (
    <Sheet open={open} title="Edit Plan" onClose={onClose} width={560}>
      <div className="sv-stack-sm">
        <Input
          label="Title"
          value={title}
          onChange={setTitle}
          placeholder="Plan title…"
        />
        <Input
          label="Tags (comma-separated)"
          value={tags}
          onChange={setTags}
          placeholder="Dinner, Prep, Freezer…"
        />
        <label className="sv-field">
          <span className="sv-field__label">Notes</span>
          <textarea
            className="sv-input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={6}
            placeholder="What makes this plan special?"
          />
        </label>

        <div className="sv-row sv-justify-between sv-align-center">
          <div className="sv-muted sv-text-sm">
            Status: <span className="sv-strong">{plan.status}</span>
            {plan.completedAt
              ? ` • completed ${new Date(plan.completedAt).toLocaleString()}`
              : ""}
          </div>
          <div className="sv-row sv-gap">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                onSave({
                  title: title.trim(),
                  tags: tagArr,
                  notes,
                })
              }
              disabled={!isValid}
              title={!isValid ? "Title is required" : "Save changes"}
            >
              Save
            </Button>
          </div>
        </div>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- */
/* Event-driven glue + undo stack */
/* -------------------------------------------------------------------------- */
const EVENT_KEYS = [
  "recipe.consolidated",
  "inventory.updated",
  "calendar.synced",
  "preferences.changed",
  "torah.profile.updated",
];

function useAutomationGlue(onEvent) {
  useEffect(() => {
    const offs = [];
    EVENT_KEYS.forEach((k) => {
      const off = automation?.on?.(k, (payload) => onEvent?.(k, payload));
      if (typeof off === "function") offs.push(off);
    });
    return () =>
      offs.forEach((off) => {
        try {
          if (typeof off === "function") off();
        } catch {}
      });
  }, [onEvent]);
}

function useUndo() {
  const stack = useRef([]);
  const push = (revert, descr = "Change") => {
    stack.current.push(revert);
    return {
      undo: () => stack.current.pop()?.(),
      descr,
    };
  };
  return { push };
}

/* -------------------------------------------------------------------------- */
/* Main Page */
/* -------------------------------------------------------------------------- */
export default function CookingPage() {
  const qa = React.useMemo(() => getQuickAdd(), []);
  // ----------------------------- Draft/Swap/Edit UI -----------------------------
  const [draftOpen, setDraftOpen] = useState(false);
  const [swapPlansOpen, setSwapPlansOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

  const [activeDraft, setActiveDraft] = useState(null);
  const [swapCandidates, setSwapCandidates] = useState([]);
  const [editPlan, setEditPlan] = useState(null);

  const openDraft = (draft) => {
    setActiveDraft(draft || null);
    setDraftOpen(true);
  };

  const openSwap = (candidates) => {
    setSwapCandidates(Array.isArray(candidates) ? candidates : []);
    setSwapOpen(true);
  };

  const openEdit = (plan) => {
    setEditPlan(plan || null);
    setEditOpen(true);
  };

  const isOverlay = useOverlayMode();
  if (isOverlay) return <CookingOverlaySurface />;

  const navigate = useNavigate();
  const undo = useUndo();

  const clientRef = useRef(null);
  const streamRef = useRef(null); // BroadcastChannel
  const overlayWindowRef = useRef(null);

  // NEW: CookingPlans repo + state
  const plansRepoRef = useRef(null);
  const [plansReady, setPlansReady] = useState(false);
  const [plans, setPlans] = useState([]);
  const [plansErr, setPlansErr] = useState(null);

  const [planQuery, setPlanQuery] = useState("");
  const [planStatus, setPlanStatus] = useState("all"); // all|active|completed
  const [planTagFilter, setPlanTagFilter] = useState("all");
  const [planEditOpen, setPlanEditOpen] = useState(false);
  const [planEditing, setPlanEditing] = useState(null);

  // NEW: “Now” CTA state
  const [runnable, setRunnable] = useState([]);
  const [swapOpen, setSwapOpen] = useState(false);

  // Base controls
  const [start, setStart] = useState(() =>
    new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  );
  const [end, setEnd] = useState(() =>
    new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString().slice(0, 10)
  );
  const [includeTags, setIncludeTags] = useState([
    "Breakfast",
    "Lunch",
    "Dinner",
    "Snack",
  ]);
  const [servingsOverride, setServingsOverride] = useState("");
  const [title, setTitle] = useState("Cooking Session");
  const [sabbathAware, setSabbathAware] = useState(false);

  // Diversity controls
  const [cuisines, setCuisines] = useState([
    "Soul Food",
    "West African",
    "Caribbean",
  ]);
  const [proteins, setProteins] = useState([
    "Beef",
    "Lamb",
    "Chicken",
    "Beans/Lentils",
  ]);
  const [equipment, setEquipment] = useState(["Oven", "Stovetop"]);
  const [dietaryFlags, setDietaryFlags] = useState([]);
  const [pantryFirst, setPantryFirst] = useState(true);
  const [seasonalOnly, setSeasonalOnly] = useState(false);
  const [indoorOutdoor, setIndoorOutdoor] = useState("auto"); // "auto" | "indoor" | "outdoor"
  const [batchMode, setBatchMode] = useState("balanced");
  const [budgetPerServing, setBudgetPerServing] = useState("");
  const [maxTotalMinutes, setMaxTotalMinutes] = useState("");
  const [freezerSpaceQt, setFreezerSpaceQt] = useState("");

  // Meal window rhythm
  const [rhythmEnabled, setRhythmEnabled] = useState(false);
  const [rhythmStart, setRhythmStart] = useState("11:00");
  const [rhythmEnd, setRhythmEnd] = useState("19:00");

  // Packs
  const [packs, setPacks] = useState([]);
  const [selectedPackIds, setSelectedPackIds] = useState([]);

  // Doneness + Texture/Finish preferences
  const [doneness, setDoneness] = useState(DEFAULT_DONENESS);
  const [texturePrefs, setTexturePrefs] = useState({
    softness: 5,
    tenderness: 6,
    crispiness: 4,
    chewiness: 3,
    moistness: 6,
    sauciness: 5,
    char: 3,
    smoke: 2,
    spiceHeat: 2,
    sweetness: 3,
    acidity: 3,
  });

  // Progress + Draft
  const [progress, setProgress] = useState({
    taskId: null,
    phase: null,
    pct: 0,
  });
  const [draft, setDraft] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Streaming controls
  const [stationFilter, setStationFilter] = useState("all");
  const [streamerSafe, setStreamerSafe] = useState(true);
  const [overlayOpen, setOverlayOpen] = useState(false); // eslint-disable-line no-unused-vars

  // Global UI
  const [banners, setBanners] = useState([]);
  const [toast, setToast] = useState(null);
  // Listen for cooking quick-add commits so the UI updates instantly
  useEffect(() => {
    function onCommitted(e) {
      const payload = e?.detail || {};
      const dom = payload?.domain;
      if (dom !== "cooking") return;

      // ✅ refresh your cooking page state
      // simplest: refresh plans / sessions / draft-adjacent UI
      refreshPlans?.();
      refreshRunnable?.();

      // optional: show toast if QuickAdd provides a message
      if (payload?.toast) {
        setToast(payload.toast);
      }
    }

    window.addEventListener("quickadd.committed", onCommitted);
    return () => window.removeEventListener("quickadd.committed", onCommitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [openSheet, setOpenSheet] = useState(null); // "tags" | "diversity" | "diet" | "constraints" | "finishes" | "packs"

  // Shared-orchestration awareness
  const [conflictCount, setConflictCount] = useState(0);
  const [shortages, setShortages] = useState({
    total: 0,
    pantry: 0,
    cleaning: 0,
    hygiene: 0,
    animal: 0,
    garden: 0,
  });

  // Sheet-specific scratch state
  const [newTag, setNewTag] = useState("");
  const [tagPresetSearch, setTagPresetSearch] = useState("");

  // Overlay room input / connection
  const [roomInput, setRoomInput] = useState("");
  const roomConn = useRoomConnection("");

  const rhythm = useMemo(() => {
    if (!rhythmEnabled) return null;
    return {
      type: "time-restricted",
      windows: [{ start: rhythmStart, end: rhythmEnd }],
      fastingPattern: "custom",
    };
  }, [rhythmEnabled, rhythmStart, rhythmEnd]);

  const visibleStations = useMemo(() => {
    const arr = draft?.stations || [];
    return stationFilter === "all"
      ? arr
      : arr.filter((s) => s.key === stationFilter);
  }, [stationFilter, draft]);

  const stationKeys = (draft?.stations || []).map((s) => s.key);

  const constraintSummary =
    [
      budgetPerServing ? `$${budgetPerServing}/serv` : null,
      maxTotalMinutes ? `≤${maxTotalMinutes} min` : null,
      freezerSpaceQt ? `${freezerSpaceQt} qt freezer` : null,
    ]
      .filter(Boolean)
      .join(" • ") || "None";

  const tagPresets = [
    "Breakfast",
    "Lunch",
    "Dinner",
    "Snack",
    "Prep",
    "Freezer",
    "Company",
    "Shabbat",
    "Feast",
  ];
  const filteredTagPresets = tagPresets.filter((t) =>
    tagPresetSearch
      ? t.toLowerCase().includes(tagPresetSearch.toLowerCase())
      : true
  );

  // NEW: derived plan filters
  const allTags = useMemo(() => {
    const set = new Set();
    plans.forEach((p) => (p.tags || []).forEach((t) => set.add(t)));
    return ["all", ...Array.from(set).sort((a, b) => a.localeCompare(b))];
  }, [plans]);

  const filteredPlans = useMemo(() => {
    const q = planQuery.trim().toLowerCase();
    return plans
      .filter((p) => {
        if (planStatus !== "all" && p.status !== planStatus) return false;
        if (planTagFilter !== "all" && !(p.tags || []).includes(planTagFilter))
          return false;
        if (!q) return true;
        const blob = `${p.title || ""} ${(p.notes || "").slice(0, 300)} ${(
          p.tags || []
        ).join(" ")}`.toLowerCase();
        return blob.includes(q);
      })
      .sort((a, b) =>
        String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""))
      );
  }, [plans, planQuery, planStatus, planTagFilter]);

  // NEW: helper to refresh runnable sessions from SessionsRepo
  const refreshRunnable = async () => {
    const list = await SessionsRepo.getRunnable({ domain: "cooking" });
    const arr = Array.isArray(list) ? list : [];
    setRunnable(arr);
    return arr;
  };

  // NEW: load plans repo + list
  const refreshPlans = async () => {
    try {
      const repo = plansRepoRef.current;
      if (!repo) return;
      const rows = await repo.list();
      setPlans(Array.isArray(rows) ? rows : []);
      setPlansErr(null);
    } catch (e) {
      setPlansErr(e?.message || "Failed to load plans");
    }
  };

  // mount repo
  useEffect(() => {
    const repo = makeCookingPlansRepo({
      emit: (type, payload) => eventBus.emit?.(type, payload),
      toast: (t) => setToast(t),
    });
    plansRepoRef.current = repo;

    repo
      .init()
      .then(() => {
        setPlansReady(true);
        refreshPlans();
      })
      .catch((e) => {
        setPlansReady(true);
        setPlansErr(e?.message || "Plans repo failed");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Listen to session lifecycle to refresh runnable list
  useEffect(() => {
    refreshRunnable();
    const offs = [
      eventBus.on?.("session.started", refreshRunnable),
      eventBus.on?.("session.completed", refreshRunnable),
      eventBus.on?.("session.aborted", refreshRunnable),
      eventBus.on?.("session.saved", refreshRunnable),
    ].filter(Boolean);

    return () =>
      offs.forEach((off) => {
        try {
          off?.();
        } catch {}
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // create worker + listeners
  useEffect(() => {
    const client = createAgentsClient();
    clientRef.current = client;

    const off1 = client.onProgress((d) =>
      setProgress({ taskId: d.taskId, phase: d.phase, pct: d.pct || 0 })
    );

    const off2 = client.onDraft(({ draft: newDraft }) => {
      setBusy(false);
      setDraft(newDraft);
      setModalOpen(true);
      setToast({
        tone: "success",
        text: "Draft ready.",
        action: { label: "Open overlay", fn: () => handleOpenOverlay() },
      });
      eventBus.emit?.("ads.context.show", {
        placement: "cooking_draft_ready",
        domain: "meal",
      });
    });

    const off3 = client.onCalendarSyncRequest(() => {});
    const off4 = client.onLog(() => {});
    const off5 = client.onError((e) =>
      console.warn("[cooking] worker error:", e)
    );
    const off6 = client.onResult(() => {});

    client
      .init([
        "mealPlanningAgent",
        "batchCookingAgent",
        "recipeConsolidatorAgent",
        "recipePacksAgent",
      ])
      .catch(() => {});

    client
      .listRecipePacks()
      .then(setPacks)
      .catch(() => setPacks([]));

    // streaming channel
    streamRef.current = new BroadcastChannel(STREAM_CHANNEL);

    // Shared orchestration listeners
    const offA = eventBus.on?.("planner.conflict.detected", () => {
      setConflictCount((n) => Math.min(99, n + 1));
      bannerAdd({
        key: `conf-${Date.now()}`,
        tone: "warning",
        text: "Planner conflict detected (time • appliance • weather • biohazard).",
        actions: [{ label: "Open Planner", fn: () => scrollToPlanner() }],
      });
    });

    const offB = eventBus.on?.("supplies.shortages.update", (payload) => {
      const list = Array.isArray(payload?.items) ? payload.items : [];
      const counters = {
        total: 0,
        pantry: 0,
        cleaning: 0,
        hygiene: 0,
        animal: 0,
        garden: 0,
      };
      for (const r of list) {
        counters.total += 1;
        if (r?.domain && counters[r.domain] !== undefined)
          counters[r.domain] += 1;
      }
      setShortages(counters);
      if (counters.total > 0) {
        bannerAdd({
          key: "shortages",
          tone: "info",
          text: `${counters.total} shortage${
            counters.total > 1 ? "s" : ""
          } detected • review before cooking.`,
          actions: [{ label: "Add to Grocery", fn: () => openGrocery() }],
        });
      }
    });

    return () => {
      [off1, off2, off3, off4, off5, off6, offA, offB].forEach((off) => {
        try {
          if (typeof off === "function") off();
        } catch {}
      });
      try {
        client.shutdown();
      } catch {}
      try {
        streamRef.current?.close();
      } catch {}
      if (overlayWindowRef.current && !overlayWindowRef.current.closed) {
        overlayWindowRef.current.close();
      }
      roomConn.leave().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Auto-generate a session on first load (no clicks required) ---
  const didAutogenRef = useRef(false);
  useEffect(() => {
    if (didAutogenRef.current) return;
    if (!draft) {
      didAutogenRef.current = true;
      const t = setTimeout(() => {
        try {
          handleGenerate();
        } catch {}
      }, 300);
      return () => clearTimeout(t);
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  // Automation glue
  useAutomationGlue((event) => {
    if (event === "recipe.consolidated") {
      bannerAdd({
        key: "recs",
        tone: "info",
        text: "Recipes changed—refresh and regenerate your session when ready.",
        actions: [{ label: "Regenerate", fn: () => handleGenerate() }],
      });
    }
    if (event === "inventory.updated") {
      bannerAdd({
        key: "inv",
        tone: "warning",
        text: "Inventory updated—re-check before cooking.",
        actions: [{ label: "Open Planner", fn: () => scrollToPlanner() }],
      });
    }
    if (event === "calendar.synced") {
      bannerAdd({
        key: "cal",
        tone: "success",
        text: "Calendar sync complete.",
        dismissible: true,
      });
    }
    if (event === "preferences.changed")
      setToast({ tone: "info", text: "Preferences applied to planning." });
    if (event === "torah.profile.updated") {
      bannerAdd({
        key: "diet",
        tone: "info",
        text: "Dietary profile changed—review allergens in Planner.",
      });
    }
  });

  // Hotkeys
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key.toLowerCase();
      if (k === "g") handleGenerate();
      if (k === "o") handleOpenOverlay();
      if (k === "a" && draft) handleApprove(draft);
      if (k === "c" && draft) handleCookNow(draft);
      if (k === "n") handleNow();
      if (e.key === "/") {
        e.preventDefault();
        const el = document.querySelector(
          'input[placeholder="Cooking Session"]'
        );
        if (el) el.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, runnable]);

  // Push overlay updates whenever draft/stationFilter/title/streamerSafe changes
  useEffect(() => {
    if (!draft) return;

    const payload = buildOverlayPayload({
      draft,
      stationFilter,
      title,
      streamerSafe,
    });
    try {
      streamRef.current?.postMessage(payload);
    } catch {}
    if (roomConn.connected) {
      roomConn.send(payload).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, stationFilter, title, streamerSafe]);

  const toggleItem = (arrSetter) => (val) =>
    arrSetter((prev) =>
      prev.includes(val) ? prev.filter((x) => x !== val) : [...prev, val]
    );

  const handleGenerate = async () => {
    const client = clientRef.current;
    if (!client) return;

    setBusy(true);
    setDraft(null);
    setModalOpen(false);
    setProgress({ taskId: null, phase: "queued", pct: 1 });

    const windowRange = {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };

    const preferences = {
      title,
      sabbathAware,
      rhythm,
      cuisines,
      proteins,
      equipment,
      dietaryFlags,
      pantryFirst,
      seasonalOnly,
      environment: indoorOutdoor,
      batchMode,
      constraints: {
        budgetPerServing: budgetPerServing ? Number(budgetPerServing) : null,
        maxTotalMinutes: maxTotalMinutes ? Number(maxTotalMinutes) : null,
        freezerSpaceQt: freezerSpaceQt ? Number(freezerSpaceQt) : null,
      },
      doneness,
      texture: texturePrefs,
    };

    try {
      eventBus.emit?.("ads.context.show", {
        placement: "cooking_generate_click",
        domain: "meal",
      });
      await client.generateFromPlan(
        windowRange,
        includeTags,
        servingsOverride ? Number(servingsOverride) : null,
        title,
        preferences,
        selectedPackIds
      );
      setToast({ tone: "info", text: "Generating session…" });
    } catch (e) {
      console.error("Generate error:", e?.message || e);
      setBusy(false);
      setToast({ tone: "error", text: "Couldn’t generate." });
    }
  };

  const handleApprove = async (d) => {
    const client = clientRef.current;
    if (!client || !d?.id) return;

    eventBus.emit?.("ads.context.show", {
      placement: "cooking_approve_click",
      domain: "meal",
    });
    emitDraftApproved({
      draftId: d.id,
      calendar: { enabled: true, calendarId: null },
    });

    try {
      const result = await client.approve(d.id, {
        enabled: true,
        calendarId: null,
      });
      const eventId = result?.data?.eventId;

      const { undo: revert } = undo.push(async () => {
        try {
          await automation.request?.("calendar.undoEvent", { id: eventId });
          setToast({ tone: "success", text: "Approval undone." });
        } catch {
          setToast({ tone: "error", text: "Couldn’t undo calendar sync." });
        }
      }, "Approve");

      setModalOpen(false);
      setToast({
        tone: "success",
        text: "Approved & synced.",
        action: { label: "Undo", fn: revert },
      });

      setTimeout(() => {
        setToast({
          tone: "info",
          text: "Next: open Cook Now to start cooking",
          action: { label: "Cook Now", fn: () => handleCookNow(d) },
        });
      }, 1400);
    } catch (e) {
      console.error("Approve error:", e?.message || e);
      setToast({ tone: "error", text: "Couldn’t approve." });
    }
  };

  const handleScheduleCleanup = async () => {
    try {
      const ev = await automation.request?.("calendar.add.cleanup", {
        minutes: 5,
      });
      const { undo: revert } = undo.push(async () => {
        await automation.request?.("calendar.undoEvent", { id: ev?.id });
      }, "Schedule cleanup");
      setToast({
        tone: "success",
        text: "Cleanup scheduled.",
        action: { label: "Undo", fn: revert },
      });
    } catch {
      setToast({ tone: "error", text: "Couldn’t schedule cleanup." });
    }
  };

  // Save the current draft as a favorite (user-owned)
  const handleSaveFavorite = async (d) => {
    if (!d) return;
    try {
      const res = await automation.request?.("favorites.saveDraft", {
        domain: "meal",
        draftType: "cooking",
        draft: d,
        tags: ["user-favorite"],
      });
      if (!res) throw new Error("no-automation");
      setToast({ tone: "success", text: "Saved to Favorites." });
      eventBus.emit?.("favorite.saved", { domain: "meal", draftId: d.id });
    } catch {
      const key = "sv.favorite.cookingDrafts";
      const list = safeJsonParse(localStorage.getItem(key) || "[]", []);
      list.unshift({ savedAt: Date.now(), draft: d });
      localStorage.setItem(key, JSON.stringify(list.slice(0, 20)));
      setToast({ tone: "success", text: "Saved to Favorites (local)." });
    }
  };

  // Save a schedule template for later reuse
  const handleSaveScheduleTemplate = async (d) => {
    if (!d) return;
    try {
      const res = await automation.request?.("schedules.saveTemplate", {
        domain: "meal",
        kind: "cooking-session",
        title: d.title || "Cooking Session",
        window: d.window,
        stations: d.stations,
        steps: d.steps,
        timers: d.timers,
        preferences: d.preferences,
      });
      if (!res) throw new Error("no-automation");
      setToast({ tone: "success", text: "Schedule template saved." });
      eventBus.emit?.("schedule.template.saved", {
        domain: "meal",
        draftId: d.id,
      });
    } catch {
      const key = "sv.cooking.scheduleTemplates";
      const list = safeJsonParse(localStorage.getItem(key) || "[]", []);
      list.unshift({
        savedAt: Date.now(),
        title: d.title || "Cooking Session",
        window: d.window,
        stations: d.stations,
        steps: d.steps,
        timers: d.timers,
        preferences: d.preferences,
      });
      localStorage.setItem(key, JSON.stringify(list.slice(0, 20)));
      setToast({ tone: "success", text: "Schedule template saved (local)." });
    }
  };

  // Deep-link to Play screen
  const handleCookNow = (d) => {
    try {
      const play = draftToPlay(d);
      const playId = play?.id || `play_${Date.now()}`;
      navigate(`/cooking/play/${encodeURIComponent(playId)}`, {
        state: { play },
      });
    } catch (e) {
      console.warn(
        "[cooking] draftToPlay failed, trying minimal play object:",
        e
      );
      const play = {
        id: `play_${Date.now()}`,
        title: d?.title || "Cooking Session",
        steps: (d?.steps || []).map((s) => ({
          id: s.id,
          title: s.label,
          text: s.label,
          durationSec: s.estMin ? s.estMin * 60 : 0,
        })),
      };
      navigate(`/cooking/play/${encodeURIComponent(play.id)}`, {
        state: { play },
      });
    }
  };

  // ---- “Now” CTA handling → opens app-wide SessionRunner modal ----
  const createSessionFromDraft = async (d) => {
    const id = `sess_${Date.now()}`;
    const session = {
      id,
      domain: "cooking",
      title: d?.title || "Cooking Session",
      source: { type: "manual", refId: d?.id || null },
      steps: (d?.steps || []).map((s, i) => ({
        id: s.id || `${id}_step_${i + 1}`,
        title: s.label || s.title || `Step ${i + 1}`,
        desc: s.label || s.title || "",
        durationSec: s.estMin ? s.estMin * 60 : 0,
        blockers: ["inventory", "quietHours", "sabbath", "equipment"],
        metadata: { tempTargetF: 0, donenessCue: "timer", cueNotes: "" },
      })),
      prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
      status: "pending",
      progress: {
        currentStepIndex: 0,
        elapsedSec: 0,
        startedAt: null,
        pausedAt: null,
      },
      analytics: { skippedSteps: [], adjustments: [] },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await SessionsRepo?.upsert?.(session);
    } catch (e) {
      console.warn(
        "[cooking:index] SessionsRepo.upsert failed (soft):",
        e?.message || e
      );
    }

    exportToHubIfEnabled({
      type: "session.cooking.created",
      source: "cooking-page",
      data: { session },
    });
    return session;
  };

  const startRunnerFor = async (session) => {
    const sid = session?.id;
    if (!sid) return;

    try {
      if (openRunner) {
        await openRunner({ sessionId: sid, sticky: true });
      } else {
        eventBus.emit?.("session.open", {
          type: "session.open.request",
          ts: new Date().toISOString(),
          source: "cooking-page",
          data: { sessionId: sid, sticky: true },
        });
      }
      refreshRunnable();
    } catch (e) {
      console.warn("[cooking] openRunner fallback:", e?.message || e);
    }
  };

  const handleNow = async () => {
    const list = await refreshRunnable();

    if (list.length > 1) {
      setSwapOpen(true);
      return;
    }
    if (runnable.length === 1) {
      startRunnerFor(runnable[0]);
      return;
    }

    const d =
      draft ||
      makeFallbackDraft({
        title,
        windowRange: null,
        includeTags,
        preferences: { cuisines, proteins, equipment },
      });

    const sess = await createSessionFromDraft(d);
    startRunnerFor(sess);
  };

  const handleSwapSelect = async (s) => {
    setSwapOpen(false);
    if (!s) return;
    startRunnerFor(s);
  };

  // OPEN OVERLAY — if room is entered and join succeeds, include &room=CODE
  const handleOpenOverlay = async () => {
    const url = new URL(window.location.href);
    url.searchParams.set("overlay", "1");

    if (roomInput?.trim()) {
      const { ok } = await roomConn.join(roomInput.trim());
      if (ok) url.searchParams.set("room", roomInput.trim());
    }

    overlayWindowRef.current = window.open(
      url.toString(),
      "svCookingOverlay",
      "width=1280,height=720"
    );
    setOverlayOpen(true);

    if (streamRef.current && draft) {
      const payload = buildOverlayPayload({
        draft,
        stationFilter,
        title,
        streamerSafe,
      });
      try {
        streamRef.current.postMessage(payload);
      } catch {}
      if (roomConn.connected) {
        roomConn.send(payload).catch(() => {});
      }
    }
  };

  const bannerAdd = (b) =>
    setBanners((prev) =>
      prev.find((x) => x.key === b.key) ? prev : [...prev, b]
    );
  const bannerDismiss = (key) =>
    setBanners((prev) => prev.filter((b) => b.key !== key));

  const scrollToPlanner = () => {
    const el = document.querySelector("#sv-planner-anchor");
    if (el) el.scrollIntoView({ behavior: "smooth" });
  };

  const openSupplies = () => {
    eventBus.emit?.("ui.navigate", { panel: "SuppliesPanel" });
    eventBus.emit?.("ui.panel.open", { id: "SUPPLIES" });
  };

  const openGrocery = () => {
    eventBus.emit?.("grocerylist.requested", {
      domain: "meal",
      source: "cooking-page",
    });
    eventBus.emit?.("ui.navigate", { panel: "GroceryListPanel" });
    eventBus.emit?.("ui.panel.open", { id: "GROCERY_LIST" });
  };

  // NEW: Library actions (Dexie CRUD + optimistic UI)
  const handleSavePlanFromDraft = async () => {
    const repo = plansRepoRef.current;
    if (!repo) return;

    const d = draft;
    const t = (d?.title || title || "").trim();
    if (!t || t.length < 2) {
      setToast({ tone: "error", text: "Plan title required (2+ chars)." });
      return;
    }

    const now = new Date().toISOString();
    const record = {
      id: makeId("plan"),
      householdId: null,
      title: t,
      tags: includeTags.slice(0, 12),
      status: "active",
      notes: "",
      draftId: d?.id || null,
      draft: d || null,
      metrics: {
        totalRecipes: d?.metrics?.totalRecipes ?? 0,
        estMinutes: d?.metrics?.estMinutes ?? 0,
        steps: d?.steps?.length ?? 0,
      },
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    // optimistic UI add
    setPlans((prev) => [record, ...prev]);

    try {
      await repo.create(record);
      setToast({ tone: "success", text: "Saved to Cooking Plans." });
      refreshPlans();
    } catch (e) {
      // revert optimistic
      setPlans((prev) => prev.filter((p) => p.id !== record.id));
      setToast({
        tone: "error",
        text: `Couldn’t save plan: ${e?.message || "error"}`,
      });
    }
  };

  const handleTogglePlanCompleted = async (p) => {
    const repo = plansRepoRef.current;
    if (!repo || !p?.id) return;

    const nextCompleted = p.status !== "completed";

    // optimistic update
    const before = p;
    const optimistic = {
      ...p,
      status: nextCompleted ? "completed" : "active",
      completedAt: nextCompleted ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    };
    setPlans((prev) => prev.map((x) => (x.id === p.id ? optimistic : x)));

    try {
      await repo.toggleCompleted(p.id, nextCompleted);
      refreshPlans();
    } catch (e) {
      setPlans((prev) => prev.map((x) => (x.id === p.id ? before : x)));
      setToast({
        tone: "error",
        text: `Couldn’t update plan: ${e?.message || "error"}`,
      });
    }
  };

  const handleDeletePlan = async (p) => {
    const repo = plansRepoRef.current;
    if (!repo || !p?.id) return;

    // optimistic remove + undo
    const snapshot = plans;
    setPlans((prev) => prev.filter((x) => x.id !== p.id));

    const { undo: revert } = undo.push(async () => {
      setPlans(snapshot);
      setToast({ tone: "success", text: "Delete undone (UI restored)." });
    }, "Delete plan");

    try {
      await repo.remove(p.id);
      setToast({
        tone: "success",
        text: "Plan deleted.",
        action: { label: "Undo", fn: revert },
      });
      refreshPlans();
    } catch (e) {
      setPlans(snapshot);
      setToast({
        tone: "error",
        text: `Couldn’t delete: ${e?.message || "error"}`,
      });
    }
  };

  const handleEditPlan = (p) => {
    setPlanEditing(p);
    setPlanEditOpen(true);
  };

  const handleSavePlanEdit = async (patch) => {
    const repo = plansRepoRef.current;
    if (!repo || !planEditing?.id) return;

    const id = planEditing.id;
    const before = planEditing;

    // optimistic patch
    const optimistic = {
      ...planEditing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    setPlans((prev) => prev.map((x) => (x.id === id ? optimistic : x)));
    setPlanEditOpen(false);

    try {
      await repo.update(id, patch);
      setToast({ tone: "success", text: "Plan updated." });
      refreshPlans();
    } catch (e) {
      setPlans((prev) => prev.map((x) => (x.id === id ? before : x)));
      setToast({
        tone: "error",
        text: `Couldn’t save: ${e?.message || "error"}`,
      });
    }
  };

  const handleRunPlan = async (p) => {
    // If plan has a stored draft snapshot, run it like a normal draft.
    if (p?.draft) {
      setDraft(p.draft);
      setModalOpen(true);
      setToast({
        tone: "info",
        text: "Loaded plan draft.",
        action: { label: "Cook Now", fn: () => handleCookNow(p.draft) },
      });
      return;
    }

    // If no draft snapshot, create a quick fallback draft from plan metadata.
    const fallback = makeFallbackDraft({
      title: p?.title || "Cooking Session",
      windowRange: null,
      includeTags: p?.tags || includeTags,
      preferences: {
        cuisines,
        proteins,
        equipment,
      },
    });
    setDraft(fallback);
    setModalOpen(true);
    setToast({ tone: "info", text: "Draft reconstructed (fallback)." });
  };

  return (
    <div className="sv-container">
      {/* Hero */}
      <div className="sv-hero sv-pad">
        <div className="sv-row sv-justify-between sv-align-center">
          <div className="sv-row">
            <span className="sv-emoji">🍲</span>
            <h1 className="sv-pageTitle">Cooking</h1>
          </div>

          <div className="sv-row sv-gap">
            <Button
              onClick={handleNow}
              title="Open SessionRunner now (hotkey: N)"
            >
              Now
            </Button>
            <div className="sv-caption" style={{ alignSelf: "center" }}>
              {runnable.length
                ? `${runnable.length} ready`
                : "builds from current draft"}
            </div>
          </div>
        </div>

        <p className="sv-muted">
          Generate a consolidated cooking session from your Meal Plan and/or
          Recipe Packs. Approve to sync with your calendar. Stream it live with
          a clean overlay.
        </p>
      </div>

      {/* Global banners */}
      {banners.map((b) => (
        <Banner
          key={b.key}
          tone={b.tone}
          onDismiss={
            b.dismissible === false ? undefined : () => bannerDismiss(b.key)
          }
        >
          <div
            className="sv-row sv-gap"
            style={{ justifyContent: "space-between" }}
          >
            <span>{b.text}</span>
            <div className="sv-row sv-gap">
              {b.actions?.map((a, i) => (
                <Button key={String(i)} variant="outline" onClick={a.fn}>
                  {a.label}
                </Button>
              ))}
            </div>
          </div>
        </Banner>
      ))}

      <div className="sv-grid-3">
        {/* Controls – Quick Start */}
        <Card className="sv-pad sv-span-2">
          <SectionHeader
            icon="🧭"
            title={
              <>
                <span>Generate Session</span>
                <span className="sv-badge" style={{ marginLeft: 8 }}>
                  auto
                </span>
              </>
            }
            sub="Quick start with great defaults. Tweak details in sheets as needed."
            right={
              busy ? (
                <div className="sv-row sv-gap">
                  <ProgressBar pct={progress.pct} />
                  <div className="sv-caption">
                    {(progress.phase || "working…").replace(
                      /^draft:cooking:/,
                      ""
                    )}{" "}
                    • {Math.round(progress.pct || 0)}%
                  </div>
                </div>
              ) : null
            }
          />

          <div className="sv-grid-2">
            <Input
              label="Title"
              value={title}
              onChange={setTitle}
              placeholder="Cooking Session"
            />
            <label className="sv-field">
              <span className="sv-field__label">Preset</span>
              <div className="sv-wrap">
                {[
                  ["balanced", "Balanced"],
                  ["cook_once_eat_twice", "Cook once • eat twice"],
                  ["freezer_fill", "Freezer fill"],
                ].map(([k, lbl]) => (
                  <Chip
                    key={k}
                    active={batchMode === k}
                    onClick={() => setBatchMode(k)}
                  >
                    {lbl}
                  </Chip>
                ))}
              </div>
            </label>
          </div>

          <div className="sv-grid-2 sv-block">
            <Input
              label="Window start"
              type="date"
              value={start}
              onChange={setStart}
            />
            <Input
              label="Window end"
              type="date"
              value={end}
              onChange={setEnd}
            />
          </div>

          <div className="sv-row sv-gap sv-block" style={{ flexWrap: "wrap" }}>
            <FilterButton
              label="Include tags"
              summary={includeTags.length ? includeTags.join(", ") : "None"}
              onClick={() => setOpenSheet("tags")}
            />
            <FilterButton
              label="Diversity"
              summary={`${cuisines.length} cuisines, ${proteins.length} proteins`}
              onClick={() => setOpenSheet("diversity")}
            />
            <FilterButton
              label="Diet & Equipment"
              summary={`${dietaryFlags.length || 0} diet flags, ${
                equipment.length
              } equipment`}
              onClick={() => setOpenSheet("diet")}
            />
            <FilterButton
              label="Constraints"
              summary={constraintSummary}
              onClick={() => setOpenSheet("constraints")}
            />
            <FilterButton
              label="Finishes"
              summary={`Meat ${doneness.redMeat}, Veg ${doneness.veg}`}
              onClick={() => setOpenSheet("finishes")}
            />
            <FilterButton
              label="Packs & Rhythm"
              summary={`${selectedPackIds.length} packs${
                rhythmEnabled ? " • window" : ""
              }${sabbathAware ? " • sabbath-aware" : ""}`}
              onClick={() => setOpenSheet("packs")}
            />
          </div>

          <div className="sv-row sv-block">
            <Button
              onClick={handleGenerate}
              disabled={busy}
              title="Shortcut: press G"
            >
              Generate session
            </Button>
            {busy && (
              <div className="sv-flex-1 sv-row sv-gap">
                <ProgressBar pct={progress.pct} />
                <div className="sv-caption">
                  {(progress.phase || "working…").replace(
                    /^draft:cooking:/,
                    ""
                  )}{" "}
                  • {Math.round(progress.pct || 0)}%
                </div>
              </div>
            )}
          </div>

          <div
            className="sv-row sv-gap sv-muted sv-text-sm"
            style={{ marginTop: 12 }}
          >
            <span className={conflictCount ? "sv-danger" : ""}>
              Conflicts: {conflictCount}
            </span>
            <span>•</span>
            <span>Shortages: {shortages.total}</span>
            <span className="sv-spacer" />
            <Button variant="outline" onClick={openSupplies}>
              Open Supplies
            </Button>
            <Button variant="outline" onClick={openGrocery}>
              Open Grocery
            </Button>
          </div>
        </Card>

        {/* Right rail */}
        <Card className="sv-pad">
          <SectionHeader
            icon="📄"
            title="Latest Draft"
            sub="Preview, stream overlay, quick actions, and nutrition."
          />

          {draft ? (
            <div className="sv-stack-sm sv-text-sm">
              <div className="sv-strong">{draft.title || title}</div>
              <div className="sv-muted">
                {draft.metrics?.totalRecipes ?? 0} recipes •{" "}
                {draft.steps?.length ?? 0} steps • ~{" "}
                {draft.metrics?.estMinutes ?? 0} min
              </div>

              <div className="sv-block">
                <div className="sv-caption caps">Overlay Room (optional)</div>
                <div className="sv-row sv-gap">
                  <Input
                    label="Room code"
                    value={roomInput}
                    onChange={setRoomInput}
                    placeholder="ABCD"
                  />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      if (!roomInput.trim()) return;
                      const { ok } = await roomConn.join(roomInput.trim());
                      setToast({
                        tone: ok ? "success" : "error",
                        text: ok ? `Joined room ${roomInput}` : "Join failed",
                      });
                    }}
                  >
                    {roomConn.connected
                      ? `Connected (${roomConn.clientType || "rt"})`
                      : "Join"}
                  </Button>
                  {roomConn.connected && (
                    <Button variant="ghost" onClick={() => roomConn.leave()}>
                      Leave
                    </Button>
                  )}
                </div>
                <div className="sv-caption">
                  Tip: For remote overlay/OBS, open this page with{" "}
                  <code>{`?overlay=1&room=${roomInput || "ABCD"}`}</code>.
                </div>
              </div>

              {stationKeys.length > 0 && (
                <div className="sv-block">
                  <div className="sv-caption caps">Filter by station</div>
                  <div className="sv-wrap">
                    <Chip
                      active={stationFilter === "all"}
                      onClick={() => setStationFilter("all")}
                    >
                      All
                    </Chip>
                    {draft.stations.map((s) => (
                      <Chip
                        key={s.key}
                        active={stationFilter === s.key}
                        onClick={() => setStationFilter(s.key)}
                      >
                        {s.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              )}

              <div className="sv-block">
                <div className="sv-caption caps">Livestream Overlay</div>
                <div className="sv-wrap">
                  <Toggle
                    label="Streamer Safe (hide private details)"
                    checked={streamerSafe}
                    onChange={setStreamerSafe}
                  />
                  <Button
                    variant="outline"
                    onClick={handleOpenOverlay}
                    title="Shortcut: press O"
                  >
                    Open Overlay Window
                  </Button>
                </div>
                <div className="sv-caption">
                  Local: add a Browser source pointed at this page with{" "}
                  <code>?overlay=1</code>. • Remote: include{" "}
                  <code>{`&room=${roomInput || "ABCD"}`}</code>.
                </div>
              </div>

              <div className="sv-row sv-gap" style={{ flexWrap: "wrap" }}>
                <Button variant="ghost" onClick={() => setModalOpen(true)}>
                  Open
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleSaveFavorite(draft)}
                >
                  Save Favorite
                </Button>
                <Button
                  variant="outline"
                  onClick={() => handleSaveScheduleTemplate(draft)}
                >
                  Save Schedule
                </Button>
                <Button
                  onClick={() => handleApprove(draft)}
                  title="Shortcut: press A"
                >
                  Approve &amp; Sync
                </Button>
                <Button
                  onClick={() => handleCookNow(draft)}
                  title="Shortcut: press C"
                >
                  Cook Now
                </Button>
                <Button
                  variant="outline"
                  onClick={handleNow}
                  title="Open SessionRunner now (hotkey: N)"
                >
                  Now
                </Button>
                <Button
                  variant="outline"
                  onClick={handleSavePlanFromDraft}
                  title={
                    !plansReady
                      ? "Plans loading…"
                      : "Save this draft into Cooking Plans"
                  }
                  disabled={!plansReady}
                >
                  Save to Plans
                </Button>
              </div>

              <div className="sv-block">
                <div className="sv-caption caps">Stations</div>
                <ul className="sv-list">
                  {(visibleStations || []).slice(0, 5).map((s) => (
                    <li key={s.key}>{s.label}</li>
                  ))}
                  {!visibleStations?.length && (
                    <li className="sv-muted">None</li>
                  )}
                </ul>
              </div>

              <div className="sv-block">
                <NutritionPanel
                  recipes={(draft.selection || draft.steps || []).map((r) => ({
                    id: r.id,
                  }))}
                  servings={1}
                  dense
                  showActions={false}
                />
              </div>

              <div className="sv-block">
                <div className="sv-caption caps">Finish snapshot</div>
                <div className="sv-muted">
                  Doneness: meat {doneness.redMeat}, fish {doneness.fish}, veg{" "}
                  {doneness.veg} • Texture bias: crisp {texturePrefs.crispiness}
                  /10, moist {texturePrefs.moistness}/10
                </div>
              </div>
            </div>
          ) : (
            <div className="sv-empty">
              <p className="sv-muted">No draft yet.</p>
              <Button variant="outline" onClick={handleGenerate}>
                Generate your first session
              </Button>
              <Button
                onClick={handleNow}
                title="Create a quick session and run it"
              >
                Now
              </Button>
            </div>
          )}
        </Card>
      </div>

      {/* NEW: Cooking Plans Library (Dexie CRUD) */}
      <Card className="sv-pad sv-block">
        <SectionHeader
          icon="📚"
          title="Cooking Plans"
          sub="Save, search, edit, complete, and rerun your best sessions."
          right={
            <div className="sv-row sv-gap" style={{ flexWrap: "wrap" }}>
              <Input
                label="Search"
                value={planQuery}
                onChange={setPlanQuery}
                placeholder="Title, tag, notes…"
              />
              <Select
                label="Status"
                value={planStatus}
                onChange={setPlanStatus}
                options={[
                  { value: "all", label: "All" },
                  { value: "active", label: "Active" },
                  { value: "completed", label: "Completed" },
                ]}
              />
              <Select
                label="Tag"
                value={planTagFilter}
                onChange={setPlanTagFilter}
                options={allTags.map((t) => ({
                  value: t,
                  label: t === "all" ? "All tags" : t,
                }))}
              />
              <Button
                variant="outline"
                onClick={() => refreshPlans()}
                title={plansErr ? `Error: ${plansErr}` : "Refresh list"}
              >
                Refresh
              </Button>
            </div>
          }
        />

        {plansErr ? (
          <div className="sv-banner sv-banner--warning">
            Plans error: {plansErr}
          </div>
        ) : null}

        <div className="sv-stack" style={{ marginTop: 10 }}>
          {!plansReady ? (
            <div className="sv-muted">Loading plans…</div>
          ) : !filteredPlans.length ? (
            <div className="sv-muted">
              No plans yet. Generate a draft and click{" "}
              <span className="sv-strong">Save to Plans</span>.
            </div>
          ) : (
            filteredPlans.slice(0, 60).map((p) => (
              <div
                key={p.id}
                className="sv-card sv-pad"
                style={{ borderRadius: 14 }}
              >
                <div className="sv-row sv-justify-between sv-align-center">
                  <div style={{ minWidth: 0 }}>
                    <div
                      className="sv-row sv-gap sv-align-center"
                      style={{ flexWrap: "wrap" }}
                    >
                      <div
                        className="sv-strong"
                        style={{ overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {p.title || "Untitled"}
                      </div>
                      <span
                        className={`sv-badge ${
                          p.status === "completed" ? "sv-badge--ok" : ""
                        }`}
                      >
                        {p.status}
                      </span>
                      {p.metrics ? (
                        <span className="sv-muted sv-text-sm">
                          {p.metrics.steps ?? 0} steps • ~
                          {p.metrics.estMinutes ?? 0} min
                        </span>
                      ) : null}
                    </div>

                    <div className="sv-wrap" style={{ marginTop: 6 }}>
                      {(p.tags || []).slice(0, 10).map((t) => (
                        <span
                          key={`${p.id}_${t}`}
                          className="sv-chip is-active"
                          style={{ cursor: "default" }}
                        >
                          {t}
                        </span>
                      ))}
                      {!p.tags?.length ? (
                        <span className="sv-muted sv-text-sm">No tags</span>
                      ) : null}
                    </div>

                    {p.notes ? (
                      <div
                        className="sv-muted sv-text-sm"
                        style={{ marginTop: 6 }}
                      >
                        {String(p.notes).slice(0, 160)}
                        {String(p.notes).length > 160 ? "…" : ""}
                      </div>
                    ) : null}

                    <div className="sv-caption" style={{ marginTop: 6 }}>
                      Updated{" "}
                      {p.updatedAt
                        ? new Date(p.updatedAt).toLocaleString()
                        : "—"}
                    </div>
                  </div>

                  <div className="sv-row sv-gap" style={{ flexWrap: "wrap" }}>
                    <Button variant="outline" onClick={() => handleRunPlan(p)}>
                      Open
                    </Button>
                    <Button variant="outline" onClick={() => handleEditPlan(p)}>
                      Edit
                    </Button>
                    <div className="sv-row sv-gap" style={{ flexWrap: "wrap" }}>
                      <Button
                        variant="outline"
                        onClick={() =>
                          qa?.open?.({ source: "Cooking", initialText: "" })
                        }
                        title="Quick add a note/ingredient/task to Cooking"
                      >
                        Quick Add
                      </Button>

                      <Button
                        variant="outline"
                        onClick={() => handleTogglePlanCompleted(p)}
                      >
                        {p.status === "completed" ? "Restore" : "Complete"}
                      </Button>
                    </div>

                    <Button
                      variant="ghost"
                      onClick={() => handleDeletePlan(p)}
                      title="Delete plan"
                    >
                      Delete
                    </Button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      </Card>

      {/* Sheets (progressive disclosure) */}
      {/* TAGS SHEET */}
      <Sheet
        open={openSheet === "tags"}
        title="Include Tags"
        onClose={() => setOpenSheet(null)}
      >
        <p className="sv-muted sv-text-sm">
          Tags help the planner pull the right recipes from your Meal Plan.
          Think <strong>Breakfast / Leftovers / Company / Feast</strong>.
        </p>

        <div className="sv-grid-2 sv-block" style={{ marginTop: 12 }}>
          <Input
            label="Search presets"
            value={tagPresetSearch}
            onChange={setTagPresetSearch}
            placeholder="Type to filter presets…"
          />
          <Input
            label="Add custom tag"
            value={newTag}
            onChange={setNewTag}
            placeholder="E.g. Kid-friendly"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newTag.trim()) {
                const trimmed = newTag.trim();
                if (!includeTags.includes(trimmed)) {
                  setIncludeTags((prev) => [...prev, trimmed]);
                }
                setNewTag("");
              }
            }}
          />
        </div>

        <div className="sv-block">
          <div className="sv-caption caps">Presets</div>
          <div className="sv-wrap">
            {filteredTagPresets.map((t) => (
              <Chip
                key={t}
                active={includeTags.includes(t)}
                onClick={() => toggleItem(setIncludeTags)(t)}
              >
                {t}
              </Chip>
            ))}
          </div>
        </div>

        <div className="sv-block">
          <div className="sv-caption caps">Active tags</div>
          {includeTags.length ? (
            <div className="sv-wrap">
              {includeTags.map((t) => (
                <Chip
                  key={t}
                  active
                  onClick={() => toggleItem(setIncludeTags)(t)}
                >
                  {t} ✕
                </Chip>
              ))}
            </div>
          ) : (
            <p className="sv-muted sv-text-sm">
              No tags selected – the planner will use your whole Meal Plan
              window.
            </p>
          )}
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button variant="outline" onClick={() => setIncludeTags([])}>
            Clear
          </Button>
          <Button onClick={() => setOpenSheet(null)}>Done</Button>
        </div>
      </Sheet>

      {/* DIVERSITY SHEET */}
      <Sheet
        open={openSheet === "diversity"}
        title="Cuisine & Protein Diversity"
        onClose={() => setOpenSheet(null)}
      >
        <p className="sv-muted sv-text-sm">
          Choose which <strong>cuisines</strong> and <strong>proteins</strong>{" "}
          you want in this session. The agent will balance them across the
          window.
        </p>

        <div className="sv-grid-2 sv-block" style={{ marginTop: 12 }}>
          <div>
            <div className="sv-caption caps">Cuisines</div>
            <div className="sv-wrap">
              {CUISINES.map((c) => (
                <Chip
                  key={c}
                  active={cuisines.includes(c)}
                  onClick={() => toggleItem(setCuisines)(c)}
                >
                  {c}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <div className="sv-caption caps">Proteins</div>
            <div className="sv-wrap">
              {PROTEINS.map((p) => (
                <Chip
                  key={p}
                  active={proteins.includes(p)}
                  onClick={() => toggleItem(setProteins)(p)}
                >
                  {p}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button
            variant="outline"
            onClick={() =>
              setCuisines(["Soul Food", "West African", "Caribbean"])
            }
          >
            Reset Cuisines
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              setProteins(["Beef", "Lamb", "Chicken", "Beans/Lentils"])
            }
          >
            Reset Proteins
          </Button>
          <Button onClick={() => setOpenSheet(null)}>Done</Button>
        </div>
      </Sheet>

      {/* DIET & EQUIPMENT SHEET */}
      <Sheet
        open={openSheet === "diet"}
        title="Diet & Equipment"
        onClose={() => setOpenSheet(null)}
      >
        <p className="sv-muted sv-text-sm">
          Tell the planner what <strong>diet flags</strong> to honor and which{" "}
          <strong>equipment</strong> to use today.
        </p>

        <div className="sv-grid-2 sv-block" style={{ marginTop: 12 }}>
          <div>
            <div className="sv-caption caps">Dietary flags</div>
            <div className="sv-wrap">
              {DIETARY.map((d) => (
                <Chip
                  key={d}
                  active={dietaryFlags.includes(d)}
                  onClick={() => toggleItem(setDietaryFlags)(d)}
                >
                  {d}
                </Chip>
              ))}
            </div>
          </div>

          <div>
            <div className="sv-caption caps">Equipment</div>
            <div className="sv-wrap">
              {EQUIPMENT.map((e) => (
                <Chip
                  key={e}
                  active={equipment.includes(e)}
                  onClick={() => toggleItem(setEquipment)(e)}
                >
                  {e}
                </Chip>
              ))}
            </div>
          </div>
        </div>

        <div className="sv-block">
          <Toggle
            label="Pantry-first (use what you already have)"
            checked={pantryFirst}
            onChange={setPantryFirst}
          />
          <Toggle
            label="Seasonal-only (prefer in-season produce)"
            checked={seasonalOnly}
            onChange={setSeasonalOnly}
          />
        </div>

        <div className="sv-grid-2 sv-block">
          <Select
            label="Indoor / Outdoor bias"
            value={indoorOutdoor}
            onChange={setIndoorOutdoor}
            options={[
              { value: "auto", label: "Auto" },
              { value: "indoor", label: "Indoor focus" },
              { value: "outdoor", label: "Outdoor / Grill" },
            ]}
          />
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button onClick={() => setOpenSheet(null)}>Done</Button>
        </div>
      </Sheet>

      {/* CONSTRAINTS SHEET */}
      <Sheet
        open={openSheet === "constraints"}
        title="Budget & Time Constraints"
        onClose={() => setOpenSheet(null)}
      >
        <p className="sv-muted sv-text-sm">
          Set gentle constraints. The agent will treat them as{" "}
          <strong>goals</strong>, not hard rules.
        </p>

        <div className="sv-grid-3 sv-block" style={{ marginTop: 12 }}>
          <Input
            label="Budget per serving ($)"
            type="number"
            value={budgetPerServing}
            onChange={setBudgetPerServing}
            min="0"
            step="0.25"
          />
          <Input
            label="Max total minutes"
            type="number"
            value={maxTotalMinutes}
            onChange={setMaxTotalMinutes}
            min="0"
            step="10"
          />
          <Input
            label="Freezer space (qt)"
            type="number"
            value={freezerSpaceQt}
            onChange={setFreezerSpaceQt}
            min="0"
            step="1"
          />
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button
            variant="outline"
            onClick={() => {
              setBudgetPerServing("");
              setMaxTotalMinutes("");
              setFreezerSpaceQt("");
            }}
          >
            Clear
          </Button>
          <Button onClick={() => setOpenSheet(null)}>Done</Button>
        </div>
      </Sheet>

      {/* FINISHES SHEET */}
      <Sheet
        open={openSheet === "finishes"}
        title="Doneness & Texture Finishes"
        onClose={() => setOpenSheet(null)}
      >
        <p className="sv-muted sv-text-sm">
          This tells the agent what <strong>finish cues</strong> to bias for
          notes and timers. It won’t overrule food safety.
        </p>

        <div className="sv-grid-2 sv-block" style={{ marginTop: 12 }}>
          <div>
            <div className="sv-caption caps">Doneness presets</div>
            <div className="sv-stack-sm">
              {[
                ["Red meat", "redMeat", DONENESS_OPTIONS.redMeat],
                ["Poultry", "poultry", DONENESS_OPTIONS.poultry],
                ["Fish", "fish", DONENESS_OPTIONS.fish],
                ["Eggs", "eggs", DONENESS_OPTIONS.eggs],
                ["Pasta", "pasta", DONENESS_OPTIONS.pasta],
                ["Rice & beans", "riceBeans", DONENESS_OPTIONS.riceBeans],
                ["Veg", "veg", DONENESS_OPTIONS.veg],
              ].map(([label, key, opts]) => (
                <div key={key}>
                  <div className="sv-subtitle">{label}</div>
                  <div className="sv-wrap">
                    {opts.map((o) => (
                      <Chip
                        key={o.value}
                        active={doneness[key] === o.value}
                        onClick={() =>
                          setDoneness((prev) => ({ ...prev, [key]: o.value }))
                        }
                      >
                        {o.label}
                      </Chip>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="sv-caption caps">Texture & finish sliders</div>
            <div className="sv-stack-sm">
              <Slider
                label="Softness"
                value={texturePrefs.softness}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, softness: v }))
                }
                caption="0 = firm, 10 = very soft"
              />
              <Slider
                label="Tenderness"
                value={texturePrefs.tenderness}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, tenderness: v }))
                }
              />
              <Slider
                label="Crispiness"
                value={texturePrefs.crispiness}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, crispiness: v }))
                }
              />
              <Slider
                label="Chewiness"
                value={texturePrefs.chewiness}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, chewiness: v }))
                }
              />
              <Slider
                label="Moistness"
                value={texturePrefs.moistness}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, moistness: v }))
                }
              />
              <Slider
                label="Sauciness"
                value={texturePrefs.sauciness}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, sauciness: v }))
                }
              />
              <Slider
                label="Char"
                value={texturePrefs.char}
                onChange={(v) => setTexturePrefs((p) => ({ ...p, char: v }))}
              />
              <Slider
                label="Smoke"
                value={texturePrefs.smoke}
                onChange={(v) => setTexturePrefs((p) => ({ ...p, smoke: v }))}
              />
              <Slider
                label="Spice heat"
                value={texturePrefs.spiceHeat}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, spiceHeat: v }))
                }
              />
              <Slider
                label="Sweetness"
                value={texturePrefs.sweetness}
                onChange={(v) =>
                  setTexturePrefs((p) => ({ ...p, sweetness: v }))
                }
              />
              <Slider
                label="Acidity"
                value={texturePrefs.acidity}
                onChange={(v) => setTexturePrefs((p) => ({ ...p, acidity: v }))}
              />
            </div>
          </div>
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button
            variant="outline"
            onClick={() => {
              setDoneness(DEFAULT_DONENESS);
              setTexturePrefs({
                softness: 5,
                tenderness: 6,
                crispiness: 4,
                chewiness: 3,
                moistness: 6,
                sauciness: 5,
                char: 3,
                smoke: 2,
                spiceHeat: 2,
                sweetness: 3,
                acidity: 3,
              });
            }}
          >
            Reset
          </Button>
          <Button onClick={() => setOpenSheet(null)}>Done</Button>
        </div>
      </Sheet>

      {/* PACKS & RHYTHM SHEET */}
      <Sheet
        open={openSheet === "packs"}
        title="Recipe Packs & Meal Rhythm"
        onClose={() => setOpenSheet(null)}
      >
        <p className="sv-muted sv-text-sm">
          Include <strong>Recipe Packs</strong> from your library and define a
          daily <strong>eating window</strong>. Sabbath awareness keeps cooking
          away from your rest blocks.
        </p>

        <div className="sv-block" style={{ marginTop: 12 }}>
          <div className="sv-caption caps">Recipe Packs</div>
          <RecipePackPicker
            packs={packs}
            selected={selectedPackIds}
            onToggle={(id) =>
              setSelectedPackIds((prev) =>
                prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
              )
            }
          />
        </div>

        <div className="sv-grid-2 sv-block">
          <div>
            <div className="sv-caption caps">Rhythm window</div>
            <Toggle
              label="Use time-restricted eating window"
              checked={rhythmEnabled}
              onChange={setRhythmEnabled}
            />
            {rhythmEnabled && (
              <div className="sv-grid-2 sv-block">
                <Input
                  label="Start"
                  type="time"
                  value={rhythmStart}
                  onChange={setRhythmStart}
                />
                <Input
                  label="End"
                  type="time"
                  value={rhythmEnd}
                  onChange={setRhythmEnd}
                />
              </div>
            )}
          </div>

          <div>
            <div className="sv-caption caps">Sabbath & servings</div>
            <Toggle
              label="Sabbath-aware (avoid cooking during Sabbath rest)"
              checked={sabbathAware}
              onChange={setSabbathAware}
            />
            <Input
              label="Servings override"
              type="number"
              value={servingsOverride}
              onChange={setServingsOverride}
              min="0"
              step="1"
              placeholder="Leave blank to infer"
            />
          </div>
        </div>

        <div className="sv-row sv-justify-end" style={{ marginTop: 12 }}>
          <Button onClick={() => setOpenSheet(null)}>Done</Button>
        </div>
      </Sheet>

      {/* Planner */}
      <Card id="sv-planner-anchor" className="sv-pad sv-block">
        <SectionHeader
          icon="🧩"
          title={
            <>
              <span>Session Planner</span>
              <span className="sv-badge" style={{ marginLeft: 8 }}>
                manual
              </span>
            </>
          }
          sub="Pick recipes, adjust stations & packaging, then generate."
        />
        <CookingSessionPlanner
          onDraftReady={(d) => {
            setDraft(d);
            setModalOpen(true);
          }}
        />
      </Card>

      {/* Timers */}
      {draft && (
        <Card className="sv-pad sv-block">
          <SectionHeader
            icon="⏱️"
            title="Multi-Timers"
            sub="Start timers, get voice alerts, and jump to steps."
          />
          <MultiTimerPanel
            draft={draft}
            stationFilter={stationFilter === "all" ? null : stationFilter}
            onOpenStep={(id) => console.debug("open step", id)}
          />
        </Card>
      )}

      <DraftModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        draft={draft}
        onApprove={handleApprove}
        onScheduleCleanup={handleScheduleCleanup}
        onSaveFavorite={handleSaveFavorite}
        onSaveSchedule={handleSaveScheduleTemplate}
        onCookNow={handleCookNow}
      />

      {/* NEW: Swap modal for NOW */}
      <SessionSwapModal
        open={swapOpen}
        onClose={() => setSwapOpen(false)}
        sessions={runnable}
        onSelect={handleSwapSelect}
      />

      {/* NEW: Plan editor */}
      <PlanEditSheet
        open={planEditOpen}
        plan={planEditing}
        onClose={() => setPlanEditOpen(false)}
        onSave={handleSavePlanEdit}
      />

      {/* Toasts */}
      {toast && (
        <div className="sv-toastWrap">
          <Toast
            tone={toast.tone}
            text={toast.text}
            action={toast.action}
            onClose={() => setToast(null)}
          />
        </div>
      )}
      {/* -------------------------- Optional Modals/Sheets -------------------------- */}
      {DraftModal ? (
        <DraftModal
          open={draftOpen}
          draft={activeDraft}
          onClose={() => setDraftOpen(false)}
          onSaved={(draft) => {
            emitCookingEvent(COOKING_EVENTS.planDraftSaved, { draft });
            setDraftOpen(false);
          }}
          onApply={(draft) => {
            emitCookingEvent(COOKING_EVENTS.planDraftApplied, { draft });
            setDraftOpen(false);
          }}
        />
      ) : null}

      {SessionSwapModal ? (
        <SessionSwapModal
          open={swapOpen}
          candidates={swapCandidates}
          onClose={() => setSwapOpen(false)}
          onPick={(picked) => {
            emitCookingEvent(COOKING_EVENTS.nowSessionRequested, { picked });
            setSwapOpen(false);
          }}
        />
      ) : null}

      {PlanEditSheet ? (
        <PlanEditSheet
          open={editOpen}
          plan={editPlan}
          onClose={() => setEditOpen(false)}
          onSave={(nextPlan) => {
            emitCookingEvent(COOKING_EVENTS.planUpdated, { plan: nextPlan });
            setEditOpen(false);
          }}
          onRemove={(planId) => {
            emitCookingEvent(COOKING_EVENTS.planRemoved, { planId });
            setEditOpen(false);
          }}
        />
      ) : null}

      {/* Toasts */}
      {toast && (
        <div className="sv-toastWrap">
          <Toast
            tone={toast.tone}
            text={toast.text}
            action={toast.action}
            onClose={() => setToast(null)}
          />
        </div>
      )}
      {modalOpen && draft && (
        <DraftModal
          open={modalOpen}
          draft={draft}
          onClose={() => setModalOpen(false)}
        />
      )}

      {swapOpen && (
        <SessionSwapModal
          open={swapOpen}
          candidates={swapCandidates}
          onSelect={handleSwapSelect}
          onClose={() => setSwapOpen(false)}
        />
      )}

      {planEditOpen && planEditing && (
        <PlanEditSheet
          open={planEditOpen}
          plan={planEditing}
          onClose={() => setPlanEditOpen(false)}
        />
      )}
    </div>
  );
}

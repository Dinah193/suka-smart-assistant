/* eslint-disable no-console */
// src/hooks/useNextBestAction.js
// Derives Next Best Actions (NBA) from scheduler + context.
// Listens to eventBus (inventory, sessions, schedules), guard-aware,
// and offers helpers to start sessions, save favorites, and save schedules.
//
// Usage:
// const { nbas, pick, dismiss, refresh, startSession, saveFavorite, saveSchedule } = useNextBestAction();
//
// Each NBA is:
// { id, domain, kind, title, subtitle, score, cta: { label, onClick }, meta }

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -----------------------------------------------------------------------------
   Defensive deps + helpers
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";

let eventBus = { emit() {}, on() {}, off() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch {}

let automation = { emit() {}, on() {}, off() {}, rules: { get: () => [] } };
try {
  const mod = require("@/services/automation/runtime");
  automation = (mod && (mod.automation || mod.default || mod)) || automation;
} catch {}

let pausePolicies = {
  constants: {
    REASON_USER: "user",
    REASON_SAFETY: "safety",
    REASON_SABBATH: "sabbath",
  },
  shouldFreeze: () => false,
  canContinue: () => true,
  normalize: (p) => ({ ...p }),
};
try {
  const mod = require("@/services/session/policies/pausePolicies");
  pausePolicies = (mod && (mod.default || mod)) || pausePolicies;
} catch {}

let calendarSync = {
  upcoming: async () => [],
  addEvents: async () => ({ ok: true }),
  writeSession: async () => ({ ok: true }),
};
try {
  const mod = require("@/services/calendar/calendarSync");
  calendarSync = (mod && (mod.default || mod)) || calendarSync;
} catch {}

let offsetParser = { parse: () => 0 };
try {
  const mod = require("@/services/session/utils/offsetParser");
  offsetParser = (mod && (mod.default || mod)) || offsetParser;
} catch {}

let useSettingsStore = () => ({
  quietHours: { start: "21:00", end: "06:30", enabled: false },
  sabbath: { enabled: false, from: "Friday 18:00", to: "Saturday 19:30" },
  rhythms: { preferMorning: true },
  defaults: {
    animalsTemplateId: "daily-animal-rounds",
    gardenTemplateId: "transplant-bed-basic",
    cleaningTemplateId: "speed-clean-30",
    mealsTemplateId: "dinner-quick-40",
  },
});
try {
  const mod = require("@/stores/settingsStore");
  useSettingsStore =
    (mod && (mod.default || mod.useSettingsStore)) || useSettingsStore;
} catch {}

let InventoryMonitor = { getSignals: () => ({ low: [], short: [] }) };
try {
  const mod = require("@/managers/InventoryMonitor");
  InventoryMonitor = (mod && (mod.default || mod)) || InventoryMonitor;
} catch {}

let GardenQueueManager = { peek: async () => [] };
try {
  const mod = require("@/managers/GardenQueueManager");
  GardenQueueManager = (mod && (mod.default || mod)) || GardenQueueManager;
} catch {}

let AnimalQueueManager = { peek: async () => [] };
try {
  const mod = require("@/managers/AnimalQueueManager");
  AnimalQueueManager = (mod && (mod.default || mod)) || AnimalQueueManager;
} catch {}

let useFavoriteSessions = () => ({
  list: () => [],
  save: async () => ({ ok: true }),
  remove: async () => ({ ok: true }),
});
try {
  const mod = require("@/hooks/useFavoriteSessions");
  useFavoriteSessions =
    (mod && (mod.default || mod.useFavoriteSessions)) || useFavoriteSessions;
} catch {}

let useSchedules = () => ({ list: () => [], save: async () => ({ ok: true }) });
try {
  const mod = require("@/hooks/useSchedules");
  useSchedules = (mod && (mod.default || mod.useSchedules)) || useSchedules;
} catch {}

/* -----------------------------------------------------------------------------
   Local fallbacks for favorites/schedules
----------------------------------------------------------------------------- */
const favKey = (domain) => `${domain || "session"}:favorites`;
const schedKey = (domain) => `${domain || "session"}:schedules`;

const localFavAPI = (domain) => ({
  list: () => {
    if (!isBrowser) return [];
    try {
      return JSON.parse(localStorage.getItem(favKey(domain)) || "[]");
    } catch {
      return [];
    }
  },
  save: async (fav) => {
    if (!isBrowser) return { ok: false };
    const all = localFavAPI(domain).list();
    const next = [
      ...all.filter((f) => f.id !== fav.id),
      { ...fav, updatedAt: Date.now() },
    ];
    localStorage.setItem(favKey(domain), JSON.stringify(next));
    return { ok: true };
  },
  remove: async (id) => {
    if (!isBrowser) return { ok: false };
    const next = localFavAPI(domain)
      .list()
      .filter((f) => f.id !== id);
    localStorage.setItem(favKey(domain), JSON.stringify(next));
    return { ok: true };
  },
});

const localSchedAPI = (domain) => ({
  list: () => {
    if (!isBrowser) return [];
    try {
      return JSON.parse(localStorage.getItem(schedKey(domain)) || "[]");
    } catch {
      return [];
    }
  },
  save: async (s) => {
    if (!isBrowser) return { ok: false };
    const all = localSchedAPI(domain).list();
    const next = [
      ...all.filter((x) => x.id !== s.id),
      { ...s, updatedAt: Date.now() },
    ];
    localStorage.setItem(schedKey(domain), JSON.stringify(next));
    return { ok: true };
  },
});

/* -----------------------------------------------------------------------------
   Utilities
----------------------------------------------------------------------------- */
const nowISO = () => new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 10);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const minutesUntil = (whenISO) => {
  if (!whenISO) return 9999;
  const d = new Date(whenISO).getTime() - Date.now();
  return Math.round(d / 60000);
};
const normalizeStr = (s) => (s || "").toLowerCase();

/* Simple scoring: higher is better */
function scoreNBA(nba, ctx) {
  let s = 0;

  // Base by kind
  const kind = nba.kind || "task";
  if (kind === "urgent") s += 60;
  if (kind === "task") s += 30;
  if (kind === "schedule") s += 25;
  if (kind === "inventory") s += 35;

  // Imminent time windows
  if (nba.meta?.windowStart) {
    const m = minutesUntil(nba.meta.windowStart);
    if (m <= 0) s += 20; // now
    else if (m <= 30) s += 15;
    else if (m <= 90) s += 8;
  }

  // Domain nudges
  const d = nba.domain;
  if (d === "animals" && ctx.rhythms?.preferMorning) s += 8;
  if (d === "garden" && ctx.rhythms?.preferMorning) s += 6;
  if (d === "meals") s += 5;
  if (d === "cleaning") s += 3;

  // Inventory pressure
  if (Array.isArray(nba.meta?.shortages) && nba.meta.shortages.length) {
    s += clamp(nba.meta.shortages.length * 4, 0, 24);
  }

  // Guard pressure: if Sabbath/QuietHours active, downscore tasks that need work
  if (ctx.frozenByGuard && kind !== "schedule") s -= 30;

  // Manual weight
  if (typeof nba.meta?.weight === "number") s += nba.meta.weight;

  return s;
}

/* -----------------------------------------------------------------------------
   The Hook
----------------------------------------------------------------------------- */
export function useNextBestAction() {
  const settings = useSettingsStore();
  const { quietHours, sabbath, rhythms, defaults } = settings;

  // Resolve persistence APIs (domain passed per-call in helpers)
  const favHookFactory = (domain) => {
    try {
      const h = useFavoriteSessions();
      if (h && typeof h.list === "function") return h;
    } catch {}
    return localFavAPI(domain);
  };
  const schedHookFactory = (domain) => {
    try {
      const h = useSchedules();
      if (h && typeof h.list === "function") return h;
    } catch {}
    return localSchedAPI(domain);
  };

  const [nbas, setNbas] = useState([]);
  const pendingDismiss = useRef(new Set());
  const lastCtx = useRef(null);

  const computeFrozen = useCallback(() => {
    try {
      return !!pausePolicies.shouldFreeze?.({
        domain: "system",
        quietHours,
        sabbath,
        rhythms,
        now: new Date(),
      });
    } catch {
      return false;
    }
  }, [quietHours, sabbath, rhythms]);

  const refresh = useCallback(async () => {
    const frozenByGuard = computeFrozen();

    // Gather signals defensively
    let inv = { low: [], short: [] };
    try {
      inv = (await InventoryMonitor.getSignals?.()) || inv;
    } catch {}

    let upcoming = [];
    try {
      upcoming = (await calendarSync.upcoming?.({ withinHours: 10 })) || [];
    } catch {}

    let gardenPeeks = [];
    try {
      gardenPeeks = (await GardenQueueManager.peek?.()) || [];
    } catch {}
    let animalPeeks = [];
    try {
      animalPeeks = (await AnimalQueueManager.peek?.()) || [];
    } catch {}

    const ctx = {
      frozenByGuard,
      inv,
      upcoming,
      gardenPeeks,
      animalPeeks,
      rhythms,
      defaults,
    };
    lastCtx.current = ctx;

    const ideas = [];

    // 1) Inventory-driven NBAs
    const shortages = [...(inv.short || []), ...(inv.low || [])];
    if (shortages.length) {
      ideas.push({
        id: `nba-inv-${uid()}`,
        domain: "inventory",
        kind: "inventory",
        title: "Restock essentials",
        subtitle: `${shortages.length} item(s) need attention`,
        meta: { shortages },
        cta: {
          label: "Open Inventory",
          onClick: () =>
            eventBus.emit("ui:navigate", { to: "/tier2/household/inventory" }),
        },
      });
    }

    // 2) Animals — Morning rounds or urgent items
    if (animalPeeks.length) {
      ideas.push({
        id: `nba-animals-${uid()}`,
        domain: "animals",
        kind: rhythms?.preferMorning ? "urgent" : "task",
        title: "Animal rounds",
        subtitle: "Feed • Water • Health check • Bedding",
        meta: {
          templateId: defaults?.animalsTemplateId || "daily-animal-rounds",
          weight: 8,
        },
        cta: {
          label: "Start session",
          onClick: () =>
            eventBus.emit("ui:startSession", {
              domain: "animals",
              templateId: defaults?.animalsTemplateId || "daily-animal-rounds",
            }),
        },
      });
    }

    // 3) Garden — quick bed refresh when peek signals exist
    if (gardenPeeks.length) {
      ideas.push({
        id: `nba-garden-${uid()}`,
        domain: "garden",
        kind: rhythms?.preferMorning ? "urgent" : "task",
        title: "Garden bed refresh",
        subtitle: "Weed • Amend • Transplant • Water",
        meta: {
          templateId: defaults?.gardenTemplateId || "transplant-bed-basic",
          weight: 6,
        },
        cta: {
          label: "Start session",
          onClick: () =>
            eventBus.emit("ui:startSession", {
              domain: "garden",
              templateId: defaults?.gardenTemplateId || "transplant-bed-basic",
            }),
        },
      });
    }

    // 4) Cleaning — if no urgent signals, propose quick 30
    ideas.push({
      id: `nba-clean-${uid()}`,
      domain: "cleaning",
      kind: "task",
      title: "Quick home reset (30 min)",
      subtitle: "Entry • Kitchen • Bath • Trash",
      meta: { templateId: defaults?.cleaningTemplateId || "speed-clean-30" },
      cta: {
        label: "Start session",
        onClick: () =>
          eventBus.emit("ui:startSession", {
            domain: "cleaning",
            templateId: defaults?.cleaningTemplateId || "speed-clean-30",
          }),
      },
    });

    // 5) Meals — suggest prep if dinner window in next 90m
    const dinner = (upcoming || []).find((e) =>
      normalizeStr(e.title).includes("dinner")
    );
    if (dinner) {
      const m = minutesUntil(dinner.start);
      ideas.push({
        id: `nba-meals-${uid()}`,
        domain: "meals",
        kind: m <= 90 ? "urgent" : "task",
        title: "Start dinner prep",
        subtitle: m <= 0 ? "Scheduled now" : `Starts in ~${m} min`,
        meta: {
          templateId: defaults?.mealsTemplateId || "dinner-quick-40",
          windowStart: dinner.start,
          weight: 5,
        },
        cta: {
          label: "Start session",
          onClick: () =>
            eventBus.emit("ui:startSession", {
              domain: "meals",
              templateId: defaults?.mealsTemplateId || "dinner-quick-40",
            }),
        },
      });
    } else {
      // If no explicit dinner event, still suggest a plan if it’s late afternoon
      const hour = new Date().getHours();
      if (hour >= 15 && hour <= 18) {
        ideas.push({
          id: `nba-meals-${uid()}`,
          domain: "meals",
          kind: "task",
          title: "Plan tonight’s dinner",
          subtitle: "Quick 40-minute dinner flow",
          meta: {
            templateId: defaults?.mealsTemplateId || "dinner-quick-40",
            weight: 3,
          },
          cta: {
            label: "Open Meal Planner",
            onClick: () =>
              eventBus.emit("ui:navigate", { to: "/tier2/household/meals" }),
          },
        });
      }
    }

    // Score, de-dup, and filter dismissed
    const withScores = ideas.map((n) => ({ ...n, score: scoreNBA(n, ctx) }));
    withScores.sort((a, b) => b.score - a.score);
    const unique = [];
    const seen = new Set();
    for (const n of withScores) {
      const key = `${n.domain}:${n.title}`;
      if (seen.has(key)) continue;
      if (pendingDismiss.current.has(key)) continue;
      seen.add(key);
      unique.push(n);
    }

    // Down-rank actionable tasks if guard is active, but keep schedules/inventory
    const finalList = unique.map((n) =>
      ctx.frozenByGuard && n.kind !== "schedule" && n.kind !== "inventory"
        ? {
            ...n,
            score: n.score - 30,
            subtitle:
              (n.subtitle ? n.subtitle + " • " : "") +
              "Paused by household guard",
          }
        : n
    );

    setNbas(finalList.slice(0, 6));
  }, [computeFrozen, rhythms, defaults]);

  // Initial + event-driven recompute
  useEffect(() => {
    refresh();
    const rebuilder = () => refresh();

    // Signals that commonly change NBA
    eventBus.on?.("inventory:signals", rebuilder);
    eventBus.on?.("session:created", rebuilder);
    eventBus.on?.("session:ended", rebuilder);
    eventBus.on?.("favorites:changed", rebuilder);
    eventBus.on?.("schedules:changed", rebuilder);
    eventBus.on?.("calendar:updated", rebuilder);
    eventBus.on?.("nba:refresh", rebuilder);

    return () => {
      eventBus.off?.("inventory:signals", rebuilder);
      eventBus.off?.("session:created", rebuilder);
      eventBus.off?.("session:ended", rebuilder);
      eventBus.off?.("favorites:changed", rebuilder);
      eventBus.off?.("schedules:changed", rebuilder);
      eventBus.off?.("calendar:updated", rebuilder);
      eventBus.off?.("nba:refresh", rebuilder);
    };
  }, [refresh]);

  /* -----------------------------------------------------------------------------
     Public helpers
  ----------------------------------------------------------------------------- */

  // Mark an NBA as chosen (emit + optimistic filter)
  const pick = useCallback(
    (id) => {
      const chosen = nbas.find((x) => x.id === id);
      if (!chosen) return;
      eventBus.emit("nba:picked", { id, nba: chosen, at: nowISO() });
      setNbas((prev) => prev.filter((x) => x.id !== id));
    },
    [nbas]
  );

  // Dismiss an NBA (session-local)
  const dismiss = useCallback(
    (id) => {
      const target = nbas.find((x) => x.id === id);
      if (!target) return;
      const key = `${target.domain}:${target.title}`;
      pendingDismiss.current.add(key);
      setNbas((prev) => prev.filter((x) => x.id !== id));
      eventBus.emit("nba:dismissed", {
        id,
        domain: target.domain,
        title: target.title,
        at: nowISO(),
      });
    },
    [nbas]
  );

  // Start a session via eventBus; SessionRunner pages are already listening
  const startSession = useCallback(({ domain, templateId, steps }) => {
    const sessionId = `${domain}-${uid()}`;
    eventBus.emit("session:created", {
      sessionId,
      domain,
      title: `${domain[0].toUpperCase()}${domain.slice(1)} Session`,
      steps: steps || [],
      startedAt: nowISO(),
    });
    eventBus.emit("ui:startSession", { domain, templateId, steps, sessionId });
  }, []);

  // Save user's favorite session for any domain (hooks or localStorage)
  const saveFavorite = useCallback(
    async ({
      domain,
      sessionId = `fav-${uid()}`,
      title = "Session",
      templateId,
      steps = [],
      meta = {},
    }) => {
      const favHook = favHookFactory(domain);
      const fav = {
        id: `fav-${sessionId}`,
        domain,
        title,
        templateId,
        steps,
        createdAt: meta.createdAt || nowISO(),
        updatedAt: Date.now(),
        meta: { source: "user", ...meta },
      };
      const res = await (favHook.save?.(fav) || Promise.resolve({ ok: false }));
      if (res?.ok) eventBus.emit("favorites:changed", { domain });
      return res;
    },
    []
  );

  // Save a user's schedule template (hooks or localStorage) + calendar write
  const saveSchedule = useCallback(
    async ({
      domain,
      title = "Session Schedule",
      templateId,
      steps = [],
      rrule = "FREQ=WEEKLY;BYDAY=MO",
      firstRunAt,
    }) => {
      const schedHook = schedHookFactory(domain);
      const base = new Date(firstRunAt || Date.now());
      if (rhythms?.preferMorning) {
        base.setHours(8, 0, 0, 0);
        if (base < new Date()) base.setDate(base.getDate() + 1);
      }
      const sched = {
        id: `sched-${uid()}`,
        domain,
        title,
        sessionTemplate: { templateId, steps },
        rrule,
        firstRunAt: base.toISOString(),
      };
      const res = await (schedHook.save?.(sched) ||
        Promise.resolve({ ok: false }));
      if (res?.ok) {
        eventBus.emit("schedules:changed", { domain });
        try {
          await calendarSync.addEvents?.({
            domain,
            title: sched.title,
            rrule: sched.rrule,
            firstRunAt: sched.firstRunAt,
            meta: { sessionTemplateId: sched.id, source: "useNextBestAction" },
          });
        } catch {}
      }
      return res;
    },
    [rhythms?.preferMorning]
  );

  const api = useMemo(
    () => ({
      nbas,
      refresh,
      pick,
      dismiss,
      startSession,
      saveFavorite,
      saveSchedule,
    }),
    [dismiss, nbas, pick, refresh, saveFavorite, saveSchedule, startSession]
  );

  return api;
}

export default useNextBestAction;

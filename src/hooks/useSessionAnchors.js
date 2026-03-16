/* eslint-disable no-console */
// src/hooks/useSessionAnchors.js
// Purpose: Reactive "UI anchors" state for any SessionRunner-like surface.
// - Subscribes to eventBus session signals (created/step/paused/resumed/ended)
// - Tracks anchors: banner, timeline, pauseModal, shortages, progress, kbHint, ctas, etc.
// - Exposes setters + imperative helpers to update anchors from anywhere
// - Emits/handles Favorites & Schedule "save" intents (user-owned) with localStorage fallback
//
// Usage:
// const { anchors, setAnchor, removeAnchor, saveFavorite, saveSchedule, emit } = useSessionAnchors({ domain, sessionId });
//
// Anchors shape example:
// anchors = {
//   banner: { title, subtitle, paused },
//   timeline: { steps, currentIndex },
//   pauseModal: { open, reason },
//   shortages: [{ item, qty, reason }],
//   progress: { pct, total, index },
//   kbHint: "(Space) pause • (→) next • (←) back",
//   ctas: [{ id, label, kind, onClick? }],
// }

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -----------------------------------------------------------------------------
   Defensive deps
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";

let eventBus = { emit() {}, on() {}, off() {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
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

let useSettingsStore = () => ({
  quietHours: { start: "21:00", end: "06:30", enabled: false },
  sabbath: { enabled: false, from: "Friday 18:00", to: "Saturday 19:30" },
  rhythms: { preferMorning: true },
});
try {
  const mod = require("@/stores/settingsStore");
  useSettingsStore =
    (mod && (mod.default || mod.useSettingsStore)) || useSettingsStore;
} catch {}

let calendarSync = {
  addEvents: async () => ({ ok: true }),
  writeSession: async () => ({ ok: true }),
};
try {
  const mod = require("@/services/calendar/calendarSync");
  calendarSync = (mod && (mod.default || mod)) || calendarSync;
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
const shallowEq = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (let k of ka) if (a[k] !== b[k]) return false;
  return true;
};

const rafBatch = (() => {
  let id = null;
  const fns = new Set();
  const flush = () => {
    id = null;
    fns.forEach((fn) => {
      try {
        fn();
      } catch (e) {
        console.warn("rafBatch fn error:", e?.message || e);
      }
    });
    fns.clear();
  };
  return (fn) => {
    fns.add(fn);
    if (id) return;
    id =
      isBrowser && window.requestAnimationFrame
        ? window.requestAnimationFrame(flush)
        : setTimeout(flush, 16);
  };
})();

const nowISO = () => new Date().toISOString();
const uid = () => Math.random().toString(36).slice(2, 10);

/* -----------------------------------------------------------------------------
   Public helper: emit anchor updates from anywhere (non-hook code)
----------------------------------------------------------------------------- */
export function emitAnchorUpdate({
  domain,
  sessionId,
  key,
  value,
  merge = true,
}) {
  eventBus.emit("session:anchor:update", {
    domain,
    sessionId,
    key,
    value,
    merge,
  });
}

/* -----------------------------------------------------------------------------
   Hook: useSessionAnchors
----------------------------------------------------------------------------- */
export function useSessionAnchors({ domain, sessionId } = {}) {
  const { quietHours, sabbath, rhythms } = useSettingsStore();
  const [anchors, setAnchors] = useState(() => ({
    banner: { title: "", subtitle: "", paused: false, progressPct: 0 },
    timeline: { steps: [], currentIndex: 0 },
    pauseModal: { open: false, reason: "" },
    shortages: [],
    progress: { pct: 0, total: 0, index: 0 },
    kbHint: "(Space) pause • (→) next • (←) back",
    ctas: [],
  }));

  // Resolve persistence APIs
  const favHook = (() => {
    try {
      const h = useFavoriteSessions();
      if (h && typeof h.list === "function") return h;
    } catch {}
    return localFavAPI(domain);
  })();
  const schedHook = (() => {
    try {
      const h = useSchedules();
      if (h && typeof h.list === "function") return h;
    } catch {}
    return localSchedAPI(domain);
  })();

  const anchorRef = useRef(anchors);
  useEffect(() => {
    anchorRef.current = anchors;
  }, [anchors]);

  const setAnchor = useCallback((key, value, { merge = true } = {}) => {
    rafBatch(() => {
      setAnchors((prev) => {
        const prevVal = prev[key];
        const nextVal =
          merge && typeof prevVal === "object" && prevVal
            ? { ...prevVal, ...value }
            : value;
        if (shallowEq(prevVal, nextVal)) return prev;
        return { ...prev, [key]: nextVal };
      });
    });
  }, []);

  const removeAnchor = useCallback((key) => {
    rafBatch(() => {
      setAnchors((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    });
  }, []);

  const emit = useCallback((type, payload) => {
    eventBus.emit(type, payload);
  }, []);

  /* -----------------------------------------------------------------------------
     Subscribe to orchestration signals
  ----------------------------------------------------------------------------- */
  useEffect(() => {
    if (!domain || !sessionId) return;

    const onCreated = (p) => {
      if (p?.domain !== domain || p?.sessionId !== sessionId) return;
      setAnchor("banner", {
        title: p.title || "Session",
        subtitle: p.subtitle || "",
        paused: false,
        progressPct: 0,
      });
      setAnchor("timeline", { steps: p.steps || [], currentIndex: 0 });
      setAnchor("progress", {
        pct: 0,
        total: (p.steps || []).length,
        index: 0,
      });
    };

    const onStepChanged = (p) => {
      if (p?.domain !== domain || p?.sessionId !== sessionId) return;
      const idx = Math.max(0, parseInt(p.index ?? 0, 10));
      const total = (anchorRef.current.timeline?.steps || []).length || 1;
      const pct = Math.max(
        0,
        Math.min(100, Math.round(((idx + 1) / total) * 100))
      );
      setAnchor("timeline", { currentIndex: idx });
      setAnchor("progress", { index: idx, total, pct });
      setAnchor("banner", { progressPct: pct });
    };

    const onPaused = (p) => {
      if (p?.domain !== domain || p?.sessionId !== sessionId) return;
      const reason =
        p?.reason === pausePolicies.constants?.REASON_SABBATH
          ? "Paused by household guard (Sabbath/Quiet Hours)."
          : p?.reason === pausePolicies.constants?.REASON_SAFETY
          ? "Paused for safety."
          : "Paused by user.";
      setAnchor("pauseModal", { open: true, reason });
      setAnchor("banner", { paused: true });
    };

    const onResumed = (p) => {
      if (p?.domain !== domain || p?.sessionId !== sessionId) return;
      setAnchor("pauseModal", { open: false, reason: "" });
      setAnchor("banner", { paused: false });
    };

    const onEnded = (p) => {
      if (p?.domain !== domain || p?.sessionId !== sessionId) return;
      setAnchor("banner", { progressPct: 100, endedAt: nowISO() });
      setAnchor("pauseModal", { open: false });
    };

    const onInventory = (p) => {
      if (p?.domain !== domain || p?.sessionId !== sessionId) return;
      const list = Array.isArray(p.shortages) ? p.shortages : [];
      setAnchor("shortages", list);
    };

    const onAnchorUpdate = (p) => {
      if (p?.domain !== domain || p?.sessionId !== sessionId) return;
      if (!p?.key) return;
      setAnchor(p.key, p.value, { merge: p.merge !== false });
    };

    // Favorites & schedules external changes
    const onFavs = (p) => {
      if (p?.domain !== domain) return;
      setAnchor("favoritesChangedAt", nowISO());
    };
    const onScheds = (p) => {
      if (p?.domain !== domain) return;
      setAnchor("schedulesChangedAt", nowISO());
    };

    eventBus.on?.("session:created", onCreated);
    eventBus.on?.("session:step:changed", onStepChanged);
    eventBus.on?.("session:paused", onPaused);
    eventBus.on?.("session:resumed", onResumed);
    eventBus.on?.("session:ended", onEnded);
    eventBus.on?.("inventory:signals", onInventory);
    eventBus.on?.("session:anchor:update", onAnchorUpdate);
    eventBus.on?.("favorites:changed", onFavs);
    eventBus.on?.("schedules:changed", onScheds);

    return () => {
      eventBus.off?.("session:created", onCreated);
      eventBus.off?.("session:step:changed", onStepChanged);
      eventBus.off?.("session:paused", onPaused);
      eventBus.off?.("session:resumed", onResumed);
      eventBus.off?.("session:ended", onEnded);
      eventBus.off?.("inventory:signals", onInventory);
      eventBus.off?.("session:anchor:update", onAnchorUpdate);
      eventBus.off?.("favorites:changed", onFavs);
      eventBus.off?.("schedules:changed", onScheds);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, sessionId]);

  /* -----------------------------------------------------------------------------
     Guards: evaluate on mount (inform anchors only — SessionRunner blocks UI)
  ----------------------------------------------------------------------------- */
  useEffect(() => {
    try {
      const shouldFreeze = pausePolicies.shouldFreeze?.({
        domain,
        quietHours,
        sabbath,
        rhythms,
        now: new Date(),
      });
      if (shouldFreeze) {
        setAnchor("pauseModal", {
          open: true,
          reason: "Paused by household guard (Sabbath/Quiet Hours).",
        });
        setAnchor("banner", { paused: true });
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain]);

  /* -----------------------------------------------------------------------------
     Favorite & Schedule helpers (user-owned)
  ----------------------------------------------------------------------------- */
  const saveFavorite = useCallback(
    async ({ title = "Session", templateId, steps = [], meta = {} }) => {
      if (!domain || !sessionId) return { ok: false, reason: "missing ids" };
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
    [domain, favHook, sessionId]
  );

  const saveSchedule = useCallback(
    async ({
      title = "Session Schedule",
      templateId,
      steps = [],
      rrule = "FREQ=WEEKLY;BYDAY=MO",
      firstRunAt,
    }) => {
      if (!domain) return { ok: false, reason: "missing domain" };
      const base = new Date(firstRunAt || Date.now());
      // If user prefers morning and the time already passed, bump to tomorrow AM
      if (useSettingsStore().rhythms?.preferMorning) {
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
        // Best effort: pre-write to calendar if available
        try {
          await calendarSync.addEvents?.({
            domain,
            title: sched.title,
            rrule: sched.rrule,
            firstRunAt: sched.firstRunAt,
            meta: { sessionTemplateId: sched.id, source: "useSessionAnchors" },
          });
        } catch {}
      }
      return res;
    },
    [domain, schedHook]
  );

  /* -----------------------------------------------------------------------------
     Public API
  ----------------------------------------------------------------------------- */
  const api = useMemo(
    () => ({
      anchors,
      setAnchor,
      removeAnchor,
      emit, // generic eventBus emitter
      saveFavorite,
      saveSchedule,
    }),
    [anchors, emit, removeAnchor, saveFavorite, saveSchedule, setAnchor]
  );

  return api;
}

export default useSessionAnchors;

// C:\Users\larho\suka-smart-assistant\src\store\CookingStore.js
//
// Lightweight, intuitive cooking planner / batch-cooking store.
// Mirrors other stores (Zustand-style):
//   import { useCooking, Cooking } from "@/store/CookingStore"
//
// What’s new in v3 (to support 4) & recent planner upgrades)
// - Draft → Approve flow so KPIs only count scheduled/approved sessions
// - Recipe-level metadata: station, allergen/dietary tags, yield/unit
// - Auto packaging estimate per recipe
// - Cooling/food-safety timers scaffold (UI can spin timers)
// - Label template on session
// - Storage capacity hints + warnings (freezer/fridge/pantry quarts)
// - Clickable KPI support via count helpers & curated getters
// - Clean intents for draft creation/approval & capacity updates
//
// Storage
// - Persisted to localStorage with versioning + migration
//
// Events emitted (window.dispatchEvent CustomEvent):
// - "cooking:updated" { type, session? }
// - "cooking:draft:created" { session }
// - "cooking:draft:approved" { session }
// - "cooking:warning" { code, message, meta }
// - "automation:intent" (we *emit* only when asked – here only on approve
//   we emit { intent: "calendar/sync", context: { ... } } so your
//   CalendarSync hook can pick it up)
//
// NOTE: plain JS to fit the rest of the project.
//

import { create } from "zustand";

/* ---------------------------------- Utils --------------------------------- */

const STORAGE_KEY = "cookingStore.v3";

/** Return Monday (00:00) of the week for a given date (local time). */
function weekStart(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay(); // 0..6 (Sun..Sat)
  // Make Monday the start: convert Sun(0) -> 6, Mon(1)->0, ...
  const diff = (day + 6) % 7;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diff);
  return d.toISOString();
}

/** Make a random-ish ID. */
function uid(prefix = "cook") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/** Clamp to a safe integer (minutes). */
function mins(n, fallback = 60) {
  const v = Number.isFinite(Number(n)) ? Math.max(0, Math.floor(Number(n))) : fallback;
  return v;
}

/** Move an ISO date by minutes. */
function shiftIso(iso, deltaMins = 0) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + Number(deltaMins || 0));
  return d.toISOString();
}

/** Return true if two ISO strings are the same calendar day (local). */
function isSameDay(aIso, bIso) {
  const a = new Date(aIso);
  const b = new Date(bIso);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Coerce recipe input into enriched recipe entry with defaults. */
function normalizeRecipe(r) {
  if (!r) return null;
  if (typeof r === "string") return { title: r };

  const {
    id,
    title,
    station = "prep", // prep | range | oven | grill | chill
    allergens = [], // e.g., ["gluten","dairy","nuts"]
    dietary = [], // e.g., ["gluten-free","dairy-free","kosher-style"]
    yieldUnit = { amount: 0, unit: "cups" }, // { amount, unit }
    packaging = { containerSize: 1, containerUnit: "cups" }, // for estimate
  } = r;

  // derive packaging estimate (ceil)
  const total = Number(yieldUnit?.amount || 0);
  const size = Number(packaging?.containerSize || 1);
  const containers =
    total > 0 && size > 0 ? Math.ceil(total / size) : 0;

  return {
    id,
    title,
    station,
    allergens: Array.isArray(allergens) ? allergens : [],
    dietary: Array.isArray(dietary) ? dietary : [],
    yieldUnit,
    packaging,
    packagingEstimate: containers,
  };
}

/** Calculate storage load in “quarts” rough equivalence for hints. */
function toQuarts(amount, unit) {
  // Simple conversions; UI can override with smarter logic later
  const u = (unit || "").toLowerCase();
  if (u === "q" || u === "quart" || u === "quarts") return Number(amount || 0);
  if (u === "cup" || u === "cups") return Number(amount || 0) / 4;
  if (u === "pt" || u === "pint" || u === "pints") return Number(amount || 0) / 2;
  if (u === "gal" || u === "gallon" || u === "gallons") return Number(amount || 0) * 4;
  // Fallback: treat unknown as quarts already
  return Number(amount || 0);
}

/* ------------------------------ Default State ----------------------------- */

const defaultState = () => {
  const start = weekStart();
  return {
    __version: 3,

    // Household storage capacity hints (user-tunable)
    capacity: {
      freezerQ: 40, // quarts remaining (estimate)
      fridgeQ: 20,
      pantryQ: 60,
    },

    // Current planning week
    week: {
      start, // ISO (Mon 00:00) of current week (local)
      sessions: [], // Session[]
    },

    // Derived cache (not persisted as-is; recomputed on load)
    today: {
      date: new Date().toISOString(),
      sessions: [],
    },
  };
};

/*
Session shape v3:
{
  id: string,
  title: string,                     // e.g., "Weekday Batch", "Freezer Fill"
  start: ISO string,                 // start datetime
  end: ISO string,                   // end datetime
  recipes: [                         // enriched recipe list
    {
      id?: string,
      title: string,
      station: 'prep'|'range'|'oven'|'grill'|'chill',
      allergens: string[],           // e.g., ["gluten","dairy"]
      dietary: string[],             // e.g., ["gluten-free"]
      yieldUnit: { amount: number, unit: "cups"|"pints"|"quarts"|"gal"|... },
      packaging: { containerSize: number, containerUnit: "cups"|"pints"|... },
      packagingEstimate: number      // auto computed container count
    }
  ],
  labelTemplate: {                   // one-click labels
    prefix: string,                  // e.g., "SVFH"
    dateFormat: string,              // e.g., "YYYY-MM-DD"
    ingredientsLine: string          // comma-separated base line
  },
  safetyTimers: {                    // UI turns to live timers
    hotFillHoldMins?: number,        // e.g., 10 for jams
    chillTargetF?: number,           // e.g., 41
    maxChillMins?: number            // e.g., 240 per FDA guidance
  },
  storageHints: {                    // rough quarts usage by zone
    freezerQ?: number,
    fridgeQ?: number,
    pantryQ?: number
  },
  status: 'draft'|'scheduled'|'in_progress'|'done'|'canceled',
  notes?: string
}
*/

/* ------------------------------- Persistence ------------------------------ */

function migrateToV3(parsed) {
  // from v1/v2 → v3
  const next = { ...defaultState(), ...parsed };

  next.__version = 3;
  next.capacity = parsed.capacity || defaultState().capacity;

  // Ensure week + sessions
  const wkStart = parsed.week?.start || weekStart();
  const sessions = Array.isArray(parsed.week?.sessions) ? parsed.week.sessions : [];
  next.week = { start: wkStart, sessions: sessions.map(migrateSessionV3) };

  return next;
}

function migrateSessionV3(s) {
  if (!s) return null;
  const r = Array.isArray(s.recipes) ? s.recipes.map(normalizeRecipe).filter(Boolean) : [];
  const labelTemplate = s.labelTemplate || { prefix: "SVFH", dateFormat: "YYYY-MM-DD", ingredientsLine: "" };
  const safetyTimers = s.safetyTimers || {};
  const storageHints = s.storageHints || estimateStorageFromRecipes(r);

  // Map old statuses: keep if present, default to 'scheduled'
  let status = s.status || "scheduled";
  // v3 adds 'draft'; older sessions remain as-is

  return {
    ...s,
    recipes: r,
    labelTemplate,
    safetyTimers,
    storageHints,
    status,
  };
}

function estimateStorageFromRecipes(recipes = []) {
  // Naive split: chilled items → fridge, frozen → freezer if tagged, else pantry
  // Without recipe flags, assume fridge usage from total yield in quarts
  const totalQ = recipes.reduce(
    (sum, r) => sum + toQuarts(r?.yieldUnit?.amount, r?.yieldUnit?.unit),
    0
  );
  // Basic heuristic: 60% fridge, 30% freezer, 10% pantry
  return {
    fridgeQ: Math.round(totalQ * 0.6 * 10) / 10,
    freezerQ: Math.round(totalQ * 0.3 * 10) / 10,
    pantryQ: Math.round(totalQ * 0.1 * 10) / 10,
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      // Try prior versions for migration
      const v2 = localStorage.getItem("cookingStore.v2");
      if (v2) {
        const parsedV2 = JSON.parse(v2);
        const migrated = migrateToV3(parsedV2);
        persist(migrated);
        return migrated;
      }
      return defaultState();
    }
    const parsed = JSON.parse(raw);

    if (!parsed.__version || parsed.__version < 3) {
      const migrated = migrateToV3(parsed);
      persist(migrated);
      return migrated;
    }

    // Ensure required props exist
    parsed.week = parsed.week || { start: weekStart(), sessions: [] };
    parsed.week.sessions = Array.isArray(parsed.week.sessions) ? parsed.week.sessions.map(migrateSessionV3).filter(Boolean) : [];
    parsed.capacity = parsed.capacity || defaultState().capacity;

    return parsed;
  } catch {
    return defaultState();
  }
}

function persist(state) {
  try {
    const copy = { ...state, today: undefined }; // don't persist derived
    localStorage.setItem(STORAGE_KEY, JSON.stringify(copy));
  } catch {
    // ignore storage errors
  }
}

/* ------------------------------ Derived Update ---------------------------- */

function recomputeToday(state) {
  const todayIso = new Date().toISOString();
  const todays = (state.week.sessions || []).filter(
    (s) => isSameDay(s.start, todayIso) && s.status !== "canceled"
  );
  state.today = { date: todayIso, sessions: todays };
}

/* ---------------------------------- Store --------------------------------- */

export const useCooking = create((set, get) => {
  const init = load();
  recomputeToday(init);

  const api = {
    /** Ensure we are on the correct planning week (rebase when week changes). */
    ensureWeek(current = new Date()) {
      const st = get();
      const need = weekStart(current);
      if (st.week.start !== need) {
        const next = { ...st, week: { start: need, sessions: [] } };
        recomputeToday(next);
        persist(next);
        set(next);
      }
    },

    /** Set storage capacity hints (quarts). */
    setCapacity(partial = {}) {
      const st = get();
      const cap = {
        ...st.capacity,
        ...Object.fromEntries(
          Object.entries(partial).map(([k, v]) => [k, Number.isFinite(+v) ? +v : st.capacity[k]])
        ),
      };
      const next = { ...st, capacity: cap };
      persist(next);
      set(next);
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "capacity", capacity: cap } }));
    },

    /** Internal: storage warning helper. */
    maybeWarnStorage(session) {
      const { freezerQ = 0, fridgeQ = 0, pantryQ = 0 } = session?.storageHints || {};
      const cap = get().capacity || {};
      const over = [];
      if (freezerQ > (cap.freezerQ ?? Infinity)) over.push("freezer");
      if (fridgeQ > (cap.fridgeQ ?? Infinity)) over.push("fridge");
      if (pantryQ > (cap.pantryQ ?? Infinity)) over.push("pantry");
      if (over.length) {
        window.dispatchEvent(
          new CustomEvent("cooking:warning", {
            detail: {
              code: "STORAGE_OVER_CAP",
              message: `Plan may exceed ${over.join(", ")} capacity.`,
              meta: { over, session, capacity: cap },
            },
          })
        );
      }
    },

    /** Create a draft session from recipes (for SessionDraftDetail modal). */
    createDraft({
      title = "Draft Cooking Session",
      start = new Date().toISOString(),
      durationMins = 90,
      recipes = [],
      notes = "",
      labelTemplate = { prefix: "SVFH", dateFormat: "YYYY-MM-DD", ingredientsLine: "" },
      safetyTimers = {}, // { hotFillHoldMins, chillTargetF, maxChillMins }
    } = {}) {
      const st = get();
      const recs = Array.isArray(recipes) ? recipes.map(normalizeRecipe).filter(Boolean) : [];
      const sess = {
        id: uid("draft"),
        title,
        start,
        end: shiftIso(start, mins(durationMins, 90)),
        recipes: recs,
        labelTemplate,
        safetyTimers,
        storageHints: estimateStorageFromRecipes(recs),
        status: "draft",
        notes,
      };
      const next = { ...st, week: { ...st.week, sessions: [...(st.week.sessions || []), sess] } };
      recomputeToday(next);
      persist(next);
      set(next);
      window.dispatchEvent(new CustomEvent("cooking:draft:created", { detail: { session: sess } }));
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "draft:create", session: sess } }));
      return sess.id;
    },

    /** Approve a draft → scheduled (fires CalendarSync intent for hook). */
    approveDraft(id, { scheduleAtIso, durationMins } = {}) {
      const st = get();
      const session = (st.week.sessions || []).find((s) => s.id === id);
      if (!session) return;
      if (scheduleAtIso) session.start = scheduleAtIso;
      if (durationMins) session.end = shiftIso(session.start, mins(durationMins, 90));
      session.status = "scheduled";

      const next = { ...st, week: { ...st.week, sessions: [...st.week.sessions] } };
      recomputeToday(next);
      persist(next);
      set(next);

      // Warn if storage exceeded
      api.maybeWarnStorage(session);

      // Emit approval + calendar intent (your CalendarSync hook listens for this)
      window.dispatchEvent(new CustomEvent("cooking:draft:approved", { detail: { session } }));
      window.dispatchEvent(
        new CustomEvent("automation:intent", {
          detail: {
            intent: "calendar/sync",
            context: {
              source: "cooking",
              id: session.id,
              title: session.title,
              start: session.start,
              end: session.end,
              tags: ["cooking", "session"],
            },
          },
        })
      );

      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "draft:approve", session } }));
    },

    /** Schedule a (non-draft) session quickly. */
    scheduleSession({
      title = "Cooking Session",
      start = new Date().toISOString(),
      durationMins = 90,
      recipes = [],
      notes = "",
      status = "scheduled",
      labelTemplate = { prefix: "SVFH", dateFormat: "YYYY-MM-DD", ingredientsLine: "" },
      safetyTimers = {},
    } = {}) {
      const st = get();
      const recs = Array.isArray(recipes) ? recipes.map(normalizeRecipe).filter(Boolean) : [];
      const sess = {
        id: uid(),
        title,
        start,
        end: shiftIso(start, mins(durationMins, 90)),
        recipes: recs,
        labelTemplate,
        safetyTimers,
        storageHints: estimateStorageFromRecipes(recs),
        status,
        notes,
      };
      const next = { ...st, week: { ...st.week, sessions: [...(st.week.sessions || []), sess] } };
      recomputeToday(next);
      persist(next);
      set(next);
      api.maybeWarnStorage(sess);
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "schedule", session: sess } }));
      return sess.id;
    },

    /** Start (or quick-start) a session. If id missing, create one for 'now'. */
    startSession(id) {
      const st = get();
      let next = { ...st };
      let session = (st.week.sessions || []).find((s) => s.id === id);
      if (!session) {
        // Quick session: 90 mins starting now
        const newId = api.scheduleSession({
          title: "Quick Batch Session",
          start: new Date().toISOString(),
          durationMins: 90,
          recipes: [],
          status: "in_progress",
        });
        session = (get().week.sessions || []).find((s) => s.id === newId);
        next = get();
      } else {
        session.status = "in_progress";
        next = { ...st, week: { ...st.week, sessions: [...st.week.sessions] } };
        recomputeToday(next);
        persist(next);
        set(next);
      }
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "start", session } }));
      return session?.id;
    },

    /** Mark a session done. */
    completeSession(id) {
      const st = get();
      const session = (st.week.sessions || []).find((s) => s.id === id);
      if (!session) return;
      session.status = "done";
      const next = { ...st, week: { ...st.week, sessions: [...st.week.sessions] } };
      recomputeToday(next);
      persist(next);
      set(next);
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "complete", session } }));
    },

    /** Cancel a session. */
    cancelSession(id) {
      const st = get();
      const session = (st.week.sessions || []).find((s) => s.id === id);
      if (!session) return;
      session.status = "canceled";
      const next = { ...st, week: { ...st.week, sessions: [...st.week.sessions] } };
      recomputeToday(next);
      persist(next);
      set(next);
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "cancel", session } }));
    },

    /** Move session to a new start time and/or duration. */
    moveSession(id, newStartIso, newDurationMins) {
      const st = get();
      const session = (st.week.sessions || []).find((s) => s.id === id);
      if (!session) return;
      session.start = newStartIso || session.start;

      const currentDur =
        (new Date(session.end).getTime() - new Date(session.start).getTime()) / 60000;
      const dur = mins(newDurationMins ?? currentDur, currentDur || 90);

      session.end = shiftIso(session.start, dur);
      const next = { ...st, week: { ...st.week, sessions: [...st.week.sessions] } };
      recomputeToday(next);
      persist(next);
      set(next);
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "move", session } }));
    },

    /** Nudge a session forward/backward by minutes (+/-). */
    nudgeSession(id, deltaMinutes = 15) {
      const st = get();
      const session = (st.week.sessions || []).find((s) => s.id === id);
      if (!session) return;
      const dur = (new Date(session.end).getTime() - new Date(session.start).getTime()) / 60000;
      session.start = shiftIso(session.start, deltaMinutes);
      session.end = shiftIso(session.start, dur);
      const next = { ...st, week: { ...st.week, sessions: [...st.week.sessions] } };
      recomputeToday(next);
      persist(next);
      set(next);
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "nudge", session, deltaMinutes } }));
    },

    /** Remove completed & canceled sessions older than N days (default 30). */
    clearOld(olderThanDays = 30) {
      const st = get();
      const cutoff = Date.now() - mins(olderThanDays, 30) * 24 * 60 * 60000;
      const keep = (st.week.sessions || []).filter((s) => {
        const done = s.status === "done" || s.status === "canceled";
        const endMs = +new Date(s.end || s.start);
        return !(done && endMs < cutoff);
      });
      const next = { ...st, week: { ...st.week, sessions: keep } };
      recomputeToday(next);
      persist(next);
      set(next);
      window.dispatchEvent(new CustomEvent("cooking:updated", { detail: { type: "clearOld" } }));
    },

    /** Count helpers used by KPIs and elsewhere (clickable cards). */
    count: {
      sessionsThisWeek() {
        const st = get();
        return (st.week.sessions || []).filter((s) => s.status !== "canceled").length;
      },
      scheduledThisWeek() {
        const st = get();
        return (st.week.sessions || []).filter((s) => s.status === "scheduled").length;
      },
      draftsThisWeek() {
        const st = get();
        return (st.week.sessions || []).filter((s) => s.status === "draft").length;
      },
      todaysSessions() {
        const st = get();
        return (st.today.sessions || []).filter((s) => s.status !== "canceled").length;
      },
      activeNow() {
        const now = new Date();
        const st = get();
        return (st.week.sessions || []).filter((s) => {
          const a = new Date(s.start);
          const b = new Date(s.end);
          return s.status !== "canceled" && a <= now && now <= b;
        }).length;
      },
    },

    /** Curated getters for KPI navigation targets. */
    list: {
      scheduledThisWeek() {
        const st = get();
        return (st.week.sessions || []).filter((s) => s.status === "scheduled");
      },
      draftsThisWeek() {
        const st = get();
        return (st.week.sessions || []).filter((s) => s.status === "draft");
      },
      today() {
        const st = get();
        return (st.today.sessions || []).filter((s) => s.status !== "canceled");
      },
    },
  };

  // Attach intent listeners (ergonomics; no navigation here)
  if (typeof window !== "undefined") {
    const onIntent = (e) => {
      const { intent, ...detail } = e?.detail || {};
      if (!intent) return;

      switch (intent) {
        case "batch/start": {
          api.startSession(detail?.id);
          break;
        }
        case "cooking/schedule/add": {
          api.scheduleSession({
            title: detail?.title,
            start: detail?.start || new Date().toISOString(),
            durationMins: detail?.durationMins ?? 90,
            recipes: detail?.recipes || [],
            notes: detail?.notes || "",
            labelTemplate: detail?.labelTemplate,
            safetyTimers: detail?.safetyTimers,
          });
          break;
        }
        case "cooking/draft/new": {
          api.createDraft({
            title: detail?.title,
            start: detail?.start || new Date().toISOString(),
            durationMins: detail?.durationMins ?? 90,
            recipes: detail?.recipes || [],
            notes: detail?.notes || "",
            labelTemplate: detail?.labelTemplate,
            safetyTimers: detail?.safetyTimers,
          });
          break;
        }
        case "cooking/draft/approve": {
          if (detail?.id) api.approveDraft(detail.id, { scheduleAtIso: detail?.start, durationMins: detail?.durationMins });
          break;
        }
        case "cooking/session/complete": {
          if (detail?.id) api.completeSession(detail.id);
          break;
        }
        case "cooking/session/cancel": {
          if (detail?.id) api.cancelSession(detail.id);
          break;
        }
        case "cooking/session/nudge": {
          if (detail?.id) api.nudgeSession(detail.id, detail?.deltaMinutes ?? 15);
          break;
        }
        case "cooking/capacity/set": {
          api.setCapacity(detail?.capacity || {});
          break;
        }
        default:
          // ignore other intents
          break;
      }
    };
    // Avoid duplicate listeners across HMR
    try {
      window.removeEventListener("automation:intent", onIntent);
      window.addEventListener("automation:intent", onIntent);
    } catch {
      /* noop */
    }
  }

  return { ...init, ...api };
});

/* ----------------------------- External Helpers --------------------------- */

export const Cooking = {
  get state() {
    return useCooking.getState();
  },
  setCapacity: (cap) => useCooking.getState().setCapacity(cap),
  createDraft: (opts) => useCooking.getState().createDraft(opts),
  approveDraft: (id, opts) => useCooking.getState().approveDraft(id, opts),
  schedule: (opts) => useCooking.getState().scheduleSession(opts),
  start: (id) => useCooking.getState().startSession(id),
  complete: (id) => useCooking.getState().completeSession(id),
  cancel: (id) => useCooking.getState().cancelSession(id),
  move: (id, startIso, dur) => useCooking.getState().moveSession(id, startIso, dur),
  nudge: (id, deltaMins) => useCooking.getState().nudgeSession(id, deltaMins),
  countThisWeek: () => useCooking.getState().count.sessionsThisWeek(),
  countScheduledThisWeek: () => useCooking.getState().count.scheduledThisWeek(),
  countDraftsThisWeek: () => useCooking.getState().count.draftsThisWeek(),
  listScheduledThisWeek: () => useCooking.getState().list.scheduledThisWeek(),
  listDraftsThisWeek: () => useCooking.getState().list.draftsThisWeek(),
  listToday: () => useCooking.getState().list.today(),
};

// On initial load, ensure the week anchor is current and persist.
try {
  useCooking.getState().ensureWeek(new Date());
  persist(useCooking.getState());
} catch {
  /* ignore on SSR */
}

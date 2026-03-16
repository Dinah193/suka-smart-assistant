// src/services/sharing/familySharingService.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Family Sharing & Goals Service (+ Operational Forecast Auto-Share)
 * ----------------------------------------------------------------------------------------
 * Families (circles), shares, goals, milestones, tasks, sessions, and automatic
 * operational forecast digests (garden/animals/cleaning/cooking) for the agrarian(s).
 *
 * v3 Enhancements:
 *  - Per-family channels: email / push / inapp / sms + recipients override
 *  - Timezone-aware quiet hours, Sabbath Guard, min-interval per cause
 *  - Content de-dup per cause + normalized windows/signals
 *  - “Preview & resend” (idempotent) + share links for read-only digest
 *  - Safer adapters: graceful fallbacks; consolidated event names
 *  - Migration v2->v3 (keeps state)
 */

import {
  events,
  NAMES,
  buildEvent,
  emitEvent,
} from "@/services/events/contracts";

import { guardSabbathAction } from "@/services/integration/torahProfileHooks";
import { ask, emit as busEmit } from "@/services/events/eventBus";

let PreferencesStore;
try {
  ({ usePreferencesStore: PreferencesStore } = await import(
    "@/store/PreferencesStore"
  ));
} catch {}

const STORAGE_KEY = "suka.family.ops.v3";
const SCHEMA_VERSION = 3;

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowISO = () => new Date().toISOString();
const isStr = (v) => typeof v === "string" && v.length > 0;
const isNum = (v) => Number.isFinite(v);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

/* ──────────────────────────────────────────────────────────────
 * Defaults (v3 adds channels + causeIntervals + tz)
 * ────────────────────────────────────────────────────────────── */
const DEFAULT = Object.freeze({
  __v: SCHEMA_VERSION,
  families: [], // [{ id, name, householdIds[], ownerId, createdAt, members:[{id,email,role,name?}] }]
  familySettings: {}, // { [familyId]: { autoShare:true, quietStart:"22:00", quietEnd:"06:00", tz?:string, minIntervalMins:180, causeIntervals?:{[cause]:mins}, channels:{email:true,push:true,inapp:true,sms:false}, recipientsOverride?:email[] } }
  shares: [], // [{ id, familyId, scope, refId, title, permissions, meta, createdAt }]
  goals: [], // [{ id, familyId, title, description, categories[], ownerId, createdAt, updatedAt, progress, progressMode, householdIds[], links[], archived }]
  milestones: [], // [{ id, goalId, title, due, weight, completedAt }]
  tasks: [], // [{ id, goalId, milestoneId?, title, ownerId?, due?, weight, done, notes? }]
  sessions: [], // [{ id, familyId, goalId?, title, startISO, endISO, agenda, createdAt }]
  messages: [], // [{ id, familyId, type:'ops-forecast', payload, recipients:[{email,name}], channels:{...}, createdAt, shareToken? }]
  _lastDigestAt: {}, // { [familyId]: ISO }
  _lastDigestHash: {}, // { [familyId]: "hash" }          // last general hash (any cause)
  _causeHash: {}, // { [familyId]: { cause: "hash" }} // per-cause hash to prevent duplicates
});

/* ──────────────────────────────────────────────────────────────
 * Storage / Migration
 * ────────────────────────────────────────────────────────────── */
const storage = {
  load() {
    try {
      const raw =
        localStorage.getItem(STORAGE_KEY) ||
        localStorage.getItem("suka.family.ops.v2");
      const parsed = raw ? JSON.parse(raw) : null;
      return migrate(parsed) || { ...DEFAULT };
    } catch {
      return { ...DEFAULT };
    }
  },
  save(d) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
    } catch (e) {
      console.warn("[familySharing] storage save error", e);
    }
  },
};

function migrate(data) {
  if (!data) return null;
  if (data.__v === SCHEMA_VERSION) return data;

  // v2 -> v3: add channels, causeIntervals, tz, _causeHash
  const next = { ...DEFAULT, ...data };
  next.familySettings = next.familySettings || {};
  for (const fid of Object.keys(next.familySettings)) {
    next.familySettings[fid] = {
      autoShare: true,
      quietStart: "22:00",
      quietEnd: "06:00",
      minIntervalMins: 180,
      channels: { email: true, push: true, inapp: true, sms: false },
      causeIntervals: {},
      tz: next.familySettings[fid]?.tz || getTZ(),
      recipientsOverride: null,
      ...next.familySettings[fid],
    };
  }
  next._causeHash = next._causeHash || {};
  next.__v = SCHEMA_VERSION;
  return next;
}

function withState(mutator) {
  const s = storage.load();
  const snapshot = JSON.parse(JSON.stringify(s));
  const result = mutator(s);
  storage.save(s);
  return { result, undo: () => storage.save(snapshot) };
}

function getState() {
  return storage.load();
}
const getTZ = () =>
  PreferencesStore?.getState?.()?.calendar?.timezone ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  "UTC";

/* ──────────────────────────────────────────────────────────────
 * Design-system glue
 * ────────────────────────────────────────────────────────────── */
function toast(variant, title, message) {
  events.emit(
    buildEvent(
      NAMES["ui.toast.shown"],
      { variant, title, message },
      { source: "familySharing" }
    )
  );
}
function nba(label, hint, route, params) {
  events.emit(
    buildEvent(
      NAMES["ui.nba.suggested"],
      { label, hint, route, params },
      { source: "familySharing" }
    )
  );
}
function empty(context, actions = []) {
  events.emit(
    buildEvent(
      NAMES["ui.empty.presented"],
      { context, actions },
      { source: "familySharing" }
    )
  );
}

/* ──────────────────────────────────────────────────────────────
 * Helpers (roles, progress, formatting, hashing, time windows)
 * ────────────────────────────────────────────────────────────── */
function getFamily(state, familyId) {
  return state.families.find((f) => f.id === familyId);
}
function findAgrarians(family) {
  const m = Array.isArray(family?.members) ? family.members : [];
  return m.filter((x) => (x.role || "").toLowerCase() === "agrarian");
}
function computeProgress(state, goalId) {
  const tasks = state.tasks.filter((t) => t.goalId === goalId);
  const mils = state.milestones.filter((m) => m.goalId === goalId);
  let total = 0,
    done = 0;
  for (const t of tasks) {
    const w = isNum(t.weight) ? t.weight : 1;
    total += w;
    if (t.done) done += w;
  }
  for (const m of mils) {
    const w = isNum(m.weight) ? m.weight : 1;
    total += w;
    if (m.completedAt) done += w;
  }
  return total === 0 ? 0 : Math.round((done / total) * 100);
}
function htmlEscape(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function hashDigest(obj) {
  const str = JSON.stringify(obj);
  let h = 0,
    i = 0,
    len = str.length;
  while (i < len) {
    h = ((h << 5) - h + str.charCodeAt(i++)) | 0;
  }
  return `h${(h >>> 0).toString(36)}`;
}
function inQuietHours(settings) {
  const tz = settings?.tz || getTZ();
  const now = new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const toMin = (t) => {
    const [hh, mm] = String(t || "")
      .split(":")
      .map(Number);
    return (Number(hh) || 0) * 60 + (Number(mm) || 0);
  };
  const curMins = local.getHours() * 60 + local.getMinutes();
  const startM = toMin(settings?.quietStart || "22:00");
  const endM = toMin(settings?.quietEnd || "06:00");
  return startM <= endM
    ? curMins >= startM && curMins <= endM
    : curMins >= startM || curMins <= endM;
}

/* ──────────────────────────────────────────────────────────────
 * Family Circles
 * ────────────────────────────────────────────────────────────── */
export function createFamilyCircle(
  name,
  householdIds = [],
  { ownerId = "me", members = [] } = {}
) {
  if (!isStr(name) || !Array.isArray(householdIds)) {
    empty("family.circle.empty", [
      {
        label: "Create Family Circle",
        eventName: NAMES["ui.modal.open"],
        payload: { id: "createFamilyCircle" },
      },
    ]);
    return null;
  }

  const { result: fam, undo } = withState((s) => {
    const fam = {
      id: uid(),
      name,
      householdIds,
      ownerId,
      createdAt: nowISO(),
      members,
    };
    s.families.unshift(fam);
    // default settings for this family (v3)
    s.familySettings[fam.id] = {
      autoShare: true,
      quietStart: "22:00",
      quietEnd: "06:00",
      tz: getTZ(),
      minIntervalMins: 180,
      causeIntervals: {}, // per-cause throttle
      recipientsOverride: null,
      channels: { email: true, push: true, inapp: true, sms: false },
    };
    return fam;
  });

  emitEvent(
    "family.circle.created",
    { familyId: fam.id, householdIds, members },
    {
      source: "familySharing.createFamilyCircle",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Circle removed", "Undo successful.");
        },
      },
      nextBestAction: {
        label: "Share Something",
        hint: "Start sharing with family",
        route: "/family",
        params: { familyId: fam.id, tab: "share" },
      },
    }
  );

  if (findAgrarians(fam).length) {
    nba("Enable Ops Forecasts", "We’ll auto-share support plans", "/family", {
      familyId: fam.id,
      tab: "settings",
    });
  }

  toast("success", "Family Circle created", name);
  return fam;
}

export function deleteFamilyCircle(familyId) {
  const state = getState();
  const fam = state.families.find((f) => f.id === familyId);
  if (!fam) return false;

  const { undo } = withState((s) => {
    s.families = s.families.filter((f) => f.id !== familyId);
    s.shares = s.shares.filter((sh) => sh.familyId !== familyId);
    s.goals = s.goals.filter((g) => g.familyId !== familyId);
    s.sessions = s.sessions.filter((ss) => ss.familyId !== familyId);
    s.messages = s.messages.filter((m) => m.familyId !== familyId);
    delete s.familySettings[familyId];
    delete s._lastDigestAt[familyId];
    delete s._lastDigestHash[familyId];
    delete s._causeHash[familyId];
  });

  emitEvent(
    "family.circle.deleted",
    { familyId },
    {
      source: "familySharing.deleteFamilyCircle",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Family Circle restored", "Undo successful.");
        },
      },
      nextBestAction: {
        label: "Create New Circle",
        hint: "Start fresh",
        route: "/family#create",
      },
    }
  );

  toast("warning", "Family Circle deleted", "");
  return true;
}

/* ──────────────────────────────────────────────────────────────
 * Per-family Settings
 * ────────────────────────────────────────────────────────────── */
export function getFamilySettings(familyId) {
  const s = getState();
  return s.familySettings[familyId] || null;
}

export function updateFamilySettings(familyId, partial = {}) {
  const { undo, result } = withState((s) => {
    s.familySettings[familyId] = {
      ...(s.familySettings[familyId] || {}),
      ...partial,
      tz: partial.tz || s.familySettings[familyId]?.tz || getTZ(),
      channels: {
        email: true,
        push: true,
        inapp: true,
        sms: false,
        ...(s.familySettings[familyId]?.channels || {}),
        ...(partial.channels || {}),
      },
      causeIntervals: {
        ...(s.familySettings[familyId]?.causeIntervals || {}),
        ...(partial.causeIntervals || {}),
      },
      minIntervalMins: clamp(
        Number(
          partial.minIntervalMins ??
            s.familySettings[familyId]?.minIntervalMins ??
            180
        ),
        15,
        1440
      ),
    };
    return s.familySettings[familyId];
  });

  emitEvent(
    "family.settings.updated",
    { familyId, settings: result },
    {
      source: "familySharing.updateFamilySettings",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Settings reverted", "Undo successful.");
        },
      },
    }
  );

  toast("success", "Family settings updated", "");
  return result;
}

/* ──────────────────────────────────────────────────────────────
 * Shares (family-level)
 * ────────────────────────────────────────────────────────────── */
const ALLOWED_SCOPES = new Set([
  "meals",
  "recipes",
  "inventory",
  "garden",
  "cleaning",
  "animals",
  "storehouse",
  "waste",
  "preservation",
  "procurement",
  "calendar",
  "mealplan",
  "labels",
  "soilWater",
  "cooking",
]);

export function shareToFamily(
  familyId,
  { scope, refId, title, permissions = "view", meta = {} }
) {
  if (!ALLOWED_SCOPES.has(scope)) {
    toast("warning", "Not shareable", "This category is not enabled.");
    return null;
  }
  const s = getState();
  const fam = getFamily(s, familyId);
  if (!fam) return null;

  const { result: sh, undo } = withState((state) => {
    const sh = {
      id: uid(),
      familyId,
      scope,
      refId,
      title: title || refId,
      permissions,
      meta,
      createdAt: nowISO(),
    };
    state.shares.unshift(sh);
    return sh;
  });

  emitEvent(
    "family.share.created",
    { shareId: sh.id, familyId, scope },
    {
      source: "familySharing.shareToFamily",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Share removed", "Undo successful.");
        },
      },
      nextBestAction: {
        label: "Create Goal",
        hint: "Turn this into a family plan",
        route: "/family",
        params: { familyId, tab: "goals" },
      },
    }
  );

  if (
    ["garden", "animals", "cleaning", "cooking"].includes(scope) &&
    findAgrarians(fam).length
  ) {
    autoShareOpsForecast(familyId, { cause: "share.created", scopes: [scope] });
  }

  toast("success", "Shared", `${title} with family circle`);
  return sh;
}

/* ──────────────────────────────────────────────────────────────
 * Goals / Milestones / Tasks (unchanged logic, minor polish)
 * ────────────────────────────────────────────────────────────── */
export function createFamilyGoal(
  familyId,
  {
    title,
    description = "",
    categories = [],
    ownerId = "me",
    householdIds = [],
    progressMode = "auto",
  } = {}
) {
  if (!isStr(title)) return null;

  const { result: g, undo } = withState((s) => {
    const g = {
      id: uid(),
      familyId,
      title,
      description,
      categories: Array.from(new Set(categories)),
      ownerId,
      householdIds,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      progress: 0,
      progressMode: progressMode === "manual" ? "manual" : "auto",
      links: [],
      archived: false,
    };
    s.goals.unshift(g);
    return g;
  });

  emitEvent(
    "family.goal.created",
    { goalId: g.id, familyId },
    {
      source: "familySharing.createFamilyGoal",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Goal removed", "Undo successful.");
        },
      },
      nextBestAction: {
        label: "Add Milestones",
        hint: "Break it into steps",
        route: "/family",
        params: { familyId, goalId: g.id, tab: "milestones" },
      },
    }
  );

  const fam = getFamily(getState(), familyId);
  const cat = g.categories.map((c) => (c + "").toLowerCase());
  if (
    fam &&
    findAgrarians(fam).length &&
    cat.some((x) =>
      ["garden", "animals", "cleaning", "cooking", "soilwater"].includes(x)
    )
  ) {
    autoShareOpsForecast(familyId, {
      cause: "goal.created",
      goalId: g.id,
      scopes: g.categories,
    });
  }

  toast("success", "Family Goal created", title);
  return g;
}

export function updateFamilyGoal(goalId, partial = {}) {
  const { result: updated, undo } = withState((s) => {
    const g = s.goals.find((x) => x.id === goalId);
    if (!g) return null;
    const prev = { ...g };
    Object.assign(g, partial, { updatedAt: nowISO() });
    if (g.progressMode === "auto") g.progress = computeProgress(s, goalId);
    return { g, prev };
  });

  if (!updated) return null;

  const { g, prev } = updated;

  emitEvent(
    "family.goal.updated",
    { goalId: g.id, familyId: g.familyId },
    {
      source: "familySharing.updateFamilyGoal",
      undo: {
        label: "Undo",
        handler: () => {
          withState((s) => {
            const gg = s.goals.find((x) => x.id === g.id);
            if (gg) Object.assign(gg, prev);
          });
          toast("info", "Goal reverted", "Undo successful.");
        },
      },
    }
  );

  const fam = getFamily(getState(), g.familyId);
  const cat = (g.categories || []).map((c) => (c + "").toLowerCase());
  if (
    fam &&
    findAgrarians(fam).length &&
    cat.some((x) =>
      ["garden", "animals", "cleaning", "cooking", "soilwater"].includes(x)
    )
  ) {
    autoShareOpsForecast(g.familyId, { cause: "goal.updated", goalId });
  }

  toast("success", "Goal updated", "");
  return g;
}

export function addMilestone(goalId, { title, due, weight = 1 } = {}) {
  if (!isStr(title)) return null;

  const { result: payload, undo } = withState((s) => {
    const m = {
      id: uid(),
      goalId,
      title,
      due: due || null,
      weight: Number(weight) || 1,
      createdAt: nowISO(),
      completedAt: null,
    };
    s.milestones.push(m);
    const g = s.goals.find((x) => x.id === goalId);
    if (g && g.progressMode === "auto") g.progress = computeProgress(s, goalId);
    g && (g.updatedAt = nowISO());
    return { m, gId: g?.id, famId: g?.familyId, cats: g?.categories || [] };
  });

  emitEvent(
    "family.milestone.added",
    { goalId, milestoneId: payload.m.id, familyId: payload.famId },
    {
      source: "familySharing.addMilestone",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Milestone removed", "Addition undone.");
        },
      },
      nextBestAction: {
        label: "Add Tasks",
        hint: "What steps make this real?",
        route: "/family",
        params: { tab: "goals", goalId },
      },
    }
  );

  const fam = getFamily(getState(), payload.famId);
  if (
    fam &&
    findAgrarians(fam).length &&
    (payload.cats || []).some((c) =>
      ["garden", "animals", "cleaning", "cooking", "soilWater"].includes(c + "")
    )
  ) {
    autoShareOpsForecast(payload.famId, { cause: "milestone.added", goalId });
  }

  toast("success", "Milestone added", title);
  return payload.m;
}

export function completeMilestone(milestoneId, done = true) {
  const { result: payload, undo } = withState((s) => {
    const m = s.milestones.find((x) => x.id === milestoneId);
    if (!m) return null;
    const prev = m.completedAt;
    m.completedAt = done ? nowISO() : null;
    const g = s.goals.find((x) => x.id === m.goalId);
    if (g && g.progressMode === "auto") g.progress = computeProgress(s, g.id);
    g && (g.updatedAt = nowISO());
    return { m, g, prev };
  });
  if (!payload) return null;

  emitEvent(
    "family.milestone.completed",
    {
      milestoneId,
      goalId: payload.m.goalId,
      familyId: payload.g?.familyId,
      done,
    },
    {
      source: "familySharing.completeMilestone",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Milestone reverted", "Completion undone.");
        },
      },
      nextBestAction: {
        label: "Plan Session",
        hint: "Coordinate the next push",
        route: "/family",
        params: { tab: "sessions", goalId: payload.m.goalId },
      },
    }
  );

  const fam = getFamily(getState(), payload.g?.familyId);
  if (fam && findAgrarians(fam).length)
    autoShareOpsForecast(payload.g.familyId, {
      cause: "milestone.completed",
      goalId: payload.g.id,
    });

  toast("success", done ? "Milestone completed" : "Marked incomplete", "");
  return payload.m;
}

export function addTask(
  goalId,
  {
    title,
    ownerId = null,
    due = null,
    weight = 1,
    milestoneId = null,
    notes = "",
  } = {}
) {
  if (!isStr(title)) return null;

  const { result: payload, undo } = withState((s) => {
    const t = {
      id: uid(),
      goalId,
      milestoneId,
      title,
      ownerId,
      due,
      weight: Number(weight) || 1,
      done: false,
      notes,
    };
    s.tasks.push(t);
    const g = s.goals.find((x) => x.id === goalId);
    if (g && g.progressMode === "auto") g.progress = computeProgress(s, goalId);
    g && (g.updatedAt = nowISO());
    return { t, gId: g?.id, famId: g?.familyId, cats: g?.categories || [] };
  });

  emitEvent(
    "family.task.added",
    { taskId: payload.t.id, goalId, familyId: payload.famId },
    {
      source: "familySharing.addTask",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Task removed", "Addition undone.");
        },
      },
    }
  );

  const fam = getFamily(getState(), payload.famId);
  if (
    fam &&
    findAgrarians(fam).length &&
    (payload.cats || []).some((c) =>
      ["garden", "animals", "cleaning", "cooking", "soilWater"].includes(c + "")
    )
  ) {
    autoShareOpsForecast(payload.famId, { cause: "task.added", goalId });
  }

  toast("success", "Task added", title);
  return payload.t;
}

export function toggleTask(taskId, done = true) {
  const { result: payload, undo } = withState((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    const prev = t.done;
    t.done = !!done;
    const g = s.goals.find((x) => x.id === t.goalId);
    if (g && g.progressMode === "auto") g.progress = computeProgress(s, g.id);
    g && (g.updatedAt = nowISO());
    return { t, g, prev };
  });
  if (!payload) return null;

  emitEvent(
    "family.task.toggled",
    { taskId, goalId: payload.t.goalId, familyId: payload.g?.familyId, done },
    {
      source: "familySharing.toggleTask",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Task reverted", "Completion undone.");
        },
      },
      nextBestAction: done
        ? {
            label: "Review Progress",
            hint: "See the updated %",
            route: "/family",
            params: { tab: "goals", goalId: payload.t.goalId },
          }
        : undefined,
    }
  );

  toast("success", done ? "Task completed" : "Marked incomplete", "");
  return payload.t;
}

export function updateTask(taskId, partial = {}) {
  const { result: payload, undo } = withState((s) => {
    const t = s.tasks.find((x) => x.id === taskId);
    if (!t) return null;
    const prev = { ...t };
    Object.assign(t, partial);
    const g = s.goals.find((x) => x.id === t.goalId);
    if (g && g.progressMode === "auto") g.progress = computeProgress(s, g.id);
    g && (g.updatedAt = nowISO());
    return { t, prev, familyId: g?.familyId };
  });
  if (!payload) return null;

  emitEvent(
    "family.task.updated",
    { taskId, goalId: payload.t.goalId, familyId: payload.familyId },
    {
      source: "familySharing.updateTask",
      undo: {
        label: "Undo",
        handler: () => {
          withState((s) => {
            const tt = s.tasks.find((y) => y.id === taskId);
            if (tt) Object.assign(tt, payload.prev);
          });
          toast("info", "Task restored", "Changes undone.");
        },
      },
    }
  );

  toast("success", "Task updated", "Changes saved.");
  return payload.t;
}

/* ──────────────────────────────────────────────────────────────
 * Planning Sessions
 * ────────────────────────────────────────────────────────────── */
export function scheduleFamilySession(
  familyId,
  {
    goalId = null,
    title = "Family Planning Session",
    startISO,
    endISO,
    agenda = "",
  } = {}
) {
  if (!isStr(startISO) || !isStr(endISO)) return null;

  const { result: sess, undo } = withState((s) => {
    const sess = {
      id: uid(),
      familyId,
      goalId,
      title,
      startISO,
      endISO,
      agenda,
      createdAt: nowISO(),
    };
    s.sessions.push(sess);
    return sess;
  });

  emitEvent(
    NAMES["calendar.add"] || "calendar/add",
    { title, startISO, endISO, attendees: [], meta: { familyId, goalId } },
    {
      source: "familySharing.scheduleFamilySession",
      nextBestAction: {
        label: "Open Calendar",
        hint: "Sync session",
        route: "/calendar",
      },
    }
  );

  emitEvent(
    "family.session.scheduled",
    { sessionId: sess.id, familyId, goalId },
    {
      source: "familySharing.scheduleFamilySession",
      undo: {
        label: "Undo",
        handler: () => {
          undo();
          toast("info", "Session removed", "Undo successful.");
        },
      },
    }
  );

  autoShareOpsForecast(familyId, { cause: "session.scheduled", goalId });
  toast(
    "success",
    "Family Session scheduled",
    new Date(startISO).toLocaleString()
  );
  return sess;
}

/* ──────────────────────────────────────────────────────────────
 * Operational Forecast Auto-Share (background)
 * ────────────────────────────────────────────────────────────── */
function buildOpsWindows(state, familyId) {
  const now = Date.now();
  const asISO = (ms) => new Date(ms).toISOString();

  const goals = state.goals.filter(
    (g) => g.familyId === familyId && !g.archived
  );
  const goalIds = goals.map((g) => g.id);
  const milestones = state.milestones.filter(
    (m) => goalIds.includes(m.goalId) && m.due
  );
  const sessions = state.sessions.filter((s) => s.familyId === familyId);
  const windows = [];

  for (const m of milestones) {
    const due = new Date(m.due).getTime();
    const start = Math.min(now, due - 2 * 24 * 3600 * 1000);
    windows.push({ startISO: asISO(start), days: 5, reason: "milestone" });
  }
  for (const s of sessions) {
    const ts = new Date(s.startISO).getTime();
    windows.push({
      startISO: asISO(ts - 1 * 24 * 3600 * 1000),
      days: 4,
      reason: "session",
    });
  }
  if (
    !windows.length &&
    (goals.length || state.shares.some((sh) => sh.familyId === familyId))
  ) {
    windows.push({ startISO: asISO(now), days: 7, reason: "weekly" });
  }

  // Normalize for hashing (day bucket only)
  return windows.slice(0, 3).map((w) => ({
    startISO:
      new Date(w.startISO).toISOString().slice(0, 10) + "T00:00:00.000Z",
    days: w.days,
    reason: w.reason,
  }));
}

function buildSignals(state, familyId) {
  const shares = state.shares.filter((s) => s.familyId === familyId);
  return {
    meals: shares.filter((s) => ["meals", "mealplan"].includes(s.scope)).length,
    cookingSessions: shares.filter((s) => s.scope === "cooking").length,
    cleaningRoutines: shares.filter((s) => s.scope === "cleaning").length,
    gardenPlans: shares.filter((s) => s.scope === "garden").length,
    animalPlans: shares.filter((s) => s.scope === "animals").length,
    preservation: shares.filter((s) => s.scope === "preservation").length,
    inventory: shares.filter((s) => s.scope === "inventory").length,
  };
}

function composeOpsDigest(responses = [], windows = [], familyName = "Family") {
  const css = `
    <style>
      :root{--line:#e5e7eb;--muted:#667085;--fg:#0b1220;--card:#fff}
      body{margin:0;background:#fafafa;font:13px/1.45 system-ui,-apple-system,Segoe UI,Roboto}
      .page{max-width:860px;margin:16px auto;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
      h2{margin:0 0 6px;font-size:18px}
      .muted{color:var(--muted);margin:2px 0 12px}
      .sec{border:1px solid var(--line);border-radius:10px;padding:12px;margin:12px 0;background:#fff}
      .item{display:flex;gap:10px;padding:8px 0;border-bottom:1px dashed var(--line)}
      .item:last-child{border-bottom:none}
      .date{font-weight:600;white-space:nowrap}
      .title{flex:1}
      .chip{border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-size:11px;margin-left:6px}
      footer{margin-top:12px;color:var(--muted);font-size:12px}
      a.button{display:inline-block;margin-top:8px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;text-decoration:none;color:#0b1220}
    </style>`;
  const winTxt =
    windows
      .map((w) => `${new Date(w.startISO).toLocaleDateString()} • ${w.days}d`)
      .join(" • ") || "upcoming week";
  const sectionOrder = ["garden", "animals", "cleaning", "cooking"];
  const map = new Map();
  for (const r of responses) {
    const key = (r?.section || "").toLowerCase();
    if (!map.has(key)) map.set(key, []);
    (r?.items || []).forEach((it) => map.get(key).push(it));
  }
  const renderItems = (arr = []) =>
    arr
      .slice(0, 30)
      .map((it) => {
        const date = it.date ? new Date(it.date).toLocaleDateString() : "—";
        const title = htmlEscape(it.title || "Task");
        const det = it.detail
          ? ` <span class="muted">• ${htmlEscape(it.detail)}</span>`
          : "";
        const qty =
          it.qty != null
            ? ` <span class="chip">${htmlEscape(String(it.qty))}${
                it.unit ? " " + htmlEscape(it.unit) : ""
              }</span>`
            : "";
        const pr = it.priority
          ? ` <span class="chip">${htmlEscape(String(it.priority))}</span>`
          : "";
        const bl =
          Array.isArray(it.blockers) && it.blockers.length
            ? ` <span class="muted"> — Blockers: ${htmlEscape(
                it.blockers.join(", ")
              )}</span>`
            : "";
        return `<div class="item"><div class="date">${date}</div><div class="title">${title}${det}${qty}${pr}${bl}</div></div>`;
      })
      .join("");

  const secHtml = sectionOrder
    .map((sec) => {
      const items = map.get(sec) || [];
      if (!items.length) return "";
      const title = sec.charAt(0).toUpperCase() + sec.slice(1);
      return `<div class="sec"><h3>${title}</h3>${renderItems(items)}</div>`;
    })
    .join("");

  return `<!doctype html><meta charset="utf-8"><body>
    ${css}
    <article class="page">
      <h2>${htmlEscape(familyName)} • Operational Forecast</h2>
      <p class="muted">Windows: ${htmlEscape(
        winTxt
      )} • Sections: Garden, Animals, Cleaning, Cooking</p>
      ${
        secHtml ||
        `<div class="sec"><div class="item"><div class="title">No forecasted items.</div></div></div>`
      }
      <footer>Generated ${new Date().toLocaleString()} • Suka Smart Assistant</footer>
    </article>
  </body>`;
}

function toPlainText(html = "") {
  // Minimal HTML → text for SMS; keeps bullets & important bits
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(h\d|p|div|li|br)>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ──────────────────────────────────────────────────────────────
 * Rate/Quiet/Sabbath gating
 * ────────────────────────────────────────────────────────────── */
async function shouldShareNow(familyId, cause = "auto") {
  const s = getState();
  const fam = getFamily(s, familyId);
  if (!fam) return { ok: false, reason: "no-family" };

  const settings = s.familySettings[familyId] || {};
  if (settings.autoShare === false) return { ok: false, reason: "disabled" };

  try {
    const allowed = await guardSabbathAction?.("share.opsForecast");
    if (allowed === false) return { ok: false, reason: "sabbath" };
  } catch {
    /* ignore */
  }

  if (inQuietHours(settings)) return { ok: false, reason: "quiet-hours" };

  // Global min interval
  const last = s._lastDigestAt[familyId]
    ? new Date(s._lastDigestAt[familyId]).getTime()
    : 0;
  const mins = clamp(Number(settings.minIntervalMins || 180), 15, 1440);
  if (Date.now() - last < mins * 60 * 1000)
    return { ok: false, reason: "rate-limit" };

  // Per-cause interval (if configured)
  const causeMins = clamp(
    Number(settings.causeIntervals?.[cause] || 0),
    0,
    10080
  ); // up to 7 days
  if (causeMins > 0) {
    const lastHashTime = s._lastDigestAt[`${familyId}:${cause}`]
      ? new Date(s._lastDigestAt[`${familyId}:${cause}`]).getTime()
      : 0;
    if (Date.now() - lastHashTime < causeMins * 60000)
      return { ok: false, reason: "cause-rate-limit" };
  }

  return { ok: true, reason: "ok" };
}

/* ──────────────────────────────────────────────────────────────
 * Digest sending: channels + dedup + events
 * ────────────────────────────────────────────────────────────── */
function resolveRecipients(fam, settings) {
  const base = settings.recipientsOverride?.length
    ? settings.recipientsOverride.map((email) => ({ email, name: email }))
    : findAgrarians(fam);
  return base.filter((x) => x?.email);
}

function sendViaChannels({ msg, html, text }) {
  const channels = msg.channels || {
    email: true,
    push: true,
    inapp: true,
    sms: false,
  };
  const baseMeta = {
    familyId: msg.familyId,
    messageId: msg.id,
    kind: "ops-forecast",
  };

  if (channels.email) {
    busEmit("notifications/send", {
      type: "email",
      recipients: msg.recipients,
      subject: "Operational Forecast Digest",
      html,
      meta: baseMeta,
    });
  }
  if (channels.push) {
    busEmit("notifications/send", {
      type: "push",
      recipients: msg.recipients,
      title: "Operational Forecast",
      body: "Your digest is ready.",
      meta: baseMeta,
    });
  }
  if (channels.inapp) {
    busEmit("notifications/send", {
      type: "inapp",
      recipients: msg.recipients,
      title: "Operational Forecast",
      html,
      meta: baseMeta,
    });
  }
  if (channels.sms) {
    const smsTo = msg.recipients
      .filter((r) => r.phone)
      .map((r) => ({ to: r.phone, name: r.name || r.email }));
    if (smsTo.length) {
      busEmit("notifications/send", {
        type: "sms",
        recipients: smsTo,
        text,
        meta: baseMeta,
      });
    }
  }
}

/**
 * Ask domain forecasters and auto-share digest to agrarian(s).
 * It’s okay if some providers aren’t installed; we include the ones that respond.
 */
export async function autoShareOpsForecast(
  familyId,
  { cause = "auto", goalId = null, scopes = [] } = {}
) {
  const s = getState();
  const fam = getFamily(s, familyId);
  if (!fam) return;

  const settings = s.familySettings[familyId] || {};
  const agrarians = resolveRecipients(fam, settings);
  if (!agrarians.length) return;

  const gate = await shouldShareNow(familyId, cause);
  if (!gate.ok) {
    events.emit(
      buildEvent(
        "family.opsForecast.skipped",
        { familyId, reason: gate.reason },
        { source: "familySharing" }
      )
    );
    return;
  }

  const windows = buildOpsWindows(s, familyId);
  if (!windows.length) return;

  const signals = buildSignals(s, familyId);
  const payload = {
    familyId,
    householdIds: fam.householdIds || [],
    windows,
    signals,
    scopes,
    cause,
  };

  const reqs = [
    ask("forecast/garden", payload, 12000).catch(() => null),
    ask("forecast/animals", payload, 12000).catch(() => null),
    ask("forecast/cleaning", payload, 12000).catch(() => null),
    ask("forecast/cooking", payload, 12000).catch(() => null),
  ];

  let responses = [];
  try {
    responses = (await Promise.all(reqs)).filter(Boolean);
  } catch {
    responses = [];
  }
  if (!responses.length) {
    toast(
      "info",
      "No operational forecasters connected",
      "Enable domain forecasters to power agrarian digests."
    );
    return;
  }

  // Normalized hash: use day-bucketed windows & simplified responses
  const compact = responses.map((r) => ({
    section: r.section,
    count: (r.items || []).length,
  }));
  const digestBody = {
    windows,
    signals,
    famName: fam.name || "Family",
    cause,
    compact,
  };
  const digestHash = hashDigest(digestBody);

  // Per-cause de-dup
  const cHash = s._causeHash[familyId] || {};
  if (cHash[cause] === digestHash) {
    events.emit(
      buildEvent(
        "family.opsForecast.duplicate",
        { familyId, cause },
        { source: "familySharing" }
      )
    );
    return;
  }

  const html = composeOpsDigest(responses, windows, fam.name || "Family");
  const text = toPlainText(html);

  const msg = {
    id: uid(),
    familyId,
    type: "ops-forecast",
    payload: {
      html,
      windows,
      signals,
      cause,
      goalId,
      scopes,
      sections: responses.map((r) => r.section),
    },
    recipients: agrarians.map((a) => ({
      email: a.email,
      name: a.name || a.email,
      phone: a.phone,
    })),
    channels: settings.channels || {
      email: true,
      push: true,
      inapp: true,
      sms: false,
    },
    createdAt: nowISO(),
    shareToken: `sh_${uid()}`, // simple opaque token for read-only link
  };

  withState((state) => {
    state.messages.unshift(msg);
    state._lastDigestAt[familyId] = nowISO();
    state._lastDigestHash[familyId] = digestHash;
    state._lastDigestAt[`${familyId}:${cause}`] = nowISO();
    state._causeHash[familyId] = {
      ...(state._causeHash[familyId] || {}),
      [cause]: digestHash,
    };
  });

  emitEvent(
    "family.opsForecast.shared",
    {
      familyId,
      messageId: msg.id,
      recipients: msg.recipients,
      sections: responses.map((r) => r.section),
      windows,
      cause,
    },
    {
      source: "familySharing.autoShareOpsForecast",
      undo: {
        label: "Undo",
        handler: () => {
          withState((x) => {
            x.messages = x.messages.filter((m) => m.id !== msg.id);
          });
          busEmit("notifications/cancel", { messageId: msg.id });
          toast(
            "info",
            "Ops forecast removed",
            "Agrarian notification canceled."
          );
        },
      },
      nextBestAction: {
        label: "Open Digest",
        hint: "Preview and adjust",
        route: "/family",
        params: { familyId, tab: "digests", id: msg.id },
      },
    }
  );

  sendViaChannels({ msg, html, text });
  toast(
    "success",
    "Operational forecast shared",
    "Agrarian received the digest."
  );
}

/* ──────────────────────────────────────────────────────────────
 * Preview / Resend / Share Link
 * ────────────────────────────────────────────────────────────── */
export function previewLastDigest(familyId) {
  const m = listFamilyDigests(familyId)[0];
  if (!m) return null;
  return {
    html: m.payload?.html,
    createdAt: m.createdAt,
    recipients: m.recipients,
    channels: m.channels,
    shareURL: `/share/${m.shareToken}`,
  };
}

export function resendLastDigest(familyId, overrides = {}) {
  const m = listFamilyDigests(familyId)[0];
  if (!m) {
    toast("info", "No digest to resend", "Create a forecast first.");
    return false;
  }
  const html = m.payload?.html || "";
  const text = toPlainText(html);
  const msg = {
    ...m,
    id: uid(),
    createdAt: nowISO(),
    recipients: overrides.recipients || m.recipients,
    channels: { ...(m.channels || {}), ...(overrides.channels || {}) },
  };
  withState((s) => s.messages.unshift(msg));
  sendViaChannels({ msg, html, text });
  emitEvent(
    "family.opsForecast.resent",
    { familyId, messageId: msg.id },
    { source: "familySharing.resendLastDigest" }
  );
  toast("success", "Digest resent", "");
  return true;
}

export function getShareLink(familyId, messageId) {
  const s = getState();
  const m = s.messages.find(
    (mm) => mm.familyId === familyId && mm.id === messageId
  );
  if (!m) return null;
  return `/share/${m.shareToken}`;
}

/* ──────────────────────────────────────────────────────────────
 * Event-driven nudges & background triggers
 * ────────────────────────────────────────────────────────────── */

// Meal plan published → cooking/cleaning forecasts often shift
events.on(
  NAMES["meal.plan.published"] || "meal.plan.published",
  ({ payload }) => {
    const familyId = payload?.familyId;
    if (familyId) {
      nba(
        "Share Operational Forecast",
        "Align support across households",
        "/family",
        { familyId, tab: "digests" }
      );
      autoShareOpsForecast(familyId, {
        cause: "meal.plan.published",
        scopes: ["cooking", "cleaning"],
      });
    }
  }
);

// Cooking sessions created/updated
events.on("cooking/sessionCreated", ({ payload }) => {
  const familyId = payload?.familyId;
  if (familyId)
    autoShareOpsForecast(familyId, {
      cause: "cooking.sessionCreated",
      scopes: ["cooking"],
    });
});

// Cleaning routine updates
events.on("cleaning/routineUpdated", ({ payload }) => {
  const familyId = payload?.familyId;
  if (familyId)
    autoShareOpsForecast(familyId, {
      cause: "cleaning.routineUpdated",
      scopes: ["cleaning"],
    });
});

// Garden plan or animal plan changes
events.on("garden/planUpdated", ({ payload }) => {
  const familyId = payload?.familyId;
  if (familyId)
    autoShareOpsForecast(familyId, {
      cause: "garden.planUpdated",
      scopes: ["garden"],
    });
});
events.on("animals/planUpdated", ({ payload }) => {
  const familyId = payload?.familyId;
  if (familyId)
    autoShareOpsForecast(familyId, {
      cause: "animals.planUpdated",
      scopes: ["animals"],
    });
});

// Calendar synced/created → session alignment
events.on(
  NAMES["calendar.events.created"] || "calendar.events.created",
  ({ payload }) => {
    const famId = payload?.familyId;
    if (famId)
      autoShareOpsForecast(famId, { cause: "calendar.events.created" });
  }
);

// Household profile nudges → re-run if relevant windows shift
events.on("household.profile.updated", ({ payload }) => {
  const famId = payload?.familyId;
  if (famId) autoShareOpsForecast(famId, { cause: "profile.updated" });
});

/* ──────────────────────────────────────────────────────────────
 * Queries
 * ────────────────────────────────────────────────────────────── */
export function listFamilies() {
  return getState().families;
}
export function listFamilyShares(familyId) {
  return getState().shares.filter((sh) => sh.familyId === familyId);
}
export function listFamilyGoals(familyId) {
  return getState().goals.filter((g) => g.familyId === familyId && !g.archived);
}
export function listFamilySessions(familyId) {
  return getState().sessions.filter((ss) => ss.familyId === familyId);
}
export function listFamilyDigests(familyId) {
  return getState().messages.filter(
    (m) => m.familyId === familyId && m.type === "ops-forecast"
  );
}
export function listFamilySettings(familyId) {
  const s = getState();
  return s.familySettings[familyId] || null;
}

/* ──────────────────────────────────────────────────────────────
 * Auto Empty State
 * ────────────────────────────────────────────────────────────── */
(function init() {
  const s = getState();
  if (s.families.length === 0) {
    empty("family.getting-started", [
      {
        label: "Create Family Circle",
        eventName: NAMES["ui.modal.open"],
        payload: { id: "createFamilyCircle" },
      },
    ]);
  }
  console.log("[FamilySharing] ready • schema v" + SCHEMA_VERSION);
})();

/* ──────────────────────────────────────────────────────────────
 * Public API
 * ────────────────────────────────────────────────────────────── */
export default {
  // circles
  createFamilyCircle,
  deleteFamilyCircle,

  // settings
  getFamilySettings,
  updateFamilySettings,

  // shares
  shareToFamily,

  // goals
  createFamilyGoal,
  updateFamilyGoal,

  // milestones
  addMilestone,
  completeMilestone,

  // tasks
  addTask,
  toggleTask,
  updateTask,

  // sessions
  scheduleFamilySession,

  // operational forecast automation
  autoShareOpsForecast,

  // preview/share/resend
  previewLastDigest,
  resendLastDigest,
  getShareLink,

  // queries
  listFamilies,
  listFamilyShares,
  listFamilyGoals,
  listFamilySessions,
  listFamilyDigests,
  listFamilySettings,
};

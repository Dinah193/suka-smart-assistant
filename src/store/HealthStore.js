// File: C:\Users\larho\suka-smart-assistant\src\store\HealthStore.js
/**
 * HealthStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Canonical "health layer" store for SSA:
 *      • user + household health profiles (goals, diet modes, allergies)
 *      • measurements (weight, waist, BP, glucose, etc.)
 *      • nutrition targets (macros/micros) + constraints
 *      • activity/training notes (lightweight, no external deps)
 *      • computed helpers (BMR/TDEE estimates) with safe defaults
 *
 * Design goals
 *  - Browser-safe, Vite-friendly (no Node imports).
 *  - Works with or without Dexie:
 *      • If Dexie "health_profiles" and/or "health_logs" exist, persists there
 *      • Else localStorage fallback (ssa.health.v1)
 *      • Else in-memory
 *  - Event-bus friendly:
 *      • health.hydrated
 *      • health.changed
 *      • health.activeProfile.changed
 *      • health.log.added
 *
 * Notes
 *  - This is NOT medical advice. It’s a structured personal tracking layer.
 *  - Keep the shape tolerant; UI and services can extend meta objects freely.
 */

const SOURCE = "store.HealthStore";
const STORAGE_KEY = "ssa.health.v1";

/* -----------------------------------------------------------------------------
 * Optional deps (safe dynamic imports)
 * -------------------------------------------------------------------------- */

let _depsPromise = null;
async function getDeps() {
  if (_depsPromise) return _depsPromise;

  _depsPromise = (async () => {
    let bus = null;
    let db = null;

    try {
      const mod = await import("../services/automation/eventBus.js").catch(
        () => null
      );
      bus =
        mod?.eventBus ||
        mod?.bus ||
        mod?.default?.eventBus ||
        mod?.default ||
        null;
    } catch {
      bus = null;
    }

    try {
      const mod = await import("../services/db.js").catch(() => null);
      db = mod?.db || mod?.default || mod || null;
    } catch {
      db = null;
    }

    return { bus, db };
  })();

  return _depsPromise;
}

function emit(bus, event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const nowISO = () => new Date().toISOString();

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function stableId(prefix = "h") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function parseISOorDate(x) {
  if (!x) return null;
  if (x instanceof Date) return x;
  const d = new Date(x);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toISO(x) {
  const d = parseISOorDate(x) || new Date();
  return d.toISOString();
}

/* -----------------------------------------------------------------------------
 * Normalization
 * -------------------------------------------------------------------------- */

function normalizeTargets(t) {
  const x = safeObj(t);
  return {
    calories: Number.isFinite(+x.calories) ? +x.calories : undefined,
    protein_g: Number.isFinite(+x.protein_g) ? +x.protein_g : undefined,
    fat_g: Number.isFinite(+x.fat_g) ? +x.fat_g : undefined,
    carbs_g: Number.isFinite(+x.carbs_g) ? +x.carbs_g : undefined,
    fiber_g: Number.isFinite(+x.fiber_g) ? +x.fiber_g : undefined,
    sodium_mg: Number.isFinite(+x.sodium_mg) ? +x.sodium_mg : undefined,
    water_ml: Number.isFinite(+x.water_ml) ? +x.water_ml : undefined,
    micros: safeObj(x.micros), // vitamins/minerals
    meta: safeObj(x.meta),
  };
}

function normalizeConstraints(c) {
  const x = safeObj(c);
  return {
    dietMode: x.dietMode ? String(x.dietMode) : "", // keto/carnivore/vegetarian/balanced/OMAD etc.
    allergens: safeArr(x.allergens).map(String),
    avoidIngredients: safeArr(x.avoidIngredients).map(String),
    preferIngredients: safeArr(x.preferIngredients).map(String),
    kosherStyle: x.kosherStyle ? String(x.kosherStyle) : "", // optional app-specific constraint label (not religious-law logic)
    sabbathAware:
      typeof x.sabbathAware === "boolean" ? x.sabbathAware : undefined,
    quietHours: safeObj(x.quietHours),
    notes: x.notes ? String(x.notes) : "",
    meta: safeObj(x.meta),
  };
}

function normalizeProfile(p, { keepId = true } = {}) {
  const x = safeObj(p);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("hp"));

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();
  const updatedAtISO = nowISO();

  return {
    ...safeObj(x),
    id: finalId,

    // ownership / scope
    scope: x.scope ? String(x.scope) : "user", // "user" | "household"
    userId: x.userId ? String(x.userId) : undefined,
    householdId: x.householdId ? String(x.householdId) : undefined,

    // identity
    label: x.label ? String(x.label) : "Health Profile",
    active: typeof x.active === "boolean" ? x.active : undefined,

    // baseline info (optional)
    sexAtBirth: x.sexAtBirth ? String(x.sexAtBirth) : "", // "female"|"male"|"" (optional)
    ageYears: Number.isFinite(+x.ageYears)
      ? clamp(+x.ageYears, 0, 125)
      : undefined,
    height_cm: Number.isFinite(+x.height_cm)
      ? clamp(+x.height_cm, 30, 300)
      : undefined,

    // goals
    goal: x.goal ? String(x.goal) : "", // "lose_weight"|"gain_weight"|"maintain"|"recomp" etc.
    goalWeight_kg: Number.isFinite(+x.goalWeight_kg)
      ? +x.goalWeight_kg
      : undefined,
    goalDateISO: x.goalDateISO ? String(x.goalDateISO) : "",

    // activity baseline
    activityLevel: x.activityLevel ? String(x.activityLevel) : "moderate", // sedentary/light/moderate/active/athlete

    // nutrition targets and constraints
    targets: normalizeTargets(x.targets),
    constraints: normalizeConstraints(x.constraints),

    // preferences/habits
    sleepTarget_h: Number.isFinite(+x.sleepTarget_h)
      ? +x.sleepTarget_h
      : undefined,
    stepsTarget: Number.isFinite(+x.stepsTarget) ? +x.stepsTarget : undefined,

    // links
    tags: safeArr(x.tags).map(String),
    meta: safeObj(x.meta),

    createdAtISO,
    updatedAtISO,
    source: x.source || SOURCE,
  };
}

function normalizeLog(log, { keepId = true } = {}) {
  const x = safeObj(log);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("hl"));

  const ts = x.tsISO ? String(x.tsISO) : x.ts ? toISO(x.ts) : nowISO();

  return {
    ...safeObj(x),
    id: finalId,
    profileId: x.profileId ? String(x.profileId) : "",

    // What kind of measurement is this?
    // "weight", "waist", "bp", "glucose", "sleep", "steps", "note", "custom"
    type: x.type ? String(x.type) : "note",

    // Optional numeric values (depending on type)
    value: Number.isFinite(+x.value) ? +x.value : x.value,
    unit: x.unit ? String(x.unit) : "",

    // BP example: { systolic, diastolic }
    readings: safeObj(x.readings),

    // freeform
    note: x.note ? String(x.note) : "",

    // tags/meta
    tags: safeArr(x.tags).map(String),
    meta: safeObj(x.meta),

    tsISO: ts,
    createdAtISO: x.createdAtISO ? String(x.createdAtISO) : ts,
    updatedAtISO: nowISO(),
    source: x.source || SOURCE,
  };
}

/* -----------------------------------------------------------------------------
 * Estimation helpers (basic, optional)
 * -------------------------------------------------------------------------- */

/**
 * Mifflin-St Jeor BMR estimate (kcal/day)
 *  - Requires sexAtBirth, ageYears, height_cm, weight_kg
 */
function estimateBMR({ sexAtBirth, ageYears, height_cm, weight_kg }) {
  const sex = String(sexAtBirth || "").toLowerCase();
  const age = Number(ageYears);
  const h = Number(height_cm);
  const w = Number(weight_kg);
  if (
    !Number.isFinite(age) ||
    !Number.isFinite(h) ||
    !Number.isFinite(w) ||
    age <= 0 ||
    h <= 0 ||
    w <= 0
  )
    return null;

  // Mifflin-St Jeor:
  // men:   10w + 6.25h - 5a + 5
  // women: 10w + 6.25h - 5a - 161
  const base = 10 * w + 6.25 * h - 5 * age;
  if (sex === "male" || sex === "m") return Math.round(base + 5);
  if (sex === "female" || sex === "f") return Math.round(base - 161);
  return Math.round(base - 78); // neutral midpoint if unknown
}

function activityMultiplier(level) {
  const l = String(level || "moderate").toLowerCase();
  if (l === "sedentary") return 1.2;
  if (l === "light") return 1.375;
  if (l === "moderate") return 1.55;
  if (l === "active") return 1.725;
  if (l === "athlete") return 1.9;
  return 1.55;
}

function estimateTDEE(profile, latestWeightKg) {
  const bmr = estimateBMR({
    sexAtBirth: profile?.sexAtBirth,
    ageYears: profile?.ageYears,
    height_cm: profile?.height_cm,
    weight_kg: latestWeightKg,
  });
  if (!bmr) return null;
  const mult = activityMultiplier(profile?.activityLevel);
  return Math.round(bmr * mult);
}

/* -----------------------------------------------------------------------------
 * localStorage IO
 * -------------------------------------------------------------------------- */

function loadLS() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { profiles: [], logs: [], activeProfileId: null };
    const parsed = JSON.parse(raw);
    return {
      profiles: safeArr(parsed.profiles),
      logs: safeArr(parsed.logs),
      activeProfileId: parsed.activeProfileId
        ? String(parsed.activeProfileId)
        : null,
    };
  } catch {
    return { profiles: [], logs: [], activeProfileId: null };
  }
}

function saveLS(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        savedAtISO: nowISO(),
        profiles: safeArr(state.profiles),
        logs: safeArr(state.logs),
        activeProfileId: state.activeProfileId
          ? String(state.activeProfileId)
          : null,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Internal state + subscribers
 * -------------------------------------------------------------------------- */

const _state = {
  hydrated: false,
  loading: false,
  error: null,

  profiles: [],
  logs: [],

  activeProfileId: null,

  source: "memory", // "dexie" | "localStorage" | "memory"
  lastLoadedAtISO: null,
  lastSavedAtISO: null,
};

const _subs = new Set();
function _notify() {
  for (const fn of _subs) {
    try {
      fn();
    } catch {}
  }
}
function _set(partial) {
  Object.assign(_state, partial);
  _notify();
}

function getSnapshot() {
  return {
    hydrated: _state.hydrated,
    loading: _state.loading,
    error: _state.error,
    profiles: _state.profiles.slice(),
    logs: _state.logs.slice(),
    activeProfileId: _state.activeProfileId,
    source: _state.source,
    lastLoadedAtISO: _state.lastLoadedAtISO,
    lastSavedAtISO: _state.lastSavedAtISO,
  };
}

function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/* -----------------------------------------------------------------------------
 * Dexie helpers
 * -------------------------------------------------------------------------- */

async function getProfilesTable(db) {
  try {
    if (!db) return null;
    if (db.health_profiles) return db.health_profiles;
    if (db.healthProfiles) return db.healthProfiles;
    if (typeof db.table === "function") {
      try {
        return db.table("health_profiles");
      } catch {
        return db.table("healthProfiles");
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getLogsTable(db) {
  try {
    if (!db) return null;
    if (db.health_logs) return db.health_logs;
    if (db.healthLogs) return db.healthLogs;
    if (typeof db.table === "function") {
      try {
        return db.table("health_logs");
      } catch {
        return db.table("healthLogs");
      }
    }
    return null;
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * Hydrate / persist
 * -------------------------------------------------------------------------- */

async function hydrate() {
  if (_state.hydrated || _state.loading) return getSnapshot();
  _set({ loading: true, error: null });

  const { bus, db } = await getDeps();

  // Dexie first (if tables exist)
  try {
    const tp = await getProfilesTable(db);
    const tl = await getLogsTable(db);

    if (tp && typeof tp.toArray === "function") {
      const profilesRaw = await tp.toArray();
      const profiles = safeArr(profilesRaw).map((p) =>
        normalizeProfile(p, { keepId: true })
      );

      let logs = [];
      if (tl && typeof tl.toArray === "function") {
        const logsRaw = await tl.toArray();
        logs = safeArr(logsRaw).map((l) => normalizeLog(l, { keepId: true }));
      }

      // determine active profile
      let activeProfileId = _state.activeProfileId;
      const flagged = profiles.find((p) => p.active === true);
      if (flagged) activeProfileId = flagged.id;
      if (!activeProfileId && profiles[0]) activeProfileId = profiles[0].id;

      _set({
        profiles,
        logs,
        activeProfileId: activeProfileId || null,
        hydrated: true,
        loading: false,
        source: "dexie",
        lastLoadedAtISO: nowISO(),
      });

      emit(bus, "health.hydrated", {
        at: _state.lastLoadedAtISO,
        source: "dexie",
        profiles: profiles.length,
        logs: logs.length,
      });
      return getSnapshot();
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage fallback
  try {
    const ls = loadLS();
    const profiles = safeArr(ls.profiles).map((p) =>
      normalizeProfile(p, { keepId: true })
    );
    const logs = safeArr(ls.logs).map((l) => normalizeLog(l, { keepId: true }));

    let activeProfileId = ls.activeProfileId || null;
    if (!activeProfileId) {
      const flagged = profiles.find((p) => p.active === true);
      if (flagged) activeProfileId = flagged.id;
      else if (profiles[0]) activeProfileId = profiles[0].id;
    }

    _set({
      profiles,
      logs,
      activeProfileId,
      hydrated: true,
      loading: false,
      source: "localStorage",
      lastLoadedAtISO: nowISO(),
    });

    emit(bus, "health.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "localStorage",
      profiles: profiles.length,
      logs: logs.length,
    });
    return getSnapshot();
  } catch (e) {
    _set({
      hydrated: true,
      loading: false,
      source: "memory",
      lastLoadedAtISO: nowISO(),
      error: e?.message || String(e),
    });

    emit(bus, "health.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "memory",
      profiles: _state.profiles.length,
      logs: _state.logs.length,
    });
    return getSnapshot();
  }
}

async function persistNow() {
  const { bus, db } = await getDeps();
  const profiles = safeArr(_state.profiles);
  const logs = safeArr(_state.logs);

  // Dexie
  try {
    const tp = await getProfilesTable(db);
    const tl = await getLogsTable(db);

    if (tp && typeof tp.bulkPut === "function") {
      await tp.bulkPut(profiles);
      if (tl && typeof tl.bulkPut === "function") {
        await tl.bulkPut(logs);
      }
      _set({ lastSavedAtISO: nowISO(), source: "dexie" });
      emit(bus, "health.persisted", {
        at: _state.lastSavedAtISO,
        source: "dexie",
        profiles: profiles.length,
        logs: logs.length,
      });
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage
  const ok = saveLS({
    profiles,
    logs,
    activeProfileId: _state.activeProfileId,
  });
  _set({
    lastSavedAtISO: nowISO(),
    source: ok ? "localStorage" : _state.source,
  });
  emit(bus, "health.persisted", {
    at: _state.lastSavedAtISO,
    source: ok ? "localStorage" : _state.source,
    profiles: profiles.length,
    logs: logs.length,
  });
  return { ok, source: ok ? "localStorage" : _state.source };
}

/* -----------------------------------------------------------------------------
 * Profiles
 * -------------------------------------------------------------------------- */

function listProfiles() {
  // active first, then label
  const arr = _state.profiles.slice();
  arr.sort((a, b) => {
    const aa = a?.active === true ? 1 : 0;
    const bb = b?.active === true ? 1 : 0;
    if (bb !== aa) return bb - aa;
    return String(a?.label || "").localeCompare(String(b?.label || ""));
  });
  return arr;
}

function getProfileById(id) {
  const pid = String(id || "");
  if (!pid) return null;
  return _state.profiles.find((p) => String(p.id) === pid) || null;
}

function getActiveProfile() {
  if (_state.activeProfileId) return getProfileById(_state.activeProfileId);
  const flagged = _state.profiles.find((p) => p.active === true);
  return flagged || _state.profiles[0] || null;
}

function setActiveProfile(id) {
  const pid = String(id || "");
  if (pid && !getProfileById(pid)) return null;

  const profiles = _state.profiles.map((p) => ({
    ...p,
    active: pid ? p.id === pid : false,
    updatedAtISO: nowISO(),
  }));

  _set({ profiles, activeProfileId: pid || null });

  getDeps().then(({ bus }) => {
    emit(bus, "health.activeProfile.changed", {
      activeProfileId: _state.activeProfileId,
      at: nowISO(),
    });
    emit(bus, "health.changed", {
      type: "setActiveProfile",
      profileId: _state.activeProfileId,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return getActiveProfile();
}

function upsertProfile(profileOrPartial) {
  const incoming = normalizeProfile(profileOrPartial, { keepId: true });
  const existing = getProfileById(incoming.id);

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        return merged;
      })()
    : incoming;

  const profiles = _state.profiles.filter((p) => p.id !== next.id);
  profiles.push(next);

  // keep active id valid
  let activeProfileId = _state.activeProfileId || next.id;

  // if incoming.active true -> set as active
  if (incoming.active === true) {
    activeProfileId = next.id;
    for (const p of profiles) p.active = p.id === activeProfileId;
  } else if (!profiles.some((p) => p.id === activeProfileId)) {
    activeProfileId = profiles[0]?.id || null;
  }

  _set({ profiles, activeProfileId });

  getDeps().then(({ bus }) => {
    emit(bus, "health.changed", {
      type: existing ? "upsertProfile" : "createProfile",
      profileId: next.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return next;
}

function createProfile({
  scope = "user",
  label = "New Health Profile",
  userId,
  householdId,
  sexAtBirth = "",
  ageYears,
  height_cm,
  goal = "",
  goalWeight_kg,
  goalDateISO = "",
  activityLevel = "moderate",
  targets = {},
  constraints = {},
  tags = [],
  meta = {},
} = {}) {
  const p = normalizeProfile(
    {
      id: stableId("hp"),
      scope,
      label,
      userId,
      householdId,
      sexAtBirth,
      ageYears,
      height_cm,
      goal,
      goalWeight_kg,
      goalDateISO,
      activityLevel,
      targets,
      constraints,
      tags,
      meta,
      active: _state.profiles.length === 0, // first profile becomes active
    },
    { keepId: true }
  );
  const created = upsertProfile(p);
  setActiveProfile(created.id);
  return created;
}

function removeProfile(id) {
  const pid = String(id || "");
  if (!pid) return false;

  const before = _state.profiles.length;
  const profiles = _state.profiles.filter((p) => p.id !== pid);

  // remove logs for that profile (best-effort)
  const logs = _state.logs.filter((l) => String(l.profileId) !== pid);

  let activeProfileId = _state.activeProfileId;
  if (activeProfileId === pid) {
    activeProfileId = profiles[0]?.id || null;
    for (const p of profiles) p.active = p.id === activeProfileId;
  }

  _set({ profiles, logs, activeProfileId });

  const changed = before !== profiles.length;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "health.changed", {
        type: "removeProfile",
        profileId: pid,
        at: nowISO(),
      });
      emit(bus, "health.activeProfile.changed", {
        activeProfileId,
        at: nowISO(),
      });
    });
    persistNow().catch(() => {});
  }

  return changed;
}

/* -----------------------------------------------------------------------------
 * Logs
 * -------------------------------------------------------------------------- */

function listLogs(profileId, { limit = 200, type = "", sinceISO = "" } = {}) {
  const pid = String(profileId || "");
  let rows = _state.logs.slice();

  if (pid) rows = rows.filter((l) => String(l.profileId) === pid);
  if (type) rows = rows.filter((l) => String(l.type) === String(type));

  if (sinceISO) {
    const since = parseISOorDate(sinceISO);
    if (since) {
      const sinceMs = since.getTime();
      rows = rows.filter((l) => {
        const d = parseISOorDate(l.tsISO);
        return d ? d.getTime() >= sinceMs : true;
      });
    }
  }

  rows.sort((a, b) =>
    String(b.tsISO || "").localeCompare(String(a.tsISO || ""))
  );
  if (Number.isFinite(+limit) && +limit > 0) rows = rows.slice(0, +limit);
  return rows;
}

function addLog(entry) {
  const profileId = entry?.profileId
    ? String(entry.profileId)
    : getActiveProfile()?.id || "";
  if (!profileId) return null;

  const log = normalizeLog({ ...safeObj(entry), profileId }, { keepId: true });
  const logs = _state.logs.slice();
  logs.push(log);
  _set({ logs });

  getDeps().then(({ bus }) => {
    emit(bus, "health.log.added", {
      profileId,
      logId: log.id,
      type: log.type,
      at: nowISO(),
    });
    emit(bus, "health.changed", {
      type: "addLog",
      profileId,
      logId: log.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return log;
}

function removeLog(logId) {
  const lid = String(logId || "");
  if (!lid) return false;

  const before = _state.logs.length;
  const logs = _state.logs.filter((l) => String(l.id) !== lid);
  _set({ logs });

  const changed = before !== logs.length;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "health.changed", {
        type: "removeLog",
        logId: lid,
        at: nowISO(),
      });
    });
    persistNow().catch(() => {});
  }
  return changed;
}

/* -----------------------------------------------------------------------------
 * Derived helpers
 * -------------------------------------------------------------------------- */

function getLatestMeasurement(profileId, type) {
  const pid = String(profileId || "");
  const t = String(type || "");
  if (!pid || !t) return null;
  const rows = listLogs(pid, { limit: 50, type: t });
  return rows[0] || null;
}

function getLatestWeightKg(profileId) {
  const log = getLatestMeasurement(profileId, "weight");
  if (!log) return null;

  const v = Number(log.value);
  if (!Number.isFinite(v) || v <= 0) return null;

  // infer unit; default "kg" if unspecified
  const unit = String(log.unit || "kg").toLowerCase();
  if (unit === "kg" || unit === "kilogram" || unit === "kilograms") return v;
  if (unit === "lb" || unit === "lbs" || unit === "pound" || unit === "pounds")
    return +(v * 0.45359237).toFixed(3);

  return v; // fallback
}

function computeEstimates(profileId) {
  const p = getProfileById(profileId) || getActiveProfile();
  if (!p) return { bmr: null, tdee: null, weightKg: null };

  const weightKg = getLatestWeightKg(p.id);
  const bmr = estimateBMR({
    sexAtBirth: p.sexAtBirth,
    ageYears: p.ageYears,
    height_cm: p.height_cm,
    weight_kg: weightKg,
  });
  const tdee = estimateTDEE(p, weightKg);

  return { bmr, tdee, weightKg };
}

/* -----------------------------------------------------------------------------
 * Convenience setters
 * -------------------------------------------------------------------------- */

function setTargets(profileId, targetsOrUpdater) {
  const p = getProfileById(profileId);
  if (!p) return null;

  const current = normalizeTargets(p.targets);
  const next =
    typeof targetsOrUpdater === "function"
      ? targetsOrUpdater(current)
      : targetsOrUpdater;

  return upsertProfile({
    ...p,
    targets: normalizeTargets(deepMerge(current, safeObj(next))),
  });
}

function setConstraints(profileId, constraintsOrUpdater) {
  const p = getProfileById(profileId);
  if (!p) return null;

  const current = normalizeConstraints(p.constraints);
  const next =
    typeof constraintsOrUpdater === "function"
      ? constraintsOrUpdater(current)
      : constraintsOrUpdater;

  return upsertProfile({
    ...p,
    constraints: normalizeConstraints(deepMerge(current, safeObj(next))),
  });
}

/* -----------------------------------------------------------------------------
 * Public facade
 * -------------------------------------------------------------------------- */

const HealthStore = {
  // status
  hydrate,
  persistNow,
  getSnapshot,
  subscribe,

  // profiles
  listProfiles,
  getProfileById,
  getActiveProfile,
  setActiveProfile,
  createProfile,
  upsertProfile,
  removeProfile,

  // logs
  listLogs,
  addLog,
  removeLog,
  getLatestMeasurement,

  // derived
  getLatestWeightKg,
  computeEstimates,

  // convenience
  setTargets,
  setConstraints,

  // diagnostics
  _unsafeState: _state,
};

export default HealthStore;
export { HealthStore };

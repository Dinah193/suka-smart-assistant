/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\nutrition\nutritionStore.js
//
// Shared Nutrition Wiring Layer (SSA)
// -----------------------------------------------------------------------------
// Goal: All nutrition tools (BMI, Macros, Micronutrients) read/write the same
// source of truth (Dexie + kv) and coordinate via eventBus without tight coupling.
//
// - Defensive imports (SSA standalone)
// - Local-first persistence (Dexie) with localStorage fallback
// - Store pattern with derived selectors + migrations/versioning
// - Emits + subscribes to standardized nutrition events
//
// Tables expected in db (added in db.js v10):
// - personProfiles
// - nutritionPreferences
// - toolRunLogs
// - kv (optional; used for active person)
// -----------------------------------------------------------------------------

import {
  NUTRITION_EVENTS,
  emitNutritionEvent,
  onNutritionEvent,
} from "./nutritionEvents";

// ----------------------------- Defensive Imports -----------------------------
let _dbPromise = null;
async function safeImportDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    // Most SSA pages import from "@/services/db" (default export db)
    try {
      // eslint-disable-next-line import/no-unresolved
      const mod = await import("@/services/db");
      const db = mod?.db || mod?.default || null;
      if (db) return db;
    } catch {}

    // Some repos may use relative path from services/
    try {
      const mod2 = await import("../db");
      const db2 = mod2?.db || mod2?.default || null;
      if (db2) return db2;
    } catch {}

    // Last resort: no db available
    return null;
  })();
  return _dbPromise;
}

// ------------------------------- Utilities ----------------------------------
function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix = "nut") {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.min(max, Math.max(min, x));
}

function round(n, digits = 1) {
  const x = Number(n);
  if (Number.isNaN(x)) return 0;
  const p = 10 ** digits;
  return Math.round(x * p) / p;
}

// ----------------------------- Data Contracts --------------------------------
/**
 * PersonProfile (canonical)
 * @typedef {Object} PersonProfile
 * @property {string} id
 * @property {string|null} householdId
 * @property {string} name
 * @property {"female"|"male"|"other"|"unknown"} sex
 * @property {number|null} age
 * @property {number|null} heightCm
 * @property {number|null} weightKg
 * @property {"sedentary"|"light"|"moderate"|"active"|"very_active"|string} activityLevel
 * @property {string} updatedAt
 */

/**
 * DietConstraints (canonical)
 * @typedef {Object} DietConstraints
 * @property {boolean} porkFree
 * @property {boolean} glutenFree
 * @property {boolean} dairyFree
 * @property {boolean} lowCarb
 * @property {boolean} vegetarian
 * @property {boolean} vegan
 * @property {Object.<string, boolean>} custom
 */

/**
 * Allergens (canonical)
 * @typedef {Object} Allergens
 * @property {boolean} peanuts
 * @property {boolean} treeNuts
 * @property {boolean} shellfish
 * @property {boolean} fish
 * @property {boolean} eggs
 * @property {boolean} soy
 * @property {boolean} wheat
 * @property {boolean} milk
 * @property {Object.<string, boolean>} custom
 */

/**
 * NutritionTargets (canonical)
 * @typedef {Object} NutritionTargets
 * @property {number|null} caloriesKcal
 * @property {{proteinG:number|null, carbsG:number|null, fatG:number|null, fiberG:number|null}} macros
 * @property {Object.<string, number|null>} micros  // e.g. { ironMg: 18, vitCMg: 90, ... }
 */

/**
 * ToolDerivations (canonical)
 * @typedef {Object} ToolDerivations
 * @property {Object|null} bmi        // computed BMI result
 * @property {Object|null} macros     // computed macro targets result
 * @property {Object|null} micros     // computed micro targets result
 * @property {Object.<string, any>} meta
 */

/**
 * Stored NutritionPreferences record (in db.nutritionPreferences)
 * We keep this flexible and versioned for migrations.
 *
 * @typedef {Object} NutritionPreferencesRecord
 * @property {string} id
 * @property {string} personId
 * @property {string} goal
 * @property {DietConstraints} constraints
 * @property {Allergens} allergens
 * @property {NutritionTargets} targets
 * @property {ToolDerivations} derivations
 * @property {number} version
 * @property {string} createdAt
 * @property {string} updatedAt
 */

// ------------------------------ Defaults ------------------------------------
const STORE_VERSION = 1;

function defaultConstraints() {
  return {
    porkFree: false,
    glutenFree: false,
    dairyFree: false,
    lowCarb: false,
    vegetarian: false,
    vegan: false,
    custom: {},
  };
}

function defaultAllergens() {
  return {
    peanuts: false,
    treeNuts: false,
    shellfish: false,
    fish: false,
    eggs: false,
    soy: false,
    wheat: false,
    milk: false,
    custom: {},
  };
}

function defaultTargets() {
  return {
    caloriesKcal: null,
    macros: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
    micros: {},
  };
}

function defaultDerivations() {
  return { bmi: null, macros: null, micros: null, meta: {} };
}

function defaultPreferencesForPerson(personId) {
  const ts = nowIso();
  return {
    id: `pref_${personId}`,
    personId,
    goal: "maintain",
    constraints: defaultConstraints(),
    allergens: defaultAllergens(),
    targets: defaultTargets(),
    derivations: defaultDerivations(),
    version: STORE_VERSION,
    createdAt: ts,
    updatedAt: ts,
  };
}

// ---------------------------- Migrations ------------------------------------
function migratePreferencesRecord(rec) {
  if (!rec || typeof rec !== "object") return rec;

  const version = Number(rec.version || 0);

  // v0 -> v1 (ensure canonical fields exist)
  if (version < 1) {
    const migrated = {
      ...rec,
      constraints:
        rec.constraints && typeof rec.constraints === "object"
          ? rec.constraints
          : defaultConstraints(),
      allergens:
        rec.allergens && typeof rec.allergens === "object"
          ? rec.allergens
          : defaultAllergens(),
      targets:
        rec.targets && typeof rec.targets === "object"
          ? rec.targets
          : defaultTargets(),
      derivations:
        rec.derivations && typeof rec.derivations === "object"
          ? rec.derivations
          : defaultDerivations(),
      goal: typeof rec.goal === "string" ? rec.goal : "maintain",
      version: 1,
      updatedAt: rec.updatedAt || nowIso(),
      createdAt: rec.createdAt || rec.updatedAt || nowIso(),
    };
    return migrated;
  }

  return rec;
}

// ------------------------------- Events -------------------------------------
function emit(type, data) {
  // fire-and-forget async so callers don't block
  void emitNutritionEvent(type, "nutritionStore", data);
}

async function subscribe(type, handler) {
  return onNutritionEvent(type, handler);
}

// ------------------------------- Store --------------------------------------
const listeners = new Set();

const initialState = {
  version: STORE_VERSION,

  // selection
  activePersonId: null,

  // loaded data
  people: [], // PersonProfile[]
  activePerson: null, // PersonProfile|null
  prefsByPersonId: {}, // { [personId]: NutritionPreferencesRecord }

  // UI / runtime
  loading: false,
  saving: false,
  error: null,

  // derived cache (optional)
  derived: {
    bmi: null,
    macros: null,
    micros: null,
  },
};

let state = { ...initialState };

function notify() {
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {}
  });
}

function reducer(current, action) {
  switch (action.type) {
    case "LOADING":
      return { ...current, loading: true, error: null };
    case "LOADED":
      return { ...current, loading: false, error: null, ...action.payload };
    case "SAVING":
      return { ...current, saving: true, error: null };
    case "SAVED":
      return { ...current, saving: false, error: null, ...action.payload };
    case "ERROR":
      return {
        ...current,
        loading: false,
        saving: false,
        error: action.error || "Unknown error",
      };
    case "SET_ACTIVE":
      return {
        ...current,
        activePersonId: action.personId,
        activePerson: action.person || null,
      };
    case "UPSERT_PERSON":
      return {
        ...current,
        people: upsertById(current.people, action.person),
        activePersonId:
          action.person?.id === current.activePersonId
            ? current.activePersonId
            : current.activePersonId,
        activePerson:
          action.person?.id === current.activePersonId
            ? action.person
            : current.activePerson,
      };
    case "UPSERT_PREFS": {
      const { personId, prefs } = action;
      const next = {
        ...current,
        prefsByPersonId: { ...current.prefsByPersonId, [personId]: prefs },
      };
      if (personId === current.activePersonId) {
        next.derived = {
          bmi: prefs?.derivations?.bmi || null,
          macros: prefs?.derivations?.macros || null,
          micros: prefs?.derivations?.micros || null,
        };
      }
      return next;
    }
    default:
      return current;
  }
}

function dispatch(action) {
  state = reducer(state, action);
  notify();
}

function upsertById(arr, item) {
  const list = Array.isArray(arr) ? arr.slice() : [];
  if (!item || !item.id) return list;
  const idx = list.findIndex((x) => x && x.id === item.id);
  if (idx >= 0) list[idx] = { ...list[idx], ...item };
  else list.unshift(item);
  return list;
}

// ---------------------------- Persistence API --------------------------------
const ACTIVE_PERSON_KV_KEY = "nutrition.activePersonId";

async function kvGet(key) {
  const db = await safeImportDb();
  if (db?.kv) {
    try {
      const row = await db.kv.get(String(key));
      return row?.value ?? null;
    } catch {}
  }
  try {
    return localStorage.getItem(String(key));
  } catch {
    return null;
  }
}

async function kvSet(key, value) {
  const db = await safeImportDb();
  if (db?.kv) {
    try {
      await db.kv.put({
        key: String(key),
        value: value == null ? null : String(value),
        updatedAt: nowIso(),
      });
      return true;
    } catch {}
  }
  try {
    if (value == null) localStorage.removeItem(String(key));
    else localStorage.setItem(String(key), String(value));
    return true;
  } catch {
    return false;
  }
}

async function listPeople() {
  const db = await safeImportDb();
  if (!db?.personProfiles) return [];
  try {
    const rows = await db.personProfiles.toCollection().toArray();
    rows.sort((a, b) =>
      String(a?.name || "").localeCompare(String(b?.name || ""))
    );
    return rows;
  } catch {
    return [];
  }
}

async function getPerson(personId) {
  const db = await safeImportDb();
  if (!db?.personProfiles || !personId) return null;
  try {
    return await db.personProfiles.get(String(personId));
  } catch {
    return null;
  }
}

async function upsertPerson(profilePatch) {
  const db = await safeImportDb();
  if (!db?.personProfiles) return null;

  const id = profilePatch?.id ? String(profilePatch.id) : makeId("person");
  const existing = await getPerson(id);

  const normalized = {
    id,
    householdId: profilePatch?.householdId ?? existing?.householdId ?? null,
    name: String(profilePatch?.name ?? existing?.name ?? "Household Member"),
    sex: String(profilePatch?.sex ?? existing?.sex ?? "unknown"),
    age:
      profilePatch?.age == null
        ? existing?.age ?? null
        : Number(profilePatch.age),
    heightCm:
      profilePatch?.heightCm == null
        ? existing?.heightCm ?? null
        : Number(profilePatch.heightCm),
    weightKg:
      profilePatch?.weightKg == null
        ? existing?.weightKg ?? null
        : Number(profilePatch.weightKg),
    activityLevel: String(
      profilePatch?.activityLevel ?? existing?.activityLevel ?? "moderate"
    ),
    updatedAt: nowIso(),
  };

  await db.personProfiles.put(normalized);
  return normalized;
}

async function getPrefs(personId) {
  const db = await safeImportDb();
  if (!db?.nutritionPreferences || !personId) return null;
  try {
    const id = `pref_${personId}`;
    const row = await db.nutritionPreferences.get(id);
    return row ? migratePreferencesRecord(row) : null;
  } catch {
    return null;
  }
}

async function upsertPrefs(personId, patch) {
  const db = await safeImportDb();
  if (!db?.nutritionPreferences || !personId) return null;

  const existing =
    (await getPrefs(personId)) || defaultPreferencesForPerson(personId);
  const ts = nowIso();

  const next = migratePreferencesRecord({
    ...existing,
    ...patch,
    id: existing.id || `pref_${personId}`,
    personId,
    version: STORE_VERSION,
    updatedAt: ts,
    createdAt: existing.createdAt || ts,
  });

  await db.nutritionPreferences.put(next);
  return next;
}

async function logToolRun({ personId, tool, input, output, version }) {
  const db = await safeImportDb();
  if (!db?.toolRunLogs) return null;

  const row = {
    id: makeId("toolrun"),
    personId: personId ? String(personId) : null,
    tool: String(tool || "unknown"),
    createdAt: nowIso(),
    version: version == null ? 1 : Number(version),
    input: input && typeof input === "object" ? input : {},
    output: output && typeof output === "object" ? output : {},
  };

  try {
    await db.toolRunLogs.put(row);
    return row;
  } catch {
    return null;
  }
}

// ---------------------------- Domain Computations ----------------------------
function computeBmi(heightCm, weightKg) {
  const h = Number(heightCm);
  const w = Number(weightKg);
  if (!h || !w || Number.isNaN(h) || Number.isNaN(w)) return null;
  const m = h / 100;
  const bmi = w / (m * m);
  const v = round(bmi, 1);

  let category = "unknown";
  if (v < 18.5) category = "underweight";
  else if (v < 25) category = "normal";
  else if (v < 30) category = "overweight";
  else category = "obese";

  return { bmi: v, category, heightCm: h, weightKg: w };
}

function activityMultiplier(level) {
  const L = String(level || "").toLowerCase();
  if (L.includes("sedentary")) return 1.2;
  if (L.includes("light")) return 1.375;
  if (L.includes("moderate")) return 1.55;
  if (L.includes("very")) return 1.725;
  if (L.includes("active")) return 1.725;
  return 1.55;
}

// Mifflin-St Jeor
function estimateBmr({ sex, age, heightCm, weightKg }) {
  const s = String(sex || "unknown").toLowerCase();
  const a = Number(age || 0);
  const h = Number(heightCm || 0);
  const w = Number(weightKg || 0);
  if (!h || !w) return null;

  const base = 10 * w + 6.25 * h - 5 * (a || 30);
  if (s === "male") return base + 5;
  if (s === "female") return base - 161;
  return base;
}

function computeMacroTargets(profile, prefs) {
  if (!profile) return null;

  const bmr = estimateBmr(profile);
  const mult = activityMultiplier(profile.activityLevel);
  const tdee = bmr ? Math.round(bmr * mult) : null;

  const goal = String(prefs?.goal || "maintain");
  let calories = tdee;

  if (calories != null) {
    if (goal === "lose") calories = Math.max(1200, calories - 400);
    if (goal === "gain") calories = calories + 300;
  }

  let pPct = 0.3,
    cPct = 0.4,
    fPct = 0.3;
  if (goal === "lose") {
    pPct = 0.35;
    cPct = 0.35;
    fPct = 0.3;
  } else if (goal === "gain") {
    pPct = 0.25;
    cPct = 0.45;
    fPct = 0.3;
  }

  if (prefs?.constraints?.lowCarb) {
    cPct = 0.25;
    pPct = 0.4;
    fPct = 0.35;
  }

  if (calories == null) {
    return {
      caloriesKcal: null,
      macros: { proteinG: null, carbsG: null, fatG: null, fiberG: null },
      method: "estimate",
      inputs: {
        sex: profile.sex,
        age: profile.age,
        heightCm: profile.heightCm,
        weightKg: profile.weightKg,
        activityLevel: profile.activityLevel,
        goal,
      },
    };
  }

  const proteinG = Math.round((calories * pPct) / 4);
  const carbsG = Math.round((calories * cPct) / 4);
  const fatG = Math.round((calories * fPct) / 9);
  const fiberG = Math.round(clamp(carbsG * 0.1, 20, 45));

  return {
    caloriesKcal: calories,
    macros: { proteinG, carbsG, fatG, fiberG },
    method: "estimate",
    inputs: {
      sex: profile.sex,
      age: profile.age,
      heightCm: profile.heightCm,
      weightKg: profile.weightKg,
      activityLevel: profile.activityLevel,
      goal,
    },
  };
}

function computeMicroTargets(profile, prefs) {
  if (!profile) return null;
  const sex = String(profile.sex || "unknown").toLowerCase();
  const age = Number(profile.age || 0);

  const micros = {
    ironMg: sex === "female" && age >= 14 ? 18 : 8,
    calciumMg: 1000,
    magnesiumMg: sex === "male" ? 420 : 320,
    potassiumMg: 2600,
    sodiumMg: 2300,
    zincMg: sex === "male" ? 11 : 8,
    vitCMg: 90,
    vitDMcg: 15,
    vitB12Mcg: 2.4,
    folateMcg: 400,
  };

  return {
    micros,
    method: "baseline",
    inputs: {
      sex: profile.sex,
      age: profile.age,
      goal: prefs?.goal || "maintain",
    },
  };
}

// ----------------------------- Selectors ------------------------------------
export const selectors = {
  getState: () => state,

  getPeople: () => state.people || [],
  getActivePersonId: () => state.activePersonId,
  getActivePerson: () => state.activePerson,

  getPrefsForPerson: (personId) =>
    personId ? state.prefsByPersonId[String(personId)] || null : null,

  getActivePrefs: () =>
    state.activePersonId
      ? state.prefsByPersonId[state.activePersonId] || null
      : null,

  getActiveTargets: () => {
    const prefs = selectors.getActivePrefs();
    return prefs?.targets || null;
  },

  getActiveConstraints: () => {
    const prefs = selectors.getActivePrefs();
    return prefs?.constraints || null;
  },

  getDerived: () => state.derived || { bmi: null, macros: null, micros: null },
};

// ------------------------------ Actions -------------------------------------
export const actions = {
  async bootstrap() {
    dispatch({ type: "LOADING" });
    try {
      const people = await listPeople();
      const stored = await kvGet("nutrition.activePersonId");
      const activePersonId = stored || people[0]?.id || null;

      let activePerson = activePersonId
        ? await getPerson(activePersonId)
        : null;
      const prefsByPersonId = {};

      if (activePersonId) {
        const prefs =
          (await getPrefs(activePersonId)) ||
          defaultPreferencesForPerson(activePersonId);
        prefsByPersonId[String(activePersonId)] = prefs;

        dispatch({
          type: "LOADED",
          payload: {
            people,
            activePersonId: activePersonId ? String(activePersonId) : null,
            activePerson,
            prefsByPersonId,
            derived: {
              bmi: prefs?.derivations?.bmi || null,
              macros: prefs?.derivations?.macros || null,
              micros: prefs?.derivations?.micros || null,
            },
          },
        });
      } else {
        dispatch({
          type: "LOADED",
          payload: {
            people,
            activePersonId: null,
            activePerson: null,
            prefsByPersonId,
          },
        });
      }

      if (activePersonId)
        await kvSet("nutrition.activePersonId", String(activePersonId));

      emit(NUTRITION_EVENTS.ACTIVE_PERSON_CHANGED, {
        personId: activePersonId ? String(activePersonId) : null,
        reason: "bootstrap",
      });

      return { people, activePersonId };
    } catch (err) {
      dispatch({ type: "ERROR", error: String(err?.message || err) });
      return null;
    }
  },

  async wireSubscriptions() {
    const unsubs = [];

    unsubs.push(
      await subscribe(NUTRITION_EVENTS.PROFILE_UPDATED, async (evt) => {
        const personId = evt?.data?.personId;
        if (!personId) return;
        await actions.refreshPerson(personId, {
          reason: `event:${NUTRITION_EVENTS.PROFILE_UPDATED}`,
        });
      })
    );

    unsubs.push(
      await subscribe(NUTRITION_EVENTS.TARGETS_UPDATED, async (evt) => {
        const personId = evt?.data?.personId;
        if (!personId) return;
        await actions.refreshPrefs(personId, {
          reason: `event:${NUTRITION_EVENTS.TARGETS_UPDATED}`,
        });
      })
    );

    unsubs.push(
      await subscribe(NUTRITION_EVENTS.CONSTRAINTS_UPDATED, async (evt) => {
        const personId = evt?.data?.personId;
        if (!personId) return;
        await actions.refreshPrefs(personId, {
          reason: `event:${NUTRITION_EVENTS.CONSTRAINTS_UPDATED}`,
        });
      })
    );

    unsubs.push(
      await subscribe(NUTRITION_EVENTS.ACTIVE_PERSON_CHANGED, async (evt) => {
        const personId = evt?.data?.personId;
        if (!personId) return;
        if (String(personId) !== String(state.activePersonId || "")) {
          await actions.setActivePerson(personId, {
            reason: `event:${NUTRITION_EVENTS.ACTIVE_PERSON_CHANGED}`,
          });
        }
      })
    );

    return () => {
      unsubs.forEach((fn) => {
        try {
          fn();
        } catch {}
      });
    };
  },

  async refreshPerson(personId) {
    const person = await getPerson(personId);
    if (person) dispatch({ type: "UPSERT_PERSON", person });
    if (String(personId) === String(state.activePersonId || "")) {
      dispatch({ type: "SET_ACTIVE", personId: String(personId), person });
    }
    return person;
  },

  async refreshPrefs(personId) {
    const prefs =
      (await getPrefs(personId)) || defaultPreferencesForPerson(personId);
    dispatch({ type: "UPSERT_PREFS", personId: String(personId), prefs });
    return prefs;
  },

  async getActivePerson() {
    if (state.activePersonId) return state.activePersonId;
    const stored = await kvGet("nutrition.activePersonId");
    return stored || null;
  },

  async setActivePerson(personId, { reason } = {}) {
    const pid = personId ? String(personId) : null;
    if (!pid) return null;

    dispatch({
      type: "SET_ACTIVE",
      personId: pid,
      person: state.people.find((p) => p?.id === pid) || null,
    });
    await kvSet("nutrition.activePersonId", pid);

    const person = await getPerson(pid);
    const prefs = (await getPrefs(pid)) || defaultPreferencesForPerson(pid);

    try {
      await upsertPrefs(pid, prefs);
    } catch {}

    dispatch({ type: "SET_ACTIVE", personId: pid, person });
    dispatch({ type: "UPSERT_PREFS", personId: pid, prefs });

    emit(NUTRITION_EVENTS.ACTIVE_PERSON_CHANGED, {
      personId: pid,
      reason: reason || "setActivePerson",
    });
    return pid;
  },

  async savePersonProfile(profilePatch, { setActive = false } = {}) {
    dispatch({ type: "SAVING" });
    try {
      const saved = await upsertPerson(profilePatch);
      dispatch({ type: "UPSERT_PERSON", person: saved });
      dispatch({ type: "SAVED", payload: {} });

      if (setActive && saved?.id) {
        await actions.setActivePerson(saved.id, {
          reason: "savePersonProfile(setActive)",
        });
      }

      emit(NUTRITION_EVENTS.PROFILE_UPDATED, {
        personId: String(saved.id),
        fields: Object.keys(profilePatch || {}),
      });

      return saved;
    } catch (err) {
      dispatch({ type: "ERROR", error: String(err?.message || err) });
      return null;
    }
  },

  async updateActivityLevel(personId, activityLevel) {
    const pid = String(personId || state.activePersonId || "");
    if (!pid) return null;

    const saved = await actions.savePersonProfile(
      { id: pid, activityLevel: String(activityLevel || "moderate") },
      { setActive: false }
    );

    emit(NUTRITION_EVENTS.MEALPLAN_PREFERENCES_APPLIED, {
      personId: pid,
      from: "nutritionStore.updateActivityLevel",
      activityLevel: String(activityLevel || "moderate"),
      ts: nowIso(),
    });

    return saved;
  },

  async updateConstraints(personId, constraintsPatch, allergensPatch) {
    const pid = String(personId || state.activePersonId || "");
    if (!pid) return null;

    dispatch({ type: "SAVING" });
    try {
      const current = (await getPrefs(pid)) || defaultPreferencesForPerson(pid);

      const nextConstraints = {
        ...defaultConstraints(),
        ...(current.constraints || {}),
        ...(constraintsPatch && typeof constraintsPatch === "object"
          ? constraintsPatch
          : {}),
        custom: {
          ...((current.constraints || {}).custom || {}),
          ...((constraintsPatch || {}).custom || {}),
        },
      };

      const nextAllergens = {
        ...defaultAllergens(),
        ...(current.allergens || {}),
        ...(allergensPatch && typeof allergensPatch === "object"
          ? allergensPatch
          : {}),
        custom: {
          ...((current.allergens || {}).custom || {}),
          ...((allergensPatch || {}).custom || {}),
        },
      };

      const saved = await upsertPrefs(pid, {
        constraints: nextConstraints,
        allergens: nextAllergens,
      });
      dispatch({ type: "UPSERT_PREFS", personId: pid, prefs: saved });
      dispatch({ type: "SAVED", payload: {} });

      emit(NUTRITION_EVENTS.CONSTRAINTS_UPDATED, {
        personId: pid,
        constraints: nextConstraints,
        allergens: nextAllergens,
      });

      emit(NUTRITION_EVENTS.MEALPLAN_PREFERENCES_APPLIED, {
        personId: pid,
        from: "nutritionStore.updateConstraints",
        constraints: nextConstraints,
        allergens: nextAllergens,
        ts: nowIso(),
      });

      return saved;
    } catch (err) {
      dispatch({ type: "ERROR", error: String(err?.message || err) });
      return null;
    }
  },

  async runBmi(personId) {
    const pid = String(personId || state.activePersonId || "");
    if (!pid) return null;

    const person = await getPerson(pid);
    const bmi = computeBmi(person?.heightCm, person?.weightKg);

    const prefs = (await getPrefs(pid)) || defaultPreferencesForPerson(pid);
    const nextDerivations = {
      ...(prefs.derivations || defaultDerivations()),
      bmi,
    };

    const saved = await upsertPrefs(pid, { derivations: nextDerivations });
    dispatch({ type: "UPSERT_PREFS", personId: pid, prefs: saved });

    emit(NUTRITION_EVENTS.BMI_COMPUTED, { personId: pid, bmi });

    const log = await logToolRun({
      personId: pid,
      tool: "BMI",
      input: {
        heightCm: person?.heightCm ?? null,
        weightKg: person?.weightKg ?? null,
      },
      output: { bmi },
      version: 1,
    });

    if (log)
      emit(NUTRITION_EVENTS.TOOLRUN_LOGGED, {
        personId: pid,
        tool: "BMI",
        logId: log.id,
      });

    return bmi;
  },

  async runMacros(personId, { overrideGoal } = {}) {
    const pid = String(personId || state.activePersonId || "");
    if (!pid) return null;

    const person = await getPerson(pid);
    const prefs = (await getPrefs(pid)) || defaultPreferencesForPerson(pid);

    const goal = overrideGoal
      ? String(overrideGoal)
      : String(prefs.goal || "maintain");
    const macros = computeMacroTargets(person, { ...prefs, goal });

    const nextTargets = {
      ...(prefs.targets || defaultTargets()),
      caloriesKcal: macros?.caloriesKcal ?? null,
      macros: {
        ...(prefs.targets?.macros || defaultTargets().macros),
        ...(macros?.macros || {}),
      },
    };

    const nextDerivations = {
      ...(prefs.derivations || defaultDerivations()),
      macros,
    };

    const saved = await upsertPrefs(pid, {
      goal,
      targets: nextTargets,
      derivations: nextDerivations,
    });
    dispatch({ type: "UPSERT_PREFS", personId: pid, prefs: saved });

    emit(NUTRITION_EVENTS.MACROS_COMPUTED, { personId: pid, macros });
    emit(NUTRITION_EVENTS.TARGETS_UPDATED, {
      personId: pid,
      targets: saved.targets,
      reason: "macros",
    });

    emit(NUTRITION_EVENTS.MEALPLAN_PREFERENCES_APPLIED, {
      personId: pid,
      from: "nutritionStore.runMacros",
      targets: saved.targets,
      constraints: saved.constraints,
      allergens: saved.allergens,
      ts: nowIso(),
    });

    const log = await logToolRun({
      personId: pid,
      tool: "MACROS",
      input: { person, goal },
      output: { macros, targets: saved.targets },
      version: 1,
    });
    if (log)
      emit(NUTRITION_EVENTS.TOOLRUN_LOGGED, {
        personId: pid,
        tool: "MACROS",
        logId: log.id,
      });

    return macros;
  },

  async runMicros(personId) {
    const pid = String(personId || state.activePersonId || "");
    if (!pid) return null;

    const person = await getPerson(pid);
    const prefs = (await getPrefs(pid)) || defaultPreferencesForPerson(pid);

    const micros = computeMicroTargets(person, prefs);

    const nextTargets = {
      ...(prefs.targets || defaultTargets()),
      micros: { ...(prefs.targets?.micros || {}), ...(micros?.micros || {}) },
    };

    const nextDerivations = {
      ...(prefs.derivations || defaultDerivations()),
      micros,
    };

    const saved = await upsertPrefs(pid, {
      targets: nextTargets,
      derivations: nextDerivations,
    });
    dispatch({ type: "UPSERT_PREFS", personId: pid, prefs: saved });

    emit(NUTRITION_EVENTS.MICROS_COMPUTED, { personId: pid, micros });
    emit(NUTRITION_EVENTS.TARGETS_UPDATED, {
      personId: pid,
      targets: saved.targets,
      reason: "micros",
    });

    emit(NUTRITION_EVENTS.MEALPLAN_PREFERENCES_APPLIED, {
      personId: pid,
      from: "nutritionStore.runMicros",
      targets: saved.targets,
      constraints: saved.constraints,
      allergens: saved.allergens,
      ts: nowIso(),
    });

    const log = await logToolRun({
      personId: pid,
      tool: "MICROS",
      input: { person, goal: prefs.goal },
      output: { micros, targets: saved.targets },
      version: 1,
    });
    if (log)
      emit(NUTRITION_EVENTS.TOOLRUN_LOGGED, {
        personId: pid,
        tool: "MICROS",
        logId: log.id,
      });

    return micros;
  },

  async resetToDefaults(personId) {
    const pid = String(personId || state.activePersonId || "");
    if (!pid) return null;

    dispatch({ type: "SAVING" });
    try {
      const fresh = defaultPreferencesForPerson(pid);
      const saved = await upsertPrefs(pid, fresh);

      dispatch({ type: "UPSERT_PREFS", personId: pid, prefs: saved });
      dispatch({ type: "SAVED", payload: {} });

      emit(NUTRITION_EVENTS.TARGETS_UPDATED, {
        personId: pid,
        targets: saved.targets,
        reason: "reset",
      });
      emit(NUTRITION_EVENTS.CONSTRAINTS_UPDATED, {
        personId: pid,
        constraints: saved.constraints,
        allergens: saved.allergens,
      });

      emit(NUTRITION_EVENTS.MEALPLAN_PREFERENCES_APPLIED, {
        personId: pid,
        from: "nutritionStore.resetToDefaults",
        targets: saved.targets,
        constraints: saved.constraints,
        allergens: saved.allergens,
        ts: nowIso(),
      });

      const log = await logToolRun({
        personId: pid,
        tool: "RESET_DEFAULTS",
        input: {},
        output: {
          targets: saved.targets,
          constraints: saved.constraints,
          allergens: saved.allergens,
        },
        version: 1,
      });
      if (log)
        emit(NUTRITION_EVENTS.TOOLRUN_LOGGED, {
          personId: pid,
          tool: "RESET_DEFAULTS",
          logId: log.id,
        });

      return saved;
    } catch (err) {
      dispatch({ type: "ERROR", error: String(err?.message || err) });
      return null;
    }
  },
};

// ------------------------ React Hook (useSyncExternalStore) ------------------
function getSnapshot() {
  return state;
}

function subscribeStore(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * useNutritionStore()
 * - Provides the canonical shared state + actions to all tools.
 * - Uses useSyncExternalStore for correctness across concurrent renders.
 */
export function useNutritionStore() {
  let useSyncExternalStore = null;
  try {
    // eslint-disable-next-line global-require
    const React = require("react");
    useSyncExternalStore = React.useSyncExternalStore;
  } catch {}

  if (!useSyncExternalStore) {
    return { state, actions, selectors };
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  const snap = useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);
  return { state: snap, actions, selectors };
}

export default {
  actions,
  selectors,
  useNutritionStore,
};

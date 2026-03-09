// src/store/MealPrefsStore.js
/**
 * MealPrefsStore — rhythm-aware, cross-tab synced, server-optional
 * ---------------------------------------------------------------
 * Public API (compatible with MealPrefsStore.d.ts):
 *   - await store.get(): Promise<MealPlanPrefs>
 *   - await store.set(partial: Partial<MealPlanPrefs>): Promise<void>
 *   - const off = store.onChange((prefs) => {})
 *
 * Plus ergonomic helpers you’re already using:
 *   - init({ baseUrl?, socketIO?, user? })
 *   - destroy()
 *   - getState(), get(dotPath, fallback), set(dotPath, value, opts), patch(obj, opts), reset(section?, opts)
 *   - subscribe(fn) -> off
 *   - effectivePortions(overrides), isIngredientAllowed(name), sabbathAware(), nextBatchSessionDate(from?)
 */

const VERSION = 2;
const LS_KEY = `suka.mealprefs.v${VERSION}`;
const BC_NAME = "suka.mealprefs";

const DEFAULTS = Object.freeze({
  ui: {
    locale: "en-US",
    timezone: "America/New_York", // align with app TZ
  },

  // ── Rhythm-driven planning (mirrors types in MealPrefsStore.d.ts) ──────────
  rhythm: {
    preset: "custom", // "custom" | "16:8" | "18:6" | "omad" | "36h" | "adf" | custom string
    timezone: "America/New_York",
    slots: [
      {
        slotId: "B",
        label: "Breakfast",
        type: "meal",
        start: "08:00",
        end: "08:45",
      },
      {
        slotId: "L",
        label: "Lunch",
        type: "meal",
        start: "12:30",
        end: "13:15",
      },
      {
        slotId: "D",
        label: "Dinner",
        type: "meal",
        start: "18:30",
        end: "19:15",
      },
    ],
    // 0=Sun … 6=Sat (+ default)
    dietByDow: {
      default: "unrestricted",
      1: "keto",
      2: "keto",
      3: "keto",
      4: "keto",
      5: "keto",
      6: "unrestricted",
      0: "unrestricted",
    },
    adf: null, // { startIso: "2025-09-01", fastEveryOtherDay: true }
    overrides: {}, // { "YYYY-MM-DD": { slots?, dietTag? } }
  },

  // ── Nutrition & scaling ───────────────────────────────────────────────────
  macros: {
    calories: undefined,
    proteinPercent: 30,
    carbsPercent: 25,
    fatPercent: 45,
    proteinPerKg: 1.6,
    netCarbsLimit: undefined,
    fiberTarget: 25,
  },
  sizing: { defaultServings: 4, scaleToHousehold: true, roundServings: true },

  // ── Workflows ─────────────────────────────────────────────────────────────
  batchCooking: {
    enabled: true,
    daysOfWeek: [0], // Sunday
    defaultStart: "14:00",
    defaultDurationMins: 120,
    autoGeneratePrepLists: true,
  },
  shopping: {
    cadence: "weekly", // "weekly" | "biweekly" | "monthly" | "as_needed"
    budgetPerPeriod: undefined,
    preferredStores: [],
    autoGroupByAisle: true,
  },
  leftovers: { planLeftovers: true, keepDays: 3, assignToSlots: true },
  inventorySync: {
    autoDecrementOnPlan: false,
    decrementOnCook: true,
    reserveOnPlan: true,
  },

  // ── Dietary prefs (keep name aligned with your base types) ────────────────
  dietary: {
    allergies: [], // e.g., ["peanuts","shellfish"]
    exclusions: [], // ingredients to avoid
    preferredCuisines: [], // weight toward
    dislikedCuisines: [], // weight away from
    // kosher-style toggles moved into exclusions/recipes filters at runtime.
  },

  // ── Observance: Sabbath/feast-day & sunset awareness ──────────────────────
  observance: {
    sabbathAware: true,
    sabbathDayRule: "hebrew_day7", // not "saturday" by default
    sabbathPrepWindowHours: 4,
    feastDayBehavior: "lock", // "lock" | "swap" | "skip"
    showSunsetTimes: true,
  },

  // ── Reminders & generator defaults ────────────────────────────────────────
  reminders: {
    enableReminders: true,
    reminderTimes: ["09:00", "17:00"],
    advanceMinutes: 15,
  },
  defaultGenerateDays: 28,

  // ── Feature flags ─────────────────────────────────────────────────────────
  features: {
    aiSuggestions: true,
    allowSwapWithJustification: false,
    enableCostEstimates: true,
  },

  // Legacy area retained for compatibility (soft-deprecated)
  meals: {
    diet: { kosherStyle: true, pork: false, shellfish: false },
    portions: { default: 4, adults: 2, children: 2 },
    cadence: { breakfast: true, lunch: true, dinner: true, snacks: false },
    proteins: ["chicken", "beef", "fish"],
    breads: ["white", "wheat", "sourdough", "cornbread"],
    veggies: ["lettuce", "spinach", "tomato", "broccoli", "onion", "pepper"],
    batchCooking: {
      enabled: true,
      sessionDay: "Sunday",
      sessionHour: 14,
      warmUpTips: true,
    },
    donenessHints: { vegetables: "tender-crisp", meat: "medium" },
  },
  calendar: { sabbathAware: true, sabbathSunsetOffsetMin: 30 },
});

const ENUMS = {
  donenessVeg: new Set(["soft", "tender-crisp"]),
  donenessMeat: new Set(["rare", "medium", "well"]),
  sessionDays: new Set([
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ]),
  presets: new Set(["custom", "16:8", "18:6", "omad", "36h", "adf"]),
};

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function getAtPath(obj, dot, fallback) {
  if (!dot) return obj;
  const parts = String(dot).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return fallback;
    cur = cur[p];
  }
  return cur === undefined ? fallback : cur;
}
function setAtPath(obj, dot, value) {
  const parts = String(dot).split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i === parts.length - 1) cur[p] = value;
    else {
      if (!isObj(cur[p])) cur[p] = {};
      cur = cur[p];
    }
  }
}
function deepMerge(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return b; // arrays replace
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = isObj(v) ? deepMerge(out[k], v) : v;
  }
  return out;
}
function debounce(fn, ms = 250) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* --- Validation tuned to your prefs schema --- */
function isTimeStr(s) {
  return typeof s === "string" && /^\d{2}:\d{2}$/.test(s);
}
function validateRhythm(rhythm) {
  if (!rhythm) return;
  if (
    rhythm.preset &&
    !(
      ENUMS.presets.has(String(rhythm.preset).toLowerCase()) ||
      typeof rhythm.preset === "string"
    )
  ) {
    throw new Error(`Unknown rhythm.preset: ${rhythm.preset}`);
  }
  if (!Array.isArray(rhythm.slots))
    throw new Error("rhythm.slots must be an array");
  for (const slot of rhythm.slots) {
    if (!slot || !slot.slotId || !slot.label || !slot.type)
      throw new Error("Invalid rhythm slot");
    if (!isTimeStr(slot.start) || !isTimeStr(slot.end))
      throw new Error("rhythm slot times must be 'HH:MM'");
  }
}
function validate(next) {
  const dVeg = next?.meals?.donenessHints?.vegetables;
  if (dVeg && !ENUMS.donenessVeg.has(dVeg))
    throw new Error(`Invalid vegetables doneness: ${dVeg}`);
  const dMeat = next?.meals?.donenessHints?.meat;
  if (dMeat && !ENUMS.donenessMeat.has(dMeat))
    throw new Error(`Invalid meat doneness: ${dMeat}`);

  const day = next?.meals?.batchCooking?.sessionDay;
  if (day && !ENUMS.sessionDays.has(day))
    throw new Error(`Invalid sessionDay: ${day}`);
  const portions = next?.meals?.portions?.default;
  if (
    portions != null &&
    (!Number.isFinite(portions) || portions < 1 || portions > 20)
  ) {
    throw new Error("Portions must be between 1 and 20");
  }
  validateRhythm(next?.rhythm);
  if (
    next?.defaultGenerateDays &&
    (!Number.isFinite(next.defaultGenerateDays) || next.defaultGenerateDays < 1)
  ) {
    throw new Error("defaultGenerateDays must be a positive number");
  }
  return true;
}

/* --- Helpers used by selectors --- */
function kosherDisallowed(name, diet) {
  const k = String(name || "").toLowerCase();
  if (diet?.pork && /pork|bacon|ham|prosciutto|pepperoni/.test(k)) return true;
  if (
    diet?.shellfish &&
    /shrimp|prawn|lobster|crab|clam|oyster|scallop/.test(k)
  )
    return true;
  return false;
}
function calcEffectivePortions(state, overrides = {}) {
  const base = state.meals?.portions || DEFAULTS.meals.portions;
  const adults = overrides.adults ?? base.adults ?? 2;
  const children = overrides.children ?? base.children ?? 2;
  const perAdult = 1;
  const perChild = 0.6;
  const total = Math.round(adults * perAdult + children * perChild);
  return Math.max(total, base.default || 4);
}
function isSabbathAware(state) {
  return !!(state?.observance?.sabbathAware ?? state?.calendar?.sabbathAware);
}

/* --- minimal HTTP helper (optional server sync) --- */
async function httpJSON(method, url, body, headers = {}) {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`HTTP ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json().catch(() => ({}));
}

function createEmitter() {
  const subs = new Set();
  return {
    emit: (s) =>
      subs.forEach((fn) => {
        try {
          fn(s);
        } catch {}
      }),
    subscribe: (fn) => {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    size: () => subs.size,
  };
}

/* ----------------------------------------------------------------------------
   Store factory
---------------------------------------------------------------------------- */
export function createMealPrefsStore(initial = {}) {
  // Migration: bring over older versions if present
  let migrated = {};
  try {
    const legacyRaw = localStorage.getItem("suka.mealprefs.v1");
    if (legacyRaw) migrated = JSON.parse(legacyRaw);
  } catch {}
  let state = deepMerge(DEFAULTS, deepMerge(migrated, initial || {}));

  let serverBaseUrl = null;
  let socket = null;
  let userId = null;
  const emitter = createEmitter();
  const bc =
    typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(BC_NAME)
      : null;

  // cross-tab listener
  bc?.addEventListener?.("message", (ev) => {
    if (!ev?.data || ev.data.type !== "patch") return;
    state = deepMerge(state, ev.data.patch || {});
    emitter.emit(clone(state));
  });

  const persistLocal = debounce(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {}
  }, 200);

  function notify(patchObj = {}) {
    persistLocal();
    // include patch for other tabs to merge (idempotent)
    bc?.postMessage?.({ type: "patch", patch: patchObj });
    emitter.emit(clone(state));
  }

  async function init({ baseUrl = null, socketIO = null, user = null } = {}) {
    serverBaseUrl = baseUrl;
    socket = socketIO || null;
    userId = user || null;

    // hydrate from localStorage
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) state = deepMerge(state, JSON.parse(raw));
    } catch {}

    // hydrate from server (merged)
    if (serverBaseUrl) {
      try {
        const data = await httpJSON("GET", `${serverBaseUrl}/preferences`);
        if (data && typeof data === "object") {
          state = deepMerge(state, data);
        }
      } catch (_) {
        /* non-fatal */
      }
    }

    // wire socket live updates
    if (socket && socket.on) {
      const handler = (payload) => {
        if (payload?.patch) {
          state = deepMerge(state, payload.patch);
          notify(payload.patch);
        } else if (payload?.path && payload?.value !== undefined) {
          set(payload.path, payload.value, { silentServer: true });
        }
      };
      socket.on("preferences:update", handler);
      state._socketHandler = handler;
    }

    notify();
    return clone(state);
  }

  // ---------- Core mutators ----------
  async function saveToServer(patchObj) {
    if (!serverBaseUrl) return;
    try {
      await httpJSON("PATCH", `${serverBaseUrl}/preferences`, patchObj);
    } catch {
      /* non-fatal */
    }
  }

  function getState() {
    return clone(state);
  }
  function get(dot, fallback) {
    return getAtPath(state, dot, fallback);
  }

  function set(dot, value, opts = {}) {
    const next = clone(state);
    setAtPath(next, dot, value);
    validate(next);
    state = next;
    notify({ [dot]: value });
    if (!opts.silentServer) saveToServer({ [dot]: value }).catch(() => {});
    return value;
  }

  function patch(obj, opts = {}) {
    if (!isObj(obj)) throw new Error("patch() expects an object");
    const next = deepMerge(state, obj);
    validate(next);
    state = next;
    notify(obj);
    if (!opts.silentServer) saveToServer(obj).catch(() => {});
    return clone(state);
  }

  function reset(section = null, opts = {}) {
    if (!section) {
      state = clone(DEFAULTS);
      notify(DEFAULTS);
      if (!opts.silentServer) saveToServer(DEFAULTS).catch(() => {});
      return;
    }
    const next = clone(state);
    next[section] = clone(DEFAULTS[section] || {});
    validate(next);
    state = next;
    const body = { [section]: DEFAULTS[section] || {} };
    notify(body);
    if (!opts.silentServer) saveToServer(body).catch(() => {});
  }

  // ---------- Selectors / helpers ----------
  function effectivePortions(overrides = {}) {
    return calcEffectivePortions(state, overrides);
  }
  function isIngredientAllowed(name) {
    // honor both legacy meals.diet and new dietary exclusions
    const legacyDiet = state.meals?.diet || {};
    if (kosherDisallowed(name, legacyDiet)) return false;
    const excluded = (state.dietary?.exclusions || []).map((s) =>
      String(s).toLowerCase()
    );
    return !excluded.some((x) =>
      String(name || "")
        .toLowerCase()
        .includes(x)
    );
  }
  function sabbathAware() {
    return isSabbathAware(state);
  }
  function nextBatchSessionDate(fromDate = new Date()) {
    // prefer new batchCooking; fall back to legacy
    const prefs = state.batchCooking?.enabled ? state.batchCooking : null;
    if (prefs) {
      const days = [0, 1, 2, 3, 4, 5, 6];
      const active = (prefs.daysOfWeek || [0]).filter((d) => days.includes(d));
      if (active.length === 0) return null;
      const d = new Date(fromDate);
      const cur = d.getDay();
      let bestDiff = Infinity;
      let targetDow = cur;
      for (const dow of active) {
        const diff = (dow - cur + 7) % 7 || 7;
        if (diff < bestDiff) {
          bestDiff = diff;
          targetDow = dow;
        }
      }
      void targetDow;
      d.setDate(d.getDate() + bestDiff);
      const [hh, mm] = String(prefs.defaultStart || "14:00")
        .split(":")
        .map((n) => parseInt(n, 10));
      d.setHours(hh || 14, mm || 0, 0, 0);
      return d.toISOString();
    }
    // legacy path
    const enabled = !!state.meals?.batchCooking?.enabled;
    if (!enabled) return null;
    const target = (
      state.meals.batchCooking.sessionDay || "Sunday"
    ).toLowerCase();
    const names = [
      "sunday",
      "monday",
      "tuesday",
      "wednesday",
      "thursday",
      "friday",
      "saturday",
    ];
    const idx = names.indexOf(target);
    if (idx < 0) return null;
    const d = new Date(fromDate);
    const current = d.getDay();
    const diff = (idx - current + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    d.setHours(state.meals.batchCooking.sessionHour ?? 14, 0, 0, 0);
    return d.toISOString();
  }

  // ---------- Observable API ----------
  function subscribe(fn) {
    return emitter.subscribe(fn);
  }

  function destroy() {
    try {
      if (socket && state._socketHandler && socket.off) {
        socket.off("preferences:update", state._socketHandler);
      }
    } catch {}
    bc?.close?.();
  }

  // ---------- d.ts-compatible façade ----------
  async function getAsync() {
    return clone(state);
  }
  async function setAsync(nextPartial) {
    if (!isObj(nextPartial)) throw new Error("set(partial) expects an object");
    patch(nextPartial);
  }
  function onChange(listener) {
    return subscribe(listener);
  }

  return {
    // lifecycle
    init,
    destroy,
    // state access (ergonomic)
    getState,
    get,
    set,
    patch,
    reset,
    subscribe,
    // selectors
    effectivePortions,
    isIngredientAllowed,
    sabbathAware,
    nextBatchSessionDate,
    // d.ts facade (avoid duplicate keys)
    getAsync,
    setAsync,
    onChange,
  };
}

// Default singleton (ESM)
const MealPrefsStore = createMealPrefsStore();
export default MealPrefsStore;

// CommonJS interop for code that does `const store = require(...)`
try {
  // eslint-disable-next-line no-undef
  if (typeof module !== "undefined" && module.exports) {
    // eslint-disable-next-line no-undef
    module.exports = MealPrefsStore;
    // eslint-disable-next-line no-undef
    module.exports.createMealPrefsStore = createMealPrefsStore;
  }
} catch {}

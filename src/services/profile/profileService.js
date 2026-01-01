// src/services/profile/profileService.js
/* eslint-disable no-console */

/**
 * Suka Smart Assistant — Profile Service
 * -------------------------------------------------------------
 * 1) Clear IA: emits route + UI glue events for onboarding/next steps.
 * 2) Intuitive flows: optimistic updates, confirmables, empty states.
 * 3) Consistent design system: toasts, pending/ready, confirmations.
 * 4) Event-driven glue: emits canonical events on change; offers Undo.
 *
 * Persistence: localStorage (pluggable). No external deps.
 */

import {
  events,
  NAMES,
  buildEvent,
  emitEvent,
} from "@/services/events/contracts";

/* ──────────────────────────────────────────────────────────────
 * Storage adapter (swap for IndexedDB/remote if needed)
 * ────────────────────────────────────────────────────────────── */
const STORAGE_KEY = "suka.profile.v1";

const storage = {
  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (err) {
      console.error("[profile] storage load error:", err);
      return null;
    }
  },
  save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      return true;
    } catch (err) {
      console.error("[profile] storage save error:", err);
      return false;
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
      return true;
    } catch (err) {
      console.error("[profile] storage clear error:", err);
      return false;
    }
  },
};

/* ──────────────────────────────────────────────────────────────
 * Schema, defaults, and validation
 * ────────────────────────────────────────────────────────────── */
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isString = (v) => typeof v === "string";
const isBool = (v) => typeof v === "boolean";
const isNum = (v) => Number.isFinite(v);

const DEFAULT_PROFILE = Object.freeze({
  version: 1,
  userId: null, // becomes "user:<id>" when auth integrated
  displayName: "",
  email: "",
  // Dietary / Torah toggles & household rules
  torah: {
    shellfishAllowed: false,  // user-selectable per your rule
    effectiveDate: null,      // ISO string when change becomes active
    notes: "",                // free text

    // NEW: Sabbath guard (local-time anchors; user-editable)
    sabbath: {
      enabled: true,
      start: { day: 5, hour: 18, minute: 0 }, // Friday 18:00
      end:   { day: 6, hour: 20, minute: 0 }, // Saturday 20:00
      allowEssentials: true,
      exceptions: [], // array of YYYY-MM-DD strings to skip guard
    },

    // NEW: Household-defined rules (simple JSON; user curated)
    rules: [
      // examples (off by default — household chooses):
      // { id:"no-pork",          enabled:false, type:"avoidIngredients", anyOf:["pork","boar"], effect:"exclude", label:"Avoid pork" },
      // { id:"no-blood",         enabled:false, type:"avoidTags",        anyOf:["blood"],       effect:"exclude", label:"No blood" },
      // { id:"humane-slaughter", enabled:false, type:"requireTags",      allOf:["humane"],      effect:"warn",    label:"Prefer humane slaughter" },
      // { id:"unleavened-week",  enabled:false, type:"calendarWindow",   window:"unleavened",   effect:"exclude", label:"No leaven during Unleavened Bread" },
      // { id:"dairy-with-meat",  enabled:false, type:"avoidPairing",     pair:["meat","dairy"], effect:"warn",    label:"Avoid mixing meat & dairy" },
    ],
  },
  // UI preferences (future expansion)
  ui: {
    theme: "light",
    compact: false,
  },
  // Audit
  createdAt: null,
  updatedAt: null,
});

function validateSabbath(s) {
  if (!isObj(s)) return "torah.sabbath must be an object";
  if (!("enabled" in s) || !isBool(s.enabled)) return "torah.sabbath.enabled must be boolean";
  const start = s.start || {};
  const end = s.end || {};
  if (!isNum(start.day) || !isNum(start.hour)) return "torah.sabbath.start must include numeric day/hour";
  if (!isNum(end.day) || !isNum(end.hour)) return "torah.sabbath.end must include numeric day/hour";
  if (!("allowEssentials" in s) || !isBool(s.allowEssentials)) return "torah.sabbath.allowEssentials must be boolean";
  if (!Array.isArray(s.exceptions)) return "torah.sabbath.exceptions must be an array of dates";
  return true;
}

function validateRules(rules) {
  if (!Array.isArray(rules)) return "torah.rules must be an array";
  for (const r of rules) {
    if (!isObj(r)) return "each torah.rules item must be an object";
    if (!r.id || !isString(r.id)) return "torah.rules item missing string id";
    if (!("enabled" in r) || !isBool(r.enabled)) return `rule "${r.id}" missing boolean enabled`;
    if (!r.type || !isString(r.type)) return `rule "${r.id}" missing string type`;
    if (r.effect && !["warn","exclude"].includes(r.effect)) return `rule "${r.id}" effect must be "warn" or "exclude"`;
  }
  return true;
}

function validateProfile(p) {
  if (!isObj(p)) return "Profile must be an object";
  if (!("version" in p)) return "Missing version";
  if (!isObj(p.torah)) return "Missing torah object";

  if (!("shellfishAllowed" in p.torah) || !isBool(p.torah.shellfishAllowed))
    return "torah.shellfishAllowed must be boolean";
  if (p.torah.effectiveDate && !isString(p.torah.effectiveDate))
    return "torah.effectiveDate must be ISO string or null";

  if ("sabbath" in p.torah) {
    const vs = validateSabbath(p.torah.sabbath);
    if (vs !== true) return vs;
  }
  if ("rules" in p.torah) {
    const vr = validateRules(p.torah.rules);
    if (vr !== true) return vr;
  }

  if (!("ui" in p) || !isObj(p.ui)) return "Missing ui object";
  if (!("theme" in p.ui)) return "Missing ui.theme";
  return true;
}

function migrateProfile(p) {
  // For future schema migrations. Currently version 1.
  // Ensure new keys exist for previously-saved profiles.
  const withTorah = p.torah || {};
  if (!("sabbath" in withTorah)) {
    withTorah.sabbath = { ...DEFAULT_PROFILE.torah.sabbath };
  }
  if (!("rules" in withTorah)) {
    withTorah.rules = [...DEFAULT_PROFILE.torah.rules];
  }
  return { ...p, torah: withTorah };
}

/* ──────────────────────────────────────────────────────────────
 * Tiny reactive store (subscribe / notify)
 * ────────────────────────────────────────────────────────────── */
const subscribers = new Set();
/** @type {ReturnType<typeof buildState>} */
let state;

function buildState() {
  const loaded = storage.load();
  let profile =
    (loaded && migrateProfile(loaded)) || {
      ...DEFAULT_PROFILE,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

  // Show empty state CTA if first-time user (no displayName/email)
  if (!loaded) {
    try {
      events.emit(
        buildEvent(
          NAMES["ui.empty.presented"],
          {
            context: "profile.onboarding",
            actions: [
              {
                label: "Set Up Profile",
                eventName: NAMES["ia.route.navigated"],
                payload: { path: "/profile/setup" },
              },
              {
                label: "Skip & Plan Meals",
                eventName: NAMES["ia.route.navigated"],
                payload: { path: "/tier2/household/meals" },
              },
            ],
          },
          { source: "profileService" }
        )
      );
    } catch (err) {
      console.warn("[profile] empty state emit failed:", err);
    }
  }

  return {
    profile,
    pendingKeys: new Set(), // e.g., "profile:update", "profile:reset"
  };
}

function notify() {
  for (const cb of subscribers) {
    try {
      cb(state.profile);
    } catch (err) {
      console.error("[profile] subscriber error:", err);
    }
  }
}

/* ──────────────────────────────────────────────────────────────
 * Helpers: pending/ready + toast
 * ────────────────────────────────────────────────────────────── */
function setPending(key, on = true) {
  const already = state.pendingKeys.has(key);
  if (on && !already) {
    state.pendingKeys.add(key);
    events.emit(buildEvent(NAMES["ui.state.pending"], { key }, { source: "profileService" }));
  } else if (!on && already) {
    state.pendingKeys.delete(key);
    events.emit(buildEvent(NAMES["ui.state.ready"], { key }, { source: "profileService" }));
  }
}

function toast(variant, title, message) {
  try {
    events.emit(
      buildEvent(
        NAMES["ui.toast.shown"],
        { variant, title, message },
        { source: "profileService" }
      )
    );
  } catch (err) {
    console.warn("[profile] toast emit failed:", err);
  }
}

/* ──────────────────────────────────────────────────────────────
 * Core mutators (with optimistic + undo)
 * ────────────────────────────────────────────────────────────── */
function save(profile, opts = { silent: false }) {
  const v = validateProfile(profile);
  if (v !== true) throw new Error(`Profile validation failed: ${v}`);
  profile.updatedAt = new Date().toISOString();
  storage.save(profile);
  state.profile = profile;
  if (!opts.silent) notify();
  return profile;
}

function update(partial, opts = {}) {
  const key = "profile:update";
  setPending(key, true);
  const prev = state.profile;
  const next = {
    ...prev,
    ...partial,
    torah: { ...prev.torah, ...(partial.torah || {}) },
    ui: { ...prev.ui, ...(partial.ui || {}) },
  };
  const saved = save(next);

  // Offer Undo
  const undoSpec = {
    label: "Undo",
    handler: () => {
      save(prev);
      toast("info", "Changes reverted", "Your profile was restored.");
    },
  };

  // Canonical emission when dietary toggle changed
  if (
    partial.torah &&
    Object.prototype.hasOwnProperty.call(partial.torah, "shellfishAllowed")
  ) {
    emitEvent(
      NAMES["torah.profile.updated"],
      {
        shellfishAllowed: saved.torah.shellfishAllowed,
        effectiveDate: saved.torah.effectiveDate || new Date().toISOString(),
        notes: saved.torah.notes || "",
      },
      {
        source: "profileService",
        undo: undoSpec,
      }
    );
  }

  // UX glue for Sabbath/rules changes
  if (partial.torah && (partial.torah.sabbath || partial.torah.rules)) {
    // Single NBA
    events.emit(
      buildEvent(
        NAMES["ui.nba.suggested"],
        {
          label: "Recompute Meal Suggestions",
          hint: "Update menus & shopping list",
          route: "/tier2/household/meals",
        },
        { source: "profileService" }
      )
    );
    // Toast
    toast("success", "Household rules updated", "Your preferences were saved.");
    // Offer Undo for Sabbath/Rules as well
    events.emit(
      buildEvent(NAMES["ui.undo.offered"], { label: "Undo", ttlMs: 7000 }, { source: "profileService" })
    );
    const undoHandler = () => {
      save(prev);
      toast("info", "Changes reverted", "Your rules and Sabbath settings were restored.");
      events.off(NAMES["ui.undo.triggered"], undoHandler);
    };
    events.on(NAMES["ui.undo.triggered"], undoHandler, { once: true });
  }

  setPending(key, false);
  // Generic toast if not already shown by special cases
  if (!(partial.torah && (partial.torah.sabbath || partial.torah.rules))) {
    toast("success", "Profile updated", "Your changes were saved.");
  }
  return saved;
}

/**
 * Explicit API to update ONLY the Torah dietary toggles with safety rails.
 * @param {{ shellfishAllowed:boolean, effectiveDate?:string, notes?:string }} input
 * @param {{ optimistic?: boolean }} [options]
 */
function setTorahProfile(input, options = { optimistic: true }) {
  const { shellfishAllowed, effectiveDate, notes } = input || {};
  if (typeof shellfishAllowed !== "boolean")
    throw new Error("shellfishAllowed must be boolean");

  const prev = state.profile;
  const key = "profile:torah";

  setPending(key, true);

  // Optimistic apply
  const optimisticNext = {
    ...prev,
    torah: {
      ...prev.torah,
      shellfishAllowed,
      effectiveDate: effectiveDate || new Date().toISOString(),
      notes: notes ?? prev.torah.notes,
    },
  };

  if (options.optimistic) {
    state.profile = optimisticNext;
    notify();
  }

  // Commit (synchronous here; replace with async if remote)
  const committed = save(optimisticNext, { silent: !options.optimistic });

  // Offer Undo and emit canonical event
  emitEvent(
    NAMES["torah.profile.updated"],
    {
      shellfishAllowed: committed.torah.shellfishAllowed,
      effectiveDate: committed.torah.effectiveDate,
      notes: committed.torah.notes || "",
    },
    {
      source: "profileService.setTorahProfile",
      undo: {
        label: "Undo",
        handler: () => {
          save(prev);
          toast("info", "Dietary change reverted", "Torah profile restored.");
        },
      },
    }
  );

  setPending(key, false);
  toast(
    "success",
    "Dietary profile updated",
    committed.torah.shellfishAllowed
      ? "Shellfish now included per your selection."
      : "Shellfish excluded per your selection."
  );

  return committed;
}

/**
 * NEW: Replace full rules array (atomic).
 * @param {Array} rules
 */
function setTorahRules(rules) {
  return update({ torah: { rules: Array.isArray(rules) ? rules : [] } });
}

/**
 * NEW: Toggle a rule by id (create if missing).
 * @param {string} ruleId
 * @param {boolean} enabled
 * @param {Partial<{type:string,effect:"warn"|"exclude",label:string, anyOf:any, allOf:any, pair:any, window:any}>} [defaults]
 */
function toggleRule(ruleId, enabled, defaults = {}) {
  const prev = get();
  const rules = [...(prev.torah?.rules || [])];
  const idx = rules.findIndex((r) => r.id === ruleId);
  if (idx >= 0) {
    rules[idx] = { ...rules[idx], enabled: !!enabled };
  } else {
    rules.push({
      id: ruleId,
      enabled: !!enabled,
      type: defaults.type || "custom",
      effect: defaults.effect || "warn",
      label: defaults.label || ruleId,
      ...defaults,
    });
  }
  return setTorahRules(rules);
}

/**
 * NEW: Update Sabbath configuration (merged).
 * @param {{enabled?:boolean,start?:{day?:number,hour?:number,minute?:number},end?:{day?:number,hour?:number,minute?:number},allowEssentials?:boolean,exceptions?:string[]}} sabbathPartial
 */
function setSabbath(sabbathPartial = {}) {
  const prev = get();
  const merged = {
    ...prev.torah.sabbath,
    ...sabbathPartial,
    start: { ...prev.torah.sabbath.start, ...(sabbathPartial.start || {}) },
    end:   { ...prev.torah.sabbath.end,   ...(sabbathPartial.end || {}) },
  };
  return update({ torah: { sabbath: merged } });
}

/**
 * Reset profile (asks UI to confirm by emitting a confirm-request event).
 * Consumers should listen for confirm result and call `applyReset()` if yes.
 */
function requestReset() {
  const onConfirmId = "profile.reset.confirmed";

  events.emit(
    buildEvent(
      NAMES["ui.dialog.confirm.requested"],
      {
        title: "Reset Profile?",
        message:
          "This will clear your profile data on this device. You can’t undo this after confirmation.",
        confirmLabel: "Reset",
        cancelLabel: "Cancel",
        onConfirmId,
      },
      { source: "profileService" }
    )
  );

  // When UI confirms, we perform reset
  const unsub = events.on(onConfirmId, () => {
    unsub();
    applyReset();
  });
}

function applyReset() {
  const key = "profile:reset";
  setPending(key, true);

  const prev = state.profile;
  storage.clear();
  state.profile = {
    ...DEFAULT_PROFILE,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  notify();

  // Offer Undo of destructive reset
  emitEvent(
    NAMES["ui.undo.offered"],
    { label: "Undo Reset", ttlMs: 8000 },
    {
      source: "profileService.applyReset",
      // glue event only; real undo handler below:
    }
  );

  // Implement actual undo via our own listener during TTL window
  let undone = false;
  const undoHandler = () => {
    if (undone) return;
    undone = true;
    save(prev);
    notify();
    toast("info", "Profile restored", "Reset was undone.");
    cleanup();
  };
  const cleanup = () => {
    events.off(undoEventHandler);
    setPending(key, false);
  };
  const undoEventHandler = (ev) => {
    if (ev.name === NAMES["ui.undo.triggered"]) undoHandler();
  };
  events.on(NAMES["ui.undo.triggered"], undoEventHandler);

  // Auto-cleanup after TTL (UI is responsible for timing, but we guard anyway)
  setTimeout(() => {
    if (!undone) cleanup();
  }, 8500);

  toast("warning", "Profile reset", "Your profile has been cleared.");
}

/* ──────────────────────────────────────────────────────────────
 * Selectors & public API
 * ────────────────────────────────────────────────────────────── */
function get() {
  return state.profile;
}

/**
 * Subscribe to profile changes. Returns unsubscribe fn.
 * @param {(profile:any)=>void} cb
 */
function subscribe(cb) {
  subscribers.add(cb);
  // immediate sync
  try {
    cb(state.profile);
  } catch (err) {
    console.error("[profile] subscriber immediate error:", err);
  }
  return () => subscribers.delete(cb);
}

/**
 * Initialize service. Call once at app bootstrap (idempotent).
 * Emits an IA nav event if needed (optional).
 */
function init() {
  if (state) return state.profile;
  state = buildState();
  // Optional: announce ready state or route suggestion
  events.emit(
    buildEvent(
      NAMES["ia.route.navigated"],
      { path: window?.location?.pathname || "/" },
      { source: "profileService.init" }
    )
  );
  return state.profile;
}

/* ──────────────────────────────────────────────────────────────
 * Event-driven UI glue examples (listeners)
 *  - If other domains change, we could annotate/profile stats, etc.
 *  - Keep lightweight; orchestrators handle heavy recompute.
 * ────────────────────────────────────────────────────────────── */
function wireGlue() {
  // Example: if meal plan gets published, nudge user to review profile prefs
  events.on(NAMES["meal.plan.published"], () => {
    events.emit(
      buildEvent(
        NAMES["ui.nba.suggested"],
        {
          label: "Review Dietary Preferences",
          hint: "Ensure your meal plan matches your Torah profile",
          route: "/profile",
        },
        { source: "profileService.glue" }
      )
    );
  });

  // Example: when calendar events created, suggest setting effectiveDate if empty
  events.on(NAMES["calendar.events.created"], () => {
    const p = get();
    if (!p.torah.effectiveDate) {
      events.emit(
        buildEvent(
          NAMES["ui.nba.suggested"],
          {
            label: "Set Effective Date",
            hint: "Lock in your dietary profile start date",
            route: "/profile",
          },
          { source: "profileService.glue" }
        )
      );
    }
  });
}

/* ──────────────────────────────────────────────────────────────
 * Module export
 * ────────────────────────────────────────────────────────────── */
const profileService = {
  init,
  get,
  subscribe,
  update,
  setTorahProfile,
  setTorahRules,   // NEW
  toggleRule,      // NEW
  setSabbath,      // NEW
  requestReset,
  applyReset, // exposed for advanced flows/testing
};

export default profileService;

/* ──────────────────────────────────────────────────────────────
 * Auto-init & glue wiring (safe in browser-only envs)
 * ────────────────────────────────────────────────────────────── */
try {
  profileService.init();
  wireGlue();
} catch (err) {
  console.error("[profile] initialization error:", err);
}

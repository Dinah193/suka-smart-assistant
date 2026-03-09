// C:\Users\larho\suka-smart-assistant\src\services\farmToTable\CuisineResolver.js
/* eslint-disable no-console */
/**
 * SSA • Farm-to-Table / Homestead CuisineResolver
 * -----------------------------------------------------------------------------
 * Deterministic cuisine selection + rotation engine used by:
 *  - homesteadplanner/cuisines.jsx (selection, rotation)
 *  - preference resolution (cuisine defaults merged into taste cards / tag affinities)
 *  - meal planning / provisioning strategy (“what we plan next”)
 *
 * Responsibilities
 *  1) Normalize cuisine profiles (from Dexie/JSON)
 *  2) Determine active cuisine(s) based on:
 *     - manual selection
 *     - rotation mode: weekly/monthly/feast_overrides
 *     - optional schedule constraints (days of week, seasons, feast windows)
 *  3) Produce a "cuisine context pack" to feed PreferenceResolver:
 *     {
 *       activeCuisineIds: [],
 *       weights: { preferTags: [], preferMethods: [] },
 *       taste: { cards: { ... } },
 *       constraints: { ... optional adds ... },
 *       meta: { mode, pickedForISO, windowKey, reasons[] }
 *     }
 *  4) Provide explainable outputs for UI
 *
 * Public API
 *  - resolveActiveCuisine(state, profiles, context)
 *  - buildCuisinePreferenceLayer(active, profiles, context)
 *  - rotateCuisineIds(state, context) -> next plan (deterministic)
 *  - explainActive(active, profiles) -> string[]
 *
 * This file is browser-safe and does NOT require Node.
 */

const SOURCE = "services/farmToTable/CuisineResolver";

const DEFAULTS = {
  // Rotation behavior
  rotation: {
    mode: "manual", // manual | weekly | monthly | feast_overrides
    // if weekly, which day starts the rotation week (0=Sun ... 6=Sat)
    weekStartDow: 0,
    // if monthly, start at day 1
    monthStartDay: 1,
    // deterministic tie-breaking
    seedSalt: "ssa-cuisine",
    // If multiple cuisines are allowed concurrently, cap them
    maxActive: 1,
  },

  // Weight merging behavior
  merge: {
    // For multi-cuisine active sets, union tags/methods and average taste cards.
    multiCuisineTaste: "average", // average | max | sum
  },

  // Feast override defaults (if user supplies context.feastKey)
  feastOverrides: {
    // Example:
    // "passover": { preferTags:["lamb","bitter_herbs"], forbidTags:["leavened"], preferMethods:["roasting"] }
  },
};

export const CuisineResolver = {
  resolveActiveCuisine,
  buildCuisinePreferenceLayer,
  rotateCuisineIds,
  explainActive,
  normalizeCuisineProfile,
  normalizeCuisineProfiles,
};

/**
 * state:
 *  {
 *    selectedCuisineIds: string[], // user-selected pool for rotation
 *    activeCuisineIds: string[],   // current active set (may be stored)
 *    rotationMode: "manual"|"weekly"|"monthly"|"feast_overrides",
 *    maxActive?: number,
 *    weekStartDow?: number,
 *    monthStartDay?: number,
 *    lastPickedAtISO?: string
 *  }
 *
 * profiles: array of cuisine profiles (see normalizeCuisineProfile)
 *
 * context:
 *  {
 *    nowISO?: string,
 *    timezoneOffsetMinutes?: number, // optional
 *    feastKey?: string,              // optional feast override key
 *    seasonKey?: string,             // optional
 *    dayOfWeek?: number,             // optional 0..6
 *    forcePick?: boolean,            // force recompute even if same window
 *  }
 */
export function resolveActiveCuisine(state = {}, profiles = [], context = {}) {
  const cfg = mergeCfg(state);
  const nowISO = context.nowISO || new Date().toISOString();

  const pool = uniqStrings(state.selectedCuisineIds || []);
  const normalizedProfiles = normalizeCuisineProfiles(profiles);

  // Validate pool against available profiles
  const availableIds = new Set(normalizedProfiles.map((p) => toLower(p.id)));
  const poolValid = pool.filter((id) => availableIds.has(toLower(id)));

  const reasons = [];
  if (!poolValid.length) {
    // fallback: if no selected pool, use all profiles (stable order)
    reasons.push("No selected cuisines; using all available profiles.");
  }

  const pickFrom = poolValid.length
    ? poolValid
    : normalizedProfiles.map((p) => p.id);

  // Feast override: keep cuisine picks but allow override layer to bias
  const feastKey = safeStr(context.feastKey);
  const windowKey = computeWindowKey(
    cfg.rotation.mode,
    nowISO,
    cfg.rotation,
    context
  );

  // If manual mode: honor state.activeCuisineIds if valid, else first of pickFrom
  if (cfg.rotation.mode === "manual") {
    const active = uniqStrings(state.activeCuisineIds || []).filter((id) =>
      availableIds.has(toLower(id))
    );
    const chosen = active.length
      ? active.slice(0, cfg.rotation.maxActive)
      : pickFrom.slice(0, cfg.rotation.maxActive);

    return {
      activeCuisineIds: chosen,
      poolCuisineIds: pickFrom,
      meta: {
        mode: "manual",
        pickedForISO: nowISO,
        windowKey,
        feastKey: feastKey || null,
        reasons: active.length
          ? ["Manual mode: used stored active cuisines."]
          : ["Manual mode: used first cuisine in pool."],
      },
    };
  }

  // Rotation modes: weekly/monthly/feast_overrides
  const lastWindow = safeStr(state.lastWindowKey);
  const shouldRecompute =
    !!context.forcePick || !lastWindow || lastWindow !== windowKey;

  // If not recompute and state has active cuisines, reuse (stable)
  if (!shouldRecompute) {
    const active = uniqStrings(state.activeCuisineIds || []).filter((id) =>
      availableIds.has(toLower(id))
    );
    if (active.length) {
      return {
        activeCuisineIds: active.slice(0, cfg.rotation.maxActive),
        poolCuisineIds: pickFrom,
        meta: {
          mode: cfg.rotation.mode,
          pickedForISO: nowISO,
          windowKey,
          feastKey: feastKey || null,
          reasons: ["Reused active cuisines for same rotation window."],
        },
      };
    }
  }

  // Deterministic pick:
  //  - choose N cuisines by hashing windowKey + seedSalt + index
  const picked = pickDeterministic(
    pickFrom,
    cfg.rotation.maxActive,
    `${cfg.rotation.seedSalt}|${windowKey}`
  );

  reasons.push(
    `Rotation mode "${cfg.rotation.mode}" picked cuisines for window "${windowKey}".`
  );

  return {
    activeCuisineIds: picked,
    poolCuisineIds: pickFrom,
    meta: {
      mode: cfg.rotation.mode,
      pickedForISO: nowISO,
      windowKey,
      feastKey: feastKey || null,
      reasons,
    },
  };
}

/**
 * Convert active cuisine selection to a PreferenceResolver "layer" object.
 * This is what you pass as input.cuisine into PreferenceResolver.resolvePreferences().
 *
 * Returns a cuisine-layer object shaped like:
 *  {
 *    cuisine: { activeCuisineIds, rotationMode, weights: { preferTags, preferMethods } },
 *    taste: { cards: { ... } },
 *    constraints: { forbiddenTags?, allergens?, dislikes? } // optional additions
 *  }
 */
export function buildCuisinePreferenceLayer(
  activeSelection,
  profiles = [],
  context = {}
) {
  const normalized = normalizeCuisineProfiles(profiles);
  const byId = new Map(normalized.map((p) => [toLower(p.id), p]));

  const ids = uniqStrings(activeSelection?.activeCuisineIds || []);
  const actives = ids.map((id) => byId.get(toLower(id))).filter(Boolean);

  const meta = activeSelection?.meta || {};
  const mode = meta.mode || "manual";

  // Feast override pack (optional)
  const feastKey = safeStr(meta.feastKey || context.feastKey);
  const feast = feastKey
    ? DEFAULTS.feastOverrides[feastKey] || context.feastOverride || null
    : null;

  // Merge tags/methods across actives
  const preferTags = uniqLower(actives.flatMap((p) => p.preferTags || []));
  const preferMethods = uniqLower(
    actives.flatMap((p) => p.preferMethods || [])
  );

  // Apply feast override biases
  const forbidTags = uniqLower([
    ...(feast?.forbidTags || []),
    ...(context?.forbiddenTags || []),
  ]);
  const feastPreferTags = uniqLower([
    ...(feast?.preferTags || []),
    ...(context?.likedTags || []),
  ]);
  const feastPreferMethods = uniqLower([
    ...(feast?.preferMethods || []),
    ...(context?.preferMethods || []),
  ]);

  const mergedPreferTags = uniqLower(preferTags.concat(feastPreferTags));
  const mergedPreferMethods = uniqLower(
    preferMethods.concat(feastPreferMethods)
  );

  // Merge taste cards
  const taste = mergeTasteCards(
    actives.map((p) => p.tasteCards || {}),
    DEFAULTS.merge.multiCuisineTaste
  );

  // Build output layer
  const layer = {
    cuisine: {
      activeCuisineIds: actives.map((p) => p.id),
      rotationMode: mode,
      weights: {
        preferTags: mergedPreferTags,
        preferMethods: mergedPreferMethods,
      },
      meta: {
        windowKey: meta.windowKey || null,
        feastKey: feastKey || null,
        reasons: meta.reasons || [],
      },
    },
    taste: { cards: taste },
  };

  // Optional constraints additions (forbidTags)
  if (forbidTags.length) {
    layer.constraints = layer.constraints || {};
    layer.constraints.forbiddenTags = forbidTags;
  }

  return layer;
}

/**
 * Compute next rotation plan (without needing profiles).
 * Useful for UI previews: "Next week you’ll rotate to X".
 */
export function rotateCuisineIds(state = {}, context = {}) {
  const cfg = mergeCfg(state);
  const nowISO = context.nowISO || new Date().toISOString();
  const pool = uniqStrings(state.selectedCuisineIds || []);
  const maxActive = cfg.rotation.maxActive;

  if (!pool.length) {
    return {
      nextActiveCuisineIds: [],
      meta: { message: "No selected cuisines; cannot preview rotation." },
    };
  }

  const currentWindow = computeWindowKey(
    cfg.rotation.mode,
    nowISO,
    cfg.rotation,
    context
  );
  const nextWindow = computeNextWindowKey(
    cfg.rotation.mode,
    nowISO,
    cfg.rotation,
    context
  );

  const currentPick = pickDeterministic(
    pool,
    maxActive,
    `${cfg.rotation.seedSalt}|${currentWindow}`
  );
  const nextPick = pickDeterministic(
    pool,
    maxActive,
    `${cfg.rotation.seedSalt}|${nextWindow}`
  );

  return {
    currentActiveCuisineIds: currentPick,
    nextActiveCuisineIds: nextPick,
    meta: {
      mode: cfg.rotation.mode,
      currentWindow,
      nextWindow,
      pickedForISO: nowISO,
    },
  };
}

/**
 * Human-friendly explanation for UI.
 */
export function explainActive(activeSelection, profiles = []) {
  const normalized = normalizeCuisineProfiles(profiles);
  const byId = new Map(normalized.map((p) => [toLower(p.id), p]));

  const ids = uniqStrings(activeSelection?.activeCuisineIds || []);
  const meta = activeSelection?.meta || {};
  const mode = meta.mode || "manual";

  const lines = [];
  lines.push(`Rotation mode: ${mode}`);
  if (meta.windowKey) lines.push(`Window: ${meta.windowKey}`);
  if (meta.feastKey) lines.push(`Feast override: ${meta.feastKey}`);

  if (!ids.length) {
    lines.push("Active cuisines: none");
    return lines;
  }

  const names = ids
    .map((id) => byId.get(toLower(id))?.name || id)
    .filter(Boolean);

  lines.push(`Active cuisines: ${names.join(", ")}`);

  // Add a compact summary of biases
  const actives = ids.map((id) => byId.get(toLower(id))).filter(Boolean);
  const tags = uniqLower(actives.flatMap((p) => p.preferTags || [])).slice(
    0,
    10
  );
  const methods = uniqLower(
    actives.flatMap((p) => p.preferMethods || [])
  ).slice(0, 10);

  if (tags.length) lines.push(`Prefer tags: ${tags.join(", ")}`);
  if (methods.length) lines.push(`Prefer methods: ${methods.join(", ")}`);

  if (Array.isArray(meta.reasons) && meta.reasons.length) {
    lines.push(...meta.reasons.map((r) => `• ${r}`));
  }

  return lines;
}

/* -----------------------------------------------------------------------------
 * Cuisine profile normalization
 * --------------------------------------------------------------------------- */

/**
 * Input cuisine profile can be flexible; we normalize it to:
 *  {
 *    id, name,
 *    preferTags: string[],
 *    preferMethods: string[],
 *    tasteCards: { heat, sweet, sour, salt, smoke, aromatics },
 *    constraints: { forbiddenTags? },
 *    notes?
 *  }
 */
export function normalizeCuisineProfile(raw) {
  if (!raw || typeof raw !== "object") return null;

  const name = safeStr(raw.name || raw.title || raw.id);
  if (!name) return null;

  const id = safeStr(raw.id || slugify(name));
  const preferTags = uniqLower(
    normalizeStringArray(raw.preferTags || raw.tags || raw.prefer_tags)
  );
  const preferMethods = uniqLower(
    normalizeStringArray(raw.preferMethods || raw.methods || raw.prefer_methods)
  );

  // Taste cards may be nested or flattened
  const cardsIn = raw.tasteCards || raw.taste?.cards || raw.taste || {};
  const tasteCards = normalizeTasteCards(cardsIn);

  const constraints =
    raw.constraints && typeof raw.constraints === "object"
      ? raw.constraints
      : {};
  const forbiddenTags = uniqLower(
    normalizeStringArray(
      constraints.forbiddenTags || constraints.forbidden_tags
    )
  );

  return {
    id,
    name,
    preferTags,
    preferMethods,
    tasteCards,
    constraints: forbiddenTags.length ? { forbiddenTags } : {},
    notes: safeStr(raw.notes || raw.description || ""),
  };
}

export function normalizeCuisineProfiles(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();

  for (const raw of arr) {
    const p = normalizeCuisineProfile(raw);
    if (!p) continue;
    const k = toLower(p.id);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }

  // Stable order by name then id
  out.sort(
    (a, b) =>
      (a.name || "").localeCompare(b.name || "") ||
      (a.id || "").localeCompare(b.id || "")
  );
  return out;
}

function normalizeTasteCards(cardsIn) {
  const out = {
    heat: 0,
    sweet: 0,
    sour: 0,
    salt: 0,
    smoke: 0,
    aromatics: 0,
  };

  if (!cardsIn || typeof cardsIn !== "object") return out;

  for (const k of Object.keys(out)) {
    const v = cardsIn[k];
    out[k] = clampNum(v, -2, 2);
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Deterministic rotation helpers
 * --------------------------------------------------------------------------- */

function computeWindowKey(mode, nowISO, rotationCfg, context) {
  const dt = new Date(nowISO);
  if (Number.isNaN(dt.getTime())) return `invalid:${mode}`;

  if (mode === "weekly" || mode === "feast_overrides") {
    const weekStartDow = clampInt(rotationCfg.weekStartDow ?? 0, 0, 6);
    const ymd = weekWindowStartYMD(dt, weekStartDow);
    return `wk:${ymd}`;
  }

  if (mode === "monthly") {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    return `mo:${y}-${m}`;
  }

  // default/manual
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `day:${y}-${m}-${d}`;
}

function computeNextWindowKey(mode, nowISO, rotationCfg, context) {
  const dt = new Date(nowISO);
  if (Number.isNaN(dt.getTime())) return `invalid:${mode}:next`;

  if (mode === "weekly" || mode === "feast_overrides") {
    const weekStartDow = clampInt(rotationCfg.weekStartDow ?? 0, 0, 6);
    const start = weekWindowStartDate(dt, weekStartDow);
    const next = new Date(start.getTime() + 7 * 86400000);
    const ymd = toYMD(next);
    return `wk:${ymd}`;
  }

  if (mode === "monthly") {
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth(); // 0..11
    const next = new Date(Date.UTC(y, m + 1, 1));
    return `mo:${toYMD(next).slice(0, 7)}`;
  }

  const nextDay = new Date(dt.getTime() + 86400000);
  return `day:${toYMD(nextDay)}`;
}

function weekWindowStartYMD(dt, weekStartDow) {
  return toYMD(weekWindowStartDate(dt, weekStartDow));
}

function weekWindowStartDate(dt, weekStartDow) {
  // Determine UTC day-of-week for dt
  const dow = dt.getUTCDay(); // 0..6
  let diff = dow - weekStartDow;
  if (diff < 0) diff += 7;
  const start = new Date(
    Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate())
  );
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

function toYMD(dt) {
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function pickDeterministic(poolIds, maxActive, seed) {
  const pool = (poolIds || []).slice();
  const n = Math.max(1, Math.min(maxActive || 1, pool.length));
  if (pool.length <= n) return pool.slice(0, n);

  // Use a seeded shuffle based on seed string
  const shuffled = seededShuffle(pool, seed);
  return shuffled.slice(0, n);
}

function seededShuffle(arr, seed) {
  const out = arr.slice();
  let s = stringToSeed(seed);
  for (let i = out.length - 1; i > 0; i--) {
    s = xorshift32(s);
    const j = Math.floor((s / 0xffffffff) * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function stringToSeed(str) {
  // FNV-1a 32-bit
  let h = 2166136261;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // ensure non-zero
  return h >>> 0 || 1;
}

function xorshift32(x) {
  let y = x >>> 0;
  y ^= y << 13;
  y ^= y >>> 17;
  y ^= y << 5;
  return y >>> 0;
}

/* -----------------------------------------------------------------------------
 * Taste merge for multi-cuisine
 * --------------------------------------------------------------------------- */

function mergeTasteCards(list, mode) {
  const cards = Array.isArray(list) ? list : [];
  const axes = ["heat", "sweet", "sour", "salt", "smoke", "aromatics"];

  if (!cards.length) {
    const z = {};
    for (const a of axes) z[a] = 0;
    return z;
  }

  const out = {};
  for (const a of axes) out[a] = 0;

  if (mode === "max") {
    for (const a of axes) {
      let best = -Infinity;
      for (const c of cards) {
        const v = clampNum(c?.[a], -2, 2);
        if (v > best) best = v;
      }
      out[a] = best === -Infinity ? 0 : best;
    }
    return out;
  }

  if (mode === "sum") {
    for (const a of axes) {
      let total = 0;
      for (const c of cards) total += clampNum(c?.[a], -2, 2);
      out[a] = clampNum(total, -2, 2);
    }
    return out;
  }

  // average (default)
  for (const a of axes) {
    let total = 0;
    for (const c of cards) total += clampNum(c?.[a], -2, 2);
    out[a] = clampNum(total / cards.length, -2, 2);
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Config + utilities
 * --------------------------------------------------------------------------- */

function mergeCfg(state) {
  const rotation = {
    ...DEFAULTS.rotation,
    ...(state || {}),
    ...(state.rotation || {}),
  };

  // Support flat overrides in state (rotationMode, weekStartDow, maxActive)
  rotation.mode =
    safeStr(state.rotationMode) || safeStr(rotation.mode) || "manual";
  rotation.weekStartDow = Number.isFinite(state.weekStartDow)
    ? state.weekStartDow
    : rotation.weekStartDow;
  rotation.monthStartDay = Number.isFinite(state.monthStartDay)
    ? state.monthStartDay
    : rotation.monthStartDay;
  rotation.maxActive = Number.isFinite(state.maxActive)
    ? state.maxActive
    : rotation.maxActive;

  return { rotation };
}

function safeStr(x) {
  return (x == null ? "" : String(x)).trim();
}

function toLower(s) {
  return (typeof s === "string" ? s : s == null ? "" : String(s))
    .trim()
    .toLowerCase();
}

function slugify(s) {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(min, Math.min(max, n));
}

function clampInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function normalizeStringArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((x) => (x == null ? "" : String(x)).trim()).filter(Boolean);
}

function uniqStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = safeStr(x);
    if (!s) continue;
    const k = toLower(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function uniqLower(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const s = toLower(x);
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

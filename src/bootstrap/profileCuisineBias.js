// src/bootstrap/profileCuisineBias.js
// Dynamic Cuisine Bias (profile + behavior + inventory)
// - Produces normalized weights per cuisine pack (e.g., "africanAmerican", "westAfrican")
// - Reacts to profile/prefs changes, favorites updates, meal history, and inventory signals
// - Provides helpers to re-rank candidates by cuisine affinity and to push temporary/session bias
//
// Intended use:
//  import cuisineBias from "@/bootstrap/profileCuisineBias";
//  const bias = await cuisineBias.getCuisineBias();               // { africanAmerican: 0.62, westAfrican: 0.38, ... }
//  const ranked = cuisineBias.rerankByCuisine(candidates, c => c.cuisineKey || inferFromTags(c.tags));
//
// Design notes:
// - Defaults gracefully when optional stores/bus aren’t present.
// - Aligns with usdaDefaults' cuisine packs (AA default, WA optional).
// - Lightweight persistence across sessions (in-memory + optional store).

/* ----------------------------------------------------------------------------
   Defensive imports
---------------------------------------------------------------------------- */
let logger = { info: () => {}, warn: () => {}, error: () => {} };
let usdaDefaults;
let eventBus;
let PreferencesStore, HouseholdProfileStore, FavoritesStore, MealHistoryStore, InventoryStore;
try { ({ logger } = await import("@/utils/logger")); } catch {}
try { ({ usdaDefaults } = await import("@/services/nutrition/usdaDefaults")); } catch {}
try { ({ eventBus } = await import("@/services/automation/eventBus")); } catch {}
try { ({ usePreferencesStore: PreferencesStore } = await import("@/store/PreferencesStore")); } catch {}
try { ({ useHouseholdProfile: HouseholdProfileStore } = await import("@/store/HouseholdProfileStore")); } catch {}
try { ({ useFavoritesStore: FavoritesStore } = await import("@/store/FavoritesStore")); } catch {}
try { ({ useMealHistoryStore: MealHistoryStore } = await import("@/store/MealHistoryStore")); } catch {}
try { ({ Inventory } = await import("@/store/InventoryStore")); InventoryStore = Inventory; } catch {}

/* ----------------------------------------------------------------------------
   Constants
---------------------------------------------------------------------------- */
const DEFAULT_PACKS = ["africanAmerican"]; // AA as default, WA opt-in via profile/prefs
const KNOWN_PACKS = new Set(["africanAmerican", "westAfrican"]); // keep expandable

// Map cuisines → light regex and tag cues to help inference from content
const CUISINE_CUES = {
  africanAmerican: {
    rx: /(collard|black[-\s]?eyed|mac.*cheese|grits|catfish|sweet\s?potato|smoked\s?turkey|rice\s?&\s?gravy|soul[-\s]?food)/i,
    tags: new Set(["african-american","soul-food","collards","black-eyed-peas","grits","catfish","mac-and-cheese","sweet-potato","bbq"])
  },
  westAfrican: {
    rx: /(jollof|waakye|egusi|fufu|eba|garri|palm\s?oil|okra|yam|cassava|suya|pepper\s?soup|millet)/i,
    tags: new Set(["west-african","egusi","suya","palm-oil","fufu","eba","garri","jollof","waakye","okra","yam","cassava","millet","stew"])
  }
};

// Blend weights used to combine signals (sum to ~1 but we re-normalize anyway)
const WEIGHTS = {
  profileActive: 0.38,     // household-set active cuisines
  profilePrimary: 0.16,    // strong push for primary cuisine (if present)
  favorites: 0.18,         // items the household saves/requests
  historyNovelty: 0.12,    // "avoid repetition" -> subtract recent over-served cuisines
  inventoryPantry: 0.10,   // what's on-hand nudges toward those cuisines
  seasonalCalendar: 0.06   // (optional) calendar constraints (e.g., passoverMode)
};

// How far back to consider "recent meals" (days)
const HISTORY_WINDOW_DAYS = 10;

// Ephemeral bias entries (contextual modifiers) decay
const EPHEMERAL_TTL_MS = 1000 * 60 * 60 * 3; // 3 hours

/* ----------------------------------------------------------------------------
   State
---------------------------------------------------------------------------- */
let _bias = null;                 // cached normalized map
let _packs = new Set(DEFAULT_PACKS);
let _lastRecalc = 0;
const _ephemeral = new Map();     // contextId -> { weights, expiresAt }
let _inventorySnapshot = null;    // last pulled inventory (cheap summary)

/* ----------------------------------------------------------------------------
   Utilities
---------------------------------------------------------------------------- */
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const toKey = (s) => (s || "").toString().trim().toLowerCase();
const now = () => Date.now();

function normalizeWeights(map = {}) {
  // ensure all known packs have entries; clamp and normalize
  const out = {};
  let sum = 0;
  const keys = new Set([...KNOWN_PACKS, ...Object.keys(map)]);
  for (const k of keys) {
    const v = clamp01(map[k] ?? 0);
    out[k] = v;
    sum += v;
  }
  if (sum <= 0) {
    // default balanced over active packs; bias towards active
    const active = _packs.size ? Array.from(_packs) : DEFAULT_PACKS;
    active.forEach(k => out[k] = 1 / active.length);
    sum = active.length > 0 ? 1 : 1;
  }
  // normalize
  for (const k of Object.keys(out)) out[k] = out[k] / sum;
  return out;
}

function mergeAdd(dst, src, weight = 1) {
  for (const [k, v] of Object.entries(src || {})) {
    if (!KNOWN_PACKS.has(k)) continue;
    dst[k] = (dst[k] || 0) + (Number(v) || 0) * weight;
  }
}

function cueScoreFromTags(name = "", tags = []) {
  const s = { africanAmerican: 0, westAfrican: 0 };
  const low = String(name).toLowerCase();
  for (const [pack, cues] of Object.entries(CUISINE_CUES)) {
    if (cues.rx?.test(low)) s[pack] += 1;
    for (const t of (tags || [])) if (cues.tags.has(toKey(t))) s[pack] += 1;
  }
  return s;
}

function inferCuisineKeyFromItem(item = {}) {
  // Prefer explicit key if present
  if (item.cuisineKey && KNOWN_PACKS.has(item.cuisineKey)) return item.cuisineKey;
  // Prefer nutrition resolver flags if present
  if (item.cuisine?.africanAmerican) return "africanAmerican";
  if (item.cuisine?.westAfrican) return "westAfrican";
  // Try name/tags
  const scores = cueScoreFromTags(item.name || item.title, item.tags);
  return scores.africanAmerican >= scores.westAfrican ? "africanAmerican" : "westAfrican";
}

/* ----------------------------------------------------------------------------
   Signal collectors
---------------------------------------------------------------------------- */
function packsFromProfile(profile = {}) {
  // flexible shapes:
  // profile.cuisineDefaults = ["africanAmerican","westAfrican"]
  // profile.cuisine.active = [...]
  // preferences.food.cuisines.active = [...]
  const out = new Set();
  const a = profile?.cuisineDefaults;
  const b = profile?.cuisine?.active;
  const c = profile?.food?.cuisines?.active;
  for (const arr of [a, b, c]) {
    if (Array.isArray(arr)) arr.forEach(p => KNOWN_PACKS.has(p) && out.add(p));
  }
  if (!out.size) DEFAULT_PACKS.forEach(p => out.add(p));
  return out;
}

function primaryFromProfile(profile = {}) {
  return profile?.cuisine?.primary && KNOWN_PACKS.has(profile.cuisine.primary)
    ? profile.cuisine.primary
    : null;
}

function favoritesSignal() {
  // Expect Favorites store: { food: { favorites: [{ name, tags, cuisine?, weight? }, ...] } }
  const favs = FavoritesStore?.getState?.()?.food?.favorites || [];
  const tally = { africanAmerican: 0, westAfrican: 0 };
  for (const f of favs) {
    const key = f.cuisine && KNOWN_PACKS.has(f.cuisine) ? f.cuisine : inferCuisineKeyFromItem(f);
    tally[key] += (Number(f.weight) || 1);
  }
  return normalizeWeights(tally);
}

function historySignal() {
  // Expect MealHistory: entries with { servedAt, items:[{ name,tags,cuisineKey }] }
  const until = Date.now();
  const since = until - HISTORY_WINDOW_DAYS * 24 * 3600 * 1000;
  const hist = MealHistoryStore?.getRange
    ? (MealHistoryStore.getRange(since, until) || [])
    : (MealHistoryStore?.getState?.()?.events || []).filter(e => (e.servedAt || 0) >= since);

  const counts = { africanAmerican: 0, westAfrican: 0 };
  for (const e of hist) {
    for (const it of (e.items || [])) {
      const key = inferCuisineKeyFromItem(it);
      counts[key] += 1;
    }
  }
  // Convert to "novelty": higher score for less-served cuisines
  const total = counts.africanAmerican + counts.westAfrican;
  if (!total) return { africanAmerican: 0.5, westAfrican: 0.5 };
  const inv = {
    africanAmerican: (total - counts.africanAmerican) / total,
    westAfrican: (total - counts.westAfrican) / total
  };
  return normalizeWeights(inv);
}

async function inventorySignal(householdId) {
  try {
    const snap = householdId ? await InventoryStore?.snapshot?.(householdId) : null;
    const items = snap?.items || _inventorySnapshot?.items || [];
    if (snap) _inventorySnapshot = snap;
    const tally = { africanAmerican: 0, westAfrican: 0 };
    for (const it of items) {
      const key = inferCuisineKeyFromItem({ name: it.name, tags: it.tags });
      // weight by qty presence (binary bump) and perishability (if present)
      const qty = Number(it.qty || (Array.isArray(it.lots) ? it.lots.reduce((a,b)=>a+(b.qty||0),0) : 0));
      if (qty > 0) tally[key] += Math.min(1, qty);
    }
    return normalizeWeights(tally);
  } catch {
    return { africanAmerican: 0.5, westAfrican: 0.5 };
  }
}

function seasonalCalendarSignal() {
  const prefs = PreferencesStore?.getState?.() || {};
  const passover = !!(prefs?.calendar?.passoverMode);
  // Very light nudge away from chametz-heavy cuisines if passoverMode
  // (both packs include some chametz items; we just apply a tiny uniform penalty)
  if (!passover) return { africanAmerican: 0.5, westAfrican: 0.5 };
  return normalizeWeights({ africanAmerican: 0.48, westAfrican: 0.52 });
}

/* ----------------------------------------------------------------------------
   Core: recompute bias
---------------------------------------------------------------------------- */
async function recomputeBias({ householdId } = {}) {
  try {
    // Active packs from profile/prefs (also applied inside usdaDefaults)
    const profileState = HouseholdProfileStore?.getState?.() || {};
    _packs = packsFromProfile(profileState);

    // Start with zeroed map for known packs
    const blended = { africanAmerican: 0, westAfrican: 0 };

    // Profile active = equal distribution across active packs
    const activeArr = Array.from(_packs);
    const profileActive = {};
    activeArr.forEach(k => { profileActive[k] = 1 / activeArr.length; });
    mergeAdd(blended, profileActive, WEIGHTS.profileActive);

    // Profile primary
    const primary = primaryFromProfile(profileState);
    if (primary) mergeAdd(blended, { [primary]: 1 }, WEIGHTS.profilePrimary);

    // Favorites
    mergeAdd(blended, favoritesSignal(), WEIGHTS.favorites);

    // History novelty
    mergeAdd(blended, historySignal(), WEIGHTS.historyNovelty);

    // Inventory
    mergeAdd(blended, await inventorySignal(householdId), WEIGHTS.inventoryPantry);

    // Seasonal/Calendar
    mergeAdd(blended, seasonalCalendarSignal(), WEIGHTS.seasonalCalendar);

    // Ephemeral/contextual tweaks
    pruneEphemeral();
    for (const { weights } of _ephemeral.values()) mergeAdd(blended, weights, 1);

    _bias = normalizeWeights(blended);
    _lastRecalc = now();
    logger.info?.("[profileCuisineBias] recomputed", _bias);
    return _bias;
  } catch (e) {
    logger.warn?.("[profileCuisineBias] recompute failed", e);
    // Fallback to active packs equal weights
    const fallback = {};
    const arr = Array.from(_packs.size ? _packs : new Set(DEFAULT_PACKS));
    arr.forEach(k => fallback[k] = 1 / arr.length);
    _bias = normalizeWeights(fallback);
    return _bias;
  }
}

/* ----------------------------------------------------------------------------
   Ephemeral/context bias
---------------------------------------------------------------------------- */
function pruneEphemeral() {
  const t = now();
  for (const [k, v] of _ephemeral) if (!v || v.expiresAt <= t) _ephemeral.delete(k);
}

/**
 * Push a temporary context bias (e.g., user clicked "More West-African tonight")
 * @param {string} contextId unique key
 * @param {object} weights like { westAfrican: +0.4 }
 * @param {number} ttlMs optional TTL (default EPHEMERAL_TTL_MS)
 */
function pushEphemeral(contextId, weights, ttlMs = EPHEMERAL_TTL_MS) {
  if (!contextId || !weights) return false;
  const sanitized = {};
  for (const [k, v] of Object.entries(weights)) {
    if (KNOWN_PACKS.has(k)) sanitized[k] = Number(v) || 0;
  }
  _ephemeral.set(contextId, { weights: sanitized, expiresAt: now() + ttlMs });
  _bias = null; // force recompute on next read
  return true;
}

function clearEphemeral(contextId) {
  if (!contextId) { _ephemeral.clear(); return true; }
  _ephemeral.delete(contextId);
  _bias = null;
  return true;
}

/* ----------------------------------------------------------------------------
   Public API
---------------------------------------------------------------------------- */
export const profileCuisineBias = {
  /**
   * Get normalized cuisine bias. Triggers recompute if stale or forced.
   */
  async getCuisineBias({ force = false, householdId } = {}) {
    if (!_bias || force || (now() - _lastRecalc > 1000 * 60 * 10)) {
      return await recomputeBias({ householdId });
    }
    return _bias;
  },

  /**
   * Rerank arbitrary candidates by cuisine affinity.
   * @param candidates array of items
   * @param getCuisineKey function(item) -> "africanAmerican" | "westAfrican" | null
   * @param options { bias?, boost?: number } boost controls strength (default 0.6)
   */
  async rerankByCuisine(candidates = [], getCuisineKey, options = {}) {
    const bias = options.bias || await this.getCuisineBias({});
    const boost = typeof options.boost === "number" ? options.boost : 0.6;

    return (candidates || []).map(item => {
      const key = getCuisineKey ? getCuisineKey(item) : inferCuisineKeyFromItem(item);
      const w = clamp01(key && bias[key] != null ? bias[key] : 0.5);
      const baseScore = Number(item.score || item.rating || 0);
      // Intuition: newScore = base*(1 - boost) + w*boost
      const score = (baseScore * (1 - boost)) + (w * boost);
      return { ...item, cuisineKey: key, cuisineBias: w, score };
    }).sort((a, b) => (b.score || 0) - (a.score || 0));
  },

  /**
   * Return the active cuisine packs (mirrors usdaDefaults).
   */
  getActivePacks() {
    return Array.from(_packs && _packs.size ? _packs : new Set(DEFAULT_PACKS));
  },

  /**
   * Manually set active packs (also updates usdaDefaults if available).
   */
  setActivePacks(packs = []) {
    const next = packs.filter(p => KNOWN_PACKS.has(p));
    _packs = new Set(next.length ? next : DEFAULT_PACKS);
    try { usdaDefaults?.setActiveCuisinePacks?.(Array.from(_packs)); } catch {}
    _bias = null;
    emitCuisinePackChanged();
    return this.getActivePacks();
  },

  /**
   * Apply a household profile object to update active packs.
   */
  applyHouseholdProfile(profile = {}) {
    const next = packsFromProfile(profile);
    _packs = next.size ? next : new Set(DEFAULT_PACKS);
    try { usdaDefaults?.applyHouseholdProfile?.(profile); } catch {}
    _bias = null;
    emitCuisinePackChanged();
    return this.getActivePacks();
  },

  /** Ephemeral/context bias controls */
  pushEphemeral,
  clearEphemeral
};

export default profileCuisineBias;

/* ----------------------------------------------------------------------------
   Event wiring
---------------------------------------------------------------------------- */
function emitCuisinePackChanged() {
  try { eventBus?.emit?.("cuisine.packs.changed", { packs: profileCuisineBias.getActivePacks() }); } catch {}
}

// Auto-listen to profile/prefs/favorites/history changes and recompute
try {
  // Household profile updates (packs & primary)
  eventBus?.on?.("household.profile.updated", async (payload) => {
    profileCuisineBias.applyHouseholdProfile(payload?.profile || payload);
    await profileCuisineBias.getCuisineBias({ force: true });
  });

  // Preferences cuisine toggles
  eventBus?.on?.("preferences.cuisine.updated", async (payload) => {
    profileCuisineBias.applyHouseholdProfile(payload?.preferences || payload);
    await profileCuisineBias.getCuisineBias({ force: true });
  });

  // Favorites updated
  eventBus?.on?.("favorites.updated", async () => {
    _bias = null;
    await profileCuisineBias.getCuisineBias({ force: true });
  });

  // Meal served (history)
  eventBus?.on?.("meals.served", async () => {
    _bias = null;
    await profileCuisineBias.getCuisineBias({ force: true });
  });

  // Inventory changed
  eventBus?.on?.("inventory.snapshot.updated", async ({ householdId }) => {
    _bias = null;
    await profileCuisineBias.getCuisineBias({ force: true, householdId });
  });

  // Initial sync from stores if available
  const hp = HouseholdProfileStore?.getState?.();
  if (hp) profileCuisineBias.applyHouseholdProfile(hp);
  await profileCuisineBias.getCuisineBias({ force: true });
} catch (e) {
  logger.warn?.("[profileCuisineBias] event wiring failed (ok to ignore in bootstrap)", e);
}

/* ----------------------------------------------------------------------------
   Convenience: infer cuisine from tags/name (exported for reuse)
---------------------------------------------------------------------------- */
export function inferCuisineKeyFromTagsOrName(name, tags) {
  return inferCuisineKeyFromItem({ name, tags });
}

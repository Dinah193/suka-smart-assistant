
// FILE: src/services/cuisine/CuisineRotationEngine.js
// Deterministic “random-like” rotation engine.
// - Seed derived from householdId + weekIndex + cuisineKey
// - Enforces cooldowns and rotates proteins/techniques/spice profiles
// - Stores rotation state in Dexie (cuisine_rotation_state) with localStorage fallback.

import { db } from "@/services/db";

const TABLE = "cuisine_rotation_state";

function nowIso() { try { return new Date().toISOString(); } catch { return String(Date.now()); } }

function stableHash(str) {
  // Simple FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weekIndexFromDate(d) {
  const ms = 24 * 60 * 60 * 1000;
  const epoch = new Date("2020-01-05T00:00:00Z"); // Sunday anchor (stable)
  const diff = Math.floor((new Date(d).getTime() - epoch.getTime()) / ms);
  return Math.floor(diff / 7);
}

function safeParse(raw, fallback) { try { return JSON.parse(raw) ?? fallback; } catch { return fallback; } }

async function getStateRow({ householdId, cuisineKey }) {
  const hid = String(householdId || "default");
  const ck = String(cuisineKey || "aai");
  try {
    const t = db?.table?.(TABLE);
    if (!t) throw new Error("missing table");
    const row = await t.where("householdId").equals(hid).and((r) => r.cuisineKey === ck).first();
    return row || null;
  } catch {
    const k = `suka.cuisine.rotation.${hid}.${ck}`;
    try { return safeParse(localStorage.getItem(k), null); } catch { return null; }
  }
}

async function putStateRow({ householdId, cuisineKey, next }) {
  const hid = String(householdId || "default");
  const ck = String(cuisineKey || "aai");
  const row = { ...next, householdId: hid, cuisineKey: ck, updatedAt: nowIso() };
  try {
    const t = db?.table?.(TABLE);
    if (!t) throw new Error("missing table");
    if (row.id) await t.update(row.id, row);
    else row.id = await t.add(row);
  } catch {
    const k = `suka.cuisine.rotation.${hid}.${ck}`;
    try { localStorage.setItem(k, JSON.stringify(row)); } catch {}
  }
  return row;
}

export async function getRotationState({ householdId = "default", cuisineKey = "aai", date = new Date() } = {}) {
  const hid = String(householdId || "default");
  const ck = String(cuisineKey || "aai");
  const wi = weekIndexFromDate(date);
  const existing = await getStateRow({ householdId: hid, cuisineKey: ck });
  const base = {
    id: existing?.id,
    householdId: hid,
    cuisineKey: ck,
    weekIndex: wi,
    lastServedMap: existing?.lastServedMap || {},   // dishKey -> iso date
    cooldownMap: existing?.cooldownMap || {},       // dishKey -> remainingCooldownDays
    proteinLast: existing?.proteinLast || null,
    techniqueLast: existing?.techniqueLast || null,
    spiceLast: existing?.spiceLast || null,
    updatedAt: existing?.updatedAt || null,
  };
  // advance week if needed (reset some week-scoped markers)
  if (existing && typeof existing.weekIndex === "number" && existing.weekIndex !== wi) {
    base.weekIndex = wi;
    base.techniqueLast = null;
    base.spiceLast = null;
  }
  return base;
}

export async function advanceRotationState({ householdId = "default", cuisineKey = "aai", date = new Date(), chosen } = {}) {
  const state = await getRotationState({ householdId, cuisineKey, date });
  const iso = new Date(date).toISOString().slice(0, 10);
  const next = { ...state };

  if (chosen?.dishKey) next.lastServedMap = { ...(next.lastServedMap || {}), [chosen.dishKey]: iso };
  if (chosen?.primaryProtein) next.proteinLast = chosen.primaryProtein;
  if (chosen?.technique) next.techniqueLast = chosen.technique;
  if (chosen?.spiceProfile) next.spiceLast = chosen.spiceProfile;

  // Apply cooldown: chosen dish gets cooldown window; decrement others softly.
  const cooldownDays = Math.max(1, Number(chosen?.cooldownDays || 7));
  const cm = { ...(next.cooldownMap || {}) };
  if (chosen?.dishKey) cm[chosen.dishKey] = cooldownDays;

  for (const k of Object.keys(cm)) {
    if (k === chosen?.dishKey) continue;
    const v = Number(cm[k] || 0);
    cm[k] = Math.max(0, v - 1);
    if (cm[k] === 0) delete cm[k];
  }
  next.cooldownMap = cm;

  return putStateRow({ householdId, cuisineKey, next });
}

export function createDeterministicRng({ householdId = "default", cuisineKey = "aai", weekIndex = 0, salt = "" } = {}) {
  const seedStr = `${householdId}|${cuisineKey}|${weekIndex}|${salt}`;
  const seed = stableHash(seedStr);
  return mulberry32(seed);
}

export function scoreDish({
  dish,
  prefs,
  state,
  rng,
  enforce = { rotateProteins: true, rotateTechniques: true, rotateSpice: true, avoidSameProteinConsecutive: true }
}) {
  if (!dish) return -Infinity;
  const tags = Array.isArray(dish.tags) ? dish.tags : [];

  let score = 0;

  // Slight preference to underused dishes (not in lastServedMap)
  const lastServed = state?.lastServedMap?.[dish.key];
  if (!lastServed) score += 2;

  // Cooldown penalty
  const cd = Number(state?.cooldownMap?.[dish.key] || 0);
  if (cd > 0) score -= 10 + cd;

  // Diet-mode heuristics
  const diet = prefs?.dietMode || "normal";
  if (diet === "keto") {
    if (tags.includes("highStarch") || tags.includes("grain") || tags.includes("sugarAdded")) score -= 12;
    if (tags.includes("lowCarb")) score += 4;
  } else if (diet === "carnivore") {
    if (tags.includes("vegHeavy") || tags.includes("grain") || tags.includes("legume") || tags.includes("highStarch")) score -= 14;
    if (tags.includes("meatHeavy") || tags.includes("broth") || tags.includes("sausage")) score += 4;
  } else if (diet === "vegetarian") {
    if (dish.primaryProtein && dish.primaryProtein !== "vegetarian") score -= 999;
    if (tags.includes("vegHeavy") || tags.includes("legume")) score += 3;
  } else if (diet === "OMAD") {
    // Prefer hearty but not complex multi-component
    if (dish.timeBudget === "long") score += 1;
  }

  // Disliked ingredient phrase filters (best effort)
  const dislikes = (prefs?.dislikedIngredients || []).map((s) => String(s).toLowerCase());
  const name = String(dish.name || "").toLowerCase();
  for (const d of dislikes) {
    if (d && name.includes(d)) score -= 30;
  }

  // Protein rotation
  if (enforce.avoidSameProteinConsecutive && state?.proteinLast && dish.primaryProtein && dish.primaryProtein === state.proteinLast) {
    score -= 6;
  }
  if (enforce.rotateProteins && dish.primaryProtein && dish.primaryProtein !== state?.proteinLast) score += 1;

  // Technique rotation
  const tech = Array.isArray(dish.techniques) ? dish.techniques[0] : null;
  if (enforce.rotateTechniques && tech && state?.techniqueLast && tech !== state.techniqueLast) score += 1;
  if (enforce.rotateTechniques && tech && state?.techniqueLast && tech === state.techniqueLast) score -= 2;

  // Spice rotation
  const sp = Array.isArray(dish.spiceProfiles) ? dish.spiceProfiles[0] : null;
  if (enforce.rotateSpice && sp && state?.spiceLast && sp !== state.spiceLast) score += 1;
  if (enforce.rotateSpice && sp && state?.spiceLast && sp === state.spiceLast) score -= 2;

  // Add slight deterministic jitter so ties feel “random-like”
  const jitter = (rng ? rng() : Math.random()) * 0.8;
  score += jitter;

  return score;
}

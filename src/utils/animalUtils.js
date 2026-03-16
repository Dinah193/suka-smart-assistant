// File: src/utils/animalUtils.js
/**
 * animalUtils.js (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Shared animal-domain utility functions for SSA:
 *      • normalization / validation of animal profiles
 *      • species + breed helpers
 *      • age, lifecycle stage, and breeding windows
 *      • weight + body condition scoring helpers (lightweight)
 *      • inventory/yield estimation stubs (meat/milk/eggs/wool) for cross-domain
 *        planning (garden/meal/storehouse) without coupling to calculators
 *      • event helpers + safe ID generation
 *
 * Design goals
 *  - Browser-safe, dependency-free.
 *  - Never throw on bad inputs; return null/empty/fallback.
 *  - Schema-tolerant: supports partial profiles and incremental enrichment.
 *
 * NOTE
 *  - This file does not "decide doctrine" for slaughter/harvest rules. Those
 *    constraints should live in policy/cuisine/law catalogs. Here is purely
 *    data shaping + pragmatic planning helpers.
 */

import { toDate, toISO, nowISO, differenceDays } from "@/utils/dates";
import { isPlainObject, isArr, isStr, isNum } from "@/utils/obj";
import { seedFrom, createRng } from "@/utils/rand";

/* -------------------------------- Constants -------------------------------- */

export const ANIMAL_STATUSES = Object.freeze([
  "active",
  "sold",
  "deceased",
  "culled",
  "lost",
  "archived",
]);

export const SEXES = Object.freeze(["female", "male", "unknown"]);
export const REPRO_STATUSES = Object.freeze([
  "intact",
  "neutered",
  "spayed",
  "unknown",
]);

export const LIFE_STAGES = Object.freeze([
  "newborn",
  "juvenile",
  "adult",
  "senior",
  "unknown",
]);

export const PURPOSES = Object.freeze([
  "meat",
  "milk",
  "eggs",
  "wool",
  "fiber",
  "breeding",
  "draft",
  "guard",
  "pet",
  "mixed",
]);

export const UNITS = Object.freeze({
  weight: ["lb", "kg"],
  length: ["in", "cm"],
  temp: ["F", "C"],
});

export const SPECIES = Object.freeze([
  "sheep",
  "goat",
  "cattle",
  "chicken",
  "duck",
  "turkey",
  "rabbit",
  "pig",
  "fish",
  "bee",
  "other",
]);

/**
 * Basic lifecycle defaults (conservative, non-vet).
 * Used for *planning UI* (not health advice).
 */
export const SPECIES_DEFAULTS = Object.freeze({
  sheep: {
    adultDays: 365,
    seniorDays: 6 * 365,
    gestationDays: 147,
    weanDays: 60,
    breedingMinDaysFemale: 240,
    breedingMinDaysMale: 210,
    bcsScale: "1-5",
    typicalDressingPct: 0.45, // carcass/live
  },
  goat: {
    adultDays: 365,
    seniorDays: 7 * 365,
    gestationDays: 150,
    weanDays: 60,
    breedingMinDaysFemale: 240,
    breedingMinDaysMale: 210,
    bcsScale: "1-5",
    typicalDressingPct: 0.45,
  },
  cattle: {
    adultDays: 2 * 365,
    seniorDays: 10 * 365,
    gestationDays: 283,
    weanDays: 180,
    breedingMinDaysFemale: 420,
    breedingMinDaysMale: 365,
    bcsScale: "1-9",
    typicalDressingPct: 0.62,
  },
  pig: {
    adultDays: 240,
    seniorDays: 6 * 365,
    gestationDays: 114,
    weanDays: 28,
    breedingMinDaysFemale: 210,
    breedingMinDaysMale: 210,
    bcsScale: "1-5",
    typicalDressingPct: 0.72,
  },
  chicken: {
    adultDays: 180,
    seniorDays: 4 * 365,
    gestationDays: null,
    weanDays: null,
    breedingMinDaysFemale: 180,
    breedingMinDaysMale: 180,
    bcsScale: "na",
    typicalDressingPct: 0.7,
  },
  duck: {
    adultDays: 210,
    seniorDays: 5 * 365,
    gestationDays: null,
    weanDays: null,
    breedingMinDaysFemale: 210,
    breedingMinDaysMale: 210,
    bcsScale: "na",
    typicalDressingPct: 0.7,
  },
  turkey: {
    adultDays: 240,
    seniorDays: 5 * 365,
    gestationDays: null,
    weanDays: null,
    breedingMinDaysFemale: 240,
    breedingMinDaysMale: 240,
    bcsScale: "na",
    typicalDressingPct: 0.72,
  },
  rabbit: {
    adultDays: 180,
    seniorDays: 5 * 365,
    gestationDays: 31,
    weanDays: 28,
    breedingMinDaysFemale: 150,
    breedingMinDaysMale: 150,
    bcsScale: "1-5",
    typicalDressingPct: 0.55,
  },
  fish: {
    adultDays: 365,
    seniorDays: 5 * 365,
    gestationDays: null,
    weanDays: null,
    breedingMinDaysFemale: 0,
    breedingMinDaysMale: 0,
    bcsScale: "na",
    typicalDressingPct: 0.5,
  },
  bee: {
    adultDays: 0,
    seniorDays: 0,
    gestationDays: null,
    weanDays: null,
    breedingMinDaysFemale: 0,
    breedingMinDaysMale: 0,
    bcsScale: "na",
    typicalDressingPct: null,
  },
  other: {
    adultDays: 365,
    seniorDays: 7 * 365,
    gestationDays: null,
    weanDays: null,
    breedingMinDaysFemale: 0,
    breedingMinDaysMale: 0,
    bcsScale: "na",
    typicalDressingPct: null,
  },
});

export const EVENT_TYPES = Object.freeze({
  CREATED: "animals.profile.created",
  UPDATED: "animals.profile.updated",
  ARCHIVED: "animals.profile.archived",

  WEIGHT_LOGGED: "animals.weight.logged",
  HEALTH_LOGGED: "animals.health.logged",

  BREEDING_STARTED: "animals.breeding.started",
  BREEDING_ENDED: "animals.breeding.ended",
  BIRTH_RECORDED: "animals.birth.recorded",

  BUTCHER_PLANNED: "animals.butchery.planned",
  BUTCHER_COMPLETED: "animals.butchery.completed",
});

/* ---------------------------------- Utils ---------------------------------- */

export function createAnimalId(prefix = "ani") {
  // stable-ish but collision-resistant enough for local-first
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

export function normalizeSpecies(v) {
  const s = String(v || "")
    .toLowerCase()
    .trim();
  if (!s) return "other";
  if (SPECIES.includes(s)) return s;
  // common aliases
  if (["cow", "bull", "heifer", "steer"].includes(s)) return "cattle";
  if (["hen", "rooster"].includes(s)) return "chicken";
  return "other";
}

export function normalizeSex(v) {
  const s = String(v || "")
    .toLowerCase()
    .trim();
  if (
    s === "f" ||
    s === "female" ||
    s === "doe" ||
    s === "hen" ||
    s === "cow" ||
    s === "ewe"
  )
    return "female";
  if (
    s === "m" ||
    s === "male" ||
    s === "buck" ||
    s === "rooster" ||
    s === "bull" ||
    s === "ram"
  )
    return "male";
  return "unknown";
}

export function normalizeStatus(v) {
  const s = String(v || "")
    .toLowerCase()
    .trim();
  return ANIMAL_STATUSES.includes(s) ? s : "active";
}

export function normalizeReproStatus(v) {
  const s = String(v || "")
    .toLowerCase()
    .trim();
  return REPRO_STATUSES.includes(s) ? s : "unknown";
}

export function normalizePurpose(v) {
  const s = String(v || "")
    .toLowerCase()
    .trim();
  return PURPOSES.includes(s) ? s : "mixed";
}

export function normalizeTagList(tags) {
  const arr = isArr(tags) ? tags : isStr(tags) ? tags.split(",") : [];
  const out = [];
  const seen = new Set();
  for (const t of arr) {
    const s = String(t || "").trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

export function normalizeWeight(value, unit = "lb") {
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) return null;
  const u = String(unit || "lb").toLowerCase();
  const uu = u === "kg" ? "kg" : "lb";
  return { value: v, unit: uu };
}

export function kgToLb(kg) {
  const v = Number(kg);
  if (!Number.isFinite(v)) return null;
  return v * 2.2046226218;
}

export function lbToKg(lb) {
  const v = Number(lb);
  if (!Number.isFinite(v)) return null;
  return v / 2.2046226218;
}

export function convertWeight(weight, toUnit = "lb") {
  if (!weight || !Number.isFinite(Number(weight.value))) return null;
  const from = String(weight.unit || "lb").toLowerCase() === "kg" ? "kg" : "lb";
  const to = String(toUnit || "lb").toLowerCase() === "kg" ? "kg" : "lb";
  if (from === to) return { value: Number(weight.value), unit: to };
  if (from === "kg" && to === "lb")
    return { value: kgToLb(weight.value), unit: "lb" };
  if (from === "lb" && to === "kg")
    return { value: lbToKg(weight.value), unit: "kg" };
  return null;
}

/* -------------------------------------------------------------------------- */
/* Compatibility: Queue helpers (used by cooking planners)                      */
/* -------------------------------------------------------------------------- */

/**
 * addToAnimalQueue
 * - Backward-compatible export expected by some cooking components.
 * - Tries to enqueue "animal sourcing" needs into an AnimalStore if present.
 * - Never throws; returns a small result contract for UI to react to.
 *
 * @param {Object} item  e.g. { name, amount|quantity, unit, reason, recipeId, recipeName }
 * @param {Object} opts  e.g. { householdId, source, meta }
 * @returns {{ ok: boolean, queued?: any, reason?: string }}
 */
export function addToAnimalQueue(item, opts = {}) {
  try {
    // Attempt to find a store on window for runtime-only integrations
    // (keeps this utils file decoupled + build-safe).
    const w = typeof window !== "undefined" ? window : undefined;
    const store =
      w?.SSA?.stores?.AnimalStore ||
      w?.SSA?.AnimalStore ||
      w?.AnimalStore ||
      null;

    const payload = {
      id: `aq_${Date.now().toString(36)}_${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      atISO: nowISO(),
      type: "animal.queue.add",
      item: {
        name: item?.name,
        unit: item?.unit || item?.uom || "",
        quantity: Number(item?.quantity ?? item?.amount ?? item?.qty) || 0,
      },
      reason: item?.reason || "inventory_aware_planner",
      recipeId: item?.recipeId,
      recipeName: item?.recipeName,
      householdId: opts?.householdId,
      source: opts?.source || "utils.animalUtils",
      meta: { ...(opts?.meta || {}) },
    };

    // Store API variants:
    // 1) store.addToQueue(payload)
    // 2) store.enqueue(payload)
    // 3) store.queue.push(payload) (array)
    if (store && typeof store.addToQueue === "function") {
      const r = store.addToQueue(payload);
      return { ok: true, queued: r ?? payload };
    }
    if (store && typeof store.enqueue === "function") {
      const r = store.enqueue(payload);
      return { ok: true, queued: r ?? payload };
    }
    if (store && Array.isArray(store.queue)) {
      store.queue.push(payload);
      return { ok: true, queued: payload };
    }

    // No store wired — succeed softly so UI can still proceed.
    return { ok: true, queued: payload, reason: "no_store_bound" };
  } catch {
    return { ok: false, reason: "enqueue_failed" };
  }
}

/* ------------------------------ Profile Shape ------------------------------ */

/**
 * Canonical profile shape (tolerant)
 * {
 *   id, name, species, breed?, sex, status, reproStatus,
 *   dobISO?, acquiredISO?, origin?, purpose?,
 *   tags?, notes?,
 *   herdId?, householdId?,
 *   identifiers?: { earTag?, microchip?, registry?, band?, other? },
 *   lineage?: { sireId?, damId?, hatchBatchId?, notes? },
 *   location?: { penId?, pastureId?, coopId?, name? },
 *   health?: { alerts?, vaccinations?, meds?, conditions? },
 *   production?: { milk?, eggs?, wool?, fiber? },
 *   weights?: [{ atISO, value, unit, notes? }],
 *   createdAt, updatedAt, meta?
 * }
 */

export function normalizeAnimalProfile(input, { now = nowISO() } = {}) {
  const x = isPlainObject(input) ? { ...input } : {};

  const id = String(x.id || createAnimalId());
  const species = normalizeSpecies(x.species);
  const sex = normalizeSex(x.sex);
  const status = normalizeStatus(x.status);
  const reproStatus = normalizeReproStatus(x.reproStatus);
  const purpose = normalizePurpose(x.purpose);

  const dobISO = toISO(x.dobISO || x.dob || x.birthDate || null, null);
  const acquiredISO = toISO(
    x.acquiredISO || x.acquiredAt || x.acquired || null,
    null
  );

  const createdAt = toISO(x.createdAt || null, now) || now;
  const updatedAt = now;

  const identifiers = isPlainObject(x.identifiers) ? { ...x.identifiers } : {};
  const lineage = isPlainObject(x.lineage) ? { ...x.lineage } : {};
  const location = isPlainObject(x.location) ? { ...x.location } : {};
  const health = isPlainObject(x.health) ? { ...x.health } : {};
  const production = isPlainObject(x.production) ? { ...x.production } : {};

  const weights = normalizeWeightLogList(x.weights || x.weightLogs || []);

  return {
    id,
    name: x.name != null ? String(x.name) : "",
    species,
    breed: x.breed != null ? String(x.breed) : undefined,
    sex,
    status,
    reproStatus,
    purpose,

    dobISO: dobISO || undefined,
    acquiredISO: acquiredISO || undefined,
    origin: x.origin != null ? String(x.origin) : undefined,

    herdId: x.herdId != null ? String(x.herdId) : undefined,
    householdId: x.householdId != null ? String(x.householdId) : undefined,

    tags: normalizeTagList(x.tags || []),
    notes: x.notes != null ? String(x.notes) : undefined,

    identifiers: {
      earTag:
        identifiers.earTag != null ? String(identifiers.earTag) : undefined,
      microchip:
        identifiers.microchip != null
          ? String(identifiers.microchip)
          : undefined,
      registry:
        identifiers.registry != null ? String(identifiers.registry) : undefined,
      band: identifiers.band != null ? String(identifiers.band) : undefined,
      other: identifiers.other != null ? String(identifiers.other) : undefined,
    },

    lineage: {
      sireId: lineage.sireId != null ? String(lineage.sireId) : undefined,
      damId: lineage.damId != null ? String(lineage.damId) : undefined,
      hatchBatchId:
        lineage.hatchBatchId != null ? String(lineage.hatchBatchId) : undefined,
      notes: lineage.notes != null ? String(lineage.notes) : undefined,
    },

    location: {
      penId: location.penId != null ? String(location.penId) : undefined,
      pastureId:
        location.pastureId != null ? String(location.pastureId) : undefined,
      coopId: location.coopId != null ? String(location.coopId) : undefined,
      name: location.name != null ? String(location.name) : undefined,
    },

    health: {
      alerts: isArr(health.alerts) ? health.alerts.map(String) : undefined,
      vaccinations: isArr(health.vaccinations)
        ? health.vaccinations
        : undefined,
      meds: isArr(health.meds) ? health.meds : undefined,
      conditions: isArr(health.conditions) ? health.conditions : undefined,
      notes: health.notes != null ? String(health.notes) : undefined,
    },

    production: {
      milk: isPlainObject(production.milk) ? production.milk : undefined,
      eggs: isPlainObject(production.eggs) ? production.eggs : undefined,
      wool: isPlainObject(production.wool) ? production.wool : undefined,
      fiber: isPlainObject(production.fiber) ? production.fiber : undefined,
    },

    weights,

    createdAt,
    updatedAt,
    meta: isPlainObject(x.meta) ? { ...x.meta } : undefined,
  };
}

export function normalizeWeightLogList(list) {
  const arr = isArr(list) ? list : [];
  const out = [];

  for (const item of arr) {
    if (!isPlainObject(item)) continue;
    const atISO = toISO(item.atISO || item.at || item.date || null, null);
    const w = normalizeWeight(
      item.value ?? item.weight ?? item.wt,
      item.unit || "lb"
    );
    if (!atISO || !w) continue;
    out.push({
      atISO,
      value: Number(w.value),
      unit: w.unit,
      notes: item.notes != null ? String(item.notes) : undefined,
    });
  }

  out.sort((a, b) => new Date(a.atISO).getTime() - new Date(b.atISO).getTime());
  return out;
}

/* --------------------------- Age / Lifecycle Stage -------------------------- */

export function getAgeDays(profile, asOf = new Date()) {
  const dobISO = profile?.dobISO;
  if (!dobISO) return null;
  const d0 = toDate(dobISO);
  const d1 = toDate(asOf);
  if (!d0 || !d1) return null;
  const diff = differenceDays(d1, d0);
  if (diff == null) return null;
  return Math.max(0, diff);
}

export function getAgeMonths(profile, asOf = new Date()) {
  const days = getAgeDays(profile, asOf);
  if (days == null) return null;
  return Math.floor(days / 30.4375);
}

export function getLifeStage(profile, asOf = new Date(), overrides = {}) {
  const species = normalizeSpecies(profile?.species);
  const cfg = {
    ...(SPECIES_DEFAULTS[species] || SPECIES_DEFAULTS.other),
    ...(overrides || {}),
  };
  const age = getAgeDays(profile, asOf);
  if (age == null) return "unknown";
  if (age < 30) return "newborn";
  if (age < cfg.adultDays) return "juvenile";
  if (cfg.seniorDays && age >= cfg.seniorDays) return "senior";
  return "adult";
}

/* ------------------------- Weight / Trend / BCS ----------------------------- */

export function latestWeight(profile) {
  const w = isArr(profile?.weights) ? profile.weights : [];
  if (!w.length) return null;
  return w[w.length - 1];
}

export function weightTrend(profile, { window = 3 } = {}) {
  // Return simple slope over last N logs (value per day)
  const logs = isArr(profile?.weights) ? profile.weights : [];
  const n = Math.max(2, Math.trunc(Number(window) || 3));
  if (logs.length < 2) return null;

  const slice = logs.slice(-n);
  const first = slice[0];
  const last = slice[slice.length - 1];
  const d0 = toDate(first.atISO);
  const d1 = toDate(last.atISO);
  if (!d0 || !d1) return null;
  const days = Math.max(
    1,
    (d1.getTime() - d0.getTime()) / (1000 * 60 * 60 * 24)
  );
  const dv = Number(last.value) - Number(first.value);
  if (!Number.isFinite(dv)) return null;
  return {
    perDay: dv / days,
    delta: dv,
    days,
    fromISO: first.atISO,
    toISO: last.atISO,
    unit: last.unit || first.unit || "lb",
  };
}

/**
 * Minimal "body condition" helper:
 * - Doesn’t diagnose; just maps a numeric score to a label.
 * - Uses species BCS scale (1-5 or 1-9) from defaults.
 */
export function bcsLabel(score, { scale = "1-5" } = {}) {
  const s = Number(score);
  if (!Number.isFinite(s)) return null;

  if (scale === "1-9") {
    if (s <= 3) return "thin";
    if (s <= 4) return "lean";
    if (s <= 6) return "ideal";
    if (s <= 7) return "fleshy";
    return "obese";
  }

  // 1-5
  if (s <= 2) return "thin";
  if (s <= 2.5) return "lean";
  if (s <= 3.5) return "ideal";
  if (s <= 4) return "fleshy";
  return "obese";
}

/* --------------------------- Breeding / Gestation --------------------------- */

export function canBreed(profile, asOf = new Date(), overrides = {}) {
  const species = normalizeSpecies(profile?.species);
  const cfg = {
    ...(SPECIES_DEFAULTS[species] || SPECIES_DEFAULTS.other),
    ...(overrides || {}),
  };

  if (normalizeStatus(profile?.status) !== "active")
    return { ok: false, reason: "inactive" };
  if (normalizeReproStatus(profile?.reproStatus) !== "intact")
    return { ok: false, reason: "not_intact" };

  const sex = normalizeSex(profile?.sex);
  const ageDays = getAgeDays(profile, asOf);
  if (ageDays == null) return { ok: false, reason: "unknown_age" };

  const minDays =
    sex === "female"
      ? cfg.breedingMinDaysFemale
      : sex === "male"
      ? cfg.breedingMinDaysMale
      : 0;

  if (minDays && ageDays < minDays) {
    return { ok: false, reason: "too_young", minDays, ageDays };
  }

  return { ok: true };
}

export function estimateDueDate(breedingStartISO, species, overrides = {}) {
  const d0 = toDate(breedingStartISO);
  if (!d0) return null;
  const sp = normalizeSpecies(species);
  const cfg = {
    ...(SPECIES_DEFAULTS[sp] || SPECIES_DEFAULTS.other),
    ...(overrides || {}),
  };
  const g = Number(cfg.gestationDays);
  if (!Number.isFinite(g) || g <= 0) return null;
  const due = new Date(d0.getTime() + g * 86400000);
  return isValidDate(due) ? due.toISOString() : null;
}

export function estimateWeanDate(birthISO, species, overrides = {}) {
  const d0 = toDate(birthISO);
  if (!d0) return null;
  const sp = normalizeSpecies(species);
  const cfg = {
    ...(SPECIES_DEFAULTS[sp] || SPECIES_DEFAULTS.other),
    ...(overrides || {}),
  };
  const w = Number(cfg.weanDays);
  if (!Number.isFinite(w) || w <= 0) return null;
  const due = new Date(d0.getTime() + w * 86400000);
  return isValidDate(due) ? due.toISOString() : null;
}

/* ----------------------------- Yield Estimation ----------------------------- */

/**
 * Estimate carcass yield (very rough planning)
 * - Returns null if insufficient inputs.
 * - dressingPct defaults come from SPECIES_DEFAULTS[species].typicalDressingPct
 */
export function estimateCarcassWeight(
  profile,
  { liveWeight, unit = "lb", dressingPct } = {}
) {
  const species = normalizeSpecies(profile?.species);
  const cfg = SPECIES_DEFAULTS[species] || SPECIES_DEFAULTS.other;

  const lw =
    liveWeight != null
      ? normalizeWeight(liveWeight, unit)
      : latestWeight(profile)
      ? normalizeWeight(latestWeight(profile).value, latestWeight(profile).unit)
      : null;

  if (!lw) return null;

  const pct =
    Number.isFinite(Number(dressingPct)) && Number(dressingPct) > 0
      ? Number(dressingPct)
      : Number(cfg.typicalDressingPct);

  if (!Number.isFinite(pct) || pct <= 0) return null;

  // compute in lb by default
  const lwLb = convertWeight(lw, "lb");
  if (!lwLb) return null;

  const carcassLb = lwLb.value * pct;
  const out = { value: carcassLb, unit: "lb", dressingPct: pct };

  // convert if requested
  if (String(unit).toLowerCase() === "kg") {
    const kg = lbToKg(carcassLb);
    return kg == null ? out : { value: kg, unit: "kg", dressingPct: pct };
  }

  return out;
}

/**
 * Stub for dairy yield planning.
 * You can refine later with breed curves, lactation stage, season, feed quality.
 */
export function estimateMilkDaily(profile) {
  const p = profile?.production?.milk;
  if (!isPlainObject(p)) return null;
  const liters = Number(p.litersPerDay);
  const gallons = Number(p.gallonsPerDay);
  if (Number.isFinite(liters))
    return { value: liters, unit: "L/day", source: "profile" };
  if (Number.isFinite(gallons))
    return { value: gallons, unit: "gal/day", source: "profile" };
  return null;
}

/**
 * Stub for egg yield planning.
 */
export function estimateEggsDaily(profile) {
  const p = profile?.production?.eggs;
  if (!isPlainObject(p)) return null;
  const eggs = Number(p.eggsPerDay);
  const eggsWk = Number(p.eggsPerWeek);
  if (Number.isFinite(eggs))
    return { value: eggs, unit: "eggs/day", source: "profile" };
  if (Number.isFinite(eggsWk))
    return { value: eggsWk / 7, unit: "eggs/day", source: "profile" };
  return null;
}

/**
 * Stub for wool/fiber yield planning.
 */
export function estimateWoolAnnual(profile) {
  const p = profile?.production?.wool || profile?.production?.fiber;
  if (!isPlainObject(p)) return null;
  const lb = Number(p.lbPerYear);
  const kg = Number(p.kgPerYear);
  if (Number.isFinite(lb))
    return { value: lb, unit: "lb/yr", source: "profile" };
  if (Number.isFinite(kg))
    return { value: kg, unit: "kg/yr", source: "profile" };
  return null;
}

/* ----------------------------- Search / Match ------------------------------- */

export function matchesAnimal(profile, query) {
  const q = String(query || "")
    .trim()
    .toLowerCase();
  if (!q) return true;

  const fields = [
    profile?.name,
    profile?.species,
    profile?.breed,
    profile?.sex,
    profile?.status,
    profile?.purpose,
    profile?.identifiers?.earTag,
    profile?.identifiers?.microchip,
    profile?.identifiers?.registry,
    profile?.identifiers?.band,
    profile?.location?.name,
    ...(isArr(profile?.tags) ? profile.tags : []),
  ]
    .filter((v) => v != null)
    .map((v) => String(v).toLowerCase());

  return fields.some((s) => s.includes(q));
}

export function groupBySpecies(profiles) {
  const arr = isArr(profiles) ? profiles : [];
  const out = {};
  for (const p of arr) {
    const sp = normalizeSpecies(p?.species);
    if (!out[sp]) out[sp] = [];
    out[sp].push(p);
  }
  return out;
}

/* --------------------------- Stable “Rotation” Picks ------------------------- */

/**
 * Choose N animals from a list deterministically using a seed.
 * Good for "rotation" displays that feel random but remain stable per day/week.
 */
export function pickRotation(
  profiles,
  n,
  { seedParts = [], unique = true } = {}
) {
  const arr = isArr(profiles) ? profiles.slice() : [];
  const count = Math.max(0, Math.trunc(Number(n) || 0));
  if (!count || !arr.length) return [];

  const seed = seedFrom("animals.rotation", ...seedParts);
  const rng = createRng(seed);

  if (!unique) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(rng.pick(arr));
    return out.filter(Boolean);
  }

  return rng.pickN(arr, count, { unique: true }).filter(Boolean);
}

/* ----------------------------- Event Payloads ------------------------------- */

export function buildAnimalEvent(type, profile, extra = {}) {
  const p = profile ? normalizeAnimalProfile(profile) : null;
  return {
    type: String(type || EVENT_TYPES.UPDATED),
    at: nowISO(),
    source: "utils.animalUtils",
    animalId: p?.id,
    species: p?.species,
    herdId: p?.herdId,
    householdId: p?.householdId,
    payload: {
      profile: p,
      ...extra,
    },
  };
}

/* ------------------------------ Validation ---------------------------------- */

export function validateAnimalProfile(profile) {
  const p = isPlainObject(profile) ? profile : {};
  const errors = [];

  const id = String(p.id || "");
  if (!id) errors.push({ field: "id", message: "Missing id" });

  const species = normalizeSpecies(p.species);
  if (!species || species === "other") {
    // "other" is allowed, but we flag if truly missing
    if (!p.species)
      errors.push({ field: "species", message: "Missing species" });
  }

  const sex = normalizeSex(p.sex);
  if (sex === "unknown") {
    // allowed; no error
  }

  if (p.dobISO && !toDate(p.dobISO))
    errors.push({ field: "dobISO", message: "Invalid dobISO" });
  if (p.acquiredISO && !toDate(p.acquiredISO))
    errors.push({ field: "acquiredISO", message: "Invalid acquiredISO" });

  return {
    ok: errors.length === 0,
    errors,
    normalized: normalizeAnimalProfile(p),
  };
}

// File: src/services/animals/AnimalSuggestionService.js
/**
 * AnimalSuggestionService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic (non-AI) suggestion engine for animal husbandry operations:
 *      • daily/weekly husbandry focus (feed/water/health/cleaning)
 *      • breeding readiness & pairing suggestions
 *      • butchering / harvest planning suggestions (meat yield + inventory deficits)
 *      • medical observation flags (weight loss, missed feed, overdue checks)
 *      • supply/refill suggestions (feed, bedding, minerals, meds)
 *
 * Key principles
 *  - Browser-safe, offline-first friendly.
 *  - No hard dependency on a single DB schema (uses adapters).
 *  - Suggests “why” and “next step actions” with stable scoring.
 *  - Emits SSA events to eventBus if present.
 *
 * Output
 *  - suggestions[] items:
 *      { id, kind, title, summary, score, reasons[], actions[], data, createdAtISO }
 *
 * Suggestion kinds
 *  - "care"        (routine husbandry tasks)
 *  - "health"      (checks, trends, risk flags)
 *  - "breeding"    (pairing, readiness, scheduling)
 *  - "harvest"     (butchering planning + yield + inventory linkage)
 *  - "supplies"    (feed/bedding/minerals/meds refills)
 *  - "weeklyFocus" (executive summary)
 */

import eventBus from "@/services/events/eventBus";
import db from "@/services/db";

/* -------------------------------------------------------------------------- */
/* Utilities                                                                  */
/* -------------------------------------------------------------------------- */

const SOURCE = "animals.AnimalSuggestionService";

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function safeId(prefix = "as") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function asNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizeStr(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function stableJson(obj) {
  const seen = new WeakSet();
  const sortKeys = (x) => {
    if (!isObj(x) && !Array.isArray(x)) return x;
    if (seen.has(x)) return "[Circular]";
    seen.add(x);
    if (Array.isArray(x)) return x.map(sortKeys);
    const keys = Object.keys(x).sort();
    const out = {};
    for (const k of keys) out[k] = sortKeys(x[k]);
    return out;
  };
  try {
    return JSON.stringify(sortKeys(obj));
  } catch {
    try {
      return JSON.stringify(obj);
    } catch {
      return "{}";
    }
  }
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function emit(topic, payload) {
  try {
    if (eventBus?.emit) eventBus.emit(topic, payload);
  } catch {
    // never crash
  }
}

function daysBetweenMs(aMs, bMs) {
  return Math.abs(aMs - bMs) / 86400000;
}

/* -------------------------------------------------------------------------- */
/* Default catalogs / constants                                               */
/* -------------------------------------------------------------------------- */

/**
 * Species defaults used for heuristics when catalog data isn't available.
 */
const DEFAULT_SPECIES_PROFILES = {
  sheep: {
    gestationDays: 147,
    maturityMonthsFemale: 7,
    maturityMonthsMale: 6,
    typicalMarketAgeMonths: 6, // lamb
    typicalBreedingSeason: ["fall"], // heuristic
    feedPerHeadPerDay: { unit: "lb", value: 3.0 }, // rough combined (hay+grain)
    waterPerHeadPerDay: { unit: "gal", value: 1.0 },
    beddingPerHeadPerWeek: { unit: "lb", value: 2.0 },
    yield: { meatLb: 35, fatLb: 5, boneLb: 10 },
  },
  goat: {
    gestationDays: 150,
    maturityMonthsFemale: 7,
    maturityMonthsMale: 6,
    typicalMarketAgeMonths: 8,
    typicalBreedingSeason: ["fall"],
    feedPerHeadPerDay: { unit: "lb", value: 3.0 },
    waterPerHeadPerDay: { unit: "gal", value: 1.2 },
    beddingPerHeadPerWeek: { unit: "lb", value: 2.0 },
    yield: { meatLb: 30, fatLb: 4, boneLb: 9 },
  },
  cattle: {
    gestationDays: 283,
    maturityMonthsFemale: 14,
    maturityMonthsMale: 14,
    typicalMarketAgeMonths: 18,
    typicalBreedingSeason: ["spring", "summer"],
    feedPerHeadPerDay: { unit: "lb", value: 25.0 },
    waterPerHeadPerDay: { unit: "gal", value: 10.0 },
    beddingPerHeadPerWeek: { unit: "lb", value: 15.0 },
    yield: { meatLb: 430, fatLb: 70, boneLb: 120 },
  },
  chicken: {
    gestationDays: null,
    maturityMonthsFemale: 5,
    maturityMonthsMale: 5,
    typicalMarketAgeMonths: 2,
    typicalBreedingSeason: ["spring", "summer"],
    feedPerHeadPerDay: { unit: "lb", value: 0.25 },
    waterPerHeadPerDay: { unit: "gal", value: 0.05 },
    beddingPerHeadPerWeek: { unit: "lb", value: 0.2 },
    yield: { meatLb: 3.5, fatLb: 0.4, boneLb: 0.8 },
  },
};

const DEFAULT_SUPPLY_KEYS = {
  feed: ["hay", "feed", "grain", "pellets"],
  water: ["water"],
  minerals: ["mineral", "salt block", "electrolytes"],
  bedding: ["bedding", "straw", "pine shavings"],
  meds: ["dewormer", "iodine", "antibiotic", "vet wrap"],
};

/* -------------------------------------------------------------------------- */
/* Adapters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Recommended adapter contracts
 * -----------------------------------------------------------------------------
 * animalAdapter.getAnimalState({ householdId }) => {
 *   animals: [{
 *     id, name, species, sex, birthAtISO?, acquiredAtISO?,
 *     status: "active"|"sold"|"deceased"|"harvested",
 *     locationId?, groupId?,
 *     weightLb?, // latest
 *     tags?:[],
 *     breeding?: { canBreed?, lastBredAtISO?, lastBirthAtISO?, pregnant?, dueAtISO? },
 *     health?: { lastCheckAtISO?, notes?, flags?:[] }
 *   }],
 *   events: [{
 *     id, animalId, kind, atISO, data
 *     // kinds: "fed","watered","weight","healthCheck","heat","bred","birth","moved","cleaned","dewormed","vaccinated"
 *   }],
 *   tasks: [{ id, title, dueAtISO?, kind, animalId?, groupId? }],
 *   updatedAtISO
 * }
 *
 * inventoryAdapter.getInventorySnapshot({ householdId }) => {
 *   items: [{ key, name, qty, unit, minQty, targetQty, expiresAtISO? }],
 *   updatedAtISO
 * }
 *
 * prefsAdapter.getAnimalPrefs({ householdId }) => {
 *   speciesProfiles?: { [species]: { gestationDays, maturityMonthsFemale, ... } }
 *   breedingRules?: {
 *     minAgeMonthsFemale?: number,
 *     minAgeMonthsMale?: number,
 *     restDaysPostBirth?: number,
 *     avoidInbreeding?: boolean,
 *     maxBreedsPerMalePerSeason?: number
 *   }
 *   careCadence?: {
 *     feedEveryHours?: number,
 *     waterEveryHours?: number,
 *     cleaningEveryDays?: number,
 *     healthCheckEveryDays?: number,
 *     weighEveryDays?: number
 *   }
 *   supplyKeys?: { feed?:[], bedding?:[], minerals?:[], meds?:[] }
 *   harvestTargets?: [{ species, desiredMeatLbPerMonth, preferredCuts?:[], inventoryKeys?:[] }]
 *   dislikedHarvest?: boolean
 * }
 *
 * catalogAdapter.getSpeciesCatalog() => similar to DEFAULT_SPECIES_PROFILES
 */

function createDefaultAnimalAdapter() {
  return {
    async getAnimalState({ householdId }) {
      try {
        const has = (name) =>
          !!db?.[name] && typeof db[name].toArray === "function";
        const animalsTable =
          (has("animals") && "animals") ||
          (has("animal_profiles") && "animal_profiles") ||
          (has("AnimalProfiles") && "AnimalProfiles") ||
          null;

        const eventsTable =
          (has("animal_events") && "animal_events") ||
          (has("events") && "events") ||
          (has("AnimalEvents") && "AnimalEvents") ||
          null;

        const tasksTable =
          (has("animal_tasks") && "animal_tasks") ||
          (has("tasks") && "tasks") ||
          null;

        const animals = animalsTable
          ? (await db[animalsTable].toArray())
              .filter(
                (r) =>
                  !householdId ||
                  r.householdId === householdId ||
                  r.household_id === householdId
              )
              .map((r) => ({
                id: r.id || safeId("animal"),
                name: r.name || r.tag || r.id || "Animal",
                species: normalizeStr(r.species || r.type || "unknown"),
                sex: normalizeStr(r.sex || r.gender || "unknown"),
                birthAtISO: r.birthAtISO || r.birth || r.dob || null,
                acquiredAtISO: r.acquiredAtISO || r.acquired || null,
                status: r.status || "active",
                locationId: r.locationId || r.location_id || null,
                groupId: r.groupId || r.group_id || null,
                weightLb: asNumber(
                  r.weightLb ?? r.weight ?? r.latestWeightLb,
                  null
                ),
                tags: Array.isArray(r.tags) ? r.tags : [],
                breeding: isObj(r.breeding) ? r.breeding : {},
                health: isObj(r.health) ? r.health : {},
              }))
          : [];

        const events = eventsTable
          ? (await db[eventsTable].toArray())
              .filter(
                (r) =>
                  !householdId ||
                  r.householdId === householdId ||
                  r.household_id === householdId
              )
              .map((r) => ({
                id: r.id || safeId("evt"),
                animalId: r.animalId || r.animal_id || null,
                kind: normalizeStr(r.kind || r.type || "event"),
                atISO: r.atISO || r.dateISO || r.at || null,
                data: r.data || {},
              }))
          : [];

        const tasks = tasksTable
          ? (await db[tasksTable].toArray())
              .filter(
                (r) =>
                  !householdId ||
                  r.householdId === householdId ||
                  r.household_id === householdId
              )
              .map((r) => ({
                id: r.id || safeId("task"),
                title: r.title || r.name || "Task",
                dueAtISO: r.dueAtISO || r.due || null,
                kind: normalizeStr(r.kind || r.type || "animal"),
                animalId: r.animalId || r.animal_id || null,
                groupId: r.groupId || r.group_id || null,
              }))
          : [];

        return { animals, events, tasks, updatedAtISO: isoNow() };
      } catch {
        return { animals: [], events: [], tasks: [], updatedAtISO: isoNow() };
      }
    },
  };
}

function createDefaultInventoryAdapter() {
  return {
    async getInventorySnapshot({ householdId }) {
      try {
        const has = (name) =>
          !!db?.[name] && typeof db[name].toArray === "function";
        const tbl =
          (has("inventory_items") && "inventory_items") ||
          (has("inventory") && "inventory") ||
          (has("items") && "items") ||
          null;
        if (!tbl) return { items: [], updatedAtISO: isoNow() };

        const rows = await db[tbl].toArray();
        const items = (rows || [])
          .filter(
            (r) =>
              !householdId ||
              r.householdId === householdId ||
              r.household_id === householdId
          )
          .map((r) => ({
            key: normalizeStr(r.key || r.itemKey || r.sku || r.name),
            name: r.name || r.label || r.key || "Item",
            qty: asNumber(r.qty ?? r.quantity ?? r.onHand, 0),
            unit: r.unit || r.uom || "ea",
            minQty: asNumber(r.minQty ?? r.min ?? r.reorderPoint, 0),
            targetQty: asNumber(r.targetQty ?? r.target ?? r.parLevel, 0),
            expiresAtISO:
              r.expiresAtISO || r.expiry || r.expirationDateISO || null,
          }))
          .filter((x) => x.key);

        return { items, updatedAtISO: isoNow() };
      } catch {
        return { items: [], updatedAtISO: isoNow() };
      }
    },
  };
}

function createDefaultPrefsAdapter() {
  return {
    async getAnimalPrefs() {
      return {
        speciesProfiles: {},
        breedingRules: {
          minAgeMonthsFemale: 7,
          minAgeMonthsMale: 6,
          restDaysPostBirth: 45,
          avoidInbreeding: true,
          maxBreedsPerMalePerSeason: 25,
        },
        careCadence: {
          feedEveryHours: 24,
          waterEveryHours: 12,
          cleaningEveryDays: 7,
          healthCheckEveryDays: 14,
          weighEveryDays: 30,
        },
        supplyKeys: DEFAULT_SUPPLY_KEYS,
        harvestTargets: [],
        dislikedHarvest: false,
      };
    },
  };
}

function createDefaultCatalogAdapter() {
  return {
    async getSpeciesCatalog() {
      return DEFAULT_SPECIES_PROFILES;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Inventory deficit helpers (supplies)                                       */
/* -------------------------------------------------------------------------- */

function buildInventoryIndex(items) {
  const byKey = new Map();
  for (const it of items || []) {
    const k = normalizeStr(it.key || it.name);
    if (!k) continue;
    byKey.set(k, {
      key: k,
      name: it.name || it.key || k,
      qty: asNumber(it.qty, 0),
      unit: it.unit || "ea",
      minQty: asNumber(it.minQty, 0),
      targetQty: asNumber(it.targetQty, 0),
      expiresAtISO: it.expiresAtISO || null,
    });
  }
  return byKey;
}

function computeReorderGaps(invByKey) {
  const out = [];
  for (const it of invByKey.values()) {
    if (it.minQty > 0 && it.qty < it.minQty) {
      out.push({
        key: it.key,
        unit: it.unit,
        gap: it.minQty - it.qty,
        source: "minQty",
      });
    } else if (it.targetQty > 0 && it.qty < it.targetQty) {
      out.push({
        key: it.key,
        unit: it.unit,
        gap: it.targetQty - it.qty,
        source: "targetQty",
      });
    }
  }
  out.sort((a, b) => b.gap - a.gap);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Animal event helpers                                                       */
/* -------------------------------------------------------------------------- */

function latestEventByAnimal(events, kindSet) {
  const latest = new Map(); // animalId -> {atMs, event}
  for (const e of events || []) {
    if (!e?.animalId) continue;
    const k = normalizeStr(e.kind);
    if (kindSet && !kindSet.has(k)) continue;
    const ms = e.atISO ? Date.parse(e.atISO) : NaN;
    if (!Number.isFinite(ms)) continue;
    const cur = latest.get(e.animalId);
    if (!cur || ms > cur.atMs) latest.set(e.animalId, { atMs: ms, event: e });
  }
  return latest;
}

function animalAgeMonths(animal, atMs) {
  const born = animal?.birthAtISO ? Date.parse(animal.birthAtISO) : NaN;
  const acquired = animal?.acquiredAtISO
    ? Date.parse(animal.acquiredAtISO)
    : NaN;
  const base = Number.isFinite(born)
    ? born
    : Number.isFinite(acquired)
    ? acquired
    : NaN;
  if (!Number.isFinite(base)) return null;
  const days = (atMs - base) / 86400000;
  return Math.max(0, days / 30.4375);
}

function isActiveAnimal(a) {
  const st = normalizeStr(a?.status || "active");
  return st === "active" || st === "" || st === "alive";
}

/* -------------------------------------------------------------------------- */
/* Suggestion builders                                                        */
/* -------------------------------------------------------------------------- */

function makeSuggestion({
  kind,
  title,
  summary,
  score,
  reasons,
  actions,
  data,
}) {
  return {
    id: safeId("suggestion"),
    kind,
    title,
    summary,
    score: clamp(asNumber(score, 0), 0, 100),
    reasons: Array.isArray(reasons) ? reasons.filter(Boolean) : [],
    actions: Array.isArray(actions) ? actions.filter(Boolean) : [],
    data: data || {},
    createdAtISO: isoNow(),
  };
}

function action({ type, label, payload }) {
  return {
    type: type || "noop",
    label: label || "Action",
    payload: payload || {},
  };
}

/* -------------------------------------------------------------------------- */
/* Core scoring heuristics                                                    */
/* -------------------------------------------------------------------------- */

function careOverdueScore({ lastAtMs, cadenceHours, baseScore = 60 }) {
  if (!Number.isFinite(cadenceHours) || cadenceHours <= 0) cadenceHours = 24;
  if (!Number.isFinite(lastAtMs)) return clamp(baseScore + 20, 0, 100);

  const ageHrs = (nowMs() - lastAtMs) / 3600000;
  const pct = ageHrs / cadenceHours;

  // under cadence => low urgency, >1 => urgency grows quickly
  const bump = pct < 1 ? pct * 10 : 10 + (pct - 1) * 35;
  return clamp(baseScore + bump, 0, 100);
}

function trendRiskScore({ deltaPct, baseScore = 55 }) {
  // deltaPct negative means loss
  if (!Number.isFinite(deltaPct)) return baseScore;
  if (deltaPct >= 0) return clamp(baseScore - 10, 0, 100);
  const loss = Math.abs(deltaPct);
  if (loss < 2) return clamp(baseScore + 5, 0, 100);
  if (loss < 5) return clamp(baseScore + 15, 0, 100);
  if (loss < 10) return clamp(baseScore + 30, 0, 100);
  return clamp(baseScore + 40, 0, 100);
}

function seasonFromMonth(m) {
  // meteorological seasons
  if (m === 11 || m === 0 || m === 1) return "winter";
  if (m === 2 || m === 3 || m === 4) return "spring";
  if (m === 5 || m === 6 || m === 7) return "summer";
  return "fall";
}

/* -------------------------------------------------------------------------- */
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

class AnimalSuggestionServiceImpl {
  constructor() {
    this._cache = new Map();
    this._cacheTtlMs = 30_000;
  }

  async suggest(opts = {}) {
    const started = nowMs();
    const {
      householdId = null,
      horizonDays = 30,
      include = [
        "care",
        "health",
        "breeding",
        "harvest",
        "supplies",
        "weeklyFocus",
      ],
      adapters = {},
    } = opts;

    const deps = this._resolveAdapters(adapters);

    const [animalState, invSnap, prefs, speciesCatalog] = await Promise.all([
      deps.animalAdapter.getAnimalState({ householdId }),
      deps.inventoryAdapter.getInventorySnapshot({ householdId }),
      deps.prefsAdapter.getAnimalPrefs({ householdId }),
      deps.catalogAdapter.getSpeciesCatalog({ householdId }),
    ]);

    const ctx = this._buildContext({
      householdId,
      horizonDays,
      animalState,
      invSnap,
      prefs,
      speciesCatalog,
    });

    const fp = hashString(
      stableJson({ include, ctx: this._fingerprintCtx(ctx) })
    );
    const cached = this._getCache(fp);
    if (cached) return cached;

    const suggestions = [];

    if (include.includes("care")) suggestions.push(...this._suggestCare(ctx));
    if (include.includes("health"))
      suggestions.push(...this._suggestHealth(ctx));
    if (include.includes("breeding"))
      suggestions.push(...this._suggestBreeding(ctx));
    if (include.includes("harvest"))
      suggestions.push(...this._suggestHarvest(ctx));
    if (include.includes("supplies"))
      suggestions.push(...this._suggestSupplies(ctx));
    if (include.includes("weeklyFocus"))
      suggestions.push(...this._suggestWeeklyFocus(ctx));

    suggestions.sort(
      (a, b) => b.score - a.score || a.title.localeCompare(b.title)
    );

    const result = {
      ok: true,
      householdId,
      horizonDays,
      counts: {
        total: suggestions.length,
        care: suggestions.filter((s) => s.kind === "care").length,
        health: suggestions.filter((s) => s.kind === "health").length,
        breeding: suggestions.filter((s) => s.kind === "breeding").length,
        harvest: suggestions.filter((s) => s.kind === "harvest").length,
        supplies: suggestions.filter((s) => s.kind === "supplies").length,
        weeklyFocus: suggestions.filter((s) => s.kind === "weeklyFocus").length,
      },
      suggestions,
      generatedAtISO: isoNow(),
      durationMs: nowMs() - started,
      inputs: {
        animalUpdatedAtISO: animalState?.updatedAtISO || null,
        inventoryUpdatedAtISO: invSnap?.updatedAtISO || null,
      },
    };

    this._setCache(fp, result);

    emit("animals.suggestions.generated", {
      source: SOURCE,
      householdId,
      horizonDays,
      counts: result.counts,
      durationMs: result.durationMs,
    });

    return result;
  }

  async suggestWeeklyFocus(opts = {}) {
    const limit = asNumber(opts.limit, 10) || 10;
    const res = await this.suggest({
      ...opts,
      include: [
        "weeklyFocus",
        "care",
        "health",
        "breeding",
        "harvest",
        "supplies",
      ],
    });
    const top = (res.suggestions || []).slice(0, limit);
    return {
      ...res,
      suggestions: top,
      counts: { ...res.counts, total: top.length },
    };
  }

  /* ------------------------------ internals ------------------------------- */

  _resolveAdapters(adapters) {
    return {
      animalAdapter: adapters.animalAdapter || createDefaultAnimalAdapter(),
      inventoryAdapter:
        adapters.inventoryAdapter || createDefaultInventoryAdapter(),
      prefsAdapter: adapters.prefsAdapter || createDefaultPrefsAdapter(),
      catalogAdapter: adapters.catalogAdapter || createDefaultCatalogAdapter(),
    };
  }

  _buildContext({
    householdId,
    horizonDays,
    animalState,
    invSnap,
    prefs,
    speciesCatalog,
  }) {
    const animals = (animalState?.animals || []).filter(isActiveAnimal);
    const events = animalState?.events || [];
    const tasks = animalState?.tasks || [];

    const invByKey = buildInventoryIndex(invSnap?.items || []);
    const gaps = computeReorderGaps(invByKey);

    const mergedSpecies = {
      ...(speciesCatalog || {}),
      ...(prefs?.speciesProfiles || {}),
    };

    // event indexes
    const fedLatest = latestEventByAnimal(events, new Set(["fed"]));
    const waterLatest = latestEventByAnimal(
      events,
      new Set(["watered", "water"])
    );
    const cleanLatest = latestEventByAnimal(
      events,
      new Set(["cleaned", "clean"])
    );
    const healthLatest = latestEventByAnimal(
      events,
      new Set(["healthcheck", "health_check", "health"])
    );
    const weighLatest = latestEventByAnimal(
      events,
      new Set(["weight", "weighed"])
    );
    const bredLatest = latestEventByAnimal(
      events,
      new Set(["bred", "breeding"])
    );
    const birthLatest = latestEventByAnimal(
      events,
      new Set(["birth", "gave_birth"])
    );
    const heatLatest = latestEventByAnimal(events, new Set(["heat", "estrus"]));

    return {
      householdId,
      horizonDays,
      prefs: prefs || {},
      speciesCatalog: mergedSpecies,
      animals,
      events,
      tasks,
      inventory: invSnap || { items: [] },
      invByKey,
      gaps,
      idx: {
        fedLatest,
        waterLatest,
        cleanLatest,
        healthLatest,
        weighLatest,
        bredLatest,
        birthLatest,
        heatLatest,
      },
      season: seasonFromMonth(new Date().getMonth()),
    };
  }

  _fingerprintCtx(ctx) {
    return {
      householdId: ctx.householdId,
      horizonDays: ctx.horizonDays,
      animalsCount: ctx.animals.length,
      tasksCount: ctx.tasks.length,
      gapsTop: ctx.gaps.slice(0, 25),
      prefs: {
        breedingRules: ctx.prefs?.breedingRules || {},
        careCadence: ctx.prefs?.careCadence || {},
        dislikedHarvest: !!ctx.prefs?.dislikedHarvest,
      },
      season: ctx.season,
    };
  }

  _getCache(key) {
    const hit = this._cache.get(key);
    if (!hit) return null;
    if (nowMs() - hit.atMs > this._cacheTtlMs) {
      this._cache.delete(key);
      return null;
    }
    return hit.value;
  }

  _setCache(key, value) {
    this._cache.set(key, { atMs: nowMs(), value });
  }

  /* ---------------------------------------------------------------------- */
  /* CARE suggestions                                                       */
  /* ---------------------------------------------------------------------- */

  _suggestCare(ctx) {
    const out = [];
    const cadence = ctx.prefs?.careCadence || {};
    const feedEveryHours = asNumber(cadence.feedEveryHours, 24);
    const waterEveryHours = asNumber(cadence.waterEveryHours, 12);
    const cleaningEveryDays = asNumber(cadence.cleaningEveryDays, 7);

    const bySpecies = new Map(); // species -> { ids, names, worstScores, due }
    for (const a of ctx.animals) {
      const species = normalizeStr(a.species);
      if (!species) continue;

      const fed = ctx.idx.fedLatest.get(a.id);
      const wat = ctx.idx.waterLatest.get(a.id);
      const cle = ctx.idx.cleanLatest.get(a.id);

      const feedScore = careOverdueScore({
        lastAtMs: fed?.atMs,
        cadenceHours: feedEveryHours,
        baseScore: 50,
      });
      const waterScore = careOverdueScore({
        lastAtMs: wat?.atMs,
        cadenceHours: waterEveryHours,
        baseScore: 52,
      });
      const cleanScore = careOverdueScore({
        lastAtMs: cle?.atMs,
        cadenceHours: cleaningEveryDays * 24,
        baseScore: 48,
      });

      const worst = Math.max(feedScore, waterScore, cleanScore);
      const group = bySpecies.get(species) || {
        species,
        animalIds: [],
        names: [],
        worst: 0,
        feedWorst: 0,
        waterWorst: 0,
        cleanWorst: 0,
      };

      group.animalIds.push(a.id);
      group.names.push(a.name || a.id);
      group.worst = Math.max(group.worst, worst);
      group.feedWorst = Math.max(group.feedWorst, feedScore);
      group.waterWorst = Math.max(group.waterWorst, waterScore);
      group.cleanWorst = Math.max(group.cleanWorst, cleanScore);

      bySpecies.set(species, group);
    }

    const groups = Array.from(bySpecies.values()).sort(
      (a, b) => b.worst - a.worst
    );

    for (const g of groups.slice(0, 8)) {
      const speciesLabel = g.species || "animals";
      const reasons = [];
      if (g.feedWorst >= 70)
        reasons.push("Feeding appears overdue for at least one animal.");
      if (g.waterWorst >= 70)
        reasons.push("Water check appears overdue for at least one animal.");
      if (g.cleanWorst >= 70)
        reasons.push("Cleaning appears overdue for at least one pen/area.");

      // If no strong overdue, still propose routine
      if (!reasons.length) reasons.push("Routine husbandry cadence check.");

      out.push(
        makeSuggestion({
          kind: "care",
          title: `Routine care: ${speciesLabel}`,
          summary: `Review feed/water/cleaning for ${
            g.animalIds.length
          } ${speciesLabel} (${g.names.slice(0, 3).join(", ")}${
            g.names.length > 3 ? "…" : ""
          }).`,
          score: clamp(g.worst, 0, 100),
          reasons,
          actions: [
            action({
              type: "animals.openGroup",
              label: "Open group",
              payload: { householdId: ctx.householdId, species: speciesLabel },
            }),
            action({
              type: "animals.logCare",
              label: "Log feed/water/cleaning",
              payload: {
                householdId: ctx.householdId,
                species: speciesLabel,
                animalIds: g.animalIds,
              },
            }),
          ],
          data: g,
        })
      );
    }

    // Include due tasks from task table (animal-related)
    const dueTasks = (ctx.tasks || [])
      .map((t) => {
        const dueMs = t.dueAtISO ? Date.parse(t.dueAtISO) : null;
        return { ...t, dueMs: Number.isFinite(dueMs) ? dueMs : null };
      })
      .sort((a, b) => (a.dueMs ?? Infinity) - (b.dueMs ?? Infinity))
      .slice(0, 8);

    for (const t of dueTasks) {
      const score = t.dueMs
        ? clamp(90 - daysBetweenMs(nowMs(), t.dueMs) * 12, 40, 95)
        : 70;
      out.push(
        makeSuggestion({
          kind: "care",
          title: `Task: ${t.title}`,
          summary: t.dueAtISO ? `Due: ${t.dueAtISO}` : "No due date set.",
          score,
          reasons: ["Scheduled animal task found in your task list."],
          actions: [
            action({
              type: "tasks.open",
              label: "Open task",
              payload: { householdId: ctx.householdId, taskId: t.id },
            }),
            action({
              type: "tasks.complete",
              label: "Mark complete",
              payload: { householdId: ctx.householdId, taskId: t.id },
            }),
          ],
          data: t,
        })
      );
    }

    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* HEALTH suggestions                                                      */
  /* ---------------------------------------------------------------------- */

  _suggestHealth(ctx) {
    const out = [];
    const cadence = ctx.prefs?.careCadence || {};
    const healthCheckEveryDays = asNumber(cadence.healthCheckEveryDays, 14);
    const weighEveryDays = asNumber(cadence.weighEveryDays, 30);

    // Build per-animal health flags
    const weightEvents = ctx.events.filter(
      (e) =>
        normalizeStr(e.kind) === "weight" || normalizeStr(e.kind) === "weighed"
    );

    // For weight trends, keep last 2 weights
    const weightsByAnimal = new Map();
    for (const e of weightEvents) {
      const aId = e.animalId;
      if (!aId) continue;
      const ms = e.atISO ? Date.parse(e.atISO) : NaN;
      const w = asNumber(
        e.data?.weightLb ?? e.data?.weight ?? e.data?.lb ?? null,
        null
      );
      if (!Number.isFinite(ms) || w == null) continue;
      const arr = weightsByAnimal.get(aId) || [];
      arr.push({ ms, weightLb: w });
      weightsByAnimal.set(aId, arr);
    }
    for (const arr of weightsByAnimal.values()) arr.sort((a, b) => a.ms - b.ms);

    const candidates = [];

    for (const a of ctx.animals) {
      const lastHealth = ctx.idx.healthLatest.get(a.id);
      const lastWeigh = ctx.idx.weighLatest.get(a.id);

      const healthScore = careOverdueScore({
        lastAtMs: lastHealth?.atMs,
        cadenceHours: healthCheckEveryDays * 24,
        baseScore: 55,
      });

      const weighScore = careOverdueScore({
        lastAtMs: lastWeigh?.atMs,
        cadenceHours: weighEveryDays * 24,
        baseScore: 50,
      });

      // Weight trend risk
      let trend = null;
      const ws = weightsByAnimal.get(a.id);
      if (ws && ws.length >= 2) {
        const prev = ws[ws.length - 2];
        const last = ws[ws.length - 1];
        const deltaPct =
          ((last.weightLb - prev.weightLb) / Math.max(1e-6, prev.weightLb)) *
          100;
        trend = {
          prevLb: prev.weightLb,
          lastLb: last.weightLb,
          deltaPct,
          daysBetween: (last.ms - prev.ms) / 86400000,
        };
      }

      const trendScore = trend
        ? trendRiskScore({ deltaPct: trend.deltaPct, baseScore: 55 })
        : 55;

      // Combine
      const score = clamp(
        Math.max(healthScore, weighScore, trendScore),
        0,
        100
      );

      // Reasons
      const reasons = [];
      if (healthScore >= 70)
        reasons.push(
          `Health check overdue (~${healthCheckEveryDays} day cadence).`
        );
      if (weighScore >= 70)
        reasons.push(`Weigh-in overdue (~${weighEveryDays} day cadence).`);
      if (trend && trend.deltaPct < -5)
        reasons.push(
          `Weight drop: ${trend.deltaPct.toFixed(1)}% since last weigh-in.`
        );
      if (trend && trend.deltaPct > 8)
        reasons.push(
          `Rapid gain: +${trend.deltaPct.toFixed(1)}% since last weigh-in.`
        );
      const flags = Array.isArray(a.health?.flags) ? a.health.flags : [];
      for (const f of flags.slice(0, 3)) reasons.push(`Flag: ${String(f)}`);

      if (!reasons.length) continue; // keep health list focused

      candidates.push({ animal: a, score, reasons, trend });
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const c of candidates.slice(0, 12)) {
      const a = c.animal;
      out.push(
        makeSuggestion({
          kind: "health",
          title: `Health check: ${a.name}`,
          summary: `${a.species || "animal"} • ${a.sex || ""}`.trim(),
          score: c.score,
          reasons: c.reasons,
          actions: [
            action({
              type: "animals.openProfile",
              label: "Open profile",
              payload: { householdId: ctx.householdId, animalId: a.id },
            }),
            action({
              type: "animals.logHealthCheck",
              label: "Log health check",
              payload: { householdId: ctx.householdId, animalId: a.id },
            }),
            action({
              type: "animals.logWeight",
              label: "Log weight",
              payload: { householdId: ctx.householdId, animalId: a.id },
            }),
          ],
          data: { animalId: a.id, trend: c.trend },
        })
      );
    }

    if (!out.length) {
      out.push(
        makeSuggestion({
          kind: "health",
          title: "Health cadence looks stable",
          summary:
            "No urgent health flags detected based on your logged events. Keep regular checks and weigh-ins for accurate trend detection.",
          score: 60,
          reasons: [
            "Health suggestions become stronger as more weights/health events are logged.",
          ],
          actions: [
            action({
              type: "animals.openDashboard",
              label: "Open animals dashboard",
              payload: { householdId: ctx.householdId },
            }),
            action({
              type: "animals.logHealthCheck",
              label: "Log a quick check",
              payload: { householdId: ctx.householdId },
            }),
          ],
          data: {},
        })
      );
    }

    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* BREEDING suggestions                                                    */
  /* ---------------------------------------------------------------------- */

  _suggestBreeding(ctx) {
    const out = [];
    const rules = ctx.prefs?.breedingRules || {};
    const minAgeF = asNumber(rules.minAgeMonthsFemale, 7);
    const minAgeM = asNumber(rules.minAgeMonthsMale, 6);
    const restDaysPostBirth = asNumber(rules.restDaysPostBirth, 45);
    const avoidInbreeding = rules.avoidInbreeding !== false; // default true

    // Group animals by species and sex
    const bySpecies = new Map();
    for (const a of ctx.animals) {
      const sp = normalizeStr(a.species);
      if (!sp) continue;
      const bucket = bySpecies.get(sp) || { females: [], males: [] };
      const sex = normalizeStr(a.sex);
      if (sex.startsWith("f")) bucket.females.push(a);
      else if (sex.startsWith("m")) bucket.males.push(a);
      bySpecies.set(sp, bucket);
    }

    const season = ctx.season;

    for (const [species, g] of bySpecies.entries()) {
      const prof =
        ctx.speciesCatalog?.[species] ||
        DEFAULT_SPECIES_PROFILES[species] ||
        {};
      const typicalSeasons = Array.isArray(prof.typicalBreedingSeason)
        ? prof.typicalBreedingSeason
        : [];
      const seasonFit = typicalSeasons.length
        ? typicalSeasons.includes(season)
        : true;

      const eligibleFemales = [];
      for (const f of g.females) {
        const ageM = animalAgeMonths(f, nowMs());
        if (ageM != null && ageM < minAgeF) continue;

        const b = f.breeding || {};
        if (b.pregnant) continue;

        // Rest after birth
        const lastBirthMs = b.lastBirthAtISO
          ? Date.parse(b.lastBirthAtISO)
          : NaN;
        if (Number.isFinite(lastBirthMs)) {
          const days = (nowMs() - lastBirthMs) / 86400000;
          if (days < restDaysPostBirth) continue;
        }

        eligibleFemales.push(f);
      }

      const eligibleMales = [];
      for (const m of g.males) {
        const ageM = animalAgeMonths(m, nowMs());
        if (ageM != null && ageM < minAgeM) continue;
        eligibleMales.push(m);
      }

      if (!eligibleFemales.length || !eligibleMales.length) continue;

      // Simple pairing: pick one male for up to N females; avoid same groupId if avoidInbreeding.
      const pairings = [];
      const maxPerMale = asNumber(rules.maxBreedsPerMalePerSeason, 25);

      for (const male of eligibleMales) {
        let used = 0;
        for (const female of eligibleFemales) {
          if (used >= maxPerMale) break;

          if (avoidInbreeding) {
            // crude: if same groupId, treat as potential related group
            if (
              male.groupId &&
              female.groupId &&
              male.groupId === female.groupId
            )
              continue;
            // if tags show family/line identifiers, you can extend this logic
          }

          pairings.push({
            maleId: male.id,
            maleName: male.name,
            femaleId: female.id,
            femaleName: female.name,
          });
          used++;
        }
      }

      if (!pairings.length) continue;

      const score = clamp(
        75 + (seasonFit ? 10 : 0) + Math.min(10, pairings.length),
        0,
        100
      );

      out.push(
        makeSuggestion({
          kind: "breeding",
          title: `Breeding opportunities: ${species}`,
          summary: `${eligibleFemales.length} eligible females • ${
            eligibleMales.length
          } eligible males • season: ${season}${
            seasonFit ? " (fit)" : " (not typical)"
          }.`,
          score,
          reasons: [
            `Eligibility rules: female ≥ ${minAgeF} months, male ≥ ${minAgeM} months.`,
            `Post-birth rest: ${restDaysPostBirth} days.`,
            avoidInbreeding
              ? "Avoiding same groupId pairings (anti-inbreeding heuristic)."
              : "Inbreeding avoidance disabled.",
          ],
          actions: [
            action({
              type: "animals.openBreedingPlanner",
              label: "Open breeding planner",
              payload: { householdId: ctx.householdId, species },
            }),
            action({
              type: "animals.createBreedingBatch",
              label: "Create breeding batch",
              payload: {
                householdId: ctx.householdId,
                species,
                pairings: pairings.slice(0, 50),
              },
            }),
          ],
          data: {
            species,
            season,
            seasonFit,
            eligibleFemales: eligibleFemales.map((x) => x.id),
            eligibleMales: eligibleMales.map((x) => x.id),
            pairings,
          },
        })
      );

      // Due date reminders for already-pregnant animals
      const pregnant = g.females.filter(
        (f) => !!f?.breeding?.pregnant || !!f?.breeding?.dueAtISO
      );
      for (const f of pregnant) {
        const dueMs = f?.breeding?.dueAtISO
          ? Date.parse(f.breeding.dueAtISO)
          : NaN;
        if (!Number.isFinite(dueMs)) continue;
        const days = (dueMs - nowMs()) / 86400000;
        const dueScore = clamp(90 - Math.max(0, days) * 8, 40, 95);

        out.push(
          makeSuggestion({
            kind: "breeding",
            title: `Due soon: ${f.name}`,
            summary: `${species} birth due around ${f.breeding.dueAtISO}.`,
            score: dueScore,
            reasons: ["Pregnancy due date is recorded."],
            actions: [
              action({
                type: "animals.openProfile",
                label: "Open profile",
                payload: { householdId: ctx.householdId, animalId: f.id },
              }),
              action({
                type: "animals.prepareBirthingKit",
                label: "Prep birthing kit tasks",
                payload: {
                  householdId: ctx.householdId,
                  animalId: f.id,
                  species,
                },
              }),
            ],
            data: {
              animalId: f.id,
              dueAtISO: f.breeding.dueAtISO,
              daysUntil: days,
            },
          })
        );
      }
    }

    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* HARVEST / BUTCHERING suggestions                                        */
  /* ---------------------------------------------------------------------- */

  _suggestHarvest(ctx) {
    const out = [];
    if (ctx.prefs?.dislikedHarvest) {
      out.push(
        makeSuggestion({
          kind: "harvest",
          title: "Harvest suggestions disabled",
          summary:
            "Household preferences indicate harvest/butchering suggestions are turned off.",
          score: 40,
          reasons: ["Preference: dislikedHarvest=true"],
          actions: [
            action({
              type: "prefs.openAnimals",
              label: "Open animal preferences",
              payload: { householdId: ctx.householdId },
            }),
          ],
          data: {},
        })
      );
      return out;
    }

    // Identify “market age” animals (heuristic) for each species
    const now = nowMs();
    const candidates = [];

    for (const a of ctx.animals) {
      const sp = normalizeStr(a.species);
      const prof =
        ctx.speciesCatalog?.[sp] || DEFAULT_SPECIES_PROFILES[sp] || null;
      if (!prof) continue;

      const ageM = animalAgeMonths(a, now);
      if (ageM == null) continue;

      const marketAge = asNumber(prof.typicalMarketAgeMonths, null);
      if (marketAge == null) continue;

      // prefer animals beyond typicalMarketAgeMonths and not pregnant
      const pregnant = !!a?.breeding?.pregnant || !!a?.breeding?.dueAtISO;
      if (pregnant) continue;

      const over = ageM - marketAge;
      if (over < 0) continue;

      // score: older slightly higher, but cap
      let score = 65 + clamp(over * 6, 0, 25);

      // if weight exists, boost if large
      if (a.weightLb != null)
        score += clamp(Math.log10(1 + a.weightLb) * 6, 0, 10);

      // if health flags exist, allow “cull” suggestion
      const flags = Array.isArray(a.health?.flags) ? a.health.flags : [];
      if (flags.length) score += 5;

      score = clamp(score, 0, 100);

      candidates.push({ animal: a, species: sp, ageM, prof, score, flags });
    }

    candidates.sort((a, b) => b.score - a.score);

    for (const c of candidates.slice(0, 10)) {
      const a = c.animal;
      const y =
        c.prof?.yield || DEFAULT_SPECIES_PROFILES[c.species]?.yield || {};
      const estMeat = asNumber(y.meatLb, null);
      const estFat = asNumber(y.fatLb, null);
      const estBone = asNumber(y.boneLb, null);

      const reasons = [
        `Age: ~${c.ageM.toFixed(1)} months (typical market age ~${asNumber(
          c.prof.typicalMarketAgeMonths,
          "?"
        )} months).`,
        estMeat != null ? `Estimated yield: ~${estMeat} lb meat.` : null,
        c.flags?.length
          ? `Health flags present: ${c.flags.slice(0, 2).join(", ")}.`
          : null,
      ].filter(Boolean);

      out.push(
        makeSuggestion({
          kind: "harvest",
          title: `Harvest candidate: ${a.name}`,
          summary: `${c.species} • ${a.sex || ""}`.trim(),
          score: c.score,
          reasons,
          actions: [
            action({
              type: "animals.openButcheringLog",
              label: "Open butchering log",
              payload: {
                householdId: ctx.householdId,
                animalId: a.id,
                species: c.species,
              },
            }),
            action({
              type: "animals.createButcheringSession",
              label: "Create butchering session",
              payload: {
                householdId: ctx.householdId,
                animalId: a.id,
                species: c.species,
                estimates: { meatLb: estMeat, fatLb: estFat, boneLb: estBone },
              },
            }),
            action({
              type: "inventory.planMeatIntake",
              label: "Plan inventory intake",
              payload: {
                householdId: ctx.householdId,
                animalId: a.id,
                species: c.species,
                inventoryKeys: [
                  `${c.species} meat`,
                  `${c.species} fat`,
                  `${c.species} bones`,
                ],
                estimates: { meatLb: estMeat, fatLb: estFat, boneLb: estBone },
              },
            }),
          ],
          data: {
            animalId: a.id,
            species: c.species,
            ageMonths: c.ageM,
            estimates: { meatLb: estMeat, fatLb: estFat, boneLb: estBone },
          },
        })
      );
    }

    if (!out.length) {
      out.push(
        makeSuggestion({
          kind: "harvest",
          title: "No clear harvest candidates",
          summary:
            "No animals detected beyond typical market age (or missing birth/acquired dates). Add dates/weights for stronger harvest planning.",
          score: 55,
          reasons: [
            "Harvest suggestions depend on age/weight data and pregnancy flags.",
          ],
          actions: [
            action({
              type: "animals.openDashboard",
              label: "Open animals dashboard",
              payload: { householdId: ctx.householdId },
            }),
            action({
              type: "animals.logWeight",
              label: "Log weights",
              payload: { householdId: ctx.householdId },
            }),
          ],
          data: {},
        })
      );
    }

    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* SUPPLIES suggestions                                                    */
  /* ---------------------------------------------------------------------- */

  _suggestSupplies(ctx) {
    const out = [];
    const supplyKeys = ctx.prefs?.supplyKeys || DEFAULT_SUPPLY_KEYS;
    const gaps = ctx.gaps;

    // Match inventory gaps to supply categories
    const categories = [
      { kind: "feed", keys: (supplyKeys.feed || []).map(normalizeStr) },
      { kind: "bedding", keys: (supplyKeys.bedding || []).map(normalizeStr) },
      { kind: "minerals", keys: (supplyKeys.minerals || []).map(normalizeStr) },
      { kind: "meds", keys: (supplyKeys.meds || []).map(normalizeStr) },
    ];

    const catHits = new Map(); // cat -> [{gap...}]
    for (const g of gaps) {
      for (const cat of categories) {
        // crude containment match; you can extend with lexicons later
        if (cat.keys.some((k) => g.key.includes(k))) {
          const arr = catHits.get(cat.kind) || [];
          arr.push(g);
          catHits.set(cat.kind, arr);
        }
      }
    }

    // Also estimate consumption based on headcount
    const headcountBySpecies = new Map();
    for (const a of ctx.animals) {
      const sp = normalizeStr(a.species);
      headcountBySpecies.set(sp, (headcountBySpecies.get(sp) || 0) + 1);
    }

    for (const [cat, arr] of catHits.entries()) {
      const top = arr.slice(0, 6);
      const totalGap = top.reduce((s, x) => s + asNumber(x.gap, 0), 0);
      const score = clamp(70 + Math.log10(1 + totalGap) * 15, 0, 95);

      out.push(
        makeSuggestion({
          kind: "supplies",
          title: `Refill supplies: ${cat}`,
          summary: `Low items detected: ${top.map((x) => x.key).join(", ")}.`,
          score,
          reasons: [
            `Estimated gaps driven by min/target thresholds.`,
            `Top gaps total: ~${Math.round(totalGap * 10) / 10}.`,
          ],
          actions: [
            action({
              type: "inventory.openSupplies",
              label: "Open inventory supplies",
              payload: { householdId: ctx.householdId, category: cat },
            }),
            action({
              type: "shopping.addBatch",
              label: "Add to shopping list",
              payload: { householdId: ctx.householdId, items: top },
            }),
          ],
          data: { category: cat, gaps: top },
        })
      );
    }

    // Consumption planning suggestion (weekly)
    const speciesCatalog = ctx.speciesCatalog || {};
    let weeklyFeedLb = 0;
    let weeklyWaterGal = 0;

    for (const [sp, count] of headcountBySpecies.entries()) {
      const prof = speciesCatalog[sp] || DEFAULT_SPECIES_PROFILES[sp] || {};
      const feed = asNumber(prof.feedPerHeadPerDay?.value, 0);
      const water = asNumber(prof.waterPerHeadPerDay?.value, 0);
      weeklyFeedLb += feed * count * 7;
      weeklyWaterGal += water * count * 7;
    }

    if (weeklyFeedLb > 0 || weeklyWaterGal > 0) {
      const score = 70;
      out.push(
        makeSuggestion({
          kind: "supplies",
          title: "Weekly consumption estimate",
          summary: `Estimated weekly use: ~${Math.round(
            weeklyFeedLb
          )} lb feed and ~${Math.round(weeklyWaterGal)} gal water (heuristic).`,
          score,
          reasons: [
            "Uses per-species defaults; refine by entering your own feed/water profiles.",
          ],
          actions: [
            action({
              type: "prefs.openAnimals",
              label: "Adjust species profiles",
              payload: { householdId: ctx.householdId },
            }),
            action({
              type: "inventory.planReorder",
              label: "Plan reorder quantities",
              payload: {
                householdId: ctx.householdId,
                weeklyFeedLb,
                weeklyWaterGal,
              },
            }),
          ],
          data: {
            weeklyFeedLb,
            weeklyWaterGal,
            headcountBySpecies: Array.from(headcountBySpecies.entries()),
          },
        })
      );
    }

    if (!out.length) {
      out.push(
        makeSuggestion({
          kind: "supplies",
          title: "Supplies look stable",
          summary:
            "No low-threshold supply items detected. Keep inventory thresholds (min/target) up to date for reliable refill suggestions.",
          score: 55,
          reasons: [
            "Supply suggestions depend on minQty/targetQty fields in inventory.",
          ],
          actions: [
            action({
              type: "inventory.openDashboard",
              label: "Open inventory dashboard",
              payload: { householdId: ctx.householdId },
            }),
          ],
          data: {},
        })
      );
    }

    return out;
  }

  /* ---------------------------------------------------------------------- */
  /* WEEKLY FOCUS suggestions                                                 */
  /* ---------------------------------------------------------------------- */

  _suggestWeeklyFocus(ctx) {
    const out = [];

    const topCare = this._suggestCare(ctx).slice(0, 2);
    const topHealth = this._suggestHealth(ctx).slice(0, 2);
    const topBreed = this._suggestBreeding(ctx).slice(0, 1);
    const topHarvest = this._suggestHarvest(ctx).slice(0, 1);
    const topSupplies = this._suggestSupplies(ctx).slice(0, 1);

    const focusLines = [];

    if (topCare.length)
      focusLines.push(
        `Care: ${topCare
          .map((s) => s.title.replace(/^Routine care:\s*/, ""))
          .join(", ")}`
      );
    if (topHealth.length)
      focusLines.push(
        `Health: ${topHealth
          .map((s) => s.title.replace(/^Health check:\s*/, ""))
          .join(", ")}`
      );
    if (topBreed.length)
      focusLines.push(
        `Breeding: ${topBreed[0].title.replace(
          /^Breeding opportunities:\s*/,
          ""
        )}`
      );
    if (topHarvest.length)
      focusLines.push(
        `Harvest: ${topHarvest[0].title.replace(/^Harvest candidate:\s*/, "")}`
      );
    if (topSupplies.length)
      focusLines.push(
        `Supplies: ${topSupplies[0].title.replace(/^Refill supplies:\s*/, "")}`
      );

    const score = 88;

    out.push(
      makeSuggestion({
        kind: "weeklyFocus",
        title: "Weekly livestock focus",
        summary:
          focusLines.join(" • ") ||
          "Review care cadence, health logs, and supply thresholds.",
        score,
        reasons: [
          "Built from event cadence, health trends, breeding readiness, and inventory gaps.",
        ],
        actions: [
          action({
            type: "animals.openDashboard",
            label: "Open animals dashboard",
            payload: { householdId: ctx.householdId },
          }),
          action({
            type: "inventory.openDashboard",
            label: "Open inventory dashboard",
            payload: { householdId: ctx.householdId },
          }),
          action({
            type: "tasks.openBoard",
            label: "Open task board",
            payload: { householdId: ctx.householdId },
          }),
        ],
        data: {
          animalsCount: ctx.animals.length,
          tasksCount: ctx.tasks.length,
          season: ctx.season,
        },
      })
    );

    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Public singleton                                                           */
/* -------------------------------------------------------------------------- */

const AnimalSuggestionService = new AnimalSuggestionServiceImpl();

/* -------------------------------------------------------------------------- */
/* Compatibility exports (for older imports)                                  */
/* -------------------------------------------------------------------------- */

/**
 * suggestAnimalsFromIntelligence
 * -----------------------------------------------------------------------------
 * Compatibility helper for AnimalPlanner.jsx (and similar UI layers) that expect
 * an exported function named `suggestAnimalsFromIntelligence`.
 *
 * This is intentionally "non-AI": it converts recent import intelligence (from
 * ImportIntelligenceService) into a small set of deterministic planning hints.
 *
 * Expected input shapes (tolerant):
 *  - recentImports: array of objects that may look like:
 *      { analysis: { topDomains:[{name,score}], label }, nextActions:[], ... }
 *    OR { intel: { analysis: ... } } OR { artifactId, analysis: ... }
 *
 * Returns:
 *  - { ok, suggestions: [{ id, kind, title, summary, score, reasons[], actions[], data, createdAtISO }], meta }
 */
export function suggestAnimalsFromIntelligence(
  recentImports = [],
  options = {}
) {
  const opts = isObj(options) ? options : {};
  const arr = Array.isArray(recentImports) ? recentImports : [];

  const maxItems = clamp(asNumber(opts.maxItems, 8), 1, 25);
  const minDomainScore = asNumber(opts.minDomainScore, 8);

  // Aggregate domain evidence from import intel
  let animalsScore = 0;
  let inventoryScore = 0;
  let mealsScore = 0;

  const labelCounts = {};
  const reasons = [];

  function bumpLabel(label) {
    const k = normalizeStr(label || "unknown");
    labelCounts[k] = (labelCounts[k] || 0) + 1;
  }

  for (const item of arr) {
    const analysis =
      item?.analysis ||
      item?.intel?.analysis ||
      item?.data?.analysis ||
      (isObj(item?.analysisWrapper) ? item.analysisWrapper.analysis : null) ||
      null;

    if (!analysis) continue;

    bumpLabel(analysis.label);

    const topDomains = Array.isArray(analysis.topDomains)
      ? analysis.topDomains
      : [];
    for (const d of topDomains) {
      const name = normalizeStr(d?.name);
      const sc = asNumber(d?.score, 0);
      if (name === "animals") animalsScore += sc;
      if (name === "inventory") inventoryScore += sc;
      if (name === "meals") mealsScore += sc;
    }
  }

  // Convert to 0..100-ish signals
  animalsScore = clamp(animalsScore * 0.15, 0, 100);
  inventoryScore = clamp(inventoryScore * 0.12, 0, 100);
  mealsScore = clamp(mealsScore * 0.1, 0, 100);

  const topLabels = Object.entries(labelCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));

  if (arr.length) {
    reasons.push(`Recent imports analyzed: ${arr.length}.`);
    if (topLabels.length) {
      reasons.push(
        `Top import types: ${topLabels
          .map((x) => `${x.label}(${x.count})`)
          .join(", ")}.`
      );
    }
  } else {
    reasons.push("No recent imports available for intelligence-based hints.");
  }

  const suggestions = [];

  // 1) If imports suggest animals domain, offer review action
  if (animalsScore >= minDomainScore) {
    suggestions.push(
      makeSuggestion({
        kind: "weeklyFocus",
        title: "Imports mention livestock activity",
        summary:
          "Your recent imports look livestock-related. Review animals dashboard for planning, tasks, and breeding/harvest timelines.",
        score: clamp(60 + animalsScore * 0.4, 55, 95),
        reasons: [...reasons, "Imports show animals domain signals."],
        actions: [
          action({
            type: "animals.openDashboard",
            label: "Open animals dashboard",
            payload: {},
          }),
          action({
            type: "animals.openPlanner",
            label: "Open animal planner",
            payload: { source: "imports.intelligence" },
          }),
        ],
        data: { animalsScore, inventoryScore, mealsScore, topLabels },
      })
    );
  }

  // 2) If imports suggest inventory, offer supplies check (feed/bedding/minerals/meds)
  if (inventoryScore >= minDomainScore) {
    suggestions.push(
      makeSuggestion({
        kind: "supplies",
        title: "Check livestock supplies after recent imports",
        summary:
          "Recent import activity touches inventory. Verify livestock supplies (feed, bedding, minerals, meds) and reorder thresholds.",
        score: clamp(58 + inventoryScore * 0.45, 50, 92),
        reasons: [...reasons, "Imports show inventory domain signals."],
        actions: [
          action({
            type: "inventory.openSupplies",
            label: "Open supplies",
            payload: {},
          }),
          action({
            type: "inventory.openDashboard",
            label: "Open inventory dashboard",
            payload: { source: "imports.intelligence" },
          }),
        ],
        data: { animalsScore, inventoryScore, mealsScore, topLabels },
      })
    );
  }

  // 3) If imports suggest meals + animals, nudge harvest planning alignment
  if (animalsScore >= minDomainScore && mealsScore >= minDomainScore) {
    suggestions.push(
      makeSuggestion({
        kind: "harvest",
        title: "Align meal planning with harvest timelines",
        summary:
          "Your recent imports touch meals and livestock. Consider mapping upcoming meat needs to harvest candidates and preservation sessions.",
        score: clamp(62 + (animalsScore + mealsScore) * 0.25, 55, 95),
        reasons: [...reasons, "Imports show both meals + animals signals."],
        actions: [
          action({
            type: "animals.openHarvestPlanner",
            label: "Open harvest planner",
            payload: {},
          }),
          action({
            type: "preservation.openPlanner",
            label: "Open preservation planner",
            payload: { source: "imports.intelligence" },
          }),
        ],
        data: { animalsScore, inventoryScore, mealsScore, topLabels },
      })
    );
  }

  // If nothing triggered, return a gentle default (still deterministic)
  if (!suggestions.length) {
    suggestions.push(
      makeSuggestion({
        kind: "weeklyFocus",
        title: "No animal-specific hints from imports",
        summary:
          "Recent imports don’t strongly indicate livestock activity. You can still use the animal planner for care cadence, breeding readiness, and supply estimates.",
        score: 55,
        reasons,
        actions: [
          action({
            type: "animals.openPlanner",
            label: "Open animal planner",
            payload: {},
          }),
          action({
            type: "animals.openDashboard",
            label: "Open animals dashboard",
            payload: {},
          }),
        ],
        data: { animalsScore, inventoryScore, mealsScore, topLabels },
      })
    );
  }

  // Keep stable order & cap
  const out = suggestions
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, maxItems);

  return {
    ok: true,
    suggestions: out,
    meta: {
      source: SOURCE,
      from: "suggestAnimalsFromIntelligence",
      counts: { in: arr.length, out: out.length },
      scores: { animalsScore, inventoryScore, mealsScore },
      topLabels,
      generatedAtISO: isoNow(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

export default AnimalSuggestionService;
export { AnimalSuggestionService };

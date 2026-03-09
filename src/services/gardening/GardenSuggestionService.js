// File: src/services/gardening/GardenSuggestionService.js
/**
 * GardenSuggestionService (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Deterministic (non-AI) suggestion engine that helps a household:
 *      • decide what to plant next
 *      • decide what to harvest next
 *      • decide what to preserve next (freeze/can/dehydrate/ferment)
 *      • decide what to refill in the storehouse (inventory-driven)
 *      • generate “why” + actionable next steps, not vague advice
 *
 * Key principles (SSA-style)
 *  - Offline-first friendly, browser-safe.
 *  - No hard dependency on any specific DB schema: uses adapters.
 *  - Emits SSA events to your eventBus if present.
 *  - Supports “fixed planning layers” / catalogs: crop catalog, meal plan needs,
 *    inventory deficits, preservation capacity, and household preferences.
 *
 * Output shape
 *  - suggestions[] with:
 *      { id, kind, title, summary, score, reasons[], actions[], data, createdAtISO }
 *
 * Typical wiring
 *  - Garden dashboard calls:
 *      GardenSuggestionService.suggest({ householdId, horizonDays: 30 })
 *  - Inventory module calls:
 *      GardenSuggestionService.suggestRefills({ householdId })
 *  - Scheduler calls:
 *      GardenSuggestionService.suggestWeeklyFocus({ householdId })
 */

import eventBus from "@/services/events/eventBus";
import db from "@/services/db";

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

const SOURCE = "gardening.GardenSuggestionService";

function nowMs() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function safeId(prefix = "gs") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function asNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
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
  // Stable stringify for fingerprints/caching
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
  // Simple non-crypto hash for caching keys
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
    // never crash suggestions
  }
}

/* -------------------------------------------------------------------------- */
/* Default catalogs (minimal fallback)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Crop catalog item shape (recommended)
 * -----------------------------------------------------------------------------
 * {
 *   id: "crop.tomato",
 *   name: "Tomato",
 *   category: "vegetable" | "fruit" | "herb" | "grain" | "legume",
 *   tags: ["summer", "nightshade", "sauce"],
 *   daysToMaturity: 75,
 *   yield: { unit: "lb", perPlant: 12 }, // estimates
 *   plantingWindows: [
 *     { season: "spring", startDayOfSeason: 0, endDayOfSeason: 45 },
 *     { season: "summer", startDayOfSeason: 0, endDayOfSeason: 20 }
 *   ],
 *   harvestWindows: [
 *     { season: "summer", startDayOfSeason: 30, endDayOfSeason: 90 },
 *     { season: "fall", startDayOfSeason: 0, endDayOfSeason: 45 }
 *   ],
 *   storage: [
 *     { method: "freeze", shelfLifeDays: 180 },
 *     { method: "can", shelfLifeDays: 365 },
 *     { method: "dehydrate", shelfLifeDays: 365 }
 *   ],
 *   inventoryItemKeys: ["tomatoes", "tomato sauce"],
 *   kitchenRoles: ["sauce", "salad", "stew"]
 * }
 */
const DEFAULT_CROP_CATALOG = [
  {
    id: "crop.spinach",
    name: "Spinach",
    category: "vegetable",
    tags: ["cool-season", "greens"],
    daysToMaturity: 45,
    yield: { unit: "lb", perPlant: 0.6 },
    plantingWindows: [
      { season: "spring", startDayOfSeason: 0, endDayOfSeason: 45 },
      { season: "fall", startDayOfSeason: 0, endDayOfSeason: 50 },
    ],
    harvestWindows: [
      { season: "spring", startDayOfSeason: 25, endDayOfSeason: 90 },
      { season: "fall", startDayOfSeason: 25, endDayOfSeason: 80 },
    ],
    storage: [
      { method: "freeze", shelfLifeDays: 180 },
      { method: "dehydrate", shelfLifeDays: 365 },
    ],
    inventoryItemKeys: ["spinach", "greens"],
    kitchenRoles: ["greens", "side"],
  },
  {
    id: "crop.tomato",
    name: "Tomato",
    category: "fruit",
    tags: ["warm-season", "sauce"],
    daysToMaturity: 75,
    yield: { unit: "lb", perPlant: 10 },
    plantingWindows: [
      { season: "spring", startDayOfSeason: 10, endDayOfSeason: 60 },
      { season: "summer", startDayOfSeason: 0, endDayOfSeason: 15 },
    ],
    harvestWindows: [
      { season: "summer", startDayOfSeason: 35, endDayOfSeason: 90 },
      { season: "fall", startDayOfSeason: 0, endDayOfSeason: 45 },
    ],
    storage: [
      { method: "freeze", shelfLifeDays: 180 },
      { method: "can", shelfLifeDays: 365 },
      { method: "dehydrate", shelfLifeDays: 365 },
      { method: "ferment", shelfLifeDays: 180 },
    ],
    inventoryItemKeys: ["tomato", "tomatoes", "tomato sauce"],
    kitchenRoles: ["sauce", "salad", "stew"],
  },
  {
    id: "crop.onion",
    name: "Onion",
    category: "vegetable",
    tags: ["allium", "base-flavor"],
    daysToMaturity: 110,
    yield: { unit: "lb", perPlant: 0.4 },
    plantingWindows: [
      { season: "spring", startDayOfSeason: 0, endDayOfSeason: 45 },
      { season: "fall", startDayOfSeason: 0, endDayOfSeason: 25 },
    ],
    harvestWindows: [
      { season: "summer", startDayOfSeason: 40, endDayOfSeason: 90 },
      { season: "fall", startDayOfSeason: 10, endDayOfSeason: 70 },
    ],
    storage: [{ method: "cure", shelfLifeDays: 180 }],
    inventoryItemKeys: ["onion", "onions"],
    kitchenRoles: ["base", "seasoning"],
  },
  {
    id: "crop.blackbean",
    name: "Black Beans",
    category: "legume",
    tags: ["protein", "pantry"],
    daysToMaturity: 95,
    yield: { unit: "lb", perPlant: 0.25 },
    plantingWindows: [
      { season: "summer", startDayOfSeason: 0, endDayOfSeason: 35 },
    ],
    harvestWindows: [
      { season: "fall", startDayOfSeason: 0, endDayOfSeason: 70 },
    ],
    storage: [{ method: "dry", shelfLifeDays: 365 }],
    inventoryItemKeys: ["black beans", "beans"],
    kitchenRoles: ["protein", "soup", "stew"],
  },
];

/* -------------------------------------------------------------------------- */
/* Adapters                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * You can inject adapters if your DB/schema differs.
 *
 * Expected adapter contracts:
 *  - inventoryAdapter.getInventorySnapshot({ householdId }) => {
 *        items: [{ key, name, qty, unit, minQty, targetQty, expiresAtISO? }],
 *        updatedAtISO
 *    }
 *
 *  - gardenAdapter.getGardenState({ householdId }) => {
 *        beds: [{ id, name, areaSqFt?, slots?, crops: [{ cropId, plantedAtISO, stage, qtyPlants? }] }],
 *        harvests: [{ cropId, qty, unit, atISO }],
 *        tasks: [{ id, title, dueAtISO?, kind }],
 *        updatedAtISO
 *    }
 *
 *  - mealPlanAdapter.getMealNeeds({ householdId, horizonDays }) => {
 *        needs: [{ key, qty, unit, importance? }], // key is inventory item key
 *        meals: [{ id, title, ingredients: [{ key, qty, unit }] }],
 *        updatedAtISO
 *    }
 *
 *  - prefsAdapter.getGardenPrefs({ householdId }) => {
 *        dislikedKeys?: ["okra"],
 *        preferredCropIds?: ["crop.tomato"],
 *        avoidCropIds?: [],
 *        preservationPriority?: ["can","freeze","dehydrate","ferment"],
 *        pantryTargets?: [{ key, targetQty, unit }],
 *        gardenIntensity?: "low"|"medium"|"high",
 *        hemisphere?: "north"|"south",
 *        seasonOverride?: "spring"|"summer"|"fall"|"winter",
 *        location?: { lat?, lon?, zip?, city?, state? } // optional
 *    }
 *
 *  - catalogAdapter.getCropCatalog() => CropCatalogItem[]
 *  - capacityAdapter.getPreservationCapacity({ householdId }) => {
 *        freezer: { availableCuFt?, loadPct? },
 *        pantry: { shelfSpacePct? },
 *        canning: { jarsAvailable? },
 *        dehydration: { traysAvailable? }
 *    }
 */

function createDefaultInventoryAdapter() {
  return {
    async getInventorySnapshot({ householdId }) {
      // Try a few common table names safely.
      // If nothing found, return empty.
      try {
        const has = (name) =>
          !!db?.[name] && typeof db[name].toArray === "function";
        const pick = () => {
          if (has("inventory_items")) return "inventory_items";
          if (has("inventory")) return "inventory";
          if (has("items")) return "items";
          return null;
        };
        const table = pick();
        if (!table) return { items: [], updatedAtISO: isoNow() };

        const rows = await db[table].toArray();
        // Attempt to normalize
        const items = (rows || [])
          .filter(
            (r) =>
              !householdId ||
              r.householdId === householdId ||
              r.household_id === householdId
          )
          .map((r) => ({
            key: r.key || r.itemKey || r.sku || r.name || safeId("item"),
            name: r.name || r.label || r.key || "Item",
            qty: asNumber(r.qty ?? r.quantity ?? r.onHand, 0),
            unit: r.unit || r.uom || "ea",
            minQty: asNumber(r.minQty ?? r.min ?? r.reorderPoint, 0),
            targetQty: asNumber(r.targetQty ?? r.target ?? r.parLevel, 0),
            expiresAtISO:
              r.expiresAtISO || r.expiry || r.expirationDateISO || null,
          }));

        return { items, updatedAtISO: isoNow() };
      } catch {
        return { items: [], updatedAtISO: isoNow() };
      }
    },
  };
}

function createDefaultGardenAdapter() {
  return {
    async getGardenState({ householdId }) {
      // Best-effort: look for common garden tables.
      try {
        const has = (name) =>
          !!db?.[name] && typeof db[name].toArray === "function";
        const bedsTable =
          (has("garden_beds") && "garden_beds") ||
          (has("beds") && "beds") ||
          (has("gardenBeds") && "gardenBeds") ||
          null;
        const cropsTable =
          (has("garden_crops") && "garden_crops") ||
          (has("planted_crops") && "planted_crops") ||
          (has("plantings") && "plantings") ||
          null;
        const harvestTable =
          (has("garden_harvests") && "garden_harvests") ||
          (has("harvests") && "harvests") ||
          null;
        const tasksTable =
          (has("tasks") && "tasks") ||
          (has("garden_tasks") && "garden_tasks") ||
          null;

        const beds = bedsTable
          ? (await db[bedsTable].toArray())
              .filter(
                (r) =>
                  !householdId ||
                  r.householdId === householdId ||
                  r.household_id === householdId
              )
              .map((r) => ({
                id: r.id || safeId("bed"),
                name: r.name || r.label || "Bed",
                areaSqFt: asNumber(r.areaSqFt ?? r.area ?? r.squareFeet, null),
                slots: asNumber(r.slots ?? r.capacity, null),
                crops: [],
              }))
          : [];

        const crops = cropsTable
          ? (await db[cropsTable].toArray())
              .filter(
                (r) =>
                  !householdId ||
                  r.householdId === householdId ||
                  r.household_id === householdId
              )
              .map((r) => ({
                id: r.id || safeId("plant"),
                bedId: r.bedId || r.bed_id || null,
                cropId: r.cropId || r.crop_id || r.idCrop || null,
                plantedAtISO:
                  r.plantedAtISO || r.plantedAt || r.planted_at || null,
                stage: r.stage || r.status || "planted",
                qtyPlants: asNumber(r.qtyPlants ?? r.count ?? r.plants, 1),
              }))
          : [];

        const byBed = new Map();
        for (const b of beds) byBed.set(b.id, b);

        for (const c of crops) {
          const bed = c.bedId ? byBed.get(c.bedId) : null;
          if (bed)
            bed.crops.push({
              cropId: c.cropId,
              plantedAtISO: c.plantedAtISO,
              stage: c.stage,
              qtyPlants: c.qtyPlants,
            });
        }

        const harvests = harvestTable
          ? (await db[harvestTable].toArray())
              .filter(
                (r) =>
                  !householdId ||
                  r.householdId === householdId ||
                  r.household_id === householdId
              )
              .map((r) => ({
                cropId: r.cropId || r.crop_id || null,
                qty: asNumber(r.qty ?? r.quantity, 0),
                unit: r.unit || "ea",
                atISO: r.atISO || r.harvestedAtISO || r.dateISO || null,
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
                kind: r.kind || r.type || "garden",
              }))
          : [];

        return { beds, harvests, tasks, updatedAtISO: isoNow() };
      } catch {
        return { beds: [], harvests: [], tasks: [], updatedAtISO: isoNow() };
      }
    },
  };
}

function createDefaultMealPlanAdapter() {
  return {
    async getMealNeeds({ householdId, horizonDays }) {
      // Optional — if you have a meal plan table. If not, return empty.
      try {
        const has = (name) =>
          !!db?.[name] && typeof db[name].toArray === "function";
        const tbl =
          (has("meal_plans") && "meal_plans") ||
          (has("mealPlans") && "mealPlans") ||
          (has("plans") && "plans") ||
          null;

        if (!tbl) return { needs: [], meals: [], updatedAtISO: isoNow() };

        const rows = await db[tbl].toArray();
        const plans = (rows || []).filter(
          (r) =>
            !householdId ||
            r.householdId === householdId ||
            r.household_id === householdId
        );

        // Normalize into ingredient needs (best effort)
        const needsMap = new Map();
        const meals = [];

        for (const p of plans) {
          const items = p.ingredients || p.items || p.needs || [];
          const title = p.title || p.name || "Meal Plan";
          meals.push({ id: p.id || safeId("meal"), title, ingredients: [] });

          for (const it of items) {
            const key = it.key || it.itemKey || it.name;
            if (!key) continue;
            const nKey = normalizeStr(key);
            const qty = asNumber(it.qty ?? it.quantity ?? 0, 0);
            const unit = it.unit || "ea";
            const importance = asNumber(it.importance, 1);

            meals[meals.length - 1].ingredients.push({ key: nKey, qty, unit });

            const cur = needsMap.get(nKey) || {
              key: nKey,
              qty: 0,
              unit,
              importance: 0,
            };
            cur.qty += qty;
            cur.unit = unit || cur.unit;
            cur.importance = Math.max(cur.importance || 0, importance);
            needsMap.set(nKey, cur);
          }
        }

        const needs = Array.from(needsMap.values());
        return { needs, meals, updatedAtISO: isoNow() };
      } catch {
        return { needs: [], meals: [], updatedAtISO: isoNow() };
      }
    },
  };
}

function createDefaultPrefsAdapter() {
  return {
    async getGardenPrefs() {
      // Optional — if you have preferences stored elsewhere. Default empty.
      return {
        dislikedKeys: [],
        preferredCropIds: [],
        avoidCropIds: [],
        preservationPriority: [
          "freeze",
          "can",
          "dehydrate",
          "ferment",
          "cure",
          "dry",
        ],
        pantryTargets: [],
        gardenIntensity: "medium",
        hemisphere: "north",
        seasonOverride: null,
        location: null,
      };
    },
  };
}

function createDefaultCatalogAdapter() {
  return {
    async getCropCatalog() {
      return DEFAULT_CROP_CATALOG;
    },
  };
}

function createDefaultCapacityAdapter() {
  return {
    async getPreservationCapacity() {
      // Unknown => assume moderate constraints
      return {
        freezer: { availableCuFt: null, loadPct: null },
        pantry: { shelfSpacePct: null },
        canning: { jarsAvailable: null },
        dehydration: { traysAvailable: null },
      };
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Season inference (simple, deterministic)                                   */
/* -------------------------------------------------------------------------- */

function inferSeason({ atMs, hemisphere = "north" }) {
  const d = new Date(atMs);
  const m = d.getMonth(); // 0..11
  const north = normalizeStr(hemisphere) !== "south";

  // Meteorological seasons (simple & stable)
  // North: DJF winter, MAM spring, JJA summer, SON fall
  // South swapped by 6 months.
  const idx = north ? m : (m + 6) % 12;

  if (idx === 11 || idx === 0 || idx === 1) return "winter";
  if (idx === 2 || idx === 3 || idx === 4) return "spring";
  if (idx === 5 || idx === 6 || idx === 7) return "summer";
  return "fall";
}

function dayOfSeasonApprox({ atMs, season, hemisphere = "north" }) {
  // Approximate day index within a meteorological season (0..~91)
  const d = new Date(atMs);
  const year = d.getFullYear();

  const north = normalizeStr(hemisphere) !== "south";
  const seasonStarts = north
    ? {
        winter: Date.UTC(year, 11, 1), // Dec 1
        spring: Date.UTC(year, 2, 1), // Mar 1
        summer: Date.UTC(year, 5, 1), // Jun 1
        fall: Date.UTC(year, 8, 1), // Sep 1
      }
    : {
        winter: Date.UTC(year, 5, 1), // Jun 1
        spring: Date.UTC(year, 8, 1), // Sep 1
        summer: Date.UTC(year, 11, 1), // Dec 1
        fall: Date.UTC(year, 2, 1), // Mar 1
      };

  const start =
    seasonStarts[season] ?? seasonStarts[inferSeason({ atMs, hemisphere })];
  const diffDays = Math.floor((atMs - start) / 86400000);
  return clamp(diffDays, 0, 120);
}

function isInWindow(window, season, dayOfSeason) {
  if (!window || !season) return false;
  if (window.season !== season) return false;
  const s = asNumber(window.startDayOfSeason, 0);
  const e = asNumber(window.endDayOfSeason, 999);
  return dayOfSeason >= s && dayOfSeason <= e;
}

/* -------------------------------------------------------------------------- */
/* Inventory deficits                                                         */
/* -------------------------------------------------------------------------- */

function buildInventoryIndex(items) {
  const byKey = new Map();
  for (const it of items || []) {
    const key = normalizeStr(it.key || it.name);
    if (!key) continue;
    byKey.set(key, {
      key,
      name: it.name || it.key || key,
      qty: asNumber(it.qty, 0),
      unit: it.unit || "ea",
      minQty: asNumber(it.minQty, 0),
      targetQty: asNumber(it.targetQty, 0),
      expiresAtISO: it.expiresAtISO || null,
    });
  }
  return byKey;
}

function computeDeficits({ inventoryByKey, pantryTargets, mealNeeds }) {
  const deficits = [];

  // 1) Pantry targets (storehouse provisioning)
  for (const t of pantryTargets || []) {
    const key = normalizeStr(t.key);
    if (!key) continue;
    const targetQty = asNumber(t.targetQty, 0);
    const inv = inventoryByKey.get(key);
    const qty = inv ? asNumber(inv.qty, 0) : 0;
    const unit = t.unit || inv?.unit || "ea";
    const gap = targetQty - qty;
    if (gap > 0)
      deficits.push({ key, unit, gap, source: "pantryTarget", importance: 2 });
  }

  // 2) Meal needs horizon
  for (const n of mealNeeds || []) {
    const key = normalizeStr(n.key);
    if (!key) continue;
    const needed = asNumber(n.qty, 0);
    const inv = inventoryByKey.get(key);
    const qty = inv ? asNumber(inv.qty, 0) : 0;
    const gap = needed - qty;
    if (gap > 0) {
      deficits.push({
        key,
        unit: n.unit || inv?.unit || "ea",
        gap,
        source: "mealPlan",
        importance: asNumber(n.importance, 1),
      });
    }
  }

  // 3) Min quantities (reorder thresholds)
  for (const inv of inventoryByKey.values()) {
    if (inv.minQty > 0 && inv.qty < inv.minQty) {
      deficits.push({
        key: inv.key,
        unit: inv.unit,
        gap: inv.minQty - inv.qty,
        source: "minQty",
        importance: 1.5,
      });
    }
  }

  // Merge by key
  const merged = new Map();
  for (const d of deficits) {
    const cur = merged.get(d.key) || {
      key: d.key,
      unit: d.unit,
      gap: 0,
      importance: 0,
      sources: [],
    };
    cur.gap += asNumber(d.gap, 0);
    cur.importance = Math.max(cur.importance, asNumber(d.importance, 0));
    cur.unit = d.unit || cur.unit;
    cur.sources.push(d.source);
    merged.set(d.key, cur);
  }

  const out = Array.from(merged.values()).map((x) => ({
    ...x,
    sources: uniq(x.sources),
  }));

  // Highest importance and gap first
  out.sort((a, b) => b.importance - a.importance || b.gap - a.gap);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Crop matching                                                              */
/* -------------------------------------------------------------------------- */

function cropMatchesDeficit(crop, deficitKeyNorm) {
  const keys = (crop.inventoryItemKeys || []).map(normalizeStr).filter(Boolean);
  return keys.includes(deficitKeyNorm);
}

function cropPreferencePenalty(crop, prefs) {
  const avoid = new Set((prefs?.avoidCropIds || []).map(String));
  const preferred = new Set((prefs?.preferredCropIds || []).map(String));

  if (avoid.has(crop.id)) return 999; // hard block
  if (preferred.has(crop.id)) return -1; // slight boost
  return 0;
}

function cropSeasonScore(crop, season, dayOfSeason) {
  const plantWins = crop.plantingWindows || [];
  const ok = plantWins.some((w) => isInWindow(w, season, dayOfSeason));
  if (!ok) return 0;

  // “how centered” in the window (center = best)
  const w = plantWins.find((x) => isInWindow(x, season, dayOfSeason));
  const s = asNumber(w.startDayOfSeason, 0);
  const e = asNumber(w.endDayOfSeason, 120);
  const mid = (s + e) / 2;
  const dist = Math.abs(dayOfSeason - mid);
  const span = Math.max(1, (e - s) / 2);
  const centered = clamp(1 - dist / span, 0, 1);
  return 0.6 + 0.4 * centered; // 0.6..1.0
}

function maturityHorizonScore(crop, horizonDays) {
  const dtm = asNumber(crop.daysToMaturity, 999);
  if (dtm <= 0) return 0.5;
  if (!horizonDays || horizonDays <= 0) return 0.6;
  // Prefer crops that can mature within horizon (but not only those)
  if (dtm <= horizonDays) return 1.0;
  const ratio = horizonDays / dtm; // < 1
  return clamp(0.4 + 0.6 * ratio, 0.4, 0.95);
}

function preservationFitScore(crop, prefs, capacity) {
  const prio = (prefs?.preservationPriority || []).map(normalizeStr);
  const storage = (crop.storage || [])
    .map((s) => normalizeStr(s.method))
    .filter(Boolean);
  if (!storage.length) return 0.6;

  // Base = how high-priority methods are supported
  let best = 0.5;
  for (let i = 0; i < prio.length; i++) {
    const method = prio[i];
    if (storage.includes(method)) {
      const score = 1 - i / Math.max(1, prio.length); // earlier = higher
      best = Math.max(best, score);
    }
  }

  // Capacity constraints (soft)
  const freezerLoad = asNumber(capacity?.freezer?.loadPct, null);
  if (
    freezerLoad != null &&
    freezerLoad >= 0.85 &&
    storage.includes("freeze")
  ) {
    best *= 0.85;
  }
  const jars = asNumber(capacity?.canning?.jarsAvailable, null);
  if (jars != null && jars <= 6 && storage.includes("can")) {
    best *= 0.9;
  }

  return clamp(best, 0.35, 1.0);
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
/* Service                                                                    */
/* -------------------------------------------------------------------------- */

class GardenSuggestionServiceImpl {
  constructor() {
    this._cache = new Map(); // key -> { atMs, value }
    this._cacheTtlMs = 30_000; // short-lived; dashboards refresh frequently
  }

  /**
   * Main entry: generate multi-category suggestions.
   */
  async suggest(opts = {}) {
    const started = nowMs();
    const {
      householdId = null,
      horizonDays = 30,
      include = ["refill", "plant", "harvest", "preserve", "weeklyFocus"],
      adapters = {},
    } = opts;

    const deps = this._resolveAdapters(adapters);

    const prefs = await deps.prefsAdapter.getGardenPrefs({ householdId });
    const capacity = await deps.capacityAdapter.getPreservationCapacity({
      householdId,
    });

    // Season
    const season =
      prefs?.seasonOverride ||
      inferSeason({ atMs: nowMs(), hemisphere: prefs?.hemisphere || "north" });
    const dayOfSeason = dayOfSeasonApprox({
      atMs: nowMs(),
      season,
      hemisphere: prefs?.hemisphere || "north",
    });

    // Snapshot inputs
    const [invSnap, gardenState, mealNeedsPack, cropCatalog] =
      await Promise.all([
        deps.inventoryAdapter.getInventorySnapshot({ householdId }),
        deps.gardenAdapter.getGardenState({ householdId }),
        deps.mealPlanAdapter.getMealNeeds({ householdId, horizonDays }),
        deps.catalogAdapter.getCropCatalog({ householdId }),
      ]);

    const inventoryByKey = buildInventoryIndex(invSnap?.items || []);
    const deficits = computeDeficits({
      inventoryByKey,
      pantryTargets: prefs?.pantryTargets || [],
      mealNeeds: mealNeedsPack?.needs || [],
    });

    const ctx = {
      householdId,
      horizonDays,
      season,
      dayOfSeason,
      prefs: prefs || {},
      capacity: capacity || {},
      inventory: invSnap || { items: [] },
      garden: gardenState || { beds: [], harvests: [], tasks: [] },
      mealNeeds: mealNeedsPack || { needs: [], meals: [] },
      cropCatalog: Array.isArray(cropCatalog)
        ? cropCatalog
        : DEFAULT_CROP_CATALOG,
      deficits,
    };

    const fp = hashString(
      stableJson({ include, ctx: this._fingerprintCtx(ctx) })
    );
    const cached = this._getCache(fp);
    if (cached) return cached;

    const suggestions = [];

    if (include.includes("refill")) {
      suggestions.push(...this._suggestRefills(ctx));
    }
    if (include.includes("plant")) {
      suggestions.push(...this._suggestPlanting(ctx));
    }
    if (include.includes("harvest")) {
      suggestions.push(...this._suggestHarvest(ctx));
    }
    if (include.includes("preserve")) {
      suggestions.push(...this._suggestPreservation(ctx));
    }
    if (include.includes("weeklyFocus")) {
      suggestions.push(...this._suggestWeeklyFocus(ctx));
    }

    // Sort by score desc, then stable by title
    suggestions.sort(
      (a, b) => b.score - a.score || a.title.localeCompare(b.title)
    );

    const result = {
      ok: true,
      householdId,
      season,
      dayOfSeason,
      horizonDays,
      counts: {
        total: suggestions.length,
        refill: suggestions.filter((s) => s.kind === "refill").length,
        plant: suggestions.filter((s) => s.kind === "plant").length,
        harvest: suggestions.filter((s) => s.kind === "harvest").length,
        preserve: suggestions.filter((s) => s.kind === "preserve").length,
        weeklyFocus: suggestions.filter((s) => s.kind === "weeklyFocus").length,
      },
      suggestions,
      generatedAtISO: isoNow(),
      durationMs: nowMs() - started,
      inputs: {
        inventoryUpdatedAtISO: invSnap?.updatedAtISO || null,
        gardenUpdatedAtISO: gardenState?.updatedAtISO || null,
        mealNeedsUpdatedAtISO: mealNeedsPack?.updatedAtISO || null,
      },
    };

    this._setCache(fp, result);

    emit("garden.suggestions.generated", {
      source: SOURCE,
      householdId,
      season,
      dayOfSeason,
      horizonDays,
      counts: result.counts,
      durationMs: result.durationMs,
    });

    return result;
  }

  /**
   * Convenience: only refills (storehouse provisioning).
   */
  async suggestRefills(opts = {}) {
    const res = await this.suggest({ ...opts, include: ["refill"] });
    return res;
  }

  /**
   * Convenience: “what should I do this week” as a short list.
   */
  async suggestWeeklyFocus(opts = {}) {
    const res = await this.suggest({
      ...opts,
      include: ["weeklyFocus", "harvest", "plant", "preserve"],
    });
    // Return top N
    const top = (res.suggestions || []).slice(0, asNumber(opts.limit, 8) || 8);
    return {
      ...res,
      suggestions: top,
      counts: { ...res.counts, total: top.length },
    };
  }

  /* ------------------------------- internals ------------------------------ */

  _resolveAdapters(adapters) {
    return {
      inventoryAdapter:
        adapters.inventoryAdapter || createDefaultInventoryAdapter(),
      gardenAdapter: adapters.gardenAdapter || createDefaultGardenAdapter(),
      mealPlanAdapter:
        adapters.mealPlanAdapter || createDefaultMealPlanAdapter(),
      prefsAdapter: adapters.prefsAdapter || createDefaultPrefsAdapter(),
      catalogAdapter: adapters.catalogAdapter || createDefaultCatalogAdapter(),
      capacityAdapter:
        adapters.capacityAdapter || createDefaultCapacityAdapter(),
    };
  }

  _fingerprintCtx(ctx) {
    // Keep fingerprint small & stable; don’t include full rows.
    return {
      householdId: ctx.householdId,
      horizonDays: ctx.horizonDays,
      season: ctx.season,
      dayOfSeason: ctx.dayOfSeason,
      prefs: {
        dislikedKeys: ctx.prefs?.dislikedKeys || [],
        preferredCropIds: ctx.prefs?.preferredCropIds || [],
        avoidCropIds: ctx.prefs?.avoidCropIds || [],
        pantryTargets: ctx.prefs?.pantryTargets || [],
        gardenIntensity: ctx.prefs?.gardenIntensity || "medium",
        preservationPriority: ctx.prefs?.preservationPriority || [],
      },
      deficitsTop: (ctx.deficits || []).slice(0, 20),
      bedsCount: (ctx.garden?.beds || []).length,
      plantingsCount: (ctx.garden?.beds || []).reduce(
        (n, b) => n + (b.crops?.length || 0),
        0
      ),
      inventoryCount: (ctx.inventory?.items || []).length,
      cropCatalogCount: (ctx.cropCatalog || []).length,
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

  _suggestRefills(ctx) {
    const out = [];
    const disliked = new Set(
      (ctx.prefs?.dislikedKeys || []).map(normalizeStr).filter(Boolean)
    );

    // Use deficits to propose refills, and map deficits to “grow it” options later.
    for (const d of (ctx.deficits || []).slice(0, 25)) {
      if (disliked.has(d.key)) continue;

      const score =
        60 +
        clamp(d.importance * 10, 0, 25) +
        clamp(Math.log10(1 + d.gap) * 10, 0, 15);

      out.push(
        makeSuggestion({
          kind: "refill",
          title: `Refill: ${d.key}`,
          summary: `You’re short by ~${Math.round(d.gap * 10) / 10} ${
            d.unit
          } based on ${d.sources.join(", ")}.`,
          score,
          reasons: [
            `Gap: ${Math.round(d.gap * 10) / 10} ${d.unit}`,
            `Drivers: ${d.sources.join(", ")}`,
          ],
          actions: [
            action({
              type: "inventory.open",
              label: "Open inventory item",
              payload: { key: d.key, householdId: ctx.householdId },
            }),
            action({
              type: "shopping.add",
              label: "Add to grocery list",
              payload: {
                key: d.key,
                qty: d.gap,
                unit: d.unit,
                householdId: ctx.householdId,
              },
            }),
          ],
          data: { deficit: d },
        })
      );
    }

    return out;
  }

  _suggestPlanting(ctx) {
    const out = [];

    const catalog = ctx.cropCatalog || [];
    const deficits = ctx.deficits || [];

    // Determine “open capacity” in beds (best-effort)
    const beds = ctx.garden?.beds || [];
    const openBeds = beds
      .map((b) => {
        const slots = asNumber(b.slots, null);
        const planted = (b.crops || []).reduce(
          (n, c) => n + asNumber(c.qtyPlants, 1),
          0
        );
        const openSlots = slots != null ? Math.max(0, slots - planted) : null;
        return { bedId: b.id, bedName: b.name, openSlots, planted, slots };
      })
      .filter((b) => b.openSlots == null || b.openSlots > 0);

    // Match crops to biggest deficits first
    const deficitKeys = deficits.map((d) => d.key);
    const deficitKeySet = new Set(deficitKeys);

    const seasonFactorByCrop = new Map();
    for (const crop of catalog) {
      const seasonScore = cropSeasonScore(crop, ctx.season, ctx.dayOfSeason);
      seasonFactorByCrop.set(crop.id, seasonScore);
    }

    // Candidate crops: in-season plantable, not avoided
    const candidates = [];
    for (const crop of catalog) {
      const seasonScore = seasonFactorByCrop.get(crop.id) || 0;
      if (seasonScore <= 0) continue;

      const penalty = cropPreferencePenalty(crop, ctx.prefs);
      if (penalty >= 999) continue;

      const matches = (crop.inventoryItemKeys || [])
        .map(normalizeStr)
        .filter((k) => deficitKeySet.has(k));

      candidates.push({
        crop,
        seasonScore,
        penalty,
        matches,
      });
    }

    // Score each candidate:
    //  - deficit alignment
    //  - season fit
    //  - maturity horizon
    //  - preservation fit
    //  - preference boost
    const scored = candidates.map((c) => {
      const deficitBoost =
        c.matches.length > 0 ? 1 + Math.min(1.0, c.matches.length / 3) : 0.7; // still allow variety
      const horizonScore = maturityHorizonScore(c.crop, ctx.horizonDays);
      const preserveScore = preservationFitScore(
        c.crop,
        ctx.prefs,
        ctx.capacity
      );

      let prefBoost = 1.0;
      if (c.penalty < 0) prefBoost += 0.08;

      const base =
        70 *
        deficitBoost *
        c.seasonScore *
        horizonScore *
        preserveScore *
        prefBoost;
      const score = clamp(base, 0, 100);

      return { ...c, score };
    });

    scored.sort(
      (a, b) => b.score - a.score || a.crop.name.localeCompare(b.crop.name)
    );

    const top = scored.slice(0, 12);
    for (const c of top) {
      const crop = c.crop;
      const yieldPerPlant = asNumber(crop?.yield?.perPlant, null);
      const yieldUnit = crop?.yield?.unit || "ea";

      const matchKeys = c.matches.length
        ? c.matches
        : (crop.inventoryItemKeys || []).map(normalizeStr).slice(0, 2);

      const where =
        openBeds.length === 0
          ? "No bed capacity detected. Add/define bed slots or clear a bed."
          : `Suggested beds: ${openBeds
              .slice(0, 3)
              .map(
                (b) =>
                  `${b.bedName}${
                    b.openSlots != null ? ` (${b.openSlots} open)` : ""
                  }`
              )
              .join(", ")}.`;

      const reasons = [
        `Planting window fits: ${ctx.season} (day ~${ctx.dayOfSeason}).`,
        c.matches.length
          ? `Matches deficits: ${c.matches.join(", ")}.`
          : "Good rotation/variety candidate.",
        `Maturity: ~${asNumber(crop.daysToMaturity, "?")} days.`,
      ];

      if (yieldPerPlant != null)
        reasons.push(
          `Estimated yield: ~${yieldPerPlant} ${yieldUnit} per plant.`
        );

      out.push(
        makeSuggestion({
          kind: "plant",
          title: `Plant: ${crop.name}`,
          summary: `${where} Targets: ${matchKeys.join(", ")}.`,
          score: c.score,
          reasons,
          actions: [
            action({
              type: "garden.planPlanting",
              label: "Plan planting",
              payload: {
                householdId: ctx.householdId,
                cropId: crop.id,
                cropName: crop.name,
                season: ctx.season,
                suggestedBeds: openBeds.slice(0, 3),
              },
            }),
            action({
              type: "inventory.linkCrop",
              label: "Link crop → inventory keys",
              payload: {
                householdId: ctx.householdId,
                cropId: crop.id,
                keys: crop.inventoryItemKeys || [],
              },
            }),
          ],
          data: { crop, matches: c.matches, seasonScore: c.seasonScore },
        })
      );
    }

    // Add one “capacity” suggestion if no beds available
    if (beds.length > 0 && openBeds.length === 0) {
      out.unshift(
        makeSuggestion({
          kind: "plant",
          title: "Create planting capacity",
          summary:
            "All beds appear fully planted (or no slots configured). Clear a bed, add containers, or define bed slot capacity.",
          score: 88,
          reasons: [
            "Planting suggestions depend on available bed/container capacity.",
          ],
          actions: [
            action({
              type: "garden.openBeds",
              label: "Open garden beds",
              payload: { householdId: ctx.householdId },
            }),
            action({
              type: "garden.addContainer",
              label: "Add containers",
              payload: { householdId: ctx.householdId },
            }),
          ],
          data: { bedsCount: beds.length },
        })
      );
    }

    return out;
  }

  _suggestHarvest(ctx) {
    const out = [];
    const beds = ctx.garden?.beds || [];
    const catalogById = new Map((ctx.cropCatalog || []).map((c) => [c.id, c]));

    // Heuristic: if plantedAtISO exists and daysToMaturity exists, estimate “ready”.
    const now = nowMs();

    const candidates = [];
    for (const b of beds) {
      for (const p of b.crops || []) {
        const cropId = p.cropId;
        if (!cropId) continue;
        const crop = catalogById.get(cropId);
        if (!crop) continue;

        const plantedAt = p.plantedAtISO ? Date.parse(p.plantedAtISO) : null;
        const dtm = asNumber(crop.daysToMaturity, null);
        if (!Number.isFinite(plantedAt) || dtm == null) continue;

        const ageDays = (now - plantedAt) / 86400000;
        const maturityPct = clamp(ageDays / Math.max(1, dtm), 0, 2);

        // Harvest window check (optional) using current season/day approximation
        const harvestWins = crop.harvestWindows || [];
        const seasonOk =
          harvestWins.length === 0 ||
          harvestWins.some((w) => isInWindow(w, ctx.season, ctx.dayOfSeason));

        const qtyPlants = asNumber(p.qtyPlants, 1);
        const yieldPerPlant = asNumber(crop?.yield?.perPlant, null);
        const estYield =
          yieldPerPlant != null ? yieldPerPlant * qtyPlants : null;

        // Score: mature, season ok, bigger yield first
        let score = 50;
        score += clamp((maturityPct - 0.9) * 60, 0, 40); // >0.9 approaches harvest
        if (seasonOk) score += 10;
        if (estYield != null)
          score += clamp(Math.log10(1 + estYield) * 10, 0, 10);
        score = clamp(score, 0, 100);

        candidates.push({
          bedId: b.id,
          bedName: b.name,
          cropId,
          crop,
          plantedAtISO: p.plantedAtISO,
          ageDays,
          maturityPct,
          estYield,
          seasonOk,
          score,
        });
      }
    }

    candidates.sort(
      (a, b) => b.score - a.score || b.maturityPct - a.maturityPct
    );

    for (const c of candidates.slice(0, 10)) {
      const crop = c.crop;
      const yieldUnit = crop?.yield?.unit || "ea";
      out.push(
        makeSuggestion({
          kind: "harvest",
          title: `Harvest check: ${crop.name}`,
          summary: `Bed: ${c.bedName}. Age ~${Math.round(
            c.ageDays
          )} days vs maturity ~${asNumber(crop.daysToMaturity, "?")}.`,
          score: c.score,
          reasons: [
            `Estimated maturity: ${Math.round(c.maturityPct * 100)}%.`,
            c.seasonOk
              ? `Harvest window aligns with ${ctx.season}.`
              : "Harvest window not confirmed for current season.",
            c.estYield != null
              ? `Estimated yield: ~${
                  Math.round(c.estYield * 10) / 10
                } ${yieldUnit}.`
              : null,
          ].filter(Boolean),
          actions: [
            action({
              type: "garden.logHarvest",
              label: "Log harvest",
              payload: {
                householdId: ctx.householdId,
                cropId: crop.id,
                bedId: c.bedId,
              },
            }),
            action({
              type: "inventory.addFromHarvest",
              label: "Add harvest to inventory",
              payload: {
                householdId: ctx.householdId,
                cropId: crop.id,
                inventoryKeys: crop.inventoryItemKeys || [],
              },
            }),
          ],
          data: c,
        })
      );
    }

    // If nothing, suggest “garden walkthrough”
    if (out.length === 0) {
      out.push(
        makeSuggestion({
          kind: "harvest",
          title: "Garden walkthrough",
          summary:
            "No harvest-ready crops detected (or missing planting dates). Do a quick walkthrough and log plantings with dates for accurate readiness suggestions.",
          score: 72,
          reasons: [
            "Harvest readiness scoring improves significantly with plantedAt dates and crop IDs.",
          ],
          actions: [
            action({
              type: "garden.openLogPlanting",
              label: "Log plantings",
              payload: { householdId: ctx.householdId },
            }),
            action({
              type: "garden.openBeds",
              label: "Open beds",
              payload: { householdId: ctx.householdId },
            }),
          ],
          data: {},
        })
      );
    }

    return out;
  }

  _suggestPreservation(ctx) {
    const out = [];
    const harvests = ctx.garden?.harvests || [];

    if (!harvests.length) {
      out.push(
        makeSuggestion({
          kind: "preserve",
          title: "Preservation prep",
          summary:
            "No recent harvests found. Prep preservation capacity anyway: label jars, clear freezer bins, sanitize containers.",
          score: 55,
          reasons: [
            "Prepared capacity reduces spoilage when harvest comes in fast.",
          ],
          actions: [
            action({
              type: "preservation.openCapacity",
              label: "Open preservation capacity",
              payload: { householdId: ctx.householdId },
            }),
            action({
              type: "tasks.add",
              label: "Add prep tasks",
              payload: {
                householdId: ctx.householdId,
                kind: "preservationPrep",
              },
            }),
          ],
          data: {},
        })
      );
      return out;
    }

    // Aggregate harvests by cropId
    const byCrop = new Map();
    for (const h of harvests) {
      const cid = h.cropId || "unknown";
      const cur = byCrop.get(cid) || {
        cropId: cid,
        qty: 0,
        unit: h.unit || "ea",
        lastAtISO: null,
        count: 0,
      };
      cur.qty += asNumber(h.qty, 0);
      cur.unit = h.unit || cur.unit;
      cur.lastAtISO = h.atISO || cur.lastAtISO;
      cur.count += 1;
      byCrop.set(cid, cur);
    }

    const catalogById = new Map((ctx.cropCatalog || []).map((c) => [c.id, c]));
    const prio = (ctx.prefs?.preservationPriority || []).map(normalizeStr);

    const candidates = [];
    for (const agg of byCrop.values()) {
      const crop = catalogById.get(agg.cropId);
      if (!crop) continue;
      const methods = (crop.storage || [])
        .map((s) => normalizeStr(s.method))
        .filter(Boolean);

      // Choose best method by preference order
      let bestMethod = methods[0] || "freeze";
      let bestRank = 999;
      for (const m of methods) {
        const r = prio.indexOf(m);
        if (r >= 0 && r < bestRank) {
          bestRank = r;
          bestMethod = m;
        }
      }

      // Score by quantity + perishability (crudely inferred by category)
      let base = 60;
      base += clamp(Math.log10(1 + agg.qty) * 15, 0, 20);
      if ((crop.tags || []).some((t) => normalizeStr(t).includes("greens")))
        base += 10; // greens spoil fast
      const capScore = preservationFitScore(crop, ctx.prefs, ctx.capacity);
      const score = clamp(base * capScore, 0, 100);

      candidates.push({ ...agg, crop, bestMethod, methods, score });
    }

    candidates.sort((a, b) => b.score - a.score || b.qty - a.qty);

    for (const c of candidates.slice(0, 10)) {
      const crop = c.crop;
      out.push(
        makeSuggestion({
          kind: "preserve",
          title: `Preserve: ${crop.name}`,
          summary: `Best fit: ${c.bestMethod}. Harvest total ~${
            Math.round(c.qty * 10) / 10
          } ${c.unit}.`,
          score: c.score,
          reasons: [
            `Available methods: ${c.methods.join(", ") || "unknown"}.`,
            `Preference order: ${
              (ctx.prefs?.preservationPriority || []).join(", ") || "not set"
            }.`,
          ],
          actions: [
            action({
              type: "preservation.startSession",
              label: `Start ${c.bestMethod} session`,
              payload: {
                householdId: ctx.householdId,
                cropId: crop.id,
                method: c.bestMethod,
                qty: c.qty,
                unit: c.unit,
              },
            }),
            action({
              type: "inventory.updatePreserved",
              label: "Mark preserved inventory",
              payload: {
                householdId: ctx.householdId,
                cropId: crop.id,
                inventoryKeys: crop.inventoryItemKeys || [],
              },
            }),
          ],
          data: c,
        })
      );
    }

    return out;
  }

  _suggestWeeklyFocus(ctx) {
    const out = [];

    // Compact “focus plan” based on deficits + season + existing tasks
    const deficits = (ctx.deficits || []).slice(0, 6);
    const tasks = (ctx.garden?.tasks || []).slice(0, 10);

    const focusItems = [];

    if (deficits.length) {
      focusItems.push(`Top deficits: ${deficits.map((d) => d.key).join(", ")}`);
    } else {
      focusItems.push(
        "No major deficits detected — focus on rotation, soil health, and preservation capacity."
      );
    }

    // In-season planting note
    focusItems.push(`Current season: ${ctx.season} (day ~${ctx.dayOfSeason}).`);

    if (tasks.length) {
      const dueSoon = tasks
        .slice()
        .sort((a, b) => {
          const ad = a.dueAtISO ? Date.parse(a.dueAtISO) : Infinity;
          const bd = b.dueAtISO ? Date.parse(b.dueAtISO) : Infinity;
          return ad - bd;
        })
        .slice(0, 3)
        .map((t) => t.title);
      focusItems.push(`Existing tasks: ${dueSoon.join("; ")}`);
    }

    const score = 85;

    out.push(
      makeSuggestion({
        kind: "weeklyFocus",
        title: "Weekly garden focus",
        summary: focusItems.join(" • "),
        score,
        reasons: [
          "Built from storehouse deficits, season fit, and existing garden tasks.",
        ],
        actions: [
          action({
            type: "garden.openDashboard",
            label: "Open garden dashboard",
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
          deficits,
          tasksCount: tasks.length,
          season: ctx.season,
          dayOfSeason: ctx.dayOfSeason,
        },
      })
    );

    return out;
  }
}

/* -------------------------------------------------------------------------- */
/* Public singleton                                                           */
/* -------------------------------------------------------------------------- */

const GardenSuggestionService = new GardenSuggestionServiceImpl();

/* -------------------------------------------------------------------------- */
/* ✅ COMPAT EXPORT (Build fix): suggestGardenFromIntelligence                 */
/* -------------------------------------------------------------------------- */
/**
 * GardenPlanner.jsx imports:
 *   import { suggestGardenFromIntelligence } from "@/services/gardening/GardenSuggestionService";
 *
 * This is a deterministic alias that returns the same shape as GardenSuggestionService.suggest().
 * It defaults to a “weekly focus” style include set, but callers can override.
 *
 * @param {Object} opts
 * @returns {Promise<any>}
 */
export async function suggestGardenFromIntelligence(opts = {}) {
  // Preserve caller intent if they provide include; otherwise give a useful default.
  const include =
    Array.isArray(opts.include) && opts.include.length
      ? opts.include
      : ["weeklyFocus", "harvest", "plant", "preserve", "refill"];

  return GardenSuggestionService.suggest({ ...opts, include });
}

export default GardenSuggestionService;
export { GardenSuggestionService };

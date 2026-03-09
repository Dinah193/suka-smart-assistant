// C:\Users\larho\suka-smart-assistant\src\analytics\ingredientUsage.stats.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Ingredient Usage & Seasonality Stats
// -----------------------------------------------------------------------------
// PURPOSE
// Track how often ingredients are mentioned / used / harvested / preserved
// across the entire household engine:
//
//   imports (recipe, garden/seed, animal/butchery, storehouse, video/how-to)
//   → normalize → tag/intelligence → automation
//
// This file sits in the **analytics** layer and is meant to feed dashboards
// like HouseholdAnalytics.jsx and engines like ReverseGeneration.js.
//
// WHAT IT TRACKS
// - ingredient → total count (how often we saw it)
// - ingredient → by domain (meals, garden, animal, storehouse, preservation)
// - ingredient → by month (seasonality)
// - ingredient → by source importIds (optional; kept short)
// - lastSeen / firstSeen
//
// EVENTS LISTENED TO (in an ideal runtime)
// - import.parsed (recipe / storehouse / garden / animal / video)
// - meal.executed
// - garden.harvest.logged
// - preservation.completed
//
// EMITS
// - analytics.ingredient.updated
//
// HUB EXPORT
// If the tracked event actually represents household data changing
// (harvest logged, preservation completed, inventory updated via ingredient),
// we also export a summarized payload to the Hub.
//
// EXTEND
// - add new domain mappers in `mapToIngredients(evt)`
// - add new seasonality rules in `getMonthKey()`
//
// NOTE
// This is written as a singleton-style analytics module – you can import it
// and call `initListener()` once from your app bootstrap.
//
// -----------------------------------------------------------------------------

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";

// soft hub deps
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter.js");
  // eslint-disable-next-line import/no-unresolved, global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector.js");
} catch (_) {
  // optional
}

const isBrowser = typeof window !== "undefined";

// in-memory store
// stats = {
//   "tomato": {
//     name: "tomato",
//     total: 7,
//     byDomain: { recipe: 5, garden: 1, preservation: 1 },
//     byMonth: { "2025-07": 2, "2025-08": 3, "2025-10": 2 },
//     lastSeen: ISO,
//     firstSeen: ISO,
//     sources: ["import:xyz", "pwa:abc", ...],
//   },
//   ...
// }
const stats = Object.create(null);

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (_) {
    // silent
  }
}

function emit(type, data = {}) {
  const evt = {
    type,
    ts: nowIso(),
    source: "analytics:ingredient-usage",
    data,
  };
  try {
    eventBus?.emit?.(evt);
  } catch (_) {
    // never crash
  }
  return evt;
}

function normName(s = "") {
  return s.toString().trim().toLowerCase();
}

function getMonthKey(ts = Date.now()) {
  const d = typeof ts === "number" ? new Date(ts) : new Date(ts || Date.now());
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${m.toString().padStart(2, "0")}`;
}

// -----------------------------------------------------------------------------
// core upsert
// -----------------------------------------------------------------------------
function upsertIngredient(name, domain, ts, sourceId) {
  const key = normName(name);
  if (!key) return null;

  const monthKey = getMonthKey(ts);
  const now = typeof ts === "string" ? ts : nowIso();

  if (!stats[key]) {
    stats[key] = {
      name: key,
      total: 0,
      byDomain: Object.create(null),
      byMonth: Object.create(null),
      lastSeen: now,
      firstSeen: now,
      sources: [],
    };
  }

  const entry = stats[key];
  entry.total += 1;
  entry.lastSeen = now;
  // firstSeen stays
  if (domain) {
    entry.byDomain[domain] = (entry.byDomain[domain] || 0) + 1;
  }
  entry.byMonth[monthKey] = (entry.byMonth[monthKey] || 0) + 1;

  // keep recent 10 sources
  if (sourceId) {
    entry.sources.unshift(sourceId);
    if (entry.sources.length > 10) entry.sources.length = 10;
  }

  emit("analytics.ingredient.updated", {
    ingredient: entry.name,
    domain,
    month: monthKey,
    total: entry.total,
  });

  return entry;
}

// -----------------------------------------------------------------------------
// event → ingredient mapper
// -----------------------------------------------------------------------------
/**
 * Map incoming SSA events into ingredient candidates.
 * Returns an array of { name, domain, sourceId }
 */
function mapToIngredients(evt = {}) {
  const results = [];
  const type = evt.type || "";
  const data = evt.data || {};
  const sourceId = data.importId || data.id || data.sourceId || null;

  // 1. import.parsed – richest source
  if (type === "import.parsed") {
    const k = data.kind || "other";
    const domain = mapKindToDomain(k);

    // recipes
    if (k === "recipe" || k === "mealPlan") {
      const ings = data.ingredients || data.ings || [];
      for (const ing of ings) {
        const name = typeof ing === "string" ? ing : ing.name || ing.label;
        if (!name) continue;
        results.push({ name, domain, sourceId });
      }
    }

    // garden
    if (k === "garden" || k === "gardenPlan" || k === "harvestPlan") {
      const seeds = data.seeds || data.harvest || [];
      for (const s of seeds) {
        const name = s.name || s.crop || s.variety;
        if (!name) continue;
        results.push({ name, domain, sourceId });
      }
    }

    // storehouse
    if (
      k === "storehouse" ||
      k === "storehouseStock" ||
      k === "storehouseGoal"
    ) {
      const items = data.items || [];
      for (const it of items) {
        const name = it.item || it.name;
        if (!name) continue;
        results.push({ name, domain, sourceId });
      }
    }

    // animal/butchery – track proteins as “ingredients”
    if (k === "animal" || k === "animalPlan" || k === "butcherySession") {
      const animals = data.animals || [];
      for (const an of animals) {
        const name = an.species || an.name;
        if (!name) continue;
        results.push({ name, domain, sourceId });
      }
    }

    // video/how-to – not always ingredients, but we can tag found words
    if (k === "video" && typeof data.text === "string") {
      const text = data.text.toLowerCase();
      // simple heuristic – track high-value crops
      ["tomato", "pepper", "okra", "greens", "lamb", "goat", "beef"].forEach(
        (w) => {
          if (text.includes(w)) {
            results.push({ name: w, domain, sourceId });
          }
        }
      );
    }
  }

  // 2. meal.executed – confirm actual usage
  if (type === "meal.executed") {
    const ings = data.ingredients || [];
    for (const ing of ings) {
      const name = typeof ing === "string" ? ing : ing.name || ing.label;
      if (!name) continue;
      results.push({ name, domain: "meals", sourceId });
    }
  }

  // 3. garden.harvest.logged – fresh ingredients in season
  if (type === "garden.harvest.logged") {
    const harvest = data.harvest || [];
    for (const item of harvest) {
      const name = item.crop || item.name;
      if (!name) continue;
      results.push({ name, domain: "garden", sourceId });
    }
  }

  // 4. preservation.completed – track preserved ingredient
  if (type === "preservation.completed") {
    const name = data.crop || data.item || data.ingredient;
    if (name) {
      results.push({ name, domain: "preservation", sourceId });
    }
  }

  // 5. inventory.updated – track items like ingredients
  if (type === "inventory.updated") {
    const items = data.items || data.updates || [];
    for (const it of items) {
      const name = it.name || it.item;
      if (!name) continue;
      results.push({ name, domain: "inventory", sourceId });
    }
  }

  return results;
}

function mapKindToDomain(kind = "") {
  const k = kind.toLowerCase();
  if (k.includes("recipe") || k.includes("meal")) return "meals";
  if (k.includes("clean")) return "cleaning";
  if (k.includes("garden") || k.includes("harvest") || k.includes("seed"))
    return "garden";
  if (k.includes("animal") || k.includes("butcher")) return "animals";
  if (k.includes("store")) return "storehouse";
  if (k.includes("video")) return "video";
  return "other";
}

// -----------------------------------------------------------------------------
// listener init
// -----------------------------------------------------------------------------
function initListener() {
  const bus = eventBus || (isBrowser ? window.__suka?.eventBus : null);
  if (!bus || typeof bus.on !== "function") return;

  const handler = async (evt) => {
    const mapped = mapToIngredients(evt);
    if (!mapped.length) return;

    const isHouseholdChange =
      evt.type === "garden.harvest.logged" ||
      evt.type === "preservation.completed" ||
      evt.type === "inventory.updated";

    const updatedNames = [];

    for (const { name, domain, sourceId } of mapped) {
      const entry = upsertIngredient(
        name,
        domain,
        evt.ts || Date.now(),
        sourceId
      );
      if (entry) {
        updatedNames.push(entry.name);
      }
    }

    // hub sync – only when household data changed
    if (isHouseholdChange && updatedNames.length) {
      await exportToHubIfEnabled({
        kind: "analytics.ingredient.updated",
        at: evt.ts || nowIso(),
        ingredients: updatedNames,
        sourceEvent: evt.type,
      });
    }
  };

  bus.on?.(handler);

  // optional teardown caller
  return () => {
    bus.off?.(handler);
  };
}

// -----------------------------------------------------------------------------
// public API
// -----------------------------------------------------------------------------
/**
 * Get a snapshot of all ingredient stats.
 * Optionally filter by domain or limit.
 */
function getAllStats({ domain = null, limit = 500 } = {}) {
  const entries = Object.values(stats);
  let filtered = entries;

  if (domain) {
    filtered = entries.filter((e) => e.byDomain[domain]);
  }

  // sort by total desc
  filtered.sort((a, b) => (b.total || 0) - (a.total || 0));

  return filtered.slice(0, limit);
}

/**
 * Get seasonality profile for one ingredient.
 */
function getIngredientSeasonality(name) {
  const key = normName(name);
  if (!stats[key]) return null;
  return {
    name: key,
    byMonth: { ...stats[key].byMonth },
  };
}

/**
 * Lightweight prune: drop entries never updated for > N days
 */
function prune({ olderThanDays = 180 } = {}) {
  const now = Date.now();
  const threshold = olderThanDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  Object.keys(stats).forEach((key) => {
    const last = new Date(stats[key].lastSeen).getTime();
    if (now - last > threshold) {
      delete stats[key];
      removed += 1;
    }
  });
  return removed;
}

// export everything
const ingredientUsageStats = {
  initListener,
  getAllStats,
  getIngredientSeasonality,
  prune,
  // for tests / debugging
  _stats: stats,
};

export default ingredientUsageStats;
export { initListener, getAllStats, getIngredientSeasonality, prune };

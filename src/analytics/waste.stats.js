// C:\Users\larho\suka-smart-assistant\src\analytics\waste.stats.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Waste / Spoilage Analytics
// -----------------------------------------------------------------------------
// PURPOSE
// Track *loss* inside the household engine so your SSA can do the opposite:
// suggest preservation, earlier cooking, garden scaling, and storehouse
// restocking.
//
// This file sits in the pipeline here:
//
//   imports → normalize → intelligence → automation → **analytics.waste** → (optional) hub
//
// We listen to household events that imply loss/spoilage:
//
//   - inventory.expired
//   - inventory.spoiled
//   - meal.waste.logged
//   - garden.harvest.waste
//   - preservation.failed
//   - storehouse.waste.logged
//
// And we aggregate them by:
//   - domain (meals, garden, animals, storehouse, preservation, inventory)
//   - item (tomato, lamb, greens, “prepared meal”)
//   - month (seasonality of waste)
//   - reason (expired, spoiled, prep-error, overcooked, pest, storage-failure)
//
// Then we surface:
//   - totalWasteCount
//   - totalEstimatedLossValue
//   - per-domain waste
//   - top-wasted items
//
// If the event is a real household change (inventory.spoiled, garden.harvest.waste,
// preservation.failed, storehouse.waste.logged), we also **optionally export** it
// to the Hub using the SSA-first → Hub-second rule.
//
// Forward-thinking:
//   - easy to add new waste events
//   - easy to hook dashboards (HouseholdAnalytics.jsx)
//   - designed to coexist with ingredientUsage.stats.js and preservation.stats.js
//
// -----------------------------------------------------------------------------

import eventBus from "@/services/eventBus.js";
import featureFlags from "@/config/featureFlags.js";

// soft hub deps
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter.js");
  // eslint-disable-next-line import/no-unresolved, global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector.js");
} catch (_) {
  // optional, fail silently
}

const isBrowser = typeof window !== "undefined";

// in-memory store
// wasteStats = {
//   items: {
//     "tomato": {
//        name: "tomato",
//        total: 3,
//        totalValue: 5.25,
//        byDomain: { garden: 2, meals: 1 },
//        byMonth: { "2025-11": 3 },
//        reasons: { spoiled: 2, expired: 1 },
//        lastSeen: ISO,
//        firstSeen: ISO,
//        sources: [...],
//     },
//     ...
//   },
//   domainTotals: { garden: 3, meals: 1, ... },
//   totalWasteCount: 4,
//   totalEstimatedLoss: 5.25,
// }
const wasteStats = {
  items: Object.create(null),
  domainTotals: Object.create(null),
  totalWasteCount: 0,
  totalEstimatedLoss: 0,
};

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function emitEvent(type, data = {}) {
  const evt = { type, ts: nowIso(), source: "analytics:waste", data };
  try {
    eventBus?.emit?.(evt);
  } catch (_) {
    // never crash analytics
  }
  return evt;
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

function norm(str = "") {
  return str.toString().trim().toLowerCase();
}

function getMonthKey(ts) {
  const d = ts ? new Date(ts) : new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  return `${y}-${m.toString().padStart(2, "0")}`;
}

// heuristic: estimate value of a wasted item
// we can later replace this with real pricebook / store data
function estimateLossValue(evt) {
  // explicit value wins
  if (typeof evt?.data?.value === "number") return evt.data.value;

  const qty = Number(evt?.data?.quantity || evt?.data?.weight || 1) || 1;
  const domain = detectDomain(evt);
  // rough domain-based multipliers
  if (domain === "meals") return qty * 3.0; // cooked meals more valuable
  if (domain === "preservation") return qty * 2.0;
  if (domain === "garden") return qty * 1.25;
  if (domain === "animal") return qty * 6.0; // meat is expensive
  if (domain === "storehouse") return qty * 1.5;
  return qty * 1.0;
}

function detectDomain(evt = {}) {
  const t = (evt.type || "").toLowerCase();
  const d = evt.data || {};

  if (d.domain) return d.domain;
  if (t.includes("inventory")) return "inventory";
  if (t.includes("meal")) return "meals";
  if (t.includes("garden")) return "garden";
  if (t.includes("animal")) return "animal";
  if (t.includes("storehouse")) return "storehouse";
  if (t.includes("preservation")) return "preservation";
  return "other";
}

function detectItemName(evt = {}) {
  const d = evt.data || {};
  // try explicit
  if (d.item) return d.item;
  if (d.name) return d.name;
  if (d.crop) return d.crop;
  if (d.ingredient) return d.ingredient;
  if (d.mealTitle) return d.mealTitle;
  if (Array.isArray(d.items) && d.items.length) return d.items[0].name || d.items[0].item;
  return "unknown";
}

function detectReason(evt = {}) {
  const d = evt.data || {};
  if (d.reason) return d.reason;
  const t = (evt.type || "").toLowerCase();
  if (t.includes("expired")) return "expired";
  if (t.includes("spoiled")) return "spoiled";
  if (t.includes("waste")) return "waste";
  if (t.includes("failed")) return "failed";
  return "unspecified";
}

function isRealHouseholdWasteEvent(evt = {}) {
  // these are the ones we want to forward to the Hub
  return (
    evt.type === "inventory.expired" ||
    evt.type === "inventory.spoiled" ||
    evt.type === "garden.harvest.waste" ||
    evt.type === "preservation.failed" ||
    evt.type === "storehouse.waste.logged" ||
    evt.type === "meal.waste.logged"
  );
}

// -----------------------------------------------------------------------------
// core upsert
// -----------------------------------------------------------------------------
function upsertWaste(evt = {}) {
  const ts = evt.ts || nowIso();
  const monthKey = getMonthKey(ts);
  const domain = detectDomain(evt);
  const itemName = norm(detectItemName(evt));
  const reason = norm(detectReason(evt));
  const value = estimateLossValue(evt);
  const srcId = evt.data?.id || evt.data?.sourceId || evt.data?.importId || null;

  // update global totals
  wasteStats.totalWasteCount += 1;
  wasteStats.totalEstimatedLoss += value;

  // update domain totals
  if (!wasteStats.domainTotals[domain]) {
    wasteStats.domainTotals[domain] = 0;
  }
  wasteStats.domainTotals[domain] += 1;

  // update item bucket
  if (!wasteStats.items[itemName]) {
    wasteStats.items[itemName] = {
      name: itemName,
      total: 0,
      totalValue: 0,
      byDomain: Object.create(null),
      byMonth: Object.create(null),
      reasons: Object.create(null),
      lastSeen: ts,
      firstSeen: ts,
      sources: [],
    };
  }

  const entry = wasteStats.items[itemName];
  entry.total += 1;
  entry.totalValue += value;
  entry.lastSeen = ts;

  // domain
  entry.byDomain[domain] = (entry.byDomain[domain] || 0) + 1;
  // month
  entry.byMonth[monthKey] = (entry.byMonth[monthKey] || 0) + 1;
  // reason
  entry.reasons[reason] = (entry.reasons[reason] || 0) + 1;
  // sources
  if (srcId) {
    entry.sources.unshift(srcId);
    if (entry.sources.length > 10) entry.sources.length = 10;
  }

  // emit fine-grained update
  emitEvent("analytics.waste.updated", {
    item: entry.name,
    domain,
    reason,
    month: monthKey,
    value,
    totals: {
      itemTotal: entry.total,
      itemTotalValue: entry.totalValue,
      globalTotal: wasteStats.totalWasteCount,
      globalValue: wasteStats.totalEstimatedLoss,
    },
  });

  return entry;
}

// -----------------------------------------------------------------------------
// event listener init
// -----------------------------------------------------------------------------
function initListener() {
  const bus = eventBus || (isBrowser ? window.__suka?.eventBus : null);
  if (!bus || typeof bus.on !== "function") return;

  const handler = async (evt) => {
    if (!evt || !evt.type) return;

    // only react to waste-ish events; extend this list easily
    const wasteTypes = new Set([
      "inventory.expired",
      "inventory.spoiled",
      "meal.waste.logged",
      "garden.harvest.waste",
      "preservation.failed",
      "storehouse.waste.logged",
    ]);

    if (!wasteTypes.has(evt.type)) return;

    const entry = upsertWaste(evt);

    // real household loss → notify Hub (optional)
    if (isRealHouseholdWasteEvent(evt)) {
      await exportToHubIfEnabled({
        kind: "analytics.waste.logged",
        at: evt.ts || nowIso(),
        item: entry.name,
        domain: detectDomain(evt),
        reason: detectReason(evt),
        value: estimateLossValue(evt),
      });
    }
  };

  bus.on?.(handler);

  // return unsubscribe
  return () => {
    bus.off?.(handler);
  };
}

// -----------------------------------------------------------------------------
// public API
// -----------------------------------------------------------------------------

/**
 * Get a snapshot of waste stats.
 * @param {Object} opts
 * @param {string|null} opts.domain - filter by domain
 * @param {number} opts.limit - max items
 */
function getWasteSnapshot({ domain = null, limit = 200 } = {}) {
  const items = Object.values(wasteStats.items);
  let filtered = items;

  if (domain) {
    filtered = items.filter((it) => it.byDomain[domain]);
  }

  // sort by total value desc
  filtered.sort((a, b) => (b.totalValue || 0) - (a.totalValue || 0));

  return {
    totals: {
      totalWasteCount: wasteStats.totalWasteCount,
      totalEstimatedLoss: wasteStats.totalEstimatedLoss,
      domainTotals: { ...wasteStats.domainTotals },
    },
    items: filtered.slice(0, limit).map((it) => ({
      name: it.name,
      total: it.total,
      totalValue: it.totalValue,
      byDomain: it.byDomain,
      byMonth: it.byMonth,
      reasons: it.reasons,
      lastSeen: it.lastSeen,
    })),
  };
}

/**
 * Get waste for a single item
 */
function getItemWasteReport(name) {
  const key = norm(name);
  const entry = wasteStats.items[key];
  if (!entry) return null;
  return {
    name: entry.name,
    total: entry.total,
    totalValue: entry.totalValue,
    byDomain: entry.byDomain,
    byMonth: entry.byMonth,
    reasons: entry.reasons,
    lastSeen: entry.lastSeen,
    firstSeen: entry.firstSeen,
  };
}

/**
 * Prune very old waste entries.
 */
function prune({ olderThanDays = 180 } = {}) {
  const now = Date.now();
  const maxAge = olderThanDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  Object.keys(wasteStats.items).forEach((key) => {
    const entry = wasteStats.items[key];
    const last = new Date(entry.lastSeen).getTime();
    if (now - last > maxAge) {
      delete wasteStats.items[key];
      removed += 1;
    }
  });
  return removed;
}

// export singleton-style instance
const wasteAnalytics = {
  initListener,
  getWasteSnapshot,
  getItemWasteReport,
  prune,
  // for debugging
  _state: wasteStats,
};

export default wasteAnalytics;
export {
  initListener,
  getWasteSnapshot,
  getItemWasteReport,
  prune,
};

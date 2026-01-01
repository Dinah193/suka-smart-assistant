// src/services/templates/pantryRestockNudger.js

import * as MealPlanStore from "@/store/MealPlanStore";
import * as inventoryUtils from "@/utils/inventoryUtils";
import * as timeUtils from "@/utils/timeUtils";
import forecastFoodProduction from "@/services/planning/forecastFoodProduction";
import ReminderManager from "@/managers/ReminderManager"; // fallback notifier

// Optional/guarded services for richer UX – non-fatal if absent
let NotificationCenter, UserSettingsStore, CalendarSyncModule, PriceBookStore, DietProfileStore;
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}
try { UserSettingsStore = require("@/store/UserSettingsStore"); } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { PriceBookStore = require("@/store/PriceBookStore"); } catch (_) {}
try { DietProfileStore = require("@/store/DietProfileStore"); } catch (_) {}

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "pantry_restock_nudger_v2",
  version: "2.2.0",
  purpose: "Subtle, weekly “you’ll be short next week” guidance with par-levels, swaps, and budget caps.",
  triggers: ["RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=9"],
  inputs: {
    // You can pass snapshots in, or we'll read from stores/utilities.
    required: [],
    optional: [
      "inventorySnapshot",
      "next7dMeals",
      "parLevels",           // { name -> { minQty, unit } }
      "budgetCeiling",       // number (currency units) for this run
      "preferredVendors",    // [{ id, name, aislesMap? }]
      "avoidList"            // string[] allergens or dislikes (“peanut”, “cilantro”)
    ]
  },
  logic: {
    selectors: [
      "MealPlanStore.next7d()",
      "inventoryUtils.getSnapshot()",
      "forecastFoodProduction({ inventorySnapshot, plannedMeals })",
      "PriceBookStore.getUnitPrice?(name) → { price, unitSize }",
      "UserSettingsStore.get('shopping.vendorPrefs'|'budget.ceiling')"
    ],
    rules: [
      "Forecast the next 7 days’ usage and compute stockouts.",
      "Respect par-levels: if below par, top-up even if not used this week.",
      "Suggest pantry swaps first (confidence-scored).",
      "Route items to preferred vendors; group by store/aisle.",
      "Fit within budget ceiling; push non-urgent items to next week.",
      "Emit a concise approval UI and a tappable notification."
    ],
    llm_roles: []
  },
  actions: [
    "OPEN_UI:ProcurementReport.jsx",
    "EVENT:procurement:ready",
    "NOTIFY:minimal checklist; tap Approve → export",
    "CALENDAR:optional ‘Grocery pickup’ stub"
  ],
  outputs: {
    ui: ["ProcurementReport.jsx"],
    data: ["groceryListGrouped", "advisory", "budget", "carryOver"],
    alerts: []
  },
  fallbacks: [
    "Offer swaps to avoid shopping (suggest recipe or ingredient substitutions).",
    "If over budget, defer lowest-urgency items (not used in next 7d, or above-par) to carryOver."
  ],
  success_message: "Heads up: I prepped a tiny restock list for next week.",
  used_by: ["inventoryAgent", "mealPlanningAgent"]
};

/* ---------------- helpers & dynamic enrichers ---------------- */

const toKey = (s) => String(s || "").trim().toLowerCase();

function getBudgetCeiling(budgetCeilingIn) {
  const sys = Number(UserSettingsStore?.get?.("budget.ceiling") ?? 0) || null;
  const run = Number(budgetCeilingIn ?? 0) || null;
  return run || sys; // run-time override wins
}

function getPreferredVendors(vIn) {
  const sys = UserSettingsStore?.get?.("shopping.vendorPrefs");
  const arr = Array.isArray(vIn) && vIn.length ? vIn : (Array.isArray(sys) ? sys : []);
  return arr.map(v => ({ id: v.id || toKey(v.name), name: v.name || v.id || "General", aislesMap: v.aislesMap || {} }));
}

function getDietAvoids(avoidIn) {
  const diet = DietProfileStore?.get?.() || {};
  const avoid = new Set([...(avoidIn || []), ...(diet?.allergens || []), ...(diet?.avoid || [])].map(toKey));
  return avoid;
}

function groupByStoreAisle(shortages = [], vendors = []) {
  const vendorIndex = vendors.reduce((acc, v) => (acc[v.id] = v, acc), {});
  const grouped = {};

  for (const item of shortages) {
    const vendorId = item.vendorId || item.preferredVendorId || vendors[0]?.id || "general";
    const vendor = vendorIndex[vendorId] || { id: vendorId, name: item.store || "General", aislesMap: {} };
    const aisleName = item.aisle || vendor.aislesMap?.[toKey(item.name)] || "Misc";
    const key = `${vendor.id}__${aisleName}`;
    if (!grouped[key]) grouped[key] = { storeId: vendor.id, store: vendor.name || "General", aisle: aisleName, items: [] };

    const existing = grouped[key].items.find(i => toKey(i.name) === toKey(item.name) && (i.unit || "") === (item.unit || ""));
    if (existing) {
      existing.qty = Number(existing.qty ?? 0) + Number(item.qty ?? 0);
    } else {
      grouped[key].items.push({
        name: item.name,
        qty: Number(item.qty ?? 1),
        unit: item.unit || "",
        note: item.note || ""
      });
    }
  }

  return Object.values(grouped)
    .sort((a, b) => a.store.localeCompare(b.store) || a.aisle.localeCompare(b.aisle))
    .map(g => ({ ...g, items: g.items.sort((a, b) => a.name.localeCompare(b.name)) }));
}

function priceFor(item) {
  try {
    const row = PriceBookStore?.getUnitPrice?.(item.name);
    if (!row) return null;
    const qty = Number(item.qty ?? 1);
    const unitPrice = Number(row.price ?? 0);
    const packSize = Number(row.unitSize ?? 1);
    // If our qty is in “units” and pricebook records pack sizes, approximate
    const packs = Math.ceil(qty / Math.max(1, packSize));
    return packs * unitPrice;
  } catch (_) {
    return null;
  }
}

function urgencyScore(missingRow) {
  // Higher → more urgent
  const daysToUse = Number(missingRow.daysToUse ?? 7);     // sooner usage = more urgent
  const deficitRatio = (Number(missingRow.needed ?? 0) - Number(missingRow.onHand ?? 0)) / Math.max(1, Number(missingRow.needed ?? 1));
  const parPenalty = missingRow.belowPar ? 0.15 : 0;       // small bump if below par
  const recipeCount = (missingRow.recipeIds || []).length; // many recipes → more urgent

  const score =
    (1.2 - Math.min(1, daysToUse / 7)) * 0.5 +     // 0..0.5
    Math.max(0, Math.min(1, deficitRatio)) * 0.35 +// 0..0.35
    (Math.min(1, recipeCount / 3)) * 0.15 +        // 0..0.15
    parPenalty;                                    // 0 or 0.15

  return Math.max(0, Math.min(1.5, score)); // cap to keep ordering stable
}

function applyParLevels(missing, parLevels, inventorySnapshot) {
  // Ensure items at/under par are surfaced even if not used this week
  if (!parLevels) return missing;
  const onHandIndex = (inventorySnapshot?.items ? inventorySnapshot.items : {}).reduce
    ? inventorySnapshot.items.reduce((acc, it) => (acc[toKey(it.name)] = Number(it.qty ?? it.quantity ?? 0), acc), {})
    : Object.entries(inventorySnapshot?.items || {}).reduce((acc, [k, v]) => (acc[toKey(k)] = Number(v ?? 0), acc), {});

  const parRows = Object.entries(parLevels).map(([name, spec]) => {
    const key = toKey(name);
    const onHand = Number(onHandIndex[key] ?? 0);
    const minQty = Number(spec?.minQty ?? spec ?? 0);
    const deficit = Math.max(0, minQty - onHand);
    return deficit > 0 ? {
      name,
      needed: minQty,
      onHand,
      unit: spec?.unit || "",
      belowPar: true,
      parMin: minQty,
      daysToUse: 14,         // low urgency unless also needed this week
      recipeIds: []
    } : null;
  }).filter(Boolean);

  // Merge parRows into missing, preferring the larger deficit
  const baseIndex = {};
  const merged = [...missing];
  merged.forEach((m, i) => (baseIndex[toKey(m.name)] = i));
  for (const pr of parRows) {
    const k = toKey(pr.name);
    if (baseIndex[k] == null) merged.push(pr);
    else {
      const i = baseIndex[k];
      const curDef = (Number(merged[i].needed ?? 0) - Number(merged[i].onHand ?? 0));
      const newDef = (Number(pr.needed ?? 0) - Number(pr.onHand ?? 0));
      if (newDef > curDef) merged[i] = { ...merged[i], ...pr, belowPar: true };
    }
  }
  return merged;
}

function filterByAvoidList(items, avoidSet) {
  if (!avoidSet || avoidSet.size === 0) return items;
  return items.filter(it => !avoidSet.has(toKey(it.name)));
}

/**
 * Convert forecast deltas into a short “must-buy” list,
 * while proposing swaps first. Adds price + urgency for budgeting.
 */
function buildShortagesWithSwaps(forecast, inventorySnapshot, parLevels, avoidSet) {
  const baseMissing = Array.isArray(forecast?.missing) ? forecast.missing : [];
  const withPars = applyParLevels(baseMissing, parLevels, inventorySnapshot);

  const essentials = [];
  const advisory = [];

  for (const m of withPars) {
    if (avoidSet?.has?.(toKey(m.name))) continue;

    const neededQty = Math.max(0, Number(m.needed ?? 0) - Number(m.onHand ?? 0));
    if (neededQty <= 0) continue;

    const swap = inventoryUtils.suggestSwaps?.(m, inventorySnapshot) || null;
    const suggestion = { name: m.name, unit: m.unit || "", store: m.store, aisle: m.aisle, daysToUse: m.daysToUse, recipeIds: m.recipeIds, belowPar: !!m.belowPar };

    if (swap?.onHandQty && swap.onHandQty >= neededQty * 0.8) {
      const remaining = Math.max(0, neededQty - swap.onHandQty);
      if (remaining > 0) {
        const row = { ...suggestion, qty: remaining, note: `Use ${swap.name} you have; buy a little to top up.` };
        row.urgency = urgencyScore({ ...m, belowPar: !!m.belowPar });
        row.price = priceFor(row);
        essentials.push(row);
      } else {
        advisory.push({ ...suggestion, qty: 0, note: `Swap with ${swap.name} on-hand; no purchase needed.` });
      }
    } else {
      const row = { ...suggestion, qty: neededQty, note: "" };
      row.urgency = urgencyScore({ ...m, belowPar: !!m.belowPar });
      row.price = priceFor(row);
      essentials.push(row);
    }
  }

  // keep concise – sort by urgency desc then price asc; cap ~14 essentials
  essentials.sort((a, b) => (b.urgency - a.urgency) || ((a.price ?? 0) - (b.price ?? 0)));
  return { essentials: essentials.slice(0, 14), advisory };
}

function applyBudgetCap(items, budgetCeiling) {
  if (!budgetCeiling || budgetCeiling <= 0) return { within: items, carryOver: [] , total: items.reduce((s, i) => s + (i.price ?? 0), 0) };

  let running = 0;
  const within = [];
  const carryOver = [];

  for (const it of items) {
    const p = Number(it.price ?? 0);
    // treat items without price as small – let them through up to +10% buffer
    const effective = p || 1.25;
    if (running + effective <= budgetCeiling * 1.1) {
      within.push(it);
      running += effective;
    } else {
      carryOver.push({ ...it, note: (it.note ? it.note + " — " : "") + "Deferred (budget)" });
    }
  }
  return { within, carryOver, total: running };
}

function attachVendors(items, preferredVendors) {
  if (!preferredVendors || preferredVendors.length === 0) return items;
  const primary = preferredVendors[0];
  return items.map(it => ({ ...it, vendorId: it.vendorId || primary.id, store: it.store || primary.name }));
}

/**
 * Post a minimal “tap to approve” notification.
 * Your UI can listen for `procurement:approve` or `procurement:ready`.
 */
function notifyMinimalChecklist(payload) {
  const notify = NotificationCenter?.notify || ReminderManager?.notify || ReminderManager?.schedule;
  const now = new Date();
  if (notify === ReminderManager?.schedule) {
    notify?.({
      at: now,
      title: "Restock nudger",
      message: "Minimal grocery list is ready—tap Approve to export.",
      action: "Approve",
      tags: ["inventory", "restock"]
    });
  } else {
    notify?.({
      title: "Restock nudger",
      message: "Minimal grocery list is ready—tap Approve to export.",
      action: "Approve",
      meta: payload
    });
  }

  window.dispatchEvent(new CustomEvent("procurement:ready", { detail: payload }));
}

/* ---------------- execute ---------------- */

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Object} [payload.inventorySnapshot]
 * @param {Array<Object>} [payload.next7dMeals]
 * @param {Object} [payload.parLevels]
 * @param {number} [payload.budgetCeiling]
 * @param {Array<Object>} [payload.preferredVendors]
 * @param {Array<string>} [payload.avoidList]
 * @param {Object} [ctx]                    // { openUI? }
 * @returns {Promise<{groceryListGrouped:Array, advisory:Array, budget:Object, carryOver:Array, message:string}>}
 */
export async function execute(payload = {}, ctx = {}) {
  const {
    inventorySnapshot: snapshotIn,
    next7dMeals: mealsIn,
    parLevels = {},
    budgetCeiling: budgetIn,
    preferredVendors: vendorsIn,
    avoidList: avoidIn
  } = payload;

  const { openUI } = ctx;

  // 1) Resolve inputs (derive if not provided)
  const next7dMeals = mealsIn ?? MealPlanStore.next7d?.() ?? [];
  const inventorySnapshot =
    snapshotIn ??
    inventoryUtils.getSnapshot?.() ??
    { items: {} };

  const budgetCeiling = getBudgetCeiling(budgetIn);
  const preferredVendors = getPreferredVendors(vendorsIn);
  const avoidSet = getDietAvoids(avoidIn);

  // 2) Forecast misses for the coming 7 days
  const forecast = await forecastFoodProduction({
    inventorySnapshot,
    plannedMeals: next7dMeals,
    windowDays: 7
  });

  // 3) Build minimal shortages list w/ swaps + par levels + avoid filter
  let { essentials, advisory } = buildShortagesWithSwaps(
    forecast,
    inventorySnapshot,
    parLevels,
    avoidSet
  );

  // 4) Vendor routing & pricing already attached; optionally re-route
  essentials = attachVendors(essentials, preferredVendors);

  // 5) Budget cap → split into within / carryOver
  const budgetSplit = applyBudgetCap(essentials, budgetCeiling);
  const withinBudget = budgetSplit.within;
  const carryOver = budgetSplit.carryOver;

  // 6) Group by store/aisle for fast shopping (within budget only)
  const groceryListGrouped = groupByStoreAisle(withinBudget, preferredVendors);

  // 7) Open ProcurementReport with grouped list and swap advisories
  const reportParams = {
    weekOf: timeUtils?.toLocalISODate?.(new Date()) || new Date().toISOString().slice(0, 10),
    groceryListGrouped,
    advisory,                 // zero-qty items covered by swaps
    carryOver,                // deferred due to budget
    plannedMealsCount: next7dMeals.length,
    budget: {
      ceiling: budgetCeiling || null,
      estTotal: Math.round((budgetSplit.total || 0) * 100) / 100
    }
  };

  if (typeof openUI === "function") {
    openUI("ProcurementReport", reportParams);
  } else {
    window.dispatchEvent(new CustomEvent("ui:navigate", {
      detail: { route: "ProcurementReport", params: reportParams }
    }));
  }

  // 8) Optional: add a calendar stub to remind pickup (non-fatal)
  try {
    const pickupDate = new Date();
    pickupDate.setDate(pickupDate.getDate() + 1);
    CalendarSyncModule?.load?.([{
      start: pickupDate,
      end: new Date(pickupDate.getTime() + 60 * 60 * 1000),
      allDay: false,
      title: "Grocery pickup (nudger)",
      description: "Approve & export from Procurement Report.",
      tags: ["inventory", "restock"]
    }]);
  } catch (_) {}

  // 9) Notify with a minimal checklist, tap to approve → export
  notifyMinimalChecklist({
    groceryListGrouped,
    advisory,
    carryOver,
    budget: reportParams.budget,
    exportHint: "grocery:export"
  });

  return {
    groceryListGrouped,
    advisory,
    budget: reportParams.budget,
    carryOver,
    message: template.success_message
  };
}

export default {
  template,
  execute
};

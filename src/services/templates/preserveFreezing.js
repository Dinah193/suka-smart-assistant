// src/services/templates/preserveFreezing.js

import * as timeUtils from "@/utils/timeUtils";
import ReminderManager from "@/managers/ReminderManager";
import * as StorehousePlannerStore from "@/store/StorehousePlannerStore";
import * as inventoryUtils from "@/utils/inventoryUtils";

// Optional/guarded integrations
let InventoryStore, LabelPrinter, CalendarSyncModule, NotificationCenter, BadgeManager;
try { InventoryStore = require("@/store/InventoryStore"); } catch (_) {}
try { LabelPrinter = require("@/services/labels/LabelPrinter").default; } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}
try { BadgeManager = require("@/managers/BadgeManager"); } catch (_) {}

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "preserve_freezing_v2",
  version: "2.3.0",
  purpose: "Quick-save portions/produce with capacity-aware batching and reheat labels.",
  triggers: ["batch::portioned", "inventory::approaching_wilt", "ui::FreezingPlanner.open"],
  inputs: {
    // portions: [{ name, type, qty, unit, volumeMl?, reheatsTo?, perishScore?:1..10, notes? }]
    // freezerSpace: { trays, trayVolumeMl, looseSpaceMl }
    // supplies: { bags: 'qt'|'gal', containers: ['half_pint','pint','quart','2qt'], labels?:boolean, reserve?:boolean }
    // blanchRules: { [produceKey]: { timeMin, note } }
    required: ["portions"],
    optional: ["freezerSpace", "supplies", "blanchRules"]
  },
  logic: {
    selectors: [
      "StorehousePlannerStore.getFrozenSkus?()",
      "inventoryUtils.getSnapshot()",
      "blanchRules for produce; reheat notes by portion type",
      "Capacity planner → waves when trays/space are limited"
    ],
    rules: [
      "Prefer flat-freeze bags for solids & containers for liquids.",
      "Auto-split large portions to fit selected packaging.",
      "Pack by perishability first; schedule waves when needed.",
      "Generate reheat notes + QR label payloads."
    ],
    llm_roles: []
  },
  actions: [
    "open:FreezingTracker.jsx",
    "write:StorehousePlannerStore.addFrozenItems",
    "notify:ReminderManager.schedule(rotate_freezer_30d)",
    "optional:InventoryStore.reserve(supplies)",
    "optional:LabelPrinter.printBatch(labels)",
    "optional:CalendarSyncModule.load(events)"
  ],
  outputs: {
    ui: ["FreezingTracker.jsx"],
    data: ["waves", "skus", "reheatCards", "labels"],
    alerts: ["rotate_freezer"]
  },
  fallbacks: [
    "If still can’t fit → produce an 'eat this first' list ordered by perishability & volume."
  ],
  success_message: "Freezing plan set—waves, labels, and a 30-day rotation reminder are ready.",
  used_by: ["storehouseAgent", "inventoryAgent"]
};

/** ---------- Helpers ---------- **/

const UNIT_TO_ML = {
  ml: 1, l: 1000, cup: 240, cups: 240, tbsp: 15, tsp: 5, oz: 30, floz: 30,
  serving: 350, servings: 350, pint: 473, "half_pint": 237, quart: 946, "2qt": 1892
};
const BAG_TO_ML = { quart: 946, gallon: 3785 };
const CONTAINER_TO_ML = { half_pint: 237, pint: 473, quart: 946, "2qt": 1892 };

const toNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);

function mlPerUnit(unit = "") {
  const u = String(unit).toLowerCase().replace(/\s+/g, "");
  if (UNIT_TO_ML[u] != null) return UNIT_TO_ML[u];
  if (u.includes("ml")) return 1;
  if (u.includes("l")) return 1000;
  return 250;
}

function estimateVolumeMl(portion) {
  const qty = toNum(portion?.qty, 1);
  if (portion?.volumeMl != null) return toNum(portion.volumeMl) * qty;
  return qty * mlPerUnit(portion?.unit || "");
}

function isLiquidPortion(p) {
  const t = String(p?.type || p?.name || "").toLowerCase();
  return /soup|stew|stock|broth|sauce|curry|gravy|puree|purée|liquid/.test(t);
}

function makeReheatNote(p) {
  const t = String(p?.type || p?.name || "").toLowerCase();
  if (/soup|stew|chili|broth|curry/.test(t))
    return "Thaw overnight; reheat in pot to a gentle simmer until steaming throughout.";
  if (/rice|grain|pasta/.test(t))
    return "Microwave covered with a splash of water 1–3 min, stirring once.";
  if (/meat|chicken|beef|lamb|goat|fish|roast|steak|thigh|breast/.test(t))
    return "Thaw in fridge; reheat covered at low heat to 165°F/74°C internal.";
  if (/veg|vegetable|greens/.test(t))
    return "Sauté from frozen or steam briefly to just-hot; avoid overcooking.";
  if (/berry|fruit|herb/.test(t))
    return "Use from frozen in smoothies/baking; for garnish, thaw on paper towel.";
  return "Thaw in fridge; reheat until steaming hot. Do not refreeze once thawed.";
}

function bagChoiceMl(supplies) {
  const bag = String(supplies?.bags || "qt").toLowerCase();
  return bag.startsWith("g") ? BAG_TO_ML.gallon : BAG_TO_ML.quart;
}
function containerChoiceMl(supplies, prefer = "pint") {
  const list = Array.isArray(supplies?.containers) ? supplies.containers : [];
  const pref = list.includes(prefer) ? prefer : (list[0] || "pint");
  return CONTAINER_TO_ML[pref] || 473;
}

function pickPackaging(portion, supplies = {}) {
  if (isLiquidPortion(portion)) {
    // prefer containers; fall back to bag
    const sizeMl = containerChoiceMl(supplies, "pint");
    return { method: "container", sizeMl, sizeLabel: Object.keys(CONTAINER_TO_ML).find(k => CONTAINER_TO_ML[k] === sizeMl) || "pint" };
  }
  const sizeMl = bagChoiceMl(supplies);
  return { method: "tray+bag", sizeMl, sizeLabel: sizeMl >= 3000 ? "gallon" : "quart" };
}

// Split a portion into N units that fit the packaging volume
function splitToFit(portion, pkg) {
  const vol = estimateVolumeMl(portion);
  const maxPerUnit = Math.max(150, pkg.sizeMl - 50); // headspace
  if (vol <= maxPerUnit) return [{ ...portion, volumeMl: vol }];
  const n = Math.ceil(vol / maxPerUnit);
  const each = Math.round(vol / n);
  return Array.from({ length: n }, (_, i) => ({
    ...portion,
    volumeMl: each,
    splitIndex: i + 1,
    splitTotal: n
  }));
}

function withBlanchNotes(portions, blanchRules = {}) {
  return portions.map((p) => {
    const key = String(p?.type || p?.name || "").toLowerCase();
    const rule = blanchRules[key];
    if (!rule) return p;
    if (p.notes) return p;
    return { ...p, notes: `Blanch ${rule.timeMin} min. ${rule.note || ""}`.trim() };
  });
}

// Order by perishability desc then volume desc
function orderByUrgency(list) {
  return [...list].sort((a, b) => {
    const ps = toNum(b.perishScore, 5) - toNum(a.perishScore, 5);
    if (ps !== 0) return ps;
    return estimateVolumeMl(b) - estimateVolumeMl(a);
  });
}

/**
 * Wave planner:
 * - Packs into trays first (for tray+bag),
 * - Liquids/containers go to loose shelf,
 * - If not enough capacity, creates sequential waves (each wave fits).
 */
function planWaves(portions, freezerSpace = {}, supplies = {}) {
  const trays = Math.max(0, toNum(freezerSpace?.trays, 2));
  const trayCap = Math.max(1000, toNum(freezerSpace?.trayVolumeMl, 3000));
  const looseCap = Math.max(1000, toNum(freezerSpace?.looseSpaceMl, 4000));

  const list = orderByUrgency(portions);
  const waves = [];
  let i = 0;

  while (i < list.length) {
    let trayUsed = 0;
    let trayCount = 0;
    let looseUsed = 0;
    const items = [];

    for (; i < list.length; i++) {
      const p = list[i];
      const basePkg = pickPackaging(p, supplies);
      const splits = splitToFit(p, basePkg);

      // try to place all splits; if any split cannot fit this wave, break to next wave
      let canAllFit = true;
      let tmpTrayUsed = trayUsed;
      let tmpTrayCount = trayCount;
      let tmpLooseUsed = looseUsed;

      for (const s of splits) {
        if (basePkg.method === "tray+bag") {
          // needs tray slot & capacity
          if (tmpTrayCount >= trays) { canAllFit = false; break; }
          if (tmpTrayUsed + s.volumeMl > trayCap) {
            // move to next tray if available
            if (tmpTrayCount + 1 >= trays) { canAllFit = false; break; }
            tmpTrayCount += 1;
            tmpTrayUsed = 0;
          }
          tmpTrayUsed += s.volumeMl;
        } else {
          // container → loose space
          if (tmpLooseUsed + s.volumeMl > looseCap) { canAllFit = false; break; }
          tmpLooseUsed += s.volumeMl;
        }
      }

      if (!canAllFit) break;

      // commit this item to the wave
      trayUsed = tmpTrayUsed;
      trayCount = tmpTrayCount;
      looseUsed = tmpLooseUsed;
      items.push({ original: p, packaging: basePkg, splits });
    }

    // if nothing fit (e.g., a single huge item), force place first split into wave to avoid infinite loop
    if (items.length === 0 && i < list.length) {
      const p = list[i];
      const basePkg = pickPackaging(p, supplies);
      const splits = splitToFit(p, basePkg);
      const first = splits[0];
      if (basePkg.method === "tray+bag") {
        trayUsed = Math.min(trayCap, (trayCount > 0 ? trayUsed : 0) + first.volumeMl);
        trayCount = Math.max(1, trayCount);
      } else {
        looseUsed = Math.min(looseCap, looseUsed + first.volumeMl);
      }
      items.push({ original: p, packaging: basePkg, splits: [first], partial: true });
      // put remaining splits back into list right after this item
      const rest = splits.slice(1).map(s => ({ ...p, volumeMl: s.volumeMl }));
      list.splice(i + 1, 0, ...rest);
      i += 1;
    }

    waves.push({
      trayCount: Math.min(trays, Math.max(1, trayCount || (trays ? 1 : 0))),
      trayVolumeUsedMl: trayUsed,
      looseVolumeUsedMl: looseUsed,
      items
    });
  }

  return waves;
}

function buildSkuAndCards(waves) {
  const date = new Date().toISOString().slice(0, 10);
  const skus = [];
  const cards = [];
  const labels = [];

  waves.forEach((w, wi) => {
    w.items.forEach(({ original, splits, packaging }, idx) => {
      splits.forEach((s, si) => {
        const baseName = original.name || original.type || "Frozen Item";
        const id = `FRZ_${date.replace(/-/g, "")}_${String(baseName)
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")}_${wi}_${idx}_${si}`;

        const reheat = original.notes || makeReheatNote(original);
        const bestBy =
          timeUtils?.toLocalISODate?.(timeUtils?.addDays?.(new Date(), 120)) || ""; // ~4 months

        const pkgLabel = packaging.method === "container"
          ? (Object.keys(CONTAINER_TO_ML).find(k => CONTAINER_TO_ML[k] === packaging.sizeMl) || "pint")
          : (packaging.sizeLabel || "quart");

        skus.push({
          id,
          name: baseName,
          date,
          packaging: packaging.method,
          size: pkgLabel,
          wave: wi + 1,
          volumeMl: s.volumeMl || estimateVolumeMl(s),
          qty: 1,
          unit: original.unit || "",
          tags: ["frozen", "batch"]
        });

        cards.push({
          id: `${id}_CARD`,
          skuId: id,
          reheat,
          bestBy,
          notes: original.reheatsTo || ""
        });

        labels.push({
          id: `${id}_LBL`,
          title: baseName,
          lines: [
            `Frozen: ${date}`,
            `Pkg: ${packaging.method === "container" ? pkgLabel : `${pkgLabel} bag (flat)`}`,
            `Best by: ${bestBy}`
          ],
          qr: { sku: id, meta: { wave: wi + 1 } }
        });
      });
    });
  });

  return { skus, cards, labels };
}

/** ---------- Execute ---------- **/

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Array<Object>} payload.portions
 * @param {Object} [payload.freezerSpace]
 * @param {Object} [payload.supplies]
 * @param {Object} [payload.blanchRules]
 * @param {Object} [ctx] - { openUI?, now? }
 * @returns {Promise<{waves:Array, skus:Array, reheatCards:Array, labels:Array, message:string, overflow?:Array}>}
 */
export async function execute(payload = {}, ctx = {}) {
  const {
    portions = [],
    freezerSpace = {},
    supplies = {},
    blanchRules = {}
  } = payload;

  const { openUI, now = new Date() } = ctx;

  if (!Array.isArray(portions) || portions.length === 0) {
    throw new Error("preserveFreezing: no portions provided.");
  }

  // 1) Apply blanch notes for produce
  const portionsAug = withBlanchNotes(portions, blanchRules);

  // 2) Plan waves according to capacity (trays + loose shelf)
  const waves = planWaves(portionsAug, freezerSpace, supplies);

  // 3) If even a single wave has zero items (extreme constraint), produce eat-first fallback
  const totalItems = waves.reduce((s, w) => s + w.items.length, 0);
  if (totalItems === 0) {
    const eatFirst = orderByUrgency(portionsAug).map((p) => ({
      name: p.name || p.type || "Item",
      reason: "Freezer full",
      serves: p.qty || 1,
      volumeMl: estimateVolumeMl(p),
      suggestion: "Prioritize cooking/serving within 48 hours."
    }));
    if (typeof openUI === "function") {
      openUI("FreezingTracker", { waves: [], overflow: eatFirst, supplies });
    } else {
      window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "FreezingTracker", params: { waves: [], overflow: eatFirst, supplies } } }));
    }
    return { waves: [], skus: [], reheatCards: [], labels: [], message: "Freezer appears full—suggested an 'eat this first' list.", overflow: eatFirst };
  }

  // 4) Build SKUs, reheat cards, labels
  const { skus, cards: reheatCards, labels } = buildSkuAndCards(waves);

  // 5) Persist plan
  StorehousePlannerStore.addFrozenItems?.({
    createdAt: now,
    skus,
    reheatCards,
    plan: { waves, freezerSpace, supplies }
  });

  // 6) Optional: reserve supplies & print labels
  if (supplies?.reserve && InventoryStore?.reserve) {
    try {
      const bagCount = skus.filter(s => s.packaging !== "container").length;
      const containerCount = skus.filter(s => s.packaging === "container").length;
      if (bagCount) InventoryStore.reserve?.(`${supplies.bags || "qt"} freezer bag`, bagCount, "ea");
      if (containerCount) {
        const common = supplies.containers?.[0] || "pint";
        InventoryStore.reserve?.(`${common} container`, containerCount, "ea");
      }
      if (supplies?.labels) InventoryStore.reserve?.("freezer label", skus.length, "ea");
    } catch (_) {}
  }
  try { if (supplies?.labels) LabelPrinter?.printBatch?.(labels); } catch (_) {}

  // 7) Open UI
  const uiParams = { waves, skus, reheatCards, labels, supplies };
  if (typeof openUI === "function") {
    openUI("FreezingTracker", uiParams);
  } else {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "FreezingTracker", params: uiParams } }));
  }

  // 8) Optional calendar block for each wave (so users can stage trays)
  try {
    const events = [];
    let cursor = new Date(now);
    waves.forEach((w, i) => {
      const estMins = Math.max(30, Math.round((w.trayVolumeUsedMl + w.looseVolumeUsedMl) / 60)); // crude staging time
      const end = timeUtils?.addMinutes?.(cursor, estMins) || new Date(cursor.getTime() + estMins * 60000);
      events.push({ start: cursor, end, title: `Freeze wave ${i + 1} (${w.items.length} items)`, allDay: false, tags: ["freezer"] });
      cursor = end;
    });
    CalendarSyncModule?.load?.(events);
  } catch (_) {}

  // 9) Rotate reminder (FIFO) in 30 days
  const rotateAt = timeUtils?.addDays?.(now, 30) || new Date(now.getTime() + 30 * 24 * 3600 * 1000);
  ReminderManager.schedule?.({
    at: rotateAt,
    title: "Rotate freezer items",
    message: "Use oldest frozen items first. I can list what to pull.",
    tags: ["freezer", "rotation"]
  });

  // Friendly ping & badge
  NotificationCenter?.notify?.({
    title: "Freezing plan ready",
    message: `${waves.length} wave${waves.length > 1 ? "s" : ""} planned • labels generated.`,
    action: "View"
  });
  try { BadgeManager?.increment?.("freezing_session"); } catch (_) {}

  return {
    waves,
    skus,
    reheatCards,
    labels,
    message: template.success_message
  };
}

export default { template, execute };

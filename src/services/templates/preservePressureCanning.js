// src/services/templates/preservePressureCanning.js

import * as timeUtils from "@/utils/timeUtils";
import ReminderManager from "@/managers/ReminderManager";
import * as inventoryUtils from "@/utils/inventoryUtils";
import * as StorehousePlannerStore from "@/store/StorehousePlannerStore";
import * as SettingsStore from "@/store/SettingsStore"; // optional, guarded below

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
  id: "preserve_pressure_canning_v2",
  version: "2.2.0",
  purpose: "Convert surplus into shelf-stable jars, plan waves by capacity, and auto-schedule cool/label/store.",
  triggers: ["inventory::produceSurplus>threshold", "batch::completed", "ui::PressureCanningPlanner.open"],
  inputs: {
    // items: [{ name, type, acidity? ('low'|'high'|unknown), qtyLbs?, preferredJar?:'pint'|'quart' }]
    // jarSizes: [{ itemName?, size:'pint'|'quart' }]
    // cannerType: 'weighted'|'dial'
    // altitude: feet (number)
    // equipment: { racks?:number, jarsPerRack?:number, available?:boolean }
    // jarsAvailable: { pint?:number, quart?:number }   // optional stock check; we’ll reserve if InventoryStore exists
    // labelsFormat: optional passthrough for your LabelPrinter
    required: ["items", "jarSizes", "cannerType", "altitude"],
    optional: ["batchId", "equipment", "labelsFormat", "jarsAvailable"]
  },
  logic: {
    selectors: [
      "StorehousePlannerStore.getPreservationLots?()",
      "inventoryUtils.getSnapshot()",
      "Processing rules by food type, jar size, canner type, altitude",
      "Capacity planner → multi-run waves (racks × jarsPerRack) & jar availability"
    ],
    rules: [
      "Only pressure-can low-acid items; high-acid routes to water bath (fallback) or recipe-specific exceptions.",
      "Compute PSI by altitude + gauge type; block time for venting, process, natural cool.",
      "Check jar availability; auto-reserve jars/lids if InventoryStore is present.",
      "Generate QR labels and schedule cool-end, seal-check, and storage moves."
    ],
    llm_roles: []
  },
  actions: [
    "open:PressureCanningTracker.jsx",
    "open:LabelPrinter.jsx#print",
    "notify:ReminderManager.schedule(cool_end, seal_check, move_to_storage)",
    "write:StorehousePlannerStore.addLotRecord",
    "optional:InventoryStore.reserve(jars/lids)",
    "optional:CalendarSyncModule.load(blocks)"
  ],
  outputs: {
    ui: ["PressureCanningTracker.jsx", "LabelPrinter.jsx"],
    data: ["lotRecord", "inventoryIncrements", "labels", "waves", "psi", "safetyAdvisories"],
    alerts: ["cool_end", "seal_check", "move_to_storage"]
  },
  fallbacks: [
    "If canner unavailable → offer Freezing (#7) or Dehydrating (#8).",
    "If item judged high-acid → route to water-bath canning template (if present) or suggest verified recipe."
  ],
  success_message: "Canning plan ready—waves, timers, labels, and reminders are set.",
  used_by: ["storehouseAgent", "batchCookingAgent"]
};

/** ---------- Rules & helpers ---------- **/

const toNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const cap = (s = "") => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Minimal processing time map (minutes) by item type + jar size
// Tune these to your internal ruleset; these serve as safe planning defaults.
const PROCESS_TIME_MIN = {
  pint:   { meat: 75, poultry: 75, fish: 100, beans: 75, vegetable: 35, stock: 20 },
  quart:  { meat: 90, poultry: 90, fish: 100, beans: 90, vegetable: 40, stock: 25 }
};

/**
 * Pressure (PSI) by altitude & gauge type for low-acid foods.
 * weighted: 10 PSI <= 1000 ft; 15 PSI > 1000
 * dial:     11 PSI <= 2000; 12 PSI <= 4000; 13 PSI <= 6000; 14 PSI <= 8000; 15 PSI > 8000
 */
function choosePressurePSI(cannerType = "weighted", altitudeFt = 0) {
  const type = String(cannerType || "weighted").toLowerCase();
  const alt = toNum(altitudeFt, 0);

  if (type.includes("weighted")) return alt <= 1000 ? 10 : 15;
  if (alt <= 2000) return 11;
  if (alt <= 4000) return 12;
  if (alt <= 6000) return 13;
  if (alt <= 8000) return 14;
  return 15;
}

/**
 * Normalize item to rules key
 */
function normalizeType(item = {}) {
  const key = `${item.type || item.name || ""}`.toLowerCase();
  if (/stock|broth|bone/.test(key)) return "stock";
  if (/bean|chickpea|lentil|pea/.test(key)) return "beans";
  if (/fish|tuna|salmon|mackerel|sardine/.test(key)) return "fish";
  if (/chicken|turkey|poultry/.test(key)) return "poultry";
  if (/beef|lamb|goat|pork|venison|meat/.test(key)) return "meat";
  return "vegetable";
}

function isLowAcid(item = {}) {
  // Caller can specify explicitly; otherwise infer from type
  const a = String(item.acidity || "").toLowerCase();
  if (a === "low") return true;
  if (a === "high") return false;
  // Inference: meats, beans, veg are low-acid; fruit/tomato default to high unless recipe specifies pressure
  const t = normalizeType(item);
  return ["meat", "poultry", "fish", "beans", "vegetable", "stock"].includes(t);
}

function pickJarSizeFor(item, jarSizes = []) {
  const explicit = jarSizes?.find?.(j => j.itemName === item.name)?.size;
  return explicit || item.preferredJar || (jarSizes?.[0]?.size) || "pint";
}

/**
 * Capacity model → racks × jarsPerRack and jar availability by size
 * Returns { maxJarsPerRun, racks, jarsPerRack, jarStockOk, jarShortage: { pint, quart } }
 */
function resolveCapacity(equipment = {}, jarsAvailable = {}) {
  const racks = Math.max(1, toNum(equipment?.racks ?? SettingsStore?.get?.("canner.racks"), 1));
  const jarsPerRack = Math.max(1, toNum(equipment?.jarsPerRack ?? SettingsStore?.get?.("canner.jarsPerRack"), 7));
  const maxJarsPerRun = racks * jarsPerRack;

  const stockPint = Math.max(0, toNum(jarsAvailable?.pint, Infinity));
  const stockQuart = Math.max(0, toNum(jarsAvailable?.quart, Infinity));
  return {
    racks, jarsPerRack, maxJarsPerRun,
    jarStockOk: Number.isFinite(stockPint) || Number.isFinite(stockQuart),
    jarShortage: { pint: stockPint, quart: stockQuart }
  };
}

/**
 * Plan runs (waves) by item → respect capacity and jar stock
 * Each run has: { itemName, jarSize, jars, processMin, ventMin, coolMin, psi, runIndex, runOf }
 */
function buildCanningWaves({ items = [], jarSizes = [], cannerType, altitude, equipment = {}, jarsAvailable = {} }) {
  const psi = choosePressurePSI(cannerType, altitude);
  const { racks, jarsPerRack, maxJarsPerRun, jarStockOk, jarShortage } = resolveCapacity(equipment, jarsAvailable);

  // time constants
  const ventMin = 10;
  const coolMin = 45;

  // Prepare queue: low-acid first; within that, sort by weight desc
  const lowAcid = items.filter(isLowAcid);
  const highAcid = items.filter(i => !isLowAcid(i));

  const queue = [...lowAcid].sort((a, b) => toNum(b.qtyLbs, 0) - toNum(a.qtyLbs, 0));

  const waves = [];
  const reserved = { pint: 0, quart: 0 };
  for (const raw of queue) {
    const typeKey = normalizeType(raw);
    const jar = pickJarSizeFor(raw, jarSizes);
    const perRunTime = PROCESS_TIME_MIN[jar]?.[typeKey] ?? PROCESS_TIME_MIN.pint[typeKey] ?? 40;
    const lbs = Math.max(0.1, toNum(raw.qtyLbs, 0));
    const jarsNeeded = Math.max(1, Math.round(lbs / (jar === "quart" ? 2 : 1)));

    // Respect jar stock if provided (reserve per run)
    let stockCap = Infinity;
    if (jarStockOk && Number.isFinite(jarShortage[jar])) {
      stockCap = Math.max(0, jarShortage[jar] - reserved[jar]);
      if (stockCap <= 0) continue; // no jars available for this size → skip item for now
    }

    const effectivePerRun = Math.min(maxJarsPerRun, stockCap || maxJarsPerRun);
    const runs = Math.max(1, Math.ceil(jarsNeeded / Math.max(1, effectivePerRun)));

    for (let r = 0; r < runs; r++) {
      const batchCount = Math.min(effectivePerRun, jarsNeeded - r * effectivePerRun);
      waves.push({
        itemName: raw.name,
        type: typeKey,
        jarSize: jar,
        psi,
        ventMin,
        processMin: perRunTime,
        coolMin,
        totalBlockMin: ventMin + perRunTime + coolMin,
        jars: batchCount,
        runIndex: r + 1,
        runOf: runs,
        racks,
        jarsPerRack
      });
      reserved[jar] += batchCount;
    }
  }

  return { waves, psi, reserved, highAcidSkipped: highAcid.map(h => h.name) };
}

/**
 * Labels with QR payload for inventory actions
 */
function buildLabels(waves, batchId) {
  const date = new Date().toISOString().slice(0, 10);
  const labels = [];
  waves.forEach((w, wi) => {
    for (let j = 0; j < w.jars; j++) {
      const id = `${batchId || "pc"}_${wi}_${j}`;
      labels.push({
        id,
        name: `${cap(w.itemName)} (${w.jarSize})`,
        date,
        process: `${w.processMin} min @ ${w.psi} PSI`,
        run: `${w.runIndex}/${w.runOf}`,
        qr: { sku: id, meta: { kind: "pressure_canned", item: w.itemName, jarSize: w.jarSize, run: w.runIndex } }
      });
    }
  });
  return labels;
}

function buildSafetyAdvisories({ altitude, cannerType }) {
  const list = [];
  const psi = choosePressurePSI(cannerType, altitude);
  list.push({ kind: "psi_altitude", message: `Using ${psi} PSI for altitude ${altitude} ft (${cannerType}).` });
  list.push({ kind: "venting", message: "Vent a full 10 minutes before pressurizing." });
  list.push({ kind: "cooling", message: "Allow natural cool; do not force cool. Remove rings after 12–24h." });
  return list;
}

/**
 * Soft schedule blocks to Calendar (optional)
 */
function scheduleCalendarBlocks(waves, startAt = new Date()) {
  if (!CalendarSyncModule?.load) return;
  let cursor = new Date(startAt);
  const events = waves.map((w, i) => {
    const end = timeUtils?.addMinutes?.(cursor, w.totalBlockMin) || new Date(cursor.getTime() + w.totalBlockMin * 60000);
    const ev = { start: cursor, end, title: `Pressure-canning run ${i + 1} — ${cap(w.itemName)} (${w.jarSize}, ${w.jars} jars)`, tags: ["pressure_canning"] };
    cursor = end;
    return ev;
  });
  CalendarSyncModule.load(events);
}

/**
 * Cool-end, seal-check, move-to-storage reminders
 */
function scheduleReminders(waves = [], startAt = new Date()) {
  const totalMins = waves.reduce((s, w) => s + (w.totalBlockMin || 0), 0);
  const coolEnd = timeUtils?.addMinutes?.(startAt, Math.max(20, totalMins)) || new Date(startAt.getTime() + Math.max(20, totalMins) * 60000);

  ReminderManager.schedule?.({
    at: coolEnd,
    title: "Pressure canning: cool-down complete",
    message: "Check lids/seals, remove rings, and label jars.",
    tags: ["preservation", "pressure_canning", "cool_end"]
  });

  const sealCheck = timeUtils?.addHours?.(coolEnd, 12) || new Date(coolEnd.getTime() + 12 * 3600000);
  ReminderManager.schedule?.({
    at: sealCheck,
    title: "Seal check",
    message: "Confirm seals are firm; reprocess or refrigerate any unsealed jars.",
    tags: ["preservation", "pressure_canning", "seal_check"]
  });

  const moveTime = timeUtils?.addHours?.(coolEnd, 24) || new Date(coolEnd.getTime() + 24 * 3600000);
  ReminderManager.schedule?.({
    at: moveTime,
    title: "Move jars to storage",
    message: "Move sealed jars to pantry/root cellar; inventory will be updated.",
    tags: ["preservation", "pressure_canning", "move_to_storage"]
  });

  return { coolEnd, sealCheck, moveTime };
}

/**
 * Persist lot + schedule inventory increment at cool-end
 */
function finalizeInventory(waves = [], coolEnd = new Date()) {
  const lotId = StorehousePlannerStore.addLotRecord?.({
    type: "pressure_canning",
    createdAt: new Date(),
    runs: waves
  });

  ReminderManager.schedule?.({
    at: coolEnd,
    title: "Log canning lot",
    message: "Increment inventory counts for the new jars.",
    tags: ["preservation", "inventory"],
    payload: { action: "inventory:increment_lot", lotId }
  });

  return lotId;
}

function reserveSupplies(waves = [], jarsAvailable = {}) {
  if (!InventoryStore?.reserve) return;
  const need = waves.reduce((acc, w) => {
    acc[w.jarSize] = (acc[w.jarSize] || 0) + w.jars;
    return acc;
  }, {});
  try {
    if (need.pint)  InventoryStore.reserve?.("Mason jar - pint", need.pint, "ea");
    if (need.quart) InventoryStore.reserve?.("Mason jar - quart", need.quart, "ea");
    const lids = (need.pint || 0) + (need.quart || 0);
    if (lids) InventoryStore.reserve?.("Lids (regular/wide mix)", lids, "ea");
  } catch (_) {}
}

/** ---------- Execute ---------- **/

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Array<Object>} payload.items
 * @param {Array<Object>} payload.jarSizes
 * @param {string}        payload.cannerType
 * @param {number}        payload.altitude
 * @param {Object}       [payload.equipment]
 * @param {string}       [payload.batchId]
 * @param {Object}       [payload.labelsFormat]
 * @param {Object}       [payload.jarsAvailable]     // { pint, quart }
 * @param {Object}       [ctx]                       // { openUI?, runTemplate?, now? }
 * @returns {Promise<{lotRecord:string|null, labels:Array, psi:number, waves:Array, safetyAdvisories:Array, message:string, redirected?:string}>}
 */
export async function execute(payload, ctx = {}) {
  const {
    items = [],
    jarSizes = [],
    cannerType = "weighted",
    altitude = 0,
    equipment = {},
    batchId,
    labelsFormat,
    jarsAvailable = {}
  } = payload || {};
  const { openUI, runTemplate, now = new Date() } = ctx;

  // Guard: canner availability
  const cannerAvailable = (equipment?.available ?? SettingsStore?.get?.("canner.available") ?? true) === true;
  if (!cannerAvailable) {
    if (typeof runTemplate === "function") {
      try {
        await runTemplate("preserve_freezing_v1", { portions: items.map(i => ({ name: i.name, type: i.type, qty: i.qtyLbs, unit: "lb" })) });
        return { lotRecord: null, labels: [], psi: null, waves: [], safetyAdvisories: [], message: "Canner unavailable—switched to Freezing plan.", redirected: "freezing" };
      } catch {
        await runTemplate("preserve_dehydrating_v1", { items, dehydrator: equipment?.dehydrator });
        return { lotRecord: null, labels: [], psi: null, waves: [], safetyAdvisories: [], message: "Canner unavailable—switched to Dehydrating plan.", redirected: "dehydrating" };
      }
    }
    return { lotRecord: null, labels: [], psi: null, waves: [], safetyAdvisories: [], message: "Canner unavailable—choose Freezing or Dehydrating." };
  }

  // Route any high-acid items to water bath if you support it
  const highAcidNames = items.filter(i => !isLowAcid(i)).map(i => i.name);
  if (highAcidNames.length && typeof runTemplate === "function") {
    try {
      await runTemplate("preserve_water_bath_v1", { items: items.filter(i => !isLowAcid(i)) });
    } catch (_) {
      // If not available, we proceed with pressure plan for low-acid and leave advisories for the rest.
    }
  }

  // Build waves (capacity + jar stock aware)
  const { waves, psi, reserved, highAcidSkipped } = buildCanningWaves({
    items,
    jarSizes,
    cannerType,
    altitude,
    equipment,
    jarsAvailable
  });

  if (!waves.length) {
    throw new Error("preservePressureCanning: no waves were generated (check inputs, jar stock, or capacity).");
  }

  // Reserve jars/lids (best-effort)
  reserveSupplies(waves, jarsAvailable);

  // Open tracker UI
  const trackerParams = {
    batchId,
    psi,
    waves,
    startAt: now,
    advisories: buildSafetyAdvisories({ altitude, cannerType }),
    skippedHighAcid: highAcidSkipped
  };
  if (typeof openUI === "function") {
    openUI("PressureCanningTracker", trackerParams);
  } else {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "PressureCanningTracker", params: trackerParams } }));
  }

  // Labels (QR-ready)
  const labels = buildLabels(waves, batchId);
  try {
    if (typeof openUI === "function") {
      openUI("LabelPrinter", { labels, batchId, format: labelsFormat });
    } else {
      window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "LabelPrinter", params: { labels, batchId, format: labelsFormat } } }));
    }
    LabelPrinter?.printBatch?.(labels, labelsFormat);
  } catch (_) {}

  // Calendar blocks + reminders
  scheduleCalendarBlocks(waves, now);
  const { coolEnd } = scheduleReminders(waves, now);

  // Persist lot + schedule inventory increment
  const lotRecord = finalizeInventory(waves, coolEnd);

  // Ping + badge
  NotificationCenter?.notify?.({
    title: "Pressure-canning plan ready",
    message: `${waves.length} run${waves.length > 1 ? "s" : ""} planned @ ${psi} PSI. Labels generated.`,
    action: "View"
  });
  try { BadgeManager?.increment?.("pressure_canning_session"); } catch (_) {}

  return {
    lotRecord,
    labels,
    psi,
    waves,
    safetyAdvisories: buildSafetyAdvisories({ altitude, cannerType }),
    message: template.success_message
  };
}

export default { template, execute };

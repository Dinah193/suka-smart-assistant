// src/services/templates/preserveDehydrating.js

import * as timeUtils from "@/utils/timeUtils";
import ReminderManager from "@/managers/ReminderManager";
import * as StorehousePlannerStore from "@/store/StorehousePlannerStore";

// Optional/guarded integrations
let InventoryStore, LabelPrinter, NotificationCenter, CalendarSyncModule, BadgeManager;
try { InventoryStore = require("@/store/InventoryStore"); } catch (_) {}
try { LabelPrinter = require("@/services/labels/LabelPrinter").default; } catch (_) {}
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { BadgeManager = require("@/managers/BadgeManager"); } catch (_) {}

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "preserve_dehydrating_v2",
  version: "2.2.0",
  purpose: "Stabilize herbs/fruit/veg with batch planning, prompts, and safety rails.",
  triggers: ["garden::harvestLogged", "inventory::softHerbs>threshold", "ui::DehydratingPlanner.open"],
  inputs: {
    // items: [{ name, type('herb'|'fruit'|'veg'|'aromatic'), qty, unit, thicknessMm?, moistureHint?('very_wet'|'avg'|'dry'), notes? }]
    // thickness: default mm for items without thicknessMm
    // dehydrator: { model, airflow:'vertical'|'horizontal', tempRangeF:[min,max], trays?:number, trayAreaSqIn?:number }
    // humidityPct (optional): pass from weather module if available
    // supplies?: { reserve:boolean, jarsPerRun?:number, desiccantPacksPerRun?:number }
    required: ["items", "dehydrator"],
    optional: ["thickness", "humidityPct", "supplies"]
  },
  logic: {
    selectors: [
      "StorehousePlannerStore.getDehydratedLots?()",
      "Batching by type (herb/aromatic/fruit/veg), choose temp in machine range",
      "Adjust time by thickness, airflow, humidity, and moistureHint",
      "Respect tray capacity → split into sequential runs if needed"
    ],
    rules: [
      "Rotate-tray prompts every 60–90 min depending on airflow efficiency.",
      "Schedule snap test near end; schedule jar + desiccant; optional 1-week conditioning check.",
      "Reserve supplies and print labels (if integrations available).",
      "Persist lot with clear per-run details for UI and calendar."
    ],
    llm_roles: []
  },
  actions: [
    "OPEN_UI:DehydratingTracker.jsx",
    "NOTIFY:quiet reminders",
    "CALENDAR:load plan (optional)",
    "INVENTORY:reserve jars/desiccant (optional)",
    "PRINT:labels (optional)"
  ],
  outputs: {
    ui: ["DehydratingTracker.jsx"],
    data: ["runs", "labels", "lotId", "potencyWindow"],
    alerts: ["rotate_trays", "snap_test", "jar_and_desiccant", "conditioning_check"]
  },
  fallbacks: [
    "If very humid (>80%) → suggest postponing or increase dry time (+35%)."
  ],
  success_message: "Dehydrating plan ready—batches, rotations, and reminders scheduled.",
  used_by: ["storehouseAgent", "gardenAgent"]
};

/** ---------- Rules & helpers ---------- **/

// Baseline temps (°F) by type
const BASE_TEMP_F = { herb: 95, aromatic: 115, fruit: 135, veg: 125 };
// Baseline time (hours) for ~3mm slices at base temp (approx)
const BASE_TIME_HR = { herb: 2.5, aromatic: 6, fruit: 8, veg: 6 };

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function normalizeType(item = {}) {
  const t = String(item.type || item.name || "").toLowerCase();
  if (/parsley|cilantro|dill|basil|mint|thyme|oregano|sage|rosemary|chive|herb/.test(t)) return "herb";
  if (/garlic|onion|leek|shallot|aromatic/.test(t)) return "aromatic";
  if (/apple|pear|peach|plum|banana|berry|mango|pineapple|fruit/.test(t)) return "fruit";
  return "veg";
}

function chooseTempF(kind, dehydrator = {}) {
  const base = BASE_TEMP_F[kind] ?? 125;
  const [minF, maxF] = dehydrator.tempRangeF ?? [90, 160];
  return clamp(base, minF, maxF);
}

function estimateHours(kind, thicknessMm, dehydrator = {}, humidityPct, moistureHint) {
  const baseHr = BASE_TIME_HR[kind] ?? 6;
  const mm = Math.max(1, Number(thicknessMm ?? 3));
  const airflow = String(dehydrator.airflow || "horizontal").toLowerCase();

  let hours = baseHr * (mm / 3);

  // Airflow penalty: vertical stacks are usually less even
  if (airflow.includes("vertical")) hours *= 1.2;

  // Moisture hint: very_wet +20%, dry -10%
  if (moistureHint === "very_wet") hours *= 1.2;
  else if (moistureHint === "dry") hours *= 0.9;

  // Humidity penalty
  const h = Number(humidityPct ?? -1);
  if (h >= 0) {
    if (h > 80) hours *= 1.35;
    else if (h > 65) hours *= 1.2;
  }

  return clamp(hours, 1, 24);
}

function buildRotatePrompts(startAt, totalHours, dehydrator = {}) {
  const stepMin = String(dehydrator.airflow || "horizontal").toLowerCase().includes("vertical") ? 60 : 90;
  const prompts = [];
  const totalMin = Math.round(totalHours * 60);
  for (let m = stepMin; m < totalMin; m += stepMin) {
    const at = timeUtils?.addMinutes?.(startAt, m) || new Date(startAt.getTime() + m * 60000);
    prompts.push({ at, title: "Rotate trays", message: "Rotate & check evenness." });
  }
  return prompts;
}

function toLocalISO(date) {
  const d = new Date(date);
  const z = d.getTimezoneOffset() * 60000;
  return new Date(d - z).toISOString().slice(0, 16); // YYYY-MM-DDTHH:MM
}

// Estimate jar yield & potency window
function buildJarRecords(batchItems = [], tempF, hours) {
  const today = new Date();
  return batchItems.map((it, idx) => {
    const kind = normalizeType(it);
    const estJars =
      kind === "herb" ? Math.max(1, Math.round(Number(it.qty ?? 1) / 1.5))
      : Math.max(1, Math.round(Number(it.qty ?? 1) / 2));

    const months = kind === "herb" ? 9 : 9; // center of 6–12 months
    const potencyDate = timeUtils?.toLocalISODate?.(timeUtils?.addDays?.(today, months * 30))
      || new Date(today.getTime() + months * 30 * 86400000).toISOString().slice(0, 10);

    return {
      id: `DEHY_${today.toISOString().slice(0,10).replace(/-/g,"")}_${idx}`,
      itemName: it.name || kind,
      type: kind,
      tempF,
      hours: Number(hours.toFixed(1)),
      jars: estJars,
      date: today.toISOString().slice(0, 10),
      potencyDate
    };
  });
}

// Split items into runs by tray capacity (very simple heuristic)
function buildRunsGroupedByType(items, dehydrator, defaults) {
  const trays = Math.max(1, Number(dehydrator.trays ?? 5));
  // crude capacity: each item uses 1 tray unless qty/unit says otherwise
  // For simplicity, we assume 1 "tray unit" per item record.
  const groups = items.reduce((m, it) => {
    const kind = normalizeType(it);
    m[kind] = m[kind] || [];
    m[kind].push(it);
    return m;
  }, {});

  const runs = [];
  Object.entries(groups).forEach(([kind, arr]) => {
    for (let i = 0; i < arr.length; i += trays) {
      runs.push({
        kind,
        items: arr.slice(i, i + trays),
        thicknessMm: defaults.thickness,
      });
    }
  });
  return runs;
}

/** ---------- Execute ---------- **/

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Array<Object>} payload.items
 * @param {number}        [payload.thickness]      // mm default
 * @param {Object}        payload.dehydrator       // { model, airflow, tempRangeF:[min,max], trays?, trayAreaSqIn? }
 * @param {number}        [payload.humidityPct]    // optional external weather input
 * @param {Object}        [payload.supplies]       // { reserve:boolean, jarsPerRun?:number, desiccantPacksPerRun?:number }
 * @param {Object}        [ctx]                    // { openUI?, now? }
 * @returns {Promise<{runs:Array, labels:Array, potencyWindow:{from:string,to:string}, lotId:string|null, message:string, postpone?:boolean}>}
 */
export async function execute(payload, ctx = {}) {
  const { items = [], thickness, dehydrator = {}, humidityPct, supplies = {} } = payload || {};
  const { openUI, now = new Date() } = ctx;

  if (!items.length) throw new Error("preserveDehydrating: no items provided.");

  // Postpone suggestion on very humid days
  let postpone = false;
  if (typeof humidityPct === "number" && humidityPct > 80) postpone = true;

  // Plan sequential runs by type & tray capacity
  const plannedRuns = buildRunsGroupedByType(items, dehydrator, { thickness });

  const runs = [];
  let cursorStart = new Date(now);
  const allLabels = [];

  for (const r of plannedRuns) {
    const sample = r.items[0] || {};
    const kind = r.kind;
    const tempF = chooseTempF(kind, dehydrator);
    const thicknessMm = r.thicknessMm ?? sample.thicknessMm ?? 3;

    // moistureHint: if any item says very_wet, carry that
    const moistureHint = r.items.some((it) => it.moistureHint === "very_wet")
      ? "very_wet"
      : r.items.some((it) => it.moistureHint === "dry")
      ? "dry"
      : "avg";

    const hours = estimateHours(kind, thicknessMm, dehydrator, humidityPct, moistureHint);

    // Rotate prompts & reminders
    const rotatePrompts = buildRotatePrompts(cursorStart, hours, dehydrator);

    const snapAtMin = Math.max(30, Math.round((hours - 0.5) * 60));
    const snapAt = timeUtils?.addMinutes?.(cursorStart, snapAtMin) || new Date(cursorStart.getTime() + snapAtMin * 60000);
    const endAt = timeUtils?.addMinutes?.(cursorStart, Math.round(hours * 60)) || new Date(cursorStart.getTime() + Math.round(hours * 60) * 60000);
    const jarAt = timeUtils?.addHours?.(endAt, 12) || new Date(endAt.getTime() + 12 * 3600000);
    const conditionAt = timeUtils?.addDays?.(jarAt, 7) || new Date(jarAt.getTime() + 7 * 86400000);

    // Build jar records & labels
    const jars = buildJarRecords(r.items, tempF, hours);
    const labels = jars.map((j) => ({
      sku: `dehy_${j.itemName.toLowerCase().replace(/\s+/g, "_")}`,
      title: `${j.itemName} — ${kind}`,
      lines: [
        `Temp: ${tempF}°F • ${j.hours}h`,
        `Dehydrated: ${j.date}`,
        `Best by: ${j.potencyDate}`
      ]
    }));
    allLabels.push(...labels);

    // Reminders (quiet)
    rotatePrompts.forEach((p) => {
      ReminderManager.schedule?.({ at: p.at, title: p.title, message: p.message, tags: ["preservation", "dehydrating", "rotate_trays"] });
    });
    ReminderManager.schedule?.({
      at: snapAt,
      title: "Snap test",
      message: "Cool a piece: herbs should snap; fruit/veg leathery or crisp (depending). Continue if still soft.",
      tags: ["preservation", "dehydrating", "snap_test"]
    });
    ReminderManager.schedule?.({
      at: jarAt,
      title: "Jar & desiccant",
      message: "Jar the dried foods once fully cool. Add desiccant if needed. Label jars.",
      tags: ["preservation", "dehydrating", "jar_and_desiccant"]
    });
    ReminderManager.schedule?.({
      at: conditionAt,
      title: "Conditioning check",
      message: "Shake jars and verify no clumping/condensation. If present, re-dry briefly.",
      tags: ["preservation", "dehydrating", "conditioning_check"]
    });

    // Optional calendar events
    try {
      CalendarSyncModule?.load?.([
        { start: cursorStart, end: endAt, title: `Dehydrate — ${kind} (${r.items.length} tray${r.items.length>1?"s":""})`, allDay: false, tags: ["dehydrating"] },
        { start: jarAt, end: timeUtils?.addMinutes?.(jarAt, 30) || new Date(jarAt.getTime() + 1800000), title: "Jar & desiccant", allDay: false },
      ]);
    } catch (_) {}

    // Optional supplies reservations
    if (supplies?.reserve && InventoryStore?.reserve) {
      const jarsNeeded = supplies.jarsPerRun ?? jars.reduce((s, j) => s + (j.jars || 1), 0);
      const packsNeeded = supplies.desiccantPacksPerRun ?? Math.ceil(jarsNeeded * 0.6);
      try {
        InventoryStore.reserve?.("mason jar", jarsNeeded, "ea");
        InventoryStore.reserve?.("desiccant pack", packsNeeded, "ea");
      } catch (_) {}
    }

    // Push run
    runs.push({
      kind,
      items: r.items,
      tempF,
      hours: Number(hours.toFixed(1)),
      startAt: cursorStart,
      endAt,
      snapTestAt: snapAt,
      jarAt,
      rotatePrompts,
      labels
    });

    // Next run starts after this one (simple sequential scheduling)
    cursorStart = timeUtils?.addMinutes?.(endAt, 15) || new Date(endAt.getTime() + 900000); // 15m buffer
  }

  // Persist lot (best-effort)
  const lotId =
    StorehousePlannerStore.addDehydratedLot?.({
      createdAt: now,
      dehydrator,
      humidityPct,
      runs: runs.map((r) => ({
        kind: r.kind,
        startAt: r.startAt,
        endAt: r.endAt,
        tempF: r.tempF,
        hours: r.hours,
        items: r.items,
        labels: r.labels
      }))
    }) ?? null;

  // Print labels (optional)
  try { LabelPrinter?.printBatch?.(allLabels); } catch (_) {}

  // Open UI
  const potencyFrom = runs[0]?.startAt ? toLocalISO(runs[0].startAt).slice(0,10) : new Date().toISOString().slice(0,10);
  const potencyTo   = runs[runs.length-1]?.items?.[0]
    ? runs[runs.length-1].labels?.[0]?.lines?.find?.(l => l.startsWith("Best by:"))?.split(": ").pop() || ""
    : "";
  const trackerParams = {
    dehydrator,
    humidityPct,
    postpone,
    runs,
    lotId,
    potencyWindow: { from: potencyFrom, to: potencyTo }
  };

  if (typeof openUI === "function") {
    openUI("DehydratingTracker", trackerParams);
  } else {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "DehydratingTracker", params: trackerParams } }));
  }

  // Friendly notification + badge
  NotificationCenter?.notify?.({
    title: "Dehydrating plan created",
    message: `${runs.length} run${runs.length>1?"s":""} scheduled with tray rotations and reminders.`,
    action: "View"
  });
  try { BadgeManager?.increment?.("dehydrating_session"); } catch (_) {}

  return {
    runs,
    labels: allLabels,
    potencyWindow: { from: potencyFrom, to: potencyTo },
    lotId,
    message: template.success_message,
    postpone
  };
}

export default { template, execute };

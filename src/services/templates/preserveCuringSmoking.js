// src/services/templates/preserveCuringSmoking.js

import * as timeUtils from "@/utils/timeUtils";
import ReminderManager from "@/managers/ReminderManager";
import * as StorehousePlannerStore from "@/store/StorehousePlannerStore";

// Optional/guarded modules
let InventoryStore, NotificationCenter, LabelPrinter, BadgeManager, CalendarSyncModule;
try { InventoryStore = require("@/store/InventoryStore"); } catch (_) {}
try { NotificationCenter = require("@/managers/NotificationCenter").default; } catch (_) {}
try { LabelPrinter = require("@/services/labels/LabelPrinter").default; } catch (_) {}
try { BadgeManager = require("@/managers/BadgeManager"); } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}

/**
 * Contract-compliant metadata
 */
export const template = {
  id: "preserve_curing_smoking_v2",
  version: "2.3.0",
  purpose: "Stress-free long cures with calendar automation and safety rails.",
  triggers: ["butchering::logged", "sale::bulk_meat", "ui::CurePlanner.open"],
  inputs: {
    // cuts: [{ id?, name, type ('belly'|'ham'|'loin'|'shoulder'|'fish'|'other'), weightKg, thicknessCm?, skinOn?, notes? }]
    // targetStyle: 'bacon'|'pancetta'|'ham'|'pastrami'|'smoked_fish'|'jerky'|'custom'
    // method?: 'dry'|'brine'  (optional, default per style)
    // fridge: { tempC, capacityKg?, litersFree? }
    // smoker: { available:boolean, type?:'hot'|'cold', wood?:string, maxHours?:number, capacityKg?:number, preferredWindow?:'evening'|'weekend' }
    // supplies?: { reserve:boolean }  // reserve salt/sugar/cure #1 if InventoryStore exists
    required: ["cuts", "targetStyle", "fridge", "smoker"],
    optional: ["method", "supplies"]
  },
  logic: {
    selectors: [
      "StorehousePlannerStore.getCureLots?()",
      "InventoryStore.reserve?(salt/sugar/cure#1) if supplies.reserve",
      "Style rules: %salt, %sugar, cure#1, days/kg or days/cm, flip cadence, smoke mode/hours",
      "Wet brine math (g/L; 1 L ≈ 1 kg water), equilibrium targeting",
      "Smoker capacity windowing (evening or next weekend), respect maxHours"
    ],
    rules: [
      "Compute cure/brine per cut by weight & style; clamp cure#1 to safe ranges.",
      "Schedule flips; pellicle/air-dry before smoke when applicable.",
      "Place smoke blocks in a realistic window based on smoker availability/capacity.",
      "Attach safety checks (finish temps for hot smoke; cold-smoke cautions).",
      "If smoker unavailable or time window impossible → offer partial-cure then freeze."
    ],
    llm_roles: []
  },
  actions: [
    "OPEN_UI:SmokingAndCuringManager.jsx",
    "NOTIFY:quiet cadence reminders",
    "CALENDAR:load plan",
    "PRINT:labels (optional)",
    "INVENTORY:reserve supplies (optional)"
  ],
  outputs: {
    ui: ["SmokingAndCuringManager.jsx"],
    data: ["cureLog", "safetyChecks", "lotId", "labels"],
    alerts: ["flip", "air_dry", "smoke_start", "smoke_end", "rest_done"]
  },
  fallbacks: [
    "Offer partial cure → freeze if time/space/smoker is constrained."
  ],
  success_message: "Cure plan set—flips, air-dry, smoke windows, and labels are ready.",
  used_by: ["storehouseAgent", "animalAgent"]
};

/** ---------- Style rules & helpers ---------- **/

// Reasonable defaults; tweak to your house profiles
const STYLE_RULES = {
  bacon:        { method: "dry",  saltPct: 0.025, sugarPct: 0.012, cure1Pct: 0.0025, daysPerCm: 1.5, flipEveryDays: 1, smoke: { mode: "hot", hours: 6, finishTempC: 62 } },
  pancetta:     { method: "dry",  saltPct: 0.028, sugarPct: 0.010, cure1Pct: 0.0020, daysPerCm: 1.6, flipEveryDays: 1, smoke: null },
  ham:          { method: "brine",saltPct: 0.027, sugarPct: 0.012, cure1Pct: 0.0025, daysPerCm: 2.0, flipEveryDays: 1, smoke: { mode: "hot", hours: 8, finishTempC: 63 } },
  pastrami:     { method: "brine",saltPct: 0.027, sugarPct: 0.015, cure1Pct: 0.0025, daysPerCm: 1.4, flipEveryDays: 1, smoke: { mode: "hot", hours: 8, finishTempC: 63 } },
  smoked_fish:  { method: "brine",saltPct: 0.030, sugarPct: 0.015, cure1Pct: 0.0020, daysPerCm: 0.8, flipEveryDays: 1, smoke: { mode: "hot", hours: 3, finishTempC: 60 } },
  jerky:        { method: "dry",  saltPct: 0.030, sugarPct: 0.010, cure1Pct: 0.0020, daysPerCm: 0.5, flipEveryDays: 0.5, smoke: { mode: "hot", hours: 4, finishTempC: 71 } },
  custom:       { method: "dry",  saltPct: 0.027, sugarPct: 0.012, cure1Pct: 0.0020, daysPerCm: 1.5, flipEveryDays: 1, smoke: { mode: "hot", hours: 6, finishTempC: 63 } }
};

// Hard guardrails for cure #1 grams per kg green weight (6.25% nitrite premix)
const CURE1_PCT_MIN = 0.0015; // 0.15%
const CURE1_PCT_MAX = 0.0030; // 0.30%

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const kgToG = (kg) => Math.round(Number(kg || 0) * 1000);
const gToKg = (g) => Number(g || 0) / 1000;

function addDays(d, n) {
  return typeof timeUtils?.addDays === "function"
    ? timeUtils.addDays(d, n)
    : new Date(d.getTime() + n * 86400000);
}
function addHours(d, n) {
  return typeof timeUtils?.addHours === "function"
    ? timeUtils.addHours(d, n)
    : new Date(d.getTime() + n * 3600000);
}

/** Compute cure or brine for a cut */
function computeDoseForCut(cut, styleKey, forcedMethod) {
  const rules = STYLE_RULES[styleKey] ?? STYLE_RULES.custom;
  const method = forcedMethod || rules.method || "dry";

  const weightKg = Number(cut.weightKg ?? 0);
  const thicknessCm = Number(cut.thicknessCm ?? 3);

  // Percentages are by green weight. For brine, treat 1 L water ≈ 1 kg.
  const saltPct  = Number(rules.saltPct  ?? 0.027);
  const sugarPct = Number(rules.sugarPct ?? 0.012);
  const cure1Pct = clamp(Number(rules.cure1Pct ?? 0.0020), CURE1_PCT_MIN, CURE1_PCT_MAX);

  const massG = kgToG(weightKg);

  const dry = {
    method: "dry",
    saltG:  +(massG * saltPct).toFixed(1),
    sugarG: +(massG * sugarPct).toFixed(1),
    cure1G: +(massG * cure1Pct).toFixed(1)
  };

  // Simple equilibrium brine target volume ~ 40% of meat weight (adjustable)
  // e.g., 1.0 kg meat → 0.4 L water. Dial this to your house SOP.
  const brineVolKg = +(weightKg * 0.4).toFixed(2);
  const brineMassG = kgToG(brineVolKg);

  const brine = {
    method: "brine",
    waterKg: brineVolKg,
    saltG:  +(brineMassG * saltPct).toFixed(1),
    sugarG: +(brineMassG * sugarPct).toFixed(1),
    cure1G: +(brineMassG * cure1Pct).toFixed(1)
  };

  const cureDays = Math.max(3, Math.ceil(thicknessCm * (rules.daysPerCm || 1.5)));

  return { rules, method, dry, brine, cureDays };
}

/** Try to place a smoke block realistically */
function scheduleSmokeWindow({ endCure, hoursNeeded, smoker, prefer }) {
  if (!hoursNeeded) return { start: null, end: null };

  const capHours = smoker?.maxHours ? Math.min(hoursNeeded, Number(smoker.maxHours)) : hoursNeeded;
  let start = addHours(endCure, 12); // default: next morning/overnight pellicle accounted elsewhere
  const now = new Date();

  // Respect preferred window
  if (prefer === "evening") {
    start = addHours(endCure, 24); // next evening by default
    start.setHours(17, 30, 0, 0);
  } else if (prefer === "weekend") {
    // find next Sat/Sun late morning
    const tmp = new Date(Math.max(now.getTime(), endCure.getTime()));
    for (let i = 0; i < 14; i++) {
      const cand = addDays(tmp, i);
      const dow = cand.getDay(); // 0 Sun..6 Sat
      if (dow === 6 || dow === 0) {
        cand.setHours(10, 0, 0, 0);
        start = cand;
        break;
      }
    }
  }

  const end = addHours(start, capHours);
  return { start, end };
}

/** Build a per-cut cure plan */
function buildCurePlan({ cuts, targetStyle, fridge, smoker, method, startAt = new Date() }) {
  const plan = [];
  const tempC = Number(fridge?.tempC ?? 2);
  const safeFridge = clamp(tempC, -1, 4); // typical safe band

  const smokerHas = !!smoker && !!smoker.available;
  const smokerMode = STYLE_RULES[targetStyle]?.smoke?.mode || "hot";
  const preferWindow = smoker?.preferredWindow || (smokerMode === "hot" ? "evening" : "weekend");
  const smokerCapacityKg = Number(smoker?.capacityKg ?? Infinity);

  // Sum batch weight
  const totalBatchKg = cuts.reduce((s, c) => s + Number(c.weightKg || 0), 0);
  const overCapacity = totalBatchKg > smokerCapacityKg;

  for (const cut of cuts) {
    const dose = computeDoseForCut(cut, targetStyle, method);
    const start = new Date(startAt);
    const endCure = addDays(start, dose.cureDays);

    // Flip cadence
    const flips = [];
    const every = Math.max(0.5, Number(dose.rules.flipEveryDays ?? 1));
    const totalFlips = Math.max(1, Math.round(dose.cureDays / every));
    for (let i = 1; i <= totalFlips; i++) {
      flips.push({
        at: addDays(start, i * every),
        title: "Flip & massage cure",
        cutId: cut.id ?? cut.name
      });
    }

    // Pellicle/air-dry for smoking styles
    const willSmoke = !!STYLE_RULES[targetStyle]?.smoke && smokerHas;
    const pellicleStart = willSmoke ? addHours(endCure, 12) : null;

    let smoke = null;
    if (willSmoke) {
      const hours = Number(STYLE_RULES[targetStyle].smoke.hours ?? 6);
      const { start: smokeStart, end: smokeEnd } = scheduleSmokeWindow({
        endCure,
        hoursNeeded: hours,
        smoker,
        prefer: preferWindow
      });
      smoke = { start: smokeStart, end: smokeEnd, mode: smokerMode };
    }

    // Rest after smoke (or cure end if not smoking)
    const restEnd = smoke?.end ? addHours(smoke.end, 12) : endCure;

    plan.push({
      cut,
      dose, // dry/brine grams and cureDays
      cure: { start, end: endCure, flips },
      pellicle: willSmoke ? { start: pellicleStart, hours: 12 } : null,
      smoke,
      rest: { end: restEnd }
    });
  }

  return { plan, safeFridge, overCapacity };
}

/** Safety checks & advisories */
function buildSafetyChecks(entry, styleKey) {
  const checks = [];
  checks.push({
    kind: "fridge_temp",
    okRangeC: "0–4°C",
    note: "Keep curing cuts in 0–4°C (32–39°F)."
  });

  const rules = STYLE_RULES[styleKey] ?? STYLE_RULES.custom;
  const smokeCfg = rules.smoke;

  if (entry.smoke && smokeCfg) {
    if (smokeCfg.mode === "hot") {
      const finishC = smokeCfg.finishTempC ?? 63;
      checks.push({
        kind: "hot_smoke_finish_temp",
        targetC: finishC,
        cue: "Probe thickest part; rest 10 min; refrigerate after."
      });
    } else {
      checks.push({
        kind: "cold_smoke_caution",
        cue: "Keep <21°C/70°F; smoke in short sessions; chill between; cook before service."
      });
    }
  } else if (!smokeCfg) {
    checks.push({
      kind: "no_smoke",
      cue: "After cure, air-dry to target texture; cook before eating unless validated dry-age/ferment SOP is used."
    });
  }

  // Cure #1 bound echo (per cut)
  const { cure1G } = entry.dose[entry.dose.method] || {};
  if (cure1G > 0) {
    checks.push({
      kind: "cure1_guard",
      note: "Cure #1 dose applied within house guardrails (0.15%–0.30% of mix proxy)."
    });
  }
  return checks;
}

/** Reserve supplies from inventory (best-effort) */
function reserveSupplies(entries, { reserve }) {
  if (!reserve || !InventoryStore?.reserve) return [];

  const reservations = [];
  for (const e of entries) {
    const d = e.dose[e.dose.method];
    if (!d) continue;

    if (e.dose.method === "dry") {
      reservations.push({ name: "kosher salt", qtyG: d.saltG });
      reservations.push({ name: "sugar", qtyG: d.sugarG });
      if (d.cure1G > 0) reservations.push({ name: "cure #1", qtyG: d.cure1G });
    } else {
      reservations.push({ name: "water (L)", qty: +(d.waterKg).toFixed(2) });
      reservations.push({ name: "salt (g)", qty: d.saltG });
      reservations.push({ name: "sugar (g)", qty: d.sugarG });
      if (d.cure1G > 0) reservations.push({ name: "cure #1 (g)", qty: d.cure1G });
    }
  }

  // Coalesce by name
  const merged = reservations.reduce((m, r) => {
    const key = r.name;
    if (!m[key]) m[key] = { name: key, qtyG: 0, qty: 0 };
    if ("qtyG" in r) m[key].qtyG += r.qtyG;
    if ("qty" in r) m[key].qty += r.qty;
    return m;
  }, {});
  const list = Object.values(merged);

  // Reserve (graceful failure)
  try {
    list.forEach((it) => {
      InventoryStore.reserve?.(it.name, it.qtyG || it.qty || 0, it.qtyG ? "g" : undefined);
    });
  } catch (_) {}

  return list;
}

/** Create simple labels for printing */
function buildLabels(entries, styleKey) {
  const today = new Date().toISOString().slice(0, 10);
  return entries.map((e) => ({
    sku: `cure_${(e.cut.name || "cut").toLowerCase().replace(/\s+/g, "_")}`,
    title: `${e.cut.name} — ${styleKey}`,
    lines: [
      `Start: ${e.cure.start.toISOString().slice(0, 10)}`,
      `End cure: ${e.cure.end.toISOString().slice(0, 10)}`,
      e.smoke?.start ? `Smoke: ${e.smoke.start.toISOString().slice(0, 10)}` : null,
      `Label: ${today}`
    ].filter(Boolean),
    notes: e.dose.method === "dry"
      ? `Dry: salt ${e.dose.dry.saltG}g, sugar ${e.dose.dry.sugarG}g, cure#1 ${e.dose.dry.cure1G}g`
      : `Brine: water ${e.dose.brine.waterKg}kg, salt ${e.dose.brine.saltG}g, sugar ${e.dose.brine.sugarG}g, cure#1 ${e.dose.brine.cure1G}g`
  }));
}

/** Quiet reminders for flips/air-dry/smoke */
function scheduleCadenceReminders(entry) {
  (entry.cure.flips || []).forEach((f) => {
    ReminderManager.schedule?.({
      at: f.at,
      title: "Flip & massage cure",
      message: `${entry.cut.name}: turn bag and massage salt evenly.`,
      tags: ["curing", "flip"]
    });
  });

  if (entry.pellicle?.start) {
    ReminderManager.schedule?.({
      at: entry.pellicle.start,
      title: "Air-dry/pellicle",
      message: `${entry.cut.name}: rack uncovered in fridge to form tacky surface.`,
      tags: ["curing", "air_dry"]
    });
  }
  if (entry.smoke?.start) {
    ReminderManager.schedule?.({
      at: entry.smoke.start,
      title: "Start smoke",
      message: `${entry.cut.name}: preheat smoker, add wood, begin ${entry.smoke.mode} smoke.`,
      tags: ["curing", "smoke_start"]
    });
  }
  if (entry.smoke?.end) {
    ReminderManager.schedule?.({
      at: entry.smoke.end,
      title: "Smoke finished",
      message: `${entry.cut.name}: confirm doneness/safety; move to rest.`,
      tags: ["curing", "smoke_end"]
    });
  }
  if (entry.rest?.end) {
    ReminderManager.schedule?.({
      at: entry.rest.end,
      title: "Ready to portion/store",
      message: `${entry.cut.name}: chill, slice/portion, label, and store.`,
      tags: ["curing", "rest_done"]
    });
  }
}

/** ---------- Execute ---------- **/

/**
 * Execute the template.
 * @param {Object} payload
 * @param {Array<Object>} payload.cuts
 * @param {string}        payload.targetStyle
 * @param {Object}        payload.fridge
 * @param {Object}        payload.smoker
 * @param {("dry"|"brine")} [payload.method]
 * @param {Object}        [payload.supplies]
 * @param {Object}        [ctx]                 // { openUI?, runTemplate?, now? }
 * @returns {Promise<{cureLog:Array, safetyChecks:Array, lotId:string|null, labels:Array, message:string, fallback?:string}>}
 */
export async function execute(payload, ctx = {}) {
  const { cuts = [], targetStyle, fridge = {}, smoker = {}, method, supplies = {} } = payload || {};
  const { openUI, runTemplate, now = new Date() } = ctx;

  if (!cuts.length) throw new Error("preserveCuringSmoking: no cuts provided.");

  const styleHasSmoke = !!STYLE_RULES[targetStyle]?.smoke;

  // Smoker availability fallback
  if (styleHasSmoke && !smoker?.available) {
    if (typeof runTemplate === "function") {
      try {
        await runTemplate("preserve_freezing_v1", {
          portions: cuts.map((c) => ({ name: c.name, type: targetStyle, qty: c.weightKg ?? 1, unit: "kg", notes: "Freeze after partial cure." }))
        });
      } catch (_) {}
    }
    return {
      cureLog: [],
      safetyChecks: [],
      lotId: null,
      labels: [],
      message: "Smoker unavailable—offered partial cure then freeze.",
      fallback: "partial_cure_freeze"
    };
  }

  // Build plan
  const { plan, safeFridge, overCapacity } = buildCurePlan({
    cuts,
    targetStyle,
    fridge,
    smoker,
    method,
    startAt: now
  });

  // If smoker capacity exceeded and style requires smoke → suggest split/partial freeze
  if (styleHasSmoke && overCapacity) {
    NotificationCenter?.notify?.({
      title: "Smoker capacity exceeded",
      message: "We’ll split into multiple smoke runs or freeze a portion after cure.",
      action: "Review Plan"
    });
  }

  // Reserve supplies (optional)
  const reservations = reserveSupplies(plan, { reserve: supplies?.reserve });

  // Persist lot
  const lotId =
    StorehousePlannerStore.addCureLot?.({
      createdAt: now,
      targetStyle,
      fridge: { tempC: safeFridge },
      smoker,
      entries: plan,
      reservations
    }) ?? null;

  // Safety checks
  const safetyChecks = plan.map((entry) => ({
    cut: entry.cut.name,
    checks: buildSafetyChecks(entry, targetStyle)
  }));

  // Labels
  const labels = buildLabels(plan, targetStyle);
  try { LabelPrinter?.printBatch?.(labels); } catch (_) {}

  // Calendar load (best-effort)
  try {
    const events = [];
    plan.forEach((p) => {
      (p.cure.flips || []).forEach((f) =>
        events.push({ start: f.at, end: addHours(f.at, 0.25), title: `Flip cure — ${p.cut.name}`, allDay: false, tags: ["curing", "flip"] })
      );
      if (p.pellicle?.start) events.push({ start: p.pellicle.start, end: addHours(p.pellicle.start, p.pellicle.hours), title: `Air-dry (pellicle) — ${p.cut.name}`, allDay: false });
      if (p.smoke?.start && p.smoke?.end) events.push({ start: p.smoke.start, end: p.smoke.end, title: `Smoke (${p.smoke.mode}) — ${p.cut.name}`, allDay: false });
      if (p.rest?.end) events.push({ start: p.rest.end, end: addHours(p.rest.end, 1), title: `Ready to portion/store — ${p.cut.name}`, allDay: false });
    });
    CalendarSyncModule?.load?.(events);
  } catch (_) {}

  // UI open
  const uiParams = { lotId, style: targetStyle, fridgeTempC: safeFridge, smoker, plan, reservations, labels };
  if (typeof openUI === "function") {
    openUI("SmokingAndCuringManager", uiParams);
  } else {
    window.dispatchEvent(new CustomEvent("ui:navigate", { detail: { route: "SmokingAndCuringManager", params: uiParams } }));
  }

  // Quiet reminders
  plan.forEach(scheduleCadenceReminders);

  // Badge/streak
  try { BadgeManager?.increment?.("curing_session"); } catch (_) {}

  // Output-friendly cure log
  const cureLog = plan.map((p) => ({
    cut: p.cut.name,
    method: p.dose.method,
    cureStart: p.cure.start,
    cureEnd: p.cure.end,
    flips: p.cure.flips.length,
    pellicleStart: p.pellicle?.start ?? null,
    smokeStart: p.smoke?.start ?? null,
    smokeEnd: p.smoke?.end ?? null,
    restEnd: p.rest?.end ?? null
  }));

  return {
    cureLog,
    safetyChecks,
    lotId,
    labels,
    message: template.success_message
  };
}

export default { template, execute };

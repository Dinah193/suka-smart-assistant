// C:\Users\larho\suka-smart-assistant\src\services\templates\garden\PestDiseaseScout.template.js

/**
 * Pest & Disease Scout — dynamic v2.4.0
 * - Seasonal windows + symptom inference → unified alerts with confidence
 * - Optional weather boost for fungal risks (humidity/rain recent days)
 * - Inventory checks → ORDER_SUPPLIES and a consolidated PROCUREMENT_SUGGEST
 * - Care tasks + follow-ups, escalation hints, and UI bootstrapping
 * - Backward-compatible outputs/actions & inputs (weather is optional)
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const title = (s) => (s || "").replace(/\b\w/g, (m) => m.toUpperCase());
const uniq = (arr) => Array.from(new Set(arr || []));

/* ----------------------------------------------------------------------------
   Coarse knowledge: symptom → suspect; suspect → controls + SKUs
---------------------------------------------------------------------------- */
const SYMPTOM_MAP = [
  { keys: ["honeydew", "sooty", "curl", "aphid"], suspect: "aphid" },
  { keys: ["stippling", "web", "mite"], suspect: "spider_mite" },
  { keys: ["holes", "cabbage", "green worm", "looper"], suspect: "cabbage_looper" },
  { keys: ["skeletonize", "cucumber", "beetle"], suspect: "cucumber_beetle" },
  { keys: ["wilting base", "sawdust", "squash", "borer"], suspect: "squash_vine_borer" },
  { keys: ["powdery", "white dust", "mildew"], suspect: "powdery_mildew" },
  { keys: ["spots lower leaves", "target", "tomato", "early blight"], suspect: "early_blight" },
  { keys: ["slug", "snail", "slime", "ragged"], suspect: "snail_slug" },
];

const CONTROL_CATALOG = {
  aphid: {
    controls: [
      "Insecticidal soap (early AM/PM)",
      "Neem oil (avoid bloom)",
      "Introduce/attract lady beetles/hoverflies (alyssum/dill)",
    ],
    supplies: [{ sku: "soap-rtu", name: "Insecticidal Soap RTU", minUnits: 1 }],
  },
  spider_mite: {
    controls: ["Water blast underside leaves", "Horticultural oil (cool hours)", "Release predatory mites (optional)"],
    supplies: [{ sku: "hort-oil", name: "Horticultural Oil", minUnits: 1 }],
  },
  cabbage_looper: {
    controls: ["Bt kurstaki on label schedule", "Row cover until heading size"],
    supplies: [
      { sku: "bt-k", name: "Bt (kurstaki)", minUnits: 1 },
      { sku: "row-cover", name: "Agribon Row Cover", minUnits: 1 },
    ],
  },
  cucumber_beetle: {
    controls: ["Yellow sticky cards", "Kaolin clay film", "Neem on adults (non-bloom)"],
    supplies: [
      { sku: "yellow-cards", name: "Sticky Cards", minUnits: 10 },
      { sku: "kaolin-clay", name: "Kaolin Clay", minUnits: 1 },
    ],
  },
  squash_vine_borer: {
    controls: ["Row cover until flowering", "SVB traps", "Inject Bt in stem (advanced)"],
    supplies: [
      { sku: "svb-trap", name: "SVB Pheromone Trap", minUnits: 1 },
      { sku: "row-cover", name: "Agribon Row Cover", minUnits: 1 },
    ],
  },
  powdery_mildew: {
    controls: ["Potassium bicarbonate spray", "Milk spray 1:10", "Sulfur (not with oil; cool temps)"],
    supplies: [{ sku: "pk-bicarb", name: "Potassium Bicarbonate", minUnits: 1 }],
  },
  early_blight: {
    controls: ["Sanitation (remove lower leaves)", "Mulch soil splash", "Copper fungicide at onset (label)"],
    supplies: [{ sku: "copper-fung", name: "Copper Fungicide", minUnits: 1 }],
  },
  snail_slug: {
    controls: ["Iron phosphate bait", "Beer traps", "Copper tape around beds"],
    supplies: [{ sku: "iron-phos", name: "Iron Phosphate Bait", minUnits: 1 }],
  },
};

/* ----------------------------------------------------------------------------
   Defaults / settings
---------------------------------------------------------------------------- */
const DEFAULTS = {
  lookaheadDays: 14,
  symptomLookbackDays: 14,
  openUIRoute: "/tier2/garden/care",
  createCalendarEvents: true,
  minSeverityForEscalation: 3,
  inventoryThresholdDefault: 1,
  recheckDays: 4,
  // Weather (optional inputs.weather[] boosts fungal risks)
  humidPctBoost: 80,        // past-3-day avg RH ≥ this → boost fungal suspects
  rainMmBoost: 10,          // past-3-day cumulative rain ≥ this → boost fungal suspects
};

/* ----------------------------------------------------------------------------
   Template
---------------------------------------------------------------------------- */
const PestDiseaseScoutTemplate = {
  id: "pest-disease-scout",
  name: "Pest & Disease Scout",
  version: "2.4.0",
  purpose: "Anticipate and catch problems early with organic-first responses.",

  triggers: ["seasonal_pest_window", "symptom_logged", "user_request", "weekly_scan_monday_0800"],

  inputs: {
    crops: "array[{ bedId, crop }]",
    regionPestData:
      "array[{ pest, crops?:string[], cropFamilies?:string[], window:{startISO,endISO}, severity?:1|2|3, notes? }]",
    plantHealthLogs:
      "array[{ dateISO, bedId?, crop?, symptoms?:string[], notes?:string, photos?:string[] }]",
    inventory: "record<sku,{ units:number, unitName?:string }>",
    extensionContacts: "array[{ region?, name, phone?, url? }]",
    // Optional: recent weather points for fungal risk boosts
    weather: "array[{ dateISO, relHumidityPct?:number, rainfallMm?:number }]",
    settings:
      "object{ lookaheadDays?, symptomLookbackDays?, openUIRoute?, createCalendarEvents?, minSeverityForEscalation?, inventoryThresholdDefault?, recheckDays?, humidPctBoost?, rainMmBoost? }",
  },

  logic: [
    "Open Garden Care UI.",
    "Scan regional pest windows within lookahead; map to user crops/families.",
    "Parse recent health logs → infer suspects via keyword heuristics.",
    "Optionally boost fungal-disease confidence using recent humidity/rain.",
    "Merge seasonal and symptom-derived alerts; dedupe by bed+crop+suspect, keep highest severity and compute confidence.",
    "Attach organic control recommendations; check inventory against minimums; emit ORDER_SUPPLIES and consolidated PROCUREMENT_SUGGEST.",
    "Create immediate care tasks and recheck events.",
    "Provide escalation recommendation to extension/pro when severity >= threshold or issue persists.",
  ],

  // Action identifiers consumed by your orchestrator/renderer
  actions: ["OPEN_UI", "ORDER_SUPPLIES", "PROCUREMENT_SUGGEST"],

  outputs: {
    gardenUpdates: "array[ {type:'pest.alert_card'|'garden.care_task', ...} ]",
    calendarEvents: "array[ {type:'care'|'warning'|'follow_up', title, date, notes?} ]",
    recommendations: "array[string]",
    logs: "array",
    actions: "array[{type, ...}]",
  },

  fallbacks: ["escalate_to_extension_service", "escalate_to_local_professional"],

  schedule: { RRULE: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0;BYSECOND=0" },

  nextRuns(now = dayjs()) {
    const base = now.day(1).hour(8).minute(0).second(0).millisecond(0);
    const t = base.isBefore(now) ? base.add(1, "week") : base;
    return [t.toISOString()];
  },

  async run(ctx = {}, services = {}) {
    const startTs = isoNow();
    const logs = [];
    const recommendations = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const actions = [];

    const now = dayjs(ctx.now || new Date());
    const crops = Array.isArray(ctx.inputs?.crops) ? ctx.inputs.crops : [];
    const regionPestData = Array.isArray(ctx.inputs?.regionPestData) ? ctx.inputs.regionPestData : [];
    const inventory = ctx.inputs?.inventory || {};
    const extensionContacts = Array.isArray(ctx.inputs?.extensionContacts) ? ctx.inputs.extensionContacts : [];
    const weather = Array.isArray(ctx.inputs?.weather) ? ctx.inputs.weather : [];

    const S = { ...DEFAULTS, ...(ctx.inputs?.settings || {}) };

    // Open GardenCareTasks UI
    actions.push({
      type: "OPEN_UI",
      route: S.openUIRoute,
      component: "GardenCareTasks",
      params: {},
    });

    // Recent logs for symptoms
    const healthLogs = (Array.isArray(ctx.inputs?.plantHealthLogs) ? ctx.inputs.plantHealthLogs : []).filter((l) =>
      dayjs(l.dateISO).isAfter(now.subtract(S.symptomLookbackDays, "day"))
    );

    /* --------------------- 1) Seasonal windows (lookahead) --------------------- */
    const upcoming = regionPestData.filter(
      (p) => dayjs(p.window?.startISO).isBefore(now.add(S.lookaheadDays, "day")) && dayjs(p.window?.endISO).isAfter(now)
    );

    /* --------------------- 2) Symptom → suspect inference --------------------- */
    const suspectsFromSymptoms = [];
    for (const log of healthLogs) {
      const found = inferSuspects(log);
      if (found.length) suspectsFromSymptoms.push({ ...log, suspects: found });
    }

    /* ------------------ 3) Optional weather-based fungal boost ----------------- */
    // Compute recent 3-day humidity/rain
    const wx3 = recentWeatherSummary(weather, now, 3);
    const fungalBoost = (wx3.avgRH >= S.humidPctBoost) || (wx3.rainSum >= S.rainMmBoost);

    /* ---------------- Merge alerts (seasonal + symptom), dedupe ---------------- */
    const alerts = [];
    // Seasonal by crop/family
    for (const window of upcoming) {
      for (const c of crops) {
        if (matchesCrop(window, c.crop)) {
          alerts.push(
            buildAlert({
              source: "seasonal_window",
              bedId: c.bedId,
              crop: c.crop,
              suspect: window.pest,
              severity: safeNum(window.severity, 2),
              window,
              notes: window.notes || null,
              confidence: 0.6, // base for seasonal
            })
          );
        }
      }
    }
    // Symptom-driven (higher confidence)
    for (const log of suspectsFromSymptoms) {
      for (const sus of log.suspects) {
        alerts.push(
          buildAlert({
            source: "symptom_log",
            bedId: log.bedId,
            crop: log.crop,
            suspect: sus,
            severity: 3,
            window: null,
            notes:
              (log.notes || "") +
              (Array.isArray(log.symptoms) && log.symptoms.length ? ` | Symptoms: ${log.symptoms.join(", ")}` : ""),
            confidence: 0.8, // symptoms > seasonal
          })
        );
      }
    }

    // Weather boost for typical fungal suspects
    if (fungalBoost) {
      for (const a of alerts) {
        if (["powdery_mildew", "early_blight"].includes(a.suspect)) {
          a.confidence = Math.min(1.0, (a.confidence || 0.6) + 0.15);
          a.severity = Math.min(3, safeNum(a.severity, 2) + 1);
          a.notes = (a.notes ? a.notes + " " : "") + "(Weather boost: humid/rainy conditions)";
        }
      }
    }

    // Deduplicate by bedId|crop|suspect (keep highest severity, then highest confidence)
    const key = (a) => `${a.bedId || "n/a"}|${a.crop || "n/a"}|${a.suspect}`;
    const byKey = new Map();
    for (const a of alerts) {
      const k = key(a);
      const prev = byKey.get(k);
      if (
        !prev ||
        a.severity > prev.severity ||
        (a.severity === prev.severity && (a.confidence || 0) > (prev.confidence || 0))
      ) byKey.set(k, a);
    }
    const deduped = Array.from(byKey.values());

    /* ----------------- 4) Controls, supplies, tasks, follow-ups ---------------- */
    // Track consolidated procurement suggestions
    const procurementDemand = new Map(); // sku -> {name, needed}

    for (const a of deduped) {
      const catalog = CONTROL_CATALOG[a.suspect] || { controls: ["Hand removal / sanitation"], supplies: [] };

      // Calendar event for immediate care
      if (S.createCalendarEvents) {
        calendarEvents.push({
          type: a.severity >= 3 ? "warning" : "care",
          title: `${title(a.suspect.replace(/_/g, " "))} — ${a.crop}${a.bedId ? " (" + a.bedId + ")" : ""}`,
          date: isoNow(),
          notes:
            (a.source === "seasonal_window" ? "Seasonal risk window active. " : "Symptoms reported. ") +
            `Suggested controls: ${catalog.controls.join("; ")}`,
        });
      }

      // Inventory checks → order actions when low + accumulate procurement
      for (const s of catalog.supplies || []) {
        const have = safeNum(inventory[s.sku]?.units, 0);
        const min = safeNum(s.minUnits, S.inventoryThresholdDefault);
        if (have < min) {
          const need = Math.max(1, min - have);
          // Individual order (back-compat)
          actions.push({
            type: "ORDER_SUPPLIES",
            sku: s.sku,
            name: s.name,
            qty: need,
            reason: `Pest & Disease Scout: ${a.suspect}`,
          });
          // Consolidated suggestion for the procurement planner
          const prev = procurementDemand.get(s.sku) || { name: s.name, qty: 0 };
          prev.qty += need;
          procurementDemand.set(s.sku, prev);
        }
      }

      // UI alert card
      gardenUpdates.push({
        type: "pest.alert_card",
        bedId: a.bedId,
        crop: a.crop,
        suspect: a.suspect,
        severity: a.severity,
        whenISO: isoNow(),
        controls: catalog.controls,
        suppliesHint: (catalog.supplies || []).map((x) => ({ sku: x.sku, name: x.name })),
        source: a.source,
        window: a.window || undefined,
        notes: a.notes || undefined,
        confidence: a.confidence || 0.6,
      });

      // Care task
      gardenUpdates.push({
        type: "garden.care_task",
        bedId: a.bedId,
        crop: a.crop,
        title: `Scout/Control — ${title(a.suspect.replace(/_/g, " "))}`,
        dateISO: isoNow(),
        checklist: [
          "Scout 5 random plants; record presence count.",
          ...catalog.controls.slice(0, 2).map((c) => `If threshold met: ${c}`),
          "Recheck in 3–5 days; note efficacy.",
        ],
      });

      // Follow-up
      calendarEvents.push({
        type: "follow_up",
        title: `Recheck ${title(a.suspect.replace(/_/g, " "))} — ${a.crop}`,
        date: dayjs().add(safeNum(S.recheckDays, 4), "day").toISOString(),
        notes: "Evaluate control efficacy; escalate if still high.",
      });

      // Escalation hint
      if (a.severity >= S.minSeverityForEscalation) {
        const ext = extensionContacts[0];
        recommendations.push(
          ext
            ? `If issue persists, contact ${ext.name}${ext.phone ? " (" + ext.phone + ")" : ext.url ? " (" + ext.url + ")" : ""}`
            : `If issue persists, consult local extension/professional.`
        );
      }
    }

    // Emit a single consolidated procurement suggestion so your procurementScheduler can pick it up
    if (procurementDemand.size) {
      actions.push({
        type: "PROCUREMENT_SUGGEST",
        payload: {
          demand: Array.from(procurementDemand.entries()).map(([sku, v]) => ({
            name: v.name,
            sku,
            qty: v.qty,
            unit: "unit",
            priority: "essential",
            tags: ["garden", "pest_control"],
          })),
          reason: "pest_disease_scout_supplies",
        },
      });
    }

    // Summary & UI reopen with initial alerts
    const summary = deduped.length
      ? `Generated ${deduped.length} pest/disease alert(s).`
      : "No alerts — no seasonal risks in lookahead and no concerning symptoms logged.";

    actions.push({
      type: "OPEN_UI",
      route: S.openUIRoute,
      component: "GardenCareTasks",
      params: { initialAlerts: deduped },
    });

    services?.logger?.info?.(`[${this.id}] ${summary}`);

    return {
      ok: true,
      timestamp: startTs,
      summary,
      recommendations,
      calendarEvents,
      gardenUpdates,
      logs,
      actions,
    };
  },
};

export default PestDiseaseScoutTemplate;

/* =========================
   Internal helper functions
   ========================= */

function inferSuspects(log) {
  const text = [...(log.symptoms || []), log.notes || ""].join(" ").toLowerCase();
  const suspects = [];
  for (const row of SYMPTOM_MAP) {
    if (row.keys.some((k) => text.includes(k))) suspects.push(row.suspect);
  }
  return uniq(suspects);
}

function matchesCrop(window, cropName) {
  if (!window) return false;
  const lc = (cropName || "").toLowerCase();
  const list = (window.crops || []).map((c) => (c || "").toLowerCase());
  const famList = (window.cropFamilies || []).map((f) => (f || "").toLowerCase());
  return list.includes(lc) || famList.some((f) => cropFamilyMatch(f, lc));
}

function cropFamilyMatch(familyLc, cropLc) {
  // very coarse mapping
  const MAP = {
    solanaceae: ["tomato", "pepper", "eggplant", "potato"],
    brassicaceae: ["cabbage", "broccoli", "kale", "radish", "mustard"],
    cucurbitaceae: ["cucumber", "squash", "melon", "pumpkin", "zucchini"],
    fabaceae: ["bean", "pea"],
    apiaceae: ["carrot", "celery", "dill", "parsley"],
    asteraceae: ["lettuce", "sunflower", "marigold"],
    alliaceae: ["onion", "leek", "garlic", "chive"],
  };
  const crops = MAP[familyLc] || [];
  return crops.includes(cropLc);
}

function buildAlert({ source, bedId, crop, suspect, severity = 2, window = null, notes = null, confidence = 0.6 }) {
  return { source, bedId, crop, suspect, severity, window, notes, confidence };
}

function recentWeatherSummary(weather = [], now = dayjs(), days = 3) {
  const start = now.subtract(days, "day");
  const recent = weather.filter((w) => dayjs(w.dateISO).isAfter(start));
  if (!recent.length) return { avgRH: 0, rainSum: 0 };
  const avgRH =
    recent.reduce((a, b) => a + (Number.isFinite(b.relHumidityPct) ? b.relHumidityPct : 0), 0) / recent.length;
  const rainSum = recent.reduce((a, b) => a + (Number.isFinite(b.rainfallMm) ? b.rainfallMm : 0), 0);
  return { avgRH, rainSum };
}

/* ----------------------------------------------------------------------------
USAGE

import tpl from "@/services/templates/garden/PestDiseaseScout.template";

const res = await tpl.run({
  now: new Date(),
  inputs: {
    crops: [{ bedId: "B1", crop: "Tomato" }, { bedId: "B2", crop: "Broccoli" }],
    regionPestData: [
      { pest: "early_blight", crops: ["Tomato"], window: { startISO: "2025-04-15", endISO: "2025-07-30" }, severity: 2 },
      { pest: "cabbage_looper", crops: ["Broccoli", "Cabbage"], window: { startISO: "2025-04-01", endISO: "2025-09-01" }, severity: 2 },
    ],
    plantHealthLogs: [{ dateISO: "2025-05-10", bedId: "B2", crop: "Broccoli", symptoms: ["green worm holes", "frass"] }],
    inventory: { "bt-k": { units: 0 }, "row-cover": { units: 1 } },
    extensionContacts: [{ region: "TX", name: "County Extension", phone: "555-123-4567", url: "https://extension.example" }],
    weather: [
      { dateISO:"2025-05-08", relHumidityPct: 84, rainfallMm: 6 },
      { dateISO:"2025-05-09", relHumidityPct: 86, rainfallMm: 5 },
      { dateISO:"2025-05-10", relHumidityPct: 88, rainfallMm: 3 }
    ],
    settings: {
      // optional overrides
      // lookaheadDays: 21,
      // minSeverityForEscalation: 3,
    },
  },
});
---------------------------------------------------------------------------- */

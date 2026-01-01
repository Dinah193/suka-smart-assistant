// C:\Users\larho\suka-smart-assistant\src\services\templates\animal\DailyFeedRotation.template.js

/**
 * Daily Feed Rotation (AM/PM) — standardized template (dynamic v2.3)
 *
 * New in 2.3:
 *  • Primary→fallback→blend logic (uses both SKUs when needed)
 *  • Auto restock procurement hints with lead-time friendly dates
 *  • Sabbath/quiet-hours notes on alerts
 *  • Rotation persistence via services.storage with per-species keys
 *  • Optional water/supplement usage metrics for dashboards
 *  • Clear anomalies (zero headcount, missing ration, missing SKU)
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const keyOf = (s) => String(s || "").toLowerCase().replace(/\s+/g, "_");
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ----------------------------------------------------------------------------
   Defaults (override via inputs.settings)
---------------------------------------------------------------------------- */
const DEFAULTS = {
  times: ["06:00", "17:00"],
  rotatePolicy: "sequential",
  minDaysLeftAlert: 3,
  fallbackMixKey: "alternate",
  openUIChecklistRoute: "/tier2/animals/care",
  sabbathAware: true,
  quietHours: { start: "22:00", end: "07:00" },
  // Optional heuristics for metrics (coarse, safe to ignore)
  metrics: {
    waterLitersPerHeadAM: 0.12,
    waterLitersPerHeadPM: 0.10,
    gritPerHeadGrams: 2,
  },
  // When days-left drops under this, create a procurement request
  autoProcureBelowDays: 2,
};

/* ----------------------------------------------------------------------------
   Template
---------------------------------------------------------------------------- */
const DailyFeedRotationTemplate = {
  id: "daily-feed-rotation",
  name: "Daily Feed Rotation (AM/PM)",
  version: "2.3.0",
  purpose:
    "Rotate feed stations, check water, and note refusals while tracking feed usage and triggering timely restocks.",

  triggers: ["daily_am", "daily_pm", "user_request"],

  inputs: {
    species:
      "array[{ name:string, headcount:number, stations?:string[], waterSources?:string[], rationKey:string, notes?:string }]",
    rations:
      "record<rationKey, { primaryFeedSku:string, fallbackFeedSku?:string, gramsPerHeadAM:number, gramsPerHeadPM:number }>",
    inventory:
      "record<sku, { remainingGrams:number }>",
    settings:
      "object{ times?:string[], rotatePolicy?:'sequential', minDaysLeftAlert?:number, fallbackMixKey?:string, openUIChecklistRoute?:string, sabbathAware?:boolean, quietHours?:{start,end}, metrics?:object, autoProcureBelowDays?:number }",
  },

  logic: [
    "Open AnimalCareChecklist UI for current slot (AM/PM).",
    "For each species group: rotate station (sequential), compute grams needed for the slot.",
    "Consume primary; if short, pull from fallback; if still short, blend available amounts and log partial.",
    "Decrement inventory; estimate days-of-feed-left; emit warnings + procurement hints under thresholds.",
    "Log water checks and periodic sanitation nudges based on rotation index.",
    "Emit Sabbath/quiet-hours notes for alerts and dashboards.",
  ],

  actions: ["OPEN_UI", "INVENTORY_DECREMENT", "ALERT", "PROCUREMENT_REQUEST", "SCHEDULE_ALERTS"],

  outputs: {
    gardenUpdates:
      "array[ {type:'animal.feed_log', species, slot:'AM'|'PM', station, headcount, feedSkuUsed, gramsUsed, fallbackUsed, blend?:{primary:number,fallback:number}, waterCheck, timestamp} ]",
    calendarEvents:
      "array[ {type:'warning'|'care', title, date, notes?} ]",
    recommendations: "array[string]",
    logs: "array",
    actions: "array[{type, ...}]",
    // bonus (non-breaking): simple analytics for dashboards
    metrics: "object{ totalGramsUsed:number, totalHeads:number, waterLitersEstimated:number }",
    anomalies: "array[string]",
  },

  fallbacks: ["use_fallback_mix", "partial_portion_with_alert", "immediate_restock"],

  schedule: {
    am: { RRULE: "FREQ=DAILY;BYHOUR=6;BYMINUTE=0;BYSECOND=0" },
    pm: { RRULE: "FREQ=DAILY;BYHOUR=17;BYMINUTE=0;BYSECOND=0" },
  },

  nextRuns(now = dayjs(), settings = {}) {
    const times = settings.times || DEFAULTS.times;
    const out = [];
    for (const t of times) {
      const [hh, mm] = t.split(":").map((n) => parseInt(n, 10));
      let at = now.hour(hh).minute(mm).second(0).millisecond(0);
      if (at.isBefore(now)) at = at.add(1, "day");
      out.push(at.toISOString());
    }
    return out.sort();
  },

  async run(ctx = {}, services = {}) {
    const startTs = isoNow();
    const logs = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const recommendations = [];
    const actions = [];
    const anomalies = [];

    const now = dayjs(ctx.now || new Date());
    const isAM = now.hour() < 12;
    const slot = isAM ? "AM" : "PM";

    const inputs = ctx.inputs || {};
    const species = Array.isArray(inputs.species) ? inputs.species : [];
    const rations = inputs.rations || {};
    const inventory = inputs.inventory || {};
    const settings = { ...DEFAULTS, ...(inputs.settings || {}) };

    // Sabbath/quiet-hours helper (notes only; actual deferral handled by alerts service)
    const sabNote = () => {
      if (!settings.sabbathAware) return null;
      const dow = now.day();
      if (dow === 5) return "Sabbath-aware: finish active chores before Friday sunset.";
      if (dow === 6) return "Sabbath-aware: minimize active chores during Saturday; prefer quick checks.";
      return null;
    };
    const quietNote = () => {
      const d = new Date(now.toISOString());
      const [sh, sm] = (settings.quietHours?.start || "22:00").split(":").map(Number);
      const [eh, em] = (settings.quietHours?.end || "07:00").split(":").map(Number);
      const s = new Date(d); s.setHours(sh, sm || 0, 0, 0);
      const e = new Date(d); e.setHours(eh, em || 0, 0, 0);
      const inQuiet = s <= e ? (d >= s && d <= e) : (d >= s || d <= e);
      return inQuiet ? `Quiet-hours aware: alerts may be deferred (${settings.quietHours.start}-${settings.quietHours.end}).` : null;
    };

    // Open checklist UI
    actions.push({
      type: "OPEN_UI",
      route: settings.openUIChecklistRoute,
      component: "AnimalCareChecklist",
      params: { slot },
    });

    // Aggregate metrics
    let totalGramsUsed = 0;
    let totalHeads = 0;
    let waterLitersEstimated = 0;

    // Rotation key helper
    const rotateKey = (spName) => `feed.rotate.${keyOf(spName)}`;

    for (const sp of species) {
      const spName = sp.name || "Unknown";
      const headcount = safeNum(sp.headcount, 0);
      if (headcount <= 0) {
        anomalies.push(`${spName}: headcount is zero; skipping.`);
        continue;
      }
      totalHeads += headcount;

      const ration = rations[sp.rationKey] || null;
      if (!ration) {
        anomalies.push(`${spName}: missing ration "${sp.rationKey}".`);
        continue;
      }

      // Rotation index (persisted if storage available)
      let idx = 0;
      if (services?.storage?.get) {
        try {
          const prev = await services.storage.get(rotateKey(spName));
          if (Number.isInteger(prev)) idx = prev;
        } catch (_e) {}
      }
      const stations = Array.isArray(sp.stations) ? sp.stations : [];
      const chosenStation =
        stations.length === 0 ? "Unassigned Station" : stations[idx % stations.length];

      if (services?.storage?.set && stations.length > 0) {
        try {
          const nextIdx = (idx + 1) % stations.length;
          await services.storage.set(rotateKey(spName), nextIdx);
        } catch (_e) {}
      }

      // Slot grams needed
      const gramsPerHead = safeNum(isAM ? ration.gramsPerHeadAM : ration.gramsPerHeadPM, 0);
      const totalGramsNeeded = headcount * gramsPerHead;

      // Inventory draw: primary → fallback → blend
      const primarySku = ration.primaryFeedSku;
      const fallbackSku = ration.fallbackFeedSku || (primarySku ? `${primarySku}:${settings.fallbackMixKey}` : null);

      const primaryRemaining = safeNum(inventory[primarySku]?.remainingGrams, 0);
      const fallbackRemaining = fallbackSku ? safeNum(inventory[fallbackSku]?.remainingGrams, 0) : 0;

      let usedPrimary = 0;
      let usedFallback = 0;
      let useSku = primarySku;
      let fallbackUsed = false;

      if (!primarySku) {
        anomalies.push(`${spName}: no primaryFeedSku for ration "${sp.rationKey}".`);
        continue;
      }

      if (primaryRemaining >= totalGramsNeeded) {
        usedPrimary = totalGramsNeeded;
      } else {
        // take what's left from primary
        usedPrimary = primaryRemaining;
        const stillNeed = Math.max(0, totalGramsNeeded - usedPrimary);
        if (stillNeed > 0) {
          if (fallbackSku && fallbackRemaining > 0) {
            usedFallback = Math.min(stillNeed, fallbackRemaining);
            fallbackUsed = usedFallback > 0;
          }
        }
      }

      const usedGrams = usedPrimary + usedFallback;
      totalGramsUsed += usedGrams;

      // Decrement inventory (primary, then fallback if used)
      if (usedPrimary > 0) {
        actions.push({
          type: "INVENTORY_DECREMENT",
          sku: primarySku,
          amountGrams: usedPrimary,
          reason: `Feeding ${spName} ${slot}`,
        });
      }
      if (usedFallback > 0) {
        actions.push({
          type: "INVENTORY_DECREMENT",
          sku: fallbackSku,
          amountGrams: usedFallback,
          reason: `Fallback feeding ${spName} ${slot}`,
        });
      }

      // Recommendations if partial or none
      if (usedGrams < totalGramsNeeded) {
        const combined = primaryRemaining + fallbackRemaining;
        if (combined > 0) {
          recommendations.push(
            `${spName}: delivered partial portion for ${slot} (${usedGrams}/${totalGramsNeeded}g).`
          );
        } else {
          recommendations.push(`${spName}: NO feed available for ${slot}. Trigger immediate restock!`);
        }
      }
      if (fallbackUsed) {
        recommendations.push(
          `${spName}: primary feed low (had ${primaryRemaining}g). Used fallback ${fallbackSku} for ${slot}.`
        );
      }

      // Days-of-feed-left (based on PRIMARY daily usage)
      const dailyGrams =
        headcount *
        (safeNum(ration.gramsPerHeadAM, 0) + safeNum(ration.gramsPerHeadPM, 0));
      const daysLeft =
        dailyGrams > 0 ? Math.floor(primaryRemaining / dailyGrams) : null;

      if (daysLeft !== null && daysLeft < settings.minDaysLeftAlert) {
        const reminderText = `${spName} primary feed ${primarySku}: ~${daysLeft} day(s) left. Reorder now.`;
        actions.push({ type: "ALERT", level: "warning", message: reminderText });
        calendarEvents.push({
          type: "warning",
          title: `Restock: ${primarySku}`,
          date: isoNow(),
          notes: [reminderText, sabNote(), quietNote()].filter(Boolean).join(" • "),
        });
      }

      // Auto-procurement hint when very low
      if (daysLeft !== null && daysLeft <= settings.autoProcureBelowDays) {
        // Aim to cover 10 days as a coarse default order size
        const targetDays = 10;
        const needGrams = Math.max(0, targetDays * dailyGrams - primaryRemaining);
        if (needGrams > 0) {
          actions.push({
            type: "PROCUREMENT_REQUEST",
            payload: {
              demand: [
                {
                  name: primarySku,
                  qty: Math.ceil(needGrams),
                  unit: "g",
                  needBy: now.add(1, "day").toISOString(),
                  priority: "essential",
                  tags: ["feed", keyOf(spName)],
                },
              ],
              links: { species: spName, slot },
            },
          });
        }
      }

      const waterNotes =
        (sp.waterSources || []).length > 0
          ? `Check/clean: ${sp.waterSources.join(", ")}`
          : "Verify water access & flow";

      // Approximate water usage metric (optional)
      const waterPerHead =
        safeNum(settings.metrics?.[isAM ? "waterLitersPerHeadAM" : "waterLitersPerHeadPM"], 0);
      waterLitersEstimated += +(headcount * waterPerHead).toFixed(2);

      // Emit feed log update
      gardenUpdates.push({
        type: "animal.feed_log",
        species: spName,
        slot,
        station: chosenStation,
        headcount,
        feedSkuUsed: usedFallback > 0 && usedPrimary === 0 ? (fallbackSku || primarySku) : primarySku,
        gramsUsed: usedGrams,
        fallbackUsed,
        blend: usedFallback > 0 ? { primary: usedPrimary, fallback: usedFallback } : undefined,
        waterCheck: waterNotes,
        timestamp: isoNow(),
        notes: sp.notes || undefined,
      });

      // Periodic sanitation suggestion (every 3 rotations on a given station index)
      if (idx % 3 === 0 && stations.length > 0) {
        recommendations.push(`${spName}: sanitize ${chosenStation} feeder today to reduce pest build-up.`);
      }
    }

    // Optional daily alert summary (friendly nudge)
    actions.push({
      type: "SCHEDULE_ALERTS",
      payload: {
        session: {
          type: "animal",
          title: `Feed rotation ${slot} summary`,
          tasks: ["Review refusals", "Top off water", "Log anomalies"],
          startTime: now.add(5, "minute").toISOString(),
          notifyUsers: ctx.notifyUsers || [],
          sabbathAware: settings.sabbathAware,
        },
        options: { leadMinutes: 0, extraLeadMinutes: [], quietHours: settings.quietHours },
      },
    });

    const summary = `Daily Feed Rotation ${slot}: processed ${species.length} species group(s).`;

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
      anomalies,
      metrics: {
        totalGramsUsed: Math.round(totalGramsUsed),
        totalHeads,
        waterLitersEstimated: +waterLitersEstimated.toFixed(2),
      },
    };
  },
};

export default DailyFeedRotationTemplate;

/* ----------------------------------------------------------------------------
USAGE

1) Place file at:
   src/services/templates/animal/DailyFeedRotation.template.js

2) Registrar bootstrap:
   import engine from '@/services/automation/engine';
   import feedRotation from '@/services/templates/animal/DailyFeedRotation.template';
   engine.register(feedRotation.id, feedRotation);

3) Example payload:

const inputs = {
  species: [
    { name:'Broilers', headcount:25, stations:['N1','N2','N3'], waterSources:['Nipple Line A'], rationKey:'broiler' },
    { name:'Layers', headcount:18, stations:['L1','L2'], waterSources:['Bell Drinker'], rationKey:'layer' },
  ],
  rations: {
    broiler: { primaryFeedSku:'broiler-18%', fallbackFeedSku:'scratch-mix', gramsPerHeadAM:80, gramsPerHeadPM:100 },
    layer:   { primaryFeedSku:'layer-16%',  gramsPerHeadAM:70, gramsPerHeadPM:80 },
  },
  inventory: {
    'broiler-18%': { remainingGrams: 6000 },
    'scratch-mix': { remainingGrams: 3000 },
    'layer-16%':   { remainingGrams: 4000 },
  },
  settings: { times:['06:00','17:00'], minDaysLeftAlert:3, autoProcureBelowDays:2 }
};

import feedRotation from '@/services/templates/animal/DailyFeedRotation.template';
const res = await feedRotation.run({ now:new Date(), inputs, notifyUsers:[{name:'Larho', email:'you@example.com', preference:'email'}] });

---------------------------------------------------------------------------- */

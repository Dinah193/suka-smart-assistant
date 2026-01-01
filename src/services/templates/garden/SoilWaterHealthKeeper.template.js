// src/services/templates/garden/SoilWaterHealthKeeper.template.js

/**
 * Soil & Water Health Keeper — standardized template contract
 *
 * Contract fields:
 * - id, name, version, purpose
 * - triggers[]: machine-readable event keys
 * - inputs: schema-ish description for UI/validators
 * - logic[]: human-readable steps
 * - actions[]: identifiers your orchestrator understands
 * - outputs: shape description of returned data
 * - fallbacks[]: graceful options in drought/constraints
 * - schedule: RRULE hints for auto-scheduling
 * - nextRuns(now): compute upcoming run times (ISO)
 * - run(ctx, services): execute → { ok, summary, gardenUpdates, calendarEvents, actions, ... }
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const round = (n, d = 1) => Math.round(n * 10 ** d) / 10 ** d;
const title = (s) => (s || "").replace(/\b\w/g, (m) => m.toUpperCase());
const uniq = (arr) => Array.from(new Set(arr || []));

/* ----------------------------------------------------------------------------
   Defaults
---------------------------------------------------------------------------- */
const DEFAULTS = {
  rainSkipThresholdMm: 6,
  allowableDepletionPct: 40, // reserved for future soil-water balance
  targetMoistureVWCRange: {
    sand: [8, 14],
    sandy_loam: [10, 18],
    loam: [14, 25],
    loam_clay: [18, 30],
    clay: [20, 32],
    default: [12, 24],
  },
  reTestIntervalDays: 60,
  openIrrigationUIRoute: "/tier2/garden/irrigation",
  organicOnly: true,
  notifyOnSkips: true,
  notifyOnLowInventory: true,
  minSensorCountPerBed: 1, // flag low data confidence
};

/* ----------------------------------------------------------------------------
   The standardized template object
---------------------------------------------------------------------------- */
const SoilWaterHealthKeeperTemplate = {
  id: "soil-water-health-keeper",
  name: "Soil & Water Health Keeper",
  version: "2.1.0",
  purpose:
    "Keep soil fertile and moisture balanced via timely amendments, irrigation tuning, and drought-aware care.",

  // Machine-readable triggers your orchestrator can subscribe to
  triggers: [
    "rain_event",
    "irrigation_cycle",
    "soil_test_due",
    "user_request",
    "daily_scan_0630",
    "weekly_scan_monday",
  ],

  // Minimal schema-style hints (for UI + validators)
  inputs: {
    beds: "array[{ bedId, areaM2?, soil?:{ texture?, ph?, cec?, omPct? }, crop?, rootDepthCm? }]",
    moistureLogs:
      "array[{ timestamp, bedId, vwcPct:number, tensionKPa?, source:'sensor'|'manual' }]",
    soilTests:
      "array[{ date, bedId, ph:number, omPct?, nPpm?, pPpm?, kPpm?, cec?, salinityDsPerM? }]",
    weather: "array[{ date, rainMm:number, etoMm?, tMaxC?, tMinC? }]",
    irrigationPrograms:
      "array[{ zoneId, bedIds:string[], method:'drip'|'soaker'|'sprinkler', minutes:number, notes? }]",
    inventory: "record<skuOrNameLower, number>",
    settings:
      "object{ rainSkipThresholdMm?, allowableDepletionPct?, targetMoistureVWCRange?, reTestIntervalDays?, openIrrigationUIRoute?, organicOnly?, notifyOnSkips?, notifyOnLowInventory?, minSensorCountPerBed? }",
  },

  // Human-readable logic ladder
  logic: [
    "Open irrigation UI and present a visible draft of proposed changes.",
    "Compute rain in last/next 24h; detect hot/ET conditions and drought patterns.",
    "Build rolling 3-day average VWC per bed + confidence signal (sensor count & recency).",
    "Per irrigation zone: rain-skip if threshold met; else modulate minutes (wet −30%, dry +25%/+50% if hot, ET +10%).",
    "Append water logs and program updates; create calendar items (run/skip).",
    "For each bed with a recent soil test: compute coarse amendment plan (pH + NPK), preferring organic sources if enabled, create calendar tasks and inventory actions.",
    "Identify beds due for re-test; schedule follow-ups.",
    "If droughty (low rain vs ET): recommend mulch/water-saving routine and add tasks.",
  ],

  // Action identifiers consumed by your orchestrator/renderer
  actions: [
    "OPEN_UI",
    "ORDER_SUPPLIES",
    "INVENTORY_RESERVE",
    "CREATE_TASK",
    "NOTIFY",
    "PATCH_IRRIGATION_PROGRAM",
  ],

  // Output shape
  outputs: {
    gardenUpdates:
      "array[ {type:'irrigation.program_update'|'water.log'|'soil.amendment_plan'|'soil.report'|'sensor.health', ...} ]",
    calendarEvents:
      "array[ {type:'care'|'amend'|'rain_skip'|'follow_up'|'test', title, date, notes?} ]",
    recommendations: "array[string]",
    logs: "array",
    actions: "array[{type, ...}]",
    draft: "object{ zoneTweaks, soilPlans, drought, notes }",
  },

  // Fallbacks for constraints
  fallbacks: ["mulch_water_saver", "defer_amendments_until_stocked"],

  // Scheduling hints
  schedule: {
    daily: { RRULE: "FREQ=DAILY;BYHOUR=6;BYMINUTE=30;BYSECOND=0" },
    weekly: { RRULE: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=7;BYMINUTE=0;BYSECOND=0" },
  },

  // Compute upcoming run times (ISO strings)
  nextRuns(now = dayjs()) {
    const base = now.add(1, "day").hour(6).minute(30).second(0).millisecond(0);
    return [base.toISOString()];
  },

  // Execute template
  async run(ctx = {}, services = {}) {
    const startTs = isoNow();
    const logs = [];
    const recommendations = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const actions = [];

    const now = dayjs(ctx.now || new Date());
    const inputs = ctx.inputs || {};
    const beds = inputs.beds || [];
    const moistureLogs = inputs.moistureLogs || [];
    const soilTests = inputs.soilTests || [];
    const weather = inputs.weather || [];
    const programs = inputs.irrigationPrograms || [];
    const inventory = inputs.inventory || {};
    const S = {
      ...DEFAULTS,
      ...(inputs.settings || {}),
      targetMoistureVWCRange: {
        ...DEFAULTS.targetMoistureVWCRange,
        ...(inputs.settings?.targetMoistureVWCRange || {}),
      },
    };

    /* ---------------- UI priming: visible draft ---------------- */
    actions.push({
      type: "OPEN_UI",
      route: S.openIrrigationUIRoute,
      component: "IrrigationSchedule",
      params: { mode: "draft" },
    });

    /* ---------------- Rain/ET & VWC prep ---------------- */
    const rainTodayMm = sumBy(weather.filter((w) => dayjs(w.date).isSame(now, "day")), "rainMm");
    const rainNext24Mm = sumBy(
      weather.filter((w) => {
        const d = dayjs(w.date);
        return d.isAfter(now) && d.isBefore(now.add(1, "day"));
      }),
      "rainMm"
    );
    const etoToday = avgBy(weather.filter((w) => dayjs(w.date).isSame(now, "day")), "etoMm");
    const hotSpell = avgBy(weather.slice(-3), "tMaxC") >= 33;

    const vwcByBed = rollingVWC(moistureLogs, 3, S.minSensorCountPerBed);
    const sensorHealth = sensorHealthReport(moistureLogs, beds, S.minSensorCountPerBed);
    if (sensorHealth.warnings.length) {
      gardenUpdates.push({
        type: "sensor.health",
        createdISO: isoNow(),
        warnings: sensorHealth.warnings,
      });
      recommendations.push(
        ...sensorHealth.warnings.map((w) => `Sensor check: ${w.bedId} — ${w.reason}`)
      );
      actions.push(
        ...sensorHealth.warnings.map((w) => ({
          type: "CREATE_TASK",
          title: `Check moisture sensor — ${w.bedId}`,
          dueISO: dayjs().add(1, "day").toISOString(),
          notes: w.reason,
          tags: ["garden", "sensors"],
        }))
      );
    }

    /* ---------------- Irrigation tweaks per zone ---------------- */
    const zoneTweaks = [];
    for (const prog of programs) {
      const bedStates = (prog.bedIds || []).map((bid) => ({
        bedId: bid,
        vwc: vwcByBed[bid]?.avgVWC ?? null,
        texture: bedTexture(beds, bid),
        confidence: vwcByBed[bid]?.confidence ?? "low",
      }));

      const anyWet = bedStates.some((bs) =>
        isWet(bs.vwc, bs.texture, S.targetMoistureVWCRange)
      );
      const anyDry = bedStates.some((bs) =>
        isDry(bs.vwc, bs.texture, S.targetMoistureVWCRange)
      );
      const lowConfidence = bedStates.some((bs) => (bs.confidence || "low") === "low");

      let minutes = safeNum(prog.minutes, 0);
      const reason = [];

      // Rain skip
      if (rainTodayMm + rainNext24Mm >= S.rainSkipThresholdMm) {
        reason.push(`Rain-skip (≥${S.rainSkipThresholdMm} mm in 24h)`);
        minutes = 0;
      } else {
        if (anyWet && !anyDry) {
          minutes = round(minutes * 0.7, 1);
          reason.push("Wet readings → -30%");
        } else if (anyDry && !anyWet) {
          minutes = round(minutes * (hotSpell ? 1.5 : 1.25), 1);
          reason.push(hotSpell ? "Dry & hot → +50%" : "Dry → +25%");
        }
        if (etoToday && etoToday > 5) {
          minutes = round(minutes * 1.1, 1);
          reason.push("High ET₀ → +10%");
        }
      }

      if (lowConfidence) reason.push("Low sensor confidence — conservative adjustment applied");

      const tweak = {
        zoneId: prog.zoneId,
        newMinutes: minutes,
        reason: reason.join("; ") || "No change",
        method: prog.method,
        confidence: lowConfidence ? "low" : "normal",
        affectedBeds: bedStates,
      };
      zoneTweaks.push(tweak);

      // Draft update (PATCH action for orchestrator; UI will show 'Apply')
      actions.push({
        type: "PATCH_IRRIGATION_PROGRAM",
        zoneId: prog.zoneId,
        minutes,
        notes: tweak.reason,
        draft: true,
      });

      // Calendar & logs (still as draft-visible items)
      calendarEvents.push({
        type: minutes === 0 ? "rain_skip" : "care",
        title:
          minutes === 0
            ? `Rain-skip — Zone ${prog.zoneId}`
            : `Irrigate Zone ${prog.zoneId} (${minutes} min)`,
        date: isoNow(),
        notes: tweak.reason,
      });

      gardenUpdates.push({
        type: "irrigation.program_update",
        zoneId: prog.zoneId,
        bedIds: prog.bedIds,
        method: prog.method,
        minutes: minutes,
        notes: tweak.reason,
        draft: true,
      });

      gardenUpdates.push({
        type: "water.log",
        zoneId: prog.zoneId,
        dateISO: isoNow(),
        rainMm: round(rainTodayMm, 1),
        etoMm: etoToday || null,
        runtimeMinutes: minutes,
        draft: true,
      });

      if (S.notifyOnSkips && minutes === 0) {
        actions.push({
          type: "NOTIFY",
          channel: "inbox",
          title: `Zone ${prog.zoneId} rain-skip`,
          body: `Skipping irrigation due to forecast/observed rain. Reason: ${tweak.reason}`,
          tags: ["garden", "irrigation"],
        });
      }
    }

    /* ---------------- Soil tests → amendment scheduling ---------------- */
    const soilReports = [];
    const soilPlans = [];

    for (const bed of beds) {
      const st = latestTestForBed(soilTests, bed.bedId);
      if (!st) continue;

      const plan = recommendAmendments(st, {
        organicOnly: S.organicOnly,
      });

      soilReports.push({
        bedId: bed.bedId,
        ph: st.ph,
        nutrients: {
          nPpm: st.nPpm,
          pPpm: st.pPpm,
          kPpm: st.kPpm,
          cec: st.cec,
          omPct: st.omPct,
        },
        recommendations: plan.recommendations,
        testDate: st.date,
      });

      if (plan.amendments.length) {
        const applyDate = dayjs().add(2, "day").toISOString();

        const planObj = {
          bedId: bed.bedId,
          amendments: plan.amendments,
          reTestDateISO: dayjs(st.date || now).add(S.reTestIntervalDays, "day").toISOString(),
          draft: true,
        };
        soilPlans.push(planObj);

        gardenUpdates.push({
          type: "soil.amendment_plan",
          ...planObj,
        });

        calendarEvents.push({
          type: "amend",
          title: `Apply amendments — ${bed.bedId}`,
          date: applyDate,
          notes: plan.amendments
            .map((a) => `${a.name} ${a.rateKgPerM2} kg/m²`)
            .join("; "),
        });

        // Inventory checks → reserve/order
        for (const a of plan.amendments) {
          const key = (a.sku || a.name?.toLowerCase()) ?? "";
          const have = safeNum(inventory[key] ?? inventory[a.name?.toLowerCase()], 0);
          const needKg = round(a.rateKgPerM2 * safeNum(bed.areaM2, 1), 2);

          if (have > 0) {
            const reserveQty = clamp(needKg, 0, have);
            if (reserveQty > 0) {
              actions.push({
                type: "INVENTORY_RESERVE",
                sku: key || a.name.toLowerCase().replace(/\s+/g, "-"),
                name: title(a.name),
                qty: reserveQty,
                unit: "kg",
                reason: `Upcoming amendment for ${bed.bedId}`,
              });
            }
          }

          if (have < needKg) {
            const orderQty = round(needKg - have, 2);
            actions.push({
              type: "ORDER_SUPPLIES",
              sku: key || a.name.toLowerCase().replace(/\s+/g, "-"),
              name: title(a.name),
              qty: orderQty,
              unit: "kg",
              reason: `Amendment for ${bed.bedId}`,
            });

            if (S.notifyOnLowInventory) {
              actions.push({
                type: "NOTIFY",
                channel: "inbox",
                title: `Low inventory: ${title(a.name)}`,
                body: `Need ${orderQty} kg for ${bed.bedId}. Current stock: ${have} kg.`,
                tags: ["garden", "inventory"],
              });
            }
          }
        }
      }
    }

    if (soilReports.length) {
      gardenUpdates.push({
        type: "soil.report",
        createdISO: isoNow(),
        items: soilReports,
      });
    }

    /* ---------------- Soil test due detection ---------------- */
    const bedsMissingOrStale = bedsDueForTest(beds, soilTests, S.reTestIntervalDays);
    for (const bid of bedsMissingOrStale) {
      calendarEvents.push({
        type: "test",
        title: `Soil test — ${bid}`,
        date: dayjs().add(1, "day").toISOString(),
        notes: "Re-sample bed and submit to lab; schedule amendments after results.",
      });
      actions.push({
        type: "CREATE_TASK",
        title: `Collect soil sample — ${bid}`,
        dueISO: dayjs().add(1, "day").toISOString(),
        notes: "Use clean trowel, sample 8–10 cores (0–15 cm), mix and bag.",
        tags: ["garden", "soil"],
      });
    }

    /* ---------------- Drought fallback ---------------- */
    const last7 = weather.filter((w) => dayjs(w.date).isAfter(now.subtract(7, "day")));
    const rain7 = sumBy(last7, "rainMm");
    const eto7 = sumBy(last7, "etoMm");
    const droughty = rain7 < (eto7 * 0.4 || 20);

    if (droughty) {
      recommendations.push(
        "Drought fallback: add 5–8 cm mulch, prioritize drip/soaker, water pre-dawn, and deep/infrequent schedule."
      );
      calendarEvents.push({
        type: "care",
        title: "Apply mulch (water-saving)",
        date: dayjs().add(1, "day").toISOString(),
        notes: "Target 5–8 cm organic mulch; refresh around heavy feeders.",
      });
      actions.push({
        type: "CREATE_TASK",
        title: "Mulch priority beds",
        dueISO: dayjs().add(2, "day").toISOString(),
        notes: "Focus on fruiting beds and shallow-rooted crops first.",
        tags: ["garden", "drought"],
      });
    }

    // Final UI open with tweak summary (visible drafts)
    actions.push({
      type: "OPEN_UI",
      route: S.openIrrigationUIRoute,
      component: "IrrigationSchedule",
      params: { updates: zoneTweaks, mode: "review" },
    });

    const summary = `Drafted ${zoneTweaks.length} irrigation tweak(s); ${soilPlans.length} amendment plan(s); ${bedsMissingOrStale.length} bed(s) flagged for soil test.`;
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
      draft: {
        zoneTweaks,
        soilPlans,
        drought: droughty,
        notes: uniq([
          droughty ? "Drought-safe routine recommended" : null,
          sensorHealth.warnings.length ? "Sensor health issues detected" : null,
        ]).filter(Boolean),
      },
    };
  },
};

export default SoilWaterHealthKeeperTemplate;

/* =========================
   Internal helper functions
   ========================= */

function sumBy(arr, key) {
  return (arr || []).reduce((a, b) => a + safeNum(b[key], 0), 0);
}
function avgBy(arr, key) {
  if (!arr || !arr.length) return null;
  const s = sumBy(arr, key);
  return s ? s / arr.length : null;
}
function bedTexture(beds, bedId) {
  const bed = (beds || []).find((b) => b.bedId === bedId);
  return bed?.soil?.texture || "default";
}
function targetRangeForTexture(texture, map) {
  const key = (texture || "default").toLowerCase();
  return map[key] || map.default;
}
function isWet(vwc, texture, map) {
  if (vwc == null) return false;
  const [, high] = targetRangeForTexture(texture, map);
  return vwc > high;
}
function isDry(vwc, texture, map) {
  if (vwc == null) return false;
  const [low] = targetRangeForTexture(texture, map);
  return vwc < low;
}

/**
 * Build 3-day rolling VWC with a simple confidence signal:
 * - confidence = "normal" if ≥ minSensorCountPerBed readings in window
 * - "low" otherwise
 */
function rollingVWC(moistureLogs = [], days = 3, minCount = 1) {
  const cutoff = dayjs().subtract(days, "day");
  const group = {};
  for (const m of moistureLogs) {
    const t = dayjs(m.timestamp || m.date || isoNow());
    if (t.isBefore(cutoff)) continue;
    const k = m.bedId;
    if (!group[k]) group[k] = [];
    if (Number.isFinite(Number(m.vwcPct))) group[k].push(safeNum(m.vwcPct, null));
  }
  const out = {};
  for (const [k, arr] of Object.entries(group)) {
    if (!arr.length) continue;
    out[k] = {
      avgVWC: round(arr.reduce((a, b) => a + b, 0) / arr.length, 1),
      confidence: arr.length >= minCount ? "normal" : "low",
      sampleCount: arr.length,
    };
  }
  return out;
}

function latestTestForBed(soilTests, bedId) {
  const items = (soilTests || []).filter((s) => s.bedId === bedId);
  if (!items.length) return null;
  return items.sort((a, b) => dayjs(b.date) - dayjs(a.date))[0];
}

function bedsDueForTest(beds, soilTests, intervalDays = 60) {
  const due = [];
  for (const b of beds || []) {
    const st = latestTestForBed(soilTests, b.bedId);
    if (!st) {
      due.push(b.bedId);
      continue;
    }
    const nextDue = dayjs(st.date).add(intervalDays, "day");
    if (dayjs().isAfter(nextDue)) due.push(b.bedId);
  }
  return due;
}

/**
 * Recommend coarse amendments from a soil test.
 * Caps rates to safe single-application maxima and prefers organic sources when enabled.
 */
function recommendAmendments(test, opts = {}) {
  const organicOnly = !!opts.organicOnly;
  const amends = [];

  // pH correction
  if (Number.isFinite(Number(test.ph))) {
    const ph = Number(test.ph);
    if (ph < 6.0) {
      const rate = clamp(0.5 + (6 - ph) * 0.1, 0.3, 1.0); // kg/m²
      amends.push({
        name: "garden lime",
        sku: "garden-lime",
        rateKgPerM2: round(rate, 2),
        notes: "Raise pH to ~6.4–6.8",
      });
    } else if (ph > 7.5) {
      const rate = clamp(0.1 + (ph - 7.5) * 0.05, 0.05, 0.3);
      amends.push({
        name: "elemental sulfur",
        sku: "elemental-sulfur",
        rateKgPerM2: round(rate, 2),
        notes: "Lower pH gradually",
      });
    }
  }

  // Macronutrients (coarse thresholds)
  const N = safeNum(test.nPpm, null);
  const P = safeNum(test.pPpm, null);
  const K = safeNum(test.kPpm, null);

  if (N !== null && N < 15) {
    amends.push({
      name: organicOnly ? "blood meal" : "ammonium nitrate",
      sku: organicOnly ? "blood-meal" : "ammonium-nitrate",
      rateKgPerM2: organicOnly ? 0.05 : 0.02,
      notes: "Boost N for leafy growth",
    });
  }
  if (P !== null && P < 30) {
    amends.push({
      name: organicOnly ? "rock phosphate" : "triple superphosphate",
      sku: organicOnly ? "rock-phosphate" : "tsp",
      rateKgPerM2: organicOnly ? 0.1 : 0.03,
      notes: "Support root/flowering",
    });
  }
  if (K !== null && K < 120) {
    amends.push({
      name: organicOnly ? "sulfate of potash" : "potassium chloride",
      sku: organicOnly ? "sop" : "muriate-of-potash",
      rateKgPerM2: organicOnly ? 0.05 : 0.02,
      notes: "Improve fruit set & resilience",
    });
  }

  const recommendations = amends.length
    ? amends.map((a) => `${title(a.name)} — ${a.rateKgPerM2} kg/m² (${a.notes})`)
    : ["Soil levels acceptable — maintain with compost 1–2 kg/m² annually."];

  return { amendments: amends, recommendations };
}

/**
 * Sensor health: flag beds with no readings in the 3-day window or too few samples.
 */
function sensorHealthReport(moistureLogs = [], beds = [], minCount = 1) {
  const byBed = {};
  const cutoff = dayjs().subtract(3, "day");
  for (const log of moistureLogs) {
    const t = dayjs(log.timestamp || log.date || isoNow());
    if (t.isBefore(cutoff)) continue;
    const k = log.bedId;
    if (!byBed[k]) byBed[k] = 0;
    if (Number.isFinite(Number(log.vwcPct))) byBed[k] += 1;
  }
  const warnings = [];
  for (const b of beds || []) {
    const c = byBed[b.bedId] || 0;
    if (c < minCount) {
      warnings.push({
        bedId: b.bedId,
        reason:
          c === 0
            ? "No VWC samples in the last 3 days"
            : `Low sample count in last 3 days (have ${c}, need ≥ ${minCount})`,
      });
    }
  }
  return { warnings };
}

/* ----------------------------------------------------------------------------
USAGE

import tpl from "@/services/templates/garden/SoilWaterHealthKeeper.template";

const res = await tpl.run({
  now: new Date(),
  inputs: {
    beds: [
      { bedId: "B1", areaM2: 3.6, soil: { texture: "loam", ph: 6.2 } },
      { bedId: "B2", areaM2: 2.4, soil: { texture: "sandy_loam", ph: 7.8 } },
    ],
    moistureLogs: [
      { timestamp: "2025-08-08T08:00:00Z", bedId: "B1", vwcPct: 15.2, source: "sensor" },
      { timestamp: "2025-08-09T08:00:00Z", bedId: "B1", vwcPct: 16.4, source: "sensor" },
      { timestamp: "2025-08-09T08:00:00Z", bedId: "B2", vwcPct: 9.5, source: "sensor" },
    ],
    soilTests: [
      { date: "2025-07-10", bedId: "B1", ph: 5.8, nPpm: 10, pPpm: 25, kPpm: 90, cec: 10, omPct: 3.5 },
      { date: "2025-07-10", bedId: "B2", ph: 7.8, nPpm: 20, pPpm: 35, kPpm: 110, cec: 7, omPct: 2.5 },
    ],
    weather: [
      { date: "2025-08-08", rainMm: 0, etoMm: 5.4, tMaxC: 36, tMinC: 24 },
      { date: "2025-08-09", rainMm: 8, etoMm: 4.9, tMaxC: 33, tMinC: 23 },
      { date: "2025-08-10", rainMm: 2, etoMm: 5.1, tMaxC: 35, tMinC: 24 },
    ],
    irrigationPrograms: [
      { zoneId: "Z1", bedIds: ["B1"], method: "drip", minutes: 30 },
      { zoneId: "Z2", bedIds: ["B2"], method: "drip", minutes: 25 },
    ],
    inventory: { "garden-lime": 2, "elemental-sulfur": 0.2, "blood-meal": 0 },
    settings: {
      // overrides welcome:
      // rainSkipThresholdMm: 8,
      // organicOnly: true,
      // notifyOnSkips: true,
      // notifyOnLowInventory: true,
      // minSensorCountPerBed: 2,
    },
  },
});
---------------------------------------------------------------------------- */

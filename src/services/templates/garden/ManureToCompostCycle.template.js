// C:\Users\larho\suka-smart-assistant\src\services\templates\garden\ManureToCompostCycle.template.js

/**
 * Manure → Compost Cycle — dynamic v2.3.0
 * - Smarter C:N + moisture balancing (with liters of water to add)
 * - Sensor-adaptive turn cadence & safety (55–65°C kill zone dwell hints)
 * - Bin-aware packing with capacity safeguards
 * - Browns procurement nudge payloads when short
 * - Delivery alignment to garden need dates with agent notifications
 * - Backward-compatible outputs/actions
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const round = (n, d = 1) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

/* ----------------------------------------------------------------------------
   Defaults (process params)
---------------------------------------------------------------------------- */
const DEFAULTS = {
  targetCN: 28,                 // aim for 25–30:1
  targetMoisturePct: 55,        // 50–60% ideal
  hotMethodTurnDays: 3,
  coldMethodTurnDays: 14,
  hotMethodCureDays: 21,
  coldMethodCureDays: 45,
  minPileVolumeL: 400,          // min for reliable hot compost
  // coarse densities (kg/L) for rough mass & heat capacity intuition
  densityKgPerL: { manure: 0.7, brown: 0.12, compost: 0.6 },
  // typical moisture baselines
  defaultMoisturePct: { manure: 70, brown: 10 },
  openUIRoute: "/tier2/garden/compost",
  allowDirectApply: true,
  directApplyHints: [
    "perennial shrubs",
    "fruit trees (mulch ring)",
    "ornamental beds",
    "non-root annuals (side-dress)"
  ],
  // kill-zone safety: aim to keep ≥55°C for ≥3 days (hot method)
  minHotKillTempC: 55,
  minHotKillDays: 3
};

/* ----------------------------------------------------------------------------
   Template
---------------------------------------------------------------------------- */
const ManureToCompostCycleTemplate = {
  id: "manure-to-compost-cycle",
  name: "Manure to Compost Cycle",
  version: "2.3.0",
  purpose: "Convert collected manure to garden-ready compost with timely delivery.",

  triggers: ["waste_bin_full", "garden_need_date_set", "user_request", "daily_scan_0700"],

  inputs: {
    manure: "{ source, cnApprox:number=12, volumeL:number, moisturePct?:number }",
    browns: "array[{ name, cn:number, availableL:number, moisturePct?:number }]",
    bins: "array[{ binId, capacityL:number, availableL:number, method:'hot'|'cold', aeration:'passive'|'forced' }]",
    gardenNeeds: "array[{ dateISO, volumeL?, notes? }]",
    sensors: "array[{ binId, dateISO, tempC?, moisturePct? }]",
    wasteBins: "array[{ id, full:boolean }]",
    settings:
      "object{ targetCN?, targetMoisturePct?, hotMethodTurnDays?, coldMethodTurnDays?, hotMethodCureDays?, coldMethodCureDays?, minPileVolumeL?, openUIRoute?, allowDirectApply?, directApplyHints?[] }"
  },

  logic: [
    "Normalize inputs; open Compost Schedule UI.",
    "Compute browns required to reach target C:N and estimate water addition to reach target moisture.",
    "Pick method (hot/cold) from achievable pile volume; prefer hot if ≥ minPileVolumeL.",
    "Pack batches into bins by available capacity, preserving target ratios.",
    "Emit turn/cure events and 'ready' alerts; adapt turn frequency based on sensor temps.",
    "Align earliest cured batch to garden need dates; notify gardenAgent.",
    "If browns shortfall or bin capacity insufficient → recommend procurement/direct-apply fallbacks.",
    "Use sensors to check kill-zone dwell (≥55°C for ≥3 days) and moisture drifts."
  ],

  actions: ["OPEN_UI", "NOTIFY_AGENT", "PROCUREMENT_SUGGEST"],

  outputs: {
    gardenUpdates: "array[ {type:'compost.schedule'|'garden.delivery', ...} ]",
    calendarEvents: "array[ {type:'care'|'follow_up'|'warning', title, date, notes?} ]",
    recommendations: "array[string]",
    logs: "array",
    actions: "array[{type, ...}]"
  },

  fallbacks: ["direct_apply_mulch_non_root_crops", "delay_to_next_bin_capacity"],

  schedule: { RRULE: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0;BYSECOND=0" },

  nextRuns(now = dayjs(), ctx = {}) {
    const needs = Array.isArray(ctx?.inputs?.gardenNeeds) ? ctx.inputs.gardenNeeds : [];
    const preps = needs
      .map((n) => dayjs(n.dateISO).subtract(5, "day"))
      .filter((d) => d.isAfter(now))
      .map((d) => d.toISOString());
    if (preps.length) return preps.sort();

    const base = now.hour(7).minute(0).second(0).millisecond(0);
    const t = base.isBefore(now) ? base.add(1, "day") : base;
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
    const inManure = ctx.inputs?.manure || { volumeL: 0, cnApprox: 12, source: "Unknown" };
    const browns = Array.isArray(ctx.inputs?.browns) ? ctx.inputs.browns : [];
    const bins = Array.isArray(ctx.inputs?.bins) ? ctx.inputs.bins : [];
    const gardenNeeds = Array.isArray(ctx.inputs?.gardenNeeds) ? ctx.inputs.gardenNeeds : [];
    const sensors = Array.isArray(ctx.inputs?.sensors) ? ctx.inputs.sensors : [];
    const wasteBins = Array.isArray(ctx.inputs?.wasteBins) ? ctx.inputs.wasteBins : [];
    const S = { ...DEFAULTS, ...(ctx.inputs?.settings || {}) };

    // UI entry
    actions.push({ type: "OPEN_UI", route: S.openUIRoute, component: "CompostSchedule", params: {} });

    const hasFullWaste = wasteBins.some((w) => w.full);
    const nextNeed = gardenNeeds.slice().sort((a, b) => new Date(a.dateISO) - new Date(b.dateISO))[0] || null;

    /* ------------------------------------------------------------------------
       Phase 1: C:N & Moisture planning
    ------------------------------------------------------------------------ */
    const targetCN = safeNum(S.targetCN, 28);
    const manureCN = safeNum(inManure.cnApprox, 12);
    const manureL = safeNum(inManure.volumeL, 0);

    // Moisture assumptions
    const manureMoist = safeNum(inManure.moisturePct, S.defaultMoisturePct.manure);
    const avgBrownCN = browns.length
      ? browns.reduce((a, b) => a + safeNum(b.cn, 60), 0) / browns.length
      : 60;
    const avgBrownMoist = browns.length
      ? browns.reduce((a, b) => a + safeNum(b.moisturePct ?? S.defaultMoisturePct.brown, S.defaultMoisturePct.brown), 0) /
        browns.length
      : S.defaultMoisturePct.brown;

    // Browns volume to hit target C:N (simple proportional model)
    function brownsNeededL(greenL, greenCN, goalCN, brownCN) {
      if (brownCN === goalCN) return 0;
      const k = (goalCN - greenCN) / (brownCN - goalCN);
      return Math.max(0, k * greenL);
    }
    const brownNeedL = round(brownsNeededL(manureL, manureCN, targetCN, avgBrownCN));
    const availableBrownsL = browns.reduce((a, b) => a + safeNum(b.availableL, 0), 0);
    const brownShortfallL = Math.max(0, brownNeedL - availableBrownsL);

    if (brownShortfallL > 0) {
      recommendations.push(
        `Need ~${brownNeedL} L browns for C:N≈${targetCN}:1; short by ~${brownShortfallL} L. Add shredded leaves/cardboard/wood shavings.`
      );
      // Procurement suggestion payload
      actions.push({
        type: "PROCUREMENT_SUGGEST",
        payload: {
          demand: [
            { name: "Shredded Leaves", qty: Math.ceil(brownShortfallL), unit: "L", priority: "staple", tags: ["browns"] }
          ],
          reason: "compost_browns_shortfall"
        }
      });
    }

    // Estimate post-mix moisture and water to add to reach target
    const mixManureWaterL = manureL * (manureMoist / 100);
    const useBrownL = Math.min(availableBrownsL, brownNeedL);
    const mixBrownsWaterL = useBrownL * (avgBrownMoist / 100);
    const totalMixL = manureL + useBrownL;
    const currentMoistPct = totalMixL > 0 ? ((mixManureWaterL + mixBrownsWaterL) / totalMixL) * 100 : 0;
    const targetMoistPct = clamp(safeNum(S.targetMoisturePct, 55), 45, 65);
    const waterToAddL = totalMixL > 0 && currentMoistPct < targetMoistPct
      ? round(((targetMoistPct - currentMoistPct) / 100) * totalMixL, 1)
      : 0;

    const method = totalMixL >= S.minPileVolumeL ? "hot" : "cold";
    const turnEveryDaysBase = method === "hot" ? safeNum(S.hotMethodTurnDays, 3) : safeNum(S.coldMethodTurnDays, 14);
    const cureDays = method === "hot" ? safeNum(S.hotMethodCureDays, 21) : safeNum(S.coldMethodCureDays, 45);

    /* ------------------------------------------------------------------------
       Phase 2: Bin packing (capacity-aware)
    ------------------------------------------------------------------------ */
    const batches = []; // { binId, startISO, method, manureL, brownL, waterAddL, totalL, turnEveryDays, estCureISO }
    let remainingManureL = manureL;
    let remainingBrownL = useBrownL;

    const binsSorted = bins
      .slice()
      .sort((a, b) => safeNum(b.availableL, 0) - safeNum(a.availableL, 0));

    for (const bin of binsSorted) {
      if (remainingManureL <= 0) break;
      const slotL = clamp(safeNum(bin.availableL, 0), 0, safeNum(bin.capacityL, Infinity));
      if (slotL <= 0) continue;

      // Keep C:N and volume proportion in each bin
      const totalRemainingMix = Math.max(1, remainingManureL + remainingBrownL);
      const allocateL = Math.min(slotL, totalRemainingMix);

      const manurePortion = Math.min(remainingManureL, Math.round(allocateL * (remainingManureL / totalRemainingMix)));
      const brownPortion = Math.min(remainingBrownL, Math.max(0, allocateL - manurePortion));

      const thisMixL = manurePortion + brownPortion;
      if (thisMixL <= 0) continue;

      // Pro-rate water addition for this bin relative to total mix
      const waterAddL = totalMixL > 0 ? round(waterToAddL * (thisMixL / totalMixL), 1) : 0;

      const startISO = now.toISOString();
      const estCureISO = now.add(cureDays, "day").toISOString();

      batches.push({
        binId: bin.binId,
        method,
        startISO,
        manureL: manurePortion,
        brownL: brownPortion,
        waterAddL,
        totalL: thisMixL,
        turnEveryDays: turnEveryDaysBase,
        estCureISO,
        aeration: bin.aeration || "passive"
      });

      remainingManureL -= manurePortion;
      remainingBrownL -= brownPortion;
    }

    if (remainingManureL > 0) {
      recommendations.push(`Bins at capacity. ~${remainingManureL} L manure remains unassigned.`);
      if (S.allowDirectApply) {
        recommendations.push(
          `Fallback: direct-apply as mulch for ${S.directApplyHints.join(", ")} (avoid edible contact).`
        );
      }
    }

    /* ------------------------------------------------------------------------
       Phase 3: Delivery alignment to garden need
    ------------------------------------------------------------------------ */
    let deliveryISO = null;
    if (gardenNeeds.length && batches.length) {
      const earliestCure = batches
        .slice()
        .sort((a, b) => new Date(a.estCureISO) - new Date(b.estCureISO))[0];
      const need = dayjs(gardenNeeds[0].dateISO);
      if (dayjs(earliestCure.estCureISO).isBefore(need.add(1, "day"))) {
        deliveryISO = need.toISOString();
      } else {
        deliveryISO = earliestCure.estCureISO;
        recommendations.push(
          `First cured batch ready ${dayjs(deliveryISO).format("YYYY-MM-DD")} after requested need date.`
        );
      }
    }

    /* ------------------------------------------------------------------------
       Phase 4: Calendar, sensors & outputs
    ------------------------------------------------------------------------ */
    // Base calendar: turns + cure checks + ready
    for (const b of batches) {
      // Adaptive turn cadence hint based on aeration
      let turnEveryDays = b.turnEveryDays;
      if (b.aeration === "forced" && method === "hot") {
        turnEveryDays = Math.max(2, b.turnEveryDays + 1); // forced aeration often needs slightly fewer turns
      }

      // Active-phase scheduled turns
      const activeDays = method === "hot" ? 14 : 28;
      let t = dayjs(b.startISO).add(turnEveryDays, "day");
      while (t.isBefore(dayjs(b.startISO).add(activeDays, "day"))) {
        calendarEvents.push({
          type: "care",
          title: `Turn bin ${b.binId} (${method})`,
          date: t.toISOString(),
          notes: `Target C:N≈${targetCN}:1; moisture ${targetMoisturePct}%. Add ~${b.waterAddL} L water across early turns if dry.`
        });
        t = t.add(turnEveryDays, "day");
      }

      // Cure checks & ready
      calendarEvents.push({
        type: "follow_up",
        title: `Cure check — Bin ${b.binId}`,
        date: b.estCureISO,
        notes: "Squeeze test: damp (no drip), crumbly; temp near ambient. Screen if desired."
      });
      calendarEvents.push({
        type: "care",
        title: `Compost ready — Bin ${b.binId}`,
        date: b.estCureISO,
        notes: "Deliver or move to curing bay."
      });

      // Schedule row for UI
      gardenUpdates.push({
        type: "compost.schedule",
        binId: b.binId,
        method: b.method,
        aeration: b.aeration,
        startISO: b.startISO,
        estCureISO: b.estCureISO,
        turnEveryDays,
        mix: {
          manureL: b.manureL,
          brownL: b.brownL,
          waterAddL: b.waterAddL,
          totalL: b.totalL,
          targetCN,
          targetMoisturePct
        },
        notes: "Auto-generated by Manure→Compost Cycle"
      });
    }

    // Delivery event & agent notify
    if (deliveryISO) {
      const deliverVol = Math.min(
        gardenNeeds[0]?.volumeL || 0,
        batches.reduce((a, b) => a + safeNum(b.totalL, 0), 0)
      );

      gardenUpdates.push({
        type: "garden.delivery",
        category: "compost",
        dateISO: deliveryISO,
        volumeL: deliverVol || undefined,
        notes: gardenNeeds[0]?.notes || "Auto-scheduled compost delivery"
      });

      actions.push({
        type: "NOTIFY_AGENT",
        agent: "gardenAgent",
        payload: {
          summary: "Compost delivery scheduled",
          dateISO: deliveryISO,
          volumeL: deliverVol || null
        }
      });
    }

    // Sensor-driven adaptations & safety
    const byBin = new Map();
    for (const s of sensors) {
      if (!byBin.has(s.binId)) byBin.set(s.binId, []);
      byBin.get(s.binId).push(s);
    }

    for (const b of batches) {
      const binSensors = (byBin.get(b.binId) || []).sort(
        (a, c) => new Date(a.dateISO) - new Date(c.dateISO)
      );

      if (method === "hot" && binSensors.length) {
        // Kill-zone dwell check (≥55°C for ≥3 cumulative days)
        let dwellDays = 0;
        for (let i = 0; i < binSensors.length; i++) {
          const tC = safeNum(binSensors[i].tempC, NaN);
          if (!Number.isFinite(tC)) continue;
          if (tC >= S.minHotKillTempC) {
            const next = binSensors[i + 1]?.dateISO || dayjs(binSensors[i].dateISO).add(1, "day").toISOString();
            dwellDays += Math.max(
              0,
              dayjs(next).diff(dayjs(binSensors[i].dateISO), "day", true)
            );
          }
        }
        if (dwellDays < S.minHotKillDays) {
          recommendations.push(
            `Bin ${b.binId}: hot compost dwell ${dwellDays.toFixed(
              1
            )}d < ${S.minHotKillDays}d at ≥${S.minHotKillTempC}°C. Increase greens/moisture or reduce turn interval.`
          );
          // add an extra turn event tomorrow morning
          calendarEvents.push({
            type: "care",
            title: `Extra turn — Bin ${b.binId} (boost heat)`,
            date: dayjs().hour(9).minute(0).second(0).millisecond(0).toISOString(),
            notes: "Add greens or water lightly if dry."
          });
        }
      }

      // Moisture drift hints
      const latest = binSensors[binSensors.length - 1];
      if (latest?.moisturePct != null) {
        if (latest.moisturePct < targetMoisturePct - 5) {
          recommendations.push(
            `Bin ${b.binId}: moisture ${latest.moisturePct}% is low; add ${Math.max(
              1,
              Math.round(b.waterAddL || (b.totalL * 0.05))
            )} L water during next turn.`
          );
        } else if (latest.moisturePct > targetMoisturePct + 10) {
          recommendations.push(
            `Bin ${b.binId}: moisture ${latest.moisturePct}% is high; add dry browns and fork for aeration.`
          );
        }
      }
    }

    if (hasFullWaste && manureL === 0) {
      recommendations.push("Waste bin flagged full but manure volume = 0 — verify sync/data source.");
    }

    const summary = batches.length
      ? `Planned ${batches.length} compost batch(es); method=${method}, ${waterToAddL > 0 ? `add ~${waterToAddL} L water total; ` : ""}${deliveryISO ? `delivery ${dayjs(deliveryISO).format("YYYY-MM-DD")}` : "no delivery"}`
      : "No compost batches created (insufficient materials or bin capacity).";

    services?.logger?.info?.(`[${this.id}] ${summary}`);

    return {
      ok: true,
      timestamp: startTs,
      summary,
      recommendations,
      calendarEvents,
      gardenUpdates,
      logs,
      actions
    };
  }
};

export default ManureToCompostCycleTemplate;

/* ---------------------------------------------------------------------------
USAGE

import tpl from "@/services/templates/garden/ManureToCompostCycle.template";

const res = await tpl.run({
  now: new Date(),
  inputs: {
    manure: { source: "Chicken Coop", cnApprox: 12, volumeL: 300, moisturePct: 70 },
    browns: [
      { name: "Shredded Leaves", cn: 60, availableL: 400, moisturePct: 12 },
      { name: "Cardboard Shreds", cn: 350, availableL: 120, moisturePct: 7 }
    ],
    bins: [
      { binId: "B1", capacityL: 800, availableL: 600, method: "hot", aeration: "passive" },
      { binId: "B2", capacityL: 800, availableL: 300, method: "hot", aeration: "forced" }
    ],
    gardenNeeds: [{ dateISO: "2025-10-01", volumeL: 400, notes: "Fall bed prep" }],
    sensors: [
      { binId: "B1", dateISO: "2025-08-10", tempC: 52, moisturePct: 48 },
      { binId: "B1", dateISO: "2025-08-11", tempC: 56, moisturePct: 50 },
      { binId: "B1", dateISO: "2025-08-12", tempC: 58, moisturePct: 52 }
    ],
    wasteBins: [{ id: "WB-1", full: true }],
    settings: {
      // optional overrides
      // targetCN: 30,
      // targetMoisturePct: 55,
      // openUIRoute: "/tier2/garden/compost",
    }
  }
});
--------------------------------------------------------------------------- */

// C:\Users\larho\suka-smart-assistant\src\services\templates\animal\ButcheringProcessingDayPrep.template.js

/**
 * Butchering & Processing Day Prep — standardized template (dynamic v2.3)
 *
 * New in 2.3:
 *  • Sabbath/quiet-hours notes on prep/processing events
 *  • Cold-chain math → ice requirement estimate + spillover guidance
 *  • Weather & capacity risk scoring with clear recommendations
 *  • Optional staff/tool assignment hints (consumed by planner)
 *  • Procurement hooks for ice/propane/sanitizer/labels
 *  • “Second-day spillover” plan if maxDailyHours exceeded
 *  • Alert scheduling hints for -3d/-2d/-1d & day-of checkpoints
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const title = (s) => (s || "").replace(/\b\w/g, (m) => m.toUpperCase());
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const fmt = (d) => dayjs(d).format("YYYY-MM-DD");

/* ----------------------------------------------------------------------------
   Defaults (overridable via ctx.inputs.settings)
---------------------------------------------------------------------------- */
const DEFAULTS = {
  processingStartLocal: "07:00",
  humaneIntervalMin: 20,
  cleanupBufferMin: 15,
  maxDailyHours: 10,
  sabbathAware: true,
  quietHours: { start: "22:00", end: "07:00" }, // for alert deferral notes
  speciesProfiles: {
    Chicken: { batchSize: 10, processMinPerHead: 12, avgYieldPct: 70 },
    Turkey:  { batchSize: 5,  processMinPerHead: 18, avgYieldPct: 76 },
    Duck:    { batchSize: 8,  processMinPerHead: 16, avgYieldPct: 68 },
    Goat:    { batchSize: 1,  processMinPerHead: 45, avgYieldPct: 49 },
    Pig:     { batchSize: 1,  processMinPerHead: 90, avgYieldPct: 72 },
  },
  chilling: {
    // Rule-of-thumb: ~0.3–0.5 kg ice per kg carcass to pull down to <4°C;
    // we start at 0.35 and apply assistFactor if you have pre-chill/circulation.
    icePerKgCarcass: 0.35,
    iceAssistFactor: 1.15, // +15% effectiveness if plenty of circulation/pre-chill
  },
  minSharpnessPct: 70,
  // Simple thresholds for outdoor stations
  weather: { hotMaxC: 32, coldMinC: -5, rainMm: 20, windMps: 12 },
  staffing: {
    // Minimal staffing per station (used for assignment hints)
    stations: [
      { id: "dispatch", name: "Dispatch", min: 1, tools: ["cones"] },
      { id: "scald_pluck", name: "Scald & Pluck", min: 1, tools: ["scalder","plucker"] },
      { id: "evisc", name: "Evisceration", min: 1, tools: ["knives","sanitizer"] },
      { id: "rinse_chill", name: "Rinse & Chill", min: 1, tools: ["ice","totes"] },
      { id: "bag_label", name: "Bag & Label", min: 1, tools: ["labels","scale"] },
    ],
  },
  openUIRoute: "/tier2/animals/processing",
};

/* ----------------------------------------------------------------------------
   Template
---------------------------------------------------------------------------- */
const ButcheringProcessingDayPrepTemplate = {
  id: "butchering-processing-day-prep",
  name: "Butchering & Processing Day Prep",
  version: "2.3.0",
  purpose:
    "Plan humane, efficient harvest days with capacity checks, staffing/tool readiness, cold-chain coverage, and labeling/procurement hooks.",

  triggers: ["three_days_before_butcher_date", "weekly_scan_friday", "user_request"],

  inputs: {
    butcherAppointments:
      "array[{ dateISO, location?, animals: array[{ species, count:number, avgLiveKg:number, yieldPct?, cutSheetKey? }] }]",
    tools:
      "object{ knives?:{count:number, sharpnessPct:number}, cones?:{count:number}, scalder?:bool, plucker?:bool, propaneKg?:number, sanitizerL?:number, iceKgAvailable?:number }",
    capacity:
      "object{ coolerKg?:number, freezerKg?:number, iceKgReserve?:number }",
    labelProfiles:
      "record<key, { productPrefix?:string, items?:array[{ name, weightRangeKg?:[number,number] }], barcodeFormat?:string }>",
    weather:
      "array[{ dateISO, tMaxC?:number, precipMm?:number, windMps?:number }]",
    // Optional staffing context for assignment hints
    staff:
      "array[{ userId, name, toolsOwned?:string[] }]",
    settings:
      "object{ processingStartLocal?, humaneIntervalMin?, cleanupBufferMin?, maxDailyHours?, sabbathAware?, quietHours?, speciesProfiles?, chilling?, minSharpnessPct?, weather?, staffing?, openUIRoute? }",
  },

  logic: [
    "Compute carcass mass from heads × live kg × yield.",
    "Create humane batches with cleanup buffers; respect maxDailyHours.",
    "Validate cooler/freezer/ice and estimate ice shortfall.",
    "Check tool readiness (knives sharpness/count, scalder/plucker, propane, sanitizer).",
    "Score weather risk; suggest fallback (mobile butcher / reschedule) if high.",
    "Generate label jobs from cut sheets.",
    "Emit prep tasks (-3d/-2d/-1d), alert hints, procurement deltas, staffing/tool assignment hints.",
  ],

  actions: ["OPEN_UI", "TIMER_CREATE", "LABEL_PRINTER_SYNC", "SCHEDULE_ALERTS", "PROCUREMENT_REQUEST", "ASSIGN_STAFF", "LOG"],

  outputs: {
    gardenUpdates: "array[ {type:'animal.processing_plan', ...} ]",
    calendarEvents: "array[ {type:'care'|'warning', title, date, notes?} ]",
    recommendations: "array[string]",
    procurementDeltas: "array[{ name, unit, qty, dateISO, reason }]",
    staffingHints: "array[{ stationId, need, tools: string[] }]",
    logs: "array",
    actions: "array[{type, ...}]",
  },

  fallbacks: ["book_mobile_butcher", "add_ice_and_extend_prechill", "spillover_to_next_day", "reduce_batch_size"],

  schedule: {
    weekly: { RRULE: "FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },
  },

  nextRuns(now = dayjs()) {
    const base = now.day(5).hour(9).minute(0).second(0).millisecond(0); // Friday 09:00
    const t = base.isBefore(now) ? base.add(1, "week") : base;
    return [t.toISOString()];
  },

  async run(ctx = {}, services = {}) {
    const startTs = isoNow();
    const logs = [];
    const recommendations = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const procurementDeltas = [];
    const staffingHints = [];
    const actions = [];

    const now = dayjs(ctx.now || new Date());
    const inputs = ctx.inputs || {};
    const appointments = inputs.butcherAppointments || [];
    const tools = inputs.tools || {};
    const cap = inputs.capacity || {};
    const labels = inputs.labelProfiles || {};
    const weather = inputs.weather || [];
    const staff = Array.isArray(inputs.staff) ? inputs.staff : [];
    const settings = {
      ...DEFAULTS,
      ...(inputs.settings || {}),
      speciesProfiles: { ...DEFAULTS.speciesProfiles, ...(inputs.settings?.speciesProfiles || {}) },
      weather: { ...DEFAULTS.weather, ...(inputs.settings?.weather || {}) },
      chilling: { ...DEFAULTS.chilling, ...(inputs.settings?.chilling || {}) },
      staffing: { ...DEFAULTS.staffing, ...(inputs.settings?.staffing || {}) },
    };

    const forecastByDate = (iso) =>
      (Array.isArray(weather) ? weather : []).find((w) => dayjs(w.dateISO).isSame(dayjs(iso), "day")) || {};

    const sabNote = (iso, action) => {
      if (!settings.sabbathAware) return null;
      const d = dayjs(iso);
      const dow = d.day();
      if (dow === 5) return `Sabbath-aware: finish active ${action} before Friday sunset.`;
      if (dow === 6) return `Sabbath-aware: prefer no active ${action} until after Saturday sunset.`;
      return null;
    };
    const quietNote = (iso) => {
      const d = new Date(iso);
      const [sh, sm] = (settings.quietHours?.start || "22:00").split(":").map(Number);
      const [eh, em] = (settings.quietHours?.end || "07:00").split(":").map(Number);
      const s = new Date(d); s.setHours(sh, sm || 0, 0, 0);
      const e = new Date(d); e.setHours(eh, em || 0, 0, 0);
      const inQuiet = s <= e ? (d >= s && d <= e) : (d >= s || d <= e);
      return inQuiet ? `Quiet-hours aware: alerts may be deferred (${settings.quietHours.start}-${settings.quietHours.end}).` : null;
    };

    actions.push({ type: "OPEN_UI", route: settings.openUIRoute, component: "ProcessingChecklist", params: {} });

    for (const appt of appointments) {
      const date = dayjs(appt.dateISO);
      const procStartLocal = parseTimeOnDate(date, settings.processingStartLocal);
      let cursor = procStartLocal.clone();

      // Totals
      let totalCarcassKg = 0;
      let totalHeads = 0;

      // Build batches
      const batches = [];
      for (const lot of appt.animals || []) {
        const prof = settings.speciesProfiles[lot.species] || settings.speciesProfiles["Chicken"];
        const yieldPct = safeNum(lot.yieldPct, prof.avgYieldPct);
        const carcassKg = safeNum(lot.count, 0) * safeNum(lot.avgLiveKg, 0) * (safeNum(yieldPct, prof.avgYieldPct) / 100);
        totalCarcassKg += carcassKg;
        totalHeads += safeNum(lot.count, 0);

        const batchSize = Math.max(1, safeNum(prof.batchSize, 10));
        const perHeadMin = Math.max(1, safeNum(prof.processMinPerHead, 12));
        const humaneGap = safeNum(settings.humaneIntervalMin, 20);
        const cleanup = safeNum(settings.cleanupBufferMin, 15);

        const nBatches = Math.ceil((lot.count || 0) / batchSize);
        for (let b = 0; b < nBatches; b++) {
          const heads = b < nBatches - 1 ? batchSize : (lot.count || 0) - batchSize * (nBatches - 1);
          const workMin = heads * perHeadMin;
          const start = cursor.clone();
          const end = start.clone().add(workMin + cleanup, "minute");

          batches.push({
            species: lot.species,
            headcount: heads,
            startISO: start.toISOString(),
            endISO: end.toISOString(),
            station: appt.location || "Processing Area",
            notes: `Batch ${b + 1}/${nBatches} (humane interval ${humaneGap} min, cleanup ${cleanup} min).`,
          });

          actions.push({
            type: "TIMER_CREATE",
            label: `${lot.species} Batch ${b + 1}`,
            startISO: start.toISOString(),
            durationMin: workMin,
            meta: { cleanupBufferMin: cleanup, humaneIntervalMin: humaneGap },
          });

          cursor = end.clone().add(humaneGap, "minute");
        }
      }

      // Capacity & cold-chain
      const coolerKg = safeNum(cap.coolerKg, Infinity);
      const freezerKg = safeNum(cap.freezerKg, 0);
      const iceReserve = safeNum(cap.iceKgReserve, 0);
      const iceAvail = safeNum(tools.iceKgAvailable, 0);
      const icePerKg = safeNum(settings.chilling.icePerKgCarcass, 0.35);
      const assist = settings.chilling.iceAssistFactor || 1;

      const coolerAllowance = Number.isFinite(coolerKg) ? coolerKg * (iceReserve > 0 ? assist : 1) : Infinity;
      const coolerOk = totalCarcassKg <= coolerAllowance;
      const freezerOk = freezerKg >= totalCarcassKg * 0.6; // coarse 60% frozen same day

      // Estimate ice needs
      const iceNeeded = Math.ceil(totalCarcassKg * icePerKg);
      const iceShort = Math.max(0, iceNeeded - iceAvail - iceReserve);

      if (!coolerOk) {
        recommendations.push(
          `Projected carcass mass ~${totalCarcassKg.toFixed(1)} kg exceeds chilling allowance (${coolerAllowance.toFixed(1)} kg). Add ice or split to two days.`
        );
      }
      if (!freezerOk) {
        recommendations.push(
          `Freezer capacity may be tight (need ~${Math.ceil(totalCarcassKg * 0.6)} kg). Extend pre-chill or stage freezing.`
        );
      }
      if (iceShort > 0) {
        recommendations.push(`Ice shortfall ~${iceShort} kg. Add bags or increase pre-chill water circulation.`);
        procurementDeltas.push({
          name: "bagged ice",
          unit: "kg",
          qty: iceShort,
          dateISO: date.subtract(1, "day").toISOString(),
          reason: `${iceNeeded} kg needed – ${iceAvail} kg on hand, ${iceReserve} kg reserve.`,
        });
      }

      // Tools readiness
      const sharpnessOk = safeNum(tools?.knives?.sharpnessPct, 0) >= settings.minSharpnessPct;
      const knifeCountOk = safeNum(tools?.knives?.count, 0) >= 3;
      if (!sharpnessOk || !knifeCountOk) {
        calendarEvents.push({
          type: "care",
          title: "Sharpen & stage knives",
          date: date.subtract(2, "day").toISOString(),
          notes: `Have ≥3 knives at ≥${settings.minSharpnessPct}% sharpness; stage steel & sanitizer.`,
        });
        procurementDeltas.push({
          name: "sanitizer",
          unit: "L",
          qty: safeNum(1 - safeNum(tools.sanitizerL, 0), 0) > 0 ? 1 : 0,
          dateISO: date.subtract(2, "day").toISOString(),
          reason: "Top up sanitizer for day-of workflow.",
        });
      }
      if (!tools.scalder || !tools.plucker) {
        recommendations.push("Verify scalder/plucker availability or book mobile equipment.");
      }
      if (safeNum(tools.propaneKg, 0) < 5) {
        procurementDeltas.push({
          name: "propane",
          unit: "kg",
          qty: Math.max(0, 8 - safeNum(tools.propaneKg, 0)),
          dateISO: date.subtract(2, "day").toISOString(),
          reason: "Keep ≥8 kg on hand (≥5 kg minimum + spare).",
        });
        calendarEvents.push({
          type: "warning",
          title: "Low propane for scalder",
          date: isoNow(),
          notes: "Keep ≥5 kg reserve; add spare tank.",
        });
      }
      if (safeNum(tools.sanitizerL, 0) < 1) {
        calendarEvents.push({
          type: "warning",
          title: "Sanitizer low",
          date: isoNow(),
          notes: "Target ≥1–2 L sanitizer for processing day.",
        });
      }

      // Weather risk
      const fc = forecastByDate(appt.dateISO);
      const wx = settings.weather;
      const extremeHot = safeNum(fc.tMaxC, -999) >= wx.hotMaxC;
      const extremeCold = safeNum(fc.tMaxC, 999) <= wx.coldMinC;
      const heavyRain = safeNum(fc.precipMm, 0) >= wx.rainMm;
      const highWind = safeNum(fc.windMps, 0) >= wx.windMps;
      const riskScore = (extremeHot ? 2 : 0) + (extremeCold ? 2 : 0) + (heavyRain ? 1 : 0) + (highWind ? 1 : 0);

      if (riskScore >= 2) {
        const notes = [
          extremeHot ? `hot (≥${wx.hotMaxC}°C)` : null,
          extremeCold ? `cold (≤${wx.coldMinC}°C)` : null,
          heavyRain ? `heavy rain (≥${wx.rainMm}mm)` : null,
          highWind ? `high wind (≥${wx.windMps} m/s)` : null,
        ].filter(Boolean).join(", ");
        calendarEvents.push({
          type: "warning",
          title: "Weather risk on butchering day",
          date: isoNow(),
          notes: `Forecast: ${notes}. Fallback: book mobile butcher or reschedule.`,
        });
        recommendations.push("Consider mobile butcher fallback or shift by 1–2 days for safer conditions.");
      }

      // Overlong day spillover
      const totalMinutes = batches.reduce((a, b) => a + dayjs(b.endISO).diff(dayjs(b.startISO), "minute"), 0)
        + batches.length * safeNum(settings.humaneIntervalMin, 20);
      const hours = totalMinutes / 60;
      let spillover = null;
      if (hours > safeNum(settings.maxDailyHours, 10)) {
        recommendations.push(
          `Planned work ~${hours.toFixed(1)} h exceeds daily cap (${settings.maxDailyHours} h). Spill last batches to next day.`
        );
        // Move last X batches to next day until within cap
        const nextDay = date.add(1, "day");
        const toMove = [];
        let currentHours = hours;
        for (let i = batches.length - 1; i >= 0 && currentHours > settings.maxDailyHours; i--) {
          toMove.push(batches[i]);
          const segMin = dayjs(batches[i].endISO).diff(dayjs(batches[i].startISO), "minute") + settings.humaneIntervalMin;
          currentHours -= segMin / 60;
          batches.pop();
        }
        spillover = toMove.reverse().map((b, idx) => {
          const start = parseTimeOnDate(nextDay, settings.processingStartLocal).add(idx * (settings.humaneIntervalMin + 30), "minute");
          const dur = dayjs(b.endISO).diff(dayjs(b.startISO), "minute");
          return { ...b, startISO: start.toISOString(), endISO: start.add(dur, "minute").toISOString(), notes: (b.notes || "") + " (spillover)" };
        });
        // Add spillover timers
        (spillover || []).forEach((b, i) => {
          actions.push({
            type: "TIMER_CREATE",
            label: `${b.species} Spillover ${i + 1}`,
            startISO: b.startISO,
            durationMin: dayjs(b.endISO).diff(dayjs(b.startISO), "minute"),
            meta: { spillover: true },
          });
        });
      }

      // Labels → jobs
      const labelJobs = [];
      for (const lot of appt.animals || []) {
        const key = lot.cutSheetKey || defaultCutKeyFor(lot.species);
        const profile = labels[key];
        if (!profile) {
          recommendations.push(`${lot.species}: no label profile for key "${key}". Please add one or map a default.`);
          continue;
        }
        const items = buildLabelItems(profile, lot);
        labelJobs.push({ cutSheetKey: key, species: lot.species, items });
      }
      if (labelJobs.length) {
        actions.push({ type: "LABEL_PRINTER_SYNC", payload: { dateISO: appt.dateISO, jobs: labelJobs } });
        // Procurement hint for labels if needed (assume 1 label per item)
        procurementDeltas.push({
          name: "labels",
          unit: "each",
          qty: labelJobs.reduce((s, j) => s + j.items.length, 0),
          dateISO: date.subtract(2, "day").toISOString(),
          reason: "Labels for packaged parts/wholes.",
        });
      }

      // Staffing hints (tool-based)
      const stationNeeds = settings.staffing.stations.map(st => ({
        stationId: st.id,
        need: st.min,
        tools: st.tools,
      }));
      staffingHints.push(...stationNeeds);
      actions.push({
        type: "ASSIGN_STAFF",
        hint: {
          dateISO: appt.dateISO,
          location: appt.location || "Processing Area",
          stations: stationNeeds,
          staff, // consumer can match by toolsOwned
        },
      });

      // Procurement actions (convert deltas to actionable request)
      if (procurementDeltas.length) {
        actions.push({
          type: "PROCUREMENT_REQUEST",
          payload: {
            demand: procurementDeltas.map(d => ({ name: d.name, qty: d.qty, unit: d.unit, needBy: d.dateISO, priority: "essential", tags: ["processing_day"] })),
            links: { processingDateISO: appt.dateISO },
          },
        });
      }

      // Prep alerts: -3d/-2d/-1d and day-of 60m/15m
      const alertBlocks = [
        { offsetDays: 3, title: "Stage cones, scalder, plucker, ice, coolers", tasks: ["Deep clean & stage tools", "Verify propane/sanitizer"] },
        { offsetDays: 2, title: "Sharpen knives & stage PPE", tasks: ["Hone & test cuts", "Prepare PPE"] },
        { offsetDays: 1, title: "Mix sanitizer & pre-chill coolers", tasks: ["Prepare ice slurry", "Set chilling totes"] },
      ];
      for (const block of alertBlocks) {
        const when = date.subtract(block.offsetDays, "day").hour(9).minute(0).second(0);
        actions.push({
          type: "SCHEDULE_ALERTS",
          payload: {
            session: {
              type: "animal",
              title: block.title,
              tasks: block.tasks,
              startTime: when.toISOString(),
              notifyUsers: ctx.notifyUsers || [],
              sabbathAware: settings.sabbathAware,
            },
            options: { leadMinutes: 60, extraLeadMinutes: [1440], quietHours: settings.quietHours },
          },
        });
        calendarEvents.push({
          type: "care",
          title: block.title,
          date: when.toISOString(),
          notes: [sabNote(when, "prep"), quietNote(when)].filter(Boolean).join(" "),
        });
      }
      // Day-of checkpoint
      actions.push({
        type: "SCHEDULE_ALERTS",
        payload: {
          session: {
            type: "animal",
            title: "Processing day starts",
            tasks: ["Stations ready", "Water hot", "Ice in place"],
            startTime: procStartLocal.toISOString(),
            notifyUsers: ctx.notifyUsers || [],
            sabbathAware: settings.sabbathAware,
          },
          options: { leadMinutes: 60, extraLeadMinutes: [15], quietHours: settings.quietHours },
        },
      });

      // Processing plan snapshot
      gardenUpdates.push({
        type: "animal.processing_plan",
        dateISO: appt.dateISO,
        location: appt.location || "Processing Area",
        totals: { heads: totalHeads, carcassKg: Number(totalCarcassKg.toFixed(1)) },
        capacity: {
          coolerAllowanceKg: Number((Number.isFinite(safeNum(cap.coolerKg, NaN)) ? safeNum(cap.coolerKg, 0) : 0) * (safeNum(cap.iceKgReserve, 0) > 0 ? settings.chilling.iceAssistFactor : 1)),
          freezerKg: safeNum(cap.freezerKg, 0),
          iceReserveKg: safeNum(cap.iceKgReserve, 0),
        },
        batches,
        spillover: spillover || null,
        weather: Object.keys(fc).length ? fc : null,
        notes: [
          !coolerOk ? "Cooling capacity tight." : null,
          !freezerOk ? "Freezer tight." : null,
          iceShort > 0 ? `Add ~${iceShort} kg ice.` : null,
        ].filter(Boolean).join(" "),
      });
    }

    const summary = appointments.length
      ? `Prepared processing plans for ${appointments.length} appointment(s).`
      : "No butcher appointments provided.";

    services?.logger?.info?.(`[${this.id}] ${summary}`);

    return {
      ok: true,
      timestamp: startTs,
      summary,
      recommendations,
      calendarEvents,
      gardenUpdates,
      procurementDeltas,
      staffingHints,
      logs,
      actions,
    };
  },
};

export default ButcheringProcessingDayPrepTemplate;

/* =========================
   Internal helper functions
   ========================= */

function parseTimeOnDate(dateObj, hhmm = "07:00") {
  const [h, m] = (hhmm || "07:00").split(":").map((n) => parseInt(n, 10));
  return dayjs(dateObj).hour(h).minute(m).second(0).millisecond(0);
}

function defaultCutKeyFor(species = "") {
  const s = (species || "").toLowerCase();
  if (s.includes("chicken")) return "broiler-basic";
  if (s.includes("turkey")) return "turkey-basic";
  if (s.includes("duck")) return "duck-basic";
  if (s.includes("goat")) return "goat-basic";
  if (s.includes("pig")) return "pork-basic";
  return "generic";
}

function buildLabelItems(profile, lot) {
  const count = safeNum(lot.count, 0);
  const prefix = profile.productPrefix || title(lot.species);
  const items = [];

  if (Array.isArray(profile.items) && profile.items.length) {
    for (let i = 0; i < count; i++) {
      for (const it of profile.items) {
        items.push({
          product: `${prefix} — ${it.name}`,
          weightRangeKg: it.weightRangeKg || null,
          barcodeFormat: profile.barcodeFormat || null,
        });
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      items.push({
        product: `${prefix} — Whole`,
        weightRangeKg: null,
        barcodeFormat: profile.barcodeFormat || null,
      });
    }
  }
  return items;
}

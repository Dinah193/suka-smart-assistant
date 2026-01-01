// C:\Users\larho\suka-smart-assistant\src\services\templates\garden\SeasonalPlantingCalendarGenerator.template.js

/**
 * Seasonal Planting Calendar Generator — dynamic v2.4.0
 * - Zone-aware (explicit frost dates or resolve via services.planning.getFrostDates)
 * - Spring and optional fall windows with succession auto-stop
 * - Moon-phase nudges, indoor lead bias, season padding
 * - Procurement suggestions for seed-start + season extension gear
 * - Backward compatible outputs/actions/inputs
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const title = (s) => (s || "").replace(/\b\w/g, (m) => m.toUpperCase());

/* ----------------------------------------------------------------------------
   Coarse crop profiles (editable). Offsets relative to frost dates.
---------------------------------------------------------------------------- */
const DEFAULT_CROP_PROFILES = {
  Tomato:   { dtm: 75, cool: false, startIndoorsWksBeforeLast: 6, transplantWksAfterLast: 1, directSowWksAfterLast: null, successions: 0, family: "Solanaceae", backups: ["Early Girl", "Stupice", "Siletz"] },
  Pepper:   { dtm: 80, cool: false, startIndoorsWksBeforeLast: 8, transplantWksAfterLast: 2, directSowWksAfterLast: null, successions: 0, family: "Solanaceae", backups: ["Ace", "Carmen", "Gypsy"] },
  Eggplant: { dtm: 80, cool: false, startIndoorsWksBeforeLast: 8, transplantWksAfterLast: 2, directSowWksAfterLast: null, successions: 0, family: "Solanaceae", backups: ["Galine", "Orient Express"] },

  Cucumber: { dtm: 55, cool: false, startIndoorsWksBeforeLast: 3, transplantWksAfterLast: 1, directSowWksAfterLast: 2, successions: 1, family: "Cucurbitaceae", backups: ["Marketmore 76", "Diva"] },
  Squash:   { dtm: 60, cool: false, startIndoorsWksBeforeLast: 3, transplantWksAfterLast: 1, directSowWksAfterLast: 2, successions: 1, family: "Cucurbitaceae", backups: ["Black Beauty", "Early Prolific"] },
  Melon:    { dtm: 80, cool: false, startIndoorsWksBeforeLast: 3, transplantWksAfterLast: 2, directSowWksAfterLast: 2, successions: 0, family: "Cucurbitaceae", backups: ["Minnesota Midget", "Sugar Baby"] },

  Lettuce:  { dtm: 45, cool: true,  startIndoorsWksBeforeLast: 4, transplantWksAfterLast: -2, directSowWksAfterLast: -4, successions: 5, family: "Asteraceae", backups: ["Salad Bowl", "Black Seeded Simpson"] },
  Kale:     { dtm: 55, cool: true,  startIndoorsWksBeforeLast: 5, transplantWksAfterLast: -2, directSowWksAfterLast: -2, successions: 2, family: "Brassicaceae", backups: ["Winterbor", "Red Russian"] },
  Broccoli: { dtm: 65, cool: true,  startIndoorsWksBeforeLast: 6, transplantWksAfterLast: -2, directSowWksAfterLast: -1, successions: 1, family: "Brassicaceae", backups: ["Green Magic", "DeCicco"] },
  Cabbage:  { dtm: 75, cool: true,  startIndoorsWksBeforeLast: 6, transplantWksAfterLast: -2, directSowWksAfterLast: -1, successions: 1, family: "Brassicaceae", backups: ["Golden Acre", "Stonehead"] },

  Carrot:   { dtm: 70, cool: true,  startIndoorsWksBeforeLast: null, transplantWksAfterLast: null, directSowWksAfterLast: -3, successions: 3, family: "Apiaceae", backups: ["Napoli", "Yaya"] },
  Beet:     { dtm: 60, cool: true,  startIndoorsWksBeforeLast: null, transplantWksAfterLast: null, directSowWksAfterLast: -2, successions: 2, family: "Amaranthaceae", backups: ["Detroit Dark Red", "Cylindra"] },
  Radish:   { dtm: 28, cool: true,  startIndoorsWksBeforeLast: null, transplantWksAfterLast: null, directSowWksAfterLast: -4, successions: 6, family: "Brassicaceae", backups: ["Cherry Belle", "French Breakfast"] },

  Onion:    { dtm: 100, cool: true, startIndoorsWksBeforeLast: 10, transplantWksAfterLast: -4, directSowWksAfterLast: -4, successions: 0, family: "Alliaceae", backups: ["Candy", "Walla Walla"] },
  Spinach:  { dtm: 40, cool: true,  startIndoorsWksBeforeLast: null, transplantWksAfterLast: null, directSowWksAfterLast: -6, successions: 4, family: "Amaranthaceae", backups: ["Space", "Bloomsdale"] },
  Pea:      { dtm: 60, cool: true,  startIndoorsWksBeforeLast: 3, transplantWksAfterLast: -4, directSowWksAfterLast: -6, successions: 1, family: "Fabaceae", backups: ["Sugar Ann", "Sugar Snap"] },
};

/** Moon phase rules (coarse): 'none' | 'biodynamic' | 'waxing-waning' */
function moonAdjust(date, rule = "none", cropProfile = {}) {
  if (rule === "none") return dayjs(date);
  // Heuristic approximation: lunar month ~29.53d anchored at 2025-01-11 (new moon)
  const anchor = dayjs("2025-01-11");
  const days = dayjs(date).diff(anchor, "day");
  const pos = ((days % 30) + 30) % 30; // 0..29
  const waxing = pos < 15;

  const isFruit =
    !cropProfile.cool && ["Solanaceae", "Cucurbitaceae", "Fabaceae"].includes(cropProfile.family || "");
  const isRoot =
    cropProfile.family === "Apiaceae" ||
    cropProfile.family === "Amaranthaceae" ||
    (cropProfile.family === "Brassicaceae" && ["Radish"].includes(cropProfile.name));

  if (rule === "waxing-waning") {
    if (waxing && isFruit) return dayjs(date).add(2, "day");
    if (!waxing && isRoot) return dayjs(date).add(2, "day");
    return dayjs(date);
  }
  if (rule === "biodynamic") {
    const shift = Math.abs(days) % 2 === 0 ? 1 : -1;
    return dayjs(date).add(shift, "day");
  }
  return dayjs(date);
}

/* ----------------------------------------------------------------------------
   The standardized template object
---------------------------------------------------------------------------- */
const SeasonalPlantingCalendarGeneratorTemplate = {
  id: "seasonal-planting-calendar-generator",
  name: "Seasonal Planting Calendar Generator",
  version: "2.4.0",
  purpose: "Create zone-aware sow, transplant, and harvest dates with successions.",

  // Machine-readable triggers your orchestrator can subscribe to
  triggers: ["pre_season", "crops_changed", "zone_updated", "user_request"],

  // Minimal schema-style hints (for UI + validators)
  inputs: {
    // EITHER provide frostDates OR just usdaZone (we'll try to resolve frost with services.planning.getFrostDates)
    zoneInfo: "{ usdaZone, frostDates?:{ lastSpring, firstFall }, year?:number }",
    crops: "array[{ name, variety?, notes?, successions? }]",
    cropProfiles: "record<cropName, { dtm, cool, startIndoorsWksBeforeLast?, transplantWksAfterLast?, directSowWksAfterLast?, successions?, family?, backups?:string[] }>",
    settings:
      "object{ successionGapDays?, openUIRoute?, createCalendarEvents?, moonRule?('none'|'waxing-waning'|'biodynamic'), suggestBackups?, preferFall?, indoorLeadBiasWeeks?, seasonPaddingDays?, successionEndDateISO? }",
  },

  // Human-readable logic ladder
  logic: [
    "Resolve frost dates (use provided or fetch via services.planning.getFrostDates).",
    "Open RoutineScheduleDnD UI.",
    "Merge default + user crop profiles.",
    "For each crop: compute sow-indoors, transplant, direct-sow (spring + optional fall), and harvest windows from frost dates and settings.",
    "Apply moon-phase adjustment, indoor lead bias (±weeks), and season padding.",
    "Generate successions at fixed gap until season end (or explicit successionEndDateISO); auto-stop if harvest would miss window.",
    "Emit calendar events; build garden.planting_timeline update; suggest backups if windows are tight/late.",
    "Emit PROCUREMENT_SUGGEST for seed-start mix, trays, row cover if relevant actions exist."
  ],

  // Action identifiers consumed by your orchestrator/renderer
  actions: ["OPEN_UI", "CALENDAR_SYNC", "PROCUREMENT_SUGGEST"],

  // Output shape
  outputs: {
    gardenUpdates: "array[ {type:'garden.planting_timeline', ...} ]",
    calendarEvents: "array[ {type:'plant'|'harvest', title, date, notes?} ]",
    recommendations: "array[string]",
    logs: "array",
    actions: "array[{type, ...}]",
  },

  // Fallbacks / suggestions when timing is tight
  fallbacks: ["suggest_backup_varieties", "shift_to_fall_or_indoor_seedlings"],

  // Pre-season nudge (Mid-Jan default)
  schedule: { RRULE: "FREQ=YEARLY;BYMONTH=1;BYMONTHDAY=15;BYHOUR=9;BYMINUTE=0;BYSECOND=0" },

  // Compute upcoming run times (ISO strings)
  nextRuns(now = dayjs(), ctx = {}) {
    const last = ctx?.inputs?.zoneInfo?.frostDates?.lastSpring;
    if (last) {
      const t = dayjs(last).subtract(8, "week");
      if (t.isAfter(now)) return [t.toISOString()];
    }
    const base = now.month(0).date(15).hour(9).minute(0).second(0).millisecond(0); // Jan 15
    const t2 = base.isBefore(now) ? base.add(1, "year") : base;
    return [t2.toISOString()];
  },

  // Execute template
  async run(ctx = {}, services = {}) {
    const startTs = isoNow();
    const logs = [];
    const recommendations = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const actions = [];

    const inputs = ctx.inputs || {};
    const zoneInfo = inputs.zoneInfo || {};
    const crops = Array.isArray(inputs.crops) ? inputs.crops : [];
    const profiles = { ...DEFAULT_CROP_PROFILES, ...(inputs.cropProfiles || {}) };

    const S = {
      successionGapDays: 14,
      openUIRoute: "/tier2/garden/routine-plans",
      createCalendarEvents: true,
      moonRule: "none",               // 'none' | 'waxing-waning' | 'biodynamic'
      suggestBackups: true,
      preferFall: true,               // try to include fall windows for cool crops
      indoorLeadBiasWeeks: 0,         // ± weeks for indoor start lead
      seasonPaddingDays: 0,           // widen/contract season window globally
      successionEndDateISO: null,     // hard stop for successions if provided
      ...(inputs.settings || {}),
    };

    // Resolve frost dates
    const { lastSpring, firstFall } = await resolveFrostDates(zoneInfo, services);

    // Open RoutineScheduleDnD UI
    actions.push({
      type: "OPEN_UI",
      route: S.openUIRoute,
      component: "RoutineScheduleDnD",
      params: { plan: "planting-calendar" },
    });

    const addPad = (d, days = 0, dir = +1) => (Number.isFinite(days) && days !== 0 ? dayjs(d).add(dir * days, "day") : dayjs(d));

    // Build timeline per crop
    const timeline = []; // { crop, variety, actions:[{type, dateISO, notes}] }
    // Track if we actually scheduled indoor sow/transplant OR early/shoulder actions to drive procurement hints
    let needsSeedStartSupplies = false;
    let needsRowCover = false;

    for (const c of crops) {
      const name = c.name;
      const p = profiles[name] || {};
      if (!(p && (p.dtm || p.dtm === 0))) {
        recommendations.push(`${name}: missing DTM/profile — please review cropProfiles.`);
        continue;
      }

      const cool = !!p.cool;
      const dtm = safeNum(p.dtm, 60);
      const leadBiasW = safeNum(S.indoorLeadBiasWeeks, 0);

      // Spring windows
      const startIndoors =
        Number.isFinite(p.startIndoorsWksBeforeLast) && lastSpring
          ? moonAdjust(addPad(lastSpring, S.seasonPaddingDays, -1).subtract(p.startIndoorsWksBeforeLast + leadBiasW, "week"), S.moonRule, { ...p, name })
          : null;

      const transplant =
        Number.isFinite(p.transplantWksAfterLast) && lastSpring
          ? moonAdjust(addPad(lastSpring, S.seasonPaddingDays, +1).add(p.transplantWksAfterLast, "week"), S.moonRule, { ...p, name })
          : null;

      const directSowSpring =
        Number.isFinite(p.directSowWksAfterLast) && lastSpring
          ? moonAdjust(addPad(lastSpring, S.seasonPaddingDays, +1).add(p.directSowWksAfterLast, "week"), S.moonRule, { ...p, name })
          : null;

      // Fall direct sow for cool crops (back-schedule from firstFall)
      const directSowFall =
        cool && S.preferFall && firstFall && p.directSowWksAfterLast !== null
          ? addPad(firstFall, S.seasonPaddingDays, -1).subtract(Math.ceil(dtm / 7) + 2, "week")
          : null;

      // Choose the first actionable spring start for harvest baseline
      const primaryStart = transplant || directSowSpring || startIndoors;
      const harvestFrom = primaryStart ? dayjs(primaryStart).add(dtm, "day") : null;

      const entry = { crop: name, variety: c.variety || null, actions: [] };

      if (startIndoors) {
        entry.actions.push({
          type: "sow_indoors",
          dateISO: startIndoors.toISOString(),
          notes: `Start indoors (${p.startIndoorsWksBeforeLast + leadBiasW} wks before last frost).`,
        });
        needsSeedStartSupplies = true;
      }
      if (transplant) {
        entry.actions.push({
          type: "transplant",
          dateISO: transplant.toISOString(),
          notes: `Transplant (${p.transplantWksAfterLast} wks after last frost).`,
        });
        // If transplant is before last frost (negative offset → cool crops), suggest row cover
        if (p.transplantWksAfterLast < 0) needsRowCover = true;
      }
      if (directSowSpring) {
        entry.actions.push({
          type: "direct_sow",
          dateISO: directSowSpring.toISOString(),
          notes: `Direct sow (${p.directSowWksAfterLast} wks from last frost).`,
        });
      }
      if (directSowFall) {
        entry.actions.push({
          type: "direct_sow_fall",
          dateISO: directSowFall.toISOString(),
          notes: `Fall sow to mature ~${dtm}d before first frost.`,
        });
      }
      if (harvestFrom) {
        entry.actions.push({
          type: "harvest_window_start",
          dateISO: harvestFrom.toISOString(),
          notes: `Est. first harvest ~${dtm} days after start.`,
        });
      }

      // Successions (stop when reaching explicit end date or frost window)
      const successionGap = safeNum(S.successionGapDays, 14);
      const maxSucc = safeNum(c.successions, p.successions || 0);
      const stopAt = S.successionEndDateISO ? dayjs(S.successionEndDateISO) : (firstFall || null);
      if (maxSucc > 0 && (directSowSpring || transplant)) {
        const firstDate = transplant || directSowSpring;
        for (let i = 1; i <= maxSucc; i++) {
          let sDate = dayjs(firstDate).add(i * successionGap, "day");
          sDate = moonAdjust(sDate, S.moonRule, { ...p, name });
          const sHarvest = sDate.add(dtm, "day");
          // For warm crops, avoid harvest after firstFall; for cool crops allow into cool shoulder
          if (stopAt && !cool && sHarvest.isAfter(stopAt)) break;
          if (stopAt && cool && firstFall && sHarvest.isAfter(dayjs(firstFall).add(S.seasonPaddingDays, "day"))) break;

          entry.actions.push({
            type: "succession_sow",
            dateISO: sDate.toISOString(),
            notes: `Succession ${i} (+${i * successionGap}d).`,
          });
          entry.actions.push({
            type: "harvest_window_start",
            dateISO: sHarvest.toISOString(),
            notes: `Succession ${i} harvest begins.`,
          });
        }
      }

      timeline.push(entry);

      // Calendar events
      if (S.createCalendarEvents) {
        for (const act of entry.actions) {
          const label = `${act.type.replace(/_/g, " ")} — ${name}${c.variety ? " (" + c.variety + ")" : ""}`;
          calendarEvents.push({
            type: ["harvest_window_start"].includes(act.type) ? "harvest" : "plant",
            title: title(label),
            date: act.dateISO,
            notes: act.notes,
          });
        }
      }

      // Backups / fallback suggestions
      if (S.suggestBackups && Array.isArray(p.backups) && p.backups.length) {
        const firstAction = entry.actions.map((a) => a.dateISO).sort()[0];
        if (firstAction) {
          const fa = dayjs(firstAction);
          const lateSpring =
            !!lastSpring && fa.isBefore(dayjs().subtract(14, "day"));
          const warmTooLate =
            !cool && firstFall && fa.add(dtm, "day").isAfter(firstFall);
          if (lateSpring || warmTooLate) {
            recommendations.push(`${name}: window tight/late — consider backup varieties: ${p.backups.join(", ")}.`);
          }
        }
      }
    }

    // Garden update: timeline plan for RoutineScheduleDnD
    gardenUpdates.push({
      type: "garden.planting_timeline",
      zone: zoneInfo?.usdaZone || null,
      frostDates: { lastSpring: lastSpring?.toISOString() || null, firstFall: firstFall?.toISOString() || null },
      moonRule: S.moonRule,
      plan: timeline,
      createdISO: isoNow(),
    });

    // Calendar sync action
    if (S.createCalendarEvents) actions.push({ type: "CALENDAR_SYNC", events: calendarEvents });

    // Procurement suggestions (lightweight, consolidated)
    const demand = [];
    if (needsSeedStartSupplies) {
      demand.push(
        { name: "Seed-Starting Mix", sku: "seed-start-mix", qty: 1, unit: "bag", priority: "staple", tags: ["garden","seed_start"] },
        { name: "Cell Trays (72)", sku: "tray-72", qty: 2, unit: "ea", priority: "staple", tags: ["garden","seed_start"] }
      );
    }
    if (needsRowCover) {
      demand.push(
        { name: "Row Cover (Agribon 19)", sku: "row-cover", qty: 1, unit: "roll", priority: "essential", tags: ["garden","season_extension"] },
        { name: "Wire Hoops", sku: "low-tunnel-hoops", qty: 10, unit: "ea", priority: "staple", tags: ["garden","season_extension"] }
      );
    }
    if (demand.length) {
      actions.push({ type: "PROCUREMENT_SUGGEST", payload: { demand, reason: "planting_calendar_seed_start_and_cover" } });
    }

    const summary = timeline.length
      ? `Generated planting calendar for ${timeline.length} crop(s) — zone ${zoneInfo?.usdaZone || "n/a"}.`
      : "No crops provided or profiles missing.";

    // Open UI with plan preloaded
    actions.push({
      type: "OPEN_UI",
      route: S.openUIRoute,
      component: "RoutineScheduleDnD",
      params: { plan: "planting-calendar", initialData: timeline },
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

export default SeasonalPlantingCalendarGeneratorTemplate;

/* =========================
   Internal helper functions
   ========================= */

async function resolveFrostDates(zoneInfo = {}, services = {}) {
  // If frost dates provided, use them
  if (zoneInfo?.frostDates?.lastSpring && zoneInfo?.frostDates?.firstFall) {
    return {
      lastSpring: dayjs(zoneInfo.frostDates.lastSpring),
      firstFall: dayjs(zoneInfo.frostDates.firstFall),
    };
  }
  // Try to resolve via service if usdaZone present
  const zone = zoneInfo?.usdaZone;
  const year = safeNum(zoneInfo?.year, dayjs().year());
  if (zone && services?.planning?.getFrostDates) {
    try {
      const f = await services.planning.getFrostDates(zone, year);
      return { lastSpring: dayjs(f.last), firstFall: dayjs(f.first) };
    } catch (_e) { /* ignore and fall through */ }
  }
  // Fallback: assume conservative long season around mid-April to mid-Nov for unknown zone
  const y = safeNum(zoneInfo?.year, dayjs().year());
  return {
    lastSpring: dayjs(`${y}-04-20`),
    firstFall: dayjs(`${y}-11-10`),
  };
}

/* ----------------------------------------------------------------------------
USAGE

import tpl from "@/services/templates/garden/SeasonalPlantingCalendarGenerator.template";

const res = await tpl.run({
  now: new Date(),
  inputs: {
    zoneInfo: { usdaZone: "8a", frostDates: { lastSpring: "2025-03-20", firstFall: "2025-11-05" } },
    crops: [
      { name: "Tomato", variety: "Sungold" },
      { name: "Lettuce", successions: 4 },
      { name: "Cucumber", successions: 2 },
      { name: "Carrot", successions: 3 },
    ],
    cropProfiles: {
      // optional overrides
      Tomato: { dtm: 65, startIndoorsWksBeforeLast: 6, transplantWksAfterLast: 1 },
    },
    settings: {
      // optional toggles
      // moonRule: "waxing-waning",
      // successionGapDays: 14,
      // indoorLeadBiasWeeks: 1,
      // seasonPaddingDays: 7,
      // createCalendarEvents: true,
      // preferFall: true,
    },
  },
});
---------------------------------------------------------------------------- */

// C:\Users\larho\suka-smart-assistant\src\services\templates\animal\BreedingCyclePlanner.template.js
/**
 * Breeding Cycle Planner — standardized template contract (dynamic v2.2)
 *
 * Contract fields (back-compat preserved):
 * - id, name, version, purpose
 * - triggers[]: machine-readable event keys
 * - inputs: schema-ish description for UI/validators
 * - logic[]: human-readable steps
 * - actions[]: identifiers your orchestrator understands
 * - outputs: shape description of returned data
 * - fallbacks[]: graceful options when capacity/season conflicts occur
 * - schedule: RRULE hints for auto-scheduling
 * - nextRuns(now): compute upcoming run times (ISO)
 * - run(ctx, services): execute → { ok, summary, gardenUpdates, calendarEvents, actions, ... }
 *
 * New in 2.2:
 * - Pair selection & rest windows (avoid overusing the same pair)
 * - Fertility buffers & stochastic yield (hatch/gestation success)
 * - Capacity “reservation ledger” output for brooder/growout/maternity
 * - Season gating + Sabbath/quiet-hour notes on scheduled actions
 * - Procurement links: feed & supplies deltas for brooder/growout windows
 * - Calendar-friendly event shapes + alert scheduling action hints
 * - Graceful fallbacks: delay window | reduce batch | stagger batches
 */

import dayjs from "dayjs";

/* ----------------------------------------------------------------------------
   Helpers
---------------------------------------------------------------------------- */
const isoNow = () => new Date().toISOString();
const safeNum = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const keyOf = (s) => String(s || "").toLowerCase().trim().replace(/\s+/g, "_");
const fmt = (d) => dayjs(d).format("YYYY-MM-DD");

/** simple pseudo-random but deterministic per key */
function seededRand(key) {
  let h = 2166136261 >>> 0;
  const str = String(key);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  // 0..1
  return (h >>> 0) / 0xffffffff;
}

/* ----------------------------------------------------------------------------
   Defaults
---------------------------------------------------------------------------- */
const DEFAULTS = {
  shiftStepDays: 7,
  maxShiftAttempts: 10,
  seasonWindow: null, // { startISO, endISO }
  defaultStages: {
    brooderDays: 21,  // time chicks/kids require brooder/close care
    growoutDays: 28,  // time in grow-out before “targetBy”
    maternityDays: 14 // pen recovery / maternity pen booking
  },
  pairRestDays: 7,          // minimum rest between introductions for a pair
  sabbathAware: true,        // annotate/avoid Friday eve & Saturday activities
  quietHours: { start: "22:00", end: "07:00" }, // annotate alerts
  openUIRoute: "/tier2/animal/breeding",
  feedDefaults: {            // coarse feed needs per head per day (kg)
    brooder: 0.06,           // chicks / young
    growout: 0.12            // growers
  }
};

/* ----------------------------------------------------------------------------
   The standardized template object
---------------------------------------------------------------------------- */
const BreedingCyclePlannerTemplate = {
  id: "breeding-cycle-planner",
  name: "Breeding Cycle Planner",
  version: "2.2.0",
  purpose:
    "Back-plan breeding to hit target dates while respecting brooder/grow-out/housing capacity, pair rest windows, and feed constraints. Emits calendar events, alerts, and procurement deltas.",

  // Machine-readable triggers your orchestrator can subscribe to
  triggers: ["season_start", "user_goal_set", "weekly_scan_monday", "user_request"],

  // Minimal schema-style hints (for UI + validators)
  inputs: {
    pairs:
      "array[{ species, pairId, maleId?, femaleId?, fertilityRatePct?, lastIntroISO?, geneticsTag? }]",
    speciesProfiles:
      "record<species, { incubationDays? /* birds */, gestationDays? /* mammals */, brooderDays?, growoutDays?, maternityDays? }>",
    housing:
      "object{ brooder?:number, growout?:number, maternity?:number, pens?:number } /* simultaneous headcount caps */",
    goals:
      "array[{ species, quantity:number, targetByISO:ISO, product?:'broiler'|'meat'|'market'|'kids'|string, fertilityRatePct? }]",
    settings:
      "object{ shiftStepDays?, maxShiftAttempts?, seasonWindow?:{startISO,endISO}, defaultStages?, pairRestDays?, sabbathAware?, quietHours?, openUIRoute?, feedDefaults? }",
    // Optional existing bookings to consider during capacity checks:
    existingBookings:
      "array[{ stage:'brooder'|'growout'|'maternity', startISO, endISO, count:number }]",
  },

  // Human-readable logic ladder
  logic: [
    "For each goal: select species profile and stage durations.",
    "Back-calc hatch/birth and breed/intro dates from target date and stage lengths.",
    "Pick eligible breeding pairs (rested, species-matching, genetics diversity).",
    "Check capacity for maternity, brooder, grow-out windows against existing bookings.",
    "If conflict: shift plan forward by step days until it fits or attempts exhausted.",
    "Emit calendar events, alert hints, care tasks, and procurement deltas for feed.",
  ],

  // Action identifiers consumed by your orchestrator/renderer
  actions: ["OPEN_UI", "SCHEDULE", "SCHEDULE_ALERTS", "LOG"],

  // Output shape
  outputs: {
    gardenUpdates:
      "array[ {type:'animal.breeding_plan'|'animal.care_tasks'|'capacity.reservation', ...} ]",
    calendarEvents:
      "array[ {type:'breed'|'hatch'|'care'|'warning', title, date, notes?, rrule?} ]",
    recommendations: "array[string]",
    procurementDeltas:
      "array[{ phase:'brooder'|'growout', name:'feed', unit:'kg', qty:number, dateISO:string, reason:string }]",
    logs: "array",
    actions: "array[{type, ...}]",
  },

  // Fallbacks for constraints
  fallbacks: ["delay_to_next_window", "reduce_batch_size", "stagger_batches"],

  // Scheduling hints
  schedule: {
    weekly: { RRULE: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=8;BYMINUTE=0;BYSECOND=0" },
  },

  // Compute upcoming run times (ISO strings)
  nextRuns(now = dayjs()) {
    const base = now.day(1).hour(8).minute(0).second(0).millisecond(0); // next Monday 08:00
    const t = base.isBefore(now) ? base.add(1, "week") : base;
    // Also allow a same-day “user request” run at the next half-hour
    const halfHour = now.minute() < 30 ? now.minute(30) : now.add(1, "hour").minute(0);
    return [t.toISOString(), halfHour.second(0).millisecond(0).toISOString()];
  },

  // Execute template
  async run(ctx = {}, services = {}) {
    const startedAt = isoNow();
    const logs = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const recommendations = [];
    const actions = [];
    const procurementDeltas = [];

    const now = dayjs(ctx.now || new Date());
    const pairs = Array.isArray(ctx.inputs?.pairs) ? ctx.inputs.pairs : [];
    const profiles = ctx.inputs?.speciesProfiles || {};
    const housing = ctx.inputs?.housing || {};
    const goals = Array.isArray(ctx.inputs?.goals) ? ctx.inputs.goals : [];
    const existing = Array.isArray(ctx.existingBookings) ? ctx.existingBookings : [];

    const settings = {
      ...DEFAULTS,
      ...(ctx.inputs?.settings || {}),
      defaultStages: {
        ...DEFAULTS.defaultStages,
        ...(ctx.inputs?.settings?.defaultStages || {}),
      },
      feedDefaults: {
        ...DEFAULTS.feedDefaults,
        ...(ctx.inputs?.settings?.feedDefaults || {}),
      },
    };

    // Optional UI open
    actions.push({
      type: "OPEN_UI",
      route: settings.openUIRoute,
      component: "AnimalBreedingPlanner",
      params: {},
    });

    // Capacity ledger
    const capacity = {
      brooder: safeNum(housing.brooder, Infinity),
      growout: safeNum(housing.growout, Infinity),
      maternity: safeNum(housing.maternity, 0),
      pens: safeNum(housing.pens, 0),
    };

    /* ---------- Local helpers ---------- */
    const season = settings.seasonWindow || null;
    const seasonStart = season?.startISO ? dayjs(season.startISO) : null;
    const seasonEnd = season?.endISO ? dayjs(season.endISO) : null;
    const inSeason = (iso) => {
      if (!seasonStart || !seasonEnd) return true;
      const d = dayjs(iso);
      return (d.isSame(seasonStart, "day") || d.isAfter(seasonStart)) &&
             (d.isSame(seasonEnd, "day")   || d.isBefore(seasonEnd));
    };

    const overlaps = (a1, a2, b1, b2) => dayjs(a1).isBefore(b2) && dayjs(b1).isBefore(a2);
    const stageWindow = (startISO, days) => {
      const s = dayjs(startISO);
      return { startISO: s.toISOString(), endISO: s.add(days, "day").toISOString() };
    };
    const sabbathNoteFor = (iso, thing) => {
      if (!settings.sabbathAware) return null;
      const d = dayjs(iso);
      const dow = d.day();
      if (dow === 5) return `Sabbath-aware: finish active ${thing} work before Friday sunset.`;
      if (dow === 6) return `Sabbath-aware: prefer no active ${thing} until after Saturday sunset.`;
      return null;
    };
    const quietNoteFor = (iso) => {
      const d = new Date(iso);
      const [sh, sm] = (settings.quietHours?.start || "22:00").split(":").map(Number);
      const [eh, em] = (settings.quietHours?.end   || "07:00").split(":").map(Number);
      const dayStart = new Date(d); dayStart.setHours(sh, sm || 0, 0, 0);
      const dayEnd   = new Date(d); dayEnd.setHours(eh, em || 0, 0, 0);
      const crosses = dayStart > dayEnd;
      const inQuiet = crosses ? (d >= dayStart || d <= dayEnd) : (d >= dayStart && d <= dayEnd);
      return inQuiet ? `Quiet-hours aware: notifications may be deferred outside ${settings.quietHours.start}-${settings.quietHours.end}.` : null;
    };

    function fitsCapacity(stage, planWindow, countNeeded) {
      const cap = capacity[stage] ?? Infinity;
      if (!Number.isFinite(cap)) return true;
      let concurrent = 0;
      existing
        .filter((b) => b.stage === stage)
        .forEach((b) => {
          if (overlaps(planWindow.startISO, planWindow.endISO, b.startISO, b.endISO)) {
            concurrent += safeNum(b.count, 0);
          }
        });
      return concurrent + countNeeded <= cap;
    }

    function selectPairs(species, introISO, needed) {
      // Eligible pairs: matching species & rested
      const list = pairs.filter((p) => p.species === species);
      const eligible = list.filter((p) => {
        const last = p.lastIntroISO ? dayjs(p.lastIntroISO) : null;
        if (!last) return true;
        return dayjs(introISO).diff(last, "day") >= safeNum(settings.pairRestDays, 7);
      });
      // sort to rotate: least-recent first, then deterministic by pairId hash
      eligible.sort((a, b) => {
        const al = a.lastIntroISO ? dayjs(a.lastIntroISO).valueOf() : 0;
        const bl = b.lastIntroISO ? dayjs(b.lastIntroISO).valueOf() : 0;
        if (al !== bl) return al - bl;
        return seededRand(a.pairId) - seededRand(b.pairId);
      });

      // Pick as many as we have pens or pairs available (soft cap by pens)
      const maxPairs = Number.isFinite(capacity.pens) ? Math.max(1, capacity.pens) : Math.max(1, eligible.length);
      const take = Math.min(maxPairs, Math.max(1, eligible.length));
      const picked = eligible.slice(0, take);
      // Estimate yield via fertility
      const fertility = (avgPct) => clamp(avgPct / 100, 0.5, 1.0);
      const avgFert = picked.reduce((s, p) => s + safeNum(p.fertilityRatePct, 85), 0) / Math.max(1, picked.length);
      const expected = Math.ceil(needed / Math.max(0.01, fertility(avgFert)));

      return { picked, expectedEggsOrCovers: expected, avgFertPct: avgFert };
    }

    function planGoal(goal) {
      const sp = goal.species;
      const prof = profiles[sp] || {};
      const defaults = settings.defaultStages;

      // Determine incubation or gestation
      const isIncubation = Number.isFinite(prof.incubationDays);
      const reproductiveDays = safeNum(
        isIncubation ? prof.incubationDays : prof.gestationDays,
        isIncubation ? 21 : 150
      );

      // Stage durations
      const brooderDays = safeNum(prof.brooderDays, defaults.brooderDays);
      const growoutDays = safeNum(prof.growoutDays, defaults.growoutDays);
      const maternityDays = safeNum(prof.maternityDays, defaults.maternityDays);

      // Quantity & fertility buffer (goal overrides pairs avg if provided)
      const qty = Math.max(1, safeNum(goal.quantity, 1));
      const targetBy = dayjs(goal.targetByISO || now);
      const product = (goal.product || "").toLowerCase();
      const endAtGrowout = ["broiler", "meat", "market"].some((k) => product.includes(k));

      // Timeline math
      const growoutEnd = targetBy;
      const brooderEnd = endAtGrowout ? growoutEnd.subtract(growoutDays, "day") : growoutEnd;
      const hatchOrBirth = brooderEnd.subtract(brooderDays, "day");
      const introBreed = hatchOrBirth.subtract(reproductiveDays, "day");

      // Pair selection & expected coverage
      const pairSel = selectPairs(sp, introBreed.toISOString(), qty);
      const fertPct = Number.isFinite(goal.fertilityRatePct) ? goal.fertilityRatePct : pairSel.avgFertPct;
      const eggsOrCoversNeeded = Math.ceil(qty / Math.max(0.5, fertPct/100));

      return {
        species: sp,
        qty,
        eggsOrCoversNeeded,
        isIncubation,
        reproductiveDays,
        brooderDays,
        growoutDays,
        maternityDays,
        product: product || "general",
        targetByISO: targetBy.toISOString(),
        hatchOrBirthISO: hatchOrBirth.toISOString(),
        introBreedISO: introBreed.toISOString(),
        pairs: pairSel.picked,
        windows: {
          maternity: stageWindow(introBreed.toISOString(), maternityDays),
          reproduction: stageWindow(introBreed.toISOString(), reproductiveDays),
          brooder: stageWindow(hatchOrBirth.toISOString(), brooderDays),
          growout: stageWindow(brooderEnd.toISOString(), growoutDays),
        },
      };
    }

    function resolveCapacity(planDraft) {
      const step = safeNum(settings.shiftStepDays, 7);
      const maxAttempts = safeNum(settings.maxShiftAttempts, 10);
      let attempt = 0;
      let plan = { ...planDraft };

      while (attempt <= maxAttempts) {
        const fits =
          fitsCapacity("maternity", plan.windows.maternity, Math.min(plan.qty, capacity.maternity || plan.qty)) &&
          fitsCapacity("brooder", plan.windows.brooder, plan.qty) &&
          fitsCapacity("growout", plan.windows.growout, plan.qty) &&
          (!capacity.pens || plan.pairs.length <= capacity.pens);

        const allInSeason =
          inSeason(plan.introBreedISO) &&
          inSeason(plan.hatchOrBirthISO) &&
          inSeason(plan.windows.growout.endISO);

        if (fits && allInSeason) return { plan, shiftedDays: attempt * step, attempts: attempt };

        // shift all windows forward
        const shift = (iso) => dayjs(iso).add(step, "day").toISOString();
        plan = {
          ...plan,
          introBreedISO: shift(plan.introBreedISO),
          hatchOrBirthISO: shift(plan.hatchOrBirthISO),
          targetByISO: shift(plan.targetByISO),
          windows: {
            maternity: { startISO: shift(plan.windows.maternity.startISO), endISO: shift(plan.windows.maternity.endISO) },
            reproduction: { startISO: shift(plan.windows.reproduction.startISO), endISO: shift(plan.windows.reproduction.endISO) },
            brooder: { startISO: shift(plan.windows.brooder.startISO), endISO: shift(plan.windows.brooder.endISO) },
            growout: { startISO: shift(plan.windows.growout.startISO), endISO: shift(plan.windows.growout.endISO) },
          },
        };
        attempt += 1;
      }
      return { plan: planDraft, shiftedDays: null, attempts: attempt, failed: true };
    }

    /* ---------- Build plans for each goal ---------- */
    const capacityReservations = [];
    const planned = [];

    for (const g of goals) {
      const draft = planGoal(g);
      const { plan, shiftedDays, failed } = resolveCapacity(draft);
      planned.push({ goal: g, plan, shiftedDays, failed });

      const baseTitle = `${plan.species} — ${plan.product}`;
      const sabBreed = sabbathNoteFor(plan.introBreedISO, "breeding");
      const sabHatch = sabbathNoteFor(plan.hatchOrBirthISO, "care");
      const qBreed = quietNoteFor(plan.introBreedISO);

      // Calendar events (ICS-friendly)
      calendarEvents.push({
        type: "breed",
        title: `Introduce breeders: ${baseTitle}`,
        date: plan.introBreedISO,
        notes: [
          `Target: ${g.quantity} by ${fmt(plan.targetByISO)}`,
          plan.pairs.length ? `Pairs: ${plan.pairs.map(p => p.pairId).join(", ")}` : "Pairs TBD",
          sabBreed, qBreed
        ].filter(Boolean).join(" • ")
      });
      calendarEvents.push({
        type: "hatch",
        title: `Expected hatch/birth: ${baseTitle}`,
        date: plan.hatchOrBirthISO,
        notes: [
          `${plan.isIncubation ? "Incubation" : "Gestation"} ${plan.reproductiveDays} days`,
          sabHatch
        ].filter(Boolean).join(" • ")
      });
      calendarEvents.push({
        type: "care",
        title: `Brooder care window: ${baseTitle}`,
        date: plan.windows.brooder.startISO,
        rrule: `FREQ=DAILY;UNTIL=${dayjs(plan.windows.brooder.endISO).utc().format("YYYYMMDD[T]HHmmss[Z]")}`,
        notes: `Through ${fmt(plan.windows.brooder.endISO)} (${plan.brooderDays}d)`
      });
      calendarEvents.push({
        type: "care",
        title: `Grow-out window: ${baseTitle}`,
        date: plan.windows.growout.startISO,
        notes: `Through ${fmt(plan.windows.growout.endISO)} (${plan.growoutDays}d)`
      });

      if (failed) {
        calendarEvents.push({
          type: "warning",
          title: `Capacity exceeded: ${baseTitle}`,
          date: isoNow(),
          notes: "Fallback: delayed to next optimal window not possible within shift attempts."
        });
        recommendations.push(
          `${plan.species}: capacity conflict. Increase housing or reduce batch size; consider staggering by additional weeks.`
        );
      } else if (shiftedDays && shiftedDays > 0) {
        recommendations.push(`${plan.species}: start shifted by ${shiftedDays} day(s) to respect capacity.`);
      }

      // Capacity reservations for downstream schedulers
      const resv = [
        { stage: "maternity", window: plan.windows.maternity, count: Math.min(plan.qty, capacity.maternity || plan.qty) },
        { stage: "brooder",   window: plan.windows.brooder,   count: plan.qty },
        { stage: "growout",   window: plan.windows.growout,   count: plan.qty },
      ];
      resv.forEach(r => capacityReservations.push({
        ...r,
        species: plan.species,
        product: plan.product
      }));

      // Actions for scheduler & alerts
      actions.push(
        {
          type: "SCHEDULE",
          event: {
            kind: "breed_introduction",
            dateISO: plan.introBreedISO,
            meta: { species: plan.species, qty: plan.qty, product: plan.product, pairs: plan.pairs.map(p => p.pairId) }
          }
        },
        {
          type: "SCHEDULE",
          event: {
            kind: "expected_hatch_birth",
            dateISO: plan.hatchOrBirthISO,
            meta: { species: plan.species, qty: plan.qty, product: plan.product, days: plan.reproductiveDays }
          }
        },
        {
          type: "SCHEDULE_ALERTS", // consumed by your alerts service (scheduleSessionAlerts)
          payload: {
            session: {
              type: "animal",
              title: `Introduce breeders: ${baseTitle}`,
              tasks: ["Set/verify incubator or mating pen", "Confirm water/feed available"],
              startTime: plan.introBreedISO,
              notifyUsers: ctx.notifyUsers || [],
              recurrence: null,
              sabbathAware: settings.sabbathAware,
            },
            options: { leadMinutes: 60, extraLeadMinutes: [1440], quietHours: settings.quietHours }
          }
        }
      );

      // Garden updates (plan + recurring care)
      gardenUpdates.push({
        type: "animal.breeding_plan",
        species: plan.species,
        product: plan.product,
        quantity: plan.qty,
        eggsOrCoversNeeded: plan.eggsOrCoversNeeded,
        pairs: plan.pairs.map(p => ({ pairId: p.pairId, maleId: p.maleId, femaleId: p.femaleId })),
        introBreedISO: plan.introBreedISO,
        hatchOrBirthISO: plan.hatchOrBirthISO,
        stages: plan.windows,
        notes: shiftedDays ? `Start shifted ${shiftedDays}d to fit capacity.` : undefined
      });

      gardenUpdates.push({
        type: "animal.care_tasks",
        species: plan.species,
        tasks: [
          { title: "Prep brooder (heat, bedding, feeders)", dateISO: dayjs(plan.hatchOrBirthISO).subtract(2, "day").toISOString() },
          { title: "Daily brooder checks", dateISO: plan.windows.brooder.startISO, repeat: "DAILY", untilISO: plan.windows.brooder.endISO },
          { title: "Prep grow-out housing", dateISO: plan.windows.brooder.endISO }
        ]
      });

      // Capacity reservation updates
      resv.forEach((r) => {
        gardenUpdates.push({
          type: "capacity.reservation",
          stage: r.stage,
          species: plan.species,
          startISO: r.window.startISO,
          endISO: r.window.endISO,
          count: r.count
        });
      });

      // Procurement: simple feed deltas for planning window
      const fd = settings.feedDefaults || {};
      const daysBrooder = dayjs(plan.windows.brooder.endISO).diff(dayjs(plan.windows.brooder.startISO), "day");
      const daysGrowout = dayjs(plan.windows.growout.endISO).diff(dayjs(plan.windows.growout.startISO), "day");
      if (daysBrooder > 0) {
        procurementDeltas.push({
          phase: "brooder",
          name: "feed",
          unit: "kg",
          qty: +(plan.qty * fd.brooder * daysBrooder).toFixed(2),
          dateISO: plan.windows.brooder.startISO,
          reason: `${plan.qty} head x ${fd.brooder}kg/day x ${daysBrooder}d`
        });
      }
      if (daysGrowout > 0) {
        procurementDeltas.push({
          phase: "growout",
          name: "feed",
          unit: "kg",
          qty: +(plan.qty * fd.growout * daysGrowout).toFixed(2),
          dateISO: plan.windows.growout.startISO,
          reason: `${plan.qty} head x ${fd.growout}kg/day x ${daysGrowout}d`
        });
      }
    }

    // Summary & diagnostic log
    const summary = `Planned ${planned.length} breeding cycle(s).`;
    logs.push({ at: startedAt, msg: summary });

    // Optional logging hook
    services?.logger?.info?.(`[${this.id}] ${summary}`);

    return {
      ok: true,
      timestamp: startedAt,
      summary,
      recommendations,
      calendarEvents,
      gardenUpdates,
      procurementDeltas,
      capacityReservations,
      logs,
      actions
    };
  },
};

export default BreedingCyclePlannerTemplate;

/* ----------------------------------------------------------------------------
USAGE

1) Place file at:
   src/services/templates/animal/BreedingCyclePlanner.template.js

2) Ensure your bootstrap calls the registrar once:
   import engine from '@/services/automation/engine';
   import { autoRegisterAllTemplates } from '@/services/automation/autoRegisterTemplates';
   await autoRegisterAllTemplates(engine);

3) Example payload

const inputs = {
  pairs: [
    { species: 'Chicken', pairId: 'CK-01', fertilityRatePct: 85, lastIntroISO: '2025-03-01' },
    { species: 'Chicken', pairId: 'CK-02', fertilityRatePct: 80, lastIntroISO: '2025-03-10' },
  ],
  speciesProfiles: {
    Chicken: { incubationDays: 21, brooderDays: 21, growoutDays: 35 },
    Goat: { gestationDays: 150, maternityDays: 14, growoutDays: 90 }
  },
  housing: { brooder: 40, growout: 60, maternity: 4, pens: 6 },
  goals: [
    { species: 'Chicken', quantity: 20, targetByISO: '2025-05-15', product: 'broiler' },
    { species: 'Goat', quantity: 2,  targetByISO: '2026-03-01', product: 'kids' },
  ],
  settings: {
    // optional overrides:
    // shiftStepDays: 7,
    // pairRestDays: 10,
    // seasonWindow: { startISO: '2025-02-01', endISO: '2025-10-31' },
    // sabbathAware: true,
    // quietHours: { start: '21:30', end: '07:30' },
    // feedDefaults: { brooder: 0.07, growout: 0.14 }
  }
};

import planner from '@/services/templates/animal/BreedingCyclePlanner.template';
const res = await planner.run({ now: new Date(), inputs, notifyUsers: [{ name:'Larho', email:'you@example.com', preference:'email' }] });

---------------------------------------------------------------------------- */

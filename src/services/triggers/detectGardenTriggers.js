// File: C:\Users\larho\suka-smart-assistant\src\services\triggers\detectGardenTriggers.js
/**
 * detectGardenTriggers (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Analyze current household + garden state + plans + inventory + weather hints
 *    and emit actionable "triggers" (nudges, reminders, session candidates)
 *    for the Gardening domain.
 *
 * Design goals
 *  - Browser-safe (no Node imports).
 *  - Offline-first (Dexie optional; operates with passed-in context).
 *  - Deterministic: same inputs -> same triggers (no AI, no randomness).
 *  - Extensible: rules registry with enable/disable and per-rule weights.
 *  - Safe: never throws on missing modules; returns best-effort results.
 *
 * Outputs are intended to be consumed by:
 *  - Planner / SessionOrchestrator (to build session blueprints)
 *  - Dashboard KPIs + action cards
 *  - Notification scheduling layer (optional)
 *
 * -----------------------------------------------------------------------------
 * Expected (optional) input context shape
 * -----------------------------------------------------------------------------
 * ctx = {
 *   now: Date | ISO,
 *   householdId: string,
 *   zone?: string,                     // IANA timezone (optional)
 *   prefs: { ... }                     // gardening prefs (quiet hours, sabbath)
 *   beds: [                            // normalized garden beds/areas
 *     {
 *       id, name,
 *       type?: "raised"|"in-ground"|"container"|"orchard"|"greenhouse",
 *       location?: { lat?, lon?, address? },
 *       soil?: { lastTestAt?, ph?, notes? },
 *       irrigation?: { lastWateredAt?, method?, schedule? },
 *       lastWeededAt?: ISO,
 *       lastMulchedAt?: ISO,
 *       lastInspectedAt?: ISO,
 *       notes?: string
 *     }
 *   ],
 *   plantings: [                        // normalized plantings/crops
 *     {
 *       id, bedId, crop, variety?,
 *       plantedAt?, startedAt?, transplantAt?,
 *       stage?: "seed"|"seedling"|"veg"|"flower"|"fruit"|"harvest"|"done",
 *       expectedHarvestAt?, lastHarvestAt?,
 *       watering?: { intervalDays?, lastAt? },
 *       fertilizing?: { intervalDays?, lastAt?, type? },
 *       pest?: { lastInspectAt?, concern? },
 *       qty?: number,
 *       tags?: string[],
 *       status?: "active"|"done"
 *     }
 *   ],
 *   inventory: {
 *     items?: [{ id, name, qty, unit, tags?: string[] }]
 *   },
 *   plans: {
 *     garden?: [{ dayISO, title, tasks?, bedIds?, plantingIds? }]
 *   },
 *   logs: {
 *     gardenTasks?: [{ atISO, type, bedId?, plantingId?, meta? }]
 *   },
 *   weather: {
 *     // Optional hints (do NOT require live API)
 *     // Provide what you have; service will be best-effort.
 *     forecast?: {
 *       nextRainAtISO?: string,
 *       rainProbabilityPct?: number,
 *       frostRisk?: "low"|"medium"|"high",
 *       heatRisk?: "low"|"medium"|"high"
 *     }
 *   }
 * }
 *
 * -----------------------------------------------------------------------------
 * Tooling hooks (optional)
 * -----------------------------------------------------------------------------
 * - Emits to eventBus if available:
 *    • "triggers.garden.detected" with payload { householdId, triggers }
 *
 * - Logs to DashboardLog if available:
 *    • category: "Garden" with summary counts
 */

const SOURCE = "services.triggers.detectGardenTriggers";

/* -----------------------------------------------------------------------------
 * Optional deps (safe)
 * -------------------------------------------------------------------------- */

let DashboardLog = null;
try {
  const mod = await import("../dashboard/DashboardLog.js").catch(() => null);
  DashboardLog = mod?.default || mod?.DashboardLog || null;
} catch {
  DashboardLog = null;
}

let bus = null;
const BUS_CANDIDATES = [
  () => import("../automation/eventBus.js"),
  () => import("../events/eventBus.js"),
  () => import("../automation/runtime.js"),
  () => import("../../services/automation/eventBus.js"),
];
for (const load of BUS_CANDIDATES) {
  try {
    const mod = await load().catch(() => null);
    const b =
      mod?.eventBus ||
      mod?.bus ||
      mod?.default?.eventBus ||
      mod?.default ||
      mod;
    if (
      b &&
      (typeof b.emit === "function" || typeof b.publish === "function")
    ) {
      bus = b;
      break;
    }
  } catch {
    /* keep trying */
  }
}

/* -----------------------------------------------------------------------------
 * Utils
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const toDate = (x) => (x instanceof Date ? x : new Date(x));
const toISO = (x) => toDate(x).toISOString();
const nowISO = () => new Date().toISOString();

function tryEmit(event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

function daysBetween(a, b) {
  const da = toDate(a).getTime();
  const db = toDate(b).getTime();
  return Math.round((db - da) / 86400000);
}

function hoursBetween(a, b) {
  const da = toDate(a).getTime();
  const db = toDate(b).getTime();
  return (db - da) / 3600000;
}

function uniqBy(items, keyFn) {
  const out = [];
  const seen = new Set();
  for (const it of safeArr(items)) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function addDays(date, n) {
  const d = toDate(date);
  const x = new Date(d);
  x.setDate(x.getDate() + Number(n || 0));
  return x;
}

function isoDateKey(d) {
  const dt = toDate(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/* -----------------------------------------------------------------------------
 * Trigger shape + helpers
 * -------------------------------------------------------------------------- */
/**
 * Trigger:
 * {
 *   id: string,
 *   domain: "garden",
 *   kind: "session_candidate"|"dashboard_nudge"|"inventory_refill"|"reminder",
 *   severity: "info"|"warn"|"high",
 *   title: string,
 *   message: string,
 *   whenISO?: string,
 *   bedIds?: string[],
 *   plantingIds?: string[],
 *   tags?: string[],
 *   score?: number,
 *   ruleId: string,
 *   meta?: object
 * }
 */

function makeTrigger(partial) {
  const p = safeObj(partial);
  const domain = "garden";
  const kind = String(p.kind || "dashboard_nudge");
  const ruleId = String(p.ruleId || "unknown_rule");
  const title = String(p.title || "Garden");
  const message = String(p.message || "");
  const severity = String(p.severity || "info");
  const whenISO = p.whenISO ? toISO(p.whenISO) : null;

  const bedIds = safeArr(p.bedIds).map(String);
  const plantingIds = safeArr(p.plantingIds).map(String);
  const tags = safeArr(p.tags).map(String);
  const score = Number.isFinite(p.score) ? p.score : 0;

  const base = `${domain}:${ruleId}:${kind}:${keyOf(title)}:${keyOf(
    message
  )}:${bedIds.slice().sort().join(",")}:${plantingIds
    .slice()
    .sort()
    .join(",")}`;

  return {
    id: p.id || base,
    domain,
    kind,
    severity,
    title,
    message,
    whenISO,
    bedIds: bedIds.length ? bedIds : undefined,
    plantingIds: plantingIds.length ? plantingIds : undefined,
    tags: tags.length ? tags : undefined,
    score,
    ruleId,
    meta: safeObj(p.meta),
    source: SOURCE,
    createdAt: nowISO(),
  };
}

/* -----------------------------------------------------------------------------
 * Default rule settings (deterministic heuristics)
 * -------------------------------------------------------------------------- */

const DEFAULT_RULES = {
  // bed / area care
  BED_INSPECTION_DUE: { enabled: true, days: 7, severity: "info", score: 35 },
  WEEDING_DUE: { enabled: true, days: 10, severity: "info", score: 30 },
  MULCH_CHECK_DUE: { enabled: true, days: 30, severity: "info", score: 20 },
  SOIL_TEST_DUE: { enabled: true, days: 365, severity: "info", score: 15 },

  // watering
  WATERING_DUE_PLANTING: {
    enabled: true,
    days: 2,
    severity: "warn",
    score: 70,
  },
  WATERING_DUE_BED: { enabled: true, days: 3, severity: "warn", score: 55 },
  SKIP_WATER_IF_RAIN_SOON: { enabled: true, hours: 12 }, // modifies message/score only

  // plant lifecycle
  TRANSPLANT_WINDOW: { enabled: true, days: 3, severity: "info", score: 45 },
  HARVEST_DUE: { enabled: true, days: 2, severity: "warn", score: 75 },
  HARVEST_OVERDUE: { enabled: true, days: 7, severity: "high", score: 90 },

  // fertilizing / pest scouting
  FERTILIZE_DUE: { enabled: true, days: 21, severity: "info", score: 25 },
  PEST_SCOUT_DUE: { enabled: true, days: 7, severity: "info", score: 28 },

  // weather risk nudges (best-effort)
  FROST_RISK_ACTION: { enabled: true, severity: "high", score: 95 },
  HEAT_RISK_ACTION: { enabled: true, severity: "warn", score: 60 },

  // inventory/refill
  SEEDS_LOW: { enabled: true, minQty: 1, severity: "info", score: 22 },
  COMPOST_LOW: { enabled: true, minQty: 1, severity: "info", score: 20 },
  MULCH_LOW: { enabled: true, minQty: 1, severity: "info", score: 18 },

  // plan adherence
  PLANNED_TASK_TODAY: { enabled: true, severity: "info", score: 33 },

  // notes flags
  PEST_CONCERN_PRESENT: { enabled: true, severity: "warn", score: 80 },
};

/* -----------------------------------------------------------------------------
 * Rule engine
 * -------------------------------------------------------------------------- */

function normalizeCtx(input) {
  const ctx = safeObj(input);
  const now = ctx.now ? toDate(ctx.now) : new Date();
  const householdId = String(ctx.householdId || "primary");
  const zone = ctx.zone ? String(ctx.zone) : null;

  const beds = safeArr(ctx.beds)
    .map((b) => {
      const x = safeObj(b);
      return {
        id: String(x.id || ""),
        name: String(x.name || ""),
        type: x.type ? String(x.type) : null,
        location: safeObj(x.location),
        soil: safeObj(x.soil),
        irrigation: safeObj(x.irrigation),
        lastWeededAt: x.lastWeededAt || null,
        lastMulchedAt: x.lastMulchedAt || null,
        lastInspectedAt: x.lastInspectedAt || null,
        notes: x.notes ? String(x.notes) : "",
      };
    })
    .filter((b) => b.id);

  const plantings = safeArr(ctx.plantings)
    .map((p) => {
      const x = safeObj(p);
      return {
        id: String(x.id || ""),
        bedId: String(x.bedId || ""),
        crop: String(x.crop || x.name || ""),
        variety: x.variety ? String(x.variety) : null,
        plantedAt: x.plantedAt || null,
        startedAt: x.startedAt || null,
        transplantAt: x.transplantAt || null,
        stage: x.stage ? String(x.stage) : null,
        expectedHarvestAt: x.expectedHarvestAt || null,
        lastHarvestAt: x.lastHarvestAt || null,
        watering: safeObj(x.watering),
        fertilizing: safeObj(x.fertilizing),
        pest: safeObj(x.pest),
        qty: Number.isFinite(x.qty) ? x.qty : null,
        tags: safeArr(x.tags).map(String),
        status: String(x.status || "active"),
      };
    })
    .filter((p) => p.id && p.status !== "done");

  const inventory = safeObj(ctx.inventory);
  const plans = safeObj(ctx.plans);
  const logs = safeObj(ctx.logs);
  const prefs = safeObj(ctx.prefs);
  const weather = safeObj(ctx.weather);

  return {
    now,
    householdId,
    zone,
    beds,
    plantings,
    inventory,
    plans,
    logs,
    prefs,
    weather,
  };
}

function buildRuleSet(overrides) {
  const o = safeObj(overrides);
  const merged = { ...DEFAULT_RULES };
  for (const k of Object.keys(o)) {
    if (!merged[k]) merged[k] = {};
    merged[k] = { ...safeObj(merged[k]), ...safeObj(o[k]) };
  }
  return merged;
}

function runRules(ctx, rules) {
  const triggers = [];
  const invItems = safeArr(ctx.inventory.items);
  const invByTag = (tag) =>
    invItems.filter((it) => safeArr(it.tags).map(keyOf).includes(keyOf(tag)));

  const plannedGarden = safeArr(ctx.plans?.garden);
  const todayKey = isoDateKey(ctx.now);

  const forecast = safeObj(ctx.weather?.forecast);
  const rainSoon =
    forecast.nextRainAtISO && rules.SKIP_WATER_IF_RAIN_SOON?.enabled
      ? hoursBetween(ctx.now, forecast.nextRainAtISO) <=
        Number(rules.SKIP_WATER_IF_RAIN_SOON.hours || 12)
      : false;

  // Rule: planned tasks today
  if (rules.PLANNED_TASK_TODAY?.enabled) {
    const todays = plannedGarden.filter(
      (p) => String(p.dayISO || "") === todayKey
    );
    for (const p of todays) {
      triggers.push(
        makeTrigger({
          ruleId: "PLANNED_TASK_TODAY",
          kind: "session_candidate",
          severity: rules.PLANNED_TASK_TODAY.severity,
          title: "Planned garden work today",
          message: String(p.title || "Garden session planned for today."),
          whenISO: toISO(ctx.now),
          bedIds: safeArr(p.bedIds).map(String),
          plantingIds: safeArr(p.plantingIds).map(String),
          tags: ["plan", "garden"],
          score: rules.PLANNED_TASK_TODAY.score,
          meta: { plan: p },
        })
      );
    }
  }

  // Weather risk nudges
  if (rules.FROST_RISK_ACTION?.enabled && forecast.frostRisk) {
    const risk = String(forecast.frostRisk);
    if (risk === "high") {
      triggers.push(
        makeTrigger({
          ruleId: "FROST_RISK_ACTION",
          kind: "reminder",
          severity: rules.FROST_RISK_ACTION.severity,
          title: "Frost risk (high)",
          message:
            "High frost risk soon. Cover sensitive crops, move containers, and protect seedlings.",
          whenISO: toISO(ctx.now),
          tags: ["weather", "frost"],
          score: rules.FROST_RISK_ACTION.score,
          meta: {
            frostRisk: risk,
            nextRainAtISO: forecast.nextRainAtISO || null,
          },
        })
      );
    }
  }

  if (rules.HEAT_RISK_ACTION?.enabled && forecast.heatRisk) {
    const risk = String(forecast.heatRisk);
    if (risk === "high") {
      triggers.push(
        makeTrigger({
          ruleId: "HEAT_RISK_ACTION",
          kind: "dashboard_nudge",
          severity: rules.HEAT_RISK_ACTION.severity,
          title: "Heat risk (high)",
          message:
            "High heat risk. Water early, shade tender plants, and check soil moisture.",
          whenISO: toISO(ctx.now),
          tags: ["weather", "heat"],
          score: rules.HEAT_RISK_ACTION.score,
          meta: { heatRisk: risk },
        })
      );
    }
  }

  // Bed-level rules
  for (const b of ctx.beds) {
    // inspection
    if (rules.BED_INSPECTION_DUE?.enabled) {
      const last = b.lastInspectedAt || null;
      const days = Number(rules.BED_INSPECTION_DUE.days || 7);
      if (!last || daysBetween(last, ctx.now) >= days) {
        triggers.push(
          makeTrigger({
            ruleId: "BED_INSPECTION_DUE",
            kind: "dashboard_nudge",
            severity: rules.BED_INSPECTION_DUE.severity,
            title: "Bed inspection due",
            message: `${
              b.name || b.id
            } needs a quick inspection (pests, moisture, growth).`,
            whenISO: toISO(ctx.now),
            bedIds: [b.id],
            tags: ["inspection"],
            score: rules.BED_INSPECTION_DUE.score,
            meta: { lastInspectedAt: last, thresholdDays: days },
          })
        );
      }
    }

    // weeding
    if (rules.WEEDING_DUE?.enabled) {
      const last = b.lastWeededAt || null;
      const days = Number(rules.WEEDING_DUE.days || 10);
      if (!last || daysBetween(last, ctx.now) >= days) {
        triggers.push(
          makeTrigger({
            ruleId: "WEEDING_DUE",
            kind: "session_candidate",
            severity: rules.WEEDING_DUE.severity,
            title: "Weeding due",
            message: `${b.name || b.id} likely needs weeding.`,
            whenISO: toISO(ctx.now),
            bedIds: [b.id],
            tags: ["weeding"],
            score: rules.WEEDING_DUE.score,
            meta: { lastWeededAt: last, thresholdDays: days },
          })
        );
      }
    }

    // mulch check
    if (rules.MULCH_CHECK_DUE?.enabled) {
      const last = b.lastMulchedAt || null;
      const days = Number(rules.MULCH_CHECK_DUE.days || 30);
      if (!last || daysBetween(last, ctx.now) >= days) {
        triggers.push(
          makeTrigger({
            ruleId: "MULCH_CHECK_DUE",
            kind: "dashboard_nudge",
            severity: rules.MULCH_CHECK_DUE.severity,
            title: "Mulch check",
            message: `${
              b.name || b.id
            }: consider topping off mulch / checking coverage.`,
            whenISO: toISO(ctx.now),
            bedIds: [b.id],
            tags: ["mulch"],
            score: rules.MULCH_CHECK_DUE.score,
            meta: { lastMulchedAt: last, thresholdDays: days },
          })
        );
      }
    }

    // soil test
    if (rules.SOIL_TEST_DUE?.enabled) {
      const last = safeObj(b.soil).lastTestAt || null;
      const days = Number(rules.SOIL_TEST_DUE.days || 365);
      if (!last || daysBetween(last, ctx.now) >= days) {
        triggers.push(
          makeTrigger({
            ruleId: "SOIL_TEST_DUE",
            kind: "reminder",
            severity: rules.SOIL_TEST_DUE.severity,
            title: "Soil test due",
            message: `${b.name || b.id}: soil test is due (annual).`,
            whenISO: toISO(addDays(ctx.now, 1)),
            bedIds: [b.id],
            tags: ["soil", "test"],
            score: rules.SOIL_TEST_DUE.score,
            meta: {
              lastTestAt: last,
              thresholdDays: days,
              ph: safeObj(b.soil).ph || null,
            },
          })
        );
      }
    }

    // bed watering (fallback when no plantings intervals exist)
    if (rules.WATERING_DUE_BED?.enabled) {
      const irr = safeObj(b.irrigation);
      const last = irr.lastWateredAt || b.lastWateredAt || null;
      const days = Number(rules.WATERING_DUE_BED.days || 3);
      if (!last || daysBetween(last, ctx.now) >= days) {
        const msg = rainSoon
          ? `${
              b.name || b.id
            } watering due, but rain is expected soon — consider checking moisture first.`
          : `${b.name || b.id} may need watering.`;
        const score = rainSoon
          ? rules.WATERING_DUE_BED.score * 0.6
          : rules.WATERING_DUE_BED.score;

        triggers.push(
          makeTrigger({
            ruleId: "WATERING_DUE_BED",
            kind: "dashboard_nudge",
            severity: rules.WATERING_DUE_BED.severity,
            title: "Watering check (bed)",
            message: msg,
            whenISO: toISO(ctx.now),
            bedIds: [b.id],
            tags: ["water"],
            score,
            meta: {
              lastWateredAt: last,
              thresholdDays: days,
              rainSoon: !!rainSoon,
            },
          })
        );
      }
    }
  }

  // Planting-level rules
  for (const p of ctx.plantings) {
    const watering = safeObj(p.watering);
    const fertilizing = safeObj(p.fertilizing);
    const pest = safeObj(p.pest);

    // watering due (planting interval)
    if (rules.WATERING_DUE_PLANTING?.enabled) {
      const interval = Number(
        watering.intervalDays || rules.WATERING_DUE_PLANTING.days || 2
      );
      const last = watering.lastAt || watering.lastWateredAt || null;
      if (!last || daysBetween(last, ctx.now) >= interval) {
        const msg = rainSoon
          ? `${
              p.crop || "Planting"
            } watering due, but rain is expected soon — check soil moisture first.`
          : `${p.crop || "Planting"} likely needs watering.`;
        const score = rainSoon
          ? rules.WATERING_DUE_PLANTING.score * 0.6
          : rules.WATERING_DUE_PLANTING.score;

        triggers.push(
          makeTrigger({
            ruleId: "WATERING_DUE_PLANTING",
            kind: "session_candidate",
            severity: rules.WATERING_DUE_PLANTING.severity,
            title: "Watering due",
            message: msg,
            whenISO: toISO(ctx.now),
            bedIds: p.bedId ? [p.bedId] : undefined,
            plantingIds: [p.id],
            tags: ["water", "planting"],
            score,
            meta: {
              intervalDays: interval,
              lastWateredAt: last,
              rainSoon: !!rainSoon,
              crop: p.crop,
            },
          })
        );
      }
    }

    // transplant window
    if (rules.TRANSPLANT_WINDOW?.enabled && p.transplantAt) {
      const d = daysBetween(ctx.now, p.transplantAt);
      const window = Number(rules.TRANSPLANT_WINDOW.days || 3);
      if (d >= 0 && d <= window) {
        triggers.push(
          makeTrigger({
            ruleId: "TRANSPLANT_WINDOW",
            kind: "session_candidate",
            severity: rules.TRANSPLANT_WINDOW.severity,
            title: "Transplant window",
            message: `${
              p.crop || "Planting"
            } is within transplant window (~${d} day(s)).`,
            whenISO: toISO(ctx.now),
            bedIds: p.bedId ? [p.bedId] : undefined,
            plantingIds: [p.id],
            tags: ["transplant"],
            score: rules.TRANSPLANT_WINDOW.score,
            meta: { transplantAt: p.transplantAt, daysUntil: d },
          })
        );
      }
    }

    // harvest due / overdue
    if (p.expectedHarvestAt) {
      const d = daysBetween(ctx.now, p.expectedHarvestAt);

      if (rules.HARVEST_DUE?.enabled) {
        const due = Number(rules.HARVEST_DUE.days || 2);
        if (d >= 0 && d <= due) {
          triggers.push(
            makeTrigger({
              ruleId: "HARVEST_DUE",
              kind: "session_candidate",
              severity: rules.HARVEST_DUE.severity,
              title: "Harvest due soon",
              message: `${
                p.crop || "Planting"
              } harvest window is near (~${d} day(s)).`,
              whenISO: toISO(ctx.now),
              bedIds: p.bedId ? [p.bedId] : undefined,
              plantingIds: [p.id],
              tags: ["harvest"],
              score: rules.HARVEST_DUE.score,
              meta: { expectedHarvestAt: p.expectedHarvestAt, daysUntil: d },
            })
          );
        }
      }

      if (rules.HARVEST_OVERDUE?.enabled) {
        const overdue = Number(rules.HARVEST_OVERDUE.days || 7);
        if (d < 0 && Math.abs(d) >= overdue) {
          triggers.push(
            makeTrigger({
              ruleId: "HARVEST_OVERDUE",
              kind: "reminder",
              severity: rules.HARVEST_OVERDUE.severity,
              title: "Harvest overdue",
              message: `${
                p.crop || "Planting"
              } looks overdue for harvest (~${Math.abs(d)} day(s) past).`,
              whenISO: toISO(ctx.now),
              bedIds: p.bedId ? [p.bedId] : undefined,
              plantingIds: [p.id],
              tags: ["harvest", "overdue"],
              score: rules.HARVEST_OVERDUE.score,
              meta: {
                expectedHarvestAt: p.expectedHarvestAt,
                daysPast: Math.abs(d),
              },
            })
          );
        }
      }
    }

    // fertilize due
    if (rules.FERTILIZE_DUE?.enabled) {
      const interval = Number(
        fertilizing.intervalDays || rules.FERTILIZE_DUE.days || 21
      );
      const last = fertilizing.lastAt || fertilizing.lastFertilizedAt || null;
      if (!last || daysBetween(last, ctx.now) >= interval) {
        triggers.push(
          makeTrigger({
            ruleId: "FERTILIZE_DUE",
            kind: "session_candidate",
            severity: rules.FERTILIZE_DUE.severity,
            title: "Fertilize due",
            message: `${p.crop || "Planting"} may be due for fertilizing.`,
            whenISO: toISO(ctx.now),
            bedIds: p.bedId ? [p.bedId] : undefined,
            plantingIds: [p.id],
            tags: ["fertilize"],
            score: rules.FERTILIZE_DUE.score,
            meta: {
              intervalDays: interval,
              lastFertilizedAt: last,
              type: fertilizing.type || null,
            },
          })
        );
      }
    }

    // pest scouting due
    if (rules.PEST_SCOUT_DUE?.enabled) {
      const interval = Number(
        pest.intervalDays || rules.PEST_SCOUT_DUE.days || 7
      );
      const last = pest.lastInspectAt || pest.lastInspectedAt || null;
      if (!last || daysBetween(last, ctx.now) >= interval) {
        triggers.push(
          makeTrigger({
            ruleId: "PEST_SCOUT_DUE",
            kind: "dashboard_nudge",
            severity: rules.PEST_SCOUT_DUE.severity,
            title: "Pest scouting",
            message: `Check ${p.crop || "planting"} for pests and leaf damage.`,
            whenISO: toISO(ctx.now),
            bedIds: p.bedId ? [p.bedId] : undefined,
            plantingIds: [p.id],
            tags: ["pest", "inspection"],
            score: rules.PEST_SCOUT_DUE.score,
            meta: {
              intervalDays: interval,
              lastInspectAt: last,
              concern: pest.concern || null,
            },
          })
        );
      }
    }

    // pest concern present (notes)
    if (rules.PEST_CONCERN_PRESENT?.enabled) {
      const concern = String(pest.concern || "");
      if (concern && concern.trim()) {
        triggers.push(
          makeTrigger({
            ruleId: "PEST_CONCERN_PRESENT",
            kind: "reminder",
            severity: rules.PEST_CONCERN_PRESENT.severity,
            title: "Pest concern noted",
            message: `${p.crop || "Planting"} has a pest concern: ${concern}`,
            whenISO: toISO(ctx.now),
            bedIds: p.bedId ? [p.bedId] : undefined,
            plantingIds: [p.id],
            tags: ["pest", "concern"],
            score: rules.PEST_CONCERN_PRESENT.score,
            meta: { concern },
          })
        );
      }
    }
  }

  // Inventory rules (garden inputs)
  if (rules.SEEDS_LOW?.enabled) {
    const minQty = Number(rules.SEEDS_LOW.minQty || 1);
    const seeds = invByTag("seeds").concat(invByTag("seed"));
    const low = seeds.filter((it) => Number(it.qty || 0) <= minQty);
    if (low.length) {
      triggers.push(
        makeTrigger({
          ruleId: "SEEDS_LOW",
          kind: "inventory_refill",
          severity: rules.SEEDS_LOW.severity,
          title: "Seeds running low",
          message: `You have ${low.length} seed item(s) at or below threshold.`,
          whenISO: toISO(ctx.now),
          tags: ["inventory", "seeds"],
          score: rules.SEEDS_LOW.score,
          meta: {
            threshold: minQty,
            items: low.map((x) => ({
              id: x.id,
              name: x.name,
              qty: x.qty,
              unit: x.unit,
            })),
          },
        })
      );
    }
  }

  if (rules.COMPOST_LOW?.enabled) {
    const minQty = Number(rules.COMPOST_LOW.minQty || 1);
    const compost = invByTag("compost")
      .concat(invByTag("manure"))
      .concat(invByTag("soil_amendment"));
    const low = compost.filter((it) => Number(it.qty || 0) <= minQty);
    if (low.length) {
      triggers.push(
        makeTrigger({
          ruleId: "COMPOST_LOW",
          kind: "inventory_refill",
          severity: rules.COMPOST_LOW.severity,
          title: "Compost / amendments low",
          message: `You have ${low.length} compost/amendment item(s) at or below threshold.`,
          whenISO: toISO(ctx.now),
          tags: ["inventory", "compost"],
          score: rules.COMPOST_LOW.score,
          meta: {
            threshold: minQty,
            items: low.map((x) => ({
              id: x.id,
              name: x.name,
              qty: x.qty,
              unit: x.unit,
            })),
          },
        })
      );
    }
  }

  if (rules.MULCH_LOW?.enabled) {
    const minQty = Number(rules.MULCH_LOW.minQty || 1);
    const mulch = invByTag("mulch")
      .concat(invByTag("straw"))
      .concat(invByTag("wood_chips"));
    const low = mulch.filter((it) => Number(it.qty || 0) <= minQty);
    if (low.length) {
      triggers.push(
        makeTrigger({
          ruleId: "MULCH_LOW",
          kind: "inventory_refill",
          severity: rules.MULCH_LOW.severity,
          title: "Mulch materials low",
          message: `You have ${low.length} mulch item(s) at or below threshold.`,
          whenISO: toISO(ctx.now),
          tags: ["inventory", "mulch"],
          score: rules.MULCH_LOW.score,
          meta: {
            threshold: minQty,
            items: low.map((x) => ({
              id: x.id,
              name: x.name,
              qty: x.qty,
              unit: x.unit,
            })),
          },
        })
      );
    }
  }

  // De-dupe triggers
  const deduped = uniqBy(
    triggers,
    (t) =>
      `${t.ruleId}|${t.kind}|${safeArr(t.bedIds)
        .slice()
        .sort()
        .join(",")}|${safeArr(t.plantingIds).slice().sort().join(",")}|${keyOf(
        t.title
      )}`
  );

  // Sort by score desc then severity
  const sevRank = { high: 3, warn: 2, info: 1 };
  deduped.sort((a, b) => {
    const sa = Number(a.score || 0);
    const sb = Number(b.score || 0);
    if (sb !== sa) return sb - sa;
    return (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0);
  });

  return deduped;
}

/* -----------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

/**
 * Detect triggers for the Gardening domain.
 *
 * @param {object} ctx - input context (see header)
 * @param {object} [options]
 * @param {object} [options.ruleOverrides] - override DEFAULT_RULES by key
 * @param {boolean} [options.emitEvent=true]
 * @param {boolean} [options.logDashboard=false] - log summary to DashboardLog
 * @returns {Promise<{ householdId: string, atISO: string, triggers: any[], meta: object }>}
 */
export async function detectGardenTriggers(ctx, options = {}) {
  const c = normalizeCtx(ctx);
  const opts = safeObj(options);
  const ruleOverrides = safeObj(opts.ruleOverrides);
  const emitEvent = opts.emitEvent !== false;
  const logDashboard = !!opts.logDashboard;

  const rules = buildRuleSet(ruleOverrides);
  const triggers = runRules(c, rules);

  const payload = {
    householdId: c.householdId,
    atISO: toISO(c.now),
    triggers,
    meta: {
      source: SOURCE,
      rulesEnabled: Object.keys(rules).filter((k) => rules[k]?.enabled),
      bedCount: c.beds.length,
      plantingCount: c.plantings.length,
      inventoryItemCount: safeArr(c.inventory.items).length,
      weatherHints: safeObj(c.weather.forecast),
    },
  };

  if (emitEvent) {
    tryEmit("triggers.garden.detected", payload);
  }

  if (logDashboard && DashboardLog?.log) {
    try {
      const hi = triggers.filter((t) => t.severity === "high").length;
      const warn = triggers.filter((t) => t.severity === "warn").length;
      const info = triggers.filter((t) => t.severity === "info").length;

      await DashboardLog.log({
        category: "Garden",
        icon: "🪴",
        message: `Garden triggers: ${hi} high, ${warn} warn, ${info} info`,
        time: payload.atISO,
        meta: {
          householdId: c.householdId,
          counts: { high: hi, warn, info },
          top: triggers.slice(0, 5).map((t) => ({
            title: t.title,
            severity: t.severity,
            ruleId: t.ruleId,
          })),
        },
      });
    } catch {
      /* non-fatal */
    }
  }

  return payload;
}

export default detectGardenTriggers;

/* -----------------------------------------------------------------------------
 * Convenience: detect with minimal inputs
 * -------------------------------------------------------------------------- */

/**
 * A wrapper for callers that only have beds + plantings + inventory.
 * @param {Array} beds
 * @param {Array} plantings
 * @param {Object} inventory
 * @param {Object} moreCtx
 */
export async function detectGardenTriggersSimple(
  beds = [],
  plantings = [],
  inventory = {},
  moreCtx = {}
) {
  return detectGardenTriggers(
    {
      now: new Date().toISOString(),
      beds,
      plantings,
      inventory,
      ...safeObj(moreCtx),
    },
    { emitEvent: true, logDashboard: false }
  );
}

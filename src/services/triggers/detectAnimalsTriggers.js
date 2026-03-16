// File: C:\Users\larho\suka-smart-assistant\src\services\triggers\detectAnimalsTriggers.js
/**
 * detectAnimalsTriggers (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Analyze current household/animal state + plans + events and emit
 *    actionable "triggers" (suggestions, alerts, session candidates)
 *    for the Animals domain.
 *
 * Design goals
 *  - Browser-safe (no Node imports).
 *  - Offline-first (Dexie optional; operates with passed-in context).
 *  - Deterministic: same inputs -> same triggers (no AI, no randomness).
 *  - Extensible: rules registry with enable/disable and per-rule weights.
 *  - Safe: never throws on missing modules; returns best-effort results.
 *
 * What is a "trigger"?
 *  - A lightweight object describing *why* something should happen next:
 *      • create a session candidate (animal care session)
 *      • show a dashboard nudge (low feed, water check, overdue tasks)
 *      • schedule reminder (vaccinations due, breeding window, etc.)
 *      • recommend storehouse replenishment (feed, bedding, minerals)
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
 *   prefs: { ... }                       // animal prefs (quiet hours, sabbath)
 *   animals: [                           // normalized animals
 *     {
 *       id, name, species, breed?, sex?, dob?, stage?,
 *       status?: "active"|"sold"|"dead",
 *       location?: { penId?, pastureId? },
 *       tags?: string[],
 *       lastSeenAt?: ISO,
 *       health?: { bcs?, notes?, lastCheckAt?, lastDewormAt?, lastVaxAt? },
 *       reproduction?: { bredAt?, dueAt?, heatCycleDays?, lastHeatAt? },
 *       feeding?: { rationId?, lastFedAt?, feedType?, waterCheckedAt? },
 *     }
 *   ],
 *   inventory: {
 *     // minimal: items & quantities for feed/bedding/minerals/etc.
 *     items?: [{ id, name, qty, unit, tags?: string[] }],
 *     stats?: { lowCount?: number }
 *   },
 *   plans: {
 *     // optional planned tasks/sessions
 *     animalCare?: [{ dayISO, title, tasks?, animalIds? }]
 *   },
 *   logs: {
 *     // optional recent completion logs
 *     animalTasks?: [{ atISO, type, animalId?, meta? }]
 *   }
 * }
 *
 * -----------------------------------------------------------------------------
 * Tooling hooks (optional)
 * -----------------------------------------------------------------------------
 * - Emits to eventBus if available:
 *    • "triggers.animals.detected" with payload { householdId, triggers }
 *
 * - Logs to DashboardLog if available:
 *    • category: "Animals" with summary counts
 */

const SOURCE = "services.triggers.detectAnimalsTriggers";

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
 *   domain: "animals",
 *   kind: "session_candidate"|"dashboard_nudge"|"inventory_refill"|"reminder",
 *   severity: "info"|"warn"|"high",
 *   title: string,
 *   message: string,
 *   whenISO?: string,              // recommended execution / attention time
 *   animalIds?: string[],
 *   tags?: string[],
 *   score?: number,                // for sorting
 *   ruleId: string,
 *   meta?: object
 * }
 */

function makeTrigger(partial) {
  const p = safeObj(partial);
  const domain = "animals";
  const kind = String(p.kind || "dashboard_nudge");
  const ruleId = String(p.ruleId || "unknown_rule");
  const title = String(p.title || "Animals");
  const message = String(p.message || "");
  const severity = String(p.severity || "info");
  const whenISO = p.whenISO ? toISO(p.whenISO) : null;
  const animalIds = safeArr(p.animalIds).map(String);
  const tags = safeArr(p.tags).map(String);
  const score = Number.isFinite(p.score) ? p.score : 0;

  const base = `${domain}:${ruleId}:${kind}:${keyOf(title)}:${keyOf(
    message
  )}:${animalIds.slice().sort().join(",")}`;

  return {
    id: p.id || base,
    domain,
    kind,
    severity,
    title,
    message,
    whenISO,
    animalIds: animalIds.length ? animalIds : undefined,
    tags: tags.length ? tags : undefined,
    score,
    ruleId,
    meta: safeObj(p.meta),
    source: SOURCE,
    createdAt: nowISO(),
  };
}

/* -----------------------------------------------------------------------------
 * Default rule settings
 * -------------------------------------------------------------------------- */

const DEFAULT_RULES = {
  // core checks
  WATER_CHECK_DUE: { enabled: true, hours: 12, severity: "warn", score: 70 },
  FEEDING_DUE: { enabled: true, hours: 18, severity: "warn", score: 75 },
  HEALTH_CHECK_DUE: { enabled: true, days: 30, severity: "info", score: 45 },
  LAST_SEEN_STALE: { enabled: true, days: 3, severity: "warn", score: 60 },

  // reproduction
  BIRTH_DUE_SOON: { enabled: true, daysBefore: 7, severity: "high", score: 90 },
  HEAT_WINDOW: { enabled: true, daysWindow: 2, severity: "info", score: 40 },

  // inventory/refill
  FEED_LOW: { enabled: true, minQty: 1, severity: "warn", score: 65 },
  WATER_CONSUMABLES_LOW: {
    enabled: false,
    minQty: 1,
    severity: "info",
    score: 20,
  },
  BEDDING_LOW: { enabled: true, minQty: 1, severity: "info", score: 30 },

  // plan adherence
  PLANNED_TASK_TODAY: { enabled: true, severity: "info", score: 35 },

  // safety/illness flags (simple heuristics)
  SICK_NOTES_PRESENT: { enabled: true, severity: "high", score: 95 },
};

/* -----------------------------------------------------------------------------
 * Rule engine
 * -------------------------------------------------------------------------- */

function normalizeCtx(input) {
  const ctx = safeObj(input);
  const now = ctx.now ? toDate(ctx.now) : new Date();
  const householdId = String(ctx.householdId || "primary");

  const animals = safeArr(ctx.animals)
    .filter(
      (a) =>
        safeObj(a) &&
        String(a.status || "active") !== "sold" &&
        String(a.status || "active") !== "dead"
    )
    .map((a) => {
      const x = safeObj(a);
      return {
        id: String(x.id || ""),
        name: String(x.name || ""),
        species: String(x.species || x.type || ""),
        breed: x.breed ? String(x.breed) : null,
        sex: x.sex ? String(x.sex) : null,
        dob: x.dob || x.dateOfBirth || null,
        stage: x.stage ? String(x.stage) : null,
        status: String(x.status || "active"),
        location: safeObj(x.location),
        tags: safeArr(x.tags).map(String),
        lastSeenAt: x.lastSeenAt || x.lastSeenISO || null,
        health: safeObj(x.health),
        reproduction: safeObj(x.reproduction),
        feeding: safeObj(x.feeding),
      };
    })
    .filter((a) => a.id); // require id

  const inventory = safeObj(ctx.inventory);
  const plans = safeObj(ctx.plans);
  const logs = safeObj(ctx.logs);
  const prefs = safeObj(ctx.prefs);

  return { now, householdId, animals, inventory, plans, logs, prefs };
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

  // helpers
  const invItems = safeArr(ctx.inventory.items);
  const invByTag = (tag) =>
    invItems.filter((it) => safeArr(it.tags).map(keyOf).includes(keyOf(tag)));

  const plannedAnimalCare = safeArr(ctx.plans?.animalCare);
  const todayKey = isoDateKey(ctx.now);

  // Rule: planned animal task today
  if (rules.PLANNED_TASK_TODAY?.enabled) {
    const todays = plannedAnimalCare.filter(
      (p) => String(p.dayISO || "") === todayKey
    );
    for (const p of todays) {
      triggers.push(
        makeTrigger({
          ruleId: "PLANNED_TASK_TODAY",
          kind: "session_candidate",
          severity: rules.PLANNED_TASK_TODAY.severity,
          title: "Planned animal care today",
          message: String(p.title || "Animal care session planned for today."),
          whenISO: toISO(ctx.now),
          animalIds: safeArr(p.animalIds).map(String),
          tags: ["plan", "animals"],
          score: rules.PLANNED_TASK_TODAY.score,
          meta: { plan: p },
        })
      );
    }
  }

  // Per-animal rules
  for (const a of ctx.animals) {
    const feeding = safeObj(a.feeding);
    const health = safeObj(a.health);
    const repro = safeObj(a.reproduction);

    // Rule: water check due
    if (rules.WATER_CHECK_DUE?.enabled) {
      const last =
        feeding.waterCheckedAt ||
        feeding.lastWaterCheckAt ||
        feeding.waterAt ||
        null;
      const hrs = Number(rules.WATER_CHECK_DUE.hours || 12);
      if (!last || hoursBetween(last, ctx.now) >= hrs) {
        triggers.push(
          makeTrigger({
            ruleId: "WATER_CHECK_DUE",
            kind: "dashboard_nudge",
            severity: rules.WATER_CHECK_DUE.severity,
            title: "Water check due",
            message: `${a.name || a.id} (${
              a.species || "animal"
            }) needs a water check.`,
            whenISO: toISO(ctx.now),
            animalIds: [a.id],
            tags: ["water", "routine"],
            score: rules.WATER_CHECK_DUE.score,
            meta: { lastWaterCheckAt: last || null, thresholdHours: hrs },
          })
        );
      }
    }

    // Rule: feeding due
    if (rules.FEEDING_DUE?.enabled) {
      const lastFed = feeding.lastFedAt || feeding.lastFeedingAt || null;
      const hrs = Number(rules.FEEDING_DUE.hours || 18);
      if (!lastFed || hoursBetween(lastFed, ctx.now) >= hrs) {
        triggers.push(
          makeTrigger({
            ruleId: "FEEDING_DUE",
            kind: "dashboard_nudge",
            severity: rules.FEEDING_DUE.severity,
            title: "Feeding due",
            message: `${a.name || a.id} (${
              a.species || "animal"
            }) likely needs feeding.`,
            whenISO: toISO(ctx.now),
            animalIds: [a.id],
            tags: ["feed", "routine"],
            score: rules.FEEDING_DUE.score,
            meta: {
              lastFedAt: lastFed || null,
              thresholdHours: hrs,
              feedType: feeding.feedType || null,
            },
          })
        );
      }
    }

    // Rule: health check due
    if (rules.HEALTH_CHECK_DUE?.enabled) {
      const last = health.lastCheckAt || health.lastHealthCheckAt || null;
      const days = Number(rules.HEALTH_CHECK_DUE.days || 30);
      if (!last || daysBetween(last, ctx.now) >= days) {
        triggers.push(
          makeTrigger({
            ruleId: "HEALTH_CHECK_DUE",
            kind: "session_candidate",
            severity: rules.HEALTH_CHECK_DUE.severity,
            title: "Routine health check",
            message: `${a.name || a.id} (${
              a.species || "animal"
            }) is due for a routine health check.`,
            whenISO: toISO(ctx.now),
            animalIds: [a.id],
            tags: ["health", "routine"],
            score: rules.HEALTH_CHECK_DUE.score,
            meta: { lastHealthCheckAt: last || null, thresholdDays: days },
          })
        );
      }
    }

    // Rule: last seen stale
    if (rules.LAST_SEEN_STALE?.enabled) {
      const lastSeen = a.lastSeenAt || null;
      const days = Number(rules.LAST_SEEN_STALE.days || 3);
      if (!lastSeen || daysBetween(lastSeen, ctx.now) >= days) {
        triggers.push(
          makeTrigger({
            ruleId: "LAST_SEEN_STALE",
            kind: "dashboard_nudge",
            severity: rules.LAST_SEEN_STALE.severity,
            title: "Animal not checked recently",
            message: `${a.name || a.id} (${
              a.species || "animal"
            }) hasn't been checked in ${days}+ day(s).`,
            whenISO: toISO(ctx.now),
            animalIds: [a.id],
            tags: ["inspection", "presence"],
            score: rules.LAST_SEEN_STALE.score,
            meta: { lastSeenAt: lastSeen || null, thresholdDays: days },
          })
        );
      }
    }

    // Rule: sick notes present (simple flag)
    if (rules.SICK_NOTES_PRESENT?.enabled) {
      const notes = String(health.notes || "");
      const flags = [
        "sick",
        "ill",
        "limp",
        "cough",
        "diarr",
        "bloody",
        "fever",
        "not eating",
        "won't eat",
        "letharg",
        "injur",
        "wound",
        "mastitis",
      ];
      const low = notes.toLowerCase();
      const hit = flags.find((f) => low.includes(f));
      if (hit) {
        triggers.push(
          makeTrigger({
            ruleId: "SICK_NOTES_PRESENT",
            kind: "reminder",
            severity: rules.SICK_NOTES_PRESENT.severity,
            title: "Health concern flagged",
            message: `${
              a.name || a.id
            } has health notes that may need attention (${hit}).`,
            whenISO: toISO(ctx.now),
            animalIds: [a.id],
            tags: ["health", "urgent"],
            score: rules.SICK_NOTES_PRESENT.score,
            meta: { keyword: hit, notes: health.notes || "" },
          })
        );
      }
    }

    // Rule: birth due soon
    if (rules.BIRTH_DUE_SOON?.enabled) {
      const dueAt = repro.dueAt || repro.birthDueAt || null;
      const daysBefore = Number(rules.BIRTH_DUE_SOON.daysBefore || 7);
      if (dueAt) {
        const d = daysBetween(ctx.now, dueAt);
        if (d >= 0 && d <= daysBefore) {
          triggers.push(
            makeTrigger({
              ruleId: "BIRTH_DUE_SOON",
              kind: "session_candidate",
              severity: rules.BIRTH_DUE_SOON.severity,
              title: "Birth due soon",
              message: `${
                a.name || a.id
              } may be due to give birth in ~${d} day(s). Prepare a birthing kit and pen.`,
              whenISO: toISO(addDays(ctx.now, Math.max(0, d - 1))),
              animalIds: [a.id],
              tags: ["birth", "prep"],
              score: rules.BIRTH_DUE_SOON.score,
              meta: { dueAt, daysUntil: d, windowDays: daysBefore },
            })
          );
        }
      }
    }

    // Rule: heat window (basic heuristic)
    if (rules.HEAT_WINDOW?.enabled) {
      const heatCycleDays = Number(repro.heatCycleDays || 21);
      const lastHeatAt = repro.lastHeatAt || repro.lastHeatISO || null;
      const lastBredAt = repro.bredAt || repro.lastBredAt || null;
      const daysWindow = Number(rules.HEAT_WINDOW.daysWindow || 2);

      // Only apply if female and not bred recently (very simple)
      const isFemale = keyOf(a.sex) === "female" || keyOf(a.sex) === "f";
      const bredRecently = lastBredAt
        ? daysBetween(lastBredAt, ctx.now) < heatCycleDays
        : false;

      if (isFemale && lastHeatAt && !bredRecently) {
        const daysSince = daysBetween(lastHeatAt, ctx.now);
        // if within cycle boundary +/- window
        const mod =
          ((daysSince % heatCycleDays) + heatCycleDays) % heatCycleDays;
        if (mod <= daysWindow || mod >= heatCycleDays - daysWindow) {
          triggers.push(
            makeTrigger({
              ruleId: "HEAT_WINDOW",
              kind: "dashboard_nudge",
              severity: rules.HEAT_WINDOW.severity,
              title: "Breeding window (estimate)",
              message: `${
                a.name || a.id
              } may be near a heat window (estimate). Observe behavior and confirm.`,
              whenISO: toISO(ctx.now),
              animalIds: [a.id],
              tags: ["breeding", "estimate"],
              score: rules.HEAT_WINDOW.score,
              meta: {
                heatCycleDays,
                lastHeatAt,
                daysSinceHeat: daysSince,
                windowDays: daysWindow,
              },
            })
          );
        }
      }
    }
  }

  // Inventory rules (global)
  const feedItems = invByTag("feed").concat(invByTag("animal_feed"));
  const beddingItems = invByTag("bedding")
    .concat(invByTag("straw"))
    .concat(invByTag("pine_shavings"));
  const minerals = invByTag("minerals")
    .concat(invByTag("salt_block"))
    .concat(invByTag("supplement"));

  if (rules.FEED_LOW?.enabled) {
    const minQty = Number(rules.FEED_LOW.minQty || 1);
    const low = feedItems.filter((it) => Number(it.qty || 0) <= minQty);
    if (low.length) {
      triggers.push(
        makeTrigger({
          ruleId: "FEED_LOW",
          kind: "inventory_refill",
          severity: rules.FEED_LOW.severity,
          title: "Animal feed running low",
          message: `You have ${low.length} feed item(s) at or below threshold.`,
          whenISO: toISO(ctx.now),
          tags: ["inventory", "feed"],
          score: rules.FEED_LOW.score,
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

  if (rules.BEDDING_LOW?.enabled) {
    const minQty = Number(rules.BEDDING_LOW.minQty || 1);
    const low = beddingItems.filter((it) => Number(it.qty || 0) <= minQty);
    if (low.length) {
      triggers.push(
        makeTrigger({
          ruleId: "BEDDING_LOW",
          kind: "inventory_refill",
          severity: rules.BEDDING_LOW.severity,
          title: "Bedding running low",
          message: `You have ${low.length} bedding item(s) at or below threshold.`,
          whenISO: toISO(ctx.now),
          tags: ["inventory", "bedding"],
          score: rules.BEDDING_LOW.score,
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

  // Minerals low (optional but useful)
  if (minerals.length) {
    const minQty = 1;
    const low = minerals.filter((it) => Number(it.qty || 0) <= minQty);
    if (low.length) {
      triggers.push(
        makeTrigger({
          ruleId: "MINERALS_LOW",
          kind: "inventory_refill",
          severity: "info",
          title: "Minerals / supplements low",
          message: `You have ${low.length} mineral/supplement item(s) at or below threshold.`,
          whenISO: toISO(ctx.now),
          tags: ["inventory", "minerals"],
          score: 25,
          meta: {
            threshold: minQty,
            items: low.map((x) => ({ id: x.id, name: x.name, qty: x.qty })),
          },
        })
      );
    }
  }

  // De-dupe triggers with same (ruleId + animalIds + kind)
  const deduped = uniqBy(
    triggers,
    (t) =>
      `${t.ruleId}|${t.kind}|${safeArr(t.animalIds)
        .slice()
        .sort()
        .join(",")}|${keyOf(t.title)}`
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
 * Detect triggers for the Animals domain.
 *
 * @param {object} ctx - input context (see header)
 * @param {object} [options]
 * @param {object} [options.ruleOverrides] - override DEFAULT_RULES by key
 * @param {boolean} [options.emitEvent=true]
 * @param {boolean} [options.logDashboard=false] - log summary to DashboardLog
 * @returns {Promise<{ householdId: string, atISO: string, triggers: any[], meta: object }>}
 */
export async function detectAnimalsTriggers(ctx, options = {}) {
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
      animalCount: c.animals.length,
      inventoryItemCount: safeArr(c.inventory.items).length,
    },
  };

  if (emitEvent) {
    tryEmit("triggers.animals.detected", payload);
  }

  if (logDashboard && DashboardLog?.log) {
    try {
      const hi = triggers.filter((t) => t.severity === "high").length;
      const warn = triggers.filter((t) => t.severity === "warn").length;
      const info = triggers.filter((t) => t.severity === "info").length;

      await DashboardLog.log({
        category: "Animals",
        icon: "🐐",
        message: `Animal triggers: ${hi} high, ${warn} warn, ${info} info`,
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

export default detectAnimalsTriggers;

/* -----------------------------------------------------------------------------
 * Convenience: detect with minimal inputs
 * -------------------------------------------------------------------------- */

/**
 * A tiny wrapper for callers that only have animals + inventory.
 * @param {Array} animals
 * @param {Object} inventory
 * @param {Object} moreCtx
 */
export async function detectAnimalsTriggersSimple(
  animals = [],
  inventory = {},
  moreCtx = {}
) {
  return detectAnimalsTriggers(
    {
      now: new Date().toISOString(),
      animals,
      inventory,
      ...safeObj(moreCtx),
    },
    { emitEvent: true, logDashboard: false }
  );
}

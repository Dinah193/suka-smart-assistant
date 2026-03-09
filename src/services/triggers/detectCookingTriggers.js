// C:\Users\larho\suka-smart-assistant\src\services\triggers\detectCookingTriggers.js
/**
 * detectCookingTriggers
 * ---------------------
 * Dynamic trigger detector for home + kitchen workflows across chat, approvals,
 * calendar, inventory, devices, and location.
 *
 * Design goals (aligned with your project direction):
 *  - Smart + intuitive: infer “what should happen now” from minimal signals.
 *  - Dynamic & configurable: rules-as-data, easy to extend per household.
 *  - Global-ready: time zone aware; avoids US-only assumptions.
 *  - Cross-domain: listens to approvals (cooking/cleaning/animal/gardening/inventory),
 *    inventory levels, meal plan slots, recipe steps, devices, & chat commands.
 *  - Meal flow: preheat/defrost/harden-off style prep reminders; calendar sync stubs.
 *
 * This file exports:
 *  - detectCookingTriggers(event, ctx) → Trigger[]   (pure function)
 *  - subscribeCookingTriggers(eventBus, ctx)         (optional live listener)
 *
 * It cooperates with:
 *  - Calendar sync (e.g., useCalendarSyncOnApproval)
 *  - Meal plan rhythm generator (generateMealPlanFromRhythm)
 *  - Recipe parsing (parseRecipeSteps)
 *  - Inventory service (low/expiring → shopping/defrost suggestions)
 *
 * NOTE: Kept as plain JS with rich JSDoc typedefs to fit your repo.
 */

// luxon removed (browser-safe)

/** @typedef {import('../planning/parseRecipeSteps')} ParseRecipeStepsModule */
/** @typedef {import('../planning/getZonePlantingDates')} PlantingDatesModule */

/**
 * @typedef {Object} Trigger
 * @property {string} type                // e.g., 'START_RECIPE', 'PREHEAT_APPLIANCE', 'THAW_REMINDER', ...
 * @property {string} [reason]            // human-readable explanation
 * @property {Record<string, any>} [data] // payload for action handlers
 * @property {('low'|'medium'|'high')} [confidence] // default 'medium'
 */

/**
 * @typedef {Object} DetectContext
 * @property {string} tz                                // IANA timezone
 * @property {(iso: string)=>Promise<string[]>} [calendarTagLookup] // mirrors meal rhythm option
 * @property {Object} [stores]
 * @property {Object} [stores.mealRhythm]               // optional: { rules: [...] }
 * @property {Object} [stores.inventory]                // optional: inventory API
 * @property {Object} [stores.recipes]                  // optional: recipes API
 * @property {Object} [services]
 * @property {Object} [services.calendar]               // optional: calendar sync API
 * @property {ParseRecipeStepsModule} [services.parse]  // optional: parseRecipeSteps default export
 * @property {PlantingDatesModule} [services.planting]  // optional
 * @property {Object} [user]
 * @property {string[]} [user.dietaryTags]              // e.g., ['kosher','gluten_free']
 * @property {string[]} [user.appliancePrefs]           // e.g., ['oven','airfryer','instant_pot']
 * @property {Object} [config]                          // dynamic rules config (see DEFAULT_RULES)
 */

/**
 * @typedef {Object} EventEnvelope
 * @property {string} kind          // 'chat','approval','calendar','inventory','device','location','timer'
 * @property {string} [subkind]     // e.g., chat:'text', approval:'status', device:'sensor'
 * @property {string} [id]          // source id
 * @property {string} [at]          // ISO timestamp event time (fallback: now)
 * @property {Record<string,any>} payload
 */

// ───────────────────────────────────────────────────────────────────────────────
// Dynamic Rules (data-first so you can override per-home)
// ───────────────────────────────────────────────────────────────────────────────

const DEFAULT_RULES = {
  approvals: {
    // Any approval with domain below + status 'approved' → sync + followups
    domains: ["cooking", "cleaning", "animal", "gardening", "inventory"],
    onApproved: [
      {
        type: "CALENDAR_SYNC",
        reason: "Approval granted; sync tasks/events.",
        confidence: "high",
      },
      {
        type: "ACK_APPROVAL",
        reason: "Send a quick acknowledgment and next steps.",
        confidence: "high",
      },
    ],
  },
  chatIntents: [
    // Lightweight NLP-free patterns; you can swap for an NLU later.
    {
      rx: /\b(what('s| is) for (dinner|lunch)|menu|meal plan)\b/i,
      triggers: [
        { type: "SHOW_TODAY_MEALS", reason: "User asked what's planned." },
      ],
    },
    {
      rx: /\b(start|open)\s+(recipe|cooking)\b/i,
      triggers: [
        { type: "OPEN_RECIPE", reason: "User asked to start a recipe." },
      ],
    },
    {
      rx: /\b(preheat|pre-heat)\b.*\b(oven|air ?fryer|airfryer)\b/i,
      triggers: [
        { type: "PREHEAT_APPLIANCE", reason: "User requested preheat." },
      ],
    },
    {
      rx: /\b(start|set)\b.*\b(timer|countdown)\b/i,
      triggers: [{ type: "START_TIMER", reason: "User requested a timer." }],
    },
    {
      rx: /\b(generate|make|build)\b.*\b(meal plan|menu)\b/i,
      triggers: [
        { type: "GENERATE_MEAL_PLAN", reason: "User asked for a plan." },
      ],
    },
    {
      rx: /\b(defrost|thaw)\b/i,
      triggers: [
        { type: "THAW_REMINDER", reason: "User mentioned thaw/defrost." },
      ],
    },
  ],
  mealPrep: {
    // Lead times before slot start to trigger prep steps
    warningMinutes: { preheat: 20, thaw: 480, marinade: 60, proof: 120 },
  },
  inventory: {
    // Thresholds / days before expiry to nudge actions
    lowThresholdPct: 0.2,
    expiryWarningDays: 3,
    onLow: [{ type: "CREATE_SHOPPING_TASK", reason: "Stock low." }],
    onExpiring: [
      { type: "COOK_SOON_SUGGESTION", reason: "Item expiring soon." },
    ],
  },
  devices: {
    // Map device events to kitchen actions
    patterns: [
      {
        rx: /\boven_preheat_complete\b/i,
        triggers: [{ type: "NOTIFY_PREHEAT_DONE", reason: "Oven is ready." }],
      },
      {
        rx: /\bfridge_door_open_too_long\b/i,
        triggers: [
          { type: "SAFETY_NUDGE", reason: "Fridge door open warning." },
        ],
      },
    ],
  },
  calendar: {
    // For upcoming meal slots (from MealRhythm calendar or tags)
    // Tag-based hints: if event has tag FAST → skip cooking nudges
    lookAheadMinutes: 120,
  },
  location: {
    // Example: when user arrives home within a window before meal slot, kick off prep
    homeGeofenceId: "home",
    arriveLeadMinutes: 45,
  },
};

// ───────────────────────────────────────────────────────────────────────────────
// Time helpers (browser-safe; avoids luxon)
// ───────────────────────────────────────────────────────────────────────────────

const MS_MIN = 60 * 1000;
const MS_DAY = 24 * 60 * 60 * 1000;

function nowMs() {
  return Date.now();
}
function nowIso() {
  return new Date().toISOString();
}
function parseMs(iso) {
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}
function minutesBetweenMs(aMs, bMs) {
  return (aMs - bMs) / MS_MIN;
}
function daysBetweenMs(aMs, bMs) {
  return (aMs - bMs) / MS_DAY;
}

// ───────────────────────────────────────────────────────────────────────────────
// Core: detection function
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Detects recommended actions (triggers) from a single event.
 * Pure function: does not mutate stores; returns list of Trigger.
 * @param {EventEnvelope} event
 * @param {DetectContext} ctx
 * @returns {Trigger[]}
 */
function detectCookingTriggers(event, ctx = {}) {
  const tz = ctx.tz || "America/New_York";
  const rules = mergeRules(DEFAULT_RULES, ctx.config);

  // Keep `now` available for location logic; use Date (tz carried in ctx for downstream services)
  const now = {
    ms: event?.at ? parseMs(event.at) : nowMs(),
    iso: event?.at || nowIso(),
    tz,
  };

  switch ((event.kind || "").toLowerCase()) {
    case "approval":
      return detectFromApproval(event, rules);
    case "chat":
      return detectFromChat(event, rules);
    case "inventory":
      return detectFromInventory(event, rules, tz);
    case "calendar":
      return detectFromCalendar(event, rules, tz, ctx);
    case "device":
      return detectFromDevice(event, rules);
    case "location":
      return detectFromLocation(event, rules, tz, ctx, now);
    case "timer":
      return detectFromTimer(event, tz);
    default:
      return [];
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Per-domain detectors
// ───────────────────────────────────────────────────────────────────────────────

/** @param {EventEnvelope} event */
function detectFromApproval(event, rules) {
  // payload: { domain: 'cooking'|'cleaning'|'animal'|'gardening'|'inventory', status: 'approved'|'rejected', notes? }
  const p = event.payload || {};
  const domain = (p.domain || "").toLowerCase();
  const status = (p.status || "").toLowerCase();

  if (status === "approved" && rules.approvals.domains.includes(domain)) {
    // Inventory 'approved' is now included as requested
    // Fire all onApproved triggers, tagging domain
    return (rules.approvals.onApproved || []).map((t) => ({
      ...t,
      data: { domain, approvalId: event.id, notes: p.notes || null },
    }));
  }
  return [];
}

/** @param {EventEnvelope} event */
function detectFromChat(event, rules) {
  // payload: { text: string }
  const text = (event.payload && event.payload.text) || "";
  if (!text.trim()) return [];

  const hits = [];
  for (const pat of rules.chatIntents) {
    if (pat.rx.test(text)) {
      for (const trig of pat.triggers) {
        hits.push({
          ...trig,
          confidence: trig.confidence || "high",
          data: { text },
        });
      }
    }
  }
  return hits;
}

/** @param {EventEnvelope} event */
function detectFromInventory(event, rules, tz) {
  // payload can be one of:
  // { itemId, sku, name, qty, capacity, expiryISO }
  // OR { low: [{...}], expiring: [{...}] } in a batch update shape
  const p = event.payload || {};
  const out = [];
  const lowThresholdPct = rules.inventory.lowThresholdPct;
  const expiryWarnDays = rules.inventory.expiryWarningDays;

  const items = [];
  if (Array.isArray(p.low) || Array.isArray(p.expiring)) {
    (p.low || []).forEach((i) => items.push({ ...i, _low: true }));
    (p.expiring || []).forEach((i) => items.push({ ...i, _expiring: true }));
  } else {
    items.push(p);
  }

  for (const it of items) {
    const name = it.name || it.sku || it.itemId || "item";

    // Low stock
    if (
      typeof it.qty === "number" &&
      typeof it.capacity === "number" &&
      it.capacity > 0
    ) {
      const pct = it.qty / it.capacity;
      if (pct <= lowThresholdPct || it._low) {
        for (const trig of rules.inventory.onLow || []) {
          out.push({
            ...trig,
            confidence: "high",
            data: { item: it, percent: pct, tz },
          });
        }
      }
    }

    // Expiring soon
    if (it.expiryISO) {
      const expMs = parseMs(it.expiryISO);
      if (Number.isFinite(expMs)) {
        const now = nowMs();
        const days = daysBetweenMs(expMs, now);
        if (days <= expiryWarnDays || it._expiring) {
          for (const trig of rules.inventory.onExpiring || []) {
            out.push({
              ...trig,
              confidence: "medium",
              data: {
                item: it,
                daysToExpiry: Math.max(-999, Math.round(days)),
                tz,
              },
            });
          }

          // Bonus: thaw/prep suggestion for proteins
          if (/\b(chicken|beef|pork|fish|lamb|turkey|shrimp)\b/i.test(name)) {
            out.push({
              type: "THAW_REMINDER",
              reason: `${name} expiring in ${Math.ceil(
                days
              )}d — plan to cook soon.`,
              confidence: "medium",
              data: { item: it, tz },
            });
          }
        }
      }
    }
  }

  return out;
}

/** @param {EventEnvelope} event */
function detectFromCalendar(event, rules, tz, ctx) {
  // payload: { id, title, startISO, endISO, tags?: string[], source?: string }
  const p = event.payload || {};
  const out = [];

  const startMs = parseMs(p.startISO || "");
  if (!Number.isFinite(startMs)) return out;

  const mins = minutesBetweenMs(startMs, nowMs());
  const tags = (p.tags || []).map((s) => String(s).toLowerCase());

  // Skip nudges if calendar marks a fast window
  if (tags.includes("fast") || tags.includes("fasting")) return out;

  // Approaching a meal slot? Suggest preheat/thaw from parsed recipe (if present)
  if (
    mins <= (rules.calendar.lookAheadMinutes || 120) &&
    /^(meal|lunch|dinner|breakfast|snack)/i.test(p.title || "")
  ) {
    // If we have a parsed recipe attached in payload, infer preheat/thaw
    const steps = Array.isArray(p.recipeSteps) ? p.recipeSteps : [];
    const hasPreheat = steps.some(
      (s) =>
        String(s.action || "").toLowerCase() === "preheat" ||
        (Array.isArray(s.equipment) ? s.equipment : []).includes("oven")
    );
    const hasThaw =
      /\b(thaw|defrost)\b/i.test(JSON.stringify(steps)) ||
      (p.tags || []).some((t) => /frozen/i.test(String(t)));

    if (hasThaw && mins >= (rules.mealPrep.warningMinutes.thaw || 480)) {
      out.push({
        type: "THAW_REMINDER",
        reason: `Thaw ahead of ${p.title} starting in ~${Math.round(
          mins
        )} min.`,
        confidence: "high",
        data: { eventId: p.id, windowStart: p.startISO, tz },
      });
    }
    if (hasPreheat && mins <= (rules.mealPrep.warningMinutes.preheat || 20)) {
      out.push({
        type: "PREHEAT_APPLIANCE",
        reason: `Preheat needed for ${p.title} soon.`,
        confidence: "high",
        data: {
          eventId: p.id,
          appliance: inferApplianceFromSteps(steps),
          targetTempF: extractTargetTempF(steps),
          tz,
        },
      });
    }
    out.push({
      type: "SHOW_COOKING_CHECKLIST",
      reason: `Prep checklist for ${p.title}.`,
      confidence: "medium",
      data: { eventId: p.id, steps, tz },
    });
  }

  return out;
}

/** @param {EventEnvelope} event */
function detectFromDevice(event, rules) {
  // payload: { code: string, data?: any }
  const p = event.payload || {};
  const code = String(p.code || "");
  const out = [];

  for (const pat of rules.devices.patterns || []) {
    if (pat.rx.test(code)) {
      for (const trig of pat.triggers) {
        out.push({
          ...trig,
          data: { device: event.id, raw: p },
          confidence: trig.confidence || "high",
        });
      }
    }
  }
  // Extra: if probe temp reached target, nudge rest/serve
  if (/probe_temp_reached/i.test(code)) {
    out.push({
      type: "NOTIFY_TEMP_TARGET",
      reason: "Target temperature reached.",
      confidence: "high",
      data: p,
    });
  }
  return out;
}

/** @param {EventEnvelope} event */
function detectFromLocation(event, rules, tz, ctx, now) {
  // payload: { geofenceId, transition: 'enter'|'exit' }
  const p = event.payload || {};
  const out = [];
  const gfHome = rules.location.homeGeofenceId;

  if (p.geofenceId === gfHome && p.transition === "enter") {
    // If a meal slot starts soon, suggest kicking off time-sensitive prep
    const lead = rules.location.arriveLeadMinutes || 45;
    const upcomingMeal = nearestMealEvent(ctx, tz, now, lead);
    if (upcomingMeal) {
      out.push({
        type: "START_PREP_ON_ARRIVAL",
        reason: `Arrived home ${lead}m before ${upcomingMeal.title}.`,
        confidence: "high",
        data: {
          eventId: upcomingMeal.id,
          title: upcomingMeal.title,
          startISO: upcomingMeal.startISO,
          tz,
        },
      });
    }
  }
  return out;
}

/** @param {EventEnvelope} event */
function detectFromTimer(event, tz) {
  // payload: { name, remainingSec, state: 'elapsed'|'running' }
  const p = event.payload || {};
  const out = [];
  if (p.state === "elapsed") {
    out.push({
      type: "TIMER_ELAPSED",
      reason: `Timer "${p.name || "timer"}" finished.`,
      confidence: "high",
      data: { ...p, tz },
    });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────────────

function mergeRules(base, extra) {
  if (!extra) return base;
  // shallow merge top-level, special-case arrays/objects
  const out = { ...base, ...extra };
  if (extra.approvals)
    out.approvals = { ...base.approvals, ...extra.approvals };
  if (extra.inventory)
    out.inventory = { ...base.inventory, ...extra.inventory };
  if (extra.calendar) out.calendar = { ...base.calendar, ...extra.calendar };
  if (extra.location) out.location = { ...base.location, ...extra.location };
  if (Array.isArray(extra.chatIntents))
    out.chatIntents = [...base.chatIntents, ...extra.chatIntents];
  if (extra.devices) {
    out.devices = { ...base.devices };
    out.devices.patterns = [
      ...(base.devices.patterns || []),
      ...(extra.devices.patterns || []),
    ];
  }
  return out;
}

function nearestMealEvent(ctx, tz, now, withinMinutes) {
  // If you have calendar service attached, query it; otherwise rely on injected context
  const cal = ctx.services && ctx.services.calendar;
  if (!cal || typeof cal.getUpcomingEvents !== "function") return null;

  const nowMsVal = Number.isFinite(now?.ms) ? now.ms : nowMs();
  const maxMs = nowMsVal + (Number(withinMinutes) || 0) * MS_MIN;

  const events =
    cal.getUpcomingEvents({
      withinMinutes,
      filterTags: ["meal", "lunch", "dinner", "breakfast", "snack"],
      tz,
    }) || [];

  let best = null;
  let bestStart = Infinity;

  for (const e of events) {
    const s = parseMs(e.startISO);
    if (!Number.isFinite(s)) continue;
    if (s >= nowMsVal && s <= maxMs) {
      if (s < bestStart) {
        bestStart = s;
        best = e;
      }
    }
  }

  return best;
}

function inferApplianceFromSteps(steps) {
  // prefer oven/airfryer/instant pot based on equipment tags computed by parseRecipeSteps
  const eq = new Set(
    (steps || []).flatMap((s) => s.equipment || s.tools || [])
  );
  if (eq.has("oven")) return "oven";
  if (eq.has("airfryer")) return "airfryer";
  if (eq.has("instant_pot") || eq.has("pressure")) return "instant_pot";
  if (eq.has("pan") || eq.has("pot")) return "stovetop";
  return "oven";
}

function extractTargetTempF(steps) {
  // Look for the highest temperature mentioned (conservative preheat target)
  let best = 0;
  for (const s of steps || []) {
    const t = s.temperature || "";
    const m = String(t).match(/(\d{2,3})\s*°?\s*(F|C)/i);
    if (m) {
      let val = parseInt(m[1], 10);
      if (/C/i.test(m[2])) val = Math.round((val * 9) / 5 + 32);
      if (val > best) best = val;
    }
  }
  return best || 375;
}

// ───────────────────────────────────────────────────────────────────────────────
// Live subscription (optional)
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Wires an event bus into this detector and emits 'trigger' events.
 * @param {{ on: Function, emit?: Function }} eventBus  // Node-style EventEmitter-like
 * @param {DetectContext} ctx
 */
function subscribeCookingTriggers(eventBus, ctx = {}) {
  if (!eventBus || typeof eventBus.on !== "function") {
    throw new Error(
      "subscribeCookingTriggers requires an EventEmitter-like bus with .on()"
    );
  }

  // Debounce guard for noisy sources
  const seen = new Map(); // key -> lastMs
  const dupeWindowMs = 2500;

  const handle = (event) => {
    try {
      const triggers = detectCookingTriggers(event, ctx) || [];
      const nowM = nowMs();
      const nowI = nowIso();

      for (const trig of triggers) {
        const key = `${trig.type}:${JSON.stringify(trig.data || {})}`;
        const lastMs = seen.get(key);

        if (!lastMs || nowM - lastMs > dupeWindowMs) {
          seen.set(key, nowM);
          // Re-emit as 'trigger' for downstream orchestrators
          if (typeof eventBus.emit === "function") {
            eventBus.emit("trigger", {
              at: nowI,
              trigger: trig,
              sourceEvent: event,
            });
          }
        }
      }
    } catch (e) {
      if (typeof eventBus.emit === "function") {
        eventBus.emit("error", {
          where: "detectCookingTriggers",
          error: e,
          sourceEvent: event,
        });
      }
    }
  };

  // Attach listeners (extend as your bus supports)
  eventBus.on("chat", handle);
  eventBus.on("approval", handle);
  eventBus.on("calendar", handle);
  eventBus.on("inventory", handle);
  eventBus.on("device", handle);
  eventBus.on("location", handle);
  eventBus.on("timer", handle);

  return () => {
    // provide a basic unsubscribe if your bus supports .off
    [
      "chat",
      "approval",
      "calendar",
      "inventory",
      "device",
      "location",
      "timer",
    ].forEach((k) => {
      if (typeof eventBus.off === "function") eventBus.off(k, handle);
    });
  };
}

// ───────────────────────────────────────────────────────────────────────────────
// Exports
// ───────────────────────────────────────────────────────────────────────────────

module.exports = {
  detectCookingTriggers,
  subscribeCookingTriggers,
  DEFAULT_RULES,
};

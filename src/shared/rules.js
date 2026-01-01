// C:\Users\larho\suka-smart-assistant\src\shared\rules.js
/**
 * Suka Shared Rules Engine (dynamic, Sabbath-aware)
 * -------------------------------------------------
 * A lightweight, pluggable policy layer that scores, filters, and schedules
 * nudges/actions across domains (cooking, cleaning, gardening, animals, inventory).
 *
 * Goals this serves:
 * - Centralize household heuristics (quiet hours, Sabbath avoidance, cooldowns)
 * - Convert raw events/triggers into user-friendly nudges with priorities
 * - Provide guardrails (don’t spam, avoid low-value nudges, de-duplicate)
 * - Allow dynamic overlays via `rules.local.js` or browser global
 * - Keep orchestration flexible: pure functions, no hard dependencies
 *
 * Usage (Node/Browser):
 *   const Rules = require("@/shared/rules");
 *   const engine = Rules.createEngine(); // loads base+overlays
 *   const decisions = await engine.evaluate({ events, triggers, ctx });
 *   decisions.forEach(n => emit("automation/nudge", n))
 *
 * Notation:
 *  - ctx: context snapshot (see householdOrchestrator getHouseholdContext())
 *  - events: array of event names (see ontology.events)
 *  - triggers: array of detector outputs (see detectCleaningTriggers, etc.)
 *
 * Exports:
 *   createEngine(options?): RulesEngine
 *   defaultRules(): Rule[]              // base rules (read-only copy)
 *   helpers: { isSabbath, inQuietHours, ... }
 *   setStorage(adapter)                 // optional persistence for cooldowns
 */

const isBrowser = typeof window !== "undefined";
const { EVENTS } = (() => {
  try { return require("./ontology"); } catch { return { EVENTS: {} }; }
})();

/* ----------------------------------------------------------------------------
 * Types (JSDoc)
 * -------------------------------------------------------------------------- */
/**
 * @typedef {Object} Rule
 * @property {string} id                      Unique id
 * @property {number} [priority=0.5]          Base priority 0..1
 * @property {(input:EvalInput)=>boolean} when
 * @property {(input:EvalInput)=>Nudge|Nudge[]|null|Promise<Nudge|Nudge[]|null>} then
 * @property {number} [cooldownMs=0]          Minimum time between emissions of this rule
 * @property {boolean} [oncePerDay=false]     Gate to one emission/day
 * @property {boolean} [sabbathAware=true]    Skip during Sabbath (unless critical)
 * @property {boolean} [respectQuietHours=true] Skip/defers during quiet hours
 * @property {('allow'|'suppress'|'defer')} [defaultAction='allow']
 * @property {(nudge:Nudge,input:EvalInput)=>Nudge|false|void} [post]
 */

/**
 * @typedef {Object} Nudge
 * @property {string} title
 * @property {string} message
 * @property {number} [priority]              0..1; can be adjusted by engine
 * @property {Array<{id:string,label:string,meta?:any}>} [actions]
 * @property {Array<{startISO:string,endISO:string,label?:string}>} [suggestedWindows]
 * @property {string} [ruleId]                which rule created it
 * @property {('info'|'tip'|'warning'|'critical')} [level='info']
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} EvalInput
 * @property {Date} now
 * @property {Array<string>} events
 * @property {Array<any>} triggers
 * @property {Object} ctx                     context snapshot
 */

/* ----------------------------------------------------------------------------
 * Persistence (cooldowns etc.)
 * -------------------------------------------------------------------------- */
let storage = (() => {
  // Fallback ephemeral store
  let map = new Map();
  return {
    async get(k) { return map.get(k); },
    async set(k, v) { map.set(k, v); return true; },
    async del(k) { map.delete(k); },
  };
})();

function setStorage(adapter) {
  if (adapter && typeof adapter.get === "function" && typeof adapter.set === "function") {
    storage = adapter;
  }
}

/* ----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */
const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
const toDate = (x) => {
  if (!x) return null;
  const d = new Date(x);
  return isNaN(d.getTime()) ? null : d;
};

function getQuietHours(settings) {
  // Defaults 21:00–07:00 local
  const q = settings?.quietHours || { start: 21, end: 7 };
  return { startHour: Number(q.start ?? 21), endHour: Number(q.end ?? 7) };
}

function inQuietHours(now, settings) {
  const { startHour, endHour } = getQuietHours(settings);
  const h = now.getHours();
  if (startHour < endHour) {
    return h >= startHour && h < endHour;
  }
  // spans midnight
  return h >= startHour || h < endHour;
}

function nextDayAt(now, hour) {
  const d = new Date(now);
  const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, hour, 0, 0, 0);
  return tomorrow;
}

function isSabbath(now, settings) {
  // Project policy: avoid Saturday; use optional precise window if available via ontology.sabbath()
  try {
    const ont = require("./ontology");
    const win = ont?.sabbath?.(now);
    if (win?.startISO && win?.endISO) {
      const s = new Date(win.startISO), e = new Date(win.endISO);
      return now >= s && now < e;
    }
  } catch {}
  // Fallback: Friday 18:00 to Saturday 18:00 approximate
  const day = now.getDay();
  const fri18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((5 - day + 7) % 7), 18, 0, 0, 0);
  const sat18 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + ((6 - day + 7) % 7), 18, 0, 0, 0);
  return now >= fri18 && now < sat18;
}

function keyDaily(id, now) {
  const d = `${now.getFullYear()}-${now.getMonth()+1}-${now.getDate()}`;
  return `rule:${id}:day:${d}`;
}
function keyCooldown(id) { return `rule:${id}:cooldown`; }

/* ----------------------------------------------------------------------------
 * Scoring tweaks (global)
 * -------------------------------------------------------------------------- */
function applyGlobalScoring(nudge, { ctx, now }) {
  const out = { ...nudge };
  const settings = ctx?.settings || {};

  // Down-rank during quiet hours (unless warning/critical)
  if (inQuietHours(now, settings) && !/warning|critical/.test(out.level || "")) {
    out.priority = clamp01((out.priority ?? 0.5) * 0.8);
  }

  // Up-rank for Sabbath prep day (typically Friday)
  const dow = now.getDay(); // 5=Friday
  if (dow === 5 && /sabbath|shabbat|prep/i.test(`${out.title} ${out.message}`)) {
    out.priority = clamp01(Math.max(out.priority ?? 0.5, 0.8));
  }

  // Up-rank "expires soon" items
  if (out.meta?.expiresAt) {
    const exp = toDate(out.meta.expiresAt);
    if (exp && exp.getTime() - now.getTime() < 36 * 3600 * 1000) {
      out.priority = clamp01(Math.max(out.priority ?? 0.5, 0.85));
      out.level = out.level || "warning";
    }
  }

  return out;
}

/* ----------------------------------------------------------------------------
 * Base Rules
 * -------------------------------------------------------------------------- */
/**
 * NOTE: These rules align with modules we already updated:
 * - detectCleaningTriggers (SUPPLY_LOW, SUPPLY_OVERDUE, ZONE_OVERDUE)
 * - householdOrchestrator (EVENTS.*)
 * - loadCalendarContext (freeBlocks, sabbath window)
 */
function baseRules() {
  const R = [];

  // 1) Cleaning supply low -> Suggest restock
  R.push({
    id: "cleaning:supply-low",
    priority: 0.78,
    cooldownMs: 4 * 3600 * 1000, // 4h
    oncePerDay: true,
    when: ({ triggers }) => (triggers || []).some(t => t.type === "SUPPLY_LOW"),
    then: async ({ triggers }) => {
      const lows = triggers.filter(t => t.type === "SUPPLY_LOW");
      return lows.map(t => ({
        title: "Cleaning supply running low",
        message: t.message,
        level: t.severity === "high" ? "warning" : "info",
        priority: t.severity === "high" ? 0.92 : 0.78,
        actions: [{ id: "add-to-shopping-list", label: "Add to shopping list", meta: { item: t?.meta?.name || t.key } }],
        suggestedWindows: t.suggestedWindows || [],
        ruleId: "cleaning:supply-low",
        meta: { supply: t.key, daysLeft: t.meta?.daysLeft ?? null },
      }));
    },
  });

  // 2) Cleaning zone overdue -> Suggest schedule
  R.push({
    id: "cleaning:zone-overdue",
    priority: 0.75,
    cooldownMs: 3 * 3600 * 1000,
    when: ({ triggers }) => (triggers || []).some(t => t.type === "ZONE_OVERDUE"),
    then: async ({ triggers }) => {
      const zones = triggers.filter(t => t.type === "ZONE_OVERDUE");
      return zones.map(t => ({
        title: `Cleaning due: ${String(t.key || "").split(":")[1] || "Zone"}`,
        message: t.message,
        priority: t.severity === "high" ? 0.9 : 0.75,
        actions: [{ id: "open-cleaning-checklist", label: "Open checklist" }],
        suggestedWindows: t.suggestedWindows || [],
        ruleId: "cleaning:zone-overdue",
        meta: { zone: t.key },
      }));
    },
  });

  // 3) Sabbath prep heuristic when COOKING planned and it's not evening yet
  R.push({
    id: "sabbath:prep-bundle",
    priority: 0.95,
    sabbathAware: false, // This is ABOUT sabbath prep, allow during Friday daytime
    respectQuietHours: true,
    oncePerDay: true,
    when: ({ events, ctx }) => {
      const tod = String(ctx?.tod || "");
      const isPlanned = events?.includes(EVENTS?.SESSION?.PLANNED?.COOKING);
      const day = (new Date()).getDay();
      return isPlanned && day === 5 && tod !== "evening";
    },
    then: async ({ ctx }) => {
      const msg = "Line up meals and do a quick high-visibility tidy. Aim to finish before sundown.";
      return {
        title: "Shabbat prep flow",
        message: msg,
        level: "tip",
        priority: 0.95,
        actions: [
          { id: "open-prep-checklist", label: "Open prep checklist" },
          { id: "open-cleaning-checklist", label: "Quick tidy" },
        ],
        ruleId: "sabbath:prep-bundle",
      };
    },
  });

  // 4) Batch cooking planned (morning/afternoon) -> Kitchen reset nudge
  R.push({
    id: "cooking:kitchen-reset-priming",
    priority: 0.82,
    cooldownMs: 2 * 3600 * 1000,
    when: ({ events, ctx }) => {
      const planned = events?.includes(EVENTS?.SESSION?.PLANNED?.COOKING);
      return planned && ctx?.tod !== "evening";
    },
    then: async () => ({
      title: "Quick kitchen reset for smoother batch cooking",
      message: "Clear counters, empty sink, stage tools (≈10 min).",
      actions: [{ id: "start-reset", label: "Start 10-min timer" }],
      priority: 0.82,
      ruleId: "cooking:kitchen-reset-priming",
    }),
  });

  // 5) Garden harvest window event -> Offer harvest & preservation queue
  R.push({
    id: "garden:harvest-window",
    priority: 0.89,
    cooldownMs: 6 * 3600 * 1000,
    respectQuietHours: true,
    when: ({ events }) => events?.includes(EVENTS?.GARDEN?.HARVEST_WINDOW),
    then: async () => ({
      title: "Garden is ready — use it well",
      message: "Schedule harvest, queue preservation, and add fresh meals.",
      actions: [
        { id: "schedule-harvest", label: "Schedule harvest" },
        { id: "queue-preserve",   label: "Queue preservation" },
        { id: "add-meals",        label: "Add meals" },
      ],
      priority: 0.89,
      ruleId: "garden:harvest-window",
    }),
  });

  return R;
}

/* ----------------------------------------------------------------------------
 * Overlay loader (browser global + rules.local.js)
 * -------------------------------------------------------------------------- */
function loadOverlays() {
  let extra = [];
  // Browser overlay
  if (isBrowser && Array.isArray(window.__SUKA_RULES__)) {
    extra = extra.concat(window.__SUKA_RULES__);
  }
  // Local file overlay (CJS or ESM-like default)
  try {
    // eslint-disable-next-line global-require
    const local = require("./rules.local.js");
    const arr = local?.default || local;
    if (Array.isArray(arr)) extra = extra.concat(arr);
  } catch {}
  return extra;
}

/* ----------------------------------------------------------------------------
 * Engine
 * -------------------------------------------------------------------------- */
function createEngine(options = {}) {
  const base = baseRules();
  const overlays = loadOverlays();
  const rules = [...base, ...overlays].map((r) => ({
    sabbathAware: true,
    respectQuietHours: true,
    defaultAction: "allow",
    cooldownMs: 0,
    oncePerDay: false,
    ...r,
    priority: clamp01(r.priority ?? 0.5),
  }));

  async function _gate(rule, now) {
    // cooldown
    if (rule.cooldownMs > 0) {
      const ck = await storage.get(keyCooldown(rule.id));
      if (ck && now.getTime() - Number(ck) < rule.cooldownMs) return false;
    }
    // once per day
    if (rule.oncePerDay) {
      const dk = await storage.get(keyDaily(rule.id, now));
      if (dk) return false;
    }
    return true;
  }

  async function _mark(rule, now) {
    if (rule.cooldownMs > 0) await storage.set(keyCooldown(rule.id), String(now.getTime()));
    if (rule.oncePerDay) await storage.set(keyDaily(rule.id, now), "1");
  }

  function _applyPolicy(rule, nudge, input) {
    const settings = input?.ctx?.settings || {};
    const now = input.now;

    // Sabbath-aware
    if (rule.sabbathAware !== false && isSabbath(now, settings)) {
      // Allow warnings/criticals; defer tips/infos to after Sabbath
      if (!/warning|critical/.test(nudge.level || "")) {
        return { action: "defer", until: nextDayAt(now, 20) }; // defer to tomorrow 8pm (after typical end)
      }
    }

    // Quiet hours respect
    if (rule.respectQuietHours !== false && inQuietHours(now, settings)) {
      if (!/warning|critical/.test(nudge.level || "")) {
        const { endHour } = getQuietHours(settings);
        const until = new Date(now);
        if (now.getHours() >= endHour) {
          // past end hour but still in quiet block (spans midnight)
          until.setDate(now.getDate() + 1);
        }
        until.setHours(endHour, 0, 0, 0);
        return { action: "defer", until };
      }
    }

    return { action: "allow" };
  }

  function _dedupe(nudges) {
    const seen = new Set();
    const out = [];
    for (const n of nudges) {
      const key = `${n.ruleId || "rule"}::${(n.title || "").toLowerCase()}::${(n.message || "").toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(n);
    }
    return out;
  }

  async function evaluate(inputRaw) {
    const now = inputRaw?.now instanceof Date ? inputRaw.now : new Date();
    const input = { ...inputRaw, now, events: inputRaw?.events || [], triggers: inputRaw?.triggers || [], ctx: inputRaw?.ctx || {} };

    const out = [];

    for (const rule of rules) {
      try {
        if (!rule.when || typeof rule.when !== "function") continue;
        const eligible = await rule.when(input);
        if (!eligible) continue;

        // Gate by cooldown/once-per-day
        if (!(await _gate(rule, now))) continue;

        // Execute
        const res = await rule.then(input);
        const nudges = Array.isArray(res) ? res : (res ? [res] : []);
        if (!nudges.length) continue;

        for (const n0 of nudges) {
          let n = { ...n0, priority: clamp01(n0.priority ?? rule.priority), ruleId: n0.ruleId || rule.id };

          // Rule-level post tweak
          if (typeof rule.post === "function") {
            const postRes = rule.post(n, input);
            if (postRes === false) continue; // suppressed
            if (postRes && typeof postRes === "object") n = postRes;
          }

          // Global scoring
          n = applyGlobalScoring(n, { ctx: input.ctx, now });

          // Policy (sabbath, quiet)
          const policy = _applyPolicy(rule, n, input);
          if (policy.action === "suppress") continue;
          if (policy.action === "defer") {
            n.meta = { ...(n.meta || {}), deferredUntilISO: policy.until?.toISOString?.() };
            // Optionally reduce priority for deferred items
            n.priority = clamp01((n.priority ?? 0.5) * 0.85);
          }

          out.push(n);
        }

        // Mark gates only if something was produced
        if (out.length) await _mark(rule, now);

      } catch (e) {
        // keep engine resilient
        // eslint-disable-next-line no-console
        console.warn("[rules] rule error", rule.id, e?.message || e);
      }
    }

    // De-dupe and top-sort
    const unique = _dedupe(out);
    unique.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    // Optional cap (caller may further filter)
    const cap = Number(options.maxNudges ?? 6);
    return unique.slice(0, cap);
  }

  return { evaluate, rules: () => [...rules] };
}

/* ----------------------------------------------------------------------------
 * Exports
 * -------------------------------------------------------------------------- */
module.exports = {
  createEngine,
  defaultRules: () => baseRules().map(r => ({ ...r })), // read-only copy
  helpers: { isSabbath, inQuietHours, getQuietHours },
  setStorage,
};
module.exports.default = module.exports;

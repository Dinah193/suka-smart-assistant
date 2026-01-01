/**
 * @file C:\Users\larho\suka-smart-assistant\src\engines\synthesis\SynthesisEngine.js
 *
 * SynthesisEngine — Core orchestrator that reads *domain rules* and generates
 * readiness / prep steps and optional executable sessions.
 *
 * PIPELINE FIT
 * imports → normalize → intelligence → **synthesis (this file)** → automation runtime
 * → (optional) hub export
 *
 * - Inputs: normalized imports (recipe/cleaning/garden/animal/preservation), inventory,
 *   calendar/time, household prefs.
 * - Outputs:
 *   • readinessSteps: human-sized prep actions (e.g., “thaw chicken 12h”, “sterilize jars”)
 *   • sessionSuggestions: structured, schedulable sessions (e.g., “Meal: Chickpea Curry 6:30pm”)
 * - Side effects:
 *   • If `options.commit === true` and `sessionSuggestions.length > 0`, we persist to the
 *     SessionsStore (soft import; safe no-op if not present) and emit events.
 *   • On commit, we also try an optional Family Fund Hub export (guarded by feature flags).
 *
 * EVENT ENVELOPE SHAPE (every emit):
 *   { type, ts, source, data }
 *
 * EXTN POINTS
 *   registerDomainRules(domain, ruleset) — add/override rules at runtime.
 *   Rules are pure functions or declarative objects; see RuleSpec below.
 */

import eventBus from 'src/services/eventBus.js';

const SOURCE = 'SynthesisEngine';

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Generate readiness steps and (optionally) session suggestions from domain inputs.
 *
 * @param {Object} payload
 * @param {Array<Object>} payload.imports - normalized import items, each with:
 *      {id, domain: 'recipe'|'cleaning'|'garden'|'animal'|'preservation'|string,
 *       title, meta?, items?, methods?, equipment?, seasonality?, serves?, yield?}
 * @param {Object} payload.context
 *      { now: Date | string, tz: string, inventory: Record<sku,qty>, prefs?:object, weather?:object }
 * @param {Object} [options]
 *      { commit?: boolean, dedupe?: boolean, planId?: string, source?: string }
 * @returns {Promise<{ ok:boolean, readinessSteps:Array<PrepStep>, sessionSuggestions:Array<SessionSuggestion>, meta?:object }>}
 */
export async function synthesize({ imports, context }, options = {}) {
  const tsStart = nowISO();

  if (!Array.isArray(imports) || imports.length === 0) {
    emit('synthesis.completed', { ok: true, empty: true, steps: 0, sessions: 0 });
    return { ok: true, readinessSteps: [], sessionSuggestions: [], meta: { tsStart, tsEnd: nowISO() } };
  }

  const ctx = buildContext(context);
  const opts = {
    commit: !!options.commit,
    dedupe: options.dedupe !== false, // default true
    planId: stringOrNull(options.planId),
    source: options.source || SOURCE,
  };

  emit('synthesis.started', {
    imports: imports.length,
    domains: unique(imports.map((i) => i.domain)),
    planId: opts.planId || null,
  });

  const readinessSteps = [];
  const sessionSuggestions = [];
  const diagnostics = [];

  for (const item of imports) {
    const domain = (item?.domain || '').toLowerCase();
    const rules = getRulesForDomain(domain);

    if (!rules || rules.length === 0) {
      diagnostics.push({ level: 'warn', domain, reason: 'NO_RULES' });
      continue;
    }

    try {
      const { steps, sessions, diag } = await runRuleset({ item, rules, ctx, opts });
      if (Array.isArray(steps)) readinessSteps.push(...steps);
      if (Array.isArray(sessions)) sessionSuggestions.push(...sessions);
      if (diag?.length) diagnostics.push(...diag);
    } catch (err) {
      emit('synthesis.error', { domain, message: err?.message || 'rule execution failed' });
      diagnostics.push({ level: 'error', domain, reason: 'RULE_THROW', message: err?.message });
    }
  }

  // Dedupe & order
  const stepsOut = dedupeSteps(readinessSteps);
  const sessionsOut = dedupeSessions(sessionSuggestions);

  emit('synthesis.suggestion.generated', {
    steps: stepsOut.length,
    sessions: sessionsOut.length,
    planId: opts.planId || null,
  });

  // Optionally commit session suggestions to SessionsStore
  if (opts.commit && sessionsOut.length > 0) {
    const commitRes = await commitSessions(sessionsOut, { ctx, planId: opts.planId });
    if (commitRes.ok) {
      emit('synthesis.sessions.committed', { count: sessionsOut.length, planId: opts.planId || null });
      // Try optional hub export (fire and forget)
      await exportToHubIfEnabled({
        type: 'sessions.committed',
        ts: nowISO(),
        source: SOURCE,
        data: { planId: opts.planId || null, sessions: sessionsOut },
      });
    } else {
      emit('synthesis.error', { message: commitRes.error || 'commit failed' });
    }
  }

  const result = {
    ok: true,
    readinessSteps: stepsOut,
    sessionSuggestions: sessionsOut,
    meta: {
      diagnostics,
      tsStart,
      tsEnd: nowISO(),
    },
  };

  emit('synthesis.completed', {
    ok: true,
    steps: stepsOut.length,
    sessions: sessionsOut.length,
    planId: opts.planId || null,
  });

  return result;
}

/**
 * Register or override rules for a domain at runtime.
 * @param {string} domain - e.g., 'recipe', 'cleaning', 'garden', 'animal', 'preservation'
 * @param {Array<RuleSpec|RuleFn>} ruleset
 */
export function registerDomainRules(domain, ruleset = []) {
  const d = (domain || '').toLowerCase().trim();
  if (!d || !Array.isArray(ruleset)) return;
  RULES_REGISTRY.set(d, ruleset.slice());
  emit('synthesis.rules.registered', { domain: d, count: ruleset.length });
}

// Provide a snapshot of domains/rules for observability/UIs.
export function listDomains() {
  return Array.from(RULES_REGISTRY.keys());
}

// ───────────────────────────────────────────────────────────────────────────────
// Rule engine (lightweight)

//
// RuleSpec form (declarative):
// {
//   id: 'thaw-poultry',
//   when: ({item, ctx}) => boolean,
//   produce: ({item, ctx}) => ({ steps?:PrepStep[], sessions?:SessionSuggestion[], diag?:any[] }),
//   priority?: number // larger runs first in its stage
// }
//
// RuleFn form (imperative):
// async function ({item, ctx}) => { steps?, sessions?, diag? }
//
// A rule should be pure (no side effects). Persistence happens outside.
//

async function runRuleset({ item, rules, ctx, opts }) {
  const diag = [];
  const steps = [];
  const sessions = [];

  // Sort by priority desc; fallback to 0
  const ordered = rules.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0));

  for (const rule of ordered) {
    try {
      // Support both declarative and functional rules
      if (typeof rule === 'function') {
        const out = await rule({ item, ctx, options: opts });
        if (out?.steps) steps.push(...out.steps);
        if (out?.sessions) sessions.push(...out.sessions);
        if (out?.diag) diag.push(...out.diag);
      } else if (rule && typeof rule === 'object') {
        const shouldRun = typeof rule.when === 'function' ? !!rule.when({ item, ctx, options: opts }) : true;
        if (!shouldRun) continue;
        const out = typeof rule.produce === 'function' ? await rule.produce({ item, ctx, options: opts }) : null;
        if (out?.steps) steps.push(...out.steps);
        if (out?.sessions) sessions.push(...out.sessions);
        if (out?.diag) diag.push(...out.diag);
      }
    } catch (err) {
      diag.push({ level: 'error', rule: rule?.id || '<fn>', message: err?.message || 'rule error' });
    }
  }

  return { steps, sessions, diag };
}

// ───────────────────────────────────────────────────────────────────────────────
// Built-in rules (forward-looking; safe defaults for each domain)

const RULES_REGISTRY = new Map();

// Boot with a minimal useful set; callers can replace/extend later
bootstrapDefaultRules();

// ───────────────────────────────────────────────────────────────────────────────
// Persistence (sessions) with soft imports

async function commitSessions(sessions, { ctx, planId }) {
  try {
    const store =
      (await softImport('src/domain/sessions/SessionsStore.js')) ||
      (await softImport('src/services/sessions/SessionsStore.js')); // alt path
    if (!store) return { ok: false, error: 'SessionsStore unavailable' };

    // Allow either bulkUpsert or saveMany
    const fn =
      store.bulkUpsert ||
      store.saveMany ||
      (store.default && (store.default.bulkUpsert || store.default.saveMany));

    if (typeof fn !== 'function') {
      return { ok: false, error: 'No bulkUpsert/saveMany in SessionsStore' };
    }

    // Normalize shape
    const docs = sessions.map((s) => ({
      id: s.id || `sess:${hash(`${s.domain}:${s.title}:${s.start || ''}:${s.meta?.refId || ''}`)}`,
      domain: s.domain,
      title: s.title,
      start: s.start || null,
      end: s.end || null,
      needs: s.needs || {},
      meta: { ...(s.meta || {}), planId: planId || null },
      createdAt: nowISO(),
      status: 'suggested',
    }));

    const res = await fn.call(store, docs);
    return res?.ok !== false ? { ok: true, count: docs.length } : { ok: false, error: res?.error || 'store error' };
  } catch (err) {
    return { ok: false, error: err?.message || 'commit exception' };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Dedupers & normalizers

function dedupeSteps(steps) {
  const seen = new Set();
  const out = [];
  for (const s of steps) {
    const key = sKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: s.id || `prep:${hash(key)}`,
      title: s.title,
      domain: s.domain,
      dueBy: s.dueBy || null,
      priority: s.priority ?? 0,
      meta: s.meta || {},
    });
  }
  // Sort: higher priority first, then sooner due
  out.sort((a, b) => (b.priority - a.priority) || cmpISO(a.dueBy, b.dueBy));
  return out;
}

function dedupeSessions(sessions) {
  const seen = new Set();
  const out = [];
  for (const s of sessions) {
    const key = sessKey(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  // Sort: by start time if available
  out.sort((a, b) => cmpISO(a.start, b.start));
  return out;
}

function sKey(s) {
  return `${s.domain}|${s.title}|${s.dueBy || ''}|${JSON.stringify(s.meta || {})}`;
}
function sessKey(s) {
  return `${s.domain}|${s.title}|${s.start || ''}|${JSON.stringify(s.needs || {})}`;
}

// ───────────────────────────────────────────────────────────────────────────────
// Defaults & Rule helpers

function bootstrapDefaultRules() {
  // RECIPE domain — mise en place, thawing, preheat, marinate, soak beans
  RULES_REGISTRY.set('recipe', [
    // thaw if frozen proteins detected
    {
      id: 'recipe-thaw-protein',
      priority: 50,
      when: ({ item }) => hasAny(item?.items, (x) => /(chicken|beef|pork|fish|lamb)/i.test(x.name) && x.state === 'frozen'),
      produce: ({ item, ctx }) => {
        const hrs = 12;
        const due = isoMinusHours(ctx.now, hrs);
        return {
          steps: [{
            domain: 'recipe',
            title: `Thaw ${item.title} protein in fridge (${hrs}h)`,
            dueBy: due,
            priority: 9,
            meta: { refId: item.id, reason: 'frozen-protein' },
          }],
        };
      },
    },
    // Soak dried beans if present
    {
      id: 'recipe-soak-beans',
      priority: 40,
      when: ({ item }) => hasAny(item?.items, (x) => /(chickpea|garbanzo|bean)/i.test(x.name) && x.state === 'dried'),
      produce: ({ item, ctx }) => {
        const hrs = 8;
        const due = isoMinusHours(ctx.now, 2); // start 2h before to have time
        return {
          steps: [{
            domain: 'recipe',
            title: `Soak beans for ${hrs}h for ${item.title}`,
            dueBy: due,
            priority: 8,
            meta: { refId: item.id, reason: 'dried-legume' },
          }],
        };
      },
    },
    // Preheat step as a readiness action close to mealtime
    {
      id: 'recipe-preheat-oven',
      priority: 10,
      when: ({ item }) => hasAny(item?.methods, (m) => /bake|roast/i.test(m)),
      produce: ({ item }) => ({
        steps: [{
          domain: 'recipe',
          title: `Preheat oven for ${item.title}`,
          dueBy: null,
          priority: 5,
          meta: { refId: item.id, reason: 'oven-method' },
        }],
      }),
    },
    // Produce a session suggestion
    async function sessionSuggestion({ item, ctx }) {
      // If import contains desired time (e.g., dinner slot) use it; else leave null
      const start = item.meta?.desiredStart || null;
      return {
        sessions: [{
          domain: 'cooking',
          title: `Cook: ${item.title}`,
          start,
          needs: {
            devices: item.equipment?.includes('oven') ? ['oven-1'] : [],
            people: [], // automation can assign later
            capacity: [],
          },
          meta: { refId: item.id, origin: 'synthesis' },
        }],
      };
    },
  ]);

  // CLEANING domain — supplies check & vacuum scheduling off quiet hours
  RULES_REGISTRY.set('cleaning', [
    {
      id: 'cleaning-supply-check',
      priority: 20,
      produce: ({ item, ctx }) => {
        const shortages = (item.items || []).filter((it) => qty(ctx.inventory, it.sku) < (it.qty || 1));
        if (shortages.length === 0) return {};
        return {
          steps: shortages.map((s) => ({
            domain: 'cleaning',
            title: `Stock up: ${s.name}`,
            dueBy: null,
            priority: 6,
            meta: { refId: item.id, sku: s.sku, reason: 'inventory-shortage' },
          })),
        };
      },
    },
    {
      id: 'cleaning-schedule',
      priority: 10,
      when: ({ item }) => /vacuum|mop|disinfect/i.test(item.title || ''),
      produce: ({ item, ctx }) => {
        // Suggest a session outside quiet hours if we know them
        const start = nextOutsideQuietHours(ctx);
        return {
          sessions: [{
            domain: 'cleaning',
            title: item.title,
            start,
            needs: { devices: [], people: [], capacity: [] },
            meta: { refId: item.id },
          }],
        };
      },
    },
  ]);

  // GARDEN domain — watering windows, harvest readiness
  RULES_REGISTRY.set('garden', [
    {
      id: 'garden-water',
      priority: 15,
      when: ({ item }) => /watering/i.test(item.title || '') || hasAny(item?.methods, (m) => /water/i.test(m)),
      produce: ({ item, ctx }) => {
        const start = withinTimeWindow(ctx.prefs?.garden?.wateringWindow) || null;
        return {
          sessions: [{
            domain: 'garden',
            title: item.title || 'Water plants',
            start,
            needs: { devices: [], people: [], capacity: [] },
            meta: { refId: item.id },
          }],
        };
      },
    },
    {
      id: 'garden-harvest-readiness',
      priority: 10,
      when: ({ item }) => /harvest/i.test(item.title || ''),
      produce: ({ item }) => ({
        steps: [{
          domain: 'garden',
          title: `Clean tools & baskets for ${item.title}`,
          dueBy: null,
          priority: 5,
          meta: { refId: item.id },
        }],
      }),
    },
  ]);

  // ANIMAL domain — feed schedule
  RULES_REGISTRY.set('animal', [
    {
      id: 'animal-feed',
      priority: 10,
      when: ({ item }) => /feed|feeding/i.test(item.title || ''),
      produce: ({ item }) => ({
        sessions: [{
          domain: 'animal',
          title: item.title || 'Feed animals',
          start: null,
          needs: { devices: [], people: [], capacity: [] },
          meta: { refId: item.id },
        }],
      }),
    },
  ]);

  // PRESERVATION domain — jar sterilization
  RULES_REGISTRY.set('preservation', [
    {
      id: 'preservation-sterilize-jars',
      priority: 20,
      produce: ({ item }) => ({
        steps: [{
          domain: 'preservation',
          title: `Sterilize jars for ${item.title || 'preservation'}`,
          dueBy: null,
          priority: 8,
          meta: { refId: item.id },
        }],
      }),
    },
  ]);
}

// ───────────────────────────────────────────────────────────────────────────────
// Helpers: context, dates, inventory

function buildContext(context = {}) {
  const now = context.now ? new Date(context.now) : new Date();
  return {
    now,
    tz: context.tz || 'UTC',
    inventory: context.inventory || {},
    prefs: context.prefs || {},
    weather: context.weather || {},
    guards: context.guards || {},
  };
}

function qty(inventory, sku) {
  if (!sku) return 0;
  const v = inventory[sku];
  return Number.isFinite(v) ? v : 0;
}

function nextOutsideQuietHours(ctx) {
  const q = ctx?.guards?.quietHours;
  if (!q?.enabled) return null;
  try {
    const now = new Date(ctx.now);
    const [qsH, qsM] = (q.start || '21:00').split(':').map((x) => parseInt(x, 10));
    const [qeH, qeM] = (q.end || '07:00').split(':').map((x) => parseInt(x, 10));
    const startQ = new Date(now); startQ.setHours(qsH, qsM, 0, 0);
    const endQ = new Date(now); endQ.setHours(qeH, qeM, 0, 0);

    // If quiet spans midnight, ensure endQ > startQ
    if (endQ <= startQ) endQ.setDate(endQ.getDate() + 1);

    if (now >= startQ && now <= endQ) return endQ.toISOString();
    return null;
  } catch {
    return null;
  }
}

function withinTimeWindow([start, end] = []) {
  if (!start || !end) return null;
  const now = new Date();
  const [sH, sM] = start.split(':').map((x) => parseInt(x, 10));
  const [eH, eM] = end.split(':').map((x) => parseInt(x, 10));
  const s = new Date(now); s.setHours(sH, sM, 0, 0);
  const e = new Date(now); e.setHours(eH, eM, 0, 0);
  if (now < s) return s.toISOString();
  if (now > e) return null;
  return now.toISOString();
}

function isoMinusHours(base, hrs) {
  const d = new Date(base);
  d.setHours(d.getHours() - (hrs || 0));
  return d.toISOString();
}

function cmpISO(a, b) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return new Date(a) - new Date(b);
}

// ───────────────────────────────────────────────────────────────────────────────
// Telemetry

function emit(type, data) {
  try {
    eventBus.emit('automation.event', {
      type,
      ts: nowISO(),
      source: SOURCE,
      data,
    });
  } catch {
    /* never throw */
  }
}

function nowISO() {
  return new Date().toISOString();
}

// ───────────────────────────────────────────────────────────────────────────────
// Soft imports & utilities

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default || mod;
  } catch {
    return null;
  }
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function stringOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function hash(str) {
  let h = 2166136261 >>> 0; // FNV-1a tiny impl
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

function hasAny(list, pred) {
  return Array.isArray(list) && list.some(pred);
}

// ───────────────────────────────────────────────────────────────────────────────
// Optional Hub export helper (only for household data mutations, i.e., sessions commit)

async function exportToHubIfEnabled(payload) {
  try {
    const flagsMod = await softImport('src/config/featureFlags.js');
    const featureFlags = flagsMod?.default || flagsMod || {};
    if (!featureFlags.familyFundMode) return;

    const Formatter = await softImport('src/services/hub/HubPacketFormatter.js');
    const Connector = await softImport('src/services/hub/FamilyFundConnector.js');
    if (!Formatter || !Connector) return;

    const packet =
      (Formatter.format && Formatter.format(payload)) ||
      (Formatter.default && Formatter.default.format && Formatter.default.format(payload)) ||
      null;
    if (!packet) return;

    const send =
      Connector.send ||
      (Connector.default && Connector.default.send);
    if (typeof send !== 'function') return;

    await send(packet);
  } catch {
    // fail silent by design
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Type hints (JSDoc)

/**
 * @typedef {Object} PrepStep
 * @property {string} id
 * @property {string} domain
 * @property {string} title
 * @property {string|null} dueBy
 * @property {number} [priority]
 * @property {Object} [meta]
 */

/**
 * @typedef {Object} SessionSuggestion
 * @property {string} [id]
 * @property {string} domain
 * @property {string} title
 * @property {string|null} [start]
 * @property {string|null} [end]
 * @property {Object} [needs] - { devices?:string[], people?:string[], capacity?:Array<{id,units}> }
 * @property {Object} [meta]
 */

// ───────────────────────────────────────────────────────────────────────────────

export default {
  synthesize,
  registerDomainRules,
  listDomains,
};

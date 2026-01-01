/**
 * @file C:\Users\larho\suka-smart-assistant\src\engines\synthesis\LeadTimeCalculator.js
 *
 * LeadTimeCalculator — computes readiness lead times using scraped tables
 * (when available) plus household/environment adjustments (altitude, temperature,
 * equipment performance, batch size, thickness, etc.).
 *
 * PIPELINE FIT
 * imports → normalize → intelligence(scraped tables) → **lead-time (this file)**
 * → synthesis → validator → automation runtime → (optional) hub export elsewhere
 *
 * WHAT THIS MODULE PRODUCES
 * - For each normalized import, a list of "requirements" with:
 *   { id, label, kind, baseMinutes, adjustedMinutes, window:{start,end}, rationale[], meta }
 * - It does not mutate household data. We emit automation telemetry only.
 *
 * EXTENSION POINTS
 * - registerAdjuster(id, fn) — add household-specific adjustment logic.
 * - registerEstimator(id, fn) — add new base estimators (e.g., dry-brine, par-bake, autolyse).
 * - External tables: if present, we read from "src/data/knowledge/LeadTimeTables.js"
 *   (e.g., thaw/min-per-kg, soak hours per legume, proof times per flour % hydration, etc.)
 *
 * EVENT ENVELOPE SHAPE: { type, ts, source, data }
 *   synthesis.leadtime.started | synthesis.leadtime.item | synthesis.leadtime.completed | synthesis.leadtime.error
 */

import eventBus from 'src/services/eventBus.js';

const SOURCE = 'LeadTimeCalculator';

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Compute lead-time requirements for the given imports.
 *
 * @param {Object} input
 * @param {Array<Object>} input.imports - normalized imports with fields:
 *   { id, domain, title, items?, methods?, equipment?, meta? }
 *   where meta.leadTimes (optional) may include per-step scraped baselines.
 * @param {Object} input.context
 *   { now: Date|string, tz?: string, prefs?: object, environment?: object, inventory?: object }
 *   prefs.house.altitudeMeters?, prefs.kitchen.ovenPreheatRateCPerMin?, prefs.temp.roomC?, prefs.batch.sizeMultiplier?
 * @param {Object} [options]
 *   { lookaheadHours?: number, useScrapedFirst?: boolean }
 *
 * @returns {Promise<{ ok: boolean, items: Array<RequirementBundle>, metrics: object }>}
 */
export async function calculate({ imports = [], context = {} } = {}, options = {}) {
  const tsStart = nowISO();

  if (!Array.isArray(imports)) {
    return fail('Invalid "imports" — expected array.');
  }

  const ctx = buildCtx(context);
  const opts = {
    lookaheadHours: toInt(options.lookaheadHours, 72),
    useScrapedFirst: options.useScrapedFirst !== false, // default true
  };

  emit('synthesis.leadtime.started', {
    count: imports.length,
    domains: unique(imports.map((i) => (i.domain || '').toLowerCase())),
  });

  const knowledge = await loadTables(); // optional, may be null
  const results = [];
  const rationales = [];

  for (const imp of imports) {
    try {
      const bundle = await computeForImport(imp, ctx, opts, knowledge);
      results.push(bundle);
      rationales.push(...bundle.requirements.flatMap((r) => r.rationale || []));
      emit('synthesis.leadtime.item', {
        importId: imp.id || null,
        title: imp.title || null,
        reqCount: bundle.requirements.length,
      });
    } catch (err) {
      emit('synthesis.leadtime.error', {
        importId: imp?.id || null,
        message: err?.message || 'compute error',
      });
    }
  }

  const allReq = results.flatMap((r) => r.requirements);
  const avgAdj =
    allReq.length === 0
      ? 0
      : Math.round(
          (100 *
            allReq.reduce((acc, r) => acc + (pctDelta(r.baseMinutes, r.adjustedMinutes) || 0), 0)) /
            allReq.length
        ) / 100;

  const payload = {
    ok: true,
    items: results,
    metrics: {
      totalRequirements: allReq.length,
      avgAdjustmentPct: avgAdj,
      tsStart,
      tsEnd: nowISO(),
    },
  };

  emit('synthesis.leadtime.completed', {
    total: allReq.length,
    avgAdjustmentPct: avgAdj,
  });

  return payload;
}

/**
 * Register a household/environment adjuster.
 * @param {string} id
 * @param {(args:{ requirement: Requirement, ctx: Ctx, item: any }) => Requirement|void|Promise<Requirement|void>} fn
 */
export function registerAdjuster(id, fn) {
  if (!id || typeof fn !== 'function') return;
  ADJUSTERS.set(id, fn);
  emit('synthesis.leadtime.adjuster.registered', { id });
}

/**
 * Register a base estimator for a requirement kind.
 * @param {string} id - kind key (e.g., 'thaw', 'soak', 'preheat', 'proof', 'sterilize')
 * @param {(args:{ item:any, ctx: Ctx, knowledge:any }) => (BaseEstimate|null|Promise<BaseEstimate|null>)} fn
 */
export function registerEstimator(id, fn) {
  if (!id || typeof fn !== 'function') return;
  ESTIMATORS.set(id, fn);
  emit('synthesis.leadtime.estimator.registered', { id });
}

// ───────────────────────────────────────────────────────────────────────────────
// Core computation

async function computeForImport(item, ctx, opts, knowledge) {
  const baseList = await estimateBaseRequirements(item, ctx, opts, knowledge);
  const adjusted = [];
  for (const base of baseList) {
    const req = await applyAdjusters(base, ctx, item);
    adjusted.push(finalizeRequirement(req, ctx, opts));
  }

  return {
    importId: item.id || null,
    domain: (item.domain || '').toLowerCase(),
    title: item.title || '',
    requirements: adjusted,
  };
}

async function estimateBaseRequirements(item, ctx, opts, knowledge) {
  const out = [];

  // 1) Use scraped lead times when provided
  if (opts.useScrapedFirst && item?.meta?.leadTimes && Array.isArray(item.meta.leadTimes)) {
    for (const lt of item.meta.leadTimes) {
      const base = normalizeBaseEstimate(lt, item);
      if (base) out.push(base);
    }
  }

  // 2) Derive from methods/equipment/items and knowledge/heuristics
  const methods = (item.methods || []).map((m) => String(m || '').toLowerCase());
  const equipment = (item.equipment || []).map((e) => String(e || '').toLowerCase());
  const names = (item.items || []).map((x) => String(x?.name || '').toLowerCase());

  // thaw
  if (names.some((n) => /(chicken|beef|pork|lamb|fish)/.test(n)) || methods.some((m) => /thaw|defrost/.test(m))) {
    const est = (await callEstimator('thaw', { item, ctx, knowledge })) || thawHeuristic(item, knowledge);
    if (est) out.push(est);
  }

  // soak (legumes, grains)
  if (names.some((n) => /(chickpea|garbanzo|bean|lentil|pea|barley)/.test(n)) || methods.some((m) => /soak/.test(m))) {
    const est = (await callEstimator('soak', { item, ctx, knowledge })) || soakHeuristic(item, knowledge);
    if (est) out.push(est);
  }

  // preheat (oven)
  if (methods.some((m) => /bake|roast|preheat/.test(m)) || equipment.includes('oven')) {
    const est = (await callEstimator('preheat', { item, ctx, knowledge })) || preheatHeuristic(item, knowledge);
    if (est) out.push(est);
  }

  // proof dough
  if (names.some((n) => /(dough|yeast|bread)/.test(n)) || methods.some((m) => /proof|rise/.test(m))) {
    const est = (await callEstimator('proof', { item, ctx, knowledge })) || proofHeuristic(item, knowledge);
    if (est) out.push(est);
  }

  // sterilize jars (preservation)
  if ((item.domain || '').toLowerCase() === 'preservation' || names.some((n) => /jar/.test(n))) {
    const est = (await callEstimator('sterilize', { item, ctx, knowledge })) || sterilizeHeuristic(item, knowledge);
    if (est) out.push(est);
  }

  // sanitizer contact (cleaning)
  if ((item.domain || '').toLowerCase() === 'cleaning' && (item.title || '').toLowerCase().includes('sanitize')) {
    const est = (await callEstimator('sanitizeContact', { item, ctx, knowledge })) || sanitizeContactHeuristic(item, knowledge);
    if (est) out.push(est);
  }

  return out;
}

// ───────────────────────────────────────────────────────────────────────────────
// Built-in base estimators (heuristics)

function thawHeuristic(item, knowledge) {
  // Prefer item.meta.massKg when present
  const massKg = numberOrNull(item?.meta?.massKg) || guessMassFromItems(item.items);
  // default: ~10h per 2.5kg in fridge; fish fillets ~8h per 2.5kg
  const isFish = hasAny(item.items, (x) => /fish/.test((x?.name || '').toLowerCase()));
  const minPerKg =
    getFromTable(knowledge, 'thaw.minPerKg.fridge') ??
    (isFish ? 320 : 400); // minutes per kg
  if (!massKg) return baseReq('thaw', 8 * 60, { mode: 'fridge', rationale: ['default mass'] }, item);
  return baseReq('thaw', Math.ceil(minPerKg * massKg), { mode: 'fridge', massKg }, item);
}

function soakHeuristic(item, knowledge) {
  // Default: dried beans ~8-12h; lentils ~2-4h (no-soak acceptable).
  const isLentil = hasAny(item.items, (x) => /lentil/.test((x?.name || '').toLowerCase()));
  const base =
    getFromTable(knowledge, `soak.${isLentil ? 'lentilHours' : 'beansHours'}`) ??
    (isLentil ? 3 * 60 : 9 * 60);
  return baseReq('soak', base, { legume: isLentil ? 'lentil' : 'beans' }, item);
}

function preheatHeuristic(item, knowledge) {
  // If a target temp is present in meta, use it; else 205°C default baking temp.
  const targetC = numberOrNull(item?.meta?.ovenTargetC) ?? 205;
  // Preheat rate: user pref or table; fallback 8°C/min.
  const rate = getFromTable(knowledge, 'preheat.cPerMin') ?? 8;
  // Start from room temp ~22°C unless table provides baseline
  const startC = numberOrNull(knowledge?.ambient?.kitchenC) ?? 22;
  const minutes = Math.ceil(Math.max(0, targetC - startC) / rate);
  return baseReq('preheat', minutes, { targetC, rateCPerMin: rate }, item);
}

function proofHeuristic(item, knowledge) {
  // Proof dependent on room temp and hydration; default 60–90 min at 24°C.
  const base = getFromTable(knowledge, 'proof.baseMin') ?? 75;
  return baseReq('proof', base, { hydrationPct: numberOrNull(item?.meta?.hydrationPct) || null }, item);
}

function sterilizeHeuristic(item, knowledge) {
  // Boiling-water canning sterilization: base 10 min at sea level + altitude adjustment.
  const base = getFromTable(knowledge, 'sterilize.baseMin') ?? 10;
  return baseReq('sterilize', base, { method: 'boil' }, item);
}

function sanitizeContactHeuristic(item, knowledge) {
  // Typical sanitizer contact time: 10 minutes
  const base = getFromTable(knowledge, 'sanitize.contactMin') ?? 10;
  return baseReq('sanitizeContact', base, { product: item?.meta?.sanitizer || 'generic' }, item);
}

// ───────────────────────────────────────────────────────────────────────────────
// Adjusters

const ADJUSTERS = new Map();
const ESTIMATORS = new Map();

// Built-in adjusters

// Altitude affects boil-based times (sterilize, some bean soaking softening assumptions)
registerAdjuster('altitude.boil', ({ requirement, ctx }) => {
  if (!['sterilize'].includes(requirement.kind)) return;
  const meters = numberOrNull(ctx.prefs?.house?.altitudeMeters);
  if (!meters || meters <= 0) return;

  // Rule of thumb: +1 minute per 300m for boil sterilization (simple, conservative)
  const add = Math.ceil(meters / 300);
  requirement.adjustedMinutes += add;
  requirement.rationale.push(`+${add} min for altitude ${meters}m`);
});

// Room temperature affects proof times
registerAdjuster('roomTemp.proof', ({ requirement, ctx }) => {
  if (requirement.kind !== 'proof') return;
  const roomC = numberOrNull(ctx.prefs?.temp?.roomC) ?? numberOrNull(ctx.environment?.roomC);
  if (!roomC) return;
  // Approx: each 5°C below 24°C increases time by ~50%; above reduces
  const delta = roomC - 24;
  const factor = delta < 0 ? 1 + Math.abs(delta) * 0.1 : 1 / (1 + delta * 0.08);
  const adj = Math.max(10, Math.round(requirement.adjustedMinutes * factor));
  requirement.rationale.push(`room ${roomC}°C factor ${round2(factor)}`);
  requirement.adjustedMinutes = adj;
});

// Oven performance affects preheat
registerAdjuster('oven.rate', ({ requirement, ctx }) => {
  if (requirement.kind !== 'preheat') return;
  const userRate = numberOrNull(ctx.prefs?.kitchen?.ovenPreheatRateCPerMin);
  if (!userRate) return;
  const targetC = requirement.meta.targetC ?? 205;
  const startC = numberOrNull(ctx.environment?.kitchenC) ?? 22;
  requirement.adjustedMinutes = Math.ceil(Math.max(0, targetC - startC) / userRate);
  requirement.rationale.push(`oven rate ${userRate}°C/min`);
});

// Batch size affects soak/thaw (more mass → longer)
registerAdjuster('batch.mass', ({ requirement, item, ctx }) => {
  if (!['soak', 'thaw'].includes(requirement.kind)) return;
  const factor = numberOrNull(ctx.prefs?.batch?.sizeMultiplier);
  if (!factor || factor <= 1) return;
  const add = Math.ceil(requirement.adjustedMinutes * (factor - 1) * 0.5); // half-scale
  requirement.adjustedMinutes += add;
  requirement.rationale.push(`batch x${factor} → +${add} min`);
});

// Safety floor for sanitizer contact — never below label
registerAdjuster('sanitize.min', ({ requirement, ctx }) => {
  if (requirement.kind !== 'sanitizeContact') return;
  const labelMin = toInt(ctx.prefs?.cleaning?.sanitizerContactMin, 10);
  if (requirement.adjustedMinutes < labelMin) {
    requirement.rationale.push(`floor to label ${labelMin} min`);
    requirement.adjustedMinutes = labelMin;
  }
});

// ───────────────────────────────────────────────────────────────────────────────
// Helpers

function buildCtx(context = {}) {
  const now = context.now ? new Date(context.now) : new Date();
  return {
    now,
    tz: context.tz || 'UTC',
    prefs: context.prefs || {},
    environment: context.environment || {},
    inventory: context.inventory || {},
  };
}

async function loadTables() {
  try {
    const mod = await import(/* @vite-ignore */ 'src/data/knowledge/LeadTimeTables.js');
    return mod?.default || mod;
  } catch {
    return null;
  }
}

async function callEstimator(kind, args) {
  const fn = ESTIMATORS.get(kind);
  if (!fn) return null;
  try {
    return normalizeBaseEstimate(await fn(args), args.item);
  } catch {
    return null;
  }
}

async function applyAdjusters(base, ctx, item) {
  const req = { ...base, adjustedMinutes: base.baseMinutes, rationale: base.rationale ? base.rationale.slice() : [] };
  for (const [, fn] of ADJUSTERS.entries()) {
    try {
      const out = await fn({ requirement: req, ctx, item });
      if (out && typeof out === 'object') {
        // adjuster may return a new requirement object; merge conservatively
        req.adjustedMinutes = toInt(out.adjustedMinutes, req.adjustedMinutes);
        req.meta = { ...(req.meta || {}), ...(out.meta || {}) };
        if (Array.isArray(out.rationale)) req.rationale.push(...out.rationale);
      }
    } catch {
      // ignore faulty adjuster
    }
  }
  return req;
}

function finalizeRequirement(req, ctx, opts) {
  // Establish window ending at the desired start (if provided) or "now + lookahead"
  const horizon = new Date(ctx.now.getTime() + opts.lookaheadHours * 60 * 60 * 1000);
  const end = toISO(req.meta?.desiredStart || horizon);
  const start = toISO(new Date(new Date(end).getTime() - req.adjustedMinutes * 60 * 1000));
  return { ...req, window: { start, end } };
}

function baseReq(kind, minutes, meta, item) {
  return {
    id: `${kind}:${(item?.id || item?.title || 'item').toString()}`,
    label: humanize(kind),
    kind,
    baseMinutes: toInt(minutes, 0),
    adjustedMinutes: toInt(minutes, 0),
    rationale: [],
    meta: { ...(meta || {}) },
  };
}

function normalizeBaseEstimate(x, item) {
  if (!x) return null;
  if (typeof x === 'number') return baseReq('custom', x, { source: 'scraped' }, item);
  if (typeof x === 'object' && Number.isFinite(x.minutes)) {
    return {
      id: x.id || `scraped:${item?.id || item?.title || ''}:${x.kind || 'custom'}`,
      label: x.label || humanize(x.kind || 'custom'),
      kind: x.kind || 'custom',
      baseMinutes: toInt(x.minutes, 0),
      adjustedMinutes: toInt(x.minutes, 0),
      rationale: x.rationale ? x.rationale.slice() : ['scraped'],
      meta: { ...(x.meta || {}), source: x.meta?.source || 'scraped' },
    };
  }
  return null;
}

function getFromTable(knowledge, path) {
  if (!knowledge) return null;
  const parts = String(path).split('.');
  let cur = knowledge;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur === undefined) return null;
  }
  return cur;
}

// ───────────────────────────────────────────────────────────────────────────────
// Utilities (shared)

function toISO(d) {
  const dd = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dd.getTime()) ? null : dd.toISOString();
}
function nowISO() {
  return new Date().toISOString();
}
function toInt(n, fallback) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? x : fallback;
}
function numberOrNull(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}
function pctDelta(a, b) {
  if (!a) return 0;
  return ((b - a) / a) * 100;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}
function hasAny(list, pred) {
  return Array.isArray(list) && list.some(pred);
}
function unique(arr) {
  return Array.from(new Set(arr));
}
function humanize(id) {
  return String(id || '')
    .replace(/[-_.]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
function guessMassFromItems(items = []) {
  // Look for item.qtyKg or qty + unit
  for (const it of items) {
    if (numberOrNull(it?.qtyKg)) return numberOrNull(it.qtyKg);
    const q = numberOrNull(it?.qty);
    const unit = String(it?.unit || '').toLowerCase();
    if (q && /kg|kilogram/.test(unit)) return q;
    if (q && /g|gram/.test(unit)) return q / 1000;
    if (q && /lb|pound/.test(unit)) return q * 0.453592;
  }
  return null;
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

// ───────────────────────────────────────────────────────────────────────────────
// Types
/**
 * @typedef {object} Requirement
 * @property {string} id
 * @property {string} label
 * @property {string} kind
 * @property {number} baseMinutes
 * @property {number} adjustedMinutes
 * @property {{start:string|null,end:string|null}} [window]
 * @property {string[]} [rationale]
 * @property {object} [meta]
 */
/**
 * @typedef {object} RequirementBundle
 * @property {string|null} importId
 * @property {string} domain
 * @property {string} title
 * @property {Requirement[]} requirements
 */
/**
 * @typedef {object} Ctx
 * @property {Date} now
 * @property {string} tz
 * @property {object} prefs
 * @property {object} environment
 * @property {object} inventory
 */

// ───────────────────────────────────────────────────────────────────────────────

export default {
  calculate,
  registerAdjuster,
  registerEstimator,
};

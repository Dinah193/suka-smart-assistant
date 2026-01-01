// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\admission\options.js
/**
 * SSA Scheduling Admission — Options Generator
 * --------------------------------------------
 * Purpose:
 *   Given a proposed session that *failed* feasibility or is tight, suggest alternate
 *   time slots or simplified variants (shorter, split, resource-substituted, policy-aware).
 *
 * How it fits the SSA pipeline:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports produce normalized sessions with duration & constraints
 *   - intelligence refines durations, prep, dependencies, preferences
 *   - feasibility check determines if it fits as-is
 *   - THIS MODULE proposes alternate options before committing schedule changes
 *   - downstream schedulers may pick an option, persist it, emit events, and optionally export to Hub
 *
 * EventBus:
 *   Emits `{ type, ts, source, data }` payloads with ISO timestamps:
 *     - scheduling.options.generated
 *     - scheduling.options.none
 *
 * Forward-thinking:
 *   - Strategy registry to add domain-specific or global suggestion strategies
 *   - Pluggable providers for calendar & resource locks (Dexie, ICS, Google Calendar, etc.)
 *   - Policy-aware (quiet hours, sabbath guard), with hooks for astronomy-based windows
 *
 * NOTE:
 *   This module does NOT mutate household state. If a selected option is applied elsewhere
 *   (persisted session), that action should emit inventory/meal/garden events and optionally
 *   export to Hub. A helper `exportToHubIfEnabled()` is included for future use but unused here.
 */

let eventBus = {
  emit: (...a) => console.debug("[scheduling:options:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* noop for tests */ }

let featureFlags = { familyFundMode: false, quietHours: { enabled: false, start: 22, end: 6 }, sabbathGuard: false };
try {
  const ff = require("@/config/featureFlags");
  featureFlags = ff?.default || ff || featureFlags;
} catch { /* noop */ }

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch { /* optional */ }

/* ---------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {("cooking"|"cleaning"|"garden"|"animal"|"preservation"|"storehouse")} domain
 * @property {string} title
 * @property {string} deadlineISO
 * @property {number} taskMinutes
 * @property {number} [prepMinutes]
 * @property {number} [setupMinutes]
 * @property {number} [cleanupMinutes]
 * @property {number} [bufferMinutes]
 * @property {number} [earliestStartOffsetMin]
 * @property {Array<string>} [requiredResources]
 * @property {Array<{id:string, done:boolean}>} [dependencies]
 * @property {Object} [preferences]
 */

/**
 * @typedef {Object} OptionsConfig
 * @property {(startISO:string,endISO:string)=>Promise<Array<{startISO:string,endISO:string,label?:string}>>} fetchCalendarBlocks
 * @property {(resources:string[],startISO:string,endISO:string)=>Promise<Array<{startISO:string,endISO:string,resource:string}>>} fetchResourceLocks
 * @property {(d:Date)=>Promise<{sunsetISO?:string,sundownISO?:string}>} [fetchAstronomy]
 * @property {{enabled:boolean,start:number,end:number}} [quietHours]
 * @property {{enabled:boolean, dayStart:number, dayEnd:number}} [sabbath]
 * @property {number} [granularityMin]  // default 5
 * @property {number} [maxAlternates]   // default 6
 * @property {number} [searchHorizonMin]// minutes to search *after* deadline for late options, default 240
 * @property {Record<string,string[]>} [resourceSubstitutions] // { "range.top": ["induction.hob","outdoor.burner"] }
 * @property {Date} [now]
 * @property {Array<Function>} [extraStrategies] // (session,ctx)=>Promise<Suggestion[]>
 */

/**
 * @typedef {Object} Suggestion
 * @property {string} kind     // "slot", "shorten", "split", "resource-substitution", "policy-override", "deadline-extension"
 * @property {string} label
 * @property {number} score    // higher is better (0..100)
 * @property {{startISO:string,endISO:string}} [schedule]
 * @property {Object} [deltas] // { minutesSaved, resourcesReplaced, policyOverride:{quietHours?:boolean,sabbath?:boolean}, deadlineDeltaMin?:number }
 * @property {Array<string>} [risks] // human-readable caveats
 */

/* --------------------------------- Exports --------------------------------- */
module.exports = {
  /**
   * Generate alternate scheduling options or simplified variants.
   * @param {Session} session
   * @param {OptionsConfig} options
   * @returns {Promise<{ suggestions: Suggestion[], meta: { searched: number, deadlineISO: string } }>}
   */
  async suggestOptions(session, options = {}) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.admission.options";

    const out = await _suggest(session, options);

    eventBus.emit({
      type: out.suggestions.length ? "scheduling.options.generated" : "scheduling.options.none",
      ts,
      source,
      data: {
        sessionId: session?.id,
        domain: session?.domain,
        count: out.suggestions.length,
        top: out.suggestions[0] || null,
        meta: out.meta,
      },
    });

    return out;
  },
};

/* ------------------------------- Core Engine ------------------------------- */

async function _suggest(session, options) {
  // Defensive checks
  const errs = [];
  if (!session || typeof session !== "object") errs.push("missing-session");
  if (!session?.deadlineISO || Number.isNaN(Date.parse(session.deadlineISO))) errs.push("invalid-deadline");
  if (!Number.isFinite(session?.taskMinutes) || session.taskMinutes <= 0) errs.push("invalid-taskMinutes");
  if (errs.length) return { suggestions: [], meta: { errors: errs, searched: 0, deadlineISO: session?.deadlineISO || null } };

  const ctx = await buildContext(session, options);

  // Strategy registry (order matters: cheaper/tighter-fit first)
  const strategies = [
    suggestEarlierSlots,
    suggestLaterSlotsPostDeadline,         // late but near-term
    suggestShortenVariant,                 // trims buffer/setup/cleanup safely
    suggestSplitVariant,                   // split across two free windows
    suggestResourceSubstitution,           // swap resource to find availability
    suggestPolicyAwareWindow,              // near quiet/sabbath edges if allowed
    suggestDeadlineExtension,              // as a last resort
    ...(Array.isArray(options.extraStrategies) ? options.extraStrategies : []),
  ];

  /** @type {Suggestion[]} */
  let suggestions = [];
  for (const strat of strategies) {
    try {
      const got = await strat(session, ctx);
      if (Array.isArray(got) && got.length) suggestions.push(...got);
      if (suggestions.length >= ctx.maxAlternates) break;
    } catch { /* ignore bad strategy */ }
  }

  // De-dup & normalize scores 0..100
  suggestions = dedupeSuggestions(suggestions)
    .slice(0, ctx.maxAlternates)
    .sort((a, b) => b.score - a.score);

  return {
    suggestions,
    meta: { searched: ctx.stats.searchedWindows, deadlineISO: ctx.deadline.toISOString() },
  };
}

/* ------------------------------ Suggestors --------------------------------- */

/** Find multiple free slots before the deadline */
async function suggestEarlierSlots(_session, ctx) {
  const duration = ctx.totalMinutes;
  const windows = await enumerateFreeWindows(ctx.earliestStart, ctx.deadline, ctx, ctx.granularityMin, duration, ctx.maxAlternates);
  ctx.stats.searchedWindows += windows.length;
  return windows.map((w, i) => ({
    kind: "slot",
    label: i === 0 ? "First available slot before deadline" : "Alternate slot before deadline",
    score: 90 - i * 5,
    schedule: { startISO: w.start.toISOString(), endISO: w.end.toISOString() },
    deltas: {},
    risks: [],
  }));
}

/** Offer near-term windows *after* the deadline (if acceptable) */
async function suggestLaterSlotsPostDeadline(_session, ctx) {
  const horizonEnd = addMinutes(ctx.deadline, ctx.searchHorizonMin);
  const windows = await enumerateFreeWindows(ctx.deadline, horizonEnd, ctx, ctx.granularityMin, ctx.totalMinutes, Math.ceil(ctx.maxAlternates / 2));
  ctx.stats.searchedWindows += windows.length;
  return windows.map((w, i) => ({
    kind: "slot",
    label: "Soonest slot after deadline",
    score: 65 - i * 5,
    schedule: { startISO: w.start.toISOString(), endISO: w.end.toISOString() },
    deltas: {},
    risks: ["misses-deadline"],
  }));
}

/** Trim non-core minutes to fit: buffer → cleanup → setup → prep (in that order) */
async function suggestShortenVariant(session, ctx) {
  const { prep, setup, cleanup, buffer, task } = ctx.parts;
  const order = [
    ["bufferMinutes", buffer],
    ["cleanupMinutes", cleanup],
    ["setupMinutes", setup],
    ["prepMinutes", prep],
  ];

  let trimmed = 0;
  /** @type {Suggestion[]} */
  const out = [];

  for (const [key, current] of order) {
    if (current <= 0) continue;

    // Try a 25% trim for this segment (at least 5 minutes if possible)
    const cut = Math.max(0, Math.min(current, Math.max(5, Math.round(current * 0.25))));
    const variant = { ...session, [key]: Math.max(0, current - cut) };

    const fits = await checkVariantFits(variant, ctx);
    if (fits) {
      trimmed += cut;
      out.push({
        kind: "shorten",
        label: `Trim ${key} by ${cut} min`,
        score: 75 - out.length * 3,
        schedule: fits,
        deltas: { minutesSaved: trimmed },
        risks: key === "prepMinutes" ? ["reduced-prep-may-affect-quality"] : [],
      });
      if (out.length >= 3) break; // don't spam
    }
  }

  // Ultimate compression attempt: trim *all* non-task minutes by up to 30% total
  if (out.length === 0 && (prep + setup + cleanup + buffer) > 0) {
    const compressBy = Math.floor((prep + setup + cleanup + buffer) * 0.3);
    if (compressBy > 0) {
      const variant = compressNonTask(session, compressBy);
      const fits = await checkVariantFits(variant, ctx);
      if (fits) {
        out.push({
          kind: "shorten",
          label: `Compress non-task minutes by ${compressBy}`,
          score: 70,
          schedule: fits,
          deltas: { minutesSaved: compressBy },
          risks: ["compression-may-impact-quality"],
        });
      }
    }
  }

  return out;
}

/** Split across two windows (e.g., prep/setup earlier, task+cleanup later) */
async function suggestSplitVariant(session, ctx) {
  const { prep, setup, cleanup, buffer, task } = ctx.parts;
  const earlyChunk = prep + setup;
  const lateChunk = task + cleanup + buffer;
  if (earlyChunk === 0 || lateChunk === 0) return [];

  // Find an early window for prep+setup
  const earlyWins = await enumerateFreeWindows(ctx.earliestStart, addMinutes(ctx.deadline, -lateChunk), ctx, ctx.granularityMin, earlyChunk, 1);
  ctx.stats.searchedWindows += earlyWins.length;
  if (!earlyWins.length) return [];

  const earlyEnd = earlyWins[0].end;
  // Then find a window for lateChunk between earlyEnd and deadline
  const lateWins = await enumerateFreeWindows(earlyEnd, ctx.deadline, ctx, ctx.granularityMin, lateChunk, 1);
  ctx.stats.searchedWindows += lateWins.length;
  if (!lateWins.length) return [];

  return [{
    kind: "split",
    label: "Split: prep/setup earlier, main work later",
    score: 68,
    schedule: { startISO: earlyWins[0].start.toISOString(), endISO: lateWins[0].end.toISOString() },
    deltas: { split: [{ startISO: earlyWins[0].start.toISOString(), endISO: earlyWins[0].end.toISOString() },
                      { startISO: lateWins[0].start.toISOString(),  endISO: lateWins[0].end.toISOString() }] },
    risks: ["requires-two-returns", "may-increase-context-switching"],
  }];
}

/** Swap a required resource with an allowed substitute to unlock windows */
async function suggestResourceSubstitution(session, ctx) {
  const subs = ctx.resourceSubstitutions;
  const req = Array.isArray(session.requiredResources) ? session.requiredResources : [];
  if (!req.length || !subs || !Object.keys(subs).length) return [];

  const out = [];
  for (const r of req) {
    const alts = subs[r];
    if (!Array.isArray(alts) || !alts.length) continue;

    for (const alt of alts) {
      const variant = {
        ...session,
        requiredResources: req.map(x => (x === r ? alt : x)),
      };
      const fits = await checkVariantFits(variant, ctx);
      if (fits) {
        out.push({
          kind: "resource-substitution",
          label: `Use "${alt}" instead of "${r}"`,
          score: 67 - out.length * 2,
          schedule: fits,
          deltas: { resourcesReplaced: { [r]: alt } },
          risks: ["different-equipment-behavior"],
        });
      }
      if (out.length >= 3) break;
    }
    if (out.length >= 3) break;
  }
  return out;
}

/** Offer windows near quiet/sabbath edges without violating policies */
async function suggestPolicyAwareWindow(_session, ctx) {
  const out = [];
  // Try just after quiet hours end each day up to deadline
  if (ctx.quietHours.enabled) {
    const candidates = buildPolicyEdgeStarts(ctx.earliestStart, ctx.deadline, ctx.quietHours.end);
    for (const cand of candidates) {
      const end = addMinutes(cand, ctx.totalMinutes);
      const free = await isWindowFree(cand, end, ctx);
      if (free) {
        out.push({
          kind: "slot",
          label: "Start right after quiet hours",
          score: 62 - out.length * 3,
          schedule: { startISO: cand.toISOString(), endISO: end.toISOString() },
          deltas: {},
          risks: [],
        });
      }
      if (out.length >= 2) break;
    }
  }
  return out;
}

/** Last resort: ask for a small deadline extension */
async function suggestDeadlineExtension(_session, ctx) {
  // Find earliest slot after deadline within horizon and compute minimal extension
  const horizonEnd = addMinutes(ctx.deadline, ctx.searchHorizonMin);
  const windows = await enumerateFreeWindows(ctx.deadline, horizonEnd, ctx, ctx.granularityMin, ctx.totalMinutes, 1);
  ctx.stats.searchedWindows += windows.length;
  if (!windows.length) return [];

  const w = windows[0];
  const extension = Math.ceil((w.end - ctx.deadline) / 60000);
  return [{
    kind: "deadline-extension",
    label: `Request deadline extension of ${extension} minutes`,
    score: 55,
    schedule: { startISO: w.start.toISOString(), endISO: w.end.toISOString() },
    deltas: { deadlineDeltaMin: extension },
    risks: ["requires-approval"],
  }];
}

/* --------------------------------- Context --------------------------------- */

async function buildContext(session, options) {
  const now = options.now instanceof Date ? options.now : new Date();
  const earliestStart = addMinutes(now, clampNonNegInt(session.earliestStartOffsetMin ?? 0));
  const deadline = new Date(session.deadlineISO);

  const prep = clampNonNegInt(session.prepMinutes ?? 0);
  const setup = clampNonNegInt(session.setupMinutes ?? 0);
  const cleanup = clampNonNegInt(session.cleanupMinutes ?? 0);
  const buffer = clampNonNegInt(session.bufferMinutes ?? 0);
  const task = clampNonNegInt(session.taskMinutes);
  const totalMinutes = prep + setup + task + cleanup + buffer;

  return {
    now,
    earliestStart,
    deadline,
    totalMinutes,
    parts: { prep, setup, cleanup, buffer, task },
    fetchCalendarBlocks: options.fetchCalendarBlocks,
    fetchResourceLocks: options.fetchResourceLocks,
    fetchAstronomy: options.fetchAstronomy,
    quietHours: normalizeQuietHours(options.quietHours ?? featureFlags.quietHours),
    sabbath: normalizeSabbath(options.sabbath, featureFlags.sabbathGuard),
    granularityMin: Math.max(1, Math.min(60, Math.floor(options.granularityMin ?? 5))),
    maxAlternates: Math.max(1, Math.min(12, Math.floor(options.maxAlternates ?? 6))),
    searchHorizonMin: Math.max(30, Math.min(24 * 60, Math.floor(options.searchHorizonMin ?? 240))),
    resourceSubstitutions: options.resourceSubstitutions || {},
    stats: { searchedWindows: 0 },
  };
}

/* ----------------------------- Window Finding ------------------------------ */

async function enumerateFreeWindows(rangeStart, rangeEnd, ctx, stepMin, durationMin, limit) {
  const blocked = await gatherBlocked(rangeStart, rangeEnd, ctx);
  const merged = mergeIntervals(blocked);
  return findKFitSlots(rangeStart, rangeEnd, merged, durationMin, stepMin, limit);
}

async function gatherBlocked(start, end, ctx) {
  const [calendarBlocks, resourceLocks, policyBlocks] = await Promise.all([
    resolveCalendarBlocks(start, end, ctx.fetchCalendarBlocks),
    resolveResourceLocks(Array.isArray(ctx.requiredResources) ? ctx.requiredResources : null, start, end, ctx.fetchResourceLocks),
    resolvePolicyBlocks(start, end, ctx),
  ]);
  return [...calendarBlocks, ...resourceLocks, ...policyBlocks].map(toInterval);
}

async function resolveCalendarBlocks(start, end, fetcher) {
  if (typeof fetcher !== "function") return [];
  const res = await safeCall(async () => await fetcher(start.toISOString(), end.toISOString()), []);
  return Array.isArray(res) ? res : [];
}
async function resolveResourceLocks(resources, start, end, fetcher) {
  if (!resources || !resources.length) return [];
  if (typeof fetcher !== "function") return [];
  const res = await safeCall(async () => await fetcher(resources, start.toISOString(), end.toISOString()), []);
  return Array.isArray(res) ? res : [];
}
async function resolvePolicyBlocks(start, end, ctx) {
  const blocks = [];
  if (ctx.quietHours.enabled) blocks.push(...buildQuietHourBlocks(start, end, ctx.quietHours.start, ctx.quietHours.end));
  if (ctx.sabbath.enabled) blocks.push(...await buildSabbathBlocks(start, end, ctx.fetchAstronomy));
  return blocks;
}

/* ------------------------------ Fit Utilities ------------------------------ */

function findKFitSlots(start, deadline, blocked, durationMin, granularityMin, k) {
  const res = [];
  const durationMs = durationMin * 60 * 1000;
  const stepMs = granularityMin * 60 * 1000;

  let cursor = new Date(start);
  const lastStart = new Date(deadline.getTime() - durationMs);
  let i = 0;

  while (cursor <= lastStart && res.length < k) {
    let jumped = false;
    for (; i < blocked.length; i++) {
      const b = blocked[i];
      if (cursor >= b.end) continue;
      if (cursor < b.start) break;
      cursor = new Date(b.end);
      jumped = true;
      break;
    }
    if (jumped) continue;

    const candidateEnd = new Date(cursor.getTime() + durationMs);
    if (!intersectsAny(cursor, candidateEnd, blocked) && candidateEnd <= deadline) {
      res.push({ start: new Date(cursor), end: candidateEnd });
      // advance by duration to find next distinct window
      cursor = new Date(candidateEnd.getTime() + stepMs);
      continue;
    }

    const nextBlock = nextBlockingAfter(cursor, blocked);
    if (nextBlock && nextBlock.start - cursor < stepMs) {
      cursor = new Date(nextBlock.end);
    } else {
      cursor = new Date(cursor.getTime() + stepMs);
    }
  }
  return res;
}

async function isWindowFree(start, end, ctx) {
  const blocked = await gatherBlocked(start, end, ctx);
  const merged = mergeIntervals(blocked);
  return !intersectsAny(start, end, merged);
}

async function checkVariantFits(variantSession, ctx) {
  // Recompute totals for variant
  const total =
    clampNonNegInt(variantSession.prepMinutes ?? 0) +
    clampNonNegInt(variantSession.setupMinutes ?? 0) +
    clampNonNegInt(variantSession.taskMinutes ?? 0) +
    clampNonNegInt(variantSession.cleanupMinutes ?? 0) +
    clampNonNegInt(variantSession.bufferMinutes ?? 0);

  if (total <= 0) return null;

  const windows = await enumerateFreeWindows(ctx.earliestStart, ctx.deadline, ctx, ctx.granularityMin, total, 1);
  if (!windows.length) return null;
  return { startISO: windows[0].start.toISOString(), endISO: windows[0].end.toISOString() };
}

/* ------------------------------ Policy Helpers ----------------------------- */

function buildPolicyEdgeStarts(rangeStart, rangeEnd, endHour) {
  const starts = [];
  let dayCursor = startOfDay(rangeStart);
  const last = startOfDay(rangeEnd);
  while (dayCursor <= last) {
    const edge = setHour(dayCursor, endHour);
    if (edge >= rangeStart && edge <= rangeEnd) starts.push(edge);
    dayCursor = addDays(dayCursor, 1);
  }
  return starts;
}

function normalizeQuietHours(qh) {
  const fallback = { enabled: false, start: 22, end: 6 };
  if (!qh || typeof qh !== "object") return fallback;
  const start = toHour(qh.start, 22);
  const end = toHour(qh.end, 6);
  return { enabled: !!qh.enabled, start, end };
}

function normalizeSabbath(opt, flagEnabled) {
  if (!flagEnabled && !opt?.enabled) return { enabled: false, dayStart: 18, dayEnd: 18 };
  const enabled = opt?.enabled ?? true;
  const dayStart = toHour(opt?.dayStart, 18);
  const dayEnd = toHour(opt?.dayEnd, 18);
  return { enabled, dayStart, dayEnd };
}

async function buildSabbathBlocks(start, end, fetchAstronomy) {
  const blocks = [];
  let dayCursor = startOfDay(start);
  const lastDay = startOfDay(end);
  while (dayCursor <= lastDay) {
    const dow = dayCursor.getDay(); // 0..6
    if (dow === 5) {
      const fri = new Date(dayCursor);
      const sat = addDays(fri, 1);
      let startISO, endISO;
      if (typeof fetchAstronomy === "function") {
        const friAstro = await safeCall(async () => await fetchAstronomy(fri), {});
        const satAstro = await safeCall(async () => await fetchAstronomy(sat), {});
        startISO = friAstro?.sunsetISO || friAstro?.sundownISO || setHour(fri, 18).toISOString();
        endISO = satAstro?.sundownISO || satAstro?.sunsetISO || setHour(sat, 18).toISOString();
      } else {
        startISO = setHour(fri, 18).toISOString();
        endISO = setHour(sat, 18).toISOString();
      }
      blocks.push({ start: new Date(startISO), end: new Date(endISO) });
    }
    dayCursor = addDays(dayCursor, 1);
  }
  return trimBlocksToRange(blocks, start, end);
}

/* --------------------------------- Utils ---------------------------------- */

function compressNonTask(session, totalCut) {
  const keys = ["bufferMinutes", "cleanupMinutes", "setupMinutes", "prepMinutes"];
  const out = { ...session };
  let remaining = totalCut;

  for (const k of keys) {
    const cur = clampNonNegInt(out[k] ?? 0);
    if (cur <= 0) continue;
    const cut = Math.min(cur, Math.ceil(remaining / 2)); // greedily remove half of remaining
    out[k] = cur - cut;
    remaining -= cut;
    if (remaining <= 0) break;
  }
  return out;
}

function dedupeSuggestions(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    const key = JSON.stringify([s.kind, s.schedule?.startISO, s.schedule?.endISO, s.label, s.deltas]);
    if (seen.has(key)) continue;
    seen.add(key);
    // clamp score
    s.score = Math.max(0, Math.min(100, Math.round(Number(s.score) || 0)));
    out.push(s);
  }
  return out;
}

function clampNonNegInt(n) {
  const v = Math.floor(Number(n) || 0);
  return v < 0 ? 0 : v;
}
async function safeCall(fn, fallback) { try { return await fn(); } catch { return fallback; } }

function addMinutes(date, min) { return new Date(date.getTime() + min * 60 * 1000); }
function startOfDay(d) { const x = new Date(d); x.setHours(0,0,0,0); return x; }
function setHour(d, hour) { const x = new Date(d); x.setHours(hour,0,0,0); return x; }
function addDays(d, n) { return new Date(d.getTime() + n * 24 * 60 * 60 * 1000); }
function trimBlocksToRange(blocks, start, end) {
  return blocks
    .map(b => ({ start: b.start < start ? new Date(start) : b.start,
                 end: b.end > end ? new Date(end) : b.end }))
    .filter(b => b.end > b.start);
}
function toHour(val, def) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n < 24 ? Math.floor(n) : def;
}
function toInterval(x) {
  const startISO = x.startISO || x.start || x.from;
  const endISO = x.endISO || x.end || x.to;
  const start = new Date(startISO);
  const end = new Date(endISO);
  return { start, end };
}
function mergeIntervals(intervals) {
  const arr = intervals
    .filter(iv => iv?.start instanceof Date && iv?.end instanceof Date && iv.end > iv.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const iv of arr) {
    if (!merged.length || iv.start > merged[merged.length - 1].end) {
      merged.push({ start: new Date(iv.start), end: new Date(iv.end) });
    } else {
      if (iv.end > merged[merged.length - 1].end) merged[merged.length - 1].end = new Date(iv.end);
    }
  }
  return merged;
}
function intersectsAny(start, end, intervals) {
  for (const iv of intervals) {
    if (iv.end <= start) continue;
    if (iv.start >= end) break;
    if (iv.start < end && iv.end > start) return true;
  }
  return false;
}
function nextBlockingAfter(t, intervals) {
  for (const iv of intervals) {
    if (iv.end <= t) continue;
    if (iv.start >= t) return iv;
    if (iv.start <= t && iv.end > t) return iv;
  }
  return null;
}

/* --------------------------- Optional Hub Export --------------------------- */
/**
 * Not used here (read-only generator), but included to align with SSA contracts
 * for modules that *do* mutate household state during scheduling.
 */
async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  try {
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch {
    // fail silently by contract
  }
}

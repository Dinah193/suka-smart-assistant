// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\policies\priorities.js
/**
 * SSA Scheduling Policies — Priority Rules (hard/soft, EDF, WIP limits)
 * ---------------------------------------------------------------------
 * Purpose:
 *   Provide a central, extensible priority engine for ranking candidate sessions.
 *   Implements:
 *     - Hard constraints (blockers, WIP limits, must-run flags)
 *     - Soft priorities (policy weights, domain boosts, user/household prefs)
 *     - Deadline awareness (EDF = Earliest Deadline First)
 *     - Aging/urgency (score grows as time elapses)
 *     - SLA classes (critical/high/normal/low)
 *     - Tie-breakers (createdAt, estimated effort, domain sequence)
 *
 * How it fits the SSA pipeline:
 *   imports → intelligence → automation → (optional) hub export
 *   - imports + intelligence produce normalized sessions
 *   - THIS MODULE computes priority scores for automation runtime to schedule/allocate
 *   - When policy overrides change, we emit events and optionally mirror to Hub
 *
 * Events (payloads use the { type, ts, source, data } contract):
 *   - scheduling.priority.evaluated   (single session scored)
 *   - scheduling.priorities.ranked    (batch ranked list)
 *   - scheduling.priority.policy.updated / .removed / .error
 *
 * Forward-thinking:
 *   - Strategy registry for domain-specific tweaks
 *   - Persistent + runtime overrides
 *   - Per-domain WIP caps and queue-classes
 *   - Supports Family Fund Hub mirroring of policy changes when enabled
 */

let eventBus = {
  emit: (...a) => console.debug("[policies:priorities:eventBus.emit]", ...a),
  on: () => () => {},
};
try {
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* noop */ }

let featureFlags = {
  familyFundMode: false,
  priorityPolicy: {
    baseWeights: {
      // primary score components
      deadline: 0.45,       // EDF pressure
      importance: 0.30,     // user/household "importance" 0..1
      effortFit: 0.10,      // shorter jobs get small boost to reduce fragmentation
      domainBoost: 0.05,    // domain-specific nudge
      aging: 0.10,          // +score as time passes since createdAt
    },
    agingHalfLifeHours: 12,  // score contribution halves every 12h
    slaBoosts: { critical: 0.3, high: 0.15, normal: 0.0, low: -0.05 },
    edfHorizonHours: 168,    // how far to look for EDF normalization (1 week)
    wip: {                   // default WIP caps per domain
      cooking: 3,
      cleaning: 3,
      garden: 4,
      animal: 2,
      preservation: 2,
      storehouse: 2,
    },
    domainBoosts: {          // small nudges; can be changed via overrides
      preservation: 0.05,
      animal: 0.04,
      garden: 0.03,
      cooking: 0.02,
      cleaning: 0.01,
      storehouse: 0.00,
    },
    tieBreakers: ["earliestCreated", "shorterDuration", "domainAlpha"], // applied in order
  },
};
try {
  const ff = require("@/config/featureFlags");
  featureFlags = ff?.default || ff || featureFlags;
} catch { /* noop */ }

let dataGateway;
try { dataGateway = require("@/services/dataGateway"); } catch {}

let HubPacketFormatter, FamilyFundConnector;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch { /* optional */ }

/* ---------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} SessionCandidate
 * @property {string} id
 * @property {("cooking"|"cleaning"|"garden"|"animal"|"preservation"|"storehouse")} domain
 * @property {string} title
 * @property {string} [createdAtISO]
 * @property {string} [deadlineISO]                // optional for non-deadline items
 * @property {number} taskMinutes
 * @property {number} [prepMinutes]
 * @property {number} [setupMinutes]
 * @property {number} [cleanupMinutes]
 * @property {number} [bufferMinutes]
 * @property {("critical"|"high"|"normal"|"low")} [slaClass]
 * @property {number} [importance]                 // 0..1 household/user-set weight
 * @property {boolean} [mustRun]                   // hard priority — bypass WIP if needed
 * @property {boolean} [blocked]                   // hard blocker — score becomes -Infinity
 * @property {Object} [meta]                       // free-form (source import id, etc.)
 */

/**
 * @typedef {Object} RankOptions
 * @property {Object<string,number>} [wipInFlightByDomain] // current running counts by domain
 * @property {Object} [runtimeOverrides]                   // ephemeral overrides for weights/boosts
 * @property {Date}   [now]                                // testing hook
 */

/* --------------------------------- Public API ------------------------------ */
module.exports = {
  /**
   * Score a single session candidate.
   * @param {SessionCandidate} session
   * @param {RankOptions} [options]
   * @returns {Promise<{ score:number, hardBlocked:boolean, reasons:string[], breakdown:Object }>}
   */
  async evaluate(session, options = {}) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.priorities";

    const out = await _scoreOne(session, options);

    eventBus.emit({
      type: "scheduling.priority.evaluated",
      ts,
      source,
      data: {
        sessionId: session?.id || null,
        domain: session?.domain || null,
        score: out.score,
        hardBlocked: out.hardBlocked,
        reasons: out.reasons.slice(0, 6),
        breakdown: out.breakdown,
      },
    });

    return out;
  },

  /**
   * Rank a list of session candidates using score + tie-breakers + WIP caps.
   * @param {SessionCandidate[]} sessions
   * @param {RankOptions} [options]
   * @returns {Promise<Array<{id:string, score:number, hardBlocked:boolean, reasons:string[], rank:number}>>}
   */
  async rank(sessions, options = {}) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.priorities";

    const list = Array.isArray(sessions) ? sessions : [];
    const scored = await Promise.all(list.map(s => _scoreOne(s, options)));

    // Enforce WIP caps per domain (except mustRun)
    const cfg = resolvePolicy(options.runtimeOverrides);
    const used = { ...(options.wipInFlightByDomain || {}) };
    const ranked = list
      .map((s, i) => ({ s, idx: i, scorePack: scored[i] }))
      .sort((a, b) => {
        // higher score first
        const ds = b.scorePack.score - a.scorePack.score;
        if (Math.abs(ds) !== 0) return ds;

        // tie-breakers
        return tieBreak(a.s, b.s, cfg.tieBreakers);
      })
      .map((entry, i) => ({ ...entry, rank: i + 1 }));

    const admitted = [];
    for (const item of ranked) {
      const dom = item.s.domain || "unknown";
      const cap = toPosInt(cfg.wip[dom] ?? 0);
      const current = toPosInt(used[dom] ?? 0);

      const bypass = !!item.s.mustRun;
      const blocked = item.scorePack.hardBlocked;

      if (!blocked && (bypass || cap === 0 || current < cap)) {
        admitted.push({
          id: item.s.id,
          score: item.scorePack.score,
          hardBlocked: false,
          reasons: item.scorePack.reasons,
          rank: admitted.length + 1,
        });
        used[dom] = current + 1;
      } else {
        // still return with hardBlocked flag; it will appear after admitted in the final array
        admitted.push({
          id: item.s.id,
          score: item.scorePack.score,
          hardBlocked: true,
          reasons: [...item.scorePack.reasons, blocked ? "blocked" : "wip-cap-reached"],
          rank: admitted.length + 1,
        });
      }
    }

    eventBus.emit({
      type: "scheduling.priorities.ranked",
      ts,
      source,
      data: {
        total: list.length,
        top: admitted.slice(0, 5),
      },
    });

    return admitted;
  },

  /**
   * Create or update a persistent priority override (weights/boosts/WIP caps per domain).
   * Any field omitted remains unchanged.
   * @param {{ id?:string, scope?:("global"|"domain"), domain?:string, weights?:object, wip?:object, domainBoosts?:object, slaBoosts?:object, reason?:string, enabled?:boolean }} override
   * @returns {Promise<{ id:string }>}
   */
  async setPriorityOverride(override) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.priorities";
    try {
      guardDataGateway();
      const row = normalizeOverride(override);
      const id = row.id || makeId(row);
      const toSave = { ...row, id, updatedAt: ts };

      await upsertMany("policies.priorities", [toSave], ["id"]);

      eventBus.emit({
        type: "scheduling.priority.policy.updated",
        ts,
        source,
        data: { id, scope: toSave.scope, domain: toSave.domain || null, enabled: toSave.enabled !== false, reason: toSave.reason || null },
      });

      await exportToHubIfEnabled({
        type: "policy.priority.updated",
        ts,
        source,
        data: { id, scope: toSave.scope, domain: toSave.domain || null },
      });

      return { id };
    } catch (err) {
      eventBus.emit({ type: "scheduling.priority.policy.error", ts, source, data: { op: "set", reason: err?.message || "unknown" } });
      throw err;
    }
  },

  /**
   * Remove a priority override by id.
   * @param {string} id
   * @returns {Promise<boolean>}
   */
  async removePriorityOverride(id) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.policies.priorities";
    try {
      guardDataGateway();
      const ok = await delById("policies.priorities", id);
      if (ok) {
        eventBus.emit({ type: "scheduling.priority.policy.removed", ts, source, data: { id } });
        await exportToHubIfEnabled({ type: "policy.priority.removed", ts, source, data: { id } });
      }
      return !!ok;
    } catch (err) {
      eventBus.emit({ type: "scheduling.priority.policy.error", ts, source, data: { op: "remove", reason: err?.message || "unknown" } });
      return false;
    }
  },

  /**
   * List all priority overrides (enabled first).
   */
  async listPriorityOverrides() {
    guardDataGateway();
    const rows = await readAll("policies.priorities");
    return (rows || []).sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false));
  },
};

/* ------------------------------- Core Scoring ------------------------------- */

async function _scoreOne(session, options) {
  const reasons = [];
  const now = options.now instanceof Date ? options.now : new Date();

  if (!isValidSession(session)) {
    return { score: -Infinity, hardBlocked: true, reasons: ["invalid-session"], breakdown: {} };
  }

  const cfg = resolvePolicy(options.runtimeOverrides);
  const totalMin = sum([
    session.prepMinutes, session.setupMinutes, session.taskMinutes,
    session.cleanupMinutes, session.bufferMinutes,
  ].map(toNonNegInt));

  // Hard blockers
  if (session.blocked) {
    reasons.push("hard-block:blocked");
    return { score: -Infinity, hardBlocked: true, reasons, breakdown: {} };
  }

  // Base components (0..1)
  const edf = normalizeEDF(session.deadlineISO, now, cfg.edfHorizonHours);            // nearer deadline → closer to 1
  const imp = clamp01(Number(session.importance ?? 0.5));                               // user/household assigned
  const eff = normalizeEffort(totalMin);                                               // shorter tasks boosted
  const dom = clamp01(cfg.domainBoosts[session.domain] ?? 0);                          // domain small nudge
  const age = normalizeAge(session.createdAtISO, now, cfg.agingHalfLifeHours);         // older grows

  const baseW = cfg.baseWeights;
  let score =
    baseW.deadline  * edf +
    baseW.importance* imp +
    baseW.effortFit * eff +
    baseW.domainBoost * dom +
    baseW.aging * age;

  // SLA class boosts
  const sla = String(session.slaClass || "normal").toLowerCase();
  score += (cfg.slaBoosts[sla] ?? 0);

  // Domain-specific strategy tweaks (extensible)
  score = await applyDomainStrategies(score, session, { now, cfg, reasons });

  // Must-run forces top tier unless blocked
  if (session.mustRun) {
    score = Math.max(score, 1.25); // put above any normal bound
    reasons.push("must-run");
  }

  // Clamp score to a sane band for sorting
  const finalScore = round3(clamp(score, -2, 2));
  return {
    score: finalScore,
    hardBlocked: false,
    reasons,
    breakdown: { edf, imp, eff, dom, age, sla: cfg.slaBoosts[sla] ?? 0 },
  };
}

/* ------------------------------- Strategies -------------------------------- */

/**
 * Registry of async domain strategies. Each may nudge score and append reasons.
 * Signature: (score:number, session, ctx) => Promise<number>|number
 */
function getDomainStrategies() {
  return {
    preservation: [
      (score, s, { reasons }) => {
        // Canning safety: higher priority if ambient temp is in unsafe zone (from meta)
        const hotDay = s?.meta?.ambientTemp >= 85;
        if (hotDay) { reasons.push("hot-day"); return score + 0.05; }
        return score;
      },
    ],
    garden: [
      (score, s, { now, reasons }) => {
        // Boost if near planting window (deadline within 48h)
        if (s.deadlineISO && (Date.parse(s.deadlineISO) - +now) <= 48 * 3600 * 1000) {
          reasons.push("planting-window");
          return score + 0.06;
        }
        return score;
      },
    ],
    animal: [
      (score) => score, // placeholder for herd-health or milking cycles
    ],
    cooking: [
      (score, s) => {
        // Small de-boost for very long cooks to avoid monopolizing
        const total = sum([
          s.prepMinutes, s.setupMinutes, s.taskMinutes, s.cleanupMinutes, s.bufferMinutes,
        ].map(toNonNegInt));
        if (total >= 240) return score - 0.03;
        return score;
      },
    ],
    cleaning: [],
    storehouse: [],
  };
}

async function applyDomainStrategies(score, session, ctx) {
  const reg = getDomainStrategies();
  const fns = reg[session.domain] || [];
  let s = score;
  for (const fn of fns) {
    try { s = await Promise.resolve(fn(s, session, ctx)); } catch { /* ignore */ }
  }
  return s;
}

/* --------------------------------- Policy ---------------------------------- */

function resolvePolicy(runtimeOverrides) {
  const base = { ...(featureFlags?.priorityPolicy || {}) };
  const rt = runtimeOverrides && typeof runtimeOverrides === "object" ? runtimeOverrides : {};
  // shallow merge; callers can override any leaf
  return deepMerge(base, rt);
}

/* ------------------------------ WIP Overrides ------------------------------ */

function normalizeOverride(ovr) {
  if (!ovr || typeof ovr !== "object") throw new Error("invalid-override");
  const scope = (ovr.scope || "global").toLowerCase();
  if (!["global", "domain"].includes(scope)) throw new Error("invalid-scope");
  const out = {
    id: String(ovr.id || "").trim(),
    scope,
    domain: scope === "domain" ? String(ovr.domain || "").trim() : null,
    weights: isObj(ovr.weights) ? pruneToNumbers(ovr.weights) : undefined,
    wip: isObj(ovr.wip) ? pruneToNumbers(ovr.wip) : undefined,
    domainBoosts: isObj(ovr.domainBoosts) ? pruneToNumbers(ovr.domainBoosts) : undefined,
    slaBoosts: isObj(ovr.slaBoosts) ? pruneToNumbers(ovr.slaBoosts) : undefined,
    reason: typeof ovr.reason === "string" ? ovr.reason.slice(0, 240) : null,
    enabled: ovr.enabled !== false,
  };
  return out;
}

function makeId(row) {
  return row.scope === "domain" ? `prio::domain::${row.domain}` : "prio::global";
}

/* --------------------------------- Storage --------------------------------- */

function guardDataGateway() {
  if (!dataGateway) throw new Error("dataGateway unavailable");
}

async function upsertMany(table, rows, keyFields) {
  guardDataGateway();
  if (typeof dataGateway.upsertMany === "function") return dataGateway.upsertMany(table, rows, keyFields);
  if (typeof dataGateway.writeMany === "function") return dataGateway.writeMany({ table, rows, keyFields, mode: "upsert" });
  if (typeof dataGateway.putMany === "function") { await dataGateway.putMany(table, rows); return rows.length; }
  if (typeof dataGateway.put === "function") { for (const r of rows) await dataGateway.put(table, r); return rows.length; }
  throw new Error("No upsert-capable method on dataGateway");
}

async function delById(table, id) {
  if (typeof dataGateway.delete === "function") return await dataGateway.delete(table, id);
  if (typeof dataGateway.remove === "function") return await dataGateway.remove(table, { id });
  if (typeof dataGateway.writeMany === "function") { await dataGateway.writeMany({ table, rows: [{ id }], mode: "delete" }); return true; }
  return false;
}

async function readAll(table) {
  if (typeof dataGateway.all === "function") return await dataGateway.all(table);
  if (typeof dataGateway.scan === "function") return await dataGateway.scan(table, {});
  return [];
}

/* -------------------------------- Utilities -------------------------------- */

function isValidSession(s) {
  return s && typeof s === "object" &&
    typeof s.id === "string" &&
    typeof s.domain === "string" &&
    Number.isFinite(toNonNegInt(s.taskMinutes));
}

function normalizeEDF(deadlineISO, now, horizonHrs) {
  if (!deadlineISO || Number.isNaN(Date.parse(deadlineISO))) return 0; // no deadline → 0 pressure
  const msLeft = Date.parse(deadlineISO) - +now;
  if (msLeft <= 0) return 1; // overdue → max pressure
  const horizonMs = Math.max(1, horizonHrs) * 3600 * 1000;
  return clamp01(1 - Math.min(1, msLeft / horizonMs));
}

function normalizeEffort(totalMin) {
  // smaller jobs get more boost; logistic mapping  (≤15min ~0.9, 60min ~0.5, 240min ~0.1)
  const x = Math.max(1, Number(totalMin) || 0);
  const k = 0.03;
  const mid = 60;
  return clamp01(1 / (1 + Math.exp(k * (x - mid))));
}

function normalizeAge(createdISO, now, halfLifeHrs) {
  if (!createdISO || Number.isNaN(Date.parse(createdISO))) return 0.25; // unknown age: small base
  const hours = Math.max(0, (+now - Date.parse(createdISO)) / 3600e3);
  // decay formula turned into "growth" via 1 - 0.5^(t/halfLife)
  const half = Math.max(0.1, Number(halfLifeHrs) || 12);
  return clamp01(1 - Math.pow(0.5, hours / half));
}

function tieBreak(a, b, order) {
  for (const key of order || []) {
    if (key === "earliestCreated") {
      const ta = safeTime(a.createdAtISO), tb = safeTime(b.createdAtISO);
      if (ta !== tb) return ta - tb;
    } else if (key === "shorterDuration") {
      const da = estimatedTotal(a), db = estimatedTotal(b);
      if (da !== db) return da - db;
    } else if (key === "domainAlpha") {
      const da = String(a.domain || ""), db = String(b.domain || "");
      if (da !== db) return da < db ? -1 : 1;
    }
  }
  // final tie: id
  return String(a.id).localeCompare(String(b.id));
}

function estimatedTotal(s) {
  return sum([
    s.prepMinutes, s.setupMinutes, s.taskMinutes,
    s.cleanupMinutes, s.bufferMinutes,
  ].map(toNonNegInt));
}

function safeTime(iso) {
  const t = Date.parse(iso || "");
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t;
}

function deepMerge(a, b) {
  if (!isObj(a)) return b;
  if (!isObj(b)) return a;
  const out = { ...a };
  for (const k of Object.keys(b)) {
    out[k] = (isObj(a[k]) && isObj(b[k])) ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}

function isObj(x) { return x && typeof x === "object" && !Array.isArray(x); }
function pruneToNumbers(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function toNonNegInt(n) { const v = Math.floor(Number(n) || 0); return v < 0 ? 0 : v; }
function toPosInt(n) { const v = Math.floor(Number(n) || 0); return v > 0 ? v : 0; }
function sum(arr) { return arr.reduce((a, b) => a + (Number(b) || 0), 0); }
function clamp01(x) { return Math.max(0, Math.min(1, Number(x) || 0)); }
function clamp(x, lo, hi) { const n = Number(x); return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : lo)); }
function round3(n) { return Math.round(n * 1000) / 1000; }

/* --------------------------- Optional Hub Export --------------------------- */
/**
 * Policy changes are mirrored to Hub when familyFundMode is enabled.
 * This module itself does not mutate inventory/storehouse; it only changes policy.
 */
async function exportToHubIfEnabled(payload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format(payload);
    await FamilyFundConnector.send(packet);
  } catch { /* silent by contract */ }
}

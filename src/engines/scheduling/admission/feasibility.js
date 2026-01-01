// C:\Users\larho\suka-smart-assistant\src\engines\scheduling\admission\feasibility.js
/**
 * SSA Scheduling Feasibility Engine
 * ---------------------------------
 * Purpose:
 *  Checks if a proposed session can meet its deadline under current household constraints
 *  (calendar blocks, resource locks, quiet hours, sabbath guard, buffers, dependencies).
 *
 * How it fits the SSA pipeline:
 *  imports → intelligence → automation → (optional) hub export
 *   - imports produce normalized intents/sessions with estimated durations & constraints
 *   - intelligence refines durations, prep, dependencies, and preferences
 *   - this module (automation/scheduling) tests feasibility before committing a schedule
 *   - if later modules persist a schedule, they will emit inventory/meal/garden events and
 *     export to Hub when familyFundMode is enabled. This checker itself is read-only.
 *
 * EventBus:
 *  Emits `{ type, ts, source, data }` payloads with ISO timestamps:
 *   - scheduling.feasibility.checked
 *   - scheduling.feasibility.unfeasible
 *
 * Forward-thinking:
 *  - Constraint registry allows adding new rules (e.g., preservation/animal/storehouse specifics)
 *  - Providers (calendar/resource) are injected via options for different backends (Dexie, ICS, gCal)
 *  - Sabbath/quiet hours strategies are pluggable
 */

let eventBus = {
  emit: (...a) => console.debug("[scheduling:feasibility:eventBus.emit]", ...a),
  on: () => () => {},
};

try {
  // Prefer default export, but support named as well
  const eb = require("@/services/eventBus");
  eventBus = eb?.default || eb?.eventBus || eventBus;
} catch { /* noop for tests or build steps */ }

// Feature flags are optional in this checker; we use them for guard toggles only.
let featureFlags = { sabbathGuard: false, quietHours: { enabled: false, start: 22, end: 6 } };
try {
  const ff = require("@/config/featureFlags");
  featureFlags = ff?.default || ff || featureFlags;
} catch { /* noop */ }

/* ---------------------------------- Types ---------------------------------- */
/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {("cooking"|"cleaning"|"garden"|"animal"|"preservation"|"storehouse")} domain
 * @property {string} title
 * @property {string} deadlineISO                 // hard deadline (ISO)
 * @property {number} taskMinutes                 // main work minutes (required)
 * @property {number} prepMinutes                 // optional, defaults 0
 * @property {number} setupMinutes                // optional, defaults 0
 * @property {number} cleanupMinutes              // optional, defaults 0
 * @property {number} bufferMinutes               // optional guard band, defaults 0
 * @property {number} earliestStartOffsetMin      // optional, minutes from now
 * @property {Array<string>} requiredResources    // e.g., ["range.top", "sink", "butcher.table"]
 * @property {Array<{id:string, done:boolean}>}   dependencies
 * @property {Object} preferences                 // { household: {...}, user: {...} }
 */

/**
 * @typedef {Object} FeasibilityOptions
 * @property {(startISO:string,endISO:string)=>Promise<Array<{startISO:string,endISO:string, label?:string}>>} fetchCalendarBlocks
 *   Returns busy intervals on the household calendar.
 * @property {(resources:string[],startISO:string,endISO:string)=>Promise<Array<{startISO:string,endISO:string, resource:string}>>} fetchResourceLocks
 *   Returns intervals when required resources are locked.
 * @property {(d:Date)=>Promise<{sunsetISO?:string,sundownISO?:string}>} [fetchAstronomy]
 *   Optional, for more accurate sabbath boundaries (if enabled).
 * @property {{enabled:boolean,start:number,end:number}} [quietHours] // 0-24 local hours
 * @property {{enabled:boolean, dayStart:number, dayEnd:number}} [sabbath] // defaults Fri evening → Sat evening
 * @property {number} [granularityMin] // slot search step minutes, default 5
 * @property {Date} [now] // testability hook
 */

/* --------------------------------- Exports --------------------------------- */
module.exports = {
  /**
   * Check if a session can be scheduled before its deadline.
   * @param {Session} session
   * @param {FeasibilityOptions} options
   * @returns {Promise<{feasible:boolean, reason?:string, schedule?:{startISO:string,endISO:string}, slots?:Array<{startISO:string,endISO:string}>, requiredAdjustments?:string[]}>}
   */
  async checkFeasibility(session, options = {}) {
    const ts = new Date().toISOString();
    const source = "engines.scheduling.admission.feasibility";
    try {
      const result = await _check(session, options);

      eventBus.emit({
        type: result.feasible ? "scheduling.feasibility.checked" : "scheduling.feasibility.unfeasible",
        ts,
        source,
        data: {
          sessionId: session?.id,
          domain: session?.domain,
          title: session?.title,
          proposed: result.schedule || null,
          reason: result.reason || null,
          requiredAdjustments: result.requiredAdjustments || [],
        },
      });

      return result;
    } catch (err) {
      const reason = `error: ${err?.message || "unknown"}`;
      eventBus.emit({
        type: "scheduling.feasibility.unfeasible",
        ts,
        source,
        data: {
          sessionId: session?.id,
          domain: session?.domain,
          title: session?.title,
          proposed: null,
          reason,
          requiredAdjustments: ["fix-inputs", "retry"],
        },
      });
      return { feasible: false, reason };
    }
  },
};

/* ------------------------------- Core Engine ------------------------------- */

async function _check(session, options) {
  const now = options.now instanceof Date ? options.now : new Date();
  // Defensive input validation
  const errs = [];
  if (!session || typeof session !== "object") errs.push("missing-session");
  if (!session?.deadlineISO || Number.isNaN(Date.parse(session.deadlineISO))) errs.push("invalid-deadline");
  if (!Number.isFinite(session?.taskMinutes) || session.taskMinutes <= 0) errs.push("invalid-taskMinutes");
  if (errs.length) return { feasible: false, reason: `bad-input: ${errs.join(",")}` };

  // Normalize minutes
  const prep = clampNonNegInt(session.prepMinutes ?? 0);
  const setup = clampNonNegInt(session.setupMinutes ?? 0);
  const cleanup = clampNonNegInt(session.cleanupMinutes ?? 0);
  const buffer = clampNonNegInt(session.bufferMinutes ?? 0);
  const task = clampNonNegInt(session.taskMinutes);

  const totalMinutes = prep + setup + task + cleanup + buffer;
  if (totalMinutes <= 0) return { feasible: false, reason: "zero-duration" };

  const earliestStart = addMinutes(now, clampNonNegInt(session.earliestStartOffsetMin ?? 0));
  const deadline = new Date(session.deadlineISO);
  if (deadline <= earliestStart) {
    return { feasible: false, reason: "deadline-before-earliest-start" };
  }

  // Gather blocked intervals
  const [calendarBlocks, resourceLocks, policyBlocks] = await Promise.all([
    resolveCalendarBlocks(earliestStart, deadline, options),
    resolveResourceLocks(session.requiredResources || [], earliestStart, deadline, options),
    resolvePolicyBlocks(earliestStart, deadline, session, options),
  ]);

  // Domain-specific constraints (extensible)
  const domainAdjustments = [];
  const domainConstraints = getDomainConstraintsRegistry()[session.domain] || [];
  for (const fn of domainConstraints) {
    const adj = await fn(session, { earliestStart, deadline });
    if (Array.isArray(adj) && adj.length) domainAdjustments.push(...adj);
  }

  const blocked = mergeIntervals([...calendarBlocks, ...resourceLocks, ...policyBlocks].map(toInterval));

  // Slot search
  const granularity = Math.max(1, Math.min(60, Math.floor(options.granularityMin ?? 5)));
  const firstFit = findFirstFitSlot(earliestStart, deadline, blocked, totalMinutes, granularity);

  if (!firstFit) {
    const reasons = ["no-slot-before-deadline"];
    if (blocked.length) reasons.push("busy-calendar-or-resources");
    if (policyBlocks.length) reasons.push("policy-quiet/sabbath");
    return {
      feasible: false,
      reason: reasons.join("|"),
      requiredAdjustments: [
        ...domainAdjustments,
        "extend-deadline",
        "shorten-duration",
        "relax-quiet-hours",
        "override-sabbath-guard",
        "free-required-resources",
      ],
    };
  }

  // Build contiguous sub-slots (single block schedule suggestion)
  const startISO = firstFit.start.toISOString();
  const endISO = firstFit.end.toISOString();

  return {
    feasible: true,
    schedule: { startISO, endISO },
    slots: [{ startISO, endISO }],
    requiredAdjustments: domainAdjustments,
  };
}

/* ------------------------------ Data Providers ----------------------------- */

async function resolveCalendarBlocks(start, end, options) {
  const fetcher = options.fetchCalendarBlocks;
  if (typeof fetcher !== "function") return [];
  const blocks = await safeCall(async () => await fetcher(start.toISOString(), end.toISOString()), []);
  return Array.isArray(blocks) ? blocks : [];
}

async function resolveResourceLocks(resources, start, end, options) {
  if (!resources?.length) return [];
  const fetcher = options.fetchResourceLocks;
  if (typeof fetcher !== "function") return [];
  const locks = await safeCall(async () => await fetcher(resources, start.toISOString(), end.toISOString()), []);
  return Array.isArray(locks) ? locks : [];
}

async function resolvePolicyBlocks(start, end, session, options) {
  const blocks = [];

  // Quiet hours
  const qh = normalizeQuietHours(options.quietHours ?? featureFlags.quietHours);
  if (qh.enabled) {
    blocks.push(...buildQuietHourBlocks(start, end, qh.start, qh.end));
  }

  // Sabbath guard
  const sabbath = normalizeSabbath(options.sabbath, featureFlags.sabbathGuard);
  if (sabbath.enabled) {
    blocks.push(...await buildSabbathBlocks(start, end, options.fetchAstronomy));
  }

  return blocks;
}

/* ----------------------------- Constraint System --------------------------- */

/**
 * Registry of domain-specific feasibility adjustments.
 * Each function may return an array of suggested adjustments if constraints pinch scheduling.
 * Extension point: push new rules for "preservation", "animal", "storehouse", etc.
 */
function getDomainConstraintsRegistry() {
  return {
    cooking: [
      // Example: enforce doneness/rest windows or preheat overlap
      async (session) => {
        const adj = [];
        const needsHighHeat = _hasPreference(session, "cooking.requiresHighHeat");
        if (needsHighHeat && Array.isArray(session.requiredResources) && !session.requiredResources.includes("range.top")) {
          adj.push("add-resource:range.top (high-heat)");
        }
        return adj;
      },
    ],
    cleaning: [
      async () => [],
    ],
    garden: [
      // Example: daylight preference
      async (session) => {
        if (_hasPreference(session, "garden.daylightOnly")) {
          return ["prefer-daylight-hours"];
        }
        return [];
      },
    ],
    animal: [
      // Example: humane time windows (early AM/late PM in summer)
      async (session) => {
        if (_hasPreference(session, "animal.coolerHoursPreferred")) {
          return ["prefer-cooler-hours"];
        }
        return [];
      },
    ],
    preservation: [
      async () => [],
    ],
    storehouse: [
      async () => [],
    ],
  };
}

/* --------------------------------- Helpers --------------------------------- */

function clampNonNegInt(n) {
  const v = Math.floor(Number(n) || 0);
  return v < 0 ? 0 : v;
}

async function safeCall(fn, fallback) {
  try { return await fn(); } catch { return fallback; }
}

function addMinutes(date, min) {
  return new Date(date.getTime() + min * 60 * 1000);
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
      // overlap
      if (iv.end > merged[merged.length - 1].end) merged[merged.length - 1].end = new Date(iv.end);
    }
  }
  return merged;
}

/**
 * Find the first continuous free slot of length `durationMin` between start and deadline,
 * skipping all blocked intervals. Uses a discrete step (granularityMin).
 */
function findFirstFitSlot(start, deadline, blocked, durationMin, granularityMin) {
  const durationMs = durationMin * 60 * 1000;
  const stepMs = granularityMin * 60 * 1000;

  // Build cursor advancing around blocks
  let cursor = new Date(start);
  const lastStart = new Date(deadline.getTime() - durationMs);

  let i = 0;
  while (cursor <= lastStart) {
    // Skip if cursor falls inside a block: jump to block end
    let jumped = false;
    for (; i < blocked.length; i++) {
      const b = blocked[i];
      if (cursor >= b.end) continue;
      if (cursor < b.start) {
        // no jump; this block is ahead
        break;
      }
      // cursor in block: jump to end of block
      cursor = new Date(b.end);
      jumped = true;
      break;
    }
    if (jumped) continue;

    // Check if [cursor, cursor+duration] intersects any block
    const candidateEnd = new Date(cursor.getTime() + durationMs);
    const intersects = intersectsAny(cursor, candidateEnd, blocked);
    if (!intersects && candidateEnd <= deadline) {
      return { start: cursor, end: candidateEnd };
    }

    // Advance by step (or to next relevant block start to accelerate)
    const nextBlock = nextBlockingAfter(cursor, blocked);
    if (nextBlock && nextBlock.start - cursor < stepMs) {
      cursor = new Date(nextBlock.end);
    } else {
      cursor = new Date(cursor.getTime() + stepMs);
    }
  }

  return null;
}

function intersectsAny(start, end, intervals) {
  for (const iv of intervals) {
    if (iv.end <= start) continue;
    if (iv.start >= end) break; // intervals sorted
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

function normalizeQuietHours(qh) {
  const fallback = { enabled: false, start: 22, end: 6 };
  if (!qh || typeof qh !== "object") return fallback;
  const start = toHour(qh.start, 22);
  const end = toHour(qh.end, 6);
  return { enabled: !!qh.enabled, start, end };
}

function toHour(val, def) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 && n < 24 ? Math.floor(n) : def;
}

/**
 * Build quiet hour daily blocks between start and end (inclusive of days).
 */
function buildQuietHourBlocks(start, end, startHr, endHr) {
  const blocks = [];
  // Iterate day by day
  let dayCursor = startOfDay(start);
  const lastDay = startOfDay(end);
  while (dayCursor <= lastDay) {
    if (startHr < endHr) {
      // Same-day quiet block
      const qStart = setHour(dayCursor, startHr);
      const qEnd = setHour(dayCursor, endHr);
      blocks.push({ start: qStart, end: qEnd });
    } else {
      // Overnight quiet hours split into two
      const qStart = setHour(dayCursor, startHr);
      const qEnd = setHour(addDays(dayCursor, 1), endHr);
      blocks.push({ start: qStart, end: qEnd });
    }
    dayCursor = addDays(dayCursor, 1);
  }
  return trimBlocksToRange(blocks, start, end);
}

function normalizeSabbath(opt, flagEnabled) {
  if (!flagEnabled && !opt?.enabled) return { enabled: false, dayStart: 18, dayEnd: 18 };
  const enabled = opt?.enabled ?? true;
  const dayStart = toHour(opt?.dayStart, 18); // approx "evening"
  const dayEnd = toHour(opt?.dayEnd, 18);     // approx "evening"
  return { enabled, dayStart, dayEnd };
}

/**
 * Approximate Sabbath from Friday "evening" to Saturday "evening".
 * If astronomy provider is present, it may adjust boundaries by sunset.
 */
async function buildSabbathBlocks(start, end, fetchAstronomy) {
  // Find the Friday and Saturday in range
  const blocks = [];
  let dayCursor = startOfDay(start);
  const lastDay = startOfDay(end);
  while (dayCursor <= lastDay) {
    const dow = dayCursor.getDay(); // 0 Sun .. 6 Sat
    if (dow === 5) {
      // Friday evening → Saturday evening
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

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function setHour(d, hour) {
  const x = new Date(d);
  x.setHours(hour, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 24 * 60 * 60 * 1000);
}
function trimBlocksToRange(blocks, start, end) {
  return blocks
    .map(b => ({
      start: b.start < start ? new Date(start) : b.start,
      end: b.end > end ? new Date(end) : b.end,
    }))
    .filter(b => b.end > b.start);
}

function _hasPreference(session, key) {
  const segs = String(key).split(".");
  let obj = session?.preferences || {};
  for (const k of segs) {
    if (!obj || typeof obj !== "object") return false;
    obj = obj[k];
  }
  return !!obj;
}

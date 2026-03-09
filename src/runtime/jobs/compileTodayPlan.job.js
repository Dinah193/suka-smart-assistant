// C:\Users\larho\suka-smart-assistant\src\runtime\jobs\compileTodayPlan.job.js
// SSA Runtime - Job: Compile Today's Plan (runs at ~06:00 local)
// -----------------------------------------------------------------------------
// Role in pipeline:
//   imports → intelligence → automation → (optional) hub export
//   - This job compiles the actionable plan for the day from the scheduling
//     engine: pulls admitted sessions, fills reasonable gaps with suggestions,
//     applies priorities/buffers/constraints, and emits a single rollup event.
//   - Because it produces/updates generated sessions & a daily rollup, it also
//     invokes exportToHubIfEnabled() so households in Family Fund mode can mirror
//     the plan to the Hub.
//
// Behavior:
//   - Timebox: [today 06:00 local, today 23:59:59 local] by default
//   - Includes sessions already admitted into calendar and near-term candidates
//   - Scores with priorities policy when available (EDF + overrides)
//   - Respects constraints policy (quiet hours, etc.) when available
//   - Emits: planning.today.compiled
//
// Defensive design:
//   - All external deps are optional; gracefully degrade if missing.
//   - Input validation; early returns with clear events.
//   - Consistent event payload: { type, ts, source, data } with ISO timestamps.
//

const path = require("path");

// ---------- Dependencies (defensive requires) ----------
let eventBus = { emit: function () {} };
try {
  const eb = require("@/services/events/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_) {}

let featureFlags = { familyFundMode: false };
try {
  const ff = require("@/config/featureFlags");
  featureFlags = (ff && (ff.default || ff)) || featureFlags;
} catch (_) {}

let SessionStore = null; // assumed API shown below
try {
  SessionStore = require("@/engines/scheduling/SessionStore");
} catch (_) {
  try {
    SessionStore = require("@/engines/scheduling/sessionStore");
  } catch (_) {}
}

let prioritiesPolicy = null; // assumed: scoreSessions(sessions, ctx)
try {
  prioritiesPolicy = require("@/engines/scheduling/policies/priorities");
} catch (_) {}

let constraintsPolicy = null; // assumed: filterSlots/sessions by constraints
try {
  constraintsPolicy = require("@/engines/scheduling/policies/constraints");
} catch (_) {}

let optionsEngine = null; // suggested alternates (gap fillers)
try {
  optionsEngine = require("@/engines/scheduling/admission/options");
} catch (_) {}

let HubPacketFormatter = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
} catch (_) {}
let FamilyFundConnector = null;
try {
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
} catch (_) {}

// ---------- Public API ----------
module.exports = {
  /**
   * Compiles today's plan and emits a rollup event. Intended to run at 06:00.
   * @param {Object} args
   * @param {string} [args.timezone="America/Chicago"]
   * @param {string} [args.windowStartLocal="06:00"] - local time HH:mm to begin the plan
   * @param {string} [args.windowEndLocal="23:59"] - local time HH:mm to end the plan
   * @param {number} [args.maxGapFills=3] - number of suggested sessions to insert for gaps
   */
  async run(args) {
    const cfg = normalizeArgs(args);
    if (!cfg) {
      emit("planning.today.compile.skipped", { reason: "invalid-args" });
      return { ok: false, reason: "invalid-args" };
    }

    const { windowStart, windowEnd, timezone, maxGapFills } = cfg;

    // Fetch sessions: admitted + near-term candidates
    const store = resolveSessionStore();
    if (!store) {
      emit("planning.today.compile.skipped", {
        reason: "missing-session-store",
      });
      return { ok: false, reason: "missing-session-store" };
    }

    // 1) Pull already-admitted sessions in the window
    const admitted = await safeCall(
      store.listAdmittedInWindow,
      store,
      windowStart,
      windowEnd
    );

    // 2) Pull candidates with deadlines today (or overdue), not yet admitted
    const candidates = await safeCall(
      store.listCandidatesByDeadline,
      store,
      startOfLocalDay(windowStart),
      endOfLocalDay(windowEnd)
    );

    // 3) Merge, dedupe by sessionId
    const basePlan = dedupeById([].concat(admitted || [], candidates || []));

    // 4) Score & order via priorities (EDF + rules) when available
    const scored = await applyPriorities(basePlan, {
      now: new Date(),
      timezone,
    });

    // 5) Respect constraints (quiet hours, sabbath/holy days, safety, prefs)
    const constrained = await applyConstraints(scored, {
      windowStart,
      windowEnd,
      timezone,
    });

    // 6) Fill gaps with light suggestions from options engine
    const withGapFills = await fillGaps(constrained, {
      windowStart,
      windowEnd,
      timezone,
      maxGapFills,
    });

    // 7) Final ordering, clamping to window
    const finalPlan = finalizeOrdering(withGapFills, windowStart, windowEnd);

    // 8) Emit rollup event
    const rollup = {
      dateLocal: toLocalISODate(windowStart),
      timezone,
      windowStartISO: windowStart.toISOString(),
      windowEndISO: windowEnd.toISOString(),
      counts: {
        total: finalPlan.length,
        admitted: (admitted || []).length,
        candidates: (candidates || []).length,
        suggested: finalPlan.filter(
          (x) => x.meta && x.meta.kind === "suggested"
        ).length,
      },
      sessions: finalPlan.map(projectSession),
    };

    emit("planning.today.compiled", { rollup });

    // 9) Optional hub export
    await exportToHubIfEnabled({
      type: "planning.today.compiled",
      ts: new Date().toISOString(),
      source: "runtime.jobs.compileTodayPlan",
      data: rollup,
    });

    return { ok: true, planCount: finalPlan.length };
  },
};

// ---------- Helpers ----------

function normalizeArgs(args) {
  const tz = (args && args.timezone) || "America/Chicago";
  const startHHmm = (args && args.windowStartLocal) || "06:00";
  const endHHmm = (args && args.windowEndLocal) || "23:59";
  const maxGapFills = Number(
    (args && args.maxGapFills) != null ? args.maxGapFills : 3
  );
  if (!/^\d{2}:\d{2}$/.test(startHHmm) || !/^\d{2}:\d{2}$/.test(endHHmm))
    return null;

  const now = new Date();
  const windowStart = localDateWithTime(now, startHHmm, tz);
  const windowEnd = localDateWithTime(now, endHHmm, tz);
  if (
    !(windowStart instanceof Date) ||
    isNaN(windowStart) ||
    !(windowEnd instanceof Date) ||
    isNaN(windowEnd)
  )
    return null;
  if (windowEnd <= windowStart) return null;

  return { timezone: tz, windowStart, windowEnd, maxGapFills };
}

function resolveSessionStore() {
  if (!SessionStore) return null;
  // Support either class with static methods, instance, or plain module fns
  if (typeof SessionStore.listAdmittedInWindow === "function")
    return SessionStore;
  if (SessionStore && typeof SessionStore.getInstance === "function")
    return SessionStore.getInstance();
  if (SessionStore && typeof SessionStore.default === "object")
    return SessionStore.default;
  return SessionStore;
}

async function applyPriorities(sessions, ctx) {
  if (!Array.isArray(sessions) || !sessions.length) return [];
  if (
    !prioritiesPolicy ||
    typeof prioritiesPolicy.scoreSessions !== "function"
  ) {
    // Fallback: EDF (earliest-deadline-first), then hard-before-soft, then duration asc
    return sessions.slice().sort((a, b) => {
      const da = toTime(a.deadlineISO);
      const db = toTime(b.deadlineISO);
      if (da !== db) return da - db;
      const ha = boolScore(a.hard || a.constraints?.hard);
      const hb = boolScore(b.hard || b.constraints?.hard);
      if (ha !== hb) return hb - ha;
      return Number(a.estimatedMinutes || 0) - Number(b.estimatedMinutes || 0);
    });
  }
  try {
    return await prioritiesPolicy.scoreSessions(sessions, ctx);
  } catch (_) {
    return sessions;
  }
}

async function applyConstraints(sessions, ctx) {
  if (!Array.isArray(sessions) || !sessions.length) return [];
  if (!constraintsPolicy) return sessions;
  try {
    const res = await (constraintsPolicy.filterSessions
      ? constraintsPolicy.filterSessions(sessions, ctx)
      : sessions);
    return Array.isArray(res) ? res : sessions;
  } catch (_) {
    return sessions;
  }
}

async function fillGaps(
  sessions,
  { windowStart, windowEnd, timezone, maxGapFills }
) {
  if (
    !optionsEngine ||
    typeof optionsEngine.suggestGaps !== "function" ||
    maxGapFills <= 0
  )
    return sessions;
  try {
    const suggestions = await optionsEngine.suggestGaps({
      windowStartISO: windowStart.toISOString(),
      windowEndISO: windowEnd.toISOString(),
      existing: sessions,
      timezone,
      limit: maxGapFills,
    });
    const normalized = (Array.isArray(suggestions) ? suggestions : []).map(
      (s) => ({
        ...s,
        meta: { ...(s.meta || {}), kind: "suggested" },
      })
    );
    return dedupeById(sessions.concat(normalized));
  } catch (_) {
    return sessions;
  }
}

function finalizeOrdering(sessions, windowStart, windowEnd) {
  const clamped = sessions
    .map((s) => clampToWindow(s, windowStart, windowEnd))
    .filter(Boolean);

  // Stable sort: by plannedStartISO then priorityScore desc then EDF
  return clamped.sort((a, b) => {
    const sa = toTime(a.plannedStartISO);
    const sb = toTime(b.plannedStartISO);
    if (sa !== sb) return sa - sb;
    const pa = Number(a.priorityScore || 0);
    const pb = Number(b.priorityScore || 0);
    if (pa !== pb) return pb - pa;
    const da = toTime(a.deadlineISO);
    const db = toTime(b.deadlineISO);
    return da - db;
  });
}

function clampToWindow(session, winStart, winEnd) {
  const s0 = toTime(session.plannedStartISO || session.suggestedStartISO);
  const e0 = s0 + Number(session.estimatedMinutes || 0) * 60000;
  const s = Math.max(
    s0 || toTime(winStart.toISOString()),
    toTime(winStart.toISOString())
  );
  const e = Math.min(
    e0 || toTime(winEnd.toISOString()),
    toTime(winEnd.toISOString())
  );
  if (!(s < e)) return null;
  return {
    ...session,
    plannedStartISO: new Date(s).toISOString(),
    plannedEndISO: new Date(e).toISOString(),
  };
}

function projectSession(s) {
  return {
    id: s.id,
    domain: s.domain, // e.g., cooking/cleaning/garden/animal/preservation
    title: s.title,
    equipment: s.equipment || [],
    estimatedMinutes: Number(s.estimatedMinutes || 0),
    priorityScore: Number(s.priorityScore || 0),
    hard: !!(s.hard || s.constraints?.hard),
    deadlineISO: s.deadlineISO || null,
    plannedStartISO: s.plannedStartISO || null,
    plannedEndISO: s.plannedEndISO || null,
    meta: s.meta || {},
  };
}

// ---------- Store helpers (expected optional API) ----------
/*
Expected SessionStore methods (defensive):
  - listAdmittedInWindow(startDate: Date, endDate: Date) => Promise<Session[]>
  - listCandidatesByDeadline(dayStart: Date, dayEnd: Date) => Promise<Session[]>
*/
async function safeCall(fn, ctx /* , ...args */) {
  const args = Array.prototype.slice.call(arguments, 2);
  if (typeof fn !== "function") return [];
  try {
    const res = await fn.apply(ctx, args);
    return Array.isArray(res) ? res : [];
  } catch (_) {
    return [];
  }
}

// ---------- Event / Hub helpers ----------

function emit(type, data) {
  try {
    eventBus.emit({
      type: type,
      ts: new Date().toISOString(),
      source: "runtime.jobs.compileTodayPlan",
      data: data,
    });
  } catch (_) {}
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags || !featureFlags.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = await (HubPacketFormatter.format
      ? HubPacketFormatter.format(payload)
      : payload);
    if (FamilyFundConnector && typeof FamilyFundConnector.send === "function") {
      await FamilyFundConnector.send(packet);
    }
  } catch (_) {
    // fail silent by requirement
  }
}

// ---------- Date/time utilities (local-unsafe but deterministic) ----------

function localDateWithTime(baseDate, hhmm, tz) {
  // This uses system tz if Node isn't built with ICU TZ support.
  // We accept slight drift; callers pass America/Chicago by default.
  const [hh, mm] = hhmm.split(":").map(Number);
  const d = new Date(baseDate);
  d.setHours(hh, mm, 0, 0);
  return d;
}

function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function toLocalISODate(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const dd = String(x.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + dd;
}

function toTime(isoOrDate) {
  if (!isoOrDate) return NaN;
  if (isoOrDate instanceof Date) return isoOrDate.getTime();
  const t = Date.parse(isoOrDate);
  return isNaN(t) ? NaN : t;
}

function dedupeById(arr) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const id = arr[i] && (arr[i].id || arr[i].sessionId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...arr[i], id }); // normalize as id
  }
  return out;
}

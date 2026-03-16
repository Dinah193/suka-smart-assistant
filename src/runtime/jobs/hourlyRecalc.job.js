// C:\Users\larho\suka-smart-assistant\src\runtime\jobs\hourlyRecalc.job.js
// SSA Runtime - Job: Hourly Recalc (re-evaluates next 3h every hour)
// ------------------------------------------------------------------
// Role in pipeline:
//   imports -> intelligence -> automation -> (optional) hub export
//   - Looks ahead 3 hours, applies priorities/buffers/constraints, and tries
//     to place a few urgent sessions (light autoplan), then emits a rollup.
//   - If it commits placements (household data changed), it also exports to Hub
//     when familyFundMode is enabled.
//
// Behavior:
//   - Window: [now, now + 3h]
//   - Pulls admitted sessions in-window (to respect and avoid overlaps)
//   - Pulls near-deadline candidates (deadline <= now+3h)
//   - Filters via constraints, orders via priorities (EDF + policy overrides)
//   - Feasibility checks against current calendar; tries up to maxPlacements
//   - Emits: planning.hourlyRecalc.completed (+ .placements.committed if any)
//
// Defensive design:
//   - All external deps optional; degrade gracefully without crashing
//   - Input validation; early-return events on errors
//   - Consistent event payload: { type, ts, source, data } with ISO timestamps

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

// Optional subsystems (defensive requires)
let SessionStore = null; // expected: listAdmittedInWindow, listCandidatesByDeadline, detectConflicts, placeSession
try {
  SessionStore = require("@/engines/scheduling/SessionStore");
} catch (_) {
  try {
    SessionStore = require("@/engines/scheduling/sessionStore");
  } catch (_) {}
}

let prioritiesPolicy = null; // expected: scoreSessions(sessions, ctx)
try {
  prioritiesPolicy = require("@/engines/scheduling/policies/priorities");
} catch (_) {}

let constraintsPolicy = null; // expected: filterSessions(sessions, ctx) or filterSessionsWithWindow
try {
  constraintsPolicy = require("@/engines/scheduling/policies/constraints");
} catch (_) {}

let buffersPolicy = null; // expected: getRecommendedBuffer(domain, kind) optional
try {
  buffersPolicy = require("@/engines/scheduling/policies/buffers");
} catch (_) {}

let feasibility = null; // expected: canPlace(session, ctx) or checkWindow(session, ctx)
try {
  feasibility = require("@/engines/scheduling/admission/feasibility");
} catch (_) {}

let optionsEngine = null; // expected: suggestGaps({...}) optional
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

// Public API
module.exports = {
  /**
   * Recalculate the next 3h and try to place urgent work.
   * @param {Object} args
   * @param {number} [args.horizonMinutes=180]
   * @param {number} [args.maxPlacements=3]
   * @param {string} [args.timezone="America/Chicago"]
   * @returns {Promise<{ok:boolean, placed:number, considered:number}>}
   */
  async run(args) {
    const cfg = normalizeArgs(args);
    if (!cfg) {
      emit("planning.hourlyRecalc.skipped", { reason: "invalid-args" });
      return { ok: false, placed: 0, considered: 0 };
    }
    const { horizonMinutes, maxPlacements, timezone } = cfg;

    const now = new Date();
    const windowStart = new Date(now.getTime());
    const windowEnd = new Date(now.getTime() + horizonMinutes * 60000);

    const store = resolveSessionStore();
    if (!store) {
      emit("planning.hourlyRecalc.skipped", {
        reason: "missing-session-store",
      });
      return { ok: false, placed: 0, considered: 0 };
    }

    // 1) Pull admitted sessions in-window to respect current plan
    const admitted = await safeCall(
      store.listAdmittedInWindow,
      store,
      windowStart,
      windowEnd
    );

    // 2) Pull candidate sessions with deadlines within window (or overdue)
    const candidates = await safeCall(
      store.listCandidatesByDeadline,
      store,
      now,
      windowEnd
    );

    // Merge & dedupe
    const base = dedupeById([].concat(candidates || []));

    // 3) Score candidates using priorities (EDF + rules), then apply constraints
    const scored = await applyPriorities(base, { now, timezone });
    const filtered = await applyConstraints(scored, {
      windowStart,
      windowEnd,
      timezone,
    });

    // 4) Try to place up to maxPlacements, respecting feasibility and overlaps with admitted
    const placed = [];
    const considered = Math.min(filtered.length, maxPlacements * 3); // small guard: inspect only top slice
    for (
      let i = 0;
      i < filtered.length && placed.length < maxPlacements && i < considered;
      i++
    ) {
      const sess = filtered[i];

      const estMin = Number(sess.estimatedMinutes || 0);
      if (!estMin || estMin < 0) continue;

      const padMs = recommendPadMs(sess); // buffer/pad around session if policy is present

      // Find earliest feasible start inside the window (simple forward scan in 5-minute slices)
      const stepMs = 5 * 60000;
      const durMs = estMin * 60000;
      const startFloor = ceilTo5(windowStart);
      let scheduled = null;

      for (
        let t = startFloor.getTime();
        t + durMs + padMs <= windowEnd.getTime();
        t += stepMs
      ) {
        const startISO = new Date(t + padMs / 2).toISOString(); // center pad half before/after
        const endISO = new Date(t + padMs / 2 + durMs).toISOString();
        const ctx = {
          windowStartISO: windowStart.toISOString(),
          windowEndISO: windowEnd.toISOString(),
          admitted: admitted || [],
          timezone,
          nowISO: now.toISOString(),
        };
        const ok = await isFeasible(sess, startISO, endISO, ctx, store);
        if (ok) {
          scheduled = { startISO, endISO };
          break;
        }
      }

      if (scheduled) {
        const placedOk = await commitPlacement(
          store,
          sess,
          scheduled.startISO,
          scheduled.endISO
        );
        if (placedOk) {
          placed.push({
            id: sess.id || sess.sessionId,
            startISO: scheduled.startISO,
            endISO: scheduled.endISO,
          });
          // Update admitted set in-memory to avoid overlapping subsequent trials
          admitted.push({
            id: sess.id || sess.sessionId,
            plannedStartISO: scheduled.startISO,
            plannedEndISO: scheduled.endISO,
            estimatedMinutes: estMin,
          });
        }
      }
    }

    // Optional: add soft suggestions for remaining gaps (no commit, just event data)
    let suggestions = [];
    if (optionsEngine && typeof optionsEngine.suggestGaps === "function") {
      try {
        const res = await optionsEngine.suggestGaps({
          windowStartISO: windowStart.toISOString(),
          windowEndISO: windowEnd.toISOString(),
          existing: admitted || [],
          timezone,
          limit: Math.max(0, maxPlacements - placed.length),
        });
        suggestions = Array.isArray(res)
          ? res.map((x) => ({
              ...x,
              meta: { ...(x.meta || {}), kind: "suggested" },
            }))
          : [];
      } catch (_) {}
    }

    // Emit summary rollup
    const rollup = {
      windowStartISO: windowStart.toISOString(),
      windowEndISO: windowEnd.toISOString(),
      timezone,
      counts: {
        admittedInWindow: (admitted || []).length,
        candidates: (candidates || []).length,
        considered,
        placed: placed.length,
        suggestions: suggestions.length,
      },
      placed,
      suggestions: suggestions.map(projectSuggestion),
    };

    emit("planning.hourlyRecalc.completed", { rollup });

    // If any placement changed household data, export to hub (silent if unavailable)
    if (placed.length > 0) {
      emit("planning.hourlyRecalc.placements.committed", { placed });
      await exportToHubIfEnabled({
        type: "planning.hourlyRecalc.completed",
        ts: new Date().toISOString(),
        source: "runtime.jobs.hourlyRecalc",
        data: rollup,
      });
    }

    return { ok: true, placed: placed.length, considered };
  },
};

// ----------------------------- helpers -----------------------------

function normalizeArgs(args) {
  const horizonMinutes = Number(
    (args && args.horizonMinutes) != null ? args.horizonMinutes : 180
  );
  const maxPlacements = Number(
    (args && args.maxPlacements) != null ? args.maxPlacements : 3
  );
  const timezone = (args && args.timezone) || "America/Chicago";
  if (!isFinite(horizonMinutes) || horizonMinutes <= 0) return null;
  if (!isFinite(maxPlacements) || maxPlacements < 0) return null;
  return { horizonMinutes, maxPlacements, timezone };
}

function resolveSessionStore() {
  if (!SessionStore) return null;
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
    // Fallback: EDF, then hard-before-soft, then duration asc
    return sessions.slice().sort((a, b) => {
      const da = toTime(a.deadlineISO);
      const db = toTime(b.deadlineISO);
      if (da !== db) return da - db;
      const ha = a.hard || (a.constraints && a.constraints.hard) ? 1 : 0;
      const hb = b.hard || (b.constraints && b.constraints.hard) ? 1 : 0;
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

function recommendPadMs(session) {
  try {
    if (
      !buffersPolicy ||
      typeof buffersPolicy.getRecommendedBuffer !== "function"
    )
      return 0;
    const rec = buffersPolicy.getRecommendedBuffer(
      session.domain || "general",
      session.meta && session.meta.kind
    );
    const minMs = Number((rec && rec.minMs) || 0);
    const beforeMs = Number((rec && rec.beforeMs) || 0);
    const afterMs = Number((rec && rec.afterMs) || 0);
    const sum = Math.max(minMs, beforeMs + afterMs);
    return isFinite(sum) && sum >= 0 ? sum : 0;
  } catch (_) {
    return 0;
  }
}

async function isFeasible(session, startISO, endISO, ctx, store) {
  // First check feasibility engine if present
  if (feasibility && typeof feasibility.canMeetDeadline === "function") {
    try {
      const ok = await feasibility.canMeetDeadline({
        session,
        proposedStartISO: startISO,
        proposedEndISO: endISO,
        windowStartISO: ctx.windowStartISO,
        windowEndISO: ctx.windowEndISO,
        admitted: ctx.admitted,
        nowISO: ctx.nowISO,
      });
      if (!ok) return false;
    } catch (_) {
      // fall through to conflict check
    }
  }
  // Conflict check against store calendar
  try {
    if (typeof store.detectConflicts === "function") {
      const conflicts = await store.detectConflicts({
        startISO,
        endISO,
        excludeIds: [session.id || session.sessionId],
      });
      if (Array.isArray(conflicts) && conflicts.length) return false;
    }
  } catch (_) {}
  return true;
}

async function commitPlacement(store, session, startISO, endISO) {
  try {
    if (typeof store.placeSession !== "function") return false;
    const res = await store.placeSession({
      id: session.id || session.sessionId,
      startISO,
      endISO,
      reason: "hourlyRecalc",
    });
    return !!res;
  } catch (_) {
    return false;
  }
}

function projectSuggestion(s) {
  return {
    id: s.id,
    title: s.title,
    domain: s.domain,
    estimatedMinutes: Number(s.estimatedMinutes || 0),
    suggestedStartISO: s.suggestedStartISO || null,
    suggestedEndISO: s.suggestedEndISO || null,
    meta: s.meta || {},
  };
}

function emit(type, data) {
  try {
    eventBus.emit({
      type: type,
      ts: new Date().toISOString(),
      source: "runtime.jobs.hourlyRecalc",
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
    // fail silently per requirement
  }
}

// ----------------------------- tiny utils -----------------------------

function ceilTo5(date) {
  const d = new Date(date.getTime());
  const ms = d.getTime();
  const step = 5 * 60000;
  const next = Math.ceil(ms / step) * step;
  return new Date(next);
}

async function safeCall(fn, ctx) {
  const args = Array.prototype.slice.call(arguments, 2);
  if (typeof fn !== "function") return [];
  try {
    const res = await fn.apply(ctx, args);
    return Array.isArray(res) ? res : [];
  } catch (_) {
    return [];
  }
}

function dedupeById(arr) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const id = arr[i] && (arr[i].id || arr[i].sessionId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...arr[i], id });
  }
  return out;
}

function toTime(isoOrDate) {
  if (!isoOrDate) return NaN;
  if (isoOrDate instanceof Date) return isoOrDate.getTime();
  const t = Date.parse(isoOrDate);
  return isNaN(t) ? NaN : t;
}

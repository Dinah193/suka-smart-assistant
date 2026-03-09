// C:\Users\larho\suka-smart-assistant\src\services\session\SessionConflictRules.js
// SessionConflictRules.js
// -----------------------------------------------------------------------------
// PURPOSE
// This service centralizes "can these two sessions run at the same time?" logic.
// SSA runs a *household engine* where multiple domains can generate actionable
// sessions: cooking, cleaning, garden, animal/butchery, preservation, storehouse.
// Those domains may overlap in:
//   - time windows (2 sessions at 10:00)
//   - equipment/resources (oven, stovetop, dehydrator, smoker, sink, hose, freezer)
//   - "do not disturb" windows (Sabbath / quiet hours / weather)
//   - people/roles (if you wire people-involved sessions later)
//
// This file fits in the pipeline like this:
//   IMPORT → normalize → planners/generators → **SessionConflictRules** → automation runtime
//   → (optional) Hub export when familyFundMode=true
//
// REQUIREMENTS FROM USER:
// 1. SSA and SVFFH are separate. This file MUST NOT depend on Hub to work.
// 2. Emit consistent eventBus shape: { type, ts, source, data }
// 3. Be forward-thinking (allow new domains / new equipment)
// 4. If it changes household data (e.g. it AUTO-DELAYS a session or marks conflict)
//    call exportToHubIfEnabled(...) and fail silently if Hub is unavailable.
//
// ASSUMPTIONS
// - We have a shared eventBus at "@/services/events/eventBus"
// - Sessions announce themselves with one of:
//     "session.scheduled"   → { session: {...} }
//     "session.started"     → { session: {...} }
//     "session.updated"     → { session: {...} }
//   The `.session` object should look like:
//
//   {
//     id: "sess-123",
//     domain: "cooking" | "cleaning" | "garden" | "animals" | "preservation" | "storehouse",
//     title: "Batch cook stews",
//     startsAt: 1730499600000,    // ms epoch
//     endsAt: 1730503200000,      // ms epoch
//     equipment: ["oven", "stovetop", "freezer?"],
//     resources: { energy: "normal", water: "high" },
//     meta: { createdBy: "user", priority: 1, ... }
//   }
//
// - We ALSO listen for "automation.schedule.request" so we can block/adjust before it is saved.
//

/* eslint-disable no-console */
(function () {
  const MODULE_SOURCE = "SessionConflictRules";
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();

  // ----------------------------- defensive imports ---------------------------
  let eventBus = { on() {}, off() {}, emit() {} };
  try {
    const eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  let featureFlags = { familyFundMode: false };
  try {
    featureFlags = require("@/config/featureFlags.json") || featureFlags;
  } catch (_e) {}

  let HubPacketFormatter = null;
  try {
    HubPacketFormatter = require("@/services/hub/HubPacketFormatter");
  } catch (_e) {}

  let FamilyFundConnector = null;
  try {
    FamilyFundConnector = require("@/services/hub/FamilyFundConnector");
  } catch (_e) {}

  // optional: schedule helpers (sabbath, quiet, weather)
  let scheduleHelpers = null;
  try {
    scheduleHelpers = require("@/services/scheduleHelpers");
  } catch (_e) {}

  // optional: automation runtime (to auto-delay conflicting sessions)
  let automation = null;
  try {
    automation =
      (require("@/services/automation/runtime") || {}).automation || null;
  } catch (_e) {}

  // ----------------------------- utils ---------------------------------------
  function emitEvent(type, data) {
    const payload = {
      type,
      ts: new Date().toISOString(),
      source: MODULE_SOURCE,
      data: data || {},
    };
    try {
      eventBus.emit(type, payload);
    } catch (_e) {}
    // let automation hear about session conflicts too
    try {
      if (automation && typeof automation.emitEvent === "function") {
        automation.emitEvent(type, payload);
      }
    } catch (_e) {}
    return payload;
  }

  function exportToHubIfEnabled(payload) {
    if (!featureFlags?.familyFundMode) return;
    try {
      const packet = HubPacketFormatter
        ? HubPacketFormatter.format("sessionConflict", payload)
        : { kind: "sessionConflict", payload };
      if (
        FamilyFundConnector &&
        typeof FamilyFundConnector.send === "function"
      ) {
        FamilyFundConnector.send(packet);
      }
    } catch (_err) {
      // SSA must continue without hub
    }
  }

  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

  function toMs(x) {
    if (typeof x === "number") return x;
    if (!x) return 0;
    const s = String(x).trim();
    if (/^\d+$/.test(s)) return Number(s);
    // "+20m", "PT30M" patterns could be added here if needed
    return Date.parse(s) || 0;
  }

  // ----------------------------- in-memory state -----------------------------
  // Keep a very small in-memory index of scheduled/running sessions to check conflicts.
  // Shape:
  // sessionsById[id] = { id, domain, startsAt, endsAt, equipment[], resources{}, meta{} }
  const sessionsById = Object.create(null);

  // domains that are more likely to rival for equipment/time
  const HIGH_CONTENTION_DOMAINS = new Set([
    "cooking", // oven, stove, freezer, mixer, dehydrator
    "preservation", // dehydrator, smoker, canner
    "cleaning", // water, washer/dryer, power
    "animals", // equipment + outdoor time windows
    "garden", // hose, outdoor quiet/wet windows
  ]);

  // canonical equipment keys we know about; new ones will be accepted but not auto-grouped
  const EQUIPMENT_GROUPS = {
    oven: ["oven", "baking-oven", "convection-oven"],
    stovetop: ["stovetop", "burner", "gas-burner", "induction-burner"],
    dehydrator: ["dehydrator", "preservation-dehydrator"],
    smoker: ["smoker", "outdoor-smoker"],
    canner: ["canner", "pressure-canner"],
    washer: ["washer", "laundry-washer"],
    dryer: ["dryer", "laundry-dryer"],
    hose: ["hose", "garden-hose", "water-line"],
    freezer: ["freezer", "deep-freeze"],
  };

  function normalizeEquip(list) {
    if (!Array.isArray(list)) return [];
    return list
      .map((e) => (typeof e === "string" ? e.trim().toLowerCase() : null))
      .filter(Boolean);
  }

  function expandEquipment(equipmentList) {
    // turn "oven" into ["oven", "baking-oven", ...] for matching
    const known = new Set();
    const normalized = normalizeEquip(equipmentList);
    normalized.forEach((item) => {
      known.add(item);
      Object.keys(EQUIPMENT_GROUPS).forEach((key) => {
        const variants = EQUIPMENT_GROUPS[key];
        if (variants.includes(item)) {
          variants.forEach((v) => known.add(v));
          known.add(key);
        }
      });
    });
    return Array.from(known);
  }

  // ----------------------------- core conflict logic -------------------------
  /**
   * Check if two time ranges overlap with a minimum overlap.
   * @param {number} startA
   * @param {number} endA
   * @param {number} startB
   * @param {number} endB
   * @param {number} [minOverlapMs=1]
   * @returns {boolean}
   */
  function rangesOverlap(startA, endA, startB, endB, minOverlapMs = 1) {
    if (!startA || !endA || !startB || !endB) return false;
    const latestStart = Math.max(startA, startB);
    const earliestEnd = Math.min(endA, endB);
    const diff = earliestEnd - latestStart;
    return diff >= minOverlapMs;
  }

  /**
   * Check if equipment sets overlap.
   * @param {string[]} reqA
   * @param {string[]} reqB
   * @returns {string[]} conflicting equipment
   */
  function equipmentOverlap(reqA, reqB) {
    if (!reqA?.length || !reqB?.length) return [];
    const a = new Set(expandEquipment(reqA));
    const b = new Set(expandEquipment(reqB));
    const out = [];
    a.forEach((item) => {
      if (b.has(item)) out.push(item);
    });
    return out;
  }

  /**
   * Check weather/quiet/sabbath guards quickly.
   * Returns an array of active guards.
   */
  function activeGuardsAt(ts, domain) {
    const guards = [];
    if (!scheduleHelpers) return guards;
    try {
      if (scheduleHelpers.isSabbath && scheduleHelpers.isSabbath(ts)) {
        guards.push({
          kind: "sabbath",
          until: scheduleHelpers.nextUnquiet
            ? scheduleHelpers.nextUnquiet(ts)
            : null,
        });
      }
    } catch (_e) {}
    try {
      if (scheduleHelpers.inQuietHours && scheduleHelpers.inQuietHours(ts)) {
        guards.push({
          kind: "quiet-hours",
          until: scheduleHelpers.nextUnquiet
            ? scheduleHelpers.nextUnquiet(ts)
            : null,
        });
      }
    } catch (_e) {}
    try {
      if (scheduleHelpers.withholdsForDomain) {
        const w = scheduleHelpers.withholdsForDomain(domain) || [];
        guards.push(...w);
      }
    } catch (_e) {}
    return guards;
  }

  /**
   * Main entry: compare an incoming session against existing ones.
   * returns { ok: boolean, conflicts: [...] }
   */
  function checkSessionAgainstExisting(candidate) {
    const conflicts = [];

    const cStart = toMs(candidate.startsAt);
    const cEnd =
      toMs(candidate.endsAt) || (cStart ? cStart + 30 * 60 * 1000 : 0); // default 30 min
    const cEq = normalizeEquip(candidate.equipment);

    // guard-aware: if Sabbath/quiet → we mark as conflict with guard
    const guards = activeGuardsAt(cStart || now(), candidate.domain);
    if (guards.length) {
      conflicts.push({
        kind: "guard",
        guards,
        message: "Session occurs during a guarded time window.",
      });
    }

    Object.values(sessionsById).forEach((sess) => {
      if (!sess) return;
      if (sess.id === candidate.id) return;

      const sStart = toMs(sess.startsAt);
      const sEnd = toMs(sess.endsAt);

      // time overlap?
      if (rangesOverlap(cStart, cEnd, sStart, sEnd, 60 * 1000)) {
        // equipment overlap too?
        const eqOverlap = equipmentOverlap(cEq, normalizeEquip(sess.equipment));
        const isHighContention =
          HIGH_CONTENTION_DOMAINS.has(candidate.domain) ||
          HIGH_CONTENTION_DOMAINS.has(sess.domain);
        conflicts.push({
          kind: eqOverlap.length ? "time+equipment" : "time",
          withSessionId: sess.id,
          withDomain: sess.domain,
          overlapMs: Math.min(cEnd, sEnd) - Math.max(cStart, sStart),
          equipment: eqOverlap,
          highContention: isHighContention,
        });
      }
    });

    return {
      ok: conflicts.length === 0,
      conflicts,
    };
  }

  // ----------------------------- resolution strategies ------------------------
  /**
   * Try to auto-resolve a conflict by pushing the candidate session forward.
   * We keep this *very* conservative: we only push forward by the exact overlap window + 5 minutes,
   * and we only do this if automation runtime is available.
   *
   * returns { resolved: boolean, newStartsAt?, newEndsAt? }
   */
  function tryAutoDelay(candidate, conflicts) {
    if (!automation) return { resolved: false };

    // find the worst overlap
    let maxOverlap = 0;
    let maxUntil = null;
    conflicts.forEach((c) => {
      if (c.kind === "guard") {
        // if guard has 'until', prefer that
        const u = c.guards?.[0]?.until;
        if (u) {
          const uMs = toMs(u);
          if (uMs > (maxUntil || 0)) {
            maxUntil = uMs;
          }
        }
      }
      if (typeof c.overlapMs === "number" && c.overlapMs > maxOverlap) {
        maxOverlap = c.overlapMs;
      }
    });

    // base push is: maxOverlap + 5m
    const basePushMs = maxOverlap ? maxOverlap + 5 * 60 * 1000 : 5 * 60 * 1000;
    const curStart = toMs(candidate.startsAt) || now();
    let newStart = curStart + basePushMs;

    // if guard says "wait until ts"
    if (maxUntil && maxUntil > newStart) {
      newStart = maxUntil;
    }

    const duration =
      (toMs(candidate.endsAt) || curStart + 30 * 60 * 1000) - curStart;
    const newEnd = newStart + duration;

    // emit a request to automation to update the schedule
    automation.emitEvent?.("automation.schedule.request", {
      id: candidate.scheduleId || candidate.id,
      title: candidate.title || "Delayed Session",
      templateId:
        candidate.templateId ||
        `session.${candidate.domain || "general"}.generate`,
      rule: { at: new Date(newStart).toISOString().slice(11, 16) }, // "HH:MM"
      ctx: { ...candidate, startsAt: newStart, endsAt: newEnd },
      meta: {
        domain: candidate.domain || "general",
        reason: "conflict-auto-delay",
      },
    });

    return {
      resolved: true,
      newStartsAt: newStart,
      newEndsAt: newEnd,
    };
  }

  // ----------------------------- main handler ---------------------------------
  /**
   * Handle an incoming session (scheduled/started/updated).
   * Saves to local index, checks conflicts, emits events, optionally notifies hub.
   */
  function handleIncomingSession(raw) {
    if (!raw || typeof raw !== "object") return;
    const session = raw.session || raw; // tolerate both shapes

    if (!session.id) {
      // no id → we can't track it
      console.warn(
        "[SessionConflictRules] session without id ignored:",
        session
      );
      return;
    }

    // normalize basic shape
    const norm = {
      id: String(session.id),
      domain: session.domain || "general",
      title: session.title || "Session",
      startsAt: toMs(session.startsAt) || now(),
      endsAt:
        toMs(session.endsAt) ||
        (toMs(session.startsAt)
          ? toMs(session.startsAt) + 30 * 60 * 1000
          : now() + 30 * 60 * 1000),
      equipment: normalizeEquip(session.equipment),
      resources: session.resources || {},
      meta: session.meta || {},
      scheduleId: session.scheduleId || null,
      templateId: session.templateId || null,
    };

    // save for future checks
    sessionsById[norm.id] = norm;

    // run conflict check
    const check = checkSessionAgainstExisting(norm);

    if (check.ok) {
      // good, emit "session.conflict.clear"
      emitEvent("session.conflict.cleared", {
        sessionId: norm.id,
        domain: norm.domain,
      });
      return;
    }

    // there ARE conflicts
    const detectedPayload = emitEvent("session.conflict.detected", {
      sessionId: norm.id,
      domain: norm.domain,
      conflicts: check.conflicts,
      session: norm,
    });

    // try to auto-resolve if configured / possible
    const auto = tryAutoDelay(norm, check.conflicts);
    if (auto.resolved) {
      emitEvent("session.conflict.autoResolved", {
        sessionId: norm.id,
        domain: norm.domain,
        newStartsAt: auto.newStartsAt,
        newEndsAt: auto.newEndsAt,
        conflicts: check.conflicts,
      });

      // hub mirror: SSA delayed a session due to conflicts
      exportToHubIfEnabled({
        action: "session.conflict.autoResolved",
        sessionId: norm.id,
        domain: norm.domain,
        newStartsAt: auto.newStartsAt,
        newEndsAt: auto.newEndsAt,
        conflicts: check.conflicts,
      });
    } else {
      // hub mirror: just report the conflict
      exportToHubIfEnabled({
        action: "session.conflict.detected",
        sessionId: norm.id,
        domain: norm.domain,
        conflicts: check.conflicts,
      });
    }

    return detectedPayload;
  }

  // ----------------------------- event wiring ---------------------------------
  function initSessionConflictRules() {
    // 1) newly scheduled sessions
    eventBus.on("session.scheduled", (evt = {}) => {
      handleIncomingSession(evt.data || evt);
    });

    // 2) sessions that start right now
    eventBus.on("session.started", (evt = {}) => {
      handleIncomingSession(evt.data || evt);
    });

    // 3) updates (time changed / equipment added)
    eventBus.on("session.updated", (evt = {}) => {
      handleIncomingSession(evt.data || evt);
    });

    // 4) automation.schedule.request — we can inspect BEFORE it is persisted
    //    shape: { type, ts, source, data: { templateId, rule, ctx, meta } }
    eventBus.on("automation.schedule.request", (evt = {}) => {
      const data = evt.data || {};
      const ctx = data.ctx || {};
      // Only run conflict check if ctx looks like a session
      if (!ctx.sessionId && !ctx.id) return;
      handleIncomingSession({
        session: {
          id: ctx.sessionId || ctx.id,
          domain: ctx.domain || data.meta?.domain || "general",
          title: data.title || ctx.title,
          startsAt: ctx.startsAt,
          endsAt: ctx.endsAt,
          equipment: ctx.equipment,
          resources: ctx.resources,
          meta: { ...(ctx.meta || {}), scheduleMeta: data.meta || {} },
          scheduleId: data.id || null,
          templateId: data.templateId || null,
        },
      });
    });

    // 5) clear from index when session ends
    eventBus.on("session.ended", (evt = {}) => {
      const data = evt.data || evt;
      const sid = data.sessionId || data.id;
      if (!sid) return;
      delete sessionsById[sid];
      emitEvent("session.conflict.tracking.removed", { sessionId: sid });
    });

    // 6) optional: react to domain-specific schedules, e.g. cooking/session/schedule
    //    we just normalize and pass through
    const domainSchedules = [
      "cooking/session/schedule",
      "cleaning/session/schedule",
      "garden/session/schedule",
      "animals/session/schedule",
      "preservation/session/schedule",
      "storehouse/session/schedule",
    ];
    domainSchedules.forEach((topic) => {
      eventBus.on(topic, (evt = {}) => {
        const p = evt.payload || evt.data || evt;
        if (!p.sessionId && !p.id) return;
        handleIncomingSession({
          session: {
            id: p.sessionId || p.id,
            domain: topic.split("/")[0], // "cooking", "cleaning", ...
            title: p.title,
            startsAt: p.startsAt,
            endsAt: p.endsAt,
            equipment: p.equipment,
            resources: p.resources,
            meta: p.meta || {},
            scheduleId: p.id || null,
          },
        });
      });
    });

    emitEvent("session.conflict.rules.ready", {
      message: "Session conflict rules initialized.",
    });
  }

  // ----------------------------- exports --------------------------------------
  const SessionConflictRules = {
    checkSessionAgainstExisting,
    handleIncomingSession,
    init: initSessionConflictRules,
  };

  // CommonJS + browser global
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SessionConflictRules;
  } else {
    // @ts-ignore
    window.SessionConflictRules = SessionConflictRules;
  }

  // auto-init in browser
  if (isBrowser) {
    try {
      initSessionConflictRules();
    } catch (err) {
      console.error("[SessionConflictRules] init failed:", err);
    }
  }
})();

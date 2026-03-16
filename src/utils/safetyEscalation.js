/* eslint-disable no-console */
import eventBusModule from "@/services/events/eventBus";
import * as pausePoliciesModule from "@/services/session/policies/pausePolicies";
import * as inventoryGuardModule from "@/services/session/guards/inventoryGuard";
import * as timeUtilModule from "@/utils/dateFormat";
import * as prefsModule from "@/stores/scheduler/prefs";

// src/utils/safetyEscalation.js
// Safety Escalation: soft/hard deadline evaluators + guard-aware actions.
//
// Goals
// - Unify "deadline pressure" across domains (meal steps, garden tasks, animal care)
// - Soft -> notify / suggest pause / pre-emptive substitution
// - Hard -> auto-pause / stop / fallback plan
// - Respect Quiet Hours + Sabbath Guard; never spam during locked windows
// - Event-driven: emit rich payloads that the NBA orchestrator and UI can use
//
// Inputs (examples)
//  evaluate({
//    id: "session:abc#step:3",
//    domain: "cooking",                     // "cooking"|"garden"|"animals"|"cleaning"|...
//    title: "Sear lamb - side A",
//    startAt: 1730023200000,                // ms
//    dueAt: 1730023420000,                  // ms (hard deadline / end)
//    softAt: 1730023340000,                 // ms (soft threshold; optional)
//    maxOverrunMs: 120000,                  // grace after dueAt before "hard" triggers
//    risk: { heat: true, perishables: true, contamination: false }, // domain flags
//    meta: { sessionId, stepIndex, planRef, priority: "high" }
//  }, nowMs)
//
// API emits "safety:escalation" with { level, code, nextBestActions[], ... }
// Optionally triggers pause/stop via pausePolicies when appropriate.
//

(function () {
  const pickModule = (mod) => {
    if (!mod) return null;
    return "default" in mod ? mod.default || mod : mod;
  };

  /* ------------------------------- Optional deps ----------------------------- */
  let eventBus = pickModule(eventBusModule) || { emit() {}, on() {}, off() {} };
  eventBus = eventBus.eventBus || eventBus;

  // Pause policies (freeze/continue/safety). Defensive import.
  const pausePolicies = pickModule(pausePoliciesModule);

  // Inventory guard (optional; for substitution hints when time is tight)
  const inventoryGuard = pickModule(inventoryGuardModule);

  // Time helpers
  const timeUtil = pickModule(timeUtilModule);

  // Scheduler/global settings (quiet hours, sabbath guard, safety thresholds)
  let getSchedulerPrefs = () => ({
    quietHours: { enabled: false, start: "22:00", end: "06:00" },
    sabbathGuard: {
      enabled: false,
      start: "Friday 18:00",
      end: "Saturday 19:30",
    },
    safety: {
      softLeadMs: 2 * 60 * 1000, // if no softAt provided: how early to warn
      hardGraceMs: 60 * 1000, // grace after dueAt before hard escalation
      cooldownMs: 45 * 1000, // re-emit min interval
      minTickMs: 5000,
    },
    user: { locale: null },
  });
  if (prefsModule && typeof prefsModule.getSchedulerPrefs === "function") {
    getSchedulerPrefs = prefsModule.getSchedulerPrefs;
  }

  /* -------------------------------- Mini utils ------------------------------- */
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const now = () => Date.now();
  const toTs = (x) =>
    x instanceof Date ? x.getTime() : typeof x === "number" ? x : Date.parse(x);
  const pad2 = (n) => String(n).padStart(2, "0");

  const lastEmitAt = new Map(); // id -> timestamp (cooldown)

  // HH:MM to ms-of-day
  function parseHHMM(s) {
    if (!s || typeof s !== "string") return null;
    const [h, m] = s.split(":").map((v) => parseInt(v, 10));
    if (Number.isNaN(h) || Number.isNaN(m)) return null;
    return { h, m };
  }

  function isWithinQuietHours(ts, quiet) {
    if (!quiet?.enabled) return false;
    const d = new Date(ts);
    const { h, m } = { h: d.getHours(), m: d.getMinutes() };
    const curMin = h * 60 + m;
    const start = parseHHMM(quiet.start) || { h: 22, m: 0 };
    const end = parseHHMM(quiet.end) || { h: 6, m: 0 };
    const sMin = start.h * 60 + start.m,
      eMin = end.h * 60 + end.m;
    if (sMin <= eMin) return curMin >= sMin && curMin < eMin; // same-day window
    // crosses midnight
    return curMin >= sMin || curMin < eMin;
  }

  // Simple sabbath window detector. Start/End strings are human-ish; we only gate if enabled.
  function isWithinSabbath(ts, sabbath) {
    if (!sabbath?.enabled) return false;
    // Lightweight approach: treat Friday 18:00 -> Saturday 19:30 as default if parsing fails
    const d = new Date(ts);
    const dow = d.getDay(); // 0 Sun .. 6 Sat
    const hour = d.getHours() + d.getMinutes() / 60;
    if (dow === 5) return hour >= 18; // Friday after 18:00
    if (dow === 6) return hour < 19.5; // Saturday before 19:30
    return false;
  }

  function cooldownOk(id, cooldownMs) {
    const prev = lastEmitAt.get(id) || 0;
    const ok = now() - prev >= cooldownMs;
    if (ok) lastEmitAt.set(id, now());
    return ok;
  }

  /* --------------------------- Risk & Slack calculation ---------------------- */
  function slackMs(input, nowMs) {
    const due = toTs(input.dueAt);
    const soft = input.softAt
      ? toTs(input.softAt)
      : due - (getSchedulerPrefs().safety.softLeadMs || 120000);
    const hardGrace =
      input.maxOverrunMs ?? getSchedulerPrefs().safety.hardGraceMs ?? 60000;

    return {
      toSoft: soft - nowMs,
      toDue: due - nowMs,
      toHard: due + hardGrace - nowMs,
      softAt: soft,
      dueAt: due,
      hardAt: due + hardGrace,
    };
  }

  function riskScore(input) {
    // Simple additive heuristic; tuneable per domain
    const r = input.risk || {};
    let score = 0;
    if (r.heat) score += 3;
    if (r.perishables) score += 2;
    if (r.contamination) score += 3;
    if (input.meta?.priority === "high") score += 1;
    if (input.domain === "animals") score += 2; // time sensitivity
    return clamp(score, 0, 10);
  }

  /* --------------------------- NBA suggestion builders ----------------------- */
  function nbasForSoft(input, delta) {
    const list = [];
    if (input.domain === "cooking") {
      list.push({
        code: "PREHEAT_OR_PREP",
        label: "Pre-heat/Prep now",
        rationale: "Avoid crunch at hard deadline",
      });
      list.push({
        code: "SET_TIMER",
        label: "Set timer for " + formatRemaining(delta),
        rationale: "Stay on track",
      });
      if (inventoryGuard?.suggestSubs) {
        list.push({
          code: "CHECK_SUBS",
          label: "Check substitutions",
          rationale: "If ingredient missing, adapt now",
          data: { suggest: true },
        });
      }
    } else if (input.domain === "garden") {
      list.push({
        code: "STAGE_TOOLS",
        label: "Stage tools & water",
        rationale: "Be ready for action window",
      });
    } else if (input.domain === "animals") {
      list.push({
        code: "STAGE_FEED_SHELTER",
        label: "Stage feed/shelter",
        rationale: "Reduce animal stress",
      });
    } else {
      list.push({
        code: "REVIEW_STEP",
        label: "Review upcoming step",
        rationale: "Reduce errors under time pressure",
      });
    }
    return list;
  }

  function nbasForHard(input) {
    const list = [];
    const basePause = {
      code: "AUTO_PAUSE",
      label: "Auto-pause session",
      rationale: "Exceeded hard deadline",
    };
    const baseStop = {
      code: "AUTO_STOP",
      label: "Stop step",
      rationale: "Exceeded hard deadline",
    };

    if (input.domain === "cooking") {
      list.push(basePause, {
        code: "SAFE_REMOVE_HEAT",
        label: "Remove from heat",
        rationale: "Prevent burning",
      });
      list.push({
        code: "COOL_DOWN",
        label: "Start cool-down",
        rationale: "Food safety",
      });
    } else if (input.domain === "animals") {
      list.push(basePause, {
        code: "ESCALATE_ANIMAL_WELFARE",
        label: "Escalate care",
        rationale: "Animal welfare priority",
      });
    } else if (input.domain === "garden") {
      list.push(baseStop, {
        code: "WATER_OR_SHADE",
        label: "Water/shade plants",
        rationale: "Prevent stress",
      });
    } else {
      list.push(basePause);
    }
    return list;
  }

  function formatRemaining(ms) {
    if (timeUtil?.countdownLabel) return timeUtil.countdownLabel(ms);
    // Basic fallback: MM:SS remaining
    const t = Math.max(0, Math.floor(ms / 1000));
    const mm = pad2(Math.floor(t / 60));
    const ss = pad2(t % 60);
    return `${mm}:${ss} remaining`;
  }

  /* ---------------------------- Evaluator (core) ----------------------------- */
  /**
   * Evaluate escalation level for an item.
   * @param {object} input - see header for shape
   * @param {number} [nowMs] - current time (ms)
   * @returns {{
   *   id:string, level:"none"|"soft"|"hard", code:string,
   *   reason:string, data:any, nextCheckMs:number,
   *   nextBestActions:Array<{code:string,label:string,rationale?:string,data?:any}>
   * }}
   */
  function evaluate(input, nowMs = now()) {
    const prefs = getSchedulerPrefs();
    const quiet = isWithinQuietHours(nowMs, prefs.quietHours);
    const sabbath = isWithinSabbath(nowMs, prefs.sabbathGuard);

    const { toSoft, toDue, toHard, softAt, dueAt, hardAt } = slackMs(
      input,
      nowMs
    );
    const risk = riskScore(input);
    const cool = prefs.safety?.cooldownMs ?? 45000;

    // If within Sabbath guard: avoid hard actions; only low-noise soft nudges
    const guardLock = sabbath ? "sabbath" : quiet ? "quiet" : null;

    // Decide level
    let level = "none";
    let code = "OK";
    let reason = "On schedule";
    let nbas = [];
    let nextCheckMs = prefs.safety?.minTickMs ?? 5000;

    if (toHard <= 0) {
      level = "hard";
      code = "DEADLINE_PASSED";
      reason = "Exceeded deadline + grace";
      nbas = nbasForHard(input);
    } else if (toDue <= 0) {
      level = "hard";
      code = "DUE_EXCEEDED_IN_GRACE";
      reason = "Past due; within grace";
      nbas = nbasForHard(input);
    } else if (toSoft <= 0) {
      level = "soft";
      code = "APPROACHING_DEADLINE";
      reason = "Soft threshold reached";
      nbas = nbasForSoft(input, toDue);
      nextCheckMs = Math.min(
        nextCheckMs,
        Math.max(3000, Math.floor(toDue / 3))
      );
    } else {
      // far from soft: lower freq checks
      const lead = Math.max(10000, Math.min(60000, toSoft / 2));
      nextCheckMs = Math.round(lead);
    }

    // Guard-aware dampening
    if (guardLock && level === "hard") {
      // downgrade to soft with safe suggestions only
      level = "soft";
      code = `GUARD_DOWNGRADE_${guardLock.toUpperCase()}`;
      reason = `Within ${guardLock} window; suppressing hard actions`;
      nbas = nbasForSoft(input, toDue).filter((a) => a.code !== "SET_TIMER"); // keep it quiet
    }

    // Cooldown gating for emits
    const shouldEmit =
      level !== "none" &&
      cooldownOk(input.id || input.meta?.sessionId || dueAt, cool);

    const payload = {
      id: input.id || `${input.domain || "task"}:${dueAt}`,
      domain: input.domain || "task",
      level,
      code,
      reason,
      risk,
      schedule: { softAt, dueAt, hardAt, now: nowMs, toSoft, toDue, toHard },
      nextBestActions: nbas,
      context: { title: input.title, meta: input.meta || {} },
      guards: { quietHours: !!quiet, sabbath: !!sabbath },
      nextCheckMs,
    };

    if (shouldEmit) eventBus.emit("safety:escalation", payload);

    // Auto-pause trigger (only when not in quiet/sabbath; require policy)
    if (!guardLock && level === "hard" && pausePolicies?.autoPauseForSafety) {
      try {
        pausePolicies.autoPauseForSafety(payload);
        eventBus.emit("session:safety:autopause", {
          id: payload.id,
          reason: payload.code,
        });
      } catch (e) {
        console.warn("[safetyEscalation] autoPauseForSafety failed:", e);
      }
    }

    return payload;
  }

  /* --------------------------- Batch convenience API ------------------------ */
  function evaluateMany(items, nowMs = now()) {
    const out = items.map((it) => evaluate(it, nowMs));
    // Pick most severe to suggest a global NBA
    const hard = out.filter((o) => o.level === "hard");
    const soft = out.filter((o) => o.level === "soft");
    const head = hard[0] || soft[0] || out[0] || null;
    return { results: out, head };
  }

  /* --------------------------------- Export --------------------------------- */
  const api = { evaluate, evaluateMany };

  try {
    module.exports = api;
  } catch (_e) {}
  // ESM compatibility
  // @ts-ignore
  if (typeof exports !== "undefined") {
    exports.evaluate = evaluate;
    exports.evaluateMany = evaluateMany;
    exports.default = api;
  }
  // Browser fallback
  // @ts-ignore
  if (typeof window !== "undefined") window.SukaSafetyEscalation = api;
})();

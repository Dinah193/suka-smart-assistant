/* eslint-disable no-console */
// sessionExecutionEngine.js — domain-agnostic runbook executor (ES2015-safe)
// Orchestrates a single runbook: step routing, timers/devices, waits, guards, resume, analytics hooks.

(function () {
  /* ------------------------------ Defensive deps ------------------------------ */
  var eventBus = {
    emit: function () {},
    on: function () {},
    off: function () {},
  };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
  } catch (e) {}

  var logger = console;

  var config = {
    get: function (_p, fb) {
      return fb;
    },
    sabbathGuard: { enabled: false },
  };
  try {
    var cfg = require("@/services/config");
    if (cfg && typeof cfg.get === "function") config = cfg;
  } catch (_e) {}

  var analytics = { track: function () {}, event: function () {} };
  try {
    var an = require("@/services/analytics");
    analytics = (an && (an.default || an)) || analytics;
  } catch (_e) {}

  /* ----------------------------- Runbook Schema ------------------------------
    {
      id, title, domain: "meals"|"cleaning"|"animal"|"garden"|...,
      meta: { store, sabbathGuard, targetStartISO, resumeState? },
      guards?: { sabbathActive?:boolean, incompatibleChemicals?:{a,b}? },
      hazards?: string[], ppe?: string[],
      steps: [
        {
          id, label, type:"DEVICE"|"TIMER"|"MANUAL"|"POST"|"DELAY"|"REMINDER"|"NOTE"|"CHECKLIST"|"CHECK"|"LINKS"|"ALERTS",
          device?, timer?:{ minutes:number, label?:string }, delay?:{ minutes:number },
          reminder?:{ whenISO?:string, label?:string }, note?:{ text?:string },
          checklist?: string[], links?: Array<{label?:string,url?:string}>,
          wait?: boolean,
          backgroundOK?: boolean,           // new: allow non-blocking timers/delays even if wait=true
          startOffsetSec?: number,          // new: schedule offset for timers
          parallelizable?: boolean,         // if true, emit prep window
          emitAsPrepCandidate?: boolean,    // legacy compat
          onDone?: [{type:"NOTE",label:"..."}]
        }
      ],
      cleanup?: [...],
      logging?: [...]
    }
  ----------------------------------------------------------------------------- */

  /* ----------------------------- Internal State ------------------------------ */
  // id -> { runbook, idx, status, timers:{timerId:true}, createdISO, progress:{done,total}, lastTickISO }
  var SESSIONS = {};

  function nowISO() {
    return new Date().toISOString();
  }
  function clamp(n, a, b) {
    n = Number(n);
    return Math.max(a, Math.min(b, n));
  }
  function safeArr(x) {
    return Array.isArray(x) ? x : [];
  }
  function safeStr(x) {
    return x == null ? "" : String(x);
  }
  function shallowClone(obj) {
    var out = {};
    for (var k in obj || {})
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  }

  /* ------------------------------ Sabbath helpers ---------------------------- */
  function _cfgSabbath() {
    return (
      (config &&
        (config.sabbathGuard ||
          (config.get && config.get("sabbath.guard", { enabled: false })))) || {
        enabled: false,
      }
    );
  }
  function sabbathActiveFor(sess) {
    // effective if either runbook.meta.sabbathGuard OR global guard is enabled
    if (
      sess &&
      sess.runbook &&
      sess.runbook.meta &&
      sess.runbook.meta.sabbathGuard
    )
      return true;
    var g = _cfgSabbath();
    return !!(g && g.enabled);
  }

  /* ------------------------------- Event helpers ----------------------------- */
  function emit(evt, payload) {
    try {
      if (eventBus && eventBus.emit) eventBus.emit(evt, payload);
    } catch (e) {}
  }
  function on(evt, handler) {
    try {
      if (eventBus && eventBus.on) eventBus.on(evt, handler);
    } catch (e) {}
  }
  function off(evt, handler) {
    try {
      if (eventBus && eventBus.off) eventBus.off(evt, handler);
    } catch (e) {}
  }

  /* --------------------------------- Guards ---------------------------------- */
  function gateGuards(runbook) {
    var guards = (runbook && runbook.guards) || {};
    if (guards.sabbathActive) {
      emit("guard:sabbath", {
        runbookId: runbook.id,
        title: runbook.title,
        when: nowISO(),
      });
    }
    if (guards.incompatibleChemicals) {
      emit("guard:chem-incompatible", {
        runbookId: runbook.id,
        clash: guards.incompatibleChemicals,
        chemicals: (runbook.meta && runbook.meta.chemicals) || [],
      });
    }
  }

  /* --------------------------------- Hazards --------------------------------- */
  function gateHazards(runbook) {
    var hazards = (runbook && runbook.hazards) || [];
    var ppe = (runbook && runbook.ppe) || [];
    if (hazards.length) {
      emit("nba:hint", {
        type: "SAFETY",
        label: "Hazards: " + hazards.join(", "),
        runbookId: runbook.id,
      });
    }
    if (ppe.length) {
      emit("nba:hint", {
        type: "PPE",
        label: "PPE: " + ppe.join(", "),
        runbookId: runbook.id,
      });
    }
  }

  /* -------------------------------- Timers IO -------------------------------- */
  function buildTimerPayload(step, sessionId) {
    var mins = Number(step && step.timer && step.timer.minutes);
    if (!isFinite(mins) || mins <= 0) mins = 5;
    var so = Number(step && step.startOffsetSec);
    if (!isFinite(so) || so < 0) so = 0;
    return {
      id:
        sessionId +
        ":tmr:" +
        String((step && step.id) || Math.random().toString(36).slice(2)),
      groupId: sessionId,
      label:
        (step && step.timer && step.timer.label) ||
        (step && step.label) ||
        "Timer",
      minutes: clamp(mins, 1, 12 * 60),
      startOffsetSec: so,
    };
  }

  /* ----------------------------- Session lifecycle --------------------------- */
  function _calcTotalSteps(runbook) {
    return (runbook && runbook.steps && runbook.steps.length) || 0;
  }

  function createSession(runbook) {
    if (!runbook || !runbook.id) throw new Error("runbook.id required");
    var sess = {
      id: runbook.id,
      runbook: runbook,
      idx: 0,
      status: "READY", // READY -> RUNNING -> PAUSED -> DONE
      timers: {},
      createdISO: nowISO(),
      progress: { done: 0, total: _calcTotalSteps(runbook) },
      lastTickISO: null,
    };
    SESSIONS[sess.id] = sess;

    emit("session:created", {
      id: sess.id,
      title: runbook.title,
      domain: runbook.domain,
      ts: sess.createdISO,
    });

    gateGuards(runbook);
    gateHazards(runbook);

    analytics.track &&
      analytics.track("session/created", {
        id: runbook.id,
        domain: runbook.domain,
        minutes: Number(runbook.estimatedMinutes || 0) || null,
      });

    return sess;
  }

  function restoreOrCreate(runbook, resumeState) {
    var s = SESSIONS[runbook.id];
    if (s) return s;
    var sess = createSession(runbook);
    if (resumeState && typeof resumeState.index === "number") {
      sess.idx = clamp(resumeState.index, 0, _calcTotalSteps(runbook));
      sess.progress.done = clamp(resumeState.done || 0, 0, sess.progress.total);
    }
    return sess;
  }

  function currentStep(sess) {
    var steps = (sess.runbook && sess.runbook.steps) || [];
    if (sess.idx >= 0 && sess.idx < steps.length) return steps[sess.idx];
    return null;
  }

  function _computeProgress(sess) {
    sess.progress.total = _calcTotalSteps(sess.runbook);
    // done = steps strictly before current index
    sess.progress.done = clamp(sess.idx, 0, sess.progress.total);
  }

  function notify(sess) {
    _computeProgress(sess);
    var step = currentStep(sess);
    var payload = {
      id: sess.id,
      status: sess.status,
      index: sess.idx,
      total: sess.progress.total,
      step: step,
      domain: sess.runbook && sess.runbook.domain,
      hazards: (sess.runbook && sess.runbook.hazards) || [],
      ppe: (sess.runbook && sess.runbook.ppe) || [],
      guards: (sess.runbook && sess.runbook.guards) || {},
      progress: shallowClone(sess.progress),
      ts: nowISO(),
    };
    emit("session:progress", payload);
  }

  function advance(sess) {
    var steps = (sess.runbook && sess.runbook.steps) || [];
    if (sess.idx < steps.length - 1) {
      sess.idx += 1;
      notify(sess);
      return true;
    } else {
      sess.idx = steps.length;
      finalize(sess);
      return false;
    }
  }

  /* ---------------------------- Helper: wait policy --------------------------- */
  function shouldWaitAfter(step, sess) {
    // Base: explicit wait flag
    var wait = !!(step && step.wait);

    // TIMER/DELAY semantics:
    if (step && (step.type === "TIMER" || step.type === "DELAY")) {
      // If sabbath active -> never block (we preview timers)
      if (sabbathActiveFor(sess)) return false;
      // If backgroundOK, allow flow-through
      if (step.backgroundOK === true) return false;
      // default respect wait|true (or implicit wait for timers if wait is omitted)
      if (step.wait == null) wait = true;
    }

    // CHECKLIST/CHECK default to blocking only if wait=true
    // DEVICE/MANUAL/NOTE/REMINDER/LINKS/ALERTS respect explicit wait

    return wait;
  }

  /* ------------------------------- Step runners ------------------------------ */
  function doDevice(step, sess) {
    emit("device:command", {
      sessionId: sess.id,
      device: step.device || {},
      label: step.label,
    });
  }

  function _emitPrepWindow(step, sess) {
    var isCandidate = !!(
      step &&
      (step.emitAsPrepCandidate || step.parallelizable)
    );
    if (step && step.type === "TIMER" && isCandidate) {
      emit("prep:candidate", {
        runbookId: sess.id,
        windowMinutes: step.timer && step.timer.minutes,
        label: step.label || (step.timer && step.timer.label),
        domain: (sess.runbook && sess.runbook.domain) || "prep",
        area:
          (sess.runbook &&
            sess.runbook.meta &&
            (sess.runbook.meta.area || sess.runbook.meta.dish)) ||
          "",
      });
    }
  }

  function doTimer(step, sess) {
    var t = buildTimerPayload(step, sess.id);
    sess.timers[t.id] = true;

    _emitPrepWindow(step, sess);

    if (sabbathActiveFor(sess)) {
      // Respect Sabbath: preview timers but do not start; do not block progression.
      emit("multitimer:preview", { groupId: sess.id, timers: [t] });
    } else {
      emit("multitimer:start", { groupId: sess.id, timers: [t] });
    }
  }

  function doManual(step, sess) {
    emit("nba:hint", { type: "DO_NOW", label: step.label, sessionId: sess.id });
  }

  function doDelay(step, sess) {
    // Convert to a labeled timer for UI
    var minutes = Number(step && step.delay && step.delay.minutes);
    if (!isFinite(minutes) || minutes <= 0) minutes = 5;
    var so = Number(step && step.startOffsetSec);
    if (!isFinite(so) || so < 0) so = 0;

    var t = {
      id:
        sess.id +
        ":delay:" +
        String(step.id || Math.random().toString(36).slice(2)),
      groupId: sess.id,
      label: step && step.label ? step.label : "Delay",
      minutes: clamp(minutes, 1, 12 * 60),
      startOffsetSec: so,
    };
    if (sabbathActiveFor(sess)) {
      emit("multitimer:preview", { groupId: sess.id, timers: [t] });
    } else {
      sess.timers[t.id] = true;
      emit("multitimer:start", { groupId: sess.id, timers: [t] });
    }
  }

  function doReminder(step, sess) {
    var whenISO = (step && step.reminder && step.reminder.whenISO) || nowISO();
    emit("schedule:reminder:create", {
      id:
        sess.id +
        ":rem:" +
        String(step.id || Math.random().toString(36).slice(2)),
      title:
        (step && step.reminder && step.reminder.label) ||
        step.label ||
        "Reminder",
      when: whenISO,
      disabled: sabbathActiveFor(sess),
    });
  }

  function doNote(step, sess) {
    var text = (step && step.note && step.note.text) || step.label || "";
    emit("session:note", { sessionId: sess.id, label: text });
  }

  function doChecklist(step, sess) {
    // Non-blocking unless wait:true; individual items tracked via events
    emit("checklist:open", {
      sessionId: sess.id,
      stepId: step.id,
      title: step.label || "Checklist",
      items: safeArr(step.checklist),
    });
  }

  function doCheck(step, sess) {
    // A single confirmation check
    emit("check:prompt", {
      sessionId: sess.id,
      stepId: step.id,
      label: step.label || "Check",
    });
  }

  function doLinks(step, sess) {
    emit("links:open", {
      sessionId: sess.id,
      stepId: step.id,
      label: step.label || "Open Links",
      links: safeArr(step.links),
    });
  }

  function doAlerts(step, sess) {
    emit("alerts:show", {
      sessionId: sess.id,
      stepId: step.id,
      label: step.label || "Alerts",
      issues: safeArr(step.issues),
    });
  }

  function _runStep(step, sess) {
    var kind = (step && step.type) || "MANUAL";
    if (kind === "DEVICE") doDevice(step, sess);
    else if (kind === "TIMER") doTimer(step, sess);
    else if (kind === "MANUAL") doManual(step, sess);
    else if (kind === "POST") doManual(step, sess);
    else if (kind === "DELAY") doDelay(step, sess);
    else if (kind === "REMINDER") doReminder(step, sess);
    else if (kind === "NOTE") doNote(step, sess);
    else if (kind === "CHECKLIST") doChecklist(step, sess);
    else if (kind === "CHECK") doCheck(step, sess);
    else if (kind === "LINKS") doLinks(step, sess);
    else if (kind === "ALERTS") doAlerts(step, sess);
    else doManual(step, sess);
  }

  function stepRunner(sess) {
    if (!sess || sess.status !== "RUNNING") return;

    var step = currentStep(sess);
    if (!step) {
      finalize(sess);
      return;
    }

    _runStep(step, sess);

    var requiresWait = shouldWaitAfter(step, sess);
    if (!requiresWait) {
      // Fast-forward through consecutive non-wait steps (avoid long loops: cap burst)
      var burst = 0;
      while (sess.status === "RUNNING" && burst < 12) {
        if (!advance(sess)) break;
        var next = currentStep(sess);
        if (!next) break;
        _runStep(next, sess);
        if (shouldWaitAfter(next, sess)) break;
        burst += 1;
      }
    }
  }

  /* ------------------------------- Finalization ------------------------------ */
  function _applyOnDoneFor(step, sess) {
    var actions = step && step.onDone ? step.onDone : [];
    for (var a = 0; a < actions.length; a++) {
      var act = actions[a];
      if (act.type === "NOTE")
        emit("session:note", { sessionId: sess.id, label: act.label });
    }
  }

  function finalize(sess) {
    // Cleanup prompts
    var cl = sess.runbook && sess.runbook.cleanup ? sess.runbook.cleanup : [];
    for (var i = 0; i < cl.length; i++) {
      emit("nba:hint", {
        type: "CLEANUP",
        label: cl[i].label,
        sessionId: sess.id,
      });
    }

    // Logging actions (inventory deltas, harvest logs, feed logs, etc.)
    var logs = sess.runbook && sess.runbook.logging ? sess.runbook.logging : [];
    for (var j = 0; j < logs.length; j++) {
      emit("session:log", { sessionId: sess.id, entry: logs[j], ts: nowISO() });
    }

    sess.status = "DONE";
    notify(sess);
    // Unhook listeners
    off("multitimer:timer:done", onTimerDone);
    off("device:done", onDeviceDone);
    emit("session:done", { id: sess.id });

    analytics.track &&
      analytics.track("session/done", {
        id: sess.id,
        domain: sess.runbook && sess.runbook.domain,
      });
  }

  /* --------------------------------- Listeners ------------------------------- */
  function onTimerDone(ev) {
    // ev: { id, groupId? }
    var keys = Object.keys(SESSIONS);
    for (var i = 0; i < keys.length; i++) {
      var sess = SESSIONS[keys[i]];
      if (!sess || sess.status !== "RUNNING") continue;

      if (sess.timers && sess.timers[ev.id]) {
        delete sess.timers[ev.id];

        // If timer corresponds to current step, run onDone hooks
        var step = currentStep(sess);
        _applyOnDoneFor(step, sess);

        advance(sess);
        stepRunner(sess);
      }
    }
  }

  function onDeviceDone(ev) {
    // ev: { sessionId, stepId }
    var sess = SESSIONS[ev && ev.sessionId];
    if (!sess || sess.status !== "RUNNING") return;
    // device completions typically correspond to wait:true device steps
    // apply onDone for the matching step if at current index
    var step = currentStep(sess);
    if (step && step.id === ev.stepId) _applyOnDoneFor(step, sess);
    advance(sess);
    stepRunner(sess);
  }

  /* ------------------------------- Public API -------------------------------- */
  function createSession(runbook) {
    return restoreOrCreate(
      runbook,
      (runbook && runbook.meta && runbook.meta.resumeState) || null
    );
  }

  function start(sessId) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    if (sess.status === "DONE") return sess;
    sess.status = "RUNNING";
    notify(sess);
    stepRunner(sess);
    // hook listeners once session runs
    on("multitimer:timer:done", onTimerDone);
    on("device:done", onDeviceDone);
    return sess;
  }

  function pause(sessId) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    if (sess.status === "DONE") return sess;
    sess.status = "PAUSED";
    emit("multitimer:group:pause", { groupId: sess.id });
    notify(sess);
    return sess;
  }

  function resume(sessId) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    if (sess.status === "DONE") return sess;
    sess.status = "RUNNING";
    emit("multitimer:group:resume", { groupId: sess.id });
    notify(sess);
    stepRunner(sess);
    return sess;
  }

  function stop(sessId) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    sess.status = "DONE";
    emit("multitimer:stop", { groupId: sess.id });
    finalize(sess);
    return sess;
  }

  // Skip current step (advance by n, default 1)
  function skip(sessId, n) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    if (sess.status === "DONE") return sess;
    var count = clamp(n || 1, 1, 100);
    for (var i = 0; i < count; i++) {
      advance(sess);
    }
    if (sess.status !== "DONE") stepRunner(sess);
    return sess;
  }

  // Complete all remaining steps immediately
  function completeAll(sessId) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    if (sess.status === "DONE") return sess;
    // drain timers bookkeeping
    sess.timers = {};
    finalize(sess);
    return sess;
  }

  // Start from an arbitrary step index (sane bounds)
  function startAt(sessId, index) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    var total =
      (sess.runbook && sess.runbook.steps && sess.runbook.steps.length) || 0;
    sess.idx = clamp(index || 0, 0, total);
    if (sess.status === "READY") sess.status = "RUNNING";
    notify(sess);
    stepRunner(sess);
    return sess;
  }

  // Serialize a session's minimal resume state (for persistence in runbook.meta.resumeState)
  function getResumeState(sessId) {
    var sess = SESSIONS[sessId];
    if (!sess) return null;
    return {
      index: sess.idx,
      done: sess.progress && sess.progress.done,
      ts: nowISO(),
    };
  }

  /* --------------------------------- Exports --------------------------------- */
  module.exports = {
    createSession: createSession, // idempotent by runbook.id; honors meta.resumeState
    start: start,
    pause: pause,
    resume: resume,
    stop: stop,
    skip: skip,
    completeAll: completeAll,
    startAt: startAt,
    getResumeState: getResumeState, // <— new
    // internals for tests / tooling
    _internals: {
      buildTimerPayload: buildTimerPayload,
      stepRunner: stepRunner,
      currentStep: currentStep,
      sabbathActiveFor: sabbathActiveFor,
    },
  };
})();

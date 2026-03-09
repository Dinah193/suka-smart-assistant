/* eslint-disable no-console */
/**
 * PrepSessionOrchestrator.js
 * Runbook-capable orchestrator for start/resume/pause/end session glue.
 * Converts suggestions OR runbooks into:
 *  • batch session objects
 *  • step streams
 *  • multi-timer groups
 *  • lead-prep sub-sessions (defrost/marinate/proof/autolyse/etc.)
 *  • reminders + NBA hints
 *  • domain-aware event payloads (per shared catalog)
 *
 * Notes:
 *  - Emits only cataloged events and adds {domain} to relevant payloads:
 *      • "batch:session:create"            { session }
 *      • "schedule:session:create"         { id,title,start,end,metadata:{domain,type,parent} }
 *      • "prep:lead:sessions"              { count, anchorISO, sessions }
 *      • "prep:drawer:state"               DrawerState
 *      • "reminder:scheduled"              { runbookId, stepId, at, label, domain }
 *      • "multitimer:preview" | :start     { groupId, timers, meta:{sessionHint,domain} }
 *      • "prepstream:update"               Snapshot
 *      • "session:lifecycle"               { id, action: start|pause|resume|end, domain, atISO }
 *      • "planner.conflict.detected"       { kind, details, domain, atISO }
 *  - Honors Sabbath guard + withhold windows.
 *  - Infers lead-prep needs from natural language (incl. freshly milled flour → autolyse).
 */

(function () {
  /* ------------------------------ Defensive deps ------------------------------ */
  var logger = console;

  var eventBus = {
    emit: function () {},
    on: function () {},
    off: function () {},
  };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  var prepEngine = null; // optional
  try {
    prepEngine = require("@/engines/planning/prepConsolidationEngine");
  } catch (_e) {}

  var scheduleHelpers = null; // optional
  try {
    scheduleHelpers = require("@/engines/scheduling/scheduleHelpers");
  } catch (_e) {}

  var IngredientLinker = null; // optional
  try {
    IngredientLinker = require("@/engines/linkers/IngredientLinker");
  } catch (_e) {}

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

  var automation = {
    scheduleAt: function () {},
    scheduleAfter: function () {},
  };
  try {
    var autoSvc = require("@/services/automation");
    automation = (autoSvc && (autoSvc.default || autoSvc)) || automation;
  } catch (_e) {}

  var analytics = { track: function () {}, event: function () {} };
  try {
    var an = require("@/services/analytics");
    analytics = (an && (an.default || an)) || analytics;
  } catch (_e) {}

  var nba = { upsert: function () {}, clear: function () {} };
  try {
    var nbaSvc = require("@/services/nba");
    nba = (nbaSvc && (nbaSvc.default || nbaSvc)) || nba;
  } catch (_e) {}

  var prepBus = { emitCandidate: function () {} };
  try {
    var pb = require("@/engines/planning/prepBus");
    prepBus = (pb && (pb.default || pb)) || prepBus;
  } catch (_e) {}

  /* --------------------------------- Utilities -------------------------------- */
  function nowISO() {
    return new Date().toISOString();
  }
  function iso(d) {
    return (d instanceof Date ? d : new Date(d || Date.now())).toISOString();
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
  function uid(prefix) {
    return (prefix || "id") + ":" + Math.random().toString(36).slice(2, 10);
  }
  function asMinutes(v, fb) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : fb;
  }
  function addHours(dateLike, hrs) {
    var d = new Date(dateLike || Date.now());
    d.setHours(d.getHours() + Number(hrs || 0));
    return d;
  }
  function addDays(dateLike, days) {
    var d = new Date(dateLike || Date.now());
    d.setDate(d.getDate() + Number(days || 0));
    return d;
  }
  function shallowClone(obj) {
    var out = {};
    for (var k in obj || {})
      if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    return out;
  }
  function getDomain(x, fb) {
    return safeStr(
      (x && (x.domain || (x.meta && x.meta.domain))) || fb || "prep"
    );
  }

  /* ------------------------------ Domain UX toggles --------------------------- */
  var domainUX = {
    meals: { aisleHint: true, preheatReminders: true },
    cleaning: { ppeTip: true },
    garden: { uvHeatNotes: true },
    animal: { withdrawalNotes: true },
  };

  /* ------------------------------ Sabbath & withholds ------------------------- */
  function _cfgSabbath() {
    return (
      (config &&
        (config.sabbathGuard ||
          (config.get && config.get("sabbath.guard", { enabled: false })))) || {
        enabled: false,
      }
    );
  }
  function isSabbath(dateLike, options) {
    var opts = options || {};
    var sg = opts.sabbathGuard ? { enabled: true } : _cfgSabbath();
    if (!sg || !sg.enabled) return false;
    var d = new Date(dateLike || Date.now());
    return d.getDay() === 6; // Sat
  }
  function adjustForSabbath(dateLike, options) {
    var d = new Date(dateLike || Date.now());
    if (!isSabbath(d, options)) return d;
    var prev = addDays(d, -1);
    prev.setHours(12, 0, 0, 0);
    return prev;
  }
  function withholdActive(domainKey) {
    var windows =
      (config &&
        config.get &&
        config.get(domainKey + ".withholdWindows", [])) ||
      [];
    try {
      var now = new Date();
      var cur = now.getHours() * 60 + now.getMinutes();
      for (var i = 0; i < windows.length; i++) {
        var w = windows[i] || {};
        var pf = String(w.from || "00:00").split(":");
        var from = +pf[0] * 60 + (+pf[1] || 0);
        var pt = String(w.to || "00:00").split(":");
        var to = +pt[0] * 60 + (+pt[1] || 0);
        var spans = to < from;
        var within = spans
          ? cur >= from || cur <= to
          : cur >= from && cur <= to;
        if (within) return w.reason || "withhold";
      }
    } catch (_e) {}
    return null;
  }

  /* ------------------------- Input normalization (suggestion/runbook) --------- */
  // Accepts:
  //  - "suggestion-like": { id, title, domain?, tasks[], steps? }
  //  - "runbook": { id, title, domain, steps[], guards?, hazards?, ppe?, logging?, cleanup? }
  function normalizeToSuggestion(input) {
    if (!input)
      return { id: uid("sug"), title: "Session", domain: "prep", tasks: [] };

    var looksRunbook =
      Array.isArray(input.steps) && !!input.domain && !!input.title;
    if (!looksRunbook) return input; // already suggestion-like

    var sug = {
      id: input.id || uid("rb"),
      sessionId: input.id || null,
      title: input.title,
      domain: input.domain || "prep",
      steps: input.steps || [],
      checklist: null,
      meta: shallowClone(input.meta || {}),
    };
    if (input.guards && typeof input.guards === "object") {
      sug.meta.guards = shallowClone(input.guards);
    }
    if (Array.isArray(input.hazards)) sug.meta.hazards = input.hazards.slice(0);
    if (Array.isArray(input.ppe)) sug.meta.ppe = input.ppe.slice(0);
    if (Array.isArray(input.cleanup)) sug.meta.cleanup = input.cleanup.slice(0);
    if (Array.isArray(input.logging)) sug.meta.logging = input.logging.slice(0);

    return sug;
  }

  /* ------------------------- Normalization & timer building ------------------- */
  function toTimersFromSuggestion(sug, options) {
    var cfg = options || {};
    var timers = [];
    var overlapSec = Number(cfg.overlapSec || 60);
    var disabled = !!cfg.sabbathGuard;

    // Runbook-style TIMER steps
    var rbSteps = safeArr(sug && sug.steps);
    var haveRunbookTimers = false;
    for (var r = 0; r < rbSteps.length; r++) {
      var st = rbSteps[r] || {};
      if (
        String(st.type || "").toUpperCase() === "TIMER" &&
        st.timer &&
        st.timer.minutes
      ) {
        haveRunbookTimers = true;
        timers.push({
          id: "tmr:" + (st.id || uid("st")),
          label: safeStr(st.label || (st.timer && st.timer.label) || "Timer"),
          minutes: clamp(Number(st.timer.minutes) || 1, 1, 8 * 60),
          startOffsetSec: Number(st.startOffsetSec || r * overlapSec),
          domain: safeStr(sug.domain || "prep"),
          refId: st.id || null,
          disabled: disabled,
        });
      }
    }

    // Fallback: classic suggestion.tasks
    if (!haveRunbookTimers) {
      var tasks = safeArr(sug && sug.tasks);
      for (var i = 0; i < tasks.length; i++) {
        var t = tasks[i] || {};
        var mins = asMinutes(t.estMinutes || t.minutes || t.durationMin, 10);
        var startOffset = Number(t.startOffsetSec || i * overlapSec);
        timers.push({
          id: "tmr:" + (t.id || "t" + i),
          label: safeStr(t.title || t.label || "Task"),
          minutes: clamp(mins, 1, 8 * 60),
          startOffsetSec: Math.max(0, startOffset),
          domain: safeStr(sug.domain || t.domain || "prep"),
          refId: t.id || null,
          disabled: disabled,
        });
      }
    }
    return timers;
  }

  function naiveSessionFromSuggestion(sug) {
    var steps = [];
    var rbSteps = safeArr(sug && sug.steps);
    if (rbSteps.length) {
      for (var i = 0; i < rbSteps.length; i++) {
        var s = rbSteps[i] || {};
        steps.push({
          id: "step:" + (s.id || uid("st")),
          description: safeStr(s.label || s.description || "Step"),
          estimatedTime: asMinutes(
            (s.timer && s.timer.minutes) || s.minutes,
            5
          ),
          domain: safeStr(sug.domain || "prep"),
          checklist: safeArr(s.checklist),
          sourceSuggestionId: sug.id || null,
        });
      }
    } else {
      var tasks = safeArr(sug && sug.tasks);
      for (var t = 0; t < tasks.length; t++) {
        var tk = tasks[t] || {};
        steps.push({
          id: "step:" + (tk.id || uid("tk")),
          description: safeStr(tk.title || tk.label || "Step"),
          estimatedTime: asMinutes(tk.estMinutes || tk.minutes, 10),
          domain: safeStr(sug.domain || tk.domain || "prep"),
          checklist: safeArr(tk.checklist),
          sourceSuggestionId: sug.id || null,
        });
      }
    }

    return {
      id: sug.sessionId || "sess:" + (sug.id || uid("sug")),
      title: safeStr(sug.title || "Session"),
      createdAt: nowISO(),
      domain: safeStr(sug.domain || "prep"),
      steps: steps,
      meta: shallowClone(sug.meta || {}),
    };
  }

  function buildFromSuggestion(suggestion, options) {
    options = options || {};
    var session = null;

    if (prepEngine && typeof prepEngine.toBatchSession === "function") {
      try {
        session = prepEngine.toBatchSession(suggestion, options);
      } catch (e) {
        logger.warn(
          "[PrepSessionOrchestrator] prepEngine.toBatchSession failed; falling back",
          e
        );
      }
    }
    if (!session) session = naiveSessionFromSuggestion(suggestion);

    session.meta = session.meta || {};
    session.meta.store = options.store || session.meta.store || "Default";
    session.meta.sabbathGuard = !!(
      options.sabbathGuard ||
      (suggestion.meta &&
        suggestion.meta.guards &&
        suggestion.meta.guards.sabbathActive)
    );
    session.meta.origin = session.meta.origin || "PrepSessionOrchestrator";
    session.meta.type = session.meta.type || suggestion.type || "session";
    session.meta.resumeState =
      session.meta.resumeState || options.resumeState || null;
    session.meta.domain = session.meta.domain || session.domain;

    try {
      eventBus.emit("runbook:created", {
        session: session,
        domain: session.domain,
      });
      eventBus.emit("batch:session:create", {
        session: session,
        domain: session.domain,
      });
      analytics.track &&
        analytics.track("session/created", {
          id: session.id,
          domain: session.domain,
          store: session.meta.store,
        });
      eventBus.emit("nba:candidate", {
        kind: "session",
        id: session.id,
        title: session.title,
        cta: "Open Session",
        domain: session.domain,
        payload: { sessionId: session.id },
      });
      eventBus.emit("session:lifecycle", {
        id: session.id,
        action: "start",
        domain: session.domain,
        atISO: nowISO(),
      });
    } catch (_e) {}

    return session;
  }

  /* -------------------------- Lead-Prep Session Scheduler -------------------- */
  function detectLeadPrepNeeds(suggestion) {
    var needs = [];
    var tasks = safeArr(suggestion && suggestion.tasks);
    var checklistSteps = safeArr(
      suggestion && suggestion.checklist && suggestion.checklist.steps
    );
    var rbSteps = safeArr(suggestion && suggestion.steps);

    function consider(label, meta) {
      var title = safeStr(label || (meta && meta.title));
      var m = meta || {};
      var hours = Number(m.leadTimeHours || 0);
      var days = Number(m.leadTimeDays || 0);
      var inferred = false;

      if (!hours && !days) {
        var l = (title || "").toLowerCase();
        if (/overnight|12\s*h|twelve\s*hours|24\s*h|twenty[-\s]*four/.test(l)) {
          hours = 12;
          inferred = true;
        }
        if (/soak|soaking|beans|legume/.test(l)) {
          hours = Math.max(hours, 8);
          inferred = true;
        }
        if (/brine|brining|salt\s*water/.test(l)) {
          hours = Math.max(hours, 8);
          inferred = true;
        }
        if (/marinat(e|ing)/.test(l)) {
          hours = Math.max(hours, 4);
          inferred = true;
        }
        if (
          /ferment|proof|starter|levain|culture|kimchi|sauerkraut|yogurt/.test(
            l
          )
        ) {
          days = Math.max(days, 1);
          inferred = true;
        }
        if (/cure|dry\s*age|salt\s*rub\s*rest/.test(l)) {
          days = Math.max(days, 1);
          inferred = true;
        }
        if (/defrost|thaw/.test(l)) {
          hours = Math.max(hours, 12);
          inferred = true;
        }
        // Fresh-ground whole grain flour → autolyse / rest before knead
        if (
          /fresh(ly)?\s*(ground|milled)|whole\s*grain\s*flour|fresh\s*ground\s*flour/.test(
            l
          )
        ) {
          hours = Math.max(hours, 0.5); // 30 min autolyse default
          inferred = true;
          m.hint =
            (m.hint || "Autolyse") +
            " — let dough rest 20–40 min to hydrate bran.";
        }
        // Frozen fruit/veg for smoothies/stock → thaw
        if (/frozen\s*(fruit|veg|vegetable|berries)/.test(l)) {
          hours = Math.max(hours, 1);
          inferred = true;
        }
      }

      if (hours || days) {
        needs.push({
          id: uid("lead"),
          title: title || "Lead Prep",
          domain: m.domain || suggestion.domain || "prep",
          leadTimeHours: Number(hours || 0),
          leadTimeDays: Number(days || 0),
          inferred: inferred,
          source: "heuristic",
          meta: shallowClone(m),
        });
      }
    }

    for (var i = 0; i < tasks.length; i++)
      consider(tasks[i] && (tasks[i].title || tasks[i].label), tasks[i]);
    for (var j = 0; j < checklistSteps.length; j++)
      consider(
        checklistSteps[j] &&
          (checklistSteps[j].description || checklistSteps[j].label),
        checklistSteps[j]
      );
    for (var k = 0; k < rbSteps.length; k++)
      consider(
        rbSteps[k] && (rbSteps[k].label || rbSteps[k].description),
        rbSteps[k]
      );

    try {
      if (scheduleHelpers && scheduleHelpers.detectLeadPrep) {
        var extra = safeArr(scheduleHelpers.detectLeadPrep(suggestion));
        for (var m = 0; m < extra.length; m++) needs.push(extra[m]);
      }
    } catch (_e) {}

    return needs;
  }

  function scheduleLeadPrepSessions(suggestion, options) {
    options = options || {};
    var targetStartISO =
      options.targetStartISO || options.targetEventISO || options.atISO || null;
    var anchor = targetStartISO ? new Date(targetStartISO) : new Date();

    var needs = detectLeadPrepNeeds(suggestion);
    var created = [];

    for (var i = 0; i < needs.length; i++) {
      var n = needs[i];
      var totalHours =
        Number(n.leadTimeHours || 0) + Number(n.leadTimeDays || 0) * 24;
      if (!totalHours) continue;

      var startTime = addHours(anchor, -totalHours);
      if (startTime.getHours() < 7 || startTime.getHours() > 21)
        startTime.setHours(9, 0, 0, 0);
      var scheduledTime = adjustForSabbath(startTime, options);

      var withholdReason =
        withholdActive("sessions") || withholdActive(n.domain || "prep");
      if (withholdReason) {
        var bump = new Date(scheduledTime);
        bump.setHours(9, 0, 0, 0);
        scheduledTime = bump;
      }

      var leadSession = {
        id:
          "lead:" + (suggestion.id || uid("sug")) + ":" + (n.id || uid("need")),
        title: "Lead Prep – " + (n.title || "Prep"),
        domain: n.domain || "prep",
        createdAt: nowISO(),
        when: iso(scheduledTime),
        steps: [
          {
            id: "lead-step:" + (n.id || "0"),
            description: n.title || "Lead Prep",
            estimatedTime: Math.max(
              10,
              Math.min(180, totalHours >= 1 ? 30 : 15)
            ),
            domain: n.domain || "prep",
            meta: shallowClone(n.meta || {}),
          },
        ],
        meta: {
          type: "lead-prep",
          inferred: !!n.inferred,
          anchorISO: iso(anchor),
          leadTimeHours: totalHours,
          sabbathGuard: !!options.sabbathGuard,
          store: options.store || "Default",
          origin: "LeadPrepScheduler",
          parentSuggestionId: suggestion.id || null,
          domain: n.domain || "prep",
        },
      };

      try {
        eventBus.emit("batch:session:create", {
          session: leadSession,
          domain: leadSession.domain,
        });
        eventBus.emit("schedule:session:create", {
          id: leadSession.id,
          title: leadSession.title,
          start: leadSession.when,
          end: iso(addHours(scheduledTime, 1)),
          metadata: {
            domain: leadSession.domain,
            type: "lead-prep",
            parent: suggestion.id || null,
          },
          domain: leadSession.domain,
          disabled: !!options.sabbathGuard && isSabbath(scheduledTime, options),
        });
        eventBus.emit("nba:candidate", {
          kind: "lead-prep",
          id: leadSession.id,
          title: leadSession.title,
          cta: "Open Lead Prep",
          domain: leadSession.domain,
          payload: { sessionId: leadSession.id },
        });
        analytics.track &&
          analytics.track("lead_prep/scheduled", {
            id: leadSession.id,
            hours: totalHours,
            domain: leadSession.domain,
          });
      } catch (_e) {}

      try {
        if (scheduleHelpers) {
          var label = (n.title || "").toLowerCase();
          var dummyItem = { name: n.title };
          if (/defrost|thaw/.test(label) && scheduleHelpers.defrostReminder) {
            var r1 = scheduleHelpers.defrostReminder(dummyItem, scheduledTime);
            if (r1) {
              r1.domain = leadSession.domain;
              eventBus.emit("schedule:reminder:create", shallowClone(r1));
            }
          }
          if (/marinat/.test(label) && scheduleHelpers.marinateReminder) {
            var r2 = scheduleHelpers.marinateReminder(dummyItem, scheduledTime);
            if (r2) {
              r2.domain = leadSession.domain;
              eventBus.emit("schedule:reminder:create", shallowClone(r2));
            }
          }
          if (
            /autolyse|fresh/.test(label) &&
            scheduleHelpers.autolyseReminder
          ) {
            var r3 = scheduleHelpers.autolyseReminder(dummyItem, scheduledTime);
            if (r3) {
              r3.domain = leadSession.domain;
              eventBus.emit("schedule:reminder:create", shallowClone(r3));
            }
          }
          if (
            /proof|starter|levain/.test(label) &&
            scheduleHelpers.proofingReminder
          ) {
            var r4 = scheduleHelpers.proofingReminder(dummyItem, scheduledTime);
            if (r4) {
              r4.domain = leadSession.domain;
              eventBus.emit("schedule:reminder:create", shallowClone(r4));
            }
          }
        }
      } catch (_e) {}

      created.push(leadSession);
    }

    try {
      if (created.length) {
        eventBus.emit("prep:lead:sessions", {
          count: created.length,
          anchorISO: iso(anchor),
          sessions: created,
          domain: getDomain(suggestion),
        });
      }
    } catch (_e) {}

    return created;
  }

  /* --------------------------------- Reminders -------------------------------- */
  function emitRemindersFor(session, options) {
    if (!scheduleHelpers) return [];
    var out = [];
    try {
      for (var i = 0; i < session.steps.length; i++) {
        var s = session.steps[i];
        var desc = safeStr(s.description).toLowerCase();
        var isMeat = /meat|lamb|beef|chicken|poultry|fish/.test(desc);
        var isOven = /bake|roast|oven/.test(desc);
        var isBread =
          /(dough|bread|loaf|knead|mix flour|freshly\s*milled|fresh\s*ground\s*flour)/.test(
            desc
          );

        if (isMeat && scheduleHelpers.defrostReminder) {
          var df = scheduleHelpers.defrostReminder(
            { name: s.description },
            new Date()
          );
          if (df) {
            df.domain = session.domain;
            out.push(df);
          }
        }
        if (isMeat && scheduleHelpers.marinateReminder) {
          var mr = scheduleHelpers.marinateReminder(
            { name: s.description },
            new Date()
          );
          if (mr) {
            mr.domain = session.domain;
            out.push(mr);
          }
        }
        if (isOven && scheduleHelpers.preheatReminder) {
          var ph = scheduleHelpers.preheatReminder(
            { name: s.description },
            new Date()
          );
          if (ph) {
            ph.domain = session.domain;
            out.push(ph);
          }
        }
        if (isBread && scheduleHelpers.autolyseReminder) {
          var ar = scheduleHelpers.autolyseReminder(
            { name: s.description },
            new Date()
          );
          if (ar) {
            ar.domain = session.domain;
            out.push(ar);
          }
        }
        if (/proof|rise/.test(desc) && scheduleHelpers.proofingReminder) {
          var pr = scheduleHelpers.proofingReminder(
            { name: s.description },
            new Date()
          );
          if (pr) {
            pr.domain = session.domain;
            out.push(pr);
          }
        }
      }
    } catch (_e) {}

    for (var j = 0; j < out.length; j++) {
      try {
        var payload = shallowClone(out[j]);
        payload.disabled = !!options.sabbathGuard;
        payload.domain = payload.domain || session.domain;
        eventBus.emit("schedule:reminder:create", payload);
      } catch (_e) {}
    }
    return out;
  }

  /* ------------------------------- Timers ------------------------------------ */
  function startTimersForSuggestion(suggestion, options) {
    options = options || {};
    var timers = toTimersFromSuggestion(suggestion, options);

    try {
      for (var i = 0; i < timers.length; i++) {
        var tmr = timers[i];
        if (!tmr.disabled && tmr.minutes > 0) {
          var fireAt = new Date(
            Date.now() +
              Number(tmr.startOffsetSec || 0) * 1000 +
              tmr.minutes * 60000
          );
          automation.scheduleAt(iso(fireAt), {
            kind: "reminder",
            runbookId: suggestion.sessionId || suggestion.id || null,
            stepId: tmr.id,
            label: tmr.label,
            domain: getDomain(suggestion, tmr.domain),
          });
          eventBus.emit("reminder:scheduled", {
            runbookId: suggestion.sessionId || suggestion.id || null,
            stepId: tmr.id,
            at: iso(fireAt),
            label: tmr.label,
            domain: getDomain(suggestion, tmr.domain),
          });
          nba.upsert({
            kind: "window",
            domain: getDomain(suggestion, tmr.domain),
            runbookId: suggestion.sessionId || suggestion.id || null,
            stepId: tmr.id,
            label: "Use wait window wisely",
            priority: "info",
          });
        }
      }
    } catch (_e) {}

    var withhold =
      withholdActive("sessions") || withholdActive(getDomain(suggestion));
    if (options.sabbathGuard || options.dryRun || withhold) {
      try {
        eventBus.emit("multitimer:preview", {
          groupId: suggestion.id || uid("grp"),
          timers: timers,
          domain: getDomain(suggestion),
        });
      } catch (_e) {}
      return timers;
    }

    try {
      eventBus.emit("multitimer:start", {
        groupId: suggestion.id || uid("grp"),
        timers: timers,
        meta: {
          sessionHint: suggestion.sessionId || null,
          domain: getDomain(suggestion),
        },
        domain: getDomain(suggestion),
      });
      analytics.track &&
        analytics.track("timers/started", {
          count: timers.length,
          domain: getDomain(suggestion),
        });
    } catch (_e) {}
    return timers;
  }

  /* ------------------------------- Step streaming ---------------------------- */
  function streamNextSteps(suggestion, options) {
    options = options || {};
    var steps = (
      suggestion && suggestion.checklist
        ? suggestion.checklist.steps || []
        : safeArr(suggestion && suggestion.steps)
    ).slice();
    var cursor = 0;
    var listeners = [];
    var destroyed = false;
    var domain = getDomain(suggestion);

    function snapshot() {
      var total = steps.length;
      var idx = Math.min(cursor, total);
      var current = steps[idx] || null;
      return {
        total: total,
        index: idx,
        current: current,
        remaining: steps.slice(idx + 1),
        done: idx >= total,
        domain: domain,
        suggestionId: suggestion.id || null,
        sabbathGuard: !!options.sabbathGuard,
      };
    }

    function notify() {
      if (destroyed) return;
      var payload = snapshot();
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](payload);
        } catch (_e) {}
      }
      try {
        eventBus.emit("prepstream:update", payload);
      } catch (_e) {}
    }

    function onUpdate(cb) {
      if (typeof cb === "function") listeners.push(cb);
      notify();
      return function off() {
        for (var i = 0; i < listeners.length; i++)
          if (listeners[i] === cb) {
            listeners.splice(i, 1);
            break;
          }
      };
    }
    function advance() {
      if (cursor < steps.length) {
        cursor += 1;
        notify();
      }
    }
    function skip(n) {
      n = clamp(n || 1, 1, steps.length);
      cursor = clamp(cursor + n, 0, steps.length);
      notify();
    }
    function back(n) {
      n = clamp(n || 1, 1, steps.length);
      cursor = clamp(cursor - n, 0, steps.length);
      notify();
    }
    function completeAll() {
      cursor = steps.length;
      notify();
    }

    function handleDone() {
      advance();
    }
    function handleGroupPaused() {
      notify();
    }
    function handleGroupResumed() {
      notify();
    }

    try {
      eventBus.on && eventBus.on("multitimer:timer:done", handleDone);
      eventBus.on && eventBus.on("multitimer:group:paused", handleGroupPaused);
      eventBus.on &&
        eventBus.on("multitimer:group:resumed", handleGroupResumed);
    } catch (_e) {}

    function destroy() {
      destroyed = true;
      try {
        eventBus.off && eventBus.off("multitimer:timer:done", handleDone);
        eventBus.off &&
          eventBus.off("multitimer:group:paused", handleGroupPaused);
        eventBus.off &&
          eventBus.off("multitimer:group:resumed", handleGroupResumed);
      } catch (_e) {}
      listeners = [];
    }

    return {
      onUpdate: onUpdate,
      advance: advance,
      skip: skip,
      back: back,
      completeAll: completeAll,
      destroy: destroy,
    };
  }

  /* ------------------------------ Conflict detection ------------------------- */
  function detectAndEmitConflicts(suggestion, options) {
    try {
      if (
        !scheduleHelpers ||
        typeof scheduleHelpers.detectConflicts !== "function"
      )
        return [];
      var conflicts = safeArr(
        scheduleHelpers.detectConflicts(suggestion, options)
      );
      var domain = getDomain(suggestion);
      for (var i = 0; i < conflicts.length; i++) {
        var c = conflicts[i] || {};
        // kinds: time | appliance | weather | biohazard
        eventBus.emit("planner.conflict.detected", {
          kind: c.kind || "time",
          details: c.details || {},
          domain: domain,
          atISO: nowISO(),
        });
      }
      return conflicts;
    } catch (_e) {
      return [];
    }
  }

  /* ------------------------------- Drawer state ------------------------------ */
  function buildDrawerState(session, suggestion) {
    var timers = toTimersFromSuggestion(suggestion || {}, {
      overlapSec: 60,
      sabbathGuard: !!(session.meta && session.meta.sabbathGuard),
    });
    var current = (session.steps && session.steps[0]) || null;

    var aisle = null;
    try {
      if (
        IngredientLinker &&
        IngredientLinker.mapAisleHint &&
        domainUX[session.domain] &&
        domainUX[session.domain].aisleHint
      ) {
        var tags = (session.meta && session.meta.tags) || [];
        aisle = IngredientLinker.mapAisleHint(tags, session.title || "");
      }
    } catch (_e) {}

    var totalMin = 0;
    for (var i = 0; i < timers.length; i++)
      totalMin += Number(timers[i].minutes || 0);
    var eta = totalMin ? iso(addHours(Date.now(), totalMin / 60)) : null;

    return {
      sessionId: session.id,
      title: session.title,
      domain: session.domain || "prep",
      store: (session.meta && session.meta.store) || "Default",
      sabbathGuard: !!(session.meta && session.meta.sabbathGuard),
      aisleHint: aisle,
      timersPreview: timers,
      stepNow: current,
      stepCount: (session.steps && session.steps.length) || 0,
      nextSteps: (session.steps || []).slice(1, 4),
      etaISO: eta,
      progress: {
        done: 0,
        total: (session.steps && session.steps.length) || 0,
      },
      hazards: (session.meta && session.meta.hazards) || [],
      ppe: (session.meta && session.meta.ppe) || [],
      guards: (session.meta && session.meta.guards) || {},
    };
  }

  /* --------------------------------- Orchestrate ----------------------------- */
  function orchestrate(suggestionLike, options) {
    options = options || {};
    var domain = getDomain(suggestionLike);

    // 1) create main session
    var session = buildFromSuggestion(suggestionLike, options);

    // 2) schedule lead-prep sessions
    var leadSessions = scheduleLeadPrepSessions(suggestionLike, options);

    // 3) timers for current suggestion
    var timers = startTimersForSuggestion(suggestionLike, options);

    // 4) step stream
    var stream = streamNextSteps(suggestionLike, options);

    // 5) inline reminders for the main session
    var reminders = emitRemindersFor(session, options);

    // 6) conflicts (time|appliance|weather|biohazard)
    var conflicts = detectAndEmitConflicts(suggestionLike, options);

    // 7) drawer state
    var drawerState = buildDrawerState(session, suggestionLike);
    try {
      eventBus.emit("prep:drawer:state", shallowClone(drawerState));
    } catch (_e) {}

    // NBA hint: “resume later” for paused windows
    try {
      nba.upsert({
        kind: "hint",
        domain: domain,
        runbookId: session.id,
        label: "Session controls available (pause/resume/end)",
        priority: "low",
      });
    } catch (_e) {}

    return {
      session: session,
      leadSessions: leadSessions,
      timers: timers,
      stream: stream,
      reminders: reminders,
      conflicts: conflicts,
      drawerState: drawerState,
    };
  }

  /* --------------------------- Lifecycle controls ---------------------------- */
  function pause(sessionId, meta) {
    try {
      eventBus.emit("multitimer:group:pause", {
        groupId: sessionId,
        domain: getDomain(meta),
      });
      eventBus.emit("session:lifecycle", {
        id: sessionId,
        action: "pause",
        domain: getDomain(meta),
        atISO: nowISO(),
      });
      nba.upsert({
        kind: "window",
        domain: getDomain(meta),
        runbookId: sessionId,
        label: "Session paused — we’ll remind you about in-progress timers",
        priority: "info",
      });
    } catch (_e) {}
  }

  function resume(sessionId, meta) {
    try {
      eventBus.emit("multitimer:group:resume", {
        groupId: sessionId,
        domain: getDomain(meta),
      });
      eventBus.emit("session:lifecycle", {
        id: sessionId,
        action: "resume",
        domain: getDomain(meta),
        atISO: nowISO(),
      });
      nba.upsert({
        kind: "action",
        domain: getDomain(meta),
        runbookId: sessionId,
        label: "Back to it — next steps loaded",
        priority: "normal",
      });
    } catch (_e) {}
  }

  function end(sessionId, meta) {
    try {
      eventBus.emit("multitimer:group:stop", {
        groupId: sessionId,
        domain: getDomain(meta),
      });
      eventBus.emit("batch:session:end", {
        id: sessionId,
        domain: getDomain(meta),
        atISO: nowISO(),
      });
      eventBus.emit("session:lifecycle", {
        id: sessionId,
        action: "end",
        domain: getDomain(meta),
        atISO: nowISO(),
      });
      if (nba && typeof nba.clear === "function") {
        try {
          nba.clear({ runbookId: sessionId, domain: getDomain(meta) });
        } catch (_e) {}
      }
      analytics.track &&
        analytics.track("session/ended", {
          id: sessionId,
          domain: getDomain(meta),
        });
    } catch (_e) {}
  }

  /* --------------------------- Convenience entry points ---------------------- */
  function orchestrateSuggestion(suggestion, opts) {
    return orchestrate(suggestion, opts || {});
  }

  function orchestrateRunbook(runbook, opts) {
    var suggestionLike = normalizeToSuggestion(runbook);
    return orchestrate(suggestionLike, opts || {});
  }

  function orchestrateAny(input, opts) {
    var looksRunbook =
      input &&
      Array.isArray(input.steps) &&
      !!input.domain &&
      !!input.title &&
      (input.meta || input.guards || input.hazards);
    return looksRunbook
      ? orchestrateRunbook(input, opts)
      : orchestrateSuggestion(input, opts);
  }

  /* --------------------------------- Exports --------------------------------- */
  module.exports = {
    // main
    orchestrateAny: orchestrateAny,
    orchestrateRunbook: orchestrateRunbook,
    orchestrate: orchestrateSuggestion, // legacy alias

    // lifecycle glue
    pause: pause,
    resume: resume,
    end: end,

    // building blocks
    buildFromSuggestion: buildFromSuggestion,
    startTimersForSuggestion: startTimersForSuggestion,
    streamNextSteps: streamNextSteps,

    // exposed for tests
    _internals: {
      detectLeadPrepNeeds: detectLeadPrepNeeds,
      scheduleLeadPrepSessions: scheduleLeadPrepSessions,
      isSabbath: isSabbath,
      adjustForSabbath: adjustForSabbath,
      toTimersFromSuggestion: toTimersFromSuggestion,
      normalizeToSuggestion: normalizeToSuggestion,
      detectAndEmitConflicts: detectAndEmitConflicts,
      buildDrawerState: buildDrawerState,
    },
  };
})();

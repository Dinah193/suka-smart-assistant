/* eslint-disable no-console */
/**
 * onPrepTasksRequested.js — dynamic orchestration for PREP task generation (ES2015-safe)
 *
 * Listens for (aliases normalized by eventAliases middleware):
 *   - "prep.tasks.requested"
 *
 * Emits (via unified events hub):
 *   - "workprep.consolidated"          // after coalescing overlapping prep
 *   - "prep.tasks.generated"           // after building tasks
 *   - "reminder.schedule.requested"    // to ReminderManager/Automations
 *   - "calendar.event.requested"       // optional UI calendar paint
 *   - "nba.updated"                    // Next Best Action prompts (immediate/do-now)
 *
 * Cross-domain: cooking, cleaning, animals (care & butchery), garden
 * Features:
 *   - Shared orchestration ready (uses @/automation/events + @/services/eventAliases)
 *   - Session-aware: supports relative-to-session start & pause-aware shifting
 *   - Coalescing: merges preheats (same appliance/window), and shared marinades/soaks/proofs
 *   - Sabbath Guard: shifts tasks outside blocked window
 *   - Withhold/chill-chain guardrails (soft checks)
 *   - Defensive imports & no-crash fallbacks
 *   - Timezone-safe; degrades to local if tz not available
 *   - “Do now” NBA for overdue/near-due prep
 */

(function () {
  // ----------------------------- Safe Imports -----------------------------
  function prefer(mod, keys) {
    if (!mod) return {};
    if (!keys) return (mod.default || mod);
    var picked = {};
    keys.forEach(function (k) {
      if (mod[k]) picked[k] = mod[k];
      else if (mod.default && mod.default[k]) picked[k] = mod.default[k];
    });
    return picked;
  }

  var Events = {};
  var EventsHub = {};
  try {
    EventsHub = require("@/automation/events") || {};
    if (!EventsHub || !EventsHub.emit || !EventsHub.on) {
      EventsHub = require("@/automation/events/index") || EventsHub;
    }
    Events = (EventsHub && (EventsHub.Events || (EventsHub.default && EventsHub.default.Events))) || {};
  } catch (e) {}

  var eventAliases = {};
  try { eventAliases = require("@/services/eventAliases") || {}; } catch (e) {}

  var ReminderManager = { schedule: function () {} };
  try { ReminderManager = prefer(require("@/managers/ReminderManager"), ["schedule"]); } catch (e) {}

  var InventoryMonitor = { notes: function () { return {}; } };
  try { InventoryMonitor = prefer(require("@/managers/InventoryMonitor"), ["notes"]); } catch (e) {}

  var SessionStore = { getById: function () { return null; } };
  try { SessionStore = prefer(require("@/stores/SessionStore"), ["getById"]); } catch (e) {}

  var SettingsStore = { get: function () { return {}; } };
  try { SettingsStore = prefer(require("@/stores/SettingsStore"), ["get"]); } catch (e) {}

  var PrepTemplateLibrary = { normalizeItem: function (x) { return x; } };
  try { PrepTemplateLibrary = prefer(require("@/libraries/PrepTemplateLibrary"), ["normalizeItem"]); } catch (e) {}

  // Fallback event emit/on if hub missing (no-op safe)
  var emit = (EventsHub && EventsHub.emit) ? EventsHub.emit : function () {};
  var on = (EventsHub && EventsHub.on) ? EventsHub.on : function () {};

  var DEV = true;

  // ----------------------------- Utilities --------------------------------
  function uuid() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  function nowMs() { return Date.now(); }
  function safeDate(input) {
    if (!input) return new Date();
    if (input instanceof Date) return input;
    var d = new Date(input);
    return isNaN(d.getTime()) ? new Date() : d;
  }
  function toMs(v, unit) {
    if (v == null) return 0;
    var n = Number(v) || 0, H = 3600000, M = 60000;
    switch (unit) { case "hours": case "hour": return n * H; case "minutes": case "minute": return n * M; default: return n; }
  }
  function withinWindow(aStart, aEnd, bStart, bEnd) { return (aStart <= bEnd) && (bStart <= aEnd); }
  function clamp(n, min, max){ return Math.max(min, Math.min(max, n)); }
  function toArray(x){ return Array.isArray(x) ? x : (x == null ? [] : [x]); }

  function getSetting(key, fallback) {
    try { if (SettingsStore && SettingsStore.get) { var v = SettingsStore.get(key); return (v == null ? fallback : v); } }
    catch (e) {}
    return fallback;
  }

  function applySabbathGuard(dt, options) {
    try {
      var guard = (options && options.sabbathGuard);
      if (guard == null) guard = getSetting("sabbathGuard", false);
      if (!guard) return dt;

      // Basic Fri 18:00 → Sat 18:00 local block (can be replaced by Calendar integration upstream)
      var d = new Date(dt.getTime());
      var ref = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18, 0, 0, 0);
      var diffToFri = (5 - d.getDay()); // days until Friday
      var fri = new Date(ref.getTime() + diffToFri * 86400000);
      var sat = new Date(fri.getTime() + 86400000);
      var inBlock = (d >= fri && d < sat) || (d.getDay() === 6 && d.getHours() < 18);
      if (!inBlock) return dt;
      return new Date(fri.getTime() - 15 * 60000); // shift just before block
    } catch (e) { return dt; }
  }

  function withinGuardrails(task) {
    // Soft checks only; engines downstream can hard-enforce
    try {
      var c = task && task.meta && task.meta.constraints || {};
      // withholdMinutes → don't start earlier than scheduledAt - withhold
      if (c.withholdMinutes && task.scheduledAt) {
        var latestStart = task.scheduledAt - toMs(c.withholdMinutes, "minutes");
        if ((nowMs() - latestStart) > 0) return false;
      }
      // chillChain.maxMinutesOut → keep short estimatedMs if raw meat
      if (c.chillChain && c.chillChain.maxMinutesOut && /raw|meat|butcher/i.test(task.title || "")) {
        var cap = toMs(c.chillChain.maxMinutesOut, "minutes");
        task.estimatedMs = Math.min(task.estimatedMs || 10*60000, cap);
      }
      return true;
    } catch (e) { return true; }
  }

  // Merge items with same key where windows overlap
  function coalesceByKey(tasks, key, windowMs) {
    var merged = [];
    var buckets = {};

    tasks.forEach(function (t) {
      var k = (t.meta && t.meta[key]) || null;
      if (!k) return merged.push(t);
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(t);
    });

    Object.keys(buckets).forEach(function (k) {
      var arr = buckets[k].sort(function (a,b){ return a.scheduledAt - b.scheduledAt; });
      var i = 0;
      while (i < arr.length) {
        var cur = arr[i];
        var start = cur.scheduledAt;
        var end = cur.scheduledAt + (cur.estimatedMs || 0);
        var group = [cur];
        var j = i + 1;
        while (j < arr.length) {
          var next = arr[j];
          var nStart = next.scheduledAt;
          var nEnd = next.scheduledAt + (next.estimatedMs || 0);
          if (withinWindow(start - windowMs, end + windowMs, nStart, nEnd)) {
            group.push(next);
            start = Math.min(start, nStart);
            end = Math.max(end, nEnd);
            j++;
          } else break;
        }

        if (group.length === 1) {
          merged.push(group[0]);
        } else {
          var combined = {
            id: uuid(),
            kind: "prep",
            title: "Coalesced: " + (group[0].meta && group[0].meta[key]) + " (" + group.length + ")",
            description: "Combined prep: " + group.map(function (x){ return x.title; }).join(", "),
            scheduledAt: start,
            estimatedMs: Math.max(10 * 60000, end - start),
            domain: group[0].domain || "cooking",
            sessionId: group[0].sessionId || null,
            planId: group[0].planId || null,
            tags: Array.from(new Set((group[0].tags || []).concat(["coalesced"]))),
            meta: (function(){
              var base = group[0].meta || {};
              base.coalescedKey = key;
              base.coalescedCount = group.length;
              base.children = group.map(function (x){ return x.id; });
              return base;
            })()
          };
          merged.push(combined);
        }
        i = j;
      }
    });

    return merged;
  }

  // ----------------------------- Core Builder -----------------------------
  /**
   * Item (normalized):
   * {
   *   id, title, domain, neededBy (Date/string),
   *   leadTimes: { defrostHours, marinateHours, soakHours, proofHours, temperMinutes, preheatMinutes, sanitizeMinutes },
   *   resources: { appliance:"oven|smoker|dehydrator|grill", vessel, ppe:[] },
   *   constraints: { withholdMinutes, chillChain:{ maxMinutesOut } },
   *   meta: { marinadeId, soakId, proofGroupKey, preheatGroupKey, relativeMs?, ... }
   * }
   */
  function buildPrepTasksForItem(item, ctx) {
    var out = [];
    var neededBy = safeDate(item.neededBy);
    var lead = item.leadTimes || {};
    var domain = item.domain || ctx.source || "cooking";
    var base = {
      domain: domain,
      sessionId: ctx.sessionId || null,
      planId: ctx.planId || null,
      tags: ["prep", domain]
    };

    function pushTask(title, minutes, meta) {
      if (!minutes || minutes <= 0) return;
      var scheduledAt = neededBy.getTime() - toMs(minutes, "minutes");
      var durMin = clamp(minutes, 5, 180);
      var task = Object.assign({}, base, {
        id: uuid(),
        kind: "prep",
        title: title,
        description: (item.title ? ("For: " + item.title) : title),
        scheduledAt: scheduledAt,
        estimatedMs: toMs(durMin, "minutes"),
        meta: Object.assign({}, item.meta || {}, meta || {})
      });
      if (item.constraints) {
        task.meta.constraints = Object.assign({}, item.constraints);
      }
      out.push(task);
    }

    // Cooking
    if (lead.defrostHours)  pushTask("Defrost", lead.defrostHours * 60, { type: "defrost" });
    if (lead.marinateHours) pushTask("Marinate", lead.marinateHours * 60, { type: "marinate", marinadeId: (item.meta && item.meta.marinadeId) || item.id });
    if (lead.soakHours)     pushTask("Soak", lead.soakHours * 60,       { type: "soak",    soakId: (item.meta && item.meta.soakId) || item.id });
    if (lead.proofHours)    pushTask("Proof", lead.proofHours * 60,     { type: "proof",   proofGroupKey: (item.meta && item.meta.proofGroupKey) || item.id });
    if (lead.temperMinutes) pushTask("Temper", lead.temperMinutes,      { type: "temper" });
    if (lead.preheatMinutes) {
      var appliance = (item.meta && item.meta.preheatGroupKey) || (item.resources && item.resources.appliance) || "oven";
      pushTask("Preheat " + appliance, lead.preheatMinutes, { type: "preheat", preheatGroupKey: appliance, appliance: appliance });
    }
    if (lead.sanitizeMinutes) pushTask("Sanitize & Stage PPE", lead.sanitizeMinutes, { type: "sanitize" });

    // Cleaning domain (pre-soak, chemical dwell, PPE stage)
    if (domain === "cleaning") {
      if (lead.soakHours && !lead.sanitizeMinutes) pushTask("Pre-soak surfaces", lead.soakHours * 60, { type: "soak", soakId: (item.meta && item.meta.soakId) || item.id });
      if (lead.sanitizeMinutes) pushTask("Stage PPE & Sanitizer", lead.sanitizeMinutes, { type: "sanitize" });
    }

    // Animals domain (butchery/cold chain)
    if (domain === "animals") {
      if (lead.defrostHours) pushTask("Thaw per chill chain", lead.defrostHours * 60, { type: "defrost" });
      if (lead.sanitizeMinutes) pushTask("Sterilize tools & PPE", lead.sanitizeMinutes, { type: "sanitize" });
    }

    // Garden domain (seed soak, pre-sprout)
    if (domain === "garden") {
      if (lead.soakHours) pushTask("Soak seeds", lead.soakHours * 60, { type: "soak", soakId: (item.meta && item.meta.soakId) || item.id });
    }

    return out;
  }

  function normalizeIncomingItem(raw) {
    try { raw = (PrepTemplateLibrary && PrepTemplateLibrary.normalizeItem) ? (PrepTemplateLibrary.normalizeItem(raw) || raw) : raw; } catch (e) {}
    var lead = raw.leadTimes || {};
    var meta = raw.meta || {};
    var resources = raw.resources || {};
    return {
      id: raw.id || uuid(),
      title: raw.title || raw.name || "Untitled",
      domain: raw.domain || raw.source || "cooking",
      neededBy: raw.neededBy || raw.when || raw.targetTime || new Date(),
      leadTimes: {
        defrostHours: +lead.defrostHours || 0,
        marinateHours: +lead.marinateHours || 0,
        soakHours: +lead.soakHours || 0,
        proofHours: +lead.proofHours || 0,
        temperMinutes: +lead.temperMinutes || 0,
        preheatMinutes: +lead.preheatMinutes || 0,
        sanitizeMinutes: +lead.sanitizeMinutes || 0
      },
      resources: {
        appliance: resources.appliance || null,
        vessel: resources.vessel || null,
        ppe: Array.isArray(resources.ppe) ? resources.ppe : (resources.ppe ? [resources.ppe] : [])
      },
      constraints: raw.constraints || {},
      meta: meta
    };
  }

  // ----------------------------- Orchestrator -----------------------------
  function handlePrepTasksRequested(envelope) {
    // Envelope shape from events hub: { topic, payload, sessionId?, correlationId?, ... }
    var env = (eventAliases && eventAliases.canonicalizeEnvelope) ? eventAliases.canonicalizeEnvelope(envelope) : (envelope || {});
    if (!env || (env.topic !== "prep.tasks.requested" && env.type !== "prep.tasks.requested")) return;

    var payload = env.payload || {};
    var items = Array.isArray(payload.items) ? payload.items : [];
    var sessionId = payload.sessionId || env.sessionId || null;
    var planId = payload.planId || null;
    var source = payload.source || "cooking";
    var options = payload.options || {};

    // Resolve session anchor for relative scheduling & pause-aware adjustments
    var session = null;
    try { if (sessionId && SessionStore.getById) session = SessionStore.getById(sessionId) || null; } catch (e) {}

    // Normalize
    var normalized = items.map(normalizeIncomingItem);

    // Build raw tasks
    var ctx = { sessionId: sessionId, planId: planId, source: source };
    var allTasks = normalized.reduce(function (acc, it) { return acc.concat(buildPrepTasksForItem(it, ctx)); }, []);

    // Relative-to-session handling
    if (payload.relativeToSessionStart && session && session.start) {
      var startMs = safeDate(session.start).getTime();
      allTasks = allTasks.map(function (t) {
        var rel = (t.meta && typeof t.meta.relativeMs === "number") ? t.meta.relativeMs : null;
        if (rel != null) t.scheduledAt = startMs + rel - (t.estimatedMs || 0);
        return t;
      });
    }

    // Pause-aware shift: if session paused and tasks fall inside pause, bump to resume
    if (session && session.state === "paused" && session.resumeAt) {
      var resume = safeDate(session.resumeAt).getTime();
      allTasks = allTasks.map(function (t) {
        if (t.scheduledAt < resume) t.scheduledAt = resume;
        return t;
      });
    }

    // Sabbath Guard
    allTasks = allTasks.map(function (t) {
      var shifted = applySabbathGuard(new Date(t.scheduledAt), options);
      t.scheduledAt = shifted.getTime();
      return t;
    });

    // Coalesce: preheats + liquids (soak/proof/marinate)
    var preheats = allTasks.filter(function (t){ return t.meta && t.meta.type === "preheat"; });
    var rest = allTasks.filter(function (t){ return !t.meta || t.meta.type !== "preheat"; });

    var soaks = rest.filter(function (t){ return t.meta && t.meta.type === "soak"; });
    var proofs = rest.filter(function (t){ return t.meta && t.meta.type === "proof"; });
    var marinades = rest.filter(function (t){ return t.meta && t.meta.type === "marinate"; });
    var others = rest.filter(function (t){ return !t.meta || ["soak","proof","marinate"].indexOf(t.meta.type) === -1; });

    var preheatWindow = toMs(getSetting("prep.preheatCoalesceWindowMin", 10), "minutes");
    var liquidWindow  = toMs(getSetting("prep.liquidCoalesceWindowMin", 20), "minutes");
    var marinadeWindow= toMs(getSetting("prep.marinadeCoalesceWindowMin", 30), "minutes");

    var mergedPreheats  = coalesceByKey(preheats,  "preheatGroupKey", preheatWindow);
    var mergedSoaks     = coalesceByKey(soaks,     "soakId",          liquidWindow);
    var mergedProofs    = coalesceByKey(proofs,    "proofGroupKey",   liquidWindow);
    var mergedMarinades = coalesceByKey(marinades, "marinadeId",      marinadeWindow);

    var coalesced = []
      .concat(mergedPreheats)
      .concat(mergedSoaks)
      .concat(mergedProofs)
      .concat(mergedMarinades)
      .concat(others)
      .filter(withinGuardrails);

    // Sort by time
    coalesced.sort(function (a,b){ return a.scheduledAt - b.scheduledAt; });

    // Emit consolidated (UI: Work Prep Consolidation bar, analytics)
    try {
      emit(Events.ANY || "workprep.consolidated", {
        source: source,
        sessionId: sessionId,
        planId: planId,
        tasks: coalesced
      }, { topic: "workprep.consolidated" });
    } catch (e) {}

    // NBA “do now” prompts for tasks due ≤ 10 min
    var now = nowMs();
    var horizonMin = getSetting("prep.immediateWindowMin", 10);
    var immediate = coalesced.filter(function (t) { return (t.scheduledAt - now) <= toMs(horizonMin, "minutes"); });

    if (immediate.length) {
      try {
        emit(Events.NBA_UPDATED || "nba.updated", {
          scope: { sessionId: sessionId, planId: planId, source: source },
          suggestions: immediate.map(function (t) {
            return {
              id: "nba:" + t.id,
              label: "Start: " + t.title,
              when: new Date(Math.max(t.scheduledAt, now)).toISOString(),
              action: { type: "prep.task.begin", payload: { taskId: t.id, sessionId: sessionId, planId: planId } },
              badges: ["prep", source]
            };
          })
        }, { topic: "nba.updated" });
      } catch (e) {}
    }

    // Fan-out: reminders + calendar paint
    coalesced.forEach(function (t) {
      // Reminder schedule
      var reminderPayload = {
        id: "reminder:" + t.id,
        title: t.title,
        message: t.description || t.title,
        when: new Date(t.scheduledAt).toISOString(),
        context: {
          sessionId: t.sessionId,
          planId: t.planId,
          domain: t.domain,
          tags: t.tags || [],
          meta: t.meta || {}
        },
        channels: toArray(getSetting("notifications.channelsDefault", ["toast","modal"])),
        priority: "normal"
      };

      try {
        if (ReminderManager && typeof ReminderManager.schedule === "function") {
          ReminderManager.schedule(Object.assign({}, reminderPayload, { when: new Date(t.scheduledAt) }));
        } else {
          emit("reminder.schedule.requested", reminderPayload, { topic: "reminder.schedule.requested" });
        }
      } catch (e) {}

      // Calendar paint (optional)
      try {
        emit("calendar.event.requested", {
          title: "Prep: " + t.title,
          start: new Date(t.scheduledAt).toISOString(),
          end: new Date(t.scheduledAt + (t.estimatedMs || 10*60000)).toISOString(),
          domain: t.domain,
          sessionId: t.sessionId,
          planId: t.planId,
          tags: t.tags || []
        }, { topic: "calendar.event.requested" });
      } catch (e) {}
    });

    // Announce generated
    try {
      emit("prep.tasks.generated", {
        source: source,
        sessionId: sessionId,
        planId: planId,
        count: coalesced.length,
        tasks: coalesced
      }, { topic: "prep.tasks.generated" });
    } catch (e) {}

    if (DEV) try { console.debug("[prep] generated:", coalesced.length); } catch (e) {}
  }

  // ----------------------------- Registration -----------------------------
  function registerOn(hub) {
    var api = hub && hub.on ? hub : { on: on };
    if (api && api.on) on = api.on;
    if (api && api.emit) emit = api.emit;
    try { api.on("prep.tasks.requested", handlePrepTasksRequested); }
    catch (e) {
      try { on("prep.tasks.requested", handlePrepTasksRequested); } catch (e2) {}
    }
  }

  // Auto-register when events hub is present
  try { registerOn(EventsHub); } catch (e) {}

  // ----------------------------- Exports ----------------------------------
  var api = {
    register: registerOn,
    _internals: {
      handlePrepTasksRequested: handlePrepTasksRequested,
      buildPrepTasksForItem: buildPrepTasksForItem,
      normalizeIncomingItem: normalizeIncomingItem,
      coalesceByKey: coalesceByKey
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    try { window.onPrepTasksRequested = api; } catch (e) {}
  }
})();

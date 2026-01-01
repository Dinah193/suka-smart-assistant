/* eslint-disable no-console */
/**
 * emitPlannerConflict.js — dynamic detection & emission for planner conflicts (ES2015-safe)
 *
 * Listens (canonical; aliases normalized upstream):
 *   - "planner.conflict.requested"         // { items:[task|event], options? }
 *   - "planner.conflict.emit"              // same as requested; convenience alias
 *
 * Emits (via unified events hub):
 *   - "planner.conflict.emitted"           // { conflicts:[...], summary:{...}, scope:{...} }
 *   - "planner.conflict.suggested"         // per-conflict suggestions for UI and automation
 *   - "nba.updated"                        // Do-now / resolve suggestions
 *   - "calendar.event.requested"           // paint conflict spans as overlays
 *   - "reminder.schedule.requested"        // optional reminder to fix critical conflicts
 *
 * Conflict taxonomy (multi-domain):
 *   - time.overlap        : two+ items overlap in time (same person/zone/appliance)
 *   - resource.appliance  : same oven/smoker/grill/dehydrator
 *   - resource.zone       : same room/station (kitchen sink, butchery table, garden bed)
 *   - resource.person     : same person assigned to multiple tasks
 *   - sabbath.window      : item falls into sabbath guard window
 *   - weather.blocker     : garden task conflicts with weather window (basic heuristic)
 *   - chillchain.risk     : food safety max-out-of-fridge exceeded
 *   - withhold.violation  : started too early for withholdMinutes constraint
 *   - budget.overrun      : optional (if costs present) session or plan exceeds budget
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

  var EventsHub = {};
  var Events = {};
  try {
    EventsHub = require("@/automation/events") || {};
    Events = (EventsHub && (EventsHub.Events || (EventsHub.default && EventsHub.default.Events))) || {};
  } catch (e) {}

  var eventAliases = {};
  try { eventAliases = require("@/services/eventAliases") || {}; } catch (e) {}

  var SettingsStore = { get: function(){ return undefined; } };
  try { SettingsStore = prefer(require("@/stores/SettingsStore"), ["get"]); } catch (e) {}

  var SessionStore = { getById: function(){ return null; } };
  try { SessionStore = prefer(require("@/stores/SessionStore"), ["getById"]); } catch (e) {}

  var EstimateEngine = { estimateLines: function(){ return null; } };
  try { EstimateEngine = prefer(require("@/engines/estimateEngine"), ["estimateLines"]); } catch (e) {}

  var ReminderManager = { schedule: function(){} };
  try { ReminderManager = prefer(require("@/managers/ReminderManager"), ["schedule"]); } catch (e) {}

  // hub helpers (no-op safe)
  var emit = (EventsHub && EventsHub.emit) ? EventsHub.emit : function(){};
  var on   = (EventsHub && EventsHub.on)   ? EventsHub.on   : function(){};

  var DEV = true;

  // ----------------------------- Utilities --------------------------------
  function uuid(){ return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=(Math.random()*16)|0,v=c==="x"?r:(r&0x3)|0x8;return v.toString(16);}); }
  function safeDate(x){ if(!x) return new Date(); if(x instanceof Date) return x; var d=new Date(x); return isNaN(d.getTime())?new Date():d; }
  function toMs(v, unit){ if(v==null) return 0; var n=Number(v)||0,M=60000,H=3600000; switch(unit){ case "m": case "min": case "minute": case "minutes":return n*M; case "h": case "hour": case "hours":return n*H; default: return n; } }
  function overlaps(aStart,aEnd,bStart,bEnd){ return (aStart <= bEnd) && (bStart <= aEnd); }
  function getSetting(key, fallback){ try{ var v=SettingsStore.get && SettingsStore.get(key); return (v==null?fallback:v);}catch(e){return fallback;} }
  function toArray(x){ return Array.isArray(x)?x:(x==null?[]:[x]); }

  function applySabbathGuardCheck(startMs, endMs, enabled){
    if(!enabled) return { hit:false };
    try{
      // Basic Fri 18:00 → Sat 18:00 local
      var d = new Date(startMs);
      var ref = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18,0,0,0);
      var diffToFri = (5 - d.getDay());
      var fri = new Date(ref.getTime() + diffToFri*86400000).getTime();
      var sat = fri + 86400000;
      var hit = overlaps(startMs, endMs, fri, sat);
      // also cover Saturday before 18:00
      var st = new Date(startMs);
      if (st.getDay()===6 && st.getHours()<18) hit = true;
      return { hit: !!hit, window:[fri, sat] };
    } catch(e){ return { hit:false }; }
  }

  function normItem(x){
    if (!x) return null;
    var s = safeDate(x.start || x.scheduledAt);
    var e = safeDate(x.end || (x.scheduledAt ? new Date(x.scheduledAt + (x.estimatedMs||0)) : null));
    if (e && e < s) { var tmp = e; e = s; s = tmp; } // safety
    var meta = x.meta || {};
    var constraints = meta.constraints || x.constraints || {};
    var resources = x.resources || {};

    return {
      id: x.id || uuid(),
      title: x.title || x.name || "Untitled",
      domain: x.domain || (x.context && x.context.domain) || "cooking",
      start: s.getTime(),
      end: (e ? e.getTime() : (s.getTime() + (x.estimatedMs || 0))),
      zone: resources.zone || meta.zone || null,
      appliance: resources.appliance || meta.appliance || null,
      personIds: toArray(resources.personIds || meta.personIds),
      planId: x.planId || null,
      sessionId: x.sessionId || null,
      tags: toArray(x.tags || []),
      meta: meta,
      constraints: constraints
    };
  }

  // ----------------------------- Detectors --------------------------------
  function detectTimeOverlap(items){
    var conflicts = [];
    var arr = items.slice().sort(function(a,b){ return a.start - b.start; });
    for (var i=0;i<arr.length;i++){
      for (var j=i+1;j<arr.length;j++){
        if (arr[j].start > arr[i].end) break;
        // Any shared resource/person/zone?
        var sharedAppliance = arr[i].appliance && arr[i].appliance === arr[j].appliance;
        var sharedZone = arr[i].zone && arr[i].zone === arr[j].zone;
        var sharedPerson = arr[i].personIds.some(function(p){ return arr[j].personIds.indexOf(p)>=0; });
        if (overlaps(arr[i].start, arr[i].end, arr[j].start, arr[j].end) && (sharedAppliance || sharedZone || sharedPerson)) {
          conflicts.push({
            id: uuid(),
            type: "time.overlap",
            severity: sharedAppliance ? "high" : (sharedPerson || sharedZone ? "medium" : "low"),
            a: arr[i], b: arr[j],
            details: {
              shared: {
                appliance: sharedAppliance ? arr[i].appliance : null,
                zone: sharedZone ? arr[i].zone : null,
                personIds: sharedPerson ? arr[i].personIds.filter(function(p){return arr[j].personIds.indexOf(p)>=0;}) : []
              }
            }
          });
        }
      }
    }
    return conflicts;
  }

  function detectAppliance(items){
    var by = {};
    items.forEach(function(it){
      if (!it.appliance) return;
      var k = it.appliance;
      (by[k] = by[k] || []).push(it);
    });
    var out = [];
    Object.keys(by).forEach(function(k){
      var arr = by[k].sort(function(a,b){ return a.start - b.start; });
      for (var i=0;i<arr.length;i++){
        for (var j=i+1;j<arr.length;j++){
          if (arr[j].start > arr[i].end) break;
          if (overlaps(arr[i].start, arr[i].end, arr[j].start, arr[j].end)) {
            out.push({
              id: uuid(),
              type: "resource.appliance",
              severity: "high",
              appliance: k,
              a: arr[i], b: arr[j]
            });
          }
        }
      }
    });
    return out;
  }

  function detectZone(items){
    var by = {};
    items.forEach(function(it){
      if (!it.zone) return;
      var k = it.zone;
      (by[k] = by[k] || []).push(it);
    });
    var out = [];
    Object.keys(by).forEach(function(k){
      var arr = by[k].sort(function(a,b){ return a.start - b.start; });
      for (var i=0;i<arr.length;i++){
        for (var j=i+1;j<arr.length;j++){
          if (arr[j].start > arr[i].end) break;
          if (overlaps(arr[i].start, arr[i].end, arr[j].start, arr[j].end)) {
            out.push({
              id: uuid(),
              type: "resource.zone",
              severity: "medium",
              zone: k,
              a: arr[i], b: arr[j]
            });
          }
        }
      }
    });
    return out;
  }

  function detectPerson(items){
    var out = [];
    items.forEach(function(a, i){
      if (!a.personIds.length) return;
      for (var j=i+1;j<items.length;j++){
        var b = items[j];
        if (!b.personIds.length) continue;
        if (!overlaps(a.start, a.end, b.start, b.end)) continue;
        var shared = a.personIds.filter(function(p){ return b.personIds.indexOf(p)>=0; });
        if (shared.length){
          out.push({ id: uuid(), type:"resource.person", severity:"medium", personIds: shared, a:a, b:b });
        }
      }
    });
    return out;
  }

  function detectSabbath(items, enabled){
    if (!enabled) return [];
    var out=[];
    items.forEach(function(it){
      var chk = applySabbathGuardCheck(it.start, it.end, true);
      if (chk.hit){
        out.push({ id: uuid(), type:"sabbath.window", severity:"high", a:it, window: chk.window });
      }
    });
    return out;
  }

  function detectChillChain(items){
    var out=[];
    items.forEach(function(it){
      var c = it.constraints || {};
      var cc = c.chillChain;
      if (!cc || !cc.maxMinutesOut) return;
      var maxMs = toMs(cc.maxMinutesOut, "minutes");
      var duration = it.end - it.start;
      if (duration > maxMs){
        out.push({ id: uuid(), type:"chillchain.risk", severity:"high", a:it, limitMs: maxMs, durationMs: duration });
      }
    });
    return out;
  }

  function detectWithhold(items){
    var out=[];
    items.forEach(function(it){
      var c = it.constraints || {};
      if (!c.withholdMinutes) return;
      var latestStart = it.end - toMs(c.withholdMinutes, "minutes");
      if (it.start < latestStart){
        out.push({ id: uuid(), type:"withhold.violation", severity:"low", a:it, latestStart: latestStart });
      }
    });
    return out;
  }

  function detectWeather(items){
    // lightweight heuristic: if task domain=garden and item.meta.weather === "rain" and item.meta.requires="dry"
    // Or if SettingsStore has a simple "weather.blocker" flag injected upstream.
    var out=[];
    items.forEach(function(it){
      if (it.domain !== "garden") return;
      var w = (it.meta && it.meta.weather) || null;
      var req = (it.meta && it.meta.requires) || null;
      if (!w || !req) return;
      if (/rain/i.test(w) && /dry/i.test(req)){
        out.push({ id: uuid(), type:"weather.blocker", severity:"medium", a:it, weather:w, requires:req });
      }
    });
    return out;
  }

  function detectBudget(items){
    // if items have costs OR we can estimate quickly
    var costLines = [];
    items.forEach(function(it){
      if (it.cost != null){
        costLines.push({ name: it.title, unitPrice: Number(it.cost)||0, qty: 1 });
      }
    });
    if (!costLines.length) return [];
    var budget = Number(getSetting("budget.sessionCap", 0)) || 0;
    if (!budget) return [];
    var est = null;
    try { est = EstimateEngine.estimateLines ? EstimateEngine.estimateLines(costLines) : null; } catch(e){}
    var total = (est && est.total) || costLines.reduce(function(s, l){ return s + (l.unitPrice * (l.qty||1)); }, 0);
    if (total > budget){
      return [{ id: uuid(), type:"budget.overrun", severity:"medium", total: total, cap: budget, lines: costLines }];
    }
    return [];
  }

  // ----------------------------- Suggestions ------------------------------
  function suggestionsFor(conf){
    var sug = [], a = conf.a, b = conf.b;
    switch (conf.type){
      case "time.overlap":
      case "resource.appliance":
      case "resource.zone":
        sug.push({ type:"reschedule", label:"Move later by 15–30 min", payload:{ id:(b||a).id, shift:"+20m" } });
        sug.push({ type:"reassign",  label:"Reassign resource/person", payload:{ id:(b||a).id, resource:"auto" } });
        if (conf.type === "resource.appliance" && a && b && a.meta && b.meta && (a.meta.type==="preheat" || b.meta.type==="preheat")){
          sug.push({ type:"combine.preheat", label:"Combine preheats (same appliance)", payload:{ ids:[a.id, b.id] } });
        }
        break;
      case "resource.person":
        sug.push({ type:"reassign.person", label:"Reassign to another available person", payload:{ ids:[].concat(conf.personIds||[]), taskId:(b||a).id } });
        sug.push({ type:"reschedule", label:"Move one task by 15–30 min", payload:{ id:(b||a).id, shift:"+20m" } });
        break;
      case "sabbath.window":
        sug.push({ type:"shift.before.sabbath", label:"Shift to before Sabbath", payload:{ id:a.id, target:"before" } });
        sug.push({ type:"shift.after.sabbath",  label:"Shift to after Sabbath",  payload:{ id:a.id, target:"after" } });
        break;
      case "chillchain.risk":
        sug.push({ type:"split.task", label:"Split into smaller batches", payload:{ id:a.id, maxMinutes: Math.round(conf.limitMs/60000) } });
        sug.push({ type:"add.icebath", label:"Add cooling step between stages", payload:{ id:a.id } });
        break;
      case "withhold.violation":
        sug.push({ type:"delay.start", label:"Delay start to respect withhold", payload:{ id:a.id, earliest: conf.latestStart } });
        break;
      case "weather.blocker":
        sug.push({ type:"reschedule.weather", label:"Reschedule to dry window", payload:{ id:a.id } });
        sug.push({ type:"cover.crop", label:"Use cover or move task indoors", payload:{ id:a.id } });
        break;
      case "budget.overrun":
        sug.push({ type:"reduce.scope", label:"Remove lower-priority items", payload:{} });
        sug.push({ type:"substitute.lower.cost", label:"Swap for cheaper options", payload:{} });
        break;
    }
    return sug;
  }

  function conflictToCalendarOverlay(conf){
    var start = (conf.a && conf.a.start) || (conf.window && conf.window[0]) || Date.now();
    var end   = (conf.a && conf.a.end)   || (conf.window && conf.window[1]) || (start + 30*60000);
    var label = "[" + conf.type + "] " + ((conf.a && conf.a.title) || (conf.b && conf.b.title) || "");
    return { title: label, start: new Date(start).toISOString(), end: new Date(end).toISOString(), tags:["conflict"] };
  }

  function conflictToNBA(conf, scope){
    var top = suggestionsFor(conf).slice(0,3);
    return top.map(function(s, idx){
      return {
        id: "nba:conflict:"+conf.id+":"+idx,
        label: s.label,
        when: new Date().toISOString(),
        badges: ["conflict", conf.type],
        hint: (conf.details && conf.details.shared) ? JSON.stringify(conf.details.shared) : "",
        action: { type: s.type, payload: Object.assign({ conflictId: conf.id, scope: scope }, s.payload || {}) }
      };
    });
  }

  function scheduleReminderIfCritical(conf, options){
    try{
      var critical = conf.severity === "high" || conf.type === "sabbath.window" || conf.type === "chillchain.risk";
      if (!critical) return;
      var when = new Date(Date.now() + 5*60000); // 5 minutes from now
      var title = "Resolve conflict: " + conf.type;
      var payload = {
        id: "reminder:conflict:"+conf.id,
        title: title,
        message: (conf.a && conf.a.title) ? conf.a.title : title,
        when: when,
        context: { type:"planner-conflict", conflictId: conf.id, severity: conf.severity },
        channels: toArray(getSetting("notifications.channelsDefault", ["toast","modal"])),
        priority: "high"
      };
      if (ReminderManager && typeof ReminderManager.schedule === "function") {
        ReminderManager.schedule(payload);
      } else {
        emit("reminder.schedule.requested", Object.assign({}, payload, { when: when.toISOString() }), { topic: "reminder.schedule.requested" });
      }
    } catch(e){}
  }

  // ----------------------------- Orchestrator -----------------------------
  function buildConflicts(items, options){
    var sabbathGuard = !!(options && (options.sabbathGuard != null ? options.sabbathGuard : getSetting("sabbathGuard", false)));
    var conflicts = []
      .concat(detectAppliance(items))
      .concat(detectZone(items))
      .concat(detectPerson(items))
      .concat(detectTimeOverlap(items))
      .concat(detectSabbath(items, sabbathGuard))
      .concat(detectChillChain(items))
      .concat(detectWithhold(items))
      .concat(detectWeather(items))
      .concat(detectBudget(items));
    // Dedup by (type + a.id + b.id)
    var seen = {};
    conflicts = conflicts.filter(function(c){
      var key = [c.type, (c.a && c.a.id)||"", (c.b && c.b.id)||"", c.appliance||"", c.zone||""].join("|");
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
    return conflicts;
  }

  function handleConflictRequested(envelope){
    var env = (eventAliases && eventAliases.canonicalizeEnvelope) ? eventAliases.canonicalizeEnvelope(envelope) : (envelope || {});
    if (!env || (env.topic !== "planner.conflict.requested" && env.topic !== "planner.conflict.emit" && env.type !== "planner.conflict.requested")) return;

    var payload = env.payload || {};
    var rawItems = Array.isArray(payload.items) ? payload.items : [];
    var options  = payload.options || {};
    var sessionId = payload.sessionId || env.sessionId || null;
    var planId    = payload.planId || null;

    // Pause-aware; if session paused, tag items
    var session = null;
    try { if (sessionId && SessionStore.getById) session = SessionStore.getById(sessionId) || null; } catch(e){}
    var items = rawItems.map(normItem);

    var conflicts = buildConflicts(items, options);

    // Emit per-conflict suggestions + overlays + critical reminders
    var scope = { sessionId: sessionId, planId: planId, source: options.source || "planner" };
    conflicts.forEach(function(c){
      // suggestions event (for side panels/cards)
      try {
        emit("planner.conflict.suggested", {
          conflict: c,
          suggestions: suggestionsFor(c),
          scope: scope
        }, { topic: "planner.conflict.suggested" });
      } catch(e){}

      // calendar overlay
      try {
        emit("calendar.event.requested", conflictToCalendarOverlay(c), { topic: "calendar.event.requested" });
      } catch(e){}

      // critical reminder
      scheduleReminderIfCritical(c, options);
    });

    // Fire NBA cards (top suggestions for each)
    var nbaCards = [];
    conflicts.forEach(function(c){
      nbaCards = nbaCards.concat(conflictToNBA(c, scope));
    });
    if (nbaCards.length){
      try {
        emit(Events.NBA_UPDATED || "nba.updated", { scope: scope, suggestions: nbaCards }, { topic: Events.NBA_UPDATED || "nba.updated" });
      } catch(e){}
    }

    // Summary
    var summary = conflicts.reduce(function(acc, c){
      acc.total++;
      acc.byType[c.type] = (acc.byType[c.type]||0)+1;
      return acc;
    }, { total:0, byType:{} });

    // Final emission
    try {
      emit("planner.conflict.emitted", { conflicts: conflicts, summary: summary, scope: scope }, { topic: "planner.conflict.emitted" });
    } catch(e){}

    if (DEV) try { console.debug("[planner.conflict] emitted:", summary); } catch(e){}
  }

  // ----------------------------- Registration -----------------------------
  function registerOn(hub){
    var api = hub && hub.on ? hub : { on:on };
    try {
      api.on("planner.conflict.requested", handleConflictRequested);
      api.on("planner.conflict.emit", handleConflictRequested);
    } catch(e){
      try { on("planner.conflict.requested", handleConflictRequested); } catch(e2){}
      try { on("planner.conflict.emit", handleConflictRequested); } catch(e3){}
    }
  }

  // auto-register
  try { registerOn(EventsHub); } catch(e){}

  // ----------------------------- Exports ----------------------------------
  var api = {
    register: registerOn,
    emitConflicts: function(payload){ // programmatic helper
      try { emit("planner.conflict.requested", payload, { topic: "planner.conflict.requested" }); } catch(e){}
    },
    _internals: {
      normItem: normItem,
      buildConflicts: buildConflicts,
      detectTimeOverlap: detectTimeOverlap,
      detectAppliance: detectAppliance,
      detectZone: detectZone,
      detectPerson: detectPerson,
      detectSabbath: detectSabbath,
      detectChillChain: detectChillChain,
      detectWithhold: detectWithhold,
      detectWeather: detectWeather,
      suggestionsFor: suggestionsFor
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    try { window.emitPlannerConflict = api; } catch (e) {}
  }
})();

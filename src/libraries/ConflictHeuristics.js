/* eslint-disable no-console */
/**
 * ConflictHeuristics.js — domain-aware conflict detection + suggestions (ES2015-safe)
 *
 * Goals
 *  • Unify conflict detection across modules (meals, cleaning, animals, garden)
 *  • Emit domain-aware events: planner.conflict.detected (kind: time|appliance|weather|biohazard|withhold)
 *  • Provide consistent scores (0–100), rationales, and Next Best Action (NBA) hints
 *  • Offer quick-fix patches that UI can apply (non-destructive) via session/plan patching
 *  • Pluggable heuristics: registerHeuristic(name, fn)
 *
 * Design Notes
 *  • Defensive requires to avoid hard crashes during incremental wiring
 *  • Scoring blends base severity per kind + contextual modifiers (PPE, species, perishables, outdoor/indoor, etc.)
 *  • Suggestions shaped for ConflictResolverBar & NBAInvokeButton (title, action, patch, emit, telemetry)
 */

(function () {
  /* ----------------------------- Safe Imports ----------------------------- */
  var eventBus = { emit: function () {} };
  try {
    // Supports either default export or named { eventBus }
    var eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
  } catch (e) { /* noop */ }

  var scheduleHelpers = { overlapWindows: function(){ return []; }, shiftWindow: function(win, mins){ return win; } };
  try {
    scheduleHelpers = require("@/engines/schedule/scheduleHelpers") || scheduleHelpers;
  } catch (e) { /* noop */ }

  var estimateEngine = { estimate: function(){ return {}; } };
  try {
    estimateEngine = require("@/engines/estimates/estimateEngine") || estimateEngine;
  } catch (e) { /* noop */ }

  var placementRules = { suggestAlternates: function(){ return []; }, detectApplianceClash: function(){ return []; } };
  try {
    placementRules = require("@/engines/deciders/placementRules") || placementRules;
  } catch (e) { /* noop */ }

  var workPrepConsolidation = { detectResourceOverlaps: function(){ return []; } };
  try {
    workPrepConsolidation = require("@/engines/prep/workPrepConsolidation") || workPrepConsolidation;
  } catch (e) { /* noop */ }

  // Optional: Weather & PPE advisors
  var WeatherAdvisor = { assess: function(){ return { risk: "low", reasons: [] }; } };
  try {
    WeatherAdvisor = require("@/advisors/WeatherAdvisor") || WeatherAdvisor;
  } catch (e) { /* noop */ }

  var SafetyAdvisor = { assessBiohazard: function(){ return { level: "low", reasons: [] }; }, withholdWindows: function(){ return []; } };
  try {
    SafetyAdvisor = require("@/advisors/SafetyAdvisor") || SafetyAdvisor;
  } catch (e) { /* noop */ }

  /* ----------------------------- Utilities -------------------------------- */
  var KINDS = {
    TIME: "time",
    APPLIANCE: "appliance",
    WEATHER: "weather",
    BIOHAZARD: "biohazard",
    WITHHOLD: "withhold"
  };

  var DOMAIN_BASE = {
    meals: 1.0,       // perishables/time critical
    cleaning: 0.8,    // moderate time sensitivity
    animals: 1.2,     // high welfare impact
    garden: 0.9       // weather-dependent, variable
  };

  var KIND_BASE = {
    time: 55,
    appliance: 60,
    weather: 65,
    biohazard: 80,
    withhold: 70
  };

  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

  function scoreConflict(base, modifiers) {
    var s = base;
    for (var i=0;i<modifiers.length;i++) s += modifiers[i];
    return clamp(Math.round(s), 0, 100);
  }

  function normalizeDomain(domain) {
    return (domain && DOMAIN_BASE.hasOwnProperty(domain)) ? domain : "meals";
  }

  function windowFromItem(item) {
    // item.timeWindow: { start:number(ms), end:number(ms) } or derive from duration + start
    if (item && item.timeWindow && typeof item.timeWindow.start === "number" && typeof item.timeWindow.end === "number") {
      return item.timeWindow;
    }
    if (item && item.start && item.durationMin) {
      return { start: item.start, end: item.start + item.durationMin * 60000 };
    }
    return null;
  }

  function emitConflict(conflict) {
    try {
      eventBus.emit("planner.conflict.detected", {
        kind: conflict.kind,
        domain: conflict.domain,
        conflict: conflict
      });
    } catch (e) { /* noop */ }
  }

  function nbaHint(conflict, priority) {
    return {
      id: "nba:"+conflict.id,
      priority: priority || (conflict.score >= 80 ? "critical" : conflict.score >= 60 ? "high" : "normal"),
      title: conflict.title || ("Resolve "+conflict.kind+" conflict"),
      subtitle: conflict.rationale,
      actions: (conflict.suggestions || []).map(function(sug){
        return {
          label: sug.title,
          intent: sug.intent || "patch",
          emit: sug.emit || null
        };
      })
    };
  }

  /* ---------------------------- Heuristic Core ---------------------------- */
  var registry = {}; // name -> fn(ctx): Conflict[]
  function registerHeuristic(name, fn) { registry[name] = fn; }
  function listHeuristics() { return Object.keys(registry); }

  /**
   * analyze(plan, options)
   * plan: { id, domain, items:[{ id, title, type, start, durationMin, timeWindow?, appliance?, resources?, species?, indoor?, perishable?, temperature?, notes? }], meta? }
   * options: { now?, user?, weather?, strict? }
   */
  function analyze(plan, options) {
    options = options || {};
    var domain = normalizeDomain(plan && plan.domain);
    var ctx = {
      plan: plan || { items: [] },
      options: options,
      domain: domain,
      helpers: { scheduleHelpers: scheduleHelpers, placementRules: placementRules, workPrepConsolidation: workPrepConsolidation, estimateEngine: estimateEngine },
      advisors: { WeatherAdvisor: WeatherAdvisor, SafetyAdvisor: SafetyAdvisor }
    };

    var conflicts = [];
    var names = listHeuristics();
    for (var i=0;i<names.length;i++) {
      try {
        var out = registry[names[i]](ctx) || [];
        for (var j=0;j<out.length;j++) {
          out[j].domain = domain;
          emitConflict(out[j]);
          conflicts.push(out[j]);
        }
      } catch (e) {
        console.warn("[ConflictHeuristics] heuristic failed:", names[i], e && e.message);
      }
    }

    // Aggregate metrics + NBA hints
    var metrics = { total: conflicts.length, byKind: {}, maxScore: 0 };
    var hints = [];
    for (var k=0;k<conflicts.length;k++) {
      var c = conflicts[k];
      metrics.byKind[c.kind] = (metrics.byKind[c.kind] || 0) + 1;
      metrics.maxScore = Math.max(metrics.maxScore, c.score || 0);
      hints.push(nbaHint(c));
    }

    // Triage order: highest score first, then biohazard/withhold priority
    conflicts.sort(function(a,b){
      if ((b.score||0) !== (a.score||0)) return (b.score||0) - (a.score||0);
      var prio = [KINDS.BIOHAZARD, KINDS.WITHHOLD, KINDS.WEATHER, KINDS.APPLIANCE, KINDS.TIME];
      return prio.indexOf(a.kind) - prio.indexOf(b.kind);
    });

    return { conflicts: conflicts, metrics: metrics, nbaHints: hints };
  }

  /**
   * applyAutoFixes(plan, conflicts)
   * Attempts low-risk patches (time shifts, appliance swap, PPE reminders). Returns { patchedPlan, patches }
   */
  function applyAutoFixes(plan, conflicts) {
    plan = plan || { items: [] };
    var patches = [];
    for (var i=0;i<conflicts.length;i++) {
      var c = conflicts[i];
      if (!c.suggestions) continue;
      for (var j=0;j<c.suggestions.length;j++) {
        var s = c.suggestions[j];
        if (s.autoApply === true && typeof s.patch === "function") {
          var p = s.patch(plan);
          if (p) patches.push(p);
        }
      }
    }
    // Apply patches immutably
    var map = {};
    for (var x=0;x<plan.items.length;x++) map[plan.items[x].id] = plan.items[x];
    for (var y=0;y<patches.length;y++) {
      var patch = patches[y];
      if (patch && patch.targetId && patch.apply && typeof patch.apply === "function") {
        var target = map[patch.targetId];
        var updated = patch.apply(target);
        if (updated) map[patch.targetId] = updated;
      }
    }
    var resultItems = [];
    for (var key in map) if (map.hasOwnProperty(key)) resultItems.push(map[key]);
    return { patchedPlan: Object.assign({}, plan, { items: resultItems }), patches: patches };
  }

  /* --------------------------- Built-in Heuristics ------------------------ */

  // 1) TIME OVERLAP / DENSE STACK
  registerHeuristic("time.overlap", function(ctx){
    var items = ctx.plan.items || [];
    var overlaps = scheduleHelpers.overlapWindows(items.map(function(it){ return { id: it.id, window: windowFromItem(it), title: it.title }; }));
    var out = [];
    for (var i=0;i<overlaps.length;i++){
      var pair = overlaps[i]; // { a:{id,window}, b:{id,window}, overlapMin }
      if (!pair || !pair.a || !pair.b) continue;

      var a = items.find(function(x){ return x.id === pair.a.id; });
      var b = items.find(function(x){ return x.id === pair.b.id; });
      if (!a || !b) continue;

      var domainMult = DOMAIN_BASE[ctx.domain] || 1;
      var base = KIND_BASE[KINDS.TIME];
      var tightness = Math.min(30, Math.round(pair.overlapMin / 2)); // more overlap -> higher score
      var modifiers = [ tightness * domainMult ];

      var conflict = {
        id: "time:"+a.id+"~"+b.id,
        kind: KINDS.TIME,
        title: "Overlapping tasks",
        score: scoreConflict(base, modifiers),
        rationale: "Two tasks overlap in time, risking execution quality and throughput.",
        affected: [ a.id, b.id ],
        suggestions: [
          {
            title: "Shift start time of '"+b.title+"' by +15 min",
            autoApply: true,
            intent: "patch",
            patch: function(plan){
              return {
                targetId: b.id,
                apply: function(target){
                  if (!target) return target;
                  var w = windowFromItem(target);
                  if (!w) return target;
                  var shifted = scheduleHelpers.shiftWindow(w, 15);
                  return Object.assign({}, target, { timeWindow: shifted, start: shifted.start, durationMin: Math.round((shifted.end - shifted.start)/60000) });
                }
              };
            }
          },
          {
            title: "Make '"+a.title+"' prep-only (defer cook/execute)",
            autoApply: false,
            intent: "option",
            emit: { name: "planner.option.selected", payload: { strategy: "defer-execute", items: [a.id] } }
          }
        ]
      };
      out.push(conflict);
    }
    return out;
  });

  // 2) APPLIANCE / RESOURCE CLASH
  registerHeuristic("appliance.clash", function(ctx){
    var items = ctx.plan.items || [];
    var clashes = (placementRules.detectApplianceClash && placementRules.detectApplianceClash(items)) || [];
    var out = [];
    for (var i=0;i<clashes.length;i++){
      var c = clashes[i]; // { ids:[], appliance, windows:[{start,end}], density }
      var base = KIND_BASE[KINDS.APPLIANCE];
      var density = c.density ? Math.min(25, c.density*5) : 10;
      var modifiers = [ density, (ctx.domain === "meals" ? 5 : 0) ];

      out.push({
        id: "appliance:"+c.appliance+":"+(c.ids||[]).join(","),
        kind: KINDS.APPLIANCE,
        title: "Appliance overbooked: "+c.appliance,
        score: scoreConflict(base, modifiers),
        rationale: "Multiple tasks require the same appliance concurrently.",
        affected: c.ids || [],
        suggestions: [
          {
            title: "Stagger appliance tasks by +10 min",
            autoApply: true,
            intent: "patch",
            patch: function(plan){
              // simple stagger: shift every second item
              return {
                targetId: c.ids[1],
                apply: function(target){
                  if (!target) return target;
                  var w = windowFromItem(target);
                  if (!w) return target;
                  var shifted = scheduleHelpers.shiftWindow(w, 10);
                  return Object.assign({}, target, { timeWindow: shifted, start: shifted.start, durationMin: Math.round((shifted.end - shifted.start)/60000) });
                }
              };
            }
          },
          {
            title: "Suggest alternate equipment",
            autoApply: false,
            intent: "option",
            emit: { name: "planner.alternate.requested", payload: { appliance: c.appliance, items: c.ids } }
          }
        ]
      });
    }
    return out;
  });

  // 3) WEATHER RISK (garden + animals priority, some cleaning/meals outdoor)
  registerHeuristic("weather.risk", function(ctx){
    var items = ctx.plan.items || [];
    var out = [];
    for (var i=0;i<items.length;i++){
      var it = items[i];
      if (it.indoor === true) continue;
      var assess = ctx.advisors.WeatherAdvisor.assess(it, ctx.options.weather || null);
      var level = (assess && assess.risk) || "low";
      if (level === "low") continue;

      var base = KIND_BASE[KINDS.WEATHER];
      var mod = level === "medium" ? 10 : 25; // high -> +25
      var domainMod = (ctx.domain === "garden" || ctx.domain === "animals") ? 10 : 0;

      out.push({
        id: "weather:"+it.id,
        kind: KINDS.WEATHER,
        title: "Weather risk for '"+(it.title || it.id)+"'",
        score: scoreConflict(base, [mod, domainMod]),
        rationale: (assess.reasons && assess.reasons.join("; ")) || "Outdoor conditions may reduce success or safety.",
        affected: [it.id],
        suggestions: [
          {
            title: "Move to earliest safe window",
            autoApply: false,
            intent: "option",
            emit: { name: "planner.schedule.safeWindow.requested", payload: { itemId: it.id } }
          },
          {
            title: "Add PPE reminder (rain gear / heat plan)",
            autoApply: true,
            intent: "patch",
            patch: function(){
              return {
                targetId: it.id,
                apply: function(target){
                  var notes = (target.notes || "");
                  if (notes.indexOf("[PPE]") === -1) notes = "[PPE] Weather protection required. " + notes;
                  return Object.assign({}, target, { notes: notes });
                }
              };
            }
          }
        ]
      });
    }
    return out;
  });

  // 4) BIOHAZARD / FOOD SAFETY / ANIMAL WELFARE
  registerHeuristic("biohazard.safety", function(ctx){
    var items = ctx.plan.items || [];
    var out = [];
    for (var i=0;i<items.length;i++){
      var it = items[i];
      var assess = ctx.advisors.SafetyAdvisor.assessBiohazard(it, ctx.plan);
      var level = (assess && assess.level) || "low";
      if (level === "low") continue;

      var base = KIND_BASE[KINDS.BIOHAZARD];
      var mod = level === "medium" ? 10 : 25;
      // Extra penalty for cross-contamination risks in meals + butchery
      var domainMod = (ctx.domain === "meals" || ctx.domain === "animals") ? 10 : 0;

      out.push({
        id: "bio:"+it.id,
        kind: KINDS.BIOHAZARD,
        title: "Biohazard risk for '"+(it.title || it.id)+"'",
        score: scoreConflict(base, [mod, domainMod]),
        rationale: (assess.reasons && assess.reasons.join("; ")) || "Potential contamination or unsafe handling flow.",
        affected: [it.id],
        suggestions: [
          {
            title: "Insert sanitation step before/after",
            autoApply: false,
            intent: "option",
            emit: { name: "prep.tasks.requested", payload: { domain: ctx.domain, tasks: ["Sanitize surfaces", "Change gloves"] } }
          },
          {
            title: "Split task into prep + execute with buffer",
            autoApply: true,
            intent: "patch",
            patch: function(){
              return {
                targetId: it.id,
                apply: function(target){
                  // Add a minimal buffer note; actual split is orchestrator-level
                  var notes = (target.notes || "");
                  if (notes.indexOf("[FLOW]") === -1) notes = "[FLOW] Separate prep/execute; enforce sanitation buffer. " + notes;
                  return Object.assign({}, target, { notes: notes });
                }
              };
            }
          }
        ]
      });
    }
    return out;
  });

  // 5) WITHHOLD WINDOWS (cooling, resting meat, curing, marinating, proofing, chemical withhold for cleaning or animal meds)
  registerHeuristic("withhold.windows", function(ctx){
    var items = ctx.plan.items || [];
    var withholds = ctx.advisors.SafetyAdvisor.withholdWindows(items, ctx.plan) || [];
    var out = [];
    for (var i=0;i<withholds.length;i++){
      var w = withholds[i]; // { itemId, reason, start, end, kind?: "marinate|rest|cool|chemical|medication" }
      var base = KIND_BASE[KINDS.WITHHOLD];
      var durMin = Math.round((w.end - w.start)/60000);
      var durMod = Math.min(25, Math.round(durMin / 15)); // longer withhold -> higher impact
      // Animals meds & butchery cooling carry higher system impact
      var domainMod = (ctx.domain === "animals" || ctx.domain === "meals") ? 10 : 0;

      out.push({
        id: "withhold:"+w.itemId+":"+w.start,
        kind: KINDS.WITHHOLD,
        title: "Withhold period: "+(w.kind || "process buffer"),
        score: scoreConflict(base, [durMod, domainMod]),
        rationale: w.reason || "Process requires a timed withhold window.",
        affected: [w.itemId],
        suggestions: [
          {
            title: "Auto-schedule reminder at withhold end",
            autoApply: true,
            intent: "patch",
            patch: function(){
              return {
                targetId: w.itemId,
                apply: function(target){
                  var notes = (target.notes || "");
                  if (notes.indexOf("[REMIND]") === -1) notes = "[REMIND] Resume at withhold end. " + notes;
                  return Object.assign({}, target, { notes: notes });
                }
              };
            }
          },
          {
            title: "Pause session for background run",
            autoApply: false,
            intent: "option",
            emit: { name: "session.pause.requested", payload: { reason: "withhold", until: w.end, items: [w.itemId] } }
          }
        ]
      });
    }
    return out;
  });

  // 6) CROSS-RESOURCE OVERLAP (prep tables, sinks, hoses, zones)
  registerHeuristic("resource.overlap", function(ctx){
    var items = ctx.plan.items || [];
    var overlaps = ctx.helpers.workPrepConsolidation.detectResourceOverlaps(items) || [];
    var out = [];
    for (var i=0;i<overlaps.length;i++){
      var o = overlaps[i]; // { resource:"sinkA", ids:[], overlapMin:number }
      var base = KIND_BASE[KINDS.APPLIANCE] - 5; // similar severity, slightly lower by default
      var mod = Math.min(20, Math.round(o.overlapMin / 5));
      out.push({
        id: "resource:"+o.resource+":"+(o.ids||[]).join(","),
        kind: KINDS.APPLIANCE,
        title: "Resource contention: "+o.resource,
        score: scoreConflict(base, [mod]),
        rationale: "Multiple tasks share a constrained resource at the same time.",
        affected: o.ids || [],
        suggestions: [
          {
            title: "Insert 5-min buffer between tasks",
            autoApply: true,
            intent: "patch",
            patch: function(plan){
              var targetId = (o.ids && o.ids[1]);
              return {
                targetId: targetId,
                apply: function(target){
                  if (!target) return target;
                  var w = windowFromItem(target);
                  if (!w) return target;
                  var shifted = scheduleHelpers.shiftWindow(w, 5);
                  return Object.assign({}, target, { timeWindow: shifted, start: shifted.start, durationMin: Math.round((shifted.end - shifted.start)/60000) });
                }
              };
            }
          }
        ]
      });
    }
    return out;
  });

  /* ----------------------------- Public API ------------------------------- */
  function score(conflict) {
    if (!conflict || typeof conflict.score === "number") return (conflict && conflict.score) || 0;
    var base = KIND_BASE[conflict.kind] || 50;
    return scoreConflict(base, []);
  }

  function suggest(conflict, ctx) {
    if (!conflict) return [];
    // Already carries suggestions; this is a compatibility wrapper
    return conflict.suggestions || [];
  }

  function getCatalog() {
    return {
      kinds: Object.keys(KINDS).map(function(k){ return KINDS[k]; }),
      domains: Object.keys(DOMAIN_BASE),
      heuristics: listHeuristics()
    };
  }

  var api = {
    analyze: analyze,
    applyAutoFixes: applyAutoFixes,
    score: score,
    suggest: suggest,
    registerHeuristic: registerHeuristic,
    listHeuristics: listHeuristics,
    getCatalog: getCatalog,
    KINDS: KINDS
  };

  /* ------------------------- Export (CJS + UMD-ish) ----------------------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof define === "function" && define.amd) {
    // eslint-disable-next-line no-undef
    define(function(){ return api; });
  } else {
    // global
    // eslint-disable-next-line no-undef
    this.ConflictHeuristics = api;
  }
}).call(typeof global !== "undefined" ? global : (typeof window !== "undefined" ? window : this));

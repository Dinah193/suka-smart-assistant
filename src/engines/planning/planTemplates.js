/* eslint-disable no-console */
// planTemplates.js — Templates Orchestrator (ES2015-safe)

(function () {
  // ------------------------------ Safe Imports ------------------------------
  var eventBus = { emit: function () {} };
  try {
    eventBus = (require("@/services/eventBus") || {}).eventBus || eventBus;
  } catch (e) {}

  var automation = null;
  try {
    automation = (require("@/services/automation/runtime") || {}).automation || null;
  } catch (e) {}

  var scoring = null; // deciderScoringEngine
  try {
    scoring = require("@/engines/deciderScoringEngine");
  } catch (e) {}

  var placement = null; // placementRules
  try {
    placement = require("@/engines/planning/placementRules");
  } catch (e) {}

  var logger = console;

  // ------------------------------- State ------------------------------------
  var REGISTRY = {}; // { id: {id, version, domain, meta, generator(ctx)=>items[], ... } }

  // ------------------------------- Utils ------------------------------------
  var DAY_MS = 24 * 60 * 60 * 1000;

  function asDate(v) { return v instanceof Date ? v : new Date(v); }
  function startOfDay(d) { var x = new Date(asDate(d)); x.setHours(0,0,0,0); return x; }
  function addDays(d, n) { return new Date(startOfDay(d).getTime() + (n * DAY_MS)); }
  function clamp(v, a, b) { if (a===void 0)a=0; if(b===void 0)b=1; return Math.max(a, Math.min(b, v)); }
  function idOf(x) { return x && (x.id || x._id || x.slug || x.title) || null; }

  function ensureArray(v) { return Array.isArray(v) ? v : (v == null ? [] : [v]); }

  function shallowClone(o) {
    var k, out = {};
    for (k in o) { if (Object.prototype.hasOwnProperty.call(o,k)) out[k] = o[k]; }
    return out;
  }

  function deepMerge() {
    var out = {};
    for (var i=0;i<arguments.length;i++){
      var o = arguments[i]; if (!o || typeof o !== "object") continue;
      var keys = Object.keys(o);
      for (var j=0;j<keys.length;j++){
        var k = keys[j], val = o[k];
        if (val && typeof val === "object" && !Array.isArray(val)) {
          out[k] = deepMerge(out[k]||{}, val);
        } else {
          out[k] = val;
        }
      }
    }
    return out;
  }

  function sabbathGuard(date, tz, forbidWrite) {
    // Basic Friday sundown to Saturday sundown guard via weekday heuristic.
    // You already have stricter guards in cleaning/grocery. Here: block "cooking sessions" if desired.
    // tz is unused in this simple version to keep ES2015-safe.
    var d = asDate(date);
    var wd = d.getDay(); // 0 Sun .. 6 Sat
    if (!forbidWrite) return false;
    // Block Saturday
    return wd === 6;
  }

  // ----------------------------- Public Schema ------------------------------
  /**
   * Template shape (lightweight):
   * {
   *   id: "weekly-balanced",
   *   version: 1,
   *   domain: "meals" | "cleaning" | "garden",
   *   meta: { title, description, author, tags:[] },
   *   defaults: { timeWindowMinutes, budgetPerServing, dietProfile, preferences },
   *   generator(ctx) => Array<{ type, recipe?, slot, meta? }>
   *     - type: "COOK" | "LEFTOVER" | "SHOP" | "CLEAN" | "HARVEST"
   *     - slot: { start: Date, mealType?: "breakfast"|"lunch"|"dinner" }
   *     - recipe: any normalized recipe candidate (for meals)
   * }
   */

  // ----------------------------- Registry API -------------------------------
  function registerTemplate(tpl) {
    if (!tpl || !tpl.id) throw new Error("Template must have an id");
    var existing = REGISTRY[tpl.id];
    if (existing && existing.version && tpl.version && tpl.version < existing.version) {
      return existing; // ignore older registrations
    }
    REGISTRY[tpl.id] = tpl;
    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit("templates:registered", { id: tpl.id, version: tpl.version || 1, domain: tpl.domain || "generic" });
      }
    } catch (e) {}
    return tpl;
  }

  function listTemplates(filter) {
    var ids = Object.keys(REGISTRY);
    var list = [];
    for (var i=0;i<ids.length;i++){
      var t = REGISTRY[ids[i]];
      if (!filter || !filter.domain || (t.domain === filter.domain)) list.push(t);
    }
    return list;
  }

  function getTemplate(id) {
    return REGISTRY[id] || null;
  }

  function loadRuntimeTemplates() {
    try {
      if (!automation || typeof automation.get !== "function") return;
      var packs = automation.get("plan.templates"); // expect array of POJOs
      if (!Array.isArray(packs)) return;
      for (var i=0;i<packs.length;i++){
        try { registerTemplate(packs[i]); } catch (e) { logger.warn("[planTemplates] bad runtime template", e); }
      }
    } catch (e) {
      logger.warn("[planTemplates] loadRuntimeTemplates failed", e);
    }
  }

  // ------------------------ Candidate Selection (Meals) ----------------------
  function selectMealCandidate(pool, ctx) {
    // Uses decider scoring to pick top recipe from a pool with user context.
    if (!Array.isArray(pool) || !pool.length) return null;
    if (!scoring || typeof scoring.scoreCandidates !== "function") {
      // Fallback: pick shortest total time then most on-hand-ish by naive heuristic
      var sorted = pool.slice().sort(function(a,b){
        var ta = Number(a.totalTimeMinutes || 0);
        var tb = Number(b.totalTimeMinutes || 0);
        if (ta !== tb) return ta - tb;
        var ia = (a.ingredients || []).length;
        var ib = (b.ingredients || []).length;
        return ia - ib;
      });
      return sorted[0];
    }
    var limit = Math.min(6, pool.length);
    var scored = scoring.scoreCandidates(pool, ctx, limit);
    return (scored && scored.length) ? pool.find(function (r) { return idOf(r) === scored[0].id; }) || pool[0] : pool[0];
  }

  // -------------------------- Template Application --------------------------
  /**
   * Apply template to date range.
   * opts: {
   *   templateId,
   *   startDate,
   *   days: number,
   *   domain: "meals"|"cleaning"|"garden",
   *   context: {
   *     plan: existing placements,
   *     inventory, timeWindowMinutes, budgetPerServing, dietProfile,
   *     preferences, applianceAvailability, calendarBusy, tz,
   *     candidatePools: { breakfast:[], lunch:[], dinner:[] } // for meals
   *   },
   *   dryRun: boolean // do not register placement if true
   * }
   *
   * Returns { items:[], blocked:[], reservations:[], reasons:[] }
   */
  function applyTemplate(opts) {
    var out = { items: [], blocked: [], reservations: [], reasons: [] };
    if (!opts || !opts.templateId) { out.reasons.push("No templateId"); return out; }

    var tpl = getTemplate(opts.templateId);
    if (!tpl) { out.reasons.push("Template not found: " + opts.templateId); return out; }

    var start = startOfDay(opts.startDate || new Date());
    var days = Number(opts.days || 7);
    var ctx = deepMerge(
      { plan: [] },
      { preferences: (tpl.defaults && tpl.defaults.preferences) || {} },
      opts.context || {}
    );

    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit("templates:apply:start", { id: tpl.id, days: days });
      }
    } catch (e) {}

    // Template "generator" produces abstract plan intents for the span
    var intents = [];
    try {
      if (typeof tpl.generator === "function") {
        intents = tpl.generator({ startDate: start, days: days, ctx: ctx }) || [];
      }
    } catch (e) {
      out.reasons.push("Template generator failed: " + e.message);
      return out;
    }

    // Resolve intents into concrete placements with rules
    for (var i=0;i<intents.length;i++){
      var intent = intents[i];

      // Sabbath guard (cooking/cleaning write-protect)
      var guard = sabbathGuard(intent.slot && intent.slot.start, ctx.tz, !!ctx.preferences && !!ctx.preferences.sabbathWriteProtect);
      if (guard && (intent.type === "COOK" || intent.type === "CLEAN")) {
        out.blocked.push({ intent: intent, reasons: ["Sabbath guard: protected time"] });
        continue;
      }

      // For meals, pick a recipe if not provided
      var recipe = intent.recipe;
      if (tpl.domain === "meals" && !recipe) {
        var mealType = (intent.slot && intent.slot.mealType) || "dinner";
        var pool = (ctx.candidatePools && ctx.candidatePools[mealType]) || [];
        recipe = selectMealCandidate(pool, ctx);
        if (!recipe) {
          out.blocked.push({ intent: intent, reasons: ["No candidate recipes available"] });
          continue;
        }
      }

      // Check placement rules and register
      if (tpl.domain === "meals" && placement && typeof placement.canPlace === "function") {
        var check = placement.canPlace(recipe, intent.slot, { 
          plan: ctx.plan,
          preferences: ctx.preferences,
          applianceAvailability: ctx.applianceAvailability,
          calendarBusy: ctx.calendarBusy
        });

        if (!check.ok) {
          out.blocked.push({ intent: intent, reasons: check.reasons, fixes: check.fixes });
          continue;
        }

        // Add reservations (e.g., leftovers)
        if (check.reservations && check.reservations.length) {
          for (var r=0;r<check.reservations.length;r++){
            out.reservations.push(check.reservations[r]);
            // Optionally reflect reservation in plan so later checks see it
            ctx.plan.push({
              recipeId: "RESV:" + (check.reservations[r].forRecipeId || idOf(recipe)),
              recipe: { title: "Leftovers" },
              slot: check.reservations[r].slot,
              meta: { type: check.reservations[r].type }
            });
          }
        }

        // Register placement into ephemeral plan unless dryRun
        if (!opts.dryRun && typeof placement.registerPlacement === "function") {
          try { placement.registerPlacement(recipe, intent.slot, ctx); } catch (e) {}
        }
      }

      // Keep item for output and also push into ctx.plan for subsequent checks
      var item = {
        type: intent.type,
        recipeId: idOf(recipe),
        recipe: recipe,
        slot: intent.slot,
        meta: intent.meta || {}
      };
      out.items.push(item);
      ctx.plan.push(item);
    }

    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit("templates:apply:done", { id: tpl.id, items: out.items.length, blocked: out.blocked.length });
      }
    } catch (e) {}

    return out;
  }

  // ---------------------------- Seed Templates ------------------------------
  // 1) Weekly Balanced Meals (Collect • Decide • Plan aligned)
  registerTemplate({
    id: "weekly-balanced-meals",
    version: 1,
    domain: "meals",
    meta: {
      title: "Weekly Balanced (Breakfast-Lunch-Dinner)",
      description: "Balanced spread that respects time/budget/diet, rotates protein/cuisine, auto-reserves leftovers.",
      tags: ["balanced","variety","leftovers","appliance-aware"]
    },
    defaults: {
      timeWindowMinutes: 45,
      budgetPerServing: 4.5,
      preferences: {
        sabbathWriteProtect: true,
        variety: {
          proteinCooldownDays: 2,
          cuisineCooldownDays: 3,
          techniqueCooldownDays: 2,
          breakfastRepeatsPerWeek: 5
        },
        leftovers: { autoPlace: true, defaultMealType: "lunch", windowDays: 2, reserveAs: "LEFTOVER" }
      }
    },
    generator: function (args) {
      var start = startOfDay(args.startDate);
      var days = Number(args.days || 7);
      var out = [];
      for (var i=0;i<days;i++){
        var d = addDays(start, i);
        // Breakfast & Lunch simple intents; Dinner is the "Decide" anchor.
        out.push({ type: "COOK", slot: { start: d, mealType: "breakfast" } });
        out.push({ type: "COOK", slot: { start: d, mealType: "lunch" } });
        out.push({ type: "COOK", slot: { start: d, mealType: "dinner" } });
      }
      // Suggest a "SHOP" action on day 0 if on-hand falls short during scoring (surfaced by NBA elsewhere).
      return out;
    }
  });

  // 2) Batch Sunday + Leftovers midweek
  registerTemplate({
    id: "batch-sunday-leftovers",
    version: 1,
    domain: "meals",
    meta: {
      title: "Sunday Batch, Weekday Leftovers",
      description: "Large Sunday dinner + midweek leftovers lunches; quick dinners Mon-Thu.",
      tags: ["batch","leftovers","quick-weeknights"]
    },
    defaults: {
      timeWindowMinutes: 30,
      budgetPerServing: 4.0,
      preferences: {
        sabbathWriteProtect: true,
        leftovers: { autoPlace: true, defaultMealType: "lunch", windowDays: 3, reserveAs: "LEFTOVER" }
      }
    },
    generator: function (args) {
      var start = startOfDay(args.startDate);
      var out = [];
      // Find upcoming Sunday within range and anchor a batch dinner there.
      for (var i=0;i<7;i++){
        var d = addDays(start, i);
        if (d.getDay() === 0) { // Sunday
          out.push({ type: "COOK", slot: { start: d, mealType: "dinner" }, meta: { batch: true } });
          // Quick dinners Mon-Thu
          for (var k=1;k<=4;k++){
            var wd = addDays(d, k);
            out.push({ type: "COOK", slot: { start: wd, mealType: "dinner" }, meta: { quick: true } });
          }
          // Friday dinner (prepped earlier or cold spread)
          out.push({ type: "COOK", slot: { start: addDays(d, 5), mealType: "dinner" }, meta: { coldPreferred: true } });
          break;
        }
      }
      return out;
    }
  });

  // 3) Cleaning Sprint (example outside meals domain)
  registerTemplate({
    id: "cleaning-week-sprint",
    version: 1,
    domain: "cleaning",
    meta: {
      title: "Weeklong Cleaning Sprint",
      description: "Light daily sessions; avoid deep clean on protected day.",
      tags: ["cleaning","sprint","routine"]
    },
    defaults: {
      preferences: { sabbathWriteProtect: true }
    },
    generator: function (args) {
      var start = startOfDay(args.startDate);
      var days = Number(args.days || 7);
      var out = [];
      for (var i=0;i<days;i++){
        var d = addDays(start, i);
        out.push({ type: "CLEAN", slot: { start: d }, meta: { intensity: "light" } });
      }
      return out;
    }
  });

  // Load runtime-provided templates if your automation runtime has them
  loadRuntimeTemplates();

  // ------------------------------- Exports -----------------------------------
  module.exports = {
    registerTemplate: registerTemplate,
    listTemplates: listTemplates,
    getTemplate: getTemplate,
    applyTemplate: applyTemplate
  };
})();

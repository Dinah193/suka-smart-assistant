// C:\Users\larho\suka-smart-assistant\src\plans\cooking\roastLamb.plan.js
/* eslint-disable no-console */
/**
 * roastLamb.plan.js — Dynamic Roast Lamb plan (ES2015-safe, event-driven)
 *
 * Goals hit:
 *  • Dynamic: adjusts for cut, size, doneness, brine/marinade, sides, and oven behavior
 *  • Intuitive: clear steps, timers, offsets (+20m / PT1H), auto-toasts/NBA nudges
 *  • Orchestrated: emits domain-aware events, optional calendar write, inventory checks
 *  • Favorites: users can save their own tuned variants (FavoritePlans)
 *  • Pause/Safety: integrates pausePolicies (freeze/continue), Sabbath guard, withhold windows
 *
 * Works even if optional engines/managers are missing (defensive requires).
 */

(function () {
  /* ------------------------------ Defensive deps ------------------------------ */
  var logger = console;

  // Event bus (optional, safe fallback)
  var eventBus = { emit: function () {}, on: function(){}, off: function(){} };
  try {
    var eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  // Offset parser (+20m, PT1H, "tomorrow 5pm" → ms)
  var parseOffset = function (s) { return 0; };
  try {
    parseOffset = (require("@/services/session/utils/offsetParser") || {}).parseOffset || parseOffset;
  } catch (_e) {}

  // Pause policies (freeze/continue/safety windows)
  var pausePolicies = {
    shouldFreezeTask: function(){ return false; },
    canContinueTask: function(){ return true; },
    safetyWindowActive: function(){ return false; }
  };
  try {
    pausePolicies = require("@/services/session/policies/pausePolicies") || pausePolicies;
  } catch (_e) {}

  // Inventory utilities (ensure items on hand, shortages event)
  var inventoryGuard = {
    ensureItemsOnHand: function(){ return { ok: true, missing: [] }; },
    asSKUs: function(items){ return items || []; }
  };
  try {
    inventoryGuard = require("@/services/session/guards/inventoryGuard") || inventoryGuard;
  } catch (_e) {}

  // Automation runtime (for reminders / nudges)
  var automation = { schedule: function(){}, cancel: function(){} };
  try {
    var ar = require("@/services/automation/runtime");
    automation = (ar && (ar.automation || ar.default)) || automation;
  } catch (_e) {}

  // Calendar sync (optional write of session to user calendar)
  var calendarSync = { queueWrite: function(){}, writeSessionBlock: function(){} };
  try {
    calendarSync = require("@/services/calendar/calendarSync") || calendarSync;
  } catch (_e) {}

  // Favorites manager (persist user-saved plans)
  var FavoritePlans = {
    save: function(){ return { id: "fav:local" }; },
    listByKey: function(){ return []; },
    load: function(){ return null; }
  };
  try {
    FavoritePlans = require("@/managers/FavoritePlans") || FavoritePlans;
  } catch (_e) {}

  // Schedule helpers (PPE, weather, withhold times)
  var scheduleHelpers = {
    withholdWindows: function(){ return []; },
    suggestPPE: function(){ return []; },
    weatherAdvisory: function(){ return null; }
  };
  try {
    scheduleHelpers = require("@/services/session/scheduleHelpers") || scheduleHelpers;
  } catch (_e) {}

  // Estimate engine (optional cost summary)
  var estimateEngine = { estimateCost: function(){ return null; } };
  try {
    estimateEngine = require("@/services/session/estimateEngine") || estimateEngine;
  } catch (_e) {}

  /* -------------------------------- Constants -------------------------------- */
  var DOMAIN = "cooking";
  var PLAN_KEY = "plan:cooking:roast-lamb";
  var VERSION = "2.2.0"; // dynamic + favorites + calendar + shortages + safety

  var CUT_PROFILES = {
    "leg":              { sear: true, fatCap: true },
    "shoulder":         { sear: true, fatCap: true, lowAndSlowBias: true },
    "rack":             { sear: false, hotRoast: true },
    "loin":             { sear: true, moderate: true }
  };

  var DONENESS_TARGETS = {
    rare:   { tempF: 125, window: [122,128], perLbMin: 18, finishBoostF: 500, restMin: 15 },
    medrare:{ tempF: 130, window: [127,133], perLbMin: 20, finishBoostF: 500, restMin: 15 },
    medium: { tempF: 140, window: [137,143], perLbMin: 22, finishBoostF: 475, restMin: 20 },
    medwell:{ tempF: 150, window: [147,153], perLbMin: 25, finishBoostF: 450, restMin: 25 },
    well:   { tempF: 160, window: [157,163], perLbMin: 28, finishBoostF: 425, restMin: 25 }
  };

  /* ------------------------------- Small helpers ------------------------------ */
  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

  function roundTo(n, base){ return Math.round(n / base) * base; }

  function calcRoastMinutes(weightLb, donenessKey, altitudeFt, ovenRunsCool) {
    var base = (DONENESS_TARGETS[donenessKey] || DONENESS_TARGETS.medium).perLbMin;
    var minutes = weightLb * base;

    // Altitude: +7% per 3000 ft (approx)
    if (altitudeFt && altitudeFt > 0) {
      var altBumps = Math.floor(altitudeFt / 3000);
      minutes *= (1 + (0.07 * altBumps));
    }

    // Oven calibration bias (user claims oven runs cool: +8%)
    if (ovenRunsCool) minutes *= 1.08;

    // Shoulder low-and-slow bias added later via options.cut
    return roundTo(minutes, 5);
  }

  function computeTempPlan(donenessKey, cut) {
    var d = DONENESS_TARGETS[donenessKey] || DONENESS_TARGETS.medium;
    var profile = CUT_PROFILES[cut] || {};
    var firstStage = profile.hotRoast ? 450 : 350;
    var finishBoost = d.finishBoostF;

    // Shoulder gets lower/longer baseline
    if (profile.lowAndSlowBias) {
      firstStage = 325;
      finishBoost = clamp(finishBoost - 25, 375, 500);
    }

    return { preheatF: firstStage, finishF: finishBoost, targetTempF: d.tempF, restMin: d.restMin };
  }

  function buildIngredients(opts) {
    var people = opts.servings || 6;
    var weightLb = opts.weightLb || clamp(people * 0.5, 3, 8); // ~0.5 lb/person, min 3 lb, max 8 lb

    return [
      { sku: "MEAT-LAMB-" + (opts.cut || "leg").toUpperCase(), name: "Lamb " + (opts.cut || "leg"), qty: weightLb, uom: "lb" },
      { sku: "PROD-GARLIC-FRESH", name: "Garlic cloves", qty: 6, uom: "each" },
      { sku: "PROD-ROSEMARY-FRESH", name: "Fresh rosemary", qty: 4, uom: "sprigs" },
      { sku: "PROD-THYME-FRESH", name: "Fresh thyme", qty: 6, uom: "sprigs" },
      { sku: "PAN-SALT-KOSHER", name: "Kosher salt", qty: 2, uom: "tbsp" },
      { sku: "PAN-PEPPER-BLACK", name: "Black pepper", qty: 1, uom: "tbsp" },
      { sku: "OIL-OLIVE-EVOO", name: "Olive oil", qty: 3, uom: "tbsp" },
      { sku: "PROD-LEMON", name: "Lemon (zest + juice)", qty: 1, uom: "each", optional: true },
      { sku: "PAN-MUSTARD-DIJON", name: "Dijon mustard", qty: 1, uom: "tbsp", optional: true },
      { sku: "STAPLE-THERMOMETER", name: "Instant-read thermometer", qty: 1, uom: "each" },
      // Sides (optional; user may toggle in UI)
      { sku: "PROD-POTATO-RUSSET", name: "Potatoes (roast)", qty: people, uom: "each", optional: true },
      { sku: "PROD-CARROT", name: "Carrots", qty: people, uom: "each", optional: true },
      // Gravy thickener option honoring user's whole grain preference across the system
      { sku: "PAN-FLOUR-WHOLEGRAIN", name: "Fresh-ground whole grain flour", qty: 2, uom: "tbsp", optional: true }
    ];
  }

  function stepsFor(opts) {
    var cut = (opts.cut || "leg").toLowerCase();
    var donenessKey = (opts.doneness || "medrare").toLowerCase();
    var altitudeFt = +opts.altitudeFt || 0;
    var ovenRunsCool = !!opts.ovenRunsCool;
    var marinadeHours = clamp(+opts.marinadeHours || 0, 0, 24);
    var weightLb = +opts.weightLb || clamp((opts.servings || 6) * 0.5, 3, 8);

    var roastMinutes = calcRoastMinutes(weightLb, donenessKey, altitudeFt, ovenRunsCool);
    var tplan = computeTempPlan(donenessKey, cut);
    var profile = CUT_PROFILES[cut] || {};

    var searStep = profile.sear ? [{
      id: "sear",
      label: "Sear fat cap",
      details: "Heat a heavy pan until very hot. Sear lamb on fat side 2–3 min until deep golden.",
      kind: "cook",
      durationMs: 3 * 60 * 1000,
      appliance: "stovetop",
      pausePolicy: "continue",            // can continue through short pauses
      ppe: scheduleHelpers.suggestPPE({ domain: DOMAIN, context: "sear" })
    }] : [];

    var marinadeSteps = marinadeHours > 0 ? [{
      id: "marinate",
      label: "Marinate the lamb",
      details: "Score fat. Mash garlic, rosemary, thyme, salt, pepper, lemon zest, Dijon with oil. Rub all over the lamb. Cover and marinate in fridge.",
      kind: "prep",
      durationMs: marinadeHours * 60 * 60 * 1000,
      appliance: "fridge",
      canPause: true,
      pausePolicy: "freeze",              // safe to freeze this timer on pause
      reminders: [
        { atOffset: "-30m", message: "Pull lamb from fridge soon so it can lose its chill." }
      ]
    }] : [];

    var sidesParallel = opts.includeSides ? [{
      id: "prep-sides",
      label: "Prep sides (optional)",
      details: "Cut potatoes & carrots; toss with oil, salt, pepper. Start roasting when lamb goes into oven.",
      kind: "prep",
      durationMs: 10 * 60 * 1000,
      canRunParallel: true
    }] : [];

    var roastBlocks = [{
      id: "preheat",
      label: "Preheat oven",
      details: "Set oven to " + tplan.preheatF + "°F. Position rack middle.",
      kind: "prep",
      durationMs: 10 * 60 * 1000,
      appliance: "oven",
      pausePolicy: "continue"
    }].concat(searStep).concat([
      {
        id: "roast-stage",
        label: "Roast lamb",
        details: "Transfer lamb to rack in roasting pan. Insert thermometer into thickest part. Roast until " + DONENESS_TARGETS[donenessKey].window[0] + "–" + DONENESS_TARGETS[donenessKey].window[1] + "°F.",
        kind: "cook",
        durationMs: roastMinutes * 60 * 1000,
        appliance: "oven",
        targetTempF: tplan.targetTempF,
        finishBoostF: tplan.finishF,
        reminders: [
          { atOffset: "-20m", message: "Baste lamb (optional) and rotate pan for even browning." },
          { atOffset: "+0",   message: "Check internal temp now; do not overshoot." }
        ],
        pausePolicy: "safety", // long cook: respect withhold windows & sabbath guard
        safetyWindows: scheduleHelpers.withholdWindows({ domain: DOMAIN }) || []
      },
      {
        id: "finish-boost",
        label: "Finish at " + tplan.finishF + "°F (short)",
        details: "Increase heat briefly to build crust if needed; monitor closely.",
        kind: "cook",
        durationMs: 5 * 60 * 1000,
        appliance: "oven",
        optional: true,
        skipIf: function (ctx) { return (ctx && ctx.crustIsGood) || false; }
      },
      {
        id: "rest",
        label: "Rest the roast",
        details: "Tent with foil. Rest " + tplan.restMin + " min to redistribute juices.",
        kind: "rest",
        durationMs: tplan.restMin * 60 * 1000,
        appliance: "counter",
        reminders: [
          { atOffset: "+0", message: "Start gravy now (optional). Use pan drippings + stock; thicken with fresh-ground whole grain flour if desired." }
        ],
        pausePolicy: "continue"
      },
      {
        id: "carve",
        label: "Carve & serve",
        details: "Slice against the grain. Taste for salt & lemon. Serve with roasted veg.",
        kind: "serve",
        durationMs: 5 * 60 * 1000
      }
    ]).concat(sidesParallel);

    return [].concat(marinadeSteps).concat(roastBlocks);
  }

  /* --------------------------------- Plan API -------------------------------- */
  function createPlan(userOpts) {
    var opts = userOpts || {};
    var cut = (opts.cut || "leg").toLowerCase();
    var doneness = (opts.doneness || "medrare").toLowerCase();
    var servings = +opts.servings || 6;

    var ingredients = buildIngredients({ servings: servings, cut: cut, weightLb: opts.weightLb, doneness: doneness });
    var steps = stepsFor({
      cut: cut,
      doneness: doneness,
      altitudeFt: opts.altitudeFt,
      ovenRunsCool: opts.ovenRunsCool,
      marinadeHours: opts.marinadeHours,
      weightLb: opts.weightLb,
      servings: servings,
      includeSides: !!opts.includeSides
    });

    var plan = {
      $schema: "urn:suka:contracts:cookplan",   // future cooking contract alignment
      id: PLAN_KEY + ":" + VERSION,
      key: PLAN_KEY,
      version: VERSION,
      xDomain: DOMAIN,
      template: "roast-lamb",
      title: "Roast Lamb (" + cut + ", " + doneness + ")",
      synopsis: "A flexible roast lamb plan that adapts to cut, size, doneness, and kitchen quirks.",
      tags: ["lamb", "roast", "holiday", "protein", "oven", cut, doneness],
      metadata: {
        author: "Suka Smart Assistant",
        altitudeFt: +opts.altitudeFt || 0,
        ovenRunsCool: !!opts.ovenRunsCool,
        sabbathGuard: true
      },
      options: {
        cut: cut,
        doneness: doneness,
        servings: servings,
        marinadeHours: +opts.marinadeHours || 0,
        includeSides: !!opts.includeSides,
        weightLb: +opts.weightLb || null
      },
      ingredients: ingredients,
      steps: steps,
      // Computed hints for UI
      metrics: (function () {
        var cookMs = 0;
        for (var i = 0; i < steps.length; i++) cookMs += steps[i].durationMs || 0;
        var activeMs = 0;
        for (var j = 0; j < steps.length; j++) {
          var s = steps[j];
          if (s.kind === "prep" || s.kind === "serve" || s.kind === "cook") activeMs += Math.min(s.durationMs || 0, 10 * 60 * 1000); // crude "active" proxy
        }
        return {
          totalMinutes: Math.round(cookMs / 60000),
          activeMinutes: Math.round(activeMs / 60000)
        };
      })()
    };

    // Optional inventory check (domain-aware shortage event)
    try {
      var skus = inventoryGuard.asSKUs(plan.ingredients);
      var res = inventoryGuard.ensureItemsOnHand({ skus: skus, domain: DOMAIN });
      if (!res.ok && res.missing && res.missing.length) {
        eventBus.emit("inventory.shortage.detected", {
          domain: DOMAIN,
          planKey: PLAN_KEY,
          missing: res.missing
        });
      }
    } catch (_e) {}

    // Optional estimated cost
    try {
      var estimate = estimateEngine.estimateCost({ items: plan.ingredients, domain: DOMAIN });
      if (estimate) plan.estimate = estimate;
    } catch (_e) {}

    return plan;
  }

  /* ------------------------------- Session glue ------------------------------- */
  function startSession(opts) {
    var plan = createPlan(opts || {});
    var nowMs = Date.now();

    // Announce (domain-aware)
    eventBus.emit("mealplan.draft.requested", { domain: DOMAIN, planKey: PLAN_KEY, options: opts || {} });
    eventBus.emit("prep.tasks.requested", { domain: DOMAIN, planKey: PLAN_KEY, steps: plan.steps });

    // NBA nudges for near-term actions (preheat, pull from fridge)
    try {
      for (var i = 0; i < plan.steps.length; i++) {
        var st = plan.steps[i];
        if (!st.reminders) continue;
        for (var r = 0; r < st.reminders.length; r++) {
          var rem = st.reminders[r];
          var when = nowMs + (parseOffset(rem.atOffset) || 0);
          automation.schedule({
            title: "Roast Lamb • " + st.label,
            prompt: "Tell me to: " + (rem.message || ("Remember " + st.label)),
            schedule: "BEGIN:VEVENT\nDTSTART:" + new Date(when).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z") + "\nEND:VEVENT"
          });
        }
      }
    } catch (_e) {}

    // Calendar write (single block from now for plan.metrics.totalMinutes)
    try {
      var totalMin = (plan.metrics && plan.metrics.totalMinutes) || 120;
      calendarSync.queueWrite([{
        title: "Cooking: " + plan.title,
        start: new Date(nowMs).toISOString(),
        end: new Date(nowMs + totalMin * 60 * 1000).toISOString(),
        location: "Home Kitchen",
        description: "Auto-scheduled by Suka • " + plan.synopsis
      }]);
    } catch (_e) {}

    return plan;
  }

  /* --------------------------- Favorites (user-owned) ------------------------- */
  /**
   * Save a user-tuned variant as their favorite.
   * @param {string} userId
   * @param {object} overrides - any createPlan options plus custom title/notes/tags
   * @returns {object} favoriteRef
   */
  function saveAsFavorite(userId, overrides) {
    var plan = createPlan(overrides || {});
    var fav = {
      key: PLAN_KEY,
      version: VERSION,
      domain: DOMAIN,
      title: overrides && overrides.title ? overrides.title : plan.title,
      notes: overrides && overrides.notes || "",
      tags: (plan.tags || []).concat(overrides && overrides.tags || []).filter(Boolean),
      options: plan.options,
      ingredients: plan.ingredients,
      steps: plan.steps,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    try {
      var ref = FavoritePlans.save(userId, fav);
      eventBus.emit("plan.favorite.saved", { domain: DOMAIN, planKey: PLAN_KEY, userId: userId, ref: ref });
      return ref;
    } catch (e) {
      logger.warn("[roastLamb.plan] Favorite save failed:", e && e.message);
      return { error: true, message: "Favorite save failed" };
    }
  }

  function listFavorites(userId) {
    try {
      return FavoritePlans.listByKey(userId, PLAN_KEY) || [];
    } catch (_e) {
      return [];
    }
  }

  function loadFavorite(userId, favId) {
    try {
      return FavoritePlans.load(userId, favId);
    } catch (_e) {
      return null;
    }
  }

  /* -------------------------------- Exports ---------------------------------- */
  var api = {
    key: PLAN_KEY,
    version: VERSION,
    domain: DOMAIN,
    title: "Roast Lamb",
    synopsis: "Dynamic roast lamb with cut, doneness, and schedule intelligence.",
    // Core
    createPlan: createPlan,
    startSession: startSession,
    // Favorites
    saveAsFavorite: saveAsFavorite,
    listFavorites: listFavorites,
    loadFavorite: loadFavorite,
    // Hints
    defaults: {
      cut: "leg",
      doneness: "medrare",
      servings: 6,
      marinadeHours: 0,
      includeSides: true,
      altitudeFt: 0,
      ovenRunsCool: false
    }
  };

  // CommonJS + ESM friendly
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    try { window.roastLambPlan = api; } catch (_e) {}
  }
})();

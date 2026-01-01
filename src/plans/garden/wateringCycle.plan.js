// C:\Users\larho\suka-smart-assistant\src\plans\garden\wateringCycle.plan.js
/* eslint-disable no-console */
/**
 * wateringCycle.plan.js — Domain-aware watering/irrigation plan
 * Dynamic, favorite-able, and orchestration-ready.
 *
 * Goals:
 *  • Works out-of-the-box via in-file templates, but will defer to GardenPlanTemplates if available.
 *  • Users can "Adopt & Save" their own plan variants (favorites) — emits events and carries stable ids.
 *  • Session-ready: step graph, timers, guards (inventory/weather/withhold), schedule hints.
 *  • Inventory-aware SKUs (filters, gaskets, batteries, emitters), zone-based logic, drought-safe.
 *  • Calendar-friendly: includes calendar write hints and recurrence rules.
 *
 * Contracts & Events:
 *  • Data contract: urn:suka:contracts:gardenplan (see /src/data/contracts/gardenplan.contract.json)
 *  • Event catalog (already in system):
 *      - inventory.shortage.detected   (domain-aware)
 *      - planner.conflict.detected     (kind: time|appliance|weather|biohazard)
 *      - prep.tasks.requested          (params.domain)
 *      - garden.plan.favorite.requested / garden.plan.favorite.saved
 *      - schedule.event.write.requested (calendarSync picks these up)
 *
 * Shared Orchestration:
 *  • inventoryGuard.js, pausePolicies.js, offsetParser.js
 *  • PrepSessionOrchestrator.js, sessionExecutionEngine, scheduleHelpers.js
 */

(function () {
  /* ------------------------------ Safe Imports ------------------------------ */
  var eventBus = { on: function(){}, off: function(){}, emit: function(){} };
  try {
    var eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  var inventoryGuard = { ensureOnHand: function(){ return { ok:true, missing:[] }; } };
  try { inventoryGuard = require("@/services/session/guards/inventoryGuard"); } catch (_e) {}

  var offsetParser = { parse: function (s){ return { ms:0 }; } };
  try { offsetParser = require("@/services/session/utils/offsetParser"); } catch (_e) {}

  var pausePolicies = { SAFETY_WINDOW_MINUTES: 30, canRunNow: function(){ return true; } };
  try { pausePolicies = require("@/services/session/policies/pausePolicies"); } catch (_e) {}

  // Optional central templates library — if present, we’ll defer to it.
  var GardenPlanTemplates = null;
  try { GardenPlanTemplates = require("@/libraries/GardenPlanTemplates"); } catch (_e) {}

  /* ------------------------------ ID Helpers -------------------------------- */
  var rnd = function () { return Math.random().toString(36).slice(2, 8); };
  var stableId = function (base, householdId) {
    return ("gardenplan:" + base + (householdId ? (":" + householdId) : "")).toLowerCase();
  };

  /* ------------------------ Favorite/Save Integration ------------------------ */
  /**
   * Emits a favorite request; SavePlanButton / FavoritePicker listen for this and open modal.
   * Downstream will persist to local DB (Dexie) and/or cloud (Drive/File Device Export) per user’s choice.
   */
  function requestFavoriteAdoption(plan, options) {
    var payload = {
      domain: "garden",
      plan,
      options: options || {},
      favoriteKey: plan.meta.defaultFavoriteKey || ("garden:" + plan.slug),
      timestamp: Date.now()
    };
    eventBus.emit("garden.plan.favorite.requested", payload);
    return payload;
  }

  /* ------------------------------ Supplies/SKUs ------------------------------ */
  // Domain-aware consumables & spares to pre-check via inventoryGuard.
  var SUPPLIES = {
    "irrigation.filter.inline.3/4in": { label: "Inline Filter 3/4\"", unit: "ea", min: 1 },
    "irrigation.emitter.2gph":        { label: "Drip Emitters 2 GPH",  unit: "ea", min: 12 },
    "hose.gasket.standard":           { label: "Hose Gaskets",         unit: "ea", min: 6 },
    "battery.aa":                     { label: "AA Batteries (Timer)", unit: "ea", min: 2 },
    "teflon.tape":                    { label: "PTFE Thread Seal Tape",unit: "roll", min: 1 },
    "mulch.chips.cuft":               { label: "Mulch (cubic ft)",     unit: "cuft", min: 2 }
  };

  /* ------------------------------ Templates --------------------------------- */
  /**
   * 1) timed-drip: Zone-based daily/alternate-day cycles (drip-first design)
   * 2) deep-soak: Less frequent, longer soak for raised beds and perennials
   */
  var INFILE_TEMPLATES = {
    "timed-drip": function timedDripTemplate(opts) {
      var householdId = opts.householdId || "household";
      var zones = (opts.zones && opts.zones.length ? opts.zones : [
        { id: "front-beds",  label: "Front Beds",  minutes: 20, start: "06:00" },
        { id: "kitchen-herb",label: "Kitchen Herb",minutes: 12, start: "06:25" },
        { id: "rear-rows",   label: "Rear Vegetable Rows", minutes: 25, start: "06:40" }
      ]);

      var recurrence = opts.recurrence || "RRULE:FREQ=DAILY;BYHOUR=6;BYMINUTE=0;BYSECOND=0";
      var slug = "wateringCycle:timed-drip";
      var planId = stableId(slug, householdId);

      // Step graph (session-capable)
      var steps = zones.map(function (z, i) {
        return {
          id: "zone-" + z.id,
          title: "Water " + z.label,
          description: "Run drip for " + z.minutes + " min. Ensure emitters are not clogged.",
          kind: "water",
          appliance: "irrigation",
          zone: z.id,
          startOffset: offsetParser.parse("+" + (i === 0 ? "0m" : (zones[i-1].minutes + 5) + "m")).ms, // 5m buffer
          durationMs: (z.minutes * 60 * 1000),
          parallelGroup: null,
          guards: {
            withhold: {
              // Weather-aware withhold (handled by pausePolicies/scheduleHelpers)
              // Examples: freeze, heavy rain forecast, drought restrictions windows.
              reason: "weather|withhold",
              policy: "auto" // let pausePolicies decide
            }
          }
        };
      });

      return {
        "$id": planId,
        "$schema": "urn:suka:contracts:gardenplan",
        type: "wateringCycle",
        slug: slug,
        meta: {
          title: "Daily Drip Watering — Zone Schedule",
          subtitle: "Efficient morning watering for beds, herbs, and rows",
          domain: "garden",
          version: "1.0.0",
          favoriteable: true,
          defaultFavoriteKey: "garden:wateringCycle:timed-drip",
          exportable: true, // enables Save to Device / Cloud in the SavePlan modal
          icon: "sprout",
          tags: ["watering", "drip", "zones", "morning", "automation-ready"],
          createdAt: Date.now()
        },
        params: {
          droughtMode: !!opts.droughtMode,
          weatherStationId: opts.weatherStationId || null,
          soilMoistureSensorIds: opts.soilMoistureSensorIds || [],
          zones: zones
        },
        inventory: {
          required: Object.keys(SUPPLIES).map(function (sku) {
            return { sku: sku, ...SUPPLIES[sku] };
          })
        },
        schedule: {
          recurrence: recurrence,
          startTimeLocal: zones[0]?.start || "06:00",
          calendar: {
            write: true,
            title: "Garden — Watering (Timed Drip)",
            reminders: [{ minutesBefore: 5, method: "popup" }]
          }
        },
        steps: steps,
        nudgeRules: [
          { kind: "precheck", message: "Quick emitter check: look for geysers or clogs." },
          { kind: "post", message: "Mulch exposed soil to reduce evaporation." }
        ],
        emitOnLoad: [
          { event: "prep.tasks.requested", payload: { domain: "garden", planId: planId } }
        ]
      };
    },

    "deep-soak": function deepSoakTemplate(opts) {
      var householdId = opts.householdId || "household";
      var zones = (opts.zones && opts.zones.length ? opts.zones : [
        { id: "perennial-beds", label: "Perennial Beds", minutes: 45, start: "19:00" },
        { id: "raised-beds",    label: "Raised Beds",    minutes: 35, start: "19:50" }
      ]);

      var recurrence = opts.recurrence || "RRULE:FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=19;BYMINUTE=0;BYSECOND=0";
      var slug = "wateringCycle:deep-soak";
      var planId = stableId(slug, householdId);

      var steps = zones.map(function (z, i) {
        return {
          id: "zone-" + z.id,
          title: "Deep Soak — " + z.label,
          description: "Long soak for deep root hydration. Avoid runoff.",
          kind: "water",
          appliance: "irrigation",
          zone: z.id,
          startOffset: offsetParser.parse("+" + (i === 0 ? "0m" : (zones[i-1].minutes + 10) + "m")).ms, // 10m buffer
          durationMs: (z.minutes * 60 * 1000),
          guards: {
            withhold: { reason: "weather|withhold", policy: "auto" }
          }
        };
      });

      return {
        "$id": planId,
        "$schema": "urn:suka:contracts:gardenplan",
        type: "wateringCycle",
        slug: slug,
        meta: {
          title: "Deep Soak — Perennials & Raised Beds",
          subtitle: "Less frequent, longer watering for deep roots",
          domain: "garden",
          version: "1.0.0",
          favoriteable: true,
          defaultFavoriteKey: "garden:wateringCycle:deep-soak",
          exportable: true,
          icon: "droplets",
          tags: ["watering", "deep-soak", "perennial", "raised-beds", "evening"],
          createdAt: Date.now()
        },
        params: {
          droughtMode: !!opts.droughtMode,
          weatherStationId: opts.weatherStationId || null,
          soilMoistureSensorIds: opts.soilMoistureSensorIds || [],
          zones: zones
        },
        inventory: {
          required: Object.keys(SUPPLIES).map(function (sku) {
            return { sku: sku, ...SUPPLIES[sku] };
          })
        },
        schedule: {
          recurrence: recurrence,
          startTimeLocal: zones[0]?.start || "19:00",
          calendar: {
            write: true,
            title: "Garden — Watering (Deep Soak)",
            reminders: [{ minutesBefore: 10, method: "popup" }]
          }
        },
        steps: steps,
        nudgeRules: [
          { kind: "precheck", message: "Check mulch coverage; add if soil is exposed." },
          { kind: "post", message: "Spot-check 2–3 soil areas to confirm soak depth." }
        ],
        emitOnLoad: [
          { event: "prep.tasks.requested", payload: { domain: "garden", planId: planId } }
        ]
      };
    }
  };

  /* -------------------------- Shortage Check Helper -------------------------- */
  function checkInventory(plan) {
    try {
      var result = inventoryGuard.ensureOnHand({
        domain: "garden",
        items: (plan.inventory?.required || []).map(function (r) {
          return { sku: r.sku, min: r.min, label: r.label };
        })
      });
      if (!result.ok && result.missing && result.missing.length) {
        eventBus.emit("inventory.shortage.detected", {
          domain: "garden",
          planId: plan.$id,
          missing: result.missing
        });
      }
      return result;
    } catch (e) {
      console.warn("[wateringCycle] inventory check failed", e);
      return { ok: true, missing: [] };
    }
  }

  /* --------------------------- Weather/Pause Helper -------------------------- */
  function canRunNowContextual() {
    try {
      return !!pausePolicies.canRunNow({ domain: "garden", kind: "weather|withhold" });
    } catch (_e) {
      return true;
    }
  }

  /* ------------------------------ Factory API -------------------------------- */
  /**
   * createWateringCycle — the public factory for this plan.
   * @param {Object} options
   *  - templateId: "timed-drip" | "deep-soak"
   *  - zones: [{ id, label, minutes, start }]
   *  - recurrence: iCal RRULE (string)
   *  - householdId, droughtMode, weatherStationId, soilMoistureSensorIds
   *  - autoFavorite: bool (if true, emit favorite request immediately)
   */
  function createWateringCycle(options) {
    options = options || {};
    var templateId = options.templateId || "timed-drip";

    // If the central library exists and has this template, use it.
    if (GardenPlanTemplates && GardenPlanTemplates.get) {
      var libTpl = GardenPlanTemplates.get("wateringCycle:" + templateId, options);
      if (libTpl) {
        // ensure fields we rely on exist
        libTpl.meta = libTpl.meta || {};
        libTpl.meta.domain = "garden";
        libTpl.meta.favoriteable = true;
        libTpl.meta.exportable = true;
        libTpl.slug = libTpl.slug || ("wateringCycle:" + templateId);
        // run inventory precheck
        checkInventory(libTpl);
        if (options.autoFavorite) requestFavoriteAdoption(libTpl, { reason: "autoFavorite" });
        // Calendar write request hint
        if (libTpl?.schedule?.calendar?.write) {
          eventBus.emit("schedule.event.write.requested", {
            domain: "garden",
            planId: libTpl.$id,
            title: libTpl.schedule.calendar.title || libTpl.meta.title,
            recurrence: libTpl.schedule.recurrence,
            startTimeLocal: libTpl.schedule.startTimeLocal
          });
        }
        return libTpl;
      }
    }

    // Fallback to in-file templates
    var builder = INFILE_TEMPLATES[templateId];
    if (!builder) {
      console.warn("[wateringCycle] Unknown templateId:", templateId, "— defaulting to timed-drip.");
      builder = INFILE_TEMPLATES["timed-drip"];
    }

    var plan = builder(options || {});
    // Inventory precheck + domain-aware shortage event
    checkInventory(plan);

    // Calendar write request hint (picked up by calendarSync.js)
    if (plan?.schedule?.calendar?.write) {
      eventBus.emit("schedule.event.write.requested", {
        domain: "garden",
        planId: plan.$id,
        title: plan.schedule.calendar.title || plan.meta.title,
        recurrence: plan.schedule.recurrence,
        startTimeLocal: plan.schedule.startTimeLocal
      });
    }

    // Optionally mark as favorite immediately
    if (options.autoFavorite) requestFavoriteAdoption(plan, { reason: "autoFavorite" });

    return plan;
  }

  /* ------------------------------- Run Helpers ------------------------------- */
  /**
   * attachRuntimeHooks — Adds lightweight runtime helpers consumers can call.
   *  plan.runtime.requestFavorite() => opens Save modal via event
   *  plan.runtime.canRunNow() => uses pausePolicies
   */
  function attachRuntimeHooks(plan) {
    plan.runtime = plan.runtime || {};
    plan.runtime.requestFavorite = function (opt) { return requestFavoriteAdoption(plan, opt); };
    plan.runtime.canRunNow = function () { return canRunNowContextual(); };
    return plan;
  }

  /* --------------------------------- Exports --------------------------------- */
  var api = {
    create: function (options) {
      var plan = createWateringCycle(options || {});
      return attachRuntimeHooks(plan);
    },
    templates: Object.keys(INFILE_TEMPLATES),
    supplies: SUPPLIES
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else if (typeof window !== "undefined") window.WateringCyclePlan = api;
})();

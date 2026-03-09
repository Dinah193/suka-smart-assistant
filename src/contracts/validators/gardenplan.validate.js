/* eslint-disable no-console */
/**
 * gardenplan.validate.js — Canonical validator/normalizer for Garden Plans (ES2015-safe)
 *
 * Integrations (defensive):
 *  - eventBus               (@/services/events/eventBus)
 *  - scheduleHelpers        (@/services/scheduleHelpers)   // harden-off, seed-soak/stratify, preheat greenhouse, irrigation timers
 *  - placementRules         (@/engines/placementRules)     // zone/weather/species, companion/antagonist, crop rotation
 *  - workPrepConsolidation  (@/engines/workPrepConsolidation) // batching by bed/tool/waterline
 *  - listBuilder            (@/engines/listBuilder)        // seed/soil/irrigation SKUs consolidation
 *
 * Emits:
 *  - gardenplan.validated
 *  - gardenplan.validation_failed
 *  - nba.updated (scope: "garden")
 */

(function () {
  // ----------------------------- Safe Imports -----------------------------
  function safeRequire(path) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      var mod = require(path);
      return mod && (mod.default || mod);
    } catch (e) {
      return null;
    }
  }

  var eventBus = (safeRequire("@/services/events/eventBus") || {}).eventBus ||
    (safeRequire("@/services/events/eventBus") || {}).default || {
      emit: function () {},
      on: function () {},
      off: function () {},
    };

  var scheduleHelpers =
    safeRequire("@/services/scheduleHelpers") ||
    safeRequire("../../services/scheduleHelpers") ||
    {};

  var placementRules = safeRequire("@/engines/placementRules") || {};
  var workPrepConsolidation =
    safeRequire("@/engines/workPrepConsolidation") || {};
  var listBuilder = safeRequire("@/engines/listBuilder") || {};

  var AjvCtor = safeRequire("ajv/dist/2020") || safeRequire("ajv");
  var addFormats =
    safeRequire("ajv-formats") ||
    function () {
      return function () {};
    };

  // ----------------------------- Utilities -----------------------------
  var ID_RX = /^[a-z]+:[A-Za-z0-9_\-:.]+$/;
  function nowISO() {
    return new Date().toISOString();
  }

  function toISO(d) {
    if (!d) return null;
    if (typeof d === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d))
        return new Date(d + "T00:00:00Z").toISOString();
      if (!isNaN(Date.parse(d))) return new Date(d).toISOString();
      return null;
    }
    if (d instanceof Date) return d.toISOString();
    return null;
  }

  function coerceArray(x) {
    return x == null ? [] : Array.isArray(x) ? x : [x];
  }

  function ensureId(prefix, idCandidate) {
    var base = (idCandidate || "").toString().trim();
    if (base && ID_RX.test(base)) return base;
    var rand = Math.random().toString(36).slice(2, 10);
    return prefix + ":" + rand;
  }

  function uniqueBy(arr, keyFn) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = keyFn(arr[i], i);
      if (seen[k]) continue;
      seen[k] = true;
      out.push(arr[i]);
    }
    return out;
  }

  function byIdMap(arr) {
    var map = Object.create(null);
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && arr[i].id) map[arr[i].id] = arr[i];
    }
    return map;
  }

  function minutesOverlap(aStart, aDur, bStart, bDur) {
    if (!aStart || !bStart) return false;
    var a0 = Date.parse(aStart),
      a1 = a0 + (Number(aDur) || 0) * 60000;
    var b0 = Date.parse(bStart),
      b1 = b0 + (Number(bDur) || 0) * 60000;
    return a0 < b1 && b0 < a1;
  }

  function daysAfter(iso, days) {
    if (!iso) return null;
    return new Date(
      Date.parse(iso) + (Number(days) || 0) * 24 * 3600 * 1000
    ).toISOString();
  }

  // naive area calc helpers
  function areaSqFt(bed) {
    var w = Number(bed && bed.widthFt) || 0;
    var l = Number(bed && bed.lengthFt) || 0;
    var a = w * l;
    return a > 0 ? a : 0;
  }
  function plantsCapacity(bed, spacingIn) {
    if (!bed || !spacingIn) return 0;
    var sqft = areaSqFt(bed);
    var perSqFt = 144 / Math.pow(Number(spacingIn) || 12, 2); // 12in x 12in square-foot approx
    return Math.floor(sqft * perSqFt);
  }

  // ----------------------------- Load Schema (with fallback) -----------------------------
  function loadSchema() {
    var schema =
      safeRequire("@/data/contracts/gardenplan.contract.json") ||
      safeRequire("../../data/contracts/gardenplan.contract.json");
    if (schema) return schema;

    // Minimal inline fallback to keep the app resilient
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:suka:contracts:gardenplan",
      title: "Garden Plan Contract (Fallback)",
      description:
        "Fallback schema for garden plans when canonical file is unavailable.",
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "x-domain",
        "householdId",
        "period",
        "beds",
        "crops",
        "tasks",
      ],
      properties: {
        id: {
          type: "string",
          pattern: "^(workplan|gardenplan):[A-Za-z0-9_\\-:.]+$",
        },
        title: { type: "string", default: "Garden Plan" },
        "x-version": { type: "string", default: "1.0.0" },
        "x-domain": { const: "garden" },
        householdId: { type: "string" },
        createdAt: {
          type: "string",
          format: "date-time",
          default: function () {
            return nowISO();
          },
        },
        updatedAt: {
          type: "string",
          format: "date-time",
          default: function () {
            return nowISO();
          },
        },
        period: {
          type: "object",
          additionalProperties: false,
          required: ["start", "end"],
          properties: {
            start: { type: "string", format: "date-time" },
            end: { type: "string", format: "date-time" },
          },
        },
        settings: {
          type: "object",
          additionalProperties: true,
          default: {},
          properties: {
            sabbathGuard: { type: "boolean", default: false },
            timezone: { type: "string" },
            // ties into user's Hebrew calendar preference (full moon month start)
            calendarStart: {
              type: "string",
              enum: [
                "full-moon",
                "new-moon",
                "first-crescent",
                "meridian-rule",
                "gregorian",
              ],
              default: "full-moon",
            },
            lastFrost: { type: "string", format: "date" },
            firstFrost: { type: "string", format: "date" },
            usdaZone: { type: "string" }, // e.g., "8a"
          },
        },
        beds: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              zone: { type: "string", default: "yard" },
              widthFt: { type: "number", minimum: 0 },
              lengthFt: { type: "number", minimum: 0 },
              soil: { type: "string" }, // loam, clay, sand, amended
              rotationTag: { type: "string" }, // e.g., "nightshade", "brassica", "legume"
              irrigationLineId: { type: "string" },
              constraints: {
                type: "object",
                additionalProperties: true,
                default: {},
              },
            },
          },
        },
        crops: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "species"],
            properties: {
              id: { type: "string" },
              species: { type: "string" }, // e.g., tomato, lettuce, okra
              variety: { type: "string" },
              seedSku: { type: "string" },
              daysToMaturity: { type: "number", minimum: 0 },
              spacingIn: { type: "number", minimum: 0 },
              bedId: { type: "string" },
              quantity: { type: "number", minimum: 0, default: 1 },
              companions: {
                type: "array",
                items: { type: "string" },
                default: [],
              },
              antagonists: {
                type: "array",
                items: { type: "string" },
                default: [],
              },
              notes: { type: "string" },
            },
          },
        },
        tasks: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "title", "kind"],
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              kind: {
                type: "string",
                enum: [
                  "soil_prep",
                  "sow",
                  "transplant",
                  "water",
                  "fertilize",
                  "trellis",
                  "prune",
                  "pest_scout",
                  "pesticide",
                  "weed",
                  "mulch",
                  "harvest",
                  "preserve",
                  "closeout",
                ],
              },
              scheduledAt: { type: "string", format: "date-time" },
              durationMin: { type: "number", default: 20 },
              bedId: { type: "string" },
              cropIds: {
                type: "array",
                items: { type: "string" },
                default: [],
              },
              dependencies: {
                type: "array",
                items: { type: "string" },
                default: [],
              },
              supplies: {
                type: "array",
                default: [],
                items: {
                  type: "object",
                  additionalProperties: true,
                  required: ["name"],
                  properties: {
                    sku: { type: "string" },
                    name: { type: "string" }, // compost, 5-10-5, neem oil, BT, row cover
                    amount: { type: "string" },
                  },
                },
              },
              tools: { type: "array", items: { type: "string" }, default: [] },
              irrigation: {
                type: "object",
                additionalProperties: true,
                default: {},
                properties: {
                  waterlineId: { type: "string" },
                  minutes: { type: "number", minimum: 0 },
                },
              },
              // Pre-harvest interval for pesticide tasks; harvests should respect this
              phiDays: { type: "number", minimum: 0, default: 0 },
              flags: { type: "array", items: { type: "string" }, default: [] },
              notes: { type: "string" },
            },
          },
        },
      },
    };
  }

  // ----------------------------- AJV Setup -----------------------------
  function buildAjv() {
    var Ajv = AjvCtor && AjvCtor.default ? AjvCtor.default : AjvCtor;
    var ajv = new Ajv({
      allErrors: true,
      strict: false,
      allowUnionTypes: true,
      removeAdditional: false,
      useDefaults: "empty",
      coerceTypes: true,
    });
    try {
      addFormats(ajv);
    } catch (e) {
      /* no-op */
    }
    return ajv;
  }

  // ----------------------------- Normalization -----------------------------
  function normalizeGardenPlan(input) {
    var plan = Object.assign({}, input || {});
    plan.id = ensureId("gardenplan", plan.id);
    plan["x-domain"] = plan["x-domain"] || "garden";
    plan["x-version"] = plan["x-version"] || "1.0.0";
    plan.createdAt = toISO(plan.createdAt) || nowISO();
    plan.updatedAt = nowISO();

    if (!plan.period) plan.period = {};
    plan.period.start = toISO(plan.period.start) || nowISO();
    plan.period.end =
      toISO(plan.period.end) ||
      new Date(
        Date.parse(plan.period.start) + 90 * 24 * 3600 * 1000
      ).toISOString();

    plan.settings = plan.settings || {};
    if (!plan.settings.calendarStart) plan.settings.calendarStart = "full-moon";

    plan.beds = uniqueBy(coerceArray(plan.beds), function (b) {
      return b && b.id ? b.id : JSON.stringify(b);
    }).map(function (b) {
      var bb = Object.assign({ zone: "yard", constraints: {} }, b || {});
      bb.id = ensureId("bed", bb.id);
      bb.name = bb.name || bb.id;
      return bb;
    });

    var bedIds = plan.beds.map(function (b) {
      return b.id;
    });

    plan.crops = uniqueBy(coerceArray(plan.crops), function (c) {
      return c && c.id ? c.id : JSON.stringify(c);
    }).map(function (c) {
      var cc = Object.assign(
        { quantity: 1, companions: [], antagonists: [] },
        c || {}
      );
      cc.id = ensureId("crop", cc.id);
      if (!cc.bedId && bedIds[0]) cc.bedId = bedIds[0];
      cc.daysToMaturity = Number(cc.daysToMaturity) || 0;
      cc.spacingIn = Number(cc.spacingIn) || 12;
      return cc;
    });

    var cropIds = plan.crops.map(function (c) {
      return c.id;
    });

    plan.tasks = uniqueBy(coerceArray(plan.tasks), function (t) {
      return t && t.id ? t.id : t && t.title ? t.title : JSON.stringify(t);
    }).map(function (t) {
      var tt = Object.assign({ durationMin: 20, phiDays: 0 }, t || {});
      tt.id = ensureId("task", tt.id);
      tt.title = tt.title || tt.id;
      tt.kind = tt.kind || "soil_prep";
      tt.scheduledAt = toISO(tt.scheduledAt) || plan.period.start;
      tt.bedId =
        tt.bedId && bedIds.indexOf(tt.bedId) >= 0
          ? tt.bedId
          : bedIds[0] || null;
      tt.cropIds = coerceArray(tt.cropIds).filter(function (id) {
        return cropIds.indexOf(id) >= 0;
      });
      tt.dependencies = coerceArray(tt.dependencies);
      tt.supplies = coerceArray(tt.supplies);
      tt.tools = coerceArray(tt.tools);
      tt.irrigation = tt.irrigation || {};
      if (tt.irrigation && tt.irrigation.minutes == null)
        tt.irrigation.minutes = 0;
      return tt;
    });

    return plan;
  }

  // ----------------------------- Cross-Field Checks -----------------------------
  function computeWarnings(plan) {
    var warnings = [];
    var bedMap = byIdMap(plan.beds);
    var cropMap = byIdMap(plan.crops);

    // Period sanity
    if (Date.parse(plan.period.start) > Date.parse(plan.period.end)) {
      warnings.push({
        code: "period.order",
        level: "error",
        msg: "Period start is after end.",
      });
    }

    // Bed capacity vs crop quantity (spacing awareness)
    for (var i = 0; i < plan.crops.length; i++) {
      var c = plan.crops[i];
      var bed = bedMap[c.bedId];
      if (bed && c.spacingIn && c.quantity != null) {
        var cap = plantsCapacity(bed, c.spacingIn);
        if (cap && c.quantity > cap) {
          warnings.push({
            code: "bed.overcapacity",
            level: "warn",
            cropId: c.id,
            msg:
              "Planned quantity (" +
              c.quantity +
              ") exceeds bed capacity (" +
              cap +
              ") for spacing " +
              c.spacingIn +
              "in.",
          });
        }
      }
    }

    // Companion / antagonist conflicts within same bed
    var cropsByBed = {};
    for (var b = 0; b < plan.crops.length; b++) {
      var cb = plan.crops[b];
      var key = cb.bedId || "_";
      (cropsByBed[key] = cropsByBed[key] || []).push(cb);
    }
    for (var bedKey in cropsByBed) {
      var list = cropsByBed[bedKey];
      for (var a = 0; a < list.length; a++) {
        for (var d = a + 1; d < list.length; d++) {
          var A = list[a],
            D = list[d];
          // antagonists either direction
          if (
            (A.antagonists || []).indexOf((D.species || "").toLowerCase()) >=
              0 ||
            (D.antagonists || []).indexOf((A.species || "").toLowerCase()) >= 0
          ) {
            warnings.push({
              code: "companion.antagonist",
              level: "warn",
              cropIds: [A.id, D.id],
              msg:
                "Antagonist pairing detected in the same bed: " +
                (A.species || "A") +
                " vs " +
                (D.species || "B"),
            });
          }
        }
      }
    }

    // Task sanity, frost/heat risk, PHI, Sabbath
    var lastFrostISO =
      plan.settings && plan.settings.lastFrost
        ? toISO(plan.settings.lastFrost)
        : null;
    var firstFrostISO =
      plan.settings && plan.settings.firstFrost
        ? toISO(plan.settings.firstFrost)
        : null;

    for (var t = 0; t < plan.tasks.length; t++) {
      var task = plan.tasks[t];

      if (task.bedId && !bedMap[task.bedId]) {
        warnings.push({
          code: "task.bed.missing",
          level: "error",
          taskId: task.id,
          msg: "Task references unknown bed: " + task.bedId,
        });
      }
      for (var q = 0; q < task.cropIds.length; q++) {
        if (!cropMap[task.cropIds[q]]) {
          warnings.push({
            code: "task.crop.missing",
            level: "error",
            taskId: task.id,
            msg: "Task references unknown crop: " + task.cropIds[q],
          });
        }
      }

      // Sabbath guard
      if (plan.settings && plan.settings.sabbathGuard) {
        try {
          var day = new Date(task.scheduledAt).getUTCDay(); // 6 = Saturday
          if (day === 6) {
            warnings.push({
              code: "sabbath.guard",
              level: "info",
              taskId: task.id,
              msg: "Sabbath guard enabled — consider rescheduling Saturday work.",
            });
          }
        } catch (e) {
          /* no-op */
        }
      }

      // Frost risk warnings (simple heuristics)
      if (task.kind === "sow" || task.kind === "transplant") {
        if (
          lastFrostISO &&
          Date.parse(task.scheduledAt) < Date.parse(lastFrostISO)
        ) {
          warnings.push({
            code: "frost.pre_last",
            level: "warn",
            taskId: task.id,
            msg: "Sowing/transplant scheduled before last frost date.",
          });
        }
      }
      if (task.kind === "harvest") {
        if (
          firstFrostISO &&
          Date.parse(task.scheduledAt) > Date.parse(firstFrostISO)
        ) {
          warnings.push({
            code: "frost.post_first",
            level: "info",
            taskId: task.id,
            msg: "Harvest scheduled after first frost — verify cold-hardiness.",
          });
        }
      }

      // PHI enforcement: pesticide -> later harvests must respect phiDays
      if (task.kind === "pesticide" && task.phiDays > 0) {
        var blockUntil = daysAfter(task.scheduledAt, task.phiDays);
        for (var h = 0; h < plan.tasks.length; h++) {
          var H = plan.tasks[h];
          if (H.kind !== "harvest") continue;
          // If harvest involves intersecting crops, check PHI
          var intersects =
            H.cropIds.length === 0 || task.cropIds.length === 0
              ? true // conservative: unknown crops => warn
              : task.cropIds.some(function (id) {
                  return H.cropIds.indexOf(id) >= 0;
                });
          if (
            intersects &&
            Date.parse(H.scheduledAt) < Date.parse(blockUntil)
          ) {
            warnings.push({
              code: "phi.violation",
              level: "error",
              taskIds: [task.id, H.id],
              msg:
                "Harvest is scheduled before PHI (" +
                task.phiDays +
                " days) after pesticide.",
            });
          }
        }
      }
    }

    // Tools / waterline overlaps
    for (var i1 = 0; i1 < plan.tasks.length; i1++) {
      var A = plan.tasks[i1];
      for (var i2 = i1 + 1; i2 < plan.tasks.length; i2++) {
        var B = plan.tasks[i2];
        // Tool overlap
        var sharedTools = (A.tools || []).filter(function (tn) {
          return (B.tools || []).indexOf(tn) >= 0;
        });
        if (
          sharedTools.length &&
          minutesOverlap(
            A.scheduledAt,
            A.durationMin,
            B.scheduledAt,
            B.durationMin
          )
        ) {
          var strong = A.bedId && B.bedId && A.bedId === B.bedId;
          warnings.push({
            code: "tools.overlap",
            level: strong ? "warn" : "info",
            taskIds: [A.id, B.id],
            msg: "Overlapping tasks share tools: " + sharedTools.join(", "),
          });
        }
        // Waterline overlap
        var wA = A.irrigation && A.irrigation.waterlineId;
        var wB = B.irrigation && B.irrigation.waterlineId;
        if (
          wA &&
          wB &&
          wA === wB &&
          minutesOverlap(
            A.scheduledAt,
            A.durationMin,
            B.scheduledAt,
            B.durationMin
          )
        ) {
          warnings.push({
            code: "waterline.overlap",
            level: "info",
            taskIds: [A.id, B.id],
            msg: "Concurrent irrigation on the same line: " + wA,
          });
        }
      }
    }

    // Optional: placement rules (rotation, zone/weather/species, companion planting catalogs)
    if (placementRules && typeof placementRules.validate === "function") {
      try {
        var pr = placementRules.validate({
          beds: plan.beds,
          crops: plan.crops,
          tasks: plan.tasks,
          settings: plan.settings,
          domain: "garden",
        });
        if (pr && pr.warnings && pr.warnings.length) {
          for (var w = 0; w < pr.warnings.length; w++) {
            var W = pr.warnings[w];
            warnings.push({
              code: "placement." + (W.code || "rule"),
              level: W.level || "warn",
              msg: W.msg || "Placement rule warning.",
            });
          }
        }
      } catch (e) {
        /* no-op */
      }
    }

    // Optional: pre-steps (seed soak/stratify/presprout, harden-off schedules)
    if (
      scheduleHelpers &&
      typeof scheduleHelpers.computePresteps === "function"
    ) {
      try {
        var pre = scheduleHelpers.computePresteps(plan.tasks || []);
        if (pre && pre.alerts && pre.alerts.length) {
          for (var p = 0; p < pre.alerts.length; p++) {
            var al = pre.alerts[p];
            warnings.push({
              code: "prestep." + (al.code || "alert"),
              level: al.level || "info",
              msg: al.msg || "Pre-step advisory.",
            });
          }
        }
      } catch (e) {
        /* no-op */
      }
    }

    return warnings;
  }

  // ----------------------------- Metrics -----------------------------
  function projectedHarvests(plan) {
    // naive estimation: from first sow/transplant per crop + daysToMaturity
    var result = [];
    var firstActionByCrop = {};
    for (var i = 0; i < plan.tasks.length; i++) {
      var t = plan.tasks[i];
      if (t.kind !== "sow" && t.kind !== "transplant") continue;
      var when = t.scheduledAt;
      if (!t.cropIds || t.cropIds.length === 0) continue;
      for (var c = 0; c < t.cropIds.length; c++) {
        var id = t.cropIds[c];
        var prev = firstActionByCrop[id];
        if (!prev || Date.parse(when) < Date.parse(prev))
          firstActionByCrop[id] = when;
      }
    }
    for (var cropId in firstActionByCrop) {
      var crop = plan.crops.find(function (x) {
        return x.id === cropId;
      });
      if (!crop) continue;
      var start = firstActionByCrop[cropId];
      var eta = daysAfter(start, crop.daysToMaturity || 0);
      result.push({
        cropId: cropId,
        species: crop.species,
        variety: crop.variety,
        eta: eta,
      });
    }
    return result;
  }

  function computeMetrics(plan) {
    var tasksByKind = {
      soil_prep: 0,
      sow: 0,
      transplant: 0,
      water: 0,
      fertilize: 0,
      trellis: 0,
      prune: 0,
      pest_scout: 0,
      pesticide: 0,
      weed: 0,
      mulch: 0,
      harvest: 0,
      preserve: 0,
      closeout: 0,
    };
    var totalMinutes = 0;
    var irrigationMinutesByLine = Object.create(null);
    var cropsBySpecies = Object.create(null);

    for (var i = 0; i < plan.crops.length; i++) {
      var sp = (plan.crops[i].species || "unknown").toLowerCase();
      cropsBySpecies[sp] =
        (cropsBySpecies[sp] || 0) + (Number(plan.crops[i].quantity) || 0);
    }

    for (var j = 0; j < plan.tasks.length; j++) {
      var t = plan.tasks[j];
      tasksByKind[t.kind] = (tasksByKind[t.kind] || 0) + 1;
      totalMinutes += Number(t.durationMin) || 0;
      if (t.irrigation && t.irrigation.waterlineId && t.irrigation.minutes) {
        var key = t.irrigation.waterlineId;
        irrigationMinutesByLine[key] =
          (irrigationMinutesByLine[key] || 0) + Number(t.irrigation.minutes);
      }
    }

    var harvestETAs = projectedHarvests(plan);

    // Consolidate supplies via listBuilder if present
    var supplies = [];
    if (listBuilder && typeof listBuilder.buildSupplies === "function") {
      try {
        supplies =
          listBuilder.buildSupplies({ tasks: plan.tasks, domain: "garden" }) ||
          [];
      } catch (e) {
        /* no-op */
      }
    } else {
      var acc = Object.create(null);
      for (var k = 0; k < plan.tasks.length; k++) {
        var sArr = plan.tasks[k].supplies || [];
        for (var m = 0; m < sArr.length; m++) {
          var key = (sArr[m].sku || sArr[m].name || "supply").toLowerCase();
          acc[key] = (acc[key] || 0) + 1;
        }
      }
      supplies = Object.keys(acc).map(function (k) {
        return { key: k, qty: acc[k] };
      });
    }

    return {
      tasksByKind: tasksByKind,
      totalMinutes: totalMinutes,
      irrigationMinutesByLine: irrigationMinutesByLine,
      cropsBySpecies: cropsBySpecies,
      harvestETAs: harvestETAs,
      supplies: supplies,
    };
  }

  // ----------------------------- Validator -----------------------------
  var _ajv = null,
    _schema = null,
    _validateFn = null;

  function getValidator() {
    if (_validateFn) return _validateFn;
    _schema = loadSchema();
    _ajv = buildAjv();
    _validateFn = _ajv.compile(_schema);
    return _validateFn;
  }

  /**
   * Validate + normalize a Garden Plan.
   * @param {object} data raw plan
   * @param {object} opts { emit?: boolean, source?: string }
   * @returns {{ ok: boolean, errors: Array, warnings: Array, normalized: object, metrics: object }}
   */
  function validateGardenPlan(data, opts) {
    opts = opts || {};
    var emit = opts.emit !== false; // default true
    var normalized = normalizeGardenPlan(data || {});
    var validate = getValidator();

    var ok = false;
    var errors = [];
    try {
      ok = !!validate(normalized);
      if (!ok && validate.errors) {
        errors = (validate.errors || []).map(function (e) {
          return {
            instancePath: e.instancePath || "",
            keyword: e.keyword,
            message: e.message,
            params: e.params,
          };
        });
      }
    } catch (e) {
      errors.push({
        keyword: "exception",
        message: e && e.message ? e.message : "Validation exception.",
      });
      ok = false;
    }

    var warnings = computeWarnings(normalized);
    var metrics = computeMetrics(normalized);

    // Optional: consolidation hints
    if (
      workPrepConsolidation &&
      typeof workPrepConsolidation.analyze === "function"
    ) {
      try {
        var cr = workPrepConsolidation.analyze({
          tasks: normalized.tasks,
          domain: "garden",
        });
        if (cr && cr.warnings && cr.warnings.length) {
          for (var i = 0; i < cr.warnings.length; i++) {
            var w = cr.warnings[i];
            warnings.push({
              code: "consolidation." + (w.code || "hint"),
              level: w.level || "info",
              msg: w.msg || "Consolidation hint.",
            });
          }
        }
      } catch (e) {
        /* no-op */
      }
    }

    var result = {
      ok: ok && errors.length === 0,
      errors: errors,
      warnings: warnings,
      normalized: normalized,
      metrics: metrics,
    };

    // Emit events
    if (emit) {
      try {
        if (result.ok) {
          eventBus.emit("gardenplan.validated", {
            planId: normalized.id,
            householdId: normalized.householdId,
            metrics: metrics,
            warnings: warnings,
            ts: nowISO(),
            source: opts.source || "validator",
          });

          // NBA nudge (defensive)
          eventBus.emit("nba.updated", {
            scope: "garden",
            planId: normalized.id,
            hints: (function () {
              if (
                warnings.some(function (w) {
                  return w.code.indexOf("phi.") === 0;
                })
              ) {
                return [
                  {
                    code: "respect_phi",
                    label: "Fix PHI harvest conflicts",
                    weight: 0.9,
                  },
                ];
              }
              if (
                warnings.some(function (w) {
                  return w.code.indexOf("frost.") === 0;
                })
              ) {
                return [
                  {
                    code: "resolve_frost_risks",
                    label: "Adjust for frost dates",
                    weight: 0.8,
                  },
                ];
              }
              if (
                warnings.some(function (w) {
                  return w.code.indexOf("companion.antagonist") === 0;
                })
              ) {
                return [
                  {
                    code: "apply_companion_rules",
                    label: "Separate antagonists",
                    weight: 0.7,
                  },
                ];
              }
              if (
                warnings.some(function (w) {
                  return (
                    w.code.indexOf("tools.overlap") === 0 ||
                    w.code.indexOf("waterline.overlap") === 0
                  );
                })
              ) {
                return [
                  {
                    code: "reschedule_conflicts",
                    label: "Resolve tool/waterline overlaps",
                    weight: 0.6,
                  },
                ];
              }
              // harvest clustering hint: plan preservation session
              if ((metrics.harvestETAs || []).length > 0) {
                return [
                  {
                    code: "plan_preservation",
                    label: "Plan canning/drying for harvest window",
                    weight: 0.5,
                  },
                ];
              }
              return [
                {
                  code: "review_plan",
                  label: "Review garden plan",
                  weight: 0.3,
                },
              ];
            })(),
            ts: nowISO(),
          });
        } else {
          eventBus.emit("gardenplan.validation_failed", {
            planId: normalized.id,
            errors: errors,
            ts: nowISO(),
            source: opts.source || "validator",
          });
        }
      } catch (e) {
        /* no-op */
      }
    }

    return result;
  }

  // ----------------------------- Module Exports -----------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      validateGardenPlan: validateGardenPlan,
      normalizeGardenPlan: normalizeGardenPlan,
      computeWarnings: computeWarnings,
      computeMetrics: computeMetrics,
      get schema() {
        return _schema || loadSchema();
      },
      get ajv() {
        return _ajv || buildAjv();
      },
    };
  } else {
    // eslint-disable-next-line no-undef
    window.gardenplanValidate = { validateGardenPlan: validateGardenPlan };
  }
})();

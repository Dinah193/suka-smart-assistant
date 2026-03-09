/* eslint-disable no-console */
/**
 * barnplan.validate.js — Canonical validator/normalizer for Barn Plans (ES2015-safe)
 *
 * Goals:
 * - Load barnplan JSON Schema (draft 2020-12) with AJV (defaults, coercion, formats)
 * - Normalize input (ids, dates, arrays, enums), enrich with dynamic defaults
 * - Cross-field validation (zones, animals, tasks, withhold windows, overlaps)
 * - Compute warnings + metrics for HUD, NBA, and session orchestration
 * - Defensive integration with shared services (eventBus, scheduleHelpers, placementRules,
 *   workPrepConsolidation, listBuilder) without hard crashes if missing.
 * - Emit lifecycle events: barnplan.validated | barnplan.validation_failed
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
      // Accept yyyy-mm-dd as local date => convert to start-of-day UTC ISO
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        var dt = new Date(d + "T00:00:00Z");
        return dt.toISOString();
      }
      // If it's already ISO, trust it
      if (!isNaN(Date.parse(d))) return new Date(d).toISOString();
      return null;
    }
    if (d instanceof Date) return d.toISOString();
    return null;
  }

  function coerceArray(x) {
    if (x == null) return [];
    return Array.isArray(x) ? x : [x];
  }

  function ensureId(prefix, idCandidate) {
    var base = (idCandidate || "").toString().trim();
    if (base && ID_RX.test(base)) return base;
    var rand = Math.random().toString(36).slice(2, 10);
    return prefix + ":" + rand;
  }

  function uniqueBy(arr, keyFn) {
    var seen = {};
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
    var map = {};
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

  // ----------------------------- Load Schema (with fallback) -----------------------------
  function loadSchema() {
    var schema =
      safeRequire("@/data/contracts/barnplan.contract.json") ||
      safeRequire("../../data/contracts/barnplan.contract.json");
    if (schema) return schema;

    // Minimal inline fallback to keep the app resilient
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:suka:contracts:barnplan",
      title: "Barn Plan Contract (Fallback)",
      description:
        "Fallback schema used when the canonical JSON file is unavailable.",
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "x-domain",
        "householdId",
        "period",
        "animals",
        "zones",
        "tasks",
      ],
      properties: {
        id: {
          type: "string",
          pattern: "^(workplan|barnplan):[A-Za-z0-9_\\-:.]+$",
        },
        title: { type: "string", default: "Barn Plan" },
        "x-version": { type: "string", default: "1.0.0" },
        "x-domain": { const: "animals" },
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
          properties: {
            sabbathGuard: { type: "boolean", default: false },
            timezone: { type: "string" },
          },
          default: {},
        },
        zones: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              kind: {
                type: "string",
                enum: [
                  "barn",
                  "pasture",
                  "coop",
                  "pen",
                  "storage",
                  "processing",
                ],
                default: "barn",
              },
              constraints: { type: "object", additionalProperties: true },
            },
          },
          default: [],
        },
        animals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "species"],
            properties: {
              id: { type: "string" },
              species: { type: "string" }, // e.g., chicken, sheep, goat, cow
              name: { type: "string" },
              sex: {
                type: "string",
                enum: ["male", "female", "unknown"],
                default: "unknown",
              },
              ageMonths: { type: "number" },
              tags: { type: "array", items: { type: "string" }, default: [] },
              locationZoneId: { type: "string" },
            },
          },
          default: [],
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
                enum: ["care", "butchery", "maintenance", "cleaning"],
              },
              scheduledAt: { type: "string", format: "date-time" },
              durationMin: { type: "number", default: 30 },
              zoneId: { type: "string" },
              animalIds: {
                type: "array",
                items: { type: "string" },
                default: [],
              },
              dependencies: {
                type: "array",
                items: { type: "string" },
                default: [],
              },
              resources: {
                type: "object",
                additionalProperties: true,
                properties: {
                  water: { type: "boolean", default: false },
                  feed: {
                    type: "object",
                    additionalProperties: true,
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          additionalProperties: true,
                          properties: {
                            sku: { type: "string" },
                            name: { type: "string" },
                            amount: { type: "string" },
                          },
                        },
                        default: [],
                      },
                    },
                    default: {},
                  },
                  meds: {
                    type: "array",
                    default: [],
                    items: {
                      type: "object",
                      additionalProperties: true,
                      required: ["name"],
                      properties: {
                        name: { type: "string" },
                        dose: { type: "string" },
                      },
                    },
                  },
                  equipment: {
                    type: "array",
                    items: { type: "string" },
                    default: [],
                  },
                  ppe: {
                    type: "array",
                    items: { type: "string" },
                    default: [],
                  },
                },
                default: {},
              },
              withhold: {
                type: "object",
                additionalProperties: true,
                properties: {
                  product: { type: "string", enum: ["milk", "eggs", "meat"] },
                  until: { type: "string", format: "date-time" },
                },
              },
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
  function normalizeBarnPlan(input) {
    var plan = Object.assign({}, input || {});
    plan.id = ensureId("barnplan", plan.id);
    plan["x-domain"] = plan["x-domain"] || "animals";
    plan["x-version"] = plan["x-version"] || "1.0.0";
    plan.createdAt = toISO(plan.createdAt) || nowISO();
    plan.updatedAt = nowISO();

    if (!plan.period) plan.period = {};
    plan.period.start = toISO(plan.period.start) || nowISO();
    // default end = start + 7d
    plan.period.end =
      toISO(plan.period.end) ||
      new Date(
        Date.parse(plan.period.start) + 7 * 24 * 3600 * 1000
      ).toISOString();

    plan.settings = plan.settings || {};
    plan.zones = uniqueBy(coerceArray(plan.zones), function (z) {
      return z && z.id ? z.id : JSON.stringify(z);
    }).map(function (z) {
      var zz = Object.assign({ kind: "barn", constraints: {} }, z || {});
      zz.id = ensureId("zone", zz.id);
      zz.name = zz.name || zz.id;
      return zz;
    });

    plan.animals = uniqueBy(coerceArray(plan.animals), function (a) {
      return a && a.id ? a.id : JSON.stringify(a);
    }).map(function (a) {
      var aa = Object.assign({ sex: "unknown", tags: [] }, a || {});
      aa.id = ensureId("animal", aa.id);
      if (aa.locationZoneId == null && plan.zones[0])
        aa.locationZoneId = plan.zones[0].id;
      return aa;
    });

    var zoneIds = plan.zones.map(function (z) {
      return z.id;
    });
    var animalIds = plan.animals.map(function (a) {
      return a.id;
    });

    plan.tasks = uniqueBy(coerceArray(plan.tasks), function (t) {
      return t && t.id ? t.id : t && t.title ? t.title : JSON.stringify(t);
    }).map(function (t) {
      var tt = Object.assign({ durationMin: 30 }, t || {});
      tt.id = ensureId("task", tt.id);
      tt.title = tt.title || tt.id;
      tt.kind = tt.kind || "care";
      tt.scheduledAt = toISO(tt.scheduledAt) || plan.period.start;
      tt.zoneId =
        tt.zoneId && zoneIds.indexOf(tt.zoneId) >= 0
          ? tt.zoneId
          : plan.zones[0] && plan.zones[0].id;
      tt.animalIds = coerceArray(tt.animalIds).filter(function (id) {
        return animalIds.indexOf(id) >= 0;
      });
      tt.dependencies = coerceArray(tt.dependencies);
      tt.resources = Object.assign(
        { water: false, feed: { items: [] }, meds: [], equipment: [], ppe: [] },
        tt.resources || {}
      );
      tt.flags = coerceArray(tt.flags);
      if (tt.resources.meds && tt.resources.meds.length && !tt.withhold) {
        // heuristic default: 48h withhold for meat/milk when meds present
        var until = new Date(
          Date.parse(tt.scheduledAt) + 48 * 3600 * 1000
        ).toISOString();
        tt.withhold = { product: "meat", until: until };
      }
      if (tt.withhold) {
        tt.withhold.product = tt.withhold.product || "meat";
        tt.withhold.until =
          toISO(tt.withhold.until) ||
          new Date(Date.parse(tt.scheduledAt) + 24 * 3600 * 1000).toISOString();
      }
      return tt;
    });

    return plan;
  }

  // ----------------------------- Cross-Field Checks -----------------------------
  function computeWarnings(plan) {
    var warnings = [];
    var zoneMap = byIdMap(plan.zones);
    var animalMap = byIdMap(plan.animals);

    // Period sanity
    if (Date.parse(plan.period.start) > Date.parse(plan.period.end)) {
      warnings.push({
        code: "period.order",
        level: "error",
        msg: "Period start is after end.",
      });
    }

    // Tasks sanity
    for (var i = 0; i < plan.tasks.length; i++) {
      var t = plan.tasks[i];
      if (!zoneMap[t.zoneId]) {
        warnings.push({
          code: "task.zone.missing",
          level: "error",
          taskId: t.id,
          msg: "Task zone does not exist: " + t.zoneId,
        });
      }
      // animal references
      for (var j = 0; j < t.animalIds.length; j++) {
        if (!animalMap[t.animalIds[j]]) {
          warnings.push({
            code: "task.animal.missing",
            level: "error",
            taskId: t.id,
            msg: "Task references unknown animal: " + t.animalIds[j],
          });
        }
      }
      // withhold window
      if (
        t.withhold &&
        t.withhold.until &&
        Date.parse(t.withhold.until) <= Date.parse(t.scheduledAt)
      ) {
        warnings.push({
          code: "withhold.order",
          level: "error",
          taskId: t.id,
          msg: "Withhold 'until' must be after the task time.",
        });
      }
      // task inside plan period (soft warning)
      if (
        Date.parse(t.scheduledAt) < Date.parse(plan.period.start) ||
        Date.parse(t.scheduledAt) > Date.parse(plan.period.end)
      ) {
        warnings.push({
          code: "task.outside.period",
          level: "warn",
          taskId: t.id,
          msg: "Task is scheduled outside the plan period.",
        });
      }
      // Sabbath guard
      if (plan.settings && plan.settings.sabbathGuard) {
        try {
          var day = new Date(t.scheduledAt).getUTCDay(); // 6 = Saturday (UTC)
          if (day === 6) {
            warnings.push({
              code: "sabbath.guard",
              level: "info",
              taskId: t.id,
              msg: "Sabbath guard enabled — consider rescheduling Saturday tasks.",
            });
          }
        } catch (e) {
          /* no-op */
        }
      }
    }

    // Resource overlaps (equipment/time conflicts)
    for (var a = 0; a < plan.tasks.length; a++) {
      var A = plan.tasks[a];
      if (
        !A.resources ||
        !A.resources.equipment ||
        !A.resources.equipment.length
      )
        continue;
      for (var b = a + 1; b < plan.tasks.length; b++) {
        var B = plan.tasks[b];
        if (
          !B.resources ||
          !B.resources.equipment ||
          !B.resources.equipment.length
        )
          continue;

        var shared = A.resources.equipment.filter(function (eq) {
          return B.resources.equipment.indexOf(eq) >= 0;
        });
        if (
          shared.length &&
          minutesOverlap(
            A.scheduledAt,
            A.durationMin,
            B.scheduledAt,
            B.durationMin
          )
        ) {
          warnings.push({
            code: "equipment.overlap",
            level: "warn",
            taskIds: [A.id, B.id],
            msg: "Overlapping tasks share equipment: " + shared.join(", "),
          });
        }
      }
    }

    // Optional: consult placementRules for zone/species constraints
    if (placementRules && typeof placementRules.validate === "function") {
      try {
        var pr = placementRules.validate({
          zones: plan.zones,
          animals: plan.animals,
        });
        if (pr && pr.warnings && pr.warnings.length) {
          warnings = warnings.concat(
            pr.warnings.map(function (w) {
              return {
                code: "placement." + (w.code || "rule"),
                level: w.level || "warn",
                msg: w.msg || "Placement rule warning.",
              };
            })
          );
        }
      } catch (e) {
        /* no-op */
      }
    }

    // Optional: pre-steps from scheduleHelpers (defrost/marinate/preheat-esque) mapped to animal meds withholding etc.
    if (
      scheduleHelpers &&
      typeof scheduleHelpers.computePresteps === "function"
    ) {
      try {
        var pre = scheduleHelpers.computePresteps(plan.tasks || []);
        if (pre && pre.alerts && pre.alerts.length) {
          warnings = warnings.concat(
            pre.alerts.map(function (al) {
              return {
                code: "prestep." + (al.code || "alert"),
                level: al.level || "info",
                msg: al.msg || "Pre-step advisory.",
              };
            })
          );
        }
      } catch (e) {
        /* no-op */
      }
    }

    return warnings;
  }

  // ----------------------------- Metrics -----------------------------
  function computeMetrics(plan) {
    var headcountBySpecies = {};
    for (var i = 0; i < plan.animals.length; i++) {
      var sp = (plan.animals[i].species || "unknown").toLowerCase();
      headcountBySpecies[sp] = (headcountBySpecies[sp] || 0) + 1;
    }

    var tasksByKind = { care: 0, butchery: 0, maintenance: 0, cleaning: 0 };
    var totalMinutes = 0;
    var withholds = [];

    for (var j = 0; j < plan.tasks.length; j++) {
      var t = plan.tasks[j];
      tasksByKind[t.kind] = (tasksByKind[t.kind] || 0) + 1;
      totalMinutes += Number(t.durationMin) || 0;
      if (t.withhold && t.withhold.product && t.withhold.until) {
        withholds.push({
          taskId: t.id,
          product: t.withhold.product,
          until: t.withhold.until,
        });
      }
    }

    // Optional: consolidated resources for shopping/supplies
    var supplies = [];
    if (listBuilder && typeof listBuilder.buildSupplies === "function") {
      try {
        supplies =
          listBuilder.buildSupplies({ tasks: plan.tasks, domain: "animals" }) ||
          [];
      } catch (e) {
        /* no-op */
      }
    } else {
      // minimal fallback: gather feed SKUs & meds
      var skuMap = {};
      for (var k = 0; k < plan.tasks.length; k++) {
        var res =
          (plan.tasks[k].resources &&
            plan.tasks[k].resources.feed &&
            plan.tasks[k].resources.feed.items) ||
          [];
        for (var r = 0; r < res.length; r++) {
          var key = res[r].sku || res[r].name || "feed";
          skuMap[key] = (skuMap[key] || 0) + 1;
        }
        var meds =
          (plan.tasks[k].resources && plan.tasks[k].resources.meds) || [];
        for (var m = 0; m < meds.length; m++) {
          var mk = meds[m].name || "medication";
          skuMap[mk] = (skuMap[mk] || 0) + 1;
        }
      }
      supplies = Object.keys(skuMap).map(function (key) {
        return { key: key, qty: skuMap[key] };
      });
    }

    return {
      headcountBySpecies: headcountBySpecies,
      tasksByKind: tasksByKind,
      totalMinutes: totalMinutes,
      withholds: withholds,
      supplies: supplies,
    };
  }

  // ----------------------------- Validator -----------------------------
  var _ajv = null;
  var _schema = null;
  var _validateFn = null;

  function getValidator() {
    if (_validateFn) return _validateFn;
    _schema = loadSchema();
    _ajv = buildAjv();
    _validateFn = _ajv.compile(_schema);
    return _validateFn;
  }

  /**
   * Validate + normalize a Barn Plan.
   * @param {object} data raw plan
   * @param {object} opts { emit?: boolean, source?: string }
   * @returns {{ ok: boolean, errors: Array, warnings: Array, normalized: object, metrics: object }}
   */
  function validateBarnPlan(data, opts) {
    opts = opts || {};
    var emit = opts.emit !== false; // default true
    var normalized = normalizeBarnPlan(data || {});
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

    // Cross-field warnings & enrichments
    var warnings = computeWarnings(normalized);
    var metrics = computeMetrics(normalized);

    // Optional: consolidation advisor
    if (
      workPrepConsolidation &&
      typeof workPrepConsolidation.analyze === "function"
    ) {
      try {
        var cr = workPrepConsolidation.analyze({
          tasks: normalized.tasks,
          domain: "animals",
        });
        if (cr && cr.warnings && cr.warnings.length) {
          warnings = warnings.concat(
            cr.warnings.map(function (w) {
              return {
                code: "consolidation." + (w.code || "hint"),
                level: w.level || "info",
                msg: w.msg || "Consolidation hint.",
              };
            })
          );
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

    // Emit events for orchestration
    if (emit) {
      try {
        if (result.ok) {
          eventBus.emit("barnplan.validated", {
            planId: normalized.id,
            householdId: normalized.householdId,
            metrics: metrics,
            warnings: warnings,
            ts: nowISO(),
            source: opts.source || "validator",
          });
          // Next Best Action nudge (defensive)
          if (eventBus.emit) {
            eventBus.emit("nba.updated", {
              scope: "animals",
              planId: normalized.id,
              hints: [
                warnings.some(function (w) {
                  return w.code.indexOf("equipment.overlap") === 0;
                })
                  ? {
                      code: "reschedule_conflicts",
                      label: "Resolve overlapping equipment",
                      weight: 0.7,
                    }
                  : {
                      code: "review_plan",
                      label: "Review barn plan",
                      weight: 0.3,
                    },
              ],
              ts: nowISO(),
            });
          }
        } else {
          eventBus.emit("barnplan.validation_failed", {
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
      validateBarnPlan: validateBarnPlan,
      normalizeBarnPlan: normalizeBarnPlan,
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
    // global fallback
    // eslint-disable-next-line no-undef
    window.barnplanValidate = { validateBarnPlan: validateBarnPlan };
  }
})();

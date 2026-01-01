/* eslint-disable no-console */
/**
 * cleanplan.validate.js — Canonical validator/normalizer for Cleaning Plans (ES2015-safe)
 *
 * Integrations (defensive):
 *  - eventBus            (@/services/eventBus)
 *  - scheduleHelpers     (@/services/scheduleHelpers)   // soak/pre-treat/dwell timers, pre-steps
 *  - placementRules      (@/engines/placementRules)     // zone/room constraints (quiet hours, occupancy)
 *  - workPrepConsolidation (@/engines/workPrepConsolidation) // batching by room/supply/tool
 *  - listBuilder         (@/engines/listBuilder)        // supply SKUs consolidation
 *
 * Emits:
 *  - cleanplan.validated
 *  - cleanplan.validation_failed
 *  - nba.updated (scope: "cleaning")
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

  var eventBus =
    (safeRequire("@/services/eventBus") || {}).eventBus ||
    (safeRequire("@/services/eventBus") || {}).default ||
    { emit: function () {}, on: function(){}, off: function(){} };

  var scheduleHelpers =
    safeRequire("@/services/scheduleHelpers") ||
    safeRequire("../../services/scheduleHelpers") ||
    {};
  var placementRules = safeRequire("@/engines/placementRules") || {};
  var workPrepConsolidation = safeRequire("@/engines/workPrepConsolidation") || {};
  var listBuilder = safeRequire("@/engines/listBuilder") || {};

  var AjvCtor = safeRequire("ajv/dist/2020") || safeRequire("ajv");
  var addFormats = safeRequire("ajv-formats") || function () { return function () {}; };

  // ----------------------------- Utilities -----------------------------
  var ID_RX = /^[a-z]+:[A-Za-z0-9_\-:.]+$/;
  var BLEACH_NAMES = ["bleach", "sodium hypochlorite", "chlorine"];
  var AMMONIA_NAMES = ["ammonia", "ammonium hydroxide"];
  var ACIDIC_NAMES = ["acid", "hydrochloric", "muriatic", "phosphoric", "vinegar", "acetic", "citric"];

  function nowISO() { return new Date().toISOString(); }

  function toISO(d) {
    if (!d) return null;
    if (typeof d === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return new Date(d + "T00:00:00Z").toISOString();
      if (!isNaN(Date.parse(d))) return new Date(d).toISOString();
      return null;
    }
    if (d instanceof Date) return d.toISOString();
    return null;
  }

  function coerceArray(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

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
    for (var i = 0; i < arr.length; i++) if (arr[i] && arr[i].id) map[arr[i].id] = arr[i];
    return map;
  }

  function minutesOverlap(aStart, aDur, bStart, bDur) {
    if (!aStart || !bStart) return false;
    var a0 = Date.parse(aStart), a1 = a0 + (Number(aDur) || 0) * 60000;
    var b0 = Date.parse(bStart), b1 = b0 + (Number(bDur) || 0) * 60000;
    return a0 < b1 && b0 < a1;
  }

  function containsAny(str, needles) {
    if (!str) return false;
    var s = String(str).toLowerCase();
    for (var i = 0; i < needles.length; i++) if (s.indexOf(needles[i]) >= 0) return true;
    return false;
  }

  // ----------------------------- Load Schema (with fallback) -----------------------------
  function loadSchema() {
    var schema =
      safeRequire("@/data/contracts/cleanplan.contract.json") ||
      safeRequire("../../data/contracts/cleanplan.contract.json");
    if (schema) return schema;

    // Minimal inline fallback to keep the app resilient
    return {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "urn:suka:contracts:cleanplan",
      title: "Clean Plan Contract (Fallback)",
      description: "Fallback schema for cleaning plans when canonical file is unavailable.",
      type: "object",
      additionalProperties: false,
      required: ["id", "x-domain", "householdId", "period", "rooms", "tasks"],
      properties: {
        id: { type: "string", pattern: "^(workplan|cleanplan):[A-Za-z0-9_\\-:.]+$" },
        title: { type: "string", default: "Cleaning Plan" },
        "x-version": { type: "string", default: "1.0.0" },
        "x-domain": { const: "cleaning" },
        householdId: { type: "string" },
        createdAt: { type: "string", format: "date-time", default: function(){ return nowISO(); } },
        updatedAt: { type: "string", format: "date-time", default: function(){ return nowISO(); } },
        period: {
          type: "object",
          additionalProperties: false,
          required: ["start", "end"],
          properties: {
            start: { type: "string", format: "date-time" },
            end: { type: "string", format: "date-time" }
          }
        },
        settings: {
          type: "object",
          additionalProperties: true,
          properties: {
            sabbathGuard: { type: "boolean", default: false },
            timezone: { type: "string" },
            quietHours: {
              type: "object",
              additionalProperties: false,
              properties: {
                startHour: { type: "integer", minimum: 0, maximum: 23, default: 21 },
                endHour: { type: "integer", minimum: 0, maximum: 23, default: 7 }
              },
              default: {}
            }
          },
          default: {}
        },
        rooms: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "name"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              floor: { type: "string", default: "main" },
              constraints: {
                type: "object",
                additionalProperties: true,
                properties: {
                  noNoise: { type: "boolean", default: false },
                  requiresVentilation: { type: "boolean", default: false }
                },
                default: {}
              }
            }
          }
        },
        surfaces: {
          type: "array",
          default: [],
          items: {
            type: "object",
            additionalProperties: true,
            required: ["id", "roomId", "material"],
            properties: {
              id: { type: "string" },
              roomId: { type: "string" },
              material: { type: "string" }, // tile, hardwood, stainless, glass, fabric, etc.
              notes: { type: "string" }
            }
          }
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
                enum: ["sweep","vacuum","mop","dust","sanitize","laundry","dishes","trash","maintenance","organize"]
              },
              scheduledAt: { type: "string", format: "date-time" },
              durationMin: { type: "number", default: 20 },
              roomId: { type: "string" },
              surfaceIds: { type: "array", items: { type: "string" }, default: [] },
              dependencies: { type: "array", items: { type: "string" }, default: [] },
              supplies: {
                type: "array",
                default: [],
                items: {
                  type: "object",
                  additionalProperties: true,
                  required: ["name"],
                  properties: {
                    sku: { type: "string" },
                    name: { type: "string" },
                    amount: { type: "string" } // e.g., "50ml", "1 pad", "2 bags"
                  }
                }
              },
              tools: { type: "array", items: { type: "string" }, default: [] }, // vacuum, mop, bucket, squeegee
              ppe: { type: "array", items: { type: "string" }, default: [] },
              dwellTimeMin: { type: "number", minimum: 0, default: 0 }, // sanitizer dwell time
              ventilation: {
                type: "object",
                additionalProperties: true,
                properties: {
                  required: { type: "boolean", default: false },
                  reentryAt: { type: "string", format: "date-time" }
                },
                default: {}
              },
              flags: { type: "array", items: { type: "string" }, default: [] },
              notes: { type: "string" }
            }
          }
        }
      }
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
      coerceTypes: true
    });
    try { addFormats(ajv); } catch (e) { /* no-op */ }
    return ajv;
  }

  // ----------------------------- Normalization -----------------------------
  function normalizeCleanPlan(input) {
    var plan = Object.assign({}, input || {});
    plan.id = ensureId("cleanplan", plan.id);
    plan["x-domain"] = plan["x-domain"] || "cleaning";
    plan["x-version"] = plan["x-version"] || "1.0.0";
    plan.createdAt = toISO(plan.createdAt) || nowISO();
    plan.updatedAt = nowISO();

    if (!plan.period) plan.period = {};
    plan.period.start = toISO(plan.period.start) || nowISO();
    plan.period.end =
      toISO(plan.period.end) ||
      new Date(Date.parse(plan.period.start) + 7 * 24 * 3600 * 1000).toISOString();

    plan.settings = plan.settings || {};
    if (!plan.settings.quietHours) plan.settings.quietHours = { startHour: 21, endHour: 7 };

    plan.rooms = uniqueBy(coerceArray(plan.rooms), function (r) { return r && r.id ? r.id : JSON.stringify(r); })
      .map(function (r) {
        var rr = Object.assign({ floor: "main", constraints: {} }, r || {});
        rr.id = ensureId("room", rr.id);
        rr.name = rr.name || rr.id;
        rr.constraints = rr.constraints || {};
        return rr;
      });

    var roomIds = plan.rooms.map(function (r) { return r.id; });

    plan.surfaces = uniqueBy(coerceArray(plan.surfaces), function (s) { return s && s.id ? s.id : JSON.stringify(s); })
      .map(function (s) {
        var ss = Object.assign({}, s || {});
        ss.id = ensureId("surface", ss.id);
        if (!ss.roomId && roomIds[0]) ss.roomId = roomIds[0];
        return ss;
      });

    var surfaceIds = plan.surfaces.map(function (s) { return s.id; });

    plan.tasks = uniqueBy(coerceArray(plan.tasks), function (t) { return t && t.id ? t.id : t && t.title ? t.title : JSON.stringify(t); })
      .map(function (t) {
        var tt = Object.assign({ durationMin: 20, dwellTimeMin: 0 }, t || {});
        tt.id = ensureId("task", tt.id);
        tt.title = tt.title || tt.id;
        tt.kind = tt.kind || "sanitize";
        tt.scheduledAt = toISO(tt.scheduledAt) || plan.period.start;
        tt.roomId = tt.roomId && roomIds.indexOf(tt.roomId) >= 0 ? tt.roomId : (roomIds[0] || null);
        tt.surfaceIds = coerceArray(tt.surfaceIds).filter(function (id) { return surfaceIds.indexOf(id) >= 0; });
        tt.dependencies = coerceArray(tt.dependencies);
        tt.supplies = coerceArray(tt.supplies);
        tt.tools = coerceArray(tt.tools);
        tt.ppe = coerceArray(tt.ppe);
        tt.ventilation = tt.ventilation || {};
        if (tt.ventilation.required && !tt.ventilation.reentryAt) {
          // default reentry = scheduledAt + max(dwell, 15 min)
          var extra = Math.max(Number(tt.dwellTimeMin) || 0, 15) * 60000;
          tt.ventilation.reentryAt = new Date(Date.parse(tt.scheduledAt) + extra).toISOString();
        }
        return tt;
      });

    return plan;
  }

  // ----------------------------- Cross-Field Checks -----------------------------
  function computeWarnings(plan) {
    var warnings = [];
    var roomMap = byIdMap(plan.rooms);
    var surfaceMap = byIdMap(plan.surfaces);

    // Period order
    if (Date.parse(plan.period.start) > Date.parse(plan.period.end)) {
      warnings.push({ code: "period.order", level: "error", msg: "Period start is after end." });
    }

    // Quiet hours helper
    function isQuietHour(dateStr) {
      try {
        var d = new Date(dateStr);
        var h = d.getUTCHours(); // UTC; still useful as heuristic without tz DB
        var start = (plan.settings.quietHours && plan.settings.quietHours.startHour != null)
          ? plan.settings.quietHours.startHour : 21;
        var end = (plan.settings.quietHours && plan.settings.quietHours.endHour != null)
          ? plan.settings.quietHours.endHour : 7;
        if (start < end) return h >= start && h < end;
        // wraps midnight
        return h >= start || h < end;
      } catch (e) { return false; }
    }

    // Task sanity + chemical safety
    for (var i = 0; i < plan.tasks.length; i++) {
      var t = plan.tasks[i];

      if (t.roomId && !roomMap[t.roomId]) {
        warnings.push({ code: "task.room.missing", level: "error", taskId: t.id, msg: "Task room does not exist: " + t.roomId });
      }

      for (var s = 0; s < t.surfaceIds.length; s++) {
        if (!surfaceMap[t.surfaceIds[s]]) {
          warnings.push({ code: "task.surface.missing", level: "error", taskId: t.id, msg: "Unknown surface: " + t.surfaceIds[s] });
        }
      }

      // dwell time basic check
      if ((t.kind === "sanitize" || t.kind === "mop") && (Number(t.dwellTimeMin) || 0) <= 0) {
        warnings.push({ code: "dwell.missing", level: "warn", taskId: t.id, msg: "Consider setting dwellTimeMin for disinfectants or wet cleaning." });
      }

      // Sabbath guard
      if (plan.settings && plan.settings.sabbathGuard) {
        try {
          var day = new Date(t.scheduledAt).getUTCDay(); // 6 = Saturday
          if (day === 6) {
            warnings.push({ code: "sabbath.guard", level: "info", taskId: t.id, msg: "Sabbath guard enabled — consider rescheduling Saturday tasks." });
          }
        } catch (e) { /* no-op */ }
      }

      // Quiet hours (noisy tools)
      if (isQuietHour(t.scheduledAt) && (t.tools || []).some(function (x) {
        var n = (x || "").toLowerCase();
        return n.indexOf("vacuum") >= 0 || n.indexOf("machine") >= 0 || n.indexOf("blower") >= 0;
      })) {
        warnings.push({ code: "quiet.hours", level: "info", taskId: t.id, msg: "Noisy tool scheduled during quiet hours." });
      }

      // Chemical incompatibility (bleach + ammonia OR bleach + acids)
      var hasBleach = false, hasAmmonia = false, hasAcid = false;
      for (var q = 0; q < (t.supplies || []).length; q++) {
        var nm = ((t.supplies[q] && t.supplies[q].name) || "").toLowerCase();
        if (containsAny(nm, BLEACH_NAMES)) hasBleach = true;
        if (containsAny(nm, AMMONIA_NAMES)) hasAmmonia = true;
        if (containsAny(nm, ACIDIC_NAMES)) hasAcid = true;
      }
      if (hasBleach && hasAmmonia) {
        warnings.push({ code: "chem.bleach_ammonia", level: "error", taskId: t.id, msg: "Do not mix bleach and ammonia." });
      }
      if (hasBleach && hasAcid) {
        warnings.push({ code: "chem.bleach_acid", level: "error", taskId: t.id, msg: "Do not mix bleach with acids (vinegar, muriatic, etc.)." });
      }

      // Ventilation logic
      if (t.ventilation && t.ventilation.required) {
        if (!t.ventilation.reentryAt || Date.parse(t.ventilation.reentryAt) <= Date.parse(t.scheduledAt)) {
          warnings.push({ code: "ventilation.reentry", level: "error", taskId: t.id, msg: "Re-entry time must be after task time when ventilation is required." });
        }
        if (t.roomId && roomMap[t.roomId] && !roomMap[t.roomId].constraints.requiresVentilation) {
          warnings.push({ code: "ventilation.room.flag", level: "info", taskId: t.id, msg: "Mark room as requiresVentilation or review chemical choice." });
        }
      }
    }

    // Equipment/time overlaps (vacuum/mop conflicts, bucket reuse, etc.)
    for (var a = 0; a < plan.tasks.length; a++) {
      var A = plan.tasks[a];
      if (!A.tools || !A.tools.length) continue;
      for (var b = a + 1; b < plan.tasks.length; b++) {
        var B = plan.tasks[b];
        if (!B.tools || !B.tools.length) continue;
        var shared = A.tools.filter(function (tool) { return B.tools.indexOf(tool) >= 0; });
        if (shared.length && minutesOverlap(A.scheduledAt, A.durationMin, B.scheduledAt, B.durationMin)) {
          // If they share a room, it’s a stronger warning
          var level = (A.roomId && B.roomId && A.roomId === B.roomId) ? "warn" : "info";
          warnings.push({
            code: "tools.overlap",
            level: level,
            taskIds: [A.id, B.id],
            msg: "Overlapping tasks share tools: " + shared.join(", ")
          });
        }
      }
    }

    // Room stepping conflicts (mop while vacuuming the same room)
    for (var i1 = 0; i1 < plan.tasks.length; i1++) {
      for (var i2 = i1 + 1; i2 < plan.tasks.length; i2++) {
        var T1 = plan.tasks[i1], T2 = plan.tasks[i2];
        if (T1.roomId && T2.roomId && T1.roomId === T2.roomId && minutesOverlap(T1.scheduledAt, T1.durationMin, T2.scheduledAt, T2.durationMin)) {
          var pair = [T1.kind, T2.kind].sort().join("+");
          if (pair.indexOf("mop") >= 0 && pair.indexOf("vacuum") >= 0) {
            warnings.push({ code: "room.wet_vs_vacuum", level: "warn", taskIds: [T1.id, T2.id], msg: "Vacuuming overlaps with mopping in the same room." });
          }
        }
      }
    }

    // Optional: placement rules (e.g., chemicals not allowed on certain surfaces)
    if (placementRules && typeof placementRules.validate === "function") {
      try {
        var pr = placementRules.validate({ rooms: plan.rooms, surfaces: plan.surfaces, tasks: plan.tasks, domain: "cleaning" });
        if (pr && pr.warnings && pr.warnings.length) {
          for (var w = 0; w < pr.warnings.length; w++) {
            var W = pr.warnings[w];
            warnings.push({ code: "placement." + (W.code || "rule"), level: W.level || "warn", msg: W.msg || "Placement rule warning." });
          }
        }
      } catch (e) { /* no-op */ }
    }

    // Optional: pre-steps (soak, pre-treat, schedule sequences)
    if (scheduleHelpers && typeof scheduleHelpers.computePresteps === "function") {
      try {
        var pre = scheduleHelpers.computePresteps(plan.tasks || []);
        if (pre && pre.alerts && pre.alerts.length) {
          for (var p = 0; p < pre.alerts.length; p++) {
            var al = pre.alerts[p];
            warnings.push({ code: "prestep." + (al.code || "alert"), level: al.level || "info", msg: al.msg || "Pre-step advisory." });
          }
        }
      } catch (e) { /* no-op */ }
    }

    return warnings;
  }

  // ----------------------------- Metrics -----------------------------
  function computeMetrics(plan) {
    var tasksByKind = { sweep:0, vacuum:0, mop:0, dust:0, sanitize:0, laundry:0, dishes:0, trash:0, maintenance:0, organize:0 };
    var totalMinutes = 0;
    var ventilationHolds = [];
    var supplies = [];

    for (var i = 0; i < plan.tasks.length; i++) {
      var t = plan.tasks[i];
      tasksByKind[t.kind] = (tasksByKind[t.kind] || 0) + 1;
      totalMinutes += Number(t.durationMin) || 0;
      if (t.ventilation && t.ventilation.required && t.ventilation.reentryAt) {
        ventilationHolds.push({ taskId: t.id, reentryAt: t.ventilation.reentryAt });
      }
    }

    // Consolidate supplies using listBuilder if present
    if (listBuilder && typeof listBuilder.buildSupplies === "function") {
      try {
        supplies = listBuilder.buildSupplies({ tasks: plan.tasks, domain: "cleaning" }) || [];
      } catch (e) { /* no-op */ }
    } else {
      // Fallback basic consolidation by name/sku
      var acc = Object.create(null);
      for (var j = 0; j < plan.tasks.length; j++) {
        var sArr = plan.tasks[j].supplies || [];
        for (var k = 0; k < sArr.length; k++) {
          var key = (sArr[k].sku || sArr[k].name || "supply").toLowerCase();
          acc[key] = (acc[key] || 0) + 1;
        }
      }
      supplies = Object.keys(acc).map(function (k) { return { key: k, qty: acc[k] }; });
    }

    return {
      tasksByKind: tasksByKind,
      totalMinutes: totalMinutes,
      ventilationHolds: ventilationHolds,
      supplies: supplies
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
   * Validate + normalize a Cleaning Plan.
   * @param {object} data raw plan
   * @param {object} opts { emit?: boolean, source?: string }
   * @returns {{ ok: boolean, errors: Array, warnings: Array, normalized: object, metrics: object }}
   */
  function validateCleanPlan(data, opts) {
    opts = opts || {};
    var emit = opts.emit !== false; // default true
    var normalized = normalizeCleanPlan(data || {});
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
            params: e.params
          };
        });
      }
    } catch (e) {
      errors.push({ keyword: "exception", message: e && e.message ? e.message : "Validation exception." });
      ok = false;
    }

    var warnings = computeWarnings(normalized);
    var metrics = computeMetrics(normalized);

    // Optional: consolidation hints
    if (workPrepConsolidation && typeof workPrepConsolidation.analyze === "function") {
      try {
        var cr = workPrepConsolidation.analyze({ tasks: normalized.tasks, domain: "cleaning" });
        if (cr && cr.warnings && cr.warnings.length) {
          for (var i = 0; i < cr.warnings.length; i++) {
            var w = cr.warnings[i];
            warnings.push({ code: "consolidation." + (w.code || "hint"), level: w.level || "info", msg: w.msg || "Consolidation hint." });
          }
        }
      } catch (e) { /* no-op */ }
    }

    var result = { ok: ok && errors.length === 0, errors: errors, warnings: warnings, normalized: normalized, metrics: metrics };

    // Emit events
    if (emit) {
      try {
        if (result.ok) {
          eventBus.emit("cleanplan.validated", {
            planId: normalized.id,
            householdId: normalized.householdId,
            metrics: metrics,
            warnings: warnings,
            ts: nowISO(),
            source: opts.source || "validator"
          });
          // NBA nudge (defensive)
          eventBus.emit("nba.updated", {
            scope: "cleaning",
            planId: normalized.id,
            hints: [
              warnings.some(function (w) { return w.code.indexOf("chem.") === 0; })
                ? { code: "resolve_chem_conflicts", label: "Fix chemical conflicts", weight: 0.9 }
                : warnings.some(function (w) { return w.code.indexOf("tools.overlap") === 0 || w.code.indexOf("room.wet_vs_vacuum") === 0; })
                  ? { code: "reschedule_conflicts", label: "Resolve room/tool overlaps", weight: 0.7 }
                  : { code: "review_plan", label: "Review cleaning plan", weight: 0.3 }
            ],
            ts: nowISO()
          });
        } else {
          eventBus.emit("cleanplan.validation_failed", {
            planId: normalized.id,
            errors: errors,
            ts: nowISO(),
            source: opts.source || "validator"
          });
        }
      } catch (e) { /* no-op */ }
    }

    return result;
  }

  // ----------------------------- Module Exports -----------------------------
  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      validateCleanPlan: validateCleanPlan,
      normalizeCleanPlan: normalizeCleanPlan,
      computeWarnings: computeWarnings,
      computeMetrics: computeMetrics,
      get schema() { return _schema || loadSchema(); },
      get ajv() { return _ajv || buildAjv(); }
    };
  } else {
    // global fallback
    // eslint-disable-next-line no-undef
    window.cleanplanValidate = { validateCleanPlan: validateCleanPlan };
  }
})();

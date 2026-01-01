/* eslint-disable no-console */
/**
 * AnimalPlanTemplates.js — registry + composable templates for Animals plans
 *
 * Goals:
 *  - Keep handlers dumb: handler calls Templates.get(id, options) and receives { id, items }
 *  - Easy to extend: Templates.register("tmpl:my-new-template", (opts)=>[...])
 *  - Safe defaults: indoor/outdoor, weather requirements, withhold & chill-chain
 *  - Consistent shape: scheduledAt (ms), estimatedMs (ms), resources/meta/constraints
 *
 * Used by:
 *  - onAnimalPlanDraftRequested.js
 */

(function () {
  // ----------------------------- Utilities ------------------------------
  function uuid() {
    return "ap:" + Math.random().toString(36).slice(2);
  }
  function minutes(n) { return Number(n || 0) * 60 * 1000; }
  function hours(n)   { return Number(n || 0) * 60 * 60 * 1000; }
  function asDate(x, fallbackMsFromNow) {
    if (!x && typeof fallbackMsFromNow === "number") return new Date(Date.now() + fallbackMsFromNow);
    if (x instanceof Date) return x;
    const d = new Date(x);
    return isNaN(d.getTime()) ? new Date(Date.now() + (fallbackMsFromNow || 0)) : d;
  }
  function clamp(n, min, max) { n = Number(n)||0; return Math.max(min, Math.min(max, n)); }
  function arr(x){ return Array.isArray(x) ? x : (x ? [x] : []); }

  function baseTask(overrides) {
    const o = overrides || {};
    const t = {
      id: o.id || uuid(),
      title: o.title || "Untitled",
      domain: "animals",
      scheduledAt: typeof o.scheduledAt === "number" ? o.scheduledAt : asDate(o.scheduledAt || new Date()).getTime(),
      estimatedMs: typeof o.estimatedMs === "number" ? o.estimatedMs : minutes(30),
      resources: Object.assign({ zone: null, appliance: null, personIds: ["u:self"] }, o.resources || {}),
      constraints: Object.assign({}, o.constraints || {}),
      meta: Object.assign({}, o.meta || {})
    };
    // Normalize common meta flags → arrays
    if (t.meta && t.meta.ppe) t.meta.ppe = arr(t.meta.ppe);
    return t;
  }

  function outdoorReq(indoorOnly, explicit) {
    if (explicit) return explicit;
    return indoorOnly ? { requires: "any", weather: "n/a" } : { requires: "dry", weather: "auto" };
  }

  function align(items) {
    // Ensure ascending by scheduledAt; no mutation of inputs
    return items.slice().sort(function(a,b){ return a.scheduledAt - b.scheduledAt; });
  }

  // ----------------------------- Registry --------------------------------
  const registry = Object.create(null);

  /**
   * Register a template
   * @param {string} id
   * @param {(options:object)=>Array|{items:Array}} fn
   */
  function register(id, fn) {
    if (!id || typeof fn !== "function") return;
    registry[id] = fn;
  }

  /**
   * Get a template result
   * @param {string} id
   * @param {object} options
   * @returns {{id:string, items:Array}|null}
   */
  function get(id, options) {
    const fn = registry[id];
    if (!fn) return null;
    const out = fn(options || {}) || [];
    const items = Array.isArray(out) ? out : (out && Array.isArray(out.items) ? out.items : []);
    return { id, items: align(items) };
  }

  function list() { return Object.keys(registry); }
  function exists(id){ return !!registry[id]; }
  function unregister(id){ delete registry[id]; }

  // --------------------------- Composable Stages --------------------------
  // Small helpers you can reuse across templates
  function stageCull(startMs, durationMs, opts) {
    const indoorOnly = !!(opts && opts.indoorOnly);
    const req = outdoorReq(indoorOnly, opts && opts.requirements);
    return baseTask({
      title: "Cull excess roosters",
      scheduledAt: startMs,
      estimatedMs: durationMs,
      resources: { zone: indoorOnly ? "garage" : "yard", personIds: arr(opts && opts.personIds || "u:self") },
      constraints: { withholdMinutes: 30 },
      meta: Object.assign({ batchName: (opts && opts.batchName) || "Batch A" }, req)
    });
  }

  function stageButchery(startMs, durationMs, opts) {
    const req = outdoorReq(!!(opts && opts.indoorOnly), opts && opts.requirements);
    return baseTask({
      title: "Butchery – " + ((opts && opts.batchName) || "Batch A"),
      scheduledAt: startMs,
      estimatedMs: durationMs,
      resources: { zone: "butchery-table", personIds: arr(opts && opts.personIds || "u:self") },
      constraints: { withholdMinutes: 45, chillChain: { maxMinutesOut: clamp(opts && opts.maxOutMin, 20, 180) || 40 } },
      meta: Object.assign({ batchCount: Number((opts && opts.count) || 3) }, req)
    });
  }

  function stageScaldEviscerate(startMs, durationMs, opts) {
    const req = outdoorReq(!!(opts && opts.indoorOnly), opts && opts.requirements);
    return baseTask({
      title: "De-feather & eviscerate",
      scheduledAt: startMs,
      estimatedMs: durationMs,
      resources: { zone: "scald-station", appliance: "scalder", personIds: arr(opts && opts.personIds || "u:self") },
      constraints: { withholdMinutes: 10, chillChain: { maxMinutesOut: 20 } },
      meta: Object.assign({ ppe: ["gloves","apron"] }, req)
    });
  }

  function stageIceDown(startMs, durationMs, opts) {
    return baseTask({
      title: "Ice-down chill",
      scheduledAt: startMs,
      estimatedMs: durationMs,
      resources: { zone: "cooler", personIds: arr(opts && opts.personIds || "u:self") },
      meta: { requires: "any", weather: "n/a" }
    });
  }

  function stageSterilize(startMs, durationMs, opts){
    return baseTask({
      title: "Sterilize tools & PPE",
      scheduledAt: startMs,
      estimatedMs: durationMs,
      resources: { zone: "butchery-table", personIds: arr(opts && opts.personIds || "u:self") },
      meta: { ppe: ["gloves"], requires: "any", weather: "n/a" }
    });
  }

  function stageBreakdown(startMs, durationMs, opts){
    return baseTask({
      title: "Breakdown carcasses",
      scheduledAt: startMs,
      estimatedMs: durationMs,
      resources: { zone: "butchery-table", personIds: arr(opts && opts.personIds || "u:self") },
      constraints: { chillChain: { maxMinutesOut: clamp(opts && opts.maxOutMin, 20, 180) || 30 } },
      meta: { requires: "any", weather: "n/a" }
    });
  }

  // ----------------------------- Built-ins --------------------------------
  /**
   * tmpl:animals-basic
   * Options:
   *  - startAt: Date|string|ms (default: now+30m)
   *  - count: number (birds)
   *  - batchName: string
   *  - indoorOnly: boolean
   *  - personIds: string|string[]
   */
  register("tmpl:animals-basic", function(opts){
    const step = minutes(60);
    const pre = minutes(15);
    const start = asDate(opts && opts.startAt, minutes(30)).getTime();
    const personIds = arr(opts && opts.personIds || "u:self");
    const baseOpts = Object.assign({}, opts, { personIds });

    const t1 = stageCull(start, step, baseOpts);
    const t2 = stageButchery(t1.scheduledAt + t1.estimatedMs, step, baseOpts);
    const t3 = stageScaldEviscerate(t2.scheduledAt + pre, step, baseOpts);
    const t4 = stageIceDown(t2.scheduledAt + t2.estimatedMs, minutes(30), baseOpts);

    return [t1, t2, t3, t4];
  });

  /**
   * tmpl:animals-processing-lite
   * A shorter indoor-friendly flow.
   */
  register("tmpl:animals-processing-lite", function(opts){
    const start = asDate(opts && opts.startAt, minutes(20)).getTime();
    const t1 = stageSterilize(start, minutes(20), opts);
    const t2 = stageBreakdown(t1.scheduledAt + minutes(25), minutes(45), opts);
    return [t1, t2];
  });

  /**
   * tmpl:animals-mobile-butcher
   * Adds arrival/setup/teardown around a standard batch; helpful for conflict testing.
   * Options:
   *  - travelMin: number (default 25)
   */
  register("tmpl:animals-mobile-butcher", function(opts){
    const start = asDate(opts && opts.startAt, minutes(45)).getTime();
    const travel = minutes(clamp(opts && opts.travelMin, 10, 120) || 25);
    const step = minutes(55);

    const arrive = baseTask({
      title: "Mobile butcher arrival & setup",
      scheduledAt: start,
      estimatedMs: travel,
      resources: { zone: "driveway", personIds: arr(opts && opts.personIds || ["u:self","vendor:butcher"]) },
      meta: outdoorReq(!!opts?.indoorOnly)
    });

    const butch = stageButchery(arrive.scheduledAt + arrive.estimatedMs, step, opts);
    const evisc = stageScaldEviscerate(butch.scheduledAt + minutes(10), step, opts);
    const chill = stageIceDown(butch.scheduledAt + butch.estimatedMs, minutes(30), opts);

    const teardown = baseTask({
      title: "Teardown & sanitation",
      scheduledAt: chill.scheduledAt + chill.estimatedMs,
      estimatedMs: minutes(20),
      resources: { zone: "butchery-table", personIds: arr(opts && opts.personIds || ["u:self","vendor:butcher"]) },
      meta: { ppe: ["gloves"], requires: "any", weather: "n/a" }
    });

    return [arrive, butch, evisc, chill, teardown];
  });

  // ------------------------------ Exports --------------------------------
  const api = { register, get, list, exists, unregister };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    try { window.AnimalPlanTemplates = api; } catch (_e) {}
  }
})();

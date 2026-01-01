/* eslint-disable no-console */
/**
 * onAnimalPlanDraftRequested.js — dynamic generator for Animals plan drafts (ES2015-safe)
 *
 * Listens (canonical; aliases normalized upstream):
 *   - "animalplan.draft.requested"
 *
 * Emits:
 *   - "animalplan.generated"            // draft items + metadata
 *   - "prep.tasks.requested"            // build sanitizer/defrost/etc
 *   - "supply.shortage.detected"        // feed/glove/bag/ice/etc
 *   - "planner.conflict.requested"      // early conflict scan (weather/withhold/etc)
 *   - "nba.updated"                     // quick nudges to review plan, buy items, or start prep
 */

(function () {
  /* ----------------------------- Safe Imports ----------------------------- */
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

  var InventoryMonitor = { notes: function(){ return {}; } };
  try { InventoryMonitor = prefer(require("@/managers/InventoryMonitor"), ["notes"]); } catch (e) {}

  var AnimalTemplates = { get: function(){ return null; } };
  try { AnimalTemplates = prefer(require("@/libraries/AnimalPlanTemplates"), ["get"]); } catch (e) {}

  var emit = (EventsHub && EventsHub.emit) ? EventsHub.emit : function(){};
  var on   = (EventsHub && EventsHub.on)   ? EventsHub.on   : function(){};

  var DEV = true;

  /* ------------------------------ Utilities ------------------------------ */
  function uuid(){ return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=(Math.random()*16)|0,v=c==="x"?r:(r&0x3)|0x8;return v.toString(16);}); }
  function safeDate(x){ if(!x) return new Date(); if(x instanceof Date) return x; var d=new Date(x); return isNaN(d.getTime())?new Date():d; }
  function toMs(v, unit){ if(v==null) return 0; var n=Number(v)||0,M=60000,H=3600000; switch(unit){ case "m": case "min": case "minute": case "minutes":return n*M; case "h": case "hour": case "hours":return n*H; default: return n; } }
  function getSetting(key, fallback){ try{ var v=SettingsStore.get && SettingsStore.get(key); return (v==null?fallback:v);}catch(e){return fallback;} }
  function toArray(x){ return Array.isArray(x)?x:(x==null?[]:[x]); }

  function startIn(minutes){ return new Date(Date.now() + minutes * 60000).toISOString(); }

  /* ------------------------------ Templates ------------------------------ */
  /**
   * Very lightweight in-file templates so the handler works out of the box.
   * If @/libraries/AnimalPlanTemplates exists, it will be used instead.
   */
  var BuiltInTemplates = {
    "tmpl:animals-basic": function(opts){
      var batchName = (opts && opts.batchName) || "Batch A";
      var headCount = Number((opts && opts.count) || 3);
      var outdoor = !(opts && opts.indoorOnly);

      var nowIso = new Date().toISOString();
      var t0 = safeDate(opts && opts.startAt || startIn(30)); // 30m from now
      var pre  = toMs(15, "m");
      var step = toMs(60, "m");

      return [
        {
          id: uuid(),
          title: "Cull excess roosters",
          domain: "animals",
          scheduledAt: t0.getTime(),
          estimatedMs: step,
          resources: { zone: outdoor ? "yard" : "garage", personIds: ["u:self"] },
          constraints: { withholdMinutes: 30 },
          meta: { batchName: batchName, requires: outdoor ? "dry" : "any", weather: outdoor ? "auto" : "n/a" }
        },
        {
          id: uuid(),
          title: "Butchery – " + batchName,
          domain: "animals",
          scheduledAt: t0.getTime() + step,
          estimatedMs: step,
          resources: { zone: "butchery-table", personIds: ["u:self"], appliance: null },
          constraints: { withholdMinutes: 45, chillChain: { maxMinutesOut: 40 } },
          meta: { batchCount: headCount, requires: outdoor ? "dry" : "any", weather: outdoor ? "auto" : "n/a" }
        },
        {
          id: uuid(),
          title: "De-feather & eviscerate",
          domain: "animals",
          scheduledAt: t0.getTime() + step + pre,
          estimatedMs: step,
          resources: { zone: "scald-station", personIds: ["u:self"], appliance: "scalder" },
          constraints: { withholdMinutes: 10, chillChain: { maxMinutesOut: 20 } },
          meta: { ppe: ["gloves","apron"], requires: "dry", weather: outdoor ? "auto" : "n/a" }
        },
        {
          id: uuid(),
          title: "Ice-down chill",
          domain: "animals",
          scheduledAt: t0.getTime() + 2 * step,
          estimatedMs: toMs(30, "m"),
          resources: { zone: "cooler", personIds: ["u:self"] },
          constraints: { withholdMinutes: 0 },
          meta: { requires: "any", weather: "n/a" }
        }
      ];
    },

    "tmpl:animals-processing-lite": function(opts){
      var t0 = safeDate(opts && opts.startAt || startIn(20));
      return [
        {
          id: uuid(),
          title: "Sterilize tools & PPE",
          domain: "animals",
          scheduledAt: t0.getTime(),
          estimatedMs: toMs(20, "m"),
          resources: { zone: "butchery-table", personIds: ["u:self"] },
          constraints: {},
          meta: { ppe: ["gloves"], requires: "any", weather: "n/a" }
        },
        {
          id: uuid(),
          title: "Breakdown carcasses",
          domain: "animals",
          scheduledAt: t0.getTime() + toMs(25, "m"),
          estimatedMs: toMs(45, "m"),
          resources: { zone: "butchery-table", personIds: ["u:self"] },
          constraints: { chillChain: { maxMinutesOut: 30 } },
          meta: { requires: "any", weather: "n/a" }
        }
      ];
    }
  };

  function resolveTemplate(templateId, options){
    try {
      var fromLib = AnimalTemplates.get && AnimalTemplates.get(templateId, options);
      if (fromLib && Array.isArray(fromLib.items)) return fromLib.items;
    } catch (e) {}
    var fn = BuiltInTemplates[templateId] || BuiltInTemplates["tmpl:animals-basic"];
    return fn(options || {});
  }

  function inferShortagesFrom(items, opts){
    // Simple heuristic: gloves, bags, ice; layer feed if plan has "feed" tasks (extend as needed)
    var out = [];
    var needGloves = items.some(function(i){ return (i.meta && i.meta.ppe && i.meta.ppe.indexOf("gloves")>=0) || /Butch|Eviscerate|Sterilize/i.test(i.title); });
    var needIce    = items.some(function(i){ return /Ice|chill/i.test(i.title); });
    if (needGloves) out.push({ id: uuid(), domain:"animals", name:"Disposable gloves", requiredQty: 1, unit:"box", neededBy: new Date(items[0].scheduledAt).toISOString() });
    if (needIce)    out.push({ id: uuid(), domain:"animals", name:"Ice (20lb)", requiredQty: 2, unit:"bag", neededBy: new Date(items[0].scheduledAt).toISOString() });
    if (opts && opts.includeFeed) out.push({ id: uuid(), domain:"animals", name:"Layer feed 50lb", requiredQty: 1, unit:"bag", neededBy: startIn(6*60) });
    return out;
  }

  function buildPrepFrom(items){
    // Convert high-level items into prep “neededBy” targets with leadTimes
    return items.map(function(it){
      var lead = {};
      // Sanitize just before butchery; defrost seldom for fresh kill, keep generic.
      if (/Sterilize|Butchery|Eviscerate|Breakdown/i.test(it.title)) lead.sanitizeMinutes = 10;
      return {
        id: "prep-for:" + it.id,
        title: "Prep: " + it.title,
        domain: "animals",
        neededBy: new Date(it.scheduledAt + Math.max(0, it.estimatedMs || 0)).toISOString(),
        leadTimes: lead,
        resources: { ppe: ["gloves"] },
        constraints: it.constraints || {},
        meta: { preheatGroupKey: null }
      };
    });
  }

  function buildConflictProbe(items){
    // Feed the planner a minimal shape; it will detect weather/withhold/etc.
    return {
      items: items.map(function(it){
        return {
          id: it.id,
          title: it.title,
          domain: it.domain,
          scheduledAt: it.scheduledAt,
          estimatedMs: it.estimatedMs,
          resources: it.resources,
          constraints: it.constraints,
          meta: it.meta
        };
      }),
      options: { source: "animals", sabbathGuard: !!getSetting("sabbathGuard", false) }
    };
  }

  /* ------------------------------ Orchestrator --------------------------- */
  function handleAnimalPlanDraftRequested(envelope) {
    var env = (eventAliases && eventAliases.canonicalizeEnvelope) ? eventAliases.canonicalizeEnvelope(envelope) : (envelope || {});
    if (!env || env.topic !== "animalplan.draft.requested") return;

    var payload = env.payload || {};
    var sessionId = payload.sessionId || env.sessionId || null;
    var planId = payload.planId || ("plan:" + uuid());
    var templateId = payload.templateId || "tmpl:animals-basic";
    var options = payload.options || {};

    // Session awareness (pause/resume, anchor)
    var session = null;
    try { if (sessionId && SessionStore.getById) session = SessionStore.getById(sessionId) || null; } catch (e) {}

    // 1) Build items from template
    var items = resolveTemplate(templateId, options);
    // Shift if session paused and tasks would start before resume
    if (session && session.state === "paused" && session.resumeAt) {
      var resume = safeDate(session.resumeAt).getTime();
      items = items.map(function(it){
        if (it.scheduledAt < resume) {
          var delta = resume - it.scheduledAt;
          it.scheduledAt = it.scheduledAt + delta;
        }
        return it;
      });
    }

    // 2) Emit generated plan
    var draft = {
      planId: planId,
      sessionId: sessionId,
      status: "generated",
      items: items,
      meta: {
        templateId: templateId,
        createdAt: new Date().toISOString(),
        options: options
      }
    };

    try { emit("animalplan.generated", draft, { topic: "animalplan.generated" }); } catch (e) {}
    if (DEV) try { console.debug("[animalplan] generated:", planId, "items:", items.length); } catch (e) {}

    // 3) Ask for PREP tasks
    try {
      emit("prep.tasks.requested", {
        sessionId: sessionId,
        planId: planId,
        source: "animals",
        items: buildPrepFrom(items),
        options: { sabbathGuard: !!getSetting("sabbathGuard", false) }
      }, { topic: "prep.tasks.requested" });
    } catch (e) {}

    // 4) Probe shortages (gloves, ice, optional feed)
    var shortageItems = inferShortagesFrom(items, options);
    if (shortageItems.length) {
      try {
        emit("supply.shortage.detected", {
          items: shortageItems,
          options: {
            attemptSubstitutions: true,
            autoGenerateList: true,
            autoPurchase: !!options.autoPurchase
          },
          sessionId: sessionId,
          planId: planId
        }, { topic: "supply.shortage.detected" });
      } catch (e) {}
    }

    // 5) Early conflict scan (weather/withhold/chill-chain/person/zone)
    try {
      emit("planner.conflict.requested", Object.assign({ sessionId: sessionId, planId: planId }, buildConflictProbe(items)), { topic: "planner.conflict.requested" });
    } catch (e) {}

    // 6) NBA: quick nudges to review/begin
    try {
      emit(Events.NBA_UPDATED || "nba.updated", {
        scope: { sessionId: sessionId, planId: planId, source: "animals" },
        suggestions: [
          {
            id: "nba:review-plan:" + planId,
            label: "Review Animal Plan",
            when: new Date().toISOString(),
            badges: ["plan","animals"],
            action: { type: "plan.open", payload: { planId: planId } }
          },
          {
            id: "nba:start-prep:" + planId,
            label: "Start sanitizer & PPE prep",
            when: new Date().toISOString(),
            badges: ["prep","animals"],
            action: { type: "prep.tasks.open", payload: { planId: planId, sessionId: sessionId } }
          }
        ]
      }, { topic: Events.NBA_UPDATED || "nba.updated" });
    } catch (e) {}
  }

  /* ------------------------------- Register ------------------------------- */
  function registerOn(hub){
    var api = hub && hub.on ? hub : { on: on };
    try { api.on("animalplan.draft.requested", handleAnimalPlanDraftRequested); }
    catch(e){ try { on("animalplan.draft.requested", handleAnimalPlanDraftRequested); } catch(e2){} }
  }

  // Auto-register
  try { registerOn(EventsHub); } catch(e){}

  /* -------------------------------- Export -------------------------------- */
  var api = {
    register: registerOn,
    _internals: {
      resolveTemplate: resolveTemplate,
      inferShortagesFrom: inferShortagesFrom,
      buildPrepFrom: buildPrepFrom,
      handleAnimalPlanDraftRequested: handleAnimalPlanDraftRequested
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    try { window.onAnimalPlanDraftRequested = api; } catch (e) {}
  }
})();

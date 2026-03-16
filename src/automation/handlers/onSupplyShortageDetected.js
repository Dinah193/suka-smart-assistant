/* eslint-disable no-console */
/**
 * onSupplyShortageDetected.js — dynamic orchestration for supply gaps (ES2015-safe)
 *
 * Listens (aliases normalized upstream by eventAliases):
 *   - "inventory.shortage.detected"
 *
 * Emits (via unified events hub):
 *   - "supply.shortage.processed"
 *   - "grocerylist.requested"
 *   - "purchase.order.requested"
 *   - "plan.adjustment.requested"
 *   - "substitution.suggested"
 *   - "nba.updated"
 *   - "reminder.schedule.requested"
 *   - "calendar.event.requested"
 *
 * Cross-domain: cooking, cleaning, animals/butchery, garden
 * 3)b) updates baked-in:
 *   • Canonical events + alias normalization; mirrors legacy names automatically
 *   • Vendor/store routing with user defaults; aisle hints & “short vs have” badges
 *   • Expanded flour substitution logic incl. fresh-milled whole grain + hydration guidance
 *   • Sabbath Guard windowing; pause-aware session reminders; pickup calendar paint
 *   • Cost estimates via EstimateEngine; NBA cards for Replace | Add to List | Adjust Plan | Auto-Order
 */

(function () {
  // --------------------------- Safe Imports ---------------------------
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
    if (!EventsHub || !EventsHub.emit || !EventsHub.on) {
      EventsHub = require("@/automation/events/index") || EventsHub;
    }
    Events = (EventsHub && (EventsHub.Events || (EventsHub.default && EventsHub.default.Events))) || {};
  } catch (e) {}

  var eventAliases = {};
  try { eventAliases = require("@/services/eventAliases") || {}; } catch (e) {}

  var InventoryMonitor = { notes: function(){ return {}; }, category: function(){ return null; } };
  try { InventoryMonitor = prefer(require("@/managers/InventoryMonitor"), ["notes","category"]); } catch (e) {}

  var ListBuilder = { build: function(items, opts){ return { items: items||[], storeId: (opts&&opts.storeId)||null, aisleGroups:{}, collapsedDuplicates:true }; } };
  try { ListBuilder = prefer(require("@/managers/ListBuilder"), ["build"]); } catch (e) {}

  var EstimateEngine = { estimateLines: function(lines){ return { total: 0, lines: (lines||[]).map(function(l){ l.unitPrice=l.unitPrice||0; l.lineTotal=(l.unitPrice||0)*(l.qty||1); return l; }) }; } };
  try { EstimateEngine = prefer(require("@/engines/estimateEngine"), ["estimateLines"]); } catch (e) {}

  var ScheduleHelpers = { buyBy: function(neededBy, leadMinutes){ var nb=new Date(neededBy?new Date(neededBy):Date.now()); return new Date(nb.getTime()-((leadMinutes||120)*60000)); } };
  try { ScheduleHelpers = prefer(require("@/helpers/scheduleHelpers"), ["buyBy"]); } catch (e) {}

  var SettingsStore = { get: function(){ return undefined; } };
  try { SettingsStore = prefer(require("@/stores/SettingsStore"), ["get"]); } catch (e) {}

  var SessionStore = { getById: function(){ return null; } };
  try { SessionStore = prefer(require("@/stores/SessionStore"), ["getById"]); } catch (e) {}

  var SubstitutionEngine = { suggest: function(){ return []; } };
  try { SubstitutionEngine = prefer(require("@/engines/SubstitutionEngine"), ["suggest"]); } catch (e) {}

  var GardenQueueManager = { suggestPlanting: function(){ return null; } };
  try { GardenQueueManager = prefer(require("@/managers/GardenQueueManager"), ["suggestPlanting"]); } catch (e) {}

  var AnimalQueueManager = { suggestFeedPlan: function(){ return null; } };
  try { AnimalQueueManager = prefer(require("@/managers/AnimalQueueManager"), ["suggestFeedPlan"]); } catch (e) {}

  var ReminderManager = { schedule: function(){} };
  try { ReminderManager = prefer(require("@/managers/ReminderManager"), ["schedule"]); } catch (e) {}

  // Hub helpers (no-op safe)
  var emit = (EventsHub && EventsHub.emit) ? EventsHub.emit : function(){};
  var on   = (EventsHub && EventsHub.on)   ? EventsHub.on   : function(){};

  var DEV = true;

  // --------------------------- Utilities --------------------------------
  function uuid(){ return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=(Math.random()*16)|0,v=c==="x"?r:(r&0x3)|0x8;return v.toString(16);}); }
  function safeDate(x){ if(!x) return new Date(); if(x instanceof Date) return x; var d=new Date(x); return isNaN(d.getTime())?new Date():d; }
  function toArray(x){ return Array.isArray(x)?x:(x==null?[]:[x]); }
  function getSetting(key, fallback){ try{ var v=SettingsStore.get && SettingsStore.get(key); return (v==null?fallback:v);}catch(e){return fallback;} }

  function applySabbathGuard(dt, enabled){
    if(!enabled) return dt;
    try{
      var d = new Date(dt.getTime());
      var ref = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 18,0,0,0);
      var diffToFri = (5 - d.getDay());
      var fri = new Date(ref.getTime() + diffToFri*86400000);
      var sat = new Date(fri.getTime() + 86400000);
      var inBlock = (d >= fri && d < sat) || (d.getDay()===6 && d.getHours()<18);
      if (!inBlock) return d;
      return new Date(fri.getTime() - 30*60000);
    } catch(e){ return dt; }
  }

  function coalesceLines(lines){
    var map = {};
    (lines||[]).forEach(function(l){
      var key = (l.storeId||"*")+"::"+(l.sku||l.name||"unknown")+"::"+(l.unit||"");
      if(!map[key]) map[key]=Object.assign({},l,{ qty:Number(l.qty||0) });
      else map[key].qty += Number(l.qty||0);
      if (!map[key].aisleHint && l.aisleHint) map[key].aisleHint = l.aisleHint;
      // carry badges
      map[key].tags = Array.from(new Set((map[key].tags||[]).concat(toArray(l.tags))));
    });
    return Object.keys(map).map(function(k){ return map[k]; });
  }

  // ------------------ Flour-aware fallback substitutions ------------------
  var HEURISTIC_SUBS = {
    cooking: {
      AP_FLOUR: [
        { name:"Bread flour", reason:"Higher protein; +2–5% water" },
        { name:"Fresh-milled hard white (whole grain)", reason:"+10–15% water; 20–30 min autolyse" }
      ],
      BREAD_FLOUR: [
        { name:"All-purpose flour", reason:"Lower protein; −2–4% water" },
        { name:"Fresh-milled hard red/white (whole grain)", reason:"+10–15% water; longer bulk; optional +1–2% vital gluten" }
      ],
      WHOLE_WHEAT_FLOUR: [
        { name:"Fresh-milled (whole grain)", reason:"+5–10% water; sift bran for lighter crumb" },
        { name:"Bread flour", reason:"Lighter crumb; similar water" }
      ],
      FRESH_GROUND_WHOLE_GRAIN: [
        { name:"Commercial whole-wheat", reason:"−3–5% water vs fresh-milled" },
        { name:"Bread flour + 10% wheat bran", reason:"Closer flavor; autolyse 20 min" }
      ],
      FLOUR_ANY: [
        { name:"Fresh-milled hard white wheat", reason:"+8–12% water; 20–30 min autolyse" }
      ],
      CHICKEN_STOCK: [{ name:"Water + salt + umami (miso/soy)", reason:"Flavor proxy" }],
      EGG: [{ name:"Flax egg (1 Tbsp flax + 3 Tbsp water)", reason:"Binder for baking" }]
    },
    cleaning: {
      BLEACH: [{ name:"Hydrogen peroxide 3%", reason:"Non-chlorine oxidizer" }],
      DEGREASER: [{ name:"Hot water + dish soap + baking soda", reason:"DIY degreaser" }]
    },
    animals: {
      LAYER_FEED: [{ name:"Scratch + protein supplement", reason:"Temporary ration" }]
    },
    garden: {
      POTTING_SOIL: [{ name:"Compost + perlite + coco coir", reason:"DIY potting mix" }],
      SEED_STARTER: [{ name:"Fine compost + vermiculite", reason:"DIY starter mix" }]
    }
  };

  function resolveFlourKey(sku, name){
    var s=(sku||name||"").toString().toUpperCase();
    var isFlour=/\bFLOUR\b/.test(s)||/\bWHEAT\b/.test(s);
    var isAP=/\bAP\b/.test(s)||/ALL[-\s]?PURPOSE/.test(s);
    var isBread=/\bBREAD\b/.test(s);
    var isWhole=/WHOLE[-\s]?WHEAT/.test(s)||/\bWW\b/.test(s);
    var isFresh=/FRESH(LY)?/.test(s)||/GROUND|MILLED/.test(s);
    if (isFlour){
      if (isFresh) return "FRESH_GROUND_WHOLE_GRAIN";
      if (isWhole) return "WHOLE_WHEAT_FLOUR";
      if (isBread) return "BREAD_FLOUR";
      if (isAP) return "AP_FLOUR";
      return "FLOUR_ANY";
    }
    if (HEURISTIC_SUBS.cooking[s]) return s;
    return null;
  }

  function suggestSubsFallback(sku, name, category, domain){
    var bank = HEURISTIC_SUBS[domain||"cooking"] || {};
    var flourKey = resolveFlourKey(sku,name);
    var key = flourKey;
    if (!key){
      var direct=(sku||name||"").toString().toUpperCase().replace(/\s+/g,"_");
      key = bank[direct] ? direct : null;
    }
    var arr=(key && bank[key]) ? bank[key] : (bank.FLOUR_ANY || []);
    return arr.map(function(x){ return { sku:null, name:x.name, reason:x.reason, penaltyScore:0.4, notes:x.reason }; });
  }

  // --------------------------- Normalization -----------------------------
  function normalizeShortage(x){
    var inv={};
    try { inv = (InventoryMonitor.notes && x.sku) ? (InventoryMonitor.notes(x.sku)||{}) : {}; } catch(e){}
    var cat = x.category || (InventoryMonitor.category ? InventoryMonitor.category(x.sku) : inv.category) || null;

    return {
      id: x.id || uuid(),
      sku: x.sku || null,
      name: x.name || inv.name || "Unknown item",
      requiredQty: Number(x.requiredQty || 1),
      unit: x.unit || inv.unit || "",
      domain: x.domain || "cooking",
      neededBy: x.neededBy || null,
      planId: x.planId || null,
      sessionId: x.sessionId || null,
      priority: x.priority || "normal",
      tags: Array.isArray(x.tags) ? x.tags.slice() : [],
      category: cat,
      storeId: x.storeId || (inv.storeIds && inv.storeIds[0]) || null,
      aisleHint: x.aisleHint || inv.aisleHint || null,
      lastVendor: inv.lastVendor || null,
      context: x.context || {}
    };
  }

  // --------------------------- Core Handler ------------------------------
  function handleSupplyShortageDetected(envelope){
    // Canonicalize envelope via alias layer
    var env = (eventAliases && eventAliases.canonicalizeEnvelope) ? eventAliases.canonicalizeEnvelope(envelope) : (envelope || {});
    if (!env || env.topic !== "inventory.shortage.detected") return;

    var payload = env.payload || {};
    var shortages = Array.isArray(payload.items) ? payload.items : [];
    var options = payload.options || {};

    var attemptSubs   = options.attemptSubstitutions !== false; // default true
    var autoList      = options.autoGenerateList    !== false;  // default true
    var autoPurchase  = !!options.autoPurchase;
    var sabbathGuard  = !!options.sabbathGuard || !!getSetting("sabbathGuard", false);
    var vendorPref    = options.vendorPreference || getSetting("preferredVendor", null);
    var storeSelector = options.storeSelector || getSetting("defaultStoreId", null);

    var session = null;
    try { if ((payload.sessionId || env.sessionId) && SessionStore.getById) { session = SessionStore.getById(payload.sessionId || env.sessionId) || null; } } catch(e){}

    // 1) Normalize
    var normalized = shortages.map(normalizeShortage);

    // 2) Substitutions (engine → fallback heuristics)
    var subsMap = {};
    normalized.forEach(function(item){
      if (!attemptSubs) return;
      var suggested = [];
      try {
        suggested = (SubstitutionEngine.suggest)
          ? (SubstitutionEngine.suggest(
              { sku:item.sku, name:item.name, category:item.category, domain:item.domain },
              { vendorPreference: vendorPref, storeId: storeSelector }
            ) || [])
          : [];
      } catch(e){}
      if (!suggested || !suggested.length) { suggested = suggestSubsFallback(item.sku, item.name, item.category, item.domain); }
      if (suggested && suggested.length) subsMap[item.id] = suggested;
    });

    // Emit substitution suggestions (for UI cards/tooltips)
    Object.keys(subsMap).forEach(function(shortageId){
      try { emit("substitution.suggested", { shortageId: shortageId, items: subsMap[shortageId] }, { topic: "substitution.suggested" }); } catch(e){}
    });

    // 3) Decide: list lines vs plan adjustments
    var listLines = [];
    var planAdjustments = [];

    normalized.forEach(function(item){
      var neededSoon = false;
      if (item.neededBy){
        var diffMs = safeDate(item.neededBy).getTime() - Date.now();
        neededSoon = diffMs <= (6 * 3600000);
      }

      var hasSubs = !!subsMap[item.id] && subsMap[item.id].length > 0;
      if (neededSoon && !hasSubs){
        planAdjustments.push({
          id: "adj:"+item.id,
          planId: item.planId,
          sessionId: item.sessionId,
          reason: "shortage",
          message: "Adjust plan: " + item.name + " unavailable before needed time.",
          suggestions: [
            { type: "delay", label: "Delay task/recipe" },
            { type: "skip",  label: "Skip this item" },
            { type: "replace", label: "Replace with another ingredient" }
          ],
          context: item
        });
      }

      if (autoList){
        var qty = Number(item.requiredQty || 1);
        listLines.push({
          id: "line:"+item.id,
          sku: item.sku,
          name: item.name,
          qty: qty > 0 ? qty : 1,
          unit: item.unit,
          domain: item.domain,
          storeId: item.storeId || storeSelector || null,
          aisleHint: item.aisleHint || null,
          tags: (item.tags || []).concat(["short","auto-added"]),
          neededBy: item.neededBy || null,
          vendorPreference: vendorPref || item.lastVendor || null,
          context: item.context || {}
        });
      }
    });

    // 4) Coalesce & build list (with aisle groups, badges)
    var collapsed = coalesceLines(listLines);
    var builtList = null;
    try {
      builtList = ListBuilder.build(collapsed, {
        storeId: storeSelector,
        collapseDuplicates: true,
        includeHave: true,                 // show have vs short badges in UI
        showAisles: true,
        sabbathGuard: sabbathGuard,
        showShortVsHaveBadges: true
      }) || { items: collapsed, aisleGroups:{}, collapsedDuplicates:true };
    } catch(e){
      builtList = { items: collapsed, aisleGroups:{}, collapsedDuplicates:true };
    }

    // 5) Cost estimate
    var estimated = { total: 0, lines: builtList.items };
    try {
      estimated = (EstimateEngine.estimateLines && EstimateEngine.estimateLines(builtList.items, {
        storeId: builtList.storeId || storeSelector || null,
        vendorPreference: vendorPref,
        domains: Array.from(new Set(builtList.items.map(function(i){return i.domain;})))
      })) || { total: 0, lines: builtList.items };
    } catch(e){}

    // 6) Reminders & calendar (errand/pickup)
    var reminders = [];
    estimated.lines.forEach(function(l){
      if (!l.neededBy) return;
      var when = ScheduleHelpers.buyBy(l.neededBy, 120);
      when = applySabbathGuard(when, sabbathGuard);

      // Pause-aware sessions: if paused and reminder falls in pause, push to resume
      try {
        if (session && session.state === "paused" && session.resumeAt) {
          var resume = safeDate(session.resumeAt).getTime();
          if (when.getTime() < resume) when = new Date(resume);
        }
      } catch(e){}

      reminders.push({
        id: "reminder:"+l.id,
        title: "Buy: " + (l.name || l.sku),
        message: "Needed by " + safeDate(l.neededBy).toLocaleString(),
        when: when,
        storeId: l.storeId || storeSelector || null
      });
    });

    reminders.forEach(function(r){
      try {
        if (ReminderManager && typeof ReminderManager.schedule === "function") {
          ReminderManager.schedule({
            id: r.id, title: r.title, message: r.message, when: r.when,
            context: { type: "supply-shortage", storeId: r.storeId },
            channels: toArray(getSetting("notifications.channelsDefault", ["toast","modal"])),
            priority: "high"
          });
        } else {
          emit("reminder.schedule.requested", {
            id: r.id, title: r.title, message: r.message, when: r.when.toISOString(),
            context: { type: "supply-shortage", storeId: r.storeId }
          }, { topic: "reminder.schedule.requested" });
        }
      } catch(e){}

      try {
        emit("calendar.event.requested", {
          title: r.title + (r.storeId ? (" @ Store " + r.storeId) : ""),
          start: r.when.toISOString(),
          end: new Date(r.when.getTime() + 30*60000).toISOString(),
          tags: ["errand","shopping"]
        }, { topic: "calendar.event.requested" });
      } catch(e){}
    });

    // 7) Domain aux (garden/animals nudges)
    var aux = [];
    normalized.forEach(function(item){
      if (item.domain === "garden" && GardenQueueManager && GardenQueueManager.suggestPlanting) {
        try { var gp = GardenQueueManager.suggestPlanting({ category:item.category, shortage:item }); if (gp) aux.push({ type:"garden.plan.suggestion", details: gp }); } catch(e){}
      }
      if (item.domain === "animals" && AnimalQueueManager && AnimalQueueManager.suggestFeedPlan) {
        try { var ap = AnimalQueueManager.suggestFeedPlan({ sku:item.sku, shortage:item }); if (ap) aux.push({ type:"animals.feed.plan.suggestion", details: ap }); } catch(e){}
      }
    });

    // 8) NBA cards (Replace | Add to List | Adjust Plan | Auto-Order)
    var nba = [];
    normalized.forEach(function(item){
      var subs = subsMap[item.id] || [];
      subs.slice(0,3).forEach(function(s, idx){
        nba.push({
          id: "nba:sub:"+item.id+":"+idx,
          label: "Replace " + item.name + " → " + (s.name || s.sku),
          when: new Date().toISOString(),
          badges: ["shortage","substitution"],
          hint: s.notes || s.reason || "",
          action: { type: "substitution.apply", payload: { shortageId:item.id, substitute:s, planId:item.planId, sessionId:item.sessionId } }
        });
      });

      nba.push({
        id: "nba:list:"+item.id,
        label: "Add to Shopping List: " + item.name,
        when: new Date().toISOString(),
        badges: ["shopping","list"],
        action: { type: "shopping.list.add", payload: { sku:item.sku, name:item.name, qty:item.requiredQty, unit:item.unit, storeId: storeSelector } }
      });

      var neededSoon = item.neededBy ? (safeDate(item.neededBy).getTime() - Date.now()) <= (6*3600000) : false;
      if (neededSoon && (!subs || !subs.length)) {
        nba.push({
          id: "nba:adj:"+item.id,
          label: "Adjust plan (shortage): " + item.name,
          when: new Date().toISOString(),
          badges: ["planning","urgent"],
          action: { type: "plan.adjustment.requested", payload: { planId:item.planId, sessionId:item.sessionId, reason:"shortage", item:item } }
        });
      }

      if (autoPurchase) {
        nba.push({
          id: "nba:order:"+item.id,
          label: "Auto-order: " + item.name,
          when: new Date().toISOString(),
          badges: ["shopping","auto"],
          action: { type: "purchase.order.requested", payload: { vendorPreference: vendorPref, storeId: storeSelector, lines: [{ sku:item.sku, name:item.name, qty:item.requiredQty, unit:item.unit }], context:{ reason:"supply-shortage", sessionId:item.sessionId, planId:item.planId } } }
        });
      }
    });

    if (nba.length) {
      try {
        emit(Events.NBA_UPDATED || "nba.updated", {
          scope: { sessionId: payload.sessionId || env.sessionId || null, planId: payload.planId || null, source: "supply" },
          suggestions: nba
        }, { topic: Events.NBA_UPDATED || "nba.updated" });
      } catch(e){}
    }

    // 9) Emit plan adjustments
    planAdjustments.forEach(function(adj){
      try { emit("plan.adjustment.requested", adj, { topic: "plan.adjustment.requested" }); } catch(e){}
    });

    // 10) Emit grocery list build
    try {
      emit("grocerylist.requested", {
        source: "shortage",
        items: estimated.lines,
        storeId: builtList.storeId || storeSelector || null,
        aisleGroups: builtList.aisleGroups || {},
        collapsedDuplicates: true,
        estimatedTotal: estimated.total,
        options: {
          showAisles: true,
          storeSelector: !!storeSelector,
          includeHave: true,
          collapseDuplicates: true,
          sabbathGuard: sabbathGuard,
          showShortVsHaveBadges: true
        }
      }, { topic: "grocerylist.requested" });
    } catch(e){}

    // 11) Optional auto purchase
    if (autoPurchase) {
      try {
        emit("purchase.order.requested", {
          vendorPreference: vendorPref,
          storeId: builtList.storeId || storeSelector || null,
          lines: estimated.lines.map(function(l){ return { sku:l.sku, name:l.name, qty:l.qty, unit:l.unit, estPrice:l.unitPrice || 0 }; }),
          estimatedTotal: estimated.total,
          context: { reason: "supply-shortage", sessionId: payload.sessionId || env.sessionId || null, planId: payload.planId || null }
        }, { topic: "purchase.order.requested" });
      } catch(e){}
    }

    // 12) Final result
    var result = {
      shortages: normalized,
      substitutions: subsMap,
      list: { items: estimated.lines, estimatedTotal: estimated.total, storeId: builtList.storeId || storeSelector || null, aisleGroups: builtList.aisleGroups || {} },
      planAdjustments: planAdjustments,
      aux: aux,
      options: { attemptSubs: attemptSubs, autoList: autoList, autoPurchase: autoPurchase, sabbathGuard: sabbathGuard }
    };

    try { emit("supply.shortage.processed", result, { topic: "supply.shortage.processed" }); } catch(e){}

    if (DEV) try { console.debug("[supply] processed:", normalized.length, "items; list:", estimated.lines.length, "lines; est:", estimated.total); } catch(e){}
  }

  // --------------------------- Registration ------------------------------
  function registerOn(hub){
    var api = hub && hub.on ? hub : { on:on };
    if (api && api.on) on = api.on;
    if (api && api.emit) emit = api.emit;
    try { api.on("inventory.shortage.detected", handleSupplyShortageDetected); }
    catch(e){ try { on("inventory.shortage.detected", handleSupplyShortageDetected); } catch(e2){} }
  }

  // Auto-register when hub present
  try { registerOn(EventsHub); } catch(e){}

  // --------------------------- Exports -----------------------------------
  var api = {
    register: registerOn,
    _internals: {
      handleSupplyShortageDetected: handleSupplyShortageDetected,
      normalizeShortage: normalizeShortage,
      coalesceLines: coalesceLines,
      resolveFlourKey: resolveFlourKey,
      suggestSubsFallback: suggestSubsFallback
    }
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    try { window.onSupplyShortageDetected = api; } catch(e){}
  }
})();

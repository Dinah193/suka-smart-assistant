/* eslint-disable no-console */
// animalExecutor.js — build runbooks for animal care / butchery + lightweight runner + user-owned favorites/schedules
// Style: ES2015-safe, dependency-light, defensive DI, event-driven hooks.

(function () {
  /* ------------------------------- Factory & DI ------------------------------- */
  /**
   * @param {Object} deps
   *  - clock:        { now(): Date }
   *  - config:       { get(path:string, fallback:any):any, sabbathGuard?:{enabled:boolean,start?:string,end?:string}, withholdWindows?:Array }
   *  - inventory:    { has(itemId:string):boolean, reserve?(itemIds:string[]):void }
   *  - eventBus:     { emit(evt:string, payload:object):void }
   *  - analytics:    { track(evt:string, payload:object):void }
   *  - estimate:     { animalCareCost?(ctx:object):number, butcheryCost?(ctx:object):number }
   *  - automation:   { scheduleAt?(iso:string,payload:object):void, scheduleAfter?(ms:number,payload:object):void }
   *  - nba:          { upsert?(hint:object):void }
   *  - catalog:      { skuFor?(itemId:string):string }                       // SKU mapper for supplies
   *  - prep:         { emitCandidate?(win:{minutes:number,label:string,domain:string,area?:string}):void }
   *  - favorites:    { save?(fav:object):Promise<{ok:boolean}> }             // user-owned sessions
   *  - schedules:    { save?(sched:object):Promise<{ok:boolean}> }           // user-owned schedules
   */
  function createAnimalExecutor(deps) {
    var clock      = (deps && deps.clock)      || { now: function(){ return new Date(); } };
    var config     = (deps && deps.config)     || { get: function(_p, fb){ return fb; }, sabbathGuard: { enabled:false }, withholdWindows: [] };
    var inventory  = (deps && deps.inventory)  || { has: function(){ return false; }, reserve: function(){} };
    var eventBus   = (deps && deps.eventBus)   || { emit: function(){} };
    var analytics  = (deps && deps.analytics)  || { track: function(){} };
    var estimate   = (deps && deps.estimate)   || { animalCareCost: function(){ return 0; }, butcheryCost: function(){ return 0; } };
    var automation = (deps && deps.automation) || { scheduleAt: function(){}, scheduleAfter: function(){} };
    var nba        = (deps && deps.nba)        || { upsert: function(){} };
    var catalog    = (deps && deps.catalog)    || { skuFor: function(){ return ""; } };
    var prepBus    = (deps && deps.prep)       || { emitCandidate: function(){} };
    var favorites  = (deps && deps.favorites)  || { save: function(){ return Promise.resolve({ ok:false }); } };
    var schedules  = (deps && deps.schedules)  || { save: function(){ return Promise.resolve({ ok:false }); } };

    /* -------------------------------- Utilities ------------------------------- */
    function safeArr(x){ return Array.isArray(x) ? x : []; }
    function safeStr(x){ return x == null ? "" : String(x); }
    function clamp(n,a,b){ n = Number(n); return Math.max(a, Math.min(b, n)); }
    function nowISO(){ return clock.now().toISOString(); }
    function addHours(dateLike, hrs){ var d=new Date(dateLike||clock.now()); d.setHours(d.getHours()+Number(hrs||0)); return d; }
    function addDays(dateLike, days){ var d=new Date(dateLike||clock.now()); d.setDate(d.getDate()+Number(days||0)); return d; }
    function iso(d){ return (d instanceof Date ? d : new Date(d||clock.now())).toISOString(); }
    function toLower(x){ return safeStr(x).toLowerCase(); }
    function stepId(prefix){ return prefix + "-" + Math.random().toString(36).slice(2,8); }

    // LocalStorage fallbacks for user-owned persistence
    var LS = (function(){ try { return window && window.localStorage; } catch(_e){ return null; } })();
    function lsList(key){ try{ return JSON.parse((LS && LS.getItem(key)) || "[]"); }catch(_e){ return []; } }
    function lsSave(key, obj, idKey){
      var list = lsList(key);
      var id   = obj[idKey];
      var out  = []; var found = false;
      for (var i=0;i<list.length;i++){ if (list[i][idKey] === id){ out.push(obj); found = true; } else { out.push(list[i]); } }
      if(!found) out.push(obj);
      try { LS && LS.setItem(key, JSON.stringify(out)); } catch(_e){}
      return { ok: true };
    }

    // Parse "2 scoops", "1.5 kg", "250 g", "30 ml"
    function parseAmountTokens(s){
      var txt = safeStr(s).trim();
      if (!txt) return { qty: 1, unit: "unit" };
      var m = txt.match(/^(\d+(\.\d+)?)\s*([a-zA-Z]+)?/);
      if (m) return { qty: Number(m[1]), unit: (m[3] || "unit").toLowerCase() };
      return { qty: 1, unit: "unit" };
    }

    /* ------------------------------- Config Maps ------------------------------ */
    var PPE_DEFAULTS = config.get("animal.ppeDefaults", {
      care:      ["gloves","apron"],
      butchery:  ["cut gloves","apron","eye protection"]
    });

    var SUPPLY_BASE = config.get("animal.supplyBase", [
      "tools/bucket","tools/scoop","tools/brush","tools/labels","tools/marker"
    ]);

    var MED_KIT = config.get("animal.medKit", [
      "tools/syringe","tools/needle","tools/alcohol-wipe","tools/cooler","tools/ice-pack"
    ]);

    var SANITIZE_ITEMS = config.get("animal.sanitizeItems", [
      "chem/bleach","chem/quats","tools/sanitizer-spray"
    ]);

    /* ------------------------------- Guards ----------------------------------- */
    function isSabbathGuardActive(){
      var sg = config.sabbathGuard || (config.get && config.get("sabbath.guard", { enabled:false }));
      if(!sg || !sg.enabled) return false;
      try{
        var now = clock.now();
        var day = now.getDay(); // 0-6
        var start = sg.start || "Fri 18:00";
        var end   = sg.end   || "Sat 19:00";
        function parseBoundary(s){
          var parts = String(s||"").split(" ");
          var wday = parts[0]; var hm = parts[1] || "18:00";
          var map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
          var targetD = map[wday];
          var base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
          var delta = targetD - day;
          var target = new Date(base.getTime() + delta*24*60*60*1000);
          var hmParts = hm.split(":");
          target.setHours(Number(hmParts[0]||0));
          target.setMinutes(Number(hmParts[1]||0));
          return target;
        }
        var s = parseBoundary(start);
        var e = parseBoundary(end);
        if(e < s) e = new Date(e.getTime() + 7*24*60*60*1000);
        return (clock.now() >= s && clock.now() <= e);
      } catch(_e){ return false; }
    }

    function validateTask(task){
      var issues = [];
      if(!task || typeof task !== "object"){ issues.push("Task is missing or not an object."); return issues; }
      if(!task.title) issues.push("Missing task.title");
      if(task.kind && ["care","butchery"].indexOf(toLower(task.kind))<0) issues.push("task.kind must be 'care' or 'butchery'.");
      if(task.careType && ["feed","watering","vaccination","deworming","medication"].indexOf(toLower(task.careType))<0){
        issues.push("task.careType invalid.");
      }
      if(isSabbathGuardActive()) issues.push("Sabbath guard active — execution should be deferred.");

      // Optional withhold windows (quiet hours, etc.)
      var withholds = config.get("animal.withholdWindows", config.withholdWindows || []); // [{from:"22:00",to:"06:00",reason:"quiet-hours"}]
      try{
        var now = clock.now();
        var hh = now.getHours(); var mm = now.getMinutes();
        var cur = (hh*60 + mm);
        for(var i=0;i<withholds.length;i++){
          var w = withholds[i] || {};
          var pFrom = String(w.from||"00:00").split(":"); var from = (+pFrom[0])*60 + (+pFrom[1]||0);
          var pTo   = String(w.to  ||"00:00").split(":"); var to   = (+pTo[0])*60   + (+pTo[1]||0);
          var spansMidnight = to < from;
          var within = spansMidnight ? (cur>=from || cur<=to) : (cur>=from && cur<=to);
          if(within){ issues.push("Withhold window active — " + (w.reason || "defer")); break; }
        }
      } catch(_e){ /* ignore */ }

      return issues;
    }

    /* ------------------------------- Hazards/PPE ------------------------------- */
    function deriveHazards(task){
      var hazards = [];
      var flags = safeArr(task.flags).map(function(x){ return toLower(x); });
      var kind = toLower(task.kind);
      if (flags.indexOf("raw-meat")>=0 || kind==="butchery") hazards.push("raw-meat");
      if (flags.indexOf("biohazard")>=0) hazards.push("biohazard");
      if (flags.indexOf("sharp-tools")>=0 || kind==="butchery") hazards.push("sharp-tools");
      if (flags.indexOf("scalding")>=0) hazards.push("scalding-water");
      if (flags.indexOf("needle")>=0 || ["vaccination","medication","deworming"].indexOf(toLower(task.careType))>=0) hazards.push("needlestick");
      if (task.sanitize===true) hazards.push("sanitizer-chemicals");
      return hazards;
    }

    function derivePPE(task){
      var p = safeArr(task.ppe);
      if (!p.length) {
        var kind = toLower(task.kind)==="butchery" ? "butchery" : "care";
        p = PPE_DEFAULTS[kind] ? PPE_DEFAULTS[kind].slice(0) : ["gloves","apron"];
      }
      if (["vaccination","deworming","medication"].indexOf(toLower(task.careType))>=0){
        if (p.indexOf("eye protection")<0) p.push("eye protection");
      }
      return p;
    }

    /* ------------------------------ Supply Builder ---------------------------- */
    function buildSupplyList(items){
      var out = [];
      for(var i=0;i<items.length;i++){
        var id = items[i];
        var available = false;
        try{ available = !!inventory.has(id); } catch(_e){ available = false; }
        var sku = "";
        try{ sku = catalog.skuFor(id) || ""; } catch(_e){ sku = ""; }
        out.push({ id:id, available:available, sku:sku });
      }
      return out;
    }

    /* ------------------------------ Reminder Helper --------------------------- */
    function scheduleTimerReminder(runbookId, step, minutes){
      try{
        var ms = Math.max(0, Math.round(minutes*60000));
        var whenISO = new Date(clock.now().getTime() + ms).toISOString();
        automation.scheduleAt(whenISO, {
          kind: "reminder",
          runbookId: runbookId,
          stepId: step.id,
          label: step.label,
          domain: "animals"
        });
        eventBus.emit("reminder:scheduled", { runbookId:runbookId, stepId:step.id, at:whenISO, label:step.label, domain:"animals" });
      }catch(_e){}
    }

    /* ------------------------------- Care Blocks ------------------------------ */
    function careFeedWaterSteps(task){
      var steps = [];
      var logs = [];
      var invDelta = [];

      var ppe = derivePPE(task);
      steps.push({ id:stepId("ppe"), label:"PPE on (" + ppe.join(", ") + ")", type:"MANUAL", wait:false });

      var feed = task.feed || {};
      var feedItems = safeArr(feed.items);

      for (var i=0;i<feedItems.length;i++){
        var it = feedItems[i] || {};
        var nm = safeStr(it.name || "feed");
        var amt = safeStr(it.amount || "");
        steps.push({ id:stepId("feed"), label:"Feed: " + nm + (amt ? " — " + amt : ""), type:"MANUAL", wait:false });

        // Inventory decrement
        var tok = parseAmountTokens(amt);
        var delta = -Math.max(1, Math.round(tok.qty||1));
        invDelta.push({ name: toLower(nm), delta: delta, meta: { unit: tok.unit } });
      }

      if (feed && feed.waterCheck) steps.push({ id:stepId("water"), label:"Check & refill water", type:"MANUAL", wait:false });
      steps.push({ id:stepId("inspect"), label:"Quick health check / bedding spot clean", type:"MANUAL", wait:false });

      // Optional sanitation
      if (task.sanitize===true){
        var dwell = clamp(Number(task.sanitizeDwellMinutes||2),1,30);
        steps.push({ id:stepId("san-pre"), type:"MANUAL", label:"Sanitize buckets / scoops / handles", wait:false });
        var dwellStep = { id:stepId("san-dwell"), type:"TIMER", label:"Disinfectant contact time", timer:{ minutes:dwell, label:"Sanitize" }, wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true };
        steps.push(dwellStep);
      }

      var log = { type:"ANIMAL_CARE_LOG", title: task.title || "Animal Care", ts: nowISO() };
      logs.push(log);
      if (invDelta.length) logs.push({ type:"INVENTORY_DELTA", items: invDelta });

      return { steps: steps, logging: logs };
    }

    function careMedsSteps(task){
      // task.med: { name, concentrationMgPerMl?, doseMgPerKg?, fixedMl?, route, boosterDays?, withdrawalDays? }
      // task.patient: { weightKg?, tagId?, group? }
      var steps = [];
      var logs = [];
      var careType = toLower(task.careType || "medication");
      var med = task.med || {};
      var patient = task.patient || {};
      var ppe = derivePPE(task);

      steps.push({ id:stepId("ppe"), label:"PPE on (" + ppe.join(", ") + ")", type:"MANUAL", wait:false });

      // Cold chain guard for vaccines/biologics
      var isVaccine = (careType === "vaccination");
      if (task.coldChain || isVaccine){
        var maxOut = clamp(Number(task.coldChain && task.coldChain.maxMinutesOut || 20), 5, 120);
        var ccStep = { id:stepId("cold"), type:"TIMER", timer:{ minutes:maxOut, label:"Cold chain window" }, label:"Cold chain window", wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true };
        steps.push(ccStep);
      }

      // Dosing math
      var label = safeStr(med.name || (careType==="deworming" ? "Dewormer" : "Medication"));
      var volMl = null;
      var noteDose = "";

      var fixedMl = Number(med.fixedMl);
      var mgPerKg = Number(med.doseMgPerKg);
      var conc = Number(med.concentrationMgPerMl); // mg per mL
      var weightKg = Number(patient.weightKg);

      if (isFinite(fixedMl) && fixedMl > 0) {
        volMl = fixedMl;
        noteDose = "Dose: " + fixedMl + " mL" + (med.route ? (" " + med.route.toUpperCase()) : "");
      } else if (isFinite(mgPerKg) && isFinite(conc) && conc > 0 && isFinite(weightKg) && weightKg > 0) {
        var mgTotal = mgPerKg * weightKg;
        volMl = +(mgTotal / conc).toFixed(2);
        noteDose = "Dose: " + mgPerKg + " mg/kg × " + weightKg + " kg → " + volMl + " mL " + (med.route ? med.route.toUpperCase() : "");
      } else {
        volMl = Number(task.defaultMl || 1);
        noteDose = "Dose: " + volMl + " mL (verify)";
      }

      steps.push({
        id: stepId("admin"),
        type: "MANUAL",
        label: (careType==="deworming" ? "Administer dewormer" : isVaccine ? "Administer vaccine" : "Administer medication") +
               " — " + label + " (" + noteDose + ")",
        wait: false
      });

      if (med.route){ steps.push({ id:stepId("route"), type:"NOTE", note:{ text: "Route: " + med.route.toUpperCase() }, label:"Route note", wait:false }); }

      // Booster reminder
      if (isFinite(Number(med.boosterDays)) && Number(med.boosterDays) > 0){
        var boosterWhen = iso(addDays(clock.now(), Number(med.boosterDays)));
        steps.push({ id:stepId("booster"), type:"REMINDER", reminder:{ whenISO:boosterWhen, label:"Booster due: " + label }, label:"Booster reminder", wait:false });
      }

      // Withdrawal period note (food animals)
      if (isFinite(Number(med.withdrawalDays)) && Number(med.withdrawalDays) > 0){
        steps.push({ id:stepId("withdrawal"), type:"NOTE", note:{ text:"Observe withdrawal: " + Number(med.withdrawalDays) + " days" }, label:"Withdrawal note", wait:false });
      }

      // Quarantine/Observation
      if (task.quarantine === true){
        steps.push({ id:stepId("obs-note"), type:"NOTE", note:{ text:"Observe for adverse reactions (24–48h)" }, label:"Observation note", wait:false });
        var obsWhen = iso(addHours(clock.now(), 24));
        steps.push({ id:stepId("obs-rem"), type:"REMINDER", reminder:{ whenISO: obsWhen, label:"Check patient status" }, label:"Observation reminder", wait:false });
      }

      // End sanitation if requested
      if (task.sanitize === true){
        var dwell = clamp(Number(task.sanitizeDwellMinutes||2),1,30);
        steps.push({ id:stepId("san-pre"), type:"MANUAL", label:"Sanitize syringes / drips / surfaces", wait:false });
        var sdStep = { id:stepId("san-dwell"), type:"TIMER", label:"Disinfectant contact time", timer:{ minutes:dwell, label:"Sanitize" }, wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true };
        steps.push(sdStep);
      }

      // Logging
      var careLog = {
        type: isVaccine ? "VACCINATION_LOG" : (careType==="deworming" ? "DEWORMING_LOG" : "MEDICATION_LOG"),
        title: task.title || (isVaccine ? "Vaccination" : (careType==="deworming" ? "Deworming" : "Medication")),
        ts: nowISO(),
        patient: {
          tagId: (task.patient && task.patient.tagId) || null,
          group: (task.patient && task.patient.group) || null,
          weightKg: isFinite(weightKg) && weightKg>0 ? weightKg : null
        },
        med: {
          name: label,
          route: med.route || null,
          doseMl: volMl,
          doseMgPerKg: isFinite(mgPerKg) ? mgPerKg : null
        }
      };
      logs.push(careLog);

      // Inventory decrement for med (mL)
      if (isFinite(volMl) && volMl > 0 && label){
        logs.push({ type:"INVENTORY_DELTA", items:[{ name: toLower(label), delta: -volMl, meta:{ unit:"ml" } }] });
      }

      return { steps: steps, logging: logs };
    }

    function careSteps(task){
      var careType = toLower(task.careType || "");
      if (careType === "vaccination" || careType === "deworming" || careType === "medication") {
        return careMedsSteps(task);
      }
      return careFeedWaterSteps(task);
    }

    /* -------------------------------- Butchery -------------------------------- */
    function butcherySteps(task){
      var steps = [];
      var logs = [];
      var ppe = derivePPE(task);

      steps.push({ id:stepId("ppe"), label:"PPE on (" + ppe.join(", ") + ")", type:"MANUAL", wait:false });

      // Station sanitize + dwell if requested
      if (task.sanitize===true){
        var dwell = clamp(Number(task.sanitizeDwellMinutes||2),1,30);
        steps.push({ id:stepId("san-pre"), type:"MANUAL", label:"Sanitize station & boards", wait:false });
        var dwellStep = { id:stepId("san-dwell"), type:"TIMER", label:"Disinfectant contact time", timer:{ minutes:dwell, label:"Sanitize" }, wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true };
        steps.push(dwellStep);
      }

      // Chill-chain
      var maxOut = clamp(Number(task.chillChain && task.chillChain.maxMinutesOut || 20), 5, 120);
      var ccStep = { id:stepId("chill"), label:"Chill-chain window", type:"TIMER", timer:{ minutes:maxOut, label:"Chill-chain" }, wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true };
      steps.push(ccStep);

      steps.push({ id:stepId("breakdown"), label:"Breakdown / trim", type:"MANUAL", wait:false });
      steps.push({ id:stepId("probe"), type:"NOTE", note:{ text:"Keep ≤40°F / 4°C" }, label:"Temp control note", wait:false });
      steps.push({ id:stepId("package"), label:"Package, label, date", type:"MANUAL", wait:false });
      steps.push({ id:stepId("blast"), label:"Return to fridge/freezer promptly", type:"MANUAL", wait:false });

      if (task.sanitize===true){
        steps.push({ id:stepId("san-final"), label:"Final sanitize (boards, tools, sinks)", type:"MANUAL", wait:false });
      }

      logs.push({ type:"BUTCHERY_LOG", label: task.title || "Butchery", chillChainMax: maxOut, ts: nowISO() });
      var pkg = safeArr(task.packagedItems);
      if (pkg.length) {
        logs.push({ type:"INVENTORY_DELTA", items: pkg.map(function(p){
          return { name: toLower(p && p.name), delta: +Math.abs(Number(p && p.delta || 0)) };
        }) });
      }

      return { steps: steps, logging: logs };
    }

    /* -------------------------------- Lead Prep -------------------------------- */
    function leadPrepSteps(task){
      var out = [];
      var careType = toLower(task.careType || "");
      // Butchery fasting reminder
      if (toLower(task.kind)==="butchery" && Number(task.fastingHours)>0){
        var when = iso(addHours(clock.now(), -Math.abs(Number(task.fastingHours))));
        out.push({ id:stepId("lead-fast"), type:"REMINDER", reminder:{ whenISO: when, label:"Begin fasting ("+ Number(task.fastingHours) +"h prior)" }, label:"Begin fasting", wait:false });
      }
      // Vaccine cooler staging
      if (careType==="vaccination" && task.stageCooler === true){
        out.push({ id:stepId("lead-ice"), type:"REMINDER", reminder:{ whenISO: nowISO(), label:"Stage ice pack/cooler for vaccines" }, label:"Stage ice pack/cooler", wait:false });
      }
      return out;
    }

    /* ---------------------------- Supplies Builder ---------------------------- */
    function suppliesForTask(task){
      var items = SUPPLY_BASE.slice(0);
      var kind = toLower(task.kind)==="butchery" ? "butchery" : "care";
      var ppe = derivePPE(task);
      for(var i=0;i<ppe.length;i++) items.push("ppe/" + ppe[i]);

      if (["vaccination","deworming","medication"].indexOf(toLower(task.careType))>=0){
        items = items.concat(MED_KIT);
      }
      if (task.sanitize===true){
        items = items.concat(SANITIZE_ITEMS);
      }

      // Feed items as supplies (so they appear on list with availability + SKU)
      var feed = task.feed || {};
      var feedItems = safeArr(feed.items);
      for (var f=0; f<feedItems.length; f++){
        var nm = safeStr(feedItems[f] && feedItems[f].name || "").trim();
        if(nm) items.push("feed/" + toLower(nm));
      }

      // Dedup
      var seen = {}; var dedup = [];
      for (var k=0;k<items.length;k++){ var id = items[k]; if(!seen[id]){ seen[id]=true; dedup.push(id); } }

      return buildSupplyList(dedup);
    }

    /* --------------------------------- toRunbook ------------------------------- */
    /**
     * toRunbook(task, opts?)
     * task: {... see previous version ...}
     * opts: { sessionId?: string, resumeState?: {...}, background?: boolean }
     */
    function toRunbook(task, opts){
      opts = opts || {};
      var issues = validateTask(task);
      var id = task && task.id ? task.id : ("animal:" + Math.random().toString(36).slice(2));
      var kind = toLower(task && task.kind) || "care";
      var area = safeStr(task && task.area || task && task.title || "Area");

      var hazards = deriveHazards(task);
      var ppeList = derivePPE(task);
      var supplies = suppliesForTask(task);

      var lead = leadPrepSteps(task);
      var block = (kind === "butchery") ? butcherySteps(task) : careSteps(task);

      // Pre-checks/guards
      var steps = [];
      if(issues.length){
        steps.push({ id:stepId("guard"), label:"Pre-checks & guards", type:"ALERTS", wait:true, issues:issues.slice(0) });
      }

      // Merge
      steps = steps.concat(lead).concat(block.steps);

      // Cleanup
      var cleanup = [
        { id:stepId("ppeoff"), label:"Remove PPE & wash hands", type:"CHECK", wait:false }
      ];

      // Logging
      var logging = block.logging || [];
      logging.push({
        type: "ANIMAL_SESSION_LOG",
        title: task.title || (kind==="care" ? "Animal Care" : "Butchery"),
        area: area,
        notes: safeStr(task && task.notes, ""),
        ts: nowISO()
      });

      // Estimates
      var estimatedMinutes = Number(task && task.estMinutes || 0);
      if(!estimatedMinutes){
        if(kind==="butchery"){
          var base = 45;
          if(task.sanitize===true) base += (task.sanitizeDwellMinutes||2);
          if(task.chillChain) base += 5;
          estimatedMinutes = base;
        } else {
          var baseCare = 10;
          if (task.feed && task.feed.items && task.feed.items.length) baseCare += task.feed.items.length * 2;
          if (["vaccination","deworming","medication"].indexOf(toLower(task.careType))>=0) baseCare += 8;
          if (task.sanitize===true) baseCare += (task.sanitizeDwellMinutes||2);
          estimatedMinutes = baseCare;
        }
      }

      var estimatedCost = 0;
      try{
        if(kind==="butchery"){
          estimatedCost = Number(estimate.butcheryCost({
            supplies:supplies, hazards:hazards, estimatedMinutes:estimatedMinutes, area:area
          })) || 0;
        } else {
          estimatedCost = Number(estimate.animalCareCost({
            supplies:supplies, hazards:hazards, estimatedMinutes:estimatedMinutes, area:area, careType:task.careType||""
          })) || 0;
        }
      } catch(_e){ estimatedCost = 0; }

      var runbook = {
        id: id,
        sessionId: opts.sessionId || null,
        title: (kind === "care" ? "Animal Care • " : "Butchery • ") + (task && task.title ? task.title : "Task"),
        domain: "animals", // prefer plural; see dual-emits below for compatibility
        priority: (task && task.priority) || "normal",
        estimatedMinutes: estimatedMinutes,
        estimatedCost: estimatedCost,
        hazards: hazards,
        ppe: ppeList,
        supplies: supplies,
        steps: steps,
        cleanup: cleanup,
        logging: logging,
        guards: { sabbathActive: isSabbathGuardActive() },
        meta: {
          area: area,
          background: !!opts.background,
          source: "animalExecutor",
          resumeState: opts.resumeState || null
        }
      };

      /* --------------------------- Orchestration Hooks ------------------------- */
      try{
        // Guard emit
        if(runbook.guards.sabbathActive){
          eventBus.emit("guard:sabbath", { runbookId:id, title:runbook.title, when:nowISO(), domain:"animals" });
        }

        // Prep consolidation + reminders for TIMER steps
        for(var s=0; s<runbook.steps.length; s++){
          var st = runbook.steps[s];
          if(st && st.type==="TIMER"){
            var minutes = (st.timer && st.timer.minutes) || 0;
            if(st.emitAsPrepCandidate){
              var win = { minutes: minutes, label: st.label, domain:"animals", area: area, runbookId:id };
              eventBus.emit("prep:candidate", win);
              prepBus.emitCandidate({ minutes: minutes, label: st.label, domain:"animals", area: area });
            }
            if(st.backgroundOK && minutes>0){
              scheduleTimerReminder(id, st, minutes);
              nba.upsert({ kind:"window", domain:"animals", runbookId:id, stepId:st.id, label:"Use wait window wisely", priority:"info" });
            }
          }
          if(st && st.type==="REMINDER" && st.reminder && st.reminder.whenISO){
            automation.scheduleAt(st.reminder.whenISO, { kind:"reminder", domain:"animals", runbookId:id, stepId:st.id, label:st.reminder.label });
            eventBus.emit("reminder:scheduled", { domain:"animals", runbookId:id, stepId:st.id, at:st.reminder.whenISO, label:st.reminder.label });
          }
        }

        // Creation + analytics
        eventBus.emit("runbook:created", { runbook: runbook });
        analytics.track("runbook/built", {
          domain:"animals",
          kind: kind,
          careType: task.careType || "",
          hazards: hazards,
          estMin: estimatedMinutes,
          estCost: estimatedCost,
          priority: runbook.priority
        });
      } catch(_e){ /* no-op */ }

      return runbook;
    }

    // ----------------------------- Runner: emits step:start/complete ----------
    /**
     * makeRunner(input, opts?)
     *  - input: runbook OR task
     *  - opts: { sessionId?, resumeIndex? }
     * Returns controls: { start(), startStep(idOrIndex), completeStep(idOrIndex), pause(reason?), resume(), abort() }
     */
    function makeRunner(input, opts){
      var runbook = (input && input.steps) ? input : toRunbook(input, opts || {});
      var idx = Math.max(0, Number((opts && opts.resumeIndex) || 0));
      var sessionId = runbook.sessionId || ("animals-" + Math.random().toString(36).slice(2,8));

      function coerceIndex(idOrIndex){
        if (typeof idOrIndex === "number") return Math.max(0, Math.min(runbook.steps.length-1, idOrIndex));
        var i; for (i=0;i<runbook.steps.length;i++){ if (runbook.steps[i].id === idOrIndex) return i; }
        return idx;
      }

      function blockedByGuards(){
        if (runbook.guards && runbook.guards.sabbathActive) return { blocked:true, reason:"sabbath" };
        var issues = validateTask({ title: runbook.title, kind:"care" }); // minimal check for withholds
        for (var j=0;j<issues.length;j++){
          if (String(issues[j]).toLowerCase().indexOf("withhold window")>=0){
            return { blocked:true, reason:"quiet-hours" };
          }
        }
        return { blocked:false };
      }

      function emitStepStart(i){
        var st = runbook.steps[i];
        // Primary (plural) & compatibility (singular)
        eventBus.emit("animal:step:start",  { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        eventBus.emit("animals:step:start", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "animals", index: i });
        analytics.track("animals/step/start", { step: st.label, index: i, runbookId: runbook.id });
      }

      function emitStepComplete(i){
        var st = runbook.steps[i];
        eventBus.emit("animal:step:complete",  { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        eventBus.emit("animals:step:complete", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        analytics.track("animals/step/complete", { step: st.label, index: i, runbookId: runbook.id });
      }

      function start(){
        var g = blockedByGuards();
        if (g.blocked){
          eventBus.emit("session:paused", { sessionId: sessionId, domain: "animals", reason: g.reason || "guard" });
          return { ok:false, blocked:true, reason: g.reason || "guard" };
        }
        eventBus.emit("session:created", { sessionId: sessionId, domain: "animals", title: runbook.title, steps: runbook.steps, startedAt: clock.now().toISOString() });
        analytics.track("animals/session/start", { runbookId: runbook.id, steps: runbook.steps.length });
        emitStepStart(idx);
        return { ok:true, sessionId: sessionId, index: idx, runbook: runbook };
      }

      function startStep(idOrIndex){
        idx = coerceIndex(idOrIndex);
        emitStepStart(idx);
        return { ok:true, index: idx };
      }

      function completeStep(idOrIndex){
        var i = coerceIndex(idOrIndex);
        emitStepComplete(i);
        idx = Math.min(i + 1, runbook.steps.length - 1);
        if (i < runbook.steps.length - 1){
          emitStepStart(idx);
        } else {
          eventBus.emit("session:ended", { sessionId: sessionId, domain: "animals", finishedAt: clock.now().toISOString() });
          analytics.track("animals/session/end", { runbookId: runbook.id });
        }
        return { ok:true, index: idx };
      }

      function pause(reason){
        eventBus.emit("session:paused", { sessionId: sessionId, domain: "animals", reason: reason || "user" });
        return { ok:true };
      }
      function resume(){
        eventBus.emit("session:resumed", { sessionId: sessionId, domain: "animals" });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "animals", index: idx });
        return { ok:true, index: idx };
      }
      function abort(){
        eventBus.emit("session:ended", { sessionId: sessionId, domain: "animals", aborted: true, finishedAt: clock.now().toISOString() });
        return { ok:true };
      }

      return { start: start, startStep: startStep, completeStep: completeStep, pause: pause, resume: resume, abort: abort, runbook: runbook, sessionId: sessionId };
    }

    // ----------------------------- User-owned Favorites & Schedules -----------
    /**
     * saveFavoriteSession({ sessionId?, title, templateId, steps })
     * saveScheduleTemplate({ title, templateId, steps, rrule, firstRunAtISO })
     * Uses DI hooks when available; falls back to localStorage.
     */
    function saveFavoriteSession(payload){
      var fav = {
        id: "fav-" + (payload.sessionId || Math.random().toString(36).slice(2,10)),
        domain: "animals",
        title: safeStr(payload.title || "Animal Session"),
        templateId: payload.templateId || "",
        steps: payload.steps || [],
        createdAt: nowISO(),
        updatedAt: Date.now(),
        meta: { source: "user" }
      };
      var viaHook = favorites && typeof favorites.save === "function";
      if (viaHook) {
        return favorites.save(fav).then(function(res){
          if (res && res.ok){ eventBus.emit("favorites:changed", { domain: "animals" }); }
          return res || { ok:false };
        });
      }
      var res = lsSave("animals:favorites", fav, "id");
      if (res.ok) eventBus.emit("favorites:changed", { domain: "animals" });
      return Promise.resolve(res);
    }

    function saveScheduleTemplate(payload){
      var sched = {
        id: "sched-" + Math.random().toString(36).slice(2,10),
        domain: "animals",
        title: safeStr(payload.title || "Animal Schedule"),
        sessionTemplate: { templateId: payload.templateId || "", steps: payload.steps || [] },
        rrule: payload.rrule || "FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0", // default: morning rounds
        firstRunAt: safeStr(payload.firstRunAtISO || nowISO())
      };
      var viaHook = schedules && typeof schedules.save === "function";
      var onOk = function(ok){
        if (ok) {
          eventBus.emit("schedules:changed", { domain: "animals" });
          try {
            automation.scheduleAt(sched.firstRunAt, { kind:"session", domain:"animals", title:sched.title, rrule:sched.rrule, sessionTemplate: sched.sessionTemplate });
          } catch(_e){}
        }
      };
      if (viaHook) {
        return schedules.save(sched).then(function(res){ onOk(res && res.ok); return res || { ok:false }; });
      }
      var res = lsSave("animals:schedules", sched, "id");
      onOk(res.ok);
      return Promise.resolve(res);
    }

    /* ----------------------------- Public API --------------------------------- */
    function validateAndExplain(task){
      var issues = validateTask(task);
      return { ok: issues.length===0, issues: issues };
    }

    return {
      toRunbook: toRunbook,
      validateTask: validateAndExplain,
      makeRunner: makeRunner,
      saveFavoriteSession: saveFavoriteSession,
      saveScheduleTemplate: saveScheduleTemplate
    };
  }

  // Backwards-compatible default export (safe fallbacks)
  var defaultExecutor = createAnimalExecutor({});

  module.exports = {
    createAnimalExecutor: createAnimalExecutor,
    toRunbook: defaultExecutor.toRunbook,
    validateTask: defaultExecutor.validateTask,
    makeRunner: defaultExecutor.makeRunner,
    saveFavoriteSession: defaultExecutor.saveFavoriteSession,
    saveScheduleTemplate: defaultExecutor.saveScheduleTemplate
  };
})();

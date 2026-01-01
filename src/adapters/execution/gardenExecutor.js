/* eslint-disable no-console */
// gardenExecutor.js — build robust runbooks for garden tasks + lightweight runner + user-owned favorites/schedules
// Style: ES2015-safe, dependency-light, defensive DI, event-driven hooks.

(function () {
  /**
   * Factory with optional dependency injection. All deps are optional and safely noop.
   *
   * @param {Object} deps
   *  - clock:     { now(): Date }
   *  - config:    { get(path, fb):any, sabbathGuard?:{enabled:boolean,start?:string,end?:string}, withholdWindows?:Array }
   *  - eventBus:  { emit(evt, payload):void }
   *  - analytics: { track(evt, payload):void }
   *  - weather:   { recentRainMM?(days:number):number, forecastUVIndex?():number, isHeatAdvisory?():boolean }
   *  - gardenDb:  { getCropMeta?(name:string):{ category, defaultRinseM?, defaultDryM?, hasThorns?, latexSap?, allergenTags?, defaultStorage?, phiDays?, yieldPerPlant?, yieldUnit? } }
   *  - foodSafety:{ washAdvice?(category:string):{ rinseM:number, dryM:number } }
   *  - inventory: { add?(items:Array<{id:string,qty:number,unit?:string,meta?:Object}>):void, has?(key:string):boolean }
   *  - labeler:   { makeLabel?(payload:{name,qty,unit,date,location}):string }
   *  - scheduleHelpers: { irrigationRuntime?(task):{minutes:number}|null, harvestWindow?(crop:string):{best:string}|null }
   *  - pests:     { recommend?(issue:string, crop?:string):{ product:string, phiDays?:number, notes?:string }|null }
   *  - catalog:   { skuFor?(itemId:string):string }
   *  - estimate:  { gardenCost?(ctx:object):number }
   *  - automation:{ scheduleAt?(iso:string,payload:object):void, scheduleAfter?(ms:number,payload:object):void }
   *  - nba:       { upsert?(hint:object):void }
   *  - prep:      { emitCandidate?(win:{minutes:number,label:string,domain:string,area?:string}):void }
   *  - favorites: { save?(fav:object):Promise<{ok:boolean}> }     // user-owned sessions
   *  - schedules: { save?(sched:object):Promise<{ok:boolean}> }   // user-owned schedules
   */
  function createGardenExecutor(deps) {
    var clock      = (deps && deps.clock)      || { now: function(){ return new Date(); } };
    var config     = (deps && deps.config)     || { get: function(_p, fb){ return fb; }, sabbathGuard:{ enabled:false }, withholdWindows: [] };
    var eventBus   = (deps && deps.eventBus)   || { emit: function(){} };
    var analytics  = (deps && deps.analytics)  || { track: function(){} };
    var weather    = (deps && deps.weather)    || { recentRainMM:function(){return 0;}, forecastUVIndex:function(){return 5;}, isHeatAdvisory:function(){return false;} };
    var gardenDb   = (deps && deps.gardenDb)   || { getCropMeta:function(){ return null; } };
    var foodSafety = (deps && deps.foodSafety) || { washAdvice:function(){ return null; } };
    var inventory  = (deps && deps.inventory)  || { add:function(){}, has:function(){ return false; } };
    var labeler    = (deps && deps.labeler)    || { makeLabel:function(){ return ""; } };
    var scheduleHelpers = (deps && deps.scheduleHelpers) || { irrigationRuntime:function(){return null;}, harvestWindow:function(){return null;} };
    var pests      = (deps && deps.pests)      || { recommend:function(){ return null; } };
    var catalog    = (deps && deps.catalog)    || { skuFor:function(){ return ""; } };
    var estimate   = (deps && deps.estimate)   || { gardenCost:function(){ return 0; } };
    var automation = (deps && deps.automation) || { scheduleAt:function(){}, scheduleAfter:function(){} };
    var nba        = (deps && deps.nba)        || { upsert:function(){} };
    var prepBus    = (deps && deps.prep)       || { emitCandidate:function(){} };
    var favorites  = (deps && deps.favorites)  || { save:function(){ return Promise.resolve({ ok:false }); } };
    var schedules  = (deps && deps.schedules)  || { save:function(){ return Promise.resolve({ ok:false }); } };

    // ----------------------------- Local persistence fallbacks -----------------
    var LS = (function(){ try { return window && window.localStorage; } catch(_e){ return null; } })();
    function lsList(key){ try{ return JSON.parse((LS && LS.getItem(key)) || "[]"); }catch(_e){ return []; } }
    function lsSave(key, obj, idKey){
      var list = lsList(key);
      var id   = obj[idKey];
      var out  = []; var found = false;
      for (var i=0;i<list.length;i++){
        if (list[i][idKey] === id){ out.push(obj); found = true; } else { out.push(list[i]); }
      }
      if(!found) out.push(obj);
      try { LS && LS.setItem(key, JSON.stringify(out)); } catch(_e){}
      return { ok: true };
    }

    // ----------------------------- Helpers -------------------------------------
    function stepId(prefix){ return prefix + "-" + Math.random().toString(36).slice(2,8); }
    function safeString(x, fb){ return (x===null||x===undefined)?(fb||""):String(x); }
    function toLower(x){ return String(x||"").toLowerCase().trim(); }
    function uniqLower(arr){ var out=[],seen={}; for(var i=0;i<(arr||[]).length;i++){ var v=toLower(arr[i]); if(!v) continue; if(!seen[v]){ seen[v]=true; out.push(v);} } return out; }
    function tryHas(key){ try { return !!inventory.has(key); } catch(_e){ return false; } }
    function safeSku(id){ try{ return catalog.skuFor(id) || ""; } catch(_e){ return ""; } }

    function isSabbathGuardActive(){
      var sg = config.sabbathGuard || (config.get && config.get("sabbath.guard", { enabled:false }));
      if(!sg || !sg.enabled) return false;
      try{
        var now = clock.now(); var day = now.getDay();
        var start = sg.start || "Fri 18:00"; var end = sg.end || "Sat 19:00";
        function parseBoundary(s){
          var parts = String(s||"").split(" ");
          var wday = parts[0]; var hm = parts[1] || "18:00";
          var map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
          var targetD = map[wday];
          var base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
          var delta = targetD - day;
          var target = new Date(base.getTime() + delta*24*60*60*1000);
          var hmParts = hm.split(":"); target.setHours(Number(hmParts[0]||0)); target.setMinutes(Number(hmParts[1]||0));
          return target;
        }
        var s = parseBoundary(start); var e = parseBoundary(end);
        if(e < s) e = new Date(e.getTime() + 7*24*60*60*1000);
        return (now >= s && now <= e);
      } catch(_e){ return false; }
    }

    function withholdIssues(domainKey){
      var issues = [];
      var withholds = config.get(domainKey+".withholdWindows", config.withholdWindows || []); // [{from:"22:00",to:"06:00",reason:"quiet-hours"}]
      try{
        var now = clock.now(); var hh = now.getHours(); var mm = now.getMinutes(); var cur = hh*60 + mm;
        for(var w=0; w<withholds.length; w++){
          var ww = withholds[w] || {};
          var pf = String(ww.from||"00:00").split(":"); var from = (+pf[0])*60 + (+pf[1]||0);
          var pt = String(ww.to  ||"00:00").split(":"); var to   = (+pt[0])*60 + (+pt[1]||0);
          var spans = to < from;
          var within = spans ? (cur>=from || cur<=to) : (cur>=from && cur<=to);
          if(within){ issues.push("Withhold window active — " + (ww.reason || "defer")); break; }
        }
      } catch(_e){}
      return issues;
    }

    function scheduleTimerReminder(runbookId, step, minutes){
      try{
        var ms = Math.max(0, Math.round(minutes*60000));
        var whenISO = new Date(clock.now().getTime() + ms).toISOString();
        automation.scheduleAt(whenISO, { kind:"reminder", runbookId:runbookId, stepId:step.id, label:step.label, domain:"garden" });
        eventBus.emit("reminder:scheduled", { runbookId:runbookId, stepId:step.id, at:whenISO, label:step.label, domain:"garden" });
      } catch(_e){}
    }

    // ----------------------------- Hazards -------------------------------------
    function detectHazards(task, cropMeta){
      var hazards = [];
      if(task && task.hazards && task.hazards.length){
        for(var i=0;i<task.hazards.length;i++) hazards.push("user/"+toLower(task.hazards[i]));
      }
      if(cropMeta && cropMeta.hasThorns) hazards.push("plant/thorns");
      if(cropMeta && cropMeta.latexSap)  hazards.push("plant/latex-sap");
      if(cropMeta && cropMeta.allergenTags){
        for(var j=0;j<cropMeta.allergenTags.length;j++) hazards.push("allergen/"+toLower(cropMeta.allergenTags[j]));
      }
      if(task && task.pesticide && task.pesticide.name) hazards.push("chem/pesticide");
      if(weather.isHeatAdvisory && weather.isHeatAdvisory()===true) hazards.push("env/heat-advisory");
      var uvi = 0; try{ uvi = Number(weather.forecastUVIndex()||0); }catch(_e){ uvi = 0; }
      if(uvi >= 8) hazards.push("env/high-uv");
      return hazards;
    }

    // ----------------------------- Validation ----------------------------------
    function validateTask(task){
      var issues = [];
      if(!task || typeof task !== "object"){ issues.push("Task missing or not an object."); return issues; }
      if(!task.title) issues.push("Missing task.title");
      var kind = toLower(task.kind || "harvest");
      var allowed = {"harvest":1,"maintenance":1,"irrigation":1,"fertilize":1,"prune":1,"trellis":1,"pest":1,"soil":1,"seeding":1,"transplant":1,"weeding":1,"mulch":1,"compost":1};
      if(!allowed[kind]) issues.push("Unknown kind: " + kind);
      if(isSabbathGuardActive()) issues.push("Sabbath guard active — execution should be deferred.");
      issues = issues.concat(withholdIssues("garden"));

      // PHI guard
      if(kind==="harvest" && task.pesticide && task.pesticide.appliedAt && (task.pesticide.phiDays || (task.harvest && task.harvest.phiDays))){
        try{
          var applied = new Date(task.pesticide.appliedAt).getTime();
          var phi = Number(task.pesticide.phiDays || task.harvest.phiDays || 0);
          var unlock = applied + phi*24*60*60*1000;
          if(clock.now().getTime() < unlock) issues.push("Pre-harvest interval not met ("+phi+"d).");
        }catch(_e){}
      }
      return issues;
    }

    // ----------------------------- Washing/Drying ------------------------------
    function washDrySpec(category, task){
      var overrideR = task && task.harvest && Number(task.harvest.rinseMinutes);
      var overrideD = task && task.harvest && Number(task.harvest.dryMinutes);
      var advice = null; try{ advice = foodSafety.washAdvice(category); }catch(_e){ advice = null; }
      var spec = { rinseM: 0, dryM: 0 };
      if(advice){ spec.rinseM = advice.rinseM || 0; spec.dryM = advice.dryM || 0; }
      if(overrideR > 0) spec.rinseM = overrideR;
      if(overrideD > 0) spec.dryM = overrideD;
      if(!spec.rinseM && category==="leafy") spec.rinseM = 2;
      if(!spec.dryM && category==="leafy")  spec.dryM = 8;
      return spec;
    }

    // ----------------------------- Supplies ------------------------------------
    function buildSupplies(task, cropMeta){
      var items = [];
      var base = config.get("garden.baseTools", ["tools/harvest-shears","tools/harvest-tote","tools/labels","tools/twine","tools/brush"]);
      for(var i=0;i<base.length;i++){ var idb = base[i]; items.push({ id:idb, available:tryHas(idb), sku:safeSku(idb) }); }
      if(cropMeta && cropMeta.hasThorns) items.push({ id:"ppe/gloves", available:true, sku:safeSku("ppe/gloves") });
      if(task && toLower(task.kind)==="irrigation"){
        var ht = "tools/hose-timer"; items.push({ id:ht, available:tryHas(ht), sku:safeSku(ht) });
      }
      if(task && task.storage && task.storage.container){
        var cId = "container/"+toLower(task.storage.container);
        items.push({ id:cId, available:tryHas(cId), sku:safeSku(cId) });
      }
      // Dedup
      var seen={}, dedup=[]; for(var d=0; d<items.length; d++){ var it=items[d]; if(!seen[it.id]){ seen[it.id]=true; dedup.push(it); } }
      return dedup;
    }

    // ----------------------------- Yield estimate ------------------------------
    function estimateYield(task, cropMeta){
      var y = { qty: Number(task && task.harvest && task.harvest.qty) || 0, unit: safeString(task && task.harvest && task.harvest.unit, (cropMeta && cropMeta.yieldUnit) || "pcs") };
      if(!y.qty && cropMeta && cropMeta.yieldPerPlant && task && task.harvest && task.harvest.plants){
        y.qty = Number(task.harvest.plants) * Number(cropMeta.yieldPerPlant);
        y.unit = cropMeta.yieldUnit || y.unit;
      }
      if(!y.qty) y.qty = 1;
      return y;
    }

    // ----------------------------- Core: toRunbook -----------------------------
    /**
     * toRunbook(task, opts?)
     * task: {...}  // same structure as previous version
     * opts: { sessionId?: string, resumeState?: { stepId?:string, timers?:{[stepId]:{remainingMs:number}} }, background?: boolean }
     */
    function toRunbook(task, opts){
      opts = opts || {};
      var id    = (task && task.id) || ("garden:" + Math.random().toString(36).slice(2));
      var kind  = toLower((task && task.kind) || "harvest");
      var title = (kind === "harvest" ? "Harvest • " : "Garden • ") + safeString(task && task.title, "Task");

      var cropName = (task && task.harvest && task.harvest.crop) || "";
      var cropMeta = null; try{ cropMeta = gardenDb.getCropMeta(cropName); }catch(_e){ cropMeta = null; }

      var issues   = validateTask(task);
      var hazards  = detectHazards(task, cropMeta);
      var supplies = buildSupplies(task, cropMeta);

      var steps = [];

      if(issues.length){
        steps.push({ id:stepId("guard"), label:"Pre-checks & guards", type:"ALERTS", wait:true, issues:issues.slice(0) });
      }

      if(kind === "harvest"){
        steps.push({ id:stepId("stage"), label:"Stage harvest tote (shears, bins, labels)", type:"MANUAL", wait:false });

        try{
          var windowInfo = scheduleHelpers.harvestWindow(cropName);
          if(windowInfo && windowInfo.best){
            steps.push({ id:stepId("window"), label:"Best harvest window: " + windowInfo.best, type:"NOTE", wait:false });
          }
        }catch(_e){}

        if(hazards.indexOf("env/heat-advisory")>=0) steps.push({ id:stepId("heat"), label:"Heat advisory: hydrate, work in shade, shorten sessions", type:"NOTE", wait:false });
        if(hazards.indexOf("env/high-uv")>=0)       steps.push({ id:stepId("uv"),   label:"High UV: add hat/sunscreen or schedule early/late", type:"NOTE", wait:false });

        steps.push({ id:stepId("pick"), label:"Harvest: " + (cropName || "produce"), type:"MANUAL", wait:false });

        var category = (cropMeta && cropMeta.category) || "leafy";
        var washSpec = washDrySpec(category, task);
        var wantsWash = !!(task && task.washAndDry) || category==="leafy";
        if(wantsWash && washSpec.rinseM){
          steps.push({ id:stepId("rinse"), label:"Rinse / cool water soak", type:"TIMER", timer:{ minutes:washSpec.rinseM, label:"Rinse ("+washSpec.rinseM+"m)" }, wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true });
        }
        if(wantsWash && washSpec.dryM){
          steps.push({ id:stepId("dry"), label:"Spin / air-dry", type:"TIMER", timer:{ minutes:washSpec.dryM, label:"Dry ("+washSpec.dryM+"m)" }, wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true });
        }

        var st = task && task.storage;
        var defaultStorage = (cropMeta && cropMeta.defaultStorage) || null;
        var storageMethod = (st && st.method) || (defaultStorage && defaultStorage.method) || "refrigerate";
        var container = (st && st.container) || (defaultStorage && defaultStorage.container) || "container";
        var location = (st && st.location) || (defaultStorage && defaultStorage.location) || "";
        var targetF  = (st && st.targetF) || (defaultStorage && defaultStorage.targetF) || 38;

        steps.push({ id:stepId("store"), label:"Store: " + storageMethod + " in " + container + (location?(" → "+location):"") + " ("+targetF+"°F target)", type:"MANUAL", wait:false });

        if(task && task.harvest && task.harvest.label){
          var labelId=""; try{
            labelId = labeler.makeLabel({ name: cropName || (task.title||"Produce"), qty: (task.harvest && task.harvest.qty) || "", unit:(task.harvest && task.harvest.unit) || "", date: clock.now().toISOString().slice(0,10), location: location });
          }catch(_e){ labelId=""; }
          steps.push({ id:stepId("label"), label:"Print/apply label" + (labelId?(" ("+labelId+")"):""), type:"MANUAL", wait:false });
        }
      }
      else if(kind === "irrigation"){
        var rainMM=0; try{ rainMM = Number(weather.recentRainMM(2) || 0); }catch(_e){}
        var skipRain = (task && task.irrigation && Number(task.irrigation.skipIfRainMM)) || 6;
        if(rainMM >= skipRain){
          steps.push({ id:stepId("skip"), label:"Skip irrigation (recent rain "+rainMM+"mm ≥ "+skipRain+"mm)", type:"NOTE", wait:false });
        } else {
          var runtime=null; try{ runtime = scheduleHelpers.irrigationRuntime(task) || null; }catch(_e){ runtime=null; }
          var minutes = (runtime && runtime.minutes) || (task && task.irrigation && Number(task.irrigation.minutes)) || 20;
          var method  = safeString(task && task.irrigation && task.irrigation.method, "drip");
          steps.push({ id:stepId("irrigate"), label:"Irrigate ("+minutes+"m) — " + method, type:"TIMER", timer:{ minutes:minutes, label:"Irrigation ("+minutes+"m)" }, wait:true, parallelizable:true, emitAsPrepCandidate:true, backgroundOK:true });
        }
      }
      else if(kind === "pest"){
        steps.push({ id:stepId("inspect"), label:"Inspect plants & confirm pest/disease", type:"CHECKLIST", wait:false, checklist:["Photograph damage","Check underside of leaves","Identify pest stage (egg/larva/adult)"] });
        var rec=null; try{ rec = pests.recommend(task && task.issue, cropName); }catch(_e){ rec=null; }
        if(rec && rec.product){
          steps.push({ id:stepId("treat"), label:"Apply treatment: " + rec.product, type:"MANUAL", wait:false });
          if(rec.phiDays || (task && task.pesticide && task.pesticide.phiDays)){
            var phi = Number(rec.phiDays || task.pesticide.phiDays || 0);
            steps.push({ id:stepId("phi"), label:"Set PHI lock: no harvest for " + phi + " days", type:"NOTE", wait:false });
          }
          if(rec.notes) steps.push({ id:stepId("pnotes"), label:"Notes: " + rec.notes, type:"NOTE", wait:false });
        } else {
          steps.push({ id:stepId("nt"), label:"Use non-chemical controls (hand-pick, blast with water, remove leaves)", type:"MANUAL", wait:false });
        }
      }
      else if(kind === "fertilize"){
        steps.push({ id:stepId("stagef"), label:"Stage fertilizer & watering can/hose", type:"MANUAL", wait:false });
        steps.push({ id:stepId("fert"),   label:"Apply fertilizer per label (avoid leaf burn)", type:"MANUAL", wait:false });
        steps.push({ id:stepId("waterin"), label:"Water-in fertilizer", type:"MANUAL", wait:false });
      }
      else if(kind === "prune" || kind === "trellis"){
        steps.push({ id:stepId("staget"), label:"Stage pruners, ties, trellis clips", type:"MANUAL", wait:false });
        steps.push({ id:stepId("doit"),   label:safeString(task && task.title, "Structure plants (prune/trellis)"), type:"MANUAL", wait:false });
      }
      else if(kind === "seeding" || kind === "transplant"){
        steps.push({ id:stepId("soilprep"), label:"Prep bed/containers (loosen soil, amend if needed)", type:"MANUAL", wait:false });
        steps.push({ id:stepId("plant"),    label:(kind==="seeding"?"Sow seeds":"Transplant seedlings")+" at proper spacing/depth", type:"MANUAL", wait:false });
        steps.push({ id:stepId("water"),    label:"Water gently to settle soil", type:"MANUAL", wait:false });
        steps.push({ id:stepId("shade"),    label:"Provide shade/row cover if high UV", type:"CHECK", wait:false });
      }
      else { // maintenance / weeding / soil / mulch / compost / generic
        steps.push({ id:stepId("stage"), label:"Stage garden tools", type:"MANUAL", wait:false });
        steps.push({ id:stepId("do"),    label:safeString(task && task.title, "Garden maintenance"), type:"MANUAL", wait:false });
      }

      // Cleanup
      var cleanup = [
        { id: stepId("rinsetools"), label:"Rinse tools, dry & oil pruners", type:"MANUAL", wait:false }
      ];

      // Logging & Inventory
      var logging = [];
      if(kind === "harvest"){
        var est = estimateYield(task, cropMeta);
        logging.push({ type:"HARVEST_LOG", crop: cropName || (task && task.title) || "produce", qty: est.qty, unit: est.unit, bed:(task && task.bed)||"", zone:(task && task.zone)||"", ts: clock.now().toISOString() });
        try{
          inventory.add([{ id:"produce/"+toLower(cropName||task.title), qty:est.qty, unit:est.unit, meta:{ bed:task && task.bed, zone:task && task.zone } }]);
        }catch(_e){}
      } else {
        logging.push({ type:"GARDEN_TASK_LOG", kind:kind, area:(task && (task.area || task.title)) || "Garden", notes:safeString(task && task.notes, ""), ts: clock.now().toISOString() });
      }

      // Estimates
      var estimatedMinutes = Number(task && task.estMinutes || 0) || defaultEstimate(kind, task);
      var estimatedCost = 0;
      try{
        estimatedCost = Number(estimate.gardenCost({
          kind: kind,
          supplies: supplies,
          hazards: hazards,
          estimatedMinutes: estimatedMinutes,
          crop: cropName,
          area: (task && (task.area || task.title)) || "Garden"
        })) || 0;
      }catch(_e){ estimatedCost = 0; }

      // Build runbook
      var runbook = {
        id: id,
        sessionId: opts.sessionId || null,
        title: title,
        domain: "garden",
        priority: (task && task.priority) || "normal",
        estimatedMinutes: estimatedMinutes,
        estimatedCost: estimatedCost,
        hazards: hazards,
        supplies: supplies,
        steps: steps,
        cleanup: cleanup,
        logging: logging,
        guards: { sabbathActive: isSabbathGuardActive() },
        meta: {
          kind: kind,
          crop: cropName || "",
          area: (task && task.area) || "",
          bed: (task && task.bed) || "",
          zone: (task && task.zone) || "",
          background: !!opts.background,
          source: "gardenExecutor",
          resumeState: opts.resumeState || null
        }
      };

      // ----------------------------- Orchestration Hooks ------------------------
      try{
        if(runbook.guards.sabbathActive){
          eventBus.emit("guard:sabbath", { runbookId:id, title:title, when: clock.now().toISOString(), domain:"garden" });
        }
        for(var s=0; s<steps.length; s++){
          var st = steps[s];
          if(st && st.type==="TIMER"){
            var minutes = (st.timer && st.timer.minutes) || 0;
            if(st.emitAsPrepCandidate){
              var area = runbook.meta.area || runbook.meta.bed || "Garden";
              var win = { minutes: minutes, label: st.label, domain:"garden", area: area, runbookId:id };
              eventBus.emit("prep:candidate", win);
              prepBus.emitCandidate({ minutes: minutes, label: st.label, domain: "garden", area: area });
            }
            if(st.backgroundOK && minutes>0){
              scheduleTimerReminder(id, st, minutes);
              nba.upsert({ kind:"window", domain:"garden", runbookId:id, stepId:st.id, label:"Use wait window wisely", priority:"info" });
            }
          }
          if(st && st.type==="REMINDER" && st.reminder && st.reminder.whenISO){
            automation.scheduleAt(st.reminder.whenISO, { kind:"reminder", domain:"garden", runbookId:id, stepId:st.id, label:st.reminder.label });
            eventBus.emit("reminder:scheduled", { domain:"garden", runbookId:id, stepId:st.id, at:st.reminder.whenISO, label:st.reminder.label });
          }
        }
        eventBus.emit("runbook:created", { runbook: runbook });
        analytics.track("runbook/built", { domain:"garden", kind:kind, crop:cropName, minutes:runbook.estimatedMinutes, estCost: estimatedCost, hazards:hazards, priority:runbook.priority });
      } catch(_e){}

      return runbook;
    }

    function defaultEstimate(kind, task){
      var k = toLower(kind);
      if(k==="harvest"){ var wash = !!(task && task.washAndDry); return wash ? 25 : 12; }
      if(k==="irrigation") return (task && task.irrigation && Number(task.irrigation.minutes)) || 20;
      if(k==="seeding" || k==="transplant") return 30;
      if(k==="pest") return 20;
      if(k==="fertilize") return 15;
      return 15;
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
      var sessionId = runbook.sessionId || ("garden-" + Math.random().toString(36).slice(2,8));

      function coerceIndex(idOrIndex){
        if (typeof idOrIndex === "number") return Math.max(0, Math.min(runbook.steps.length-1, idOrIndex));
        var i; for (i=0;i<runbook.steps.length;i++){ if (runbook.steps[i].id === idOrIndex) return i; }
        return idx;
      }

      function blockedByGuards(){
        if (runbook.guards && runbook.guards.sabbathActive) return { blocked:true, reason:"sabbath" };
        var issues = validateTask({ title: runbook.title, kind: runbook.meta && runbook.meta.kind || "harvest" });
        for (var j=0;j<issues.length;j++){
          if (String(issues[j]).toLowerCase().indexOf("withhold window")>=0){
            return { blocked:true, reason:"quiet-hours" };
          }
        }
        return { blocked:false };
      }

      function emitStepStart(i){
        var st = runbook.steps[i];
        eventBus.emit("garden:step:start", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "garden", index: i });
        analytics.track("garden/step/start", { step: st.label, index: i, runbookId: runbook.id });
      }

      function emitStepComplete(i){
        var st = runbook.steps[i];
        eventBus.emit("garden:step:complete", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        analytics.track("garden/step/complete", { step: st.label, index: i, runbookId: runbook.id });
      }

      function start(){
        var g = blockedByGuards();
        if (g.blocked){
          eventBus.emit("session:paused", { sessionId: sessionId, domain: "garden", reason: g.reason || "guard" });
          return { ok:false, blocked:true, reason: g.reason || "guard" };
        }
        eventBus.emit("session:created", { sessionId: sessionId, domain: "garden", title: runbook.title, steps: runbook.steps, startedAt: clock.now().toISOString() });
        analytics.track("garden/session/start", { runbookId: runbook.id, steps: runbook.steps.length });
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
          eventBus.emit("session:ended", { sessionId: sessionId, domain: "garden", finishedAt: clock.now().toISOString() });
          analytics.track("garden/session/end", { runbookId: runbook.id });
        }
        return { ok:true, index: idx };
      }

      function pause(reason){
        eventBus.emit("session:paused", { sessionId: sessionId, domain: "garden", reason: reason || "user" });
        return { ok:true };
      }
      function resume(){
        eventBus.emit("session:resumed", { sessionId: sessionId, domain: "garden" });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "garden", index: idx });
        return { ok:true, index: idx };
      }
      function abort(){
        eventBus.emit("session:ended", { sessionId: sessionId, domain: "garden", aborted: true, finishedAt: clock.now().toISOString() });
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
        domain: "garden",
        title: safeString(payload.title, "Garden Session"),
        templateId: payload.templateId || "",
        steps: payload.steps || [],
        createdAt: clock.now().toISOString(),
        updatedAt: Date.now(),
        meta: { source: "user" }
      };
      var viaHook = favorites && typeof favorites.save === "function";
      if (viaHook) {
        return favorites.save(fav).then(function(res){
          if (res && res.ok){ eventBus.emit("favorites:changed", { domain: "garden" }); }
          return res || { ok:false };
        });
      }
      var res = lsSave("garden:favorites", fav, "id");
      if (res.ok) eventBus.emit("favorites:changed", { domain: "garden" });
      return Promise.resolve(res);
    }

    function saveScheduleTemplate(payload){
      var sched = {
        id: "sched-" + Math.random().toString(36).slice(2,10),
        domain: "garden",
        title: safeString(payload.title, "Garden Schedule"),
        sessionTemplate: { templateId: payload.templateId || "", steps: payload.steps || [] },
        rrule: payload.rrule || "FREQ=WEEKLY;BYDAY=SA;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        firstRunAt: safeString(payload.firstRunAtISO, clock.now().toISOString())
      };
      var viaHook = schedules && typeof schedules.save === "function";
      var onOk = function(ok){
        if (ok) {
          eventBus.emit("schedules:changed", { domain: "garden" });
          try {
            automation.scheduleAt(sched.firstRunAt, { kind:"session", domain:"garden", title:sched.title, rrule:sched.rrule, sessionTemplate: sched.sessionTemplate });
          } catch(_e){}
        }
      };
      if (viaHook) {
        return schedules.save(sched).then(function(res){ onOk(res && res.ok); return res || { ok:false }; });
      }
      var res = lsSave("garden:schedules", sched, "id");
      onOk(res.ok);
      return Promise.resolve(res);
    }

    // ----------------------------- Public API ----------------------------------
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

  // Backwards-compatible default export using empty deps (safe fallbacks)
  var defaultExecutor = createGardenExecutor({});

  module.exports = {
    createGardenExecutor: createGardenExecutor,
    toRunbook: defaultExecutor.toRunbook,
    validateTask: defaultExecutor.validateTask,
    makeRunner: defaultExecutor.makeRunner,
    saveFavoriteSession: defaultExecutor.saveFavoriteSession,
    saveScheduleTemplate: defaultExecutor.saveScheduleTemplate
  };
})();

/* eslint-disable no-console */
// cleaningExecutor.js — build robust runbooks for cleaning sessions + lightweight runner + user-owned favorites/schedules
// Style: ES2015-safe, dependency-light, defensive DI, event-driven hooks.

(function () {
  /**
   * Factory so we can DI optional services without crashing if they're absent.
   *
   * @param {Object} deps
   *  - clock:        { now(): Date }
   *  - config:       { get(path:string, fallback:any):any, sabbathGuard?: { enabled:boolean, start?:string, end?:string }, withholdWindows?:Array }
   *  - inventory:    { has(itemId:string):boolean, reserve?(itemIds:string[]):void }
   *  - eventBus:     { emit(evt:string, payload:object):void }
   *  - analytics:    { track(evt:string, payload:object):void }
   *  - recipes:      { getCleaningFormula(key:string): { name, ingredients:[{item, qty, unit}], steps:[string] } }
   *  - safety:       { sdsUrl?(chem:string):string }
   *  - catalog:      { skuFor?(itemId:string):string }
   *  - estimate:     { cleaningCost?(ctx:object):number }
   *  - automation:   { scheduleAt?(iso:string,payload:object):void, scheduleAfter?(ms:number,payload:object):void }
   *  - nba:          { upsert?(hint:object):void }                        // Next Best Action orchestrator
   *  - prep:         { emitCandidate?(win:{minutes:number,label:string,domain:string,area:string}):void }
   *  - favorites:    { save?(fav:object):Promise<{ok:boolean}> }          // user-owned sessions
   *  - schedules:    { save?(sched:object):Promise<{ok:boolean}> }        // user-owned schedules
   */
  function createCleaningExecutor(deps) {
    var clock      = (deps && deps.clock)      || { now: function(){ return new Date(); } };
    var config     = (deps && deps.config)     || { get: function(_p, fb){ return fb; }, sabbathGuard: { enabled:false }, withholdWindows: [] };
    var inventory  = (deps && deps.inventory)  || { has: function(){ return false; }, reserve: function(){} };
    var eventBus   = (deps && deps.eventBus)   || { emit: function(){} };
    var analytics  = (deps && deps.analytics)  || { track: function(){} };
    var recipes    = (deps && deps.recipes)    || { getCleaningFormula: function(){ return null; } };
    var safety     = (deps && deps.safety)     || { sdsUrl: function(){ return ""; } };
    var catalog    = (deps && deps.catalog)    || { skuFor: function(){ return ""; } };
    var estimate   = (deps && deps.estimate)   || { cleaningCost: function(){ return 0; } };
    var automation = (deps && deps.automation) || { scheduleAt: function(){}, scheduleAfter: function(){} };
    var nba        = (deps && deps.nba)        || { upsert: function(){} };
    var prepBus    = (deps && deps.prep)       || { emitCandidate: function(){} };
    var favorites  = (deps && deps.favorites)  || { save: function(){ return Promise.resolve({ ok:false }); } };
    var schedules  = (deps && deps.schedules)  || { save: function(){ return Promise.resolve({ ok:false }); } };

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

    // ----------------------------- Domain dictionaries (config-overridable) ----
    var DEFAULT_DWELL_MINUTES = config.get("cleaning.dwellDefaults", {
      bleach: 10, hydrogen_peroxide: 6, quats: 10, vinegar: 3, apc: 2, acid: 5, degreaser: 5, alcohol: 1
    });

    var CHEM_COMPAT_MATRIX = config.get("cleaning.compatMatrix", {
      bleach: ["ammonia", "acid", "vinegar"],
      ammonia: ["bleach"],
      acid: ["bleach", "ammonia", "quats"],
      vinegar: ["bleach"],
      quats: ["acid"],
      alcohol: [], degreaser: [], apc: []
    });

    var CHEM_PPE = config.get("cleaning.chemPPE", {
      bleach: ["gloves", "eye-protection"],
      ammonia: ["gloves", "eye-protection"],
      acid: ["gloves", "eye-protection", "apron"],
      degreaser: ["gloves"],
      quats: ["gloves"],
      apc: [],
      vinegar: [],
      alcohol: ["gloves"],
      hydrogen_peroxide: ["gloves"]
    });

    var CHEM_ENV_FLAGS = config.get("cleaning.envFlags", {
      bleach: { ventilation: true,  noMetal: false, keepPetsOut: true },
      ammonia:{ ventilation: true,  noMetal: false, keepPetsOut: true },
      acid:  { ventilation: true,  noMetal: true,  keepPetsOut: true },
      degreaser:{ ventilation:true, noMetal: false, keepPetsOut: false },
      alcohol: { ventilation: true, noMetal: false, keepPetsOut: true },
      quats:  { ventilation: false, noMetal: false, keepPetsOut: true },
      apc:    { ventilation: false, noMetal: false, keepPetsOut: false },
      vinegar:{ ventilation: false, noMetal: false, keepPetsOut: false },
      hydrogen_peroxide: { ventilation: false, noMetal: false, keepPetsOut: true }
    });

    var SURFACE_HINTS = config.get("cleaning.surfaceHints", {
      stainless: { noAbrasive: true, tool: "microfiber • with-grain passes" },
      glass:     { noResidue: true, tool: "lint-free towel • squeegee" },
      stone:     { noAcid: true,    tool: "pH-neutral cleaner • soft pad" },
      wood:      { noStandingWater:true, tool: "slightly damp microfiber" },
      tile:      { groutFocus: true, tool: "nylon brush for grout" }
    });

    // ----------------------------- Helpers -------------------------------------
    function uniqLower(arr){
      var seen = {}; var out = []; var i;
      for(i=0; i<(arr||[]).length; i++){
        var v = String(arr[i] || "").toLowerCase().trim();
        if(!v) continue;
        if(!seen[v]){ seen[v]=true; out.push(v); }
      }
      return out;
    }

    function sumPPE(chems){
      var set = {}; var i, j;
      for(i=0;i<chems.length;i++){
        var list = CHEM_PPE[chems[i]] || [];
        for(j=0;j<list.length;j++) set[list[j]] = true;
      }
      if(chems.length) set.gloves = true; // baseline
      return Object.keys(set);
    }

    function detectHazards(chems, task){
      var hazards = []; var i;
      for(i=0;i<chems.length;i++){
        var c = chems[i];
        if(c==="bleach") hazards.push("hazard/bleach");
        if(c==="ammonia") hazards.push("hazard/ammonia");
        if(c==="acid") hazards.push("hazard/acid");
        if(c==="quats") hazards.push("hazard/quats");
      }
      var env = { ventilation:false, noMetal:false, keepPetsOut:false };
      for(i=0;i<chems.length;i++){
        var f = CHEM_ENV_FLAGS[chems[i]] || {};
        if(f.ventilation) env.ventilation = true;
        if(f.noMetal)    env.noMetal = true;
        if(f.keepPetsOut)env.keepPetsOut = true;
      }
      if(env.ventilation) hazards.push("env/ventilation-required");
      if(env.noMetal) hazards.push("env/no-metal-contact");
      if(env.keepPetsOut || (task && task.petsPresent)) hazards.push("env/keep-pets-out");
      if(task && task.allergies && task.allergies.length) hazards.push("user/allergy-risk");
      return hazards;
    }

    function incompatibleCombo(chems){
      var i, j;
      for(i=0;i<chems.length;i++){
        var a = chems[i];
        var badWithA = CHEM_COMPAT_MATRIX[a] || [];
        for(j=0;j<chems.length;j++){
          if(i===j) continue;
          var b = chems[j];
          if(badWithA.indexOf(b)>=0) return { a:a, b:b };
        }
      }
      return null;
    }

    function inferredDwell(chems, explicit){
      if(explicit && explicit>0) return Number(explicit);
      var overrides = config.get("cleaning.dwellOverrides", {});
      var max = 0; var i;
      for(i=0;i<chems.length;i++){
        var c = chems[i];
        var m = overrides[c];
        if(typeof m === "number"){ if(m>max) max=m; continue; }
        var d = DEFAULT_DWELL_MINUTES[c];
        if(d && d>max) max=d;
      }
      return max;
    }

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

    function safeString(x, fb){ return (x===null || x===undefined) ? (fb||"") : String(x); }

    function stepId(prefix){ return prefix + "-" + Math.random().toString(36).slice(2,8); }

    function makeSDSLinkStep(chems){
      var links = []; var i;
      for(i=0;i<chems.length;i++){
        var url = "";
        try{ url = safety.sdsUrl(chems[i]) || ""; } catch(_e){ url=""; }
        if(url) links.push({ chem:chems[i], url:url });
      }
      if(!links.length) return null;
      return { id:stepId("sds"), label:"Open Safety Data Sheets", type:"LINKS", wait:false, links:links };
    }

    function pickSurfaceHint(surface){
      var s = (surface||"").toLowerCase();
      return SURFACE_HINTS[s] || null;
    }

    function injectRecipeSteps(formulaKey){
      var f = null;
      try{ f = recipes.getCleaningFormula(formulaKey); } catch(_e){ f = null; }
      if(!f) return null;

      var step = {
        id: stepId("mix"),
        label: "Mix homemade: " + f.name,
        type: "CHECKLIST",
        wait: false,
        checklist: (f.steps || []).slice(0)
      };

      var ingredients = (f.ingredients || []).map(function(x){ return { item:x.item, qty:x.qty, unit:x.unit }; });

      return { formula:f.name, ingredients:ingredients, steps:[step] };
    }

    function buildSupplyList(chems, extras){
      var goods = [];
      for(var i=0;i<chems.length;i++) goods.push("chem/" + chems[i]);
      var base = ["tools/microfiber","tools/scrub-pad","tools/brush","tools/bucket","tools/squeegee"];
      for(var j=0;j<base.length;j++) goods.push(base[j]);
      var ppe = sumPPE(chems);
      for(var k=0;k<ppe.length;k++) goods.push("ppe/" + ppe[k]);
      var ex = extras || [];
      for(var h=0;h<ex.length;h++) goods.push(ex[h]);

      var items = [];
      for(var z=0; z<goods.length; z++){
        var g = goods[z];
        var available = false;
        try{ available = !!inventory.has(g); } catch(_e){ available = false; }
        var sku = "";
        try{ sku = catalog.skuFor(g) || ""; } catch(_e){ sku = ""; }
        items.push({ id:g, available:available, sku:sku });
      }
      return items;
    }

    function scheduleTimerReminder(runbookId, step, minutes){
      try{
        var ms = Math.max(0, Math.round(minutes*60000));
        var whenISO = new Date(clock.now().getTime() + ms).toISOString();
        automation.scheduleAt(whenISO, {
          kind: "reminder",
          runbookId: runbookId,
          stepId: step.id,
          label: step.label,
          domain: "cleaning"
        });
        eventBus.emit("reminder:scheduled", { runbookId:runbookId, stepId:step.id, at:whenISO, label:step.label, domain:"cleaning" });
      } catch(_e){}
    }

    // ----------------------------- Validation ----------------------------------
    function validateTask(task){
      var issues = [];
      if(!task || typeof task !== "object"){ issues.push("Task is missing or not an object."); return issues; }
      if(!task.title) issues.push("Missing task.title");
      if(task.chemicals && Object.prototype.toString.call(task.chemicals) !== "[object Array]") issues.push("task.chemicals must be an array.");
      if(task.surfaces  && Object.prototype.toString.call(task.surfaces)  !== "[object Array]") issues.push("task.surfaces must be an array.");

      var chems = uniqLower(task.chemicals || []);
      var clash = incompatibleCombo(chems);
      if(clash) issues.push("Incompatible chemicals: " + clash.a + " + " + clash.b);

      if(isSabbathGuardActive()) issues.push("Sabbath guard active — execution should be deferred.");

      // Withhold windows (quiet hours; etc.)
      var withholds = config.get("cleaning.withholdWindows", config.withholdWindows || []); // [{ from:"22:00", to:"07:00", reason:"quiet-hours" }]
      try{
        var nowD = clock.now();
        var hh = nowD.getHours(); var mm = nowD.getMinutes();
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

    // ----------------------------- Core: toRunbook ------------------------------
    function toRunbook(task, opts){
      opts = opts || {};
      var issues    = validateTask(task);
      var id        = (task && task.id) || ("clean:" + Math.random().toString(36).slice(2));
      var title     = "Clean • " + safeString(task && task.title, "Area");
      var chems     = uniqLower((task && task.chemicals) || []);
      var surfaces  = (task && task.surfaces) || [];
      var dwell     = inferredDwell(chems, task && task.dwellMinutes);
      var hazards   = detectHazards(chems, task);
      var sdsStep   = makeSDSLinkStep(chems);
      var surfaceHint = (surfaces.length === 1) ? pickSurfaceHint(surfaces[0]) : null;
      var ppeList   = sumPPE(chems);
      var supplies  = buildSupplyList(chems, task && task.extras);
      var recipeBlock = (task && task.formulaKey) ? injectRecipeSteps(task.formulaKey) : null;

      var steps = [];

      if(issues.length){
        steps.push({ id:stepId("guard"), label:"Pre-checks & guards", type:"ALERTS", wait:true, issues:issues.slice(0) });
      }

      steps.push({ id:stepId("stage"), label:"Stage cleaning caddy & tools", type:"MANUAL", wait:false });
      steps.push({ id:stepId("ppe"),   label:"Don PPE: " + (ppeList.join(", ") || "gloves"), type:"CHECK", wait:false });

      var needVent   = hazards.indexOf("env/ventilation-required") >= 0;
      var needPetOut = hazards.indexOf("env/keep-pets-out") >= 0;
      if(needVent)   steps.push({ id:stepId("vent"), label:"Enable ventilation (open window / fan on)", type:"CHECK", wait:false });
      if(needPetOut) steps.push({ id:stepId("gate"), label:"Gate pets/children out of area", type:"CHECK", wait:false });

      if(surfaceHint){
        var hintBits = [surfaceHint.tool];
        if(surfaceHint.noAcid) hintBits.push("avoid acids");
        if(surfaceHint.noStandingWater) hintBits.push("no standing water");
        steps.push({ id:stepId("hint"), label:"Surface note: " + hintBits.join(" • "), type:"NOTE", wait:false });
      }

      if(recipeBlock && recipeBlock.steps){
        try{
          var ingIds = [];
          for(var r=0;r<recipeBlock.ingredients.length;r++){
            ingIds.push("chem/" + recipeBlock.ingredients[r].item);
          }
          inventory.reserve(ingIds);
        } catch(_e){}
        for(var rs=0; rs<recipeBlock.steps.length; rs++) steps.push(recipeBlock.steps[rs]);
      }

      if(sdsStep) steps.push(sdsStep);

      steps.push({
        id: stepId("apply"),
        label: "Apply " + (chems.join(" + ") || "cleaner") + (surfaces.length ? (" on " + surfaces.join(", ")) : ""),
        type: "MANUAL",
        wait: false
      });

      if(dwell > 0){
        var dwellStep = {
          id: stepId("dwell"),
          label: "Contact/Dwell time",
          type: "TIMER",
          timer: { minutes: dwell, label: "Dwell (" + dwell + "m)" },
          wait: true,
          parallelizable: true,
          emitAsPrepCandidate: true,
          backgroundOK: true
        };
        steps.push(dwellStep);
      }

      var scrubLabel = "Agitate / Scrub";
      if(surfaceHint && surfaceHint.tool) scrubLabel += " (" + surfaceHint.tool + ")";
      steps.push({ id: stepId("scrub"), label: scrubLabel, type: "MANUAL", wait: false });

      var needsDry = true;
      if(surfaces.indexOf("wood")>=0) needsDry = true;
      steps.push({ id: stepId("rinse"), label: "Rinse" + (needsDry ? " & dry thoroughly" : ""), type: "MANUAL", wait: false });

      if(task && task.sanitize){
        var sanitizeChem = (chems.indexOf("bleach")>=0) ? "bleach (sanitizing dilution)" : "sanitizer";
        var sanitizeDwell = inferredDwell(["bleach"], null);
        steps.push({ id: stepId("san1"), label:"Sanitize: apply " + sanitizeChem, type:"MANUAL", wait:false });
        steps.push({ id: stepId("san2"), label:"Sanitizer contact time", type:"TIMER", timer:{ minutes:sanitizeDwell, label:"Sanitize" }, wait:true, backgroundOK:true });
        steps.push({ id: stepId("san3"), label:"Air dry or final wipe per label", type:"MANUAL", wait:false });
      }

      steps.push({ id: stepId("waste"), label:"Dispose wastewater & containers per label/local rules", type:"CHECK", wait:false });

      var cleanup = [
        { id: stepId("towel"),  label:"Rinse tools & hang towels", type:"MANUAL", wait:false },
        { id: stepId("ppeoff"), label:"Doff PPE & wash hands",     type:"CHECK",  wait:false }
      ];

      var logging = [{
        type: "CLEANING_LOG",
        area: (task && (task.area || task.title)) || "Area",
        zone: (task && task.zone) || "",
        room: (task && task.room) || "",
        surfaces: surfaces,
        chemicals: chems,
        notes: safeString(task && task.notes, ""),
        ts: clock.now().toISOString()
      }];

      var estimatedMinutes = Number(task && task.estMinutes || 0) || (10 + (dwell||0));
      var estimatedCost = 0;
      try{
        estimatedCost = Number(estimate.cleaningCost({
          chemicals: chems,
          supplies: supplies,
          estimatedMinutes: estimatedMinutes,
          area: task && (task.area || task.title),
          surfaces: surfaces
        })) || 0;
      }catch(_e){ estimatedCost = 0; }

      var runbook = {
        id: id,
        sessionId: opts.sessionId || null,
        title: title,
        domain: "cleaning",
        priority: (task && task.priority) || "normal",
        estimatedMinutes: estimatedMinutes,
        estimatedCost: estimatedCost,
        hazards: detectHazards(chems, task),
        ppe: sumPPE(chems),
        supplies: supplies,
        steps: steps,
        cleanup: cleanup,
        logging: logging,
        guards: {
          sabbathActive: isSabbathGuardActive(),
          incompatibleChemicals: incompatibleCombo(chems)
        },
        meta: {
          surfaces: surfaces,
          chemicals: chems,
          dwellMinutes: dwell,
          recipe: recipeBlock ? (recipeBlock.formula || "") : "",
          background: !!opts.background,
          source: "cleaningExecutor",
          resumeState: opts.resumeState || null
        }
      };

      // ----------------------------- Orchestration hooks -----------------------
      try{
        if(runbook.guards.sabbathActive){
          eventBus.emit("guard:sabbath", { runbookId:id, title:title, when:clock.now().toISOString(), domain:"cleaning" });
        }
        if(runbook.guards.incompatibleChemicals){
          eventBus.emit("guard:chem-incompatible", { runbookId:id, clash:runbook.guards.incompatibleChemicals, chemicals:chems, domain:"cleaning" });
        }

        for(var s=0; s<steps.length; s++){
          var st = steps[s];
          if(st.type==="TIMER" && st.emitAsPrepCandidate){
            var win = { runbookId:id, windowMinutes: (st.timer && st.timer.minutes) || 0, label:st.label, domain:"cleaning", area: (task && (task.area || task.title)) || "Area" };
            eventBus.emit("prep:candidate", win);
            prepBus.emitCandidate({ minutes: win.windowMinutes, label: win.label, domain: win.domain, area: win.area });
            scheduleTimerReminder(id, st, win.windowMinutes);
            nba.upsert({ kind:"window", domain:"cleaning", runbookId:id, stepId:st.id, label:"Use dwell window wisely", priority:"info" });
          }
        }

        eventBus.emit("runbook:created", { runbook: runbook });
        analytics.track("runbook/built", {
          domain:"cleaning",
          chemicals:chems,
          dwell:dwell,
          hazards:runbook.hazards,
          priority:runbook.priority,
          estMin:estimatedMinutes,
          estCost:estimatedCost
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
      var sessionId = runbook.sessionId || ("clean-" + Math.random().toString(36).slice(2,8));

      function coerceIndex(idOrIndex){
        if (typeof idOrIndex === "number") return Math.max(0, Math.min(runbook.steps.length-1, idOrIndex));
        var i; for (i=0;i<runbook.steps.length;i++){ if (runbook.steps[i].id === idOrIndex) return i; }
        return idx;
      }

      function blockedByGuards(){
        if (runbook.guards && runbook.guards.sabbathActive) return { blocked:true, reason:"sabbath" };
        var issues = validateTask({ title: runbook.title, chemicals: runbook.meta && runbook.meta.chemicals || [] });
        for (var j=0;j<issues.length;j++){
          if (String(issues[j]).toLowerCase().indexOf("withhold window")>=0){
            return { blocked:true, reason:"quiet-hours" };
          }
        }
        if (runbook.guards && runbook.guards.incompatibleChemicals) return { blocked:true, reason:"chem-incompatible" };
        return { blocked:false };
      }

      function emitStepStart(i){
        var st = runbook.steps[i];
        eventBus.emit("cleaning:step:start", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "cleaning", index: i });
        analytics.track("clean/step/start", { step: st.label, index: i, runbookId: runbook.id });
      }

      function emitStepComplete(i){
        var st = runbook.steps[i];
        eventBus.emit("cleaning:step:complete", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        analytics.track("clean/step/complete", { step: st.label, index: i, runbookId: runbook.id });
      }

      function start(){
        var g = blockedByGuards();
        if (g.blocked){
          eventBus.emit("session:paused", { sessionId: sessionId, domain: "cleaning", reason: g.reason || "guard" });
          return { ok:false, blocked:true, reason: g.reason || "guard" };
        }
        eventBus.emit("session:created", { sessionId: sessionId, domain: "cleaning", title: runbook.title, steps: runbook.steps, startedAt: clock.now().toISOString() });
        analytics.track("clean/session/start", { runbookId: runbook.id, steps: runbook.steps.length });
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
          eventBus.emit("session:ended", { sessionId: sessionId, domain: "cleaning", finishedAt: clock.now().toISOString() });
          analytics.track("clean/session/end", { runbookId: runbook.id });
        }
        return { ok:true, index: idx };
      }

      function pause(reason){
        eventBus.emit("session:paused", { sessionId: sessionId, domain: "cleaning", reason: reason || "user" });
        return { ok:true };
      }
      function resume(){
        eventBus.emit("session:resumed", { sessionId: sessionId, domain: "cleaning" });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "cleaning", index: idx });
        return { ok:true, index: idx };
      }
      function abort(){
        eventBus.emit("session:ended", { sessionId: sessionId, domain: "cleaning", aborted: true, finishedAt: clock.now().toISOString() });
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
        domain: "cleaning",
        title: safeString(payload.title, "Cleaning Session"),
        templateId: payload.templateId || "",
        steps: payload.steps || [],
        createdAt: clock.now().toISOString(),
        updatedAt: Date.now(),
        meta: { source: "user" }
      };
      var viaHook = favorites && typeof favorites.save === "function";
      if (viaHook) {
        return favorites.save(fav).then(function(res){
          if (res && res.ok){ eventBus.emit("favorites:changed", { domain: "cleaning" }); }
          return res || { ok:false };
        });
      }
      var res = lsSave("cleaning:favorites", fav, "id");
      if (res.ok) eventBus.emit("favorites:changed", { domain: "cleaning" });
      return Promise.resolve(res);
    }

    function saveScheduleTemplate(payload){
      var sched = {
        id: "sched-" + Math.random().toString(36).slice(2,10),
        domain: "cleaning",
        title: safeString(payload.title, "Cleaning Schedule"),
        sessionTemplate: { templateId: payload.templateId || "", steps: payload.steps || [] },
        rrule: payload.rrule || "FREQ=WEEKLY;BYDAY=SA",
        firstRunAt: safeString(payload.firstRunAtISO, clock.now().toISOString())
      };
      var viaHook = schedules && typeof schedules.save === "function";
      var onOk = function(ok){
        if (ok) {
          eventBus.emit("schedules:changed", { domain: "cleaning" });
          try {
            automation.scheduleAt(sched.firstRunAt, { kind:"session", domain:"cleaning", title:sched.title, rrule:sched.rrule, sessionTemplate: sched.sessionTemplate });
          } catch(_e){}
        }
      };
      if (viaHook) {
        return schedules.save(sched).then(function(res){ onOk(res && res.ok); return res || { ok:false }; });
      }
      var res = lsSave("cleaning:schedules", sched, "id");
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
  var defaultExecutor = createCleaningExecutor({});

  module.exports = {
    createCleaningExecutor: createCleaningExecutor,
    toRunbook: defaultExecutor.toRunbook,
    validateTask: defaultExecutor.validateTask,
    makeRunner: defaultExecutor.makeRunner,
    saveFavoriteSession: defaultExecutor.saveFavoriteSession,
    saveScheduleTemplate: defaultExecutor.saveScheduleTemplate
  };
})();

/* eslint-disable no-console */
// cookingExecutor.js — build robust runbooks for meals + lightweight runner + user-owned favorites/schedules
// Style: ES2015-safe, dependency-light, defensive DI, event-driven hooks.

(function () {
  /**
   * Factory allows DI of optional services; falls back safely if absent.
   *
   * @param {Object} deps
   *  - clock:          { now(): Date }
   *  - config:         { get(path, fb):any, sabbathGuard?:{enabled:boolean,start?:string,end?:string}, withholdWindows?:Array }
   *  - inventory:      { has(key:string):boolean, reserve?(items:Array), commit?(items:Array), suggestSub?(missingKey:string):string[] }
   *  - eventBus:       { emit(evt:string, payload:Object):void }
   *  - analytics:      { track(evt:string, payload:Object):void }
   *  - nutrition:      { estimate(recipe): { calories:number, protein:number, carbs:number, fat:number, servings:number } }
   *  - scheduleHelpers:{
   *        needsDefrost?(task): boolean,
   *        needsMarinade?(task): boolean,
   *        preheatSpec?(appliance:string, recipe): { temp:number, minutes:number } | null,
   *        restMinutes?(protein:string): number
   *    }
   *  - safety:         { sdsUrl?(chem:string):string }
   *  - catalog:        { skuFor?(itemId:string):string }
   *  - estimate:       { cookingCost?(ctx:object):number }
   *  - automation:     { scheduleAt?(iso:string,payload:object):void, scheduleAfter?(ms:number,payload:object):void }
   *  - nba:            { upsert?(hint:object):void } // Next Best Action orchestrator
   *  - prep:           { emitCandidate?(win:{minutes:number,label:string,domain:string,area?:string}):void }
   *  - favorites:      { save?(fav:object):Promise<{ok:boolean}> } // user-owned sessions
   *  - schedules:      { save?(sched:object):Promise<{ok:boolean}> } // user-owned schedules
   */
  function createCookingExecutor(deps) {
    var clock      = (deps && deps.clock)      || { now: function(){ return new Date(); } };
    var config     = (deps && deps.config)     || { get: function(_p, fb){ return fb; }, sabbathGuard: { enabled:false }, withholdWindows: [] };
    var inventory  = (deps && deps.inventory)  || { has: function(){ return false; }, reserve: function(){}, commit: function(){}, suggestSub: function(){ return []; } };
    var eventBus   = (deps && deps.eventBus)   || { emit: function(){} };
    var analytics  = (deps && deps.analytics)  || { track: function(){} };
    var nutrition  = (deps && deps.nutrition)  || { estimate: function(){ return null; } };
    var scheduleHelpers = (deps && deps.scheduleHelpers) || {
      needsDefrost: function(){ return false; },
      needsMarinade: function(){ return false; },
      preheatSpec: function(appliance/*, recipe*/){
        var a = String(appliance||"").toLowerCase();
        if (a === "oven")        return { temp: 400, minutes: 10 };
        if (a === "air fryer")   return { temp: 375, minutes: 5  };
        if (a === "grill")       return { temp: 500, minutes: 12 };
        if (a === "pizza oven")  return { temp: 700, minutes: 20 };
        return null;
      },
      restMinutes: function (protein){
        var p = String(protein||"").toLowerCase();
        if (p==="beef"||p==="lamb") return 10;
        if (p==="pork")             return 5;
        if (p==="poultry")          return 2;
        if (p==="fish")             return 1;
        return 3;
      }
    };
    var safety     = (deps && deps.safety)     || { sdsUrl: function(){ return ""; } };
    var catalog    = (deps && deps.catalog)    || { skuFor: function(){ return ""; } };
    var estimate   = (deps && deps.estimate)   || { cookingCost: function(){ return 0; } };
    var automation = (deps && deps.automation) || { scheduleAt: function(){}, scheduleAfter: function(){} };
    var nba        = (deps && deps.nba)        || { upsert: function(){} };
    var prepBus    = (deps && deps.prep)       || { emitCandidate: function(){} };
    var favorites  = (deps && deps.favorites)  || { save: function(){ return Promise.resolve({ ok: false }); } };
    var schedules  = (deps && deps.schedules)  || { save: function(){ return Promise.resolve({ ok: false }); } };

    // ----------------------------- Local persistence fallbacks -----------------
    var LS = (function(){
      try { return window && window.localStorage; } catch(_e){ return null; }
    })();
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

    // ----------------------------- Domain dictionaries -------------------------
    var TARGET_TEMPS_F = config.get("meals.targetTempsF", {
      poultry: 165, pork: 145, beef: 145, lamb: 145, fish: 145, leftovers: 165
    });

    var APPLIANCE_KINDS = config.get("meals.applianceKinds", {
      "oven":            { name: "Oven",            supportsPreheat: true  },
      "stovetop":        { name: "Stovetop",        supportsPreheat: false },
      "air fryer":       { name: "Air Fryer",       supportsPreheat: true  },
      "grill":           { name: "Grill",           supportsPreheat: true  },
      "slow cooker":     { name: "Slow Cooker",     supportsPreheat: false },
      "pressure cooker": { name: "Pressure Cooker", supportsPreheat: false },
      "instant pot":     { name: "Pressure Cooker", supportsPreheat: false },
      "microwave":       { name: "Microwave",       supportsPreheat: false },
      "deep fryer":      { name: "Deep Fryer",      supportsPreheat: true  }
    });

    var ALLERGENS = config.get("meals.allergens", ["gluten","dairy","egg","soy","peanut","tree nut","fish","shellfish","sesame","mustard","sulfite"]);

    // ----------------------------- Helpers -------------------------------------
    function uniqLower(arr){
      var out = []; var seen = {};
      for (var i=0;i<(arr||[]).length;i++){
        var v = String(arr[i]||"").toLowerCase().trim();
        if(!v) continue;
        if(!seen[v]){ seen[v]=true; out.push(v); }
      }
      return out;
    }
    function stepId(prefix){ return prefix + "-" + Math.random().toString(36).slice(2,8); }
    function safeString(x, fb){ return (x===null||x===undefined)?(fb||""):String(x); }
    function tryHas(key){ try { return !!inventory.has(key); } catch(_e){ return false; } }

    function isSabbathGuardActive(){
      var sg = config.sabbathGuard || (config.get && config.get("sabbath.guard", { enabled:false }));
      if(!sg || !sg.enabled) return false;
      try{
        var nowD = clock.now(); var day = nowD.getDay();
        var start = sg.start || "Fri 18:00"; var end = sg.end || "Sat 19:00";
        function parseBoundary(s){
          var parts = String(s).split(" "); var wday = parts[0]; var hm = parts[1] || "18:00";
          var map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
          var targetD = map[wday];
          var base = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate(), 0,0,0,0);
          var delta = targetD - day;
          var target = new Date(base.getTime() + delta*24*60*60*1000);
          var hmParts = hm.split(":"); target.setHours(Number(hmParts[0]||0)); target.setMinutes(Number(hmParts[1]||0));
          return target;
        }
        var s = parseBoundary(start); var e = parseBoundary(end);
        if(e < s) e = new Date(e.getTime() + 7*24*60*60*1000);
        return (nowD >= s && nowD <= e);
      } catch(_e){ return false; }
    }

    function detectHazards(task){
      var hazards = [];
      var flags = uniqLower(task.flags || []);
      var apps  = uniqLower(task.appliances || []);
      if (flags.indexOf("raw-meat")>=0 || flags.indexOf("raw-fish")>=0) hazards.push("hazard/raw-protein");
      if (apps.indexOf("deep fryer")>=0) hazards.push("hazard/hot-oil");
      if (apps.indexOf("pressure cooker")>=0 || apps.indexOf("instant pot")>=0) hazards.push("hazard/pressure");
      if (flags.indexOf("alcohol-flambe")>=0) hazards.push("hazard/flame");
      var ing = (task.recipe && task.recipe.ingredients) || [];
      var lowerIng = []; for (var i=0;i<ing.length;i++) lowerIng.push(String(ing[i].name||"").toLowerCase());
      for (var j=0;j<ALLERGENS.length;j++){
        var a = ALLERGENS[j];
        for (var k=0;k<lowerIng.length;k++){ if (lowerIng[k].indexOf(a)>=0){ hazards.push("allergen/"+a); break; } }
      }
      return hazards;
    }

    function buildSupplies(task){
      var items = [];
      var base = config.get("meals.miseTools", ["tools/chef-knife","tools/cutting-board","tools/tongs","tools/thermometer","tools/scale","tools/timer"]);
      for (var i=0;i<base.length;i++){
        var idb = base[i];
        items.push({ id: idb, available: tryHas(idb), sku: safeSku(idb) });
      }
      var apps = uniqLower(task.appliances || []);
      for (var a=0;a<apps.length;a++){
        var apId = "appliance/" + apps[a];
        items.push({ id: apId, available: true, sku: safeSku(apId) });
      }
      var rec = task.recipe || {}; var ings = rec.ingredients || [];
      for (var n=0;n<ings.length;n++){
        var key = "ing/" + String(ings[n].name||"").toLowerCase();
        items.push({ id: key, available: tryHas(key), sku: safeSku(key) });
      }
      var seen = {}; var dedup = [];
      for (var d=0; d<items.length; d++){
        var it = items[d];
        if(!seen[it.id]){ seen[it.id]=true; dedup.push(it); }
      }
      return dedup;
    }

    function safeSku(id){ try{ return catalog.skuFor(id) || ""; } catch(_e){ return ""; } }

    function reserveRecipeIngredients(recipe){
      try{
        var arr = []; var ings = (recipe && recipe.ingredients) || [];
        for (var i=0;i<ings.length;i++){
          arr.push({ id:"ing/"+String(ings[i].name||"").toLowerCase(), qty: ings[i].qty || 1, unit: ings[i].unit || "" });
        }
        inventory.reserve(arr);
      } catch(_e){}
    }

    function commitRecipeIngredients(recipe){
      try{
        var arr = []; var ings = (recipe && recipe.ingredients) || [];
        for (var i=0;i<ings.length;i++){
          arr.push({ id:"ing/"+String(ings[i].name||"").toLowerCase(), delta: -(ings[i].qty || 1), unit: ings[i].unit || "" });
        }
        inventory.commit(arr);
      } catch(_e){}
    }

    function pickProbeTargetF(task){
      if (task && task.recipe && task.recipe.safeTempF) return Number(task.recipe.safeTempF);
      var protein = (task && task.recipe && task.recipe.primaryProtein) || "";
      var p = String(protein||"").toLowerCase();
      if (TARGET_TEMPS_F[p]) return TARGET_TEMPS_F[p];
      var flags = uniqLower(task.flags||[]);
      if (flags.indexOf("raw-meat")>=0) return 145;
      if (flags.indexOf("raw-fish")>=0) return 145;
      return 165;
    }

    function marinadeOrDefrostNotices(task){
      var notices = [];
      try {
        if (scheduleHelpers.needsDefrost(task)) notices.push("Item requires defrost (schedule or use quick-safe thaw).");
        if (scheduleHelpers.needsMarinade(task)) notices.push("Item requires marinade time before cooking.");
      } catch(_e){}
      return notices;
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
          domain: "meals"
        });
        eventBus.emit("reminder:scheduled", { runbookId:runbookId, stepId:step.id, at:whenISO, label:step.label, domain:"meals" });
      } catch(_e){}
    }

    // ----------------------------- Validation ----------------------------------
    function validateTask(task){
      var issues = [];
      if(!task || typeof task !== "object"){ issues.push("Task missing or not an object."); return issues; }
      if(!task.title) issues.push("Missing task.title");
      if(task.appliances && Object.prototype.toString.call(task.appliances) !== "[object Array]") issues.push("task.appliances must be an array.");
      if(task.flags && Object.prototype.toString.call(task.flags) !== "[object Array]") issues.push("task.flags must be an array.");
      if(isSabbathGuardActive()) issues.push("Sabbath guard active — execution should be deferred.");

      var apps = uniqLower(task.appliances||[]);
      for (var i=0;i<apps.length;i++){ if(!APPLIANCE_KINDS[apps[i]]) issues.push("Unknown appliance: " + apps[i]); }

      // Withhold windows (quiet hours; overnight preheats, etc.)
      var withholds = config.get("meals.withholdWindows", config.withholdWindows || []); // [{from:"22:00",to:"06:00",reason:"quiet-hours"}]
      try{
        var nowD = clock.now(); var hh = nowD.getHours(); var mm = nowD.getMinutes(); var cur = hh*60 + mm;
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

    // ----------------------------- Core: toRunbook -----------------------------
    /**
     * toRunbook(task, opts?)
     * (unchanged API — augmented events + metadata)
     */
    function toRunbook(task, opts){
      opts = opts || {};
      var id    = (task && task.id) || ("cook:" + Math.random().toString(36).slice(2));
      var title = "Cook • " + safeString(task && task.title, "Dish");

      var issues   = validateTask(task);
      var hazards  = detectHazards(task);
      var apps     = uniqLower(task.appliances || []);
      var supplies = buildSupplies(task);

      try{ if(task && task.recipe) reserveRecipeIngredients(task.recipe); }catch(_e){}

      var notices = marinadeOrDefrostNotices(task);
      for (var nn=0; nn<notices.length; nn++) issues.push("Prep: " + notices[nn]);

      var steps = [];

      if(issues.length){
        steps.push({ id:stepId("guard"), label:"Pre-checks & guards", type:"ALERTS", wait:true, issues: issues.slice(0) });
      }

      steps.push({
        id: stepId("mise"),
        label: "Mise en place: wash, chop, measure, label cups/bowls",
        type: "CHECKLIST",
        wait: false,
        checklist: [
          "Wash hands (20s) & sanitize stations",
          "Separate boards for raw & ready-to-eat",
          "Gather tools & set trash bowl",
          "Pre-measure spices, sauces, and liquids"
        ]
      });

      for (var a=0;a<apps.length;a++){
        var ap = apps[a];
        var spec = null;
        try { spec = scheduleHelpers.preheatSpec(ap, task.recipe); } catch(_e){ spec = null; }
        if (APPLIANCE_KINDS[ap] && APPLIANCE_KINDS[ap].supportsPreheat && spec){
          steps.push({
            id: stepId("preheat"),
            label: "Preheat " + APPLIANCE_KINDS[ap].name + " to " + spec.temp + "°F",
            type: "DEVICE",
            device: { kind: ap, action: "preheat", args: { temp: spec.temp } },
            wait: true,
            timer: { minutes: spec.minutes, label: "Preheat ("+spec.minutes+"m)" },
            parallelizable: true,
            emitAsPrepCandidate: true,
            backgroundOK: true
          });
        } else {
          var lbl = (ap === "stovetop") ? "Heat pan: medium-high until shimmering"
                   : (ap === "microwave") ? "Ready microwave-safe vessel"
                   : "Prep " + (APPLIANCE_KINDS[ap] ? APPLIANCE_KINDS[ap].name : ap);
          steps.push({ id: stepId("prime"), label: lbl, type:"MANUAL", wait:false });
        }
      }

      if(hazards.indexOf("hazard/raw-protein")>=0){
        steps.push({
          id: stepId("rawguard"),
          label: "Raw protein handling guard",
          type: "CHECKLIST",
          wait: false,
          checklist: ["Use dedicated raw board & knife","Keep raw away from ready-to-eat","Wipe & sanitize splashes immediately"]
        });
      }

      var cookMins = Number(task && (task.estMinutes || (task.recipe && task.recipe.totalTimeMinutes)) || 30);
      var recipeSteps = (task && task.recipe && task.recipe.steps) || null;

      if (recipeSteps && recipeSteps.length){
        for (var rs=0; rs<recipeSteps.length; rs++){
          var rstep = recipeSteps[rs] || {};
          var typeU = String(rstep.type||"").toUpperCase();
          var step = {
            id: stepId("r"),
            label: safeString(rstep.label, "Step"),
            type: (typeU==="TIMER"||typeU==="DEVICE"||typeU==="CHECKLIST"||typeU==="MANUAL") ? typeU : "MANUAL",
            wait: !!rstep.wait
          };
          if (rstep.minutes){
            step.type = "TIMER";
            step.timer = { minutes: Number(rstep.minutes)||1, label: safeString(rstep.label,"Timer") };
            step.parallelizable = true;
            step.emitAsPrepCandidate = true;
            step.backgroundOK = true;
          }
          if (rstep.checklist && Object.prototype.toString.call(rstep.checklist) === "[object Array]"){
            step.type = "CHECKLIST";
            step.checklist = rstep.checklist.slice(0);
          }
          if (rstep.device) step.device = rstep.device;
          steps.push(step);
        }
      } else {
        steps.push({
          id: stepId("cook"),
          label: "Cook: " + safeString(task && task.title, "Dish"),
          type: "TIMER",
          timer: { minutes: cookMins, label: safeString(task && task.title, "Cook") + " ("+cookMins+"m)" },
          wait: true,
          onDone: [{ type:"NOTE", label:"Check doneness (visual cues) and probe if needed." }],
          parallelizable: true,
          emitAsPrepCandidate: true,
          backgroundOK: true
        });
      }

      var targetF = pickProbeTargetF(task);
      if (targetF){
        steps.push({ id: stepId("probe"), label: "Probe temperature to at least " + targetF + "°F at thickest point", type: "CHECK", wait: false });
      }

      var restMin = 0;
      try { var prot = task && task.recipe && task.recipe.primaryProtein; restMin = scheduleHelpers.restMinutes(prot); } catch(_e){ restMin = 0; }
      if (restMin > 0){
        steps.push({
          id: stepId("rest"),
          label: "Rest meat/fish (" + restMin + "m)",
          type: "TIMER",
          timer: { minutes: restMin, label: "Rest ("+restMin+"m)" },
          wait: true,
          parallelizable: true,
          emitAsPrepCandidate: true,
          backgroundOK: true
        });
      }

      steps.push({ id: stepId("plate"), label: "Plate & garnish (wipe rims, add herbs/sauce)", type:"MANUAL", wait:false });

      var cleanup = [
        { id: stepId("clean1"), label: "Wash knives & boards (separate raw boards last) • hot soapy water", type:"MANUAL", wait:false },
        { id: stepId("clean2"), label: "Sanitize counters & pulls", type:"MANUAL", wait:false },
        { id: stepId("clean3"), label: "Label & store leftovers promptly", type:"MANUAL", wait:false }
      ];

      var logItems = [];

      if (task && task.recipe && task.recipe.ingredients && task.recipe.ingredients.length){
        var invItems = [];
        for (var i=0;i<task.recipe.ingredients.length;i++){
          var ing = task.recipe.ingredients[i] || {};
          invItems.push({ name: String(ing.name||"").toLowerCase(), delta: -(ing.qty || 1), unit: ing.unit || "" });
        }
        logItems.push({ type: "INVENTORY_DELTA", items: invItems });
      }

      if (task && task.recipe && task.recipe.leftoverPolicy && task.recipe.leftoverPolicy.predictsLeftovers){
        logItems.push({ type: "LEFTOVERS_CREATE", servings: task.recipe.leftoverPolicy.leftoverServings || 2, label: safeString(task.title,"Dish") });
      }

      try{
        var n = nutrition.estimate(task && task.recipe);
        if(n){ logItems.push({ type: "NUTRITION_LOG", perServing: { calories:n.calories, protein:n.protein, carbs:n.carbs, fat:n.fat }, servings: n.servings }); }
      } catch(_e){}

      var missing = [];
      try{
        var ings = (task && task.recipe && task.recipe.ingredients) || [];
        for (var m=0;m<ings.length;m++){
          var key = "ing/" + String(ings[m].name||"").toLowerCase();
          if(!tryHas(key)){
            var subs = []; try{ subs = inventory.suggestSub(key) || []; }catch(_e){ subs = []; }
            missing.push({ need: ings[m].name, suggest: subs });
          }
        }
      } catch(_e){}
      if (missing.length){
        steps.unshift({ id: stepId("subs"), label: "Substitution review", type: "NOTE", wait: true, missing: missing });
      }

      var estimatedMinutes = Number(task && task.estMinutes || (task && task.recipe && task.recipe.totalTimeMinutes) || 30);
      var estimatedCost = 0;
      try{
        estimatedCost = Number(estimate.cookingCost({
          ingredients: (task && task.recipe && task.recipe.ingredients) || [],
          supplies: supplies,
          appliances: apps,
          hazards: hazards,
          estimatedMinutes: estimatedMinutes,
          dish: task && task.title
        })) || 0;
      } catch(_e){ estimatedCost = 0; }

      var runbook = {
        id: id,
        sessionId: opts.sessionId || null,
        title: title,
        domain: "meals",
        priority: (task && task.priority) || "normal",
        estimatedMinutes: estimatedMinutes,
        estimatedCost: estimatedCost,
        hazards: hazards,
        supplies: supplies,
        steps: steps,
        cleanup: cleanup,
        logging: logItems,
        ppe: (hazards.indexOf("hazard/hot-oil")>=0) ? ["gloves","eye-protection"] : ["gloves"],
        guards: { sabbathActive: isSabbathGuardActive() },
        meta: {
          appliances: apps,
          probeTargetF: targetF,
          notes: safeString(task && task.notes, ""),
          background: !!opts.background,
          source: "cookingExecutor",
          resumeState: opts.resumeState || null
        }
      };

      // ----------------------------- Orchestration Hooks ------------------------
      try{
        if(runbook.guards.sabbathActive){
          eventBus.emit("guard:sabbath", { runbookId:id, title:title, when: clock.now().toISOString(), domain:"meals" });
        }

        for (var s=0; s<steps.length; s++){
          var st = steps[s];
          if(st && st.type==="TIMER"){
            var minutes = (st.timer && st.timer.minutes) || 0;
            if(st.emitAsPrepCandidate){
              var win = { minutes: minutes, label: st.label, domain:"meals", area: safeString(task && task.title, "Dish"), runbookId: id };
              eventBus.emit("prep:candidate", win);
              prepBus.emitCandidate({ minutes: minutes, label: st.label, domain:"meals", area: win.area });
            }
            if(st.backgroundOK && minutes>0){
              scheduleTimerReminder(id, st, minutes);
              nba.upsert({ kind:"window", domain:"meals", runbookId:id, stepId:st.id, label:"Use wait window wisely", priority:"info" });
            }
          }
        }

        eventBus.emit("runbook:created", { runbook: runbook });
        analytics.track("runbook/built", {
          domain: "meals",
          appliances: apps,
          hazards: hazards,
          minutes: runbook.estimatedMinutes,
          estCost: estimatedCost,
          leftovers: !!(task && task.recipe && task.recipe.leftoverPolicy && task.recipe.leftoverPolicy.predictsLeftovers),
          priority: runbook.priority
        });
      } catch(_e){}

      try{ if(task && task.recipe) commitRecipeIngredients(task.recipe); }catch(_e){}

      return runbook;
    }

    // ----------------------------- Runner: emits step:start/complete ---------
    /**
     * makeRunner(input, opts?)
     *  - input: runbook OR task (same shape as toRunbook)
     *  - opts: { sessionId?, resumeIndex? }
     * Returns controls: { start(), startStep(idOrIndex), completeStep(idOrIndex), pause(reason?), resume(), abort() }
     */
    function makeRunner(input, opts){
      var runbook = (input && input.steps) ? input : toRunbook(input, opts || {});
      var idx = Math.max(0, Number((opts && opts.resumeIndex) || 0));
      var sessionId = runbook.sessionId || ("meals-" + Math.random().toString(36).slice(2,8));

      function coerceIndex(idOrIndex){
        if (typeof idOrIndex === "number") return Math.max(0, Math.min(runbook.steps.length-1, idOrIndex));
        var i; for (i=0;i<runbook.steps.length;i++){ if (runbook.steps[i].id === idOrIndex) return i; }
        return idx;
      }

      function blockedByGuards(){
        if (runbook.guards && runbook.guards.sabbathActive) return { blocked:true, reason:"sabbath" };
        // Also respect withhold windows (quiet hours)
        var issues = validateTask({ title: runbook.title, appliances: runbook.meta && runbook.meta.appliances || [] });
        for (var j=0;j<issues.length;j++){
          if (String(issues[j]).toLowerCase().indexOf("withhold window")>=0){
            return { blocked:true, reason:"quiet-hours" };
          }
        }
        return { blocked:false };
      }

      function emitStepStart(i){
        var st = runbook.steps[i];
        eventBus.emit("cooking:step:start", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "meals", index: i });
        analytics.track("cook/step/start", { step: st.label, index: i, runbookId: runbook.id });
      }

      function emitStepComplete(i){
        var st = runbook.steps[i];
        eventBus.emit("cooking:step:complete", { sessionId: sessionId, runbookId: runbook.id, stepId: st.id, index: i, label: st.label, at: clock.now().toISOString() });
        analytics.track("cook/step/complete", { step: st.label, index: i, runbookId: runbook.id });
      }

      function start(){
        var g = blockedByGuards();
        if (g.blocked){
          var reason = g.reason === "sabbath" ? "sabbath" : "quiet-hours";
          eventBus.emit("session:paused", { sessionId: sessionId, domain: "meals", reason: reason });
          return { ok:false, blocked:true, reason: reason };
        }
        eventBus.emit("session:created", { sessionId: sessionId, domain: "meals", title: runbook.title, steps: runbook.steps, startedAt: clock.now().toISOString() });
        analytics.track("cook/session/start", { runbookId: runbook.id, steps: runbook.steps.length });
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
          eventBus.emit("session:ended", { sessionId: sessionId, domain: "meals", finishedAt: clock.now().toISOString() });
          analytics.track("cook/session/end", { runbookId: runbook.id });
        }
        return { ok:true, index: idx };
      }

      function pause(reason){
        eventBus.emit("session:paused", { sessionId: sessionId, domain: "meals", reason: reason || "user" });
        return { ok:true };
      }
      function resume(){
        eventBus.emit("session:resumed", { sessionId: sessionId, domain: "meals" });
        eventBus.emit("session:step:changed", { sessionId: sessionId, domain: "meals", index: idx });
        return { ok:true, index: idx };
      }
      function abort(){
        eventBus.emit("session:ended", { sessionId: sessionId, domain: "meals", aborted: true, finishedAt: clock.now().toISOString() });
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
        domain: "meals",
        title: safeString(payload.title, "Meal Session"),
        templateId: payload.templateId || "",
        steps: payload.steps || [],
        createdAt: clock.now().toISOString(),
        updatedAt: Date.now(),
        meta: { source: "user" }
      };
      var viaHook = favorites && typeof favorites.save === "function";
      if (viaHook) {
        return favorites.save(fav).then(function(res){
          if (res && res.ok){ eventBus.emit("favorites:changed", { domain: "meals" }); }
          return res || { ok:false };
        });
      }
      var res = lsSave("meals:favorites", fav, "id");
      if (res.ok) eventBus.emit("favorites:changed", { domain: "meals" });
      return Promise.resolve(res);
    }

    function saveScheduleTemplate(payload){
      var sched = {
        id: "sched-" + Math.random().toString(36).slice(2,10),
        domain: "meals",
        title: safeString(payload.title, "Meal Schedule"),
        sessionTemplate: { templateId: payload.templateId || "", steps: payload.steps || [] },
        rrule: payload.rrule || "FREQ=WEEKLY;BYDAY=MO",
        firstRunAt: safeString(payload.firstRunAtISO, clock.now().toISOString())
      };
      var viaHook = schedules && typeof schedules.save === "function";
      var onOk = function(ok){
        if (ok) {
          eventBus.emit("schedules:changed", { domain: "meals" });
          try {
            automation.scheduleAt(sched.firstRunAt, { kind:"session", domain:"meals", title:sched.title, rrule:sched.rrule, sessionTemplate: sched.sessionTemplate });
          } catch(_e){}
        }
      };
      if (viaHook) {
        return schedules.save(sched).then(function(res){ onOk(res && res.ok); return res || { ok:false }; });
      }
      var res = lsSave("meals:schedules", sched, "id");
      onOk(res.ok);
      return Promise.resolve(res);
    }

    // ----------------------------- Public API ---------------------------------
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
  var defaultExecutor = createCookingExecutor({});

  module.exports = {
    createCookingExecutor: createCookingExecutor,
    toRunbook: defaultExecutor.toRunbook,
    validateTask: defaultExecutor.validateTask,
    makeRunner: defaultExecutor.makeRunner,
    saveFavoriteSession: defaultExecutor.saveFavoriteSession,
    saveScheduleTemplate: defaultExecutor.saveScheduleTemplate
  };
})();

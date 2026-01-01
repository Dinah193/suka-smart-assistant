/* eslint-disable no-console */
/**
 * SafetyRules.js — centralized safety advisories & withhold windows (ES2015-safe)
 *
 * Goals
 *  • One source of truth for PPE, biohazard, allergen, temp control, chemical, animal welfare, weather & withhold logic
 *  • Domain-aware defaults (meals, cleaning, animals, garden)
 *  • Pure evaluator: returns advisories (no event side-effects)
 *  • Suggestions shaped for orchestration: can emit known events (prep.tasks.requested, planner.alternate.requested)
 *  • Registry pattern for composable/override-able rules
 *
 * Advisory shape:
 * {
 *   id: string,
 *   domain: "meals"|"cleaning"|"animals"|"garden",
 *   kind: "biohazard"|"chemical"|"allergen"|"temperature"|"withhold"|"ppe"|"weather"|"animal_welfare",
 *   level: "low"|"medium"|"high"|"critical",
 *   title: string,
 *   rationale: string,
 *   affected: string[]        // item ids
 *   ppe?: string[],           // recommended PPE labels
 *   withhold?: { start:number, end:number, kind:string, reason:string },
 *   suggestions?: [
 *     { title, autoApply:boolean, intent:"patch"|"option", emit?:{name,payload}, patch?:(plan)=>Patch }
 *   ],
 *   meta?: object
 * }
 */

(function(){
  /* ----------------------------- Safe Imports ----------------------------- */
  var scheduleHelpers = {
    now: function(){ return Date.now(); },
    shiftWindow: function(win, mins){ return !win ? null : { start: win.start + mins*60000, end: win.end + mins*60000 }; }
  };
  try { scheduleHelpers = require("@/engines/schedule/scheduleHelpers") || scheduleHelpers; } catch (e) {}

  var estimateEngine = { estimate: function(){ return {}; } };
  try { estimateEngine = require("@/engines/estimates/estimateEngine") || estimateEngine; } catch (e) {}

  /* ------------------------------- Catalogs -------------------------------- */
  var DOMAINS = { meals:"meals", cleaning:"cleaning", animals:"animals", garden:"garden" };

  // Lightweight PPE catalog (extend as needed)
  var PPE = {
    gloves: "Disposable Gloves",
    heatGloves: "Heat-Resistant Gloves",
    eye: "Safety Glasses",
    faceShield: "Face Shield",
    mask: "Dust Mask / Respirator",        // flour dust, sanding, lime, etc.
    apron: "Apron",
    cut: "Cut-Resistant Gloves",
    boot: "Non-Slip Boots",
    hearing: "Hearing Protection"
  };

  // Temperature guidance (kitchen) — conservative defaults
  var TEMP = {
    coldMaxF: 41,             // ≤41°F cold hold
    coolTo70WithinMin: 120,   // 2 hours to 70°F
    coolTo41WithinMin: 240,   // 4 more hours to 41°F
    poultryMinF: 165,
    groundMeatMinF: 160,
    wholeCutsMinF: 145,
    fishEggsMinF: 145
  };

  // Animal welfare generic defaults (non-prescriptive; tune per species)
  var ANIMAL = {
    fastingBeforeButcheryHours: 12,
    restAfterVaccinationHours: 24,
    milkWithdrawalDefaultHours: 72,
    meatWithdrawalDefaultDays: 10
  };

  // Garden chemical defaults (fallbacks if REI not provided)
  var GARDEN = {
    defaultREIHours: 12      // Re-Entry Interval
  };

  /* ------------------------------ Utilities -------------------------------- */
  function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
  function asWindow(item){
    if (item && item.timeWindow && typeof item.timeWindow.start === "number" && typeof item.timeWindow.end === "number") return item.timeWindow;
    if (item && item.start && item.durationMin) return { start: item.start, end: item.start + item.durationMin * 60000 };
    return null;
  }
  function mkId(parts){ return parts.filter(Boolean).join(":"); }

  function levelFromScore(score){
    if (score >= 85) return "critical";
    if (score >= 65) return "high";
    if (score >= 45) return "medium";
    return "low";
  }

  /* ----------------------------- Rule Registry ----------------------------- */
  // Rule: (ctx) => Advisory[] where ctx = { domain, plan, items, options }
  var registry = Object.create(null);
  function registerRule(name, fn){ registry[name] = fn; }
  function listRules(){ return Object.keys(registry); }

  /* ---------------------------- Core Evaluations --------------------------- */

  // 1) Cross-contamination (raw → ready-to-eat without sanitation in-between)
  registerRule("meals.crossContamination", function(ctx){
    if (ctx.domain !== DOMAINS.meals && ctx.domain !== DOMAINS.animals) return [];
    var items = ctx.items || [];
    var out = [];

    // naive scan: find raw meat/fish/poultry tasks followed by RTE tasks on same surface/resource
    for (var i=0;i<items.length;i++){
      var a = items[i];
      if (!a || !a.tags) continue;
      var isRaw = (a.tags.indexOf("raw-meat")>=0) || (a.tags.indexOf("butchery")>=0) || (a.tags.indexOf("poultry-raw")>=0);
      if (!isRaw) continue;

      var res = (a.resources || []).find(function(r){ return /board|table|sink|counter/i.test(r); });
      if (!res) continue;

      for (var j=0;j<items.length;j++){
        if (i===j) continue;
        var b = items[j];
        if (!b || !b.tags) continue;
        var isRTE = (b.tags.indexOf("rte")>=0) || (b.tags.indexOf("salad")>=0) || (b.tags.indexOf("plating")>=0);
        if (!isRTE) continue;

        var resB = (b.resources || []).find(function(r){ return String(r).toLowerCase() === String(res).toLowerCase(); });
        if (!resB) continue;

        // check time order (same or later)
        var wa = asWindow(a), wb = asWindow(b);
        if (!wa || !wb || wb.start < wa.start) continue;

        var id = mkId(["biohazard", a.id, b.id, res]);
        var adv = {
          id: id,
          domain: ctx.domain,
          kind: "biohazard",
          level: "high",
          title: "Cross-contamination risk on shared surface",
          rationale: "Raw proteins scheduled before ready-to-eat on the same surface without a sanitation buffer.",
          affected: [a.id, b.id],
          ppe: [PPE.gloves],
          suggestions: [
            {
              title: "Insert sanitation step between tasks",
              autoApply: false,
              intent: "option",
              emit: { name: "prep.tasks.requested", payload: { domain: ctx.domain, tasks: ["Sanitize shared surface", "Wash hands", "Swap cutting board"] } }
            }
          ],
          meta: { resource: res }
        };
        out.push(adv);
      }
    }
    return out;
  });

  // 2) Temperature control & cooling curve (meals, animals → chilling)
  registerRule("meals.temperatureControl", function(ctx){
    if (ctx.domain !== DOMAINS.meals && ctx.domain !== DOMAINS.animals) return [];
    var items = ctx.items || [];
    var out = [];

    for (var i=0;i<items.length;i++){
      var it = items[i];
      var tags = it.tags || [];
      var cooking = tags.indexOf("cook")>=0 || tags.indexOf("butchery-cool")>=0 || tags.indexOf("stock-cool")>=0;
      if (!cooking) continue;

      var id = mkId(["temperature", it.id]);
      var rationale = "Hot food must cool from 135°F→70°F within 2h and to ≤41°F within 6h total. Use shallow pans/ice bath and vented storage.";
      var adv = {
        id: id,
        domain: ctx.domain,
        kind: "temperature",
        level: "high",
        title: "Cooling time/temperature control required",
        rationale: rationale,
        affected: [it.id],
        ppe: [PPE.gloves],
        suggestions: [
          {
            title: "Add cooling reminders (2h/6h checkpoints)",
            autoApply: false,
            intent: "option",
            emit: { name: "prep.tasks.requested", payload: { domain: ctx.domain, tasks: ["Cooling check: ≤70°F by 2h", "Cooling check: ≤41°F by 6h"] } }
          }
        ],
        meta: { coolTargets: { to70Min: TEMP.coolTo70WithinMin, to41Min: TEMP.coolTo41WithinMin } }
      };
      out.push(adv);
    }
    return out;
  });

  // 3) Allergen separation (meals: wheat/gluten, dairy, eggs, nuts; includes flour dust)
  registerRule("meals.allergens", function(ctx){
    if (ctx.domain !== DOMAINS.meals) return [];
    var items = ctx.items || [];
    var out = [];
    var allergenMap = {
      gluten: /flour|wheat|bread|pasta|dough/i,
      dairy: /milk|cheese|butter|cream|yogurt/i,
      egg: /egg/i,
      nuts: /almond|peanut|walnut|pecan|hazelnut|nut/i
    };

    for (var i=0;i<items.length;i++){
      var it = items[i];
      var title = it.title || "";
      var matchesGluten = allergenMap.gluten.test(title) || (it.tags||[]).indexOf("gluten")>=0;
      var flourDust = /flour|mill|grind/i.test(title) || (it.tags||[]).indexOf("fresh-milled")>=0;
      if (matchesGluten) {
        out.push({
          id: mkId(["allergen", "gluten", it.id]),
          domain: ctx.domain,
          kind: "allergen",
          level: "medium",
          title: "Gluten handling — prevent cross-contact",
          rationale: "Plan includes gluten ingredients. Use dedicated tools or sanitize before non-gluten prep.",
          affected: [it.id],
          ppe: flourDust ? [PPE.mask, PPE.apron] : [PPE.apron],
          suggestions: [
            {
              title: "Add ‘gluten first’ then sanitize",
              autoApply: false,
              intent: "option",
              emit: { name: "prep.tasks.requested", payload: { domain: ctx.domain, tasks: ["Handle gluten tasks up front", "Thorough sanitize before RTE"] } }
            }
          ]
        });
      }
      if (flourDust) {
        out.push({
          id: mkId(["ppe","flour-dust", it.id]),
          domain: ctx.domain,
          kind: "ppe",
          level: "medium",
          title: "Airborne flour dust — wear a mask",
          rationale: "Fresh-milled whole grain flour can aerosolize; use a dust mask/respirator and good ventilation.",
          affected: [it.id],
          ppe: [PPE.mask, PPE.eye]
        });
      }
      ["dairy","egg","nuts"].forEach(function(k){
        if (allergenMap[k].test(title) || (it.tags||[]).indexOf(k)>=0) {
          out.push({
            id: mkId(["allergen", k, it.id]),
            domain: ctx.domain,
            kind: "allergen",
            level: "medium",
            title: "Allergen handling — " + k,
            rationale: "Separate tools/containers and sanitize before/after to avoid cross-contact.",
            affected: [it.id],
            ppe: [PPE.apron, PPE.gloves]
          });
        }
      });
    }
    return out;
  });

  // 4) Chemical incompatibilities (cleaning)
  registerRule("cleaning.chemicals", function(ctx){
    if (ctx.domain !== DOMAINS.cleaning) return [];
    var items = ctx.items || [];
    var out = [];
    var badCombos = [
      { a:/bleach/i, b:/ammonia|ammonium|urine/i, title:"Never mix bleach and ammonia", note:"Mixing creates chloramines, causing respiratory injury." },
      { a:/bleach/i, b:/vinegar|acid/i, title:"Avoid bleach + acid", note:"Chlorine gas can form when bleach contacts acids." }
    ];

    items.forEach(function(it){
      var title = it.title || "";
      for (var i=0;i<badCombos.length;i++){
        var bc = badCombos[i];
        if (bc.a.test(title) && bc.b.test(title)) {
          out.push({
            id: mkId(["chemical", it.id, String(i)]),
            domain: ctx.domain,
            kind: "chemical",
            level: "critical",
            title: bc.title,
            rationale: bc.note,
            affected: [it.id],
            ppe: [PPE.gloves, PPE.eye, PPE.mask],
            suggestions: [
              { title: "Switch to single-agent clean", autoApply: false, intent: "option", emit: { name: "planner.alternate.requested", payload: { items: [it.id] } } }
            ]
          });
        }
      }
      // Chemical dwell/ventilation PPE
      if (/disinfect|sanitize|acid|alkaline|degreaser/i.test(title)) {
        out.push({
          id: mkId(["ppe","chem", it.id]),
          domain: ctx.domain,
          kind: "ppe",
          level: "medium",
          title: "Use appropriate PPE for chemicals",
          rationale: "Chemical agents may irritate skin, eyes, and lungs; ensure gloves, eye protection, and ventilation.",
          affected: [it.id],
          ppe: [PPE.gloves, PPE.eye, PPE.mask]
        });
      }
    });
    return out;
  });

  // 5) Withhold windows (marinate, proof, cure, chemical REI, animal meds withdrawal)
  registerRule("shared.withholds", function(ctx){
    var items = ctx.items || [];
    var out = [];
    var now = scheduleHelpers.now ? scheduleHelpers.now() : Date.now();

    items.forEach(function(it){
      var tags = it.tags || [];
      var win = asWindow(it) || { start: it.start || now, end: (it.start||now) + (it.durationMin||0)*60000 };

      // Meals: marinating, proofing, curing
      if (tags.indexOf("marinate")>=0) {
        var dur = it.durationMin || 60;
        out.push({
          id: mkId(["withhold","marinate", it.id]),
          domain: DOMAINS.meals,
          kind: "withhold",
          level: levelFromScore(clamp(dur/2, 30, 80)),
          title: "Marinating period in progress",
          rationale: "Do not proceed to cook until marination completes.",
          affected: [it.id],
          withhold: { start: win.end - dur*60000, end: win.end, kind: "marinate", reason: "Flavor/safety dwell time" },
          suggestions: [
            { title: "Queue ‘start cook’ reminder", autoApply: false, intent: "option", emit: { name: "prep.tasks.requested", payload: { domain: DOMAINS.meals, tasks: ["Reminder: Begin cook after marinade time"] } } }
          ]
        });
      }
      if (tags.indexOf("proof")>=0 || /dough/i.test(it.title||"")) {
        var pdur = it.durationMin || 45;
        out.push({
          id: mkId(["withhold","proof", it.id]),
          domain: DOMAINS.meals,
          kind: "withhold",
          level: levelFromScore(clamp(pdur/2, 25, 70)),
          title: "Dough proofing",
          rationale: "Allow dough to proof; avoid drafts; check volume increase.",
          affected: [it.id],
          withhold: { start: win.start, end: win.end, kind: "proof", reason: "Gluten development / fermentation" },
          ppe: [PPE.apron]
        });
      }
      if (tags.indexOf("cure")>=0 || /curing|brining/i.test(it.title||"")) {
        var cdur = it.durationMin || 1440;
        out.push({
          id: mkId(["withhold","cure", it.id]),
          domain: ctx.domain || DOMAINS.meals,
          kind: "withhold",
          level: "high",
          title: "Curing/brining dwell",
          rationale: "Maintain safe temps and salinity during cure/brine.",
          affected: [it.id],
          withhold: { start: win.start, end: win.end, kind: "cure", reason: "Cure/brine dwell" },
          ppe: [PPE.gloves]
        });
      }

      // Cleaning: chemical REI (re-entry interval)
      if ((ctx.domain === DOMAINS.cleaning || ctx.domain === DOMAINS.garden) && (/disinfect|sanitize|pesticide|herbicide/i.test(it.title||"") || tags.indexOf("chemical")>=0)) {
        var reiHours = it.reiHours || GARDEN.defaultREIHours;
        var reiEnd = (it.start || now) + reiHours*3600*1000;
        out.push({
          id: mkId(["withhold","rei", it.id]),
          domain: ctx.domain,
          kind: "withhold",
          level: "medium",
          title: "Re-entry interval (REI)",
          rationale: "Avoid contact until chemicals have dried/dissipated per label or REI period ends.",
          affected: [it.id],
          withhold: { start: it.start || now, end: reiEnd, kind: "chemical", reason: "REI" },
          ppe: [PPE.gloves, PPE.eye, PPE.mask]
        });
      }

      // Animals: medication withdrawal windows (generic fallback)
      if (ctx.domain === DOMAINS.animals && (tags.indexOf("medication")>=0 || /deworm|antibiotic|vaccine/i.test(it.title||""))) {
        var milkEnd = (it.start || now) + (ANIMAL.milkWithdrawalDefaultHours*3600*1000);
        var meatEnd = (it.start || now) + (ANIMAL.meatWithdrawalDefaultDays*24*3600*1000);
        out.push({
          id: mkId(["withhold","animal-med", it.id]),
          domain: ctx.domain,
          kind: "withhold",
          level: "high",
          title: "Medication withdrawal period",
          rationale: "Do not use milk/meat for human consumption until withdrawal periods end.",
          affected: [it.id],
          withhold: { start: it.start || now, end: Math.max(milkEnd, meatEnd), kind: "medication", reason: "Residue avoidance" },
          ppe: [PPE.gloves]
        });
      }
    });
    return out;
  });

  // 6) Animal welfare: fasting & post-procedure rest
  registerRule("animals.welfare", function(ctx){
    if (ctx.domain !== DOMAINS.animals) return [];
    var items = ctx.items || [];
    var out = [];
    items.forEach(function(it){
      var tags = it.tags || [];
      if (tags.indexOf("butchery")>=0 || /slaughter|butcher/i.test(it.title||"")) {
        out.push({
          id: mkId(["animal_welfare","fasting", it.id]),
          domain: ctx.domain,
          kind: "animal_welfare",
          level: "medium",
          title: "Pre-butchery fasting window",
          rationale: "Withhold feed for ~" + ANIMAL.fastingBeforeButcheryHours + "h to reduce contamination risk.",
          affected: [it.id],
          suggestions: [
            { title: "Add ‘feed withhold’ reminder", autoApply: false, intent: "option", emit: { name: "prep.tasks.requested", payload: { domain: ctx.domain, tasks: ["Withhold feed before butchery (~12h)"] } } }
          ]
        });
      }
      if (tags.indexOf("vaccination")>=0) {
        out.push({
          id: mkId(["animal_welfare","rest", it.id]),
          domain: ctx.domain,
          kind: "animal_welfare",
          level: "low",
          title: "Post-vaccination rest/monitor",
          rationale: "Allow animals to rest and monitor for adverse reactions for ~" + ANIMAL.restAfterVaccinationHours + "h.",
          affected: [it.id]
        });
      }
    });
    return out;
  });

  // 7) Weather exposure → hydration breaks / heat/cold plan (outdoor tasks)
  registerRule("shared.weatherPPE", function(ctx){
    var items = ctx.items || [];
    var out = [];
    var weather = (ctx.options && ctx.options.weather) || {};
    var heatIndex = weather.heatIndex || weather.apparentTempF || null;

    items.forEach(function(it){
      if (it.indoor === true) return;
      var title = it.title || "";
      if (!/harvest|dig|till|clean|butcher|cook|smoke|grill|repair|construction/i.test(title) && !(it.tags||[]).some(function(t){return /outdoor|field|pen|barn/i.test(t);})) return;

      var level = "low";
      var ppe = [PPE.gloves, PPE.boot];
      var rationale = "Outdoor task — prepare hydration and sun/heat or cold protection.";
      if (typeof heatIndex === "number") {
        if (heatIndex >= 90 && heatIndex < 100) { level = "medium"; }
        else if (heatIndex >= 100) { level = "high"; }
      }
      out.push({
        id: mkId(["weather","ppe", it.id]),
        domain: ctx.domain || DOMAINS.garden,
        kind: "weather",
        level: level,
        title: "Weather exposure — plan PPE & breaks",
        rationale: rationale,
        affected: [it.id],
        ppe: ppe,
        suggestions: [
          { title: "Add hydration/rest breaks", autoApply: false, intent: "option", emit: { name: "prep.tasks.requested", payload: { domain: ctx.domain || DOMAINS.garden, tasks: ["Hydration break every 30–45 min", "Shade / cooling plan"] } } }
        ]
      });
    });
    return out;
  });

  /* -------------------------- Public Evaluators ---------------------------- */

  /**
   * evaluateItems(items, domain, options) -> Advisory[]
   * items: array of plan items (id, title, start, durationMin, timeWindow?, tags[], resources[], indoor?)
   * domain: one of DOMAINS
   * options: { weather?, user? }
   */
  function evaluateItems(items, domain, options){
    domain = DOMAINS[domain] ? domain : DOMAINS.meals;
    var ctx = { domain: domain, plan: null, items: items || [], options: options || {} };
    var out = [];
    var names = listRules();
    for (var i=0;i<names.length;i++){
      try {
        var fn = registry[names[i]];
        var adds = fn ? (fn(ctx) || []) : [];
        for (var j=0;j<adds.length;j++){
          var adv = adds[j];
          // normalize minimal fields
          adv.domain = domain;
          adv.level = adv.level || "low";
          adv.kind = adv.kind || "ppe";
          adv.title = adv.title || "Safety advisory";
          adv.affected = adv.affected || [];
          out.push(adv);
        }
      } catch (e) {
        console.warn("[SafetyRules] rule failed:", names[i], e && e.message);
      }
    }
    return out;
  }

  /**
   * evaluatePlan(plan, options) -> { advisories, withholds }
   * plan: { id, domain, items:[] }
   */
  function evaluatePlan(plan, options){
    plan = plan || { items: [], domain: DOMAINS.meals };
    var advisories = evaluateItems(plan.items || [], plan.domain, options);
    var withholds = advisories.filter(function(a){ return a.kind === "withhold" && a.withhold; })
                              .map(function(a){ return Object.assign({ itemId: (a.affected||[])[0] }, a.withhold); });
    return { advisories: advisories, withholds: withholds };
  }

  /* ------------------------- SafetyAdvisor compatibility ------------------- */
  // These methods mirror what ConflictHeuristics expects from a SafetyAdvisor.

  // assessBiohazard(item, plan) -> { level:"low|medium|high", reasons:string[] }
  function assessBiohazard(item, plan){
    var res = evaluateItems([item], (plan && plan.domain) || DOMAINS.meals, {});
    var bio = res.filter(function(a){ return a.kind === "biohazard"; });
    if (!bio.length) return { level: "low", reasons: [] };
    // take the worst
    bio.sort(function(a,b){ var L = ["low","medium","high","critical"]; return L.indexOf(b.level)-L.indexOf(a.level); });
    return { level: bio[0].level, reasons: [bio[0].rationale || bio[0].title] };
  }

  // withholdWindows(items, plan) -> Array<{ itemId, start, end, kind, reason }>
  function withholdWindows(items, plan){
    var res = evaluateItems(items, (plan && plan.domain) || DOMAINS.meals, {});
    return res.filter(function(a){ return a.kind === "withhold" && a.withhold; })
              .map(function(a){
                return Object.assign({ itemId: (a.affected||[])[0] }, a.withhold);
              });
  }

  // getPPEFor(item, domain) -> string[]
  function getPPEFor(item, domain){
    var res = evaluateItems([item], domain || DOMAINS.meals, {});
    var ppeSet = Object.create(null);
    res.forEach(function(a){ (a.ppe||[]).forEach(function(p){ ppeSet[p] = true; }); });
    return Object.keys(ppeSet);
  }

  /* ---------------------------------- API ---------------------------------- */
  var api = {
    evaluateItems: evaluateItems,
    evaluatePlan: evaluatePlan,
    assessBiohazard: assessBiohazard,
    withholdWindows: withholdWindows,
    getPPEFor: getPPEFor,
    registerRule: registerRule,
    listRules: listRules,
    catalogs: { PPE: PPE, TEMP: TEMP, ANIMAL: ANIMAL, GARDEN: GARDEN, DOMAINS: DOMAINS }
  };

  /* ---------------------------- Export (CJS/UMD) --------------------------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof define === "function" && define.amd) {
    // eslint-disable-next-line no-undef
    define(function(){ return api; });
  } else {
    // eslint-disable-next-line no-undef
    this.SafetyRules = api;
  }
}).call(typeof global !== "undefined" ? global : (typeof window !== "undefined" ? window : this));

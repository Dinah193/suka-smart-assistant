// usePrepConsolidation.js
// [NEW] Expose batch-prep proposals from cross-domain "prep candidates".
// ES2015-safe, dependency-light, DI-friendly.

import { useCallback, useMemo, useRef, useState } from "react";

/**
 * Candidate shape (normalized)
 * Emitted upstream by executors as `prep:candidate` or added manually:
 * {
 *   id: string,
 *   domain: "meals"|"cleaning"|"garden"|"laundry"|"other",
 *   label: string,                        // e.g., "Marinate chicken (30m)"
 *   windowMinutes: number,                // dwell/marinade/preheat/rest/etc.
 *   whenISO?: string,                     // optional anchor time
 *   dateISO?: string,                     // for clustering by day
 *   area?: string,                        // e.g., "Kitchen", "Bathroom"
 *   tags?: string[],                      // ["marinade","chop","soak","dwell","proof","preheat"]
 *   appliances?: string[],                // e.g., ["oven","stovetop"]
 *   ingredients?: Array<{name, qty, unit}>,
 *   tools?: string[],                     // ["sheet pan", "mixing bowl"]
 *   relatedId?: string,                   // recipeId or runbookId
 *   priority?: "low"|"normal"|"high"
 * }
 */

/**
 * Proposal shape (output)
 * {
 *   id, title, dateISO, durationMinutes, slots:[{ label, minutes, candidateIds:[] }],
 *   groups:[{ key, title, items:[candidateIds...] }],
 *   resources: { appliances: string[], tools: string[] },
 *   impact: { mealsAffected:number, minutesSaved:number, inventoryShortageFrac:number, estCost?:{total, currency} },
 *   safetyFlags: string[],      // e.g., ["raw-protein","allergen/cross-contact","sabbath"]
 *   conflicts: string[],        // e.g., ["appliance conflict: oven"]
 *   checklist: string[],        // linear checklist for UI export/print
 *   groceryHints: Array<{name, qty, unit}>,
 *   accepts: { suggestWindows: Array<{id,label,minutes,startISO?,endISO?}> }
 * }
 */

export function createPrepConsolidation(deps = {}) {
  const clock     = deps.clock     || { now: function () { return new Date(); } };
  const config    = deps.config    || { get: function (_p, fb) { return fb; }, sabbathGuard: { enabled:false } };
  const analytics = deps.analytics || { track: function () {} };
  const eventBus  = deps.eventBus  || { emit: function () {} };
  const scheduler = deps.scheduler || {
    windowsForDay: function () { return []; },
    scheduleBlock: function (_payload) {}
  };
  const inventory = deps.inventory || {
    has: function () { return false; },
    estimateShortage: function () { return { have:0, short:0 }; }
  };
  const estimateEngine = deps.estimateEngine || { cost: function () { return null; } };
  const allergens = deps.allergens || { detectNames: function () { return []; } }; // detectNames(listOfNames)->[tags]
  const mapping = deps.mapping || { shortageRatio: function () { return 0; } };

  // ---- helpers ---------------------------------------------------------------

  function uuid(prefix){ return (prefix||"id") + "-" + Math.random().toString(36).slice(2, 9); }
  function toLower(x){ return String(x||"").toLowerCase(); }
  function safeNum(x, fb){ var n = Number(x); return isFinite(n) ? n : (fb || 0); }
  function coerceDateISO(d){ return (d || clock.now()).toISOString().slice(0,10); }

  function isSabbathGuardActive() {
    var sg = config.sabbathGuard || (config.get && config.get("sabbath.guard", { enabled:false }));
    if (!sg || !sg.enabled) return false;
    try {
      var now = clock.now();
      var day = now.getDay();
      var start = sg.start || "Fri 18:00";
      var end   = sg.end   || "Sat 19:00";
      function parseBoundary(s) {
        var parts = s.split(" "); var wday = parts[0]; var hm = parts[1];
        var map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
        var targetD = map[wday];
        var base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0,0,0,0);
        var delta = targetD - day;
        var target = new Date(base.getTime() + delta*24*60*60*1000);
        var hmParts = hm.split(":"); target.setHours(Number(hmParts[0]||0)); target.setMinutes(Number(hmParts[1]||0));
        return target;
      }
      var s = parseBoundary(start); var e = parseBoundary(end);
      if (e < s) e = new Date(e.getTime() + 7*24*60*60*1000);
      return (now >= s && now <= e);
    } catch (_e) { return false; }
  }

  function normalizeCandidate(c) {
    var dateISO = c.dateISO || (c.whenISO ? String(c.whenISO).slice(0,10) : coerceDateISO());
    var tags = (c.tags || []).map(toLower);
    return Object.assign({
      id: uuid("prep"),
      priority: "normal",
      domain: "meals",
      dateISO: dateISO,
      tags: tags,
      appliances: (c.appliances || []).map(toLower),
      tools: (c.tools || []),
      ingredients: (c.ingredients || [])
    }, c);
  }

  function classifyBucket(c) {
    var tags = c.tags || [];
    if (tags.indexOf("marinade")>=0) return "marinade";
    if (tags.indexOf("chop")>=0 || /chop|dice|slice|prep/.test(toLower(c.label))) return "knife-prep";
    if (tags.indexOf("soak")>=0) return "soak";
    if (tags.indexOf("dwell")>=0) return "dwell";
    if (tags.indexOf("proof")>=0) return "proof";
    if (tags.indexOf("preheat")>=0) return "preheat";
    if (c.domain === "cleaning") return "cleaning-window";
    if (c.domain === "garden") return "wash-dry";
    return "misc";
  }

  function detectSafetyFlags(items) {
    var flags = [];
    // raw protein heuristic
    var names = [];
    for (var i=0;i<items.length;i++){
      var ing = items[i].ingredients || [];
      for (var j=0;j<ing.length;j++){ names.push(toLower(ing[j].name || "")); }
    }
    try {
      var tags = allergens.detectNames(names) || [];
      for (var t=0;t<tags.length;t++) flags.push("allergen/" + toLower(tags[t]));
    } catch (_e) {}
    // marinade + room temp risk
    var marinade = items.some(function (x){ return (x.tags||[]).indexOf("marinade")>=0; });
    if (marinade) flags.push("food-safety/marinade-refrigeration");
    // cleaning + chemical dwell
    var cleaning = items.some(function (x){ return x.domain === "cleaning"; });
    if (cleaning) flags.push("chemical/dwell-separation");
    if (isSabbathGuardActive()) flags.push("sabbath");
    return flags;
  }

  function resourceSummary(items) {
    var apps = {}; var tools = {};
    for (var i=0;i<items.length;i++){
      var a = items[i].appliances || [];
      var t = items[i].tools || [];
      for (var j=0;j<a.length;j++) apps[a[j]] = true;
      for (var k=0;k<t.length;k++) tools[t[k]] = true;
    }
    return { appliances: Object.keys(apps), tools: Object.keys(tools) };
  }

  function estimateShortageFrac(items) {
    var sum = 0; var count = 0;
    for (var i=0;i<items.length;i++){
      var ings = items[i].ingredients || [];
      if (!ings.length) continue;
      var fakeRecipe = { ingredients: ings.map(function (x){ return { name: x.name }; }) };
      try { sum += mapping.shortageRatio(fakeRecipe); } catch (_e) {}
      count++;
    }
    return count ? (sum / count) : 0;
  }

  function estimateCost(items) {
    var total = 0; var currency = "USD";
    for (var i=0;i<items.length;i++){
      var ings = items[i].ingredients || [];
      if (!ings.length) continue;
      try {
        var recipeLike = { ingredients: ings };
        var c = estimateEngine.cost(recipeLike);
        if (c && isFinite(c.total)) {
          total += Number(c.total);
          currency = c.currency || currency;
        }
      } catch (_e) {}
    }
    if (total <= 0) return null;
    return { total: Number(total.toFixed(2)), currency: currency };
  }

  function makeChecklist(title, groups) {
    var list = ["Stage: label containers, sharp knife, boards (raw vs ready), sanitizer, bins."];
    for (var i=0;i<groups.length;i++){
      var g = groups[i];
      list.push("• " + g.title + ":");
      for (var j=0;j<g.items.length;j++){
        list.push("   - " + g.items[j].label + " (" + g.items[j].windowMinutes + "m)");
      }
    }
    list.push("Cleanup: sanitize stations, label & store, log inventory deltas.");
    return list;
  }

  // ---- core: proposals -------------------------------------------------------

  /**
   * buildProposals(candidates, opts)
   * opts: { dateISO?, maxSessionMinutes?: number (default 120), strategy?: "balanced"|"aggressive" }
   */
  function buildProposals(candidates, opts = {}) {
    var dateISO = opts.dateISO || coerceDateISO();
    var maxSession = safeNum(opts.maxSessionMinutes, 120);
    var strategy = opts.strategy || "balanced";

    // Normalize + filter by day
    var norm = [];
    for (var i=0;i<(candidates||[]).length;i++){
      var n = normalizeCandidate(candidates[i]);
      if (n.dateISO === dateISO) norm.push(n);
    }
    if (!norm.length) return [];

    // Cluster by buckets (knife-prep, marinade, soak, dwell, proof, cleaning-window, wash-dry)
    var buckets = {};
    for (var j=0;j<norm.length;j++){
      var b = classifyBucket(norm[j]);
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(norm[j]);
    }

    // Build sessions: one general kitchen session + optional cleaning/garden micro-sessions
    var proposals = [];

    // Kitchen session: prioritize knife-prep + marinade + soak, then misc
    var kitchenKeys = ["knife-prep","marinade","soak","proof","misc","preheat"];
    var kitchenItems = [];
    for (var kk=0; kk<kitchenKeys.length; kk++){
      var arr = buckets[kitchenKeys[kk]] || [];
      for (var a=0;a<arr.length;a++) kitchenItems.push(arr[a]);
    }
    if (kitchenItems.length) {
      var durationSum = 0;
      var slots = [];
      var groups = [];

      // Group by type block to reduce context switches
      for (var g=0; g<kitchenKeys.length; g++){
        var set = (buckets[kitchenKeys[g]] || []).slice(0);
        if (!set.length) continue;

        // Sort high priority first, then descending window
        set.sort(function (x,y){
          var px = (x.priority === "high") ? 1 : 0;
          var py = (y.priority === "high") ? 1 : 0;
          if (px !== py) return (py - px);
          return (y.windowMinutes - x.windowMinutes);
        });

        var groupDuration = 0;
        var groupItems = [];

        for (var si=0; si<set.length; si++){
          var item = set[si];
          var cost = Math.min(item.windowMinutes, strategy === "aggressive" ? item.windowMinutes : Math.max(5, Math.round(item.windowMinutes * 0.75)));
          if (durationSum + cost > maxSession) break;
          durationSum += cost;
          groupDuration += cost;
          groupItems.push(item);
          slots.push({ label: item.label, minutes: cost, candidateIds: [item.id] });
        }

        if (groupItems.length) {
          groups.push({
            key: kitchenKeys[g],
            title: (function(k){ 
              var map = { "knife-prep":"Knife prep", "marinade":"Marinades", "soak":"Soaks/Beans", "proof":"Proof/Rest", "misc":"Quick wins", "preheat":"Preheats" };
              return map[k] || k;
            })(kitchenKeys[g]),
            items: groupItems
          });
        }
      }

      if (slots.length) {
        var safetyFlags = detectSafetyFlags(kitchenItems);
        var resources = resourceSummary(kitchenItems);
        var shortage = estimateShortageFrac(kitchenItems);
        var estCost = estimateCost(kitchenItems);
        var conflicts = [];

        // Simple appliance conflict check (same appliance parallelization)
        var appCount = {};
        for (var ai=0; ai<resources.appliances.length; ai++) {
          var ap = resources.appliances[ai];
          appCount[ap] = (appCount[ap] || 0) + 1;
        }
        for (var k in appCount) {
          if (appCount[k] > 1) conflicts.push("appliance conflict: " + k);
        }

        // Meals affected approximation: count unique relatedIds in "meals" domain
        var mealSet = {};
        for (var mi=0; mi<kitchenItems.length; mi++){
          if (kitchenItems[mi].domain === "meals" && kitchenItems[mi].relatedId) {
            mealSet[kitchenItems[mi].relatedId] = true;
          }
        }

        var proposal = {
          id: uuid("prop"),
          title: "Kitchen Prep Session",
          dateISO: dateISO,
          durationMinutes: durationSum,
          slots: slots,
          groups: groups,
          resources: resources,
          impact: {
            mealsAffected: Object.keys(mealSet).length,
            minutesSaved: Math.round(durationSum * 0.4), // heuristic: batch saves ~40% overhead
            inventoryShortageFrac: shortage,
            estCost: estCost
          },
          safetyFlags: safetyFlags,
          conflicts: conflicts,
          checklist: makeChecklist("Kitchen Prep Session", groups),
          groceryHints: (function(){
            var hints = [];
            for (var gi=0; gi<kitchenItems.length; gi++){
              var ins = kitchenItems[gi].ingredients || [];
              for (var gj=0; gj<ins.length; gj++){
                hints.push(ins[gj]);
              }
            }
            return hints;
          })(),
          accepts: { suggestWindows: scheduler.windowsForDay(dateISO) || [] }
        };

        proposals.push(proposal);
      }
    }

    // Cleaning micro-session (e.g., dwell timers you can tuck in between)
    if ((buckets["cleaning-window"] || []).length) {
      var cset = buckets["cleaning-window"].slice(0);
      var cDur = 0; var cSlots = []; var cGroups = [{ key:"cleaning", title:"Cleaning Windows", items: cset }];
      for (var ci=0; ci<cset.length; ci++) {
        var it = cset[ci];
        var cost = Math.min(it.windowMinutes, 15);
        if (cDur + cost > 45) break; // keep micro-session short
        cDur += cost;
        cSlots.push({ label: it.label, minutes: cost, candidateIds: [it.id] });
      }
      if (cSlots.length) {
        proposals.push({
          id: uuid("prop"),
          title: "Quick Cleaning Inserts",
          dateISO: dateISO,
          durationMinutes: cDur,
          slots: cSlots,
          groups: cGroups,
          resources: resourceSummary(cset),
          impact: { mealsAffected: 0, minutesSaved: Math.round(cDur * 0.25), inventoryShortageFrac: 0 },
          safetyFlags: ["chemical/dwell-separation"],
          conflicts: [],
          checklist: makeChecklist("Quick Cleaning Inserts", cGroups),
          groceryHints: [],
          accepts: { suggestWindows: scheduler.windowsForDay(dateISO) || [] }
        });
      }
    }

    // Garden wash/dry micro-session
    if ((buckets["wash-dry"] || []).length) {
      var gset = buckets["wash-dry"].slice(0);
      var gDur = 0; var gSlots = []; var gGroups = [{ key:"wash-dry", title:"Garden Wash & Dry", items: gset }];
      for (var wi=0; wi<gset.length; wi++) {
        var git = gset[wi];
        var cost = Math.min(git.windowMinutes, 20);
        if (gDur + cost > 40) break;
        gDur += cost;
        gSlots.push({ label: git.label, minutes: cost, candidateIds: [git.id] });
      }
      if (gSlots.length) {
        proposals.push({
          id: uuid("prop"),
          title: "Garden Wash & Dry",
          dateISO: dateISO,
          durationMinutes: gDur,
          slots: gSlots,
          groups: gGroups,
          resources: resourceSummary(gset),
          impact: { mealsAffected: 0, minutesSaved: Math.round(gDur * 0.3), inventoryShortageFrac: 0 },
          safetyFlags: [],
          conflicts: [],
          checklist: makeChecklist("Garden Wash & Dry", gGroups),
          groceryHints: [],
          accepts: { suggestWindows: scheduler.windowsForDay(dateISO) || [] }
        });
      }
    }

    // Emit analytics
    try {
      analytics.track("prep/proposals_built", { dateISO, candidates: norm.length, proposals: proposals.length });
    } catch (_e) {}

    return proposals;
  }

  /**
   * acceptProposal(proposal, windowId?) -> scheduled payload
   */
  function acceptProposal(proposal, windowId) {
    if (!proposal) return null;
    try {
      scheduler.scheduleBlock({
        title: proposal.title,
        dateISO: proposal.dateISO,
        minutes: proposal.durationMinutes,
        windowId: windowId || (proposal.accepts && proposal.accepts.suggestWindows[0] && proposal.accepts.suggestWindows[0].id),
        checklist: proposal.checklist,
        resources: proposal.resources
      });
    } catch (_e) {}

    try {
      eventBus.emit("prep:proposal:accepted", { proposalId: proposal.id, dateISO: proposal.dateISO, minutes: proposal.durationMinutes });
      analytics.track("prep/proposal_accepted", { id: proposal.id, minutes: proposal.durationMinutes });
    } catch (_e) {}

    return {
      scheduled: true,
      id: proposal.id,
      dateISO: proposal.dateISO,
      minutes: proposal.durationMinutes,
      windowId: windowId || null
    };
  }

  /**
   * exportChecklist(proposal) -> simple text array for printing/sharing
   */
  function exportChecklist(proposal) {
    if (!proposal) return [];
    return proposal.checklist || [];
  }

  return {
    buildProposals,
    acceptProposal,
    exportChecklist
  };
}

// ---------------- React hook wrapper ------------------------------------------

/**
 * usePrepConsolidation
 * Collect candidates (from event stream or manual), build proposals by day, accept/schedule, export checklist.
 */
export default function usePrepConsolidation(deps = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createPrepConsolidation(deps);

  const [candidates, setCandidates] = useState([]);     // normalized candidates
  const [proposals, setProposals] = useState([]);       // current day's proposals
  const [lastBuiltFor, setLastBuiltFor] = useState(null);

  // ---- candidate management --------------------------------------------------

  const addCandidate = useCallback((rawCandidate) => {
    // allow raw step payloads from executors; engine will normalize on build
    setCandidates((prev) => prev.concat([rawCandidate]));
    try { deps.analytics && deps.analytics.track && deps.analytics.track("prep/candidate_added", {}); } catch (_e) {}
  }, [deps]);

  const addMany = useCallback((rawList) => {
    if (!rawList || !rawList.length) return;
    setCandidates((prev) => prev.concat(rawList));
  }, []);

  const clearCandidates = useCallback(() => {
    setCandidates([]);
  }, []);

  // ---- proposals -------------------------------------------------------------

  const buildForDate = useCallback((dateISO, opts = {}) => {
    const props = engineRef.current.buildProposals(candidates, Object.assign({ dateISO }, opts));
    setProposals(props);
    setLastBuiltFor(dateISO || new Date().toISOString().slice(0,10));
    return props;
  }, [candidates]);

  const refreshToday = useCallback((opts = {}) => {
    const dateISO = new Date().toISOString().slice(0,10);
    return buildForDate(dateISO, opts);
  }, [buildForDate]);

  const accept = useCallback((proposalId, windowId) => {
    const p = proposals.find((x) => x.id === proposalId);
    if (!p) return null;
    const res = engineRef.current.acceptProposal(p, windowId);
    return res;
  }, [proposals]);

  const exportChecklist = useCallback((proposalId) => {
    const p = proposals.find((x) => x.id === proposalId);
    if (!p) return [];
    return engineRef.current.exportChecklist(p);
  }, [proposals]);

  // ---- derived views ---------------------------------------------------------

  const summary = useMemo(() => {
    let totalMinutes = 0, sessions = proposals.length, meals = 0;
    let flags = [];
    for (let i=0;i<proposals.length;i++){
      totalMinutes += proposals[i].durationMinutes || 0;
      meals += proposals[i].impact ? (proposals[i].impact.mealsAffected || 0) : 0;
      flags = flags.concat(proposals[i].safetyFlags || []);
    }
    return { sessions, totalMinutes, mealsAffected: meals, flags: Array.from(new Set(flags)) };
  }, [proposals]);

  return {
    // candidate intake
    addCandidate,
    addMany,
    clearCandidates,
    candidates,
    // proposals
    buildForDate,
    refreshToday,
    proposals,
    lastBuiltFor,
    accept,
    exportChecklist,
    summary
  };
}

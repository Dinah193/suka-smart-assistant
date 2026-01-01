/* eslint-disable no-console */
/**
 * workPrepConsolidation.js
 * -------------------------------------------------
 * Purpose:
 *  - Scan a mixed-domain plan (meals / garden / cleaning / animal-care)
 *  - Extract implicit "prep" steps (preheat oven, sanitize station, stage tools/PPE)
 *  - Detect overlapping resources (appliances, zones, tools, chemicals, PPE, species, beds, roles)
 *  - Propose consolidation bundles and conflict fixes
 *
 * Input (plan item shape, minimal):
 *  {
 *    id, domain, slot:{start, end, mealType?},
 *    // Domain fields (any subset):
 *    title, tags[], appliances[], oven?:{tempF?, tempC?},
 *    steps?, tools?, chemicals?, ppe?, roles?,
 *    kind?, bedName?, cropName?, species?, roomType?
 *  }
 *
 * API:
 *  - consolidate(plan:Array, ctx?:object) -> {
 *      consolidatedPreps: Array<PrepBundle>,
 *      overlaps: Array<ResourceOverlap>,
 *      suggestions: string[],
 *      byResource: Map-ish summary
 *    }
 *
 *  - _internals.* exported for tests
 */

// ----------------------------- Safe Imports ----------------------------------
(function () {
  var eventBus = { emit: function () {} };
  try {
    eventBus = (require("@/services/eventBus") || {}).eventBus || eventBus;
  } catch (e) {}

  var automation = null;
  try {
    automation = (require("@/services/automation/runtime") || {}).automation || null;
  } catch (e) {}

  var logger = console;

// ------------------------------- Utilities -----------------------------------
  var DAY_MS = 24 * 60 * 60 * 1000;
  var HOUR_MS = 60 * 60 * 1000;

  function asDate(v) { return v instanceof Date ? v : new Date(v); }
  function norm(s) { return (s || "").toString().trim().toLowerCase(); }
  function defined(v) { return v !== undefined && v !== null; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function deepMerge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (!o || typeof o !== "object") continue;
      var ks = Object.keys(o);
      for (var j = 0; j < ks.length; j++) {
        var k = ks[j], val = o[k];
        if (val && typeof val === "object" && !Array.isArray(val)) {
          out[k] = deepMerge(out[k] || {}, val);
        } else {
          out[k] = val;
        }
      }
    }
    return out;
  }

  function loadPrefs(ctx) {
    var base = {
      prep: {
        // how close in time items must be to consolidate (minutes)
        proximityMinutes: 30,
        // how strict to consider oven temp “compatible”
        ovenTempToleranceF: 25,
        // default dwell timer to propose if chemical present but no timer
        defaultDwellSec: 600,
        // how close in space to consolidate tools (same zone/room by default)
        zoneAffinity: true
      },
      resources: {
        // resource categories we watch
        watch: ["appliance","zone","tool","chemical","ppe","species","bed","role"]
      }
    };
    var ctxPrefs = (ctx && ctx.preferences) ? { prep: ctx.preferences.prep, resources: ctx.preferences.resources } : {};
    var runtime = {};
    try {
      var pr = automation && automation.get ? automation.get("workprep.preferences") : null;
      if (pr && typeof pr === "object") runtime = pr;
    } catch (e) {}
    return deepMerge(base, ctxPrefs, runtime);
  }

  function extractTagValue(tags, prefix) {
    if (!Array.isArray(tags)) return null;
    var p = String(prefix).toLowerCase() + ":";
    for (var i = 0; i < tags.length; i++) {
      var t = String(tags[i]).toLowerCase();
      if (t.indexOf(p) === 0) return t.slice(p.length);
    }
    return null;
  }

  function idOf(it) { return it.id || it._id || it.slug || it.title || it.name || null; }
  function slotStartOf(it) { return asDate(it && it.slot && (it.slot.start || it.slot.date || it.slot)); }
  function slotEndOf(it) {
    if (it && it.slot && it.slot.end) return asDate(it.slot.end);
    var start = slotStartOf(it);
    var fallbackMin = 45;
    var mins = Number(
      it.totalTimeMinutes || it.totalMinutes ||
      (it.time && (it.time.total || (Number(it.time.prep || 0) + Number(it.time.cook || 0)))) ||
      (it.durationMin) || fallbackMin
    );
    return new Date(start.getTime() + mins * 60000);
  }

  function uniqPush(h, key, val) {
    if (!h[key]) h[key] = [];
    // de-dupe by JSON-ish signature
    var sig = JSON.stringify(val);
    for (var i = 0; i < h[key].length; i++) {
      if (JSON.stringify(h[key][i]) === sig) return;
    }
    h[key].push(val);
  }

  function overlap(aStart, aEnd, bStart, bEnd) {
    return !(aEnd <= bStart || aStart >= bEnd);
  }

// ---------------------------- Resource Extraction ----------------------------
  /**
   * Normalize an item to resource requirements and prep intents.
   */
  function extractResources(item) {
    var res = {
      // single-valued
      zone: null,
      oven: null, // {tempF?, tempC?}
      bed: null,
      species: null,
      // lists
      appliances: [],
      tools: [],
      chemicals: [],
      ppe: [],
      roles: []
    };

    var tags = item.tags || [];
    res.zone = extractTagValue(tags, "zone") || (item.domain === "garden" ? "outdoor" : "indoor");
    res.species = extractTagValue(tags, "species") || (Array.isArray(item.species) && item.species[0]) || null;
    res.bed = item.bedName || item.bed || null;

    // Appliances / oven
    var apps = Array.isArray(item.appliances) ? item.appliances.slice() : [];
    // infer from tags/kind
    if (item.domain === "meals") {
      if (/bake|roast|sheet pan|oven/i.test((item.title || ""))) apps.push("oven");
      if (/air[- ]?fry/i.test(item.title || "")) apps.push("airfryer");
      if (/grill/i.test((item.title || ""))) apps.push("grill");
    }
    res.appliances = apps.map(function (a) { return norm(a); });

    // Oven temps
    if (item.oven && (defined(item.oven.tempF) || defined(item.oven.tempC))) {
      res.oven = { tempF: defined(item.oven.tempF) ? Number(item.oven.tempF) : null,
                   tempC: defined(item.oven.tempC) ? Number(item.oven.tempC) : null };
    } else {
      // try to parse from title like "Roast Chicken (425F)"
      var m = String(item.title || "").match(/(\d{3})\s*F\b/i);
      if (m) res.oven = { tempF: Number(m[1]) };
    }

    // Tools / Chemicals / PPE / Roles
    if (Array.isArray(item.tools)) res.tools = item.tools.map(norm);
    if (Array.isArray(item.chemicals)) res.chemicals = item.chemicals.map(function (c) { return norm(c.name || c); });
    if (Array.isArray(item.ppe)) res.ppe = item.ppe.map(norm);
    if (Array.isArray(item.roles)) res.roles = item.roles.map(norm);

    // Steps-derived: dwell timers imply chemical prep
    if (Array.isArray(item.steps)) {
      for (var i = 0; i < item.steps.length; i++) {
        var s = item.steps[i];
        if (s.product) uniqPush(res, "chemicals", norm(s.product));
        if (s.surface && /floor|counter|glass|stainless|toilet|sink/.test(s.surface)) uniqPush(res, "tools", "microfiber cloth");
        if (s.timer && s.timer.durationSec) uniqPush(res, "tools", "timer");
        if (/mop|bucket/i.test(s.text || "")) uniqPush(res, "tools", "mop & bucket");
      }
    }

    // Garden heuristics
    if (item.domain === "garden") {
      uniqPush(res, "tools", "watering can"); // light default
      if (/trellis|stake/i.test(String(item.kind || ""))) uniqPush(res, "tools", "stakes/trellis");
      if (/fertil/i.test(String(item.kind || ""))) uniqPush(res, "tools", "fertilizer scoop");
    }

    return res;
  }

// --------------------------- Timeline & Overlaps -----------------------------
  function buildTimeline(plan) {
    var timeline = []; // [{id, domain, start, end, res}]
    for (var i = 0; i < plan.length; i++) {
      var it = plan[i];
      if (!it || !it.slot) continue;
      timeline.push({
        id: idOf(it),
        domain: (it.domain || (it.ingredients ? "meals" : "unknown")).toLowerCase(),
        start: slotStartOf(it),
        end: slotEndOf(it),
        res: extractResources(it),
        raw: it
      });
    }
    // sort by start
    timeline.sort(function (a, b) { return a.start - b.start; });
    return timeline;
  }

  function detectOverlaps(timeline) {
    var overlaps = []; // { type, resource, A, B, reason, fixes[] }
    var byResource = {}; // summaries for UI

    function pushRes(cat, key, payload) {
      var k = cat + "::" + key;
      if (!byResource[k]) byResource[k] = { category: cat, key: key, uses: [] };
      byResource[k].uses.push(payload);
    }

    for (var i = 0; i < timeline.length; i++) {
      var A = timeline[i];
      var aStart = A.start, aEnd = A.end;

      // appliances
      for (var ai = 0; ai < A.res.appliances.length; ai++) {
        var app = A.res.appliances[ai];
        pushRes("appliance", app, { id: A.id, start: aStart, end: aEnd });

        for (var j = i + 1; j < timeline.length; j++) {
          var B = timeline[j];
          if (B.start - aEnd > 2 * HOUR_MS) break; // cheap window cut
          if (B.res.appliances.indexOf(app) >= 0 && overlap(aStart, aEnd, B.start, B.end)) {
            overlaps.push({
              type: "appliance",
              resource: app,
              A: { id: A.id, start: aStart, end: aEnd },
              B: { id: B.id, start: B.start, end: B.end },
              reason: 'Appliance "' + app + '" overbooked.',
              fixes: [
                { label: "Shift later by +30m", payload: { type: "SHIFT_MINUTES", id: B.id, minutes: 30 } },
                { label: "Start earlier by -30m", payload: { type: "SHIFT_MINUTES", id: A.id, minutes: -30 } }
              ]
            });
          }
        }
      }

      // zones
      if (A.res.zone) {
        var zone = A.res.zone;
        pushRes("zone", zone, { id: A.id, start: aStart, end: aEnd });
        for (var j2 = i + 1; j2 < timeline.length; j2++) {
          var B2 = timeline[j2];
          if (B2.res.zone === zone && overlap(aStart, aEnd, B2.start, B2.end)) {
            overlaps.push({
              type: "zone",
              resource: zone,
              A: { id: A.id, start: aStart, end: aEnd },
              B: { id: B2.id, start: B2.start, end: B2.end },
              reason: 'Zone "' + zone + '" in use by multiple tasks.',
              fixes: [
                { label: "Pick alternate zone", payload: { type: "PICK_ZONE", id: B2.id } },
                { label: "Shift by +30m", payload: { type: "SHIFT_MINUTES", id: B2.id, minutes: 30 } }
              ]
            });
          }
        }
      }

      // species
      if (A.res.species) {
        var sp = norm(A.res.species);
        pushRes("species", sp, { id: A.id, start: aStart, end: aEnd });
        for (var j3 = i + 1; j3 < timeline.length; j3++) {
          var B3 = timeline[j3];
          if (norm(B3.res.species) === sp && overlap(aStart, aEnd, B3.start, B3.end)) {
            overlaps.push({
              type: "species",
              resource: sp,
              A: { id: A.id, start: aStart, end: aEnd },
              B: { id: B3.id, start: B3.start, end: B3.end },
              reason: 'Species "' + sp + '" engagement overlap.',
              fixes: [
                { label: "Stagger by 20m", payload: { type: "SHIFT_MINUTES", id: B3.id, minutes: 20 } },
                { label: "Assign different handler", payload: { type: "ASSIGN_ROLE", role: "assistant", id: B3.id } }
              ]
            });
          }
        }
      }

      // bed (garden)
      if (A.res.bed) {
        var bed = norm(A.res.bed);
        pushRes("bed", bed, { id: A.id, start: aStart, end: aEnd });
        for (var j4 = i + 1; j4 < timeline.length; j4++) {
          var B4 = timeline[j4];
          if (norm(B4.res.bed) === bed && overlap(aStart, aEnd, B4.start, B4.end)) {
            overlaps.push({
              type: "bed",
              resource: bed,
              A: { id: A.id, start: aStart, end: aEnd },
              B: { id: B4.id, start: B4.start, end: B4.end },
              reason: 'Garden bed "' + bed + '" is double-booked.',
              fixes: [
                { label: "Split tasks (sequence)", payload: { type: "SEQUENCE", ids: [A.id, B4.id] } },
                { label: "Move B to next free window", payload: { type: "AUTOSCHEDULE_NEXT", id: B4.id } }
              ]
            });
          }
        }
      }

      // tools (soft conflict → consolidation opportunity)
      for (var ti = 0; ti < A.res.tools.length; ti++) {
        var tool = A.res.tools[ti];
        pushRes("tool", tool, { id: A.id, start: aStart, end: aEnd });
      }

      // chemicals / PPE (soft: propose shared prep & safety)
      for (var ci = 0; ci < A.res.chemicals.length; ci++) {
        var chem = A.res.chemicals[ci];
        pushRes("chemical", chem, { id: A.id, start: aStart, end: aEnd });
      }
      for (var pi = 0; pi < A.res.ppe.length; pi++) {
        var ppe = A.res.ppe[pi];
        pushRes("ppe", ppe, { id: A.id, start: aStart, end: aEnd });
      }

      // roles (people)
      for (var ri = 0; ri < A.res.roles.length; ri++) {
        var role = A.res.roles[ri];
        pushRes("role", role, { id: A.id, start: aStart, end: aEnd });
        for (var j5 = i + 1; j5 < timeline.length; j5++) {
          var B5 = timeline[j5];
          if (B5.res.roles.indexOf(role) >= 0 && overlap(aStart, aEnd, B5.start, B5.end)) {
            overlaps.push({
              type: "role",
              resource: role,
              A: { id: A.id, start: aStart, end: aEnd },
              B: { id: B5.id, start: B5.start, end: B5.end },
              reason: 'Role "' + role + '" overbooked.',
              fixes: [
                { label: "Assign alternate", payload: { type: "ASSIGN_ROLE", id: B5.id, role: role + "_alt" } },
                { label: "Shift B by +15m", payload: { type: "SHIFT_MINUTES", id: B5.id, minutes: 15 } }
              ]
            });
          }
        }
      }
    }

    return { overlaps: overlaps, byResource: byResource };
  }

// ------------------------ Consolidation (Prep Bundles) -----------------------
  /**
   * Create "prep bundles" for:
   *  - Oven preheat (combine nearby recipes, reconcile temps)
   *  - Station sanitize (shared chemicals + PPE for cleaning runs)
   *  - Garden tool staging (group nearby bed work)
   *  - Role briefings (if same role handles adjacent tasks)
   */
  function consolidatePreps(timeline, prefs) {
    var bundles = []; // { type, resource, window:{start,end}, actions[], appliesTo:[id] }

    // 1) Oven preheat
    var ovenUsers = timeline.filter(function (t) {
      return t.res.appliances.indexOf("oven") >= 0;
    });

    for (var i = 0; i < ovenUsers.length; i++) {
      var A = ovenUsers[i];
      var group = [A];
      var windowStart = new Date(A.start);
      var windowEnd = new Date(A.end);
      var proxMs = (prefs.prep.proximityMinutes || 30) * 60000;

      for (var j = i + 1; j < ovenUsers.length; j++) {
        var B = ovenUsers[j];
        if (Math.abs(B.start - A.start) <= proxMs) {
          group.push(B);
          if (B.end > windowEnd) windowEnd = new Date(B.end);
        } else {
          break; // sorted by start
        }
      }
      if (group.length > 1) {
        // Reconcile temperatures
        var temps = group.map(function (g) { return (g.res.oven && g.res.oven.tempF) || null; }).filter(defined);
        var target = temps.length ? Math.round(temps.reduce(function (a, b) { return a + b; }, 0) / temps.length) : null;

        // Validate tolerance: if spread too big, note recommendation
        var spread = 0;
        for (var k = 0; k < temps.length; k++) spread = Math.max(spread, Math.abs(temps[k] - target));

        var actions = [{ kind: "preheat", text: "Preheat oven" + (target ? (" to " + target + "°F") : ""), at: new Date(windowStart.getTime() - 10 * 60000) }];
        if (spread > (prefs.prep.ovenTempToleranceF || 25)) {
          actions.push({ kind: "notice", text: "Oven temperature mismatch across items; consider sequence or split batches." });
        }
        var appliesTo = group.map(function (g) { return g.id; });

        bundles.push({
          type: "oven-preheat",
          resource: "oven",
          window: { start: windowStart, end: windowEnd },
          actions: actions,
          appliesTo: appliesTo
        });

        i += (group.length - 1);
      }
    }

    // 2) Cleaning station sanitize (shared chemicals + PPE)
    var cleaners = timeline.filter(function (t) { return t.domain === "cleaning" || (t.res.chemicals && t.res.chemicals.length); });
    if (cleaners.length) {
      // group by zone & proximity
      cleaners.sort(function (a, b) { return a.start - b.start; });
      var visited = {};
      for (var c = 0; c < cleaners.length; c++) {
        if (visited[c]) continue;
        var C = cleaners[c];
        var groupC = [C];
        visited[c] = true;

        for (var d = c + 1; d < cleaners.length; d++) {
          if (visited[d]) continue;
          var D = cleaners[d];
          var sameZone = (C.res.zone === D.res.zone);
          var near = Math.abs(D.start - C.start) <= (prefs.prep.proximityMinutes || 30) * 60000;
          if (sameZone && near) { groupC.push(D); visited[d] = true; }
          else if (D.start - C.start > (prefs.prep.proximityMinutes || 30) * 60000 * 2) break;
        }

        if (groupC.length > 1) {
          var start = groupC[0].start;
          var end = groupC[groupC.length - 1].end;
          var chems = {};
          var ppe = {};
          for (var gx = 0; gx < groupC.length; gx++) {
            var t = groupC[gx];
            for (var ci = 0; ci < t.res.chemicals.length; ci++) { chems[t.res.chemicals[ci]] = true; }
            for (var pi = 0; pi < t.res.ppe.length; pi++) { ppe[t.res.ppe[pi]] = true; }
          }
          var chemKeys = Object.keys(chems);
          var ppeKeys = Object.keys(ppe);
          var actionsC = [];
          if (chemKeys.length) {
            actionsC.push({ kind: "stage", text: "Stage chemicals: " + chemKeys.join(", "), at: new Date(start.getTime() - 5 * 60000) });
            // ensure dwell timers exist downstream
            actionsC.push({ kind: "timer-sanity", text: "Ensure dwell timers set (" + (prefs.prep.defaultDwellSec || 600) + "s) for disinfectant steps." });
          }
          if (ppeKeys.length) {
            actionsC.push({ kind: "stage", text: "Stage PPE: " + ppeKeys.join(", "), at: new Date(start.getTime() - 5 * 60000) });
          }

          bundles.push({
            type: "cleaning-station",
            resource: C.res.zone || "indoor",
            window: { start: start, end: end },
            actions: actionsC,
            appliesTo: groupC.map(function (g) { return g.id; })
          });
        }
      }
    }

    // 3) Garden tool staging (same bed or adjacent times)
    var garden = timeline.filter(function (t) { return t.domain === "garden"; });
    if (garden.length) {
      garden.sort(function (a, b) { return a.start - b.start; });
      var used = {};
      for (var gi = 0; gi < garden.length; gi++) {
        if (used[gi]) continue;
        var G = garden[gi];
        var groupG = [G];
        used[gi] = true;

        for (var gj = gi + 1; gj < garden.length; gj++) {
          if (used[gj]) continue;
          var H = garden[gj];
          var near = Math.abs(H.start - G.start) <= (prefs.prep.proximityMinutes || 30) * 60000;
          var sameBed = G.res.bed && H.res.bed && norm(G.res.bed) === norm(H.res.bed);
          if (near || sameBed) { groupG.push(H); used[gj] = true; }
          else if (H.start - G.start > (prefs.prep.proximityMinutes || 30) * 60000 * 2) break;
        }

        if (groupG.length > 1) {
          var toolsSet = {};
          for (var tgi = 0; tgi < groupG.length; tgi++) {
            var rr = groupG[tgi].res;
            for (var tt = 0; tt < rr.tools.length; tt++) toolsSet[rr.tools[tt]] = true;
          }
          var toolList = Object.keys(toolsSet);
          bundles.push({
            type: "garden-staging",
            resource: (G.res.bed || "beds"),
            window: { start: groupG[0].start, end: groupG[groupG.length - 1].end },
            actions: [
              { kind: "stage", text: "Stage garden tools: " + (toolList.join(", ") || "hand tools"), at: new Date(groupG[0].start.getTime() - 10 * 60000) }
            ],
            appliesTo: groupG.map(function (g) { return g.id; })
          });
        }
      }
    }

    // 4) Role briefing (if same role across adjacent tasks)
    var withRoles = timeline.filter(function (t) { return t.res.roles && t.res.roles.length; });
    if (withRoles.length) {
      withRoles.sort(function (a, b) { return a.start - b.start; });
      for (var rsi = 0; rsi < withRoles.length - 1; rsi++) {
        var X = withRoles[rsi], Y = withRoles[rsi + 1];
        var overlapRole = null;
        for (var r1 = 0; r1 < X.res.roles.length; r1++) {
          var role = X.res.roles[r1];
          if (Y.res.roles.indexOf(role) >= 0) { overlapRole = role; break; }
        }
        if (overlapRole && Math.abs(Y.start - X.end) <= (prefs.prep.proximityMinutes || 30) * 60000) {
          bundles.push({
            type: "role-brief",
            resource: overlapRole,
            window: { start: X.start, end: Y.end },
            actions: [{ kind: "brief", text: "Brief '" + overlapRole + "' once for adjacent tasks." }],
            appliesTo: [X.id, Y.id]
          });
        }
      }
    }

    return bundles;
  }

// ------------------------------- Main API ------------------------------------
  function consolidate(plan, ctx) {
    if (!Array.isArray(plan)) plan = [];
    var prefs = loadPrefs(ctx || {});
    var timeline = buildTimeline(plan);
    var detection = detectOverlaps(timeline);
    var bundles = consolidatePreps(timeline, prefs);

    // Suggestions: lightweight tips based on overlaps/bundles
    var suggestions = [];
    for (var i = 0; i < detection.overlaps.length; i++) {
      var o = detection.overlaps[i];
      if (o.type === "appliance" && o.resource === "oven") {
        suggestions.push("Oven conflict detected — consolidate preheat or stagger starts by 30m.");
      } else if (o.type === "zone") {
        suggestions.push("Zone '" + o.resource + "' is busy — try alternate zone or shift.");
      } else if (o.type === "species") {
        suggestions.push("Species overlap — assign assistant or stagger tasks.");
      } else if (o.type === "role") {
        suggestions.push("Role '" + o.resource + "' is double-booked — assign alternate or reschedule.");
      } else if (o.type === "bed") {
        suggestions.push("Garden bed '" + o.resource + "' double-booked — sequence tasks or move one.");
      }
    }
    if (bundles.some(function (b) { return b.type === "cleaning-station"; })) {
      suggestions.push("Combine cleaning runs in the same zone and reuse staged PPE/chemicals.");
    }
    if (bundles.some(function (b) { return b.type === "garden-staging"; })) {
      suggestions.push("Stage garden tools once for adjacent bed tasks.");
    }

    // Emit small NBA hint for UI
    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit("workprep:analyzed", {
          overlapCount: detection.overlaps.length,
          bundleCount: bundles.length
        });
      }
    } catch (e) {}

    return {
      consolidatedPreps: bundles,
      overlaps: detection.overlaps,
      suggestions: suggestions,
      byResource: detection.byResource
    };
  }

// ------------------------------ Module Exports -------------------------------
  module.exports = {
    consolidate: consolidate,
    _internals: {
      buildTimeline: buildTimeline,
      detectOverlaps: detectOverlaps,
      consolidatePreps: consolidatePreps,
      extractResources: extractResources,
      loadPrefs: loadPrefs
    }
  };
})();

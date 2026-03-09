/* eslint-disable no-console */
// prepConsolidationEngine.js — Detect overlaps → batch prep suggestions (ES2015-safe)

(function () {
  // ------------------------------ Safe Imports ------------------------------
  var eventBus = { emit: function () {} };
  try {
    eventBus =
      (require("@/services/events/eventBus") || {}).eventBus || eventBus;
  } catch (e) {}

  var automation = null;
  try {
    automation =
      (require("@/services/automation/runtime") || {}).automation || null;
  } catch (e) {}

  var logger = console;

  // ------------------------------- Utilities --------------------------------
  var MIN = 60 * 1000;
  var DAY_MS = 24 * 60 * 60 * 1000;

  function asDate(v) {
    return v instanceof Date ? v : new Date(v);
  }
  function clamp(v, a, b) {
    if (a === void 0) a = 0;
    if (b === void 0) b = 1;
    return Math.max(a, Math.min(b, v));
  }

  function deepMerge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (!o || typeof o !== "object") continue;
      var keys = Object.keys(o);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j],
          val = o[k];
        if (val && typeof val === "object" && !Array.isArray(val)) {
          out[k] = deepMerge(out[k] || {}, val);
        } else {
          out[k] = val;
        }
      }
    }
    return out;
  }

  function uniq(arr) {
    var m = {};
    var out = [];
    for (var i = 0; i < (arr || []).length; i++) {
      var v = String(arr[i]);
      if (!m[v]) {
        m[v] = 1;
        out.push(v);
      }
    }
    return out;
  }

  function intersect(a, b) {
    var setA = {};
    var out = [];
    for (var i = 0; i < (a || []).length; i++)
      setA[String(a[i]).toLowerCase()] = 1;
    for (var j = 0; j < (b || []).length; j++) {
      var v = String(b[j]).toLowerCase();
      if (setA[v]) out.push(v);
    }
    return uniq(out);
  }

  function idOf(task) {
    if (!task) return null;
    return task.id || task._id || task.ref || task.title || null;
  }

  function timeOverlap(a, b, slackMinutes) {
    var slack = Number(slackMinutes || 0) * MIN;
    var aStart = asDate(
      a.start || a.windowStart || (a.slot && a.slot.start) || a.date
    );
    var aEnd = asDate(
      a.end ||
        a.windowEnd ||
        (a.slot && a.slot.end) ||
        (aStart &&
          new Date(
            aStart.getTime() + Number(a.estMinutes || a.duration || 30) * MIN
          ))
    );
    var bStart = asDate(
      b.start || b.windowStart || (b.slot && b.slot.start) || b.date
    );
    var bEnd = asDate(
      b.end ||
        b.windowEnd ||
        (b.slot && b.slot.end) ||
        (bStart &&
          new Date(
            bStart.getTime() + Number(b.estMinutes || b.duration || 30) * MIN
          ))
    );
    if (!aStart || !bStart) return false;
    return !(
      aEnd.getTime() + slack <= bStart.getTime() ||
      bEnd.getTime() + slack <= aStart.getTime()
    );
  }

  function sameDay(a, b) {
    var A = asDate(a),
      B = asDate(b);
    return (
      A.getFullYear() === B.getFullYear() &&
      A.getMonth() === B.getMonth() &&
      A.getDate() === B.getDate()
    );
  }

  function locationAffinity(a, b) {
    // If zones/areas match → 1, if room matches → 0.8, else 0.0
    var az = (a.zone || "").toLowerCase(),
      bz = (b.zone || "").toLowerCase();
    var ar = (a.room || "").toLowerCase(),
      br = (b.room || "").toLowerCase();
    if (az && bz && az === bz) return 1.0;
    if (ar && br && ar === br) return 0.8;
    return 0.0;
  }

  function sanitationRisk(a, b) {
    // If one involves raw meat/fish and the other is produce, require sanitize step
    var aFlags = (a.flags || []).map(function (x) {
      return String(x).toLowerCase();
    });
    var bFlags = (b.flags || []).map(function (x) {
      return String(x).toLowerCase();
    });
    var aRaw =
      aFlags.indexOf("raw-meat") >= 0 || aFlags.indexOf("raw-fish") >= 0;
    var bRaw =
      bFlags.indexOf("raw-meat") >= 0 || bFlags.indexOf("raw-fish") >= 0;
    var aProduce =
      aFlags.indexOf("produce") >= 0 || aFlags.indexOf("ready-to-eat") >= 0;
    var bProduce =
      bFlags.indexOf("produce") >= 0 || bFlags.indexOf("ready-to-eat") >= 0;
    if ((aRaw && bProduce) || (bRaw && aProduce)) return true;
    return false;
  }

  function normalizeTask(t) {
    if (!t) return null;
    var out = {
      id: idOf(t),
      title: t.title || "Task",
      domain: (t.domain || "meals").toLowerCase(), // meals|cleaning|animal|garden|inventory|...
      start: t.start || t.windowStart || t.date || null,
      end: t.end || t.windowEnd || null,
      estMinutes: Number(t.estMinutes || t.duration || 30),
      room: t.room || t.location || "",
      zone: t.zone || "",
      tools: Array.isArray(t.tools) ? t.tools.slice() : [],
      appliances: Array.isArray(t.appliances) ? t.appliances.slice() : [],
      ingredients: Array.isArray(t.ingredients) ? t.ingredients.slice() : [],
      consumables: Array.isArray(t.consumables) ? t.consumables.slice() : [],
      flags: Array.isArray(t.flags) ? t.flags.slice() : [],
      // examples: flags: ["raw-meat","produce","sanitizer-required","outdoors","hot-oil"]
      meta: t.meta || {},
    };
    if (!out.start) {
      // place on today to enable same-day consolidation; caller can pass real windows
      var now = new Date();
      now.setMinutes(0, 0, 0);
      out.start = now;
    }
    if (!out.end) {
      out.end = new Date(asDate(out.start).getTime() + out.estMinutes * MIN);
    }
    return out;
  }

  // --------------------------- Scoring & Clustering --------------------------
  function pairScore(a, b, ctx) {
    var slack = (ctx && ctx.windowSlackMinutes) || 20;
    var s = 0;

    // Time proximity / overlap
    if (timeOverlap(a, b, slack)) s += 0.45;

    // Location affinity
    s += locationAffinity(a, b) * 0.25;

    // Tool / appliance overlap
    var sharedTools = intersect(a.tools, b.tools).length;
    var sharedApps = intersect(a.appliances, b.appliances).length;
    if (sharedTools > 0) s += 0.1;
    if (sharedApps > 0) s += 0.12;

    // Ingredient/consumable overlap → same chopping/sanitizer sessions
    var sharedIngs = intersect(a.ingredients, b.ingredients).length;
    var sharedCons = intersect(a.consumables, b.consumables).length;
    if (sharedIngs > 0) s += 0.06;
    if (sharedCons > 0) s += 0.04;

    return clamp(s, 0, 1);
  }

  function buildGraph(tasks, ctx) {
    var nodes = [];
    var edges = [];
    for (var i = 0; i < tasks.length; i++) {
      nodes.push({
        id: tasks[i].id,
        idx: i,
        domain: tasks[i].domain,
        title: tasks[i].title,
      });
    }
    for (var a = 0; a < tasks.length; a++) {
      for (var b = a + 1; b < tasks.length; b++) {
        var w = pairScore(tasks[a], tasks[b], ctx);
        if (w >= ((ctx && ctx.minPairScore) || 0.35)) {
          edges.push({
            a: a,
            b: b,
            w: w,
            sanitation: sanitationRisk(tasks[a], tasks[b]),
          });
        }
      }
    }
    return { nodes: nodes, edges: edges };
  }

  function clusterize(tasks, ctx) {
    // Simple union-find clustering by weight threshold
    var th = (ctx && ctx.clusterThreshold) || 0.45;
    var g = buildGraph(tasks, ctx);
    var parent = [];
    for (var i = 0; i < g.nodes.length; i++) parent[i] = i;

    function find(x) {
      while (parent[x] !== x) x = parent[x] = parent[parent[x]];
      return x;
    }
    function unite(x, y) {
      var rx = find(x),
        ry = find(y);
      if (rx !== ry) parent[ry] = rx;
    }

    for (var e = 0; e < g.edges.length; e++) {
      var edge = g.edges[e];
      if (edge.w >= th) unite(edge.a, edge.b);
    }

    var groups = {};
    for (var k = 0; k < g.nodes.length; k++) {
      var r = find(k);
      var gid = String(r);
      if (!groups[gid]) groups[gid] = [];
      groups[gid].push(tasks[k]);
    }

    var clusters = [];
    var keys = Object.keys(groups);
    for (var j = 0; j < keys.length; j++) clusters.push(groups[keys[j]]);
    return { clusters: clusters, graph: g };
  }

  // --------------------------- Suggestion Builder ----------------------------
  function buildPrepChecklist(cluster) {
    // Deduplicate steps & tools/consumables; insert sanitation steps as needed
    var steps = [];
    var tools = [];
    var consumables = [];
    var appliances = [];
    var ingredients = [];

    // Accumulate
    for (var i = 0; i < cluster.length; i++) {
      var t = cluster[i];
      tools = tools.concat(t.tools || []);
      consumables = consumables.concat(t.consumables || []);
      appliances = appliances.concat(t.appliances || []);
      ingredients = ingredients.concat(t.ingredients || []);
      // Treat each task title as a step seed
      steps.push({ label: t.title, fromTaskId: t.id, domain: t.domain });
    }

    tools = uniq(tools);
    consumables = uniq(consumables);
    appliances = uniq(appliances);
    ingredients = uniq(ingredients);

    // Insert sanitation checkpoints if raw→produce mix
    var needsSanitize = false;
    for (var a = 0; a < cluster.length; a++) {
      for (var b = a + 1; b < cluster.length; b++) {
        if (sanitationRisk(cluster[a], cluster[b])) {
          needsSanitize = true;
          break;
        }
      }
      if (needsSanitize) break;
    }
    if (needsSanitize) {
      steps.unshift({
        label: "Prep sanitize station (soap + sanitizer, fresh towels)",
        domain: "cleaning",
      });
      steps.push({
        label: "Sanitize surfaces/tools after raw handling",
        domain: "cleaning",
      });
      if (consumables.indexOf("sanitizer") < 0) consumables.push("sanitizer");
      if (consumables.indexOf("towels") < 0) consumables.push("towels");
      if (tools.indexOf("cutting board - raw") < 0)
        tools.push("cutting board - raw");
      if (tools.indexOf("cutting board - produce") < 0)
        tools.push("cutting board - produce");
    }

    // Common smart steps
    // 1) Preheat once per appliance
    for (var ap = 0; ap < appliances.length; ap++) {
      var aName = appliances[ap];
      steps.unshift({ label: "Preheat/prime: " + aName, domain: "meals" });
    }
    // 2) Bulk-chop common vegetables (onion, garlic, peppers, carrots, celery)
    var vegs = [
      "onion",
      "garlic",
      "pepper",
      "bell pepper",
      "carrot",
      "celery",
      "ginger",
    ];
    var sharedVeg = [];
    for (var v = 0; v < vegs.length; v++) {
      var key = vegs[v];
      for (var ing = 0; ing < ingredients.length; ing++) {
        var s = String(ingredients[ing]).toLowerCase();
        if (s.indexOf(key) >= 0) {
          sharedVeg.push(key);
          break;
        }
      }
    }
    sharedVeg = uniq(sharedVeg);
    for (var sv = 0; sv < sharedVeg.length; sv++) {
      steps.unshift({ label: "Bulk-chop: " + sharedVeg[sv], domain: "meals" });
    }

    // 3) Cleaning bundle (if any cleaning tasks present)
    var hasCleaning = false;
    for (var i2 = 0; i2 < cluster.length; i2++)
      if (cluster[i2].domain === "cleaning") {
        hasCleaning = true;
        break;
      }
    if (hasCleaning) {
      steps.unshift({
        label: "Stage cleaning caddy (spray, microfiber, gloves)",
        domain: "cleaning",
      });
    }

    // 4) Garden/animal bundles
    var hasGarden = false,
      hasAnimal = false;
    for (var i3 = 0; i3 < cluster.length; i3++) {
      if (cluster[i3].domain === "garden") hasGarden = true;
      if (cluster[i3].domain === "animal") hasAnimal = true;
    }
    if (hasGarden)
      steps.unshift({
        label: "Harvest tote ready (shears, bins, labels)",
        domain: "garden",
      });
    if (hasAnimal)
      steps.unshift({
        label: "Butchery PPE & labels staged",
        domain: "animal",
      });

    return {
      steps: steps,
      tools: tools,
      consumables: consumables,
      appliances: appliances,
      ingredients: ingredients,
    };
  }

  function summarizeCluster(cluster) {
    // Produce a friendly title and time window
    var title = "Batch Prep";
    var earliest = asDate(cluster[0].start),
      latest = asDate(cluster[0].end);
    var domains = {};
    for (var i = 0; i < cluster.length; i++) {
      var t = cluster[i];
      if (asDate(t.start) < earliest) earliest = asDate(t.start);
      if (asDate(t.end) > latest) latest = asDate(t.end);
      domains[t.domain] = 1;
    }
    var domainList = Object.keys(domains).join(" + ");
    title = "Batch Prep (" + domainList + ")";
    return { title: title, window: { start: earliest, end: latest } };
  }

  function clusterToSuggestion(cluster, ctx) {
    var meta = summarizeCluster(cluster);
    var checklist = buildPrepChecklist(cluster);

    var suggestion = {
      id: "cluster:" + (cluster[0].id || Math.random().toString(36).slice(2)),
      title: meta.title,
      window: meta.window,
      tasks: cluster,
      checklist: checklist,
      nbActions: [
        { label: "Open MultiTimerPanel", action: "OPEN_MULTITIMER" },
        {
          label: "Open Prep Checklist Generator",
          action: "OPEN_PREP_CHECKLIST",
        },
        { label: "Open BatchInventoryMap", action: "OPEN_BATCH_INVENTORY" },
      ],
      reasons: [],
    };

    // Reasons: shared tools/appliances/ingredients/time
    var tools = [];
    var apps = [];
    var ings = [];
    for (var i = 0; i < cluster.length; i++) {
      tools = tools.concat(cluster[i].tools || []);
      apps = apps.concat(cluster[i].appliances || []);
      ings = ings.concat(cluster[i].ingredients || []);
    }
    tools = uniq(tools);
    apps = uniq(apps);
    ings = uniq(ings);

    if (apps.length)
      suggestion.reasons.push("Shared appliances: " + apps.join(", "));
    if (tools.length)
      suggestion.reasons.push("Shared tools: " + tools.join(", "));
    if (ings.length)
      suggestion.reasons.push(
        "Shared ingredients: " +
          ings.slice(0, 4).join(", ") +
          (ings.length > 4 ? "…" : "")
      );
    suggestion.reasons.push(
      "Time overlap/proximity within ~" +
        ((ctx && ctx.windowSlackMinutes) || 20) +
        " minutes."
    );

    return suggestion;
  }

  // ------------------------------- Main API ----------------------------------
  /**
   * analyze(tasks, ctx)
   * tasks: Array of { id,title,domain,start,end,estMinutes,room,zone,tools,appliances,ingredients,consumables,flags,meta }
   * ctx:   { windowSlackMinutes, minPairScore, clusterThreshold, emitEvents, tz }
   */
  function analyze(tasks, ctx) {
    var out = { clusters: [], suggestions: [], graph: null, reasons: [] };
    if (!Array.isArray(tasks) || !tasks.length) {
      out.reasons.push("No tasks provided");
      return out;
    }

    // Normalize
    var norm = [];
    for (var i = 0; i < tasks.length; i++) {
      var t = normalizeTask(tasks[i]);
      if (t) norm.push(t);
    }
    if (!norm.length) {
      out.reasons.push("No valid tasks");
      return out;
    }

    // Same-day grouping first (to reduce accidental cross-day merges)
    var byDay = {};
    for (var j = 0; j < norm.length; j++) {
      var dKey = asDate(norm[j].start).toDateString();
      if (!byDay[dKey]) byDay[dKey] = [];
      byDay[dKey].push(norm[j]);
    }

    var dayKeys = Object.keys(byDay);
    var globalGraph = { nodes: [], edges: [] };

    for (var dk = 0; dk < dayKeys.length; dk++) {
      var dayTasks = byDay[dayKeys[dk]];
      var res = clusterize(dayTasks, ctx);
      var clusters = res.clusters;

      // append graph for visualization (keep index offset)
      var offset = globalGraph.nodes.length;
      for (var n = 0; n < res.graph.nodes.length; n++) {
        var node = res.graph.nodes[n];
        globalGraph.nodes.push({
          id: node.id,
          idx: node.idx + offset,
          domain: node.domain,
          title: node.title,
        });
      }
      for (var e = 0; e < res.graph.edges.length; e++) {
        var edge = res.graph.edges[e];
        globalGraph.edges.push({
          a: edge.a + offset,
          b: edge.b + offset,
          w: edge.w,
          sanitation: edge.sanitation,
        });
      }

      // Build suggestions
      for (var c = 0; c < clusters.length; c++) {
        var cluster = clusters[c];
        if (!cluster || cluster.length === 0) continue;

        // Singletons: only surface if task is heavy or batch-friendly
        if (cluster.length === 1) {
          var singleton = cluster[0];
          var heavy =
            Number(singleton.estMinutes || 0) >= 45 ||
            (singleton.appliances || []).length > 0;
          if (!heavy) continue;
        }

        out.clusters.push(cluster);
        var sug = clusterToSuggestion(cluster, ctx);
        out.suggestions.push(sug);
      }
    }

    out.graph = globalGraph;

    try {
      if (
        ctx &&
        ctx.emitEvents &&
        eventBus &&
        typeof eventBus.emit === "function"
      ) {
        eventBus.emit("prep:consolidation:ready", {
          clusters: out.clusters.length,
          suggestions: out.suggestions.length,
        });
      }
    } catch (e) {}

    return out;
  }

  /**
   * toBatchSession(suggestion)
   * Convert a suggestion into a Batch Session plan payload for your Batch Session Planner.
   */
  function toBatchSession(suggestion) {
    if (!suggestion) return null;
    var tasks = suggestion.tasks || [];
    var items = [];
    for (var i = 0; i < tasks.length; i++) {
      items.push({
        taskId: tasks[i].id,
        title: tasks[i].title,
        domain: tasks[i].domain,
        estMinutes: tasks[i].estMinutes,
        room: tasks[i].room,
        zone: tasks[i].zone,
        tools: tasks[i].tools || [],
        appliances: tasks[i].appliances || [],
        ingredients: tasks[i].ingredients || [],
        consumables: tasks[i].consumables || [],
        flags: tasks[i].flags || [],
      });
    }
    return {
      id: suggestion.id,
      title: suggestion.title,
      window: suggestion.window,
      items: items,
      checklist: suggestion.checklist,
    };
  }

  /**
   * mergeChecklists(list) — Merge multiple suggestion checklists into one deduped list.
   */
  function mergeChecklists(list) {
    var steps = [];
    var tools = [];
    var consumables = [];
    var appliances = [];
    var ingredients = [];
    for (var i = 0; i < (list || []).length; i++) {
      var cl = list[i] && list[i].checklist;
      if (!cl) continue;
      steps = steps.concat(cl.steps || []);
      tools = tools.concat(cl.tools || []);
      consumables = consumables.concat(cl.consumables || []);
      appliances = appliances.concat(cl.appliances || []);
      ingredients = ingredients.concat(cl.ingredients || []);
    }
    // de-dupe steps by label order-preserving
    var seen = {};
    var stepOut = [];
    for (var s = 0; s < steps.length; s++) {
      var lbl = steps[s].label;
      if (!seen[lbl]) {
        seen[lbl] = 1;
        stepOut.push(steps[s]);
      }
    }
    return {
      steps: stepOut,
      tools: uniq(tools),
      consumables: uniq(consumables),
      appliances: uniq(appliances),
      ingredients: uniq(ingredients),
    };
  }

  // ------------------------------- Exports -----------------------------------
  module.exports = {
    analyze: analyze,
    toBatchSession: toBatchSession,
    mergeChecklists: mergeChecklists,
    _internals: {
      normalizeTask: normalizeTask,
      pairScore: pairScore,
      buildGraph: buildGraph,
      clusterize: clusterize,
      buildPrepChecklist: buildPrepChecklist,
      clusterToSuggestion: clusterToSuggestion,
    },
  };
})();

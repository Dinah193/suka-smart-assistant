/* eslint-disable no-console */
// placementRules.js — variety / leftovers / appliance + zone/weather/species rules (ES2015-safe)

(function () {
  // ----------------------------- Safe Imports -----------------------------
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

  var HouseholdCalendar = {
    getEventsInRange: function () {
      return [];
    },
  };
  try {
    HouseholdCalendar =
      require("@/store/HouseholdCalendarStore") || HouseholdCalendar;
  } catch (e) {}

  var logger = console;

  // ------------------------------- Constants ------------------------------
  var DAY_MS = 24 * 60 * 60 * 1000;

  // ------------------------------- Utilities ------------------------------
  function clamp(v, a, b) {
    if (a === void 0) a = 0;
    if (b === void 0) b = 1;
    return Math.max(a, Math.min(b, v));
  }

  function asDate(v) {
    return v instanceof Date ? v : new Date(v);
  }

  function sameDay(a, b) {
    var A = asDate(a);
    var B = asDate(b);
    return (
      A.getFullYear() === B.getFullYear() &&
      A.getMonth() === B.getMonth() &&
      A.getDate() === B.getDate()
    );
  }

  function getId(recipe) {
    if (!recipe) return null;
    return (
      recipe.id ||
      recipe._id ||
      recipe.slug ||
      recipe.title ||
      recipe.name ||
      null
    );
  }

  function deepMerge() {
    var out = {};
    for (var i = 0; i < arguments.length; i++) {
      var o = arguments[i];
      if (!o || typeof o !== "object") continue;
      var keys = Object.keys(o);
      for (var j = 0; j < keys.length; j++) {
        var k = keys[j];
        var val = o[k];
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
      preferences: {
        variety: {
          proteinCooldownDays: 2,
          cuisineCooldownDays: 3,
          techniqueCooldownDays: 2,
          breakfastRepeatsPerWeek: 5,
        },
        leftovers: {
          autoPlace: true,
          defaultMealType: "lunch",
          windowDays: 2,
          reserveAs: "LEFTOVER",
        },
        zones: {
          default: "indoor", // assume indoor when unspecified
          windMaxKphForGrill: 35,
          rainBlockForOutdoor: true,
          heatWarnC: 32,
          coldWarnC: -5,
        },
        species: {
          blockOnQuarantine: true,
        },
      },
    };

    var ctxPrefs =
      ctx && ctx.preferences ? { preferences: ctx.preferences } : {};
    var runtimePrefs = {};
    try {
      var fromRuntime =
        automation && typeof automation.get === "function"
          ? automation.get("placement.rules")
          : null;
      if (fromRuntime && typeof fromRuntime === "object") {
        runtimePrefs = { preferences: fromRuntime };
      }
    } catch (e) {}

    var merged = deepMerge(base, ctxPrefs, runtimePrefs);
    return merged.preferences;
  }

  function extractTagValue(tags, prefix) {
    if (!Array.isArray(tags)) return null;
    var p = String(prefix).toLowerCase() + ":";
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      if (typeof t !== "string") continue;
      var tl = t.toLowerCase();
      if (tl.indexOf(p) === 0) {
        return tl.slice(p.length);
      }
    }
    return null;
  }

  function hasTag(tags, value) {
    if (!Array.isArray(tags)) return false;
    var v = String(value).toLowerCase();
    for (var i = 0; i < tags.length; i++) {
      if (String(tags[i]).toLowerCase() === v) return true;
    }
    return false;
  }

  function firstNonEmpty() {
    for (var i = 0; i < arguments.length; i++) {
      if (
        arguments[i] !== undefined &&
        arguments[i] !== null &&
        arguments[i] !== ""
      )
        return arguments[i];
    }
    return null;
  }

  function gatherRecent(ctx, slotDate, mealType, windowDays) {
    var plan = (ctx && ctx.plan) || [];
    var end = asDate(slotDate);
    var start = new Date(end.getTime() - windowDays * DAY_MS);
    var out = [];
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      var d = asDate((p.slot && (p.slot.start || p.slot.date)) || p.slot);
      var okRange = d >= start && d <= end;
      var okMeal = !mealType || (p.slot && p.slot.mealType === mealType);
      if (okRange && okMeal) out.push(p);
    }
    return out;
  }

  function enumerateWeek(ctx, slotDate) {
    var d = asDate(slotDate);
    var startOfWeek = new Date(d);
    startOfWeek.setDate(d.getDate() - d.getDay()); // Sunday
    var days = [];
    var byDay = {};
    for (var i = 0; i < 7; i++) {
      var day = new Date(startOfWeek.getTime() + i * DAY_MS);
      days.push(day);
      var list = [];
      var plan = (ctx && ctx.plan) || [];
      for (var j = 0; j < plan.length; j++) {
        var p = plan[j];
        if (sameDay(p.slot && p.slot.start, day)) list.push(p);
      }
      byDay[day.toDateString()] = list;
    }
    return { days: days, byDay: byDay };
  }

  function mkFix(label, payload) {
    return { label: label, payload: payload || {} };
  }

  // ------------------------------- Variety Rule ------------------------------
  function varietyCheck(recipe, slot, ctx) {
    var prefs = loadPrefs(ctx);
    var reasons = [];
    var fixes = [];

    var slotDate = asDate((slot && (slot.start || slot.date)) || slot);
    var mealType = slot && slot.mealType ? slot.mealType : "dinner";

    var protein = extractTagValue(recipe && recipe.tags, "protein");
    var cuisine = extractTagValue(recipe && recipe.tags, "cuisine");
    var technique = extractTagValue(recipe && recipe.tags, "technique");

    var protRecents = gatherRecent(
      ctx,
      slotDate,
      null,
      prefs.variety.proteinCooldownDays
    );
    var cuisRecents = gatherRecent(
      ctx,
      slotDate,
      null,
      prefs.variety.cuisineCooldownDays
    );
    var techRecents = gatherRecent(
      ctx,
      slotDate,
      null,
      prefs.variety.techniqueCooldownDays
    );

    var ok = true;

    if (protein) {
      for (var i = 0; i < protRecents.length; i++) {
        var pr = protRecents[i];
        if (
          extractTagValue(pr.recipe && pr.recipe.tags, "protein") === protein
        ) {
          ok = false;
          reasons.push('Protein "' + protein + '" used recently.');
          fixes.push(
            mkFix("Swap protein or shift by +1 day", {
              type: "SHIFT_DAYS",
              days: 1,
            })
          );
          break;
        }
      }
    }

    if (cuisine) {
      for (var j = 0; j < cuisRecents.length; j++) {
        var cr = cuisRecents[j];
        if (
          extractTagValue(cr.recipe && cr.recipe.tags, "cuisine") === cuisine
        ) {
          ok = false;
          reasons.push(
            'Cuisine "' + cuisine + '" repeated in cooldown window.'
          );
          fixes.push(
            mkFix("Pick a different cuisine style", {
              type: "ALTER_TAG",
              tag: "cuisine",
            })
          );
          break;
        }
      }
    }

    if (technique) {
      for (var k = 0; k < techRecents.length; k++) {
        var tr = techRecents[k];
        if (
          extractTagValue(tr.recipe && tr.recipe.tags, "technique") ===
          technique
        ) {
          ok = false;
          reasons.push('Technique "' + technique + '" used recently.');
          fixes.push(
            mkFix("Change technique (e.g., bake vs. saute)", {
              type: "ALTER_TAG",
              tag: "technique",
            })
          );
          break;
        }
      }
    }

    if (mealType === "breakfast") {
      var week = enumerateWeek(ctx, slotDate);
      var flat = [];
      var dayKeys = Object.keys(week.byDay);
      for (var d = 0; d < dayKeys.length; d++) {
        var key = dayKeys[d];
        flat = flat.concat(week.byDay[key]);
      }
      var breakfasts = [];
      for (var m = 0; m < flat.length; m++) {
        var it = flat[m];
        if (it.slot && it.slot.mealType === "breakfast") breakfasts.push(it);
      }
      var title = ((recipe && recipe.title) || "").toLowerCase();
      var repeats = 0;
      for (var n = 0; n < breakfasts.length; n++) {
        var bt = (
          (breakfasts[n].recipe && breakfasts[n].recipe.title) ||
          ""
        ).toLowerCase();
        if (bt === title) repeats++;
      }
      if (repeats >= prefs.variety.breakfastRepeatsPerWeek) {
        ok = false;
        reasons.push("Breakfast repeat cap reached for the week.");
        fixes.push(
          mkFix("Pick a different breakfast or reduce repeats", {
            type: "ALTER_TITLE",
          })
        );
      }
    }

    return { ok: ok, reasons: reasons, fixes: fixes };
  }

  // ----------------------------- Leftovers Rule ------------------------------
  function estimatePredictsLeftovers(recipe) {
    var s = Number((recipe && recipe.servings) || 0);
    var time = Number((recipe && recipe.totalTimeMinutes) || 0);
    var batchy = false;
    if (recipe && Array.isArray(recipe.tags)) {
      for (var i = 0; i < recipe.tags.length; i++) {
        var t = String(recipe.tags[i]).toLowerCase();
        if (t.indexOf("batch") >= 0) {
          batchy = true;
          break;
        }
      }
    }
    return s >= 4 || time >= 60 || batchy;
  }

  function isCookingConflict(slot, ctx) {
    var plan = (ctx && ctx.plan) || [];
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      var same =
        sameDay(p.slot && p.slot.start, slot.start) &&
        (p.slot && p.slot.mealType) === slot.mealType &&
        !(p.meta && p.meta.type === "LEFTOVER");
      if (same) return true;
    }
    return false;
  }

  function leftoversCheck(recipe, slot, ctx) {
    var prefs = loadPrefs(ctx);
    var reasons = [];
    var fixes = [];
    var reservations = [];

    var pol = (recipe && recipe.leftoverPolicy) || {};
    var predicts = !!pol.predictsLeftovers || estimatePredictsLeftovers(recipe);
    if (!predicts)
      return {
        ok: true,
        reasons: reasons,
        fixes: fixes,
        reservations: reservations,
      };

    var servings = Number((recipe && recipe.servings) || 0);
    var leftoverServings = Number(
      pol.leftoverServings || Math.max(0, servings - 1)
    );
    if (leftoverServings <= 0)
      return {
        ok: true,
        reasons: reasons,
        fixes: fixes,
        reservations: reservations,
      };

    var slotDate = asDate((slot && (slot.start || slot.date)) || slot);
    var keepDays = Number(
      pol.keepDays || Math.max(2, prefs.leftovers.windowDays)
    );
    var targetMealType =
      pol.preferredMealType || prefs.leftovers.defaultMealType || "lunch";

    if (!prefs.leftovers.autoPlace) {
      reasons.push("Leftovers likely (" + leftoverServings + " servings).");
      fixes.push(
        mkFix("Auto-place leftovers (enable in settings)", {
          type: "ENABLE_AUTO_LEFTOVERS",
        })
      );
      return {
        ok: true,
        reasons: reasons,
        fixes: fixes,
        reservations: reservations,
      };
    }

    for (var d = 1; d <= keepDays; d++) {
      var day = new Date(slotDate.getTime() + d * DAY_MS);
      var candidate = { start: day, mealType: targetMealType };
      var conflict = isCookingConflict(candidate, ctx);
      if (!conflict) {
        reservations.push({
          type: prefs.leftovers.reserveAs,
          forRecipeId: getId(recipe),
          servings: leftoverServings,
          slot: candidate,
        });
        reasons.push(
          "Reserved leftovers on " +
            day.toDateString() +
            " (" +
            targetMealType +
            ")."
        );
        break;
      }
    }

    if (reservations.length === 0) {
      reasons.push("No suitable slot found for leftovers within window.");
      fixes.push(
        mkFix("Manually pick a leftovers slot", {
          type: "PICK_SLOT",
          withinDays: keepDays,
        })
      );
    }

    return {
      ok: true,
      reasons: reasons,
      fixes: fixes,
      reservations: reservations,
    };
  }

  // -------------------------- Appliance Conflict Rule ------------------------
  function checkApplianceWindows(recipe, slot, ctx, reasons, fixes) {
    var appliances = Array.isArray(recipe && recipe.appliances)
      ? recipe.appliances.map(function (a) {
          return String(a).toLowerCase();
        })
      : [];
    if (!appliances.length) return true;

    var start = asDate((slot && (slot.start || slot.date)) || slot);
    var end =
      slot && slot.end
        ? asDate(slot.end)
        : new Date(
            start.getTime() +
              Number((recipe && recipe.totalTimeMinutes) || 45) * 60000
          );

    var hardBlocks = (ctx && ctx.applianceAvailability) || {};
    if (
      (!hardBlocks || !Object.keys(hardBlocks).length) &&
      automation &&
      typeof automation.get === "function"
    ) {
      var rb = automation.get("appliances.busy");
      if (rb && typeof rb === "object") hardBlocks = rb;
    }

    for (var i = 0; i < appliances.length; i++) {
      var app = appliances[i];
      var blocks = hardBlocks[app] || [];
      for (var j = 0; j < blocks.length; j++) {
        var b = blocks[j];
        var bs = asDate(b.start);
        var be = asDate(b.end);
        var overlap = !(end <= bs || start >= be);
        if (overlap) {
          reasons.push(
            'Appliance "' +
              app +
              '" is unavailable (' +
              (b.reason || "busy") +
              ")."
          );
          fixes.push(
            mkFix("Shift time beyond " + be.toLocaleString(), {
              type: "SHIFT_TIME",
              to: be,
            })
          );
          return false;
        }
      }
    }

    var calBusy =
      (ctx && Array.isArray(ctx.calendarBusy) && ctx.calendarBusy) ||
      (HouseholdCalendar &&
      typeof HouseholdCalendar.getEventsInRange === "function"
        ? HouseholdCalendar.getEventsInRange(start, end)
        : []);

    if (Array.isArray(calBusy)) {
      for (var k = 0; k < calBusy.length; k++) {
        var e = calBusy[k];
        var es = asDate(e.start);
        var ee = asDate(e.end);
        var overlap2 = !(end <= es || start >= ee);
        if (overlap2) {
          reasons.push(
            "Calendar busy window overlaps: " + (e.label || "event") + "."
          );
          fixes.push(mkFix("Choose a different slot", { type: "PICK_SLOT" }));
          return false;
        }
      }
    }

    var plan = (ctx && ctx.plan) || [];
    for (var p = 0; p < plan.length; p++) {
      var item = plan[p];
      var rApps = Array.isArray(item && item.recipe && item.recipe.appliances)
        ? item.recipe.appliances.map(function (a) {
            return String(a).toLowerCase();
          })
        : [];
      if (!rApps.length) continue;
      var ps = asDate(item.slot && item.slot.start);
      var pe =
        item.slot && item.slot.end
          ? asDate(item.slot.end)
          : new Date(
              ps.getTime() +
                Number((item.recipe && item.recipe.totalTimeMinutes) || 45) *
                  60000
            );
      var overlaps = !(end <= ps || start >= pe);
      if (!overlaps) continue;
      for (var r = 0; r < rApps.length; r++) {
        if (appliances.indexOf(rApps[r]) >= 0) {
          reasons.push(
            'Appliance conflict with "' +
              ((item.recipe && item.recipe.title) || item.recipeId) +
              '" (' +
              rApps[r] +
              ")."
          );
          fixes.push(
            mkFix("Adjust start time by +30m", {
              type: "SHIFT_MINUTES",
              minutes: 30,
            })
          );
          return false;
        }
      }
    }

    return true;
  }

  function applianceCheck(recipe, slot, ctx) {
    var reasons = [];
    var fixes = [];
    var ok = checkApplianceWindows(recipe, slot, ctx, reasons, fixes);
    return { ok: ok, reasons: reasons, fixes: fixes };
  }

  // --------------------------- Zone Availability Rule ------------------------
  /**
   * Honors zone:* tags and optional ctx.zoneAvailability / automation key "zones.busy".
   * Zones examples: indoor, outdoor, grill, kitchen, patio, barn
   */
  function zoneCheck(item, slot, ctx) {
    var prefs = loadPrefs(ctx);
    var reasons = [];
    var fixes = [];
    var zone =
      extractTagValue(item && item.tags, "zone") || prefs.zones.default;

    // Busy windows for zones (e.g., grill/patio reserved)
    var start = asDate((slot && (slot.start || slot.date)) || slot);
    var end =
      slot && slot.end
        ? asDate(slot.end)
        : new Date(start.getTime() + 60 * 60000);

    var busy = (ctx && ctx.zoneAvailability) || {};
    if (
      (!busy || !Object.keys(busy).length) &&
      automation &&
      typeof automation.get === "function"
    ) {
      var z = automation.get("zones.busy");
      if (z && typeof z === "object") busy = z;
    }

    var blocks = busy && busy[zone] ? busy[zone] : [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var bs = asDate(b.start);
      var be = asDate(b.end);
      var overlap = !(end <= bs || start >= be);
      if (overlap) {
        reasons.push(
          'Zone "' + zone + '" unavailable (' + (b.reason || "busy") + ")."
        );
        fixes.push(
          mkFix("Pick another zone or shift time", {
            type: "PICK_ZONE_OR_SHIFT",
            zone: zone,
            to: be,
          })
        );
        return { ok: false, reasons: reasons, fixes: fixes };
      }
    }

    return { ok: true, reasons: reasons, fixes: fixes, zone: zone };
  }

  // ------------------------------ Weather Rule --------------------------------
  /**
   * Uses ctx.weatherForecast(date) -> { precipProb, windKph, tempC, frostRisk, description }
   * Fallback: automation.get("weather.forecast") if function not provided.
   * Applies mainly to outdoor/grill tasks or garden tasks.
   */
  function weatherCheck(item, slot, ctx, zoneResult) {
    var prefs = loadPrefs(ctx);
    var reasons = [];
    var fixes = [];

    var zone =
      (zoneResult && zoneResult.zone) ||
      extractTagValue(item && item.tags, "zone") ||
      prefs.zones.default;
    var isOutdoor =
      zone === "outdoor" ||
      zone === "grill" ||
      zone === "patio" ||
      hasTag(item && item.tags, "outdoor");

    // garden task heuristic: outdoor by default
    if (!isOutdoor && item && item.domain === "garden") isOutdoor = true;

    if (!isOutdoor) {
      return { ok: true, reasons: reasons, fixes: fixes };
    }

    var when = asDate((slot && (slot.start || slot.date)) || slot);
    var forecastFunc =
      ctx && typeof ctx.weatherForecast === "function"
        ? ctx.weatherForecast
        : null;

    var forecast = null;
    try {
      if (forecastFunc) {
        forecast = forecastFunc(when);
      } else if (automation && typeof automation.get === "function") {
        var wf = automation.get("weather.forecast");
        if (typeof wf === "function") forecast = wf(when);
      }
    } catch (e) {}

    if (!forecast) {
      reasons.push("No forecast available; weather rule neutral.");
      return { ok: true, reasons: reasons, fixes: fixes };
    }

    var precipProb = Number(forecast.precipProb || forecast.rainProb || 0); // 0..1 or 0..100
    if (precipProb > 1) precipProb = precipProb / 100.0;
    var windKph = Number(forecast.windKph || forecast.wind || 0);
    var tempC = Number(forecast.tempC || forecast.temp || 0);
    var frostRisk = !!forecast.frostRisk;

    if (prefs.zones.rainBlockForOutdoor && precipProb >= 0.5) {
      reasons.push("High chance of rain for outdoor slot.");
      fixes.push(
        mkFix("Shift to indoor or change day", {
          type: "PICK_ZONE_OR_SHIFT",
          to: when,
          zone: "indoor",
        })
      );
      return { ok: false, reasons: reasons, fixes: fixes };
    }

    if (
      windKph >= prefs.zones.windMaxKphForGrill &&
      (zone === "grill" || hasTag(item && item.tags, "grill"))
    ) {
      reasons.push("Wind too strong for grill.");
      fixes.push(
        mkFix("Pick calmer slot or cook indoor variant", {
          type: "PICK_ZONE_OR_SHIFT",
          zone: "indoor",
        })
      );
      return { ok: false, reasons: reasons, fixes: fixes };
    }

    if (tempC >= prefs.zones.heatWarnC) {
      reasons.push("Heat advisory for outdoor work.");
      fixes.push(
        mkFix("Shift to cooler hours", { type: "SHIFT_HOURS", hours: -2 })
      );
    }
    if (tempC <= prefs.zones.coldWarnC) {
      reasons.push("Very cold for outdoor work.");
      fixes.push(
        mkFix("Shift to warmer hours", { type: "SHIFT_HOURS", hours: 2 })
      );
    }

    if (
      item &&
      item.domain === "garden" &&
      (item.kind === "transplant" || item.kind === "sow")
    ) {
      if (frostRisk) {
        reasons.push("Frost risk near task time.");
        fixes.push(
          mkFix("Delay until frost-safe", { type: "SHIFT_DAYS", days: 1 })
        );
        return { ok: false, reasons: reasons, fixes: fixes };
      }
    }

    return { ok: true, reasons: reasons, fixes: fixes };
  }

  // ------------------------------ Species Rule --------------------------------
  /**
   * Understands species:* tag and blocks if species is in a busy/quarantine window.
   * Sources: ctx.speciesBusy or automation "species.busy" (per species arrays of {start,end,reason,type}).
   * Also prevents overbooking species-specific service windows (e.g., milking).
   */
  function speciesCheck(item, slot, ctx) {
    var prefs = loadPrefs(ctx);
    var reasons = [];
    var fixes = [];

    // meal recipes may carry species:beef/pork (ignored for busy windows); animal-care tasks use barn species.
    var speciesTag = extractTagValue(item && item.tags, "species");
    if (
      !speciesTag &&
      Array.isArray(item && item.species) &&
      item.species.length
    ) {
      speciesTag = String(item.species[0]).toLowerCase();
    }
    if (!speciesTag) return { ok: true, reasons: reasons, fixes: fixes };

    var start = asDate((slot && (slot.start || slot.date)) || slot);
    var end =
      slot && slot.end
        ? asDate(slot.end)
        : new Date(start.getTime() + 60 * 60000);

    var windows = (ctx && ctx.speciesBusy) || {};
    if (
      (!windows || !Object.keys(windows).length) &&
      automation &&
      typeof automation.get === "function"
    ) {
      var wb = automation.get("species.busy");
      if (wb && typeof wb === "object") windows = wb;
    }

    var blocks = windows && windows[speciesTag] ? windows[speciesTag] : [];
    for (var i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      var bs = asDate(b.start);
      var be = asDate(b.end);
      var overlap = !(end <= bs || start >= be);
      if (overlap) {
        if (
          prefs.species.blockOnQuarantine ||
          (b.type && String(b.type).toLowerCase() === "quarantine")
        ) {
          reasons.push(
            'Species "' +
              speciesTag +
              '" unavailable (' +
              (b.reason || b.type || "busy") +
              ")."
          );
          fixes.push(
            mkFix("Choose different time or species", {
              type: "PICK_SLOT_OR_SPECIES",
              to: be,
              species: speciesTag,
            })
          );
          return { ok: false, reasons: reasons, fixes: fixes };
        } else {
          reasons.push(
            "Species window overlaps (" +
              (b.reason || "busy") +
              "). Proceed with caution."
          );
        }
      }
    }

    return { ok: true, reasons: reasons, fixes: fixes };
  }

  // ------------------------------ Public API ---------------------------------
  function canPlace(recipe, slot, ctx) {
    if (ctx === void 0) ctx = {};
    var reasons = [];
    var fixes = [];
    var reservations = [];

    // Original rules
    var v = varietyCheck(recipe, slot, ctx);
    var l = leftoversCheck(recipe, slot, ctx);
    var a = applianceCheck(recipe, slot, ctx);

    // New rules: zone → weather → species
    var z = zoneCheck(recipe, slot, ctx); // may return zone
    var w = weatherCheck(recipe, slot, ctx, z); // uses zone result if outdoor
    var s = speciesCheck(recipe, slot, ctx);

    var ok = v.ok && l.ok && a.ok && z.ok && w.ok && s.ok;

    reasons = reasons.concat(
      v.reasons,
      l.reasons,
      a.reasons,
      z.reasons,
      w.reasons,
      s.reasons
    );
    fixes = fixes.concat(v.fixes, l.fixes, a.fixes, z.fixes, w.fixes, s.fixes);
    if (l.reservations && l.reservations.length) {
      reservations = reservations.concat(l.reservations);
    }

    try {
      if (!ok && eventBus && typeof eventBus.emit === "function") {
        eventBus.emit("placement:block", {
          recipeId: getId(recipe),
          slot: slot,
          reasons: reasons,
          fixes: fixes,
        });
      }
    } catch (e) {}

    return {
      ok: ok,
      reasons: reasons,
      fixes: fixes,
      reservations: reservations,
    };
  }

  function registerPlacement(recipe, slot, ctx) {
    if (ctx === void 0) ctx = {};
    if (!ctx.ephemeral) ctx.ephemeral = {};
    var key =
      asDate(slot && (slot.start || slot)).toDateString() +
      "::" +
      ((slot && slot.mealType) || "dinner");
    if (!ctx.ephemeral.byDayMeal) ctx.ephemeral.byDayMeal = {};
    if (!ctx.ephemeral.byDayMeal[key]) ctx.ephemeral.byDayMeal[key] = [];
    ctx.ephemeral.byDayMeal[key].push({
      recipeId: getId(recipe),
      recipe: recipe,
      slot: slot,
    });

    var apps = Array.isArray(recipe && recipe.appliances)
      ? recipe.appliances.map(function (a) {
          return String(a).toLowerCase();
        })
      : [];
    if (apps.length) {
      if (!ctx.ephemeral.applianceUse) ctx.ephemeral.applianceUse = {};
      var start = asDate(slot && (slot.start || slot));
      var end =
        slot && slot.end
          ? asDate(slot.end)
          : new Date(
              start.getTime() +
                Number((recipe && recipe.totalTimeMinutes) || 45) * 60000
            );
      for (var i = 0; i < apps.length; i++) {
        var app = apps[i];
        if (!ctx.ephemeral.applianceUse[app])
          ctx.ephemeral.applianceUse[app] = [];
        ctx.ephemeral.applianceUse[app].push({
          start: start,
          end: end,
          recipeId: getId(recipe),
        });
      }
    }

    try {
      if (eventBus && typeof eventBus.emit === "function") {
        eventBus.emit("placement:registered", {
          recipeId: getId(recipe),
          slot: slot,
        });
      }
    } catch (e) {}
  }

  function resolveApplianceConflicts(plan, ctx) {
    if (plan === void 0) plan = [];
    if (ctx === void 0) ctx = {};
    var conflicts = [];
    var fixes = [];

    var schedule = {};
    for (var i = 0; i < plan.length; i++) {
      var p = plan[i];
      var apps = Array.isArray(p && p.recipe && p.recipe.appliances)
        ? p.recipe.appliances.map(function (a) {
            return String(a).toLowerCase();
          })
        : [];
      var start = asDate(p.slot && p.slot.start);
      var end =
        p.slot && p.slot.end
          ? asDate(p.slot.end)
          : new Date(
              start.getTime() +
                Number((p.recipe && p.recipe.totalTimeMinutes) || 45) * 60000
            );
      for (var j = 0; j < apps.length; j++) {
        var app = apps[j];
        if (!schedule[app]) schedule[app] = [];
        schedule[app].push({ start: start, end: end, ref: p });
      }
    }

    var appKeys = Object.keys(schedule);
    for (var a = 0; a < appKeys.length; a++) {
      var appName = appKeys[a];
      var items = schedule[appName].sort(function (x, y) {
        return x.start - y.start;
      });
      for (var k = 1; k < items.length; k++) {
        var prev = items[k - 1];
        var curr = items[k];
        var overlap = !(curr.start >= prev.end);
        if (overlap) {
          conflicts.push({ appliance: appName, A: prev.ref, B: curr.ref });
          fixes.push(
            mkFix(
              'Shift "' +
                (curr.ref.recipe && curr.ref.recipe.title) +
                '" by +30m on ' +
                appName,
              {
                type: "SHIFT_MINUTES",
                minutes: 30,
                recipeId: getId(curr.ref.recipe),
              }
            )
          );
        }
      }
    }

    try {
      if (conflicts.length && eventBus && typeof eventBus.emit === "function") {
        eventBus.emit("placement:applianceConflicts", {
          conflicts: conflicts,
          fixes: fixes,
        });
      }
    } catch (e) {}

    return { plan: plan, conflicts: conflicts, fixes: fixes };
  }

  function suggestAlternateSlot(recipe, slot, ctx) {
    if (ctx === void 0) ctx = {};
    var reasons = [];
    var base = asDate((slot && (slot.start || slot)) || slot);
    var mealType = slot && slot.mealType ? slot.mealType : "dinner";

    var candidates = [
      { start: new Date(base.getTime() - DAY_MS), mealType: mealType },
      { start: new Date(base.getTime() + DAY_MS), mealType: mealType },
    ];

    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i];
      var check = canPlace(recipe, s, ctx);
      if (check.ok) {
        return {
          slot: s,
          reasons: [
            "Alternate slot available: " +
              s.start.toDateString() +
              " (" +
              mealType +
              ")",
          ],
        };
      } else {
        reasons.push(
          "Blocked alt (" +
            s.start.toDateString() +
            "): " +
            check.reasons.join("; ")
        );
      }
    }
    return { slot: null, reasons: reasons };
  }

  // ------------------------------ Exports ------------------------------------
  module.exports = {
    canPlace: canPlace,
    registerPlacement: registerPlacement,
    resolveApplianceConflicts: resolveApplianceConflicts,
    suggestAlternateSlot: suggestAlternateSlot,
    _internals: {
      varietyCheck: varietyCheck,
      leftoversCheck: leftoversCheck,
      applianceCheck: applianceCheck,
      zoneCheck: zoneCheck,
      weatherCheck: weatherCheck,
      speciesCheck: speciesCheck,
      loadPrefs: loadPrefs,
    },
  };
})();

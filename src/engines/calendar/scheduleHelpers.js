/* eslint-disable no-console */
// scheduleHelpers.js — PPE, Weather, and Withhold/Withdrawal reminders (ES2015-safe)
// Drop-in helper for Suka Smart Assistant automation runtime.
// Goals: defensive imports, session-aware reminders, NBA suggestions, zero-crash if services are missing.

(function () {
  // ----------------------------- Safe Imports -----------------------------
  var eventBus = { emit: function () {} };
  try {
    eventBus = (require("@/services/eventBus") || {}).eventBus || eventBus;
  } catch (_) {}

  var automation = { schedule: function () {}, nowISO: function () { return new Date().toISOString(); } };
  try {
    automation = require("@/services/automation/runtime") || automation;
  } catch (_) {}

  var ReminderManager = { schedule: function () {}, bulkSchedule: function () {} };
  try {
    ReminderManager = require("@/managers/ReminderManager") || ReminderManager;
  } catch (_) {}

  var Inventory = {
    has: function () { return false; },
    findMissing: function () { return []; }
  };
  try {
    var inv = require("@/managers/InventoryMonitor");
    if (inv) {
      Inventory.has = function (skuOrName) {
        try { return !!inv.hasItem && !!inv.hasItem(skuOrName); } catch (_) { return false; }
      };
      Inventory.findMissing = function (list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
          if (!Inventory.has(list[i])) out.push(list[i]);
        }
        return out;
      };
    }
  } catch (_) {}

  var Weather = {
    // Returns array of simple forecasts: [{ at: ISO, tempC, windKph, gustKph, precipChance, precipType, uv, condition }]
    forecast: function (_args) { return []; },
    // Returns current snapshot: { tempC, windKph, gustKph, precipType, precipChance, condition, daylight }
    now: function (_args) { return null; }
  };
  try {
    var weatherSvc = require("@/services/weather");
    if (weatherSvc) {
      Weather.forecast = function (args) {
        try { return weatherSvc.getWindowForecast(args) || []; } catch (_) { return []; }
      };
      Weather.now = function (args) {
        try { return weatherSvc.getCurrent(args) || null; } catch (_) { return null; }
      };
    }
  } catch (_) {}

  var Settings = { tz: "America/New_York", locale: "en-US" };
  try {
    var settings = require("@/stores/SettingsStore") || {};
    Settings.tz = (settings.get && settings.get("timezone")) || Settings.tz;
    Settings.locale = (settings.get && settings.get("locale")) || Settings.locale;
  } catch (_) {}

  // Optional registries (medications, pesticides PHI, etc.)
  var WithholdRegistry = {
    // Example shape; tasks can override via task.withhold.days or task.withhold.until
    animal: {
      // med code/name: days
      ivermectin: 35,
      fenbendazole: 6,
      praziquantel: 0,
      oxytetracycline: 28
    },
    garden: {
      // pesticide/fungicide code/name: pre-harvest interval (days)
      neem_oil: 0,
      spinosad: 1,
      copper_fungicide: 1,
      pyrethrin: 3,
      bacillus_thuringiensis: 0
    }
  };
  try {
    var reg = require("@/data/withhold.registry.json");
    if (reg && typeof reg === "object") WithholdRegistry = reg;
  } catch (_) {}

  // Species and crop profiles (optional)
  var SpeciesProfiles = {};
  try { SpeciesProfiles = require("@/data/species.profiles.json") || SpeciesProfiles; } catch (_) {}
  var CropProfiles = {};
  try { CropProfiles = require("@/data/crop.profiles.json") || CropProfiles; } catch (_) {}

  // ----------------------------- Tiny Utils -----------------------------
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function toISO(d) { return (d instanceof Date ? d : new Date(d || Date.now())).toISOString(); }
  function addMinutes(iso, mins) { var d = new Date(iso || Date.now()); d.setMinutes(d.getMinutes() + (mins || 0)); return d.toISOString(); }
  function addDays(iso, days) { var d = new Date(iso || Date.now()); d.setDate(d.getDate() + (days || 0)); return d.toISOString(); }
  function id(prefix) { return (prefix || "rem") + ":" + Math.random().toString(36).slice(2, 10); }
  function fmtDuration(mins) { return (mins >= 60 ? (Math.floor(mins/60) + "h " + (mins%60) + "m") : (mins + "m")); }
  function uniq(arr) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = String(arr[i]);
      if (!seen[k]) { seen[k] = 1; out.push(arr[i]); }
    }
    return out;
  }

  function read(obj, key, fallback) {
    try {
      var parts = key.split(".");
      var cur = obj;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null) return fallback;
        cur = cur[parts[i]];
      }
      return cur == null ? fallback : cur;
    } catch (_) { return fallback; }
  }

  // ----------------------------- PPE Planning -----------------------------
  // Derives PPE list from task and profiles; returns {required, missing, notes}
  function planPPE(task) {
    task = task || {};
    var base = Array.isArray(task.ppe) ? task.ppe.slice() : [];
    var kind = task.kind || ""; // "cooking" | "cleaning" | "animal" | "butchery" | "garden"
    var flags = task.flags || []; // e.g., ["biohazard","raw-meat","caustic","sharp"]
    var extra = [];

    // Rule-of-thumb enrichments
    if (kind === "butchery" || flags.indexOf("raw-meat") >= 0) extra = extra.concat(["gloves","apron","cut-resistant gloves","face shield"]);
    if (kind === "animal" && flags.indexOf("biohazard") >= 0) extra = extra.concat(["gloves","eye protection","respirator (N95)"]);
    if (kind === "cleaning" && flags.indexOf("caustic") >= 0) extra = extra.concat(["gloves","eye protection","respirator (chem)","apron"]);
    if (kind === "garden" && (flags.indexOf("spray") >= 0 || flags.indexOf("pesticide") >= 0)) extra = extra.concat(["gloves","eye protection","respirator (chem)","long sleeves","boots"]);
    if (flags.indexOf("sharp") >= 0) extra = extra.concat(["cut-resistant gloves"]);

    // Profile-based PPE (species or crop)
    var species = task.species && String(task.species).toLowerCase();
    if (species && SpeciesProfiles[species] && Array.isArray(SpeciesProfiles[species].ppe)) {
      extra = extra.concat(SpeciesProfiles[species].ppe);
    }
    var crop = task.crop && String(task.crop).toLowerCase();
    if (crop && CropProfiles[crop] && Array.isArray(CropProfiles[crop].ppe)) {
      extra = extra.concat(CropProfiles[crop].ppe);
    }

    var required = uniq(base.concat(extra));
    var missing = Inventory.findMissing(required);
    var notes = [];

    if (missing.length) {
      notes.push("Missing PPE: " + missing.join(", "));
    }
    if (kind === "cleaning" && flags.indexOf("ventilation") >= 0) {
      notes.push("Ensure adequate ventilation before starting.");
    }
    if (kind === "butchery") {
      notes.push("Confirm sanitation station is set and chill chain timers are armed.");
    }
    return { required: required, missing: missing, notes: notes };
  }

  // Schedules a pre-task PPE reminder
  function schedulePPEReminder(task, session) {
    var ctx = session || {};
    var startISO = toISO(read(task, "startAt", automation.nowISO()));
    var ppePlan = planPPE(task);

    var msg = "[PPE Check] " + (task.title || "Task") + "\n• Required: " + (ppePlan.required.join(", ") || "—");
    if (ppePlan.missing.length) msg += "\n• Missing: " + ppePlan.missing.join(", ");
    if (ppePlan.notes.length) msg += "\n• Notes: " + ppePlan.notes.join(" ");

    var when = addMinutes(startISO, -10); // remind 10 minutes before start
    var payload = {
      id: id("ppe"),
      at: when,
      message: msg,
      tags: ["ppe","safety","nba"],
      linkTo: { sessionId: ctx.id || read(task, "sessionId") || null, taskId: task.id || null },
      data: { type: "ppe", required: ppePlan.required, missing: ppePlan.missing }
    };

    try {
      (ReminderManager.schedule || automation.schedule || function(){ })(payload);
    } catch (_) {}
    try { eventBus.emit("reminder.created", payload); } catch (_) {}
    try {
      eventBus.emit("nba.suggestion.created", {
        id: payload.id,
        kind: "safety",
        title: "PPE check before “" + (task.title || "task") + "”",
        actionLabel: "Open checklist",
        action: { type: "openPPEChecklist", params: payload.data }
      });
    } catch (_) {}

    return payload;
  }

  // ----------------------------- Weather Planning -----------------------------
  // Evaluate weather constraints and schedule alerts
  function planWeather(task) {
    task = task || {};
    var env = task.env || {};
    var loc = task.location || {};
    var windowStart = toISO(task.startAt || automation.nowISO());
    var windowEnd = toISO(task.endAt || addMinutes(windowStart, task.durationMin || 60));
    var windowMins = Math.max(5, (new Date(windowEnd) - new Date(windowStart)) / 60000);

    // Default heuristics
    var avoidRain = !!env.avoidRain || (task.kind === "garden" && (task.flags || []).indexOf("spray") >= 0);
    var avoidHighWind = !!env.avoidHighWind || (task.kind === "garden" && (task.flags || []).indexOf("spray") >= 0);
    var windLimit = env.maxWindKph || (avoidHighWind ? 15 : 999);
    var daylightOnly = !!env.daylightOnly || task.kind === "garden";
    var tempMin = read(env, "tempRange.0", null);
    var tempMax = read(env, "tempRange.1", null);

    // Pull forecast (defensive)
    var fc = [];
    try {
      fc = Weather.forecast({ start: windowStart, end: windowEnd, location: loc });
    } catch (_) { fc = []; }

    // Assess risk windows
    var issues = [];
    for (var i = 0; i < fc.length; i++) {
      var p = fc[i] || {};
      var tempC = typeof p.tempC === "number" ? p.tempC : null;
      var windKph = typeof p.windKph === "number" ? p.windKph : 0;
      var precipChance = typeof p.precipChance === "number" ? p.precipChance : 0;
      var precipType = p.precipType || "precip";
      var daylight = (typeof p.daylight === "boolean") ? p.daylight : true;

      if (avoidRain && precipChance >= 40) {
        issues.push({ at: p.at, type: "rain", msg: "Rain (" + precipChance + "%) likely." });
      }
      if (windKph >= windLimit) {
        issues.push({ at: p.at, type: "wind", msg: "High wind (" + windKph + " kph) above limit " + windLimit + " kph." });
      }
      if (daylightOnly && !daylight) {
        issues.push({ at: p.at, type: "dark", msg: "Not in daylight." });
      }
      if (tempMin != null && tempC != null && tempC < tempMin) {
        issues.push({ at: p.at, type: "cold", msg: "Temp " + tempC + "°C below min " + tempMin + "°C." });
      }
      if (tempMax != null && tempC != null && tempC > tempMax) {
        issues.push({ at: p.at, type: "heat", msg: "Temp " + tempC + "°C above max " + tempMax + "°C." });
      }
    }

    return { issues: issues, window: { start: windowStart, end: windowEnd, minutes: windowMins } };
  }

  function scheduleWeatherAlerts(task, session) {
    var plan = planWeather(task);
    var issued = [];

    if (!plan.issues.length) {
      // Pre-flight heads-up if spraying or weather-sensitive but no issues detected
      var sensitive = (task.kind === "garden" && (task.flags || []).some(function (f){ return f === "spray" || f === "transplant"; })) ||
                      (task.kind === "butchery") ||
                      (task.kind === "animal" && (task.flags || []).indexOf("heat-stress-risk") >= 0);
      if (sensitive) {
        var msg = "[Weather OK] " + (task.title || "Task") + " — no forecasted conflicts in the planned window (" + fmtDuration(plan.window.minutes) + ").";
        var payloadOk = {
          id: id("wxok"),
          at: addMinutes(plan.window.start, -15),
          message: msg,
          tags: ["weather","heads-up"],
          linkTo: { sessionId: (session && session.id) || null, taskId: task.id || null },
          data: { type: "weather-ok" }
        };
        try { (ReminderManager.schedule || automation.schedule || function(){ })(payloadOk); } catch (_){}
        try { eventBus.emit("reminder.created", payloadOk); } catch (_){}
        issued.push(payloadOk);
      }
      return issued;
    }

    // Otherwise, schedule a consolidated alert 30 min before window
    var notes = [];
    for (var i = 0; i < plan.issues.length; i++) {
      notes.push("• " + plan.issues[i].msg + " (" + (plan.issues[i].at || "time TBA") + ")");
    }
    var msgWarn = "[Weather Risk] " + (task.title || "Task") + "\n" + notes.join("\n");
    var payloadWarn = {
      id: id("wx"),
      at: addMinutes(plan.window.start, -30),
      message: msgWarn,
      tags: ["weather","risk","nba"],
      linkTo: { sessionId: (session && session.id) || null, taskId: task.id || null },
      data: { type: "weather", issues: plan.issues }
    };
    try { (ReminderManager.schedule || automation.schedule || function(){ })(payloadWarn); } catch (_){}
    try { eventBus.emit("reminder.created", payloadWarn); } catch (_){}
    try {
      eventBus.emit("nba.suggestion.created", {
        id: payloadWarn.id,
        kind: "reschedule",
        title: "Weather risk for “" + (task.title || "task") + "”",
        actionLabel: "See better time",
        action: { type: "openWeatherSmartRescheduler", params: { window: plan.window, issues: plan.issues } }
      });
    } catch (_){}

    issued.push(payloadWarn);
    return issued;
  }

  // ----------------------------- Withhold / Withdrawal Planning -----------------------------
  // Supports animal product withdrawal and garden pre-harvest intervals
  // task.withhold: { type: 'meat'|'milk'|'eggs'|'harvest', days?: number, until?: ISO, source?: 'ivermectin'|'spinosad'... }
  function resolveWithholdDays(task) {
    var w = task.withhold || {};
    if (w.days != null) return clamp(parseInt(w.days, 10) || 0, 0, 365);
    if (w.until) {
      var d = new Date(w.until);
      var now = new Date(read(task, "appliedAt", task.startAt || automation.nowISO()));
      var diff = Math.ceil((d - now) / 86400000);
      return clamp(diff, 0, 365);
    }
    var domain = (task.kind === "garden" || w.type === "harvest") ? "garden" : "animal";
    var src = (w.source || "").toLowerCase();
    if (src && WithholdRegistry[domain] && WithholdRegistry[domain][src] != null) {
      return clamp(parseInt(WithholdRegistry[domain][src], 10) || 0, 0, 365);
    }
    return 0;
  }

  function scheduleWithholdReminders(task, session) {
    var w = task.withhold || null;
    if (!w) return [];

    var appliedISO = toISO(read(task, "appliedAt", task.startAt || automation.nowISO()));
    var days = resolveWithholdDays(task);
    var untilISO = addDays(appliedISO, days);

    var product = (w.type || (task.kind === "garden" ? "harvest" : "meat")).toLowerCase();
    var note = "[Withhold Active] " + (task.title || "Task") +
      "\n• Product: " + product.toUpperCase() +
      "\n• Duration: " + days + " day(s)" +
      (w.source ? ("\n• Agent: " + w.source) : "") +
      "\n• Safe after: " + untilISO;

    var idStart = id("wh-start");
    var idEnd = id("wh-end");

    var reminders = [
      {
        id: idStart,
        at: addMinutes(appliedISO, 5),
        message: note,
        tags: ["withhold","safety","compliance","nba"],
        linkTo: { sessionId: (session && session.id) || null, taskId: task.id || null },
        data: { type: "withhold-start", product: product, days: days, until: untilISO, source: w.source || null }
      },
      {
        id: idEnd,
        at: addMinutes(untilISO, 10),
        message: "[Withhold Clear] You can now resume use of " + product.toUpperCase() + ".",
        tags: ["withhold","clear"],
        linkTo: { sessionId: (session && session.id) || null, taskId: task.id || null },
        data: { type: "withhold-end", product: product, since: appliedISO }
      }
    ];

    // Block calendar/inventory if supported
    try { eventBus.emit("inventory.hold.created", { product: product, until: untilISO, reason: "withhold", refTaskId: task.id || null }); } catch (_){}
    try { eventBus.emit("calendar.block.range", { start: appliedISO, end: untilISO, label: "WITHHOLD: " + product.toUpperCase(), color: "warning" }); } catch (_){}

    // Schedule
    for (var i = 0; i < reminders.length; i++) {
      try { (ReminderManager.schedule || automation.schedule || function(){ })(reminders[i]); } catch (_){}
      try { eventBus.emit("reminder.created", reminders[i]); } catch (_){}
    }

    // NBA chip
    try {
      eventBus.emit("nba.suggestion.created", {
        id: idStart,
        kind: "compliance",
        title: "Withhold in effect: " + product.toUpperCase(),
        actionLabel: "View policy",
        action: { type: "openWithholdDetails", params: { product: product, until: untilISO, days: days, source: w.source || null } }
      });
    } catch (_){}

    return reminders;
  }

  // ----------------------------- Orchestrator -----------------------------
  // Schedules all relevant reminders for a task: PPE (pre), Weather (pre), Withhold (span)
  // Returns a flat array of scheduled reminder payloads.
  function scheduleAll(task, session) {
    if (!task) return [];
    var out = [];
    try { out.push(schedulePPEReminder(task, session)); } catch (e) { console.warn("PPE schedule error:", e && e.message); }
    try {
      var wx = scheduleWeatherAlerts(task, session);
      if (wx && wx.length) out = out.concat(wx);
    } catch (e2) { console.warn("Weather schedule error:", e2 && e2.message); }
    try {
      var wh = scheduleWithholdReminders(task, session);
      if (wh && wh.length) out = out.concat(wh);
    } catch (e3) { console.warn("Withhold schedule error:", e3 && e3.message); }

    // Filter falsy / normalize
    var flat = [];
    for (var i = 0; i < out.length; i++) {
      if (!out[i]) continue;
      if (Array.isArray(out[i])) {
        for (var j = 0; j < out[i].length; j++) if (out[i][j]) flat.push(out[i][j]);
      } else {
        flat.push(out[i]);
      }
    }
    return flat;
  }

  // ----------------------------- Public API -----------------------------
  var api = {
    planPPE: planPPE,
    schedulePPEReminder: schedulePPEReminder,
    planWeather: planWeather,
    scheduleWeatherAlerts: scheduleWeatherAlerts,
    scheduleWithholdReminders: scheduleWithholdReminders,
    scheduleAll: scheduleAll
  };

  // UMD-ish export
  try { module.exports = api; } catch (_) { this.scheduleHelpers = api; }
})();

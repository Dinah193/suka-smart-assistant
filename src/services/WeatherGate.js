/* eslint-disable no-console */
/**
 * WeatherGate.js — Provider-agnostic weather normalizer + risk assessor (ES2015-safe)
 *
 * Goals
 *  • Pluggable adapters: registerProvider("openmeteo", fn), registerProvider("noaa", fn), etc.
 *  • Normalized shape for hourly/daily data + inferred metrics (heatIndex, windChill, wetBulb, rainProb).
 *  • Fast dev: in-memory cache (per key) with TTL + stale-while-revalidate support.
 *  • Pure by default (no events). Optional builders create catalog-compliant events for NBA/Conflict UIs.
 *  • Helpers to assess per-task weather risk and find earliest “safe window” for outdoor tasks.
 *
 * No new event names are emitted here. Use the synthetic builders if you want:
 *    buildPlannerWeatherConflictEvent(conflictLike)
 * which produces: { name: "planner.conflict.detected", payload: { kind:"weather", domain, conflict } }
 */

(function () {
  /* ----------------------------- Safe Imports ----------------------------- */
  var eventBus = {
    emit: function () {},
    on: function () {},
    off: function () {},
  };
  try {
    var eb = require("@/services/events/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus)) || eventBus;
  } catch (e) {
    /* noop */
  }

  var scheduleHelpers = {
    now: function () {
      return Date.now();
    },
    // shiftWindow({start,end}, minutes)
    shiftWindow: function (win, mins) {
      return !win
        ? null
        : { start: win.start + mins * 60000, end: win.end + mins * 60000 };
    },
  };
  try {
    scheduleHelpers =
      require("@/engines/schedule/scheduleHelpers") || scheduleHelpers;
  } catch (e) {}

  var SafetyRules = null;
  try {
    SafetyRules = require("@/libraries/SafetyRules");
  } catch (e) {}

  /* ------------------------------- Types ---------------------------------- */
  /**
   * NormalizedWeather:
   * {
   *   location: { lat, lon, name?, tz? },
   *   range: { start, end },
   *   hourly: [{ t:number(ms), tempC, rh, windKph, gustKph?, precipMm, precipProb, cloud, uv?, heatIndexC?, windChillC?, wetBulbC? }],
   *   daily:  [{ d:number(ms), tMinC, tMaxC, rhAvg, windKphMax, precipMm, precipProbMax, uvMax?, sunrise?, sunset? }],
   *   meta: { provider, fetchedAt:number(ms), units:{...} }
   * }
   */

  /* ------------------------------- Registry -------------------------------- */
  var providers = Object.create(null);
  function registerProvider(name, fetchFn) {
    providers[name] = fetchFn;
  }
  function listProviders() {
    return Object.keys(providers);
  }

  /* -------------------------------- Cache ---------------------------------- */
  // Simple in-memory cache keyed by provider|lat|lon|start|end (rounded)
  var CACHE = Object.create(null);
  var DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

  function cacheKey(p, lat, lon, start, end) {
    function r(x) {
      return Math.round(x * 1000) / 1000;
    }
    return [
      p,
      r(lat),
      r(lon),
      Math.floor(start / 3600000),
      Math.floor(end / 3600000),
    ].join("|");
  }

  function getCached(p, lat, lon, start, end) {
    var k = cacheKey(p, lat, lon, start, end);
    var e = CACHE[k];
    if (!e) return null;
    var fresh = scheduleHelpers.now() - e.storedAt < (e.ttl || DEFAULT_TTL_MS);
    return { entry: e, isFresh: fresh, key: k };
  }

  function putCache(key, value, ttl) {
    CACHE[key] = {
      value: value,
      storedAt: scheduleHelpers.now(),
      ttl: ttl || DEFAULT_TTL_MS,
    };
  }

  /* --------------------------- Math / Conversions -------------------------- */
  function cToF(c) {
    return (c * 9) / 5 + 32;
  }
  function fToC(f) {
    return ((f - 32) * 5) / 9;
  }
  function kphToMph(k) {
    return k * 0.621371;
  }

  // Heat Index approximation (Steadman/Rothfusz; inputs in °C and %RH)
  function heatIndexC(tempC, rh) {
    if (tempC == null || rh == null) return null;
    var T = cToF(tempC);
    var R = rh;
    if (T < 80) return tempC; // HI ~= T under 80°F
    var HI =
      -42.379 +
      2.04901523 * T +
      10.14333127 * R -
      0.22475541 * T * R -
      6.83783e-3 * T * T -
      5.481717e-2 * R * R +
      1.22874e-3 * T * T * R +
      8.5282e-4 * T * R * R -
      1.99e-6 * T * T * R * R;
    // adjustments
    if (R < 13 && T >= 80 && T <= 112)
      HI -= ((13 - R) / 4) * Math.sqrt((17 - Math.abs(T - 95)) / 17);
    if (R > 85 && T >= 80 && T <= 87) HI += ((R - 85) / 10) * ((87 - T) / 5);
    return fToC(HI);
  }

  // Wind chill (Steadman), inputs °C and kph; valid when tempC <= 10°C and windKph > 4.8
  function windChillC(tempC, windKph) {
    if (tempC == null || windKph == null) return null;
    if (tempC > 10 || windKph <= 4.8) return tempC;
    return (
      13.12 +
      0.6215 * tempC -
      11.37 * Math.pow(windKph, 0.16) +
      0.3965 * tempC * Math.pow(windKph, 0.16)
    );
  }

  // Simple wet-bulb approximation (Stull 2011)
  function wetBulbC(tempC, rh) {
    if (tempC == null || rh == null) return null;
    var T = tempC,
      R = rh;
    var Tw =
      T * Math.atan(0.151977 * Math.sqrt(R + 8.313659)) +
      Math.atan(T + R) -
      Math.atan(R - 1.676331) +
      0.00391838 * Math.pow(R, 1.5) * Math.atan(0.023101 * R) -
      4.686035;
    return Tw;
  }

  /* --------------------------- Normalization utils ------------------------- */
  function ensureMetricsOnHourly(hourly) {
    for (var i = 0; i < (hourly || []).length; i++) {
      var h = hourly[i];
      if (typeof h.heatIndexC !== "number")
        h.heatIndexC = heatIndexC(h.tempC, h.rh);
      if (typeof h.windChillC !== "number")
        h.windChillC = windChillC(h.tempC, h.windKph);
      if (typeof h.wetBulbC !== "number") h.wetBulbC = wetBulbC(h.tempC, h.rh);
    }
    return hourly;
  }

  function normalize(out) {
    if (!out) return null;
    out.hourly = ensureMetricsOnHourly(out.hourly || []);
    out.daily = out.daily || [];
    return out;
  }

  /* --------------------------- Safe Windows / Risk ------------------------- */
  /**
   * assessRiskAt(hour): returns { level: "low"|"medium"|"high", reasons:[], flags:{heat,cold,storm,wind,precip,uv} }
   */
  function assessRiskAt(hour) {
    if (!hour) return { level: "low", reasons: [], flags: {} };
    var reasons = [];
    var flags = {};
    var level = "low";

    // Heat
    var hi = hour.heatIndexC;
    if (typeof hi === "number") {
      if (hi >= 32) {
        level = bump(level, "high");
        reasons.push("Dangerous heat index");
        flags.heat = true;
      } else if (hi >= 27) {
        level = bump(level, "medium");
        reasons.push("Elevated heat index");
        flags.heat = true;
      }
    }
    // Cold/WindChill
    var wc = hour.windChillC;
    if (typeof wc === "number") {
      if (wc <= -15) {
        level = bump(level, "high");
        reasons.push("Severe wind chill");
        flags.cold = true;
      } else if (wc <= 0) {
        level = bump(level, "medium");
        reasons.push("Low wind chill");
        flags.cold = true;
      }
    }
    // Wind
    if (typeof hour.gustKph === "number" && hour.gustKph >= 45) {
      level = bump(level, "high");
      reasons.push("Strong gusts");
      flags.wind = true;
    } else if (typeof hour.windKph === "number" && hour.windKph >= 30) {
      level = bump(level, "medium");
      reasons.push("Windy");
      flags.wind = true;
    }
    // Precip
    if (typeof hour.precipProb === "number") {
      if (hour.precipProb >= 0.7) {
        level = bump(level, "high");
        reasons.push("High precipitation probability");
        flags.precip = true;
      } else if (hour.precipProb >= 0.4) {
        level = bump(level, "medium");
        reasons.push("Chance of precipitation");
        flags.precip = true;
      }
    }
    // UV (if available)
    if (typeof hour.uv === "number") {
      if (hour.uv >= 8) {
        level = bump(level, "high");
        reasons.push("Very high UV");
        flags.uv = true;
      } else if (hour.uv >= 5) {
        level = bump(level, "medium");
        reasons.push("Moderate UV");
        flags.uv = true;
      }
    }
    return { level: level, reasons: reasons, flags: flags };
  }

  function bump(curr, next) {
    var order = ["low", "medium", "high"];
    return order[Math.max(order.indexOf(curr), order.indexOf(next))];
  }

  /**
   * findSafeWindows(weather, opts) → [{ start, end, score, reasons }]
   * opts: { horizonHours?: number, minBlockMinutes?: number, avoidFlags?:{heat?:boolean,precip?:boolean,wind?:boolean,uv?:boolean}, preferEarly?:boolean }
   */
  function findSafeWindows(weather, opts) {
    opts = opts || {};
    var horizonH = Math.max(1, opts.horizonHours || 48);
    var minBlockMin = Math.max(15, opts.minBlockMinutes || 45);
    var avoid = opts.avoidFlags || { heat: true, precip: true, wind: true };
    var now = scheduleHelpers.now();
    var until = now + horizonH * 60 * 60 * 1000;

    var slots = [];
    var active = null;
    for (var i = 0; i < (weather.hourly || []).length; i++) {
      var h = weather.hourly[i];
      if (h.t < now || h.t > until) continue;
      var risk = assessRiskAt(h);
      var ok = true;
      if (avoid.heat && risk.flags.heat) ok = false;
      if (avoid.precip && risk.flags.precip) ok = false;
      if (avoid.wind && risk.flags.wind) ok = false;

      if (ok) {
        if (!active)
          active = { start: h.t, end: h.t + 60 * 60 * 1000, reasons: [] };
        else active.end = h.t + 60 * 60 * 1000;
      } else {
        if (active) {
          slots.push(active);
          active = null;
        }
      }
    }
    if (active) slots.push(active);

    // Filter by min block length and score them (earlier & longer preferred)
    var out = [];
    for (var j = 0; j < slots.length; j++) {
      var durMin = Math.round((slots[j].end - slots[j].start) / 60000);
      if (durMin < minBlockMin) continue;
      var earliness = 1 - (slots[j].start - now) / (horizonH * 60 * 60 * 1000);
      var score = Math.round(50 * earliness + Math.min(50, durMin / 2));
      out.push({
        start: slots[j].start,
        end: slots[j].end,
        score: score,
        reasons: [],
      });
    }
    // Prefer early windows if requested
    out.sort(function (a, b) {
      if (opts.preferEarly) return a.start - b.start;
      return b.score - a.score;
    });
    return out;
  }

  /* ------------------------- Task-Level Risk Assessor ---------------------- */
  /**
   * assessTaskWeather(task, weather, domain) -> { level, reasons, suggestions:[], safeWindows:[] }
   * task: { id, title, indoor?, tags?:[], timeWindow? }
   */
  function assessTaskWeather(task, weather, domain) {
    domain = domain || (task && task.domain) || "garden";
    if (!task || task.indoor === true)
      return { level: "low", reasons: [], suggestions: [], safeWindows: [] };

    var reasons = [];
    var level = "low";
    var suggestions = [];

    // Evaluate planned window if present; otherwise find next safe windows
    var w = task.timeWindow || null;
    if (w) {
      var hits = (weather.hourly || []).filter(function (h) {
        return h.t >= w.start && h.t <= w.end;
      });
      var worst = "low";
      for (var i = 0; i < hits.length; i++) {
        var r = assessRiskAt(hits[i]);
        worst = bump(worst, r.level);
      }
      level = worst;
      if (level !== "low") {
        reasons.push("Planned time has elevated environmental risk.");
        suggestions.push({
          title: "Find earliest safe window",
          autoApply: false,
          intent: "option",
          emit: {
            name: "planner.schedule.safeWindow.requested",
            payload: { itemId: task.id },
          },
        });
        suggestions.push({
          title: "Add PPE & hydration plan",
          autoApply: false,
          intent: "option",
          emit: {
            name: "prep.tasks.requested",
            payload: {
              domain: domain,
              tasks: [
                "Hydration break every 30–45 min",
                "Sun/heat or cold protection",
              ],
            },
          },
        });
      }
    }

    // Offer safe windows regardless
    var safe = findSafeWindows(weather, {
      horizonHours: 72,
      minBlockMinutes: 30,
      preferEarly: true,
    });
    return {
      level: level,
      reasons: reasons,
      suggestions: suggestions,
      safeWindows: safe,
    };
  }

  /* ------------------------------- Fetch Core ------------------------------ */
  /**
   * getWeather({ lat, lon, name?, tz? }, { start, end, provider?, preferCache?:true, ttlMs?, allowStale?:true })
   * Returns normalized weather with computed metrics (pure; no events).
   */
  function getWeather(loc, range, opts) {
    loc = loc || {};
    range = range || {};
    opts = opts || {};
    var provider = opts.provider || listProviders()[0] || "devLocal";
    if (!providers[provider]) provider = "devLocal";

    var start = range.start || scheduleHelpers.now() - 60 * 60 * 1000;
    var end = range.end || scheduleHelpers.now() + 48 * 60 * 60 * 1000;
    var lat = Number(loc.lat || 0);
    var lon = Number(loc.lon || 0);

    var ck = cacheKey(provider, lat, lon, start, end);
    var cached = getCached(provider, lat, lon, start, end);

    // Prefer cache if available
    if (cached && cached.isFresh && opts.preferCache !== false) {
      return Promise.resolve(normalize(cached.entry.value));
    }

    // If we have stale and allowStale, return quickly and optionally revalidate in background
    if (cached && !cached.isFresh && opts.allowStale !== false) {
      // fire-and-forget revalidation
      try {
        providers[provider](lat, lon, start, end)
          .then(function (fresh) {
            putCache(ck, fresh, opts.ttlMs);
          })
          .catch(function () {});
      } catch (e) {}
      return Promise.resolve(normalize(cached.entry.value));
    }

    // Fetch fresh
    return providers[provider](lat, lon, start, end)
      .then(function (raw) {
        putCache(ck, raw, opts.ttlMs);
        return normalize(raw);
      })
      .catch(function (err) {
        console.warn(
          "[WeatherGate] provider failed:",
          provider,
          err && err.message
        );
        // last-resort: devLocal
        if (provider !== "devLocal" && providers["devLocal"]) {
          var fallback = providers["devLocal"](lat, lon, start, end);
          return Promise.resolve(fallback).then(normalize);
        }
        // return stale if any
        if (cached) return Promise.resolve(normalize(cached.entry.value));
        // otherwise return an empty shell
        return Promise.resolve(
          normalize({
            location: {
              lat: lat,
              lon: lon,
              name: loc.name || "Unknown",
              tz: loc.tz || "America/Chicago",
            },
            range: { start: start, end: end },
            hourly: [],
            daily: [],
            meta: {
              provider: provider,
              fetchedAt: scheduleHelpers.now(),
              units: { temp: "C", wind: "kph", precip: "mm" },
            },
          })
        );
      });
  }

  /* ------------------------------ Dev Provider ----------------------------- */
  // “devLocal” — deterministic mock for offline dev and tests.
  registerProvider("devLocal", function (lat, lon, start, end) {
    // Generate hourly temps that rise in day and fall at night; sprinkle precipProb.
    var out = {
      location: { lat: lat, lon: lon, name: "DevLocal", tz: "America/Chicago" },
      range: { start: start, end: end },
      hourly: [],
      daily: [],
      meta: {
        provider: "devLocal",
        fetchedAt: Date.now(),
        units: { temp: "C", wind: "kph", precip: "mm" },
      },
    };
    var t = Math.floor(start / (60 * 60 * 1000)) * 60 * 60 * 1000;
    while (t <= end) {
      var hour = new Date(t).getHours();
      var base = 14 + 10 * Math.sin((Math.PI * (hour - 6)) / 12); // ~14–24°C curve
      var rh = 40 + (hour < 6 || hour > 18 ? 20 : 5);
      var wind = 8 + (hour > 12 ? 6 : 2);
      var gust = wind + (hour > 15 ? 12 : 4);
      var precipProb = hour > 15 && hour < 21 ? 0.35 : 0.1;
      out.hourly.push({
        t: t,
        tempC: base,
        rh: rh,
        windKph: wind,
        gustKph: gust,
        precipMm: 0,
        precipProb: precipProb,
        cloud: hour > 11 && hour < 18 ? 0.2 : 0.5,
        uv: hour > 10 && hour < 16 ? 7 : 2,
      });
      t += 60 * 60 * 1000;
    }
    // roll up daily
    var dayCursor = new Date(start);
    dayCursor.setHours(12, 0, 0, 0);
    while (dayCursor.getTime() <= end) {
      var d = dayCursor.getTime();
      var dayHours = out.hourly.filter(function (h) {
        var hd = new Date(h.t);
        hd.setHours(12, 0, 0, 0);
        return hd.getTime() === d;
      });
      if (dayHours.length) {
        var temps = dayHours.map(function (h) {
          return h.tempC;
        });
        var rhAvg = avg(
          dayHours.map(function (h) {
            return h.rh;
          })
        );
        var windMax = Math.max.apply(
          null,
          dayHours.map(function (h) {
            return h.windKph;
          })
        );
        var precipProbMax = Math.max.apply(
          null,
          dayHours.map(function (h) {
            return h.precipProb;
          })
        );
        out.daily.push({
          d: d,
          tMinC: Math.min.apply(null, temps),
          tMaxC: Math.max.apply(null, temps),
          rhAvg: rhAvg,
          windKphMax: windMax,
          precipMm: 0,
          precipProbMax: precipProbMax,
          uvMax: Math.max.apply(
            null,
            dayHours.map(function (h) {
              return h.uv || 0;
            })
          ),
        });
      }
      dayCursor = new Date(d + 24 * 60 * 60 * 1000);
    }
    return Promise.resolve(out);
  });

  function avg(arr) {
    if (!arr.length) return 0;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  /* ------------------------- Synthetic Event Builders ---------------------- */
  // Use these to integrate without inventing new event names.
  function buildPlannerWeatherConflictEvent(task, domain, weather) {
    var assess = assessTaskWeather(task, weather, domain);
    if (assess.level === "low") return null;

    var score = assess.level === "high" ? 75 : 55;
    return {
      name: "planner.conflict.detected",
      payload: {
        kind: "weather",
        domain: domain || (task && task.domain) || "garden",
        conflict: {
          id: "weather:" + task.id,
          kind: "weather",
          domain: domain || "garden",
          title: "Weather risk for '" + (task.title || task.id) + "'",
          rationale:
            assess.reasons.join("; ") ||
            "Outdoor conditions may reduce success or safety.",
          score: score,
          affected: [task.id],
          suggestions: [
            {
              title: "Find safe window",
              autoApply: false,
              intent: "option",
              emit: {
                name: "planner.schedule.safeWindow.requested",
                payload: { itemId: task.id },
              },
            },
            {
              title: "Add PPE & hydration plan",
              autoApply: false,
              intent: "option",
              emit: {
                name: "prep.tasks.requested",
                payload: {
                  domain: domain || "garden",
                  tasks: [
                    "Hydration break every 30–45 min",
                    "Sun/heat or cold protection",
                  ],
                },
              },
            },
          ],
        },
      },
    };
  }

  /* --------------------------------- API ----------------------------------- */
  var api = {
    // Providers
    registerProvider: registerProvider,
    listProviders: listProviders,

    // Fetch/Normalize
    getWeather: getWeather,

    // Metrics/Assessors
    assessRiskAt: assessRiskAt,
    findSafeWindows: findSafeWindows,
    assessTaskWeather: assessTaskWeather,

    // Math helpers
    cToF: cToF,
    fToC: fToC,
    heatIndexC: heatIndexC,
    windChillC: windChillC,
    wetBulbC: wetBulbC,
    kphToMph: kphToMph,

    // Events (pure builders)
    buildPlannerWeatherConflictEvent: buildPlannerWeatherConflictEvent,
  };

  /* ----------------------------- Export (CJS/UMD) -------------------------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof define === "function" && define.amd) {
    // eslint-disable-next-line no-undef
    define(function () {
      return api;
    });
  } else {
    // eslint-disable-next-line no-undef
    this.WeatherGate = api;
  }
}).call(
  typeof global !== "undefined"
    ? global
    : typeof window !== "undefined"
    ? window
    : this
);

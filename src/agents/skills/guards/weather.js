/**
 * @file src/agents/skills/guards/weather.js
 *
 * Weather condition guard helper for Suka Smart Assistant (SSA).
 *
 * HOW THIS FITS:
 * - This module is the low-level weather classifier used by:
 *   - the `weather` guard inside `guardsEvaluate.js` (via `env.weatherSnapshot`),
 *   - any “Now” resolver / scheduler that wants to avoid starting
 *     outdoor sessions in unsafe conditions,
 *   - a potential weather-aware swap modal that suggests alternative
 *     tasks when weather blocks the current step.
 *
 * CONTRACT WITH guardsEvaluate:
 * - `guardsEvaluate.weatherGuard` expects `env.weatherSnapshot` to be an
 *   object with at least:
 *   {
 *     severity: 'ok'|'rain'|'storm'|'danger'|'heat'|'cold'|'snow'|'wind',
 *     tempF: number|null,
 *     windMph: number|null,
 *     precipitationType: 'none'|'rain'|'snow'|'sleet',
 *     precipitationIntensity: 'none'|'light'|'moderate'|'heavy',
 *     alerts: string[],
 *     lastUpdated: ISO string|null
 *   }
 *
 * - This file provides:
 *   - `normalizeWeatherSnapshot(raw)` → normalized snapshot in that shape.
 *   - `evaluateWeather(raw, options)` → higher-level decision
 *      (allow / warn / block) + suggestions.
 */

import { emit } from '../../../services/eventBus';

/**
 * @typedef {'ok'|'rain'|'storm'|'danger'|'heat'|'cold'|'snow'|'wind'} WeatherSeverity
 */

/**
 * @typedef {'none'|'light'|'moderate'|'heavy'} PrecipitationIntensity
 */

/**
 * @typedef {'none'|'rain'|'snow'|'sleet'} PrecipitationType
 */

/**
 * Normalized weather snapshot used by the weather guard.
 *
 * @typedef {Object} NormalizedWeatherSnapshot
 * @property {WeatherSeverity} severity
 * @property {number|null} tempF
 * @property {number|null} windMph
 * @property {PrecipitationType} precipitationType
 * @property {PrecipitationIntensity} precipitationIntensity
 * @property {string[]} alerts
 * @property {string|null} lastUpdated
 * @property {Object} [raw] Arbitrary original API response (for debugging)
 */

/**
 * Options that influence how we evaluate safety.
 *
 * @typedef {Object} WeatherEvaluationOptions
 * @property {boolean} [requiresOutdoor]   True if the step must be performed outside
 * @property {boolean} [involvesTravel]    True if user must travel (e.g., drive) to perform this
 * @property {{ min: number, max: number }} [comfortTempRangeF]  Optional comfort band
 * @property {number} [maxWindMph]         Optional max comfortable wind speed
 */

/**
 * High-level weather evaluation result.
 *
 * @typedef {Object} WeatherEvaluationResult
 * @property {boolean} isSafe                 True if “normal household operations” allowed
 * @property {'allow'|'warn'|'block'} decision
 * @property {WeatherSeverity} severity
 * @property {string} reasonCode              'noData'|'ok'|'precipitation'|'storm'|'alerts'|'extremeTemp'|'wind'|'danger'
 * @property {string[]} suggestions           Human-readable suggestions for UI / swap modal
 * @property {string[]} warnings              Non-fatal config/data issues
 * @property {NormalizedWeatherSnapshot|null} snapshot
 */

/**
 * Normalize arbitrary weather data into a canonical snapshot that the
 * guards and SessionRunner understand.
 *
 * This function is intentionally tolerant — it will accept most shapes
 * of API data and do its best to classify them into our small set of
 * severities and fields.
 *
 * @param {any} raw
 * @returns {NormalizedWeatherSnapshot|null}
 */
export function normalizeWeatherSnapshot(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  // Attempt to pull some common fields from various weather APIs
  const tempF = extractTempF(raw);
  const windMph = extractWindMph(raw);
  const { precipitationType, precipitationIntensity } = extractPrecipitation(raw);
  const alerts = extractAlerts(raw);
  const lastUpdated = extractLastUpdated(raw);

  const severity = classifySeverity({
    tempF,
    windMph,
    precipitationType,
    precipitationIntensity,
    alerts
  });

  /** @type {NormalizedWeatherSnapshot} */
  const snapshot = {
    severity,
    tempF,
    windMph,
    precipitationType,
    precipitationIntensity,
    alerts,
    lastUpdated,
    raw
  };

  return snapshot;
}

/**
 * Evaluate whether weather is safe for the current operation, using
 * normalized snapshot + options.
 *
 * Example:
 * ```js
 * const snapshot = normalizeWeatherSnapshot(apiResponse);
 * const result = evaluateWeather(snapshot, { requiresOutdoor: true });
 *
 * if (result.decision === 'block') {
 *   // Use guardsEvaluate + swap modal to suggest indoor tasks instead
 * }
 * ```
 *
 * @param {any} rawOrSnapshot Either raw API data or a normalized snapshot
 * @param {WeatherEvaluationOptions} [options]
 * @returns {WeatherEvaluationResult}
 */
export function evaluateWeather(rawOrSnapshot, options = {}) {
  /** @type {WeatherEvaluationResult} */
  const baseResult = {
    isSafe: true,
    decision: 'allow',
    severity: 'ok',
    reasonCode: 'ok',
    suggestions: [],
    warnings: [],
    snapshot: null
  };

  const snapshot =
    rawOrSnapshot && rawOrSnapshot.severity
      ? /** @type {NormalizedWeatherSnapshot} */ (rawOrSnapshot)
      : normalizeWeatherSnapshot(rawOrSnapshot);

  if (!snapshot) {
    const res = {
      ...baseResult,
      isSafe: true, // allow but warn; guards can choose to be more strict if desired
      decision: 'warn',
      reasonCode: 'noData',
      warnings: ['Weather data unavailable; treating conditions as safe by default.'],
      snapshot: null
    };
    safeEmitWeatherEvaluated(res);
    return res;
  }

  const o = options || {};
  let { severity } = snapshot;
  /** @type {string[]} */
  const suggestions = [];
  /** @type {string[]} */
  const warnings = [];

  const requiresOutdoor = !!o.requiresOutdoor;
  const involvesTravel = !!o.involvesTravel;

  // Start from severity classification
  /** @type {'allow'|'warn'|'block'} */
  let decision = 'allow';
  /** @type {string} */
  let reasonCode = 'ok';

  if (severity === 'danger' || severity === 'storm') {
    decision = 'block';
    reasonCode = severity === 'storm' ? 'storm' : 'danger';
    suggestions.push(
      'Avoid outdoor or travel-related tasks.',
      'Consider indoor tasks or reschedule this session.'
    );
  } else if (severity === 'rain' || severity === 'snow') {
    decision = requiresOutdoor || involvesTravel ? 'warn' : 'allow';
    reasonCode = 'precipitation';
    if (requiresOutdoor) {
      suggestions.push('Consider swapping to an indoor task until precipitation eases.');
    }
    if (involvesTravel) {
      suggestions.push('Allow extra travel time and use caution on roads.');
    }
  } else if (severity === 'heat' || severity === 'cold') {
    decision = requiresOutdoor ? 'warn' : 'allow';
    reasonCode = 'extremeTemp';
    if (requiresOutdoor) {
      suggestions.push(
        'Limit time outside and take breaks.',
        'Stay hydrated and watch for signs of heat or cold stress.'
      );
    }
  } else if (severity === 'wind') {
    decision = requiresOutdoor ? 'warn' : 'allow';
    reasonCode = 'wind';
    if (requiresOutdoor) {
      suggestions.push(
        'Secure loose items before starting outdoor tasks.',
        'Avoid working under large tree branches or unstable structures.'
      );
    }
  } else {
    // severity === 'ok'
    decision = 'allow';
    reasonCode = 'ok';
  }

  // Extra pass: refine decision based on comfort ranges if provided
  if (snapshot.tempF != null && o.comfortTempRangeF) {
    const { min, max } = o.comfortTempRangeF;
    if (snapshot.tempF < min || snapshot.tempF > max) {
      if (decision === 'allow') {
        decision = 'warn';
        reasonCode = 'extremeTemp';
      }
      suggestions.push(
        `Temperature (${snapshot.tempF}°F) is outside the comfort range (${min}–${max}°F).`
      );
    }
  }

  if (snapshot.windMph != null && o.maxWindMph != null) {
    if (snapshot.windMph > o.maxWindMph && decision !== 'block') {
      decision = 'warn';
      reasonCode = 'wind';
      suggestions.push(
        `Wind speed (${snapshot.windMph} mph) is above your preferred limit (${o.maxWindMph} mph).`
      );
    }
  }

  // Alerts override: if there are severe alerts, we may upgrade to block/warn
  if (snapshot.alerts && snapshot.alerts.length) {
    if (decision === 'allow') {
      decision = requiresOutdoor || involvesTravel ? 'warn' : 'allow';
      reasonCode = 'alerts';
    }
    warnings.push('Weather alerts present; review local guidance.');
  }

  const isSafe = decision !== 'block';

  const result = {
    ...baseResult,
    isSafe,
    decision,
    severity,
    reasonCode,
    suggestions,
    warnings,
    snapshot
  };

  safeEmitWeatherEvaluated(result);
  return result;
}

/**
 * Convenience helper that just returns the normalized snapshot.
 *
 * Typically used by:
 * - An integration layer that fetches from some weather API and wants to
 *   stash a simplified snapshot on `env.weatherSnapshot`.
 *
 * @param {any} raw
 * @returns {NormalizedWeatherSnapshot|null}
 */
export function toGuardWeatherSnapshot(raw) {
  return normalizeWeatherSnapshot(raw);
}

/* -------------------------------------------------------------------------- */
/*  Severity classification helpers                                           */
/* -------------------------------------------------------------------------- */

/**
 * Internal helper for severity classification from primitive fields.
 *
 * @param {Object} params
 * @param {number|null} params.tempF
 * @param {number|null} params.windMph
 * @param {PrecipitationType} params.precipitationType
 * @param {PrecipitationIntensity} params.precipitationIntensity
 * @param {string[]} params.alerts
 * @returns {WeatherSeverity}
 */
function classifySeverity({ tempF, windMph, precipitationType, precipitationIntensity, alerts }) {
  // Alerts can elevate severity to danger, but we assume guard-level logic can be stricter.
  if (Array.isArray(alerts) && alerts.length) {
    const lowered = alerts.join(' ').toLowerCase();
    if (
      lowered.includes('tornado') ||
      lowered.includes('hurricane') ||
      lowered.includes('flash flood') ||
      lowered.includes('severe thunderstorm') ||
      lowered.includes('blizzard')
    ) {
      return 'danger';
    }
  }

  // Strong precipitation
  if (
    precipitationType === 'rain' &&
    (precipitationIntensity === 'moderate' || precipitationIntensity === 'heavy')
  ) {
    return 'rain';
  }

  if (
    precipitationType === 'snow' &&
    (precipitationIntensity === 'moderate' || precipitationIntensity === 'heavy')
  ) {
    return 'snow';
  }

  // Extreme temps (very rough bands; adjust to your locale)
  if (typeof tempF === 'number') {
    if (tempF >= 100) return 'heat';
    if (tempF <= 20) return 'cold';
  }

  // High winds (heuristic)
  if (typeof windMph === 'number' && windMph >= 35) {
    return 'wind';
  }

  // Light precipitation
  if (
    precipitationType === 'rain' &&
    (precipitationIntensity === 'light' || precipitationIntensity === 'moderate')
  ) {
    return 'rain';
  }

  if (
    precipitationType === 'snow' &&
    (precipitationIntensity === 'light' || precipitationIntensity === 'moderate')
  ) {
    return 'snow';
  }

  // If alerts exist but we didn't classify them as "danger" already, treat situation as "storm"
  if (Array.isArray(alerts) && alerts.length) {
    return 'storm';
  }

  return 'ok';
}

/* -------------------------------------------------------------------------- */
/*  Field extraction helpers                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Extract temperature in °F from various API shapes.
 *
 * @param {any} raw
 * @returns {number|null}
 */
function extractTempF(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Common patterns:
  // - raw.temp (°F)
  // - raw.temperature (°C or °F; we’ll assume °F if > 60)
  // - raw.current.temp (usually Kelvin or °C – we won't try to be too smart here)
  const maybe = getFirstDefined([
    raw.temp,
    raw.temperature,
    raw.apparentTemperature,
    raw.feels_like,
    raw.current && raw.current.temp
  ]);

  if (!Number.isFinite(maybe)) return null;

  const value = Number(maybe);

  // Heuristic: if < 60 and > -30, this might actually be °C; convert to °F.
  if (value < 60 && value > -30) {
    // You can adjust / remove this heuristic if your data is guaranteed °F.
    return Math.round((value * 9) / 5 + 32);
  }

  return value;
}

/**
 * Extract wind speed in mph from various API shapes.
 *
 * @param {any} raw
 * @returns {number|null}
 */
function extractWindMph(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Common shapes:
  // - raw.windSpeed (mph)
  // - raw.wind.speed (m/s or km/h; we will assume m/s and convert)
  // - raw.current.windSpeed
  const maybe = getFirstDefined([
    raw.windSpeed,
    raw.wind && raw.wind.speed,
    raw.current && raw.current.windSpeed
  ]);

  if (!Number.isFinite(maybe)) return null;

  const value = Number(maybe);

  // Heuristic: if value is < 30, treat as m/s and convert to mph.
  if (value < 30) {
    return Math.round(value * 2.23694); // m/s → mph
  }

  return value;
}

/**
 * Extract precipitation type & intensity.
 *
 * @param {any} raw
 * @returns {{ precipitationType: PrecipitationType, precipitationIntensity: PrecipitationIntensity }}
 */
function extractPrecipitation(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      precipitationType: 'none',
      precipitationIntensity: 'none'
    };
  }

  let precipitationType = /** @type {PrecipitationType} */ ('none');
  let precipitationIntensity = /** @type {PrecipitationIntensity} */ ('none');

  // Try to read a condition code/description
  const description = String(
    getFirstDefined([
      raw.description,
      raw.weather && raw.weather.description,
      raw.current && raw.current.summary,
      raw.current && raw.current.weather && raw.current.weather[0] && raw.current.weather[0].description
    ]) || ''
  ).toLowerCase();

  const intensity = getFirstDefined([
    raw.precipIntensity,
    raw.precipitationIntensity,
    raw.current && raw.current.precipIntensity
  ]);

  if (description.includes('rain') || description.includes('drizzle')) {
    precipitationType = 'rain';
  } else if (description.includes('snow') || description.includes('sleet')) {
    precipitationType = description.includes('sleet') ? 'sleet' : 'snow';
  }

  if (Number.isFinite(intensity)) {
    const val = Number(intensity);
    if (val <= 0.01) precipitationIntensity = 'light';
    else if (val <= 0.1) precipitationIntensity = 'moderate';
    else precipitationIntensity = 'heavy';
  } else if (description) {
    if (description.includes('light')) precipitationIntensity = 'light';
    else if (description.includes('heavy') || description.includes('storm')) {
      precipitationIntensity = 'heavy';
    } else if (precipitationType !== 'none') {
      precipitationIntensity = 'moderate';
    }
  }

  return { precipitationType, precipitationIntensity };
}

/**
 * Extract any alert messages into a simple string array.
 *
 * @param {any} raw
 * @returns {string[]}
 */
function extractAlerts(raw) {
  if (!raw || typeof raw !== 'object') return [];

  // Potential shapes:
  // - raw.alerts: string[]
  // - raw.alerts: [{ title, description }]
  // - raw.alert: { title, description }
  const alertsField = raw.alerts || raw.alert || raw.warnings;

  if (!alertsField) return [];

  /** @type {string[]} */
  const alerts = [];

  if (Array.isArray(alertsField)) {
    for (const item of alertsField) {
      if (typeof item === 'string') {
        alerts.push(item);
      } else if (item && typeof item === 'object') {
        const title = item.title || item.event || '';
        const desc = item.description || item.message || '';
        const text = [title, desc].filter(Boolean).join(': ');
        if (text) alerts.push(String(text));
      }
    }
    return alerts;
  }

  if (typeof alertsField === 'string') {
    alerts.push(alertsField);
    return alerts;
  }

  if (alertsField && typeof alertsField === 'object') {
    const title = alertsField.title || alertsField.event || '';
    const desc = alertsField.description || alertsField.message || '';
    const text = [title, desc].filter(Boolean).join(': ');
    if (text) alerts.push(String(text));
  }

  return alerts;
}

/**
 * Extract a reasonable "last updated" timestamp as ISO string.
 *
 * @param {any} raw
 * @returns {string|null}
 */
function extractLastUpdated(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const ts = getFirstDefined([
    raw.lastUpdated,
    raw.updated_at,
    raw.current && raw.current.time,
    raw.current && raw.current.dt
  ]);

  if (!ts) return null;

  if (typeof ts === 'number') {
    // Assume UNIX seconds
    const d = new Date(ts * 1000);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  if (typeof ts === 'string') {
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  return null;
}

/**
 * Return the first defined value in an array of candidates.
 *
 * @param {any[]} arr
 * @returns {any}
 */
function getFirstDefined(arr) {
  for (const v of arr) {
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/*  Event emission                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Emit `weather.evaluated` for telemetry / debugging.
 *
 * Payload:
 * {
 *   type: 'weather.evaluated',
 *   ts: ISO8601,
 *   source: 'guards.weather',
 *   data: WeatherEvaluationResult
 * }
 *
 * @param {WeatherEvaluationResult} result
 */
function safeEmitWeatherEvaluated(result) {
  try {
    if (typeof emit !== 'function') return;
    emit({
      type: 'weather.evaluated',
      ts: new Date().toISOString(),
      source: 'guards.weather',
      data: result
    });
  } catch (_err) {
    // Never crash guard logic because of eventBus failures.
    // console.warn('[guards.weather] Failed to emit weather.evaluated', _err);
  }
}

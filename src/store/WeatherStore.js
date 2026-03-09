// File: src/store/WeatherStore.js
/**
 * WeatherStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Local-first weather cache + simple forecast fetching for SSA.
 *  - Designed to support:
 *      • home dashboard "today" weather card
 *      • garden planning (rain, frost risk windows)
 *      • task scheduling suggestions (avoid storms)
 *  - Browser-safe, build-safe (no Node imports).
 *  - Provider-pluggable (default: Open-Meteo; no API key).
 *
 * Key behaviors
 *  - Stores "locations" and per-location forecast caches.
 *  - Provides stable selectors + actions (external-store pattern).
 *  - Persistence to localStorage (opt-in, on by default).
 *  - Optional eventBus emission (lazy dynamic import; no hard dependency).
 *
 * State shape (public)
 *  {
 *    meta: { version, hydrated, loading, error, lastUpdatedAt },
 *    settings: { units, refreshMinutes, persist, provider },
 *    activeLocationId: string|null,
 *    locations: { [id]: { id, label, lat, lon, tz, source, createdAt, updatedAt } },
 *    forecasts: {
 *      [locationId]: {
 *        provider, fetchedAt, expiresAt,
 *        current?: {...}, hourly?: {...}, daily?: {...}, alerts?: {...},
 *        raw?: any
 *      }
 *    }
 *  }
 */

const SOURCE = "store.WeatherStore";
const STORAGE_KEY = "ssa.weather.store.v1";
const VERSION = 1;

/* ----------------------------- Small safe helpers ---------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const nowISO = () => new Date().toISOString();
const nowMs = () => Date.now();

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function safeJsonStringify(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function stableIdFromLatLon(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return `loc_${nowMs()}`;
  // deterministic-ish ID at 4 decimals (~11m)
  const a = la.toFixed(4).replace(".", "_").replace("-", "m");
  const b = lo.toFixed(4).replace(".", "_").replace("-", "m");
  return `loc_${a}_${b}`;
}

function normalizeUnits(units) {
  const u = isObj(units) ? units : {};
  const temp = String(u.temp || "F").toUpperCase();
  const wind = String(u.wind || "mph").toLowerCase();
  const precip = String(u.precip || "in").toLowerCase();

  return {
    temp: temp === "C" ? "C" : "F",
    wind:
      wind === "ms" || wind === "m/s"
        ? "ms"
        : wind === "kmh" || wind === "km/h"
        ? "kmh"
        : "mph",
    precip: precip === "mm" ? "mm" : "in",
  };
}

function normalizeLocation(input) {
  const x = isObj(input) ? input : {};
  const lat = Number(x.lat ?? x.latitude);
  const lon = Number(x.lon ?? x.lng ?? x.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const id =
    isStr(x.id) && x.id.trim() ? x.id.trim() : stableIdFromLatLon(lat, lon);
  const label =
    isStr(x.label) && x.label.trim()
      ? x.label.trim()
      : isStr(x.name) && x.name.trim()
      ? x.name.trim()
      : `(${lat.toFixed(3)}, ${lon.toFixed(3)})`;

  const tz = isStr(x.tz) && x.tz.trim() ? x.tz.trim() : "auto";

  return {
    id,
    label,
    lat: clamp(lat, -90, 90),
    lon: clamp(lon, -180, 180),
    tz,
    source: isStr(x.source) ? x.source : "manual",
    createdAt: isStr(x.createdAt) ? x.createdAt : nowISO(),
    updatedAt: nowISO(),
  };
}

/* --------------------------- Optional event bus hook -------------------------- */

let _eventBusPromise = null;
async function getEventBus() {
  if (_eventBusPromise) return _eventBusPromise;
  _eventBusPromise = (async () => {
    try {
      // Try common SSA paths. If neither exists, return null.
      const mod =
        (await import(/* @vite-ignore */ "@/services/events/eventBus").catch(
          () => null
        )) ||
        (await import(/* @vite-ignore */ "@/services/events/eventBus.js").catch(
          () => null
        ));
      if (!mod) return null;
      return mod.default || mod.eventBus || mod.bus || null;
    } catch {
      return null;
    }
  })();
  return _eventBusPromise;
}

async function emitEvent(type, payload) {
  try {
    const bus = await getEventBus();
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(type, payload);
    else if (typeof bus.publish === "function")
      bus.publish({ type, ...payload });
  } catch {
    // no-op
  }
}

/* --------------------------- Provider (Open-Meteo) --------------------------- */
/**
 * Default provider: Open-Meteo (no API key).
 * Docs: https://open-meteo.com/
 *
 * We intentionally keep a small subset of variables that SSA typically needs.
 */

function providerToUrl_OpenMeteo({ lat, lon, tz, units }) {
  const temperature_unit = units.temp === "C" ? "celsius" : "fahrenheit";
  const windspeed_unit =
    units.wind === "kmh" ? "kmh" : units.wind === "ms" ? "ms" : "mph";
  const precipitation_unit = units.precip === "mm" ? "mm" : "inch";
  const timezone = tz && tz !== "auto" ? tz : "auto";

  const current = [
    "temperature_2m",
    "relative_humidity_2m",
    "apparent_temperature",
    "precipitation",
    "rain",
    "showers",
    "snowfall",
    "weather_code",
    "wind_speed_10m",
    "wind_direction_10m",
  ];

  const hourly = [
    "temperature_2m",
    "apparent_temperature",
    "precipitation",
    "rain",
    "snowfall",
    "weather_code",
    "wind_speed_10m",
    "wind_direction_10m",
    "relative_humidity_2m",
    "cloud_cover",
  ];

  const daily = [
    "weather_code",
    "temperature_2m_max",
    "temperature_2m_min",
    "apparent_temperature_max",
    "apparent_temperature_min",
    "sunrise",
    "sunset",
    "precipitation_sum",
    "rain_sum",
    "snowfall_sum",
    "precipitation_probability_max",
    "wind_speed_10m_max",
    "wind_direction_10m_dominant",
  ];

  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    timezone,
    temperature_unit,
    windspeed_unit,
    precipitation_unit,
    current: current.join(","),
    hourly: hourly.join(","),
    daily: daily.join(","),
    forecast_days: "10",
  });

  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

function normalizeForecast_OpenMeteo(json, { units }) {
  if (!isObj(json)) return null;

  const out = {
    provider: "open-meteo",
    fetchedAt: nowISO(),
    current: null,
    hourly: null,
    daily: null,
    alerts: null,
    raw: json, // keep raw for debugging / future mapping
    units: { ...units },
  };

  if (isObj(json.current)) {
    out.current = {
      time: json.current.time,
      temperature: json.current.temperature_2m,
      apparentTemperature: json.current.apparent_temperature,
      humidity: json.current.relative_humidity_2m,
      precipitation: json.current.precipitation,
      rain: json.current.rain,
      showers: json.current.showers,
      snowfall: json.current.snowfall,
      weatherCode: json.current.weather_code,
      windSpeed: json.current.wind_speed_10m,
      windDirection: json.current.wind_direction_10m,
    };
  }

  if (isObj(json.hourly) && Array.isArray(json.hourly.time)) {
    out.hourly = json.hourly; // keep native arrays
  }

  if (isObj(json.daily) && Array.isArray(json.daily.time)) {
    out.daily = json.daily;
  }

  return out;
}

/* -------------------------------- Store Core -------------------------------- */

function createExternalStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  const getState = () => state;

  const setState = (updater, { silent = false } = {}) => {
    const next = typeof updater === "function" ? updater(state) : updater;
    if (!next || next === state) return state;
    state = next;
    if (!silent) {
      for (const fn of Array.from(listeners)) {
        try {
          fn();
        } catch {
          // ignore listener errors
        }
      }
    }
    return state;
  };

  const subscribe = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };

  return { getState, setState, subscribe };
}

/* ------------------------------ Default state -------------------------------- */

function defaultState() {
  return {
    meta: {
      version: VERSION,
      hydrated: false,
      loading: false,
      error: null,
      lastUpdatedAt: null,
    },
    settings: {
      units: normalizeUnits({ temp: "F", wind: "mph", precip: "in" }),
      refreshMinutes: 60, // cache TTL
      persist: true,
      provider: "open-meteo",
      providerOptions: {}, // reserved for future (vars/alerts/etc.)
    },
    activeLocationId: null,
    locations: {}, // id -> location
    forecasts: {}, // locationId -> forecast packet
  };
}

function mergeHydrated(base, saved) {
  const b = isObj(base) ? base : defaultState();
  const s = isObj(saved) ? saved : {};
  const out = { ...b };

  if (isObj(s.settings)) {
    out.settings = {
      ...b.settings,
      ...s.settings,
      units: normalizeUnits(s.settings.units || b.settings.units),
      refreshMinutes: clamp(
        Number(s.settings.refreshMinutes ?? b.settings.refreshMinutes),
        5,
        24 * 60
      ),
      persist: s.settings.persist !== false,
      provider: isStr(s.settings.provider)
        ? s.settings.provider
        : b.settings.provider,
      providerOptions: isObj(s.settings.providerOptions)
        ? { ...s.settings.providerOptions }
        : b.settings.providerOptions,
    };
  }

  if (isObj(s.locations)) out.locations = { ...s.locations };
  if (isStr(s.activeLocationId)) out.activeLocationId = s.activeLocationId;

  if (isObj(s.forecasts)) out.forecasts = { ...s.forecasts };

  out.meta = {
    ...b.meta,
    hydrated: true,
    error: null,
  };

  return out;
}

/* ------------------------------ Persistence ---------------------------------- */

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return safeJsonParse(raw);
  } catch {
    return null;
  }
}

function saveToStorage(state) {
  try {
    if (!state?.settings?.persist) return;
    const minimal = {
      settings: state.settings,
      activeLocationId: state.activeLocationId,
      locations: state.locations,
      forecasts: state.forecasts,
    };
    const str = safeJsonStringify(minimal);
    if (!str) return;
    localStorage.setItem(STORAGE_KEY, str);
  } catch {
    // no-op
  }
}

/* ------------------------------ WeatherStore -------------------------------- */

class WeatherStoreImpl {
  constructor() {
    this._store = createExternalStore(defaultState());
    this._inflight = new Map(); // locationId -> Promise
    this._hydratedOnce = false;

    // best-effort auto-hydrate
    this.hydrate().catch(() => {});
  }

  /* ------------------------------ External API ------------------------------ */

  getState() {
    return this._store.getState();
  }

  subscribe(fn) {
    return this._store.subscribe(fn);
  }

  select(selector, fallback = null) {
    try {
      const s = this.getState();
      const v = typeof selector === "function" ? selector(s) : null;
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }

  /* ------------------------------ Hydration -------------------------------- */

  async hydrate() {
    if (this._hydratedOnce) return this.getState();
    this._hydratedOnce = true;

    const saved = loadFromStorage();
    this._store.setState((s) => mergeHydrated(s, saved), { silent: false });
    return this.getState();
  }

  persistNow() {
    saveToStorage(this.getState());
  }

  /* ------------------------------ Settings ---------------------------------- */

  setUnits(units) {
    this._store.setState((s) => {
      const next = {
        ...s,
        settings: {
          ...s.settings,
          units: normalizeUnits(units),
        },
        meta: { ...s.meta, lastUpdatedAt: nowISO() },
      };
      return next;
    });
    this.persistNow();
    emitEvent("weather.settings.changed", {
      source: SOURCE,
      at: nowISO(),
    }).catch(() => {});
  }

  setRefreshMinutes(minutes) {
    const m = clamp(Number(minutes), 5, 24 * 60);
    this._store.setState((s) => ({
      ...s,
      settings: { ...s.settings, refreshMinutes: m },
      meta: { ...s.meta, lastUpdatedAt: nowISO() },
    }));
    this.persistNow();
  }

  setPersistEnabled(enabled) {
    const on = enabled !== false;
    this._store.setState((s) => ({
      ...s,
      settings: { ...s.settings, persist: on },
      meta: { ...s.meta, lastUpdatedAt: nowISO() },
    }));
    if (on) this.persistNow();
    else {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // ignore
      }
    }
  }

  setProvider(provider, providerOptions = null) {
    const p = String(provider || "open-meteo");
    this._store.setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        provider: p,
        providerOptions: isObj(providerOptions)
          ? { ...providerOptions }
          : s.settings.providerOptions,
      },
      meta: { ...s.meta, lastUpdatedAt: nowISO() },
    }));
    this.persistNow();
  }

  /* ------------------------------ Locations --------------------------------- */

  upsertLocation(loc, { setActive = false } = {}) {
    const n = normalizeLocation(loc);
    if (!n) return null;

    this._store.setState((s) => {
      const prev = s.locations[n.id];
      const merged = prev
        ? { ...prev, ...n, createdAt: prev.createdAt || n.createdAt }
        : n;
      return {
        ...s,
        locations: { ...s.locations, [n.id]: merged },
        activeLocationId: setActive ? n.id : s.activeLocationId || n.id,
        meta: { ...s.meta, lastUpdatedAt: nowISO(), error: null },
      };
    });

    this.persistNow();
    emitEvent("weather.location.upserted", {
      source: SOURCE,
      at: nowISO(),
      locationId: n.id,
    }).catch(() => {});
    return this.getState().locations[n.id] || n;
  }

  removeLocation(locationId) {
    const id = String(locationId || "").trim();
    if (!id) return;

    this._store.setState((s) => {
      if (!s.locations[id]) return s;
      const locations = { ...s.locations };
      delete locations[id];

      const forecasts = { ...s.forecasts };
      delete forecasts[id];

      let activeLocationId = s.activeLocationId;
      if (activeLocationId === id) {
        const remainingIds = Object.keys(locations);
        activeLocationId = remainingIds.length ? remainingIds[0] : null;
      }

      return {
        ...s,
        locations,
        forecasts,
        activeLocationId,
        meta: { ...s.meta, lastUpdatedAt: nowISO() },
      };
    });

    this.persistNow();
    emitEvent("weather.location.removed", {
      source: SOURCE,
      at: nowISO(),
      locationId: id,
    }).catch(() => {});
  }

  setActiveLocation(locationId) {
    const id = String(locationId || "").trim();
    if (!id) return;
    this._store.setState((s) => {
      if (!s.locations[id]) return s;
      return {
        ...s,
        activeLocationId: id,
        meta: { ...s.meta, lastUpdatedAt: nowISO() },
      };
    });
    this.persistNow();
    emitEvent("weather.location.activated", {
      source: SOURCE,
      at: nowISO(),
      locationId: id,
    }).catch(() => {});
  }

  getActiveLocation() {
    const s = this.getState();
    const id = s.activeLocationId;
    return id ? s.locations[id] || null : null;
  }

  /* ------------------------------ Forecasts --------------------------------- */

  isForecastFresh(locationId) {
    const s = this.getState();
    const id = String(locationId || s.activeLocationId || "").trim();
    if (!id) return false;

    const f = s.forecasts[id];
    if (!f || !f.expiresAt) return false;

    const exp = Date.parse(f.expiresAt);
    if (!Number.isFinite(exp)) return false;

    return nowMs() < exp;
  }

  getForecast(locationId) {
    const s = this.getState();
    const id = String(locationId || s.activeLocationId || "").trim();
    if (!id) return null;
    return s.forecasts[id] || null;
  }

  async fetchForecast(locationId, { force = false, signal } = {}) {
    const s0 = this.getState();
    const id = String(locationId || s0.activeLocationId || "").trim();
    if (!id) return null;

    const loc = s0.locations[id];
    if (!loc) return null;

    if (!force && this.isForecastFresh(id)) return this.getForecast(id);
    if (this._inflight.has(id)) return this._inflight.get(id);

    const task = (async () => {
      this._store.setState((s) => ({
        ...s,
        meta: { ...s.meta, loading: true, error: null },
      }));

      try {
        const units = normalizeUnits(s0.settings.units);
        const provider = String(s0.settings.provider || "open-meteo");

        let json = null;
        let normalized = null;

        if (provider === "open-meteo") {
          const url = providerToUrl_OpenMeteo({
            lat: loc.lat,
            lon: loc.lon,
            tz: loc.tz || "auto",
            units,
            options: s0.settings.providerOptions || {},
          });

          const res = await fetch(url, { signal });
          if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
          json = await res.json();
          normalized = normalizeForecast_OpenMeteo(json, { units });
        } else {
          throw new Error(`Unsupported weather provider: ${provider}`);
        }

        if (!normalized) throw new Error("Weather normalization failed");

        const refreshMinutes = clamp(
          Number(s0.settings.refreshMinutes),
          5,
          24 * 60
        );
        const fetchedAt = normalized.fetchedAt || nowISO();
        const expiresAt = new Date(
          Date.parse(fetchedAt) + refreshMinutes * 60 * 1000
        ).toISOString();

        const packet = {
          ...normalized,
          provider,
          fetchedAt,
          expiresAt,
        };

        this._store.setState((s) => ({
          ...s,
          forecasts: { ...s.forecasts, [id]: packet },
          meta: {
            ...s.meta,
            loading: false,
            error: null,
            lastUpdatedAt: nowISO(),
          },
        }));

        this.persistNow();
        emitEvent("weather.forecast.fetched", {
          source: SOURCE,
          at: nowISO(),
          locationId: id,
          provider,
        }).catch(() => {});

        return packet;
      } catch (err) {
        const msg =
          err?.name === "AbortError"
            ? "Weather request aborted"
            : String(err?.message || err || "Weather error");

        this._store.setState((s) => ({
          ...s,
          meta: {
            ...s.meta,
            loading: false,
            error: msg,
            lastUpdatedAt: nowISO(),
          },
        }));

        emitEvent("weather.forecast.error", {
          source: SOURCE,
          at: nowISO(),
          locationId: id,
          error: msg,
        }).catch(() => {});

        return null;
      } finally {
        this._inflight.delete(id);
      }
    })();

    this._inflight.set(id, task);
    return task;
  }

  async refreshActive({ force = true, signal } = {}) {
    const s = this.getState();
    const id = s.activeLocationId;
    if (!id) return null;
    return this.fetchForecast(id, { force, signal });
  }

  clearForecasts(locationId) {
    const id = String(locationId || "").trim();
    this._store.setState((s) => {
      if (!id) {
        return {
          ...s,
          forecasts: {},
          meta: { ...s.meta, lastUpdatedAt: nowISO() },
        };
      }
      if (!s.forecasts[id]) return s;
      const forecasts = { ...s.forecasts };
      delete forecasts[id];
      return { ...s, forecasts, meta: { ...s.meta, lastUpdatedAt: nowISO() } };
    });
    this.persistNow();
  }

  /* ------------------------------ Convenience -------------------------------- */

  async addFromGeolocation({
    label = "My Location",
    timeoutMs = 10_000,
    setActive = true,
  } = {}) {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      this._store.setState((s) => ({
        ...s,
        meta: {
          ...s.meta,
          error: "Geolocation not available",
          lastUpdatedAt: nowISO(),
        },
      }));
      return null;
    }

    const getPos = () =>
      new Promise((resolve, reject) => {
        const opts = {
          enableHighAccuracy: false,
          maximumAge: 60_000,
          timeout: timeoutMs,
        };
        navigator.geolocation.getCurrentPosition(resolve, reject, opts);
      });

    try {
      const pos = await getPos();
      const lat = pos?.coords?.latitude;
      const lon = pos?.coords?.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon))
        throw new Error("Invalid coordinates");

      const loc = this.upsertLocation(
        { lat, lon, label, source: "geolocation", tz: "auto" },
        { setActive }
      );
      return loc;
    } catch (err) {
      const msg = String(err?.message || err || "Geolocation error");
      this._store.setState((s) => ({
        ...s,
        meta: { ...s.meta, error: msg, lastUpdatedAt: nowISO() },
      }));
      return null;
    }
  }

  getTodaySummary(locationId) {
    const s = this.getState();
    const id = String(locationId || s.activeLocationId || "").trim();
    const location = id ? s.locations[id] || null : null;
    const forecast = id ? s.forecasts[id] || null : null;

    const current = forecast?.current || null;
    let todayDaily = null;

    if (
      forecast?.daily &&
      Array.isArray(forecast.daily.time) &&
      forecast.daily.time.length
    ) {
      const idx = 0;
      const d = forecast.daily;
      todayDaily = {
        date: d.time?.[idx],
        weatherCode: d.weather_code?.[idx],
        tempMax: d.temperature_2m_max?.[idx],
        tempMin: d.temperature_2m_min?.[idx],
        precipSum: d.precipitation_sum?.[idx],
        precipProbMax: d.precipitation_probability_max?.[idx],
        sunrise: d.sunrise?.[idx],
        sunset: d.sunset?.[idx],
        windMax: d.wind_speed_10m_max?.[idx],
        windDir: d.wind_direction_10m_dominant?.[idx],
      };
    }

    return {
      location,
      units: s.settings.units,
      current,
      todayDaily,
      isFresh: id ? this.isForecastFresh(id) : false,
      loading: !!s.meta.loading,
      error: s.meta.error,
    };
  }

  reset() {
    this._store.setState(() => defaultState());
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    emitEvent("weather.store.reset", { source: SOURCE, at: nowISO() }).catch(
      () => {}
    );
  }
}

/* ------------------------------ Singleton export ----------------------------- */

const WeatherStore = new WeatherStoreImpl();
export default WeatherStore;

/* ------------------------------ Named exports -------------------------------- */

export {
  VERSION as WEATHER_STORE_VERSION,
  STORAGE_KEY as WEATHER_STORE_STORAGE_KEY,
};

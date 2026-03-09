/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\weather\weatherGuard.js
/**
 * weatherGuard.js
 * -----------------------------------------------------------------------------
 * Purpose:
 *   Prevent the app from crashing when location/coords are missing.
 *   Weather features should be "best-effort" and NEVER block other domains.
 *
 * Fixes:
 *   - Stops "Cannot read properties of null (reading 'coords')" hard crash.
 *   - Provides safe getters + an optional notice emitter.
 *   - Adds Vite-safe dynamic import normalization for "@/..." aliases.
 *
 * Expected usage patterns (supports all safely):
 *   - import weatherGuard from "@/services/weather/weatherGuard";
 *     const res = await weatherGuard({ require: false });
 *     if (res.ok) { ... use res.coords ... }
 *
 *   - import { getCoordsOrNull, ensureCoords } from "@/services/weather/weatherGuard";
 */

function nowISO() {
  return new Date().toISOString();
}

/** Normalize "@/x" to "/src/x" for Vite runtime dynamic imports */
function normalizeViteDynamicPath(p) {
  const s = String(p || "").trim();
  if (!s) return s;
  if (s.startsWith("@/")) return `/src/${s.slice(2)}`;
  if (s.startsWith("@\\")) return `/src/${s.slice(2).replace(/\\/g, "/")}`;
  return s;
}

async function safeImportMany(paths = []) {
  for (const p of paths) {
    try {
      const normalized = normalizeViteDynamicPath(p);
      const mod = await import(/* @vite-ignore */ normalized);
      return mod?.default || mod;
    } catch {}
  }
  return null;
}

/** Emit a non-fatal notice event (UI can listen & show toast/banner). */
function emitNotice(code, message, meta = {}) {
  try {
    window.dispatchEvent?.(
      new CustomEvent("ssa:notice", {
        detail: { atISO: nowISO(), code, message, meta },
      })
    );
  } catch {}
}

function isFiniteNum(n) {
  return Number.isFinite(Number(n));
}

function normalizeCoords(coords) {
  if (!coords) return null;

  // Accept GeoPosition coords object or {lat,lng} shape
  const lat =
    coords.latitude ?? coords.lat ?? coords.latitudeDeg ?? coords.y ?? null;
  const lng =
    coords.longitude ??
    coords.lng ??
    coords.lon ??
    coords.longitudeDeg ??
    coords.x ??
    null;

  if (!isFiniteNum(lat) || !isFiniteNum(lng)) return null;

  return {
    latitude: Number(lat),
    longitude: Number(lng),
    accuracy: isFiniteNum(coords.accuracy) ? Number(coords.accuracy) : null,
    source: coords.source || "unknown",
  };
}

function readCoordsFromLocalStorage() {
  try {
    const keys = [
      "ssa.location.coords",
      "suka.location.coords",
      "suka::location::coords",
      "ssa::location::coords",
      "household.coords",
      "customLocation.coords",
      "selectedLocation.coords",
    ];
    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const norm = normalizeCoords(parsed);
      if (norm) return { coords: { ...norm, source: "localStorage" }, key: k };
    }
  } catch {}
  return null;
}

async function readCoordsFromDexie() {
  // Best-effort: try common db entrypoints & tables without crashing
  try {
    const dbMod = await safeImportMany([
      "@/services/db.js",
      "@/services/db",
      "@/db/index.js",
      "@/db",
      "../db",
      "../../db",
    ]);
    const db = dbMod?.db || dbMod?.default?.db || dbMod?.default || dbMod;
    if (!db) return null;

    // Common tables / patterns used in SSA:
    // - customLocations
    // - locations
    // - userMeta
    // - settings/meta tables holding selected location
    // We'll probe safely.

    // 1) userMeta -> selected location snapshot
    try {
      const doc =
        (await db.userMeta?.get?.({ key: "ssa.location.selected" })) ||
        (await db.userMeta?.get?.({ key: "suka.location.selected" })) ||
        (await db.userMeta?.get?.({ key: "selectedLocation" })) ||
        null;

      const v = doc?.value || doc?.val || null;
      const coords = normalizeCoords(v?.coords || v);
      if (coords) return { coords: { ...coords, source: "dexie:userMeta" } };
    } catch {}

    // 2) customLocations / locations table -> find active/selected
    for (const tableName of ["customLocations", "locations"]) {
      try {
        const table = db[tableName];
        if (!table?.toArray) continue;
        const rows = await table.toArray();
        const selected =
          rows.find((r) => r?.selected) ||
          rows.find((r) => r?.active) ||
          rows[0];
        const coords = normalizeCoords(selected?.coords || selected);
        if (coords)
          return { coords: { ...coords, source: `dexie:${tableName}` } };
      } catch {}
    }
  } catch {}
  return null;
}

async function readCoordsFromNavigator({ prompt = false } = {}) {
  if (typeof navigator === "undefined") return null;
  if (!navigator.geolocation) return null;

  // If prompt is false, we try permissions first to avoid triggering prompts unexpectedly
  try {
    if (!prompt && navigator.permissions?.query) {
      const p = await navigator.permissions.query({ name: "geolocation" });
      if (p?.state === "denied") return null;
      if (p?.state === "prompt") return null; // do not prompt unless caller requests
    }
  } catch {}

  return new Promise((resolve) => {
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const coords = normalizeCoords(pos?.coords);
          if (coords) resolve({ coords: { ...coords, source: "navigator" } });
          else resolve(null);
        },
        () => resolve(null),
        {
          enableHighAccuracy: false,
          timeout: 6500,
          maximumAge: 10 * 60 * 1000,
        }
      );
    } catch {
      resolve(null);
    }
  });
}

/**
 * Core guard:
 *   - tries multiple sources in a safe order
 *   - returns { ok, coords, source, reason }
 *
 * Options:
 *   - require: if true, returns ok:false with reason when coords missing
 *   - promptGeolocation: if true, may prompt the browser for coords
 *   - silent: if true, no notice event is emitted
 */
export async function ensureCoords(options = {}) {
  const {
    require = false,
    promptGeolocation = false,
    silent = true,
  } = options || {};

  // 1) In-memory global cache if you set one elsewhere
  try {
    const cached = normalizeCoords(window?.__SSA_COORDS__ || null);
    if (cached) return { ok: true, coords: { ...cached, source: "window" } };
  } catch {}

  // 2) localStorage
  const ls = readCoordsFromLocalStorage();
  if (ls?.coords) return { ok: true, coords: ls.coords };

  // 3) Dexie
  const dx = await readCoordsFromDexie();
  if (dx?.coords) return { ok: true, coords: dx.coords };

  // 4) navigator (optional)
  const nav = await readCoordsFromNavigator({ prompt: promptGeolocation });
  if (nav?.coords) return { ok: true, coords: nav.coords };

  // None found
  const out = { ok: false, coords: null, reason: "NO_COORDS" };

  if (!silent) {
    emitNotice(
      "WEATHER_NO_COORDS",
      "Weather features are unavailable until a location is selected.",
      { require, promptGeolocation }
    );
  }

  // If require, still do NOT throw — keep app alive.
  return out;
}

/** Convenience: returns coords object or null (never throws). */
export async function getCoordsOrNull(options = {}) {
  const res = await ensureCoords({ ...options, require: false, silent: true });
  return res.ok ? res.coords : null;
}

/**
 * Wrap a weather function call so it never kills the app.
 * Usage:
 *   const safe = await guardWeather(async ({coords}) => fetchWeather(coords));
 */
export async function guardWeather(fn, options = {}) {
  const res = await ensureCoords({ ...options, require: false, silent: true });
  if (!res.ok) return { ok: false, reason: res.reason, data: null };
  try {
    const data = await fn({ coords: res.coords });
    return { ok: true, data, coords: res.coords };
  } catch (e) {
    return {
      ok: false,
      reason: "WEATHER_ERROR",
      error: String(e?.message || e),
    };
  }
}

/**
 * Default export kept broad to be compatible with multiple call styles:
 *   - weatherGuard()
 *   - weatherGuard({ require: true })
 */
export default async function weatherGuard(options = {}) {
  return ensureCoords(options);
}

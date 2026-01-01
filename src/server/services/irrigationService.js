// C:\Users\larho\suka-smart-assistant\src\server\services\irrigationService.js
//
// Suka Smart Assistant — Irrigation Service
//
// Purpose:
//   Provider-agnostic helpers for /api/irrigation routes, agents, and n8n flows.
//   Bridges Garden Plans ⇄ Irrigation Zones ⇄ Soil Moisture ⇄ Calendar.
//   Returns "visible drafts" for UI preview/edit before saving.
//
// Key Features integrated from project chats:
//   • Zone mapping to garden beds (1:N bed→zone or zone→beds supported)
//   • Seasonal adjustments (month-based + optional weather hooks)
//   • Soil moisture logs & threshold-based “smart skip”
//   • Rain/forecast skip (stub; easy to wire later)
//   • Time-window watering (avoid noon; default early morning/evening)
//   • Sabbath skip default (Hebrew Day 7; user can choose Saturday explicitly)
//   • Calendar export; n8n-friendly payloads
//
// Storage: Local JSON store (dev/offline). Optional bridges to gardenService,
//          calendarService, and a future weatherService/device driver.
//
// Exports (summary):
//   - upsertController(input) / listControllers()
//   - upsertZone(input) / getZone(id) / listZones() / deleteZone(id)
//   - mapBedsToZones(mappings) / getBedZoneMap()
//   - recordMoisture({ zoneId, pct, source? }) / getSoilMoisture(zoneId)
//   - generateScheduleDraft(opts) -> visible draft of cyclic watering plan
//   - buildRunPlan(schedule, opts) -> flattened executable runs
//   - saveSchedule(schedule) / getSchedule(id) / listSchedules() / deleteSchedule(id)
//   - scheduleOnCalendar(opts) -> events[] (uses calendarService if present)
//   - suggestWateringFromGarden(plan, opts) -> zone run-minute suggestions
//   - runConditionsPreview(runPlan, opts) -> marks SKIP for sabbath/rain/moisture/time-window
//   - buildN8nPayload(entity, opts)
//
// ------------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// ---- Lazy bridges ------------------------------------------------------------
let gardenService = null;
let calendarService = null;
// Optionally wire a weather adapter later; keep lazy to avoid breaking dev
let weatherService = null;
// Optionally wire a device driver (ESPHome/OpenSprinkler/etc.)
let deviceService = null;

async function getGardenService() {
  if (!gardenService) {
    const mod = await import("./gardenService.js").catch(() => null);
    gardenService = mod ? mod.default || mod : null;
  }
  return gardenService;
}
async function getCalendarService() {
  if (!calendarService) {
    const mod = await import("./calendarService.js").catch(() => null);
    calendarService = mod ? mod.default || mod : null;
  }
  return calendarService;
}
async function getWeatherService() {
  if (!weatherService) {
    const mod = await import("../../features/weather/weatherService.js").catch(() => null);
    weatherService = mod ? mod.default || mod : null;
  }
  return weatherService;
}
async function getDeviceService() {
  if (!deviceService) {
    const mod = await import("../../features/devices/irrigationDeviceService.js").catch(() => null);
    deviceService = mod ? mod.default || mod : null;
  }
  return deviceService;
}

// ---- Local JSON store --------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), "data", "irrigation");
const FILES = {
  controllers: path.join(DATA_DIR, "controllers.json"),
  zones: path.join(DATA_DIR, "zones.json"),
  schedules: path.join(DATA_DIR, "schedules.json"),
  moisture: path.join(DATA_DIR, "moisture.json"),
  runs: path.join(DATA_DIR, "runs.json"),
  bedZoneMap: path.join(DATA_DIR, "bedZoneMap.json"),
};

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of Object.values(FILES)) {
    try { await fs.access(f); }
    catch { await fs.writeFile(f, JSON.stringify([], null, 2), "utf-8"); }
  }
  // bedZoneMap should be an object, not an array
  try {
    const raw = await fs.readFile(FILES.bedZoneMap, "utf-8");
    JSON.parse(raw);
  } catch {
    await fs.writeFile(FILES.bedZoneMap, JSON.stringify({ mappings: [] }, null, 2), "utf-8");
  }
}
async function readJson(file) {
  await ensureStore();
  const raw = await fs.readFile(file, "utf-8");
  return JSON.parse(raw || "[]");
}
async function writeJson(file, data) {
  await ensureStore();
  await fs.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

// ---- Utilities ---------------------------------------------------------------
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();
const ISODate = (d) => new Date(d).toISOString().slice(0, 10);
const pad2 = (n) => n.toString().padStart(2, "0");
const toTime = (h, m = 0) => `${pad2(h)}:${pad2(m)}`;

function coalesce(a, b) { return typeof a === "undefined" ? b : a; }

function addDays(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return ISODate(d);
}
function hebrewDayIsSabbathSkip(isoDate, opts) {
  const defaultSkip = coalesce(opts?.skipSabbath, true);
  const useSaturday = coalesce(opts?.sabbathIsSaturday, false);
  if (!defaultSkip) return false;
  const d = new Date(isoDate);
  const dow = d.getUTCDay(); // 6 = Saturday
  return useSaturday ? dow === 6 : dow === 6;
}
function isWithinTimeWindow(timeHHMM, windows) {
  if (!windows || windows.length === 0) return true;
  const t = timeHHMM;
  return windows.some(([start, end]) => (t >= start && t <= end));
}
function monthSeasonalFactor(dateISO, { base = 1.0 } = {}) {
  const m = new Date(dateISO).getMonth() + 1; // 1-12
  // Mild seasonal curve; tune as needed / override by weather evapotranspiration later
  const map = { 1:0.6, 2:0.7, 3:0.9, 4:1.0, 5:1.0, 6:1.1, 7:1.2, 8:1.1, 9:0.9, 10:0.8, 11:0.7, 12:0.6 };
  return Math.max(0.4, (map[m] || 1.0) * base);
}

// ---- Controllers & Zones -----------------------------------------------------
/**
 * Controller: { id, name, driver:"local|esp|opensprinkler|other", meta }
 */
export async function upsertController(input) {
  const all = await readJson(FILES.controllers);
  const now = nowISO();
  let rec = input || {};
  if (!rec.id) rec.id = uid();
  rec.createdAt = rec.createdAt || now;
  rec.updatedAt = now;

  const idx = all.findIndex((x) => x.id === rec.id);
  if (idx >= 0) all[idx] = { ...all[idx], ...rec, updatedAt: now };
  else all.push(rec);
  await writeJson(FILES.controllers, all);
  return rec;
}
export async function listControllers() {
  const all = await readJson(FILES.controllers);
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

/**
 * Zone: { id, controllerId, name, flowGpm?, precipitationInHr?, areaSqft?, plants?:string[], soil?: "sandy|loam|clay", moistureThreshold?: number (0-100), defaultMinutes?: number, timeWindows?: [[HH:MM,HH:MM]], notes? }
 */
export async function upsertZone(input) {
  const all = await readJson(FILES.zones);
  const now = nowISO();
  let rec = input || {};
  if (!rec.id) rec.id = uid();
  rec.createdAt = rec.createdAt || now;
  rec.updatedAt = now;

  // Defaults aligned with “intuitive + low setup”
  rec.moistureThreshold = coalesce(rec.moistureThreshold, 28); // %
  rec.defaultMinutes = coalesce(rec.defaultMinutes, 20);
  rec.timeWindows = rec.timeWindows || [
    [toTime(5, 0), toTime(9, 30)],   // early morning
    [toTime(18, 0), toTime(21, 30)], // evening
  ];

  const idx = all.findIndex((x) => x.id === rec.id);
  if (idx >= 0) all[idx] = { ...all[idx], ...rec, updatedAt: now };
  else all.push(rec);
  await writeJson(FILES.zones, all);
  return rec;
}
export async function getZone(id) {
  const all = await readJson(FILES.zones);
  return all.find((z) => z.id === id) || null;
}
export async function listZones() {
  const all = await readJson(FILES.zones);
  return all.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}
export async function deleteZone(id) {
  const all = await readJson(FILES.zones);
  await writeJson(FILES.zones, all.filter((z) => z.id !== id));
}

// ---- Bed ↔ Zone mapping ------------------------------------------------------
/**
 * mappings: [{ bedId, zoneId, sharePct? (0-100) }]
 * Supports splitting a bed across zones or using one zone for many beds.
 */
export async function mapBedsToZones(mappings = []) {
  const raw = await readJson(FILES.bedZoneMap);
  const now = nowISO();
  const payload = { mappings: Array.isArray(mappings) ? mappings.map(m => ({ ...m, sharePct: coalesce(m.sharePct, 100) })) : [], updatedAt: now };
  await writeJson(FILES.bedZoneMap, payload);
  return payload;
}
export async function getBedZoneMap() {
  const raw = await readJson(FILES.bedZoneMap);
  return raw?.mappings ? raw : { mappings: [], updatedAt: nowISO() };
}

// ---- Soil moisture -----------------------------------------------------------
/**
 * recordMoisture: { zoneId, pct (0-100), source?: "sensor|manual", at?: ISO }
 */
export async function recordMoisture({ zoneId, pct, source = "manual", at = nowISO() }) {
  const logs = await readJson(FILES.moisture);
  const rec = { id: uid(), zoneId, pct: Number(pct), source, at };
  logs.push(rec);
  await writeJson(FILES.moisture, logs);
  return rec;
}
export async function getSoilMoisture(zoneId) {
  const logs = await readJson(FILES.moisture);
  const list = logs.filter((l) => l.zoneId === zoneId).sort((a, b) => (b.at || "").localeCompare(a.at || ""));
  return { latest: list[0] || null, history: list.slice(0, 50) };
}

// ---- Smart suggestions from Garden ------------------------------------------
/**
 * suggestWateringFromGarden(plan, opts)
 * Returns minutes per zone based on area & crop type density.
 */
export async function suggestWateringFromGarden(plan, opts = {}) {
  const zones = await listZones();
  const map = await getBedZoneMap();

  // Simple heuristic: warm crops (tomato/pepper/cuke/basil) +10–20%; cool crops baseline.
  const warmRegex = /(tomato|pepper|cucumber|basil|squash|melon|corn)/i;

  const zoneMinutes = new Map();
  for (const m of map.mappings) {
    const bed = (plan?.beds || []).find((b) => b.id === m.bedId);
    const zone = zones.find((z) => z.id === m.zoneId);
    if (!bed || !zone) continue;

    const area = bed.sqft || 16;
    const warmCount = (bed.slots || []).filter(s => warmRegex.test(s.cropName || s.cropKey)).length;
    const coolCount = (bed.slots || []).length - warmCount;

    // base minutes from zone default scaled by area and crop mix
    const base = zone.defaultMinutes || 20;
    const per100sqft = base / 32; // reference bed size 32 sqft
    let minutes = per100sqft * (area / (m.sharePct / 100));

    // crop intensity adjustment
    minutes *= (1 + (warmCount * 0.08) + (coolCount * 0.03));

    // soil factor
    if (zone.soil === "sandy") minutes *= 1.15;
    if (zone.soil === "clay") minutes *= 0.9;

    // cap & floor
    minutes = Math.max(8, Math.min(45, Math.round(minutes)));

    zoneMinutes.set(zone.id, Math.max(zoneMinutes.get(zone.id) || 0, minutes));
  }

  return Array.from(zoneMinutes.entries()).map(([zoneId, minutes]) => ({ zoneId, minutes }));
}

// ---- Schedule generation & run planning -------------------------------------
/**
 * generateScheduleDraft
 * Returns a visible draft schedule with recurrence hints and per-zone minutes.
 */
export async function generateScheduleDraft(opts = {}) {
  const {
    title = "Irrigation Schedule",
    startDate = new Date().toISOString().slice(0, 10),
    frequencyDays = 2,              // every N days
    cycles = 21,                    // number of occurrences to generate (visible draft)
    preferredTimes = [[toTime(5, 30), toTime(6, 30)]], // early morning default window
    skipSabbath = true,
    sabbathIsSaturday = false,
    seasonalBase = 1.0,            // seasonal scalar for baseline
    planId = null,                  // optional garden plan for suggestions
  } = opts;

  let zoneMinutes = [];
  if (planId) {
    const garden = await getGardenService();
    const plan = garden ? await garden.getPlan(planId) : null;
    if (plan) zoneMinutes = await suggestWateringFromGarden(plan, {});
  }

  if (zoneMinutes.length === 0) {
    // fallback: use all zones defaults
    const zones = await listZones();
    zoneMinutes = zones.map((z) => ({ zoneId: z.id, minutes: z.defaultMinutes || 20 }));
  }

  const schedule = {
    id: uid(),
    type: "IRRIGATION_SCHEDULE",
    title,
    startDate,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    config: {
      frequencyDays,
      cycles,
      preferredTimes,
      skipSabbath,
      sabbathIsSaturday,
      seasonalBase,
      planId,
    },
    zones: zoneMinutes,
    notes: "",
  };

  return schedule; // visible draft (save with saveSchedule)
}

/**
 * buildRunPlan
 * Flattens a schedule into per-day, per-zone runs with seasonal & time-window logic.
 */
export async function buildRunPlan(schedule, opts = {}) {
  const zones = await listZones();
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const {
    startDate = schedule?.startDate || new Date().toISOString().slice(0, 10),
    frequencyDays = schedule?.config?.frequencyDays || 2,
    cycles = schedule?.config?.cycles || 14,
    preferredTimes = schedule?.config?.preferredTimes || [[toTime(5, 30), toTime(6, 30)]],
    skipSabbath = coalesce(schedule?.config?.skipSabbath, true),
    sabbathIsSaturday = coalesce(schedule?.config?.sabbathIsSaturday, false),
    seasonalBase = coalesce(schedule?.config?.seasonalBase, 1.0),
  } = opts;

  const runs = [];
  let date = startDate;

  for (let c = 0; c < cycles; c++) {
    if (!hebrewDayIsSabbathSkip(date, { skipSabbath, sabbathIsSaturday })) {
      const seasonalFactor = monthSeasonalFactor(date, { base: seasonalBase });
      // choose first valid time from windows
      const chosenTime = (preferredTimes[0] && preferredTimes[0][0]) || toTime(5, 30);

      for (const z of (schedule.zones || [])) {
        const zone = zoneById.get(z.zoneId);
        if (!zone) continue;
        const minutes = Math.max(5, Math.round((z.minutes || zone.defaultMinutes || 20) * seasonalFactor));

        runs.push({
          id: uid(),
          date,
          time: chosenTime,
          zoneId: z.zoneId,
          zoneName: zone.name || z.zoneId,
          controllerId: zone.controllerId || null,
          minutes,
          reason: "routine",
          conditions: { seasonalFactor, skipSabbath, preferredTimes },
          status: "PENDING",
        });
      }
    }
    date = addDays(date, frequencyDays);
  }

  return {
    scheduleId: schedule?.id || null,
    generatedAt: nowISO(),
    runs,
  };
}

// ---- Run conditions preview (skip logic) ------------------------------------
/**
 * runConditionsPreview
 * Marks runs as SKIP when:
 *  - outside time window (rare if buildRunPlan chose valid window)
 *  - soil moisture >= threshold
 *  - rain forecast (stubbed via weatherService if available)
 */
export async function runConditionsPreview(runPlan, opts = {}) {
  const zones = await listZones();
  const zoneById = new Map(zones.map((z) => [z.id, z]));
  const wx = await getWeatherService();

  const out = [];
  for (const run of runPlan.runs || []) {
    const zone = zoneById.get(run.zoneId);
    let decision = { ...run, decision: "RUN" };

    // time window check (defensive; buildRunPlan already guards)
    const okWindow = isWithinTimeWindow(run.time, zone?.timeWindows || []);
    if (!okWindow) {
      decision.decision = "SKIP";
      decision.skipReason = "time-window";
      out.push(decision);
      continue;
    }

    // soil moisture check
    const m = await getSoilMoisture(run.zoneId);
    const latestPct = Number(m.latest?.pct || NaN);
    if (!Number.isNaN(latestPct) && zone?.moistureThreshold != null && latestPct >= zone.moistureThreshold) {
      decision.decision = "SKIP";
      decision.skipReason = "moisture-high";
      out.push(decision);
      continue;
    }

    // weather/rain forecast (stubbed)
    if (wx?.willRainSoon && (await wx.willRainSoon({ date: run.date, hoursAhead: 12 }))) {
      decision.decision = "SKIP";
      decision.skipReason = "rain-forecast";
      out.push(decision);
      continue;
    }

    out.push(decision);
  }
  return out;
}

// ---- Persistence for schedules & runs ---------------------------------------
export async function saveSchedule(schedule) {
  const all = await readJson(FILES.schedules);
  const id = schedule.id || uid();
  const payload = { ...schedule, id, updatedAt: nowISO() };
  const idx = all.findIndex((s) => s.id === id);
  if (idx >= 0) all[idx] = payload;
  else all.push(payload);
  await writeJson(FILES.schedules, all);
  return payload;
}
export async function getSchedule(id) {
  const all = await readJson(FILES.schedules);
  return all.find((s) => s.id === id) || null;
}
export async function listSchedules() {
  const all = await readJson(FILES.schedules);
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
export async function deleteSchedule(id) {
  const all = await readJson(FILES.schedules);
  await writeJson(FILES.schedules, all.filter((s) => s.id !== id));
}

// Optional: persist generated run plans (auditing / device dispatch preview)
export async function saveRunPlan(runPlan) {
  const all = await readJson(FILES.runs);
  const rec = { id: uid(), ...runPlan, savedAt: nowISO() };
  all.push(rec);
  await writeJson(FILES.runs, all);
  return rec;
}
export async function listRunPlans() {
  const all = await readJson(FILES.runs);
  return all.sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
}

// ---- Calendar export ---------------------------------------------------------
/**
 * scheduleOnCalendar
 * Writes the built runs to calendar (one all-day block per day with details), or returns preview.
 */
export async function scheduleOnCalendar(opts = {}) {
  const {
    scheduleId,
    provider = "local",
    calendarId = "primary",
    timezone = "America/New_York",
    titlePrefix = "Irrigation •",
  } = opts;

  const schedule = await getSchedule(scheduleId);
  if (!schedule) throw new Error("Irrigation schedule not found");

  const runPlan = await buildRunPlan(schedule);
  const decisions = await runConditionsPreview(runPlan);

  const byDay = new Map();
  for (const d of decisions) {
    const list = byDay.get(d.date) || [];
    list.push(d);
    byDay.set(d.date, list);
  }

  const events = [];
  for (const [date, items] of byDay.entries()) {
    const summary = items.map(i => `${i.time} ${i.zoneName} ${i.decision === "SKIP" ? "⤫" : `(${i.minutes}m)`}`).join("; ");
    events.push({
      title: `${titlePrefix} ${date}`,
      description: summary,
      start: date,
      durationMinutes: 60, // calendar placeholder; device driver handles exact sequencing
      timezone,
      recurrence: null,
      meta: { scheduleId: schedule.id, count: items.length },
    });
  }

  const cal = await getCalendarService();
  if (!cal?.createEventsBatch) return events; // visible preview

  return cal.createEventsBatch({ provider, calendarId, events });
}

// ---- Device dispatch (optional) ---------------------------------------------
/**
 * dispatchRunPlan(runPlan, { dryRun = true })
 * If deviceService is present, will invoke per-zone runtime.
 */
export async function dispatchRunPlan(runPlan, { dryRun = true } = {}) {
  const decisions = await runConditionsPreview(runPlan);
  const toRun = decisions.filter(d => d.decision === "RUN");
  const device = await getDeviceService();

  if (!device || dryRun) {
    // Dry-run preview
    const preview = toRun.map(r => ({ zoneId: r.zoneId, minutes: r.minutes, at: `${r.date}T${r.time}` }));
    return { status: "preview", count: preview.length, items: preview };
  }

  // Real dispatch (sequential per chosen start time)
  const results = [];
  for (const r of toRun) {
    const at = new Date(`${r.date}T${r.time}:00.000Z`).toISOString();
    // device.runZone({ controllerId, zoneId, minutes, at })
    if (device.runZone) {
      // eslint-disable-next-line no-await-in-loop
      const res = await device.runZone({ controllerId: r.controllerId, zoneId: r.zoneId, minutes: r.minutes, at });
      results.push({ ...r, result: res });
    } else {
      results.push({ ...r, result: { ok: false, reason: "device.runZone not implemented" } });
    }
  }
  return { status: "dispatched", count: results.length, results };
}

// ---- n8n Payload -------------------------------------------------------------
export function buildN8nPayload(entity, opts = {}) {
  if (!entity) return { type: "UNKNOWN", options: opts };

  if (entity.type === "IRRIGATION_SCHEDULE") {
    return {
      type: "IRRIGATION_SCHEDULE",
      id: entity.id,
      title: entity.title,
      startDate: entity.startDate,
      config: entity.config,
      zones: entity.zones,
      updatedAt: entity.updatedAt,
      options: opts,
    };
  }

  if (entity.runs) {
    return {
      type: "IRRIGATION_RUN_PLAN",
      scheduleId: entity.scheduleId || null,
      runCount: entity.runs.length,
      runs: entity.runs.map(r => ({ date: r.date, time: r.time, zoneId: r.zoneId, minutes: r.minutes })),
      options: opts,
    };
  }

  return { type: "UNKNOWN", options: opts };
}

// ---- Default export ----------------------------------------------------------
const IrrigationService = {
  // Controllers & zones
  upsertController,
  listControllers,
  upsertZone,
  getZone,
  listZones,
  deleteZone,

  // Bed mapping
  mapBedsToZones,
  getBedZoneMap,

  // Moisture
  recordMoisture,
  getSoilMoisture,

  // Schedules & runs
  generateScheduleDraft,
  buildRunPlan,
  runConditionsPreview,
  saveSchedule,
  getSchedule,
  listSchedules,
  deleteSchedule,
  saveRunPlan,
  listRunPlans,

  // Calendar & devices
  scheduleOnCalendar,
  dispatchRunPlan,

  // Garden integration
  suggestWateringFromGarden,

  // n8n
  buildN8nPayload,
};

export default IrrigationService;

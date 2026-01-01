// C:\Users\larho\suka-smart-assistant\src\services\triggers\detectCleaningTriggers.js

/**
 * Suka Smart Assistant — Cleaning Trigger Detector (dynamic)
 * ----------------------------------------------------------
 * Detects cleaning-related triggers and emits action-ready suggestions.
 *
 * What’s new vs. your original:
 * - Configurable thresholds (per-zone frequencies & supply grace windows)
 * - Pulls optional preferences (Sabbath avoidance, timezone) when available
 * - Computes "days since" robustly with null-safe parsing
 * - Adds severity scoring & next-suggested windows (skips Sabbath if enabled)
 * - Calculates low-supply risk using simple run-rate when logs are available
 * - Backward compatible return ({ restockNeeded, overdueSupplies, zonesDue })
 *   PLUS a rich `triggers[]` array your orchestrator can route into UI/agents.
 */

import DexieDB from "../../db";

// Optional/guarded modules (keep bundlers happy)
let SettingsStore, CleaningPlanStore, InventoryService, timeUtils;
try { SettingsStore = require("@/store/SettingsStore"); } catch (_) {}
try { CleaningPlanStore = require("@/store/CleaningPlanStore"); } catch (_) {}
try { InventoryService = require("@/services/inventory/InventoryService"); } catch (_) {}
try { timeUtils = require("@/utils/timeUtils"); } catch (_) { timeUtils = {}; }

// ---------- Helpers ----------
const toDate = (input) => {
  if (!input) return null;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
};

const daysBetween = (a, b) => {
  const ms = (b.getTime() - a.getTime());
  return ms / (1000 * 60 * 60 * 24);
};

const nowLocal = () => new Date();

/**
 * Compute up to N suggested 2-hour windows starting "tomorrow 9am, 1pm, 6pm",
 * skipping Saturdays when sabbath avoidance is enabled.
 */
const nextSuggestedWindows = (opts = {}) => {
  const {
    count = 3,
    avoidSabbath = true,
    sabbathOnSaturday = true, // default behavior per project chats
    tz = undefined,           // optional: not strictly needed in this utility
  } = opts;

  const windows = [];
  const start = nowLocal();
  // Begin suggestions tomorrow at 09:00 local
  const seed = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 9, 0, 0, 0);
  const slots = [9, 13, 18]; // 9am, 1pm, 6pm

  let d = 0;
  while (windows.length < count && d < 21) { // cap search at 3 weeks
    for (const hour of slots) {
      const candidate = new Date(seed);
      candidate.setDate(seed.getDate() + d);
      candidate.setHours(hour, 0, 0, 0);

      // Skip Sabbath (Saturday) if configured
      if (avoidSabbath && sabbathOnSaturday && candidate.getDay() === 6) continue;

      const end = new Date(candidate);
      end.setHours(candidate.getHours() + 2);

      windows.push({
        startISO: candidate.toISOString(),
        endISO: end.toISOString(),
        label: `${candidate.toLocaleDateString()} ${candidate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}–${end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      });

      if (windows.length >= count) break;
    }
    d += 1;
  }
  return windows;
};

/**
 * Derive per-zone frequency (days) with the following precedence:
 *  1) CleaningPlanStore zone config (if present)
 *  2) zone.meta.frequencyDays on log tasks (if present)
 *  3) default fallback (7 days)
 */
const resolveZoneFrequencyDays = (zoneName, planZonesMap, metaFrequencyDays) => {
  if (planZonesMap && planZonesMap[zoneName]?.frequencyDays) {
    return Number(planZonesMap[zoneName].frequencyDays) || 7;
  }
  if (metaFrequencyDays) return Number(metaFrequencyDays) || 7;
  return 7;
};

/**
 * Supply thresholds precedence:
 *  1) InventoryService or SettingsStore specific overrides
 *  2) item.threshold on the record
 *  3) category default for "cleaning": 2 (units)
 */
const resolveSupplyThreshold = (item, settings = {}, inventoryCfg = {}) => {
  const catDefault = 2;
  const invOverride = inventoryCfg?.thresholds?.[item.category]?.[item.name];
  if (typeof invOverride === "number") return invOverride;

  const settingsOverride = settings?.supplyThresholds?.[item.category]?.[item.name];
  if (typeof settingsOverride === "number") return settingsOverride;

  if (typeof item.threshold === "number") return item.threshold;
  return catDefault;
};

/**
 * Grace window for "overdue supply not updated":
 * precedence: settings.supplyOverdueDays || 14
 */
const resolveSupplyOverdueDays = (settings) =>
  Number(settings?.supplyOverdueDays) || 14;

/**
 * Compute a naive daily run-rate from worker logs if tasks contain usage entries.
 * Expected shape (optional, best-effort):
 *   task.usageAdjustments?: [{ sku|name, delta: -1, at: ISO }]
 * Returns map: { [supplyName]: unitsPerDay }
 */
const estimateSupplyRunRates = (logs) => {
  const usage = {};
  const firstSeen = {};
  const lastSeen = {};

  logs.forEach((log) => {
    log?.tasks?.forEach((task) => {
      const when = toDate(task?.completedAt || log?.date);
      if (!when) return;

      const adjusts = task?.usageAdjustments;
      if (!Array.isArray(adjusts)) return;

      adjusts.forEach((adj) => {
        const name = adj?.name || adj?.sku || adj?.id;
        if (!name || typeof adj?.delta !== "number") return;
        // we only care about consumption (negative)
        const consumed = Math.min(0, adj.delta);
        if (!usage[name]) usage[name] = 0;
        usage[name] += Math.abs(consumed);

        if (!firstSeen[name] || when < firstSeen[name]) firstSeen[name] = when;
        if (!lastSeen[name] || when > lastSeen[name]) lastSeen[name] = when;
      });
    });
  });

  const rate = {};
  Object.keys(usage).forEach((k) => {
    const spanDays = Math.max(1, daysBetween(firstSeen[k], lastSeen[k] || firstSeen[k]) || 1);
    rate[k] = usage[k] / spanDays; // units/day
  });
  return rate;
};

// ---------- Main ----------
/**
 * @param {Object} options
 * @param {Date|string|null} [options.now]                    Injected "now" for tests
 * @param {boolean} [options.avoidSabbath=true]              Skip Sabbath in windows
 * @param {boolean} [options.sabbathOnSaturday=true]         Treat Saturday as Sabbath
 * @param {Object} [options.defaults]                        Default knobs
 * @param {number} [options.defaults.zoneFallbackDays=7]     Zone default frequency
 * @returns {Promise<{
 *  restockNeeded: string[],
 *  overdueSupplies: string[],
 *  zonesDue: string[],
 *  triggers: Array<{
 *    type: 'SUPPLY_LOW'|'SUPPLY_OVERDUE'|'ZONE_OVERDUE',
 *    key: string,
 *    message: string,
 *    severity: 'low'|'medium'|'high',
 *    meta?: any,
 *    suggestedWindows?: {startISO:string,endISO:string,label:string}[],
 *    suggestedActions?: {type:string,payload?:any,label?:string}[]
 *  }>
 * }>}
 */
const detectCleaningTriggers = async (options = {}) => {
  const {
    now = nowLocal(),
    avoidSabbath = true,
    sabbathOnSaturday = true,
    defaults = {},
  } = options;

  const nowDate = typeof now === "string" ? toDate(now) : now || nowLocal();
  const zoneFallbackDays = Number(defaults.zoneFallbackDays) || 7;

  // 1) Pull user/system settings if available
  let settings = {};
  try { settings = (await SettingsStore?.get?.()) || {}; } catch (_) {}

  // 2) Pull optional cleaning plan zone metadata (frequencyDays, labels, etc.)
  let planZonesMap = null;
  try {
    const plan = await CleaningPlanStore?.getActivePlan?.();
    if (plan?.zones?.length) {
      planZonesMap = {};
      for (const z of plan.zones) {
        planZonesMap[z.name] = { frequencyDays: z.frequencyDays || null, label: z.label || z.name };
      }
    }
  } catch (_) {}

  // 3) Pull inventory config (threshold overrides) if service exists
  let inventoryCfg = {};
  try { inventoryCfg = (await InventoryService?.getConfig?.()) || {}; } catch (_) {}

  // 4) Fetch data (supplies + cleaner logs)
  const supplies = (await DexieDB?.supplies?.toArray?.()) || [];
  const logs = (await DexieDB?.workerSessions
    ?.where?.("role")?.equals?.("cleaner")
    ?.toArray?.()) || [];

  const triggers = [];
  const restockNeeded = [];
  const overdueSupplies = [];
  const zonesDue = [];

  // Pre-compute run-rates from logs (best effort)
  const runRates = estimateSupplyRunRates(logs);

  // ---------- Analyze supplies ----------
  const overdueDaysLimit = resolveSupplyOverdueDays(settings);

  for (const item of supplies) {
    if (item?.category !== "cleaning") continue;

    const threshold = resolveSupplyThreshold(item, settings, inventoryCfg);
    const qty = Number(item?.quantity) || 0;

    // LOW SUPPLY / RESTOCK
    if (qty <= threshold) {
      restockNeeded.push(item.name);

      // Estimate days remaining if run-rate known
      const rate = runRates[item.name] || null;
      const daysLeft = rate ? (qty / rate) : null;

      triggers.push({
        type: "SUPPLY_LOW",
        key: `supply:${item.name}`,
        message: `${item.name} is at or below threshold (${qty} ≤ ${threshold}).`,
        severity: daysLeft !== null ? (daysLeft <= 2 ? "high" : daysLeft <= 5 ? "medium" : "low") : "medium",
        meta: { quantity: qty, threshold, daysLeft, ratePerDay: rate },
        suggestedActions: [
          { type: "CREATE_SHOPPING_LIST", payload: { items: [{ name: item.name, min: threshold + 1 }] }, label: "Add to Shopping List" },
          { type: "OPEN_INVENTORY", payload: { focus: item.name }, label: "Review Inventory" },
        ],
      });
    }

    // OVERDUE SUPPLY (not updated)
    const last = toDate(item?.lastUpdated);
    if (last) {
      const age = daysBetween(last, nowDate);
      if (age > overdueDaysLimit) {
        overdueSupplies.push(item.name);
        triggers.push({
          type: "SUPPLY_OVERDUE",
          key: `supply-overdue:${item.name}`,
          message: `${item.name} has not been updated for ${Math.floor(age)} days (limit ${overdueDaysLimit}).`,
          severity: age > overdueDaysLimit * 2 ? "high" : "medium",
          meta: { lastUpdatedISO: last.toISOString(), ageDays: age, limitDays: overdueDaysLimit },
          suggestedActions: [
            { type: "OPEN_INVENTORY", payload: { focus: item.name }, label: "Update Supply Record" },
          ],
        });
      }
    } else {
      // No lastUpdated at all → gentle nudge
      triggers.push({
        type: "SUPPLY_OVERDUE",
        key: `supply-overdue:${item.name}:unknown`,
        message: `${item.name} has no update history — confirm quantity.`,
        severity: "low",
        meta: { lastUpdatedISO: null },
        suggestedActions: [
          { type: "OPEN_INVENTORY", payload: { focus: item.name }, label: "Confirm Quantity" },
        ],
      });
    }
  }

  // ---------- Analyze zones (last cleaned) ----------
  // Build last-cleaned index by zone
  const lastZoneLog = {}; // { zoneName: ISOString }
  const zoneMeta = {};    // { zoneName: { frequencyDays? } } (best-effort from tasks)

  logs.forEach((log) => {
    const logDate = toDate(log?.date) || nowDate;
    log?.tasks?.forEach((task) => {
      const zone = task?.zone || "General";
      const completed = toDate(task?.completedAt) || logDate;
      const metaFreq = task?.meta?.frequencyDays;

      if (!lastZoneLog[zone] || toDate(lastZoneLog[zone]) < completed) {
        lastZoneLog[zone] = completed.toISOString();
      }
      if (metaFreq && !zoneMeta[zone]) zoneMeta[zone] = { frequencyDays: metaFreq };
    });
  });

  const windows = nextSuggestedWindows({ avoidSabbath, sabbathOnSaturday });

  // For zones with a known last clean date
  Object.entries(lastZoneLog).forEach(([zone, lastCleanedISO]) => {
    const lastDate = toDate(lastCleanedISO);
    if (!lastDate) return;

    const freq = resolveZoneFrequencyDays(zone, planZonesMap, zoneMeta[zone]?.frequencyDays) || zoneFallbackDays;
    const age = daysBetween(lastDate, nowDate);

    if (age > freq) {
      zonesDue.push(zone);

      const overdueBy = Math.floor(age - freq);
      const sev = overdueBy >= freq ? "high" : overdueBy >= Math.ceil(freq / 2) ? "medium" : "low";

      triggers.push({
        type: "ZONE_OVERDUE",
        key: `zone:${zone}`,
        message: `${zone} overdue by ${overdueBy} day(s). Target frequency: every ${freq} day(s).`,
        severity: sev,
        meta: { lastCleanedISO: lastDate.toISOString(), daysSince: age, frequencyDays: freq, overdueBy },
        suggestedWindows: windows,
        suggestedActions: [
          { type: "SCHEDULE_CLEANING_SESSION", payload: { zone, durationMin: 60 }, label: `Schedule ${zone} Clean` },
          { type: "GENERATE_CLEANING_CHECKLIST", payload: { zone }, label: "Generate Checklist" },
        ],
      });
    }
  });

  // For zones defined in plan but never cleaned yet → flag as due
  if (planZonesMap) {
    Object.keys(planZonesMap).forEach((zone) => {
      if (lastZoneLog[zone]) return;
      const freq = resolveZoneFrequencyDays(zone, planZonesMap, null) || zoneFallbackDays;

      zonesDue.push(zone);
      triggers.push({
        type: "ZONE_OVERDUE",
        key: `zone:${zone}:uncleaned`,
        message: `${zone} has no cleaning history. Suggested frequency: every ${freq} day(s).`,
        severity: "medium",
        meta: { lastCleanedISO: null, daysSince: null, frequencyDays: freq },
        suggestedWindows: windows,
        suggestedActions: [
          { type: "SCHEDULE_CLEANING_SESSION", payload: { zone, durationMin: 60 }, label: `First Clean: ${zone}` },
          { type: "GENERATE_CLEANING_CHECKLIST", payload: { zone }, label: "Generate Checklist" },
        ],
      });
    });
  }

  // ---------- Backward-compatible summary + rich triggers ----------
  return {
    restockNeeded,
    overdueSupplies,
    zonesDue,
    triggers,
  };
};

export default detectCleaningTriggers;

// C:\Users\larho\suka-smart-assistant\src\services\analytics\gardenAnalytics.js
/* ============================================================================
   gardenAnalytics — Garden, Group-Garden, and Coalition (Multi-Garden) Analytics
   - Solo (personal beds), Shared Group gardens (shared beds/seed pools),
     and Coalition groups (multiple independent gardens aligned to common goals)
   - Coalition = intentionally formed groups where different users grow
     individually but coordinate toward pooled targets and fair contribution.
   - Event-driven & defensive; UI-ready cards; NBA nudges; Automation templates.
============================================================================ */

import EventEmitter from "eventemitter3";

/* -----------------------------------------------------------------------------
   Defensive optional imports (no hard coupling)
----------------------------------------------------------------------------- */
let automation;
let eventBus;
let PreferencesStore, GardenStore, SeedStore, InventoryStore, WeatherStore, CalendarStore, TaskStore, GroupStore, CoalitionStore;
try { ({ automation } = await import("@/services/automation/runtime")); } catch {}
try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
try { ({ usePreferencesStore: PreferencesStore } = await import("@/store/PreferencesStore")); } catch {}
try { ({ useGardenStore: GardenStore } = await import("@/store/GardenStore")); } catch {}
try { ({ useSeedStore: SeedStore } = await import("@/store/SeedStore")); } catch {}
try { ({ useInventoryStore: InventoryStore } = await import("@/store/InventoryStore")); } catch {}
try { ({ useWeatherStore: WeatherStore } = await import("@/store/WeatherStore")); } catch {}
try { ({ useCalendarStore: CalendarStore } = await import("@/store/CalendarStore")); } catch {}
try { ({ useTaskStore: TaskStore } = await import("@/store/TaskStore")); } catch {}
try { ({ useGroupStore: GroupStore } = await import("@/store/GroupStore")); } catch {}
// Optional coalition-specific store; if not present we derive from GroupStore
try { ({ useCoalitionStore: CoalitionStore } = await import("@/store/CoalitionStore")); } catch {}

/* -----------------------------------------------------------------------------
   Local helpers
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const dayMs = 86_400_000;
const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const avg = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const keyBy = (arr, k) => Object.fromEntries((arr || []).map(x => [x[k], x]));
const mergeObjSum = (a, b) => {
  const out = { ...(a || {}) };
  Object.entries(b || {}).forEach(([k, v]) => { out[k] = (out[k] || 0) + Number(v || 0); });
  return out;
};

/* Storage for snapshots (per personal, group, coalition) */
const storage = (() => {
  const key = "suka::gardenAnalytics::snaps";
  if (isBrowser && window.sessionStorage) {
    return {
      get: () => JSON.parse(sessionStorage.getItem(key) || "{}"),
      set: (v) => sessionStorage.setItem(key, JSON.stringify(v || {})),
      del: () => sessionStorage.removeItem(key),
    };
  }
  let mem = {};
  return { get: () => mem, set: (v) => (mem = v), del: () => (mem = {}) };
})();

/* -----------------------------------------------------------------------------
   Store accessors (defensive)
----------------------------------------------------------------------------- */
function readPrefs()      { try { return PreferencesStore?.() || {}; } catch { return {}; } }
function readGarden()     { try { return GardenStore?.() || {}; } catch { return {}; } }
function readSeeds()      { try { return SeedStore?.() || {}; } catch { return {}; } }
function readInventory()  { try { return InventoryStore?.() || {}; } catch { return {}; } }
function readWeather()    { try { return WeatherStore?.() || {}; } catch { return {}; } }
function readCalendar()   { try { return CalendarStore?.() || {}; } catch { return {}; } }
function readTasks()      { try { return TaskStore?.() || {}; } catch { return {}; } }
function readGroups()     { try { return GroupStore?.() || {}; } catch { return {}; } }
function readCoalitions() { try { return CoalitionStore?.() || {}; } catch { return {}; } }

/* -----------------------------------------------------------------------------
   Data expectations (defensive)
   - Coalition groups model (if CoalitionStore missing, derive from GroupStore):
     coalition: {
       id, name, type:'coalition', members:[{userId, displayName}],
       pooledDemand: { crop -> lbs/week }, fairness: { basis:'lbs|hours|beds' },
       targets: { crop -> lbs over horizon }, startTs, endTs
     }
   - Member garden data resolution: try CoalitionStore.getMemberGarden(userId)
     else GroupStore.getMemberGarden(userId), else eventBus request/response fallback.
----------------------------------------------------------------------------- */
async function getMemberGarden(userId) {
  try { return await CoalitionStore?.getMemberGarden?.(userId); } catch {}
  try { return await GroupStore?.getMemberGarden?.(userId); } catch {}
  // Last resort: emit request; expect some agent to reply into memory cache
  try {
    const key = `memberGarden:${userId}`;
    return storage.get()[key] || null;
  } catch { return null; }
}

/* =============================================================================
   PERSONAL & GROUP SNAPSHOTS (existing features)
============================================================================= */

/**
 * computeGardenSnapshot (personal or shared group gardens)
 * scope: 'personal' when groupId == null AND entityType != 'coalition'
 * scope: 'group' when groupId != null (shared beds)
 */
export function computeGardenSnapshot({
  groupId = null,
  horizonDays = 30,
  prefs = readPrefs(),
  garden = readGarden(),
  seeds = readSeeds(),
  inventory = readInventory(),
  weather = readWeather(),
  calendar = readCalendar(),
  groups = readGroups(),
} = {}) {
  const bedsAll = garden.beds || [];
  const plantingsAll = garden.plantings || [];
  const pestsAll = garden.pests || [];
  const irrigAll = garden.irrigations || [];
  const packetsAll = seeds.packets || [];
  const tasksAll = (readTasks().items || []);

  // Scope by group (shared garden) or personal
  const isInScope = (x) => (groupId == null ? !x?.groupId : String(x?.groupId) === String(groupId));
  const beds = bedsAll.filter(isInScope);
  const plantings = plantingsAll.filter(isInScope);
  const pests = pestsAll.filter(isInScope);
  const irrigations = irrigAll.filter(isInScope);
  const packets = packetsAll.filter(isInScope);
  const tasks = tasksAll.filter(isInScope);

  // Time windows
  const since30 = now() - 30 * dayMs;

  /* --------------------------- KPIs --------------------------- */
  const bedById = keyBy(beds, "id");
  const plantedBeds = new Set(plantings.map(p => p.bedId));
  const totalArea = sum(beds.map(b => Number(b.areaSqFt || 0)));
  const plantedArea = sum(beds.filter(b => plantedBeds.has(b.id)).map(b => Number(b.areaSqFt || 0)));
  const bedUsagePct = totalArea ? plantedArea / totalArea : 0;

  const plannedCal = (calendar.plan || []).filter(e => e.type === "plant" && isInScope(e) && e.ts >= since30);
  const actualThisMonth = plantings.filter(p => p.tsPlant >= since30);
  const onPlanHits = plannedCal.filter(e => actualThisMonth.some(p => p.crop === e.crop && roughlySameDay(p.tsPlant, e.ts))).length;
  const planAdherence = plannedCal.length ? onPlanHits / plannedCal.length : 1;

  const cropForecast = forecastYield({ plantings, horizonDays });
  const demand = demandProfile({ prefs, groups, groupId });
  const surplusDeficit = compareForecastToDemand(cropForecast, demand);

  const succession = analyzeSuccession({ plantings, horizonDays });
  const rotation = analyzeRotation({ plantings, beds });

  const pest30 = pests.filter(p => p.ts >= since30);
  const pestPressure = Math.min(100, Math.round(avg(pest30.map(p => (Number(p.severity || 1) * 20))) || 0));

  const waterNeed = estimateWaterNeed({ weather, irrigations, beds });
  const seedStatus = analyzeSeeds({ packets, upcoming: plannedCal });
  const costProxy = estimateCostPerLb({ inventory, forecast: cropForecast });
  const { backlog, upcomingWork } = analyzeWorkload({ tasks, horizonDays });

  const alerts = buildAlerts({
    bedUsagePct, planAdherence, pestPressure, waterNeed,
    seedStatus, surplusDeficit, rotation, succession
  });

  return {
    ts: now(),
    scope: groupId == null ? "personal" : "group",
    groupId,
    beds: { totalArea: round2(totalArea), plantedArea: round2(plantedArea), usagePct: round2(bedUsagePct) },
    plan: { adherence: round2(planAdherence), planned: plannedCal.length, plantedThisMonth: actualThisMonth.length },
    forecast: cropForecast,
    demand,
    surplusDeficit,
    succession,
    rotation,
    pests: { pressure: pestPressure, last30: pest30.length },
    water: waterNeed,
    seeds: seedStatus,
    cost: costProxy,
    work: { backlog, upcomingWork },
    alerts,
  };
}

/* =============================================================================
   COALITION (MULTI-GARDEN) SNAPSHOT
   - Multiple independent gardens grown by different users for common pooled goals
   - No shared beds; we aggregate members’ personal garden analytics.
============================================================================= */

/**
 * computeCoalitionSnapshot
 * @param {Object} opts
 *  - coalitionId (required)
 *  - memberResolver?: (userId) => Promise<{ garden, seeds, calendar, inventory, weather }>
 *  - horizonDays: default 30
 */
export async function computeCoalitionSnapshot({
  coalitionId,
  horizonDays = 30,
  memberResolver = getMemberGarden,
  coalitions = readCoalitions(),
  groups = readGroups(), // fallback source if CoalitionStore not available
} = {}) {
  if (!coalitionId) return null;

  const coalition =
    (coalitions.coalitions || []).find(c => String(c.id) === String(coalitionId)) ||
    (groups.groups || []).find(g => String(g.id) === String(coalitionId) && (g.type === "coalition" || g.kind === "coalition")) ||
    { id: coalitionId, name: "Coalition", members: [], pooledDemand: {}, targets: {}, fairness: { basis: "lbs" } };

  const members = coalition.members || [];
  const memberSnaps = [];

  for (const m of members) {
    let mg = await memberResolver(m.userId);
    // mg: { prefs, garden, seeds, inventory, weather, calendar }
    if (!mg) { memberSnaps.push({ userId: m.userId, error: "unavailable" }); continue; }

    const snap = computeGardenSnapshot({
      groupId: null,
      horizonDays,
      prefs: mg.prefs || readPrefs(),
      garden: mg.garden || { beds: [], plantings: [] },
      seeds: mg.seeds || { packets: [] },
      inventory: mg.inventory || { items: [] },
      weather: mg.weather || { history: [] },
      calendar: mg.calendar || { plan: [] },
      groups, // still needed for baseline demand profile
    });
    memberSnaps.push({ userId: m.userId, name: m.displayName || m.userId, snapshot: snap });
  }

  // Aggregate coalition metrics
  const agg = aggregateCoalition(memberSnaps, coalition, horizonDays);

  // NBA/alerts at coalition level
  const alerts = buildCoalitionAlerts(agg);

  const out = {
    ts: now(),
    scope: "coalition",
    coalitionId,
    name: coalition.name,
    horizonDays,
    members: memberSnaps,
    pooled: agg.pooled,         // { forecast, demand, surplusDeficit }
    fairness: agg.fairness,     // contribution vs target balance
    coordination: agg.coord,    // suggested swaps/trades/schedules
    alerts,
  };

  return out;
}

function aggregateCoalition(memberSnaps, coalition, horizonDays) {
  // Sum member forecasts & derive pooled demand/targets
  let pooledForecast = {};
  let pooledDemand = { ...(coalition.pooledDemand || {}) }; // lbs/week
  let pooledBeds = { totalArea: 0, plantedArea: 0 };

  const perMember = [];

  for (const m of memberSnaps) {
    const s = m.snapshot;
    if (!s || !s.forecast) continue;

    // Sum forecasts
    Object.entries(s.forecast).forEach(([crop, v]) => {
      pooledForecast[crop] = pooledForecast[crop] || { lbs: 0, harvests: [] };
      pooledForecast[crop].lbs += Number(v.lbs || 0);
      pooledForecast[crop].harvests = pooledForecast[crop].harvests.concat(v.harvests || []);
    });

    // Sum beds
    pooledBeds.totalArea += Number(s.beds?.totalArea || 0);
    pooledBeds.plantedArea += Number(s.beds?.plantedArea || 0);

    // Track individual contributions for fairness
    perMember.push({
      userId: m.userId,
      name: m.name,
      contribution: { forecastLbs: sum(Object.values(s.forecast || {}).map(x => Number(x.lbs || 0))) },
    });
  }

  // Normalize rounding
  Object.keys(pooledForecast).forEach(c => { pooledForecast[c].lbs = round2(pooledForecast[c].lbs); });

  const pooledSD = compareForecastToDemand(pooledForecast, pooledDemand);
  const fairness = fairnessAnalysis({ members: perMember, coalition });

  const coord = coalitionCoordination({
    pooledForecast,
    pooledDemand,
    pooledSD: pooledSD,
    memberSnaps,
    basis: fairness.basis,
  });

  return {
    pooled: {
      beds: { totalArea: round2(pooledBeds.totalArea), plantedArea: round2(pooledBeds.plantedArea),
              usagePct: pooledBeds.totalArea ? round2(pooledBeds.plantedArea / pooledBeds.totalArea) : 0 },
      forecast: pooledForecast,
      demand: pooledDemand,
      surplusDeficit: pooledSD,
    },
    fairness,
    coord,
  };
}

function fairnessAnalysis({ members, coalition }) {
  const basis = coalition?.fairness?.basis || "lbs"; // 'lbs'|'hours'|'beds'
  const values = members.map(m => {
    if (basis === "hours") return Number(m.hours || 0);
    if (basis === "beds") return Number(m.beds || 0);
    return Number(m.contribution?.forecastLbs || 0);
  });
  const total = sum(values);
  const mean = avg(values);
  // Simple imbalance index: mean absolute deviation / mean (0..high)
  const mad = avg(values.map(v => Math.abs(v - mean)));
  const imbalanceIdx = mean ? round2(mad / mean) : 0;

  // Target split: even or by declared quotas?
  const split = coalition?.targets ? coalition.targets : null; // { crop -> lbs over horizon }
  // For now, per-member target = totalTarget/members if split exists
  let perMemberTarget = null;
  if (split && members.length) {
    const totalTarget = sum(Object.values(split));
    perMemberTarget = round2(totalTarget / members.length);
  }

  const perMember = members.map((m, i) => ({
    userId: m.userId,
    name: m.name,
    basisValue: values[i],
    target: perMemberTarget,
    deltaToTarget: perMemberTarget != null ? round2(values[i] - perMemberTarget) : null,
  }));

  return { basis, total, mean: round2(mean), imbalanceIdx, members: perMember };
}

function coalitionCoordination({ pooledForecast, pooledDemand, pooledSD, memberSnaps, basis }) {
  // Suggest trades/swaps: crops with coalition deficits request from members w/ surplus
  const deficits = Object.entries(pooledSD || {}).filter(([_, v]) => (v.delta || 0) < 0).map(([crop, v]) => ({ crop, need: Math.abs(v.delta) }));
  const suggestions = [];
  if (!deficits.length) return { suggestions, schedules: [] };

  // Member-level availability (surplus vs their own demand)
  const memberAvail = memberSnaps.map(m => {
    const s = m.snapshot;
    const sd = compareForecastToDemand(s.forecast || {}, s.demand || {});
    return {
      userId: m.userId,
      name: m.name,
      surplus: Object.fromEntries(Object.entries(sd).filter(([_, v]) => v.delta > 0).map(([c, v]) => [c, v.delta])),
    };
  });

  for (const d of deficits) {
    let remaining = d.need;
    for (const mem of memberAvail) {
      const avail = Number(mem.surplus[d.crop] || 0);
      if (avail <= 0) continue;
      const give = round2(Math.min(avail, remaining));
      suggestions.push({ crop: d.crop, fromUserId: mem.userId, fromName: mem.name, amount: give, unit: "lb" });
      remaining = round2(remaining - give);
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      suggestions.push({ crop: d.crop, fromUserId: null, fromName: "external", amount: remaining, unit: "lb", note: "Purchase or expand plantings" });
    }
  }

  // Simple staggered schedule suggestion: if many harvests same week for the same crop, propose shifting
  const schedules = [];
  Object.entries(pooledForecast || {}).forEach(([crop, v]) => {
    const byWeek = {};
    (v.harvests || []).forEach(h => {
      const wk = weekKey(h.ts);
      byWeek[wk] = (byWeek[wk] || 0) + Number(h.qty || 0);
    });
    const peaks = Object.entries(byWeek).filter(([_, lbs]) => lbs > (avg(Object.values(byWeek)) * 1.5));
    if (peaks.length >= 1) {
      schedules.push({ crop, peaks: peaks.map(([w, lbs]) => ({ week: w, lbs: round2(lbs) })), suggestion: "Stagger sow/harvest to smooth peaks" });
    }
  });

  return { suggestions, schedules };
}

function weekKey(ts) {
  const d = new Date(ts);
  // ISO week year-week format
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / dayMs) + onejan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

function buildCoalitionAlerts(agg) {
  const alerts = [];
  const deficits = Object.values(agg.pooled.surplusDeficit || {}).filter(v => v.delta < 0).length;
  if (deficits) {
    alerts.push({
      level: "warning",
      code: "COALITION_DEFICIT",
      message: `${deficits} coalition deficit crop(s) in next 4 weeks.`,
      actions: [{ label: "Open Coordination", topic: "garden.coalition.balance.open" }],
    });
  }
  if ((agg.fairness?.imbalanceIdx || 0) > 0.35) {
    alerts.push({
      level: "info",
      code: "FAIRNESS_IMBALANCE",
      message: "Contribution imbalance detected across members.",
      actions: [{ label: "Redistribute Tasks", topic: "garden.coalition.tasks.balance.open" }],
    });
  }
  if ((agg.coord?.schedules || []).length) {
    alerts.push({
      level: "info",
      code: "PEAK_HARVEST",
      message: "Peak harvest weeks detected; consider staggering.",
      actions: [{ label: "View Stagger Plan", topic: "garden.coalition.stagger.open" }],
    });
  }
  return alerts;
}

/* -----------------------------------------------------------------------------
   Shared helpers used above
----------------------------------------------------------------------------- */
function roughlySameDay(aTs, bTs) {
  const a = new Date(aTs), b = new Date(bTs);
  a.setHours(0,0,0,0); b.setHours(0,0,0,0);
  return a.getTime() === b.getTime();
}

function forecastYield({ plantings, horizonDays }) {
  const until = now() + horizonDays * dayMs;
  const byCrop = {};
  (plantings || []).forEach(p => {
    const estTs = p.tsHarvestEst || p.tsHarvest;
    const within = !!estTs && estTs <= until;
    const qty = Number(p.qtyEst || p.qtyActual || 0);
    if (within && qty > 0) {
      const c = (p.crop || "unknown").toLowerCase();
      byCrop[c] = byCrop[c] || { lbs: 0, harvests: [] };
      byCrop[c].lbs += qty;
      byCrop[c].harvests.push({ plantingId: p.id, ts: estTs, qty });
    }
  });
  Object.keys(byCrop).forEach(c => { byCrop[c].lbs = round2(byCrop[c].lbs); });
  return byCrop;
}

function demandProfile({ prefs, groups, groupId }) {
  const hh = Number(prefs?.household?.members || 2);
  const vegLbsPerPersonWeek = Number(prefs?.garden?.vegLbsPerPersonWeek || 7);
  const base = Math.max(0, hh * vegLbsPerPersonWeek);
  const demand = { mixed_veg: base };
  if (groupId != null) {
    const g = (groups.groups || []).find(x => String(x.id) === String(groupId));
    if (g?.cropDemand) Object.entries(g.cropDemand).forEach(([crop, lbs]) => {
      const k = (crop || "").toLowerCase(); demand[k] = Number(lbs || 0) + (demand[k] || 0);
    });
  }
  return demand;
}

function compareForecastToDemand(forecast, demand) {
  const weeks = 4;
  const out = {};
  const crops = new Set([ ...Object.keys(forecast || {}), ...Object.keys(demand || {}) ]);
  crops.forEach(c => {
    const f = forecast[c]?.lbs || 0;
    const need = (demand[c] || 0) * weeks;
    out[c] = { delta: round2(f - need), unit: "lb" };
  });
  return out;
}

function analyzeSuccession({ plantings }) {
  const targetGap = 10;
  const byCrop = {};
  (plantings || []).forEach(p => { (byCrop[(p.crop || "").toLowerCase()] ||= []).push(p.tsPlant); });
  const gaps = {};
  Object.entries(byCrop).forEach(([crop, times]) => {
    const s = times.sort((a, b) => a - b);
    const longGaps = [];
    for (let i = 1; i < s.length; i++) {
      const gapDays = Math.round((s[i] - s[i - 1]) / dayMs);
      if (gapDays > targetGap) longGaps.push({ from: s[i - 1], to: s[i], days: gapDays });
    }
    if (longGaps.length) gaps[crop] = longGaps;
  });
  return { targetGap, gaps };
}

function analyzeRotation({ plantings, beds }) {
  const fam = (crop) => {
    const c = (crop || "").toLowerCase();
    if (/tomato|pepper|eggplant|potato/.test(c)) return "nightshade";
    if (/cabbage|kale|broccoli|brussels/.test(c)) return "brassica";
    if (/beans|peas/.test(c)) return "legume";
    if (/onion|garlic|leek/.test(c)) return "allium";
    if (/carrot|beet|radish/.test(c)) return "root";
    return "misc";
  };
  const perBed = {};
  (plantings || []).forEach(p => {
    const b = String(p.bedId);
    (perBed[b] ||= []).push({ year: p.rotationYear ?? new Date(p.tsPlant).getFullYear(), family: fam(p.crop) });
  });
  const issues = [];
  Object.entries(perBed).forEach(([bedId, rows]) => {
    const sorted = rows.sort((a, b) => a.year - b.year);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].family === sorted[i - 1].family) {
        const bedName = beds.find(b => String(b.id) === bedId)?.name || `Bed ${bedId}`;
        issues.push({ bedId, bedName, yearA: sorted[i - 1].year, yearB: sorted[i].year, family: sorted[i].family });
      }
    }
  });
  return { issues };
}

function estimateWaterNeed({ weather, irrigations, beds }) {
  const last7 = (weather.history || []).filter(w => w.ts >= (now() - 7 * dayMs));
  const rain = sum(last7.map(w => Number(w.rainIn || 0)));
  const etTargetIn = 1.0;
  const irrigL = sum((irrigations || []).filter(i => i.ts >= (now() - 7 * dayMs)).map(i => Number(i.volumeL || 0)));
  const irrigInches = (irrigL / 1000) / Math.max(1, sum(beds.map(b => Number(b.areaSqFt || 0))) / 43560);
  const deficit = clamp(etTargetIn - (rain + irrigInches), 0, 2);
  const score = Math.round((deficit / 2) * 100);
  return { deficitIn: round2(deficit), risk: score };
}

function analyzeSeeds({ packets, upcoming }) {
  const total = (packets || []).length;
  const avgViability = avg((packets || []).map(p => Number(p.viabilityPct || 0))) || 0;
  const need = {};
  (upcoming || []).forEach(e => {
    const k = (e.crop || "").toLowerCase();
    need[k] = (need[k] || 0) + Number(e.seedsNeeded || 0);
  });
  const have = {};
  (packets || []).forEach(p => {
    const k = (p.crop || "").toLowerCase();
    have[k] = (have[k] || 0) + Number(p.qtySeeds || 0) * Number(p.viabilityPct || 1);
  });
  const shortages = Object.keys(need).filter(k => (have[k] || 0) < need[k]).map(k => ({
    crop: k, shortBySeeds: Math.max(0, Math.round(need[k] - (have[k] || 0)))
  }));
  return { totalPackets: total, avgViability: round2(avgViability), shortages };
}

function estimateCostPerLb({ inventory, forecast }) {
  const items = (inventory.items || []).filter(i => /compost|fertilizer|amend/i.test((i.category || i.name || "")));
  const cost = sum(items.map(i => Number(i.unitCost || 0) * Number(i.qty || 1)));
  const lbs = sum(Object.values(forecast || {}).map(x => Number(x.lbs || 0)));
  return { costHorizon: round2(cost), costPerLb: lbs ? round2(cost / lbs) : 0 };
}

function analyzeWorkload({ tasks, horizonDays }) {
  const back = (tasks || []).filter(t => !t.done);
  const upcoming = back.filter(t => t.dueTs && t.dueTs <= (now() + horizonDays * dayMs));
  const late = back.filter(t => t.dueTs && t.dueTs < now());
  return {
    backlog: { total: back.length, late: late.length },
    upcomingWork: upcoming.sort((a, b) => (a.dueTs || 0) - (b.dueTs || 0)).slice(0, 20),
  };
}

function buildAlerts({ bedUsagePct, planAdherence, pestPressure, waterNeed, seedStatus, surplusDeficit, rotation, succession }) {
  const alerts = [];
  if (bedUsagePct < 0.6) {
    alerts.push({ level: "info", code: "BED_UNDERUSED", message: "Beds underused. Want a quick succession plan?",
      actions: [{ label: "Suggest Successions", topic: "garden.succession.suggest.open" }] });
  }
  if (planAdherence < 0.7) {
    alerts.push({ level: "warning", code: "PLAN_OFF_TRACK", message: "Planting plan is off track this month.",
      actions: [{ label: "Review Calendar", topic: "garden.calendar.open" }] });
  }
  if (pestPressure >= 60) {
    alerts.push({ level: "warning", code: "PEST_PRESSURE", message: "Pest pressure is high. Queue IPM tasks?",
      actions: [{ label: "IPM Checklist", topic: "garden.ipm.checklist.open" }] });
  }
  if (waterNeed.risk >= 60) {
    alerts.push({ level: "warning", code: "WATER_DEFICIT", message: "Irrigation deficit likely. Schedule watering?",
      actions: [{ label: "Schedule Watering", topic: "garden.irrigation.schedule.open" }] });
  }
  if ((seedStatus.shortages || []).length) {
    alerts.push({ level: "warning", code: "SEED_SHORTAGE", message: "Seed shortages detected for upcoming sowings.",
      actions: [{ label: "Build Seed Order", topic: "seeds.order.plan.open" }] });
  }
  const deficits = Object.entries(surplusDeficit).filter(([_, v]) => (v.delta || 0) < 0);
  if (deficits.length) {
    alerts.push({ level: "info", code: "CROP_DEFICIT", message: `${deficits.length} crop deficit(s) within 4 weeks.`,
      actions: [{ label: "Swap/Scale Plan", topic: "garden.plan.balance.open" }] });
  }
  if ((rotation.issues || []).length) {
    alerts.push({ level: "info", code: "ROTATION_RISK", message: "Rotation risks flagged on some beds.",
      actions: [{ label: "View Rotation", topic: "garden.rotation.open" }] });
  }
  if (Object.keys(succession.gaps || {}).length) {
    alerts.push({ level: "info", code: "SUCCESSION_GAPS", message: "Gaps in successions detected.",
      actions: [{ label: "Fill Gaps", topic: "garden.succession.suggest.open" }] });
  }
  return alerts;
}

/* -----------------------------------------------------------------------------
   UI Cards (dashboard-ready)
----------------------------------------------------------------------------- */
export function toDashboardCards(snapshot) {
  if (!snapshot) return [];
  if (snapshot.scope === "coalition") {
    const deficits = Object.values(snapshot.pooled?.surplusDeficit || {}).filter(v => v.delta < 0).length;
    const imb = snapshot.fairness?.imbalanceIdx || 0;
    return [
      {
        id: "coalition-forecast-balance",
        title: "Coalition · Forecast Balance",
        value: deficits ? `-${deficits} crop(s)` : "Balanced",
        meta: "Pooled forecast vs 4-week demand",
        intent: deficits ? "warning" : "success",
      },
      {
        id: "coalition-fairness",
        title: "Coalition · Fairness",
        value: `${Math.round(imb * 100)} MAD%`,
        meta: "Lower is more balanced contribution",
        intent: imb > 0.35 ? "warning" : imb > 0.2 ? "info" : "success",
      },
      {
        id: "coalition-bed-usage",
        title: "Coalition · Bed Usage",
        value: `${Math.round((snapshot.pooled?.beds?.usagePct || 0) * 100)}%`,
        meta: `${snapshot.pooled?.beds?.plantedArea}/${snapshot.pooled?.beds?.totalArea} sq ft planted`,
        intent: (snapshot.pooled?.beds?.usagePct || 0) >= 0.8 ? "success" : (snapshot.pooled?.beds?.usagePct || 0) >= 0.6 ? "info" : "warning",
      },
    ];
  }

  const scopePrefix = snapshot.scope === "group" ? "Group · " : "";
  const deficits = Object.values(snapshot.surplusDeficit || {}).filter(v => v.delta < 0).length;
  const seedsShort = (snapshot.seeds?.shortages || []).length;

  return [
    {
      id: "bed-usage",
      title: scopePrefix + "Bed Usage",
      value: `${Math.round((snapshot.beds.usagePct || 0) * 100)}%`,
      meta: `${snapshot.beds.plantedArea}/${snapshot.beds.totalArea} sq ft planted`,
      intent: snapshot.beds.usagePct >= 0.8 ? "success" : snapshot.beds.usagePct >= 0.6 ? "info" : "warning",
    },
    {
      id: "plan-adherence",
      title: scopePrefix + "Plan Adherence",
      value: `${Math.round((snapshot.plan.adherence || 0) * 100)}%`,
      meta: `${snapshot.plan.plantedThisMonth}/${snapshot.plan.planned} planned executed`,
      intent: snapshot.plan.adherence >= 0.85 ? "success" : snapshot.plan.adherence >= 0.7 ? "info" : "warning",
    },
    {
      id: "pest-pressure",
      title: scopePrefix + "Pest Pressure",
      value: `${snapshot.pests.pressure}/100`,
      meta: `${snapshot.pests.last30} sightings (30d)`,
      intent: snapshot.pests.pressure >= 60 ? "warning" : "info",
    },
    {
      id: "water-need",
      title: scopePrefix + "Watering Need",
      value: `${snapshot.water.risk}/100`,
      meta: `Deficit: ${snapshot.water.deficitIn}" last 7d`,
      intent: snapshot.water.risk >= 60 ? "warning" : "info",
    },
    {
      id: "seed-health",
      title: scopePrefix + "Seed Health",
      value: `${Math.round((snapshot.seeds.avgViability || 0) * 100)}%`,
      meta: `${seedsShort} shortages pending`,
      intent: seedsShort ? "warning" : "success",
    },
    {
      id: "forecast-balance",
      title: scopePrefix + "Forecast Balance",
      value: deficits ? `-${deficits} crop(s)` : "Balanced",
      meta: "Forecast vs 4-week demand",
      intent: deficits ? "warning" : "success",
    },
  ];
}

/* -----------------------------------------------------------------------------
   “Suggest” helpers
----------------------------------------------------------------------------- */
export function suggestSuccessions({ snapshot, max = 10 } = {}) {
  const gaps = snapshot?.succession?.gaps || {};
  const out = [];
  Object.entries(gaps).forEach(([crop, arr]) => {
    arr.forEach(g => {
      out.push({
        crop,
        reason: `Gap of ${g.days} days`,
        action: "schedule_sowing",
        whenTs: Math.min(now() + 2 * dayMs, g.from + (g.days * dayMs) / 2),
      });
    });
  });
  return out.slice(0, max);
}

export function suggestCoalitionTrades({ coalitionSnapshot, max = 12 } = {}) {
  const s = coalitionSnapshot;
  if (!s || s.scope !== "coalition") return [];
  return (s.coordination?.suggestions || []).slice(0, max);
}

/* -----------------------------------------------------------------------------
   Event-driven analytics bus
----------------------------------------------------------------------------- */
class GardenAnalytics extends EventEmitter {
  constructor() {
    super();
    this._snaps = storage.get(); // { personal, group:<id>, coalition:<id> }
    this._hooked = false;
  }

  snapshotPersonal() { return this._snaps.personal || this.recompute({}); }
  snapshotGroup(groupId) {
    return this._snaps[`group:${groupId}`] || this.recompute({ groupId });
  }
  snapshotCoalition(coalitionId) {
    return this._snaps[`coalition:${coalitionId}`] || null;
  }

  recompute({ groupId = null } = {}) {
    const snap = computeGardenSnapshot({ groupId });
    const key = groupId == null ? "personal" : `group:${groupId}`;
    this._snaps[key] = snap;
    storage.set(this._snaps);

    this.emit("updated", { key, snapshot: snap });
    automation?.emitEvent?.("garden.analytics.updated", { key, snapshot: snap });

    try { this._maybeNBA(snap); } catch {}
    return snap;
  }

  async recomputeCoalition(coalitionId) {
    const snap = await computeCoalitionSnapshot({ coalitionId });
    if (!snap) return null;
    const key = `coalition:${coalitionId}`;
    this._snaps[key] = snap;
    storage.set(this._snaps);

    this.emit("updated", { key, snapshot: snap });
    automation?.emitEvent?.("garden.coalition.analytics.updated", { key, snapshot: snap });

    try { this._maybeNBACoalition(snap); } catch {}
    return snap;
  }

  _maybeNBA(snap) {
    if (!automation?.emitEvent) return;
    const deficits = Object.values(snap.surplusDeficit || {}).filter(v => v.delta < 0).length;

    if ((snap.seeds?.shortages || []).length) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "seed-shortage",
        message: "Seed shortages detected. Build an order or swap crops?",
        actions: [
          { label: "Seed Order", topic: "seeds.order.plan.open" },
          { label: "Swap Plan", topic: "garden.plan.balance.open" },
        ],
        ts: now(),
      });
    }
    if (deficits) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "crop-deficit",
        message: `${deficits} deficit crop(s) vs demand. Rebalance plan?`,
        actions: [{ label: "Rebalance", topic: "garden.plan.balance.open" }],
        ts: now(),
      });
    }
    if (snap.pests?.pressure >= 60) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "ipm-nudge",
        message: "Pest pressure high. Queue IPM tasks and set trap reminders?",
        actions: [{ label: "Open IPM", topic: "garden.ipm.checklist.open" }],
        ts: now(),
      });
    }
  }

  _maybeNBACoalition(s) {
    if (!automation?.emitEvent) return;
    const deficits = Object.values(s.pooled?.surplusDeficit || {}).filter(v => v.delta < 0).length;

    if (deficits) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "coalition-deficit",
        message: `Coalition has ${deficits} deficit crop(s). Coordinate trades or expand plantings?`,
        actions: [
          { label: "Open Coordination", topic: "garden.coalition.balance.open", payload: { coalitionId: s.coalitionId } },
          { label: "Trade Board", topic: "garden.coalition.tradeboard.open", payload: { coalitionId: s.coalitionId } },
        ],
        ts: now(),
      });
    }
    if ((s.fairness?.imbalanceIdx || 0) > 0.35) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "coalition-fairness",
        message: "Contribution imbalance detected across members. Reassign crops or tasks?",
        actions: [{ label: "Reassign Plan", topic: "garden.coalition.tasks.balance.open", payload: { coalitionId: s.coalitionId } }],
        ts: now(),
      });
    }
  }

  hookEvents() {
    if (this._hooked) return;
    this._hooked = true;

    const gardenTopics = [
      "garden.updated",
      "garden.planting.logged",
      "garden.harvest.logged",
      "garden.pest.logged",
      "garden.irrigation.logged",
      "seeds.updated",
      "inventory.updated",
      "weather.updated",
      "calendar.plan.updated",
      "tasks.updated",
    ];
    const groupTopics = [
      "group.membership.updated",
      "group.demand.updated",
    ];
    const coalitionTopics = [
      "coalition.membership.updated",
      "coalition.demand.updated",
      "coalition.targets.updated",
      "coalition.memberGarden.updated",
    ];

    gardenTopics.forEach(t => automation?.onTopic?.(t, () => { try { this.recompute({}); } catch {} }));
    groupTopics.forEach(t => automation?.onTopic?.(t, (evt) => {
      const gid = evt?.payload?.groupId ?? null;
      if (gid != null) try { this.recompute({ groupId: gid }); } catch {}
    }));
    coalitionTopics.forEach(t => automation?.onTopic?.(t, async (evt) => {
      const cid = evt?.payload?.coalitionId;
      if (cid) try { await this.recomputeCoalition(cid); } catch {}
    }));

    if (eventBus?.on) {
      [...gardenTopics, ...groupTopics, ...coalitionTopics].forEach(t => eventBus.on(t, async (payload) => {
        const gid = payload?.groupId ?? null;
        const cid = payload?.coalitionId ?? null;
        if (cid) await this.recomputeCoalition(cid);
        else this.recompute({ groupId: gid });
      }));
    }
  }
}

export const gardenAnalytics = new GardenAnalytics();

/* -----------------------------------------------------------------------------
   Automation templates & triggers
----------------------------------------------------------------------------- */
function registerAutomationTemplates() {
  if (!automation?.registerTemplate) return;

  automation.register([
    {
      id: "garden.daily-kpis",
      title: "Garden: Daily KPIs",
      description: "Compute personal garden KPIs and raise NBA when needed.",
      tags: ["garden", "analytics"],
      schedule: { at: "07:00" },
      timeoutMs: 12000,
      async run({ emit }) {
        const snap = gardenAnalytics.recompute({});
        emit?.("garden.analytics.daily", { scope: "personal", snapshot: snap });
        return { ok: true };
      },
    },
    {
      id: "garden.group-daily-kpis",
      title: "Garden: Group KPIs",
      description: "Compute KPIs for each joined group garden.",
      tags: ["garden", "analytics", "group"],
      schedule: { at: "07:10" },
      timeoutMs: 20000,
      async run({ emit }) {
        const groups = readGroups().groups || [];
        for (const g of groups.filter(x => x.type === "group" || !x.type)) {
          const snap = gardenAnalytics.recompute({ groupId: g.id });
          emit?.("garden.analytics.daily", { scope: "group", groupId: g.id, snapshot: snap });
        }
        return { ok: true, groups: groups.length };
      },
    },
    {
      id: "garden.coalition-daily-kpis",
      title: "Garden: Coalition KPIs",
      description: "Aggregate multi-garden analytics for coalition goals.",
      tags: ["garden", "analytics", "coalition"],
      schedule: { at: "07:20" },
      timeoutMs: 40000,
      async run({ emit }) {
        const coalitions = (readCoalitions().coalitions || []).concat(
          (readGroups().groups || []).filter(g => g.type === "coalition" || g.kind === "coalition")
        );
        for (const c of coalitions) {
          const snap = await gardenAnalytics.recomputeCoalition(c.id);
          emit?.("garden.coalition.analytics.daily", { coalitionId: c.id, snapshot: snap });
        }
        return { ok: true, coalitions: coalitions.length };
      },
    },
    {
      id: "garden.weekly-balance",
      title: "Garden: Weekly Balance & Succession",
      description: "Suggest successions and (group/coalition) balance actions.",
      tags: ["garden", "analytics", "forecast"],
      schedule: { days: [0], at: "09:00" }, // Sunday
      timeoutMs: 30000,
      async run({ emit }) {
        const personal = gardenAnalytics.snapshotPersonal();
        const succ = suggestSuccessions({ snapshot: personal });
        if (succ.length) {
          emit?.("nba", {
            topic: "nba",
            kind: "succession-suggest",
            message: `Suggest ${succ.length} succession action(s) to close gaps.`,
            actions: [{ label: "Review Suggestions", topic: "garden.succession.suggest.open" }],
            ts: now(),
          });
        }

        const coalitions = (readCoalitions().coalitions || []).concat(
          (readGroups().groups || []).filter(g => g.type === "coalition" || g.kind === "coalition")
        );
        for (const c of coalitions) {
          const snap = gardenAnalytics.snapshotCoalition(c.id) || await gardenAnalytics.recomputeCoalition(c.id);
          const trades = suggestCoalitionTrades({ coalitionSnapshot: snap });
          if (trades.length) {
            emit?.("nba", {
              topic: "nba",
              kind: "coalition-trades",
              message: `Coalition “${snap.name}”: ${trades.length} trade suggestion(s) ready.`,
              actions: [{ label: "Open Coordination", topic: "garden.coalition.balance.open", payload: { coalitionId: c.id } }],
              ts: now(),
            });
          }
        }
        return { ok: true };
      },
    },
  ]);

  // Triggers
  automation.registerTrigger(() => {
    const topics = [
      "garden.updated","garden.planting.logged","garden.harvest.logged","garden.pest.logged","garden.irrigation.logged",
      "seeds.updated","inventory.updated","weather.updated","calendar.plan.updated","tasks.updated",
      "group.membership.updated","group.demand.updated",
      "coalition.membership.updated","coalition.demand.updated","coalition.targets.updated","coalition.memberGarden.updated",
    ];
    const unsubs = topics.map(t => automation.onTopic?.(t, async (evt) => {
      const gid = evt?.payload?.groupId ?? null;
      const cid = evt?.payload?.coalitionId ?? null;
      if (cid) await gardenAnalytics.recomputeCoalition(cid);
      else gardenAnalytics.recompute({ groupId: gid });
    }));
    return () => unsubs.forEach(u => u?.());
  });
}

registerAutomationTemplates();
gardenAnalytics.hookEvents();

/* -----------------------------------------------------------------------------
   Public helpers for consumers
----------------------------------------------------------------------------- */
export function getSnapshot() {
  return gardenAnalytics.snapshotPersonal();
}
export function getGroupSnapshot(groupId) {
  return gardenAnalytics.snapshotGroup(groupId);
}
export async function getCoalitionSnapshot(coalitionId) {
  return gardenAnalytics.snapshotCoalition(coalitionId) || await gardenAnalytics.recomputeCoalition(coalitionId);
}
export function getDashboardCards({ groupId = null, coalitionId = null } = {}) {
  if (coalitionId != null) return toDashboardCards(gardenAnalytics.snapshotCoalition(coalitionId));
  const snap = groupId == null ? getSnapshot() : getGroupSnapshot(groupId);
  return toDashboardCards(snap);
}
export function exportGardenAnalytics({ groupId = null, coalitionId = null, format = "json" } = {}) {
  const snap = coalitionId != null
    ? gardenAnalytics.snapshotCoalition(coalitionId)
    : (groupId == null ? getSnapshot() : getGroupSnapshot(groupId));
  if (!snap) return null;

  if (format === "json") return JSON.stringify(snap);
  if (format === "csv") {
    if (snap.scope === "coalition") {
      const deficits = Object.entries(snap.pooled?.surplusDeficit || {}).map(([c, v]) => `${c}:${v.delta}`).join("|");
      const row = [
        ["ts", snap.ts],
        ["scope", snap.scope],
        ["coalitionId", snap.coalitionId],
        ["imbalanceIdx", snap.fairness?.imbalanceIdx || 0],
        ["usagePct", snap.pooled?.beds?.usagePct || 0],
        ["deficits", deficits],
      ];
      return row.map(r => r.join(",")).join("\n");
    } else {
      const deficits = Object.entries(snap.surplusDeficit || {}).map(([c, v]) => `${c}:${v.delta}`).join("|");
      const row = [
        ["ts", snap.ts],
        ["scope", snap.scope],
        ["groupId", snap.groupId || ""],
        ["bedUsagePct", snap.beds.usagePct],
        ["planAdherence", snap.plan.adherence],
        ["pestPressure", snap.pests.pressure],
        ["waterRisk", snap.water.risk],
        ["avgSeedViability", snap.seeds.avgViability],
        ["deficits", deficits],
      ];
      return row.map(r => r.join(",")).join("\n");
    }
  }
  return null;
}

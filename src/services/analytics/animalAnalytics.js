// C:\Users\larho\suka-smart-assistant\src\services\analytics\animalAnalytics.js
/* ============================================================================
   animalAnalytics — Herd & Flock KPIs, forecasts, nudges, and Coalitions
   - Mammals + poultry (incl. chickens: layers, broilers, pullets, roosters, chicks)
   - Event-driven & defensive (works even if Stores/Agents are absent)
   - UI-ready cards + “Next Best Action” (NBA) nudges
   - Automation Runtime integration (daily/weekly schedules + triggers)
   - NEW: Coalitions (multi-herd, different users) for shared goals/targets
     * Aggregates independent herds (meat, milk, eggs, wool, feed, AU)
     * Fairness index & contribution balance
     * Trade/coordination suggestions to hit common goals
============================================================================ */

import EventEmitter from "eventemitter3";

/* -----------------------------------------------------------------------------
   Defensive optional imports (do not break when missing)
----------------------------------------------------------------------------- */
let automation;
let eventBus;
let AnimalStore, InventoryStore, CalendarStore, PreferencesStore, GroupStore, CoalitionStore;
try { ({ automation } = await import("@/services/automation/runtime")); } catch {}
try { ({ eventBus } = await import("@/services/events/eventBus")); } catch {}
try { ({ useAnimalStore: AnimalStore } = await import("@/store/AnimalStore")); } catch {}
try { ({ useInventoryStore: InventoryStore } = await import("@/store/InventoryStore")); } catch {}
try { ({ useCalendarStore: CalendarStore } = await import("@/store/CalendarStore")); } catch {}
try { ({ usePreferencesStore: PreferencesStore } = await import("@/store/PreferencesStore")); } catch {}
try { ({ useGroupStore: GroupStore } = await import("@/store/GroupStore")); } catch {}
try { ({ useCoalitionStore: CoalitionStore } = await import("@/store/CoalitionStore")); } catch {}

/* -----------------------------------------------------------------------------
   Local helpers & utils
----------------------------------------------------------------------------- */
const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const dayMs = 86_400_000;

const safeJSON = {
  parse: (s, f = null) => { try { return JSON.parse(s); } catch { return f; } },
  stringify: (o) => { try { return JSON.stringify(o); } catch { return ""; } },
};

const storage = (() => {
  const keyPrefix = "suka::animalAnalytics::";
  if (isBrowser && window.localStorage) {
    return {
      get: (k, d = null) => safeJSON.parse(localStorage.getItem(keyPrefix + k), d),
      set: (k, v) => localStorage.setItem(keyPrefix + k, safeJSON.stringify(v)),
      del: (k) => localStorage.removeItem(keyPrefix + k),
    };
  }
  const mem = new Map();
  return {
    get: (k, d = null) => (mem.has(k) ? mem.get(k) : d),
    set: (k, v) => mem.set(k, v),
    del: (k) => mem.delete(k),
  };
})();

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function sum(arr) { return arr.reduce((a, b) => a + b, 0); }
function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stddev(arr) {
  if (!arr.length) return 0;
  const m = avg(arr);
  return Math.sqrt(avg(arr.map(x => (x - m) ** 2)));
}
function ema(arr, k = 0.4) {
  if (!arr.length) return [];
  const out = [arr[0]];
  for (let i = 1; i < arr.length; i++) out[i] = k * arr[i] + (1 - k) * out[i - 1];
  return out;
}
function daysAgo(ts) { return Math.floor((now() - ts) / dayMs); }
function nextNDays(n) {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  return Array.from({ length: n }, (_, i) => new Date(base.getTime() + (i * dayMs)).getTime());
}
function groupBy(arr, keyFn) {
  return arr.reduce((acc, x) => {
    const k = keyFn(x);
    (acc[k] ||= []).push(x);
    return acc;
  }, {});
}
function round2(n) { return Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100; }

/* -----------------------------------------------------------------------------
   Store accessors (defensive)
----------------------------------------------------------------------------- */
function readAnimals() {
  try { return AnimalStore?.()?.animals || []; } catch { return []; }
}
function readEvents() {
  try { return AnimalStore?.()?.logs || []; } catch { return []; }
}
function readInventory() {
  try { return InventoryStore?.()?.items || []; } catch { return []; }
}
function readPrefs() {
  try { return PreferencesStore?.()?.animals || {}; } catch { return {}; }
}
function readCalendar() {
  try { return CalendarStore?.()?.events || []; } catch { return []; }
}
function readCoalitions() {
  try { return CoalitionStore?.() || { coalitions: [] }; } catch { return { coalitions: [] }; }
}
function readGroups() {
  try { return GroupStore?.() || { groups: [] }; } catch { return { groups: [] }; }
}

/* =============================================================================
   PERSONAL SNAPSHOT — herd + flock KPIs, trends, forecasts, alerts
============================================================================= */

/**
 * computeHerdSnapshot — aggregates primary KPIs for one user/herd
 * Returns { totals, reproduction, health, feed, production, utilization, poultry }
 */
export function computeHerdSnapshot({
  animals = readAnimals(),
  events = readEvents(),
  inventory = readInventory(),
  prefs = readPrefs()
} = {}) {
  const alive = animals.filter(a => !a.deceased && !a.sold && !a.butchering?.completed);
  const mammals = alive.filter(a => !isChicken(a));
  const poultry  = alive.filter(a => isChicken(a));

  // Mammals breakdown
  const females = mammals.filter(a => (a.sex || "").toLowerCase().startsWith("f"));
  const males   = mammals.filter(a => (a.sex || "").toLowerCase().startsWith("m"));
  const young   = mammals.filter(a => /lamb|kid|calf/i.test(a.category || ""));

  // Poultry breakdown
  const hens     = poultry.filter(a => isHen(a));
  const roosters = poultry.filter(a => isRooster(a));
  const pullets  = poultry.filter(a => /pullet/i.test(a.category || ""));
  const chicks   = poultry.filter(a => /chick/i.test(a.category || ""));

  // Mammal: Weight gain trend (last 60d)
  const weightLogs = events.filter(e => e.type === "weight" && !isChickenId(e.animalId, animals));
  const byAnimal = groupBy(weightLogs, l => l.animalId);
  const gains = Object.values(byAnimal).map(series => {
    const sorted = series.sort((a, b) => a.ts - b.ts);
    const first = sorted[0]?.weight ?? 0;
    const last = sorted[sorted.length - 1]?.weight ?? 0;
    const daysBetween = Math.max(1, Math.floor((sorted[sorted.length - 1].ts - sorted[0].ts) / dayMs));
    return (last - first) / daysBetween;
  });
  const avgDailyGain = avg(gains) || 0;

  // Health incidents (rolling 30d) – mammals + poultry
  const healthLogs30 = events.filter(e => e.type === "health" && daysAgo(e.ts) <= 30);
  const healthIncidentRate = alive.length ? (healthLogs30.length / alive.length) : 0;

  // Reproduction (mammals)
  const reproduction = analyzeReproduction({ animals: mammals, events, prefs });

  // Poultry production (eggs)
  const poultryProd = analyzeEggProduction({ animals: poultry, events, prefs });

  // Feed forecast & cost-of-gain (30d)
  const feedPlan = forecastFeed({ animals: alive, events, inventory, prefs, horizonDays: 30 });

  // Production (mammals): milk, wool, meat
  const production = analyzeProduction({ animals: mammals, events });

  // Utilization (pasture pressure)
  const utilization = estimatePastureUtilization({ animals: mammals, poultry, prefs });

  // Alerts
  const alerts = buildAlerts({
    animals: alive,
    events,
    avgDailyGain,
    healthIncidentRate,
    feedPlan,
    production,
    eggProd: poultryProd,
    inventory
  });

  return {
    ts: now(),
    totals: {
      herdSize: mammals.length,
      flockSize: poultry.length,
      females: females.length,
      males: males.length,
      young: young.length,
      hens: hens.length,
      roosters: roosters.length,
      pullets: pullets.length,
      chicks: chicks.length,
    },
    reproduction,
    poultry: poultryProd,
    health: { incidentRate30d: healthIncidentRate, last30d: healthLogs30.length },
    feed: feedPlan.summary,
    production,
    utilization,
    alerts,
  };
}

/* -----------------------------------------------------------------------------
   Species helpers
----------------------------------------------------------------------------- */
function isChicken(entity) {
  const sp = (entity?.species || "").toLowerCase();
  return /chicken|poultry|hen|rooster|layer|broiler|leghorn|rhode|orpington|wyandotte|barred/i.test(sp) ||
         /hen|rooster|pullet|chick|broiler|layer/i.test((entity?.category || "").toLowerCase());
}
function isHen(a) {
  const s = (a.sex || "").toLowerCase();
  const c = (a.category || "").toLowerCase();
  return isChicken(a) && (s.startsWith("f") || /hen|layer/i.test(c));
}
function isRooster(a) {
  const s = (a.sex || "").toLowerCase();
  const c = (a.category || "").toLowerCase();
  return isChicken(a) && (s.startsWith("m") || /rooster|cock/i.test(c));
}
function isChickenId(id, animals) {
  const a = (animals || []).find(x => x.id === id);
  return a ? isChicken(a) : false;
}

/* -----------------------------------------------------------------------------
   Reproduction analytics for mammals
----------------------------------------------------------------------------- */
export function analyzeReproduction({ animals, events, prefs = {} }) {
  const gestationDays = prefs.gestationDays ?? 152; // sheep ~152; goats ~150; cattle ~283 (override)
  const heatCycleDays = prefs.heatCycleDays ?? 17;

  const breedLogs = events.filter(e => e.type === "breeding");
  const byAnimal = groupBy(breedLogs, e => e.animalId);
  const due = [];
  const heats = [];

  animals.forEach(a => {
    const series = (byAnimal[a.id] || []).sort((x, y) => x.ts - y.ts);
    if (series.length) {
      const lastService = series[series.length - 1];
      const estDue = lastService.ts + gestationDays * dayMs;
      due.push({ animalId: a.id, name: a.name, dueTs: estDue, method: lastService.method || "natural" });
    } else {
      const lastHeat = events
        .filter(e => e.type === "heat" && e.animalId === a.id)
        .sort((x, y) => y.ts - x.ts)[0];
      if (lastHeat) {
        const nextHeat = lastHeat.ts + heatCycleDays * dayMs;
        if (nextHeat > now()) heats.push({ animalId: a.id, name: a.name, nextHeatTs: nextHeat });
      }
    }
  });

  return {
    gestationDays, heatCycleDays,
    due: due.sort((a, b) => a.dueTs - b.dueTs).slice(0, 20),
    heatWindows: heats.sort((a, b) => a.nextHeatTs - b.nextHeatTs).slice(0, 20),
    counts: { expecting: due.length, heatWatch: heats.length },
  };
}

/* -----------------------------------------------------------------------------
   Poultry: egg production analytics
----------------------------------------------------------------------------- */
export function analyzeEggProduction({ animals, events, prefs = {} }) {
  const layers = animals.filter(a => isHen(a));
  const lays = events.filter(e => e.type === "egg_collect");
  const last30 = lays.filter(e => daysAgo(e.ts) <= 30);
  const last7  = lays.filter(e => daysAgo(e.ts) <= 7);
  const eggs30 = sum(last30.map(e => e.eggs || 0));
  const eggs7  = sum(last7.map(e => e.eggs || 0));

  // Lay rate per hen per day (7d)
  const henDays7 = Math.max(1, layers.length * 7);
  const layRate7 = eggs7 / henDays7;

  // EMA trend (30d)
  const dayBuckets = bucketDaily(lays, 30);
  const emaEggs = ema(dayBuckets.map(d => d.count), 0.3);

  // Mortality rate last 30d (poultry)
  const mort = events.filter(e => e.type === "mortality" && (e.species === "chicken" || e.flockTag === "chicken"));
  const mort30 = mort.filter(e => daysAgo(e.ts) <= 30).length;
  const mortRate30 = layers.length ? mort30 / layers.length : 0;

  return {
    layers: layers.length,
    eggs: { last7: eggs7, last30: eggs30, layRate7 },
    mortality30: mortRate30,
    trend: { daily: dayBuckets, ema: emaEggs },
  };
}

function bucketDaily(events, days = 30) {
  const map = new Map();
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    map.set(d.getTime(), 0);
  }
  events.forEach(e => {
    const d = new Date(e.ts);
    d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    if (map.has(k)) map.set(k, (map.get(k) || 0) + (e.eggs || 0));
  });
  return Array.from(map.entries()).sort((a, b) => a[0] - b[0]).map(([ts, count]) => ({ ts, count }));
}

/* -----------------------------------------------------------------------------
   Feed forecast: ration estimate, inventory impact, cost, shortages
----------------------------------------------------------------------------- */
export function forecastFeed({
  animals,
  events,
  inventory,
  prefs = {},
  horizonDays = 30,
}) {
  // Mammals intake % per 100kg BW
  const defaultIntakePct = {
    ewe: 3.0, ram: 2.5, lamb: 4.0, goat_doe: 3.5, buck: 3.0, kid: 4.5, cattle: 2.5,
  };
  const intakePct = { ...defaultIntakePct, ...(prefs.intakePct || {}) };

  // Poultry grams/day DM
  const defaultPoultryIntakeG = {
    hen: 110, rooster: 90, pullet: 95, chick: 30, broiler: 150,
  };
  const poultryIntakeG = { ...defaultPoultryIntakeG, ...(prefs.poultryIntakeG || {}) };

  const lastWeights = latestWeights(events);

  let dailyDM = 0;
  animals.forEach(a => {
    if (isChicken(a)) {
      const cls = classifyBird(a);
      const g = poultryIntakeG[cls] ?? poultryIntakeG.hen;
      dailyDM += (g / 1000);
    } else {
      const w = lastWeights.get(a.id) ?? (a.estimatedWeight ?? defaultWeight(a));
      const cls = classifyAnimal(a);
      const pct = intakePct[cls] ?? 3.0;
      dailyDM += (w / 100) * pct;
    }
  });

  const FEED_CATS = ["hay", "pellet", "grain", "corn", "mineral", "salt", "silage", "layer", "scratch", "oyster", "grit"];
  const feeds = (inventory || [])
    .filter(i => FEED_CATS.includes((i.category || "").toLowerCase()))
    .map(i => ({
      id: i.id, name: i.name, sku: i.sku,
      category: (i.category || "").toLowerCase(),
      dmKg: i.dmKg ?? guessDMKg(i),
      unitCost: i.unitCost ?? 0,
      qty: i.qty ?? 1,
    }));

  const totalDMAvailable = sum(feeds.map(f => f.dmKg));
  const daysCovered = dailyDM ? Math.floor(totalDMAvailable / dailyDM) : 0;
  const shortfallDays = Math.max(0, horizonDays - daysCovered);

  const dailyCost = proportionalDailyCost(feeds, totalDMAvailable, dailyDM);
  const costHorizon = dailyCost * horizonDays;

  const oyster = feeds.filter(f => /oyster/.test(f.category) || /oyster/i.test(f.name));
  const hasCalcium = sum(oyster.map(o => o.dmKg)) > 0;

  return {
    summary: {
      horizonDays,
      herdDailyDMKg: round2(dailyDM),
      totalDMAvailableKg: round2(totalDMAvailable),
      daysCovered,
      shortfallDays,
      dailyCost: round2(dailyCost),
      horizonCost: round2(costHorizon),
      calciumOk: !!hasCalcium,
    },
    feeds,
  };
}

function latestWeights(events) {
  const map = new Map();
  const weights = events.filter(e => e.type === "weight").sort((a, b) => a.ts - b.ts);
  for (const w of weights) map.set(w.animalId, w.weight);
  return map;
}
function defaultWeight(a) {
  const sp = (a.species || "").toLowerCase();
  if (/goat/.test(sp)) return 45;
  if (/cattle|cow|heifer|steer|bull/.test(sp)) return 350;
  if (/sheep|ov/.test(sp)) return 40;
  return 40;
}
function guessDMKg(item) {
  const w = item.weightKg ?? 20;
  const dmPct = /hay|silage/i.test(item.name) || /hay|silage/i.test(item.category || "") ? 0.85 : 0.9;
  return w * dmPct * (item.qty ?? 1);
}
function classifyAnimal(a) {
  const c = (a.category || "").toLowerCase();
  const s = (a.sex || "").toLowerCase();
  if (/ewe/.test(c) || (s.startsWith("f") && /sheep|ov|cap/.test(a.species || ""))) return "ewe";
  if (/lamb/.test(c)) return "lamb";
  if (/kid/.test(c)) return "kid";
  if (/goat/.test((a.species || "").toLowerCase()) && s.startsWith("f")) return "goat_doe";
  if (/(ram|buck)/.test(c) || s.startsWith("m")) return "ram";
  if (/cattle|cow|heifer|steer|bull/.test((a.species || "").toLowerCase())) return "cattle";
  return "ewe";
}
function classifyBird(a) {
  const c = (a.category || "").toLowerCase();
  const s = (a.sex || "").toLowerCase();
  if (/broiler/.test(c)) return "broiler";
  if (/pullet/.test(c)) return "pullet";
  if (/chick/.test(c)) return "chick";
  if (s.startsWith("m") || /rooster|cock/.test(c)) return "rooster";
  return "hen";
}
function proportionalDailyCost(feeds, totalDM, dailyDM) {
  if (!totalDM || !dailyDM) return 0;
  const dmRatio = dailyDM / totalDM;
  return sum(feeds.map(f => (f.unitCost || 0) * (f.dmKg || 0))) * dmRatio;
}

/* -----------------------------------------------------------------------------
   Production: milk, wool, meat processed, off-take rate (mammals)
----------------------------------------------------------------------------- */
export function analyzeProduction({ animals, events }) {
  const milkLogs = events.filter(e => e.type === "milk");
  const woolLogs = events.filter(e => e.type === "shearing");
  const butcherLogs = events.filter(e => e.type === "butchering");

  const last30Milk = milkLogs.filter(e => daysAgo(e.ts) <= 30).map(e => e.volumeL || 0);
  const milk30L = sum(last30Milk);

  const woolYields = woolLogs.map(e => e.weightKg || 0);
  const woolTotal = sum(woolYields);
  const lastShearingTs = woolLogs.length ? woolLogs[woolLogs.length - 1].ts : null;

  const meatProcessedKg = sum(butcherLogs.map(e => e.carcassKg || 0));
  const offTakeRate = animals.length ? butcherLogs.length / animals.length : 0;

  return {
    milk: { last30dL: round2(milk30L), entries: last30Milk.length },
    wool: { totalKg: round2(woolTotal), lastShearingTs },
    meat: { processedKg: round2(meatProcessedKg), offTakeRate: round2(offTakeRate) },
  };
}

/* -----------------------------------------------------------------------------
   Pasture utilization proxy (0–100); poultry contributes lightly if pastured
----------------------------------------------------------------------------- */
export function estimatePastureUtilization({ animals, poultry = [], prefs = {} }) {
  const acres = prefs.pastureAcres ?? 2;
  const auPerAnimal = prefs.animalUnit ?? 0.15; // small ruminants
  const auMammals = animals.length * auPerAnimal;

  const poultryAuPerBird = prefs.poultryUnit ?? 0.02; // light if tractored/free-range
  const auPoultry = poultry.length * poultryAuPerBird;

  const au = auMammals + auPoultry;
  const auPerAcre = acres ? au / acres : au;
  const target = prefs.targetAuPerAc ?? 0.25;
  const score = clamp((auPerAcre / target) * 50, 0, 100);

  return { acres, au: round2(au), auPerAcre: round2(auPerAcre), score: Math.round(score) };
}

/* -----------------------------------------------------------------------------
   Alerts & anomalies
----------------------------------------------------------------------------- */
export function buildAlerts({ animals, events, avgDailyGain, healthIncidentRate, feedPlan, production, eggProd, inventory }) {
  const alerts = [];

  if (feedPlan.summary.shortfallDays > 0) {
    alerts.push({
      level: "warning",
      code: "FEED_SHORTFALL",
      message: `Feed shortfall in ${feedPlan.summary.shortfallDays} day(s).`,
      actions: [{ label: "Plan Purchase", topic: "inventory.purchase.plan", payload: { category: "feed" } }],
    });
  }

  if (avgDailyGain < 0) {
    alerts.push({
      level: "warning",
      code: "WEIGHT_LOSS_TREND",
      message: "Average daily gain is negative; review ration and health.",
      actions: [{ label: "Open Ration Tool", topic: "animals.ration.open" }],
    });
  }

  if (healthIncidentRate > 0.2) {
    alerts.push({
      level: "warning",
      code: "HEALTH_SPIKE",
      message: "High health incident rate (30d). Consider vet check or isolation.",
      actions: [{ label: "Open Health Log", topic: "animals.health.log.open" }],
    });
  }

  if (eggProd?.layers > 0 && eggProd.eggs?.layRate7 != null) {
    const rate = eggProd.eggs.layRate7;
    if (rate < (inventoryLikelyWinter(inventory) ? 0.35 : 0.5)) {
      alerts.push({
        level: "info",
        code: "EGG_RATE_LOW",
        message: `Lay rate is low (~${round2(rate)} eggs/hen/day). Consider calcium, light hours, or parasites.`,
        actions: [
          { label: "Check Calcium", topic: "inventory.check.category", payload: { category: "oyster" } },
          { label: "Lighting Tips", topic: "knowledge.open", payload: { slug: "layer-lighting-basics" } },
        ],
      });
    }
  }

  if (!feedPlan.summary.calciumOk && (eggProd?.layers || 0) > 0) {
    alerts.push({
      level: "warning",
      code: "CALCIUM_LOW",
      message: "No oyster shell detected for layers. Add calcium to prevent shell issues.",
      actions: [{ label: "Add to List", topic: "inventory.purchase.plan", payload: { category: "oyster" } }],
    });
  }

  if (production.wool.lastShearingTs && daysAgo(production.wool.lastShearingTs) > 330) {
    alerts.push({
      level: "info",
      code: "SHEARING_DUE",
      message: "Shearing likely due soon.",
      actions: [{ label: "Schedule Shearing", topic: "calendar.create", payload: { type: "shearing" } }],
    });
  }

  return alerts;
}
function inventoryLikelyWinter(inventory = []) {
  const win = (inventory || []).filter(i => /hay|silage/i.test(i.category || i.name)).length;
  return win > 0;
}

/* -----------------------------------------------------------------------------
   Grazing rotation suggestion
----------------------------------------------------------------------------- */
export function suggestGrazingRotation({ animals = readAnimals(), prefs = readPrefs() } = {}) {
  const paddocks = prefs.paddocks || 4;
  const restDays = prefs.restDays || 28;
  const grazeDays = prefs.grazeDays || 3;
  const plan = [];
  const days = nextNDays(paddocks * grazeDays);

  for (let i = 0; i < paddocks; i++) {
    plan.push({
      type: "paddock",
      paddock: i + 1,
      startTs: days[i * grazeDays],
      endTs: days[i * grazeDays + (grazeDays - 1)],
      restUntil: days[i * grazeDays + (grazeDays - 1) + restDays],
    });
  }

  const poultry = animals.filter(isChicken);
  if (poultry.length) {
    const tractorDays = nextNDays(14);
    const tractorPlan = tractorDays.map((ts, idx) => ({
      type: "tractor",
      segment: idx + 1,
      moveTs: ts,
      note: "Move chicken tractor to fresh ground.",
    }));
    return { paddocks, restDays, grazeDays, plan, tractor: tractorPlan };
  }

  return { paddocks, restDays, grazeDays, plan };
}

/* -----------------------------------------------------------------------------
   UI Cards (ready-to-render)
----------------------------------------------------------------------------- */
export function toDashboardCards(snapshot) {
  const cards = [];
  if (!snapshot) return cards;

  cards.push({
    id: "herd-size",
    title: "Herd Size",
    value: String(snapshot.totals.herdSize),
    meta: `${snapshot.totals.females}F · ${snapshot.totals.males}M · ${snapshot.totals.young} young`,
    intent: "info",
  });

  cards.push({
    id: "flock-size",
    title: "Flock Size",
    value: String(snapshot.totals.flockSize),
    meta: `${snapshot.totals.hens} hens · ${snapshot.totals.roosters} roosters · ${snapshot.totals.pullets} pullets`,
    intent: "info",
  });

  const eggs7 = snapshot.poultry?.eggs?.last7 ?? 0;
  const layRate = snapshot.poultry?.eggs?.layRate7 ?? 0;
  cards.push({
    id: "eggs-7d",
    title: "Eggs (7d)",
    value: `${eggs7}`,
    meta: `Lay rate: ${round2(layRate)} eggs/hen/day`,
    intent: layRate < 0.5 && (snapshot.totals.hens || 0) > 0 ? "warning" : "success",
  });

  cards.push({
    id: "feed-coverage",
    title: "Feed Coverage",
    value: `${snapshot.feed.daysCovered} days`,
    meta: `Daily DM: ${snapshot.feed.herdDailyDMKg} kg · Cost/day: $${snapshot.feed.dailyCost}`,
    intent: snapshot.feed.shortfallDays > 0 ? "warning" : "success",
  });

  cards.push({
    id: "health-30d",
    title: "Health (30d)",
    value: `${Math.round(snapshot.health.incidentRate30d * 100)}%`,
    meta: `${snapshot.health.last30d} incidents`,
    intent: snapshot.health.incidentRate30d > 0.2 ? "warning" : "info",
  });

  cards.push({
    id: "production",
    title: "Production",
    value: `${snapshot.production.milk.last30dL} L milk · ${snapshot.production.meat.processedKg} kg meat`,
    meta: `Wool: ${snapshot.production.wool.totalKg} kg`,
    intent: "info",
  });

  cards.push({
    id: "utilization",
    title: "Pasture Pressure",
    value: `${snapshot.utilization.score}/100`,
    meta: `${snapshot.utilization.au} AU · ${snapshot.utilization.auPerAcre} AU/ac`,
    intent: snapshot.utilization.score > 70 ? "warning" : "info",
  });

  return cards;
}

/* =============================================================================
   COALITIONS (Multi-Herd, different users) — common goals & coordination
   Coalition model (flexible; works if CoalitionStore absent, falls back to GroupStore):
     coalition: {
       id, name, type: 'coalition',
       members: [{ userId, displayName }],
       pooledDemand: { meatKgPerWeek, milkLPerWeek, eggsPerWeek, woolKgPerSeason },
       targets: { meatKg, milkL, eggs, woolKg } // optional absolute horizon targets
       fairness: { basis: 'meatKg'|'milkL'|'eggs'|'AU' }
     }
============================================================================= */

// Resolve another member's data (their independent herd)
async function getMemberHerd(userId) {
  try { return await CoalitionStore?.getMemberHerd?.(userId); } catch {}
  try { return await GroupStore?.getMemberHerd?.(userId); } catch {}
  // Fallback: look in local cache (if some agent seeded it earlier)
  try { return storage.get(`memberHerd:${userId}`, null); } catch { return null; }
}

/**
 * computeCoalitionHerdSnapshot — aggregate independent herds toward shared goals
 * memberResolver result should include: { animals, events, inventory, prefs }
 */
export async function computeCoalitionHerdSnapshot({
  coalitionId,
  horizonDays = 30,
  memberResolver = getMemberHerd,
  coalitions = readCoalitions(),
  groups = readGroups(),
} = {}) {
  if (!coalitionId) return null;

  const coalition =
    (coalitions.coalitions || []).find(c => String(c.id) === String(coalitionId)) ||
    (groups.groups || []).find(g => String(g.id) === String(coalitionId) && (g.type === "coalition" || g.kind === "coalition")) ||
    { id: coalitionId, name: "Coalition", members: [], pooledDemand: {}, targets: {}, fairness: { basis: "meatKg" } };

  const members = coalition.members || [];
  const memberSnaps = [];

  for (const m of members) {
    const ctx = await memberResolver(m.userId);
    if (!ctx) { memberSnaps.push({ userId: m.userId, name: m.displayName || m.userId, error: "unavailable" }); continue; }

    const snap = computeHerdSnapshot({
      animals: ctx.animals || [],
      events: ctx.events || [],
      inventory: ctx.inventory || [],
      prefs: ctx.prefs || {},
    });

    memberSnaps.push({ userId: m.userId, name: m.displayName || m.userId, snapshot: snap });
  }

  const agg = aggregateCoalitionHerd(memberSnaps, coalition, horizonDays);
  const alerts = buildCoalitionHerdAlerts(agg);

  return {
    ts: now(),
    scope: "coalition-animals",
    coalitionId,
    name: coalition.name,
    horizonDays,
    members: memberSnaps,
    pooled: agg.pooled,     // aggregated KPIs (production, feed, AU, eggs)
    fairness: agg.fairness, // contribution balance
    coordination: agg.coord,// trade/coordination suggestions
    alerts,
  };
}

function aggregateCoalitionHerd(memberSnaps, coalition, horizonDays) {
  const pooled = {
    production: { meatKg: 0, milkL: 0, eggs: 0, woolKg: 0 },
    feed: { herdDailyDMKg: 0, horizonCost: 0, daysCoveredMin: null },
    AU: 0,
    eggs: { last7: 0, last30: 0 },
  };

  // Aggregate & compute contribution metrics
  const perMember = [];

  for (const m of memberSnaps) {
    const s = m.snapshot;
    if (!s) continue;

    // Production (30d)
    pooled.production.meatKg += Number(s.production?.meat?.processedKg || 0);
    pooled.production.milkL  += Number(s.production?.milk?.last30dL || 0);
    pooled.production.woolKg += Number(s.production?.wool?.totalKg || 0);

    // Eggs
    pooled.production.eggs   += Number(s.poultry?.eggs?.last30 || 0);
    pooled.eggs.last7        += Number(s.poultry?.eggs?.last7 || 0);
    pooled.eggs.last30       += Number(s.poultry?.eggs?.last30 || 0);

    // Feed
    pooled.feed.herdDailyDMKg += Number(s.feed?.herdDailyDMKg || 0);
    pooled.feed.horizonCost   += Number(s.feed?.horizonCost || 0);
    const daysCov = Number(s.feed?.daysCovered ?? 0);
    pooled.feed.daysCoveredMin = pooled.feed.daysCoveredMin == null ? daysCov : Math.min(pooled.feed.daysCoveredMin, daysCov);

    // AU
    pooled.AU += Number(s.utilization?.au || 0);

    // Contribution basis
    const basisValue = (() => {
      const basis = coalition?.fairness?.basis || "meatKg";
      if (basis === "milkL") return Number(s.production?.milk?.last30dL || 0);
      if (basis === "eggs")  return Number(s.poultry?.eggs?.last30 || 0);
      if (basis === "AU")    return Number(s.utilization?.au || 0);
      return Number(s.production?.meat?.processedKg || 0);
    })();

    perMember.push({
      userId: m.userId,
      name: m.name,
      basisValue: round2(basisValue),
    });
  }

  // Demand/Targets normalization over horizon (4 weeks approximation)
  const weeks = 4;
  const demand = {
    meatKg: Number(coalition?.pooledDemand?.meatKgPerWeek || 0) * weeks,
    milkL:  Number(coalition?.pooledDemand?.milkLPerWeek  || 0) * weeks,
    eggs:   Number(coalition?.pooledDemand?.eggsPerWeek   || 0) * weeks,
    woolKg: Number(coalition?.pooledDemand?.woolKgPerSeason || 0) / 12 * (horizonDays / 30), // spread seasonal wool
  };

  const surplusDeficit = {
    meatKg: round2((pooled.production.meatKg || 0) - demand.meatKg),
    milkL:  round2((pooled.production.milkL  || 0) - demand.milkL),
    eggs:   round2((pooled.production.eggs   || 0) - demand.eggs),
    woolKg: round2((pooled.production.woolKg || 0) - demand.woolKg),
  };

  const fairness = coalitionFairness(perMember, coalition);

  const coord = coalitionCoordinationAnimals({
    pooledProduction: pooled.production,
    demand,
    memberSnaps,
    basis: coalition?.fairness?.basis || "meatKg",
  });

  // Round pooled
  pooled.production.meatKg = round2(pooled.production.meatKg);
  pooled.production.milkL  = round2(pooled.production.milkL);
  pooled.production.woolKg = round2(pooled.production.woolKg);
  pooled.production.eggs   = Math.round(pooled.production.eggs);
  pooled.feed.herdDailyDMKg = round2(pooled.feed.herdDailyDMKg);
  pooled.feed.horizonCost   = round2(pooled.feed.horizonCost);
  pooled.AU = round2(pooled.AU);

  return {
    pooled: { ...pooled, demand, surplusDeficit },
    fairness,
    coord,
  };
}

function coalitionFairness(perMember, coalition) {
  const basis = coalition?.fairness?.basis || "meatKg";
  const values = perMember.map(m => Number(m.basisValue || 0));
  const mean = avg(values);
  const mad = avg(values.map(v => Math.abs(v - mean)));
  const imbalanceIdx = mean ? round2(mad / mean) : 0;

  // Optional total target split (absolute) → even share
  let perMemberTarget = null;
  if (coalition?.targets) {
    const totalTarget = sum(Object.values(coalition.targets || {}).map(Number));
    perMemberTarget = perMember.length ? round2(totalTarget / perMember.length) : null;
  }

  const members = perMember.map(m => ({
    ...m,
    target: perMemberTarget,
    deltaToTarget: perMemberTarget != null ? round2(m.basisValue - perMemberTarget) : null,
  }));

  return { basis, mean: round2(mean), imbalanceIdx, members };
}

function coalitionCoordinationAnimals({ pooledProduction, demand, memberSnaps, basis }) {
  const deficits = [];
  if ((pooledProduction.meatKg || 0) < (demand.meatKg || 0)) deficits.push({ metric: "meatKg", need: round2(demand.meatKg - pooledProduction.meatKg) });
  if ((pooledProduction.milkL  || 0) < (demand.milkL  || 0)) deficits.push({ metric: "milkL",  need: round2(demand.milkL  - pooledProduction.milkL) });
  if ((pooledProduction.eggs   || 0) < (demand.eggs   || 0)) deficits.push({ metric: "eggs",   need: round2(demand.eggs   - pooledProduction.eggs) });
  if ((pooledProduction.woolKg || 0) < (demand.woolKg || 0)) deficits.push({ metric: "woolKg", need: round2(demand.woolKg - pooledProduction.woolKg) });

  const suggestions = [];
  if (!deficits.length) return { suggestions };

  // Member surpluses (vs THEIR personal implied demand = 0; use production as availability)
  const memberAvail = memberSnaps.map(m => {
    const s = m.snapshot;
    return {
      userId: m.userId,
      name: m.name,
      meatKg: Number(s.production?.meat?.processedKg || 0),
      milkL:  Number(s.production?.milk?.last30dL   || 0),
      eggs:   Number(s.poultry?.eggs?.last30        || 0),
      woolKg: Number(s.production?.wool?.totalKg     || 0),
    };
  });

  for (const d of deficits) {
    let remaining = d.need;
    // Greedy: ask members with highest availability of that metric
    const sorted = [...memberAvail].sort((a, b) => Number(b[d.metric] || 0) - Number(a[d.metric] || 0));
    for (const mem of sorted) {
      const avail = Number(mem[d.metric] || 0);
      if (avail <= 0) continue;
      const give = round2(Math.min(avail * 0.5, remaining)); // suggest up to 50% of their current
      if (give <= 0) continue;
      suggestions.push({ metric: d.metric, fromUserId: mem.userId, fromName: mem.name, amount: give, unit: d.metric === "eggs" ? "eggs" : "kg" });
      remaining = round2(remaining - give);
      if (remaining <= 0) break;
    }
    if (remaining > 0) {
      suggestions.push({ metric: d.metric, fromUserId: null, fromName: "expand/purchase", amount: remaining, unit: d.metric === "eggs" ? "eggs" : "kg", note: "Expand stock, shift breeding, or purchase" });
    }
  }

  return { suggestions };
}

function buildCoalitionHerdAlerts(agg) {
  const alerts = [];
  const sd = agg.pooled.surplusDeficit || {};
  const deficitsCount = ["meatKg", "milkL", "eggs", "woolKg"].filter(k => (sd[k] || 0) < 0).length;

  if (deficitsCount) {
    alerts.push({
      level: "warning",
      code: "COALITION_DEFICIT",
      message: `${deficitsCount} coalition deficit metric(s) in next 4 weeks.`,
      actions: [{ label: "Open Coordination", topic: "animals.coalition.balance.open" }],
    });
  }

  if ((agg.fairness?.imbalanceIdx || 0) > 0.35) {
    alerts.push({
      level: "info",
      code: "FAIRNESS_IMBALANCE",
      message: "Contribution imbalance detected across members.",
      actions: [{ label: "Redistribute Tasks", topic: "animals.coalition.tasks.balance.open" }],
    });
  }

  if ((agg.pooled?.feed?.daysCoveredMin ?? 0) < 7) {
    alerts.push({
      level: "warning",
      code: "FEED_RISK",
      message: "Some member feed coverage < 7 days. Coordinate purchases?",
      actions: [{ label: "Group Feed Plan", topic: "inventory.group.feed.plan.open" }],
    });
  }

  return alerts;
}

/* -----------------------------------------------------------------------------
   Event-driven analytics bus (personal + coalition)
----------------------------------------------------------------------------- */
class AnimalAnalytics extends EventEmitter {
  constructor() {
    super();
    this._snapshot = storage.get("lastSnapshot", null);
    this._coalitions = storage.get("coalitions", {}); // { [id]: snapshot }
    this._hooked = false;
  }

  get snapshot() { return this._snapshot; }
  get coalitionSnaps() { return this._coalitions; }

  recompute() {
    const snap = computeHerdSnapshot({});
    this._snapshot = snap;
    storage.set("lastSnapshot", snap);
    this.emit("updated", snap);
    automation?.emitEvent?.("animals.analytics.updated", { snapshot: snap });
    try { this._maybeNBA(snap); } catch {}
    return snap;
  }

  async recomputeCoalition(coalitionId) {
    const snap = await computeCoalitionHerdSnapshot({ coalitionId });
    if (!snap) return null;
    this._coalitions[coalitionId] = snap;
    storage.set("coalitions", this._coalitions);
    this.emit("coalition.updated", { coalitionId, snapshot: snap });
    automation?.emitEvent?.("animals.coalition.analytics.updated", { coalitionId, snapshot: snap });
    try { this._maybeNBACoalition(snap); } catch {}
    return snap;
  }

  _maybeNBA(snap) {
    if (!automation?.emitEvent) return;

    if (snap.feed.shortfallDays > 0) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "feed-shortfall",
        message: `Feed shortfall in ${snap.feed.shortfallDays} day(s). Create a purchase or adjust ration?`,
        actions: [
          { label: "Plan Purchase", topic: "inventory.purchase.plan", payload: { category: "feed" } },
          { label: "Open Ration Tool", topic: "animals.ration.open" },
        ],
        ts: now(),
      });
    }

    const dueSoon = (snap.reproduction?.due || []).filter(x => (x.dueTs - now()) <= (7 * dayMs));
    if (dueSoon.length) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "due-soon",
        message: `${dueSoon.length} birth(s) expected within 7 days. Prepare a birthing kit and clean pen?`,
        actions: [
          { label: "Checklist", topic: "animals.birth.checklist.open" },
          { label: "Schedule Checks", topic: "calendar.create", payload: { type: "health-check", count: dueSoon.length } },
        ],
        ts: now(),
      });
    }

    const layRate = snap.poultry?.eggs?.layRate7 ?? 0;
    if ((snap.totals.hens || 0) > 0 && (layRate < 0.5 || !snap.feed.calciumOk)) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "eggs-low",
        message: "Eggs trending low or calcium missing. Add oyster shell and check lighting?",
        actions: [
          { label: "Add Oyster Shell", topic: "inventory.purchase.plan", payload: { category: "oyster" } },
          { label: "Log Egg Count", topic: "animals.eggs.log.open" },
        ],
        ts: now(),
      });
    }
  }

  _maybeNBACoalition(s) {
    if (!automation?.emitEvent) return;
    const sd = s.pooled?.surplusDeficit || {};
    const deficits = ["meatKg", "milkL", "eggs", "woolKg"].filter(k => (sd[k] || 0) < 0).length;

    if (deficits) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "animals-coalition-deficit",
        message: `Coalition has ${deficits} deficit metric(s). Coordinate trades or expand stock?`,
        actions: [
          { label: "Open Coordination", topic: "animals.coalition.balance.open", payload: { coalitionId: s.coalitionId } },
          { label: "Trade Board", topic: "animals.coalition.tradeboard.open", payload: { coalitionId: s.coalitionId } },
        ],
        ts: now(),
      });
    }
    if ((s.fairness?.imbalanceIdx || 0) > 0.35) {
      automation.emitEvent("nba", {
        topic: "nba",
        kind: "animals-coalition-fairness",
        message: "Contribution imbalance detected across members. Reassign tasks or targets?",
        actions: [{ label: "Reassign Plan", topic: "animals.coalition.tasks.balance.open", payload: { coalitionId: s.coalitionId } }],
        ts: now(),
      });
    }
  }

  hookEvents() {
    if (this._hooked) return;
    this._hooked = true;

    const topics = [
      "animals.updated",
      "animals.health.logged",
      "animals.weight.logged",
      "animals.breeding.logged",
      "butchering.logged",
      "inventory.updated",
      "eggs.collected",
      "mortality.logged",
    ];
    topics.forEach(t => automation?.onTopic?.(t, () => { try { this.recompute(); } catch {} }));

    // Coalition-related changes
    const coalitionTopics = [
      "coalition.membership.updated",
      "coalition.targets.updated",
      "coalition.demand.updated",
      "coalition.memberHerd.updated",
    ];
    coalitionTopics.forEach(t => automation?.onTopic?.(t, async (evt) => {
      const cid = evt?.payload?.coalitionId;
      if (cid) try { await this.recomputeCoalition(cid); } catch {}
    }));

    if (eventBus?.on) {
      [...topics, ...coalitionTopics].forEach(t => eventBus.on(t, async (payload) => {
        const cid = payload?.coalitionId ?? null;
        if (cid) await this.recomputeCoalition(cid);
        else this.recompute();
      }));
    }
  }
}

export const animalAnalytics = new AnimalAnalytics();

/* -----------------------------------------------------------------------------
   Automation integration: analytics templates + triggers
----------------------------------------------------------------------------- */
function registerAutomationTemplates() {
  if (!automation?.registerTemplate) return;

  automation.register([
    {
      id: "animals.daily-kpis",
      title: "Animals: Daily KPIs",
      description: "Compute and cache herd & flock KPIs; emit analytics.updated.",
      tags: ["animals", "analytics"],
      schedule: { at: "06:00" },
      timeoutMs: 10000,
      async run({ emit }) {
        const snap = animalAnalytics.recompute();
        emit?.("animals.analytics.daily", { snapshot: snap });
        return { ok: true, snapshot: snap };
      },
    },
    {
      id: "animals.weekly-forecast",
      title: "Animals: Weekly Feed Forecast",
      description: "Compute feed horizon forecast and raise NBA if shortfall.",
      tags: ["animals", "analytics", "forecast"],
      schedule: { days: [1], at: "07:00" }, // Mondays
      timeoutMs: 15000,
      async run({ emit }) {
        const animals = readAnimals(); const events = readEvents(); const inventory = readInventory();
        const prefs = readPrefs();
        const forecast = forecastFeed({ animals, events, inventory, prefs, horizonDays: 30 });
        const snap = animalAnalytics.snapshot || computeHerdSnapshot({});
        const combined = { ...snap, feed: forecast.summary };
        animalAnalytics._snapshot = combined;
        storage.set("lastSnapshot", combined);

        emit?.("animals.analytics.updated", { snapshot: combined });
        if (forecast.summary.shortfallDays > 0) {
          emit?.("nba", {
            topic: "nba",
            kind: "feed-shortfall",
            message: `Forecast shows a ${forecast.summary.shortfallDays}-day feed shortfall this month.`,
            actions: [{ label: "Plan Purchase", topic: "inventory.purchase.plan", payload: { category: "feed" } }],
            ts: now(),
          });
        }
        return { ok: true, forecast: forecast.summary };
      },
    },
    {
      id: "poultry.egg-summary",
      title: "Poultry: Egg Summary",
      description: "Summarize last 7/30 days egg counts and lay rate.",
      tags: ["animals", "analytics", "poultry"],
      schedule: { at: "18:00" },
      timeoutMs: 10000,
      async run({ emit }) {
        const animals = readAnimals();
        const events = readEvents();
        const poultry = animals.filter(isChicken);
        const eggs = analyzeEggProduction({ animals: poultry, events });
        emit?.("eggs.summary.updated", { eggs });
        return { ok: true, eggs };
      },
    },
    {
      id: "animals.coalition-daily-kpis",
      title: "Animals: Coalition KPIs",
      description: "Aggregate multi-herd analytics for coalition goals.",
      tags: ["animals", "analytics", "coalition"],
      schedule: { at: "06:20" },
      timeoutMs: 40000,
      async run({ emit }) {
        const coalitions = (readCoalitions().coalitions || []).concat(
          (readGroups().groups || []).filter(g => g.type === "coalition" || g.kind === "coalition")
        );
        for (const c of coalitions) {
          const snap = await animalAnalytics.recomputeCoalition(c.id);
          emit?.("animals.coalition.analytics.daily", { coalitionId: c.id, snapshot: snap });
        }
        return { ok: true, coalitions: coalitions.length };
      },
    },
  ]);

  // Triggers
  automation.registerTrigger(() => {
    const topics = [
      "animals.updated","animals.health.logged","animals.weight.logged","animals.breeding.logged",
      "butchering.logged","inventory.updated","eggs.collected","mortality.logged",
      "coalition.membership.updated","coalition.targets.updated","coalition.demand.updated","coalition.memberHerd.updated",
    ];
    const unsubs = topics.map(t => automation.onTopic?.(t, async (evt) => {
      const cid = evt?.payload?.coalitionId ?? null;
      if (cid) await animalAnalytics.recomputeCoalition(cid);
      else animalAnalytics.recompute();
    }));
    return () => unsubs.forEach(u => u?.());
  });
}

registerAutomationTemplates();
animalAnalytics.hookEvents();

/* -----------------------------------------------------------------------------
   Exports for consumers
----------------------------------------------------------------------------- */
export function getSnapshot() {
  return animalAnalytics.snapshot || animalAnalytics.recompute();
}
export function getDashboardCards() {
  return toDashboardCards(getSnapshot());
}
export function getGrazingPlan() {
  return suggestGrazingRotation({});
}
export async function getCoalitionSnapshot(coalitionId) {
  return animalAnalytics.coalitionSnaps?.[coalitionId] || await animalAnalytics.recomputeCoalition(coalitionId);
}
export function toCoalitionCards(coalitionSnap) {
  if (!coalitionSnap) return [];
  const sd = coalitionSnap.pooled?.surplusDeficit || {};
  const deficits = ["meatKg","milkL","eggs","woolKg"].filter(k => (sd[k] || 0) < 0).length;
  const imb = coalitionSnap.fairness?.imbalanceIdx || 0;

  return [
    {
      id: "coalition-balance",
      title: "Coalition · Balance",
      value: deficits ? `-${deficits} metric(s)` : "On Track",
      meta: "Meat/Milk/Eggs/Wool vs 4-week demand",
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
      id: "coalition-feed",
      title: "Coalition · Feed Risk",
      value: `${Math.max(0, coalitionSnap.pooled?.feed?.daysCoveredMin ?? 0)} days min`,
      meta: "Min days covered among members",
      intent: (coalitionSnap.pooled?.feed?.daysCoveredMin ?? 0) < 7 ? "warning" : "info",
    },
  ];
}

/* -----------------------------------------------------------------------------
   Export analytics (CSV/JSON)
----------------------------------------------------------------------------- */
export function exportAnalytics({ format = "json", coalitionId = null } = {}) {
  if (coalitionId) {
    const snap = animalAnalytics.coalitionSnaps?.[coalitionId];
    if (!snap) return null;
    if (format === "json") return safeJSON.stringify(snap);
    if (format === "csv") {
      const sd = snap.pooled?.surplusDeficit || {};
      const row = [
        ["ts", snap.ts],
        ["scope", snap.scope],
        ["coalitionId", snap.coalitionId],
        ["meatDeltaKg", sd.meatKg ?? 0],
        ["milkDeltaL", sd.milkL ?? 0],
        ["eggsDelta", sd.eggs ?? 0],
        ["woolDeltaKg", sd.woolKg ?? 0],
        ["imbalanceIdx", snap.fairness?.imbalanceIdx ?? 0],
        ["minDaysFeed", snap.pooled?.feed?.daysCoveredMin ?? 0],
      ];
      return row.map(r => r.join(",")).join("\n");
    }
    return null;
  }

  const snap = getSnapshot();
  if (format === "json") return safeJSON.stringify(snap);

  if (format === "csv") {
    const rows = [
      ["ts", snap.ts],
      ["herdSize", snap.totals.herdSize],
      ["flockSize", snap.totals.flockSize],
      ["females", snap.totals.females],
      ["males", snap.totals.males],
      ["young", snap.totals.young],
      ["hens", snap.totals.hens],
      ["roosters", snap.totals.roosters],
      ["dailyDMKg", snap.feed.herdDailyDMKg],
      ["daysCovered", snap.feed.daysCovered],
      ["shortfallDays", snap.feed.shortfallDays],
      ["incidentRate30d", snap.health.incidentRate30d],
      ["milk30dL", snap.production.milk.last30dL],
      ["meatKg", snap.production.meat.processedKg],
      ["woolKg", snap.production.wool.totalKg],
      ["eggs7d", snap.poultry?.eggs?.last7 ?? 0],
      ["layRate7", snap.poultry?.eggs?.layRate7 ?? 0],
      ["pressureScore", snap.utilization.score],
    ];
    return rows.map(r => r.join(",")).join("\n");
  }

  return null;
}

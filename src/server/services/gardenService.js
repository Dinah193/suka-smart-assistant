// C:\Users\larho\suka-smart-assistant\src\server\services\gardenService.js
//
// Suka Smart Assistant — Garden Service
//
// Purpose:
//   Provider-agnostic helpers for /api/garden routes, agents, and n8n flows.
//   Bridges Garden Plans ⇄ Planting Schedules ⇄ Harvest Logs ⇄ Inventory ⇄ Meals ⇄ Calendar.
//   Returns "visible drafts" for the UI to preview/edit before saving.
//
// Key Features integrated from project chats:
//   • Zone-aware sow/transplant/harvest windows (+ succession planting)
//   • Companion planting (layout & conflict detection)
//   • Irrigation & care task blueprint (simple, weather-agnostic stub)
//   • Harvest logging → Inventory sync → Meal suggestions from harvests
//   • Preservation suggestions (canning/dehydrating/freezing/fermentation)
//   • Calendar scheduling with Hebrew Day 7 (Sabbath) skip (default)
//   • n8n-friendly compact payloads
//
// Storage: Local JSON store (dev/offline). Optional bridges to calendarService,
//          inventoryService, and cookingService.
//
// Exports (summary):
//   - generateGardenPlan(input)                     -> visible draft plan (not yet persisted)
//   - buildPlantingSchedule(plan, opts)             -> tasks timeline (sow/transplant/harvest/etc.)
//   - suggestCompanions(crops)                      -> {good, avoid, matrix}
//   - estimateYields(plan)                          -> rough yield + preservation cues
//   - suggestMealsFromHarvest(harvests|plan)        -> recipes (via cookingService)
//   - getSoilAmendmentPlan(soil)                    -> DIY-first amendment suggestions
//   - buildIrrigationTasks(plan, opts)              -> recurring watering tasks
//   - savePlan(plan) / getPlan(id) / listPlans() / deletePlan(id)
//   - logHarvest(entry) / listHarvests() / harvestSummary()
//   - syncHarvestToInventory(harvestEntry, mode)    -> add to inventory (fresh/preserved)
//   - scheduleGardenOnCalendar(opts)                -> events[] (uses calendarService if present)
//   - buildN8nPayload(entity, opts)
//
// ------------------------------------------------------------------------------

import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

// ---- Lazy bridges (avoid circular deps) -------------------------------------
let calendarService = null;
let inventoryService = null;
let cookingService = null;

async function getCalendarService() {
  if (!calendarService) {
    const mod = await import("./calendarService.js").catch(() => null);
    calendarService = mod ? mod.default || mod : null;
  }
  return calendarService;
}
async function getInventoryService() {
  if (!inventoryService) {
    const mod = await import("./inventoryService.js").catch(() => null);
    inventoryService = mod ? mod.default || mod : null;
  }
  return inventoryService;
}
async function getCookingService() {
  if (!cookingService) {
    const mod = await import("./cookingService.js").catch(() => null);
    cookingService = mod ? mod.default || mod : null;
  }
  return cookingService;
}

// ---- Local JSON store -------------------------------------------------------
const DATA_DIR = path.resolve(process.cwd(), "data", "garden");
const FILES = {
  plans: path.join(DATA_DIR, "plans.json"),
  harvests: path.join(DATA_DIR, "harvests.json"),
};

async function ensureStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const f of Object.values(FILES)) {
    try { await fs.access(f); }
    catch { await fs.writeFile(f, JSON.stringify([], null, 2), "utf-8"); }
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

// ---- Utilities --------------------------------------------------------------
const uid = () => crypto.randomUUID();
const nowISO = () => new Date().toISOString();
const coalesce = (a, b) => (typeof a === "undefined" ? b : a);
const ISODate = (d) => new Date(d).toISOString().slice(0, 10);

function addDays(iso, days) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return ISODate(d);
}
function hebrewDayIsSabbathSkip(isoDate, opts) {
  // Placeholder: treat Saturday as Sabbath unless Hebrew day integration is wired here.
  const defaultSkip = coalesce(opts?.skipSabbath, true);
  const useSaturday = coalesce(opts?.sabbathIsSaturday, false);
  if (!defaultSkip) return false;
  const d = new Date(isoDate);
  const dow = d.getUTCDay(); // 6 = Saturday
  return useSaturday ? dow === 6 : dow === 6;
}

// ---- Crop knowledge (minimal starter; extend via data files later) ----------
/**
 * daysToMaturity: from transplant (t) or sow (s)
 * spacing: inches between plants (row) / between rows
 * season: cool|warm
 * companions.good / companions.avoid: arrays of crop keys
 * yieldPerSqft: rough lb/ft² at good fertility
 */
const CROPS = {
  tomato: {
    name: "Tomato",
    dtm: { t: 70, s: 100 },
    spacing: { inRow: 24, betweenRow: 36 },
    season: "warm",
    companions: { good: ["basil", "onion", "marigold"], avoid: ["fennel", "potato"] },
    yieldPerSqft: 1.2,
    preservation: ["Canning (pressure)", "Freezing", "Dehydrating"],
    tags: ["garden:tomato", "preserve:canning"],
  },
  pepper: {
    name: "Pepper",
    dtm: { t: 65, s: 95 },
    spacing: { inRow: 18, betweenRow: 24 },
    season: "warm",
    companions: { good: ["basil", "onion"], avoid: ["fennel"] },
    yieldPerSqft: 0.8,
    preservation: ["Freezing", "Pickling", "Dehydrating"],
    tags: ["garden:pepper", "preserve:freezing"],
  },
  onion: {
    name: "Onion",
    dtm: { t: 80, s: 110 },
    spacing: { inRow: 4, betweenRow: 12 },
    season: "cool",
    companions: { good: ["carrot", "beet"], avoid: ["pea", "bean"] },
    yieldPerSqft: 0.6,
    preservation: ["Curing", "Dehydrating"],
    tags: ["garden:onion", "preserve:curing"],
  },
  lettuce: {
    name: "Lettuce",
    dtm: { s: 45 },
    spacing: { inRow: 10, betweenRow: 12 },
    season: "cool",
    companions: { good: ["carrot", "radish", "onion"], avoid: [] },
    yieldPerSqft: 0.4,
    preservation: ["Refrigeration"],
    tags: ["garden:lettuce"],
  },
  basil: {
    name: "Basil",
    dtm: { s: 55 },
    spacing: { inRow: 12, betweenRow: 18 },
    season: "warm",
    companions: { good: ["tomato", "pepper"], avoid: [] },
    yieldPerSqft: 0.3,
    preservation: ["Dehydrating", "Freezing pesto"],
    tags: ["garden:basil", "preserve:dehydrating"],
  },
  cucumber: {
    name: "Cucumber",
    dtm: { s: 58 },
    spacing: { inRow: 12, betweenRow: 36 },
    season: "warm",
    companions: { good: ["dill", "bean"], avoid: ["potato"] },
    yieldPerSqft: 0.9,
    preservation: ["Pickling", "Refrigeration"],
    tags: ["garden:cucumber", "preserve:pickling"],
  },
  kale: {
    name: "Kale",
    dtm: { s: 55 },
    spacing: { inRow: 18, betweenRow: 24 },
    season: "cool",
    companions: { good: ["onion", "beet"], avoid: [] },
    yieldPerSqft: 0.5,
    preservation: ["Freezing", "Dehydrating"],
    tags: ["garden:kale", "preserve:freezing"],
  },
  carrot: {
    name: "Carrot",
    dtm: { s: 70 },
    spacing: { inRow: 3, betweenRow: 12 },
    season: "cool",
    companions: { good: ["onion", "lettuce"], avoid: ["dill"] },
    yieldPerSqft: 0.8,
    preservation: ["Cellaring", "Freezing (blanch)"],
    tags: ["garden:carrot", "preserve:cellar"],
  },
  // Add more as needed (spinach, beans, corn, squash, etc.)
};

// ---- Companion suggestions ---------------------------------------------------
export function suggestCompanions(cropKeys = []) {
  const good = new Set();
  const avoid = new Set();
  for (const key of cropKeys) {
    const c = CROPS[key];
    if (!c) continue;
    (c.companions.good || []).forEach((k) => good.add(k));
    (c.companions.avoid || []).forEach((k) => avoid.add(k));
  }

  // Build simple matrix
  const matrix = [];
  for (const a of cropKeys) {
    for (const b of cropKeys) {
      if (a === b) continue;
      const ca = CROPS[a], cb = CROPS[b];
      if (!ca || !cb) continue;
      const rel =
        (ca.companions.good || []).includes(b) ? "good" :
        (ca.companions.avoid || []).includes(b) ? "avoid" : "neutral";
      matrix.push({ a, b, rel });
    }
  }
  return { good: Array.from(good), avoid: Array.from(avoid), matrix };
}

// ---- Garden plan generation --------------------------------------------------
/**
 * generateGardenPlan
 * Minimal inputs → visible draft bed layout + crop placement + notes.
 */
export function generateGardenPlan(input) {
  const {
    homeName = "My Home",
    zone = "7b",                 // user’s USDA zone (approximate)
    startDate = new Date().toISOString().slice(0, 10),
    beds = [
      { id: "bed-1", sqft: 32, name: "Front Bed" },
      { id: "bed-2", sqft: 32, name: "Side Bed" },
    ],
    cropsWanted = ["tomato", "basil", "pepper", "onion", "lettuce", "cucumber"],
    rotationYear = 1,
    preferences = {
      successionWeeks: 2,        // re-sow every N weeks for cut-and-come again
      skipSabbath: true,         // default per project chats
      sabbathIsSaturday: false,  // Hebrew Day 7 ~ Saturday by default
      kitchenFirst: true,        // bias for crops used in current meal plans
      preservationFocus: true,   // bias toward crops that preserve well
    },
    notes = "",
  } = input || {};

  // Assign crops to beds with lightweight rotation logic
  const planBeds = beds.map((b, i) => {
    const picks = cropsWanted.filter((_, idx) => idx % beds.length === i);
    const slots = picks.map((k) => ({
      cropKey: k,
      cropName: CROPS[k]?.name || k,
      sqft: Math.max(6, Math.round(b.sqft / (picks.length || 1))),
      spacing: CROPS[k]?.spacing || null,
      season: CROPS[k]?.season || "warm",
      preservation: CROPS[k]?.preservation || [],
      tags: CROPS[k]?.tags || [],
    }));
    return { ...b, slots };
  });

  // Companion matrix & conflicts for UX highlights
  const companions = suggestCompanions(cropsWanted);

  const plan = {
    id: uid(),
    type: "GARDEN_PLAN",
    homeName,
    zone,
    startDate,
    rotationYear,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    preferences,
    notes,
    beds: planBeds,
    companions,
    // Computed summaries
    estimates: estimateYields({ beds: planBeds }),
  };

  return plan; // visible draft for UI
}

// ---- Planting schedule (zone-ish heuristic) ---------------------------------
export function buildPlantingSchedule(plan, opts = {}) {
  const {
    startDate = plan?.startDate || new Date().toISOString().slice(0, 10),
    skipSabbath = coalesce(plan?.preferences?.skipSabbath, true),
    sabbathIsSaturday = coalesce(plan?.preferences?.sabbathIsSaturday, false),
    successionWeeks = coalesce(plan?.preferences?.successionWeeks, 2),
  } = opts;

  const tasks = [];

  (plan?.beds || []).forEach((bed) => {
    (bed.slots || []).forEach((slot) => {
      const crop = CROPS[slot.cropKey] || {};
      const isCool = crop.season === "cool";
      const sowDate = ISODate(startDate);
      const transplantDate = crop.dtm?.t ? addDays(sowDate, Math.max(28, Math.round(crop.dtm.t * 0.3))) : null;
      const harvestStart = crop.dtm?.t ? addDays(transplantDate || sowDate, crop.dtm.t) :
                          crop.dtm?.s ? addDays(sowDate, crop.dtm.s) : addDays(sowDate, 60);
      const harvestEnd = addDays(harvestStart, 21);

      // base tasks
      tasks.push({
        type: "SOW",
        date: sowDate,
        bedId: bed.id,
        bedName: bed.name,
        cropKey: slot.cropKey,
        cropName: slot.cropName,
        details: isCool ? "Cool-season sowing window" : "Warm-season sowing window",
      });
      if (transplantDate) {
        tasks.push({
          type: "TRANSPLANT",
          date: transplantDate,
          bedId: bed.id,
          bedName: bed.name,
          cropKey: slot.cropKey,
          cropName: slot.cropName,
          details: "Harden off 5–7 days prior; plant at dusk if hot.",
        });
      }
      tasks.push({
        type: "HARVEST_START",
        date: harvestStart,
        bedId: bed.id,
        bedName: bed.name,
        cropKey: slot.cropKey,
        cropName: slot.cropName,
        details: "Begin picking at market maturity; encourage continued production.",
      });
      tasks.push({
        type: "HARVEST_END",
        date: harvestEnd,
        bedId: bed.id,
        bedName: bed.name,
        cropKey: slot.cropKey,
        cropName: slot.cropName,
        details: "Last expected harvest window for first succession.",
      });

      // successions
      for (let w = successionWeeks; w <= successionWeeks * 4; w += successionWeeks) {
        const sd = addDays(sowDate, w * 7);
        tasks.push({
          type: "SOW",
          date: sd,
          bedId: bed.id,
          bedName: bed.name,
          cropKey: slot.cropKey,
          cropName: slot.cropName,
          details: `Succession sowing (+${w}w)`,
        });
      }
    });
  });

  // Sabbath skip for first occurrences (UI can show badge)
  const filtered = tasks.filter((t) =>
    !hebrewDayIsSabbathSkip(t.date, { skipSabbath, sabbathIsSaturday })
  );

  return {
    planId: plan?.id,
    generatedAt: nowISO(),
    tasks: filtered.sort((a, b) => a.date.localeCompare(b.date)),
    config: { startDate, skipSabbath, sabbathIsSaturday, successionWeeks },
  };
}

// ---- Yield estimate & preservation cues -------------------------------------
export function estimateYields(planLike) {
  let sqft = 0;
  let estLb = 0;
  const byCrop = {};

  (planLike?.beds || []).forEach((bed) => {
    (bed.slots || []).forEach((slot) => {
      const crop = CROPS[slot.cropKey];
      const area = slot.sqft || Math.max(4, Math.round((bed.sqft || 16) / (bed.slots?.length || 1)));
      sqft += area;
      const y = (crop?.yieldPerSqft || 0.5) * area;
      estLb += y;
      byCrop[slot.cropKey] = (byCrop[slot.cropKey] || 0) + y;
    });
  });

  const preservation = Object.entries(byCrop).map(([key, pounds]) => ({
    cropKey: key,
    cropName: CROPS[key]?.name || key,
    pounds: Math.round(pounds * 10) / 10,
    suggested: CROPS[key]?.preservation || [],
  }));

  return { sqftTotal: sqft, estLbTotal: Math.round(estLb * 10) / 10, byCrop, preservation };
}

// ---- Soil amendment plan (DIY first) ----------------------------------------
export function getSoilAmendmentPlan(soil = {}) {
  // soil: { pH, N, P, K, organicMatterPct, texture }
  const out = [];
  if (soil.pH && soil.pH < 6.2) out.push("Add garden lime (split doses over 4–6 weeks).");
  if (soil.pH && soil.pH > 7.2) out.push("Add elemental sulfur (split, re-test in 6–8 weeks).");
  if (soil.organicMatterPct && soil.organicMatterPct < 4) out.push("Topdress 1–2\" finished compost; mulch 2–3\".");
  if (soil.N === "low") out.push("Blood meal or feather meal as N source (follow label).");
  if (soil.P === "low") out.push("Rock phosphate or bone meal pre-plant; mix into root zone.");
  if (soil.K === "low") out.push("Kelp meal/greensand for K + micros.");
  if (!out.length) out.push("Maintain with compost, leaf mold, and living mulches.");
  return { recommendations: out, diyMixes: [
    "Compost tea (aerated) monthly during active growth.",
    "Fermented plant juice (FPJ) from nettle/comfrey as foliar (dilute).",
  ]};
}

// ---- Irrigation blueprint ----------------------------------------------------
export function buildIrrigationTasks(plan, opts = {}) {
  const {
    startDate = plan?.startDate || ISODate(new Date()),
    frequencyDays = 2, // adjust by season manually in UI; weather-aware later
    durationMinutes = 20,
    cycles = 20,
    skipSabbath = coalesce(plan?.preferences?.skipSabbath, true),
    sabbathIsSaturday = coalesce(plan?.preferences?.sabbathIsSaturday, false),
  } = opts;

  const tasks = [];
  let d = startDate;
  for (let i = 0; i < cycles; i++) {
    if (!hebrewDayIsSabbathSkip(d, { skipSabbath, sabbathIsSaturday })) {
      tasks.push({
        type: "IRRIGATION",
        date: d,
        durationMinutes,
        details: `Water deeply; adjust for rainfall.`,
      });
    }
    d = addDays(d, frequencyDays);
  }

  return {
    planId: plan?.id,
    generatedAt: nowISO(),
    tasks,
    config: { startDate, frequencyDays, durationMinutes, cycles, skipSabbath, sabbathIsSaturday },
  };
}

// ---- Persistence (plans) ----------------------------------------------------
export async function savePlan(plan) {
  const all = await readJson(FILES.plans);
  const id = plan.id || uid();
  const payload = { ...plan, id, updatedAt: nowISO() };
  const idx = all.findIndex((p) => p.id === id);
  if (idx >= 0) all[idx] = payload;
  else all.push(payload);
  await writeJson(FILES.plans, all);
  return payload;
}
export async function getPlan(id) {
  const all = await readJson(FILES.plans);
  return all.find((p) => p.id === id) || null;
}
export async function listPlans() {
  const all = await readJson(FILES.plans);
  return all.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}
export async function deletePlan(id) {
  const all = await readJson(FILES.plans);
  await writeJson(FILES.plans, all.filter((p) => p.id !== id));
}

// ---- Harvest logging & inventory sync ---------------------------------------
export async function logHarvest(entry) {
  const {
    planId = null,
    date = ISODate(new Date()),
    cropKey,
    cropName = CROPS[cropKey]?.name || cropKey,
    qty = 1,
    unit = "lb", // lb | oz | bunch | count | kg
    bedId = null,
    notes = "",
  } = entry || {};

  const rec = {
    id: uid(),
    planId,
    date: ISODate(date),
    cropKey,
    cropName,
    qty: Number(qty) || 0,
    unit,
    bedId,
    notes,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  };

  const all = await readJson(FILES.harvests);
  all.push(rec);
  await writeJson(FILES.harvests, all);
  return rec;
}
export async function listHarvests() {
  const all = await readJson(FILES.harvests);
  return all.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
export async function harvestSummary(startDate = null, endDate = null) {
  const all = await listHarvests();
  const within = all.filter((h) => {
    const okStart = !startDate || h.date >= startDate;
    const okEnd = !endDate || h.date <= endDate;
    return okStart && okEnd;
  });
  const map = new Map();
  for (const h of within) {
    const key = `${h.cropKey}::${h.unit}`;
    const prev = map.get(key) || { cropKey: h.cropKey, cropName: h.cropName, unit: h.unit, qty: 0 };
    prev.qty += Number(h.qty) || 0;
    map.set(key, prev);
  }
  return Array.from(map.values());
}

export async function syncHarvestToInventory(harvestEntry, mode = "fresh") {
  const inv = await getInventoryService();
  if (!inv) return { status: "noop", reason: "inventoryService not available" };

  const name = harvestEntry.cropName || harvestEntry.cropKey;
  const line = {
    name,
    qty: Number(harvestEntry.qty) || 0,
    unit: harvestEntry.unit || "lb",
    location: mode === "fresh" ? "Root Cellar/Fridge" : "Pantry/Freezer",
    meta: {
      planId: harvestEntry.planId,
      harvestId: harvestEntry.id,
      date: harvestEntry.date,
      mode,
    },
  };

  if (inv.addProducedBulk) {
    return inv.addProducedBulk([line], { source: "gardenService" });
  }
  if (inv.addItem) {
    return inv.addItem(line);
  }
  return { status: "noop", reason: "inventoryService lacks add methods" };
}

// ---- Meal suggestions from harvest ------------------------------------------
export async function suggestMealsFromHarvest(input) {
  // input: harvest array OR plan (use plan estimates.byCrop)
  const cook = await getCookingService();
  if (!cook?.listRecipes) return [];

  const names = [];
  if (Array.isArray(input)) {
    for (const h of input) names.push(h.cropName || h.cropKey);
  } else if (input?.estimates?.byCrop) {
    for (const key of Object.keys(input.estimates.byCrop)) names.push(CROPS[key]?.name || key);
  }

  // Simple search by crop name in recipe title/tags
  const out = [];
  const recipes = await cook.listRecipes();
  for (const r of recipes) {
    const hay = `${r.title} ${r.tags.join(" ")}`.toLowerCase();
    if (names.some((n) => hay.includes((n || "").toLowerCase()))) {
      out.push({ id: r.id, title: r.title, tags: r.tags, nutrition: r.nutrition });
    }
  }
  // De-duplicate & top 10
  const uniq = [];
  const seen = new Set();
  for (const x of out) {
    if (seen.has(x.id)) continue;
    seen.add(x.id);
    uniq.push(x);
  }
  return uniq.slice(0, 10);
}

// ---- Calendar scheduling (Sabbath-aware) ------------------------------------
export async function scheduleGardenOnCalendar(opts) {
  const {
    planId,
    provider = "local",
    calendarId = "primary",
    timezone = "America/New_York",
    includeIrrigation = true,
    includeCare = true,
    skipSabbath = true,
    sabbathIsSaturday = false,
    eventTitlePrefix = "Garden •",
  } = opts || {};

  const plan = await getPlan(planId);
  if (!plan) throw new Error("Garden plan not found");

  const schedule = buildPlantingSchedule(plan, { skipSabbath, sabbathIsSaturday });
  const irrigation = includeIrrigation ? buildIrrigationTasks(plan, { skipSabbath, sabbathIsSaturday }) : { tasks: [] };

  const events = [];
  for (const t of schedule.tasks) {
    const title = `${eventTitlePrefix} ${t.type} • ${t.cropName}`;
    events.push({
      title,
      description: `Bed: ${t.bedName} • ${t.details || ""}`,
      start: t.date,
      durationMinutes: t.type === "TRANSPLANT" ? 60 : 30,
      timezone,
      recurrence: null,
      meta: { planId: plan.id, type: t.type, cropKey: t.cropKey, bedId: t.bedId },
    });
  }
  if (includeCare) {
    // Add light recurring care (weeding/feeding) every 14 days for 4 cycles
    let d = plan.startDate;
    for (let i = 0; i < 4; i++) {
      if (!hebrewDayIsSabbathSkip(d, { skipSabbath, sabbathIsSaturday })) {
        events.push({
          title: `${eventTitlePrefix} Care • Weed & Feed`,
          description: `Light weeding, check pests, compost tea/FPJ if needed.`,
          start: d,
          durationMinutes: 40,
          timezone,
          recurrence: null,
          meta: { planId: plan.id, type: "CARE" },
        });
      }
      d = addDays(d, 14);
    }
  }
  for (const i of irrigation.tasks) {
    events.push({
      title: `${eventTitlePrefix} Irrigation`,
      description: i.details,
      start: i.date,
      durationMinutes: i.durationMinutes,
      timezone,
      recurrence: null,
      meta: { planId: plan.id, type: "IRRIGATION" },
    });
  }

  const cal = await getCalendarService();
  if (!cal?.createEventsBatch) return events; // visible preview for UI

  return cal.createEventsBatch({ provider, calendarId, events });
}

// ---- n8n payloads -----------------------------------------------------------
export function buildN8nPayload(entity, opts = {}) {
  const base = {
    id: entity?.id,
    type: entity?.type,
    homeName: entity?.homeName,
    createdAt: entity?.createdAt,
    updatedAt: entity?.updatedAt,
  };

  if (entity?.type === "GARDEN_PLAN") {
    return {
      ...base,
      zone: entity.zone,
      startDate: entity.startDate,
      rotationYear: entity.rotationYear,
      beds: entity.beds,
      companions: entity.companions,
      estimates: entity.estimates,
      preferences: entity.preferences,
      options: opts,
    };
  }

  // Harvest entry passthrough
  if (entity?.harvestId || entity?.cropKey) {
    return { ...base, harvest: entity, options: opts };
  }

  return { ...base, options: opts };
}

// ---- Default export ---------------------------------------------------------
const GardenService = {
  // Generation & schedules
  generateGardenPlan,
  buildPlantingSchedule,
  suggestCompanions,
  estimateYields,
  getSoilAmendmentPlan,
  buildIrrigationTasks,

  // Persistence
  savePlan,
  getPlan,
  listPlans,
  deletePlan,

  // Harvests & inventory
  logHarvest,
  listHarvests,
  harvestSummary,
  syncHarvestToInventory,

  // Meals
  suggestMealsFromHarvest,

  // Calendar
  scheduleGardenOnCalendar,

  // n8n
  buildN8nPayload,
};

export default GardenService;

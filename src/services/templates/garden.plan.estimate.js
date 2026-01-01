// src/services/templates/garden.plan.estimate.js
import spec from "@/ai/templates/garden.plan.estimate.suka.json";
import { automation } from "@/services/automation/runtime";

// Optional/guarded modules so this can run in thin environments
let WeatherSvc, InventoryStore, CalendarSyncModule, SettingsStore;
try { WeatherSvc = require("@/services/weather/WeatherSvc").default; } catch (_) {}
try { InventoryStore = require("@/store/InventoryStore"); } catch (_) {}
try { CalendarSyncModule = require("@/services/calendar/CalendarSyncModule").default; } catch (_) {}
try { SettingsStore = require("@/store/SettingsStore"); } catch (_) {}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const round = (n, d = 1) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

function isoDate(dLike) {
  const d = dLike instanceof Date ? dLike : new Date(dLike || Date.now());
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDays(dLike, days) {
  const d = dLike instanceof Date ? new Date(dLike) : new Date(dLike || Date.now());
  d.setDate(d.getDate() + days);
  return d;
}
function addWeeks(dLike, w) { return addDays(dLike, w * 7); }
function daysBetween(a, b) {
  const MS = 86400000;
  const d1 = a instanceof Date ? a : new Date(a);
  const d2 = b instanceof Date ? b : new Date(b);
  return Math.round((d2 - d1) / MS);
}

const SOIL_HINT = {
  clay: "Add 2–3 cm compost + 0.5–1 kg/m² gypsum; avoid compaction; mulch well.",
  sand: "Add 2–3 cm compost + 0.4 kg/m² biochar pre-charged; mulch to conserve moisture.",
  loam: 'Top-dress 2–3 cm compost; maintain 1–2 kg/m² yearly; keep living mulch if possible.',
  default: 'Top-dress 2–3 cm compost; avoid working soil when wet.'
};

const IRRIG_METHOD_HINT = {
  drip: "Deep, infrequent sessions at pre-dawn; verify emitters 20–30 cm spacing for veg beds.",
  soaker: "Run 25–45 min depending on soil; check uniform darkening; mulch to reduce evap.",
  sprinkler: "Use early morning; aim for 12–18 mm application; avoid leaf wetness late day."
};

function compostHint(soilType) {
  const key = String(soilType || "default").toLowerCase();
  return SOIL_HINT[key] || SOIL_HINT.default;
}

function pickIrrigMethod(input) {
  const m = (input?.irrigation?.method || input?.waterAccess || "").toLowerCase();
  if (m.includes("drip")) return { method: "drip", hint: IRRIG_METHOD_HINT.drip };
  if (m.includes("soaker")) return { method: "soaker", hint: IRRIG_METHOD_HINT.soaker };
  if (m.includes("sprinkler")) return { method: "sprinkler", hint: IRRIG_METHOD_HINT.sprinkler };
  return { method: "hose", hint: "Water early morning; aim for deep soak to 15–20 cm." };
}

function firstSafePlanting({ today, climate = {}, weather = {} }) {
  const now = today ? new Date(today) : new Date();
  const lastFrost = climate?.lastFrost ? new Date(climate.lastFrost) : null;
  // If we have a forecast, nudge planting if sub-freezing nights are predicted within 5 days
  const riskyNight = Array.isArray(weather?.daily)
    ? weather.daily.slice(0, 5).some(d => (d.tMinC ?? 99) <= -1)
    : false;

  const base = lastFrost ? addDays(lastFrost, 7) : now;
  const start = riskyNight ? addDays(base, 3) : base;
  return isoDate(start);
}

function phaseDates(seedDateISO, crop) {
  // Succession-friendly defaults; can be overridden per crop
  const seed = new Date(seedDateISO);
  const daysToMaturity = Number(crop?.daysToMaturity || 60);
  const stake = addDays(seed, 7);
  const firstHarvest = addDays(seed, Math.max(28, Math.round(daysToMaturity * 0.7)));
  const fullHarvest = addDays(seed, daysToMaturity);
  const succession = addWeeks(seed, crop?.successionWeeks ?? 3);
  return {
    plantISO: isoDate(seed),
    stakeISO: isoDate(stake),
    firstHarvestISO: isoDate(firstHarvest),
    fullHarvestISO: isoDate(fullHarvest),
    successionISO: isoDate(succession)
  };
}

function qtyForHousehold(crop, householdSize = 4, diet = {}) {
  // scale by household & diet preferences (more tomatoes for vegetarian, etc.)
  const hh = clamp(householdSize, 1, 12);
  const base = crop?.baseQty ?? 4;
  let scale = 1.0;
  if (diet?.vegetarian) scale += 0.3;
  if (diet?.vegan) scale += 0.4;
  if (/herb/i.test(crop?.name || "")) scale += 0.2;
  return Math.max(crop?.minQty ?? 1, Math.round(base * hh / 4 * scale));
}

function ensureInventory(items = []) {
  // Look up current stock and return purchase suggestions
  const have = (InventoryStore?.getAll?.() || []).reduce((acc, it) => {
    acc[String(it.name || "").toLowerCase()] = it.qty ?? it.quantity ?? 0;
    return acc;
  }, {});
  return items
    .map((it) => {
      const key = String(it.sku || it.name || "").toLowerCase();
      const want = Number(it.qty ?? it.quantity ?? 0);
      const onHand = Number(have[key] || 0);
      const need = Math.max(0, round(want - onHand, 2));
      return need > 0 ? { ...it, need } : null;
    })
    .filter(Boolean);
}

function scheduleItemsToEvents(items = [], color = "#34d399") {
  return items.map((s) => ({
    title: `Garden • ${s.title}`,
    date: s.date,
    color,
    source: "garden"
  }));
}

function dietCaps(diet) {
  // Quick guardrails for suggestions
  return {
    allowNightshade: !(diet?.nightshadeFree),
    allowBrassica: !(diet?.lowOxalate),
  };
}

/**
 * Main rule engine
 */
function ruleEngine(input = {}, defaults = {}) {
  const today = input.today ? new Date(input.today) : new Date();

  // Pull a minimal forecast if available (non-fatal)
  let forecast = null;
  try { forecast = WeatherSvc?.getDaily?.({ days: 10 }); } catch (_) {}

  const plantingISO = firstSafePlanting({ today, climate: input.climate, weather: forecast });
  const irrig = pickIrrigMethod(input);

  // Household + diet scaling
  const hh = clamp(input.householdSize ?? input.household?.size ?? 4, 1, 12);
  const diet = input.diet || SettingsStore?.get?.("diet_profile") || {};
  const caps = dietCaps(diet);

  // Crop palette (can be extended by spec or input)
  const palette = (input.crops && input.crops.length ? input.crops : [
    { name: "Tomatoes", baseQty: 4, minQty: 2, daysToMaturity: 65, successionWeeks: 4 },
    { name: "Basil", baseQty: 6, minQty: 4, daysToMaturity: 40, successionWeeks: 3 },
    { name: "Parsley", baseQty: 4, minQty: 2, daysToMaturity: 70, successionWeeks: 5 },
    { name: "Lettuce", baseQty: 8, minQty: 4, daysToMaturity: 35, successionWeeks: 2 },
  ]).filter(c => {
    if (!caps.allowNightshade && /tomato|pepper|eggplant/i.test(c.name)) return false;
    if (!caps.allowBrassica && /kale|cabbage|broccoli|brussels/i.test(c.name)) return false;
    return true;
  });

  // Beds (fallback if none supplied)
  const bedsIn = Array.isArray(input.beds) && input.beds.length ? input.beds : [
    { name: "North Bed", areaSqft: 100, id: "bed_north", soilType: input.soilType || "loam" },
    { name: "Herb Strip", areaSqft: 30, id: "bed_herb", soilType: input.soilType || "loam" }
  ];

  // Allocate simple planting suggestions per bed
  const beds = bedsIn.map((b, i) => {
    const suggested = [];
    // heuristic: leafy/herbs in smaller/herb bed; fruiting in larger
    const picks = i === 0 ? palette.filter(p => !/parsley/i.test(p.name)).slice(0, 2)
                          : palette.filter(p => /basil|parsley|lettuce/i.test(p.name)).slice(0, 2);

    for (const crop of picks) {
      const qty = qtyForHousehold(crop, hh, diet);
      const phases = phaseDates(plantingISO, crop);
      suggested.push({
        name: crop.name,
        qty,
        phases
      });
    }
    return {
      name: b.name,
      id: b.id || `bed_${i}`,
      areaSqft: b.areaSqft ?? 40,
      soilType: b.soilType || input.soilType || "loam",
      crops: suggested
    };
  });

  // Compost & soil
  const compost = compostHint(input.soilType);

  // Scheduling ladder (plant → stake/support → first harvest → succession)
  const schedule = [];
  for (const bed of beds) {
    for (const c of bed.crops) {
      schedule.push({ date: c.phases.plantISO, title: `Plant ${c.name} — ${bed.name}`, kind: "plant" });
      if (/tomato|pepper|eggplant/i.test(c.name)) {
        schedule.push({ date: c.phases.stakeISO, title: `Stake/Support ${c.name} — ${bed.name}`, kind: "care" });
      }
      schedule.push({ date: c.phases.firstHarvestISO, title: `First harvest — ${c.name}`, kind: "harvest" });
      schedule.push({ date: c.phases.successionISO, title: `Succession sowing — ${c.name}`, kind: "plant" });
    }
  }

  // Drought/heat awareness from forecast
  const hotSoon = Array.isArray(forecast?.daily)
    ? forecast.daily.slice(0, 3).some(d => (d.tMaxC ?? 0) >= 33)
    : false;
  const waterNote = hotSoon
    ? "Heat on the way: bias pre-dawn deep watering the day before the hottest spell."
    : "Keep top 5–8 cm mulched; water deeply 2–3×/wk depending on soil.";

  // Minimal supply plan
  const supplies = [
    { sku: "compost-bulk", name: "Compost (bulk)", qty: round((beds.reduce((s, b) => s + (b.areaSqft || 0), 0) / 10) * 7.5, 1), unit: "kg" },
    { sku: "mulch-straw", name: "Mulch (straw/leaves)", qty: round((beds.length) * 1.5, 1), unit: "bales" },
    /drip|soaker/.test(irrig.method) ? { sku: "drip-emitter-pack", name: "Drip emitter pack", qty: beds.length, unit: "pk" } : null
  ].filter(Boolean);

  const toOrder = ensureInventory(supplies);

  const plan = {
    beds,
    irrigation: { method: irrig.method, hint: irrig.hint, note: waterNote },
    compost,
    supplies,
    toOrder,
    meta: {
      ...input,
      plantingISO,
      generatedISO: isoDate(today),
      householdSize: hh,
      dietProfile: diet
    }
  };

  // Calendar + actions for your orchestrator (visible draft, then apply)
  const events = scheduleItemsToEvents(schedule, "#34d399");
  const actions = [
    {
      type: "OPEN_UI",
      route: "/tier2/garden/plan-draft",
      component: "GardenPlanDraft",
      params: {
        plan,
        schedule,
        draft: true
      }
    },
    {
      type: "PATCH_PLAN",
      plan: { schedule, beds, compost, irrigation: plan.irrigation },
      draft: true
    }
  ];

  // Optional soft calendar sync (non-fatal)
  try { CalendarSyncModule?.load?.(events); } catch (_) {}

  const summary = `Planned ${beds.reduce((s, b) => s + b.crops.length, 0)} crop entries across ${beds.length} bed(s); first planting ${plan.meta.plantingISO}.`;

  return { ok: true, plan, schedule, events, actions, summary };
}

export default {
  id: spec.id,
  description: spec.description,
  version: "2.1.0",
  /**
   * Run the planner. Uses rule engine by default but remains compatible with your spec’s llm gates.
   */
  async run(input) {
    const out = ruleEngine(input || {}, spec.defaults || {});
    // Emit on automation bus (observability)
    automation.emit?.("event", { type: "garden/plan_estimated", payload: out });

    // Gentle inbox heads-up (non-fatal)
    try {
      automation.emit?.("notify", {
        title: "Garden plan draft ready",
        message: out.summary,
        tags: ["garden", "draft"]
      });
    } catch (_) {}

    return out;
  }
};

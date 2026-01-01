// C:\Users\larho\suka-smart-assistant\src\services\templates\garden\HouseholdPlanGenerator.template.js
/**
 * Household Plan Generator — dynamic v2.4
 * - Computes plan ONLY for crops provided in inputs.crops
 * - Defaults to lbs; supports kg via settings.units
 * - NEW: zone timing (optional), seed inventory checks, procurement nudges,
 *        meal-plan demand coverage, nutrition/cost rollups (if provided),
 *        calendar anchors, and clearer totals.
 */
import dayjs from "dayjs";

const isoNow = () => new Date().toISOString();
const safe = (n, fb = 0) => (Number.isFinite(Number(n)) ? Number(n) : fb);
const title = (s) => (s || "").replace(/\b\w/g, (m) => m.toUpperCase());
const KG2LB = 2.20462262185;

const GENERIC_SPACING_CM = { inRow: 30, betweenRow: 40 };
const GENERIC_YIELD = { perM2_kg: 2.5, perPlant_kg: null };
const GENERIC_STORAGE = { fresh: 30, freeze: 40, can: 30 };
const DEFAULT_GERMINATION_PCT = 85; // used if packet doesn't give one

function parseNotes(notes = "") {
  // Optional inline varieties: "varieties: Tomato=Sungold, Cucumber=Marketmore"
  const out = { varieties: {} };
  const m = notes.match(/variet(?:y|ies)\s*:\s*([^]+)$/i);
  if (!m) return out;
  m[1].split(",").forEach((seg) => {
    const s = seg.trim();
    if (!s) return;
    const [crop, variety] = s.split(/\s*=\s*/);
    if (variety) (out.varieties[crop.trim()] ||= []).push(variety.trim());
  });
  return out;
}

/* ----------------------------------------------------------------------------
   Catalog-aware helpers
---------------------------------------------------------------------------- */
function spacingFor(cropName, catalog = {}) {
  const key = (cropName || "").toLowerCase();
  const s = catalog[key]?.spacingCm;
  return s && Number.isFinite(s.inRow) && Number.isFinite(s.betweenRow)
    ? s
    : GENERIC_SPACING_CM;
}

function plantsFromAreaM2(cropName, areaM2, catalog = {}) {
  const sp = spacingFor(cropName, catalog);
  const cm2 = sp.inRow * sp.betweenRow;
  return Math.max(1, Math.floor((areaM2 * 10_000) / cm2));
}

function yieldKg(cropName, { plants, areaM2 }, catalog = {}) {
  const key = (cropName || "").toLowerCase();
  const y = catalog[key]?.yield || {};
  const perPlant = Number.isFinite(y.perPlant_kg) ? y.perPlant_kg : GENERIC_YIELD.perPlant_kg;
  const perM2 = Number.isFinite(y.perM2_kg) ? y.perM2_kg : GENERIC_YIELD.perM2_kg;

  if (Number.isFinite(perPlant) && plants) return plants * perPlant;
  return (areaM2 || 0) * perM2;
}

function toUnits(kg, units) {
  return units === "lb" ? kg * KG2LB : kg;
}

function storageSplit(cropName, totalKg, catalog = {}, visionFocus = []) {
  const key = (cropName || "").toLowerCase();
  const base = catalog[key]?.storagePct || GENERIC_STORAGE; // {fresh,freeze,can,...}
  const out = {};
  for (const [k, p] of Object.entries(base)) out[k] = +(totalKg * (p / 100)).toFixed(3);

  // nudge 10% toward focus buckets if present
  const f = (visionFocus || []).map((s) => s.toLowerCase().replace("drying", "dry"));
  if (f.length) {
    const give = 0.10 * totalKg;
    for (const bucket of f) {
      if (out[bucket] == null) continue;
      const others = Object.keys(out).filter((k) => k !== bucket);
      const takeEach = others.length ? give / others.length : 0;
      for (const o of others) out[o] = Math.max(0, out[o] - takeEach);
      out[bucket] += give;
    }
  }
  return out;
}

function computeDemandLb({ householdVision = {}, mealPlan = [] }) {
  const base = safe(householdVision.yearlyProduceLbTarget, 0);
  const ae = safe(householdVision.adultEquivalents, 0);
  const annualTargetLb = base || (ae ? 550 * ae : 0); // heuristic

  const mealDemand = {};
  for (const item of mealPlan) {
    const servings = safe(item.servings, 0);
    const ps = item.perServing || {};
    for (const key of Object.keys(ps)) {
      const m = key.match(/^(.+?)_(lb|kg)$/i);
      if (!m) continue;
      const crop = m[1];
      const unit = m[2].toLowerCase();
      const qtyPerServing = Number(ps[key]) || 0;
      const lb = unit === "lb" ? qtyPerServing : qtyPerServing * KG2LB;
      mealDemand[crop] = safe(mealDemand[crop], 0) + lb * servings;
    }
  }
  return { annualTargetLb, mealDemandLb: mealDemand };
}

/* ----------------------------------------------------------------------------
   Public template config
---------------------------------------------------------------------------- */
export const DEFAULT_HOUSEHOLD_PLAN_CONFIG = {
  id: "household-plan-generator",
  name: "Household Plan Generator",
  purpose:
    "Compute a user-selected crop plan (lbs/kg) with seeds, geometry, yields, storage, timing anchors, and inventory nudges.",
  schedule: { manual: { RRULE: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0" } },
  settings: {
    units: "lb", // 'lb' | 'kg'
    seedOveragePct: 10,
    defaultBedWidthM: 1.2,
    openUIRoute: "/tier2/garden/plan",
    // NEW optional timing + economics defaults:
    zone: null,
    year: dayjs().year(),
    // If the catalog provides nutrition/cost, we’ll include aggregates:
    // cropCatalog['tomato'] = { nutrition:{kcal_per_kg:180}, economics:{cost_per_packet:3.5, seeds_per_packet:30} }
  },
  inputsSchema: {
    notes: "string",
    beds: [/* { bedId, lengthM, widthM, areaM2? } */],
    crops: [/* { name, areaSqft?, areaM2?, plants?, bedId? } */],
    cropCatalog: {/* 'tomato': { spacingCm, yield, storagePct, nutrition?, economics? } */},
    seedPackets: {/* Tomato:{seedsPerPacket:25, germinationPct?:90} */},
    seedsOnHand: {/* Tomato:{seeds:number} */},
    household: { size: 4, dailyUseLb: 3.0 },
    householdVision: { selfReliancePct: 60, focus: ["fresh","canning","freezing"], adultEquivalents: 3, yearlyProduceLbTarget: null },
    mealPlan: [/* optional demand */]
  }
};

export function createHouseholdPlanTemplate(config = {}) {
  const meta = {
    ...DEFAULT_HOUSEHOLD_PLAN_CONFIG,
    ...config,
    settings: { ...DEFAULT_HOUSEHOLD_PLAN_CONFIG.settings, ...(config.settings || {}) }
  };

  function nextRuns(now = dayjs()) {
    return [now.add(1, "day").hour(9).minute(0).second(0).millisecond(0).toISOString()];
  }

  async function run(ctx = {}, services = {}) {
    const start = isoNow();
    const logs = [];
    const actions = [];
    const calendarEvents = [];
    const gardenUpdates = [];
    const recommendations = [];

    const units = (meta.settings.units || "lb").toLowerCase();
    const inputs = ctx.inputs || {};
    const bedsIn = Array.isArray(inputs.beds) ? inputs.beds : [];
    const cropsIn = Array.isArray(inputs.crops) ? inputs.crops : [];
    const catalogIn = inputs.cropCatalog || {};
    const packets = inputs.seedPackets || {};
    const seedsOnHand = inputs.seedsOnHand || {};
    const hh = inputs.household || { size: 4, dailyUseLb: 3.0 };
    const parsedNotes = parseNotes(inputs.notes || "");
    const vision = inputs.householdVision || {};
    const { annualTargetLb, mealDemandLb } = computeDemandLb({
      householdVision: vision,
      mealPlan: inputs.mealPlan || []
    });

    actions.push({
      type: "OPEN_UI",
      route: meta.settings.openUIRoute,
      component: "GardenPlan",
      params: {}
    });

    /* -------------------- Normalize beds -------------------- */
    const bedMap = {};
    for (const b of bedsIn) {
      const lengthM = safe(b.lengthM, b.areaM2 ? b.areaM2 / meta.settings.defaultBedWidthM : 3.6);
      const widthM = safe(b.widthM, meta.settings.defaultBedWidthM);
      const areaM2 = safe(b.areaM2, lengthM * widthM);
      bedMap[b.bedId] = { bedId: b.bedId, lengthM, widthM, areaM2 };
    }

    /* -------------------- Optional: zone timing advice -------------------- */
    let zoneAdvice = null;
    const zone = meta.settings.zone ?? inputs.settings?.zone ?? null;
    const year = meta.settings.year ?? inputs.settings?.year ?? dayjs().year();

    if (zone && services?.planning?.getZonePlantingDates) {
      try {
        const cropKeys = Array.from(
          new Set(cropsIn.map((c) => (c.name || "").toLowerCase()).filter(Boolean))
        ).map((key) => ({ key }));
        if (cropKeys.length) {
          zoneAdvice = await services.planning.getZonePlantingDates({
            zone: String(zone),
            year: safe(year, dayjs().year()),
            crops: cropKeys,
            options: { preferFall: true }
          });
        }
      } catch (_e) {
        logs.push("Zone planting dates unavailable; continuing without timing anchors.");
      }
    }

    /* -------------------- Per-crop computation -------------------- */
    const items = [];
    let totalAreaSqft = 0;
    let totalKg = 0;
    let totalKcal = 0;
    let seedBudget = 0;

    const adviceByCrop = new Map();
    if (zoneAdvice?.schedule) {
      for (const s of zoneAdvice.schedule) {
        adviceByCrop.set((s.name || s.key || "").toLowerCase(), s);
      }
    }

    for (const c of cropsIn) {
      const name = c.name;
      if (!name) continue;
      const key = (name || "").toLowerCase();

      // Area / plants
      let areaM2 = 0;
      let plants = safe(c.plants, 0);
      if (c.areaSqft) areaM2 = c.areaSqft * 0.092903;
      else if (c.areaM2) areaM2 = c.areaM2;
      else if (c.bedId && bedMap[c.bedId]) areaM2 = bedMap[c.bedId].areaM2;

      if (plants <= 0 && areaM2 > 0) plants = plantsFromAreaM2(name, areaM2, catalogIn);

      // Yields + units
      const kg = yieldKg(name, { plants, areaM2 }, catalogIn);
      const valUnits = toUnits(kg, units);

      // Storage split aligned to household vision
      const splitKg = storageSplit(name, kg, catalogIn, vision.focus);

      // Seeds: overage + germination
      const packetSpec = packets[name] || {};
      const perPacket = safe(packetSpec.seedsPerPacket, 0);
      const germPct = safe(packetSpec.germinationPct, DEFAULT_GERMINATION_PCT) / 100;
      const overPct = safe(meta.settings.seedOveragePct, 10) / 100;
      const neededSeeds = Math.ceil(plants / Math.max(germPct, 0.01));
      const withOverage = Math.ceil(neededSeeds * (1 + overPct));
      const onHand = safe(seedsOnHand[name]?.seeds, 0);
      const buySeeds = Math.max(0, withOverage - onHand);
      const packetsNeeded = perPacket > 0 ? Math.ceil(buySeeds / perPacket) : null;

      // Economics (optional)
      const econ = catalogIn[key]?.economics || {};
      if (packetsNeeded && econ.cost_per_packet) {
        seedBudget += packetsNeeded * Number(econ.cost_per_packet);
      }

      totalAreaSqft += areaM2 / 0.092903;
      totalKg += kg;

      // Meal-plan demand coverage (lb baseline)
      const demandLb =
        safe(mealDemandLb[name] ?? mealDemandLb[title(name)] ?? mealDemandLb[key], 0);
      const producedLb = units === "lb" ? valUnits : kg * KG2LB;
      const demandCoveragePct =
        demandLb > 0 ? Math.min(100, Math.round((producedLb / demandLb) * 100)) : null;

      // Nutrition (optional)
      const kcalPerKg = safe(catalogIn[key]?.nutrition?.kcal_per_kg, 0);
      const kcal = kcalPerKg * kg;
      totalKcal += kcal;

      // Timing anchors (if available)
      const z = adviceByCrop.get(key);
      const timing = z
        ? {
            spring: z.spring
              ? {
                  sowIndoor: z.spring.sowIndoor || null,
                  sowOutdoor: z.spring.sowOutdoor || null,
                  transplant: z.spring.transplant || null
                }
              : null,
            fall: z.fall
              ? {
                  sowIndoor: z.fall.sowIndoor || null,
                  sowOutdoor: z.fall.sowOutdoor || null,
                  transplant: z.fall.transplant || null
                }
              : null
          }
        : null;

      // Calendar anchors (non-intrusive reminders)
      if (timing?.spring?.transplant || timing?.spring?.sowOutdoor || timing?.spring?.sowIndoor) {
        const anchor =
          timing.spring.transplant || timing.spring.sowOutdoor || timing.spring.sowIndoor;
        calendarEvents.push({
          type: "care",
          title: `Planting window: ${title(name)}`,
          date: anchor,
          notes: "Auto-generated from zone timing."
        });
      }

      const item = {
        crop: title(name),
        bedId: c.bedId || null,
        bed: c.bedId && bedMap[c.bedId] ? bedMap[c.bedId] : null,
        geometry:
          areaM2 > 0
            ? {
                areaM2: +areaM2.toFixed(2),
                areaSqft: +((areaM2 / 0.092903)).toFixed(0),
                ...(c.bedId && bedMap[c.bedId]
                  ? { lengthM: bedMap[c.bedId].lengthM, widthM: bedMap[c.bedId].widthM }
                  : {})
              }
            : null,
        spacingCm: spacingFor(name, catalogIn),
        plants,
        seedOrder: {
          neededSeeds: withOverage,
          onHand,
          buySeeds,
          packets: packetsNeeded,
          germinationPct: Math.round(germPct * 100)
        },
        expectedHarvest: { value: +valUnits.toFixed(1), units }, // lbs default
        lastsDaysAtHouseholdUse:
          hh?.dailyUseLb ? Math.ceil((units === "lb" ? valUnits : kg * KG2LB) / hh.dailyUseLb) : null,
        storagePlan: Object.fromEntries(
          Object.entries(splitKg).map(([k, vKg]) => [k, +toUnits(vKg, units).toFixed(1)])
        ),
        nutritionKcal: kcal ? Math.round(kcal) : null,
        economics: packetsNeeded && econ.cost_per_packet ? { seedCost: packetsNeeded * Number(econ.cost_per_packet) } : null,
        varieties: parsedNotes.varieties[name] || [],
        notes: demandCoveragePct != null ? `${demandCoveragePct}% of meal-plan demand` : undefined,
        timing // optional timing block to help UIs
      };

      // Procurement nudges
      if (item.seedOrder.buySeeds > 0 && perPacket > 0) {
        actions.push({
          type: "ALERT",
          level: "info",
          message: `Seeds: ${item.crop} need ${item.seedOrder.buySeeds} (≈${item.seedOrder.packets} packet${item.seedOrder.packets === 1 ? "" : "s"}).`
        });
      }

      items.push(item);
    }

    // Totals
    const totalValUnits = toUnits(totalKg, units);
    const targetLb = safe(annualTargetLb, 0);
    const selfReliancePct = targetLb > 0
      ? Math.round(((units === "lb" ? totalValUnits : totalValUnits * KG2LB) / targetLb) * 100)
      : null;

    // High-level nudge if we’re far from the target
    if (selfReliancePct != null && selfReliancePct < safe(vision.selfReliancePct, 60)) {
      recommendations.push(
        `Plan meets ~${selfReliancePct}% of annual target. Consider increasing area for calorie-dense staples (potato, winter squash, beans).`
      );
    }

    // Emit a lightweight procurement task bundle for seeds (if any buys)
    const seedShortfalls = items
      .filter((it) => (it.seedOrder?.buySeeds || 0) > 0)
      .map((it) => ({
        name: `${it.crop} seeds`,
        qty: it.seedOrder.buySeeds,
        unit: "seed",
        priority: "staple",
        tags: ["seed"]
      }));

    if (seedShortfalls.length) {
      actions.push({
        type: "LOG",
        message: `Seed budget (est.): $${seedBudget.toFixed(2)}`,
        meta: { seedBudget }
      });
      // If you’ve wired scheduleProcurement, this is an easy handoff:
      actions.push({
        type: "PROCUREMENT_SUGGEST",
        payload: { demand: seedShortfalls, reason: "seed_shortfall" }
      });
    }

    // Compile master update
    gardenUpdates.push({
      type: "garden.household_plan",
      createdISO: isoNow(),
      units,
      household: hh,
      householdVision: { ...vision, computedAnnualTargetLb: targetLb || undefined },
      totals: {
        beds: Object.keys(bedMap).length,
        areaSqft: Math.round(totalAreaSqft),
        expectedHarvest: { value: +totalValUnits.toFixed(1), units },
        lastsDaysAtHouseholdUse: hh?.dailyUseLb
          ? Math.ceil((units === "lb" ? totalValUnits : totalValUnits * KG2LB) / hh.dailyUseLb)
          : null,
        selfReliancePct,
        kcalTotal: totalKcal ? Math.round(totalKcal) : null
      },
      items
    });

    const summary = `Household plan for ${items.length} crop(s), ~${totalValUnits.toFixed(1)} ${units}, ${Math.round(
      totalAreaSqft
    )} sqft.`;

    services?.logger?.info?.(`[${meta.id}] ${summary}`);

    return { ok: true, timestamp: start, summary, recommendations, calendarEvents, gardenUpdates, logs, actions };
  }

  return { meta, nextRuns, run };
}

// default export
const templateInstance = createHouseholdPlanTemplate();
export default templateInstance;

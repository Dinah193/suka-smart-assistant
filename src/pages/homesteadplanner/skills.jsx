// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\skills.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Skills (skill paths tied to what’s planned next)
 * -----------------------------------------------------------------------------
 * What this page does
 *  - Looks at "planned next" signals from Homestead Planner:
 *      • provisioning targets (homesteadProvisioningTargets)
 *      • garden targets (homesteadGardenTargets)
 *      • animal targets (homesteadAnimalTargets)
 *      • preservation batches (homesteadBatches + homesteadBatchLots)
 *  - Maps those signals to recommended skill paths
 *  - Lets users start / pause / complete skills, track micro-steps, attach notes
 *  - Persists progress in Dexie (browser-safe)
 *  - Emits SSA events for cross-module linkage
 *
 * Tables (Dexie)
 *  - homesteadSkillPaths:
 *      { id, title, domain, description, tags[], sources[], steps[], level, estimatedHours,
 *        createdAt, updatedAt, status }
 *  - homesteadSkillProgress:
 *      { id, pathId, householdId, status, startedAt, completedAt, updatedAt, createdAt,
 *        stepStates: { [stepId]: { done:boolean, doneAt?:iso, notes?:string } },
 *        notes, focusNextISO, linkedPlan: { type, id } }
 *
 * Events emitted
 *  - ssa.hp.skills.recommendations.updated
 *  - ssa.hp.skills.path.started
 *  - ssa.hp.skills.path.paused
 *  - ssa.hp.skills.path.completed
 *  - ssa.hp.skills.step.toggled
 *  - ssa.hp.skills.linked
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * DB (aligned with other Homestead Planner pages)
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/skills";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1";
const DB_VERSION = 8; // bump for skills tables

let _dbSingleton = null;

function getDb() {
  if (_dbSingleton) return _dbSingleton;

  const db = new Dexie(DB_NAME);

  // v1 base
  db.version(1).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
  });

  // v2 batches
  db.version(2).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
  });

  // v3 provisioning + garden
  db.version(3).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
    homesteadProvisioningTargets:
      "id, nameLower, category, unit, qtyPerYear, updatedAt, createdAt, *tags",
    homesteadGardenTargets:
      "id, computedAt, cropKey, cropNameLower, sourceHash, window, confidence, *tags",
    homesteadGardenAssumptions: "key",
  });

  // v4 animals
  db.version(4).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
    homesteadProvisioningTargets:
      "id, nameLower, category, unit, qtyPerYear, updatedAt, createdAt, *tags",
    homesteadGardenTargets:
      "id, computedAt, cropKey, cropNameLower, sourceHash, window, confidence, *tags",
    homesteadGardenAssumptions: "key",
    homesteadAnimalTargets:
      "id, computedAt, animalKey, animalNameLower, sourceHash, strategy, confidence, *tags",
    homesteadAnimalAssumptions: "key",
  });

  // v5 cuisines
  db.version(5).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
    homesteadProvisioningTargets:
      "id, nameLower, category, unit, qtyPerYear, updatedAt, createdAt, *tags",
    homesteadGardenTargets:
      "id, computedAt, cropKey, cropNameLower, sourceHash, window, confidence, *tags",
    homesteadGardenAssumptions: "key",
    homesteadAnimalTargets:
      "id, computedAt, animalKey, animalNameLower, sourceHash, strategy, confidence, *tags",
    homesteadAnimalAssumptions: "key",
    cuisineProfiles:
      "id, nameLower, status, createdAt, updatedAt, *tags, *seasonTags",
    cuisineUserPrefs: "key",
    cuisineRotations:
      "id, titleLower, startISO, weeks, updatedAt, createdAt, sourceHash",
  });

  // v7 preferences (keep)
  db.version(7).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
    homesteadProvisioningTargets:
      "id, nameLower, category, unit, qtyPerYear, updatedAt, createdAt, *tags",
    homesteadGardenTargets:
      "id, computedAt, cropKey, cropNameLower, sourceHash, window, confidence, *tags",
    homesteadGardenAssumptions: "key",
    homesteadAnimalTargets:
      "id, computedAt, animalKey, animalNameLower, sourceHash, strategy, confidence, *tags",
    homesteadAnimalAssumptions: "key",
    cuisineProfiles:
      "id, nameLower, status, createdAt, updatedAt, *tags, *seasonTags",
    cuisineUserPrefs: "key",
    cuisineRotations:
      "id, titleLower, startISO, weeks, updatedAt, createdAt, sourceHash",
    householdProfiles: "id, nameLower, updatedAt, createdAt",
    householdPreferences: "id, householdId, updatedAt, createdAt, *tags",
  });

  // v8 skills
  db.version(DB_VERSION).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
    homesteadProvisioningTargets:
      "id, nameLower, category, unit, qtyPerYear, updatedAt, createdAt, *tags",
    homesteadGardenTargets:
      "id, computedAt, cropKey, cropNameLower, sourceHash, window, confidence, *tags",
    homesteadGardenAssumptions: "key",
    homesteadAnimalTargets:
      "id, computedAt, animalKey, animalNameLower, sourceHash, strategy, confidence, *tags",
    homesteadAnimalAssumptions: "key",
    cuisineProfiles:
      "id, nameLower, status, createdAt, updatedAt, *tags, *seasonTags",
    cuisineUserPrefs: "key",
    cuisineRotations:
      "id, titleLower, startISO, weeks, updatedAt, createdAt, sourceHash",
    householdProfiles: "id, nameLower, updatedAt, createdAt",
    householdPreferences: "id, householdId, updatedAt, createdAt, *tags",

    homesteadSkillPaths:
      "id, titleLower, domain, status, level, updatedAt, createdAt, *tags",
    homesteadSkillProgress:
      "id, pathId, householdId, status, updatedAt, createdAt, startedAt, completedAt",
  });

  _dbSingleton = db;
  return db;
}

/* -----------------------------------------------------------------------------
 * Utilities
 * --------------------------------------------------------------------------- */

function nowISO() {
  return new Date().toISOString();
}
function safeString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function normalizeLower(s) {
  return safeString(s).trim().toLowerCase();
}
function uniq(arr) {
  return Array.from(
    new Set((arr || []).map((x) => safeString(x).trim()).filter(Boolean))
  );
}
function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}
function hashStable(obj) {
  const s = JSON.stringify(obj, Object.keys(obj).sort());
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `h_${(h >>> 0).toString(16)}`;
}
function emitSSAEvent(type, detail) {
  try {
    if (typeof window !== "undefined" && window.eventBus?.emit)
      window.eventBus.emit(type, detail);
  } catch (e) {}
  try {
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch (e) {}
}
function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}

/* -----------------------------------------------------------------------------
 * Skill catalog (built-in, editable via Dexie)
 *  - This is a "starter catalog" to ensure page is functional immediately.
 *  - Users can extend by saving new skill paths from the UI.
 * --------------------------------------------------------------------------- */

function step(id, title, desc, estMins = 30, tags = []) {
  return { id, title, desc, estMins: clamp(estMins, 5, 480), tags: uniq(tags) };
}

const BUILTIN_SKILL_PATHS = [
  {
    id: "skills__pressure_canning_basics",
    title: "Pressure Canning Basics",
    titleLower: "pressure canning basics",
    domain: "preservation",
    level: "foundations",
    estimatedHours: 6,
    status: "active",
    tags: ["preservation", "pressure-canning", "safety"],
    description:
      "Learn safe pressure canning workflow: equipment, testing seals, processing times, altitude adjustments, and storage labeling.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "pc_1",
        "Understand safety rules",
        "Botulism risk, low-acid foods, pressure ranges, venting, and why time/pressure matter.",
        45,
        ["safety"]
      ),
      step(
        "pc_2",
        "Equipment checklist",
        "Canner parts, gauges/weights, jars, lids/rings, lifter, funnel, headspace tool.",
        30
      ),
      step(
        "pc_3",
        "Jar prep + headspace",
        "Sterilization (when needed), warm jars, correct headspace for food types.",
        35
      ),
      step(
        "pc_4",
        "Venting + pressurizing",
        "Proper venting time, reaching pressure, maintaining steady pressure.",
        40
      ),
      step(
        "pc_5",
        "Cooling + seal check",
        "Natural depressurizing, removing jars safely, seal verification after 12–24h.",
        35
      ),
      step(
        "pc_6",
        "Labeling + storage",
        "Lot labels, dates, best-by policy, pantry storage conditions.",
        25
      ),
      step(
        "pc_7",
        "Run a practice batch",
        "Practice with water or a simple high-volume safe item (follow tested recipe).",
        90
      ),
    ],
  },
  {
    id: "skills__water_bath_canning_basics",
    title: "Water Bath Canning Basics",
    titleLower: "water bath canning basics",
    domain: "preservation",
    level: "foundations",
    estimatedHours: 4,
    status: "active",
    tags: ["preservation", "water-bath", "jams", "pickles"],
    description:
      "High-acid safe canning: jams, jellies, pickles, tomato products with acidification.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "wb_1",
        "High-acid rules",
        "What qualifies as high-acid and why it matters for safe water bath canning.",
        35,
        ["safety"]
      ),
      step(
        "wb_2",
        "Jar setup + rack",
        "Boiling water coverage, rack use, jar handling and timing.",
        35
      ),
      step(
        "wb_3",
        "Pectin + set",
        "Jams/jellies set points, pectin types, troubleshooting set failures.",
        45
      ),
      step(
        "wb_4",
        "Pickling basics",
        "Vinegar ratios, salt types, crisping tips, safe storage.",
        45
      ),
      step(
        "wb_5",
        "Label + store",
        "Labels, ring removal after sealing, pantry conditions.",
        25
      ),
      step(
        "wb_6",
        "Practice batch",
        "Do one test batch and log headspace + timing + yield.",
        75
      ),
    ],
  },
  {
    id: "skills__dehydrating_basics",
    title: "Dehydrating Basics",
    titleLower: "dehydrating basics",
    domain: "preservation",
    level: "foundations",
    estimatedHours: 3,
    status: "active",
    tags: ["preservation", "dehydrating", "shelf-stable"],
    description:
      "Core dehydrating skills: prep, slice thickness, temperature, conditioning, and storage.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "dh_1",
        "Prep + slice strategy",
        "Uniform slicing, pre-treatments, blanching vs raw, preventing browning.",
        40
      ),
      step(
        "dh_2",
        "Temp/time planning",
        "Temps by food class, checking dryness, avoiding case hardening.",
        45
      ),
      step(
        "dh_3",
        "Conditioning",
        "Jar conditioning to prevent mold and ensure even moisture.",
        25,
        ["safety"]
      ),
      step(
        "dh_4",
        "Storage + oxygen control",
        "Mylar + O2 absorbers, jars, vacuum sealing, rotation.",
        30
      ),
      step(
        "dh_5",
        "Make a shelf kit",
        "Build a basic dehydrated meal kit and log rehydration ratios.",
        55
      ),
    ],
  },
  {
    id: "skills__fermentation_basics",
    title: "Fermentation Basics",
    titleLower: "fermentation basics",
    domain: "preservation",
    level: "foundations",
    estimatedHours: 5,
    status: "active",
    tags: ["preservation", "fermenting", "probiotic"],
    description:
      "Salt brine + lacto-fermentation fundamentals: safety, mold management, and consistent results.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "fm_1",
        "Brine math",
        "Salt percentage brines, weights, and volume conversions.",
        45
      ),
      step(
        "fm_2",
        "Vessels + weights",
        "Airlocks, weights, keeping veg submerged, daily checks.",
        35
      ),
      step(
        "fm_3",
        "Kahm vs mold",
        "Identify harmless yeast vs dangerous mold, safe discard rules.",
        40,
        ["safety"]
      ),
      step(
        "fm_4",
        "Temperature + time",
        "Ferment timing by temp; flavor profiles; when to cold store.",
        40
      ),
      step(
        "fm_5",
        "First batch: cabbage",
        "A simple cabbage ferment with logs for salt%, time, and taste.",
        90
      ),
    ],
  },
  {
    id: "skills__garden_seed_starting",
    title: "Seed Starting + Transplants",
    titleLower: "seed starting + transplants",
    domain: "garden",
    level: "foundations",
    estimatedHours: 4,
    status: "active",
    tags: ["garden", "seed-starting", "soil"],
    description:
      "Start seeds reliably and harden off transplants to reduce losses.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "gs_1",
        "Media + containers",
        "Seed-start mix, drainage, labeling, and moisture control.",
        35
      ),
      step(
        "gs_2",
        "Light + heat",
        "Germination temps, light distance, preventing legginess.",
        45
      ),
      step(
        "gs_3",
        "Watering + damping off",
        "Bottom watering, airflow, sanitation, signs of damping off.",
        45,
        ["safety"]
      ),
      step(
        "gs_4",
        "Potting up",
        "When and how to pot up; root handling; gentle feeding.",
        40
      ),
      step(
        "gs_5",
        "Hardening off",
        "7–10 day hardening schedule and transplant success checklist.",
        45
      ),
    ],
  },
  {
    id: "skills__garden_soil_building",
    title: "Soil Building + Compost",
    titleLower: "soil building + compost",
    domain: "garden",
    level: "foundations",
    estimatedHours: 6,
    status: "active",
    tags: ["garden", "compost", "soil"],
    description:
      "Build fertility via compost, mulch, and basic soil testing to support target crops.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "sb_1",
        "Soil test basics",
        "Texture, pH, organic matter, and interpreting results.",
        45
      ),
      step(
        "sb_2",
        "Compost recipe",
        "Greens/browns ratios, moisture, turning schedule, and smell diagnostics.",
        60
      ),
      step(
        "sb_3",
        "Mulch strategy",
        "Mulch types, weed suppression, moisture retention, and timing.",
        45
      ),
      step(
        "sb_4",
        "Amendments",
        "Lime, gypsum, rock dust, nitrogen sources; avoid over-amending.",
        45
      ),
      step(
        "sb_5",
        "Bed prep workflow",
        "Prepare a bed for a target crop and document inputs/outputs.",
        90
      ),
    ],
  },
  {
    id: "skills__chicken_care_starter",
    title: "Chicken Care Starter Path",
    titleLower: "chicken care starter path",
    domain: "animals",
    level: "foundations",
    estimatedHours: 8,
    status: "active",
    tags: ["animals", "chickens", "biosecurity"],
    description:
      "Basic chicken husbandry: housing, feed, water, health checks, predator protection, and egg handling.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "ck_1",
        "Housing requirements",
        "Coop basics, roosts, bedding, ventilation, space per bird.",
        60
      ),
      step(
        "ck_2",
        "Feed + water",
        "Layer feed vs grower feed, grit/oyster shell, water sanitation.",
        45
      ),
      step(
        "ck_3",
        "Biosecurity",
        "Quarantine, cleaning cycles, parasites, and minimizing disease spread.",
        60,
        ["safety"]
      ),
      step(
        "ck_4",
        "Predator-proofing",
        "Hardware cloth, lock strategy, run design, and overnight risks.",
        60
      ),
      step(
        "ck_5",
        "Health check routine",
        "Weekly check list: droppings, weight, comb, mites, behavior.",
        45
      ),
      step(
        "ck_6",
        "Egg handling",
        "Collection, washing rules, storage, and grading basics.",
        40
      ),
      step(
        "ck_7",
        "First 30-day care plan",
        "Create a care plan and supply list; log daily tasks.",
        90
      ),
    ],
  },
  {
    id: "skills__goat_basics",
    title: "Goat Basics: Care + Fencing",
    titleLower: "goat basics: care + fencing",
    domain: "animals",
    level: "intermediate",
    estimatedHours: 10,
    status: "active",
    tags: ["animals", "goats", "fencing"],
    description:
      "Foundational goat husbandry with emphasis on fencing, browsing, mineral needs, and routine health.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "gt_1",
        "Fencing basics",
        "Fence types, height, electrified options, and escape-proofing.",
        75
      ),
      step(
        "gt_2",
        "Feed + browse",
        "Browsing strategy, hay quality, concentrate rules, clean water.",
        60
      ),
      step(
        "gt_3",
        "Minerals",
        "Loose minerals, copper sensitivity, signs of deficiency.",
        45
      ),
      step(
        "gt_4",
        "Hoof care",
        "Trim schedule, tools, and avoiding lameness.",
        60
      ),
      step(
        "gt_5",
        "Parasite management",
        "FAMACHA basics, rotational grazing principles, when to treat.",
        75,
        ["safety"]
      ),
      step(
        "gt_6",
        "Setup checklist",
        "Shelter, feeders, waterers, basic medical kit.",
        60
      ),
    ],
  },
  {
    id: "skills__bulk_buying_coordination",
    title: "Bulk Buying Coordination",
    titleLower: "bulk buying coordination",
    domain: "storehouse",
    level: "foundations",
    estimatedHours: 3,
    status: "active",
    tags: ["storehouse", "bulk-buying", "planning"],
    description:
      "Coordinate bulk purchasing, storage, rotation, and cost tracking for household provisioning.",
    sources: ["SSA builtin"],
    steps: [
      step(
        "bb_1",
        "Define staples list",
        "Identify top staples and annual quantities based on provisioning targets.",
        40
      ),
      step(
        "bb_2",
        "Storage readiness",
        "Bin/jar strategy, moisture control, pests, and labeling.",
        45
      ),
      step(
        "bb_3",
        "Rotation system",
        "FIFO rules, re-order points, and audit cadence.",
        45
      ),
      step(
        "bb_4",
        "Cost tracking",
        "Track unit cost, seasonal price shifts, and savings per buy.",
        40
      ),
    ],
  },
];

/* -----------------------------------------------------------------------------
 * Mapping planned next -> skill paths
 * --------------------------------------------------------------------------- */

function includesAnyTags(rowTags, needed) {
  const a = uniq(rowTags || []).map(normalizeLower);
  const b = uniq(needed || []).map(normalizeLower);
  if (!a.length || !b.length) return false;
  return b.some((t) => a.includes(t));
}

function inferSkillNeedsFromPlans({
  provisioning = [],
  gardenTargets = [],
  animalTargets = [],
  batches = [],
}) {
  const needs = {
    // category buckets
    preservation: new Set(),
    garden: new Set(),
    animals: new Set(),
    storehouse: new Set(),
    cooking: new Set(),
  };

  // provisioning targets often imply storehouse + preservation
  for (const t of provisioning) {
    const cat = normalizeLower(t?.category);
    const tags = uniq(t?.tags || []).map(normalizeLower);
    const name = normalizeLower(t?.nameLower || t?.name || "");

    if (cat.includes("preserv") || tags.some((x) => x.includes("preserv"))) {
      needs.preservation.add("preservation");
    }
    if (
      cat.includes("meat") ||
      tags.includes("meat") ||
      name.includes("meat")
    ) {
      needs.preservation.add("pressure-canning");
      needs.preservation.add("freezing");
    }
    if (
      cat.includes("veget") ||
      cat.includes("produce") ||
      tags.includes("produce")
    ) {
      needs.preservation.add("dehydrating");
      needs.preservation.add("fermenting");
      needs.preservation.add("water-bath");
    }
    if (
      cat.includes("grain") ||
      tags.includes("grains") ||
      name.includes("rice") ||
      name.includes("corn")
    ) {
      needs.storehouse.add("bulk-buying");
      needs.storehouse.add("rotation");
    }
  }

  // garden targets imply seed starting/soil skills
  if (gardenTargets.length) {
    needs.garden.add("seed-starting");
    needs.garden.add("soil");
    needs.garden.add("compost");
  }

  // animal targets imply animal care skills
  for (const a of animalTargets) {
    const key = normalizeLower(a?.animalKey || "");
    const nm = normalizeLower(a?.animalNameLower || "");
    const tags = uniq(a?.tags || []).map(normalizeLower);

    if (
      key.includes("chicken") ||
      nm.includes("chicken") ||
      tags.includes("chickens")
    )
      needs.animals.add("chickens");
    if (key.includes("goat") || nm.includes("goat") || tags.includes("goats"))
      needs.animals.add("goats");
  }

  // batches imply specific preservation method skills
  for (const b of batches) {
    const method = normalizeLower(
      b?.methodLower || b?.method || b?.methodKey || ""
    );
    const title = normalizeLower(b?.titleLower || b?.title || "");
    const tags = uniq(b?.tags || []).map(normalizeLower);

    const hay = `${method} ${title} ${tags.join(" ")}`;

    if (hay.includes("pressure")) needs.preservation.add("pressure-canning");
    if (
      hay.includes("water bath") ||
      hay.includes("jam") ||
      hay.includes("jelly") ||
      hay.includes("pickle")
    )
      needs.preservation.add("water-bath");
    if (hay.includes("dehydrat")) needs.preservation.add("dehydrating");
    if (hay.includes("ferment")) needs.preservation.add("fermenting");
    if (hay.includes("freeze")) needs.preservation.add("freezing");
  }

  return needs;
}

function scorePathForNeeds(path, needs) {
  const tags = uniq(path?.tags || []).map(normalizeLower);
  const domain = normalizeLower(path?.domain || "");
  let score = 0;

  // domain weight
  if (domain && needs[domain]?.size) score += 2;

  const allNeeds = [
    ...Array.from(needs.preservation),
    ...Array.from(needs.garden),
    ...Array.from(needs.animals),
    ...Array.from(needs.storehouse),
    ...Array.from(needs.cooking),
  ].map(normalizeLower);

  // tag match weight
  for (const n of allNeeds) {
    if (tags.some((t) => t.includes(n) || n.includes(t))) score += 2;
  }

  // light bonus for "foundations" when many plans exist
  if (normalizeLower(path?.level) === "foundations") score += 1;

  return score;
}

/* -----------------------------------------------------------------------------
 * Normalizers
 * --------------------------------------------------------------------------- */

function normalizeSkillPath(p) {
  const title = safeString(p?.title || "").trim() || "Untitled Skill Path";
  return {
    id: safeString(p?.id || `skills__${hashStable({ title, at: nowISO() })}`),
    title,
    titleLower: normalizeLower(title),
    domain: safeString(p?.domain || "general"),
    description: safeString(p?.description || ""),
    tags: uniq(p?.tags || []),
    sources: uniq(p?.sources || ["user"]),
    steps: Array.isArray(p?.steps) ? p.steps.map((s) => normalizeStep(s)) : [],
    level: safeString(p?.level || "foundations"),
    estimatedHours: clamp(
      p?.estimatedHours ?? estimateHoursFromSteps(p?.steps),
      1,
      200
    ),
    status: safeString(p?.status || "active"),
    createdAt: p?.createdAt || nowISO(),
    updatedAt: p?.updatedAt || nowISO(),
  };
}

function normalizeStep(s) {
  const id = safeString(
    s?.id || `step_${hashStable({ t: s?.title || "step", at: nowISO() })}`
  );
  return {
    id,
    title: safeString(s?.title || "Step").trim(),
    desc: safeString(s?.desc || ""),
    estMins: clamp(s?.estMins ?? 30, 5, 480),
    tags: uniq(s?.tags || []),
  };
}

function estimateHoursFromSteps(steps) {
  const arr = Array.isArray(steps) ? steps : [];
  const mins = arr.reduce((sum, s) => sum + clamp(s?.estMins ?? 30, 5, 480), 0);
  return Math.max(1, Math.round((mins / 60) * 10) / 10);
}

function normalizeProgress(p) {
  return {
    id: safeString(
      p?.id || `prog_${hashStable({ pathId: p?.pathId || "x", at: nowISO() })}`
    ),
    pathId: safeString(p?.pathId || ""),
    householdId: safeString(p?.householdId || "primary"),
    status: safeString(p?.status || "not_started"), // not_started | in_progress | paused | completed
    startedAt: p?.startedAt || null,
    completedAt: p?.completedAt || null,
    focusNextISO: p?.focusNextISO || null,
    stepStates:
      p?.stepStates && typeof p.stepStates === "object" ? p.stepStates : {},
    notes: safeString(p?.notes || ""),
    linkedPlan: p?.linkedPlan || null, // { type, id }
    createdAt: p?.createdAt || nowISO(),
    updatedAt: p?.updatedAt || nowISO(),
  };
}

/* -----------------------------------------------------------------------------
 * UI Atoms
 * --------------------------------------------------------------------------- */

function FieldLabel({ children }) {
  return (
    <div className="text-xs font-semibold opacity-80 mb-1">{children}</div>
  );
}
function Button({
  children,
  onClick,
  variant = "solid",
  disabled,
  title,
  type = "button",
  className,
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold border transition";
  const solid = "bg-black text-white border-black hover:opacity-90";
  const ghost = "bg-white text-black border-gray-300 hover:bg-gray-50";
  const danger = "bg-white text-red-700 border-red-200 hover:bg-red-50";
  const styles =
    variant === "ghost" ? ghost : variant === "danger" ? danger : solid;
  return (
    <button
      type={type}
      title={title}
      disabled={!!disabled}
      onClick={onClick}
      className={cx(
        base,
        styles,
        disabled ? "opacity-50 cursor-not-allowed" : "",
        className
      )}
    >
      {children}
    </button>
  );
}
function Input({ value, onChange, placeholder, className, type = "text" }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      className={cx(
        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black",
        className
      )}
    />
  );
}
function Select({ value, onChange, options, className }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      className={cx(
        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black bg-white",
        className
      )}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
function Textarea({ value, onChange, placeholder, rows = 6, className }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className={cx(
        "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black",
        className
      )}
    />
  );
}
function Badge({ tone = "neutral", children, title }) {
  const cls =
    tone === "success"
      ? "border-green-200 text-green-800 bg-green-50"
      : tone === "warn"
      ? "border-amber-200 text-amber-800 bg-amber-50"
      : tone === "danger"
      ? "border-red-200 text-red-800 bg-red-50"
      : "border-gray-200 text-black bg-white";
  return (
    <span
      title={title}
      className={cx("text-xs rounded-full border px-2 py-1", cls)}
    >
      {children}
    </span>
  );
}
function Card({ title, subtitle, right, children, className }) {
  return (
    <div
      className={cx(
        "rounded-2xl border border-gray-200 p-4 bg-white",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <div className="font-bold">{title}</div>
          {subtitle ? (
            <div className="text-xs opacity-70 mt-1">{subtitle}</div>
          ) : null}
        </div>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}
function ModalShell({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-5xl rounded-2xl bg-white shadow-xl border border-gray-200 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
          <div className="font-bold text-base">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border px-2 py-1 text-sm"
          >
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer ? (
          <div className="px-5 py-4 border-t border-gray-200">{footer}</div>
        ) : null}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Main Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerSkillsPage() {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  const [paths, setPaths] = useState([]); // merged builtin + saved
  const [progress, setProgress] = useState([]); // progress rows

  const [planSignals, setPlanSignals] = useState({
    provisioning: [],
    gardenTargets: [],
    animalTargets: [],
    batches: [],
  });

  const [filters, setFilters] = useState({
    q: "",
    domain: "all",
    show: "recommended", // recommended | all | in_progress | completed
    level: "all",
  });

  const [activeModal, setActiveModal] = useState({ open: false, pathId: null });

  const [toast, setToast] = useState(null);

  // load
  useEffect(() => {
    const db = getDb();
    dbRef.current = db;

    (async () => {
      try {
        await db.inventoryMeta.limit(1).toArray();
        await ensureSkillsTables(db);

        const [loadedPaths, loadedProgress, signals] = await Promise.all([
          loadSkillPaths(db),
          loadProgress(db),
          loadPlanSignals(db),
        ]);

        setPaths(loadedPaths);
        setProgress(loadedProgress);
        setPlanSignals(signals);

        setReady(true);
      } catch (e) {
        console.warn("[Skills] init failed:", e);
        setDbError(
          "Skills storage isn’t available (IndexedDB blocked/unavailable)."
        );
        // still show builtins in-memory
        setPaths(BUILTIN_SKILL_PATHS.map(normalizeSkillPath));
        setProgress([]);
        setPlanSignals({
          provisioning: [],
          gardenTargets: [],
          animalTargets: [],
          batches: [],
        });
        setReady(true);
      }
    })();
  }, []);

  function pushToast(message, kind = "info") {
    setToast({ message, kind, at: Date.now() });
    setTimeout(() => setToast(null), 2200);
  }

  const needs = useMemo(
    () => inferSkillNeedsFromPlans(planSignals),
    [planSignals]
  );

  const recommendations = useMemo(() => {
    const list = (paths || [])
      .filter((p) => normalizeLower(p.status) !== "archived")
      .map((p) => ({ path: p, score: scorePathForNeeds(p, needs) }))
      .sort((a, b) => b.score - a.score);

    const top = list.filter((x) => x.score > 0).slice(0, 12);

    emitSSAEvent("ssa.hp.skills.recommendations.updated", {
      source: PAGE_SOURCE,
      computedAt: nowISO(),
      snapshotHash: hashStable({
        needs: serializeNeeds(needs),
        top: top.map((t) => ({ id: t.path.id, score: t.score })),
      }),
      needs: serializeNeeds(needs),
      top: top.map((t) => ({
        id: t.path.id,
        title: t.path.title,
        score: t.score,
        domain: t.path.domain,
      })),
    });

    return top;
  }, [paths, needs]);

  const progressByPath = useMemo(() => {
    const map = new Map();
    for (const p of progress || []) map.set(p.pathId, normalizeProgress(p));
    return map;
  }, [progress]);

  const filteredList = useMemo(() => {
    const q = normalizeLower(filters.q);
    const domain = normalizeLower(filters.domain);
    const show = normalizeLower(filters.show);
    const level = normalizeLower(filters.level);

    const recIds = new Set(recommendations.map((r) => r.path.id));

    const base = (paths || []).filter(
      (p) => normalizeLower(p.status) !== "archived"
    );

    const out = base.filter((p) => {
      if (q) {
        const hay = `${p.titleLower} ${normalizeLower(p.description)} ${(
          p.tags || []
        ).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (domain !== "all" && normalizeLower(p.domain) !== domain) return false;
      if (level !== "all" && normalizeLower(p.level) !== level) return false;

      const prog = progressByPath.get(p.id);
      const st = normalizeLower(prog?.status || "not_started");

      if (show === "recommended" && !recIds.has(p.id)) return false;
      if (show === "in_progress" && st !== "in_progress") return false;
      if (show === "completed" && st !== "completed") return false;

      return true;
    });

    // sort: recommended score desc, then progress status, then title
    const scored = out.map((p) => {
      const rec = recommendations.find((r) => r.path.id === p.id);
      const score = rec ? rec.score : scorePathForNeeds(p, needs);
      const st = normalizeLower(
        progressByPath.get(p.id)?.status || "not_started"
      );
      const stRank =
        st === "in_progress"
          ? 0
          : st === "paused"
          ? 1
          : st === "not_started"
          ? 2
          : 3;
      return { p, score, stRank };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.stRank !== b.stRank) return a.stRank - b.stRank;
      return a.p.titleLower.localeCompare(b.p.titleLower);
    });

    return scored;
  }, [paths, filters, recommendations, needs, progressByPath]);

  // actions
  async function startPath(path, linkedPlan = null) {
    const db = dbRef.current;
    const now = nowISO();
    const existing = progressByPath.get(path.id);

    const next = normalizeProgress({
      ...(existing || {}),
      id:
        existing?.id ||
        `prog_${hashStable({ pathId: path.id, householdId: "primary" })}`,
      pathId: path.id,
      householdId: "primary",
      status: "in_progress",
      startedAt: existing?.startedAt || now,
      completedAt: null,
      focusNextISO: existing?.focusNextISO || daysFromNow(2),
      linkedPlan: linkedPlan || existing?.linkedPlan || null,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
    });

    setProgress((prev) => {
      const rest = (prev || []).filter((x) => x.pathId !== path.id);
      return [...rest, next];
    });

    if (db && !dbError) {
      try {
        await db.homesteadSkillProgress.put(next);
      } catch (e) {
        console.warn("[Skills] start save failed:", e);
      }
    }

    emitSSAEvent("ssa.hp.skills.path.started", {
      source: PAGE_SOURCE,
      pathId: path.id,
      title: path.title,
      linkedPlan,
      updatedAt: now,
    });
    pushToast("Started.", "success");
  }

  async function pausePath(path) {
    const db = dbRef.current;
    const now = nowISO();
    const existing = progressByPath.get(path.id);
    if (!existing) return;

    const next = normalizeProgress({
      ...existing,
      status: "paused",
      updatedAt: now,
    });
    setProgress((prev) =>
      (prev || []).map((x) => (x.pathId === path.id ? next : x))
    );

    if (db && !dbError) {
      try {
        await db.homesteadSkillProgress.put(next);
      } catch (e) {
        console.warn("[Skills] pause save failed:", e);
      }
    }

    emitSSAEvent("ssa.hp.skills.path.paused", {
      source: PAGE_SOURCE,
      pathId: path.id,
      updatedAt: now,
    });
    pushToast("Paused.", "info");
  }

  async function completePath(path) {
    const db = dbRef.current;
    const now = nowISO();
    const existing = progressByPath.get(path.id);

    // Ensure all steps are done (or allow completion anyway). We'll auto-mark remaining steps done.
    const stepStates = { ...(existing?.stepStates || {}) };
    for (const s of path.steps || []) {
      if (!stepStates[s.id]?.done)
        stepStates[s.id] = {
          ...(stepStates[s.id] || {}),
          done: true,
          doneAt: now,
        };
    }

    const next = normalizeProgress({
      ...(existing || {}),
      id:
        existing?.id ||
        `prog_${hashStable({ pathId: path.id, householdId: "primary" })}`,
      pathId: path.id,
      householdId: "primary",
      status: "completed",
      startedAt: existing?.startedAt || now,
      completedAt: now,
      stepStates,
      focusNextISO: null,
      updatedAt: now,
      createdAt: existing?.createdAt || now,
    });

    setProgress((prev) => {
      const rest = (prev || []).filter((x) => x.pathId !== path.id);
      return [...rest, next];
    });

    if (db && !dbError) {
      try {
        await db.homesteadSkillProgress.put(next);
      } catch (e) {
        console.warn("[Skills] complete save failed:", e);
      }
    }

    emitSSAEvent("ssa.hp.skills.path.completed", {
      source: PAGE_SOURCE,
      pathId: path.id,
      title: path.title,
      completedAt: now,
      snapshotHash: hashStable({ pathId: path.id, at: now }),
    });
    pushToast("Completed.", "success");
  }

  async function toggleStep(path, stepId) {
    const db = dbRef.current;
    const now = nowISO();
    const existing =
      progressByPath.get(path.id) ||
      normalizeProgress({ pathId: path.id, householdId: "primary" });
    const stepStates = { ...(existing.stepStates || {}) };
    const prev = stepStates[stepId] || {};
    const nextDone = !prev.done;

    stepStates[stepId] = {
      ...prev,
      done: nextDone,
      doneAt: nextDone ? now : null,
    };

    // if any step is checked, treat as in_progress unless completed
    let status = existing.status;
    if (normalizeLower(status) !== "completed") {
      const anyDone = Object.values(stepStates).some((x) => x && x.done);
      status = anyDone ? "in_progress" : "not_started";
    }

    const next = normalizeProgress({
      ...existing,
      pathId: path.id,
      householdId: "primary",
      status,
      startedAt: existing.startedAt || (status === "in_progress" ? now : null),
      updatedAt: now,
      stepStates,
      createdAt: existing.createdAt || now,
    });

    setProgress((prevArr) => {
      const rest = (prevArr || []).filter((x) => x.pathId !== path.id);
      return [...rest, next];
    });

    if (db && !dbError) {
      try {
        await db.homesteadSkillProgress.put(next);
      } catch (e) {
        console.warn("[Skills] toggle step save failed:", e);
      }
    }

    emitSSAEvent("ssa.hp.skills.step.toggled", {
      source: PAGE_SOURCE,
      pathId: path.id,
      stepId,
      done: nextDone,
      updatedAt: now,
    });
  }

  async function updateProgressNotes(pathId, notes) {
    const db = dbRef.current;
    const now = nowISO();
    const existing =
      progressByPath.get(pathId) ||
      normalizeProgress({ pathId, householdId: "primary" });
    const next = normalizeProgress({
      ...existing,
      notes: safeString(notes),
      updatedAt: now,
    });

    setProgress((prevArr) => {
      const rest = (prevArr || []).filter((x) => x.pathId !== pathId);
      return [...rest, next];
    });

    if (db && !dbError) {
      try {
        await db.homesteadSkillProgress.put(next);
      } catch (e) {
        console.warn("[Skills] notes save failed:", e);
      }
    }
  }

  async function createCustomPathFromModal(draft) {
    const db = dbRef.current;
    const now = nowISO();
    const path = normalizeSkillPath({
      ...draft,
      createdAt: now,
      updatedAt: now,
      status: "active",
    });

    setPaths((prev) => {
      const existing = (prev || []).filter((x) => x.id !== path.id);
      return [...existing, path];
    });

    if (db && !dbError) {
      try {
        await db.homesteadSkillPaths.put(path);
      } catch (e) {
        console.warn("[Skills] save custom path failed:", e);
        pushToast("Could not save skill path.", "error");
        return;
      }
    }

    pushToast("Skill path saved.", "success");
    setActiveModal({ open: false, pathId: null });
  }

  // helper: link a recommended skill to a plan item (from "planned next" list)
  async function startLinkedTo(planItem) {
    // planItem: { type, id, title, tags[], methodLower? }
    const rec = recommendations[0]?.path;
    if (!rec) return;
    await startPath(rec, { type: planItem.type, id: planItem.id });
    emitSSAEvent("ssa.hp.skills.linked", {
      source: PAGE_SOURCE,
      pathId: rec.id,
      linkedPlan: { type: planItem.type, id: planItem.id },
    });
  }

  const plannedNextItems = useMemo(
    () => flattenPlannedNext(planSignals),
    [planSignals]
  );

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">Skills</h1>
            <div className="text-sm opacity-80 mt-1">
              Skill paths automatically suggested based on what your Homestead
              Planner says is next.
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              onClick={() => setActiveModal({ open: true, pathId: null })}
              title="Create skill path"
            >
              + New skill path
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                refreshSignals(
                  dbRef,
                  setPlanSignals,
                  setPaths,
                  setProgress,
                  setDbError,
                  pushToast
                )
              }
            >
              Refresh plans
            </Button>
          </div>
        </div>

        {dbError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="font-bold text-red-800">Storage unavailable</div>
            <div className="text-red-800 mt-1">{dbError}</div>
          </div>
        ) : null}

        {/* Planned Next */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <Card
            className="lg:col-span-5"
            title="Planned next"
            subtitle="Signals pulled from provisioning, targets, and batches."
            right={
              <Badge tone={plannedNextItems.length ? "success" : "neutral"}>
                {plannedNextItems.length} items
              </Badge>
            }
          >
            {plannedNextItems.length ? (
              <div className="space-y-2">
                {plannedNextItems.slice(0, 10).map((x) => (
                  <div
                    key={`${x.type}:${x.id}`}
                    className="rounded-xl border border-gray-200 bg-white p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-semibold text-sm">{x.title}</div>
                        <div className="text-xs opacity-70 mt-1">
                          {x.type} • {x.meta}
                        </div>
                        <div className="flex flex-wrap gap-2 mt-2">
                          {(x.tags || []).slice(0, 6).map((t) => (
                            <Badge key={t}>{t}</Badge>
                          ))}
                        </div>
                      </div>
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => startLinkedTo(x)}
                          title="Start top recommended skill linked to this plan"
                        >
                          Start skill
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
                {plannedNextItems.length > 10 ? (
                  <div className="text-xs opacity-70">
                    Showing 10 of {plannedNextItems.length}…
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="text-sm opacity-70">
                No plan signals found yet. Add provisioning targets, compute
                garden/animal targets, or start a preservation batch.
              </div>
            )}
          </Card>

          <Card
            className="lg:col-span-7"
            title="Recommendations"
            subtitle="Top skill paths that match your plans."
            right={
              <Badge tone={recommendations.length ? "success" : "neutral"}>
                {recommendations.length} suggested
              </Badge>
            }
          >
            {recommendations.length ? (
              <div className="space-y-2">
                {recommendations.map((r) => {
                  const prog = progressByPath.get(r.path.id);
                  const st = normalizeLower(prog?.status || "not_started");
                  const donePct = computeCompletionPct(r.path, prog);

                  return (
                    <div
                      key={r.path.id}
                      className="rounded-xl border border-gray-200 bg-white p-3"
                    >
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="font-bold">{r.path.title}</div>
                          <div className="text-xs opacity-70 mt-1">
                            {r.path.domain} • {r.path.level} • ~
                            {r.path.estimatedHours}h • score {r.score}
                          </div>
                          <div className="flex flex-wrap gap-2 mt-2">
                            {(r.path.tags || []).slice(0, 10).map((t) => (
                              <Badge key={t}>{t}</Badge>
                            ))}
                            <Badge
                              tone={
                                st === "completed"
                                  ? "success"
                                  : st === "in_progress"
                                  ? "warn"
                                  : "neutral"
                              }
                            >
                              {labelStatus(st)}
                            </Badge>
                            <Badge tone="neutral">{donePct}%</Badge>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setActiveModal({ open: true, pathId: r.path.id })
                            }
                          >
                            View
                          </Button>
                          {st === "not_started" ? (
                            <Button
                              onClick={() => startPath(r.path)}
                              title="Start this path"
                            >
                              Start
                            </Button>
                          ) : st === "in_progress" ? (
                            <Button
                              variant="ghost"
                              onClick={() => pausePath(r.path)}
                              title="Pause this path"
                            >
                              Pause
                            </Button>
                          ) : st === "paused" ? (
                            <Button
                              onClick={() => startPath(r.path)}
                              title="Resume this path"
                            >
                              Resume
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              onClick={() =>
                                setActiveModal({
                                  open: true,
                                  pathId: r.path.id,
                                })
                              }
                            >
                              Review
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-sm opacity-70">
                No strong recommendations yet. As you add plans
                (targets/batches), this will populate automatically.
              </div>
            )}
          </Card>
        </div>

        {/* Filters + List */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <Card
            className="lg:col-span-12"
            title="Skill library"
            subtitle="Browse all skill paths and track progress."
            right={<Badge tone="neutral">{filteredList.length} shown</Badge>}
          >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <FieldLabel>Search</FieldLabel>
                <Input
                  value={filters.q}
                  onChange={(v) => setFilters((p) => ({ ...p, q: v }))}
                  placeholder="pressure canning, goats, compost…"
                />
              </div>
              <div className="md:col-span-2">
                <FieldLabel>Domain</FieldLabel>
                <Select
                  value={filters.domain}
                  onChange={(v) => setFilters((p) => ({ ...p, domain: v }))}
                  options={[
                    { value: "all", label: "All" },
                    { value: "preservation", label: "Preservation" },
                    { value: "garden", label: "Garden" },
                    { value: "animals", label: "Animals" },
                    { value: "storehouse", label: "Storehouse" },
                    { value: "cooking", label: "Cooking" },
                    { value: "general", label: "General" },
                  ]}
                />
              </div>
              <div className="md:col-span-3">
                <FieldLabel>Show</FieldLabel>
                <Select
                  value={filters.show}
                  onChange={(v) => setFilters((p) => ({ ...p, show: v }))}
                  options={[
                    { value: "recommended", label: "Recommended" },
                    { value: "all", label: "All" },
                    { value: "in_progress", label: "In progress" },
                    { value: "completed", label: "Completed" },
                  ]}
                />
              </div>
              <div className="md:col-span-3">
                <FieldLabel>Level</FieldLabel>
                <Select
                  value={filters.level}
                  onChange={(v) => setFilters((p) => ({ ...p, level: v }))}
                  options={[
                    { value: "all", label: "All" },
                    { value: "foundations", label: "Foundations" },
                    { value: "intermediate", label: "Intermediate" },
                    { value: "advanced", label: "Advanced" },
                  ]}
                />
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {filteredList.length ? (
                filteredList.map(({ p, score }) => {
                  const prog = progressByPath.get(p.id);
                  const st = normalizeLower(prog?.status || "not_started");
                  const donePct = computeCompletionPct(p, prog);

                  return (
                    <div
                      key={p.id}
                      className="rounded-xl border border-gray-200 bg-white p-3"
                    >
                      <div className="flex items-start justify-between gap-2 flex-wrap">
                        <div className="min-w-0">
                          <div className="font-bold">{p.title}</div>
                          <div className="text-xs opacity-70 mt-1">
                            {p.domain} • {p.level} • ~{p.estimatedHours}h •
                            match {score}
                          </div>

                          <div className="flex flex-wrap gap-2 mt-2">
                            {(p.tags || []).slice(0, 10).map((t) => (
                              <Badge key={t}>{t}</Badge>
                            ))}
                            <Badge
                              tone={
                                st === "completed"
                                  ? "success"
                                  : st === "in_progress"
                                  ? "warn"
                                  : "neutral"
                              }
                            >
                              {labelStatus(st)}
                            </Badge>
                            <Badge tone="neutral">{donePct}%</Badge>
                            {prog?.linkedPlan ? (
                              <Badge
                                tone="neutral"
                                title="Linked to a plan item"
                              >
                                linked
                              </Badge>
                            ) : null}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setActiveModal({ open: true, pathId: p.id })
                            }
                          >
                            View
                          </Button>
                          {st === "not_started" ? (
                            <Button onClick={() => startPath(p)}>Start</Button>
                          ) : st === "in_progress" ? (
                            <Button
                              variant="ghost"
                              onClick={() => pausePath(p)}
                            >
                              Pause
                            </Button>
                          ) : st === "paused" ? (
                            <Button onClick={() => startPath(p)}>Resume</Button>
                          ) : (
                            <Button
                              variant="ghost"
                              onClick={() => startPath(p)}
                            >
                              Restart
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-sm opacity-70">
                  No skill paths match your filters.
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Modal */}
        <SkillPathModal
          open={activeModal.open}
          pathId={activeModal.pathId}
          paths={paths}
          progressByPath={progressByPath}
          onClose={() => setActiveModal({ open: false, pathId: null })}
          onStart={startPath}
          onPause={pausePath}
          onComplete={completePath}
          onToggleStep={toggleStep}
          onUpdateNotes={updateProgressNotes}
          onCreateCustom={createCustomPathFromModal}
        />

        {/* Toast */}
        {toast ? (
          <div
            className={cx(
              "fixed bottom-4 left-1/2 -translate-x-1/2 z-[90] rounded-full px-4 py-2 text-sm font-semibold shadow-lg border",
              toast.kind === "success"
                ? "bg-white border-green-200 text-green-800"
                : toast.kind === "error"
                ? "bg-white border-red-200 text-red-800"
                : "bg-white border-gray-200 text-black"
            )}
          >
            {toast.message}
          </div>
        ) : null}

        {!ready ? (
          <div className="mt-6 text-sm opacity-70">Loading…</div>
        ) : null}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Dexie helpers
 * --------------------------------------------------------------------------- */

async function ensureSkillsTables(db) {
  // seed builtin paths into Dexie if none exist
  const count = await db.homesteadSkillPaths.count();
  if (!count) {
    const now = nowISO();
    const rows = BUILTIN_SKILL_PATHS.map((p) =>
      normalizeSkillPath({ ...p, createdAt: now, updatedAt: now })
    );
    await db.homesteadSkillPaths.bulkPut(rows);
  }
}

async function loadSkillPaths(db) {
  const saved = await db.homesteadSkillPaths.toArray();
  const normalizedSaved = saved.map(normalizeSkillPath);

  // If user deleted all saved rows, fallback to builtins
  if (!normalizedSaved.length)
    return BUILTIN_SKILL_PATHS.map(normalizeSkillPath);

  // Merge with builtins: keep saved precedence (by id)
  const map = new Map();
  for (const p of BUILTIN_SKILL_PATHS.map(normalizeSkillPath)) map.set(p.id, p);
  for (const p of normalizedSaved) map.set(p.id, p);
  return Array.from(map.values()).sort((a, b) =>
    a.titleLower.localeCompare(b.titleLower)
  );
}

async function loadProgress(db) {
  const rows = await db.homesteadSkillProgress.toArray();
  return rows.map(normalizeProgress);
}

async function loadPlanSignals(db) {
  // Load small slices; this page needs only "planned next" indicators.
  const [provisioning, gardenTargets, animalTargets, batches] =
    await Promise.all([
      db.homesteadProvisioningTargets
        ? db.homesteadProvisioningTargets.limit(50).toArray()
        : [],
      db.homesteadGardenTargets
        ? db.homesteadGardenTargets.limit(50).toArray()
        : [],
      db.homesteadAnimalTargets
        ? db.homesteadAnimalTargets.limit(50).toArray()
        : [],
      db.homesteadBatches
        ? db.homesteadBatches.orderBy("updatedAt").reverse().limit(20).toArray()
        : [],
    ]);

  return {
    provisioning: provisioning || [],
    gardenTargets: gardenTargets || [],
    animalTargets: animalTargets || [],
    batches: batches || [],
  };
}

async function refreshSignals(
  dbRef,
  setPlanSignals,
  setPaths,
  setProgress,
  setDbError,
  pushToast
) {
  const db = dbRef.current;
  if (!db) return;
  try {
    const [signals, loadedPaths, loadedProgress] = await Promise.all([
      loadPlanSignals(db),
      loadSkillPaths(db),
      loadProgress(db),
    ]);
    setPlanSignals(signals);
    setPaths(loadedPaths);
    setProgress(loadedProgress);
    setDbError(null);
    pushToast("Refreshed.", "success");
  } catch (e) {
    console.warn("[Skills] refresh failed:", e);
    setDbError("Could not refresh plan signals.");
    pushToast("Refresh failed.", "error");
  }
}

/* -----------------------------------------------------------------------------
 * Planned next flattener
 * --------------------------------------------------------------------------- */

function flattenPlannedNext(signals) {
  const out = [];

  for (const t of signals.provisioning || []) {
    const title = safeString(t?.name || t?.nameLower || "Provisioning target");
    out.push({
      type: "provisioning",
      id: safeString(t?.id || hashStable(t)),
      title,
      meta:
        `${safeString(t?.qtyPerYear ?? "")} ${safeString(
          t?.unit ?? ""
        )}`.trim() || safeString(t?.category || ""),
      tags: uniq(t?.tags || []),
    });
  }

  for (const g of signals.gardenTargets || []) {
    const title = safeString(g?.cropKey || g?.cropNameLower || "Garden target");
    out.push({
      type: "garden_target",
      id: safeString(g?.id || hashStable(g)),
      title,
      meta: safeString(g?.window || "planting window"),
      tags: uniq(g?.tags || []),
    });
  }

  for (const a of signals.animalTargets || []) {
    const title = safeString(
      a?.animalKey || a?.animalNameLower || "Animal target"
    );
    out.push({
      type: "animal_target",
      id: safeString(a?.id || hashStable(a)),
      title,
      meta: safeString(a?.strategy || "strategy"),
      tags: uniq(a?.tags || []),
    });
  }

  for (const b of signals.batches || []) {
    const title = safeString(b?.title || b?.titleLower || "Preservation batch");
    out.push({
      type: "batch",
      id: safeString(b?.id || hashStable(b)),
      title,
      meta: safeString(b?.methodLower || b?.status || "batch"),
      tags: uniq(b?.tags || []),
      methodLower: safeString(b?.methodLower || ""),
    });
  }

  // Prefer recency if timestamps exist
  out.sort((x, y) => {
    const ax = safeString(x?.updatedAt || x?.computedAt || x?.createdAt || "");
    const ay = safeString(y?.updatedAt || y?.computedAt || y?.createdAt || "");
    return ay.localeCompare(ax);
  });

  return out;
}

function serializeNeeds(needs) {
  return {
    preservation: Array.from(needs.preservation || []),
    garden: Array.from(needs.garden || []),
    animals: Array.from(needs.animals || []),
    storehouse: Array.from(needs.storehouse || []),
    cooking: Array.from(needs.cooking || []),
  };
}

/* -----------------------------------------------------------------------------
 * Completion helpers
 * --------------------------------------------------------------------------- */

function computeCompletionPct(path, prog) {
  const steps = Array.isArray(path?.steps) ? path.steps : [];
  if (!steps.length) return 0;
  const st = prog?.stepStates || {};
  const done = steps.reduce((sum, s) => sum + (st[s.id]?.done ? 1 : 0), 0);
  return Math.round((done / steps.length) * 100);
}
function labelStatus(st) {
  if (st === "in_progress") return "in progress";
  if (st === "not_started") return "not started";
  return st;
}

/* -----------------------------------------------------------------------------
 * Modal: view/edit/run a skill path; create custom path
 * --------------------------------------------------------------------------- */

function SkillPathModal({
  open,
  pathId,
  paths,
  progressByPath,
  onClose,
  onStart,
  onPause,
  onComplete,
  onToggleStep,
  onUpdateNotes,
  onCreateCustom,
}) {
  const isCreate = !pathId;

  const [draft, setDraft] = useState({
    title: "",
    domain: "preservation",
    level: "foundations",
    tags: [],
    description: "",
    steps: [step("s1", "First step", "Describe what to do.", 30)],
    estimatedHours: 2,
  });

  useEffect(() => {
    if (!open) return;
    if (isCreate) {
      setDraft({
        title: "",
        domain: "preservation",
        level: "foundations",
        tags: [],
        description: "",
        steps: [step("s1", "First step", "Describe what to do.", 30)],
        estimatedHours: 2,
      });
      return;
    }
  }, [open, isCreate]);

  const path = useMemo(() => {
    if (!pathId) return null;
    return (paths || []).find((p) => p.id === pathId) || null;
  }, [pathId, paths]);

  const prog = useMemo(() => {
    if (!path) return null;
    return progressByPath.get(path.id) || null;
  }, [path, progressByPath]);

  const status = normalizeLower(prog?.status || "not_started");
  const pct = path ? computeCompletionPct(path, prog) : 0;

  return (
    <ModalShell
      open={open}
      title={isCreate ? "Create skill path" : "Skill path"}
      onClose={onClose}
      footer={
        isCreate ? (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs opacity-70">
              Saved paths become available for recommendations and progress
              tracking.
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                onClick={() => onCreateCustom?.(draft)}
                disabled={
                  !safeString(draft.title).trim() ||
                  !Array.isArray(draft.steps) ||
                  draft.steps.length === 0
                }
              >
                Save path
              </Button>
            </div>
          </div>
        ) : path ? (
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <Badge
                tone={
                  status === "completed"
                    ? "success"
                    : status === "in_progress"
                    ? "warn"
                    : "neutral"
                }
              >
                {labelStatus(status)}
              </Badge>
              <Badge tone="neutral">{pct}%</Badge>
              {prog?.linkedPlan ? (
                <Badge
                  tone="neutral"
                  title={`Linked to ${prog.linkedPlan.type}:${prog.linkedPlan.id}`}
                >
                  linked
                </Badge>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {status === "not_started" ? (
                <Button onClick={() => onStart?.(path)}>Start</Button>
              ) : status === "in_progress" ? (
                <Button variant="ghost" onClick={() => onPause?.(path)}>
                  Pause
                </Button>
              ) : status === "paused" ? (
                <Button onClick={() => onStart?.(path)}>Resume</Button>
              ) : (
                <Button variant="ghost" onClick={() => onStart?.(path)}>
                  Restart
                </Button>
              )}
              <Button variant="ghost" onClick={() => onComplete?.(path)}>
                Mark complete
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : null
      }
    >
      {isCreate ? (
        <CreatePathEditor draft={draft} setDraft={setDraft} />
      ) : !path ? (
        <div className="text-sm opacity-70">Skill path not found.</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
          <div className="lg:col-span-7">
            <div className="font-black text-xl">{path.title}</div>
            <div className="text-xs opacity-70 mt-1">
              {path.domain} • {path.level} • ~{path.estimatedHours}h
            </div>
            <div className="flex flex-wrap gap-2 mt-2">
              {(path.tags || []).slice(0, 12).map((t) => (
                <Badge key={t}>{t}</Badge>
              ))}
            </div>

            {path.description ? (
              <div className="text-sm mt-3">{path.description}</div>
            ) : null}

            <div className="mt-4">
              <div className="font-bold">Steps</div>
              <div className="text-xs opacity-70 mt-1">
                Check steps as you complete them.
              </div>

              <div className="mt-3 space-y-2">
                {(path.steps || []).map((s) => {
                  const done = !!prog?.stepStates?.[s.id]?.done;
                  return (
                    <div
                      key={s.id}
                      className="rounded-xl border border-gray-200 bg-white p-3"
                    >
                      <div className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          checked={done}
                          onChange={() => onToggleStep?.(path, s.id)}
                          className="mt-1"
                        />
                        <div className="min-w-0">
                          <div className="font-semibold">{s.title}</div>
                          {s.desc ? (
                            <div className="text-sm opacity-80 mt-1">
                              {s.desc}
                            </div>
                          ) : null}
                          <div className="flex flex-wrap gap-2 mt-2">
                            <Badge tone="neutral">{s.estMins} mins</Badge>
                            {(s.tags || []).slice(0, 6).map((t) => (
                              <Badge key={t}>{t}</Badge>
                            ))}
                            {done ? (
                              <Badge tone="success">done</Badge>
                            ) : (
                              <Badge tone="warn">next</Badge>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="lg:col-span-5">
            <Card
              title="Progress notes"
              subtitle="Keep a running log, links, reminders, and mistakes to avoid."
            >
              <Textarea
                value={safeString(prog?.notes || "")}
                onChange={(v) => onUpdateNotes?.(path.id, v)}
                rows={10}
                placeholder="Notes, links, substitutions, measurements, safety checks…"
              />
              <div className="text-xs opacity-70 mt-2">
                Saved locally. You can later surface this in knowledge helper
                flows.
              </div>
            </Card>

            <div className="mt-3">
              <Card
                title="Focus cadence"
                subtitle="Optional: set a suggested next focus date (inform reminders/planning)."
              >
                <div className="text-xs opacity-70">
                  This is stored in progress (focusNextISO). Wire to your
                  ReminderManager later.
                </div>
              </Card>
            </div>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

function CreatePathEditor({ draft, setDraft }) {
  const derivedHours = useMemo(
    () => estimateHoursFromSteps(draft.steps),
    [draft.steps]
  );

  useEffect(() => {
    // keep hours roughly aligned (but let user override)
    if (
      !draft.estimatedHours ||
      Math.abs(draft.estimatedHours - derivedHours) > 1.5
    ) {
      setDraft((p) => ({ ...p, estimatedHours: derivedHours }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derivedHours]);

  function setField(k, v) {
    setDraft((p) => ({ ...p, [k]: v }));
  }

  function setTagsFromText(text) {
    const tags = uniq(text.split(",").map((x) => x.trim()));
    setField("tags", tags);
  }

  function updateStep(i, patch) {
    setDraft((p) => {
      const steps = [...(p.steps || [])];
      steps[i] = normalizeStep({ ...(steps[i] || {}), ...patch });
      return { ...p, steps };
    });
  }

  function addStep() {
    setDraft((p) => {
      const steps = [...(p.steps || [])];
      const idx = steps.length + 1;
      steps.push(step(`s${idx}`, `Step ${idx}`, "", 30));
      return { ...p, steps };
    });
  }

  function removeStep(i) {
    setDraft((p) => {
      const steps = [...(p.steps || [])].filter((_, idx) => idx !== i);
      return {
        ...p,
        steps: steps.length ? steps : [step("s1", "First step", "", 30)],
      };
    });
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
      <div className="lg:col-span-5">
        <FieldLabel>Title</FieldLabel>
        <Input
          value={draft.title}
          onChange={(v) => setField("title", v)}
          placeholder="e.g., Sausage Making Basics"
        />

        <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6">
            <FieldLabel>Domain</FieldLabel>
            <Select
              value={draft.domain}
              onChange={(v) => setField("domain", v)}
              options={[
                { value: "preservation", label: "Preservation" },
                { value: "garden", label: "Garden" },
                { value: "animals", label: "Animals" },
                { value: "storehouse", label: "Storehouse" },
                { value: "cooking", label: "Cooking" },
                { value: "general", label: "General" },
              ]}
            />
          </div>
          <div className="md:col-span-6">
            <FieldLabel>Level</FieldLabel>
            <Select
              value={draft.level}
              onChange={(v) => setField("level", v)}
              options={[
                { value: "foundations", label: "Foundations" },
                { value: "intermediate", label: "Intermediate" },
                { value: "advanced", label: "Advanced" },
              ]}
            />
          </div>
        </div>

        <div className="mt-3">
          <FieldLabel>Tags (comma-separated)</FieldLabel>
          <Input
            value={(draft.tags || []).join(", ")}
            onChange={setTagsFromText}
            placeholder="preservation, curing, safety"
          />
        </div>

        <div className="mt-3">
          <FieldLabel>Description</FieldLabel>
          <Textarea
            value={draft.description}
            onChange={(v) => setField("description", v)}
            rows={6}
            placeholder="What this skill path teaches and why it matters…"
          />
        </div>

        <div className="mt-3">
          <FieldLabel>Estimated hours</FieldLabel>
          <Input
            type="number"
            value={String(draft.estimatedHours || derivedHours)}
            onChange={(v) => setField("estimatedHours", clamp(v, 1, 200))}
          />
          <div className="text-xs opacity-70 mt-1">
            Derived estimate: ~{derivedHours}h from step minutes.
          </div>
        </div>
      </div>

      <div className="lg:col-span-7">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-bold">Steps</div>
            <div className="text-xs opacity-70 mt-1">
              Keep steps short and practical. Add safety steps when needed.
            </div>
          </div>
          <Button variant="ghost" onClick={addStep}>
            + Add step
          </Button>
        </div>

        <div className="mt-3 space-y-2">
          {(draft.steps || []).map((s, i) => (
            <div
              key={s.id || i}
              className="rounded-xl border border-gray-200 bg-white p-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <FieldLabel>Step title</FieldLabel>
                  <Input
                    value={s.title}
                    onChange={(v) => updateStep(i, { title: v })}
                    placeholder={`Step ${i + 1}`}
                  />
                  <div className="mt-2">
                    <FieldLabel>Description</FieldLabel>
                    <Textarea
                      value={s.desc}
                      onChange={(v) => updateStep(i, { desc: v })}
                      rows={3}
                      placeholder="What to do, what to watch for, safety notes…"
                    />
                  </div>
                  <div className="mt-2 grid grid-cols-1 md:grid-cols-12 gap-2">
                    <div className="md:col-span-4">
                      <FieldLabel>Minutes</FieldLabel>
                      <Input
                        type="number"
                        value={String(s.estMins)}
                        onChange={(v) =>
                          updateStep(i, { estMins: clamp(v, 5, 480) })
                        }
                      />
                    </div>
                    <div className="md:col-span-8">
                      <FieldLabel>Tags (comma)</FieldLabel>
                      <Input
                        value={(s.tags || []).join(", ")}
                        onChange={(v) =>
                          updateStep(i, {
                            tags: uniq(v.split(",").map((x) => x.trim())),
                          })
                        }
                        placeholder="safety, setup, practice…"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <Button
                    variant="ghost"
                    onClick={() => removeStep(i)}
                    title="Remove step"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs opacity-80">
          Tip: Once saved, this path can be recommended automatically when
          future plans match its tags/domain.
        </div>
      </div>
    </div>
  );
}

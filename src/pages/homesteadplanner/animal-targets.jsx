// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\animal-targets.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Animal Targets
 * -----------------------------------------------------------------------------
 * Goal
 *  - Convert provisioning targets (meat/eggs/milk/etc.) into:
 *      • Breeding targets (breeders needed, litters/clutches, replacement rates)
 *      • Purchase targets (animals to buy, timing, batch groups)
 *
 * Works standalone:
 *  - Reads provisioning targets from Dexie table homesteadProvisioningTargets
 *    OR inventoryMeta key "homesteadProvisioningTargets" (stringified JSON/array).
 *  - Assumptions live in Dexie table homesteadAnimalAssumptions (key="animalAssumptions").
 *  - Computed snapshots stored in Dexie table homesteadAnimalTargets.
 *
 * Browser-safe:
 *  - No Node imports. Uses Dexie + React only.
 *
 * Emits events:
 *  - window.dispatchEvent(new CustomEvent("ssa.hp.animalTargets.computed", {detail}))
 *  - window.dispatchEvent(new CustomEvent("ssa.hp.animalTargets.saved", {detail}))
 *
 * Notes
 *  - This is intentionally "planner math" not a husbandry authority.
 *  - You can refine yields, fertility, and cull rates in the Assumptions editor.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * DB
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/animal-targets";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1";
const DB_VERSION = 4;

let _dbSingleton = null;

function getDb() {
  if (_dbSingleton) return _dbSingleton;

  const db = new Dexie(DB_NAME);

  // v1
  db.version(1).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
  });

  // v2
  db.version(2).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
  });

  // v3 (garden targets, provisioning targets)
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

  // v4 (animal targets)
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

    // computed snapshot rows
    homesteadAnimalTargets:
      "id, computedAt, animalKey, animalNameLower, sourceHash, strategy, confidence, *tags",

    // settings / assumptions record
    homesteadAnimalAssumptions: "key",
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
function uid(prefix = "id") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}
function safeString(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function normalizeLower(s) {
  return safeString(s).trim().toLowerCase();
}
function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}
function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}
function emitSSAEvent(type, detail) {
  try {
    if (typeof window !== "undefined" && window.eventBus?.emit)
      window.eventBus.emit(type, detail);
  } catch (e) {
    // ignore
  }
  try {
    if (typeof window !== "undefined")
      window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch (e) {
    // ignore
  }
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
function downloadJSON(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function tryParseJSON(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/* -----------------------------------------------------------------------------
 * Default animal catalog + provisioning keyword mapping
 * --------------------------------------------------------------------------- */

/**
 * animal catalog entry fields:
 *  - yieldUnit: base unit for planning ("lb_meat", "egg", "gallon_milk")
 *  - yieldPerMarketAnimal: annualized yield for purchase/finish strategy
 *      - if yieldUnit="lb_meat": pounds retail cuts per market animal
 *      - if yieldUnit="egg": eggs per layer per year (purchase layers)
 *      - if yieldUnit="gallon_milk": gallons per milker per year
 *  - reproduction:
 *      breedable: bool
 *      breedersPerFamily: recommended minimum breeding group size (e.g., 1 buck + 3 does)
 *      offspringPerBirth: avg live young per birth
 *      birthsPerYear: average successful births per female per year
 *      keepRateForGrowOut: fraction of offspring that reach market (after loss/culls)
 *      replacementRate: fraction of breeding animals to replace annually
 *  - marketAgeMonths: typical time to harvest
 *  - strategyDefault: "purchase" | "breed" | "mixed"
 */
const DEFAULT_ANIMAL_CATALOG = [
  {
    animalKey: "chicken_layers",
    animalName: "Chickens (layers)",
    yieldUnit: "egg",
    yieldPerMarketAnimal: 250, // eggs per hen per year (varies: 200-300)
    marketAgeMonths: 6,
    strategyDefault: "purchase",
    reproduction: {
      breedable: true,
      breedersPerFamily: { male: 1, female: 6 }, // rooster + hens
      offspringPerBirth: 8, // hatchlings per clutch (avg viable)
      birthsPerYear: 3, // clutches per year per hen when managed
      keepRateForGrowOut: 0.6,
      replacementRate: 0.35, // replace older layers over time
    },
    notes:
      "Egg yield varies by breed, feed, daylight, and age. Replace a portion yearly for steady production.",
  },
  {
    animalKey: "chicken_broilers",
    animalName: "Chickens (broilers/meat birds)",
    yieldUnit: "lb_meat",
    yieldPerMarketAnimal: 4.5, // retail meat lbs per bird (after dressing)
    marketAgeMonths: 2,
    strategyDefault: "purchase",
    reproduction: {
      breedable: false,
      breedersPerFamily: { male: 0, female: 0 },
      offspringPerBirth: 0,
      birthsPerYear: 0,
      keepRateForGrowOut: 0,
      replacementRate: 0,
    },
    notes: "Broilers are usually purchased as chicks for each batch.",
  },
  {
    animalKey: "goat_meat",
    animalName: "Goats (meat)",
    yieldUnit: "lb_meat",
    yieldPerMarketAnimal: 25, // retail meat lbs per goat (varies)
    marketAgeMonths: 10,
    strategyDefault: "breed",
    reproduction: {
      breedable: true,
      breedersPerFamily: { male: 1, female: 4 }, // buck + does
      offspringPerBirth: 1.6, // singles/twins average
      birthsPerYear: 1.2,
      keepRateForGrowOut: 0.8,
      replacementRate: 0.2,
    },
    notes:
      "Meat yield depends on breed/age. Adjust to your processing realities.",
  },
  {
    animalKey: "goat_milk",
    animalName: "Goats (dairy)",
    yieldUnit: "gallon_milk",
    yieldPerMarketAnimal: 170, // gallons per doe per lactation/year (varies)
    marketAgeMonths: 12,
    strategyDefault: "mixed",
    reproduction: {
      breedable: true,
      breedersPerFamily: { male: 1, female: 3 },
      offspringPerBirth: 1.8,
      birthsPerYear: 1.0,
      keepRateForGrowOut: 0.75,
      replacementRate: 0.2,
    },
    notes:
      "Milk yields vary widely. Plan extra for cheese/yogurt processing loss if needed.",
  },
  {
    animalKey: "sheep_meat",
    animalName: "Sheep (meat/lamb)",
    yieldUnit: "lb_meat",
    yieldPerMarketAnimal: 30,
    marketAgeMonths: 8,
    strategyDefault: "breed",
    reproduction: {
      breedable: true,
      breedersPerFamily: { male: 1, female: 6 }, // ram + ewes
      offspringPerBirth: 1.4,
      birthsPerYear: 1.0,
      keepRateForGrowOut: 0.85,
      replacementRate: 0.18,
    },
    notes: "Plan per local breed and butchery yields.",
  },
  {
    animalKey: "cow_beef",
    animalName: "Cattle (beef)",
    yieldUnit: "lb_meat",
    yieldPerMarketAnimal: 430, // retail beef lbs per steer (varies 350-500+)
    marketAgeMonths: 18,
    strategyDefault: "purchase",
    reproduction: {
      breedable: true,
      breedersPerFamily: { male: 1, female: 8 }, // bull + cows
      offspringPerBirth: 1.0,
      birthsPerYear: 0.9,
      keepRateForGrowOut: 0.9,
      replacementRate: 0.15,
    },
    notes:
      "Many families purchase halves/quarters instead of raising. Strategy can be set per target.",
  },
  {
    animalKey: "rabbit_meat",
    animalName: "Rabbits (meat)",
    yieldUnit: "lb_meat",
    yieldPerMarketAnimal: 3.2,
    marketAgeMonths: 3,
    strategyDefault: "breed",
    reproduction: {
      breedable: true,
      breedersPerFamily: { male: 1, female: 3 }, // buck + does
      offspringPerBirth: 6,
      birthsPerYear: 4,
      keepRateForGrowOut: 0.8,
      replacementRate: 0.25,
    },
    notes:
      "Excellent small-space protein. Manage heat stress and breeding schedules.",
  },
];

/**
 * Provisioning keyword mapping:
 *  - targetKeyMatch: substring keyword match against provisioning target name/category/tags
 *  - planningUnit: one of "lb_meat" | "egg" | "gallon_milk"
 *  - animalKey: which animal this maps to
 *  - targetUnitConversion:
 *      converts provisioning unit to planning unit.
 *      Example: if provisioning unit is "dozen" for eggs, conversion to eggs is 12.
 *      If provisioning unit is "lb", conversion to lb_meat is 1.
 */
const DEFAULT_PROVISIONING_TO_ANIMAL_MAP = [
  // eggs
  {
    targetKeyMatch: "egg",
    animalKey: "chicken_layers",
    planningUnit: "egg",
    unitHint: "egg",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "dozen eggs",
    animalKey: "chicken_layers",
    planningUnit: "egg",
    unitHint: "dozen",
    targetUnitConversion: 12,
  },

  // chicken meat
  {
    targetKeyMatch: "chicken",
    animalKey: "chicken_broilers",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "broiler",
    animalKey: "chicken_broilers",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },

  // goat
  {
    targetKeyMatch: "goat meat",
    animalKey: "goat_meat",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "chevon",
    animalKey: "goat_meat",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "goat milk",
    animalKey: "goat_milk",
    planningUnit: "gallon_milk",
    unitHint: "gallon",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "milk (goat)",
    animalKey: "goat_milk",
    planningUnit: "gallon_milk",
    unitHint: "gallon",
    targetUnitConversion: 1,
  },

  // lamb/sheep
  {
    targetKeyMatch: "lamb",
    animalKey: "sheep_meat",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "mutton",
    animalKey: "sheep_meat",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "sheep",
    animalKey: "sheep_meat",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },

  // beef
  {
    targetKeyMatch: "beef",
    animalKey: "cow_beef",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },
  {
    targetKeyMatch: "steak",
    animalKey: "cow_beef",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },

  // rabbit
  {
    targetKeyMatch: "rabbit",
    animalKey: "rabbit_meat",
    planningUnit: "lb_meat",
    unitHint: "lb",
    targetUnitConversion: 1,
  },
];

/* -----------------------------------------------------------------------------
 * Default assumptions
 * --------------------------------------------------------------------------- */

const DEFAULT_ASSUMPTIONS = {
  version: 1,
  pantryBufferPct: 0.12, // add to provisioning targets to cover guests/loss
  strategyOverrides: {
    // optional per-animal override: animalKey -> "purchase" | "breed" | "mixed"
    // e.g. cow_beef: "purchase"
  },
  purchase: {
    // purchase planning details
    batchGroupsPerYear: 2, // how many purchase batches (broilers etc.)
    rounding: "up", // up | nearest
  },
  breeding: {
    // breeding planning details
    rounding: "up",
    allowFractionalBreeders: false,
    // When doing "mixed", allocate this fraction to breeding and the rest to purchase.
    mixedBreedFraction: 0.65,
  },
  catalog: DEFAULT_ANIMAL_CATALOG,
  provisioningToAnimalMap: DEFAULT_PROVISIONING_TO_ANIMAL_MAP,
  confidence: {
    keywordMatch: 0.6,
    unitKnown: 0.2,
    catalogKnown: 0.2,
  },
  labels: {
    household: "Household",
    region: "US (generic)",
  },
};

/* -----------------------------------------------------------------------------
 * UI atoms
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
function Textarea({ value, onChange, placeholder, rows = 8, className }) {
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
function ModalShell({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-6xl rounded-2xl bg-white shadow-xl border border-gray-200 overflow-hidden">
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
 * Provisioning targets load
 * --------------------------------------------------------------------------- */

async function loadProvisioningTargets(db) {
  try {
    const arr = await db.homesteadProvisioningTargets.toArray();
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (e) {
    // ignore
  }

  try {
    const meta = await db.inventoryMeta.get("homesteadProvisioningTargets");
    if (meta?.value && Array.isArray(meta.value)) return meta.value;
    if (typeof meta?.value === "string") {
      const parsed = tryParseJSON(meta.value);
      if (parsed.ok && Array.isArray(parsed.value)) return parsed.value;
    }
  } catch (e) {
    // ignore
  }

  return [];
}

function normalizeProvisioningTarget(raw) {
  const id = safeString(raw?.id).trim() || uid("pt");
  const name = safeString(raw?.name).trim();
  const category = safeString(raw?.category).trim();
  const unit = safeString(raw?.unit).trim();
  const qtyPerYear = Number(raw?.qtyPerYear);

  const tags = uniq(
    (raw?.tags || []).map((t) => safeString(t).trim()).filter(Boolean)
  );
  const createdAt = raw?.createdAt || nowISO();
  const updatedAt = nowISO();

  const out = {
    id,
    name,
    nameLower: normalizeLower(name),
    category,
    unit,
    qtyPerYear: Number.isFinite(qtyPerYear) ? qtyPerYear : 0,
    notes: safeString(raw?.notes),
    tags,
    createdAt,
    updatedAt,
  };

  const errors = [];
  if (!out.name) errors.push("Target missing name");
  if (!out.unit) errors.push("Target missing unit");
  if (!Number.isFinite(out.qtyPerYear) || out.qtyPerYear <= 0)
    errors.push("Target qtyPerYear must be > 0");
  return { out, errors };
}

/* -----------------------------------------------------------------------------
 * Assumptions persistence
 * --------------------------------------------------------------------------- */

function deepMerge(base, override) {
  if (override == null) return base;
  if (Array.isArray(base) && Array.isArray(override)) return override;
  if (typeof base !== "object" || typeof override !== "object") return override;

  const out = { ...(base || {}) };
  for (const k of Object.keys(override)) {
    if (k in out) out[k] = deepMerge(out[k], override[k]);
    else out[k] = override[k];
  }
  return out;
}

async function loadAssumptions(db) {
  try {
    const rec = await db.homesteadAnimalAssumptions.get("animalAssumptions");
    if (rec?.value) return deepMerge(DEFAULT_ASSUMPTIONS, rec.value);
  } catch (e) {
    // ignore
  }
  return DEFAULT_ASSUMPTIONS;
}

async function saveAssumptions(db, assumptions) {
  await db.homesteadAnimalAssumptions.put({
    key: "animalAssumptions",
    value: assumptions,
    updatedAt: nowISO(),
  });
}

/* -----------------------------------------------------------------------------
 * Core compute: provisioning -> animal targets
 * --------------------------------------------------------------------------- */

function bestMapForTarget(target, mapRows) {
  const hay = `${normalizeLower(target.name)} ${normalizeLower(
    target.category
  )} ${(target.tags || []).map(normalizeLower).join(" ")}`.trim();
  let best = null;
  let bestScore = 0;

  for (const row of mapRows || []) {
    const needle = normalizeLower(row.targetKeyMatch);
    if (!needle) continue;
    if (hay.includes(needle)) {
      const score = 0.6 + Math.min(0.35, needle.length / 100);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
  }

  return { best, matchScore: best ? bestScore : 0 };
}

function getAnimal(animalKey, catalog) {
  return (catalog || []).find((a) => a.animalKey === animalKey) || null;
}

function computeConfidence({ matchScore, unitKnown, catalogKnown, weights }) {
  const w = weights || DEFAULT_ASSUMPTIONS.confidence;
  const score =
    matchScore * (w.keywordMatch || 0) +
    (unitKnown ? 1 : 0) * (w.unitKnown || 0) +
    (catalogKnown ? 1 : 0) * (w.catalogKnown || 0);
  return clamp(score, 0, 1);
}

function normalizeUnit(u) {
  const x = normalizeLower(u);
  if (!x) return "";
  if (["lb", "lbs", "pound", "pounds"].includes(x)) return "lb";
  if (["egg", "eggs"].includes(x)) return "egg";
  if (["dozen", "doz"].includes(x)) return "dozen";
  if (["gallon", "gallons", "gal"].includes(x)) return "gallon";
  if (["quart", "quarts", "qt"].includes(x)) return "quart";
  if (["pint", "pints", "pt"].includes(x)) return "pint";
  return x;
}

function convertToPlanningQty({
  qty,
  unit,
  planningUnit,
  unitConversion,
  targetNameLower,
}) {
  const u = normalizeUnit(unit);
  const pu = planningUnit;

  // direct known conversions
  if (pu === "lb_meat") {
    if (u === "lb") return qty;
    // common meat provisioning might be "half", "quarter" etc. (not auto-converted)
    return qty * (Number(unitConversion) || 1);
  }

  if (pu === "egg") {
    if (u === "egg") return qty;
    if (u === "dozen") return qty * 12;
    return qty * (Number(unitConversion) || 1);
  }

  if (pu === "gallon_milk") {
    if (u === "gallon") return qty;
    if (u === "quart") return qty / 4;
    if (u === "pint") return qty / 8;
    return qty * (Number(unitConversion) || 1);
  }

  // fallback
  console.warn(
    "[AnimalTargets] unknown planning unit:",
    pu,
    "for",
    targetNameLower
  );
  return qty * (Number(unitConversion) || 1);
}

function computePurchaseCounts({ requiredQty, animal, assumptions }) {
  const y = Number(animal.yieldPerMarketAnimal || 0);
  if (!Number.isFinite(y) || y <= 0)
    return { marketAnimalsPerYear: 0, batches: [] };

  const raw = requiredQty / y;

  const rounding = assumptions.purchase?.rounding || "up";
  const marketAnimalsPerYear =
    rounding === "nearest" ? Math.round(raw) : Math.ceil(raw);

  // batch grouping (for broilers, rabbits, etc.)
  const groups = Math.max(
    1,
    Number(assumptions.purchase?.batchGroupsPerYear || 1)
  );
  const perGroupRaw = marketAnimalsPerYear / groups;
  const perGroup =
    rounding === "nearest" ? Math.round(perGroupRaw) : Math.ceil(perGroupRaw);

  const batches = [];
  for (let i = 0; i < groups; i++) {
    batches.push({
      batchIndex: i + 1,
      marketAnimals: perGroup,
      note: `Batch ${i + 1} of ${groups}`,
    });
  }

  return { marketAnimalsPerYear, batches };
}

function computeBreedingCounts({ requiredQty, animal, assumptions }) {
  const r = animal.reproduction || {};
  if (!r.breedable)
    return {
      breeders: null,
      marketAnimalsPerYear: 0,
      offspringPerYear: 0,
      notes: "Not breedable in catalog.",
    };

  const keepRate = Number(r.keepRateForGrowOut || 0.8);
  const birthsPerYear = Number(r.birthsPerYear || 1);
  const offspringPerBirth = Number(r.offspringPerBirth || 1);
  const femaleGroup = r.breedersPerFamily || { male: 1, female: 3 };

  const yieldPerMarket = Number(animal.yieldPerMarketAnimal || 0);
  if (!Number.isFinite(yieldPerMarket) || yieldPerMarket <= 0) {
    // for eggs/milk, breeding means managing layers/milkers
    // use yieldPerMarketAnimal as annual output per producing female
    return {
      breeders: null,
      marketAnimalsPerYear: 0,
      offspringPerYear: 0,
      notes: "Missing yield per producing animal.",
    };
  }

  // For eggs/milk, "market animals" effectively equals producing females required.
  if (animal.yieldUnit === "egg" || animal.yieldUnit === "gallon_milk") {
    const producingRaw = requiredQty / yieldPerMarket;
    const rounding = assumptions.breeding?.rounding || "up";
    const producingFemales =
      rounding === "nearest"
        ? Math.round(producingRaw)
        : Math.ceil(producingRaw);

    const replaceRate = Number(r.replacementRate || 0.25);
    const replacements = Math.ceil(producingFemales * replaceRate);

    // If breedable, estimate chicks/kids needed for replacements:
    const offspringPerFemalePerYear =
      offspringPerBirth * birthsPerYear * keepRate;
    const breedingFemalesRaw =
      offspringPerFemalePerYear > 0
        ? replacements / offspringPerFemalePerYear
        : replacements;
    const breedingFemales =
      rounding === "nearest"
        ? Math.round(breedingFemalesRaw)
        : Math.ceil(breedingFemalesRaw);

    const males = Math.max(0, Number(femaleGroup.male || 1));
    const maleRatio = femaleGroup.female > 0 ? femaleGroup.female : 3;
    const breedingMales = Math.ceil(breedingFemales / maleRatio) * males;

    return {
      breeders: {
        producingFemales,
        replacementPerYear: replacements,
        breedingFemales,
        breedingMales,
      },
      marketAnimalsPerYear: producingFemales,
      offspringPerYear: Math.ceil(
        breedingFemales * offspringPerBirth * birthsPerYear * keepRate
      ),
      notes:
        "Breeding plan sized to supply replacements for producing herd/flock.",
    };
  }

  // Meat plan: required meat -> market animals -> breeding females needed to produce those market animals.
  const marketAnimalsRaw = requiredQty / yieldPerMarket;
  const rounding = assumptions.breeding?.rounding || "up";
  const marketAnimalsPerYear =
    rounding === "nearest"
      ? Math.round(marketAnimalsRaw)
      : Math.ceil(marketAnimalsRaw);

  const offspringPerFemalePerYear =
    offspringPerBirth * birthsPerYear * keepRate;
  const breedingFemalesRaw =
    offspringPerFemalePerYear > 0
      ? marketAnimalsPerYear / offspringPerFemalePerYear
      : marketAnimalsPerYear;
  let breedingFemales =
    rounding === "nearest"
      ? Math.round(breedingFemalesRaw)
      : Math.ceil(breedingFemalesRaw);

  // Enforce minimum breeding group
  const minFem = Math.max(0, Number(femaleGroup.female || 0));
  if (breedingFemales < minFem) breedingFemales = minFem;

  const malesEachGroup = Math.max(0, Number(femaleGroup.male || 1));
  const femalePerGroup = Math.max(1, Number(femaleGroup.female || 3));
  const breedingMales = Math.max(
    malesEachGroup,
    Math.ceil(breedingFemales / femalePerGroup) * malesEachGroup
  );

  // Replacement: additional breeders to replace annually
  const replaceRate = Number(r.replacementRate || 0.2);
  const breederReplacements = Math.ceil(
    (breedingFemales + breedingMales) * replaceRate
  );

  return {
    breeders: {
      breedingFemales,
      breedingMales,
      breederReplacementsPerYear: breederReplacements,
    },
    marketAnimalsPerYear,
    offspringPerYear: Math.ceil(
      breedingFemales * offspringPerBirth * birthsPerYear * keepRate
    ),
    notes: "Breeding plan sized to produce required market animals per year.",
  };
}

function computeAnimalTargets({ provisioningTargets, assumptions }) {
  const a = assumptions || DEFAULT_ASSUMPTIONS;
  const buffer = 1 + Number(a.pantryBufferPct || 0);

  const catalog = a.catalog || [];
  const mapRows = a.provisioningToAnimalMap || [];

  const meta = {
    computedAt: nowISO(),
    source: "provisioningTargets",
    bufferPct: a.pantryBufferPct || 0,
    labels: a.labels || DEFAULT_ASSUMPTIONS.labels,
  };

  // Aggregate requirements by animalKey + planningUnit
  const byAnimal = new Map();

  for (const t of provisioningTargets || []) {
    const qty = Number(t.qtyPerYear);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const { best, matchScore } = bestMapForTarget(t, mapRows);

    const unitLower = normalizeLower(t.unit);
    const unitKnown = !!unitLower;

    if (!best) {
      const key = "unassigned";
      const existing = byAnimal.get(key) || {
        animalKey: key,
        animalName: "Unassigned (needs mapping)",
        animal: null,
        planningUnit: "",
        requiredQty: 0,
        confidence: 0,
        lines: [],
      };
      existing.lines.push({
        targetId: t.id,
        targetName: t.name,
        targetUnit: t.unit,
        targetQty: qty,
        reason: "No keyword mapping match",
      });
      byAnimal.set(key, existing);
      continue;
    }

    const animal = getAnimal(best.animalKey, catalog);
    const catalogKnown = !!animal;

    const planningUnit = best.planningUnit;
    const converted = convertToPlanningQty({
      qty: qty * buffer,
      unit: t.unit,
      planningUnit,
      unitConversion: best.targetUnitConversion,
      targetNameLower: normalizeLower(t.name),
    });

    const confidence = computeConfidence({
      matchScore,
      unitKnown,
      catalogKnown,
      weights: a.confidence,
    });

    const mapKey = `${best.animalKey}::${planningUnit}`;
    const existing = byAnimal.get(mapKey) || {
      animalKey: best.animalKey,
      animalName: animal?.animalName || best.animalKey,
      animal,
      planningUnit,
      requiredQty: 0,
      confidence: 0,
      lines: [],
    };

    existing.requiredQty += converted;
    existing.confidence = Math.max(existing.confidence, confidence);
    existing.lines.push({
      targetId: t.id,
      targetName: t.name,
      targetUnit: t.unit,
      targetQty: qty,
      matchedOn: best.targetKeyMatch,
      planningUnit,
      convertedQty: converted,
      notes: t.notes || "",
    });

    byAnimal.set(mapKey, existing);
  }

  // Build output rows
  const rows = [];
  for (const [, bucket] of byAnimal.entries()) {
    const animal = bucket.animal;
    if (!animal) {
      rows.push({
        id: uid("at"),
        computedAt: meta.computedAt,
        sourceHash: "",
        animalKey: "unassigned",
        animalName: "Unassigned (needs mapping)",
        animalNameLower: "unassigned",
        planningUnit: bucket.planningUnit || "",
        requiredQty: round2(bucket.requiredQty || 0),
        strategy: "manual",
        purchase: null,
        breeding: null,
        marketAgeMonths: 0,
        confidence: bucket.confidence || 0,
        notes: "Map this provisioning line to an animal to compute targets.",
        tags: ["needs_mapping"],
        _lines: bucket.lines || [],
      });
      continue;
    }

    // Determine strategy: override > default
    const override = a.strategyOverrides?.[animal.animalKey];
    const strategy = override || animal.strategyDefault || "purchase";

    const requiredQty = Number(bucket.requiredQty || 0);
    const marketAgeMonths = Number(animal.marketAgeMonths || 0);

    // Compute purchase & breeding components (for mixed, split)
    let purchasePlan = null;
    let breedingPlan = null;

    if (strategy === "purchase") {
      purchasePlan = computePurchaseCounts({
        requiredQty,
        animal,
        assumptions: a,
      });
    } else if (strategy === "breed") {
      breedingPlan = computeBreedingCounts({
        requiredQty,
        animal,
        assumptions: a,
      });
    } else {
      // mixed
      const f = clamp(Number(a.breeding?.mixedBreedFraction ?? 0.65), 0, 1);
      const breedQty = requiredQty * f;
      const buyQty = requiredQty * (1 - f);
      breedingPlan = computeBreedingCounts({
        requiredQty: breedQty,
        animal,
        assumptions: a,
      });
      purchasePlan = computePurchaseCounts({
        requiredQty: buyQty,
        animal,
        assumptions: a,
      });
    }

    rows.push({
      id: uid("at"),
      computedAt: meta.computedAt,
      sourceHash: "",
      animalKey: animal.animalKey,
      animalName: animal.animalName,
      animalNameLower: normalizeLower(animal.animalName),
      planningUnit: bucket.planningUnit,
      requiredQty: round2(requiredQty),
      strategy,
      purchase: purchasePlan,
      breeding: breedingPlan,
      marketAgeMonths,
      confidence: bucket.confidence,
      notes: animal.notes || "",
      tags: [],
      _lines: bucket.lines,
    });
  }

  const sourceHash = hashStable({
    provisioning: (provisioningTargets || []).map((t) => ({
      id: t.id,
      name: t.name,
      unit: t.unit,
      qtyPerYear: t.qtyPerYear,
      category: t.category,
      tags: t.tags || [],
    })),
    assumptions: {
      pantryBufferPct: a.pantryBufferPct,
      overrides: a.strategyOverrides,
      purchase: a.purchase,
      breeding: a.breeding,
      map: a.provisioningToAnimalMap,
      catalog: (a.catalog || []).map((x) => ({
        animalKey: x.animalKey,
        yieldUnit: x.yieldUnit,
        yieldPerMarketAnimal: x.yieldPerMarketAnimal,
        marketAgeMonths: x.marketAgeMonths,
        strategyDefault: x.strategyDefault,
        reproduction: x.reproduction,
      })),
    },
  });

  for (const r of rows) r.sourceHash = sourceHash;

  return { meta: { ...meta, sourceHash }, rows };
}

/* -----------------------------------------------------------------------------
 * Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerAnimalTargetsPage() {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  const [assumptions, setAssumptions] = useState(DEFAULT_ASSUMPTIONS);
  const [provisioningTargets, setProvisioningTargets] = useState([]);
  const [computed, setComputed] = useState({ meta: null, rows: [] });

  const [filter, setFilter] = useState({
    q: "",
    strategy: "",
    minConfidence: "0",
  });
  const [expandedKey, setExpandedKey] = useState(null);

  const [toast, setToast] = useState(null);

  const [editAssumptionsOpen, setEditAssumptionsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [draftTargetsText, setDraftTargetsText] = useState("");

  useEffect(() => {
    const db = getDb();
    dbRef.current = db;

    (async () => {
      try {
        await db.inventoryMeta.limit(1).toArray();
        const a = await loadAssumptions(db);
        setAssumptions(a);

        const targets = await loadProvisioningTargets(db);
        setProvisioningTargets(targets);

        const res = computeAnimalTargets({
          provisioningTargets: targets,
          assumptions: a,
        });
        setComputed(res);

        setReady(true);
      } catch (e) {
        console.warn("[AnimalTargets] init failed:", e);
        setDbError(
          "Animal targets storage isn’t available (IndexedDB blocked/unavailable)."
        );
        setReady(true);
      }
    })();
  }, []);

  function pushToast(message, kind = "info") {
    setToast({ message, kind, at: Date.now() });
    setTimeout(() => setToast(null), 2200);
  }

  async function reloadProvisioning() {
    const db = dbRef.current;
    if (!db || dbError) return;
    const targets = await loadProvisioningTargets(db);
    setProvisioningTargets(targets);
    const res = computeAnimalTargets({
      provisioningTargets: targets,
      assumptions,
    });
    setComputed(res);
    pushToast("Provisioning targets reloaded.", "success");
  }

  function recompute() {
    const res = computeAnimalTargets({ provisioningTargets, assumptions });
    setComputed(res);

    emitSSAEvent("ssa.hp.animalTargets.computed", {
      source: PAGE_SOURCE,
      computedAt: res?.meta?.computedAt,
      sourceHash: res?.meta?.sourceHash,
      rowCount: res?.rows?.length || 0,
    });

    pushToast("Computed animal targets.", "success");
  }

  async function saveSnapshot() {
    const db = dbRef.current;
    if (!db || dbError) return;

    const res = computeAnimalTargets({ provisioningTargets, assumptions });

    try {
      await db.transaction("rw", db.homesteadAnimalTargets, async () => {
        await db.homesteadAnimalTargets
          .where("sourceHash")
          .equals(res.meta.sourceHash)
          .delete();
        const rows = res.rows.map((r) => ({
          ...r,
          animalNameLower: normalizeLower(r.animalName),
        }));
        await db.homesteadAnimalTargets.bulkPut(rows);
      });

      emitSSAEvent("ssa.hp.animalTargets.saved", {
        source: PAGE_SOURCE,
        sourceHash: res.meta.sourceHash,
        computedAt: res.meta.computedAt,
        rowCount: res.rows.length,
      });

      setComputed(res);
      pushToast("Saved snapshot.", "success");
    } catch (e) {
      console.warn("[AnimalTargets] saveSnapshot failed:", e);
      pushToast("Save failed.", "error");
    }
  }

  function exportSnapshot() {
    const res = computeAnimalTargets({ provisioningTargets, assumptions });
    downloadJSON(
      `ssa-animal-targets-${new Date().toISOString().slice(0, 10)}.json`,
      {
        type: "SSA_HomesteadPlanner_AnimalTargets",
        version: 1,
        exportedAt: nowISO(),
        assumptions,
        provisioningTargets,
        computed: res,
      }
    );
    pushToast("Exported JSON.", "success");
  }

  async function saveAssumptionsFromModal(nextAssumptions) {
    const db = dbRef.current;
    if (!db || dbError) return;

    try {
      await saveAssumptions(db, nextAssumptions);
      setAssumptions(nextAssumptions);
      setEditAssumptionsOpen(false);

      const res = computeAnimalTargets({
        provisioningTargets,
        assumptions: nextAssumptions,
      });
      setComputed(res);

      pushToast("Assumptions saved.", "success");
    } catch (e) {
      console.warn("[AnimalTargets] save assumptions failed:", e);
      pushToast("Save assumptions failed.", "error");
    }
  }

  async function importTargetsFromJSONOrCSV() {
    const db = dbRef.current;
    if (!db || dbError) return;

    const text = draftTargetsText.trim();
    if (!text) {
      pushToast("Paste JSON or CSV first.", "error");
      return;
    }

    const parsed = tryParseJSON(text);
    if (parsed.ok) {
      const payload = parsed.value;
      const targets =
        payload?.provisioningTargets ||
        payload?.targets ||
        payload?.data?.targets;

      if (Array.isArray(targets)) {
        const norm = [];
        for (const t of targets) {
          const { out, errors } = normalizeProvisioningTarget(t);
          if (errors.length) {
            pushToast(errors[0], "error");
            return;
          }
          norm.push(out);
        }

        try {
          await db.homesteadProvisioningTargets.bulkPut(norm);
          setProvisioningTargets(norm);
          setImportOpen(false);
          pushToast(`Imported ${norm.length} provisioning targets.`, "success");
          const res = computeAnimalTargets({
            provisioningTargets: norm,
            assumptions,
          });
          setComputed(res);
          return;
        } catch (e) {
          console.warn("[AnimalTargets] import JSON failed:", e);
          pushToast("Import failed.", "error");
          return;
        }
      }

      pushToast("JSON parsed but no provisioningTargets array found.", "error");
      return;
    }

    // CSV fallback: name,category,unit,qtyPerYear,tags(optional),notes(optional)
    try {
      const lines = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      const norm = [];
      for (let i = 0; i < lines.length; i++) {
        const parts = splitCSVLine(lines[i]);
        if (parts.length < 4) continue;

        const [name, category, unit, qtyPerYear, tags, notes] = parts;
        const { out, errors } = normalizeProvisioningTarget({
          name,
          category,
          unit,
          qtyPerYear,
          tags: tags ? tags.split("|").map((x) => x.trim()) : [],
          notes: notes || "",
        });
        if (errors.length) {
          pushToast(`Line ${i + 1}: ${errors[0]}`, "error");
          return;
        }
        norm.push(out);
      }

      await db.homesteadProvisioningTargets.bulkPut(norm);
      setProvisioningTargets(norm);
      setImportOpen(false);
      pushToast(`Imported ${norm.length} provisioning targets.`, "success");

      const res = computeAnimalTargets({
        provisioningTargets: norm,
        assumptions,
      });
      setComputed(res);
    } catch (e) {
      console.warn("[AnimalTargets] import CSV failed:", e);
      pushToast("Import failed.", "error");
    }
  }

  const strategyOptions = useMemo(() => {
    const set = new Set();
    for (const r of computed.rows || []) {
      if (r.strategy) set.add(r.strategy);
    }
    return ["", ...Array.from(set)];
  }, [computed.rows]);

  const filteredRows = useMemo(() => {
    const q = normalizeLower(filter.q);
    const minC = Number(filter.minConfidence || 0);

    return (computed.rows || []).filter((r) => {
      if (q) {
        const hay = `${normalizeLower(r.animalName)} ${normalizeLower(
          r.animalKey
        )} ${normalizeLower(r.planningUnit)} ${(r.tags || [])
          .map(normalizeLower)
          .join(" ")}`.trim();
        if (!hay.includes(q)) return false;
      }
      if (filter.strategy && safeString(r.strategy) !== filter.strategy)
        return false;
      if (Number.isFinite(minC) && minC > 0 && Number(r.confidence || 0) < minC)
        return false;
      return true;
    });
  }, [computed.rows, filter]);

  const summary = useMemo(() => {
    const rows = filteredRows || [];
    const purchaseAnimals = rows.reduce(
      (sum, r) => sum + Number(r.purchase?.marketAnimalsPerYear || 0),
      0
    );
    const breedMarket = rows.reduce(
      (sum, r) => sum + Number(r.breeding?.marketAnimalsPerYear || 0),
      0
    );
    const eggs = rows
      .filter((r) => r.planningUnit === "egg")
      .reduce((sum, r) => sum + Number(r.requiredQty || 0), 0);
    const milk = rows
      .filter((r) => r.planningUnit === "gallon_milk")
      .reduce((sum, r) => sum + Number(r.requiredQty || 0), 0);
    const meat = rows
      .filter((r) => r.planningUnit === "lb_meat")
      .reduce((sum, r) => sum + Number(r.requiredQty || 0), 0);

    return {
      count: rows.length,
      purchaseAnimals: Math.ceil(purchaseAnimals),
      breedMarket: Math.ceil(breedMarket),
      meatLbs: round2(meat),
      eggs: Math.ceil(eggs),
      milkGal: round2(milk),
    };
  }, [filteredRows]);

  const provisioningEmpty = provisioningTargets.length === 0;

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">
              Animal Targets
            </h1>
            <div className="text-sm opacity-80 mt-1">
              Breeding/purchase targets derived from provisioning goals (meat,
              eggs, milk).
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              Import Targets
            </Button>
            <Button
              variant="ghost"
              onClick={() => setEditAssumptionsOpen(true)}
            >
              Edit Assumptions
            </Button>
            <Button
              variant="ghost"
              onClick={exportSnapshot}
              title="Export provisioning + assumptions + computed rows"
            >
              Export
            </Button>
            <Button
              variant="ghost"
              onClick={reloadProvisioning}
              title="Reload provisioning from storage"
            >
              Reload
            </Button>
            <Button onClick={recompute} title="Recompute animal targets">
              Recompute
            </Button>
            <Button
              onClick={saveSnapshot}
              title="Save computed snapshot to storage"
            >
              Save Snapshot
            </Button>
          </div>
        </div>

        {dbError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="font-bold text-red-800">Storage unavailable</div>
            <div className="text-red-800 mt-1">{dbError}</div>
          </div>
        ) : null}

        {provisioningEmpty && ready && !dbError ? (
          <div className="mt-4 rounded-2xl border border-gray-200 p-5">
            <div className="font-bold">No provisioning targets found</div>
            <div className="text-sm opacity-80 mt-1">
              Add/paste targets here, or ensure your provisioning targets page
              writes to <b>homesteadProvisioningTargets</b> (or inventoryMeta
              key <b>homesteadProvisioningTargets</b>).
            </div>
            <div className="mt-3">
              <Button onClick={() => setImportOpen(true)}>
                Import Targets
              </Button>
            </div>
          </div>
        ) : null}

        {/* Summary */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Computed rows</div>
            <div className="text-2xl font-black mt-1">{summary.count}</div>
            <div className="text-xs opacity-70 mt-2">
              Source hash:{" "}
              <b>
                {computed?.meta?.sourceHash
                  ? computed.meta.sourceHash.slice(0, 10)
                  : "—"}
              </b>
            </div>
            <div className="text-xs opacity-70 mt-1">
              Computed:{" "}
              <b>
                {computed?.meta?.computedAt
                  ? computed.meta.computedAt.slice(0, 19).replace("T", " ")
                  : "—"}
              </b>
            </div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Meat requirement</div>
            <div className="text-2xl font-black mt-1">
              {summary.meatLbs.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">
              lbs / year (after buffer)
            </div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Egg requirement</div>
            <div className="text-2xl font-black mt-1">
              {summary.eggs.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">
              eggs / year (after buffer)
            </div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Milk requirement</div>
            <div className="text-2xl font-black mt-1">
              {summary.milkGal.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">
              gallons / year (after buffer)
            </div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-6 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">
              Purchase plan total
            </div>
            <div className="text-2xl font-black mt-1">
              {summary.purchaseAnimals.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">
              market animals per year (across rows)
            </div>
          </div>
          <div className="lg:col-span-6 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">
              Breeding plan market output
            </div>
            <div className="text-2xl font-black mt-1">
              {summary.breedMarket.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">
              market animals or producing females per year
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6">
            <FieldLabel>Search animals</FieldLabel>
            <Input
              value={filter.q}
              onChange={(v) => setFilter((p) => ({ ...p, q: v }))}
              placeholder="goat, eggs, beef, rabbit…"
            />
          </div>
          <div className="md:col-span-3">
            <FieldLabel>Strategy</FieldLabel>
            <Select
              value={filter.strategy}
              onChange={(v) => setFilter((p) => ({ ...p, strategy: v }))}
              options={strategyOptions.map((s) => ({
                value: s,
                label: s ? s : "All strategies",
              }))}
            />
          </div>
          <div className="md:col-span-3">
            <FieldLabel>Min confidence</FieldLabel>
            <Select
              value={filter.minConfidence}
              onChange={(v) => setFilter((p) => ({ ...p, minConfidence: v }))}
              options={[
                { value: "0", label: "Any" },
                { value: "0.4", label: "≥ 0.40" },
                { value: "0.6", label: "≥ 0.60" },
                { value: "0.8", label: "≥ 0.80" },
              ]}
            />
          </div>
        </div>

        {/* Table */}
        <div className="mt-4 rounded-2xl border border-gray-200 overflow-hidden">
          <div className="overflow-auto">
            <table className="min-w-[1200px] w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <Th>Animal</Th>
                  <Th>Need (unit)</Th>
                  <Th>Strategy</Th>
                  <Th>Purchase / yr</Th>
                  <Th>Breeding group</Th>
                  <Th>Output / yr</Th>
                  <Th>Market age</Th>
                  <Th>Confidence</Th>
                  <Th>Notes</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r) => {
                  const conf = Number(r.confidence || 0);
                  const tone =
                    conf >= 0.8
                      ? "success"
                      : conf >= 0.6
                      ? "neutral"
                      : conf >= 0.4
                      ? "warn"
                      : "danger";
                  const isExpanded = expandedKey === r.id;
                  const needsMapping =
                    r.animalKey === "unassigned" ||
                    (r.tags || []).includes("needs_mapping");

                  const unitLabel =
                    r.planningUnit === "lb_meat"
                      ? "lbs meat"
                      : r.planningUnit === "egg"
                      ? "eggs"
                      : r.planningUnit === "gallon_milk"
                      ? "gallons"
                      : r.planningUnit || "—";

                  const purchaseAnimals = Number(
                    r.purchase?.marketAnimalsPerYear || 0
                  );
                  const breedingSummary = summarizeBreeding(r.breeding);

                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        className={cx(
                          "border-b border-gray-100",
                          needsMapping ? "bg-amber-50" : ""
                        )}
                      >
                        <Td>
                          <div className="font-bold">{r.animalName}</div>
                          <div className="text-xs opacity-70">
                            {r.animalKey}
                          </div>
                          {needsMapping ? (
                            <div className="mt-1">
                              <Badge tone="warn">Needs mapping</Badge>
                            </div>
                          ) : null}
                        </Td>

                        <Td>
                          <b>{Number(r.requiredQty || 0).toLocaleString()}</b>
                          <div className="text-xs opacity-70">
                            {unitLabel} / year
                          </div>
                        </Td>

                        <Td>
                          <Badge
                            tone={
                              r.strategy === "breed"
                                ? "success"
                                : r.strategy === "mixed"
                                ? "warn"
                                : "neutral"
                            }
                          >
                            {r.strategy}
                          </Badge>
                        </Td>

                        <Td>
                          {purchaseAnimals ? (
                            <>
                              <b>{purchaseAnimals.toLocaleString()}</b>
                              <div className="text-xs opacity-70">
                                market animals / year
                              </div>
                            </>
                          ) : (
                            "—"
                          )}
                        </Td>

                        <Td className="text-xs">
                          {breedingSummary ? (
                            <>
                              <div className="font-bold">
                                {breedingSummary.title}
                              </div>
                              <div className="opacity-70">
                                {breedingSummary.subtitle}
                              </div>
                            </>
                          ) : (
                            "—"
                          )}
                        </Td>

                        <Td className="text-xs">
                          {r.breeding?.offspringPerYear ? (
                            <>
                              <div className="font-bold">
                                {Number(
                                  r.breeding.offspringPerYear
                                ).toLocaleString()}
                              </div>
                              <div className="opacity-70">
                                offspring / year (est.)
                              </div>
                            </>
                          ) : r.purchase?.batches?.length ? (
                            <>
                              <div className="font-bold">
                                {r.purchase.batches.length}
                              </div>
                              <div className="opacity-70">
                                purchase batches / year
                              </div>
                            </>
                          ) : (
                            "—"
                          )}
                        </Td>

                        <Td>
                          {r.marketAgeMonths ? `${r.marketAgeMonths} mo` : "—"}
                        </Td>

                        <Td>
                          <Badge tone={tone}>{Math.round(conf * 100)}%</Badge>
                        </Td>

                        <Td className="text-xs opacity-80 max-w-[360px]">
                          <div className="line-clamp-2" title={r.notes || ""}>
                            {r.notes || "—"}
                          </div>
                        </Td>

                        <Td>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setExpandedKey(isExpanded ? null : r.id)
                            }
                          >
                            {isExpanded ? "Hide" : "Details"}
                          </Button>
                        </Td>
                      </tr>

                      {isExpanded ? (
                        <tr className="border-b border-gray-100 bg-white">
                          <td colSpan={10} className="p-4">
                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
                              <div className="lg:col-span-7 rounded-xl border border-gray-200 p-4">
                                <div className="font-bold text-sm">
                                  Provisioning lines feeding this animal
                                </div>
                                <div className="text-xs opacity-70 mt-1">
                                  (Each line converted into planning units using
                                  keyword mapping × buffer.)
                                </div>

                                <div className="mt-3 space-y-2">
                                  {(r._lines || []).map((ln) => (
                                    <div
                                      key={
                                        ln.targetId ||
                                        `${ln.targetName}_${Math.random()}`
                                      }
                                      className="rounded-xl border border-gray-200 p-3"
                                    >
                                      <div className="flex items-start justify-between gap-2 flex-wrap">
                                        <div className="min-w-0">
                                          <div className="font-bold text-sm">
                                            {ln.targetName}
                                          </div>
                                          <div className="text-xs opacity-70 mt-1">
                                            {ln.targetQty} {ln.targetUnit} /
                                            year{" "}
                                            {ln.matchedOn ? (
                                              <>
                                                • matched: <b>{ln.matchedOn}</b>
                                              </>
                                            ) : null}{" "}
                                            {ln.planningUnit ? (
                                              <>
                                                • unit: <b>{ln.planningUnit}</b>
                                              </>
                                            ) : null}
                                          </div>
                                        </div>
                                        {ln.convertedQty ? (
                                          <div className="text-sm">
                                            <b>
                                              {round2(
                                                ln.convertedQty
                                              ).toLocaleString()}
                                            </b>{" "}
                                            <span className="text-xs opacity-70">
                                              {prettyPlanningUnit(
                                                ln.planningUnit
                                              )}
                                            </span>
                                          </div>
                                        ) : (
                                          <Badge tone="warn">
                                            No conversion
                                          </Badge>
                                        )}
                                      </div>
                                      {ln.notes ? (
                                        <div className="text-xs opacity-80 mt-2 whitespace-pre-wrap">
                                          {ln.notes}
                                        </div>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              </div>

                              <div className="lg:col-span-5 rounded-xl border border-gray-200 p-4">
                                <div className="font-bold text-sm">
                                  Plan details
                                </div>

                                <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
                                  <div className="rounded-xl border border-gray-200 p-3">
                                    <div className="text-xs opacity-70">
                                      Strategy
                                    </div>
                                    <div className="font-bold">
                                      {r.strategy}
                                    </div>
                                    <div className="text-xs opacity-70 mt-1">
                                      Override this per animal in Assumptions →
                                      Strategy Overrides.
                                    </div>
                                  </div>

                                  {r.purchase ? (
                                    <div className="rounded-xl border border-gray-200 p-3">
                                      <div className="text-xs opacity-70">
                                        Purchase plan
                                      </div>
                                      <div className="font-bold">
                                        {Number(
                                          r.purchase.marketAnimalsPerYear || 0
                                        ).toLocaleString()}{" "}
                                        / year
                                      </div>
                                      {Array.isArray(r.purchase.batches) &&
                                      r.purchase.batches.length ? (
                                        <div className="text-xs opacity-80 mt-2 space-y-1">
                                          {r.purchase.batches.map((b) => (
                                            <div key={b.batchIndex}>
                                              • {b.note}:{" "}
                                              <b>{b.marketAnimals}</b> animals
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}

                                  {r.breeding ? (
                                    <div className="rounded-xl border border-gray-200 p-3">
                                      <div className="text-xs opacity-70">
                                        Breeding plan
                                      </div>
                                      <div className="text-sm font-bold">
                                        {summarizeBreeding(r.breeding)?.title ||
                                          "—"}
                                      </div>
                                      <div className="text-xs opacity-80 mt-1">
                                        {r.breeding.notes || ""}
                                      </div>
                                      {r.breeding.breeders ? (
                                        <div className="text-xs opacity-80 mt-2 space-y-1">
                                          {renderBreederBreakdown(r)}
                                        </div>
                                      ) : null}
                                    </div>
                                  ) : null}

                                  <div className="rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs opacity-80">
                                    <div className="font-bold text-xs mb-1">
                                      Accuracy tips
                                    </div>
                                    <ul className="list-disc ml-5 space-y-1">
                                      <li>
                                        Adjust yields (lbs/animal,
                                        eggs/hen/year, gallons/doe/year) to your
                                        breed/feed reality.
                                      </li>
                                      <li>
                                        Set keep-rate and replacement-rate to
                                        match your losses/culling practices.
                                      </li>
                                      <li>
                                        Use provisioning units that match real
                                        consumption (lbs, dozens, gallons).
                                      </li>
                                    </ul>
                                  </div>
                                </div>

                                <div className="mt-3 flex items-center gap-2 flex-wrap">
                                  <Button
                                    variant="ghost"
                                    onClick={() => setEditAssumptionsOpen(true)}
                                  >
                                    Edit assumptions
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    onClick={() => {
                                      downloadJSON(
                                        `ssa-animal-target-${r.animalKey}.json`,
                                        {
                                          animalKey: r.animalKey,
                                          computedAt:
                                            computed?.meta?.computedAt ||
                                            nowISO(),
                                          sourceHash:
                                            computed?.meta?.sourceHash || "",
                                          row: r,
                                        }
                                      );
                                      pushToast(
                                        "Exported animal detail.",
                                        "success"
                                      );
                                    }}
                                  >
                                    Export detail
                                  </Button>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  );
                })}

                {ready && !dbError && filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="p-6 text-sm opacity-80">
                      No rows match your filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        <EditAssumptionsModal
          open={editAssumptionsOpen}
          onClose={() => setEditAssumptionsOpen(false)}
          assumptions={assumptions}
          onSave={saveAssumptionsFromModal}
        />

        <ImportTargetsModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          value={draftTargetsText}
          onChange={setDraftTargetsText}
          onImport={importTargetsFromJSONOrCSV}
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
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Helpers for rendering breeding
 * --------------------------------------------------------------------------- */

function prettyPlanningUnit(u) {
  if (u === "lb_meat") return "lbs";
  if (u === "egg") return "eggs";
  if (u === "gallon_milk") return "gallons";
  return u || "";
}

function summarizeBreeding(breeding) {
  if (!breeding || !breeding.breeders) return null;

  const b = breeding.breeders;

  if (typeof b.producingFemales === "number") {
    // eggs/milk style
    const pf = Math.max(0, Number(b.producingFemales || 0));
    const bf = Math.max(0, Number(b.breedingFemales || 0));
    const bm = Math.max(0, Number(b.breedingMales || 0));
    return {
      title: `Producing: ${pf} • Breeders: ${bm}M/${bf}F`,
      subtitle: `Replacements/year: ${Math.max(
        0,
        Number(b.replacementPerYear || 0)
      )}`,
    };
  }

  const bf = Math.max(0, Number(b.breedingFemales || 0));
  const bm = Math.max(0, Number(b.breedingMales || 0));
  return {
    title: `Breeders: ${bm}M / ${bf}F`,
    subtitle: `Breeder replacements/year: ${Math.max(
      0,
      Number(b.breederReplacementsPerYear || 0)
    )}`,
  };
}

function renderBreederBreakdown(r) {
  const b = r.breeding?.breeders;
  if (!b) return null;

  if (typeof b.producingFemales === "number") {
    return (
      <>
        <div>
          • Producing females:{" "}
          <b>{Number(b.producingFemales || 0).toLocaleString()}</b>
        </div>
        <div>
          • Replacement/year:{" "}
          <b>{Number(b.replacementPerYear || 0).toLocaleString()}</b>
        </div>
        <div>
          • Breeding males:{" "}
          <b>{Number(b.breedingMales || 0).toLocaleString()}</b>
        </div>
        <div>
          • Breeding females:{" "}
          <b>{Number(b.breedingFemales || 0).toLocaleString()}</b>
        </div>
      </>
    );
  }

  return (
    <>
      <div>
        • Breeding females:{" "}
        <b>{Number(b.breedingFemales || 0).toLocaleString()}</b>
      </div>
      <div>
        • Breeding males: <b>{Number(b.breedingMales || 0).toLocaleString()}</b>
      </div>
      <div>
        • Breeder replacements/year:{" "}
        <b>{Number(b.breederReplacementsPerYear || 0).toLocaleString()}</b>
      </div>
    </>
  );
}

/* -----------------------------------------------------------------------------
 * Table cells
 * --------------------------------------------------------------------------- */

function Th({ children }) {
  return (
    <th className="text-left px-3 py-2 text-xs font-black tracking-wide uppercase opacity-70">
      {children}
    </th>
  );
}
function Td({ children, className }) {
  return <td className={cx("px-3 py-3 align-top", className)}>{children}</td>;
}

/* -----------------------------------------------------------------------------
 * Import Targets Modal
 * --------------------------------------------------------------------------- */

function ImportTargetsModal({ open, onClose, value, onChange, onImport }) {
  return (
    <ModalShell
      open={open}
      title="Import Provisioning Targets"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs opacity-70">
            Supports JSON (with provisioningTargets array) or CSV lines:{" "}
            <b>name,category,unit,qtyPerYear,tags(optional),notes(optional)</b>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button onClick={onImport} disabled={!value.trim()}>
              Import
            </Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-12">
          <FieldLabel>Paste JSON or CSV</FieldLabel>
          <Textarea
            value={value}
            onChange={onChange}
            rows={16}
            placeholder={`JSON example:
{
  "provisioningTargets": [
    {"name":"Eggs (dozens)","category":"Storehouse","unit":"dozen","qtyPerYear":120,"tags":["eggs"]},
    {"name":"Goat milk (gallons)","category":"Dairy","unit":"gallon","qtyPerYear":180,"tags":["goat","milk"]},
    {"name":"Goat meat (lbs)","category":"Freezer","unit":"lb","qtyPerYear":120,"tags":["goat","meat"]}
  ]
}

CSV example:
Eggs (dozens),Storehouse,dozen,120,eggs,
Goat milk (gallons),Dairy,gallon,180,goat|milk,
Goat meat (lbs),Freezer,lb,120,goat|meat,
`}
          />
        </div>
      </div>
    </ModalShell>
  );
}

/* -----------------------------------------------------------------------------
 * Edit Assumptions Modal
 * --------------------------------------------------------------------------- */

function EditAssumptionsModal({ open, onClose, assumptions, onSave }) {
  const [draft, setDraft] = useState(assumptions || DEFAULT_ASSUMPTIONS);
  const [tab, setTab] = useState("overview"); // overview | catalog | mapping | overrides | raw
  const [rawJSON, setRawJSON] = useState("");

  useEffect(() => {
    if (!open) return;
    const merged = deepMerge(DEFAULT_ASSUMPTIONS, assumptions || {});
    setDraft(merged);
    setTab("overview");
    setRawJSON(JSON.stringify(merged, null, 2));
  }, [open, assumptions]);

  function setField(path, value) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev || {}));
      const parts = path.split(".");
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) {
        cur[parts[i]] = cur[parts[i]] ?? {};
        cur = cur[parts[i]];
      }
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  }

  function save() {
    if (tab === "raw") {
      const parsed = tryParseJSON(rawJSON);
      if (!parsed.ok) return;
      onSave?.(deepMerge(DEFAULT_ASSUMPTIONS, parsed.value));
      return;
    }
    onSave?.(draft);
  }

  const canSaveRaw = tab !== "raw" || tryParseJSON(rawJSON).ok;

  return (
    <ModalShell
      open={open}
      title="Animal Assumptions (yields + breeding math)"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs opacity-70">
            These settings control how provisioning converts into
            breeding/purchase targets (buffer, yield, fertility, replacement).
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={!canSaveRaw}
              title={!canSaveRaw ? "Fix JSON first" : "Save assumptions"}
            >
              Save
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Button
          variant={tab === "overview" ? "solid" : "ghost"}
          onClick={() => setTab("overview")}
        >
          Overview
        </Button>
        <Button
          variant={tab === "overrides" ? "solid" : "ghost"}
          onClick={() => setTab("overrides")}
        >
          Strategy Overrides
        </Button>
        <Button
          variant={tab === "catalog" ? "solid" : "ghost"}
          onClick={() => setTab("catalog")}
        >
          Animal Catalog
        </Button>
        <Button
          variant={tab === "mapping" ? "solid" : "ghost"}
          onClick={() => setTab("mapping")}
        >
          Keyword Mapping
        </Button>
        <Button
          variant={tab === "raw" ? "solid" : "ghost"}
          onClick={() => setTab("raw")}
        >
          Raw JSON
        </Button>
      </div>

      {tab === "overview" ? (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-4">
            <FieldLabel>Pantry buffer %</FieldLabel>
            <Input
              type="number"
              value={String(draft.pantryBufferPct ?? 0)}
              onChange={(v) => setField("pantryBufferPct", Number(v))}
              placeholder="0.12"
            />
            <div className="text-xs opacity-70 mt-1">
              Adds extra to cover loss, guests, gifts.
            </div>
          </div>

          <div className="md:col-span-4">
            <FieldLabel>Purchase batches/year</FieldLabel>
            <Input
              type="number"
              value={String(draft.purchase?.batchGroupsPerYear ?? 2)}
              onChange={(v) =>
                setField("purchase.batchGroupsPerYear", Number(v))
              }
              placeholder="2"
            />
            <div className="text-xs opacity-70 mt-1">
              Splits purchase plan into batches.
            </div>
          </div>

          <div className="md:col-span-4">
            <FieldLabel>Mixed: breeding fraction</FieldLabel>
            <Input
              type="number"
              value={String(draft.breeding?.mixedBreedFraction ?? 0.65)}
              onChange={(v) =>
                setField("breeding.mixedBreedFraction", Number(v))
              }
              placeholder="0.65"
            />
            <div className="text-xs opacity-70 mt-1">
              When strategy is “mixed”.
            </div>
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Household label</FieldLabel>
            <Input
              value={draft.labels?.household || ""}
              onChange={(v) => setField("labels.household", v)}
              placeholder="Household"
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Region label</FieldLabel>
            <Input
              value={draft.labels?.region || ""}
              onChange={(v) => setField("labels.region", v)}
              placeholder="US (generic)"
            />
          </div>

          <div className="md:col-span-12 rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs opacity-80">
            <div className="font-bold text-xs mb-2">
              What you’ll most likely customize
            </div>
            <ul className="list-disc ml-5 space-y-1">
              <li>
                Lbs meat per animal (retail yield after butchery) by your
                breed/age.
              </li>
              <li>Eggs per hen/year and layer replacement rate.</li>
              <li>
                Births per year, offspring per birth, keep-rate (loss/culls),
                and replacement rate.
              </li>
            </ul>
          </div>
        </div>
      ) : null}

      {tab === "overrides" ? (
        <OverridesEditor draft={draft} setDraft={setDraft} />
      ) : null}
      {tab === "catalog" ? (
        <AnimalCatalogEditor draft={draft} setDraft={setDraft} />
      ) : null}
      {tab === "mapping" ? (
        <MappingEditor draft={draft} setDraft={setDraft} />
      ) : null}

      {tab === "raw" ? (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-12">
            <FieldLabel>Raw JSON (advanced)</FieldLabel>
            <Textarea value={rawJSON} onChange={setRawJSON} rows={18} />
            <div className="text-xs opacity-70 mt-2">
              {tryParseJSON(rawJSON).ok ? (
                <span className="text-green-700 font-bold">Valid JSON</span>
              ) : (
                <span className="text-red-700 font-bold">Invalid JSON</span>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </ModalShell>
  );
}

function OverridesEditor({ draft, setDraft }) {
  const catalog = draft.catalog || [];
  const overrides = draft.strategyOverrides || {};

  function setOverride(animalKey, value) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.strategyOverrides = next.strategyOverrides || {};
      if (!value) delete next.strategyOverrides[animalKey];
      else next.strategyOverrides[animalKey] = value;
      return next;
    });
  }

  return (
    <div className="mt-4">
      <div className="font-bold">Strategy overrides</div>
      <div className="text-xs opacity-70 mt-1">
        Force an animal to be planned as <b>purchase</b>, <b>breed</b>, or{" "}
        <b>mixed</b> regardless of catalog defaults.
      </div>

      <div className="mt-4 space-y-2">
        {catalog.map((a) => (
          <div
            key={a.animalKey}
            className="rounded-2xl border border-gray-200 p-4"
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <div className="font-bold">{a.animalName}</div>
                <div className="text-xs opacity-70">{a.animalKey}</div>
              </div>
              <div className="w-56">
                <Select
                  value={overrides[a.animalKey] || ""}
                  onChange={(v) => setOverride(a.animalKey, v || "")}
                  options={[
                    { value: "", label: "Use default" },
                    { value: "purchase", label: "purchase" },
                    { value: "breed", label: "breed" },
                    { value: "mixed", label: "mixed" },
                  ]}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnimalCatalogEditor({ draft, setDraft }) {
  const catalog = draft.catalog || [];

  function update(idx, patch) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.catalog = next.catalog || [];
      next.catalog[idx] = { ...next.catalog[idx], ...patch };
      return next;
    });
  }

  function updateRepro(idx, patch) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.catalog = next.catalog || [];
      next.catalog[idx].reproduction = {
        ...(next.catalog[idx].reproduction || {}),
        ...patch,
      };
      return next;
    });
  }

  function add() {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.catalog = next.catalog || [];
      next.catalog.push({
        animalKey: `custom_${uid("animal").slice(-8)}`,
        animalName: "Custom animal",
        yieldUnit: "lb_meat",
        yieldPerMarketAnimal: 20,
        marketAgeMonths: 8,
        strategyDefault: "purchase",
        reproduction: {
          breedable: true,
          breedersPerFamily: { male: 1, female: 3 },
          offspringPerBirth: 2,
          birthsPerYear: 1,
          keepRateForGrowOut: 0.8,
          replacementRate: 0.2,
        },
        notes: "",
      });
      return next;
    });
  }

  function remove(idx) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.catalog = (next.catalog || []).filter((_, i) => i !== idx);
      return next;
    });
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-bold">Animal catalog</div>
          <div className="text-xs opacity-70 mt-1">
            Yields + breeding math are driven by these fields.
          </div>
        </div>
        <Button variant="ghost" onClick={add}>
          + Add animal
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {catalog.map((a, idx) => (
          <div
            key={a.animalKey}
            className="rounded-2xl border border-gray-200 p-4"
          >
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="font-black">{a.animalName}</div>
                <div className="text-xs opacity-70">{a.animalKey}</div>
              </div>
              <Button variant="danger" onClick={() => remove(idx)}>
                Remove
              </Button>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-6">
                <FieldLabel>Name</FieldLabel>
                <Input
                  value={a.animalName || ""}
                  onChange={(v) => update(idx, { animalName: v })}
                />
              </div>

              <div className="md:col-span-6">
                <FieldLabel>Key</FieldLabel>
                <Input
                  value={a.animalKey || ""}
                  onChange={(v) => update(idx, { animalKey: v })}
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Yield unit</FieldLabel>
                <Select
                  value={a.yieldUnit || "lb_meat"}
                  onChange={(v) => update(idx, { yieldUnit: v })}
                  options={[
                    { value: "lb_meat", label: "lb_meat" },
                    { value: "egg", label: "egg" },
                    { value: "gallon_milk", label: "gallon_milk" },
                  ]}
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Yield per producing/market animal</FieldLabel>
                <Input
                  type="number"
                  value={String(a.yieldPerMarketAnimal ?? "")}
                  onChange={(v) =>
                    update(idx, { yieldPerMarketAnimal: Number(v) })
                  }
                  placeholder="e.g., 25"
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Market age (months)</FieldLabel>
                <Input
                  type="number"
                  value={String(a.marketAgeMonths ?? "")}
                  onChange={(v) => update(idx, { marketAgeMonths: Number(v) })}
                  placeholder="e.g., 10"
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Default strategy</FieldLabel>
                <Select
                  value={a.strategyDefault || "purchase"}
                  onChange={(v) => update(idx, { strategyDefault: v })}
                  options={[
                    { value: "purchase", label: "purchase" },
                    { value: "breed", label: "breed" },
                    { value: "mixed", label: "mixed" },
                  ]}
                />
              </div>

              <div className="md:col-span-12">
                <div className="text-xs font-black uppercase opacity-70">
                  Reproduction
                </div>
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Breedable</FieldLabel>
                <Select
                  value={String(!!a.reproduction?.breedable)}
                  onChange={(v) =>
                    updateRepro(idx, { breedable: v === "true" })
                  }
                  options={[
                    { value: "true", label: "true" },
                    { value: "false", label: "false" },
                  ]}
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Offspring per birth</FieldLabel>
                <Input
                  type="number"
                  value={String(a.reproduction?.offspringPerBirth ?? "")}
                  onChange={(v) =>
                    updateRepro(idx, { offspringPerBirth: Number(v) })
                  }
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Births per year</FieldLabel>
                <Input
                  type="number"
                  value={String(a.reproduction?.birthsPerYear ?? "")}
                  onChange={(v) =>
                    updateRepro(idx, { birthsPerYear: Number(v) })
                  }
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Keep rate (grow-out)</FieldLabel>
                <Input
                  type="number"
                  value={String(a.reproduction?.keepRateForGrowOut ?? "")}
                  onChange={(v) =>
                    updateRepro(idx, { keepRateForGrowOut: Number(v) })
                  }
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Replacement rate</FieldLabel>
                <Input
                  type="number"
                  value={String(a.reproduction?.replacementRate ?? "")}
                  onChange={(v) =>
                    updateRepro(idx, { replacementRate: Number(v) })
                  }
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Breeders (M)</FieldLabel>
                <Input
                  type="number"
                  value={String(a.reproduction?.breedersPerFamily?.male ?? "")}
                  onChange={(v) =>
                    updateRepro(idx, {
                      breedersPerFamily: {
                        ...(a.reproduction?.breedersPerFamily || {}),
                        male: Number(v),
                      },
                    })
                  }
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Breeders (F)</FieldLabel>
                <Input
                  type="number"
                  value={String(
                    a.reproduction?.breedersPerFamily?.female ?? ""
                  )}
                  onChange={(v) =>
                    updateRepro(idx, {
                      breedersPerFamily: {
                        ...(a.reproduction?.breedersPerFamily || {}),
                        female: Number(v),
                      },
                    })
                  }
                />
              </div>

              <div className="md:col-span-12">
                <FieldLabel>Notes</FieldLabel>
                <Textarea
                  value={a.notes || ""}
                  onChange={(v) => update(idx, { notes: v })}
                  rows={3}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MappingEditor({ draft, setDraft }) {
  const mapRows = draft.provisioningToAnimalMap || [];
  const animals = (draft.catalog || []).map((a) => ({
    value: a.animalKey,
    label: `${a.animalName} (${a.animalKey})`,
  }));

  function update(idx, patch) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.provisioningToAnimalMap = next.provisioningToAnimalMap || [];
      next.provisioningToAnimalMap[idx] = {
        ...next.provisioningToAnimalMap[idx],
        ...patch,
      };
      return next;
    });
  }

  function add() {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.provisioningToAnimalMap = next.provisioningToAnimalMap || [];
      next.provisioningToAnimalMap.push({
        targetKeyMatch: "new keyword",
        animalKey:
          (next.catalog && next.catalog[0]?.animalKey) || "chicken_layers",
        planningUnit: "lb_meat",
        unitHint: "lb",
        targetUnitConversion: 1,
      });
      return next;
    });
  }

  function remove(idx) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.provisioningToAnimalMap = (
        next.provisioningToAnimalMap || []
      ).filter((_, i) => i !== idx);
      return next;
    });
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-bold">Keyword mapping</div>
          <div className="text-xs opacity-70 mt-1">
            Matches provisioning target text → animal + planning unit conversion
            (lbs/eggs/gallons).
          </div>
        </div>
        <Button variant="ghost" onClick={add}>
          + Add mapping
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {mapRows.map((m, idx) => (
          <div
            key={`${m.targetKeyMatch}_${idx}`}
            className="rounded-2xl border border-gray-200 p-4"
          >
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="font-bold text-sm">Mapping #{idx + 1}</div>
              <Button variant="danger" onClick={() => remove(idx)}>
                Remove
              </Button>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <FieldLabel>Keyword (substring match)</FieldLabel>
                <Input
                  value={m.targetKeyMatch || ""}
                  onChange={(v) => update(idx, { targetKeyMatch: v })}
                  placeholder="goat milk"
                />
              </div>

              <div className="md:col-span-4">
                <FieldLabel>Animal</FieldLabel>
                <Select
                  value={m.animalKey || ""}
                  onChange={(v) => update(idx, { animalKey: v })}
                  options={[{ value: "", label: "Select animal…" }, ...animals]}
                />
              </div>

              <div className="md:col-span-2">
                <FieldLabel>Planning unit</FieldLabel>
                <Select
                  value={m.planningUnit || "lb_meat"}
                  onChange={(v) => update(idx, { planningUnit: v })}
                  options={[
                    { value: "lb_meat", label: "lb_meat" },
                    { value: "egg", label: "egg" },
                    { value: "gallon_milk", label: "gallon_milk" },
                  ]}
                />
              </div>

              <div className="md:col-span-2">
                <FieldLabel>Unit conversion</FieldLabel>
                <Input
                  type="number"
                  value={String(m.targetUnitConversion ?? 1)}
                  onChange={(v) =>
                    update(idx, { targetUnitConversion: Number(v) })
                  }
                  placeholder="1"
                />
              </div>
            </div>

            <div className="text-xs opacity-70 mt-2">
              Tip: Use specific keywords like <b>“goat milk gallons”</b> or{" "}
              <b>“dozen eggs”</b> to reduce accidental matches.
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * CSV splitting (handles simple quoted commas)
 * --------------------------------------------------------------------------- */

function splitCSVLine(line) {
  const out = [];
  let cur = "";
  let inQ = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
      continue;
    }
    if (ch === "," && !inQ) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\garden-targets.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Garden Targets
 * -----------------------------------------------------------------------------
 * Goal
 *  - Convert provisioning targets (what the household wants to preserve/stock)
 *    into planting targets (crops, plants, bed sqft, seed counts, and timelines).
 *
 * Design notes (production-ready, browser-safe):
 *  - Works even if provisioning tables are not present: you can paste/import targets
 *    or create them directly on this page, then link later.
 *  - Uses Dexie (IndexedDB) and does not import Node modules.
 *  - Adds new tables with a DB version bump (non-breaking).
 *
 * Data model (Dexie tables)
 *  - homesteadProvisioningTargets: provisioning targets (optional if you already have elsewhere)
 *      { id, name, nameLower, category, unit, qtyPerYear, notes, tags, createdAt, updatedAt }
 *
 *  - homesteadGardenAssumptions: settings + crop mappings + yield assumptions
 *      { key, value }  // key="gardenAssumptions"
 *
 *  - homesteadGardenTargets: computed plan rows (persisted snapshot)
 *      { id, computedAt, sourceHash, cropKey, cropName, familyTargetUnit, familyTargetQty,
 *        freshEquivalentLbs, plantsNeeded, sqftNeeded, seedCount, seedPackets, window,
 *        d2m, succession, confidence, notes, tags }
 *
 * Emits events:
 *  - window.dispatchEvent(new CustomEvent("ssa.hp.gardenTargets.computed", {detail}))
 *  - window.dispatchEvent(new CustomEvent("ssa.hp.gardenTargets.saved", {detail}))
 *
 * Assumptions you can edit in UI:
 *  - pantry buffer (extra %)
 *  - preservation conversion (fresh -> preserved) multipliers
 *  - yield per plant / per sqft
 *  - succession rounds
 *  - seed germination + thinning factors
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * DB
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/garden-targets";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1";
const DB_VERSION = 3;

let _dbSingleton = null;

function getDb() {
  if (_dbSingleton) return _dbSingleton;

  const db = new Dexie(DB_NAME);

  // v1 tables (shared)
  db.version(1).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
  });

  // v2 tables (batches)
  db.version(2).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
  });

  // v3 tables (garden targets + optional provisioning targets)
  db.version(DB_VERSION).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",

    // Optional: keep provisioning targets here if you don't already have them elsewhere
    homesteadProvisioningTargets:
      "id, nameLower, category, unit, qtyPerYear, updatedAt, createdAt, *tags",

    // Computed garden targets (snapshot)
    homesteadGardenTargets:
      "id, computedAt, cropKey, cropNameLower, sourceHash, window, confidence, *tags",

    // Settings / assumptions (single record)
    homesteadGardenAssumptions: "key",
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
  // lightweight stable hash for snapshots (not crypto)
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
 * Default crop catalog + mappings
 * --------------------------------------------------------------------------- */

/**
 * Crop catalog entries:
 *  - yieldBasis: "plant" | "sqft"
 *  - yieldPerBasisLbs: average fresh lbs per plant or per sqft (per season)
 *  - spacingSqftPerPlant: if yieldBasis="plant", used to estimate bed sqft
 *  - seedsPerPacket: typical packet seed count (for planning)
 *  - germinationRate: 0..1
 *  - thinningFactor: multiplier >1 for extra seeds
 *  - d2m: days to maturity
 *  - windows: rough planting windows (user can override by region)
 */
const DEFAULT_CROP_CATALOG = [
  {
    cropKey: "tomato_paste_sauce",
    cropName: "Tomatoes (paste/sauce types)",
    yieldBasis: "plant",
    yieldPerBasisLbs: 12, // conservative average per plant
    spacingSqftPerPlant: 4,
    seedsPerPacket: 25,
    germinationRate: 0.85,
    thinningFactor: 1.25,
    d2m: 80,
    windows: ["Spring (after frost)"],
    notes:
      "Good for sauce/canning; adjust yield by variety and trellis support.",
  },
  {
    cropKey: "tomato_slicer",
    cropName: "Tomatoes (slicers/cherry)",
    yieldBasis: "plant",
    yieldPerBasisLbs: 10,
    spacingSqftPerPlant: 4,
    seedsPerPacket: 25,
    germinationRate: 0.85,
    thinningFactor: 1.25,
    d2m: 75,
    windows: ["Spring (after frost)"],
    notes: "Fresh eating + freezing. Sauce yields differ.",
  },
  {
    cropKey: "green_beans",
    cropName: "Green Beans (bush)",
    yieldBasis: "sqft",
    yieldPerBasisLbs: 0.4, // per sqft per planting window
    spacingSqftPerPlant: null,
    seedsPerPacket: 50,
    germinationRate: 0.9,
    thinningFactor: 1.15,
    d2m: 55,
    windows: ["Late Spring", "Summer (succession)"],
    notes: "Succession plantings recommended for steady harvests.",
  },
  {
    cropKey: "cucumber_pickling",
    cropName: "Cucumbers (pickling)",
    yieldBasis: "plant",
    yieldPerBasisLbs: 8,
    spacingSqftPerPlant: 4,
    seedsPerPacket: 30,
    germinationRate: 0.9,
    thinningFactor: 1.2,
    d2m: 55,
    windows: ["Late Spring", "Summer (succession)"],
    notes: "Harvest frequently; trellis increases yield.",
  },
  {
    cropKey: "pepper_sweet",
    cropName: "Peppers (sweet)",
    yieldBasis: "plant",
    yieldPerBasisLbs: 4,
    spacingSqftPerPlant: 2,
    seedsPerPacket: 25,
    germinationRate: 0.8,
    thinningFactor: 1.25,
    d2m: 75,
    windows: ["Spring (after frost)"],
    notes: "Freezing + fresh. Yield varies widely by cultivar.",
  },
  {
    cropKey: "pepper_hot",
    cropName: "Peppers (hot)",
    yieldBasis: "plant",
    yieldPerBasisLbs: 3,
    spacingSqftPerPlant: 2,
    seedsPerPacket: 25,
    germinationRate: 0.8,
    thinningFactor: 1.25,
    d2m: 80,
    windows: ["Spring (after frost)"],
    notes: "Drying + sauces.",
  },
  {
    cropKey: "onion_bulb",
    cropName: "Onions (bulb)",
    yieldBasis: "sqft",
    yieldPerBasisLbs: 0.6,
    seedsPerPacket: 200,
    germinationRate: 0.75,
    thinningFactor: 1.1,
    d2m: 110,
    windows: ["Early Spring", "Fall (overwinter in mild zones)"],
    notes:
      "Often started from sets/starts; adjust seed planning if using sets.",
  },
  {
    cropKey: "garlic",
    cropName: "Garlic",
    yieldBasis: "sqft",
    yieldPerBasisLbs: 0.5,
    seedsPerPacket: 0, // cloves
    germinationRate: 0.95,
    thinningFactor: 1,
    d2m: 240,
    windows: ["Fall (plant cloves)"],
    notes: "Plan cloves instead of seeds (1 clove ~ 1 bulb).",
  },
  {
    cropKey: "leafy_greens",
    cropName: "Leafy Greens (collards/kale/spinach mix)",
    yieldBasis: "sqft",
    yieldPerBasisLbs: 0.35,
    seedsPerPacket: 250,
    germinationRate: 0.85,
    thinningFactor: 1.2,
    d2m: 55,
    windows: ["Early Spring", "Fall"],
    notes: "Succession + cut-and-come-again possible.",
  },
  {
    cropKey: "okra",
    cropName: "Okra",
    yieldBasis: "plant",
    yieldPerBasisLbs: 3.5,
    spacingSqftPerPlant: 2.25,
    seedsPerPacket: 30,
    germinationRate: 0.85,
    thinningFactor: 1.2,
    d2m: 60,
    windows: ["Late Spring", "Summer"],
    notes: "Harvest often; very heat tolerant.",
  },
  {
    cropKey: "corn_sweet",
    cropName: "Corn (sweet)",
    yieldBasis: "sqft",
    yieldPerBasisLbs: 0.35, // rough conversion from ears per sqft
    seedsPerPacket: 50,
    germinationRate: 0.9,
    thinningFactor: 1.15,
    d2m: 80,
    windows: ["Late Spring"],
    notes: "Plant in blocks for pollination; yield depends on spacing.",
  },
  {
    cropKey: "berries_mixed",
    cropName: "Berries (strawberry/blackberry mix)",
    yieldBasis: "sqft",
    yieldPerBasisLbs: 0.25,
    seedsPerPacket: 0,
    germinationRate: 0.0,
    thinningFactor: 1,
    d2m: 0,
    windows: ["Perennial (establish year 1)"],
    notes: "Usually starts/plants; yields improve after establishment.",
  },
];

/**
 * Provisioning → Crop mapping rows:
 *  - targetKeyMatch: keyword match against provisioning target name/category
 *  - freshLbsPerTargetUnit: how many fresh lbs are needed per 1 target unit
 *    e.g. 1 quart of tomato sauce might require ~3 lbs tomatoes (varies).
 *  - preferredCropKey: which crop to allocate to.
 *  - methodHint: optional.
 */
const DEFAULT_PROVISIONING_TO_CROP_MAP = [
  {
    targetKeyMatch: "tomato sauce",
    freshLbsPerTargetUnit: 3.0,
    preferredCropKey: "tomato_paste_sauce",
    methodHint: "canning",
  },
  {
    targetKeyMatch: "tomato paste",
    freshLbsPerTargetUnit: 4.0,
    preferredCropKey: "tomato_paste_sauce",
    methodHint: "canning",
  },
  {
    targetKeyMatch: "salsa",
    freshLbsPerTargetUnit: 2.0,
    preferredCropKey: "tomato_slicer",
    methodHint: "canning",
  },
  {
    targetKeyMatch: "diced tomatoes",
    freshLbsPerTargetUnit: 2.5,
    preferredCropKey: "tomato_slicer",
    methodHint: "canning",
  },

  {
    targetKeyMatch: "green beans",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "green_beans",
    methodHint: "canning/freezing",
  },
  {
    targetKeyMatch: "pickles",
    freshLbsPerTargetUnit: 1.5,
    preferredCropKey: "cucumber_pickling",
    methodHint: "pickling",
  },
  {
    targetKeyMatch: "cucumber",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "cucumber_pickling",
  },

  {
    targetKeyMatch: "peppers",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "pepper_sweet",
  },
  {
    targetKeyMatch: "hot sauce",
    freshLbsPerTargetUnit: 1.5,
    preferredCropKey: "pepper_hot",
  },

  {
    targetKeyMatch: "onion",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "onion_bulb",
  },
  {
    targetKeyMatch: "garlic",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "garlic",
  },

  {
    targetKeyMatch: "greens",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "leafy_greens",
  },
  {
    targetKeyMatch: "okra",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "okra",
  },
  {
    targetKeyMatch: "corn",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "corn_sweet",
  },

  {
    targetKeyMatch: "berries",
    freshLbsPerTargetUnit: 1.0,
    preferredCropKey: "berries_mixed",
  },
  {
    targetKeyMatch: "jam",
    freshLbsPerTargetUnit: 2.0,
    preferredCropKey: "berries_mixed",
    methodHint: "canning",
  },
];

/* -----------------------------------------------------------------------------
 * Default assumptions
 * --------------------------------------------------------------------------- */

const DEFAULT_ASSUMPTIONS = {
  version: 1,
  pantryBufferPct: 0.15, // add 15% to targets (loss, gifts, guests)
  seedPacketsRounding: "up", // up | nearest
  seedPacketMin: 1,
  // If you already track family size elsewhere, you can wire it in later:
  householdLabel: "Household",
  regionLabel: "US (generic windows)",
  // Crop catalog + mapping (editable)
  cropCatalog: DEFAULT_CROP_CATALOG,
  provisioningToCropMap: DEFAULT_PROVISIONING_TO_CROP_MAP,
  // Default succession if crop is succession-friendly
  defaultSuccessionRounds: 2,
  // Confidence scoring weights
  confidence: {
    keywordMatch: 0.55,
    unitKnown: 0.25,
    catalogKnown: 0.2,
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
 * Core compute: provisioning targets -> crop targets
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
      // Longer needle gets a slight edge to avoid overly generic matches.
      const score = 0.6 + Math.min(0.35, needle.length / 100);
      if (score > bestScore) {
        bestScore = score;
        best = row;
      }
    }
  }

  return { best, matchScore: best ? bestScore : 0 };
}

function getCrop(cropKey, catalog) {
  return (catalog || []).find((c) => c.cropKey === cropKey) || null;
}

function computeConfidence({ matchScore, unitKnown, catalogKnown, weights }) {
  const w = weights || DEFAULT_ASSUMPTIONS.confidence;
  const score =
    matchScore * (w.keywordMatch || 0) +
    (unitKnown ? 1 : 0) * (w.unitKnown || 0) +
    (catalogKnown ? 1 : 0) * (w.catalogKnown || 0);
  return clamp(score, 0, 1);
}

function computeSeedPackets({
  seedCount,
  seedsPerPacket,
  roundingMode,
  seedPacketMin,
}) {
  if (!seedsPerPacket || seedsPerPacket <= 0)
    return { seedPackets: 0, seedCount };
  const raw = seedCount / seedsPerPacket;
  const packets =
    roundingMode === "nearest"
      ? Math.max(seedPacketMin, Math.round(raw))
      : Math.max(seedPacketMin, Math.ceil(raw));
  return { seedPackets: packets, seedCount };
}

function computeGardenTargets({ provisioningTargets, assumptions }) {
  const a = assumptions || DEFAULT_ASSUMPTIONS;
  const buffer = 1 + Number(a.pantryBufferPct || 0);

  const catalog = a.cropCatalog || [];
  const mapRows = a.provisioningToCropMap || [];

  // Group by cropKey to aggregate fresh lbs requirement across multiple provisioning lines.
  const byCrop = new Map();

  const meta = {
    computedAt: nowISO(),
    source: "provisioningTargets",
    bufferPct: a.pantryBufferPct || 0,
    householdLabel: a.householdLabel || "Household",
    regionLabel: a.regionLabel || "US (generic windows)",
  };

  for (const t of provisioningTargets || []) {
    const qty = Number(t.qtyPerYear);
    if (!Number.isFinite(qty) || qty <= 0) continue;

    const { best, matchScore } = bestMapForTarget(t, mapRows);

    const unitLower = normalizeLower(t.unit);
    const unitKnown = !!unitLower;

    if (!best) {
      // Unmapped target becomes "unassigned" for manual mapping.
      const key = "unassigned";
      const existing = byCrop.get(key) || {
        cropKey: key,
        cropName: "Unassigned (needs mapping)",
        crop: null,
        lines: [],
        freshEquivalentLbs: 0,
        confidence: 0,
      };

      existing.lines.push({
        targetId: t.id,
        targetName: t.name,
        targetUnit: t.unit,
        targetQty: qty,
        reason: "No keyword mapping match",
      });

      // We cannot convert to lbs without mapping, keep 0.
      byCrop.set(key, existing);
      continue;
    }

    const crop = getCrop(best.preferredCropKey, catalog);
    const catalogKnown = !!crop;

    // Convert provisioning unit -> fresh lbs.
    // If the provisioning unit itself is already "lb", we treat freshLbsPerTargetUnit=1.
    let freshPerUnit = Number(best.freshLbsPerTargetUnit);
    if (!Number.isFinite(freshPerUnit) || freshPerUnit <= 0) freshPerUnit = 1;

    if (
      unitLower === "lb" ||
      unitLower === "lbs" ||
      unitLower === "pound" ||
      unitLower === "pounds"
    ) {
      freshPerUnit = 1;
    }

    const freshLbs = qty * freshPerUnit * buffer;

    const confidence = computeConfidence({
      matchScore,
      unitKnown,
      catalogKnown,
      weights: a.confidence,
    });

    const existing = byCrop.get(best.preferredCropKey) || {
      cropKey: best.preferredCropKey,
      cropName: crop?.cropName || best.preferredCropKey,
      crop,
      lines: [],
      freshEquivalentLbs: 0,
      confidence: 0,
    };

    existing.freshEquivalentLbs += freshLbs;
    existing.confidence = Math.max(existing.confidence, confidence);
    existing.lines.push({
      targetId: t.id,
      targetName: t.name,
      targetUnit: t.unit,
      targetQty: qty,
      matchedOn: best.targetKeyMatch,
      freshLbsPerTargetUnit: freshPerUnit,
      freshEquivalentLbs: freshLbs,
      methodHint: best.methodHint || "",
      notes: t.notes || "",
    });

    byCrop.set(best.preferredCropKey, existing);
  }

  // Turn aggregated crop requirements into actionable planting targets.
  const rows = [];
  for (const [cropKey, bucket] of byCrop.entries()) {
    const crop = bucket.crop;
    if (!crop) {
      rows.push({
        id: uid("gt"),
        computedAt: meta.computedAt,
        sourceHash: "",
        cropKey,
        cropName: bucket.cropName,
        cropNameLower: normalizeLower(bucket.cropName),
        familyTargetUnit: "mixed",
        familyTargetQty: "",
        freshEquivalentLbs: round2(bucket.freshEquivalentLbs),
        plantsNeeded: 0,
        sqftNeeded: 0,
        seedCount: 0,
        seedPackets: 0,
        window: "—",
        d2m: 0,
        succession: 1,
        confidence: bucket.confidence,
        notes:
          "Map this provisioning line to a crop to compute planting needs.",
        tags: ["needs_mapping"],
        _lines: bucket.lines,
      });
      continue;
    }

    const freshNeed = bucket.freshEquivalentLbs;
    const yieldBasis = crop.yieldBasis;
    const yieldPer = Number(crop.yieldPerBasisLbs || 0);
    const succession = crop.successionRounds
      ? Number(crop.successionRounds)
      : Number(DEFAULT_ASSUMPTIONS.defaultSuccessionRounds || 1);
    const succ = Number.isFinite(succession) && succession > 0 ? succession : 1;

    let plantsNeeded = 0;
    let sqftNeeded = 0;

    if (yieldBasis === "plant") {
      // Divide by (yield per plant * succession rounds).
      plantsNeeded = yieldPer > 0 ? freshNeed / (yieldPer * succ) : 0;
      // Estimate sqft by spacing.
      const spacing = Number(crop.spacingSqftPerPlant || 0);
      sqftNeeded = spacing > 0 ? plantsNeeded * spacing : 0;
    } else {
      // sqft basis
      sqftNeeded = yieldPer > 0 ? freshNeed / (yieldPer * succ) : 0;
      plantsNeeded = 0; // not needed; depends on spacing, crop type
    }

    // Seed planning:
    // For plant-based crops: seeds ~ plants / germination / thinning
    // For sqft-based crops: approximate seeds from sqft and a default density.
    const germ = Number(crop.germinationRate || 0.85);
    const thin = Number(crop.thinningFactor || 1.2);
    const seedsPerPacket = Number(crop.seedsPerPacket || 0);

    let seedCount = 0;
    if (yieldBasis === "plant") {
      const p = Math.max(0, plantsNeeded);
      seedCount = germ > 0 ? (p / germ) * thin : p * thin;
    } else {
      // density seeds per sqft (rough): leafy greens high, beans moderate, onions high
      const density = guessSeedDensityPerSqft(crop.cropKey);
      const s = Math.max(0, sqftNeeded) * density;
      seedCount = germ > 0 ? (s / germ) * thin : s * thin;
    }

    const packets = computeSeedPackets({
      seedCount,
      seedsPerPacket,
      roundingMode: a.seedPacketsRounding,
      seedPacketMin: a.seedPacketMin || 1,
    });

    const window = (crop.windows || []).join(" • ") || "—";
    const d2m = Number(crop.d2m || 0);

    rows.push({
      id: uid("gt"),
      computedAt: meta.computedAt,
      sourceHash: "",
      cropKey,
      cropName: crop.cropName,
      cropNameLower: normalizeLower(crop.cropName),
      familyTargetUnit: "fresh_lbs_equivalent",
      familyTargetQty: round2(freshNeed),
      freshEquivalentLbs: round2(freshNeed),
      plantsNeeded: yieldBasis === "plant" ? round2(plantsNeeded) : 0,
      sqftNeeded: round2(sqftNeeded),
      seedCount: Math.ceil(seedCount),
      seedPackets: packets.seedPackets,
      window,
      d2m,
      succession: succ,
      confidence: bucket.confidence,
      notes: crop.notes || "",
      tags: [],
      _lines: bucket.lines,
    });
  }

  // Source hash (so you can tell if provisioning changed)
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
      map: a.provisioningToCropMap,
      catalog: a.cropCatalog.map((c) => ({
        cropKey: c.cropKey,
        yieldBasis: c.yieldBasis,
        yieldPerBasisLbs: c.yieldPerBasisLbs,
        spacingSqftPerPlant: c.spacingSqftPerPlant,
        seedsPerPacket: c.seedsPerPacket,
        germinationRate: c.germinationRate,
        thinningFactor: c.thinningFactor,
        d2m: c.d2m,
        windows: c.windows,
      })),
      defaultSuccessionRounds: a.defaultSuccessionRounds,
      rounding: a.seedPacketsRounding,
    },
  });

  for (const r of rows) r.sourceHash = sourceHash;

  return { meta: { ...meta, sourceHash }, rows };
}

function guessSeedDensityPerSqft(cropKey) {
  const k = normalizeLower(cropKey);
  if (k.includes("leafy") || k.includes("spinach") || k.includes("greens"))
    return 35;
  if (k.includes("onion")) return 45;
  if (k.includes("beans")) return 8;
  if (k.includes("corn")) return 2.5;
  if (k.includes("garlic")) return 1.2; // cloves-ish
  return 12;
}

/* -----------------------------------------------------------------------------
 * Provisioning targets: read from DB, or fall back to inventoryMeta if needed
 * --------------------------------------------------------------------------- */

async function loadProvisioningTargets(db) {
  // Preferred: homesteadProvisioningTargets table
  try {
    const arr = await db.homesteadProvisioningTargets.toArray();
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (e) {
    // ignore
  }

  // Optional fallback: inventoryMeta "homesteadProvisioningTargets"
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

async function loadAssumptions(db) {
  try {
    const rec = await db.homesteadGardenAssumptions.get("gardenAssumptions");
    if (rec?.value) return deepMerge(DEFAULT_ASSUMPTIONS, rec.value);
  } catch (e) {
    // ignore
  }
  return DEFAULT_ASSUMPTIONS;
}

async function saveAssumptions(db, assumptions) {
  await db.homesteadGardenAssumptions.put({
    key: "gardenAssumptions",
    value: assumptions,
    updatedAt: nowISO(),
  });
}

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

/* -----------------------------------------------------------------------------
 * Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerGardenTargetsPage() {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  const [assumptions, setAssumptions] = useState(DEFAULT_ASSUMPTIONS);

  const [provisioningTargets, setProvisioningTargets] = useState([]);
  const [computed, setComputed] = useState({ meta: null, rows: [] });

  const [filter, setFilter] = useState({
    q: "",
    window: "",
    minConfidence: "0",
  });
  const [expandedCropKey, setExpandedCropKey] = useState(null);

  const [toast, setToast] = useState(null);

  const [editAssumptionsOpen, setEditAssumptionsOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [draftTargetsText, setDraftTargetsText] = useState("");

  useEffect(() => {
    const db = getDb();
    dbRef.current = db;

    (async () => {
      try {
        // Probe
        await db.inventoryMeta.limit(1).toArray();
        const a = await loadAssumptions(db);
        setAssumptions(a);

        const targets = await loadProvisioningTargets(db);
        setProvisioningTargets(targets);

        setReady(true);
      } catch (e) {
        console.warn("[GardenTargets] init failed:", e);
        setDbError(
          "Garden targets storage isn’t available (IndexedDB blocked/unavailable)."
        );
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!ready || dbError) return;
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  function pushToast(message, kind = "info") {
    setToast({ message, kind, at: Date.now() });
    setTimeout(() => setToast(null), 2200);
  }

  async function reloadProvisioning() {
    const db = dbRef.current;
    if (!db || dbError) return;
    const targets = await loadProvisioningTargets(db);
    setProvisioningTargets(targets);
    pushToast("Provisioning targets reloaded.", "success");
  }

  function recompute() {
    const res = computeGardenTargets({ provisioningTargets, assumptions });
    setComputed(res);

    emitSSAEvent("ssa.hp.gardenTargets.computed", {
      source: PAGE_SOURCE,
      computedAt: res?.meta?.computedAt,
      sourceHash: res?.meta?.sourceHash,
      rowCount: res?.rows?.length || 0,
    });

    pushToast("Computed planting targets.", "success");
  }

  async function saveSnapshot() {
    const db = dbRef.current;
    if (!db || dbError) return;

    const res = computeGardenTargets({ provisioningTargets, assumptions });

    try {
      await db.transaction("rw", db.homesteadGardenTargets, async () => {
        // Replace existing snapshot with same sourceHash (keep only latest)
        await db.homesteadGardenTargets
          .where("sourceHash")
          .equals(res.meta.sourceHash)
          .delete();

        const rows = res.rows.map((r) => ({
          ...r,
          cropNameLower: normalizeLower(r.cropName),
        }));
        await db.homesteadGardenTargets.bulkPut(rows);
      });

      emitSSAEvent("ssa.hp.gardenTargets.saved", {
        source: PAGE_SOURCE,
        sourceHash: res.meta.sourceHash,
        computedAt: res.meta.computedAt,
        rowCount: res.rows.length,
      });

      setComputed(res);
      pushToast("Saved snapshot.", "success");
    } catch (e) {
      console.warn("[GardenTargets] saveSnapshot failed:", e);
      pushToast("Save failed.", "error");
    }
  }

  async function exportSnapshot() {
    const res = computeGardenTargets({ provisioningTargets, assumptions });
    downloadJSON(
      `ssa-garden-targets-${new Date().toISOString().slice(0, 10)}.json`,
      {
        type: "SSA_HomesteadPlanner_GardenTargets",
        version: 1,
        exportedAt: nowISO(),
        assumptions,
        provisioningTargets,
        computed: res,
      }
    );
    pushToast("Exported JSON.", "success");
  }

  async function importTargetsFromJSONOrCSV() {
    const db = dbRef.current;
    if (!db || dbError) return;

    const text = draftTargetsText.trim();
    if (!text) {
      pushToast("Paste JSON or CSV first.", "error");
      return;
    }

    // Try JSON first
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
          return;
        } catch (e) {
          console.warn("[GardenTargets] import JSON failed:", e);
          pushToast("Import failed.", "error");
          return;
        }
      }

      // If it contains computed snapshot, you can still store provisioning
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
    } catch (e) {
      console.warn("[GardenTargets] import CSV failed:", e);
      pushToast("Import failed.", "error");
    }
  }

  async function saveAssumptionsFromModal(nextAssumptions) {
    const db = dbRef.current;
    if (!db || dbError) return;

    try {
      await saveAssumptions(db, nextAssumptions);
      setAssumptions(nextAssumptions);
      setEditAssumptionsOpen(false);
      pushToast("Assumptions saved.", "success");
      // recompute using new assumptions
      const res = computeGardenTargets({
        provisioningTargets,
        assumptions: nextAssumptions,
      });
      setComputed(res);
    } catch (e) {
      console.warn("[GardenTargets] save assumptions failed:", e);
      pushToast("Save assumptions failed.", "error");
    }
  }

  const windowOptions = useMemo(() => {
    const set = new Set();
    for (const r of computed.rows || []) {
      const w = safeString(r.window);
      if (!w || w === "—") continue;
      set.add(w);
    }
    return ["", ...Array.from(set)];
  }, [computed.rows]);

  const filteredRows = useMemo(() => {
    const q = normalizeLower(filter.q);
    const minC = Number(filter.minConfidence || 0);

    return (computed.rows || []).filter((r) => {
      if (q) {
        const hay = `${normalizeLower(r.cropName)} ${normalizeLower(
          r.cropKey
        )} ${(r.tags || []).map(normalizeLower).join(" ")}`.trim();
        if (!hay.includes(q)) return false;
      }
      if (filter.window && safeString(r.window) !== filter.window) return false;
      if (Number.isFinite(minC) && minC > 0 && Number(r.confidence || 0) < minC)
        return false;
      return true;
    });
  }, [computed.rows, filter]);

  const summary = useMemo(() => {
    const rows = filteredRows || [];
    const totalSqft = rows.reduce(
      (sum, r) => sum + Number(r.sqftNeeded || 0),
      0
    );
    const totalPlants = rows.reduce(
      (sum, r) => sum + Number(r.plantsNeeded || 0),
      0
    );
    const seedPackets = rows.reduce(
      (sum, r) => sum + Number(r.seedPackets || 0),
      0
    );
    const freshLbs = rows.reduce(
      (sum, r) => sum + Number(r.freshEquivalentLbs || 0),
      0
    );

    return {
      totalSqft: round2(totalSqft),
      totalPlants: round2(totalPlants),
      seedPackets: Math.ceil(seedPackets),
      freshLbs: round2(freshLbs),
      count: rows.length,
    };
  }, [filteredRows]);

  const provisioningEmpty = provisioningTargets.length === 0;

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">
              Garden Targets
            </h1>
            <div className="text-sm opacity-80 mt-1">
              Planting targets derived from provisioning (preservation +
              storehouse goals).
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
            <Button onClick={recompute} title="Recompute planting targets">
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
            <div className="text-xs font-bold opacity-70">
              Total fresh equivalent
            </div>
            <div className="text-2xl font-black mt-1">
              {summary.freshLbs.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">
              lbs to harvest (after buffer)
            </div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Bed area needed</div>
            <div className="text-2xl font-black mt-1">
              {summary.totalSqft.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">square feet (approx.)</div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Seed packets</div>
            <div className="text-2xl font-black mt-1">
              {summary.seedPackets.toLocaleString()}
            </div>
            <div className="text-xs opacity-70 mt-1">
              estimated packets to buy
            </div>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-5 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-5">
            <FieldLabel>Search crops</FieldLabel>
            <Input
              value={filter.q}
              onChange={(v) => setFilter((p) => ({ ...p, q: v }))}
              placeholder="tomato, beans, garlic…"
            />
          </div>
          <div className="md:col-span-4">
            <FieldLabel>Planting window</FieldLabel>
            <Select
              value={filter.window}
              onChange={(v) => setFilter((p) => ({ ...p, window: v }))}
              options={windowOptions.map((w) => ({
                value: w,
                label: w ? w : "All windows",
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
            <table className="min-w-[1100px] w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <Th>Crop</Th>
                  <Th>Window</Th>
                  <Th>Fresh lbs</Th>
                  <Th>Succession</Th>
                  <Th>Plants</Th>
                  <Th>Bed sqft</Th>
                  <Th>Seeds</Th>
                  <Th>Packets</Th>
                  <Th>D2M</Th>
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
                  const isExpanded = expandedCropKey === r.cropKey;
                  const needsMapping =
                    r.cropKey === "unassigned" ||
                    (r.tags || []).includes("needs_mapping");

                  return (
                    <React.Fragment key={r.id}>
                      <tr
                        className={cx(
                          "border-b border-gray-100",
                          needsMapping ? "bg-amber-50" : ""
                        )}
                      >
                        <Td>
                          <div className="font-bold">{r.cropName}</div>
                          <div className="text-xs opacity-70">{r.cropKey}</div>
                          {needsMapping ? (
                            <div className="mt-1">
                              <Badge tone="warn">Needs mapping</Badge>
                            </div>
                          ) : null}
                        </Td>
                        <Td className="text-xs">{r.window || "—"}</Td>
                        <Td>
                          <b>
                            {Number(r.freshEquivalentLbs || 0).toLocaleString()}
                          </b>
                        </Td>
                        <Td>{r.succession || 1}</Td>
                        <Td>
                          {r.plantsNeeded
                            ? round2(r.plantsNeeded).toLocaleString()
                            : "—"}
                        </Td>
                        <Td>
                          <b>{round2(r.sqftNeeded || 0).toLocaleString()}</b>
                        </Td>
                        <Td>{Number(r.seedCount || 0).toLocaleString()}</Td>
                        <Td>
                          <b>{Number(r.seedPackets || 0).toLocaleString()}</b>
                        </Td>
                        <Td>{r.d2m ? Number(r.d2m).toLocaleString() : "—"}</Td>
                        <Td>
                          <Badge tone={tone}>{Math.round(conf * 100)}%</Badge>
                        </Td>
                        <Td className="text-xs opacity-80 max-w-[320px]">
                          <div className="line-clamp-2" title={r.notes || ""}>
                            {r.notes || "—"}
                          </div>
                        </Td>
                        <Td>
                          <Button
                            variant="ghost"
                            onClick={() =>
                              setExpandedCropKey(isExpanded ? null : r.cropKey)
                            }
                          >
                            {isExpanded ? "Hide" : "Details"}
                          </Button>
                        </Td>
                      </tr>

                      {isExpanded ? (
                        <tr className="border-b border-gray-100 bg-white">
                          <td colSpan={12} className="p-4">
                            <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
                              <div className="lg:col-span-7 rounded-xl border border-gray-200 p-4">
                                <div className="font-bold text-sm">
                                  Provisioning lines feeding this crop
                                </div>
                                <div className="text-xs opacity-70 mt-1">
                                  (Each line converted to fresh lbs using
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
                                            year
                                            {ln.matchedOn ? (
                                              <>
                                                {" "}
                                                • matched: <b>{ln.matchedOn}</b>
                                              </>
                                            ) : null}
                                            {ln.methodHint ? (
                                              <>
                                                {" "}
                                                • method: <b>{ln.methodHint}</b>
                                              </>
                                            ) : null}
                                          </div>
                                        </div>
                                        {ln.freshEquivalentLbs ? (
                                          <div className="text-sm">
                                            <b>
                                              {round2(
                                                ln.freshEquivalentLbs
                                              ).toLocaleString()}
                                            </b>{" "}
                                            lbs fresh eq.
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
                                  Quick actions
                                </div>
                                <div className="text-xs opacity-70 mt-1">
                                  Adjust mappings/yields in Assumptions to
                                  improve accuracy.
                                </div>

                                <div className="mt-3 flex flex-col gap-2">
                                  <Button
                                    variant="ghost"
                                    onClick={() => setEditAssumptionsOpen(true)}
                                  >
                                    Edit assumptions for yields/mappings
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    onClick={() => {
                                      const payload = {
                                        cropKey: r.cropKey,
                                        cropName: r.cropName,
                                        computedAt:
                                          computed?.meta?.computedAt ||
                                          nowISO(),
                                        sourceHash:
                                          computed?.meta?.sourceHash || "",
                                        row: r,
                                      };
                                      downloadJSON(
                                        `ssa-garden-target-${r.cropKey}.json`,
                                        payload
                                      );
                                      pushToast(
                                        "Exported crop detail.",
                                        "success"
                                      );
                                    }}
                                  >
                                    Export crop detail
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    onClick={() => {
                                      setExpandedCropKey(null);
                                      pushToast("Collapsed.", "info");
                                    }}
                                  >
                                    Close details
                                  </Button>
                                </div>

                                <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs opacity-80">
                                  <div className="font-bold text-xs mb-1">
                                    How to improve confidence
                                  </div>
                                  <ul className="list-disc ml-5 space-y-1">
                                    <li>
                                      Add a more specific keyword mapping (e.g.,
                                      “tomato sauce quart”).
                                    </li>
                                    <li>
                                      Set yields closer to your garden reality
                                      (trellis, soil, variety).
                                    </li>
                                    <li>
                                      Use provisioning units that reflect real
                                      preserved containers (quart, pint, lb).
                                    </li>
                                  </ul>
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
                    <td colSpan={12} className="p-6 text-sm opacity-80">
                      No rows match your filters.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>

        {/* Modals */}
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
    {"name":"Tomato sauce (quarts)","category":"Canning","unit":"quart","qtyPerYear":48,"tags":["tomato","sauce"]}
  ]
}

CSV example:
Tomato sauce (quarts),Canning,quart,48,tomato|sauce,For winter meals
Green beans (lbs),Freezer,lb,30,beans|freezer,
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
  const [tab, setTab] = useState("overview"); // overview | catalog | mapping | raw
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
      title="Garden Assumptions (yields + mappings)"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs opacity-70">
            These settings control how provisioning converts into planting
            targets (buffer, yield, succession, seed math).
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
          variant={tab === "catalog" ? "solid" : "ghost"}
          onClick={() => setTab("catalog")}
        >
          Crop Catalog
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
              placeholder="0.15"
            />
            <div className="text-xs opacity-70 mt-1">
              Adds extra to cover loss, guests, gifts.
            </div>
          </div>

          <div className="md:col-span-4">
            <FieldLabel>Default succession rounds</FieldLabel>
            <Input
              type="number"
              value={String(draft.defaultSuccessionRounds ?? 2)}
              onChange={(v) => setField("defaultSuccessionRounds", Number(v))}
              placeholder="2"
            />
            <div className="text-xs opacity-70 mt-1">
              Used when crop doesn’t specify rounds.
            </div>
          </div>

          <div className="md:col-span-4">
            <FieldLabel>Seed packet rounding</FieldLabel>
            <Select
              value={draft.seedPacketsRounding || "up"}
              onChange={(v) => setField("seedPacketsRounding", v)}
              options={[
                { value: "up", label: "Round up" },
                { value: "nearest", label: "Nearest" },
              ]}
            />
            <div className="text-xs opacity-70 mt-1">
              How seed packets are estimated.
            </div>
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Household label</FieldLabel>
            <Input
              value={draft.householdLabel || ""}
              onChange={(v) => setField("householdLabel", v)}
              placeholder="Household"
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Region label</FieldLabel>
            <Input
              value={draft.regionLabel || ""}
              onChange={(v) => setField("regionLabel", v)}
              placeholder="US (generic windows)"
            />
          </div>

          <div className="md:col-span-12 rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs opacity-80">
            <div className="font-bold text-xs mb-2">
              What you’ll most likely customize
            </div>
            <ul className="list-disc ml-5 space-y-1">
              <li>
                Yield per plant/sqft (based on your varieties, trellis, soil,
                and weather).
              </li>
              <li>
                Fresh lbs per provisioning unit (e.g., “1 quart sauce” → how
                many lbs tomatoes in your process).
              </li>
              <li>
                Planting windows by your zone/region and whether you overwinter.
              </li>
            </ul>
          </div>
        </div>
      ) : null}

      {tab === "catalog" ? (
        <CropCatalogEditor draft={draft} setDraft={setDraft} />
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

function CropCatalogEditor({ draft, setDraft }) {
  const catalog = draft.cropCatalog || [];

  function update(idx, patch) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.cropCatalog = next.cropCatalog || [];
      next.cropCatalog[idx] = { ...next.cropCatalog[idx], ...patch };
      return next;
    });
  }

  function add() {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.cropCatalog = next.cropCatalog || [];
      next.cropCatalog.push({
        cropKey: `custom_${uid("crop").slice(-8)}`,
        cropName: "Custom crop",
        yieldBasis: "plant",
        yieldPerBasisLbs: 5,
        spacingSqftPerPlant: 2,
        seedsPerPacket: 25,
        germinationRate: 0.85,
        thinningFactor: 1.2,
        d2m: 70,
        windows: ["Spring"],
        notes: "",
      });
      return next;
    });
  }

  function remove(idx) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.cropCatalog = (next.cropCatalog || []).filter((_, i) => i !== idx);
      return next;
    });
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-bold">Crop catalog</div>
          <div className="text-xs opacity-70 mt-1">
            Yields + seed math are driven by these fields.
          </div>
        </div>
        <Button variant="ghost" onClick={add}>
          + Add crop
        </Button>
      </div>

      <div className="mt-4 space-y-4">
        {catalog.map((c, idx) => (
          <div
            key={c.cropKey}
            className="rounded-2xl border border-gray-200 p-4"
          >
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="font-black">{c.cropName}</div>
                <div className="text-xs opacity-70">{c.cropKey}</div>
              </div>
              <Button variant="danger" onClick={() => remove(idx)}>
                Remove
              </Button>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-6">
                <FieldLabel>Name</FieldLabel>
                <Input
                  value={c.cropName || ""}
                  onChange={(v) => update(idx, { cropName: v })}
                />
              </div>

              <div className="md:col-span-6">
                <FieldLabel>Key</FieldLabel>
                <Input
                  value={c.cropKey || ""}
                  onChange={(v) => update(idx, { cropKey: v })}
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Yield basis</FieldLabel>
                <Select
                  value={c.yieldBasis || "plant"}
                  onChange={(v) => update(idx, { yieldBasis: v })}
                  options={[
                    { value: "plant", label: "per plant" },
                    { value: "sqft", label: "per sqft" },
                  ]}
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Yield lbs</FieldLabel>
                <Input
                  type="number"
                  value={String(c.yieldPerBasisLbs ?? "")}
                  onChange={(v) => update(idx, { yieldPerBasisLbs: Number(v) })}
                  placeholder="e.g., 12"
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Sqft per plant</FieldLabel>
                <Input
                  type="number"
                  value={String(c.spacingSqftPerPlant ?? "")}
                  onChange={(v) =>
                    update(idx, {
                      spacingSqftPerPlant: v === "" ? null : Number(v),
                    })
                  }
                  placeholder="(plant basis only)"
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Days to maturity</FieldLabel>
                <Input
                  type="number"
                  value={String(c.d2m ?? "")}
                  onChange={(v) => update(idx, { d2m: Number(v) })}
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Seeds/packet</FieldLabel>
                <Input
                  type="number"
                  value={String(c.seedsPerPacket ?? "")}
                  onChange={(v) => update(idx, { seedsPerPacket: Number(v) })}
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Germination</FieldLabel>
                <Input
                  type="number"
                  value={String(c.germinationRate ?? "")}
                  onChange={(v) => update(idx, { germinationRate: Number(v) })}
                  placeholder="0.85"
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Thinning factor</FieldLabel>
                <Input
                  type="number"
                  value={String(c.thinningFactor ?? "")}
                  onChange={(v) => update(idx, { thinningFactor: Number(v) })}
                  placeholder="1.2"
                />
              </div>

              <div className="md:col-span-12">
                <FieldLabel>Planting windows (separate with |)</FieldLabel>
                <Input
                  value={Array.isArray(c.windows) ? c.windows.join(" | ") : ""}
                  onChange={(v) =>
                    update(idx, {
                      windows: v
                        .split("|")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder="Early Spring | Fall"
                />
              </div>

              <div className="md:col-span-12">
                <FieldLabel>Notes</FieldLabel>
                <Textarea
                  value={c.notes || ""}
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
  const mapRows = draft.provisioningToCropMap || [];
  const crops = (draft.cropCatalog || []).map((c) => ({
    value: c.cropKey,
    label: `${c.cropName} (${c.cropKey})`,
  }));

  function update(idx, patch) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.provisioningToCropMap = next.provisioningToCropMap || [];
      next.provisioningToCropMap[idx] = {
        ...next.provisioningToCropMap[idx],
        ...patch,
      };
      return next;
    });
  }

  function add() {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.provisioningToCropMap = next.provisioningToCropMap || [];
      next.provisioningToCropMap.push({
        targetKeyMatch: "new keyword",
        freshLbsPerTargetUnit: 1,
        preferredCropKey:
          (next.cropCatalog && next.cropCatalog[0]?.cropKey) ||
          "tomato_paste_sauce",
        methodHint: "",
      });
      return next;
    });
  }

  function remove(idx) {
    setDraft((prev) => {
      const next = JSON.parse(JSON.stringify(prev));
      next.provisioningToCropMap = (next.provisioningToCropMap || []).filter(
        (_, i) => i !== idx
      );
      return next;
    });
  }

  return (
    <div className="mt-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="font-bold">Keyword mapping</div>
          <div className="text-xs opacity-70 mt-1">
            Matches provisioning target text → crop + fresh conversion lbs per
            unit.
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
                  placeholder="tomato sauce"
                />
              </div>

              <div className="md:col-span-3">
                <FieldLabel>Fresh lbs per 1 target unit</FieldLabel>
                <Input
                  type="number"
                  value={String(m.freshLbsPerTargetUnit ?? "")}
                  onChange={(v) =>
                    update(idx, { freshLbsPerTargetUnit: Number(v) })
                  }
                  placeholder="3"
                />
              </div>

              <div className="md:col-span-4">
                <FieldLabel>Crop</FieldLabel>
                <Select
                  value={m.preferredCropKey || ""}
                  onChange={(v) => update(idx, { preferredCropKey: v })}
                  options={[{ value: "", label: "Select crop…" }, ...crops]}
                />
              </div>

              <div className="md:col-span-1">
                <FieldLabel>Hint</FieldLabel>
                <Input
                  value={m.methodHint || ""}
                  onChange={(v) => update(idx, { methodHint: v })}
                  placeholder="canning"
                />
              </div>
            </div>

            <div className="text-xs opacity-70 mt-2">
              Tip: use specific keywords like <b>“tomato sauce quart”</b> to
              avoid catching unrelated tomato items.
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

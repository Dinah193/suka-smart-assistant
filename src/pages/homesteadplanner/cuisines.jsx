// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\cuisines.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Cuisines (Profile selection + rotation)
 * -----------------------------------------------------------------------------
 * What this page does
 *  - Lets users select cuisine profiles from a local catalog (Dexie).
 *  - Builds a rotation plan (4–12 weeks) with configurable:
 *      • weights (how often each cuisine appears)
 *      • max streak (avoid repeating same cuisine too many weeks in a row)
 *      • “locked weeks” (force a cuisine for a specific week)
 *      • season / tags filter (optional)
 *  - Saves the rotation snapshot to Dexie and exports as JSON.
 *
 * Storage (Dexie)
 *  - cuisineProfiles:           { id, name, nameLower, tags[], seasonTags[], status, createdAt, updatedAt, ... }
 *  - cuisineUserPrefs:          { key:"cuisineRotationPrefs", value:{...}, updatedAt }
 *  - cuisineRotations:          { id, title, startISO, weeks, plan[], rules, selectedProfileIds, sourceHash, createdAt, updatedAt }
 *
 * Compatibility notes
 *  - This file is browser-safe (no Node imports).
 *  - If you already have a global SSA Dexie db, you can swap getDb() to reuse it.
 *
 * Emits events
 *  - ssa.hp.cuisines.rotation.generated
 *  - ssa.hp.cuisines.rotation.saved
 *  - ssa.hp.cuisines.profile.toggled
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * DB
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/cuisines";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1";
const DB_VERSION = 6;

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

  // v4 animal targets
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

  // v6 keep same stores (version bump allows future-safe upgrades)
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
  });

  _dbSingleton = db;
  return db;
}

/* -----------------------------------------------------------------------------
 * Defaults
 * --------------------------------------------------------------------------- */

const DEFAULT_SEASONS = ["winter", "spring", "summer", "fall", "all"];
const DEFAULT_PREFS = {
  version: 1,
  // selection
  selectedProfileIds: [],
  // per profile weight: id -> number (1..10)
  weightsById: {},
  // rotation rules
  startISO: new Date().toISOString().slice(0, 10),
  weeks: 8,
  maxStreak: 1,
  spacingBias: 0.65, // 0..1 (higher = spread cuisines out more)
  allowBackToBackIfOnlyOne: true,
  // optional filters
  season: "all",
  requiredTags: [],
  excludedTags: [],
  // locked weeks: weekIndex(1-based) -> profileId
  lockedWeeks: {},
  // naming
  rotationTitleTemplate: "Cuisine Rotation",
};

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
function startOfWeekISO(startISO, weekIndex1) {
  // weekIndex1 is 1-based
  const d = new Date(`${startISO}T00:00:00`);
  const out = new Date(
    d.getTime() + (weekIndex1 - 1) * 7 * 24 * 60 * 60 * 1000
  );
  return out.toISOString().slice(0, 10);
}

/* -----------------------------------------------------------------------------
 * Seed profiles (only used if cuisineProfiles is empty)
 * --------------------------------------------------------------------------- */

const SEED_CUISINE_PROFILES = [
  {
    id: "c_aai",
    name: "AAI (African American Israelite)",
    tags: ["aai", "comfort", "heritage", "family"],
    seasonTags: ["all"],
    status: "active",
    notes:
      "Primary SSA house style—blend of Southern + West African + Mediterranean rhythms.",
  },
  {
    id: "c_west_african",
    name: "West African",
    tags: ["west-african", "stew", "spice-forward"],
    seasonTags: ["all"],
    status: "active",
  },
  {
    id: "c_mediterranean",
    name: "Mediterranean",
    tags: ["mediterranean", "fresh", "olive-oil"],
    seasonTags: ["spring", "summer", "fall"],
    status: "active",
  },
  {
    id: "c_caribbean",
    name: "Caribbean",
    tags: ["caribbean", "island", "spice"],
    seasonTags: ["spring", "summer"],
    status: "active",
  },
  {
    id: "c_southern",
    name: "Southern",
    tags: ["southern", "comfort", "slow-cook"],
    seasonTags: ["fall", "winter", "all"],
    status: "active",
  },
  {
    id: "c_middle_eastern",
    name: "Middle Eastern",
    tags: ["middle-eastern", "grill", "herbs"],
    seasonTags: ["all"],
    status: "active",
  },
];

/* -----------------------------------------------------------------------------
 * Dexie I/O
 * --------------------------------------------------------------------------- */

async function ensureSeedProfiles(db) {
  const count = await db.cuisineProfiles.count();
  if (count > 0) return;

  const now = nowISO();
  const rows = SEED_CUISINE_PROFILES.map((p) => ({
    ...p,
    nameLower: normalizeLower(p.name),
    createdAt: now,
    updatedAt: now,
    tags: uniq(p.tags || []),
    seasonTags: uniq(p.seasonTags || ["all"]),
  }));

  try {
    await db.cuisineProfiles.bulkPut(rows);
  } catch (e) {
    console.warn("[Cuisines] seed failed:", e);
  }
}

async function loadProfiles(db) {
  try {
    const rows = await db.cuisineProfiles.toArray();
    return (rows || []).map(normalizeProfileRow);
  } catch (e) {
    console.warn("[Cuisines] loadProfiles failed:", e);
    return [];
  }
}

function normalizeProfileRow(p) {
  const id = safeString(p?.id).trim() || uid("cuisine");
  const name = safeString(p?.name).trim() || "Cuisine";
  const tags = uniq(
    (p?.tags || []).map((t) => safeString(t).trim()).filter(Boolean)
  );
  const seasonTags = uniq(
    (p?.seasonTags || ["all"]).map((t) => normalizeLower(t)).filter(Boolean)
  );
  return {
    id,
    name,
    nameLower: normalizeLower(name),
    tags,
    seasonTags: seasonTags.length ? seasonTags : ["all"],
    status: p?.status || "active",
    notes: safeString(p?.notes || ""),
    createdAt: p?.createdAt || nowISO(),
    updatedAt: p?.updatedAt || nowISO(),
  };
}

async function loadPrefs(db) {
  try {
    const rec = await db.cuisineUserPrefs.get("cuisineRotationPrefs");
    if (rec?.value) return deepMerge(DEFAULT_PREFS, rec.value);
  } catch (e) {
    // ignore
  }
  return DEFAULT_PREFS;
}

async function savePrefs(db, prefs) {
  await db.cuisineUserPrefs.put({
    key: "cuisineRotationPrefs",
    value: prefs,
    updatedAt: nowISO(),
  });
}

async function listRotations(db, limit = 12) {
  try {
    const rows = await db.cuisineRotations
      .orderBy("updatedAt")
      .reverse()
      .limit(limit)
      .toArray();
    return rows || [];
  } catch (e) {
    console.warn("[Cuisines] listRotations failed:", e);
    return [];
  }
}

async function saveRotation(db, rotation) {
  await db.cuisineRotations.put(rotation);
}

async function deleteRotation(db, id) {
  await db.cuisineRotations.delete(id);
}

/* -----------------------------------------------------------------------------
 * Deep merge
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

/* -----------------------------------------------------------------------------
 * Rotation engine
 * --------------------------------------------------------------------------- */

/**
 * Weighted rotation with anti-streak + spacing bias.
 * Input:
 *  - profiles[] (already filtered to eligible)
 *  - selectedProfileIds[] subset of eligible
 *  - weightsById {id->w}
 *  - weeks
 *  - lockedWeeks {weekIndex1->profileId}
 *  - maxStreak
 *  - spacingBias (0..1)
 *
 * Output:
 *  - plan[] length=weeks, each:
 *      { weekIndex, weekStartISO, profileId, profileName, tags, seasonTags, reason, locked }
 */
function generateRotationPlan({
  profiles,
  selectedProfileIds,
  weightsById,
  weeks,
  startISO,
  lockedWeeks,
  maxStreak,
  spacingBias,
  allowBackToBackIfOnlyOne,
}) {
  const eligible = (profiles || []).filter((p) =>
    selectedProfileIds.includes(p.id)
  );

  // if nothing selected, fallback to all eligible passed in
  const pool = eligible.length ? eligible : profiles || [];

  const idToProfile = new Map(pool.map((p) => [p.id, p]));

  // sanity: locked weeks that reference unavailable profile -> ignore
  const locked = {};
  for (const k of Object.keys(lockedWeeks || {})) {
    const wk = Number(k);
    const pid = lockedWeeks[k];
    if (Number.isFinite(wk) && wk >= 1 && wk <= weeks && idToProfile.has(pid)) {
      locked[String(wk)] = pid;
    }
  }

  const plan = [];
  const lastUsedAt = new Map(); // profileId -> last weekIndex used
  let streakId = null;
  let streakCount = 0;

  // helper: weighted random-ish pick using deterministic "score" (not RNG)
  // We avoid Math.random to keep stable when inputs unchanged by using a simple hash score per week.
  function deterministicPick(candidates, weekIndex) {
    const scored = candidates.map((p) => {
      const w = clamp(Number(weightsById?.[p.id] ?? 1), 0.1, 20);
      const last = lastUsedAt.get(p.id) ?? -9999;
      const gap = weekIndex - last; // larger is better
      const spacingScore =
        clamp(gap / 6, 0, 1) * clamp(Number(spacingBias || 0), 0, 1); // normalize
      const base = w;

      // streak penalty
      const streakPenalty = streakId === p.id ? 0.0001 : 1;

      // deterministic tie-breaker: hash of (weekIndex + id)
      const tie = detFloat(`${weekIndex}|${p.id}`);

      // composite score
      const score =
        base * (1 + spacingScore) * streakPenalty * (0.85 + tie * 0.3);
      return { p, score, w, gap, spacingScore };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  for (let i = 1; i <= weeks; i++) {
    const weekStartISO = startOfWeekISO(startISO, i);

    // locked week
    const lockedId = locked[String(i)];
    if (lockedId) {
      const p = idToProfile.get(lockedId);
      plan.push({
        weekIndex: i,
        weekStartISO,
        profileId: p.id,
        profileName: p.name,
        tags: p.tags,
        seasonTags: p.seasonTags,
        reason: "Locked week",
        locked: true,
      });
      lastUsedAt.set(p.id, i);
      // update streak
      if (streakId === p.id) streakCount += 1;
      else {
        streakId = p.id;
        streakCount = 1;
      }
      continue;
    }

    const candidatesRaw = pool.slice();

    // anti-streak filtering
    let candidates = candidatesRaw;

    if (pool.length === 1 && allowBackToBackIfOnlyOne) {
      // do nothing
    } else if (maxStreak <= 0) {
      // maxStreak=0 means "never repeat adjacent"
      candidates = candidates.filter((p) => p.id !== streakId);
    } else if (streakId && streakCount >= maxStreak) {
      candidates = candidates.filter((p) => p.id !== streakId);
    }

    // if candidates became empty, fall back to full pool
    if (!candidates.length) candidates = candidatesRaw;

    const pick = deterministicPick(candidates, i);
    const p = pick?.p || candidates[0];

    plan.push({
      weekIndex: i,
      weekStartISO,
      profileId: p.id,
      profileName: p.name,
      tags: p.tags,
      seasonTags: p.seasonTags,
      reason: `Auto (w=${round2(pick?.w ?? 1)}, gap=${pick?.gap ?? "—"})`,
      locked: false,
    });

    lastUsedAt.set(p.id, i);

    // update streak
    if (streakId === p.id) streakCount += 1;
    else {
      streakId = p.id;
      streakCount = 1;
    }
  }

  return plan;
}

function detFloat(seed) {
  // deterministic [0..1)
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const x = (h >>> 0) / 4294967296;
  return x;
}

/* -----------------------------------------------------------------------------
 * Filtering eligible profiles by season + tags
 * --------------------------------------------------------------------------- */

function profileMatchesFilters(
  profile,
  { season, requiredTags, excludedTags }
) {
  const s = normalizeLower(season || "all");
  const pSeasons = (profile.seasonTags || []).map(normalizeLower);
  const seasonOk =
    s === "all" || pSeasons.includes("all") || pSeasons.includes(s);

  const req = (requiredTags || []).map(normalizeLower).filter(Boolean);
  const exc = (excludedTags || []).map(normalizeLower).filter(Boolean);
  const ptags = (profile.tags || []).map(normalizeLower);

  const requiredOk = req.length ? req.every((t) => ptags.includes(t)) : true;
  const excludedOk = exc.length ? !exc.some((t) => ptags.includes(t)) : true;

  return (
    seasonOk &&
    requiredOk &&
    excludedOk &&
    (profile.status || "active") !== "archived"
  );
}

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
 * Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerCuisinesPage() {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  const [profiles, setProfiles] = useState([]);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);

  const [rotationPreview, setRotationPreview] = useState(null);
  const [savedRotations, setSavedRotations] = useState([]);

  const [ui, setUi] = useState({
    q: "",
    showOnlySelected: false,
  });

  const [toast, setToast] = useState(null);

  const [editModalOpen, setEditModalOpen] = useState(false);
  const [importExportOpen, setImportExportOpen] = useState(false);

  useEffect(() => {
    const db = getDb();
    dbRef.current = db;

    (async () => {
      try {
        // touch IDB
        await db.inventoryMeta.limit(1).toArray();
        await ensureSeedProfiles(db);

        const [p, pref, rot] = await Promise.all([
          loadProfiles(db),
          loadPrefs(db),
          listRotations(db, 12),
        ]);
        const normalizedPrefs = sanitizePrefs(pref, p);

        setProfiles(p);
        setPrefs(normalizedPrefs);
        setSavedRotations(rot);

        // initial preview
        const preview = buildRotationPreview(p, normalizedPrefs);
        setRotationPreview(preview);

        setReady(true);
      } catch (e) {
        console.warn("[Cuisines] init failed:", e);
        setDbError(
          "Cuisine storage isn’t available (IndexedDB blocked/unavailable)."
        );
        setReady(true);
      }
    })();
  }, []);

  function pushToast(message, kind = "info") {
    setToast({ message, kind, at: Date.now() });
    setTimeout(() => setToast(null), 2200);
  }

  const eligibleProfiles = useMemo(() => {
    const f = {
      season: prefs.season,
      requiredTags: prefs.requiredTags,
      excludedTags: prefs.excludedTags,
    };
    return (profiles || []).filter((p) => profileMatchesFilters(p, f));
  }, [profiles, prefs.season, prefs.requiredTags, prefs.excludedTags]);

  const selectedSet = useMemo(
    () => new Set(prefs.selectedProfileIds || []),
    [prefs.selectedProfileIds]
  );

  const visibleProfiles = useMemo(() => {
    const q = normalizeLower(ui.q);
    let list = eligibleProfiles;

    if (ui.showOnlySelected) list = list.filter((p) => selectedSet.has(p.id));

    if (q) {
      list = list.filter((p) => {
        const hay = `${normalizeLower(p.name)} ${(p.tags || [])
          .map(normalizeLower)
          .join(" ")} ${(p.seasonTags || []).join(" ")}`.trim();
        return hay.includes(q);
      });
    }

    // stable sort: selected first, then by name
    list = list.slice().sort((a, b) => {
      const as = selectedSet.has(a.id) ? 0 : 1;
      const bs = selectedSet.has(b.id) ? 0 : 1;
      if (as !== bs) return as - bs;
      return (a.nameLower || "").localeCompare(b.nameLower || "");
    });

    return list;
  }, [eligibleProfiles, ui.q, ui.showOnlySelected, selectedSet]);

  const stats = useMemo(() => {
    const selectedEligible = eligibleProfiles.filter((p) =>
      selectedSet.has(p.id)
    );
    const selectedAll = (prefs.selectedProfileIds || []).length;
    const totalEligible = eligibleProfiles.length;

    const weights = prefs.weightsById || {};
    const totalWeight = selectedEligible.reduce(
      (sum, p) => sum + clamp(Number(weights[p.id] ?? 1), 0.1, 20),
      0
    );

    return {
      selectedEligible: selectedEligible.length,
      selectedAll,
      totalEligible,
      totalWeight: round2(totalWeight),
    };
  }, [
    eligibleProfiles,
    prefs.selectedProfileIds,
    prefs.weightsById,
    selectedSet,
  ]);

  function updatePrefs(patch) {
    setPrefs((prev) => {
      const next = deepMerge(prev, patch);
      return next;
    });
  }

  async function persistPrefs(nextPrefs) {
    const db = dbRef.current;
    if (!db || dbError) return;

    try {
      await savePrefs(db, nextPrefs);
    } catch (e) {
      console.warn("[Cuisines] savePrefs failed:", e);
      pushToast("Saving prefs failed.", "error");
    }
  }

  function toggleProfile(profileId) {
    setPrefs((prev) => {
      const cur = new Set(prev.selectedProfileIds || []);
      const willSelect = !cur.has(profileId);
      if (willSelect) cur.add(profileId);
      else cur.delete(profileId);

      const next = { ...prev, selectedProfileIds: Array.from(cur) };

      emitSSAEvent("ssa.hp.cuisines.profile.toggled", {
        source: PAGE_SOURCE,
        profileId,
        selected: willSelect,
      });

      // save shortly
      queueMicrotask(() => persistPrefs(next));
      return next;
    });
  }

  function setWeight(profileId, weight) {
    const w = clamp(Number(weight || 1), 0.1, 20);

    setPrefs((prev) => {
      const next = { ...prev, weightsById: { ...(prev.weightsById || {}) } };
      next.weightsById[profileId] = w;
      queueMicrotask(() => persistPrefs(next));
      return next;
    });
  }

  function autoSelectAllEligible() {
    const ids = eligibleProfiles.map((p) => p.id);
    const next = { ...prefs, selectedProfileIds: ids };
    setPrefs(next);
    persistPrefs(next);
    pushToast("Selected all eligible cuisines.", "success");
  }

  function clearSelection() {
    const next = { ...prefs, selectedProfileIds: [] };
    setPrefs(next);
    persistPrefs(next);
    pushToast("Selection cleared.", "success");
  }

  function regeneratePreview() {
    const preview = buildRotationPreview(profiles, prefs);
    setRotationPreview(preview);

    emitSSAEvent("ssa.hp.cuisines.rotation.generated", {
      source: PAGE_SOURCE,
      startISO: prefs.startISO,
      weeks: prefs.weeks,
      selectedCount: (prefs.selectedProfileIds || []).length,
      sourceHash: preview?.sourceHash,
    });

    pushToast("Rotation generated.", "success");
  }

  async function saveRotationSnapshot() {
    const db = dbRef.current;
    if (!db || dbError) return;

    const preview = buildRotationPreview(profiles, prefs);
    setRotationPreview(preview);

    const title = buildRotationTitle(prefs);

    const rotation = {
      id: uid("rot"),
      title,
      titleLower: normalizeLower(title),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      startISO: prefs.startISO,
      weeks: prefs.weeks,
      rules: {
        maxStreak: prefs.maxStreak,
        spacingBias: prefs.spacingBias,
        season: prefs.season,
        requiredTags: prefs.requiredTags,
        excludedTags: prefs.excludedTags,
        lockedWeeks: prefs.lockedWeeks,
      },
      selectedProfileIds: prefs.selectedProfileIds,
      weightsById: prefs.weightsById,
      plan: preview.plan,
      sourceHash: preview.sourceHash,
      source: PAGE_SOURCE,
      version: 1,
    };

    try {
      await saveRotation(db, rotation);
      const rot = await listRotations(db, 12);
      setSavedRotations(rot);

      emitSSAEvent("ssa.hp.cuisines.rotation.saved", {
        source: PAGE_SOURCE,
        rotationId: rotation.id,
        sourceHash: rotation.sourceHash,
        weeks: rotation.weeks,
      });

      pushToast("Saved rotation.", "success");
    } catch (e) {
      console.warn("[Cuisines] saveRotation failed:", e);
      pushToast("Save failed.", "error");
    }
  }

  function exportCurrent() {
    const preview = buildRotationPreview(profiles, prefs);
    downloadJSON(
      `ssa-cuisine-rotation-${new Date().toISOString().slice(0, 10)}.json`,
      {
        type: "SSA_CuisineRotation",
        version: 1,
        exportedAt: nowISO(),
        prefs,
        preview,
        profiles,
      }
    );
    pushToast("Exported JSON.", "success");
  }

  async function refreshSavedRotations() {
    const db = dbRef.current;
    if (!db || dbError) return;
    const rot = await listRotations(db, 12);
    setSavedRotations(rot);
  }

  async function removeRotation(id) {
    const db = dbRef.current;
    if (!db || dbError) return;

    try {
      await deleteRotation(db, id);
      await refreshSavedRotations();
      pushToast("Deleted rotation.", "success");
    } catch (e) {
      console.warn("[Cuisines] deleteRotation failed:", e);
      pushToast("Delete failed.", "error");
    }
  }

  async function applyRotation(r) {
    // Applies saved rotation rules/selection back into prefs (does NOT overwrite profile catalog)
    const next = sanitizePrefs(
      deepMerge(prefs, {
        selectedProfileIds: r.selectedProfileIds || [],
        weightsById: r.weightsById || {},
        startISO: r.startISO || prefs.startISO,
        weeks: r.weeks || prefs.weeks,
        maxStreak: r.rules?.maxStreak ?? prefs.maxStreak,
        spacingBias: r.rules?.spacingBias ?? prefs.spacingBias,
        season: r.rules?.season ?? prefs.season,
        requiredTags: r.rules?.requiredTags ?? prefs.requiredTags,
        excludedTags: r.rules?.excludedTags ?? prefs.excludedTags,
        lockedWeeks: r.rules?.lockedWeeks ?? prefs.lockedWeeks,
      }),
      profiles
    );

    setPrefs(next);
    await persistPrefs(next);
    setRotationPreview(buildRotationPreview(profiles, next));
    pushToast("Loaded rotation settings.", "success");
  }

  const canGenerate = useMemo(() => {
    const selectedEligibleCount = eligibleProfiles.filter((p) =>
      selectedSet.has(p.id)
    ).length;
    return selectedEligibleCount > 0 || eligibleProfiles.length > 0;
  }, [eligibleProfiles, selectedSet]);

  const weekOptions = useMemo(
    () =>
      [4, 6, 8, 10, 12].map((w) => ({
        value: String(w),
        label: `${w} weeks`,
      })),
    []
  );

  const maxStreakOptions = useMemo(
    () => [
      { value: "0", label: "No back-to-back (0)" },
      { value: "1", label: "Max 1 week streak" },
      { value: "2", label: "Max 2 week streak" },
      { value: "3", label: "Max 3 week streak" },
    ],
    []
  );

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">Cuisines</h1>
            <div className="text-sm opacity-80 mt-1">
              Select cuisine profiles and generate a weekly rotation.
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" onClick={() => setEditModalOpen(true)}>
              Edit Rules
            </Button>
            <Button variant="ghost" onClick={() => setImportExportOpen(true)}>
              Import/Export
            </Button>
            <Button
              variant="ghost"
              onClick={exportCurrent}
              title="Export profiles + prefs + rotation preview"
            >
              Export
            </Button>
            <Button
              onClick={regeneratePreview}
              disabled={!canGenerate}
              title="Generate rotation preview"
            >
              Generate
            </Button>
            <Button
              onClick={saveRotationSnapshot}
              disabled={!canGenerate}
              title="Save this rotation snapshot"
            >
              Save Rotation
            </Button>
          </div>
        </div>

        {dbError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="font-bold text-red-800">Storage unavailable</div>
            <div className="text-red-800 mt-1">{dbError}</div>
          </div>
        ) : null}

        {/* Summary cards */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">
              Eligible cuisines
            </div>
            <div className="text-2xl font-black mt-1">
              {stats.totalEligible}
            </div>
            <div className="text-xs opacity-70 mt-1">
              Matches current season/tags filter.
            </div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">
              Selected (eligible)
            </div>
            <div className="text-2xl font-black mt-1">
              {stats.selectedEligible}
            </div>
            <div className="text-xs opacity-70 mt-1">
              Total selected: <b>{stats.selectedAll}</b>
            </div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Rotation length</div>
            <div className="text-2xl font-black mt-1">{prefs.weeks}</div>
            <div className="text-xs opacity-70 mt-1">
              weeks starting {prefs.startISO}
            </div>
          </div>

          <div className="lg:col-span-3 rounded-2xl border border-gray-200 p-4">
            <div className="text-xs font-bold opacity-70">Total weight</div>
            <div className="text-2xl font-black mt-1">{stats.totalWeight}</div>
            <div className="text-xs opacity-70 mt-1">
              Higher = appears more often.
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-5 rounded-2xl border border-gray-200 p-4">
            <div className="font-bold">Selection</div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-7">
                <FieldLabel>Search</FieldLabel>
                <Input
                  value={ui.q}
                  onChange={(v) => setUi((p) => ({ ...p, q: v }))}
                  placeholder="aai, west-african, mediterranean…"
                />
              </div>
              <div className="md:col-span-5">
                <FieldLabel>View</FieldLabel>
                <Select
                  value={ui.showOnlySelected ? "selected" : "all"}
                  onChange={(v) =>
                    setUi((p) => ({ ...p, showOnlySelected: v === "selected" }))
                  }
                  options={[
                    { value: "all", label: "All eligible" },
                    { value: "selected", label: "Selected only" },
                  ]}
                />
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <Button variant="ghost" onClick={autoSelectAllEligible}>
                Select all eligible
              </Button>
              <Button variant="ghost" onClick={clearSelection}>
                Clear selection
              </Button>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 overflow-hidden">
              <div className="max-h-[380px] overflow-auto">
                {ready && !dbError && visibleProfiles.length === 0 ? (
                  <div className="p-4 text-sm opacity-80">
                    No cuisines match your filters.
                  </div>
                ) : (
                  <div className="divide-y divide-gray-100">
                    {visibleProfiles.map((p) => {
                      const selected = selectedSet.has(p.id);
                      const w = clamp(
                        Number(prefs.weightsById?.[p.id] ?? 1),
                        0.1,
                        20
                      );

                      return (
                        <div
                          key={p.id}
                          className="p-3 flex items-start justify-between gap-3"
                        >
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => toggleProfile(p.id)}
                              className="mt-1 h-4 w-4"
                            />
                            <div className="min-w-0">
                              <div className="font-bold">{p.name}</div>
                              <div className="text-xs opacity-70 mt-1">
                                <span className="mr-2">
                                  Seasons:{" "}
                                  <b>{(p.seasonTags || ["all"]).join(", ")}</b>
                                </span>
                                <span>
                                  Tags:{" "}
                                  <b>{(p.tags || []).join(", ") || "—"}</b>
                                </span>
                              </div>
                              {p.notes ? (
                                <div className="text-xs opacity-80 mt-1">
                                  {p.notes}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <div className="w-32">
                            <FieldLabel>Weight</FieldLabel>
                            <Input
                              type="number"
                              value={String(w)}
                              onChange={(v) => setWeight(p.id, v)}
                              className={!selected ? "opacity-60" : ""}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 rounded-2xl border border-gray-200 p-4">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div>
                <div className="font-bold">Rotation preview</div>
                <div className="text-xs opacity-70 mt-1">
                  Uses selected cuisines (eligible) with weights + anti-streak
                  rules. Lock specific weeks if needed.
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => setEditModalOpen(true)}>
                  Edit rules
                </Button>
                <Button onClick={regeneratePreview} disabled={!canGenerate}>
                  Generate
                </Button>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <FieldLabel>Start date</FieldLabel>
                <Input
                  type="date"
                  value={prefs.startISO}
                  onChange={(v) => {
                    const next = { ...prefs, startISO: v };
                    setPrefs(next);
                    persistPrefs(next);
                  }}
                />
              </div>
              <div className="md:col-span-4">
                <FieldLabel>Weeks</FieldLabel>
                <Select
                  value={String(prefs.weeks)}
                  onChange={(v) => {
                    const next = { ...prefs, weeks: clamp(Number(v), 4, 12) };
                    setPrefs(next);
                    persistPrefs(next);
                  }}
                  options={weekOptions}
                />
              </div>
              <div className="md:col-span-4">
                <FieldLabel>Max streak</FieldLabel>
                <Select
                  value={String(prefs.maxStreak)}
                  onChange={(v) => {
                    const next = {
                      ...prefs,
                      maxStreak: clamp(Number(v), 0, 6),
                    };
                    setPrefs(next);
                    persistPrefs(next);
                  }}
                  options={maxStreakOptions}
                />
              </div>
            </div>

            {/* plan table */}
            <div className="mt-4 rounded-xl border border-gray-200 overflow-hidden">
              <div className="overflow-auto">
                <table className="min-w-[900px] w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <Th>Week</Th>
                      <Th>Start</Th>
                      <Th>Cuisine</Th>
                      <Th>Tags</Th>
                      <Th>Lock</Th>
                      <Th>Reason</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {(rotationPreview?.plan || []).map((row) => {
                      const lockedId =
                        prefs.lockedWeeks?.[String(row.weekIndex)] || "";
                      const locked = row.locked || !!lockedId;
                      return (
                        <tr
                          key={row.weekIndex}
                          className="border-b border-gray-100"
                        >
                          <Td>
                            <b>{row.weekIndex}</b>
                          </Td>
                          <Td>{row.weekStartISO}</Td>
                          <Td>
                            <div className="font-bold">{row.profileName}</div>
                            <div className="text-xs opacity-70">
                              {row.profileId}
                            </div>
                          </Td>
                          <Td className="text-xs">
                            <div className="flex flex-wrap gap-1">
                              {(row.tags || []).slice(0, 6).map((t) => (
                                <Badge key={t} tone="neutral">
                                  {t}
                                </Badge>
                              ))}
                              {(row.tags || []).length > 6 ? (
                                <Badge tone="neutral">
                                  +{row.tags.length - 6}
                                </Badge>
                              ) : null}
                            </div>
                          </Td>
                          <Td>
                            <LockPicker
                              profiles={eligibleProfiles}
                              value={lockedId}
                              onChange={(v) => {
                                const next = {
                                  ...prefs,
                                  lockedWeeks: { ...(prefs.lockedWeeks || {}) },
                                };
                                if (!v)
                                  delete next.lockedWeeks[
                                    String(row.weekIndex)
                                  ];
                                else
                                  next.lockedWeeks[String(row.weekIndex)] = v;
                                setPrefs(next);
                                persistPrefs(next);
                                // update preview immediately
                                setRotationPreview(
                                  buildRotationPreview(profiles, next)
                                );
                              }}
                            />
                            {locked ? (
                              <div className="mt-1">
                                <Badge tone="warn">locked</Badge>
                              </div>
                            ) : null}
                          </Td>
                          <Td className="text-xs opacity-70">{row.reason}</Td>
                        </tr>
                      );
                    })}

                    {ready &&
                    !dbError &&
                    (!rotationPreview?.plan ||
                      rotationPreview.plan.length === 0) ? (
                      <tr>
                        <td colSpan={6} className="p-5 text-sm opacity-80">
                          Select at least one eligible cuisine, then click
                          Generate.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <Badge tone="neutral" title="Deterministic hash of inputs">
                sourceHash:{" "}
                {rotationPreview?.sourceHash
                  ? rotationPreview.sourceHash.slice(0, 10)
                  : "—"}
              </Badge>
              <Badge
                tone={
                  rotationPreview?.selectedEligibleCount ? "success" : "warn"
                }
              >
                selected eligible: {rotationPreview?.selectedEligibleCount ?? 0}
              </Badge>
              <Badge tone="neutral">season: {prefs.season}</Badge>
            </div>
          </div>
        </div>

        {/* Saved rotations */}
        <div className="mt-5 rounded-2xl border border-gray-200 p-4">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div>
              <div className="font-bold">Saved rotations</div>
              <div className="text-xs opacity-70 mt-1">
                Your last 12 snapshots (local).
              </div>
            </div>
            <Button variant="ghost" onClick={refreshSavedRotations}>
              Refresh
            </Button>
          </div>

          <div className="mt-3 rounded-xl border border-gray-200 overflow-hidden">
            <div className="max-h-[320px] overflow-auto">
              {savedRotations.length === 0 ? (
                <div className="p-4 text-sm opacity-80">
                  No saved rotations yet.
                </div>
              ) : (
                <div className="divide-y divide-gray-100">
                  {savedRotations.map((r) => (
                    <div
                      key={r.id}
                      className="p-3 flex items-start justify-between gap-3 flex-wrap"
                    >
                      <div className="min-w-0">
                        <div className="font-bold">{r.title}</div>
                        <div className="text-xs opacity-70 mt-1">
                          {r.weeks} weeks • start {r.startISO} • updated{" "}
                          {safeString(r.updatedAt)
                            .slice(0, 19)
                            .replace("T", " ")}
                        </div>
                        <div className="text-xs opacity-70 mt-1">
                          sourceHash:{" "}
                          <b>{safeString(r.sourceHash).slice(0, 10) || "—"}</b>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => {
                            downloadJSON(
                              `ssa-rotation-${r.titleLower || "rotation"}.json`,
                              r
                            );
                            pushToast("Exported snapshot.", "success");
                          }}
                        >
                          Export
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => applyRotation(r)}
                        >
                          Load
                        </Button>
                        <Button
                          variant="danger"
                          onClick={() => removeRotation(r.id)}
                        >
                          Delete
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <EditRulesModal
          open={editModalOpen}
          onClose={() => setEditModalOpen(false)}
          prefs={prefs}
          profiles={profiles}
          onSave={async (next) => {
            const sanitized = sanitizePrefs(next, profiles);
            setPrefs(sanitized);
            await persistPrefs(sanitized);
            setRotationPreview(buildRotationPreview(profiles, sanitized));
            pushToast("Rules saved.", "success");
          }}
        />

        <ImportExportModal
          open={importExportOpen}
          onClose={() => setImportExportOpen(false)}
          profiles={profiles}
          prefs={prefs}
          onApply={async ({ nextProfiles, nextPrefs }) => {
            const db = dbRef.current;
            if (!db || dbError) return;

            try {
              if (Array.isArray(nextProfiles) && nextProfiles.length) {
                const now = nowISO();
                const rows = nextProfiles.map((p) => ({
                  ...normalizeProfileRow(p),
                  createdAt: p.createdAt || now,
                  updatedAt: now,
                }));
                await db.cuisineProfiles.bulkPut(rows);
                const loaded = await loadProfiles(db);
                setProfiles(loaded);

                const sanitizedPrefs = sanitizePrefs(
                  nextPrefs || prefs,
                  loaded
                );
                setPrefs(sanitizedPrefs);
                await persistPrefs(sanitizedPrefs);
                setRotationPreview(
                  buildRotationPreview(loaded, sanitizedPrefs)
                );

                pushToast(`Imported ${rows.length} profiles.`, "success");
              } else if (nextPrefs) {
                const sanitizedPrefs = sanitizePrefs(nextPrefs, profiles);
                setPrefs(sanitizedPrefs);
                await persistPrefs(sanitizedPrefs);
                setRotationPreview(
                  buildRotationPreview(profiles, sanitizedPrefs)
                );
                pushToast("Imported prefs.", "success");
              }
            } catch (e) {
              console.warn("[Cuisines] import failed:", e);
              pushToast("Import failed.", "error");
            }
          }}
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
 * Helpers
 * --------------------------------------------------------------------------- */

function sanitizePrefs(prefs, profiles) {
  const p = deepMerge(DEFAULT_PREFS, prefs || {});
  p.weeks = clamp(Number(p.weeks || 8), 4, 12);
  p.maxStreak = clamp(Number(p.maxStreak ?? 1), 0, 8);
  p.spacingBias = clamp(Number(p.spacingBias ?? 0.65), 0, 1);

  // startISO basic normalize
  const s = safeString(p.startISO || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s))
    p.startISO = new Date().toISOString().slice(0, 10);

  // selectedProfileIds should exist in profiles (otherwise keep but will be ignored)
  const ids = uniq((p.selectedProfileIds || []).map(safeString));
  p.selectedProfileIds = ids;

  // weights sanitize
  const w = { ...(p.weightsById || {}) };
  for (const k of Object.keys(w)) w[k] = clamp(Number(w[k] ?? 1), 0.1, 20);
  p.weightsById = w;

  // locked weeks sanitize
  const locked = {};
  for (const k of Object.keys(p.lockedWeeks || {})) {
    const wk = Number(k);
    const pid = safeString(p.lockedWeeks[k]);
    if (!Number.isFinite(wk) || wk < 1 || wk > p.weeks) continue;
    locked[String(wk)] = pid;
  }
  p.lockedWeeks = locked;

  // tags sanitize
  p.requiredTags = uniq(
    (p.requiredTags || []).map((t) => normalizeLower(t)).filter(Boolean)
  );
  p.excludedTags = uniq(
    (p.excludedTags || []).map((t) => normalizeLower(t)).filter(Boolean)
  );

  // season sanitize
  p.season = DEFAULT_SEASONS.includes(normalizeLower(p.season))
    ? normalizeLower(p.season)
    : "all";

  // template sanitize
  p.rotationTitleTemplate =
    safeString(p.rotationTitleTemplate || "Cuisine Rotation").trim() ||
    "Cuisine Rotation";

  // ensure each selected id has a default weight
  const idsAll = new Set(ids);
  for (const id of idsAll) if (p.weightsById[id] == null) p.weightsById[id] = 1;

  // if profiles empty, keep as-is
  if (!Array.isArray(profiles) || profiles.length === 0) return p;

  return p;
}

function buildRotationTitle(prefs) {
  const base =
    safeString(prefs.rotationTitleTemplate || "Cuisine Rotation").trim() ||
    "Cuisine Rotation";
  return `${base} • ${prefs.weeks}w • ${prefs.startISO}`;
}

function buildRotationPreview(profiles, prefs) {
  const filters = {
    season: prefs.season,
    requiredTags: prefs.requiredTags,
    excludedTags: prefs.excludedTags,
  };
  const eligible = (profiles || []).filter((p) =>
    profileMatchesFilters(p, filters)
  );

  const selectedEligible = eligible.filter((p) =>
    (prefs.selectedProfileIds || []).includes(p.id)
  );
  const selectedProfileIds = selectedEligible.length
    ? selectedEligible.map((p) => p.id)
    : eligible.map((p) => p.id);

  const plan = generateRotationPlan({
    profiles: eligible,
    selectedProfileIds,
    weightsById: prefs.weightsById || {},
    weeks: prefs.weeks,
    startISO: prefs.startISO,
    lockedWeeks: prefs.lockedWeeks || {},
    maxStreak: Number(prefs.maxStreak ?? 1),
    spacingBias: Number(prefs.spacingBias ?? 0.65),
    allowBackToBackIfOnlyOne: !!prefs.allowBackToBackIfOnlyOne,
  });

  const sourceHash = hashStable({
    eligibleProfiles: eligible.map((p) => ({
      id: p.id,
      name: p.name,
      tags: p.tags,
      seasonTags: p.seasonTags,
    })),
    prefs: {
      selectedProfileIds,
      weightsById: prefs.weightsById,
      startISO: prefs.startISO,
      weeks: prefs.weeks,
      maxStreak: prefs.maxStreak,
      spacingBias: prefs.spacingBias,
      lockedWeeks: prefs.lockedWeeks,
      season: prefs.season,
      requiredTags: prefs.requiredTags,
      excludedTags: prefs.excludedTags,
    },
  });

  return {
    computedAt: nowISO(),
    sourceHash,
    selectedEligibleCount: selectedEligible.length,
    eligibleCount: eligible.length,
    plan,
  };
}

/* -----------------------------------------------------------------------------
 * Components
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

function LockPicker({ profiles, value, onChange }) {
  const opts = useMemo(() => {
    const arr = (profiles || [])
      .slice()
      .sort((a, b) => (a.nameLower || "").localeCompare(b.nameLower || ""));
    return [
      { value: "", label: "— none —" },
      ...arr.map((p) => ({ value: p.id, label: p.name })),
    ];
  }, [profiles]);

  return <Select value={value || ""} onChange={onChange} options={opts} />;
}

/* -----------------------------------------------------------------------------
 * Edit Rules Modal
 * --------------------------------------------------------------------------- */

function EditRulesModal({ open, onClose, prefs, profiles, onSave }) {
  const [draft, setDraft] = useState(prefs || DEFAULT_PREFS);
  const [rawTags, setRawTags] = useState({ required: "", excluded: "" });

  useEffect(() => {
    if (!open) return;
    const p = sanitizePrefs(prefs, profiles);
    setDraft(p);
    setRawTags({
      required: (p.requiredTags || []).join(", "),
      excluded: (p.excludedTags || []).join(", "),
    });
  }, [open, prefs, profiles]);

  function save() {
    const req = uniq(
      rawTags.required
        .split(",")
        .map((t) => normalizeLower(t))
        .filter(Boolean)
    );
    const exc = uniq(
      rawTags.excluded
        .split(",")
        .map((t) => normalizeLower(t))
        .filter(Boolean)
    );
    const next = { ...draft, requiredTags: req, excludedTags: exc };
    onSave?.(next);
    onClose?.();
  }

  return (
    <ModalShell
      open={open}
      title="Rotation Rules"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs opacity-70">
            Season and tag filters affect which cuisines are eligible for
            selection and rotation.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save}>Save</Button>
          </div>
        </div>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-4">
          <FieldLabel>Season filter</FieldLabel>
          <Select
            value={draft.season}
            onChange={(v) => setDraft((p) => ({ ...p, season: v }))}
            options={DEFAULT_SEASONS.map((s) => ({ value: s, label: s }))}
          />
        </div>

        <div className="md:col-span-4">
          <FieldLabel>Max streak</FieldLabel>
          <Input
            type="number"
            value={String(draft.maxStreak)}
            onChange={(v) =>
              setDraft((p) => ({ ...p, maxStreak: clamp(Number(v), 0, 8) }))
            }
          />
          <div className="text-xs opacity-70 mt-1">
            0 = never repeat adjacent.
          </div>
        </div>

        <div className="md:col-span-4">
          <FieldLabel>Spacing bias (0..1)</FieldLabel>
          <Input
            type="number"
            value={String(draft.spacingBias)}
            onChange={(v) =>
              setDraft((p) => ({ ...p, spacingBias: clamp(Number(v), 0, 1) }))
            }
          />
          <div className="text-xs opacity-70 mt-1">
            Higher = spread cuisines out more.
          </div>
        </div>

        <div className="md:col-span-6">
          <FieldLabel>Required tags (comma separated)</FieldLabel>
          <Input
            value={rawTags.required}
            onChange={(v) => setRawTags((p) => ({ ...p, required: v }))}
            placeholder="e.g., family, comfort"
          />
          <div className="text-xs opacity-70 mt-1">
            Only cuisines containing all required tags are eligible.
          </div>
        </div>

        <div className="md:col-span-6">
          <FieldLabel>Excluded tags (comma separated)</FieldLabel>
          <Input
            value={rawTags.excluded}
            onChange={(v) => setRawTags((p) => ({ ...p, excluded: v }))}
            placeholder="e.g., spicy"
          />
          <div className="text-xs opacity-70 mt-1">
            Cuisines containing any excluded tag are removed.
          </div>
        </div>

        <div className="md:col-span-6">
          <FieldLabel>Rotation title template</FieldLabel>
          <Input
            value={draft.rotationTitleTemplate}
            onChange={(v) =>
              setDraft((p) => ({ ...p, rotationTitleTemplate: v }))
            }
            placeholder="Cuisine Rotation"
          />
        </div>

        <div className="md:col-span-6">
          <FieldLabel>
            Allow back-to-back if only one cuisine is eligible
          </FieldLabel>
          <Select
            value={String(!!draft.allowBackToBackIfOnlyOne)}
            onChange={(v) =>
              setDraft((p) => ({
                ...p,
                allowBackToBackIfOnlyOne: v === "true",
              }))
            }
            options={[
              { value: "true", label: "true" },
              { value: "false", label: "false" },
            ]}
          />
        </div>

        <div className="md:col-span-12 rounded-xl border border-gray-200 bg-gray-50 p-4 text-xs opacity-80">
          <div className="font-bold text-xs mb-2">
            How SSA can use this rotation
          </div>
          <ul className="list-disc ml-5 space-y-1">
            <li>
              Meal Planner: choose weekly cuisine mode → influence recipes,
              spices, techniques.
            </li>
            <li>
              Storehouse Targets: map cuisines → staple ingredients (spice
              blends, grains, oils).
            </li>
            <li>
              Batch Cooking: schedule preservation batches aligned to upcoming
              cuisines.
            </li>
          </ul>
        </div>
      </div>
    </ModalShell>
  );
}

/* -----------------------------------------------------------------------------
 * Import/Export Modal
 * --------------------------------------------------------------------------- */

function ImportExportModal({ open, onClose, profiles, prefs, onApply }) {
  const [tab, setTab] = useState("export"); // export | import
  const [text, setText] = useState("");

  useEffect(() => {
    if (!open) return;
    setTab("export");
    setText(
      JSON.stringify(
        {
          type: "SSA_CuisineProfilesAndPrefs",
          version: 1,
          exportedAt: nowISO(),
          profiles,
          prefs,
        },
        null,
        2
      )
    );
  }, [open, profiles, prefs]);

  function apply() {
    const parsed = tryParseJSON(text);
    if (!parsed.ok) return;

    const payload = parsed.value || {};
    const nextProfiles = Array.isArray(payload.profiles)
      ? payload.profiles
      : null;
    const nextPrefs = payload.prefs || payload.value || null;
    onApply?.({ nextProfiles, nextPrefs });
    onClose?.();
  }

  const jsonOk = tryParseJSON(text).ok;

  return (
    <ModalShell
      open={open}
      title="Cuisine Import / Export"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs opacity-70">
            Import supports payloads containing <b>profiles</b> and/or{" "}
            <b>prefs</b>.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {tab === "import" ? (
              <Button
                onClick={apply}
                disabled={!jsonOk}
                title={!jsonOk ? "Fix JSON first" : "Apply import"}
              >
                Apply Import
              </Button>
            ) : null}
          </div>
        </div>
      }
    >
      <div className="flex items-center gap-2">
        <Button
          variant={tab === "export" ? "solid" : "ghost"}
          onClick={() => setTab("export")}
        >
          Export
        </Button>
        <Button
          variant={tab === "import" ? "solid" : "ghost"}
          onClick={() => setTab("import")}
        >
          Import
        </Button>
      </div>

      <div className="mt-4">
        <FieldLabel>
          {tab === "export" ? "Copy JSON" : "Paste JSON to import"}
        </FieldLabel>
        <Textarea value={text} onChange={setText} rows={18} />
        <div className="text-xs opacity-70 mt-2">
          {jsonOk ? (
            <span className="text-green-700 font-bold">Valid JSON</span>
          ) : (
            <span className="text-red-700 font-bold">Invalid JSON</span>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

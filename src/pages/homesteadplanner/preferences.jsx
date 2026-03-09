// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\preferences.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Preferences (Household preferences + taste cards)
 * -----------------------------------------------------------------------------
 * Production goals
 *  - Browser-safe (no Node imports)
 *  - Dexie-backed persistence
 *  - "Taste cards" UI to capture household flavor, ingredients, constraints, rhythms
 *  - Emits SSA events for downstream modules (meal planning, storehouse targets, batch cooking)
 *
 * Storage (Dexie)
 *  - householdProfiles: { id, name, timezone, membersCount, createdAt, updatedAt }
 *  - householdPreferences:
 *      {
 *        id, householdId,
 *        // taste axes
 *        taste: { heat, sweet, sour, bitter, umami, salt, smoke, herbaceous, aromatic, richness },
 *        // ingredient affinities
 *        likes: { proteins[], vegetables[], grains[], legumes[], dairyAlt[], fruits[], fats[], herbsSpices[], cuisines[] },
 *        avoids: { ingredients[], techniques[], textures[] },
 *        allergies: { items[], severityByItem: { [item]: "mild"|"moderate"|"severe" } },
 *        constraints: { halalLike, noPork, noShellfish, lowSodium, lowSugar, glutenFree, dairyFree, eggFree, nutFree },
 *        // planning rhythms
 *        rhythms: { cookDaysPerWeek, leftoverNightsPerWeek, batchCookCadenceWeeks, breakfastStyle, prepTimeWeeknightMins },
 *        // household notes + tags
 *        notes, tags[],
 *        // meta
 *        version, createdAt, updatedAt
 *      }
 *
 * Events emitted
 *  - ssa.hp.preferences.updated
 *  - ssa.hp.preferences.card.updated
 *  - ssa.hp.preferences.exported
 *  - ssa.hp.preferences.imported
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * DB
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/preferences";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1";
const DB_VERSION = 7;

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

  // v6 keep stores
  db.version(6).stores({
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

  // v7 preferences tables
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
  });

  _dbSingleton = db;
  return db;
}

/* -----------------------------------------------------------------------------
 * Defaults
 * --------------------------------------------------------------------------- */

const DEFAULT_HOUSEHOLD = {
  id: "primary",
  name: "Household",
  nameLower: "household",
  timezone: "America/Chicago",
  membersCount: 1,
  createdAt: null,
  updatedAt: null,
};

const DEFAULT_PREFERENCES = {
  id: "prefs_primary",
  householdId: "primary",
  version: 1,

  taste: {
    heat: 2,
    sweet: 2,
    sour: 2,
    bitter: 1,
    umami: 3,
    salt: 2,
    smoke: 2,
    herbaceous: 3,
    aromatic: 3,
    richness: 3,
  },

  likes: {
    proteins: ["chicken", "beef", "lamb", "goat", "fish"],
    vegetables: ["onion", "garlic", "greens", "tomato", "pepper"],
    grains: ["rice", "cornmeal", "oats", "wheat"],
    legumes: ["beans", "lentils"],
    dairyAlt: [],
    fruits: [],
    fats: ["olive oil", "butter", "ghee"],
    herbsSpices: ["black pepper", "cumin", "paprika", "thyme", "ginger"],
    cuisines: ["aai", "southern", "west-african", "mediterranean"],
  },

  avoids: {
    ingredients: [],
    techniques: [],
    textures: [],
  },

  allergies: {
    items: [],
    severityByItem: {},
  },

  constraints: {
    halalLike: false,
    noPork: false,
    noShellfish: false,
    lowSodium: false,
    lowSugar: false,
    glutenFree: false,
    dairyFree: false,
    eggFree: false,
    nutFree: false,
  },

  rhythms: {
    cookDaysPerWeek: 5,
    leftoverNightsPerWeek: 1,
    batchCookCadenceWeeks: 2,
    breakfastStyle: "eggs + waffles",
    prepTimeWeeknightMins: 45,
  },

  notes: "",
  tags: ["homestead", "taste"],

  createdAt: null,
  updatedAt: null,
};

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
 * Dexie I/O
 * --------------------------------------------------------------------------- */

async function ensureHouseholdAndPrefs(db) {
  const now = nowISO();

  const household = await db.householdProfiles.get("primary");
  if (!household) {
    await db.householdProfiles.put({
      ...DEFAULT_HOUSEHOLD,
      createdAt: now,
      updatedAt: now,
    });
  }

  const prefs = await db.householdPreferences.get(DEFAULT_PREFERENCES.id);
  if (!prefs) {
    await db.householdPreferences.put({
      ...DEFAULT_PREFERENCES,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function loadHousehold(db) {
  const h = await db.householdProfiles.get("primary");
  if (!h) return { ...DEFAULT_HOUSEHOLD };
  return normalizeHousehold(h);
}

async function loadPreferences(db) {
  const p = await db.householdPreferences.get(DEFAULT_PREFERENCES.id);
  if (!p) return { ...DEFAULT_PREFERENCES };
  return normalizePreferences(p);
}

async function saveHousehold(db, household) {
  const now = nowISO();
  const row = normalizeHousehold({
    ...household,
    updatedAt: now,
    createdAt: household.createdAt || now,
  });
  await db.householdProfiles.put(row);
  return row;
}

async function savePreferences(db, prefs) {
  const now = nowISO();
  const row = normalizePreferences({
    ...prefs,
    updatedAt: now,
    createdAt: prefs.createdAt || now,
  });
  await db.householdPreferences.put(row);
  return row;
}

function normalizeHousehold(h) {
  const name =
    safeString(h?.name || DEFAULT_HOUSEHOLD.name).trim() ||
    DEFAULT_HOUSEHOLD.name;
  return {
    id: "primary",
    name,
    nameLower: normalizeLower(name),
    timezone: safeString(h?.timezone || DEFAULT_HOUSEHOLD.timezone),
    membersCount: clamp(h?.membersCount ?? 1, 1, 99),
    createdAt: h?.createdAt || nowISO(),
    updatedAt: h?.updatedAt || nowISO(),
  };
}

function normalizePreferences(p) {
  const merged = deepMerge(DEFAULT_PREFERENCES, p || {});
  merged.id = DEFAULT_PREFERENCES.id;
  merged.householdId = "primary";

  // taste axes clamp 0..5
  const t = { ...(merged.taste || {}) };
  for (const k of Object.keys(DEFAULT_PREFERENCES.taste))
    t[k] = clamp(t[k], 0, 5);
  merged.taste = t;

  // arrays normalize
  merged.likes = merged.likes || {};
  merged.avoids = merged.avoids || {};
  merged.allergies = merged.allergies || { items: [], severityByItem: {} };
  merged.constraints = merged.constraints || {};
  merged.rhythms = merged.rhythms || {};

  merged.likes.proteins = uniq(merged.likes.proteins);
  merged.likes.vegetables = uniq(merged.likes.vegetables);
  merged.likes.grains = uniq(merged.likes.grains);
  merged.likes.legumes = uniq(merged.likes.legumes);
  merged.likes.dairyAlt = uniq(merged.likes.dairyAlt);
  merged.likes.fruits = uniq(merged.likes.fruits);
  merged.likes.fats = uniq(merged.likes.fats);
  merged.likes.herbsSpices = uniq(merged.likes.herbsSpices);
  merged.likes.cuisines = uniq(merged.likes.cuisines);

  merged.avoids.ingredients = uniq(merged.avoids.ingredients);
  merged.avoids.techniques = uniq(merged.avoids.techniques);
  merged.avoids.textures = uniq(merged.avoids.textures);

  merged.allergies.items = uniq(merged.allergies.items);
  merged.allergies.severityByItem = merged.allergies.severityByItem || {};

  merged.constraints = {
    ...DEFAULT_PREFERENCES.constraints,
    ...(merged.constraints || {}),
  };

  merged.rhythms = {
    ...DEFAULT_PREFERENCES.rhythms,
    ...(merged.rhythms || {}),
  };
  merged.rhythms.cookDaysPerWeek = clamp(
    merged.rhythms.cookDaysPerWeek ?? 5,
    0,
    7
  );
  merged.rhythms.leftoverNightsPerWeek = clamp(
    merged.rhythms.leftoverNightsPerWeek ?? 1,
    0,
    7
  );
  merged.rhythms.batchCookCadenceWeeks = clamp(
    merged.rhythms.batchCookCadenceWeeks ?? 2,
    1,
    12
  );
  merged.rhythms.prepTimeWeeknightMins = clamp(
    merged.rhythms.prepTimeWeeknightMins ?? 45,
    5,
    240
  );
  merged.rhythms.breakfastStyle = safeString(
    merged.rhythms.breakfastStyle || "eggs + waffles"
  );

  merged.notes = safeString(merged.notes || "");
  merged.tags = uniq(merged.tags || []);

  merged.version = Number(merged.version || 1);
  merged.createdAt = merged.createdAt || nowISO();
  merged.updatedAt = merged.updatedAt || nowISO();

  return merged;
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
function Toggle({ checked, onChange, label }) {
  return (
    <label className="flex items-center gap-2 text-sm select-none cursor-pointer">
      <input
        type="checkbox"
        checked={!!checked}
        onChange={(e) => onChange?.(e.target.checked)}
      />
      <span>{label}</span>
    </label>
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
 * Taste Card components
 * --------------------------------------------------------------------------- */

const TASTE_AXES = [
  { key: "heat", label: "Heat" },
  { key: "sweet", label: "Sweet" },
  { key: "sour", label: "Sour" },
  { key: "bitter", label: "Bitter" },
  { key: "umami", label: "Umami" },
  { key: "salt", label: "Salt" },
  { key: "smoke", label: "Smoke" },
  { key: "herbaceous", label: "Herbaceous" },
  { key: "aromatic", label: "Aromatic" },
  { key: "richness", label: "Richness" },
];

function TasteAxisRow({ label, value, onChange }) {
  const v = clamp(value ?? 0, 0, 5);
  return (
    <div className="grid grid-cols-12 gap-2 items-center">
      <div className="col-span-4 text-sm font-semibold">{label}</div>
      <div className="col-span-6">
        <input
          type="range"
          min="0"
          max="5"
          step="1"
          value={String(v)}
          onChange={(e) => onChange?.(Number(e.target.value))}
          className="w-full"
        />
      </div>
      <div className="col-span-2 flex justify-end">
        <Badge tone="neutral">{v}</Badge>
      </div>
    </div>
  );
}

function TagChipsEditor({
  title,
  subtitle,
  value,
  onChange,
  suggestions = [],
}) {
  const [draft, setDraft] = useState("");
  const chips = uniq(value || []);

  function addChip(text) {
    const t = safeString(text).trim();
    if (!t) return;
    onChange?.(uniq([...chips, t]));
    setDraft("");
  }
  function removeChip(t) {
    onChange?.(chips.filter((x) => normalizeLower(x) !== normalizeLower(t)));
  }

  const filteredSuggestions = useMemo(() => {
    const q = normalizeLower(draft);
    const base = uniq(suggestions || []);
    const out = base
      .filter(
        (s) => !chips.some((c) => normalizeLower(c) === normalizeLower(s))
      )
      .filter((s) => (q ? normalizeLower(s).includes(q) : true))
      .slice(0, 10);
    return out;
  }, [draft, suggestions, chips]);

  return (
    <div>
      <div className="font-bold">{title}</div>
      {subtitle ? (
        <div className="text-xs opacity-70 mt-1">{subtitle}</div>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {chips.length ? (
          chips.map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-2 rounded-full border border-gray-200 bg-white px-3 py-1 text-sm"
            >
              {c}
              <button
                type="button"
                className="text-xs opacity-70 hover:opacity-100"
                onClick={() => removeChip(c)}
              >
                ✕
              </button>
            </span>
          ))
        ) : (
          <div className="text-sm opacity-70">None yet.</div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-2">
        <div className="md:col-span-9">
          <Input
            value={draft}
            onChange={setDraft}
            placeholder="Type and press Enter (or click Add)…"
            className=""
            type="text"
          />
        </div>
        <div className="md:col-span-3">
          <Button
            variant="ghost"
            onClick={() => addChip(draft)}
            disabled={!safeString(draft).trim()}
            title="Add"
            className="w-full"
          >
            Add
          </Button>
        </div>
      </div>

      {filteredSuggestions.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {filteredSuggestions.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => addChip(s)}
              className="text-xs rounded-full border border-gray-200 bg-gray-50 px-2 py-1 hover:bg-gray-100"
              title="Click to add"
            >
              + {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Main Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerPreferencesPage() {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  const [household, setHousehold] = useState(DEFAULT_HOUSEHOLD);
  const [prefs, setPrefs] = useState(DEFAULT_PREFERENCES);

  const [toast, setToast] = useState(null);
  const [importExportOpen, setImportExportOpen] = useState(false);
  const [rawImport, setRawImport] = useState("");

  // autosave debounce
  const saveTimerRef = useRef(null);

  useEffect(() => {
    const db = getDb();
    dbRef.current = db;

    (async () => {
      try {
        await db.inventoryMeta.limit(1).toArray();
        await ensureHouseholdAndPrefs(db);
        const [h, p] = await Promise.all([
          loadHousehold(db),
          loadPreferences(db),
        ]);
        setHousehold(h);
        setPrefs(p);
        setReady(true);
      } catch (e) {
        console.warn("[Preferences] init failed:", e);
        setDbError(
          "Household preferences storage isn’t available (IndexedDB blocked/unavailable)."
        );
        setReady(true);
      }
    })();
  }, []);

  function pushToast(message, kind = "info") {
    setToast({ message, kind, at: Date.now() });
    setTimeout(() => setToast(null), 2200);
  }

  function scheduleSave(nextHousehold, nextPrefs, eventMeta = {}) {
    const db = dbRef.current;
    if (!db || dbError) return;

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      try {
        const [savedH, savedP] = await Promise.all([
          saveHousehold(db, nextHousehold),
          savePreferences(db, nextPrefs),
        ]);

        const payload = buildEventPayload(savedH, savedP);

        emitSSAEvent("ssa.hp.preferences.updated", {
          source: PAGE_SOURCE,
          ...eventMeta,
          ...payload,
        });

        pushToast("Saved.", "success");
      } catch (e) {
        console.warn("[Preferences] save failed:", e);
        pushToast("Save failed.", "error");
      }
    }, 350);
  }

  function updateHousehold(patch) {
    setHousehold((prev) => {
      const next = normalizeHousehold({ ...prev, ...patch });
      scheduleSave(next, prefs, { area: "household" });
      return next;
    });
  }

  function updatePrefs(patch, cardKey = null) {
    setPrefs((prev) => {
      const next = normalizePreferences(deepMerge(prev, patch));
      scheduleSave(household, next, {
        area: cardKey ? `card:${cardKey}` : "prefs",
      });

      emitSSAEvent("ssa.hp.preferences.card.updated", {
        source: PAGE_SOURCE,
        card: cardKey || "unknown",
        snapshotHash: hashStable({
          householdId: next.householdId,
          prefs: next,
        }),
      });

      return next;
    });
  }

  const suggestions = useMemo(() => {
    // Conservative built-in suggestions for speed; users can type anything.
    return {
      proteins: [
        "chicken",
        "beef",
        "lamb",
        "goat",
        "fish",
        "turkey",
        "venison",
        "eggs",
      ],
      vegetables: [
        "onion",
        "garlic",
        "greens",
        "cabbage",
        "okra",
        "tomato",
        "pepper",
        "carrot",
        "sweet potato",
      ],
      grains: [
        "rice",
        "cornmeal",
        "oats",
        "wheat",
        "barley",
        "sorghum",
        "millet",
      ],
      legumes: ["beans", "lentils", "peas", "chickpeas"],
      fats: ["olive oil", "butter", "ghee", "tallow", "coconut oil"],
      herbsSpices: [
        "black pepper",
        "cumin",
        "paprika",
        "thyme",
        "ginger",
        "coriander",
        "turmeric",
        "cayenne",
        "allspice",
      ],
      cuisines: [
        "aai",
        "southern",
        "west-african",
        "caribbean",
        "mediterranean",
        "middle-eastern",
      ],
      techniques: [
        "frying",
        "grilling",
        "smoking",
        "braising",
        "pressure-canning",
        "dehydrating",
        "fermenting",
      ],
      textures: ["mushy", "slimy", "crunchy", "chewy", "gritty"],
      allergies: [
        "peanuts",
        "tree nuts",
        "dairy",
        "eggs",
        "gluten",
        "shellfish",
        "soy",
        "sesame",
      ],
      ingredientsAvoid: ["pork", "gelatin", "high-fructose corn syrup"],
    };
  }, []);

  function exportPrefs() {
    const payload = {
      type: "SSA_HouseholdPreferences",
      version: 1,
      exportedAt: nowISO(),
      household,
      prefs,
    };
    downloadJSON(
      `ssa-household-preferences-${new Date().toISOString().slice(0, 10)}.json`,
      payload
    );
    emitSSAEvent("ssa.hp.preferences.exported", {
      source: PAGE_SOURCE,
      householdId: household.id,
    });
    pushToast("Exported JSON.", "success");
  }

  function openImport() {
    setRawImport(
      JSON.stringify(
        {
          type: "SSA_HouseholdPreferences",
          version: 1,
          household,
          prefs,
        },
        null,
        2
      )
    );
    setImportExportOpen(true);
  }

  async function applyImport() {
    const parsed = tryParseJSON(rawImport);
    if (!parsed.ok) return;

    const incoming = parsed.value || {};
    const nextH = incoming.household
      ? normalizeHousehold({ ...household, ...incoming.household })
      : household;
    const nextP = incoming.prefs
      ? normalizePreferences(deepMerge(prefs, incoming.prefs))
      : prefs;

    setHousehold(nextH);
    setPrefs(nextP);

    const db = dbRef.current;
    if (db && !dbError) {
      try {
        await Promise.all([
          saveHousehold(db, nextH),
          savePreferences(db, nextP),
        ]);
        emitSSAEvent("ssa.hp.preferences.imported", {
          source: PAGE_SOURCE,
          householdId: nextH.id,
          snapshotHash: hashStable({ household: nextH, prefs: nextP }),
        });
      } catch (e) {
        console.warn("[Preferences] import save failed:", e);
      }
    }

    pushToast("Imported.", "success");
    setImportExportOpen(false);
  }

  const jsonOk = useMemo(() => tryParseJSON(rawImport).ok, [rawImport]);

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">Preferences</h1>
            <div className="text-sm opacity-80 mt-1">
              Household taste profile + constraints. These inform Meal Planning,
              Storehouse Targets, and Batch Cooking.
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              onClick={exportPrefs}
              title="Export preferences JSON"
            >
              Export
            </Button>
            <Button
              variant="ghost"
              onClick={openImport}
              title="Import preferences JSON"
            >
              Import
            </Button>
          </div>
        </div>

        {dbError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="font-bold text-red-800">Storage unavailable</div>
            <div className="text-red-800 mt-1">{dbError}</div>
          </div>
        ) : null}

        {/* Household Profile */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <Card
            className="lg:col-span-5"
            title="Household profile"
            subtitle="Basic info used across SSA."
            right={<Badge tone="neutral">id: {household.id}</Badge>}
          >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-6">
                <FieldLabel>Name</FieldLabel>
                <Input
                  value={household.name}
                  onChange={(v) => updateHousehold({ name: v })}
                  placeholder="Household name"
                />
              </div>

              <div className="md:col-span-6">
                <FieldLabel>Timezone</FieldLabel>
                <Input
                  value={household.timezone}
                  onChange={(v) => updateHousehold({ timezone: v })}
                  placeholder="America/Chicago"
                />
              </div>

              <div className="md:col-span-6">
                <FieldLabel>Members</FieldLabel>
                <Input
                  type="number"
                  value={String(household.membersCount)}
                  onChange={(v) =>
                    updateHousehold({ membersCount: clamp(v, 1, 99) })
                  }
                />
              </div>

              <div className="md:col-span-6">
                <FieldLabel>Tags</FieldLabel>
                <Input
                  value={(prefs.tags || []).join(", ")}
                  onChange={(v) =>
                    updatePrefs(
                      { tags: uniq(v.split(",").map((x) => x.trim())) },
                      "tags"
                    )
                  }
                  placeholder="homestead, taste, …"
                />
              </div>
            </div>
          </Card>

          <Card
            className="lg:col-span-7"
            title="Planning rhythms"
            subtitle="Defaults used when generating weekly meal plans and preservation schedules."
          >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              <div className="md:col-span-4">
                <FieldLabel>Cook days / week</FieldLabel>
                <Input
                  type="number"
                  value={String(prefs.rhythms.cookDaysPerWeek)}
                  onChange={(v) =>
                    updatePrefs(
                      { rhythms: { cookDaysPerWeek: clamp(v, 0, 7) } },
                      "rhythms"
                    )
                  }
                />
              </div>

              <div className="md:col-span-4">
                <FieldLabel>Leftover nights / week</FieldLabel>
                <Input
                  type="number"
                  value={String(prefs.rhythms.leftoverNightsPerWeek)}
                  onChange={(v) =>
                    updatePrefs(
                      { rhythms: { leftoverNightsPerWeek: clamp(v, 0, 7) } },
                      "rhythms"
                    )
                  }
                />
              </div>

              <div className="md:col-span-4">
                <FieldLabel>Batch cadence (weeks)</FieldLabel>
                <Input
                  type="number"
                  value={String(prefs.rhythms.batchCookCadenceWeeks)}
                  onChange={(v) =>
                    updatePrefs(
                      { rhythms: { batchCookCadenceWeeks: clamp(v, 1, 12) } },
                      "rhythms"
                    )
                  }
                />
              </div>

              <div className="md:col-span-6">
                <FieldLabel>Weeknight prep time (mins)</FieldLabel>
                <Input
                  type="number"
                  value={String(prefs.rhythms.prepTimeWeeknightMins)}
                  onChange={(v) =>
                    updatePrefs(
                      { rhythms: { prepTimeWeeknightMins: clamp(v, 5, 240) } },
                      "rhythms"
                    )
                  }
                />
              </div>

              <div className="md:col-span-6">
                <FieldLabel>Breakfast style</FieldLabel>
                <Input
                  value={prefs.rhythms.breakfastStyle}
                  onChange={(v) =>
                    updatePrefs({ rhythms: { breakfastStyle: v } }, "rhythms")
                  }
                  placeholder="eggs + waffles"
                />
              </div>
            </div>
          </Card>
        </div>

        {/* Taste + likes */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <Card
            className="lg:col-span-5"
            title="Taste card"
            subtitle="0 = low, 5 = high. Used to bias recipes, spice level, and technique."
          >
            <div className="space-y-3">
              {TASTE_AXES.map((a) => (
                <TasteAxisRow
                  key={a.key}
                  label={a.label}
                  value={prefs.taste[a.key]}
                  onChange={(v) =>
                    updatePrefs({ taste: { [a.key]: v } }, "taste")
                  }
                />
              ))}
            </div>
          </Card>

          <Card
            className="lg:col-span-7"
            title="Likes"
            subtitle="Affinities that increase selection probability during planning."
          >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Proteins"
                  subtitle="Core proteins (also maps to storehouse + animal targets)."
                  value={prefs.likes.proteins}
                  onChange={(v) =>
                    updatePrefs({ likes: { proteins: v } }, "likes:proteins")
                  }
                  suggestions={suggestions.proteins}
                />
              </div>
              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Vegetables"
                  subtitle="Preferred vegetables/greens."
                  value={prefs.likes.vegetables}
                  onChange={(v) =>
                    updatePrefs(
                      { likes: { vegetables: v } },
                      "likes:vegetables"
                    )
                  }
                  suggestions={suggestions.vegetables}
                />
              </div>

              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Grains"
                  subtitle="Preferred grains/starches."
                  value={prefs.likes.grains}
                  onChange={(v) =>
                    updatePrefs({ likes: { grains: v } }, "likes:grains")
                  }
                  suggestions={suggestions.grains}
                />
              </div>
              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Legumes"
                  subtitle="Beans/lentils/peas."
                  value={prefs.likes.legumes}
                  onChange={(v) =>
                    updatePrefs({ likes: { legumes: v } }, "likes:legumes")
                  }
                  suggestions={suggestions.legumes}
                />
              </div>

              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Fats"
                  subtitle="Cooking fats and oils."
                  value={prefs.likes.fats}
                  onChange={(v) =>
                    updatePrefs({ likes: { fats: v } }, "likes:fats")
                  }
                  suggestions={suggestions.fats}
                />
              </div>

              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Herbs & spices"
                  subtitle="Bias spice cabinet + seasonings."
                  value={prefs.likes.herbsSpices}
                  onChange={(v) =>
                    updatePrefs(
                      { likes: { herbsSpices: v } },
                      "likes:herbsSpices"
                    )
                  }
                  suggestions={suggestions.herbsSpices}
                />
              </div>

              <div className="md:col-span-12">
                <TagChipsEditor
                  title="Cuisine keywords"
                  subtitle="Used by cuisine rotation and recipe filters."
                  value={prefs.likes.cuisines}
                  onChange={(v) =>
                    updatePrefs({ likes: { cuisines: v } }, "likes:cuisines")
                  }
                  suggestions={suggestions.cuisines}
                />
              </div>
            </div>
          </Card>
        </div>

        {/* Constraints + avoids */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <Card
            className="lg:col-span-5"
            title="Constraints"
            subtitle="Hard constraints that planners must respect."
          >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.noPork}
                  onChange={(v) =>
                    updatePrefs({ constraints: { noPork: v } }, "constraints")
                  }
                  label="No pork"
                />
              </div>
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.noShellfish}
                  onChange={(v) =>
                    updatePrefs(
                      { constraints: { noShellfish: v } },
                      "constraints"
                    )
                  }
                  label="No shellfish"
                />
              </div>
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.glutenFree}
                  onChange={(v) =>
                    updatePrefs(
                      { constraints: { glutenFree: v } },
                      "constraints"
                    )
                  }
                  label="Gluten-free"
                />
              </div>
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.dairyFree}
                  onChange={(v) =>
                    updatePrefs(
                      { constraints: { dairyFree: v } },
                      "constraints"
                    )
                  }
                  label="Dairy-free"
                />
              </div>
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.eggFree}
                  onChange={(v) =>
                    updatePrefs({ constraints: { eggFree: v } }, "constraints")
                  }
                  label="Egg-free"
                />
              </div>
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.nutFree}
                  onChange={(v) =>
                    updatePrefs({ constraints: { nutFree: v } }, "constraints")
                  }
                  label="Nut-free"
                />
              </div>
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.lowSodium}
                  onChange={(v) =>
                    updatePrefs(
                      { constraints: { lowSodium: v } },
                      "constraints"
                    )
                  }
                  label="Low sodium"
                />
              </div>
              <div className="md:col-span-6">
                <Toggle
                  checked={prefs.constraints.lowSugar}
                  onChange={(v) =>
                    updatePrefs({ constraints: { lowSugar: v } }, "constraints")
                  }
                  label="Low sugar"
                />
              </div>
              <div className="md:col-span-12">
                <Toggle
                  checked={prefs.constraints.halalLike}
                  onChange={(v) =>
                    updatePrefs(
                      { constraints: { halalLike: v } },
                      "constraints"
                    )
                  }
                  label="Halal-like (clean meats + method constraints)"
                />
              </div>
            </div>

            <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs opacity-80">
              Tip: Planners should treat these as blockers and adjust
              recipes/substitutions automatically.
            </div>
          </Card>

          <Card
            className="lg:col-span-7"
            title="Avoids & allergies"
            subtitle="Avoids reduce probability; allergies are blockers."
          >
            <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Avoid ingredients"
                  subtitle="Example: cilantro, pork, HFCS."
                  value={prefs.avoids.ingredients}
                  onChange={(v) =>
                    updatePrefs(
                      { avoids: { ingredients: v } },
                      "avoids:ingredients"
                    )
                  }
                  suggestions={[
                    ...suggestions.ingredientsAvoid,
                    ...suggestions.allergies,
                  ]}
                />
              </div>

              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Avoid techniques"
                  subtitle="Example: frying, smoking."
                  value={prefs.avoids.techniques}
                  onChange={(v) =>
                    updatePrefs(
                      { avoids: { techniques: v } },
                      "avoids:techniques"
                    )
                  }
                  suggestions={suggestions.techniques}
                />
              </div>

              <div className="md:col-span-6">
                <TagChipsEditor
                  title="Avoid textures"
                  subtitle="Example: slimy, mushy."
                  value={prefs.avoids.textures}
                  onChange={(v) =>
                    updatePrefs({ avoids: { textures: v } }, "avoids:textures")
                  }
                  suggestions={suggestions.textures}
                />
              </div>

              <div className="md:col-span-6">
                <AllergyEditor
                  items={prefs.allergies.items}
                  severityByItem={prefs.allergies.severityByItem}
                  onChange={(items, severityByItem) =>
                    updatePrefs(
                      { allergies: { items, severityByItem } },
                      "allergies"
                    )
                  }
                  suggestions={suggestions.allergies}
                />
              </div>
            </div>
          </Card>
        </div>

        {/* Notes */}
        <div className="mt-5">
          <Card
            title="Notes"
            subtitle="Context for future planning decisions and substitutions."
          >
            <Textarea
              value={prefs.notes}
              onChange={(v) => updatePrefs({ notes: v }, "notes")}
              placeholder="Household notes: spice tolerance by person, favorite meals, disliked ingredients, feast-day patterns…"
              rows={6}
            />
          </Card>
        </div>

        {/* Import/Export Modal */}
        <ModalShell
          open={importExportOpen}
          title="Import preferences JSON"
          onClose={() => setImportExportOpen(false)}
          footer={
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="text-xs opacity-70">
                Paste JSON containing <b>household</b> and/or <b>prefs</b>.
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  onClick={() => setImportExportOpen(false)}
                >
                  Close
                </Button>
                <Button
                  onClick={applyImport}
                  disabled={!jsonOk}
                  title={!jsonOk ? "Fix JSON first" : "Apply import"}
                >
                  Apply Import
                </Button>
              </div>
            </div>
          }
        >
          <FieldLabel>JSON</FieldLabel>
          <Textarea value={rawImport} onChange={setRawImport} rows={16} />
          <div className="text-xs opacity-70 mt-2">
            {jsonOk ? (
              <span className="text-green-700 font-bold">Valid JSON</span>
            ) : (
              <span className="text-red-700 font-bold">Invalid JSON</span>
            )}
          </div>
        </ModalShell>

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
 * Allergy Editor
 * --------------------------------------------------------------------------- */

function AllergyEditor({ items, severityByItem, onChange, suggestions = [] }) {
  const [draft, setDraft] = useState("");
  const [draftSeverity, setDraftSeverity] = useState("moderate");

  const list = uniq(items || []);
  const sev = severityByItem || {};

  function add() {
    const name = safeString(draft).trim();
    if (!name) return;
    const nextItems = uniq([...list, name]);
    const nextSev = { ...sev, [name]: draftSeverity };
    onChange?.(nextItems, nextSev);
    setDraft("");
  }

  function remove(name) {
    const nextItems = list.filter(
      (x) => normalizeLower(x) !== normalizeLower(name)
    );
    const nextSev = { ...sev };
    delete nextSev[name];
    onChange?.(nextItems, nextSev);
  }

  function setSeverity(name, s) {
    const nextSev = { ...sev, [name]: s };
    onChange?.(list, nextSev);
  }

  const filteredSuggestions = useMemo(() => {
    const q = normalizeLower(draft);
    const base = uniq(suggestions || []);
    return base
      .filter((s) => !list.some((x) => normalizeLower(x) === normalizeLower(s)))
      .filter((s) => (q ? normalizeLower(s).includes(q) : true))
      .slice(0, 8);
  }, [draft, suggestions, list]);

  return (
    <div>
      <div className="font-bold">Allergies</div>
      <div className="text-xs opacity-70 mt-1">
        Allergies are blockers. Severity helps substitution rules.
      </div>

      <div className="mt-3 space-y-2">
        {list.length ? (
          list.map((a) => (
            <div
              key={a}
              className="flex items-center justify-between gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2"
            >
              <div className="min-w-0">
                <div className="font-semibold text-sm">{a}</div>
                <div className="text-xs opacity-70">
                  severity: {sev[a] || "moderate"}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="rounded-lg border border-gray-300 px-2 py-1 text-sm bg-white"
                  value={sev[a] || "moderate"}
                  onChange={(e) => setSeverity(a, e.target.value)}
                >
                  <option value="mild">mild</option>
                  <option value="moderate">moderate</option>
                  <option value="severe">severe</option>
                </select>
                <button
                  type="button"
                  className="rounded-lg border px-2 py-1 text-sm"
                  onClick={() => remove(a)}
                  title="Remove"
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        ) : (
          <div className="text-sm opacity-70">None yet.</div>
        )}
      </div>

      <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-2">
        <div className="md:col-span-6">
          <Input
            value={draft}
            onChange={setDraft}
            placeholder="e.g., peanuts"
          />
        </div>
        <div className="md:col-span-3">
          <Select
            value={draftSeverity}
            onChange={setDraftSeverity}
            options={[
              { value: "mild", label: "mild" },
              { value: "moderate", label: "moderate" },
              { value: "severe", label: "severe" },
            ]}
          />
        </div>
        <div className="md:col-span-3">
          <Button
            variant="ghost"
            onClick={add}
            disabled={!safeString(draft).trim()}
            className="w-full"
          >
            Add
          </Button>
        </div>
      </div>

      {filteredSuggestions.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {filteredSuggestions.map((s) => (
            <button
              type="button"
              key={s}
              onClick={() => setDraft(s)}
              className="text-xs rounded-full border border-gray-200 bg-gray-50 px-2 py-1 hover:bg-gray-100"
              title="Click to use"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Event payload builder
 * --------------------------------------------------------------------------- */

function buildEventPayload(household, prefs) {
  const payload = {
    householdId: household.id,
    updatedAt: prefs.updatedAt,
    snapshotHash: hashStable({ household, prefs }),
    taste: prefs.taste,
    constraints: prefs.constraints,
    likes: prefs.likes,
    avoids: prefs.avoids,
    allergies: prefs.allergies,
    rhythms: prefs.rhythms,
  };
  return payload;
}

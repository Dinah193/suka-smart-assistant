// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\inventory.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Component Inventory View
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Track on-hand components + preserved goods with readiness + shelf-life logic.
 *
 * What this page includes (production-ready, no external UI kit required):
 *  - Local Dexie DB tables:
 *      • homesteadInventory   (inventory lots / items)
 *      • inventoryMeta        (seed + settings)
 *  - Seeded starter inventory to demonstrate readiness + shelf-life computations
 *  - Add/Edit/Consume flows (lots + quantity units)
 *  - Search / filters / sort / pagination
 *  - Readiness model:
 *      • Ready now (and not expired)
 *      • Not ready (with readyOn date)
 *      • Expired / past best-by
 *  - Shelf-life model:
 *      • bestByDate (quality) + expiresOn (safety) supported
 *      • If only shelfLifeDays is provided, computed from packedOn/acquiredOn
 *  - Export/Import JSON (merge/replace) with validation + normalization
 *
 * Integration points:
 *  - Optional callback: onUse(item, delta, context)
 *  - Emits DOM events:
 *      window.dispatchEvent(new CustomEvent("ssa.hp.inventory.used", {detail}))
 *      window.dispatchEvent(new CustomEvent("ssa.hp.inventory.updated", {detail}))
 *
 * Notes:
 *  - This is browser-safe: no Node imports; won’t break Vite build.
 *  - Tailwind classes are used if present; otherwise the layout still works.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/inventory";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1";
const DB_VERSION = 1;

const DOMAIN = {
  COMPONENT: "component",
  PRESERVATION: "preservation",
};

const STATUS = {
  ACTIVE: "active",
  ARCHIVED: "archived",
};

const SORT = {
  UPDATED_DESC: "updated_desc",
  NAME_ASC: "name_asc",
  READY_SOON: "ready_soon",
  EXPIRY_SOON: "expiry_soon",
  QTY_DESC: "qty_desc",
};

const DEFAULT_PAGE_SIZE = 24;
const SEED_VERSION = "seed_2026-01-09_v1";

/* -----------------------------------------------------------------------------
 * Dexie DB
 * --------------------------------------------------------------------------- */

let _dbSingleton = null;

function getInventoryDb() {
  if (_dbSingleton) return _dbSingleton;

  const db = new Dexie(DB_NAME);

  // Keep schema stable; add db.version(n+1) for migrations.
  db.version(DB_VERSION).stores({
    // Inventory lots:
    // - id: unique
    // - domain: component | preservation
    // - nameLower for search
    // - readyOn, bestByDate, expiresOn for readiness/shelf-life queries
    // - tags as multi-entry index
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
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

function uid(prefix = "inv") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function safeArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function parseISODateOnly(isoOrDate) {
  const s = safeString(isoOrDate);
  if (!s) return null;
  // Accept YYYY-MM-DD or full ISO
  const d = new Date(s.length === 10 ? `${s}T00:00:00` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toDateOnlyISO(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : parseISODateOnly(d);
  if (!dt) return "";
  return dt.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = date instanceof Date ? date : parseISODateOnly(date);
  if (!d) return null;
  const out = new Date(d.getTime());
  out.setDate(out.getDate() + Number(days || 0));
  return out;
}

function diffDays(a, b) {
  // a - b in days
  const da = a instanceof Date ? a : parseISODateOnly(a);
  const db = b instanceof Date ? b : parseISODateOnly(b);
  if (!da || !db) return null;
  const ms = da.getTime() - db.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function emitSSAEvent(type, detail) {
  try {
    if (typeof window !== "undefined" && window.eventBus?.emit) {
      window.eventBus.emit(type, detail);
    }
  } catch (e) {
    // no-op
  }
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    }
  } catch (e) {
    // no-op
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

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

/* -----------------------------------------------------------------------------
 * Readiness + Shelf-life computation
 * --------------------------------------------------------------------------- */

function computeDatesFromShelfLife(item) {
  // If bestByDate/expiresOn already set, keep them.
  // If shelfLifeDays set and packedOn/acquiredOn exists, compute bestByDate.
  const packedOn = parseISODateOnly(item?.packedOn || item?.acquiredOn);
  const shelfLifeDays = Number(item?.shelfLifeDays);
  let bestByDate = parseISODateOnly(item?.bestByDate);
  let expiresOn = parseISODateOnly(item?.expiresOn);

  if (
    !bestByDate &&
    packedOn &&
    Number.isFinite(shelfLifeDays) &&
    shelfLifeDays > 0
  ) {
    bestByDate = addDays(packedOn, shelfLifeDays);
  }

  // Optional safetyDaysAfterBestBy to compute expiresOn
  const safetyDays = Number(item?.safetyDaysAfterBestBy);
  if (
    !expiresOn &&
    bestByDate &&
    Number.isFinite(safetyDays) &&
    safetyDays > 0
  ) {
    expiresOn = addDays(bestByDate, safetyDays);
  }

  return { bestByDate, expiresOn };
}

function computeReadiness(item, now = new Date()) {
  const readyOn = parseISODateOnly(item?.readyOn);
  const { bestByDate, expiresOn } = computeDatesFromShelfLife(item);

  const expired =
    (expiresOn && expiresOn.getTime() < now.getTime()) ||
    (item?.treatBestByAsExpiry &&
      bestByDate &&
      bestByDate.getTime() < now.getTime());

  const ready =
    (!readyOn || readyOn.getTime() <= now.getTime()) &&
    !expired &&
    (item?.quantity || 0) > 0;

  const daysUntilReady = readyOn ? diffDays(readyOn, now) : 0;
  const daysUntilBestBy = bestByDate ? diffDays(bestByDate, now) : null;
  const daysUntilExpiry = expiresOn ? diffDays(expiresOn, now) : null;

  return {
    readyOn,
    bestByDate,
    expiresOn,
    expired,
    ready,
    daysUntilReady,
    daysUntilBestBy,
    daysUntilExpiry,
  };
}

function readinessBadge(meta) {
  if (meta.expired) return { label: "Expired", tone: "danger" };
  if (meta.ready) return { label: "Ready", tone: "success" };
  if (meta.readyOn) return { label: "Not Ready", tone: "warn" };
  return { label: "In Stock", tone: "neutral" };
}

function shelfLifeBadge(meta) {
  if (meta.expired) return { label: "Past Date", tone: "danger" };

  // If expiresOn exists, use it as primary urgency indicator.
  if (meta.expiresOn) {
    const d = meta.daysUntilExpiry;
    if (d != null && d <= 7) return { label: "Expires ≤ 7d", tone: "danger" };
    if (d != null && d <= 21) return { label: "Expires ≤ 21d", tone: "warn" };
    return { label: "Within Date", tone: "success" };
  }

  // Otherwise bestByDate is quality indicator.
  if (meta.bestByDate) {
    const d = meta.daysUntilBestBy;
    if (d != null && d <= 7) return { label: "Best-by ≤ 7d", tone: "warn" };
    if (d != null && d <= 21)
      return { label: "Best-by ≤ 21d", tone: "neutral" };
    return { label: "Good", tone: "success" };
  }

  return { label: "No Date", tone: "neutral" };
}

/* -----------------------------------------------------------------------------
 * Seed Data
 * --------------------------------------------------------------------------- */

function getSeedInventory() {
  const today = new Date();
  const in7 = addDays(today, 7);
  const in21 = addDays(today, 21);
  const in3 = addDays(today, 3);
  const in2 = addDays(today, 2);

  return [
    // Components (not perishable)
    {
      id: "seed_inv_comp_screws",
      domain: DOMAIN.COMPONENT,
      category: "Hardware",
      name: 'Exterior Screws (3")',
      tags: ["hardware", "construction"],
      unit: "count",
      quantity: 450,
      minOnHand: 200,
      location: "Workshop • Fasteners bin",
      status: STATUS.ACTIVE,
      acquiredOn: toDateOnlyISO(addDays(today, -30)),
      notes: "Restock before big build weeks.",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: 'exterior screws (3")',
    },
    {
      id: "seed_inv_comp_lids",
      domain: DOMAIN.COMPONENT,
      category: "Canning Supplies",
      name: "Canning Lids (Regular Mouth)",
      tags: ["canning", "jars"],
      unit: "count",
      quantity: 48,
      minOnHand: 72,
      location: "Pantry • Canning shelf",
      status: STATUS.ACTIVE,
      acquiredOn: toDateOnlyISO(addDays(today, -10)),
      notes: "Buy in bulk when sales hit.",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "canning lids (regular mouth)",
    },

    // Preservation lots (with readiness + shelf-life)
    {
      id: "seed_inv_pres_kraut",
      domain: DOMAIN.PRESERVATION,
      category: "Fermentation",
      name: "Sauerkraut (1 qt jar)",
      tags: ["ferment", "cabbage", "probiotic"],
      unit: "jar",
      quantity: 3,
      minOnHand: 2,
      location: "Fridge • Ferments",
      status: STATUS.ACTIVE,
      packedOn: toDateOnlyISO(addDays(today, -5)),
      // not ready until day 7
      readyOn: toDateOnlyISO(in2),
      // quality best-by date
      bestByDate: toDateOnlyISO(in21),
      // optional safety expiry
      expiresOn: toDateOnlyISO(addDays(today, 45)),
      notes: "Keep submerged; keep cold once ready.",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "sauerkraut (1 qt jar)",
    },
    {
      id: "seed_inv_pres_jam",
      domain: DOMAIN.PRESERVATION,
      category: "Canning",
      name: "Strawberry Jam (8 oz jar)",
      tags: ["canning", "jam", "fruit"],
      unit: "jar",
      quantity: 10,
      minOnHand: 6,
      location: "Pantry • Preserves",
      status: STATUS.ACTIVE,
      packedOn: toDateOnlyISO(addDays(today, -120)),
      readyOn: toDateOnlyISO(addDays(today, -119)),
      shelfLifeDays: 365,
      safetyDaysAfterBestBy: 0, // quality only
      notes: "Rotate older jars to front.",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "strawberry jam (8 oz jar)",
    },
    {
      id: "seed_inv_pres_freezerveg",
      domain: DOMAIN.PRESERVATION,
      category: "Freezing",
      name: "Blanched Green Beans (1 lb bag)",
      tags: ["freezing", "vegetables"],
      unit: "bag",
      quantity: 4,
      minOnHand: 6,
      location: "Freezer • Drawer A",
      status: STATUS.ACTIVE,
      packedOn: toDateOnlyISO(addDays(today, -150)),
      shelfLifeDays: 365,
      notes: "Use oldest first.",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "blanched green beans (1 lb bag)",
    },
    {
      id: "seed_inv_pres_pickles",
      domain: DOMAIN.PRESERVATION,
      category: "Canning",
      name: "Dill Pickles (quart jar)",
      tags: ["canning", "pickles"],
      unit: "jar",
      quantity: 2,
      minOnHand: 4,
      location: "Pantry • Preserves",
      status: STATUS.ACTIVE,
      packedOn: toDateOnlyISO(addDays(today, -330)),
      // set bestBy close to now to show urgency
      bestByDate: toDateOnlyISO(in3),
      expiresOn: toDateOnlyISO(in7),
      notes: "If seal compromised, discard.",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "dill pickles (quart jar)",
    },
  ].map((x) => ({
    ...x,
    tags: uniq(x.tags),
    createdAt: x.createdAt || nowISO(),
    updatedAt: x.updatedAt || nowISO(),
    nameLower: normalizeLower(x.name),
  }));
}

/* -----------------------------------------------------------------------------
 * Normalization / Validation
 * --------------------------------------------------------------------------- */

function normalizeInventoryItem(raw) {
  const id = safeString(raw?.id).trim() || uid("inv");
  const domain =
    raw?.domain === DOMAIN.PRESERVATION
      ? DOMAIN.PRESERVATION
      : DOMAIN.COMPONENT;
  const name = safeString(raw?.name).trim();
  const category = safeString(raw?.category).trim();
  const status =
    safeString(raw?.status || STATUS.ACTIVE).trim() || STATUS.ACTIVE;

  const quantity = Number(raw?.quantity);
  const minOnHand =
    raw?.minOnHand == null || raw?.minOnHand === ""
      ? undefined
      : Number(raw?.minOnHand);
  const unit = safeString(raw?.unit || "").trim() || "unit";

  const tags = uniq(
    safeArray(raw?.tags)
      .map((t) => safeString(t).trim())
      .filter(Boolean)
  );

  const createdAt = raw?.createdAt || nowISO();
  const updatedAt = nowISO();

  const item = {
    id,
    domain,
    category,
    name,
    nameLower: normalizeLower(name),
    tags,
    unit,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    minOnHand: Number.isFinite(minOnHand) ? minOnHand : undefined,
    location: safeString(raw?.location),
    status,
    notes: safeString(raw?.notes),

    // dates
    acquiredOn: raw?.acquiredOn ? toDateOnlyISO(raw.acquiredOn) : "",
    packedOn: raw?.packedOn ? toDateOnlyISO(raw.packedOn) : "",
    readyOn: raw?.readyOn ? toDateOnlyISO(raw.readyOn) : "",
    bestByDate: raw?.bestByDate ? toDateOnlyISO(raw.bestByDate) : "",
    expiresOn: raw?.expiresOn ? toDateOnlyISO(raw.expiresOn) : "",
    shelfLifeDays:
      raw?.shelfLifeDays == null || raw?.shelfLifeDays === ""
        ? undefined
        : Number(raw.shelfLifeDays),
    safetyDaysAfterBestBy:
      raw?.safetyDaysAfterBestBy == null || raw?.safetyDaysAfterBestBy === ""
        ? undefined
        : Number(raw.safetyDaysAfterBestBy),

    treatBestByAsExpiry: !!raw?.treatBestByAsExpiry,

    // link back to catalog if you want
    catalogItemId: safeString(raw?.catalogItemId || ""),
    batchId: safeString(raw?.batchId || ""),
    createdAt,
    updatedAt,
  };

  const errors = [];
  if (!item.name) errors.push("Missing required field: name");
  if (!item.domain) errors.push("Missing required field: domain");

  // Dates should be valid if provided
  const dateFields = [
    "acquiredOn",
    "packedOn",
    "readyOn",
    "bestByDate",
    "expiresOn",
  ];
  for (const f of dateFields) {
    if (item[f]) {
      const dt = parseISODateOnly(item[f]);
      if (!dt) errors.push(`Invalid date for ${f}: ${item[f]}`);
    }
  }

  return { item, errors };
}

function validateImportPayload(payload) {
  if (!payload || typeof payload !== "object")
    return { ok: false, error: "Import JSON must be an object." };
  const items =
    payload.items || payload.homesteadInventory || payload.data || payload;
  if (!Array.isArray(items))
    return {
      ok: false,
      error: "Import JSON must contain an array at `items`.",
    };
  return { ok: true, items };
}

/* -----------------------------------------------------------------------------
 * DB helpers
 * --------------------------------------------------------------------------- */

async function ensureSeeded(db) {
  try {
    const meta = await db.inventoryMeta.get("seedVersion");
    if (meta?.value === SEED_VERSION) return;

    const count = await db.homesteadInventory.count();
    if (count === 0) {
      await db.homesteadInventory.bulkPut(getSeedInventory());
    }
    await db.inventoryMeta.put({
      key: "seedVersion",
      value: SEED_VERSION,
      updatedAt: nowISO(),
    });
  } catch (e) {
    console.warn("[HomesteadInventory] ensureSeeded failed:", e);
  }
}

async function getFacetValues(db) {
  const all = await db.homesteadInventory.toArray();
  const categories = uniq(
    all.map((x) => safeString(x.category)).filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const tags = uniq(
    all
      .flatMap((x) => x.tags || [])
      .map((x) => safeString(x))
      .filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const locations = uniq(
    all.map((x) => safeString(x.location)).filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const units = uniq(all.map((x) => safeString(x.unit)).filter(Boolean)).sort(
    (a, b) => a.localeCompare(b)
  );
  return { categories, tags, locations, units };
}

async function queryInventory({
  db,
  search,
  domainKey,
  category,
  tag,
  location,
  readinessFilter, // all | ready | not_ready | expired | low_stock
  sortKey,
  page,
  pageSize,
  includeArchived,
}) {
  const s = normalizeLower(search);
  const d = domainKey && domainKey !== "all" ? domainKey : null;
  const cat = normalizeLower(category);
  const t = normalizeLower(tag);
  const loc = normalizeLower(location);

  let coll = db.homesteadInventory.toCollection();
  if (d) coll = db.homesteadInventory.where("domain").equals(d).toCollection();

  const now = new Date();

  coll = coll.filter((it) => {
    if (!includeArchived && normalizeLower(it.status) === STATUS.ARCHIVED)
      return false;

    if (cat && normalizeLower(it.category) !== cat) return false;
    if (loc && normalizeLower(it.location) !== loc) return false;

    if (t) {
      const hasTag = (it.tags || []).some((x) => normalizeLower(x) === t);
      if (!hasTag) return false;
    }

    if (s) {
      const hay = [
        it.nameLower,
        normalizeLower(it.category),
        normalizeLower(it.location),
        normalizeLower(it.notes),
        (it.tags || []).map((x) => normalizeLower(x)).join(" "),
      ].join(" ");
      if (!hay.includes(s)) return false;
    }

    // readiness filtering
    const meta = computeReadiness(it, now);
    if (readinessFilter === "ready" && !meta.ready) return false;
    if (readinessFilter === "not_ready" && (meta.ready || meta.expired))
      return false;
    if (readinessFilter === "expired" && !meta.expired) return false;
    if (readinessFilter === "low_stock") {
      const min = Number(it.minOnHand);
      if (!Number.isFinite(min)) return false;
      if ((it.quantity || 0) >= min) return false;
    }

    return true;
  });

  let items = await coll.toArray();

  // Attach meta for sorting/display (don’t store)
  const withMeta = items.map((it) => ({
    ...it,
    _meta: computeReadiness(it, now),
  }));

  withMeta.sort((a, b) => {
    const an = safeString(a.nameLower);
    const bn = safeString(b.nameLower);
    const au = safeString(a.updatedAt);
    const bu = safeString(b.updatedAt);

    switch (sortKey) {
      case SORT.NAME_ASC:
        return an.localeCompare(bn);
      case SORT.QTY_DESC:
        return (b.quantity || 0) - (a.quantity || 0) || an.localeCompare(bn);
      case SORT.READY_SOON: {
        const ar = a._meta?.readyOn ? parseISODateOnly(a._meta.readyOn) : null;
        const br = b._meta?.readyOn ? parseISODateOnly(b._meta.readyOn) : null;
        const aT = ar ? ar.getTime() : Number.MAX_SAFE_INTEGER;
        const bT = br ? br.getTime() : Number.MAX_SAFE_INTEGER;
        return aT - bT || an.localeCompare(bn);
      }
      case SORT.EXPIRY_SOON: {
        const aE = a._meta?.expiresOn || a._meta?.bestByDate;
        const bE = b._meta?.expiresOn || b._meta?.bestByDate;
        const aD = aE
          ? parseISODateOnly(aE)?.getTime() ?? Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER;
        const bD = bE
          ? parseISODateOnly(bE)?.getTime() ?? Number.MAX_SAFE_INTEGER
          : Number.MAX_SAFE_INTEGER;
        return aD - bD || an.localeCompare(bn);
      }
      case SORT.UPDATED_DESC:
      default:
        return bu.localeCompare(au);
    }
  });

  const total = withMeta.length;
  const ps = clamp(pageSize || DEFAULT_PAGE_SIZE, 6, 120);
  const p = clamp(page || 1, 1, Math.max(1, Math.ceil(total / ps)));
  const start = (p - 1) * ps;
  const end = start + ps;

  return { items: withMeta.slice(start, end), total, page: p, pageSize: ps };
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
      type="button"
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

function Textarea({ value, onChange, placeholder, rows = 6 }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:border-black"
    />
  );
}

function Drawer({ open, onClose, children, widthClass = "max-w-xl" }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[75]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={cx(
          "absolute right-0 top-0 h-full w-full bg-white shadow-2xl border-l border-gray-200 overflow-y-auto",
          widthClass
        )}
        style={{ maxWidth: "720px" }}
      >
        {children}
      </div>
    </div>
  );
}

function ModalShell({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-4xl rounded-2xl bg-white shadow-xl border border-gray-200 overflow-hidden">
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

/* -----------------------------------------------------------------------------
 * Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerInventoryPage({ onUse }) {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  // Query state
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [domainKey, setDomainKey] = useState("all");
  const [category, setCategory] = useState("");
  const [tag, setTag] = useState("");
  const [location, setLocation] = useState("");
  const [readinessFilter, setReadinessFilter] = useState("all");
  const [sortKey, setSortKey] = useState(SORT.UPDATED_DESC);
  const [includeArchived, setIncludeArchived] = useState(false);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // Results
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);

  // Facets
  const [facets, setFacets] = useState({
    categories: [],
    tags: [],
    locations: [],
    units: [],
  });

  // UI state
  const [selected, setSelected] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState(null);

  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const db = getInventoryDb();
    dbRef.current = db;

    (async () => {
      try {
        await ensureSeeded(db);
        await db.homesteadInventory.limit(1).toArray();
        setFacets(await getFacetValues(db));
        setReady(true);
      } catch (e) {
        console.warn("[HomesteadInventory] init failed:", e);
        setDbError(
          "Inventory storage isn’t available (IndexedDB blocked/unavailable)."
        );
        setReady(true);
      }
    })();
  }, []);

  // Reset page when filters change
  useEffect(() => {
    setPage(1);
  }, [
    searchDebounced,
    domainKey,
    category,
    tag,
    location,
    readinessFilter,
    sortKey,
    pageSize,
    includeArchived,
  ]);

  // Query effect
  useEffect(() => {
    if (!ready) return;
    const db = dbRef.current;
    if (!db || dbError) {
      setItems([]);
      setTotal(0);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await queryInventory({
          db,
          search: searchDebounced,
          domainKey,
          category,
          tag,
          location,
          readinessFilter,
          sortKey,
          page,
          pageSize,
          includeArchived,
        });
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      } catch (e) {
        console.warn("[HomesteadInventory] query failed:", e);
        if (cancelled) return;
        setItems([]);
        setTotal(0);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    ready,
    dbError,
    searchDebounced,
    domainKey,
    category,
    tag,
    location,
    readinessFilter,
    sortKey,
    page,
    pageSize,
    includeArchived,
  ]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((total || 0) / pageSize)),
    [total, pageSize]
  );

  const summary = useMemo(() => {
    const now = new Date();
    let readyCount = 0;
    let notReadyCount = 0;
    let expiredCount = 0;
    let lowStockCount = 0;

    for (const it of items) {
      const meta = it._meta || computeReadiness(it, now);
      const min = Number(it.minOnHand);
      if (meta.expired) expiredCount += 1;
      else if (meta.ready) readyCount += 1;
      else if (meta.readyOn) notReadyCount += 1;

      if (Number.isFinite(min) && (it.quantity || 0) < min) lowStockCount += 1;
    }

    return { readyCount, notReadyCount, expiredCount, lowStockCount };
  }, [items]);

  function pushToast(message, kind = "info") {
    setToast({ message, kind, at: Date.now() });
    setTimeout(() => setToast(null), 2200);
  }

  async function refreshFacets() {
    const db = dbRef.current;
    if (!db || dbError) return;
    try {
      setFacets(await getFacetValues(db));
    } catch (e) {
      // ignore
    }
  }

  function openCreate(domain = DOMAIN.COMPONENT) {
    setEditDraft({
      id: "",
      domain,
      category: "",
      name: "",
      tags: [],
      unit: "unit",
      quantity: 0,
      minOnHand: "",
      location: "",
      status: STATUS.ACTIVE,
      notes: "",
      acquiredOn: "",
      packedOn: "",
      readyOn: "",
      bestByDate: "",
      expiresOn: "",
      shelfLifeDays: "",
      safetyDaysAfterBestBy: "",
      treatBestByAsExpiry: false,
      catalogItemId: "",
      batchId: "",
    });
    setEditOpen(true);
  }

  function openEdit(item) {
    setEditDraft({
      ...item,
      minOnHand: item?.minOnHand ?? "",
      shelfLifeDays: item?.shelfLifeDays ?? "",
      safetyDaysAfterBestBy: item?.safetyDaysAfterBestBy ?? "",
      // strip computed meta
      _meta: undefined,
    });
    setEditOpen(true);
  }

  async function saveDraft(draft) {
    const db = dbRef.current;
    if (!db || dbError) return;

    const { item, errors } = normalizeInventoryItem(draft);
    if (errors.length) {
      pushToast(errors[0], "error");
      return;
    }

    try {
      const existing = await db.homesteadInventory.get(item.id);
      if (existing?.createdAt) item.createdAt = existing.createdAt;
      await db.homesteadInventory.put(item);

      setEditOpen(false);
      setEditDraft(null);
      pushToast("Saved.", "success");
      await refreshFacets();

      emitSSAEvent("ssa.hp.inventory.updated", {
        source: PAGE_SOURCE,
        item,
        at: nowISO(),
      });

      if (selected?.id === item.id) setSelected(item);
    } catch (e) {
      console.warn("[HomesteadInventory] save failed:", e);
      pushToast("Save failed.", "error");
    }
  }

  async function deleteItem(item) {
    const db = dbRef.current;
    if (!db || dbError) return;

    const ok = window.confirm(`Delete "${item.name}" from inventory?`);
    if (!ok) return;

    try {
      await db.homesteadInventory.delete(item.id);
      if (selected?.id === item.id) setSelected(null);
      pushToast("Deleted.", "success");
      await refreshFacets();
      emitSSAEvent("ssa.hp.inventory.updated", {
        source: PAGE_SOURCE,
        item: { ...item, deleted: true },
        at: nowISO(),
      });
    } catch (e) {
      console.warn("[HomesteadInventory] delete failed:", e);
      pushToast("Delete failed.", "error");
    }
  }

  async function consumeItem(item, amount) {
    const db = dbRef.current;
    if (!db || dbError) return;

    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta <= 0) {
      pushToast("Enter a positive amount to consume.", "error");
      return;
    }

    const current = await db.homesteadInventory.get(item.id);
    if (!current) return;

    const newQty = Math.max(0, (current.quantity || 0) - delta);
    const updated = { ...current, quantity: newQty, updatedAt: nowISO() };

    try {
      await db.homesteadInventory.put(updated);
      pushToast(`Consumed ${delta} ${current.unit}.`, "success");

      emitSSAEvent("ssa.hp.inventory.used", {
        source: PAGE_SOURCE,
        itemId: current.id,
        name: current.name,
        unit: current.unit,
        delta,
        newQty,
        at: nowISO(),
      });

      try {
        await onUse?.(current, delta, { source: PAGE_SOURCE });
      } catch (e) {
        // ignore
      }

      if (selected?.id === current.id) setSelected(updated);
      await refreshFacets();
    } catch (e) {
      console.warn("[HomesteadInventory] consume failed:", e);
      pushToast("Consume failed.", "error");
    }
  }

  async function exportJSON() {
    const db = dbRef.current;
    if (!db || dbError) return;

    try {
      const all = await db.homesteadInventory.toArray();
      const payload = {
        type: "SSA_HomesteadPlanner_Inventory",
        version: 1,
        seedVersion: SEED_VERSION,
        exportedAt: nowISO(),
        items: all,
      };
      downloadJSON(
        `ssa-homestead-inventory-${new Date().toISOString().slice(0, 10)}.json`,
        payload
      );
      pushToast("Exported JSON.", "success");
    } catch (e) {
      console.warn("[HomesteadInventory] export failed:", e);
      pushToast("Export failed.", "error");
    }
  }

  async function importJSON({ jsonText, mode }) {
    const db = dbRef.current;
    if (!db || dbError) return;

    const parsed = tryParseJSON(jsonText);
    if (!parsed.ok) {
      pushToast("Invalid JSON.", "error");
      return;
    }

    const chk = validateImportPayload(parsed.value);
    if (!chk.ok) {
      pushToast(chk.error, "error");
      return;
    }

    const incoming = chk.items;
    const normalized = [];
    const problems = [];

    for (const raw of incoming) {
      const { item, errors } = normalizeInventoryItem(raw);
      if (errors.length) problems.push({ id: raw?.id, errors });
      else normalized.push(item);
    }

    if (normalized.length === 0) {
      pushToast("No valid items found to import.", "error");
      return;
    }

    try {
      if (mode === "replace") {
        await db.transaction("rw", db.homesteadInventory, async () => {
          await db.homesteadInventory.clear();
          await db.homesteadInventory.bulkPut(normalized);
        });
      } else {
        await db.homesteadInventory.bulkPut(normalized);
      }

      setImportOpen(false);
      await refreshFacets();
      pushToast(`Imported ${normalized.length} item(s).`, "success");

      if (problems.length)
        console.warn("[HomesteadInventory] import problems:", problems);

      emitSSAEvent("ssa.hp.inventory.updated", {
        source: PAGE_SOURCE,
        imported: normalized.length,
        at: nowISO(),
      });
    } catch (e) {
      console.warn("[HomesteadInventory] import failed:", e);
      pushToast("Import failed.", "error");
    }
  }

  const headerSubtitle = useMemo(() => {
    const filters = [
      domainKey !== "all" ? domainKey : null,
      category ? `Category: ${category}` : null,
      tag ? `Tag: ${tag}` : null,
      location ? `Location: ${location}` : null,
      readinessFilter !== "all"
        ? `Filter: ${readinessFilter.replaceAll("_", " ")}`
        : null,
      includeArchived ? "Including archived" : null,
    ].filter(Boolean);
    if (!filters.length && !searchDebounced)
      return "Track readiness and shelf-life for components and preserved goods.";
    return [searchDebounced ? `Search: "${searchDebounced}"` : null, ...filters]
      .filter(Boolean)
      .join(" • ");
  }, [
    domainKey,
    category,
    tag,
    location,
    readinessFilter,
    includeArchived,
    searchDebounced,
  ]);

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">
              Component Inventory
            </h1>
            <div className="text-sm opacity-80 mt-1">{headerSubtitle}</div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              Import/Export
            </Button>
            <Button
              variant="ghost"
              onClick={() => openCreate(DOMAIN.COMPONENT)}
            >
              + Component
            </Button>
            <Button
              variant="ghost"
              onClick={() => openCreate(DOMAIN.PRESERVATION)}
            >
              + Preserved Lot
            </Button>
          </div>
        </div>

        {dbError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="font-bold text-red-800">
              Inventory storage unavailable
            </div>
            <div className="text-red-800 mt-1">{dbError}</div>
          </div>
        ) : null}

        {/* Controls */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-5">
            <FieldLabel>Search</FieldLabel>
            <Input
              value={search}
              onChange={setSearch}
              placeholder="Search name, category, tags, location, notes..."
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel>Domain</FieldLabel>
            <Select
              value={domainKey}
              onChange={setDomainKey}
              options={[
                { value: "all", label: "All" },
                { value: DOMAIN.COMPONENT, label: "Components" },
                { value: DOMAIN.PRESERVATION, label: "Preservation" },
              ]}
            />
          </div>

          <div className="lg:col-span-3">
            <FieldLabel>Readiness</FieldLabel>
            <Select
              value={readinessFilter}
              onChange={setReadinessFilter}
              options={[
                { value: "all", label: "All" },
                { value: "ready", label: "Ready now" },
                { value: "not_ready", label: "Not ready yet" },
                { value: "expired", label: "Expired / past date" },
                { value: "low_stock", label: "Low stock" },
              ]}
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel>Sort</FieldLabel>
            <Select
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: SORT.UPDATED_DESC, label: "Updated (new → old)" },
                { value: SORT.NAME_ASC, label: "Name (A → Z)" },
                { value: SORT.QTY_DESC, label: "Quantity (high → low)" },
                { value: SORT.READY_SOON, label: "Ready soon" },
                { value: SORT.EXPIRY_SOON, label: "Expiry/Best-by soon" },
              ]}
            />
          </div>
        </div>

        {/* Facets */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-4">
            <FieldLabel>Category</FieldLabel>
            <Select
              value={category}
              onChange={setCategory}
              options={[
                { value: "", label: "All categories" },
                ...facets.categories.map((c) => ({ value: c, label: c })),
              ]}
            />
          </div>
          <div className="md:col-span-3">
            <FieldLabel>Tag</FieldLabel>
            <Select
              value={tag}
              onChange={setTag}
              options={[
                { value: "", label: "All tags" },
                ...facets.tags.map((t) => ({ value: t, label: t })),
              ]}
            />
          </div>
          <div className="md:col-span-3">
            <FieldLabel>Location</FieldLabel>
            <Select
              value={location}
              onChange={setLocation}
              options={[
                { value: "", label: "All locations" },
                ...facets.locations.map((l) => ({ value: l, label: l })),
              ]}
            />
          </div>
          <div className="md:col-span-2">
            <FieldLabel>Page size</FieldLabel>
            <Select
              value={String(pageSize)}
              onChange={(v) => setPageSize(Number(v))}
              options={[12, 24, 36, 48, 72].map((n) => ({
                value: String(n),
                label: String(n),
              }))}
            />
          </div>
        </div>

        {/* Toggles */}
        <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone="success" title="Ready now">
              {summary.readyCount} ready
            </Badge>
            <Badge tone="warn" title="Not ready yet">
              {summary.notReadyCount} not ready
            </Badge>
            <Badge tone="danger" title="Expired/past date">
              {summary.expiredCount} expired
            </Badge>
            <Badge tone="neutral" title="Low stock among visible results">
              {summary.lowStockCount} low stock
            </Badge>
          </div>

          <label className="text-sm flex items-center gap-2 select-none">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
            Include archived
          </label>
        </div>

        {/* Pager */}
        <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm opacity-80">
            Showing <b>{items.length}</b> of <b>{total}</b>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← Prev
            </Button>
            <div className="text-sm">
              Page <b>{page}</b> / <b>{Math.max(1, totalPages)}</b>
            </div>
            <Button
              variant="ghost"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next →
            </Button>
          </div>
        </div>

        {/* Grid */}
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {items.map((it) => (
            <InventoryCard
              key={it.id}
              item={it}
              onOpen={() => setSelected(it)}
              onQuickUse={() => consumeItem(it, 1)}
            />
          ))}
        </div>

        {/* Empty */}
        {ready && !dbError && items.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-gray-200 p-6">
            <div className="font-bold">No matching inventory</div>
            <div className="text-sm opacity-80 mt-1">
              Try clearing filters, adding items, or importing an inventory
              JSON.
            </div>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <Button variant="ghost" onClick={() => setImportOpen(true)}>
                Import/Export
              </Button>
              <Button
                variant="ghost"
                onClick={() => openCreate(DOMAIN.COMPONENT)}
              >
                + Component
              </Button>
              <Button
                variant="ghost"
                onClick={() => openCreate(DOMAIN.PRESERVATION)}
              >
                + Preserved Lot
              </Button>
            </div>
          </div>
        ) : null}

        {/* Drawer */}
        <Drawer open={!!selected} onClose={() => setSelected(null)}>
          {selected ? (
            <InventoryDrawer
              item={selected}
              onClose={() => setSelected(null)}
              onEdit={() => openEdit(selected)}
              onDelete={() => deleteItem(selected)}
              onConsume={(amt) => consumeItem(selected, amt)}
            />
          ) : null}
        </Drawer>

        {/* Edit modal */}
        <EditInventoryModal
          open={editOpen}
          draft={editDraft}
          facets={facets}
          onClose={() => {
            setEditOpen(false);
            setEditDraft(null);
          }}
          onSave={saveDraft}
        />

        {/* Import/export modal */}
        <ImportExportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onExport={exportJSON}
          onImport={importJSON}
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
 * Cards + Drawer
 * --------------------------------------------------------------------------- */

function InventoryCard({ item, onOpen, onQuickUse }) {
  const meta = item._meta || computeReadiness(item, new Date());
  const r = readinessBadge(meta);
  const s = shelfLifeBadge(meta);

  const min = Number(item.minOnHand);
  const lowStock = Number.isFinite(min) && (item.quantity || 0) < min;

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold opacity-70">
            {item.domain === DOMAIN.PRESERVATION ? "Preservation" : "Component"}
          </div>
          <div
            className="font-black text-base leading-snug mt-1 truncate"
            title={item.name}
          >
            {item.name}
          </div>
          <div className="text-xs opacity-70 mt-1 truncate">
            {item.category ? `• ${item.category}` : ""}{" "}
            {item.location ? `• ${item.location}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onOpen}>
            Details
          </Button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Badge tone={r.tone}>{r.label}</Badge>
        <Badge tone={s.tone}>{s.label}</Badge>
        {lowStock ? (
          <Badge tone="danger" title={`Below min on hand (${min})`}>
            Low stock
          </Badge>
        ) : null}
      </div>

      <div className="mt-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="opacity-80">Quantity</span>
          <b>
            {Number(item.quantity || 0).toLocaleString()} {item.unit || "unit"}
          </b>
        </div>

        {item.domain === DOMAIN.PRESERVATION ? (
          <div className="mt-2 text-xs opacity-80 space-y-1">
            {meta.readyOn ? (
              <div>
                Ready on: <b>{toDateOnlyISO(meta.readyOn)}</b>{" "}
                {meta.daysUntilReady != null && meta.daysUntilReady > 0
                  ? `(${meta.daysUntilReady}d)`
                  : ""}
              </div>
            ) : null}
            {meta.bestByDate ? (
              <div>
                Best-by: <b>{toDateOnlyISO(meta.bestByDate)}</b>{" "}
                {meta.daysUntilBestBy != null
                  ? `(${meta.daysUntilBestBy}d)`
                  : ""}
              </div>
            ) : null}
            {meta.expiresOn ? (
              <div>
                Expires: <b>{toDateOnlyISO(meta.expiresOn)}</b>{" "}
                {meta.daysUntilExpiry != null
                  ? `(${meta.daysUntilExpiry}d)`
                  : ""}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="text-xs opacity-70">
          Updated: {safeString(item.updatedAt).slice(0, 10)}
        </div>
        <Button
          variant="ghost"
          onClick={onQuickUse}
          disabled={(item.quantity || 0) <= 0}
          title="Consume 1 unit"
        >
          Use 1
        </Button>
      </div>
    </div>
  );
}

function InventoryDrawer({ item, onClose, onEdit, onDelete, onConsume }) {
  const [consumeAmt, setConsumeAmt] = useState("1");
  const meta = computeReadiness(item, new Date());
  const r = readinessBadge(meta);
  const s = shelfLifeBadge(meta);

  const min = Number(item.minOnHand);
  const lowStock = Number.isFinite(min) && (item.quantity || 0) < min;

  useEffect(() => {
    setConsumeAmt("1");
  }, [item?.id]);

  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold opacity-70">
            {item.domain === DOMAIN.PRESERVATION ? "Preservation" : "Component"}
          </div>
          <div className="text-xl font-black leading-tight mt-1">
            {item.name}
          </div>
          <div className="text-sm opacity-80 mt-1">
            {item.category ? (
              <span className="mr-2">
                Category: <b>{item.category}</b>
              </span>
            ) : null}
            {item.location ? (
              <span className="mr-2">
                Location: <b>{item.location}</b>
              </span>
            ) : null}
            {item.status ? (
              <span>
                Status: <b>{item.status}</b>
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border px-2 py-1 text-sm"
        >
          ✕
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <Badge tone={r.tone}>{r.label}</Badge>
        <Badge tone={s.tone}>{s.label}</Badge>
        {lowStock ? <Badge tone="danger">Low stock</Badge> : null}
      </div>

      <div className="mt-4 rounded-2xl border border-gray-200 p-4">
        <div className="font-bold text-sm mb-2">Quantity</div>
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm opacity-80">On hand</div>
          <div className="text-lg font-black">
            {Number(item.quantity || 0).toLocaleString()} {item.unit || "unit"}
          </div>
        </div>
        {Number.isFinite(min) ? (
          <div className="text-xs opacity-70 mt-1">
            Min on hand: <b>{min}</b> {item.unit || "unit"}
          </div>
        ) : null}

        <div className="mt-3 grid grid-cols-12 gap-2 items-end">
          <div className="col-span-7">
            <FieldLabel>Consume amount</FieldLabel>
            <Input
              value={consumeAmt}
              onChange={setConsumeAmt}
              type="number"
              placeholder="e.g., 1"
            />
          </div>
          <div className="col-span-5">
            <Button
              className="w-full"
              variant="ghost"
              onClick={() => onConsume?.(consumeAmt)}
              disabled={(item.quantity || 0) <= 0}
              title="Reduce quantity"
            >
              Consume
            </Button>
          </div>
        </div>
      </div>

      {item.domain === DOMAIN.PRESERVATION ? (
        <div className="mt-4 rounded-2xl border border-gray-200 p-4">
          <div className="font-bold text-sm mb-2">Readiness & Shelf Life</div>

          <div className="text-sm space-y-2">
            <Row label="Packed on" value={item.packedOn || "—"} />
            <Row label="Acquired on" value={item.acquiredOn || "—"} />
            <Row label="Ready on" value={item.readyOn || "—"} />
            <Row
              label="Best-by"
              value={
                item.bestByDate ||
                (item.shelfLifeDays ? `computed (${item.shelfLifeDays}d)` : "—")
              }
            />
            <Row
              label="Expires on"
              value={
                item.expiresOn ||
                (item.safetyDaysAfterBestBy
                  ? `computed (+${item.safetyDaysAfterBestBy}d)`
                  : "—")
              }
            />
            {meta.bestByDate ? (
              <Row
                label="Days until best-by"
                value={String(meta.daysUntilBestBy ?? "—")}
              />
            ) : null}
            {meta.expiresOn ? (
              <Row
                label="Days until expiry"
                value={String(meta.daysUntilExpiry ?? "—")}
              />
            ) : null}
          </div>

          {meta.expired ? (
            <div className="mt-3 text-sm rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
              This lot is past its date. Consider discarding or reviewing safety
              notes.
            </div>
          ) : null}
        </div>
      ) : null}

      {item.tags?.length ? (
        <div className="mt-4 rounded-2xl border border-gray-200 p-4">
          <div className="font-bold text-sm mb-2">Tags</div>
          <div className="flex flex-wrap gap-2">
            {item.tags.map((t) => (
              <span
                key={t}
                className="text-xs rounded-full border border-gray-200 px-2 py-1"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {item.notes ? (
        <div className="mt-4 rounded-2xl border border-gray-200 p-4">
          <div className="font-bold text-sm mb-2">Notes</div>
          <div className="text-sm whitespace-pre-wrap">{item.notes}</div>
        </div>
      ) : null}

      <div className="mt-4 rounded-2xl border border-gray-200 p-4">
        <div className="font-bold text-sm mb-2">Actions</div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button onClick={onEdit} variant="ghost">
            Edit
          </Button>
          <Button onClick={onDelete} variant="danger">
            Delete
          </Button>
        </div>
        <div className="text-xs opacity-70 mt-2">
          ID: {item.id} • Updated:{" "}
          {safeString(item.updatedAt).slice(0, 19).replace("T", " ")}
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="opacity-80">{label}</span>
      <b className="text-right">{value}</b>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Edit Modal
 * --------------------------------------------------------------------------- */

function EditInventoryModal({ open, draft, facets, onClose, onSave }) {
  const [local, setLocal] = useState(draft);

  useEffect(() => setLocal(draft), [draft]);

  function setField(path, value) {
    setLocal((prev) => {
      const next = { ...(prev || {}) };
      const parts = path.split(".");
      let cur = next;
      for (let i = 0; i < parts.length - 1; i++) {
        const k = parts[i];
        cur[k] = cur[k] && typeof cur[k] === "object" ? { ...cur[k] } : {};
        cur = cur[k];
      }
      cur[parts[parts.length - 1]] = value;
      return next;
    });
  }

  function setList(path, text) {
    const arr = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    setField(path, arr);
  }

  if (!open) return null;
  const isEdit = !!(local && local.id);

  return (
    <ModalShell
      open={open}
      title={isEdit ? "Edit Inventory Item" : "Add Inventory Item"}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs opacity-70">
            Tip: For preserved lots, use <b>packed on</b> +{" "}
            <b>shelf life days</b> OR set best-by/expires directly.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => onSave?.(local)}>Save</Button>
          </div>
        </div>
      }
    >
      {!local ? null : (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-3">
            <FieldLabel>Domain</FieldLabel>
            <Select
              value={local.domain || DOMAIN.COMPONENT}
              onChange={(v) => setField("domain", v)}
              options={[
                { value: DOMAIN.COMPONENT, label: "Component" },
                { value: DOMAIN.PRESERVATION, label: "Preservation" },
              ]}
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Name *</FieldLabel>
            <Input
              value={local.name || ""}
              onChange={(v) => setField("name", v)}
              placeholder="e.g., Canning lids, Strawberry jam (8 oz jar)..."
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Category</FieldLabel>
            <Input
              value={local.category || ""}
              onChange={(v) => setField("category", v)}
              placeholder="e.g., Hardware, Canning, Freezing"
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Unit</FieldLabel>
            <Input
              value={local.unit || ""}
              onChange={(v) => setField("unit", v)}
              placeholder="e.g., jar, bag, count"
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Quantity</FieldLabel>
            <Input
              type="number"
              value={String(local.quantity ?? 0)}
              onChange={(v) => setField("quantity", v)}
              placeholder="0"
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Min on hand</FieldLabel>
            <Input
              type="number"
              value={String(local.minOnHand ?? "")}
              onChange={(v) => setField("minOnHand", v)}
              placeholder="(optional)"
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Status</FieldLabel>
            <Select
              value={local.status || STATUS.ACTIVE}
              onChange={(v) => setField("status", v)}
              options={[
                { value: STATUS.ACTIVE, label: "active" },
                { value: STATUS.ARCHIVED, label: "archived" },
              ]}
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Location</FieldLabel>
            <Input
              value={local.location || ""}
              onChange={(v) => setField("location", v)}
              placeholder="e.g., Pantry • Preserves, Freezer • Drawer A"
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Tags (one per line)</FieldLabel>
            <Textarea
              value={(local.tags || []).join("\n")}
              onChange={(v) => setList("tags", v)}
              rows={5}
              placeholder={"canning\njars\nhardware\n..."}
            />
          </div>

          <div className="md:col-span-12">
            <FieldLabel>Notes</FieldLabel>
            <Textarea
              value={local.notes || ""}
              onChange={(v) => setField("notes", v)}
              rows={4}
              placeholder="Optional notes…"
            />
          </div>

          <div className="md:col-span-12">
            <div className="rounded-2xl border border-gray-200 p-4">
              <div className="font-bold text-sm mb-2">Dates & Shelf Life</div>

              <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
                <div className="md:col-span-3">
                  <FieldLabel>Acquired on</FieldLabel>
                  <Input
                    type="date"
                    value={local.acquiredOn || ""}
                    onChange={(v) => setField("acquiredOn", v)}
                  />
                </div>
                <div className="md:col-span-3">
                  <FieldLabel>Packed on</FieldLabel>
                  <Input
                    type="date"
                    value={local.packedOn || ""}
                    onChange={(v) => setField("packedOn", v)}
                  />
                </div>
                <div className="md:col-span-3">
                  <FieldLabel>Ready on</FieldLabel>
                  <Input
                    type="date"
                    value={local.readyOn || ""}
                    onChange={(v) => setField("readyOn", v)}
                  />
                </div>
                <div className="md:col-span-3">
                  <FieldLabel>Best-by date</FieldLabel>
                  <Input
                    type="date"
                    value={local.bestByDate || ""}
                    onChange={(v) => setField("bestByDate", v)}
                  />
                </div>

                <div className="md:col-span-3">
                  <FieldLabel>Expires on</FieldLabel>
                  <Input
                    type="date"
                    value={local.expiresOn || ""}
                    onChange={(v) => setField("expiresOn", v)}
                  />
                </div>
                <div className="md:col-span-3">
                  <FieldLabel>Shelf life days</FieldLabel>
                  <Input
                    type="number"
                    value={String(local.shelfLifeDays ?? "")}
                    onChange={(v) => setField("shelfLifeDays", v)}
                    placeholder="e.g., 365"
                  />
                </div>
                <div className="md:col-span-3">
                  <FieldLabel>Safety days after best-by</FieldLabel>
                  <Input
                    type="number"
                    value={String(local.safetyDaysAfterBestBy ?? "")}
                    onChange={(v) => setField("safetyDaysAfterBestBy", v)}
                    placeholder="e.g., 30"
                  />
                </div>
                <div className="md:col-span-3 flex items-end">
                  <label className="text-sm flex items-center gap-2 select-none">
                    <input
                      type="checkbox"
                      checked={!!local.treatBestByAsExpiry}
                      onChange={(e) =>
                        setField("treatBestByAsExpiry", e.target.checked)
                      }
                    />
                    Treat best-by as expiry
                  </label>
                </div>

                <div className="md:col-span-12 text-xs opacity-70">
                  If you provide <b>shelf life days</b>, the system computes
                  best-by from packed/acquired date. If you provide
                  <b> safety days after best-by</b>, it computes an expiry date.
                </div>
              </div>
            </div>
          </div>

          {isEdit ? (
            <div className="md:col-span-12">
              <FieldLabel>ID (read-only)</FieldLabel>
              <div className="rounded-lg border border-gray-200 px-3 py-2 text-sm bg-gray-50">
                {local.id}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </ModalShell>
  );
}

/* -----------------------------------------------------------------------------
 * Import / Export Modal
 * --------------------------------------------------------------------------- */

function ImportExportModal({ open, onClose, onExport, onImport }) {
  const [mode, setMode] = useState("merge");
  const [text, setText] = useState("");
  const [exampleOpen, setExampleOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setText("");
      setExampleOpen(false);
      setMode("merge");
    }
  }, [open]);

  const examplePayload = useMemo(
    () => ({
      type: "SSA_HomesteadPlanner_Inventory",
      version: 1,
      exportedAt: nowISO(),
      items: [
        {
          id: "my_inv_jerky",
          domain: "preservation",
          category: "Dehydrating",
          name: "Beef Jerky (1 lb bag)",
          tags: ["dehydrating", "jerky"],
          unit: "bag",
          quantity: 2,
          minOnHand: 4,
          location: "Pantry • Snacks",
          packedOn: toDateOnlyISO(new Date()),
          readyOn: toDateOnlyISO(new Date()),
          shelfLifeDays: 60,
          safetyDaysAfterBestBy: 0,
          notes: "Use within 2 months for best quality.",
          status: "active",
        },
      ],
    }),
    []
  );

  if (!open) return null;

  return (
    <ModalShell
      open={open}
      title="Import / Export Inventory"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onExport}>
              Export JSON
            </Button>
            <Button
              onClick={() => onImport?.({ jsonText: text, mode })}
              disabled={!text.trim()}
            >
              Import
            </Button>
          </div>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
        <div className="md:col-span-4">
          <FieldLabel>Import mode</FieldLabel>
          <Select
            value={mode}
            onChange={setMode}
            options={[
              { value: "merge", label: "Merge (upsert)" },
              { value: "replace", label: "Replace (clear then import)" },
            ]}
          />
          <div className="text-xs opacity-70 mt-2">
            Merge updates matching IDs and adds new ones. Replace clears your
            inventory first.
          </div>

          <div className="mt-3">
            <Button
              variant="ghost"
              onClick={() => {
                setExampleOpen((v) => !v);
                if (!exampleOpen)
                  setText(JSON.stringify(examplePayload, null, 2));
              }}
            >
              {exampleOpen ? "Hide Example" : "Load Example"}
            </Button>
          </div>
        </div>

        <div className="md:col-span-8">
          <FieldLabel>Paste inventory JSON</FieldLabel>
          <Textarea
            value={text}
            onChange={setText}
            rows={14}
            placeholder='{"items":[{...}]}'
          />
          <div className="text-xs opacity-70 mt-2">
            Expected shape: object with <b>items</b> array (or directly an
            array). Each item needs at least <b>name</b> and <b>domain</b>.
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

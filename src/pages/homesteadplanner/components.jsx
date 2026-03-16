// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\components.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Components & Preservation Catalog Browser
 * -----------------------------------------------------------------------------
 * What this page provides (production-ready, drop-in):
 *  - Dexie-backed local catalog (components + preservation methods)
 *  - Seeded starter library (safe to extend / replace via Import)
 *  - Search (name/description/tags/category), filters, sorting, pagination
 *  - Item detail drawer with “Add to Plan” hooks (callback + safe event emit)
 *  - Create/Edit/Delete catalog items (local-only; no server required)
 *  - Import/Export JSON (with validation + merge strategy)
 *
 * Integration points (non-breaking):
 *  - Pass `onAddToPlan(item, opts)` to wire into your plan builder/targets page
 *  - Page also emits DOM events you can listen to:
 *      window.addEventListener("ssa.hp.catalog.addToPlan", (e) => ...)
 *  - If your app exposes window.eventBus.emit(type, payload), we also call it.
 *
 * Notes:
 *  - This file intentionally avoids depending on your app’s UI kit to prevent build breaks.
 *  - Uses Tailwind-style classes if available; otherwise still renders fine with default browser styles.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/components";
const DB_NAME = "SSA_HomesteadPlanner_Catalog_v1";
const DB_VERSION = 1;

const DOMAIN = {
  COMPONENT: "component",
  PRESERVATION: "preservation",
};

const SORT = {
  UPDATED_DESC: "updated_desc",
  UPDATED_ASC: "updated_asc",
  NAME_ASC: "name_asc",
  NAME_DESC: "name_desc",
  CATEGORY_ASC: "category_asc",
  CATEGORY_DESC: "category_desc",
};

const DOMAIN_OPTIONS = [
  { key: "all", label: "All" },
  { key: DOMAIN.COMPONENT, label: "Components" },
  { key: DOMAIN.PRESERVATION, label: "Preservation" },
];

const DEFAULT_PAGE_SIZE = 24;

/* -----------------------------------------------------------------------------
 * Dexie DB (local, module-scoped singleton)
 * --------------------------------------------------------------------------- */

let _dbSingleton = null;

function getCatalogDb() {
  if (_dbSingleton) return _dbSingleton;

  const db = new Dexie(DB_NAME);

  // Schema: keep it stable; add new version() blocks for future migrations.
  db.version(DB_VERSION).stores({
    // Primary table for items
    catalogItems:
      "id, domain, category, nameLower, updatedAt, createdAt, status, *tags, *seasons",
    // Meta table for seeding + bookkeeping
    catalogMeta: "key",
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

function uid(prefix = "hp") {
  // Collision-resistant enough for local-only catalog
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function prettyDomain(domain) {
  if (domain === DOMAIN.COMPONENT) return "Component";
  if (domain === DOMAIN.PRESERVATION) return "Preservation";
  return safeString(domain);
}

function emitSSAEvent(type, detail) {
  try {
    // Optional: your app-level eventBus if present
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

function summarizeItem(item) {
  const tags = (item?.tags || []).slice(0, 6).join(", ");
  const cat = safeString(item?.category);
  const dom = prettyDomain(item?.domain);
  return `${dom}${cat ? ` • ${cat}` : ""}${tags ? ` • ${tags}` : ""}`;
}

function safeArray(v) {
  return Array.isArray(v) ? v : v == null ? [] : [v];
}

/* -----------------------------------------------------------------------------
 * Seed Data (starter catalog)
 * --------------------------------------------------------------------------- */

const SEED_VERSION = "seed_2026-01-09_v1";

function getSeedItems() {
  return [
    // Components (homestead infrastructure)
    {
      id: "seed_component_raised_bed",
      domain: DOMAIN.COMPONENT,
      category: "Garden Infrastructure",
      name: "Raised Bed (4x8) – Basic Build",
      tags: ["garden", "soil", "lumber", "beds"],
      seasons: ["spring", "fall"],
      status: "active",
      description:
        "Standard raised bed build with optional hardware cloth base for gopher protection. Includes soil mix guidance and maintenance notes.",
      inputs: {
        materials: [
          "2x10 (or 2x12) boards",
          "Exterior screws",
          "Cardboard (sheet mulch)",
          "Hardware cloth (optional)",
          "Soil/compost mix",
        ],
        tools: ["Drill/driver", "Saw", "Tape measure", "Level"],
      },
      outputs: {
        yields: ["One 4x8 raised bed ready for planting"],
      },
      steps: [
        "Choose location (6–8 hours sun).",
        "Assemble frame; square corners; fasten with screws.",
        "Lay cardboard sheet mulch; add hardware cloth if needed.",
        "Fill with soil mix; water-in to settle.",
        "Add mulch; mark planting grid; log in garden plan.",
      ],
      time: { activeMinutes: 60, totalMinutes: 90 },
      storage: { notes: "Store extra soil covered; keep fasteners dry." },
      safety: {
        notes: "Use eye protection; watch pinch points; verify saw setup.",
      },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "raised bed (4x8) – basic build",
    },
    {
      id: "seed_component_cold_frame",
      domain: DOMAIN.COMPONENT,
      category: "Season Extension",
      name: "Cold Frame – Simple Lid Design",
      tags: ["garden", "season extension", "greens"],
      seasons: ["winter", "fall", "spring"],
      status: "active",
      description:
        "Low-profile cold frame for hardening off seedlings and extending greens into cold months.",
      inputs: {
        materials: [
          "Lumber or straw bales",
          "Hinges",
          "Old window or polycarbonate sheet",
        ],
        tools: ["Drill/driver", "Tape measure", "Saw (optional)"],
      },
      outputs: { yields: ["One cold frame with hinged lid"] },
      steps: [
        "Size frame to lid/window dimensions.",
        "Build sloped sides (higher in back) for sun angle.",
        "Attach lid with hinges; add prop stick or vent control.",
        "Place on level soil; seal drafts; monitor temps.",
      ],
      time: { activeMinutes: 45, totalMinutes: 60 },
      storage: { notes: "Store lid indoors during storms if needed." },
      safety: { notes: "Handle glass carefully; sand sharp edges." },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "cold frame – simple lid design",
    },
    {
      id: "seed_component_compost_bin",
      domain: DOMAIN.COMPONENT,
      category: "Soil & Compost",
      name: "Compost Bin – 3-Bay System",
      tags: ["compost", "soil", "waste", "garden"],
      seasons: ["spring", "summer", "fall"],
      status: "active",
      description:
        "Three-bay compost system for active, curing, and finished compost. Includes turn schedule + moisture targets.",
      inputs: {
        materials: ["Pallets or fencing panels", "T-posts", "Wire/ties"],
        tools: ["Gloves", "Wire cutters", "Post driver (optional)"],
      },
      outputs: { yields: ["Three-bay compost system ready for use"] },
      steps: [
        "Choose drainage-friendly spot near garden access.",
        "Set bays with pallets/panels; secure with posts/ties.",
        "Start pile with carbon base (leaves/cardboard).",
        "Add greens/browns; keep moisture like wrung sponge.",
        "Turn weekly (or when temps drop); move along bays.",
      ],
      time: { activeMinutes: 60, totalMinutes: 90 },
      storage: { notes: "Keep browns stockpiled in a covered area." },
      safety: { notes: "Wear gloves; avoid meat/dairy to reduce pests." },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "compost bin – 3-bay system",
    },

    // Preservation methods
    {
      id: "seed_preservation_water_bath",
      domain: DOMAIN.PRESERVATION,
      category: "Canning",
      name: "Water Bath Canning (High-Acid Foods)",
      tags: ["canning", "jars", "shelf-stable", "high-acid"],
      seasons: ["summer", "fall"],
      status: "active",
      description:
        "For jams, pickles, tomatoes (acidified), and other high-acid foods. Includes safety notes and basic workflow.",
      inputs: {
        materials: [
          "Canning jars",
          "New lids",
          "Bands",
          "Water bath canner/pot",
        ],
        tools: ["Jar lifter", "Funnel", "Bubble remover", "Towels"],
      },
      outputs: {
        yields: [
          "Shelf-stable jars (when recipe + processing times are correct)",
        ],
      },
      steps: [
        "Use a tested recipe; confirm food is high-acid or properly acidified.",
        "Prepare jars/lids; preheat jars as needed.",
        "Fill jars; remove bubbles; set headspace; wipe rims; apply lids.",
        "Process in boiling water for recipe time; adjust for altitude.",
        "Cool 12–24 hours; check seals; label/date; store cool/dark.",
      ],
      time: { activeMinutes: 60, totalMinutes: 150 },
      storage: { notes: "Store sealed jars cool/dark; refrigerate unsealed." },
      safety: {
        notes:
          "Follow tested recipes. Low-acid foods require pressure canning. Discard any jar with spoilage signs.",
      },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "water bath canning (high-acid foods)",
    },
    {
      id: "seed_preservation_pressure_canning",
      domain: DOMAIN.PRESERVATION,
      category: "Canning",
      name: "Pressure Canning (Low-Acid Foods)",
      tags: ["canning", "pressure", "shelf-stable", "low-acid"],
      seasons: ["summer", "fall", "winter"],
      status: "active",
      description:
        "For meats, most vegetables, stocks, and low-acid foods. Includes safety checks (gauge, venting, cool-down).",
      inputs: {
        materials: ["Pressure canner", "Canning jars", "New lids", "Bands"],
        tools: [
          "Jar lifter",
          "Funnel",
          "Timer",
          "Gauge check access (recommended)",
        ],
      },
      outputs: {
        yields: [
          "Shelf-stable jars (when recipe + processing times are correct)",
        ],
      },
      steps: [
        "Use a tested recipe; determine PSI + time for your altitude.",
        "Prepare jars; hot-pack or raw-pack as recipe specifies.",
        "Load canner with correct water level; lock lid.",
        "Vent steam 10 minutes; then pressurize to target PSI.",
        "Maintain PSI for required time; then natural cool-down.",
        "Wait for zero pressure; open safely; cool jars; check seals; label/store.",
      ],
      time: { activeMinutes: 75, totalMinutes: 210 },
      storage: { notes: "Store sealed jars cool/dark; avoid freezing jars." },
      safety: {
        notes:
          "Critical: follow tested recipes + altitude adjustments. Never force-cool the canner. Verify canner condition.",
      },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "pressure canning (low-acid foods)",
    },
    {
      id: "seed_preservation_dehydrating",
      domain: DOMAIN.PRESERVATION,
      category: "Drying",
      name: "Dehydrating (Fruits, Herbs, Jerky Basics)",
      tags: ["dehydrating", "drying", "storage", "snacks"],
      seasons: ["summer", "fall"],
      status: "active",
      description:
        "Dehydrate produce/herbs and make basic dried goods. Includes conditioning and storage guidance.",
      inputs: {
        materials: ["Dehydrator (or low oven)", "Trays", "Airtight containers"],
        tools: ["Knife", "Cutting board", "Scale (optional)"],
      },
      outputs: { yields: ["Dried goods for pantry storage"] },
      steps: [
        "Prep uniform slices; pretreat if needed (e.g., lemon water for apples).",
        "Dry at appropriate temperature until leathery/brittle as required.",
        "Condition dried fruits (jar + shake daily 7–10 days).",
        "Store airtight; label/date; keep cool/dark; watch for moisture.",
      ],
      time: { activeMinutes: 30, totalMinutes: 360 },
      storage: { notes: "Use moisture absorbers if needed; rotate stock." },
      safety: {
        notes:
          "Jerky requires correct temps and handling; follow safe recipes.",
      },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "dehydrating (fruits, herbs, jerky basics)",
    },
    {
      id: "seed_preservation_fermenting",
      domain: DOMAIN.PRESERVATION,
      category: "Fermentation",
      name: "Lacto-Fermentation (Vegetables)",
      tags: ["ferment", "probiotic", "cabbage", "brine"],
      seasons: ["summer", "fall"],
      status: "active",
      description:
        "Basic brine fermentation for vegetables (kraut, pickles). Includes salinity and mold-prevention basics.",
      inputs: {
        materials: [
          "Jar/crock",
          "Salt (non-iodized preferred)",
          "Weights",
          "Lid/airlock",
        ],
        tools: ["Knife", "Scale (recommended)", "Bowl"],
      },
      outputs: {
        yields: [
          "Fermented vegetables (refrigerated storage or further processing)",
        ],
      },
      steps: [
        "Prep veg; weigh; add salt by weight (common: 2–2.5%).",
        "Pack tightly; keep veg submerged under brine.",
        "Ferment at cool room temp; burp jars if needed.",
        "Taste-check; remove surface yeast; keep submerged.",
        "Cold-store when desired sourness is reached.",
      ],
      time: { activeMinutes: 25, totalMinutes: 10080 }, // ~7 days
      storage: { notes: "Refrigerate to slow fermentation; keep submerged." },
      safety: {
        notes: "If smells rotten/putrid or shows fuzzy colored mold, discard.",
      },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "lacto-fermentation (vegetables)",
    },
    {
      id: "seed_preservation_freezing",
      domain: DOMAIN.PRESERVATION,
      category: "Freezing",
      name: "Freezing + Blanching (Vegetables)",
      tags: ["freezing", "blanch", "storage", "vegetables"],
      seasons: ["summer", "fall"],
      status: "active",
      description:
        "Quick workflow to preserve vegetables by blanching, chilling, and freezing for quality retention.",
      inputs: {
        materials: ["Freezer bags/containers", "Ice", "Large pot"],
        tools: ["Timer", "Strainer"],
      },
      outputs: { yields: ["Frozen vegetables for months-long storage"] },
      steps: [
        "Prep veg; bring water to boil; prep ice bath.",
        "Blanch for recommended time; immediately chill in ice bath.",
        "Drain and dry; pack airtight; label/date; freeze flat.",
      ],
      time: { activeMinutes: 25, totalMinutes: 60 },
      storage: { notes: "Rotate stock; avoid freezer burn with good seals." },
      safety: { notes: "Cool foods quickly; don’t overload freezer warm." },
      sources: [{ label: "SSA Seed", url: "" }],
      createdAt: nowISO(),
      updatedAt: nowISO(),
      nameLower: "freezing + blanching (vegetables)",
    },
  ].map((x) => ({
    ...x,
    tags: uniq(x.tags),
    seasons: uniq(x.seasons),
    createdAt: x.createdAt || nowISO(),
    updatedAt: x.updatedAt || nowISO(),
    nameLower: normalizeLower(x.name),
  }));
}

/* -----------------------------------------------------------------------------
 * Validation / Normalization
 * --------------------------------------------------------------------------- */

function normalizeItem(raw) {
  const domain =
    raw?.domain === DOMAIN.PRESERVATION
      ? DOMAIN.PRESERVATION
      : DOMAIN.COMPONENT;
  const name = safeString(raw?.name).trim();
  const id = safeString(raw?.id).trim() || uid("cat");
  const category = safeString(raw?.category).trim();
  const tags = uniq(
    safeArray(raw?.tags)
      .map((t) => safeString(t).trim())
      .filter(Boolean)
  );
  const seasons = uniq(
    safeArray(raw?.seasons)
      .map((s) => safeString(s).trim())
      .filter(Boolean)
  );
  const status = safeString(raw?.status || "active").trim() || "active";

  const createdAt = raw?.createdAt || nowISO();
  const updatedAt = nowISO();

  const item = {
    id,
    domain,
    category,
    name,
    nameLower: normalizeLower(name),
    tags,
    seasons,
    status,

    description: safeString(raw?.description),
    inputs:
      raw?.inputs && typeof raw.inputs === "object"
        ? raw.inputs
        : { materials: [], tools: [] },
    outputs:
      raw?.outputs && typeof raw.outputs === "object"
        ? raw.outputs
        : { yields: [] },
    steps: safeArray(raw?.steps)
      .map((s) => safeString(s))
      .filter(Boolean),
    time:
      raw?.time && typeof raw.time === "object"
        ? {
            activeMinutes: Number.isFinite(raw.time.activeMinutes)
              ? raw.time.activeMinutes
              : undefined,
            totalMinutes: Number.isFinite(raw.time.totalMinutes)
              ? raw.time.totalMinutes
              : undefined,
          }
        : {},
    storage: raw?.storage && typeof raw.storage === "object" ? raw.storage : {},
    safety: raw?.safety && typeof raw.safety === "object" ? raw.safety : {},
    sources: safeArray(raw?.sources).map((s) =>
      typeof s === "object" ? s : { label: safeString(s), url: "" }
    ),

    createdAt,
    updatedAt,
  };

  const errors = [];
  if (!item.name) errors.push("Missing required field: name");
  if (!item.domain) errors.push("Missing required field: domain");

  return { item, errors };
}

function validateImportPayload(payload) {
  if (!payload || typeof payload !== "object")
    return { ok: false, error: "Import JSON must be an object." };
  const items =
    payload.items || payload.catalogItems || payload.data || payload;
  if (!Array.isArray(items))
    return {
      ok: false,
      error: "Import JSON must contain an array at `items`.",
    };
  return { ok: true, items };
}

/* -----------------------------------------------------------------------------
 * Data access
 * --------------------------------------------------------------------------- */

async function ensureSeeded(db) {
  try {
    const meta = await db.catalogMeta.get("seedVersion");
    if (meta?.value === SEED_VERSION) return;

    // If db is empty, seed; otherwise, don’t overwrite—just mark as seeded.
    const count = await db.catalogItems.count();
    if (count === 0) {
      const seedItems = getSeedItems();
      await db.catalogItems.bulkPut(seedItems);
    }
    await db.catalogMeta.put({
      key: "seedVersion",
      value: SEED_VERSION,
      updatedAt: nowISO(),
    });
  } catch (e) {
    console.warn("[HomesteadCatalog] ensureSeeded failed:", e);
  }
}

async function queryItems({
  db,
  search,
  domainKey,
  category,
  tag,
  season,
  status,
  sortKey,
  page,
  pageSize,
}) {
  const s = normalizeLower(search);
  const d = domainKey && domainKey !== "all" ? domainKey : null;
  const cat = normalizeLower(category);
  const t = normalizeLower(tag);
  const seas = normalizeLower(season);
  const st = normalizeLower(status);

  // Build base collection (try to use indexes when possible)
  let coll = db.catalogItems.toCollection();

  if (d) coll = db.catalogItems.where("domain").equals(d).toCollection();

  // Lightweight filters (post-filter; still fast for local sized catalogs)
  coll = coll.filter((it) => {
    if (cat && normalizeLower(it.category) !== cat) return false;
    if (st && normalizeLower(it.status) !== st) return false;

    if (t) {
      const hasTag = (it.tags || []).some((x) => normalizeLower(x) === t);
      if (!hasTag) return false;
    }
    if (seas) {
      const hasSeason = (it.seasons || []).some(
        (x) => normalizeLower(x) === seas
      );
      if (!hasSeason) return false;
    }

    if (s) {
      const hay = [
        it.nameLower,
        normalizeLower(it.description),
        normalizeLower(it.category),
        (it.tags || []).map((x) => normalizeLower(x)).join(" "),
      ].join(" ");
      if (!hay.includes(s)) return false;
    }

    return true;
  });

  let items = await coll.toArray();

  // Sorting
  items.sort((a, b) => {
    const aName = safeString(a.nameLower);
    const bName = safeString(b.nameLower);
    const aCat = normalizeLower(a.category);
    const bCat = normalizeLower(b.category);
    const aUp = safeString(a.updatedAt);
    const bUp = safeString(b.updatedAt);

    switch (sortKey) {
      case SORT.UPDATED_ASC:
        return aUp.localeCompare(bUp);
      case SORT.NAME_DESC:
        return bName.localeCompare(aName);
      case SORT.NAME_ASC:
        return aName.localeCompare(bName);
      case SORT.CATEGORY_ASC:
        return aCat.localeCompare(bCat) || aName.localeCompare(bName);
      case SORT.CATEGORY_DESC:
        return bCat.localeCompare(aCat) || aName.localeCompare(bName);
      case SORT.UPDATED_DESC:
      default:
        return bUp.localeCompare(aUp);
    }
  });

  const total = items.length;
  const ps = clamp(pageSize || DEFAULT_PAGE_SIZE, 6, 120);
  const p = clamp(page || 1, 1, Math.max(1, Math.ceil(total / ps)));
  const start = (p - 1) * ps;
  const end = start + ps;
  const pageItems = items.slice(start, end);

  return { items: pageItems, total, page: p, pageSize: ps };
}

async function getFacetValues(db) {
  const all = await db.catalogItems.toArray();
  const categories = uniq(
    all.map((x) => safeString(x.category)).filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const tags = uniq(
    all
      .flatMap((x) => x.tags || [])
      .map((x) => safeString(x))
      .filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const seasons = uniq(
    all
      .flatMap((x) => x.seasons || [])
      .map((x) => safeString(x))
      .filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const statuses = uniq(
    all.map((x) => safeString(x.status)).filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  return { categories, tags, seasons, statuses };
}

/* -----------------------------------------------------------------------------
 * UI Helpers (lightweight)
 * --------------------------------------------------------------------------- */

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
}

function Pill({ active, children, onClick, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cx(
        "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm",
        active
          ? "bg-black text-white border-black"
          : "bg-white text-black border-gray-300"
      )}
      style={!active ? { opacity: 0.92 } : undefined}
    >
      {children}
    </button>
  );
}

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

function Input({ value, onChange, placeholder, className }) {
  return (
    <input
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

function ModalShell({ open, title, onClose, children, footer }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-3xl rounded-2xl bg-white shadow-xl border border-gray-200 overflow-hidden">
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
        style={{ maxWidth: "640px" }}
      >
        {children}
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Main Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerComponentsPage({
  onAddToPlan, // optional: (item, opts) => void
  initialDomain = "all",
}) {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  // Query state
  const [search, setSearch] = useState("");
  const [domainKey, setDomainKey] = useState(initialDomain);
  const [category, setCategory] = useState("");
  const [tag, setTag] = useState("");
  const [season, setSeason] = useState("");
  const [status, setStatus] = useState("");
  const [sortKey, setSortKey] = useState(SORT.UPDATED_DESC);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // Results
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);

  // Facets
  const [facets, setFacets] = useState({
    categories: [],
    tags: [],
    seasons: [],
    statuses: [],
  });

  // UI state
  const [selected, setSelected] = useState(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editDraft, setEditDraft] = useState(null);

  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState(null);

  // Debounce search
  const [searchDebounced, setSearchDebounced] = useState(search);
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const db = getCatalogDb();
    dbRef.current = db;

    (async () => {
      try {
        await ensureSeeded(db);
        // Try simple read to ensure IndexedDB is available
        await db.catalogItems.limit(1).toArray();
        const f = await getFacetValues(db);
        setFacets(f);
        setReady(true);
      } catch (e) {
        console.warn("[HomesteadCatalog] init failed:", e);
        setDbError(
          "Catalog storage isn’t available in this browser/profile (IndexedDB blocked or unavailable)."
        );
        setReady(true);
      }
    })();

    return () => {
      // Keep db open; Dexie handles lifetime. No need to close.
    };
  }, []);

  // Reset page on filter changes
  useEffect(() => {
    setPage(1);
  }, [
    searchDebounced,
    domainKey,
    category,
    tag,
    season,
    status,
    sortKey,
    pageSize,
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
        const res = await queryItems({
          db,
          search: searchDebounced,
          domainKey,
          category,
          tag,
          season,
          status,
          sortKey,
          page,
          pageSize,
        });
        if (cancelled) return;
        setItems(res.items);
        setTotal(res.total);
      } catch (e) {
        console.warn("[HomesteadCatalog] query failed:", e);
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
    season,
    status,
    sortKey,
    page,
    pageSize,
  ]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((total || 0) / pageSize)),
    [total, pageSize]
  );

  function pushToast(message, kind = "info") {
    setToast({ message, kind, at: Date.now() });
    setTimeout(() => setToast(null), 2200);
  }

  async function refreshFacets() {
    const db = dbRef.current;
    if (!db || dbError) return;
    try {
      const f = await getFacetValues(db);
      setFacets(f);
    } catch (e) {
      // ignore
    }
  }

  async function handleAddToPlan(item) {
    const payload = {
      source: PAGE_SOURCE,
      item,
      at: nowISO(),
    };

    // User callback
    try {
      await onAddToPlan?.(item, { source: PAGE_SOURCE });
    } catch (e) {
      console.warn("[HomesteadCatalog] onAddToPlan error:", e);
    }

    // Fire DOM/app events (safe)
    emitSSAEvent("ssa.hp.catalog.addToPlan", payload);

    pushToast(`Added to plan: ${safeString(item?.name)}`, "success");
  }

  function openCreate(domain = DOMAIN.COMPONENT) {
    setEditDraft({
      id: "",
      domain,
      category: "",
      name: "",
      tags: [],
      seasons: [],
      status: "active",
      description: "",
      inputs: { materials: [], tools: [] },
      outputs: { yields: [] },
      steps: [],
      time: { activeMinutes: "", totalMinutes: "" },
      storage: { notes: "" },
      safety: { notes: "" },
      sources: [],
    });
    setEditOpen(true);
  }

  function openEdit(item) {
    setEditDraft({
      ...item,
      time: {
        activeMinutes: item?.time?.activeMinutes ?? "",
        totalMinutes: item?.time?.totalMinutes ?? "",
      },
    });
    setEditOpen(true);
  }

  async function handleDelete(item) {
    const db = dbRef.current;
    if (!db || dbError) return;
    if (!item?.id) return;

    const ok = window.confirm(`Delete "${item.name}" from your catalog?`);
    if (!ok) return;

    try {
      await db.catalogItems.delete(item.id);
      if (selected?.id === item.id) setSelected(null);
      pushToast("Deleted.", "success");
      await refreshFacets();
      // Trigger refresh by nudging page state if needed
      setPage((p) => Math.max(1, p));
    } catch (e) {
      console.warn("[HomesteadCatalog] delete failed:", e);
      pushToast("Delete failed.", "error");
    }
  }

  async function handleSaveDraft(draft) {
    const db = dbRef.current;
    if (!db || dbError) return;

    const { item, errors } = normalizeItem({
      ...draft,
      // coerce numeric time if provided
      time: {
        activeMinutes:
          draft?.time?.activeMinutes === ""
            ? undefined
            : Number(draft?.time?.activeMinutes),
        totalMinutes:
          draft?.time?.totalMinutes === ""
            ? undefined
            : Number(draft?.time?.totalMinutes),
      },
    });

    if (errors.length) {
      pushToast(errors[0], "error");
      return;
    }

    try {
      // Preserve createdAt on updates
      const existing = await db.catalogItems.get(item.id);
      if (existing?.createdAt) item.createdAt = existing.createdAt;

      await db.catalogItems.put(item);
      setEditOpen(false);
      setEditDraft(null);
      pushToast("Saved.", "success");
      await refreshFacets();

      // If we were editing selected, refresh drawer
      if (selected?.id === item.id) {
        setSelected(item);
      }
    } catch (e) {
      console.warn("[HomesteadCatalog] save failed:", e);
      pushToast("Save failed.", "error");
    }
  }

  async function handleExport() {
    const db = dbRef.current;
    if (!db || dbError) return;

    try {
      const all = await db.catalogItems.toArray();
      const payload = {
        type: "SSA_HomesteadPlanner_Catalog",
        version: 1,
        seedVersion: SEED_VERSION,
        exportedAt: nowISO(),
        items: all,
      };
      downloadJSON(
        `ssa-homestead-catalog-${new Date().toISOString().slice(0, 10)}.json`,
        payload
      );
      pushToast("Exported JSON.", "success");
    } catch (e) {
      console.warn("[HomesteadCatalog] export failed:", e);
      pushToast("Export failed.", "error");
    }
  }

  async function handleImport({ jsonText, mode }) {
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
      const { item, errors } = normalizeItem(raw);
      if (errors.length) problems.push({ id: raw?.id, errors });
      else normalized.push(item);
    }

    if (normalized.length === 0) {
      pushToast("No valid items found to import.", "error");
      return;
    }

    try {
      if (mode === "replace") {
        await db.transaction("rw", db.catalogItems, async () => {
          await db.catalogItems.clear();
          await db.catalogItems.bulkPut(normalized);
        });
      } else {
        // merge: upsert
        await db.catalogItems.bulkPut(normalized);
      }

      await refreshFacets();
      setImportOpen(false);
      pushToast(`Imported ${normalized.length} item(s).`, "success");

      if (problems.length) {
        console.warn("[HomesteadCatalog] import problems:", problems);
      }
    } catch (e) {
      console.warn("[HomesteadCatalog] import failed:", e);
      pushToast("Import failed.", "error");
    }
  }

  const headerSubtitle = useMemo(() => {
    const activeFilters = [
      domainKey && domainKey !== "all" ? prettyDomain(domainKey) : null,
      category ? `Category: ${category}` : null,
      tag ? `Tag: ${tag}` : null,
      season ? `Season: ${season}` : null,
      status ? `Status: ${status}` : null,
    ].filter(Boolean);

    if (!activeFilters.length && !searchDebounced)
      return "Browse, search, and add homestead components and preservation methods to your plan.";
    return [
      searchDebounced ? `Search: "${searchDebounced}"` : null,
      ...activeFilters,
    ]
      .filter(Boolean)
      .join(" • ");
  }, [domainKey, category, tag, season, status, searchDebounced]);

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">
              Components & Preservation Catalog
            </h1>
            <div className="text-sm opacity-80 mt-1">{headerSubtitle}</div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="ghost"
              onClick={() => setImportOpen(true)}
              title="Import or export catalog JSON"
            >
              Import/Export
            </Button>
            <Button
              variant="ghost"
              onClick={() => openCreate(DOMAIN.COMPONENT)}
              title="Create a component item"
            >
              + Component
            </Button>
            <Button
              variant="ghost"
              onClick={() => openCreate(DOMAIN.PRESERVATION)}
              title="Create a preservation item"
            >
              + Preservation
            </Button>
          </div>
        </div>

        {dbError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="font-bold text-red-800">
              Catalog storage unavailable
            </div>
            <div className="text-red-800 mt-1">{dbError}</div>
            <div className="text-red-700 mt-2">
              Tip: If you’re in a restrictive browser profile, enable
              IndexedDB/storage or try a standard profile.
            </div>
          </div>
        ) : null}

        {/* Controls */}
        <div className="mt-5 grid grid-cols-1 lg:grid-cols-12 gap-3">
          <div className="lg:col-span-5">
            <FieldLabel>Search</FieldLabel>
            <Input
              value={search}
              onChange={setSearch}
              placeholder="Search name, category, tags, description..."
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel>Domain</FieldLabel>
            <Select
              value={domainKey}
              onChange={setDomainKey}
              options={DOMAIN_OPTIONS.map((o) => ({
                value: o.key,
                label: o.label,
              }))}
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel>Sort</FieldLabel>
            <Select
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: SORT.UPDATED_DESC, label: "Updated (new → old)" },
                { value: SORT.UPDATED_ASC, label: "Updated (old → new)" },
                { value: SORT.NAME_ASC, label: "Name (A → Z)" },
                { value: SORT.NAME_DESC, label: "Name (Z → A)" },
                { value: SORT.CATEGORY_ASC, label: "Category (A → Z)" },
                { value: SORT.CATEGORY_DESC, label: "Category (Z → A)" },
              ]}
            />
          </div>

          <div className="lg:col-span-1">
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

          <div className="lg:col-span-2 flex items-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setSearch("");
                setDomainKey("all");
                setCategory("");
                setTag("");
                setSeason("");
                setStatus("");
                setSortKey(SORT.UPDATED_DESC);
                pushToast("Filters cleared.", "info");
              }}
              title="Clear filters"
              className="w-full"
            >
              Clear
            </Button>
          </div>
        </div>

        {/* Facet filters */}
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
            <FieldLabel>Season</FieldLabel>
            <Select
              value={season}
              onChange={setSeason}
              options={[
                { value: "", label: "All seasons" },
                ...facets.seasons.map((s) => ({ value: s, label: s })),
              ]}
            />
          </div>

          <div className="md:col-span-2">
            <FieldLabel>Status</FieldLabel>
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: "", label: "All" },
                ...facets.statuses.map((s) => ({ value: s, label: s })),
              ]}
            />
          </div>
        </div>

        {/* Quick domain pills */}
        <div className="mt-4 flex items-center gap-2 flex-wrap">
          {DOMAIN_OPTIONS.map((o) => (
            <Pill
              key={o.key}
              active={domainKey === o.key}
              onClick={() => setDomainKey(o.key)}
            >
              {o.label}
            </Pill>
          ))}
        </div>

        {/* Results header */}
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
              Page <b>{page}</b> / <b>{totalPages}</b>
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
            <CatalogCard
              key={it.id}
              item={it}
              onOpen={() => setSelected(it)}
              onAdd={() => handleAddToPlan(it)}
            />
          ))}
        </div>

        {/* Empty */}
        {ready && !dbError && items.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-gray-200 p-6">
            <div className="font-bold">No matches</div>
            <div className="text-sm opacity-80 mt-1">
              Try clearing filters, switching domain, or importing a catalog
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
                + Preservation
              </Button>
            </div>
          </div>
        ) : null}

        {/* Drawer */}
        <Drawer open={!!selected} onClose={() => setSelected(null)}>
          {selected ? (
            <ItemDrawerContent
              item={selected}
              onClose={() => setSelected(null)}
              onAdd={() => handleAddToPlan(selected)}
              onEdit={() => openEdit(selected)}
              onDelete={() => handleDelete(selected)}
            />
          ) : null}
        </Drawer>

        {/* Edit modal */}
        <EditItemModal
          open={editOpen}
          draft={editDraft}
          onClose={() => {
            setEditOpen(false);
            setEditDraft(null);
          }}
          onSave={handleSaveDraft}
        />

        {/* Import/Export modal */}
        <ImportExportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onExport={handleExport}
          onImport={handleImport}
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
 * Catalog Card
 * --------------------------------------------------------------------------- */

function CatalogCard({ item, onOpen, onAdd }) {
  const dom = prettyDomain(item.domain);
  const summary = summarizeItem(item);
  const tags = (item.tags || []).slice(0, 6);

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold opacity-70">{dom}</div>
          <div
            className="font-black text-base leading-snug mt-1 truncate"
            title={item.name}
          >
            {item.name}
          </div>
          <div className="text-xs opacity-70 mt-1 truncate" title={summary}>
            {summary}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={onOpen} title="Open details">
            Details
          </Button>
        </div>
      </div>

      {item.description ? (
        <div
          className="text-sm mt-3 opacity-90 line-clamp-3"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {item.description}
        </div>
      ) : null}

      {tags.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {tags.map((t) => (
            <span
              key={t}
              className="text-xs rounded-full border border-gray-200 px-2 py-1"
            >
              {t}
            </span>
          ))}
        </div>
      ) : null}

      <div className="mt-4 flex items-center justify-between gap-2">
        <div className="text-xs opacity-70">
          Updated: {safeString(item.updatedAt).slice(0, 10)}
        </div>
        <Button onClick={onAdd} title="Add to plan">
          Add to Plan
        </Button>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Drawer Content
 * --------------------------------------------------------------------------- */

function ItemDrawerContent({ item, onClose, onAdd, onEdit, onDelete }) {
  const tags = item.tags || [];
  const seasons = item.seasons || [];
  const tools = item?.inputs?.tools || [];
  const materials = item?.inputs?.materials || [];
  const yields = item?.outputs?.yields || [];
  const steps = item?.steps || [];

  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold opacity-70">
            {prettyDomain(item.domain)}
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
        <Button onClick={onAdd}>Add to Plan</Button>
        <Button variant="ghost" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="danger" onClick={onDelete}>
          Delete
        </Button>
      </div>

      {item.description ? (
        <Section title="Description">
          <div className="text-sm whitespace-pre-wrap">{item.description}</div>
        </Section>
      ) : null}

      {tags.length ? (
        <Section title="Tags">
          <div className="flex flex-wrap gap-2">
            {tags.map((t) => (
              <span
                key={t}
                className="text-xs rounded-full border border-gray-200 px-2 py-1"
              >
                {t}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {seasons.length ? (
        <Section title="Seasons">
          <div className="flex flex-wrap gap-2">
            {seasons.map((s) => (
              <span
                key={s}
                className="text-xs rounded-full border border-gray-200 px-2 py-1"
              >
                {s}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
        {materials.length ? (
          <Section title="Materials">
            <ul className="list-disc pl-5 text-sm">
              {materials.map((m, idx) => (
                <li key={`${m}-${idx}`}>{m}</li>
              ))}
            </ul>
          </Section>
        ) : null}

        {tools.length ? (
          <Section title="Tools">
            <ul className="list-disc pl-5 text-sm">
              {tools.map((m, idx) => (
                <li key={`${m}-${idx}`}>{m}</li>
              ))}
            </ul>
          </Section>
        ) : null}
      </div>

      {yields.length ? (
        <Section title="Outputs / Yields">
          <ul className="list-disc pl-5 text-sm">
            {yields.map((y, idx) => (
              <li key={`${y}-${idx}`}>{y}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {steps.length ? (
        <Section title="Steps">
          <ol className="list-decimal pl-5 text-sm space-y-1">
            {steps.map((s, idx) => (
              <li key={`${idx}-${s.slice(0, 16)}`}>{s}</li>
            ))}
          </ol>
        </Section>
      ) : null}

      {item?.time?.activeMinutes || item?.time?.totalMinutes ? (
        <Section title="Time">
          <div className="text-sm">
            {item?.time?.activeMinutes ? (
              <div>
                Active minutes: <b>{item.time.activeMinutes}</b>
              </div>
            ) : null}
            {item?.time?.totalMinutes ? (
              <div>
                Total minutes: <b>{item.time.totalMinutes}</b>
              </div>
            ) : null}
          </div>
        </Section>
      ) : null}

      {item?.storage?.notes ? (
        <Section title="Storage Notes">
          <div className="text-sm whitespace-pre-wrap">
            {safeString(item.storage.notes)}
          </div>
        </Section>
      ) : null}

      {item?.safety?.notes ? (
        <Section title="Safety Notes">
          <div className="text-sm whitespace-pre-wrap">
            {safeString(item.safety.notes)}
          </div>
        </Section>
      ) : null}

      <Section title="Metadata">
        <div className="text-xs opacity-80">
          <div>ID: {item.id}</div>
          <div>
            Created: {safeString(item.createdAt).slice(0, 19).replace("T", " ")}
          </div>
          <div>
            Updated: {safeString(item.updatedAt).slice(0, 19).replace("T", " ")}
          </div>
        </div>
      </Section>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mt-4 rounded-2xl border border-gray-200 p-4">
      <div className="font-bold text-sm mb-2">{title}</div>
      {children}
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Edit Modal
 * --------------------------------------------------------------------------- */

function EditItemModal({ open, draft, onClose, onSave }) {
  const [local, setLocal] = useState(draft);

  useEffect(() => {
    setLocal(draft);
  }, [draft]);

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
      title={isEdit ? "Edit Catalog Item" : "Create Catalog Item"}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2">
          <div className="text-xs opacity-70">
            Tip: Put one item per line for lists (tags, tools, materials,
            steps).
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

          <div className="md:col-span-5">
            <FieldLabel>Name *</FieldLabel>
            <Input
              value={local.name || ""}
              onChange={(v) => setField("name", v)}
              placeholder="e.g., Root cellar (small), Water bath canning..."
            />
          </div>

          <div className="md:col-span-4">
            <FieldLabel>Category</FieldLabel>
            <Input
              value={local.category || ""}
              onChange={(v) => setField("category", v)}
              placeholder="e.g., Canning, Fermentation, Garden Infrastructure"
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Tags (one per line)</FieldLabel>
            <Textarea
              value={(local.tags || []).join("\n")}
              onChange={(v) => setList("tags", v)}
              rows={5}
              placeholder={"garden\nsoil\ncanning\n..."}
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Seasons (one per line)</FieldLabel>
            <Textarea
              value={(local.seasons || []).join("\n")}
              onChange={(v) => setList("seasons", v)}
              rows={5}
              placeholder={"spring\nsummer\nfall\nwinter"}
            />
          </div>

          <div className="md:col-span-12">
            <FieldLabel>Description</FieldLabel>
            <Textarea
              value={local.description || ""}
              onChange={(v) => setField("description", v)}
              rows={4}
              placeholder="Short overview and purpose…"
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Materials (one per line)</FieldLabel>
            <Textarea
              value={(local?.inputs?.materials || []).join("\n")}
              onChange={(v) => setList("inputs.materials", v)}
              rows={6}
              placeholder={"Canning jars\nNew lids\nSalt\n..."}
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Tools (one per line)</FieldLabel>
            <Textarea
              value={(local?.inputs?.tools || []).join("\n")}
              onChange={(v) => setList("inputs.tools", v)}
              rows={6}
              placeholder={"Jar lifter\nKnife\nScale\n..."}
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Outputs/Yields (one per line)</FieldLabel>
            <Textarea
              value={(local?.outputs?.yields || []).join("\n")}
              onChange={(v) => setList("outputs.yields", v)}
              rows={5}
              placeholder={"Shelf-stable jars\nFinished compost\n..."}
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Active minutes</FieldLabel>
            <Input
              value={local?.time?.activeMinutes ?? ""}
              onChange={(v) => setField("time.activeMinutes", v)}
              placeholder="e.g., 45"
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Total minutes</FieldLabel>
            <Input
              value={local?.time?.totalMinutes ?? ""}
              onChange={(v) => setField("time.totalMinutes", v)}
              placeholder="e.g., 180"
            />
          </div>

          <div className="md:col-span-12">
            <FieldLabel>Steps (one per line)</FieldLabel>
            <Textarea
              value={(local.steps || []).join("\n")}
              onChange={(v) => setList("steps", v)}
              rows={8}
              placeholder={"Step 1…\nStep 2…\nStep 3…"}
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Storage notes</FieldLabel>
            <Textarea
              value={safeString(local?.storage?.notes)}
              onChange={(v) => setField("storage.notes", v)}
              rows={4}
              placeholder="How to store outputs, rotate stock, etc."
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Safety notes</FieldLabel>
            <Textarea
              value={safeString(local?.safety?.notes)}
              onChange={(v) => setField("safety.notes", v)}
              rows={4}
              placeholder="Critical safety reminders, discard rules, PPE, etc."
            />
          </div>

          <div className="md:col-span-4">
            <FieldLabel>Status</FieldLabel>
            <Select
              value={local.status || "active"}
              onChange={(v) => setField("status", v)}
              options={[
                { value: "active", label: "active" },
                { value: "draft", label: "draft" },
                { value: "archived", label: "archived" },
              ]}
            />
          </div>

          {isEdit ? (
            <div className="md:col-span-8">
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
  const [mode, setMode] = useState("merge"); // merge | replace
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
      type: "SSA_HomesteadPlanner_Catalog",
      version: 1,
      exportedAt: nowISO(),
      items: [
        {
          id: "my_preservation_smoking",
          domain: "preservation",
          category: "Smoking & Curing",
          name: "Hot Smoking (Basics)",
          tags: ["smoking", "meat", "fish"],
          seasons: ["fall", "winter"],
          status: "active",
          description:
            "Basic hot-smoke workflow with temperature control and food safety emphasis.",
          inputs: {
            materials: ["Wood chunks", "Salt"],
            tools: ["Smoker", "Thermometer"],
          },
          outputs: { yields: ["Smoked product for refrigeration/freezing"] },
          steps: [
            "Dry brine",
            "Air-dry pellicle",
            "Smoke to safe internal temp",
            "Cool quickly",
          ],
          time: { activeMinutes: 45, totalMinutes: 240 },
          storage: {
            notes:
              "Cool quickly and store refrigerated; freeze for longer storage.",
          },
          safety: {
            notes: "Always hit safe internal temps; avoid time in danger zone.",
          },
          sources: [{ label: "My Notes", url: "" }],
          createdAt: nowISO(),
          updatedAt: nowISO(),
        },
      ],
    }),
    []
  );

  if (!open) return null;

  return (
    <ModalShell
      open={open}
      title="Import / Export Catalog"
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
              title="Import the JSON currently in the textarea"
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
            Merge will update items with matching IDs and add new ones. Replace
            clears your catalog first.
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
          <FieldLabel>Paste catalog JSON</FieldLabel>
          <Textarea
            value={text}
            onChange={setText}
            rows={14}
            placeholder='{"items":[{...}]}'
          />
          <div className="text-xs opacity-70 mt-2">
            Expected shape: an object containing <b>items</b> array (or directly
            an array). Each item needs at least <b>name</b> and <b>domain</b>.
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

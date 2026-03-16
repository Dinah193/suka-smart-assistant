// C:\Users\larho\suka-smart-assistant\src\pages\homesteadplanner\batches.jsx
/* eslint-disable no-console */
/**
 * SSA • Homestead Planner — Preservation Batches
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Start a preservation batch (canning / fermentation / dehydrating / freezing / curing, etc.)
 *  - Record batch history (timeline + filters)
 *  - Link produced lots directly into Homestead Inventory (homesteadInventory table)
 *
 * What this page includes (production-ready, browser-safe):
 *  - Local Dexie DB:
 *      • homesteadBatches      (batch header + metadata)
 *      • homesteadBatchLots    (outputs produced by batch; becomes inventory lots)
 *      • homesteadInventory    (same schema used by inventory.jsx; we write into it)
 *      • inventoryMeta         (seed/settings)
 *  - Start batch wizard:
 *      • Batch details
 *      • Inputs (optional notes)
 *      • Outputs (lots) builder with computed readiness/shelf-life
 *      • Commit creates batch + lots + inventory lots (transactional)
 *  - Batch history view:
 *      • Search / filter by method/status/date range
 *      • Expand batch to see output lots + quick actions:
 *          - "Use 1" decrements inventory lot
 *          - "Open in Inventory" (scroll + highlight by id)
 *  - Export/Import JSON for batches (merge/replace)
 *
 * Emits DOM events:
 *   window.dispatchEvent(new CustomEvent("ssa.hp.batch.created", {detail}))
 *   window.dispatchEvent(new CustomEvent("ssa.hp.inventory.updated", {detail}))
 *
 * Notes:
 *  - Tailwind classes used if present, but layout still works without Tailwind.
 *  - No Node imports (safe for Vite).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import Dexie from "dexie";

/* -----------------------------------------------------------------------------
 * Constants
 * --------------------------------------------------------------------------- */

const PAGE_SOURCE = "pages/homesteadplanner/batches";
const DB_NAME = "SSA_HomesteadPlanner_Inventory_v1"; // shared with inventory.jsx
const DB_VERSION = 2; // bump locally here to add batch tables safely

const DOMAIN = {
  PRESERVATION: "preservation",
};

const STATUS = {
  ACTIVE: "active",
  ARCHIVED: "archived",
  DRAFT: "draft",
  COMPLETED: "completed",
  CANCELLED: "cancelled",
};

const METHODS = [
  "Canning",
  "Fermentation",
  "Dehydrating",
  "Freezing",
  "Curing/Smoking",
  "Pickling",
  "Salting/Brining",
  "Root Cellar",
  "Cold Storage",
  "Other",
];

const DEFAULT_PAGE_SIZE = 20;

/* -----------------------------------------------------------------------------
 * Dexie DB (shared name; adds tables if not already present)
 * --------------------------------------------------------------------------- */

let _dbSingleton = null;

function getDb() {
  if (_dbSingleton) return _dbSingleton;

  const db = new Dexie(DB_NAME);

  /**
   * IMPORTANT:
   * - inventory.jsx created DB at version 1 with homesteadInventory + inventoryMeta.
   * - Here we extend with version 2 for batch tables.
   *
   * Dexie requires you to repeat prior stores + new ones in a newer version.
   */
  db.version(1).stores({
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",
  });

  db.version(DB_VERSION).stores({
    // Preserve existing tables and add new ones
    homesteadInventory:
      "id, domain, category, nameLower, updatedAt, createdAt, status, readyOn, bestByDate, expiresOn, *tags",
    inventoryMeta: "key",

    // Batch header
    homesteadBatches:
      "id, createdAt, updatedAt, startedAt, completedAt, status, methodLower, titleLower, *tags",
    // Produced lots (outputs)
    homesteadBatchLots:
      "id, batchId, createdAt, updatedAt, inventoryItemId, nameLower, category, status, readyOn, bestByDate, expiresOn, *tags",
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

function uid(prefix = "id") {
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
  const da = a instanceof Date ? a : parseISODateOnly(a);
  const db = b instanceof Date ? b : parseISODateOnly(b);
  if (!da || !db) return null;
  const ms = da.getTime() - db.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

function cx(...parts) {
  return parts.filter(Boolean).join(" ");
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

/* -----------------------------------------------------------------------------
 * Shelf-life + readiness computation (same model as inventory.jsx)
 * --------------------------------------------------------------------------- */

function computeDatesFromShelfLife(item) {
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
  if (meta.expiresOn) {
    const d = meta.daysUntilExpiry;
    if (d != null && d <= 7) return { label: "Expires ≤ 7d", tone: "danger" };
    if (d != null && d <= 21) return { label: "Expires ≤ 21d", tone: "warn" };
    return { label: "Within Date", tone: "success" };
  }
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
 * Normalization
 * --------------------------------------------------------------------------- */

function normalizeBatchHeader(raw) {
  const id = safeString(raw?.id).trim() || uid("batch");
  const title = safeString(raw?.title).trim() || "Preservation Batch";
  const method = safeString(raw?.method).trim() || "Other";
  const status = safeString(raw?.status).trim() || STATUS.DRAFT;

  const tags = uniq(
    safeArray(raw?.tags)
      .map((t) => safeString(t).trim())
      .filter(Boolean)
  );

  const startedAt = raw?.startedAt ? safeString(raw.startedAt) : nowISO();
  const completedAt = raw?.completedAt ? safeString(raw.completedAt) : "";

  const createdAt = raw?.createdAt || nowISO();
  const updatedAt = nowISO();

  const header = {
    id,
    title,
    titleLower: normalizeLower(title),
    method,
    methodLower: normalizeLower(method),
    status,
    tags,

    startedAt,
    completedAt: completedAt || "",
    createdAt,
    updatedAt,

    notes: safeString(raw?.notes),
    location: safeString(raw?.location),
    // optional links
    relatedPlanId: safeString(raw?.relatedPlanId),
  };

  const errors = [];
  if (!header.title) errors.push("Missing title");
  if (!header.method) errors.push("Missing method");
  return { header, errors };
}

function normalizeBatchLot(raw, batchId) {
  const id = safeString(raw?.id).trim() || uid("lot");
  const name = safeString(raw?.name).trim();
  const category = safeString(raw?.category).trim();
  const unit = safeString(raw?.unit || "unit").trim() || "unit";
  const quantity = Number(raw?.quantity);

  const packedOn = raw?.packedOn ? toDateOnlyISO(raw.packedOn) : "";
  const acquiredOn = raw?.acquiredOn ? toDateOnlyISO(raw.acquiredOn) : "";
  const readyOn = raw?.readyOn ? toDateOnlyISO(raw.readyOn) : "";
  const bestByDate = raw?.bestByDate ? toDateOnlyISO(raw.bestByDate) : "";
  const expiresOn = raw?.expiresOn ? toDateOnlyISO(raw.expiresOn) : "";

  const shelfLifeDays =
    raw?.shelfLifeDays == null || raw?.shelfLifeDays === ""
      ? undefined
      : Number(raw.shelfLifeDays);
  const safetyDaysAfterBestBy =
    raw?.safetyDaysAfterBestBy == null || raw?.safetyDaysAfterBestBy === ""
      ? undefined
      : Number(raw.safetyDaysAfterBestBy);

  const tags = uniq(
    safeArray(raw?.tags)
      .map((t) => safeString(t).trim())
      .filter(Boolean)
  );
  const status =
    safeString(raw?.status || STATUS.ACTIVE).trim() || STATUS.ACTIVE;

  const createdAt = raw?.createdAt || nowISO();
  const updatedAt = nowISO();

  const lot = {
    id,
    batchId,
    name,
    nameLower: normalizeLower(name),
    category,
    unit,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    minOnHand:
      raw?.minOnHand == null || raw?.minOnHand === ""
        ? undefined
        : Number(raw.minOnHand),
    location: safeString(raw?.location),
    status,
    notes: safeString(raw?.notes),

    // preservation-specific dates
    acquiredOn,
    packedOn,
    readyOn,
    bestByDate,
    expiresOn,
    shelfLifeDays,
    safetyDaysAfterBestBy,
    treatBestByAsExpiry: !!raw?.treatBestByAsExpiry,

    tags,
    createdAt,
    updatedAt,

    // back-reference once committed to inventory
    inventoryItemId: safeString(raw?.inventoryItemId),
  };

  const errors = [];
  if (!lot.name) errors.push("Lot missing name");
  if (!batchId) errors.push("Lot missing batchId");
  return { lot, errors };
}

function normalizeInventoryFromLot(lot) {
  // inventory.jsx schema fields
  const id = lot.inventoryItemId || uid("inv");
  const name = lot.name;
  const item = {
    id,
    domain: DOMAIN.PRESERVATION,
    category: lot.category,
    name,
    nameLower: normalizeLower(name),
    tags: uniq(lot.tags),
    unit: lot.unit,
    quantity: Number(lot.quantity || 0),
    minOnHand: lot.minOnHand,
    location: lot.location,
    status: lot.status,
    notes: lot.notes,

    acquiredOn: lot.acquiredOn || "",
    packedOn: lot.packedOn || "",
    readyOn: lot.readyOn || "",
    bestByDate: lot.bestByDate || "",
    expiresOn: lot.expiresOn || "",
    shelfLifeDays: lot.shelfLifeDays,
    safetyDaysAfterBestBy: lot.safetyDaysAfterBestBy,
    treatBestByAsExpiry: !!lot.treatBestByAsExpiry,

    catalogItemId: safeString(lot.catalogItemId),
    batchId: safeString(lot.batchId),

    createdAt: lot.createdAt || nowISO(),
    updatedAt: nowISO(),
  };

  const errors = [];
  if (!item.name) errors.push("Inventory item missing name");
  return { item, errors };
}

/* -----------------------------------------------------------------------------
 * Query / facets helpers
 * --------------------------------------------------------------------------- */

async function getFacets(db) {
  const all = await db.homesteadBatches.toArray();
  const methods = uniq(
    all.map((b) => safeString(b.method)).filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const tags = uniq(
    all
      .flatMap((b) => b.tags || [])
      .map((x) => safeString(x))
      .filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  const statuses = uniq(
    all.map((b) => safeString(b.status)).filter(Boolean)
  ).sort((a, b) => a.localeCompare(b));
  return { methods, tags, statuses };
}

async function queryBatches({
  db,
  search,
  method,
  status,
  tag,
  dateFrom,
  dateTo,
  sortKey,
  page,
  pageSize,
}) {
  const s = normalizeLower(search);
  const m = normalizeLower(method);
  const st = normalizeLower(status);
  const tg = normalizeLower(tag);

  let coll = db.homesteadBatches.toCollection();

  coll = coll.filter((b) => {
    if (m && normalizeLower(b.method) !== m) return false;
    if (st && normalizeLower(b.status) !== st) return false;
    if (tg) {
      const ok = (b.tags || []).some((x) => normalizeLower(x) === tg);
      if (!ok) return false;
    }

    if (dateFrom) {
      const d0 = parseISODateOnly(dateFrom);
      const start =
        parseISODateOnly(b.startedAt) || parseISODateOnly(b.createdAt);
      if (d0 && start && start.getTime() < d0.getTime()) return false;
    }
    if (dateTo) {
      const d1 = parseISODateOnly(dateTo);
      const start =
        parseISODateOnly(b.startedAt) || parseISODateOnly(b.createdAt);
      if (d1 && start && start.getTime() > addDays(d1, 1).getTime())
        return false;
    }

    if (s) {
      const hay = [
        b.titleLower,
        b.methodLower,
        normalizeLower(b.location),
        normalizeLower(b.notes),
        (b.tags || []).map((x) => normalizeLower(x)).join(" "),
      ].join(" ");
      if (!hay.includes(s)) return false;
    }

    return true;
  });

  let arr = await coll.toArray();

  arr.sort((a, b) => {
    const aStart = safeString(a.startedAt || a.createdAt);
    const bStart = safeString(b.startedAt || b.createdAt);
    const aUp = safeString(a.updatedAt || a.createdAt);
    const bUp = safeString(b.updatedAt || b.createdAt);

    if (sortKey === "updated_desc") return bUp.localeCompare(aUp);
    // default start_desc
    return bStart.localeCompare(aStart);
  });

  const total = arr.length;
  const ps = clamp(pageSize || DEFAULT_PAGE_SIZE, 5, 100);
  const p = clamp(page || 1, 1, Math.max(1, Math.ceil(total / ps)));
  const start = (p - 1) * ps;
  const end = start + ps;

  return { items: arr.slice(start, end), total, page: p, pageSize: ps };
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
  type = "button",
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
 * Page
 * --------------------------------------------------------------------------- */

export default function HomesteadPlannerBatchesPage() {
  const dbRef = useRef(null);

  const [ready, setReady] = useState(false);
  const [dbError, setDbError] = useState(null);

  // batch history query state
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [method, setMethod] = useState("");
  const [status, setStatus] = useState("");
  const [tag, setTag] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [sortKey, setSortKey] = useState("start_desc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // results
  const [batches, setBatches] = useState([]);
  const [total, setTotal] = useState(0);

  const [facets, setFacets] = useState({
    methods: METHODS,
    tags: [],
    statuses: [],
  });

  // expanded batch -> lots
  const [expandedId, setExpandedId] = useState(null);
  const [lotsByBatch, setLotsByBatch] = useState({}); // batchId -> lots[]

  // UI state
  const [startOpen, setStartOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 200);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    const db = getDb();
    dbRef.current = db;

    (async () => {
      try {
        // basic probe
        await db.homesteadBatches.limit(1).toArray();
        await refreshFacets(db);
        setReady(true);
      } catch (e) {
        console.warn("[HomesteadBatches] init failed:", e);
        setDbError(
          "Batch storage isn’t available (IndexedDB blocked/unavailable)."
        );
        setReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [
    searchDebounced,
    method,
    status,
    tag,
    dateFrom,
    dateTo,
    sortKey,
    pageSize,
  ]);

  useEffect(() => {
    if (!ready) return;
    const db = dbRef.current;
    if (!db || dbError) {
      setBatches([]);
      setTotal(0);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await queryBatches({
          db,
          search: searchDebounced,
          method,
          status,
          tag,
          dateFrom,
          dateTo,
          sortKey,
          page,
          pageSize,
        });
        if (cancelled) return;
        setBatches(res.items);
        setTotal(res.total);
      } catch (e) {
        console.warn("[HomesteadBatches] query failed:", e);
        if (cancelled) return;
        setBatches([]);
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
    method,
    status,
    tag,
    dateFrom,
    dateTo,
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

  async function refreshFacets(db = dbRef.current) {
    if (!db || dbError) return;
    try {
      const f = await getFacets(db);
      setFacets((prev) => ({
        ...prev,
        methods: uniq([...(METHODS || []), ...(f.methods || [])]),
        tags: f.tags || [],
        statuses: f.statuses || [],
      }));
    } catch (e) {
      // ignore
    }
  }

  async function toggleExpand(batchId) {
    const db = dbRef.current;
    if (!db || dbError) return;

    setExpandedId((prev) => (prev === batchId ? null : batchId));

    if (lotsByBatch[batchId]) return;
    try {
      const lots = await db.homesteadBatchLots
        .where("batchId")
        .equals(batchId)
        .toArray();
      setLotsByBatch((prev) => ({ ...prev, [batchId]: lots }));
    } catch (e) {
      console.warn("[HomesteadBatches] load lots failed:", e);
    }
  }

  async function consumeInventory(inventoryItemId, amount = 1) {
    const db = dbRef.current;
    if (!db || dbError) return;

    const delta = Number(amount);
    if (!Number.isFinite(delta) || delta <= 0) {
      pushToast("Enter a positive amount.", "error");
      return;
    }

    try {
      const current = await db.homesteadInventory.get(inventoryItemId);
      if (!current) {
        pushToast("Inventory lot not found.", "error");
        return;
      }
      const newQty = Math.max(0, (current.quantity || 0) - delta);
      const updated = { ...current, quantity: newQty, updatedAt: nowISO() };
      await db.homesteadInventory.put(updated);

      emitSSAEvent("ssa.hp.inventory.updated", {
        source: PAGE_SOURCE,
        itemId: updated.id,
        delta,
        newQty,
        at: nowISO(),
      });

      pushToast(`Used ${delta} ${current.unit}.`, "success");
    } catch (e) {
      console.warn("[HomesteadBatches] consume inventory failed:", e);
      pushToast("Consume failed.", "error");
    }
  }

  async function exportBatchesJSON() {
    const db = dbRef.current;
    if (!db || dbError) return;

    try {
      const headers = await db.homesteadBatches.toArray();
      const lots = await db.homesteadBatchLots.toArray();

      downloadJSON(
        `ssa-homestead-batches-${new Date().toISOString().slice(0, 10)}.json`,
        {
          type: "SSA_HomesteadPlanner_Batches",
          version: 1,
          exportedAt: nowISO(),
          batches: headers,
          lots,
        }
      );

      pushToast("Exported JSON.", "success");
    } catch (e) {
      console.warn("[HomesteadBatches] export failed:", e);
      pushToast("Export failed.", "error");
    }
  }

  async function importBatchesJSON({ jsonText, mode }) {
    const db = dbRef.current;
    if (!db || dbError) return;

    const parsed = tryParseJSON(jsonText);
    if (!parsed.ok) {
      pushToast("Invalid JSON.", "error");
      return;
    }

    const payload = parsed.value;
    const headers =
      payload?.batches || payload?.headers || payload?.data?.batches;
    const lots = payload?.lots || payload?.data?.lots;

    if (!Array.isArray(headers) || !Array.isArray(lots)) {
      pushToast(
        "Import JSON must include arrays: {batches:[], lots:[]}.",
        "error"
      );
      return;
    }

    const normHeaders = [];
    const normLots = [];
    const problems = [];

    for (const raw of headers) {
      const { header, errors } = normalizeBatchHeader(raw);
      if (errors.length) problems.push({ kind: "batch", id: raw?.id, errors });
      else normHeaders.push(header);
    }
    for (const raw of lots) {
      const bid = safeString(raw?.batchId).trim();
      const { lot, errors } = normalizeBatchLot(raw, bid);
      if (errors.length) problems.push({ kind: "lot", id: raw?.id, errors });
      else normLots.push(lot);
    }

    if (!normHeaders.length) {
      pushToast("No valid batches found.", "error");
      return;
    }

    try {
      await db.transaction(
        "rw",
        db.homesteadBatches,
        db.homesteadBatchLots,
        async () => {
          if (mode === "replace") {
            await db.homesteadBatchLots.clear();
            await db.homesteadBatches.clear();
          }
          await db.homesteadBatches.bulkPut(normHeaders);
          await db.homesteadBatchLots.bulkPut(normLots);
        }
      );

      setImportOpen(false);
      await refreshFacets(db);
      pushToast(`Imported ${normHeaders.length} batch(es).`, "success");

      if (problems.length)
        console.warn("[HomesteadBatches] import problems:", problems);
    } catch (e) {
      console.warn("[HomesteadBatches] import failed:", e);
      pushToast("Import failed.", "error");
    }
  }

  return (
    <div className="p-4 md:p-6">
      <div className="max-w-6xl mx-auto">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-black tracking-tight">
              Preservation Batches
            </h1>
            <div className="text-sm opacity-80 mt-1">
              Batch history + start a new preservation batch (and create
              inventory lots).
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="ghost" onClick={() => setImportOpen(true)}>
              Import/Export
            </Button>
            <Button onClick={() => setStartOpen(true)}>+ Start Batch</Button>
          </div>
        </div>

        {dbError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm">
            <div className="font-bold text-red-800">
              Batch storage unavailable
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
              placeholder="Search title, method, tags, notes, location..."
            />
          </div>

          <div className="lg:col-span-3">
            <FieldLabel>Method</FieldLabel>
            <Select
              value={method}
              onChange={setMethod}
              options={[
                { value: "", label: "All methods" },
                ...facets.methods.map((m) => ({ value: m, label: m })),
              ]}
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel>Status</FieldLabel>
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: "", label: "All statuses" },
                ...uniq([
                  STATUS.DRAFT,
                  STATUS.COMPLETED,
                  STATUS.CANCELLED,
                  ...(facets.statuses || []),
                ]).map((s) => ({
                  value: s,
                  label: s,
                })),
              ]}
            />
          </div>

          <div className="lg:col-span-2">
            <FieldLabel>Sort</FieldLabel>
            <Select
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: "start_desc", label: "Start date (new → old)" },
                { value: "updated_desc", label: "Updated (new → old)" },
              ]}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3">
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
            <FieldLabel>Date from</FieldLabel>
            <Input type="date" value={dateFrom} onChange={setDateFrom} />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Date to</FieldLabel>
            <Input type="date" value={dateTo} onChange={setDateTo} />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Page size</FieldLabel>
            <Select
              value={String(pageSize)}
              onChange={(v) => setPageSize(Number(v))}
              options={[10, 20, 30, 50].map((n) => ({
                value: String(n),
                label: String(n),
              }))}
            />
          </div>
        </div>

        {/* Pager */}
        <div className="mt-4 flex items-center justify-between gap-2 flex-wrap">
          <div className="text-sm opacity-80">
            Showing <b>{batches.length}</b> of <b>{total}</b>
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

        {/* List */}
        <div className="mt-4 space-y-3">
          {batches.map((b) => (
            <BatchCard
              key={b.id}
              batch={b}
              expanded={expandedId === b.id}
              lots={lotsByBatch[b.id]}
              onToggle={() => toggleExpand(b.id)}
              onQuickUse={(inventoryItemId) =>
                consumeInventory(inventoryItemId, 1)
              }
            />
          ))}
        </div>

        {/* Empty */}
        {ready && !dbError && batches.length === 0 ? (
          <div className="mt-6 rounded-2xl border border-gray-200 p-6">
            <div className="font-bold">No batches yet</div>
            <div className="text-sm opacity-80 mt-1">
              Start a preservation batch to build your history and create lots
              in inventory.
            </div>
            <div className="mt-3">
              <Button onClick={() => setStartOpen(true)}>+ Start Batch</Button>
            </div>
          </div>
        ) : null}

        {/* Start batch modal */}
        <StartBatchModal
          open={startOpen}
          onClose={() => setStartOpen(false)}
          onCreated={() => {
            setStartOpen(false);
            setExpandedId(null);
            setLotsByBatch({});
            refreshFacets();
            pushToast("Batch created.", "success");
          }}
          onToast={pushToast}
        />

        {/* Import modal */}
        <ImportExportModal
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onExport={exportBatchesJSON}
          onImport={importBatchesJSON}
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
 * Batch Card
 * --------------------------------------------------------------------------- */

function BatchCard({ batch, expanded, lots, onToggle, onQuickUse }) {
  const tags = batch.tags || [];
  const started = toDateOnlyISO(batch.startedAt || batch.createdAt);
  const completed = batch.completedAt ? toDateOnlyISO(batch.completedAt) : "";
  const statusTone =
    batch.status === STATUS.COMPLETED
      ? "success"
      : batch.status === STATUS.CANCELLED
      ? "danger"
      : "neutral";

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-xs font-bold opacity-70">{batch.method}</div>
          <div className="font-black text-base mt-1">{batch.title}</div>
          <div className="text-xs opacity-70 mt-1">
            Started: <b>{started}</b>
            {completed ? (
              <>
                {" "}
                • Completed: <b>{completed}</b>
              </>
            ) : null}
            {batch.location ? (
              <>
                {" "}
                • Location: <b>{batch.location}</b>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Badge tone={statusTone}>{batch.status}</Badge>
          <Button variant="ghost" onClick={onToggle}>
            {expanded ? "Hide" : "View"} Lots
          </Button>
        </div>
      </div>

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

      {batch.notes ? (
        <div className="mt-3 text-sm whitespace-pre-wrap rounded-xl border border-gray-200 p-3 bg-gray-50">
          {batch.notes}
        </div>
      ) : null}

      {expanded ? (
        <div className="mt-4 rounded-2xl border border-gray-200 p-4">
          <div className="font-bold text-sm mb-2">Output Lots</div>
          {!lots ? (
            <div className="text-sm opacity-80">Loading…</div>
          ) : lots.length === 0 ? (
            <div className="text-sm opacity-80">
              No lots recorded for this batch.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {lots.map((lot) => (
                <LotCard
                  key={lot.id}
                  lot={lot}
                  onQuickUse={() =>
                    lot.inventoryItemId && onQuickUse(lot.inventoryItemId)
                  }
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function LotCard({ lot, onQuickUse }) {
  const meta = computeReadiness(lot, new Date());
  const r = readinessBadge(meta);
  const s = shelfLifeBadge(meta);

  return (
    <div className="rounded-2xl border border-gray-200 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold opacity-70">
            {lot.category || "Lot"}
          </div>
          <div className="font-black text-sm mt-1 truncate" title={lot.name}>
            {lot.name}
          </div>
          <div className="text-xs opacity-70 mt-1">
            Qty: <b>{Number(lot.quantity || 0).toLocaleString()}</b>{" "}
            {lot.unit || "unit"}
            {lot.location ? (
              <>
                {" "}
                • <b>{lot.location}</b>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={r.tone}>{r.label}</Badge>
          <Badge tone={s.tone}>{s.label}</Badge>
        </div>
      </div>

      <div className="mt-2 text-xs opacity-80 space-y-1">
        {lot.packedOn ? (
          <div>
            Packed: <b>{lot.packedOn}</b>
          </div>
        ) : null}
        {meta.readyOn ? (
          <div>
            Ready: <b>{toDateOnlyISO(meta.readyOn)}</b>{" "}
            {meta.daysUntilReady != null && meta.daysUntilReady > 0
              ? `(${meta.daysUntilReady}d)`
              : ""}
          </div>
        ) : null}
        {meta.bestByDate ? (
          <div>
            Best-by: <b>{toDateOnlyISO(meta.bestByDate)}</b>{" "}
            {meta.daysUntilBestBy != null ? `(${meta.daysUntilBestBy}d)` : ""}
          </div>
        ) : null}
        {meta.expiresOn ? (
          <div>
            Expires: <b>{toDateOnlyISO(meta.expiresOn)}</b>{" "}
            {meta.daysUntilExpiry != null ? `(${meta.daysUntilExpiry}d)` : ""}
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="text-xs opacity-60">
          {lot.inventoryItemId
            ? `Inventory: ${lot.inventoryItemId}`
            : "Not linked"}
        </div>
        <Button
          variant="ghost"
          onClick={onQuickUse}
          disabled={!lot.inventoryItemId || (lot.quantity || 0) <= 0}
          title="Use 1 unit from inventory lot"
        >
          Use 1
        </Button>
      </div>
    </div>
  );
}

/* -----------------------------------------------------------------------------
 * Start Batch Modal
 * --------------------------------------------------------------------------- */

function StartBatchModal({ open, onClose, onCreated, onToast }) {
  const dbRef = useRef(null);

  const [step, setStep] = useState(1);

  const [header, setHeader] = useState(() => ({
    title: "",
    method: "Canning",
    status: STATUS.DRAFT,
    startedAt: nowISO(),
    location: "",
    tags: [],
    notes: "",
  }));

  const [outputs, setOutputs] = useState(() => [
    {
      id: uid("lotdraft"),
      name: "",
      category: "",
      unit: "jar",
      quantity: 1,
      minOnHand: "",
      location: "",
      tags: [],
      notes: "",
      packedOn: toDateOnlyISO(new Date()),
      readyOn: "",
      bestByDate: "",
      expiresOn: "",
      shelfLifeDays: "",
      safetyDaysAfterBestBy: "",
      treatBestByAsExpiry: false,
    },
  ]);

  useEffect(() => {
    if (!open) return;
    dbRef.current = getDb();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // reset when opening
    setStep(1);
    setHeader({
      title: "",
      method: "Canning",
      status: STATUS.DRAFT,
      startedAt: nowISO(),
      location: "",
      tags: [],
      notes: "",
    });
    setOutputs([
      {
        id: uid("lotdraft"),
        name: "",
        category: "",
        unit: "jar",
        quantity: 1,
        minOnHand: "",
        location: "",
        tags: [],
        notes: "",
        packedOn: toDateOnlyISO(new Date()),
        readyOn: "",
        bestByDate: "",
        expiresOn: "",
        shelfLifeDays: "",
        safetyDaysAfterBestBy: "",
        treatBestByAsExpiry: false,
      },
    ]);
  }, [open]);

  function setHeaderField(k, v) {
    setHeader((prev) => ({ ...(prev || {}), [k]: v }));
  }

  function setOutputsField(idx, k, v) {
    setOutputs((prev) =>
      prev.map((o, i) => (i === idx ? { ...o, [k]: v } : o))
    );
  }

  function setOutputTags(idx, text) {
    const tags = text
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    setOutputsField(idx, "tags", uniq(tags));
  }

  function addOutput() {
    setOutputs((prev) => [
      ...prev,
      {
        id: uid("lotdraft"),
        name: "",
        category: "",
        unit: "jar",
        quantity: 1,
        minOnHand: "",
        location: "",
        tags: [],
        notes: "",
        packedOn: toDateOnlyISO(new Date()),
        readyOn: "",
        bestByDate: "",
        expiresOn: "",
        shelfLifeDays: "",
        safetyDaysAfterBestBy: "",
        treatBestByAsExpiry: false,
      },
    ]);
  }

  function removeOutput(idx) {
    setOutputs((prev) => prev.filter((_, i) => i !== idx));
  }

  const previewLots = useMemo(() => {
    const now = new Date();
    return outputs.map((o) => {
      const meta = computeReadiness(
        {
          ...o,
          quantity: Number(o.quantity || 0),
        },
        now
      );
      return { ...o, _meta: meta };
    });
  }, [outputs]);

  async function commitBatch() {
    const db = dbRef.current;
    if (!db) return;

    const title = header.title?.trim() || `${header.method} Batch`;
    const tags = uniq(
      safeArray(header.tags)
        .map((t) => safeString(t).trim())
        .filter(Boolean)
    );

    // Normalize header
    const { header: batchHeader, errors: headerErrors } = normalizeBatchHeader({
      ...header,
      title,
      tags,
      status: STATUS.COMPLETED, // committing from this modal finalizes the batch
      completedAt: nowISO(),
      startedAt: header.startedAt || nowISO(),
    });

    if (headerErrors.length) {
      onToast?.(headerErrors[0], "error");
      return;
    }

    // Normalize lots
    const normLots = [];
    for (const raw of outputs) {
      const { lot, errors } = normalizeBatchLot(
        {
          ...raw,
          quantity: Number(raw.quantity || 0),
          minOnHand: raw.minOnHand === "" ? undefined : Number(raw.minOnHand),
          packedOn: raw.packedOn,
        },
        batchHeader.id
      );
      if (errors.length) {
        onToast?.(errors[0], "error");
        return;
      }
      if (!lot.name) {
        onToast?.("Each output lot needs a name.", "error");
        return;
      }
      normLots.push(lot);
    }

    if (normLots.length === 0) {
      onToast?.("Add at least one output lot.", "error");
      return;
    }

    // Create inventory items for lots
    const inventoryItems = [];
    const patchedLots = [];

    for (const lot of normLots) {
      const invId = uid("inv");
      const { item: inv, errors: invErrors } = normalizeInventoryFromLot({
        ...lot,
        inventoryItemId: invId,
      });
      if (invErrors.length) {
        onToast?.(invErrors[0], "error");
        return;
      }
      inventoryItems.push(inv);
      patchedLots.push({ ...lot, inventoryItemId: invId });
    }

    try {
      await db.transaction(
        "rw",
        db.homesteadBatches,
        db.homesteadBatchLots,
        db.homesteadInventory,
        async () => {
          await db.homesteadBatches.put(batchHeader);
          await db.homesteadBatchLots.bulkPut(patchedLots);
          await db.homesteadInventory.bulkPut(inventoryItems);
        }
      );

      emitSSAEvent("ssa.hp.batch.created", {
        source: PAGE_SOURCE,
        batch: batchHeader,
        lots: patchedLots,
        at: nowISO(),
      });

      emitSSAEvent("ssa.hp.inventory.updated", {
        source: PAGE_SOURCE,
        createdFromBatchId: batchHeader.id,
        inventoryCount: inventoryItems.length,
        at: nowISO(),
      });

      onCreated?.();
    } catch (e) {
      console.warn("[StartBatchModal] commit failed:", e);
      onToast?.("Failed to create batch.", "error");
    }
  }

  if (!open) return null;

  return (
    <ModalShell
      open={open}
      title="Start Preservation Batch"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="text-xs opacity-70">
            Step {step}/3 • Commit creates batch history + inventory lots.
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {step > 1 ? (
              <Button
                variant="ghost"
                onClick={() => setStep((s) => Math.max(1, s - 1))}
              >
                ← Back
              </Button>
            ) : null}
            {step < 3 ? (
              <Button onClick={() => setStep((s) => Math.min(3, s + 1))}>
                Next →
              </Button>
            ) : (
              <Button onClick={commitBatch}>Commit Batch</Button>
            )}
          </div>
        </div>
      }
    >
      {step === 1 ? (
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-6">
            <FieldLabel>Title</FieldLabel>
            <Input
              value={header.title}
              onChange={(v) => setHeaderField("title", v)}
              placeholder="e.g., Tomato Sauce (Quart Jars)"
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Method</FieldLabel>
            <Select
              value={header.method}
              onChange={(v) => setHeaderField("method", v)}
              options={METHODS.map((m) => ({ value: m, label: m }))}
            />
          </div>

          <div className="md:col-span-3">
            <FieldLabel>Started at</FieldLabel>
            <Input
              type="datetime-local"
              value={toLocalDateTimeValue(header.startedAt)}
              onChange={(v) =>
                setHeaderField("startedAt", fromLocalDateTimeValue(v))
              }
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Location</FieldLabel>
            <Input
              value={header.location}
              onChange={(v) => setHeaderField("location", v)}
              placeholder="e.g., Kitchen, Outdoor canning station"
            />
          </div>

          <div className="md:col-span-6">
            <FieldLabel>Tags (one per line)</FieldLabel>
            <Textarea
              value={(header.tags || []).join("\n")}
              onChange={(v) =>
                setHeaderField(
                  "tags",
                  uniq(
                    v
                      .split("\n")
                      .map((x) => x.trim())
                      .filter(Boolean)
                  )
                )
              }
              rows={5}
              placeholder={"tomatoes\nquart\nsummer\n..."}
            />
          </div>

          <div className="md:col-span-12">
            <FieldLabel>Notes</FieldLabel>
            <Textarea
              value={header.notes}
              onChange={(v) => setHeaderField("notes", v)}
              rows={5}
              placeholder="Process notes, temps, pH, times, observations…"
            />
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div className="font-black">Outputs (lots)</div>
              <div className="text-sm opacity-80 mt-1">
                Each output becomes a preserved inventory lot.
              </div>
            </div>
            <Button variant="ghost" onClick={addOutput}>
              + Add Output
            </Button>
          </div>

          <div className="mt-4 space-y-4">
            {outputs.map((o, idx) => (
              <div
                key={o.id}
                className="rounded-2xl border border-gray-200 p-4"
              >
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="font-bold text-sm">Output #{idx + 1}</div>
                  <Button
                    variant="danger"
                    onClick={() => removeOutput(idx)}
                    disabled={outputs.length <= 1}
                  >
                    Remove
                  </Button>
                </div>

                <div className="mt-3 grid grid-cols-1 md:grid-cols-12 gap-3">
                  <div className="md:col-span-6">
                    <FieldLabel>Name *</FieldLabel>
                    <Input
                      value={o.name}
                      onChange={(v) => setOutputsField(idx, "name", v)}
                      placeholder="e.g., Tomato Sauce (Quart Jar)"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <FieldLabel>Category</FieldLabel>
                    <Input
                      value={o.category}
                      onChange={(v) => setOutputsField(idx, "category", v)}
                      placeholder="e.g., Canning"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <FieldLabel>Location</FieldLabel>
                    <Input
                      value={o.location}
                      onChange={(v) => setOutputsField(idx, "location", v)}
                      placeholder="Pantry • Preserves"
                    />
                  </div>

                  <div className="md:col-span-3">
                    <FieldLabel>Unit</FieldLabel>
                    <Input
                      value={o.unit}
                      onChange={(v) => setOutputsField(idx, "unit", v)}
                      placeholder="jar"
                    />
                  </div>
                  <div className="md:col-span-3">
                    <FieldLabel>Quantity</FieldLabel>
                    <Input
                      type="number"
                      value={String(o.quantity)}
                      onChange={(v) => setOutputsField(idx, "quantity", v)}
                    />
                  </div>
                  <div className="md:col-span-3">
                    <FieldLabel>Min on hand</FieldLabel>
                    <Input
                      type="number"
                      value={String(o.minOnHand ?? "")}
                      onChange={(v) => setOutputsField(idx, "minOnHand", v)}
                      placeholder="(optional)"
                    />
                  </div>
                  <div className="md:col-span-3 flex items-end">
                    <label className="text-sm flex items-center gap-2 select-none">
                      <input
                        type="checkbox"
                        checked={!!o.treatBestByAsExpiry}
                        onChange={(e) =>
                          setOutputsField(
                            idx,
                            "treatBestByAsExpiry",
                            e.target.checked
                          )
                        }
                      />
                      Treat best-by as expiry
                    </label>
                  </div>

                  <div className="md:col-span-3">
                    <FieldLabel>Packed on</FieldLabel>
                    <Input
                      type="date"
                      value={o.packedOn}
                      onChange={(v) => setOutputsField(idx, "packedOn", v)}
                    />
                  </div>

                  <div className="md:col-span-3">
                    <FieldLabel>Ready on</FieldLabel>
                    <Input
                      type="date"
                      value={o.readyOn}
                      onChange={(v) => setOutputsField(idx, "readyOn", v)}
                    />
                  </div>

                  <div className="md:col-span-3">
                    <FieldLabel>Shelf life days</FieldLabel>
                    <Input
                      type="number"
                      value={String(o.shelfLifeDays ?? "")}
                      onChange={(v) => setOutputsField(idx, "shelfLifeDays", v)}
                      placeholder="e.g., 365"
                    />
                  </div>

                  <div className="md:col-span-3">
                    <FieldLabel>Safety days after best-by</FieldLabel>
                    <Input
                      type="number"
                      value={String(o.safetyDaysAfterBestBy ?? "")}
                      onChange={(v) =>
                        setOutputsField(idx, "safetyDaysAfterBestBy", v)
                      }
                      placeholder="e.g., 30"
                    />
                  </div>

                  <div className="md:col-span-3">
                    <FieldLabel>Best-by date</FieldLabel>
                    <Input
                      type="date"
                      value={o.bestByDate}
                      onChange={(v) => setOutputsField(idx, "bestByDate", v)}
                    />
                  </div>

                  <div className="md:col-span-3">
                    <FieldLabel>Expires on</FieldLabel>
                    <Input
                      type="date"
                      value={o.expiresOn}
                      onChange={(v) => setOutputsField(idx, "expiresOn", v)}
                    />
                  </div>

                  <div className="md:col-span-6">
                    <FieldLabel>Tags (one per line)</FieldLabel>
                    <Textarea
                      value={(o.tags || []).join("\n")}
                      onChange={(v) => setOutputTags(idx, v)}
                      rows={4}
                      placeholder={"canning\nsauce\n..."}
                    />
                  </div>

                  <div className="md:col-span-6">
                    <FieldLabel>Notes</FieldLabel>
                    <Textarea
                      value={o.notes}
                      onChange={(v) => setOutputsField(idx, "notes", v)}
                      rows={4}
                      placeholder="Optional lot notes…"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {step === 3 ? (
        <div>
          <div className="font-black">Preview</div>
          <div className="text-sm opacity-80 mt-1">
            Review readiness + shelf-life and confirm commit.
          </div>

          <div className="mt-4 rounded-2xl border border-gray-200 p-4">
            <div className="text-sm">
              <div>
                Title: <b>{header.title?.trim() || `${header.method} Batch`}</b>
              </div>
              <div className="mt-1">
                Method: <b>{header.method}</b> • Started:{" "}
                <b>{toDateOnlyISO(header.startedAt)}</b>
              </div>
              {header.location ? (
                <div className="mt-1">
                  Location: <b>{header.location}</b>
                </div>
              ) : null}
              {(header.tags || []).length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {(header.tags || []).map((t) => (
                    <span
                      key={t}
                      className="text-xs rounded-full border border-gray-200 px-2 py-1"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
            {previewLots.map((lot) => {
              const meta = lot._meta || computeReadiness(lot, new Date());
              const r = readinessBadge(meta);
              const s = shelfLifeBadge(meta);
              return (
                <div
                  key={lot.id}
                  className="rounded-2xl border border-gray-200 p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-xs font-bold opacity-70">
                        {lot.category || header.method}
                      </div>
                      <div
                        className="font-black text-base mt-1 truncate"
                        title={lot.name}
                      >
                        {lot.name || "(Unnamed lot)"}
                      </div>
                      <div className="text-sm opacity-80 mt-1">
                        Qty: <b>{Number(lot.quantity || 0)}</b>{" "}
                        {lot.unit || "unit"} • Packed:{" "}
                        <b>{lot.packedOn || "—"}</b>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge tone={r.tone}>{r.label}</Badge>
                      <Badge tone={s.tone}>{s.label}</Badge>
                    </div>
                  </div>

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
                </div>
              );
            })}
          </div>

          <div className="mt-4 text-xs opacity-70">
            Commit will create:
            <ul className="list-disc ml-5 mt-1">
              <li>
                1 batch header in <b>homesteadBatches</b>
              </li>
              <li>
                {previewLots.length} output rows in <b>homesteadBatchLots</b>
              </li>
              <li>
                {previewLots.length} inventory lots in <b>homesteadInventory</b>{" "}
                (domain: preservation)
              </li>
            </ul>
          </div>
        </div>
      ) : null}
    </ModalShell>
  );
}

function toLocalDateTimeValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

function fromLocalDateTimeValue(v) {
  if (!v) return nowISO();
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return nowISO();
  return d.toISOString();
}

/* -----------------------------------------------------------------------------
 * Import/Export Modal
 * --------------------------------------------------------------------------- */

function ImportExportModal({ open, onClose, onExport, onImport }) {
  const [mode, setMode] = useState("merge");
  const [text, setText] = useState("");

  useEffect(() => {
    if (!open) {
      setText("");
      setMode("merge");
    }
  }, [open]);

  if (!open) return null;

  return (
    <ModalShell
      open={open}
      title="Import / Export Batches"
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
            Merge updates matching IDs and adds new ones. Replace clears batches
            first.
          </div>
        </div>

        <div className="md:col-span-8">
          <FieldLabel>Paste batches JSON</FieldLabel>
          <Textarea
            value={text}
            onChange={setText}
            rows={14}
            placeholder='{"batches":[...], "lots":[...]}'
          />
          <div className="text-xs opacity-70 mt-2">
            Expected shape: object with <b>batches</b> and <b>lots</b> arrays.
          </div>
        </div>
      </div>
    </ModalShell>
  );
}

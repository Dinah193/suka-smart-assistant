/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\knowledge\yield-curves.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * knowledge/yield-curves.jsx — Yield Curves Knowledge Page
 * -----------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * Imports → Intelligence → Automation → (optional) Hub Export
 *
 * - "Yield curves" here are domain intelligence maps that convert inputs
 *   (animals, cuts, produce, preservation methods, substitutions) into
 *   expected outputs (weights, ratios, loss %, jars/trays, etc.).
 *
 * - This page lets you browse, validate, import, and update yield curves.
 *   Changes to household knowledge will emit events to the shared event bus
 *   in the canonical payload shape: { type, ts, source, data } with ISO time.
 *
 * - If a change impacts household planning (sessions/inventory/storehouse),
 *   we opportunistically forward a formatted packet to the Hub when
 *   featureFlags.familyFundMode === true, using HubPacketFormatter and
 *   FamilyFundConnector (assumed to exist). Failures are silent by design.
 *
 * FORWARD-THINKING
 * - Categories are dynamic; supports new domains (preservation, animal, storehouse).
 * - Soft-imports for all external modules to avoid hard failures.
 * - Defensive validation and bounded in-memory buffers.
 *
 * AUTOMATION TOUCHPOINTS
 * - Emits:
 *   • yieldcurve.created
 *   • yieldcurve.updated
 *   • yieldcurve.deleted
 *   • yieldcurve.recalculated (inform downstream session engines)
 */

// ----------------------------- Soft Imports ---------------------------------
let eventBus = null;
try {
  eventBus = require("@/services/eventBus").default ?? require("@/services/eventBus");
} catch {}

let Config = { get: (_k, fallback) => fallback };
try {
  Config = require("@/config").default ?? require("@/config");
} catch {}

let HubPacketFormatter = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
} catch {}

let FamilyFundConnector = null;
try {
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {}

let db = null; // Dexie instance (optional)
try {
  db = require("@/db").default ?? require("@/db");
} catch {}

// Optional domain service if you have one
let YieldCurveService = null;
try {
  YieldCurveService = require("@/services/yield/YieldCurveService").default;
} catch {}

// ------------------------------ Utilities -----------------------------------
const NOW_ISO = () => new Date().toISOString();

function isISO(s) {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !Number.isNaN(d.valueOf());
}
function ensureISO(ts) {
  return isISO(ts) ? ts : NOW_ISO();
}
function nanoid(len = 12) {
  const a = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += a[(Math.random() * a.length) | 0];
  return out;
}

// Heuristic schema guard for yield curves. Keep permissive & extensible.
function validateYieldCurve(obj) {
  if (!obj || typeof obj !== "object") return { ok: false, reason: "not-an-object" };
  if (!obj.id || typeof obj.id !== "string") return { ok: false, reason: "missing-id" };
  if (!obj.name || typeof obj.name !== "string") return { ok: false, reason: "missing-name" };
  if (!obj.category || typeof obj.category !== "string")
    return { ok: false, reason: "missing-category" };
  // Optional: version, unit, notes, mappings, entries[]
  if (obj.entries && !Array.isArray(obj.entries))
    return { ok: false, reason: "entries-not-array" };
  return { ok: true };
}

function normalizeYieldCurve(obj) {
  const base = {
    id: String(obj.id),
    name: String(obj.name),
    category: String(obj.category), // e.g., 'meat', 'preservation', 'substitutions', 'garden'
    version: obj.version ?? 1,
    unit: obj.unit ?? null, // e.g., 'lb', 'kg', 'jar', 'tray', 'percent'
    notes: obj.notes ?? "",
    entries: Array.isArray(obj.entries) ? obj.entries : [],
    meta: typeof obj.meta === "object" && obj.meta ? obj.meta : {},
    updatedAt: NOW_ISO(),
    createdAt: obj.createdAt && isISO(obj.createdAt) ? obj.createdAt : NOW_ISO(),
  };
  return base;
}

function downloadJSON(filename, obj) {
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.warn("[yield-curves] downloadJSON failed", e);
  }
}

/**
 * exportToHubIfEnabled: silent and non-blocking best-effort export
 * 1) checks featureFlags.familyFundMode
 * 2) formats with HubPacketFormatter
 * 3) sends with FamilyFundConnector
 */
async function exportToHubIfEnabled(eventPayload) {
  try {
    const flags = Config.get?.("featureFlags", {}) ?? {};
    if (!flags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;

    const packet = HubPacketFormatter.format?.(eventPayload);
    if (!packet) return;

    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[yield-curves] Hub export failed (ignored):", err);
    }
  }
}

// Safe emit that also mirrors to Hub when appropriate
function emitEvent(type, source, data) {
  const payload = { type, ts: NOW_ISO(), source, data };
  try {
    if (eventBus?.emit) eventBus.emit(payload);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[yield-curves] bus.emit failed:", e);
    }
  }
  // Household knowledge changes can influence downstream planning → export
  if (type.startsWith("yieldcurve.") || type === "yieldcurve.recalculated") {
    exportToHubIfEnabled(payload); // fire-and-forget
  }
  return payload;
}

// --------------------------- Data Access (soft) ------------------------------
async function listAllYieldCurves() {
  // Prefer domain service -> db -> fallback memory
  if (YieldCurveService?.list) {
    return (await YieldCurveService.list()) ?? [];
  }
  if (db?.yieldCurves?.toArray) {
    return (await db.yieldCurves.toArray()) ?? [];
  }
  // Fallback: empty
  return [];
}

async function upsertYieldCurve(curve) {
  if (!curve?.id) throw new Error("curve.id required");
  if (YieldCurveService?.upsert) {
    return YieldCurveService.upsert(curve);
  }
  if (db?.yieldCurves?.put) {
    return db.yieldCurves.put(curve); // Dexie .put does upsert
  }
  return null;
}

async function deleteYieldCurve(id) {
  if (!id) return;
  if (YieldCurveService?.remove) return YieldCurveService.remove(id);
  if (db?.yieldCurves?.delete) return db.yieldCurves.delete(id);
  return null;
}

// ------------------------------- Component -----------------------------------
export default function KnowledgeYieldCurvesPage() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState({ kind: "idle", message: "" });
  const fileInputRef = useRef(null);

  // Initial load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const all = await listAllYieldCurves();
        if (!alive) return;
        setItems(Array.isArray(all) ? all : []);
      } catch (e) {
        setStatus({ kind: "warn", message: "Could not load yield curves (degraded mode)." });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Derived facets
  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.category).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [items]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((it) => {
      if (category !== "all" && it.category !== category) return false;
      if (!s) return true;
      const hay = `${it.id} ${it.name} ${it.category} ${it.unit} ${it.notes} ${JSON.stringify(
        it.entries ?? []
      )}`.toLowerCase();
      return hay.includes(s);
    });
  }, [items, q, category]);

  const kpis = useMemo(() => {
    const total = items.length;
    const byCat = items.reduce((acc, it) => {
      acc[it.category] = (acc[it.category] ?? 0) + 1;
      return acc;
    }, {});
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return { total, top };
  }, [items]);

  // ------------------------------- Actions ----------------------------------
  const onClickImport = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChange = useCallback(async (e) => {
    try {
      const file = e.target.files?.[0];
      if (!file) return;
      const text = await file.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        setStatus({ kind: "error", message: "Invalid JSON file." });
        return;
      }

      // Accept either a single curve or an array of curves
      const toIngest = Array.isArray(json) ? json : [json];
      let created = 0;
      let updated = 0;

      for (const raw of toIngest) {
        const check = validateYieldCurve(raw);
        if (!check.ok) {
          console.warn("Skipped invalid curve:", check.reason, raw);
          continue;
        }
        const normalized = normalizeYieldCurve(raw);
        const exists = items.find((x) => x.id === normalized.id);
        await upsertYieldCurve(normalized);
        if (exists) {
          emitEvent("yieldcurve.updated", "KnowledgeYieldCurves", {
            id: normalized.id,
            name: normalized.name,
            category: normalized.category,
            unit: normalized.unit,
          });
          updated++;
        } else {
          emitEvent("yieldcurve.created", "KnowledgeYieldCurves", {
            id: normalized.id,
            name: normalized.name,
            category: normalized.category,
            unit: normalized.unit,
          });
          created++;
        }
      }

      // Refresh list
      const refreshed = await listAllYieldCurves();
      setItems(Array.isArray(refreshed) ? refreshed : []);

      setStatus({
        kind: "ok",
        message: `Imported ${created + updated} curve(s) (${created} created, ${updated} updated).`,
      });
      e.target.value = ""; // reset
    } catch (err) {
      console.error(err);
      setStatus({ kind: "error", message: "Import failed." });
    }
  }, [items]);

  const onDelete = useCallback(
    async (id) => {
      if (!id) return;
      if (!confirm("Delete this yield curve?")) return;
      try {
        await deleteYieldCurve(id);
        emitEvent("yieldcurve.deleted", "KnowledgeYieldCurves", { id });
        const refreshed = await listAllYieldCurves();
        setItems(Array.isArray(refreshed) ? refreshed : []);
      } catch (e) {
        setStatus({ kind: "error", message: "Delete failed." });
      }
    },
    []
  );

  const onExportAll = useCallback(() => {
    downloadJSON(
      `ssa-yield-curves-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      items
    );
  }, [items]);

  const onRecalculate = useCallback(async () => {
    // This is a signal to downstream engines to recompute projections that
    // depend on yield curves (e.g., cut yields → inventory projections,
    // preservation capacity → session planning).
    emitEvent("yieldcurve.recalculated", "KnowledgeYieldCurves", { count: items.length });
    setStatus({ kind: "ok", message: "Recalculation signal emitted." });
  }, [items.length]);

  // ------------------------------- Render -----------------------------------
  return (
    <div className="p-4 md:p-6">
      <header className="mb-5 md:mb-7">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold">Yield Curves</h1>
            <p className="text-sm text-neutral-600">
              Domain intelligence for meat cuts, preservation methods, substitutions, and produce.
              Changes emit bus events and optionally export to the Hub.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button className="rounded-xl border px-3 py-2 text-sm hover:shadow" onClick={onRecalculate}>
              Recalculate projections
            </button>
            <button className="rounded-xl border px-3 py-2 text-sm hover:shadow" onClick={onExportAll}>
              Export JSON
            </button>
            <button className="rounded-xl border px-3 py-2 text-sm hover:shadow" onClick={onClickImport}>
              Import JSON
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={onFileChange}
            />
          </div>
        </div>

        {status.kind !== "idle" && (
          <div
            className={
              "mt-2 text-xs rounded-lg p-2 border " +
              (status.kind === "ok"
                ? "border-green-300 bg-green-50 text-green-800"
                : status.kind === "warn"
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : status.kind === "error"
                ? "border-rose-300 bg-rose-50 text-rose-800"
                : "border-neutral-200")
            }
          >
            {status.message}
          </div>
        )}
      </header>

      {/* KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-6">
        <KpiCard label="Total curves" value={kpis.total} />
        <KpiCard
          label="Top categories"
          value={kpis.top.length ? `${kpis.top[0][0]} ×${kpis.top[0][1]}` : "—"}
        />
        <KpiCard
          label="Second category"
          value={kpis.top.length > 1 ? `${kpis.top[1][0]} ×${kpis.top[1][1]}` : "—"}
        />
      </section>

      {/* Filters */}
      <section className="rounded-2xl border p-3 md:p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4">
          <div className="md:col-span-4">
            <label className="block text-xs text-neutral-600 mb-1">Search</label>
            <input
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Find by name, id, unit, notes, or entry text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="md:col-span-4">
            <label className="block text-xs text-neutral-600 mb-1">Category</label>
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm bg-white"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Grid */}
      <section>
        {filtered.length === 0 ? (
          <div className="text-sm text-neutral-600 border rounded-2xl p-6 text-center">
            No yield curves found. Import some JSON or add via your YieldCurveService.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
            {filtered.map((it) => (
              <CurveCard key={it.id} curve={it} onDelete={onDelete} />
            ))}
          </div>
        )}
      </section>

      {/* Docs */}
      <section className="mt-8">
        <details className="rounded-2xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            How yield curves drive SSA
          </summary>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
            <li>
              <strong>Imports →</strong> Scan seed packets, animal plans, or how-to guides; normalizers
              map raw content into domain facts (methods, equipment, seasonality).
            </li>
            <li>
              <strong>Intelligence →</strong> Yield curves translate ingredients/inputs into expected
              outputs (trim loss, jar/tray counts, dried ratios).
            </li>
            <li>
              <strong>Automation →</strong> Session engines (Cooking, Cleaning, Garden, Animal,
              Preservation) use curves to size tasks and detect shortages.
            </li>
            <li>
              <strong>Hub export (optional) →</strong> When enabled, created/updated curves are
              formatted and forwarded to SVFFH so community planners can align supply with demand.
            </li>
          </ul>
        </details>
      </section>
    </div>
  );
}

// ------------------------------- UI Bits ------------------------------------
function KpiCard({ label, value }) {
  return (
    <div className="rounded-2xl border p-3 md:p-4">
      <div className="text-xs text-neutral-600 mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value ?? 0}</div>
    </div>
  );
}

function CurveCard({ curve, onDelete }) {
  const [open, setOpen] = useState(false);

  const handleDelete = useCallback(() => {
    onDelete?.(curve.id);
  }, [curve.id, onDelete]);

  const emitPreview = useCallback(() => {
    // Broadcast a non-mutating preview signal for downstream UIs
    emitEvent("yieldcurve.preview", "KnowledgeYieldCurves", {
      id: curve.id,
      category: curve.category,
      unit: curve.unit,
    });
  }, [curve.id, curve.category, curve.unit]);

  return (
    <div className="rounded-2xl border p-3 md:p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{curve.name}</div>
          <div className="text-xs text-neutral-600">
            <span className="mr-2">#{curve.id}</span>
            <span className="px-2 py-0.5 border rounded-full">{curve.category}</span>
            {curve.unit ? <span className="ml-2 text-neutral-500">• {curve.unit}</span> : null}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="text-xs rounded-lg border px-2 py-1 hover:shadow"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "View"}
          </button>
          <button className="text-xs rounded-lg border px-2 py-1 hover:shadow" onClick={emitPreview}>
            Signal
          </button>
          <button
            className="text-xs rounded-lg border px-2 py-1 hover:shadow text-rose-700"
            onClick={handleDelete}
            title="Delete curve"
          >
            Delete
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3">
          <div className="text-xs text-neutral-600 mb-1">Notes</div>
          <div className="text-sm">{curve.notes || "—"}</div>

          <div className="text-xs text-neutral-600 mt-3 mb-1">Entries</div>
          {Array.isArray(curve.entries) && curve.entries.length ? (
            <pre className="text-xs bg-neutral-50 rounded-lg p-2 max-h-64 overflow-auto dark:bg-neutral-900">
{JSON.stringify(curve.entries, null, 2)}
            </pre>
          ) : (
            <div className="text-sm text-neutral-500">No entries.</div>
          )}

          {curve.meta && Object.keys(curve.meta).length > 0 && (
            <>
              <div className="text-xs text-neutral-600 mt-3 mb-1">Meta</div>
              <pre className="text-xs bg-neutral-50 rounded-lg p-2 max-h-64 overflow-auto dark:bg-neutral-900">
{JSON.stringify(curve.meta, null, 2)}
              </pre>
            </>
          )}

          <div className="text-[11px] text-neutral-500 mt-2">
            Updated {curve.updatedAt ? new Date(curve.updatedAt).toLocaleString() : "unknown"}
          </div>
        </div>
      )}
    </div>
  );
}

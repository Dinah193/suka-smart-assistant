/* eslint-disable no-console */
// FavoriteImportButton — import plans + favorites (merge/replace) with preview & backup
// - Drag & drop or file picker (.json)
// - Works with FavoritePlans.importAll() or PlanStorageRouter fallback
// - Backup export before replace, toasts + NBA pulses, accessible

import React, { useEffect, useRef, useState } from "react";

/* --------------------------------- Imports -------------------------------- */
let FavoritePlans = null;
try {
  const mod = require("@/managers/FavoritePlans");
  FavoritePlans = mod?.default || mod || null;
} catch (_e) {}

let PlanStorageFactory = null;
try {
  const psr = require("@/managers/storage/PlanStorageRouter");
  PlanStorageFactory = psr?.createPlanStorageRouter || null;
} catch (_e) {}

let eventBus = { on(){}, off(){}, emit(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let automation = null;
try {
  const rt = require("@/services/automation/runtime");
  automation = rt?.automation || rt?.default || null;
} catch (_e) {}

const isBrowser = typeof window !== "undefined";

/* ---------------------------------- Icons --------------------------------- */
const IconUpload = (p) => (
  <svg viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <path d="M5 20h14v-2H5v2zM11 8.83V18h2V8.83l3.59 3.58L18 11l-6-6-6 6 1.41 1.41L11 8.83z"/>
  </svg>
);
const IconX = (p) => (
  <svg viewBox="0 0 24 24" className={p.className} aria-hidden="true">
    <path d="M6.225 4.811L4.811 6.225 9.586 11l-4.775 4.775 1.414 1.414L11 12.414l4.775 4.775 1.414-1.414L12.414 11l4.775-4.775-1.414-1.414L11 9.586 6.225 4.811z"/>
  </svg>
);

/* --------------------------------- Helpers -------------------------------- */
const cls = (...xs) => xs.filter(Boolean).join(" ");
const prettyNum = (n) => (n == null ? "0" : n.toLocaleString());

function summarizeBlob(data) {
  // Supports both router-style { plans, favorites } and legacy blob with featured/userPlans/favorites
  if (!data) return { plans: 0, featured: 0, userPlans: 0, favorites: 0, domains: new Set() };
  const summary = { plans: 0, featured: 0, userPlans: 0, favorites: 0, domains: new Set() };

  if (Array.isArray(data.plans)) {
    summary.plans = data.plans.length;
    data.plans.forEach(p => summary.domains.add(p?.domain || "meals"));
  }
  if (data.favorites?.byId) summary.favorites = Object.keys(data.favorites.byId).length;

  if (data.featured) {
    Object.values(data.featured).forEach(arr => {
      summary.featured += (arr?.length || 0);
      (arr || []).forEach(p => summary.domains.add(p?.domain || "meals"));
    });
  }
  if (data.userPlans) {
    Object.values(data.userPlans).forEach(arr => {
      summary.userPlans += (arr?.length || 0);
      (arr || []).forEach(p => summary.domains.add(p?.domain || "meals"));
    });
  }
  return summary;
}

function downloadJSON(obj, filename = "suka-backup.json") {
  if (!isBrowser) return;
  try {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.setAttribute("href", url);
    a.setAttribute("download", filename);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2500);
  } catch (_e) {}
}

/* -------------------------------- Component ------------------------------- */
/**
 * @param {object} props
 * @param {string} props.userId
 * @param {string=} props.className
 * @param {("outline"|"solid"|"ghost")=} props.variant
 */
export default function FavoriteImportButton({
  userId = "anon",
  className,
  variant = "outline",
}) {
  const [open, setOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [fileName, setFileName] = useState("");
  const [payload, setPayload] = useState(null);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("merge"); // merge | replace
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const [routerReady, setRouterReady] = useState(false);
  const routerRef = useRef(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!PlanStorageFactory) return setRouterReady(false);
      try {
        const r = await PlanStorageFactory({ userId });
        if (alive) { routerRef.current = r; setRouterReady(!!r); }
      } catch (_e) {
        if (alive) setRouterReady(false);
      }
    })();
    return () => { alive = false; };
  }, [userId]);

  const buttonBase = "inline-flex items-center gap-2 rounded-xl border text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 transition";
  const buttonStyle =
    variant === "solid"
      ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700 focus-visible:ring-blue-500"
      : variant === "ghost"
      ? "bg-transparent text-blue-700 border-transparent hover:bg-blue-50 focus-visible:ring-blue-500"
      : "bg-white text-blue-700 border-blue-600 hover:bg-blue-50 focus-visible:ring-blue-500";

  const summary = summarizeBlob(payload?.data);

  function resetState() {
    setFileName("");
    setPayload(null);
    setError("");
    setMode("merge");
    setFavoritesOnly(false);
  }

  function openModal() {
    resetState();
    setOpen(true);
  }

  function closeModal() {
    setOpen(false);
  }

  async function onPickFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    await readFile(f);
  }

  async function readFile(file) {
    setError("");
    try {
      setFileName(file.name);
      const text = await file.text();
      const obj = JSON.parse(text);

      // accept either already-wrapped {kind, data} or raw data -> wrap
      const data = obj?.data ? obj : { kind: "suka.favorites.export", version: obj?.version || obj?.data?.version || 2, data: obj?.data ? obj.data : obj };
      setPayload(data);
    } catch (err) {
      setError("Invalid JSON file. Please select a valid Suka export.");
      setPayload(null);
    }
  }

  function onDrop(ev) {
    ev.preventDefault();
    setDragOver(false);
    const f = ev.dataTransfer?.files?.[0];
    if (f) readFile(f);
  }

  function onDragOver(ev) {
    ev.preventDefault();
    setDragOver(true);
  }

  function onDragLeave() { setDragOver(false); }

  async function backupExport() {
    try {
      setBusy(true);
      // Prefer FavoritePlans export (works offline too)
      if (FavoritePlans?.exportAll) {
        const blob = await FavoritePlans.exportAll({ userId });
        downloadJSON(blob, `suka-backup-${userId}-${Date.now()}.json`);
        eventBus.emit?.("toast.show", { level: "success", title: "Backup created", message: "Your current favorites and plans were exported.", ts: Date.now() });
        return;
      }
      // Router fallback (minimal)
      const r = routerRef.current;
      if (r?.adapter?.keys && r?.adapter?.bulkGet && r?.adapter?.get) {
        const uKeys = await r.adapter.keys(`plans:user:${userId}:`);
        const gKeys = await r.adapter.keys(`plans:global:`);
        const plans = (await r.adapter.bulkGet(uKeys.concat(gKeys))).filter(Boolean);
        const favorites = (await r.adapter.get(`favorites:user:${userId}`)) || { byId: {} };
        downloadJSON({ kind:"suka.favorites.export", version:3, exportedAt: Date.now(), data:{ plans, favorites } },
          `suka-backup-${userId}-${Date.now()}.json`
        );
        eventBus.emit?.("toast.show", { level: "success", title: "Backup created", message: "Your current favorites and plans were exported.", ts: Date.now() });
      }
    } catch (err) {
      eventBus.emit?.("toast.show", { level: "error", title: "Backup failed", message: String(err?.message || err), ts: Date.now() });
    } finally {
      setBusy(false);
    }
  }

  async function performImport() {
    if (!payload?.data) {
      setError("No file loaded.");
      return;
    }
    setBusy(true);
    try {
      const mergeMode = mode; // "merge" | "replace"

      // If replace, encourage backup first
      if (mergeMode === "replace") {
        try { await backupExport(); } catch (_e) {}
      }

      let ok = false;

      // If user chooses favorites-only, strip plan payload but keep favorites map
      let incoming = JSON.parse(JSON.stringify(payload));
      if (favoritesOnly) {
        if (incoming.data) {
          incoming.data = { favorites: incoming.data.favorites || incoming.data?.data?.favorites || {} };
        }
      }

      // Preferred: FavoritePlans.importAll
      if (FavoritePlans?.importAll) {
        ok = await FavoritePlans.importAll({ userId, blob: incoming, mergeMode });
      } else if (routerReady) {
        // Fallback: apply using PlanStorageRouter adapter directly
        const r = routerRef.current;
        const data = incoming?.data;
        if (!data) throw new Error("Invalid import payload.");

        // Replace mode: we avoid destructive purge for safety in this UI.
        // (If you later add a confirmed destructive purge API, call r.purgeUserScope?.(userId).)

        // Write plans if available
        if (!favoritesOnly) {
          if (Array.isArray(data.plans) && r?.adapter?.bulkSet) {
            const entries = data.plans.map(p => ({
              key: (p.scope && String(p.scope).startsWith("global"))
                ? `plans:global:${p.id}`
                : `plans:user:${userId}:${p.id}`,
              value: { ...p, meta: { ...(p.meta||{}), createdBy: p.meta?.createdBy || userId } }
            }));
            if (entries.length) await r.adapter.bulkSet(entries);
          } else if ((data.userPlans || data.featured) && r?.adapter?.bulkSet) {
            const entries = [];
            for (const d of Object.keys(data.userPlans || {})) {
              for (const p of (data.userPlans[d] || [])) {
                entries.push({ key: `plans:user:${userId}:${p.id}`, value: p });
              }
            }
            for (const d of Object.keys(data.featured || {})) {
              for (const p of (data.featured[d] || [])) {
                entries.push({ key: `plans:global:${p.id}`, value: p });
              }
            }
            if (entries.length) await r.adapter.bulkSet(entries);
          }
        }

        // Write favorites
        if (data.favorites && r?.adapter?.set) {
          if (mergeMode === "replace") {
            await r.adapter.set(`favorites:user:${userId}`, { byId: { ...(data.favorites.byId || {}) } });
          } else {
            const existing = (await r.adapter.get(`favorites:user:${userId}`)) || { byId: {} };
            await r.adapter.set(`favorites:user:${userId}`, { byId: { ...existing.byId, ...(data.favorites.byId || {}) } });
          }
        }
        ok = true;
      }

      if (!ok) throw new Error("Import path unavailable.");

      // Orchestration & pulses
      automation?.emit?.("nba.signal", {
        kind: "favorites.imported",
        userId,
        mode: mergeMode,
        counts: {
          plans: summary.plans || (summary.featured + summary.userPlans),
          favorites: summary.favorites,
        },
        ts: Date.now(),
      });
      eventBus.emit?.("favorites.changed", { domain: null, userId, ts: Date.now() });
      eventBus.emit?.("toast.show", { level: "success", title: "Import complete", message: "Your plans and favorites were imported.", ts: Date.now() });

      setOpen(false);
    } catch (err) {
      console.warn("[FavoriteImportButton] import failed", err);
      eventBus.emit?.("toast.show", { level: "error", title: "Import failed", message: String(err?.message || err), ts: Date.now() });
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={cls(buttonBase, buttonStyle, "px-3 py-2")}
        onClick={openModal}
        title="Import favorites and plans from a Suka export"
      >
        <IconUpload className="h-4 w-4" />
        Import
      </button>

      {!open ? null : (
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={closeModal} />

          {/* Modal */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Import favorites and plans"
            className="relative w-[min(720px,92vw)] max-h-[90vh] overflow-auto rounded-2xl bg-white shadow-xl border"
          >
            {/* Header */}
            <div className="sticky top-0 z-10 bg-white/80 backdrop-blur border-b px-5 py-3 flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-500">Favorites & Plans</div>
                <h3 className="text-lg font-semibold">Import from file</h3>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="inline-flex items-center justify-center h-10 w-10 rounded-full hover:bg-gray-100"
              >
                <IconX className="h-5 w-5 fill-gray-600" />
              </button>
            </div>

            {/* Body */}
            <div className="p-5 space-y-4">
              {/* Drop zone */}
              <div
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                className={cls(
                  "rounded-xl border-2 border-dashed p-6 text-center",
                  dragOver ? "border-blue-500 bg-blue-50" : "border-gray-300"
                )}
              >
                <p className="text-sm text-gray-700">
                  Drag & drop a <code className="px-1 py-0.5 rounded bg-gray-100">.json</code> export here,
                  or choose a file.
                </p>
                <div className="mt-3">
                  <label className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm cursor-pointer hover:bg-gray-50">
                    <input type="file" accept="application/json,.json" className="hidden" onChange={onPickFile} />
                    <IconUpload className="h-4 w-4" />
                    Choose file
                  </label>
                </div>
                {fileName && <div className="mt-2 text-xs text-gray-500">Selected: {fileName}</div>}
              </div>

              {/* Options */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Import mode</span>
                  <select
                    className="mt-1 w-full rounded-xl border px-3 py-2 text-sm bg-white"
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                  >
                    <option value="merge">Merge (recommended)</option>
                    <option value="replace">Replace (advanced)</option>
                  </select>
                  <p className="mt-1 text-xs text-gray-500">
                    Merge keeps your current items and adds/updates from the file.
                    Replace overwrites with the file (a backup will be created first).
                  </p>
                </label>

                <label className="block">
                  <span className="text-sm font-medium text-gray-700">Scope</span>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      id="favoritesOnly"
                      type="checkbox"
                      className="h-4 w-4 accent-blue-600"
                      checked={favoritesOnly}
                      onChange={(e) => setFavoritesOnly(e.target.checked)}
                    />
                    <label htmlFor="favoritesOnly" className="text-sm text-gray-700">
                      Import favorites only (skip plans)
                    </label>
                  </div>
                </label>
              </div>

              {/* Preview */}
              {payload?.data && (
                <div className="rounded-xl border p-4 bg-gray-50">
                  <div className="text-sm font-medium text-gray-700">Preview</div>
                  <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    {"plans" in summary && (
                      <div>
                        <div className="text-xs text-gray-500">Plans (flat)</div>
                        <div className="font-semibold">{prettyNum(summary.plans)}</div>
                      </div>
                    )}
                    {"userPlans" in summary && (
                      <div>
                        <div className="text-xs text-gray-500">User plans</div>
                        <div className="font-semibold">{prettyNum(summary.userPlans)}</div>
                      </div>
                    )}
                    {"featured" in summary && (
                      <div>
                        <div className="text-xs text-gray-500">Featured plans</div>
                        <div className="font-semibold">{prettyNum(summary.featured)}</div>
                      </div>
                    )}
                    <div>
                      <div className="text-xs text-gray-500">Favorites</div>
                      <div className="font-semibold">{prettyNum(summary.favorites)}</div>
                    </div>
                    <div className="md:col-span-4">
                      <div className="text-xs text-gray-500">Domains</div>
                      <div className="mt-1 flex flex-wrap gap-1">
                        {[...summary.domains].map((d) => (
                          <span key={d} className="inline-flex items-center rounded-full bg-white border px-2 py-0.5 text-xs">
                            {d}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Error */}
              {!!error && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
                  {error}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="sticky bottom-0 bg-white/80 backdrop-blur border-t px-5 py-3 flex flex-wrap items-center justify-between gap-2">
              <button
                type="button"
                className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                onClick={backupExport}
                disabled={busy}
                title="Download a backup of your current items"
              >
                Backup current
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-xl border px-3 py-2 text-sm hover:bg-gray-50"
                  onClick={closeModal}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className={cls(
                    "rounded-xl px-3 py-2 text-sm",
                    "bg-blue-600 text-white hover:bg-blue-700 border border-blue-600"
                  )}
                  onClick={performImport}
                  disabled={busy || !payload?.data}
                >
                  {busy ? "Importing…" : "Import"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

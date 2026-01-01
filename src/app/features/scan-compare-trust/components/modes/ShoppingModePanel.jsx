// src/app/features/scan-compare-trust/components/modes/ShoppingModePanel.jsx
// -----------------------------------------------------------------------------
// ShoppingModePanel
// -----------------------------------------------------------------------------
// Purpose:
// - Store selector (selected store set)
// - Candidate list (provisional scans)
// - Live enrichment updates via eventBus:
//     "shopping:candidate.enriched"  { candidateId, resolved: {...} }
// - Results modal per scan with "Return to shelf" / "In cart"
// -----------------------------------------------------------------------------
//
// DI-safe:
// - eventBus can be passed or pulled from window.__SUKA_EVENT_BUS__
// - db is optional; safe-checks exist for missing tables
//
// Expected enrichment payload:
//  shopping:candidate.enriched -> { candidateId, resolved: { item, observations, coupons, recalls, ingredientsCheck } }
//
// Optional recommended events (for best UX):
//  shopping:candidate.created -> { candidate: {...} }  OR { candidateId, candidate: {...} }
//
// NOTE:
// - This file does not assume any specific "locals" provider.
// - Store list is stubbed but supports injection + normalization.
//
// -----------------------------------------------------------------------------

/* eslint-disable no-console */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  CheckCircle2,
  X,
  Store,
  ShoppingCart,
  Undo2,
  Sparkles,
} from "lucide-react";

import ShoppingCandidateCard from "@/app/features/scan-compare-trust/components/shopping/ShoppingCandidateCard";
import ShoppingResultsModal from "@/app/features/scan-compare-trust/components/shopping/ShoppingResultsModal";

import { db as dbImport } from "@/services/db";

/**
 * @param {{
 *  eventBus?: any,
 *  automation?: any,
 *  householdId?: string,
 *  userId?: string,
 *  // optional store list injection if you already have locals results
 *  availableStores?: Array<{ id?: string, name: string, brand?: string, address?: string }>,
 *  // optional: current shoppingSessionId (if managed by parent)
 *  shoppingSessionId?: string,
 *  // optional: callback when store selection changes
 *  onStoreSetChange?: (storeSet: any) => void,
 * }} props
 */
export default function ShoppingModePanel({
  eventBus: eventBusProp,
  automation: automationProp,
  householdId,
  userId,
  availableStores,
  shoppingSessionId: shoppingSessionIdProp,
  onStoreSetChange,
}) {
  const isBrowser = typeof window !== "undefined";
  const g = /** @type {any} */ (isBrowser ? window : {});
  const noopBus = useMemo(
    () => ({ emit: () => {}, on: () => {}, off: () => {} }),
    []
  );
  const eventBus = eventBusProp || g.__SUKA_EVENT_BUS__ || noopBus;
  const automation = automationProp || g.__SUKA_AUTOMATION__ || null;

  // Use imported db if present; tolerate if user has different export shape
  const db = dbImport || g.__SUKA_DB__ || null;

  // ------------------------------ Stores -----------------------------------
  const stores = useMemo(() => {
    // If you already provide a store list from Google Locals, inject it via props.
    if (Array.isArray(availableStores) && availableStores.length) {
      return availableStores.map(normalizeStore);
    }

    // Safe fallback list for dev/demo; replace with your Locals service results.
    return [
      { id: "walmart", name: "Walmart", brand: "Walmart" },
      { id: "target", name: "Target", brand: "Target" },
      { id: "kroger", name: "Kroger", brand: "Kroger" },
      { id: "aldi", name: "ALDI", brand: "ALDI" },
    ].map(normalizeStore);
  }, [availableStores]);

  const [selectedStoreIds, setSelectedStoreIds] = useState(() => []);
  const storeSet = useMemo(
    () => makeStoreSet(selectedStoreIds, stores),
    [selectedStoreIds, stores]
  );

  // ------------------------------ Session ----------------------------------
  const [shoppingSessionId, setShoppingSessionId] = useState(
    shoppingSessionIdProp || null
  );

  // Autostart session when store set becomes valid
  useEffect(() => {
    if (shoppingSessionIdProp) {
      setShoppingSessionId(shoppingSessionIdProp);
      return;
    }
    if (!storeSet?.storeIds?.length) return;

    // If we already have one, keep it
    setShoppingSessionId((prev) => prev || uid("shop_sess"));
  }, [shoppingSessionIdProp, storeSet?.storeIds?.length]);

  // Notify parent about store set
  useEffect(() => {
    try {
      onStoreSetChange?.(storeSet);
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSet?.id]);

  // ------------------------------ Candidates state -------------------------
  // Candidate records keyed by candidateId:
  // { id, upc, name, status, createdAt, storeSetId, resolved? }
  const [candidateById, setCandidateById] = useState(() => new Map());
  const [order, setOrder] = useState(() => []);

  // Modal state: show results for the most recent scan/candidate
  const [activeCandidateId, setActiveCandidateId] = useState(null);
  const [resultsOpen, setResultsOpen] = useState(false);

  // Keep latest storeSet in ref (for event callbacks)
  const storeSetRef = useRef(storeSet);
  useEffect(() => {
    storeSetRef.current = storeSet;
  }, [storeSet]);

  // ------------------------------ Event wiring -----------------------------
  useEffect(() => {
    if (!eventBus?.on) return;

    // Candidate created event (recommended)
    function onCandidateCreated(payload) {
      const candidate =
        payload?.candidate || payload?.data?.candidate || payload;
      const candidateId =
        payload?.candidateId || candidate?.id || candidate?.candidateId;
      if (!candidateId) return;

      const normalized = normalizeCandidate({
        ...candidate,
        id: candidateId,
        storeSetId: candidate?.storeSetId || storeSetRef.current?.id || null,
        shoppingSessionId:
          candidate?.shoppingSessionId || shoppingSessionId || null,
      });

      upsertCandidate(normalized, { openModal: true, reason: "created" });
    }

    // Candidate enriched event (required)
    function onCandidateEnriched(payload) {
      const candidateId = payload?.candidateId || payload?.id;
      const resolved = payload?.resolved || payload?.data?.resolved;

      if (!candidateId || !resolved) return;

      // merge into candidate
      upsertCandidate(
        { id: String(candidateId), resolved },
        { openModal: false, reason: "enriched" }
      );
    }

    eventBus.on("shopping:candidate.created", onCandidateCreated);
    eventBus.on("shopping:candidate.enriched", onCandidateEnriched);

    return () => {
      eventBus.off?.("shopping:candidate.created", onCandidateCreated);
      eventBus.off?.("shopping:candidate.enriched", onCandidateEnriched);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventBus, shoppingSessionId]);

  // ------------------------------ Helpers ----------------------------------

  function upsertCandidate(partial, { openModal, reason } = {}) {
    const id = String(partial?.id || "");
    if (!id) return;

    setCandidateById((prev) => {
      const next = new Map(prev);
      const existing = next.get(id) || {};

      const merged = {
        ...existing,
        ...partial,
        id,
        // deep-merge resolved subtree if both exist
        resolved: deepMerge(
          existing?.resolved || null,
          partial?.resolved || null
        ),
        updatedAt: Date.now(),
      };

      next.set(id, merged);
      return next;
    });

    setOrder((prev) => {
      if (prev.includes(id)) return prev;
      return [id, ...prev].slice(0, 300);
    });

    if (openModal) {
      setActiveCandidateId(id);
      setResultsOpen(true);

      // Optional: lightweight toast/notify
      automation?.notify?.({
        title: "Scan captured",
        message: "Showing results…",
        ts: Date.now(),
        scope: "local",
        severity: "info",
        tags: ["shopping", "scan", reason || "created"],
      });
    }
  }

  async function setCandidateStatus(candidateId, status) {
    const id = String(candidateId);
    if (!id) return;

    // update local state immediately (instant UX)
    upsertCandidate({ id, status }, { openModal: false, reason: "status" });

    // best-effort persist if you have a shopping candidates table
    // (You told me you'll add staging tables; this is safe-checked)
    try {
      const table =
        db?.shopping_candidates ||
        db?.shoppingCandidates ||
        db?.candidates ||
        null;

      if (table?.update) {
        // If numeric PK exists elsewhere, your table may store candidateId as indexed field.
        // We'll try update by id first; if it fails silently, no crash.
        await table.update(id, { status, updatedAt: new Date().toISOString() });
      } else if (table?.where) {
        // fallback: update by candidateId index if present
        const row = await table.where("candidateId").equals(id).first();
        if (row && row.id != null) {
          await table.update(row.id, {
            status,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    } catch (e) {
      // local-first UI must never crash; persistence is best-effort
      if (import.meta?.env?.DEV)
        console.warn("[ShoppingModePanel] persist status failed", e);
    }

    // emit an event (lets other panes update)
    try {
      eventBus.emit?.("shopping:candidate.status.changed", {
        candidateId: id,
        status,
        ts: Date.now(),
      });
    } catch {}
  }

  const candidates = useMemo(() => {
    return order
      .map((id) => candidateById.get(id))
      .filter(Boolean)
      .filter((c) => c.status !== "removed"); // hide removed by default
  }, [order, candidateById]);

  const activeCandidate = useMemo(() => {
    if (!activeCandidateId) return null;
    return candidateById.get(activeCandidateId) || null;
  }, [activeCandidateId, candidateById]);

  const canScan = Boolean(storeSet?.storeIds?.length);

  return (
    <div className="w-full">
      {/* Store selector */}
      <div className="rounded-xl border p-3 bg-background">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Store className="h-4 w-4" />
            Shopping Stores
          </div>
          <div className="text-xs text-muted-foreground">
            {storeSet?.storeIds?.length
              ? `Session: ${shoppingSessionId || "ready"}`
              : "Select stores to begin"}
          </div>
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          {stores.map((s) => {
            const on = selectedStoreIds.includes(s.id);
            return (
              <button
                key={s.id}
                className={
                  "px-2 py-1 text-xs rounded-full border transition " +
                  (on ? "bg-black text-white" : "hover:bg-muted")
                }
                onClick={() => {
                  setSelectedStoreIds((prev) => toggle(prev, s.id));
                }}
                title={s.address || s.name}
              >
                {s.name}
              </button>
            );
          })}
        </div>

        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="text-xs text-muted-foreground">
            {canScan
              ? "Scan items now — results will pop up instantly."
              : "Pick at least 1 store to enable Shopping scan results."}
          </div>
          <div className="inline-flex items-center gap-1 text-xs">
            <span
              className={
                "inline-flex items-center gap-1 px-2 py-0.5 rounded-full border " +
                (canScan
                  ? "bg-green-50 text-green-700"
                  : "bg-amber-50 text-amber-800")
              }
            >
              <Sparkles className="h-3.5 w-3.5" />
              {canScan ? "Ready" : "Needs stores"}
            </span>
          </div>
        </div>
      </div>

      {/* Candidate list */}
      <div className="mt-3 rounded-xl border bg-background">
        <div className="px-3 py-2 border-b flex items-center justify-between">
          <div className="text-sm font-medium inline-flex items-center gap-2">
            <ShoppingCart className="h-4 w-4" />
            Candidates
            <span className="text-xs text-muted-foreground">
              ({candidates.length})
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            Live updates via{" "}
            <span className="font-mono">shopping:candidate.enriched</span>
          </div>
        </div>

        <div className="p-3 flex flex-col gap-2">
          {candidates.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              Scan an item to add a candidate. Results will appear as a modal.
            </div>
          ) : null}

          {candidates.map((c) => (
            <div key={c.id} className="relative">
              <button
                className="absolute inset-0 rounded-xl"
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setActiveCandidateId(c.id);
                  setResultsOpen(true);
                }}
                aria-label="Open results"
              />
              <div className="pointer-events-none">
                <ShoppingCandidateCard candidate={c} compact />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Results modal (auto-opens on created) */}
      <ShoppingResultsModal
        open={resultsOpen}
        onOpenChange={setResultsOpen}
        candidate={activeCandidate}
        onReturnToShelf={(id) => setCandidateStatus(id, "removed")}
        onInCart={(id) => setCandidateStatus(id, "in_cart")}
        onKeepBrowsing={() => setResultsOpen(false)}
      />

      {/* Small footer hint */}
      <AnimatePresence>
        {resultsOpen && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            className="mt-2 text-xs text-muted-foreground"
          >
            Tip: close results and keep scanning — enrichment will keep updating
            in the background.
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* --------------------------------- Utils --------------------------------- */

function uid(p = "id") {
  return `${p}:${Math.random().toString(36).slice(2)}:${Date.now().toString(
    36
  )}`;
}

function toggle(list, id) {
  const s = new Set(list);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  return Array.from(s);
}

function normalizeStore(s) {
  const id = String(s?.id || s?.brand || s?.name || "")
    .toLowerCase()
    .replace(/\s+/g, "-");
  return {
    id: id || uid("store"),
    name: String(s?.name || s?.brand || "Store"),
    brand: String(s?.brand || s?.name || "Store"),
    address: s?.address ? String(s.address) : "",
  };
}

function makeStoreSet(selectedIds, allStores) {
  const ids = Array.isArray(selectedIds) ? selectedIds : [];
  const setStores = allStores.filter((s) => ids.includes(s.id));
  const name = setStores.map((s) => s.name).join(" + ");
  return {
    id: ids.length ? `storeSet:${ids.sort().join("|")}` : null,
    storeIds: ids,
    stores: setStores,
    name: name || "",
  };
}

function normalizeCandidate(c) {
  if (!c || typeof c !== "object") return null;
  const id = String(c.id || c.candidateId || "");
  if (!id) return null;

  // upc can be in several places depending on your pipeline
  const upc =
    c.upc || c.barcode || c.code || c.item?.upc || c.resolved?.item?.upc || "";

  return {
    id,
    upc: upc ? String(upc) : "",
    name: String(c.name || c.itemName || c.resolved?.item?.name || ""),
    status: String(c.status || "scanned"),
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now(),
    storeSetId: c.storeSetId || null,
    shoppingSessionId: c.shoppingSessionId || null,
    resolved: c.resolved || null,
  };
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== "object") return base;
  if (!base || typeof base !== "object") return patch;

  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

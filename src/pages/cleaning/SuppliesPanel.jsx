/* eslint-disable no-console */
// src/components/supplies/SuppliesPanel.jsx
//
// SuppliesPanel — cross-domain shortages dashboard with “Jump to Grocery”
// - Unifies shortages from pantry, cleaning, hygiene, animal feed, garden inputs
// - Aisle grouping • store selector • substitutions • qty steppers
// - “Add to Grocery” (bulk or per-item) + “Jump to Grocery” deep-link
// - Collapse duplicates (by sku/name/unit) with safe merging
// - “Include what we have” toggle, Sabbath guard (optional), defensive fallbacks
// - Inspired by Amazon/Instacart list UIs, Linear’s clean grouping, and Notion’s simple filters

import React, { useEffect, useMemo, useRef, useState } from "react";
import { format } from "date-fns";

// -------------------- Defensive service/context imports --------------------
let eventBus;
try {
  eventBus = require("../../services/eventBus").default;
} catch {
  eventBus = {
    emit: (...args) => console.debug("[SuppliesPanel:eventBus.emit]", ...args),
    on: () => () => {},
  };
}

let SettingsContext;
try {
  SettingsContext = require("../context/SettingsContext").SettingsContext;
} catch {
  SettingsContext = React.createContext({
    sabbathGuard: false,
    sabbathWindow: { startDow: 5, startHour: 18, endDow: 6, endHour: 19 },
    blockCommerceDuringSabbath: true,
    defaultStore: "Sams Club",
  });
}

let useMilestoneState;
try {
  useMilestoneState = require("../../app/hooks/useMilestoneState").default;
} catch {
  useMilestoneState = () => ({ recordMilestone: () => {} });
}

let IngredientSourceMap; // garden/animal/bulk linkage (optional)
try {
  IngredientSourceMap = require("../../app/utils/ingredientSourceMap").INGREDIENT_SOURCES;
} catch {
  IngredientSourceMap = {};
}

// Optional aisle metadata service
let AisleService = {
  // getAisle(name, store) -> {id, label}
  getAisle: (name, store) => {
    const n = String(name || "").toLowerCase();
    if (/detergent|bleach|clean/i.test(n)) return { id: "cleaning", label: "Cleaning" };
    if (/soap|shampoo|tooth/i.test(n)) return { id: "hygiene", label: "Personal Care" };
    if (/feed|grain|hay|pellet/i.test(n)) return { id: "animal", label: "Animal Feed" };
    if (/seed|soil|mulch|fertil/i.test(n)) return { id: "garden", label: "Garden" };
    if (/meat|lamb|beef|chicken/i.test(n)) return { id: "meat", label: "Meat" };
    if (/flour|grain|rice|wheat/i.test(n)) return { id: "grains", label: "Grains" };
    if (/milk|cheese|egg|butter/i.test(n)) return { id: "dairy", label: "Dairy" };
    return { id: "general", label: "General" };
  },
};

// -------------------- Helpers --------------------
const withinSabbath = (now = new Date(), window = { startDow: 5, startHour: 18, endDow: 6, endHour: 19 }) => {
  const dow = now.getDay(); // 0 Sun..6 Sat
  const hr = now.getHours();
  if (dow === window.startDow && hr >= window.startHour) return true;
  if (dow === window.endDow && hr < window.endHour) return true;
  return false;
};

const domains = ["pantry", "cleaning", "hygiene", "animal", "garden", "other"];

function asKey(i) {
  // dedupe key: prefer sku; else normalized name+unit
  if (i.sku) return `sku:${i.sku}`;
  return `nu:${String(i.name || "").trim().toLowerCase()}|${i.unit || ""}`;
}

function collapseDuplicates(items) {
  const map = new Map();
  for (const it of items || []) {
    const k = asKey(it);
    if (!map.has(k)) {
      map.set(k, { ...it, qty: Number(it.qty || 0) });
      continue;
    }
    const prev = map.get(k);
    map.set(k, {
      ...prev,
      qty: Number(prev.qty || 0) + Number(it.qty || 0),
      // Prefer most specific store; merge tags/substitutions
      store: it.store || prev.store,
      tags: Array.from(new Set([...(prev.tags || []), ...(it.tags || [])])),
      substitutions: Array.from(new Set([...(prev.substitutions || []), ...(it.substitutions || [])])),
    });
  }
  return Array.from(map.values());
}

function computeShortages(source = []) {
  // Each item shape:
  // { id, name, unit, haveQty, needQty, minQty, domain, store, sku, tags[], substitutions[], aisle, notes }
  const out = [];
  for (const row of source) {
    const have = Number(row.haveQty || 0);
    const min = Number(row.minQty || 0);
    const need = Number(row.needQty || 0);

    // shortage logic: if need is given, use need - have; else fall back to min - have
    let shortage = 0;
    if (need > 0) shortage = Math.max(0, need - have);
    else if (min > 0) shortage = Math.max(0, min - have);

    // skip fully covered
    if (shortage <= 0) continue;

    // attach aisle if missing
    const aisle = row.aisle || AisleService.getAisle(row.name, row.store).label;

    out.push({
      ...row,
      qty: shortage,
      aisle,
    });
  }
  return out;
}

function groupByAisle(items) {
  const m = new Map();
  for (const it of items) {
    const a = it.aisle || "General";
    if (!m.has(a)) m.set(a, []);
    m.get(a).push(it);
  }
  // Sort aisles alphabetically, with Cleaning/Personal Care/Garden/Animal first
  const priority = ["Cleaning", "Personal Care", "Garden", "Animal Feed"];
  const entries = Array.from(m.entries()).sort((a, b) => {
    const ai = priority.indexOf(a[0]);
    const bi = priority.indexOf(b[0]);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a[0].localeCompare(b[0]);
  });
  return entries;
}

// -------------------- Component --------------------
export default function SuppliesPanel({
  shortagesSource = [], // optional upstream source; if absent, listens for eventBus updates
  defaultStore,
  onAddToGrocery, // optional override(items, options)
  onJumpToGrocery, // optional override()
}) {
  const {
    sabbathGuard,
    sabbathWindow,
    blockCommerceDuringSabbath = true,
    defaultStore: ctxDefaultStore,
  } = React.useContext(SettingsContext);
  const { recordMilestone } = useMilestoneState();

  const [store, setStore] = useState(defaultStore || ctxDefaultStore || "Sam's Club");
  const [includeHave, setIncludeHave] = useState(false);
  const [collapse, setCollapse] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [domainFilter, setDomainFilter] = useState(() => new Set(domains));
  const [source, setSource] = useState(shortagesSource);

  // Subscribe to external updates (e.g., inventory sync recomputed)
  useEffect(() => {
    const off = eventBus.on?.("supplies.shortages.update", (payload) => {
      if (Array.isArray(payload?.items)) {
        setSource(payload.items);
      }
    });
    return () => off?.();
  }, []);

  useEffect(() => {
    if (Array.isArray(shortagesSource) && shortagesSource.length) {
      setSource(shortagesSource);
    }
  }, [shortagesSource]);

  // Derived shortages
  const computed = useMemo(() => computeShortages(source), [source]);

  // Optional include “have” view (for context or counting)
  const listWithHave = useMemo(() => {
    if (!includeHave) return computed;
    const withHave = [...computed];
    for (const row of source) {
      const a = AisleService.getAisle(row.name, row.store).label;
      withHave.push({
        id: `have:${row.id || row.name}`,
        name: row.name,
        unit: row.unit,
        qty: Number(row.haveQty || 0),
        domain: row.domain || "other",
        store: row.store || store,
        sku: row.sku,
        notes: "Already in inventory",
        aisle: a,
        isHave: true,
        substitutions: row.substitutions || [],
        tags: row.tags || [],
      });
    }
    return withHave;
  }, [computed, includeHave, source, store]);

  // Filter by domain
  const domainFiltered = useMemo(() => {
    return (listWithHave || []).filter((i) => domainFilter.has(i.domain || "other"));
  }, [listWithHave, domainFilter]);

  // Store filter (show all, but highlight preferred store)
  const storeAdjusted = useMemo(() => {
    // We keep items even if their preferredStore != current store; UI shows a “swap store” chip.
    return domainFiltered.map((i) => ({ ...i, preferredStore: i.store || store }));
  }, [domainFiltered, store]);

  // Search
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return storeAdjusted;
    return storeAdjusted.filter((i) => {
      const hay = [
        i.name,
        i.domain,
        i.unit,
        i.aisle,
        i.sku,
        ...(i.tags || []),
        ...(i.substitutions || []),
        i.notes,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [storeAdjusted, query]);

  // Collapse duplicates (for shortages, not “have” rows)
  const collapsed = useMemo(() => {
    if (!collapse) return searched;
    const needs = searched.filter((i) => !i.isHave);
    const haves = searched.filter((i) => i.isHave);
    return [...collapseDuplicates(needs), ...haves];
  }, [searched, collapse]);

  // Aisle grouping
  const aisles = useMemo(() => groupByAisle(collapsed), [collapsed]);

  // Selection helpers
  const toggleSelect = (id) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const selectAll = () => {
    const all = new Set();
    for (const [, items] of aisles) {
      for (const it of items) {
        if (!it.isHave) all.add(it.id || asKey(it));
      }
    }
    setSelected(all);
  };

  const clearSelection = () => setSelected(new Set());

  const disabledBySabbath = sabbathGuard && blockCommerceDuringSabbath && withinSabbath(new Date(), sabbathWindow);

  const addSelectedToGrocery = () => {
    const items = [];
    for (const [, rows] of aisles) {
      for (const it of rows) {
        const id = it.id || asKey(it);
        if (!selected.has(id)) continue;
        if (it.isHave) continue; // don't add "have" rows
        items.push({
          id,
          name: it.name,
          qty: it.qty,
          unit: it.unit,
          domain: it.domain,
          sku: it.sku,
          tags: it.tags,
          substitutions: it.substitutions,
          aisle: it.aisle,
          store: store,
          preferredStore: it.preferredStore,
          notes: it.notes,
        });
      }
    }
    if (!items.length) return;

    if (onAddToGrocery) {
      onAddToGrocery(items, { store });
    } else {
      eventBus.emit("grocery.addItems", { items, store, at: new Date().toISOString() });
    }
    recordMilestone?.({ key: "supplies_added_to_grocery", meta: { count: items.length, store } });
    clearSelection();
  };

  const jumpToGrocery = () => {
    if (onJumpToGrocery) onJumpToGrocery();
    else {
      eventBus.emit("ui.navigate", { panel: "GroceryListPanel", store });
      eventBus.emit("ui.panel.open", { id: "GROCERY_LIST" });
    }
    recordMilestone?.({ key: "jump_to_grocery", meta: { store } });
  };

  // -------------------- Render --------------------
  return (
    <div className="w-full max-w-7xl mx-auto p-4 sm:p-6">
      <header className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Supplies & Shortages</h1>
          <p className="text-gray-600">
            Review shortages across pantry, cleaning, hygiene, animal, and garden. Add to Grocery or jump there.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search items, tags, SKU…"
              className="w-64 rounded-xl border px-3 py-2 text-sm"
            />
            <span className="absolute right-2 top-2 text-xs text-gray-400">/</span>
          </div>

          <select
            value={store}
            onChange={(e) => setStore(e.target.value)}
            className="rounded-xl border px-3 py-2 text-sm bg-white"
            title="Preferred store"
          >
            <option>Sam's Club</option>
            <option>Costco</option>
            <option>Publix</option>
            <option>Walmart</option>
            <option>Local Co-op</option>
          </select>

          <button
            type="button"
            onClick={jumpToGrocery}
            className="rounded-xl border border-black bg-gray-900 text-white px-3 py-2 text-sm hover:opacity-90 disabled:opacity-50"
            disabled={false}
            title="Open Grocery List"
          >
            Jump to Grocery
          </button>
        </div>
      </header>

      {/* Filters */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {domains.map((d) => {
          const on = domainFilter.has(d);
          return (
            <button
              key={d}
              type="button"
              onClick={() =>
                setDomainFilter((f) => {
                  const n = new Set(f);
                  if (n.has(d)) n.delete(d);
                  else n.add(d);
                  return n;
                })
              }
              className={[
                "rounded-full border px-3 py-1.5 text-sm",
                on ? "bg-gray-900 text-white border-black" : "bg-white hover:bg-gray-50",
              ].join(" ")}
            >
              {d}
            </button>
          );
        })}

        <label className="ml-auto flex items-center gap-2 text-sm">
          <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} />
          Collapse duplicates
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeHave} onChange={(e) => setIncludeHave(e.target.checked)} />
          Include “have”
        </label>
      </div>

      {/* Bulk actions */}
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={selectAll}
          className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
        >
          Select all
        </button>
        <button
          type="button"
          onClick={clearSelection}
          className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={addSelectedToGrocery}
          className={[
            "rounded-xl px-3 py-2 text-sm border",
            disabledBySabbath
              ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
              : "bg-gray-900 text-white border-black hover:opacity-90",
          ].join(" ")}
          disabled={disabledBySabbath}
          title={
            disabledBySabbath
              ? "Sabbath guard: adding to Grocery is paused"
              : "Add selected to Grocery"
          }
        >
          Add selected to Grocery
        </button>
      </div>

      {/* Aisle groups */}
      <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-6">
        {aisles.length === 0 ? (
          <div className="lg:col-span-2">
            <div className="rounded-2xl border border-dashed p-10 text-center text-gray-600">
              <div className="text-lg font-semibold">No shortages found.</div>
              <div className="mt-1">Everything looks stocked based on your thresholds.</div>
            </div>
          </div>
        ) : (
          aisles.map(([aisleName, items]) => (
            <section key={aisleName} className="rounded-2xl border p-4">
              <div className="mb-2 flex items-baseline justify-between">
                <h2 className="text-sm font-medium text-gray-500 uppercase tracking-wider">{aisleName}</h2>
                <span className="text-xs text-gray-400">{items.length} item{items.length !== 1 ? "s" : ""}</span>
              </div>

              <ul className="grid gap-3">
                {items.map((i) => {
                  const id = i.id || asKey(i);
                  const isSelected = selected.has(id);
                  const [qty, setQty] = useQtyState(id, i.qty);

                  return (
                    <li key={id} className="rounded-xl border p-3 bg-white shadow-sm">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold text-gray-900 truncate">
                              {i.name} {i.isHave ? <span className="ml-2 text-xs text-gray-400">(have)</span> : null}
                            </h3>
                            {i.domain ? (
                              <span className="inline-flex items-center rounded-full bg-gray-100 text-gray-700 border border-gray-200 px-2 py-0.5 text-xs">
                                {i.domain}
                              </span>
                            ) : null}
                            {i.sku ? (
                              <span className="inline-flex items-center rounded-full bg-gray-50 text-gray-600 border px-2 py-0.5 text-xs">
                                SKU: {i.sku}
                              </span>
                            ) : null}
                            {i.preferredStore && i.preferredStore !== store ? (
                              <span className="inline-flex items-center rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5 text-xs">
                                Prefers {i.preferredStore}
                              </span>
                            ) : null}
                          </div>

                          <div className="mt-1 text-sm text-gray-600 flex flex-wrap gap-3">
                            <span>
                              Needed:{" "}
                              <strong>
                                {qty} {i.unit || ""}
                              </strong>
                            </span>
                            {i.notes ? <span>• {i.notes}</span> : null}
                            {Array.isArray(i.tags) && i.tags.length ? (
                              <span className="flex flex-wrap gap-1">
                                {i.tags.map((t) => (
                                  <span
                                    key={t}
                                    className="inline-flex items-center rounded-full bg-gray-50 text-gray-700 border px-2 py-0.5 text-xs"
                                  >
                                    #{t}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </div>
                        </div>

                        {/* Select + Qty + Actions */}
                        <div className="flex items-center gap-2">
                          {!i.isHave ? (
                            <label className="flex items-center gap-1 text-sm">
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleSelect(id)}
                              />
                              <span className="sr-only">Select</span>
                            </label>
                          ) : null}

                          {!i.isHave ? (
                            <div className="flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => setQty((v) => Math.max(0, Number(v) - stepForUnit(i.unit)))}
                                className="rounded-md border px-2 py-1 text-sm bg-white hover:bg-gray-50"
                                title="Decrease"
                              >
                                −
                              </button>
                              <input
                                type="number"
                                min={0}
                                step={stepForUnit(i.unit)}
                                value={qty}
                                onChange={(e) => setQty(sanitizeNum(e.target.value))}
                                className="w-16 rounded-md border px-2 py-1 text-sm text-right"
                                aria-label="Quantity"
                              />
                              <button
                                type="button"
                                onClick={() => setQty((v) => Number(v) + stepForUnit(i.unit))}
                                className="rounded-md border px-2 py-1 text-sm bg-white hover:bg-gray-50"
                                title="Increase"
                              >
                                +
                              </button>
                            </div>
                          ) : null}

                          {!i.isHave ? (
                            <button
                              type="button"
                              onClick={() => {
                                const item = { ...i, qty };
                                if (onAddToGrocery) onAddToGrocery([item], { store });
                                else eventBus.emit("grocery.addItems", { items: [item], store });
                                setSelected((prev) => {
                                  const n = new Set(prev);
                                  n.delete(id);
                                  return n;
                                });
                                recordMilestone?.({ key: "supply_added_single", meta: { name: i.name, qty, store } });
                              }}
                              className={[
                                "rounded-xl px-3 py-1.5 text-sm border",
                                disabledBySabbath
                                  ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                                  : "bg-gray-900 text-white border-black hover:opacity-90",
                              ].join(" ")}
                              disabled={disabledBySabbath}
                              title={
                                disabledBySabbath
                                  ? "Sabbath guard: adding to Grocery is paused"
                                  : "Add to Grocery"
                              }
                            >
                              Add
                            </button>
                          ) : null}
                        </div>
                      </div>

                      {/* Substitutions */}
                      {!i.isHave && Array.isArray(i.substitutions) && i.substitutions.length ? (
                        <div className="mt-2 text-xs text-gray-600">
                          <span className="font-medium">Subs:</span>{" "}
                          {i.substitutions.map((s, idx) => (
                            <button
                              key={`${id}-sub-${s}`}
                              type="button"
                              onClick={() => {
                                setQuery(s);
                                // small UX delight: auto-open store dropdown if sub implies diff store
                              }}
                              className="underline decoration-dotted hover:decoration-solid mr-2"
                            >
                              {s}
                              {idx < i.substitutions.length - 1 ? "," : ""}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>

      {/* Footer actions */}
      <footer className="mt-6 flex items-center justify-between flex-wrap gap-2">
        <div className="text-xs text-gray-500">
          Updated {format(new Date(), "PPpp")}
          {disabledBySabbath ? (
            <span className="ml-2 inline-flex items-center rounded-full bg-amber-50 text-amber-800 border border-amber-200 px-2 py-0.5">
              Sabbath Guard Active
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={addSelectedToGrocery}
            className={[
              "rounded-xl px-3 py-2 text-sm border",
              disabledBySabbath
                ? "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                : "bg-gray-900 text-white border-black hover:opacity-90",
            ].join(" ")}
            disabled={disabledBySabbath}
          >
            Add selected to Grocery
          </button>
          <button
            type="button"
            onClick={jumpToGrocery}
            className="rounded-xl border bg-white hover:bg-gray-50 px-3 py-2 text-sm"
          >
            Jump to Grocery
          </button>
        </div>
      </footer>
    </div>
  );
}

// -------------------- Local state for qty per-line --------------------
function useQtyState(lineId, initial) {
  const ref = useRef(typeof initial === "number" ? initial : Number(initial || 0));
  const [, force] = useState(0);
  const set = (updater) => {
    const next = typeof updater === "function" ? updater(ref.current) : updater;
    ref.current = sanitizeNum(next);
    force((v) => v + 1);
  };
  return [ref.current, set];
}
function sanitizeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}
function stepForUnit(unit) {
  if (!unit) return 1;
  const u = String(unit).toLowerCase();
  if (/(ml|g|gram|ounce|oz)/.test(u)) return 50;
  if (/(kg|lb|pound)/.test(u)) return 0.25;
  if (/(l|liter|quart|gallon)/.test(u)) return 0.25;
  return 1;
}

/**
 * Expected shortage row shape (upstream; flexible):
 * {
 *   id?: string,
 *   name: string,
 *   domain: "pantry"|"cleaning"|"hygiene"|"animal"|"garden"|"other",
 *   unit?: "ea"|"g"|"kg"|"ml"|"l"|"lb"|"oz"|...,
 *   haveQty?: number,         // current stock
 *   needQty?: number,         // target for upcoming plan/period
 *   minQty?: number,          // minimum threshold we like to keep
 *   sku?: string,
 *   store?: string,           // preferred store
 *   aisle?: string,           // optional (we can infer)
 *   tags?: string[],
 *   substitutions?: string[], // alternative items
 *   notes?: string,
 * }
 *
 * Integrations:
 * - Emit “supplies.shortages.update” with {items:[...]} to refresh the panel from inventory/meal/garden/cleaning engines
 * - Add to Grocery:
 *     eventBus.emit("grocery.addItems", { items, store, at: new Date().toISOString() })
 * - Navigate:
 *     eventBus.emit("ui.navigate", { panel: "GroceryListPanel", store })
 *     eventBus.emit("ui.panel.open", { id: "GROCERY_LIST" })
 *
 * Design notes:
 * - Clean, compact cards; aisle grouping reduces scan time
 * - Substitutions work like quick-filters (one-tap query)
 * - Qty steppers are unit-aware (bigger steps for bulk units)
 * - Sabbath guard blocks “add to grocery” if enabled (list remains viewable)
 */

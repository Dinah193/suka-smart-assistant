// src/components/meals/ShoppingListGenerator.jsx
/**
 * ShoppingListGenerator
 *
 * DOMAIN ROLE (WEB OF MEANING):
 * - Primary domains:
 *   - cooking/meals   → needed ingredients come from recipes / batch cycles
 *   - storehouse      → current inventory & provision gaps
 *   - grocery/provisioning → outbound shopping or ordering
 *
 * - Connected domains:
 *   - preservation (if user chooses to buy for canning/freezing “beyond today”)
 *   - feasts/events (seasonal/feast-driven lists)
 *
 * CONCEPT:
 * - Take one or more recipes (often from a batch session or feast plan)
 *   and turn them into a **provision list** that respects the storehouse:
 *   - aggregate ingredients across recipes,
 *   - compare to storehouse / inventory snapshot,
 *   - mark which items are fully covered, partially covered, or missing,
 *   - allow sending “missing / short” items into the grocery flow.
 *
 * TOOL MODE:
 * - Works with just the `recipes` prop. If there is no storehouse snapshot,
 *   it still returns an aggregated ingredient list (no coverage info).
 *
 * STEWARDSHIP MODE:
 * - When `stewardshipMode` is true, makes stronger assumptions:
 *   - Tries to fetch an inventory snapshot via `automation`.
 *   - Emits richer events on the eventBus so other domains
 *     (storehouse planners, price trackers, feast planners) can react.
 *
 * EVENTS:
 * - shoppingList.updated
 *   - Fired whenever the provision list is recomputed.
 * - shoppingList.sentToGrocery
 *   - Fired when the householder sends “missing/short” items into the
 *     grocery provisioning flow.
 * - storehouse.provision.planned
 *   - Fired when the app confirms a provision plan for a feast / cycle.
 *
 * TODO[seasons]:
 * - Use `seasonContext` to mark items as “feast prep”, “Sabbath prep”,
 *   or “general cycle” and let storehouse intelligence prioritize.
 *
 * TODO[insights]:
 * - Attach per-cycle “stretch” insights:
 *   - Which items are always low before feasts?
 *   - Which staples would stabilize the storehouse if bought in bulk?
 */

import React, { useEffect, useMemo, useState } from "react";
import { classNames as cx } from "@/utils/css";
import { eventBus } from "@/services/events/eventBus";
import { automation } from "@/services/automation/runtime";
import { useStorehousePlannerStore } from "@/store/StorehousePlannerStore";
import { forwardProvisionToStorehousePlanner } from "@/services/planners/mealPlannerBridge";

export default function ShoppingListGenerator({
  recipes = [],             // [{ id, title, ingredients:[{ name, qty, unit }], slot?, mode? }]
  seedProvisionItems = [],  // [{ name, neededQty|qty, unit, recipeTitle?, recipeId? }]
  stewardshipMode = false,  // false = TOOL MODE, true = STEWARDSHIP MODE
  seasonContext = null,     // optional { seasonKey, feastKey, dayLabel, ... }
  sessionId = null,         // optional batch/feast session id
  onListUpdated,            // (list) => void
  onSendToGrocery,          // (payload) => void
}) {
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [storehouseSnapshot, setStorehouseSnapshot] = useState(null);
  const [loadingStorehouse, setLoadingStorehouse] = useState(false);

  const modeContext = stewardshipMode ? "stewardship" : "tool";

  // ---------------- Storehouse snapshot (if available) ----------------

  useEffect(() => {
    let cancelled = false;

    async function fetchStorehouse() {
      if (!stewardshipMode || !automation) return;
      setLoadingStorehouse(true);
      try {
        // TODO: adjust to the actual automation route once defined.
        const res = await automation("inventory.snapshot", { scope: "kitchen" });
        if (!cancelled && res && Array.isArray(res.items)) {
          setStorehouseSnapshot(res.items);
        }
      } catch (err) {
        // fail silently – TOOL MODE still works without storehouse
        if (!cancelled) setStorehouseSnapshot(null);
      } finally {
        if (!cancelled) setLoadingStorehouse(false);
      }
    }

    fetchStorehouse();
    return () => { cancelled = true; };
  }, [stewardshipMode]);

  // -------------- Build provision list from recipes + storehouse ------

  const provisionList = useMemo(() => {
    const storehouseIndex = buildStorehouseIndex(storehouseSnapshot);
    return buildProvisionList(recipes, storehouseIndex, seedProvisionItems);
  }, [JSON.stringify(recipes), JSON.stringify(storehouseSnapshot), JSON.stringify(seedProvisionItems)]);

  const filteredList = useMemo(() => {
    if (!onlyMissing) return provisionList;
    return provisionList.filter(
      (row) => row.coverage.status === "missing" || row.coverage.status === "partial"
    );
  }, [provisionList, onlyMissing]);

  const summary = useMemo(
    () => summarizeProvisionList(provisionList),
    [provisionList]
  );

  // -------------- Emit updates to parent + eventBus -------------------

  useEffect(() => {
    if (onListUpdated) onListUpdated(provisionList);

    eventBus?.emit?.("shoppingList.updated", {
      context: modeContext,
      sessionId,
      seasonContext,
      summary,
      itemsCount: provisionList.length,
    });

    // TODO[insights]:
    // automation?.("intelligence.storehouse.provisionList.update", {
    //   context: modeContext,
    //   sessionId,
    //   seasonContext,
    //   summary,
    //   items: provisionList,
    // });

  }, [JSON.stringify(provisionList), modeContext, sessionId, JSON.stringify(seasonContext)]);

  // -------------- Actions ---------------------------------------------

  function handleExportCsv() {
    const header = [
      "name",
      "neededQty",
      "unit",
      "status",
      "onHandQty",
      "recipes",
    ];
    const rows = provisionList.map((row) => {
      const rTitles = Array.from(row.recipeTitles || []).join(" | ");
      return [
        safeCsv(row.name),
        row.neededQty,
        row.unit || "",
        row.coverage.status,
        row.coverage.onHandQty,
        safeCsv(rTitles),
      ].join(",");
    });

    const blob = new Blob(
      [[header.join(","), ...rows].join("\n")],
      { type: "text/csv;charset=utf-8" }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "provision-list.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleSendMissingToGrocery() {
    const missingOrShort = provisionList.filter(
      (row) => row.coverage.status === "missing" || row.coverage.status === "partial"
    );
    if (!missingOrShort.length) return;

    const payload = {
      sessionId,
      seasonContext,
      items: missingOrShort.map((row) => ({
        name: row.name,
        unit: row.unit,
        neededQty: row.neededQty,
        onHandQty: row.coverage.onHandQty || 0,
        shortfallQty: row.coverage.shortfallQty || row.neededQty,
        recipeIds: Array.from(row.recipeIds || []),
        recipeTitles: Array.from(row.recipeTitles || []),
      })),
    };

    const upsertNeeds = useStorehousePlannerStore?.getState?.()?.upsertNeeds;
    forwardProvisionToStorehousePlanner({
      payload,
      upsertNeeds,
      eventBusEmit: eventBus?.emit?.bind(eventBus),
    });

    // Optional callback for parent
    onSendToGrocery?.(payload);

    // Emit event for other domains
    eventBus?.emit?.("shoppingList.sentToGrocery", {
      context: modeContext,
      sessionId,
      seasonContext,
      count: missingOrShort.length,
    });

    // TODO: hook into grocery engine
    // await automation?.("grocery.addFromProvisionList", payload);

    // Also let storehouse intelligence know that a provision plan is forming
    eventBus?.emit?.("storehouse.provision.planned", {
      context: modeContext,
      sessionId,
      seasonContext,
      summary,
    });
  }

  // -------------- Render ----------------------------------------------

  const isEmpty = !provisionList.length;

  return (
    <div className="rounded-2xl border border-base-200 bg-base-100 shadow-md flex flex-col min-h-[260px]">
      {/* Header */}
      <div className="px-4 pt-4 pb-3 border-b border-base-200 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold uppercase tracking-wide text-base-content/70">
            Provision List (Shopping View)
          </div>
          <div className="text-xs text-base-content/70 truncate">
            Ingredients across chosen dishes, compared with your storehouse to show what needs to be brought in.
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 text-[11px] text-base-content/70">
          <div className="flex items-center gap-2">
            <span className="px-2 py-1 rounded-full bg-base-200">
              {summary.totalItems} items • {summary.missingOrShort} need provision
            </span>
          </div>
          {seasonContext && (
            <div className="flex items-center gap-1">
              <span className="px-2 py-1 rounded-full bg-base-200">
                {seasonContext.feastKey
                  ? `Feast cycle: ${seasonContext.feastKey}`
                  : seasonContext.dayLabel || "Current season"}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="px-4 py-2 border-b border-base-200 flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={onlyMissing}
            onChange={(e) => setOnlyMissing(e.target.checked)}
          />
          <span>Show only items that need provision</span>
        </label>
        <div className="ml-auto flex items-center gap-2">
          {loadingStorehouse && (
            <span className="text-[11px] text-base-content/60">
              Checking storehouse…
            </span>
          )}
          {!loadingStorehouse && storehouseSnapshot && (
            <span className="text-[11px] text-base-content/60">
              Storehouse snapshot loaded
            </span>
          )}
          {!storehouseSnapshot && !loadingStorehouse && stewardshipMode && (
            <span className="text-[11px] text-base-content/60">
              Storehouse snapshot unavailable — treating all as needed.
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 p-4 overflow-auto">
        {isEmpty ? (
          <EmptyProvision />
        ) : (
          <table className="table table-xs w-full">
            <thead>
              <tr className="text-[11px] text-base-content/60">
                <th className="w-4"></th>
                <th>Item</th>
                <th>Need</th>
                <th>Status</th>
                <th>From dishes</th>
              </tr>
            </thead>
            <tbody>
              {filteredList.map((row) => (
                <ProvisionRow key={row.key} row={row} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-base-200 flex flex-wrap items-center gap-2 text-xs">
        <button
          className="btn btn-outline btn-xs"
          onClick={handleExportCsv}
          disabled={provisionList.length === 0}
        >
          Export provision list as CSV
        </button>
        <button
          className="btn btn-primary btn-xs"
          onClick={handleSendMissingToGrocery}
          disabled={!provisionList.some(
            (r) =>
              r.coverage.status === "missing" ||
              r.coverage.status === "partial"
          )}
        >
          Send missing & short items to Grocery flow
        </button>
        <div className="ml-auto text-[11px] text-base-content/60">
          {sessionId ? (
            <>Linked to session: {sessionId}</>
          ) : (
            <>No session attached — using this as a one-time provision list.</>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ Row / Empty UI ---------------------------- */

function ProvisionRow({ row }) {
  const { coverage } = row;
  const status = coverage.status;

  let badgeClass = "badge-ghost";
  let statusLabel = "Unknown";

  if (status === "covered") {
    badgeClass = "badge-success";
    statusLabel = "Storehouse covers this";
  } else if (status === "partial") {
    badgeClass = "badge-warning";
    statusLabel = "Partly covered — needs a little more";
  } else if (status === "missing") {
    badgeClass = "badge-error";
    statusLabel = "Not in storehouse yet";
  }

  const recipeSummary = Array.from(row.recipeTitles || []);
  const needLabel =
    row.unit && row.neededQty
      ? `${row.neededQty} ${row.unit}`
      : row.neededQty || "—";

  return (
    <tr className="hover:bg-base-200/40">
      <td className="align-top">
        <span className={cx("badge badge-xs", badgeClass)}></span>
      </td>
      <td className="align-top">
        <div className="text-xs font-medium">{row.name}</div>
        {coverage.onHandQty > 0 && (
          <div className="text-[11px] text-base-content/60">
            On hand: {coverage.onHandQty} {row.unit || ""}
          </div>
        )}
      </td>
      <td className="align-top text-xs">
        {needLabel}
        {status === "partial" && (
          <div className="text-[11px] text-base-content/70">
            Short by: {coverage.shortfallQty} {row.unit || ""}
          </div>
        )}
      </td>
      <td className="align-top text-[11px]">
        <span className={cx("badge badge-xs", badgeClass)}>{statusLabel}</span>
      </td>
      <td className="align-top text-[11px]">
        {recipeSummary.length === 0 ? (
          <span className="text-base-content/60">From plan</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {recipeSummary.map((t) => (
              <span
                key={t}
                className="px-2 py-0.5 rounded-full bg-base-200 truncate max-w-[120px]"
                title={t}
              >
                {t}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}

function EmptyProvision() {
  return (
    <div className="rounded-xl border border-dashed border-base-300 p-6 text-center bg-base-100">
      <div className="text-sm font-semibold">
        No provision list yet
      </div>
      <p className="text-xs text-base-content/70 mt-1 max-w-md mx-auto">
        Once you choose recipes for a meal cycle or feast, this view will gather
        all needed ingredients and show how your storehouse can support them.
      </p>
    </div>
  );
}

/* ------------------------------ Core Logic -------------------------------- */

/**
 * Storehouse index:
 * - key: canonical ingredient identifier (name::unit)
 * - value: qty on hand
 */
function buildStorehouseIndex(snapshot) {
  const index = new Map();
  if (!Array.isArray(snapshot)) return index;

  for (const item of snapshot) {
    const name = (item.name || "").toLowerCase().trim();
    if (!name) continue;
    const unit = (item.unit || "ea").toLowerCase();
    const key = `${name}::${unit}`;
    const qty = Number(item.qty ?? item.quantity ?? 0);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    index.set(key, (index.get(key) || 0) + qty);
  }

  return index;
}

/**
 * Build provision list:
 * - Aggregate all ingredients across recipes by {name, unit}
 * - Attach coverage from storehouse index (if any).
 *
 * Row shape:
 * {
 *   key,
 *   name,
 *   unit,
 *   neededQty,
 *   recipeIds: Set,
 *   recipeTitles: Set,
 *   coverage: {
 *     status: "missing" | "partial" | "covered",
 *     onHandQty,
 *     shortfallQty,
 *   },
 * }
 */
function buildProvisionList(recipes, storehouseIndex, seedProvisionItems = []) {
  if ((!Array.isArray(recipes) || !recipes.length) && (!Array.isArray(seedProvisionItems) || !seedProvisionItems.length)) {
    return [];
  }

  const map = new Map();

  for (const recipe of recipes) {
    const rid = recipe?.id || recipe?.title || "recipe";
    const rtitle = recipe?.title || "Untitled dish";
    const ingredients = Array.isArray(recipe.ingredients)
      ? recipe.ingredients
      : [];

    for (const ing of ingredients) {
      const rawName = (ing.name || "").trim();
      if (!rawName) continue;
      const name = rawName.toLowerCase();
      const unit = (ing.unit || "ea").toLowerCase();
      const key = `${name}::${unit}`;
      const qty = Number(ing.qty ?? ing.quantity ?? 0) || 0;

      if (!map.has(key)) {
        map.set(key, {
          key,
          name: capitalize(rawName),
          unit,
          neededQty: 0,
          recipeIds: new Set(),
          recipeTitles: new Set(),
        });
      }

      const row = map.get(key);
      row.neededQty += qty;
      row.recipeIds.add(rid);
      row.recipeTitles.add(rtitle);
    }
  }

  // Allow direct seed rows from planner output when recipe ingredients are unavailable.
  for (const seed of Array.isArray(seedProvisionItems) ? seedProvisionItems : []) {
    const rawName = String(seed?.name || "").trim();
    if (!rawName) continue;
    const name = rawName.toLowerCase();
    const unit = String(seed?.unit || "ea").toLowerCase();
    const key = `${name}::${unit}`;
    const qty = Number(seed?.neededQty ?? seed?.qty ?? seed?.quantity ?? 0) || 0;

    if (!map.has(key)) {
      map.set(key, {
        key,
        name: capitalize(rawName),
        unit,
        neededQty: 0,
        recipeIds: new Set(),
        recipeTitles: new Set(),
      });
    }

    const row = map.get(key);
    row.neededQty += qty;
    if (seed?.recipeId) row.recipeIds.add(seed.recipeId);
    if (seed?.recipeTitle) row.recipeTitles.add(seed.recipeTitle);
  }

  // Attach coverage from storehouse
  const rows = [];
  for (const [key, row] of map.entries()) {
    const storeKey = `${row.name.toLowerCase()}::${row.unit}`;
    const onHandQty = storehouseIndex?.get?.(storeKey) || 0;
    let status = "missing";
    let shortfallQty = row.neededQty;

    if (row.neededQty <= 0) {
      status = "missing";
      shortfallQty = 0;
    } else if (onHandQty <= 0) {
      status = "missing";
    } else if (onHandQty >= row.neededQty) {
      status = "covered";
      shortfallQty = 0;
    } else {
      status = "partial";
      shortfallQty = row.neededQty - onHandQty;
    }

    rows.push({
      ...row,
      coverage: {
        status,
        onHandQty,
        shortfallQty,
      },
    });
  }

  rows.sort((a, b) => {
    const order = { missing: 0, partial: 1, covered: 2 };
    const sa = order[a.coverage.status] ?? 3;
    const sb = order[b.coverage.status] ?? 3;
    if (sa !== sb) return sa - sb;
    return a.name.localeCompare(b.name);
  });

  return rows;
}

function summarizeProvisionList(rows) {
  const summary = {
    totalItems: rows.length,
    missingOrShort: 0,
    fullyCovered: 0,
  };

  for (const row of rows) {
    if (row.coverage.status === "missing" || row.coverage.status === "partial") {
      summary.missingOrShort += 1;
    } else if (row.coverage.status === "covered") {
      summary.fullyCovered += 1;
    }
  }

  return summary;
}

/* ------------------------------ Helpers ----------------------------------- */

function safeCsv(v) {
  const s = String(v || "");
  if (s.includes(",") || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function capitalize(str) {
  const s = String(str || "").trim();
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

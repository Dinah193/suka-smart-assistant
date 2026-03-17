import React, { useEffect, useMemo, useState } from "react";
import PlannerDashboardCard from "@/components/planners/PlannerDashboardCard";
import StorehouseInventoryTable from "./StorehouseInventoryTable";
import {
  fetchStorehousePlannerData,
  updateStorehouseInventory,
} from "./InventoryEstimatorService";
import { getStorehouseRecommendations } from "./Neo4jStorehouseGraphService";

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function getReorderPoint(row) {
  const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const candidates = [metadata.minQty, metadata.reorderPoint, row?.reservedQty]
    .map((x) => toFiniteNumber(x, 0))
    .filter((x) => x > 0);
  return candidates.length ? Math.max(...candidates) : 0;
}

function getReplenishTarget(row) {
  const reorderPoint = getReorderPoint(row);
  if (reorderPoint > 0) return Math.max(reorderPoint + 1, reorderPoint * 2);
  return Math.max(1, toFiniteNumber(row?.qty, 0) + 1);
}

function isLowStock(row) {
  const qty = toFiniteNumber(row?.qty, 0);
  const reorderPoint = getReorderPoint(row);
  if (qty <= 0) return true;
  return reorderPoint > 0 && qty <= reorderPoint;
}

export default function StorehousePlanner({ householdId = "default-household", neo4jSession = null }) {
  const [rows, setRows] = useState([]);
  const [recommendations, setRecommendations] = useState([]);
  const [replenishingKey, setReplenishingKey] = useState("");
  const [alertMessage, setAlertMessage] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [batchDelta, setBatchDelta] = useState(1);

  const lowStockRows = useMemo(
    () => rows.filter((row) => row && typeof row === "object" && isLowStock(row)),
    [rows]
  );

  const zoneMap = useMemo(() => {
    const zones = new Map();
    for (const row of rows) {
      const metadata = row?.metadata && typeof row.metadata === "object" ? row.metadata : {};
      const zone =
        String(metadata.location || metadata.zone || row?.state || "unassigned").trim() ||
        "unassigned";
      const existing = zones.get(zone) || { zone, count: 0, low: 0, items: [] };
      existing.count += 1;
      if (isLowStock(row)) existing.low += 1;
      existing.items.push(row?.itemName || row?.sku || "item");
      zones.set(zone, existing);
    }
    return Array.from(zones.values()).sort((a, b) => b.count - a.count);
  }, [rows]);

  async function persistSingleRow(updatedRow, changeReason = "storehouse_manual_adjust") {
    const payload = {
      householdId,
      updatedBy: "storehouse.planner.ui",
      changeReason,
      inventory: [updatedRow],
    };
    await updateStorehouseInventory(payload);
  }

  async function handleQtyChange(row, nextQty) {
    const safeQty = Math.max(0, Number(nextQty || 0));
    const key = String(row?.id || row?.sku || row?.itemName || "");
    if (!key) return;

    const updated = { ...row, qty: safeQty };
    setRows((prev) =>
      prev.map((candidate) => {
        const candidateKey = String(
          candidate?.id || candidate?.sku || candidate?.itemName || ""
        );
        return candidateKey === key ? updated : candidate;
      })
    );

    try {
      await persistSingleRow(updated, "storehouse_qty_edit_ui");
      setAlertMessage(
        `Updated ${row?.itemName || row?.sku || "item"} to ${safeQty} ${row?.unit || "units"}.`
      );
    } catch {
      setAlertMessage(`Unable to update ${row?.itemName || row?.sku || "item"}.`);
    }
  }

  async function handleRemoveRow(row) {
    const key = String(row?.id || row?.sku || row?.itemName || "");
    if (!key) return;
    setRows((prev) => prev.filter((candidate) => String(candidate?.id || candidate?.sku || candidate?.itemName || "") !== key));
    try {
      await persistSingleRow({ ...row, qty: 0 }, "storehouse_quick_remove_ui");
      setAlertMessage(`Removed ${row?.itemName || row?.sku || "item"} from active stock.`);
    } catch {
      setAlertMessage(`Unable to remove ${row?.itemName || row?.sku || "item"}.`);
    }
  }

  async function handleQuickAdd(item) {
    const next = {
      id: `quick_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      sku: `manual.${String(item.itemName || "item").toLowerCase().replace(/\s+/g, ".")}`,
      itemName: item.itemName,
      qty: Math.max(0, Number(item.qty || 0)),
      unit: item.unit || "unit",
      state: "raw",
      method: null,
      reservedQty: 0,
      metadata: { location: "pantry", source: "quick_add" },
    };
    setRows((prev) => [next, ...prev]);
    try {
      await persistSingleRow(next, "storehouse_quick_add_ui");
      setAlertMessage(`Added ${next.itemName} (${next.qty} ${next.unit}).`);
    } catch {
      setAlertMessage(`Unable to add ${next.itemName}.`);
    }
  }

  async function handleBatchAdjust() {
    const delta = Math.max(0, Number(batchDelta || 0));
    const targets = lowStockRows;
    if (!targets.length || delta <= 0) return;

    const updatedRows = rows.map((row) => {
      const key = String(row?.id || row?.sku || row?.itemName || "");
      const match = targets.find(
        (x) => String(x?.id || x?.sku || x?.itemName || "") === key
      );
      if (!match) return row;
      return { ...row, qty: toFiniteNumber(row?.qty, 0) + delta };
    });

    setRows(updatedRows);
    try {
      await updateStorehouseInventory({
        householdId,
        updatedBy: "storehouse.planner.ui",
        changeReason: "storehouse_batch_adjust_ui",
        inventory: updatedRows.filter((row) =>
          targets.some(
            (x) => String(x?.id || x?.sku || x?.itemName || "") === String(row?.id || row?.sku || row?.itemName || "")
          )
        ),
      });
      setAlertMessage(`Batch updated ${targets.length} low-stock items by +${delta}.`);
    } catch {
      setAlertMessage("Unable to apply batch update.");
    }
  }

  async function handleReplenish(row) {
    const key = String(row?.id || row?.sku || row?.itemName || "");
    if (!key) return;
    setReplenishingKey(key);
    setAlertMessage("");

    const nextQty = getReplenishTarget(row);
    const payload = {
      householdId,
      updatedBy: "storehouse.planner.ui",
      changeReason: "low_stock_replenish_ui",
      inventory: [
        {
          ...row,
          qty: nextQty,
        },
      ],
    };

    try {
      await updateStorehouseInventory(payload);
      setRows((prev) =>
        prev.map((candidate) => {
          const candidateKey = String(
            candidate?.id || candidate?.sku || candidate?.itemName || ""
          );
          if (candidateKey !== key) return candidate;
          return {
            ...candidate,
            qty: nextQty,
          };
        })
      );
      setAlertMessage(`Replenished ${row?.itemName || row?.sku || "item"} to ${nextQty} ${row?.unit || "units"}.`);
    } catch {
      setAlertMessage(`Unable to replenish ${row?.itemName || row?.sku || "item"}. Please retry.`);
    } finally {
      setReplenishingKey("");
    }
  }

  useEffect(() => {
    let alive = true;
    fetchStorehousePlannerData(householdId)
      .then((d) => alive && setRows(d.inventory || []))
      .catch(() => alive && setRows([]));

    getStorehouseRecommendations({ neo4jSession, householdId })
      .then((d) => alive && setRecommendations(d))
      .catch(() => alive && setRecommendations([]));

    return () => {
      alive = false;
    };
  }, [householdId, neo4jSession]);

  return (
    <main className="space-y-4 p-4">
      <h1 className="text-2xl font-bold text-amber-900">Storehouse Planner</h1>

      <PlannerDashboardCard
        title="Visual inventory map"
        subtitle="Zones show stock density and low-stock pressure at a glance."
      >
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {zoneMap.map((zone) => (
            <div key={zone.zone} className="rounded-md border border-amber-200 bg-white p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold text-amber-900">{zone.zone}</div>
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                  {zone.count} items
                </span>
              </div>
              <div className="mt-1 text-xs text-amber-700">Low stock: {zone.low}</div>
              <div className="mt-1 text-xs text-amber-700 truncate" title={zone.items.join(", ")}>
                {zone.items.slice(0, 3).join(", ")}
                {zone.items.length > 3 ? ` +${zone.items.length - 3}` : ""}
              </div>
            </div>
          ))}
          {!zoneMap.length ? (
            <div className="rounded-md border border-amber-200 bg-white p-3 text-sm text-amber-900">
              No inventory rows available yet.
            </div>
          ) : null}
        </div>
      </PlannerDashboardCard>

      <PlannerDashboardCard
        title="Low-stock alert strip"
        subtitle="See urgent shortages and replenish with one click."
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-white p-2">
          <label className="inline-flex items-center gap-2 text-sm text-amber-900">
            <input
              type="checkbox"
              checked={batchMode}
              onChange={(e) => setBatchMode(e.target.checked)}
            />
            Batch quantity mode
          </label>
          {batchMode ? (
            <>
              <label className="inline-flex items-center gap-1 text-sm text-amber-900">
                +
                <input
                  className="w-16 rounded border border-amber-300 px-2 py-1"
                  type="number"
                  min="1"
                  value={batchDelta}
                  onChange={(e) => setBatchDelta(e.target.value)}
                />
              </label>
              <button
                type="button"
                className="rounded-md border border-amber-300 bg-white px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100"
                onClick={handleBatchAdjust}
              >
                Apply to all low-stock
              </button>
            </>
          ) : null}
        </div>

        {lowStockRows.length ? (
          <div className="space-y-2">
            {lowStockRows.map((row) => {
              const key = String(row?.id || row?.sku || row?.itemName || "");
              const reorderPoint = getReorderPoint(row);
              const targetQty = getReplenishTarget(row);
              const isBusy = replenishingKey === key;
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2"
                >
                  <div className="text-sm text-amber-900">
                    <strong>{row?.itemName || row?.sku || "Unnamed item"}</strong>
                    <span className="ml-2">
                      {toFiniteNumber(row?.qty, 0)} {row?.unit || "units"} on hand
                    </span>
                    {reorderPoint > 0 ? (
                      <span className="ml-2 text-amber-700">(reorder at {reorderPoint})</span>
                    ) : (
                      <span className="ml-2 text-amber-700">(depleted/low)</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => handleReplenish(row)}
                    disabled={isBusy}
                    className="rounded-md border border-amber-300 bg-white px-3 py-1 text-sm font-medium text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isBusy ? "Replenishing..." : `Replenish to ${targetQty} ${row?.unit || "units"}`}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-sm text-amber-900">All items are above reorder thresholds.</p>
        )}

        {alertMessage ? (
          <p className="mt-3 text-sm text-amber-800" role="status">
            {alertMessage}
          </p>
        ) : null}
      </PlannerDashboardCard>

      <StorehouseInventoryTable
        rows={rows}
        editable
        onQtyChange={handleQtyChange}
        onRemoveRow={handleRemoveRow}
        onQuickAdd={handleQuickAdd}
      />

      <PlannerDashboardCard title="Replenishment + Preservation Priorities" subtitle="Inventory-first graph reasoning">
        <ul className="space-y-2 text-sm text-amber-900">
          {recommendations.map((rec) => (
            <li key={rec.item} className="rounded-md bg-amber-50 p-2">
              {rec.item}: {rec.explain}
            </li>
          ))}
          {!recommendations.length ? <li>No priorities yet.</li> : null}
        </ul>
      </PlannerDashboardCard>
    </main>
  );
}

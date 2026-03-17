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

  const lowStockRows = useMemo(
    () => rows.filter((row) => row && typeof row === "object" && isLowStock(row)),
    [rows]
  );

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
        title="Low-stock alert strip"
        subtitle="See urgent shortages and replenish with one click."
      >
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

      <StorehouseInventoryTable rows={rows} />

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

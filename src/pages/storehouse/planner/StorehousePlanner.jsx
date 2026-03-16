import React, { useEffect, useState } from "react";
import PlannerDashboardCard from "@/components/planners/PlannerDashboardCard";
import StorehouseInventoryTable from "./StorehouseInventoryTable";
import { fetchStorehousePlannerData } from "./InventoryEstimatorService";
import { getStorehouseRecommendations } from "./Neo4jStorehouseGraphService";

export default function StorehousePlanner({ householdId = "default-household", neo4jSession = null }) {
  const [rows, setRows] = useState([]);
  const [recommendations, setRecommendations] = useState([]);

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

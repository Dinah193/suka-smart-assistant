import React, { useEffect, useMemo, useState } from "react";
import PlannerDashboardCard from "@/components/planners/PlannerDashboardCard";
import GardenSchedule from "./GardenSchedule";
import { estimateAnimalOutput } from "./AnimalProductionEstimator";
import { estimatePreservationYield } from "./PreservationEstimator";
import { getHomesteadRecommendations } from "./Neo4jHomesteadGraphService";

export default function HomesteadPlanner({ householdId = "default-household", neo4jSession = null }) {
  const [recommendations, setRecommendations] = useState([]);

  useEffect(() => {
    let alive = true;
    getHomesteadRecommendations({ neo4jSession, householdId })
      .then((rows) => alive && setRecommendations(rows))
      .catch(() => alive && setRecommendations([]));
    return () => {
      alive = false;
    };
  }, [householdId, neo4jSession]);

  const animal = useMemo(() => estimateAnimalOutput({ species: "chicken", count: 12 }), []);
  const preservation = useMemo(
    () => estimatePreservationYield({ qty: 40, method: "canning" }),
    []
  );

  return (
    <main className="space-y-4 p-4">
      <h1 className="text-2xl font-bold text-lime-900">Homestead Planner</h1>
      <p className="text-sm text-lime-700">
        Tracks production, preservation, and meal-plan demand to reduce prep burden across the household.
      </p>

      <GardenSchedule
        tasks={[
          { id: "g1", title: "Harvest tomatoes for canning", when: "This weekend" },
          { id: "g2", title: "Dry herbs and label jars", when: "Thursday afternoon" },
        ]}
      />

      <div className="grid gap-4 md:grid-cols-2">
        <PlannerDashboardCard title="Animal Output Forecast" score={0.84} chips={["collaboration-ready"]}>
          <p className="text-sm text-lime-800">Weekly eggs: {animal.weeklyEggs}</p>
          <p className="text-xs text-lime-700">Preservation-ready outputs: {animal.preservationReadyOutputs.join(", ") || "none"}</p>
        </PlannerDashboardCard>

        <PlannerDashboardCard title="Preservation Forecast" score={0.88} chips={["prep-time reduction"]}>
          <p className="text-sm text-lime-800">Preserved qty: {preservation.preservedQty}</p>
          <p className="text-xs text-lime-700">Estimated prep reduction: {Math.round(preservation.prepReductionPct * 100)}%</p>
        </PlannerDashboardCard>
      </div>

      <PlannerDashboardCard title="Neo4j Collaboration + Processing Recommendations" subtitle="Explainable graph path hints">
        <ul className="space-y-2 text-sm text-lime-900">
          {recommendations.map((rec) => (
            <li key={rec.output} className="rounded-md bg-lime-50 p-2">
              {rec.output}: {rec.explain}
            </li>
          ))}
          {!recommendations.length ? <li>No recommendations yet.</li> : null}
        </ul>
      </PlannerDashboardCard>
    </main>
  );
}

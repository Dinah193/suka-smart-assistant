import React from "react";
import PlannerDashboardCard from "@/components/planners/PlannerDashboardCard";
import PreservationTaskCard from "@/components/planners/PreservationTaskCard";

export default function MealPlanDashboard({ recommendations = [], preservationTasks = [], onCompleteTask }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PlannerDashboardCard
        title="Meal Recommendations"
        subtitle="Preservation-aware, inventory-first suggestions"
      >
        <ul className="space-y-2 text-sm text-emerald-900">
          {recommendations.map((rec) => (
            <li key={rec.meal} className="rounded-md bg-emerald-50 p-2">
              <div className="font-medium">{rec.meal}</div>
              <div className="text-xs text-emerald-700">{rec.explain?.reason || "Graph-scored recommendation"}</div>
            </li>
          ))}
          {!recommendations.length ? <li>No recommendations yet.</li> : null}
        </ul>
      </PlannerDashboardCard>

      <PlannerDashboardCard
        title="Preservation Impact"
        subtitle="Prep/cook reductions from preserved ingredients"
      >
        <div className="space-y-3">
          {preservationTasks.map((task) => (
            <PreservationTaskCard key={task.id || task.title} task={task} onComplete={onCompleteTask} />
          ))}
          {!preservationTasks.length ? <p className="text-sm text-emerald-700">No preservation tasks queued.</p> : null}
        </div>
      </PlannerDashboardCard>
    </div>
  );
}

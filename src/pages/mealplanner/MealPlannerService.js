import { publishPlannerEvent, PlannerEvents } from "@/eventBus/plannerEventBus";

export async function fetchMealPlannerData(householdId) {
  const res = await fetch(`/api/planners/meal?householdId=${encodeURIComponent(householdId)}`);
  if (!res.ok) throw new Error("Failed to load meal planner data");
  return res.json();
}

export async function saveMealPlannerOutput(payload) {
  const res = await fetch(`/api/planners/meal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Failed to save meal planner output");
  const data = await res.json();

  publishPlannerEvent(PlannerEvents.MEAL_PLAN_UPDATED, data, {
    source: "MealPlannerService.saveMealPlannerOutput",
  });

  return data;
}

export default { fetchMealPlannerData, saveMealPlannerOutput };

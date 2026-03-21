const TOOL_ALIASES = {
  batch: "cycle",
  batches: "cycle",
  "batch-collab": "cycle",
  "batch-collaboration": "cycle",
  collaboration: "prep",
  planner: "dashboard",
  overview: "dashboard",
};

export function normalizeMealPlannerTool(raw, knownToolIds) {
  const value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  const resolved = TOOL_ALIASES[value] || value;
  return knownToolIds.has(resolved) ? resolved : "";
}

export function buildMealPlannerProbeText(activeTool) {
  const tool = String(activeTool || "dashboard");
  return [
    "Meal Planner Ready",
    `Active tool: ${tool}`,
    "Probe keywords: prep batch cycle",
  ].join(" | ");
}

export function resolveToolFromSearch(search, knownToolIds) {
  const params = new URLSearchParams(search || "");
  return (
    normalizeMealPlannerTool(params.get("tool"), knownToolIds) ||
    normalizeMealPlannerTool(params.get("tab"), knownToolIds) ||
    normalizeMealPlannerTool(params.get("focus"), knownToolIds) ||
    ""
  );
}

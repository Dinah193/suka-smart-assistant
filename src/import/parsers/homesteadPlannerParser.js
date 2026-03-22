// src/import/parsers/homesteadPlannerParser.js
// Minimal parser bridge used by import pages and CI browser smoke.

async function parse(raw = {}, meta = {}) {
  const source = raw && typeof raw === "object" ? raw : {};

  return {
    type: "homesteadplanner_import",
    domain: "homesteadplanner",
    title: String(meta.title || source.title || "Imported homestead plan"),
    summary: String(source.summary || "Homestead planner import"),
    seasonalGoals: Array.isArray(source.seasonalGoals) ? source.seasonalGoals : [],
    projects: Array.isArray(source.projects) ? source.projects : [],
    dependencies: Array.isArray(source.dependencies) ? source.dependencies : [],
    resources: Array.isArray(source.resources) ? source.resources : [],
    timeline: Array.isArray(source.timeline) ? source.timeline : [],
    notes: source.notes ? String(source.notes) : null,
  };
}

const homesteadPlannerParser = {
  parse,
  parseHomesteadPlanner: parse,
};

export default homesteadPlannerParser;

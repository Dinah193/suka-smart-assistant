import { computePlannerScore, runNeo4jRead } from "@/services/neo4j/GraphUtils";

export async function getHomesteadRecommendations({ neo4jSession, householdId }) {
  const query = `
    // Placeholder graph query: production, preservation readiness, and collaboration paths
    MATCH (p:Production {householdId: $householdId})
    RETURN p.name AS output, p.preservationReady AS preservationReady
    LIMIT 50
  `;

  const { records } = await runNeo4jRead(neo4jSession, query, { householdId });
  return records.map((r) => ({
    output: r.get ? r.get("output") : r.output,
    preservationReady: r.get ? r.get("preservationReady") : r.preservationReady,
    score: computePlannerScore({
      functional: 0.88,
      dietarySafe: 1,
      inventoryFirst: 0.8,
      goalOptimizing: 0.82,
      preservationEfficiency: 0.9,
    }),
    explain: "Prioritize outputs with preservation-ready windows and meal-plan demand.",
  }));
}

export default { getHomesteadRecommendations };

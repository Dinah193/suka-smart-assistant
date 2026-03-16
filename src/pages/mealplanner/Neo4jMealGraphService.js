import { buildExplainablePath, computePlannerScore, runNeo4jRead } from "@/services/neo4j/GraphUtils";

export async function getMealRecommendations({ neo4jSession, context = {} }) {
  const query = `
    // Placeholder graph query: preserved inventory + preferences -> candidate meals
    MATCH (m:Meal)
    OPTIONAL MATCH (m)-[:USES]->(i:Ingredient)
    RETURN m.name AS meal, collect(i.name) AS ingredients
    LIMIT 20
  `;

  const { records } = await runNeo4jRead(neo4jSession, query, context);
  return records.map((r) => {
    const parts = {
      functional: 0.8,
      dietarySafe: 0.9,
      inventoryFirst: 0.75,
      goalOptimizing: 0.7,
      preservationEfficiency: 0.85,
    };
    return {
      meal: r.get ? r.get("meal") : r.meal,
      ingredients: r.get ? r.get("ingredients") : r.ingredients,
      score: computePlannerScore(parts),
      explain: buildExplainablePath({
        reason: "Preserved lots reduce prep and cook effort",
        substitutions: ["fresh tomato -> canned tomato"],
        collaboration: ["share prep batch with partner household"],
      }),
    };
  });
}

export default { getMealRecommendations };

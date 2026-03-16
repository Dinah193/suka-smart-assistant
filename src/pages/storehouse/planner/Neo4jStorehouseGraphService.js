import { computePlannerScore, runNeo4jRead } from "@/services/neo4j/GraphUtils";

export async function getStorehouseRecommendations({ neo4jSession, householdId }) {
  const query = `
    // Placeholder graph query: detect low lots and substitution graph options
    MATCH (l:Lot {householdId: $householdId})
    RETURN l.name AS item, l.qty AS qty
    LIMIT 50
  `;

  const { records } = await runNeo4jRead(neo4jSession, query, { householdId });
  return records.map((r) => ({
    item: r.get ? r.get("item") : r.item,
    qty: r.get ? r.get("qty") : r.qty,
    score: computePlannerScore({
      functional: 0.85,
      dietarySafe: 1,
      inventoryFirst: 0.95,
      goalOptimizing: 0.75,
      preservationEfficiency: 0.8,
    }),
    explain: "Use preserved stock first, then replenish with preservation priority queue.",
  }));
}

export default { getStorehouseRecommendations };

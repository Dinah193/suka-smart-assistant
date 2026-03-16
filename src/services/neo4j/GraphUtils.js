const SCORE_WEIGHTS = {
  functional: 0.25,
  dietarySafe: 0.25,
  inventoryFirst: 0.2,
  goalOptimizing: 0.2,
  preservationEfficiency: 0.1,
};

export function computePlannerScore(parts = {}) {
  const normalized = {
    functional: Number(parts.functional || 0),
    dietarySafe: Number(parts.dietarySafe || 0),
    inventoryFirst: Number(parts.inventoryFirst || 0),
    goalOptimizing: Number(parts.goalOptimizing || 0),
    preservationEfficiency: Number(parts.preservationEfficiency || 0),
  };

  const weighted = Object.entries(SCORE_WEIGHTS).reduce((acc, [k, w]) => {
    return acc + Math.max(0, Math.min(1, normalized[k])) * w;
  }, 0);

  return {
    total: Number(weighted.toFixed(4)),
    parts: normalized,
    weights: SCORE_WEIGHTS,
  };
}

export function buildPreservationImpact({ prepMinutes = 0, cookMinutes = 0, reductionPct = 0 } = {}) {
  const pct = Math.max(0, Math.min(1, Number(reductionPct || 0)));
  const prepReduction = Math.round(Number(prepMinutes || 0) * pct);
  const cookReduction = Math.round(Number(cookMinutes || 0) * pct);

  return {
    reductionPct: pct,
    prepReduction,
    cookReduction,
    netPrepMinutes: Math.max(0, Number(prepMinutes || 0) - prepReduction),
    netCookMinutes: Math.max(0, Number(cookMinutes || 0) - cookReduction),
  };
}

export async function runNeo4jRead(session, query, params = {}) {
  if (!session || typeof session.run !== "function") {
    return { records: [], summary: null };
  }
  const res = await session.run(query, params);
  return { records: res.records || [], summary: res.summary || null };
}

export function buildExplainablePath(record = {}) {
  return {
    reason: record.reason || "Preservation-aware recommendation",
    substitutions: record.substitutions || [],
    collaboration: record.collaboration || [],
    inventoryLinks: record.inventoryLinks || [],
  };
}

export default {
  computePlannerScore,
  buildPreservationImpact,
  runNeo4jRead,
  buildExplainablePath,
};

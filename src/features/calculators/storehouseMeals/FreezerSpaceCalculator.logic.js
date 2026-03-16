function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const SHAPE_EFFICIENCY = {
  box: 0.95,
  bag: 0.85,
  round: 0.8,
  irregular: 0.72,
};

function litersToCuFt(liters) {
  return liters / 28.3168;
}

function normItem(item = {}) {
  const count = Math.max(toNum(item.count, 0), 0);
  const direct = toNum(item.volumePerUnitCuFt, NaN);
  const liters = toNum(item.volumePerUnitL, NaN);
  const baseVol = Number.isFinite(direct)
    ? Math.max(direct, 0)
    : Number.isFinite(liters)
      ? Math.max(litersToCuFt(liters), 0)
      : 0;

  const shape = String(item.packagingShape || "irregular").toLowerCase();
  const shapeEff = SHAPE_EFFICIENCY[shape] || SHAPE_EFFICIENCY.irregular;
  const stackBoost = item.stackable ? 1.08 : 1;
  const custom = Number.isFinite(item.packingEfficiency) ? toNum(item.packingEfficiency, 1) : null;
  const efficiency = Math.max(0.5, Math.min(1.2, custom ?? shapeEff * stackBoost));

  return {
    domainTag: String(item.domainTag || "uncategorized"),
    requiredCuFt: (baseVol * count) / efficiency,
  };
}

export function calculateFreezerSpace(config = {}) {
  const capacityCuFt = Math.max(toNum(config.capacityCuFt, 0), 0);
  const reservedPct = Math.max(0, Math.min(1, toNum(config.reservedPct, 0)));
  const effectiveCapacityCuFt = capacityCuFt * (1 - reservedPct);
  const rawItems = Array.isArray(config.items) ? config.items : [];

  const byDomain = {};
  let requiredCuFt = 0;
  for (const item of rawItems) {
    const normalized = normItem(item);
    requiredCuFt += normalized.requiredCuFt;
    const bucket = byDomain[normalized.domainTag] || { requiredCuFt: 0, utilizationPct: 0 };
    bucket.requiredCuFt += normalized.requiredCuFt;
    byDomain[normalized.domainTag] = bucket;
  }

  const utilizationPct = effectiveCapacityCuFt > 0 ? (requiredCuFt / effectiveCapacityCuFt) * 100 : 0;
  for (const key of Object.keys(byDomain)) {
    byDomain[key].utilizationPct = effectiveCapacityCuFt > 0 ? (byDomain[key].requiredCuFt / effectiveCapacityCuFt) * 100 : 0;
  }

  const domainOrder = Object.entries(byDomain)
    .sort((a, b) => b[1].requiredCuFt - a[1].requiredCuFt)
    .map(([domainTag, data], idx) => ({ domainTag, layerIndex: idx + 1, approxCuFt: data.requiredCuFt }));

  return {
    capacityCuFt,
    reservedPct,
    effectiveCapacityCuFt,
    requiredCuFt,
    utilizationPct,
    fits: requiredCuFt <= effectiveCapacityCuFt,
    byDomain,
    layoutHints: {
      deepShelvesRecommended: !!config.layout?.deepChest,
      basketsRecommended: toNum(config.layout?.baskets, 0) > 0,
      layerSuggestions: domainOrder,
    },
    warnings: [],
  };
}

export default {
  calculateFreezerSpace,
};

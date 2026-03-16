function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const METHOD_BASE_MONTHS = {
  freezing: 12,
  canning: 24,
  dehydrating: 18,
  fermenting: 9,
  curing: 10,
};

const FAT_FACTORS = { low: 1.05, medium: 1, high: 0.8 };
const CONTAINER_FACTORS = { excellent: 1.1, ok: 1, poor: 0.75 };
const OXYGEN_FACTORS = { low: 1.1, medium: 1, high: 0.8 };

function normEnum(value, allowed, fallback) {
  const v = String(value || "").toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

export function calculatePreservationTime(config = {}) {
  const foodType = String(config.foodType || "unknown").toLowerCase();
  const inputMethod = String(config.method || "").toLowerCase();
  const knownMethods = Object.keys(METHOD_BASE_MONTHS);
  const unknownMethod = !knownMethods.includes(inputMethod);
  const method = unknownMethod ? inputMethod || "unknown" : inputMethod;
  const storageTempF = toNum(config.storageTempF, 32);
  const fatContent = normEnum(config.fatContent, ["low", "medium", "high"], "medium");
  const containerIntegrity = normEnum(config.containerIntegrity, ["excellent", "ok", "poor"], "ok");
  const oxygenExposure = normEnum(config.oxygenExposure, ["low", "medium", "high"], "medium");

  const methodBaseMonths = unknownMethod ? 0.8 : (METHOD_BASE_MONTHS[method] || 6);
  const tempAdjustment = method === "freezing"
    ? Math.max(0.4, Math.min(1.5, (32 - storageTempF) / 40 + 1))
    : Math.max(0.5, Math.min(1.3, (70 - storageTempF) / 100 + 1));

  const fatAdjustment = FAT_FACTORS[fatContent] || 1;
  const containerAdjustment = CONTAINER_FACTORS[containerIntegrity] || 1;
  const oxygenAdjustment = OXYGEN_FACTORS[oxygenExposure] || 1;
  const waterActivityAdjustment = Number.isFinite(config.waterActivity)
    ? Math.max(0.6, Math.min(1.25, 1.2 - toNum(config.waterActivity, 0.7) * 0.5))
    : 1;
  const saltPctAdjustment = Number.isFinite(config.saltPct)
    ? Math.max(0.7, Math.min(1.25, 1 + toNum(config.saltPct, 0) / 100 * 0.8))
    : 1;

  let recommendedMonths = Math.max(
    0,
    methodBaseMonths * tempAdjustment * fatAdjustment * containerAdjustment * oxygenAdjustment * waterActivityAdjustment * saltPctAdjustment
  );
  if (unknownMethod) recommendedMonths = Math.min(recommendedMonths, 1);
  const minMonths = Math.max(0, recommendedMonths * 0.75);
  const maxMonths = Math.max(minMonths, recommendedMonths * 1.3);

  let riskLevel = unknownMethod ? "high" : "low";
  if (containerIntegrity === "poor" || oxygenExposure === "high" || storageTempF > 80) riskLevel = "high";
  else if (storageTempF > 60 || fatContent === "high") riskLevel = "medium";

  return {
    foodType,
    method,
    storageTempF,
    fatContent,
    containerIntegrity,
    oxygenExposure,
    recommendedMonths,
    minMonths,
    maxMonths,
    riskLevel,
    factors: {
      tempAdjustment,
      fatAdjustment,
      containerAdjustment,
      oxygenAdjustment,
      methodBaseMonths,
      waterActivityAdjustment,
      saltPctAdjustment,
    },
    notes: Array.isArray(config.notes) ? config.notes.slice() : [],
  };
}

export default {
  calculatePreservationTime,
};

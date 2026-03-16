function toNum(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function resolveEfficiency(scaleFactor, efficiencyCurve = {}) {
  const minEfficiency = clamp(toNum(efficiencyCurve.minEfficiency, 0.75), 0.2, 1)
  const maxEfficiency = clamp(toNum(efficiencyCurve.maxEfficiency, 0.95), minEfficiency, 1)
  const growth = Math.max(scaleFactor - 1, 0)
  const ramp = 1 - Math.exp(-growth / 2)
  return minEfficiency + (maxEfficiency - minEfficiency) * ramp
}

export function calculateBatchYield(config = {}) {
  const baseBatch = config.baseBatch || {}
  const baseServings = toNum(baseBatch.servings, 0)
  const baseDurationMinutes = toNum(baseBatch.durationMinutes, 0)
  const targetServings = toNum(config.targetServings, 0)

  if (baseServings <= 0 || baseDurationMinutes <= 0 || targetServings <= 0) {
    throw new Error("invalid_batch_config")
  }

  const scaleFactor = targetServings / baseServings
  const parallelCapacity = Math.max(1, toNum(config.parallelCapacity, 1))
  const efficiency = resolveEfficiency(scaleFactor, config.efficiencyCurve)

  const prepBase = Math.max(0, toNum(baseBatch.prepMinutes, baseDurationMinutes * 0.25))
  const cookBase = Math.max(0, toNum(baseBatch.cookMinutes, Math.max(baseDurationMinutes - prepBase, 0)))

  const prepScaled = prepBase * (1 + Math.max(scaleFactor - 1, 0) * 0.35)
  const effectiveCookScale = scaleFactor / parallelCapacity
  const cookScaled = cookBase * Math.max(effectiveCookScale / Math.max(efficiency, 0.01), 0.1)

  let adjustedDurationMinutes = prepScaled + cookScaled

  const caps = config.caps || {}
  if (Number.isFinite(caps.minDurationMinutes)) {
    adjustedDurationMinutes = Math.max(adjustedDurationMinutes, toNum(caps.minDurationMinutes, 0))
  }
  if (Number.isFinite(caps.maxDurationMinutes)) {
    adjustedDurationMinutes = Math.min(adjustedDurationMinutes, toNum(caps.maxDurationMinutes, adjustedDurationMinutes))
  }

  adjustedDurationMinutes = Math.max(1, adjustedDurationMinutes)

  const prepRatio = prepScaled / Math.max(prepScaled + cookScaled, 1)
  const breakdownPrep = adjustedDurationMinutes * prepRatio
  const breakdownCook = adjustedDurationMinutes - breakdownPrep

  return {
    targetServings,
    scaleFactor,
    adjustedDurationMinutes,
    perUnitMinutes: adjustedDurationMinutes / targetServings,
    efficiency,
    breakdown: {
      prepMinutes: breakdownPrep,
      cookMinutes: breakdownCook,
    },
    method: "batch-yield-v1",
    notes: "Uses non-linear scale efficiency and optional parallel capacity.",
  }
}

export default {
  calculateBatchYield,
}

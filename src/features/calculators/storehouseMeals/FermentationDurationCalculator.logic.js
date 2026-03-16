function toNum(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function round1(v) {
  return Math.round(v * 10) / 10
}

function baseDaysForProduct(productType) {
  const key = String(productType || "").toLowerCase()
  if (key === "vegetable") return 10
  if (key === "dairy") return 0.8
  if (key === "grain") return 3.5
  if (key === "beverage") return 7
  if (key === "meat") return 6
  return 7
}

export function calculateFermentationDuration(config = {}) {
  const warnings = []
  const productType = String(config.productType || "unknown")
  const style = config.style == null ? undefined : String(config.style)
  const unit = String(config.unit || "F").toUpperCase()

  let tempF = toNum(config.tempF, 70)
  if (unit === "C") tempF = tempF * 9 / 5 + 32
  if (tempF < 32 || tempF > 120) warnings.push("temperature adjusted to safe range")
  tempF = clamp(tempF, 32, 120)

  const saltRaw = config.saltPct == null ? 0.025 : toNum(config.saltPct, 0.025)
  const inocRaw = config.inoculationPct == null ? 0 : toNum(config.inoculationPct, 0)
  if (saltRaw < 0 || saltRaw > 1) warnings.push("salt out of range")
  if (inocRaw < 0 || inocRaw > 1) warnings.push("inoculation out of range")
  const saltPct = clamp(saltRaw, 0, 1)
  const sugarPct = clamp(config.sugarPct == null ? 0 : toNum(config.sugarPct, 0), 0, 1)
  const inoculationPct = clamp(inocRaw, 0, 1)
  const starterType = config.starterType == null ? null : String(config.starterType)

  let days = baseDaysForProduct(productType)

  const tempDelta = tempF - 70
  days *= Math.max(0.2, 1 - tempDelta * 0.02)

  if (productType.toLowerCase() === "vegetable") {
    days *= 1 + (saltPct - 0.025) * 4
  }

  if (starterType === "inoculated" || starterType === "commercial") {
    days *= 1 - clamp(inoculationPct, 0, 0.4) * 1.2
  }

  if (starterType === "wild") {
    days *= 1.08
  }

  const targetProfile = String(config.targetProfile || "standard").toLowerCase()
  if (targetProfile === "quick") days *= 0.82
  if (targetProfile === "slow") days *= 1.2

  const vesselVolumeL = Math.max(0, toNum(config.vesselVolumeL, 0))
  if (vesselVolumeL > 0) {
    days *= 1 + clamp(Math.log10(1 + vesselVolumeL) * 0.06, 0, 0.22)
  }

  const altitudeFt = Math.max(0, toNum(config.altitudeFt, 0))
  if (altitudeFt > 0) {
    days *= 1 + clamp((altitudeFt / 1000) * 0.006, 0, 0.08)
  }

  days = clamp(days, 0.2, 55)
  const minDays = round1(Math.max(0, days * 0.8))
  const maxDays = round1(Math.min(60, Math.max(minDays, days * 1.25)))
  const recommendedDays = round1(clamp(days, minDays, maxDays))

  const lacticFocus = clamp(0.7 + saltPct * 2 - sugarPct * 0.6, 0, 1)
  const yeastEmphasis = clamp(0.35 + sugarPct * 2.2 - saltPct * 1.1, 0, 1)
  const aceticRisk = clamp(0.15 + Math.max(tempF - 78, 0) / 45, 0, 1)

  return {
    productType,
    style,
    tempF,
    saltPct,
    sugarPct,
    starterType,
    inoculationPct,
    minDays,
    maxDays,
    recommendedDays,
    profile: {
      lacticFocus,
      yeastEmphasis,
      aceticRisk,
    },
    warnings,
    notes: "Fermentation estimate based on product, temperature, and process modifiers.",
  }
}

export default {
  calculateFermentationDuration,
}

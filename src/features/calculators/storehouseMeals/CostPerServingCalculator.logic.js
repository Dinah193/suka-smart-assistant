function toNum(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function safeCostPerServing(unitPrice, effectiveServings) {
  if (effectiveServings <= 0) return Number.MAX_SAFE_INTEGER
  return unitPrice / effectiveServings
}

export function calculateCostPerServing(config = {}) {
  const itemsIn = Array.isArray(config.items) ? config.items : []
  const currency = String(config.currency || "USD")
  const groupBy = String(config.groupBy || "normalizedName")
  const warnings = []

  const items = itemsIn.map((raw = {}) => {
    const unitPriceRaw = toNum(raw.unitPrice, 0)
    const servingsPerUnit = toNum(raw.servingsPerUnit, 0)
    const wasteRaw = raw.wasteFactor == null ? 0 : toNum(raw.wasteFactor, 0)
    const wasteFactor = clamp(wasteRaw, 0, 1)
    const unitPrice = Math.max(0, unitPriceRaw)

    if (wasteRaw !== wasteFactor) warnings.push(`waste clamped for ${raw.id || raw.name || "item"}`)
    if (unitPriceRaw <= 0) warnings.push(`price issue for ${raw.id || raw.name || "item"}`)
    if (servingsPerUnit <= 0) warnings.push(`servings issue for ${raw.id || raw.name || "item"}`)

    const effectiveServings = Math.max(0, servingsPerUnit * (1 - wasteFactor))
    const costPerUnit = unitPrice
    const costPerServing = safeCostPerServing(unitPrice, effectiveServings)

    const groupSource = raw[groupBy]
    const groupKey = String(groupSource || raw.normalizedName || raw.name || raw.id || "unknown")

    return {
      ...raw,
      wasteFactor,
      effectiveServings,
      costPerUnit,
      costPerServing,
      groupKey,
      notes: [],
    }
  })

  const grouped = new Map()
  for (const item of items) {
    if (!grouped.has(item.groupKey)) grouped.set(item.groupKey, [])
    grouped.get(item.groupKey).push(item)
  }

  const groups = []
  for (const [key, groupItems] of grouped.entries()) {
    let cheapest = null
    for (const item of groupItems) {
      if (!cheapest || item.costPerServing < cheapest.costPerServing) cheapest = item
    }
    for (const item of groupItems) {
      item.isCheapestInGroup = cheapest ? item === cheapest : false
    }
    groups.push({
      key,
      label: key,
      cheapestItemId: cheapest?.id,
      cheapestCostPerServing: cheapest ? cheapest.costPerServing : 0,
      itemCount: groupItems.length,
    })
  }

  return {
    currency,
    items,
    groups,
    warnings,
  }
}

export default {
  calculateCostPerServing,
}

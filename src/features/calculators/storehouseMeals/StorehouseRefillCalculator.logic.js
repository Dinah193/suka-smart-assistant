function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function statusFor({ daysOnHand, minDaysOnHand, maxDaysOnHand, critical }) {
  const minDays = Number.isFinite(minDaysOnHand) ? minDaysOnHand : 0;
  const maxDays = Number.isFinite(maxDaysOnHand) ? maxDaysOnHand : Number.POSITIVE_INFINITY;
  if (daysOnHand > maxDays) return "overstock";
  if (daysOnHand < minDays) return critical ? "critical" : "low";
  return "ok";
}

function roundPurchase(deltaQty, packSize) {
  if (deltaQty <= 0) return 0;
  const pack = toNum(packSize, 0);
  if (pack <= 0) return deltaQty;
  return Math.ceil(deltaQty / pack) * pack;
}

export function calculateStorehouseRefill(config = {}) {
  const horizonDays = Math.max(toNum(config.horizonDays, 30), 0);
  const itemsIn = Array.isArray(config.items)
    ? config.items.filter((x) => x && typeof x === "object")
    : [];

  const items = itemsIn.map((item = {}) => {
    const dailyUse = Math.max(toNum(item.dailyUse, 0), 0);
    const currentQty = Math.max(toNum(item.currentQty, 0), 0);
    const requiredQty = dailyUse * horizonDays;
    const deltaQty = requiredQty - currentQty;
    const daysOnHand = dailyUse > 0 ? currentQty / dailyUse : Number.POSITIVE_INFINITY;
    const purchaseQty = roundPurchase(deltaQty, item.packSize);
    const critical = !!item.critical;
    const status = statusFor({
      daysOnHand,
      minDaysOnHand: toNum(item.minDaysOnHand, 0),
      maxDaysOnHand: toNum(item.maxDaysOnHand, Number.POSITIVE_INFINITY),
      critical,
    });

    return {
      id: item.id,
      name: String(item.name || ""),
      unit: String(item.unit || "unit"),
      dailyUse,
      currentQty,
      requiredQty,
      deltaQty,
      purchaseQty,
      daysOnHand,
      minDaysOnHand: Number.isFinite(item.minDaysOnHand) ? toNum(item.minDaysOnHand) : undefined,
      maxDaysOnHand: Number.isFinite(item.maxDaysOnHand) ? toNum(item.maxDaysOnHand) : undefined,
      status,
      critical,
      notes: [],
    };
  });

  return {
    horizonDays,
    items,
    totals: {
      purchaseUnits: items.reduce((sum, x) => sum + toNum(x.purchaseQty, 0), 0),
      criticalItems: items.filter((x) => x.critical && x.status !== "ok").length,
      lowItems: items.filter((x) => x.status === "low").length,
      overstockedItems: items.filter((x) => x.status === "overstock").length,
    },
    warnings: [],
  };
}

export default {
  calculateStorehouseRefill,
};

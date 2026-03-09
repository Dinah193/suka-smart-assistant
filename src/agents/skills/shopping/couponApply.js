/**
 * couponApply.js
 * ---------------
 * How this fits:
 * - Lives under: src/agents/skills/shopping/couponApply.js
 * - Used by shopping / planning flows (grocery list, cart optimizer, batch cooking, etc.).
 * - Applies coupon + weekly ad logic to a set of line items.
 * - Compares all relevant promos (item-level, category-level, weekly ads, order-level)
 *   and chooses a "best savings" combo according to simple, predictable rules.
 * - Emits SSA events via eventBus and (optionally) exports analytics to the Hub when
 *   familyFundMode is enabled.
 *
 * ABOUT THE “SWAP MODAL”:
 * - This skill DOES NOT render React directly, but returns a `swapOptions` array
 *   for each line item.
 * - Your root-mounted Shopping / SessionRunner UI can feed that into a "Deal Swap"
 *   modal (similar to your price swap modal) that:
 *   • shows "No coupon", "Best auto-apply", and alternative coupon/ad combos,
 *   • can stay open / minimized while the user navigates (because it lives in
 *     a Portal at App root),
 *   • can be resumed from serialized state in Dexie (store the chosen option id).
 * - This file focuses on producing deterministic, serializable data for that modal.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/events/eventBus";
import { familyFundMode } from "../../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";

/**
 * @typedef {Object} ShoppingLineItem
 * @property {string} id
 * @property {string} name
 * @property {number} qty
 * @property {number} unitPrice      - Pre-discount unit price.
 * @property {string} [store]        - Preferred store / chain id (e.g. "kroger", "walmart").
 * @property {string} [upc]
 * @property {string} [sku]
 * @property {string} [category]     - e.g. "dairy", "meat".
 * @property {string[]} [tags]       - e.g. ["organic", "store-brand"].
 */

/**
 * @typedef {"amount"|"percent"|"bogo"} CouponDiscountType
 */

/**
 * @typedef {"item"|"category"|"order"} CouponScope
 */

/**
 * @typedef {"manufacturer"|"store"|"digital"|"weeklyAd"} CouponSource
 */

/**
 * Minimal normalized coupon / promo shape.
 * This is a logical contract; your Dexie schema can be richer.
 *
 * @typedef {Object} CouponRecord
 * @property {string} id
 * @property {CouponSource} source
 * @property {CouponScope} scope
 * @property {{ upc?: string, sku?: string, category?: string, tag?: string, minQty?: number, minSpend?: number }} target
 * @property {{ type: CouponDiscountType, value: number, maxSavings?: number }} discount
 * @property {boolean} [combinable]     - Can stack with other coupons on the same item?
 * @property {string} [stackGroup]      - Coupons sharing a stackGroup cannot stack together.
 * @property {string[]} [stores]        - Store ids where valid; empty/undefined = all stores.
 * @property {string} [description]     - Human-readable marketing copy.
 * @property {string} [clipRequired]    - "manual"|"auto"|undefined
 * @property {string} expiresAt         - ISO timestamp.
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * Swap option for the UI deal selection modal.
 *
 * @typedef {Object} DealSwapOption
 * @property {string} id
 * @property {string} label
 * @property {string} summary
 * @property {number} savings          - Total line savings if this option is chosen.
 * @property {number} finalUnitPrice   - Unit price AFTER discounts.
 * @property {number} finalLineTotal   - Line total AFTER discounts.
 * @property {CouponRecord[]} coupons  - Underlying coupons/promos.
 * @property {boolean} autoSelected    - SSA-chosen best option.
 * @property {boolean} isNoDeal        - The "no coupon" baseline option.
 * @property {string[]} badges         - e.g. ["BEST", "MANUFACTURER", "STACKED"].
 */

/**
 * Result object for a single line item.
 *
 * @typedef {Object} CouponApplyResultItem
 * @property {ShoppingLineItem} item
 * @property {number} baseUnitPrice
 * @property {number} baseLineTotal
 * @property {number} finalUnitPrice
 * @property {number} finalLineTotal
 * @property {number} savings
 * @property {DealSwapOption[]} swapOptions
 * @property {string|null} chosenSwapId
 * @property {string|null} error
 */

/**
 * Options for coupon application.
 *
 * @typedef {Object} CouponApplyOptions
 * @property {string} [eventSource="shopping"]
 * @property {number} [nowTs]             - Milliseconds timestamp; defaults to Date.now().
 * @property {string|null} [preferredStore] - Fallback store if line items omit it.
 * @property {Record<string,string>} [chosenSwapByItemId] - Previously chosen swapId for each line item (for resume).
 */

/**
 * SSA event wrapper.
 * @param {string} type
 * @param {string} source
 * @param {any} data
 */
function emit(type, source, data) {
  try {
    emitEvent({
      type,
      ts: new Date().toISOString(),
      source,
      data,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[couponApply] Failed to emit event:", type, err);
  }
}

/**
 * Safely parse an ISO timestamp and check expiration.
 * @param {string} isoDate
 * @param {number} nowTs
 * @returns {boolean} true if coupon is expired.
 */
function isExpired(isoDate, nowTs) {
  if (!isoDate) return false;
  const t = Date.parse(isoDate);
  if (Number.isNaN(t)) return false;
  return t < nowTs;
}

/**
 * Check store validity for a coupon.
 * @param {CouponRecord} coupon
 * @param {string|null} storeId
 * @returns {boolean}
 */
function isStoreAllowed(coupon, storeId) {
  if (!coupon.stores || coupon.stores.length === 0) return true;
  if (!storeId) return false;
  return coupon.stores.includes(storeId);
}

/**
 * Check whether a coupon "targets" this line item (UPC / SKU / category / tag).
 * @param {CouponRecord} coupon
 * @param {ShoppingLineItem} item
 * @returns {boolean}
 */
function isCouponTargetingItem(coupon, item) {
  const target = coupon.target || {};
  const hasTarget =
    target.upc ||
    target.sku ||
    target.category ||
    target.tag ||
    target.minSpend ||
    target.minQty;

  if (!hasTarget) return true;

  if (
    target.upc &&
    item.upc &&
    String(item.upc).trim() === String(target.upc).trim()
  )
    return true;
  if (
    target.sku &&
    item.sku &&
    String(item.sku).trim() === String(target.sku).trim()
  )
    return true;
  if (target.category && item.category && item.category === target.category)
    return true;
  if (target.tag && Array.isArray(item.tags) && item.tags.includes(target.tag))
    return true;

  // For order-scope coupons (minSpend / minQty) we still treat as eligible here;
  // full order-check will be done in a higher-level skill if needed.
  if (coupon.scope === "order") return true;

  return false;
}

/**
 * Compute savings for a coupon versus a line's base total.
 *
 * NOTE: This is an item-level approximation. For more complex combos, extend the logic
 * or call this from a higher-level "order-level" optimizer.
 *
 * @param {CouponRecord} coupon
 * @param {number} baseUnitPrice
 * @param {number} baseQty
 * @returns {number} savings (>= 0)
 */
function computeCouponSavings(coupon, baseUnitPrice, baseQty) {
  if (!coupon || !coupon.discount) return 0;
  const discount = coupon.discount;
  const baseLineTotal = baseUnitPrice * baseQty;

  if (!Number.isFinite(baseLineTotal) || baseLineTotal <= 0) return 0;

  let savings = 0;

  if (discount.type === "amount") {
    savings = discount.value || 0;
  } else if (discount.type === "percent") {
    const pct = discount.value || 0;
    savings = (pct / 100) * baseLineTotal;
  } else if (discount.type === "bogo") {
    // Simple BOGO: "Buy 1 Get 1" (or N). We assume discount.value = number of items charged (1 for B1G1).
    // Example: baseQty=2, pay for 1. If you pass value=1, we compute savings accordingly.
    const payFor = discount.value || 1;
    if (baseQty > payFor) {
      const freeQty = baseQty - payFor;
      savings = freeQty * baseUnitPrice;
    }
  }

  if (!Number.isFinite(savings) || savings <= 0) return 0;

  if (discount.maxSavings && discount.maxSavings > 0) {
    savings = Math.min(savings, discount.maxSavings);
  }

  // Ensure savings cannot exceed line total.
  return Math.min(savings, baseLineTotal);
}

/**
 * Build the "no deal" baseline option.
 * @param {ShoppingLineItem} item
 * @param {number} baseUnitPrice
 * @param {number} baseLineTotal
 * @returns {DealSwapOption}
 */
function buildNoDealOption(item, baseUnitPrice, baseLineTotal) {
  return {
    id: `none:${item.id}`,
    label: "No coupon / regular price",
    summary: "Pay regular shelf price.",
    savings: 0,
    finalUnitPrice: baseUnitPrice,
    finalLineTotal: baseLineTotal,
    coupons: [],
    autoSelected: false,
    isNoDeal: true,
    badges: ["BASELINE"],
  };
}

/**
 * Build individual coupon options (one coupon at a time).
 * @param {ShoppingLineItem} item
 * @param {number} baseUnitPrice
 * @param {number} baseLineTotal
 * @param {CouponRecord[]} coupons
 * @returns {DealSwapOption[]}
 */
function buildSingleCouponOptions(item, baseUnitPrice, baseLineTotal, coupons) {
  const qty = item.qty || 1;

  return coupons.map((coupon) => {
    const savings = computeCouponSavings(coupon, baseUnitPrice, qty);
    const finalLineTotal = Math.max(baseLineTotal - savings, 0);
    const finalUnitPrice = qty > 0 ? finalLineTotal / qty : baseUnitPrice;

    /** @type {string[]} */
    const badges = [];
    if (coupon.source) {
      badges.push(coupon.source.toUpperCase());
    }
    if (coupon.scope === "category") badges.push("CATEGORY");
    if (coupon.scope === "order") badges.push("ORDER");
    if (coupon.stackGroup) badges.push("STACK-LIMIT");

    const label = coupon.description || `Apply ${coupon.source} coupon`;
    const summary = `${label} → Save $${savings.toFixed(2)} on this line.`;

    return /** @type {DealSwapOption} */ ({
      id: coupon.id,
      label,
      summary,
      savings,
      finalUnitPrice,
      finalLineTotal,
      coupons: [coupon],
      autoSelected: false,
      isNoDeal: false,
      badges,
    });
  });
}

/**
 * Build "stacked" options where combinable coupons are allowed.
 * Assumption: max 2 stacked coupons per line item (to keep search small).
 *
 * @param {ShoppingLineItem} item
 * @param {number} baseUnitPrice
 * @param {number} baseLineTotal
 * @param {CouponRecord[]} coupons
 * @returns {DealSwapOption[]}
 */
function buildStackedCouponOptions(
  item,
  baseUnitPrice,
  baseLineTotal,
  coupons
) {
  const combinable = coupons.filter((c) => c.combinable !== false);
  if (combinable.length < 2) return [];

  const qty = item.qty || 1;
  /** @type {DealSwapOption[]} */
  const options = [];

  for (let i = 0; i < combinable.length; i += 1) {
    for (let j = i + 1; j < combinable.length; j += 1) {
      const a = combinable[i];
      const b = combinable[j];

      if (a.stackGroup && b.stackGroup && a.stackGroup === b.stackGroup) {
        continue; // cannot stack same-group coupons
      }

      // For simplicity, apply savings in sequence but cap at baseLineTotal.
      const savingsA = computeCouponSavings(a, baseUnitPrice, qty);
      const remainingAfterA = Math.max(baseLineTotal - savingsA, 0);
      const effectiveUnitAfterA =
        qty > 0 ? remainingAfterA / qty : baseUnitPrice;
      const savingsB = computeCouponSavings(b, effectiveUnitAfterA, qty);
      let totalSavings = savingsA + savingsB;
      if (totalSavings > baseLineTotal) totalSavings = baseLineTotal;

      const finalLineTotal = Math.max(baseLineTotal - totalSavings, 0);
      const finalUnitPrice = qty > 0 ? finalLineTotal / qty : baseUnitPrice;

      /** @type {string[]} */
      const badges = ["STACKED"];
      if (a.source !== b.source) badges.push("MIXED-SOURCE");

      const label =
        (a.description || "Coupon A") + " + " + (b.description || "Coupon B");
      const summary = `${label} → Stack to save $${totalSavings.toFixed(
        2
      )} on this line.`;

      options.push({
        id: `${a.id}+${b.id}`,
        label,
        summary,
        savings: totalSavings,
        finalUnitPrice,
        finalLineTotal,
        coupons: [a, b],
        autoSelected: false,
        isNoDeal: false,
        badges,
      });
    }
  }

  return options;
}

/**
 * Choose the best auto-selected option:
 * - highest savings
 * - tie-breaker: fewer coupons, then manufacturer > store > weeklyAd > digital.
 *
 * @param {DealSwapOption[]} options
 * @returns {DealSwapOption[]}
 */
function markBestOption(options) {
  if (!options.length) return options;

  let bestIdx = 0;
  let bestScore = -Infinity;

  function sourcePriority(c) {
    switch (c.source) {
      case "manufacturer":
        return 3;
      case "store":
        return 2;
      case "weeklyAd":
        return 1;
      case "digital":
      default:
        return 0;
    }
  }

  options.forEach((opt, idx) => {
    const savings = opt.savings || 0;
    const couponCount = opt.coupons?.length || 0;
    const maxSourcePriority = Math.max(
      0,
      ...(opt.coupons || []).map(sourcePriority)
    );
    // High savings, fewer coupons, higher source priority.
    const score = savings * 100 - couponCount * 10 + maxSourcePriority;
    if (score > bestScore) {
      bestIdx = idx;
      bestScore = score;
    }
  });

  return options.map((opt, idx) => ({
    ...opt,
    autoSelected: idx === bestIdx && !opt.isNoDeal && opt.savings > 0,
  }));
}

/**
 * Fetch all potentially relevant coupons/promos from Dexie.
 * Assumes two tables: db.coupons and db.weeklyAds.
 * If your schema is different, adapt this query but keep the return shape as CouponRecord[].
 *
 * @param {number} nowTs
 * @returns {Promise<CouponRecord[]>}
 */
async function fetchActiveCoupons(nowTs) {
  const coupons = [];
  try {
    if (db && db.coupons && db.coupons.toArray) {
      const allCoupons = await db.coupons.toArray();
      for (const c of allCoupons) {
        if (!isExpired(c.expiresAt, nowTs)) coupons.push(c);
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[couponApply] Failed to read db.coupons:", err);
  }

  try {
    if (db && db.weeklyAds && db.weeklyAds.toArray) {
      const weeklyAds = await db.weeklyAds.toArray();
      for (const ad of weeklyAds) {
        if (!isExpired(ad.expiresAt, nowTs)) {
          coupons.push({
            ...ad,
            source: "weeklyAd",
          });
        }
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[couponApply] Failed to read db.weeklyAds:", err);
  }

  return coupons;
}

/**
 * Filter coupons that can apply to a specific line item.
 * @param {CouponRecord[]} coupons
 * @param {ShoppingLineItem} item
 * @param {string|null} storeId
 * @returns {CouponRecord[]}
 */
function filterCouponsForItem(coupons, item, storeId) {
  return coupons.filter((coupon) => {
    if (!isStoreAllowed(coupon, storeId)) return false;
    if (!isCouponTargetingItem(coupon, item)) return false;

    const target = coupon.target || {};
    if (typeof target.minQty === "number" && item.qty < target.minQty) {
      return false;
    }
    // Order-level minSpend handled by higher-level logic.
    return true;
  });
}

/**
 * Export coupon application to Hub, if enabled.
 * @param {CouponApplyResultItem[]} items
 * @param {string} eventSource
 */
async function exportCouponApplicationToHub(items, eventSource) {
  if (!familyFundMode || !items || !items.length) return;
  try {
    const payload = HubPacketFormatter.formatCouponApplication(items, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });
    await FamilyFundConnector.send(payload);
    emit("coupon.apply.exported", eventSource, { count: items.length });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[couponApply] Hub export failed (soft):", err);
  }
}

/**
 * Public API:
 * Apply coupon + weekly ad logic to a list of line items.
 *
 * Emits:
 * - coupon.apply.requested
 * - coupon.apply.completed
 * - coupon.swapOptions.built (per item)
 * - coupon.apply.exported (on successful Hub export)
 *
 * @param {ShoppingLineItem[]} lineItems
 * @param {CouponApplyOptions} [options]
 * @returns {Promise<{ items: CouponApplyResultItem[], totals: { baseSubtotal: number, finalSubtotal: number, totalSavings: number }, meta: { count: number, errors: number } }>}
 */
export async function applyCouponsAndAds(lineItems, options = {}) {
  const {
    eventSource = "shopping",
    nowTs = Date.now(),
    preferredStore = null,
    chosenSwapByItemId = {},
  } = options;

  const safeItems = Array.isArray(lineItems) ? lineItems : [];

  emit("coupon.apply.requested", eventSource, {
    count: safeItems.length,
  });

  const allCoupons = await fetchActiveCoupons(nowTs);

  /** @type {CouponApplyResultItem[]} */
  const results = [];
  let baseSubtotal = 0;
  let finalSubtotal = 0;
  let errorCount = 0;

  for (const item of safeItems) {
    const baseUnitPrice = Number(item.unitPrice) || 0;
    const qty = Number(item.qty) || 0;
    const baseLineTotal = baseUnitPrice * qty;
    baseSubtotal += baseLineTotal;

    /** @type {CouponApplyResultItem} */
    const result = {
      item,
      baseUnitPrice,
      baseLineTotal,
      finalUnitPrice: baseUnitPrice,
      finalLineTotal: baseLineTotal,
      savings: 0,
      swapOptions: [],
      chosenSwapId: null,
      error: null,
    };

    try {
      const storeId = item.store || preferredStore;
      const eligible = filterCouponsForItem(allCoupons, item, storeId);
      const noDeal = buildNoDealOption(item, baseUnitPrice, baseLineTotal);
      const singleOptions = buildSingleCouponOptions(
        item,
        baseUnitPrice,
        baseLineTotal,
        eligible
      );
      const stackedOptions = buildStackedCouponOptions(
        item,
        baseUnitPrice,
        baseLineTotal,
        eligible
      );

      let swapOptions = [noDeal, ...singleOptions, ...stackedOptions];
      swapOptions = markBestOption(swapOptions);

      // Respect previously chosen swap (resume flow), if present and still valid.
      const chosenId =
        chosenSwapByItemId && chosenSwapByItemId[item.id]
          ? chosenSwapByItemId[item.id]
          : null;

      let chosen =
        (chosenId && swapOptions.find((opt) => opt.id === chosenId)) ||
        swapOptions.find((opt) => opt.autoSelected) ||
        noDeal;

      result.swapOptions = swapOptions;
      result.chosenSwapId = chosen.id;
      result.savings = chosen.savings;
      result.finalLineTotal = chosen.finalLineTotal;
      result.finalUnitPrice = chosen.finalUnitPrice;

      finalSubtotal += chosen.finalLineTotal;

      emit("coupon.swapOptions.built", eventSource, {
        itemId: item.id,
        optionsCount: swapOptions.length,
        autoSelectedId: swapOptions.find((o) => o.autoSelected)?.id || null,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        "[couponApply] Error computing coupons for item:",
        item,
        err
      );
      result.error = err?.message || String(err);
      errorCount += 1;
      // fallback: no-deal baseline already set.
      finalSubtotal += baseLineTotal;
    }

    results.push(result);
  }

  const totalSavings = baseSubtotal - finalSubtotal;

  emit("coupon.apply.completed", eventSource, {
    count: results.length,
    baseSubtotal,
    finalSubtotal,
    totalSavings,
    errors: errorCount,
  });

  // Fire-and-forget Hub export
  exportCouponApplicationToHub(results, eventSource).catch(() => {});

  return {
    items: results,
    totals: {
      baseSubtotal,
      finalSubtotal,
      totalSavings,
    },
    meta: {
      count: results.length,
      errors: errorCount,
    },
  };
}

/**
 * Helper:
 * Get the best deal for a single line item (cheapest by our scoring).
 *
 * @param {ShoppingLineItem} item
 * @param {CouponApplyOptions} [options]
 * @returns {Promise<{ item: CouponApplyResultItem|null, swapOptions: DealSwapOption[] }>}
 */
export async function getBestDealForItem(item, options = {}) {
  const { items } = await applyCouponsAndAds([item], options);
  const result = items[0] || null;
  return {
    item: result,
    swapOptions: result ? result.swapOptions : [],
  };
}

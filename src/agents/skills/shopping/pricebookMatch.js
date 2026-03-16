/**
 * pricebookMatch.js
 * ------------------
 * How this fits:
 * - Lives under: src/agents/skills/shopping/pricebookMatch.js
 * - Used by shopping / planning flows (grocery list, batch cooking, inventory shortage, etc.)
 * - Compares normalized items against the local Dexie-backed pricebook.
 * - When entries are missing or stale, it triggers a scrape job and upserts fresh entries.
 * - Emits SSA events via eventBus and (optionally) exports analytics to the Hub when familyFundMode is enabled.
 *
 * NOTE ABOUT THE “SWAP MODAL”:
 * - This file does NOT render UI, but it prepares structured `swapOptions` data that your
 *   SessionRunner / Shopping UI can feed into a “swap modal” (brand/size/store swap dialog).
 * - The modal can subscribe to the same events and keep running while the user navigates
 *   away, because it lives at the app root (e.g., <Portal /> in App.jsx) and uses the
 *   results from this skill as its backing data.
 */

import { db } from "../../../services/db";
import { emitEvent } from "../../../services/events/eventBus";
import { familyFundMode } from "../../../config/featureFlags";
import { HubPacketFormatter } from "@/services/hub/HubPacketFormatter";
import { FamilyFundConnector } from "@/services/hub/FamilyFundConnector";
// If you already have a ScraperEngine or PricebookScraper service, wire it here.
import { ScraperEngine } from "../../../services/scraper/ScraperEngine"; // <-- stub/assumed

/**
 * @typedef {Object} PriceQuote
 * @property {string} source        - Store or site (e.g., "Walmart", "Kroger", "Instacart")
 * @property {string} currency      - ISO currency (e.g., "USD")
 * @property {number} unitPrice     - Price per normalized unit (e.g., per oz, per lb)
 * @property {number} [totalPrice]  - Total price for the package if known
 * @property {string} [size]        - Human-readable package size (e.g., "16 oz", "1 lb")
 * @property {string} [url]         - URL to product page (if online)
 * @property {string} collectedAt   - ISO-8601 timestamp when price was collected
 */

/**
 * @typedef {Object} PricebookEntry
 * @property {string} id
 * @property {string} lookupKey
 * @property {string} name
 * @property {string} [upc]
 * @property {string} [sku]
 * @property {string} [brand]
 * @property {string} [category]
 * @property {string} lastCheckedAt     - ISO-8601 timestamp
 * @property {PriceQuote[]} prices
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/**
 * @typedef {Object} ShoppingItem
 * @property {string} id
 * @property {string} name
 * @property {string} [brand]
 * @property {string} [upc]
 * @property {string} [sku]
 * @property {string} [category]
 * @property {string} [size]        - e.g., "16 oz", "1 lb"
 * @property {number} [qty]         - how many units requested
 */

/**
 * @typedef {Object} SwapOption
 * @property {string} id
 * @property {string} label
 * @property {number|null} unitPrice
 * @property {number|null} totalPrice
 * @property {string} source
 * @property {string|null} size
 * @property {string|null} url
 * @property {boolean} isCheapest
 * @property {string[]} badges    - e.g., ["PANTRY", "LOCAL BEST", "ONLINE"]
 */

/**
 * @typedef {Object} PricebookMatchResult
 * @property {ShoppingItem} item
 * @property {string} lookupKey
 * @property {PricebookEntry|null} entry
 * @property {boolean} stale
 * @property {boolean} scraped
 * @property {SwapOption[]} swapOptions
 * @property {string|null} error
 */

/**
 * @typedef {Object} MatchOptions
 * @property {boolean} [scrapeIfStale=true]      - Whether to trigger scraping when stale/missing.
 * @property {number} [staleAfterHours=24]       - Consider entries older than this as stale.
 * @property {string} [eventSource="shopping"]   - Source string for eventBus.
 * @property {Object} [scrapeContext]            - Extra info for ScraperEngine (e.g., geo, store prefs).
 */

/**
 * Emit a structured SSA event via the central eventBus.
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
    // Never kill caller because eventBus failed.
    // eslint-disable-next-line no-console
    console.error("[pricebookMatch] Failed to emit event:", type, err);
  }
}

/**
 * Determine how stale a PricebookEntry is.
 * @param {PricebookEntry|null|undefined} entry
 * @param {number} staleAfterMs
 * @returns {boolean}
 */
function isEntryStale(entry, staleAfterMs) {
  if (!entry || !entry.lastCheckedAt) return true;
  const last = Date.parse(entry.lastCheckedAt);
  if (Number.isNaN(last)) return true;
  const age = Date.now() - last;
  if (age > staleAfterMs) return true;
  // Also treat entries with no prices as stale.
  if (!Array.isArray(entry.prices) || entry.prices.length === 0) return true;
  return false;
}

/**
 * Build a deterministic lookup key for a ShoppingItem.
 * Prefer UPC/SKU; fall back to normalized name+size.
 * @param {ShoppingItem} item
 * @returns {string}
 */
function buildLookupKey(item) {
  if (!item || typeof item !== "object") return "unknown:missing-item";
  if (item.upc) return `upc:${String(item.upc).trim()}`;
  if (item.sku) return `sku:${String(item.sku).trim()}`;
  const baseName = (item.brand ? `${item.brand} ` : "") + (item.name || "");
  const normalizedName = baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
  const size = (item.size || "").toLowerCase().replace(/\s+/g, "");
  return `name:${normalizedName}${size ? `:${size}` : ""}`;
}

/**
 * Try to find a local PricebookEntry in Dexie.
 * This assumes your Dexie schema has a `pricebook` table and an index on `lookupKey`.
 * @param {ShoppingItem} item
 * @param {string} lookupKey
 * @returns {Promise<PricebookEntry|null>}
 */
async function findLocalEntry(item, lookupKey) {
  if (!db || !db.pricebook) {
    // eslint-disable-next-line no-console
    console.warn(
      "[pricebookMatch] db.pricebook missing; returning null entry."
    );
    return null;
  }

  try {
    // If you have specific indices (e.g., upc, sku, lookupKey), prefer them here.
    if (item.upc && db.pricebook.where) {
      const byUpc = await db.pricebook.where("upc").equals(item.upc).first();
      if (byUpc) return byUpc;
    }

    if (item.sku && db.pricebook.where) {
      const bySku = await db.pricebook.where("sku").equals(item.sku).first();
      if (bySku) return bySku;
    }

    if (db.pricebook.where) {
      const byLookup = await db.pricebook
        .where("lookupKey")
        .equals(lookupKey)
        .first();
      if (byLookup) return byLookup;
    }

    // Fallback: naive search by name if your schema doesn't have the indices yet.
    if (db.pricebook.toArray) {
      const all = await db.pricebook.toArray();
      const lowerName = (
        (item.name || "") +
        " " +
        (item.brand || "")
      ).toLowerCase();
      const candidate =
        all.find((entry) =>
          String(entry.name || "")
            .toLowerCase()
            .includes(lowerName)
        ) || null;
      return candidate;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[pricebookMatch] Error querying local pricebook:", err);
    return null;
  }

  return null;
}

/**
 * Normalize raw quotes into PriceQuote[].
 * @param {any[]} rawQuotes
 * @returns {PriceQuote[]}
 */
function normalizeQuotes(rawQuotes) {
  if (!Array.isArray(rawQuotes)) return [];

  const nowIso = new Date().toISOString();

  return rawQuotes
    .map((q, idx) => {
      if (!q) return null;
      const unitPrice = Number(q.unitPrice ?? q.price ?? NaN);
      if (!Number.isFinite(unitPrice)) return null;

      return {
        source: String(q.source || q.store || `unknown-${idx}`),
        currency: String(q.currency || "USD"),
        unitPrice,
        totalPrice: q.totalPrice != null ? Number(q.totalPrice) : null,
        size: q.size != null ? String(q.size) : null,
        url: q.url != null ? String(q.url) : null,
        collectedAt: q.collectedAt ? String(q.collectedAt) : nowIso,
      };
    })
    .filter(Boolean);
}

/**
 * Run scraping for an item and upsert into pricebook.
 * Emits:
 * - pricebook.scrape.requested
 * - pricebook.scrape.completed
 *
 * @param {ShoppingItem} item
 * @param {string} lookupKey
 * @param {string} eventSource
 * @param {Object} [scrapeContext]
 * @param {PricebookEntry|null} [existing]
 * @returns {Promise<PricebookEntry|null>}
 */
async function scrapeAndUpsert(
  item,
  lookupKey,
  eventSource,
  scrapeContext = {},
  existing = null
) {
  emit("pricebook.scrape.requested", eventSource, {
    item,
    lookupKey,
    scrapeContext,
  });

  let quotes = [];
  try {
    // Assumes ScraperEngine has a method like this. Adapt to your actual API.
    // Expected return: { quotes: [...] }
    const result = await ScraperEngine.fetchPriceQuotes({
      item,
      lookupKey,
      context: scrapeContext,
    });

    quotes = normalizeQuotes(result && result.quotes);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[pricebookMatch] ScraperEngine.fetchPriceQuotes failed:",
      err
    );
    emit("pricebook.scrape.failed", eventSource, {
      item,
      lookupKey,
      error: err?.message || String(err),
    });
    return existing || null;
  }

  if (!quotes.length) {
    emit("pricebook.scrape.completed", eventSource, {
      item,
      lookupKey,
      quotes: [],
      warning: "No quotes returned.",
    });
    return existing || null;
  }

  const now = new Date().toISOString();
  /** @type {PricebookEntry} */
  const entry = {
    id: existing?.id || `pb_${lookupKey}_${Date.now()}`,
    lookupKey,
    name: existing?.name || item.name || "Unknown item",
    upc: existing?.upc || item.upc || null,
    sku: existing?.sku || item.sku || null,
    brand: existing?.brand || item.brand || null,
    category: existing?.category || item.category || null,
    lastCheckedAt: now,
    prices: quotes,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  try {
    if (!db || !db.pricebook || !db.pricebook.put) {
      // eslint-disable-next-line no-console
      console.warn(
        "[pricebookMatch] db.pricebook.put not available; skipping upsert."
      );
    } else {
      await db.pricebook.put(entry);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[pricebookMatch] Failed to upsert pricebook entry:", err);
  }

  emit("pricebook.scrape.completed", eventSource, {
    item,
    lookupKey,
    quotes,
  });

  return entry;
}

/**
 * Build swap options for UI (swap modal) from a PricebookEntry.
 * The caller can render a list or grid from these.
 * @param {ShoppingItem} item
 * @param {PricebookEntry|null} entry
 * @returns {SwapOption[]}
 */
function buildSwapOptions(item, entry) {
  if (!entry || !Array.isArray(entry.prices) || entry.prices.length === 0)
    return [];

  const qty = Number.isFinite(item?.qty) && item.qty > 0 ? item.qty : 1;

  const options = entry.prices.map((quote, index) => {
    const totalPrice =
      quote.totalPrice != null
        ? Number(quote.totalPrice)
        : Number.isFinite(quote.unitPrice)
        ? quote.unitPrice * qty
        : null;

    const labelParts = [];
    if (entry.brand) labelParts.push(entry.brand);
    labelParts.push(entry.name);
    if (quote.size) labelParts.push(`(${quote.size})`);
    labelParts.push(`@ ${quote.source}`);

    /** @type {string[]} */
    const badges = [];
    // You can refine this logic (e.g. "LOCAL", "DELIVERY", etc.)
    badges.push("PRICEBOOK");
    if (quote.url) badges.push("ONLINE");

    return {
      id: `${entry.id}:${index}`,
      label: labelParts.join(" "),
      unitPrice: Number.isFinite(quote.unitPrice) ? quote.unitPrice : null,
      totalPrice,
      source: quote.source,
      size: quote.size || null,
      url: quote.url || null,
      isCheapest: false, // set below after computing best
      badges,
    };
  });

  // Determine cheapest option (by unitPrice, then totalPrice fallback).
  let cheapestIndex = -1;
  let cheapestValue = Infinity;

  options.forEach((opt, idx) => {
    const candidate =
      Number.isFinite(opt.unitPrice) && opt.unitPrice > 0
        ? opt.unitPrice
        : Number.isFinite(opt.totalPrice) && opt.totalPrice > 0
        ? opt.totalPrice
        : Infinity;

    if (candidate < cheapestValue) {
      cheapestValue = candidate;
      cheapestIndex = idx;
    }
  });

  if (cheapestIndex >= 0) {
    options[cheapestIndex].isCheapest = true;
    options[cheapestIndex].badges.push("BEST");
  }

  return options;
}

/**
 * Export match analytics to the Hub if familyFundMode is enabled.
 * Fail silently if anything goes wrong.
 * @param {PricebookMatchResult[]} results
 * @param {string} eventSource
 */
async function exportMatchesToHub(results, eventSource) {
  if (!familyFundMode || !Array.isArray(results) || results.length === 0)
    return;

  try {
    const payload = HubPacketFormatter.formatPricebookMatch(results, {
      source: eventSource,
      exportedAt: new Date().toISOString(),
    });

    await FamilyFundConnector.send(payload);

    emit("pricebook.match.exported", eventSource, {
      count: results.length,
    });
  } catch (err) {
    // Soft failure only; do not throw.
    // eslint-disable-next-line no-console
    console.warn("[pricebookMatch] Failed to export matches to Hub:", err);
  }
}

/**
 * Public API:
 * Match items against the local pricebook, scrape if stale, and return structured results.
 *
 * This is what your Shopping / SessionRunner logic will call.
 *
 * Emits:
 * - pricebook.match.requested
 * - pricebook.match.completed
 *
 * Optionally emits:
 * - pricebook.scrape.requested / .completed / .failed (per item)
 * - pricebook.match.exported (on successful Hub export)
 *
 * @param {ShoppingItem[]} items
 * @param {MatchOptions} [options]
 * @returns {Promise<{ results: PricebookMatchResult[], meta: { total: number, stale: number, scraped: number, errors: number } }>}
 */
export async function matchAgainstPricebook(items, options = {}) {
  const {
    scrapeIfStale = true,
    staleAfterHours = 24,
    eventSource = "shopping",
    scrapeContext = {},
  } = options;

  const safeItems = Array.isArray(items) ? items : [];
  const staleAfterMs = staleAfterHours * 60 * 60 * 1000;

  emit("pricebook.match.requested", eventSource, {
    count: safeItems.length,
  });

  /** @type {PricebookMatchResult[]} */
  const results = [];

  let staleCount = 0;
  let scrapedCount = 0;
  let errorCount = 0;

  for (const item of safeItems) {
    const lookupKey = buildLookupKey(item);
    /** @type {PricebookEntry|null} */
    let entry = null;
    /** @type {PricebookMatchResult} */
    let result = {
      item,
      lookupKey,
      entry: null,
      stale: true,
      scraped: false,
      swapOptions: [],
      error: null,
    };

    try {
      const localEntry = await findLocalEntry(item, lookupKey);
      const stale = isEntryStale(localEntry, staleAfterMs);
      result.stale = stale;
      entry = localEntry;
      if (stale) staleCount += 1;

      if (stale && scrapeIfStale) {
        const fresh = await scrapeAndUpsert(
          item,
          lookupKey,
          eventSource,
          scrapeContext,
          localEntry
        );
        if (fresh) {
          entry = fresh;
          result.scraped = true;
          scrapedCount += 1;
        }
      }

      result.entry = entry;
      result.swapOptions = buildSwapOptions(item, entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[pricebookMatch] Error during match for item:", item, err);
      result.error = err?.message || String(err);
      errorCount += 1;
    }

    results.push(result);
  }

  emit("pricebook.match.completed", eventSource, {
    total: results.length,
    stale: staleCount,
    scraped: scrapedCount,
    errors: errorCount,
  });

  // Optional Hub export (non-blocking).
  exportMatchesToHub(results, eventSource).catch(() => {
    // Silently ignore; internal logging already handled.
  });

  return {
    results,
    meta: {
      total: results.length,
      stale: staleCount,
      scraped: scrapedCount,
      errors: errorCount,
    },
  };
}

/**
 * Convenience helper:
 * For a single item, return the best (cheapest) SwapOption, or null if none.
 *
 * @param {ShoppingItem} item
 * @param {MatchOptions} [options]
 * @returns {Promise<{ option: SwapOption|null, match: PricebookMatchResult|null }>}
 */
export async function getBestPriceOptionForItem(item, options = {}) {
  const { results } = await matchAgainstPricebook([item], options);
  const match = results[0] || null;
  if (
    !match ||
    !Array.isArray(match.swapOptions) ||
    match.swapOptions.length === 0
  ) {
    return { option: null, match };
  }

  const best =
    match.swapOptions.find((opt) => opt.isCheapest) || match.swapOptions[0];
  return { option: best, match };
}

// File: src/features/shopping/services/ReceiptCommitService.js
// SSA — Shopping: ReceiptCommitService
// Production-ready, defensive, Dexie-optional, schema-flexible.
//
// Goal
// - Take a receipt (artifact/receipt record) + optional shopping scan candidates
// - Produce "commit" outputs:
//   1) Inventory transactions (adds to household inventory)
//   2) Pricebook entries (store-specific prices)
//   3) Candidate reconciliation (mark candidates matched/committed)
//   4) Audit trail / events
//
// Important constraints
// - This file MUST NOT crash if certain tables are missing.
// - It MUST work even if you only have artifacts/parsed_candidates tables today.
// - It MUST emit events if eventBus exists.
//
// Expected (optional) tables (best-effort):
// - receipts OR artifacts (receipt storage)
// - shopping_candidates OR sct_candidates OR parsed_candidates (scan candidates)
// - inventory_items, inventory_txns (inventory)
// - pricebook_items, pricebook_prices OR pricebook (price history)
// - commit_log (optional)
//
// If your repo uses different names, this service still runs and returns a structured commit report.

import { db as defaultDb } from "@/services/db"; // adjust if your db export differs
import { eventBus as defaultEventBus } from "@/services/eventBus"; // adjust if your event bus export differs

const EVT = {
  START: "shopping.receipt.commit.started",
  DONE: "shopping.receipt.commit.completed",
  FAIL: "shopping.receipt.commit.failed",
  WARN: "shopping.receipt.commit.warn",

  INVENTORY_TXN: "inventory.txn.created",
  PRICEBOOK_UPSERT: "pricebook.upserted",
  CANDIDATE_MATCHED: "shopping.candidate.matched",
  CANDIDATE_UNMATCHED: "shopping.candidate.unmatched",
};

const DEFAULTS = {
  currency: "USD",
  match: {
    // how strict should matching be
    barcodeWeight: 10,
    nameWeight: 4,
    brandWeight: 2,
    sizeWeight: 2,
    minScore: 8,
  },
  // if true, create inventory items even if unknown
  allowCreateInventoryItem: true,
  // if true, write pricebook
  enablePricebook: true,
  // if true, write inventory txns
  enableInventory: true,
};

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix = "rcpt") {
  const r = Math.random().toString(16).slice(2);
  return `${prefix}_${Date.now().toString(36)}_${r}`;
}

function isFn(x) {
  return typeof x === "function";
}

function safeEmit(bus, type, payload) {
  try {
    if (bus && isFn(bus.emit)) bus.emit(type, payload);
  } catch {
    // never throw from emit
  }
}

function createLogger(userLogger) {
  const base = userLogger && typeof userLogger === "object" ? userLogger : null;
  const pick = (k) =>
    base && isFn(base[k]) ? base[k].bind(base) : console[k].bind(console);
  return {
    debug: pick("debug"),
    info: pick("info"),
    warn: pick("warn"),
    error: pick("error"),
  };
}

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeBarcode(x) {
  const s = String(x || "").trim();
  if (!s) return null;
  return s.replace(/\D+/g, "");
}

function normalizeMoney(n) {
  if (n == null || n === "") return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function normalizeQty(q) {
  if (q == null || q === "") return 1;
  const v = Number(q);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function normalizeUnit(u) {
  const s = String(u || "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  // minimal normalization; extend as needed
  const map = {
    ounce: "oz",
    ounces: "oz",
    oz: "oz",
    pound: "lb",
    pounds: "lb",
    lb: "lb",
    lbs: "lb",
    gram: "g",
    grams: "g",
    g: "g",
    kilogram: "kg",
    kilograms: "kg",
    kg: "kg",
    liter: "l",
    liters: "l",
    l: "l",
    milliliter: "ml",
    milliliters: "ml",
    ml: "ml",
    count: "ct",
    ct: "ct",
    each: "ea",
    ea: "ea",
  };
  return map[s] || s;
}

/**
 * Try to parse a common "size" string into { amount, unit }.
 * Examples:
 *  - "16 oz" -> 16, oz
 *  - "2 lb" -> 2, lb
 *  - "500g" -> 500, g
 */
function parseSize(sizeStr) {
  const s = String(sizeStr || "")
    .trim()
    .toLowerCase();
  if (!s) return { amount: null, unit: null, raw: null };

  const m = s.match(/(\d+(?:\.\d+)?)\s*([a-z]+)/i);
  if (!m) return { amount: null, unit: null, raw: s };

  const amount = Number(m[1]);
  const unit = normalizeUnit(m[2]);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    unit: unit || null,
    raw: s,
  };
}

/**
 * Dexie-safe table resolver.
 * Returns { name, table } or null if not present.
 */
function resolveTable(db, candidateNames = []) {
  if (!db) return null;

  try {
    const names = new Set((db.tables || []).map((t) => t.name));
    for (const n of candidateNames) {
      if (names.has(n) && db[n]) return { name: n, table: db[n] };
    }
  } catch {
    // ignore
  }

  return null;
}

async function safeGetById(tableRef, id) {
  if (!tableRef?.table || !id) return null;
  try {
    return (await tableRef.table.get(id)) || null;
  } catch {
    return null;
  }
}

async function safePut(tableRef, obj) {
  if (!tableRef?.table) return null;
  try {
    await tableRef.table.put(obj);
    return obj;
  } catch {
    return null;
  }
}

async function safeBulkPut(tableRef, objs) {
  if (!tableRef?.table) return { ok: false, count: 0 };
  try {
    if (isFn(tableRef.table.bulkPut)) {
      await tableRef.table.bulkPut(objs);
      return { ok: true, count: objs.length };
    }
    // fallback: sequential puts
    for (const o of objs) {
      // eslint-disable-next-line no-await-in-loop
      await tableRef.table.put(o);
    }
    return { ok: true, count: objs.length };
  } catch {
    return { ok: false, count: 0 };
  }
}

async function safeWhereEqualsToArray(tableRef, field, value) {
  if (!tableRef?.table) return null;
  try {
    if (isFn(tableRef.table.where)) {
      return await tableRef.table.where(field).equals(value).toArray();
    }
    if (isFn(tableRef.table.toArray)) {
      const all = await tableRef.table.toArray();
      return (all || []).filter((x) => x && x[field] === value);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Receipt line normalization
 * Supports flexible shapes:
 * - receipt.parsed.lines
 * - receipt.lines
 * - receipt.parsed.items
 * - receipt.items
 */
function extractReceiptLines(receipt) {
  const candidates = [
    receipt?.parsed?.lines,
    receipt?.parsed?.items,
    receipt?.lines,
    receipt?.items,
    receipt?.parsed,
  ].filter(Boolean);

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  // sometimes parsed is an object with lines prop nested deeper
  if (receipt?.parsed && typeof receipt.parsed === "object") {
    const maybe =
      receipt.parsed.lineItems ||
      receipt.parsed.line_items ||
      receipt.parsed.products;
    if (Array.isArray(maybe)) return maybe;
  }

  return [];
}

/**
 * Normalize a receipt line into a stable shape used by the commit process.
 */
function normalizeReceiptLine(line, defaults = {}) {
  const raw = line || {};

  const barcode =
    normalizeBarcode(raw.barcode) ||
    normalizeBarcode(raw.upc) ||
    normalizeBarcode(raw.ean) ||
    normalizeBarcode(raw.gtin);

  const name =
    raw.name || raw.title || raw.description || raw.item || raw.product || null;
  const brand = raw.brand || null;

  const qty = normalizeQty(raw.qty ?? raw.quantity ?? raw.count ?? 1);

  // unit price / total
  const unitPrice = normalizeMoney(
    raw.unitPrice ??
      raw.unit_price ??
      raw.price_each ??
      raw.pricePerUnit ??
      raw.price
  );
  const lineTotal = normalizeMoney(
    raw.lineTotal ?? raw.line_total ?? raw.total ?? raw.extended ?? null
  );

  const currency = raw.currency || defaults.currency || DEFAULTS.currency;

  // size
  const sizeRaw =
    raw.size ||
    raw.sizeText ||
    raw.packageSize ||
    raw.netWeight ||
    raw.weight ||
    null;
  const sizeParsed = parseSize(sizeRaw);

  return {
    id: raw.id || makeId("line"),
    barcode,
    name,
    brand,
    qty,
    unitPrice,
    lineTotal,
    currency,
    size: {
      amount: sizeParsed.amount,
      unit: sizeParsed.unit,
      raw: sizeParsed.raw || (sizeRaw ? String(sizeRaw) : null),
    },
    category: raw.category || null,
    raw,
  };
}

/**
 * Candidate normalization (from shopping scan)
 */
function normalizeCandidate(c) {
  const raw = c || {};
  const barcode = normalizeBarcode(
    raw.barcode || raw.upc || raw.gtin || raw.ean
  );
  const name = raw.name || raw.title || raw.description || null;
  const brand = raw.brand || null;

  const sizeRaw =
    raw.size ||
    raw.sizeText ||
    raw.packageSize ||
    raw.netWeight ||
    raw.weight ||
    null;
  const sizeParsed = parseSize(sizeRaw);

  return {
    id: raw.id || makeId("cand"),
    sessionId: raw.sessionId || null,
    householdId: raw.householdId || null,
    userId: raw.userId || null,
    barcode,
    name,
    brand,
    qty: normalizeQty(raw.qty ?? 1),
    unit: normalizeUnit(raw.unit || raw.uom || null),
    size: {
      amount: sizeParsed.amount,
      unit: sizeParsed.unit,
      raw: sizeParsed.raw || (sizeRaw ? String(sizeRaw) : null),
    },
    storeId: raw.storeId || null,
    store: raw.store || null,
    price: normalizeMoney(raw.price ?? raw.unitPrice ?? null),
    currency: raw.currency || DEFAULTS.currency,
    raw,
  };
}

/**
 * Scoring match between receipt line and scan candidate.
 */
function scoreMatch(line, cand, weights = DEFAULTS.match) {
  let score = 0;

  // barcode match is king
  if (line.barcode && cand.barcode && line.barcode === cand.barcode)
    score += weights.barcodeWeight;

  const ln = normalizeText(line.name);
  const cn = normalizeText(cand.name);

  if (ln && cn) {
    // simple token overlap
    const lt = new Set(ln.split(" ").filter(Boolean));
    const ct = new Set(cn.split(" ").filter(Boolean));
    let overlap = 0;
    for (const t of lt) if (ct.has(t)) overlap += 1;
    if (overlap >= 2) score += weights.nameWeight;
    else if (overlap >= 1)
      score += Math.max(1, Math.floor(weights.nameWeight / 2));
  }

  const lb = normalizeText(line.brand);
  const cb = normalizeText(cand.brand);
  if (lb && cb && lb === cb) score += weights.brandWeight;

  // size match (best effort)
  const la = line.size?.amount;
  const lu = line.size?.unit;
  const ca = cand.size?.amount;
  const cu = cand.size?.unit;
  if (la != null && ca != null && lu && cu && lu === cu) {
    const diff = Math.abs(la - ca);
    if (diff === 0) score += weights.sizeWeight;
    else if (diff / Math.max(la, ca) <= 0.1)
      score += Math.max(1, Math.floor(weights.sizeWeight / 2));
  }

  return score;
}

/**
 * Attempt to match receipt lines to candidates for a session.
 * Returns { matches, unmatchedLines, unusedCandidates }.
 */
function matchLinesToCandidates(lines, candidates, opts = {}) {
  const weights = { ...DEFAULTS.match, ...(opts.match || {}) };
  const minScore = opts.minScore ?? weights.minScore;

  const usedCandidateIds = new Set();
  const matches = [];
  const unmatchedLines = [];

  for (const line of lines) {
    let best = null;

    for (const cand of candidates) {
      if (!cand || usedCandidateIds.has(cand.id)) continue;
      const s = scoreMatch(line, cand, weights);
      if (!best || s > best.score) best = { cand, score: s };
    }

    if (best && best.score >= minScore) {
      usedCandidateIds.add(best.cand.id);
      matches.push({ line, candidate: best.cand, score: best.score });
    } else {
      unmatchedLines.push({ line });
    }
  }

  const unusedCandidates = candidates.filter(
    (c) => c && !usedCandidateIds.has(c.id)
  );
  return { matches, unmatchedLines, unusedCandidates };
}

/**
 * Inventory and pricebook upsert helpers (schema-flexible).
 * These create records with conservative shapes.
 */

function buildInventoryItemFromLine({ householdId, line, storeId }) {
  return {
    id: makeId("inv_item"),
    householdId: householdId || null,
    barcode: line.barcode || null,
    name: line.name || null,
    brand: line.brand || null,
    size: line.size?.raw || null,
    sizeAmount: line.size?.amount ?? null,
    sizeUnit: line.size?.unit ?? null,
    defaultUnit: line.size?.unit || "ea",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    meta: { source: "receipt.commit", storeId: storeId || null },
  };
}

function buildInventoryTxn({
  householdId,
  receiptId,
  line,
  matchedCandidateId,
  storeId,
  currency,
}) {
  const qty = normalizeQty(line.qty);
  const unitPrice = normalizeMoney(line.unitPrice);
  const lineTotal = normalizeMoney(line.lineTotal);

  return {
    id: makeId("inv_txn"),
    householdId: householdId || null,
    type: "add",
    at: nowISO(),

    receiptId: receiptId || null,
    storeId: storeId || null,

    // Item identifiers
    barcode: line.barcode || null,
    name: line.name || null,
    brand: line.brand || null,

    qty,
    unit: line.size?.unit || "ea",
    size: line.size?.raw || null,

    unitPrice,
    lineTotal,
    currency: currency || DEFAULTS.currency,

    candidateId: matchedCandidateId || null,
    meta: { source: "receipt.commit" },
  };
}

function buildPricebookEntry({
  householdId,
  storeId,
  line,
  receiptId,
  currency,
}) {
  const unitPrice = normalizeMoney(line.unitPrice);
  const lineTotal = normalizeMoney(line.lineTotal);
  const qty = normalizeQty(line.qty);

  // best-effort per-unit computation
  let computedUnit = unitPrice;
  if (computedUnit == null && lineTotal != null && qty)
    computedUnit = lineTotal / qty;

  return {
    id: makeId("pb"),
    householdId: householdId || null,
    storeId: storeId || null,

    barcode: line.barcode || null,
    name: line.name || null,
    brand: line.brand || null,

    size: line.size?.raw || null,
    sizeAmount: line.size?.amount ?? null,
    sizeUnit: line.size?.unit ?? null,

    currency: currency || DEFAULTS.currency,
    unitPrice: computedUnit,
    observedAt: nowISO(),
    receiptId: receiptId || null,
    meta: { source: "receipt.commit" },
  };
}

/**
 * Resolve receipt record by id from either receipts table or artifacts table.
 */
async function resolveReceiptRecord({ db, receiptId }) {
  const receiptsRef = resolveTable(db, ["receipts", "sct_receipts"]);
  const artifactsRef = resolveTable(db, ["artifacts"]);

  let receipt = null;
  if (receiptsRef) receipt = await safeGetById(receiptsRef, receiptId);

  // Some systems store receipts as artifacts
  if (!receipt && artifactsRef)
    receipt = await safeGetById(artifactsRef, receiptId);

  // Some artifacts may store receipt id in meta
  if (!receipt && artifactsRef && isFn(artifactsRef.table.where)) {
    try {
      const found = await artifactsRef.table
        .where("kind")
        .equals("receipt")
        .toArray();
      receipt = (found || []).find((a) => a?.id === receiptId) || null;
    } catch {
      // ignore
    }
  }

  return receipt;
}

/**
 * Resolve candidates by sessionId (optional).
 */
async function resolveSessionCandidates({ db, sessionId }) {
  if (!sessionId) return [];

  const candsRef = resolveTable(db, [
    "shopping_candidates",
    "sct_candidates",
    "parsed_candidates",
  ]);
  if (!candsRef) return [];

  const rows =
    (await safeWhereEqualsToArray(candsRef, "sessionId", sessionId)) || [];
  return rows.map(normalizeCandidate);
}

/**
 * Update candidate commit status (best effort).
 */
async function markCandidateCommitted({ db, candidateId, receiptId, match }) {
  const candsRef = resolveTable(db, [
    "shopping_candidates",
    "sct_candidates",
    "parsed_candidates",
  ]);
  if (!candsRef || !candidateId) return false;

  try {
    const current = await candsRef.table.get(candidateId);
    if (!current) return false;

    const next = {
      ...current,
      updatedAt: nowISO(),
      status: "committed",
      committedAt: nowISO(),
      receiptId: receiptId || current.receiptId || null,
      commit: {
        ...(current.commit || {}),
        matched: !!match,
        matchScore: match?.score ?? null,
        lineId: match?.line?.id ?? null,
      },
    };

    await candsRef.table.put(next);
    return true;
  } catch {
    return false;
  }
}

async function markCandidateUnmatched({ db, candidateId, receiptId }) {
  const candsRef = resolveTable(db, [
    "shopping_candidates",
    "sct_candidates",
    "parsed_candidates",
  ]);
  if (!candsRef || !candidateId) return false;

  try {
    const current = await candsRef.table.get(candidateId);
    if (!current) return false;

    const next = {
      ...current,
      updatedAt: nowISO(),
      status: "unmatched",
      receiptId: receiptId || current.receiptId || null,
    };

    await candsRef.table.put(next);
    return true;
  } catch {
    return false;
  }
}

/**
 * Inventory item resolution:
 * Try to find existing inventory item by barcode (preferred) else by normalized name+brand.
 */
async function resolveOrCreateInventoryItem({
  db,
  householdId,
  storeId,
  line,
  allowCreate = DEFAULTS.allowCreateInventoryItem,
  logger,
}) {
  const invItemsRef = resolveTable(db, [
    "inventory_items",
    "inventoryItems",
    "inv_items",
  ]);
  if (!invItemsRef) {
    // no inventory items table; caller may still record txns by barcode/name
    return { item: null, created: false, tableMissing: true };
  }

  const barcode = line.barcode;
  const nameKey = normalizeText(line.name);
  const brandKey = normalizeText(line.brand);

  try {
    let found = null;

    if (barcode && isFn(invItemsRef.table.where)) {
      const rows = await invItemsRef.table
        .where("barcode")
        .equals(barcode)
        .toArray();
      found = (rows || [])[0] || null;
    }

    if (!found && isFn(invItemsRef.table.toArray)) {
      const all = await invItemsRef.table.toArray();
      found =
        (all || []).find((x) => {
          const nk = normalizeText(x?.name);
          const bk = normalizeText(x?.brand);
          return nk && nk === nameKey && (!brandKey || bk === brandKey);
        }) || null;
    }

    if (found) return { item: found, created: false, tableMissing: false };

    if (!allowCreate)
      return { item: null, created: false, tableMissing: false };

    const createdItem = buildInventoryItemFromLine({
      householdId,
      line,
      storeId,
    });
    await invItemsRef.table.put(createdItem);
    return { item: createdItem, created: true, tableMissing: false };
  } catch (e) {
    logger?.warn?.(
      "[ReceiptCommitService] resolveOrCreateInventoryItem failed:",
      e
    );
    return { item: null, created: false, tableMissing: false };
  }
}

/**
 * Write inventory transaction rows (best effort).
 */
async function writeInventoryTxns({ db, txns, logger }) {
  const invTxnsRef = resolveTable(db, [
    "inventory_txns",
    "inventoryTxns",
    "inv_txns",
  ]);
  if (!invTxnsRef) return { ok: false, tableMissing: true, count: 0 };

  const res = await safeBulkPut(invTxnsRef, txns);
  if (!res.ok)
    logger?.warn?.("[ReceiptCommitService] inventory txns write failed");
  return { ok: res.ok, tableMissing: false, count: res.count };
}

/**
 * Write pricebook rows (best effort).
 */
async function writePricebookRows({ db, rows, logger }) {
  // support multiple possible schemas
  const priceRef =
    resolveTable(db, ["pricebook_prices", "pricebookPrices"]) ||
    resolveTable(db, ["pricebook", "pricebook_entries", "price_history"]);
  if (!priceRef) return { ok: false, tableMissing: true, count: 0 };

  const res = await safeBulkPut(priceRef, rows);
  if (!res.ok) logger?.warn?.("[ReceiptCommitService] pricebook write failed");
  return { ok: res.ok, tableMissing: false, count: res.count };
}

/**
 * Optional commit log table writer
 */
async function writeCommitLog({ db, logRow }) {
  const ref = resolveTable(db, [
    "commit_log",
    "receipt_commit_log",
    "audit_log",
  ]);
  if (!ref) return null;
  return await safePut(ref, logRow);
}

/**
 * Public Service
 */
const ReceiptCommitService = {
  EVT,

  /**
   * Commit a receipt into inventory + pricebook.
   *
   * @param {Object} args
   * @param {string} args.receiptId - ID in receipts table OR artifacts table
   * @param {string} [args.sessionId] - shopping scan session id (to match candidates)
   * @param {string} [args.householdId]
   * @param {string} [args.userId]
   * @param {string} [args.storeId]
   * @param {Object} [args.store] - store object (optional)
   * @param {Object} [args.options]
   * @param {Object} [args.db] - override db
   * @param {Object} [args.eventBus] - override eventBus
   * @param {Object} [args.logger] - override logger
   *
   * @returns {Promise<{ok:boolean, report:Object}>}
   */
  async commitReceipt(args = {}) {
    const {
      receiptId,
      sessionId,
      householdId,
      userId,
      storeId: storeIdArg,
      store,
      options = {},
      db = defaultDb,
      eventBus = defaultEventBus,
      logger: loggerArg,
    } = args;

    const logger = createLogger(loggerArg);
    const startedAt = nowISO();
    const commitId = makeId("commit");

    if (!receiptId) {
      const error = "Missing receiptId";
      safeEmit(eventBus, EVT.FAIL, { commitId, at: startedAt, error });
      return { ok: false, report: { commitId, error } };
    }

    const opts = {
      ...DEFAULTS,
      ...(options || {}),
      match: { ...DEFAULTS.match, ...(options?.match || {}) },
    };

    safeEmit(eventBus, EVT.START, {
      commitId,
      receiptId,
      sessionId: sessionId || null,
      householdId: householdId || null,
      userId: userId || null,
      at: startedAt,
    });

    try {
      const receipt = await resolveReceiptRecord({ db, receiptId });
      if (!receipt) {
        const error = `Receipt not found: ${receiptId}`;
        safeEmit(eventBus, EVT.FAIL, {
          commitId,
          at: nowISO(),
          receiptId,
          error,
        });
        return { ok: false, report: { commitId, receiptId, error } };
      }

      const derivedStoreId =
        storeIdArg ||
        receipt?.storeId ||
        receipt?.store?.id ||
        receipt?.meta?.storeId ||
        receipt?.parsed?.storeId ||
        null;

      const currency =
        receipt?.currency ||
        receipt?.parsed?.currency ||
        receipt?.meta?.currency ||
        options?.currency ||
        DEFAULTS.currency;

      const effectiveHouseholdId =
        householdId ||
        receipt?.householdId ||
        receipt?.meta?.householdId ||
        receipt?.parsed?.householdId ||
        null;

      const effectiveUserId =
        userId ||
        receipt?.userId ||
        receipt?.meta?.userId ||
        receipt?.parsed?.userId ||
        null;

      const linesRaw = extractReceiptLines(receipt);
      const lines = linesRaw.map((ln) =>
        normalizeReceiptLine(ln, { currency })
      );

      // Candidates (optional)
      const candidates = await resolveSessionCandidates({
        db,
        sessionId: sessionId || receipt?.sessionId,
      });

      const { matches, unmatchedLines, unusedCandidates } =
        matchLinesToCandidates(lines, candidates, {
          match: opts.match,
          minScore: opts.match.minScore,
        });

      // Emit candidate match/unmatch events and mark in DB (best effort)
      for (const m of matches) {
        safeEmit(eventBus, EVT.CANDIDATE_MATCHED, {
          commitId,
          at: nowISO(),
          receiptId,
          sessionId: sessionId || null,
          candidateId: m.candidate?.id,
          lineId: m.line?.id,
          score: m.score,
        });
        // eslint-disable-next-line no-await-in-loop
        await markCandidateCommitted({
          db,
          candidateId: m.candidate?.id,
          receiptId,
          match: m,
        });
      }
      for (const c of unusedCandidates) {
        safeEmit(eventBus, EVT.CANDIDATE_UNMATCHED, {
          commitId,
          at: nowISO(),
          receiptId,
          sessionId: sessionId || null,
          candidateId: c?.id,
        });
        // eslint-disable-next-line no-await-in-loop
        await markCandidateUnmatched({ db, candidateId: c?.id, receiptId });
      }

      // Build inventory + pricebook rows
      const inventoryTxns = [];
      const pricebookRows = [];

      // Inventory + pricebook for every line (even if unmatched), but with metadata for match.
      for (const line of lines) {
        const match = matches.find((m) => m?.line?.id === line.id) || null;
        const matchedCandidateId = match?.candidate?.id || null;

        // Inventory item resolution is optional; txns can be stored even if inventory_items table is missing.
        if (opts.enableInventory) {
          // eslint-disable-next-line no-await-in-loop
          await resolveOrCreateInventoryItem({
            db,
            householdId: effectiveHouseholdId,
            storeId: derivedStoreId,
            line,
            allowCreate: opts.allowCreateInventoryItem,
            logger,
          });

          inventoryTxns.push(
            buildInventoryTxn({
              householdId: effectiveHouseholdId,
              receiptId,
              line,
              matchedCandidateId,
              storeId: derivedStoreId,
              currency,
            })
          );
        }

        if (
          opts.enablePricebook &&
          opts.enablePricebook !== false &&
          opts.enablePricebook !== 0
        ) {
          // Only write if we have some price signal
          const unitPrice = normalizeMoney(line.unitPrice);
          const lineTotal = normalizeMoney(line.lineTotal);
          if (unitPrice != null || lineTotal != null) {
            pricebookRows.push(
              buildPricebookEntry({
                householdId: effectiveHouseholdId,
                storeId: derivedStoreId,
                line,
                receiptId,
                currency,
              })
            );
          }
        }
      }

      // Write txns / pricebook
      const invWrite = opts.enableInventory
        ? await writeInventoryTxns({ db, txns: inventoryTxns, logger })
        : { ok: true, tableMissing: false, count: 0 };

      if (opts.enableInventory && invWrite.tableMissing) {
        safeEmit(eventBus, EVT.WARN, {
          commitId,
          at: nowISO(),
          warning:
            "Inventory tables missing; inventory txns were not persisted.",
        });
      } else if (invWrite.ok) {
        for (const txn of inventoryTxns) {
          safeEmit(eventBus, EVT.INVENTORY_TXN, {
            commitId,
            at: nowISO(),
            txnId: txn.id,
            receiptId,
          });
        }
      }

      const pbWrite = opts.enablePricebook
        ? await writePricebookRows({ db, rows: pricebookRows, logger })
        : { ok: true, tableMissing: false, count: 0 };

      if (opts.enablePricebook && pbWrite.tableMissing) {
        safeEmit(eventBus, EVT.WARN, {
          commitId,
          at: nowISO(),
          warning:
            "Pricebook tables missing; price observations were not persisted.",
        });
      } else if (pbWrite.ok) {
        safeEmit(eventBus, EVT.PRICEBOOK_UPSERT, {
          commitId,
          at: nowISO(),
          receiptId,
          count: pbWrite.count,
          storeId: derivedStoreId,
        });
      }

      // Optional: mark receipt committed (best effort)
      const receiptsRef = resolveTable(db, ["receipts", "sct_receipts"]);
      const artifactsRef = resolveTable(db, ["artifacts"]);

      const receiptPatch = {
        ...receipt,
        updatedAt: nowISO(),
        status: "committed",
        committedAt: nowISO(),
        commitId,
        commit: {
          ...(receipt.commit || {}),
          commitId,
          committedAt: nowISO(),
          totals: {
            lines: lines.length,
            matchedLines: matches.length,
            unmatchedLines: unmatchedLines.length,
            inventoryTxns: invWrite.count,
            pricebookRows: pbWrite.count,
          },
        },
      };

      // Try write back to whichever table it came from
      let wroteReceipt = false;
      if (receiptsRef && (await safePut(receiptsRef, receiptPatch)))
        wroteReceipt = true;
      if (
        !wroteReceipt &&
        artifactsRef &&
        (await safePut(artifactsRef, receiptPatch))
      )
        wroteReceipt = true;

      // Optional audit log
      await writeCommitLog({
        db,
        logRow: {
          id: commitId,
          kind: "receipt_commit",
          at: nowISO(),
          receiptId,
          sessionId: sessionId || receipt?.sessionId || null,
          householdId: effectiveHouseholdId,
          userId: effectiveUserId,
          storeId: derivedStoreId,
          currency,
          counts: {
            receiptLines: lines.length,
            candidates: candidates.length,
            matches: matches.length,
            unusedCandidates: unusedCandidates.length,
            inventoryTxns: invWrite.count,
            pricebookRows: pbWrite.count,
          },
          meta: {
            opts,
            receiptTableWritten: wroteReceipt,
          },
        },
      });

      const report = {
        ok: true,
        commitId,
        startedAt,
        finishedAt: nowISO(),
        receiptId,
        sessionId: sessionId || receipt?.sessionId || null,
        householdId: effectiveHouseholdId,
        userId: effectiveUserId,
        storeId: derivedStoreId,
        store: store || receipt?.store || receipt?.parsed?.store || null,
        currency,
        counts: {
          receiptLines: lines.length,
          candidates: candidates.length,
          matches: matches.length,
          unmatchedLines: unmatchedLines.length,
          unusedCandidates: unusedCandidates.length,
          inventoryTxns: invWrite.count,
          pricebookRows: pbWrite.count,
        },
        tables: {
          inventoryTxns: invWrite.tableMissing ? null : "present",
          pricebook: pbWrite.tableMissing ? null : "present",
          receiptUpdated: wroteReceipt,
        },
        matches: matches.map((m) => ({
          score: m.score,
          line: {
            id: m.line.id,
            barcode: m.line.barcode,
            name: m.line.name,
            brand: m.line.brand,
            qty: m.line.qty,
            unitPrice: m.line.unitPrice,
            lineTotal: m.line.lineTotal,
            size: m.line.size,
          },
          candidate: {
            id: m.candidate.id,
            barcode: m.candidate.barcode,
            name: m.candidate.name,
            brand: m.candidate.brand,
            price: m.candidate.price,
            size: m.candidate.size,
          },
        })),
        warnings: [],
      };

      if (opts.enableInventory && invWrite.tableMissing) {
        report.warnings.push(
          "Inventory tables missing; inventory txns not persisted."
        );
      }
      if (opts.enablePricebook && pbWrite.tableMissing) {
        report.warnings.push(
          "Pricebook tables missing; price observations not persisted."
        );
      }

      safeEmit(eventBus, EVT.DONE, {
        commitId,
        at: nowISO(),
        receiptId,
        sessionId: report.sessionId,
        counts: report.counts,
        ok: true,
      });

      return { ok: true, report };
    } catch (e) {
      const error = String(e?.message || e);
      safeEmit(eventBus, EVT.FAIL, {
        commitId,
        at: nowISO(),
        receiptId,
        error,
      });
      logger.error("[ReceiptCommitService] commitReceipt failed:", e);
      return { ok: false, report: { commitId, receiptId, error } };
    }
  },

  /**
   * Utility: compute KPIs used on home/shopping pages without crashing if tables don’t exist.
   * - shopping candidates waiting for receipt
   * - receipts pending reconciliation / commit
   */
  async getShoppingKPIs(args = {}) {
    const { householdId = null, db = defaultDb } = args;

    const candidatesRef = resolveTable(db, [
      "shopping_candidates",
      "sct_candidates",
      "parsed_candidates",
    ]);
    const receiptsRef =
      resolveTable(db, ["receipts", "sct_receipts"]) ||
      resolveTable(db, ["artifacts"]);

    let waitingCandidates = 0;
    let receiptsPending = 0;

    try {
      if (candidatesRef?.table && isFn(candidatesRef.table.toArray)) {
        const all = await candidatesRef.table.toArray();
        const filtered = (all || []).filter((c) => {
          if (!c) return false;
          if (householdId && c.householdId && c.householdId !== householdId)
            return false;
          // "waiting for receipt" => status active/queued and no receiptId/commit
          const status = String(c.status || "").toLowerCase();
          const hasReceipt = !!(c.receiptId || c.commit?.receiptId);
          const hasCommit =
            status === "committed" || !!c.commitId || !!c.committedAt;
          return (
            !hasReceipt &&
            !hasCommit &&
            (status === "" ||
              status === "active" ||
              status === "queued" ||
              status === "candidate")
          );
        });
        waitingCandidates = filtered.length;
      }
    } catch {
      // ignore
    }

    try {
      if (receiptsRef?.table && isFn(receiptsRef.table.toArray)) {
        const all = await receiptsRef.table.toArray();
        const filtered = (all || []).filter((r) => {
          if (!r) return false;
          if (householdId && r.householdId && r.householdId !== householdId)
            return false;
          const kind = String(r.kind || r.type || "").toLowerCase();
          const isReceipt =
            kind.includes("receipt") ||
            (r.meta && String(r.meta.kind || "").toLowerCase() === "receipt");
          if (!isReceipt) return false;
          const status = String(r.status || "").toLowerCase();
          const committed =
            status === "committed" || !!r.commitId || !!r.committedAt;
          return !committed; // pending commit/reconcile
        });
        receiptsPending = filtered.length;
      }
    } catch {
      // ignore
    }

    return {
      ok: true,
      householdId,
      waitingCandidates,
      receiptsPending,
      at: nowISO(),
    };
  },
};

export default ReceiptCommitService;
export { ReceiptCommitService };

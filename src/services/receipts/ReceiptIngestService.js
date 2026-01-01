// src/services/receipts/ReceiptIngestService.js
// -----------------------------------------------------------------------------
// ReceiptIngestService (Shopping Mode)
// L0: Save receipt artifact
// L1: Parse receipt line items
// L2: Reconcile to shopping_candidates (fuzzy + UPC/qty/weight/multipack)
// L3: Receipt-confirmed commit -> inventory + costs
//
// Notes:
// - This module is defensive: works even if some tables/services are not present.
// - It prefers SSA layered tables if available (artifacts, parsed_candidates, etc.).
// - It emits shopping flow events for automation/UI refresh.
//
// Emits (eventBus + window CustomEvent when available):
//   shopping.receipt.received
//   shopping.receipt.parsed
//   shopping.receipt.reconciled
//   shopping.commit.completed
// -----------------------------------------------------------------------------

import { ReceiptReconciliationEngine } from "./ReceiptReconciliationEngine";
import { getInventorySessionService } from "@/services/inventory/InventorySessionService";

/* ----------------------------- tiny safe utils ---------------------------- */
const isBrowser = typeof window !== "undefined";
const nowIso = () => new Date().toISOString();
const now = () => Date.now();
const genId = (p = "rcpt") =>
  `${p}_${Math.random().toString(36).slice(2)}_${Date.now().toString(36)}`;

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function safeJsonParse(s, fallback = null) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function safeImport(path) {
  try {
    const mod = await import(path);
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

// eventBus soft import (repo has had multiple paths)
let EVENTBUS = null;
async function getEventBus() {
  if (EVENTBUS) return EVENTBUS;
  const candidates = [
    "@/services/events/eventBus",
    "@/services/events/eventBus.js",
    "@/services/eventBus",
    "@/services/eventBus.js",
  ];
  for (const p of candidates) {
    const mod = await safeImport(p);
    const eb = mod?.default || mod?.eventBus || mod;
    if (eb?.emit) {
      EVENTBUS = eb;
      break;
    }
  }
  EVENTBUS = EVENTBUS || { emit: () => {}, on: () => () => {} };
  return EVENTBUS;
}

async function emitAll(type, detail) {
  try {
    const eb = await getEventBus();
    // some eventBus implementations are eb.emit(type, payload) OR eb.emit({type,data})
    try {
      eb.emit(type, detail);
    } catch {
      eb.emit({
        type,
        ts: nowIso(),
        source: "ReceiptIngestService",
        data: detail,
      });
    }
  } catch {}

  try {
    if (isBrowser) window.dispatchEvent(new CustomEvent(type, { detail }));
  } catch {}
}

/* ----------------------------- DB soft import ----------------------------- */
async function getDb() {
  const servicesDb = await safeImport("@/services/db");
  const d =
    servicesDb?.db ||
    servicesDb?.default?.db ||
    servicesDb?.default ||
    servicesDb;
  if (d && typeof d.table === "function") return d;

  const legacy = await safeImport("@/db");
  const db2 = legacy?.default || legacy;
  if (db2 && typeof db2.table === "function") return db2;

  return null;
}

/* -------------------------- Receipt parsing helpers ------------------------ */

/**
 * Very tolerant receipt text parser.
 * Goal: extract plausible line items + totals/tax/discount.
 *
 * Expected output:
 * {
 *   storeName, storeIdGuess, purchasedAt, currency,
 *   totals: { subtotal, tax, discounts, total },
 *   items: [{ lineNo, raw, name, qty, unit, isWeight, unitPrice, totalPrice, upcLike }]
 * }
 */
function parseReceiptText(rawText = "") {
  const text = String(rawText || "").replace(/\r\n/g, "\n");
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const out = {
    storeName: null,
    storeIdGuess: null,
    purchasedAt: null,
    currency: "USD",
    totals: { subtotal: null, tax: null, discounts: null, total: null },
    items: [],
    rawText: text,
  };

  // Store name guess: first non-empty line (often store name)
  if (lines.length) {
    out.storeName = lines[0].slice(0, 80);
    out.storeIdGuess = normalizeStoreId(out.storeName);
  }

  // Date/time guess
  const dateRx =
    /(\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b)|(\b\d{4}[\/\-]\d{2}[\/\-]\d{2}\b)/;
  const timeRx = /\b(\d{1,2}:\d{2})(:\d{2})?\s?(am|pm)?\b/i;

  for (const l of lines.slice(0, 20)) {
    const dm = l.match(dateRx);
    if (dm) {
      const tm = l.match(timeRx);
      const dt = tm ? `${dm[0]} ${tm[0]}` : dm[0];
      out.purchasedAt = dt;
      break;
    }
  }

  // totals (common labels)
  const money = (s) => {
    const m = String(s).match(/-?\$?\s*([0-9]+(?:\.[0-9]{2})?)/);
    return m ? Number(m[1]) : null;
  };
  for (const l of lines) {
    const ll = l.toLowerCase();
    if (out.totals.total == null && /(grand\s*)?total\b/.test(ll))
      out.totals.total = money(l);
    if (out.totals.subtotal == null && /sub\s*total|subtotal/.test(ll))
      out.totals.subtotal = money(l);
    if (out.totals.tax == null && /\btax\b/.test(ll)) out.totals.tax = money(l);
    if (out.totals.discounts == null && /discount|savings|coupon/.test(ll)) {
      const v = money(l);
      if (v != null) out.totals.discounts = Math.abs(v);
    }
  }

  // line items:
  // - many receipts: "ITEM NAME    2.99" OR "ITEM  1 @ 2.99  2.99"
  // - weight items: "BANANAS  1.24 lb @ 0.59/lb  0.73"
  // - multipack: "SODA 12PK  6.99"
  const itemLike = (l) => {
    // has at least one price and some letters
    return /[a-zA-Z]/.test(l) && /([0-9]+\.[0-9]{2})/.test(l);
  };

  const qtyAtRx = /\b(\d+(?:\.\d+)?)\s*@\s*([0-9]+\.[0-9]{2})\b/;
  const weightRx = /\b(\d+(?:\.\d+)?)\s*(lb|lbs|oz|kg|g)\b/i;
  const upcRx = /\b(\d{10,14})\b/;

  let lineNo = 0;
  for (const l of lines) {
    if (!itemLike(l)) continue;
    const ll = l.toLowerCase();

    // skip total/subtotal/tax lines
    if (/total|subtotal|tax|change|cash|visa|mastercard|debit|credit/.test(ll))
      continue;

    lineNo += 1;
    const upcLike = (l.match(upcRx) || [])[1] || null;
    const qtyAt = l.match(qtyAtRx);
    const w = l.match(weightRx);

    const totalPrice = lastMoneyOnLine(l);
    const unitPrice = qtyAt ? Number(qtyAt[2]) : null;
    const qty = qtyAt ? Number(qtyAt[1]) : w ? Number(w[1]) : 1;

    const unit = qtyAt ? "ea" : w ? String(w[2]).toLowerCase() : "ea";
    const isWeight = !!w && !qtyAt;

    const name = cleanItemName(l);

    out.items.push({
      lineNo,
      raw: l,
      name,
      qty,
      unit,
      isWeight,
      unitPrice,
      totalPrice,
      upcLike,
    });
  }

  return out;
}

function lastMoneyOnLine(line) {
  const matches = String(line).match(/([0-9]+\.[0-9]{2})/g);
  if (!matches || !matches.length) return null;
  return Number(matches[matches.length - 1]);
}

function cleanItemName(line) {
  // remove money tokens and typical @ patterns
  let s = String(line);
  s = s.replace(/\b\d+(?:\.\d+)?\s*@\s*\d+\.\d{2}\b/g, "");
  s = s.replace(/\b\d+\.\d{2}\b/g, "");
  s = s.replace(/\$/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  // remove trailing non-name tokens
  s = s.replace(/\b(subtotal|total|tax)\b/i, "").trim();
  return s.slice(0, 120);
}

function normalizeStoreId(storeLike) {
  const s = String(storeLike || "").toLowerCase();
  const map = [
    ["walmart", "walmart"],
    ["wal-mart", "walmart"],
    ["target", "target"],
    ["aldi", "aldi"],
    ["kroger", "kroger"],
    ["publix", "publix"],
    ["costco", "costco"],
    ["sam's", "samsclub"],
    ["sams", "samsclub"],
    ["whole foods", "wholefoods"],
    ["trader joe", "traderjoes"],
    ["heb", "heb"],
    ["meijer", "meijer"],
  ];
  for (const [k, v] of map) if (s.includes(k)) return v;
  // fallback: alnum slug
  return s.replace(/[^a-z0-9]+/g, "").slice(0, 24) || null;
}

/* ------------------------------- L0 artifact ------------------------------ */
async function createReceiptArtifact({
  text,
  json,
  imageDataUrl,
  fileName,
  storeId,
  householdId,
  userId,
  meta = {},
} = {}) {
  // Prefer unified ingest service if present
  const UploadIngestService =
    (await safeImport("@/services/ingest/UploadIngestService")) ||
    (await safeImport("@/services/import/UploadIngestService")) ||
    (await safeImport("@/services/uploads/UploadIngestService"));

  if (UploadIngestService?.createArtifact) {
    const created = await UploadIngestService.createArtifact({
      text: text && String(text).trim() ? String(text) : null,
      json: json && typeof json === "object" ? json : null,
      imageDataUrl: imageDataUrl || null,
      fileName: fileName || "receipt",
      domainHint: "receipt",
      source: "shopping-receipt",
      householdId: householdId || null,
      userId: userId || null,
      meta: { storeId: storeId || null, receipt: true, ...meta },
    });
    return {
      artifactId: created?.artifactId || created?.id || null,
      artifact: created || null,
      mode: "ingest-service",
    };
  }

  // fallback: write to db.artifacts if exists
  const db = await getDb();
  const artifactId = genId("artifact");
  const artifact = {
    id: artifactId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    type: "receipt",
    domain: "receipt",
    source: "shopping-receipt",
    fileName: fileName || "receipt",
    storeId: storeId || null,
    householdId: householdId || null,
    userId: userId || null,
    text: text ? String(text) : null,
    json: json && typeof json === "object" ? json : null,
    imageDataUrl: imageDataUrl || null,
    meta: meta || {},
  };

  try {
    if (db?.artifacts?.put) await db.artifacts.put(artifact);
  } catch {
    // if DB missing, just return in-memory
  }

  return { artifactId, artifact, mode: "db-fallback" };
}

/* ------------------------------- main service ----------------------------- */
export class ReceiptIngestService {
  /**
   * Main pipeline:
   * - Save receipt (L0)
   * - Parse items (L1)
   * - Reconcile to shopping_candidates (L2)
   * - Commit receipt-confirmed inventory/costs (L3)
   */
  static async ingestReceipt({
    text,
    json,
    imageDataUrl,
    fileName,
    storeId,
    householdId,
    userId,
    options = {},
    meta = {},
  } = {}) {
    const db = await getDb();
    const receiptId = genId("receipt");

    // L0 artifact
    const { artifactId } = await createReceiptArtifact({
      text,
      json,
      imageDataUrl,
      fileName,
      storeId,
      householdId,
      userId,
      meta,
    });

    await emitAll("shopping.receipt.received", {
      receiptId,
      artifactId,
      storeId: storeId || null,
      householdId: householdId || null,
      ts: nowIso(),
    });

    // L1 parse
    const parsed =
      json && typeof json === "object" && Array.isArray(json.items)
        ? normalizeStructuredReceipt(json)
        : parseReceiptText(text || "");

    // store parse output if possible
    const parsedRec = {
      id: receiptId,
      artifactId: artifactId || null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      storeId: storeId || parsed.storeIdGuess || null,
      storeName: parsed.storeName || null,
      purchasedAt: parsed.purchasedAt || null,
      totals: parsed.totals || {},
      currency: parsed.currency || "USD",
      lineItems: parsed.items || [],
      householdId: householdId || null,
      userId: userId || null,
      meta: meta || {},
    };

    try {
      if (db?.receipts?.put) await db.receipts.put(parsedRec);
      if (db?.receipt_items?.bulkPut) {
        const items = (parsedRec.lineItems || []).map((it) => ({
          id: genId("rcpt_item"),
          receiptId,
          lineNo: it.lineNo,
          raw: it.raw,
          name: it.name,
          qty: it.qty,
          unit: it.unit,
          isWeight: !!it.isWeight,
          unitPrice: it.unitPrice,
          totalPrice: it.totalPrice,
          upcLike: it.upcLike || null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          storeId: parsedRec.storeId,
          householdId: householdId || null,
        }));
        await db.receipt_items.bulkPut(items);
      }
      // optional layered parsed_candidates
      if (db?.parsed_candidates?.put) {
        await db.parsed_candidates.put({
          id: genId("cand_receipt"),
          createdAt: nowIso(),
          updatedAt: nowIso(),
          artifactId: artifactId || null,
          domain: "receipt",
          kind: "receipt.parse",
          confidence: 0.9,
          payload: parsedRec,
          householdId: householdId || null,
          userId: userId || null,
        });
      }
    } catch {
      // non-fatal
    }

    await emitAll("shopping.receipt.parsed", {
      receiptId,
      artifactId,
      storeId: parsedRec.storeId,
      itemCount: (parsedRec.lineItems || []).length,
      totals: parsedRec.totals || {},
      ts: nowIso(),
    });

    // L2 reconcile
    const candidates = await selectShoppingCandidates(db, {
      storeId: parsedRec.storeId,
      householdId,
      windowMs: options.windowMs ?? 36 * 60 * 60 * 1000, // last 36 hours
    });

    const recon = ReceiptReconciliationEngine.reconcile({
      receipt: parsedRec,
      candidates,
      options: {
        storeId: parsedRec.storeId,
        allowCrossStore: !!options.allowCrossStore,
        scoreThreshold: Number.isFinite(options.scoreThreshold)
          ? options.scoreThreshold
          : 0.55,
      },
    });

    // store reconciliation
    try {
      if (db?.receipt_reconciliations?.put) {
        await db.receipt_reconciliations.put({
          id: genId("recon"),
          receiptId,
          artifactId: artifactId || null,
          storeId: parsedRec.storeId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          householdId: householdId || null,
          matches: recon.matches,
          unmatchedReceiptItems: recon.unmatchedReceiptItems,
          unmatchedCandidates: recon.unmatchedCandidates,
          totals: parsedRec.totals || {},
          meta: { ...meta, ...options },
        });
      }
      // update candidates with linkages (if table exists)
      if (db?.shopping_candidates?.put) {
        for (const m of recon.matches) {
          const c = candidates.find(
            (x) => String(x.id) === String(m.candidateId)
          );
          if (!c) continue;
          await db.shopping_candidates.put({
            ...c,
            updatedAt: nowIso(),
            receiptId,
            receiptLineNo: m.receiptLineNo,
            receiptName: m.receiptName,
            receiptQty: m.receiptQty,
            receiptUnit: m.receiptUnit,
            receiptTotal: m.receiptTotal,
            reconciliationScore: m.score,
            status: "receipt_matched",
          });
        }
      }
    } catch {
      // non-fatal
    }

    await emitAll("shopping.receipt.reconciled", {
      receiptId,
      storeId: parsedRec.storeId,
      matchedCount: recon.matches.length,
      unmatchedReceiptCount: recon.unmatchedReceiptItems.length,
      unmatchedCandidateCount: recon.unmatchedCandidates.length,
      ts: nowIso(),
    });

    // L3 commit (unless previewOnly)
    if (options.previewOnly) {
      return {
        ok: true,
        previewOnly: true,
        receiptId,
        artifactId,
        parsed: parsedRec,
        reconciliation: recon,
      };
    }

    const invSvc = getInventorySessionService();
    const commitRes = await invSvc.commitReceiptConfirmed({
      receiptId,
      storeId: parsedRec.storeId || storeId || null,
      householdId: householdId || null,
      userId: userId || null,
      currency: parsedRec.currency || "USD",
      totals: parsedRec.totals || {},
      matches: recon.matches,
      meta: { ...meta, receiptArtifactId: artifactId || null },
    });

    await emitAll("shopping.commit.completed", {
      receiptId,
      storeId: parsedRec.storeId || null,
      committedCount: commitRes?.committedCount || 0,
      costUpdates: commitRes?.costUpdates || 0,
      ts: nowIso(),
    });

    return {
      ok: true,
      receiptId,
      artifactId,
      parsed: parsedRec,
      reconciliation: recon,
      commit: commitRes,
    };
  }
}

/* ------------------------------ helpers ----------------------------------- */
function normalizeStructuredReceipt(json) {
  const storeName = json.storeName || json.store || null;
  const storeIdGuess = normalizeStoreId(storeName || "");
  const purchasedAt = json.purchasedAt || json.date || null;

  const totals = json.totals || {};
  const itemsIn = Array.isArray(json.items) ? json.items : [];

  const items = itemsIn.map((it, idx) => ({
    lineNo: it.lineNo ?? idx + 1,
    raw: it.raw || `${it.name || ""}`.trim(),
    name: String(it.name || it.description || it.raw || "Item").slice(0, 120),
    qty: Number(it.qty ?? it.quantity ?? 1),
    unit: String(it.unit || "ea").toLowerCase(),
    isWeight: !!it.isWeight,
    unitPrice: it.unitPrice != null ? Number(it.unitPrice) : null,
    totalPrice: it.totalPrice != null ? Number(it.totalPrice) : null,
    upcLike: it.upc || it.upcLike || null,
  }));

  return {
    storeName,
    storeIdGuess,
    purchasedAt,
    currency: json.currency || "USD",
    totals: {
      subtotal: totals.subtotal != null ? Number(totals.subtotal) : null,
      tax: totals.tax != null ? Number(totals.tax) : null,
      discounts: totals.discounts != null ? Number(totals.discounts) : null,
      total: totals.total != null ? Number(totals.total) : null,
    },
    items,
    rawText: null,
  };
}

async function selectShoppingCandidates(
  db,
  { storeId, householdId, windowMs } = {}
) {
  const cutoff =
    now() -
    clamp(Number(windowMs || 0), 5 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);

  // If Dexie table exists, use it
  try {
    if (db?.shopping_candidates?.toArray) {
      const all = await db.shopping_candidates.toArray();
      return (all || [])
        .filter((c) => {
          const ts = c?.ts
            ? Date.parse(c.ts)
            : c?.createdAt
            ? Date.parse(c.createdAt)
            : 0;
          const within = ts ? ts >= cutoff : true;
          const okHouse = householdId
            ? String(c.householdId || "") === String(householdId)
            : true;
          const okStatus =
            !c.status ||
            ["pending_receipt", "receipt_matched"].includes(String(c.status));
          const okStore =
            !storeId ||
            String(c.storeId || "") === String(storeId) ||
            String(c.store || "") === String(storeId);
          return within && okHouse && okStore && okStatus;
        })
        .sort(
          (a, b) =>
            (Date.parse(b.createdAt || b.ts || "") || 0) -
            (Date.parse(a.createdAt || a.ts || "") || 0)
        );
    }
  } catch {
    // ignore
  }

  // Fallback: localStorage cache (if your UI stores candidates there)
  if (isBrowser) {
    const raw = localStorage.getItem("suka::shopping::candidates") || "[]";
    const arr = safeJsonParse(raw, []);
    return Array.isArray(arr) ? arr : [];
  }
  return [];
}

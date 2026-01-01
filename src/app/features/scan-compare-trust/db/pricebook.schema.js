/* eslint-disable no-console */
// pricebook.schema.js — Dexie tables for observations (Scan • Compare • Trust)
// Style: robust, versioned, event-friendly, future-safe; JS with JSDoc for DX.

import Dexie from 'dexie';

/**
 * TIP: import this singleton DB where you need it:
 *   import { pricebookDB } from './pricebook.schema';
 *
 * Tables overview (selected):
 * - products               : product master (UPC/GTIN/brand/category normalization)
 * - stores                 : store master
 * - price_observations     : raw + normalized observations (scan/manual/API)
 * - pricebook_items        : per-store “current best known” (denormalized view)
 * - coupons                : coupons and stacking metadata
 * - circulars              : weekly/manager specials, pages, assets
 * - discount_cycles        : learned cadence per store/brand/SKU
 * - source_attributions    : which providers informed a result (for UI badge)
 * - scan_assets            : images from camera, shelf tags, PDFs
 * - ocr_texts              : OCR results + bounding boxes
 * - ingredient_alerts      : recalls, harmful ingredient flags
 * - user_prefs             : user-level flags (opt-ins, loyalty IDs)
 * - sessions               : run sessions (system-generated & user-authored)
 * - schedules              : scheduled automations (system & user-authored)
 * - favorites_sessions     : *user* saved sessions (not just system)
 * - favorites_schedules    : *user* saved schedules (not just system)
 */

export class PricebookDB extends Dexie {
  /** @type {Dexie.Table} */ products;
  /** @type {Dexie.Table} */ stores;

  /** @type {Dexie.Table} */ price_observations;
  /** @type {Dexie.Table} */ pricebook_items;

  /** @type {Dexie.Table} */ coupons;
  /** @type {Dexie.Table} */ circulars;
  /** @type {Dexie.Table} */ discount_cycles;

  /** @type {Dexie.Table} */ source_attributions;

  /** @type {Dexie.Table} */ scan_assets;
  /** @type {Dexie.Table} */ ocr_texts;
  /** @type {Dexie.Table} */ ingredient_alerts;

  /** @type {Dexie.Table} */ user_prefs;
  /** @type {Dexie.Table} */ user_links;

  /** @type {Dexie.Table} */ sessions;
  /** @type {Dexie.Table} */ schedules;
  /** @type {Dexie.Table} */ favorites_sessions;
  /** @type {Dexie.Table} */ favorites_schedules;

  /**
   * @param {Object} [opts]
   * @param {string} [opts.name]      optional DB name
   * @param {{emit?:Function}} [opts.eventBus] optional event bus
   */
  constructor(opts = {}) {
    super(opts.name || 'SUKA_PRICEBOOK_DB');
    this._eventBus = opts.eventBus?.emit ? opts.eventBus : { emit: () => {} };

    /**
     * v1 — Core entities
     */
    this.version(1).stores({
      products:
        // by id, lookup by upc/gtin/sku, brand, category
        '++id, upc, gtin, sku, name, brand, category, [brand+category], tags,*aliases',

      stores:
        '++id, extId, name, chain, city, state, zip, tz, *features',

      price_observations:
        // Fast lookups for comparison: by [storeId+upc+weekOf], newest, and stackHash
        '++id, storeId, productId, upc, gtin, sku, dateObserved, weekOf, ' +
        '[storeId+productId+dateObserved], [storeId+upc+weekOf], [upc+weekOf], ' +
        'stackHash, source, observationType, ' +
        'brand, category, tags, deleted, reviewFlag',

      pricebook_items:
        // Current best-known per store/SKU for speed in UI
        '++id, storeId, productId, upc, gtin, sku, updatedAt, ' +
        '[storeId+upc], [storeId+productId], preferred, deleted',

      coupons:
        '++id, provider, providerId, status, startsOn, endsOn, ' +
        'brand, upc, gtin, sku, storeId, chain, ' +
        'stackType, stackHash, termsHash, tags',

      circulars:
        '++id, storeId, chain, type, startsOn, endsOn, label, ' +
        'status, sourceUrl, *pages, tags',

      discount_cycles:
        // learned cadence: e.g., ~6 weeks; keyed by store + upc (or brand)
        '++id, storeId, upc, gtin, sku, brand, category, ' +
        'cycleDays, confidence, lastStart, lastEnd, samples, tags',

      source_attributions:
        '++id, entityType, entityId, sourceName, sourceType, weight, updatedAt, tags',

      scan_assets:
        '++id, kind, mime, bytes, width, height, ts, storeId, productId, upc, tags',

      ocr_texts:
        '++id, assetId, lang, ts, ' +
        // allow search by common keys
        'storeId, productId, upc, ' +
        // keep for linking
        'deleted, tags',

      ingredient_alerts:
        '++id, upc, gtin, sku, ingredient, alertType, source, effectiveOn, expiresOn, tags',

      user_prefs:
        // coupon prefs + loyalty IDs + per-feature flags
        '++id, userId, householdId, scope, key, updatedAt, [userId+key], tags',

      user_links:
        // linked accounts per provider (e.g., Sam’s, Costco, Kroger)
        '++id, userId, provider, status, createdAt, updatedAt, tags',

      sessions:
        // run sessions in Scan • Compare • Trust (system & user-authored)
        '++id, userId, householdId, title, scope, status, createdAt, updatedAt, ' +
        'systemGenerated, tags',

      schedules:
        // scheduled automations (system & user-authored)
        '++id, userId, householdId, scope, title, cron, ' +
        'systemProvided, active, createdAt, updatedAt, tags',

      favorites_sessions:
        // user-saved sessions (distinct from system)
        '++id, userId, sessionId, createdAt, [userId+sessionId]',

      favorites_schedules:
        // user-saved schedules (distinct from system)
        '++id, userId, scheduleId, createdAt, [userId+scheduleId]',
    });

    /**
     * v2 — Add trust/confidence fields, normalizedUnits, unit pricing
     */
    this.version(2).stores({
      // No index change needed; keep same definitions for Dexie
      price_observations:
        '++id, storeId, productId, upc, gtin, sku, dateObserved, weekOf, ' +
        '[storeId+productId+dateObserved], [storeId+upc+weekOf], [upc+weekOf], ' +
        'stackHash, source, observationType, ' +
        'brand, category, tags, deleted, reviewFlag',
    }).upgrade(async (tx) => {
      // Backfill normalization fields if missing
      const obs = tx.table('price_observations');
      await obs.toCollection().modify((o) => {
        o.trustScore ??= 0.5;            // 0 to 1
        o.confidence ??= 0.5;            // 0 to 1 (statistical fit / OCR quality)
        o.currency ??= 'USD';
        o.qty ??= 1;
        o.unit ??= 'ea';                 // ea, oz, lb, g, ml, L, ct, etc.
        // unitPrice = price / qty (if qty + unit recognized)
        if (o.price != null && o.qty) {
          o.unitPrice = Number(o.price) / Number(o.qty);
        }
        // packageSize (e.g., 12oz), regular vs promo
        o.packageSize ??= null;
        o.regularPrice ??= o.price ?? null;
        o.promoPrice ??= null;
      });
    });

    /**
     * v3 — Ingredient alerts & attributions tightening, add soft-delete breadth, add indexes for CycleAnalyzer
     */
    this.version(3).stores({
      discount_cycles:
        '++id, storeId, upc, gtin, sku, brand, category, ' +
        'cycleDays, confidence, lastStart, lastEnd, samples, tags, ' +
        // new lookups for dashboards
        '[storeId+brand], [storeId+category], [storeId+cycleDays]',
      ingredient_alerts:
        '++id, upc, gtin, sku, ingredient, alertType, source, effectiveOn, expiresOn, tags, deleted',
      source_attributions:
        '++id, entityType, entityId, sourceName, sourceType, weight, updatedAt, tags, deleted',
    }).upgrade(async (tx) => {
      const ia = tx.table('ingredient_alerts');
      await ia.toCollection().modify((r) => { r.deleted ??= false; });
      const sa = tx.table('source_attributions');
      await sa.toCollection().modify((r) => { r.deleted ??= false; });
    });

    /**
     * v4 — Sessions & schedules enrichment (user saved vs system), plus favorites tables refined
     */
    this.version(4).stores({
      sessions:
        '++id, userId, householdId, title, scope, status, createdAt, updatedAt, ' +
        'systemGenerated, tags, visibility, // visibility: "private"|"household"|"public"',
      schedules:
        '++id, userId, householdId, scope, title, cron, ' +
        'systemProvided, active, createdAt, updatedAt, tags, visibility',
      favorites_sessions:
        '++id, userId, sessionId, createdAt, [userId+sessionId], tags',
      favorites_schedules:
        '++id, userId, scheduleId, createdAt, [userId+scheduleId], tags',
    }).upgrade(async (tx) => {
      const ses = tx.table('sessions');
      await ses.toCollection().modify((r) => { r.visibility ??= 'private'; });
      const sch = tx.table('schedules');
      await sch.toCollection().modify((r) => { r.visibility ??= 'private'; });
    });

    /**
     * v5 — Pricebook “current view” accelerators + attribution links
     */
    this.version(5).stores({
      pricebook_items:
        '++id, storeId, productId, upc, gtin, sku, updatedAt, ' +
        '[storeId+upc], [storeId+productId], preferred, deleted, sourceAttributionId',
    });

    // Wire table handles (Dexie requirement in TypeScript, safe in JS)
    this.products = this.table('products');
    this.stores = this.table('stores');
    this.price_observations = this.table('price_observations');
    this.pricebook_items = this.table('pricebook_items');
    this.coupons = this.table('coupons');
    this.circulars = this.table('circulars');
    this.discount_cycles = this.table('discount_cycles');
    this.source_attributions = this.table('source_attributions');
    this.scan_assets = this.table('scan_assets');
    this.ocr_texts = this.table('ocr_texts');
    this.ingredient_alerts = this.table('ingredient_alerts');
    this.user_prefs = this.table('user_prefs');
    this.user_links = this.table('user_links');
    this.sessions = this.table('sessions');
    this.schedules = this.table('schedules');
    this.favorites_sessions = this.table('favorites_sessions');
    this.favorites_schedules = this.table('favorites_schedules');

    // Notify the rest of the app (e.g., toasts, logs) when schema migrates
    this.on('ready', async () => {
      this._eventBus.emit?.('db.ready', { db: 'SUKA_PRICEBOOK_DB' });
      return true;
    });
    this.on('populate', () => {
      // First run seed (optional, keep minimal)
      console.info('[pricebook.db] populate');
    });
  }

  // ---------- Convenience helpers for orchestration glue ----------

  /**
   * Normalize and store a price observation (scan/manual/API).
   * Intended for use by: useProductScan → ocr.worker → ProductResolver → StoreCatalogAdapters
   * and CouponService + CycleAnalyzer post-processors.
   * @param {Object} raw
   */
  async addObservation(raw = {}) {
    const now = new Date();
    const weekOf = startOfWeek(now);

    const safe = {
      storeId: raw.storeId ?? null,
      productId: raw.productId ?? null,
      upc: coalesceUPC(raw.upc, raw.gtin, raw.sku),
      gtin: raw.gtin ?? null,
      sku: raw.sku ?? null,

      price: numOrNull(raw.price),
      regularPrice: numOrNull(raw.regularPrice ?? raw.price),
      promoPrice: numOrNull(raw.promoPrice ?? null),

      currency: raw.currency ?? 'USD',
      qty: numOr( raw.qty, 1 ),
      unit: raw.unit ?? 'ea',
      unitPrice: computeUnitPrice(raw.price, raw.qty),

      packageSize: raw.packageSize ?? null,

      observationType: raw.observationType ?? 'scan', // scan | manual | api
      source: raw.source ?? 'unknown',
      device: raw.device ?? null,

      brand: raw.brand ?? null,
      category: raw.category ?? null,
      tags: raw.tags ?? [],

      dateObserved: iso(raw.dateObserved) ?? iso(now),
      weekOf: iso(weekOf),

      trustScore: clamp01(raw.trustScore ?? estimateTrust(raw)),
      confidence: clamp01(raw.confidence ?? 0.5),

      // coupon stacking hash (provider+id+terms normalized)
      stackHash: raw.stackHash ?? null,

      // soft-delete & QA flags
      deleted: !!raw.deleted,
      reviewFlag: !!raw.reviewFlag,

      // linkage to assets / ocr for audit trail
      assetId: raw.assetId ?? null,
      ocrId: raw.ocrId ?? null,

      // provenance
      userId: raw.userId ?? null,
      householdId: raw.householdId ?? null,
    };

    // defensive: if no price, nothing to do
    if (safe.price == null && safe.promoPrice == null && safe.regularPrice == null) {
      console.warn('[addObservation] Missing price fields; skipping');
      return null;
    }

    // build/store
    const id = await this.price_observations.add(safe);

    // keep “current view” fresh for UI
    await this._upsertPricebookItemFromObservation({ id, ...safe });

    // analytics/event hooks
    this._eventBus.emit?.('price.observed', {
      id, upc: safe.upc, storeId: safe.storeId, price: safe.price, unitPrice: safe.unitPrice,
      weekOf: safe.weekOf, brand: safe.brand, category: safe.category, trustScore: safe.trustScore,
    });

    return id;
  }

  /**
   * Upsert an accelerated “current best known” record for fast UI read.
   * Prefers freshest observation; if tie, prefers higher trustScore.
   * Links a single sourceAttributionId (UI can expand via source_attributions table).
   * @param {Object} obs
   */
  async _upsertPricebookItemFromObservation(obs) {
    if (!obs || !obs.upc || !obs.storeId) return;

    const existing = await this.pricebook_items
      .where('[storeId+upc]')
      .equals([obs.storeId, obs.upc])
      .first();

    const candidate = {
      storeId: obs.storeId,
      productId: obs.productId,
      upc: obs.upc,
      gtin: obs.gtin ?? null,
      sku: obs.sku ?? null,
      updatedAt: iso(new Date()),
      preferred: true,
      deleted: false,
      sourceAttributionId: null, // can be set by SourceAttribution UI
      // Denormalized display essentials
      price: coalescePrice(obs),
      unitPrice: obs.unitPrice ?? computeUnitPrice(obs.price, obs.qty),
      currency: obs.currency ?? 'USD',
      packageSize: obs.packageSize ?? null,
      brand: obs.brand ?? null,
      category: obs.category ?? null,
    };

    if (!existing) {
      await this.pricebook_items.add(candidate);
      return;
    }

    const chooseNew =
      (new Date(obs.dateObserved).getTime() > new Date(existing.updatedAt || 0).getTime()) ||
      ((new Date(obs.dateObserved).getTime() === new Date(existing.updatedAt || 0).getTime()) &&
        (Number(obs.trustScore || 0) > Number(existing.trustScore || 0)));

    if (chooseNew) {
      await this.pricebook_items.update(existing.id, candidate);
    }
  }

  /**
   * Mark/unmark a user favorite session.
   */
  async setFavoriteSession({ userId, sessionId, favorite = true }) {
    if (!userId || !sessionId) return;
    const key = await this.favorites_sessions.where('[userId+sessionId]').equals([userId, sessionId]).first();
    if (favorite && !key) {
      await this.favorites_sessions.add({ userId, sessionId, createdAt: iso(new Date()), tags: [] });
      this._eventBus.emit?.('session.favorited', { userId, sessionId });
    } else if (!favorite && key) {
      await this.favorites_sessions.delete(key.id);
      this._eventBus.emit?.('session.unfavorited', { userId, sessionId });
    }
  }

  /**
   * Mark/unmark a user favorite schedule.
   */
  async setFavoriteSchedule({ userId, scheduleId, favorite = true }) {
    if (!userId || !scheduleId) return;
    const key = await this.favorites_schedules.where('[userId+scheduleId]').equals([userId, scheduleId]).first();
    if (favorite && !key) {
      await this.favorites_schedules.add({ userId, scheduleId, createdAt: iso(new Date()), tags: [] });
      this._eventBus.emit?.('schedule.favorited', { userId, scheduleId });
    } else if (!favorite && key) {
      await this.favorites_schedules.delete(key.id);
      this._eventBus.emit?.('schedule.unfavorited', { userId, scheduleId });
    }
  }

  /**
   * Attach attribution entries to any entity (obs, pricebook item, coupon, circular)
   * so SourceAttribution.jsx can render badges.
   */
  async addAttributions(entityType, entityId, attributions = []) {
    if (!entityType || !entityId || !Array.isArray(attributions) || !attributions.length) return [];
    const ts = iso(new Date());
    const rows = attributions.map(a => ({
      entityType,
      entityId,
      sourceName: a.sourceName ?? 'unknown',
      sourceType: a.sourceType ?? 'provider',
      weight: numOr(a.weight, 1),
      updatedAt: ts,
      tags: a.tags ?? [],
      deleted: false,
    }));
    const ids = await this.source_attributions.bulkAdd(rows);
    this._eventBus.emit?.('attribution.added', { entityType, entityId, count: rows.length });
    return ids;
  }
}

// --------- helpers ---------

function startOfWeek(d, dow = 0) { // 0 = Sunday, 1 = Monday (customize if needed)
  const x = new Date(d);
  const day = x.getDay();
  const diff = (day < dow ? 7 : 0) + day - dow;
  x.setDate(x.getDate() - diff);
  x.setHours(0, 0, 0, 0);
  return x;
}
const iso = (v) => (v instanceof Date ? v.toISOString() : (v || null));
const numOr = (v, fb) => (v == null || Number.isNaN(Number(v)) ? fb : Number(v));
const numOrNull = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function computeUnitPrice(price, qty) {
  if (price == null) return null;
  const q = Number(qty || 1);
  return q ? Number(price) / q : Number(price);
}

function coalesceUPC(upc, gtin, sku) {
  return upc || gtin || sku || null;
}

function coalescePrice(obs) {
  // prefer promoPrice if sensible; else price; else regular
  if (obs?.promoPrice != null) return Number(obs.promoPrice);
  if (obs?.price != null) return Number(obs.price);
  if (obs?.regularPrice != null) return Number(obs.regularPrice);
  return null;
}

function estimateTrust(raw) {
  // Simple heuristic; expand with OCR quality, provider reputation, etc.
  let t = 0.5;
  if (raw.observationType === 'api') t += 0.2;
  if (raw.observationType === 'scan') t += 0.1;
  if (raw.assetId && raw.ocrId) t += 0.1;
  return clamp01(t);
}

// Singleton instance for app usage
export const pricebookDB = new PricebookDB();

// Optional factory if you need a namespaced DB (e.g., per household sandbox)
export const createPricebookDB = (opts) => new PricebookDB(opts);

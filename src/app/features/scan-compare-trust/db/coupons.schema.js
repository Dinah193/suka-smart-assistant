/* eslint-disable no-console */
// coupons.schema.js — Dexie DB for Coupons: saved clips, redemptions, expiries
// Style: versioned, defensive, event-friendly; JS + JSDoc for DX.
//
// Integrates with:
//  - pricebook.schema (products, price_observations, discount_cycles, source_attributions)
//  - CouponService (provider sync, stacking, eligibility)
//  - CycleAnalyzer (cadence learning)
//  - useCouponPrefs (user/household loyalty & opt-ins)
//  - events.catalog (coupon.* events)
//
// If you're already using pricebookDB.coupons, keep that for "catalog"
// records and use this DB for user-centric clip/redemption/expiry workflow,
// or use only this DB for all coupon data. Both approaches are supported.

import Dexie from 'dexie';

export class CouponsDB extends Dexie {
  /** @type {Dexie.Table} */ coupons;            // catalog + user notes
  /** @type {Dexie.Table} */ clipped;            // user clips ("My coupons")
  /** @type {Dexie.Table} */ redemptions;        // redemption logs
  /** @type {Dexie.Table} */ provider_syncs;     // sync cursors & audit
  /** @type {Dexie.Table} */ attribution;       // optional source links (UI badges)

  /**
   * @param {Object} [opts]
   * @param {string} [opts.name]           optional DB name override
   * @param {{emit?:Function}} [opts.eventBus] optional event emitter
   */
  constructor(opts = {}) {
    super(opts.name || 'SUKA_COUPONS_DB');
    this._eventBus = opts.eventBus?.emit ? opts.eventBus : { emit: () => {} };

    // v1 — core tables
    this.version(1).stores({
      // Coupons catalog (provider or system-provided)
      // Note: use stackHash to coalesce variants of the "same" benefit/terms
      coupons:
        '++id, provider, providerId, chain, storeId, ' +
        'upc, gtin, sku, brand, category, tags, ' +
        'startsOn, endsOn, status, ' +
        'stackType, stackHash, termsHash, ' +
        'lastSeen, updatedAt, deleted',

      // User clipped coupons (multiple users/households possible)
      clipped:
        '++id, userId, householdId, couponId, ' +
        // effective window narrowed by provider-clip if applicable
        'clippedAt, clipSource, clipRef, ' +
        'status, // active|void|redeemed|expired' +
        'expiresOn, ' +
        '[userId+couponId], [householdId+couponId], [userId+status]', // fast lookups

      // Redemption logs (line items)
      redemptions:
        '++id, userId, householdId, couponId, clippedId, ' +
        'storeId, transactionId, redeemedAt, ' +
        'discountValue, currency, qtyApplied, ' +
        'lineUpc, lineSku, tags, [userId+redeemedAt], [couponId+redeemedAt]',

      // Provider sync cursors + audit trail
      provider_syncs:
        '++id, provider, scope, userId, householdId, ' +
        'cursor, lastRunAt, success, message',

      // Optional source attributions for UI badges
      attribution:
        '++id, entityType, entityId, sourceName, sourceType, weight, updatedAt, tags',
    });

    // v2 — eligibility + stacking flags for smarter UI and service
    this.version(2).stores({
      coupons:
        '++id, provider, providerId, chain, storeId, ' +
        'upc, gtin, sku, brand, category, tags, ' +
        'startsOn, endsOn, status, ' +
        'stackType, stackHash, termsHash, ' +
        'lastSeen, updatedAt, deleted, ' +
        // new lookup/filters
        'minSpend, minQty, memberOnly, pickupOnly, inStoreOnly, onlineOnly, onePerTransaction, onePerAccount',
      clipped:
        '++id, userId, householdId, couponId, clippedAt, clipSource, clipRef, status, expiresOn, ' +
        'onePerTransaction, onePerAccount, [userId+couponId], [householdId+couponId], [userId+status]',
    }).upgrade(async (tx) => {
      await tx.table('coupons').toCollection().modify((c) => {
        c.minSpend ??= null;
        c.minQty ??= null;
        c.memberOnly ??= false;
        c.pickupOnly ??= false;
        c.inStoreOnly ??= false;
        c.onlineOnly ??= false;
        c.onePerTransaction ??= false;
        c.onePerAccount ??= false;
      });
      await tx.table('clipped').toCollection().modify((r) => {
        r.onePerTransaction ??= false;
        r.onePerAccount ??= false;
      });
    });

    // v3 — richer value model (amount, type) + product match rules
    this.version(3).stores({
      coupons:
        '++id, provider, providerId, chain, storeId, ' +
        'upc, gtin, sku, brand, category, tags, ' +
        'startsOn, endsOn, status, ' +
        'valueType, // amount|percent|bogo|bundle' +
        'value,     // numeric amount or percent' +
        'bundleQty, bundlePrice, // for bundle math' +
        'stackType, stackHash, termsHash, ' +
        'matchAnyUpc, matchAllTags, excludeTags, ' +
        'lastSeen, updatedAt, deleted, ' +
        'minSpend, minQty, memberOnly, pickupOnly, inStoreOnly, onlineOnly, onePerTransaction, onePerAccount',
    }).upgrade(async (tx) => {
      await tx.table('coupons').toCollection().modify((c) => {
        c.valueType ??= 'amount';
        c.value ??= null;
        c.bundleQty ??= null;
        c.bundlePrice ??= null;
        c.matchAnyUpc ??= [];  // array<string>
        c.matchAllTags ??= []; // array<string>
        c.excludeTags ??= [];  // array<string>
      });
    });

    // v4 — soft delete on clipped & redemptions; attribution soft delete
    this.version(4).stores({
      clipped:
        '++id, userId, householdId, couponId, clippedAt, clipSource, clipRef, status, expiresOn, ' +
        'onePerTransaction, onePerAccount, deleted, [userId+couponId], [householdId+couponId], [userId+status]',
      redemptions:
        '++id, userId, householdId, couponId, clippedId, storeId, transactionId, redeemedAt, ' +
        'discountValue, currency, qtyApplied, lineUpc, lineSku, tags, deleted, [userId+redeemedAt], [couponId+redeemedAt]',
      attribution:
        '++id, entityType, entityId, sourceName, sourceType, weight, updatedAt, tags, deleted',
    }).upgrade(async (tx) => {
      await tx.table('clipped').toCollection().modify((r) => { r.deleted ??= false; });
      await tx.table('redemptions').toCollection().modify((r) => { r.deleted ??= false; });
      await tx.table('attribution').toCollection().modify((r) => { r.deleted ??= false; });
    });

    // Wire handles
    this.coupons = this.table('coupons');
    this.clipped = this.table('clipped');
    this.redemptions = this.table('redemptions');
    this.provider_syncs = this.table('provider_syncs');
    this.attribution = this.table('attribution');

    // Notifications
    this.on('ready', async () => {
      this._eventBus.emit?.('db.ready', { db: 'SUKA_COUPONS_DB' });
      return true;
    });
  }

  // ---------- Helpers for orchestration ----------

  /**
   * Upsert/merge a coupon catalog record from a provider feed or system source.
   * Returns the coupon id.
   */
  async upsertCoupon(raw = {}) {
    const nowISO = new Date().toISOString();

    // Normalize and hash for dedupe
    const normalized = {
      provider: raw.provider ?? 'unknown',
      providerId: raw.providerId ?? null,
      chain: raw.chain ?? null,
      storeId: raw.storeId ?? null,

      upc: raw.upc ?? null,
      gtin: raw.gtin ?? null,
      sku: raw.sku ?? null,
      brand: raw.brand ?? null,
      category: raw.category ?? null,
      tags: Array.isArray(raw.tags) ? raw.tags : [],

      startsOn: iso(raw.startsOn),
      endsOn: iso(raw.endsOn),
      status: raw.status ?? 'active',

      valueType: raw.valueType ?? 'amount', // amount|percent|bogo|bundle
      value: numOrNull(raw.value),
      bundleQty: numOrNull(raw.bundleQty),
      bundlePrice: numOrNull(raw.bundlePrice),

      stackType: raw.stackType ?? 'combinable', // combinable|exclusive|store-only|mfr-only
      termsHash: raw.termsHash ?? hashTerms(raw.terms ?? {}),
      stackHash: raw.stackHash ?? hashStack(raw),

      matchAnyUpc: Array.isArray(raw.matchAnyUpc) ? raw.matchAnyUpc : [],
      matchAllTags: Array.isArray(raw.matchAllTags) ? raw.matchAllTags : [],
      excludeTags: Array.isArray(raw.excludeTags) ? raw.excludeTags : [],

      minSpend: numOrNull(raw.minSpend),
      minQty: numOrNull(raw.minQty),
      memberOnly: !!raw.memberOnly,
      pickupOnly: !!raw.pickupOnly,
      inStoreOnly: !!raw.inStoreOnly,
      onlineOnly: !!raw.onlineOnly,
      onePerTransaction: !!raw.onePerTransaction,
      onePerAccount: !!raw.onePerAccount,

      lastSeen: nowISO,
      updatedAt: nowISO,
      deleted: !!raw.deleted,
    };

    // Dedupe by (provider, providerId) or fallback to (stackHash, provider)
    let existing = null;
    if (normalized.provider && normalized.providerId) {
      existing = await this.coupons.where({ provider: normalized.provider, providerId: normalized.providerId }).first();
    }
    if (!existing && normalized.stackHash) {
      existing = await this.coupons.where({ provider: normalized.provider, stackHash: normalized.stackHash }).first();
    }

    if (existing) {
      await this.coupons.update(existing.id, normalized);
      return existing.id;
    }
    return this.coupons.add(normalized);
  }

  /**
   * Clip a coupon to a user's wallet.
   */
  async clipCoupon({ userId, householdId, couponId, clipSource = 'manual', clipRef = null }) {
    if (!userId || !couponId) return null;
    const coupon = await this.coupons.get(couponId);
    if (!coupon) return null;

    const existing = await this.clipped.where('[userId+couponId]').equals([userId, couponId]).first();
    const expiresOn = coupon.endsOn || null;

    if (existing && !existing.deleted) {
      // Already clipped — update window/status if needed
      await this.clipped.update(existing.id, {
        status: 'active',
        expiresOn,
        onePerTransaction: !!coupon.onePerTransaction,
        onePerAccount: !!coupon.onePerAccount,
        deleted: false,
      });
      this._eventBus.emit?.('coupon.clipped', { userId, couponId, clippedId: existing.id, repeat: true });
      return existing.id;
    }

    const id = await this.clipped.add({
      userId,
      householdId: householdId ?? null,
      couponId,
      clippedAt: new Date().toISOString(),
      clipSource,
      clipRef,
      status: 'active',
      expiresOn,
      onePerTransaction: !!coupon.onePerTransaction,
      onePerAccount: !!coupon.onePerAccount,
      deleted: false,
    });

    this._eventBus.emit?.('coupon.clipped', { userId, couponId, clippedId: id });
    return id;
  }

  /**
   * Unclip (soft-delete) a coupon from a user's wallet.
   */
  async unclipCoupon({ userId, couponId }) {
    if (!userId || !couponId) return;
    const row = await this.clipped.where('[userId+couponId]').equals([userId, couponId]).first();
    if (!row) return;
    await this.clipped.update(row.id, { status: 'void', deleted: true });
    this._eventBus.emit?.('coupon.unclipped', { userId, couponId, clippedId: row.id });
  }

  /**
   * Log a redemption and mark the clip accordingly.
   */
  async markRedeemed({
    userId,
    householdId = null,
    couponId,
    clippedId = null,
    storeId = null,
    transactionId = null,
    redeemedAt = new Date(),
    discountValue = null,
    currency = 'USD',
    qtyApplied = 1,
    lineUpc = null,
    lineSku = null,
    tags = [],
  }) {
    if (!userId || !couponId) return null;

    // Prefer supplied clippedId, otherwise find the active clip
    let clipRow = clippedId ? await this.clipped.get(clippedId) : null;
    if (!clipRow) {
      clipRow = await this.clipped
        .where('[userId+couponId]')
        .equals([userId, couponId])
        .filter(r => r.status === 'active' && !r.deleted)
        .first();
    }

    const redemptionId = await this.redemptions.add({
      userId,
      householdId,
      couponId,
      clippedId: clipRow?.id ?? null,
      storeId,
      transactionId,
      redeemedAt: iso(redeemedAt),
      discountValue: numOrNull(discountValue),
      currency,
      qtyApplied: numOrNull(qtyApplied) ?? 1,
      lineUpc,
      lineSku,
      tags,
      deleted: false,
    });

    // Update the clip status (onePerTransaction/Account short-circuit)
    if (clipRow) {
      const closeOut = clipRow.onePerAccount ? 'redeemed' : 'active';
      await this.clipped.update(clipRow.id, { status: closeOut });
    }

    this._eventBus.emit?.('coupon.redeemed', { userId, couponId, redemptionId, storeId, transactionId });
    return redemptionId;
  }

  /**
   * Expire all coupons & clips that are past their end date (or custom expiresOn).
   * Emits coupon.expired for clips.
   */
  async sweepExpiries(now = new Date()) {
    const nowISO = now.toISOString();

    // Expire clipped rows
    const clips = await this.clipped
      .filter(c => !c.deleted && c.status === 'active' && c.expiresOn && c.expiresOn < nowISO)
      .toArray();

    for (const c of clips) {
      await this.clipped.update(c.id, { status: 'expired' });
      this._eventBus.emit?.('coupon.expired', { userId: c.userId, couponId: c.couponId, clippedId: c.id });
    }

    // Mark catalog coupons as inactive if beyond endsOn
    const catalog = await this.coupons
      .filter(k => k.status === 'active' && k.endsOn && k.endsOn < nowISO)
      .toArray();

    for (const k of catalog) {
      await this.coupons.update(k.id, { status: 'inactive', updatedAt: nowISO });
    }

    return { clipsExpired: clips.length, catalogInactivated: catalog.length };
  }

  /**
   * Quick eligibility check for a coupon against cart/context.
   * Intended for prefiltering before stack evaluation.
   */
  async isEligible(couponId, {
    member = true,
    channel = 'inStore', // inStore|online|pickup
    spend = 0,
    qty = 1,
    upcsInCart = [],
    tagsInCart = [],
    date = new Date(),
  } = {}) {
    const c = await this.coupons.get(couponId);
    if (!c) return { ok: false, reason: 'not_found' };

    const nowISO = iso(date);
    if (c.startsOn && nowISO < c.startsOn) return { ok: false, reason: 'not_started' };
    if (c.endsOn && nowISO > c.endsOn) return { ok: false, reason: 'ended' };
    if (c.status !== 'active') return { ok: false, reason: 'inactive' };
    if (c.memberOnly && !member) return { ok: false, reason: 'member_only' };

    if (c.inStoreOnly && channel !== 'inStore') return { ok: false, reason: 'instore_only' };
    if (c.onlineOnly && channel !== 'online') return { ok: false, reason: 'online_only' };
    if (c.pickupOnly && channel !== 'pickup') return { ok: false, reason: 'pickup_only' };

    if (c.minSpend != null && spend < Number(c.minSpend)) return { ok: false, reason: 'min_spend' };
    if (c.minQty != null && qty < Number(c.minQty)) return { ok: false, reason: 'min_qty' };

    // Product match logic (UPC OR tags), then excludeTags
    const upcPass = !c.matchAnyUpc?.length || intersects(upcsInCart, c.matchAnyUpc);
    if (!upcPass) return { ok: false, reason: 'no_upc_match' };

    const tagsPass = (c.matchAllTags?.length ? includesAll(tagsInCart, c.matchAllTags) : true)
                  && (c.excludeTags?.length ? !intersects(tagsInCart, c.excludeTags) : true);
    if (!tagsPass) return { ok: false, reason: 'tag_rules' };

    return { ok: true, reason: 'eligible' };
  }

  /**
   * Find stack candidates by stackHash & time window. Use after pre-eligibility filtering.
   */
  async findStackCandidates({ provider, stackHash, upc = null, date = new Date() }) {
    const nowISO = iso(date);
    const q = this.coupons
      .where({ provider, stackHash })
      .filter(c =>
        c.status === 'active' &&
        (!c.startsOn || c.startsOn <= nowISO) &&
        (!c.endsOn || c.endsOn >= nowISO) &&
        (!upc || c.upc === upc || (c.matchAnyUpc?.includes?.(upc)))
      );

    return q.toArray();
  }

  /**
   * Sync a batch of provider coupons with upsert, delete missing (optional).
   * Emits coupon.synced once finished.
   */
  async ingestProviderFeed({ provider, items = [], scope = 'global', userId = null, householdId = null, deleteMissing = false }) {
    const seenIds = new Set();

    await this.transaction('rw', [this.coupons, this.provider_syncs], async () => {
      for (const raw of items) {
        const id = await this.upsertCoupon({ ...raw, provider });
        seenIds.add(id);
      }

      if (deleteMissing) {
        const all = await this.coupons.where({ provider }).toArray();
        const toDelete = all.filter(c => !seenIds.has(c.id));
        for (const c of toDelete) {
          await this.coupons.update(c.id, { deleted: true, status: 'inactive', updatedAt: new Date().toISOString() });
        }
      }

      // Audit
      await this.provider_syncs.add({
        provider,
        scope,
        userId,
        householdId,
        cursor: null,
        lastRunAt: new Date().toISOString(),
        success: true,
        message: `Synced ${items.length} items${deleteMissing ? `; deleted ${seenIds.size ? (Math.max(0, all?.length - seenIds.size)) : 0}` : ''}`,
      });
    });

    this._eventBus.emit?.('coupon.synced', { provider, count: items.length, scope });
  }

  /**
   * Add attributions for UI badges (SourceAttribution component).
   */
  async addAttributions(entityType, entityId, attributions = []) {
    if (!entityType || !entityId || !Array.isArray(attributions) || !attributions.length) return [];
    const ts = new Date().toISOString();
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
    return this.attribution.bulkAdd(rows);
  }
}

// ----------------- Utils -----------------

const iso = (v) => (v instanceof Date ? v.toISOString() : (typeof v === 'string' ? v : null));
const numOr = (v, fb) => (v == null || Number.isNaN(Number(v)) ? fb : Number(v));
const numOrNull = (v) => (v == null || Number.isNaN(Number(v)) ? null : Number(v));
const intersects = (a = [], b = []) => {
  if (!a?.length || !b?.length) return false;
  const set = new Set(a);
  return b.some(x => set.has(x));
};
const includesAll = (have = [], need = []) => need.every(t => have.includes(t));

function hashTerms(termsObj) {
  try {
    const s = JSON.stringify(termsObj || {}, Object.keys(termsObj || {}).sort());
    return simpleHash(s);
  } catch {
    return simpleHash(String(termsObj));
  }
}

function hashStack(raw = {}) {
  // Provider + normalized value + key product rules + exclusivity → stable hash
  const base = JSON.stringify({
    provider: raw.provider ?? 'unknown',
    chain: raw.chain ?? null,
    storeId: raw.storeId ?? null,
    valueType: raw.valueType ?? 'amount',
    value: numOrNull(raw.value),
    stackType: raw.stackType ?? 'combinable',
    minSpend: numOrNull(raw.minSpend),
    minQty: numOrNull(raw.minQty),
    matchAnyUpc: (raw.matchAnyUpc || []).slice().sort(),
    matchAllTags: (raw.matchAllTags || []).slice().sort(),
    excludeTags: (raw.excludeTags || []).slice().sort(),
    onePerTransaction: !!raw.onePerTransaction,
    onePerAccount: !!raw.onePerAccount,
  });
  return simpleHash(base);
}

function simpleHash(s) {
  // Fast non-crypto hash for coalescing; ok for client-side keys
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(36);
}

// Singleton
export const couponsDB = new CouponsDB();

// Optional factory (e.g., for tests or per-household sandboxing)
export const createCouponsDB = (opts) => new CouponsDB(opts);

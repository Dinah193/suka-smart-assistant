/* eslint-disable no-console */
// migrations.js — Versioned Dexie migrations (Scan • Compare • Trust)
//
// Goals:
//  - Run idempotent data migrations across multiple Dexie DBs (pricebook, coupons, cycles)
//  - Persist a global "applied migrations" ledger so each migration runs exactly once
//  - Emit events for orchestration (toasts, logs, NBA), be resilient to partial datasets
//  - Honor user-centric features (favorites for sessions/schedules) & cycle learning
//
// Usage:
//   import { runMigrations } from './migrations';
//   import { pricebookDB } from './pricebook.schema';
//   import { couponsDB }   from './coupons.schema';
//   import { cyclesDB }    from './cycles.schema';
//   await runMigrations({ pricebookDB, couponsDB, cyclesDB, eventBus });
//
// Notes:
//  - Migrations are chunked to avoid blocking the UI thread on large stores.
//  - Each migration must be idempotent and guarded (re-checks data before writing).
//  - Add new migrations to MIGRATIONS[] with a unique id and clear description.

import Dexie from 'dexie';
import { pricebookDB as defaultPricebookDB } from './pricebook.schema';
import { couponsDB   as defaultCouponsDB }   from './coupons.schema';
import { cyclesDB    as defaultCyclesDB }    from './cycles.schema';

// ---------- Global migration ledger DB ----------
class SukaMigrationsDB extends Dexie {
  /** @type {Dexie.Table} */ applied_migrations;
  constructor(name = 'SUKA_MIGRATIONS_DB') {
    super(name);
    this.version(1).stores({
      // id is unique migration key (e.g., '2025-10-26-price-normalization')
      applied_migrations: 'id, appliedAt, scope, desc, ok, error',
    });
    this.applied_migrations = this.table('applied_migrations');
  }
}
export const migrationsDB = new SukaMigrationsDB();

// ---------- Utilities ----------
const iso = (v) => (v instanceof Date ? v.toISOString() : new Date(v || Date.now()).toISOString());
const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const chunk = (arr, n = 500) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
function computeUnitPrice(price, qty) {
  if (price == null) return null;
  const q = Number(qty || 1);
  return q ? Number(price) / q : Number(price);
}
function isPromo(o) {
  const p = Number(o.promoPrice ?? o.price ?? NaN);
  const r = Number(o.regularPrice ?? o.price ?? NaN);
  return Number.isFinite(p) && Number.isFinite(r) && p < r;
}

// Wrap a migration to ensure it runs at most once
async function applyOnce({ id, desc, scope = 'global', eventBus, fn }) {
  const exists = await migrationsDB.applied_migrations.get(id);
  if (exists?.ok) {
    eventBus?.emit?.('migration.skipped', { id, desc, scope });
    return { skipped: true };
  }
  const start = Date.now();
  try {
    await fn();
    const row = { id, appliedAt: iso(new Date()), scope, desc, ok: true, error: null };
    await migrationsDB.applied_migrations.put(row);
    eventBus?.emit?.('migration.applied', { id, ms: Date.now() - start });
    return { ok: true };
  } catch (err) {
    console.error(`[migration:${id}] failed`, err);
    const row = { id, appliedAt: iso(new Date()), scope, desc, ok: false, error: String(err?.message || err) };
    await migrationsDB.applied_migrations.put(row);
    eventBus?.emit?.('migration.failed', { id, error: row.error });
    throw err;
  }
}

// ---------- Migrations list ----------
// Add new objects to this array to define future migrations.
// Each fn must be idempotent.
const MIGRATIONS = [
  {
    id: '2025-10-26-price-normalization',
    desc: 'Backfill trust/confidence/currency/unit fields + unitPrice on price_observations (v2 parity).',
    scope: 'pricebook',
    async fn(ctx) {
      const db = ctx.pricebookDB;
      if (!db?.price_observations) return;

      const toFix = await db.price_observations
        .filter(o => (o.trustScore == null) || (o.confidence == null) || (o.currency == null) || (o.unitPrice == null))
        .toArray();

      for (const group of chunk(toFix, 1000)) {
        await db.transaction('rw', db.price_observations, async () => {
          for (const o of group) {
            const patch = {
              trustScore: o.trustScore ?? 0.5,
              confidence: o.confidence ?? 0.5,
              currency: o.currency ?? 'USD',
              qty: o.qty ?? 1,
              unit: o.unit ?? 'ea',
            };
            patch.unitPrice = o.unitPrice ?? computeUnitPrice(o.price ?? o.promoPrice ?? o.regularPrice, patch.qty);
            await db.price_observations.update(o.id, patch);
          }
        });
        await sleep(5);
      }
      ctx.eventBus?.emit?.('price.normalized', { count: toFix.length });
    },
  },
  {
    id: '2025-10-26-pricebook-rebuild-current',
    desc: 'Rebuild pricebook_items “current best known” from latest/highest-trust observations.',
    scope: 'pricebook',
    async fn(ctx) {
      const db = ctx.pricebookDB;
      if (!db?.price_observations || !db?.pricebook_items) return;

      // Clear existing accelerated view
      await db.pricebook_items.clear();

      // Group by [storeId+upc]; pick newest, then higher trust
      const all = await db.price_observations
        .filter(o => !!o.storeId && !!o.upc && !o.deleted)
        .toArray();

      // Map best candidate per key
      const best = new Map();
      for (const o of all) {
        const k = `${o.storeId}::${o.upc}`;
        const prev = best.get(k);
        const ts = new Date(o.dateObserved || o.weekOf || o.updatedAt || o.createdAt || 0).getTime();
        const prevTs = prev ? new Date(prev.dateObserved || prev.weekOf || prev.updatedAt || prev.createdAt || 0).getTime() : -1;
        const choose = ts > prevTs || (ts === prevTs && (Number(o.trustScore || 0) > Number(prev?.trustScore || 0)));
        if (!prev || choose) best.set(k, o);
      }

      // Insert candidates
      for (const group of chunk(Array.from(best.values()), 1000)) {
        await db.transaction('rw', db.pricebook_items, async () => {
          for (const o of group) {
            const candidate = {
              storeId: o.storeId,
              productId: o.productId ?? null,
              upc: o.upc,
              gtin: o.gtin ?? null,
              sku: o.sku ?? null,
              updatedAt: iso(new Date()),
              preferred: true,
              deleted: false,
              sourceAttributionId: null,
              price: Number(o.promoPrice ?? o.price ?? o.regularPrice ?? null),
              unitPrice: o.unitPrice ?? computeUnitPrice(o.price ?? o.promoPrice ?? o.regularPrice, o.qty ?? 1),
              currency: o.currency ?? 'USD',
              packageSize: o.packageSize ?? null,
              brand: o.brand ?? null,
              category: o.category ?? null,
            };
            await db.pricebook_items.add(candidate);
          }
        });
        await sleep(5);
      }
      ctx.eventBus?.emit?.('pricebook.rebuilt', { keys: best.size });
    },
  },
  {
    id: '2025-10-26-coupons-expiry-sweep',
    desc: 'Expire stale clipped coupons and inactivate ended catalog coupons.',
    scope: 'coupons',
    async fn(ctx) {
      const db = ctx.couponsDB;
      if (!db?.sweepExpiries) return;
      const result = await db.sweepExpiries(new Date());
      ctx.eventBus?.emit?.('coupons.swept', result);
    },
  },
  {
    id: '2025-10-27-favorites-visibility-defaults',
    desc: 'Ensure sessions/schedules have visibility defaults; clean favorites integrity.',
    scope: 'pricebook',
    async fn(ctx) {
      const db = ctx.pricebookDB;
      if (!db?.sessions || !db?.schedules || !db?.favorites_sessions || !db?.favorites_schedules) return;

      // Backfill visibility
      const ses = await db.sessions.filter(r => r.visibility == null).toArray();
      const sch = await db.schedules.filter(r => r.visibility == null).toArray();
      await db.transaction('rw', [db.sessions, db.schedules], async () => {
        for (const s of ses) await db.sessions.update(s.id, { visibility: 'private' });
        for (const s of sch) await db.schedules.update(s.id, { visibility: 'private' });
      });

      // Remove broken favorite pointers (dangling session/schedule)
      const favSes = await db.favorites_sessions.toArray();
      const favSch = await db.favorites_schedules.toArray();
      await db.transaction('rw', [db.favorites_sessions, db.favorites_schedules], async () => {
        for (const f of favSes) {
          const ok = await db.sessions.get(f.sessionId);
          if (!ok) await db.favorites_sessions.delete(f.id);
        }
        for (const f of favSch) {
          const ok = await db.schedules.get(f.scheduleId);
          if (!ok) await db.favorites_schedules.delete(f.id);
        }
      });

      ctx.eventBus?.emit?.('favorites.cleaned', { sessions: ses.length, schedules: sch.length });
    },
  },
  {
    id: '2025-10-27-cycles-derive-from-recent-observations',
    desc: 'Derive promotion windows from recent price observations and update cycle predictions.',
    scope: 'cycles',
    async fn(ctx) {
      const pdb = ctx.pricebookDB;
      const cdb = ctx.cyclesDB;
      if (!pdb?.price_observations || !cdb?.deriveWindowsFromObservations) return;

      // Consider last ~180 days to bootstrap responsibly
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 180);
      const obs = await pdb.price_observations
        .filter(o => !o.deleted && o.dateObserved && new Date(o.dateObserved) >= cutoff)
        .toArray();

      // Group by (storeId, upc) for per-key derivation
      const groups = new Map();
      for (const o of obs) {
        if (!o.storeId || !o.upc) continue;
        const k = `${o.storeId}::upc::${o.upc}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(o);
      }

      let windows = 0;
      for (const [k, list] of groups.entries()) {
        const [storeId, , upc] = k.split('::');
        // Sort by date to feed derivation
        list.sort((a, b) => new Date(a.dateObserved) - new Date(b.dateObserved));
        // Pre-trim to days where promo likely (simple prefilter to reduce work)
        const filtered = list.filter(o => isPromo(o));
        if (!filtered.length) continue;
        const ids = await cdb.deriveWindowsFromObservations({
          storeId, keyType: 'upc', keyValue: upc, observations: filtered, source: 'migration:observations'
        });
        windows += ids.length;
        // Small yield between groups to keep UI responsive
        if (windows % 25 === 0) await sleep(2);
      }
      ctx.eventBus?.emit?.('cycles.bootstrap', { groups: groups.size, windows });
    },
  },
  {
    id: '2025-10-27-cycles-watchlist-autoseed',
    desc: 'Auto-seed watchlists for users who favorited sessions/schedules tagged with shopping/scan.',
    scope: 'cycles',
    async fn(ctx) {
      const pdb = ctx.pricebookDB;
      const cdb = ctx.cyclesDB;
      if (!pdb?.favorites_sessions || !pdb?.sessions || !cdb?.upsertWatch) return;

      // Heuristic: if a favorited session has tags including 'scan', 'compare', or 'shopping',
      // attach a watch on brand/category if available on session meta.
      const favs = await pdb.favorites_sessions.toArray();
      for (const group of chunk(favs, 500)) {
        for (const f of group) {
          const ses = await pdb.sessions.get(f.sessionId);
          if (!ses?.tags?.length) continue;
          const tagset = new Set(ses.tags.map(t => String(t).toLowerCase()));
          const relevant = ['scan', 'compare', 'shopping'].some(t => tagset.has(t));
          if (!relevant) continue;

          const storeId   = ses.meta?.storeId ?? null;
          const brand     = ses.meta?.brand ?? null;
          const category  = ses.meta?.category ?? null;
          const key = brand ? { keyType: 'brand', keyValue: brand }
                    : category ? { keyType: 'category', keyValue: category }
                    : null;
          if (!storeId || !key) continue;

          await cdb.upsertWatch({
            userId: ses.userId ?? f.userId,
            householdId: ses.householdId ?? null,
            storeId,
            ...key,
            rule: 'soon',
            advanceDays: 3,
            active: true,
            visibility: 'private',
            tags: ['autoseed', 'favorites'],
            scheduleId: null,
            sessionId: ses.id,
          });
        }
        await sleep(2);
      }
      ctx.eventBus?.emit?.('cycles.watch.autoseeded', {});
    },
  },
];

// ---------- Runner ----------
export async function runMigrations({
  pricebookDB = defaultPricebookDB,
  couponsDB   = defaultCouponsDB,
  cyclesDB    = defaultCyclesDB,
  eventBus    = { emit: () => {} },
} = {}) {
  const ctx = { pricebookDB, couponsDB, cyclesDB, eventBus };

  // Ensure ledger DB is ready
  await migrationsDB.open().catch((e) => {
    console.error('[migrations] ledger open failed', e);
  });

  // Apply in order
  for (const mig of MIGRATIONS) {
    await applyOnce({ ...mig, eventBus, fn: () => mig.fn(ctx) });
  }

  eventBus?.emit?.('migrations.complete', { count: MIGRATIONS.length });
  return true;
}

// ---------- Introspection helpers ----------
export async function listAppliedMigrations() {
  return migrationsDB.applied_migrations.toArray();
}
export async function resetMigration(id) {
  if (!id) return;
  await migrationsDB.applied_migrations.delete(id);
}
export async function resetAllMigrations() {
  await migrationsDB.applied_migrations.clear();
}

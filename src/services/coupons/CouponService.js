// C:\Users\larho\suka-smart-assistant\src\services\coupons\CouponService.js
// -----------------------------------------------------------------------------
// CouponService
// - Stores coupons
// - Matches coupons by UPC / category / storeKey
// - Stores coupon match results in Dexie
//
// Recommended Dexie tables:
//   coupons: "&id, upc, storeKey, expiresAt, [upc+storeKey]"
//   coupon_matches: "++id, candidateId, upc, storeKey, ts, [candidateId+storeKey]"
//
// Emits:
//   coupons:ingested
//   coupons:matched
// -----------------------------------------------------------------------------

function now() {
  return Date.now();
}
function str(x) {
  const s = String(x ?? "").trim();
  return s ? s : "";
}
function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}
function safeBus(bus) {
  return bus?.emit ? bus : { emit: () => {} };
}
function safeDb(db) {
  return db && typeof db.table === "function" ? db : null;
}
function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

export function createCouponService(deps = {}) {
  const { db = null, eventBus = null, logger = console } = deps;
  const dexie = safeDb(db);
  const bus = safeBus(eventBus);

  const mem = {
    coupons: [],
    matches: [],
  };

  return {
    ingestCoupons,
    matchCouponsForCandidate,
    listCouponsByUpc,
    listCouponMatches,
    clearExpiredCoupons,
  };

  /**
   * Ingest coupons (normalized storage).
   * Coupon shape supported:
   * { id, title, amountOff, pctOff, storeKey?, store?, upc?, category?, expiresAt, code, url, sponsored? }
   */
  async function ingestCoupons(coupons = [], ctx = {}) {
    const list = Array.isArray(coupons) ? coupons : [];
    const normalized = list
      .map((c) => materializeCoupon(c, ctx))
      .filter((c) => c.id);

    if (dexie?.coupons) {
      try {
        await dexie.coupons.bulkPut(normalized);
        bus.emit("coupons:ingested", { count: normalized.length, ts: now() });
        return normalized.length;
      } catch (e) {
        logger?.warn?.(
          "[CouponService] coupons.bulkPut failed, falling back",
          e
        );
      }
    }

    // memory
    for (const c of normalized) {
      const idx = mem.coupons.findIndex((x) => x.id === c.id);
      if (idx >= 0) mem.coupons[idx] = c;
      else mem.coupons.push(c);
    }
    bus.emit("coupons:ingested", { count: normalized.length, ts: now() });
    return normalized.length;
  }

  async function matchCouponsForCandidate({
    candidateId,
    upc,
    category,
    storeKey,
    store,
    limit = 12,
  } = {}) {
    const cid = str(candidateId);
    const u = str(upc);
    const sk =
      str(storeKey) ||
      (store ? `chain:${String(store).toLowerCase().trim()}` : "");
    const cat = str(category);

    const coupons = await selectCoupons({
      upc: u,
      category: cat,
      storeKey: sk,
      store,
    });

    // Simple scoring: upc match > category match > store match > soon expiring
    const scored = coupons
      .map((c) => {
        const score =
          (c.upc && c.upc === u ? 100 : 0) +
          (c.category && cat && c.category === cat ? 35 : 0) +
          (c.storeKey && sk && c.storeKey === sk ? 20 : 0) +
          (c.expiresAt ? Math.max(0, 10 - daysUntil(c.expiresAt)) : 0);
        return { c, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Number(limit) || 12))
      .map((x) => x.c);

    const matchRec = {
      candidateId: cid || null,
      upc: u || null,
      storeKey: sk || null,
      ts: now(),
      coupons: scored,
    };

    await persistMatch(matchRec);

    bus.emit("coupons:matched", {
      candidateId: cid || null,
      upc: u || null,
      storeKey: sk || null,
      count: scored.length,
      ts: now(),
    });

    return scored;
  }

  async function listCouponsByUpc({ upc, storeKey } = {}) {
    const u = str(upc);
    const sk = str(storeKey);

    if (dexie?.coupons) {
      try {
        if (u && dexie.coupons.where) {
          let q = dexie.coupons.where("upc").equals(u);
          if (sk) q = q.and((c) => !c.storeKey || c.storeKey === sk);
          return await q.toArray();
        }
      } catch (e) {
        logger?.warn?.("[CouponService] listCouponsByUpc", e);
      }
    }

    return mem.coupons.filter(
      (c) =>
        (!u ? true : c.upc === u) &&
        (!sk ? true : !c.storeKey || c.storeKey === sk)
    );
  }

  async function listCouponMatches({ candidateId } = {}) {
    const cid = str(candidateId);

    if (dexie?.coupon_matches) {
      try {
        if (!cid)
          return await dexie.coupon_matches
            .orderBy("ts")
            .reverse()
            .limit(50)
            .toArray();
        return await dexie.coupon_matches
          .where("candidateId")
          .equals(cid)
          .toArray();
      } catch (e) {
        logger?.warn?.("[CouponService] listCouponMatches", e);
      }
    }

    if (!cid) return mem.matches.slice(-50);
    return mem.matches.filter((m) => m.candidateId === cid);
  }

  async function clearExpiredCoupons({ beforeTs = now() } = {}) {
    const cutoff = Number(beforeTs) || now();

    if (dexie?.coupons) {
      try {
        const all = await dexie.coupons.toArray();
        const expired = all
          .filter((c) => c.expiresAt && Number(c.expiresAt) <= cutoff)
          .map((c) => c.id);
        await dexie.coupons.bulkDelete(expired);
        return expired.length;
      } catch (e) {
        logger?.warn?.("[CouponService] clearExpiredCoupons", e);
      }
    }

    const before = mem.coupons.length;
    mem.coupons = mem.coupons.filter(
      (c) => !c.expiresAt || Number(c.expiresAt) > cutoff
    );
    return before - mem.coupons.length;
  }

  // -------------------- internals --------------------

  async function selectCoupons({ upc, category, storeKey, store }) {
    const sk =
      str(storeKey) ||
      (store ? `chain:${String(store).toLowerCase().trim()}` : "");

    if (dexie?.coupons) {
      try {
        // broad fetch, filter in memory for simplicity across schemas
        const all = await dexie.coupons.toArray();
        return filterCoupons(all, { upc, category, storeKey: sk });
      } catch (e) {
        logger?.warn?.("[CouponService] selectCoupons", e);
      }
    }
    return filterCoupons(mem.coupons, { upc, category, storeKey: sk });
  }

  function filterCoupons(all, { upc, category, storeKey }) {
    const u = str(upc);
    const cat = str(category);
    const sk = str(storeKey);

    return (Array.isArray(all) ? all : []).filter((c) => {
      const storeOk = !c.storeKey || !sk || c.storeKey === sk;
      const upcOk = !c.upc || !u || c.upc === u;
      const catOk = !c.category || !cat || c.category === cat;
      return storeOk && (upcOk || catOk);
    });
  }

  async function persistMatch(matchRec) {
    // store only lightweight match rows (coupons array can be large; but acceptable for MVP)
    const rec = {
      candidateId: matchRec.candidateId || null,
      upc: matchRec.upc || null,
      storeKey: matchRec.storeKey || null,
      ts: matchRec.ts || now(),
      coupons: Array.isArray(matchRec.coupons) ? matchRec.coupons : [],
    };

    if (dexie?.coupon_matches) {
      try {
        await dexie.coupon_matches.add(rec);
        return;
      } catch (e) {
        logger?.warn?.(
          "[CouponService] coupon_matches.add failed, falling back",
          e
        );
      }
    }
    mem.matches.push({ ...rec, id: mem.matches.length + 1 });
  }

  function materializeCoupon(c, ctx) {
    const o = isObj(c) ? c : {};
    const id = str(o.id || o.couponId || o.code || "");
    if (!id) return null;

    return {
      id,
      title: str(o.title || o.name || "Coupon"),
      amountOff: toNum(o.amountOff ?? o.amount_off),
      pctOff: toNum(o.pctOff ?? o.percent_off ?? o.pct_off),
      storeKey: str(o.storeKey || o.store_key || ctx?.storeKey || "") || null,
      store: str(o.store || ctx?.store || "") || null,
      upc: str(o.upc || ctx?.upc || "") || null,
      category: str(o.category || ctx?.category || "") || null,
      expiresAt: toNum(o.expiresAt ?? o.expires_at) || null,
      code: str(o.code || "") || null,
      url: str(o.url || "") || null,
      sponsored: !!(o.sponsored || o.isSponsored),
      ts: now(),
    };
  }

  function daysUntil(ts) {
    const d = Number(ts) - now();
    return Math.floor(d / (24 * 60 * 60 * 1000));
  }
}

let __couponService;
export function getCouponService(deps) {
  if (!__couponService) __couponService = createCouponService(deps);
  return __couponService;
}

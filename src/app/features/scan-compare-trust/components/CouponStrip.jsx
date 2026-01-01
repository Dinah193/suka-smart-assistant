/* eslint-disable no-console */
/**
 * CouponStrip — Scan • Compare • Trust
 * -----------------------------------------------------------------------------
 * Banner that shows active coupons/discounts for the selected store.
 * - Auto-fetch (if couponService exists) when store changes
 * - Accepts controlled coupons via props; merges/dedupes with fetched
 * - Matches coupons to current offers (UPC/brand/category best-effort)
 * - Quick actions: Clip, Apply, Copy Code, Open Source
 * - Favorites: Save Coupon Run (session) & Weekly Sweep (schedule)
 * - Emits events over eventBus for orchestration; analytics hooks
 *
 * Props:
 *  - store: { id?:string, name?:string, slug?:string }
 *  - offers?: Array<OfferLike>           // optional; used to show “applies to N items”
 *  - coupons?: Array<CouponLike>         // optional; externally provided
 *  - dense?: boolean                     // compact height
 *  - collapsedDefault?: boolean          // banner collapsed by default
 *  - limit?: number                      // max chips visible before "… more"
 *
 * CouponLike (best-effort):
 * {
 *   id, storeId, source?:'StoreApp'|'Web'|'Affiliate'|string,
 *   type:'amount'|'percent'|'bogo'|'bundle'|'freeShip',
 *   value?: number, // amount (USD) or percent (e.g., 15)
 *   code?: string,
 *   title?: string,
 *   description?: string,
 *   minSpend?: number,
 *   stackable?: boolean,
 *   categories?: string[],
 *   brands?: string[],
 *   upcs?: string[],
 *   url?: string,
 *   expiresISO?: string,
 *   clipped?: boolean
 * }
 *
 * OfferLike (best-effort):
 * { upc, brand, name, category, store, price, ... }
 */

import React, { useEffect, useMemo, useState } from "react";

/* ----------------------------- Optional dependencies ----------------------------- */
let eventBus = { emit: () => {}, on: () => {}, off: () => {} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let analytics = { track: () => {} };
try {
  const a = require("@/services/analytics");
  analytics = (a && (a.default || a.analytics || a)) || analytics;
} catch (_e) {}

let couponService = null; // fetch/clip/track
try {
  couponService = require("@/services/coupons/couponService").default;
} catch (_e) {}

let priceCycle = null; // hints for RRULE or “discount windows”
try {
  priceCycle = require("@/services/pricing/priceCycle").default;
} catch (_e) {}

let useFavoriteSessions = null;
let useFavoriteSchedules = null;
try {
  ({ useFavoriteSessions } = require("@/hooks/useFavoriteSessions"));
} catch (_e) {}
try {
  ({ useFavoriteSchedules } = require("@/hooks/useFavoriteSchedules"));
} catch (_e) {}

/* ---------------------------------- Small helpers ---------------------------------- */
const CURRENCY = "USD";
const fmtMoney = (n, currency = CURRENCY) =>
  typeof n === "number"
    ? new Intl.NumberFormat(undefined, { style: "currency", currency }).format(n)
    : "";

const daysLeft = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const diff = Math.ceil((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  return diff;
};

const badgeTone = (dleft) => {
  if (dleft == null) return "border-gray-300 text-gray-700";
  if (dleft <= 1) return "border-rose-400 text-rose-800";
  if (dleft <= 3) return "border-orange-300 text-orange-700";
  return "border-emerald-300 text-emerald-700";
};

const uniqueById = (arr) => {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const id = x?.id || `${x?.code || ""}-${x?.title || ""}-${x?.expiresISO || ""}`;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ ...x, id });
    }
  }
  return out;
};

const normalizeStoreId = (store) =>
  store?.id || store?.slug || (store?.name ? store.name.toLowerCase().replace(/\s+/g, "-") : null);

/** Naive matching: by UPC -> brand -> category. Returns {couponId: countMatches} */
function matchCouponsToOffers(coupons = [], offers = [], store) {
  const res = new Map();
  const sname = (store?.name || "").toLowerCase();
  for (const c of coupons) {
    let count = 0;
    for (const o of offers || []) {
      if (o?.store && String(o.store).toLowerCase() !== sname) continue; // focus current store
      if (Array.isArray(c.upcs) && c.upcs.includes(o.upc)) { count++; continue; }
      if (Array.isArray(c.brands) && c.brands.map((b)=>b?.toLowerCase()).includes((o.brand||"").toLowerCase())) { count++; continue; }
      if (Array.isArray(c.categories) && c.categories.map((b)=>b?.toLowerCase()).includes((o.category||"").toLowerCase())) { count++; continue; }
    }
    res.set(c.id, count);
  }
  return res;
}

/* ---------------------------------- Chip component ---------------------------------- */
function CouponChip({ c, appliesToCount, onClip, onApply, onCopy, onOpen }) {
  const dleft = daysLeft(c.expiresISO);
  const tone = badgeTone(dleft);
  const label =
    c.type === "amount" ? `−${fmtMoney(c.value)}`
      : c.type === "percent" ? `−${c.value}%`
      : c.type === "bogo" ? "BOGO"
      : c.type === "freeShip" ? "Free Ship"
      : "Deal";

  return (
    <div className={`inline-flex items-center gap-2 border ${tone} rounded-xl px-2.5 py-1.5 mr-2 mb-2`}>
      <span className="text-xs font-semibold">{label}</span>
      {c.code ? <span className="text-[11px] font-mono bg-gray-50 px-1 py-0.5 rounded border">{c.code}</span> : null}
      {appliesToCount > 0 ? (
        <span className="text-[11px] text-gray-600">applies to {appliesToCount}</span>
      ) : null}
      {dleft != null ? (
        <span className="text-[10px] px-1 py-0.5 rounded border">{dleft <= 0 ? "expires today" : `${dleft}d left`}</span>
      ) : null}
      <div className="flex items-center gap-1 pl-1 border-l">
        <button className="text-[11px] px-1.5 py-0.5 rounded border hover:shadow-sm" title="Clip" onClick={onClip}>
          {c.clipped ? "✓ Clipped" : "Clip"}
        </button>
        <button className="text-[11px] px-1.5 py-0.5 rounded border hover:shadow-sm" title="Apply" onClick={onApply}>
          Apply
        </button>
        {c.code ? (
          <button className="text-[11px] px-1.5 py-0.5 rounded border hover:shadow-sm" title="Copy code" onClick={onCopy}>
            Copy
          </button>
        ) : null}
        {c.url ? (
          <button className="text-[11px] px-1.5 py-0.5 rounded border hover:shadow-sm" title="Open" onClick={onOpen}>
            Open
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------- Main ------------------------------------- */
export default function CouponStrip({
  store,
  offers = [],
  coupons: couponsProp = [],
  dense = false,
  collapsedDefault = false,
  limit = 8,
}) {
  const [collapsed, setCollapsed] = useState(collapsedDefault);
  const [loading, setLoading] = useState(false);
  const [coupons, setCoupons] = useState(uniqueById(couponsProp));
  const favSessions = useFavoriteSessions ? useFavoriteSessions() : null;
  const favSchedules = useFavoriteSchedules ? useFavoriteSchedules() : null;

  const storeId = useMemo(() => normalizeStoreId(store), [store]);

  /* ------------------------------- Fetch on store ------------------------------- */
  useEffect(() => {
    let alive = true;
    async function go() {
      if (!storeId || !couponService?.listActiveForStore) {
        setCoupons(uniqueById(couponsProp));
        return;
      }
      setLoading(true);
      try {
        const fetched = await couponService.listActiveForStore(storeId);
        if (!alive) return;
        setCoupons(uniqueById([...(couponsProp || []), ...(fetched || [])]));
        analytics.track("couponstrip_fetched", { storeId, count: fetched?.length || 0 });
      } catch (e) {
        console.error(e);
      } finally {
        if (alive) setLoading(false);
      }
    }
    go();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeId]);

  /* -------------------------- Matching & derived metrics ------------------------- */
  const matchMap = useMemo(() => matchCouponsToOffers(coupons, offers, store), [coupons, offers, store]);

  const sorted = useMemo(() => {
    const arr = coupons.slice();
    // rank: expiring soon first, then matches count desc, then value desc
    arr.sort((a, b) => {
      const dA = daysLeft(a.expiresISO) ?? 999;
      const dB = daysLeft(b.expiresISO) ?? 999;
      if (dA !== dB) return dA - dB;
      const mA = matchMap.get(a.id) || 0;
      const mB = matchMap.get(b.id) || 0;
      if (mA !== mB) return mB - mA;
      const vA = a.type === "amount" ? (a.value || 0) : a.type === "percent" ? (a.value || 0) : 0;
      const vB = b.type === "amount" ? (b.value || 0) : b.type === "percent" ? (b.value || 0) : 0;
      return vB - vA;
    });
    return arr;
  }, [coupons, matchMap]);

  const visible = sorted.slice(0, limit);
  const hiddenCount = Math.max(0, sorted.length - visible.length);

  useEffect(() => {
    if (sorted.length) {
      eventBus.emit("coupons:strip:rendered", {
        storeId, count: sorted.length, topId: sorted[0]?.id, context: "CouponStrip"
      });
    }
  }, [sorted, storeId]);

  /* ----------------------------------- Actions ----------------------------------- */
  const clip = async (c) => {
    try {
      if (couponService?.clip) {
        await couponService.clip(c.id, { storeId });
      }
      analytics.track("coupon_clip", { storeId, couponId: c.id });
      eventBus.emit("coupons:clip", { couponId: c.id, storeId, source: "CouponStrip" });
      setCoupons((prev) => prev.map((x) => (x.id === c.id ? { ...x, clipped: true } : x)));
      eventBus.emit("ui:toast", { type: "success", message: "Coupon clipped." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not clip coupon." });
    }
  };

  const apply = (c) => {
    // If a single best match exists, pass that; else open picker
    const candidates = (offers || []).filter((o) => {
      const sname = (store?.name || "").toLowerCase();
      if (o?.store && String(o.store).toLowerCase() !== sname) return false;
      if (Array.isArray(c.upcs) && c.upcs.includes(o.upc)) return true;
      if (Array.isArray(c.brands) && c.brands.map((b)=>b?.toLowerCase()).includes((o.brand||"").toLowerCase())) return true;
      if (Array.isArray(c.categories) && c.categories.map((b)=>b?.toLowerCase()).includes((o.category||"").toLowerCase())) return true;
      return false;
    });

    if (candidates.length === 1) {
      eventBus.emit("pricing:coupon:apply", { couponId: c.id, offer: candidates[0], storeId, source: "CouponStrip" });
    } else {
      eventBus.emit("pricing:coupon:picker:open", { coupon: c, offers: candidates, storeId, source: "CouponStrip" });
    }
    analytics.track("coupon_apply_click", { storeId, couponId: c.id, candidates: candidates.length });
  };

  const copyCode = async (c) => {
    try {
      if (c.code) await navigator.clipboard.writeText(c.code);
      eventBus.emit("ui:toast", { type: "success", message: "Code copied." });
    } catch (_e) {
      eventBus.emit("ui:toast", { type: "info", message: c.code ? `Code: ${c.code}` : "No code" });
    }
    analytics.track("coupon_copy_code", { storeId, couponId: c.id });
  };

  const openSource = (c) => {
    analytics.track("coupon_open_source", { storeId, couponId: c.id, url: c.url });
    eventBus.emit("coupons:open", { couponId: c.id, url: c.url, source: "CouponStrip" });
    if (c.url && typeof window !== "undefined") {
      try { window.open(c.url, "_blank", "noopener,noreferrer"); } catch (_e) {}
    }
  };

  const clipAll = async () => {
    const unclipped = sorted.filter((c) => !c.clipped);
    if (!unclipped.length) return;
    try {
      if (couponService?.bulkClip) {
        await couponService.bulkClip(unclipped.map((c) => c.id), { storeId });
      } else {
        for (const c of unclipped) await clip(c);
      }
      analytics.track("coupon_clip_all", { storeId, count: unclipped.length });
      eventBus.emit("ui:toast", { type: "success", message: `Clipped ${unclipped.length} coupons.` });
      setCoupons((prev) => prev.map((x) => (unclipped.some((u) => u.id === x.id) ? { ...x, clipped: true } : x)));
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Bulk clip failed." });
    }
  };

  /* ------------------------------- Favorites save -------------------------------- */
  const saveCouponRunSession = async () => {
    const payload = {
      type: "coupon_run",
      label: `Coupon Run — ${store?.name || storeId || "Store"}`,
      items: sorted.map((c) => ({
        couponId: c.id, title: c.title || c.description || c.code || c.type,
        expiresISO: c.expiresISO, code: c.code, value: c.value, type: c.type
      })),
      createdAt: Date.now(),
      source: "CouponStrip",
    };
    try {
      if (favSessions?.add) await favSessions.add(payload);
      else eventBus.emit("favorites:session:add", payload);
      analytics.track("favorites_coupon_run_saved", { storeId, count: sorted.length });
      eventBus.emit("ui:toast", { type: "success", message: "Saved Coupon Run to favorites." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not save Coupon Run." });
    }
  };

  const saveWeeklySweepSchedule = async () => {
    const hint = priceCycle ? priceCycle.getHint({ store: storeId }) : null;
    const rrule = hint?.rrule || "FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0;BYSECOND=0";
    const payload = {
      label: `Weekly coupon sweep — ${store?.name || storeId || "Store"}`,
      when: rrule,
      meta: { storeId, domain: "pricing/coupons" },
      createdAt: Date.now(),
      source: "CouponStrip",
    };
    try {
      if (useFavoriteSchedules) {
        const fav = useFavoriteSchedules();
        if (fav?.add) await fav.add(payload);
        else eventBus.emit("favorites:schedule:add", payload);
      } else {
        eventBus.emit("favorites:schedule:add", payload);
      }
      analytics.track("favorites_weekly_coupon_sweep_saved", { storeId });
      eventBus.emit("ui:toast", { type: "success", message: "We’ll remind you weekly." });
    } catch (e) {
      console.error(e);
      eventBus.emit("ui:toast", { type: "error", message: "Could not save schedule." });
    }
  };

  /* -------------------------------------- UI -------------------------------------- */
  if (!storeId) return null;

  const count = sorted.length;
  const expiringSoon = sorted.filter((c) => (daysLeft(c.expiresISO) ?? 99) <= 3).length;

  return (
    <div className={`w-full mb-3 ${dense ? "" : "mt-2"}`}>
      <div className={`rounded-xl border ${dense ? "p-2" : "p-3"} bg-gradient-to-r from-amber-50 to-amber-100`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Active coupons at {store?.name || storeId}</span>
            <span className="text-[11px] px-1.5 py-0.5 rounded-md border bg-white">
              {loading ? "Loading…" : `${count} found`}
            </span>
            {expiringSoon ? (
              <span className="text-[11px] px-1.5 py-0.5 rounded-md border border-rose-300 text-rose-800 bg-white">
                {expiringSoon} expiring ≤ 3 days
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              className="text-[12px] px-2 py-1 rounded-md border hover:shadow-sm bg-white"
              onClick={clipAll}
              disabled={!count}
              title="Clip all visible"
            >
              Clip all
            </button>
            <button
              className="text-[12px] px-2 py-1 rounded-md border hover:shadow-sm bg-white"
              onClick={saveCouponRunSession}
              disabled={!count}
              title="Save a Favorite Session with these coupons"
            >
              ★ Save Coupon Run
            </button>
            <button
              className="text-[12px] px-2 py-1 rounded-md border hover:shadow-sm bg-white"
              onClick={saveWeeklySweepSchedule}
              title="Create a Favorite Schedule to check this store weekly"
            >
              ⏰ Weekly sweep
            </button>
            <button
              className="text-[12px] px-2 py-1 rounded-md border hover:shadow-sm bg-white"
              onClick={() => setCollapsed((v) => !v)}
              aria-expanded={!collapsed}
              aria-controls="couponstrip-panel"
            >
              {collapsed ? "Show" : "Hide"}
            </button>
          </div>
        </div>

        {!collapsed && (
          <div id="couponstrip-panel" className="mt-2">
            {count ? (
              <div className="flex flex-wrap">
                {visible.map((c) => (
                  <CouponChip
                    key={c.id}
                    c={c}
                    appliesToCount={matchMap.get(c.id) || 0}
                    onClip={() => clip(c)}
                    onApply={() => apply(c)}
                    onCopy={() => copyCode(c)}
                    onOpen={() => openSource(c)}
                  />
                ))}
                {hiddenCount > 0 ? (
                  <button
                    className="text-xs underline ml-1"
                    onClick={() =>
                      eventBus.emit("coupons:list:open", { storeId, source: "CouponStrip" })
                    }
                    title="Open all coupons"
                  >
                    +{hiddenCount} more
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="text-xs text-gray-600 italic">No coupons right now — try a weekly sweep.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

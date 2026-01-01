/* eslint-disable no-console */
// src/features/scan-compare-trust/stores/useCouponPrefs.js
// Opt-ins, linked accounts, loyalty IDs, clipping rules, favorites, export/import,
// and orchestration glue for the coupons step.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* -------------------------------- safe deps -------------------------------- */
let eventBus = { emit(){}, on(){}, off(){} };
try { const eb = require("@/services/eventBus"); eventBus = (eb?.default||eb?.eventBus||eb)||eventBus; } catch (_e) {}

let DexieDB = null;
try { DexieDB = require("@/db")?.default || require("@/db"); } catch (_e) {}

let useAuth = () => ({ user: null, householdId: null });
try { useAuth = require("@/hooks/useAuth")?.default || useAuth; } catch (_e) {}

let useQuietHours = () => ({ enabled:false });
try { useQuietHours = require("@/hooks/useQuietHours")?.default || useQuietHours; } catch (_e) {}

let toast = null;
try { toast = (require("@/components/toast")?.toast) || null; } catch (_e) {}

const nowISO = () => new Date().toISOString();
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));
const toStr = (v)=> (v==null?"":String(v)).trim();

/* --------------------------------- storage --------------------------------- */
const LS_PREFS = "coupon:prefs:v1";
const LS_HUNTS = "coupon:hunts:v1"; // favorite coupon hunts

function lsGet(key, fb) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; } catch { return fb; } }
function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} }

/* ------------------------------- defaults ---------------------------------- */
function defaultPrefs() {
  return {
    version: 1,
    scope: "household", // "household" | "user" (UI hint)
    optIns: {
      autoCheck: true,          // run coupons step automatically
      autoClip: true,           // attempt to clip/apply automatically when provider allows
      shareReceiptScan: false,  // allow parsing past receipts to improve cycles
      dataConsentAtISO: null,   // timestamp when consent captured
    },
    rules: {
      allowStacking: true,            // manufacturer + store + loyalty, when allowed
      allowCashbackStack: true,       // Ibotta/Fetch-style
      preferDigitalOverPaper: true,
      minSavingsPct: 5,               // clip threshold
      maxClippedPerBrand: 5,          // guard spam
      autoApplyAtCheckout: true,      // signal to adapters that auto-apply is okay
    },
    providers: {
      // key -> { linked:boolean, displayName, status:"linked"|"needs_auth"|"error",
      //          tokenMeta?:{exists:boolean, expiresAtISO?}, accountId?, email?, lastLinkedISO? }
      // Filled at runtime via registerProvider() or linkProvider()
    },
    loyalty: {
      // adapterKey|storeId -> { number, alt?, name? }
    },
    // optional quiet-hours for coupon pings
    notifyWindows: [
      // { byweekday:[0..6], start:"08:00", end:"20:30" }
    ],
    updatedISO: nowISO(),
  };
}

/* ------------------------------ Dexie helpers ------------------------------ */
// Optional tables we’ll use if present:
// - DexieDB.kv (space="coupon:prefs") key=`prefs:<ownerKey>` -> value: prefs
// - DexieDB.favorites (type="coupon.hunt") for favorited hunts

async function dbLoadPrefs(ownerKey) {
  if (!DexieDB?.kv) return null;
  try { return await DexieDB.kv.get({ space:"coupon:prefs", key:`prefs:${ownerKey}` }); } catch { return null; }
}
async function dbSavePrefs(ownerKey, prefs) {
  if (!DexieDB?.kv) return;
  try { await DexieDB.kv.put({ space:"coupon:prefs", key:`prefs:${ownerKey}`, value:prefs, updatedAt: Date.now() }); } catch {}
}
async function favSaveHunt(userId, key, payload) {
  if (!DexieDB?.favorites) return;
  try { await DexieDB.favorites.put({ userId:userId||"anon", type:"coupon.hunt", key, payload, createdAt: Date.now() }); } catch {}
}
async function favRemoveHunt(userId, key) {
  if (!DexieDB?.favorites) return;
  try {
    const row = await DexieDB.favorites.where({ userId:userId||"anon", type:"coupon.hunt", key }).first();
    if (row?.id) await DexieDB.favorites.delete(row.id);
  } catch {}
}

/* ------------------------------ provider registry -------------------------- */
/**
 * Lightweight registry describing coupon providers.
 * The pipeline can inspect features to route calls (clip/apply/fetch).
 */
const DEFAULT_PROVIDERS = {
  generic:   { key:"generic",   name:"Generic Coupons", features:["fetch","clip"], oauth:false, version:1 },
  samsclub:  { key:"samsclub",  name:"Sam's Club",      features:["fetch","clip","apply","loyalty"], oauth:true,  version:1 },
  walmart:   { key:"walmart",   name:"Walmart",         features:["fetch","apply"], oauth:false, version:1 },
  target:    { key:"target",    name:"Target Circle",   features:["fetch","clip","apply","loyalty"], oauth:true, version:1 },
  costco:    { key:"costco",    name:"Costco",          features:["fetch"], oauth:false, version:1 },
};

const memProviders = new Map(Object.entries(DEFAULT_PROVIDERS));

export function listCouponProviders() {
  return Array.from(memProviders.values()).sort((a,b)=>a.name.localeCompare(b.name));
}
export function registerCouponProvider(meta) {
  if (!meta?.key) return false;
  const m = { key: String(meta.key), name: meta.name||meta.key, features: meta.features||[], oauth: !!meta.oauth, version: meta.version||1 };
  memProviders.set(m.key, m);
  eventBus.emit("coupon:provider:registered", { provider: m });
  return true;
}

/* ---------------------------------- hunts ---------------------------------- */
// A "coupon hunt" describes a favored search intent the user can re-run/schedule.
function huntKey(q) {
  const k = JSON.stringify({
    store: toStr(q?.store),
    brand: toStr(q?.brand),
    category: toStr(q?.category),
    upc: toStr(q?.upc),
    providers: (q?.providers||[]).sort(),
  });
  return `hunt:${k}`;
}

/* ---------------------------------- hook ----------------------------------- */
/**
 * useCouponPrefs({ scope="household"|"user" })
 * returns {
 *   status, error, prefs,
 *   setPrefs(next), update(patch),
 *   setOptIns(patch), setRules(patch),
 *   linkProvider(key, accountMeta?), unlinkProvider(key),
 *   setLoyalty(forKey, {number,alt,name}), getLoyalty(forKey),
 *   suggestCouponSession(query),                       // emits scheduler-friendly template
 *   buildCouponQuery(context),                         // builds provider+loyalty aware query
 *   hunts: { list(), save(label, query), remove(key), favorite(key), unfavorite(key) },
 *   exportPrefs(), importPrefs(payload)
 * }
 */
export default function useCouponPrefs(opts = {}) {
  const { scope = "household" } = opts;
  const { user, householdId } = useAuth();
  const { enabled: quietHours } = useQuietHours();

  const ownerKey = useMemo(() => scope === "user" ? `user:${user?.id || "anon"}` : `house:${householdId || "default"}`, [scope, user?.id, householdId]);

  const [status, setStatus] = useState("idle");
  const [error, setError] = useState(null);
  const [prefs, setPrefsState] = useState(() => lsGet(LS_PREFS, defaultPrefs()));

  // Hydrate
  useEffect(() => {
    (async () => {
      setStatus("loading"); setError(null);
      try {
        const db = await dbLoadPrefs(ownerKey);
        const next = db?.value || lsGet(LS_PREFS, null) || defaultPrefs();
        // Ensure provider registry keys at least exist
        const filled = ensureProviderShells(next);
        setPrefsState(filled);
        setStatus("ok");
        eventBus.emit("coupon:prefs:loaded", { ownerKey });
      } catch (e) { setStatus("error"); setError(e); }
    })();
  }, [ownerKey]);

  const persist = useCallback(async (next) => {
    const payload = { ...next, updatedISO: nowISO() };
    setPrefsState(payload);
    lsSet(LS_PREFS, payload);
    await dbSavePrefs(ownerKey, payload);
    eventBus.emit("coupon:prefs:updated", { ownerKey, prefs: payload });
  }, [ownerKey]);

  const update = useCallback(async (patch = {}) => {
    await persist({ ...prefs, ...patch });
    if (!quietHours && toast) toast("Coupon preferences updated.");
  }, [prefs, persist, quietHours]);

  const setOptIns = useCallback(async (patch = {}) => {
    await persist({ ...prefs, optIns: { ...(prefs.optIns||{}), ...patch, dataConsentAtISO: (patch?.dataConsentAtISO || prefs.optIns?.dataConsentAtISO || nowISO()) } });
  }, [persist, prefs]);

  const setRules = useCallback(async (patch = {}) => {
    await persist({ ...prefs, rules: { ...(prefs.rules||{}), ...patch } });
  }, [persist, prefs]);

  /* ----------------------------- providers link ---------------------------- */
  const linkProvider = useCallback(async (key, accountMeta = {}) => {
    const reg = memProviders.get(key) || { key, name: key, features: [] };
    const providers = { ...(prefs.providers||{}) };
    providers[key] = {
      ...(providers[key] || {}),
      linked: true,
      displayName: reg.name,
      status: "linked",
      tokenMeta: { exists: !!reg.oauth, expiresAtISO: null },
      accountId: accountMeta.accountId || null,
      email: accountMeta.email || null,
      lastLinkedISO: nowISO(),
    };
    await persist({ ...prefs, providers });
    eventBus.emit("coupon:provider:linked", { ownerKey, key, account: providers[key] });
    if (!quietHours && toast) toast(`${reg.name} linked.`);
    return true;
  }, [prefs, quietHours, persist, ownerKey]);

  const unlinkProvider = useCallback(async (key) => {
    const providers = { ...(prefs.providers||{}) };
    if (!providers[key]) return false;
    providers[key] = { ...providers[key], linked: false, status: "needs_auth", tokenMeta: { exists: false } };
    await persist({ ...prefs, providers });
    eventBus.emit("coupon:provider:unlinked", { ownerKey, key });
    if (!quietHours && toast) toast("Provider unlinked.");
    return true;
  }, [prefs, quietHours, persist, ownerKey]);

  /* ----------------------------- loyalty mapping --------------------------- */
  // forKey can be adapterKey ("samsclub") OR a concrete storeId from useStoresDirectory
  const setLoyalty = useCallback(async (forKey, payload = {}) => {
    const loyalty = { ...(prefs.loyalty||{}) };
    loyalty[forKey] = {
      number: toStr(payload.number) || null,
      alt: toStr(payload.alt) || null,
      name: payload.name ? String(payload.name) : null,
      updatedISO: nowISO(),
    };
    await persist({ ...prefs, loyalty });
    eventBus.emit("coupon:loyalty:updated", { ownerKey, forKey, loyalty: loyalty[forKey] });
    if (!quietHours && toast) toast("Loyalty ID saved.");
    return true;
  }, [prefs, persist, ownerKey, quietHours]);

  const getLoyalty = useCallback((forKey) => (prefs.loyalty||{})[forKey] || null, [prefs.loyalty]);

  /* ------------------------ scheduler / hunts integration ------------------- */
  const suggestCouponSession = useCallback((query = {}) => {
    // query may include storeId OR adapterKey + zip, plus brand/category/upc focus
    const plan = {
      id: `coupon-session-${Date.now()}`,
      domain: "shopping",
      label: buildLabel(query),
      coupons: buildCouponQueryInternal(prefs, query),
      schedule: [], // caller may add based on useStoresDirectory windows
      createdISO: nowISO(),
    };
    eventBus.emit("session:template:proposed", { template: plan });
    if (!quietHours && toast) toast("Coupons session ready in planner.");
    return plan.id;
  }, [prefs, quietHours]);

  const hunts = useMemo(() => ({
    list: () => lsGet(LS_HUNTS, []),
    save: async (label, query) => {
      const key = huntKey({ ...(query||{}), providers: pickLinkedProviders(prefs) });
      const row = { key, label: String(label||"My Coupon Hunt"), query, providers: pickLinkedProviders(prefs), createdISO: nowISO() };
      const arr = [row, ...lsGet(LS_HUNTS, [])].slice(0, 100);
      lsSet(LS_HUNTS, arr);
      await favSaveHunt(user?.id, key, { label: row.label });
      eventBus.emit("coupon:hunt:saved", { key, label: row.label });
      if (!quietHours && toast) toast("Saved coupon hunt.");
      return key;
    },
    remove: async (key) => {
      const arr = lsGet(LS_HUNTS, []).filter(h => h.key !== key);
      lsSet(LS_HUNTS, arr);
      await favRemoveHunt(user?.id, key);
      eventBus.emit("coupon:hunt:removed", { key });
      if (!quietHours && toast) toast("Removed coupon hunt.");
      return true;
    },
    favorite: async (key) => { await favSaveHunt(user?.id, key, { favored: true }); eventBus.emit("coupon:hunt:favorited", { key }); },
    unfavorite: async (key) => { await favRemoveHunt(user?.id, key); eventBus.emit("coupon:hunt:unfavorited", { key }); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [prefs, user?.id, quietHours]);

  /* ------------------------------- builders -------------------------------- */
  // Build a provider+loyalty aware query blob the coupons pipeline can consume.
  const buildCouponQuery = useCallback((context = {}) => {
    return buildCouponQueryInternal(prefs, context);
  }, [prefs]);

  /* -------------------------- orchestration glue --------------------------- */
  // When a store becomes primary / gets updated, prime loyalty map if adapterKey present.
  useEffect(() => {
    const onStoreUpdate = ({ patch, id }) => {
      if (!patch) return;
      const adapterKey = patch.adapterKey || null;
      if (adapterKey && !(prefs.loyalty||{})[adapterKey]) {
        // seed an empty loyalty slot so UI can prompt user
        setLoyalty(adapterKey, { number: "", name: adapterKey.toUpperCase() });
      }
    };
    eventBus.on?.("stores:updated", onStoreUpdate);
    return () => eventBus.off?.("stores:updated", onStoreUpdate);
  }, [prefs.loyalty, setLoyalty]);

  // If cycle insights predicts a window soon, nudge coupons session (NBA).
  useEffect(() => {
    const onHint = ({ kind, query, window, message, score }) => {
      if (kind !== "coupon-window") return;
      const within = Date.parse(window?.expectedStartISO || 0) - Date.now();
      if (within < 10*24*60*60*1000) { // <10 days
        eventBus.emit("nba:hint", {
          domain: "shopping",
          kind: "prep-coupon-session",
          message: message || "Upcoming coupon window",
          score: clamp((score||60)+5, 40, 90),
        });
      }
    };
    eventBus.on?.("nba:hint", onHint);
    return () => eventBus.off?.("nba:hint", onHint);
  }, []);

  /* ------------------------------ export/import ---------------------------- */
  const exportPrefs = useCallback(() => ({
    version: 1,
    exportedAt: nowISO(),
    ownerKey,
    prefs,
    hunts: lsGet(LS_HUNTS, []),
  }), [ownerKey, prefs]);

  const importPrefs = useCallback(async (payload) => {
    if (!payload?.prefs) return false;
    await persist(ensureProviderShells(payload.prefs));
    if (Array.isArray(payload.hunts)) lsSet(LS_HUNTS, payload.hunts);
    if (!quietHours && toast) toast("Imported coupon preferences.");
    return true;
  }, [persist, quietHours]);

  return {
    status, error,
    prefs,
    setPrefs: persist,
    update,
    setOptIns,
    setRules,
    linkProvider,
    unlinkProvider,
    setLoyalty,
    getLoyalty,
    suggestCouponSession,
    buildCouponQuery,
    hunts,
    exportPrefs,
    importPrefs,
  };
}

/* --------------------------------- helpers -------------------------------- */
function ensureProviderShells(p) {
  const out = { ...p, providers: { ...(p.providers||{}) } };
  for (const [k, meta] of memProviders.entries()) {
    if (!out.providers[k]) {
      out.providers[k] = { linked:false, displayName: meta.name, status:"needs_auth", tokenMeta:{ exists:false } };
    }
  }
  return out;
}
function pickLinkedProviders(prefs) {
  return Object.entries(prefs.providers||{})
    .filter(([,v]) => v?.linked)
    .map(([k]) => k);
}
function buildLabel(q) {
  const parts = [];
  if (q.store) parts.push(String(q.store));
  if (q.brand) parts.push(String(q.brand));
  if (q.category) parts.push(String(q.category));
  return `Coupons — ${parts.join(" · ") || "Smart Search"}`;
}

function buildCouponQueryInternal(prefs, context) {
  const providers = pickLinkedProviders(prefs);
  const loyalty = { ...(prefs.loyalty||{}) };

  // Context:
  // { upc?, brand?, category?, storeId?, store?, adapterKey?, zip?, limit? }
  const q = {
    filters: {
      upc: context.upc || null,
      brand: context.brand || null,
      category: context.category || null,
      zip: context.zip || null,
      store: context.store || null,
      storeId: context.storeId || null,
      adapterKey: context.adapterKey || null,
      limit: context.limit || 120,
    },
    providers,
    loyalty,
    rules: prefs.rules || {},
    optIns: prefs.optIns || {},
    requestedAtISO: nowISO(),
  };

  // Emit a fetch request event the coupon lookup layer can consume.
  eventBus.emit("coupons:fetch:requested", q);
  return q;
}

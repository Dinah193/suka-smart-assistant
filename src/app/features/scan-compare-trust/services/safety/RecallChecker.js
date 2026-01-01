/* eslint-disable no-console */
/** @ts-check */

/**
 * RecallChecker — aggregates recall sources (cached) and checks products.
 * ESM-only (Vite/TS friendly), balanced braces, no IIFEs or dual exports.
 *
 * Emits:
 *  - safety:recalls:source:registered
 *  - safety:recalls:refresh:{start|done|error}
 *  - safety:recalls:updated
 *  - safety:recall:flagged
 */

/* ------------------------------ safe imports ------------------------------ */
let eventBus = { emit(){}, on(){}, off(){} };
try {
  const eb = (await import("@/services/eventBus")).default ?? (await import("@/services/eventBus")).eventBus;
  eventBus = eb || eventBus;
} catch {}

let DexieDB = null;
try {
  const dbMod = await import("@/db");
  DexieDB = dbMod.default || dbMod;
} catch {}

let useSafetyPrefs = null;
try {
  const sp = await import("@/features/scan-compare-trust/stores/useSafetyPrefs");
  useSafetyPrefs = sp.default || null;
} catch {}

/* --------------------------------- utils ---------------------------------- */
const nowISO = () => new Date().toISOString();
const toStr = (v)=> (v==null?"":String(v)).trim();
const lc = (v)=> toStr(v).toLowerCase();
const uniq = (arr)=> Array.from(new Set((arr||[]).filter(Boolean)));
const clamp = (n,a,b)=>Math.max(a,Math.min(b,n));

/* --------------------------------- storage -------------------------------- */
const LS_ALL = "recalls:cache:v1";

function lsReadAll(){
  try{ const v = localStorage.getItem(LS_ALL); return v? JSON.parse(v):{ items:{}, meta:{} }; }
  catch{ return {items:{},meta:{}}; }
}
function lsWriteAll(obj){
  try{ localStorage.setItem(LS_ALL, JSON.stringify(obj)); }catch{}
}

async function dbBulkPutRecalls(list) {
  if (!DexieDB?.recalls) return;
  try {
    await DexieDB.recalls.bulkPut(
      list.map(r => ({ id: r.id, sourceKey: r.source?.key||"unknown", value: r, lastUpdatedAt: Date.now() }))
    );
  } catch {}
}
async function dbAllRecalls() {
  if (!DexieDB?.recalls) {
    const all = lsReadAll();
    return Object.values(all.items||{});
  }
  try {
    const rows = await DexieDB.recalls.toArray();
    return rows.map(r=>r.value);
  } catch {
    return [];
  }
}
async function dbMetaGet(key) {
  if (DexieDB?.kv) {
    try { const row = await DexieDB.kv.get({ space:"recalls:meta", key }); return row?.value || null; } catch { return null; }
  }
  const all = lsReadAll(); return (all.meta||{})[key] || null;
}
async function dbMetaPut(key, value) {
  if (DexieDB?.kv) {
    try { await DexieDB.kv.put({ space:"recalls:meta", key, value, updatedAt: Date.now() }); } catch {}
    return;
  }
  const all = lsReadAll(); all.meta = all.meta || {}; all.meta[key] = value; lsWriteAll(all);
}
async function dbReplaceAll(list) {
  if (DexieDB?.recalls) {
    try { await DexieDB.recalls.clear(); await dbBulkPutRecalls(list); return; } catch {}
  }
  const meta = (lsReadAll().meta)||{};
  const out = { items: {}, meta };
  for (const r of list) out.items[r.id] = r;
  lsWriteAll(out);
}
async function dbMerge(list) {
  if (DexieDB?.recalls) { await dbBulkPutRecalls(list); return; }
  const all = lsReadAll();
  all.items = all.items || {};
  for (const r of list) all.items[r.id] = r;
  lsWriteAll(all);
}

/* ------------------------------- text utils ------------------------------- */
function tokenize(s){
  return lc(s).replace(/[^a-z0-9]+/g," ").split(" ").filter(Boolean);
}
function jaccard(a1, a2) {
  const A = new Set(a1), B = new Set(a2);
  const inter = [...A].filter(x=>B.has(x)).length;
  const uni = new Set([...a1, ...a2]).size || 1;
  return inter / uni;
}
function toUpc12(s) {
  const d = String(s||"").replace(/[^0-9]/g,"");
  if (d.length === 12) return d;
  if (d.length === 13 && d.startsWith("0")) return d.slice(1);
  if (d.length === 11) return "0"+d;
  return null;
}

/* -------------------------------- registry -------------------------------- */
const registry = new Map(); // key -> { fn, label, ttlMs }

/**
 * @param {string} key
 * @param {(opts:{sinceISO?:string|null, etag?:string|null, lastModified?:string|null, ttlMs:number})=>Promise<{ok:boolean,items:any[],etag?:string,lastModified?:string,error?:string}>} fn
 * @param {{label?:string, ttlMs?:number}} meta
 */
export function registerSource(key, fn, meta) {
  registry.set(key, { fn, label: meta?.label || key, ttlMs: meta?.ttlMs || (24*60*60*1000) });
  eventBus.emit?.("safety:recalls:source:registered", { key, label: meta?.label || key });
  return true;
}
export function listSources(){ return Array.from(registry.keys()); }

/* ------------------------------- normalizer -------------------------------- */
export function normalizeRecall(sourceKey, raw) {
  const title = toStr(raw.title || raw.recall_title || raw.name || "");
  const hazard = toStr(raw.hazard || raw.reason || raw.problem || "");
  const upcs = uniq([...(raw.upcs||[]), ...(raw.UPCs||[])].map(toUpc12)).filter(Boolean);
  const gtins = uniq([...(raw.gtins||[]), ...(raw.GTINs||[]), ...(raw.upcs||[])]
    .map(s => String(s||"").replace(/[^0-9]/g,""))
    .filter(s => s.length === 14));
  const brands = uniq([...(raw.brands||[]), ...(raw.brand_names||[]), raw.brand]
    .flat().map(lc).filter(Boolean));
  const products = uniq([...(raw.productNames||[]), raw.product_description, raw.product, title]
    .flat().map(v=>lc(toStr(v))).filter(Boolean));

  const id = toStr(raw.id || raw.recall_number || raw.recallID || raw.url || `${sourceKey}:${title}`).slice(0,200);
  const startISO = raw.startISO || raw.start_date || raw.recall_initiation_date || raw.date || null;
  const endISO = raw.endISO || raw.end_date || raw.termination_date || null;

  return {
    id,
    source: { key: sourceKey, label: raw._sourceLabel || sourceKey, url: raw.url || null },
    title,
    hazard: hazard || null,
    classes: uniq([...(raw.classes||[]), raw.classification, raw.category, raw.class].map(lc).filter(Boolean)),
    upcs,
    gtins,
    brands,
    productNames: products,
    lots: uniq((raw.lots||raw.codes||[]).map(toStr).map(lc).filter(Boolean)),
    states: uniq((raw.states||raw.distribution||[]).map(lc).filter(Boolean)),
    startISO: startISO || null,
    endISO: endISO || null,
    lastUpdatedISO: raw.lastUpdatedISO || nowISO(),
    raw: { id: raw.id || raw.recall_number || raw.recallID || null, url: raw.url || null }
  };
}

/* --------------------------------- refresh --------------------------------- */
export async function refreshSource(key, opts = {}) {
  const metaKey = (name)=> `${name}:${key}`;
  const meta = {
    etag: await dbMetaGet(metaKey("etag")),
    lastModified: await dbMetaGet(metaKey("lastmod")),
    sinceISO: await dbMetaGet(metaKey("since")),
  };
  const reg = registry.get(key);
  if (!reg) return { ok:false, error:"not-registered" };

  eventBus.emit?.("safety:recalls:refresh:start", { sourceKey: key });

  try {
    const res = await reg.fn({ sinceISO: meta.sinceISO, etag: meta.etag, lastModified: meta.lastModified, ttlMs: reg.ttlMs });
    if (!res || res.ok === false) {
      eventBus.emit?.("safety:recalls:refresh:error", { sourceKey: key, error: res?.error || "unknown" });
      return { ok:false, error: res?.error || "refresh-failed" };
    }

    const mapped = (res.items||[]).map(r => normalizeRecall(key, r));
    if (opts.replaceAll) { await dbReplaceAll(mapped); } else { await dbMerge(mapped); }

    if (res.etag)        await dbMetaPut(metaKey("etag"), res.etag);
    if (res.lastModified)await dbMetaPut(metaKey("lastmod"), res.lastModified);
    await dbMetaPut(metaKey("since"), nowISO());

    eventBus.emit?.("safety:recalls:refresh:done", { sourceKey: key, added: mapped.length });
    eventBus.emit?.("safety:recalls:updated", { count: mapped.length, sourceKey: key });
    return { ok:true, count: mapped.length };
  } catch (e) {
    eventBus.emit?.("safety:recalls:refresh:error", { sourceKey: key, error: String(e) });
    return { ok:false, error: String(e) };
  }
}

export async function refreshAll(opts = {}) {
  const keys = listSources();
  const results = [];
  for (const k of keys) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await refreshSource(k, opts));
  }
  return results;
}

/* ---------------------------------- matcher -------------------------------- */
export async function checkProductAgainstRecalls(product, options = {}) {
  const upc = toUpc12(product?.upc);
  const brandTokens = tokenize(product?.brand || "");
  const nameTokens = tokenize(product?.name || "");
  const cats = (product?.categories||[]).map(lc);

  let allergenBoost = 0;
  try {
    const prefs = useSafetyPrefs?.getState ? useSafetyPrefs.getState() : null;
    const allergens = (prefs?.avoid?.allergens || []).map(lc);
    if (allergens.length) allergenBoost = 0.15;
  } catch {}

  const now = Date.now();
  const all = await dbAllRecalls();

  const matches = [];
  for (const r of all) {
    let score = 0;
    const reasons = [];

    if (upc && r.upcs?.includes(upc)) { score += 0.65; reasons.push("upc-exact"); }
    if (upc && r.gtins?.some(g => g.endsWith(upc))) { score += 0.35; reasons.push("gtin-suffix"); }

    if (brandTokens.length && r.brands?.length) {
      const bscore = jaccard(brandTokens, r.brands.flatMap(tokenize));
      if (bscore > 0.1) { score += clamp(bscore, 0, 0.3); reasons.push("brand-sim"); }
    }

    if (nameTokens.length && r.productNames?.length) {
      const ps = jaccard(nameTokens, r.productNames.flatMap(tokenize));
      if (ps > 0.1) { score += clamp(ps, 0, 0.35); reasons.push("title-sim"); }
    }

    if (r.classes?.some(c => c.includes("food")) || r.source?.key === "fda") {
      if (cats.some(c => c.includes("garden:seed"))) score -= 0.25; else score += 0.05;
    }

    if (allergenBoost && r.hazard && /allergen|contains|undeclared/i.test(r.hazard)) {
      score += allergenBoost; reasons.push("user-allergen-risk");
    }

    const ref = r.lastUpdatedISO || r.startISO;
    if (ref) {
      const ageDays = (now - Date.parse(ref)) / (24*60*60*1000);
      const recency = clamp(1 - (ageDays / 365), 0, 1) * 0.1;
      score += recency;
    }

    if (score >= (options.minScore ?? 0.45)) {
      matches.push({ recall: r, score: clamp(score, 0, 1), reasons });
    }
  }

  matches.sort((a,b)=>b.score-a.score);
  const maxScore = matches[0]?.score || 0;

  if (maxScore >= (options.emitThreshold ?? 0.6)) {
    eventBus.emit?.("safety:recall:flagged", {
      upc: upc || null,
      brand: product?.brand || null,
      name: product?.name || null,
      matches: matches.slice(0,5).map(x => ({ id: x.recall.id, score: x.score, source: x.recall.source })),
      sessionId: product?.sessionId || null,
      sessionLabel: product?.sessionLabel || null,
    });
  }

  return { matches, maxScore };
}

/* ---------------------------------- queries -------------------------------- */
export async function getAllRecalls() { return dbAllRecalls(); }
export async function getByUPC(upc) {
  const target = toUpc12(upc);
  const all = await dbAllRecalls();
  return all.filter(r => r.upcs?.includes(target) || r.gtins?.some(g => g.endsWith(target)));
}

/* ----------------------------- built-in adapters --------------------------- */
async function httpJSON(url, headers = {}, timeoutMs = 9000) {
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return { ok:false, error: "http-"+res.status };
    const etag = res.headers.get("ETag"); const lm = res.headers.get("Last-Modified");
    const data = await res.json();
    return { ok:true, data, etag, lastModified: lm };
  } catch(e){ return { ok:false, error: String(e && e.name==="AbortError" ? "timeout" : e) }; }
  finally { clearTimeout(t); }
}

async function FDAAdapter({ sinceISO }) {
  const qs = sinceISO ? `?since=${encodeURIComponent(sinceISO)}` : "";
  const r = await httpJSON(`/api/recalls/fda${qs}`);
  if (!r.ok) return { ok:false, error:r.error };
  const items = (r.data?.items||[]).map(x => ({
    id: x.event_id || x.recall_number || x.id,
    _sourceLabel: "FDA",
    url: x.url,
    title: x.product_description || x.title,
    hazard: x.reason_for_recall || x.hazard,
    classes: ["Food", x.classification].filter(Boolean),
    upcs: x.upcs || [],
    gtins: x.gtins || [],
    brands: x.brand_names ? x.brand_names.split(",").map(toStr) : [],
    productNames: [x.product_description||x.title].filter(Boolean),
    lots: x.codes || [],
    states: x.distribution_pattern ? tokenize(x.distribution_pattern) : [],
    startISO: x.recall_initiation_date || x.startISO || null,
    lastUpdatedISO: x.report_date || x.lastUpdatedISO || null,
  }));
  return { ok:true, items, etag: r.etag, lastModified: r.lastModified };
}

async function FSISAdapter({ sinceISO }) {
  const qs = sinceISO ? `?since=${encodeURIComponent(sinceISO)}` : "";
  const r = await httpJSON(`/api/recalls/fsis${qs}`);
  if (!r.ok) return { ok:false, error:r.error };
  const items = (r.data?.items||[]).map(x => ({
    id: x.recall_number || x.id,
    _sourceLabel: "USDA FSIS",
    url: x.url,
    title: x.product || x.title,
    hazard: x.reason || x.hazard_class,
    classes: ["Food", x.classification].filter(Boolean),
    upcs: x.upcs || [],
    gtins: x.gtins || [],
    brands: x.brands || [],
    productNames: [x.product, x.title].filter(Boolean),
    lots: x.codes || [],
    states: x.states || [],
    startISO: x.date || null,
    lastUpdatedISO: x.last_updated || null,
  }));
  return { ok:true, items, etag: r.etag, lastModified: r.lastModified };
}

async function CPSCAdapter({ sinceISO }) {
  const qs = sinceISO ? `?since=${encodeURIComponent(sinceISO)}` : "";
  const r = await httpJSON(`/api/recalls/cpsc${qs}`);
  if (!r.ok) return { ok:false, error:r.error };
  const items = (r.data?.items||[]).map(x => ({
    id: x.recallID || x.id,
    _sourceLabel: "CPSC",
    url: x.url,
    title: x.productName || x.title,
    hazard: x.hazard || x.reason,
    classes: ["Consumer"],
    upcs: x.upcs || [],
    gtins: x.gtins || [],
    brands: [x.manufacturer||x.brand].filter(Boolean),
    productNames: [x.productName||x.title].filter(Boolean),
    lots: x.lot || [],
    states: x.states || [],
    startISO: x.date || null,
    lastUpdatedISO: x.lastUpdated || null,
  }));
  return { ok:true, items, etag: r.etag, lastModified: r.lastModified };
}

/* ------------------------ register built-in sources ------------------------ */
registerSource("fda",  FDAAdapter,   { label:"FDA",       ttlMs: 12*60*60*1000 });
registerSource("fsis", FSISAdapter,  { label:"USDA FSIS", ttlMs: 12*60*60*1000 });
registerSource("cpsc", CPSCAdapter,  { label:"CPSC",      ttlMs: 24*60*60*1000 });

/* ---------------------------------- default -------------------------------- */
const RecallChecker = {
  registerSource,
  listSources,
  refreshSource,
  refreshAll,
  getAllRecalls,
  getByUPC,
  checkProductAgainstRecalls,
  normalizeRecall,
};

export default RecallChecker;

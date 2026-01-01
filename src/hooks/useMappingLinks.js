/* eslint-disable no-console */
/**
 * useMappingLinks.js — map task → inventory / feed / seed / zones
 * ES2015-safe, defensive, domain-agnostic (meals • cleaning • animals • garden).
 *
 * What this does
 * --------------
 * - Suggest & maintain links between a "task" (recipe step, cleaning chore, animal care, garden action)
 *   and concrete resources: inventory SKUs, feed/seed items, tools/supplies, and garden zones/beds/rows.
 * - Fuzzy matching across names/aliases/tags; respects user overrides.
 * - Works with or without Dexie; falls back to localStorage.
 * - Emits canonical events for UI (BatchInventoryMap, ZonePicker, Linker drawers).
 * - React hook + plain factory. Safe no-ops if deps are missing.
 *
 * Link shape
 * ----------
 * {
 *   id: string,
 *   taskId: string,
 *   domain: "meals"|"cleaning"|"animals"|"garden"|"custom",
 *   kind: "ingredient"|"supply"|"tool"|"feed"|"seed"|"zone",
 *   ref: { sku?:string, name?:string, zoneId?:string, bed?:string, row?:string, meta?:object },
 *   qty?: number,
 *   unit?: string,
 *   confidence: number,         // 0..1 from fuzzy matcher or 1 for manual
 *   source: "manual"|"auto"|"scan"|"template"|"history",
 *   createdAtISO: string,
 *   updatedAtISO: string
 * }
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ----------------------------- Safe/Optional Deps -----------------------------
function noop(){}
const NIL_BUS = { emit: noop, on: noop, off: noop };

function safeGet(obj, path, fallback) {
  try {
    const parts = String(path).split(".");
    let cur = obj;
    for (let i=0;i<parts.length;i++) cur = cur[parts[i]];
    return (cur === undefined || cur === null) ? fallback : cur;
  } catch { return fallback; }
}

function isoNow(){ return new Date().toISOString(); }
function uid(p="map"){ return `${p}:${Math.random().toString(36).slice(2)}:${Date.now()}`; }
function clamp01(x){ return Math.max(0, Math.min(1, Number(x)||0)); }

const LS_KEY = "suka:mapping:links";

// ----------------------------- Persistence (Dexie or LS) -----------------------------
async function persistLink(db, link){
  if (db && db.mapping_links && db.mapping_links.put) {
    try { await db.mapping_links.put(link); return; } catch(e){ console.warn("Dexie put failed", e); }
  }
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    all[link.id] = link;
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {}
}

async function deleteLink(db, id){
  if (db && db.mapping_links && db.mapping_links.delete) {
    try { await db.mapping_links.delete(id); return; } catch(e){ console.warn("Dexie delete failed", e); }
  }
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    delete all[id];
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {}
}

async function loadAllLinks(db){
  if (db && db.mapping_links && db.mapping_links.toArray) {
    try { return await db.mapping_links.toArray(); } catch(e){ console.warn("Dexie read failed", e); }
  }
  try {
    const all = JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    return Object.values(all);
  } catch { return []; }
}

// ----------------------------- Fuzzy Matching -----------------------------
// lightweight token-based matcher; robust to hyphens/plurals; safe for ES2015
function normalizeName(s){
  return String(s||"")
    .toLowerCase()
    .replace(/[\u2019'’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(the|and|of|for|with|a|an|to|in|on)\b/g, " ")
    .replace(/\s+([kg|lb|oz|ml|l|cup|cups|tbsp|tsp|quart|qt|pt])\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function tokens(s){ return normalizeName(s).split(" ").filter(Boolean); }

function jaccard(aTokens, bTokens){
  const A = new Set(aTokens), B = new Set(bTokens);
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  const union = A.size + B.size - inter;
  return union > 0 ? inter / union : 0;
}
function dice(aTokens, bTokens){
  const A = new Set(aTokens), B = new Set(bTokens);
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  const denom = A.size + B.size;
  return denom > 0 ? (2*inter)/denom : 0;
}
function scoreName(query, candidate){
  const q = tokens(query);
  const c = tokens(candidate);
  const j = jaccard(q,c);
  const d = dice(q,c);
  // small boost if candidate includes query start token sequence
  const starts = normalizeName(candidate).startsWith(normalizeName(query)) ? 0.08 : 0;
  return clamp01(0.6*j + 0.4*d + starts);
}

// pick top N from catalog by best of (name, aliases)
function rankCatalog(query, catalog, { field="name", aliasField="aliases", top=5 } = {}){
  const out = [];
  for (let i=0;i<(catalog||[]).length;i++){
    const row = catalog[i];
    const name = safeGet(row, field, "");
    const aliases = safeGet(row, aliasField, []) || [];
    let best = scoreName(query, name);
    for (let k=0;k<aliases.length;k++){
      best = Math.max(best, scoreName(query, aliases[k]));
    }
    out.push({ row, score: best });
  }
  out.sort((a,b)=> b.score - a.score);
  return out.slice(0, top);
}

// ----------------------------- Engine Factory -----------------------------
export function createMappingLinks(deps = {}) {
  const eventBus   = deps.eventBus || NIL_BUS;

  // catalogs / stores (all optional)
  const db         = deps.db || null; // Dexie db with mapping_links
  const inventory  = deps.inventory || { list: () => [] }; // {sku,name,kind,storage,aliases[]}
  const feeds      = deps.feeds || { list: () => [] };     // {sku,name,kind:'feed',species[],aliases[]}
  const seeds      = deps.seeds || { list: () => [] };     // {sku,name,kind:'seed',variety,aliases[]}
  const supplies   = deps.supplies || { list: () => [] };  // cleaning/consumables/tools
  const zones      = deps.zones || { list: () => [] };     // garden zones: {id,name,bed,row,meta}
  const history    = deps.history || { lastUsed: () => [] }; // prior successful mappings for boosts

  const settings   = deps.settings || { get: (_p,fb)=>fb };

  // cached link state
  let cache = { loaded: false, links: [] };

  // ---------- helpers -----------
  function buildCatalogIndex(){
    const INV = (()=>{ try { return inventory.list()||[]; } catch { return []; }})();
    const FE  = (()=>{ try { return feeds.list()||[]; } catch { return []; }})();
    const SE  = (()=>{ try { return seeds.list()||[]; } catch { return []; }})();
    const SUP = (()=>{ try { return supplies.list()||[]; } catch { return []; }})();
    const ZN  = (()=>{ try { return zones.list()||[]; } catch { return []; }})();
    return { INV, FE, SE, SUP, ZN };
  }

  function boostByHistory(rows, kind){
    let last = [];
    try { last = history.lastUsed(kind) || []; } catch {}
    const map = new Set(last.map(x => x.sku || x.zoneId || x.name));
    return rows.map(r => map.has(r.row.sku || r.row.zoneId || r.row.name)
      ? { ...r, score: clamp01(r.score + 0.12) }
      : r
    );
  }

  function chooseKindFromTask(task){
    // heuristics by domain/flags
    const domain = (task.domain || "custom").toLowerCase();
    const flags  = (task.flags || []).join(" ").toLowerCase();
    if (domain === "meals" || /ingredient|recipe|cook|bake/.test(flags)) return "ingredient";
    if (domain === "cleaning" || /clean|sanitize|wipe|mop|launder/.test(flags)) return "supply";
    if (domain === "animals" && /feed|ration|grain|pellet/.test(flags)) return "feed";
    if (domain === "garden" && /seed|sow|plant/.test(flags)) return "seed";
    if (domain === "garden" && /bed|row|zone|plot|trellis/.test(flags)) return "zone";
    return "supply";
  }

  // ---------- core API -----------
  async function load(){
    if (cache.loaded) return cache.links;
    const all = await loadAllLinks(db);
    cache = { loaded: true, links: all };
    return cache.links;
  }

  function listByTask(taskId){
    return (cache.links || []).filter(x => x.taskId === taskId);
  }

  function findExisting(taskId, kind, refKey){
    const arr = listByTask(taskId).filter(x => x.kind === kind);
    if (!refKey) return arr;
    return arr.find(x => (x.ref?.sku || x.ref?.zoneId || x.ref?.name) === refKey) || null;
  }

  function link({ task, kind, ref, qty, unit, confidence=1, source="manual" }){
    if (!task || !task.id) return null;
    const linkObj = {
      id: uid("link"),
      taskId: task.id,
      domain: (task.domain || "custom"),
      kind: kind || chooseKindFromTask(task),
      ref: ref || {},
      qty: typeof qty === "number" ? qty : undefined,
      unit: unit || undefined,
      confidence: clamp01(confidence),
      source,
      createdAtISO: isoNow(),
      updatedAtISO: isoNow()
    };
    cache.links = [linkObj].concat(cache.links || []);
    persistLink(db, linkObj);
    eventBus.emit("mapping.link.added", { link: linkObj });
    return linkObj;
  }

  function unlink(linkId){
    const found = (cache.links || []).find(x => x.id === linkId);
    cache.links = (cache.links || []).filter(x => x.id !== linkId);
    deleteLink(db, linkId);
    if (found) eventBus.emit("mapping.link.removed", { linkId, taskId: found.taskId });
    return true;
  }

  function update(linkId, patch){
    const i = (cache.links || []).findIndex(x => x.id === linkId);
    if (i < 0) return null;
    const next = { ...cache.links[i], ...patch, updatedAtISO: isoNow() };
    cache.links[i] = next;
    persistLink(db, next);
    eventBus.emit("mapping.link.updated", { link: next });
    return next;
    }

  // ---------- suggestions -----------
  function suggestForTask(task, options = {}){
    if (!task) return { ingredient:[], supply:[], feed:[], seed:[], zone:[] };

    const { INV, FE, SE, SUP, ZN } = buildCatalogIndex();

    // query string is task.title + notes + optional items from task.inventory
    const qParts = [
      task.title, task.notes,
      ...(safeGet(task, "inventory.items", []).map(i => i.name || i.sku || "")),
      ...(task.tags || [])
    ].filter(Boolean);
    const query = qParts.join(" ").slice(0, 160) || (task.kind || "task");

    // rank each catalog
    let ing = rankCatalog(query, INV, { top: options.top || 5 });
    let sup = rankCatalog(query, SUP, { top: options.top || 5 });
    let fe  = rankCatalog(query, FE,  { top: options.top || 5 });
    let se  = rankCatalog(query, SE,  { top: options.top || 5 });
    let zn  = rankCatalog(query, ZN,  { field:"name", top: options.top || 5 });

    // recent history boosts
    ing = boostByHistory(ing, "ingredient");
    sup = boostByHistory(sup, "supply");
    fe  = boostByHistory(fe,  "feed");
    se  = boostByHistory(se,  "seed");
    zn  = boostByHistory(zn,  "zone");

    // minimal confidence thresholds by kind
    const floor = {
      ingredient: 0.42,
      supply: 0.38,
      feed: 0.40,
      seed: 0.40,
      zone: 0.35
    };

    const toSuggestion = (kind) => (x) => ({
      kind,
      ref: kind === "zone"
        ? { zoneId: x.row.id, name: x.row.name, bed: x.row.bed, row: x.row.row, meta: x.row.meta }
        : { sku: x.row.sku, name: x.row.name, kind: x.row.kind, meta: x.row },
      confidence: clamp01(x.score),
      source: "auto"
    });

    return {
      ingredient: ing.filter(x => x.score >= floor.ingredient).map(toSuggestion("ingredient")),
      supply:     sup.filter(x => x.score >= floor.supply).map(toSuggestion("supply")),
      feed:       fe.filter(x => x.score >= floor.feed).map(toSuggestion("feed")),
      seed:       se.filter(x => x.score >= floor.seed).map(toSuggestion("seed")),
      zone:       zn.filter(x => x.score >= floor.zone).map(toSuggestion("zone"))
    };
  }

  // bulk helper for recipes: create links for each ingredient suggestion
  function linkFromRecipe(task, recipe){
    if (!task || !recipe || !Array.isArray(recipe.ingredients)) return [];
    const out = [];
    for (let i=0;i<recipe.ingredients.length;i++){
      const ing = recipe.ingredients[i];
      const fakeTask = { ...task, title: `${task.title} ${ing.name||""}` };
      const sug = suggestForTask(fakeTask);
      const top = (sug.ingredient[0] || null);
      if (top){
        out.push(link({
          task,
          kind: "ingredient",
          ref: top.ref,
          qty: Number(ing.qty || 0) || undefined,
          unit: ing.unit || undefined,
          confidence: top.confidence,
          source: "scan"
        }));
      }
    }
    return out;
  }

  // reconcile on inventory update: re-score low-confidence auto links
  function reconcileOnInventoryUpdate(taskId){
    const links = listByTask(taskId).filter(l => l.source !== "manual" && l.confidence < 0.7 && l.kind !== "zone");
    if (!links.length) return [];
    // Re-run suggestions for the original task shape
    const taskStub = { id: taskId, title: links.map(l => l.ref.name).join(" ") };
    const sug = suggestForTask(taskStub, { top: 3 });
    const changes = [];
    links.forEach(l => {
      const pool = (l.kind === "ingredient" ? sug.ingredient
                  : l.kind === "supply"    ? sug.supply
                  : l.kind === "feed"      ? sug.feed
                  : l.kind === "seed"      ? sug.seed : []);
      if (!pool.length) return;
      const better = pool[0];
      if (better.confidence > l.confidence + 0.12) {
        changes.push(update(l.id, { ref: better.ref, confidence: better.confidence }));
      }
    });
    return changes;
  }

  // zone linking UX helper: open zone picker and persist selection
  function openZonePicker(task){
    try {
      eventBus.emit("ui:open:zonePicker", {
        taskId: task?.id,
        onPick: (zone) => {
          link({
            task,
            kind: "zone",
            ref: { zoneId: zone.id, name: zone.name, bed: zone.bed, row: zone.row, meta: zone },
            source: "manual"
          });
        }
      });
      return true;
    } catch { return false; }
  }

  // programmatic quick link (used by BatchInventoryMap / drag&drop)
  function quickLink(task, kind, row, meta = {}){
    const ref = kind === "zone"
      ? { zoneId: row.id, name: row.name, bed: row.bed, row: row.row, meta: row }
      : { sku: row.sku, name: row.name, kind: row.kind, meta: row };
    return link({ task, kind, ref, confidence: 1, source: "manual", ...meta });
  }

  // expose minimal “mapping table” for read-only views
  function tableForTasks(taskIds){
    const set = new Set(taskIds || []);
    return (cache.links || []).filter(l => set.has(l.taskId));
  }

  // public
  return {
    // lifecycle
    load,

    // link mgmt
    link,
    unlink,
    update,

    // queries
    listByTask,
    tableForTasks,
    findExisting,

    // suggestions + flows
    suggestForTask,
    linkFromRecipe,
    reconcileOnInventoryUpdate,
    openZonePicker,
    quickLink
  };
}

// ----------------------------- React Hook -----------------------------
export default function useMappingLinks(deps = {}) {
  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createMappingLinks(deps);

  const [ready, setReady] = useState(false);
  const [byTask, setByTask] = useState({}); // taskId -> links[]

  const refreshTask = useCallback(async (taskId) => {
    const arr = engineRef.current.listByTask(taskId);
    setByTask(prev => ({ ...prev, [taskId]: arr }));
    return arr;
  }, []);

  const refreshMany = useCallback(async (taskIds=[]) => {
    const map = {};
    for (let i=0;i<taskIds.length;i++){
      map[taskIds[i]] = engineRef.current.listByTask(taskIds[i]);
    }
    setByTask(map);
    return map;
  }, []);

  const suggestForTask = useCallback((task, opts) => engineRef.current.suggestForTask(task, opts), []);
  const link = useCallback((payload) => {
    const l = engineRef.current.link(payload);
    if (l) refreshTask(l.taskId);
    return l;
  }, [refreshTask]);

  const unlink = useCallback((linkId, taskId) => {
    engineRef.current.unlink(linkId);
    if (taskId) refreshTask(taskId);
    return true;
  }, [refreshTask]);

  const update = useCallback((linkId, patch) => {
    const l = engineRef.current.update(linkId, patch);
    if (l) refreshTask(l.taskId);
    return l;
  }, [refreshTask]);

  const linkFromRecipe = useCallback((task, recipe) => {
    const arr = engineRef.current.linkFromRecipe(task, recipe);
    refreshTask(task.id);
    return arr;
  }, [refreshTask]);

  const reconcileOnInventoryUpdate = useCallback((taskId) => {
    const changes = engineRef.current.reconcileOnInventoryUpdate(taskId);
    refreshTask(taskId);
    return changes;
  }, [refreshTask]);

  const openZonePicker = useCallback((task) => engineRef.current.openZonePicker(task), []);
  const quickLink = useCallback((task, kind, row, meta) => {
    const l = engineRef.current.quickLink(task, kind, row, meta);
    refreshTask(task.id);
    return l;
  }, [refreshTask]);

  // init + event wiring
  useEffect(() => {
    let mounted = true;
    (async () => {
      await engineRef.current.load();
      if (mounted) setReady(true);
    })();

    const bus = deps.eventBus || NIL_BUS;

    // When a recipe is scanned, attempt auto-links
    const onRecipeScanned = (e) => {
      // e: { task, recipe }
      try {
        engineRef.current.linkFromRecipe(e.task, e.recipe);
        refreshTask(e.task.id);
      } catch {}
    };

    // Inventory updates → reconcile low-confidence links
    const onInventoryUpdated = (e) => {
      try {
        const taskId = e?.taskId; // if provided by publisher
        if (taskId) {
          engineRef.current.reconcileOnInventoryUpdate(taskId);
          refreshTask(taskId);
        }
      } catch {}
    };

    // Garden plan updates → open zone picker if unresolved zone
    const onGardenPlanUpdated = (e) => {
      try {
        const t = e?.task;
        if (t && !engineRef.current.findExisting(t.id, "zone")) {
          engineRef.current.openZonePicker(t);
        }
      } catch {}
    };

    bus.on("recipe.scanned", onRecipeScanned);
    bus.on("inventory.updated", onInventoryUpdated);
    bus.on("garden.plan.updated", onGardenPlanUpdated);

    return () => {
      mounted = false;
      bus.off("recipe.scanned", onRecipeScanned);
      bus.off("inventory.updated", onInventoryUpdated);
      bus.off("garden.plan.updated", onGardenPlanUpdated);
    };
  }, [deps.eventBus, refreshTask]);

  // Derived helper for trendy UIs: compact per-kind chips
  const chipsForTask = useCallback((taskId) => {
    const links = byTask[taskId] || [];
    return links.map(l => ({
      id: l.id,
      kind: l.kind,
      label: l.kind === "zone" ? (l.ref.name || l.ref.zoneId) : (l.ref.name || l.ref.sku),
      meta: l.kind === "zone" ? (l.ref.bed ? `Bed ${l.ref.bed}${l.ref.row ? ` • Row ${l.ref.row}` : ""}` : "") : l.unit ? `${l.qty||""} ${l.unit}` : "",
      confidence: l.confidence,
      source: l.source
    }));
  }, [byTask]);

  return {
    // state
    ready,
    byTask,

    // actions
    refreshTask,
    refreshMany,
    link,
    unlink,
    update,
    quickLink,
    openZonePicker,

    // suggestions / reconcile
    suggestForTask,
    linkFromRecipe,
    reconcileOnInventoryUpdate,

    // views
    chipsForTask
  };
}

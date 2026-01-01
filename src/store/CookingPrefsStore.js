// src/store/CookingPrefsStore.js
/* eslint-disable no-console */

/**
 * CookingPrefsStore v2.1
 * - Cooperates with sibling stores via automation events (no hard imports)
 * - Bridges to MealPrefsStore / MealRhythmStore / InventoryStore / RecipeStore through
 *   configureBridge({ ingredientToItemKey, onRhythmChange, onKitChange, onPacksChange })
 * - Holds taste sliders, kit, per-cuisine & per-dish house styles, texture targets,
 *   weekly flavor rhythm, recipe pack prefs, and appliance capabilities.
 * - Ships selectors tailored for meal planning, batch cooking, timers, and inventory.
 */

import { automation } from "@/services/automation/runtime";

/* ------------------------------ Utils ------------------------------ */

function isBrowser() { return typeof window !== "undefined" && typeof localStorage !== "undefined"; }
function clamp(n, min, max) { n = Number.isFinite(Number(n)) ? Number(n) : min; return Math.max(min, Math.min(max, n)); }
function asArray(x){ if(Array.isArray(x))return x; if(typeof x==="string")return x.split(",").map(s=>s.trim()).filter(Boolean); return []; }
function dedupe(arr){ return Array.from(new Set((arr||[]).filter(Boolean))); }
function safeId(len=12){ try{const b=crypto.getRandomValues(new Uint8Array(len)); const a="abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"; return Array.from(b,(x)=>a[x%a.length]).join("");}catch{ return Math.random().toString(36).slice(2,2+len);} }

/* ---------------------------- Persistence --------------------------- */

const STORE_VERSION = "2.1.0";
const LS_KEY = "suka.cookingPrefs";

const DEFAULT_STATE = {
  __version: STORE_VERSION,

  sliders: { doneness: 65, softness: 60, browning: 55, smokiness: 40, sourness: 35, chiliHeat: 45 },

  // Per-item texture targets (overrides global sliders)
  textureTargets: { /* "beef_shank": { doneness, softness, notes } */ },

  appliances: ["stovetop", "oven"],
  utensils: ["cast_iron", "wok", "dutch_oven"],

  // Capability map other modules can read
  applianceCaps: {
    pressure_cooker: { supportsPressure: true, speedMultiplier: 2.2 },
    air_fryer: { convection: true, basket: true, capacityLiters: 4 },
    charcoal_grill: { maxHeat: "very_high", smokeFlavor: "high" },
    oven: { convection: false, maxC: 260 },
    stovetop: { wokHei: false, burners: 4 },
    wok_burner: { wokHei: true, btus: 30000 },
  },

  // Learning
  houseStyles: {},              // cuisine -> { techniqueBias[], notes, lastRated, lastUpdated }
  dishStyles: {},               // "Cuisine::Dish" -> same shape
  weeklyFlavorRhythm: [],       // 7 entries, aligns with MealRhythmStore
  recipePacks: { preferred: [], recentUsed: [] }, // Pack IDs
  units: "imperial",
  region: "US",
  privacy: { shareAnonymizedTelemetry: false },

  experiments: {},              // "expName": { arm:"A|B", assignedAt, notes }
  events: [],                   // { id, ts, kind, cuisine?, dish?, itemKey?, recipeId?, payload }
  onboarding: { askedForTasteOnce: false },
  lastSummarizedAt: null,
  __undo: [],
};

let state = load();
const listeners = new Set();
let saveTimer = null;

// lightweight, optional bridges to other stores (set via configureBridge)
let bridge = {
  ingredientToItemKey: null, // (name) => itemKey
  onRhythmChange: null,       // (arr7) => void (MealRhythmStore)
  onKitChange: null,          // ({appliances, utensils}) => void (CookingStore/MultiTimerManager)
  onPacksChange: null,        // (preferredIds) => void (MealPrefs/RecipeStore)
};

function load() {
  if (!isBrowser()) return { ...DEFAULT_STATE };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    return migrate(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function scheduleSave(){
  if(saveTimer) return;
  saveTimer = setTimeout(()=>{ saveTimer=null; saveNow(); },120);
}
function saveNow(){
  if(!isBrowser()) return;
  try{ localStorage.setItem(LS_KEY, JSON.stringify({ ...state, __version: STORE_VERSION })); }
  catch(err){ console.warn("CookingPrefsStore: persist fail", err); }
}

function migrate(s) {
  if (!s || typeof s !== "object") return { ...DEFAULT_STATE };
  const next = { ...DEFAULT_STATE, ...s };
  if (!next.textureTargets) next.textureTargets = {};
  if (!next.dishStyles) next.dishStyles = {};
  if (!next.recipePacks) next.recipePacks = { preferred: [], recentUsed: [] };
  if (!next.applianceCaps) next.applianceCaps = DEFAULT_STATE.applianceCaps;
  if (!Array.isArray(next.events)) next.events = [];
  if (next.events.length > 1200) next.events.length = 1200;
  next.__version = STORE_VERSION;
  return next;
}

/* --------------------------- Notify + Undo --------------------------- */

function pushUndo(patch){ state.__undo.unshift({ ts: Date.now(), patch }); if(state.__undo.length>20) state.__undo.length=20; }
function notify(patch=null){
  for(const fn of listeners){ try{ fn(state, patch); }catch(e){ console.warn("CookingPrefsStore listener error", e); } }
  automation.emit("cookingPrefs/changed", { patch });
}

/* --------------------------------- API -------------------------------- */

export const CookingPrefsStore = {
  /* BRIDGE: allow sibling stores/hooks to plug resolvers without creating imports */
  configureBridge(partial){
    bridge = { ...bridge, ...(partial||{}) };
  },

  /* Access & subscribe */
  get(){ return state; },
  subscribe(fn){ listeners.add(fn); try{ fn(state,null); }catch{} return ()=>listeners.delete(fn); },

  /* Reset & undo */
  reset(){
    pushUndo({ revertTo: state });
    state = { ...DEFAULT_STATE, __version: STORE_VERSION };
    scheduleSave(); notify({ reset:true });
    return state;
  },
  undo(){
    const last = state.__undo.shift();
    if(!last?.patch?.revertTo) return { ok:false, error:"Nothing to undo" };
    state = { ...last.patch.revertTo };
    scheduleSave(); notify({ undo:true });
    return { ok:true };
  },

  /* Sliders */
  setSliders(partial){
    const before = { ...state.sliders };
    state.sliders = { ...state.sliders, ...sanitizeSliders(partial) };
    pushUndo({ sliders: before }); scheduleSave();
    notify({ sliders: state.sliders });
    automation.emit("cookingPrefs/slidersUpdated", { sliders: state.sliders });
    logEventInternal({ kind:"sliders_update", payload:{ sliders: state.sliders } });
    return state.sliders;
  },

  /* Per-item texture target (Inventory/Ingredients aware through bridge.ingredientToItemKey) */
  setTextureTarget(itemOrName, { doneness, softness, notes = "" }){
    const itemKey = normalizeItemKey(itemOrName);
    if(!itemKey) return null;
    const before = { ...(state.textureTargets[itemKey] || {}) };
    state.textureTargets[itemKey] = {
      doneness: clamp(doneness ?? before.doneness ?? state.sliders.doneness, 0, 100),
      softness: clamp(softness ?? before.softness ?? state.sliders.softness, 0, 100),
      notes: notes ?? before.notes ?? "",
    };
    pushUndo({ textureTargets: { [itemKey]: before } });
    scheduleSave();
    notify({ textureTarget: { itemKey, ...state.textureTargets[itemKey] } });
    automation.emit("cookingPrefs/textureTargetUpdated", { itemKey, target: state.textureTargets[itemKey] });
    return state.textureTargets[itemKey];
  },

  /* Kit & capabilities (notifies CookingStore/MultiTimerManager via bridge.onKitChange) */
  setKit({ appliances, utensils }){
    const before = { appliances: state.appliances, utensils: state.utensils };
    if(appliances) state.appliances = dedupe(asArray(appliances));
    if(utensils) state.utensils = dedupe(asArray(utensils));
    pushUndo({ kit: before }); scheduleSave();
    const patch = { appliances: state.appliances, utensils: state.utensils };
    notify(patch);
    automation.emit("cookingPrefs/kitUpdated", patch);
    if (typeof bridge.onKitChange === "function") try{ bridge.onKitChange(patch); }catch{}
    logEventInternal({ kind:"kit_update", payload: patch });
    return patch;
  },
  setApplianceCaps(appliance, capsPatch){
    if(!appliance) return null;
    const before = { ...(state.applianceCaps[appliance] || {}) };
    state.applianceCaps[appliance] = { ...before, ...capsPatch };
    pushUndo({ applianceCaps: { [appliance]: before } }); scheduleSave();
    notify({ applianceCaps: { [appliance]: state.applianceCaps[appliance] } });
    automation.emit("cookingPrefs/applianceCapsUpdated", { appliance, caps: state.applianceCaps[appliance] });
    return state.applianceCaps[appliance];
  },

  /* House & dish styles */
  upsertHouseStyle(cuisine, patch){
    if(!cuisine) return null;
    const prev = state.houseStyles[cuisine] || {};
    const techniqueBias = new Set([...(prev.techniqueBias||[]), ...asArray(patch?.techniqueBias||[])].filter(Boolean));
    const before = { ...prev };
    const merged = {
      techniqueBias: Array.from(techniqueBias),
      notes: patch?.notes ?? prev.notes ?? "",
      lastRated: typeof patch?.lastRated === "number" ? patch.lastRated : (prev.lastRated || 0),
      lastUpdated: new Date().toISOString(),
    };
    state.houseStyles[cuisine] = merged;
    pushUndo({ houseStyle: { [cuisine]: before } }); scheduleSave();
    notify({ houseStyle: { cuisine, ...merged } });
    automation.emit("cookingPrefs/houseStyleUpdated", { cuisine, houseStyle: merged });
    return merged;
  },
  getHouseStyle(cuisine){ return state.houseStyles[cuisine] || {}; },

  upsertDishStyle(cuisine, dish, patch){
    if(!cuisine || !dish) return null;
    const key = `${cuisine}::${dish}`;
    const prev = state.dishStyles[key] || {};
    const techniqueBias = new Set([...(prev.techniqueBias||[]), ...asArray(patch?.techniqueBias||[])].filter(Boolean));
    const before = { ...prev };
    const merged = {
      techniqueBias: Array.from(techniqueBias),
      notes: patch?.notes ?? prev.notes ?? "",
      lastRated: typeof patch?.lastRated === "number" ? patch.lastRated : (prev.lastRated || 0),
      lastUpdated: new Date().toISOString(),
    };
    state.dishStyles[key] = merged;
    pushUndo({ dishStyle: { [key]: before } }); scheduleSave();
    notify({ dishStyle: { key, ...merged } });
    automation.emit("cookingPrefs/dishStyleUpdated", { key, dishStyle: merged });
    return merged;
  },
  getDishStyle(cuisine, dish){ return state.dishStyles[`${cuisine}::${dish}`] || {}; },

  /* Weekly Flavor Rhythm (sync hint to MealRhythmStore via bridge.onRhythmChange) */
  setWeeklyFlavorRhythm(arr7){
    const arr = (arr7||[]).slice(0,7).map(String);
    const before = [...state.weeklyFlavorRhythm];
    state.weeklyFlavorRhythm = arr;
    pushUndo({ weeklyFlavorRhythm: before }); scheduleSave();
    notify({ weeklyFlavorRhythm: arr });
    automation.emit("cookingPrefs/weeklyFlavorUpdated", { weeklyFlavorRhythm: arr });
    if (typeof bridge.onRhythmChange === "function") try{ bridge.onRhythmChange(arr); }catch{}
    return arr;
  },

  /* Recipe Packs (sync hint to MealPrefs/RecipeStore via bridge.onPacksChange) */
  setPreferredPacks(ids){
    const before = [...(state.recipePacks.preferred||[])];
    state.recipePacks.preferred = dedupe(asArray(ids));
    pushUndo({ preferredPacks: before }); scheduleSave();
    notify({ recipePacks: state.recipePacks });
    automation.emit("cookingPrefs/packsPreferred", { ids: state.recipePacks.preferred });
    if (typeof bridge.onPacksChange === "function") try{ bridge.onPacksChange(state.recipePacks.preferred); }catch{}
    return state.recipePacks.preferred;
  },
  markPackUsed(id){
    if(!id) return;
    const list = state.recipePacks.recentUsed || [];
    state.recipePacks.recentUsed = [id, ...list.filter(x=>x!==id)].slice(0,20);
    scheduleSave(); notify({ packUsed:id });
    automation.emit("cookingPrefs/packUsed", { id });
    logEventInternal({ kind:"pack_select", payload:{ id } });
    return state.recipePacks.recentUsed;
  },

  /* Region/units/privacy */
  setRegion(region){
    const before = state.region; state.region = String(region||state.region);
    pushUndo({ region: before }); scheduleSave(); notify({ region: state.region });
    automation.emit("cookingPrefs/regionUpdated", { region: state.region }); return state.region;
  },
  setUnits(units){
    const u = units === "metric" ? "metric" : "imperial";
    const before = state.units; state.units = u;
    pushUndo({ units: before }); scheduleSave(); notify({ units: u });
    automation.emit("cookingPrefs/unitsUpdated", { units: u }); return state.units;
  },
  setPrivacy(patch){
    const before = { ...state.privacy }; state.privacy = { ...state.privacy, ...patch };
    pushUndo({ privacy: before }); scheduleSave(); notify({ privacy: state.privacy });
    automation.emit("cookingPrefs/privacyUpdated", { privacy: state.privacy }); return state.privacy;
  },

  /* Experiments (A/B) */
  enrollExperiment(name, arm="A", notes=""){
    state.experiments[name] = { arm, assignedAt: new Date().toISOString(), notes };
    scheduleSave(); notify({ experiment:{ name, arm }});
    automation.emit("cookingPrefs/experiment", { name, arm });
    logEventInternal({ kind:"ab_arm", payload:{ name, arm } });
    return state.experiments[name];
  },
  getExperimentArm(name, fallback="A"){ return state.experiments[name]?.arm || fallback; },

  /* Events */
  logEvent(evt){ const n = logEventInternal(evt); notify({ event:n }); return n; },

  /* Summarize & Learn (nightly/app-open) */
  summarizeAndLearn({ lookback=80 } = {}){
    const recent = state.events.slice(0, lookback);
    if(!recent.length) return { ok:true, changes:{} };

    let browningAdj=0, softnessAdj=0, smokinessAdj=0;
    const byCuisine = new Map();
    const packCounts = new Map();

    for(const e of recent){
      if(e.kind==="feedback"){
        if(e.payload?.deltas?.searSecondsPlus) browningAdj += 1;
        if(e.payload?.deltas?.braiseTimePlus || e.payload?.deltas?.restTimePlus) softnessAdj += 1;
        if(e.payload?.deltas?.smokeMore) smokinessAdj += 2;

        if(e.cuisine && (e.payload?.rating ?? 0) >= 4){
          const entry = byCuisine.get(e.cuisine) || { bias:new Set(), count:0 };
          if(e.payload?.deltas?.braiseTimePlus) entry.bias.add("slow_braise");
          if(e.payload?.deltas?.searSecondsPlus) entry.bias.add("hard_sear");
          if(e.payload?.deltas?.pressureCook) entry.bias.add("pressure_cook");
          if(e.payload?.deltas?.smokeMore) entry.bias.add("charcoal_grill");
          entry.count++; byCuisine.set(e.cuisine, entry);
        }
      }
      if(e.kind==="pack_select" && e.payload?.id) packCounts.set(e.payload.id,(packCounts.get(e.payload.id)||0)+1);
    }

    const sliderPatch = {};
    if(browningAdj) sliderPatch.browning = clamp(state.sliders.browning + browningAdj, 0, 100);
    if(softnessAdj) sliderPatch.softness = clamp(state.sliders.softness + softnessAdj, 0, 100);
    if(smokinessAdj) sliderPatch.smokiness = clamp(state.sliders.smokiness + smokinessAdj, 0, 100);
    if(Object.keys(sliderPatch).length){
      const before = { ...state.sliders };
      state.sliders = { ...state.sliders, ...sliderPatch };
      pushUndo({ sliders: before });
      automation.emit("cookingPrefs/slidersAutoNudged", { sliders: state.sliders, reason:"summarizeAndLearn" });
    }

    const stylePatches = [];
    for(const [cuisine, data] of byCuisine.entries()){
      if(!data.count) continue;
      const prev = state.houseStyles[cuisine] || {};
      const merged = new Set([...(prev.techniqueBias||[]), ...data.bias]);
      const hs = { techniqueBias: Array.from(merged), notes: prev.notes||"", lastRated: Math.max(prev.lastRated||0, 4), lastUpdated: new Date().toISOString() };
      state.houseStyles[cuisine] = hs; stylePatches.push({ cuisine, houseStyle: hs });
    }

    if(packCounts.size){
      const sorted = Array.from(packCounts.entries()).sort((a,b)=>b[1]-a[1]).map(([id])=>id);
      const before = [...state.recipePacks.preferred];
      state.recipePacks.preferred = dedupe([...sorted.slice(0,3), ...state.recipePacks.preferred]);
      pushUndo({ preferredPacks: before });
      if (typeof bridge.onPacksChange === "function") try{ bridge.onPacksChange(state.recipePacks.preferred); }catch{}
    }

    state.lastSummarizedAt = new Date().toISOString();
    scheduleSave();
    const changes = { sliderPatch, stylePatches, preferredPacks: state.recipePacks.preferred };
    notify({ summarizeAndLearn: changes });
    return { ok:true, changes };
  },

  /* Import/Export */
  exportJSON(){ return JSON.stringify({ ...state }, null, 2); },
  importJSON(json,{ merge=true }={}){
    try{
      const incoming = migrate(JSON.parse(json));
      if(!merge){ pushUndo({ revertTo: state }); state = incoming; }
      else{
        pushUndo({ revertTo: state });
        state.sliders = { ...state.sliders, ...incoming.sliders };
        state.appliances = dedupe([...state.appliances, ...incoming.appliances]);
        state.utensils = dedupe([...state.utensils, ...incoming.utensils]);
        state.units = incoming.units || state.units;
        state.region = incoming.region || state.region;
        state.privacy = { ...state.privacy, ...incoming.privacy };
        Object.entries(incoming.houseStyles||{}).forEach(([c,hs])=>{
          const prev = state.houseStyles[c] || {};
          state.houseStyles[c] = {
            techniqueBias: Array.from(new Set([...(prev.techniqueBias||[]), ...(hs.techniqueBias||[])])),
            notes: prev.notes || hs.notes || "",
            lastRated: Math.max(prev.lastRated||0, hs.lastRated||0),
            lastUpdated: new Date().toISOString(),
          };
        });
        Object.entries(incoming.dishStyles||{}).forEach(([k,ds])=>{
          const prev = state.dishStyles[k] || {};
          state.dishStyles[k] = {
            techniqueBias: Array.from(new Set([...(prev.techniqueBias||[]), ...(ds.techniqueBias||[])])),
            notes: prev.notes || ds.notes || "",
            lastRated: Math.max(prev.lastRated||0, ds.lastRated||0),
            lastUpdated: new Date().toISOString(),
          };
        });
        Object.entries(incoming.textureTargets||{}).forEach(([ik,t])=>{
          const prev = state.textureTargets[ik] || {};
          state.textureTargets[ik] = {
            doneness: clamp(t.doneness ?? prev.doneness ?? state.sliders.doneness, 0, 100),
            softness: clamp(t.softness ?? prev.softness ?? state.sliders.softness, 0, 100),
            notes: t.notes ?? prev.notes ?? "",
          };
        });
        state.recipePacks.preferred = dedupe([...state.recipePacks.preferred, ...(incoming.recipePacks?.preferred||[])]);
        state.recipePacks.recentUsed = dedupe([...(incoming.recipePacks?.recentUsed||[]), ...state.recipePacks.recentUsed]).slice(0,20);
        if((incoming.weeklyFlavorRhythm||[]).length) state.weeklyFlavorRhythm = incoming.weeklyFlavorRhythm.slice(0,7);
        state.events = [...incoming.events, ...state.events]; if(state.events.length>1200) state.events.length=1200;
      }
      scheduleSave(); notify({ imported:true });
      return { ok:true };
    }catch(err){ return { ok:false, error:String(err) }; }
  },

  /* ---------------------- Selectors / Interop ----------------------- */

  // For MealPlanAgent / CookingStylesAgent prompts
  getPromptContext(){
    return {
      kit: { appliances: state.appliances, utensils: state.utensils, caps: state.applianceCaps },
      sliders: state.sliders,
      region: state.region,
      units: state.units,
      rhythm: state.weeklyFlavorRhythm,
      packsPreferred: state.recipePacks.preferred,
    };
  },

  // Technique bias combining cuisine + dish
  selectTechniqueBias(cuisine, dish=null){
    const base = (cuisine && state.houseStyles[cuisine]?.techniqueBias) || [];
    if(!dish) return base;
    const ds = state.dishStyles[`${cuisine}::${dish}`]?.techniqueBias || [];
    return Array.from(new Set([...base, ...ds]));
  },

  // Resolve texture target for ingredient or inventory item
  selectTextureFor(itemOrName){
    const key = normalizeItemKey(itemOrName);
    return state.textureTargets[key] || { doneness: state.sliders.doneness, softness: state.sliders.softness, notes:"" };
  },

  // Batch Cooking: suggest “compatible techniques” for a list of dishes
  suggestBatchTechniqueBucket(cuisineList=[]){
    const allBiases = new Set();
    for(const c of cuisineList){ (this.selectTechniqueBias(c)||[]).forEach(t=>allBiases.add(t)); }
    // Favor slow_braise / pressure_cook / grill buckets if present
    if(allBiases.has("slow_braise")) return "slow_braise";
    if(allBiases.has("pressure_cook")) return "pressure_cook";
    if(allBiases.has("charcoal_grill")) return "charcoal_grill";
    if(allBiases.has("hard_sear")) return "hard_sear";
    return "mixed";
  },

  // Cloud sync stubs (optional)
  async syncToCloud(uploadFn){ if(!uploadFn) return { ok:false, error:"No uploadFn" }; try{ await uploadFn({ ...state }); return { ok:true }; }catch(e){ return { ok:false, error:String(e) }; } },
  async syncFromCloud(downloadFn){ if(!downloadFn) return { ok:false, error:"No downloadFn" }; try{ const remote=await downloadFn(); return this.importJSON(JSON.stringify(remote),{ merge:true }); }catch(e){ return { ok:false, error:String(e) }; } },
};

/* ------------------------- Internal helpers ------------------------- */

function sanitizeSliders(obj){ const out={}; for(const [k,v] of Object.entries(obj||{})) out[k]=clamp(Number(v),0,100); return out; }

function logEventInternal({ kind, cuisine=null, dish=null, itemKey=null, recipeId=null, payload={} }){
  const evt = { id: safeId(), ts: new Date().toISOString(), kind, cuisine, dish, itemKey, recipeId, payload };
  state.events.unshift(evt); if(state.events.length>1200) state.events.length=1200;
  if(kind==="feedback") automation.emit("cookingPrefs/feedback", evt);
  if(kind==="delta") automation.emit("cookingPrefs/delta", evt);
  if(kind==="approval") automation.emit("cookingPrefs/approval", evt);
  return evt;
}

function normalizeItemKey(itemOrName){
  if(!itemOrName) return null;
  if(typeof itemOrName === "string"){
    if (typeof bridge.ingredientToItemKey === "function") {
      try { return bridge.ingredientToItemKey(itemOrName) || itemOrName.toLowerCase().replace(/\s+/g,"_"); }
      catch { return itemOrName.toLowerCase().replace(/\s+/g,"_"); }
    }
    return itemOrName.toLowerCase().replace(/\s+/g,"_");
  }
  if(itemOrName?.key) return String(itemOrName.key);
  if(itemOrName?.name) return normalizeItemKey(itemOrName.name);
  return null;
}

/* ------------------------------ First-run UX ---------------------------- */

if (isBrowser() && !state.onboarding.askedForTasteOnce) {
  state.onboarding.askedForTasteOnce = true;
  scheduleSave();
  automation.emit("cookingPrefs/firstRun", {
    hint: "Set Taste Sliders, Kitchen Kit, Weekly Flavor Rhythm, and Recipe Packs to personalize planning.",
  });
}

// File: C:\Users\larho\suka-smart-assistant\src\store\VendorStore.js
/**
 * VendorStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Canonical vendor directory for SSA:
 *      • stores (local physical locations)
 *      • farmers / markets
 *      • butchers
 *      • pharmacies
 *      • services (cleaning supplies, repairs, etc.)
 *
 * Why this exists
 *  - Shopping Mode + Scan/Compare/Trust needs stable vendor ids for:
 *      • pricebook entries (by vendor/location)
 *      • receipts reconciliation
 *      • coupon applicability
 *      • advertising / local offers (future)
 *  - Household systems need a consistent place to reference where things were
 *    purchased / sourced (storehouse provenance).
 *
 * Design goals
 *  - Browser-safe (no Node imports), Vite-friendly.
 *  - Works with or without Dexie:
 *      • If Dexie table "vendors" exists -> persists there
 *      • else localStorage fallback
 *      • else in-memory
 *  - Event-bus friendly:
 *      • vendors.hydrated
 *      • vendors.changed
 *      • vendors.active.changed
 *
 * Vendor shape (tolerant)
 *  {
 *    id: string,
 *    name: string,
 *    kind: "grocery"|"butcher"|"farm"|"market"|"restaurant"|"hardware"|"pharmacy"|"service"|"custom",
 *    chain?: string,                 // e.g., "Kroger"
 *    tags?: string[],
 *
 *    // Physical presence (one vendor can have multiple locations)
 *    locations?: [{
 *      id: string,
 *      label?: string,               // "Main St"
 *      address?: {
 *        line1?, line2?, city?, state?, zip?, country?
 *      },
 *      geo?: { lat?: number, lng?: number },
 *      phone?: string,
 *      hours?: object,
 *      storeCode?: string,
 *      external?: { googlePlaceId?, wazeId?, mapquestId? },
 *      active?: boolean,
 *      meta?: object
 *    }],
 *
 *    // Online presence (optional)
 *    website?: string,
 *    loyalty?: { programName?, memberIdMasked?, notes? },
 *
 *    // commerce helpers
 *    defaultCurrency?: "USD",
 *    taxProfile?: { taxable?: boolean, rateHint?: number },
 *    paymentNotes?: string,
 *
 *    // SSA metadata
 *    active?: boolean,               // active vendor in UI contexts
 *    createdAtISO: string,
 *    updatedAtISO: string,
 *    meta?: object
 *  }
 */

const SOURCE = "store.VendorStore";
const STORAGE_KEY = "ssa.vendors.v1";

/* -----------------------------------------------------------------------------
 * Optional deps (safe dynamic imports)
 * -------------------------------------------------------------------------- */

let _depsPromise = null;
async function getDeps() {
  if (_depsPromise) return _depsPromise;

  _depsPromise = (async () => {
    let bus = null;
    let db = null;

    try {
      const mod = await import("../services/automation/eventBus.js").catch(
        () => null
      );
      bus =
        mod?.eventBus ||
        mod?.bus ||
        mod?.default?.eventBus ||
        mod?.default ||
        null;
    } catch {
      bus = null;
    }

    try {
      const mod = await import("../services/db.js").catch(() => null);
      db = mod?.db || mod?.default || mod || null;
    } catch {
      db = null;
    }

    return { bus, db };
  })();

  return _depsPromise;
}

function emit(bus, event, payload) {
  try {
    if (!bus) return;
    if (typeof bus.emit === "function") bus.emit(event, payload);
    else if (typeof bus.publish === "function") bus.publish(event, payload);
  } catch {
    /* no-op */
  }
}

/* -----------------------------------------------------------------------------
 * Utilities
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const nowISO = () => new Date().toISOString();

const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function stableId(prefix = "vend") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function deepMerge(base, patch) {
  if (!isObj(base) || !isObj(patch)) return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function normalizeAddress(a) {
  const x = safeObj(a);
  return {
    line1: x.line1 ? String(x.line1) : "",
    line2: x.line2 ? String(x.line2) : "",
    city: x.city ? String(x.city) : "",
    state: x.state ? String(x.state) : "",
    zip: x.zip ? String(x.zip) : "",
    country: x.country ? String(x.country) : "US",
  };
}

function normalizeGeo(g) {
  const x = safeObj(g);
  const lat = Number.isFinite(+x.lat) ? +x.lat : undefined;
  const lng = Number.isFinite(+x.lng) ? +x.lng : undefined;
  return { lat, lng };
}

function normalizeLocation(loc) {
  const x = safeObj(loc);
  const id = String(x.id || stableId("loc"));
  return {
    id,
    label: x.label ? String(x.label) : "",
    address: normalizeAddress(x.address),
    geo: normalizeGeo(x.geo),
    phone: x.phone ? String(x.phone) : "",
    hours: safeObj(x.hours),
    storeCode: x.storeCode ? String(x.storeCode) : "",
    external: safeObj(x.external),
    active: typeof x.active === "boolean" ? x.active : undefined,
    tags: safeArr(x.tags).map(String),
    meta: safeObj(x.meta),
  };
}

function normalizeVendor(vendor, { keepId = true } = {}) {
  const x = safeObj(vendor);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("vend"));

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();
  const updatedAtISO = nowISO();

  const name = x.name ? String(x.name) : x.title ? String(x.title) : "Vendor";
  const chain = x.chain ? String(x.chain) : "";
  const kind = x.kind ? String(x.kind) : "custom";

  const locationsInput = x.locations || x.stores || x.branches || [];
  const locations = safeArr(locationsInput).map(normalizeLocation);

  // ensure one active location if vendor.activeLocationId is provided
  const activeLocationId = x.activeLocationId
    ? String(x.activeLocationId)
    : null;
  if (activeLocationId) {
    for (const l of locations) l.active = l.id === activeLocationId;
  }

  return {
    ...safeObj(x),
    id: finalId,
    name,
    kind,
    chain,
    tags: safeArr(x.tags).map(String),
    locations,

    website: x.website ? String(x.website) : "",
    loyalty: safeObj(x.loyalty),
    defaultCurrency: x.defaultCurrency ? String(x.defaultCurrency) : "USD",
    taxProfile: safeObj(x.taxProfile),
    paymentNotes: x.paymentNotes ? String(x.paymentNotes) : "",

    active: typeof x.active === "boolean" ? x.active : undefined,
    createdAtISO,
    updatedAtISO,
    meta: safeObj(x.meta),
    source: x.source || SOURCE,
  };
}

function sortVendors(list) {
  const arr = safeArr(list).slice();
  arr.sort((a, b) => {
    // active first, then name
    const aa = a?.active === true ? 1 : 0;
    const bb = b?.active === true ? 1 : 0;
    if (bb !== aa) return bb - aa;
    return String(a?.name || "").localeCompare(String(b?.name || ""));
  });
  return arr;
}

function loadLS() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { vendors: [], activeVendorId: null };
    const parsed = JSON.parse(raw);
    return {
      vendors: safeArr(parsed.vendors),
      activeVendorId: parsed.activeVendorId
        ? String(parsed.activeVendorId)
        : null,
    };
  } catch {
    return { vendors: [], activeVendorId: null };
  }
}

function saveLS(state) {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        v: 1,
        savedAtISO: nowISO(),
        vendors: safeArr(state.vendors),
        activeVendorId: state.activeVendorId
          ? String(state.activeVendorId)
          : null,
      })
    );
    return true;
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Internal state + subscribers
 * -------------------------------------------------------------------------- */

const _state = {
  hydrated: false,
  loading: false,
  error: null,

  vendors: [],
  activeVendorId: null,

  source: "memory", // "dexie" | "localStorage" | "memory"
  lastLoadedAtISO: null,
  lastSavedAtISO: null,
};

const _subs = new Set();
function _notify() {
  for (const fn of _subs) {
    try {
      fn();
    } catch {}
  }
}
function _set(partial) {
  Object.assign(_state, partial);
  _notify();
}

function getSnapshot() {
  return {
    hydrated: _state.hydrated,
    loading: _state.loading,
    error: _state.error,
    vendors: sortVendors(_state.vendors),
    activeVendorId: _state.activeVendorId,
    source: _state.source,
    lastLoadedAtISO: _state.lastLoadedAtISO,
    lastSavedAtISO: _state.lastSavedAtISO,
  };
}

function subscribe(fn) {
  _subs.add(fn);
  return () => _subs.delete(fn);
}

/* -----------------------------------------------------------------------------
 * Dexie helpers
 * -------------------------------------------------------------------------- */

async function getVendorsTable(db) {
  try {
    if (!db) return null;
    if (db.vendors) return db.vendors;
    if (typeof db.table === "function") return db.table("vendors");
    return null;
  } catch {
    return null;
  }
}

/* -----------------------------------------------------------------------------
 * Hydrate / persist
 * -------------------------------------------------------------------------- */

async function hydrate() {
  if (_state.hydrated || _state.loading) return getSnapshot();
  _set({ loading: true, error: null });

  const { bus, db } = await getDeps();

  // Dexie first
  try {
    const t = await getVendorsTable(db);
    if (t && typeof t.toArray === "function") {
      const all = await t.toArray();
      const vendors = safeArr(all).map((v) =>
        normalizeVendor(v, { keepId: true })
      );

      // infer active vendor if one flagged
      let activeVendorId = _state.activeVendorId;
      const active = vendors.find((v) => v.active === true);
      if (active) activeVendorId = active.id;

      _set({
        vendors,
        activeVendorId: activeVendorId || null,
        hydrated: true,
        loading: false,
        source: "dexie",
        lastLoadedAtISO: nowISO(),
      });

      emit(bus, "vendors.hydrated", {
        at: _state.lastLoadedAtISO,
        source: "dexie",
        count: vendors.length,
      });
      return getSnapshot();
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage fallback
  try {
    const ls = loadLS();
    const vendors = safeArr(ls.vendors).map((v) =>
      normalizeVendor(v, { keepId: true })
    );
    _set({
      vendors,
      activeVendorId: ls.activeVendorId || null,
      hydrated: true,
      loading: false,
      source: "localStorage",
      lastLoadedAtISO: nowISO(),
    });

    emit(bus, "vendors.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "localStorage",
      count: vendors.length,
    });
    return getSnapshot();
  } catch (e) {
    _set({
      hydrated: true,
      loading: false,
      source: "memory",
      lastLoadedAtISO: nowISO(),
      error: e?.message || String(e),
    });
    emit(bus, "vendors.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "memory",
      count: _state.vendors.length,
    });
    return getSnapshot();
  }
}

async function persistNow() {
  const { bus, db } = await getDeps();
  const vendors = safeArr(_state.vendors);

  // Dexie
  try {
    const t = await getVendorsTable(db);
    if (t && typeof t.bulkPut === "function") {
      await t.bulkPut(vendors);
      _set({ lastSavedAtISO: nowISO(), source: "dexie" });
      emit(bus, "vendors.persisted", {
        at: _state.lastSavedAtISO,
        source: "dexie",
        count: vendors.length,
      });
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage
  const ok = saveLS({ vendors, activeVendorId: _state.activeVendorId });
  _set({
    lastSavedAtISO: nowISO(),
    source: ok ? "localStorage" : _state.source,
  });
  emit(bus, "vendors.persisted", {
    at: _state.lastSavedAtISO,
    source: ok ? "localStorage" : _state.source,
    count: vendors.length,
  });
  return { ok, source: ok ? "localStorage" : _state.source };
}

/* -----------------------------------------------------------------------------
 * CRUD
 * -------------------------------------------------------------------------- */

function getAll() {
  return sortVendors(_state.vendors);
}

function getById(id) {
  const vid = String(id || "");
  if (!vid) return null;
  return _state.vendors.find((v) => String(v.id) === vid) || null;
}

function getActiveVendor() {
  if (_state.activeVendorId) return getById(_state.activeVendorId);
  return (
    _state.vendors.find((v) => v.active === true) || _state.vendors[0] || null
  );
}

function setActiveVendor(id) {
  const vid = String(id || "");
  if (vid && !getById(vid)) return null;

  const vendors = _state.vendors.map((v) => ({
    ...v,
    active: vid ? v.id === vid : false,
    updatedAtISO: nowISO(),
  }));

  _set({ vendors, activeVendorId: vid || null });

  getDeps().then(({ bus }) => {
    emit(bus, "vendors.active.changed", {
      activeVendorId: _state.activeVendorId,
      at: nowISO(),
    });
    emit(bus, "vendors.changed", {
      type: "setActive",
      vendorId: _state.activeVendorId,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return getActiveVendor();
}

function upsert(vendorOrPartial) {
  const incoming = normalizeVendor(vendorOrPartial, { keepId: true });
  const existing = getById(incoming.id);

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        return merged;
      })()
    : incoming;

  const vendors = _state.vendors.filter((v) => v.id !== next.id);
  vendors.push(next);

  let activeVendorId = _state.activeVendorId;
  if (!activeVendorId) activeVendorId = next.id;

  _set({ vendors, activeVendorId });

  getDeps().then(({ bus }) => {
    emit(bus, "vendors.changed", {
      type: existing ? "upsert" : "create",
      vendorId: next.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return next;
}

function createVendor({
  name,
  kind = "custom",
  chain = "",
  website = "",
  locations = [],
  tags = [],
  meta = {},
} = {}) {
  const v = normalizeVendor(
    {
      id: stableId("vend"),
      name: name || "New Vendor",
      kind,
      chain,
      website,
      locations,
      tags,
      meta,
    },
    { keepId: true }
  );
  return upsert(v);
}

function removeVendor(id) {
  const vid = String(id || "");
  if (!vid) return false;

  const before = _state.vendors.length;
  const vendors = _state.vendors.filter((v) => v.id !== vid);

  let activeVendorId = _state.activeVendorId;
  if (activeVendorId === vid) {
    activeVendorId = vendors[0]?.id || null;
    for (const v of vendors) v.active = v.id === activeVendorId;
  }

  _set({ vendors, activeVendorId });

  const changed = before !== vendors.length;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "vendors.changed", {
        type: "remove",
        vendorId: vid,
        at: nowISO(),
      });
      emit(bus, "vendors.active.changed", { activeVendorId, at: nowISO() });
    });
    persistNow().catch(() => {});
  }

  return changed;
}

/* -----------------------------------------------------------------------------
 * Location operations
 * -------------------------------------------------------------------------- */

function addLocation(vendorId, location) {
  const v = getById(vendorId);
  if (!v) return null;

  const loc = normalizeLocation(location);
  const next = {
    ...v,
    locations: [...safeArr(v.locations), loc],
    updatedAtISO: nowISO(),
  };
  return upsert(next);
}

function updateLocation(vendorId, locationId, patch) {
  const v = getById(vendorId);
  if (!v) return null;

  const lid = String(locationId || "");
  if (!lid) return v;

  const locations = safeArr(v.locations).map((l) =>
    String(l.id) === lid ? deepMerge(l, safeObj(patch)) : l
  );
  const next = { ...v, locations, updatedAtISO: nowISO() };
  return upsert(next);
}

function removeLocation(vendorId, locationId) {
  const v = getById(vendorId);
  if (!v) return null;

  const lid = String(locationId || "");
  if (!lid) return v;

  const locations = safeArr(v.locations).filter((l) => String(l.id) !== lid);
  const next = { ...v, locations, updatedAtISO: nowISO() };
  return upsert(next);
}

function setActiveLocation(vendorId, locationId) {
  const v = getById(vendorId);
  if (!v) return null;

  const lid = String(locationId || "");
  const locations = safeArr(v.locations).map((l) => ({
    ...l,
    active: lid ? l.id === lid : false,
  }));
  const next = {
    ...v,
    locations,
    activeLocationId: lid || null,
    updatedAtISO: nowISO(),
  };
  return upsert(next);
}

/* -----------------------------------------------------------------------------
 * Finders & helpers
 * -------------------------------------------------------------------------- */

function findByName(name) {
  const q = keyOf(name);
  if (!q) return [];
  return sortVendors(
    _state.vendors.filter(
      (v) => keyOf(v.name).includes(q) || keyOf(v.chain).includes(q)
    )
  );
}

function findByExternalPlaceId(placeId) {
  const pid = String(placeId || "").trim();
  if (!pid) return null;
  for (const v of _state.vendors) {
    for (const loc of safeArr(v.locations)) {
      if (String(loc?.external?.googlePlaceId || "") === pid)
        return { vendor: v, location: loc };
    }
  }
  return null;
}

function getPrimaryLocation(vendorId) {
  const v = getById(vendorId);
  if (!v) return null;
  const locations = safeArr(v.locations);
  return locations.find((l) => l.active === true) || locations[0] || null;
}

function upsertFromReceiptContext({
  vendorName,
  chain,
  storeCode,
  address,
  geo,
  phone,
  external,
  kindHint,
  tags,
} = {}) {
  const name = String(vendorName || "").trim();
  if (!name) return null;

  // try match by name + storeCode
  const storeCodeNorm = String(storeCode || "").trim();
  const candidates = _state.vendors.filter(
    (v) => keyOf(v.name) === keyOf(name) || keyOf(v.chain) === keyOf(name)
  );
  let found = null;
  let foundLoc = null;

  if (candidates.length) {
    for (const v of candidates) {
      const locs = safeArr(v.locations);
      if (!storeCodeNorm) {
        found = v;
        break;
      }
      const match = locs.find(
        (l) => String(l.storeCode || "").trim() === storeCodeNorm
      );
      if (match) {
        found = v;
        foundLoc = match;
        break;
      }
    }
    if (!found) found = candidates[0];
  }

  const kind = kindHint ? String(kindHint) : found?.kind || "grocery";

  if (!found) {
    // create vendor + one location
    const v = createVendor({
      name,
      kind,
      chain: chain ? String(chain) : "",
      tags: safeArr(tags).map(String),
      locations: [
        {
          label: storeCodeNorm ? `Store ${storeCodeNorm}` : "",
          storeCode: storeCodeNorm,
          address: safeObj(address),
          geo: safeObj(geo),
          phone: phone ? String(phone) : "",
          external: safeObj(external),
          active: true,
        },
      ],
    });
    setActiveVendor(v.id);
    return { vendor: v, location: getPrimaryLocation(v.id) };
  }

  // ensure location exists/updated
  const nextVendor = normalizeVendor(found, { keepId: true });
  const locs = safeArr(nextVendor.locations);

  if (storeCodeNorm) {
    const idx = locs.findIndex(
      (l) => String(l.storeCode || "").trim() === storeCodeNorm
    );
    if (idx >= 0) {
      locs[idx] = deepMerge(locs[idx], {
        address: safeObj(address),
        geo: safeObj(geo),
        phone: phone ? String(phone) : locs[idx].phone,
        external: deepMerge(safeObj(locs[idx].external), safeObj(external)),
      });
      // keep active location
      locs[idx].active = true;
    } else {
      locs.push(
        normalizeLocation({
          label: `Store ${storeCodeNorm}`,
          storeCode: storeCodeNorm,
          address,
          geo,
          phone,
          external,
          active: true,
        })
      );
    }
  } else if (!foundLoc && (address || geo || external)) {
    // update first location lightly, or add one if none
    if (locs.length) {
      locs[0] = deepMerge(locs[0], {
        address: safeObj(address),
        geo: safeObj(geo),
        phone: phone ? String(phone) : locs[0].phone,
        external: deepMerge(safeObj(locs[0].external), safeObj(external)),
      });
      locs[0].active = true;
    } else {
      locs.push(
        normalizeLocation({
          label: "",
          storeCode: "",
          address,
          geo,
          phone,
          external,
          active: true,
        })
      );
    }
  }

  const mergedTags = Array.from(
    new Set([
      ...safeArr(nextVendor.tags).map(String),
      ...safeArr(tags).map(String),
    ])
  ).filter(Boolean);

  const updated = upsert({
    ...nextVendor,
    kind,
    chain: chain ? String(chain) : nextVendor.chain,
    tags: mergedTags,
    locations: locs,
  });

  setActiveVendor(updated.id);
  return { vendor: updated, location: getPrimaryLocation(updated.id) };
}

/* -----------------------------------------------------------------------------
 * Public facade
 * -------------------------------------------------------------------------- */

const VendorStore = {
  // status
  hydrate,
  persistNow,
  getSnapshot,
  subscribe,

  // vendors
  getAll,
  getById,
  getActiveVendor,
  setActiveVendor,
  createVendor,
  upsert,
  removeVendor,

  // locations
  addLocation,
  updateLocation,
  removeLocation,
  setActiveLocation,
  getPrimaryLocation,

  // finders
  findByName,
  findByExternalPlaceId,

  // convenience
  upsertFromReceiptContext,

  // diagnostics
  _unsafeState: _state,
};

export default VendorStore;
export { VendorStore };

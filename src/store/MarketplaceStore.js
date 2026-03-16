// File: C:\Users\larho\suka-smart-assistant\src\store\MarketplaceStore.js
/**
 * MarketplaceStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Lightweight marketplace/commerce layer for SSA that supports:
 *      • local vendors (farmers, butchers, markets, co-ops)
 *      • listings (items/services offered)
 *      • offers / bids / quotes (optional)
 *      • saved/favorite vendors + watchlists
 *      • local-only shopping intent (physical locations, not online carts)
 *      • "ad impressions" + "lead events" for monetization experiments
 *
 * Design goals
 *  - Browser-safe, Vite-friendly (no Node imports).
 *  - Works with or without Dexie:
 *      • If Dexie tables exist -> persists there
 *      • Else localStorage fallback (ssa.marketplace.v1)
 *      • Else in-memory
 *  - Event-bus friendly:
 *      • marketplace.hydrated
 *      • marketplace.changed
 *      • marketplace.vendor.changed
 *      • marketplace.listing.changed
 *      • marketplace.offer.changed
 *      • marketplace.analytics.event
 *
 * Expected tables (optional; auto-detect)
 *  - marketplace_vendors (or marketplaceVendors)
 *  - marketplace_listings (or marketplaceListings)
 *  - marketplace_offers (or marketplaceOffers)
 *  - marketplace_events (or marketplaceEvents) [optional analytics]
 *
 * Notes
 *  - This store intentionally avoids network calls. Any Google Places / MapQuest
 *    sync is expected to happen in separate services, which can upsert vendors.
 */

const SOURCE = "store.MarketplaceStore";
const STORAGE_KEY = "ssa.marketplace.v1";

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

function stableId(prefix = "mp") {
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

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function parseISO(x) {
  if (!x) return null;
  const d = new Date(x);
  return Number.isFinite(d.getTime()) ? d : null;
}

/* -----------------------------------------------------------------------------
 * Normalization
 * -------------------------------------------------------------------------- */

/**
 * Vendor shape (tolerant)
 * {
 *  id, name, kind, tags, notes,
 *  address, geo:{lat,lng}, phone, email, website,
 *  hours, serviceArea, pickupDelivery,
 *  ratings:{score,count},
 *  external:{ googlePlaceId, mapquestId, ... },
 *  status:"active"|"inactive"|"blocked",
 *  favorites:boolean,
 *  createdAtISO, updatedAtISO
 * }
 */
function normalizeVendor(v, { keepId = true } = {}) {
  const x = safeObj(v);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("v"));

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();
  const updatedAtISO = nowISO();

  const name = x.name ? String(x.name) : "Vendor";
  const kind = x.kind
    ? String(x.kind)
    : x.category
    ? String(x.category)
    : "local";

  const geo = safeObj(x.geo || x.location);
  const lat = Number.isFinite(+geo.lat)
    ? +geo.lat
    : Number.isFinite(+x.lat)
    ? +x.lat
    : undefined;
  const lng = Number.isFinite(+geo.lng)
    ? +geo.lng
    : Number.isFinite(+x.lng)
    ? +x.lng
    : undefined;

  const external = safeObj(x.external);
  // convenience mapping if present
  if (x.googlePlaceId && !external.googlePlaceId)
    external.googlePlaceId = String(x.googlePlaceId);
  if (x.mapquestId && !external.mapquestId)
    external.mapquestId = String(x.mapquestId);

  const ratings = safeObj(x.ratings);
  const score = Number.isFinite(+ratings.score)
    ? +ratings.score
    : Number.isFinite(+x.rating)
    ? +x.rating
    : undefined;
  const count = Number.isFinite(+ratings.count) ? +ratings.count : undefined;

  return {
    ...safeObj(x),
    id: finalId,
    name,
    kind,
    tags: safeArr(x.tags).map(String),
    notes: x.notes ? String(x.notes) : "",

    address: x.address ? String(x.address) : "",
    geo: {
      lat,
      lng,
    },
    phone: x.phone ? String(x.phone) : "",
    email: x.email ? String(x.email) : "",
    website: x.website ? String(x.website) : "",

    hours: safeObj(x.hours),
    serviceArea: safeObj(x.serviceArea),
    pickupDelivery: safeObj(x.pickupDelivery), // { pickup:true, delivery:false, shipping:false }

    ratings: {
      score,
      count,
    },

    external,
    status: x.status ? String(x.status) : "active",
    favorite: typeof x.favorite === "boolean" ? x.favorite : !!x.favorites,

    createdAtISO,
    updatedAtISO,
    source: x.source || SOURCE,
  };
}

/**
 * Listing shape (tolerant)
 * {
 *  id, vendorId, title, category,
 *  sku, upc, tags,
 *  price:{amount,currency,unit}, availability, minQty,
 *  pack, images, description,
 *  storeLocation:{ address, geo }, physicalOnly:true,
 *  quality:{ grade, notes }, compliance:{ torahOk?:true/false }, // optional constraints
 *  createdAtISO, updatedAtISO
 * }
 */
function normalizeListing(l, { keepId = true } = {}) {
  const x = safeObj(l);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("l"));

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();
  const updatedAtISO = nowISO();

  const priceObj = safeObj(x.price);
  const amount = Number.isFinite(+priceObj.amount)
    ? +priceObj.amount
    : Number.isFinite(+x.amount)
    ? +x.amount
    : undefined;
  const currency = priceObj.currency
    ? String(priceObj.currency)
    : x.currency
    ? String(x.currency)
    : "USD";
  const unit = priceObj.unit
    ? String(priceObj.unit)
    : x.unit
    ? String(x.unit)
    : "";

  const availability = x.availability ? String(x.availability) : "unknown"; // in_stock / out_of_stock / seasonal / unknown
  const physicalOnly = x.physicalOnly !== false; // default true for SSA local shopping

  return {
    ...safeObj(x),
    id: finalId,
    vendorId: x.vendorId ? String(x.vendorId) : "",
    title: x.title ? String(x.title) : x.name ? String(x.name) : "Listing",
    category: x.category ? String(x.category) : "",

    sku: x.sku ? String(x.sku) : "",
    upc: x.upc ? String(x.upc) : x.barcode ? String(x.barcode) : "",

    tags: safeArr(x.tags).map(String),

    price: {
      amount,
      currency,
      unit,
    },
    availability,
    minQty: Number.isFinite(+x.minQty) ? clamp(+x.minQty, 0, 1e9) : undefined,

    pack: safeObj(x.pack), // { count, size, unit }
    images: safeArr(x.images),
    description: x.description ? String(x.description) : "",

    storeLocation: safeObj(x.storeLocation),
    physicalOnly,

    quality: safeObj(x.quality),
    compliance: safeObj(x.compliance),

    createdAtISO,
    updatedAtISO,
    source: x.source || SOURCE,
  };
}

/**
 * Offer/Quote shape (tolerant)
 * {
 *  id, listingId, vendorId,
 *  type:"quote"|"offer"|"bid",
 *  status:"open"|"accepted"|"rejected"|"expired"|"cancelled",
 *  price, qty, message,
 *  validUntilISO,
 *  createdAtISO, updatedAtISO
 * }
 */
function normalizeOffer(o, { keepId = true } = {}) {
  const x = safeObj(o);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("o"));

  const createdAtISO = x.createdAtISO
    ? String(x.createdAtISO)
    : x.createdAt
    ? String(x.createdAt)
    : nowISO();
  const updatedAtISO = nowISO();

  const priceObj = safeObj(x.price);
  const amount = Number.isFinite(+priceObj.amount)
    ? +priceObj.amount
    : Number.isFinite(+x.amount)
    ? +x.amount
    : undefined;
  const currency = priceObj.currency
    ? String(priceObj.currency)
    : x.currency
    ? String(x.currency)
    : "USD";
  const unit = priceObj.unit
    ? String(priceObj.unit)
    : x.unit
    ? String(x.unit)
    : "";

  return {
    ...safeObj(x),
    id: finalId,
    listingId: x.listingId ? String(x.listingId) : "",
    vendorId: x.vendorId ? String(x.vendorId) : "",

    type: x.type ? String(x.type) : "quote",
    status: x.status ? String(x.status) : "open",

    price: { amount, currency, unit },
    qty: Number.isFinite(+x.qty) ? clamp(+x.qty, 0, 1e9) : undefined,
    message: x.message ? String(x.message) : "",

    validUntilISO: x.validUntilISO ? String(x.validUntilISO) : "",

    createdAtISO,
    updatedAtISO,
    source: x.source || SOURCE,
  };
}

/**
 * Marketplace analytics event (impressions/leads)
 * {
 *  id, kind:"impression"|"click"|"lead"|"call"|"directions",
 *  vendorId?, listingId?, route?, placement?,
 *  tsISO, meta
 * }
 */
function normalizeEvent(e, { keepId = true } = {}) {
  const x = safeObj(e);
  const id = keepId ? String(x.id || "") : "";
  const finalId = id || String(x.id || stableId("e"));

  const tsISO = x.tsISO
    ? String(x.tsISO)
    : x.ts
    ? new Date(x.ts).toISOString()
    : nowISO();

  return {
    ...safeObj(x),
    id: finalId,
    kind: x.kind ? String(x.kind) : "impression",
    vendorId: x.vendorId ? String(x.vendorId) : "",
    listingId: x.listingId ? String(x.listingId) : "",
    route: x.route ? String(x.route) : "",
    placement: x.placement ? String(x.placement) : "",
    tsISO,
    meta: safeObj(x.meta),
    source: x.source || SOURCE,
  };
}

/* -----------------------------------------------------------------------------
 * localStorage IO
 * -------------------------------------------------------------------------- */

function loadLS() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { vendors: [], listings: [], offers: [], events: [] };
    const parsed = JSON.parse(raw);
    return {
      vendors: safeArr(parsed.vendors),
      listings: safeArr(parsed.listings),
      offers: safeArr(parsed.offers),
      events: safeArr(parsed.events),
    };
  } catch {
    return { vendors: [], listings: [], offers: [], events: [] };
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
        listings: safeArr(state.listings),
        offers: safeArr(state.offers),
        events: safeArr(state.events),
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
  listings: [],
  offers: [],
  events: [],

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
    vendors: _state.vendors.slice(),
    listings: _state.listings.slice(),
    offers: _state.offers.slice(),
    events: _state.events.slice(),
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
 * Dexie helpers (auto-detect)
 * -------------------------------------------------------------------------- */

async function getTable(db, snake, camel) {
  try {
    if (!db) return null;
    if (db[snake]) return db[snake];
    if (db[camel]) return db[camel];
    if (typeof db.table === "function") {
      try {
        return db.table(snake);
      } catch {
        return db.table(camel);
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function getVendorsTable(db) {
  return getTable(db, "marketplace_vendors", "marketplaceVendors");
}
async function getListingsTable(db) {
  return getTable(db, "marketplace_listings", "marketplaceListings");
}
async function getOffersTable(db) {
  return getTable(db, "marketplace_offers", "marketplaceOffers");
}
async function getEventsTable(db) {
  return getTable(db, "marketplace_events", "marketplaceEvents");
}

/* -----------------------------------------------------------------------------
 * Hydrate / persist
 * -------------------------------------------------------------------------- */

async function hydrate() {
  if (_state.hydrated || _state.loading) return getSnapshot();
  _set({ loading: true, error: null });

  const { bus, db } = await getDeps();

  // Dexie first (if tables exist)
  try {
    const tv = await getVendorsTable(db);
    const tl = await getListingsTable(db);
    const to = await getOffersTable(db);
    const te = await getEventsTable(db);

    if (tv && typeof tv.toArray === "function") {
      const vendorsRaw = await tv.toArray();
      const vendors = safeArr(vendorsRaw).map((v) =>
        normalizeVendor(v, { keepId: true })
      );

      let listings = [];
      if (tl && typeof tl.toArray === "function") {
        const listingsRaw = await tl.toArray();
        listings = safeArr(listingsRaw).map((l) =>
          normalizeListing(l, { keepId: true })
        );
      }

      let offers = [];
      if (to && typeof to.toArray === "function") {
        const offersRaw = await to.toArray();
        offers = safeArr(offersRaw).map((o) =>
          normalizeOffer(o, { keepId: true })
        );
      }

      let events = [];
      if (te && typeof te.toArray === "function") {
        const eventsRaw = await te.toArray();
        events = safeArr(eventsRaw).map((e) =>
          normalizeEvent(e, { keepId: true })
        );
      }

      _set({
        vendors,
        listings,
        offers,
        events,
        hydrated: true,
        loading: false,
        source: "dexie",
        lastLoadedAtISO: nowISO(),
      });

      emit(bus, "marketplace.hydrated", {
        at: _state.lastLoadedAtISO,
        source: "dexie",
        vendors: vendors.length,
        listings: listings.length,
        offers: offers.length,
        events: events.length,
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
    const listings = safeArr(ls.listings).map((l) =>
      normalizeListing(l, { keepId: true })
    );
    const offers = safeArr(ls.offers).map((o) =>
      normalizeOffer(o, { keepId: true })
    );
    const events = safeArr(ls.events).map((e) =>
      normalizeEvent(e, { keepId: true })
    );

    _set({
      vendors,
      listings,
      offers,
      events,
      hydrated: true,
      loading: false,
      source: "localStorage",
      lastLoadedAtISO: nowISO(),
    });

    emit(bus, "marketplace.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "localStorage",
      vendors: vendors.length,
      listings: listings.length,
      offers: offers.length,
      events: events.length,
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

    emit(bus, "marketplace.hydrated", {
      at: _state.lastLoadedAtISO,
      source: "memory",
      vendors: _state.vendors.length,
      listings: _state.listings.length,
      offers: _state.offers.length,
      events: _state.events.length,
    });

    return getSnapshot();
  }
}

async function persistNow() {
  const { bus, db } = await getDeps();

  const vendors = safeArr(_state.vendors);
  const listings = safeArr(_state.listings);
  const offers = safeArr(_state.offers);
  const events = safeArr(_state.events);

  // Dexie
  try {
    const tv = await getVendorsTable(db);
    const tl = await getListingsTable(db);
    const to = await getOffersTable(db);
    const te = await getEventsTable(db);

    if (tv && typeof tv.bulkPut === "function") {
      await tv.bulkPut(vendors);
      if (tl && typeof tl.bulkPut === "function") await tl.bulkPut(listings);
      if (to && typeof to.bulkPut === "function") await to.bulkPut(offers);
      if (te && typeof te.bulkPut === "function") await te.bulkPut(events);

      _set({ lastSavedAtISO: nowISO(), source: "dexie" });
      emit(bus, "marketplace.persisted", {
        at: _state.lastSavedAtISO,
        source: "dexie",
      });
      return { ok: true, source: "dexie" };
    }
  } catch (e) {
    _set({ error: e?.message || String(e) });
  }

  // localStorage
  const ok = saveLS({ vendors, listings, offers, events });
  _set({
    lastSavedAtISO: nowISO(),
    source: ok ? "localStorage" : _state.source,
  });
  emit(bus, "marketplace.persisted", {
    at: _state.lastSavedAtISO,
    source: ok ? "localStorage" : _state.source,
  });
  return { ok, source: ok ? "localStorage" : _state.source };
}

/* -----------------------------------------------------------------------------
 * Vendor CRUD + helpers
 * -------------------------------------------------------------------------- */

function listVendors({
  onlyActive = true,
  favoritesFirst = true,
  q = "",
  tag = "",
} = {}) {
  const query = keyOf(q);
  const tagKey = keyOf(tag);

  let rows = _state.vendors.slice();

  if (onlyActive)
    rows = rows.filter(
      (v) => String(v.status) !== "blocked" && String(v.status) !== "inactive"
    );

  if (query) {
    rows = rows.filter((v) => {
      const hay = `${v.name} ${v.kind} ${v.address} ${safeArr(v.tags).join(
        " "
      )} ${v.notes}`.toLowerCase();
      return hay.includes(query.replace(/_/g, " "));
    });
  }

  if (tagKey) {
    rows = rows.filter((v) => safeArr(v.tags).map(keyOf).includes(tagKey));
  }

  rows.sort((a, b) => {
    if (favoritesFirst) {
      const af = a.favorite ? 1 : 0;
      const bf = b.favorite ? 1 : 0;
      if (bf !== af) return bf - af;
    }
    const ar = Number(a?.ratings?.score || 0);
    const br = Number(b?.ratings?.score || 0);
    if (br !== ar) return br - ar;

    return String(a.name || "").localeCompare(String(b.name || ""));
  });

  return rows;
}

function getVendorById(id) {
  const vid = String(id || "");
  if (!vid) return null;
  return _state.vendors.find((v) => String(v.id) === vid) || null;
}

function findVendorByExternal({ googlePlaceId, mapquestId } = {}) {
  const gp = googlePlaceId ? String(googlePlaceId) : "";
  const mq = mapquestId ? String(mapquestId) : "";
  if (!gp && !mq) return null;

  return (
    _state.vendors.find((v) => {
      const ext = safeObj(v.external);
      return (
        (gp && String(ext.googlePlaceId || "") === gp) ||
        (mq && String(ext.mapquestId || "") === mq)
      );
    }) || null
  );
}

function upsertVendor(vendorOrPartial) {
  const incoming = normalizeVendor(vendorOrPartial, { keepId: true });

  // attempt merge by external ids if id missing/unknown
  let existing = getVendorById(incoming.id);
  if (!existing) {
    const ext = safeObj(incoming.external);
    existing = findVendorByExternal({
      googlePlaceId: ext.googlePlaceId,
      mapquestId: ext.mapquestId,
    });
  }

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        return merged;
      })()
    : incoming;

  const vendors = _state.vendors.filter(
    (v) => v.id !== (existing ? existing.id : next.id)
  );
  vendors.push(next);

  _set({ vendors });

  getDeps().then(({ bus }) => {
    emit(bus, "marketplace.vendor.changed", {
      type: existing ? "upsert" : "create",
      vendorId: next.id,
      at: nowISO(),
    });
    emit(bus, "marketplace.changed", {
      type: "vendor",
      vendorId: next.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return next;
}

function createVendor({
  name = "New Vendor",
  kind = "local",
  address = "",
  geo,
  phone = "",
  email = "",
  website = "",
  tags = [],
  notes = "",
  external = {},
  status = "active",
  favorite = false,
  ratings = {},
  pickupDelivery = {},
  hours = {},
  meta = {},
} = {}) {
  const v = normalizeVendor(
    {
      id: stableId("v"),
      name,
      kind,
      address,
      geo,
      phone,
      email,
      website,
      tags,
      notes,
      external,
      status,
      favorite,
      ratings,
      pickupDelivery,
      hours,
      meta,
    },
    { keepId: true }
  );
  return upsertVendor(v);
}

function removeVendor(id, { hard = false } = {}) {
  const vid = String(id || "");
  if (!vid) return false;

  const before = _state.vendors.length;

  let vendors = _state.vendors.slice();
  if (hard) vendors = vendors.filter((v) => v.id !== vid);
  else
    vendors = vendors.map((v) =>
      v.id === vid ? { ...v, status: "inactive", updatedAtISO: nowISO() } : v
    );

  // soft-remove related listings/offers?
  const listings = _state.listings
    .map((l) =>
      l.vendorId === vid
        ? {
            ...l,
            availability: hard ? l.availability : "out_of_stock",
            updatedAtISO: nowISO(),
          }
        : l
    )
    .filter((l) => (hard ? l.vendorId !== vid : true));

  const offers = _state.offers.filter((o) =>
    hard ? o.vendorId !== vid : true
  );

  _set({ vendors, listings, offers });

  const changed = before !== vendors.length || !hard;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "marketplace.vendor.changed", {
        type: hard ? "remove" : "deactivate",
        vendorId: vid,
        at: nowISO(),
      });
      emit(bus, "marketplace.changed", {
        type: "vendor",
        vendorId: vid,
        at: nowISO(),
      });
    });
    persistNow().catch(() => {});
  }

  return changed;
}

function toggleFavoriteVendor(id, fav) {
  const v = getVendorById(id);
  if (!v) return null;
  const nextFav = typeof fav === "boolean" ? fav : !v.favorite;
  return upsertVendor({ ...v, favorite: nextFav });
}

/* -----------------------------------------------------------------------------
 * Listing CRUD + helpers
 * -------------------------------------------------------------------------- */

function listListings({
  vendorId = "",
  onlyPhysical = true,
  availability = "",
  q = "",
  tag = "",
  category = "",
  limit = 500,
} = {}) {
  const vid = String(vendorId || "");
  const query = keyOf(q);
  const tagKey = keyOf(tag);
  const cat = String(category || "");

  let rows = _state.listings.slice();
  if (vid) rows = rows.filter((l) => String(l.vendorId) === vid);
  if (onlyPhysical) rows = rows.filter((l) => l.physicalOnly !== false);
  if (availability)
    rows = rows.filter((l) => String(l.availability) === String(availability));
  if (cat) rows = rows.filter((l) => String(l.category) === cat);

  if (query) {
    rows = rows.filter((l) => {
      const hay = `${l.title} ${l.category} ${l.sku} ${l.upc} ${safeArr(
        l.tags
      ).join(" ")} ${l.description}`.toLowerCase();
      return hay.includes(query.replace(/_/g, " "));
    });
  }

  if (tagKey) {
    rows = rows.filter((l) => safeArr(l.tags).map(keyOf).includes(tagKey));
  }

  rows.sort((a, b) => {
    // prefer in-stock then cheapest
    const rank = (x) => (x === "in_stock" ? 2 : x === "seasonal" ? 1 : 0);
    const ra = rank(String(a.availability));
    const rb = rank(String(b.availability));
    if (rb !== ra) return rb - ra;

    const ap = Number(a?.price?.amount);
    const bp = Number(b?.price?.amount);
    if (Number.isFinite(ap) && Number.isFinite(bp) && ap !== bp) return ap - bp;

    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  if (Number.isFinite(+limit) && +limit > 0) rows = rows.slice(0, +limit);
  return rows;
}

function getListingById(id) {
  const lid = String(id || "");
  if (!lid) return null;
  return _state.listings.find((l) => String(l.id) === lid) || null;
}

function upsertListing(listingOrPartial) {
  const incoming = normalizeListing(listingOrPartial, { keepId: true });
  const existing = getListingById(incoming.id);

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        return merged;
      })()
    : incoming;

  const listings = _state.listings.filter((l) => l.id !== next.id);
  listings.push(next);

  _set({ listings });

  getDeps().then(({ bus }) => {
    emit(bus, "marketplace.listing.changed", {
      type: existing ? "upsert" : "create",
      listingId: next.id,
      vendorId: next.vendorId,
      at: nowISO(),
    });
    emit(bus, "marketplace.changed", {
      type: "listing",
      listingId: next.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return next;
}

function createListing({
  vendorId,
  title = "New Listing",
  category = "",
  price = {},
  availability = "unknown",
  tags = [],
  sku = "",
  upc = "",
  description = "",
  images = [],
  physicalOnly = true,
  storeLocation = {},
  quality = {},
  compliance = {},
  meta = {},
} = {}) {
  const l = normalizeListing(
    {
      id: stableId("l"),
      vendorId: vendorId ? String(vendorId) : "",
      title,
      category,
      price,
      availability,
      tags,
      sku,
      upc,
      description,
      images,
      physicalOnly,
      storeLocation,
      quality,
      compliance,
      meta,
    },
    { keepId: true }
  );
  return upsertListing(l);
}

function removeListing(id, { hard = false } = {}) {
  const lid = String(id || "");
  if (!lid) return false;

  const before = _state.listings.length;

  let listings = _state.listings.slice();
  const listing = listings.find((l) => l.id === lid) || null;

  if (hard) listings = listings.filter((l) => l.id !== lid);
  else
    listings = listings.map((l) =>
      l.id === lid
        ? { ...l, availability: "out_of_stock", updatedAtISO: nowISO() }
        : l
    );

  // offers linked
  const offers = _state.offers
    .filter((o) => (hard ? o.listingId !== lid : true))
    .map((o) => {
      if (!hard && o.listingId === lid && o.status === "open")
        return { ...o, status: "expired", updatedAtISO: nowISO() };
      return o;
    });

  _set({ listings, offers });

  const changed = before !== listings.length || !hard;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "marketplace.listing.changed", {
        type: hard ? "remove" : "deactivate",
        listingId: lid,
        vendorId: listing?.vendorId || "",
        at: nowISO(),
      });
      emit(bus, "marketplace.changed", {
        type: "listing",
        listingId: lid,
        at: nowISO(),
      });
    });
    persistNow().catch(() => {});
  }

  return changed;
}

/* -----------------------------------------------------------------------------
 * Offers / quotes
 * -------------------------------------------------------------------------- */

function listOffers({
  vendorId = "",
  listingId = "",
  status = "",
  limit = 500,
} = {}) {
  const vid = String(vendorId || "");
  const lid = String(listingId || "");
  const st = String(status || "");

  let rows = _state.offers.slice();
  if (vid) rows = rows.filter((o) => String(o.vendorId) === vid);
  if (lid) rows = rows.filter((o) => String(o.listingId) === lid);
  if (st) rows = rows.filter((o) => String(o.status) === st);

  // newest first
  rows.sort((a, b) =>
    String(b.updatedAtISO || b.createdAtISO || "").localeCompare(
      String(a.updatedAtISO || a.createdAtISO || "")
    )
  );

  if (Number.isFinite(+limit) && +limit > 0) rows = rows.slice(0, +limit);
  return rows;
}

function getOfferById(id) {
  const oid = String(id || "");
  if (!oid) return null;
  return _state.offers.find((o) => String(o.id) === oid) || null;
}

function upsertOffer(offerOrPartial) {
  const incoming = normalizeOffer(offerOrPartial, { keepId: true });
  const existing = getOfferById(incoming.id);

  const next = existing
    ? (() => {
        const merged = deepMerge(existing, incoming);
        merged.createdAtISO = existing.createdAtISO || incoming.createdAtISO;
        merged.updatedAtISO = nowISO();
        return merged;
      })()
    : incoming;

  const offers = _state.offers.filter((o) => o.id !== next.id);
  offers.push(next);

  _set({ offers });

  getDeps().then(({ bus }) => {
    emit(bus, "marketplace.offer.changed", {
      type: existing ? "upsert" : "create",
      offerId: next.id,
      vendorId: next.vendorId,
      listingId: next.listingId,
      at: nowISO(),
    });
    emit(bus, "marketplace.changed", {
      type: "offer",
      offerId: next.id,
      at: nowISO(),
    });
  });

  persistNow().catch(() => {});
  return next;
}

function createOffer({
  listingId = "",
  vendorId = "",
  type = "quote",
  status = "open",
  price = {},
  qty,
  message = "",
  validUntilISO = "",
  tags = [],
  meta = {},
} = {}) {
  const o = normalizeOffer(
    {
      id: stableId("o"),
      listingId,
      vendorId,
      type,
      status,
      price,
      qty,
      message,
      validUntilISO,
      tags,
      meta,
    },
    { keepId: true }
  );
  return upsertOffer(o);
}

function setOfferStatus(id, status) {
  const o = getOfferById(id);
  if (!o) return null;
  return upsertOffer({ ...o, status: String(status || "open") });
}

function removeOffer(id) {
  const oid = String(id || "");
  if (!oid) return false;
  const before = _state.offers.length;
  const offers = _state.offers.filter((o) => o.id !== oid);
  _set({ offers });

  const changed = before !== offers.length;
  if (changed) {
    getDeps().then(({ bus }) => {
      emit(bus, "marketplace.offer.changed", {
        type: "remove",
        offerId: oid,
        at: nowISO(),
      });
      emit(bus, "marketplace.changed", {
        type: "offer",
        offerId: oid,
        at: nowISO(),
      });
    });
    persistNow().catch(() => {});
  }
  return changed;
}

/* -----------------------------------------------------------------------------
 * Analytics events (impressions / clicks / leads)
 * -------------------------------------------------------------------------- */

function recordEvent(evt) {
  const e = normalizeEvent(evt, { keepId: true });
  const events = _state.events.slice();
  events.push(e);

  // keep bounded in memory/storage
  const MAX = 5000;
  if (events.length > MAX) events.splice(0, events.length - MAX);

  _set({ events });

  getDeps().then(({ bus }) => {
    emit(bus, "marketplace.analytics.event", { ...e });
    emit(bus, "marketplace.changed", {
      type: "event",
      kind: e.kind,
      at: e.tsISO,
    });
  });

  persistNow().catch(() => {});
  return e;
}

function listEvents({
  kind = "",
  vendorId = "",
  listingId = "",
  sinceISO = "",
  limit = 1000,
} = {}) {
  const k = String(kind || "");
  const vid = String(vendorId || "");
  const lid = String(listingId || "");
  const since = sinceISO ? parseISO(sinceISO) : null;
  const sinceMs = since ? since.getTime() : null;

  let rows = _state.events.slice();
  if (k) rows = rows.filter((e) => String(e.kind) === k);
  if (vid) rows = rows.filter((e) => String(e.vendorId) === vid);
  if (lid) rows = rows.filter((e) => String(e.listingId) === lid);
  if (sinceMs != null) {
    rows = rows.filter((e) => {
      const d = parseISO(e.tsISO);
      return d ? d.getTime() >= sinceMs : true;
    });
  }

  rows.sort((a, b) =>
    String(b.tsISO || "").localeCompare(String(a.tsISO || ""))
  );
  if (Number.isFinite(+limit) && +limit > 0) rows = rows.slice(0, +limit);
  return rows;
}

/**
 * Summarize analytics (simple counts).
 */
function summarizeEvents({ sinceISO = "", groupBy = "kind" } = {}) {
  const rows = listEvents({ sinceISO, limit: 5000 });
  const out = {};
  for (const e of rows) {
    const key =
      groupBy === "vendor"
        ? e.vendorId || "unknown"
        : groupBy === "listing"
        ? e.listingId || "unknown"
        : e.kind || "unknown";
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Cross-helpers: vendor <-> listings
 * -------------------------------------------------------------------------- */

function listVendorListings(vendorId, opts = {}) {
  return listListings({ ...opts, vendorId: String(vendorId || "") });
}

function getVendorWithListings(vendorId, opts = {}) {
  const v = getVendorById(vendorId);
  if (!v) return null;
  return {
    vendor: v,
    listings: listVendorListings(v.id, opts),
  };
}

/* -----------------------------------------------------------------------------
 * Public facade
 * -------------------------------------------------------------------------- */

const MarketplaceStore = {
  // status
  hydrate,
  persistNow,
  getSnapshot,
  subscribe,

  // vendors
  listVendors,
  getVendorById,
  findVendorByExternal,
  createVendor,
  upsertVendor,
  removeVendor,
  toggleFavoriteVendor,

  // listings
  listListings,
  getListingById,
  createListing,
  upsertListing,
  removeListing,

  // offers
  listOffers,
  getOfferById,
  createOffer,
  upsertOffer,
  setOfferStatus,
  removeOffer,

  // analytics
  recordEvent,
  listEvents,
  summarizeEvents,

  // joins
  listVendorListings,
  getVendorWithListings,

  // diagnostics
  _unsafeState: _state,
};

export default MarketplaceStore;
export { MarketplaceStore };

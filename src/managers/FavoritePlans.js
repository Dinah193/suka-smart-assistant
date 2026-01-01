// FavoritePlans.js — domain-aware favorites manager with user-saved plans + router-backed persistence
// Robust, defensive, event-driven, sync-capable. Integrates PlanStorageRouter & falls back to Dexie/localStorage.
/* eslint-disable no-console */
(function () {
  /* --------------------------------- Flags --------------------------------- */
  const __DEV__ = typeof process !== "undefined" && process.env && process.env.NODE_ENV !== "production";

  /* ------------------------------ Safe Imports ------------------------------ */
  let eventBus = { on(){}, off(){}, emit(){} };
  try {
    const eb = require("@/services/eventBus");
    eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
  } catch (_e) {}

  let automation = null;
  try {
    const rt = require("@/services/automation/runtime");
    automation = (rt && (rt.default || rt.automation || rt.automation?.automation)) || null;
  } catch (_e) {}

  // PlanStorageRouter (preferred path)
  let createPlanStorageRouter = null;
  try {
    const psr = require("@/managers/storage/PlanStorageRouter");
    createPlanStorageRouter = psr?.createPlanStorageRouter || psr?.default?.createPlanStorageRouter || null;
  } catch (_e) {}

  // Optional Dexie cache
  let Dexie = null;
  try { Dexie = require("dexie"); Dexie = Dexie && (Dexie.default || Dexie); } catch (_e) {}

  // Optional JSON schema contracts (non-blocking)
  let ajvCompile = null;
  try {
    const Ajv = require("ajv"); const addFormats = require("ajv-formats");
    const ajv = new (Ajv.default || Ajv)({ allErrors: true, strict: false });
    (addFormats.default || addFormats)(ajv);
    const tryImport = (p) => { try { return require(p); } catch { return null; } };
    const schemas = {
      garden: tryImport("@/data/contracts/gardenplan.contract.json"),
      cleaning: tryImport("@/data/contracts/cleanplan.contract.json"),
      meals: tryImport("@/data/contracts/mealplan.contract.json"),
      animals: tryImport("@/data/contracts/animalplan.contract.json"),
    };
    ajvCompile = (domain) => {
      const s = schemas[domain];
      return s ? (ajv.getSchema(s.$id) || ajv.compile(s)) : null;
    };
  } catch (_e) {}

  // Optional calendar sync used by orchestration
  let calendarSync = null;
  try { calendarSync = require("@/services/calendar/calendarSync"); } catch (_e) {}

  /* ----------------------------- Small Utilities ---------------------------- */
  const isBrowser = typeof window !== "undefined";
  const now = () => Date.now();
  const safeUUID = () => {
    try { return (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : null; } catch { return null; }
  };
  const uid = () => safeUUID() || ("p_" + Math.random().toString(36).slice(2) + "_" + now());

  const clampStr = (s, max=160) => (s || "").toString().slice(0, max);
  const deepClone = (o) => { try { return structuredClone(o); } catch { return JSON.parse(JSON.stringify(o || null)); } };

  const safeJSON = {
    parse: (s, f=null) => { try { return JSON.parse(s); } catch { return typeof f === "function" ? f() : (f ?? null); } },
    stringify: (v) => { try { return JSON.stringify(v); } catch { return "null"; } }
  };

  const DEFAULT_DOMAIN_ORDER = ["meals","cleaning","garden","animals","inventory","health"];
  const LSK = (userId) => `suka:favorites:v2:${userId||"anon"}`; // local cache key

  const EMPTY_STATE = {
    version: 2,
    featured: { meals: [], cleaning: [], garden: [], animals: [] },
    userPlans: { meals: [], cleaning: [], garden: [], animals: [] },
    favorites: { meals: {}, cleaning: {}, garden: {}, animals: {} },
    tags: [],
    updatedAt: 0,
  };

  const validatorsByDomain = Object.create(null);
  const validateAgainstContract = (domain, planBody) => {
    const compiler = ajvCompile ? (validatorsByDomain[domain] || (validatorsByDomain[domain] = ajvCompile(domain))) : null;
    if (!compiler) return { ok: true, errors: [] };
    const valid = compiler(planBody || {});
    return { ok: !!valid, errors: compiler.errors || [] };
  };

  /* ------------------------ Router (primary) + Cache (fallback) ------------- */
  let __routerByUser = new Map(); // userId -> router
  let __dexieDb = null;

  async function ensureDexie() {
    if (!Dexie || __dexieDb) return !!Dexie;
    __dexieDb = new Dexie("SukaFavoritesDB");
    __dexieDb.version(1).stores({ userBlobs: "userId" });
    await __dexieDb.open();
    return true;
  }

  async function getRouter(userId) {
    if (!createPlanStorageRouter) return null;
    if (__routerByUser.has(userId)) return __routerByUser.get(userId);
    try {
      const r = await createPlanStorageRouter({ userId });
      __routerByUser.set(userId, r);
      return r;
    } catch {
      return null;
    }
  }

  async function cacheLoad(userId) {
    await ensureDexie();
    if (__dexieDb) {
      const row = await __dexieDb.userBlobs.get(userId || "anon");
      return row && row.blob ? row.blob : deepClone(EMPTY_STATE);
    }
    if (!isBrowser) return deepClone(EMPTY_STATE);
    const raw = window.localStorage.getItem(LSK(userId));
    return safeJSON.parse(raw, () => deepClone(EMPTY_STATE));
  }

  async function cacheSave(userId, state) {
    state.updatedAt = now();
    if (__dexieDb) {
      await __dexieDb.userBlobs.put({ userId: userId || "anon", blob: state });
      return;
    }
    if (isBrowser) {
      window.localStorage.setItem(LSK(userId), safeJSON.stringify(state));
    }
  }

  /* ----------------------------- Key helpers -------------------------------- */
  const keyForUserPlan = (userId, planId) => `plans:user:${userId}:${planId}`;
  const keyForGlobalPlan = (planId) => `plans:global:${planId}`;
  const keyPrefixUserPlans = (userId, domain) => `plans:user:${userId}:`;
  const keyPrefixGlobalPlans = (domain) => `plans:global:`;
  const keyForFavorites = (userId) => `favorites:user:${userId}`;

  const normalizePlan = (raw = {}) => {
    const id = raw.id || uid();
    const domain = raw.domain || "meals";
    const title = clampStr(raw.title || "Untitled Plan", 200);
    const summary = clampStr(raw.summary || "", 400);
    const tags = Array.isArray(raw.tags) ? raw.tags.slice(0, 20) : [];
    const session = raw.session || {};
    const createdAt = raw.createdAt || now();
    const updatedAt = now();

    return {
      id, domain, title, summary, tags,
      planBody: raw.planBody || {},
      session,
      createdAt,
      updatedAt,
      meta: {
        createdBy: raw.meta?.createdBy || raw.userId || "unknown",
        visibility: raw.meta?.visibility || "private",
        source: raw.meta?.source || "user",
        version: (raw.meta?.version || 1)
      },
      scope: raw.scope || `user:${raw.meta?.createdBy || raw.userId || "unknown"}`
    };
  };

  /* ----------------------------- Events helpers ----------------------------- */
  const emit = (type, payload) => { try { eventBus.emit(type, payload); } catch {} };
  const pulse = (kind, extra = {}) => { try { automation?.emit?.("nba.signal", { kind, ts: now(), ...extra }); } catch {} };
  const fireFavoritesChanged = (domain, userId) => emit("favorites.changed", { domain: domain || null, userId, ts: now() });

  /* ---------------------------------- API ----------------------------------- */
  const FavoritePlans = {
    __name: "FavoritePlans",
    __version: "3.0.0",

    async init() {
      // optional warmup
      if (__DEV__) console.log("[FavoritePlans] init");
      return true;
    },

    /* ----------------------------- Core persistence ------------------------- */
    async saveUserPlan(raw) {
      const userId = raw.userId || raw.meta?.createdBy || "anon";
      const d = raw.domain || "meals";
      const plan = normalizePlan({ ...raw, domain: d, meta: { ...(raw.meta||{}), source: "user", createdBy: userId }});

      // contract validation (non-blocking)
      const validation = validateAgainstContract(d, plan.planBody);
      if (!validation.ok && __DEV__) console.warn(`[FavoritePlans] ${d} plan schema warnings`, validation.errors);

      // Try router first
      const router = await getRouter(userId);
      if (router && router.savePlan) {
        const saved = await router.savePlan(plan, { scope: "user", userId, overwrite: false });
        emit("plan.saved", { domain: d, planId: saved?.id || plan.id, userId, plan: saved || plan, ts: now() });
        pulse("plan.saved", { domain: d, userId, planId: saved?.id || plan.id });
        try { await calendarSync?.writePlanSessions?.({ userId, domain: d, plan: saved || plan }); } catch {}
        fireFavoritesChanged(d, userId);
        return saved || plan;
      }

      // Fallback to cache
      const st = await cacheLoad(userId);
      st.userPlans[d] = st.userPlans[d] || [];
      const idx = st.userPlans[d].findIndex(p => p.id === plan.id);
      if (idx >= 0) st.userPlans[d][idx] = { ...st.userPlans[d][idx], ...plan, updatedAt: now() };
      else st.userPlans[d].unshift(plan);
      await cacheSave(userId, st);
      emit("plan.saved", { domain: d, planId: plan.id, userId, plan, ts: now() });
      pulse("plan.saved", { domain: d, userId, planId: plan.id });
      fireFavoritesChanged(d, userId);
      return plan;
    },

    async adoptFeatured({ userId, domain, planId, favorite = true }) {
      const d = domain || "meals";
      const router = await getRouter(userId);
      if (router?.getPlan && router?.savePlan) {
        const base = await router.getPlan(planId, { scope: "global" });
        if (!base) return null;
        const cloned = await router.savePlan({
          ...base,
          id: undefined,
          title: (base.title || "Plan") + " (My Copy)",
          domain: base.domain || d,
          meta: { ...(base.meta||{}), source: "user", createdBy: userId, version: (base.meta?.version || 1) + 1 },
        }, { scope: "user", userId, favorite: !!favorite });
        try { router.afterSaveOrchestrate?.(cloned); } catch {}
        if (favorite) await this.favorite({ userId, domain: cloned.domain || d, planId: cloned.id });
        return cloned;
      }

      // Fallback to cache-only (copy from cached featured list)
      const st = await cacheLoad(userId);
      const base = (st.featured[d] || []).find(p => p.id === planId);
      if (!base) return null;
      const plan = normalizePlan({
        ...base,
        id: uid(),
        userId, domain: base.domain || d,
        title: (base.title || "Plan") + " (My Copy)",
        meta: { ...(base.meta||{}), source: "user", createdBy: userId, version: (base.meta?.version || 1) + 1 }
      });
      st.userPlans[d] = st.userPlans[d] || [];
      st.userPlans[d].unshift(plan);
      if (favorite) { st.favorites[d] = st.favorites[d] || {}; st.favorites[d][plan.id] = true; }
      await cacheSave(userId, st);
      emit("plan.saved", { domain: d, planId: plan.id, userId, plan, ts: now() });
      pulse("plan.saved", { domain: d, userId, planId: plan.id });
      fireFavoritesChanged(d, userId);
      return plan;
    },

    async favorite({ userId, domain, planId }) {
      const d = domain || "meals";
      const router = await getRouter(userId);

      if (router?.adapter?.get && router?.adapter?.set) {
        const favKey = keyForFavorites(userId);
        const current = (await router.adapter.get(favKey)) || { byId: {} };
        current.byId = current.byId || {};
        current.byId[planId] = { at: now(), domain: d };
        await router.adapter.set(favKey, current);
        emit("plan.favorited", { userId, domain: d, planId, ts: now() });
        pulse("plan.favorited", { userId, domain: d, planId });
        fireFavoritesChanged(d, userId);
        return true;
      }

      // Fallback cache
      const st = await cacheLoad(userId);
      st.favorites[d] = st.favorites[d] || {};
      st.favorites[d][planId] = true;
      await cacheSave(userId, st);
      emit("plan.favorited", { userId, domain: d, planId, ts: now() });
      pulse("plan.favorited", { userId, domain: d, planId });
      fireFavoritesChanged(d, userId);
      return true;
    },

    async unfavorite({ userId, domain, planId }) {
      const d = domain || "meals";
      const router = await getRouter(userId);

      if (router?.adapter?.get && router?.adapter?.set) {
        const favKey = keyForFavorites(userId);
        const current = (await router.adapter.get(favKey)) || { byId: {} };
        if (current.byId) delete current.byId[planId];
        await router.adapter.set(favKey, current);
        emit("plan.unfavorited", { userId, domain: d, planId, ts: now() });
        pulse("plan.unfavorited", { userId, domain: d, planId });
        fireFavoritesChanged(d, userId);
        return true;
      }

      const st = await cacheLoad(userId);
      st.favorites[d] = st.favorites[d] || {};
      delete st.favorites[d][planId];
      await cacheSave(userId, st);
      emit("plan.unfavorited", { userId, domain: d, planId, ts: now() });
      pulse("plan.unfavorited", { userId, domain: d, planId });
      fireFavoritesChanged(d, userId);
      return true;
    },

    async toggleFavorite({ userId, domain, planId }) {
      const isFav = await this.isFavorite({ userId, domain, planId });
      return isFav
        ? this.unfavorite({ userId, domain, planId })
        : this.favorite({ userId, domain, planId });
    },

    async isFavorite({ userId, domain, planId }) {
      const d = domain || "meals";
      const router = await getRouter(userId);
      if (router?.adapter?.get) {
        const fav = await router.adapter.get(keyForFavorites(userId));
        return !!(fav && fav.byId && fav.byId[planId]);
      }
      const st = await cacheLoad(userId);
      return !!(st.favorites[d] && st.favorites[d][planId]);
    },

    async get({ userId, domain, planId }) {
      const d = domain || "meals";
      const router = await getRouter(userId);
      if (router?.getPlan) {
        // prefer user copy first, then global
        const userCopy = await router.getPlan(planId, { scope: "user" });
        if (userCopy) return deepClone(userCopy);
        const feat = await router.getPlan(planId, { scope: "global" });
        return feat ? deepClone(feat) : null;
      }
      // fallback cache
      const st = await cacheLoad(userId);
      return (st.userPlans[d] || []).find(p => p.id === planId) ||
             (st.featured[d] || []).find(p => p.id === planId) || null;
    },

    async removeUserPlan({ userId, domain, planId }) {
      const d = domain || "meals";
      const router = await getRouter(userId);
      if (router?.deletePlan) {
        await router.deletePlan(planId, { scope: "user", userId });
        // Also clear favorite mapping if any
        try { await this.unfavorite({ userId, domain: d, planId }); } catch {}
        emit("plan.removed", { userId, domain: d, planId, ts: now() });
        pulse("plan.removed", { userId, domain: d, planId });
        fireFavoritesChanged(d, userId);
        return true;
      }
      // cache fallback
      const st = await cacheLoad(userId);
      st.userPlans[d] = (st.userPlans[d] || []).filter(p => p.id !== planId);
      if (st.favorites[d]) delete st.favorites[d][planId];
      await cacheSave(userId, st);
      emit("plan.removed", { userId, domain: d, planId, ts: now() });
      pulse("plan.removed", { userId, domain: d, planId });
      fireFavoritesChanged(d, userId);
      return true;
    },

    async attachTags({ userId, domain, planId, tags = [] }) {
      const d = domain || "meals";
      const router = await getRouter(userId);
      if (router?.savePlan && router?.getPlan) {
        // Write-through: fetch, patch, save
        const base = await this.get({ userId, domain: d, planId });
        if (!base) return false;
        const uniq = Array.from(new Set([...(base.tags||[]), ...tags.map(String)]));
        const patched = { ...base, tags: uniq, updatedAt: now() };
        await router.savePlan(patched, { scope: "user", userId, overwrite: true });
        emit("plan.tags.updated", { userId, domain: d, planId, tags: uniq, ts: now() });
        fireFavoritesChanged(d, userId);
        return true;
      }
      // cache fallback
      const st = await cacheLoad(userId);
      const update = (arr) => {
        const idx = (arr||[]).findIndex(p => p.id === planId);
        if (idx >= 0) {
          const uniq = Array.from(new Set([...(arr[idx].tags||[]), ...tags.map(String)]));
          arr[idx] = { ...arr[idx], tags: uniq, updatedAt: now() };
          return true;
        } return false;
      };
      const ok = update(st.userPlans[d]) || update(st.featured[d]);
      if (ok) {
        await cacheSave(userId, st);
        emit("plan.tags.updated", { userId, domain: d, planId, tags, ts: now() });
        fireFavoritesChanged(d, userId);
      }
      return ok;
    },

    /* ----------------------------- Listing / query -------------------------- */
    async list({ userId, domain, only = "all", tags = [], search = "" } = {}) {
      const domains = domain ? [domain] : DEFAULT_DOMAIN_ORDER;
      const tagSet = new Set((tags || []).map(String));
      const q = (search || "").toLowerCase();

      const router = await getRouter(userId);
      if (router?.adapter?.keys && router?.adapter?.bulkGet) {
        const allItems = [];
        for (const d of domains) {
          let keys = [];
          if (only === "all" || only === "mine") {
            const uPrefix = keyPrefixUserPlans(userId, d);
            const uKeys = await router.adapter.keys(uPrefix);
            keys = keys.concat(uKeys);
          }
          if (only === "all" || only === "featured") {
            const gPrefix = keyPrefixGlobalPlans(d);
            const gKeys = await router.adapter.keys(gPrefix);
            keys = keys.concat(gKeys);
          }
          const vals = await router.adapter.bulkGet(keys);
          const pool = (vals || []).filter(Boolean).map(v => ({
            ...v,
            isFavorite: false, // fill later
          }));
          // favorites map
          const favMap = ((await router.adapter.get(keyForFavorites(userId))) || { byId: {} }).byId || {};
          for (const p of pool) p.isFavorite = !!favMap[p.id];

          const filtered = pool.filter(p => {
            const tagOk = tagSet.size ? (p.tags || []).some(t => tagSet.has(String(t))) : true;
            const textOk = q ? ((p.title||"").toLowerCase().includes(q) || (p.summary||"").toLowerCase().includes(q)) : true;
            return tagOk && textOk && (!domain || p.domain === domain);
          });
          allItems.push(...filtered);
        }
        allItems.sort((a,b) => (Number(b.isFavorite) - Number(a.isFavorite)) || ((b.updatedAt||0) - (a.updatedAt||0)));
        return allItems;
      }

      // cache fallback
      const st = await cacheLoad(userId);
      const res = [];
      for (const d of domains) {
        const pool = [];
        if (only === "all" || only === "mine") pool.push(...(st.userPlans[d] || []));
        if (only === "all" || only === "featured") pool.push(...(st.featured[d] || []));
        const filtered = pool.filter(p => {
          const tagOk = tagSet.size ? (p.tags || []).some(t => tagSet.has(String(t))) : true;
          const textOk = q ? ((p.title||"").toLowerCase().includes(q) || (p.summary||"").toLowerCase().includes(q)) : true;
          return tagOk && textOk;
        }).map(p => ({
          ...p,
          isFavorite: !!(st.favorites[d] && st.favorites[d][p.id]),
        }));
        res.push(...filtered);
      }
      res.sort((a,b) => (Number(b.isFavorite) - Number(a.isFavorite)) || ((b.updatedAt||0) - (a.updatedAt||0)));
      return res;
    },

    async listFavorites({ userId, domain }) {
      const d = domain || "meals";
      const router = await getRouter(userId);
      if (router?.adapter?.get && router?.adapter?.keys && router?.adapter?.bulkGet) {
        const fav = ((await router.adapter.get(keyForFavorites(userId))) || { byId: {} }).byId || {};
        const ids = new Set(Object.keys(fav));
        // We have plan IDs, but not their scope; fetch both user & global pools, then filter by id.
        const keys = []
          .concat(await router.adapter.keys(keyPrefixUserPlans(userId, d)))
          .concat(await router.adapter.keys(keyPrefixGlobalPlans(d)));
        const vals = await router.adapter.bulkGet(keys);
        return (vals || []).filter(p => p && ids.has(p.id)).map(p => ({ ...p, isFavorite: true }));
      }
      // cache fallback
      const st = await cacheLoad(userId);
      const ids = new Set(Object.keys(st.favorites[d] || {}).filter(k => st.favorites[d][k]));
      const pool = [...(st.userPlans[d] || []), ...(st.featured[d] || [])];
      return pool.filter(p => ids.has(p.id)).map(p => ({ ...p, isFavorite: true }));
    },

    /* --------------------------- Seed/Import/Export ------------------------- */
    async seedFeatured({ userId, domain, plans = [] }) {
      // This function maintains your legacy featured cache for offline UX & bootstrapping
      const st = await cacheLoad(userId);
      const d = domain || "meals";
      st.featured[d] = st.featured[d] || [];
      const byId = new Map(st.featured[d].map(p => [p.id, p]));
      for (const p of plans) {
        const np = normalizePlan({ ...p, domain: d, meta: { ...(p.meta||{}), source:"featured", visibility:"public" } });
        byId.set(np.id, { ...byId.get(np.id), ...np });
      }
      st.featured[d] = Array.from(byId.values());
      await cacheSave(userId, st);
      fireFavoritesChanged(d, userId);
      return st.featured[d];
    },

    async exportAll({ userId }) {
      const router = await getRouter(userId);
      if (router?.adapter?.keys && router?.adapter?.bulkGet && router?.adapter?.get) {
        const uKeys = await router.adapter.keys(keyPrefixUserPlans(userId));
        const gKeys = await router.adapter.keys(keyPrefixGlobalPlans());
        const plans = (await router.adapter.bulkGet(uKeys.concat(gKeys))).filter(Boolean);
        const favorites = (await router.adapter.get(keyForFavorites(userId))) || { byId: {} };
        return { kind: "suka.favorites.export", version: 3, exportedAt: now(), data: { plans, favorites } };
      }
      // cache fallback
      const st = await cacheLoad(userId);
      return { kind: "suka.favorites.export", version: st.version, exportedAt: now(), data: st };
    },

    async importAll({ userId, blob, mergeMode = "merge" /* or "replace" */ }) {
      const router = await getRouter(userId);
      const data = blob?.data;
      if (!data) return false;

      if (router?.adapter?.bulkSet && router?.adapter?.set) {
        // If payload contains raw plans array + favorites
        if (Array.isArray(data.plans)) {
          const entries = data.plans.map(p => ({
            key: (p.scope && String(p.scope).startsWith("global")) ? keyForGlobalPlan(p.id) : keyForUserPlan(userId, p.id),
            value: { ...p, meta: { ...(p.meta||{}), createdBy: p.meta?.createdBy || userId } }
          }));
          if (mergeMode === "replace") {
            // optional: could purge user scope first; skipping destructive ops for safety
          }
          await router.adapter.bulkSet(entries);
        } else if (data.userPlans || data.featured) {
          // Legacy blob: recompose entries from userPlans + featured
          const entries = [];
          for (const d of Object.keys(data.userPlans || {})) {
            for (const p of (data.userPlans[d] || [])) entries.push({ key: keyForUserPlan(userId, p.id), value: p });
          }
          for (const d of Object.keys(data.featured || {})) {
            for (const p of (data.featured[d] || [])) entries.push({ key: keyForGlobalPlan(p.id), value: p });
          }
          if (entries.length) await router.adapter.bulkSet(entries);
        }
        if (data.favorites) {
          const existing = (await router.adapter.get(keyForFavorites(userId))) || { byId: {} };
          const byId = (mergeMode === "replace") ? {} : { ...existing.byId };
          Object.assign(byId, data.favorites.byId || {});
          await router.adapter.set(keyForFavorites(userId), { byId });
        }
        fireFavoritesChanged(null, userId);
        emit("import.finished", { userId, at: now() });
        pulse("import.finished", { userId });
        return true;
      }

      // cache fallback (legacy)
      const st = await cacheLoad(userId);
      const incoming = data;
      const out = (mergeMode === "replace") ? deepClone(incoming) : deepClone(st);

      const mergeArr = (dst = [], src = []) => {
        const byId = new Map(dst.map(p => [p.id, p]));
        src.forEach(p => byId.set(p.id, { ...byId.get(p.id), ...p }));
        return Array.from(byId.values());
      };

      if (incoming.featured) {
        for (const d of Object.keys(incoming.featured || {})) {
          out.featured[d] = mergeArr(out.featured[d] || [], incoming.featured[d] || []);
        }
      }
      if (incoming.userPlans) {
        for (const d of Object.keys(incoming.userPlans || {})) {
          out.userPlans[d] = mergeArr(out.userPlans[d] || [], incoming.userPlans[d] || []);
        }
      }
      if (incoming.favorites) {
        for (const d of Object.keys(incoming.favorites || {})) {
          out.favorites[d] = { ...(out.favorites[d] || {}), ...(incoming.favorites[d] || {}) };
        }
      }
      out.tags = Array.from(new Map((out.tags||[]).map(t => [t.id||t.label, t])).values());
      await cacheSave(userId, out);
      fireFavoritesChanged(null, userId);
      emit("import.finished", { userId, at: now() });
      pulse("import.finished", { userId });
      return true;
    },

    /* ------------------------------- Snapshots ------------------------------ */
    async snapshot({ userId, domain }) {
      const favs = await this.listFavorites({ userId, domain });
      const mine = await this.list({ userId, domain, only: "mine" });
      return {
        domain: domain || null,
        favoriteCount: favs.length,
        myPlanCount: mine.length,
        updatedAt: now(),
        top: favs.slice(0, 6).map(p => ({ id: p.id, title: p.title, domain: p.domain }))
      };
    },

    /* -------------------------- Global orchestration ------------------------ */
    attachGlobalListeners() {
      try {
        eventBus.on?.("inventory.shortage.detected", async ({ domain, items, userId }) => {
          const plans = await FavoritePlans.listFavorites({ userId, domain });
          if ((plans||[]).length) {
            emit("nba.nudge.created", { kind: "inventory.shortage.for.favorite", userId, domain, items, planCount: plans.length, ts: now() });
          }
        });
        eventBus.on?.("planner.conflict.detected", async ({ kind, userId, domain }) => {
          const snap = await FavoritePlans.snapshot({ userId, domain });
          emit("nba.nudge.created", { kind: "planner.conflict.favorite.context", userId, domain, conflict: kind, snapshot: snap, ts: now() });
        });
      } catch {}
    },
  };

  // Singleton export
  const favoritePlans = FavoritePlans;

  try {
    module.exports = FavoritePlans;
    module.exports.default = FavoritePlans;
    module.exports.favoritePlans = favoritePlans;
  } catch (_e) {
    try { exports.default = FavoritePlans; exports.favoritePlans = favoritePlans; } catch {}
  }
})();

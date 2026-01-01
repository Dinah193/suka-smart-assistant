// File: src/app/features/scan-compare-trust/services/SCTOrchestrator.js
// SSA — Scan • Compare • Trust Orchestrator (SCT)
// Production-ready, resilient, and "optional-module" safe (uses import.meta.glob to avoid Vite hard fails).
//
// Purpose
// - Central orchestration layer for Scan/Compare/Trust workflows:
//   • Shopping Scan (candidate capture, price/coupon/recall/ingredient lookups)
//   • Receipt ingest + reconciliation (commit candidates to inventory/pricebook)
//   • Compare flows (same item across stores, normalized sizes/units)
//   • Trust flows (recalls, ingredients, warnings)
//
// Design notes
// - Does NOT assume every downstream module exists; it discovers plugins dynamically.
// - Emits eventBus events if present.
// - Works even if Dexie/db is not injected (falls back to in-memory queues).
//
// Expected (optional) integrations in SSA:
// - eventBus: { emit(type, payload), on(type, fn), off(type, fn) }
// - db: Dexie instance (src/services/db.js) with tables like:
//   artifacts, parsed_candidates, method_maps, blueprints, layer_overrides, parse_cache
//   and/or scan-compare-trust specific tables if you created them.
//
// This file is intentionally self-contained and defensive.

const DEFAULT_TIMEOUT_MS = 20_000;

const EVT = {
  READY: "sct.orchestrator.ready",
  INTENT_STARTED: "sct.intent.started",
  INTENT_COMPLETED: "sct.intent.completed",
  INTENT_FAILED: "sct.intent.failed",
  PLUGIN_LOADED: "sct.plugin.loaded",
  PLUGIN_FAILED: "sct.plugin.failed",
  WARN: "sct.warn",
};

const INTENT = {
  HEALTH: "sct.health",

  // Shopping scan
  SHOPPING_SESSION_START: "shopping.scan.session.start",
  SHOPPING_ITEM_SCAN: "shopping.scan.item",
  SHOPPING_ITEM_REMOVE: "shopping.scan.item.remove",
  SHOPPING_SESSION_END: "shopping.scan.session.end",

  // Receipt + reconciliation
  RECEIPT_INGEST: "receipt.ingest",
  RECEIPT_RECONCILE: "receipt.reconcile",

  // Compare / trust
  COMPARE_ITEM: "sct.compare.item",
  TRUST_CHECK: "sct.trust.check",
};

function nowISO() {
  return new Date().toISOString();
}

function makeId(prefix = "sct") {
  const rand = Math.random().toString(16).slice(2);
  return `${prefix}_${Date.now().toString(36)}_${rand}`;
}

function isFn(x) {
  return typeof x === "function";
}

function safeGet(obj, path, fallback = undefined) {
  try {
    const parts = String(path).split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return fallback;
      cur = cur[p];
    }
    return cur === undefined ? fallback : cur;
  } catch {
    return fallback;
  }
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys)
    if (obj && Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
  return out;
}

function createLogger(userLogger) {
  const base = userLogger && typeof userLogger === "object" ? userLogger : null;
  const fnOrConsole = (name) =>
    base && isFn(base[name])
      ? base[name].bind(base)
      : console[name].bind(console);
  return {
    debug: fnOrConsole("debug"),
    info: fnOrConsole("info"),
    warn: fnOrConsole("warn"),
    error: fnOrConsole("error"),
  };
}

function emit(bus, type, payload) {
  try {
    if (bus && isFn(bus.emit)) bus.emit(type, payload);
  } catch {
    // never throw from emit
  }
}

function withTimeout(promise, ms, onTimeout) {
  let t = null;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => {
      const err = new Error(`SCT operation timed out after ${ms}ms`);
      err.code = "SCT_TIMEOUT";
      if (isFn(onTimeout)) onTimeout(err);
      rej(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (t) clearTimeout(t);
  });
}

function normalizeStores(stores) {
  if (!stores) return [];
  if (Array.isArray(stores)) return stores.filter(Boolean);
  return [stores].filter(Boolean);
}

/**
 * In-memory fallback queues (used if db isn't injected or no tables exist)
 */
function createMemoryStore() {
  const state = {
    sessions: new Map(), // sessionId -> { ... }
    candidates: new Map(), // candidateId -> { ... }
    receipts: new Map(), // receiptId -> { ... }
  };

  return {
    getSession(sessionId) {
      return state.sessions.get(sessionId) || null;
    },
    upsertSession(session) {
      state.sessions.set(session.id, session);
      return session;
    },
    addCandidate(candidate) {
      state.candidates.set(candidate.id, candidate);
      return candidate;
    },
    removeCandidate(candidateId) {
      return state.candidates.delete(candidateId);
    },
    listCandidatesBySession(sessionId) {
      return Array.from(state.candidates.values()).filter(
        (c) => c.sessionId === sessionId
      );
    },
    addReceipt(receipt) {
      state.receipts.set(receipt.id, receipt);
      return receipt;
    },
    getReceipt(receiptId) {
      return state.receipts.get(receiptId) || null;
    },
  };
}

/**
 * Minimal DB adapter interface (Dexie-friendly).
 * If a table doesn't exist, it no-ops and memory store is used instead.
 */
function createDbAdapter(db, logger) {
  const hasDb = !!db;
  const tables = new Set(
    (db && db.tables ? db.tables.map((t) => t.name) : []) || []
  );

  const getTable = (name) => {
    if (!hasDb) return null;
    if (!tables.has(name)) return null;
    return db[name] || null;
  };

  const adapter = {
    hasTable(name) {
      return tables.has(name);
    },

    // Session drafts for shopping scan (optional)
    async upsertShoppingSession(session) {
      const t = getTable("shopping_sessions") || getTable("sct_sessions");
      if (!t) return null;
      try {
        await t.put(session);
        return session;
      } catch (e) {
        logger.warn("[SCT] DB upsertShoppingSession failed:", e);
        return null;
      }
    },

    async getShoppingSession(sessionId) {
      const t = getTable("shopping_sessions") || getTable("sct_sessions");
      if (!t) return null;
      try {
        return (await t.get(sessionId)) || null;
      } catch (e) {
        logger.warn("[SCT] DB getShoppingSession failed:", e);
        return null;
      }
    },

    // Candidate queue (optional)
    async addCandidate(candidate) {
      const t =
        getTable("shopping_candidates") ||
        getTable("sct_candidates") ||
        getTable("parsed_candidates");
      if (!t) return null;
      try {
        await t.put(candidate);
        return candidate;
      } catch (e) {
        logger.warn("[SCT] DB addCandidate failed:", e);
        return null;
      }
    },

    async removeCandidate(candidateId) {
      const t =
        getTable("shopping_candidates") ||
        getTable("sct_candidates") ||
        getTable("parsed_candidates");
      if (!t) return null;
      try {
        await t.delete(candidateId);
        return true;
      } catch (e) {
        logger.warn("[SCT] DB removeCandidate failed:", e);
        return null;
      }
    },

    async listCandidatesBySession(sessionId) {
      const t =
        getTable("shopping_candidates") ||
        getTable("sct_candidates") ||
        getTable("parsed_candidates");
      if (!t) return null;
      try {
        // Dexie tables typically support where().equals().toArray()
        if (isFn(t.where)) {
          return await t.where("sessionId").equals(sessionId).toArray();
        }
        // fallback: toArray then filter (not ideal, but safe)
        if (isFn(t.toArray)) {
          const all = await t.toArray();
          return (all || []).filter((c) => c && c.sessionId === sessionId);
        }
        return null;
      } catch (e) {
        logger.warn("[SCT] DB listCandidatesBySession failed:", e);
        return null;
      }
    },

    // Receipts (optional)
    async addReceipt(receipt) {
      const t =
        getTable("receipts") ||
        getTable("sct_receipts") ||
        getTable("artifacts");
      if (!t) return null;
      try {
        await t.put(receipt);
        return receipt;
      } catch (e) {
        logger.warn("[SCT] DB addReceipt failed:", e);
        return null;
      }
    },

    async getReceipt(receiptId) {
      const t =
        getTable("receipts") ||
        getTable("sct_receipts") ||
        getTable("artifacts");
      if (!t) return null;
      try {
        return (await t.get(receiptId)) || null;
      } catch (e) {
        logger.warn("[SCT] DB getReceipt failed:", e);
        return null;
      }
    },
  };

  return adapter;
}

/**
 * Plugin contract:
 * A plugin module may export:
 *  - default: plugin object, OR
 *  - createPlugin(ctx) => plugin object
 *
 * Plugin object:
 * {
 *   id: "pricing" | ...,
 *   init?: async (ctx) => void,
 *   handles?: (intentType, intent) => boolean,
 *   run?: async (intent, ctx) => ({...}),
 *   // optional fine-grained handlers:
 *   onShoppingItemScan?: async (intent, ctx) => {...}
 *   onCompareItem?: async (intent, ctx) => {...}
 *   onTrustCheck?: async (intent, ctx) => {...}
 *   onReceiptIngest?: async (intent, ctx) => {...}
 *   onReceiptReconcile?: async (intent, ctx) => {...}
 * }
 */
async function loadPluginFromModule(mod, baseCtx, logger) {
  try {
    if (!mod) return null;
    const candidate = mod.default ?? mod;
    const plugin = isFn(candidate) ? await candidate(baseCtx) : candidate;

    // Also support named createPlugin
    if (!plugin && isFn(mod.createPlugin)) {
      return await mod.createPlugin(baseCtx);
    }

    if (!plugin || typeof plugin !== "object") return null;

    // Ensure id
    if (!plugin.id) plugin.id = makeId("plugin");

    // Optional init
    if (isFn(plugin.init)) await plugin.init(baseCtx);

    return plugin;
  } catch (e) {
    logger.warn("[SCT] loadPluginFromModule failed:", e);
    return null;
  }
}

/**
 * Default plugin discovery:
 * Looks for optional modules you may (or may not) have created.
 * If they don't exist, nothing breaks.
 */
function discoverPluginLoaders() {
  // These globs are intentionally broad (js/jsx/ts/tsx).
  // They will not throw if files are missing.
  const pluginModules = import.meta.glob(
    [
      "@/app/features/scan-compare-trust/plugins/**/*.{js,jsx,ts,tsx}",
      "@/app/features/scan-compare-trust/services/plugins/**/*.{js,jsx,ts,tsx}",
      "@/app/features/scan-compare-trust/services/*Plugin*.{js,jsx,ts,tsx}",
    ],
    { eager: false }
  );

  // Optional "well-known" service modules (not necessarily plugins, but loaders can wrap them)
  const optionalServiceModules = import.meta.glob(
    [
      "@/app/features/scan-compare-trust/services/**/Price*.{js,jsx,ts,tsx}",
      "@/app/features/scan-compare-trust/services/**/Coupon*.{js,jsx,ts,tsx}",
      "@/app/features/scan-compare-trust/services/**/Recall*.{js,jsx,ts,tsx}",
      "@/app/features/scan-compare-trust/services/**/Ingredient*.{js,jsx,ts,tsx}",
      "@/app/features/scan-compare-trust/services/**/Compare*.{js,jsx,ts,tsx}",
    ],
    { eager: false }
  );

  return { pluginModules, optionalServiceModules };
}

/**
 * Orchestrator
 */
function createSCTOrchestratorSingleton() {
  let _inited = false;

  const state = {
    id: makeId("sct_orch"),
    createdAt: nowISO(),
    readyAt: null,

    // injected
    eventBus: null,
    db: null,
    flags: null,
    logger: createLogger(null),

    // stores
    memory: createMemoryStore(),
    dbAdapter: null,

    // runtime
    plugins: [],
    pluginById: new Map(),
    pluginLoaders: new Map(), // id -> async loader(ctx) => plugin
    discovery: discoverPluginLoaders(),

    // metrics
    metrics: {
      intents: 0,
      intentsFailed: 0,
      lastIntentAt: null,
      lastError: null,
    },
  };

  function getFlags(flags) {
    const f = flags && typeof flags === "object" ? flags : {};
    // Provide stable default toggles (you can override via injected flags)
    return {
      enabled: safeGet(f, "scanCompareTrust.enabled", true),
      enablePlugins: safeGet(f, "scanCompareTrust.enablePlugins", true),
      timeoutMs: safeGet(f, "scanCompareTrust.timeoutMs", DEFAULT_TIMEOUT_MS),
      logVerbose: safeGet(f, "scanCompareTrust.logVerbose", false),

      // optional feature toggles
      enablePriceCompare: safeGet(
        f,
        "scanCompareTrust.enablePriceCompare",
        true
      ),
      enableCoupons: safeGet(f, "scanCompareTrust.enableCoupons", true),
      enableRecalls: safeGet(f, "scanCompareTrust.enableRecalls", true),
      enableIngredients: safeGet(f, "scanCompareTrust.enableIngredients", true),
      enableReceiptReconcile: safeGet(
        f,
        "scanCompareTrust.enableReceiptReconcile",
        true
      ),
    };
  }

  function baseCtx(overrides = {}) {
    return {
      orchestratorId: state.id,
      eventBus: state.eventBus,
      db: state.db,
      flags: getFlags(state.flags),
      logger: state.logger,
      // storage helpers
      memory: state.memory,
      dbAdapter: state.dbAdapter,
      // misc overrides (household, user, locale, etc.)
      ...overrides,
    };
  }

  function registerPluginLoader(id, loader) {
    if (!id || !isFn(loader)) return false;
    state.pluginLoaders.set(id, loader);
    return true;
  }

  async function loadPluginById(id) {
    const loader = state.pluginLoaders.get(id);
    if (!loader) return null;
    try {
      const plugin = await loader(baseCtx());
      if (!plugin) return null;

      // Ensure id
      plugin.id = plugin.id || id;

      state.plugins.push(plugin);
      state.pluginById.set(plugin.id, plugin);

      emit(state.eventBus, EVT.PLUGIN_LOADED, {
        at: nowISO(),
        orchestratorId: state.id,
        pluginId: plugin.id,
      });

      return plugin;
    } catch (e) {
      emit(state.eventBus, EVT.PLUGIN_FAILED, {
        at: nowISO(),
        orchestratorId: state.id,
        pluginId: id,
        error: String(e?.message || e),
      });
      state.logger.warn(`[SCT] Plugin loader failed (${id}):`, e);
      return null;
    }
  }

  async function loadDiscoveredPlugins() {
    const flags = getFlags(state.flags);
    if (!flags.enablePlugins) return;

    // 1) Load explicit registered loaders first
    for (const id of state.pluginLoaders.keys()) {
      // eslint-disable-next-line no-await-in-loop
      await loadPluginById(id);
    }

    // 2) Discover plugin modules and load anything exporting a plugin
    const { pluginModules } = state.discovery;
    const keys = Object.keys(pluginModules || {});
    for (const k of keys) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const mod = await pluginModules[k]();
        // eslint-disable-next-line no-await-in-loop
        const plugin = await loadPluginFromModule(
          mod,
          baseCtx({ modulePath: k }),
          state.logger
        );
        if (!plugin) continue;

        // Avoid duplicates by id
        const pid = plugin.id;
        if (pid && state.pluginById.has(pid)) continue;

        state.plugins.push(plugin);
        state.pluginById.set(plugin.id, plugin);

        emit(state.eventBus, EVT.PLUGIN_LOADED, {
          at: nowISO(),
          orchestratorId: state.id,
          pluginId: plugin.id,
          modulePath: k,
        });
      } catch (e) {
        // ignore any plugin module failures
        state.logger.warn("[SCT] Discovered plugin load failed:", e);
      }
    }
  }

  function normalizeIntent(intent) {
    const i = intent && typeof intent === "object" ? intent : {};
    const type = String(i.type || "").trim();
    return {
      id: i.id || makeId("intent"),
      type,
      at: i.at || nowISO(),
      // common fields:
      householdId: i.householdId || null,
      userId: i.userId || null,
      sessionId: i.sessionId || null,
      storeId: i.storeId || null,
      store: i.store || null,
      stores: normalizeStores(i.stores),
      payload: i.payload || {},
      meta: i.meta || {},
    };
  }

  async function ensureShoppingSession(intent) {
    const sessionId = intent.sessionId || makeId("shop_sess");
    const storeId = intent.storeId || intent.store?.id || null;

    const existingDb =
      (await state.dbAdapter?.getShoppingSession?.(sessionId)) ||
      state.memory.getSession(sessionId);

    if (existingDb) return existingDb;

    const session = {
      id: sessionId,
      kind: "shopping_scan",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      householdId: intent.householdId || null,
      userId: intent.userId || null,
      storeId,
      store: intent.store || null,
      status: "active",
      counts: {
        candidates: 0,
        receipts: 0,
      },
      meta: intent.meta || {},
    };

    // Try DB, fallback to memory
    const saved =
      (await state.dbAdapter?.upsertShoppingSession?.(session)) ||
      state.memory.upsertSession(session);
    return saved || session;
  }

  async function addCandidate(intent, session) {
    const payload = intent.payload || {};
    const candidateId = payload.candidateId || makeId("cand");

    const candidate = {
      id: candidateId,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      sessionId: session.id,
      householdId: intent.householdId || session.householdId || null,
      userId: intent.userId || session.userId || null,

      // item info (best effort)
      barcode: payload.barcode || null,
      upc: payload.upc || null,
      sku: payload.sku || null,
      name: payload.name || payload.title || null,
      brand: payload.brand || null,
      size: payload.size || null,
      unit: payload.unit || null,
      qty: payload.qty ?? 1,

      // price info (best effort)
      price: payload.price ?? null,
      currency: payload.currency || "USD",
      storeId: intent.storeId || session.storeId || null,
      store: intent.store || session.store || null,

      // enrichment results placeholder
      enrich: {
        priceCompare: null,
        coupons: null,
        recalls: null,
        ingredients: null,
        warnings: [],
        tags: [],
      },

      meta: payload.meta || {},
      raw: payload.raw || null,
      source: payload.source || "shopping_scan",
    };

    const saved =
      (await state.dbAdapter?.addCandidate?.(candidate)) ||
      state.memory.addCandidate(candidate);

    // Update session counts (best effort)
    try {
      const list =
        (await state.dbAdapter?.listCandidatesBySession?.(session.id)) ||
        state.memory.listCandidatesBySession(session.id) ||
        [];
      session.counts = session.counts || {};
      session.counts.candidates = (list || []).length;
      session.updatedAt = nowISO();
      await state.dbAdapter?.upsertShoppingSession?.(session);
      state.memory.upsertSession(session);
    } catch {
      // ignore
    }

    return saved || candidate;
  }

  async function removeCandidate(intent) {
    const payload = intent.payload || {};
    const candidateId = payload.candidateId;
    if (!candidateId)
      return { ok: false, error: "Missing payload.candidateId" };

    const dbRes = await state.dbAdapter?.removeCandidate?.(candidateId);
    const memRes = state.memory.removeCandidate(candidateId);

    return { ok: !!(dbRes ?? memRes), candidateId };
  }

  async function ingestReceipt(intent) {
    // This is a light wrapper. Your unified ingest service may create artifacts; we won’t assume it.
    const payload = intent.payload || {};
    const receipt = {
      id: payload.receiptId || makeId("rcpt"),
      kind: "receipt",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      householdId: intent.householdId || null,
      userId: intent.userId || null,
      storeId: intent.storeId || payload.storeId || null,
      store: intent.store || payload.store || null,
      status: "ingested",
      // raw receipt content pointers (file, image, text, parsed lines)
      artifactId: payload.artifactId || null,
      raw: payload.raw || null,
      parsed: payload.parsed || null,
      meta: payload.meta || {},
    };

    const saved =
      (await state.dbAdapter?.addReceipt?.(receipt)) ||
      state.memory.addReceipt(receipt);
    return saved || receipt;
  }

  async function reconcileReceipt(intent) {
    // Reconciliation is often app-specific:
    // - match receipt line items -> shopping candidates
    // - finalize pricebook entries
    // - commit to inventory
    //
    // This orchestrator provides a hook-based flow:
    // 1) gather candidates by session
    // 2) let plugins do matching + commits
    const payload = intent.payload || {};
    const sessionId = intent.sessionId || payload.sessionId;
    const receiptId = payload.receiptId;
    if (!sessionId)
      return {
        ok: false,
        error: "Missing sessionId (intent.sessionId or payload.sessionId)",
      };
    if (!receiptId) return { ok: false, error: "Missing payload.receiptId" };

    const session =
      (await state.dbAdapter?.getShoppingSession?.(sessionId)) ||
      state.memory.getSession(sessionId);
    if (!session)
      return { ok: false, error: `Session not found: ${sessionId}` };

    const receipt =
      (await state.dbAdapter?.getReceipt?.(receiptId)) ||
      state.memory.getReceipt(receiptId);
    if (!receipt)
      return { ok: false, error: `Receipt not found: ${receiptId}` };

    const candidates =
      (await state.dbAdapter?.listCandidatesBySession?.(sessionId)) ||
      state.memory.listCandidatesBySession(sessionId) ||
      [];

    const ctx = baseCtx({ session, receipt, candidates });

    // Prefer plugin that has onReceiptReconcile
    const pluginResults = [];
    for (const p of state.plugins) {
      if (isFn(p.onReceiptReconcile)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.onReceiptReconcile(intent, ctx);
        if (r != null) pluginResults.push({ pluginId: p.id, result: r });
      } else if (
        isFn(p.run) &&
        isFn(p.handles) &&
        p.handles(INTENT.RECEIPT_RECONCILE, intent)
      ) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.run(intent, ctx);
        if (r != null) pluginResults.push({ pluginId: p.id, result: r });
      }
    }

    return {
      ok: true,
      sessionId,
      receiptId,
      counts: { candidates: candidates.length },
      pluginResults,
    };
  }

  async function compareItem(intent) {
    const payload = intent.payload || {};
    const ctx = baseCtx({
      item: payload.item || null,
      stores: normalizeStores(payload.stores || intent.stores || []),
      query: payload.query || null,
    });

    const pluginResults = [];
    for (const p of state.plugins) {
      if (isFn(p.onCompareItem)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.onCompareItem(intent, ctx);
        if (r != null) pluginResults.push({ pluginId: p.id, result: r });
      } else if (
        isFn(p.run) &&
        isFn(p.handles) &&
        p.handles(INTENT.COMPARE_ITEM, intent)
      ) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.run(intent, ctx);
        if (r != null) pluginResults.push({ pluginId: p.id, result: r });
      }
    }

    return { ok: true, pluginResults };
  }

  async function trustCheck(intent) {
    const payload = intent.payload || {};
    const ctx = baseCtx({
      item: payload.item || null,
      barcode: payload.barcode || null,
      ingredientsText: payload.ingredientsText || null,
    });

    const pluginResults = [];
    for (const p of state.plugins) {
      if (isFn(p.onTrustCheck)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.onTrustCheck(intent, ctx);
        if (r != null) pluginResults.push({ pluginId: p.id, result: r });
      } else if (
        isFn(p.run) &&
        isFn(p.handles) &&
        p.handles(INTENT.TRUST_CHECK, intent)
      ) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.run(intent, ctx);
        if (r != null) pluginResults.push({ pluginId: p.id, result: r });
      }
    }

    return { ok: true, pluginResults };
  }

  async function shoppingSessionStart(intent) {
    const session = await ensureShoppingSession(intent);
    return { ok: true, session };
  }

  async function shoppingItemScan(intent) {
    const session = await ensureShoppingSession(intent);
    const candidate = await addCandidate(intent, session);

    const ctx = baseCtx({ session, candidate });

    // Let plugins enrich candidate (pricing/coupons/recalls/ingredients/etc.)
    const enrichments = [];
    for (const p of state.plugins) {
      if (isFn(p.onShoppingItemScan)) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.onShoppingItemScan(intent, ctx);
        if (r != null) enrichments.push({ pluginId: p.id, result: r });
      } else if (
        isFn(p.run) &&
        isFn(p.handles) &&
        p.handles(INTENT.SHOPPING_ITEM_SCAN, intent)
      ) {
        // eslint-disable-next-line no-await-in-loop
        const r = await p.run(intent, ctx);
        if (r != null) enrichments.push({ pluginId: p.id, result: r });
      }
    }

    return {
      ok: true,
      sessionId: session.id,
      candidateId: candidate.id,
      candidate,
      enrichments,
    };
  }

  async function shoppingSessionEnd(intent) {
    const sessionId = intent.sessionId || intent.payload?.sessionId;
    if (!sessionId) return { ok: false, error: "Missing sessionId" };

    const session =
      (await state.dbAdapter?.getShoppingSession?.(sessionId)) ||
      state.memory.getSession(sessionId);
    if (!session)
      return { ok: false, error: `Session not found: ${sessionId}` };

    session.status = "ended";
    session.updatedAt = nowISO();

    await state.dbAdapter?.upsertShoppingSession?.(session);
    state.memory.upsertSession(session);

    return { ok: true, sessionId, session };
  }

  async function health() {
    const flags = getFlags(state.flags);
    return {
      ok: true,
      orchestratorId: state.id,
      createdAt: state.createdAt,
      readyAt: state.readyAt,
      enabled: flags.enabled,
      plugins: state.plugins.map((p) => pick(p, ["id"])),
      metrics: { ...state.metrics },
      db: {
        attached: !!state.db,
        tables: state.db?.tables?.map((t) => t.name) || [],
      },
    };
  }

  async function dispatch(intent, ctxOverrides = {}) {
    const normalized = normalizeIntent(intent);
    const flags = getFlags(state.flags);

    if (!flags.enabled) {
      return { ok: false, error: "Scan-Compare-Trust is disabled by flags." };
    }

    const ctx = baseCtx(ctxOverrides);
    const start = Date.now();

    state.metrics.intents += 1;
    state.metrics.lastIntentAt = nowISO();

    emit(state.eventBus, EVT.INTENT_STARTED, {
      at: nowISO(),
      orchestratorId: state.id,
      intentId: normalized.id,
      type: normalized.type,
    });

    const runner = async () => {
      switch (normalized.type) {
        case INTENT.HEALTH:
          return await health();

        case INTENT.SHOPPING_SESSION_START:
          return await shoppingSessionStart(normalized);

        case INTENT.SHOPPING_ITEM_SCAN:
          return await shoppingItemScan(normalized);

        case INTENT.SHOPPING_ITEM_REMOVE:
          return await removeCandidate(normalized);

        case INTENT.SHOPPING_SESSION_END:
          return await shoppingSessionEnd(normalized);

        case INTENT.RECEIPT_INGEST:
          return await ingestReceipt(normalized);

        case INTENT.RECEIPT_RECONCILE:
          return await reconcileReceipt(normalized);

        case INTENT.COMPARE_ITEM:
          return await compareItem(normalized);

        case INTENT.TRUST_CHECK:
          return await trustCheck(normalized);

        default: {
          // If no explicit case, allow plugins to handle
          const pluginResults = [];
          for (const p of state.plugins) {
            if (
              isFn(p.run) &&
              (!isFn(p.handles) || p.handles(normalized.type, normalized))
            ) {
              // eslint-disable-next-line no-await-in-loop
              const r = await p.run(normalized, ctx);
              if (r != null) pluginResults.push({ pluginId: p.id, result: r });
            }
          }

          if (pluginResults.length > 0) return { ok: true, pluginResults };

          return {
            ok: false,
            error: `Unknown SCT intent type: ${normalized.type}`,
          };
        }
      }
    };

    try {
      const res = await withTimeout(runner(), flags.timeoutMs, (err) => {
        emit(state.eventBus, EVT.WARN, {
          at: nowISO(),
          orchestratorId: state.id,
          intentId: normalized.id,
          type: normalized.type,
          warning: err?.message || "timeout",
        });
      });

      emit(state.eventBus, EVT.INTENT_COMPLETED, {
        at: nowISO(),
        orchestratorId: state.id,
        intentId: normalized.id,
        type: normalized.type,
        ms: Date.now() - start,
        ok: !!res?.ok,
      });

      return res;
    } catch (e) {
      state.metrics.intentsFailed += 1;
      state.metrics.lastError = String(e?.message || e);

      emit(state.eventBus, EVT.INTENT_FAILED, {
        at: nowISO(),
        orchestratorId: state.id,
        intentId: normalized.id,
        type: normalized.type,
        ms: Date.now() - start,
        error: String(e?.message || e),
      });

      state.logger.error("[SCT] intent failed:", normalized.type, e);
      return {
        ok: false,
        error: String(e?.message || e),
        code: e?.code || "SCT_ERR",
      };
    }
  }

  async function init(opts = {}) {
    if (_inited) return { ok: true, already: true };

    state.eventBus = opts.eventBus || state.eventBus || null;
    state.db = opts.db || state.db || null;
    state.flags = opts.flags || state.flags || null;
    state.logger = createLogger(opts.logger);

    state.dbAdapter = createDbAdapter(state.db, state.logger);

    // Allow explicit plugin loaders passed in
    const loaders = opts.pluginLoaders || null;
    if (loaders && typeof loaders === "object") {
      for (const [id, loader] of Object.entries(loaders)) {
        if (isFn(loader)) registerPluginLoader(id, loader);
      }
    }

    // Optional: register "conventional" plugin loaders by probing known module paths.
    // This remains safe because it uses import.meta.glob.
    const conventional = import.meta.glob(
      [
        "@/app/features/scan-compare-trust/services/PricingPlugin.{js,jsx,ts,tsx}",
        "@/app/features/scan-compare-trust/services/CouponsPlugin.{js,jsx,ts,tsx}",
        "@/app/features/scan-compare-trust/services/RecallsPlugin.{js,jsx,ts,tsx}",
        "@/app/features/scan-compare-trust/services/IngredientsPlugin.{js,jsx,ts,tsx}",
        "@/app/features/scan-compare-trust/services/ComparePlugin.{js,jsx,ts,tsx}",
        "@/app/features/scan-compare-trust/services/ReceiptReconcilePlugin.{js,jsx,ts,tsx}",
      ],
      { eager: false }
    );

    for (const [path, loader] of Object.entries(conventional)) {
      const idGuess =
        path
          .split("/")
          .pop()
          ?.replace(/\.(jsx?|tsx?)$/, "") || makeId("plugin");
      registerPluginLoader(idGuess, async (ctx) => {
        const mod = await loader();
        return await loadPluginFromModule(mod, ctx, state.logger);
      });
    }

    // Load plugins (registered + discovered)
    await loadDiscoveredPlugins();

    _inited = true;
    state.readyAt = nowISO();

    emit(state.eventBus, EVT.READY, {
      at: state.readyAt,
      orchestratorId: state.id,
      plugins: state.plugins.map((p) => p.id),
    });

    return {
      ok: true,
      orchestratorId: state.id,
      plugins: state.plugins.map((p) => p.id),
    };
  }

  // Public API
  const api = {
    // constants
    EVT,
    INTENT,

    // state/inspection
    get id() {
      return state.id;
    },
    get ready() {
      return _inited;
    },
    get plugins() {
      return state.plugins.slice();
    },
    get metrics() {
      return { ...state.metrics };
    },

    // setup
    init,
    registerPluginLoader,

    // primary entrypoint
    run: async (intent, ctxOverrides = {}) => dispatch(intent, ctxOverrides),

    // convenience helpers (optional usage from UI)
    shopping: {
      start: async (args = {}) =>
        dispatch({ type: INTENT.SHOPPING_SESSION_START, ...args }),
      scanItem: async (args = {}) =>
        dispatch({ type: INTENT.SHOPPING_ITEM_SCAN, ...args }),
      removeItem: async (args = {}) =>
        dispatch({ type: INTENT.SHOPPING_ITEM_REMOVE, ...args }),
      end: async (args = {}) =>
        dispatch({ type: INTENT.SHOPPING_SESSION_END, ...args }),
    },
    receipt: {
      ingest: async (args = {}) =>
        dispatch({ type: INTENT.RECEIPT_INGEST, ...args }),
      reconcile: async (args = {}) =>
        dispatch({ type: INTENT.RECEIPT_RECONCILE, ...args }),
    },
    compare: {
      item: async (args = {}) =>
        dispatch({ type: INTENT.COMPARE_ITEM, ...args }),
    },
    trust: {
      check: async (args = {}) =>
        dispatch({ type: INTENT.TRUST_CHECK, ...args }),
    },
    health: async () => dispatch({ type: INTENT.HEALTH }),
  };

  return api;
}

// Export singleton instance (default), plus named export for flexibility.
const SCTOrchestrator = createSCTOrchestratorSingleton();

export default SCTOrchestrator;
export { SCTOrchestrator };

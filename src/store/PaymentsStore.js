// File: src/store/PaymentsStore.js
/**
 * PaymentsStore (SSA)
 * -----------------------------------------------------------------------------
 * Purpose
 *  - Central ledger + state store for payments, contributions, payouts, and
 *    reconciliation inside SSA (and Family Fund–style flows).
 *
 * What it supports
 *  - Payment records (inbound/outbound), statuses, links to receipts/sessions
 *  - Idempotent commits (externalRef / fingerprint)
 *  - Light-weight reconciliation markers (matched / unmatched)
 *  - Optional Dexie persistence (if db.payments exists)
 *  - LocalStorage persistence fallback (always available in browser)
 *  - EventBus emissions (payments.changed, payments.committed, etc.)
 *  - React-friendly subscribe/getSnapshot for useSyncExternalStore
 *
 * Non-goals
 *  - This does NOT process real payments; it stores records and metadata so the
 *    app can orchestrate workflows safely.
 */

const STORE_NAME = "PaymentsStore";
const LS_KEY = "SSA.PaymentsStore.v1";
const SCHEMA_VERSION = 1;

const DEFAULTS = {
  version: SCHEMA_VERSION,
  hydrated: false,
  dirty: false,
  lastHydratedAt: null,
  lastPersistedAt: null,
  source: "local", // local | dexie | merged
  error: null,

  paymentsById: {}, // id -> Payment
  order: [], // newest-first

  prefs: {
    defaultSort: "createdDesc", // createdDesc | updatedDesc | amountDesc | amountAsc | statusAsc
    hideVoided: true,
    defaultCurrency: "USD",
  },
};

/**
 * Payment Shape (documentation)
 * -----------------------------------------------------------------------------
 * {
 *   id: string,
 *   kind: "payment"|"contribution"|"payout"|"transfer"|"refund"|"adjustment",
 *   direction: "in"|"out",
 *   status: "pending"|"authorized"|"captured"|"settled"|"failed"|"voided"|"refunded"|"reconciled",
 *   amount: number,          // positive number
 *   currency: "USD",
 *   memo?: string,
 *   method?: "cash"|"card"|"bank"|"check"|"mobile"|"barter"|"internal",
 *   processor?: string,      // e.g., "stripe", "square", "paypal"
 *   externalRef?: string,    // processor id, bank txn id, receipt number, etc. (idempotency)
 *   fingerprint?: string,    // optional deterministic hash-like string for idempotency
 *   createdAt: ISO,
 *   updatedAt: ISO,
 *   occurredAt?: ISO,        // when it actually occurred (receipt timestamp)
 *   counterparty?: {         // person/vendor/group
 *     id?: string,
 *     name?: string,
 *     type?: "vendor"|"person"|"group"|"household"|"account",
 *   },
 *   allocation?: {           // optional split
 *     buckets?: Array<{ key: string, amount: number, note?: string }>
 *   },
 *   links?: {
 *     receiptId?: string,
 *     sessionId?: string,
 *     artifactId?: string,
 *     vendorId?: string,
 *     storeId?: string,
 *     susuCircleId?: string,
 *     invoiceId?: string,
 *     orderId?: string,
 *   },
 *   reconciliation?: {
 *     state?: "unmatched"|"matched"|"partial"|"conflict",
 *     matchedRefs?: string[],
 *     note?: string,
 *     reconciledAt?: ISO,
 *   },
 *   meta?: Record<string, any>,
 * }
 */

/* -------------------------------- Utilities -------------------------------- */

function nowISO() {
  return new Date().toISOString();
}

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, patch) {
  if (!isObject(base) || !isObject(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) {
    const pv = patch[k];
    const bv = base[k];
    if (isObject(bv) && isObject(pv)) out[k] = deepMerge(bv, pv);
    else out[k] = pv;
  }
  return out;
}

function safeParseJSON(str, fallback) {
  try {
    const v = JSON.parse(str);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function stableUnique(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    if (v == null) continue;
    const s = String(v);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function toNumber(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function round2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 100) / 100;
}

function clampInt(n, min, max, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  const xi = Math.trunc(x);
  return Math.min(max, Math.max(min, xi));
}

function normalizeISO(maybeISO) {
  if (!maybeISO) return undefined;
  const d = new Date(maybeISO);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

function createId(prefix = "pay") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function normalizeCurrency(cur, fallback = "USD") {
  const s = String(cur || "")
    .trim()
    .toUpperCase();
  return s || fallback;
}

function normalizeStatus(s) {
  const v = String(s || "pending").trim();
  const allowed = [
    "pending",
    "authorized",
    "captured",
    "settled",
    "failed",
    "voided",
    "refunded",
    "reconciled",
  ];
  return allowed.includes(v) ? v : "pending";
}

function normalizeKind(k) {
  const v = String(k || "payment").trim();
  const allowed = [
    "payment",
    "contribution",
    "payout",
    "transfer",
    "refund",
    "adjustment",
  ];
  return allowed.includes(v) ? v : "payment";
}

function normalizeDirection(d) {
  const v = String(d || "out").trim();
  return v === "in" ? "in" : "out";
}

function sortIds(state, ids, sortKey) {
  const map = state.paymentsById || {};
  const key = sortKey || state.prefs?.defaultSort || "createdDesc";

  const cmpDateDesc = (a, b) => {
    const ta = a ? new Date(a).getTime() : 0;
    const tb = b ? new Date(b).getTime() : 0;
    return tb - ta;
  };

  const cmpNum = (a, b) => (a || 0) - (b || 0);

  const cmpStr = (a, b) => (a || "").localeCompare(b || "");

  const get = (id) => map[id];

  const f = {
    createdDesc: (a, b) => cmpDateDesc(get(a)?.createdAt, get(b)?.createdAt),
    updatedDesc: (a, b) => cmpDateDesc(get(a)?.updatedAt, get(b)?.updatedAt),
    amountDesc: (a, b) => cmpNum(get(b)?.amount, get(a)?.amount),
    amountAsc: (a, b) => cmpNum(get(a)?.amount, get(b)?.amount),
    statusAsc: (a, b) => cmpStr(get(a)?.status, get(b)?.status),
  }[key];

  const copy = [...ids];
  copy.sort((a, b) => (f ? f(a, b) : 0));
  return copy;
}

/* --------------------------- Optional Dependencies --------------------------- */

async function tryLoadEventBus() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/events/eventBus");
    return mod?.eventBus || mod?.default || null;
  } catch {
    return null;
  }
}

async function tryLoadDexieDB() {
  try {
    const mod = await import(/* @vite-ignore */ "@/services/db");
    const db = mod?.db || mod?.default || null;
    if (!db) return null;
    if (!db.payments) return null;
    return db;
  } catch {
    return null;
  }
}

/* --------------------------------- Store Core -------------------------------- */

function createStore() {
  let state = { ...DEFAULTS };
  const listeners = new Set();

  let eventBus = null;
  let dexie = null;

  function emitLocal() {
    for (const fn of listeners) {
      try {
        fn();
      } catch {
        // ignore subscriber errors
      }
    }
  }

  function setState(updater, meta = {}) {
    const prev = state;
    const next =
      typeof updater === "function" ? updater(prev) : deepMerge(prev, updater);

    const nextState = {
      ...next,
      paymentsById: next.paymentsById || {},
      order: Array.isArray(next.order) ? next.order : [],
      prefs: deepMerge(DEFAULTS.prefs, next.prefs || {}),
    };

    state = nextState;

    // Emit eventBus notification
    if (eventBus && typeof eventBus.emit === "function") {
      try {
        eventBus.emit("payments.changed", {
          source: STORE_NAME,
          at: nowISO(),
          meta,
        });
      } catch {
        // ignore
      }
    } else if (eventBus && typeof eventBus.publish === "function") {
      try {
        eventBus.publish("payments.changed", {
          source: STORE_NAME,
          at: nowISO(),
          meta,
        });
      } catch {
        // ignore
      }
    }

    emitLocal();
  }

  function getState() {
    return state;
  }

  function getSnapshot() {
    return state;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /* ------------------------------ Persistence -------------------------------- */

  function loadFromLocalStorage() {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage?.getItem?.(LS_KEY);
    if (!raw) return null;
    const parsed = safeParseJSON(raw, null);
    if (!parsed || typeof parsed !== "object") return null;

    const paymentsById = isObject(parsed.paymentsById)
      ? parsed.paymentsById
      : {};
    const order = Array.isArray(parsed.order) ? parsed.order : [];

    return {
      ...DEFAULTS,
      ...parsed,
      paymentsById,
      order,
      prefs: deepMerge(DEFAULTS.prefs, parsed.prefs || {}),
      hydrated: true,
      source: "local",
      error: null,
      lastHydratedAt: nowISO(),
      dirty: false,
    };
  }

  function saveToLocalStorage(snapshot) {
    if (typeof window === "undefined") return;
    try {
      const payload = {
        ...snapshot,
        error: snapshot.error ? String(snapshot.error) : null,
      };
      window.localStorage?.setItem?.(LS_KEY, JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  async function loadFromDexieIfAvailable() {
    if (!dexie) return null;
    try {
      const rows = await dexie.payments.toArray();
      const paymentsById = {};
      const order = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || !row.id) continue;
        paymentsById[row.id] = normalizePayment(row, { keepTimestamps: true });
        order.push(row.id);
      }
      const sorted = sortIds(
        { ...state, paymentsById, prefs: state.prefs },
        stableUnique(order),
        state.prefs?.defaultSort
      );

      return {
        ...DEFAULTS,
        ...state,
        paymentsById,
        order: sorted,
        hydrated: true,
        source: "dexie",
        error: null,
        lastHydratedAt: nowISO(),
        dirty: false,
      };
    } catch (e) {
      return {
        ...state,
        hydrated: true,
        error: e ? String(e) : "Dexie load failed",
        lastHydratedAt: nowISO(),
      };
    }
  }

  async function persistToDexie(snapshot) {
    if (!dexie) return false;
    try {
      const ids = Object.keys(snapshot.paymentsById || {});
      if (typeof dexie.payments.bulkPut === "function") {
        const rows = ids.map((id) => snapshot.paymentsById[id]);
        await dexie.payments.bulkPut(rows);
      } else {
        for (const id of ids) {
          await dexie.payments.put(snapshot.paymentsById[id]);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------ Normalization ------------------------------ */

  function normalizePayment(input, opts = {}) {
    const keep = !!opts.keepTimestamps;
    const base = isObject(input) ? { ...input } : {};

    const id = String(base.id || createId("pay"));
    const createdAt = keep
      ? normalizeISO(base.createdAt) || nowISO()
      : normalizeISO(base.createdAt) || nowISO();
    const updatedAt = keep
      ? normalizeISO(base.updatedAt) || createdAt
      : nowISO();

    const kind = normalizeKind(base.kind);
    const direction = normalizeDirection(base.direction);
    const status = normalizeStatus(base.status);

    const amount = round2(Math.max(0, toNumber(base.amount) ?? 0));
    const currency = normalizeCurrency(
      base.currency,
      state.prefs?.defaultCurrency || "USD"
    );

    const occurredAt = normalizeISO(base.occurredAt);

    const method = base.method != null ? String(base.method) : undefined;
    const processor =
      base.processor != null ? String(base.processor) : undefined;

    const externalRef =
      base.externalRef != null ? String(base.externalRef) : undefined;
    const fingerprint =
      base.fingerprint != null ? String(base.fingerprint) : undefined;

    const counterparty = isObject(base.counterparty)
      ? { ...base.counterparty }
      : undefined;
    if (counterparty) {
      if (counterparty.id != null) counterparty.id = String(counterparty.id);
      if (counterparty.name != null)
        counterparty.name = String(counterparty.name);
      if (counterparty.type != null)
        counterparty.type = String(counterparty.type);
    }

    const allocation = isObject(base.allocation)
      ? { ...base.allocation }
      : undefined;
    if (allocation && Array.isArray(allocation.buckets)) {
      allocation.buckets = allocation.buckets
        .map((b) => {
          if (!isObject(b)) return null;
          const amt = round2(Math.max(0, toNumber(b.amount) ?? 0));
          return {
            key: String(b.key || "bucket"),
            amount: amt,
            note: b.note != null ? String(b.note) : undefined,
          };
        })
        .filter(Boolean);
    }

    const links = isObject(base.links) ? { ...base.links } : undefined;
    if (links) {
      for (const k of Object.keys(links)) {
        if (links[k] != null) links[k] = String(links[k]);
      }
    }

    const reconciliation = isObject(base.reconciliation)
      ? { ...base.reconciliation }
      : undefined;
    if (reconciliation) {
      const allowed = ["unmatched", "matched", "partial", "conflict"];
      const st = String(reconciliation.state || "unmatched");
      reconciliation.state = allowed.includes(st) ? st : "unmatched";
      reconciliation.matchedRefs = stableUnique(reconciliation.matchedRefs);
      reconciliation.note =
        reconciliation.note != null ? String(reconciliation.note) : undefined;
      reconciliation.reconciledAt = normalizeISO(reconciliation.reconciledAt);
    }

    return {
      id,
      kind,
      direction,
      status,
      amount,
      currency,
      memo: base.memo != null ? String(base.memo) : undefined,
      method,
      processor,
      externalRef,
      fingerprint,
      createdAt,
      updatedAt,
      occurredAt,
      counterparty,
      allocation,
      links,
      reconciliation,
      meta: isObject(base.meta) ? { ...base.meta } : undefined,
    };
  }

  /* ------------------------------ Idempotency ------------------------------- */

  function findExistingIdByExternalRef(externalRef) {
    if (!externalRef) return null;
    const ref = String(externalRef);
    for (const id of state.order) {
      const p = state.paymentsById[id];
      if (p && p.externalRef && String(p.externalRef) === ref) return id;
    }
    return null;
  }

  function findExistingIdByFingerprint(fp) {
    if (!fp) return null;
    const ref = String(fp);
    for (const id of state.order) {
      const p = state.paymentsById[id];
      if (p && p.fingerprint && String(p.fingerprint) === ref) return id;
    }
    return null;
  }

  /* -------------------------------- Lifecycle -------------------------------- */

  async function init() {
    if (!eventBus) eventBus = await tryLoadEventBus();
    if (!dexie) dexie = await tryLoadDexieDB();

    const local = loadFromLocalStorage();
    if (local) setState(local, { op: "hydrate.local" });
    else
      setState(
        { hydrated: true, lastHydratedAt: nowISO(), source: "local" },
        { op: "hydrate.empty" }
      );

    if (dexie) {
      const dx = await loadFromDexieIfAvailable();
      if (dx && dx.source === "dexie" && dx.hydrated) {
        setState(
          (prev) => {
            const merged = mergePaymentMaps(prev, dx);
            return {
              ...prev,
              ...merged,
              hydrated: true,
              source: local ? "merged" : "dexie",
              lastHydratedAt: nowISO(),
              error: dx.error || prev.error || null,
              dirty: false,
            };
          },
          { op: "hydrate.dexie.merge" }
        );

        saveToLocalStorage(getState());
      }
    }
  }

  function mergePaymentMaps(aState, bState) {
    const a = aState?.paymentsById || {};
    const b = bState?.paymentsById || {};
    const out = { ...a };

    for (const id of Object.keys(b)) {
      const ap = a[id];
      const bp = b[id];
      if (!ap) {
        out[id] = bp;
        continue;
      }
      const aU = ap.updatedAt ? new Date(ap.updatedAt).getTime() : 0;
      const bU = bp.updatedAt ? new Date(bp.updatedAt).getTime() : 0;
      out[id] = bU >= aU ? bp : ap;
    }

    const combinedOrder = stableUnique([
      ...(aState.order || []),
      ...(bState.order || []),
    ]);
    const sorted = sortIds(
      { ...aState, paymentsById: out, prefs: aState.prefs },
      combinedOrder.length ? combinedOrder : Object.keys(out),
      aState.prefs?.defaultSort
    );

    return { paymentsById: out, order: sorted };
  }

  function persistNow() {
    const snapshot = getState();
    saveToLocalStorage({
      ...snapshot,
      dirty: false,
      lastPersistedAt: nowISO(),
    });

    if (dexie) {
      persistToDexie(snapshot).then((ok) => {
        if (ok) {
          setState(
            (prev) => ({ ...prev, dirty: false, lastPersistedAt: nowISO() }),
            { op: "persist.dexie" }
          );
        }
      });
    } else {
      setState(
        (prev) => ({ ...prev, dirty: false, lastPersistedAt: nowISO() }),
        { op: "persist.local" }
      );
    }
  }

  /* ---------------------------------- Prefs ---------------------------------- */

  function setPrefs(partialOrUpdater) {
    setState(
      (prev) => {
        const nextPrefs =
          typeof partialOrUpdater === "function"
            ? partialOrUpdater(prev.prefs)
            : deepMerge(prev.prefs, partialOrUpdater || {});
        return { ...prev, prefs: nextPrefs, dirty: true };
      },
      { op: "prefs.set" }
    );
  }

  /* --------------------------------- Actions -------------------------------- */

  function addPayment(input, { idempotent = true } = {}) {
    // Idempotency check first
    if (idempotent) {
      const ext = input?.externalRef;
      const fp = input?.fingerprint;
      const found =
        (ext && findExistingIdByExternalRef(ext)) ||
        (fp && findExistingIdByFingerprint(fp));
      if (found) {
        // merge into existing by patch
        patchPayment(found, input);
        return found;
      }
    }

    const p = normalizePayment(input);
    setState(
      (prev) => {
        const paymentsById = { ...prev.paymentsById, [p.id]: p };
        const order = sortIds(
          { ...prev, paymentsById },
          stableUnique([p.id, ...prev.order]),
          prev.prefs?.defaultSort
        );
        return { ...prev, paymentsById, order, dirty: true };
      },
      { op: "payment.add", id: p.id }
    );

    // Emit a dedicated event
    if (eventBus && typeof eventBus.emit === "function") {
      try {
        eventBus.emit("payments.committed", {
          source: STORE_NAME,
          at: nowISO(),
          id: p.id,
        });
      } catch {
        // ignore
      }
    } else if (eventBus && typeof eventBus.publish === "function") {
      try {
        eventBus.publish("payments.committed", {
          source: STORE_NAME,
          at: nowISO(),
          id: p.id,
        });
      } catch {
        // ignore
      }
    }

    return p.id;
  }

  function addPayments(inputs = [], { idempotent = true } = {}) {
    const ids = [];
    const list = Array.isArray(inputs) ? inputs : [];

    for (const input of list) {
      const id = addPayment(input, { idempotent });
      if (id) ids.push(id);
    }
    return stableUnique(ids);
  }

  function updatePayment(paymentId, fullPayment) {
    if (!paymentId) return false;
    const id = String(paymentId);
    const existing = state.paymentsById[id];
    if (!existing) return false;

    const normalized = normalizePayment(
      { ...fullPayment, id, createdAt: existing.createdAt },
      { keepTimestamps: true }
    );
    normalized.createdAt = existing.createdAt;
    normalized.updatedAt = nowISO();

    setState(
      (prev) => {
        const paymentsById = { ...prev.paymentsById, [id]: normalized };
        const order = sortIds(
          { ...prev, paymentsById },
          stableUnique(
            prev.order.includes(id) ? prev.order : [id, ...prev.order]
          ),
          prev.prefs?.defaultSort
        );
        return { ...prev, paymentsById, order, dirty: true };
      },
      { op: "payment.update", id }
    );

    return true;
  }

  function patchPayment(paymentId, patch) {
    if (!paymentId) return false;
    const id = String(paymentId);
    const existing = state.paymentsById[id];
    if (!existing) return false;

    const merged = deepMerge(existing, patch || {});
    const normalized = normalizePayment(
      { ...merged, id, createdAt: existing.createdAt, updatedAt: nowISO() },
      { keepTimestamps: true }
    );
    normalized.createdAt = existing.createdAt;
    normalized.updatedAt = nowISO();

    setState(
      (prev) => {
        const paymentsById = { ...prev.paymentsById, [id]: normalized };
        const order = sortIds(
          { ...prev, paymentsById },
          stableUnique(
            prev.order.includes(id) ? prev.order : [id, ...prev.order]
          ),
          prev.prefs?.defaultSort
        );
        return { ...prev, paymentsById, order, dirty: true };
      },
      { op: "payment.patch", id }
    );

    return true;
  }

  function setStatus(paymentId, status) {
    const id = String(paymentId);
    const existing = state.paymentsById[id];
    if (!existing) return false;

    const next = normalizeStatus(status);
    return patchPayment(id, { status: next });
  }

  function reconcile(
    paymentId,
    { state: reconState = "matched", matchedRefs, note } = {}
  ) {
    const id = String(paymentId);
    const existing = state.paymentsById[id];
    if (!existing) return false;

    const allowed = ["unmatched", "matched", "partial", "conflict"];
    const st = allowed.includes(String(reconState))
      ? String(reconState)
      : "matched";
    const patch = {
      status: st === "matched" ? "reconciled" : existing.status,
      reconciliation: {
        ...(existing.reconciliation || {}),
        state: st,
        matchedRefs: stableUnique(matchedRefs),
        note:
          note != null ? String(note) : (existing.reconciliation || {}).note,
        reconciledAt: nowISO(),
      },
    };
    return patchPayment(id, patch);
  }

  async function deletePayment(paymentId) {
    if (!paymentId) return false;
    const id = String(paymentId);
    const existing = state.paymentsById[id];
    if (!existing) return false;

    setState(
      (prev) => {
        const paymentsById = { ...prev.paymentsById };
        delete paymentsById[id];
        const order = prev.order.filter((x) => x !== id);
        return { ...prev, paymentsById, order, dirty: true };
      },
      { op: "payment.delete", id }
    );

    // Best-effort remove from Dexie
    if (dexie) {
      try {
        if (dexie.payments && typeof dexie.payments.delete === "function") {
          await dexie.payments.delete(id);
        }
      } catch {
        // ignore
      }
    }

    return true;
  }

  function clearVoided() {
    const idsToRemove = [];
    for (const id of state.order) {
      const p = state.paymentsById[id];
      if (p && p.status === "voided") idsToRemove.push(id);
    }
    if (!idsToRemove.length) return 0;

    setState(
      (prev) => {
        const paymentsById = { ...prev.paymentsById };
        for (const id of idsToRemove) delete paymentsById[id];
        const order = prev.order.filter((id) => !idsToRemove.includes(id));
        return { ...prev, paymentsById, order, dirty: true };
      },
      { op: "payment.clearVoided", count: idsToRemove.length }
    );

    return idsToRemove.length;
  }

  /* ------------------------------ Import/Export ------------------------------ */

  function importPayments(payload, { mode = "merge", idempotent = true } = {}) {
    const list = Array.isArray(payload) ? payload : payload?.payments;
    if (!Array.isArray(list)) return { imported: 0, mode };

    const normalized = list.map((p) =>
      normalizePayment(p, { keepTimestamps: true })
    );

    setState(
      (prev) => {
        const paymentsById = mode === "replace" ? {} : { ...prev.paymentsById };
        const orderSeed = mode === "replace" ? [] : [...prev.order];

        for (const p of normalized) {
          // optional idempotency by externalRef/fingerprint
          if (idempotent) {
            const found =
              (p.externalRef &&
                Object.values(paymentsById).find(
                  (x) => x?.externalRef === p.externalRef
                )?.id) ||
              (p.fingerprint &&
                Object.values(paymentsById).find(
                  (x) => x?.fingerprint === p.fingerprint
                )?.id) ||
              null;
            if (found) {
              const existing = paymentsById[found];
              const aU = existing?.updatedAt
                ? new Date(existing.updatedAt).getTime()
                : 0;
              const bU = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
              paymentsById[found] = bU >= aU ? p : existing;
              orderSeed.push(found);
              continue;
            }
          }

          const existing = paymentsById[p.id];
          if (!existing) {
            paymentsById[p.id] = p;
            orderSeed.push(p.id);
            continue;
          }
          const aU = existing.updatedAt
            ? new Date(existing.updatedAt).getTime()
            : 0;
          const bU = p.updatedAt ? new Date(p.updatedAt).getTime() : 0;
          paymentsById[p.id] = bU >= aU ? p : existing;
          orderSeed.push(p.id);
        }

        const order = sortIds(
          { ...prev, paymentsById },
          stableUnique(
            orderSeed.length ? orderSeed : Object.keys(paymentsById)
          ),
          prev.prefs?.defaultSort
        );

        return { ...prev, paymentsById, order, dirty: true };
      },
      { op: "payments.import", count: normalized.length, mode }
    );

    return { imported: normalized.length, mode };
  }

  function exportPayments({ includeVoided = true } = {}) {
    const all = state.order
      .map((id) => state.paymentsById[id])
      .filter(Boolean)
      .filter((p) => (includeVoided ? true : p.status !== "voided"));

    return {
      version: SCHEMA_VERSION,
      exportedAt: nowISO(),
      payments: all,
      prefs: state.prefs,
    };
  }

  /* -------------------------------- Selectors -------------------------------- */

  function list({ filter, sort, includeVoided } = {}) {
    const incVoided =
      typeof includeVoided === "boolean"
        ? includeVoided
        : !state.prefs?.hideVoided;

    let ids = state.order.slice();

    if (!incVoided) {
      ids = ids.filter((id) => state.paymentsById[id]?.status !== "voided");
    }

    if (typeof filter === "function") {
      ids = ids.filter((id) => {
        const p = state.paymentsById[id];
        return p ? !!filter(p) : false;
      });
    }

    const sorted = sortIds(state, ids, sort || state.prefs?.defaultSort);
    return sorted.map((id) => state.paymentsById[id]).filter(Boolean);
  }

  function get(paymentId) {
    return state.paymentsById[String(paymentId)] || null;
  }

  function totals({ fromISO, toISO, kind, direction, status } = {}) {
    const from = fromISO ? new Date(fromISO).getTime() : null;
    const to = toISO ? new Date(toISO).getTime() : null;

    let count = 0;
    let sum = 0;

    for (const id of state.order) {
      const p = state.paymentsById[id];
      if (!p) continue;

      if (kind && String(p.kind) !== String(kind)) continue;
      if (direction && String(p.direction) !== String(direction)) continue;
      if (status && String(p.status) !== String(status)) continue;

      const when = new Date(p.occurredAt || p.createdAt || 0).getTime();
      if (from != null && when < from) continue;
      if (to != null && when >= to) continue;

      count++;
      sum += toNumber(p.amount) ?? 0;
    }

    return {
      count,
      amount: round2(sum),
      currency: state.prefs?.defaultCurrency || "USD",
    };
  }

  function summaryCounts() {
    let total = 0,
      pending = 0,
      settled = 0,
      failed = 0,
      voided = 0,
      reconciled = 0;

    for (const id of state.order) {
      const p = state.paymentsById[id];
      if (!p) continue;
      total++;

      if (
        p.status === "pending" ||
        p.status === "authorized" ||
        p.status === "captured"
      )
        pending++;
      else if (p.status === "settled") settled++;
      else if (p.status === "failed") failed++;
      else if (p.status === "voided") voided++;
      else if (p.status === "reconciled") reconciled++;
    }

    return { total, pending, settled, failed, voided, reconciled };
  }

  function byExternalRef(externalRef) {
    const id = findExistingIdByExternalRef(externalRef);
    return id ? state.paymentsById[id] : null;
  }

  function byFingerprint(fp) {
    const id = findExistingIdByFingerprint(fp);
    return id ? state.paymentsById[id] : null;
  }

  /* ----------------------------- Public API ---------------------------------- */

  return {
    // core
    getState,
    getSnapshot,
    subscribe,

    // lifecycle
    init,

    // persistence
    persistNow,

    // prefs
    setPrefs,

    // actions
    addPayment,
    addPayments,
    updatePayment,
    patchPayment,
    setStatus,
    reconcile,
    deletePayment,
    clearVoided,

    // import/export
    importPayments,
    exportPayments,

    // selectors
    list,
    get,
    totals,
    summaryCounts,
    byExternalRef,
    byFingerprint,
  };
}

/* -------------------------------- Singleton --------------------------------- */

const PaymentsStore = createStore();

// Auto-init in browser
if (typeof window !== "undefined") {
  Promise.resolve()
    .then(() => PaymentsStore.init())
    .catch(() => {});
}

export default PaymentsStore;

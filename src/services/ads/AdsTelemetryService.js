// src/services/ads/AdsTelemetryService.js
// Privacy-respecting ads telemetry:
// - impression
// - click (view store details)
// - conversion proxy (receipt-confirmed) — optional premium + opt-in friendly
//
// Local-first storage:
// - If Dexie has table `ads_telemetry`, we use it.
// - Else we fall back to localStorage ring-buffer.
//
// Also emits lightweight events so UI/analytics can react without tight coupling.

const isBrowser = typeof window !== "undefined";

const safeJSON = {
  parse: (s, f = null) => {
    try {
      return JSON.parse(s);
    } catch {
      return f;
    }
  },
  stringify: (o) => {
    try {
      return JSON.stringify(o);
    } catch {
      return "";
    }
  },
};

const storage = (() => {
  const keyPrefix = "suka::adsTelemetry::";
  if (isBrowser && window.localStorage) {
    return {
      get: (k, d = null) =>
        safeJSON.parse(localStorage.getItem(keyPrefix + k), d),
      set: (k, v) => localStorage.setItem(keyPrefix + k, safeJSON.stringify(v)),
      del: (k) => localStorage.removeItem(keyPrefix + k),
    };
  }
  const mem = new Map();
  return {
    get: (k, d = null) => (mem.has(k) ? mem.get(k) : d),
    set: (k, v) => mem.set(k, v),
    del: (k) => mem.delete(k),
  };
})();

const RING_KEY = "ring";
const MAX_RING = 800;

function emit(evtName, detail) {
  try {
    window.dispatchEvent(new CustomEvent(evtName, { detail }));
  } catch {}
}

async function getDexieTable() {
  try {
    const mod = await import("@/services/db");
    const db = mod?.db || mod?.default || null;
    if (db?.ads_telemetry) return db.ads_telemetry;
  } catch {}
  return null;
}

function ringRead() {
  return storage.get(RING_KEY, []);
}

function ringWrite(list) {
  const trimmed = Array.isArray(list) ? list.slice(-MAX_RING) : [];
  storage.set(RING_KEY, trimmed);
  return trimmed;
}

async function writeLocal(record) {
  const tbl = await getDexieTable();
  if (tbl) {
    try {
      await tbl.put(record);
      return { ok: true, mode: "dexie" };
    } catch {
      // fallback to ring
    }
  }
  const ring = ringRead();
  ring.push(record);
  ringWrite(ring);
  return { ok: true, mode: "ring" };
}

function minimalizeForPrivacy(record) {
  // Keep placeId + coarse metadata, avoid storing raw user identity here.
  // You can expand later with explicit consent.
  const r = record || {};
  return {
    id: r.id,
    type: r.type,
    ts: r.ts,
    sessionId: r.sessionId || "default",
    placeId: r.placeId || null,
    impressionId: r.impressionId || null,
    receiptId: r.receiptId || null,
    meta: r.meta || {},
    context: r.context || {},
    v: 1,
  };
}

const AdsTelemetryService = {
  async recordImpression(impression, { prefs } = {}) {
    const rec = minimalizeForPrivacy({
      ...impression,
      type: "impression",
      ts: impression?.ts || Date.now(),
    });

    const writeRes = await writeLocal(rec);
    emit("ads.telemetry.impression", rec);

    // shareAdsTelemetry is opt-in; for now we only emit a bus-ready event hook.
    if (prefs?.shareAdsTelemetry) {
      emit("ads.telemetry.share.request", { type: "impression", record: rec });
    }

    return { ok: true, ...writeRes };
  },

  async recordClick(click, { prefs } = {}) {
    const rec = minimalizeForPrivacy({
      ...click,
      type: "click",
      ts: click?.ts || Date.now(),
    });

    const writeRes = await writeLocal(rec);
    emit("ads.telemetry.click", rec);

    if (prefs?.shareAdsTelemetry) {
      emit("ads.telemetry.share.request", { type: "click", record: rec });
    }

    return { ok: true, ...writeRes };
  },

  async recordConversionProxy(conversion, { prefs } = {}) {
    const rec = minimalizeForPrivacy({
      ...conversion,
      type: "conversion_proxy",
      ts: conversion?.ts || Date.now(),
    });

    const writeRes = await writeLocal(rec);
    emit("ads.telemetry.conversion_proxy", rec);

    if (prefs?.shareAdsTelemetry) {
      emit("ads.telemetry.share.request", {
        type: "conversion_proxy",
        record: rec,
      });
    }

    return { ok: true, ...writeRes };
  },

  async listLocal({ limit = 200 } = {}) {
    const tbl = await getDexieTable();
    if (tbl) {
      try {
        const out = await tbl.orderBy("ts").reverse().limit(limit).toArray();
        return { ok: true, mode: "dexie", items: out || [] };
      } catch {
        // fallback
      }
    }
    const ring = ringRead();
    return { ok: true, mode: "ring", items: ring.slice(-limit).reverse() };
  },

  async clearLocal() {
    const tbl = await getDexieTable();
    if (tbl) {
      try {
        await tbl.clear();
      } catch {}
    }
    storage.del(RING_KEY);
    emit("ads.telemetry.cleared", { ts: Date.now() });
    return { ok: true };
  },
};

export default AdsTelemetryService;

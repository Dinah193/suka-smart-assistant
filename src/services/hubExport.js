// File: C:\Users\larho\suka-smart-assistant\src\services\hubExport.js
/**
 * hubExport (SSA)
 * -----------------------------------------------------------------------------
 * A browser-safe, production-ready export shim for the "Hub" (Family Fund Hub).
 *
 * Why this exists
 *  - Some SSA modules want to "export" packets to a central hub (or another app)
 *    without hard-binding to a backend, node fs/path, or brittle import paths.
 *  - This service provides:
 *      • exportToHub(packet, options?)
 *      • exportManyToHub(packets, options?)
 *      • prepareHubPacket(kind, payload, options?) (soft-uses HubPacketFormatter if present)
 *      • setHubConnector(connector) / getHubConnector()
 *      • exportToFile(packet, filename?) (download JSON in browser)
 *
 * Operating modes
 *  - If a connector is registered (FamilyFundConnector, etc.), we send packets there.
 *  - Else, we fall back to:
 *      1) emitting events for an eventual background sync,
 *      2) writing a local export record to Dexie (if table exists),
 *      3) offering a JSON file download helper.
 *
 * Safety
 *  - No Node imports. Fully browser-safe.
 *  - All optional deps are soft imported.
 */

let logger = null;
try {
  const mod = await import("@/utils/logger.js");
  logger = mod?.default ?? mod ?? null;
} catch {
  logger = null;
}

let eventBus = null;
try {
  const mod = await import("@/services/events/eventBus");
  eventBus = mod?.default ?? mod ?? null;
} catch {
  eventBus = null;
}

let autoBus = null;
try {
  const mod = await import("@/services/automation/eventBus.js");
  autoBus = mod?.default ?? mod ?? null;
} catch {
  autoBus = null;
}

/**
 * Optional feature flags module (preferred) or JSON fallback.
 * Needed for exportToHubIfEnabled().
 */
let featureFlags = { familyFundMode: false };
try {
  const mod = await import("@/config/featureFlags");
  // tolerate various shapes
  featureFlags = {
    ...featureFlags,
    ...(mod?.default && typeof mod.default === "object" ? mod.default : {}),
    ...(typeof mod?.featureFlags === "object" ? mod.featureFlags : {}),
    ...(typeof mod === "object" ? mod : {}),
    familyFundMode:
      typeof mod?.familyFundMode === "boolean"
        ? mod.familyFundMode
        : typeof mod?.default?.familyFundMode === "boolean"
        ? mod.default.familyFundMode
        : featureFlags.familyFundMode,
  };
} catch {
  // try JSON fallback
  try {
    const mod = await import("@/config/featureFlags.json");
    featureFlags =
      (mod?.default && typeof mod.default === "object" ? mod.default : mod) ||
      featureFlags;
  } catch {
    featureFlags = featureFlags || { familyFundMode: false };
  }
}

import db from "@/services/db";

// Optional: formatter / connector (may not exist in your project at times)
let HubPacketFormatter = null;
try {
  const mod = await import("@/services/hub/HubPacketFormatter.js");
  HubPacketFormatter = mod?.default ?? mod ?? null;
} catch {
  HubPacketFormatter = null;
}

let FamilyFundConnector = null;
try {
  const mod = await import("@/services/hub/FamilyFundConnector.js");
  FamilyFundConnector = mod?.default ?? mod ?? null;
} catch {
  FamilyFundConnector = null;
}

const SOURCE = "services.hubExport";

/* -----------------------------------------------------------------------------
 * Internal state
 * -------------------------------------------------------------------------- */

const state = {
  connector: null, // injected connector (preferred)
  lastResult: null,
};

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

function safeObj(x) {
  return x && typeof x === "object" && !Array.isArray(x) ? x : {};
}
function safeArr(x) {
  return Array.isArray(x) ? x : [];
}
function nowISO() {
  return new Date().toISOString();
}
function uid(prefix = "hub") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}
function emit(name, payload) {
  try {
    eventBus?.emit?.(name, payload);
  } catch {}
  try {
    autoBus?.emit?.(name, payload);
  } catch {}
}
function clampLen(s, max = 20000) {
  const str = String(s || "");
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function resolveExportsTable() {
  // Optional Dexie table to store local export outbox
  const candidates = [
    "hub_exports",
    "hubExports",
    "exports_hub",
    "hub_outbox",
    "hubOutbox",
  ];
  for (const n of candidates) {
    const t = db?.[n];
    if (t && typeof t.add === "function" && typeof t.put === "function")
      return t;
  }
  try {
    const tables = db?.tables || [];
    for (const n of candidates) {
      const hit = tables.find((t) => t?.name === n);
      if (hit) return hit;
    }
  } catch {}
  return null;
}

async function writeOutbox(packet, meta = {}) {
  const t = resolveExportsTable();
  if (!t) return { ok: false, reason: "no_table" };

  const row = {
    id: uid("export"),
    createdAt: Date.now(),
    createdISO: nowISO(),
    status: "queued",
    tries: 0,
    packet,
    meta: safeObj(meta),
    source: SOURCE,
  };

  try {
    await (t.add ? t.add(row) : t.put(row));
    return { ok: true, id: row.id };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e || "write_failed") };
  }
}

function ensurePacketShape(packet) {
  const p = safeObj(packet);
  // Minimal envelope – your formatter may add richer schema
  const kind = String(p.kind || p.type || "generic");
  return {
    id: p.id || uid("pkt"),
    kind,
    createdAt: p.createdAt || nowISO(),
    sourceApp: p.sourceApp || "SSA",
    version: p.version || "1",
    payload: p.payload != null ? p.payload : safeObj(p.data),
    meta: safeObj(p.meta),
  };
}

function isFamilyFundEnabled() {
  try {
    return !!(
      featureFlags &&
      (featureFlags.familyFundMode === true ||
        featureFlags.familyFundMode === "true")
    );
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * Connector API
 * -------------------------------------------------------------------------- */

export function setHubConnector(connector) {
  state.connector = connector || null;
  emit("hub.connector.changed", { enabled: !!state.connector });
  return { ok: true, enabled: !!state.connector };
}

export function getHubConnector() {
  return state.connector || FamilyFundConnector || null;
}

/* -----------------------------------------------------------------------------
 * Packet preparation
 * -------------------------------------------------------------------------- */

/**
 * Prepare a packet using HubPacketFormatter if available,
 * otherwise use a minimal envelope.
 *
 * @param {string} kind
 * @param {any} payload
 * @param {object} [options]
 * @returns {object} packet
 */
export function prepareHubPacket(kind, payload, options = {}) {
  const opts = safeObj(options);
  const k = String(kind || "generic");

  // Prefer formatter if present
  if (HubPacketFormatter) {
    try {
      const fn =
        HubPacketFormatter?.formatPacket ||
        HubPacketFormatter?.buildPacket ||
        HubPacketFormatter?.createPacket;
      if (typeof fn === "function") {
        const out = fn.call(HubPacketFormatter, k, payload, opts);
        return ensurePacketShape(out);
      }
      // If formatter is a function
      if (typeof HubPacketFormatter === "function") {
        const out = HubPacketFormatter(k, payload, opts);
        return ensurePacketShape(out);
      }
    } catch (e) {
      try {
        logger?.warn?.(
          "HubPacketFormatter failed; falling back",
          { err: String(e?.message || e) },
          { source: SOURCE }
        );
      } catch {}
    }
  }

  return ensurePacketShape({
    kind: k,
    payload,
    meta: { ...safeObj(opts.meta), preparedBy: "fallback" },
  });
}

/* -----------------------------------------------------------------------------
 * Export
 * -------------------------------------------------------------------------- */

/**
 * Export one packet to the hub.
 *
 * @param {object} packet - packet envelope OR raw payload (will be wrapped if options.wrap===true)
 * @param {object} [options]
 * @param {boolean} [options.wrap=false] - if true, treat "packet" as payload and wrap
 * @param {string}  [options.kind] - used when wrap=true
 * @param {boolean} [options.queueIfOffline=true] - writes to outbox table if no connector or connector fails
 * @param {boolean} [options.emitEvents=true] - emits events for UI/automation runtimes
 * @param {object}  [options.meta] - extra meta for outbox records
 */
export async function exportToHub(packet, options = {}) {
  const opts = safeObj(options);
  const wrap = !!opts.wrap;

  const prepared = wrap
    ? prepareHubPacket(opts.kind || "generic", packet, opts)
    : ensurePacketShape(packet);

  const connector = getHubConnector();

  const ctx = {
    packetId: prepared.id,
    kind: prepared.kind,
    at: nowISO(),
  };

  if (opts.emitEvents !== false) {
    emit("hub.export.requested", { ...ctx, packet: prepared });
  }

  // If connector exists, attempt send
  if (connector && typeof connector.sendPacket === "function") {
    try {
      const res = await connector.sendPacket(prepared, opts);
      const out = {
        ok: true,
        via: "connector",
        result: res ?? null,
        packet: prepared,
        ...ctx,
      };
      state.lastResult = out;

      if (opts.emitEvents !== false) emit("hub.export.succeeded", out);
      return out;
    } catch (e) {
      const reason = String(e?.message || e || "send_failed");
      try {
        logger?.warn?.(
          "exportToHub connector failed",
          { reason, kind: prepared.kind },
          { source: SOURCE }
        );
      } catch {}

      if (opts.queueIfOffline !== false) {
        const q = await writeOutbox(prepared, {
          ...safeObj(opts.meta),
          reason,
          failedVia: "connector",
        });
        const out = {
          ok: false,
          via: "connector",
          reason,
          queued: q.ok,
          outboxId: q.id || null,
          packet: prepared,
          ...ctx,
        };
        state.lastResult = out;

        if (opts.emitEvents !== false) emit("hub.export.failed", out);
        return out;
      }

      const out = {
        ok: false,
        via: "connector",
        reason,
        queued: false,
        packet: prepared,
        ...ctx,
      };
      state.lastResult = out;

      if (opts.emitEvents !== false) emit("hub.export.failed", out);
      return out;
    }
  }

  // No connector: queue/outbox if possible
  if (opts.queueIfOffline !== false) {
    const q = await writeOutbox(prepared, {
      ...safeObj(opts.meta),
      reason: "no_connector",
    });
    const out = {
      ok: q.ok,
      via: "outbox",
      queued: q.ok,
      outboxId: q.id || null,
      reason: q.ok ? null : q.reason,
      packet: prepared,
      ...ctx,
    };
    state.lastResult = out;

    if (opts.emitEvents !== false) {
      emit(q.ok ? "hub.export.queued" : "hub.export.failed", out);
    }
    return out;
  }

  const out = {
    ok: false,
    via: "none",
    reason: "no_connector",
    packet: prepared,
    ...ctx,
  };
  state.lastResult = out;
  if (opts.emitEvents !== false) emit("hub.export.failed", out);
  return out;
}

/**
 * ✅ COMPAT: exportToHubIfEnabled
 * Some modules import:
 *   import { exportToHubIfEnabled } from "@/services/hubExport";
 *
 * Supports signatures:
 *  A) exportToHubIfEnabled(kind, payload, options?)
 *  B) exportToHubIfEnabled(packet, options?)
 *
 * If familyFundMode is OFF, returns a skipped result (no send).
 */
export async function exportToHubIfEnabled(a, b, c) {
  const enabled = isFamilyFundEnabled();

  // Signature A: (kind, payload, options?)
  if (typeof a === "string") {
    const kind = a;
    const payload = b;
    const options = safeObj(c);

    if (!enabled) {
      const out = {
        ok: false,
        skipped: true,
        reason: "familyFundMode=false",
        kind,
        at: nowISO(),
      };
      if (options.emitEvents !== false) emit("hub.export.skipped", out);
      state.lastResult = out;
      return out;
    }

    // wrap payload into a packet + export
    return exportToHub(payload, { ...options, wrap: true, kind });
  }

  // Signature B: (packet, options?)
  const packet = a;
  const options = safeObj(b);

  if (!enabled) {
    const out = {
      ok: false,
      skipped: true,
      reason: "familyFundMode=false",
      kind: String(packet?.kind || packet?.type || "generic"),
      at: nowISO(),
    };
    if (options.emitEvents !== false) emit("hub.export.skipped", out);
    state.lastResult = out;
    return out;
  }

  return exportToHub(packet, options);
}

/**
 * Export many packets (best-effort). Returns per-item results.
 * @param {Array<object>} packets
 * @param {object} [options] - same as exportToHub
 */
export async function exportManyToHub(packets, options = {}) {
  const list = safeArr(packets);
  const opts = safeObj(options);

  const results = [];
  for (const p of list) {
    // eslint-disable-next-line no-await-in-loop
    const res = await exportToHub(p, opts);
    results.push(res);
  }

  const okCount = results.filter((r) => r.ok).length;
  const out = {
    ok: okCount === results.length,
    count: results.length,
    okCount,
    results,
  };

  if (opts.emitEvents !== false) {
    emit("hub.export.batch", { ...out, at: nowISO() });
  }

  return out;
}

/* -----------------------------------------------------------------------------
 * File download helper (browser)
 * -------------------------------------------------------------------------- */

/**
 * Download a JSON file for a packet (manual export).
 * @param {object} packet
 * @param {string} [filename]
 */
export function exportToFile(packet, filename) {
  const p = ensurePacketShape(packet);
  const name =
    filename ||
    `ssa_${String(p.kind || "packet").replace(/[^\w\-]+/g, "_")}_${String(
      p.id
    ).slice(0, 10)}.json`;

  try {
    const json = JSON.stringify(p, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.rel = "noopener";
    a.click();

    setTimeout(() => URL.revokeObjectURL(url), 1500);

    emit("hub.export.fileDownloaded", {
      packetId: p.id,
      kind: p.kind,
      filename: name,
      at: nowISO(),
    });
    return { ok: true, filename: name };
  } catch (e) {
    const reason = clampLen(String(e?.message || e || "download_failed"), 400);
    emit("hub.export.fileFailed", { reason, at: nowISO() });
    return { ok: false, reason };
  }
}

/* -----------------------------------------------------------------------------
 * Status helpers
 * -------------------------------------------------------------------------- */

export function getLastHubExportResult() {
  return state.lastResult;
}

const hubExport = {
  setHubConnector,
  getHubConnector,
  prepareHubPacket,
  exportToHub,
  exportToHubIfEnabled,
  exportManyToHub,
  exportToFile,
  getLastHubExportResult,
};

export default hubExport;

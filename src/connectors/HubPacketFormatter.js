// C:\Users\larho\suka-smart-assistant\src\connectors\HubPacketFormatter.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Hub Packet Formatter
// -----------------------------------------------------------------------------
// PURPOSE
// This module takes *raw* SSA events / objects and turns them into
// **Hub-friendly packets** so the FamilyFundConnector can send them upstream.
//
// SSA → (this file) → FamilyFundConnector → Hub
//
// WHY A SEPARATE FORMATTER?
// - SSA owns its data and its schema. The Hub may evolve separately.
// - Some SSA events are very chatty; the Hub may only want essentials.
// - We want a **stable envelope** so every export has the same top-level shape.
//
// ENVELOPE SHAPE (versioned)
// {
//   "v": "1.0.0",
//   "ts": "2025-11-02T12:00:00.000Z",
//   "source": "ssa",
//   "kind": "inventory.updated",
//   "householdId": "...",          // optional
//   "sessionId": "...",            // optional
//   "data": { ...compact payload... },
//   "meta": { ...extra... }
// }
//
// NOTES
// - We detect the kind from the input whenever possible.
// - We normalize timestamps to ISO.
// - We optionally trim large arrays.
// - We keep extension points for **new domains**: preservation, animal, storehouse.
// - This file itself DOES NOT send anything; FamilyFundConnector does.
// - We keep it defensive: bad input → null.
//
// -----------------------------------------------------------------------------
// ASSUMPTIONS
// - Household / app-level IDs may be stored on window.__suka or feature flags
// - We can add org/community IDs later without changing callers
// -----------------------------------------------------------------------------

import { featureFlags } from "../config/index.js";

const isBrowser = typeof window !== "undefined";

// current packet version
const PACKET_VERSION = "1.0.0";

// default max items to send for noisy events
const MAX_LIST_ITEMS = 50;

/**
 * Get the current household / app / tenant identifiers, if the SSA runtime
 * has them available in the browser.
 */
function getRuntimeIdentity() {
  const base = {
    householdId: null,
    appInstanceId: null,
    organizationId: null,
  };

  if (!isBrowser) return base;

  const suka = window.__suka || {};
  return {
    householdId: suka.householdId || suka.homeId || null,
    appInstanceId: suka.instanceId || null,
    organizationId: suka.orgId || suka.familyFundId || null,
  };
}

/**
 * Ensure we always produce an ISO timestamp
 */
function toIso(ts) {
  if (!ts) return new Date().toISOString();
  if (typeof ts === "string" && ts.includes("T")) return ts;
  return new Date(ts).toISOString();
}

/**
 * Shallow-trim large arrays in common locations to avoid giant payloads
 */
function trimBigArrays(data) {
  if (!data || typeof data !== "object") return data;

  const clone = Array.isArray(data) ? [...data] : { ...data };

  // known noisy keys
  const noisyKeys = ["items", "ingredients", "harvest", "updates", "sessions", "offers"];

  for (const key of noisyKeys) {
    if (Array.isArray(clone[key]) && clone[key].length > MAX_LIST_ITEMS) {
      clone[key] = clone[key].slice(0, MAX_LIST_ITEMS);
      clone[`_${key}Truncated`] = true;
    }
  }

  return clone;
}

/**
 * Try to detect the "kind" of SSA payload.
 * Input can be:
 *  - full SSA event { type, ts, source, data }
 *  - raw business object (inventory update, import, meal, garden)
 */
function detectKind(payload) {
  if (!payload) return "ssa.unknown";

  // SSA-style event
  if (payload.type) return payload.type;

  // raw object: check hints
  if (payload.inventory || payload.items || payload.updates) return "inventory.updated";
  if (payload.ingredients || payload.recipe || payload.steps) return "import.parsed";
  if (payload.harvest) return "garden.harvest.logged";
  if (payload.preservationMethod || payload.method === "can") return "preservation.completed";

  return "ssa.unknown";
}

/**
 * Domain-specific normalizers – this is where we can limit / remap fields
 * so the Hub only gets what it needs.
 */
function normalizeByKind(kind, rawData) {
  const data = trimBigArrays(rawData);

  // recipes / imports
  if (kind === "import.parsed") {
    return {
      id: data.id || data.importId || null,
      kind: data.kind || "recipe",
      title: data.title || null,
      sourceUrl: data.source?.url || data.url || null,
      ingredients: Array.isArray(data.ingredients)
        ? data.ingredients.slice(0, 50).map((ing) => (typeof ing === "string" ? ing : ing.name || ing.label))
        : [],
      domainTags: data.domainTags || data.tags || [],
      missing: data.missingIngredients || [],
    };
  }

  // inventory
  if (kind === "inventory.updated") {
    return {
      items: (data.items || data.updates || []).slice(0, 50).map((it) => ({
        name: it.name || it.item,
        qty: it.qty || it.quantity || it.amount || null,
        unit: it.unit || null,
      })),
      reason: data.reason || "update",
    };
  }

  // inventory shortage
  if (kind === "inventory.shortage.detected") {
    return {
      item: data.item || data.name,
      missingQty: data.missingQty || 1,
      alt: data.substitutions || [],
    };
  }

  // meals
  if (kind === "meal.executed") {
    return {
      mealId: data.id || null,
      title: data.title || data.mealTitle || null,
      ingredients: (data.ingredients || []).map((ing) => (typeof ing === "string" ? ing : ing.name || ing.label)),
      servings: data.servings || null,
    };
  }

  // garden
  if (kind === "garden.harvest.logged") {
    return {
      harvest: (data.harvest || []).map((h) => ({
        crop: h.crop || h.name,
        qty: h.quantity || h.weight || h.qty || 1,
        unit: h.unit || (h.weight ? "lb" : null),
      })),
      zone: data.zone || null,
    };
  }

  // preservation
  if (kind === "preservation.completed") {
    return {
      item: data.item || data.crop || data.ingredient,
      method: data.method || data.preservationMethod || "unknown",
      weightIn: data.weightIn || data.weightBefore || null,
      weightOut: data.weightOut || data.weightAfter || null,
      success: typeof data.success === "boolean" ? data.success : true,
    };
  }

  // storehouse
  if (kind === "storehouse.low" || kind === "storehouse.wants") {
    return {
      items: (data.items || []).map((it) => ({
        name: it.name || it.item,
        qty: it.quantity || null,
        section: it.section || null,
      })),
    };
  }

  // commerce / barter
  if (kind === "commerce.offers.generated") {
    return {
      needs: data.needs || [],
      offers: (data.offers || []).slice(0, 30),
      sourceEvent: data.fromEvent || null,
    };
  }

  if (kind === "commerce.barter.suggested") {
    return {
      needs: data.needs || [],
      localMatches: (data.localMatches || []).slice(0, 30),
      hubMatches: (data.hubMatches || []).slice(0, 30),
    };
  }

  // fallback
  return data;
}

/**
 * Main formatter.
 * @param {Object} payload - SSA-like event or raw data
 * @param {Object} [opts]
 * @param {string} [opts.source="ssa"] - override source
 * @param {string} [opts.reason] - why this is being exported
 * @returns {Object|null} formatted packet
 */
function format(payload, opts = {}) {
  if (!payload) return null;

  const kind = detectKind(payload);
  const ts = toIso(payload.ts || payload.at || Date.now());
  const source = opts.source || payload.source || "ssa";
  const runtimeIds = getRuntimeIdentity();

  // data may be on payload.data (SSA-style) or the payload itself (raw object)
  const rawData = payload.data ? payload.data : payload;

  const normalizedData = normalizeByKind(kind, rawData);

  const packet = {
    v: PACKET_VERSION,
    ts,
    source,
    kind,
    householdId: runtimeIds.householdId || featureFlags?.defaultHouseholdId || null,
    appInstanceId: runtimeIds.appInstanceId || null,
    organizationId: runtimeIds.organizationId || null,
    data: normalizedData,
    meta: {
      ...((payload && payload.meta) || {}),
      reason: opts.reason || (payload && payload.reason) || null,
      // keep original type if we mapped it
      originalType: payload.type || null,
    },
  };

  return packet;
}

/**
 * Convenience helper: wrap multiple events into a batch packet.
 * Hub may choose to unfold it.
 */
function formatBatch(events = [], opts = {}) {
  if (!Array.isArray(events) || !events.length) return null;
  const packets = events
    .map((ev) => format(ev, opts))
    .filter(Boolean);

  return {
    v: PACKET_VERSION,
    ts: toIso(Date.now()),
    source: opts.source || "ssa",
    kind: "ssa.batch",
    householdId: getRuntimeIdentity().householdId || featureFlags?.defaultHouseholdId || null,
    data: packets,
    meta: {
      batchSize: packets.length,
      reason: opts.reason || null,
    },
  };
}

const HubPacketFormatter = {
  format,
  formatBatch,
  PACKET_VERSION,
};

export default HubPacketFormatter;
export {
  format,
  formatBatch,
  PACKET_VERSION,
};

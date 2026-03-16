// C:\Users\larho\suka-smart-assistant\src\commerce\BarterSuggestion.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Barter / Community Exchange Engine
// -----------------------------------------------------------------------------
// PURPOSE
// When SSA detects *need* (inventory short, storehouse low, reverse-generation
// wants an item, or commerce/offers are empty), we should ALSO try to satisfy
// that need **without** cash – via barter, swap, or community exchange.
//
// This file sits right next to CommerceTriggerEngine, but its attitude is:
//   1. Ask Suka Village Family Fund Hub barter board (if familyFundMode=true)
//   2. Ask local / known households (SSA-local barter registry)
//   3. Fall back to "post a request" suggestion
//
// PIPELINE
//   imports → intelligence → automation → commerce triggers
//                  ↘︎ barter/exchange (this file) → (optional) hub export
//
// EVENTS WE LISTEN TO
// - inventory.shortage.detected
// - storehouse.low / storehouse.wants
// - commerce.offers.empty  ← important: barter should kick in when commerce fails
// - reverse-generation.completed (if it proposed “acquire/buy”)
// - optional: preservation.completed (to know what WE can offer as barter)
//
// EVENTS WE EMIT
// - commerce.barter.suggested
// - commerce.barter.recorded
//
// HUB EXPORT
// - If familyFundMode = true, we send **demand** and/or **offer** signals to the
//   hub so hub-side barter/exchange can match it later.
// - SSA still OWNS the data first.
//
// EXTENSION POINTS
// - add more “what can we offer?” sources in buildOfferables()
// - add more “what can we ask for?” sources in buildNeedsFromEvent()
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists
// - src/config/featureFlags.js exists
// - optional hub services exist
// -----------------------------------------------------------------------------

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";

const isBrowser = typeof window !== "undefined";

// soft hub deps – don't crash if missing
let HubPacketFormatter = null;
let FamilyFundConnector = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter.js");
  // eslint-disable-next-line import/no-unresolved, global-require
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector.js");
} catch (_) {
  // optional
}

function nowIso() {
  return new Date().toISOString();
}

function emit(type, data = {}) {
  const evt = { type, ts: nowIso(), source: "commerce:barter", data };
  try {
    eventBus?.emit?.(evt);
  } catch (_) {
    // never crash on analytics
  }
  return evt;
}

async function exportToHubIfEnabled(payload) {
  if (!featureFlags?.familyFundMode) return;
  if (!HubPacketFormatter || !FamilyFundConnector) return;
  try {
    const packet = HubPacketFormatter.format(payload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (_) {
    // silent – barter suggestions must not block
  }
}

function norm(v) {
  return (v || "").toString().trim().toLowerCase();
}

// ----------------------------------------------------------------------------
// local in-memory registry
// (could later be backed by Dexie / server)
// ----------------------------------------------------------------------------
const localBarterRegistry = {
  // items WE have and can offer
  offerables: [
    // filled dynamically from events (harvest, preservation)
    // { name: "canned-tomatoes", qty: 6, domain: "preservation", lastSeen: ISO }
  ],
  // wish list that still needs fulfillment
  pendings: [
    // { needName: "olive oil", qty: 1, domain: "storehouse", askedAt: ISO }
  ],
};

// ----------------------------------------------------------------------------
// building blocks
// ----------------------------------------------------------------------------
function buildNeedsFromEvent(evt = {}) {
  const needs = [];
  const t = evt.type || "";
  const d = evt.data || {};

  // inventory shortage
  if (t === "inventory.shortage.detected") {
    const item = d.item || d.name;
    if (item) {
      needs.push({
        name: item,
        quantity: d.missingQty || 1,
        domain: "inventory",
        reason: "inventory.shortage.detected",
      });
    }
  }

  // storehouse low
  if (t === "storehouse.low" || t === "storehouse.wants") {
    const items = Array.isArray(d.items) ? d.items : d.item ? [d.item] : [];
    for (const it of items) {
      needs.push({
        name: typeof it === "string" ? it : it.item || it.name,
        quantity: typeof it === "object" ? it.quantity || 1 : 1,
        domain: "storehouse",
        reason: "storehouse.low",
      });
    }
  }

  // commerce.offers.empty – copy over the needs from the failed commerce
  if (t === "commerce.offers.empty") {
    const items = Array.isArray(d.needs) ? d.needs : [];
    for (const n of items) {
      needs.push({
        name: n.name,
        quantity: n.quantity || 1,
        domain: n.domain || "mixed",
        reason: "commerce.offers.empty",
      });
    }
  }

  // reverse generation: “acquire” / “buy” → we can barter instead
  if (t === "reverse-generation.completed") {
    const suggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
    for (const s of suggestions) {
      if (/acquire|buy/i.test(s.title || "")) {
        needs.push({
          name: s.payload?.targetItem || s.title,
          quantity: 1,
          domain: s.domain || "mixed",
          reason: "reverse-generation",
        });
      }
    }
  }

  return needs.filter((n) => n && n.name);
}

function buildOfferables(evt = null) {
  // start with local registry
  const offerables = [...localBarterRegistry.offerables];

  // if the current event created NEW goods (harvest / preservation), add them
  if (evt) {
    if (evt.type === "garden.harvest.logged") {
      const harvest = evt.data?.harvest || [];
      for (const h of harvest) {
        offerables.push({
          name: h.crop || h.name,
          qty: h.quantity || h.weight || 1,
          domain: "garden",
          lastSeen: evt.ts || nowIso(),
        });
      }
    }
    if (evt.type === "preservation.completed") {
      const item =
        evt.data?.item ||
        evt.data?.crop ||
        evt.data?.ingredient ||
        "preserved-goods";
      offerables.push({
        name: item,
        qty: evt.data?.weightOut || evt.data?.jars || 1,
        domain: "preservation",
        lastSeen: evt.ts || nowIso(),
      });
    }
  }

  return offerables;
}

// try to match needs to local offerables
function matchLocalBarter(needs = [], offerables = []) {
  const matches = [];

  for (const need of needs) {
    const nName = norm(need.name);
    // find any offerable that is “close enough”
    const candidate = offerables.find((off) => {
      const oName = norm(off.name);
      // exact, or garden item matches food usage
      return oName === nName || oName.includes(nName) || nName.includes(oName);
    });

    if (candidate) {
      matches.push({
        need,
        offer: candidate,
        source: "local",
      });
    }
  }

  return matches;
}

// form hub-friendly suggestions payload
function makeBarterSuggestionPayload({ needs, localMatches, hubMatches, evt }) {
  return {
    kind: "commerce.barter.suggested",
    at: evt?.ts || nowIso(),
    needs,
    localMatches,
    hubMatches,
  };
}

// ----------------------------------------------------------------------------
// main engine
// ----------------------------------------------------------------------------
class BarterSuggestionEngine {
  constructor() {
    this.initialized = false;
  }

  initListener() {
    if (this.initialized) return;
    const bus = eventBus || (isBrowser ? window.__suka?.eventBus : null);
    if (!bus || typeof bus.on !== "function") return;
    this.initialized = true;

    const handler = async (evt) => {
      if (!evt || !evt.type) return;

      const interesting = new Set([
        "inventory.shortage.detected",
        "storehouse.low",
        "storehouse.wants",
        "commerce.offers.empty",
        "reverse-generation.completed",
        "garden.harvest.logged",
        "preservation.completed",
      ]);
      if (!interesting.has(evt.type)) return;

      // 1) build needs (what we want)
      const needs = buildNeedsFromEvent(evt);

      // 2) build offerables (what we can give)
      const offerables = buildOfferables(evt);

      // 3) match locally
      const localMatches = matchLocalBarter(needs, offerables);

      // 4) optionally ask hub for matches
      let hubMatches = [];
      if (featureFlags?.familyFundMode) {
        hubMatches = await this.fetchHubBarterMatches(needs);
      }

      // nothing to suggest?
      if (!needs.length && !localMatches.length && !hubMatches.length) {
        return;
      }

      const payload = makeBarterSuggestionPayload({
        needs,
        localMatches,
        hubMatches,
        evt,
      });

      // emit in-app so UI / automation can show a “Swap instead” panel
      emit("commerce.barter.suggested", payload);

      // forward demand/offer to hub
      await exportToHubIfEnabled(payload);

      // also update our pending list (so next time we can match faster)
      this.rememberPending(needs);
      this.rememberOfferables(offerables);
    };

    bus.on?.(handler);

    this._unsubscribe = () => {
      bus.off?.(handler);
      this.initialized = false;
    };
  }

  // pretend to query hub – in real app, Hub would return real barter ops
  async fetchHubBarterMatches(needs = []) {
    // if we don’t have hub connectors, return empty
    if (!HubPacketFormatter || !FamilyFundConnector) return [];

    // in a real implementation we would send a "lookup" and wait for response
    // here we just build a placeholder response so the UI can show something
    return needs.map((need) => ({
      need: {
        name: need.name,
        quantity: need.quantity || 1,
        domain: need.domain || "mixed",
      },
      offerFrom: "hub:any-household",
      offerItem: `Provide ${need.name} from hub inventory`,
      suggestedTerms: "Swap for recent harvest / preserved goods / labor hour",
    }));
  }

  // store new pendings locally
  rememberPending(needs = []) {
    for (const need of needs) {
      localBarterRegistry.pendings.unshift({
        needName: need.name,
        qty: need.quantity || 1,
        domain: need.domain || "mixed",
        askedAt: nowIso(),
      });
    }
    // cap to 100
    if (localBarterRegistry.pendings.length > 100) {
      localBarterRegistry.pendings.length = 100;
    }
  }

  // store offerables – merge by name
  rememberOfferables(offerables = []) {
    const existing = localBarterRegistry.offerables;
    for (const off of offerables) {
      const idx = existing.findIndex((e) => norm(e.name) === norm(off.name));
      if (idx === -1) {
        existing.unshift(off);
      } else {
        // update qty + lastSeen
        existing[idx].qty = off.qty || existing[idx].qty;
        existing[idx].lastSeen = off.lastSeen || existing[idx].lastSeen;
      }
    }
    if (existing.length > 100) {
      existing.length = 100;
    }
  }

  // allow UI / other code to record an accepted barter
  // if a barter is accepted, that is a household data change → export to hub
  async recordAcceptedBarter({ need, offer, partner, terms }) {
    const payload = {
      kind: "commerce.barter.recorded",
      at: nowIso(),
      need,
      offer,
      partner: partner || "unknown",
      terms: terms || "1:1",
    };

    emit("commerce.barter.recorded", payload);
    await exportToHubIfEnabled(payload);
  }

  // expose a snapshot for dashboards
  getSnapshot() {
    return {
      offerables: [...localBarterRegistry.offerables],
      pendings: [...localBarterRegistry.pendings],
    };
  }
}

// singleton
const barterSuggestionEngine = new BarterSuggestionEngine();
export default barterSuggestionEngine;
export { BarterSuggestionEngine };

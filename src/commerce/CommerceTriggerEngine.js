// C:\Users\larho\suka-smart-assistant\src\commerce\CommerceTriggerEngine.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Commerce Trigger Engine
// -----------------------------------------------------------------------------
// PURPOSE
// When the household engine detects **need** (missing ingredients, inventory
// shortages, storehouse low, reverse-generation wants a crop/animal/tool),
// this engine figures out WHAT to suggest to the user to obtain it.
//
// PIPELINE POSITION
//   imports → normalize → intelligence (tags, graph, linking)
//   → automation (sessions, reverse gen)
//   → **commerce triggers (this file)** → (optional) hub export
//
// GOALS
// - SSA runs by itself: even if the Hub is unreachable, suggestions still work.
// - Prefer Hub / Suka Village Family Fund Hub (SVFFH) businesses FIRST when
//   familyFundMode = true
// - Then fallback to local / configured providers
// - Then fallback to open web / affiliate links
// - Emit events in the standard { type, ts, source, data } shape so your
//   UI / automation runtime can surface the offers
//
// EVENTS WE LISTEN TO
// - inventory.shortage.detected
// - storehouse.low (or storehouse.wants)
// - import.parsed  (if it contains items we don’t have)
// - reverse-generation.completed (if it suggests an item we don’t have)
//
// EVENTS WE EMIT
// - commerce.offers.generated
// - commerce.offers.empty
//
// HUB EXPORT
// - If familyFundMode=true we forward the **demand signal** to the Hub so
//   member businesses can respond with supply.
// - This is “send signal to Hub,” not “Hub owns the data.” SSA keeps ownership.
//
// EXTEND
// - Add new providers in PROVIDER_REGISTRY
// - Add new domain matchers in `buildNeedFromEvent`
// - Add price/quality scoring in `scoreOffers`
//
// ASSUMPTIONS
// - src/services/eventBus.js exists
// - src/config/featureFlags.js exists
// - src/services/hub/HubPacketFormatter.js and src/services/hub/FamilyFundConnector.js exist
// - optional local provider modules can exist in src/commerce/providers/*.js
//
// -----------------------------------------------------------------------------


import eventBus from "@/services/eventBus.js";
import featureFlags from "@/config/featureFlags.js";

const isBrowser = typeof window !== "undefined";

// soft hub deps
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

// soft provider deps – we don’t crash if they don’t exist
let HubBusinessProvider = null;
let LocalBusinessProvider = null;
let ExternalAffiliateProvider = null;
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  HubBusinessProvider = require("@/commerce/providers/HubBusinessProvider.js");
} catch (_) {}
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  LocalBusinessProvider = require("@/commerce/providers/LocalBusinessProvider.js");
} catch (_) {}
try {
  // eslint-disable-next-line import/no-unresolved, global-require
  ExternalAffiliateProvider = require("@/commerce/providers/ExternalAffiliateProvider.js");
} catch (_) {}

function nowIso() {
  return new Date().toISOString();
}

function emit(type, data = {}) {
  const evt = { type, ts: nowIso(), source: "commerce:engine", data };
  try {
    eventBus?.emit?.(evt);
  } catch (_) {
    // never crash
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
    // silent – commerce suggestions must not fail UX
  }
}

function norm(v) {
  return (v || "").toString().trim().toLowerCase();
}

// -----------------------------------------------------------------------------
// provider registry (priority-ordered)
// -----------------------------------------------------------------------------
const PROVIDER_REGISTRY = [
  {
    name: "hub",
    weight: 100,
    enabled: () => !!featureFlags?.familyFundMode && !!HubBusinessProvider,
    fetchOffers: async (needs, ctx) => {
      if (!HubBusinessProvider?.getOffersForNeeds) return [];
      return HubBusinessProvider.getOffersForNeeds(needs, ctx);
    },
  },
  {
    name: "local",
    weight: 80,
    enabled: () => !!LocalBusinessProvider,
    fetchOffers: async (needs, ctx) => {
      if (!LocalBusinessProvider?.getOffersForNeeds) return [];
      return LocalBusinessProvider.getOffersForNeeds(needs, ctx);
    },
  },
  {
    name: "affiliate",
    weight: 50,
    enabled: () => !!ExternalAffiliateProvider,
    fetchOffers: async (needs, ctx) => {
      if (!ExternalAffiliateProvider?.getOffersForNeeds) return [];
      return ExternalAffiliateProvider.getOffersForNeeds(needs, ctx);
    },
  },
];

// -----------------------------------------------------------------------------
// need builder – turn arbitrary SSA events into a standard need[] list
// -----------------------------------------------------------------------------
/**
 * @param {Object} evt - SSA event
 * @returns {Array<{id?:string, name:string, quantity?:number, domain?:string, reason?:string}>}
 */
function buildNeedFromEvent(evt = {}) {
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
    const items = d.items || [d.item].filter(Boolean);
    for (const it of items) {
      needs.push({
        name: it.item || it.name || it,
        quantity: it.quantity || 1,
        domain: "storehouse",
        reason: "storehouse.low",
      });
    }
  }

  // import.parsed – missing ingredients or tools
  if (t === "import.parsed") {
    // if the normalizer told us about missing inventory:
    if (Array.isArray(d.missingIngredients) && d.missingIngredients.length) {
      for (const mi of d.missingIngredients) {
        needs.push({
          name: typeof mi === "string" ? mi : mi.name,
          quantity: (typeof mi === "object" && mi.quantity) || 1,
          domain: d.kind || "recipe",
          reason: "import.missing.ingredients",
        });
      }
    }
    // equipment / tools
    if (Array.isArray(d.requiredEquipment) && d.requiredEquipment.length) {
      for (const eq of d.requiredEquipment) {
        needs.push({
          name: typeof eq === "string" ? eq : eq.name,
          quantity: 1,
          domain: d.kind || "recipe",
          reason: "import.missing.equipment",
        });
      }
    }
  }

  // reverse-generation → if it suggested “acquire/buy” we should commerce it
  if (t === "reverse-generation.completed") {
    const suggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
    for (const s of suggestions) {
      if (s.action === "create-task" && /acquire|buy/i.test(s.title || "")) {
        needs.push({
          name: s.payload?.targetItem || s.title,
          quantity: 1,
          domain: s.domain || "mixed",
          reason: "reverse-generation",
        });
      }
    }
  }

  // future: animal.feed.missing, garden.seed.missing
  return needs.filter((n) => n && n.name);
}

// -----------------------------------------------------------------------------
// offer scoring – push Hub + local to the top
// -----------------------------------------------------------------------------
function scoreOffers(offers = []) {
  // offers shape we target:
  // {
  //   provider: "hub" | "local" | "affiliate",
  //   name: "Lamb Shoulder",
  //   sku: "xyz",
  //   price: 12.5,
  //   unit: "lb",
  //   link: "...",
  //   match: { needName, score },
  // }
  return offers
    .map((o) => {
      let base = 1;
      if (o.provider === "hub") base += 100;
      if (o.provider === "local") base += 50;
      if (typeof o.price === "number") base += 10 / Math.max(o.price, 1);
      if (o.match?.score) base += o.match.score;
      return { ...o, _score: base };
    })
    .sort((a, b) => b._score - a._score);
}

// -----------------------------------------------------------------------------
// main engine class
// -----------------------------------------------------------------------------
class CommerceTriggerEngine {
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

      // only react to a subset
      const interesting = new Set([
        "inventory.shortage.detected",
        "storehouse.low",
        "storehouse.wants",
        "import.parsed",
        "reverse-generation.completed",
      ]);
      if (!interesting.has(evt.type)) return;

      const needs = buildNeedFromEvent(evt);
      if (!needs.length) {
        emit("commerce.offers.empty", {
          fromEvent: evt.type,
        });
        return;
      }

      const offers = await this.fetchOffers(needs, {
        event: evt,
        familyFundMode: !!featureFlags?.familyFundMode,
      });

      if (!offers.length) {
        emit("commerce.offers.empty", {
          fromEvent: evt.type,
          needs,
        });
        // still send demand up if familyFundMode=true, so hub can respond later
        await exportToHubIfEnabled({
          kind: "commerce.demand.signal",
          at: evt.ts || nowIso(),
          needs,
          fromEvent: evt.type,
        });
        return;
      }

      const scored = scoreOffers(offers);

      emit("commerce.offers.generated", {
        fromEvent: evt.type,
        needs,
        offers: scored.map((o) => {
          // hide internal score from general bus
          const { _score, ...rest } = o;
          return rest;
        }),
      });

      // send demand + top offers to hub (optional)
      await exportToHubIfEnabled({
        kind: "commerce.offers.generated",
        at: evt.ts || nowIso(),
        fromEvent: evt.type,
        needs,
        offers: scored.slice(0, 15).map((o) => {
          const { _score, ...rest } = o;
          return rest;
        }),
      });
    };

    bus.on?.(handler);

    // expose unsubscribe in case caller needs it
    this._unsubscribe = () => {
      bus.off?.(handler);
      this.initialized = false;
    };
  }

  async fetchOffers(needs = [], context = {}) {
    if (!Array.isArray(needs) || !needs.length) return [];

    const allOffers = [];

    // go through providers in priority order
    for (const provider of PROVIDER_REGISTRY) {
      if (!provider.enabled()) continue;

      try {
        // provider gets the whole need list at once
        /* eslint-disable no-await-in-loop */
        const offers = await provider.fetchOffers(needs, context);
        if (Array.isArray(offers) && offers.length) {
          // normalize
          for (const off of offers) {
            allOffers.push({
              provider: provider.name,
              ...this._normalizeOffer(off),
            });
          }
        }
        /* eslint-enable no-await-in-loop */
      } catch (err) {
        // provider failed – just move on
        // eslint-disable-next-line no-console
        if (process?.env?.NODE_ENV !== "production") {
          console.warn(`[CommerceTriggerEngine] provider ${provider.name} failed:`, err?.message);
        }
        continue;
      }
    }

    // last resort – suggest “generic / any store” entries
    if (!allOffers.length) {
      for (const need of needs) {
        allOffers.push({
          provider: "generic",
          name: need.name,
          description: "Acquire from any store / co-op / family fund member.",
          link: null,
          price: null,
          unit: null,
          match: {
            needName: need.name,
            score: 5,
          },
        });
      }
    }

    return allOffers;
  }

  _normalizeOffer(offer = {}) {
    // make sure required fields exist
    const name = offer.name || offer.title || "Unnamed item";
    const price = typeof offer.price === "number" ? offer.price : null;
    const link = offer.link || offer.url || null;
    const unit = offer.unit || offer.measure || null;
    const match =
      offer.match ||
      (offer.needName
        ? { needName: offer.needName, score: 10 }
        : { needName: name, score: 5 });

    return {
      name,
      price,
      link,
      unit,
      description: offer.description || "",
      image: offer.image || null,
      sku: offer.sku || null,
      match,
      // carry over any affiliate / tracking
      tracking: offer.tracking || null,
    };
  }
}

// singleton
const commerceTriggerEngine = new CommerceTriggerEngine();
export default commerceTriggerEngine;
export { CommerceTriggerEngine };

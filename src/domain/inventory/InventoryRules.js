// C:\Users\larho\suka-smart-assistant\src\domain\inventory\InventoryRules.js
// Maps imported and locally added ingredients to stored household items
// -----------------------------------------------------------------------------
// WHY THIS FILE
// Your SSA accepts imports from MANY domains, not just recipe:
//   - recipe / meal
//   - cleaning
//   - garden / seed
//   - animal / butchery
//   - storehouse
//   - video / how-to (often has fuzzy names)
//
// All of those can reference *the same* physical item in the household.
// Example:
//   - "all-purpose flour" (recipe)
//   - "All Purpose Flour, unbleached" (site 1)
//   - "flour.ap" (user shorthand)
//   - "flour (wheat)" (storehouse)
// should all map to → inventory item: "Flour — AP" in Pantry.
//
// This module is the “glue” between IMPORT NAMES and INVENTORY KEYS.
//
// HOW IT FITS THE PIPELINE
//  imports → ImportService → (normalized-ish payload)
//    → InventoryRules.mapIngredients(...) ← THIS
//      → we return a list of { original, mappedTo, confidence, substitutions? }
//      → caller then calls InventorySessionEngine.applyDeltas(...) to actually
//        increment/decrement stock
//    → IF we had to AUTO-CREATE a mapping rule or auto-substitute, we emit
//        inventory.rules.updated
//    → IF we created a new inventory item to satisfy the mapping, we also emit
//        inventory.updated and try to export to Hub
//
// IMPORTANT NOTES
// - Forward-thinking: rules can be per-domain and per-source site
// - We support synonyms, normalized keys, and substitutions (e.g. pork→lamb
//   if you already loaded substitutions.torah.json elsewhere)
// - Event-driven: emits { type, ts, source, data } with ISO timestamp
//
// ASSUMPTIONS (soft)
// - src/services/events/eventBus.js
// - src/config/featureFlags.json
// - src/services/hub/HubPacketFormatter.js → formatInventoryRuleForHub
// - src/services/hub/FamilyFundConnector.js
// - src/services/inventory/InventoryRuleStore.js → load/save rules (optional)
// - src/services/inventory/InventoryService.js → create/find items (optional)
// - src/data/yieldCurves/substitutions/*.json may exist elsewhere; we expose a hook
//
// PUBLIC API
//   InventoryRules.loadRules()
//   InventoryRules.mapIngredients(ingredients, ctx)
//   InventoryRules.registerRule(rule)
//   InventoryRules.findMatch(ingredient, ctx)
//   InventoryRules.setExternalSubstitutions(fn)
//
// ctx = {
//   domain: "recipe" | "cleaning" | "garden" | "animal" | "storehouse" | ...,
//   source: "allrecipes.com" | "pinterest" | "local",
//   autoCreate: true | false,
// }
//
// -----------------------------------------------------------------------------

import eventBus from "../../services/events/eventBus";
import featureFlags from "@/config/featureFlags.json";
import { formatInventoryRuleForHub } from "@/services/hub/HubPacketFormatter";
import FamilyFundConnector from "@/services/hub/FamilyFundConnector";

let InventoryRuleStore = null;
let InventoryService = null;

try {
  // eslint-disable-next-line global-require
  InventoryRuleStore = require("../../services/inventory/InventoryRuleStore.js");
} catch (e) {
  InventoryRuleStore = null;
}

try {
  // eslint-disable-next-line global-require
  InventoryService = require("../../services/inventory/InventoryService.js");
} catch (e) {
  InventoryService = null;
}

const SOURCE_ID = "domain.inventory.InventoryRules";

// in-memory cache
let _rules = [];
// optional external substitutions resolver (e.g. your substitutions.torah.json loader)
let _externalSubstitutionResolver = null;

const InventoryRules = {
  /**
   * Load all rules from store (if exists) into memory.
   * Call this once on app boot or when user updates rules.
   */
  async loadRules() {
    if (InventoryRuleStore && typeof InventoryRuleStore.getAll === "function") {
      try {
        _rules = await InventoryRuleStore.getAll();
      } catch (e) {
        console.warn(
          "[InventoryRules] loadRules failed — falling back to empty",
          e
        );
        _rules = [];
      }
    } else {
      _rules = [];
    }
    return _rules;
  },

  /**
   * Register a new rule. Example rule:
   * {
   *   from: "all-purpose flour",
   *   to: "Flour — AP",
   *   location: "Pantry",
   *   category: "dry-goods",
   *   domain: "recipe",
   *   source: "allrecipes.com",
   *   confidence: 1
   * }
   */
  async registerRule(rule) {
    if (!rule || !rule.from || !rule.to) {
      console.warn("[InventoryRules] registerRule: invalid rule");
      return;
    }

    const normalized = {
      id: rule.id || makeId("invRule"),
      from: rule.from,
      fromKey: normalizeName(rule.from),
      to: rule.to,
      toKey: normalizeName(rule.to),
      location: rule.location || "Pantry",
      category: rule.category || "general",
      domain: rule.domain || "any",
      source: rule.source || "any",
      confidence: typeof rule.confidence === "number" ? rule.confidence : 1,
      createdAt: new Date().toISOString(),
    };

    // upsert into mem
    const idx = _rules.findIndex(
      (r) =>
        r.fromKey === normalized.fromKey &&
        r.domain === normalized.domain &&
        r.source === normalized.source
    );
    if (idx >= 0) {
      _rules[idx] = normalized;
    } else {
      _rules.push(normalized);
    }

    // persist
    if (InventoryRuleStore && typeof InventoryRuleStore.upsert === "function") {
      try {
        await InventoryRuleStore.upsert(normalized);
      } catch (e) {
        console.warn("[InventoryRules] registerRule: store upsert failed", e);
      }
    }

    const evt = emitEvent("inventory.rules.updated", { rule: normalized });
    await exportToHubIfEnabled(evt);
  },

  /**
   * Map an array of ingredients/items to inventory items.
   * ingredients can be:
   *  - ["flour", "olive oil"]
   *  - [{ name: "flour", qty: 2, unit: "cup" }, ...]
   *
   * RETURN:
   * [
   *   {
   *     original: "flour",
   *     mappedTo: "Flour — AP",
   *     inventoryKey: "flour — ap|pantry",
   *     confidence: 1,
   *     location: "Pantry",
   *     category: "dry-goods",
   *     created: false
   *   },
   *   ...
   * ]
   */
  async mapIngredients(ingredients, ctx = {}) {
    if (!Array.isArray(ingredients) || !ingredients.length) {
      return [];
    }

    // ensure rules are loaded
    if (!_rules.length) {
      await this.loadRules();
    }

    const results = [];
    for (const ing of ingredients) {
      const res = await this.findMatch(ing, ctx);
      results.push(res);
    }

    // emit mapping performed (does NOT change data by itself)
    emitEvent("inventory.mapping.performed", {
      ctx,
      results,
    });

    return results;
  },

  /**
   * Try to find a match for a single ingredient/item.
   * If not found:
   *  - if ctx.autoCreate → auto create an inventory item and rule
   *  - else → return an unresolved mapping
   */
  async findMatch(ingredient, ctx = {}) {
    const domain = ctx.domain || "any";
    const source = ctx.source || "any";
    const autoCreate = ctx.autoCreate ?? true;

    const name = typeof ingredient === "string" ? ingredient : ingredient?.name;
    if (!name) {
      return {
        original: ingredient,
        mappedTo: null,
        inventoryKey: null,
        confidence: 0,
        unresolved: true,
      };
    }

    const normName = normalizeName(name);

    // 1. try exact domain+source rule
    const direct = _rules.find(
      (r) =>
        r.fromKey === normName &&
        (r.domain === domain || r.domain === "any") &&
        (r.source === source || r.source === "any")
    );
    if (direct) {
      return makeMappingResult(ingredient, direct);
    }

    // 2. try domain-only rule
    const byDomain = _rules.find(
      (r) =>
        r.fromKey === normName && (r.domain === domain || r.domain === "any")
    );
    if (byDomain) {
      return makeMappingResult(ingredient, byDomain);
    }

    // 3. try source-only rule
    const bySource = _rules.find(
      (r) =>
        r.fromKey === normName && (r.source === source || r.source === "any")
    );
    if (bySource) {
      return makeMappingResult(ingredient, bySource);
    }

    // 4. try external substitution resolver (e.g. pork→lamb, wine→grape juice)
    const sub = await runExternalSubstitutionResolver(ingredient, ctx);
    if (sub) {
      // we got back something like { to: "Lamb", reason: "torah-sub", category, location }
      // we can register this as a rule for future
      await this.registerRule({
        from: name,
        to: sub.to,
        category: sub.category,
        location: sub.location,
        domain,
        source,
        confidence: 0.8,
      });
      return {
        original: ingredient,
        mappedTo: sub.to,
        inventoryKey: makeInventoryKey(sub.to, sub.location || "Pantry"),
        confidence: 0.8,
        location: sub.location || "Pantry",
        category: sub.category || "general",
        created: false,
        substitutedFrom: name,
      };
    }

    // 5. no rule found → auto-create if allowed
    if (autoCreate) {
      // create inventory item
      const invName = buildInventoryNameFromIngredient(name);
      const invLocation = guessLocationFromDomain(domain);
      const invCategory = guessCategoryFromDomain(domain);

      await createInventoryItemIfPossible({
        name: invName,
        location: invLocation,
        category: invCategory,
        source: ctx.source || "auto",
      });

      // register rule so next time it's instant
      await this.registerRule({
        from: name,
        to: invName,
        location: invLocation,
        category: invCategory,
        domain,
        source,
        confidence: 0.6,
      });

      return {
        original: ingredient,
        mappedTo: invName,
        inventoryKey: makeInventoryKey(invName, invLocation),
        confidence: 0.6,
        location: invLocation,
        category: invCategory,
        created: true,
      };
    }

    // 6. unresolved but we still return something
    return {
      original: ingredient,
      mappedTo: null,
      inventoryKey: null,
      confidence: 0,
      unresolved: true,
    };
  },

  /**
   * Allow SSA to inject an external substitution function.
   * fn(ingredient, ctx) → { to, category?, location? } | null
   */
  setExternalSubstitutions(fn) {
    _externalSubstitutionResolver = typeof fn === "function" ? fn : null;
  },
};

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

function normalizeName(name) {
  return (name || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[(),]/g, "")
    .replace(/[\u2019']/g, "")
    .trim();
}

function makeInventoryKey(name, location) {
  return `${normalizeName(name)}|${(location || "pantry").toLowerCase()}`;
}

function makeMappingResult(ingredient, rule) {
  const name = typeof ingredient === "string" ? ingredient : ingredient?.name;
  return {
    original: ingredient,
    mappedTo: rule.to,
    inventoryKey: makeInventoryKey(rule.to, rule.location),
    confidence: rule.confidence ?? 1,
    location: rule.location || "Pantry",
    category: rule.category || "general",
    created: false,
    matchedRuleId: rule.id,
  };
}

async function runExternalSubstitutionResolver(ingredient, ctx) {
  if (!_externalSubstitutionResolver) return null;
  try {
    const out = await _externalSubstitutionResolver(ingredient, ctx);
    return out || null;
  } catch (e) {
    console.warn("[InventoryRules] external substitution resolver failed", e);
    return null;
  }
}

async function createInventoryItemIfPossible(item) {
  const payload = {
    id: makeId("inv"),
    name: item.name,
    qty: 0,
    unit: "ea",
    location: item.location || "Pantry",
    category: item.category || "general",
    source: item.source || "auto",
    min: 0,
  };

  // try service first
  if (InventoryService && typeof InventoryService.upsert === "function") {
    try {
      await InventoryService.upsert(payload);
      const evt = emitEvent("inventory.updated", {
        deltas: [
          {
            item: payload.name,
            qty: 0,
            unit: "ea",
            direction: "increment",
            location: payload.location,
            source: "rules.auto-create",
          },
        ],
      });
      await exportToHubIfEnabled(evt);
      return;
    } catch (e) {
      console.warn("[InventoryRules] InventoryService.upsert failed", e);
    }
  }

  // fallback to store
  if (
    InventoryRuleStore &&
    typeof InventoryRuleStore.upsertInventoryItem === "function"
  ) {
    try {
      await InventoryRuleStore.upsertInventoryItem(payload);
      const evt = emitEvent("inventory.updated", {
        deltas: [
          {
            item: payload.name,
            qty: 0,
            unit: "ea",
            direction: "increment",
            location: payload.location,
            source: "rules.auto-create",
          },
        ],
      });
      await exportToHubIfEnabled(evt);
      return;
    } catch (e) {
      console.warn(
        "[InventoryRules] InventoryRuleStore.upsertInventoryItem failed",
        e
      );
    }
  }
  // if neither exists, we just emit and move on
}

function buildInventoryNameFromIngredient(name) {
  // you can make this smarter later (e.g. parse "1 lb ground lamb" → "Lamb — ground")
  // but for now: title-case it
  return toTitleCase(name);
}

function guessLocationFromDomain(domain) {
  if (!domain) return "Pantry";
  if (domain === "animal" || domain === "butchery") return "Freezer";
  if (domain === "garden" || domain === "seed") return "Pantry";
  if (domain === "cleaning") return "Pantry";
  if (domain === "storehouse") return "Storehouse";
  return "Pantry";
}

function guessCategoryFromDomain(domain) {
  if (!domain) return "general";
  if (domain === "animal" || domain === "butchery") return "meat";
  if (domain === "garden" || domain === "seed") return "produce";
  if (domain === "cleaning") return "cleaning";
  if (domain === "storehouse") return "general";
  return "general";
}

function toTitleCase(str) {
  return (str || "")
    .split(" ")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ")
    .trim();
}

// -----------------------------------------------------------------------------
// EVENT / HUB
// -----------------------------------------------------------------------------

function emitEvent(type, data) {
  const payload = {
    type,
    ts: new Date().toISOString(),
    source: SOURCE_ID,
    data,
  };
  if (eventBus && typeof eventBus.emit === "function") {
    eventBus.emit(type, payload);
  } else {
    console.warn("[InventoryRules] eventBus not available for", type);
  }
  return payload;
}

async function exportToHubIfEnabled(evtPayload) {
  try {
    if (!featureFlags?.familyFundMode) return;
    if (!evtPayload) return;
    const packet = formatInventoryRuleForHub(evtPayload);
    if (!packet) return;
    await FamilyFundConnector.send(packet);
  } catch (e) {
    // Hub is optional — fail silently
    console.warn("[InventoryRules] Hub export failed (silent)", e);
  }
}

// -----------------------------------------------------------------------------
// MISC
// -----------------------------------------------------------------------------

function makeId(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export default InventoryRules;

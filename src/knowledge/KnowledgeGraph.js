// C:\Users\larho\suka-smart-assistant\src\knowledge\KnowledgeGraph.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Knowledge Graph Core
// -----------------------------------------------------------------------------
// PURPOSE
// This module is the *intelligence fabric* between the SSA domains.
//
// SSA pipeline recap:
//   import (multi-domain) → normalize → ***knowledge graph*** → automation → (optional) hub export
//
// Every time SSA ingests *anything* (recipe, cleaning routine, garden/seed,
// animal/butchery, storehouse plan, video/how-to), we want to:
//   1. Turn it into *nodes* (entities SSA can reason about)
//   2. Connect it with *edges* (relationships across domains)
//   3. Emit graph events so the automation runtime can suggest sessions
//   4. Optionally export newly-linked household knowledge to the Hub
//
// EXAMPLES
// - Recipe → Ingredients → Inventory Items → Storehouse Goals
// - Garden Seed → Season → Meal/Recipe that uses that crop → Preservation method
// - Animal → Butchery Session → Inventory Cuts → Meals
// - Cleaning Routine → Room/Zone → Inventory (cleaning supplies) → Storehouse
//
// This file is forward-thinking and can be backed by Dexie/DB later; for now it
// keeps an in-memory store with simple APIs.
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists
// - src/config/featureFlags.js exists
// - src/services/hub/HubPacketFormatter.js and src/services/hub/FamilyFundConnector.js exist
//
// NOTE
// - All emitted events follow { type, ts, source, data } with ISO timestamps.
// - Any mutation that affects household data (new inventory link, new storehouse
//   requirement, new session linkage) calls exportToHubIfEnabled(...)
// -----------------------------------------------------------------------------

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";

// soft imports – ok if not present in light builds
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

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function emitEvent(type, source, data = {}) {
  const evt = { type, ts: nowIso(), source, data };
  try {
    eventBus?.emit?.(evt);
  } catch (_) {
    // never break graph insert
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
    // silent – hub is optional
  }
}

// -----------------------------------------------------------------------------
// Node + Edge shapes
// -----------------------------------------------------------------------------
// Node: {
//   id: string,
//   type: 'import'|'recipe'|'ingredient'|'inventory'|'meal'|'garden'|'animal'|'storehouse'|'preservation'|'video'|'tag',
//   label: string,
//   data: {...},
//   createdAt: ISO,
//   updatedAt: ISO,
// }
//
// Edge: {
//   id: string,
//   from: nodeId,
//   to: nodeId,
//   type: 'uses'|'produces'|'supplied-by'|'grows'|'preserves-as'|'fulfills'|'needs'|'variant-of'|'derived-from',
//   meta: {...},
//   createdAt: ISO,
// }
//
// We keep both in memory; in your real app you can swap these with Dexie tables
// (knowledge_nodes, knowledge_edges) and keep the same API below.
// -----------------------------------------------------------------------------

class KnowledgeGraph {
  constructor() {
    // in-memory stores
    this.nodes = new Map(); // id → node
    this.edges = new Map(); // id → edge

    // fast lookup indexes
    this.byType = new Map(); // type → Set(id)
  }

  // ---------------------------------------------------------------------------
  // Public: get singleton-ish instance data (for debug panels)
  // ---------------------------------------------------------------------------
  getAllNodes() {
    return Array.from(this.nodes.values());
  }

  getAllEdges() {
    return Array.from(this.edges.values());
  }

  // ---------------------------------------------------------------------------
  // Node helpers
  // ---------------------------------------------------------------------------
  createNodeId(type, hint) {
    const base = hint
      ? String(hint).toLowerCase().replace(/\s+/g, "-")
      : Math.random().toString(36).slice(2);
    return `${type}:${base}:${Date.now().toString(36)}`;
  }

  upsertNode({ id, type, label, data = {} }) {
    if (!type) {
      throw new Error("KnowledgeGraph.upsertNode: 'type' is required");
    }

    const now = nowIso();
    const nodeId =
      id || this.createNodeId(type, label || data?.name || data?.title);

    const existing = this.nodes.get(nodeId);
    if (existing) {
      const updated = {
        ...existing,
        label: label || existing.label,
        data: { ...existing.data, ...data },
        updatedAt: now,
      };
      this.nodes.set(nodeId, updated);
      emitEvent("knowledge.node.updated", "knowledge:graph", { node: updated });
      return updated;
    }

    const node = {
      id: nodeId,
      type,
      label: label || type,
      data,
      createdAt: now,
      updatedAt: now,
    };
    this.nodes.set(nodeId, node);

    // index by type
    if (!this.byType.has(type)) this.byType.set(type, new Set());
    this.byType.get(type).add(nodeId);

    emitEvent("knowledge.node.created", "knowledge:graph", { node });
    return node;
  }

  // ---------------------------------------------------------------------------
  // Edge helpers
  // ---------------------------------------------------------------------------
  createEdgeId(from, to, type) {
    return `edge:${type}:${from}→${to}:${Date.now().toString(36)}`;
  }

  upsertEdge({ from, to, type, meta = {} }) {
    if (!from || !to || !type) {
      throw new Error(
        "KnowledgeGraph.upsertEdge: 'from', 'to', and 'type' are required"
      );
    }

    // dedupe: check if we already have an edge with same from-to-type
    const existing = Array.from(this.edges.values()).find(
      (e) => e.from === from && e.to === to && e.type === type
    );

    const now = nowIso();

    if (existing) {
      const updated = {
        ...existing,
        meta: { ...existing.meta, ...meta },
        updatedAt: now,
      };
      this.edges.set(existing.id, updated);
      emitEvent("knowledge.edge.updated", "knowledge:graph", { edge: updated });
      return updated;
    }

    const id = this.createEdgeId(from, to, type);
    const edge = {
      id,
      from,
      to,
      type,
      meta,
      createdAt: now,
      updatedAt: now,
    };
    this.edges.set(id, edge);
    emitEvent("knowledge.edge.created", "knowledge:graph", { edge });
    return edge;
  }

  // ---------------------------------------------------------------------------
  // High-level: update graph from an *import-normalized* payload
  // This is called from (for example) ImportService or from the PWA receiver
  // ---------------------------------------------------------------------------
  async upsertFromImport(importPayload = {}) {
    const {
      id,
      kind,
      title,
      url,
      ingredients,
      steps,
      seeds,
      rows,
      animals,
      items,
      updates,
      generated,
      inventory,
      meta,
    } = importPayload;

    // 1. import node
    const importNode = this.upsertNode({
      id: id ? `import:${id}` : undefined,
      type: "import",
      label: title || kind || "import",
      data: {
        kind,
        title,
        url,
        meta,
      },
    });

    // branch by kind
    switch (kind) {
      case "recipe":
        await this._addRecipeImport(importNode, importPayload);
        break;
      case "cleaning":
      case "cleaningPlan":
        await this._addCleaningImport(importNode, importPayload);
        break;
      case "garden":
      case "gardenPlan":
      case "gardenCare":
      case "harvestPlan":
        await this._addGardenImport(importNode, importPayload);
        break;
      case "animal":
      case "animalPlan":
      case "butcherySession":
        await this._addAnimalImport(importNode, importPayload);
        break;
      case "storehouse":
      case "storehouseStock":
      case "storehouseGoal":
        await this._addStorehouseImport(importNode, importPayload);
        break;
      case "video":
        await this._addVideoImport(importNode, importPayload);
        break;
      default:
        // unknown – still keep the import node
        break;
    }

    // handle generic inventory updates (csv/pdf imports)
    if (Array.isArray(updates) && updates.length) {
      const invNode = this.upsertNode({
        type: "inventory",
        label: "Inventory Update",
        data: { updates },
      });
      this.upsertEdge({
        from: importNode.id,
        to: invNode.id,
        type: "updates",
        meta: { source: "import" },
      });
      // household-affecting → hub
      await exportToHubIfEnabled({
        kind: "inventory.updated",
        fromImport: importNode.id,
        updates,
      });
      emitEvent("inventory.updated", "knowledge:graph", { updates });
    }

    // if normalized import had generated sessions (cooking, cleaning, garden…)
    if (generated) {
      const sessionNode = this.upsertNode({
        type: "session",
        label: `${kind || "import"} session`,
        data: generated,
      });
      this.upsertEdge({
        from: importNode.id,
        to: sessionNode.id,
        type: "generates",
      });
      await exportToHubIfEnabled({
        kind: "session.generated",
        fromImport: importNode.id,
        session: generated,
      });
      emitEvent("session.generated", "knowledge:graph", { generated });
    }

    // if import brought inline inventory changes
    if (inventory?.updated) {
      const invNode = this.upsertNode({
        type: "inventory",
        label: "Inventory Change",
        data: inventory.updated,
      });
      this.upsertEdge({
        from: importNode.id,
        to: invNode.id,
        type: "updates",
      });
      await exportToHubIfEnabled({
        kind: "inventory.updated",
        fromImport: importNode.id,
        items: inventory.updated,
      });
      emitEvent("inventory.updated", "knowledge:graph", {
        items: inventory.updated,
      });
    }

    emitEvent("import.parsed", "knowledge:graph", {
      importId: importNode.id,
      kind,
    });

    return importNode;
  }

  // ---------------------------------------------------------------------------
  // Domain-specific insertions
  // ---------------------------------------------------------------------------

  async _addRecipeImport(importNode, payload) {
    const { title, ingredients = [], steps = [], inventory } = payload;

    // recipe node
    const recipeNode = this.upsertNode({
      type: "recipe",
      label: title || "Recipe",
      data: { steps },
    });

    // import → recipe
    this.upsertEdge({
      from: importNode.id,
      to: recipeNode.id,
      type: "derived-from",
      meta: { reason: "import-recipe" },
    });

    // ingredients → inventory
    for (const ing of ingredients) {
      if (!ing) continue;
      const ingNode = this.upsertNode({
        type: "ingredient",
        label: ing.name || ing.label || ing,
        data: typeof ing === "string" ? { name: ing } : ing,
      });

      // recipe uses ingredient
      this.upsertEdge({
        from: recipeNode.id,
        to: ingNode.id,
        type: "uses",
      });

      // link ingredient to inventory if import already mapped it
      if (ing.inventoryId || ing.inventoryMatch) {
        const invNode = this.upsertNode({
          id: ing.inventoryId,
          type: "inventory",
          label: ing.inventoryMatch || ing.inventoryId,
          data: { fromIngredient: ing.name || ing.label || ing },
        });
        this.upsertEdge({
          from: ingNode.id,
          to: invNode.id,
          type: "supplied-by",
        });
      }
    }

    // inline inventory changes (like "reserve for recipe")
    if (inventory?.reserved) {
      const invNode = this.upsertNode({
        type: "inventory",
        label: "Reserved for recipe",
        data: inventory.reserved,
      });
      this.upsertEdge({
        from: recipeNode.id,
        to: invNode.id,
        type: "needs",
      });

      await exportToHubIfEnabled({
        kind: "inventory.updated",
        recipe: recipeNode.id,
        reserved: inventory.reserved,
      });
      emitEvent("inventory.updated", "knowledge:graph", {
        reserved: inventory.reserved,
      });
    }
  }

  async _addCleaningImport(importNode, payload) {
    const { title, tasks = [] } = payload;

    const cleaningNode = this.upsertNode({
      type: "cleaning",
      label: title || "Cleaning Plan",
      data: { tasks },
    });

    this.upsertEdge({
      from: importNode.id,
      to: cleaningNode.id,
      type: "derived-from",
    });

    for (const task of tasks) {
      const taskNode = this.upsertNode({
        type: "task",
        label: task.title || "Cleaning Task",
        data: task,
      });
      this.upsertEdge({
        from: cleaningNode.id,
        to: taskNode.id,
        type: "contains",
      });

      // potential future: link to cleaning supplies inventory
    }
  }

  async _addGardenImport(importNode, payload) {
    const { seeds = [], rows = [], zone, harvest } = payload;

    const gardenNode = this.upsertNode({
      type: "garden",
      label: "Garden Plan",
      data: { zone, rows, harvest },
    });

    this.upsertEdge({
      from: importNode.id,
      to: gardenNode.id,
      type: "derived-from",
    });

    // seeds → possible meals/preservation later
    for (const seed of seeds) {
      const seedNode = this.upsertNode({
        type: "seed",
        label: seed.name || "Seed",
        data: seed,
      });

      this.upsertEdge({
        from: gardenNode.id,
        to: seedNode.id,
        type: "grows",
      });

      // Forward-thinking: connect seed to preservation
      // (tomatoes → can/dehydrate, greens → dehydrate/freeze)
      const preservationType = this._guessPreservation(seed);
      if (preservationType) {
        const presNode = this.upsertNode({
          type: "preservation",
          label: `Preserve: ${preservationType}`,
          data: { method: preservationType, from: seed.name },
        });
        this.upsertEdge({
          from: seedNode.id,
          to: presNode.id,
          type: "preserves-as",
        });
      }
    }

    // rows could link to storehouse if harvest is defined
    if (Array.isArray(harvest) && harvest.length) {
      const storeNode = this.upsertNode({
        type: "storehouse",
        label: "From Harvest",
        data: { harvest },
      });
      this.upsertEdge({
        from: gardenNode.id,
        to: storeNode.id,
        type: "fulfills",
      });

      await exportToHubIfEnabled({
        kind: "garden.harvest.logged",
        fromImport: importNode.id,
        harvest,
      });
      emitEvent("garden.harvest.logged", "knowledge:graph", { harvest });
    }
  }

  async _addAnimalImport(importNode, payload) {
    const { animals = [], reverseFrom, breedsByGeo } = payload;

    const animalPlanNode = this.upsertNode({
      type: "animal",
      label: "Animal Plan",
      data: { animals, reverseFrom, breedsByGeo },
    });

    this.upsertEdge({
      from: importNode.id,
      to: animalPlanNode.id,
      type: "derived-from",
    });

    for (const animal of animals) {
      const animalNode = this.upsertNode({
        type: "animal.unit",
        label: animal.name || animal.species || "Animal",
        data: animal,
      });
      this.upsertEdge({
        from: animalPlanNode.id,
        to: animalNode.id,
        type: "contains",
      });

      // If this is a butchery session, link to inventory cuts
      if (Array.isArray(animal.tasks) && animal.tasks.includes("Package")) {
        const invNode = this.upsertNode({
          type: "inventory",
          label: `Cuts from ${animal.name || animal.species || "animal"}`,
          data: {
            fromAnimal: animal,
          },
        });
        this.upsertEdge({
          from: animalNode.id,
          to: invNode.id,
          type: "produces",
        });

        await exportToHubIfEnabled({
          kind: "inventory.updated",
          fromImport: importNode.id,
          animal: animal,
        });
        emitEvent("inventory.updated", "knowledge:graph", { animal });
      }
    }
  }

  async _addStorehouseImport(importNode, payload) {
    const { items = [], goals } = payload;

    const storeNode = this.upsertNode({
      type: "storehouse",
      label: "Storehouse Plan",
      data: { items, goals },
    });

    this.upsertEdge({
      from: importNode.id,
      to: storeNode.id,
      type: "derived-from",
    });

    // link each item to inventory (execution) layer
    for (const item of items) {
      const invNode = this.upsertNode({
        type: "inventory",
        label: item.item || item.name || "Stock Item",
        data: item,
      });
      this.upsertEdge({
        from: storeNode.id,
        to: invNode.id,
        type: "needs",
      });
    }

    await exportToHubIfEnabled({
      kind: "storehouse.goals.updated",
      fromImport: importNode.id,
      items,
      goals,
    });
    emitEvent("storehouse.goals.updated", "knowledge:graph", { items, goals });
  }

  async _addVideoImport(importNode, payload) {
    const { title, url, text } = payload;

    const videoNode = this.upsertNode({
      type: "video",
      label: title || "How-to Video",
      data: { url, text },
    });

    this.upsertEdge({
      from: importNode.id,
      to: videoNode.id,
      type: "derived-from",
    });

    // Forward-thinking: detect if video is actually for recipe/cleaning/garden
    const guessedDomain = this._guessDomainFromText(
      title || "" + text || "" + url || ""
    );
    if (guessedDomain && guessedDomain !== "video") {
      const tagNode = this.upsertNode({
        type: "tag",
        label: guessedDomain,
      });
      this.upsertEdge({
        from: videoNode.id,
        to: tagNode.id,
        type: "tagged-with",
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Tiny inference helpers
  // ---------------------------------------------------------------------------
  _guessPreservation(seed = {}) {
    const n = (seed.name || seed.variety || "").toLowerCase();
    if (!n) return null;
    if (n.includes("tomato") || n.includes("pepper")) return "can";
    if (n.includes("greens") || n.includes("herb")) return "dehydrate";
    if (n.includes("berry")) return "freeze";
    return null;
  }

  _guessDomainFromText(text = "") {
    const lower = text.toLowerCase();
    if (
      lower.includes("recipe") ||
      lower.includes("cook") ||
      lower.includes("bake")
    )
      return "recipe";
    if (
      lower.includes("clean") ||
      lower.includes("laundry") ||
      lower.includes("declutter")
    )
      return "cleaning";
    if (
      lower.includes("garden") ||
      lower.includes("seed") ||
      lower.includes("harvest")
    )
      return "garden";
    if (
      lower.includes("butcher") ||
      lower.includes("slaughter") ||
      lower.includes("pasture")
    )
      return "animal";
    if (
      lower.includes("storehouse") ||
      lower.includes("pantry") ||
      lower.includes("restock")
    )
      return "storehouse";
    return "video";
  }
}

// export singleton + class (so you can swap implementation in tests)
const knowledgeGraph = new KnowledgeGraph();
export { KnowledgeGraph };
export default knowledgeGraph;

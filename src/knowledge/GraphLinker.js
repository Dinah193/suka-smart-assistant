// C:\Users\larho\suka-smart-assistant\src\knowledge\GraphLinker.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Graph Linker
// -----------------------------------------------------------------------------
// PURPOSE
// This module’s job is to take *already normalized* imports and actually
// **link** them to existing household data: inventory items, storehouse goals,
// meal sessions, garden plans, animal/butchery records, and preservation plans.
// Think of it like the “glue” layer that sits right after:
//
//   imports → normalize → (KnowledgeGraph makes nodes) → **GraphLinker links to
//   what the household already has** → automation → (optional) Hub export
//
// WHY ANOTHER FILE?
// - KnowledgeGraph.js is responsible for *capturing* knowledge (nodes/edges).
// - GraphLinker.js is responsible for *finding matches* in the current household
//   state and *creating* edges between the new nodes and existing nodes.
// - This separation lets you plug in smarter matchers later (fuzzy text,
//   SKU-based matching, AI-assisted matching, user-confirmed linking).
//
// KEY REQUIREMENTS (from prompt)
// - Forward-thinking for new domains (preservation, animal, storehouse)
// - Event-driven (emit { type, ts, source, data })
// - SSA-first, Hub is optional via featureFlags.familyFundMode
// - Defensive: return early; do not crash UI or runtime
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists
// - src/config/featureFlags.js exists
// - src/services/hub/HubPacketFormatter.js + src/services/hub/FamilyFundConnector.js exist
// - src/knowledge/KnowledgeGraph.js exists and can be used to upsert nodes/edges
//
// HOW TO USE
//   import graphLinker from "@/knowledge/GraphLinker";
//   await graphLinker.linkImportToHousehold(normalizedImport, {
//     inventory: currentInventoryArray,
//     storehouse: currentStorehouseGoals,
//     meals: currentMealPlans,
//     garden: currentGardenPlans,
//     animals: currentAnimalPlans,
//   });
//
// The more you pass in `currentState`, the richer the links.
//
// -----------------------------------------------------------------------------

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";
import knowledgeGraph from "@/knowledge/KnowledgeGraph.js";

// soft imports – these can be absent in light builds
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
    // never break linker
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

// basic, case-insensitive name matcher
function namesMatch(a = "", b = "") {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// fuzzy-ish contains matcher
function nameContains(a = "", b = "") {
  if (!a || !b) return false;
  return (
    a.toLowerCase().includes(b.toLowerCase()) ||
    b.toLowerCase().includes(a.toLowerCase())
  );
}

// find inventory item by name/alias/category
function findInventoryMatch(ing, inventory = []) {
  if (!ing) return null;
  const name = typeof ing === "string" ? ing : ing.name || ing.label || "";
  if (!name) return null;

  // 1) exact
  let match = inventory.find((inv) => namesMatch(inv.name, name));
  if (match) return match;

  // 2) contains
  match = inventory.find((inv) => nameContains(inv.name, name));
  if (match) return match;

  // 3) try alt names
  match = inventory.find(
    (inv) =>
      Array.isArray(inv.aliases) &&
      inv.aliases.some((al) => namesMatch(al, name))
  );
  if (match) return match;

  return null;
}

// storehouse goal match
function findStorehouseGoalMatch(item, storehouse = []) {
  if (!item) return null;
  const name = item.item || item.name || item.label || "";
  if (!name) return null;

  const goal = storehouse.find(
    (g) => namesMatch(g.item, name) || nameContains(g.item, name)
  );
  return goal || null;
}

// -----------------------------------------------------------------------------
// GraphLinker
// -----------------------------------------------------------------------------
class GraphLinker {
  /**
   * Link an already-normalized import to existing household data.
   * @param {Object} normalizedImport - normalized import from ImportService / PWA
   * @param {Object} currentState - { inventory, storehouse, meals, garden, animals }
   */
  async linkImportToHousehold(normalizedImport = {}, currentState = {}) {
    if (!normalizedImport || typeof normalizedImport !== "object") {
      emitEvent("knowledge.linker.skipped", "knowledge:linker", {
        reason: "no import",
      });
      return { linked: false, edges: [], notes: ["No import provided."] };
    }

    // first make sure it exists in the KG
    const importNode = await knowledgeGraph.upsertFromImport(normalizedImport);

    const kind =
      normalizedImport.kind || normalizedImport.__importType || "unknown";

    const edges = [];
    const notes = [];

    // branch by domain
    switch (kind) {
      case "recipe":
        {
          const res = await this._linkRecipe(
            normalizedImport,
            currentState,
            importNode
          );
          edges.push(...res.edges);
          notes.push(...res.notes);
        }
        break;

      case "cleaning":
      case "cleaningPlan":
        {
          const res = await this._linkCleaning(
            normalizedImport,
            currentState,
            importNode
          );
          edges.push(...res.edges);
          notes.push(...res.notes);
        }
        break;

      case "garden":
      case "gardenPlan":
      case "gardenCare":
      case "harvestPlan":
        {
          const res = await this._linkGarden(
            normalizedImport,
            currentState,
            importNode
          );
          edges.push(...res.edges);
          notes.push(...res.notes);
        }
        break;

      case "animal":
      case "animalPlan":
      case "butcherySession":
        {
          const res = await this._linkAnimal(
            normalizedImport,
            currentState,
            importNode
          );
          edges.push(...res.edges);
          notes.push(...res.notes);
        }
        break;

      case "storehouse":
      case "storehouseStock":
      case "storehouseGoal":
        {
          const res = await this._linkStorehouse(
            normalizedImport,
            currentState,
            importNode
          );
          edges.push(...res.edges);
          notes.push(...res.notes);
        }
        break;

      case "video":
        {
          const res = await this._linkVideo(
            normalizedImport,
            currentState,
            importNode
          );
          edges.push(...res.edges);
          notes.push(...res.notes);
        }
        break;

      default:
        notes.push(`No linker strategy for kind "${kind}".`);
        break;
    }

    // emit that linking is done
    emitEvent("knowledge.linker.completed", "knowledge:linker", {
      importId: importNode.id,
      kind,
      edges: edges.map((e) => e.id),
      notes,
    });

    return {
      linked: edges.length > 0,
      edges,
      notes,
    };
  }

  // ---------------------------------------------------------------------------
  // RECIPE LINKING
  // ---------------------------------------------------------------------------
  async _linkRecipe(imported, currentState, importNode) {
    const edges = [];
    const notes = [];

    const ingredients = imported.ingredients || [];
    const inventory = currentState.inventory || [];
    const storehouse = currentState.storehouse || [];
    const meals = currentState.meals || [];

    // find the recipe node we just created in KG
    const recipeNode = this._findLatestNodeByType("recipe");
    if (!recipeNode) {
      notes.push("No recipe node found to link.");
      return { edges, notes };
    }

    // 1. link ingredients → inventory
    for (const ing of ingredients) {
      const match = findInventoryMatch(ing, inventory);
      if (match) {
        // ensure inventory node exists
        const invNode = knowledgeGraph.upsertNode({
          id: match.id ? `inventory:${match.id}` : undefined,
          type: "inventory",
          label: match.name || "Inventory Item",
          data: match,
        });

        const edge = knowledgeGraph.upsertEdge({
          from: recipeNode.id,
          to: invNode.id,
          type: "supplied-by",
          meta: { confidence: "high", from: "linker.recipe.inventory" },
        });
        edges.push(edge);

        // if inventory says "low" or "0", emit shortage
        if (match.quantity <= 0 || match.status === "low") {
          emitEvent("inventory.shortage.detected", "knowledge:linker", {
            ingredient: ing,
            inventoryItem: match,
            recipeId: recipeNode.id,
          });
        }
      } else {
        // no inventory match – check storehouse goals (maybe we need to stock)
        const goal = findStorehouseGoalMatch(ing, storehouse);
        if (goal) {
          const storeNode = knowledgeGraph.upsertNode({
            type: "storehouse",
            label: goal.item || "Storehouse Goal",
            data: goal,
          });
          const edge = knowledgeGraph.upsertEdge({
            from: recipeNode.id,
            to: storeNode.id,
            type: "needs",
            meta: { confidence: "medium", from: "linker.recipe.storehouse" },
          });
          edges.push(edge);
        } else {
          notes.push(
            `No inventory/storehouse match for ingredient "${ing.name || ing}"`
          );
        }
      }
    }

    // 2. link recipe → existing meal plan if titles match
    for (const meal of meals) {
      if (!meal || !meal.title) continue;
      if (
        imported.title &&
        (namesMatch(imported.title, meal.title) ||
          nameContains(imported.title, meal.title))
      ) {
        const mealNode = knowledgeGraph.upsertNode({
          id: meal.id ? `meal:${meal.id}` : undefined,
          type: "meal",
          label: meal.title,
          data: meal,
        });
        const edge = knowledgeGraph.upsertEdge({
          from: recipeNode.id,
          to: mealNode.id,
          type: "variant-of",
          meta: { from: "linker.recipe.meal" },
        });
        edges.push(edge);
      }
    }

    if (edges.length) {
      await exportToHubIfEnabled({
        kind: "recipe.linked",
        recipeId: recipeNode.id,
        edges: edges.map((e) => ({ id: e.id, type: e.type })),
      });
    }

    return { edges, notes };
  }

  // ---------------------------------------------------------------------------
  // CLEANING LINKING
  // ---------------------------------------------------------------------------
  async _linkCleaning(imported, currentState, importNode) {
    const edges = [];
    const notes = [];

    const tasks = imported.tasks || [];
    const inventory = currentState.inventory || [];

    const cleaningNode = this._findLatestNodeByType("cleaning");
    if (!cleaningNode) {
      notes.push("No cleaning node found to link.");
      return { edges, notes };
    }

    // try to link cleaning tasks to cleaning supplies in inventory
    for (const task of tasks) {
      const title = task.title || "";
      const supplyMatch = inventory.find((inv) => {
        const lowerName = (inv.name || "").toLowerCase();
        return (
          lowerName.includes("cleaner") ||
          lowerName.includes("soap") ||
          lowerName.includes("bleach") ||
          lowerName.includes("detergent")
        );
      });

      if (supplyMatch) {
        const invNode = knowledgeGraph.upsertNode({
          id: supplyMatch.id ? `inventory:${supplyMatch.id}` : undefined,
          type: "inventory",
          label: supplyMatch.name || "Cleaning Supply",
          data: supplyMatch,
        });
        const edge = knowledgeGraph.upsertEdge({
          from: cleaningNode.id,
          to: invNode.id,
          type: "needs",
          meta: { task: title, from: "linker.cleaning.inventory" },
        });
        edges.push(edge);
      }
    }

    if (edges.length) {
      await exportToHubIfEnabled({
        kind: "cleaning.linked",
        cleaningId: cleaningNode.id,
        edges: edges.map((e) => ({ id: e.id, type: e.type })),
      });
    }

    return { edges, notes };
  }

  // ---------------------------------------------------------------------------
  // GARDEN LINKING
  // ---------------------------------------------------------------------------
  async _linkGarden(imported, currentState, importNode) {
    const edges = [];
    const notes = [];

    const gardenNode = this._findLatestNodeByType("garden");
    if (!gardenNode) {
      notes.push("No garden node found to link.");
      return { edges, notes };
    }

    const seeds = imported.seeds || [];
    const storehouse = currentState.storehouse || [];
    const meals = currentState.meals || [];

    // link each seed to any meal/storehouse item that uses that crop
    for (const seed of seeds) {
      const seedNode = knowledgeGraph.upsertNode({
        type: "seed",
        label: seed.name || "Seed",
        data: seed,
      });

      // garden → seed (graph already does, but double-link is ok)
      const edge1 = knowledgeGraph.upsertEdge({
        from: gardenNode.id,
        to: seedNode.id,
        type: "grows",
      });
      edges.push(edge1);

      // storehouse links
      for (const goal of storehouse) {
        if (nameContains(goal.item, seed.name)) {
          const storeNode = knowledgeGraph.upsertNode({
            type: "storehouse",
            label: goal.item,
            data: goal,
          });
          const edge2 = knowledgeGraph.upsertEdge({
            from: seedNode.id,
            to: storeNode.id,
            type: "fulfills",
            meta: { from: "linker.garden.storehouse" },
          });
          edges.push(edge2);
        }
      }

      // meal links (e.g., seed "tomato" → meal that uses tomato)
      for (const meal of meals) {
        if (!meal || !Array.isArray(meal.recipes)) continue;
        const hasCrop = meal.recipes.some((r) =>
          nameContains(r.title || "", seed.name || "")
        );
        if (hasCrop) {
          const mealNode = knowledgeGraph.upsertNode({
            id: meal.id ? `meal:${meal.id}` : undefined,
            type: "meal",
            label: meal.title || "Meal",
            data: meal,
          });
          const edge3 = knowledgeGraph.upsertEdge({
            from: seedNode.id,
            to: mealNode.id,
            type: "feeds",
            meta: { from: "linker.garden.meal" },
          });
          edges.push(edge3);
        }
      }
    }

    if (edges.length) {
      await exportToHubIfEnabled({
        kind: "garden.linked",
        gardenId: gardenNode.id,
        edges: edges.map((e) => ({ id: e.id, type: e.type })),
      });
    }

    return { edges, notes };
  }

  // ---------------------------------------------------------------------------
  // ANIMAL LINKING
  // ---------------------------------------------------------------------------
  async _linkAnimal(imported, currentState, importNode) {
    const edges = [];
    const notes = [];

    const animalPlanNode = this._findLatestNodeByType("animal");
    if (!animalPlanNode) {
      notes.push("No animal plan node found to link.");
      return { edges, notes };
    }

    const meals = currentState.meals || [];
    const storehouse = currentState.storehouse || [];

    // link animal cuts to meals that use those proteins
    if (Array.isArray(imported.animals)) {
      for (const animal of imported.animals) {
        const species = (animal.species || animal.name || "").toLowerCase();
        if (!species) continue;

        // meals containing same protein
        for (const meal of meals) {
          if (!meal || !Array.isArray(meal.recipes)) continue;
          const usesProtein = meal.recipes.some((r) => {
            const t = (r.title || "").toLowerCase();
            return (
              t.includes(species) ||
              t.includes("lamb") ||
              t.includes("goat") ||
              t.includes("beef")
            );
          });
          if (usesProtein) {
            const mealNode = knowledgeGraph.upsertNode({
              id: meal.id ? `meal:${meal.id}` : undefined,
              type: "meal",
              label: meal.title,
              data: meal,
            });
            const edge = knowledgeGraph.upsertEdge({
              from: animalPlanNode.id,
              to: mealNode.id,
              type: "supplies",
              meta: { from: "linker.animal.meal" },
            });
            edges.push(edge);
          }
        }

        // storehouse goals (frozen/butcher)
        for (const goal of storehouse) {
          const lower = (goal.item || "").toLowerCase();
          if (
            lower.includes(species) ||
            (species === "sheep" && lower.includes("lamb")) ||
            (species === "goat" && lower.includes("chevon"))
          ) {
            const storeNode = knowledgeGraph.upsertNode({
              type: "storehouse",
              label: goal.item,
              data: goal,
            });
            const edge = knowledgeGraph.upsertEdge({
              from: animalPlanNode.id,
              to: storeNode.id,
              type: "fulfills",
              meta: { from: "linker.animal.storehouse" },
            });
            edges.push(edge);
          }
        }
      }
    }

    if (edges.length) {
      await exportToHubIfEnabled({
        kind: "animal.linked",
        animalPlanId: animalPlanNode.id,
        edges: edges.map((e) => ({ id: e.id, type: e.type })),
      });
    }

    return { edges, notes };
  }

  // ---------------------------------------------------------------------------
  // STOREHOUSE LINKING
  // ---------------------------------------------------------------------------
  async _linkStorehouse(imported, currentState, importNode) {
    const edges = [];
    const notes = [];

    const storeNode = this._findLatestNodeByType("storehouse");
    if (!storeNode) {
      notes.push("No storehouse node found to link.");
      return { edges, notes };
    }

    const inventory = currentState.inventory || [];

    // link each storehouse item to inventory (execution layer)
    for (const item of imported.items || []) {
      const match = findInventoryMatch(item, inventory);
      if (match) {
        const invNode = knowledgeGraph.upsertNode({
          id: match.id ? `inventory:${match.id}` : undefined,
          type: "inventory",
          label: match.name,
          data: match,
        });
        const edge = knowledgeGraph.upsertEdge({
          from: storeNode.id,
          to: invNode.id,
          type: "needs",
          meta: { from: "linker.storehouse.inventory" },
        });
        edges.push(edge);

        // shortage detection
        if (match.quantity <= 0 || match.status === "low") {
          emitEvent("inventory.shortage.detected", "knowledge:linker", {
            storehouseItem: item,
            inventoryItem: match,
          });
        }
      } else {
        notes.push(
          `Storehouse item "${item.item || item.name}" has no inventory match.`
        );
      }
    }

    if (edges.length) {
      await exportToHubIfEnabled({
        kind: "storehouse.linked",
        storehouseId: storeNode.id,
        edges: edges.map((e) => ({ id: e.id, type: e.type })),
      });
    }

    return { edges, notes };
  }

  // ---------------------------------------------------------------------------
  // VIDEO LINKING
  // ---------------------------------------------------------------------------
  async _linkVideo(imported, currentState, importNode) {
    const edges = [];
    const notes = [];

    const videoNode = this._findLatestNodeByType("video");
    if (!videoNode) {
      notes.push("No video node found to link.");
      return { edges, notes };
    }

    const title = imported.title || "";
    const lower = title.toLowerCase();

    // if video looks like “how to can tomatoes” → link to preservation
    if (
      lower.includes("dehydrate") ||
      lower.includes("can ") ||
      lower.includes("canning") ||
      lower.includes("freeze")
    ) {
      const presNode = knowledgeGraph.upsertNode({
        type: "preservation",
        label: "Preservation (from video)",
        data: { from: imported.url || imported.title },
      });
      const edge = knowledgeGraph.upsertEdge({
        from: videoNode.id,
        to: presNode.id,
        type: "teaches",
        meta: { from: "linker.video.preservation" },
      });
      edges.push(edge);

      await exportToHubIfEnabled({
        kind: "preservation.completed",
        source: "video.linker",
        video: imported,
      });
      emitEvent("preservation.completed", "knowledge:linker", {
        video: imported,
      });
    }

    return { edges, notes };
  }

  // ---------------------------------------------------------------------------
  // Utility: get latest node of a type from knowledgeGraph
  // ---------------------------------------------------------------------------
  _findLatestNodeByType(type) {
    const all = knowledgeGraph.getAllNodes();
    const filtered = all.filter((n) => n.type === type);
    if (!filtered.length) return null;
    // return the newest one (by createdAt)
    return filtered.reduce((acc, cur) => {
      if (!acc) return cur;
      return acc.createdAt > cur.createdAt ? acc : cur;
    }, null);
  }
}

// singleton
const graphLinker = new GraphLinker();
export { GraphLinker };
export default graphLinker;

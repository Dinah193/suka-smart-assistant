// C:\Users\larho\suka-smart-assistant\src\knowledge\ReverseGeneration.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Reverse Generation Engine
// -----------------------------------------------------------------------------
// PURPOSE
// This module does the *reverse* of the normal SSA flow.
//
// Normal flow:
//   imports → normalize → knowledge graph → automation → (optional) hub
//
// Reverse flow (this file):
//   current household state (inventory / storehouse gaps / garden / animals)
//   → figure out what we *could* cook / plant / preserve / breed
//   → emit actionable suggestions
//   → optionally export those suggestions to the Hub
//
// WHY?
// Your SSA must be able to say:
//
//  - “You have lamb, bulgur, and tomatoes → here are 3 meal sessions”
//  - “Your storehouse says you’re low on dry beans → grow these 3 crops this cycle”
//  - “Your recipes often call for goat → acquire/breed 1–2 goats next cycle”
//  - “You have harvest coming up → here are preservation sessions to schedule”
//
// This file sits **after** KnowledgeGraph + GraphLinker and **before** the
// automation runtime. Think of it as “Next-best-action generator” powered by
// what you *already* have.
//
// REQUIREMENTS FULFILLED
// - Multi-domain (recipe/cooking, garden/seed, animal/butchery, storehouse, preservation)
// - Event-driven → emits { type, ts, source, data }
// - SSA-first, Hub optional via exportToHubIfEnabled(...)
// - Forward-thinking → add new suggestion strategies easily
// - Defensive → returns early if data is missing
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists
// - src/config/featureFlags.js exists
// - src/services/hub/HubPacketFormatter.js & src/services/hub/FamilyFundConnector.js exist
// - src/knowledge/KnowledgeGraph.js exists (we query it when helpful)
//
// -----------------------------------------------------------------------------

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";
import knowledgeGraph from "@/knowledge/KnowledgeGraph.js";

// soft Hub imports (optional)
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
    // best-effort
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
    // silent
  }
}

function normStr(v) {
  return (v || "").toString().trim().toLowerCase();
}

function oneOf(str, arr = []) {
  const s = normStr(str);
  return arr.some((a) => s.includes(normStr(a)));
}

// -----------------------------------------------------------------------------
// ReverseGeneration engine
// -----------------------------------------------------------------------------
class ReverseGeneration {
  /**
   * Main orchestrator – run all reverse-generation strategies.
   * @param {Object} ctx - current household state:
   *   {
   *     inventory: [],
   *     storehouse: [],
   *     garden: [],
   *     animals: [],
   *     recipes: [],
   *     preservation: []
   *   }
   */
  async runAll(ctx = {}) {
    const suggestions = [];

    const fromInv = this.suggestFromInventory(ctx);
    if (fromInv.length) suggestions.push(...fromInv);

    const fromStorehouse = this.suggestFromStorehouseGaps(ctx);
    if (fromStorehouse.length) suggestions.push(...fromStorehouse);

    const fromGarden = this.suggestFromGarden(ctx);
    if (fromGarden.length) suggestions.push(...fromGarden);

    const fromAnimals = this.suggestFromAnimals(ctx);
    if (fromAnimals.length) suggestions.push(...fromAnimals);

    const fromPreserve = this.suggestPreservation(ctx);
    if (fromPreserve.length) suggestions.push(...fromPreserve);

    // emit
    emitEvent("reverse-generation.completed", "knowledge:reverse", {
      count: suggestions.length,
      suggestions,
    });

    // export if we actually created actionable sessions
    if (suggestions.some((s) => s.action === "schedule-session")) {
      await exportToHubIfEnabled({
        kind: "reverse.suggestions",
        at: nowIso(),
        suggestions,
      });
    }

    return suggestions;
  }

  // ---------------------------------------------------------------------------
  // 1. INVENTORY → RECIPE / MEAL
  // ---------------------------------------------------------------------------
  /**
   * Suggest meals/recipes based on what we *do* have.
   * Strategy:
   *  - look at inventory items with good quantity
   *  - look at knowledgeGraph for recipes that “use” those ingredients
   *  - create meal session suggestions
   */
  suggestFromInventory(ctx = {}) {
    const inv = Array.isArray(ctx.inventory) ? ctx.inventory : [];
    if (!inv.length) {
      return [];
    }

    // get all graph nodes to see what recipes we have indexed
    const nodes = knowledgeGraph.getAllNodes();
    const recipeNodes = nodes.filter((n) => n.type === "recipe");
    if (!recipeNodes.length) {
      return [];
    }

    const suggestions = [];

    // we’ll look for recipes where at least 1 ingredient is in inventory
    for (const recipe of recipeNodes) {
      const neededIngredients = this._extractRecipeIngredients(recipe);
      const haveAny = neededIngredients.some((ing) =>
        this._inventoryHas(inv, ing)
      );

      if (!haveAny) continue;

      suggestions.push({
        id: `sugg:meal:${recipe.id}:${Date.now().toString(36)}`,
        source: "reverse:inventory",
        action: "schedule-session",
        domain: "cooking",
        title: `Cook: ${recipe.label || "Recipe"}`,
        payload: {
          recipeId: recipe.id,
          recipeTitle: recipe.label,
          ingredients: neededIngredients,
        },
        rationale: "Inventory contains at least one required ingredient.",
      });
    }

    if (suggestions.length) {
      emitEvent("reverse-generation.recipes.suggested", "knowledge:reverse", {
        count: suggestions.length,
      });
    }

    return suggestions;
  }

  _inventoryHas(inventory, ing) {
    const name = normStr(typeof ing === "string" ? ing : ing.name || ing.label);
    if (!name) return false;
    const match = inventory.find((item) => {
      const nm = normStr(item.name);
      if (!nm) return false;
      // preferable: item.quantity > 0, but some users don't track qty
      return nm === name || nm.includes(name) || name.includes(nm);
    });
    if (!match) return false;
    if (typeof match.quantity === "number") {
      return match.quantity > 0;
    }
    return true; // if no qty, assume yes
  }

  _extractRecipeIngredients(recipeNode) {
    if (!recipeNode?.data) return [];
    // we kept steps in data, but ingredients might be on data or separate
    const data = recipeNode.data;
    if (Array.isArray(data.ingredients)) return data.ingredients;
    if (Array.isArray(data.ings)) return data.ings;
    return [];
  }

  // ---------------------------------------------------------------------------
  // 2. STOREHOUSE GAPS → WHAT TO GROW / WHAT TO BUY / WHAT TO COOK
  // ---------------------------------------------------------------------------
  /**
   * If storehouse says we’re low on something, suggest:
   *  - grow it (if it’s a crop)
   *  - acquire/buy it (if it’s not a crop)
   *  - cook something else that uses what we do have
   */
  suggestFromStorehouseGaps(ctx = {}) {
    const storehouse = Array.isArray(ctx.storehouse) ? ctx.storehouse : [];
    if (!storehouse.length) return [];

    const suggestions = [];
    const nodes = knowledgeGraph.getAllNodes();
    const gardenNodes = nodes.filter(
      (n) => n.type === "garden" || n.type === "seed"
    );

    for (const goal of storehouse) {
      // detect low / needs
      if (goal.status === "ok" || goal.status === "full") continue;

      const itemName = goal.item || goal.name || "";
      if (!itemName) continue;

      // can we grow this?
      const canGrow = gardenNodes.some((g) =>
        oneOf(itemName, [g.label, g.data?.name, g.data?.variety])
      );

      if (canGrow) {
        suggestions.push({
          id: `sugg:grow:${itemName}:${Date.now().toString(36)}`,
          source: "reverse:storehouse",
          action: "schedule-session",
          domain: "garden",
          title: `Plant to replenish: ${itemName}`,
          payload: {
            targetItem: itemName,
            reason: "storehouse.low",
          },
          rationale: "Storehouse is low; garden has matching or similar crop.",
        });
      } else {
        // can't grow → suggest buy/acquire
        suggestions.push({
          id: `sugg:acquire:${itemName}:${Date.now().toString(36)}`,
          source: "reverse:storehouse",
          action: "create-task",
          domain: "inventory",
          title: `Acquire / buy: ${itemName}`,
          payload: {
            targetItem: itemName,
            reason: "storehouse.low",
          },
          rationale: "Storehouse is low; no matching crop found.",
        });
      }
    }

    if (suggestions.length) {
      emitEvent(
        "reverse-generation.storehouse.suggested",
        "knowledge:reverse",
        {
          count: suggestions.length,
        }
      );
    }

    return suggestions;
  }

  // ---------------------------------------------------------------------------
  // 3. GARDEN → WHAT MEALS / PRESERVATION TO PLAN
  // ---------------------------------------------------------------------------
  /**
   * If garden says we have crops / harvest → suggest meals and preservation.
   */
  suggestFromGarden(ctx = {}) {
    const garden = Array.isArray(ctx.garden) ? ctx.garden : [];
    if (!garden.length) return [];

    const suggestions = [];
    const nodes = knowledgeGraph.getAllNodes();
    const recipeNodes = nodes.filter((n) => n.type === "recipe");

    for (const plot of garden) {
      const crops = plot.crops || plot.seeds || [];
      for (const crop of crops) {
        const cropName = crop.name || crop.crop || crop.variety || "";
        if (!cropName) continue;

        // meals that could use this crop
        const matchingRecipes = recipeNodes.filter((r) =>
          oneOf(cropName, [
            r.label,
            ...(this._extractRecipeIngredients(r) || []).map(
              (i) => i.name || i
            ),
          ])
        );

        for (const r of matchingRecipes) {
          suggestions.push({
            id: `sugg:meal-from-garden:${r.id}:${Date.now().toString(36)}`,
            source: "reverse:garden",
            action: "schedule-session",
            domain: "cooking",
            title: `Cook ${r.label} from garden ${cropName}`,
            payload: {
              recipeId: r.id,
              crop: cropName,
            },
            rationale: "Garden is producing this crop.",
          });
        }

        // preservation – basic heuristics
        const preservationMethod = this._guessPreservationForCrop(cropName);
        if (preservationMethod) {
          suggestions.push({
            id: `sugg:preserve:${cropName}:${Date.now().toString(36)}`,
            source: "reverse:garden",
            action: "schedule-session",
            domain: "preservation",
            title: `Preserve ${cropName} via ${preservationMethod}`,
            payload: {
              crop: cropName,
              method: preservationMethod,
            },
            rationale: "Garden crop detected; preservation is possible.",
          });
        }
      }
    }

    if (suggestions.length) {
      emitEvent("reverse-generation.garden.suggested", "knowledge:reverse", {
        count: suggestions.length,
      });
    }

    return suggestions;
  }

  _guessPreservationForCrop(cropName = "") {
    const lower = normStr(cropName);
    if (!lower) return null;
    if (lower.includes("tomato") || lower.includes("pepper")) return "can";
    if (
      lower.includes("herb") ||
      lower.includes("greens") ||
      lower.includes("okra")
    )
      return "dehydrate";
    if (lower.includes("berry") || lower.includes("fruit")) return "freeze";
    return null;
  }

  // ---------------------------------------------------------------------------
  // 4. ANIMALS → WHAT TO BREED / WHAT TO BUTCHER / WHAT TO COOK
  // ---------------------------------------------------------------------------
  /**
   * If user has animals or butchery sessions → suggest:
   *  - cook from fresh meat
   *  - preserve / cure
   *  - breed/acquire (if core proteins are missing in inventory/storehouse)
   */
  suggestFromAnimals(ctx = {}) {
    const animals = Array.isArray(ctx.animals) ? ctx.animals : [];
    if (!animals.length) return [];

    const suggestions = [];
    const inventory = Array.isArray(ctx.inventory) ? ctx.inventory : [];
    const storehouse = Array.isArray(ctx.storehouse) ? ctx.storehouse : [];

    for (const an of animals) {
      const species = normStr(an.species || an.name);
      if (!species) continue;

      // if inventory/storehouse is low on this species → suggest breed/acquire
      const invHas = inventory.some((i) => normStr(i.name).includes(species));
      const storeNeeds = storehouse.some(
        (s) => normStr(s.item).includes(species) && s.status !== "full"
      );

      if (!invHas || storeNeeds) {
        suggestions.push({
          id: `sugg:breed:${species}:${Date.now().toString(36)}`,
          source: "reverse:animals",
          action: "create-task",
          domain: "animal",
          title: `Acquire/Breed: ${species}`,
          payload: {
            species,
            reason: !invHas ? "inventory.low" : "storehouse.low",
          },
          rationale: "Protein is low or missing.",
        });
      }

      // if animal has butchery tasks → suggest preservation
      if (
        Array.isArray(an.tasks) &&
        an.tasks.some((t) => normStr(t).includes("package"))
      ) {
        suggestions.push({
          id: `sugg:preserve-meat:${species}:${Date.now().toString(36)}`,
          source: "reverse:animals",
          action: "schedule-session",
          domain: "preservation",
          title: `Preserve meat from ${species}`,
          payload: {
            species,
            method: "freeze-or-cure",
          },
          rationale: "Butchery session implies fresh meat available.",
        });
      }

      // also suggest meals using this meat
      suggestions.push({
        id: `sugg:cook-meat:${species}:${Date.now().toString(36)}`,
        source: "reverse:animals",
        action: "schedule-session",
        domain: "cooking",
        title: `Cook ${species} while fresh`,
        payload: {
          protein: species,
        },
        rationale: "Fresh meat should be used or preserved.",
      });
    }

    if (suggestions.length) {
      emitEvent("reverse-generation.animals.suggested", "knowledge:reverse", {
        count: suggestions.length,
      });
    }

    return suggestions;
  }

  // ---------------------------------------------------------------------------
  // 5. PRESERVATION → WHAT TO PROCESS NEXT
  // ---------------------------------------------------------------------------
  /**
   * If we have items in inventory that *should* be preserved (fresh produce,
   * large cuts, seasonal items), suggest preservation sessions.
   */
  suggestPreservation(ctx = {}) {
    const inv = Array.isArray(ctx.inventory) ? ctx.inventory : [];
    if (!inv.length) return [];

    const suggestions = [];

    for (const item of inv) {
      const name = normStr(item.name);
      if (!name) continue;

      // heuristics
      if (
        oneOf(name, [
          "tomato",
          "pepper",
          "okra",
          "greens",
          "cucumber",
          "squash",
          "pumpkin",
        ]) ||
        oneOf(item.category, ["produce", "fresh"])
      ) {
        const method = this._guessPreservationForCrop(name) || "freeze";
        suggestions.push({
          id: `sugg:preserve-inventory:${name}:${Date.now().toString(36)}`,
          source: "reverse:preservation",
          action: "schedule-session",
          domain: "preservation",
          title: `Preserve ${item.name} via ${method}`,
          payload: {
            item: item.name,
            method,
          },
          rationale: "Inventory has perishable/seasonal item.",
        });
      }
    }

    if (suggestions.length) {
      emitEvent(
        "reverse-generation.preservation.suggested",
        "knowledge:reverse",
        {
          count: suggestions.length,
        }
      );
    }

    return suggestions;
  }
}

// singleton + class
const reverseGeneration = new ReverseGeneration();
export { ReverseGeneration };
export default reverseGeneration;

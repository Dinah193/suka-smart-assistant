// C:\Users\larho\suka-smart-assistant\src\knowledge\TagEngine.js
// -----------------------------------------------------------------------------
// Suka Smart Assistant – Tag Engine
// -----------------------------------------------------------------------------
// PURPOSE
// Auto-tag everything that comes into SSA so that later stages
// (knowledge graph → reverse generation → automation → Hub export)
// have rich, structured context intelligence.
//
// This sits in the pipeline right after:
//   imports → normalize → **tag** → KnowledgeGraph / GraphLinker → automation
//
// WHAT IT DOES
// - Looks at the normalized import (recipe, cleaning, garden/seed,
//   animal/butchery, storehouse, video/how-to)
// - Infers domain, meal type, season, cuisine, preservation relevance,
//   garden growth potential, animal raising ability by climate, storehouse
//   section, etc.
// - Emits an event with { type, ts, source, data } so the runtime can react
// - Optionally pushes the tag set to the Hub if familyFundMode=true
// - Can write tags into the knowledge graph as tag nodes
//
// FORWARD-THINKING
// - Tag groups are defined at the top and are extendable
// - New domains can just add a detector
// - A single call to `run(importPayload, ctx)` returns { tags, score, reasons }
//
// ASSUMPTIONS
// - src/services/events/eventBus.js exists
// - src/config/featureFlags.js exists
// - src/services/hub/HubPacketFormatter.js and src/services/hub/FamilyFundConnector.js exist
// - src/knowledge/KnowledgeGraph.js exists
//
// NOTE
// Tagging itself does *not* mutate inventory/storehouse directly; but because
// tags are useful for the Hub, we *optionally* export the tag bundle.
//
// -----------------------------------------------------------------------------

import eventBus from "@/services/events/eventBus.js";
import featureFlags from "@/config/featureFlags.json";
import knowledgeGraph from "@/knowledge/KnowledgeGraph.js";

// soft Hub deps (optional, fail silently in browser-only builds)
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
    // tagging should never crash
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

function norm(v) {
  return (v || "").toString().trim().toLowerCase();
}

function textBundle(importPayload = {}) {
  return (
    [
      importPayload.title,
      importPayload.text,
      importPayload.url,
      importPayload.description,
      importPayload.meta?.site,
      importPayload.meta?.category,
    ]
      .filter(Boolean)
      .map((s) => s.toString())
      .join(" \n ")
      .toLowerCase() || ""
  );
}

function hasWord(txt, list) {
  const t = txt.toLowerCase();
  return list.some((w) => t.includes(w.toLowerCase()));
}

// -----------------------------------------------------------------------------
// Tag dictionaries (basic, extend as needed)
// -----------------------------------------------------------------------------
const MEAL_TYPES = {
  breakfast: [
    "breakfast",
    "pancake",
    "waffle",
    "omelet",
    "scramble",
    "frittata",
    "morning",
  ],
  lunch: ["lunch", "sandwich", "wrap", "salad bowl", "midday"],
  dinner: ["dinner", "supper", "stew", "roast", "casserole"],
  snack: ["snack", "bars", "energy bite"],
  dessert: ["dessert", "cookie", "cake", "brownie", "pie"],
  feast: ["feast", "festival", "holy day", "shabbat", "passover", "hanukkah"], // user’s biblical context
};

const SEASON_TAGS = {
  spring: ["spring", "asparagus", "peas", "radish"],
  summer: [
    "summer",
    "grill",
    "bbq",
    "tomato",
    "cucumber",
    "watermelon",
    "zucchini",
  ],
  fall: ["fall", "autumn", "pumpkin", "squash", "apple", "cider"],
  winter: ["winter", "stew", "soup", "chili", "slow cooker"],
};

const CUISINE_TAGS = {
  african: ["jollof", "suya", "injera", "egusi", "groundnut"],
  african_israelite: [
    "lamb",
    "goat",
    "kush",
    "ethiop",
    "paleo-hebrew",
    "torah meal",
  ],
  mediterranean: ["olive", "feta", "tahini", "pita", "mezze"],
  middle_eastern: ["shawarma", "falafel", "hummus", "za'atar", "sumac"],
  southern_us: ["grits", "biscuit", "okra", "collard", "gumbo"],
  caribbean: ["jerk", "plantain", "callaloo", "saltfish"],
};

const GARDEN_POTENTIAL = {
  cool: ["cabbage", "kale", "spinach", "lettuce", "peas"],
  warm: ["tomato", "pepper", "eggplant", "okra", "squash", "melon"],
  storage: ["pumpkin", "winter squash", "onion", "garlic"],
};

const ANIMAL_CLIMATE = {
  hot: ["goat", "kiko", "sheep", "katahdin", "chicken"],
  temperate: ["sheep", "duck", "muscovy", "turkey"],
  cold: ["highland", "yak"],
};

const PRESERVATION_HINTS = [
  "can",
  "canning",
  "ferment",
  "dehydrate",
  "smoke",
  "cure",
  "pickle",
  "preserve",
];

// -----------------------------------------------------------------------------
// TagEngine class
// -----------------------------------------------------------------------------
class TagEngine {
  /**
   * MAIN ENTRY
   * @param {Object} importPayload - normalized import
   * @param {Object} context - { climate, zone, householdPrefs, seasonOverride }
   * @returns {Object} { tags: Set<string> or Array<string>, reasons: Array<string> }
   */
  async run(importPayload = {}, context = {}) {
    if (!importPayload || typeof importPayload !== "object") {
      emitEvent("knowledge.tag.skipped", "knowledge:tagger", {
        reason: "no payload",
      });
      return { tags: [], reasons: ["No payload."] };
    }

    const kind = importPayload.kind || importPayload.__importType || "unknown";
    const text = textBundle(importPayload);
    const tags = new Set();
    const reasons = [];

    // 1) domain tag
    tags.add(`domain:${kind}`);
    reasons.push(`Detected domain from import kind "${kind}".`);

    // 2) domain-specific detectors
    if (kind === "recipe") {
      this._tagRecipe(importPayload, text, tags, reasons, context);
    } else if (kind === "cleaning" || kind === "cleaningPlan") {
      this._tagCleaning(importPayload, text, tags, reasons);
    } else if (
      kind === "garden" ||
      kind === "gardenPlan" ||
      kind === "gardenCare"
    ) {
      this._tagGarden(importPayload, text, tags, reasons, context);
    } else if (
      kind === "animal" ||
      kind === "animalPlan" ||
      kind === "butcherySession"
    ) {
      this._tagAnimal(importPayload, text, tags, reasons, context);
    } else if (
      kind === "storehouse" ||
      kind === "storehouseStock" ||
      kind === "storehouseGoal"
    ) {
      this._tagStorehouse(importPayload, text, tags, reasons);
    } else if (kind === "video") {
      this._tagVideo(importPayload, text, tags, reasons);
    } else {
      // unknown → generic tags
      tags.add("domain:generic");
      reasons.push("Unknown domain, applied generic tag.");
    }

    // 3) seasonal inference (global)
    this._applySeasonal(importPayload, text, tags, reasons, context);

    // 4) create tag nodes in knowledge graph (so GraphLinker / ReverseGeneration can use them)
    this._applyTagsToGraph(importPayload, Array.from(tags));

    // 5) emit event
    emitEvent("knowledge.tags.generated", "knowledge:tagger", {
      importId: importPayload.id,
      kind,
      tags: Array.from(tags),
      reasons,
    });

    // 6) optional hub export
    await exportToHubIfEnabled({
      kind: "knowledge.tags.generated",
      importId: importPayload.id,
      tags: Array.from(tags),
      at: nowIso(),
    });

    return { tags: Array.from(tags), reasons };
  }

  // ---------------------------------------------------------------------------
  // RECIPE TAGS
  // ---------------------------------------------------------------------------
  _tagRecipe(payload, text, tags, reasons, context) {
    const title = norm(payload.title);
    const ingredients = Array.isArray(payload.ingredients)
      ? payload.ingredients
      : [];

    tags.add("type:recipe");
    reasons.push("Recipe domain detected.");

    // meal type
    this._inferMealType({ title, text, ingredients }, tags, reasons);

    // cuisine
    this._inferCuisine({ title, text, ingredients }, tags, reasons);

    // preservation relevance (sauces, tomato, peppers, greens)
    if (
      hasWord(text, PRESERVATION_HINTS) ||
      ingredients.some((ing) =>
        hasWord(norm(ing.name || ing), ["tomato", "pepper", "greens"])
      )
    ) {
      tags.add("preservation:relevant");
      reasons.push(
        "Contains ingredients or wording suitable for preservation."
      );
    }

    // climate / garden potential – can we grow ingredients?
    this._inferGardenFromIngredients(ingredients, tags, reasons, context);
  }

  // ---------------------------------------------------------------------------
  // CLEANING TAGS
  // ---------------------------------------------------------------------------
  _tagCleaning(payload, text, tags, reasons) {
    tags.add("type:cleaning");
    reasons.push("Cleaning plan detected.");

    const tasks = Array.isArray(payload.tasks) ? payload.tasks : [];
    const title = norm(payload.title);

    if (hasWord(text, ["bathroom", "toilet", "tub"])) {
      tags.add("cleaning:zone:bathroom");
      reasons.push("Cleaning tasks mention bathroom.");
    }
    if (hasWord(text, ["kitchen", "fridge", "stove", "oven"])) {
      tags.add("cleaning:zone:kitchen");
      reasons.push("Cleaning tasks mention kitchen.");
    }
    if (hasWord(text, ["laundry", "linen", "clothes"])) {
      tags.add("cleaning:laundry");
      reasons.push("Cleaning tasks mention laundry.");
    }
    if (
      title.includes("declutter") ||
      hasWord(text, ["declutter", "organize", "purge"])
    ) {
      tags.add("cleaning:declutter");
      reasons.push("Decluttering content.");
    }

    if (tasks.length > 12) {
      tags.add("cleaning:large-routine");
      reasons.push("Large cleaning routine (12+ tasks).");
    }
  }

  // ---------------------------------------------------------------------------
  // GARDEN TAGS
  // ---------------------------------------------------------------------------
  _tagGarden(payload, text, tags, reasons, context) {
    tags.add("type:garden");
    reasons.push("Garden plan detected.");

    const seeds = Array.isArray(payload.seeds) ? payload.seeds : [];
    const zone = payload.zone || context.zone || context.climate || null;

    if (zone) {
      tags.add(`garden:zone:${zone}`);
      reasons.push(`Applied garden zone from context or payload: ${zone}`);
    }

    // classify seeds
    for (const seed of seeds) {
      const name = norm(seed.name || seed.crop || seed.variety);
      if (!name) continue;

      // cool/warm/storage
      for (const [pt, list] of Object.entries(GARDEN_POTENTIAL)) {
        if (list.some((w) => name.includes(norm(w)))) {
          tags.add(`garden:potential:${pt}`);
          reasons.push(`Seed "${seed.name}" suggests ${pt} growth potential.`);
        }
      }
    }

    // garden care imports
    if (
      payload.__importType === "gardenCare" ||
      hasWord(text, ["prune", "weed", "water"])
    ) {
      tags.add("garden:care");
      reasons.push("Garden maintenance task detected.");
    }
  }

  // ---------------------------------------------------------------------------
  // ANIMAL TAGS
  // ---------------------------------------------------------------------------
  _tagAnimal(payload, text, tags, reasons, context) {
    tags.add("type:animal");
    reasons.push("Animal / butchery plan detected.");

    const animals = Array.isArray(payload.animals) ? payload.animals : [];
    const climate = norm(context.climate || context.zone || "");

    for (const an of animals) {
      const species = norm(an.species || an.name || "");
      if (!species) continue;

      // climate ability
      for (const [cl, list] of Object.entries(ANIMAL_CLIMATE)) {
        if (list.some((w) => species.includes(norm(w)))) {
          tags.add(`animal:climate:${cl}`);
          reasons.push(`Species "${species}" is suitable for ${cl} climates.`);
        }
      }

      // match user climate: flag if mismatch
      if (climate && !text.includes(climate)) {
        tags.add("animal:check-climate-fit");
        reasons.push("User climate present; verify animal suitability.");
      }
    }

    if (hasWord(text, ["butcher", "cut sheet", "quarter", "package"])) {
      tags.add("animal:butchery");
      reasons.push("Butchery-related content detected.");
    }
  }

  // ---------------------------------------------------------------------------
  // STOREHOUSE TAGS
  // ---------------------------------------------------------------------------
  _tagStorehouse(payload, text, tags, reasons) {
    tags.add("type:storehouse");
    reasons.push("Storehouse / pantry planning detected.");

    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const it of items) {
      const name = norm(it.item || it.name || "");
      if (!name) continue;

      if (
        name.includes("grain") ||
        name.includes("flour") ||
        name.includes("oat")
      ) {
        tags.add("storehouse:section:dry-goods");
      } else if (
        name.includes("lamb") ||
        name.includes("beef") ||
        name.includes("goat")
      ) {
        tags.add("storehouse:section:frozen");
      } else if (name.includes("oil") || name.includes("fat")) {
        tags.add("storehouse:section:pantry");
      }
    }
  }

  // ---------------------------------------------------------------------------
  // VIDEO TAGS
  // ---------------------------------------------------------------------------
  _tagVideo(payload, text, tags, reasons) {
    tags.add("type:video");
    reasons.push("Video / how-to import detected.");

    if (hasWord(text, ["how to", "tutorial", "step-by-step"])) {
      tags.add("video:how-to");
      reasons.push("How-to phrasing detected.");
    }
    if (hasWord(text, ["cook", "recipe", "bake", "meal"])) {
      tags.add("video:domain:recipe");
      reasons.push("Video appears to be about cooking.");
    }
    if (hasWord(text, ["garden", "seed", "prune", "water"])) {
      tags.add("video:domain:garden");
      reasons.push("Video appears to be about garden.");
    }
    if (hasWord(text, ["butcher", "quarter", "meat"])) {
      tags.add("video:domain:animal");
      reasons.push("Video appears to be about animal/butchery.");
    }
  }

  // ---------------------------------------------------------------------------
  // SHARED DETECTORS
  // ---------------------------------------------------------------------------
  _inferMealType({ title, text, ingredients }, tags, reasons) {
    const blob = `${title} ${text}`.toLowerCase();

    for (const [mt, keys] of Object.entries(MEAL_TYPES)) {
      if (hasWord(blob, keys)) {
        tags.add(`meal:${mt}`);
        reasons.push(`Matched meal type "${mt}".`);
      }
    }

    // fallback for eggs, lamb/bacon breakfasts (user preference)
    const ingNames = (ingredients || []).map((i) => norm(i.name || i));
    if (
      ingNames.some((n) => n.includes("egg")) &&
      !tags.has("meal:breakfast")
    ) {
      tags.add("meal:breakfast");
      reasons.push(
        "Contains eggs, tagging as breakfast (per user preference)."
      );
    }
    if (
      ingNames.some((n) => n.includes("lamb bacon") || n.includes("beef bacon"))
    ) {
      tags.add("meal:breakfast");
      reasons.push("Contains lamb/beef bacon, tagging as breakfast.");
    }
  }

  _inferCuisine({ title, text, ingredients }, tags, reasons) {
    const blob = `${title} ${text}`.toLowerCase();
    for (const [cui, keys] of Object.entries(CUISINE_TAGS)) {
      if (hasWord(blob, keys)) {
        tags.add(`cuisine:${cui}`);
        reasons.push(`Matched cuisine "${cui}".`);
      }
    }

    // Torah / Israelite angle
    if (hasWord(blob, ["torah", "feast", "holy day", "passover", "hanukkah"])) {
      tags.add("cuisine:israelite-torah");
      reasons.push("Content references Torah/feast/holy day cooking.");
    }
  }

  _inferGardenFromIngredients(ingredients, tags, reasons, context) {
    if (!Array.isArray(ingredients) || !ingredients.length) return;
    for (const ing of ingredients) {
      const name = norm(ing.name || ing);
      if (!name) continue;

      for (const [pt, list] of Object.entries(GARDEN_POTENTIAL)) {
        if (list.some((w) => name.includes(norm(w)))) {
          tags.add(`garden:potential:${pt}`);
          reasons.push(`Ingredient "${name}" can be garden-grown (${pt}).`);
        }
      }
    }

    // if user’s climate is known, add it on top
    if (context?.climate) {
      tags.add(`climate:${context.climate}`);
      reasons.push(`Applied household climate "${context.climate}".`);
    }
  }

  _applySeasonal(importPayload, text, tags, reasons, context) {
    // context override
    if (context.seasonOverride) {
      tags.add(`season:${context.seasonOverride}`);
      reasons.push(`Season override from context: ${context.seasonOverride}`);
      return;
    }

    for (const [s, keys] of Object.entries(SEASON_TAGS)) {
      if (hasWord(text, keys)) {
        tags.add(`season:${s}`);
        reasons.push(`Content suggests ${s} season.`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // WRITE TAGS INTO KNOWLEDGE GRAPH
  // ---------------------------------------------------------------------------
  _applyTagsToGraph(importPayload, tagList = []) {
    if (!tagList.length) return;

    // make sure import exists in graph (this will create it if missing)
    const importNode = knowledgeGraph.upsertNode({
      id: importPayload.id ? `import:${importPayload.id}` : undefined,
      type: "import",
      label: importPayload.title || importPayload.kind || "import",
      data: {
        kind: importPayload.kind || importPayload.__importType,
        url: importPayload.url,
      },
    });

    for (const tag of tagList) {
      const tagNode = knowledgeGraph.upsertNode({
        type: "tag",
        label: tag,
        data: { value: tag },
      });

      knowledgeGraph.upsertEdge({
        from: importNode.id,
        to: tagNode.id,
        type: "tagged-with",
        meta: { source: "tag-engine" },
      });
    }
  }
}

// singleton
const tagEngine = new TagEngine();
export { TagEngine };
export default tagEngine;

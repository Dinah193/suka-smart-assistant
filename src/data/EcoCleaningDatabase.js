// src/data/EcoCleaningDatabase.js

const ecoCleaningDatabase = [
  {
    id: "citrus-vinegar-cleaner",
    name: "DIY Citrus Vinegar Cleaner",
    type: "Recipe",
    eco: true,
    categories: ["toilet", "bathroom", "sink", "countertops"],
    ingredients: ["Citrus peels", "White vinegar", "Water"],
    instructions:
      "Steep citrus peels in vinegar for 2 weeks. After steeping, dilute 1:1 with water and pour into spray bottle.",
  },
  {
    id: "sal-suds",
    name: "Dr. Bronner’s Sal Suds Biodegradable Cleaner",
    type: "Product",
    eco: true,
    categories: ["floor", "mop", "kitchen", "all-purpose"],
    source: "https://shop.drbronner.com/products/sal-suds-biodegradable-cleaner",
  },
  {
    id: "glass-spray",
    name: "Streak-Free Glass Spray",
    type: "Recipe",
    eco: true,
    categories: ["glass", "windows", "mirrors"],
    ingredients: ["1 cup water", "1 cup vinegar", "1 tbsp cornstarch"],
    instructions:
      "Mix ingredients in spray bottle. Shake well before each use. Spray on glass and wipe with microfiber cloth.",
  },
  {
    id: "baking-soda-paste",
    name: "Baking Soda Scrub Paste",
    type: "Recipe",
    eco: true,
    categories: ["oven", "grout", "sink", "stove"],
    ingredients: ["Baking soda", "Water", "Optional: Lemon juice"],
    instructions:
      "Mix baking soda with small amounts of water to form a paste. Apply to surface, scrub with sponge or brush.",
  },
  {
    id: "force-of-nature",
    name: "Force of Nature Electrolyzed Cleaner",
    type: "Product",
    eco: true,
    categories: ["all-purpose", "kitchen", "bathroom"],
    source: "https://www.forceofnatureclean.com/",
  }
];

/**
 * Push a new item into the session-based database.
 * Intended for in-app use during user sessions (non-persistent).
 * @param {object} newItem - Must contain id, name, type, eco, categories, ingredients/instructions or source
 */
export function addEcoCleaningItem(newItem) {
  if (!newItem.id) {
    newItem.id = `${newItem.name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`;
  }
  ecoCleaningDatabase.push(newItem);
}

/**
 * Optionally expose read-only view for components
 */
export function getEcoCleaningItems() {
  return [...ecoCleaningDatabase];
}

export default ecoCleaningDatabase;

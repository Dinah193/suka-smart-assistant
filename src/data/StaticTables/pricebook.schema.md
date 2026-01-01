# pricebook.schema.md  
Field documentation for SSA Pricebook

> Path: `src\data\StaticTables\pricebook.schema.md`  
> Scope: **Household-level price and source catalog** used by:
> - Imports (recipe, cleaning, garden, animal, preservation, storehouse)
> - Inventory & storehouse stock planning
> - Session planning (cooking, cleaning, garden, animal care, preservation)
> - Reverse generation (from sessions/recipes → suggested pricebook rows)
> - “Swap”/comparison modals and “Now” shopping sessions

The **Pricebook** is the normalized “source of truth” for where & how the household acquires items:
food, cleaning, garden inputs, animal feed & health, and preservation supplies.

Each **PricebookEntry** can be:
- Linked to **inventory items**, **recipes**, **cleaning plans**, **garden/animal tasks**, and **sessions**.
- Used in **reverse generation** when SSA sees new text (e.g., scraped recipe, garden guide, animal regimen, or user note) and needs to propose a canonical item.
- Favorited by the household so SSA prefers those choices when building shopping sessions and storehouse stock plans.

---

## 1. Top-level shape

This schema describes a *single* normalized pricebook entry.

```ts
/**
 * Core pricebook entry.
 */
export interface PricebookEntry {
  id: string;
  /** Human readable name (what user sees in UI). */
  label: string;

  /** Canonical normalized key for matching (case-insensitive, stripped). */
  canonicalKey: string;

  /** Primary household domain(s) this item participates in. */
  domains: Array<"cooking" | "cleaning" | "garden" | "animals" | "preservation" | "storehouse">;

  /**
   * High-level grocery / storehouse section for UX:
   * used for aisle-style grouping and inspiration
   * (e.g., storehouse stock dashboards, swap modals).
   */
  grocerySection: GrocerySection;

  /**
   * Detailed categorization used for filtering, rule logic,
   * and reverse generation.
   */
  category: {
    family: string;        // e.g. "meat", "grain", "cleaner", "seed"
    type: string;          // e.g. "chicken", "whole_wheat_flour", "glass_cleaner"
    subType?: string;      // e.g. "thigh", "hard_red_wheat", "ammonia_free"
    tags: string[];        // arbitrary tags for rules + filters
  };

  /**
   * Packaging and normalization.
   * All quantities should be convertible to normalized units
   * so SSA can compute price-per-unit and storehouse targets.
   */
  package: {
    sizeQuantity: number;
    sizeUnit: NormalizedUnit;  // e.g. "g", "kg", "oz", "lb", "ml", "l", "ct"
    /** Optional: count (e.g. 12 eggs) for 'ct' style packages. */
    count?: number | null;
    /** Optional household-specific portion size (e.g. 1-cup-equivalent). */
    householdPortionGrams?: number | null;
  };

  /** Current observed price and currency. */
  price: {
    amount: number;        // actual unit price seen (e.g. 4.99)
    currency: string;      // ISO code, typically "USD"
    /** Derived or cached price per normalized unit. */
    perUnit?: {
      amount: number;
      unit: NormalizedUnit;
    };
    /** Optional sale flags. */
    sale?: {
      isOnSale: boolean;
      type?: "weekly_ad" | "clearance" | "digital_coupon" | "bulk_discount";
      /** Price before sale, if known. */
      originalAmount?: number | null;
      /** Effective window for sale if known. */
      validFrom?: string | null; // ISO
      validTo?: string | null;   // ISO
    };
  };

  /**
   * Source / origin metadata, including scrapers, manual entry,
   * store, and online vs in-store channel.
   */
  source: {
    type: "manual" | "import" | "scraper" | "api";
    refId?: string | null;       // e.g. scraped URL hash, API product ID
    storeName?: string | null;   // e.g. "Walmart", "Aldi", "Azure Standard"
    storeId?: string | null;     // internal ID if you maintain a store table
    channel?: "in_store" | "pickup" | "delivery" | "online_only";
    importedAt?: string | null;  // ISO when first created
  };

  /**
   * Availability snapshot — this can be updated when sessions or
   * scrapers touch this item.
   */
  availability?: {
    status: "unknown" | "in_stock" | "low_stock" | "out_of_stock" | "discontinued";
    lastCheckedAt?: string | null; // ISO
  };

  /**
   * Household preferences — ties into “favorite” sessions,
   * schedules and swap modals.
   */
  prefs?: {
    isFavorite: boolean;
    favoriteRank?: number | null; // smaller = more preferred
    preferredVendors?: string[];  // storeId or storeName
    /** Household interpretation: staple, treat, bulk, emergency-only, etc. */
    roleTags?: Array<"staple" | "treat" | "bulk" | "emergency" | "rotation" | string>;
    notes?: string | null;
  };

  /**
   * Nutrition and functional metadata to connect with:
   * - nutrition engine
   * - meal planning / macro-aware flows
   */
  nutrition?: {
    /** ID into global or local nutrition database. */
    nutritionRefId?: string | null;
    /** Quick macros per 100g or per household portion. */
    macrosPer100g?: {
      kcal?: number | null;
      proteinG?: number | null;
      fatG?: number | null;
      carbsG?: number | null;
      fiberG?: number | null;
      calciumMg?: number | null;
      ironMg?: number | null;
    };
  };

  /**
   * Hooks for session automation & reverse generation.
   * These are used by SSA to:
   * - find a PricebookEntry from scraped text
   * - suggest items when inventory.shortage.detected fires
   * - recommend storehouse targets by domain
   */
  reverseGeneration?: {
    /** Strings SSA can match against when scraping/importing text. */
    aliases: string[];
    /** Canonical ingredient or supply hints for mapping. */
    ingredientKeys?: string[];
    /** Pattern fragments SSA might see in recipes, garden/animal plans, cleaning routines. */
    textPhrases?: string[];

    /**
     * Recommended default mappings for new sessions:
     * e.g., “use this as the default ‘vinegar’ when a cleaning recipe calls for it”.
     */
    defaultFor?: Array<
      | "default_vinegar_cleaning"
      | "default_vinegar_cooking"
      | "default_flour_bread"
      | "default_oil_frying"
      | "default_seed_variety"
      | "default_animal_feed"
      | string
    >;
  };

  /**
   * Analytics & linkage to sessions / inventory.
   */
  usage?: {
    lastUsedAt?: string | null;  // ISO
    usageCount: number;          // total references in sessions/tasks
    /** Last time a shopping / storehouse session included this item. */
    lastShoppingSessionId?: string | null;
    /** Optional pointer to inventory item this pricebook entry usually feeds. */
    inventoryRefId?: string | null;
  };

  /**
   * Audit timestamps.
   */
  audit: {
    createdAt: string;  // ISO
    updatedAt: string;  // ISO
  };
}

/** Allowed high-level sections, optimized for storehouse + grocery UX. */
export type GrocerySection =
  | "produce"
  | "meat+freezer"
  | "eggs+dairy"
  | "pantry:dry_goods"
  | "pantry:canned_jars"
  | "pantry:spices_sauces"
  | "baking"
  | "fats+oils"
  | "beverages"
  | "snacks"
  | "cleaning:laundry"
  | "cleaning:surfaces"
  | "cleaning:disinfectants"
  | "cleaning:dishes"
  | "hygiene"
  | "garden:seeds"
  | "garden:soil_amendments"
  | "garden:tools_supplies"
  | "animals:feed"
  | "animals:healthcare"
  | "animals:bedding"
  | "preservation:jars_lids"
  | "preservation:salt_sugar_vinegar"
  | "preservation:smoking_curing"
  | "other";

/** Core normalized units SSA uses for price-per-unit. */
export type NormalizedUnit =
  | "g"
  | "kg"
  | "oz"
  | "lb"
  | "ml"
  | "l"
  | "ct";
2. Example entries by domain
These examples are not the static table itself but show how the fields are intended to be used for different SSA domains.

2.1 Cooking + Storehouse (grain)
jsonc
Copy code
{
  "id": "pricebook:hard_red_wheat_bucket_25lb",
  "label": "Hard Red Wheat Berries – 25 lb Bucket",
  "canonicalKey": "hard_red_wheat_berries_25lb_bucket",
  "domains": ["cooking", "storehouse"],
  "grocerySection": "pantry:dry_goods",
  "category": {
    "family": "grain",
    "type": "wheat_berries",
    "subType": "hard_red",
    "tags": ["bread", "long_storage", "whole_grain"]
  },
  "package": {
    "sizeQuantity": 25,
    "sizeUnit": "lb",
    "householdPortionGrams": 500
  },
  "price": {
    "amount": 28.99,
    "currency": "USD",
    "perUnit": {
      "amount": 1.16,
      "unit": "kg"
    },
    "sale": {
      "isOnSale": false
    }
  },
  "source": {
    "type": "manual",
    "storeName": "Azure Standard",
    "channel": "delivery",
    "importedAt": "2025-11-15T14:00:00.000Z"
  },
  "availability": {
    "status": "in_stock",
    "lastCheckedAt": "2025-11-16T10:00:00.000Z"
  },
  "prefs": {
    "isFavorite": true,
    "favoriteRank": 1,
    "preferredVendors": ["Azure Standard"],
    "roleTags": ["staple", "bulk", "rotation"],
    "notes": "Primary bread grain; keep at least 2 buckets in rotation."
  },
  "nutrition": {
    "nutritionRefId": "nutrition:hard_red_wheat",
    "macrosPer100g": {
      "kcal": 340,
      "proteinG": 13,
      "fatG": 2.5,
      "carbsG": 71,
      "fiberG": 12
    }
  },
  "reverseGeneration": {
    "aliases": [
      "hard red wheat berries",
      "wheat berries",
      "25 lb wheat bucket"
    ],
    "ingredientKeys": [
      "wheat_berries",
      "grain:hard_red_wheat"
    ],
    "textPhrases": [
      "grind fresh flour",
      "bread baking grain",
      "whole wheat flour from berries"
    ],
    "defaultFor": [
      "default_flour_bread"
    ]
  },
  "usage": {
    "lastUsedAt": "2025-11-18T12:30:00.000Z",
    "usageCount": 34,
    "lastShoppingSessionId": "session:shopping:2025-11-17",
    "inventoryRefId": "inv:grain:hard_red_wheat"
  },
  "audit": {
    "createdAt": "2025-11-10T09:00:00.000Z",
    "updatedAt": "2025-11-18T12:30:00.000Z"
  }
}
2.2 Cleaning (vinegar-based surface cleaner)
jsonc
Copy code
{
  "id": "pricebook:distilled_white_vinegar_1gal",
  "label": "Distilled White Vinegar – 1 gal",
  "canonicalKey": "distilled_white_vinegar_1gal",
  "domains": ["cleaning", "cooking", "preservation", "storehouse"],
  "grocerySection": "preservation:salt_sugar_vinegar",
  "category": {
    "family": "cleaner",
    "type": "vinegar",
    "subType": "distilled_white",
    "tags": ["multi_use", "glass", "descale", "pickling"]
  },
  "package": {
    "sizeQuantity": 1,
    "sizeUnit": "gal",
    "householdPortionGrams": null
  },
  "price": {
    "amount": 3.29,
    "currency": "USD",
    "perUnit": {
      "amount": 0.87,
      "unit": "l"
    },
    "sale": {
      "isOnSale": true,
      "type": "weekly_ad",
      "originalAmount": 3.99,
      "validFrom": "2025-11-16T00:00:00.000Z",
      "validTo": "2025-11-22T23:59:59.000Z"
    }
  },
  "source": {
    "type": "scraper",
    "refId": "scraper:walmart:123456789",
    "storeName": "Walmart",
    "storeId": "store:walmart:local",
    "channel": "pickup",
    "importedAt": "2025-11-16T08:10:00.000Z"
  },
  "availability": {
    "status": "in_stock",
    "lastCheckedAt": "2025-11-17T06:00:00.000Z"
  },
  "prefs": {
    "isFavorite": true,
    "favoriteRank": 1,
    "preferredVendors": ["store:walmart:local"],
    "roleTags": ["staple", "cleaning", "preservation"],
    "notes": "Default vinegar for glass cleaning mixes and basic pickles."
  },
  "reverseGeneration": {
    "aliases": [
      "white vinegar",
      "distilled vinegar",
      "1 gallon vinegar"
    ],
    "ingredientKeys": [
      "vinegar:distilled_white"
    ],
    "textPhrases": [
      "clean with vinegar",
      "vinegar and water spray",
      "vinegar-based glass cleaner",
      "basic pickle brine"
    ],
    "defaultFor": [
      "default_vinegar_cleaning",
      "default_vinegar_cooking"
    ]
  },
  "usage": {
    "lastUsedAt": "2025-11-18T15:20:00.000Z",
    "usageCount": 27,
    "lastShoppingSessionId": "session:shopping_cleaning:2025-11-17",
    "inventoryRefId": "inv:cleaning:vinegar_distilled_1gal"
  },
  "audit": {
    "createdAt": "2025-11-16T08:10:00.000Z",
    "updatedAt": "2025-11-18T15:20:00.000Z"
  }
}
2.3 Garden (seed / amendment)
jsonc
Copy code
{
  "id": "pricebook:seed_tomato_roma_packet",
  "label": "Tomato Seed – Roma (Heirloom) Packet",
  "canonicalKey": "seed_tomato_roma_packet",
  "domains": ["garden", "storehouse"],
  "grocerySection": "garden:seeds",
  "category": {
    "family": "seed",
    "type": "tomato",
    "subType": "roma_heirloom",
    "tags": ["sauce", "canning", "companion:basil"]
  },
  "package": {
    "sizeQuantity": 1,
    "sizeUnit": "ct",
    "count": 40
  },
  "price": {
    "amount": 2.99,
    "currency": "USD"
  },
  "source": {
    "type": "manual",
    "storeName": "Local Feed & Seed",
    "channel": "in_store",
    "importedAt": "2025-11-10T11:00:00.000Z"
  },
  "availability": {
    "status": "in_stock",
    "lastCheckedAt": "2025-11-10T11:00:00.000Z"
  },
  "prefs": {
    "isFavorite": true,
    "favoriteRank": 1,
    "roleTags": ["staple", "rotation"],
    "notes": "Primary tomato variety for sauce & canning; align with companion planting table."
  },
  "reverseGeneration": {
    "aliases": [
      "roma tomato seeds",
      "tomato seeds for canning",
      "heirloom roma"
    ],
    "ingredientKeys": [
      "seed:tomato:roma",
      "garden:tomato:roma"
    ],
    "textPhrases": [
      "plant roma tomatoes for sauce",
      "canning tomatoes (roma)"
    ],
    "defaultFor": [
      "default_seed_variety"
    ]
  },
  "usage": {
    "lastUsedAt": "2025-11-12T10:45:00.000Z",
    "usageCount": 5,
    "lastShoppingSessionId": "session:garden_planning:2025-11-09",
    "inventoryRefId": "inv:garden:seed:tomato_roma"
  },
  "audit": {
    "createdAt": "2025-11-10T11:00:00.000Z",
    "updatedAt": "2025-11-12T10:45:00.000Z"
  }
}
2.4 Animals (feed / mineral)
jsonc
Copy code
{
  "id": "pricebook:goat_mineral_loose_25lb",
  "label": "Loose Goat Mineral – 25 lb Bag",
  "canonicalKey": "goat_mineral_loose_25lb",
  "domains": ["animals", "storehouse"],
  "grocerySection": "animals:healthcare",
  "category": {
    "family": "animal_mineral",
    "type": "goat",
    "subType": "loose_mineral",
    "tags": ["goat", "mineral", "health"]
  },
  "package": {
    "sizeQuantity": 25,
    "sizeUnit": "lb"
  },
  "price": {
    "amount": 19.99,
    "currency": "USD"
  },
  "source": {
    "type": "manual",
    "storeName": "Local Feed & Seed",
    "channel": "in_store",
    "importedAt": "2025-11-10T13:00:00.000Z"
  },
  "availability": {
    "status": "in_stock",
    "lastCheckedAt": "2025-11-15T09:00:00.000Z"
  },
  "prefs": {
    "isFavorite": true,
    "favoriteRank": 1,
    "preferredVendors": ["Local Feed & Seed"],
    "roleTags": ["staple", "health", "emergency"],
    "notes": "Primary goat mineral; ensure always have 1 spare bag in storehouse."
  },
  "reverseGeneration": {
    "aliases": [
      "goat loose mineral",
      "loose goat mineral",
      "goat minerals bag"
    ],
    "ingredientKeys": [
      "animals:goat:mineral"
    ],
    "textPhrases": [
      "keep fresh loose mineral available for goats",
      "goat mineral feeder"
    ],
    "defaultFor": [
      "default_animal_feed",
      "default_animal_mineral"
    ]
  },
  "usage": {
    "lastUsedAt": "2025-11-18T07:15:00.000Z",
    "usageCount": 12,
    "lastShoppingSessionId": "session:animals_shopping:2025-11-14",
    "inventoryRefId": "inv:animals:goat_mineral_loose"
  },
  "audit": {
    "createdAt": "2025-11-10T13:00:00.000Z",
    "updatedAt": "2025-11-18T07:15:00.000Z"
  }
}
3. How this fits SSA, sessions, and “reverse generation”
3.1 Forward flow (Pricebook → Sessions)
When inventory.shortage.detected for an item, SSA:

Looks up PricebookEntry by inventoryRefId.

Suggests shopping lines grouped by grocerySection and storeName.

Builds a shopping session with steps grouped by aisle and domain (cooking, cleaning, garden, animals, preservation).

When user plans:

Cooking sessions: SSA can show the cheapest or favorite flour/oil/veg from the pricebook.

Cleaning sessions: SSA picks default vinegar, soap, and safe cleaners from pricebook entries with domains containing "cleaning".

Garden sessions: SSA uses garden:seeds and garden:soil_amendments entries to propose seed-starting or bed-prep shopping tasks.

Animal sessions: SSA pairs butchery tasks with packaging, salt, casings, and feed/mineral restock entries.

3.2 Reverse generation (Sessions/Imports → Pricebook)
Use reverseGeneration:

When scraping a new recipe / cleaning plan / garden guide / animal regimen:

SSA extracts ingredient / supply phrases.

Matches them against aliases, ingredientKeys, and textPhrases.

Picks an existing PricebookEntry OR proposes a new one for user approval.

When user runs a session and marks a substitution:

e.g. “Used sunflower oil instead of olive oil”

SSA:

Links the used PricebookEntry to that recipe or session.

Increments usage.usageCount.

Optionally adds a new alias to reverseGeneration.aliases for future auto-matching.

3.3 Favorites & schedules
prefs.isFavorite and favoriteRank allow:

Domain pages to show favorite sources first in swap/selection modals.

Automation runtime to prefer these items when auto-assembling weekly/monthly shopping sessions.

This interacts well with:

Storehouse targets (e.g. always 2 buckets of wheat; always spare goat mineral).

SessionRunner analytics (session.completed) to update usage.lastUsedAt and usage.usageCount.

4. UI notes (swap modal + “Now” flows)
Although this file is schema-only, it supports the UI you described:

Swap modal for sessions and meal plans:

Uses grocerySection, label, price.perUnit, and prefs.isFavorite to show:

Household favorites at the top.

Alternatives grouped by aisle/section.

“Now” shopping sessions:

Domain pages (cooking, cleaning, garden, animals, preservation, storehouse) can:

Pull the “next runnable shopping session” built from pricebook + inventory shortages.

Launch it in the shared SessionRunner modal (timers, notifications, mini HUD, etc).

This schema keeps Pricebook fully aligned with SSA’s dynamic, multi-domain automation so you can plug it directly into your existing Dexie tables and orchestrator logic.
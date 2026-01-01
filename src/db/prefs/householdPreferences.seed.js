// C:\Users\larho\suka-smart-assistant\src\db\prefs\householdPreferences.seed.js
// -----------------------------------------------------------------------------
// Seeded household/user preference examples (dietary, zone, equipment, domain prefs)
// UPDATED 2025-10-31 for Suka Smart Assistant
// -----------------------------------------------------------------------------
// GOALS OF THIS SEED:
// 1. Give the app “smart defaults” so your UI can render real panels even
//    before the user customizes anything.
// 2. Cover ALL of your current domains (cleaning, garden, storehouse,
//    meal planning, animals/butchery) so the import + orchestration
//    pipeline can “see” that they exist and offer choices.
// 3. Make favorites + user-owned sessions FIRST-CLASS, not just system
//    templates.
// 4. Enable reverse generation:
//    - mealPlan → animal acquisition / butchery plan
//    - storehouse goals → garden plan
//    - garden harvest windows → meal / preservation sessions
//    - cleaning imports → recurring cleaning sessions
// 5. Expose orchestration flags for window.__suka?.eventBus and runtime
//    so your ImportService / ImportRouter / automation/runtime.js can
//    read these and act accordingly.
//
// HOW TO USE:
// - Import this into your Dexie bootstrap (db/index.js or db/seeds.dev.js)
//   and write to a `prefs` / `householdPrefs` table if empty.
// - This file is *data-first* and defensive, so you can evolve schemas
//   without breaking the app.
//
// NOTES:
// - Keep keys stable – your UI (settings panels, ImportSettings.jsx,
//   Session planners) can use stable IDs to pre-select stuff.
// - Keep everything serializable – this gets stored in Dexie.
// -----------------------------------------------------------------------------

const householdPreferencesSeed = {
  version: "2025-10-31T10:00:00-05:00",
  householdId: "demo-household",
  owner: {
    id: "owner-001",
    name: "Demo Matriarch",
    role: "primary-householder",
  },

  // ---------------------------------------------------------------------------
  // GLOBAL / APP-WIDE
  // ---------------------------------------------------------------------------
  global: {
    locale: "en-US",
    timezone: "America/Chicago",
    sabbathGuard: {
      enabled: true,
      // Friday sunset to Saturday sunset equivalents
      window: {
        startDow: 5,
        startHour: 16,
        endDow: 6,
        endHour: 19,
      },
      behavior: "pause-noncritical", // or "reschedule", "silent"
    },
    quietHours: {
      enabled: true,
      start: "21:30",
      end: "06:30",
    },
    ui: {
      theme: "suka-light",
      density: "cozy",
      showAdvancedPanels: true,
    },
    orchestration: {
      // let the site-level shared orchestration (window.__suka?.eventBus)
      // know what to broadcast
      eventBusEnabled: true,
      emitOnPreferenceChange: true,
      emitChannels: [
        "meals",
        "cleaning",
        "garden",
        "storehouse",
        "inventory",
        "animals",
        "susu",
      ],
    },
    integrations: {
      // so ImportService / ImportRouter know what to offer
      allowLinkedAccounts: true,
      preferredImportPaths: [
        "allrecipes.com",
        "loveandlemons.com",
        "pinterest.com",
        "youtube.com",
        "tiktok.com",
        "facebook.com",
        "garden.org",
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // MEAL PLANNING
  // ---------------------------------------------------------------------------
  mealPlanning: {
    defaultCuisine: ["southern", "mediterranean"],
    avoidIngredients: ["pork", "shellfish"], // Torah-compliant preferences
    preferredProteins: ["lamb", "beef", "goat", "poultry", "fish"],
    includeGoatInPlans: true, // per your Oct 30 preference
    equipment: {
      available: ["pressure-cooker", "smoker", "dehydrator", "bread-mill"],
      unavailable: ["sous-vide"],
    },
    sessionDefaults: {
      durationMinutes: 90,
      includeBatchCooking: true,
      autoConsolidateSteps: true,
      writeToCalendar: true,
      calendarFrequency: "weekly",
      exportTo: ["inventory", "storehouse", "animals"], // ← reverse-gen hooks
    },
    favorites: [
      {
        id: "fav-meal-session-01",
        label: "Weekly Prep – Lamb/Beef Breakfasts",
        domain: "meals",
        source: "user",
        steps: [
          "Mill grains for waffles/pancakes",
          "Batch-cook lamb/beef breakfast sausage",
          "Prep goat meat for weekend stew if available",
          "Update inventory + storehouse stock goals",
        ],
        schedule: {
          type: "recurring",
          rule: "RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=9;BYMINUTE=0;BYSECOND=0",
        },
        reverseGeneration: {
          // tell the rest of the system: “this meal plan can cause an animal plan”
          enabled: true,
          targets: ["animals", "storehouse"],
          reason: "meat-heavy meals require acquisition/butchery/storehouse updates",
        },
      },
    ],
    reverseGeneration: {
      // meal → animals
      enabled: true,
      rules: [
        {
          id: "meal-to-animal-protein",
          ifMealContains: ["lamb", "beef", "goat"],
          generate: "animal-acquisition-plan",
          copyContext: ["householdId", "timezone", "sabbathGuard"],
        },
        {
          id: "meal-to-storehouse-staples",
          ifMealContains: ["flour", "grain", "oil", "wine"],
          generate: "storehouse-replenishment-goal",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // CLEANING / DECLUTTER / ZONES
  // ---------------------------------------------------------------------------
  cleaning: {
    defaultMode: "zone",
    zones: [
      { id: "kitchen", label: "Kitchen", cadence: "daily", priority: 1 },
      { id: "bathroom", label: "Bathrooms", cadence: "2x-week", priority: 1 },
      { id: "laundry", label: "Laundry", cadence: "weekly", priority: 2 },
      { id: "pantry", label: "Pantry / Storehouse Area", cadence: "weekly", priority: 2 },
      { id: "outdoor", label: "Outdoor / Animal Processing Area", cadence: "weekly", priority: 3 },
    ],
    preferredCleaningSupplies: [
      "homemade-multipurpose",
      "vinegar-solution",
      "castile-soap",
      "oxygen-bleach",
    ],
    // user-owned sessions (not just system)
    favorites: [
      {
        id: "fav-cleaning-declutter-01",
        label: "Friday Pre-Sabbath Reset",
        domain: "cleaning",
        source: "user",
        tasks: [
          "Kitchen wipe-down",
          "Bathroom freshen",
          "Sweep entry + animal mess zones",
          "Pantry/storehouse visibility pass",
        ],
        schedule: {
          type: "recurring",
          rule: "RRULE:FREQ=WEEKLY;BYDAY=FR;BYHOUR=14;BYMINUTE=0;BYSECOND=0",
        },
        orchestration: {
          emit: ["cleaning.session.created", "inventory.visibility.requested"],
        },
      },
    ],
    reverseGeneration: {
      enabled: true,
      rules: [
        {
          id: "cleaning-to-inventory-visibility",
          ifZoneIn: ["pantry", "storehouse-area"],
          generate: "inventory-visibility-task",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // GARDEN PLANNING, CARE, HARVEST
  // ---------------------------------------------------------------------------
  garden: {
    growZone: "8b", // example – adjust based on user’s real location
    methods: ["raised-beds", "in-ground", "container"],
    waterPolicy: {
      preferMorning: true,
      skipIfRainForecast: true,
      integrateWeatherGuard: true,
    },
    seedPreferences: {
      // you asked: “why do you keep referencing seed as a supported type?”
      // → here we make it explicit so ImportService/Router can “see” it
      allowSeedImports: true,
      defaultSeedSources: ["baker-creek", "johnny-seeds", "local-coop"],
      expectSchema: "garden.seedPack.v1",
    },
    careTemplates: [
      {
        id: "garden-care-weekly",
        label: "Weekly Garden Care",
        steps: ["inspect beds", "weed high-priority beds", "harvest ready produce", "log harvest"],
      },
    ],
    favorites: [
      {
        id: "fav-garden-to-storehouse-01",
        label: "Tomato to Sauce Pipeline",
        domain: "garden",
        source: "user",
        description: "Focus garden on tomato-heavy output to feed preservation + meal plans.",
        schedule: {
          type: "seasonal",
          // app layer can interpret this
          rule: "SEASON:SUMMER;FREQ=WEEKLY;BYDAY=SU",
        },
        reverseGeneration: {
          enabled: true,
          targets: ["storehouse", "meals"],
          reason: "tomato harvest → canning/preserving → meal ingredients",
        },
      },
    ],
    reverseGeneration: {
      enabled: true,
      rules: [
        {
          id: "garden-to-storehouse",
          ifHarvestIn: ["tomato", "okra", "peppers", "greens"],
          generate: "storehouse-preservation-session",
        },
        {
          id: "storehouse-goal-to-garden",
          // this gets triggered by storehouse.stock.goals when tomatoes are desired
          ifStorehouseNeeds: ["tomato-sauce", "dried-tomato", "pepper-flakes"],
          generate: "garden-planting-plan",
          copyContext: ["growZone", "waterPolicy"],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // STOREHOUSE STOCK PLANNING (inspired by grocery sections)
  // ---------------------------------------------------------------------------
  storehouse: {
    layoutInspiration: [
      "produce",
      "meat",
      "dry-goods",
      "baking",
      "ferments",
      "freezer",
      "household-supplies",
    ],
    targetLevels: {
      // Consumables at 1/10th the rate of non-consumables (per your currency rules)
      grain: { level: "3-months", priority: 1 },
      pulses: { level: "3-months", priority: 1 },
      oil: { level: "2-months", priority: 2 },
      preservedTomato: { level: "2-months", priority: 2 },
      meat: { level: "1-month", priority: 1 },
      cleaningSupplies: { level: "1-month", priority: 3 },
    },
    autoFromImports: true,
    syncInventoryOnChange: true,
    favorites: [
      {
        id: "fav-storehouse-monthly-audit",
        label: "Monthly Storehouse Audit",
        domain: "storehouse",
        source: "user",
        tasks: [
          "Scan pantry",
          "Update dry-goods levels",
          "Reconcile with inventory",
          "Emit meal/storehouse alignment event",
        ],
        schedule: {
          type: "recurring",
          rule: "RRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=8;BYMINUTE=0;BYSECOND=0",
        },
        orchestration: {
          emit: ["storehouse.audit.requested", "inventory.reconcile.requested", "meals.refresh.requested"],
        },
      },
    ],
    reverseGeneration: {
      enabled: true,
      rules: [
        {
          id: "storehouse-to-garden",
          ifNeedIn: ["tomato", "onion", "garlic", "greens"],
          generate: "garden-plan",
        },
        {
          id: "storehouse-to-meals",
          ifExcessIn: ["peas", "beans", "lamb", "goat"],
          generate: "meal-plan-using-surplus",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // ANIMAL ACQUISITION, CARE, AND BUTCHERY
  // ---------------------------------------------------------------------------
  animals: {
    allowSpecies: ["sheep", "goat", "cattle", "poultry"],
    disallowSpecies: ["swine"], // Torah-compliant, no unclean animal processing
    butchery: {
      enableHomeButchery: true,
      enableUSDAIntegration: true,
      // you mentioned blood meal production – include it here
      byproductProcessing: ["blood-meal", "tallow", "bone-broth-stock"],
    },
    acquisition: {
      estimateFromMeals: true, // ← this is the reverse generation hook
      geoAwareBreeds: true, // “Add in meat animal estimates and breeds that work well for the geographical location”
      defaultBreedsByZone: {
        "8b": {
          sheep: ["Katahdin", "Dorper"],
          goat: ["Boer", "Kiko"],
          cattle: ["Dexter", "Senepol"],
        },
      },
    },
    careTemplates: [
      {
        id: "animal-daily-care",
        label: "Daily Animal Check",
        steps: ["feed", "water", "health check", "record notes"],
      },
    ],
    favorites: [
      {
        id: "fav-animal-from-meal-plan-01",
        label: "Generate Animal Plan from Meals",
        domain: "animals",
        source: "user",
        description: "Reads current meal plan and projects meat needs for 4 weeks.",
        schedule: {
          type: "on-demand",
        },
        orchestration: {
          emit: ["animals.plan.fromMeals.requested"],
        },
      },
    ],
    reverseGeneration: {
      enabled: true,
      rules: [
        {
          id: "meals-to-animals",
          ifMealProteinIn: ["lamb", "beef", "goat", "poultry"],
          generate: "animal-provisioning-plan",
        },
        {
          id: "animals-to-storehouse",
          ifButcheryPlanned: true,
          generate: "storehouse-intake-session",
        },
      ],
    },
  },
};

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
export default householdPreferencesSeed;

// If your Dexie bootstrap uses CommonJS, you can also do:
// module.exports = householdPreferencesSeed;

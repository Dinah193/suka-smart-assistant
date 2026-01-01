// C:\Users\larho\suka-smart-assistant\src\db\seeds.dev.js
// Demo data for local testing
// -----------------------------------------------------------------------------
// This assumes you have a Dexie setup or a local storage adapter elsewhere.
// You can call seedDev(db, config) after db open in development only.

import { getConfig } from "@/config";

const DEMO_USER_ID = "__demo_user__";
const DEMO_HOUSEHOLD_ID = "__demo_household__";

function nowIso() {
  return new Date().toISOString();
}

function daysFromNow(d) {
  const dt = new Date();
  dt.setDate(dt.getDate() + d);
  return dt.toISOString();
}

export async function seedDev(db) {
  // don't seed in production
  if (import.meta?.env?.VITE_APP_ENV === "production") return;

  const cfg = getConfig({ tier: "ssa", role: "admin" });

  // optional: if you've already seeded, bail
  try {
    const existing = await db.meta?.get("seeded-dev");
    if (existing?.value === true) return;
  } catch {
    // ignore
  }

  /* ------------------------------------------------------------------------ */
  /* MEALS / COOKING                                                          */
  /* ------------------------------------------------------------------------ */
  const mealPlans = [];
  if (cfg.domains.meals.enabled) {
    mealPlans.push(
      {
        id: "__demo_mealplan_1",
        userId: DEMO_USER_ID,
        householdId: DEMO_HOUSEHOLD_ID,
        name: "Demo 7-Day Meal Plan",
        description: "Imported from Pinterest board + Allrecipes + adjusted for inventory.",
        source: "import:pinterest-board",
        days: [
          {
            date: daysFromNow(0).slice(0, 10),
            meals: [
              {
                type: "breakfast",
                recipeId: "__demo_recipe_frittata",
                title: "Garden Veggie Frittata",
                fromImport: true
              },
              {
                type: "dinner",
                recipeId: "__demo_recipe_lamb_stew",
                title: "Lamb Stew with Root Veg",
                fromImport: false
              }
            ]
          },
          {
            date: daysFromNow(1).slice(0, 10),
            meals: [
              {
                type: "lunch",
                recipeId: "__demo_recipe_flatbread",
                title: "Fresh Milled Flatbread + Hummus",
                fromImport: true
              }
            ]
          }
        ],
        reverseGeneration: {
          toAnimalPlanner: true,
          toStorehouse: true,
          toShoppingList: true
        },
        favorite: cfg.domains.meals.allowUserFavorites,
        schedule: cfg.domains.meals.allowUserSchedules
          ? {
              recurrence: "weekly",
              startDate: daysFromNow(0).slice(0, 10),
              timeOfDay: "08:00"
            }
          : null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      }
    );

    // demo recipes
    await safePut(db.recipes, [
      {
        id: "__demo_recipe_frittata",
        title: "Garden Veggie Frittata",
        ingredients: [
          { name: "egg", quantity: 6, unit: "pcs" },
          { name: "spinach", quantity: 1, unit: "cup" },
          { name: "goat cheese", quantity: 0.5, unit: "cup" }
        ],
        steps: [
          "Preheat oven to 375F.",
          "Whisk eggs.",
          "Add spinach + goat cheese.",
          "Bake 20 min."
        ],
        tags: ["breakfast", "garden", "demo"],
        source: "pinterest-import",
        createdAt: nowIso()
      },
      {
        id: "__demo_recipe_lamb_stew",
        title: "Lamb Stew with Root Veg",
        ingredients: [
          { name: "lamb shoulder", quantity: 1.5, unit: "lb" },
          { name: "carrot", quantity: 3, unit: "pcs" },
          { name: "potato", quantity: 2, unit: "pcs" },
          { name: "onion", quantity: 1, unit: "pcs" }
        ],
        steps: [
          "Brown lamb.",
          "Add veg and broth.",
          "Simmer 1.5 hr.",
          "Serve with flatbread."
        ],
        tags: ["dinner", "lamb", "demo"],
        source: "manual",
        createdAt: nowIso()
      },
      {
        id: "__demo_recipe_flatbread",
        title: "Fresh Milled Flatbread",
        ingredients: [
          { name: "fresh milled wheat flour", quantity: 2, unit: "cup" },
          { name: "water", quantity: 0.75, unit: "cup" },
          { name: "salt", quantity: 1, unit: "tsp" }
        ],
        steps: ["Mix.", "Rest 20 min.", "Roll.", "Cook on hot griddle."],
        tags: ["bread", "torah-kitchen", "demo"],
        source: "manual",
        createdAt: nowIso()
      }
    ]);
  }

  /* ------------------------------------------------------------------------ */
  /* CLEANING                                                                 */
  /* ------------------------------------------------------------------------ */
  const cleaningSessions = [];
  if (cfg.domains.cleaning.enabled) {
    cleaningSessions.push(
      {
        id: "__demo_cleaning_session_kitchen",
        name: "Kitchen Reset (Imported)",
        source: "import:cleaning-plan:pinterest",
        zone: "kitchen",
        steps: [
          "Clear counters",
          "Wash dishes / load dishwasher",
          "Wipe counters + appliances",
          "Sweep & spot mop"
        ],
        suggestedDurationMin: 35,
        favorite: cfg.domains.cleaning.allowUserFavorites,
        schedule: cfg.domains.cleaning.allowUserSchedules
          ? {
              recurrence: "daily",
              timeOfDay: "19:00"
            }
          : null,
        sabbathAware: cfg.domains.cleaning.sabbathAware,
        createdAt: nowIso()
      },
      {
        id: "__demo_cleaning_session_declutter",
        name: "10-Min Living Room Declutter",
        source: "manual",
        zone: "living-room",
        steps: ["Gather stray items", "Return to proper room", "Quick dust"],
        suggestedDurationMin: 10,
        favorite: cfg.domains.cleaning.allowUserFavorites,
        schedule: null,
        sabbathAware: cfg.domains.cleaning.sabbathAware,
        createdAt: nowIso()
      }
    );
  }

  /* ------------------------------------------------------------------------ */
  /* GARDEN: plan + care + harvest                                            */
  /* ------------------------------------------------------------------------ */
  const gardenPlans = [];
  const gardenCareQueue = [];
  if (cfg.domains.garden.enabled) {
    gardenPlans.push(
      {
        id: "__demo_garden_plan_fall",
        name: "Fall 2025 Raised Beds",
        source: "import:garden-seed-plan",
        beds: [
          {
            name: "Bed A",
            crops: [
              { crop: "collards", qty: 12, start: "2025-09-15" },
              { crop: "carrots", qty: 40, start: "2025-09-20" }
            ]
          },
          {
            name: "Bed B",
            crops: [
              { crop: "garlic", qty: 30, start: "2025-10-01" }
            ]
          }
        ],
        allowShare: cfg.domains.garden.collab.enabled,
        coOpPlanning: cfg.domains.garden.collab.coOpPlanning,
        favorite: cfg.domains.garden.allowUserFavorites,
        schedule: cfg.domains.garden.allowUserSchedules
          ? {
              recurrence: "weekly",
              dayOfWeek: "Sun",
              timeOfDay: "14:00"
            }
          : null,
        createdAt: nowIso()
      }
    );

    // care & harvest tasks derived from plan (what your gardenQueueEngine would do)
    gardenCareQueue.push(
      {
        id: "__demo_garden_task_water_collards",
        planId: "__demo_garden_plan_fall",
        type: "care",
        title: "Water collards",
        due: daysFromNow(1),
        repeat: "every-2d",
        createdAt: nowIso()
      },
      {
        id: "__demo_garden_task_harvest_carrots",
        planId: "__demo_garden_plan_fall",
        type: "harvest",
        title: "Harvest carrots (Bed A)",
        due: daysFromNow(30),
        repeat: null,
        createdAt: nowIso()
      }
    );
  }

  /* ------------------------------------------------------------------------ */
  /* STOREHOUSE: stock planning / grocery section inspo                       */
  /* ------------------------------------------------------------------------ */
  const storehouseGoals = [];
  if (cfg.domains.storehouse.enabled) {
    storehouseGoals.push(
      {
        id: "__demo_storehouse_goal_3mo",
        name: "3-Month Pantry Buildout",
        source: "import:storehouse-stock",
        grocerySections: [
          {
            section: "Grains & Flour",
            targetQty: 50,
            unit: "lb",
            fromMeals: true,
            notes: "Fresh-milled preferred"
          },
          {
            section: "Beans & Lentils",
            targetQty: 30,
            unit: "lb",
            fromMeals: true
          },
          {
            section: "Oils & Fats",
            targetQty: 2,
            unit: "gal"
          }
        ],
        reverseFromMeals: true,
        favorite: cfg.domains.storehouse.allowUserFavorites,
        schedule: cfg.domains.storehouse.allowUserSchedules
          ? {
              recurrence: "monthly",
              dayOfMonth: 1
            }
          : null,
        coOp: cfg.domains.storehouse.coOp.enabled,
        createdAt: nowIso()
      }
    );
  }

  /* ------------------------------------------------------------------------ */
  /* ANIMALS: acquisition → care → butchery                                   */
  /* ------------------------------------------------------------------------ */
  const animalPlans = [];
  const animalCareTasks = [];
  const butcherySessions = [];
  if (cfg.domains.animals.enabled) {
    animalPlans.push(
      {
        id: "__demo_animal_plan_fall",
        name: "Meat Animals for Lamb Stew + Breakfast Sausage",
        source: "reverse:meals",
        reason: "Meals include lamb stew 2x/week + breakfast sausage 3x/week",
        acquisition: [
          {
            species: "sheep",
            breed: "Katahdin (hair sheep)",
            qty: 4,
            geoMatch: cfg.domains.animals.geoAwareBreeds.enabled
          },
          {
            species: "goat",
            breed: "Boer cross",
            qty: 2,
            geoMatch: cfg.domains.animals.geoAwareBreeds.enabled
          }
        ],
        reverseDirection: cfg.domains.animals.reverseDirection.generateAnimalPlanFromRecipes,
        favorite: cfg.domains.animals.allowUserFavorites,
        schedule: cfg.domains.animals.allowUserSchedules
          ? {
              recurrence: "once",
              date: daysFromNow(2).slice(0, 10)
            }
          : null,
        createdAt: nowIso()
      }
    );

    animalCareTasks.push(
      {
        id: "__demo_animal_care_feed_am",
        animalPlanId: "__demo_animal_plan_fall",
        type: "feed",
        title: "AM feed + water check",
        due: daysFromNow(0),
        repeat: "daily",
        createdAt: nowIso()
      },
      {
        id: "__demo_animal_care_deworm",
        animalPlanId: "__demo_animal_plan_fall",
        type: "health",
        title: "Deworm flock (natural rotation)",
        due: daysFromNow(14),
        repeat: "every-90d",
        createdAt: nowIso()
      }
    );

    butcherySessions.push(
      {
        id: "__demo_butchery_session_1",
        animalPlanId: "__demo_animal_plan_fall",
        title: "Process 1 sheep for stew + breakfast sausage meat",
        date: daysFromNow(3),
        outputs: [
          {
            product: "lamb stew cuts",
            qty: 10,
            unit: "lb",
            routeTo: "storehouse"
          },
          {
            product: "breakfast sausage grind",
            qty: 6,
            unit: "lb",
            routeTo: "meals"
          },
          {
            product: "blood",
            qty: 2,
            unit: "gal",
            routeTo: "byproducts"
          }
        ],
        favorite: cfg.domains.animals.allowUserFavorites,
        schedule: cfg.domains.animals.allowUserSchedules
          ? {
              recurrence: "once",
              date: daysFromNow(3).slice(0, 10)
            }
          : null,
        createdAt: nowIso()
      }
    );
  }

  /* ------------------------------------------------------------------------ */
  /* IMPORT SESSIONS (to demo ImportLanding / ImportPreview)                  */
  /* ------------------------------------------------------------------------ */
  const importSessions = [];
  if (cfg.domains.import.enabled) {
    importSessions.push(
      {
        id: "__demo_import_cleaning",
        type: "cleaning-plan",
        sourceUrl: "https://www.pinterest.com/.../clean-kitchen-every-day/",
        payload: {
          zone: "kitchen",
          steps: ["clear counters", "wipe counters", "wash dishes", "sweep"],
          duration: 25
        },
        favorite: cfg.domains.import.sessions.allowUserFavorites,
        schedule: null,
        createdAt: nowIso()
      },
      {
        id: "__demo_import_garden",
        type: "garden-seed-plan",
        sourceUrl: "https://seed-supplier.example.com/fall-kit",
        payload: {
          season: "fall",
          items: [
            { seed: "collards", qty: 1, unit: "pkt" },
            { seed: "carrot", qty: 1, unit: "pkt" },
            { seed: "garlic", qty: 10, unit: "bulbs" }
          ]
        },
        favorite: cfg.domains.import.sessions.allowUserFavorites,
        schedule: null,
        createdAt: nowIso()
      },
      {
        id: "__demo_import_animals_reverse",
        type: "animal-plan-reverse",
        sourceUrl: "local://reverse/meals",
        payload: {
          mealPlanId: "__demo_mealplan_1",
          requiredMeats: [
            { animal: "sheep", qty: 4 },
            { animal: "goat", qty: 2 }
          ]
        },
        favorite: cfg.domains.import.sessions.allowUserFavorites,
        schedule: null,
        createdAt: nowIso()
      }
    );
  }

  /* ------------------------------------------------------------------------ */
  /* WRITE TO DB                                                              */
  /* ------------------------------------------------------------------------ */
  await safePut(db.mealPlans, mealPlans);
  await safePut(db.cleaningSessions, cleaningSessions);
  await safePut(db.gardenPlans, gardenPlans);
  await safePut(db.gardenQueue, gardenCareQueue);
  await safePut(db.storehouseGoals, storehouseGoals);
  await safePut(db.animalPlans, animalPlans);
  await safePut(db.animalCare, animalCareTasks);
  await safePut(db.butcherySessions, butcherySessions);
  await safePut(db.importSessions, importSessions);

  // mark as seeded
  if (db.meta) {
    await db.meta.put({ id: "seeded-dev", value: true, at: nowIso() });
  }
}

// safe put utility so we don't crash when table is missing
async function safePut(table, items) {
  if (!table || !items || items.length === 0) return;
  try {
    await table.bulkPut(items);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[seeds.dev] bulkPut failed, trying one-by-one", err?.message || err);
    for (const item of items) {
      try {
        await table.put(item);
      } catch {
        // ignore
      }
    }
  }
}

export default {
  seedDev
};

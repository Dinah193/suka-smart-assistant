// C:\Users\larho\suka-smart-assistant\src\features\bookmarklet\generateBookmarklet.js
// Bookmarklet generator for Suka Smart Assistant imports
// -----------------------------------------------------------------------------
// GOALS (refreshed)
// 1. Work on many site kinds: recipes, Pinterest boards, seed/garden/nursery,
//    weekly ads / grocery / circulars, cleaning/chore blogs, animal/livestock pages,
//    butchery/meat-processing posts.
// 2. POST / dispatch into Suka using the *same* shared orchestration:
//       - DOM CustomEvent("import.queue.enqueue", { ... })
//       - window.__suka?.eventBus?.emit("import.queue.enqueue", { ... })
// 3. Let USERS save their own favorite sessions/schedules (NOT just yours):
//       - payload.saveAsFavorite = true
//       - payload.schedule / payload.session
// 4. Support reverse generation for “generate animal plan from recipes”,
//    “harvest from garden plan”, “butchery from animal plan”.
// 5. Map “grocery sections for inspiration” into a storehouse-stock style payload.
// 6. Keep offline/Sabbath guard: if the app tab isn’t open, stash to localStorage.
//
// UI can generate multiple bookmarklets:
//   - “Import Recipe”
//   - “Import Garden Plan”
//   - “Import Cleaning Plan”
//   - “Import Storehouse Stock”
// by calling generateBookmarklet({ forceImportType: "..." })
//
// -----------------------------------------------------------------------------

const BASE_STORAGE_KEY = "suka.bookmarklet.offlineQueue.v1";

// This is the code that will run IN THE TARGET PAGE.
function bookmarkletRuntime(opts = {}) {
  (function () {
    const SETTINGS = Object.assign(
      {
        sourceType: "bookmarklet",
        saveAsFavorite: false,
        autoSchedule: false,
        autoScheduleRule: "once+5min",
        forceImportType: null, // 👈 new: UI can force the import type
        reverseMeta: {
          shareTarget: "family-fund-hub",
          includeShare: true,
          format: "json",
        },
      },
      opts || {},
    );

    const isBrowser = typeof window !== "undefined";
    if (!isBrowser) return;

    // ----------------------------------------
    // tiny helpers
    // ----------------------------------------
    function textNodesUpTo(max = 80) {
      const ps = Array.from(document.querySelectorAll("p, li, article, section"));
      const out = [];
      for (let i = 0; i < ps.length; i += 1) {
        const t = (ps[i].textContent || "").trim();
        if (t) out.push(t);
        if (out.length >= max) break;
      }
      return out;
    }

    function guessCleaning(pageText) {
      return /clean|declutter|organize|bathroom|kitchen|laundry|mop|dust|chore/i.test(pageText);
    }

    function guessGardenCare(pageText) {
      return /water(ing)?|fertiliz(e|er)|mulch|prune|trellis|pest control|aphid|blight/i.test(pageText);
    }

    function guessHarvest(pageText) {
      return /harvest|when to pick|curing|drying|canning|fermenting|root cellar|storage/i.test(pageText);
    }

    function guessStorehouseStock(pageText, url) {
      return /weekly ad|circular|grocery|kroger|walmart|aldi|heb|publix|food lion|costco|sams/i.test(pageText) ||
        /weekly-ads?|circular|flyer/i.test(url);
    }

    function guessAnimalAcq(pageText, url) {
      return /livestock|goats?|sheep|lambs?|calves?|heifer|poultry|chickens?|ducks?|rabbits?/i.test(pageText) ||
        /farm|tractor|rural|agric|auction/i.test(url);
    }

    function guessButchery(pageText) {
      return /butcher|butchery|slaughter|meat cutting|cut sheet|processing|usda inspected|halal/i.test(pageText);
    }

    // ----------------------------------------
    // scrapePage → produces domain-aware payload
    // ----------------------------------------
    function scrapePage() {
      const d = document;
      const w = window;
      const sel =
        w.getSelection && w.getSelection().toString()
          ? w.getSelection().toString().trim()
          : d.getSelection && d.getSelection().toString()
            ? d.getSelection().toString().trim()
            : "";

      // base content
      const ogTitle = d.querySelector('meta[property="og:title"]')?.content;
      const ogUrl = d.querySelector('meta[property="og:url"]')?.content;
      const ogImg = d.querySelector('meta[property="og:image"]')?.content;
      const ogDesc = d.querySelector('meta[property="og:description"]')?.content;
      const hostname = w.location.hostname || "";
      const href = w.location.href || "";

      // list items — we will repurpose for seeds, ingredients, sections
      const listItems = Array.from(d.querySelectorAll("li, .ingredient, .ingredients li"))
        .map((el) => (el.textContent || "").trim())
        .filter((t) => t && t.length < 190)
        .slice(0, 80);

      // full-page text to detect domain intent
      const pageSnippets = textNodesUpTo(120);
      const pageText = pageSnippets.join("\n").toLowerCase();

      // ----------------------------------------
      // DETECT TYPE
      // ----------------------------------------
      let detectedType = "recipe";

      // 1) allow the UI to force it
      if (SETTINGS.forceImportType) {
        detectedType = SETTINGS.forceImportType;
      } else {
        // 2) pinterest → planner
        if (/pinterest\.com/i.test(hostname)) {
          detectedType = "mealPlan";
        }
        // 3) seed/garden sites
        else if (/seed|nursery|garden|grow|burpee|johnnyseeds|backyardgardener|gardeningknowhow/i.test(href)) {
          // decide between planning vs care
          if (guessGardenCare(pageText)) {
            detectedType = "gardenCare";
          } else if (guessHarvest(pageText)) {
            detectedType = "harvestPlan";
          } else {
            detectedType = "gardenPlan";
          }
        }
        // 4) weekly ads/grocery → storehouse stock
        else if (guessStorehouseStock(pageText, href)) {
          detectedType = "storehouseStock";
        }
        // 5) cleaning/chore blogs
        else if (guessCleaning(pageText)) {
          detectedType = "cleaningPlan";
        }
        // 6) animal / livestock pages
        else if (guessAnimalAcq(pageText, href)) {
          detectedType = "animalAcquisition";
        }
        // 7) butchery / meat processing
        else if (guessButchery(pageText)) {
          detectedType = "butcherySession";
        }
        // 8) youtube/weird recipe pages → fall back to recipe
        else if (/youtube\.com|youtu\.be/i.test(hostname)) {
          detectedType = "recipe";
        }
        // 9) allrecipes, loveandlemons, etc. → recipe
        else if (/allrecipes\.com|loveandlemons\.com|foodnetwork\.com|seriouseats\.com|eatingwell\.com/i.test(hostname)) {
          detectedType = "recipe";
        }
      }

      // ----------------------------------------
      // BASE PAYLOAD
      // ----------------------------------------
      const payload = {
        __importType: detectedType,
        title: d.title || ogTitle || "Imported Page",
        url: href,
        source: {
          kind: "bookmarklet",
          url: href,
          title: d.title || ogTitle || "",
          hostname,
          og: {
            title: ogTitle,
            url: ogUrl,
            image: ogImg,
            description: ogDesc,
          },
        },
        meta: {
          selectedText: sel,
          timestamp: Date.now(),
        },
        saveAsFavorite: SETTINGS.saveAsFavorite,
        reverseMeta: Object.assign(
          {
            reverseFromId: null
          },
          SETTINGS.reverseMeta || {},
        ),
      };

      // ----------------------------------------
      // PER-TYPE SHAPES
      // ----------------------------------------

      // RECIPE
      if (detectedType === "recipe") {
        payload.ingredients = listItems;
        // try to get steps from paragraphs
        const paras = Array.from(d.querySelectorAll("p"))
          .map((p) => p.textContent.trim())
          .filter(Boolean)
          .slice(0, 40);
        payload.steps = paras.length ? paras : sel ? [sel] : [];
        // animal reverse possible
        payload.usesAnimalProduct =
          /beef|lamb|goat|mutton|chicken|turkey|duck|fish|eggs?|cheese|milk/i.test(pageText) || false;
      }

      // MEAL PLAN (pinterest board → meal idea)
      if (detectedType === "mealPlan") {
        payload.days = [
          {
            date: null,
            meals: [ogTitle || d.title || "Meal Idea"],
          },
        ];
        payload.collaborative = true; // multi-household sharing
      }

      // GARDEN PLAN
      if (detectedType === "gardenPlan") {
        payload.seeds = listItems.map((name) => ({ name }));
        payload.zone = null;
        payload.coop = true;
        payload.careProfile = null;
      }

      // GARDEN CARE
      if (detectedType === "gardenCare") {
        payload.zones = [
          {
            id: "default",
            name: "Garden Zone",
            tasks: listItems.length ? listItems : ["Water", "Fertilize", "Inspect for pests"],
          },
        ];
        payload.cadence = "2x/week";
      }

      // HARVEST PLAN
      if (detectedType === "harvestPlan") {
        payload.crops = listItems.map((crop) => ({
          crop,
          expectedDate: null,
          quantity: null,
          unit: null,
          toStorehouse: true,
          preserveMethod: /can|ferment|dry|freeze/i.test(pageText) ? "preserve" : null,
        }));
      }

      // CLEANING PLAN
      if (detectedType === "cleaningPlan") {
        payload.rooms = [
          {
            name: "Home",
            tasks: listItems.length ? listItems : ["Clear surfaces", "Vacuum", "Mop", "Bathrooms"],
            supplies: ["All-purpose cleaner", "Microfiber cloths"],
          },
        ];
        payload.cadence = /weekly|every week/i.test(pageText) ? "weekly" : "daily";
        payload.batchable = true;
      }

      // STOREHOUSE STOCK (grocery sections)
      if (detectedType === "storehouseStock") {
        // try to bucket list items into grocery-ish sections
        const sections = [];
        const produce = [];
        const dairy = [];
        const meat = [];
        const dry = [];
        const freezer = [];
        listItems.forEach((it) => {
          const low = it.toLowerCase();
          if (/lettuce|onion|pepper|apple|banana|greens?|tomato|potato|carrot/.test(low)) produce.push(it);
          else if (/milk|cheese|butter|yogurt|cream/.test(low)) dairy.push(it);
          else if (/beef|chicken|lamb|goat|turkey|fish|pork/.test(low)) meat.push(it);
          else if (/rice|beans|flour|cornmeal|pasta|oats?/.test(low)) dry.push(it);
          else freezer.push(it);
        });
        if (produce.length)
          sections.push({
            section: "produce",
            items: produce.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null })),
          });
        if (dairy.length)
          sections.push({
            section: "dairy",
            items: dairy.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null })),
          });
        if (meat.length)
          sections.push({
            section: "meat",
            items: meat.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: "freeze" })),
          });
        if (dry.length)
          sections.push({
            section: "pantry",
            items: dry.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null })),
          });
        if (freezer.length)
          sections.push({
            section: "frozen-or-other",
            items: freezer.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: "freeze" })),
          });
        payload.sections = sections.length
          ? sections
          : [
              {
                section: "general",
                items: listItems.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null })),
              },
            ];
      }

      // ANIMAL ACQUISITION
      if (detectedType === "animalAcquisition") {
        payload.needs = listItems.length
          ? listItems.map((line) => {
              const low = line.toLowerCase();
              const guessSpecies =
                /goat/.test(low) ? "goat" :
                /sheep|lamb/.test(low) ? "sheep" :
                /chicken|poultry|hen/.test(low) ? "chicken" :
                /duck/.test(low) ? "duck" :
                /rabbit/.test(low) ? "rabbit" : "livestock";
              return {
                species: guessSpecies,
                breed: null,
                qty: null,
                reason: "Imported from page",
                targetDate: null,
              };
            })
          : [
              {
                species: "livestock",
                breed: null,
                qty: null,
                reason: "Imported from page",
                targetDate: null,
              },
            ];
      }

      // BUTCHERY SESSION
      if (detectedType === "butcherySession") {
        payload.animals = [
          {
            species: "livestock",
            qty: null,
            cuts: [],
          },
        ];
        payload.processingTasks = listItems.length
          ? listItems
          : ["slaughter", "eviscerate", "quarter", "grind", "pack", "freeze"];
        payload.links = {
          recipes: [],
          mealPlans: [],
          storehouseGoals: [],
          inventoryUpdates: [],
        };
      }

      // auto schedule?
      if (SETTINGS.autoSchedule) {
        payload.schedule = {
          rule: SETTINGS.autoScheduleRule,
          createdAt: Date.now(),
        };
      }

      // sessions: for cleaning/garden-care/butchery/storehouse we can attach right now
      if (
        detectedType === "cleaningPlan" ||
        detectedType === "gardenCare" ||
        detectedType === "harvestPlan" ||
        detectedType === "storehouseStock" ||
        detectedType === "butcherySession" ||
        detectedType === "animalAcquisition"
      ) {
        payload.session = {
          kind:
            detectedType === "cleaningPlan"
              ? "cleaning"
              : detectedType === "gardenCare"
                ? "garden-care"
                : detectedType === "harvestPlan"
                  ? "garden-harvest"
                  : detectedType === "storehouseStock"
                    ? "storehouse-restock"
                    : detectedType === "butcherySession"
                      ? "butchery"
                      : "inventory-sync",
          date: null,
          recurring: null,
          tasks: listItems.slice(0, 20),
        };
      }

      return payload;
    }

    // ----------------------------------------
    // deliver to Suka
    // ----------------------------------------
    function sendToSukaApp(payload) {
      let delivered = false;

      // 1) DOM custom event
      try {
        const ev = new CustomEvent("import.queue.enqueue", {
          detail: {
            sourceType: payload.__importType === "mealPlan" ? "pinterest" : "bookmarklet",
            payload,
            opts: {
              saveAsFavorite: !!payload.saveAsFavorite,
              schedule: payload.schedule || null,
              session: payload.session || null,
              label: payload.title,
            },
          },
        });
        window.dispatchEvent(ev);
        delivered = true;
      } catch (err) {
        // swallow
      }

      // 2) event bus
      try {
        if (window.__suka?.eventBus?.emit) {
          window.__suka.eventBus.emit("import.queue.enqueue", {
            sourceType: payload.__importType === "mealPlan" ? "pinterest" : "bookmarklet",
            payload,
            opts: {
              saveAsFavorite: !!payload.saveAsFavorite,
              schedule: payload.schedule || null,
              session: payload.session || null,
              label: payload.title,
            },
          });
          delivered = true;
        }
      } catch (err2) {
        // swallow
      }

      // 3) offline queue
      if (!delivered) {
        try {
          const raw = window.localStorage.getItem(BASE_STORAGE_KEY);
          const arr = raw ? JSON.parse(raw) : [];
          arr.unshift({
            at: Date.now(),
            payload,
          });
          window.localStorage.setItem(BASE_STORAGE_KEY, JSON.stringify(arr.slice(0, 50)));
          alert("Suka: App not open → saved import locally. Open Suka to pull it in.");
        } catch {
          alert("Suka: Unable to deliver import.");
        }
      } else {
        alert("Suka: Import sent!");
      }
    }

    const payload = scrapePage();
    sendToSukaApp(payload);
  })();
}

// -----------------------------------------------------------------------------
// generate bookmarklet string
// -----------------------------------------------------------------------------
export function generateBookmarklet({
  defaultSource = "bookmarklet",
  saveAsFavorite = false,
  autoSchedule = false,
  autoScheduleRule = "once+5min",
  forceImportType = null, // 👈 new
  reverseMeta = {
    shareTarget: "family-fund-hub",
    includeShare: true,
    format: "json",
  },
} = {}) {
  const fnString = bookmarkletRuntime
    .toString()
    .replace(
      "function bookmarkletRuntime(opts = {}) {",
      `function bookmarkletRuntime(opts = ${JSON.stringify(
        {
          sourceType: defaultSource,
          saveAsFavorite,
          autoSchedule,
          autoScheduleRule,
          forceImportType,
          reverseMeta,
        },
      )}) {`,
    );

  const wrapped = `javascript:(${fnString})();`;
  return wrapped;
}

// -----------------------------------------------------------------------------
// helper to replay offline bookmarklet items
// -----------------------------------------------------------------------------
export function replayOfflineBookmarklets() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(BASE_STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    arr.forEach(({ payload }) => {
      window.dispatchEvent(
        new CustomEvent("import.queue.enqueue", {
          detail: {
            sourceType: payload.__importType === "mealPlan" ? "pinterest" : "bookmarklet",
            payload,
            opts: {
              saveAsFavorite: !!payload.saveAsFavorite,
              schedule: payload.schedule || null,
              session: payload.session || null,
              label: payload.title,
            },
          },
        }),
      );
    });
    window.localStorage.removeItem(BASE_STORAGE_KEY);
    return arr;
  } catch {
    return [];
  }
}

/*
HOW THIS TIES TO THE REST (latest):

✓ Cleaning, Garden planning, Care & Harvest, Storehouse Stock (grocery-inspired),
  Meal planning, Animal acquisition, care, BUTCHERY:
   - all detected and mapped to __importType
   - all can ship schedule + session to your local automation runtime

✓ Users can save their own favorite sessions/schedules:
   - saveAsFavorite: true in payload
   - your ImportNormalizer → FavoriteStore takes over

✓ Reverse generation:
   - reverseMeta in Base
   - per-page detection (e.g. recipe → animal plan later)

✓ Shared orchestration:
   - dispatch DOM "import.queue.enqueue"
   - emit eventBus "import.queue.enqueue"
   - offline replay

✓ Consider well executed sites:
   - og:*, list items, selected text, url/host detection
   - grocery-like pages → storehouseStock.sections
*/

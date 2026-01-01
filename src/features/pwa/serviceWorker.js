// C:\Users\larho\suka-smart-assistant\src\features\pwa\serviceWorker.js
// Suka Smart Assistant – PWA Service Worker (expanded domains)
// -----------------------------------------------------------------------------
// GOALS (from your project, refreshed for Oct 30 2025):
// 1. Offline-resilient, Sabbath-guardable imports for *all* household domains:
//    - cooking / recipes / meal plans
//    - cleaning plans (rooms/zones/batch cleaning)
//    - garden planning (seeds/beds), garden *care* (watering/fertilizing/pest)
//    - harvest plans (what to pick, when, and send-to-storehouse)
//    - storehouse stock planning (grocery sections for inspiration)
//    - animal acquisition, animal care, butchery / processing days
//    - inventory updates (CSV/PDF from scan-compare-trust)
// 2. SHARE TARGET posts must land in EXACTLY the same import pipeline as:
//    - bookmarklet
//    - browser extension
//    - in-app ImportLanding / ImportQueueManager
// 3. Users can save THEIR OWN favorite sessions and schedules — even offline.
//    → we store { saveAsFavorite, schedule, session, reverseMeta } INTACT.
// 4. Reverse generation must be kept → payload.reverseMeta stays in IndexedDB.
// 5. Shared orchestration → SW stores, pages replay and emit
//    "import.queue.enqueue", "import.preview.open", "automation.schedule.request".
// 6. Consider well executed websites → cache-first shell, network-first JSON,
//    explicit versioning, SW↔page broadcast messages.
//
// IMPORTANT
// - Framework-agnostic.
// - IndexedDB first; localStorage fallback only if nothing else is available.
// - This file now knows about your new import types from ImportTypes.schema.json
//   and bookmarklet/bookmarklet.min.js updates.
//
// -----------------------------------------------------------------------------
const CACHE_VERSION = "suka-pwa-v2"; // bumped for new domains
const APP_SHELL_CACHE = `suka-shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `suka-runtime-${CACHE_VERSION}`;
const OFFLINE_IMPORTS_DB = "suka-offline-imports-db";
const OFFLINE_IMPORTS_STORE = "imports";

const APP_SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/icons/suka-192.png",
  "/icons/suka-512.png",
  // add your main js/css here if needed
  // "/assets/index.js",
  // "/assets/index.css"
];

// -----------------------------------------------------------------------------
// tiny IndexedDB helper
// -----------------------------------------------------------------------------
function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!self.indexedDB) {
      resolve(null);
      return;
    }
    const req = indexedDB.open(OFFLINE_IMPORTS_DB, 2);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(OFFLINE_IMPORTS_STORE)) {
        db.createObjectStore(OFFLINE_IMPORTS_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbAddImport(payload) {
  const db = await idbOpen();
  if (!db) {
    // fallback localStorage (best-effort)
    const key = "suka.pwa.offlineImports.v1";
    try {
      const existing = JSON.parse((self.localStorage && self.localStorage.getItem(key)) || "[]");
      existing.unshift(payload);
      if (self.localStorage) {
        self.localStorage.setItem(key, JSON.stringify(existing.slice(0, 100)));
      }
    } catch {
      // ignore
    }
    return;
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_IMPORTS_STORE, "readwrite");
    tx.objectStore(OFFLINE_IMPORTS_STORE).add(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAllImports() {
  const db = await idbOpen();
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_IMPORTS_STORE, "readonly");
    const store = tx.objectStore(OFFLINE_IMPORTS_STORE);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function idbClearImports() {
  const db = await idbOpen();
  if (!db) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OFFLINE_IMPORTS_STORE, "readwrite");
    tx.objectStore(OFFLINE_IMPORTS_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -----------------------------------------------------------------------------
// broadcast helper (SW → pages)
// -----------------------------------------------------------------------------
function broadcastToClients(msg) {
  if (!self.clients || !self.clients.matchAll) return;
  self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    clients.forEach((client) => {
      client.postMessage(msg);
    });
  });
}

// -----------------------------------------------------------------------------
// INSTALL
// -----------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS);
    }),
  );
  self.skipWaiting();
});

// -----------------------------------------------------------------------------
// ACTIVATE
// -----------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (!key.includes(CACHE_VERSION)) {
            return caches.delete(key);
          }
          return null;
        }),
      ),
    ),
  );
  self.clients.claim();
});

// -----------------------------------------------------------------------------
// FETCH
// -----------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // handle PWA share target POSTs
  if (url.pathname === "/import/share-capture" && req.method === "POST") {
    event.respondWith(handleShareTargetPost(event));
    return;
  }

  // app shell → cache first
  if (req.method === "GET" && APP_SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches.match(req).then((res) => {
        return (
          res ||
          fetch(req).then((netRes) => {
            return caches.open(APP_SHELL_CACHE).then((cache) => {
              cache.put(req, netRes.clone());
              return netRes;
            });
          })
        );
      }),
    );
    return;
  }

  // runtime: network first, fallback to cache
  if (req.method === "GET" && url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((netRes) => {
          const clone = netRes.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, clone));
          return netRes;
        })
        .catch(() => caches.match(req)),
    );
    return;
  }
});

// -----------------------------------------------------------------------------
// HANDLE SHARE TARGET POST
// -----------------------------------------------------------------------------
async function handleShareTargetPost(event) {
  try {
    const formData = await event.request.formData();
    const title = formData.get("title");
    const text = formData.get("text");
    const url = formData.get("url");
    const files = formData.getAll("files");

    // Build an import payload consistent with bookmarklet & extension
    const inferredType = inferImportTypeFromShare({ title, text, url, files });

    const payload = {
      __importType: inferredType,
      title: title || text || "Shared item",
      source: {
        kind: "pwa-share",
        url,
        title
      },
      meta: {
        text,
        files: files.map((f) => f.name),
        sharedAt: Date.now()
      },
      // user-first flags (they can toggle in UI later)
      saveAsFavorite: false,
      reverseMeta: {
        shareTarget: "family-fund-hub",
        includeShare: true,
        format: "json",
        reverseFromId: null
      }
    };

    // shape per domain
    shapePayloadByType(payload, { title, text, url, files });

    // store offline first
    await idbAddImport(payload);

    // notify any open pages
    broadcastToClients({
      type: "pwa-share-received",
      payload
    });

    // redirect back to app capture
    return Response.redirect("/import/share-capture?ok=1", 303);
  } catch (err) {
    return new Response("Share capture failed", { status: 500 });
  }
}

// -----------------------------------------------------------------------------
// TYPE INFERENCE (PWA SHARE)
// -----------------------------------------------------------------------------
function inferImportTypeFromShare({ title, text, url, files }) {
  const lower = (title || text || url || "").toLowerCase();

  // pinterest → meal plan
  if (lower.includes("pinterest.com")) return "mealPlan";

  // cleaning / chore blogs
  if (/clean|declutter|organize|bathroom|kitchen|laundry|mop|dust|chore/i.test(lower)) {
    return "cleaningPlan";
  }

  // garden planning / care / harvest
  if (/seed|garden|nursery|burpee|johnnyseeds|grow|raised bed/i.test(lower)) {
    // care vs harvest?
    if (/water|fertiliz|pest control|prune|trellis|mulch/i.test(lower)) return "gardenCare";
    if (/harvest|curing|canning|preserving|fermenting|root cellar/i.test(lower)) return "harvestPlan";
    return "gardenPlan";
  }

  // grocery circulars / store ads → storehouse stock
  if (/weekly ad|circular|grocery|kroger|walmart|aldi|heb|publix|food lion|costco|sams/i.test(lower)) {
    return "storehouseStock";
  }

  // animal / livestock pages → acquisition
  if (/livestock|goats?|sheep|lambs?|calves?|heifer|poultry|chickens?|ducks?|rabbits?/i.test(lower)) {
    return "animalAcquisition";
  }

  // butchery / processing
  if (/butcher|butchery|slaughter|meat cutting|cut sheet|processing|usda inspected|halal/i.test(lower)) {
    return "butcherySession";
  }

  // file-based? let the app coerce later
  if (files && files.length) {
    return "inventoryUpdate";
  }

  // recipe-like
  if (lower.includes("recipe") || lower.includes("ingredients")) return "recipe";

  // default
  return "recipe";
}

// -----------------------------------------------------------------------------
// DOMAIN SHAPER
// -----------------------------------------------------------------------------
function shapePayloadByType(payload, ctx) {
  const t = payload.__importType;
  const text = ctx.text || "";
  const title = ctx.title || "";
  const lowerText = text.toLowerCase();

  // RECIPE
  if (t === "recipe") {
    payload.ingredients = text
      ? text.split(/\n|\r/).filter(Boolean).slice(0, 40)
      : [];
  }

  // MEAL PLAN
  if (t === "mealPlan") {
    payload.days = [
      {
        date: null,
        meals: [title || "Shared Meal"]
      }
    ];
    payload.collaborative = true;
  }

  // CLEANING
  if (t === "cleaningPlan") {
    const lines = text ? text.split(/\n|\r/).filter(Boolean) : [];
    payload.rooms = [
      {
        name: "Home",
        tasks: lines.length ? lines : ["Clear surfaces", "Vacuum", "Mop", "Bathrooms"],
        supplies: ["All-purpose cleaner", "Microfiber cloths"]
      }
    ];
    payload.cadence = /weekly|every week/i.test(lowerText) ? "weekly" : "daily";
    payload.batchable = true;
    payload.session = {
      kind: "cleaning",
      date: null,
      recurring: payload.cadence,
      tasks: payload.rooms[0].tasks.slice(0, 30)
    };
  }

  // GARDEN PLAN
  if (t === "gardenPlan") {
    const lines = text ? text.split(/\n|\r/).filter(Boolean) : [];
    payload.seeds = lines.map((name) => ({ name }));
    payload.zone = null;
    payload.coop = true;
    payload.careProfile = null;
  }

  // GARDEN CARE
  if (t === "gardenCare") {
    const lines = text ? text.split(/\n|\r/).filter(Boolean) : [];
    payload.zones = [
      {
        id: "default",
        name: "Garden Zone",
        tasks: lines.length ? lines : ["Water", "Fertilize", "Inspect for pests"]
      }
    ];
    payload.cadence = "2x/week";
    payload.session = {
      kind: "garden-care",
      date: null,
      recurring: "2x/week",
      tasks: payload.zones[0].tasks.slice(0, 20)
    };
  }

  // HARVEST PLAN
  if (t === "harvestPlan") {
    const lines = text ? text.split(/\n|\r/).filter(Boolean) : [];
    payload.crops = lines.map((crop) => ({
      crop,
      expectedDate: null,
      quantity: null,
      unit: null,
      toStorehouse: true,
      preserveMethod: /can|ferment|dry|freeze/i.test(lowerText) ? "preserve" : null
    }));
    payload.session = {
      kind: "garden-harvest",
      date: null,
      recurring: null,
      tasks: lines.slice(0, 20)
    };
  }

  // STOREHOUSE STOCK (grocery sections)
  if (t === "storehouseStock") {
    const lines = text ? text.split(/\n|\r/).filter(Boolean) : [];
    const sections = bucketToGrocerySections(lines);
    payload.sections = sections;
    payload.session = {
      kind: "storehouse-restock",
      date: null,
      recurring: "weekly",
      tasks: lines.slice(0, 30)
    };
  }

  // ANIMAL ACQUISITION
  if (t === "animalAcquisition") {
    const lines = text ? text.split(/\n|\r/).filter(Boolean) : [];
    payload.needs =
      lines.length
        ? lines.map((line) => {
            const low = line.toLowerCase();
            const species =
              /goat/.test(low) ? "goat" :
              /sheep|lamb/.test(low) ? "sheep" :
              /chicken|poultry|hen/.test(low) ? "chicken" :
              /duck/.test(low) ? "duck" :
              /rabbit/.test(low) ? "rabbit" : "livestock";
            return {
              species,
              breed: null,
              qty: null,
              reason: "Imported from PWA share",
              targetDate: null
            };
          })
        : [
            {
              species: "livestock",
              breed: null,
              qty: null,
              reason: "Imported from PWA share",
              targetDate: null
            }
          ];
    payload.session = {
      kind: "inventory-sync",
      date: null,
      recurring: null,
      tasks: []
    };
  }

  // BUTCHERY SESSION
  if (t === "butcherySession") {
    const lines = text ? text.split(/\n|\r/).filter(Boolean) : [];
    payload.animals = [
      {
        species: "livestock",
        qty: null,
        cuts: []
      }
    ];
    payload.processingTasks = lines.length
      ? lines
      : ["slaughter", "eviscerate", "quarter", "grind", "pack", "freeze"];
    payload.links = {
      recipes: [],
      mealPlans: [],
      storehouseGoals: [],
      inventoryUpdates: []
    };
    payload.session = {
      kind: "butchery",
      date: null,
      recurring: null,
      tasks: payload.processingTasks.slice(0, 30)
    };
  }

  // INVENTORY UPDATE
  if (t === "inventoryUpdate") {
    payload.updates = [];
  }
}

// helper: bucket grocery-like lines to sections
function bucketToGrocerySections(lines) {
  const sections = [];
  const produce = [], dairy = [], meat = [], dry = [], freezer = [];
  lines.forEach((it) => {
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
      items: produce.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null }))
    });
  if (dairy.length)
    sections.push({
      section: "dairy",
      items: dairy.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null }))
    });
  if (meat.length)
    sections.push({
      section: "meat",
      items: meat.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: "freeze" }))
    });
  if (dry.length)
    sections.push({
      section: "pantry",
      items: dry.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null }))
    });
  if (freezer.length)
    sections.push({
      section: "frozen-or-other",
      items: freezer.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: "freeze" }))
    });
  if (!sections.length) {
    sections.push({
      section: "general",
      items: lines.map((item) => ({ item, targetQty: null, unit: null, preserveMethod: null }))
    });
  }
  return sections;
}

// -----------------------------------------------------------------------------
// SYNC
// -----------------------------------------------------------------------------
self.addEventListener("sync", (event) => {
  if (event.tag === "suka-sync-imports") {
    event.waitUntil(flushOfflineImports());
  }
});

async function flushOfflineImports() {
  const items = await idbGetAllImports();
  if (!items.length) return;
  broadcastToClients({
    type: "pwa-offline-imports",
    items
  });
  await idbClearImports();
}

// -----------------------------------------------------------------------------
// MESSAGE (page → SW)
// -----------------------------------------------------------------------------
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data && data.type === "suka:get-offline-imports") {
    idbGetAllImports().then((items) => {
      event.source?.postMessage({
        type: "suka:offline-imports",
        items
      });
    });
  }
});

# Suka Smart Assistant – Adapters & Parsers
**File:** `C:\Users\larho\suka-smart-assistant\src\docs\adapters-and-parsers.md`  
**Version:** 2025-10-31  
**Purpose:** define a *single* adapter/parsing strategy for **all** incoming content – cleaning, garden (plan/care/harvest), storehouse stock planning (grocery sections), meal planning/cooking, and animal acquisition/care/butchery – so:
1. users can save **their own** favorite sessions & schedules (not only system ones),
2. every parsed thing can be **scheduled** via `automation.schedule.request`,
3. every parsed thing can **trigger reverse generation** (recipes→animals, recipes→garden, harvest→storehouse, storehouse→cleaning, animals→meals/storehouse),
4. everything respects your **shared orchestration** updates (the runtime remaps domain events into the central scheduler),
5. and the DX looks like “well executed websites”: small adapters, declarative parsers, consistent envelopes.

This doc is the **spec** for writing new adapters/parsers used by:

- `src/workers/import.worker.js`
- `src/workers/importQueue.worker.js`
- `src/features/import/ImportService.js`
- `src/features/import/ImportRouter.js`
- bookmarklet & mobile share flows
- home page generators (garden from seeds, animal plan from recipes)

---

## 1. Core idea: “Everything becomes a Domain Envelope”

No matter what we scrape or receive, we **always** want to end up here:

```ts
type DomainEnvelope =
  | CleaningEnvelope
  | GardenEnvelope
  | GardenHarvestEnvelope
  | StorehouseEnvelope
  | MealEnvelope
  | AnimalEnvelope;

interface BaseEnvelope {
  source: "import" | "bookmarklet" | "mobile-share" | "api" | "internal";
  domain: "cleaning" | "garden" | "harvest" | "storehouse" | "meals" | "animals";
  raw: any;              // original scraped payload
  normalized: any;       // domain-shaped object
  meta?: {
    favoriteMe?: boolean;
    scheduleMe?: boolean;
    reverse?: boolean;
    fromSite?: string;
    fromUser?: string;
    tags?: string[];
    confidence?: number;
  };
}
Why: because your automation runtime now listens for automation.schedule.request and can persist user schedules for all domains.

2. One adapter ⇒ many parsers
We split responsibilities:

Adapter = “where did this come from & in what format?”

example: allrecipes, pinterest, generic-recipe, gardener-blog, pantry-prepper-blog, homestead-butcher-notes, suka-share-payload, bookmarklet-page-scrape

outputs: { site, html?, json?, text?, url?, title? }

Parser = “what domain object should this be?”

example: parseMealFromAllrecipes, parseGardenFromSeedBlog, parseStorehouseFromPrepperPost, parseCleaningFromDeclutterPost, parseAnimalsFromButcheryPost

outputs: one of the envelopes above

This doc defines both halves so every new contributor can add adapters/parsers without breaking your orchestration.

3. Adapter contract
Create a folder like:

text
Copy code
src/adapters/
  index.js
  meal.allrecipes.js
  meal.generic.js
  garden.seed-blog.js
  garden.care-blog.js
  storehouse.prepper.js
  cleaning.declutter.js
  animals.butchery.js
Adapter shape:

ts
Copy code
export interface AdapterResult {
  site: string;
  title?: string;
  url?: string;
  html?: string;
  text?: string;
  raw?: any;
  guess?: "meals" | "garden" | "harvest" | "cleaning" | "storehouse" | "animals";
  meta?: Record<string, any>;
}
Example – meal from Allrecipes:

js
Copy code
// src/adapters/meal.allrecipes.js
export async function fromAllrecipes(doc = document) {
  const title = doc.querySelector("h1")?.textContent?.trim() || document.title;
  const ingredients = [...doc.querySelectorAll(".ingredients-item")].map((li) => li.textContent.trim());
  const steps = [...doc.querySelectorAll(".instructions-section li")].map((li) => li.textContent.trim());

  return {
    site: "allrecipes.com",
    title,
    url: location.href,
    text: doc.body?.innerText?.slice(0, 2000) || "",
    raw: { ingredients, steps },
    guess: "meals",
    meta: { favoriteMe: true },
  };
}
4. Parser contract (domain-aware)
Parsers live in src/parsers/ and take an AdapterResult + optional context (geo, household profile, user settings) and return a DomainEnvelope.

Base parser signature:

ts
Copy code
export interface ParseContext {
  geo?: { region?: string; lat?: number; lon?: number };
  household?: any;
  source?: string;
}

export type ParserFn = (adapter: AdapterResult, ctx?: ParseContext) => DomainEnvelope | null;
We define 5 main parsers (for your 5 domains) + 1 for harvest.

4.1 Meals / cooking parser
js
Copy code
// src/parsers/parseMeals.js
export function parseMeals(adapter, ctx = {}) {
  if (!adapter) return null;

  const base = {
    source: adapter.meta?.source || "import",
    domain: "meals",
    raw: adapter,
    meta: {
      favoriteMe: adapter.meta?.favoriteMe ?? true,
      scheduleMe: true,
      reverse: true, // ✅ recipes→animals & recipes→garden
      fromSite: adapter.site,
      tags: ["imported", "meals"],
      confidence: adapter.meta?.confidence ?? 0.8,
    },
  };

  // normalize
  const normalized = {
    title: adapter.title || "Imported Recipe / Meal",
    recipes: adapter.raw?.ingredients ? [adapter] : [],
    url: adapter.url,
    inventoryAware: true,
  };

  return {
    ...base,
    normalized,
  };
}
Notes:

we flag reverse: true so the worker can send:

reverse.action.request { kind: "recipes→animals" }

reverse.action.request { kind: "recipes→garden" }

4.2 Garden (plan / care)
js
Copy code
// src/parsers/parseGarden.js
export function parseGarden(adapter, ctx = {}) {
  if (!adapter) return null;

  // detect harvest vs plan
  const text = (adapter.text || "").toLowerCase();
  const isHarvest = adapter.guess === "harvest" || text.includes("harvest");

  const base = {
    source: adapter.meta?.source || "import",
    domain: isHarvest ? "harvest" : "garden",
    raw: adapter,
    meta: {
      favoriteMe: adapter.meta?.favoriteMe ?? true,
      scheduleMe: true,
      reverse: true, // ✅ harvest→storehouse
      fromSite: adapter.site,
      tags: ["imported", isHarvest ? "harvest" : "garden"],
      confidence: adapter.meta?.confidence ?? 0.8,
    },
  };

  if (isHarvest) {
    return {
      ...base,
      normalized: {
        crop: adapter.raw?.crop || adapter.title || "harvested-produce",
        qty: adapter.raw?.qty || null,
        unit: adapter.raw?.unit || null,
        harvestedAt: Date.now(),
      },
    };
  }

  // garden plan / care
  return {
    ...base,
    normalized: {
      variety: adapter.raw?.variety || adapter.title || "Garden Item",
      sowingWindow: adapter.raw?.sowingWindow || null,
      spacing: adapter.raw?.spacing || null,
      beds: adapter.raw?.beds || [],
      care: adapter.raw?.care || [],
      geo: ctx.geo || null,
    },
  };
}
4.3 Storehouse (with grocery sections)
js
Copy code
// src/parsers/parseStorehouse.js
const DEFAULT_SECTIONS = [
  "produce",
  "dairy-eggs",
  "meat-seafood",
  "frozen",
  "dry-goods",
  "baking",
  "condiments",
  "fermenting/preserving",
  "bulk",
  "cleaning-supplies",
];

export function parseStorehouse(adapter, ctx = {}) {
  if (!adapter) return null;

  return {
    source: adapter.meta?.source || "import",
    domain: "storehouse",
    raw: adapter,
    meta: {
      favoriteMe: adapter.meta?.favoriteMe ?? true,
      scheduleMe: true,
      reverse: true, // ✅ storehouse→cleaning
      fromSite: adapter.site,
      tags: ["imported", "storehouse"],
      confidence: adapter.meta?.confidence ?? 0.8,
    },
    normalized: {
      name: adapter.title || "Storehouse Goal",
      targetDays: adapter.raw?.targetDays || 30,
      sections: adapter.raw?.sections?.length ? adapter.raw.sections : DEFAULT_SECTIONS.map((name) => ({ name })),
      note: adapter.text || null,
    },
  };
}
4.4 Cleaning
js
Copy code
// src/parsers/parseCleaning.js
export function parseCleaning(adapter, ctx = {}) {
  if (!adapter) return null;

  return {
    source: adapter.meta?.source || "import",
    domain: "cleaning",
    raw: adapter,
    meta: {
      favoriteMe: adapter.meta?.favoriteMe ?? true,
      scheduleMe: true,
      reverse: true, // ✅ storehouse→cleaning may land here too
      fromSite: adapter.site,
      tags: ["imported", "cleaning"],
      confidence: adapter.meta?.confidence ?? 0.75,
    },
    normalized: {
      routineType: adapter.raw?.routineType || "standard",
      declutterFirst: /declutter|5-bin|5 bin/i.test(adapter.text || ""),
      zones: adapter.raw?.zones || ["entry", "kitchen", "bathroom"],
      cadence: adapter.raw?.cadence || "daily",
    },
  };
}
4.5 Animals / butchery
js
Copy code
// src/parsers/parseAnimals.js
export function parseAnimals(adapter, ctx = {}) {
  if (!adapter) return null;

  return {
    source: adapter.meta?.source || "import",
    domain: "animals",
    raw: adapter,
    meta: {
      favoriteMe: adapter.meta?.favoriteMe ?? true,
      scheduleMe: true,
      reverse: true, // ✅ animals→meals & animals→storehouse
      fromSite: adapter.site,
      tags: ["imported", "animals"],
      confidence: adapter.meta?.confidence ?? 0.7,
    },
    normalized: {
      title: adapter.title || "Animal / Butchery Plan",
      species: adapter.raw?.species || "sheep",
      count: adapter.raw?.count || 1,
      includeBreeds: true,
      includeMeatEstimates: true,
      region: ctx.geo?.region || null,
    },
  };
}
5. Central adapter→parser dispatcher
We now define a single dispatcher used by your workers:

js
Copy code
// src/parsers/index.js
import { parseMeals } from "./parseMeals";
import { parseGarden } from "./parseGarden";
import { parseStorehouse } from "./parseStorehouse";
import { parseCleaning } from "./parseCleaning";
import { parseAnimals } from "./parseAnimals";

export function dispatchParse(adapter, ctx = {}) {
  const guess = adapter.guess || adapter.meta?.domain || "auto";

  switch (guess) {
    case "meals":
    case "mealplan":
    case "recipe":
      return parseMeals(adapter, ctx);
    case "garden":
    case "harvest":
      return parseGarden(adapter, ctx);
    case "storehouse":
      return parseStorehouse(adapter, ctx);
    case "cleaning":
      return parseCleaning(adapter, ctx);
    case "animals":
      return parseAnimals(adapter, ctx);
    default: {
      // try a best-effort: look at text
      const hay = `${adapter.title || ""} ${adapter.text || ""}`.toLowerCase();
      if (hay.includes("recipe") || hay.includes("ingredients")) return parseMeals(adapter, ctx);
      if (hay.includes("seed") || hay.includes("garden") || hay.includes("harvest")) return parseGarden(adapter, ctx);
      if (hay.includes("pantry") || hay.includes("storehouse")) return parseStorehouse(adapter, ctx);
      if (hay.includes("clean") || hay.includes("declutter")) return parseCleaning(adapter, ctx);
      if (hay.includes("butcher") || hay.includes("livestock")) return parseAnimals(adapter, ctx);
      return null;
    }
  }
}
This dispatcher is what your import.worker.js and importQueue.worker.js should call.

6. Emitting to automation & favorites (from workers)
Because your automation runtime already knows how to listen for automation.schedule.request and persist user schedules, the parsers don’t do scheduling directly – the workers do.

Workers should follow this 3-event pattern:

js
Copy code
// inside import or importQueue worker
function emitForEnvelope(env) {
  // 1) tell UI / main thread we parsed it
  postMessage({
    type: "import.normalized",
    payload: env,
  });

  // 2) schedules
  if (env.meta?.scheduleMe) {
    postMessage({
      type: "automation.schedule.request",
      payload: {
        title: buildScheduleTitle(env),
        templateId: templateFromDomain(env.domain),
        rule: defaultRuleForDomain(env.domain),
        ctx: env.normalized,
        meta: { domain: env.domain },
        tags: ["imported", env.domain],
      },
    });
  }

  // 3) favorites (user-owned)
  if (env.meta?.favoriteMe) {
    postMessage({
      type: "favorite.request",
      payload: {
        entity: "session",
        data: {
          title: `📥 ${env.domain.toUpperCase()} – ${env.normalized?.title || "Imported"}`,
          domain: env.domain,
          source: env.source,
          payload: env.normalized,
        },
      },
    });
  }

  // 4) reverse generation
  if (env.meta?.reverse) {
    const revs = buildReverse(env);
    revs.forEach((rev) => {
      postMessage({
        type: "reverse.action.request",
        payload: rev,
      });
    });
  }
}

function templateFromDomain(domain) {
  return (
    {
      cleaning: "cleaning.session.generate",
      garden: "garden.session.generate",
      harvest: "garden.session.generate",
      storehouse: "storehouse.session.generate",
      meals: "cooking.session.generate",
      animals: "animals.session.generate",
    }[domain] || "generic.session.generate"
  );
}

function defaultRuleForDomain(domain) {
  return (
    {
      cleaning: { at: "09:00" },
      garden: { at: "08:00" },
      harvest: { at: "08:30" },
      storehouse: { at: "11:00" },
      meals: { at: "15:00", days: [0] },
      animals: { at: "07:00" },
    }[domain] || { at: "10:00" }
  );
}

function buildScheduleTitle(env) {
  const base = env.normalized?.title || env.normalized?.name || env.domain;
  return `${base} – from import`;
}

function buildReverse(env) {
  const list = [];
  switch (env.domain) {
    case "meals":
      list.push({ kind: "recipes→animals", source: "import", recipes: env.normalized?.recipes || [] });
      list.push({ kind: "recipes→garden", source: "import", recipes: env.normalized?.recipes || [] });
      break;
    case "harvest":
      list.push({
        kind: "harvest→storehouse",
        source: "import",
        crop: env.normalized?.crop,
        qty: env.normalized?.qty,
      });
      break;
    case "storehouse":
      list.push({ kind: "storehouse→cleaning", source: "import" });
      break;
    case "animals":
      list.push({ kind: "animals→meals", source: "import" });
      list.push({ kind: "animals→storehouse", source: "import" });
      break;
    default:
      break;
  }
  return list;
}
This is the exact same pattern we used for bookmarklet & mobile share, so everything stays consistent.

7. How this plugs into shared orchestration
Your updated src/services/automation/runtime.js already:

listens for automation.schedule.request

remaps domain schedule events (cleaning/garden/cooking/animals/inventory) to that event

persists user schedules

broadcasts automation.schedule.created

Because we emit that in the worker, your adapters/parsers inherit all of it – no extra wiring.

8. “Well executed websites” bits
Small adapters: like Notion web clipper / Raindrop / Pocket

Declarative parsers: like Contentful / Sanity preprocessors

Unified events: like Figma plugin bridge

User-owned saves: like Pinterest “Save” but ours is “Favorite Session / Favorite Schedule”

We matched those by:

Always setting favoriteMe: true by default for imports

Always emitting automation.schedule.request

Always emitting reverse routes for the 5 domains

9. Contributor checklist
When adding a new site or format:

Adapter – put in src/adapters/…

output must have site, title, url, text or raw

set a good guess

Parser – update or add to src/parsers/…

return a DomainEnvelope

Worker – call dispatchParse(adapter, ctx)

Emit the 4 messages: import.normalized, automation.schedule.request, favorite.request, reverse.action.request

Test in browser + bookmarklet + mobile share (all use same dispatcher)

Update this doc with your sample payload and mapping

10. TL;DR
Adapters know the site.

Parsers know the domain.

Workers know the orchestration.

Runtime knows how to store & favorite for the user.

Reverse generation is first-class for:

recipes→animals

recipes→garden

harvest→storehouse

storehouse→cleaning

animals→meals

animals→storehouse

End of file.
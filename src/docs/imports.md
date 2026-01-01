# Suka Smart Assistant — Imports (All Domains)

**File:** `src/docs/imports.md`  
**Purpose:** Explain how SSA ingests, normalizes, enriches, stores, and automates *all* incoming data from outside sites — not just recipes — and how it optionally exports to the Suka Village Family Fund Hub (SVFFH) **without** losing SSA’s data ownership.

---

## 1. Why imports matter

Suka Smart Assistant (SSA) is a **household engine**. To run a household, SSA needs *inputs* — and most of those inputs come from somewhere else (sites, blogs, YouTube, seed catalogs, animal/butchery guides, storehouse planning blogs, Pinterest boards, etc.).

So the import system has one job:

> **Turn “something I found online” into “actionable household intelligence.”**

That intelligence then feeds:
- inventory / storehouse
- meal / cooking sessions
- cleaning / decluttering sessions
- garden care / harvest logging
- animal care / butchery sessions
- preservation sessions (canning, dehydrating, curing, freezing, fermenting)
- **and** (optionally) hub exports for community / SVFFH data.

---

## 2. The pipeline at a glance

SSA’s imports follow the same, repeatable pipeline:

1. **Capture**  
   - bookmarklet (`/public/bookmarklet.html`)
   - iOS Shortcut → `POST /import/share-capture`
   - browser share → `POST /import/share-capture`
   - file upload (PDF, recipe JSON, CSV, etc.)
   - future: browser extension

2. **Queue**  
   - raw payload lands in **`importQueue`** (`schema.imports.json`)
   - status starts as `pending`

3. **Normalize**  
   - **ImportService** + **ImportRouter** decide which **domain adapter** to use:
     - `recipe`
     - `cleaning`
     - `garden` / `seed`
     - `animal` / `butchery`
     - `storehouse`
     - `video` / `how-to`
     - future: `preservation`
   - normalized object is stored in **`imports`** table (canonical form)

4. **Enrich → Context Intelligence**  
   - analyzer extracts:
     - ingredient patterns
     - methods
     - equipment
     - seasonality
     - task graphs
     - yield curves (for animal/butchery/garden → preservation)
   - these are written into the `contextIntelligence` field

5. **Emit event**  
   - standard shape:  
     ```js
     {
       type: "import.parsed",
       ts: "<ISO>",
       source: "import.service",
       data: { ...normalizedImport }
     }
     ```
   - this goes to `window.__suka?.eventBus` **and** to `events` table in Dexie (see `schema.household.json`)

6. **Automation reacts**  
   - automation runtime listens to the event
   - may create actionable sessions:
     - `cleaning.session.generate.requested`
     - `garden.plan.generate.requested`
     - `storehouse.stockPlan.generate.requested`
     - `animals.fromRecipes.generate.requested`
     - `meals.plan.generate.requested`
     - `preservation.session.generate.requested`

7. **(Optional) Export**  
   - if `featureFlags.familyFundMode === true` then SSA:
     1. formats the normalized import via **HubPacketFormatter**
     2. sends it via **FamilyFundConnector**
     3. fails **silently** if Hub unreachable
   - SSA **still owns the data first** — Hub is secondary.

---

## 3. SSA is separate from SVFFH

Important design rule:

- **SSA** must run **by itself** — a single household app that can:
  - capture
  - normalize
  - store
  - generate sessions
  - emit events
  - operate offline / local-first

- **SVFFH** is **optional** and **downstream**
  - SSA → (when allowed) → SVFFH
  - never SVFFH → SSA by default
  - SSA decides *what* to export
  - export is based on `familyFundMode`

This separation protects household autonomy. A household can use SSA to manage meals, garden, animals, and storehouse **even if** there’s no Hub.

---

## 4. Where the schemas live

We defined two JSON schema files to keep things clear:

1. **`src/db/schema.household.json`**  
   - master, household-facing schema
   - contains tables like: `households`, `inventory`, `storehouseGoals`, `gardenPlans`, `gardenHarvests`, `animalAssets`, `preservationBatches`, `sessions`, `events`, `syncQueue`, etc.
   - this is where normalized imports *end up* as part of wider household data

2. **`src/db/schema.imports.json`**  
   - import-focused schema
   - contains tables like: `importSources`, `importQueue`, `imports`, `importErrors`, `importMappings`, `importToSessionRequests`, `importExports`
   - this is the **staging → normalization → request** side

**Dexie** setup (`src/db/index.js`) reads these shapes and creates stores with hooks that emit events and optionally export to Hub.

---

## 5. Supported import domains (today)

SSA is **not** “recipes only.” We explicitly support:

### 5.1 Recipe
- **Input**: recipe page, recipe JSON, PIN, share → SSA
- **Normalize to**:
  - title
  - ingredients
  - steps
  - equipment
  - cuisine
  - yield/servings
- **Context intelligence**:
  - ingredient patterns → map to inventory
  - methods/equipment → map to session steps
  - seasonality → suggest garden/preservation
- **Events**:
  - `import.parsed` (domain: recipe)
  - then possibly: `meals.plan.generate.requested`
- **Automation**:
  - create cooking session
  - compare to inventory → `inventory.shortage.detected`
  - suggest storehouse goal

---

### 5.2 Cleaning / Decluttering / Zone
- **Input**: cleaning routine blog, TikTok/YouTube how-to, printable checklist
- **Normalize to**:
  - zones
  - tasks
  - frequency
  - duration estimate
- **Events**:
  - `import.parsed` (domain: cleaning)
  - automation may emit: `cleaning.session.generate.requested`
- **Sessions**:
  - saved to `cleaningSessions` or general `sessions` as type `cleaning`

---

### 5.3 Garden / Seed
- **Input**: seed packet page, garden planning article, crop guide
- **Normalize to**:
  - crops
  - zones / beds
  - care schedule
  - harvest targets
- **Events**:
  - `import.parsed` (domain: garden)
  - automation may emit: `garden.plan.generate.requested`
- **Downstream**:
  - when harvest is logged → `garden.harvest.logged` → inventory/storehouse updated

---

### 5.4 Animal / Butchery
- **Input**: livestock care guide, butchery yield article, cut sheet, reverse-from-recipe (need to raise/buy this animal)
- **Normalize to**:
  - species
  - breed
  - care schedule
  - butchery plan
  - yieldCurveRef → links to `/src/data/yieldCurves/...`
- **Events**:
  - `import.parsed` (domain: animal)
  - automation may emit: `animals.fromRecipes.generate.requested`
- **Downstream**:
  - when butchery session is created → create preservation/storehouse tasks

---

### 5.5 Storehouse
- **Input**: pantry preparedness article, grocery-stock list, “things to keep on hand” post
- **Normalize to**:
  - title
  - goals: [{ name, targetQuantity, unit, priority }]
- **Events**:
  - `import.parsed` (domain: storehouse)
  - automation may emit: `storehouse.stockPlan.generate.requested`
- **Downstream**:
  - compare goals vs actual inventory → `inventory.shortage.detected`
  - route gap to garden, animal, or grocery list

---

### 5.6 Video / How-to
- **Input**: YouTube / Rumble / embedded video
- **Normalize to**:
  - title
  - videoUrl
  - extracted tasks (if available)
  - equipment
- **Events**:
  - `import.parsed` (domain: video)
  - automation may emit cleaning / garden / meal tasks depending on content

---

## 6. Standard event shape

SSA is **event-driven**. All import-related events should follow this shape:

```js
{
  type: "import.parsed",           // or "cleaning.session.generate.requested", etc.
  ts: "2025-11-02T22:00:00.000Z",  // ISO String
  source: "import.service",        // who emitted it
  data: { /* domain-specific payload */ }
}
Why standardize?

the automation runtime can listen to import.* and not care if it was recipe, garden, or animal

the hub connector can safely forward events if familyFundMode=true

the UI can display a consistent activity feed

7. Optional Hub export
Any time imports result in household data changes (for example, a storehouse goal is created from an import, or an animal asset is created from an import), we call a helper like:

js
Copy code
exportToHubIfEnabled({
  type: "storehouse.goal.created",
  ts: new Date().toISOString(),
  source: "db.index.storehouseGoals",
  data: goalRow
});
That helper must:

Check featureFlags.familyFundMode

Format using HubPacketFormatter

Send using FamilyFundConnector

Fail silently (Hub is optional, SSA continues to work)

This ensures SSA owns data first, while still letting SVFFH gather real usage data (what households are cooking, growing, preserving, cleaning, and stocking) to tell Hub users what to produce and when.

8. How Dexie participates
File: src/db/index.js

defines all the stores for:

household

imports

sessions

garden

animals

storehouse

preservation

syncQueue

attaches hooks:

creating / updating → emits events

certain tables → also call exportToHubIfEnabled(...)

because the hooks emit to window.__suka?.eventBus, the rest of the app doesn’t need to poll; it can just react

This is exactly the imports → intelligence → automation → (optional) hub export pattern.

9. Reverse generation (important)
You asked for reverse generation: sometimes the IMPORT is not the starting point — sometimes the need is.

Example flows the system must support:

“I want to can 24 quarts of tomatoes”

user creates preservation target

SSA asks: “do you have tomatoes?” → imports/garden/inventory

if no, it can:

suggest garden plan import

suggest storehouse/grocery list

suggest animal feed plan (if it was meat instead of tomatoes)

all of these get captured as if they were imports

“I want a cleaning day like that blog post”

user imports a cleaning article

SSA stores import

SSA generates session

user favorites the session

later, user can export this favorite to Hub (if allowed)

So: imports create sessions, but sessions can also create imports.
That’s why schema.imports.json includes importToSessionRequests — it's the bridge in both directions.

10. Error handling
All import code should be defensive:

if page can’t be parsed → write to importErrors

if site not in allowlist → write to importErrors with domain: "unknown"

still emit:

js
Copy code
{
  type: "import.failed",
  ts: "<ISO>",
  source: "import.service",
  data: { reason: "...", payload: ... }
}
UI can read from importErrors to show “what couldn’t be imported”

11. What to customize per environment
Local dev (Vite):

bookmarklet → http://localhost:5173/import/share-capture

iOS Shortcut → same URL

no Hub export

LAN / Home server:

bookmarklet → http://192.168.x.x:5173/import/share-capture

Hub export can be enabled

Production / Deployed SSA:

bookmarklet → /import/share-capture (relative)

Hub export on

imports feed business reports (you mentioned: allow Hub users to open grocery stores, markets, housekeeping services, meal prep, etc.)

12. Recap
SSA ingests anything about the household (recipe, cleaning, garden, animal, storehouse, video).

Everything lands in a queue first.

Everything is normalized and turned into context intelligence.

Everything emits events in the same shape.

Automation listens and creates actionable sessions.

If enabled, the exact same data is forwarded to Hub.

SSA remains primary; Hub is optional.

That’s the imports story for Suka Smart Assistant. ✅
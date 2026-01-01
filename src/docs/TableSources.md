C:\Users\larho\suka-smart-assistant\src\docs\TableSources.md
# SSA Table Sources — Provenance, Organizations & Update Intervals

> imports (fetch/scrape/API) → **intelligence (normalized tables)** → automation (rules/tasks)  
> This catalog documents authoritative and trusted **provenance** for the tables our normalizers emit.  
> Use it alongside `src/services/scraper/ScraperSources.json` (allowlist/rate hints) and schema docs in `src/schemas`.

---

## 0) How to read this document

Each entry below references one or more **normalized tables** and provides:
- **Org / Dataset** — who publishes it
- **URL/Pattern** — canonical entry point(s)
- **Tables Produced** — SSA table names (stable)
- **Typical Update Interval** — how often publishers usually change data (guideline only)
- **Reliability** — High / Medium / Community
- **Scraper Notes** — robots/pagination/API notes
- **Provenance Fields** — what we store on the payload for traceability

When adding a new source:
1. Confirm it’s allowed in `ScraperSources.json` (host in `allow` list or not denied).
2. Capture a small **fixture** (HTML/JSON/CSV) in `src/fixtures/sources/<slug>/`.
3. Write/extend an adapter in `ScraperAdapters.js` and normalizer rules in `ScraperNormalizer.js`.
4. Emit `import.parsed` with **provenance** attached (see snippet at the end).

---

## 1) Cooking / Recipe

### 1.1 General recipe sites (structured data)
- **Org / Dataset**: Multiple publishers using JSON-LD `Recipe`
- **URL/Pattern**: `https://*/{recipe-slug}`, `view-source` contains `application/ld+json`
- **Tables Produced**:  
  - `recipe.ingredients` (order, qty, unit, item, notes)  
  - `recipe.steps` (order, text, timers?, equipment?)  
  - `recipe.metadata` (title, yield, author, durationTotalMin?, sourceHost)
- **Typical Update Interval**: Ad hoc (on article edits)
- **Reliability**: Medium (publisher dependent)
- **Scraper Notes**: Prefer JSON-LD; fallback to microdata; throttle per host; cache with ETag/Last-Modified.
- **Provenance Fields**: `source.url`, `source.title`, `sourceHost`, `fingerprint`, `etag`, `lastModified`

### 1.2 Serious Eats (example of high-quality structure)
- **Org / Dataset**: Serious Eats (recipe content)
- **URL/Pattern**: `https://www.seriouseats.com/*`
- **Tables Produced**: `recipe.*`, `safety.targets` (if present)
- **Typical Update Interval**: Ad hoc
- **Reliability**: High (editorial)
- **Scraper Notes**: JSON-LD first; avoid media/gallery endpoints.
- **Provenance Fields**: as above

> Add other reputable publishers (NYT Cooking, BBC Good Food, etc.) per household preferences & license constraints.

---

## 2) Cleaning / Food Safety

### 2.1 Government food safety (temperatures, sanitizer)
- **Org / Dataset**: National/State food safety portals and extension services
- **URL/Pattern**:  
  - USDA/FDA pages for safe temps & handling  
  - State extension guides on sanitizer PPM ranges
- **Tables Produced**:  
  - `safety.targets` (protein → minTempF)  
  - `safety.sanitizer` (agent, ppmMin, ppmMax, contactSecMin)
- **Typical Update Interval**: Infrequent (policy/guidance revisions)
- **Reliability**: High (official)
- **Scraper Notes**: Prefer PDF/HTML guidance that includes tables; snapshot version/date.
- **Provenance Fields**: `source.url`, `source.title`, `publishedAt?`, `fingerprint`

### 2.2 Community cleaning guides (how-to steps)
- **Org / Dataset**: Blogs and manufacturer guides
- **URL/Pattern**: `https://*/cleaning-*`
- **Tables Produced**: `cleaning.steps`, `howto.steps`
- **Update Interval**: Ad hoc
- **Reliability**: Medium
- **Scraper Notes**: Avoid PII; prefer manufacturer manuals for equipment specifics.

---

## 3) Garden / Seeds

### 3.1 Seed vendors (spacing & germination tables)
- **Org / Dataset**: Seed catalogs with horticultural tables
- **URL/Pattern**: `https://*/product/*`, `https://*/growing-guide/*`
- **Tables Produced**:  
  - `garden.spacing` (crop, depthIn, spacingIn, rowSpacingIn)  
  - `garden.germination` (crop, tempCMin, tempCMax, daysMin, daysMax)  
  - `seasonality` (zone/window)
- **Typical Update Interval**: Seasonal (annual refresh)
- **Reliability**: Medium (vendor-authored)
- **Scraper Notes**: Normalizer should reconcile imperial/metric and attach `variety` if present.

### 3.2 University extension services (regional calendars)
- **Org / Dataset**: Extension programs (planting calendars, IPM)
- **URL/Pattern**: `https://*.extension.*/*`
- **Tables Produced**: `seasonality`, `garden.pests` (optional)
- **Update Interval**: Occasional (semester/season)
- **Reliability**: High (research-backed)
- **Scraper Notes**: Respect robots and PDF throttles; some sites provide CSV or calendar widgets.

---

## 4) Animal / Husbandry

### 4.1 Veterinary extension & care sheets
- **Org / Dataset**: Vet schools / extension
- **URL/Pattern**: `https://*.vet.*/*`, `https://*.edu/*/extension/*`
- **Tables Produced**:  
  - `animal.tasks` (species, task, interval, notes)  
  - `animal.vaccines` (optional)
- **Typical Update Interval**: Infrequent
- **Reliability**: High
- **Scraper Notes**: Prefer official PDFs/HTML checklists; store `publishedAt` when detectable.

---

## 5) Storehouse / Product & Pricing

### 5.1 Retail weekly ads & product pages
- **Org / Dataset**: Retailers (grocery, hardware)
- **URL/Pattern**: `https://*/weekly-ad/*`, `https://*/product/*`
- **Tables Produced**: `product.price` (sku, name, price, unit, size, retailer, lastSeen)
- **Typical Update Interval**: Weekly ads (weekly), product pages (ad hoc)
- **Reliability**: Medium (site accuracy), pricing volatile
- **Scraper Notes**: Many require APIs or dynamic rendering; use cache + conditional requests; avoid login-gated content.

---

## 6) Video / How-to

### 6.1 Structured how-to
- **Org / Dataset**: Publishers using JSON-LD `HowTo`
- **URL/Pattern**: `https://*/how-to-*`
- **Tables Produced**: `howto.steps` (order, text, timestampSec?)
- **Typical Update Interval**: Ad hoc
- **Reliability**: Medium
- **Scraper Notes**: Prefer structured data; ignore user comments.

---

## 7) Cross-cutting: Units, Safety & Preferences

- **Units**: Normalize to canonical units; display conversion from `Preference.schema.json`.
- **Safety**: When scraping temperatures/PPM, store ranges and provenance links; avoid hardcoding numbers in rules—reference safety tables.
- **Preferences**: Dietary, equipment availability, and scheduling windows influence downstream synthesis; not part of scraping, but normalizers may use them for hints.

---

## 8) Minimal provenance block (attach to `import.parsed`)

Normalizers should attach this to `event.data.source` (fields may be a subset depending on source):

```json
{
  "url": "https://example.org/path",
  "title": "Page or dataset title",
  "sourceHost": "example.org",
  "normalizedId": "recipe_ab12cd",
  "fingerprint": "sha256:5c1b…",
  "etag": "\"W/\\\"7a-abc\\\"\"",
  "lastModified": "Tue, 10 Oct 2025 18:39:00 GMT",
  "publishedAt": "2024-11-01T00:00:00.000Z",
  "retrievedAt": "2025-11-11T21:35:00.000Z",
  "license": "publisher-terms",
  "contentKind": ["html", "jsonld"],
  "tables": ["recipe.ingredients", "recipe.steps"]
}
9) Suggested update checks (by domain)
Domain	Trigger	Interval Hint
Recipes	ETag/Last-Modified change	Ad hoc (check monthly)
Safety	Site change detection / publisher RSS (if any)	Quarterly
Garden	Pre-season sweep; vendor catalog refresh	Annually (pre-spring)
Animal	Policy/guide revisions	Semi-annual
Pricing	Weekly ads endpoints	Weekly (per retailer)
How-to	Only on user import or curated feed	On demand

Intervals are guidelines; the ScraperScheduler ultimately decides cadence using per-host rate limits, robots respect, and cache freshness.

10) Example source records (human-readable)
yaml
Copy code
- org: "USDA / Food Safety Guidance"
  reliability: "High"
  url: "https://www.example.gov/foodsafety/minimum-temperatures"
  tables:
    - safety.targets
  update: "Occasional (policy updates)"
  notes: "Prefer official HTML/PDF; capture publish date."
- org: "State Extension"
  reliability: "High"
  url: "https://state.extension.example.edu/garden/planting-calendar"
  tables:
    - seasonality
  update: "Seasonal"
  notes: "Region-specific; store zone mapping."
- org: "Seed Vendor A"
  reliability: "Medium"
  url: "https://seedvendor.example.com/growing-guides/carrots"
  tables:
    - garden.spacing
    - garden.germination
  update: "Annual"
  notes: "Reconcile metric/imperial; include variety."
- org: "Retailer X"
  reliability: "Medium"
  url: "https://retailer.example.com/weekly-ad"
  tables:
    - product.price
  update: "Weekly"
  notes: "Be courteous with rate limits; dynamic content."
11) Adding a new source (checklist)
 Add hostname and hints to ScraperSources.json

 Write adapter or map in ScraperAdapters.js

 Extend normalization rules for new tables/columns (additive)

 Create fixtures and unit tests

 Document entry here with update interval guidance

 Watch observability counters in HouseholdAnalytics.jsx

12) Notes on ethics & robots
Identify as SukaSmartAssistantBot/1.x and respect robots.txt.

Prefer APIs/feeds when available.

Cache aggressively (ETag/Last-Modified).

Do not collect PII; avoid login-required areas.

Attribute sources in UI when surfacing safety guidance.

13) Quick reference: table → typical provenance
Table Name	Typical Provenance
recipe.ingredients	Recipe JSON-LD pages
recipe.steps	Recipe JSON-LD / HTML steps
recipe.metadata	Recipe article header/JSON-LD
cleaning.steps	Manufacturer/extension how-to
safety.sanitizer	Extension / official sanitation guidance
safety.targets	Government food safety
garden.spacing	Seed vendor catalogs / extension
garden.germination	Seed vendor catalogs
seasonality	Extension planting calendars
animal.tasks	Vet/extension husbandry sheets
product.price	Retail weekly ads/product APIs
howto.steps	JSON-LD HowTo or structured video transcripts

Keep this file pragmatic and evergreen.
Update entries as adapters expand; prefer authoritative sources; attach provenance on every import.parsed payload.
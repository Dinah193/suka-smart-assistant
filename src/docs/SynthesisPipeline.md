C:\Users\larho\suka-smart-assistant\src\docs\SynthesisPipeline.md
# Suka Smart Assistant (SSA) — Multi-Domain Synthesis & Session Pipeline

> imports (fetch/scrape) → intelligence (normalize/enrich) → automation (rules → tasks/sessions)  
> → execution (events, inventory/storehouse changes) → (optional) hub export

This document explains how SSA turns heterogeneous inputs (recipes, cleaning guides, seed tables, animal care sheets, storehouse data, videos) into **actionable, scheduled sessions** for the household. It also describes the event model, data contracts, and extension points.

---

## 1) Mental Model

SSA is an **event-driven engine**. Each module emits envelopes shaped:

```json
{ "type": "string", "ts": "ISO-8601", "source": "ModuleName", "data": { "...payload..." } }
Core phases:

Imports — scraping, APIs, file drops

Intelligence — normalization to stable JSON tables & domain signals

Automation — rules evaluate events/state to propose or create tasks/sessions

Execution — sessions run; inventory/storehouse is updated; telemetry collected

(Optional) Export — if featureFlags.familyFundMode is true, selected events/data are formatted and sent to the Hub

2) Main Components (by responsibility)
ScraperScheduler (src/services/scraper/ScraperScheduler.js)
Controls cadence, robots.txt, throttling, retries. Emits lifecycle events (scheduled, throttled, sent, result, error).

ScraperEngine (src/services/scraper/ScraperEngine.js)
Fetches HTML/JSON, extracts text/tables/JSON-LD, returns a typed result.

ScraperAdapters (src/services/scraper/ScraperAdapters.js)
Domain aware mappers (recipe, cleaning, garden/seed, animal, storehouse/product, video/how-to). Produce enrichment: kind, cues, tables.

ScraperNormalizer (src/services/scraper/ScraperNormalizer.js)
Converts raw/adapted payloads into standardized JSON tables (ingredients, steps, garden hints, safety, etc.), attaches provenance.

ScraperCache (src/services/scraper/ScraperCache.js)
ETag/Last-Modified + fingerprint skip/conditional fetches.

ImportRouter (src/import/ImportRouter.js)
Forwards normalized imports to the automation runtime; emits import.parsed.

Automation Runtime (rules + planner)
Evaluates Rule.schema.json against events and state; produces actions (create task, schedule session, update inventory/storehouse, notify).

Inventory/Storehouse Engines
Apply mutations, emit inventory.updated, inventory.shortage.detected, etc. If a mutation is applied, also call exportToHubIfEnabled(payload).

Analytics (src/analytics/HouseholdAnalytics.jsx)
Observability dashboards and counters for success/error rates, throughput, and latency.

3) Canonical Contracts (schemas)
Task (src/schemas/Task.schema.json)
Universal task with steps, inputs/outputs, timers, safety, automation hints.

ResourceReadiness (src/schemas/ResourceReadiness.schema.json)
Gate conditions like heat, water, soil, sanitizer, electricity, equipment.

Rule (src/schemas/Rule.schema.json)
Triggers, predicates, and actions for multi-domain automation.

Preference (src/schemas/Preference.schema.json)
Household/user preferences (units, dietary, thresholds, schedules, export policy).

All schemas use JSON Schema Draft-07. Changes follow semver; keep payload version up to date.

4) End-to-End Sequence
mermaid
Copy code
sequenceDiagram
  autonumber
  participant User/Schedule
  participant ScraperScheduler
  participant ScraperEngine
  participant Adapters
  participant Normalizer
  participant ImportRouter
  participant Automation
  participant Inventory/Storehouse
  participant Hub (optional)

  User/Schedule->>ScraperScheduler: add(url, priority)
  ScraperScheduler-->>ScraperScheduler: robots allow? per-host token
  ScraperScheduler->>ScraperEngine: scrape(url, opts)
  ScraperEngine->>Adapters: detect kind, extract tables/meta
  Adapters->>Normalizer: enrichment {kind, tables, cues}
  Normalizer->>ImportRouter: emit import.parsed
  ImportRouter->>Automation: publish normalized payload
  Automation-->>Automation: evaluate rules & preferences
  Automation->>Inventory/Storehouse: create tasks/sessions; mutations
  Inventory/Storehouse->>Automation: inventory.updated / shortage events
  Inventory/Storehouse-->>Hub (optional): exportToHubIfEnabled(payload)
5) Event Reference (high-value)
scrape.schedule.added|skipped — scheduler queueing decisions

scrape.request.blocked|throttled|sent — compliance & flow control

scrape.result.received — status/duration

scrape.error — failure with message

cache.scrape.{hit|miss|conditional|updated} — caching path

import.parsed — normalized inputs ready for automation

inventory.updated — quantity/location/expiry changes

inventory.shortage.detected — below thresholds from preferences

meal.executed — completion marker for cooking tasks

garden.harvest.logged — yield tracking

preservation.completed — e.g., canned jars processed

All events: { type, ts, source, data } with ISO timestamps.

6) From Imports to Intelligence
6.1 Extraction Strategy
Prefer structured sources (JSON-LD Recipe, CSV, gov data tables).

Fallback to HTML text + heuristic parsing (units, quantities, step verbs).

Always attach provenance (source URL, title, fingerprint, etag/lastModified).

6.2 Normalization Outputs (examples)
Recipe → recipe.ingredients, recipe.steps, recipe.metadata, safety.targets

Cleaning → cleaning.agents, cleaning.steps, safety.sanitizer

Garden/Seeds → garden.crops, garden.spacing, garden.germination, seasonality

Animal → animal.tasks, vet.schedules, feed.rations

Storehouse → product.price, sku, package, pantry.tags

Video/How-to → howto.steps, timestamps, extracted checklists

Adapters may emit signals for the automation runtime (e.g., “contains whole chicken”, “requires probe thermometer”, “soil temp gate”).

7) Automation: Turning Intelligence into Sessions
The automation runtime consumes import.parsed and other events, with rules defined in Rule.schema.json. Each rule has:

triggers — events or intervals (e.g., import.parsed, sensor.reading, every PT30M)

logic — boolean expressions over event data or state

actions — emitEvent, createTask, scheduleSession, updateInventory, notify, etc.

7.1 Task construction
Tasks follow Task.schema.json with explicit resources I/O and steps. Examples:

Cooking tasks: inputs (inventory items), timers, safety temperatures, equipment

Cleaning tasks: sanitizer concentration PPM, contact time

Garden tasks: sowing depth/spacing, soil moisture target

Animal tasks: feed quantities, vaccine schedule

Preservation sessions: jar counts, headspace, processing time

7.2 Readiness gates
Before a step runs, automation may require a ResourceReadiness document:

Heat: oven preheated to 425°F for ≥5 min

Sanitizer: bleach 150–400 PPM for ≥60s

Soil: moisture 20–35% and temp ≥7°C

8) Inventory & Storehouse Integration
When a session is planned: soft reservations may be recorded (optional).

When a step consumes inputs: inventory is adjusted and inventory.updated emitted.

Shortage detection runs against Preference.storehouse.lowStockThresholds.

Any mutation path must:

Validate patch

Emit event(s)

Optionally exportToHubIfEnabled(payload) (silent if Hub unavailable)

9) Preferences Influence the Pipeline
Preference.schema.json provides:

Units & measurement system

Dietary constraints & serving defaults

Cleaning agent defaults

Garden site characteristics

Notification windows

Automation planning windows & concurrency caps

Export policy & scraping allow/deny lists

Preferences are read in normalization (e.g., unit conversions) and automation (e.g., schedule windows, quiet hours).

10) Provenance, Ethics, and Compliance
Respect robots.txt and site ToS (enforced in ScraperScheduler).

Identify with a stable UA string.

Cache aggressively; minimize data gathered; prefer official/public sources.

Maintain provenance JSONL (source, status, fingerprint, content kinds, table counts).

Attribute sources; avoid storing PII; sanitize HTML.

See src/services/scraper/README.txt for operational details.

11) Extension Points
New import types: add an adapter via makeAdapter(kind, test, map) in ScraperAdapters.js.

New domains: introduce table schemas & a normalizer branch; extend Rule enums with other fallback.

New readiness kinds: add to ResourceReadiness.schema.json with a details definition.

New actions: extend automation runtime with a new action.type (keep schema in sync).

Rate limits: ScraperScheduler.setRateLimitForHost(host, { rpm, burst }).

12) Error Handling & Resilience
Transient scraping errors: exponential backoff + jitter; capped by config.

Cache fallbacks: use conditional requests; if offline, optionally reuse fresh cache.

Rule failures: isolate per rule; log and continue others.

Task synthesis failures: emit automation.error with context; never mutate inventory on partial failure.

Idempotency: deterministic taskId and fingerprints wherever feasible.

13) Worked Examples (condensed)
13.1 Recipe → Dinner Session
URL scheduled → allowed & throttled → scraped (scrape.result.received).

Adapter recognizes JSON-LD Recipe → tables extracted.

Normalizer outputs recipe.ingredients + recipe.steps; emits import.parsed.

Rule “Auto-thaw before roast” matches; creates a thaw task for tonight.

Tomorrow: cooking session runs; upon completion → meal.executed + inventory decrements.

13.2 Garden → Planting Window
Seed vendor table normalized into garden.spacing and germination.

Soil sensor event says temp ≥7°C → rule emits garden.window.open.

Planner schedules “Plant carrots (Bed A)” within weekend window from Preferences.

13.3 Cleaning → Sanitizer Readiness
How-to page normalized with target PPM and contact time.

Before step “sanitize cutting board”, automation checks sanitizer readiness (test strip reading) → proceed/block.

14) Observability (what to watch)
Import throughput: pages/hour, success %, avg latency

Normalization health: table counts, parse warnings

Rule hit rate: per rule, per domain

Task acceptance: scheduled vs suggested

Inventory drift: adjustments/day, shortages/week

Export success: Hub delivery rate (when enabled)

15) Quick Integration Checklist
 Source added to ScraperSources.json with crawl hints

 Adapter test selects only intended pages

 Normalizer produces valid tables (draft-07 validated)

 Rule authored with triggers & predicates; unit tests passing

 Preferences considered (units, windows)

 Events emitted with correct envelope and ISO timestamps

 Inventory mutations idempotent & export helper wired (if applicable)

16) Appendix: Payload Snapshots
Event envelope

json
Copy code
{ "type": "import.parsed", "ts": "2025-11-11T21:15:35.000Z", "source": "ScraperNormalizer",
  "data": { "kind": "recipe", "id": "recipe_abc123", "tables": [{ "name": "recipe.ingredients", "rows": 12 }] } }
Task (excerpt)

json
Copy code
{ "taskId": "task_roast_chicken", "title": "Roast Chicken", "domain": "cooking",
  "resources": { "inputs": [{ "name": "Whole Chicken", "quantity": { "amount": 1, "unit": "each" } }] },
  "steps": [{ "stepId": "s1", "order": 1, "text": "Preheat oven to 425°F" }] }
Readiness

json
Copy code
{ "readinessId": "ready_oven_01", "kind": "heat", "status": "ready",
  "details": { "kind": "heat", "currentTempF": 430, "targetTempF": 425, "minHoldMinutes": 5 } }
SSA owns data first. Hub export is optional and controlled by feature flags and preferences. Keep payloads schema-valid, events consistent, and provenance complete.
C:\Users\larho\suka-smart-assistant\src\services\scraper\README.txt
================================================================================
Suka Smart Assistant (SSA) — Scraper Subsystem
Ethical scraping, provenance logging, and versioning notes
================================================================================

ROLE IN THE PIPELINE
--------------------
imports (Scheduler/Engine) → intelligence (Adapters/Normalizer) → automation (events)
→ (optional) hub export (only for state-changing flows; Scraper itself does not mutate)

Key modules:
- ScraperScheduler.js        : cadence, concurrency, per-host throttling, robots.txt
- ScraperEngine.js           : fetch, parse, extract text/tables/meta/jsonld
- ScraperAdapters.js         : domain adapters (recipe/how-to/garden/store/product/video)
- ScraperNormalizer.js       : output → standardized JSON tables
- ScraperCache.js            : ETag/Last-Modified/fingerprint (skip or conditional fetch)
- ScraperSources.json        : trusted/allow-listed sources + parser/crawl hints

================================================================================
1) ETHICAL SCRAPING GUIDELINES
================================================================================
SSA MUST respect sites, people, and data. These rules are enforced in code and policy:

A. Respect robots.txt and Terms
   - Always fetch and cache robots.txt per host; evaluate for the configured user agent.
   - If robots check fails → do not scrape; emit event:
       { type: "scrape.request.blocked", ts, source: "ScraperScheduler", data: { url, reason: "robots" } }
   - Observe site ToS; prefer official APIs if offered.

B. Identify yourself
   - Default UA: "SukaSmartAssistantBot/1.0 (+https://example.local)"
   - Provide contact info or project page where feasible; keep UA stable across releases.

C. Rate-limit and backoff
   - Per-host TokenBucket (default 12 rpm, burst 3) + global concurrency (default 2).
   - Exponential backoff with jitter on errors.
   - Emit "scrape.request.throttled" with delayMs for observability.

D. Cache aggressively, fetch conditionally
   - Use ETag/If-None-Match and Last-Modified/If-Modified-Since.
   - Maintain content fingerprints to avoid scraping unchanged pages.
   - TTLs can be tuned per host or tag (e.g., "price" pages = short TTL).

E. Minimize data
   - Collect only what’s needed for household automation (ingredients, steps, safety guidance,
     garden tables, product basics). Do NOT collect user comments, trackers, PII, or unrelated data.

F. Honor consent and opt-outs
   - If a site or owner requests opt-out, add domain to a denylist and stop scraping.
   - Document requests and effective dates in /config/policies or ScraperSources.json notes.

G. Attribution & licensing
   - Keep source URL, title, and site name with every record.
   - Respect copyright; store snippets/metadata, not full articles when terms restrict reuse.
   - Prefer public-domain / open-government sources for safety guidance.

H. Security & privacy
   - No credential harvesting; no authenticated sessions by default.
   - Sanitize output; treat HTML as untrusted; strip scripts/trackers; never execute site JS.
   - Never store or emit personal data from pages (names/emails/addresses) without explicit user action.

================================================================================
2) PROVENANCE LOGGING (AUDITABILITY)
================================================================================
Every import must be explainable: where it came from, when, and how it was interpreted.

2.1 Event bus envelope (all scraper events)
  { type, ts, source, data }
  - type   : string (e.g., "scrape.request.sent", "import.parsed")
  - ts     : ISO timestamp
  - source : subsystem name (e.g., "ScraperEngine")
  - data   : payload

2.2 Minimal provenance record (JSONL recommended)
  One line per scrape (store in /data/provenance/yyyy-mm/yyyy-mm-dd.jsonl):

  {
    "version": "1.0",
    "url": "<source url>",
    "fetchedAt": "<ISO>",
    "status": 200,
    "userAgent": "SukaSmartAssistantBot/1.0 (+…)",
    "robotsAllowed": true,
    "viaProxy": false,
    "etag": "W/\"abc123\"",
    "lastModified": "Wed, 10 Nov 2025 19:42:11 GMT",
    "fingerprint": "<fnv1a>",
    "sourceHost": "example.org",
    "sourceTitle": "<page title>",
    "contentKinds": ["recipe","jsonld","tables"],   // detected by adapters
    "tables": [
      { "name": "recipe.ingredients", "columns": ["order","line","qty","unit","item","notes"], "rows": 12 }
    ],
    "normalizer": "builtin.recipe",
    "normalizedId": "recipe_<hash>",
    "notes": []
  }

2.3 Attach provenance to normalized outputs
  - Normalizer returns: { kind, id, normalized, tables, warnings }
  - Include sourceUrl and (optionally) a provenanceId that points to the JSONL record.

2.4 Change history
  - If a fingerprint changes for a URL, emit:
      "cache.scrape.updated" { url, fingerprintChanged: true, etag, lastModified }
  - Downstream engines may re-run inference when fingerprintChanged=true.

================================================================================
3) VERSIONING STRATEGY
================================================================================
We version three things independently:

A. Scraper protocol version (this document)
   - Bump MINOR for non-breaking schema changes; MAJOR for breaking changes.
   - Stored in provenance "version" and in ScraperSources.json "version".

B. Extractor/Adapter versions
   - Each adapter id is stable (e.g., "generic.recipe.jsonld").
   - Optionally annotate versions like "generic.recipe.jsonld@1.2.0" in events for diagnostics.

C. Normalized table schema version
   - Tables are named (e.g., "recipe.ingredients"). When adding columns:
       • append new optional columns; avoid renames to stay backward-compatible.
       • note schema version at table.meta.schemaVersion (e.g., "recipe.ingredients@1.1").

Release checklist:
  [ ] Update UA if major change; document link and contact.
  [ ] Update ScraperSources.json "lastReviewed" for changed domains.
  [ ] Run sample crawls on staging allow-listed sites.
  [ ] Verify robots evaluation and Skip/Conditional/Fetch decisions.
  [ ] Validate JSON tables against analytics and ImportRouter integration tests.
  [ ] Record CHANGELOG entry with notable parser/normalizer updates.

================================================================================
4) CONFIGURATION SURFACE
================================================================================
- Scheduler (ScraperScheduler.js)
  • concurrency: default 2 (range 1–16)
  • perHost: { ratePerMinute: 12, burst: 3 }
  • userAgent: string
  • robotsTtlMs: default 24h
  • proxy: optional, used for CORS-safe fetching; still respects robots of origin

- Cache (ScraperCache.js)
  • defaultTtlMs: 6h
  • ttlByHost: per hostname override
  • ttlByTag: e.g., { "price": 30min, "video": 7d }
  • maxEntries: 2000 (LRU)

- Sources (ScraperSources.json)
  • trusted sources and parser hints
  • rateLimit overrides and default TTL per domain
  • categories/tags for downstream routing

- Feature flags (featureFlags.familyFundMode)
  • When a scraper workflow **mutates household data** (not typical at the import stage),
    call exportToHubIfEnabled(payload) with HubPacketFormatter + FamilyFundConnector.

================================================================================
5) EVENT REFERENCE (HIGH-VALUE EVENTS)
================================================================================
- scrape.schedule.added      { url, priority }
- scrape.schedule.skipped    { url, reason }
- scrape.request.blocked     { url, reason: "robots" }
- scrape.request.throttled   { url, host, delayMs }
- scrape.request.sent        { url }
- scrape.result.received     { url, status, type, durationMs }
- scrape.error               { url, error }
- cache.scrape.miss          { url, reason }
- cache.scrape.hit           { url, policy: "fresh"|"stale" }
- cache.scrape.conditional   { url }
- cache.scrape.updated       { url, fingerprintChanged, etag, lastModified }
- import.parsed              { url, kind, id, title, tables: [{name, rows}] }
- normalize.started/completed lifecycle

All events share shape: { type, ts, source, data }, ISO timestamps.

================================================================================
6) SAFETY & COMPLIANCE CHECKLIST
================================================================================
[ ] Robots.txt allowed and respected for intended paths
[ ] Rate limits and backoff applied per host
[ ] Conditional requests used when stale; skip when fresh
[ ] No PII stored or emitted from scraped pages
[ ] Copyright compliance: store metadata/snippets, not wholesale content
[ ] Attribution preserved: sourceUrl, title, site
[ ] Security: sanitize HTML → text, disable script execution, don’t eval
[ ] Provenance JSONL written for audit, with fingerprint and validators
[ ] Denylist honored for opt-out domains
[ ] ScraperSources.json reviewed/updated quarterly (or per release)

================================================================================
7) EXAMPLE WORKFLOWS
================================================================================
A) Recipe page (allow-listed site)
   1. Scheduler adds URL → robots allowed → rate-limit token acquired.
   2. Cache.shouldFetch(url) → "conditional" + headers.
   3. Engine.scrape(url, headers) → 200 OK; jsonld: Recipe; tables extracted.
   4. Cache.noteResponse(url, { etag, lastModified, status }, payload).
   5. Adapters produce enrichment.kind="recipe".
   6. Normalizer emits import.parsed with table counts; standardized tables ready for ImportRouter.

B) Garden seed vendor page (tables)
   1. Engine extracts HTML tables → Adapter "SeedVendor" maps to garden hints.
   2. Normalizer emits "garden.hints" table with spacing/depth/germination.
   3. Automation runtime may suggest a planting session based on zone/season data (downstream).

================================================================================
8) ADDING A NEW SOURCE OR DOMAIN
================================================================================
1. Add the domain to ScraperSources.json with:
   - patterns, categories, crawl.rateLimit, defaultTtlMs, parsing hints
2. If needed, write a new adapter via makeAdapter(...) in ScraperAdapters.js
3. If the domain outputs a new kind, register a normalizer with a stable table name
4. Ship tests that assert:
   - robots is observed
   - adapter.test() is selective
   - normalizer outputs stable table columns

================================================================================
9) INCIDENT HANDLING
================================================================================
- If a host signals distress (emails, 429s, legal, etc.):
  • Immediately add host to pause list: ScraperScheduler.pauseHost(host)
  • Raise robotsTtlMs to re-check disallow sooner; update ScraperSources.json to allowed=false if needed
  • Document in CHANGELOG and internal incident notes
  • Confirm provenance logs for affected period

================================================================================
10) DATA RETENTION
================================================================================
- Provenance JSONL may be rotated monthly; keep summary metrics (counts, error rates).
- Content fingerprints (hashes) are not reversible; they are retained for cache efficiency and change-detection.
- Raw HTML should not be stored by default; keep only normalized tables and minimal excerpts.

================================================================================
11) CONTACT / USER AGENT NOTE
================================================================================
Default UA: "SukaSmartAssistantBot/1.0 (+https://example.local)"
Update link and version per release. Provide contact email on the project page.

-- END --

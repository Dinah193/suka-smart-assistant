C:\Users\larho\suka-smart-assistant\src\engines\tables\README.txt

SUKA SMART ASSISTANT — DATA TABLES
==================================

Purpose
-------
This folder contains **read-only reference tables** that the synthesis stack uses to plan work:
- CookingTimingTables.json
- CleaningContactTimes.json
- GardenSoilTables.json (+ optional patches such as international crops)
- AnimalCareTables.json
- SharedResources.json

These tables are part of the *intelligence → synthesis → validation* pipeline. They do **not**
store user data and must be safe to load offline. Engines read them to compute lead-times,
coverage checks, resource merges, and safety prompts.

Data Principles
---------------
1) **Conservative baselines**: err on safe/longer times; engines may shorten with telemetry (prefs, altitude, device rates).
2) **Units-first**: all numeric fields declare units (C, F, minutes, hours, L, g/m², ppm).
3) **Deterministic keys**: prefer snake_case keys stable across languages.
4) **Provenance**: each file includes `metadata.updatedAt` and short `notes`. If scraped, include `source` in records.
5) **No business logic**: tables are declarative. Calculations live in engines (LeadTimeCalculator, SynthesisValidator, etc.).
6) **Locale-agnostic**: content uses metric; engines render in user units.

Common Envelope
---------------
Every table SHOULD expose:
{
  "metadata": {
    "name": "<PascalCaseName>",
    "version": "x.y.z",
    "updatedAt": "ISO-8601",
    "units": "metric",
    "notes": "short purpose and caveats"
  },
  ...
}

File-by-File Intent
-------------------
• CookingTimingTables.json
  - Boil/steam/pressure baselines, oven preheat profiles, rest times, doneness temps, technique timers.
  - Consumers: LeadTimeCalculator (derive windows); SynthesisValidator (coverage: rest/preheat present).

• CleaningContactTimes.json
  - Disinfectant dwell/contact times, dilution ratios, fragrance families, surface compatibility.
  - Consumers: SynthesisValidator (contact-time floor), SynthesisDeDup (sanitizer bucket merge), PreferenceAdapter (scent).

• GardenSoilTables.json
  - Soil pH targets, amendments settle/activation, germination temps, spacing, fertilization timelines, transplant thresholds.
  - Consumers: LeadTimeCalculator (settle waits), Validator (PHI windows for manure), automation (sow windows).
  - Extend via additive patches (e.g., international crops).

• AnimalCareTables.json
  - Brooder curves, milk-replacer temps, dip contact times, chill targets, sanitation hints.
  - Consumers: synthesis (animal tasks), validator (brooder readiness map), automation (chill verify events).

• SharedResources.json
  - Catalog of shareable resources (OVEN, BURNER, SANITIZER_BUCKET, WORKSPACE, etc.), capacity and merge strategies.
  - Consumers: SynthesisDeDup (coalesce), schedulers (avoid conflicts), Validator (cross-contamination checks).

Versioning & Compatibility
--------------------------
- Semantic version per file (`metadata.version`).
- **Backward-compatible changes**: add new keys or new records → bump MINOR.
- **Behavioral changes** (defaults that engines rely on) → bump MINOR and document.
- **Breaking key renames/removals** → bump MAJOR and update engines + tests.

Validation & Tests
------------------
- Keep lightweight JSON schema in each file (or in comments) for human readers.
- Unit tests live under `src/tests/*`. Add or update when tables change:
  - lead-time math stays deterministic (± tolerances),
  - sanitizer contact-time floors honored,
  - garden amend→settle→plant windows scheduled,
  - resource merges respect capacity bands.
- CI should JSON-parse all tables and run a linter that checks:
  - unknown units, missing `metadata`, duplicate keys,
  - out-of-range temps (e.g., °C > 350 for ovens),
  - contact time zero for disinfectants (flag).

Scraped vs Manual
-----------------
- Scraped tables must include per-record `"source":"scraped:<origin>"` and `"retrievedAt": "ISO"`.
- Manual curation must set `"source":"manual:curated"` and, where applicable, `"reference":"<short-cite>"`.
- Do not ship raw HTML; parse into normalized rows prior to commit.

Merging Patches
---------------
To extend without touching baselines (e.g., non-USA crops), add a sibling file such as:
`GardenSoilTables.exotics.json` and **deep-merge** at load time. Keys should align with the
parent structure (e.g., `phTargets.overrides`, `germination`, `spacing`, etc.).

Naming Conventions
------------------
- Crop ids: `family_or_common_specific` (e.g., `yardlong_bean`, `thai_basil`).
- Resource classes: UPPER_SNAKE (e.g., OVEN, BURNER, SANITIZER_BUCKET).
- Chemistry ids align with CleaningContactTimes (e.g., `quaternary_ammonium_quat`, `chlorine_50ppm`).

Safety & Compliance
-------------------
- These tables embed **general** safety baselines. Engines MUST still respect:
  - user preferences (petSafeOnly, allergies),
  - local regulations and product labels (label overrides all),
  - high-risk steps (bleach + ammonia) → validator emits hard blocks.

Event Hooks (Observability)
---------------------------
Loaders may emit non-mutating telemetry via the shared bus:
{ type: "tables.loaded", ts, source: "tables.loader", data: { names, versions } }
Downstream engines emit their own synthesis/validation events.

Extending Tables
----------------
1) Add new record(s) with descriptive comments.
2) Keep default-friendly values (planners can tighten).
3) If adding a new section, document consumer expectations here.
4) Update tests and bump `metadata.version`.

Do/Don’t
--------
Do:
- declare units next to numeric values,
- keep payloads compact and serializable,
- prefer ranges `{ "min": x, "max": y }` over singletons if variability is expected.

Don’t:
- embed executable code in JSON,
- rely on UI-side conversions for safety-critical thresholds.

Contact Points
--------------
- LeadTimeCalculator consumes: CookingTimingTables, GardenSoilTables.
- SynthesisDeDup consumes: SharedResources, CleaningContactTimes (sanitizer rules).
- SynthesisValidator consumes: all tables for coverage/safety floors.
- PreferenceAdapter informs: CleaningContactTimes (scent/pet-safe), CookingTimingTables (doneness).

EOF

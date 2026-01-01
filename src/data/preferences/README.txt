Suka Smart Assistant (SSA) – Preferences README
Path: C:\Users\larho\suka-smart-assistant\src\data\preferences\README.txt
Last updated: 2025-11-11

============================================================
Overview
============================================================
This folder contains *household preference defaults* for each SSA domain.
Preferences guide SSA’s intelligence and automation stages by expressing
household choices (units, safety posture, equipment availability, diet,
ethos) without encoding procedural rules.

SSA pipeline for context:
imports → normalization → intelligence (rules + preferences + reference)
→ automation runtime (sessions, timers, scheduling)
→ emits events → (optional) export to Hub (familyFundMode)

Preferences are **read-only configuration** for the runtime. They do not
directly mutate inventory or sessions, but engines *interpret* them when
planning and executing.

Included example files:
- cooking.preferences.json
- cleaning.preferences.json
- garden.preferences.json
- animals.preferences.json
- mealplanning.preferences.json
- storehouse.preferences.json

============================================================
Common JSON Envelope
============================================================
Each preferences file follows a consistent envelope:

{
  "version": "1.0.0",
  "domain": "<cooking|cleaning|garden|animals|mealplanning|storehouse>",
  "generatedAt": "YYYY-MM-DDThh:mm:ss.sssZ",
  "source": "Household defaults (SSA builtin)",
  "preferences": { ...domain-specific keys... }
}

Notes
- Keep files as pure JSON (no comments).
- Keys should be kebab-case or snake_case for list items; object keys are camelCase.
- All durations/temperatures/units should be explicit (e.g., { "unit": "F", "value": 135 })
  *unless* the domain’s units block sets defaults.

============================================================
How Preferences Are Used
============================================================
- Imports → Intelligence
  Engines merge imported content with:
  1) Domain rules (transformations, insertions, timers)
  2) Preferences (household choices & constraints)
  3) Reference data (large static tables)

- Automation
  Engines create or adjust sessions using:
  • Units defaults and fallbacks
  • Safety posture (e.g., prefer low VOC, PPE hints)
  • Equipment availability (e.g., prefer sous-vide)
  • Scheduling windows and lead times
  • Ethos constraints (e.g., organic-only, raw milk allowed)

- Events (for visibility)
  When preferences materially affect planning, engines SHOULD emit:
  { type: "preferences.applied", ts, source, data }
  where data includes { domain, keysInfluencingDecision, snapshotHash }

- Optional Hub export
  Preferences themselves aren’t exported. If a preference change causes
  downstream data changes (e.g., session plans updated), the engine emits the
  appropriate inventory/session events; those payloads may be exported when
  featureFlags.familyFundMode=true.

============================================================
Domain Key Maps (Cheat Sheet)
============================================================

[Cooking]
- units: temperature/mass/volume/time, fallbacks
- saltAndSpice: saltLevel, spiceLevel, guides
- oils: preference order, smoke points, defaults
- allergensAndDiet: avoidAllergens, dietTags, allowAlcoholCooking
- donenessTargets: per protein defaults
- equipment & utensils: preferred/backup/disallowed, appliance hints
- techniques: preferences for methods (sear-then-oven, sous-vide, etc.)
- substitutions: enableAutoSubstitutions, maps
- timersAndAlerts: output channel, chimes, prealerts
- cuisineBias, pantry staples, safety (probe-required), scheduling
- integrationAnchors: prep & meal tags
- localization, advanced (rounding, yield scaling)

[Cleaning]
- units + VOCPolicy (thresholds, ventilation)
- scentAndAromatics (sensitivity, essential oil allow/deny, pet cautions)
- disinfectantPolicy (preclean, surface compatibility, contact times)
- dilutionGuides, surfaceCare matrices, PPE defaults, equipment
- scheduling windows & chemistry cooldown
- alertsAndTimers (prealerts/post-reminders)
- storageAndLabeling, petAndAllergySafety
- integrationAnchors, localization, advanced overrides

[Garden]
- units + ethos (organic-only, heirloom/open-pollinated)
- seedPreferences (vendors, storage, pre-soak/scarify, inoculant)
- soil (pH targets, compost rates, mulch)
- watering (method, automation thresholds, schedules)
- fertility (allowed inputs, side-dress defaults)
- IPM/pest/disease & bee-safe policy
- companionPlanting guide
- plantingStyle, seasonExtension, cropRotation
- loggingAndLabels, harvest/postharvest workflow
- scheduling, equipment, integrationAnchors, advanced

[Animals]
- units + ethos (raw milk labeling, species included)
- milkingWorkflow (prep, method, handling, CIP cycle)
- milkQualityChecks (CMT cadence, logging)
- electrolytesAndRehydration (mixing guides & triggers)
- feedPreferences (forage priority, mineral policy, pasture rotation)
- youngstockFeeding (colostrum window, bottle temp/frequency)
- animalHealth (quarantine, hoof trim cadence, deworming strategy)
- butcheryPreferences (PPE, scald targets, chill targets)
- offalRetention (retain/discard policies, labels)
- poultry/duck specifics (brooding temps, water access)
- breedingAndMilkShare, scheduling, equipment, integrationAnchors

[Meal Planning]
- household sizing, default servings
- schedule windows, timers concurrency, prep lead time
- dietary & nutrition targets
- cuisineBias & variety rules (min days between same protein)
- leftovers policy, batch cooking targets
- budget controls, inventory integration (reserve-on-plan)
- shopping list grouping, preferred stores
- time constraints (pressure cooker, slow cooker availability)
- scoringWeights, recipeSources, childFriendliness
- plating & sustainability, automation hooks, calSync
- localization & advanced conflict resolution

[Storehouse]
- units + storage zones (pantry/root cellar/refrigerator/freezer/bulk)
- labeling, rotation policy (FEFO), alerts (low/expiry)
- procurement (vendors, bulk buy rules)
- containerization, safetyAndSegregation (chemicals/allergens/pests)
- catalog tracking (lots, use-by, open date)
- targets (days of food, water, fuel), preservationIntegration
- donationAndWaste, scanningAndIntake, pickLists
- integrationAnchors, localization, advanced

============================================================
Validation in VS Code
============================================================
We validate preferences using a lightweight schema:
.vscode\settings.json
{
  "json.schemas": [
    {
      "fileMatch": [
        "src/data/preferences/*.preferences.json"
      ],
      "url": "./src/data/schemas/preferences.base.schema.json"
    }
  ]
}

Tips
- If your editor flags “Comments are not permitted in JSON”, remove inline // comments.
- Reload VS Code after changing schema mappings (“Developer: Reload Window”).

============================================================
Merging & Overrides
============================================================
Load order for effective preferences:
1) SSA builtin defaults (this folder)
2) Household overrides (e.g., src/config/household/*.json)
3) Runtime/ephemeral overrides (e.g., a session-specific plan)

The engine should deep-merge with the later layers taking precedence.
For traceability, emit:
{ type: "preferences.merged", ts, source, data: { domain, layers, hash } }

============================================================
Security & Safety Posture
============================================================
- Cleaning: prefer low-VOC, forbid incompatible mixes (bleach+ammonia).
- Cooking: probe-thermometer required for poultry/roasts by default.
- Animals: chill chain for milk, quarantine for new arrivals.
- Garden: bee-safe spraying windows, tool sanitation between beds.

These are *preferences*; domain rules enforce guardrails. Engines should
log when a requested plan conflicts with safety prefs, and prefer safe
alternatives.

============================================================
Extending to New Domains
============================================================
Add a new file <domain>.preferences.json following the envelope. Extend the
base schema if needed; avoid domain-specific logic in preferences—keep logic
in rules/engines, and leave this folder for declarative household choices.

============================================================
Examples (Minimal)
============================================================

Example: preferences override (cooking) to prefer high smoke point oil
{
  "version": "1.0.0",
  "domain": "cooking",
  "generatedAt": "2025-11-11T00:00:00.000Z",
  "source": "Household override",
  "preferences": {
    "oils": {
      "defaultHighHeatOil": "avocado-refined",
      "minSmokePointC": 220
    }
  }
}

Example: cleaning fragrance-free + contact time override
{
  "version": "1.0.0",
  "domain": "cleaning",
  "generatedAt": "2025-11-11T00:00:00.000Z",
  "source": "Household override",
  "preferences": {
    "scentAndAromatics": { "allowFragrance": false, "useUnscentedWhereAvailable": true },
    "disinfectantPolicy": { "contactTimeOverrides": { "quats": 8 } }
  }
}

============================================================
Gotchas
============================================================
- Preferences don’t include procedural steps; keep steps/timers in rules.
- Don’t stash large reference tables here (put them under /data/reference).
- Always specify units or declare unit defaults in the file.
- Ensure time windows are local to the household timezone.

============================================================
Contact
============================================================
Questions or schema complaints?
- Check the base schema: src/data/schemas/preferences.base.schema.json
- Verify VS Code schema mapping under .vscode/settings.json

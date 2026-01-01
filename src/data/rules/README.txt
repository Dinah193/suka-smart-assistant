Suka Smart Assistant (SSA) – Data Rules README
Path: C:\Users\larho\suka-smart-assistant\src\data\rules\README.txt
Last updated: 2025-11-11

============================================================
Overview
============================================================
This folder contains *domain rules* that guide SSA’s automation runtime.
Rules convert imported content (recipes, cleaning checklists, garden plans,
animal workflows, etc.) into actionable sessions and steps.

SSA flow:
imports → normalization → intelligence (rules + reference) → automation
→ emits events → (optional) export to Hub

Rules are stored per domain:
- cooking.rules.json
- cleaning.rules.json
- garden.rules.json
- animals.rules.json
- shared.rules.json      (cross-domain heuristics/patterns)

Each file is validated against a domain-agnostic JSON Schema that defines a
common rule shape (RuleBase + domain-specific ruleType enums).
Schema path (relative from rules/):
../schemas/cooking.rules.schema.json        ← shared schema name; used by all domain rules


============================================================
File Format (Envelope)
============================================================
Each rules file must have this envelope:

{
  "version": "1.0.0",               // semver for the RULES bundle (not the schema)
  "domain": "<cooking|cleaning|garden|animals|shared>",
  "generatedAt": "YYYY-MM-DDThh:mm:ss.sssZ",    // ISO
  "source": "SSA builtin | <string>",           // optional
  "rules": [ /* list of Rule objects */ ]
}

Notes:
- Some validators will complain if "$schema" is present unless the schema
  declares it. Our draft-07 schema *does* allow "$schema", but if your editor
  still complains, temporarily remove "$schema" from the instance or configure
  a workspace mapping (see “Editor Integration”).


============================================================
Rule Shape (Summary)
============================================================
All rules extend RuleBase:
- id:          string (^[a-z0-9][a-z0-9-_]{2,63}$)
- ruleType:    string enum  ("prep-insertion" | "timing" | "doneness" |
                             "aromatics" | "substitution" | "scaling")
- enabled:     boolean
- priority:    0–1000 (lower runs earlier)
- tags:        [string]

Selectors (where rules apply):
- byIngredient: { names: [...], includesAny?, excludesAny?, ancestorTagsAny? ... }
- byMethod:     { methodsAny: [...], heat?, moisture?, applianceAny? }
- byStepText:   { regex: "...", flags: "gimsuy" }

Actions (what rules do):
- insertStep, modifyStep, setTimer, setEquipment,
- setDoneness (with DonenessProfile),
- recommendAromatics, swapIngredient, scaleYield


============================================================
Domain Files Included (examples)
============================================================
1) cooking.rules.json
   - Prep staging (boil water early), oven preheat
   - Aromatics recommendation, dairy substitutions, yield scaling
   - Doneness assignment (lamb general)

2) cleaning.rules.json
   - PPE insertion, ventilation, incompatibility checks (bleach+ammonia)
   - Disinfectant contact-time timers (bleach/quats/peroxide)
   - Deodorizing patterns, rinse-after-disinfect for food-contact surfaces

3) garden.rules.json
   - Soil prep (compost, pre-moisten), pre-soak/scarify, inoculation
   - Transplant hardening, timing window, water-in, mulch
   - Spacing checks, labeling/logging, succession planning

4) animals.rules.json
   - Acquisition quarantine & logging
   - Milking sanitation, mastitis checks, chill chain for milk
   - Brooding setup & hygiene, bottle-feed schedule & hygiene
   - Butchery PPE, scalding guidance, carcass chilling

5) shared.rules.json
   - Heating water early for thermal tasks
   - Sanitizing tools between materials
   - Handwashing after raw/soil handling
   - Label & log common, spacing/capacity checks
   - Rinse between chemistries, cool-down guidance


============================================================
Where to Put BIG Reference Tables
============================================================
Do NOT put large reference catalogs (e.g., sous-vide tables, safety charts,
equipment profiles) in the rules files; the schema forbids arbitrary top-level
sections. Instead, store them under:

C:\Users\larho\suka-smart-assistant\src\data\reference\cooking.reference.json
(and similar for other domains)

Your engines can load both:
- rules for transformations
- reference for lookups

This keeps validation strict while preserving rich data.


============================================================
Editor Integration (VS Code)
============================================================
Option A: per-file $schema (works if schema allows it)
In rules files:
  "$schema": "../schemas/cooking.rules.schema.json"

Option B: workspace mapping (central, keeps instances clean)
.vscode\settings.json
{
  "json.schemas": [
    {
      "fileMatch": [
        "src/data/rules/cooking.rules.json",
        "src/data/rules/cleaning.rules.json",
        "src/data/rules/garden.rules.json",
        "src/data/rules/animals.rules.json",
        "src/data/rules/shared.rules.json"
      ],
      "url": "./src/data/schemas/cooking.rules.schema.json"
    }
  ]
}

Draft-07 note:
- Our schema uses "definitions" (NOT "$defs") and ref paths "#/definitions/...".
- If you see “Property X is not allowed.” on perfectly valid rule fields,
  it usually means your validator failed to resolve an internal $ref. Ensure
  the schema file opens without errors and that the URL/path is correct.
- After schema edits, VS Code → Command Palette → “Developer: Reload Window”.


============================================================
Events Emitted by Engines (downstream; shown here for reference)
============================================================
When rules trigger insertions/modifications, domain engines should emit events
via src/services/eventBus.js with consistent payload:

{ type, ts, source, data }
- type: string (e.g., "automation.rule.applied", "inventory.updated")
- ts:   ISO timestamp (new Date().toISOString())
- source: "ssa.<domain>.<engine|module>"
- data: object (details; include rule.id, ruleType, targets, steps, timers)

If an action changes household data (inventory, storehouse, sessions), call
exportToHubIfEnabled(payload):
- Checks featureFlags.familyFundMode
- Uses HubPacketFormatter + FamilyFundConnector (assumed to exist)
- Fails silently if Hub is unavailable


============================================================
Authoring Rules – Quick Examples
============================================================
Example: Insert PPE before harsh chemicals (cleaning)
{
  "id": "ppe-before-harsh-chemicals",
  "ruleType": "prep-insertion",
  "enabled": true,
  "priority": 200,
  "match": { "byIngredient": { "names": ["bleach", "ammonia"] } },
  "actions": [
    {
      "action": "insertStep",
      "position": "before-first-match",
      "step": { "id": "don-ppe", "title": "Put on PPE", "duration": "PT30S" }
    }
  ]
}

Example: Set disinfectant contact-time (bleach) (cleaning/timing)
{
  "id": "contact-time-bleach-disinfect",
  "ruleType": "timing",
  "enabled": true,
  "priority": 320,
  "applyTo": { "byIngredient": { "names": ["bleach", "sodium hypochlorite"] } },
  "actions": [
    { "action": "setTimer", "duration": "PT5M", "label": "Disinfectant contact time (bleach)" }
  ]
}

Example: Boil water early for pasta (cooking)
{
  "id": "boil-water-early",
  "ruleType": "prep-insertion",
  "enabled": true,
  "priority": 400,
  "match": { "byIngredient": { "names": ["pasta"] } },
  "actions": [
    {
      "action": "insertStep",
      "position": "before-first-match",
      "step": {
        "id": "prestage-boiling-water",
        "title": "Prestage boiling water",
        "duration": "PT10M",
        "setTimer": true
      }
    }
  ]
}


============================================================
Priorities, Order, and Conflicts
============================================================
- Rules are evaluated in array order; priority breaks ties across mixed types.
- Lower priority value = earlier application.
- Keep safety rules high precedence (low numbers: 0–250).
- Use tags to group/diagnose (“safety”, “sanitation”, “transplant”, etc.).
- The runtime should log rule.id and resulting actions for traceability.


============================================================
Testing & Validation
============================================================
1) Validate structure:
   - Open a rules file in VS Code; ensure the schema is applied.
   - Fix any “Property X is not allowed” / “Expected …” messages.

2) Dry-run synthesis:
   - Feed a representative import (recipe/plan/checklist) through the domain
     synthesizer with rules enabled.
   - Confirm expected insertions (steps), timers, and substitutions appear.

3) Event assertions:
   - Ensure the engine emits { type, ts, source, data } for rule applications.
   - If sessions or inventory are mutated, exportToHubIfEnabled(payload) is called.


============================================================
Troubleshooting
============================================================
• “Property $schema is not allowed.”
  - Ensure the schema’s top-level "properties" includes "$schema", or remove
    "$schema" from the instance and use a workspace mapping.

• “Property id/ruleType/... is not allowed.”
  - Your schema $ref likely failed. Use draft-07 "definitions" not "$defs",
    and "#/definitions/..." paths. Confirm path/URL resolution and reload VS Code.

• “String is not a URI.”
  - Some editors treat "source" as a URI. Ours is free-form text. If your
    editor insists, either omit "source" or set it to a file:// URL.

• Nothing happens in the app after editing rules.
  - Make sure the domain engine reloads rules (watcher or restart).
  - Check eventBus wiring; confirm events are emitted (logs).


============================================================
Conventions & Hygiene
============================================================
- ids: kebab-case, short, stable (e.g., "preheat-oven-for-roast").
- tags: use small consistent vocab ("safety", "sanitation", "timing", "prep").
- priority bands (recommended):
  0–250   safety & hygiene
  251–400 prep & staging
  401–600 technique-specific
  601–800 substitutions & scaling
  801–1000 optional niceties

- Keep domain files focused on *rules*. Put large catalogs into /data/reference.
- Prefer selectors over regex when possible; regex is best for free text.


============================================================
Extending to New Domains
============================================================
Add a new rules file in this folder (e.g., preservation.rules.json), set
"domain": "preservation", and follow the same envelope. Reuse the same schema
unless you need extra ruleTypes; then extend the schema with a new ruleType
definition and add it to the "Rule" → "oneOf" list.


============================================================
Security & Safety
============================================================
- Never auto-mix hazardous chemistries; insert warnings and rinse steps.
- Default to PPE and ventilation when volatile/hazardous steps are detected.
- For animal/butchery and canning/preservation, favor conservative timers and
  temperatures; allow the household to relax via prefs if they explicitly opt in.


============================================================
Contact
============================================================
Questions or schema complaints?
- Check the schema file: C:\Users\larho\suka-smart-assistant\src\data\schemas\cooking.rules.schema.json
- If your editor still flags fields incorrectly, reload VS Code and verify
  the workspace json.schemas mapping.

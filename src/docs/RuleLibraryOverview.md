C:\Users\larho\suka-smart-assistant\src\docs\RuleLibraryOverview.md
# SSA Rule Library — Connecting Rules to Scraped Data Tables

> imports (scrape/ingest) → intelligence (**normalized tables**) → automation (**rules → tasks/sessions**)  
> → execution (events, inventory/storehouse changes) → (optional) hub export

This document explains how **rules** (see `src/schemas/Rule.schema.json`) read **normalized data tables** (from `ScraperNormalizer`) to create actionable outcomes (tasks, sessions, inventory updates). It covers mapping patterns, predicates, common table names, and versioning.

---

## 1) What rules “see”

Every subsystem publishes events in a **canonical envelope**:

```json
{ "type": "string", "ts": "ISO-8601", "source": "ModuleName", "data": { "...payload..." } }
The rule engine typically triggers on:

import.parsed — emitted by ScraperNormalizer with normalized tables

cache.scrape.* — cache outcomes (rarely used by rules directly)

Domain updates like inventory.updated, inventory.shortage.detected, meal.executed,
garden.harvest.logged, preservation.completed

Sensor-like app events (e.g., sensor.reading for soil temp/moisture)

Rules evaluate predicates against event.data or other subjects (inventory, storehouse, environment, task, time) and then run actions.

2) Normalized table shapes (high-frequency)
Normalizers emit a list of tables under data.tables where each item is:

json
Copy code
{ "name": "<namespace.table>", "columns": [ "...colNames..." ], "rows": <integer count>, "sample": { "...optional first row..." } }
Common names:

Domain	Table name	Notes (stable columns)
Cooking/Recipe	recipe.ingredients	order,line,qty,unit,item,notes
Cooking/Recipe	recipe.steps	order,text,timers?,equipment?
Cooking/Meta	recipe.metadata	title,yield,author,sourceHost,durationTotalMin?
Cleaning	cleaning.steps	order,text,agent?,ppm?,contactSec?
Cleaning	safety.sanitizer	agent,ppmMin,ppmMax,contactSecMin
Garden/Seeds	garden.spacing	crop,depthIn,spacingIn,rowSpacingIn
Garden/Seeds	garden.germination	crop,tempCMin,tempCMax,daysMin,daysMax
Garden	seasonality	zone,window,start,end,crop
Animal	animal.tasks	species,task,interval,notes
Storehouse	product.price	sku,name,price,unit,size,retailer,lastSeen
How-to/Video	howto.steps	order,text,timestampSec?

The namespace (recipe, cleaning, garden, animal, storehouse, howto, safety, etc.) and column names are stable within a schema minor version. New columns are additive.

3) Mapping: from tables to rule predicates
Rules target event.data (usually import.parsed), using predicates with a JSONPath-like path. Practical patterns:

3.1 Table existence & row counts
json
Copy code
{
  "subject": "event",
  "predicates": [
    { "path": "$.data.tables[?@.name=='recipe.ingredients'].rows", "op": ">=", "value": 1 }
  ]
}
3.2 String matching inside ingredients
You can search the normalized ingredient line or item:

json
Copy code
{
  "subject": "event",
  "predicates": [
    { "path": "$.data.text", "op": "regex", "value": "(whole\\s+chicken|roaster)" }
  ]
}
data.text is a convenience field normalizers may populate with a joined summary (title + key text). When absent, match against table samples or re-check data.tables[].sample.

3.3 Numeric gates from safety tables (sanitizer, temperatures)
json
Copy code
{
  "subject": "event",
  "predicates": [
    { "path": "$.data.tables[?@.name=='safety.sanitizer'].sample.ppmMin", "op": ">=", "value": 150 }
  ]
}
3.4 Garden planting windows (join with Preferences)
To gate by zone/season, use a rule that reads both the parsed import and preferences (resolved by the engine into environment):

json
Copy code
[
  {
    "subject": "event",
    "predicates": [
      { "path": "$.data.tables[?@.name=='garden.germination'].sample.crop", "op": "=", "value": "carrot" }
    ]
  },
  {
    "subject": "environment",
    "predicates": [
      { "path": "$.preferences.garden.usdaZone", "op": "regex", "value": "^6" }
    ]
  }
]
4) Example rules
4.1 Cooking — Auto-thaw if whole chicken detected
json
Copy code
{
  "ruleId": "rule.auto.thaw.whole.chicken",
  "title": "Auto-thaw before roast night",
  "domain": "cooking",
  "enabled": true,
  "triggers": {
    "onEvents": [
      { "type": "import.parsed", "match": [ { "path": "$.data.kind", "op": "=", "value": "recipe" } ] }
    ]
  },
  "logic": {
    "mode": "all",
    "expressions": [
      {
        "subject": "event",
        "predicates": [
          { "path": "$.data.text", "op": "regex", "value": "(whole\\s+chicken|roaster)" },
          { "path": "$.data.tables[?@.name=='recipe.ingredients'].rows", "op": ">=", "value": 1 }
        ]
      }
    ]
  },
  "actions": [
    {
      "type": "createTask",
      "createTask": {
        "task": {
          "taskId": "task_thaw_chicken_auto",
          "title": "Thaw whole chicken in fridge",
          "domain": "cooking",
          "prepOptions": { "thaw": true, "leadTime": "P1D" },
          "steps": [ { "stepId": "t1", "order": 1, "text": "Move chicken from freezer to fridge on tray." } ]
        }
      }
    }
  ]
}
4.2 Cleaning — Validate sanitizer range, notify if weak
json
Copy code
{
  "ruleId": "rule.clean.sanitizer.range.alert",
  "title": "Alert if sanitizer ppm below recommended",
  "domain": "cleaning",
  "enabled": true,
  "triggers": { "onEvents": [ { "type": "import.parsed" } ] },
  "logic": {
    "mode": "all",
    "expressions": [
      {
        "subject": "event",
        "predicates": [
          { "path": "$.data.tables[?@.name=='safety.sanitizer'].sample.ppmMin", "op": ">=", "value": 150 },
          { "path": "$.data.tables[?@.name=='cleaning.steps'].rows", "op": ">=", "value": 1 }
        ]
      }
    ]
  },
  "actions": [
    {
      "type": "notify",
      "notify": {
        "channel": "inbox",
        "title": "Sanitizer guidance found",
        "message": "Recommended 150–400 ppm with ≥60s contact time."
      }
    }
  ]
}
4.3 Garden — Open planting window when soil temp event arrives
json
Copy code
{
  "ruleId": "rule.garden.carrot.window",
  "title": "Open carrot planting window at ≥7°C soil",
  "domain": "garden",
  "enabled": true,
  "triggers": { "onEvents": [ { "type": "sensor.reading", "match": [ { "path": "$.data.kind", "op": "=", "value": "soil" } ] } ] },
  "logic": {
    "mode": "all",
    "expressions": [
      { "subject": "event", "predicates": [ { "path": "$.data.tempC", "op": ">=", "value": 7 } ] }
    ]
  },
  "actions": [
    { "type": "emitEvent", "emitEvent": { "eventType": "garden.window.open", "data": { "crop": "carrot", "soilTempCMin": 7 } } }
  ]
}
5) Authoring best practices
Anchor on table names: Prefer predicates that reference known table names (e.g., recipe.ingredients) instead of brittle HTML cues.

Use additive logic: Multiple small rules beat one complex mega-rule. Keep predicates composable (mode: "all"/"any").

Prefer normalized columns: e.g., qty, unit, item over full free-text lines.

Respect Preferences: Units, quiet hours, dietary restrictions, and scheduling windows should steer actions.

Idempotency: Ensure createTask uses deterministic taskId when feasible to avoid duplicates on replays.

Emit, don’t mutate (unless needed): Most rules should emit events or create tasks. Inventory/storehouse changes belong to well-tested, narrow rules.

Add safety margins: For temperatures, sanitizer ppm, etc., prefer ranges and >= checks over strict equality.

6) Performance & guardrails
Early exits: Use a quick table-presence predicate first (cheap), then deeper checks.

Regex carefully: Keep expressions anchored or case-insensitive; avoid catastrophic patterns.

Row sampling: Leverage tables[].sample for cheap checks; only count rows when necessary.

Error isolation: One rule's failure should not block others. Engine isolates and logs per rule.

7) Versioning & compatibility
Rules are version-agnostic, but they depend on table names/columns.

When a normalizer adds columns (MINOR), rules should continue to pass.

When a table renames (MAJOR only), ship:

a migration rule or transform,

a release note in src/schemas/README.txt,

updated tests for affected rules.

8) Testing a rule against captured imports
Save a real import.parsed payload to src/fixtures/imports/<slug>.json.

In the rule test:

Load fixture

Eval rule logic against event subject

Assert actions array is produced with expected shape

Include edge cases (missing tables, zero rows, unexpected units)

Minimal Jest sketch:

js
Copy code
import rule from '../rules/rule.auto.thaw.whole.chicken.json';
import event from '../../fixtures/imports/roast_chicken.json';
import { evaluateRule } from '../../runtime/automation/evaluator';

test('thaw rule fires on whole chicken', () => {
  const out = evaluateRule(rule, { event });
  expect(out.actions.find(a => a.type === 'createTask')).toBeTruthy();
});
9) Library structure
pgsql
Copy code
src/
 └─ rules/
    ├─ cooking/
    │   ├─ rule.auto.thaw.whole.chicken.json
    │   └─ rule.meat.probe.reminder.json
    ├─ cleaning/
    │   └─ rule.sanitizer.range.alert.json
    ├─ garden/
    │   └─ rule.carrot.window.json
    ├─ storehouse/
    │   └─ rule.shortage.auto.list.json
    └─ common/
        └─ rule.video.to.howto.steps.json
Use domain folders; keep names descriptive; one JSON per rule to enable targeted CI.

10) Common predicate recipes
Has equipment requirement
$.data.text regex for "thermometer|probe" or check recipe.steps.sample.equipment

Detects video how-to
$.data.kind == "howto" && $.data.tables[?@.name=='howto.steps'].rows >= 1

Seed spacing present
table garden.spacing exists with crop matching preferences

11) Safety & ethics in rules
Never create automation that bypasses human safety checks; model them as Readiness gates (ResourceReadiness.schema.json).

Attribution: If a rule notifies user based on scraped guidance, include a link to the source URL.

Privacy: Rules must not log PII; use provenance IDs, not raw content.

12) FAQ
Q: What if a site changes layout?
A: Normalizers preserve table names. Parser breakages are caught upstream; rules that rely on table presence naturally fail closed.

Q: How do I match a specific crop variety?
A: Extend garden.* tables with a variety column (MINOR addition) and use an equality predicate on it.

Q: Can a rule update inventory directly?
A: Yes, via updateInventory/updateStorehouse actions. Guard carefully and ensure idempotency. If a mutation is applied, downstream engines will emit events and optionally export via exportToHubIfEnabled.

Keep rules declarative, table-aware, and preference-informed.
By anchoring logic on normalized tables, the library remains stable as scrapers evolve.
# Event Catalog — Suka Smart Assistant (SSA)

> **File:** `src/docs/EventCatalog.md`  
> **Purpose:** Specifies **all event types** SSA emits across the pipeline: **imports → intelligence → automation → (optional) Hub export**.  
> **Audience:** Feature devs, domain owners (cooking, cleaning, garden, animal, preservation, storehouse), analytics, QA, integrators.

---

## 0) Golden Rules

- **Single envelope, consistent everywhere**
  ```json
  {
    "type": "domain.topic.action",
    "ts": "2025-11-11T17:42:05.913Z",
    "source": "path:module#fn",
    "data": { /* type-specific payload */ },
    "meta": { "v": 1, "correlationId": "uuid", "causationId": "uuid" }
  }
  ISO timestamps (ts) in UTC.
  ```

Event names use this order: domain.topic.action

Domains: import, parsing, inventory, meal, cleaning, garden, animal, preservation, storehouse, session, automation, validation, hub, analytics, system, pricebook, coupon, media

Backward compatibility: only add fields; never repurpose existing fields.

Idempotency: consumers deduplicate on (type, ts, meta.causationId?).

Privacy-first: SSA owns data. Hub export is optional and gated by featureFlags.familyFundMode === true.

1. Standard Envelope
   1.1 Shape
   ts
   Copy code
   export type EventEnvelope<T = Record<string, any>> = {
   type: string; // e.g., "import.parsed"
   ts: string; // ISO 8601 UTC
   source: string; // e.g., "src/import/ImportRouter.js:ImportRouter#route"
   data: T; // domain-specific payload
   meta?: {
   v?: number; // schema version of data (default 1)
   correlationId?: string; // same across a workflow
   causationId?: string; // id of triggering event/command
   householdId?: string; // logical household scope
   userId?: string; // present if user-triggered
   debug?: Record<string, any>;
   };
   };
   1.2 Required Keys
   type, ts, source, data

meta optional but recommended (correlationId, causationId help a lot)

1.3 source Format
relativePath:exportOrClass#method

Examples:

src/import/ImportRouter.js:ImportRouter#route

src/domain/inventory/InventorySessionEngine.js:InventorySessionEngine#commit

2. Core Event Families (with payload contracts)
   Contracts are abridged. Full JSON Schemas live under src/contracts/events/\*.schema.json.
   All examples are minimum required keys; extra keys are allowed.

2.1 Import & Parsing
import.received
When: raw content arrives (share sheet, bookmarklet, upload, API).

Source: src/import/ImportService.js#receive

json
Copy code
{
"importId": "uuid",
"mime": "text/html",
"size": 17324,
"origin": "https://www.allrecipes.com/...",
"channel": "bookmarklet|shareTarget|api|file",
"rawRef": "blob://... or inline excerpt"
}
import.routed
When: router selects a parser.

Source: src/import/ImportRouter.js#route

json
Copy code
{
"importId": "uuid",
"parser": "RecipeParser|CleaningParser|GardenParser|AnimalParser|GenericParser",
"reason": "matched-allowlist|heuristic|fallback"
}
import.parsed
When: parser returns normalized structure.

Source: src/import/parsers/\*#parse

json
Copy code
{
"importId": "uuid",
"domain": "recipe",
"contract": "recipe.contract.json@1",
"entity": { "id": "recipe-xyz", "title": "Banana Bread", "ingredients": [], "steps": [] }
}
validation.failed
When: contract validation fails.

Source: src/import/ImportNormalizer.js#validate

json
Copy code
{
"importId": "uuid",
"contract": "recipe.contract.json@1",
"errors": [{ "path": "ingredients[2].qty", "message": "must be number" }],
"severity": "error|warning"
}
validation.passed
When: contract validation succeeds.

Source: src/import/ImportNormalizer.js#validate

json
Copy code
{ "importId": "uuid", "contract": "recipe.contract.json@1" }
2.2 Intelligence (Synthesis)
prep.synthesized
When: SSA injects implicit steps (preheat, boil, sanitize, PPE).

Source: src/intelligence/PrepSynthesizer.js#apply

json
Copy code
{
"entityId": "recipe-xyz",
"domain": "recipe|cleaning|garden|animal|preservation",
"addedSteps": [
{ "id": "prep-1", "kind": "preheat", "details": { "tempC": 180, "leadMinutes": 15 } }
],
"rulesVersion": "prep.rules.json@7"
}
intelligence.tags.inferred
When: taxonomy/NER tags inferred (equipment, method, seasonality, hazards).

Source: src/intelligence/Tagger.js#infer

json
Copy code
{
"entityId": "recipe-xyz",
"tags": ["equipment:stand-mixer", "method:braise", "season:late-summer"]
}
2.3 Inventory & Storehouse
inventory.updated
When: quantities change (consume/add/adjust).

Source: src/domain/inventory/InventorySessionEngine.js#commit

json
Copy code
{
"changes": [
{ "sku": "flour.ap.5lb", "delta": -0.5, "uom": "kg", "reason": "meal:recipe-xyz" }
],
"snapshot": { "sku": "flour.ap.5lb", "qty": 2.0, "uom": "kg" }
}
inventory.shortage.detected
When: min threshold crossed or required for a session.

Source: src/domain/inventory/Guards.js#checkShortages

json
Copy code
{
"requirements": [{ "sku": "yeast.dry", "need": 7, "have": 0, "uom": "g" }],
"context": { "forSessionId": "session-123", "urgency": "high" }
}
storehouse.location.updated
When: item moved/relabeled/retagged in storage.

Source: src/domain/storehouse/StorehouseService.js#move

json
Copy code
{
"sku": "apple.jar.quart.2025",
"from": "cellar:A2",
"to": "pantry:B3",
"qty": 6,
"uom": "ea",
"batchId": "batch-apple-2025-10"
}
2.4 Sessions (Creation → Execution → Completion)
session.created
When: actionable session generated.

Source: src/session/SessionFactory.js#create

json
Copy code
{
"sessionId": "session-123",
"domain": "cooking|cleaning|garden|animal|preservation",
"anchor": { "start": "2025-11-11T19:00:00Z", "durationMin": 60 },
"tasks": [{ "id": "t1", "title": "Preheat oven 180C" }],
"origin": "importId|user|automation"
}
session.updated
When: status or tasks/anchor patched.

Source: src/session/SessionStore.js#update

json
Copy code
{
"sessionId": "session-123",
"patch": { "status": "in-progress", "anchor": { "start": "..." } }
}
session.completed
When: last task completed.

Source: src/session/SessionRunner.jsx#onComplete

json
Copy code
{
"sessionId": "session-123",
"outcomes": { "yield": { "loaves": 2 }, "notes": "Crumb slightly tight" }
}
2.5 Domain Outcomes
meal.executed
When: cooking run finishes.

Source: src/domain/cooking/CookingOrchestrator.js#finalize

json
Copy code
{
"recipeId": "recipe-xyz",
"doneness": { "centerTempC": 96, "visual": "golden-brown" },
"prefsApplied": { "sweetness": "low", "doneness": "well" }
}
cleaning.routine.executed
When: cleaning routine ends.

Source: src/domain/cleaning/Executor.js#finalize

json
Copy code
{
"routineId": "clean-101",
"aromaticsUsed": ["lemon", "eucalyptus"],
"surfaces": ["countertops", "sink"]
}
garden.harvest.logged
When: harvest recorded.

Source: src/domain/garden/HarvestLogger.js#commit

json
Copy code
{
"crop": "tomato.roma",
"qty": 7.2,
"uom": "kg",
"grade": "A",
"storage": "cellar:A1"
}
animal.care.completed
When: animal routine completes (feed, deworm, check).

Source: src/domain/animal/CareOrchestrator.js#finalize

json
Copy code
{
"species": "goat",
"herdId": "herd-002",
"actions": ["feed", "deworm"],
"meds": [{ "name": "albendazole", "doseMgPerKg": 7.5 }]
}
preservation.completed
When: canning/dehydrating/curing/etc. completes.

Source: src/domain/preservation/PreservationFlow.js#finalize

json
Copy code
{
"method": "pressure-canning",
"batches": [{ "sku": "greenbeans.jar.quart.2025", "qty": 12 }],
"hazardsCleared": ["botulism-process-time"]
}
2.6 Automation
automation.suggestion.emitted
When: NBA suggestions generated.

Source: src/automation/suggestions/useNextBestAction.js#emit

json
Copy code
{
"suggestions": [
{ "kind": "cook", "title": "Use ripe tomatoes today", "score": 0.82 }
],
"guards": { "sabbath": false, "quietHours": true, "inventory": "ok" }
}
automation.schedule.request
When: scheduler proposes a session.

Source: src/services/automation/runtime.js#propose

json
Copy code
{
"reason": "inventory.expiring|garden.harvest.logged|user-preference",
"proposal": { "domain": "preservation", "window": { "start": "...", "end": "..." } }
}
automation.schedule.committed
When: proposal accepted → session.created.

Source: src/services/automation/runtime.js#commit

json
Copy code
{
"sessionId": "session-123",
"proposalRef": "sched-prop-789"
}
2.7 Hub Export
Any event that changes household data should best-effort export to the Hub via exportToHubIfEnabled(payload) in the emitting module.

hub.export.attempted
Source: src/services/hub/HubExporter.js#exportToHubIfEnabled

json
Copy code
{
"eventType": "inventory.updated",
"packetType": "HubPacketFormatter@inventory.v1",
"size": 1024
}
hub.export.succeeded
Source: same

json
Copy code
{
"eventType": "inventory.updated",
"connector": "FamilyFundConnector",
"status": 200
}
hub.export.failed
Source: same — must not throw to user flow.

json
Copy code
{
"eventType": "inventory.updated",
"error": "ECONNREFUSED",
"retryHint": "backoff: 5m"
}
2.8 Validation, Guards & System
system.guard.blocked
When: guard vetoes (quiet, sabbath, weather, inventory).

Source: src/services/guards/\*#check

json
Copy code
{
"guard": "sabbath|quietHours|weather|inventory",
"reason": "window:friday-sunset..saturday-sunset",
"action": "automation.schedule.request",
"context": { "sessionId": "session-123" }
}
system.error
When: unexpected error propagated to event layer.

Source: any catch

json
Copy code
{
"message": "null ref in SessionRunner",
"stackHash": "sha1:abcd...",
"severity": "error|fatal"
}
2.9 Pricebook / Coupon
pricebook.series.updated
json
Copy code
{ "store": "Kroger", "seriesId": "price-2025W45", "items": 432 }
coupon.window.detected
json
Copy code
{ "sku": "tomato.paste.6oz", "window": { "start": "...", "end": "..." }, "discountPct": 28 }
2.10 Media (Video/How-To Imports)
media.howto.linked
json
Copy code
{ "entityId": "recipe-xyz", "platform": "YouTube", "videoId": "abcd1234" } 3) Typical Flows
3.1 Recipe → Intelligence → Session → Inventory → (Hub)
mermaid
Copy code
sequenceDiagram
participant U as User
participant IR as ImportRouter
participant P as RecipeParser
participant PS as PrepSynthesizer
participant SF as SessionFactory
participant SR as SessionRunner
participant IE as InventoryEngine
participant HX as HubExporter

U->>IR: share recipe
IR-->>IR: emit import.routed
IR->>P: parse()
P-->>P: emit import.parsed
P->>PS: synthesize prep
PS-->>PS: emit prep.synthesized
PS->>SF: create session
SF-->>SF: emit session.created
U->>SR: run session
SR-->>SR: emit session.completed & meal.executed
SR->>IE: commit inventory deltas
IE-->>IE: emit inventory.updated
IE->>HX: exportToHubIfEnabled()
HX-->>HX: hub.export.succeeded|failed
3.2 Garden Harvest → Storehouse → Preservation Suggestion
mermaid
Copy code
sequenceDiagram
participant GH as HarvestLogger
participant ST as StorehouseService
participant AR as AutomationRuntime

GH-->>GH: garden.harvest.logged
GH->>ST: move to cellar
ST-->>ST: storehouse.location.updated
ST->>AR: evaluate suggestions
AR-->>AR: automation.suggestion.emitted 4) Versioning & Change Policy
Envelope is stable; data objects carry meta.v.

Bump meta.v when:

adding a new required field, or

changing semantics of an existing field.

Adding optional fields does not require a version bump.

5. Testing & Observability
   Unit tests should assert both event emission and payload shape.

Use src/test/utils/EventProbe.ts to capture and assert events.

Analytics can subscribe to _.executed, inventory.updated, automation._, validation.\*.

6. Subscribing to Events
   js
   Copy code
   import { eventBus } from "../services/events/eventBus";

const sub = eventBus.subscribe("inventory.shortage.detected", (evt) => {
// evt: EventEnvelope
// schedule shopping list generation, etc.
});

// Remember to unsubscribe in React effects / service teardown
sub.unsubscribe();
Wildcard support (implementation-dependent):

"inventory.\*" listens to any inventory events

"\*.executed" listens to any executed terminal

7. Minimal Contracts by Domain
   Domain Key Events
   import/parsing import.received, import.routed, import.parsed, validation.passed, validation.failed
   intelligence prep.synthesized, intelligence.tags.inferred
   inventory inventory.updated, inventory.shortage.detected
   storehouse storehouse.location.updated
   session session.created, session.updated, session.completed
   cooking/meal meal.executed
   cleaning cleaning.routine.executed
   garden garden.harvest.logged
   animal animal.care.completed
   preservation preservation.completed
   automation automation.suggestion.emitted, automation.schedule.request, automation.schedule.committed
   hub hub.export.attempted, hub.export.succeeded, hub.export.failed
   system system.guard.blocked, system.error
   pricebook pricebook.series.updated, coupon.window.detected
   media media.howto.linked

8. Required Emission Points (Checklist)
   Import Router/Parsers → import._, validation._

Synthesizer/Tagger → prep.synthesized, intelligence.tags.inferred

Session Factory/Store/Runner → session._, _.executed

Inventory Engine/Storehouse → inventory.updated, inventory.shortage.detected, storehouse.location.updated

Automation Runtime → automation.\*, system.guard.blocked

Hub Exporter → hub.export.\*

Global error traps → system.error

9. Hub Export Notes
   Call exportToHubIfEnabled(eventEnvelope) after a state mutation succeeds.

The helper must:

Check featureFlags.familyFundMode

Format with HubPacketFormatter

Send via FamilyFundConnector

Never throw; instead emit hub.export.failed (and log internally)

10. Example Envelopes
    10.1 inventory.updated
    json
    Copy code
    {
    "type": "inventory.updated",
    "ts": "2025-11-11T18:20:00.000Z",
    "source": "src/domain/inventory/InventorySessionEngine.js:InventorySessionEngine#commit",
    "data": {
    "changes": [
    { "sku": "yeast.dry", "delta": -7, "uom": "g", "reason": "meal:recipe-xyz" }
    ],
    "snapshot": { "sku": "yeast.dry", "qty": 0, "uom": "g" }
    },
    "meta": { "v": 1, "correlationId": "6b5f...", "causationId": "f73a..." }
    }
    10.2 prep.synthesized (preservation)
    json
    Copy code
    {
    "type": "prep.synthesized",
    "ts": "2025-11-11T18:05:00.000Z",
    "source": "src/intelligence/PrepSynthesizer.js:PrepSynthesizer#apply",
    "data": {
    "entityId": "preserve-jar-greenbeans-2025",
    "domain": "preservation",
    "addedSteps": [
    { "id": "prep-sterilize-jars", "kind": "sanitize", "details": { "method": "boil", "minutes": 10 } }
    ],
    "rulesVersion": "prep.rules.json@7"
    },
    "meta": { "v": 1, "correlationId": "a1b2...", "causationId": "c3d4..." }
    }
    10.3 system.guard.blocked (Sabbath)
    json
    Copy code
    {
    "type": "system.guard.blocked",
    "ts": "2025-11-08T23:01:00.000Z",
    "source": "src/services/guards/SabbathGuard.js:SabbathGuard#check",
    "data": {
    "guard": "sabbath",
    "reason": "window:friday-sunset..saturday-sunset",
    "action": "automation.schedule.request",
    "context": { "proposal": { "domain": "preservation" } }
    },
    "meta": { "v": 1, "correlationId": "sab-xyz" }
    }
11. Extension Points
    New domain? Reserve a prefix (fermentation., bee., hvac., etc.) and add to §2 with 2–3 core events:

X.created|logged|executed

X.updated

X.completed

New import type? Add a parser that emits at least import.parsed and validation.\*.

New automation guard? Emit system.guard.blocked with guard = your guard’s name.

New intelligence rule? Emit \*.synthesized with rulesVersion bumped when rules change.

12. FAQ
    Q: Can we add per-event JSON Schemas?
    A: Yes—add under src/contracts/events/<event>.schema.json and reference with meta.v.

Q: How do we correlate a whole workflow?
A: Generate a correlationId at ingress (import.received) and carry it through.

Q: Are hub.export.\* required when familyFundMode=false?
A: No. They only fire when export is attempted.

End of Event Catalog

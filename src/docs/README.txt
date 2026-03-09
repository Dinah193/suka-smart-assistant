C:\Users\larho\suka-smart-assistant\src\docs\README.txt
===============================================================================
Suka Smart Assistant (SSA) — Documentation Index
===============================================================================
Purpose
-------
This README.txt is the entry point for SSA’s documentation set.
Use it to quickly find contracts, event catalogs, domain guides, and
“how-to” playbooks for adding import types, intelligence rules,
automation, and (optional) Family Fund Hub export.

SSA Pipeline (mental model)
---------------------------
imports → normalization → intelligence (context) → sessions/automation →
state changes (inventory/storehouse) → (optional) hub export → analytics

Key Principles
--------------
1) SSA and the Suka Village Family Fund Hub (SVFFH) are separate.
   SSA owns data first; Hub export is optional (featureFlags.familyFundMode=true).
2) Single event envelope everywhere:
   { type, ts, source, data, meta? } with ISO UTC timestamps.
3) Be additive and backward compatible. Don’t repurpose fields.
4) Every state-changing write emits an event and (if enabled) attempts Hub export.
5) Leave extension points for new domains: preservation, animal, storehouse, etc.

-------------------------------------------------------------------------------
TABLE OF CONTENTS
-------------------------------------------------------------------------------
[00] Start Here
[01] Eventing & Observability
[02] Contracts & Validation
[03] Imports & Normalization
[04] Intelligence (Synthesis, Tags, Rules)
[05] Sessions & Automation
[06] Inventory & Storehouse
[07] Hub Export (Family Fund Mode)
[08] Analytics & Reporting
[09] Security, Privacy, Compliance
[10] Testing & QA
[11] Developer Guides (How-To Playbooks)
[12] Glossary
[13] Changelogs & Versioning

===============================================================================
[00] START HERE
===============================================================================
• Event Catalog (canonical source of truth)
  -> src/docs/EventCatalog.md

• Contracts index (JSON Schemas for domain entities and events)
  -> src/contracts/ (see [02])

• Quick dev loop
  1) Add/extend a contract (schema) under src/contracts/
  2) Parse/normalize inputs to match the contract
  3) Emit events using the standard envelope via src/services/events/eventBus.js
  4) If state changes occur, attempt exportToHubIfEnabled(...)
  5) Add tests with EventProbe to assert event emissions and shapes

• Where to start by role
  - Parser author: see [03] and [11.A]
  - Intelligence engineer: see [04] and [11.B]
  - Automation engineer: see [05] and [11.C]
  - Inventory/storehouse dev: see [06] and [11.D]
  - Hub integrator: see [07] and [11.E]
  - Analyst: see [08]; subscribe to events and build dashboards

===============================================================================
[01] EVENTING & OBSERVABILITY
===============================================================================
• Canon:
  -> src/docs/EventCatalog.md

• Bus:
  -> src/services/events/eventBus.js

• Envelope (minimum):
  type: "domain.topic.action"
  ts:   ISO 8601 UTC string
  source: "relativePath:ExportOrClass#method"
  data: object (see contracts)
  meta?: { v?, correlationId?, causationId?, householdId?, userId?, debug? }

• Wildcards (implementation-dependent):
  "inventory.*", "*.executed", "automation.*"

• Required emission points (checklist):
  - Import Router/Parsers .......... import.*, validation.*
  - Synthesizer/Tagger ............. prep.synthesized, intelligence.tags.inferred
  - Session Factory/Runner ......... session.*, *.executed
  - Inventory/Storehouse ........... inventory.updated, inventory.shortage.detected,
                                     storehouse.location.updated
  - Automation Runtime ............. automation.*, system.guard.blocked
  - Hub Exporter ................... hub.export.*
  - Global error traps ............. system.error

• Testing helper:
  -> src/test/utils/EventProbe.ts  (captures/asserts events in tests)

===============================================================================
[02] CONTRACTS & VALIDATION
===============================================================================
• Entity contracts (examples):
  -> src/contracts/recipe.contract.json
  -> src/contracts/cleaning.contract.json
  -> src/contracts/garden.contract.json
  -> src/contracts/animal.contract.json
  -> src/contracts/preservation.contract.json
  -> src/contracts/storehouse.contract.json
  -> src/contracts/session.contract.json

• Event contracts (optional, recommended for critical events):
  -> src/contracts/events/*.schema.json
     e.g., src/contracts/events/inventory.updated.schema.json

• Validation utilities:
  -> src/import/ImportNormalizer.js  (validate parsed entities)
  -> src/services/validation/*       (if split by domain)

• Versioning:
  - Reference schema version in payloads via strings like "recipe.contract.json@1"
  - Bump meta.v in event meta when adding required fields or changing semantics

===============================================================================
[03] IMPORTS & NORMALIZATION
===============================================================================
• Router & service:
  -> src/import/ImportRouter.js
  -> src/import/ImportService.js

• Parsers (extensible):
  -> src/import/parsers/RecipeParser.js
  -> src/import/parsers/CleaningParser.js
  -> src/import/parsers/GardenParser.js
  -> src/import/parsers/AnimalParser.js
  -> src/import/parsers/PreservationParser.js
  -> src/import/parsers/GenericParser.js

• Events to emit:
  import.received → import.routed → import.parsed
  validation.passed | validation.failed

• Notes:
  - Normalize to contracts before emitting downstream intelligence rules
  - Record origin metadata (url, channel, mime, size) for analytics

===============================================================================
[04] INTELLIGENCE (SYNTHESIS, TAGS, RULES)
===============================================================================
• Components:
  -> src/intelligence/PrepSynthesizer.js   (implicit steps: preheat, boil, sanitize, PPE)
  -> src/intelligence/Tagger.js            (NER/taxonomy inference)
  -> src/intelligence/rules/               (rule packs, e.g., prep.rules.json)

• Events:
  prep.synthesized
  intelligence.tags.inferred

• Guidance:
  - Keep rule packs versioned (e.g., prep.rules.json@7)
  - Prefer pure functions for determinism and testability

===============================================================================
[05] SESSIONS & AUTOMATION
===============================================================================
• Session creation & storage:
  -> src/session/SessionFactory.js
  -> src/session/SessionStore.js
  -> src/session/SessionRunner.jsx

• Automation runtime & guards:
  -> src/services/automation/runtime.js
  -> src/services/guards/ (sabbath, quietHours, weather, inventory)

• Events:
  session.created, session.updated, session.completed
  automation.suggestion.emitted, automation.schedule.request, automation.schedule.committed
  system.guard.blocked

• Notes:
  - Derive “Next Best Action” from signals: inventory, harvest logs, expiring items
  - Always respect guards; emit system.guard.blocked on veto

===============================================================================
[06] INVENTORY & STOREHOUSE
===============================================================================
• Inventory engine & guards:
  -> src/domain/inventory/InventorySessionEngine.js
  -> src/domain/inventory/Guards.js

• Storehouse service:
  -> src/domain/storehouse/StorehouseService.js

• Events:
  inventory.updated, inventory.shortage.detected, storehouse.location.updated

• Rules:
  - Every quantity delta must be a signed number with explicit uom
  - Emit snapshot where useful for consumer UIs

===============================================================================
[07] HUB EXPORT (FAMILY FUND MODE)
===============================================================================
• Toggle:
  featureFlags.familyFundMode === true

• Helper (call after successful state change):
  exportToHubIfEnabled(eventEnvelope)

• Supporting services (assumed present):
  -> src/services/hub/HubPacketFormatter.js
  -> src/services/hub/FamilyFundConnector.js
  -> src/services/hub/HubExporter.js  (may host exportToHubIfEnabled)

• Events:
  hub.export.attempted, hub.export.succeeded, hub.export.failed
  (Export must fail silently for user flows; still emit failure event)

===============================================================================
[08] ANALYTICS & REPORTING
===============================================================================
• Components/pages:
  -> src/analytics/HouseholdAnalytics.jsx
  -> src/analytics/queries/*

• Subscriptions:
  - Prefer consuming canonical events from the bus (no private side channels)
  - Typical streams: *.executed, inventory.updated, automation.*

• Outputs:
  - Trend lines (usage, waste, yields)
  - Guard hit rates (quiet hours, sabbath)
  - Import sources performance (parse success, validation errors)

===============================================================================
[09] SECURITY, PRIVACY, COMPLIANCE
===============================================================================
• Privacy-first:
  - SSA data remains local unless familyFundMode is enabled
  - Strip PII from analytics streams when not required

• Least privilege:
  - Keep connectors (Hub, external APIs) sandboxed
  - Validate all inbound import content (size, mime, sanitize HTML)

• Auditability:
  - Correlate flows using meta.correlationId (issue at import.received)
  - Hash+log unexpected errors (system.error with stackHash)

===============================================================================
[10] TESTING & QA
===============================================================================
• Unit testing:
  -> src/test/utils/EventProbe.ts  (subscribe/assert events)
  -> src/**/__tests__/*.spec.(js|ts)

• What to assert:
  - Event emission presence and minimal envelope shape
  - Contract validation results (passed/failed)
  - Guard behavior (blocked vs allowed)

• Fixtures:
  -> src/test/fixtures/imports/*
  -> src/test/fixtures/contracts/*

===============================================================================
[11] DEVELOPER GUIDES (HOW-TO PLAYBOOKS)
===============================================================================
[A] Add a NEW Import Type
    1) Create parser file under src/import/parsers/<NewParser>.js
    2) Map it in src/import/ImportRouter.js
    3) Normalize to a contract under src/contracts/<domain>.contract.json
    4) Emit: import.routed, import.parsed, validation.passed|failed
    5) Add tests and sample fixtures
    6) Add an entry to EventCatalog.md if new events appear

[B] Add NEW Intelligence Rules
    1) Add/extend rule pack under src/intelligence/rules/
    2) Update PrepSynthesizer/Tagger to apply rules
    3) Emit: prep.synthesized and/or intelligence.tags.inferred
    4) Bump rulesVersion; update tests

[C] Add/Change Automation
    1) Extend src/services/automation/runtime.js
    2) Respect guards; emit system.guard.blocked when vetoed
    3) Emit: automation.suggestion.emitted, automation.schedule.request (.committed on accept)
    4) Add unit tests for edge cases (quiet hours, sabbath, weather, inventory)

[D] Change Inventory/Storehouse Behavior
    1) Update InventorySessionEngine/StorehouseService
    2) Emit: inventory.updated (+snapshot), inventory.shortage.detected, storehouse.location.updated
    3) After successful mutation, call exportToHubIfEnabled(...)
    4) Add tests for deltas, negative/zero handling, and boundary conditions

[E] Wire Hub Export
    1) Check featureFlags.familyFundMode
    2) Format with HubPacketFormatter
    3) Send with FamilyFundConnector
    4) Emit hub.export.attempted/succeeded/failed (never throw)
    5) Add retry/backoff if connector offers it

===============================================================================
[12] GLOSSARY
===============================================================================
• Envelope: Standard event wrapper { type, ts, source, data, meta? }
• CorrelationId: ID assigned at ingress to track a full workflow
• CausationId: ID of the triggering event/command for a subsequent event
• Guard: Policy gate (sabbath, quietHours, weather, inventory) that can veto actions
• Session: Actionable, scheduled bundle of tasks in a domain
• Family Fund Mode: Feature flag enabling optional Hub export

===============================================================================
[13] CHANGELOGS & VERSIONING
===============================================================================
• Event schema versions:
  - Use meta.v in event meta for versioning payload semantics
  - Place detailed event schemas under src/contracts/events/

• Contract versions:
  - Reference “<contractName>@<version>” in payloads (e.g., recipe.contract.json@1)

• Doc updates:
  - Update src/docs/EventCatalog.md when adding new event types
  - Update this README.txt when adding/relocating docs

===============================================================================
QUICK LINKS (Paths)
===============================================================================
• Event Catalog ............. src/docs/EventCatalog.md
• Contracts (entities) ...... src/contracts/*.json
• Event Schemas (optional) .. src/contracts/events/*.schema.json
• Import Router/Service ..... src/import/ImportRouter.js, src/import/ImportService.js
• Parsers ................... src/import/parsers/*
• Normalizer/Validation ..... src/import/ImportNormalizer.js
• Intelligence .............. src/intelligence/*
• Sessions/Automation ....... src/session/*, src/services/automation/runtime.js
• Guards .................... src/services/guards/*
• Inventory/Storehouse ...... src/domain/inventory/*, src/domain/storehouse/*
• Hub Export ................ src/services/hub/*
• Event Bus ................. src/services/events/eventBus.js
• Analytics ................. src/analytics/*
• Tests/Probe ............... src/test/utils/EventProbe.ts

===============================================================================
EDITOR NOTES
===============================================================================
• Keep this file as plain text (.txt) for easy Notepad/VS Code viewing.
• Prefer 80–100 char lines where comfortable; wrap long URLs.
• Avoid project secrets or tenant-specific configs in docs.
• Use consistent Windows-style paths when referencing locations here.

-- End of file --

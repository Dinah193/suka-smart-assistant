C:\Users\larho\suka-smart-assistant\src\engines\synthesis\README.txt

SUKA SMART ASSISTANT — SYNTHESIS STACK
======================================

Purpose
-------
This stack turns normalized imports (recipe/cleaning/garden/animal/preservation/storehouse/how-to)
into actionable household work: readiness/prep steps and schedulable sessions.
It sits between "intelligence" (imports + knowledge) and the automation runtime.

High-Level Pipeline
-------------------
normalize → synthesize → dedupe → lead-time → validate → register/commit → (optional) hub export

1) normalize
   • Inputs from importers are mapped to a canonical item shape:
     { id, domain, title, items[], methods[], equipment[], seasonality?, meta? }
   • Every import should add context intelligence (ingredients/methods/equipment/seasonality).

2) synthesize
   • SynthesisEngine reads domain rules (RuleInterpreter), preferences (PreferenceAdapter),
     and knowledge (LeadTimeTables) to generate:
       - readinessSteps[] (human-sized prep)
       - sessionSuggestions[] (schedulable sessions)
   • Emits: synthesis.started, synthesis.suggestion.generated, synthesis.completed
   • On commit, persists sessions and may export to Family Fund Hub.

3) dedupe
   • SynthesisDeDup collapses shared resources (oven@T, sanitizer bucket, capacity windows).
   • Emits: synthesis.dedup.started, synthesis.dedup.merged, synthesis.dedup.completed

4) lead-time
   • LeadTimeCalculator derives base minutes (scraped/heuristic) and adjusts for household/env
     (altitude, room temp, appliance rates, batch size).
   • Emits: synthesis.leadtime.started, synthesis.leadtime.item, synthesis.leadtime.completed

5) validate
   • SynthesisValidator enforces 100% readiness coverage BEFORE marking sessions ready.
   • Emits: synthesis.validation.coverage, synthesis.validation.passed | failed
   • On success + commit, registers session.build.complete.

6) register/commit
   • Session suggestions are persisted (SessionsStore.bulkUpsert/updateMany).
   • Household mutation events:
       - sessions.committed
       - session.build.complete
     These may be exported to the Hub via exportToHubIfEnabled().

Event Model
-----------
• Single bus: src/services/events/eventBus.js
• Envelope: { type, ts, source, data } (ts = ISO string)
• Synthesis EventEmitter provides typed helpers for common events and handles optional Hub export for mutation events.

Files in This Folder
--------------------
- SynthesisEngine.js
  Core orchestrator that runs rules, aggregates steps/sessions, and optionally commits.

- SynthesisValidator.js
  Coverage check (100% readiness) prior to session.build.complete, with optional status commit.

- SynthesisDeDup.js
  Resource-aware merging (oven preheat, sanitizer bucket, capacity windows), plus general coalesce.

- LeadTimeCalculator.js
  Computes base + adjusted minutes and time windows from tables + prefs.

- PreferenceAdapter.js
  Loads/merges household and user preferences with runtime overrides and normalizers.

- RuleInterpreter.js
  Discovers/loads/normalizes rule packs (functional or declarative) per domain.

- EventEmitter.js
  Safe façade over eventBus with typed synthesis signals and optional Hub export.

Extension Points
----------------
Rules:
  • Declarative:
      {
        id: 'preheat-oven',
        domain: 'recipe',
        priority: 10,
        when:  ({item, ctx}) => boolean,
        produce: async ({item, ctx, options}) => ({ steps?, sessions?, diag? })
      }
  • Functional:
      export default async function ({item, ctx, options}) { ... }
  • Register at runtime: RuleInterpreter.registerRule(domain, rule)

Preferences:
  • PreferenceAdapter.registerNormalizer('recipe.spiceTolerance', fn)
  • PreferenceAdapter.registerSchema('preservation', schema)

Lead-time:
  • registerEstimator(kind, fn) e.g., 'autolyse', 'dry-brine'
  • registerAdjuster(id, fn) e.g., 'altitude.boil', 'roomTemp.proof'

Dedup:
  • registerMergeStrategy({ id, applies, merge })

Readiness Requirements:
  • SynthesisValidator.registerRequirement(rule)
    - Converts imports to required readiness keys (e.g., thaw-protein → satisfied by "thaw" step).

Shared Payload Shapes
---------------------
Readiness Step:
  {
    id: string,
    domain: 'recipe'|'cleaning'|'garden'|'animal'|'preservation'|string,
    title: string,
    dueBy: ISO|null,
    priority: number,
    meta?: { reason?: string, resource?: string, mergedFrom?: string[] }
  }

Session Suggestion:
  {
    id?: string,
    domain: 'cooking'|'cleaning'|'garden'|'animal'|'preservation'|string,
    title: string,
    start?: ISO|null,
    end?: ISO|null,
    needs?: { devices?: string[], people?: string[], capacity?: {id,units}[] },
    meta?: { refId?: string, origin?: 'synthesis'|string }
  }

Event Envelope (ALWAYS):
  { type: string, ts: ISO, source: string, data: any }

Household Mutation + Hub Export
-------------------------------
If an action modifies household data (inventory/storehouse/sessions), call:

  await exportToHubIfEnabled({
    type: '<event.type>',
    ts: new Date().toISOString(),
    source: '<module>',
    data: { ... }
  });

Implementation: checks featureFlags.familyFundMode, formats with HubPacketFormatter,
sends via FamilyFundConnector; all failures are silent and never throw.

Defensive Practices
-------------------
• Validate inputs and return early.
• Never throw from telemetry; logs/events must be best-effort.
• Keep unit-free internal math; only render units at UI boundaries.
• Cap event payload size and key count (EventEmitter does this).
• Soft-import optional modules (sessions store, hub, adapters) to keep SSA standalone.

Domain Rule Guidelines
----------------------
• Prefer small, pure rules with explicit priorities; avoid side-effects.
• Put resource hints into step.meta.resource (e.g., device:oven-1, capacity:stovetop).
• Tag readiness steps with meta.reason (e.g., 'frozen-protein', 'oven-method') so Validator can satisfy requirements reliably.
• Always return { steps?, sessions?, diag? } from produce().

Typical Flow (Recipe Example)
-----------------------------
1) Import normalized recipe → SynthesisEngine runs:
   - Rules add "Thaw chicken 12h", "Preheat oven", "Soak beans 8h", session "Cook: Roast Chicken".
2) SynthesisDeDup collapses multiple preheats.
3) LeadTimeCalculator assigns windows (e.g., thaw window start/end).
4) SynthesisValidator enforces 100% readiness (thaw/preheat present).
5) On ok + commit:
   - Sessions persisted (status: suggested → ready).
   - Events: sessions.committed, session.build.complete (with optional Hub export).

Testing Notes
-------------
• Unit tests live in src/tests/*.spec.js and should cover:
  - admission/feasibility checks (admission.spec.js)
  - resource conflicts (resourceAllocator.spec.js)
  - learning loop convergence (learningLoop.spec.js)
  - synthesis pipeline happy-path and edge cases per domain
• Use RuleInterpreter.registerRule() and PreferenceAdapter.setRuntimeOverride() to isolate cases.
• Assert events via a test double for eventBus.

Naming & Conventions
--------------------
• Domains are lowercase: recipe, cleaning, garden, animal, preservation, storehouse.
• Event types are dot-namespaced: 'synthesis.leadtime.completed', 'session.build.complete'.
• Resources use prefixes: device:<id>, capacity:<id>, consumable:<id>.

Troubleshooting
---------------
• Missing readiness → check Validator "byImport" coverage map.
• Duplicate steps → ensure meta.resource is consistent so DeDup can group them.
• Hub export silent → confirm featureFlags.familyFundMode = true and Hub services are reachable.

Future-Proofing
---------------
• Preservation/animal/storehouse can add rules without touching the orchestrator.
• Lead-time table loaders can be swapped (DB, JSON, scraper) without engine changes.
• PreferenceAdapter schemas and normalizers allow per-household customization at read-time.

EOF

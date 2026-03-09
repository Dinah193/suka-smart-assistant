# SSA Migration Plan — Replacing Old Agents with Shim Modules

_File: `src/docs/migration-plan.md`_

This document outlines a **practical, incremental plan** to migrate from
the original “AI Agent” architecture to the new **Shim + Orchestrator +
SessionRunner** stack in Suka Smart Assistant (SSA).

The goal is to:

- Keep SSA **usable and stable** during the transition,
- Avoid breaking pages that still depend on old agents,
- Move **one agent at a time** into clean, testable **shim modules**,
- Ensure all flows eventually emit **canonical events** and are runnable via
  the **SessionRunner** (where applicable).

---

## 1. Vocabulary & Roles (Quick Recap)

### 1.1 Old “Agent”

The original **Agent** was typically responsible for **everything**:

- Talking to the LLM / Reasoner,
- Doing scraping or business logic,
- Mutating state directly,
- Emitting events or triggering UI, often in an ad-hoc way.

This made it harder to:

- Test,
- Run in background-resilient ways,
- Swap Reasoner backends, and
- Reuse logic across domains.

### 1.2 New “Shim”

A **Shim** sits between:

- **UI / domain code** and
- The **Reasoner + Orchestrator infrastructure**.

Characteristics:

- **No direct UI knowledge** (pure functions + side-effect shims).
- Always uses **canonical event envelopes**:
  - `{ type, ts, source, data }`.
- For Reasoner calls, shims:
  - Build a **structured prompt payload**,
  - Call the Reasoner,
  - Validate **delta outputs** against schemas,
  - Return a **clean, typed response** to the caller.

Shims _do not_ own:

- Long-lived timers or UI state (that belongs to SessionRunner, pages, hooks),
- Direct Dexie writes (usually delegated to repositories or orchestrators),
- Notifications, TTS, or PiP (that belongs to SessionRunner / shell).

### 1.3 Orchestrator & Modes

The **Orchestrator** decides **how** the Reasoner is used:

- Light vs heavy calls,
- Multi-step vs single-step,
- Which schemas to validate against,
- Whether to allow follow-up calls.

It consults:

- `src/config/orchestrator.modes.json`,
- `src/config/reasoner.policy.json`,
- And uses the **shim** to enforce structured input/output.

---

## 2. Migration Objectives

1. **Centralize Reasoner behavior**  
   All LLM calls go through orchestrator + reasoner policies, not directly from
   random domain code.

2. **Standardize event emissions**  
   Session and agent flows must use canonical events:
   - `session.started`, `session.step.changed`, …
   - For agents: `reasoner.invoked`, `reasoner.completed`, `reasoner.error`
     (or similar), always via eventBus.

3. **Decouple UI from Reasoner**  
   UI components should call **shims**, not agents. Shims are pure functions
   plus eventBus emissions and orchestrator calls.

4. **Make background behavior reliable**  
   By pushing timers, checkpoints, and “long running” work into:
   - **SessionRunner**, Dexie,
   - Background Workers (where applicable),
   - Guard modules (Sabbath, Quiet Hours, etc.).

5. **Incremental, low-risk rollout**  
   Migrate **one agent at a time**, maintain compatibility via:
   - Adapter functions,
   - Feature flags when needed.

---

## 3. Inventory the Existing Agents

> _Goal_: Know what you’re replacing and in what order.

1. **Locate all agents**  
   Typical folders (adjust as needed):
   - `src/agents/`
   - `src/services/agent/`
   - Any legacy “AI helper” modules in `src/features/**/agents`.

2. **Create an inventory file**  
   Example: `src/docs/agents-inventory.md` with a table:

   | Agent Name                    | Domain     | Entry File                                   | Used By (UI / Services)                       | Status |
   | ----------------------------- | ---------- | -------------------------------------------- | --------------------------------------------- | ------ |
   | CookingAgent                  | cooking    | `src/agents/CookingShim.js`                  | `CookingPage`, `BatchPlanner`, `RecipeImport` | legacy |
   | CleaningRoutineAgent          | cleaning   | `src/agents/CleaningRoutineShim.js`          | `CleaningPage`, `ZonesPlanner`                | legacy |
   | GardenScheduleAgent           | garden     | `src/agents/GardenScheduleShim.js`           | `GardenPage`, `GardenCalendar`                | legacy |
   | AnimalsButcheryAgent          | animals    | `src/agents/AnimalsButcheryShim.js`          | `AnimalsPage`, `ButcheryWizard`               | legacy |
   | StorehouseStoragePlannerAgent | storehouse | `src/agents/StorehouseStoragePlannerShim.js` | `StorehousePage`, `StoragePlanner`            | legacy |
   | ShoppingConsolidateListAgent  | shopping   | `src/agents/ShoppingConsolidateListShim.js`  | `ShoppingPage`, `ListConsolidator`            | legacy |

3. **Prioritize migration order**

   Suggested order:
   1. **Shopping / storehouse** (low risk, high user value),
   2. **Cooking** (heavily used; unlocks SessionRunner goodness),
   3. **Cleaning / garden**,
   4. **Animals / preservation** (butchery, heavy sessions),
   5. Other minor or experimental agents.

---

## 4. Shim Design Pattern (Per Agent)

For each agent, we create a **shim module** under:

- `src/agents/shims/<domain>/<name>.shim.js`  
  Examples:
  - `src/agents/shims/cooking/sessionComposer.shim.js`
  - `src/agents/shims/cleaning/routineComposer.shim.js`
  - `src/agents/shims/animals/butchery.shim.js`

### 4.1 Shim Structure

Each shim:

1. **Defines input contracts** (with JSDoc typedefs or inline types).
2. **Builds a Reasoner request**:
   - Mode, schema, and policy drawn from config.
3. **Invokes the orchestrator** in a single place (e.g., `orchestrator.run()`).
4. **Validates** the returned `delta` payload against the expected schema.
5. **Emits canonical events** via `eventBus`:
   - `reasoner.invoked`, `reasoner.completed`, `reasoner.error`.
6. **Returns** a **clean, predictable result** to domain code.

Pseudocode structure:

```js
/**
 * src/agents/shims/cooking/sessionComposer.shim.js
 */
import eventBus from '@/services/events/eventBus';
import { runOrchestrator } from '@/agents/orchestrator'; // your orchestrator shim
import reasonerPolicy from '@/config/reasoner.policy.json';
import orchestratorModes from '@/config/orchestrator.modes.json';

/**
 * @typedef {Object} CookingComposeSessionInput { ... }
 * @typedef {Object} CookingComposeSessionResult { ... }
 */

const SOURCE = 'agents/shims/cooking/sessionComposer';

/**
 * Compose a cooking Session plan based on normalized recipe + constraints.
 *
 * @param {CookingComposeSessionInput} input
 * @returns {Promise<CookingComposeSessionResult>}
 */
export async function composecookingSessionShim(input) {
  const ts = new Date().toISOString();

  eventBus.emit({
    type: 'reasoner.invoked',
    ts,
    source: SOURCE,
    data: { mode: 'cooking.composeSession', input },
  });

  try {
    const modeCfg = orchestratorModes.modes['cooking.composeSession'];
    const policyCfg = reasonerPolicy.modes['cooking.composeSession'] || reasonerPolicy.defaults;

    const result = await runOrchestrator({
      mode: 'cooking.composeSession',
      input,
      modeConfig: modeCfg,
      policy: policyCfg,
    });

    // Validate `result.delta` against cooking.composeSession schema here

    eventBus.emit({
      type: 'reasoner.completed',
      ts: new Date().toISOString(),
      source: SOURCE,
      data: { mode: 'cooking.composeSession', ok: true },
    });

    return result;
  } catch (error) {
    eventBus.emit({
      type: 'reasoner.error',
      ts: new Date().toISOString(),
      source: SOURCE,
      data: { mode: 'cooking.composeSession', error: String(error) },
    });
    throw error;
  }
}
5. Step-by-Step Migration for a Single Agent
We migrate one agent at a time using the pattern below.

5.1 Choose Agent & Create Matching Shim Skeleton
Pick a legacy agent (e.g., CookingAgent).

Locate its responsibilities:

inputs it expects (props, store, context),

outputs it provides (sessions, UI hints, raw text, etc.),

side effects (eventBus, Dexie, UI triggers).

Create a new shim file:

src/agents/shims/cooking/sessionComposer.shim.js.

Copy only the pure logic or prompt-building logic into the shim.

Remove direct UI/Dexie/eventBus logic from the legacy agent; the shim should
only use:

the canonical eventBus envelope, and

orchestrator + policy.

5.2 Wire Shims into Orchestrator Modes & Policies
Update or confirm:

src/config/orchestrator.modes.json

src/config/reasoner.policy.json

Ensure there is a mode entry for the shim you’re working on, e.g.:

jsonc
Copy code
{
  "modes": {
    "cooking.composeSession": {
      "description": "Compose structured cooking Session plan from recipe + constraints",
      "inputSchema": "schemas/skills/cooking.composeSession.input.json",
      "outputSchema": "schemas/skills/cooking.composeSession.output.json",
      "maxSteps": 1,
      "allowFollowUps": false,
      "guardPipelines": ["sabbath", "quietHours", "inventory"]
    }
  }
}
and in reasoner.policy.json:

jsonc
Copy code
{
  "defaults": {
    "model": "gpt-4.1-mini",
    "maxPromptTokens": 3200,
    "maxCompletionTokens": 1200,
    "maxFollowUps": 0
  },
  "modes": {
    "cooking.composeSession": {
      "model": "gpt-4.1",
      "maxPromptTokens": 6000,
      "maxCompletionTokens": 2000,
      "maxFollowUps": 1
    }
  }
}
5.3 Add Validation Specs
Add or update test notes:

src/tests/skills/cooking.composeSession.spec.md

src/tests/agents/reasoner.delta.validation.spec.md

Make sure:

The structured output expected from the shim matches the Session contract
and any relevant delta schema.

Tests cover:

sane input → valid Session,

invalid input → safe error or empty plan,

deterministic behavior for the same input.

5.4 Create Adapter for Legacy Call Sites
Instead of immediately refactoring all call sites, create a small adapter
inside the legacy agent file:

js
Copy code
// src/agents/CookingShim.js
import { composecookingSessionShim } from '@/agents/shims/cooking/sessionComposer.shim';

/**
 * Legacy wrapper used by existing UI.
 * TODO: mark as deprecated; remove once all callsites use shims directly.
 */
export async function CookingAgentComposeSession(legacyInput) {
  // transform legacyInput into the new shim input shape
  const shimInput = legacyToShimInput(legacyInput);
  const result = await composecookingSessionShim(shimInput);
  return shimResultToLegacy(result);
}
This lets:

Existing UI components keep calling CookingAgentComposeSession,

Internally, it routes through the new shim + orchestrator logic,

You reduce risk while still introducing the new architecture.

Later, you can:

Update UI to call composecookingSessionShim directly,

Delete the adapter.

5.5 Add Logging & Event Observability
Make sure:

The shim emits reasoner.invoked, reasoner.completed, reasoner.error,

SessionRunner and ToastBus can listen for these events (for debugging).

Optional: add Dev Tools panel later to visualize Reasoner calls.

6. Mapping Old Agents → New Shims
Use this table as the template for your actual mapping:

Old Agent	New Shim Module Path	Orchestrator Mode	Notes
CookingAgent	agents/shims/cooking/sessionComposer.shim.js	cooking.composeSession	Compose cooking Sessions from recipes + context.
CleaningRoutineAgent	agents/shims/cleaning/routineComposer.shim.js	cleaning.composeRoutine	Build routine Sessions for zones/rooms.
GardenScheduleAgent	agents/shims/garden/schedulePlanner.shim.js	garden.schedule	Plan sow/plant/harvest tasks as Sessions.
AnimalsButcheryAgent	agents/shims/animals/butchery.shim.js	animals.butchery.cutSheet	Use butchery.cutSheet skill output as base.
StorehouseStoragePlannerAgent	agents/shims/storehouse/storagePlanner.shim.js	storehouse.storagePlanner	Map inventory → zones; plan storage Sessions.
ShoppingConsolidateListAgent	agents/shims/shopping/consolidateList.shim.js	shopping.consolidateList	Combine lists; emit store-aware shopping plan.

Each shim should also be reflected in:

orchestrator.modes.json,

reasoner.policy.json,

Test notes under src/tests/agents and src/tests/skills.

7. SessionRunner Integration Touchpoints
Although shims are Reasoner-centric, their outputs are often used to build
Session objects that the SessionRunner will execute.

For each domain:

Identify where Sessions are created:

e.g., cooking.composeSession, cleaning.composeRoutine,
garden.schedule, animals.butchery.cutSheet, etc.

Ensure outputs include everything needed to build a Session:

steps with id, title, desc, durationSec, blockers, metadata.

Make sure Session creation logic:

Writes to Dexie (sessions store),

Emits session events via session.events.js shims:

session.started, session.step.changed, session.checkpoint.written,
etc.

Verify that ToastBus listens to:

Session lifecycle events and reflects them in user-friendly toasts.

Note: Shims should not know about SessionRunner directly; they only
provide the plans that the domain code turns into Sessions.

8. Background-Resilient Behavior
Most of the background-resilient behavior (surviving navigation, reloads,
tab switches) belongs to:

SessionRunner and its hooks (useSessionRunner, Dexie integration),

Background worker(s) for timers,

Guard modules (Sabbath, Quiet Hours, Weather, etc.).

Shims support this by:

Producing stable, structured session plans,

Emitting reasoner. events* that SessionRunner, orchestrator, or dev tools
can listen to.

No additional work is needed in shims for:

Wake Lock,

Notifications,

PiP,

Media Session API,

beyond plugging any labels/metadata required by those layers.

9. Testing & Validation Strategy
For each migrated agent:

Unit tests / spec docs:

src/tests/skills/<domain>.<skill>.spec.md

src/tests/agents/reasoner.delta.validation.spec.md

Focus on:

input → structured output,

schema compliance,

predictable error behavior.

Integration tests (manual or automated):

Run the UI pages that depend on that agent:

e.g., CookingPage, CleaningPage, etc.

Verify:

No runtime errors,

Sessions are created and runnable,

Toasts & events fire correctly,

Session Runner can start/resume sessions created from shim outputs.

Event sanity:

Use console logs or dev tooling to confirm:

reasoner.invoked and reasoner.completed appear with right payloads.

Session events fire as expected.

Backwards compatibility:

While adapters exist, compare behavior of:

Old agent path vs new shim path for the same input.

Aim for functionally equivalent behavior before deleting the old code.

10. Decommissioning Old Agents
Once a shim is stable and fully wired:

Update all call sites to use the shim or domain-level wrappers.

Remove legacy agent exports:

e.g., CookingAgentComposeSession wrapper.

Delete or archive the agent file:

If archived, mark clearly as deprecated and not imported anywhere.

Update docs:

Remove references to the old agent,

Add references to the shim and orchestrator mode instead.

Run full test suite:

Ensure no references remain to the old agent.

11. Recommended Migration Sequence
You can use this high-level checklist as your working migration board:

Shopping / Storehouse

 shopping.consolidateList shim created

 storehouse.storagePlanner shim created

 modes & policy updated

 legacy agent wrappers in place

 tests written

Cooking

 cooking.composeSession shim created

 SessionRunner integration validated

 cooking tests updated

Cleaning

 cleaning.composeRoutine shim created

 zone/room routine tests updated

Garden

 garden.schedule shim created

 season/calendar integration validated

Animals & Preservation

 animals.butchery.cutSheet shim created (using notes in animals.butcheryCutSheet.spec.md)

 preservation & storehouse Sessions wired

Global Reasoner & Orchestrator

 all modes moved to orchestrator.modes.json

 all per-mode Reasoner policies moved to reasoner.policy.json

 legacy Reasoner config removed

12. Long-Term: Swap Modal for Agent/Shim Runtime
As more shims come online, you can later add a “Swap Runtime” modal for
development and debugging:

Choose between:

local mock implementation,

real Reasoner via orchestrator,

“playback” mode using stored deltas for testing.

This modal would:

Live at app root (like SessionRunner),

Use eventBus signals like:

reasoner.swap.request,

reasoner.swap.applied,

Be purely a dev / admin tool and not required for normal SSA users.

This is not required for the initial migration, but the shim architecture
makes it straightforward to introduce later because all Reasoner calls are
funnelled through shims + orchestrator.

13. Summary
Old Agents are being replaced by Shims that:

Talk to the Reasoner via Orchestrator,

Enforce schemas and policies,

Emit canonical events,

Return clean, testable outputs to SSA.

The migration is incremental and low-risk:

one agent → one shim,

adapter wrappers for old call sites,

tests and policies per mode.

Once complete:

SSA will have a consistent, observable Reasoner layer,

Domain pages can confidently create Sessions for the SessionRunner,

All long-running behavior is resilient to navigation and reloads.

Use this document as the living checklist for completing the migration
from old agents to the new shim architecture.
```

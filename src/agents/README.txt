Suka Smart Assistant (SSA) – Agents Overview & Authoring Guide
==============================================================

File: src/agents/README.txt
Last updated: 2025-11-18


0. What “Agents” Are in SSA
===========================

In Suka Smart Assistant (SSA), an “agent” is a small, domain-aware PLANNING
module that sits between:

  • imports  → (recipes, cleaning routines, garden/seed info, animal guides, 
               storehouse/grocery info, how-to videos)
  • household context → (inventory, calendar, roles, seasons, animals, zones)
  • SessionRunner     → (cooking, cleaning, garden, animal care, butchery, 
                         preservation sessions)
  • automation runtime → (suggested schedules, reminders, workflows)

Agents DO NOT directly run steps or control the UI.

Instead, they:

  1. Listen for relevant events on the event bus.
  2. Generate high-level PLANS:
       - sessions (things you can “play now” in SessionRunner)
       - schedules (collections of sessions over time)
  3. Emit structured telemetry using `agent.*` events:
       - agent.invoked
       - agent.plan.generated / agent.plan.failed
       - agent.session.generated / agent.session.userCreated
       - agent.schedule.generated / agent.schedule.userCreated
       - agent.reverseGeneration.* (for history → templates)
       - agent.context.updated.* (cleaning, garden, storehouse, meals, animals)
  4. Update usage counters and budgets through `telemetry/counters.js` (indirectly).
  5. Optionally export usage snapshots to the Hub (Family Fund mode).

Agents are implemented as **lightweight shims** that wrap model calls, rules,
and heuristics behind a stable contract. The rest of SSA treats them as black
boxes that take inputs and emit events.


1. Domains Covered by Agents
============================

Agents currently coordinate these domains, aligned with SSA’s goals:

  • CLEANING
      - Room / zone based cleaning
      - Daily resets, weekly resets, deep cleans
      - Inspiration: modern cleaning apps, “reset” flows, and weekly reset 
        layouts on lifestyle websites.

  • GARDEN PLANNING, CARE & HARVEST
      - Bed layout, crop planning, season-aware tasks
      - Care sessions (watering, pruning, pest checks)
      - Harvest sessions that link to inventory and meals
      - Inspiration: garden planners with seasonal views and crop cards.

  • STOREHOUSE STOCK PLANNING (GROCERY SECTIONS)
      - Plans framed in “storehouse as grocery store” mental model:
          Produce, Meat + Freezer, Dairy, Pantry + Baking, Frozen, 
          Household + Cleaning, Personal Care.
      - Stock-up sessions that tightly integrate with meal plans and inventory
        shortages.
      - Inspiration: grocery shopping apps and “restock” pages that group by
        sections for intuitive navigation.

  • MEAL PLANNING & BATCH COOKING
      - Meal plans, batch cooking sessions, integrated timers
      - Links to inventory, recipe vault, grocery sections, and garden harvest
      - “Play now” flows that feel like a guided cooking experience.

  • ANIMAL ACQUISITION, CARE & BUTCHERY
      - Acquisition preferences (species, seasons, sources)
      - Routine care sessions (weekly goat care, chicken checks, etc.)
      - Butchery day sessions that link to preservation and storehouse
      - Inspiration: well-structured livestock management tools and homesteading
        guides.

All agents follow the same basic pattern and share the same telemetry and 
counter infrastructure.


2. Event Bus & Telemetry Overview
=================================

SSA is **event-driven**. All agent communication flows through the shared
event bus:

  src/services/eventBus.js

Agents USE, not own, the bus. They emit:

  emit({
    type,   // string, e.g. "agent.plan.generated"
    ts,     // ISO timestamp
    source, // string, e.g. "agents/meals/mealShim"
    data    // domain-specific payload
  });

Key telemetry modules:

  • src/agents/telemetry/events.md
      - Defines all `agent.*` events and payloads.
      - Use this as the canonical contract.

  • src/agents/telemetry/counters.js
      - Simple usage counters for budgets: per-domain invocation, favorites,
        reverse generation, etc.
      - Used by central event router to track usage budgets and patterns.

The central event router should call:

  handleTelemetryEvent(evt)

for each event emitted on the bus. This updates domain-aware counters across
cleaning, garden, storehouse, meals, and animals.


3. Session & Schedule Concepts
==============================

Agents generate two main structures:

  1. AgentSession
  2. AgentSchedule

These are PLANNING artifacts, NOT runtime objects. SessionRunner and other 
layers may enrich them.

3.1 AgentSession (Normalized)

Every session follows this shape:

  /**
   * @typedef {"cleaning"|"garden"|"storehouse"|"meals"|"animals"} AgentDomain
   * @typedef {"system"|"user"|"reverse"} OriginKind
   *
   * @typedef {Object} AgentSession
   * @property {string} id
   * @property {AgentDomain} domain
   * @property {string} title
   * @property {string[]} tags
   * @property {OriginKind} origin       // system | user | reverse
   * @property {boolean} isTemplate      // can be reused
   * @property {boolean} isFavorite      // per user
   * @property {string|null} favoriteOwnerId
   * @property {("planned"|"running"|"completed"|"abandoned")} status
   * @property {Object[]} steps          // domain-specific steps
   * @property {Object} context          // domain-specific snapshot
   */

Domain-specific examples:

  • CLEANING:
      context.room, context.zone, context.frequency.

  • GARDEN:
      context.season, context.beds, context.crops, context.harvestWindow.

  • STOREHOUSE:
      context.grocerySections, context.storeLocation, context.shortages.

  • MEALS:
      context.mealWindow, context.batchSizeMeals, context.integratedTimers.

  • ANIMALS:
      context.species, context.stage ("acquisition", "routine care", "butchery"),
      and links to preservation sessions.

3.2 AgentSchedule (Cross-Domain)

Schedules allow SSA to behave like a “smart homestead calendar”:

  /**
   * @typedef {Object} AgentScheduleBlock
   * @property {string} id
   * @property {string} sessionId
   * @property {string} fromTs
   * @property {string} toTs
   * @property {("soft"|"hard")} firmness
   *
   * @typedef {Object} AgentSchedule
   * @property {string} id
   * @property {string} title
   * @property {AgentDomain[]} domains
   * @property {OriginKind} origin
   * @property {boolean} isFavorite
   * @property {string|null} favoriteOwnerId
   * @property {AgentScheduleBlock[]} blocks
   * @property {Object} meta
   */

Typical schedule patterns:

  • Daily Kitchen Reset (cleaning + meals)
  • Weekly Garden & Animal Care Morning (garden + animals)
  • Monthly Storehouse Stock-Up (storehouse + meals)
  • Seasonal Harvest & Preservation Weekend (garden + animals + storehouse + meals)


4. Favorites & Reverse Generation
=================================

4.1 Favorites: Sessions & Schedules

Users must be able to save THEIR OWN favorite sessions and schedules, NOT only
system ones. This is how SSA learns household patterns.

Agents and UI should emit these events:

  • agent.session.favorite.saved
  • agent.session.favorite.removed
  • agent.schedule.favorite.saved
  • agent.schedule.favorite.removed

Sessions and schedules themselves carry favorite state:

  - isFavorite: boolean
  - favoriteOwnerId: userId or null

Counters track favorites at domain and origin level through 
`telemetry/counters.js`.

4.2 Reverse Generation

Reverse generation means:

  Look at what the household actually does over time:
    - session history
    - calendar usage
    - imports
  → Derive templates and preferences.

Key events:

  • agent.reverseGeneration.requested
  • agent.reverseGeneration.completed
  • agent.reverseGeneration.failed

Typical uses:

  - Turn repeated “Weekly Goat Care” into a reusable template.
  - Turn repeated “Homestead Saturday” schedules into a named schedule.
  - Detect that user always batches soups on Sunday afternoons in winter and
    auto-suggest “Sunday Soup & Stew Batch” with correct times and inventory 
    usage.


5. Agent Shim Contract
======================

Each agent lives under:

  src/agents/<domain>/<name>Shim.js

For example:

  - src/agents/meals/mealShim.js
  - src/agents/cleaning/cleaningShim.js
  - src/agents/garden/gardenShim.js
  - src/agents/storehouse/storehouseShim.js
  - src/agents/animals/animalsShim.js

A shim typically exports:

  • planForward(input)
      - Given goals, constraints, and context, generate sessions and schedules.
      - Emit `agent.invoked` and `agent.plan.generated` or `agent.plan.failed`.
      - Emit `agent.session.generated` and `agent.schedule.generated` for each
        artifact created.

  • planReverse(input)
      - Perform reverse generation.
      - Emit `agent.reverseGeneration.requested` and `...completed` or `...failed`.

  • handleEvent(evt)
      - Optional: react to events (e.g. inventory.updated, garden.harvest.logged,
        session.completed) to adjust future planning or context.

Example skeleton:

  // src/agents/meals/mealShim.js
  const { emit } = require("@/services/eventBus");

  async function planForward(input) {
    const ts = new Date().toISOString();

    emit({
      type: "agent.invoked",
      ts,
      source: "agents/meals/mealShim",
      data: {
        domain: "meals",
        agentId: "meals-planner-v1",
        mode: "forward",
        reason: input.reason || "user.request",
        input
      }
    });

    try {
      // 1) Gather context (inventory, calendar, recipes, garden harvest)
      // 2) Apply rules and heuristics
      // 3) Build AgentSession[] and AgentSchedule[] outputs

      const sessions = [];  // fill in
      const schedules = []; // fill in

      emit({
        type: "agent.plan.generated",
        ts: new Date().toISOString(),
        source: "agents/meals/mealShim",
        data: {
          domain: "meals",
          agentId: "meals-planner-v1",
          mode: "forward",
          sessions,
          schedules,
          meta: {
            sabbathGuardApplied: !!input.constraints?.sabbathSafe
          }
        }
      });

      // Emit per-session / per-schedule events so other parts of SSA can react.
      for (const s of sessions) {
        emit({
          type: "agent.session.generated",
          ts: new Date().toISOString(),
          source: "agents/meals/mealShim",
          data: { domain: "meals", session: s }
        });
      }

      for (const sched of schedules) {
        emit({
          type: "agent.schedule.generated",
          ts: new Date().toISOString(),
          source: "agents/meals/mealShim",
          data: { domain: "meals", schedule: sched }
        });
      }

      return { sessions, schedules };
    } catch (err) {
      emit({
        type: "agent.plan.failed",
        ts: new Date().toISOString(),
        source: "agents/meals/mealShim",
        data: {
          domain: "meals",
          agentId: "meals-planner-v1",
          mode: "forward",
          errorCode: "PLANNING_ERROR",
          message: err && err.message
        }
      });
      throw err;
    }
  }

  async function planReverse(input) {
    const ts = new Date().toISOString();

    emit({
      type: "agent.reverseGeneration.requested",
      ts,
      source: "agents/meals/mealShim",
      data: {
        domain: "meals",
        agentId: "meals-planner-v1",
        userId: input.userId,
        sourceWindow: input.sourceWindow,
        sources: input.sources,
        goal: input.goal
      }
    });

    try {
      // 1) Inspect session + calendar history
      // 2) Find repeated patterns
      // 3) Create AgentSession templates / schedules with origin: "reverse"

      const createdSessions = [];   // fill in
      const createdSchedules = [];  // fill in
      const inferredPreferences = {}; // e.g. preferred batchCooking window

      emit({
        type: "agent.reverseGeneration.completed",
        ts: new Date().toISOString(),
        source: "agents/meals/mealShim",
        data: {
          domain: "meals",
          agentId: "meals-planner-v1",
          userId: input.userId,
          createdSessions,
          createdSchedules,
          inferredPreferences
        }
      });

      // also emit agent.session.generated for each createdSession if appropriate
      for (const s of createdSessions) {
        emit({
          type: "agent.session.generated",
          ts: new Date().toISOString(),
          source: "agents/meals/mealShim",
          data: { domain: "meals", session: s }
        });
      }

      for (const sched of createdSchedules) {
        emit({
          type: "agent.schedule.generated",
          ts: new Date().toISOString(),
          source: "agents/meals/mealShim",
          data: { domain: "meals", schedule: sched }
        });
      }

      return { createdSessions, createdSchedules, inferredPreferences };
    } catch (err) {
      emit({
        type: "agent.reverseGeneration.failed",
        ts: new Date().toISOString(),
        source: "agents/meals/mealShim",
        data: {
          domain: "meals",
          agentId: "meals-planner-v1",
          userId: input.userId,
          errorCode: "REVERSE_ERROR",
          message: err && err.message,
          sources: input.sources
        }
      });
      throw err;
    }
  }

  function handleEvent(evt) {
    // Optional: respond to inventory.updated, garden.harvest.logged, etc.
    // For example:
    //  - Record that user often cooks right after a harvest.
    //  - Adjust reverse-generation patterns.
  }

  module.exports = {
    planForward,
    planReverse,
    handleEvent
  };


6. Integration with SessionRunner & Automation
==============================================

Agents do NOT run sessions directly. Instead:

  1. Agents generate AgentSessions and AgentSchedules.
  2. Session orchestration stores them in Dexie and/or memory.
  3. Domain pages show “Play Now” buttons on sessions and schedules.
  4. Clicking “Play Now” opens the `SessionRunner` modal.
  5. SessionRunner emits runtime events:
       - session.runner.started
       - session.runner.stepChanged
       - session.runner.completed
       - session.runner.abandoned
  6. These runtime events can be fed back into agents for reverse generation
     and preference learning.

Automation Runtime:

  • Listens for key agent + session events:
      - agent.plan.generated
      - agent.context.updated.*
      - session.completed

  • Suggests:
      - daily flows (cleaning + meals)
      - homestead days (garden + animals + meals)
      - stock-up days (storehouse + meals + cleaning)

  • Never breaks Sabbath guard (if enabled).


7. Authoring a New Agent
========================

To author a new agent (for example, a “preservation” agent, or a more detailed
“butchery” agent):

1) Create folder and shim:

   - src/agents/preservation/preservationShim.js

2) Export at least:

   - planForward(input)
   - planReverse(input) (optional but recommended)
   - handleEvent(evt) (optional)

3) Use the shared contracts:

   - See src/agents/telemetry/events.md for `agent.*` event payloads.
   - Use AgentSession and AgentSchedule shapes from this README.

4) Emit telemetry events:

   - Always emit agent.invoked before planning.
   - Emit agent.plan.generated or agent.plan.failed after planning.
   - Emit agent.session.generated and agent.schedule.generated for each output.
   - Implement reverse generation events where appropriate.

5) Keep it DOMAIN-AWARE and INTUITIVE:

   - Use intuitive groupings, like “grocery sections” for storehouse.
   - Use calendar-friendly windows, like “Sunday afternoon batch cook”.
   - Follow patterns from well-executed websites (clear labels, tags that match
     how humans think: “Reset”, “Deep Clean”, “Batch Cook”, “Stock Up”, etc.)

6) Respect budgets:

   - Your agent doesn’t check budgets directly.
   - The central event router + telemetry/counters.js keep track of usage.
   - If needed, automation runtime can throttle calls to planForward /
     planReverse based on budget status.

7) Support favorites:

   - If your agent or UI creates sessions/schedules that users “star” or “heart”,
     make sure favorites are:
       - persisted with isFavorite + favoriteOwnerId
       - mirrored in telemetry via agent.session.favorite.* /
         agent.schedule.favorite.* events.


8. Best Practices
=================

  • Keep shims SMALL and FOCUSED
      - One domain / concern per shim.
      - Compose internal utilities instead of writing monolith logic.

  • Treat agents as PURE PLANNERS
      - No direct DOM manipulation or UI control.
      - No direct SessionRunner invocation.

  • Emit EVENTS FIRST, then refine later
      - It is better to emit a simplified but correct event and enrich later,
        than to skip events entirely.

  • Honor Sabbath / Rest rules
      - If sabbathGuard is enabled, avoid scheduling disallowed work.

  • Make reverse generation a first-class citizen
      - Every time you think “user keeps doing this manually,” consider whether
        your agent can:
         - detect it
         - offer a template
         - suggest adding to favorites

  • Keep JSON shapes stable
      - If you change session or schedule shapes, update:
         - src/agents/telemetry/events.md
         - This README
         - Any schemas or validators used elsewhere.


9. Where to Look Next
=====================

  • src/agents/telemetry/events.md
      - Full catalog of `agent.*` events.

  • src/agents/telemetry/counters.js
      - How usage counters are tracked and budgets are enforced.

  • src/services/eventBus.js
      - Core event bus.

  • src/services/featureFlags.js
      - familyFundMode & other flags that may affect agent behavior.

  • SessionRunner implementation
      - How sessions are played, how runtime events are emitted.

Use this README as the canonical guide when authoring or refactoring agents
in the SSA codebase.

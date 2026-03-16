# Agent Telemetry Events (`agent.*`)

This document defines the **agent-level telemetry events** for the Suka Smart Assistant (SSA).

These events sit **above** the raw domain imports and **alongside** `session.*`, `import.*`, and `automation.*` events:

- Agents consume imports + history → generate sessions & schedules
- Users can accept, edit, favorite, or discard those suggestions
- Telemetry is used for:
  - training better suggestions (per-household & global)
  - reverse generation (deriving reusable sessions/schedules from history)
  - optional export to Family Fund Hub when `familyFundMode === true`

All events are emitted through the shared event bus:

```js
// src/services/events/eventBus.js
emit({
  type,   // string, e.g. "agent.session.generated"
  ts,     // ISO timestamp
  source, // string, e.g. "agents/meals/mealShim"
  data    // domain-specific payload
});
1. Shared Types
To keep SSA consistent, all agent telemetry payloads follow a small set of shared shapes.

js
Copy code
/**
 * @typedef {"cleaning"|"garden"|"storehouse"|"meals"|"animals"} AgentDomain
 */

/**
 * Who originated the session or schedule.
 * - "system": seeded templates, global rules, default playbooks
 * - "user": hand-built by the household
 * - "reverse": auto-derived from historical usage (reverse generation)
 */
/// @typedef {"system"|"user"|"reverse"} OriginKind

/**
 * @typedef {Object} AgentSession
 * @property {string} id              // session ID (Dexie + runtime)
 * @property {AgentDomain} domain
 * @property {string} title
 * @property {string[]} tags
 * @property {OriginKind} origin
 * @property {boolean} isTemplate     // true = reusable template
 * @property {boolean} isFavorite     // per user/household
 * @property {string|null} favoriteOwnerId // null or userId
 * @property {("planned"|"running"|"completed"|"abandoned")} status
 * @property {Object[]} steps         // domain-specific steps (normalized)
 * @property {Object} context         // domain-specific context snapshot
 */

/**
 * @typedef {Object} AgentScheduleBlock
 * @property {string} id
 * @property {string} sessionId
 * @property {string} fromTs          // ISO start
 * @property {string} toTs            // ISO end
 * @property {("soft"|"hard")} firmness
 */

/**
 * @typedef {Object} AgentSchedule
 * @property {string} id
 * @property {string} title
 * @property {AgentDomain[]} domains
 * @property {OriginKind} origin
 * @property {boolean} isFavorite
 * @property {string|null} favoriteOwnerId
 * @property {AgentScheduleBlock[]} blocks
 * @property {Object} meta            // e.g. sabbathGuard, season, theme
 */

/**
 * @typedef {Object} ReverseGenerationSource
 * @property {("session.history"|"calendar.history"|"import.patterns")} kind
 * @property {string[]} ids // session IDs, calendar event IDs, import IDs
 */
NOTE: These typings are for documentation & JSDoc only.
Implementation can stay plain JavaScript; use them as a contract.

2. Top-Level Event List
All new agent telemetry events live under the agent.* namespace:

Agent Invocation / Result

agent.invoked

agent.plan.generated

agent.plan.failed

Session Creation & Favorites

agent.session.generated

agent.session.userCreated

agent.session.favorite.saved

agent.session.favorite.removed

Schedule Creation & Favorites

agent.schedule.generated

agent.schedule.userCreated

agent.schedule.favorite.saved

agent.schedule.favorite.removed

Reverse Generation (from history → templates)

agent.reverseGeneration.requested

agent.reverseGeneration.completed

agent.reverseGeneration.failed

Domain-Specific Context Intel

agent.context.updated.cleaning

agent.context.updated.garden

agent.context.updated.storehouse

agent.context.updated.meals

agent.context.updated.animals

These are planning / orchestration events, not runtime (session.runner.*) events—that layer already exists for SessionRunner.

3. Event Contracts
3.1 agent.invoked
Agent was asked to perform a planning task (generate or reverse-generate a plan).

js
Copy code
// type: "agent.invoked"
{
  type: "agent.invoked",
  ts: "2025-11-18T17:00:00.000Z",
  source: "agents/meals/mealShim",
  data: {
    domain: /** @type {AgentDomain} */ ("meals"),
    agentId: "meals-planner-v1",
    mode: "forward", // "forward" | "reverse"
    reason: "user.request", // e.g. "automation.trigger", "user.request"
    input: {
      // Forward example (meal planning)
      goals: ["batch-cook for 3 days", "use up wilting greens"],
      constraints: {
        timeBudgetMinutes: 120,
        maxSimultaneousTimers: 4,
        sabbathSafe: true
      },
      links: {
        inventorySnapshotId: "inv-2025-11-18",
        calendarWindow: ["2025-11-18", "2025-11-20"]
      }
    }
  }
}
3.2 agent.plan.generated
Agent produced a high-level plan (sessions + optional schedule).

js
Copy code
// type: "agent.plan.generated"
{
  type: "agent.plan.generated",
  ts: "2025-11-18T17:02:10.000Z",
  source: "agents/meals/mealShim",
  data: {
    domain: "meals",
    agentId: "meals-planner-v1",
    mode: "forward",
    sessions: /** @type {AgentSession[]} */ ([/* see below */]),
    schedules: /** @type {AgentSchedule[]} */ ([/* optional */]),
    meta: {
      sabbathGuardApplied: true,
      usedInventoryShortageSignals: true
    }
  }
}
The actual sessions & schedules are captured again in the more specific events below.

3.3 agent.plan.failed
Agent tried and failed.

js
Copy code
// type: "agent.plan.failed"
{
  type: "agent.plan.failed",
  ts: "2025-11-18T17:02:10.000Z",
  source: "agents/cleaning/cleaningShim",
  data: {
    domain: "cleaning",
    agentId: "cleaning-planner-v1",
    mode: "forward",
    errorCode: "NO_VALID_WINDOW", // or "MISSING_CONTEXT", "RULE_CONFLICT"
    message: "No non-sabbath window available for requested tasks",
    debug: {
      requestedTasks: ["deep-clean oven"],
      blockedBy: ["sabbathGuard"]
    }
  }
}
3.4 agent.session.generated
Emitted whenever an agent creates or updates a session (for any domain).

js
Copy code
// type: "agent.session.generated"
{
  type: "agent.session.generated",
  ts: "2025-11-18T17:03:00.000Z",
  source: "agents/cleaning/cleaningShim",
  data: {
    domain: "cleaning",
    session: /** @type {AgentSession} */ ({
      id: "sess-clean-kitchen-reset-001",
      domain: "cleaning",
      title: "Evening Kitchen Reset",
      tags: ["kitchen", "daily", "15-min"],
      origin: "system",          // seeded template
      isTemplate: true,
      isFavorite: false,
      favoriteOwnerId: null,
      status: "planned",
      steps: [
        { id: "s1", label: "Clear counters", durationMinutes: 5 },
        { id: "s2", label: "Load / start dishwasher", durationMinutes: 5 },
        { id: "s3", label: "Sweep floor", durationMinutes: 5 }
      ],
      context: {
        room: "kitchen",
        suggestedTimeOfDay: "evening",
        dependencies: ["dishes-imported-from-recipes"]
      }
    })
  }
}
Domain-specific notes:

Cleaning: context.room, context.zone, context.frequency (“daily”, “weekly”, etc.).

Garden: context.season, context.beds, context.crops, context.harvestWindow.

Storehouse: context.grocerySections (see below), context.storeLocation.

Meals: context.mealWindow, context.batchSize, context.integratedTimers.

Animals: context.species, context.stage (“acquisition”, “routine care”, “butchery”).

3.5 agent.session.userCreated
Household hand-built a session (not generated by system).
This is crucial for learning preferences & reverse generation seeds.

js
Copy code
// type: "agent.session.userCreated"
{
  type: "agent.session.userCreated",
  ts: "2025-11-18T17:05:00.000Z",
  source: "ui/meals/sessionBuilder",
  data: {
    domain: "meals",
    userId: "user-123",
    session: {
      id: "sess-user-batch-soups-2025-11-18",
      domain: "meals",
      title: "Sunday Batch Soup & Stew Day",
      tags: ["batch", "soup", "stew", "winter"],
      origin: "user",
      isTemplate: true,
      isFavorite: true,
      favoriteOwnerId: "user-123",
      status: "planned",
      steps: [
        { id: "s1", label: "Chop root veg", durationMinutes: 20 },
        { id: "s2", label: "Start beef bone broth", durationMinutes: 10 },
        { id: "s3", label: "Simmer pots", durationMinutes: 90 }
      ],
      context: {
        mealWindow: "Sunday afternoon",
        batchSizeMeals: 12,
        usesStorehouseItems: ["jarred beans", "frozen bones"]
      }
    }
  }
}
3.6 agent.session.favorite.saved
User saved a session (system or user origin) as a favorite.

js
Copy code
// type: "agent.session.favorite.saved"
{
  type: "agent.session.favorite.saved",
  ts: "2025-11-18T17:06:00.000Z",
  source: "ui/sessions/favoriteButton",
  data: {
    domain: "garden",
    userId: "user-123",
    sessionId: "sess-garden-spring-bed-prep-001",
    previousFavoriteState: false,
    newFavoriteState: true,
    origin: "system" // origin of session itself
  }
}
This supports “favorite sessions & schedules, not just system ones”.
Any session can be user-favorited regardless of origin.

3.7 agent.session.favorite.removed
js
Copy code
// type: "agent.session.favorite.removed"
{
  type: "agent.session.favorite.removed",
  ts: "2025-11-18T17:07:00.000Z",
  source: "ui/sessions/favoriteButton",
  data: {
    domain: "meals",
    userId: "user-123",
    sessionId: "sess-user-batch-soups-2025-11-18",
    previousFavoriteState: true,
    newFavoriteState: false,
    origin: "user"
  }
}
3.8 agent.schedule.generated
A schedule (one or multiple sessions over time) was generated by the agent.

js
Copy code
// type: "agent.schedule.generated"
{
  type: "agent.schedule.generated",
  ts: "2025-11-18T17:08:30.000Z",
  source: "agents/storehouse/storehouseShim",
  data: {
    domain: "storehouse",
    schedule: /** @type {AgentSchedule} */ ({
      id: "sched-storehouse-monthly-stockup-001",
      title: "Monthly Stock-Up (Grocery Sections)",
      domains: ["storehouse", "meals"],
      origin: "system",
      isFavorite: false,
      favoriteOwnerId: null,
      blocks: [
        {
          id: "b1",
          sessionId: "sess-storehouse-produce-section",
          fromTs: "2025-11-20T10:00:00.000Z",
          toTs: "2025-11-20T10:30:00.000Z",
          firmness: "soft"
        },
        {
          id: "b2",
          sessionId: "sess-storehouse-meat-freezer-section",
          fromTs: "2025-11-20T10:30:00.000Z",
          toTs: "2025-11-20T11:00:00.000Z",
          firmness: "soft"
        }
      ],
      meta: {
        sabbathGuardApplied: true,
        grocerySections: [
          "produce",
          "meat + freezer",
          "pantry + baking",
          "household + cleaning"
        ]
      }
    })
  }
}
grocerySections mirrors the mental model used on well-executed grocery apps:
Produce, Meat/Seafood, Dairy, Frozen, Pantry/Bulk, Household/Cleaning, Personal Care.

3.9 agent.schedule.userCreated
User builds their own custom schedule (e.g., Homestead Saturday: garden + animals + meals).

js
Copy code
// type: "agent.schedule.userCreated"
{
  type: "agent.schedule.userCreated",
  ts: "2025-11-18T17:10:00.000Z",
  source: "ui/scheduleBuilder",
  data: {
    userId: "user-123",
    schedule: {
      id: "sched-homestead-saturday-2025-11-22",
      title: "Homestead Saturday – Garden, Animals & Meals",
      domains: ["garden", "animals", "meals"],
      origin: "user",
      isFavorite: true,
      favoriteOwnerId: "user-123",
      blocks: [
        // Garden block
        {
          id: "b1",
          sessionId: "sess-garden-fall-bed-care-001",
          fromTs: "2025-11-22T09:00:00.000Z",
          toTs: "2025-11-22T10:30:00.000Z",
          firmness: "hard"
        },
        // Animals block
        {
          id: "b2",
          sessionId: "sess-animals-weekly-care-goats",
          fromTs: "2025-11-22T10:30:00.000Z",
          toTs: "2025-11-22T11:30:00.000Z",
          firmness: "soft"
        },
        // Meals block
        {
          id: "b3",
          sessionId: "sess-user-batch-soups-2025-11-18",
          fromTs: "2025-11-22T12:00:00.000Z",
          toTs: "2025-11-22T14:00:00.000Z",
          firmness: "soft"
        }
      ],
      meta: {
        sabbathGuardApplied: true,
        theme: "homestead-day",
        reverseGenerationEligible: true
      }
    }
  }
}
3.10 agent.schedule.favorite.saved / .removed
js
Copy code
// type: "agent.schedule.favorite.saved"
{
  type: "agent.schedule.favorite.saved",
  ts: "2025-11-18T17:12:00.000Z",
  source: "ui/schedules/favoriteButton",
  data: {
    userId: "user-123",
    scheduleId: "sched-homestead-saturday-2025-11-22",
    previousFavoriteState: false,
    newFavoriteState: true
  }
}
js
Copy code
// type: "agent.schedule.favorite.removed"
{
  type: "agent.schedule.favorite.removed",
  ts: "2025-11-18T17:13:00.000Z",
  source: "ui/schedules/favoriteButton",
  data: {
    userId: "user-123",
    scheduleId: "sched-homestead-saturday-2025-11-22",
    previousFavoriteState: true,
    newFavoriteState: false
  }
}
4. Reverse Generation Events
“Reverse generation” = look at what the household actually does
→ derive templates (sessions/schedules) and preferences.

4.1 agent.reverseGeneration.requested
Triggered by user or automation runtime.

js
Copy code
// type: "agent.reverseGeneration.requested"
{
  type: "agent.reverseGeneration.requested",
  ts: "2025-11-18T17:20:00.000Z",
  source: "automation/runtime",
  data: {
    domain: "animals",
    agentId: "animals-planner-v1",
    userId: "user-123",
    sourceWindow: {
      fromTs: "2025-09-01T00:00:00.000Z",
      toTs: "2025-11-18T23:59:59.999Z"
    },
    sources: /** @type {ReverseGenerationSource[]} */ ([
      {
        kind: "session.history",
        ids: [
          "sess-animals-weekly-care-goats",
          "sess-animals-weekly-care-chickens"
        ]
      },
      {
        kind: "calendar.history",
        ids: ["ev-goat-trim-2025-10", "ev-butchery-day-2025-10-15"]
      }
    ]),
    goal: "derive recurring weekly care + butchery prep templates"
  }
}
4.2 agent.reverseGeneration.completed
js
Copy code
// type: "agent.reverseGeneration.completed"
{
  type: "agent.reverseGeneration.completed",
  ts: "2025-11-18T17:22:30.000Z",
  source: "agents/animals/animalsShim",
  data: {
    domain: "animals",
    agentId: "animals-planner-v1",
    userId: "user-123",
    createdSessions: [
      {
        id: "sess-animals-weekly-goat-care-template",
        domain: "animals",
        title: "Weekly Goat Care",
        tags: ["weekly", "goats", "care"],
        origin: "reverse",
        isTemplate: true,
        isFavorite: true,
        favoriteOwnerId: "user-123",
        status: "planned",
        steps: [
          { id: "s1", label: "Check hooves", durationMinutes: 10 },
          { id: "s2", label: "Check udders / health", durationMinutes: 10 },
          { id: "s3", label: "Refresh minerals & water", durationMinutes: 10 }
        ],
        context: {
          species: "goats",
          stage: "routine care",
          preferredDayOfWeek: "Sunday"
        }
      },
      {
        id: "sess-animals-butchery-day-template",
        domain: "animals",
        title: "Butchery Day – Sheep",
        tags: ["butchery", "sheep"],
        origin: "reverse",
        isTemplate: true,
        isFavorite: false,
        favoriteOwnerId: null,
        status: "planned",
        steps: [
          { id: "s1", label: "Pre-fast animals", durationMinutes: 5 },
          { id: "s2", label: "Prep equipment & station", durationMinutes: 30 },
          { id: "s3", label: "Slaughter & initial breakdown", durationMinutes: 60 },
          { id: "s4", label: "Label + hang or chill", durationMinutes: 45 }
        ],
        context: {
          species: "sheep",
          stage: "butchery",
          linksTo: {
            preservationSessionId: "sess-pork-sausage-making" // example link
          }
        }
      }
    ],
    createdSchedules: [],
    inferredPreferences: {
      preferredButcheryDay: "Wednesday",
      preferredCareWindow: "late-morning"
    }
  }
}
4.3 agent.reverseGeneration.failed
js
Copy code
// type: "agent.reverseGeneration.failed"
{
  type: "agent.reverseGeneration.failed",
  ts: "2025-11-18T17:22:30.000Z",
  source: "agents/garden/gardenShim",
  data: {
    domain: "garden",
    agentId: "garden-planner-v1",
    userId: "user-123",
    errorCode: "INSUFFICIENT_HISTORY",
    message: "Not enough repeated patterns to derive a template.",
    sources: [
      { kind: "session.history", ids: [] }
    ]
  }
}
5. Domain Context Update Events
These events let agents publish learned intelligence that other domains can use.

5.1 Cleaning
js
Copy code
// type: "agent.context.updated.cleaning"
{
  type: "agent.context.updated.cleaning",
  ts: "2025-11-18T17:25:00.000Z",
  source: "agents/cleaning/cleaningShim",
  data: {
    domain: "cleaning",
    userId: "user-123",
    preferredWindows: [
      { room: "kitchen", timeOfDay: "evening", frequency: "daily" },
      { room: "bathroom", timeOfDay: "morning", frequency: "weekly" }
    ],
    avoidedWindows: [
      { timeOfDay: "sabbath", reason: "sabbathGuard" }
    ]
  }
}
5.2 Garden Planning, Care & Harvest
js
Copy code
// type: "agent.context.updated.garden"
{
  type: "agent.context.updated.garden",
  ts: "2025-11-18T17:26:00.000Z",
  source: "agents/garden/gardenShim",
  data: {
    domain: "garden",
    userId: "user-123",
    beds: [
      { id: "bed-1", label: "North Bed", crops: ["kale", "collards"] },
      { id: "bed-2", label: "South Bed", crops: ["tomatoes", "peppers"] }
    ],
    harvestWindows: [
      { crop: "kale", fromTs: "2025-11-01T00:00:00.000Z", toTs: "2025-11-30T23:59:59.999Z" }
    ],
    season: "fall",
    links: {
      inventoryHarvestLogId: "harvest-log-2025-fall"
    }
  }
}
5.3 Storehouse Stock Planning (Grocery Sections)
js
Copy code
// type: "agent.context.updated.storehouse"
{
  type: "agent.context.updated.storehouse",
  ts: "2025-11-18T17:27:00.000Z",
  source: "agents/storehouse/storehouseShim",
  data: {
    domain: "storehouse",
    userId: "user-123",
    grocerySections: [
      "produce",
      "meat + freezer",
      "dairy",
      "pantry + baking",
      "frozen",
      "household + cleaning",
      "personal care"
    ],
    shortagesBySection: {
      "produce": ["onions", "garlic"],
      "pantry + baking": ["flour", "baking powder"]
    },
    links: {
      inventorySnapshotId: "inv-2025-11-18",
      mealPlanIds: ["mealplan-2025-11-week4"]
    }
  }
}
5.4 Meal Planning
js
Copy code
// type: "agent.context.updated.meals"
{
  type: "agent.context.updated.meals",
  ts: "2025-11-18T17:28:00.000Z",
  source: "agents/meals/mealShim",
  data: {
    domain: "meals",
    userId: "user-123",
    preferredMealWindows: [
      { name: "batchCooking", dayOfWeek: "Sunday", timeOfDay: "afternoon" },
      { name: "quickDinners", daysOfWeek: ["Mon","Tue","Thu"], timeOfDay: "evening" }
    ],
    patterns: {
      avoid: ["late-night heavy meals"],
      repeats: ["soup & stew in winter"]
    },
    links: {
      recipeVaultId: "rvault-123",
      batchQueueId: "batchqueue-456"
    }
  }
}
5.5 Animals: Acquisition, Care & Butchery
js
Copy code
// type: "agent.context.updated.animals"
{
  type: "agent.context.updated.animals",
  ts: "2025-11-18T17:29:00.000Z",
  source: "agents/animals/animalsShim",
  data: {
    domain: "animals",
    userId: "user-123",
    herds: [
      { id: "herd-goats", species: "goats", count: 8 },
      { id: "flock-chickens", species: "chickens", count: 20 }
    ],
    acquisitionPatterns: [
      { species: "sheep", preferredSeason: "fall", source: "local farmer" }
    ],
    butcheryPatterns: [
      { species: "sheep", preferredDayOfWeek: "Wednesday" }
    ],
    careRhythm: [
      { species: "goats", frequency: "weekly", window: "Sunday late-morning" }
    ]
  }
}
6. Integration Notes
These agent.* events:

feed the automation runtime (scheduling & suggestions)

inform UI (favorites, recommendations, “play now” tiles)

drive reverse generation (patterns → templates)

can be exported to Hub when familyFundMode === true via HubPacketFormatter and FamilyFundConnector.

Domain pages (cleaning, garden, storehouse, meals, animals) should:

show Now / Play buttons tied to SessionRunner

expose “Save as Favorite Session” and “Save as Favorite Schedule” actions

these must emit the appropriate agent.session.favorite.* / agent.schedule.favorite.* events.

Reverse generation can be triggered:

explicitly from UI (“Build a template from my last 60 days”)

implicitly from automation runtime when enough history exists.
```

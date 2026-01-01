# events/automation-matrix.md
> **Purpose:** One-page, living reference for **who emits/consumes what**, with **payload shapes** and **copy-paste examples**.  
> Optimized for our household system flows (planning → grocery → prep), importer, conflicts, and NBA prompts.

---

## Conventions

- **Event names** are `kebab.case.scope.verb` when possible.  
- Every payload **MUST** include:
  - `meta.correlationId` _(uuid for the request chain)_
  - `meta.emitter` _(module or handler name)_
  - `meta.ts` _(ISO timestamp)_
  - Optional `meta.generator` _(version label for the code path)_
- Use **ISO 8601** UTC timestamps; UI converts to profile TZ.
- **Idempotency**: handlers SHOULD no-op if `meta.correlationId` previously handled.
- **Error symmetry**: for any `*.generated`, there is a sibling `*.failed`.

```ts
// Shared envelope snippet (union across events)
type BaseMeta = {
  correlationId: string;   // same across a fan-out chain
  emitter: string;         // e.g., 'onGroceryListRequested.v1'
  ts: string;              // new Date().toISOString()
  generator?: string;      // internal version tag
};
At-a-glance matrix
Event	Emitted by	Consumed by	Notes
mealplan.draft.requested	Planner UI, Orchestrators	onMealplanDraftRequested	Triggers draft generation for a date range.
mealplan.draft.generated	onMealplanDraftRequested	Orchestrator → grocery.list.requested; Planner UI	Carries template, assignments, conflicts, NBA.
mealplan.draft.failed	onMealplanDraftRequested	Observability / Toasts	Includes serialized error, minimal draft.
grocery.list.requested	Planner Orchestrator, Grocery UI	onGroceryListRequested	Builds LIST from plan or recipeIds.
grocery.list.generated	onGroceryListRequested	Grocery UI, Checkout/export	Lines w/ HAVE/SHORT, aisles, subs, estimate.
grocery.list.failed	onGroceryListRequested	Observability / Toasts	Error details; empty safe payload.
prep.tasks.requested	Prep UI, Planner, Automations	onPrepTasksRequested	Builds Batch Session + tasks (timers, deps).
prep.tasks.generated	onPrepTasksRequested	Batch Runner UI	Includes session + tasks.
batch.session.created	onPrepTasksRequested	Batch Runner, Notifications	Fire-and-forget “new session” hook.
prep.tasks.failed	onPrepTasksRequested	Observability / Toasts	Error details; minimal session.
planner.conflict.detected	Conflict scanner / planner	Conflict UI, Resolver	Optional broadcast prior to resolution.
planner.conflict.resolved.shifted	Resolver	Planner UI	Assignment moved to free window.
planner.conflict.resolved.swapped	Resolver (w/ Decider)	Planner UI	Alternate recipe swapped in.
planner.conflict.unresolved	Resolver	Planner UI	Requires user action.
collector.preview.ready	Importer	Import UI (Preview grid)	Previews for URL import step.
library.item.saved	Importer / Library Save	Library UI, Tagging flows	After final save+link to collection.
nba.suggest	Any handler	UI NBA rail	List of Next Best Actions (scope-scoped).

Payload shapes (TypeScript)
These are minimal “contract” interfaces. Real payloads can include more fields; do not remove fields listed here without major-versioning.

ts
Copy code
// 1) Mealplan Draft
type MealplanDraftRequested = {
  startDate?: string | Date;
  endDate?: string | Date;
  timezone?: string;
  collections?: string[];
  pinnedIds?: string[];
  excludeIds?: string[];
  constraints?: {
    dietary?: string[];        
    maxPrepMinutes?: number;
    budget?: number;
  };
  rhythm?: Record<'sun'|'mon'|'tue'|'wed'|'thu'|'fri'|'sat', string[]>;
  honorInventory?: boolean;
  honorGarden?: boolean;
  honorSabbathGuard?: boolean;
  options?: {
    includeHave?: boolean;
    allowSubstitutions?: boolean;
    collapseDuplicates?: boolean;
    aisleGroups?: boolean;
    storeId?: string;
  };
  meta: BaseMeta;
};

type MealplanDraftGenerated = {
  draft: {
    id: string;
    kind: 'mealplan.draft';
    createdAt: string;
    range: { start: string; end: string; tz: string };
    assignments: Array<{
      slotId: string;
      slotTime: string;
      recipe: any;
    }>;
    conflicts: any[];
    grocery: { items: any[]; summary: any; meta: any };
  };
  meta: BaseMeta;
};
End-to-end sequences
A) Plan → Grocery (weekly)
mermaid
Copy code
sequenceDiagram
  participant UI as Planner UI
  participant BUS as Event Bus
  participant MP as onMealplanDraftRequested
  participant GR as onGroceryListRequested

  UI->>BUS: mealplan.draft.requested
  BUS->>MP: onMealplanDraftRequested(payload)
  MP-->>BUS: mealplan.draft.generated { draft }
  MP-->>BUS: nba.suggest { scope:'mealplan', actions:[...] }
  BUS->>GR: grocery.list.requested (derived from draft.range)
  GR-->>BUS: grocery.list.generated { list, summary }
  GR-->>BUS: nba.suggest { scope:'grocery', actions:[...] }
B) Conflicts (oven/time) → Resolve (shift/swap)
mermaid
Copy code
sequenceDiagram
  participant PL as Planner
  participant RS as Resolver (Decider+ScheduleHelpers)
  participant BUS as Event Bus

  PL-->>BUS: planner.conflict.detected { kind:'appliance', assignments:[...] }
  RS->>BUS: planner.conflict.resolved.shifted OR .swapped
  RS-->>BUS: nba.suggest { scope:'planner', actions:[review-adjustments|swap-alternative] }
Payload examples (copy-paste)
mealplan.draft.requested
json
Copy code
{
  "startDate": "2025-10-20",
  "endDate": "2025-10-26",
  "timezone": "America/New_York",
  "constraints": { "dietary": ["without:dairy"], "maxPrepMinutes": 60 },
  "options": { "storeId": "store:default", "aisleGroups": true, "includeHave": false },
  "meta": {
    "correlationId": "02dc8f17-0a2c-4a5f-8b15-08b3e9c5a6ab",
    "emitter": "planner.orchestrator",
    "ts": "2025-10-20T13:00:00.000Z"
  }
}
grocery.list.generated
json
Copy code
{
  "list": [
    { "name": "coconut milk", "needBaseQty": 13.5, "status": "short", "aisle": "International" }
  ],
  "summary": { "lines": 1, "shortLines": 1, "byAisle": { "International": 1 } },
  "meta": {
    "range": { "start": "2025-10-20T00:00:00.000Z", "end": "2025-10-26T23:59:59.999Z", "tz": "America/New_York" },
    "storeId": "store:default",
    "generator": "onGroceryListRequested.v1"
  }
}
prep.tasks.generated
json
Copy code
{
  "session": {
    "id": "batch-8d36f2b1",
    "label": "Prep • Mon, Oct 20",
    "kind": "prep",
    "tz": "America/New_York",
    "startsAt": "2025-10-20T18:00:00.000Z",
    "endsAt": "2025-10-20T20:00:00.000Z",
    "stats": { "tasks": 6, "totalMinutes": 95 }
  },
  "tasks": [
    { "id": "task-1", "title": "Chop onions", "kind": "cooking", "estMinutes": 8 }
  ]
}
Wiring guidance
Orchestrator → listens for mealplan.draft.generated, emits grocery.list.requested.

Planner UI → listens for mealplan.draft.generated, planner.conflict.*, nba.suggest.

Grocery UI → listens for grocery.list.generated, emits grocery.list.requested.

Prep / Batch Runner → listens for prep.tasks.generated, emits progress telemetry.

Importer → emits collector.preview.ready, library.item.saved, and nba.suggest.
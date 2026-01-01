# Animal Feed Calculator

> `src/features/calculators/gardenAnimal/AnimalFeedCalculator/`

Planner-style calculator for daily rations, feed usage projections, and feed-related next steps (storehouse procurement, budgeting, and meat yield planning).  
Domain focus: **animals** + **storehouse** in the SSA Planning Graph.

---

## 1. Purpose & Role in SSA

The **Animal Feed Calculator** turns your animal registry + current feed inventory into:

1. **Daily rations** per animal/group (as-fed + dry matter).
2. **Feed demand projection** over a planning horizon (e.g., 7–30 days).
3. **Cost & shortage analytics** to help avoid feed shocks.
4. **Next steps** into:
   - Storehouse **feed procurement**.
   - **Feed budget** review.
   - **Meat yield / harvest** planning (when feed pressure is high).
   - Animals **daily care** planning (when feed is stable).
5. A **“Feed Session Now”** pathway that sends a session to the global **SessionRunner**.

This keeps animals, storehouse, and meat planning all connected inside your Suka Smart Assistant.

---

## 2. File Map

All files live under:

`src/features/calculators/gardenAnimal/AnimalFeedCalculator/`

- **`AnimalFeedCalculator.config.json`**  
  Planning Graph **node config** for this calculator.  
  - Declares `nodeKey`, `kind: "calculator-node"`, domain, and metadata.
  - Describes available inputs/outputs for discovery and orchestration.

- **`AnimalFeedCalculator.schema.json`**  
  **JSON schema** for validator + tooling.  
  - Describes animals, feed inventory, planning context, rations, analytics, and projections.
  - Used by the shim and view to keep contracts stable.

- **`AnimalFeedCalculator.shim.js`**  
  The **calculator logic**.  
  - Accepts a `ShimRequest` (animals, feedInventory, context).
  - Produces a `ShimResponse` with:
    - `result.dailyFeedPlan`
    - `result.feedDemandProjection`
    - `result.analytics`
    - `result.shortageItems` (when wiring from the planning links hook)
  - Emits events via `eventBus` and optionally formats export payloads for the Hub.

- **`AnimalFeedCalculator.hooks.js`**  
  **React hooks** that connect this calculator to:
  - **SessionRunner**: “Feed Session Now” launcher from a feed plan result.
  - **Storehouse & Meat Yield Planning**: next-step link data for the Planning Graph.

  Key exports:
  - `buildFeedSessionFromResult(result)`  
    → Creates a `Session` object (domain: `"animals"`) from the feed plan.
  - `useAnimalFeedSessionLaunchers({ feedPlanResult })`  
    → Hook to trigger a “Feed Session Now” session, persist it, and emit `session.requested`.
  - `useAnimalFeedPlanningLinks(feedPlanResult)`  
    → Hook that surfaces:
    ```js
    {
      hasShortages,
      shortageItems,
      storehouseRefillPlan,
      meatYieldCandidates,
      summary
    }
    ```
    for use by planners / next-step UIs.

- **`AnimalFeedCalculator.view.jsx`**  
  **UI component** for the calculator itself:
  - Planning context inputs (horizon days, units, location, notes, export toggle).
  - “Run Feed Plan” button → calls the shim.
  - “Feed Session Now” button → uses `useAnimalFeedSessionLaunchers`.
  - Summary KPIs and shortage table.
  - Modal with **per-animal/group daily rations**.

- **`AnimalFeedCalculator.mappings.json`**  
  **Next Steps mapping** for the Planning Graph:
  - Top-level keys: `id`, `calculator`, `domains`, `inputs`, `rules`.
  - Rules wire calculator outputs into next-step nodes:
    - `storehouse.feedProcurement`
    - `storehouse.feedBudget`
    - `storehouseMeals.meatBreakdown`
    - `animals.dailyCarePlanner`

- **`README.md`** (this file)  
  Context + dev notes.

---

## 3. Data Contracts (High-Level)

### 3.1 Shim Request

The shim expects a request shaped roughly like:

```js
{
  nodeKey: "animals.feedCalculator",
  animals: [ /* animal registry entries */ ],
  feedInventory: [ /* feed item inventory entries */ ],
  context: {
    planningHorizonDays: number,
    unitSystem: "metric" | "imperial",
    farmLocation?: string,
    notes?: string,
    calculatedAt?: string // ISO
  },
  exportToHub?: boolean
}
3.2 Shim Result (Simplified View)
js
Copy code
{
  context: { /* echoed + enriched context */ },
  animals: [ /* normalized animals used in the run */ ],
  dailyFeedPlan: [
    {
      rationId: string,
      subjectId: string,
      feedItems: [
        {
          feedItemId: string,
          name: string,
          category?: string,
          asFedKgPerHeadPerDay?: number,
          dryMatterKgPerHeadPerDay?: number,
          notes?: string
        }
      ],
      totals: {
        asFedKgPerHeadPerDay?: number,
        dryMatterKgPerHeadPerDay?: number
      },
      instructions?: string
    }
  ],
  feedDemandProjection: [
    {
      feedItemId: string,
      name: string,
      currentInventoryKg?: number,
      projectedUsageKg?: number,
      projectedShortageKg?: number,
      estimatedRunoutDate?: string
    }
  ],
  analytics: {
    totalAsFedKgPerDay?: number,
    totalDryMatterKgPerDay?: number,
    estimatedFeedCostPerDay?: number,
    projectedShortageDays?: number | null
  }
}
The hooks add some derived fields (like shortageItems, meatYieldCandidates) for mapping and planning.

4. How SessionRunner Integration Works
4.1 Building a Feed Session
From the view, after a successful run, result is passed to:

js
Copy code
import { useAnimalFeedSessionLaunchers } from "./AnimalFeedCalculator.hooks";

const { launchFeedSessionNow } = useAnimalFeedSessionLaunchers({
  feedPlanResult: result
});

// e.g. onClick:
launchFeedSessionNow();
Internally:

buildFeedSessionFromResult(result) creates a Session:

domain: "animals"

title: "Feed Animals – Today’s Round"

source: { type: "animalTask", refId: null }

steps: one step per animal/group with:

Location

Per-head ration details

Default durationSec (5 min) and blockers (["inventory","quietHours","sabbath"])

persistSession(session) writes to the Dexie-backed sessions store (if available).

requestSessionStart(session) emits:

js
Copy code
emit({
  type: "session.requested",
  ts: new Date().toISOString(),
  source: "features/calculators/AnimalFeedCalculator.hooks",
  data: { session }
});
The global SessionRunner listens for session.requested and:

Mounts the SessionRunner modal at app root.

Keeps timers alive via Web Worker.

Manages wake-lock, notifications, PiP, etc.

Emits session.started, session.step.changed, session.completed, etc.

This hooks file never directly manipulates the SessionRunner UI; it just feeds it a contract-compliant Session.

5. Planning Graph & Next Steps
The AnimalFeedCalculator.mappings.json file connects this calculator’s outputs into multi-domain flows via the Planning Graph.

5.1 Inputs (from result + hooks)
At the top level:

json
Copy code
"inputs": {
  "analytics": { "from": "analytics" },
  "feedDemandProjection": { "from": "feedDemandProjection" },
  "dailyFeedPlan": { "from": "dailyFeedPlan" },
  "context": { "from": "context" },
  "shortageItems": { "from": "shortageItems" },
  "meatYieldCandidates": { "from": "meatYieldCandidates" }
}
These correspond to:

analytics → cost & shortage stats.

feedDemandProjection → per-feed item usage & runout.

dailyFeedPlan → per-animal/groupration.

shortageItems → filtered list of feed items that will run short.

meatYieldCandidates → animals that might be processed to relieve feed pressure.

5.2 Rules (Examples)
Feed shortage → Feed Procurement Planner

when.kind: "fieldThreshold" on analytics.projectedShortageDays.

nextStep.nodeKey: "storehouse.feedProcurement".

Feed cost jump → Feed Budget Planner

when.kind: "deltaPercent" on analytics.estimatedFeedCostPerDay.

nextStep.nodeKey: "storehouse.feedBudget".

Shortage + Meat Animals → Meat Yield Planner

when.kind: "fieldExists" on shortageItems.

nextStep.nodeKey: "storehouseMeals.meatBreakdown".

No shortages → Animals Daily Care

when.kind: "fallback" to catch the “all good” case.

nextStep.nodeKey: "animals.dailyCarePlanner".

These rules allow other parts of SSA to auto-suggest the next best action after a feed plan run.

6. Typical UI Flow
User opens Animals → Feed Calculator.

User sets:

Planning horizon (e.g., 14 days).

Units (kg / lb).

Farm location.

Notes (e.g., drought, late gestation).

User clicks “Run Feed Plan”:

The shim runs and returns a ShimResponse.

The view shows:

Summary KPIs (total feed/day, DM/day, cost/day, earliest shortage).

Table of projected usage & shortages.

User optionally opens the Detailed Rations modal:

Per-animal/group rations.

From the panel or modal, user taps “Feed Session Now”:

Hook builds a Session, persists, and emits session.requested.

SessionRunner says: “Let’s feed animals now” with:

Full-screen timer

Step-by-step guidance

Step toasts and optional voice.

After completion, other planners can look at:

storehouseRefillPlan, meatYieldCandidates, etc.,

Or rely on the Planning Graph engine using AnimalFeedCalculator.mappings.json.

7. Extensibility Notes
Adding more nutrition detail
Extend AnimalFeedCalculator.schema.json to include:

Protein, energy, mineral targets per class / species.

Per-ration nutrient coverage.

More granular steps for SessionRunner
Instead of one step per animal group, you can:

Break steps by location / barn.

Insert “mix feed” steps with equipment metadata and durationSec.

More Next Steps
Add new rules in .mappings.json:

E.g. link to Water System Checks if feed cost spikes and water quality is suspect.

Link to Pasture Rotation Planner if pasture-based animals show high concentrate usage.

Hub Exports
The shim can use HubPacketFormatter + FamilyFundConnector for:

Daily feed cost snapshots.

Cross-farm analytics in Family Fund Hub when familyFundMode is enabled.

8. Developer Checklist
When updating or integrating the Animal Feed Calculator:

 Keep AnimalFeedCalculator.schema.json in sync with shim + view.

 Make sure the shim returns all fields referenced in the hooks and mappings.

 Confirm nodeKey in AnimalFeedCalculator.config.json matches:

calculator in AnimalFeedCalculator.mappings.json.

Any usage in the shim request.

 Ensure useAnimalFeedSessionLaunchers is wired wherever “Feed Session Now” appears.

 Verify SessionRunner listens for session.requested and uses the standard Session contract.

 After changes, run a test feed plan and:

Check for VS Code schema errors in config/schema/mappings.

Confirm SessionRunner launches and resumes correctly.

This keeps your animal feed, storehouse, and meat planning flows coherent and ready for daily use inside SSA.
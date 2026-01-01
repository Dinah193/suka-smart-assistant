# FermentationDurationCalculator

**Path:**  
`src/features/calculators/storehouseMeals/FermentationDurationCalculator/`

This calculator determines ideal fermentation durations, phases, and check-in schedules for a variety of ferments (kraut, kimchi, brined veg, sourdough, wine, beer, etc.), and then connects those timelines to:

- **SessionRunner** (guided “do it now” sessions),
- **Storehouse / inventory** (when a batch is actually usable),
- **Meal planning & feast days** (when to feature ferments as dishes).

It is wired into the **Planning Graph** as a calculator node so other planners (batch cooking, storehouse stock, animal planner, etc.) can call it.

---

## Files in this feature

- `FermentationDurationCalculator.schema.json`  
  JSON Schema describing **inputs** and **outputs** for the calculator shim.

- `FermentationDurationCalculator.shim.js`  
  Pure logic module that **calculates durations, phases, and ready windows** from the schema inputs.

- `FermentationDurationCalculator.view.jsx`  
  React UI for configuring, running, and reviewing fermentation projects; integrates with the shim.

- `FermentationDurationCalculator.hooks.js`  
  React hooks that connect the calculator results to:
  - **Feast day alignment** (holy days / appointed times),
  - **Storehouse inventory** (ready windows & availability).

- `FermentationDurationCalculator.config.json`  
  Planning Graph **node config** (calculator-node) that describes how this calculator fits into the global planning graph.

- `FermentationDurationCalculator.mappings.json`  
  Mapping of calculator **outputs → events & next steps** (sessions, feast alignment, storehouse sync).

---

## 1. Schema: Inputs & Outputs

**File:** `FermentationDurationCalculator.schema.json`

### 1.1 Inputs (`inputs`)

The calculator expects an object with two main sections:

```json
{
  "inputs": {
    "product": {
      "type": "kraut",
      "batchSize": 5,
      "unit": "jar",
      "label": "Autumn Kraut",
      "householdId": "HH_001",
      "projectId": "P_FALL_2025"
    },
    "fermentation": {
      "method": "brined",              // brined|dry_salted|starter_based
      "temperatureRange": {
        "minC": 18,
        "maxC": 22
      },
      "targetStyle": "crisp_tangy",    // soft_sour|crisp_tangy|very_sour|dry_wine|sweet_wine|light_beer|strong_beer
      "saltPct": 2.5,
      "starterType": "wild",           // wild|sourdough|wine_yeast|beer_yeast|other
      "targetAcidity": 3.5,
      "desiredShelfLifeDays": 180
    }
  }
}
Required high-level fields (per schema):

inputs.product.type

inputs.product.batchSize

inputs.product.unit

inputs.fermentation.method

inputs.fermentation.temperatureRange

inputs.fermentation.targetStyle

Optional:

inputs.product.householdId

inputs.product.projectId

inputs.fermentation.saltPct

inputs.fermentation.starterType

inputs.fermentation.targetAcidity

inputs.fermentation.desiredShelfLifeDays

1.2 Outputs (outputs)
The shim produces:

outputs.schedule — array of fermentation phases, e.g.:

json
Copy code
[
  {
    "phaseId": "active_ferment",
    "label": "Active Fermentation",
    "durationDays": 5,
    "startAt": "2025-09-01T00:00:00.000Z",
    "endAt": "2025-09-06T00:00:00.000Z",
    "checkpoints": [
      {
        "id": "day2_burp_jars",
        "label": "Burp jars / check activity",
        "offsetDays": 2
      }
    ]
  }
]
outputs.targetReadyWindow — when the ferment is at peak flavor:

json
Copy code
{
  "start": "2025-09-07T00:00:00.000Z",
  "end": "2025-10-01T00:00:00.000Z"
}
outputs.storageShift — planned move into cold storage/root cellar:

json
Copy code
{
  "moveAt": "2025-09-06T00:00:00.000Z",
  "targetStorage": "Root Cellar"
}
outputs.sessionSuggestions — SessionRunner hint objects (check, burp, move):

json
Copy code
[
  {
    "id": "ferment_start_session",
    "kind": "start_batch",
    "label": "Start Fermentation Batch",
    "phaseId": "active_ferment",
    "scheduledAt": "2025-09-01T00:00:00.000Z"
  }
]
outputs.inventoryHints — hints for storehouse integration:

json
Copy code
[
  {
    "id": "ferment_batch_use_window",
    "kind": "ready_window",
    "start": "2025-09-07T00:00:00.000Z",
    "end": "2025-10-01T00:00:00.000Z",
    "notes": "Best texture and tang during this period."
  }
]
2. Shim Logic
File: FermentationDurationCalculator.shim.js

Responsibilities
Validate inputs against the schema shape (light defensive checks).

Compute:

phase durations (active ferment, conditioning, cold storage),

ready window (start/end),

storage shift date,

session suggestions (for SessionRunner),

inventory hints.

Emit a calculator event through eventBus:

calculator.fermentationDuration.completed on success,

calculator.fermentationDuration.error on failure.

Usage (from other code)
js
Copy code
import {
  runFermentationDurationCalculator
} from "./FermentationDurationCalculator.shim";

const result = runFermentationDurationCalculator({
  inputs: { product, fermentation },
  meta: {
    householdId: "HH_001",
    sourceNode: "PG_NODE_PRESERVATION_SUITE"
  }
});

// result.data.inputs / result.data.outputs
// result.ok, result.error
The shim does not manage UI or sessions; it only returns structured data and emits events.

3. React View
File: FermentationDurationCalculator.view.jsx

Responsibilities
Provide a friendly UI for:

Choosing product type (kraut, kimchi, wine, beer, etc.),

Batch size & units,

Method (brined, dry, starter based),

Temperature range & target style.

Call runFermentationDurationCalculator and show a:

Summary of the phase schedule,

Ready window,

Storage shift,

Session suggestions (e.g. “Start batch today”, “Burp jars on Day 2”).

Offer “Next steps” buttons:

“Sync to Storehouse” → triggers storehouse events.

“Align with Feast Days” → asks feast calendar to align ready window.

“Start Guidance Session” → emits a session request for SessionRunner.

The view uses the hooks exposed in FermentationDurationCalculator.hooks.js to connect to feasts and storehouse.

4. Hooks: Feasts & Storehouse
File: FermentationDurationCalculator.hooks.js

4.1 useFermentationFeastAlignment
Purpose:

Take calculator result + an array of feast days.

Compute which feasts overlap or sit near the ferment’s ready window.

Emit calendar.ferment.feastAlignment.computed when alignment changes.

Signature:

js
Copy code
const { alignedFeasts, bestMatch } = useFermentationFeastAlignment({
  calculatorResult,
  feastDays,
  toleranceDays: 7,
  autoEmit: true
});
4.2 useFermentationStorehouseSync
Purpose:

Normalize:

ready window,

inventory hints,

product info,

Emit storehouse.inventory.ferment.readyWindow.updated to let the storehouse module update inventory.

Signature:

js
Copy code
const {
  syncStatus,
  lastError,
  syncToStorehouse,
  normalizedPayload
} = useFermentationStorehouseSync({
  calculatorResult,
  autoSync: false
});
4.3 Combined bridge
useFermentationFeastAndStorehouseBridge wraps both behaviors for convenience.

5. Planning Graph Integration
5.1 Node Config
File: FermentationDurationCalculator.config.json
(Registered as a "calculator-node" in nodes.schema.json.)

Key properties:

nodeKey: "PG_NODE_FERMENTATION_DURATION_CALCULATOR"

type: "calculator-node"

calculatorId: "FermentationDurationCalculator"

domain: "preservation"

It declares:

Inputs: where payloads can come from (batch planner, storehouse stock planner, meat breakdown, etc.).

Outputs: schedule, ready window, storage shift, session suggestions, inventory hints.

Events consumed:

calculator.fermentationDuration.requested

calendar.event.fermentation.created

inventory.ferment.batch.created

session.completed

session.aborted

Events emitted:

calculator.fermentationDuration.completed

calculator.fermentationDuration.error

calendar.fermentation.schedule.upserted

storehouse.inventory.ferment.readyWindow.updated

session.request.fromFermentationDuration

session.request.fromFermentationDuration.batch

planningGraph.node.FERMENTATION_DURATION_CALCULATOR.completed

It also defines:

feedsInto: Preservation Suite, Storehouse Stock Planner, Meal Yield Planner, Batch Cooking Planner, Animal Planner.

ui.nowButton: a “Use Fermentation Duration” CTA that can open SessionRunner with appropriate session request event.

5.2 Mappings
File: FermentationDurationCalculator.mappings.json

Maps calculator outputs to:

Session events:

session.request.fromFermentationDuration

session.request.fromFermentationDuration.batch

Feast alignment:

calendar.ferment.feastAlignment.requested

calendar.ferment.feastHighlight.upserted

Storehouse & meal planner:

storehouse.inventory.ferment.readyWindow.updated

planner.meals.fermentWindow.updated

Also includes nextSteps entries used by planners to suggest:

“Align ferment with upcoming feast”

“Start fermentation guidance session”

“Schedule burp/check sessions”

“Sync ferment to storehouse”

“Plan root cellar or cold storage shift”

6. SessionRunner & “Now” CTA
While this feature doesn’t implement SessionRunner itself, it is designed to feed into it:

The node config exposes a nowButton that:

Surfaces on relevant preservation / storehouse domain pages.

Emits session.request.fromFermentationDuration with hints from outputs.sessionSuggestions.

Other orchestration layers listen for those session.request.* events and build full Session objects that conform to the shared contract:

js
Copy code
{
  id,
  domain: "preservation",
  title: "Check / Burp Ferments",
  source: { type: "manual", refId: null },
  steps: [ /* ... */ ],
  prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
  status: "pending",
  progress: { currentStepIndex: 0, elapsedSec: 0, startedAt: null, pausedAt: null },
  analytics: { skippedSteps: [], adjustments: [] },
  createdAt,
  updatedAt
}
SessionRunner then:

Keeps timers alive (Dexie + worker),

Emits session.started, session.step.changed, session.completed, etc.

Optionally exports to Hub if familyFundMode is enabled.

7. Example End-to-End Flow
User opens Preservation → Fermentation Duration UI and enters:

Lemons, brined, 2.5% salt, 5 jars, target style “soft_sour”.

FermentationDurationCalculator.view.jsx calls the shim:

Receives schedule, ready window, storage shift, session suggestions, inventory hints.

Hooks run:

useFermentationFeastAlignment checks which feast(s) fall in the ready window.

useFermentationStorehouseSync prepares storehouse payload.

User clicks:

“Sync to Storehouse” → emits storehouse.inventory.ferment.readyWindow.updated.

“Align with Feast Days” → emits calendar.ferment.feastAlignment.requested.

“Start Guidance Session” → emits session.request.fromFermentationDuration.

Session orchestration builds a Session object and opens the SessionRunner modal, keeping the ferment session alive across navigation with timers, notifications, and optional voice guidance.

8. Implementation Notes / Extension Points
New ferment types:
Add new targetStyle or method handling inside the shim, and optionally presets in the view.

Custom feast calendars:
Adjust consumers of calendar.ferment.feastAlignment.requested and extend the hooks to support different calendar sources or rule sets.

Additional storage locations:
Extend storageShift.targetStorage options and update storehouse mapping rules if you add more detailed locations (e.g., “Garage fridge”, “Pantry shelf 3”).

Hub export:
When familyFundMode === true, upstream orchestration can wrap this calculator result in a Hub export envelope and emit a session.exported or planner-level export event.

9. Quick Integration Checklist
✅ Ensure nodes.schema.json and mappings.schema.json exist under src/schemas/planningGraph.

✅ Register FermentationDurationCalculator.config.json in your Planning Graph loader.

✅ Register FermentationDurationCalculator.mappings.json in the mappings loader.

✅ Add a route for FermentationDurationCalculator.view.jsx:

/tier2/household/preservation/fermentation-duration

✅ Make sure your SessionRunner listener handles:

session.request.fromFermentationDuration

session.request.fromFermentationDuration.batch

✅ Verify your storehouse and calendar modules listen for:

storehouse.inventory.ferment.readyWindow.updated

calendar.ferment.feastAlignment.requested

calendar.ferment.feastHighlight.upserted

Once those are wired, the Fermentation Duration Calculator becomes a first-class citizen of your SSA planning graph, tightly coupled to feasts, storehouse, and SessionRunner.
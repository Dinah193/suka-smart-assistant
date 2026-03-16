# GardenPlantingCalendarCalculator

Planner-friendly planting calendar for **SSA’s garden domain**.

This calculator takes your **climate**, **calendar**, and **crop** info (including Hebrew calendar + feast-day alignment from upstream), then computes:

- Planting windows
- Harvest windows
- Calendar events (plant / harvest / tasks)
- Session-ready hooks for the **SessionRunner** and the wider **Planning Graph**:
  - Garden layout & bed assignments
  - Irrigation planning
  - Soil health / rotation
  - Yield forecasting
  - Preservation queue planning

It is designed to be a **“thinking front-end”** for garden planning, not a full calendar engine. Hebrew calendar logic and feast-day mapping are assumed to happen upstream.

---

## Files in this feature

**Folder:**  
`src/features/calculators/gardenAnimal/GardenPlantingCalendarCalculator/`

- `GardenPlantingCalendarCalculator.config.json`  
  Node-level config that connects this calculator into the Planning Graph and SSA calculator engine.

- `GardenPlantingCalendarCalculator.schema.json`  
  JSON Schema describing the calculator’s input and output payload shape.

- `GardenPlantingCalendarCalculator.shim.js`  
  Pure logic shim that:

  - Validates & normalizes payloads,
  - Computes planting & harvest windows,
  - Produces calendar events and summary metadata,
  - Emits calculator-level events into the `eventBus`.

- `GardenPlantingCalendarCalculator.view.jsx`  
  React UI for entering climate & crop data, viewing the generated planting calendar, and launching garden sessions with **“Now”** CTAs.

- `GardenPlantingCalendarCalculator.hooks.js`  
  React hooks for:

  - Running the shim,
  - Wiring the calculator into the garden planner,
  - Emitting planner events for SessionRunner and the Planning Graph.

- `GardenPlantingCalendarCalculator.mappings.json`  
  Planning Graph “Next Steps” mapping, connecting outputs from this calculator into:

  - `gardenLayoutPlanner`
  - `irrigationPlanner`
  - `soilHealthTracker`
  - `yieldEstimator`
  - `preservationQueuePlanner`
  - `sessionSuggestions.garden`
  - `waterUseEstimator`

- `README.md`  
  (this file) Overview and integration notes.

---

## Conceptual Overview

### What this calculator does

1. **Takes inputs:**

   - **Climate**
     - `lastFrostDate`, `firstFrostDate`
     - `zone`, `notes`
   - **Calendar**
     - `year`
     - `alignWithFeastDays` (boolean)
     - `feastDays` (array of `{ name, date, feastId? }`) – already mapped to Gregorian dates upstream
   - **Crops**
     - `name`, `cropId`
     - `daysToMaturity`
     - `frostSensitivity` (`frost-hardy | frost-tolerant | tender | very-tender`)
     - `successionEnabled`, `successionIntervalDays`, `maxSuccessions`
     - `targetUse` (`fresh | preservation | mixed | seed`)
   - **Garden Layout (optional)**
     - `gardenLayout.beds[]` – basic structure for bed IDs and notes

2. **Computes:**

   - **Planting windows**  
     ranges of dates where it’s safe & sensible to plant each crop, including successions.
   - **Harvest windows**  
     approximate ranges when each crop should be ready to harvest, based on planting window start dates + days to maturity.
   - **Calendar events**  
     discrete events for:
     - Planting
     - Harvest
     - Generic garden tasks (optional)
   - **Summary metrics**
     - `totalCropsPlanned`
     - `totalPlantingEvents`
     - `totalHarvestWindows`
     - `notes` (if needed)

3. **Feeds into the Planning Graph & SessionRunner:**
   - Offers **“Now”** candidates for the garden domain page (upcoming events)
   - Pushes bed/season info to layout & soil planner
   - Pushes harvest windows to yield & preservation planners
   - Provides irrigation & water-use hints

---

## Data Contracts

### 1. Payload shape (high-level)

The calculator works with a “SSA calculator payload” of the form:

```ts
type GardenPlantingCalendarPayload = {
  context: {
    nodeKey: "gardenPlantingCalendar";
    version: string;
    // other engine metadata allowed
  };
  inputs: {
    climate: {
      lastFrostDate: string;      // "YYYY-MM-DD" or ""
      firstFrostDate: string;     // "YYYY-MM-DD" or ""
      zone?: string;
      notes?: string;
    };
    calendar: {
      year: number;
      alignWithFeastDays: boolean;
      feastDays: Array<{
        name: string;
        date: string;            // "YYYY-MM-DD"
        feastId?: string;
      }>;
    };
    crops: Array<{
      cropId?: string;
      name: string;
      daysToMaturity: number;
      frostSensitivity: "frost-hardy" | "frost-tolerant" | "tender" | "very-tender";
      successionEnabled?: boolean;
      successionIntervalDays?: number;
      maxSuccessions?: number;
      targetUse?: "fresh" | "preservation" | "mixed" | "seed";
    }>;
    gardenLayout?: {
      beds: Array<{
        bedId: string;
        label?: string;
        notes?: string;
      }>;
    };
  };
  outputs: GardenPlantingCalendarOutputs | null;
};
Where GardenPlantingCalendarOutputs is:

ts
Copy code
type GardenPlantingCalendarOutputs = {
  plantingWindows: Array<{
    windowId: string;
    cropId?: string;
    cropName: string;
    bedId?: string;
    season?: string;                // spring/summer/fall/winter
    startDate: string;              // "YYYY-MM-DD"
    endDate: string;                // "YYYY-MM-DD"
    earliestSafeDate?: string;      // "YYYY-MM-DD"
    latestSafeDate?: string;        // "YYYY-MM-DD"
    successionIndex?: number;       // 0-based
    flags?: string[];               // e.g. ["late-window", "frost-risk"]
  }>;
  harvestWindows: Array<{
    windowId: string;
    cropId?: string;
    cropName: string;
    bedId?: string;
    targetUse?: "fresh" | "preservation" | "mixed" | "seed";
    startDate: string;
    endDate: string;
    alignedFeastDays?: Array<{
      name: string;
      date: string;
      feastId?: string;
    }>;
  }>;
  calendarEvents: Array<{
    eventId: string;
    date: string;
    kind: "planting" | "harvest" | "task";
    title: string;
    notes?: string;
    cropId?: string;
    bedId?: string;
  }>;
  summary: {
    totalCropsPlanned: number;
    totalPlantingEvents: number;
    totalHarvestWindows: number;
    notes?: string;
  };
};
The exact validation rules are defined in GardenPlantingCalendarCalculator.schema.json.

Shim: GardenPlantingCalendarCalculator.shim.js
The shim is a pure logic module that:

Accepts payload and an optional deps object:

{ eventBus, featureFlags },

Validates & normalizes inputs,

Computes outputs,

Emits calculator-level events via eventBus (e.g. planningGraph.node.computed),

Returns a new payload with outputs populated.

Usage example (outside the view):

js
Copy code
import { runGardenPlantingCalendarCalculatorShim } from "./GardenPlantingCalendarCalculator.shim";
import eventBus from "@/services/events/eventBus";
import featureFlags from "@/config/featureFlags";

async function recomputePlantingCalendar(currentPayload) {
  const next = await runGardenPlantingCalendarCalculatorShim(currentPayload, {
    eventBus,
    featureFlags,
  });
  return next;
}
The shim is side-effect friendly only through eventBus; it does not directly interact with Dexie or SessionRunner.

View: GardenPlantingCalendarCalculator.view.jsx
The view:

Provides a card-style UI using SSA’s .ssa-* utility classes.

Manages its own payload and result state.

Calls the shim via runGardenPlantingCalendarCalculatorShim.

Exposes optional props:

initialPayload

onPayloadChange(payload)

onResult(payloadWithOutputs)

Key UI Features
Climate & Calendar panel

Date inputs for last/first frost

Year selector

Toggle: “Highlight harvest windows that align with feast days”

Helper text: Hebrew calendar work is upstream

Crops & Succession panel

Add/remove crops

Fields for:

name

daysToMaturity

frostSensitivity

successionEnabled, successionIntervalDays, maxSuccessions

targetUse (fresh/preservation/mixed/seed)

Summary strip

Crops planned

Planting windows count

Harvest windows count

Optional notes

Results grid

Planting windows table:

Date range + safe range

Crop, bed, season

Succession index

Flags

Action: “Start Bed Prep Session”

Harvest windows table:

Date range

Crop, bed, target use

Feast alignment badges

Action: “Plan Harvest Session”

Timeline events

Sorted list of upcoming calendar events

Per-event “Run Session for This” button

High-level “Planting Now” CTA to find the next planting event and request a session

Session integration from the view
The view builds a garden session and emits a session.requested event:

js
Copy code
eventBus.emit({
  type: "session.requested",
  ts,
  source: "calculators/garden/GardenPlantingCalendarCalculator.view",
  data: { session },
});
Sessions are built with buildGardenSessionFromWindow(windowItem, type) and follow the shared Session object contract from the Master Codegen Prompt.

Hooks: GardenPlantingCalendarCalculator.hooks.js
The hooks are small integration helpers to keep your pages lean and observable.

useGardenPlantingCalendarCalculator(initialPayload?, options?)
Manages payload + outputs state.

Runs the shim when requested.

Optionally connects to the garden planner + SessionRunner.

Return shape (simplified):

ts
Copy code
{
  payload,                // current payload
  outputs,                // current outputs
  isComputing,            // boolean
  error,                  // string | ""
  recompute,              // () => Promise<void>
  setPayload,             // (nextPayload) => void
  // event helpers:
  emitToPlanner,          // sends planningGraph events
  emitSessionRequested,   // emits "session.requested" for a specific event/window
}
This allows your garden dashboard or planner page to treat the calculator as a black box and focus on orchestration.

Mappings: GardenPlantingCalendarCalculator.mappings.json
This file describes how outputs from this node feed the larger Planning Graph.

Schema requires a top-level inputs object, so the mappings live inside inputs.edges[].

Key edges:

To gardenLayoutPlanner

Uses outputs.plantingWindows[*] to:

Reserve beds

Spread successions sensibly

To irrigationPlanner

Uses outputs.calendarEvents[?kind=="planting"] to:

Schedule water-in tasks after planting

To soilHealthTracker

Uses successions & season patterns to:

Flag overused beds

Suggest cover crops / amendments

To yieldEstimator

Uses outputs.harvestWindows[*] to:

Generate weekly harvest load predictions

To preservationQueuePlanner

Focuses on harvest windows with targetUse == "preservation" | "mixed":

Creates preservation batches aligned with feast days

To sessionSuggestions.garden

Creates “Now” session suggestions for the garden domain page’s CTA

To waterUseEstimator

Combines planting density + seasons to:

Estimate irrigation needs over time

The Planning Graph engine can read these mappings and decide what next modules to invoke or what next steps to propose to the user.

Typical Integration Flow
1. Garden Planner Page
Import the view + hooks:

js
Copy code
import GardenPlantingCalendarCalculatorView from "./GardenPlantingCalendarCalculator.view";
import { useGardenPlantingCalendarCalculator } from "./GardenPlantingCalendarCalculator.hooks";
Initialize the hook with a default or stored payload.

Render the GardenPlantingCalendarCalculatorView with:

initialPayload={payload}

onPayloadChange={setPayload}

onResult={handleResult} (optional)

Use outputs + hooks to:

Update garden planner state,

Suggest sessions,

Push data into other nodes via the Planning Graph.

2. Domain “Now” button: Garden
The garden domain page can use outputs.calendarEvents (or the hook) to:

Find the nearest planting/harvest event within a time window (e.g. 7 days),

Emit session.requested with constructed garden session,

Trigger the global SessionRunner modal.

Event & Session Contracts
This calculator respects the SSA contracts from the Master Codegen Prompt:

Events emitted (via eventBus):

planningGraph.node.computed (from the shim)

session.requested (from the view and/or hooks)

Session contract (for emitted sessions):

ts
Copy code
type Session = {
  id: string;
  domain: "garden";
  title: string;
  source: {
    type: "gardenPlan";
    refId: string | null;  // windowId or eventId
  };
  steps: SessionStep[];
  prefs: {
    voiceGuidance: boolean;
    haptic: boolean;
    autoAdvance: boolean;
  };
  status: "pending" | "running" | "paused" | "completed" | "aborted";
  progress: {
    currentStepIndex: number;
    elapsedSec: number;
    startedAt: string | null;
    pausedAt: string | null;
  };
  analytics: {
    skippedSteps: string[];
    adjustments: any[];
  };
  createdAt: string;
  updatedAt: string;
};
The SessionRunner takes over from there (wake-lock, Picture-in-Picture, notifications, Dexie checkpoints, etc.).

Developer Notes
Hebrew calendar & feast day mapping are upstream concerns.
This calculator expects already-computed Gregorian dates and only highlights overlaps.

The shim is pure and should be easy to test in isolation:

Provide mock payloads for different zones, crops, and years.

Assert on planting/harvest window shapes.

The view is designed to plug into your existing SSA styles:

.ssa-calculator-card, .ssa-panel, .ssa-table, etc.

If your design tokens change, only the CSS needs to be updated; the layout/markup here is intentionally neutral.

The hooks are small but important glue:

Use them anywhere you need to access planting outputs without rendering the full calculator UI.

Ideal for dashboards or background recommendation engines.

Future Extension Ideas
Integrate with weather APIs to fine-tune planting windows around rain/cold snaps.

Add bed-level microclimate support (e.g., shaded vs full sun).

Support variety-level differences (e.g., early vs late tomatoes).

Connect to seed inventory and raise inventory blockers automatically.

Add multi-year rotation summaries for soil health and pest management.

If you change the schema or add new outputs (e.g., pest-risk windows, pollinator windows), update:

GardenPlantingCalendarCalculator.schema.json

GardenPlantingCalendarCalculator.shim.js

GardenPlantingCalendarCalculator.view.jsx

GardenPlantingCalendarCalculator.mappings.json

…to keep everything in sync and Planning Graph–friendly.
```

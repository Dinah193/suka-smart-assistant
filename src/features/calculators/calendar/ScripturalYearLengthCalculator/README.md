# Scriptural Year Length Calculator

The **ScripturalYearLengthCalculator** is the core **“year skeleton”** calculator for the calendar suite in Suka Smart Assistant (SSA).

It turns your chosen *scriptural cycle* and *year start* into a normalized **year structure**:

- Total year length (days)
- Months and their lengths
- Season groupings
- Optional sabbatical / Jubilee markers

That structure then feeds into:

- Garden & livestock season planners  
- Storehouse & preservation targets  
- Curriculum / term planning  
- Feast alignment (via `FeastDayAlignmentCalculator`)

This calculator itself does **not** create sessions; it feeds data into other Planning Graph nodes that *do* generate sessions for the shared **SessionRunner**.

---

## 1. Files in this folder

### 1.1 Core definition

- **`ScripturalYearLengthCalculator.config.json`**  
  Config for the Planning Graph node:
  - `nodeKey`: `"calendar.ScripturalYearLengthCalculator"`
  - `kind`: `"calculator-node"`
  - Declares:
    - Human name/description
    - Input and output keys
    - Which nodes it can **feed into** (garden, storehouse, feast alignment, curriculum, etc.)

- **`ScripturalYearLengthCalculator.schema.json`**  
  JSON Schema describing the calculator’s expected **input** and **output** shapes.

  **Input** (simplified):

  ```jsonc
  {
    "cycleKey": "plain-12 | intercalated-13 | fixed-364 | custom",
    "yearStart": "ISO-8601 string",
    "settings": {
      "dayCountStrategy": "observational | fixed",
      "intercalationStrategy": "none | aviv-based | pattern-7-13",
      "includeSabbaticalMarkers": true
    }
  }
Output (simplified):

jsonc
Copy code
{
  "yearStructure": {
    "yearLabel": "string",
    "yearStart": "ISO-8601 string",
    "yearEnd": "ISO-8601 string",
    "totalDays": 0,
    "months": [
      {
        "index": 1,
        "name": "Aviv",
        "lengthDays": 30,
        "start": "ISO-8601",
        "end": "ISO-8601"
      }
    ],
    "seasons": [
      {
        "key": "spring",
        "name": "Spring",
        "start": "ISO-8601",
        "end": "ISO-8601",
        "monthIndexes": [1, 2, 3]
      }
    ],
    "sabbatical": {
      "isSabbaticalYear": false,
      "isJubileeYear": false,
      "cycleIndex": null
    }
  },
  "diagnostics": {
    "warnings": [],
    "notes": []
  }
}
The actual schema file is stricter (types, enums, required props) and is used by both the shim and any UI to validate data.

1.2 Shim logic
ScripturalYearLengthCalculator.shim.js

A shim module that adapts user/graph requests to the core logic, validates against the schema, and emits standardized events.

Key responsibilities:

Validate the request against ScripturalYearLengthCalculator.schema.json.

Normalize cycleKey and yearStart.

Compute:

Month list (name, index, start, end, lengthDays)

totalDays

Season groupings (e.g., 4 seasons or more granular blocks if needed)

Optional sabbatical/Jubilee markers based on cycle settings.

Emit Planning Graph events through eventBus:

planningGraph.calculator.requested

planningGraph.calculator.succeeded

planningGraph.calculator.failed

Return a result object consistent with the schema.

The shim is written defensively:

Early return on invalid input (with diagnostics).

Safe defaults for unknown cycles (e.g. fallback to 12×30 or to month-length hints from another node).

Clearly marked extension points so you can plug in more sophisticated calendar rules later.

1.3 View / UI
ScripturalYearLengthCalculator.view.jsx

A React view that lets users:

Choose:

Cycle type (plain-12, intercalated, fixed-364, or custom).

Year start date (from month-start data or explicit date).

Optional sabbatical/Jubilee options.

See:

A table of months (index, name, start, end, length).

A visual season bar or badges grouping months into seasons.

Year summary (total days, sabbatical/Jubilee flags).

Push the chosen year structure into the Planning Graph as the canonical year for:

Garden planning

Storehouse/preservation planning

Curriculum & household rhythm planning

UX notes:

The view is designed as a tool panel, not a full-page route:

Works inside existing SSA dashboards/calculator layouts.

Shows meaningful empty states and validation messages.

When a year structure is applied, it can surface “Next Steps” suggestions using the mappings file.

1.4 Hooks
ScripturalYearLengthCalculator.hooks.js

React hooks to consume year structure in other SSA parts:

useScripturalYearStructure()

Returns the current canonical year structure (if defined) plus loading/error states.

useYearAnchoredPlanning()

Helper for:

Garden planners (map seasons to planting/harvest windows).

Curriculum planners (terms/blocks by months or season).

Stability/household rhythm planners (rest weeks, travel windows).

Hooks emit domain-level events when changes are applied, so the Planning Graph and Session generators can react.

1.5 Mappings
ScripturalYearLengthCalculator.mappings.json

“Next Steps” / Planning Graph hints describing what to do after a successful calculation.

Example mappings (conceptually):

From yearStructure to:

garden.SeasonPlanner

storehouse.AnnualGoalPlanner

curriculum.TermPlanner

calendar.FeastDayAlignmentCalculator

This file is used by the orchestration layer to suggest or auto-trigger downstream calculations and planners when the year structure is updated.

2. How this calculator fits the Planning Graph
High-level data flow with other calendar tools:

text
Copy code
HebrewMonthStartCalendar
       └─> ScripturalYearLengthCalculator
             ├─> FeastDayAlignmentCalculator
             ├─> Garden Season Planner
             ├─> Storehouse Annual Planner
             └─> Curriculum / Term Planner
Order of operations:

Month starts (optional but recommended)
Use HebrewMonthStartCalendar to determine Day 1 of each month based on your chosen rules.

Year structure
Use ScripturalYearLengthCalculator to:

Confirm/override month lengths & total days.

Group months into seasons.

Mark sabbatical/Jubilee if applicable.

Feasts & planning
FeastDayAlignmentCalculator and other planners consume yearStructure to set:

Feast dates & prep windows.

Garden seasons and rotations.

Storehouse targets and preservation cycles.

Curriculum terms with coherent breaks.

Downstream planners then generate sessions (cooking, cleaning, garden, preservation…) which are run by the shared SessionRunner with wake-lock, notifications, and navigation resilience.

3. Example usage (developer flow)
3.1 From code (shim invocation)
js
Copy code
import { runScripturalYearLengthShim } from "./ScripturalYearLengthCalculator.shim";

async function example() {
  const request = {
    cycleKey: "intercalated-13",
    yearStart: "2026-03-21T18:00:00Z",
    settings: {
      dayCountStrategy: "observational",
      intercalationStrategy: "aviv-based",
      includeSabbaticalMarkers: true,
    },
  };

  const result = await runScripturalYearLengthShim(request);

  if (!result || !result.ok) {
    console.warn("Year length calc failed:", result?.diagnostics);
    return;
  }

  console.log("Year structure:", result.output.yearStructure);
  // Pass into your planner, e.g. gardenSeasonPlanner.consume(result.output.yearStructure)
}
3.2 In UI
User opens Scriptural Year Length tool in the calendar section.

Picks:

Cycle (plain-12, intercalated-13, etc.).

Year start (from month-start outputs or manual date).

Clicks “Apply as Planning Year”.

The view:

Calls the shim.

Displays the year structure table & season summary.

Fires an event or calls a callback hooking into:

Garden, storehouse, feast, and curriculum planners.

Optionally shows Next Steps:

“Plan garden seasons”

“Align feasts”

“Set curriculum terms”

4. SessionRunner connection (indirect)
The ScripturalYearLengthCalculator:

Does not run sessions itself, but it shapes the when of almost everything else.

Once planners use yearStructure to build sessions (e.g. “Spring planting week” or “Pre-Sukkot preservation batch”), those sessions:

Conform to the shared Session object contract.

Are surfaced on domain dashboards with “Now” buttons.

Are executed in the shared SessionRunner (full-screen modal, wake-lock, notifications, Picture-in-Picture mini-HUD, etc.).

This keeps calendar logic centralized and explicit, while SessionRunner remains generic and domain-agnostic.

5. Extensibility
You can extend the Scriptural Year Length Calculator in several ways:

New cycles
Add new cycleKey values (e.g. essene-364, custom-pattern-x) and handle them in the shim.

More complex season logic
Instead of 4 large seasons, define:

Micro-seasons for specific crops.

Teaching blocks (e.g., literacy focus, agrarian focus, festival focus).

Deeper sabbatical / Jubilee rules

Track count of years within a 7- or 50-year cycle.

Attach additional metadata to sabbatical output:

“Land rest recommended”

“Debt release planning”

Keep all changes in sync between:

ScripturalYearLengthCalculator.schema.json

ScripturalYearLengthCalculator.shim.js

Any UI/hook logic consuming the output.

6. Developer checklist
When you modify or extend the Scriptural Year Length Calculator:

Update schema

Add/adjust properties in ScripturalYearLengthCalculator.schema.json.

Update shim

Implement new cycles or logic in ScripturalYearLengthCalculator.shim.js.

Ensure it still validates input and output against the schema.

Update config & mappings

ScripturalYearLengthCalculator.config.json for description/metadata.

ScripturalYearLengthCalculator.mappings.json to wire new Next Steps (e.g., new planners).

Update hooks & view (if needed)

Expose new options in ScripturalYearLengthCalculator.view.jsx.

Surface new derived data in ScripturalYearLengthCalculator.hooks.js.

Test in SSA

Verify that year structure:

Saves & loads correctly.

Propagates to garden/storehouse/feast/curriculum planners.

Feeds into session generators without breaking the SessionRunner flow.

This README is your reference while working on the Scriptural Year Length Calculator.
For the bigger picture of how all calendar calculators work together, see the parent calendar/README.md.
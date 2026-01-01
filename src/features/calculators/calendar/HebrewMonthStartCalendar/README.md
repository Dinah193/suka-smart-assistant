# HebrewMonthStartCalendar

HebrewMonthStartCalendar is an SSA **Planning Graph calculator node** that
turns your chosen *Hebrew month-start rule* + location + year into:

- A list of **Hebrew month start dates** (Gregorian + Hebrew indices)
- Optional **visibility / observation cues** (for your moon rules)
- Downstream **anchors** for:
  - feast planning,
  - garden / planting windows,
  - seasonal storehouse budgeting,
  - animal rotation and butchery timing.

It is the core calendar bridge between your **astronomy choices** and all the
other planning tools (storehouse, garden, animals, sessions, etc.).

---

## Files

All files live under:

`src/features/calculators/calendar/HebrewMonthStartCalendar/`

- `HebrewMonthStartCalendar.config.json`  
  Planning Graph **node config** (id, domain, labels, and how SSA sees this calculator).
- `HebrewMonthStartCalendar.schema.json`  
  JSON Schema for **inputs and outputs** of the calculator.
- `HebrewMonthStartCalendar.shim.js`  
  **Shim module** that computes month start dates from the chosen method.
- `HebrewMonthStartCalendar.view.jsx`  
  React **UI view** for choosing a method, running the calculator, and seeing calendar results.
- `HebrewMonthStartCalendar.hooks.js`  
  React hooks that **connect calendar outputs** to planting, feast logic, and downstream planning.
- `HebrewMonthStartCalendar.mappings.json`  
  Planning Graph **Next Steps mapping** that defines how this calculator feeds other nodes.

---

## 1. Node Config (config.json)

**File:**  
`HebrewMonthStartCalendar.config.json`

This file declares the calculator node to the Planning Graph:

- `id`: `"calendar.hebrewMonthStart"`
- `kind`: `"calculator-node"`
- `domain`: `"storehouse"` (calendar is treated as storehouse-adjacent planning)
- `label`: Display name for menus
- `description`: Human-readable summary
- `version`: Config version
- `config`:  
  - `inputSchemaRef`: Path to `HebrewMonthStartCalendar.schema.json`
  - `shimModule`: Path to `HebrewMonthStartCalendar.shim.js`
  - `viewComponent`: View component path for lazy-loading
  - `flags`: Assorted feature hints (e.g., needs location, needs external API)

SSA uses this file to:

1. Show the calculator in **menus and “Next Steps” panels**.
2. Validate **inputs/outputs** against the schema.
3. Load the **shim** and **view** dynamically.

You generally don’t need to edit this unless:

- You move/rename files, or
- You want to change labels, domain, or flags.

---

## 2. Schema (schema.json)

**File:**  
`HebrewMonthStartCalendar.schema.json`

Defines the shape of inputs and outputs used by:

- The **shim** (`.shim.js`)
- The **view** (`.view.jsx`)
- The **hooks** and Planning Graph

### Inputs

- `methodPresetId` (`string`)  
  One of:
  - `"fullMoon"`
  - `"firstVisibleCrescent"`
  - `"astronomicalNewMoon"`
  - `"moonDoesNotCrossMeridian"`
- `latitude` (`number`)  
- `longitude` (`number`)
- `year` (`number`) – Gregorian year you want to generate.
- `timezone` (`string`) – IANA timezone (e.g. `"America/Chicago"`).
- `includeIntercalary` (`boolean`) – Whether to include leap/intercalary month info.
- `flags` (`array<string>`) – Internal hints/overrides (e.g. `["preferLocalObservation"]`).

### Outputs

- `months` (`array`) of objects:
  - `hebrewMonthIndex` (`integer`, 1–13)
  - `hebrewMonthName` (`string`)
  - `gregorianStartDate` (`string`, ISO)
  - `visibilityWindowStart` (`string`, ISO|null)
  - `visibilityWindowEnd` (`string`, ISO|null)
  - `seasonTag` (`string`) – e.g. `"spring"`, `"summer"`, `"fall"`, `"winter"`
  - `flags` (`array<string>`) – e.g. `["intercalary", "approximation"]`
- `meta` (`object`):
  - `methodPresetId` (`string`)
  - `year` (`number`)
  - `location` (`object` with `latitude`, `longitude`, `timezone`)
  - `generatedAt` (`string`, ISO)

---

## 3. Shim Logic (shim.js)

**File:**  
`HebrewMonthStartCalendar.shim.js`

### Responsibilities

- Validate inputs against `HebrewMonthStartCalendar.schema.json`.
- Call your **astronomy / moon-phase helpers** (or placeholder logic) to find:
  - approximate full moon dates,
  - new moon / conjunction,
  - first visible crescent windows,
  - “moon does not cross meridian” conditions.
- Build the `months[]` array with:
  - `hebrewMonthIndex`
  - `hebrewMonthName`
  - `gregorianStartDate`
  - `seasonTag`, `flags`, and optional visibility windows.
- Emit a consistent, **defensive** `ShimResponse`:

```js
{
  ok: true,
  calculator: "HebrewMonthStartCalendar",
  nodeKey: "calendar.hebrewMonthStart",
  input,
  output,
  warnings: [],
  meta: { durationMs, source: "HebrewMonthStartCalendar.shim" }
}
SSA Integration
Uses eventBus.emit() to log start/end:

calculator.invoked

calculator.completed

calculator.failed (on error)

Ready for familyFundMode export if you later want to share your calendar outputs with the Hub.

4. View Component (view.jsx)
File:
HebrewMonthStartCalendar.view.jsx

UX Goals
Let the user select a method (full moon, FVC, etc.).

Let user set location + year.

Show calendar results in a compact, readable layout:

Month grid or list with Hebrew month names,

Gregorian start dates,

season tags,

flags (e.g. intercalary).

Provide next-step CTAs:

“Use for planting plans”

“Generate feast prep sessions”

“Sync to storehouse seasons”

Implementation Outline
A small form (method, year, location).

“Calculate” button → calls the shim.

Results section with:

Month table/list,

Optional highlight for key months (1 & 7).

Hooks into Next Steps via mappings and hooks (see below).

5. Hooks (hooks.js)
File:
HebrewMonthStartCalendar.hooks.js

Connects this calculator to the rest of SSA:

useHebrewMonthStarts(options)
Loads the latest or a specific year’s outputs from Dexie or in-memory state.

Returns:

months

meta

refresh() to recompute via the shim.

useHebrewPlantingPlans(months, cropsConfig)
Turns months[] into planting windows:

Spring crops anchored to specific Hebrew months,

Late harvest windows,

Optional fall / winter plantings.

useHebrewFeastSessions(months, feastConfig)
Creates feast anchor data:

feastKey, feastName,

hebrewMonth, hebrewDay,

approximate approxGregorianDate.

Used downstream to generate feast prep sessions for storehouse and cooking.

Each hook emits appropriate events (e.g. calendar.monthStarts.updated) to keep SSA’s Planning Graph aware of new data.

6. Next Steps Mappings (mappings.json)
File:
HebrewMonthStartCalendar.mappings.json

Defines how the calculator feeds other nodes:

To garden:

calendar.hebrewMonthStart -> garden.plantingWindows

Uses useHebrewPlantingPlans to create planting windows.

To feast anchors:

calendar.hebrewMonthStart -> calendar.feastAnchors

Uses useHebrewFeastSessions to create feast anchors.

To feast prep sessions:

calendar.feastAnchors -> sessions.feastPrep

Builds session drafts for storehouse/cooking.

To storehouse seasonal budget:

calendar.hebrewMonthStart -> storehouse.seasonalBudget

Creates season segments based on Hebrew months.

To animals rotation calendar:

calendar.hebrewMonthStart -> animals.rotationPlanning

Aligns breeding/pasture/butchery with seasons and feasts.

You rarely edit this unless you’re adding new downstream nodes or flows.

7. Using It in SSA
Mount the view somewhere (e.g. under a Calendar or Storehouse route):

jsx
Copy code
import HebrewMonthStartCalendarView from "@/features/calculators/calendar/HebrewMonthStartCalendar/HebrewMonthStartCalendar.view.jsx";

// inside your route:
<HebrewMonthStartCalendarView />
Run a calculation via the UI form.

The shim stores the output (via Dexie / state) and emits events.

Hooks and mappings pick up the outputs:

Planting windows

Feast anchors

Storehouse seasons

Animal rotations

“Now” buttons on domain pages can use these anchors to propose:

“Start Unleavened Bread prep session now”

“Batch-cook feast meat now”

“Begin fall planting session now”

8. Extending / Customizing
Add a new method:

Update schema.json enum for methodPresetId.

Implement logic in shim.js.

Expose in view.jsx.

Add a new downstream planner:

Add a new rule in mappings.json.

Implement a hook or planner node to consume months[].

Because everything is schema-driven and event-driven, this calculator
remains portable, extensible, and central to your Hebrew calendar-based
household planning.
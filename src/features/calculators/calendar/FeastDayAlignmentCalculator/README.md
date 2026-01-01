# FeastDayAlignmentCalculator

FeastDayAlignmentCalculator is a **calendar-driven planning node** in the Suka Smart Assistant (SSA) Planning Graph.  
It takes a Hebrew month start model (from `HebrewMonthStartCalendar`) plus a feast configuration and produces:

- Concrete **Gregorian feast dates** for the selected Hebrew year
- **Prep windows** leading into each feast
- A normalized structure that other domains (cooking, cleaning, garden, animals, preservation, storehouse) can use to:
  - Suggest **sessions** (via SessionRunner)
  - Update **plans** (storehouse pulls, garden timings, butchery schedules, decor/atmosphere)

This node is **pure logic + mappings**:
- **Schema:** `FeastDayAlignmentCalculator.schema.json`
- **Shim:** `FeastDayAlignmentCalculator.shim.js`
- **View (UI):** `FeastDayAlignmentCalculator.view.jsx`
- **Hooks:** `FeastDayAlignmentCalculator.hooks.js`
- **Mappings:** `FeastDayAlignmentCalculator.mappings.json`
- **Config:** `FeastDayAlignmentCalculator.config.json`

---

## 1. Purpose in the Planning Graph

FeastDayAlignmentCalculator is the bridge between:

- **Astronomical / rule-based month starts**  
  → from `HebrewMonthStartCalendar` (full moon, first crescent, “moon does not cross meridian”, etc.)

and

- **Household-ready feast planning**  
  → storehouse pulls, menus, cleaning, decor, animal/butchery planning, preservation flows.

It converts **(hebrewYear, monthStartModel, feast definitions)** into a **normalized set of feast objects**:

- Hebrew calendar info
- Gregorian date range
- Prep window range
- Metadata tags for downstream sessions and plans

These outputs then flow into other nodes via `FeastDayAlignmentCalculator.mappings.json`.

---

## 2. Data Contracts

### 2.1 Schema: `FeastDayAlignmentCalculator.schema.json`

The schema wraps a Planning Graph calculator definition with **input** and **output** sections.

**Input highlights:**

- `hebrewYear` (number): **Required** Hebrew year to align.
- `monthStartModel` (object):
  - `methodId` (string): Selected method id (e.g. `"fullMoon"`, `"firstVisibleCrescent"`, etc.)
  - `location` (lat/lon) and `timezone` for astronomical rules.
- `feastConfig` (object):
  - `feasts` (array):
    - Each feast has `code`, `label`, `hebrewMonthIndex`, `hebrewDay`, `durationDays`, `prepDaysBefore`, `category`.

**Output highlights:**

- `alignedFeasts` (array of objects):
  - `code`, `label`
  - `hebrewMonthIndex`, `hebrewDay`, `durationDays`
  - `gregorianStartDate`, `gregorianEndDate` (ISO date strings)
  - `prepWindowStart`, `prepWindowEnd` (ISO for preparation)
  - `category`, `tags`
  - `constraints` (optional guard hints: sabbath boundaries, quiet hours, etc.)

The root object also includes:

- `calculatorId`: `"calendar.FeastDayAlignmentCalculator"`
- `domain`: `"storehouse"`
- `metadata`: versioning and description fields.

> If your editor complains about missing `input` / `output`, ensure the root object includes both keys as defined in the schema.

---

## 3. Shim Logic: `FeastDayAlignmentCalculator.shim.js`

The shim is a **pure function + wiring layer**. It:

1. Validates the payload against the schema (using your existing validation helper).
2. Receives:
   - `hebrewYear`
   - `monthStartModel`
   - `feastConfig.feasts[]`
3. Uses a helper (e.g. `resolveHebrewDateToGregorian`) to convert each feast’s `(hebrewYear, hebrewMonthIndex, hebrewDay)` into Gregorian dates.
4. Computes:
   - `gregorianStartDate`, `gregorianEndDate` via calendar conversions and `durationDays`
   - `prepWindowStart` / `prepWindowEnd` by subtracting `prepDaysBefore` from `gregorianStartDate`
5. Adds `tags`, and optional `constraints` for guards.
6. Returns a **calculator result**:

```js
{
  calculatorId: "calendar.FeastDayAlignmentCalculator",
  input,
  output: {
    alignedFeasts: [ /* normalized feast objects */ ],
    generatedAt: "ISO_TIMESTAMP"
  },
  warnings: [],
  meta: { /* timing, version, etc. */ }
}
The shim also emits a Planning Graph event through the event bus:

type: "planningGraph.calculator.completed"

data: includes calculatorId, input, output, warnings.

4. UI: FeastDayAlignmentCalculator.view.jsx
The view is a calculator card that:

Allows the user to pick:

Hebrew year

Location/timezone (or uses SSA defaults)

Optional feast configuration profile

Shows:

A summary list of aligned feasts with:

Feast name, Hebrew date, Gregorian date, duration, prep window

A month-style calendar view that highlights:

Feast days

Prep windows

Exposes actions:

“Push to Feast Planner”

“Generate Menus”

“Suggest Cleaning Sessions”

“Export to Storehouse”

The view leverages hooks from FeastDayAlignmentCalculator.hooks.js for:

Submitting input to the shim

Receiving results

Triggering next-step mappings (session suggestions, plan updates)

It is UI-only and does not directly know about Dexie or SessionRunner internals.

5. Hooks: FeastDayAlignmentCalculator.hooks.js
Key hooks include:

5.1 useFeastDayAlignment(options)
Accepts:

Default year / method

Optional auto-run flag

Provides:

state (input form values)

setState handlers

alignedFeasts (latest output)

runCalculation() to invoke the shim

status, error, warnings

5.2 useFeastDrivenPlanning(alignedFeasts, options)
Bridges aligned feasts into:

Cooking flows: propose feast menus & batch cooking sessions

Cleaning flows: pre-feast cleaning blocks

Preservation flows: make-ahead dishes, leftovers preservation

Garden flows: linking crops/harvest to feast seasons

Storehouse flows: inventory pulls, shopping lists

Animal flows: butchery sessions aligned with feasts

Internally, this hook:

Uses the Planning Graph mappings to translate alignedFeasts into next-step suggestions.

Emits events such as:

planningGraph.nextSteps.generated

session.suggested (for domains that use sessions)

plan.update.requested (for inventory/garden/animals plans)

6. Mappings: FeastDayAlignmentCalculator.mappings.json
This file defines how feasts feed into other nodes.

Example mapping entries:

feastDayAlignment.toCookingFeastMenus

Domain: "cooking"

Action: "session.suggested"

Payload template: menus + batch cooking for feast/prep windows

feastDayAlignment.toCleaningPrep

feastDayAlignment.toPreservationFlows

feastDayAlignment.toStorehouseFeastInventory

feastDayAlignment.toGardenFeastPlantings

feastDayAlignment.toHouseholdDecorAndAtmosphere

feastDayAlignment.toAnimalAndButcheryPlanning

Each mapping:

References calculatorId: "calendar.FeastDayAlignmentCalculator"

Uses {{feast.*}} placeholders from alignedFeasts[]

Produces payloads for downstream nodes (sessions/plans)

7. Config: FeastDayAlignmentCalculator.config.json
The config file plugs this calculator into the Planning Graph registry and the storehouse domain:

id: "calendar.feastDayAlignment"

domain: "storehouse" (calendar + provisioning anchor)

label, description, icon, version

inputRefs: what upstream nodes it can consume (e.g. calendar.hebrewMonthStart)

outputRefs: what nodes are likely to consume its results (cooking, cleaning, garden, animals, preservation, storehouse)

This config is read by your planning engine to:

Show this calculator in UI menus

Wire it into cross-domain flows

Connect it to the mappings file.

8. SessionRunner & Automation Touchpoints
While FeastDayAlignmentCalculator itself is not a SessionRunner, it heavily influences which sessions are created and when:

When mappings produce session suggestions, SSA can:

Create pre-feast sessions for:

Cleaning

Menu prep

Butchery

Preservation

Decor/atmosphere

Surface “Now” CTAs on domain pages for:

“Feast Prep: Kitchen”

“Feast Prep: Cleaning”

“Feast Prep: Storehouse Pulls”

Downstream session generators should adhere to the standard Session object contract:

js
Copy code
{
  id,
  domain,           // cooking|cleaning|garden|animals|preservation|storehouse
  title,
  source,
  steps,
  prefs,
  status,
  progress,
  analytics,
  createdAt,
  updatedAt
}
Feast-driven sessions then run inside the SessionRunner modal, emitting:

session.started

session.step.changed

session.paused

session.resumed

session.completed

session.aborted

optionally session.exported (if familyFundMode is true)

9. How to Use in the App
Wire the calculator into your Planning Graph registry
Ensure FeastDayAlignmentCalculator.config.json is registered where you load node configs.

Mount the view
In your calendar / feast planning page, import and render:

jsx
Copy code
import { FeastDayAlignmentCalculatorView } from "./FeastDayAlignmentCalculator.view";
// ...
<FeastDayAlignmentCalculatorView />
Run a calculation

Choose Hebrew year and method.

Optionally adjust feast profiles.

Click “Align Feasts”.

Trigger planning flows

Use the UI buttons or programmatic hooks to:

Generate feast menus

Create cleaning sessions

Schedule preservation and butchery flows

Update garden and storehouse plans

Hook into SessionRunner

Downstream code that generates sessions from aligned feasts must:

Save sessions to Dexie sessions store

Emit canonical events

Expose “Now” CTAs that open SessionRunner.

10. Extension Ideas
Add multiple feast profiles (e.g. “Family Baseline”, “Guests Coming”, “Travel Feast”).

Integrate location-based seasonality (e.g. suggest different menus or garden ties based on climate).

Attach scriptural references in metadata for each feast and feed them into teaching/reading sessions.

Connect with pricing / storehouse calculators to show cost and stock impact per feast.

11. Troubleshooting
Schema not loading
Ensure the $schema path in FeastDayAlignmentCalculator.schema.json points to:

"../../../../schemas/planningGraph/calculator.schema.json"
relative to this folder.

Missing input / output errors
Confirm the schema root includes:

json
Copy code
{
  "input": { ... },
  "output": { ... }
}
Mappings schema error
Ensure $schema in FeastDayAlignmentCalculator.mappings.json uses the correct relative depth to schemas/planningGraph/mappings.schema.json.
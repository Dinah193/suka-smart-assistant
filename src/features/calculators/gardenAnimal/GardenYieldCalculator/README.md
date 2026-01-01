# GardenYieldCalculator

**Path**

`src/features/calculators/gardenAnimal/GardenYieldCalculator/`

The **Garden Yield Calculator** takes planting and harvest plans from the garden planning tools and predicts:

- Expected yield by crop and bed
- Harvest load by week (how much comes in when)
- Preservation load (how much needs to be canned, frozen, dried, etc.)
- Storehouse coverage (% of your annual/seasonal targets met from the garden)
- Next actions that can be turned into runnable sessions (harvest, preservation, batch cooking)

It is part of the **Planning Graph** and is designed to feed directly into **SessionRunner** (garden, preservation, and storehouse sessions).

---

## 1. What this calculator does

At a high level, the Garden Yield Calculator:

1. **Reads planting & harvest windows**
   - From `GardenPlantingCalendarCalculator`:
     - `plantingWindows` (when beds get planted)
     - `harvestWindows` (expected harvest ranges for each crop)

2. **Combines with targets & household profile**
   - From `storehouseStockPlanner`:
     - desired jars, pounds, or units of food by crop and by use (fresh vs preservation)
   - From `householdProfileCalculator`:
     - household size, months of coverage desired, and per-person consumption patterns

3. **Applies yield assumptions**
   - Per crop yield assumptions like:
     - yield per square foot
     - yield per bed
     - yield per plant
   - These can be progressively improved over time from:
     - generic defaults
     - imported data
     - your own logged harvests

4. **Produces outputs that drive the household engine**
   - Predicted yields by crop and time window
   - Weekly harvest load timeline
   - Preservation workload buckets (by crop and preservation method)
   - Coverage relative to storehouse targets
   - Suggested **next actions** that can be turned into sessions

---

## 2. Files in this folder

- **`GardenYieldCalculator.config.json`**  
  Node config wiring this calculator into the Planning Graph:
  - Node id, labels, and description
  - Expected inputs and outputs
  - Relations to other nodes (storehouse, planning calendar, etc.)

- **`GardenYieldCalculator.schema.json`**  
  JSON Schema describing:
  - Inputs (crops, plantingWindows, harvestWindows, storehouseTargets, householdProfile, etc.)
  - Outputs (yieldEstimates, harvestLoadByWeek, preservationLoad, storehouseCoverage, nextActions)

- **`GardenYieldCalculator.shim.js`**  
  Logic that:
  - Validates and normalizes payloads
  - Computes approximate yields and harvest timing
  - Builds structured outputs for the graph
  - Emits events via `eventBus` and optionally exports to the Hub when `familyFundMode` is enabled

- **`GardenYieldCalculator.view.jsx`**  
  React UI that:
  - Visualizes yields and weekly harvest loads
  - Shows coverage vs. storehouse goals
  - Provides a “Now” CTA and per-row buttons to trigger:
    - Harvest sessions
    - Preservation sessions
    - Batch cooking sessions based on expected produce

- **`GardenYieldCalculator.hooks.js`**  
  Hooks that link yield outputs into:
  - Storehouse inventory flows
  - Batch cooking planner
  - Preservation SessionPlanner
  - Automation engine (next-best actions)

- **`GardenYieldCalculator.mappings.json`**  
  Planning Graph mappings:
  - `inputs` / `outputs` key paths
  - Edges to/from:
    - Garden planting calendar
    - Storehouse stock planner
    - Household profile calculator
    - Preservation and harvest planners
    - Automation engine (“gardenNextActions”)

- **`README.md` (this file)**  
  Human-facing documentation for how to use and extend the calculator.

---

## 3. Input & output shape (conceptual)

### 3.1 Inputs (from `GardenYieldCalculator.schema.json`)

Main input sections:

- `context`
  - `nodeKey` (e.g., `"gardenYield"`)
  - `version` (e.g., `"1.0.0"`)

- `inputs`
  - `crops[]`
    - `cropId`
    - `name`
    - `variety`
    - `bedId`
    - `areaSqFt` or `plantsCount`
    - `targetUse` (`"fresh" | "preservation" | "mixed"`)
    - `yieldPerSqFt` / `yieldPerPlant` (optional; from defaults if missing)
  - `plantingWindows[]`  
    From planting calendar:
    - `windowId`
    - `cropId`
    - `bedId`
    - `startDate`, `endDate`
    - `successionIndex`
  - `harvestWindows[]`
    - `windowId`
    - `cropId`
    - `bedId`
    - `startDate`, `endDate`
    - `targetUse`
    - `alignedFeastDays[]` (if any)
  - `storehouseTargets`
    - per-crop targets (e.g., pounds or jars per season)
  - `householdProfile`
    - size, ages
    - months of coverage desired
    - consumption patterns (optional)

### 3.2 Outputs

- `outputs.yieldEstimates[]`
  - by crop & bed
  - predicted amount (e.g., pounds, pieces, jars-equivalent)
  - approximate harvest window

- `outputs.harvestLoadByWeek[]`
  - grouped by ISO week or simple date ranges
  - for each week:
    - total by crop
    - total weight/volume
    - any “overload” flags (too much for one harvest session)

- `outputs.preservationLoad[]`
  - by crop and method
  - e.g.:
    - `tomato → canning: 32 jars`
    - `herbs → dehydrating: 8 trays`

- `outputs.storehouseCoverage[]`
  - per crop:
    - predicted yield vs target
    - coverage percentage
    - “shortfall” or “surplus” flags

- `outputs.nextActions[]`
  - structured tasks the automation engine can turn into sessions:
    - `kind`: `"harvest-session" | "preservation-session" | "storehouse-update"`
    - `cropId`, `bedId`
    - `recommendedDateRange`
    - `notes`
    - `priority` (`"low" | "normal" | "high"`)

---

## 4. How this fits the SessionRunner

Yield predictions are not sessions by themselves, but they **feed sessions**:

- When harvest load in a given week exceeds a threshold:
  - The shim can create recommended `harvest-session` actions:
    - summary: `“Harvest tomatoes for sauce (Week 32)”`
    - approximate duration from volume and complexity
    - suggested steps for SessionRunner (via separate planner)

- When preservation load is calculated:
  - The hooks can:
    - Build recommended **Preservation sessions** (canning, freezing, dehydrating)
    - Emit `session.requested` events with structured session objects
    - Let the household choose “Now” or schedule later

- When storehouse coverage is low:
  - The calculator can flag:
    - “Increase planting of greens in fall”
    - “Buy bulk potatoes in Month X”
  - These become either:
    - Future garden actions
    - Storehouse purchasing sessions
    - Pricebook / ScanSheet suggestions

All of these can feed the **SessionRunner** via `eventBus.emit({ type: "session.requested", ... })` from the hooks or upstream planners.

---

## 5. Typical usage flows

### 5.1 Garden planning season

1. Use **GardenPlantingCalendarCalculator** to:
   - Configure climate & Hebrew calendar alignment
   - Add crops and optional successions
   - Generate planting and harvest windows

2. Run **GardenYieldCalculator**:
   - The view pulls in planting + harvest windows
   - User adds/edits bed sizes, yield assumptions, and storehouse targets
   - Hit “Recalculate Yield”

3. Review outputs:
   - **Yield estimates** per crop
   - **HarvestLoadByWeek** to see when you’ll be slammed
   - **Preservation load** for canning, freezing, dehydrating, etc.
   - **Storehouse coverage** to see what’s under or over target

4. Use hooks to:
   - Push preservation and harvest loads into:
     - Preservation SessionPlanner
     - Harvest SessionPlanner
     - Storehouse planner

### 5.2 In-season adjustments

1. As real harvest logs come in (from a Harvest SessionRunner or manual entry):
   - Update actual yield data per crop & bed
   - Re-run GardenYieldCalculator to refine predictions for late-season crops

2. The outputs update:
   - Surplus crops can generate extra preservation session suggestions
   - Shortfalls can trigger:
     - Additional plantings (if still possible)
     - Storehouse purchase suggestions (when combined with pricebook & ScanSheet)

---

## 6. Integration hooks (high-level)

The details live in `GardenYieldCalculator.hooks.js`, but conceptually:

- **To Storehouse**
  - Map `yieldEstimates` → expected inventory additions
  - Use `storehouseCoverage` to update coverage KPIs

- **To Preservation**
  - Map `preservationLoad` → preservation batch recipes & sessions
  - Generate `session.requested` events for canning/dehydration/freezing sessions

- **To Batch Cooking**
  - Take surplus fresh yield and:
    - Suggest batch-cooking sessions
    - Link to recipes that use those ingredients
    - Emit `session.requested` events for cooking sessions

- **To Automation Engine**
  - Feed `nextActions` into the automation runtime
  - Engine decides whether to:
    - Auto-schedule sessions (respecting Sabbath, QuietHours, weather guards)
    - Surface next-best-actions as prompts to the user

---

## 7. Extending the calculator

You can extend the Garden Yield Calculator by:

- **Adding more detailed yield assumptions**:
  - Different yields for:
    - in-ground beds vs raised beds vs containers
    - different varieties of the same crop
  - Adding seasonal/weather adjustment factors

- **Integrating historical data**:
  - Use logged yield history (Dexie table) to:
    - Update yield-per-area values per crop/bed
    - Improve predictions automatically each year

- **Adding labor estimates**:
  - Attach hours-of-work estimates per:
    - planting
    - harvesting
    - processing/preservation
  - Feed into weekly labor planning for the household

- **Connecting to external sources** (optional)
  - Future hook: seed catalog APIs, yield tables, etc.
  - Use external data to populate default yield assumptions.

---

## 8. Developer notes

- The **shim** is intentionally written to:
  - Be deterministic given a payload
  - Fail defensively if required fields are missing
  - Use **sane defaults** when data is partial
  - Emit structured, typed outputs that match the schema

- Keep the following contracts stable:
  - Mapping keys in `GardenYieldCalculator.mappings.json`
  - Field names in `GardenYieldCalculator.schema.json`
  - Event names and shapes when emitting to `eventBus`

If you need to change any of the above, consider bumping `context.version` so downstream tools know how to interpret the payload.

---

## 9. Quick mental model

- **Planting Calendar** = *When beds get planted & harvested*  
- **Garden Yield** = *How much food that schedule likely produces*  
- **Storehouse & Preservation** = *What you do with that food once it arrives*  
- **SessionRunner** = *How your household actually executes those plans in real time*  

The Garden Yield Calculator is the bridge between **what’s growing** and **what ends up in your jars, freezer, and dinner table**.
# Irrigation Calculator

**Path:**  
`src/features/calculators/gardenAnimal/IrrigationCalculator/`

The **Irrigation Calculator** helps you design practical watering plans for your garden beds based on crop needs, soil type, and climate. It turns your inputs into:

- Per-zone and per-bed **water requirements** (e.g., inches/week or gallons/week)
- A **weekly irrigation schedule** (days, times, and duration)
- **Stability / risk signals** that feed the Garden Yield and Soil Amendment tools
- Runnable **irrigation sessions** for the SessionRunner (via hooks and mappings)

It is part of the garden → yield → storehouse → preservation flow inside the SSA Planning Graph.

---

## Files in this folder

- `IrrigationCalculator.config.json`  
  Node configuration and Planning Graph metadata for this calculator.

- `IrrigationCalculator.schema.json`  
  JSON schema describing accepted **inputs** (water/soil/climate/crop requirements) and **outputs** (schedule, water requirements, stability).

- `IrrigationCalculator.shim.js`  
  Shim logic that computes irrigation needs and schedules from structured inputs, following SSA shim/Reasoner patterns.

- `IrrigationCalculator.view.jsx`  
  React UI for entering irrigation data, reviewing schedules, and creating garden irrigation sessions.

- `IrrigationCalculator.hooks.js`  
  Hooks to tie irrigation plans into **Garden Yield**, **Soil Amendment**, and stability tracking, and to expose “Now” runnable sessions.

- `IrrigationCalculator.mappings.json`  
  Next-Steps mapping to convert outputs into:
  - Garden irrigation sessions
  - Yield stability updates
  - Feedback to Soil Amendment and storehouse/preservation planners
  - Next Best Actions (NBA) for “Now” CTAs

---

## What the calculator does

At a high level, this calculator:

1. **Collects baseline data**
   - Garden bed / zone
   - Crop water needs (e.g., inches/week or relative level: low/medium/high)
   - Soil type and structure (sandy, loam, clay, amended)
   - Mulch/cover and slope (affecting evaporation and runoff)
   - Climate hints (hot/humid, hot/dry, mild, cool, etc.)
   - Available irrigation **method** (drip, soaker, sprinkler, hand-watering)
   - Local watering constraints (quiet hours, Sabbath, preferred times of day)

2. **Computes water requirements**
   - Approximates weekly water depth (inches/week) per crop/zone.
   - Converts to **gallons per week** based on area and method.
   - Allocates into a **weekly pattern** (e.g., 3x/week, 2x/week deep watering).

3. **Builds an irrigation schedule**
   - Suggests specific days & times (e.g., Mon/Wed/Sat at 6:00 AM).
   - Calculates run times per zone based on flow rate and desired gallons.
   - Marks **blocked** times (quiet hours, Sabbath, user-blocked times) so sessions can be shifted.

4. **Scores stability**
   - Produces stability hints such as:
     - `riskLevel: "low" | "moderate" | "high" | "critical"`
     - Flags for **over-water** or **under-water** risk.
   - These are consumed by:
     - `GardenYieldCalculator` (to adjust harvest projections)
     - `SoilAmendmentCalculator` (to flag soil structure/OM issues)
     - NBA logic for **Next Best Action** recommendations.

5. **Generates runnable sessions**
   - Each irrigation window can be turned into a **garden session**:
     - `domain: "garden"`
     - Steps like “Open irrigation valve for Zone A,” “Check for pooling,” etc.
   - Sessions respect the SSA Session object contract and can be:
     - Launched via **“Now”** on the garden domain page.
     - Run inside the global **SessionRunner modal**.
     - Paused/resumed, with events emitted to the event bus.

---

## Inputs (conceptual)

These are validated against `IrrigationCalculator.schema.json`. Key groups:

### Site / Zone

- `site.location` – optional broad location or micro-climate label.
- `zones[]`:
  - `id`, `label`
  - `areaSqFt` or `lengthFt * widthFt`
  - `slope` (flat / slight / steep)
  - `shadeLevel` (full sun / partial / shade)
  - `soilType` (sandy / loam / clay / amended)
  - `mulchDepthInches`

### Crops & Requirements

- `crops[]`:
  - `name`, `zoneId`
  - `waterDemandLevel` (low/medium/high) OR `targetInchesPerWeek`
  - Growth stage (seedling / vegetative / flowering / fruiting) if known.
  - Notes or preference tags (e.g. “drought-tolerant,” “shallow-rooted”).

### Irrigation Method

- `irrigationMethod` – drip / soaker / sprinkler / hand-watering.
- `flowRate` – GPM per emitter, per hose, or per zone, as available.
- Optional:
  - `maxZonesAtOnce` (to prevent pressure drops)
  - `availableWaterSource` (rain barrel, well, city; for awareness, not enforcement).

### Scheduling Preferences

- `preferredDaysOfWeek` (array)
- `preferredTimeWindows` (e.g., early morning, late evening)
- `forbiddenTimeWindows` for:
  - Quiet hours
  - Sabbath
  - Local restrictions
- `maxSessionsPerWeek` (per zone or global)

### Climate Hints

- `climateProfile` (hot-dry, hot-humid, mild, cool, etc.)
- Optional seasonal overrides (e.g., “mid-summer,” “early spring”).

---

## Outputs (conceptual)

Outputs are structured and validated so other modules can consume them reliably.

### Water Requirements

- `outputs.waterRequirements`:
  - `totalGallonsPerWeek`
  - `perZoneGallonsPerWeek[]`:
    - `zoneId`
    - `gallonsPerWeek`
    - `depthInchesPerWeek` (approx)
    - `sessionsPerWeek` and `gallonsPerSession`

### Irrigation Schedule

- `outputs.schedule[]`:
  - `id`
  - `zoneId`
  - `dayOfWeek`
  - `startTime` (local time string)
  - `durationMinutes`
  - `estimatedGallons`
  - `flags[]` (e.g. `["closeToQuietHours","highEvaporationTime"]`)

Where appropriate, this is used to generate **SessionRunner sessions**:
- Title: “Water Zone A – Monday AM”
- Steps:
  - “Inspect soil moisture briefly”  
  - “Run irrigation for 18 minutes”  
  - “Spot check pooling or runoff and adjust”

### Stability & Risk

- `outputs.stability`:
  - `riskLevel`: `"low" | "moderate" | "high" | "critical"`
  - `riskType`: `"underwater" | "overwater" | "mixed" | "unknown"`
  - `notes`: human-readable suggestions.

These fields feed:

- `GardenYieldCalculator` → adjusts expected yield / harvest windows.
- `SoilAmendmentCalculator` → flags potential soil structure or OM problems.
- NBA rules → drive “Now” CTAs and advice.

---

## How this fits the Planning Graph

**Node ID (from config):**

- `irrigationCalculator` – treated as a **garden planning node** in the Planning Graph.

**Feeds into:**

- **Garden Yield Calculator**
  - Shares water totals and risk levels.
  - Helps reconcile expected vs. achievable yields.

- **Soil Amendment Calculator**
  - High/critical risk may signal soil structure issues rather than schedule alone.

- **Storehouse & Preservation planners**
  - Stable irrigation → more predictable harvest → better batch preservation planning.

- **SessionRunner & “Now” buttons**
  - `IrrigationCalculator.mappings.json` and `IrrigationCalculator.hooks.js` expose:
    - **Next best actions** (NBA)
    - Runnable irrigation sessions
    - Data for “Now” CTAs on the **garden** page

---

## UI Usage (IrrigationCalculator.view.jsx)

### Find / Open

The view component is typically rendered inside the garden planning area, e.g.:

- `Garden Planning` → `Water & Irrigation` tab
- Or as a card on the garden dashboard with a **“Plan Irrigation”** button

### Main UI Regions

1. **Context Summary Panel**
   - Selected zone(s), soil type, and crop list.
   - Quick summary of storehouse goals (if any), so you remember why this bed matters.

2. **Input Form**
   - Step-by-step panels (accordion or wizard):
     1. Zones & soil
     2. Crops & water needs
     3. Irrigation method & flow
     4. Scheduling constraints (days, time windows, Sabbath/quiet hours)
     5. Climate profile

3. **Results & Schedule Viewer**
   - Cards or table showing:
     - Weekly gallons per zone.
     - Proposed schedule (days, times, durations).
     - Risk/stability indicators.
   - Ability to:
     - Adjust sessions (e.g., change start times or days).
     - Toggle zones on/off in the plan.

4. **Actions**
   - **Save Plan** (commit to Dexie + Planning Graph).
   - **Generate Sessions** to send irrigation events into the SessionRunner system.
   - **Export/Hooks**:
     - Connect to Garden Yield (update expectations).
     - Send hints to Soil Amendment (if risk is high).

5. **“Now” CTA**
   - A “Water Now” or “Run Next Irrigation Session” button that:
     - Resolves to the next scheduled event.
     - Emits a `session.request.start` event with a garden session payload.
     - Launches the global SessionRunner modal.

---

## Hooks & Integration

`IrrigationCalculator.hooks.js` includes key hooks like:

- `useIrrigationCalculatorState()`  
  Manages local inputs/outputs and validation.

- `useIrrigationToYieldBridge({ irrigationOutput })`  
  Pushes water totals and stability into the Garden Yield calculator.

- `useIrrigationToSoilBridge({ irrigationOutput })`  
  Flags soil review when risk suggests soil-related issues.

- `useIrrigationSessions({ irrigationOutput })`  
  Translates schedule entries into **SessionRunner** session objects and provides:
  - `createSessionsForSchedule()`
  - `getNextRunnableSession()`
  - `runNextIrrigationNow()` – typically wired to the “Now” CTA.

All hooks are designed to:

- Be **defensive** (graceful when data is missing/invalid).
- Avoid direct knowledge of view layout (pure logic + state).
- Emit events via `eventBus` when sessions are created or updated.

---

## Events & SessionRunner

When irrigation sessions are generated and run, you can expect:

- `session.started`  
- `session.step.changed`  
- `session.paused` / `session.resumed`  
- `session.completed` / `session.aborted`  

If `familyFundMode === true`, completed sessions can be exported via `exportToHubIfEnabled(...)` for community-level analytics.

The **SessionRunner modal**:

- Stays mounted at the app root (e.g., in `App.jsx`).
- Supports full-screen focus for irrigation sessions.
- Persists progress via Dexie (auto-resume if interrupted).
- Uses wake-lock and notifications where available to keep you on track.

---

## Typical workflow

1. **Define zones & crops**
   - Add your beds/zones, soil types, and which crops are planted where.

2. **Describe water needs**
   - High/medium/low or inches/week; pick a climate profile.

3. **Configure irrigation method & schedule**
   - Select drip/soaker/sprinkler/hand-watering and available time windows.

4. **Review suggestions**
   - Confirm weekly gallons and per-zone sessions.
   - Adjust days/times to fit your routine and household constraints.

5. **Save and generate sessions**
   - Save the plan and click **“Generate Irrigation Sessions”**.
   - Irrigation sessions become available to the **garden “Now” button** and the SessionRunner.

6. **Refine using feedback**
   - Watch stability scores and yield results over time.
   - If risk is high, revisit:
     - Soil structure/amendments
     - Mulch depth
     - Water timing and duration

---

## Notes & Extension Points

- Climate support is intentionally simple but can be expanded with:
  - Weather API integration.
  - Seasonal presets per geographic region.
- Flow rate estimation can be made more precise when the user measures:
  - Bucket fill time.
  - Manufacturer specs for drip emitters or sprinklers.
- Stability scoring and NBA rules are defined in:
  - `IrrigationCalculator.shim.js`
  - `IrrigationCalculator.mappings.json`  
  These files can be extended to add richer **Next Best Actions** and cross-links with other calculators.

If you keep to the schema and contracts in this folder, other SSA modules (Garden Yield, Soil Amendment, Storehouse, Preservation, and SessionRunner) will be able to consume and act on irrigation plans automatically.









ChatGPT can make mistakes. Check important info.
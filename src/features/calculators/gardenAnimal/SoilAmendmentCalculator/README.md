# SoilAmendmentCalculator

**Location**

`src/features/calculators/gardenAnimal/SoilAmendmentCalculator/`

The **SoilAmendmentCalculator** helps you turn soil test results and field observations into **concrete amendment plans** and **garden sessions** that can be run through the global `SessionRunner` (bed prep / amendment sessions).

It’s part of the **garden Planning Graph** and sits between:

- **GardenPlantingCalendarCalculator** → (what is planted where & when)
- **GardenYieldCalculator** → (what you expect to harvest & how stable the soil is over time)


---

## 1. What this calculator does

### High-level goals

1. **Capture soil state** per bed / zone:
   - pH, organic matter, NPK, texture, compaction, drainage, salinity, etc.
   - Test method (lab, DIY kit, observation only).

2. **Compare soil state to target fertility**:
   - Targets come from:
     - Crop needs (e.g., leafy greens vs. fruiting crops).
     - Yield intensity (low, standard, intensive).
     - Long-term soil stability goals.

3. **Recommend amendments & actions**:
   - Which materials, how much, and when:
     - Lime, sulfur, compost, manure, rock phosphate, bone meal, greensand, biochar, etc.
   - Plus **non-material actions**:
     - Cover crops, drainage fixes, raised beds, rest periods, mulch strategies.

4. **Emit actionable outputs**:
   - **`amendmentPlan`**: per bed, per season amendment tasks.
   - **`amendmentSessions`**: runnable garden sessions (bed prep + amend + water).
   - **`soilStabilityTrend`**: high-level rating used by yield & storehouse planners.
   - **`soilYieldHints`**: simple modifiers for yield calculations (boost/penalty).

5. **Hook into SessionRunner**:
   - “Prep Bed Now” / “Apply Amendments Now” CTAs from garden pages.
   - Sessions follow the canonical SSA `Session` contract and emit events:
     - `session.started`, `session.step.changed`, `session.completed`, etc.


---

## 2. Files in this feature

> All of these should be in the same folder:
>
> `src/features/calculators/gardenAnimal/SoilAmendmentCalculator/`

- **`SoilAmendmentCalculator.config.json`**  
  Node configuration in the Planning Graph: id, label, category, tags, and which inputs/outputs it expects/exposes.

- **`SoilAmendmentCalculator.schema.json`**  
  JSON Schema describing the **payload** for the calculator:
  - `context`, `inputs` (soil profile, target fertility, beds), and `outputs`
    (amendment recommendations, sessions, and stability ratings).

- **`SoilAmendmentCalculator.shim.js`**  
  “Shim” logic that:
  - Validates payloads against the schema.
  - Performs the core calculation (diff current vs target → amendments).
  - Builds optional **`Session`** objects for bed-prep / amendment work.
  - Emits events via the global `eventBus`.

- **`SoilAmendmentCalculator.view.jsx`**  
  React UI for:
  - Entering soil data (lab results, bed notes, etc.).
  - Viewing recommended amendments and stability ratings.
  - Launching “Now” sessions for amendment work.

- **`SoilAmendmentCalculator.hooks.js`**  
  Hooks that connect soil outputs into:
  - **GardenYieldCalculator** (yield modifiers, stability hints).
  - **Storehouse / preservation flows** (risk profile).
  - Shared “Next Steps” actions (e.g., schedule amendment session before planting).

- **`SoilAmendmentCalculator.mappings.json`**  
  Planning Graph “next steps” mapping:
  - Which nodes feed this calculator (planting calendar, yield).
  - Which nodes receive its outputs (yield, planting, storehouse, SessionRunner).


---

## 3. Data flow & Planning Graph integration

### Inputs (typical)

From **GardenPlantingCalendarCalculator**:

- `plannedBeds`: which crops are assigned to which beds and when.
- `cropRequirements`: per crop/bed ideal pH, NPK bands, organic matter targets.

From **GardenYieldCalculator** (optional):

- `yieldTargets`: desired intensity per bed (e.g., standard vs intensive).

From user or external lab:

- `soilProfile`:
  - `beds[]` with:
    - `ph`, `organicMatterPct`, `n`, `p`, `k`, `texture`, `drainage`, `salinity`,
      `notes`, etc.
  - `testMethod` (lab, diyKit, observation).

### Outputs

To **GardenYieldCalculator**:

- `soilYieldHints`: simple hints like:
  - `modifier` (e.g., 0.9 or 1.1).
  - `stabilityRating` (low / medium / high).
  - `notes` (e.g., “Low organic matter may reduce yields in hot spells.”).

- `bedConstraints`: flags for beds that should be treated as constrained until amendments are applied.

To **GardenPlantingCalendarCalculator**:

- `prePlantTasks`: tasks to inject before sowing/transplant dates:
  - “Apply compost to Bed A”
  - “Incorporate lime into Bed C by March 10”
  - These can show as pre-plant tasks and timeline events.

To **SessionRunner**:

- `amendmentSessions`: fully built **garden sessions** that can be started with a single “Now” click.

To **StorehousePlanner**:

- `soilStabilityTrend`: used to build a **risk profile** for long-term food security (“soil is trending up/down, so adjust preserved food targets accordingly”).


---

## 4. UI behavior (view component)

The `SoilAmendmentCalculator.view.jsx` should:

1. **Show input controls** for:
   - Selecting beds and linking them to soil tests.
   - Entering pH, NPK, organic matter, texture, compaction, etc.
   - Selecting test method and date.

2. **Display recommendations**:
   - Per bed: recommended amendment materials and quantities.
   - Priority (“critical before planting”, “nice-to-have this season”, etc.).
   - Notes with practical guidance (e.g., “Apply sulfur no later than 3 months before planting”).  

3. **Highlight stability**:
   - Simple badges or status:
     - “Stable & fertile”
     - “Needs attention”
     - “At risk (salinity/compaction)”

4. **Expose “Now” actions**:
   - **Per bed**: “Prep Bed Now” or “Apply Amendments Now”.
   - Each action constructs a `Session` and emits `session.requested` via `eventBus`:
     ```js
     eventBus.emit({
       type: "session.requested",
       ts: new Date().toISOString(),
       source: "calculators/garden/SoilAmendmentCalculator.view",
       data: { session }
     });
     ```
   - The global SessionRunner listens for this event and opens its modal with the session ready to run.

5. **Connect to existing garden pages**:
   - Garden dashboard can show a **summary strip**:
     - “Beds needing amendments this week”
     - “Stability trend” indicators.
   - “Now” CTA on garden pages can use hook helpers (see below) to resolve the **next amendment session**.


---

## 5. Hooks: how to use them

The hooks in `SoilAmendmentCalculator.hooks.js` expose reusable behavior.

### Example: resolve the “next amendment session”

```js
import { useNextSoilAmendmentSession } from "./SoilAmendmentCalculator.hooks";

function GardenNowButton() {
  const { nextSession, isLoading, error, triggerNow } =
    useNextSoilAmendmentSession();

  if (error) return <div className="ssa-alert-error">{error}</div>;

  return (
    <button
      type="button"
      className="ssa-button-primary"
      disabled={!nextSession || isLoading}
      onClick={triggerNow}
    >
      {nextSession ? "Prep Bed Now" : "No Soil Tasks"}
    </button>
  );
}
The hook:

Looks at the latest SoilAmendment outputs (from Dexie / in-memory state).

Chooses the nearest due amendment session.

Emits session.requested when triggerNow() is called.

6. SessionRunner expectations
When the shim builds sessions from amendment recommendations, they must:

Conform to the canonical Session contract.

Use domain: "garden" and source.type: "gardenPlan".

Define steps like:

“Gather tools and materials”

“Spread compost and amendments”

“Incorporate and water in”

With appropriate durationSec and blockers (e.g., weather, inventory).

The global SessionRunner will:

Acquire wake lock when possible.

Keep timers alive across navigation.

Emit analytics events on completion/abort.

Optionally export analytics to the Hub when familyFundMode === true.

7. Development notes
The calculator is not a soil science engine; it’s a household planner:

Aim for clear, conservative recommendations.

Prefer safe organic amendments and avoid very precise, high-risk suggestions.

Keep the shim:

Deterministic given the same inputs.

Side-effect-free except for:

Event emissions.

Optional logging.

Keep the view:

Stateless regarding business logic; call the shim on “Recalculate”.

Responsible only for:

Form controls.

Displaying results.

Emitting “Now” sessions.

Use the schema:

To validate internal changes.

To keep Planning Graph mappings consistent.

8. How to extend later
Potential extensions:

Add a cover-crop planner output node:

Suggest cover crops for beds resting this season.

Add cost estimates:

Price per amendment material, per bed, per season.

Add eco-impact / sustainability hints:

Highlight amendments that improve long-term soil health vs. short-term fixes.

Tie into Animal Planner:

Use manure and bedding from animals as inputs to compost/amendment recipes.

9. Quick checklist for integrating this node
Create / verify all files:

config.json, schema.json, shim.js, view.jsx,
hooks.js, mappings.json, README.md.

Register the calculator:

In any central Planning Graph registry or calculator index.

Wire the view:

Add a route or panel in the garden domain dashboard.

Ensure the “Recalculate” button calls the shim correctly.

Wire events:

Ensure session.requested events from this view are picked up
by the global SessionRunner.

Test flows:

Soil → amendments → sessions → SessionRunner.

Amendments → yield hints → GardenYieldCalculator.

Stability trend → Storehouse risk profile.

Once all of this is in place, your SSA users can see their soil, plan amendments, and immediately act with guided “Now” sessions—no separate tools, no scattered spreadsheets.
Just “what’s my soil like?” → “what do I need to do?” → “let’s do it now.”

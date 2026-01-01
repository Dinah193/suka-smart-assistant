# Micronutrient Calculator

Micronutrient Calculator is a shared **SSA health feature** that computes daily micronutrient targets from a simple profile (age, sex, weight, activity, focus areas, constraints) and then feeds those targets into the **Planning Graph**, especially:

- Meal Planner
- Garden Planner
- Animal Planner
- Storehouse Inventory / Storehouse Planning

It’s designed as a **shim-style module**: pure logic in `MicronutrientCalculator.shim.js` + thin React UI + hooks + Planning Graph mappings.

---

## Files in this feature

All under:

`src/features/calculators/health/MicronutrientCalculator/`

- `MicronutrientCalculator.config.json`  
  Node metadata for the Planning Graph (id/labels/tags, routing hints).

- `MicronutrientCalculator.schema.json`  
  JSON schema describing calculator **inputs** and **outputs** for validation and editor help.

- `MicronutrientCalculator.shim.js`  
  Core computation logic (pure JS, no React). Used by UI and automation (Planning Graph, sessions, etc.).

- `MicronutrientCalculator.view.jsx`  
  React UI for entering profile data and viewing nutrient targets + Planning Graph “Next Steps”.

- `MicronutrientCalculator.hooks.js`  
  Custom hooks to run the shim, manage local state, and call `Next Steps`.

- `MicronutrientCalculator.mappings.json`  
  Planning Graph Next Steps mapping from micronutrient results → Meal Planner, Garden Planner, Animal Planner, Storehouse, etc.

- `README.md`  
  (This file) Developer docs and extension notes.

---

## High-level flow

1. **User or upstream module** provides inputs:
   - age, sex, lifeStage
   - weight, height, unitSystem
   - activity level, pregnancy/lactation flags, etc.
   - focus flags (bone health, blood health, immune, etc.)
   - constraint flags (kidney issues, low sodium, low sugar, etc.)

2. **UI / hooks** call into the shim:
   - `buildMicronutrientCalculatorResult(input)` is the main orchestrator.

3. The **shim**:
   - Normalizes units.
   - Calculates nutrient targets (RDI / target ranges / upper limits) for each micronutrient.
   - Applies life-stage adjustments and focus/constraint tweaks.
   - Builds a Planning-Graph-friendly output object (targets + summary + flags).

4. **Hooks** store the result in component state and optionally:
   - Emit a calculator event (`calculator.micronutrient.calculated`) via eventBus (if you wire that in).
   - Request Next Steps from the Planning Graph, using `MicronutrientCalculator.mappings.json`.

5. **Planning Graph**:
   - Applies mapping rules to create recommended **next steps**:
     - Plan meals to cover gaps.
     - Plan garden crops for missing nutrients.
     - Plan animal products to cover gaps.
     - Review storehouse inventory for nutrient coverage.
   - Returns these steps to the UI / calling module.

6. Domain modules (Meals, Garden, Animals, Storehouse) receive payloads shaped by `payloadTransform` keys and can:
   - Open planner pages pre-loaded with nutrient-aware filters.
   - Build suggested sessions (meal batch sessions, garden tasks, animal product planning, etc.).

---

## Data contracts

### 1. Input shape (simplified)

The **schema** file describes the full shape; at minimum the shim expects something like:

```js
{
  profile: {
    age: number,
    sex: "female" | "male" | "other",
    lifeStage: "adult" | "child" | "senior" | "pregnant" | "lactating",
    weight: number,     // kg or lb based on unitSystem
    height: number,     // cm or in based on unitSystem
    unitSystem: "metric" | "imperial",
    activityLevel?: "sedentary" | "light" | "moderate" | "active" | "athlete"
  },
  focusFlags: {
    boneHealth?: boolean,
    bloodHealth?: boolean,
    immuneSupport?: boolean,
    heartHealth?: boolean,
    brainHealth?: boolean,
    metabolicHealth?: boolean
  },
  constraintFlags: {
    kidneyIssues?: boolean,
    limitSodium?: boolean,
    limitAddedSugar?: boolean
  }
}
The schema uses:

input object for the above,

output object for the result (see below),

and enumerations to keep values consistent across SSA.

2. Output shape (shim result)
The shim returns a structured result compatible with the Planning Graph and mappings:

js
Copy code
{
  profile,          // normalized profile used for calculations
  unitSystem,       // resolved unit system
  targets: {
    [nutrientKey]: {
      nutrientId: string,     // e.g. "calcium", "vitaminD", "iron"
      label: string,          // human-friendly label
      unit: string,           // "mg", "mcg", "IU" etc.
      rdi: number,            // base recommended daily intake
      adjustedTarget: number, // RDI after profile / focus adjustments
      upperLimit?: number | null,
      emphasis: "low" | "medium" | "high",
      gapEstimate?: number | null // optional: used by planners to prioritize
    }
  },
  focusFlags,       // normalized focus flags actually applied
  constraintFlags,  // normalized constraints
  summary: {
    headline: string,
    notes: string[],
    focusSummary: string[],
    constraintSummary: string[]
  },
  meta: {
    calculator: "MicronutrientCalculator",
    version: 1
  }
}
You can adjust internals as long as:

targets is a map of micronutrient keys → nutrient object.

Focus and constraint flags are preserved for mappings and Planners.

The result remains serializable to JSON.

Core logic: MicronutrientCalculator.shim.js
Key exported functions (names may vary slightly depending on your implementation):

normalizeMicronutrientInput(rawInput)

Validates required fields (age, sex, unitSystem, etc.)

Normalizes units (convert lb → kg, in → cm) and life stage.

Produces a clean internal representation.

calculateMicronutrientTargets(normalizedInput)

Applies base RDI tables (embedded in the shim, or later externalized).

Modifies targets for:

Age/life stage

Pregnant/lactating if used

Activity modifiers where appropriate

applyFocusAndConstraintAdjustments(targets, focusFlags, constraintFlags)

Focus flags can boost emphasis (e.g., boneHealth → higher emphasis on Ca, Mg, vitamin D, K).

Constraint flags can cap sodium/sugar-adjacent nutrients or adjust recommended ranges.

summarizeMicronutrientResult(result)

Builds human text summary for the UI and notes for other modules.

buildMicronutrientCalculatorResult(rawInput)

Orchestrates all steps, returns the final result object.

This is the primary function the hooks and Planning Graph should call.

Everything here is pure JS (no browser APIs, no React, no Dexie). This makes it safe to run:

in React components,

in Node-style automation,

in Service Workers (if you later wire them up),

in SSA’s automation runtime without UI.

React integration
MicronutrientCalculator.view.jsx
The view is a typical SSA feature panel, and should:

Use the hooks from MicronutrientCalculator.hooks.js.

Provide inputs for:

Age, sex, lifeStage

Weight, height, unitSystem

Activity level

Focus and constraint checkboxes/toggles

Render:

A summary card with the main headline/notes.

A table/grid of nutrient targets (nutrient name, target, unit, emphasis).

A “Next Steps” panel listing recommended actions (Meal Planner, Garden Planner, Animal Planner, Storehouse).

Interaction pattern:

User fills in profile → clicks Calculate.

Hook calls buildMicronutrientCalculatorResult.

Result is stored in state and shown in UI.

Hook calls into Planning Graph to get Next Steps.

User clicks a Next Step → SSA routes to the appropriate planner (meals/garden/animals/storehouse) with seed payload.

MicronutrientCalculator.hooks.js
Typical exports:

useMicronutrientCalculator()

Holds input state + result state.

Exposes calculate() method which:

Validates input.

Calls shim.

Optionally emits calculator.micronutrient.calculated via eventBus.

Stores the result.

useMicronutrientNextSteps(calculatorResult)

Takes a result object.

Calls Planning Graph to resolve Next Steps using MicronutrientCalculator.mappings.json.

Returns:

nextSteps array.

goToNextStep(step) helper, optionally sending SSA events and navigation.

Hooks are responsible for:

Defensive guards (no calc if required fields missing).

Avoiding crashing the UI on unexpected data.

Encapsulating how the Planning Graph is invoked.

Planning Graph integration
Node config: MicronutrientCalculator.config.json
This config declares the node inside the Planning Graph. Typical structure:

jsonc
Copy code
{
  "nodeId": "health.micronutrientCalculator",
  "label": "Micronutrient Calculator",
  "category": "health",
  "tags": ["micronutrients", "nutrition", "planning"],
  "entryPoints": {
    "ui": {
      "route": "/health/micronutrients"
    },
    "automation": {
      "eventTypes": [
        "calculator.micronutrient.requested"
      ]
    }
  }
}
Your actual file may have more metadata (e.g., icon, ordering, prerequisites). The important bits for SSA:

nodeId is referenced by mapping and Planning Graph.

The node identifies where it lives in the graph (health / calculators).

Next Steps mappings: MicronutrientCalculator.mappings.json
This file defines how the Planning Graph routes from micronutrient results to other modules.

Key sections:

routingDefaults

Shared priorities (high/medium/low).

Target module identifiers:

meals.mealPlanner

garden.planner

animals.planner

storehouse.inventory

Expected payload shape (which fields to pass).

nextSteps.default

Default recommended actions whenever a result exists:

Plan meals to hit micronutrient targets.

Plan garden crops for missing nutrients.

Plan animal products for nutrient coverage.

Check storehouse for coverage.

nextSteps.byFocus

Focus-specific next steps:

boneHealth → bone-supportive meals/crops.

bloodHealth → iron/B-vitamin meals + organ meat planning.

immuneSupport → immune-supportive meals/herbs.

heartHealth → heart-friendly meal plans.

brainHealth → brain/mood supportive foods and crops.

metabolicHealth → metabolic support meals.

nextSteps.byConstraint

Constraint-aware next steps:

kidneyIssues → filtered storehouse / meal plans.

limitSodium → low-sodium meal planning.

limitAddedSugar → low-sugar meal planning.

Each Next Step entry declares:

id – stable identifier.

label / description – for UI.

targetModuleId – which Planner/feature it points to.

priority – relative ordering.

conditions – flags that must be present (focusFlag, constraintFlag, requiresResult).

payloadTransform – transform type + field map, telling the Planning Graph how to construct payloads for the target modules.

Events & automation (optional wiring)
Although not required by this module itself, the intended event pattern is:

On successful calculation, your hook / page can emit:

js
Copy code
emit({
  type: "calculator.micronutrient.calculated",
  ts: new Date().toISOString(),
  source: "features/calculators/health/MicronutrientCalculator",
  data: {
    profile,
    result
  }
});
The automation runtime or Planning Graph engine can:

Listen to this event.

Automatically compute best Next Steps.

Optionally schedule sessions (e.g., “Bone Health Batch Cooking Session”).

If familyFundMode === true and you want to export to a Hub later, you can:

Wrap outbound payloads with HubPacketFormatter.

Send via FamilyFundConnector.

Emit session.exported or a calculator-specific event when successful.

(This is left for higher-level orchestration code; the Calculator itself remains pure+lightweight.)

Extension points
You’ll likely want to evolve this over time. Some suggested extension points:

1. Add more nutrients
Extend the internal nutrient table in MicronutrientCalculator.shim.js.

Make sure they appear in targets with:

nutrientId

label

unit

rdi / adjustedTarget

upperLimit if applicable.

2. Add or refine focus flags
Add a new focus flag (e.g., hairSkinNails) to:

MicronutrientCalculator.schema.json (input spec).

MicronutrientCalculator.shim.js adjustment logic.

MicronutrientCalculator.mappings.json under byFocus.

3. Add or refine constraint flags
For new constraints (e.g., diabetesRisk, hypertension):

Update schema.

Implement constraint logic in shim.

Add constraint-based Next Steps in mappings.

4. Integrate more planners/modules
Add new targetModuleIds in routingDefaults.

Create new Next Steps entries pointing to:

Preservation planner

Fermentation/batch cooking planner

CSA/Buying Club planner, etc.

5. Advanced: tie into SessionRunner
While the Micronutrient Calculator itself is not a session, its outputs can be used to seed sessions:

Meals:

Build a “Micronutrient-focused Batch Cooking Session” where steps are cooking tasks guided by nutrient targets.

Garden:

Build a “Plant the Bone-Health Bed” session, with steps for bed prep, seeding, watering.

Those sessions would follow the main SessionRunner contract defined in SSA and can be linked as part of the Planning Graph flows that start from this Calculator’s result.

Testing checklist
When you wire or extend this feature, verify:

 UI renders and validates basic inputs (age, sex, units, etc.).

 Calculation runs without crashing on minimal valid input.

 Results show reasonable ranges for common profiles (adult female, adult male, child, etc.).

 Focus flags actually change emphasis / targets for key nutrients.

 Constraint flags cause expected adjustments (e.g., sodium emphasis lowered when limitSodium).

 Next Steps list appears after calculation, with labels matching MicronutrientCalculator.mappings.json.

 Clicking a Next Step successfully routes to the corresponding Planner page with a meaningful payload.

 No React errors in console when fields are missing (defensive checks work).

 Feature remains headless-friendly (shim doesn’t require browser APIs).
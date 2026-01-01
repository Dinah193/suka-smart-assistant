# Black Hair Nutrition Calculator

> `src/features/calculators/health/HairNutritionCalculator/`

The **Black Hair Nutrition Calculator** is a health calculator in Suka Smart Assistant (SSA) that estimates daily **protein**, **healthy fat**, **key micronutrient**, and **hydration** targets to support **Black hair growth, length retention, and scalp health**.

It is built as a **shim-based feature**:

- All heavy logic lives in a **pure calculation shim** (safe for background workers, SessionRunner, and automation flows).
- React views and hooks wrap the shim for **UI**, **state management**, and **Planning Graph** integration.
- Results can be linked into **Meal Planner**, **Micronutrient Planner**, and **Storehouse** flows as “next steps.”

---

## Folder Overview

```text
HairNutritionCalculator/
  ├─ HairNutritionCalculator.config.json      # Node config for Planning Graph and SSA navigation
  ├─ HairNutritionCalculator.schema.json      # JSON Schema for input/output contract
  ├─ HairNutritionCalculator.shim.js          # Pure calculation logic (shim)
  ├─ HairNutritionCalculator.view.jsx         # React UI for form + results
  ├─ HairNutritionCalculator.hooks.js         # Hooks for state + runner + Planning Graph bridge
  ├─ HairNutritionCalculator.mappings.json    # “Next Steps” mappings into meals/storehouse/etc.
  └─ README.md                                # This file
What This Calculator Does
Inputs (high level)
The calculator takes a structured input object (validated against HairNutritionCalculator.schema.json), including:

Body + activity

unitSystem: "imperial" | "metric"

bodyWeight: number (lbs or kg)

activityLevel: "sedentary" | "light" | "moderate" | "active" | "athlete"

Hair profile

hairTypeProfile.curlPattern: e.g. "coily-4c", "locs", "curly-3b", etc.

hairTypeProfile.porosity: "low" | "medium" | "high | "unknown"

hairTypeProfile.scalpCondition: "normal" | "dry" | "itchy" | "flaky" | "inflamed" | ...

hairTypeProfile.chemicalHistory: ["relaxer" | "permanent-color" | "bleach" | ...]

Goals

growthGoalFlags.lengthRetention

growthGoalFlags.thickness

growthGoalFlags.sheddingReduction

growthGoalFlags.scalpHealing

growthGoalFlags.postpartumSupport

Protective styles

protectiveStylePattern.protectiveStyleType: "twists" | "braids" | "locs" | ...

protectiveStylePattern.weeksPerStyle

protectiveStylePattern.installTensionLevel

Nutrition context

macroTargets: optional calories/protein/fat/carb from Macro Calculator

micronutrientFocusFlags: iron, vitamin D, zinc, omega-3, biotin, etc.

dietaryPattern: "omnivore" | "pescatarian" | "vegetarian" | "vegan" | ...

dietaryConstraints: allergies, foods to avoid, budget level

hydrationCupsCurrent: current daily water intake

Outputs (high level)
The shim returns output (also defined in the schema):

dailyHairProteinTarget

grams

gramsPerKg

rationale

hairAminoProfile

Lysine, methionine, cysteine, arginine, histidine, tryptophan (g/day)

hairHealthyFatTargets

totalFatGrams

omega3Grams

omega6Grams

efaRatioHint

hairMicronutrientTargets

Iron, zinc, vitamin D, A, C, biotin, folate ranges

hairSupportFlags

proteinOnTrack, proteinLowRisk

ironSupportNeeded, vitaminDSupportNeeded, omega3SupportNeeded

hydrationSupportNeeded

summaryNote

blackHairRiskFlags

breakageRisk, sheddingRisk, drynessRisk

scalpInflammationRisk, protectiveStyleDamageRisk, postpartumRisk

notes

waterIntakeTargetCups

Suggested daily water target, tuned by dryness/scalp profile

The shim wraps this with a meta object:

js
Copy code
{
  meta: {
    nodeId: "health.hairNutritionCalculator",
    calculationVersion: "1.0.0",
    timestamp: "ISO-8601 string"
  },
  input: { ... },
  output: { ... }
}
Files in Detail
1. HairNutritionCalculator.config.json
Registers this calculator as a Planning Graph node (source node).

Exposes:

nodeId: "health.hairNutritionCalculator"

route: e.g. /health/hair-nutrition

graph.provides: keys like dailyHairProteinTarget, hairAminoProfile, hairSupportFlags, etc.

graph.consumes: bodyWeight, macroTargets, micronutrientFocusFlags, etc.

Declares events:

events.onCalculate: ["calculator.hairNutrition.calculated"]

events.onError: ["calculator.hairNutrition.error"]

Used by:

Navigation / quick launch

Planning Graph orchestration

“Next Steps” config

2. HairNutritionCalculator.schema.json
JSON Schema for the input and output shape.

Used to:

Validate calculator payloads.

Keep the shim, view, hooks, and Planning Graph consistent.

Guard against schema drift as we extend fields.

If you add fields in the shim or view, also update this schema.

3. HairNutritionCalculator.shim.js
Core logic module (shim).

Exports:

runHairNutritionCalculatorShim(rawInput, options?)

default HairNutritionCalculatorShim with:

NODE_ID

CALC_VERSION

run

Responsibilities:

Validate basic input: unitSystem, bodyWeight.

Compute:

Daily protein target and g/kg (based on base per-kg, hair multiplier, activity bump, clamp).

Amino acid profile from total protein.

Healthy fat targets (total fat, omega-3, omega-6, ratio hint).

Micronutrient ranges for hair support with risk bumps/postpartum adjustments.

Hair support flags and black hair–specific risk flags.

Water intake target.

Emit calculator events via eventBus.emit:

On success: calculator.hairNutrition.calculated

On error: calculator.hairNutrition.error

Optionally export to Hub when:

options.exportToHub === true

AND familyFundMode === true (feature flag)

Hub envelope uses:

HubPacketFormatter.formatCalculatorResult(...)

FamilyFundConnector.send(...)

No UI logic. Safe for:

Web Workers

Background pipelines

SessionRunner pre-checks or background “suggestions”

4. HairNutritionCalculator.view.jsx
React UI for the calculator:

Renders:

A form for:

Unit system, body weight, activity.

Hair/scalp profile.

Protective style pattern.

Hair goals.

Macro + micronutrient context.

Dietary pattern & budget.

Hydration.

A result panel with:

Protein target

Amino targets

Fat & omega targets

Micronutrient ranges

Support flags & risk flags

Hydration target

Uses runHairNutritionCalculatorShim directly to keep the view self-contained.

Persists state in localStorage:

Key: ssa.hairNutritionCalculator.state

{ input, result } is saved and reloaded on mount.

Includes an “Export to Family Fund Hub” checkbox:

Setting this passes exportToHub: true to the shim.

Intended to be mounted under the route in config.json (e.g. /health/hair-nutrition).

5. HairNutritionCalculator.hooks.js
React hooks for reusability and background integration:

buildDefaultHairNutritionInput()

Shared default input object used by view and other flows.

useHairNutritionCalculatorState()

Manages input and result with localStorage persistence.

Returns { input, setInput, result, setResult, reset }.

useHairNutritionCalculatorRunner(options?)

Wraps runHairNutritionCalculatorShim.

Tracks status: "idle" | "running" | "success" | "error".

Provides error and lastPayload.

Uses a run token to discard stale async responses.

Optionally emits a Planning Graph bridge event:

planningGraph.node.hairNutrition.updated

Data includes provides = dailyHairProteinTarget, hairAminoProfile, etc.

useHairNutritionCalculator(options?)

Convenience hook combining state + runner:

const { input, setInput, result, status, error, run, reset } = useHairNutritionCalculator();

run() uses the current input and updates result.

Use these hooks in:

Alternate views (mobile layouts, dashboards).

Automation flows that want to run the calculator and consume results without tightly coupling to the view.

6. HairNutritionCalculator.mappings.json
“Next Steps” configuration for the Planning Graph:

nodeId: "health.hairNutritionCalculator.nextSteps"

sourceNodeId: "health.hairNutritionCalculator"

Listens to:

calculator.hairNutrition.calculated

planningGraph.node.hairNutrition.updated

Contains rule objects:

Examples:

Protein & breakage support

When proteinOnTrack === false or breakageRisk === true:

Suggest high-protein hair-support meals.

Suggest stocking lamb, goat, beef, fish, eggs, legumes, beef gelatin, etc.

Iron and shedding support

When ironSupportNeeded or sheddingRisk:

Suggest iron‐rich meals (leafy greens, organ meats, legumes).

Storehouse items for iron.

Vitamin D & scalp health

When vitaminDSupportNeeded or scalpInflammationRisk:

Suggest vitamin D and anti-inflammatory meals.

Omega-3 & inflammation

Hydration & dryness

Postpartum support

General hair support bundle (if no major risks)

Catch-all info action if nothing else matches.

Downstream modules can interpret these actions (navigate to Meal Planner/Storehouse, show small inline cards, etc.).

How It Fits Into SSA & SessionRunner
While this calculator is not itself a SessionRunner domain, it fits into the broader SSA automation pattern:

User runs calculator → event emitted

Event: calculator.hairNutrition.calculated

Planning Graph node updates: planningGraph.node.hairNutrition.updated

Planning Graph “Next Steps”

Uses HairNutritionCalculator.mappings.json to generate:

Suggested meal-planning sessions.

Storehouse stocking tasks.

Those downstream tasks can be turned into sessions (e.g., cooking sessions or “batch cooking for hair support”) that run inside the SessionRunner modal:

“Now” CTA on Meal Planner or Storehouse pages can pick up hair-focused sessions.

These sessions then benefit from:

Wake-lock

Notifications

Background timers

Hub export for family-level analytics

The hair calculator itself remains pure and stateless (beyond local UI persistence), allowing:

Use in background analysis (e.g., nightly checks).

Re-use across households.

Optional sharing (via Hub) in familyFundMode.

Typical Usage Patterns
In a React Page
jsx
Copy code
import HairNutritionCalculatorView from "./HairNutritionCalculator.view.jsx";

export default function HairNutritionPage() {
  return <HairNutritionCalculatorView />;
}
In a Custom Component Using Hooks
jsx
Copy code
import { useHairNutritionCalculator } from "./HairNutritionCalculator.hooks";

function QuickHairCheckCard() {
  const { input, setInput, result, status, error, run } =
    useHairNutritionCalculator({ exportToHub: false });

  const onQuickRun = () => {
    // Optionally tweak a couple of input fields before running
    setInput((prev) => ({
      ...prev,
      hydrationCupsCurrent: Math.max(prev.hydrationCupsCurrent, 6),
    }));
    run();
  };

  return (
    <div>
      <button onClick={onQuickRun} disabled={status === "running"}>
        {status === "running" ? "Checking…" : "Quick Hair Nutrition Check"}
      </button>
      {error && <p>Error: {error}</p>}
      {result && (
        <p>
          Daily hair protein target:{" "}
          {result.output.dailyHairProteinTarget.grams} g
        </p>
      )}
    </div>
  );
}
Direct Shim Usage (e.g., in an automation worker)
js
Copy code
import { runHairNutritionCalculatorShim } from "./HairNutritionCalculator.shim";
import { getMacroNodeState } from "@/services/planningGraph";

async function nightlyHairNutritionPass(userContext) {
  const macroState = await getMacroNodeState(userContext.id, "health.macroCalculator");

  const input = {
    ...macroState.body,
    unitSystem: "imperial",
    hairTypeProfile: userContext.hairProfile,
    growthGoalFlags: userContext.hairGoals,
    hydrationCupsCurrent: userContext.hydrationCups,
    micronutrientFocusFlags: userContext.micronutrientFlags,
  };

  const payload = await runHairNutritionCalculatorShim(input, {
    exportToHub: true,
  });

  // payload.output can be used to auto-suggest sessions or tasks.
}
Extending the Calculator
When you extend or modify the calculator:

Update Schema

Add new fields in HairNutritionCalculator.schema.json under input or output.

Update Shim

Implement logic in HairNutritionCalculator.shim.js.

Make sure outputs match schema and remain backward-compatible where possible.

Update Hooks

If new fields should be persisted or included in Planning Graph provides, update:

buildDefaultHairNutritionInput

useHairNutritionCalculatorRunner provides payload.

Update View

Add form inputs and results display as appropriate.

Update Mappings

If new risk/support flags should drive “Next Steps”, add or adjust rules in HairNutritionCalculator.mappings.json.

Notes & Caveats
This calculator is guidance, not medical advice. It is designed for household planning, meal ideas, and storehouse stocking—not diagnosis or treatment.

Keep risk flags and support notes clear and gentle, avoiding clinical claims.

Always favor food-first strategies in next-step mappings; supplement-related categories should be optional and clearly labeled.

Quick Reference
Node ID: health.hairNutritionCalculator

Next Steps Node ID: health.hairNutritionCalculator.nextSteps

Primary events:

calculator.hairNutrition.calculated

calculator.hairNutrition.error

planningGraph.node.hairNutrition.updated

Key “provides”:

dailyHairProteinTarget

hairAminoProfile

hairHealthyFatTargets

hairMicronutrientTargets

hairSupportFlags

blackHairRiskFlags

waterIntakeTargetCups
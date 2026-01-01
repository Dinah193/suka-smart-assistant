Macro Calculator – Local Developer Guide

Path:
src/features/calculators/health/MacroCalculator/

The Macro Calculator is SSA’s central nutrition “engine” for daily macro targets (calories, protein, fat, carbs). It feeds the Meal Planner, Grocery Planner, and Animal Planner via the Planning Graph and eventBus.

This README explains:

What each file does

How the Macro Calculator is wired into SSA

How events flow into sessions and SessionRunner

How to safely extend / customize behavior

1. Files & Responsibilities
1.1 MacroCalculator.config.json

Purpose: Static metadata + defaults + Planning Graph node config.

Declares:

metadata (id, label, domain, route, tags)

defaults (initial input values)

planningGraph node:

nodeId: pg.health.macroCalculator

inputs / outputs

feedsInto (e.g. pg.meals.mealPlanner, pg.storehouse.groceryPlanner, pg.animals.animalPlanner)

graphHints (recommended order, summary fields)

sessionDefaults (domain, titleTemplate, prefs)

Used by:

Planning Graph loader / orchestration layer

Health calculators index / registry

UI components as a default source of labels + node id

If you add new configurable defaults or change routes, update this file first.

1.2 MacroCalculator.schema.json

Purpose: JSON Schema to validate inputs and outputs.

It defines:

input object:

demographics (sex, ageYears, height, weight, bodyFatPercent)

activityLevel, goal

calorieSource + manualCalories

macro strategy (protein, fat, carbs config)

rounding, mealsPerDay, snacksPerDay

healthFlags

ssaIntegration flags

output object:

caloriesPerDay, proteinGramsPerDay, fatGramsPerDay, carbGramsPerDay

optional perMealBreakdown (ref to health.macroPerMeal.schema.json)

optional profileMacroPresetId, warnings[], notes[]

Used by:

Validation layer (wherever you validate calculator payloads)

API/automation boundaries to ensure consistent shapes

If you change shim input/output shape, update this schema to match.

1.3 MacroCalculator.shim.js

Purpose: Pure calculation module (no React / no DOM / no side effects).

Exports:

computeMacroPlan(input, options?)

getMacroTargets(input, options?)

default export: { computeMacroPlan, getMacroTargets }

Key responsibilities:

Convert height/weight units and estimate BMR/TDEE when needed.

Resolve:

Calorie target (manual vs TDEE vs estimated) + goal adjustment.

Protein grams using modes: gPerKg, gPerLb, percentOfCalories, fixedGrams.

Fat grams using modes: percentOfCalories, gPerKg, fixedGrams.

Carb grams using modes: remainder, percentOfCalories, gPerKg, fixedGrams.

Apply healthFlag hints (notes/warnings).

Recompute macro calories, round to configured steps.

Optionally build perMealBreakdown (meals + snacks).

Optionally generate profileMacroPresetId using profileIdSeed.

How it fits SSA:

Used by:

MacroCalculator React UI

Hooks

Any automation node or background process that needs macro targets

Keeps logic testable and reusable outside the UI.

When adding new macro strategies or constraints, extend the resolve helpers in this file.

1.4 MacroCalculator.view.jsx

Purpose: Main React UI component for Macro Calculator.

Responsibilities:

Render a two-panel layout:

Left: form (demographics, activity, goal, calories, meals/snacks, health flags, SSA links)

Right: results (daily macros + per-meal table) with “Use These Macros Now” CTA.

Manage local form state (using defaults mirrored from config).

Optionally auto-recalculate when inputs change (autoRecalc toggle).

Call computeMacroPlan from the shim.

Emit events via eventBus:

health.macroPlan.calculated

health.macroPlan.appliedNow

Event payload example:

{
  input,           // MacroCalculatorInput
  macroPlan,       // MacroCalculatorOutput
  uiContext: {
    autoRecalc: true | false,
    nowClicked: true | undefined,
    appliedFrom: "MacroCalculator",
    source: "MacroCalculator"
  }
}


Integration with SessionRunner:

This view does not directly start SessionRunner.

Instead, it emits events that the automation / Planning Graph layer listens to.

That layer can:

Map health.macroPlan.appliedNow → create a storehouse session.

Open SessionRunner with an “Apply Macro Targets” session blueprint.

If you want to change UI styling, do it here. Avoid adding business logic – keep that in the shim or hooks.

1.5 MacroCalculator.hooks.js

Purpose: Shared hooks to encapsulate macro state + event wiring.

Exports:

MACRO_DEFAULT_INPUT – same defaults as config.

useMacroCalculator(params?) – full-feature hook.

useMacroTargetsOnly(input, options?) – light-weight numeric-only hook.

useMacroCalculator:

Manages:

form state

autoRecalc flag

result (full MacroCalculatorResult)

macroOutput convenience (result.output)

isDirty

Provides helpers:

updateField(field, value)

updateNestedField(path, value) ("height.value", "healthFlags.kidneyIssues", etc.)

toggleGranularity(key)

computeOnce({ emitEvent? })

applyNow()

resetForm()

Automatically emits:

health.macroPlan.calculated on auto-recalc or manual compute.

health.macroPlan.appliedNow when applyNow() is called.

useMacroTargetsOnly:

Calls MacroCalculatorShim.getMacroTargets(input, options) in a useMemo.

Does not emit events.

Ideal for inline calculators, quick insights, or other nodes that just need macros.

Use useMacroCalculator in UI that needs full SSA integration; use useMacroTargetsOnly when you just need numbers and no event traffic.

1.6 MacroCalculator.mappings.json

Purpose: Node-specific “Next Steps” mappings for the Planning Graph.

This file tells SSA:

When a macro plan is applied, what should happen next?

Which session blueprints should be created?

Which nodes they target, and under what conditions?

Key structure:

nodeId: pg.health.macroCalculator

nextSteps.primary:

Macro → Meal Planner session (macro_to_mealPlanner_session)

Macro → Grocery Planner session (macro_to_groceryPlanner_session)

nextSteps.secondary:

Macro → Animal Planner session (macro_to_animalPlanner_session)

Macro → Micronutrient Calculator navigation (macro_to_micronutrient_calculator)

Each mapping contains:

trigger.event (e.g. health.macroPlan.appliedNow)

trigger.conditions (e.g. ssaIntegration.allowAutoLinkToMealPlanner === true)

target info (nodeId, domain, route, routeAnchor)

sessionBlueprint (for kind: "sessionBlueprint" entries)

This is where you define how SessionRunner will be invoked for macros.

Example: When user clicks “Use These Macros Now”:

MacroCalculator.view calls applyNow().

Hook emits health.macroPlan.appliedNow.

Automation runtime reads MacroCalculator.mappings.json.

It finds macro_to_mealPlanner_session + others.

It picks “best” next step (or shows a selector using uiHints.selectorModal).

It:

Instantiates a session matching the blueprint.

Stores it in Dexie.

Sends it into SessionRunner.

2. Event Flow & SessionRunner
2.1 Calculation Flow

User edits form → macro calculator recomputes (if autoRecalc).

Hook/view emits health.macroPlan.calculated.

Anything in SSA listening to this event can:

Update dashboard cards.

Pre-fill Meal Planner suggestions.

Show hints (“Macro plan ready – build meals now”).

2.2 “Now” Flow → Sessions

User clicks “Use These Macros Now”.

Hook emits health.macroPlan.appliedNow.

Automation engine:

Reads MacroCalculator.mappings.json.

Filters nextSteps.primary / secondary where:

trigger.event === "health.macroPlan.appliedNow".

conditions pass against the event payload (input, macroPlan, uiContext).

For matched sessionBlueprint entries:

Build a session object using:

sessionBlueprint.idTemplate

domain, titleTemplate

source info

steps[] matching the global session contract

prefs

Save to Dexie sessions store.

Emit session.started when SessionRunner begins.

Optionally show a Next Steps selector modal based on uiHints.

The Macro Calculator itself doesn’t know SessionRunner exists – it just emits clean events.

3. How to Extend the Macro Calculator
3.1 Add a New Macro Strategy (e.g. “keto”)

Schema (MacroCalculator.schema.json):

Extend macroStrategy.enum with "keto".

Shim (MacroCalculator.shim.js):

In resolveProtein, resolveFat, resolveCarbs, adjust logic so when input.macroStrategy === "keto", you set:

Higher fat percentage.

Very low carbs.

Reasonable protein.

UI (MacroCalculator.view.jsx & hooks defaults):

Add "keto" to the strategy selector (if you expose it).

Optionally set new defaults in MACRO_DEFAULT_INPUT.

Optional: Add a new mapping if you want a keto-specific path (e.g., a “Keto Recipe Finder” node).

3.2 Add More Health Flags

Schema:

Add new flags under healthFlags in MacroCalculator.schema.json.

Defaults:

Add matching fields in MACRO_DEFAULT_INPUT.healthFlags.

Shim:

Update applyHealthFlagHints(input, grams) to add appropriate notes/warnings or adjust grams.

UI:

Add new checkboxes in the “Health Context” section.

3.3 Change How Per-Meal Distribution Works

Current behavior:

Equal split of macros across mealsPerDay + snacksPerDay.

To customize:

Modify buildPerMealBreakdown() in MacroCalculator.shim.js:

Use weighted distributions (e.g., bigger breakfast, smaller dinner).

Respect user preferences (e.g., “protein-heavy first meal”).

Update MacroCalculator.schema.json if you introduce new options in input to control distribution (like mealWeights[]).

3.4 Add a New Next Step Node

Example: a “Recipe Suggestions” node.

Add a new entry to MacroCalculator.mappings.json under secondary:

kind: "navigation" or "sessionBlueprint".

trigger.event: "health.macroPlan.appliedNow" or "health.macroPlan.calculated".

target.nodeId: e.g. pg.meals.recipeSuggestions.

Route/anchor pointing to your new feature.

Implement the target node UI / logic to read the macroPlan from event payload or from a shared store.

4. Integration Points & Gotchas

Do not import React or browser APIs into MacroCalculator.shim.js. Keep it pure.

Use hooks in React components, but keep cross-feature orchestration in:

eventBus listeners

Planning Graph runtime

Session/Automation layer

When changing input shapes:

Update schema

Update defaults in hooks and/or config

Check any code using useMacroTargetsOnly to ensure it passes required fields.

5. Quick Usage Examples
5.1 From a React Page (full integration)
import React from "react";
import MacroCalculatorView from "./MacroCalculator.view";

export default function HealthMacrosPage() {
  return (
    <div className="p-4 sm:p-6">
      <MacroCalculatorView />
    </div>
  );
}

5.2 From Another Calculator (numeric only)
import { useMacroTargetsOnly } from "./MacroCalculator.hooks";

function SomeOtherHealthWidget({ profile }) {
  const { calories, protein, fat, carbs } = useMacroTargetsOnly({
    // map your profile into MacroCalculatorInput here
    ...profile
  });

  // Use calories/protein/fat/carbs locally
}

5.3 From Automation (no React)
import MacroCalculatorShim from "./MacroCalculator.shim";

function buildMacroPlanForUser(profile, tdee) {
  const { computeMacroPlan } = MacroCalculatorShim;

  const { output } = computeMacroPlan(
    {
      // Construct MacroCalculatorInput from profile
      ...profile.macroInput
    },
    { tdee, profileIdSeed: profile.id }
  );

  return output; // caloriesPerDay, proteinGramsPerDay, etc.
}

6. Where SessionRunner Comes In

The Macro Calculator itself is session-agnostic. SessionRunner integration happens via:

Events:

health.macroPlan.calculated

health.macroPlan.appliedNow

Mappings (MacroCalculator.mappings.json) that:

Translate those events into session blueprints.

Pass those blueprints into the Session/Automation runtime.

Session/Automation runtime then:

Creates session objects in Dexie.

Opens the global SessionRunner modal (mounted at app root).

Handles wake lock, notifications, PiP, guards, analytics, and Hub exports.

When you’re wiring new domains or flows, try to keep this same pattern:

Feature → emits semantic events → mappings → runtime → SessionRunner

so each feature stays decoupled and reusable.
# BMI Calculator – Suka Smart Assistant (SSA)

**Path:**  
`src/features/calculators/health/BMICalculator`

The BMI Calculator is a small, self-contained health utility that feeds context into the broader SSA Planning Graph (macros, BMR/TDEE, meals, activity planning, etc.). It uses **pure calculation logic (shim)**, **React UI**, **hooks**, and a **Planning Graph mappings file** to integrate cleanly with everything else.

This README explains:

- Folder structure & responsibilities
- Data contracts (inputs/outputs)
- Events emitted into SSA
- How Planning Graph & “Now” actions use BMI
- How to extend or plug into other modules

---

## 1. Files & Responsibilities

| File                                 | Purpose                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `BMICalculator.config.json`          | Node metadata for Planning Graph: labels, id, tags, and defaults.                                                          |
| `BMICalculator.schema.json`          | JSON Schema describing valid inputs/outputs (height, weight, BMI, category, etc.).                                         |
| `BMICalculator.shim.js`              | Pure, side-effect-free BMI calculation logic. No React, no Dexie, no eventBus.                                             |
| `BMICalculator.view.jsx`             | React UI component: full page/form that renders BMI inputs & results and emits UI-level events.                            |
| `BMICalculator.hooks.js`             | Reusable React hooks for BMI form state, computation, and SSA events.                                                      |
| `BMICalculator.mappings.json`        | Planning Graph “Next Steps” + module suggestions + feeds-into mappings (which calculators & modules to suggest after BMI). |
| `BMICalculator.mappings.schema.json` | JSON Schema to validate the mappings file and keep VS Code happy.                                                          |
| `README.md`                          | You are here – local documentation and integration notes.                                                                  |

---

## 2. Core Concepts

### 2.1 Shim-first design

All calculation logic lives in **`BMICalculator.shim.js`**, which exposes:

- `computeBMI(input)` → `{ input, output, meta }`
- `getBMIOnly(input)` → `{ bmi, category, categoryLabel }`

The shim:

- Accepts a **JSON-compatible input** structure aligned with `BMICalculator.schema.json`.
- Does **unit normalization** (lb/kg, in/cm → kg/m²).
- Resolves **BMI category** from predefined thresholds.
- Computes a **recommended weight range** (BMI 18.5–24.9) in the user’s preferred unit.
- Returns warnings & notes for SSA UI (e.g., BMI limitations, age/sex caveats).

No side effects. This makes it safe for:

- Browser UI components
- Planning Graph engines
- Automation runtime
- Tests, workers, and offline usage

### 2.2 Hooks and view layering

- **`BMICalculator.hooks.js`** provides the main hook:

  ```js
  const {
    form,
    result,
    bmiOutput,
    autoRecalc,
    isDirty,
    setForm,
    setAutoRecalc,
    updateField,
    updateNestedField,
    resetForm,
    computeOnce,
    applyNow
  } = useBMICalculator();
  It manages:
  ```

Form state (height, weight, sex, age, unitSystem, rounding)

Auto-recalc behavior

Calls into the shim to compute BMI

Emits SSA events (via eventBus) when enabled

BMICalculator.view.jsx is a ready-to-use UI:

Renders inputs for height, weight, sex, age, units, decimals.

Shows BMI result, category, and recommended weight range.

Displays warnings & notes from shim output.

Includes a “Use BMI in Plans” button → triggers health.bmi.appliedNow event.

You can use the hook in any other UI shell if you want a compact or alternative layout.

3. Data Contracts
   3.1 Input – BMICalculatorInput
   Defined in BMICalculator.schema.json and mirrored in the shim:

ts
Copy code
type BMIHeight = {
value: number;
unit: "in" | "cm";
};

type BMIWeight = {
value: number;
unit: "lb" | "kg";
};

type BMIRoundingPreferences = {
bmiDecimals?: number;
weightDecimals?: number;
};

type BMISSAIntegrationHints = {
autosaveProfile?: boolean;
allowLinkToMacroCalculator?: boolean;
};

type BMICalculatorInput = {
height: BMIHeight;
weight: BMIWeight;
sex?: "female" | "male" | "other" | "unspecified";
ageYears?: number;
unitSystem?: "imperial" | "metric" | "mixed";
rounding?: BMIRoundingPreferences;
ssaIntegration?: BMISSAIntegrationHints;
};
The shim does a normalization pass so callers can safely pass strings for numeric fields (e.g., from <input> values).

3.2 Output – BMICalculatorOutput
ts
Copy code
type RecommendedWeightRange = {
min: number;
max: number;
unit: "lb" | "kg";
};

type BMICalculatorOutput = {
bmi: number;
category: string;
categoryLabel?: string;
recommendedWeightRange?: RecommendedWeightRange;
warnings?: string[];
notes?: string[];
};

type BMICalculatorMeta = {
calculatorId?: string;
nodeId?: "pg.health.bmiCalculator";
generatedAt?: string; // ISO timestamp
};
The full result from computeBMI:

ts
Copy code
type BMICalculatorResult = {
input: BMICalculatorInput;
output: BMICalculatorOutput;
meta: BMICalculatorMeta;
}; 4. Events & SSA Integration
BMI components do not talk directly to SessionRunner, Dexie, or the Hub.
Instead, they emit events that other layers can subscribe to.

4.1 Event bus contract
All events use src/services/events/eventBus.js with:

js
Copy code
emit({
type, // string
ts, // ISO timestamp
source, // module name or path
data // payload
});
4.2 Events emitted
From BMICalculator.view.jsx and BMICalculator.hooks.js:

health.bmi.calculated

Emitted whenever BMI is (re)computed.

Payload:

js
Copy code
{
input: BMICalculatorInput,
output: BMICalculatorOutput,
uiContext: {
autoRecalc: boolean,
source: "BMICalculator" | "BMICalculator.hook"
}
}
health.bmi.appliedNow

Emitted when the user clicks “Use BMI in Plans” or calls applyNow() in the hook.

Payload:

js
Copy code
{
input: BMICalculatorInput,
output: BMICalculatorOutput,
uiContext: {
nowClicked: true,
source: "BMICalculator" | "BMICalculator.hook",
computedJustInTime?: boolean
}
}
The Planning Graph listener or Health Orchestrator can treat health.bmi.appliedNow as a signal to open a Next Steps modal, start macro planning, or prefill health goals — without BMI needing to know about SessionRunner.

5. Planning Graph Integration
   5.1 Config metadata – BMICalculator.config.json
   This file declares:

Node id (pg.health.bmiCalculator)

Human labels & tags

Default input values (height, weight, unit system)

Which Planning Graph domain it belongs to (health)

This keeps the BMI node discoverable from:

Health dashboard

Planning Graph visualizations

Health wizard / onboarding flows

5.2 Next Steps & module mappings – BMICalculator.mappings.json
This file configures:

nextSteps: which calculators to suggest next (BMR, TDEE, macros, micronutrients, hydration, ideal weight).

suggestedModules: non-calculator modules (meal planner, exercise planner, goals, trackers).

feedsInto: how BMI outputs feed fields on other nodes (e.g., macros, meals, exercise).

conditions: like bmiOutsideNormal to show specific recommendations only for certain BMI categories.

ui hints: header text & whether to show a “Now” button.

Example snippet (simplified):

json
Copy code
{
"calculatorId": "health.bmi",
"version": "1.0.0",
"nextSteps": [
{
"id": "health.macros",
"label": "Generate Daily Macronutrient Targets",
"reason": "Macros depend on BMI, goal weight, and TDEE.",
"when": "after:tdee",
"tags": ["nutrition", "macros"]
}
],
"ui": {
"showNowButton": true,
"nextStepsHeader": "Recommended Next Steps",
"suggestedModulesHeader": "Helpful Modules to Continue"
}
}
The Planning Graph engine reads this and renders appropriate buttons/cards in your “What’s next?” UI.

6. Usage Examples
   6.1 Use the main view in a route
   jsx
   Copy code
   // src/pages/health/BMICalculatorPage.jsx
   import React from "react";
   import BMICalculatorView from "@/features/calculators/health/BMICalculator/BMICalculator.view";

const BMICalculatorPage = () => {
return (
<div className="h-full w-full">
<BMICalculatorView />
</div>
);
};

export default BMICalculatorPage;
6.2 Use the hook in a custom card
jsx
Copy code
import React from "react";
import { useBMICalculator } from "@/features/calculators/health/BMICalculator/BMICalculator.hooks";

const QuickBMIWidget = () => {
const { form, bmiOutput, updateNestedField, computeOnce } = useBMICalculator({
autoRecalcDefault: false
});

return (
<div>
<input
type="number"
value={form.height.value}
onChange={(e) => updateNestedField("height.value", e.target.value)}
/>
<input
type="number"
value={form.weight.value}
onChange={(e) => updateNestedField("weight.value", e.target.value)}
/>
<button type="button" onClick={() => computeOnce()}>
Compute BMI
</button>
<div>BMI: {bmiOutput?.bmi ?? "—"}</div>
</div>
);
};

export default QuickBMIWidget;
6.3 Use the shim in a worker or automation
js
Copy code
// healthAutomationWorker.js
import BMICalculatorShim from "@/features/calculators/health/BMICalculator/BMICalculator.shim";

function evaluateProfile(profile) {
const res = BMICalculatorShim.computeBMI(profile.bmiInput);
if (res.output.category === "obeseClass2" || res.output.category === "obeseClass3") {
// Flag for high-priority nutritional planning
}
} 7. Extending the BMI Calculator
7.1 Add new categories or threshold tweaks
Edit BMI_CATEGORY_THRESHOLDS in BMICalculator.shim.js.
You can:

Adjust cutoffs

Rename labels

Add additional categories (e.g., athlete-specific ranges)

Just keep the structure: { max, key, label }.

7.2 Change default inputs
Update defaults in:

BMICalculator.config.json (for Planning Graph + Health dashboards)

BMI_DEFAULT_INPUT in BMICalculator.hooks.js

The initial state in BMICalculator.view.jsx (if you want it to match exactly)

7.3 Wire additional “Next Steps”
Extend BMICalculator.mappings.json:

Add new calculators, e.g. "health.restingHeartRate".

Add new modules, e.g. "health.bloodworkTracker".

Use conditions to show them only for certain BMI ranges.

8. Notes & Gotchas
   No direct SessionRunner integration: BMI does not spawn sessions itself. It only emits events and mappings that other layers use.

Schema validation: BMICalculator.mappings.schema.json is referenced from the mappings file; make sure the path and filename are correct (VS Code uses this for hints).

Unit consistency: All internal calculations use kg and meters; conversion happens at the edges.

If you add more health calculators (e.g., Waist-to-Hip ratio, Body Fat %, VO2 max), consider following this same pattern:

\*.config.json

\*.schema.json

\*.shim.js

\*.view.jsx

\*.hooks.js

\*.mappings.json

…so that SSA’s Planning Graph can orchestrate them as a coherent health pipeline

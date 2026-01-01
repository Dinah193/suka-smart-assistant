# RecipeScalingCalculator

**Path:**  
`src/features/calculators/storehouseMeals/RecipeScalingCalculator/`

**Role in SSA:**  
The `RecipeScalingCalculator` is a Planning Graph node + shim pair that **scales ingredient quantities** safely and precisely for any recipe in Suka Smart Assistant (SSA). It converts “I have this recipe for 4 people, but I need 10 servings” into a clean, structured, and **session-ready** scaled recipe that can flow directly into:

- **BatchYieldCalculator** (How many portions/containers will this make?)
- **FreezerSpaceCalculator** (Is there enough freezer space for this batch?)
- **SessionRunner** cooking sessions (Turn the scaled recipe into a real-time guided cook.)

This calculator is designed to be **background-friendly** and **idempotent**, so SSA can keep using the scaled result even if the user navigates away and comes back later.

---

## 1. What this node does

At a high level:

1. **Accepts inputs**:  
   - Original servings (or yield)  
   - Target servings **or** a scale factor  
   - A list of recipe ingredients with structured quantities/units

2. **Computes a scale factor**:  
   - `scaleFactor = targetServings / originalServings`  
   - or uses a user-provided scale factor directly

3. **Applies scaling rules**:  
   - Multiplies numeric quantities by the scale factor  
   - Handles fractional amounts safely  
   - Preserves units and ingredient names  
   - Adds warnings for potentially unsafe or tricky scaling (e.g., salt, yeast, baking powder)

4. **Outputs a scaled recipe object** ready to:
   - show in UI (`RecipeScalingCalculator.view.jsx`)
   - feed into batch yield, freezer, inventory, and session composition flows
   - be persisted for later use in Dexie / storehouse planning

---

## 2. Files in this feature

- **`RecipeScalingCalculator.config.json`**  
  Node configuration for the Planning Graph:
  - `nodeId`, `label`, `description`
  - `feedsInto` (BatchYield, FreezerSpace, SessionRunner)
  - UI hints and Planner category metadata

- **`RecipeScalingCalculator.schema.json`**  
  JSON Schema describing input and output payloads:
  - Inputs: `recipeId`, `originalServings`, `targetServings`, `scaleFactor`, `ingredients[]`
  - Output: `scaledIngredients[]`, `computedScaleFactor`, `warnings[]`, `metadata`

- **`RecipeScalingCalculator.shim.js`**  
  The **shim logic**:
  - Validates input against the schema
  - Computes scale factor (or verifies a given one)
  - Scales ingredient quantities
  - Emits events via `eventBus`
  - Returns a structured `{ scaledRecipe, analytics }` payload

- **`RecipeScalingCalculator.view.jsx`**  
  React UI for:
  - Selecting source recipe and specifying target servings or scale factor
  - Previewing scaled ingredient quantities
  - Triggering “Next steps” (Batch yield, Freezer, SessionRunner)

- **`RecipeScalingCalculator.hooks.js`**  
  React hooks to:
  - Tie scaling logic into SSA state (Dexie, context, or Redux if present)
  - Connect with BatchYield and freezer flows
  - Emit relevant planning events

- **`RecipeScalingCalculator.mappings.json`**  
  Planning Graph **Next Steps**:
  - Default next nodes: `calculator.batchYield`, `calculator.freezerSpace`
  - Conditional mappings (e.g. large/small scale factors)
  - Event shapes for `planningGraph.edge.followed`

- **`README.md`** (this file)  
  Human docs for how to use and integrate this node.

---

## 3. Data model overview

The **schema** (see `RecipeScalingCalculator.schema.json`) formalizes:

### 3.1 Core inputs

- `recipeId: string | null`  
  Optional reference to a recipe in SSA.

- `originalServings: number`  
  How many servings the recipe currently makes.

- `targetServings: number`  
  How many servings the user wants (if present, this is the primary driver).

- `scaleFactor: number | null`  
  Optional explicit scale factor. If `targetServings` is given, the shim will **compute** the effective factor and may ignore a conflicting manual factor.

- `ingredients: Ingredient[]`  
  Each ingredient:

  ```ts
  {
    id: string;
    name: string;
    unit: "g" | "kg" | "oz" | "lb" | "ml" | "l" | "cup" | "tbsp" | "tsp" | "piece" | string;
    quantity: number;
    notes?: string;         // e.g. "packed", "room temp", "heaping"
    category?: string;      // e.g. "salt", "yeast", "spice"
    scaleSensitivity?:
      | "normal"
      | "reduced"
      | "nonlinear";        // helps shim add warnings or adjust scaling
  }
3.2 Core outputs
computedScaleFactor: number
The final factor used after validation.

scaledIngredients: Ingredient[]
Same shape as input, but with scaled quantity and optional notes for rounding.

warnings: string[]
e.g.:

“Salt was scaled 4x; taste as you go.”

“Yeast scaled nonlinearly; consider 1.5–2x instead of 3x.”

metadata

sourceRecipeId

originalServings

targetServings

createdAt (ISO)

updatedAt (ISO)

4. Shim behavior & events
The shim is written in RecipeScalingCalculator.shim.js and follows SSA’s shim module design:

4.1 Core function
The main export is a pure-ish function like:

ts
Copy code
async function runRecipeScalingShim(input, options?): Promise<ScalingResult>
Responsibilities:

Validate input (schema check)

Decide computedScaleFactor

Scale ingredients

Attach warnings & analytics

Optionally persist to Dexie (if provided via options)

Emit events on the SSA eventBus

4.2 Event emission
Typical events include:

calculator.scaling.invoked
When the shim starts with input.

calculator.scaling.completed
On success, with payload matching the shape described in RecipeScalingCalculator.mappings.json (onComplete).

calculator.scaling.failed
If there is a validation or runtime error.

Each event uses the standard SSA payload shape:

js
Copy code
emit({
  type: "calculator.scaling.completed",
  ts: new Date().toISOString(),
  source: "features/calculators/storehouseMeals/RecipeScalingCalculator",
  data: { /* safe, structured payload */ }
});
5. UI & Planner integration
5.1 UI (view.jsx)
The UI is designed to be:

Simple default path:

Select recipe → enter desired servings → click “Scale Recipe”

Advanced mode:

Directly enter a scale factor (e.g. 0.5x, 1.5x, 3x)

Show a table with original and new quantities side-by-side

After scaling, the UI exposes:

Primary action:
“Estimate Batch Yield” → loads BatchYieldCalculator.view with computed scaledIngredients and computedScaleFactor.

Secondary action:
“Check Freezer Space” → loads FreezerSpaceCalculator (if present).

Optional action:
“Start Cooking Session Now” → builds a SessionRunner cooking session using the scaled recipe (via Planning Graph or direct session composition shim).

5.2 Planning Graph
RecipeScalingCalculator.config.json and RecipeScalingCalculator.mappings.json together let the Planning Graph:

Show Recipe Scaling as a node in the “Storehouse Meals / Planning” path

Route data automatically into:

calculator.batchYield

calculator.freezerSpace

other future nodes (e.g. label printing, grocery list generation)

Emit planningGraph.edge.followed events when Next Steps are chosen

This makes Recipe Scaling a hub node for many downstream flows.

6. Relationship to other Storehouse Meals calculators
RecipeScalingCalculator works closely with:

BatchYieldCalculator

Uses the scaled quantities to estimate:

total portions

containers

prep/cook time

Perfect for planning a weekend batch cook.

FreezerSpaceCalculator (or equivalent)

Uses the yield and container choices to check:

required freezer volume

shelf allocation

recommended defrost schedule

MovementIntensityCalculator (indirect)

Large batch sessions may be turned into movement sessions that count toward daily activity.

Hair & Health Calculators (indirect)

Scaled recipes feed into nutrition metrics used by:

HairNutritionCalculator

Other health calculators (macro, micronutrient, movement)

7. Background & resilience expectations
The shim is built to cooperate with SSA’s background-friendly architecture:

Scaling itself is cheap and synchronous, but:

Results can be stored in Dexie so the Planning Graph can reuse them without recomputing.

SessionRunner can pick up scaled recipes later if the user starts a cooking session.

If the app reloads:

The scaled output remains in Dexie (or an SSA store) and can be re-used.

A failed or partial run should not break other calculators; they should see missing or invalid data and handle it gracefully.

8. How to use in code (summary)
In a UI component or another feature, the typical flow is:

Gather or load the recipe and servings.

Call the shim:

js
Copy code
import { runRecipeScalingShim } from "./RecipeScalingCalculator.shim";

const result = await runRecipeScalingShim({
  recipeId,
  originalServings,
  targetServings,
  scaleFactor: null,
  ingredients
});

// result.scaledIngredients, result.computedScaleFactor, result.warnings
Pass result into:

BatchYieldCalculator

Freezer tools

Cooking Session composition logic

Let the Planning Graph and *.mappings.json handle the “Next steps” suggestions.

9. Extensibility notes
You can extend this calculator by:

Adding more scaleSensitivity categories:

e.g. "maxLimit" for spices that should never exceed a specific quantity.

Supporting multi-component recipes:

e.g. dough + filling + topping sections.

Integrating with:

Price calculators (cost per serving for scaled recipes)

Nutrition calculators (macro/micronutrient updates after scaling)

HairNutritionCalculator (e.g. highlight recipes that are great for Black hair health)

Keep those enhancements inside the shim or in separate, clearly named helper modules to keep this feature focused and maintainable.

10. Quick mental model
RecipeScalingCalculator takes a recipe and target yield, scales it safely, emits structured events, and hands the result to storehouse/batch/freezer flows. It’s the bridge between “What do I want to cook?” and “How big should this cook be so my storehouse, freezer, and health goals stay on track?”.
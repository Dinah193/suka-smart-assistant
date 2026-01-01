# CostPerServingCalculator

CostPerServingCalculator is a storehouse‐focused SSA calculator that:

- Normalizes **price + quantity** into a common unit
- Computes **cost per serving**
- Computes **hair-supportive nutrient value per dollar** (for Black hair nutrition)
- Surfaces **budget-friendly + hair-friendly** items and recipes
- Feeds those insights into the **Planning Graph** (meal planning, refills, garden planning, shopping, etc.)

This README documents the **methodology**, **data contracts**, and **integration points** for the calculator and its SessionRunner-aware modal.

---

## 1. How this fits into SSA & the Planning Graph

**Node key:** `costPerServingCalculator`  
**Domain:** `storehouse`  
**Primary purpose:** Turn raw prices into **actionable planning intelligence**.

The calculator participates in the Planning Graph via:

- `CostPerServingCalculator.config.json`  
  Links this node into the Planning Graph, declares node key, supported inputs/outputs, and UI metadata for the calculators hub.

- `CostPerServingCalculator.schema.json`  
  JSON Schema for **input** (prices, units, serving sizes) and **output** (cost per serving, hair nutrient score per dollar, flags).

- `CostPerServingCalculator.shim.js`  
  Pure logic module (SSA “shim”) that:
  - Validates inputs (against schema)
  - Performs cost & nutrient calculations
  - Emits events via `eventBus`
  - Is safe to run in background / SessionRunner

- `CostPerServingCalculator.view.jsx`  
  React UI that renders:
  - A SessionRunner-style modal
  - Item list + charts for unit/serving cost comparisons
  - Actions that trigger **next steps** (batch cooking, refills, garden, shopping, etc.)

- `CostPerServingCalculator.hooks.json`  
  Declarative description of how the calculator **plugs into** storehouse + meal planning flows (e.g., “use latest inventory snapshot”, “update storehouse item metrics”).

- `CostPerServingCalculator.hooks.js`  
  React hooks that:
  - Attach calculator outputs to inventory + planning state
  - Listen/emit events (`calculator.costPerServing.completed`, etc.)
  - Wire results into storehouse, shopping lists, and Black Hair Nutrition calculator

- `CostPerServingCalculator.mappings.json`  
  “Next Steps” mappings defining what users can do with results:
  - Optimize recipes for budget
  - Choose best refill options
  - Schedule batch cooking
  - Send choices to shopping list
  - Plan garden for expensive staples
  - Refine by Black hair nutrition value

---

## 2. Input model & assumptions

Inputs adhere to `CostPerServingCalculator.schema.json`. At a high level:

```ts
type CostPerServingInputItem = {
  id: string;
  name: string;

  // Pricing
  priceTotal: number;            // e.g., 5.99
  currency?: string;             // 'USD' by default

  // Package size
  quantity: number;              // e.g., 907
  unit: 'g' | 'kg' | 'oz' | 'lb' | 'ml' | 'l' | 'fl_oz' | 'count';

  // Serving info
  servingsPerPackage?: number;   // optional; overrides servingSize if provided
  servingSize?: {
    amount: number;
    unit: 'g' | 'oz' | 'ml' | 'fl_oz' | 'count';
  };

  // Nutrient data (per serving or per 100g; specified in schema)
  hairNutrientProfile?: {
    basis: 'perServing' | 'per100g';
    nutrients: {
      protein?: number;
      iron?: number;
      zinc?: number;
      vitaminA?: number;
      vitaminD?: number;
      vitaminE?: number;
      vitaminC?: number;
      bComplexGroup?: number;
      omega3?: number;
      omega6?: number;
      biotin?: number;
      // extensible for additional nutrients
    };
  };

  // Optional context
  category?: string;             // 'protein', 'grain', 'oil', 'vegetable', 'fruit', etc.
  source?: 'inventory' | 'pricebook' | 'manual';
};
Key assumptions:

Price is for the whole package (priceTotal).

Quantity + unit describe the entire package (e.g., quantity: 907, unit: 'g').

If servingsPerPackage is present, it takes precedence over serving size calculations.

If hairNutrientProfile is missing, hair-value scores default to 0 (item is not penalized, just not prioritized for hair nutrition).

Unknown or invalid units are skipped with warnings; they do not crash the calculator.

3. Core calculations
3.1 Unit normalization
To compare items fairly, everything is normalized to consistent base units:

Mass: g

kg → g (× 1000)

lb → g (× 453.592)

oz → g (× 28.3495)

Volume: ml

l → ml (× 1000)

fl_oz → ml (× 29.5735)

Count: count remains as-is.

Internal helper (conceptual):

js
Copy code
const normalizedQuantity = normalizeUnit(quantity, unit);
// returns { amount: number, baseUnit: 'g' | 'ml' | 'count' }
If normalization fails (missing or unsupported unit):

The item is marked with status: 'invalidUnit'.

It is excluded from cost comparisons, and a warning is logged/emitted.

3.2 Cost per base unit
text
Copy code
costPerBaseUnit = priceTotal / normalizedQuantity.amount
This gives:

costPerGram if baseUnit === 'g'

costPerMl if baseUnit === 'ml'

costPerItem if baseUnit === 'count'

This value is used internally to derive per‐serving cost.

3.3 Servings per package
Two pathways:

Explicit servings:

text
Copy code
if (servingsPerPackage is present and > 0):
    servings = servingsPerPackage
Derived from serving size:

text
Copy code
normalizedServingSize = normalizeUnit(servingSize.amount, servingSize.unit)

if normalizedServingSize.amount > 0:
    servings = normalizedQuantity.amount / normalizedServingSize.amount
else:
    servings = 1     // conservative default
Edge handling:

If servings <= 0, a fallback value of 1 is used and the item is flagged as status: 'servingsFallback'.

These flags can be rendered in the UI as subtle warnings.

3.4 Cost per serving
text
Copy code
costPerServing = priceTotal / servings
Outputs include:

ts
Copy code
type CostPerServingOutputItem = {
  id: string;
  name: string;

  priceTotal: number;
  servings: number;
  costPerServing: number;            // primary metric
  costPerBaseUnit: number;           // normalized (per g / ml / count)
  baseUnit: 'g' | 'ml' | 'count';

  hairNutrientScorePerDollar?: number;
  hairNutrientScoreRaw?: number;

  status?: ('ok' | 'invalidUnit' | 'servingsFallback' | 'missingPrice')[];
  warnings?: string[];
};
4. Black hair nutrition value per dollar
The calculator supports a secondary metric:

Hair nutrient value per dollar
A weighted score that estimates how much Black hair–supportive nutrition you get per dollar spent.

4.1 Raw hair nutrient score
Internally, the shim computes a raw hair score from the hairNutrientProfile:

text
Copy code
hairScoreRaw =
  w_protein   * protein   +
  w_iron      * iron      +
  w_zinc      * zinc      +
  w_vitaminA  * vitaminA  +
  w_vitaminD  * vitaminD  +
  w_vitaminE  * vitaminE  +
  w_bComplex  * bComplexGroup +
  w_omega3    * omega3    +
  w_omega6    * omega6    +
  w_biotin    * biotin
Where weights (w_*) are defined in the shim as configuration and can be tuned later. Protein, iron, zinc, vitamin D, omega-3s, and biotin typically receive higher weights because of their stronger association with hair growth and retention in Black hair.

The calculator expects these nutrient values on a consistent basis (per serving or per 100g), as declared in hairNutrientProfile.basis. The shim standardizes them to per serving before combining.

If hairNutrientProfile is missing or incomplete:

hairScoreRaw is set to 0.

The item is still fully usable in cost comparisons.

4.2 Hair nutrient value per dollar
text
Copy code
hairNutrientScorePerDollar = hairScoreRaw / priceTotal
Notes:

If priceTotal <= 0, the item is flagged (status: 'missingPrice') and the score defaults to 0.

The UI can sort/filter by this value to highlight “best hair value per dollar” foods.

5. SessionRunner-style modal & UX
Although the visual implementation lives in CostPerServingCalculator.view.jsx, the design goals are:

5.1 Layout (inspired by the SessionRunner modal)
Full-screen overlay with a semi-transparent dark backdrop.

Centered card, rounded corners, but nearly full height to maximize visible data.

Two main columns:

Left: Item list (table or cards) with:

Name, price, quantity

Cost per serving

Hair nutrient score per dollar (with a small badge or bar)

Checkboxes or toggles to select study items (for next steps)

Right: Visual insights panel with:

Bar chart comparing cost per serving

Optional overlay line/bar for hair nutrient value per dollar

Filters (e.g., “Show only pantry staples”, “Show top 10 by hair value per dollar”)

5.2 Top bar
Title: “Cost-per-Serving & Hair Value”

Subtitle / small status line: e.g., “Based on current inventory + selected recipes”

Button group:

Run again (recalculate from latest inventory/price data)

Close (respects SessionRunner state)

Optional domain icon (e.g., storehouse / pantry icon).

5.3 Actions (Next steps)
Buttons or menu items near the bottom/right of the modal wired to CostPerServingCalculator.mappings.json:

“Use in meal plan” → optimizeRecipesForBudget

“Plan refills” → chooseBestRefillOptions

“Batch cook these” → scheduleBatchCooking

“Create shopping list” → sendToShoppingList

“Plan garden” → plantForHighValueItems

“See hair value” → refineByBlackHairNutrition

Each action uses the mapping’s sessionTemplate to open a SessionRunner session, with blockers (inventory, equipment, or weather) as appropriate.

6. Session & event behavior
Even though this is a calculator, SSA treats significant calculations as mini sessions so they can:

Run safely

Resume if the user navigates away

Emit consistent telemetry

6.1 Events emitted (from the shim)
calculator.costPerServing.started

calculator.costPerServing.completed

calculator.costPerServing.error

Optional: calculator.costPerServing.exported (if results are sent to Hub / Family Fund)

All events use the canonical payload:

js
Copy code
emit({
  type: "calculator.costPerServing.completed",
  ts: new Date().toISOString(),
  source: "features/calculators/storehouseMeals/CostPerServingCalculator",
  data: {
    inputSummary,
    resultSummary,
    items: [...],
    errors: [...],
  },
});
6.2 SessionRunner integration
When run inside SessionRunner (e.g., as part of a “Plan storehouse costs” session):

The calculator contributes steps to the session:

“Gather inventory snapshot”

“Run cost-per-serving analysis”

“Choose next actions”

Session checkpoints are written every time:

A calculation completes

The user changes selected items

A “next step” is triggered

This ensures that if the tab reloads or the user navigates elsewhere, SSA can restore:

Selected items

Sorting/filtering state

Which next steps have already been launched

7. Integration with hooks and storehouse
Key behaviors wired via CostPerServingCalculator.hooks.js:

Input sourcing:

Pulls items from inventory, pricebook, or recipe imports.

Optionally filters to visible category (e.g., pantry staples only).

Output syncing:

Writes costPerServing, hairNutrientScorePerDollar, and flags back into:

Storehouse items (for later use in other tools)

Meal planner suggestions

Black Hair Nutrition calculator seed data

Planning Graph hooks:

Raises signals for other nodes (refill calculator, garden planner, grocery list generator).

Provides a typed output payload structure so other calculators can consume results safely.

8. Edge cases & safeguards
The shim and UI are defensive:

Missing prices (priceTotal ≤ 0)

Item flagged as missingPrice; excluded from ranking.

Display subtle warning icon with tooltip.

Unknown / unsupported units

Item flagged as invalidUnit.

Skipped from normalized comparisons.

Optionally shown under a “Needs cleanup” section.

Zero or negative servings

Fallback to servings = 1.

Flag as servingsFallback.

Extremely high or low cost per serving

Values outside reasonable ranges (configurable) can be clipped or marked with a warning.

Missing hair nutrient data

Hair score simply reports 0.

The item is still useful for pure budget analysis.

9. How to use this calculator in the app
From Storehouse / Inventory pages

Use a “Analyze cost per serving” button that:

Collects current inventory items

Calls the shim with standardized input

Opens the modal view with results

From Meal Planner

After selecting recipes, call the calculator with:

Recipe ingredients (with mapped storehouse items or pricebook entries)

Serving counts

Use Next Steps actions to push refined recipes into batch cooking, shopping, or refills.

From Black Hair Nutrition calculator

Use cost results as a filter/sort key:

e.g., “Show me top 10 hair-supportive foods under $X per serving”.

10. Extensibility
You can extend the calculator by:

Adding nutrients to hairNutrientProfile.nutrients and updating the weight configuration.

Supporting new units in the normalization helpers.

Adding new “next steps” to CostPerServingCalculator.mappings.json to connect with future calculators or dashboards.

Adjusting thresholds and warnings (e.g., budget caps, hair nutrient score cutoffs).

Because this module is implemented as a shim:

Logic is UI-agnostic and testable.

It’s safe to run in background processes (Web Worker, Service Worker, or Node-side).

It integrates cleanly with SessionRunner and the wider SSA Planning Graph.

Summary:
CostPerServingCalculator is your central tool for smart, hair-aware budgeting: it translates raw prices and package sizes into clear cost-per-serving and Black hair nutrition per dollar metrics, and then uses SSA’s Planning Graph to help you act on those insights via meal planning, refills, batch cooking, garden planning, and shopping.
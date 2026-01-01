# Storehouse Refill Calculator

**Path**

`src/features/calculators/storehouseMeals/StorehouseRefillCalculator`

**Config / Schema / Shim / View**

- `StorehouseRefillCalculator.config.json` – Planning Graph node config
- `StorehouseRefillCalculator.schema.json` – input/output validation schema
- `StorehouseRefillCalculator.shim.js` – pure-logic refill computation shim
- `StorehouseRefillCalculator.view.jsx` – UI for viewing + adjusting refill suggestions
- `StorehouseRefillCalculator.hooks.js` – hooks that sync refill results with shopping + inventory
- `StorehouseRefillCalculator.mappings.json` – “next steps” mapping (shopping list, garden plan, Black hair nutrition view)

---

## 1. Purpose & Role in SSA

The **Storehouse Refill Calculator** takes:

- Current storehouse inventory levels
- Household planning horizon (days/weeks)
- Consumption patterns (e.g., from batch sessions, recipes, household size)
- Household-specific thresholds and preferences

…and computes **how much of each item should be restocked**, then wires those suggestions into:

- Shopping list builder
- Storehouse shopping sessions (driven by SessionRunner)
- Garden planning (“grow what we always buy”)
- Black Hair Nutrition flows (for items tagged as hair + scalp support)

This node is part of the **Storehouse / Meals** section of the **Planning Graph** and helps answer:

> “What should we restock now, before the storehouse is low or empty—especially for critical and hair-health-related items?”

---

## 2. How It Fits into the Planning Graph

The calculator is represented as a **Planning Graph node**:

- `nodeId`: `storehouseMeals.storehouseRefill`
- Domain: `storehouse`
- Upstream inputs:
  - Inventory snapshots (current quantities, par levels, minimums)
  - Usage/consumption estimates (recipes, sessions, household size)
  - Planning horizon (days/weeks)
  - Tags, including **hair nutrition** tags for Black hair support
- Downstream flows (from `StorehouseRefillCalculator.mappings.json`):
  - `shopping.listBuilder` – create a shopping list
  - `sessions.storehouseShopping` – auto-create a shopping SessionRunner session
  - `garden.planner` – map high-frequency items to candidate crops
  - `health.blackHairNutrition` – open a specialized view for hair-support items

Other calculators this node works closely with:

- **BatchYieldCalculator**: informs how quickly items deplete when doing batch cooking
- **RecipeScalingCalculator**: changes projected consumption when recipes are scaled up/down
- **Freezer Space / Preservation Calculators** (future): ensure that refill plans align with storage capacity

---

## 3. Inputs (Conceptual)

Validated via `StorehouseRefillCalculator.schema.json`.

Common input fields:

- `inventorySnapshot` (array of items)
  - `itemId`
  - `label`
  - `category` (e.g., grains, oils, protein, hairCare, etc.)
  - `currentQty`
  - `uom` (unit of measure)
  - `minQty` (below this is “critical low”)
  - `parQty` (comfortable stock level)
  - `avgDailyUse`
  - `hairTag` (boolean or tag array, for Black hair nutrition items)
  - `priority` (normal, high, critical)
- `planningHorizonDays`  
  How far ahead to plan (e.g., 7, 14, 30, 90).
- `runContext`
  - `householdId`
  - `createdByUserId`
  - `fromSessionId` (if triggered from SessionRunner)
  - `source` (e.g., `"auto" | "manual" | "batchCookingSummary"`)
- `safety` and `preferences`
  - `roundingMode` ("up" | "nearest" | "down")
  - `bufferPercent` (extra %
    to add for safety)
  - `skipLowPriority` (boolean)
  - `onlyHairNutritionItems` (optional mode focused on Black hair support items)

---

## 4. Outputs (Conceptual)

Also enforced by `StorehouseRefillCalculator.schema.json`.

The main output structure:

- `refillLines` (array)
  - `itemId`
  - `label`
  - `category`
  - `currentQty`
  - `minQty`
  - `parQty`
  - `projectedNeedQty` (how much is needed within the horizon)
  - `refillQty` (what SSA recommends to purchase / produce)
  - `uom`
  - `urgency` ("ok" | "planSoon" | "refillNow" | "critical")
  - `hairTag` / `hairNotes` (for Black hair nutrition items)
  - `notes` (human-readable explanation)
- `aggregatedRefillSummary`
  - `totalRefillQty`
  - `itemsCount`
  - `criticalCount`
  - `highPriorityCount`
  - `highFrequencyCount`
  - `hairNutritionCount`
- `hairNutritionSubset`
  - Array of subset lines for items that support hair and scalp health
- `meta`
  - `runContext` (echo)
  - `planningHorizonDays`
  - `calculatorVersion`

---

## 5. How Refill Calculations Are Done (Conceptual Logic)

The actual logic lives in `StorehouseRefillCalculator.shim.js`. In plain language, the shim:

1. **Validates input** against JSON schema  
   Returns an error object or an empty result if the payload is invalid.

2. **Estimates demand** over the planning horizon  
   For each item:

   ```text
   demand = avgDailyUse * planningHorizonDays
If avgDailyUse is missing, conservative fallbacks can be used:

Use historical batch and session analytics if available.

Or treat item as zero-demand unless marked critical.

Adds safety buffer

text
Copy code
demandWithBuffer = demand * (1 + bufferPercent / 100)
Compares to current stock

text
Copy code
projectedEndingQty = currentQty - demandWithBuffer
If projectedEndingQty >= parQty, urgency = "ok" and refillQty = 0.

If projectedEndingQty < parQty but >= minQty, urgency = "planSoon".

If projectedEndingQty < minQty, urgency = "refillNow" or "critical" depending on how far below.

Determines refillQty

Typical formula:

text
Copy code
idealTargetQty = parQty + demandWithBuffer
rawRefillQty = idealTargetQty - currentQty
refillQty = roundingMode === "up" ? ceil(rawRefillQty) : round(rawRefillQty)
Never goes below 0.

Black Hair Nutrition emphasis

For any item tagged for hair/scalp support:

They are included in hairNutritionSubset.

If onlyHairNutritionItems is true, all non-hair items are filtered out.

hairNotes can include cues like:

“This oil supports scalp moisture. Refill before it runs out to protect your protective styles and wash days schedule.”

Generates summary + next-step cues

The shim computes counts and totals used by:

UI to show quick summary banners.

StorehouseRefillCalculator.mappings.json “recommendedWhen” logic (e.g., garden planning only when high-frequency count > 0).

6. How SSA Uses Refill Outputs
The calculator itself does not perform these actions—it only returns structured data. The system around it (hooks + mappings + UI) uses those results to drive flows:

6.1 Shopping List
StorehouseRefillCalculator.hooks.js exposes helper hooks like:

useRefillToShoppingList(refillResult)

useRefillToShoppingSession(refillResult)

These hooks:

Normalize refill lines to shopping-line format.

Write data into the Shopping List store / Dexie tables.

Optionally emit events such as inventory.shortage.detected.

6.2 Sessions (SessionRunner Integration)
When user selects “Shop now”:

The UI calls a hook that:

Creates a storehouse shopping session with steps like:

“Go to pantry and verify quantities for critical items.”

“Add urgent items to in-store or online cart.”

Persist the session with domain: "storehouse".

Emits session.started when SessionRunner opens.

This keeps storehouse refill behavior aligned with the global SessionRunner experience.

6.3 Garden Planning
For high-frequency items (frequently refilled pantry staples):

The planGardenForStaples mapping in StorehouseRefillCalculator.mappings.json sends a subset of items to the garden planner.

This allows SSA to ask:

“Would you like to grow some of the items you’re always buying?”

6.4 Black Hair Nutrition Integration
The hairNutritionSubset output is used by:

health.blackHairNutrition node (via mappings) to:

Show which hair-supportive items are low (oils, collagen sources, leafy greens, etc.).

Align storehouse refills with hair health goals (length retention, breakage prevention, scalp care).

This connects storehouse planning with Black hair nutrition planning so hair goals are never treated as an afterthought.

7. UI Behavior (StorehouseRefillCalculator.view.jsx)
The view is responsible for:

Displaying a summary banner:

Total items needing refill

Critical count

Hair nutrition items count

Presenting a table or list of refill suggestions:

Current vs. target quantities

Urgency badges

Hair icon/marker for hair nutrition items

Allowing user adjustments:

Override refillQty

Skip item

Add notes

Showing Next Steps buttons driven by StorehouseRefillCalculator.mappings.json:

“Create Shopping List”

“Start Shopping Session”

“Plan Garden for Staples”

“Review Black Hair Nutrition Items”

All heavy logic stays in the shim and hooks; the view is mostly presentation + event wiring.

8. Hooks & Event Integration (StorehouseRefillCalculator.hooks.js)
Key responsibilities:

Run the calculator shim with validated inputs.

Save results to Dexie or in-memory planner state.

Emit eventBus events such as:

storehouse.refill.calculated

storehouse.refill.applied

inventory.shortage.detected

Provide small, composable hooks to other features:

useStorehouseRefillCalculator()

useApplyRefillToShoppingList()

useRefillHairNutritionSubset()

Hooks must be UI-agnostic orchestration helpers, not tied to any particular page.

9. Error Handling & Edge Cases
The shim and hooks should handle:

Missing or malformed inventory entries:

Ignore invalid items and collect warnings.

Zero or unknown avgDailyUse:

Either treat as low priority or require user confirmation.

Negative computed quantities:

Clamp to 0 for refillQty.

Extremely large refill amounts:

Mark with warnings so UI can prompt user for confirmation.

Typical behavior:

If input fails schema validation → return { errors: [...] } and do not change any state.

If some lines fail but others succeed → partial output with warnings array in meta.

10. Extension Points
When adding new functionality, you can extend:

Schema (StorehouseRefillCalculator.schema.json)

Additional fields (e.g., costPerUnit, supplier, leadTimeDays).

Shim logic

Cost-aware planning (budget-based refill).

Supplier-specific recommendations (e.g., which store is cheaper).

Mappings

New next steps (e.g., export to FamilyFund Hub in familyFundMode).

Hair Nutrition

More fine-grained hair tags (moisture, proteinSupport, scalpHealth, etc.).

Deeper integration with Black Hair Nutrition calculator.

11. Developer Notes
Keep the shim pure and side-effect free:

No DOM access

No direct Dexie or eventBus access

Accept an input object, return an output object

Use hooks for:

Calling the shim

Persisting results

Emitting events

Use mappings for:

Declaring “what comes next” in a data-driven way rather than hard-coding flows.

If you maintain these separations, the Storehouse Refill Calculator can power:

Standalone screens

Embedded widgets

Automated runs triggered by nightly jobs or session analytics

…without needing architecture changes.
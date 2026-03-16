# BatchYieldCalculator

Config path:  
`src/features/calculators/storehouseMeals/BatchYieldCalculator/`

Planning Graph node id:  
`storehouseMeals.batchYieldCalculator`

---

## 1. What this calculator does

The **Batch Yield Calculator** is the bridge between:

- a **recipe / batch cooking idea**, and
- **practical household planning**: how many meals you’ll get, how long it will take, and how it should flow into **sessions, preservation, freezer planning, and shopping**.

It takes a _single batch plan_ (recipe, scaling, portion targets, containers) and produces a **normalized yield model** that the rest of SSA can use:

- How many **total portions** you’ll get
- How those portions are split across **meal types** (breakfast / lunch / dinner / snacks)
- How they’re distributed across **storage containers / locations**
- A rough **time estimate** that can seed a SessionRunner session

This node is a core piece of the **Planning Graph**, feeding into:

- **SessionRunner** for immediate batch cooking
- **Preservation flows** (canning, freezing, dehydrating, curing)
- **Storehouse / inventory updates**
- **Shopping list generation** when there are shortages

---

## 2. Files in this feature

### 2.1 Config

**`BatchYieldCalculator.config.json`**

- Declares the node as part of the Planning Graph:
  - `nodeId: "storehouseMeals.batchYieldCalculator"`
  - Category: `storehouseMeals`
  - Feature kind: `calculator`
- Wires the calculator into:
  - **Upstream inputs**: recipe scanner, recipe vault, storehouse inventory
  - **Downstream nodes**: SessionRunner, preservation planners, shopping list generator
- Defines **event names** for:
  - Successful calculations: `calculator.batchYield.calculated`
  - Errors: `calculator.batchYield.error`
- Exposes UX metadata:
  - Label, description, icon
  - Whether to show in quick launch
  - Help text for the UI

### 2.2 Schema

**`BatchYieldCalculator.schema.json`**

- JSON Schema contract for **inputs and outputs**.
- **Inputs** (examples):
  - `recipeDefinition` (ingredients, steps, base serving size)
  - `batchScalingTarget` (desired servings, number of pans, etc.)
  - `portioningPreferences` (household portion sizes, kid vs adult, meal types)
  - `containerCatalog` (tray sizes, jars, freezer containers)
- **Outputs** (examples):
  - `batchPortionYield` (portions by meal type and consumer group)
  - `batchContainerPlan` (containers, counts, labels, target storage)
  - `batchInventoryDelta` (ingredients to decrement / finished meals to increment)
  - `batchTimeEstimate` (summary: prep, active, passive time)
- Used for:
  - **Runtime validation** of payloads
  - Keeping calculators and UIs aligned as the system grows

### 2.3 Shim logic

**`BatchYieldCalculator.shim.js`**

- A **pure-ish, stateless shim** that:
  - Accepts **validated input payloads** (which conform to the schema).
  - Computes:
    - Serving counts and scaling factors
    - Portion breakdowns by group (adult / teen / child)
    - Container allocations (e.g., 12× one-cup containers, 3× family pans)
    - Time estimate (from recipe metadata and batch scaling).
  - Produces a **structured result object** matching the schema.
- Emits events through the shared **event bus**:

  - `calculator.batchYield.invoked`
  - `calculator.batchYield.calculated`
  - `calculator.batchYield.error`

- Designed to be safe for:
  - **Background execution** (e.g., worker or SessionRunner-related pipelines)
  - **Idempotent re-runs** (same input → same output)

This shim is entirely focused on **logic & contracts**, not UI.

### 2.4 View component

**`BatchYieldCalculator.view.jsx`**

- React UI for this calculator, typically mounted at a route like:
  - `/storehouse/batch-yield`
- Responsibilities:
  - Simple wizard or form to:
    - Select a **recipe** from the Recipe Vault / Scanner
    - Pick **scaling options** (e.g., 2× recipe, “feed 10 adults + 4 kids”)
    - Set **portion targets** (per day, per week, or per person)
    - Choose **container types** (e.g., pans, jars, freezer bags)
  - Show **results panel**:
    - Total number of portions
    - Breakdown by consumer group / meal type
    - Container plan summary
    - High-level time estimate
  - Provide **Next Step CTAs**:
    - “Start batch cooking session now”
    - “Plan preservation (canning/freezer)”
    - “Generate shopping list to fill gaps”

UI pulls the config and uses the hooks + shim to drive interactions.

### 2.5 Hooks

**`BatchYieldCalculator.hooks.js`**

- React hooks for wiring UI ↔ shim ↔ Planning Graph:

  - `useBatchYieldCalculatorState`
    - Holds form inputs, validation errors, and last results.
  - `useRunBatchYieldCalculator`
    - Calls the shim, handles loading / error states.
    - Emits calculator events via `eventBus`.
  - `useBatchYieldNextSteps`
    - Reads `BatchYieldCalculator.mappings.json` to:
      - Recommend next actions
      - Prepare payloads for SessionRunner, preservation planners, or shopping flows
  - `useBatchYieldToSessionRunner`
    - Builds a **Session object** skeleton from batch yield:
      - Domain: `cooking`
      - Title: e.g., `Batch: {recipeName} x {scale}`
      - Steps: prep, cook, portion, label, store
      - Time estimates per step -> `durationSec`
    - Writes an initial **session record** into Dexie for SessionRunner to pick up.

Designed so any UI (not just this page) can reuse the same logic to launch sessions from computed yield.

### 2.6 Mappings

**`BatchYieldCalculator.mappings.json`**

- Defines how **outputs** from this calculator are fed into other features:

  - **Sessions**
    - `storehouseMeals.batchYieldCalculator.toSessionRunner`
      - Builds a SessionRunner session for immediate execution
  - **Preservation**
    - `storehouseMeals.batchYieldCalculator.toCanning`
    - `storehouseMeals.batchYieldCalculator.toFreezer`
  - **Shopping / Storehouse**
    - `storehouseMeals.batchYieldCalculator.toShoppingList`
      - Minimal inputs: `batchInventoryDelta` → items and quantities
  - **Hub Export**
    - Optional mapping to send a **Batch Plan** into the Family Fund Hub when `familyFundMode` is enabled.

---

## 3. How Batch Yield fits into SSA flows

### 3.1 Upstream: where inputs come from

Typical sources:

- **Recipe Vault / Scanner**
  - Provides `recipeDefinition` + base servings + time metadata.
- **Macro / Nutrition calculators**
  - Provide per-person or per-household **portion targets**.
- **Storehouse inventory**
  - Provides real-time ingredient stock, container catalogs, and location tags.

The Planning Graph ensures these inputs can be wired directly into this node via `provides` / `consumes` fields in configs.

### 3.2 Downstream: what consumes the outputs

Once the calculator runs, the result object can feed:

1. **SessionRunner: Batch Cooking Session**

   - A cooking session is created with steps like:
     - Prep ingredients
     - Cook / combine in large pans / pots
     - Portion into containers
     - Label and assign to storage zones
   - Session is persisted in Dexie; SessionRunner can:
     - Maintain timers
     - Use wake-lock & notifications
     - Survive navigation and tab changes

2. **Preservation planners**

   - `batchContainerPlan` and `batchPortionYield` can:
     - Seed jar sizes and counts for canning
     - Allocate freezer zones and shelves
   - Preservation sessions can be created with their own steps and blockers (e.g., freezer space, jars, lids).

3. **Storehouse & shopping**

   - `batchInventoryDelta` expresses:
     - Ingredients to be consumed
     - Prepared meals to be added
   - This can:
     - Update storehouse inventory
     - Generate a shopping list to fill shortages for the planned batch.

4. **Hub export (when enabled)**

   - A summary of:
     - Recipe, scale, yield, and preservation plan
   - Can be exported to the **Family Fund Hub**, so:
     - Family groups can see “batch cook days”
     - Neighbors / relatives can coordinate joint batches.

---

## 4. Event and SessionRunner integration

### 4.1 Event bus

The shim and hooks emit events via `src/services/events/eventBus.js`:

- On invocation:
  - `calculator.batchYield.invoked`
- On success:
  - `calculator.batchYield.calculated`
- On error:
  - `calculator.batchYield.error`

Each payload follows the project-wide envelope:

```js
{
  type: "calculator.batchYield.calculated",
  ts: new Date().toISOString(),
  source: "features/calculators/storehouseMeals/BatchYieldCalculator",
  data: {
    input,   // original calculator input object
    output   // normalized result from the shim
  }
}
These events can be consumed by:

Automation runtime (to suggest sessions or planners)

Analytics modules (how often batches are planned vs. executed)

4.2 SessionRunner
When the user chooses “Start Batch Session Now”:

useBatchYieldToSessionRunner builds a session skeleton from the batch yield.

A session record is written into Dexie with:

Domain: cooking

Steps: derived from recipe & batch yield

Blockers: inventory, equipment, quiet hours, Sabbath, etc.

SessionRunner is opened with this session:

Timers, steps, notifications, wake-lock, etc.

Checkpoints saved every step / 10 seconds

Auto-resume if the session is still running after a reload

The yield data keeps SessionRunner’s time estimate, portion counts, and label hints aligned with the original plan.

5. Typical user workflow
Choose recipe and scale

User picks “Lasagna” and sets “Feed 8 adults and 4 kids” or selects 2× scaling.

Open Batch Yield Calculator

SSA pulls recipe details and storehouse inventory.

User adjusts portion targets and container options.

Run calculation

Calculator shim computes:

Total servings (e.g., 16 adult-equivalent portions)

Container plan (2 large pans + 8 one-cup portions)

Time estimate (e.g., 30 min prep, 45 min bake, 15 min rest/portion)

Review results and pick next step

Options:

Start a batch cooking session now (SessionRunner)

Plan preservation (e.g., freeze one pan, eat one now)

Generate shopping list for missing ingredients

SessionRunner executes the batch

Steps are guided with timers and cues.

At completion, storehouse and freezer planners can be triggered automatically.

6. Extension points
You can expand the Batch Yield Calculator over time without breaking the contract:

New downstream integrations

E.g., “Share batch event with neighbors” or “Auto-create labels & print job”

More detailed time modeling

Per-step concurrency, oven load, multi-batch overlaps

Domain-specific rules

E.g., yield loss from frying vs. roasting, or liquid reduction for stews

Preference-aware planning

E.g., prioritize shelf-stable batches for households with limited freezer space

The schemas, shim, and mappings are intentionally designed to be:

Explicit — clear inputs and outputs

Composable — easily wired into new calculators, planners, and sessions

Background-friendly — suitable for being run by workers or automation without UI involvement

7. Notes for contributors
Keep JSON files comment-free so they stay valid and VS Code stops complaining.

When adding fields to the schema or config:

Update the shim logic to handle new fields safely.

Maintain backward compatibility where possible.

When adding new next steps to BatchYieldCalculator.mappings.json:

Use stable IDs and keep labels short and action-focused.

If you integrate with the Family Fund Hub:

Use HubPacketFormatter and FamilyFundConnector via the shared helpers.

Only export when familyFundMode is enabled.

This calculator is a key building block in SSA’s Storehouse & Meals planning loop. Treat it as the “bridge brain” between recipes, family needs, and real-world batch work.
```

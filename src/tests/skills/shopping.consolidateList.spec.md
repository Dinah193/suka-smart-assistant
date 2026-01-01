# Shopping — `consolidateList` Skill Spec  
_File: `src/tests/skills/shopping.consolidateList.spec.md`_

These notes define the **expected behavior** of the **Shopping List
Consolidation** skill: `shopping.consolidateList`.

The skill’s job is to take **many fragmented inputs** (recipes, batch
sessions, pantry gaps, store sales, user constraints) and return a **single,
deduplicated, store-aware shopping plan**, ready to be turned into:

- a human-friendly list in the UI (grouped by store & aisle/section), and/or  
- a runnable `Session` (domain: e.g. `"storehouse"` or `"shopping"`) for the
  `SessionRunner` (e.g., "Grocery Run – Aldi & Costco").

The skill itself is **pure** and **declarative**: it does not hit Dexie,
does not emit events, and does not control the SessionRunner.

---

## 1. Role of `shopping.consolidateList`

### 1.1 Purpose

This skill answers:

> “Given my planned meals/batches and what I already have, **what exactly
> should I buy, from where, and in what quantities?**”

Inputs include:

- **Meal plans & batch sessions** (cooking / preservation),
- **Derived needs from cleaning / garden / animals / storehouse** (e.g., vinegar
  for pickling, salt for curing, mason jars, feed, cleaning agents),
- **Current inventory** (to avoid buying duplicates),
- **Optional store and deal info** (pricebook, coupons, store sections),
- **User constraints** (budget, preferred stores, dietary rules, brand
  flexibility, minimum stock thresholds).

Outputs:

- A **normalized shopping plan** grouped by store, section, and item,
  including suggested brand/flex options and notes.
- Optional hints for downstream `Session` steps.

---

## 2. Output Shapes & Contracts

### 2.1 Consolidation Result Shape

Recommend a discriminated union:

```ts
type ShoppingConsolidationResult =
  | { ok: true;  plan: ShoppingPlan; warnings?: ShoppingWarning[]; }
  | { ok: false; error: ShoppingError; warnings?: ShoppingWarning[]; };

type ShoppingPlan = {
  runId: string;                 // unique per run for traceability
  context: {
    profileId?: string | null;   // e.g., "main_household"
    mode: 'normal' | 'stockUp' | 'emergency' | 'budget';
    timestamp: string;           // ISO
    sources: {
      fromMeals: string[];       // meal ids
      fromSessions: string[];    // session ids (cooking, cleaning, etc.)
      fromInventoryCheck?: boolean;
    };
  };

  /** Final, deduplicated, store-aware list entries */
  items: ShoppingLineItem[];

  /** Optional store-level summaries */
  stores?: Array<ShoppingStoreSummary>;
};

type ShoppingLineItem = {
  id: string;                   // stable identifier for UI
  name: string;                 // "Yellow onions" / "All-purpose flour"
  normalizedKey: string;        // "onion_yellow_each", used for deduping

  /** Where to buy this (may be multiple options, but one primary) */
  primaryStoreId?: string | null;
  primaryStoreName?: string | null;
  primarySection?: string | null; // "Produce", "Aisle 3 – Baking", "Meat"

  /** Optional: alternate stores with pricing */
  storeOptions?: Array<{
    storeId: string;
    storeName: string;
    section?: string | null;
    unitPrice?: number | null;   // normalized per-unit price
    unitLabel?: string | null;   // "lb", "each", "oz", etc.
    inStock?: boolean;           // from scans/feeds if available
    tags?: string[];             // e.g. ["sale", "bogo", "coupon"]
  }>;

  /** Quantity to buy (already net of inventory) in normalized units */
  quantity: number;
  unit: string;                  // "each", "lb", "g", "oz", "jar", "roll", etc.

  /** Why this is on the list (for traceability) */
  reasons: Array<{
    kind:
      | 'mealPlan'
      | 'batchCooking'
      | 'preservation'
      | 'cleaningRoutine'
      | 'gardenTask'
      | 'animalCare'
      | 'stockThreshold'
      | 'manual';
    refId?: string | null;       // e.g., recipeId, sessionId
    note?: string;               // e.g., "Lasagna for Sabbath"
  }>;

  /** Dietary / household constraints */
  constraints?: {
    glutenFree?: boolean;
    dairyFree?: boolean;
    kosherStyle?: boolean;
    halalStyle?: boolean;
    avoidPorkDerived?: boolean;
    brandLocked?: boolean;       // true if user insists on brand
  };

  /** Brand / product hints */
  productHint?: {
    brand?: string | null;       // "Azure Standard", "Kirkland"
    description?: string | null; // "Organic AP Flour, unbleached"
    upc?: string | null;
  };

  /** Budget & priority */
  priority: 'mustHave' | 'niceToHave' | 'backfillStock';
  estimatedTotal?: number | null; // quantity * chosen unitPrice if known

  /** Integration hints for Sessions (if converted to a shopping Session) */
  blockers?: Array<'inventory' | 'weather' | 'quietHours' | 'sabbath' | 'equipment'>;
  notes?: string;
};

type ShoppingStoreSummary = {
  storeId: string;
  storeName: string;
  subtotalEstimated?: number | null;
  itemCount: number;
  tags?: string[];              // e.g., ["primary", "warehouse", "discount"]
};

type ShoppingWarning = {
  code: string;                 // "missing_price_data", "no_store_for_item"
  message: string;
  details?: any;
};

type ShoppingError = {
  code: string;                 // "shopping.consolidate.invalidInput", etc.
  message: string;
  details?: any;
};
Test expectations:

For ok: true, plan.items is an array (possibly empty but usually
non-empty).

For ok: false, error.code and error.message MUST be defined and
human-readable.

3. Inputs
3.1 Input Shape
The consolidator receives an input object:

ts
Copy code
type ShoppingConsolidationInput = {
  mealNeeds?: Array<MealNeed>;
  cleaningNeeds?: Array<GenericNeed>;
  gardenNeeds?: Array<GenericNeed>;
  animalNeeds?: Array<GenericNeed>;
  storehouseNeeds?: Array<GenericNeed>;     // jars, lids, salt, etc.
  manualNeeds?: Array<GenericNeed>;         // user typed items

  inventorySnapshot?: InventorySnapshot;    // for subtracting what we already have
  storeCatalog?: StoreCatalogSnapshot;     // optional pricing & sections
  constraints?: ShoppingConstraints;       // budget, stores, dietary, etc.
};
Meal needs & generic needs
ts
Copy code
type MealNeed = {
  itemKey: string;             // "flour_ap", "onion_yellow", etc.
  name: string;
  quantity: number;
  unit: string;                // recipe native units (cups, tbsp, etc.)
  recipeId?: string | null;
  mealId?: string | null;
};

type GenericNeed = {
  itemKey: string;
  name: string;
  quantity: number;
  unit: string;                // "each", "lb", "roll", etc.
  sourceKind:
    | 'cleaningRoutine'
    | 'gardenTask'
    | 'animalCare'
    | 'storehouse'
    | 'manual';
  refId?: string | null;       // optional link to session/routine
};
Inventory snapshot
ts
Copy code
type InventorySnapshot = {
  items: Array<{
    itemKey: string;           // must match mealNeed/genericNeed itemKey
    quantity: number;
    unit: string;              // inventory unit, may differ (e.g., "lb" vs "g")
  }>;
};
Store catalog (optional)
ts
Copy code
type StoreCatalogSnapshot = {
  stores: Array<{
    id: string;
    name: string;
    tags?: string[];           // ["warehouse", "discount", "local"]
    sections?: Array<{
      id: string;
      name: string;            // "Produce", "Aisle 5 - Grains"
    }>;
  }>;
  products: Array<{
    itemKey: string;
    storeId: string;
    sectionId?: string | null;
    unitPrice: number;
    unitLabel: string;         // "lb", "each", "oz", etc.
    brand?: string;
    upc?: string;
    inStock?: boolean;
    tags?: string[];           // ["sale", "bogo", "coupon"]
  }>;
};
Shopping constraints
ts
Copy code
type ShoppingConstraints = {
  preferredStores?: string[];          // store ids in user priority order
  excludedStores?: string[];          // store ids to avoid
  budgetCap?: number | null;          // overall budget in currency
  mustHaveItemKeys?: string[];        // itemKeys that cannot be dropped
  preferSales?: boolean;              // if true, prefer sale items when near tie
  dietary?: {
    glutenFree?: boolean;
    dairyFree?: boolean;
    avoidPorkDerived?: boolean;
  };
};
Test expectations:

If input is missing or mealNeeds & manualNeeds are empty arrays AND no
other needs present → ok: true with empty plan.items.

inventorySnapshot.items and storeCatalog.stores/products default to
empty arrays if absent.

4. Core Behaviors
4.1 Deduplication & Normalization
The consolidator MUST:

Map all MealNeed and GenericNeed inputs into normalized items keyed
by itemKey.

Convert varying units to a normalized base unit where possible
(e.g., cups → lb for flour, multiples of “each”).

Sum quantities per (itemKey) and produce a single ShoppingLineItem for
each.

Test cases:

Duplicate items across meals:

Meal A: 2 cups flour,

Meal B: 1 cup flour,

Inventory: 1 cup flour.

After conversion (e.g., 1 cup flour = 0.25 lb), expect final quantity
equal to net requirement, not double-counted.

Cross-domain duplicates:

Cleaning routine needs vinegar,

Preservation batch also needs vinegar,

Inventory has partial vinegar.

Expect a single line item, with combined reasons.

4.2 Inventory Subtraction
For each normalized item:

Calculate needed = totalPlanned - inventoryEquivalent.

If needed <= 0:

The item may be omitted from plan.items OR included with quantity 0 and
note "Already in stock" (implementation-specific; tests should allow either
if documented).

If needed > 0:

Set ShoppingLineItem.quantity = needed in normalized units.

Test cases:

Inventory fully covers need → item either absent or quantity = 0
with appropriate note.

Inventory partially covers need → item present with reduced quantity.

4.3 Store Assignment & Pricing
If storeCatalog is provided:

For each itemKey:

Find matching products in storeCatalog.products.

Filter out excludedStores, respect preferredStores ranking.

Choose a primary store:

Prefer user’s preferred stores.

Among candidates:

choose lowest unitPrice,

tie-break by preferredStores order.

Populate storeOptions including per-store unitPrice/unitLabel.

Set primarySection using the product’s sectionId → section name, if
available.

Estimate estimatedTotal as quantity * unitPrice, with unit conversion where
feasible.

Test cases:

Single-store availability:

Only Walmart has the item in catalog.

Expect primaryStoreId = walmart, only one storeOptions entry.

Multi-store with preferred store:

Same item at Aldi and Costco.

User preferredStores = ['aldi', 'costco'], similar prices.

Expect Aldi as primary.

Multi-store with cheaper non-preferred:

Preferred store: price 3.00,

Non-preferred store: price 2.50,

preferSales = true.

Expect cheaper store as primary with sale tag.

Missing price data:

No products for an itemKey in catalog.

Expect primaryStoreId null and a warning:

code = 'missing_price_data'.

4.4 Budget Awareness & Prioritization
When constraints.budgetCap is set:

Items must be labeled by priority:

mustHave — essentials: ingredients needed for imminent sessions,
critical cleaning chemicals, animal feed, etc.

backfillStock — long-term stock-ups.

niceToHave — convenience or optional items.

The planner MUST still return full list with priorities, but optional
behavior (for downstream UI) may:

Suggest dropping niceToHave or backfillStock items if estimated total
exceeds budget.

Test notes:

This skill itself should not delete or hide items; it should expose
priority and estimatedTotal so other layers can guide decisions.

Test cases:

Estimated total under budget → no warnings.

Estimated total far above budget:

Expect a warning:

code = 'budget_exceeded' with details including estimatedTotal and
budgetCap.

4.5 Constraints & Product Hints
Dietary and preference constraints (e.g., avoid pork-derived ingredients) should
flow into ShoppingLineItem.constraints and, where possible, influence store
options selection.

Behavior:

If catalog has products with tags indicating restricted ingredients, these
should be excluded when possible.

If only restricted versions exist, planner should:

still return the item, but emit warning:

code = 'constraint_violation_risk'.

Brand-locked cases:

For items explicitly marked as brand-specific (e.g., user only wants
“Azure Standard” flour), constraints.brandLocked = true and
productHint.brand populated.

Planner should not suggest alternate cheaper stores as “primary,” but can
still list them in storeOptions with tags indicating alternative.

4.6 Reasons & Traceability
Each ShoppingLineItem must be able to explain why it exists.

reasons array:

At least one reason per item.

Each reason must have kind, optional refId, and a human-friendly note
where helpful.

Test cases:

An ingredient only appearing in one recipe should have a single reason.

An ingredient shared across 3 recipes and 1 cleaning routine should have
multiple reasons, not merged away.

5. Interop with SessionRunner
While shopping.consolidateList doesn’t create Sessions, its output is designed
so an orchestrator can build e.g. a "shopping" or "storehouse" domain
Session:

ts
Copy code
// Example transformation (not implemented here, just plausible)
const session = {
  id: 'sess_shopping_' + plan.runId,
  domain: 'storehouse',  // or 'shopping' if you define that
  title: 'Grocery Run – ' + summarizeStores(plan),
  source: { type: 'manual', refId: plan.runId },
  steps: plan.items.map((it, idx) => ({
    id: it.id,
    title: `Get ${it.quantity} ${it.unit} ${it.name}`,
    desc: it.primaryStoreName
      ? `Store: ${it.primaryStoreName}${it.primarySection ? ' – ' + it.primarySection : ''}`
      : 'Store: Any',
    durationSec: estimateStepDuration(it), // e.g., 45–90 seconds per item
    blockers: it.blockers || [],
    metadata: {
      cueNotes: it.notes || '',
    },
  })),
  // prefs, status, progress, analytics, timestamps...
};
Test notes:

The spec should ensure each ShoppingLineItem contains enough info
to produce a meaningful SessionStep without extra DB lookups.

6. Blockers & Guards (Shopping Context)
Even though the consolidator is pure, it can recommend future blockers for
sessions:

weather — if store run involves walking in storms, hail (checkable in
another layer).

quietHours — for late-night shopping runs in areas with restrictions.

sabbath — if configured, sessions that represent heavy, non-essential
activity on Sabbath can be flagged.

equipment — if the list volume implies using car/trailer, or
cold-chain needs cooler equipment, etc.

inventory — if purchasing depends on prior preservation/processing steps
(e.g., buy meat only if jars and lids are already acquired).

Test scenarios can note expectations that:

The planner can suggest suitable blockers in ShoppingLineItem.blockers,
but actual guard enforcement is handled by SessionRunner-side logic.

7. Error Handling & Warnings
7.1 Invalid Input
GIVEN:

input is null/undefined,

inventorySnapshot is not an object,

or storeCatalog.stores is not an array when provided,

THEN:

Return ok: false:

ts
Copy code
{
  ok: false,
  error: {
    code: 'shopping.consolidate.invalidInput',
    message: string,
    details: { /* which part was invalid */ }
  }
}
7.2 Partial Data Warnings
Missing prices → missing_price_data.

Items with no matching catalog products → no_store_for_item.

Budget exceed → budget_exceeded.

Constraint conflicts → constraint_violation_risk.

The planner should still return ok: true and populate warnings.

8. Determinism & Purity
8.1 Deterministic
For the same input, the planner MUST:

Produce identical ShoppingPlan (ignoring insignificant ordering differences
if they’re clearly documented; better to use stable sorting).

Tests can serialize the plan and compare JSON strings between runs.

8.2 No Side Effects
shopping.consolidateList MUST NOT:

Read/write Dexie directly,

Emit on eventBus,

Trigger notifications, TTS, or UI,

Create or mutate Sessions.

It must be a pure function returning a ShoppingConsolidationResult.

9. Example Test Scenarios (Checklist)
Simple two-meal list

Two recipes, overlapping ingredients, no inventory.

Expect deduped, normalized quantities and reasons referencing both recipes.

Inventory subtraction

Inventory partially covers sugar and fully covers salt.

Expect sugar quantity reduced; salt either omitted or flagged as already
in stock.

Cross-domain needs (cooking + cleaning + preservation)

Vinegar required by:

Pickling batch,

General cleaning routine.

Expect single line item with multiple reasons.

Store options and preferences

Multi-store item with preferredStores set.

Expect primary store selection honoring user preference when price is
close; cheaper store when preferSales is true.

Budget with priorities

High total cost vs budgetCap.

Expect item priorities set and budget_exceeded warning.

Dietary constraints

Item that can only be sourced from products flagged as pork-derived,
but user has avoidPorkDerived: true.

Expect item present with constraints.avoidPorkDerived and warning
constraint_violation_risk.

Invalid inputs

input null → ok: false and shopping.consolidate.invalidInput.

Empty input

No needs and/or only empty arrays → ok: true, plan.items.length === 0.

With these behaviors in place, the shopping.consolidateList skill can serve as
the backbone of SSA’s “Shopping Now” pipeline:

Orchestrators call it whenever sessions/meals/inventory change.

Domain pages surface a Next Shopping Run CTA with store-level summaries.

SessionRunner handles execution, timers, toasts, guards, and Hub export.
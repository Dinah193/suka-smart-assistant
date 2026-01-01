# Storehouse — `storagePlanner` Skill Spec  
_File: `src/tests/skills/storehouse.storagePlanner.spec.md`_

These notes define the **expected behavior** of the **Storehouse Storage
Planner** skill: `storehouse.storagePlanner`.

This skill takes **inventory + storage layout + constraints** and produces
**actionable placement/move plans**, optionally convertible into a runnable
`Session` (domain: `"storehouse"`) for the `SessionRunner`.

The spec focuses on:

- Declarative planning logic (no side effects),
- Respecting capacity and environmental constraints,
- Generating human-readable plans for shelves, bins, and cold storage,
- Supporting downstream “Now” execution via the shared `Session` contract.

---

## 1. Role of `storehouse.storagePlanner`

### 1.1 Purpose

The storage planner’s job is to answer:

> “Given what we have and how our storehouse is laid out, **where should
> everything live, and what moves are needed to get there?**”

It must:

- Accept:
  - **Inventory records** (items, quantities, preservation state),
  - **Storage topology** (rooms → zones → shelves/bins),
  - **Constraints** (capacity, environment, category rules),
  - **Planner preferences** (e.g., group by household, by use-frequency).
- Produce:
  - A **placement plan**, listing target locations and quantities.
  - A **move plan**, describing how to physically move items
    (e.g., “Move 3 jars of tomato sauce from Kitchen Cabinet B → Root Cellar Shelf A1”).

It MAY optionally:

- Be wrapped by another skill that converts move plan steps into a
  `Session` object (`domain: "storehouse"`) for the `SessionRunner`.

> **Important:** `storagePlanner` itself is **pure**: no Dexie writes,
> no eventBus emissions. It returns **data** for others to execute.

---

## 2. Output Shapes & Contracts

### 2.1 Planner Result Shape

Recommended result shape:

```ts
type StoragePlannerResult =
  | { ok: true;  plan: StoragePlan; warnings?: PlannerWarning[]; }
  | { ok: false; error: PlannerError; warnings?: PlannerWarning[]; };
Where:

ts
Copy code
type StoragePlan = {
  /** Identifier of the planner run for auditing */
  runId: string;
  /** Summary of inputs used (for caching/debug) */
  context: {
    profileId?: string | null;     // e.g., "family_household_main"
    strategy: 'byCategory' | 'byUseFrequency' | 'byHousehold' | 'hybrid';
    timestamp: string;             // ISO
  };
  /** Top-level recommendations, independent of specific moves */
  recommendations: Array<{
    code: string;                  // e.g., "balance_freezer_load"
    message: string;               // user-friendly
    details?: any;
  }>;

  /** Concrete move actions; each can become a Session step */
  moves: StorageMove[];

  /** Optional mapping from locationId to computed capacity/utilization */
  utilization?: Array<{
    locationId: string;
    capacityUnits: number;
    usedUnits: number;
    utilizationPct: number;
    overCapacity?: boolean;
  }>;
};

type StorageMove = {
  id: string;
  /** inventory item identifier */
  itemId: string;
  /** human-friendly label */
  itemName: string;
  /** quantity to move (in base units, e.g., "each", jars, lbs) */
  quantity: number;

  /** optional: from-location may be null for items not yet stored */
  fromLocationId: string | null;
  fromLocationLabel?: string | null;

  /** required: target location */
  toLocationId: string;
  toLocationLabel: string;

  /** reason for move; used in UI/Session step description */
  reason:
    | 'initialPlacement'
    | 'balanceCapacity'
    | 'groupByCategory'
    | 'rotateOldestForward'
    | 'alignWithUseFrequency'
    | 'prepForPreservation'
    | 'safetySeparation';

  /** optional: environmental hints */
  env?: {
    temperatureBand?: 'frozen' | 'cool' | 'cellar' | 'room';
    lightSensitive?: boolean;
    humidityPreference?: 'low' | 'medium' | 'high';
  };

  /** optional: hints for Session-level blockers (if converted into Session) */
  blockers?: Array<'inventory' | 'weather' | 'quietHours' | 'sabbath' | 'equipment'>;

  /** optional textual notes, used for display/tooltips */
  notes?: string;
};

type PlannerWarning = {
  code: string;             // e.g. "capacity_overflow", "missing_location"
  message: string;          // user-facing
  details?: any;
};

type PlannerError = {
  code: string;             // e.g. "invalid_input", "no_locations_available"
  message: string;          // user-facing
  details?: any;
};
Test expectations:

For ok: true, plan.moves is an array (possibly empty, but usually non-empty).

For ok: false, error.code and error.message MUST be defined.

3. Input Shapes
3.1 Inventory Input
Representative input to planner:

ts
Copy code
type InventoryItem = {
  id: string;
  name: string;
  category: 'grain' | 'legume' | 'meat' | 'produce' | 'dairy' | 'prepared' | 'other';
  quantity: number;
  unit: 'each' | 'lb' | 'kg' | 'jar' | 'bag' | 'box' | 'can';
  householdTag?: string | null;     // e.g., "Household A"
  preservationState?: 'fresh' | 'frozen' | 'cured' | 'canned' | 'dried' | 'fermenting';
  bestByDate?: string | null;       // ISO
  currentLocationId?: string | null;
};
storagePlanner receives an array of such items.

3.2 Storage Layout Input
ts
Copy code
type StorageLocation = {
  id: string;
  label: string;                    // "Root Cellar – Shelf A1"
  kind: 'rootCellar' | 'freezer' | 'fridge' | 'pantryShelf' | 'bulkBin' | 'barn' | 'other';
  capacityUnits: number;            // e.g., cubic units or abstract slots
  usedUnits?: number;               // optional pre-calculated
  /** optional environmental characteristics */
  env?: {
    temperatureBand?: 'frozen' | 'cool' | 'cellar' | 'room';
    lightProtected?: boolean;
    humidityLevel?: 'low' | 'medium' | 'high';
  };
  /** categories this location prefers; empty or absent = any */
  allowedCategories?: string[];
  /** optional tag for grouping by household / building / zone */
  zoneTag?: string;
};
Planner input:

ts
Copy code
type StoragePlannerInput = {
  inventory: InventoryItem[];
  locations: StorageLocation[];
  strategy?: 'byCategory' | 'byUseFrequency' | 'byHousehold' | 'hybrid';
  constraints?: {
    maxMoveCount?: number;
    maxDistanceScorePerRun?: number;  // optional: approximate movement “cost”
    preferColdForRootVeg?: boolean;
    SabbathGuardEnabled?: boolean;    // if true, heavy tasks may be flagged 'sabbath'
  };
};
Test expectations:

Missing strategy defaults to a safe baseline, e.g. 'byCategory'.

locations and inventory MUST be arrays; if not, expect ok: false.

4. Core Planning Rules
4.1 Category → Location Matching
GIVEN items with category grain,
WHEN there are locations with allowedCategories including "grain"
THEN those locations MUST be preferred as targets.

If multiple locations match:

Prefer those with lower utilization (avoid overloading a single shelf).

Respect environmental preference if defined:

Example: preservationState: 'fresh' + root vegetables → env.temperatureBand: 'cellar'.

Test cases:

Simple match:

10 bags of rice,

1 pantry shelf allowing grain,

1 barn location allowing other.

Expect plan to place rice on pantry shelf first.

Multiple allowed:

15 jars of beans,

2 shelves each allowing legume,

1 shelf at 80% used, 1 at 30% used.

Expect majority of moves to go toward less utilized shelf.

4.2 Capacity Enforcement
Planner must never exceed capacity.

For each candidate move, compute newUsedUnits = usedUnits + quantityInUnits.

If newUsedUnits > capacityUnits, either:

Reduce quantity for that move, or

Split across multiple locations, or

Emit ok: false with error.code = 'no_locations_available' if no alternative.

Test cases:

Exact fit:

capacity 10, used 8, quantity 2 → move accepted as-is.

Overflow split:

capacity 10, used 8, quantity 5.

Expect at least two moves (2 to that location, 3 to another, or leftover flagged).

Total overflow:

If all locations full or non-matching → ok: false, error.code = 'no_locations_available'.

4.3 Rotation: Oldest Forward (FIFO / FEFO)
Planner should help enforce:

FIFO (first in, first out) by default.

FEFO (first expired, first out) when bestByDate present.

Behavior:

Items with oldest bestByDate should be:

moved into more accessible locations (front of shelves, nearer kitchen),

flagged with reason 'rotateOldestForward'.

Test cases:

Two lots of canned tomatoes:

Lot A: bestByDate 2026-01-01,

Lot B: bestByDate 2027-01-01.

Accessible pantry shelf vs deep root cellar:

Expect the older lot moved toward pantry while younger stays deeper.

4.4 Grouping by Household / Use-Frequency
When strategy involves 'byHousehold' or 'byUseFrequency':

byHousehold:

Items tagged householdTag: 'A' should be collocated where possible.

byUseFrequency:

Frequently accessed items (like flour, sugar) should be placed in closer,
more accessible locations (kind: 'pantryShelf') while bulk backstock
goes to deeper storage (rootCellar, barn, etc.).

Test cases:

Household A and B each have rice bags.

With strategy: 'byHousehold', expect separate target locations or zones by zoneTag.

Frequently used vs long-term:

flour (useFrequency: 'daily') vs emergency rice stash (useFrequency: 'rare').

Expect daily items closer.

5. Move Plan → Session (Storehouse Domain)
Although not the storagePlanner’s job, tests should ensure the plan is easily
convertible into a Session (domain: "storehouse"):

ts
Copy code
// Example transformation (not implemented here, just expected to be feasible):
const session = {
  id: 'sess_storehouse_' + plan.runId,
  domain: 'storehouse',
  title: 'Storehouse Storage Plan – ' + dateShort(plan.context.timestamp),
  source: { type: 'storehouse', refId: plan.runId }, // or 'import'/'manual'
  steps: plan.moves.map((m, idx) => ({
    id: m.id,
    title: `Move ${m.quantity} ${m.itemName}`,
    desc: `From: ${m.fromLocationLabel || 'Unassigned'} → To: ${m.toLocationLabel}`,
    durationSec: estimateDurationFromQuantity(m.quantity),
    blockers: m.blockers || [],
    metadata: {
      cueNotes: m.notes || ''
    }
  })),
  // ...prefs, status, progress, analytics, timestamps...
};
Test notes:

Confirm StorageMove fields contain enough data to build SessionStep titles
and descriptions WITHOUT additional lookups.

6. Blockers & Guards (Storehouse Context)
Most storage moves are indoor and weather-safe, but:

quietHours:

Large crate moves, heavy dolly usage, or freezer alarms may be flagged.

sabbath:

Bulk, workload-heavy rearrangements may be flagged as non-Sabbath tasks.

equipment:

Items requiring forklift, dolly, or stairs may be flagged.

inventory:

When move is a precursor for preservation (e.g., move meat to staging before
pressure canning) and depends on jars, lids, etc.

Test scenarios:

Planner receives a constraints.SabbathGuardEnabled: true and items marking
“heavy move” risk:

At least some heavy moves should include 'sabbath' in blockers.

Items stored in a loud outbuilding at night:

Moves crossing quiet-time boundaries should include 'quietHours'.

7. Error Handling & Fallbacks
7.1 Invalid Input
GIVEN:

inventory not an array,

locations missing or empty,

capacityUnits negative,

THEN ok: false with:

ts
Copy code
{
  ok: false,
  error: {
    code: 'storehouse.storagePlanner.invalidInput',
    message: string,
    details: { ... }
  }
}
Tests MUST assert:

error.code is present and stable,

message is human-readable (not just “[object Object]”).

7.2 Partial Plans & Warnings
If some items cannot be placed but others can:

Return ok: true but include warnings with codes like:

"unplaced_items",

"capacity_overflow",

"no_matching_location_for_category".

Test cases:

Mixed inventory: some categories have no allowed locations.

Plan should still place what it can and warn about the rest.

8. Determinism & Purity
8.1 Deterministic Output
Repeated calls with identical input must produce the same plan:

Moves order may be sorted by:

toLocationLabel,

category,

or some documented priority.

Test expectation:

Serialize plan from two calls and compare JSON strings; they match.

8.2 No Side Effects
storehouse.storagePlanner MUST NOT:

write to Dexie,

emit events on the global eventBus,

start a SessionRunner,

trigger notifications or TTS.

Tests should confirm this where possible (e.g., using spies/mocks in JS
tests; here, note as a requirement).

9. Example Test Cases (Checklist)
Basic Pantry Fill

Input: grains + one pantry shelf.

Expect: all placed on shelf, ok: true, no warnings.

Multiple Locations + Capacity Limits

Input: large quantity for two shelves with different remaining capacity.

Expect: split moves, no capacity overflows.

Category-Constrained Locations

Locations that reject certain categories.

Expect misfit items to be warned under "no_matching_location_for_category".

Rotation & Best-By Dates

Older stock moved toward accessible locations, reason 'rotateOldestForward'.

Household-Zone Grouping

With strategy: 'byHousehold', expect household-tag alignment by zoneTag.

Sabbath & Quiet Hours Blockers

Heavy move scenario with constraints.SabbathGuardEnabled: true and
“night-time” context; check for 'sabbath' / 'quietHours' in blockers.

Invalid Input

Null inventory or locations → ok: false, error.code = 'storehouse.storagePlanner.invalidInput'.

Partial Success with Warnings

Only some items placeable; plan still returns ok: true and includes
warnings about unplaced items.

10. Integration Notes
Once storehouse.storagePlanner matches this spec:

Orchestrators can:

call it whenever inventory or layout changes,

convert plan.moves into a storehouse Session for the SessionRunner,

surface a “Storehouse Now” CTA in SessionBanner and storehouse pages.

The Runner can:

announce moves via Toasts (“Move 3 jars to Root Cellar – Shelf A1”),

maintain checkpoints and analytics,

export completed runs to the Hub when familyFundMode === true.

This keeps storehouse planning declarative, while execution and resilience
are handled by the shared Session runtime.
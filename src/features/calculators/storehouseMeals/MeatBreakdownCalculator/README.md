# MeatBreakdownCalculator

**Path**

```text
src/features/calculators/storehouseMeals/MeatBreakdownCalculator/
Files in this feature

MeatBreakdownCalculator.schema.json
JSON Schema for carcass inputs and per-cut/byproduct outputs.

MeatBreakdownCalculator.shim.js
Pure logic “shim” that computes yields and emits calculator events.

MeatBreakdownCalculator.view.jsx
React UI for visualizing breakdown, cuts, and byproducts.

MeatBreakdownCalculator.hooks.js
Hooks that connect the breakdown to inventory/freezer and batch planning.

MeatBreakdownCalculator.mappings.json
Planning-graph mappings for “Next Steps” (batch cooking, preservation, inventory).

README.md
This document.

1. Purpose & How It Fits SSA
The MeatBreakdownCalculator is the bridge between:

Animals / Butchery → Storehouse → Meals / Preservation

It takes a single animal / carcass and:

Chooses a basis weight (live, hot carcass, or chilled carcass).

Applies species yield profiles (beef, lamb, goat, pork, poultry, other).

Produces:

Per-cut yields (weight, % of meat, packages, servings).

Byproduct yields (bones, fat, organs).

Summary metrics (meat, bone, fat, offal, shrink, estimated servings).

Emits calculator events so:

Storehouse / Inventory can update.

Batch cooking planner can propose sessions.

Preservation / broth / rendering flows can be suggested.

Optional Hub export can share this data with the Family Fund Hub.

This calculator is not a SessionRunner itself, but it feeds sessions into the
SessionRunner by:

Emitting session.request.* events from the view and hooks, and

Providing cut/byproduct data that batch-planning logic uses to build
Session objects that follow the SessionRunner contract.

2. Data Model Overview
2.1 Inputs (high-level)
From MeatBreakdownCalculator.schema.json (summary only):

ts
Copy code
inputs: {
  animal: {
    species: "beef" | "lamb" | "goat" | "pork" | "poultry" | "other",
    breed?: string,
    sex?: string,
    tagId?: string,
    // ...other animal metadata
  },
  carcass: {
    liveWeight?: number,
    hotCarcassWeight?: number,
    chilledCarcassWeight?: number,
    weightUnit: "lb" | "kg",
    slaughterDate?: string,
    processingDate?: string,
    // ...other carcass metadata
  },
  processingPreferences?: {
    trimLevel?: "standard_trim" | "heavy_trim" | "leave_fat_cap",
    grindPreference?:
      | "balanced_grind"
      | "minimal_grind"
      | "max_grind",
    // future: dryAgedDays, sausageFlavorProfile, etc.
  },
  batchContext?: {
    // Share factor if carcass is split between households (0–1).
    shareFactor?: number,
    // future: householdId, projectId, etc.
  }
}
2.2 Basis Weight
The shim derives a basis:

Priority:

chilledCarcassWeight

hotCarcassWeight

liveWeight

Optionally multiplied by batchContext.shareFactor (0–1) if only a portion
belongs to the current household.

ts
Copy code
summary.basisType: "chilled_carcass" | "hot_carcass" | "live";
summary.basisWeight: number;
summary.weightUnit: "lb" | "kg";
2.3 Species Profiles
Each species has a default profile:

meatPct – % of basis that becomes edible meat.

bonePct – % that is bone.

fatPct – trim fat.

offalPct – organs.

shrinkPct – moisture/processing loss.

Each profile also defines cuts:

ts
Copy code
cuts: Array<{
  key: string;               // logical identifier
  name: string;              // human-readable
  category: string;          // e.g. “steak|roast|ground|stew|chop|rib|organ|other”
  primal: string;            // e.g. “Loin”, “Rib”, “Leg”
  subPrimal?: string;
  pctOfMeat: number;         // % of *meat* allocated to this cut
}>
Profiles are tunable with processingPreferences (trim + grind).

3. Shim Logic (MeatBreakdownCalculator.shim.js)
3.1 Exported API
js
Copy code
export const MeatBreakdownCalculatorShim = {
  id: "MeatBreakdownCalculator",
  domain: "storehouse",
  version: "v1.0.0",
  run: runMeatBreakdownCalculator,
};

export async function runMeatBreakdownCalculator(payload): Promise<object>;
export default MeatBreakdownCalculatorShim;
Expected payload:

ts
Copy code
payload: {
  inputs: { animal, carcass, processingPreferences?, batchContext? },
  metadata?: object;
}
Return:

Object conforming to MeatBreakdownCalculator.schema.json:

ts
Copy code
{
  version: "v1.0.0",
  calculator: "MeatBreakdownCalculator",
  metadata: { createdAt, updatedAt, ... },
  inputs: { ... },
  outputs: {
    summary: { ... },
    cuts: Array<CutOutput>,
    byproducts: Array<ByproductOutput>,
  }
}
3.2 Summary Outputs
ts
Copy code
outputs.summary = {
  basisType: "chilled_carcass" | "hot_carcass" | "live",
  basisWeight: number,
  weightUnit: "lb" | "kg",

  totalUsableMeatWeight: number,
  totalBoneWeight: number,
  totalTrimFatWeight: number,
  totalOffalWeight: number,

  yieldPercentages: {
    meatPct: number,
    bonePct: number,
    trimFatPct: number,
    offalPct: number,
    shrinkLossPct: number,
  },

  estimatedTotalServings: number, // assumes ~0.5 lb or ~0.23kg per serving
};
3.3 Cuts Outputs
Per-cut structure:

ts
Copy code
outputs.cuts: Array<{
  id: string;                 // e.g., "cut_ground" or "cut_steaks"
  name: string;
  category: string;           // "steak|roast|ground|stew|chop|rib|organ|other"
  primal: string;
  subPrimal?: string;
  boneIn: boolean;

  weight: number;             // total cut weight
  weightUnit: "lb" | "kg";

  yieldPctOfBasis: number;    // % of basis weight
  yieldPctOfMeat: number;     // % of total meat

  estimatedServings: number;
  servingSizeUnit: "lb" | "kg";

  packagePlan: {
    packages: number;
    weightPerPackage: number;
    servingsPerPackage: number;
  };

  intendedUse: string;        // "family_meals" | "special_occasions" | etc.

  storehouseLink: {
    inventoryItemId?: string;
    preferredRecipeIds?: string[];
  };

  notes?: string;
}>;
3.4 Byproducts Outputs
ts
Copy code
outputs.byproducts: Array<{
  type: string;              // "bone"|"fat"|"organ"|"stock_bag"|"hide"|"pet_food"|...
  label: string;
  weight: number;
  weightUnit: "lb" | "kg";
  yieldPctOfBasis: number;
  intendedUse: string;       // "stock" | "render_tallow" | etc.
  storehouseLink: {
    inventoryItemId?: string;
  };
  notes?: string;
}>;
3.5 Events & Hub Export
The shim emits:

calculator.meatBreakdown.completed

calculator.meatBreakdown.error

calculator.meatBreakdown.exported (if Hub export succeeds)

Event shape:

js
Copy code
emit({
  type: "calculator.meatBreakdown.completed",
  ts: new Date().toISOString(),
  source: "features/calculators/storehouseMeals/MeatBreakdownCalculator",
  data: {
    calculatorId: "MeatBreakdownCalculator",
    species,
    basisType,
    basisWeight,
    weightUnit,
    summary,
  },
});
Hub export:

Gated by familyFundMode.

Uses HubPacketFormatter.buildPacket and FamilyFundConnector.send.

Logs failure but never throws to callers.

4. UI View (MeatBreakdownCalculator.view.jsx)
4.1 Props
ts
Copy code
type MeatBreakdownCalculatorViewProps = {
  data: MeatBreakdownPayload | null;
  isLoading?: boolean;
  error?: string | null;
  onStartSession?: (data: MeatBreakdownPayload) => void;
  compact?: boolean;
};
4.2 Layout
The view renders:

Header

Species / breed / tag.

Basis weight + basis type label.

Slaughter / processing dates (if present).

“Use This Breakdown Now” CTA.

Summary Grid

Total meat, estimated servings, bones, fat, offal.

Each as cards with value + %.

Yield Bars

Horizontal bars for:

Meat

Bone

Trim Fat

Offal

Shrink/Waste

Cuts

Search + category filter toolbar.

Scrollable table:

Cut name + category (steak/roast/etc).

Primal/sub-primal.

Weight.

% of meat.

Packages.

Servings.

Row click → opens a Cut Detail Modal.

Byproducts Card

Bones, fat, organs, etc.

Weight + % of basis.

Cut Detail Modal

Primal & sub-primal.

Bone-in flag.

Weight, yield %, servings.

Packaging plan.

Optional notes.

4.3 Events
On load (when valid data + summary):

Emits calculator.meatBreakdown.viewed.

On “Use This Breakdown Now”:

If onStartSession prop is provided → called.

Otherwise, emits session.request.fromMeatBreakdown:

js
Copy code
emit({
  type: "session.request.fromMeatBreakdown",
  ts: new Date().toISOString(),
  source:
    "features/calculators/storehouseMeals/MeatBreakdownCalculator.view",
  data: {
    calculatorId: "MeatBreakdownCalculator",
    payload: data,
  },
});
The Session orchestrator should listen for this event and either:

Build batch sessions via MeatBreakdownCalculator.hooks.js, or

Open a selector to choose which suggested session to run now.

5. Hooks (MeatBreakdownCalculator.hooks.js)
5.1 useMeatBreakdownInventorySync
Connects breakdown → inventory + freezer layout.

ts
Copy code
const {
  inventoryPreview,
  freezerZones,
  totalPackages,
  totalWeight,
  weightUnit,
  syncStatus,     // 'idle' | 'saving' | 'success' | 'error'
  syncError,      // string | null
  syncToInventory // () => Promise<void>
} = useMeatBreakdownInventorySync(breakdown, {
  householdId?: string | null,
  createMissingItems?: boolean,
});
What it does:

Derives freezer zones: steaks/roasts, ground/sausage, bones/stock, organs.

Builds inventoryPreview rows from cuts + byproducts.

syncToInventory():

Writes rows into ssaDB.inventory (if available).

Emits:

storehouse.inventory.meatBreakdown.sync.requested

storehouse.inventory.meatBreakdown.synced OR sync.failed.

Inventory rows are generic and should be adapted to your actual schema:

ts
Copy code
{
  householdId: string | null,
  name: string,
  category: string,
  location: string,
  quantity: number,
  unit: string,
  packages: number,
  meta: {
    fromCalculator: "MeatBreakdownCalculator",
    kind: "cut" | "byproduct",
    primal?: string,
    subPrimal?: string,
    boneIn?: boolean,
    intendedUse?: string,
    breakdownId?: string | null,
    createMissingItems: boolean,
    storehouseLink?: object,
  },
  createdAt: string,
  updatedAt: string,
}
5.2 useMeatBreakdownBatchPlanning
Builds proposed batch cooking sessions for the SessionRunner.

ts
Copy code
const {
  proposedSessions,
  startBatchSession,
} = useMeatBreakdownBatchPlanning(breakdown, {
  domain?: "cooking" | "preservation" | "storehouse",
  defaultSourceType?: "manual" | "import" | ...,
});
What it does:

Uses cuts + byproducts to build SessionRunner-compatible sessions:

Ground & Sausage Prep

Stew / Curry Prep

Roasts & Special Cuts Labeling

Broth & Offal Prep

Each session matches the minimal Session contract:

ts
Copy code
session = {
  id: string,
  domain: string,
  title: string,
  source: { type: string, refId: string | null },
  steps: Array<{
    id: string,
    title: string,
    desc: string,
    durationSec: number,
    blockers: string[],
    metadata: {
      tempTargetF: number,
      donenessCue: "color" | "texture" | "probeTemp" | "timer" | "smell",
      cueNotes: string,
    },
  }>,
  prefs: { voiceGuidance: boolean, haptic: boolean, autoAdvance: boolean },
  status: "pending",
  progress: {
    currentStepIndex: 0,
    elapsedSec: 0,
    startedAt: null,
    pausedAt: null,
  },
  analytics: { skippedSteps: [], adjustments: [] },
  createdAt: ISO,
  updatedAt: ISO,
};
startBatchSession(session) emits:

js
Copy code
emit({
  type: "session.request.fromMeatBreakdown.batch",
  ts: new Date().toISOString(),
  source:
    "features/calculators/storehouseMeals/MeatBreakdownCalculator.hooks",
  data: {
    session,
    breakdownId: breakdown?.metadata?.id || null,
    species: breakdown?.inputs?.animal?.species || "unknown",
  },
});
The SessionRunner controller should pick this up and:

Run guards (Sabbath, Quiet Hours, Inventory, etc.).

Mount SessionRunner modal with the session data.

Persist in Dexie and manage wake-lock/notifications.

6. Mappings (MeatBreakdownCalculator.mappings.json)
This JSON file defines Planning Graph style mappings:

Which Planning Graph nodes this calculator feeds:

Storehouse Stock Planner

Meal Yield Planner

Batch Cooking Planner

Preservation Suite

Animal Planner

Template definitions for batch sessions (ground, stew, roasts, broth/offal).

Preservation strategies:

Freeze roasts/steaks for Sabbaths & feasts.

Freeze ground for weeknight meals.

Bag bones for broth.

Render fat.

Organ handling.

Inventory routing:

Freezer zones (steaks/roasts, ground, bones, organs).

Routing rules for tags and intendedUse.

It is pure configuration, no JS logic. The batch hooks and inventory hooks can
use these mappings to:

Decide when to propose sessions.

Auto-select cuts/byproducts for those sessions.

Route items into the correct freezer location and planning pipelines.

7. Integration Points
7.1 From Animals/Butchery
A typical flow:

User completes an Animal / Butchery record.

That page builds a payload for runMeatBreakdownCalculator.

On success:

results are stored (e.g., Dexie / API).

MeatBreakdownCalculator.view is shown.

useMeatBreakdownInventorySync is used to preview inventory & freezer layout.

useMeatBreakdownBatchPlanning is used to preview possible batch sessions.

7.2 “Now” CTA → SessionRunner
From the view or hooks:

User clicks Use This Breakdown Now (or a batch card Run Now).

We either:

call startBatchSession(session) from the hook, or

emit session.request.fromMeatBreakdown / session.request.fromMeatBreakdown.batch.

The SessionRunner orchestration layer should:

Listen on eventBus for these events.

Build or accept the provided session object.

Mount SessionRunner modal at the app root (portal in App.jsx).

Handle:

wake-lock

notifications

Web Worker timers

Dexie checkpoints

Hub export on completed/aborted.

7.3 Inventory & Storehouse
After evaluating the preview:

Call syncToInventory() from useMeatBreakdownInventorySync.

This writes rows to ssaDB.inventory, tagged with:

fromCalculator: "MeatBreakdownCalculator"

primal, subPrimal, boneIn, intendedUse, etc.

Storehouse dashboards can filter on these fields and show:

how many Sabbath/feast roasts,

how many weeknight ground packs,

how many stock/broth bags, etc.

8. Extension Points
You can safely extend this feature in several ways:

New species / profiles

Add to BASE_SPECIES_PROFILES in the shim.

Define meatPct, bonePct, etc., and per-cut distributions.

New cut categories

Add new category strings to profile cuts.

Update:

deriveFreezerZonesFromCuts (hooks).

CutsToolbar category filters (view).

Mapping rules in MeatBreakdownCalculator.mappings.json.

More detailed packaging logic

Adjust target package sizes in buildCutsFromProfile.

Add new fields to packagePlan if needed.

Advanced inventory schema

Adapt inventoryRowFromPreview to match your real Dexie schema.

Use tags, bin IDs, and household IDs as required.

Direct Session templates

Add more sessions to the batch planning logic:

e.g., Sausage Stuffing Day,

Charcuterie / curing (bacon, ham, etc.),

Grill Pack Assembly.

9. Safety & Defensive Behavior
Shim validates payload and inputs, throws on missing core fields.

If DB tables or Hub helpers are missing, code logs a warning and skips those actions without breaking the UI.

Percentages are clamped and normalized to prevent impossible totals.

All events use the standard SSA event bus shape:

js
Copy code
emit({
  type: string,
  ts: ISOString,
  source: "features/calculators/storehouseMeals/MeatBreakdownCalculator.*",
  data: object,
});
10. Quick Usage Examples
10.1 Running the calculator in a page
js
Copy code
import { useEffect, useState } from "react";
import { runMeatBreakdownCalculator } from "./MeatBreakdownCalculator.shim";
import MeatBreakdownCalculatorView from "./MeatBreakdownCalculator.view";

function ButcheryResultPage({ animal, carcass }) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    async function run() {
      try {
        setIsLoading(true);
        const result = await runMeatBreakdownCalculator({
          inputs: { animal, carcass, processingPreferences: {}, batchContext: {} },
          metadata: { id: `breakdown_${Date.now()}` },
        });
        setData(result);
      } catch (err) {
        setError(err.message || "Failed to calculate meat breakdown.");
      } finally {
        setIsLoading(false);
      }
    }
    run();
  }, [animal, carcass]);

  return (
    <MeatBreakdownCalculatorView
      data={data}
      isLoading={isLoading}
      error={error}
    />
  );
}
10.2 Activating Inventory Sync & Batch Planning
js
Copy code
import MeatBreakdownCalculatorView from "./MeatBreakdownCalculator.view";
import {
  useMeatBreakdownInventorySync,
  useMeatBreakdownBatchPlanning,
} from "./MeatBreakdownCalculator.hooks";

function StorehouseMeatDashboard({ breakdown }) {
  const {
    inventoryPreview,
    freezerZones,
    syncStatus,
    syncToInventory,
  } = useMeatBreakdownInventorySync(breakdown, {
    householdId: "HOUSEHOLD_1",
  });

  const { proposedSessions, startBatchSession } =
    useMeatBreakdownBatchPlanning(breakdown, {
      domain: "cooking",
      defaultSourceType: "manual",
    });

  return (
    <div className="space-y-6">
      <MeatBreakdownCalculatorView data={breakdown} />

      {/* Inventory preview + sync button, batch session cards, etc. */}
      {/* Call syncToInventory() to write to Dexie, and startBatchSession(session) to invoke SessionRunner. */}
    </div>
  );
}
Summary:
The MeatBreakdownCalculator turns one processed animal into structured
storehouse intelligence and ready-to-run session plans for batch cooking
and preservation. It respects SSA’s event patterns, is safe to extend, and plugs
directly into your SessionRunner and Planning Graph infrastructure.
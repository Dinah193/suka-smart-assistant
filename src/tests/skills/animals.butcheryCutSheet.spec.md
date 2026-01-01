# Animals — `butchery.cutSheet` Skill Spec  
_File: `src/tests/skills/animals.butcheryCutSheet.spec.md`_

These notes define the **expected behavior** of the **Butchery Cut Sheet**
skill: `butchery.cutSheet`.

The skill’s job is to take **animal details + household preferences**
and return a **structured cut sheet** and downstream hints that can be:

- printed / viewed as a **human-friendly cut sheet** for the butcher,
- stored in SSA for **inventory & storehouse planning**,
- converted into one or more runnable `Session` objects (domain:
  `"animals"`, `"storehouse"`, and/or `"preservation"`) for the
  `SessionRunner` (e.g., “Lamb Butchery Day”).

The skill itself is a **pure planner**: it does **not** talk to Dexie, does
not emit events, does not manage timers or SessionRunner directly.

---

## 1. Role of `butchery.cutSheet`

### 1.1 Purpose

This skill answers:

> “Given this animal, household preferences, and equipment/storage
> capacity, **how should we break the carcass down into cuts, grinds,
> organs, bones, and fat—plus what Sessions does this imply?**”

Inputs include:

- Species + breed + age + gender,
- Live weight, hot/cold hanging weight (if available),
- Household preferences (steaks vs roasts vs ground, bone-in vs boneless,
  bone broth, organ use, fat rendering, sausage flavors, etc.),
- Butchery style presets (American, French, Nigerian, etc.),
- Equipment + storage constraints (freezer space, grinder, smoker, etc.),
- Intended cooking patterns (grilling, stews, curing, smoking, jerky, etc.).

Outputs:

- A **structured cut sheet** grouped by primals and sub-primals,
- Yield estimates per category (cuts, grind, fat, bones, offal),
- Exceptions/warnings when preferences and physics disagree,
- **Session hints** for:
  - butchery day workflow,
  - preservation day(s) (sausage making, smoking, canning, etc.),
  - storehouse/freezer organization.

---

## 2. Output Shapes & Contracts

### 2.1 Overall Result Shape

```ts
type ButcheryCutSheetResult =
  | { ok: true;  sheet: ButcheryCutSheet; warnings?: ButcheryWarning[]; }
  | { ok: false; error: ButcheryError; warnings?: ButcheryWarning[]; };

type ButcheryCutSheet = {
  sheetId: string;           // unique id for this planned cut sheet
  animal: AnimalDescriptor;
  context: CutSheetContext;

  /** Grouped, structured cut plans */
  primals: ButcheryPrimalPlan[];

  /** Aggregated yield + storage plan */
  yields: ButcheryYieldSummary;
  storagePlan?: ButcheryStoragePlan;

  /** Hints for Session construction */
  sessionHints?: {
    butcheryDay?: ButcherySessionHint;
    preservationDay?: PreservationSessionHint;
    storehouseDay?: StorehouseSessionHint;
  };
};
2.2 Animal Descriptor & Context
ts
Copy code
type AnimalDescriptor = {
  id?: string | null;              // optional id for tracing from SSA
  species: 'lamb' | 'goat' | 'beef' | 'pork' | 'poultry' | 'other';
  breed?: string | null;
  nickname?: string | null;        // "Savvy-01", "Ram #3"
  liveWeightLb?: number | null;
  hangingWeightLb?: number | null; // carcass weight, if known
  ageMonths?: number | null;
  sex?: 'male' | 'female' | 'wether' | 'steer' | 'other' | null;

  killDate?: string | null;        // ISO date
  slaughterMethod?: string | null; // "on-farm", "processor", etc.
};

type CutSheetContext = {
  profileId?: string | null;       // household profile, e.g., "McKayFarm"
  requestedStyle: 'american' | 'european' | 'nigerian' | 'egyptian' | 'custom';
  createdAt: string;               // ISO
  locale?: string | null;          // "en-US", etc.

  /** Household cooking & meal-style preferences */
  preferences: ButcheryPreferences;

  /** Equipment, storage, and workflow constraints */
  constraints?: ButcheryConstraints | null;
};
2.3 Preferences & Constraints
ts
Copy code
type ButcheryPreferences = {
  targetUseMix: {
    steaksPct?: number;            // e.g., 20 (% of usable meat)
    roastsPct?: number;            // e.g., 30
    stewMeatPct?: number;          // e.g., 10
    groundPct?: number;            // e.g., 40
  };

  /** Bone handling preference */
  bonePreference: 'mostlyBoneIn' | 'mostlyBoneless' | 'mix';

  /** Fat handling */
  fatHandling: {
    keepForRendering: boolean;
    keepForSausage: boolean;
    discardExcessHardFat?: boolean;
  };

  /** Organs/offal preferences */
  offalPreferences: {
    keepLiver: boolean;
    keepHeart: boolean;
    keepKidneys: boolean;
    keepTongue?: boolean;
    keepHead?: boolean;
    keepFeet?: boolean;
    keepHide?: boolean;
    renderBonesForBroth: boolean;
  };

  /** Sausage plans */
  sausagePlan?: {
    enabled: boolean;
    targetPctOfTrim?: number;      // e.g., 30% of trim to sausage
    flavors?: string[];            // "breakfast", "Italian", "spicy Nigerian"
    casingType?: 'natural' | 'collagen' | 'none'; // patties vs links
  };

  /** Household habits */
  packageSizePreference?: {
    steaksPerPack?: number;
    chopsPerPack?: number;
    stewLbPerPack?: number;
    groundLbPerPack?: number;
    organUnitsPerPack?: number;
  };

  /** Cooking styles (for naming + suggestions) */
  cookingStyles?: Array<
    'grill' | 'braise' | 'stew' | 'smoke' | 'cure' | 'jerky' | 'roastWhole'
  >;
};

type ButcheryConstraints = {
  /** Physical & equipment constraints on processing day(s) */
  equipment: {
    hasGrinder: boolean;
    hasSausageStuffer: boolean;
    hasSmoker: boolean;
    hasSaw: boolean;
    hasVacuumSealer: boolean;
  };
  storage: {
    freezerCuFtAvailable?: number | null; // estimated remaining freezer space
    fridgeCuFtAvailable?: number | null;
    shelfSpaceSqFt?: number | null;      // for canned/preserved
  };
  /** Max hours for butchery day and follow-up processing */
  timeBudget: {
    butcheryDayHours: number;
    preservationDayHours?: number;
  };
};
2.4 Primals & Cut Plan
ts
Copy code
type ButcheryPrimalPlan = {
  id: string;                         // "lamb_forequarter", "lamb_leg"
  label: string;                      // human-friendly
  notes?: string;

  /** Species-specific primal name */
  primalKey: string;                  // e.g., "forequarter", "hindquarter", "loin"

  /** Expected weight range for this primal */
  estimatedWeightLb?: {
    min: number;
    max: number;
    mid?: number;
  };

  /** Planned sub-primal cuts */
  cuts: ButcheryCutPlan[];
};

type ButcheryCutPlan = {
  id: string;                         // stable id within sheet
  label: string;                      // "Loin Chops", "Leg Roasts", etc.
  cutType:
    | 'steak'
    | 'chop'
    | 'roast'
    | 'stew'
    | 'ground'
    | 'shank'
    | 'rib'
    | 'neck'
    | 'organ'
    | 'fat'
    | 'bone'
    | 'trim'
    | 'other';

  /** Bone style */
  boneStyle?: 'boneIn' | 'boneless' | 'mixed';

  /** Packaging units */
  packagePlan?: {
    approxPackages: number;
    avgWeightPerPackLb?: number;
    packageLabel?: string;           // label used for freezer/storehouse
  };

  /** Weight allocation estimate */
  weightLb?: {
    min?: number;
    max?: number;
    mid?: number;
  };

  /** If this cut feeds into the sausage or grind pool */
  flowsInto?: {
    pool: 'ground' | 'sausage' | 'stockBones' | 'renderFat' | 'discard';
    approxWeightLb?: number;
  };

  /** Optional organ/offal metadata */
  offalDetail?: {
    organType?:
      | 'liver'
      | 'heart'
      | 'kidney'
      | 'tongue'
      | 'head'
      | 'feet'
      | 'other';
    specialHandlingNotes?: string;
  };

  notes?: string;
};
2.5 Yield & Storage Summary
ts
Copy code
type ButcheryYieldSummary = {
  estimatedDressPct?: number | null;    // hanging / live
  estimatedCutoutPct?: number | null;   // packaged / hanging
  totalUsableMeatLb?: number | null;
  totalBoneLb?: number | null;
  totalFatLb?: number | null;
  totalOffalLb?: number | null;

  byCategory: {
    steaksLb?: number;
    roastsLb?: number;
    stewMeatLb?: number;
    groundLb?: number;
    sausageLb?: number;
    brothBonesLb?: number;
    renderedFatLb?: number;
    organsLb?: number;
  };

  /** Differences between target use mix and achieved allocation */
  mixDeviation?: {
    steaksPct?: { target?: number; actual?: number; };
    roastsPct?: { target?: number; actual?: number; };
    stewMeatPct?: { target?: number; actual?: number; };
    groundPct?: { target?: number; actual?: number; };
  };
};

type ButcheryStoragePlan = {
  /** Basic freezer footprint estimate (cubic feet) */
  freezerEstimateCuFt?: number | null;
  fridgeDaysForAging?: number | null;
  suggestedShelfAllocation?: {
    frozenLb?: number;
    cannedJarCount?: number;
  };

  /** Location naming hints for SSA’s storehouse module */
  recommendedZones?: Array<{
    zoneId: string;             // "freezer.main", "freezer.lamb", etc.
    label: string;
    suggestedItems: string[];   // e.g., ["Lamb Chops", "Ground Lamb", ...]
  }>;
};
2.6 Session Hints
ts
Copy code
type ButcherySessionHint = {
  sessionTitle: string;          // "Lamb Butchery Day"
  totalEstimatedMinutes: number;
  phases: Array<{
    id: string;
    label: string;               // "Breakdown", "Trim & Package", etc.
    approxMinutes: number;
    stepRefs: string[];          // list of cut or primal ids
  }>;
};

type PreservationSessionHint = {
  enabled: boolean;
  label: string;                 // "Sausage & Preservation Day"
  approxMinutes: number;
  preservationTypes: Array<'sausage' | 'smoke' | 'cure' | 'can' | 'dehydrate'>;
  notes?: string;
};

type StorehouseSessionHint = {
  label: string;                 // "Freezer Label & Map Session"
  approxMinutes: number;
  zonesInvolved: string[];
};
2.7 Warnings & Errors
ts
Copy code
type ButcheryWarning = {
  code: string;                  // "animals.butchery.missingWeights", etc.
  message: string;
  details?: any;
};

type ButcheryError = {
  code: string;                  // "animals.butchery.invalidInput"
  message: string;
  details?: any;
};
3. Inputs
3.1 Input Shape
ts
Copy code
type ButcheryCutSheetInput = {
  animal: AnimalDescriptor;
  context: {
    profileId?: string | null;
    requestedStyle?: CutSheetContext['requestedStyle'];
    locale?: string | null;
  };
  preferences: ButcheryPreferences;
  constraints?: ButcheryConstraints | null;

  /** Optional hints to align with existing SSA plans */
  integrationHints?: {
    /** Link to planned preservation batches (if any) */
    preservationPlanIds?: string[];
    /** Link to storehouse/freezer zones already created */
    storehouseZoneIds?: string[];
  };
};
Test expectations:

Minimal valid input:

animal.species provided,

at least one of liveWeightLb or hangingWeightLb,

preferences.bonePreference provided.

If critical fields missing (e.g., species), the skill should return
ok: false with an error.code of animals.butchery.invalidInput.

4. Core Behaviors
4.1 Weight Estimation & Sanity
Given liveWeightLb and/or hangingWeightLb, the skill must:

Estimate:

dressing percentage (if liveWeightLb provided),

total possible packaged meat weight (cutout).

Populate yields with derived values.

Rules:

Use species-specific default ranges (implementation detail, but tests may
only check relative correctness, not exact numbers).

If both weights missing:

Return ok: false with error.code = 'animals.butchery.missingWeights'.

Test cases:

For lamb with live weight 100 lb and hanging weight 55 lb:

estimatedDressPct ≈ 55 / 100 ≈ 0.55.

totalUsableMeatLb < hangingWeightLb (e.g., ~60–75% of hanging).

4.2 Style & Species-Specific Defaults
The skill must:

Use species + requestedStyle to choose default primal and cut layout.

Examples:

Lamb / Goat (American):

Primals: shoulder, rack, loin, leg, breast/shank.

Common cuts: shoulder chops, leg roasts, loin chops, ribs, stew, shanks.

Beef (American):

Primals: chuck, rib, loin, round, brisket, plate, flank, etc.

Cuts: steaks, roasts, ribs, ground, stew.

Pork (American):

Primals: shoulder, loin, belly, ham, etc.

Cuts: chops, roasts, bacon, ribs, sausage trim.

Test expectations:

For species = 'lamb' and requestedStyle = 'american':

primals includes at least shoulder/forequarter & leg/hindquarter.

For invalid requestedStyle, default to "american" and include a warning
code = 'animals.butchery.unknownStyle'.

4.3 Preference-to-Cut Mapping
Use preferences.targetUseMix to allocate usable meat:

Constraint: the sum of targetUseMix may be:

Between 0–100 → scale proportionally,

100 → normalize to 100 and emit warning
code = 'animals.butchery.mixOver100'.

Behavior:

Compute total usable meat (totalUsableMeatLb).

Allocate per category:

steaksLb, roastsLb, stewMeatLb, groundLb.

Translate these allocations into cut plans distributed across primals.

Test cases:

For a 50 lb usable meat lamb with target mix:

20% steaks, 20% roasts, 10% stew, 50% ground:

byCategory.steaksLb ≈ 10, roastsLb ≈ 10, etc.

For missing targetUseMix, use species defaults (e.g., lamb: more roasts and
chops, moderate ground).

4.4 Bone & Fat Handling
Use preferences.bonePreference and preferences.fatHandling to:

Decide which cuts are bone-in vs boneless,

Decide how much fat is reserved for:

rendering,

sausage,

trimmed discard.

Behavior:

bonePreference = 'mostlyBoneIn':

Keep legs and shoulders mostly bone-in roasts/chops,

Some bones still diverted to broth.

fatHandling.keepForRendering = true:

Hard fat and extra trim → flowsInto.pool = 'renderFat'.

fatHandling.keepForSausage = true:

Enough fat allocated to sausage pool to meet desired sausage ratio.

Test expectations:

When keepForRendering: true, yields.byCategory.renderedFatLb should be

0 if total fat > 0.

If keepForSausage: false, cuts should not divert fat explicitly into
sausage pool, but may still produce ground.

4.5 Offal & Organ Preferences
Based on offalPreferences:

Add ButcheryCutPlan entries for organs (liver, heart, etc.) when desired.

If processor/constraints might prevent some offal recovery, skill may:

still include them with notes,

or omit & warn.

Behavior:

keepLiver = true → cuts contains a liver entry with cutType = 'organ'
and offalDetail.organType = 'liver'.

renderBonesForBroth = true:

Bones allocated to brothBonesLb category and cut plans describing
“Soup Bones” / “Stock Bones”.

Test expectations:

For keepHeart: true, expect at least one heart cut plan.

For renderBonesForBroth: true, expect non-zero byCategory.brothBonesLb
whenever bones exist.

4.6 Sausage Planning
If sausagePlan.enabled = true:

Compute a target sausage pool:

targetSausageLb = trimPoolLb * (targetPctOfTrim / 100) (if provided),

or based on preferences.targetUseMix.groundPct.

Decide which primals/trims feed sausage vs plain ground.

Behavior:

Add dedicated cut entries for sausage:

e.g., “Breakfast Sausage”, “Spicy Nigerian Sausage” with approximate
package counts and labels.

If equipment.hasGrinder is false or hasSausageStuffer is false:

Suggest ground-only or sausage patties rather than cased links,

Emit warning, e.g., code = 'animals.butchery.missingSausageEquipment'.

Test expectations:

With sausage enabled + adequate trim:

yields.byCategory.sausageLb > 0.

With sausage enabled but no grinder:

yields.byCategory.sausageLb may be 0, but a warning is emitted.

4.7 Storage Plan & Constraints
Use constraints.storage and computed yields to:

Estimate freezer space needed,

Suggest zone labeling for SSA’s storehouse module.

Examples:

freezerEstimateCuFt roughly approximates:

totalFrozenLb / densityFactor (implementation detail),

recommendedZones suggests:

freezer.lamb, freezer.organs, freezer.bones, etc.

Test expectations:

When freezer capacity is clearly insufficient:

Emit warning code = 'animals.butchery.freezerCapacityRisk'.

recommendedZones includes at least 1 zone for the species, such as
"freezer.lamb".

4.8 Session Hints Mapping
Without constructing full Session objects, the skill must provide enough
structure for orchestrators to generate:

Butchery Day Session
e.g., "Lamb Butchery Day":

phases like:

Breakdown (quarters, primals),

Fine cutting & trimming,

Packaging & labeling.

Preservation Day Session (optional):

For sausage, smoking, curing, canning of broth, etc.

Storehouse Day Session (optional):

For labeling and mapping items into storehouse zones.

Test expectations:

When total workload is high (large animal + sausage + broth + rendering):

sessionHints.preservationDay is defined with non-trivial
approxMinutes.

When there is little to no processing beyond basic cutting:

Some hints may be omitted or have low approxMinutes.

Example transformation (for tests to reason about feasibility):

ts
Copy code
const hint = sheet.sessionHints?.butcheryDay;
expect(hint?.totalEstimatedMinutes).toBeGreaterThan(0);
expect(Array.isArray(hint?.phases)).toBe(true);
5. Guards & Integration with SessionRunner
Although the skill does not implement guards, its outputs are designed to
inform Sessions that will be guard-aware:

Some tasks related to butchery may include blockers like:

"sabbath" (avoid scheduling on Sabbath),

"quietHours" (avoid noisy work in quiet times),

"equipment" (ensure grinder/saw present and functional),

"inventory" (ensure casings, bags, labels, spices are in stock).

Tests may verify that sessionHints can be trivially mapped to Session.steps
that use such blockers, though direct implementation lives elsewhere.

6. Error Handling & Warnings
6.1 Invalid Input
GIVEN:

animal missing or species undefined,

neither liveWeightLb nor hangingWeightLb present,

preferences.bonePreference missing,

THEN:

Return:

ts
Copy code
{
  ok: false,
  error: {
    code: 'animals.butchery.invalidInput',
    message: string,
    details: { /* which part was invalid */ }
  }
}
6.2 Partial Data Warnings
Missing weights:

code = 'animals.butchery.missingWeights'

Impossible preference mix vs physical limits:

code = 'animals.butchery.unachievableMix'

Insufficient storage vs yields:

code = 'animals.butchery.freezerCapacityRisk'

Missing sausage equipment with sausage enabled:

code = 'animals.butchery.missingSausageEquipment'

The function should still return ok: true where possible and surface
warnings for the UI & orchestration to handle.

7. Determinism & Purity
7.1 Deterministic
For the same input:

butchery.cutSheet must produce the same ButcheryCutSheet structure
each time (ordering of primals and cuts should be stable and
predictable).

Tests may compare stringified JSON outputs (after removing dynamic ids if
needed) to assert determinism.

7.2 No Side Effects
The skill must not:

Read/write Dexie,

Emit events on eventBus,

Trigger UI effects, TTS, notifications, or SessionRunner,

Reach into external config or global browser APIs.

Implementation target:

ts
Copy code
function planButcheryCutSheet(input: ButcheryCutSheetInput): ButcheryCutSheetResult;
8. Example Test Scenarios (Checklist)
Single lamb, American style, bone-in

Input: species = 'lamb', liveWeightLb = 100, hangingWeightLb = 55,
bonePreference = 'mostlyBoneIn', simple use mix.

Expect:

Primals including shoulder & leg,

Some chops/roasts bone-in,

Reasonable yields.

Lamb with strong ground preference

targetUseMix.groundPct = 60 or more.

Expect:

Larger byCategory.groundLb,

Cuts from multiple primals flowing into ground.

Sausage enabled, equipment available

sausagePlan.enabled = true, hasGrinder = true.

Expect:

Non-zero byCategory.sausageLb,

Distinct sausage cut plans with flavor labels.

Sausage enabled, missing grinder

sausagePlan.enabled = true, hasGrinder = false.

Expect:

Warning animals.butchery.missingSausageEquipment,

Reduced or zero sausageLb.

Offal kept vs discarded

With keepLiver/keepHeart true:

Organs appear as cuts.

With all offal flags false:

No organ cuts; yields may allocate to organsLb but flagged as
discarded or “processor keeps.”

Freezer capacity risk

Large beef animal, small freezerCuFtAvailable.

Expect:

Warning animals.butchery.freezerCapacityRisk,

storagePlan.freezerEstimateCuFt > available.

Invalid input (no species)

Expect:

ok: false, error.code = 'animals.butchery.invalidInput'.

Consistent determinism

Same input multiple times in tests:

JSON-serialized sheet.primals should be identical.

With these behaviors implemented and validated, the butchery.cutSheet skill
becomes a core building block for SSA’s Animals and Storehouse
domains:

Domain pages can show a “Butchery Now” CTA linked to SessionRunner,

Storehouse and preservation modules can rely on the cut sheet for
inventory and session planning,

Household preferences are encoded once and reused for each animal,
making the process repeatable, transparent, and guard-aware.
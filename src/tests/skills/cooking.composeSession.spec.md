# Cooking — `composeSession` Skill Spec  
_File: `src/tests/skills/cooking.composeSession.spec.md`_

These notes define the **expected behavior** for the cooking skill that
**composes a runnable `Session`** object from cooking inputs (recipes, manual
steps, imports, leftovers workflows, etc.) for Suka Smart Assistant (SSA).

This spec is meant to guide:

- implementation of `src/skills/cooking.composeSession.js` (or similar),
- unit / integration tests,
- and future refactors that must preserve contract behavior.

The composed output MUST be compatible with the shared **Session object
contract** and ready to be executed in the **SessionRunner** with full
guarding, persistence, and Hub export pipelines.

---

## 1. Role of `cooking.composeSession`

### 1.1 Purpose

The cooking `composeSession` skill:

- Accepts **cooking domain inputs** (recipes, imports, quick actions).
- Produces a **normalized, runnable `Session`** object:

  - `domain: "cooking"`,
  - structured `steps` with durations and blockers,
  - properly initialized `prefs`, `status`, and `progress`.

- Handles **multiple input shapes**:

  - full recipes (multi-step),
  - “quick cook” presets (e.g., reheat leftovers),
  - batch sessions (multiple recipes at once, where supported),
  - manual user-entered steps.

- Stays **pure**: it **does not** write to Dexie or emit events directly.
  - The caller (e.g., shim/orchestrator) persists the Session and triggers
    `session.open.request` via `SessionEvents`.

### 1.2 Session Contract Reminder

Result MUST conform to:

```ts
{
  id: string;
  domain: 'cooking';
  title: string;
  source: {
    type: 'recipe'|'cleaningPlan'|'gardenPlan'|'animalTask'|'import'|'manual';
    refId: string|null;
  };
  steps: SessionStep[];
  prefs: {
    voiceGuidance: boolean;
    haptic: boolean;
    autoAdvance: boolean;
  };
  status: 'pending'|'running'|'paused'|'completed'|'aborted';
  progress: {
    currentStepIndex: number;
    elapsedSec: number;
    startedAt: string|null;
    pausedAt: string|null;
  };
  analytics: {
    skippedSteps: string[];
    adjustments: any[];
  };
  createdAt: string;
  updatedAt: string;
}
Each SessionStep:

ts
Copy code
{
  id: string;
  title: string;
  desc: string;
  durationSec: number;
  blockers?: Array<'inventory'|'weather'|'quietHours'|'sabbath'|'equipment'>;
  metadata?: {
    tempTargetF?: number;
    donenessCue?: 'color'|'texture'|'probeTemp'|'timer'|'smell';
    cueNotes?: string;
  };
}
2. Input Shapes & Core Behavior
2.1 Simple Recipe → Session
GIVEN a normalized cooking recipe:

has id, title,

has structured steps or instructions[],

has optional metadata (oven temp, prep/cook time, yields),

WHEN cooking.composeSession(recipe) is called,
THEN it MUST:

Produce Session.domain = "cooking".

Set Session.title from recipe title (fallback: "Untitled Cooking Session").

Set Session.source to:

type: "recipe",

refId: recipe.id (or null if unavailable).

Transform each recipe step into a SessionStep:

id: stable string (e.g., step_0, recipe step uuid, etc.).

title: short imperative (e.g., "Preheat oven", "Chop onions").

desc: detailed description from recipe (can include bullet-like text).

durationSec:

use recipe-specific timing if present,

otherwise estimate based on heuristics (e.g., chop = 120s, simmer = 900s).

Initialize:

ts
Copy code
prefs: {
  voiceGuidance: true,   // recommended default for cooking
  haptic: true,
  autoAdvance: false
},
status: 'pending',
progress: {
  currentStepIndex: 0,
  elapsedSec: 0,
  startedAt: null,
  pausedAt: null
},
analytics: {
  skippedSteps: [],
  adjustments: []
},
createdAt: ISOString,
updatedAt: ISOString
Test expectation:

The result passes validation against the Session schema.

All steps have durationSec >= 0.

2.2 Manual Quick Session
GIVEN a minimalist “quick cook” request:

ts
Copy code
{
  kind: 'quick',
  title: 'Reheat stew',
  notes: 'Leftover beef stew from fridge',
  durationMinutes: 10
}
WHEN composeSession is called,
THEN it MUST:

Create a Session with:

domain: 'cooking',

title from title field,

source.type: 'manual',

source.refId: null.

Create a single SessionStep:

title: 'Reheat stew' (or similar),

desc includes notes if present,

durationSec = durationMinutes * 60 (with min/max clamping),

metadata.donenessCue = 'smell' or 'texture' (e.g., “stew bubbling
gently and smells hot”).

Test expectation:

Exactly 1 step.

status: 'pending'.

progress.currentStepIndex === 0.

2.3 Multi-Recipe / Batch Cooking Session
GIVEN a batch payload with multiple recipes:

ts
Copy code
{
  kind: 'batchRecipes',
  title: 'Sunday Batch Cook',
  recipes: [recipeA, recipeB, recipeC],
  strategy: 'serial' | 'staggered'
}
WHEN composeSession is called,
THEN:

It MUST create a single Session representing the batch:

title: "Sunday Batch Cook" (or auto-generated).

source.type: 'recipe' | 'import' (configurable),

source.refId: null or synthetic (e.g., batch:recipeA,recipeB,...).

It MUST create steps that:

Combine steps from each recipe,

Optionally group by phases: prep, cook, finish,

Preserve ordering or apply simple optimizations (overlap simmer times).

Each SessionStep MUST include:

A clear title with recipe reference (e.g., "Chop onions (Chili)").

durationSec representing realistic segment time.

Optionally, metadata:

tempTargetF for oven segments,

donenessCue (“texture” for pasta, “probeTemp” for roasts).

Test expectations:

All steps still satisfy the SessionStep schema.

No step has durationSec < 0.

Optionally: total durationSec ~ within expected ranges for all recipes.

3. Blockers & Guards Hints
3.1 Blockers from Recipe Context
GIVEN a multi-step recipe that implies:

requires oven or stove (equipment),

requires specific ingredients in inventory,

may take long (quiet hours consideration),

may be Sabbath-unsafe (e.g., starting a long new batch during Sabbath),

may depend on weather (e.g., outside smoker, grill, or dehydrator),

WHEN composeSession is called,
THEN it MUST:

Set blockers appropriately per step, e.g.:

Steps requiring equipment but not yet verified:

blockers: ['equipment', 'inventory'].

Steps longer than a “quiet hours” threshold:

include 'quietHours' for those steps.

Steps involving grill / smoker / outdoor tasks:

include 'weather'.

Test scenarios:

GIVEN a recipe with method: 'grill'
THEN at least one step includes blockers containing 'weather'.

GIVEN a recipe whose main cook time exceeds N minutes (configurable),
THEN the main cook step includes blockers containing 'quietHours'.

3.2 Sabbath-Aware Tagging
composeSession itself does not enforce Sabbath; that’s a guard’s job.

But it MAY mark steps that would require “new creative work / extended cooking”
as potential 'sabbath' blockers.

Test note:

GIVEN a recipe flagged as “long cook” and “new batch” (not reheating)
THEN one or more steps SHOULD include 'sabbath' in blockers so that
the SabbathGuard can react appropriately.

4. Metadata (Temp, Doneness, Cues)
4.1 Oven / Stovetop Temps
GIVEN recipe metadata like:

ts
Copy code
{
  ovenTempF: 375,
  steps: [
    { text: 'Bake for 25 minutes', durationMinutes: 25 },
    ...
  ]
}
THEN composeSession MUST:

Attach metadata.tempTargetF = 375 to the relevant step(s).

Include donenessCue where applicable:

'timer' for exact time-based bake,

'color' for roux (“cook until golden brown”),

'texture' for pasta, etc.

Tests:

Check that bake steps carry metadata.tempTargetF.

For steps whose text matches patterns like “until golden”, “until tender”,
ensure donenessCue is not 'timer' but 'color' or 'texture'.

4.2 Cue Notes
metadata.cueNotes SHOULD capture helpful text, e.g.:

“Cheese melted and edges browned”

“Onions translucent and soft, not browned”

“Internal temp 165°F”

Test expectations:

For instructions with clear sensory cues (“until fragrant”, “until bubbling”),
THEN cueNotes contains a paraphrase of that cue.

5. UX-Oriented Structuring
5.1 Steps Must Be “Runner Friendly”
Steps SHOULD be broken down so the SessionRunner UI can:

show clear step titles,

show checklist-like descriptions,

not overload a single step with 10 actions.

Test scenario:

GIVEN a recipe with a long monolithic instruction text
WHEN composeSession runs
THEN it SHOULD attempt to split it into 2–3 sub-steps where reasonable,
for example by:

splitting on sentences,

or recognized patterns (“Meanwhile,” “Then,” “Next,” etc.).

5.2 Duration Distribution
If a recipe gives only total cookTime or prepTime,
composeSession SHOULD:

divide total time among steps using heuristics,

ensure the sum of step durations is close to total.

Test idea:

For recipe with totalCookMinutes: 60 and 4 cook-relevant steps:

Expect the sum of durationSec in those steps to be between 50–70 minutes.

6. Idempotence & Determinism
6.1 Deterministic Output
GIVEN the same input recipe
WHEN composeSession is called multiple times
THEN it SHOULD produce:

the same step count,

identical title values,

same durationSec (within deterministic rules),

consistent step id patterns (unless caller overrides id).

6.2 No Side Effects
composeSession MUST:

NOT write to Dexie,

NOT emit events on eventBus,

NOT perform fetch calls.

It is purely a data transformation function.

7. Error Handling & Fallbacks
7.1 Invalid / Partial Inputs
GIVEN partially malformed recipe input (missing some fields):

no id,

no title,

missing steps.

THEN:

The function SHOULD:

attempt to compute a minimal valid Session,

or return null / Result object with errors (depending on design).

Recommended pattern for tests:

If unable to produce a valid Session:

ts
Copy code
{
  ok: false,
  error: { code: 'cooking.composeSession.invalidInput', details: ... }
}
If successful:

ts
Copy code
{
  ok: true,
  session: SessionObject
}
(Update tests if you adopt this Result pattern.)

7.2 Defensive Clamping
Negative durations MUST be clamped to 0.

Excessive durations MUST be capped by domain policy, e.g.:

maxDurationSec = 4 * 60 * 60 (4 hours) per step.

8. Example Test Cases (Summary)
Simple normalized recipe → clean Session

6 steps, durations sum ≈ prepTime + cookTime.

Appropriate metadata for oven step.

Manual quick session (reheat leftovers)

1 step, with donenessCue: 'smell' and note about “hot all the way through”.

Batch cooking with 2–3 recipes

All steps labeled with recipe names.

Reasonable interleaving of prep and cook steps.

Outdoor grill recipe

Steps include blockers: ['weather', 'equipment', ...].

Long simmer recipe near quiet hours

Main simmer step includes 'quietHours' in blockers.

Malformed recipe (missing steps)

Either returns ok: false with validation error,

or synthesizes a single generic step with safe defaults.

9. Integration Notes
Once this spec is satisfied, cooking.composeSession outputs can be:

persisted into the Dexie sessions store,

surfaced in:

SessionBanner “Now” CTA,

cooking domain pages’ session lists,

run through SessionRunner with:

wake-lock,

notifications,

PiP mini HUD,

Hub export when familyFundMode === true.

Future extensions:

Add intelligence for equipment availability and inventory
pre-check hints to refine blockers.

Integrate with reasoner deltas to auto-tune step durations after
observing real-world completion times.
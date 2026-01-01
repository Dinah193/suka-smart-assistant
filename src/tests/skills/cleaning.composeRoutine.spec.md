# Cleaning — `composeRoutine` Skill Spec  
_File: `src/tests/skills/cleaning.composeRoutine.spec.md`_

These notes define the **expected behavior** for the cleaning skill that
**composes a runnable `Session` object** from cleaning routine inputs
(rooms, zones, checklists, presets) for Suka Smart Assistant (SSA).

The composed output MUST be compatible with the shared **Session object
contract** and ready to be executed in the **SessionRunner** with full
guarding, persistence, and Hub export pipelines.

---

## 1. Role of `cleaning.composeRoutine`

### 1.1 Purpose

The cleaning `composeRoutine` skill:

- Accepts **cleaning domain inputs**:
  - room-based routines (e.g., “Kitchen Daily Reset”),
  - zone-based routines (e.g., “Zone 3 – Bedrooms”),
  - deep-clean templates (e.g., “Monthly Fridge Deep Clean”),
  - manual ad-hoc checklists from the user.
- Produces a **normalized, runnable `Session`** object with:
  - `domain: "cleaning"`,
  - step list representing actionable tasks,
  - blocker hints for quiet hours / Sabbath / equipment / inventory.
- Remains **pure**: it does **not** write to Dexie or emit events directly.
  - The caller (shim/orchestrator) persists the Session and triggers
    `session.open.request` via `SessionEvents`.

### 1.2 Session Contract Reminder

Result MUST conform to the shared contract:

```ts
{
  id: string;
  domain: 'cooking'|'cleaning'|'garden'|'animals'|'preservation'|'storehouse';
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
Steps:

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
Note: Cleaning steps will typically ignore cooking-oriented metadata like
temp/doneness, but the shape must remain valid (metadata can be omitted or
used for “smell” / “visual” cleanliness cues if helpful).

2. Input Shapes & Core Behavior
2.1 Room Routine → Session
GIVEN a normalized cleaning routine:

ts
Copy code
{
  id: 'kitchen_daily',
  kind: 'roomRoutine',
  roomName: 'Kitchen',
  title: 'Kitchen Daily Reset',
  tasks: [
    { id: 'clear_counters', label: 'Clear and wipe counters', estimateMinutes: 4 },
    { id: 'dishes', label: 'Load / run dishwasher', estimateMinutes: 6 },
    ...
  ]
}
WHEN cleaning.composeRoutine(routine) is called,
THEN it MUST:

Produce Session.domain = "cleaning".

Set Session.title to either:

explicit routine.title, or

fallback "Kitchen – Daily Reset" or "Cleaning: Kitchen Daily Reset".

Set Session.source to:

type: 'cleaningPlan',

refId: routine.id (or null if no stable id).

Convert each routine task into a SessionStep:

id: stable (task.id, or step_${index} if missing).

title: imperative phrase, e.g., "Clear and wipe counters".

desc: may include room name and any extra instructions.

durationSec: from estimateMinutes * 60, clamped to valid range.

Initialize session fields:

ts
Copy code
prefs: {
  voiceGuidance: true,   // recommended default; “read out tasks”
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
Test expectations:

Session passes schema validation.

Number of steps equals number of tasks.

domain === 'cleaning'.

2.2 Zone Routine (Multiple Rooms)
GIVEN a “zone routine” input:

ts
Copy code
{
  id: 'zone_3_bedrooms',
  kind: 'zoneRoutine',
  zoneName: 'Zone 3 – Bedrooms',
  title: 'Bedrooms Reset',
  rooms: [
    {
      name: 'Master Bedroom',
      tasks: [...]
    },
    {
      name: 'Kids Bedroom',
      tasks: [...]
    }
  ]
}
THEN composeRoutine MUST:

Create a single Session:

title: 'Zone 3 – Bedrooms Reset' or similar.

source.type: 'cleaningPlan', source.refId: 'zone_3_bedrooms'.

Flatten room tasks into ordered steps, preserving room structure:

Step titles should include the room context:

"Master Bedroom – Make bed",

"Kids Bedroom – Pick up floor".

Approximate durations per task.

Test expectations:

Steps are grouped logically by room (e.g., tasks for same room appear as a contiguous block unless a better heuristic is explicitly implemented).

At least one step name includes the zone or room text.

2.3 Deep-Clean Routine
GIVEN a deep-clean template:

ts
Copy code
{
  id: 'fridge_deep_clean',
  kind: 'deepClean',
  area: 'Fridge',
  tasks: [
    { label: 'Empty fridge', estimateMinutes: 5 },
    { label: 'Remove shelves and drawers', estimateMinutes: 6, requiresEquipment: ['tool: screwdriver?'] },
    { label: 'Wash shelves/drawers in sink', estimateMinutes: 10 },
    { label: 'Wipe interior with cleaner', estimateMinutes: 8 },
    ...
  ]
}
THEN composeRoutine SHOULD:

Create a Session with:

title: 'Fridge Deep Clean',

source.type: 'cleaningPlan',

source.refId: 'fridge_deep_clean'.

Produce steps:

Each step has a clear title.

desc may include recommended products or warnings (if available).

durationSec generally longer than daily tasks.

Include blockers where appropriate:

tasks with requiresEquipment → 'equipment',

tasks needing specialty cleaner that may be out of stock → 'inventory'.

2.4 Manual / Ad-Hoc Checklists
GIVEN a simple manual checklist:

ts
Copy code
{
  kind: 'manualChecklist',
  title: 'Living Room Power Clean',
  items: [
    'Pick up clutter',
    'Vacuum rug',
    'Wipe coffee table'
  ]
}
THEN:

Session.source.type = 'manual', refId = null.

One step per item:

durationSec can be derived using heuristics (e.g., default 2–5 minutes).

Titles = item text.

Desc = same as title or extended from hints metadata.

3. Blockers & Guard Hints (Cleaning Domain)
Even though cleaning is mostly indoor and weather-safe, the runner uses
blockers to coordinate with Sabbath, Quiet Hours, and any
equipment/inventory constraints.

3.1 Quiet Hours
Vacuuming, loud machines (carpet cleaner, steam cleaner, washer/dryer),
or heavy hammering (if part of cleaning) SHOULD be marked with
'quietHours' in blockers.

Test scenario:

GIVEN a routine task with requiresEquipment: ['vacuum']
THEN its step MUST include:

ts
Copy code
blockers: expect.arrayContaining(['quietHours', 'equipment'])
3.2 Sabbath
Heavy cleaning that qualifies as “servile work” SHOULD be marked with
'sabbath' blocker so SabbathGuard can pause/disable during the Sabbath.

Light tidy or pre-Sabbath prep tasks can omit 'sabbath' or be left
configurable.

Test idea:

Deep-clean templates (e.g., oven self-clean, multi-hour tasks) SHOULD include
'sabbath' in at least one step’s blockers.

3.3 Inventory & Equipment
Tasks that mention or depend on specific cleaners or consumables:

“Refill soap dispenser” → 'inventory'.

“Change vacuum bag” → 'inventory' + 'equipment'.

Test expectations:

Steps with requiresSupplies flagged in input MUST surface 'inventory'
as a blocker.

4. Metadata & UX Cues
Cleaning rarely uses tempTargetF, but metadata can still help:

donenessCue = 'smell':

e.g., “Let disinfectant sit for 10 minutes; surface should smell faintly,
but not overwhelming.”

donenessCue = 'texture':

e.g., “Surface no longer sticky,” “Carpet fibers stand up again.”

Test note:

For steps that include cues like “until dry”, “until not sticky”,
metadata.donenessCue SHOULD be 'texture' with matching cueNotes.

If no special cues are present, metadata may be omitted or minimal.

5. UX-Oriented Structuring
5.1 Step Granularity
Steps SHOULD be small enough to feel progress but not so tiny that the
runner becomes annoying.

Examples:

Good:

“Clear and wipe counters”

“Load dishwasher”

“Sweep floor”

Bad:

“Do the entire kitchen” (too coarse)

“Pick up one toy” (too fine)

Test scenario:

GIVEN a routine that has a single mega-task like “Clean the kitchen top
to bottom”
WHEN composeRoutine runs
THEN it SHOULD split into at least 3–4 logical steps if the text hints at multiple actions.

5.2 Duration Reasonableness
For daily routines, total time typically stays within 10–45 minutes.

For deep-clean tasks, durations can extend longer but each step must still
have a realistic durationSec, not 0.

Test checks:

Sum of durationSec across steps is > 0.

No step has durationSec < 0.

Optional: no single step exceeds a configured maxStepDurationSec (e.g.,
2 hours), unless explicitly allowed.

6. Idempotence & Purity
6.1 Deterministic Output
GIVEN the same routine input
WHEN cleaning.composeRoutine is called multiple times
THEN step order, titles, and durations MUST be deterministic (no random
reordering or timing differences).

6.2 No Side Effects
MUST NOT:

write to Dexie,

emit any events on eventBus,

trigger notifications or TTS.

It is a pure data transformer.

7. Error Handling & Fallbacks
7.1 Missing or Invalid Fields
GIVEN a malformed routine:

no tasks/rooms/items,

no title,

weird/negative durations,

THEN:

composeRoutine SHOULD either:

return a Result shape with ok: false & error, or

return null (if you choose that convention).

Recommended:

ts
Copy code
{
  ok: false,
  error: {
    code: 'cleaning.composeRoutine.invalidInput',
    details: { ... }
  }
}
And on success:

ts
Copy code
{
  ok: true,
  session: Session
}
Tests SHOULD assert explicit behavior: either pattern is fine as long as it’s
consistent and documented.

7.2 Defensive Defaults
On missing duration estimates, use default per-task duration (configurable)
like 2–5 minutes.

Clamp negative durations to 0.

If title missing, fallback to:

"Cleaning Routine" or "Untitled Cleaning Session".

8. Example Test Cases (Checklist)
Daily kitchen routine → valid Session

5–10 steps.

Domain "cleaning".

source.type === 'cleaningPlan'.

Zone routine with multiple rooms

Steps include room name in title or desc.

Order respects rooms and their tasks.

Deep-clean fridge routine

Includes 'equipment' in steps that remove hardware or use tool.

Possibly 'inventory' for cleaners.

Vacuum-heavy routine near quiet hours

Steps requiring vacuum carry 'quietHours' in blockers.

Sabbath-sensitive heavy routine

Long, intensive steps flagged with 'sabbath'.

Minimal manual checklist

Creates 1 Session with step per item.

Reasonable default durations.

Malformed input (no tasks)

Returns ok: false (or null) with clear error reason.

9. Integration Notes
Once this spec is met:

Cleaning sessions will flow into the shared sessions store,

Surfaced by:

SessionBanner as cleaning domain “Now” sessions,

Cleaning pages (e.g., “Homestead → Cleaning”) as runnable routines.

They run under SessionRunner with:

wake-lock,

notifications (“Next: Vacuum rug”),

optional TTS reading out cleaning tasks,

checkpoint persistence,

Hub export when familyFundMode === true.

Future expansion:

Add priority tags (“must do today” vs “nice to have”).

Integrate with household zones calendar so routines can be auto-scheduled
and surfaced as “Next Cleaning Session” via SessionBanner.
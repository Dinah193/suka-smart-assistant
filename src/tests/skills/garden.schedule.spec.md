# Garden — `schedule` Skill Spec  
_File: `src/tests/skills/garden.schedule.spec.md`_

These notes define the **expected behavior** of the **Garden Scheduling** skill:
`garden.schedule`.

The skill’s job is to take **garden plans / tasks / crops** plus context
(weather, season, user availability, and blockers) and return a **time-ordered,
guard-aware work schedule** that can be:

- rendered in the UI as a **garden calendar** and **task list**, and/or  
- converted into one or more runnable `Session` objects (domain: `"garden"` or
  `"storehouse"`) for the `SessionRunner` (e.g., “Today’s Garden Block”).

The skill itself is a **pure, declarative planner**: it does **not** talk to
Dexie, does not emit events, and does not directly manage the SessionRunner.

---

## 1. Role of `garden.schedule`

### 1.1 Purpose

This skill answers:

> “Given my crops, garden tasks, seasons, and constraints, **what should I do
> on which day/time, in which order, to keep the garden alive and productive?**”

Inputs include:

- **Crop plans** (perennials, annuals, succession plantings),
- **Garden tasks** (sow, transplant, prune, weed, water, fertilize, harvest,
  preserve-prep, bed turnover, cover crop, tool maintenance),
- **Weather & season** (frost dates, rainfall patterns, heat waves),
- **User availability** (time windows per day, Sabbath/quiet hours),
- **Constraints** (equipment, labor intensity, preferences).

Outputs:

- A **scheduled garden plan** that maps tasks to specific dates & time windows,
  ordered and grouped into **blocks** suitable for Sessions.
- Optional hints allowing orchestrators to build `Session` objects.

---

## 2. Output Shapes & Contracts

### 2.1 Scheduling Result Shape

The `garden.schedule` skill returns a discriminated union:

```ts
type GardenScheduleResult =
  | { ok: true;  schedule: GardenSchedule; warnings?: GardenScheduleWarning[]; }
  | { ok: false; error: GardenScheduleError; warnings?: GardenScheduleWarning[]; };

type GardenSchedule = {
  planId: string;                    // unique id for this schedule run
  context: {
    profileId?: string | null;       // "main_household", "plot_A", etc.
    mode: 'normal' | 'intensive' | 'light' | 'catchUp';
    timestamp: string;               // ISO
    timeHorizon: {
      from: string;                  // ISO date (start)
      to: string;                    // ISO date (end)
    };
    sources: {
      fromGardenPlans: string[];     // garden plan ids
      fromCrops: string[];           // crop ids
      fromTemplates?: string[];      // routine templates ids, if any
    };
  };

  /** Flattened, fully-scheduled tasks */
  tasks: GardenScheduledTask[];

  /** Optional: time-block aggregates suitable for Session steps */
  blocks?: GardenWorkBlock[];
};

type GardenScheduledTask = {
  id: string;                         // stable id for task instance
  cropId?: string | null;            // e.g., "tomato_roma_bed_1"
  gardenPlanId?: string | null;      // base plan id
  type:
    | 'sow'
    | 'transplant'
    | 'water'
    | 'weed'
    | 'fertilize'
    | 'prune'
    | 'trellis'
    | 'harvest'
    | 'bedPrep'
    | 'coverCrop'
    | 'toolMaintenance'
    | 'mulch'
    | 'inspect'
    | 'other';

  label: string;                     // user-friendly task label
  notes?: string;                    // additional detail for UI

  /** When and where */
  date: string;                      // ISO date (YYYY-MM-DD)
  startTime?: string | null;         // "HH:MM" 24h local time
  endTime?: string | null;           // "HH:MM", optional
  durationMin: number;               // expected duration in minutes

  location?: {
    bedId?: string | null;
    zone?: string | null;           // "North bed", "Tunnel A", etc.
  };

  /** Guard & blocker hints for SessionRunner */
  blockers?: Array<'inventory' | 'weather' | 'quietHours' | 'sabbath' | 'equipment'>;
  weatherWindow?: {
    minTempF?: number | null;
    maxTempF?: number | null;
    noRain?: boolean;               // avoid during rain
    avoidHighWind?: boolean;
  };

  /** Priority / criticality for rescheduling logic */
  priority: 'critical' | 'high' | 'medium' | 'low';

  /** Traceability: why this exists and what it connects to */
  reasons: Array<{
    kind:
      | 'cropLifecycle'
      | 'routine'
      | 'catchUp'
      | 'manual';
    refId?: string | null;          // cropId, templateId, etc.
    note?: string;
  }>;

  /** Optional integration hints for storehouse/preservation Sessions */
  downstreamHints?: {
    expectHarvestWeightLb?: number | null;
    recommendPreservation?: boolean;
    preservationTypeHints?: Array<'dehydrate' | 'freeze' | 'can' | 'ferment'>;
  };
};

type GardenWorkBlock = {
  id: string;                        // block id
  date: string;                      // ISO date
  label: string;                     // "Morning Garden Block", etc.
  startTime?: string | null;
  endTime?: string | null;
  durationMin: number;               // sum of contained tasks
  taskIds: string[];                 // references to GardenScheduledTask.id
  locationHint?: string | null;      // "South beds", "All tunnels"
  intensity: 'light' | 'moderate' | 'heavy';
  blockers?: GardenScheduledTask['blockers'];
};

type GardenScheduleWarning = {
  code: string;                      // "over_capacity", "frost_risk", etc.
  message: string;
  details?: any;
};

type GardenScheduleError = {
  code: string;                      // "garden.schedule.invalidInput", etc.
  message: string;
  details?: any;
};
Test expectations:

For ok: true, schedule.tasks is an array (possibly empty).

For ok: false, error.code and error.message MUST be present.

3. Inputs
3.1 Input Shape
ts
Copy code
type GardenScheduleInput = {
  /** Next N days/weeks to plan for */
  timeHorizon: {
    from: string;                // ISO date, inclusive
    to: string;                  // ISO date, inclusive
  };

  /** High-level garden plan(s): crop + lifecycle info */
  crops?: GardenCropPlan[];
  /** Raw task templates and routines (may be crop-agnostic) */
  taskTemplates?: GardenTaskTemplate[];
  /** Existing commitments / previously scheduled tasks (avoid double booking) */
  existingTasks?: GardenScheduledTask[];

  /** Context data */
  weather?: GardenWeatherSnapshot;
  availability?: GardenAvailability;
  constraints?: GardenConstraints;
};
3.1.1 Crops & Lifecycle
ts
Copy code
type GardenCropPlan = {
  id: string;                       // cropId
  name: string;                     // "Roma Tomatoes", "Collard Greens"
  kind: 'annual' | 'perennial' | 'coverCrop';
  beds?: string[];                  // bed ids
  sowing: {
    firstSowDate?: string | null;   // recommended base date
    lastSowDate?: string | null;    // for succession end
    successionWeeks?: number | null;// gap between sowings
    indoors?: boolean;              // seed-start vs direct sow
  };
  transplant?: {
    earliestDate?: string | null;
    latestDate?: string | null;
  };
  harvestWindows?: Array<{
    from: string;                   // ISO date
    to: string;                     // ISO date
    expectedWeightLbPerWeek?: number | null;
  }>;
  routineTasks?: Array<{
    kind: GardenScheduledTask['type'];
    intervalDays?: number | null;   // e.g., weed every 7 days
    approxDurationMin?: number;     // per bed or per run
    priority?: GardenScheduledTask['priority'];
  }>;
};
3.1.2 Task Templates
ts
Copy code
type GardenTaskTemplate = {
  id: string;
  label: string;                    // "Deep watering", "Tunnel inspection"
  type: GardenScheduledTask['type'];
  defaultDurationMin: number;
  defaultPriority?: GardenScheduledTask['priority'];

  /** Relative scheduling hints (e.g., weekend-only tasks) */
  preferredDaysOfWeek?: Array<0 | 1 | 2 | 3 | 4 | 5 | 6>; // 0 = Sunday
  preferredTimeOfDay?: 'morning' | 'afternoon' | 'evening' | 'any';

  blockers?: GardenScheduledTask['blockers'];
};
3.1.3 Weather Snapshot
ts
Copy code
type GardenWeatherSnapshot = {
  locationId?: string | null;
  days: Array<{
    date: string;                  // ISO date
    minTempF: number;
    maxTempF: number;
    chanceOfRainPct?: number | null;
    expectedRainInches?: number | null;
    windMph?: number | null;
    conditionsTags?: string[];     // ["frost_risk", "heat_wave", "storm"]
  }>;
};
3.1.4 Availability
ts
Copy code
type GardenAvailability = {
  /** per-day windows of time the user is available for garden work */
  days: Array<{
    date: string;                   // ISO date
    windows: Array<{
      startTime: string;            // "HH:MM"
      endTime: string;              // "HH:MM"
      maxMinutes?: number | null;   // optional override, else derived
    }>;
  }>;

  sabbath?: {
    enabled: boolean;
    dayOfWeek: 5 | 6;               // typically Friday sunset–Saturday sunset
  };

  quietHours?: {
    enabled: boolean;
    startTime: string;              // "HH:MM"
    endTime: string;                // "HH:MM"
  };
};
3.1.5 Constraints
ts
Copy code
type GardenConstraints = {
  maxDailyMinutes?: number | null;   // cap total garden work per day
  maxHeavyMinutesPerDay?: number | null; // for tasks flagged as "heavy"
  equipmentAvailable?: string[];     // e.g., ["broadfork", "tiller", "hoseA"]
  avoidHeatOfDay?: boolean;          // prefer morning/evening in hot climates
  preferWeekendBlocks?: boolean;     // bulk tasks on weekend
};
4. Core Behaviors
4.1 Lifecycle Expansion → Candidate Tasks
Given crops and taskTemplates, the skill must:

Generate candidate tasks across the timeHorizon:

Sowing, transplanting, routine care, and base harvest windows.

Respect crop date windows (firstSowDate, lastSowDate, etc.).

Respect successionWeeks for successive sowings.

Generate non-crop tasks from taskTemplates (e.g., tunnel checks,
irrigation maintenance) following their recommended intervals and
preferred days.

Test expectations:

For a crop with firstSowDate inside the horizon, at least one sowing task
appears.

For successionWeeks > 0, successive sow tasks appear at those intervals,
truncated at lastSowDate or horizon end.

4.2 Weather & Guard-Aware Placement
Candidate tasks must be scheduled into specific dates and time windows using:

Weather snapshot,

Availability,

Constraints,

Guards (Sabbath, quiet hours).

Rules:

Frost-sensitive tasks (e.g., transplant for warm crops):

Avoid days marked with conditionsTags including "frost_risk".

If no frost-safe date exists within horizon:

Place in least risky slot,

Emit warning: code = 'frost_risk'.

Rain-sensitive tasks:

Tasks like watering should be reduced or skipped on days with
high chanceOfRainPct (e.g., ≥ 60%) or high expectedRainInches.

Ground work like sowing may be moved to before/after heavy rain
depending on constraints.

Heat-avoidance (when avoidHeatOfDay is true):

Prefer morning or evening windows on hot days (e.g., maxTempF >= 90).

Sabbath/Quiet Hours:

No tasks scheduled during Sabbath window or quiet hours when enabled.

Tasks that can’t be placed without violating these → emit warning
code = 'no_available_slot'.

Test cases:

Warm crop transplant during forecast frost risk → either moved or flagged.

Watering tasks on heavy rain days → reduced or skipped with reason.

Tasks not placed due to availability/sabbath → warning with affected task ids.

4.3 Workload, Blocks, and Priorities
The scheduler must:

Respect maxDailyMinutes and maxHeavyMinutesPerDay.

Distribute tasks across days to prevent overload.

Group tasks on the same date and similar location/time into GardenWorkBlocks.

Behavior:

For each day in horizon:

Sum candidate task durations.

If over maxDailyMinutes, push lower-priority tasks to subsequent days,
keeping critical tasks first.

Within each day:

Sort tasks by priority, type, and location.

Group into blocks (e.g., “Morning Garden Block”):

tasks that fit together within a window,

ideally same location/zone to minimize walking.

Set GardenWorkBlock.intensity:

Based on tasks’ types and durationMin.

Test expectations:

When multiple days are available, scheduler evens out workload.

Critical tasks (e.g., sowing before last sow date) are kept even if others are
pushed back.

Blocks’ taskIds align with tasks for that date, with duration roughly
matching sum of tasks.

4.4 Priority & Catch-up Mode
If mode = 'catchUp', the skill should:

Identify overdue tasks (e.g., sowings whose firstSowDate is already past)
and mark them as priority: 'critical'.

Attempt to schedule them as soon as possible, subject to guards.

Test cases:

Late sowing with catchUp mode:

Expect a near-term task with priority: 'critical' and a reason indicating
catch-up.

4.5 Harvest & Preservation Hints
During harvest windows:

Generate tasks of type 'harvest' with:

downstreamHints.expectHarvestWeightLb,

downstreamHints.recommendPreservation based on cumulative expected
harvest in a short window.

For high-volume harvests, suggest preservation types:

Leafy veggies → dehydrate or freeze.

Fruit/veg with canning tradition → can or ferment.

Test expectations:

In peak harvest weeks, large expected harvests should generate
recommendPreservation: true.

Downstream hints must be present to enable storehouse/preservation Sessions.

5. Interop with SessionRunner
While garden.schedule does not construct Sessions, its design is intended to
make Session creation trivial.

Example transformation (not implemented here, just for context):

ts
Copy code
const block = schedule.blocks[0];

const session = {
  id: 'sess_garden_' + block.id,
  domain: 'garden',
  title: block.label,
  source: { type: 'gardenPlan', refId: schedule.planId },
  steps: block.taskIds.map((taskId, index) => {
    const task = schedule.tasks.find(t => t.id === taskId);
    return {
      id: task.id,
      title: task.label,
      desc: task.notes || '',
      durationSec: task.durationMin * 60,
      blockers: task.blockers || [],
      metadata: {
        cueNotes: `Location: ${task.location?.bedId || task.location?.zone || 'garden'}`,
      },
    };
  }),
  // prefs, status, progress, analytics, timestamps...
};
Tests should verify that:

Each GardenWorkBlock contains enough structured information
(taskIds, durationMin, blockers) to build a valid Session.

6. Blockers & Guards (Garden Context)
Tasks and blocks can carry blockers to be enforced by SessionRunner:

weather — used for real-time checks (e.g., storm started unexpectedly).

quietHours — avoid noise (tillers, loud tools).

sabbath — to prevent launching non-essential garden Sessions during Sabbath.

equipment — ensures that underlying equipment (e.g., broadfork, irrigation
line) is available and functional.

inventory — ensures that required inputs (seed, compost, amendments) exist.

The scheduler is responsible for populating these hints where applicable;
enforcement happens in guards/SessionRunner.

7. Error Handling & Warnings
7.1 Invalid Input
GIVEN:

input is null/undefined,

timeHorizon missing or invalid (from > to),

availability.days is not an array when provided,

THEN:

Return:

ts
Copy code
{
  ok: false,
  error: {
    code: 'garden.schedule.invalidInput',
    message: string,
    details: { /* which part was invalid */ }
  }
}
7.2 Partial Data Warnings
No crops AND no taskTemplates →

ok: true with empty schedule, plus warning
code = 'no_garden_tasks'.

Weather missing or only partial →

code = 'missing_weather'.

Tasks that could not be placed due to capacity or availability →

code = 'no_available_slot' with a list of affected task ids.

Frost/heat risk conflicts →

code = 'frost_risk', code = 'heat_stress_risk'.

The function should still return ok: true where possible and surface
warnings.

8. Determinism & Purity
8.1 Deterministic
For the same input:

garden.schedule must produce the same GardenSchedule (task/block
ordering should be stable and predictable).

Tests may compare JSON outputs to verify determinism.

8.2 No Side Effects
garden.schedule must not:

Read/write Dexie,

Emit on the global eventBus,

Trigger notifications, TTS, or UI updates,

Create or mutate Sessions.

It should be implemented as a pure function:

ts
Copy code
function scheduleGarden(input: GardenScheduleInput): GardenScheduleResult;
9. Example Test Scenarios (Checklist)
Single crop, simple sow + harvest

timeHorizon covers sowing and first harvest window.

Expect one sow task, at least one harvest task, and reasonable durations.

Succession planting

Crop with firstSowDate, lastSowDate, successionWeeks = 2.

Expect multiple sow tasks spaced 2 weeks apart within horizon.

Routine care + availability

Weed every 7 days; maxDailyMinutes small.

Expect weed tasks distributed, not all packed into one day, respecting
availability windows.

Weather constraints

Forecast frost risk on a transplant day.

Expect transplant scheduled on a non-frost day or warning frost_risk.

Sabbath & quiet hours

Availability windows overlapping Sabbath or quiet hours.

Expect no tasks during restricted times; if impossible, warning
no_available_slot.

Catch-up mode

mode = 'catchUp' with overdue sowing.

Expect urgent tasks marked as priority: 'critical' placed at earliest
possible slots.

High harvest output

Harvest window with large expected weekly lbs.

Expect harvest tasks with recommendPreservation: true and preservation
type hints.

No crops, only templates

taskTemplates for inspection and irrigation, no crops.

Expect schedule of generic tasks; warning may or may not be needed,
depending on design choice (document your behavior).

Invalid input

timeHorizon missing from or to.

Expect ok: false, error.code = 'garden.schedule.invalidInput'.

With these behaviors, the garden.schedule skill becomes a core component of
SSA’s “Garden Now” experience:

Orchestrators call it when garden plans, weather, or availability change.

Domain pages surface Next Garden Block CTAs.

SessionRunner then executes the work with wake-lock, notifications,
guards, and Hub export, while this skill remains a pure, testable planner.
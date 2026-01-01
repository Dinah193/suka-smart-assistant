# Movement Intensity Calculator

> `src/features/calculators/health/MovementIntensityCalculator/`

The **Movement Intensity Calculator** is SSA’s movement “brain” for turning
everyday activity patterns (steps, chores, garden work, animal care, etc.)
into:

- a **movement intensity score** and category (below / on-track / above target),
- **weekly movement minutes targets** (light / moderate / vigorous),
- **recovery & load flags** (overreaching / undertraining / recovery day),
- **calorie and load estimates** for planning nutrition,
- **movement session templates** that can be transformed into
  SessionRunner-ready sessions (including household tasks).

It is a **shim-based calculator** designed to run safely in the background
(worker/automation) while your React UI uses simple hooks and views.

---

## Files in This Folder

### 1. `MovementIntensityCalculator.config.json`

**Role:** Planning Graph + feature config for the calculator node.

Key pieces:

- `nodeId`: `"health.movementIntensityCalculator"`
- `label`, `description`, `tags`: used by the calculator launcher / search.
- `graph`:
  - `role: "source"`: produces movement metrics used by other nodes.
  - `provides`:
    - `movementIntensityScore`
    - `movementMinutesTargets`
    - `recoveryLoadFlags`
    - `movementSessionTemplates`
  - `consumes`:
    - `bodyWeight`
    - `baselineActivityPatterns`
    - `healthRiskFlags`
    - `sleepQualityFlags`
  - `nextStepsNodeId`: `"health.movementIntensityCalculator.nextSteps"`
- `events`:
  - `onCalculate`: `["calculator.movementIntensity.calculated"]`
  - `onError`: `["calculator.movementIntensity.error"]`
- `ux`:
  - `"group": "Health & Body"`
  - `"showInQuickLaunch": true` so it appears as a quick calculator.
- `integration`:
  - Since this calculator connects heavily to movement and household tasks,
    downstream nodes (planner, calendar, health goals) can rely on the
    `provides` keys for consistent data.

You rarely need to touch this file except to change labels, tags,
or Planning Graph relationships.

---

### 2. `MovementIntensityCalculator.schema.json`

**Role:** JSON schema for **inputs** and **outputs**. This schema describes the
payload shape the shim expects and produces.

**Important sections:**

- `input`:
  - `unitSystem`: `"imperial" | "metric"`
  - `bodyWeight`, `age`, `restingHeartRate`
  - `baselineStepGoalPerDay`
  - `movementPreferences`:
    - `preferredSessionBlockMinutes`
    - `maxSessionsPerDay`
    - `indoorOnly`
  - `stepHistory`: 7-day (or more) entries:
    - `date`, `steps`, `activeMinutesLight`, `activeMinutesModerate`,
      `activeMinutesVigorous`, `avgHeartRate`
  - `sessionHistory`: recent completed sessions (optional).
  - `healthRiskFlags` & `sleepQualityFlags`.

- `output`:
  - `movementIntensityScore` (0–100)
  - `movementIntensityCategory` (`"below" | "on-track" | "above"`, plus finer
    categories if added later)
  - `movementMinutesTargets`:
    - `lightMinutesPerWeek`
    - `moderateMinutesPerWeek`
    - `vigorousMinutesPerWeek`
    - `combinedGuidelineEquivalentMinutesPerWeek`
    - `deficitToGuidelineMinutes`
  - `calorieAndLoadEstimates`:
    - `estimatedDailyActivityCalories`
    - `estimatedWeeklyActivityCalories`
  - `recoveryLoadFlags`:
    - `overreachingRisk`
    - `undertrainingRisk`
    - `recoveryDayRecommended`
    - `notes`
  - `movementSessionTemplates`: array of reusable templates:
    - `templateId`, `title`, `durationMinutes`, `intensityCategory`,
      `recommendedPerWeek`, `source` info, etc.

**Why it matters:**  
The schema keeps React, shims, automation, and workers speaking the same data
language, and makes it easy to evolve without breaking existing users.

---

### 3. `MovementIntensityCalculator.shim.js`

**Role:** The **core movement reasoning engine**, written as a **shim module**
instead of a traditional “AI Agent”.

Key responsibilities:

- Accepts validated input (matching the schema).
- Computes:
  - intensity score + category,
  - minute targets,
  - recovery flags,
  - calorie estimates,
  - movement session templates.
- Emits SSA events via `eventBus`:
  - `calculator.movementIntensity.calculated`
  - `calculator.movementIntensity.error`
- Optionally exports to the Family Fund Hub if `familyFundMode === true` by
  calling `exportToHubIfEnabled(payload)`.

Exports:

- `NODE_ID`: `"health.movementIntensityCalculator"`
- `MovementIntensityCalculatorShim.run(input, options?)`:
  - `options.exportToHub?: boolean` (default `false`).
  - Returns a `{ nodeId, input, output, meta }` payload.
- `runMovementIntensityCalculatorShim(input, options?)`: thin convenience
  wrapper used by the view.

**Background / session resilience:**

- The shim is **pure logic** plus event/Hub calls—safe to run:
  - in React,
  - in Web Workers,
  - from the automation runtime.
- Because it doesn’t rely on React state, it can continue working even if UI
  pages change or reload; only the orchestrator needs to re-invoke it.

---

### 4. `MovementIntensityCalculator.view.jsx`

**Role:** UI form + results view for the movement calculator.

Key behavior:

- Manages a friendly, low-friction input form:
  - Body basics (unit system, weight, age, resting HR).
  - Simple 7-day movement summary:
    - average steps per day,
    - weekly light/moderate/vigorous minutes.
  - Health risk and sleep flags.
  - Movement preferences (session length, max sessions, indoor-only).
  - Export to Hub toggle.
- Builds a synthetic `stepHistory` from the simple weekly summary and passes
  it into the shim.
- Calls `runMovementIntensityCalculatorShim(input, { exportToHub })` when
  the user clicks **Calculate Movement Intensity**.
- Persists `input` and `result` to `localStorage` using the key:
  - `ssa.movementIntensityCalculator.state`
- Displays:
  - intensity score + category,
  - daily/weekly activity calories,
  - weekly minutes targets,
  - recovery flags,
  - movement session templates (with a placeholder button for “Start via
    Movement Planner” that your planner/SessionRunner code can wire later).

**Important note:**  
The view **does not** directly invoke SessionRunner. It only exposes data
so that your **session planner** / **“Now” CTA** can create sessions from
templates and pass them into SessionRunner.

---

### 5. `MovementIntensityCalculator.hooks.js`

**Role:** Shared hooks that connect the shim to SSA’s planners and
SessionRunner.

Contains:

1. `useMovementIntensityCalculator(options?)`
   - Wraps the shim with React state:
     - `input`, `setInput`
     - `result`
     - `status`, `error`
     - `exportToHub`, `setExportToHub`
   - Provides a `run()` function to execute the calculation.
   - Optional `autoRun` mode (debounced) for planner dashboards.
   - Emits `calculator.movementIntensity.error` if something goes wrong.

2. `buildMovementSessionFromTemplate(template, options?)`
   - Converts a shim template into a **SessionRunner session draft**:
     - `domain: "movement"` (an extension domain for your sessions store)
     - single step with friendly description and timer-based cue.
   - Returns a fully formed session object matching the SSA session contract.

3. `useMovementSessionDrafts(calculatorResult, options?)`
   - Reads the `movementSessionTemplates` from `calculatorResult`.
   - Builds an array of SessionRunner-ready drafts with
     `buildMovementSessionFromTemplate`.
   - Exposes `buildFromTemplateId(templateId)` to generate one draft on
     demand (e.g., from a “Now” button).

4. `useMovementGoalSignals(calculatorResult)`
   - Derives:
     - `status`: `"below" | "on-track" | "above"`
     - guideline target minutes,
     - actual equivalent minutes,
     - deficit minutes,
     - recovery info.
   - Exposes `emitGoalUpdate()` that triggers
     `planner.movementGoals.updated` via `eventBus`.

**Usage idea:**

- A dashboard can:
  - call `useMovementIntensityCalculator(autoRun: true)`,
  - call `useMovementGoalSignals(result)` to show traffic-light style status,
  - call `useMovementSessionDrafts(result)` to show suggested “Start Now”
    movement session buttons.

---

### 6. `MovementIntensityCalculator.mappings.json`

**Role:** Next Steps & Planner integration mapping.

This file tells the Planning Graph **what to do with the calculator results**:

- `nodeId`: `"health.movementIntensityCalculator.nextSteps"`
- `goalStatusRouting`: mapping from `"below" | "on-track" | "above"` to:
  - human-readable labels,
  - descriptions,
  - recommended flows (e.g., light household movement, short walks, recovery
    focus).
- `intensityToDomainMappings`: maps:
  - `"light"` → gentle household sessions like room reset, garden walk, pantry
    walkthrough, easy walk.
  - `"moderate"` → more demanding chores and animal care circuits.
  - `"vigorous"` → focused movement sessions (intervals, cardio circuits).
- `sessionBuilderMappings`: presets for building SessionRunner drafts:
  - `movement.lightHouseholdStack`
  - `movement.moderateChoresPlusWalk`
  - `movement.vigorousIntervals`
- `plannerIntegration`:
  - declares that movement templates support SessionRunner,
  - lists preferred planner nodes:
    - `"sessions.sessionPlanner"`
    - `"calendar.activityPlanner"`
    - `"health.movementGoals"`
  - defines the exports/imports used by planners and guards.

---

## How This Calculator Connects to the Rest of SSA

### Planning Graph

- **Source node:** `health.movementIntensityCalculator`
- **Next steps node:** `health.movementIntensityCalculator.nextSteps`
- **Downstream consumers:**
  - Movement goals / health dashboards,
  - Household Session Planner (cleaning/garden/animals),
  - Calendar / Activity Planner,
  - Macro and Micronutrient calculators (via calorie/load estimates).

### SessionRunner & “Now” Buttons

1. **User runs the calculator** from the health calculators area.
2. The shim computes results and emits `calculator.movementIntensity.calculated`.
3. Planners read:
   - `movementMinutesTargets` and `recoveryLoadFlags` to adjust suggested
     sessions.
   - `movementSessionTemplates` to create session drafts with
     `buildMovementSessionFromTemplate`.
4. Drafts are stored in the sessions store with:
   - `domain: "movement"`,
   - `source.type: "movementPlan"`.
5. Any domain page with a “Now” CTA can:
   - look for the next runnable **movement** session,
   - pass it into **SessionRunner** just like cooking/cleaning sessions,
   - respect guards (weather, quiet hours, Sabbath) as appropriate.

### Hub / Family Fund Mode

When `familyFundMode === true` **and** `exportToHub` is enabled:

- `MovementIntensityCalculator.shim` wraps its results in a Hub envelope via
  `HubPacketFormatter`.
- Attempts to send via `FamilyFundConnector`.
- On success, emits `session.exported` (via the higher-level automation or
  planner logic that packages session drafts and analytics together).

This allows a Family Fund / community dashboard to see members’ movement
patterns at a high level (e.g., “how active are households, in general?”),
without needing raw personal health data.

---

## Typical Usage Patterns

### A. Simple Health Calculator Page

1. Render `MovementIntensityCalculatorView`.
2. User fills in approximate steps + minutes per week and health/sleep flags.
3. User clicks **Calculate Movement Intensity**.
4. View shows:
   - intensity score,
   - targets,
   - recovery hints,
   - suggested sessions.

No SessionRunner integration required to get value.

---

### B. Planner Dashboard with Auto-Run

1. A health dashboard uses:

   ```js
   const {
     input,
     setInput,
     result,
     status,
     error,
     run,
   } = useMovementIntensityCalculator({ autoRun: true });
It passes persistent / imported movement logs into setInput.

autoRun re-calculates whenever input changes.

It uses useMovementGoalSignals(result) to show a simple “Below / On Track / Above” indicator.

It uses useMovementSessionDrafts(result) to:

list suggested movement templates,

build session drafts that can be launched via SessionRunner.

C. “Movement Now” Button
A Movement or Health page can:

Use useMovementSessionDrafts(result) to generate draft sessions.

Pick the highest priority draft (or let the user choose).

Hand the draft to your existing session creation/SessionRunner entry point.

This keeps all movement logic in the shim + hooks while the SessionRunner
remains a shared, domain-agnostic execution engine.

Extending the Movement Calculator
Add new risk flags or sleep signals:

Extend the schema input,

Incorporate them in the shim’s scoring logic,

Surface them in the view and hooks if needed.

Add new session templates:

Extend the shim output movementSessionTemplates,

Optionally extend MovementIntensityCalculator.mappings.json with new
examples and presets,

Reuse buildMovementSessionFromTemplate or add a variant.

Connect to device / app data:

A sync worker can transform wearable logs or phone step counts into the
schema’s stepHistory and feed it into the shim via the hooks.

Because this feature is shim-based and event-driven, you can evolve it without
breaking existing calculators, planners, or sessions.
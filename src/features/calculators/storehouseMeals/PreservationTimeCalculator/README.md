# PreservationTimeCalculator

**Path:**  
`src/features/calculators/storehouseMeals/PreservationTimeCalculator/`

This feature calculates **safe preservation times** (canning, dehydrating, curing, smoking, freezing-prep) and turns those results into **actionable preservation sessions** that can be run with the global **SessionRunner** in Suka Smart Assistant (SSA).

The calculator is designed to:

- Help you decide *how long* each preservation method should run for a given food, volume, and altitude.
- Turn those timing results into **planned preservation sessions** (with timers, step breakdowns, and guard checks).
- Feed results into **freezer inventory**, **storehouse inventory**, and **calendar/SessionRunner** so nothing gets lost.

---

## Files in this feature

- `PreservationTimeCalculator.config.json`  
  Planning Graph **node config** wiring this calculator into the SSA Planning Graph (how the node is identified and connected).

- `PreservationTimeCalculator.schema.json`  
  JSON Schema describing **inputs and outputs** for this calculator. Keeps the data contract explicit and makes it easier to validate and extend.

- `PreservationTimeCalculator.shim.js`  
  **Shim logic module** that:
  - Accepts normalized calculator inputs.
  - Calculates preservation times and recommended step breakdowns.
  - Emits SSA events and can run in the background while the user navigates.

- `PreservationTimeCalculator.view.jsx`  
  React UI for:
  - Entering / editing preservation parameters.
  - Viewing computed times, step breakdowns, and safety notes.
  - Launching preservation sessions via “Run Now” / “Schedule” style CTAs.

- `PreservationTimeCalculator.hooks.js`  
  React hooks that:
  - Orchestrate data flow between the view, the shim, and Dexie.
  - Convert calculator outputs into **SessionRunner-ready** session objects.
  - Integrate with inventory, freezer, and storehouse modules.

- `PreservationTimeCalculator.mappings.json`  
  Planning Graph **Next Steps mappings** that:
  - Define what can happen *after* you run the calculator.
  - Connect to freezer inventory, storehouse inventory, batch cooking, and calendar scheduling.

- `README.md`  
  (This file) Documentation for how preservation timing is calculated and how the feature fits into SSA.

---

## 1. Conceptual model

PreservationTimeCalculator answers the question:

> “Given this food, this volume, this method, and my conditions, **how long** should I safely preserve it and **how should I plan the session**?”

Core responsibilities:

1. **Normalize inputs**  
   Convert user- or system-provided data into a consistent model:
   - Method: `water-bath`, `pressure-can`, `dehydrate`, `cure`, `smoke`, `freeze`, etc.
   - Food type: fruit, vegetables, meats, stocks, sauces, etc.
   - Volume / load: jar size, number of jars, tray area, weight, or bulk volume.
   - Altitude: used to adjust hold times and sometimes temperatures.
   - Target dryness/cure level: for dehydrating and curing.

2. **Apply rules / tables**  
   Use simple, explicit rules to derive:
   - **Ramp up time** (heating, bringing up to pressure, preheating dehydrator, etc.).
   - **Hold time** (time at target pressure/temperature/cure environment).
   - **Cool down / resting time** (cooling jars, equalizing moisture, resting cured meat).

3. **Produce structured outputs**  
   - Total session time in minutes.
   - Step-by-step breakdown that can be turned into a SessionRunner session.
   - Safety flags (e.g., altitude adjustments, jar too large for method, missing pressure canner, etc.).

4. **Emit events and integrate**  
   - Emit events via `eventBus` so other parts of SSA can react.
   - Feed outputs into Planning Graph to guide the user to the next step (log to freezer, update storehouse, schedule later, etc.).

---

## 2. Input data contract (high level)

The schema (`PreservationTimeCalculator.schema.json`) defines a structured input object. In plain language, you can think of the **input** as:

```json
{
  "method": "pressure-can",
  "foodType": "low-acid-vegetable",
  "batch": {
    "jarSize": "quart",
    "jarCount": 7,
    "packedVolumeLiters": 6.6
  },
  "environment": {
    "altitudeFt": 1200,
    "ambientTempF": 75
  },
  "targets": {
    "dehydrationLevel": null,
    "cureLevel": null
  }
}
Key concepts:

method
Preservation technique. Affects temperature profile and whether altitude adjustments are required.
Examples: water-bath, pressure-can, dehydrate, cure, smoke, freeze.

foodType
Used to distinguish between high-acid vs low-acid, meat vs vegetable, etc. This allows different baseline times.

batch

jarSize or trayAreaSqIn or weightLbs (depending on method).

jarCount or pieceCount.

packedVolumeLiters or similar volume metric.

environment

altitudeFt to adjust for boiling point and pressure.

ambientTempF (optional) for some nuanced timing or warnings.

targets

dehydrationLevel: e.g. “crisp”, “leathery”, “pliable”.

cureLevel: e.g. “partial-dry”, “fully-cured”.

All of this is captured formally in the JSON Schema so it can be validated, but the above is the mental model for working with the calculator.

3. Output data contract (high level)
The calculator returns an object with timing and session-related data.

Example:

json
Copy code
{
  "method": "pressure-can",
  "foodType": "low-acid-vegetable",
  "altitudeFt": 1200,
  "batch": {
    "jarSize": "quart",
    "jarCount": 7,
    "packedVolumeLiters": 6.6
  },
  "timing": {
    "rampUpMinutes": 15,
    "holdMinutes": 30,
    "coolDownMinutes": 45,
    "totalMinutes": 90
  },
  "sessionSteps": [
    {
      "id": "step-prepare-equipment",
      "title": "Prepare jars and pressure canner",
      "desc": "Check jars, lids, and gaskets. Add water to canner and preheat.",
      "durationSec": 900,
      "blockers": ["inventory", "equipment"],
      "metadata": {
        "tempTargetF": 0,
        "donenessCue": "timer",
        "cueNotes": "Preparation only; no critical temperature yet."
      }
    },
    {
      "id": "step-hold-at-pressure",
      "title": "Hold at pressure",
      "desc": "Maintain recommended pressure for the full hold time.",
      "durationSec": 1800,
      "blockers": ["equipment", "quietHours", "sabbath"],
      "metadata": {
        "tempTargetF": 240,
        "donenessCue": "timer",
        "cueNotes": "Pressure and time must both be maintained for safety."
      }
    }
  ],
  "safetyFlags": [
    "ALTITUDE_ADJUSTED",
    "LOW_ACID_PRESSURE_REQUIRED"
  ],
  "notes": [
    "Times are baseline approximations for planning and should be confirmed against a trusted preservation guide.",
    "Altitude adjustment of +5 minutes was applied based on altitudeFt."
  ]
}
This structure is what:

PreservationTimeCalculator.hooks.js uses to build a SessionRunner session object.

PreservationTimeCalculator.mappings.json uses to determine Next Steps actions.

4. Calculation logic (how times are derived)
The shim (PreservationTimeCalculator.shim.js) uses a rule-based approach rather than “magic numbers” buried in the UI.

At a high level:

Determine base hold time by method + foodType + jarSize / load

For example, a low-acid vegetable in quart jars might have a base hold time of 25 minutes at pressure.

A dehydrated apple slice tray may have a base time of 360 minutes (6 hours) at a given temperature.

Adjust for altitude

If altitudeFt is above certain thresholds, the calculator:

Increases hold time by rule.

May also set flags such as ALTITUDE_ADJUSTED.

These adjustments are intentionally simple and readable so you can override or refine them later.

Add ramp-up and cool-down

Ramp-up approximates:

Bringing jars to a boil.

Bringing a pressure canner up to pressure.

Bringing a dehydrator up to operating temperature.

Cool-down approximates:

Letting pressure drop naturally.

Allowing jars to cool and seal.

Allowing dehydrated or cured goods to rest.

Construct session steps

Each logical phase (prep, load, ramp, hold, cool, store) is mapped to a session step.

Each step is compatible with the global SessionRunner contract:

id, title, desc

durationSec

blockers (inventory, equipment, quiet hours, sabbath, etc.)

metadata for temperature targets and cues.

This makes it easy for the SessionRunner to:

Track progress.

Emit events (session.step.changed, session.completed, etc.).

Persist checkpoints in Dexie every step / every 10 seconds.

5. How this integrates with SessionRunner
While the calculator itself is “just math + structure,” it is designed to fit directly into the global session system:

Hooks build a session object:

js
Copy code
{
  id: "session-preservation-<timestamp>",
  domain: "preservation",
  title: "Run preservation session",
  source: { type: "manual", refId: null },
  steps: [ /* derived from sessionSteps */ ],
  prefs: { voiceGuidance: true, haptic: true, autoAdvance: false },
  status: "pending",
  progress: { currentStepIndex: 0, elapsedSec: 0, startedAt: null, pausedAt: null },
  analytics: { skippedSteps: [], adjustments: [] },
  createdAt: "<ISO>",
  updatedAt: "<ISO>"
}
That session is passed to SessionRunner, which:

Keeps timers running via Web Worker, even if the user navigates.

Uses Wake Lock to keep screen awake where supported.

Sends notifications with next-step hints and actions.

Can show a mini “always-visible” Picture-in-Picture window where supported.

When the session completes or is aborted:

SessionRunner emits session.completed / session.aborted.

If familyFundMode === true, a Hub packet can be created and exported to the Family Fund Hub.

6. Planning Graph and Next Steps
PreservationTimeCalculator.config.json and PreservationTimeCalculator.mappings.json connect this calculator into the broader Planning Graph.

Typical next steps after running the calculator:

Run preservation session now
→ create a SessionRunner session and open the modal.

Log preserved items into freezer inventory
→ create freezer entries with the calculated method and suggested “use by” dates.

Log shelf-stable items into storehouse
→ record jars / cured goods with locations and categories.

Sync with batch cooking
→ attach preservation timing to existing or planned batch cooking sessions.

Schedule for later
→ add a preservation block into the calendar (respecting quiet hours and Sabbath).

This keeps preservation tightly integrated with meal planning, batch cooking, and storehouse/inventory management instead of being an isolated calculator.

7. Safety and disclaimers
This calculator is meant to be:

A planning tool and time organizer.

An aid for coordinating sessions, equipment, and household flow.

It is not a replacement for:

Official food safety tables.

Extension service guidelines.

Trusted canning / preserving handbooks.

You should:

Treat the calculator’s times as baselines.

Confirm final times and methods against authoritative food safety references.

The design of the calculator (centralized rules in the shim, explicit flags, and a clear schema) is meant to make it easy to:

Swap in more authoritative tables.

Tune rules for your household.

Add new methods safely.

8. Extending this calculator
You can extend this feature by:

Adding new methods
e.g. ferment, confit, oil-preserve, with their own timing logic.

Enriching the schema
e.g. adding phLevel, saltPct, sugarPct, or cutThicknessMm.

Improving rules
Replacing placeholder constants with values from trusted tables or future data imports.

Deeper integration

Link to Black Hair Nutrition and cost-per-serving nodes to prioritize preserving high-value foods.

Attach educational content (tooltips, “learn why” links) to the view.

Because everything is centered on a clean schema and shim logic layer, these changes are low-risk and local.

9. Summary
PreservationTimeCalculator is the timing brain for your preservation workflows in SSA. It:

Normalizes inputs (method, food, volume, environment).

Calculates ramp-up, hold, and cool-down times.

Builds SessionRunner-compatible steps.

Connects into freezer and storehouse inventory, batch cooking, and calendar.

Respects the global session architecture: wake-lock, notifications, Dexie persistence, and Hub export.

Use this README as your reference when:

Updating the timing rules in PreservationTimeCalculator.shim.js.

Wiring new Next Steps in PreservationTimeCalculator.mappings.json.

Adjusting the schema or view to support new methods or household practices.
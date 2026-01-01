# Calculators Service

Location:

- `src/services/calculators/*`

This folder holds the shared “calculator engine” for SSA. It lets you:

- Define **household-aware calculators** (macros, seed viability, meat breakdown, budget, etc.).
- Run them through a **standard runner**.
- Validate input/output against **JSON Schemas**.
- Persist results for **re-use and Planning Graph**.
- Emit **events** for analytics, Stability, automation, and session creation.

It’s designed so any feature (health, garden, storehouse, animals, stability, etc.) can plug in new calculators without re-inventing glue code.

---

## 1. Core Modules

### 1.1 `calculatorRegistry.js`

**Purpose:** Central map from `calculatorId` → **shim** + **view** + metadata.

Typical shape (simplified):

```js
// Pseudo example – actual keys live in calculatorRegistry.js
const REGISTRY = {
  "health.macro": {
    id: "health.macro",
    label: "Daily Macro Needs",
    category: "health",
    shimLoader: () =>
      import("@/features/calculators/health/MacroCalculator.shim"),
    viewLoader: () =>
      import("@/features/calculators/health/MacroCalculator.view"),
    // optional hints
    tags: ["nutrition", "planningGraph"],
  },
  // ...more calculators
};
Key ideas:

calculatorId is the stable key used everywhere ("health.macro", "garden.seedViability", etc.).

shimLoader points to the logic (pure functions, no React).

viewLoader points to the UI (React component).

You extend SSA by adding new entries here rather than wiring every calculator manually all over the app.

1.2 calculatorRunner.js
Purpose: Standard interface for executing calculators and getting a normalized result.

You usually use:

js
Copy code
import { runCalculator } from "@/services/calculators/calculatorRunner";

const context = {
  userId: currentUser.id,
  householdId: currentHousehold.id,
  sessionDomain: "storehouse", // optional
  env: { locale: "en-US" },
};

const { result, diagnostics } = await runCalculator(
  "health.macro",
  inputPayload,
  context
);
Responsibilities:

Resolve shim from calculatorRegistry.

Optionally validate input (calculatorValidation.js).

Run the shim’s run() function with a consistent context object.

Normalize/annotate the result (result, warnings, durationMs, etc.).

Emit calculator events (calculatorEvents.js).

Optionally stitch results into a Session that can be handed off to the SessionRunner (e.g. “prep 10 freezer meals now”).

1.3 calculatorResultStore.js
Purpose: Helper for saving/loading calculator results (Dexie or in-memory fallback).

Usage:

js
Copy code
import {
  saveCalculatorResult,
  getMostRecentCalculatorResult,
} from "@/services/calculators/calculatorResultStore";

const record = await saveCalculatorResult("health.macro", {
  input,
  result,
  context,
  label: "Current macro plan",
  tags: ["health", "daily"],
});

const lastRun = await getMostRecentCalculatorResult("health.macro");
Responsibilities:

Persist results in Dexie store calculatorResults (configure in your DB).

Provide convenient APIs to:

Save a result.

Fetch by ID.

List results per calculator.

Get the most recent run.

Delete/clear results.

Emit result events (calculator.result.saved, calculator.result.deleted, etc.).

1.4 calculatorEvents.js
Purpose: Standardized event vocabulary for all calculator-related analytics and automation.

Exports helpers like:

emitCalculatorOpened

emitCalculatorInputChanged

emitCalculatorRunRequested

emitCalculatorRunStarted

emitCalculatorRunCompleted

emitCalculatorRunFailed

emitCalculatorSessionCreated

emitCalculatorResultSaved

emitCalculatorResultLoaded

emitCalculatorResultDeleted

Event shape is consistent with SSA’s event bus:

js
Copy code
{
  type: "calculator.completed",
  ts: "2025-11-25T12:34:56.789Z",
  source: "calculator.runner",
  data: {
    calculatorId: "health.macro",
    valid: true,
    // ...
  },
}
The automation runtime and Stability engine can subscribe to these events to power:

Dashboards (how often each calculator is used).

“Now” session suggestions.

Warnings when certain calculators fail frequently.

1.5 calculatorValidation.js
Purpose: Validate calculator inputs and outputs against JSON Schemas.

Key exports:

registerCalculatorSchemas(calculatorId, { inputSchema, outputSchema })

validateCalculatorInput(calculatorId, data, options?)

validateCalculatorOutput(calculatorId, data, options?)

ensureValidCalculatorInputOrThrow(calculatorId, data, options?)

ensureValidCalculatorOutputOrThrow(calculatorId, data, options?)

Notes:

If ajv is installed, the module uses Ajv to validate full JSON Schemas.

If not, it falls back to a simple “type + required fields” check.

Emits:

calculator.validation.input

calculator.validation.output

These events can feed into Stability dashboards (e.g., “this calculator fails input validation 30% of the time”).

2. Calculator Lifecycle
This section shows how all the pieces work together.

2.1 Typical end-to-end flow
User opens a calculator UI

A domain page (e.g. Health, Garden, Storehouse) loads a calculator view via calculatorRegistry.

UI calls emitCalculatorOpened({ calculatorId, context, inputDefaults }).

User edits inputs

Debounced change events call emitCalculatorInputChanged({ calculatorId, input, context }).

UI may also call validateCalculatorInput on the fly to show field errors.

User hits “Calculate”

UI calls emitCalculatorRunRequested(...).

UI then calls runCalculator(calculatorId, input, context).

Runner executes shim

calculatorRunner validates input (if schema registered).

Loads shim module via shimLoader.

Calls shim’s run({ input, context }).

Captures result + diagnostics.

Emits:

calculator.started

calculator.completed or calculator.failed.

Result persistence (optional but recommended)

Use saveCalculatorResult(calculatorId, { input, result, context, label, tags }).

calculatorResultStore writes to Dexie and emits calculator.result.saved.

Automation & Sessions (optional)

Shim or runner may produce a “session-ready” payload (e.g., tasks for batch cooking, garden prep, preservation steps).

calculatorEvents.emitCalculatorSessionCreated(...) emits calculator.session.created and session.created.fromCalculator.

Automation runtime or domain UI can show a “Run this as a Session Now” button to open the SessionRunner modal.

Stability & Planning Graph

Calculator events and result records feed into:

Stability dashboards (e.g., “nutrition stability score”).

Planning Graph nodes (e.g., seed viability → garden planning → yield → storehouse stock).

3. Adding a New Calculator
Use this checklist when adding another calculator (e.g. “Daily Micronutrient Requirements” or “Seed Viability”):

3.1 Choose a calculator ID
Pick a stable, namespaced ID:

health.micronutrients.daily

garden.seedViability

storehouse.mealCoverage

animals.meatBreakdown

This ID:

Will be used in routes, buttons, and analytics.

Must match what you register in calculatorRegistry.

3.2 Create the shim (logic only)
Create a file like:

src/features/calculators/health/MicronutrientCalculator.shim.js

Outline:

js
Copy code
// MicronutrientCalculator.shim.js

/**
 * Pure calculator logic.
 * No React, no DOM, no side effects beyond returning a result.
 */

export async function run({ input, context }) {
  // TODO: implement your domain-specific logic
  // input: raw form data
  // context: userId, householdId, env, etc.

  const result = {
    // normalized numeric or structured results
  };

  return {
    result,
    warnings: [],
    meta: {
      // anything helpful for UI (e.g., derived categories)
    },
  };
}

/**
 * Optional: static metadata, used by dashboards/menus.
 */
export function describe() {
  return {
    id: "health.micronutrients.daily",
    label: "Daily Micronutrient Requirements",
    category: "health",
    tags: ["nutrition", "planningGraph"],
  };
}
The shim must not touch React or browser APIs; it’s safe to run in workers if desired.

3.3 Create the view (React component)
Create:

src/features/calculators/health/MicronutrientCalculator.view.jsx

Outline:

jsx
Copy code
import React, { useState } from "react";
import { runCalculator } from "@/services/calculators/calculatorRunner";
import { saveCalculatorResult } from "@/services/calculators/calculatorResultStore";
import {
  emitCalculatorOpened,
  emitCalculatorRunRequested,
} from "@/services/calculators/calculatorEvents";

const CALCULATOR_ID = "health.micronutrients.daily";

export default function MicronutrientCalculatorView({ context }) {
  const [input, setInput] = useState({});
  const [result, setResult] = useState(null);
  const [errors, setErrors] = useState([]);
  const [isRunning, setIsRunning] = useState(false);

  React.useEffect(() => {
    emitCalculatorOpened({ calculatorId: CALCULATOR_ID, context, inputDefaults: input });
  }, [context]);

  async function handleRun() {
    emitCalculatorRunRequested({ calculatorId: CALCULATOR_ID, context, input });
    setIsRunning(true);
    setErrors([]);

    try {
      const { result, diagnostics } = await runCalculator(
        CALCULATOR_ID,
        input,
        context
      );

      setResult(result);

      await saveCalculatorResult(CALCULATOR_ID, {
        input,
        result,
        context,
        label: "Latest micronutrient plan",
      });

      if (diagnostics && diagnostics.validationErrors?.length) {
        setErrors(diagnostics.validationErrors);
      }
    } catch (err) {
      setErrors([{ path: "", message: String(err.message || err) }]);
    } finally {
      setIsRunning(false);
    }
  }

  return (
    <div className="calculator-card">
      {/* Your form, fields, and result display go here */}
      <button onClick={handleRun} disabled={isRunning}>
        {isRunning ? "Calculating..." : "Calculate"}
      </button>

      {/* Example: show errors and result */}
    </div>
  );
}
3.4 Register the calculator
Open:

src/services/calculators/calculatorRegistry.js

Add an entry:

js
Copy code
// Inside the registry map/object

"health.micronutrients.daily": {
  id: "health.micronutrients.daily",
  label: "Daily Micronutrient Requirements",
  category: "health",
  shimLoader: () =>
    import("@/features/calculators/health/MicronutrientCalculator.shim"),
  viewLoader: () =>
    import("@/features/calculators/health/MicronutrientCalculator.view"),
  tags: ["nutrition", "stability", "planningGraph"],
},
Now, any page can load this calculator using the registry.

3.5 Add validation schemas (optional but recommended)
Create JSON Schemas, e.g.:

src/features/calculators/health/MicronutrientCalculator.input.schema.json

src/features/calculators/health/MicronutrientCalculator.output.schema.json

Then wire them in (e.g., on app startup):

js
Copy code
import { registerCalculatorSchemas } from "@/services/calculators/calculatorValidation";
import inputSchema from "@/features/calculators/health/MicronutrientCalculator.input.schema.json";
import outputSchema from "@/features/calculators/health/MicronutrientCalculator.output.schema.json";

registerCalculatorSchemas("health.micronutrients.daily", {
  inputSchema,
  outputSchema,
});
After this, runCalculator can use validateCalculatorInput/Output so:

Bad input shows user-friendly errors.

Planning Graph and Stability dashboards trust the shape of results.

3.6 Connect to the Planning Graph and Sessions (optional)
If your calculator should generate steps for a session (e.g., batch cooking or garden prep):

Make your shim return enough information (e.g., tasks with durations).

Either:

Let calculatorRunner transform this into a Session object, or

Call a helper inside your domain feature to build a Session.

Then emit:

js
Copy code
import { emitCalculatorSessionCreated } from "@/services/calculators/calculatorEvents";

emitCalculatorSessionCreated({
  calculatorId: "health.micronutrients.daily",
  context,
  session, // matches SSA Session contract
});
Downstream:

Automation runtime can propose a “Now” session.

SessionRunner modal can be opened from domain pages.

Analytics gets session.created.fromCalculator plus session.started/completed.

4. Recommended Patterns
Keep shims pure: all side effects (events, UI, storage) live in the runner, UI, or result store.

Use consistent IDs: once a calculatorId is “live,” treat it as stable; if you need a new behavior, create a new ID.

Validate early: use schemas and validateCalculatorInput to prevent garbage data from flowing into the Planning Graph.

Emit events: they are the glue for Stability, dashboards, and automation. Use calculatorEvents.js instead of ad-hoc event names.

Persist important runs: anything that informs long-term planning (storehouse, garden, nutrition, energy) should be stored via calculatorResultStore.

5. Where to go next
To see how calculators are listed or navigated in the UI, search for calculatorRegistry usage in pages/components.

To integrate calculators with the Stability Dashboard, subscribe to:

calculator.validation.*

calculator.completed

calculator.result.saved

To feed calculators into SessionRunner, look at how your domain’s planning modules convert calculator output into Session objects and pass them along the event bus.

As you add more calculators, keep them modular, validated, and eventful so SSA can orchestrate them across cooking, cleaning, garden, animals, preservation, and storehouse planning.
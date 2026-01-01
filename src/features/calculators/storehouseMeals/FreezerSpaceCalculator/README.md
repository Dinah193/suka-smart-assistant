# FreezerSpaceCalculator

FreezerSpaceCalculator is a **storehouse-domain** Planning Graph calculator that helps you:

- Understand current and projected freezer utilization.
- See how new items (meat, batch cooking, ferments, leftovers) will impact available capacity.
- Get **Next Steps** suggestions when space is too tight (e.g., canning vs freezing, eat-down sessions).
- Emit guidance sessions into the **SessionRunner** (freezer re-org, culling, labeling, etc.).
- Sync freezer zones with your **storehouse inventory layout**.

This calculator is designed to be **event-driven** and Planning-Graph aware, so it can be called directly from UI forms, from other calculators (Meat Breakdown, Fermentation Duration, Batch Cooking), or from automation shims.

---

## 1. File Layout

This feature lives at:

- `src/features/calculators/storehouseMeals/FreezerSpaceCalculator/`
  - `FreezerSpaceCalculator.config.json` – Planning Graph node definition (who we are, events, edges, UI metadata).
  - `FreezerSpaceCalculator.schema.json` – JSON schema for inputs and outputs.
  - `FreezerSpaceCalculator.shim.js` – Calculation logic (pure JS + Planning Graph shim style).
  - `FreezerSpaceCalculator.view.jsx` – React UI for interacting with the calculator.
  - `FreezerSpaceCalculator.hooks.js` – Hooks that connect calculator results into batch, preservation, and sessions.
  - `FreezerSpaceCalculator.mappings.json` – Planning Graph "Next Steps" mappings (what to do after the calculation).

> You should not import these files directly from random places. Treat the `shim` as the canonical compute entry point and the `config/mappings/schema` as declarative contracts used by the Planning Graph runtime.

---

## 2. Schema Overview

The calculator uses `FreezerSpaceCalculator.schema.json` for validation and documentation of inputs/outputs.

### 2.1 Inputs (shape summary)

High-level representation (see schema file for full details):

```ts
type FreezerSpaceCalculatorInput = {
  metadata?: {
    calculatorId?: "FreezerSpaceCalculator";
    requestedBy?: string;
    requestedAt?: string; // ISO
    scenarioLabel?: string;
  };
  householdId?: string;

  freezers: Array<{
    id: string;
    label: string;
    type: "upright" | "chest" | "fridge_freezer" | "built_in" | "other";
    capacity: {
      volumeLiters: number;
      volumeCubicFeet?: number;
    };
    currentFillPct?: number;
    inventoryVolumeApprox?: number;
    zones?: Array<{
      id: string;
      label: string;
      maxLiters?: number;
      currentLiters?: number;
      tags?: string[];
    }>;
  }>;

  incomingLoads?: Array<{
    id: string;
    label: string;
    tags?: string[];
    sourceType?:
      | "meat_breakdown"
      | "batch_cooking"
      | "garden_harvest"
      | "leftovers"
      | "bulk_purchase"
      | "other";
    volumeLiters: number;
    preferredFreezerId?: string | null;
    preferredZoneTags?: string[];
    priority?: "high" | "normal" | "low";
    expectedUseWindowDays?: number;
  }>;

  options?: {
    unitSystem?: "metric" | "imperial";
    defaultUtilizationTargetPct?: number; // e.g. 90
    warnThresholdPct?: number;            // e.g. 85
    underutilizedThresholdPct?: number;   // e.g. 40
    autoDistributeLoads?: boolean;        // auto-assign loads across freezers
  };
};
2.2 Outputs (shape summary)
ts
Copy code
type FreezerSpaceCalculatorOutput = {
  metadata: {
    calculatorId: "FreezerSpaceCalculator";
    computedAt: string; // ISO
    warnings: string[];
    notes: string[];
  };

  totals: {
    totalCapacityLiters: number;
    totalUsedLiters: number;
    totalIncomingLiters: number;
    totalProjectedLiters: number;
    utilizationPct: number;       // projected overall usage
    freeLiters: number;          // remaining space after incoming
  };

  volumeUsage: Array<{
    freezerId: string;
    freezerLabel: string;
    capacityLiters: number;
    currentLiters: number;
    incomingLiters: number;
    projectedLiters: number;
    utilizationPct: number;
    freeLiters: number;
    flags: Array<
      "overflow" |
      "near_capacity" |
      "underutilized"
    >;
  }>;

  fitReport: {
    overflowItems: Array<{
      id: string;
      label: string;
      tags?: string[];
      sourceType?: string;
      volumeLiters: number;
      attemptedFreezerId?: string | null;
      reason: string; // human-readable explanation
    }>;
    warnings: string[];
    reason?: string;
  };

  suggestedLayout?: Array<{
    freezerId: string;
    zones: Array<{
      id: string;
      label: string;
      targetLiters?: number;
      tags?: string[];
    }>;
  }>;

  sessionSuggestions?: Array<{
    id: string;
    title: string;
    description: string;
    domain: "storehouse";
    suggestedActions: string[];
  }>;
};
3. How the Shim Works (FreezerSpaceCalculator.shim.js)
The shim:

Validates inputs against FreezerSpaceCalculator.schema.json (lightweight, defensive).

Normalizes capacities to liters (supports cubic feet → liters if provided).

Calculates:

per-freezer current / projected usage,

total capacity, total usage,

utilization percentages and free space.

Attempts to fit incoming loads into available freezers/zones:

If options.autoDistributeLoads is true, it selects the best freezer(s) based on:

preferred freezer,

available free space,

utilization thresholds.

Items that cannot be placed produce fitReport.overflowItems.

Generates fitReport.warnings and metadata.warnings:

e.g., “Overall utilization would exceed 95%” or “X liters of meat cannot be frozen.”

Generates sessionSuggestions:

“Freezer Re-org Session”

“Eat-Down Batch Session”

“Label & Inventory Session”
These are consumable by the SessionRunner (via mappings and hooks).

You can call this shim from:

React views (e.g., on form submit).

Planning Graph orchestrators (when another node triggers a freezer check).

Automation/cron tasks (e.g., nightly capacity checks).

4. Planning Graph Node (FreezerSpaceCalculator.config.json)
The config file wraps this calculator as a Planning Graph node with:

nodeKey: "PG_NODE_FREEZER_SPACE_CALCULATOR"

kind: "calculator-node"

domain: "storehouse"

calculatorId: "FreezerSpaceCalculator"

It declares:

Inputs: which fields are required (freezers[*].capacity.volumeLiters, at least one freezer) and which are optional (incomingLoads, options).

Outputs: totals, volumeUsage, fitReport, suggestedLayout, sessionSuggestions.

Events:

Consumed:

calculator.freezerSpace.requested

storehouse.inventory.updated

planningGraph.node.MEAT_BREAKDOWN_CALCULATOR.completed

Emitted:

calculator.freezerSpace.completed

calculator.freezerSpace.error

planningGraph.node.FREEZER_SPACE_CALCULATOR.completed

This lets the Planning Graph engine treat the calculator as a reusable, composable node.

5. Next Steps / Mappings (FreezerSpaceCalculator.mappings.json)
The mappings file encodes what happens after the calculator runs, based on outputs:

Overflow → Preservation
If fitReport.overflowItems has length > 0:

Route overflow items to PG_NODE_PRESERVATION_SUITE.

Provide hints for preferred methods: canning, dehydrating, fermenting, etc.

Tight Capacity → Batch Cooking
If totals.utilizationPct > 85:

Suggest an “Eat-Down Freezer” batch cooking session via PG_NODE_BATCH_COOKING_PLANNER.

Underutilized → Stock Up
If totals.utilizationPct < 40:

Suggest using spare capacity for bulk buys via PG_NODE_STOREHOUSE_STOCK_PLANNER.

Meat Overflow → Meat Breakdown / Preservation
If overflowItems tagged as meat:

Route to PG_NODE_MEAT_BREAKDOWN_CALCULATOR and PG_NODE_PRESERVATION_SUITE.

Layout → Storehouse Zones
If suggestedLayout exists:

Sync with PG_NODE_STOREHOUSE_STOCK_PLANNER to align physical freezer zones with inventory zones.

Session Suggestions → SessionRunner
If sessionSuggestions has entries:

Send them to PG_NODE_SESSION_RUNTIME as candidate sessions.

These mappings are how you get “Next Steps” without hard-coding them in the view.

6. Hooks & Session Integration (FreezerSpaceCalculator.hooks.js)
The hooks file provides convenient React hooks that sit on top of the shim + Planning Graph:

6.1 useFreezerSpaceCalculator()
Accepts input payload.

Calls the shim.

Manages loading, error, result state.

Emits calculator.freezerSpace.requested / calculator.freezerSpace.completed events.

6.2 useFreezerSessionSuggestions(result)
Watches result.sessionSuggestions.

Offers helpers to:

Convert suggestions → a Session object matching the SSA Session contract.

Emit session.request.fromFreezerSpace event for the SessionRunner.

Provide a “Run Now” CTA for a freezer re-org / eat-down session.

6.3 useFreezerToPreservationBridge(result)
Looks at fitReport.overflowItems.

Exposes a helper to push overflow items into the Preservation Suite and/or Batch Cooking Planner using the Planning Graph mappings.

These hooks are what your view should use rather than manually wiring events.

7. UI / View (FreezerSpaceCalculator.view.jsx)
The view component is a planner-style UI:

Inputs:

Freezer list with capacity (liters or cubic feet).

Optional zones (e.g., “Beef – Ground & Stew”, “Chicken – Parts”).

Incoming loads (e.g., “Quarter beef”, “Batch cooked chili”, “Bread loaves”).

Outputs:

Summary cards showing:

Overall utilization (before/after).

Free liters remaining.

Warnings and messages.

Table per freezer:

Capacity, current usage, incoming, projected usage.

Flags (Overflow, Near Capacity, Underutilized).

Optional visual bar or progress UI to illustrate how full each freezer is.

Next Steps:

“Suggest Preservation Options” button if overflow is detected.

“Plan Eat-Down Batch Session” button if near-capacity.

“Use SessionRunner Now” button to launch a freezer guidance session (re-org, labeling, culling old items).

The view is designed to feel like the rest of SSA: dashboards, cards, CTAs, and a clear “what should I do now?” answer.

8. SessionRunner Integration
FreezerSpaceCalculator can produce session hints which feed into the SessionRunner:

From sessionSuggestions:

Create Session objects with:

domain: "storehouse"

Steps like:

“Pull oldest items from Freezer A”

“Mark items that should be cooked this week”

“Move small items to door bins for quick access”

Hooks and mappings emit session.request.fromFreezerSpace events.

The SessionRunner:

Displays a full-screen freezer session,

Keeps timers, navigation, and notifications in sync,

Can be started directly via the “Now” CTA in the FreezerSpace UI.

This lets users do the work (re-org, cull, plan) rather than just see a static report.

9. Usage Examples
9.1 Simple direct usage in a component
jsx
Copy code
import React, { useState } from "react";
import { useFreezerSpaceCalculator } from "./FreezerSpaceCalculator.hooks";

export function SimpleFreezerCheck() {
  const [payload, setPayload] = useState(/* build input */);
  const { calculate, result, loading, error } = useFreezerSpaceCalculator();

  const handleRun = () => {
    calculate(payload);
  };

  return (
    <div>
      {/* form inputs for payload here */}
      <button onClick={handleRun} disabled={loading}>
        Check Freezer Space
      </button>
      {error && <p className="error">{error.message}</p>}
      {result && (
        <pre>{JSON.stringify(result.totals, null, 2)}</pre>
      )}
    </div>
  );
}
9.2 As a Planning Graph node
A higher-level orchestrator might:

Build a payload from:

storehouse inventory,

planned batch cooking sessions,

meat breakdown outcomes.

Call the FreezerSpaceCalculator node via the Planning Graph runtime.

Allow FreezerSpaceCalculator.mappings.json to route overflow to Preservation Suite, Batch Cooking, and SessionRuntime automatically.

10. Extension Points
You can extend the calculator safely by:

Adding new sourceTypes to incomingLoads:

e.g., "fish_catch", "foraged", "dairy".

Adding additional flags:

e.g., flags: ["power_sensitive", "door_bin_only"] in volumeUsage if you later add energy constraints.

Adding more mappings:

New id entries in FreezerSpaceCalculator.mappings.json to integrate with other planners or reports.

Adjusting thresholds:

Default thresholds live in options (or in config); you can change the defaults without breaking consumers.

Whenever you extend the logic:

Update FreezerSpaceCalculator.schema.json to reflect new fields.

Ensure the shim treats new properties defensively (optional, with defaults).

Optionally add new Planning Graph mappings and/or events if behavior changes.

11. Design Goals
FreezerSpaceCalculator is designed to:

Give fast answers to “Can I fit this quarter beef in the freezer?”.

Bridge between Meat Breakdown, Batch Cooking, Preservation, and Storehouse planners.

Trigger practical, guided sessions rather than leaving the user with static numbers.

Respect SSA’s event-driven, SessionRunner-first architecture.

If you keep those goals in mind when extending it, the calculator will remain a powerful tool in your storehouse planning flow.
# HouseholdStabilityCalculator

> Feature path:  
> `src/features/calculators/stability/HouseholdStabilityCalculator/`

The **Household Stability Calculator** is a Planning Graph calculator-node that evaluates the overall stability of a household across multiple domains (meals, cleaning, time rhythms, relationships, education/skills, finances, etc.). It produces:

- A **normalized stabilityIndex** (0–100)
- **Sub-domain scores** that explain *why* the index is high or low
- **Flags** and **recommendations** that can feed into downstream planners
- **Next Step mappings** that tell the SSA what flows to trigger next

It is intentionally designed to be **actionable**: instead of just “you are unstable” vs “you are good,” it suggests **very specific next moves** the SSA can orchestrate (e.g., “plan a batch cooking session,” “simplify cleaning loops,” “stabilize daily rhythm,” etc.).

This calculator is used by:

- The **Planning Graph** (for branching into other planners)
- The **SessionRunner** (to generate “Now” sessions from stability-related recommendations)
- The **Household dashboard(s)** (to visualize where the household is fragile vs thriving)
- Curriculum and household development flows (e.g., what to work on *this quarter*)

---

## 1. Files in this feature

All files live under:

`src/features/calculators/stability/HouseholdStabilityCalculator/`

### 1.1 Config (Planning Graph node)

**File:** `HouseholdStabilityCalculator.config.json`  
**Role:** Declares this node as a calculator within the Planning Graph and documents how its outputs should be interpreted.

Key fields:

- `nodeKey`: `"household-stability"`
- `kind`: `"calculator-node"`
- `label`: Human-friendly name for dashboards (“Household Stability Index”).
- `version`: Internal node version.
- `inputSchemaRef`: Path to this calculator’s schema file.
- `tags`: Discovery tags (e.g., `["stability", "planning", "household"]`).
- `domainHints`: Hints about the domains this calculator touches (meals, cleaning, relationships, etc.).
- `outputShape`: Brief, inline description of the key outputs.

The config allows:

- The Planning Graph engine to **discover** and **validate** this node.
- Admin/UIs to **surface** it in menus and dashboards.
- Future upgrades via `version` without breaking older data.

---

### 1.2 Schema (input + output contract)

**File:** `HouseholdStabilityCalculator.schema.json`  
**Role:** Defines the JSON structure for **inputs** and **outputs** used by the calculator shim and any UIs.

**Inputs** (high-level):

- `context.householdId` – optional, for persistence.
- `timeframe` – `"current" | "last30d" | "custom"`.
- `metrics` – a structured object of raw scores or observed statuses:
  - `mealsAndStorehouse`
  - `cleanlinessAndOrder`
  - `timeRhythms`
  - `relationshipsAndSupport`
  - `educationAndSkill`
  - `financesAndObligations` (optional / extendable)
  - plus optional flags like `recentShocks` or `healthStress`.

**Outputs** (high-level):

- `stabilityIndex` – 0 to 100 (number).
- `band` – `"critical" | "fragile" | "steady" | "thriving"`.
- `subScores` – per-domain normalized scores.
- `alerts` – array of notable issues or risks.
- `recommendations` – items that UIs can present as “Next best actions.”
- `meta` – versioning, timestamps, notes.

The schema is designed to:

- Be easy to validate against JSON Schema (even if `$schema` links are handled externally).
- Stay consistent with other calculators in the Planning Graph.
- Support both **manual entry** and **auto-derived** metrics from other modules.

---

### 1.3 Shim logic

**File:** `HouseholdStabilityCalculator.shim.js`  
**Role:** The calculation **engine** which:

- Accepts a JSON input that conforms to the schema.
- Normalizes metrics into **0–100** sub-scores.
- Derives an overall **stabilityIndex** and a **band**.
- Generates `alerts` and text-based `recommendations`.
- Emits consistent events via the global `eventBus` (if applicable).

Typical flow inside the shim:

1. **Validate** that required metrics exist; apply defaults for missing metrics.
2. **Normalize** each domain metric (e.g., 0–10 → 0–100).
3. **Weight** domains (by default, roughly equal; easily tweaked in one place).
4. Compute `stabilityIndex` as a weighted average.
5. Map the index to **bands**:
   - 0–39 → `critical`
   - 40–59 → `fragile`
   - 60–79 → `steady`
   - 80–100 → `thriving`
6. Produce **alerts** for low sub-scores or risky combinations (e.g., low meals + low time rhythms).
7. Emit a `planning.stability.calculated` event through `eventBus` (if loaded).

You can call this shim directly from:

- Route-level loaders
- React hooks
- Other planners that need to check or re-check stability

---

### 1.4 View component

**File:** `HouseholdStabilityCalculator.view.jsx`  
**Role:** React UI that:

- Renders the **stability index** and **band** prominently.
- Shows a **radar-like or bar visualization** of sub-domain scores.
- Lists **alerts** and **recommendations** in a clean, action-oriented layout.
- Integrates with **Next Steps** to let the user jump into sessions/planners.

Key UI pieces:

- **Main score panel**: Large 0–100 score with band label and brief description.
- **Domain breakdown**: Cards or chart segments highlighting each domain score + label.
- **Alerts list**: Clearly calls out critical issues.
- **Recommended next moves**:
  - Buttons that correspond to `nextSteps` from `HouseholdStabilityCalculator.mappings.json`.
  - Some buttons may trigger **SessionRunner** (e.g., “Start a Batch Cooking Session Now”).
- **History preview (optional)**:
  - If prior runs are available, shows tiny history chips or sparkline.

The view is designed to be embedded:

- In a dedicated **Stability** page (e.g., `/stability`).
- Inside a **dashboard card** on the household/home view.
- In a full-screen modal when launched from a “Check Stability” CTA.

---

### 1.5 Hooks

**File:** `HouseholdStabilityCalculator.hooks.js`  
**Role:** React hooks that connect the calculator to the rest of SSA.

Provided hooks include:

- `useHouseholdStabilityCalculator(input)`  
  - Accepts schema-shaped input.
  - Calls the shim.
  - Returns derived `result`, loading state, and any calc errors.

- `useStabilityRecommendations(result)`  
  - Takes a stability result.
  - Resolves **Next Steps** from the `mappings.json`.
  - Returns a list of recommended CTAs and their target routes/domains.

- `useStabilityDrivenSessions(result)`  
  - Translates certain recommendations into **session templates** that the SessionRunner can start.

These hooks are the **bridge** between the pure calculation and the practical SSA domain flow (meals, cleaning, garden, etc.).

---

### 1.6 Mappings

**File:** `HouseholdStabilityCalculator.mappings.json`  
**Role:** Defines **Next Steps** / downstream flows for each stability band and for specific sub-domain issues.

High-level structure:

- For each band (`critical`, `fragile`, `steady`, `thriving`):
  - Which planner nodes should be triggered, e.g.:
    - `storehouse-baseline-requirements`
    - `meal-planner`
    - `cleaning-route-planner`
    - `garden-season-planner`
    - `curriculum-cycle-planner`
    - `animal-planner`
    - `infrastructure-project-planner`
  - Which **Next Steps** CTAs to surface:
    - Label for UI (e.g., “Baseline Storehouse Wizard”).
    - Target route (e.g., `/storehouse/baseline`).
    - `sessionDomain` and `sessionTemplateHint` for SessionRunner.

- A **domain-specific** mapping section that reacts to sub-score thresholds:
  - If `mealsAndStorehouse` < 60 → suggest `meal-planner`.
  - If `cleanlinessAndOrder` < 60 → suggest `cleaning-route-planner`.
  - If `timeRhythms` < 60 → suggest `daily-rhythm-planner`.
  - If `relationshipsAndSupport` < 60 → suggest `relationship-rhythm-planner`.
  - If `educationAndSkill` < 60 → suggest `curriculum-cycle-planner`.

The mappings file means:

- The UI does **not** have to hard-code complex if/else logic.
- Upgrades to flows can be done by adjusting mappings instead of code.

---

## 2. How this calculator fits into SSA

### 2.1 Workflow in the Planning Graph

1. **Inputs gathered**  
   - From a form (user answers questions / metrics).
   - From other calculators (e.g., Meal Planning, Storehouse, Debt, etc.).
   - From periodic snapshots (SSA can schedule re-checks).

2. **Shim executes**  
   - Normalizes metrics → `stabilityIndex`, sub-scores, band.

3. **Results saved/emitted**  
   - Optionally stored in Dexie for history.
   - Event emitted on the eventBus (e.g., `planning.stability.calculated`).

4. **Mappings applied**  
   - `HouseholdStabilityCalculator.mappings.json` is consulted.
   - Next Step CTAs and potential flows are constructed.

5. **UI presents actions**  
   - View component shows results & recommended next steps.
   - User can immediately launch planners or start a session.

6. **SessionRunner integration**  
   - When the user presses a “Now” CTA:
     - A session template for the chosen domain is created (e.g., a **stability-inspired batch cooking** session).
     - The SessionRunner modal is launched and persists across navigation.

---

### 2.2 Relationship to SessionRunner

The stability calculator itself does **not** manage sessions, but it supplies:

- Context for *which domain* should get a session next (meals vs cleaning vs garden).
- Hints for **session templates**, such as:
  - “simple 7-day rotation meal plan”
  - “light cleaning routes only”
  - “garden planning for a small first step”
- A **band** that can adjust how aggressive the suggested sessions are:
  - Critical band → tiny, achievable sessions.
  - Thriving band → bigger, long-range projects.

Your SessionRunner’s “Now” button logic can:

1. Ask: “Do we have recent stability results?”  
2. If yes, use `HouseholdStabilityCalculator.mappings.json` to:
   - Propose one or more sessions as **Now** candidates.
3. Let the user pick one and launch it.

---

## 3. Example usage patterns

Below are conceptual examples; actual code uses the shim/hooks you’ve created.

### 3.1 Running the calculator from a page

```js
import { runHouseholdStabilityCalculator } from "./HouseholdStabilityCalculator.shim.js";

async function checkStabilityForDashboard(metrics) {
  const input = {
    context: { householdId: "my-household" },
    timeframe: "current",
    metrics
  };

  const result = await runHouseholdStabilityCalculator(input);

  // result.stabilityIndex, result.band, result.subScores, etc.
  return result;
}
3.2 Using hooks in a React component
jsx
Copy code
import React from "react";
import { useHouseholdStabilityCalculator } from "./HouseholdStabilityCalculator.hooks";
import HouseholdStabilityCalculatorView from "./HouseholdStabilityCalculator.view";

export default function StabilityPage({ metrics }) {
  const { result, isCalculating, error } = useHouseholdStabilityCalculator({
    context: { householdId: "my-household" },
    timeframe: "current",
    metrics
  });

  if (isCalculating) return <p>Calculating stability…</p>;
  if (error) return <p>There was a problem: {error.message}</p>;
  if (!result) return <p>No stability data yet.</p>;

  return (
    <HouseholdStabilityCalculatorView
      result={result}
      householdId="my-household"
    />
  );
}
4. Extensibility
You can safely extend the calculator in these ways:

Add more metrics
Update the schema with new domains (e.g., transportation, health) and adjust the shim’s weighting logic.

Adjust band thresholds
If you find 40–59 is too tight for fragile, you can shift thresholds in a single place in the shim.

Customize mappings

Add or change Next Step targets in HouseholdStabilityCalculator.mappings.json.

Wire in new planner nodes (e.g., debt payoff planner, career/skills planner).

Integrate more deeply with the Hub

On planning.stability.calculated, export anonymized aggregates (if familyFundMode is enabled and allowed).

Use stability snapshots to fuel community-level analytics.

5. Design & UX notes
Keep the main score very clear and emotionally neutral (“Here’s where you are; here’s what to do next”).

Avoid shaming language. Emphasize:

Stability is dynamic, not permanent.

Small improvements in one domain can unlock bigger projects later.

Ensure Next Steps are small and concrete, especially for critical and fragile bands:

“Plan a 3-day simple menu” is better than “Fix all meals.”

“Set up a 10-minute daily reset” is better than “Deep clean the house.”

6. Troubleshooting
Q: The stabilityIndex is always around the same value.

Check your metric normalization; ensure inputs are not always defaulting.

Verify that metrics are actually being passed from the UI or upstream calculators.

Q: The UI shows no Next Steps.

Ensure HouseholdStabilityCalculator.mappings.json is present and correctly referenced where you resolve Next Steps.

Confirm the band (critical, fragile, steady, thriving) matches a mapping entry.

Check sub-score thresholds if you rely on domain-specific triggers.

Q: Stability doesn’t seem to update after changes in other modules.

Make sure the calculator is being re-run when:

Inventory, meals, cleaning, etc. observables change.

Or the user explicitly clicks “Recalculate stability.”

7. Summary
The Household Stability Calculator is a core Planning Graph node that transforms scattered household metrics into:

A single, understandable stability score

Clear sub-domain diagnostics

Concrete Next Steps that drive sessions and planners

With this node in place, SSA can move beyond “tools in isolation” and begin steering each household along a coherent, stability-aware growth path—always focusing on the next best action that fits their current reality.
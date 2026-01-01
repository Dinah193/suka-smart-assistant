# SeedViabilityCalculator

> **Path:**  
> `src/features/calculators/gardenAnimal/SeedViabilityCalculator/`

The **Seed Viability Calculator** helps SSA users decide whether a given seed lot can reliably support their planned plantings and what to do next:

- **Plant now** (with smart over-sowing),
- **Refill / replace the seed lot** in the storehouse,
- Or **test / retire** the lot when data is incomplete or viability is very low.

It plugs into the **Planning Graph**, **SessionRunner**, and **Now CTAs** so that one quick calculator run can lead directly into an actionable **Planting Session** or **Refill Session**.

---

## 1. How this fits into SSA

**Domains touched:**

- `garden` – planting sessions and garden task planning.
- `storehouse` – seed inventory, refill, and procurement planning.

**Key integrations:**

- **Event Bus:** emits `seed.viability.calculated` and `inventory.shortage.detected` so other subsystems can react.
- **Planning Graph:** uses `SeedViabilityCalculator.mappings.json` to map calculator results → recommended next steps.
- **SessionRunner:** hooks build session objects (garden + storehouse) and emit `session.requested` for “Now” actions.
- **Hub Export (optional):** when `familyFundMode === true`, launchers send a small envelope to the Hub so family-fund analytics can see seed planning behavior.

---

## 2. Files in this feature

| File | Purpose |
| ---- | ------- |
| `SeedViabilityCalculator.hooks.js` | Core hooks: computes viability planning + builds/launches planting/refill sessions. |
| `SeedViabilityCalculator.mappings.json` | Planning Graph mapping from calculator result → next-step recommendations + Now CTA bindings. |
| `SeedViabilityCalculator.view.jsx` *(expected)* | UI component that renders the calculator, shows results, and wires “Plant Now” / “Refill Now” buttons to hooks. |
| `SeedViabilityCalculator.types.d.ts` *(optional)* | Type declarations for seed batch, viability results, and hook APIs (if you choose to add them). |

Related shared schema:

- `src/schemas/planningGraph/nextSteps.mappings.schema.json`  
  JSON Schema used by `*.mappings.json` files, including this feature.

---

## 3. Data model

### 3.1 Seed batch input (from storehouse / garden)

The calculator expects a **SeedBatch**-like object (usually from storehouse inventory):

```ts
type SeedBatch = {
  id: string;
  cropName: string;
  variety?: string;
  lotCode?: string;
  packedYear?: number;
  labelGermPct?: number;     // packet label germ % (0–100)
  quantityOnHand?: number;   // number of seeds in this lot
};
3.2 Viability test inputs
User and/or packet provide:

testGerminated – number of seeds that sprouted in a simple germination test.

testTotal – number of seeds tested.

labelGermPct – packet label germination rate (if present).

3.3 Viability planning result
The hook produces a ViabilityPlanningResult object:

ts
Copy code
type ViabilityPlanningResult = {
  effectiveViabilityPct: number;         // conservative % (min of label vs. test)
  theoreticalGerminatedSeeds: number;    // quantityOnHand * (viability / 100)
  maxPlantsSupported: number;            // how many plants we can realistically support
  isShortage: boolean;                   // true if plants needed > maxPlantsSupported
  shortagePlants: number;                // how many plants we're short
  recommendedSowingMultiplier: number;   // recommended over-sow factor
  shouldRefill: boolean;                 // should we start a refill plan?
  shouldFrontloadSowing: boolean;       // plant earlier / more aggressively
};
4. Hooks API
4.1 useSeedViabilityPlanning
File: SeedViabilityCalculator.hooks.js

Computes viability and (optionally) emits Planning Graph + inventory events.

js
Copy code
import { useSeedViabilityPlanning } from "./SeedViabilityCalculator.hooks";

const viability = useSeedViabilityPlanning({
  seedBatch,
  testGerminated,          // optional
  testTotal,               // optional
  targetPlants,            // plants needed from plan
  sowingMultiplier,        // default 1.1
  minViabilityForRefill,   // default 65 (%)
  autoEmitEvents: true     // emit seed.viability.calculated & inventory.shortage.detected
});
Events emitted (when autoEmitEvents: true):

seed.viability.calculated

data.seedBatch contains the full viability payload (effective %, shortage, etc.).

inventory.shortage.detected (when shortage)

data.domain = "garden"

data.itemType = "seed"

data.itemId = seedBatch.id

data.shortagePlants, data.targetPlants…

Also calls:

planningGraph.node.updated with nodeId = "garden.seedViability".

4.2 useSeedSessionLaunchers
Provides session builders and Now launchers:

js
Copy code
import { useSeedSessionLaunchers } from "./SeedViabilityCalculator.hooks";

const { buildPlantingSession, buildRefillSession, launchPlantingNow, launchRefillNow } =
  useSeedSessionLaunchers({ seedBatch, viability });
buildPlantingSession() → returns a garden Session object (domain: "garden").

buildRefillSession() → returns a storehouse Session object (domain: "storehouse").

launchPlantingNow():

persists the session draft to the sessions store (upsertSession),

emits:

js
Copy code
emit({
  type: "session.requested",
  ts,
  source: "features/calculators/SeedViabilityCalculator",
  data: { reason: "seed.planting.now", session }
});
conditionally exports a small hub envelope when familyFundMode === true.

launchRefillNow():

same pattern, with reason: "seed.refill.now" and domain "storehouse".

These do not run the SessionRunner directly; they signal that a session should start.
The SessionRunner infrastructure listens for session.requested events, picks the session up, and opens the global SessionRunner modal.

5. Planning Graph mapping
File: SeedViabilityCalculator.mappings.json
Schema: src/schemas/planningGraph/nextSteps.mappings.schema.json

This mapping file describes how to interpret the calculator’s output into next-step recommendations for the Planning Graph engine (and higher-level “What should I do next?” UX).

Key fields:

id: "garden.seedViability.nextSteps"

calculator: "SeedViabilityCalculator"

inputs: mapping of semantic keys → calculator result paths, e.g.:

json
Copy code
{
  "effectiveViabilityPct": "viability.effectiveViabilityPct",
  "isShortage": "viability.isShortage",
  "shortagePlants": "viability.shortagePlants",
  "targetPlants": "viability.targetPlants",
  "recommendedSowingMultiplier": "viability.recommendedSowingMultiplier",
  "shouldRefill": "viability.shouldRefill",
  "shouldFrontloadSowing": "viability.shouldFrontloadSowing"
}
rules[]: threshold-based rules that produce recommendations[] (labels, CTAs, domains, sessionReason, sessionKind…).

nowCtas: ties domains to default “Now” behavior:

json
Copy code
"nowCtas": {
  "garden": {
    "label": "Plant Now",
    "sessionReason": "seed.planting.now",
    "sessionKind": "planting",
    "preferredLauncher": "useSeedSessionLaunchers.launchPlantingNow"
  },
  "storehouse": {
    "label": "Refill Seeds Now",
    "sessionReason": "seed.refill.now",
    "sessionKind": "refill",
    "preferredLauncher": "useSeedSessionLaunchers.launchRefillNow"
  }
}
The Planning Graph engine can:

Read the calculator output.

Evaluate rules based on viability thresholds.

Surface a list of recommended actions (with CTAs) on Planning Graph UI / garden dashboard.

Use nowCtas to wire the global “Now” button to the correct launcher.

6. Example UI wiring
In SeedViabilityCalculator.view.jsx (or equivalent), typical flow:

jsx
Copy code
import React from "react";
import {
  useSeedViabilityPlanning,
  useSeedSessionLaunchers
} from "./SeedViabilityCalculator.hooks";

export function SeedViabilityCalculatorView({ seedBatch }) {
  // Local form state (germination test, target plants, etc.) not shown
  const testGerminated = /* form value */;
  const testTotal = /* form value */;
  const targetPlants = /* from plan */;

  const viability = useSeedViabilityPlanning({
    seedBatch,
    testGerminated,
    testTotal,
    targetPlants
  });

  const {
    launchPlantingNow,
    launchRefillNow
  } = useSeedSessionLaunchers({ seedBatch, viability });

  return (
    <div className="seed-viability-card">
      {/* Inputs and calculated fields... */}

      <div className="seed-viability-actions">
        <button
          type="button"
          onClick={launchPlantingNow}
          disabled={viability.effectiveViabilityPct === 0}
        >
          Plant Now
        </button>

        {viability.shouldRefill && (
          <button type="button" onClick={launchRefillNow}>
            Refill Seeds
          </button>
        )}
      </div>
    </div>
  );
}
Once a “Now” button is clicked:

Session is created and persisted.

session.requested event is emitted.

Global SessionRunner (mounted in App.jsx) sees the event and opens its full-screen modal for that session, providing:

timer,

step-by-step guidance,

keyboard shortcuts,

wake-lock, notifications, and optional Picture-in-Picture mini HUD.

7. Session object details
The planting + refill sessions created here follow the global Session contract:

js
Copy code
{
  id: string,
  domain: "garden" | "storehouse",
  title: string,
  source: {
    type: "gardenPlan" | "manual",
    refId: string | null
  },
  steps: [
    {
      id: string,
      title: string,
      desc: string,
      durationSec: number,
      blockers: ["inventory", "weather", ...],
      metadata: {
        tempTargetF: number,
        donenessCue: "color" | "texture" | "probeTemp" | "timer" | "smell",
        cueNotes: string
      }
    }
  ],
  prefs: {
    voiceGuidance: boolean,
    haptic: boolean,
    autoAdvance: boolean
  },
  status: "pending" | "running" | "paused" | "completed" | "aborted",
  progress: {
    currentStepIndex: number,
    elapsedSec: number,
    startedAt: string | null,
    pausedAt: string | null
  },
  analytics: {
    skippedSteps: string[],
    adjustments: Array<any>
  },
  createdAt: string,
  updatedAt: string
}
The actual step titles and descriptions in the hooks are written to be:

Concrete and short – “Gather tools and seed packet”, “Water and label”.

Easily mapped to checklists and voice guidance in the SessionRunner.

8. Extensibility
You can extend this feature by:

Adding more rules in SeedViabilityCalculator.mappings.json:

e.g., rules for seed saving, sharing seeds with neighbors, or trial beds.

Adding new flags to the viability result:

e.g., isHeirloom, isCriticalCrop, riskLevel.

Wiring additional Planning Graph nodes in feedsInto fields:

e.g., storehouse.longTermSeedBank, garden.perennialPlanning.

Exposing more SessionRunner preferences:

override prefs per domain, or use Sabbath / quiet hours guards when linking to the SessionRunner.

9. Quick checklist for integration
Ensure schema exists:
src/schemas/planningGraph/nextSteps.mappings.schema.json (done in this project).

Place mappings file:
SeedViabilityCalculator.mappings.json with $schema pointing to that schema.

Wire hooks into UI:

useSeedViabilityPlanning for computation.

useSeedSessionLaunchers for “Now” actions.

Verify eventBus wiring:

seed.viability.calculated and inventory.shortage.detected appear in dev tools / logs.

SessionRunner listens to session.requested:

ensure global SessionRunner component responds and opens the modal.

Optional: Confirm Hub export is active when familyFundMode === true.

Once those are in place, a user can:

Enter seed info + germ test.

See viability, shortage, and over-sow suggestions.

Hit Plant Now or Refill Seeds.

Immediately land in a robust, resilient, full-screen SessionRunner that guides the work from start to finish.
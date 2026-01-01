# ButcheryWeightCalculator

**Path**

`src/features/calculators/gardenAnimal/ButcheryWeightCalculator/`

This calculator helps you translate **live animal weight → hanging/carcass weight → retail cut yields**, then feeds those results into:

- Freezer & storehouse inventory planning  
- Batch cooking & preservation sessions  
- Long-term meat yield analytics for herd and budget planning  

It is part of the SSA **Planning Graph** in the `animals` and `storehouse` domains and is designed to work cleanly with the global SessionRunner, event bus, Dexie persistence, and Hub export flows.

---

## Files in this feature

- `ButcheryWeightCalculator.config.json`  
  Calculator node config (identity, domain, inputs/outputs, UI wiring).

- `ButcheryWeightCalculator.schema.json`  
  JSON Schema for calculator inputs and computed outputs (live weight, hanging weight, retail cut breakdown, etc.).

- `ButcheryWeightCalculator.shim.js`  
  Shim logic that performs the actual meat yield calculations and emits structured results + events.

- `ButcheryWeightCalculator.view.jsx`  
  React UI for entering slaughter data, seeing yield breakdowns, and sending outputs into freezer/batch planning.

- `ButcheryWeightCalculator.hooks.js`  
  Hooks that connect shim outputs into **storehouse inventory**, **freezer slots**, and **batch cooking/preservation planning**.

- `ButcheryWeightCalculator.mappings.json`  
  Planning Graph “next steps” mappings that interpret calculator outputs and trigger downstream actions/sessions.

---

## Conceptual overview

In a real homestead or small butchery workflow, you typically know:

- **Species** (beef, lamb, goat, pork, poultry, etc.)  
- **Live weight** (pre-slaughter)  
- **Hanging/carcass weight** (post-kill, pre-aging)  

You want to know:

- How much will I get in **usable meat**?  
- How much will be **bone/fat/stock/offal**?  
- How should it be **packed in the freezer**?  
- What’s the **best way to turn this into meals** (grind/roasts/stock sessions, etc.)?

The ButcheryWeightCalculator takes those inputs and returns a structured breakdown of yields by **cut type** (steaks, roasts, grind, bones, fat, offal, etc.), and uses that breakdown to:

1. **Prompt freezer/storehouse planning**  
2. **Suggest batch cooking and stock/offal sessions**  
3. **Update long-term analytics for yield % by species and method**

---

## Data shape (high level)

The schema (`ButcheryWeightCalculator.schema.json`) defines:

### Inputs

- `species` – string, required  
- `liveWeightKg` – number, live weight in kg  
- `hangingWeightKg` – number, carcass weight in kg  
- Optional planner knobs like `targetRetailPct`

### Outputs (computed by shim)

- `totalRetailKg` – computed retail cut weight  
- `bonesKg` – bones/stock material  
- `fatRenderKg` – fat suitable for rendering or sausage  
- `grindKg` – trim and grindable meat  
- `steaksKg` – steaks & chops  
- `roastsKg` – roast-style cuts  
- `offalKg` – edible organs/offal  
- `retailYieldPct` – actual yield from hanging carcass to retail meat  

Plus meta fields like `batchId` for tying this run to freezer and batch sessions.

This output structure is what **mappings** and **hooks** use to drive downstream flows.

---

## How the pieces fit together

### 1. Config node (`ButcheryWeightCalculator.config.json`)

- Registers this calculator in the **Planning Graph** as a `calculator-node` in the `animals` domain (and cross-domain aware of `storehouse` and `cooking`).
- Declares:
  - A `nodeKey` (e.g., `"animals.butcheryWeight"`)
  - Display label/description for UI
  - default species list, “typical” yield assumptions, etc.
- The Planning Graph loader uses this node config to:
  - Show the calculator in the Animals / Butchery tools list
  - Wire the node’s inputs/outputs to the Graph engine and `*.mappings.json`

You rarely need to touch this file unless you change naming, domain routing, or add more advanced config fields.

---

### 2. Shim (`ButcheryWeightCalculator.shim.js`)

- Pure logic + light SSA integration (eventBus).
- Given a validated payload that matches `ButcheryWeightCalculator.schema.json`, the shim:
  1. Normalizes weights (e.g., uses hanging weight if present, else infer from live weight).
  2. Applies species-specific default yield ratios (steaks vs roasts vs grind vs offal).
  3. Computes all output weights and checks that totals don’t exceed available carcass weight.
  4. Emits one or more events, for example:
     - `analytics.meatYield.updated`
     - `animals.butchery.yield.calculated`

The shim is designed to be called from:

- The feature’s own **view** (`ButcheryWeightCalculator.view.jsx`)
- Other parts of SSA that want to compute yields programmatically (e.g., schedule generation, imports from external butchery logs, etc.)

---

### 3. View (`ButcheryWeightCalculator.view.jsx`)

The UI file is the **front door** for the user:

- **Input panel** for:
  - Species selection
  - Live weight and/or hanging weight
  - Optional yield tuning knobs
- **Results panel** showing:
  - Retail yield breakdown (kg and %)
  - Quick summary cards (e.g., “Ground meat: 18 kg (~40 meals)”)
  - Warnings if yields look off (e.g., yield > 80% for beef)
- **Integration buttons / CTAs**:
  - “Send to Freezer Plan”
  - “Create Batch Cooking Session”
  - “Start Butchery Session Now” (opens a SessionRunner flow for cutting & packaging steps)

The view uses hooks from `ButcheryWeightCalculator.hooks.js` to interpret outputs and push them into storehouse and session planning, without embedding deep logic in the component itself.

---

### 4. Hooks (`ButcheryWeightCalculator.hooks.js`)

These hooks sit between the **calculator results** and the **rest of SSA**:

- Example responsibilities:
  - Convert output weights into **freezer inventory entries** (with labels like “Beef Stew Meat – 1 kg x 10 pkgs”).
  - Generate a **freezer load plan** (estimated volume, which freezer, shelf allocation).
  - Prepare **draft batch cooking sessions** (e.g., ground meat → burger/sausage/chili sessions).
  - Prepare a **preservation plan** (offal recipes, bone broth sessions, tallow rendering).

Hooks are intentionally focused, testable, and event-aware. They often:

- Consume `analytics.meatYield.updated` or direct shim result objects.
- Use the event bus (`eventBus.emit`) to let other parts of SSA know that planning artifacts were created or updated.
- Optionally, when `familyFundMode === true`, call Hub helpers to export yield & inventory data.

---

### 5. Mappings (`ButcheryWeightCalculator.mappings.json`)

This file tells the **Planning Graph** engine how to move from **calculator results → next best actions**, using rule objects like:

- **Freezer Planning Trigger**  
  If `totalRetailKg >= threshold`, then:
  - Emit `storehouse.freezer.plan.requested`
  - Suggest a `storehouse` session draft

- **Batch Cooking Trigger**  
  If `grindKg` or `roastsKg` is high enough, then:
  - Emit `planning.batchCooking.suggested`
  - Suggest a `cooking` batch session draft

- **Stock & Offal Trigger**  
  If `bonesKg` or `offalKg` is high enough, then:
  - Emit `planning.preservation.stockSuggested`
  - Suggest a `preservation` session draft

- **Analytics Update**  
  Always push `analytics.meatYield.updated` whenever inputs/outputs are valid.

The mappings format is shared with other Planning Graph nodes, so the graph engine can interpret it generically.

---

## SessionRunner integration

The ButcheryWeightCalculator doesn’t **run a session by itself**, but it:

1. Helps create **runnable session drafts** (especially packing, labeling, cooking, preservation sessions).  
2. Uses standard payload shapes so that a calling domain (e.g. Animals → Butchery or Storehouse → Freezer) can:

   - Transform a mapping action like `suggestSessionDraft` into a `Session` object that matches the global contract.
   - Attach SSA’s “Now” CTA to those drafted sessions so a user can immediately open the SessionRunner.

### Example flow

1. User enters live/hanging weight and species, clicks **Calculate**.  
2. Shim computes yields and emits `analytics.meatYield.updated`.  
3. Mappings fire, e.g. `storehouse.freezer.plan.requested`.  
4. The Freezer Planner listens to that event, creates a **session draft** (packaging & labeling steps), and exposes a **“Now”** button.  
5. Clicking **“Now”** opens a full SessionRunner modal guiding the user through the butchery/packaging tasks while:

   - Keeping the screen awake  
   - Using timers and cues if configured  
   - Persisting progress to Dexie and emitting session events

The ButcheryWeightCalculator therefore acts as an **upstream intelligence node** that feeds actionable session plans into this runner.

---

## Extending this feature

You can extend the calculator in several ways:

- **Add more species** or custom breed profiles  
  - Update species lists and yield defaults in the shim/config.
- **Add more cut categories** (e.g., ribs, shanks, specialty sausages)  
  - Extend the schema and shim’s breakdown logic.
- **Connect to pricing and budgeting**  
  - Add cost fields to schema and have the shim compute value/ROI of each butchery run.
- **Tie deeper into the Planning Graph**  
  - Add new mapping rules for:
    - pricing dashboards,
    - CSA/box planning,
    - donation and community-share sessions.

---

## Developer notes

- Keep the `ButcheryWeightCalculator.schema.json` in sync with the shim’s input and output keys.
- Use the hooks to integrate with storehouse and cooking **instead of** wiring heavy logic directly into the view.
- Follow existing patterns from other calculators (e.g., MeatBreakdown, AnimalFeed, SeedViability) for:
  - Event naming
  - Mapping rule structure
  - Hook conventions (`useXxxFromCalculator`, `usePushXxxToStorehouse`, etc.)
- The shim should remain **deterministic and side-effect light**, with events as its primary side effect.

---

## User-facing summary

In plain language, this tool answers:

> “If I slaughter this animal at this weight, how much real meat will I actually put into my freezer, and how should I turn that into meals and preservation projects?”

The ButcheryWeightCalculator gives you those answers, then quietly pushes them into the rest of SSA so you can:

- Pack the freezer intelligently,  
- Plan future meals and batch cooking sessions, and  
- Track yields over time as your butchery skills improve.
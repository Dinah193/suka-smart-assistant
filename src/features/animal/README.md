# Animal Planner Module

The **Animal Planner** is the SSA hub for planning animal acquisition, breeding, usage, and risk/resilience in a way that stays tightly linked to:

- Storehouse & feed planning  
- Garden & fodder planning  
- Butchery & preservation flows  
- Household health & micronutrient calculators  
- SessionRunner-powered “Now” sessions

This folder contains the UI, logic, Planning Graph configuration, and mapping rules that let the animal domain plug into the global Planning Graph and SessionRunner.

---

## Files in this folder

### 1. `AnimalPlanner.view.jsx`

**Purpose**

- Main React view for the Animal Planner route (`/animals/planner`).
- Provides the **planning dashboard UI** for:
  - Animal acquisition (what, when, from where, and how many)
  - Breeding calendar & replacement cycles
  - Usage flows (meat, milk, eggs, fiber, work)
  - Risk & resilience strategies (what to cull, sell, or pause first)
- Exposes **“Now” buttons** that emit events to the SessionRunner via the `eventBus`.

**Key responsibilities**

- Render planner cards/sections for each flow (acquisition, breeding, usage, risk).
- Allow the user to save planning states (e.g., planned animals, cycles, and cull plans).
- For each flow:
  - Provide a “Run as session now” CTA that:
    - Emits a `session.requestNext` event with an appropriate `focusArea` and `domainHints`.
    - Lets the global SessionRunner resolve or create the right `animals` session.
- Show **Planning Graph “next steps”** surfaced by the mappings file (e.g., links to food stabilization, garden season setup, storehouse duration calculators, etc.).

---

### 2. `AnimalPlanner.logic.js`

**Purpose**

- Connects animal planning data to **feed usage**, **butchery/meat breakdown**, and **micronutrient needs**.
- Acts as the “glue” between Animal Planner UI and downstream calculators/sessions.

**Key responsibilities**

- Provide pure helper functions that work off of a `plan` object:
  - `planFeedDemandFromAnimals(plan)`  
    Estimate feed consumption, produce demand for fodder, storehouse feed requirements, etc.
  - `planButcheryAndYield(plan)`  
    Map animals and target butcher dates to estimated yields (meat, bones, organs, fat).
  - `estimateMicronutrientContributions(plan)`  
    Roughly compute micronutrient contributions of projected yields to the household’s daily needs.
- Prepare **session templates** for different flows:
  - Acquisition sessions (`flowKey: "acquisition"`)
  - Breeding sessions (`flowKey: "breeding"`)
  - Usage sessions (`flowKey: "usage"`)
  - Risk/resilience sessions (`flowKey: "risk"`)
- Export functions the SessionRunner or Planning Graph engine can call to **turn a planning artifact into a live session object** that matches the shared session contract:

  ```js
  {
    id,
    domain: "animals",
    title,
    source: { type: "animalTask", refId },
    steps: [...],
    prefs: { ... },
    status,
    progress,
    analytics,
    createdAt,
    updatedAt
  }
3. AnimalPlanner.config.json
Purpose

Planning Graph node configuration for the Animal Planner.

Tells the system that animal-planner is a planner-node operating in the animals domain.

Key responsibilities

Define nodeKey and metadata used by the Planning Graph and UI:

nodeKey: "animal-planner"

kind: "planner-node"

domain: "animals"

Labels, descriptions, and tags for display.

Declare how this node fits into the broader graph:

What it feeds into (e.g., storehouse planning, garden planning, stability calculators).

What inputs or prerequisite calculators it depends on (e.g., homestead goals, stability profiles).

Provide a stable contract that the Planning Graph engine can query when constructing higher-level flows (e.g., “Food Stabilization”, “Garden Season Setup”, etc.).

4. AnimalPlanner.mappings.json
Purpose

Next-steps mapping rules that connect Animal Planner flows to recommended actions, calculators, and other planners.

Conforms to your existing nextSteps.mappings.schema.json shape.

Top-level shape

Required fields:

id: "animal-planner-next-steps"

calculator: "planning-next-steps" (or whatever your next-steps calculator id is)

status: "active"

domains: array of domains touched by these mappings (e.g., ["animals","storehouse","garden","preservation","cooking"])

inputs: metadata about source node & flows

rules: array of rules that describe event → recommended next steps

How rules work

Each rule:

Has an id (e.g., "after-animal-acquisition-plan").

Has a when block:

flowId: which Animal Planner flow this applies to (e.g., "animal-acquisition-plan").

eventType: typically "planning.flow.completed".

source: "AnimalPlannerView" so you can distinguish from other planners.

Has a nextSteps array, each item being one recommended next action:

kind: "session-template" | "calculator-node" | "planner-node".

label: text shown in UI.

reason: why this is recommended.

nodeKey: for calculators/planners in the Planning Graph (e.g., "node-food-stabilization").

route: optional route to open if user chooses this next step.

Optional nowIntent:

eventType: "session.requestNext".

focusArea: e.g., "animal-acquisition-plan".

domainHints: e.g., ["animals","storehouse","garden"].

Examples of wiring

After acquisition plan:

Offer “Start Animal Acquisition Session Now” (session-template; domain: animals).

Offer Storehouse Duration Calculator and Food Stabilization Plan pages.

Offer Garden Season Setup and Household Stability Dashboard.

After breeding calendar:

Offer “Breeding Calendar Session” (animals).

Offer Meat Breakdown Calculator and Daily Micronutrient Requirements.

Offer Health Reset Planning Flow.

After usage flow:

Offer “Usage Flow Session”.

Offer Feast Preparation Planning Flow, Food Stabilization, Storehouse Duration.

After risk/resilience:

Offer “Risk & Resilience Session”.

Offer Stability dashboard, Food Stabilization Plan, Garden Season Setup.

These rules are how the Planning Graph engine knows what to surface as “Next best action” when the user finishes a particular Animal Planner flow.

5. AnimalPlanner.routes.js
Purpose

Route configuration for the Animal Planner page(s).

Keeps the main router (src/App.jsx) clean by exporting route objects you can spread into your <Routes> tree.

Key responsibilities

Export animalPlannerRoutes with at least one route:

path: "/animals/planner"

element: <AnimalPlannerView />

handle: metadata for:

Section ("animals")

Label (“Animal Planner”)

Icon (e.g., "🐑")

Description

planningNodeKey: "animal-planner"

A default nowIntent used when the user triggers a top-level “Now” button while on this route.

Breadcrumb info and layout hints (e.g., showRightSidebar, showNowButton).

Example integration

In src/App.jsx (or equivalent):

jsx
Copy code
import animalPlannerRoutes from "@/features/animal/AnimalPlanner.routes";

// Inside <Routes>
{animalPlannerRoutes.map((route) => (
  <Route
    key={route.path}
    path={route.path}
    element={route.element}
    handle={route.handle}
  />
))}
How Animal Planner integrates with SessionRunner
Event-based “Now” CTAs
The Animal Planner view should not directly manipulate SessionRunner state.

Instead, it should:

Import the eventBus from src/services/eventBus.js.

Emit events such as:

js
Copy code
eventBus.emit({
  type: "session.requestNext",
  ts: new Date().toISOString(),
  source: "AnimalPlannerView",
  data: {
    domain: "animals",
    focusArea: "animal-breeding-calendar",
    domainHints: ["animals", "storehouse"]
  }
});
A global session orchestrator (elsewhere in SSA) listens for session.requestNext:

Looks up relevant templates via Planning Graph and AnimalPlanner.logic.

Creates or resumes a session object.

Opens the SessionRunner modal with that session.

Session behavior & guards
SessionRunner (global) is responsible for:

Applying guards (inventory/weather/quietHours/sabbath/equipment).

Writing checkpoints to Dexie every step and every 10 seconds.

Auto-resuming if a running session with the same id is found.

Emitting:

session.started

session.step.changed

session.paused

session.resumed

session.completed

session.aborted

session.exported (when Hub export succeeds)

Animal Planner logic should stay pure:

Prepare steps and metadata.

Let the runner own timers, wake-lock, notifications, and resilience.

How Animal Planner fits into the Planning Graph
Node config (AnimalPlanner.config.json) tells the graph:

“There is a planner node called animal-planner in the animals domain.”

“It feeds into storehouse planning, garden planning, stability, health, etc.”

Mappings (AnimalPlanner.mappings.json) tell the graph:

“After this flow event (e.g., animal-breeding-calendar completes), here are top recommended next steps.”

Other Planning Graph nodes can reference animal-planner in their own configs:

Example: Food Stabilization node may list animal-planner in a feedsFrom or relatedNodes section so the UI can show cross-links.

Extension points
You can extend the Animal Planner module by:

Adding new flows

Add a new flow entry in inputs.flows inside AnimalPlanner.mappings.json.

Add corresponding rules in rules with flowId set to the new flow.

Extend AnimalPlanner.view.jsx with a new section and CTAs.

Extend AnimalPlanner.logic.js with any new calculation or session template generators.

Adding new next-step recommendations

Add more nextSteps under the relevant rules item:

More calculators (e.g., “Feed Cost Estimator”).

More planner nodes (e.g., “Veterinary & Health Planner”).

More session templates.

Integrating deeper with storehouse / garden / preservation

Use AnimalPlanner.logic.js to surface data that can feed:

Storehouse duration calculators.

Garden planning (fodder, compost crops, rotations).

Preservation session templates (e.g., batch canning or curing sessions triggered by projected butcher dates).

Quick mental model
AnimalPlanner.view.jsx
Visual, interactive planning dashboard for all things animals.

AnimalPlanner.logic.js
Brain that turns planning data into feed/butcher/micronutrient implications and session templates.

AnimalPlanner.config.json
“I am a planner node named animal-planner in the Planning Graph.”

AnimalPlanner.mappings.json
“When a specific animal planning flow finishes, here are the next best things you could do.”

AnimalPlanner.routes.js
“Here’s how you get to the Animal Planner page and what metadata the router should know.”

If you keep these responsibilities separate, the Animal Planner stays easy to reason about and very composable with the rest of SSA (Planning Graph, SessionRunner, storehouse, garden, health, and beyond).
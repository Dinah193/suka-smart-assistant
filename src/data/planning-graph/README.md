# Planning Graph – Data Model & Usage Guide

The **Planning Graph** is the backbone of Suka Smart Assistant (SSA).  
It connects:

- Calculators, dashboards, and scorecards  
- Storehouse, garden, animals, and calendar planners  
- SessionRunner sessions (cooking, cleaning, garden, animals, preservation, storehouse)  
- Optional export to the **Family Fund Hub** (via `familyFundMode`)

This folder contains the **data-only definition** of that graph.

---

## 1. Files in `src/data/planning-graph/`

> All of these are configuration/data files. No business logic lives here.

- `planningGraph.nodes.json`  
  - Master list of all **nodes** in the Planning Graph.  
  - Each node represents a single measurable concept:
    - e.g., `node.health.bmi`, `node.storehouse.storehouseMealsCapacity`.

- `planningGraph.domains.json`  
  - Groups nodes into **logical domains** used for UI and scoring:
    - `health`, `storehouse`, `garden`, `calendar`, `stability`.

- `planningGraph.mappings.json`  
  - Maps each node ID → **routes, components, and automation modules**:
    - Which page to open
    - Which widget to show on dashboards
    - Which planner/agent consumes the node’s score
    - Which event names to emit on updates

- `planningGraph.version.md`  
  - Human-readable **changelog** for Planning Graph changes:
    - What changed, why, and impact on UI/automation.

- `README.md` (this file)  
  - Explains how everything fits together and how to extend it safely.

---

## 2. Supporting Schemas

Schemas live in:

- `src/schemas/planningGraph/`

Currently:

- `domains.schema.json` – validates `planningGraph.domains.json`
- (You can add more: `nodes.schema.json`, `mappings.schema.json`, etc.)

Each data file can reference its schema with a relative `$schema` path, e.g.:

```jsonc
{
  "$schema": "../../schemas/planningGraph/domains.schema.json",
  "version": 1,
  "lastUpdated": "2025-11-26T00:00:00.000Z",
  "domains": [ /* ... */ ]
}
If you add schemas for other files, use the same pattern and update $schema accordingly.

3. Core Concepts
3.1 Node
A node is a single measurable or computable concept in the Planning Graph.

Examples:

node.health.bmi

node.storehouse.storehouseMealsCapacity

node.garden.seedViabilityCalculator

node.calendar.mealCalendarCoverage

node.stability.planningGraphCompositeScore

(Exact shape is defined in planningGraph.nodes.json / its schema, but conceptually each node has:)

id – unique ID (e.g., node.health.bmi)

label – human-readable name for UI

description – what this node measures

domainId – which domain it belongs to (also expressed via planningGraph.domains.json)

score or value metadata – how the node is computed/stored (actual score calculation lives in code, not here)

Optional hints: units, range, tags, etc.

Nodes are pure definitions. They don’t know about routes or components; that’s the job of mappings.

3.2 Domain
A domain is a logical grouping of nodes for UI & scoring.
Defined in planningGraph.domains.json.

Example (simplified):

jsonc
Copy code
{
  "id": "storehouse",
  "label": "Storehouse & Meals",
  "shortLabel": "Storehouse",
  "description": "Pantry depth, meal coverage, and protein breakdown across fresh, frozen, preserved, and dry goods.",
  "weight": 0.30,
  "ui": {
    "accentColor": "#F97316",
    "icon": "warehouse"
  },
  "nodes": [
    "node.storehouse.storehouseMealsCapacity",
    "node.storehouse.meatBreakdownCalculator",
    "node.storehouse.storehouseMonthsOfCover",
    "node.storehouse.priceBookCoverage",
    "node.storehouse.couponCycleAlignment",
    "node.storehouse.bulkPurchasingReadiness"
  ]
}
Key points:

id – stable machine ID (e.g., health, storehouse, garden)

label / shortLabel – what users see on dashboards, tabs, chips, etc.

weight – relative importance of this domain in composite scores:

Not required to sum to 1; they are treated proportionally.

ui.accentColor / ui.icon – visual hints:

Domain color for charts, cards, and badges.

Icon token for the shared icon system.

nodes – list of node IDs in this domain:

Must match IDs in planningGraph.nodes.json.

3.3 Mapping
A mapping connects a node to:

Routes – where you go in SSA

Components – which React components to render for this node

Feature modules – where the logic lives

Automation – planner agents & event names

Defined in planningGraph.mappings.json.

Example (simplified):

jsonc
Copy code
{
  "nodeId": "node.storehouse.meatBreakdownCalculator",
  "routes": {
    "primary": "/tier2/calculators/meat-breakdown",
    "dashboard": "/tier2/storehouse",
    "butchery": "/tier2/storehouse/butchery"
  },
  "components": {
    "page": "MeatBreakdownCalculatorPage",
    "widget": "MeatBreakdownSummaryCard",
    "runnerCard": "MeatSessionHintCard"
  },
  "featureModule": "features/calculators/storehouseMeals/MeatBreakdownCalculator",
  "automation": {
    "plannerAgent": "butcheryPlanningAgent",
    "events": {
      "onScoreUpdated": "planningGraph.nodeScore.updated.storehouse.meatBreakdownCalculator"
    }
  }
}
Field meanings:

nodeId

Must match a node in planningGraph.nodes.json.

routes

primary – the main page for this node (calculator or primary UI).

dashboard – where this node’s widget card appears on domain dashboards.

Other keys (e.g., butchery, storehouse, preservation, etc.) can be used by features that care about domain context.

components

page – React page component name (e.g., MeatBreakdownCalculatorPage).

widget – dashboard card component.

runnerCard – small HUD component for SessionRunner or sidebars.

featureModule

Path to the feature folder/module in src/features/….

Used by routing + dynamic imports.

automation

plannerAgent – which planner/agent is responsible for using this node’s score:

e.g., mealPlanEngine, storehousePlannerAgent, gardenPlannerAgent.

events.onScoreUpdated – event name emitted when this node’s score is recomputed:

Usually something like:
planningGraph.nodeScore.updated.<domain>.<nodeName>

The goal: changing a node’s behavior or UI should usually be possible by editing its mapping, not scattered across code.

4. How SSA Uses the Planning Graph
4.1 Dashboards & UI
Domain-level dashboards

Use planningGraph.domains.json to:

Render sections: Health, Storehouse, Garden, Calendar, Stability.

Apply domain-specific colors & icons.

Show domain-level scores (aggregated from node scores).

Cards & widgets

For each node in a domain’s nodes array:

Look up the mapping in planningGraph.mappings.json.

Render components.widget component as a card in that domain’s section.

Provide a “View details” or “Open” button that navigates to routes.primary.

Navigation chips / quick links

Use domain shortLabel and ui.accentColor to build nav chips.

Clicking a chip can:

Filter dashboard to that domain, or

Jump to a domain-specific page like /tier2/storehouse.

4.2 Automation, Agents & Events
Planner agents (e.g., mealPlanEngine, storehousePlannerAgent, gardenPlannerAgent) use the Planning Graph in three main ways:

Input scores

Nodes represent inputs or outputs:

Example: node.health.dailyEnergyRequirement informs meal planning portions.

Example: node.storehouse.storehouseMonthsOfCover informs bulk purchase suggestions.

Score updates

When calculators or background workers recompute node scores:

Emit the automation.events.onScoreUpdated event via the event bus.

Example payload:

js
Copy code
eventBus.emit({
  type: "planningGraph.nodeScore.updated.storehouse.meatBreakdownCalculator",
  ts: new Date().toISOString(),
  source: "MeatBreakdownCalculator",
  data: {
    nodeId: "node.storehouse.meatBreakdownCalculator",
    score: 0.82,
    meta: { /* any hints */ }
  }
});
SessionRunner hints

Agents can feed hints into SessionRunner:

“You’re low on storehouse meals capacity; recommend a batch cooking session.”

“Garden yield projection is high while storehouse capacity is free; suggest preservation sessions.”

The Planning Graph gives a standardized vocabulary for all of this.

4.3 SessionRunner & “Now” Buttons
Although the SessionRunner code lives elsewhere, the Planning Graph supports it by:

Helping determine “next runnable session” based on node scores:

Example logic:

If node.storehouse.storehouseMealsCapacity < target → prioritize cooking/preservation sessions.

If node.calendar.cleaningRhythmConsistency is low → suggest cleaning sessions.

Providing contextual cards inside the SessionRunner modal:

components.runnerCard can be rendered in the sidebar:

e.g., show “Storehouse coverage” hint while running a cooking batch.

e.g., show “Seed viability” hint during a garden task session.

Guiding Hub export when familyFundMode === true:

Composite scores (e.g., node.stability.planningGraphCompositeScore) can be exported as part of analytics packets to the Hub.

5. Versioning & Changes
Where to track changes
Data-level changes to nodes, domains, or mappings:

Update planningGraph.version.md.

Add a new version entry at the top with:

Date

What changed

Impact on UI and automation.

Schema-level changes (e.g., new required properties):

Update the relevant schema in src/schemas/planningGraph/.

Ensure data files referencing that schema validate correctly.

6. Extending the Planning Graph
When adding a new calculator, feature, or concept, follow this checklist:

Step 1 – Add or update a node
Edit planningGraph.nodes.json:

Add a new node.* entry with:

id, label, description, domainId, etc.

Make sure id is unique and consistent:

Pattern: node.<domain>.<concept>
e.g., node.health.sleepQualityScore, node.storehouse.freezerRedundancyIndex.

Step 2 – Assign the node to a domain
Edit planningGraph.domains.json:

Find the appropriate domain (health, storehouse, etc.).

Add the new node ID to that domain’s nodes array.

If this is a completely new domain:

Create a new domain object with id, label, weight, ui, and nodes.

Step 3 – Map routes, components, and automation
Edit planningGraph.mappings.json:

Add an object like:

jsonc
Copy code
{
  "nodeId": "node.health.sleepQualityScore",
  "routes": {
    "primary": "/tier2/calculators/sleep-quality",
    "dashboard": "/tier2/dashboard"
  },
  "components": {
    "page": "SleepQualityCalculatorPage",
    "widget": "SleepQualityScoreCard",
    "runnerCard": "SleepHintCard"
  },
  "featureModule": "features/calculators/health/SleepQualityCalculator",
  "automation": {
    "plannerAgent": "healthPlannerAgent",
    "events": {
      "onScoreUpdated": "planningGraph.nodeScore.updated.health.sleepQualityScore"
    }
  }
}
Make sure these component names and routes align with your React code and router.

Step 4 – Wire the logic (outside this folder)
Implement the React components and feature modules referenced in the mapping:

SleepQualityCalculatorPage, SleepQualityScoreCard, etc.

Update planners/agents as needed to consume the new node’s score.

Emit onScoreUpdated events when values change.

Step 5 – Update the changelog
Edit planningGraph.version.md:

Add a new version entry describing:

New node

Domain

Mappings

Any UI/automation changes.

7. Safety & Maintenance Tips
Don’t hard-code node IDs in random places.

Prefer to reference nodeId constants or use centralized helpers when possible.

Use schemas to catch mistakes early.

If VS Code flags a schema error, fix it before wiring code.

Keep domains small and meaningful.

If a domain grows too large, consider:

Sub-domains (via naming conventions), or

Refactoring into multiple domains.

Always update the changelog.

It’s easier to understand why a score changed behavior later if there’s a human-readable entry.

8. How This Fits Into SSA Overall
The Planning Graph is your household brain map:

Nodes = what you can measure or score.

Domains = how you group those measures into themes.

Mappings = how users see and interact with them in SSA.

SessionRunner, planners, and Hub export all speak this language:

That’s what keeps cooking, cleaning, garden, animals, preservation, and storehouse tools in sync.

As you build more calculators, dashboards, and automations:

Grow the Planning Graph first, then wire behavior around it.
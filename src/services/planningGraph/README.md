# Planning Graph Services – Overview & Usage

> The Planning Graph is SSA’s “household brain map”:  
> it connects calculators, sessions, storehouse goals, garden plans, flows, and stability metrics into one navigable graph.

This folder contains the **service layer** for working with Planning Graph JSON files:

- Loading + versioning Graph files
- Building efficient in-memory indexes
- High-level queries (neighbors, domains, paths)
- Executing Planning Flows step-by-step
- Running diagnostics to catch broken links / integrity issues

These services are **pure JavaScript** and **UI-agnostic**. React views, calculators, and SessionRunner logic **consume** these services, but the services themselves do not import UI.

---

## 1. Core Concepts

### 1.1 Planning Graph

A **Planning Graph** is a typed graph:

- **Nodes** = “things that exist” in SSA  
  e.g. calculators, storehouse goals, garden plans, stability dimensions, flows, session templates, external imports, etc.

- **Edges** = “relationships” between those things  
  e.g. *feedsInto*, *requires*, *suggests*, *conflictsWith*, *stabilityMetricFor*, *sessionTemplateFor*, etc.

Each graph is stored as JSON:

- `id` – graph id (e.g. `"household-planning-v1"`)
- `version` – semantic version string (e.g. `"1.0.0"`)
- `nodes` – array of node definitions
- `edges` – array of edge definitions

The Planning Graph is **read-only at runtime** (for now). Authoring is done by editing JSON files per the schema.

---

## 2. Files in This Folder

### 2.1 `planningGraphLoader.js`

**Responsibility:**  
Load Planning Graph JSON files and handle versioning.

**Key behaviors:**

- Resolves a graph by id from:
  - Embedded JSON imports (e.g. `@/data/planningGraph/*.json`), or
  - A dynamic loader (if you later wire a remote source)
- Normalizes structure and attaches internal metadata:
  - Ensures `id`, `version`, `nodes`, and `edges` exist
  - Assigns internal indices (`__index`) for nodes/edges to aid diagnostics
- Caches loaded graphs by id for reuse

**You typically use:**

```js
import { loadPlanningGraph } from "@/services/planningGraph/planningGraphLoader";

const graph = await loadPlanningGraph("household-planning-v1");
2.2 planningGraphIndex.js
Responsibility:
Build efficient in-memory indexes of nodes and edges.

Key behaviors:

Given a raw graph object, builds:

nodeById: Map<string, Node>

edgesFrom: Map<string, Edge[]>

edgesTo: Map<string, Edge[]>

edgesByType: Map<string, Edge[]>

Exposes helper accessors:

getNodeById(index, nodeId)

getOutgoing(index, nodeId, [edgeType])

getIncoming(index, nodeId, [edgeType])

Typical usage:

js
Copy code
import {
  getIndexedPlanningGraph,
  getOutgoing,
} from "@/services/planningGraph/planningGraphIndex";

const index = await getIndexedPlanningGraph("household-planning-v1");
const outgoing = getOutgoing(index, "storehouse:annual-goal");
Use this when you need fast neighbor lookups vs. scanning arrays.

2.3 planningGraphQueries.js
Responsibility:
Provide higher-level query utilities on top of the indexed graph.

Examples of what it exposes:

findNodesByDomain(index, domain)
Get all nodes for a domain (e.g. "cooking", "garden").

findNeighbors(index, nodeId, { direction, edgeType })
Get upstream/downstream neighbors.

findPath(index, { from, to, maxDepth, allowedEdgeTypes })
Optional path search for reasoning about “how X feeds into Y”.

listDomainEntryPoints(index, domain)
Nodes that are valid “entry points” for flows in a domain.

Typical usage:

js
Copy code
import {
  getIndexedPlanningGraph,
  findNodesByDomain,
  findNeighbors,
} from "@/services/planningGraph/planningGraphQueries";

const index = await getIndexedPlanningGraph("household-planning-v1");
const cookingNodes = findNodesByDomain(index, "cooking");

const neighbors = findNeighbors(index, "calculator:daily-macros", {
  direction: "out",
  edgeType: "feedsInto",
});
2.4 planningFlowEngine.js
Responsibility:
Execute configured Planning Flows step-by-step and emit events.

A Planning Flow is a small DSL that describes how to walk the Planning Graph for a goal:

"Stabilize storehouse macros"

"Prep winter garden beds"

"Align daily meals to macro plan"

"Stability baseline onboarding"

Key step kinds implemented:

kind: "calculator"

Uses calculatorRunner.runCalculator(calculatorId, input, options)

Merges step’s calculatorInput with flow context (context.vars)

kind: "sessionTemplate"

Emits a ready event for automation runtime to turn into a SessionRunner session:

planningFlow.sessionTemplate.ready

kind: "note"

Emits info-level guidance:

planningFlow.note

kind: "noop"

Safe no-op; used for placeholders/feature flags.

Events emitted:

Flow-level:

planningFlow.started

planningFlow.completed

planningFlow.aborted

planningFlow.error

Step lifecycle:

planningFlow.step.lifecycle with { phase: "started" | "completed" | "error", ... }

Template hints:

planningFlow.sessionTemplate.ready

planningFlow.note

Typical usage:

js
Copy code
import { runPlanningFlow } from "@/services/planningGraph/planningFlowEngine";
import baselineFlow from "@/data/planningFlows/storehouseBaseline.flow.json";

const result = await runPlanningFlow(baselineFlow, {
  graphId: "household-planning-v1",
  context: {
    householdId: "house:123",
    userId: "user:abc",
    vars: {
      // domain-specific inputs
      targetCalories: 2200,
    },
  },
  onStepLifecycle: (payload) => {
    // Optional local side-effects, logging, or UI updates
    console.log("Flow step lifecycle:", payload);
  },
});
Downstream listeners (automation, dashboards) can subscribe to these events via the global eventBus.

2.5 planningDiagnostics.js
Responsibility:
Tools to validate graph integrity and catch broken links early.

Checks implemented:

Duplicate node ids

Edges referencing missing nodes

Duplicate edges (from → to with same type)

Isolated nodes (no incoming or outgoing edges)

Unknown node domains (optional; pass allowedDomains)

Events emitted:

planningGraph.diagnostics.started

planningGraph.diagnostics.issue

planningGraph.diagnostics.completed

Typical usage:

js
Copy code
import { runPlanningDiagnostics } from "@/services/planningGraph/planningDiagnostics";

const result = await runPlanningDiagnostics("household-planning-v1", {
  allowedDomains: [
    "cooking",
    "cleaning",
    "garden",
    "animals",
    "preservation",
    "storehouse",
    "stability",
    "meta",
  ],
});

// result.summary.hasErrors tells you if the graph is safe to deploy.
This is ideal for build-time checks or a hidden admin diagnostics panel.

3. Planning Graph JSON Shape (High-Level)
The exact schema belongs in /schemas/planningGraph/*.schema.json.
Below is a simplified view for authors:

jsonc
Copy code
{
  "id": "household-planning-v1",
  "version": "1.0.0",
  "label": "Household Planning Graph – v1",
  "nodes": [
    {
      "id": "calculator:daily-macros",
      "type": "calculator",
      "domain": "stability",
      "label": "Daily Macro Requirement Calculator",
      "tags": ["nutrition", "storehouse", "stability"],
      "meta": {
        "calculatorId": "daily-macros",
        "description": "Calculates daily macros by age, sex, and activity."
      }
    },
    {
      "id": "goal:annual-storehouse-macros",
      "type": "goal",
      "domain": "storehouse",
      "label": "Annual Macro Storehouse Goal"
    }
  ],
  "edges": [
    {
      "id": "edge:calc→goal",
      "from": "calculator:daily-macros",
      "to": "goal:annual-storehouse-macros",
      "type": "feedsInto",
      "weight": 1
    }
  ]
}
The services in this folder expect this basic shape; additional metadata can be added under meta as needed.

4. Typical Flow: From Graph → UX
Here’s how everything fits into SSA:

Load + Index Graph

js
Copy code
const index = await getIndexedPlanningGraph("household-planning-v1");
Query for Relevant Nodes/Edges

Find all nodes for a domain (e.g., garden).

Find paths from calculators to storehouse goals.

Find flows and templates attached to a stability dimension.

Execute a Planning Flow

Use planningFlowEngine.runPlanningFlow(flowDef, options) to:

Run calculators

Emit session template hints

Provide notes / guidance

Automation + SessionRunner

Automation runtime listens for events:

planningFlow.sessionTemplate.ready

planningFlow.step.lifecycle

It then:

Creates or updates Session objects (per Session contract),

Launches SessionRunner when the user hits “Now”,

Logs analytics and optionally exports to Hub (if familyFundMode).

Diagnostics & Safety

Before shipping a new graph version, run:

runPlanningDiagnostics(graphId) to catch broken links.

5. Usage Patterns & Best Practices
5.1 Authoring New Graphs
Keep graph IDs stable and semantic:

household-planning-v1

stability-planning-v1

Use namespaces in node ids:

calculator:daily-macros

goal:annual-storehouse-macros

sessionTemplate:batch-cooking-weekend

Keep domains limited to a known set for easier reasoning:

"cooking" | "cleaning" | "garden" | "animals" | "preservation" | "storehouse" | "stability" | "meta"

5.2 Wiring Calculators
Node type: calculator

meta.calculatorId should match the id registered in calculatorRegistry.js.

Edges:

type: "feedsInto" or "supports" for storehouse goals / stability metrics.

5.3 Wiring Session Templates
Node type: sessionTemplate

meta can include:

domain (cooking, cleaning, etc.)

sessionBlueprintId or a bundle of default step templates.

Edges:

From calculators/goals to session templates so flows can discover them.

5.4 Building Planning Flows
Store flows as separate JSON (e.g., /src/data/planningFlows/*.flow.json).

Steps should reference:

nodeId for graph alignment,

calculatorId when kind === "calculator",

meta.note for guidance when kind === "note".

Example snippet:

jsonc
Copy code
{
  "id": "flow:storehouse-macro-baseline",
  "label": "Storehouse Macro Baseline",
  "graphId": "household-planning-v1",
  "steps": [
    {
      "id": "step:macro-calc",
      "kind": "calculator",
      "label": "Calculate Daily Macro Needs",
      "nodeId": "calculator:daily-macros",
      "calculatorId": "daily-macros",
      "calculatorInput": {
        "fallbackActivity": "moderate"
      }
    },
    {
      "id": "step:batch-cooking-template",
      "kind": "sessionTemplate",
      "label": "Recommend Batch Cooking Sessions",
      "nodeId": "sessionTemplate:batch-cooking-weekend"
    }
  ]
}
6. Events & Integration Points
The Planning Graph services use the global SSA eventBus:

Event envelope:

js
Copy code
{
  type: "string",
  ts: "ISO 8601 timestamp",
  source: "planningGraph.* or planningFlow.*",
  data: { ...payload }
}
Common event types:

planningFlow.started

planningFlow.completed

planningFlow.step.lifecycle

planningFlow.sessionTemplate.ready

planningFlow.note

planningGraph.diagnostics.started

planningGraph.diagnostics.issue

planningGraph.diagnostics.completed

Any module (analytics, automation, UI overlays) can subscribe to these events and react accordingly.

7. Extending the Planning Graph System
You can safely extend this system in a few directions:

New Step Types in planningFlowEngine

Example: kind: "decision" for branching logic.

Example: kind: "hubExport" for direct Family Fund Hub exports.

New Edge Types

Add edge.type categories and handle them in queries:

potentialSubstituteFor

conflictsWith

followsAfter (for sequences)

Custom Diagnostics

Add domain-specific checks in planningDiagnostics.js:

Ensure all calculator nodes have a valid meta.calculatorId.

Ensure all sessionTemplate nodes map to at least one domain.

Admin UI

Build a simple Admin Planning Graph Dashboard using:

runPlanningDiagnostics(graphId) for a one-click health check;

planningGraphQueries to visualize subgraphs.

8. When to Use What
I need to know what exists and how it connects:
→ planningGraphLoader + planningGraphIndex + planningGraphQueries.

I want to walk a curated path (plan) across calculators and templates:
→ planningFlowEngine.runPlanningFlow.

I want to be sure my graph is safe before deploying:
→ planningDiagnostics.runPlanningDiagnostics.

I’m wiring a UI (e.g., Stability Dashboard, Planner pages):
→ Use queries & flows as the data source; never hard-code relationships if they can live in the graph.

9. Notes & Future Directions
Planning Graphs are intentionally lightweight and data-driven.
As SSA grows, you can:

Move graph storage to Dexie or a remote API,

Version graphs per household or family,

Allow advanced users to create custom flows on top of the same engines.

The goal is that calculators, sessions, and dashboards are all plugged into the same Planning Graph so that:

“Now” buttons,

Recommendations, and

Stability diagnostics

all draw from one coherent map of the household.
# Suka Smart Assistant (SSA) – Reasoner Prompt Templates

> **File:** `src/agents/prompts/templates.md`  
> **Role:** Central library of **prompt templates** used when calling the SSA Reasoner (LLM) in different modes.

These templates are combined with:

- The **system instructions** in `system.md`,
- The **mode → schema mapping** in `src/agents/modes/map.js`,
- The **JSON Schemas** in `src/agents/prompts/reasoner-contracts/*.schema.json`,
- Dexie-derived **context snippets** from `src/agents/context/selectors.js`.

They should be used by the calling code (not by the Reasoner itself) to construct **strict, JSON-only** requests and responses.

---

## 1. Template usage guidelines

### 1.1 Roles

Each Reasoner invocation generally uses:

- **System message:**  
  `system.md` contents (global behavior, contracts, safety rules).

- **User message:**  
  One of the templates below, with placeholders filled by the caller:
  - `{{mode}}` – mode identifier, e.g. `"cooking.substitutions"`.
  - `{{schema}}` – JSON Schema for the response.
  - `{{input}}` – structured input payload sent to the Reasoner.
  - `{{context}}` – Dexie context and other household state (already minimized).
  - `{{notes}}` – optional human-readable notes from the calling code.

The Reasoner must respond with **one single JSON object** that validates against `{{schema}}`, with **no markdown fences** and **no extra text**.

### 1.2 Common instructions (to be baked into every template)

All templates must end with the same core instructions:

1. **Output must be JSON only** (no markdown, no comments).
2. **Output must validate against the provided JSON Schema.**
3. **No external data** beyond what’s explicitly in `{{input}}` and `{{context}}`.
4. Prefer **safe, simple, guard-respecting plans** over clever but risky ones.
5. Use any schema-provided fields for:
   - Guard summaries,
   - Confidence,
   - Warnings or follow-up requirements,
   - Explanations and tradeoff notes.

---

## 2. Base Reasoner template

Use this for new modes or generic reasoning tasks that have a well-defined schema but no dedicated section below.

### 2.1 Template: `base`

```text
You are the SSA Reasoner running in mode "{{mode}}".

You receive:
- A JSON Schema that the response MUST validate against.
- Household context from Dexie and other selectors.
- A structured input describing the current intent and situation.

Your task is to produce EXACTLY ONE JSON OBJECT that:
- Conforms 100% to the provided JSON Schema.
- Reflects the constraints and data in the context and input.
- Follows household safety and culture rules (Sabbath, quiet hours, weather, inventory, battery) as described in the system instructions.

### JSON Schema for the response

```json
{{schema}}
Context
The following JSON object contains relevant household context (inventory, sessions, calendar, weather, etc.) already minimized for this decision:

json
Copy code
{{context}}
Input
The following JSON object describes the specific intent and request you must handle in mode "{{mode}}":

json
Copy code
{{input}}
Additional notes for this call (optional)
text
Copy code
{{notes}}
Critical output rules
Respond with a SINGLE JSON OBJECT only.

DO NOT wrap the JSON in markdown fences.

DO NOT include comments anywhere in the JSON.

The JSON MUST validate against the schema given above.

Use guard-related fields (if present in the schema) to reflect Sabbath, quiet hours, weather, inventory, and battery considerations.

If the schema supports confidence / follow-up flags, use them instead of guessing when information is missing or ambiguous.

yaml
Copy code

---

## 3. Cooking substitutions template

**File:** `substitutions.delta.schema.json`  
**Mode example:** `"cooking.substitutions"`

This template helps the Reasoner propose substitutions for missing or restricted ingredients, with risk and flavor notes, and links back to inventory and step logic.

### 3.1 Template: `cooking.substitutions`

```text
You are the SSA Reasoner running in mode "cooking.substitutions".

Goal:
- Generate a structured set of ingredient substitution suggestions for a cooking task.
- Respect household inventory, dietary restrictions, and cooking rules.
- Return a JSON object that matches the provided "cooking substitutions delta" schema.

The runtime will use your output to:
- Show substitution options in the SessionRunner,
- Annotate steps with substitution notes,
- Adjust inventory and guard summaries as allowed by the schema.

### JSON Schema for the response

```json
{{schema}}
Context
Context includes:

Household inventory and pantry data (available ingredients, quantities, tags),

Any known dietary restrictions or preferences,

Existing substitution knowledge or prior deltas.

json
Copy code
{{context}}
Input
The input describes:

The recipe or session source,

The specific ingredients that are missing, undesired, or constrained,

Any relevant cooking rules (e.g., must avoid dairy, prefer whole grains).

json
Copy code
{{input}}
Guidance
Prefer substitutions that:

Are present in inventory (if any),

Preserve safety and basic recipe integrity,

Are clearly labeled with risk/quality impact via fields in the schema.

Use short, clear explanation fields (e.g., reason, flavorImpact) instead of long prose.

If no reasonable substitution exists, mark the ingredient as blocked or requires user shopping using the schema’s fields.

If allowed by the schema, populate:

Guard summaries (e.g., inventory issues),

Confidence scores,

Follow-up hints (e.g., user should confirm for high-impact substitutions).

Critical output rules
Respond with EXACTLY ONE JSON OBJECT only.

DO NOT wrap the JSON in markdown fences.

DO NOT include comments.

The JSON MUST fully validate against the "cooking substitutions delta" JSON Schema above.

yaml
Copy code

---

## 4. Garden/animal schedule tradeoffs template

**File:** `scheduleTradeoffs.delta.schema.json`  
**Mode example:** `"homestead.scheduleTradeoffs"`

This template is used to evaluate and propose **schedule tradeoffs** for garden and animal tasks under constraints like weather, labor availability, Sabbath, and quiet hours.

### 4.1 Template: `homestead.scheduleTradeoffs`

```text
You are the SSA Reasoner running in mode "homestead.scheduleTradeoffs".

Goal:
- Analyze garden and animal tasks against current constraints (weather, calendar, Sabbath, quiet hours, labor).
- Propose schedule adjustments and tradeoffs in a structured format.
- Return a JSON object that matches the "schedule tradeoffs delta" schema.

The runtime will use your output to:
- Suggest rescheduling, batching, or splitting tasks,
- Inform the SessionRunner of guard issues,
- Provide the user with options for safer or more efficient timing.

### JSON Schema for the response

```json
{{schema}}
Context
Context may include:

Existing tasks (garden, animals) with time windows and priorities,

Weather snapshot/forecast (as known in Dexie),

Sabbath and quiet-hours time blocks,

Labor availability windows,

Any prior schedule deltas.

json
Copy code
{{context}}
Input
The input describes:

The specific set of tasks and target timeframe,

Hard vs soft constraints,

User preferences (e.g., avoid working in midday heat, prefer early morning chores).

json
Copy code
{{input}}
Guidance
Use the schema to:

Mark which tasks are safe as-is,

Which tasks should be moved (with suggested new time windows),

Which tasks can be batched together.

For each tradeoff, explain the logic concisely in the schema’s explanation fields (e.g., reason, benefits, risks).

Respect guard priorities:

Hard blocks like Sabbath / severe weather must not be ignored.

Quiet hours should be treated as strong constraints for noisy tasks.

Use summary fields (e.g., guardSummary, overallImpact) so the UI can present a clear decision.

If information is insufficient or ambiguous, lower your confidence and indicate needsFollowUp where the schema permits.

Critical output rules
Respond with a SINGLE JSON OBJECT only.

DO NOT wrap the JSON in markdown fences.

DO NOT include comments.

The JSON MUST fully validate against the "schedule tradeoffs delta" JSON Schema above.

yaml
Copy code

---

## 5. Step ordering / parallelization template

**File:** `stepOrdering.delta.schema.json`  
**Mode example:** `"session.stepOrdering"`

This template helps the Reasoner propose a better schedule of steps (reordering, grouping, parallelization) for a session’s tasks.

### 5.1 Template: `session.stepOrdering`

```text
You are the SSA Reasoner running in mode "session.stepOrdering".

Goal:
- Reorder and/or group steps for a given session to improve flow and safety.
- Respect dependencies, guard constraints, and equipment limitations.
- Return a JSON object that matches the "step ordering delta" schema.

The runtime will use your output to:
- Restructure the sequence of steps in a cooking/cleaning/garden/animal/preservation session,
- Indicate which steps can run in parallel,
- Provide hints and timing adjustments for the SessionRunner.

### JSON Schema for the response

```json
{{schema}}
Context
Context may include:

The current session object (steps, domains, equipment tags),

Inventory notes and constraints,

Guard-related context (Sabbath, quiet hours, weather, battery),

Any existing ordering or grouping data.

json
Copy code
{{context}}
Input
The input describes:

The original step list and any known dependencies,

User preferences (e.g., minimize active time, prioritize getting food ready by a certain time),

Session/domain-specific rules (e.g., do not leave raw meat at room temp too long).

json
Copy code
{{input}}
Guidance
Respect strict dependencies:

Don’t move steps earlier than prerequisites allow.

Keep food-safety constraints in mind (e.g., refrigeration or holding temps).

Identify parallelizable work where safe:

E.g., simmering sauce while chopping vegetables.

Use the schema’s fields for parallel groups and timing offsets.

Use guard-related fields (e.g., guardSummary) to flag steps that:

Should not be done during quiet hours (noisy equipment),

Conflict with Sabbath or other policy constraints.

Provide concise explanations in the schema’s explanation fields for:

Why certain steps were moved,

Why certain steps were grouped or kept separate.

If ordering is ambiguous and multiple schedules are equally valid:

Prefer simpler, lower-risk schedules.

Use confidence fields to reflect your certainty level.

Critical output rules
Respond with a SINGLE JSON OBJECT only.

DO NOT wrap the JSON in markdown fences.

DO NOT include comments.

The JSON MUST fully validate against the "step ordering delta" JSON Schema above.

yaml
Copy code

---

## 6. Session composition / normalization template

**Mode example:** `"session.compose"`  
**Output schema example:** `session.compose.delta.schema.json` (or equivalent defined in your contracts).

This template is used to transform raw imports (recipes, cleaning plans, garden plans, animal tasks) into normalized session structures suitable for SSA’s SessionRunner and guards.

### 6.1 Template: `session.compose`

```text
You are the SSA Reasoner running in mode "session.compose".

Goal:
- Transform imported or ad-hoc content into a normalized session definition (or delta) that SSA can run.
- Split high-level instructions into clear, timed steps with blockers and metadata.
- Return a JSON object that matches the "session compose delta" schema for the current domain.

The runtime will use your output to:
- Create or update sessions in Dexie,
- Connect sessions to guard evaluation,
- Drive the SessionRunner UI and timers.

### JSON Schema for the response

```json
{{schema}}
Context
Context may include:

The raw imported content (recipe, cleaning plan, garden/animal schedule),

Domain-specific rules or heuristics,

Inventory context (optional),

Previously composed sessions (for reference).

json
Copy code
{{context}}
Input
The input describes:

The source type and identifiers (recipe, cleaningPlan, gardenPlan, animalTask, import, manual),

The raw instructions, notes, and any structured metadata (ingredients, tools, deadlines),

Domain hints (e.g., "batch cooking", "deep clean", "seed starting").

json
Copy code
{{input}}
Guidance
Break work into steps with:

Clear title and desc,

Reasonable durationSec estimates,

Appropriate blockers (inventory, weather, quietHours, sabbath, equipment),

Metadata such as tempTargetF, donenessCue, and cueNotes for cooking sessions.

Preserve source references so SSA can link back to the originating recipe/plan.

Avoid over-fragmentation; aim for steps the user can easily follow and check off.

Use schema fields for:

Guard summaries,

Confidence and follow-up flags,

Notes for the UI to render as TTS-friendly text.

Prefer safe, conservative timing and instructions when unsure.

Critical output rules
Respond with a SINGLE JSON OBJECT only.

DO NOT wrap the JSON in markdown fences.

DO NOT include comments.

The JSON MUST fully validate against the "session compose delta" JSON Schema above.

markdown
Copy code

---

## 7. Extending templates for new modes

When adding a new mode:

1. Define or update its **output schema** in `src/agents/prompts/reasoner-contracts/*.schema.json`.
2. Register the mode in `src/agents/modes/map.js`.
3. Add a new subsection in this file with:
   - A clear, short description of the mode’s goal,
   - An embedded `{{schema}}`, `{{context}}`, `{{input}}` structure,
   - Mode-specific guidance about guards, tradeoffs, and confidence,
   - The standard **Critical output rules** paragraph.

Keep all templates:

- **Concise yet unambiguous,**
- **Aligned with `system.md`,**
- **Strict about JSON-only output and schema validation.**
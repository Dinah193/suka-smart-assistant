# BiblicalOfferingCalculator

> **Location**  
> `src/features/calculators/calendar/BiblicalOfferingCalculator/`

The **Biblical Offering Calculator** is a Planning Graph calculator-node inside Suka Smart Assistant (SSA). It helps the household **explore, categorize, and plan** around the biblical offerings and sacrifices (Torah + related texts) without re-creating a temple system.

Instead of “doing sacrifices,” this node focuses on:

- **Study & curriculum flows** (teach what the offerings are and why they matter).
- **Character and repentance work** (heart posture instead of animal blood).
- **Household practice analogies** (e.g., hospitality, mutual aid, thanksgiving meals).
- **Calendar alignment** (where offerings intersect with feasts and special days).

It feeds into the **calendar**, **study planner**, and **household session flows** (e.g., special feast-prep sessions, devotional sessions) via the Planning Graph and the shared SessionRunner.

---

## 1. Files in this feature

All files live under:

`src/features/calculators/calendar/BiblicalOfferingCalculator/`

- `BiblicalOfferingCalculator.config.json`  
  Node configuration for the Planning Graph (calculator-node + wiring).

- `BiblicalOfferingCalculator.schema.json`  
  JSON Schema describing **inputs** and **outputs** of this calculator.

- `BiblicalOfferingCalculator.shim.js`  
  Pure logic module that implements the calculator behavior (mapping inputs → outputs).

- `BiblicalOfferingCalculator.view.jsx`  
  UI component for **exploring offerings and related scriptures** with SSA styling + “Next Steps”.

- `BiblicalOfferingCalculator.hooks.js`  
  React hooks that tie calculator outputs into **study planner** and **calendar** flows, and optionally trigger **sessions**.

- `BiblicalOfferingCalculator.mappings.json`  
  Planning Graph Next Steps mapping that explains how this node’s outputs feed **study/curriculum flows**, calendar suggestions, and session templates.

---

## 2. Concept & purpose

### 2.1 What the calculator does

This calculator takes **offering-related inputs** (scripture refs, offering types, contexts, focus topics) and produces structured outputs for:

- **Offering categories**  
  Burnt, peace, sin, guilt, grain, drink, wave, heave, etc.

- **Key scripture sets**  
  Primary passages + related cross-references organized in a study-friendly way.

- **Thematic summaries**  
  Short descriptions of the offering’s purpose and heart posture.

- **Modern practice analogies**  
  Non-sacrificial parallels in household life (hospitality, community meals, thanksgiving gifts, charity, mutual aid, etc.).

- **Study plans & modules**  
  Pre-structured units that the **study planner** can import as modules, lessons, or yearly themes.

- **Calendar anchors (optional)**  
  Suggested links to feasts or special days when those offerings appear prominently in the text.

The goal is to give you a **structured scaffold** so SSA can connect:
> *“What was this offering?” → “What does it teach?” → “How do we walk this out now?”*

### 2.2 What the calculator does *not* do

- It does **not** re-establish animal sacrifices.
- It does **not** make halachic rulings or use Talmud/Mishnah/Jewish tradition.
- It stays within **Bible, Apocrypha, and Pseudepigrapha** per your project rules.

---

## 3. Inputs & outputs (high-level)

The shapes are enforced by:

- `BiblicalOfferingCalculator.schema.json` (local calculator schema)
- `schemas/planningGraph/calculator.schema.json` (shared calculator contract, once added)

### 3.1 Input shape (summary)

The `input` section of the schema allows:

- **Offering selection**
  - `offeringTypes`: array of canonical offering keys (e.g., `"burnt"`, `"peace"`, `"sin"`, `"guilt"`, `"grain"`, `"drink"`).
- **Scripture anchors**
  - `primaryRefs`: core reference strings (e.g., `"Leviticus 1"`, `"Numbers 28-29"`).
  - `includeApocrypha`: boolean to pull in additional texts if available.
- **Study intent**
  - `studyFocus`: e.g., `"forgiveness"`, `"gratitude"`, `"atonement vs. fellowship"`.
  - `householdAudience`: e.g., `"children"`, `"teens"`, `"adults"`.
- **Planner hints**
  - `desiredModuleCount`
  - `includeCalendarAnchors`

These inputs can come from:

- A **calculator form** (future UI),
- A **planning wizard**,
- A higher-level **calendar or feast planner** node.

### 3.2 Output shape (summary)

The `output` section of the schema defines:

- `offerings`  
  Detailed breakdown per selected offering type:
  - `key`
  - `label`
  - `primaryRefs` / `relatedRefs`
  - `summary`
  - `heartThemes` (e.g., repentance, gratitude, consecration)
  - `modernAnalogies` (structured suggestions)

- `studyModules`  
  Array of module descriptors the **study planner** can ingest:
  - `moduleKey`
  - `title`
  - `objectives`
  - `scriptureRefs`
  - `suggestedAssignments` (e.g., discussions, journaling, family activities)

- `calendarAnchors` (optional)  
  Hints for the calendar system:
  - `anchorType`: `"feast" | "weeklyStudy" | "seasonalFocus"`
  - `anchorKey`: e.g., `"passover"`, `"pentecost"`, `"tabernacles"`, `"weekly-sabbath-study"`
  - `notes` / `intent`

- `nextStepHints`  
  Light-weight hints pointing at:
  - `studyPlanner`
  - `calendarPlanner`
  - Potential **SessionRunner session templates** for devotional sessions.

---

## 4. How the pieces fit together

### 4.1 Planning Graph node

The node is registered via:

- `BiblicalOfferingCalculator.config.json`  
  with a **kind** of `"calculator-node"` and a **nodeKey** like `"calendar.biblicalOffering"`.

The Planning Graph engine can:

1. Discover this node as a **calculator**.
2. Validate inputs/outputs against `BiblicalOfferingCalculator.schema.json`.
3. Route results into downstream nodes defined in `BiblicalOfferingCalculator.mappings.json`.

### 4.2 Shim logic

`BiblicalOfferingCalculator.shim.js`:

- Implements `runBiblicalOfferingCalculator(input)` using:
  - Lightweight, pure JavaScript.
  - Optional SSA `eventBus` calls with standard payloads.
- Designed to be called by:
  - A **Planning Graph orchestrator**, or
  - A dedicated **calculator runtime**.

It **does not** know about React or UI; it only produces a valid output object.

### 4.3 Hooks & UI

- `BiblicalOfferingCalculator.hooks.js` exposes convenience hooks:
  - `useBiblicalOfferingCalculator(input)`
  - `useOfferingStudyFlows(result)`
  - `useOfferingCalendarFlows(result)`

These hooks:

- Call the shim,
- Interpret `nextStepHints` and `mappings`,
- Prepare **Next Steps** for:
  - Study planner,
  - Household calendar,
  - Possible devotional **sessions** run by SessionRunner.

- `BiblicalOfferingCalculator.view.jsx` renders:
  - A structured offering overview:
    - Offering cards grid,
    - Scripture lists,
    - Theme badges.
  - A **Next Steps** panel using `useOfferingStudyFlows` and `useOfferingCalendarFlows`.
  - Optional “Launch Study Session” buttons that:
    - Create a **Session object** with domain `"storehouse"` or `"preservation"` or separate `"study"` dimension (future),
    - Emit `session.started` via `eventBus`,
    - Open the **SessionRunner modal** at the app root.

### 4.4 Mappings & downstream flows

`BiblicalOfferingCalculator.mappings.json` defines how this node:

- Feeds **study planner modules**:  
  e.g., `calendar.biblicalOffering -> studyPlanner.modules`

- Suggests **calendar themes/special days**:  
  e.g., `calendar.biblicalOffering -> calendar.studyAnchors`

- Optionally links to **devotional sessions**:
  - E.g., “Now: 20-minute family walkthrough of Burnt vs. Peace offerings”.

The Planning Graph driver uses these mappings to populate:

- UI buttons,
- Route suggestions,
- Session templates.

---

## 5. SessionRunner integration (high-level)

While this calculator is more about **knowledge** than **hands-on chores**, it can still hook into **SessionRunner**:

Typical flows:

1. User explores offerings → selects **“Create Family Study Session”**.
2. Hooks translate selected modules and themes into a **Session object**:
   - `domain`: most likely `"storehouse"` or a future `"study"` domain.
   - `source.type`: `"import"` (from calculator/planner).
   - `steps`: timed readings, discussion prompts, journaling prompts.
3. Session is:
   - Persisted in Dexie;
   - Emitted via `eventBus`;
   - Opened in the **SessionRunner modal** with voice guidance, timers, etc.

Because the calculator and its shim keep a **strict separation** between logic and UI, you can easily iterate on the SessionRunner integration without breaking the core calculator.

---

## 6. Typical usage patterns

### 6.1 Study planning

1. Open the **Biblical Offering Calculator** view.
2. Select:
   - Offering type(s),
   - Scripture span,
   - Audience (children/teens/adults).
3. Run the calculator:
   - View offerings, key references, summaries.
4. Click **“Send to Study Planner”**:
   - Hooks push `output.studyModules` into the **study planner**.
   - Next Steps suggest:
     - “Open Study Planner Now”
     - “Schedule Weekly Sessions”

### 6.2 Calendar + feast linkage

1. Coming from a **Feast Day Alignment** flow, the Planning Graph calls this calculator with:
   - Feasts already mapped,
   - `includeCalendarAnchors: true`.
2. The calculator returns:
   - `calendarAnchors` describing how offerings map to feasts/seasons.
3. Hooks expose:
   - Buttons to:
     - “Add as Feast Study Track”
     - “Create Pre-Feast Devotional Sessions”
4. SessionRunner can run those devotional sessions on the days leading up to a feast.

---

## 7. Extending this calculator

### 7.1 Add more offering types

- Update:
  - Enum in `BiblicalOfferingCalculator.schema.json` for `offeringTypes`.
  - Lookup tables in `BiblicalOfferingCalculator.shim.js`.
  - Copy/adjust cards in the view for new types.

### 7.2 Add new downstream flows

- Edit `BiblicalOfferingCalculator.mappings.json` to:
  - Add new `flows` entries pointing to new nodeKeys (e.g., `curriculum.builder`, `familyFund.studyTracks`).
- Implement destination nodes or hooks as needed.

### 7.3 Add household practice prompts

To strengthen the “practice” side (without sacrificing animals):

- Add a `practicePrompts` field per offering in the shim output.
- Render them in the view as:
  - Journal prompts,
  - Family activity suggestions,
  - Mutual aid prompts.
- Use hooks to:
  - Turn those prompts into **tasks** or **sessions** (via SessionRunner).

---

## 8. Integration checklist

When wiring this feature into SSA and the Planning Graph:

1. **Node registration**
   - Ensure `BiblicalOfferingCalculator.config.json` is loaded by the Planning Graph registry.
   - `nodeKey` should be unique (e.g., `"calendar.biblicalOffering"`).

2. **Schema wiring**
   - Confirm `BiblicalOfferingCalculator.schema.json` conforms to the shared calculator schema.
   - If needed, adjust `$schema` references once `schemas/planningGraph/calculator.schema.json` is created.

3. **Mappings loading**
   - Ensure `BiblicalOfferingCalculator.mappings.json` is read by the Planning Graph mapping loader.

4. **Calculator runtime**
   - Wire `BiblicalOfferingCalculator.shim.js` into your calculator execution pipeline.

5. **UI route**
   - Add a route or panel that renders `BiblicalOfferingCalculator.view.jsx`.

6. **Hooks usage**
   - Import and use hooks from `BiblicalOfferingCalculator.hooks.js` where you:
     - Build study plans,
     - Attach content to the calendar,
     - Launch sessions.

---

## 9. Design principles

- **Scripture first**: everything driven by text and theme, not tradition add-ons.
- **Household-friendly**: outputs designed for mothers, fathers, and children to walk through together.
- **Planner-aware**: all outputs shaped to plug into:
  - Study planner,
  - Calendar planner,
  - SessionRunner.
- **Future-proof**: easy to extend with:
  - New offering types,
  - New resource types,
  - Richer hooks into other SSA domains (animals, preservation, storehouse).

---

If you add new related calculator nodes (e.g., **Peace Offering Deep Dive**, **Atonement & Forgiveness Explorer**), use this README as a template so the Planning Graph remains consistent and self-documenting.
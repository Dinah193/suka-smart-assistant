# Planning Graph – Version History & Changelog

This document tracks human-readable changes to the **Planning Graph** in Suka Smart Assistant (SSA).

The Planning Graph is the backbone that connects:
- Calculators and dashboards  
- Storehouse, garden, animals, and calendar planning  
- SessionRunner automation (cooking, cleaning, garden, animals, preservation, storehouse)

Each change entry should explain **what changed**, **why**, and **how it affects UI, scoring, or automation**.

---

## Conventions

- **Version Number** here refers to the *Planning Graph definition* (nodes, domains, mappings), not SSA app version.
- **Files covered by this changelog:**
  - `src/data/planning-graph/planningGraph.nodes.json`
  - `src/data/planning-graph/planningGraph.domains.json`
  - `src/data/planning-graph/planningGraph.mappings.json`
  - Any future `planningGraph.*` configs that define nodes, edges, or scoring.
- **Semantic-ish meaning (loose):**
  - `1.x` – Initial graph build-out and incremental refinements.
  - Major shifts in structure (e.g., new domain or scoring model) should bump the **first** digit.

When editing:
- Add a new section at the **top** for the latest version.
- Keep language plain and practical (“what this means for dashboards & automation”).

---

## v1.1 – Add Micronutrient Node + Full Mappings (2025-11-26)

**Summary**

- Clarified the nutrition stack by replacing/renaming the earlier “Daily Calcium Requirement” idea with a more holistic `node.health.dailyMicronutrientRequirement`.
- Completed the initial **mappings layer** that ties each node to:
  - Primary route
  - Dashboard route
  - Feature module
  - Planner/automation agent
  - Event names for score updates

### Changes

1. **Health domain updates**

   - Added / standardized nodes:
     - `node.health.dailyMicronutrientRequirement`  
       - Routes toward `/tier2/calculators/daily-micronutrients`.
       - Feeding into `mealPlanEngine` for more intelligent recipe selection and storehouse pulls.
   - Ensured the following health nodes are all mapped:
     - `node.health.bmi`
     - `node.health.dailyEnergyRequirement`
     - `node.health.dailyMicronutrientRequirement`
     - `node.health.hairNutritionScore`

   **Impact**

   - Meal planning AI (and eventually SessionRunner hints) can consider **micronutrient coverage** instead of just calories.
   - Future dashboards can show:
     - “Calories ✔ but micronutrients ✖” in a single glance.
   - Planning Graph score for the **health** domain becomes more robust and realistic.

2. **Storehouse domain mappings completed**

   - Nodes:
     - `node.storehouse.storehouseMealsCapacity`
     - `node.storehouse.meatBreakdownCalculator`
     - `node.storehouse.storehouseMonthsOfCover`
     - `node.storehouse.priceBookCoverage`
     - `node.storehouse.couponCycleAlignment`
     - `node.storehouse.bulkPurchasingReadiness`
   - Each node now has:
     - Primary calculator / page route
     - Dashboard widget component
     - Feature module path
     - `plannerAgent` + `planningGraph.nodeScore.updated.*` event name

   **Impact**

   - Storehouse planners and dashboards know **exactly** which component and calculator to open when a user clicks from a Planning Graph tile.
   - Automation can:
     - Trigger bulk-buy recommendations when `bulkPurchasingReadiness` is high and `couponCycleAlignment` is favorable.
     - Display “Months of Cover” warnings more intelligently.

3. **Garden domain mappings completed**

   - Nodes:
     - `node.garden.seedViabilityCalculator`
     - `node.garden.gardenPlanner`
     - `node.garden.harvestYieldProjection`
     - `node.garden.toStorehouseFlow`
     - `node.garden.preservationPlanner`
     - `node.garden.animalFeedSupport`
   - Tightened cross-domain mapping:
     - `toStorehouseFlow` links garden → storehouse intake routes.
     - `animalFeedSupport` links garden → animals feed planner.

   **Impact**

   - The Planning Graph can now quantify how well **garden output**:
     - Supports the storehouse (harvest intake).
     - Reduces feed costs for animals.
   - Future automation:
     - Suggests preservation sessions when projected yield is high and storage capacity is available.
     - Suggests garden expansion or crop type tweaks when animal feed support is weak.

4. **Calendar domain mappings completed**

   - Nodes:
     - `node.calendar.mealCalendarCoverage`
     - `node.calendar.batchSessionDensity`
     - `node.calendar.sabbathAndFeastAlignment`
     - `node.calendar.cleaningRhythmConsistency`
     - `node.calendar.gardenTaskRhythm`
     - `node.calendar.animalTaskRhythm`
   - All mapped to:
     - Calendar subpages (meals, batch sessions, feasts, cleaning rhythm, garden rhythm, animal rhythm).
     - Corresponding planner agents (`mealPlanEngine`, `sessionPlannerAgent`, `feastPlannerAgent`, `cleaningPlannerAgent`, `gardenPlannerAgent`, `animalPlannerAgent`).

   **Impact**

   - The Planning Graph now “sees” **rhythm and consistency**, not just static capacity:
     - How many days are planned vs. ignored.
     - Whether sabbaths and feasts are actually integrated into real routines.
   - SessionRunner integration:
     - Calendar nodes can influence which sessions appear as “Next best NOW session” on each domain page.

5. **Stability domain mappings completed**

   - Nodes:
     - `node.stability.incomeStabilityIndex`
     - `node.stability.utilityResilienceIndex`
     - `node.stability.storehouseStabilityIndex`
     - `node.stability.homesteadStressIndex`
     - `node.stability.dependencyOnExternalFood`
     - `node.stability.planningGraphCompositeScore`
   - All mapped to `/tier2/stability/*` routes and `stabilityPlannerAgent`.

   **Impact**

   - Stability domain can aggregate:
     - Income volatility,
     - Utility fragility,
     - Storehouse depth,
     - External food dependency,
     - Overall composite score.
   - Composite score node is now the “front door” for:
     - Household Stability dashboard,
     - Upcoming analytics and storytelling (e.g., “Your stability improved 12% over the last quarter”).

---

## v1.0 – Initial Domains & Node Grouping (2025-11-26)

**Summary**

- First formal definition of **Planning Graph domains**.
- Grouped core nodes into 5 logical domains for UI and scoring:
  - `health`
  - `storehouse`
  - `garden`
  - `calendar`
  - `stability`

### Changes

1. **Created domain definition schema**

   - File: `src/schemas/planningGraph/domains.schema.json`
   - Purpose:
     - Strong typing and VS Code validation for domain configs.
     - Enforce required fields: `id`, `label`, `shortLabel`, `description`, `weight`, `ui`, `nodes`.
     - Allow `$schema` reference in config for better tooling.

   **Impact**

   - All domain configs will be consistent and machine-readable.
   - Safer refactors as the Planning Graph grows.

2. **Added domain configuration file**

   - File: `src/data/planning-graph/planningGraph.domains.json`
   - Domains:

     - **Health (`health`)**
       - Nodes: `node.health.bmi`, `node.health.dailyEnergyRequirement`, `node.health.dailyMicronutrientRequirement`, `node.health.hairNutritionScore`
       - Weight: `0.25`
       - UI hints: purple accent, heart icon.

     - **Storehouse (`storehouse`)**
       - Nodes: `node.storehouse.storehouseMealsCapacity`, `node.storehouse.meatBreakdownCalculator`, `node.storehouse.storehouseMonthsOfCover`, `node.storehouse.priceBookCoverage`, `node.storehouse.couponCycleAlignment`, `node.storehouse.bulkPurchasingReadiness`
       - Weight: `0.30`
       - UI hints: warm orange accent, warehouse icon.

     - **Garden (`garden`)**
       - Nodes: `node.garden.seedViabilityCalculator`, `node.garden.gardenPlanner`, `node.garden.harvestYieldProjection`, `node.garden.toStorehouseFlow`, `node.garden.preservationPlanner`, `node.garden.animalFeedSupport`
       - Weight: `0.20`
       - UI hints: green accent, leaf icon.

     - **Calendar (`calendar`)**
       - Nodes: `node.calendar.mealCalendarCoverage`, `node.calendar.batchSessionDensity`, `node.calendar.sabbathAndFeastAlignment`, `node.calendar.cleaningRhythmConsistency`, `node.calendar.gardenTaskRhythm`, `node.calendar.animalTaskRhythm`
       - Weight: `0.15`
       - UI hints: blue accent, calendar-clock icon.

     - **Stability (`stability`)**
       - Nodes: `node.stability.incomeStabilityIndex`, `node.stability.utilityResilienceIndex`, `node.stability.storehouseStabilityIndex`, `node.stability.homesteadStressIndex`, `node.stability.dependencyOnExternalFood`, `node.stability.planningGraphCompositeScore`
       - Weight: `0.10`
       - UI hints: slate accent, shield-home icon.

   **Impact**

   - Dashboards can now:
     - Show domain-level scores and colors.
     - Group cards and widgets logically (“Health”, “Storehouse”, etc.).
   - Scoring engine can:
     - Apply different weights per domain when computing an overall **Planning Graph Composite Score**.

3. **Clarified intent for mappings layer**

   - Defined a separate configuration file:
     - `src/data/planning-graph/planningGraph.mappings.json`
   - Purpose:
     - Connect node IDs → routes → components → automation.
   - v1.0 only established the **pattern**, v1.1 filled in the concrete entries.

   **Impact**

   - Separation of concerns:
     - Domains file = “What category is this node in?”
     - Mappings file = “Where does the user go when they click this node, and what agent uses it?”

---

## Future Notes / TODOs

These are not versioned changes yet, but intended directions for future updates:

- **Sessions Integration**
  - Link Planning Graph nodes directly to **SessionRunner** presets.
  - Example:
    - Low `node.storehouse.storehouseMealsCapacity` + upcoming busy week → auto-suggest batch cooking sessions.

- **Per-Household Weights**
  - Allow households to override domain weights (e.g., a medically fragile family may set `health` weight higher).

- **Time-windowed scoring**
  - Add support for “last 30 days”, “last 90 days” trend lines per node.
  - Use these for stability narratives and notifications.

When any of the above are actually implemented, add a **new version section** above this line with the date and specifics.

---
# SSA Page-by-Page Implementation Tracker

Linked baseline:
- `docs/design/doet-page-matrix.md`
- `docs/design/ssa-ui-spec-pack.md`

Tracking goal:
- Move from DOET guidance coverage into tokenized, component-consistent implementation across high-value routes.

Status key:
- `Not Started`
- `In Progress`
- `Ready for QA`
- `Complete`

## Phase 1: Planner Core (priority)

| Route | Page File | DOET Matrix Status | SSA UI Scope | Owner | Status | Notes |
|---|---|---|---|---|---|---|
| `/meal-planning?tool=dashboard` | `src/pages/mealplanner/mealplanner.jsx` | Implemented | Apply mission-control layout, tokenized cards/actions, collaboration strip | TBD | Ready for QA | Slices landed for header/actions and template-duration-budget-prompt controls; Slice A/B social persistence + handoff coverage landed (`_tests_/mealPlanner.contextFeedActions.contract.test.js`, `_tests_/mealPlanner.feedInteractions.ui.contract.test.jsx`, `_tests_/mealPlanner.crossModuleHandoff.contract.test.js`) with startup hardening in `2d9974e` |
| `/meal-planning/planner-dashboard` | `src/pages/mealplanner/PlannerScaffoldPage.jsx` | Implemented | Standardize planner dashboard cards and KPI hierarchy | TBD | Not Started | Must align with `PlannerDashboardCard` |
| `/storehouse` | `src/pages/storehouse/storehouse.jsx` | Implemented | Tri-pane responsive structure and status token integration | TBD | Not Started | Tie low-stock and agreement strip into shared status model |
| `/storehouse/planner` | `src/pages/storehouse/planner/StorehousePlanner.jsx` | Implemented | Inventory table + queue surfaces aligned to tokens/states | TBD | Not Started | Validate keyboard and focus behavior in table flows |
| `/homesteadplanner` | `src/pages/homesteadplanner/homestead.jsx` | Implemented | Homestead dashboard shell, progressive disclosure, KPI state mapping | TBD | Not Started | Align subnav and section cards |
| `/homesteadplanner/planner` | `src/pages/homestead/planner/HomesteadPlanner.jsx` | Implemented | Planner workflow cohesion across production/storehouse/meal coupling | TBD | Not Started | Ensure route parity with homesteadplanner module surfaces |

## Phase 2: Daily Flow and Collaboration Surfaces

| Route | Page File | DOET Matrix Status | SSA UI Scope | Owner | Status | Notes |
|---|---|---|---|---|---|---|
| `/` | `src/pages/home.jsx` | Covered by shared primitives | Add DOET frame entry and mission-control summary band | TBD | Not Started | Recommended in matrix follow-up |
| `/community` | `src/pages/community.jsx` | Covered by shared primitives | Introduce operational social feed behavior and collaboration chips | TBD | Not Started | Must share behavior with planner collaboration strips |
| `/inventory` | `src/pages/inventory.jsx` | Covered by shared primitives | Token alignment for list/detail interactions and alert states | TBD | Not Started | Validate consistency with storehouse patterns |
| `/tasks/**` | `src/pages/tasks/routes.jsx` | Covered by shared primitives | Task-row state mapping (blocked/in-progress/done) and assignment chips | TBD | Not Started | Should reuse collaboration token family |

## Phase 3: Settings, Knowledge, Utility Stabilization

| Route Group | Primary Entry File | DOET Matrix Status | SSA UI Scope | Owner | Status | Notes |
|---|---|---|---|---|---|---|
| `/settings/**` | `src/pages/settings/index.jsx` | Covered by shared primitives | Apply shared form-control states and section rhythm | TBD | Not Started | Focus on consistency, not layout reinvention |
| `/knowledge/**` | `src/pages/knowledge/docs.jsx` | Covered by shared primitives | Typography and content card hierarchy normalization | TBD | Not Started | Preserve readability first |
| `/tools/**` | `src/pages/tools/multi-timer.jsx` | Covered by shared primitives | Utility component parity with tokenized controls | TBD | Not Started | Prioritize high-traffic tool routes |
| `/scan/**` | `src/pages/scan/index.jsx` | Covered by shared primitives | Alert and status semantics consistency | TBD | Not Started | Ensure non-color-only status communication |

## Implementation Gates (must pass before Complete)

1. Token gate
- Page consumes shared tokens from `src/styles/ssa-token-seed.css` (or imported derivative).

2. State gate
- Critical interactive components on the page support default, hover, focus-visible, disabled, loading.

3. Collaboration gate
- Planner and community pages expose request/assigned/completed/blocked state markers.

4. Accessibility gate
- Keyboard navigation, focus order, and contrast checks pass for newly updated surfaces.

5. Regression gate
- Existing route-level contract/runtime tests remain passing after UI updates.

## Recent Verification Updates

- 2026-04-04: Meal planner control regression test added at `_tests_/mealPlanner.controls.contract.test.jsx`.
- Coverage confirms interactive behavior for `Template`, `Duration`, `Budget (USD)`, and `Prompt` controls on `/meal-planning?tool=dashboard`.
- Validation run: `npm run test:ci -- _tests_/mealPlanner.controls.contract.test.jsx --reporter=dot` (pass).
- 2026-04-04: Social feed phase verification complete for meal planner with final quality lanes green (`lint:ci`, `typecheck:ci`, `test:ssa:rollout:gate`, `smoke:consolidated`, `smoke:consolidated:check`, `smoke:e2e`) and targeted Slice A/B planner pack pass (3 files, 6 tests).

## Suggested Execution Order

1. `src/components/ui/*` and shared state primitives
2. Planner routes in Phase 1
3. Home and community routes in Phase 2
4. Remaining route groups in Phase 3

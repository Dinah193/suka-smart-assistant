# Meal Planner Performance Follow-Up Evidence (2026-04-09)

## Scope
- Page: `/meal-planning`
- Objective: confirm ship/no-ship after first-paint shell + live-context deferral stabilization.
- Code state retained for validation:
  - live-context deferral enabled
  - coordination panel deferred mount enabled
  - assignments strip eager render retained

## Audit Protocol
- Build mode: `vite build` + `vite preview`
- Backend flags: `NEO4J_REQUIRED=false`, `PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED=true`
- Lighthouse mode: desktop preset
- Sampling: two clean 5-pass sets (10 valid passes total)
- Reliability controls:
  - isolated Chrome `--user-data-dir` per pass
  - rerun strategy used previously to neutralize Windows EPERM temp cleanup flake

## Evidence Artifacts
- Set 1 summary: `docs/qa/section4-lighthouse-mealplanner-2026-04-08-clean5pass-preview-summary.json`
- Set 2 pass files:
  - `docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-pass1.json`
  - `docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-pass2.json`
  - `docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-pass3.json`
  - `docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-pass4.json`
  - `docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-pass5.json`
- Combined analysis summary: `docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-and-combined10-summary.json`
- Baseline comparator: `docs/qa/section4-lighthouse-mealplanner-2026-04-07-outbox-disabled-summary.json`

## Results

### Set 2 Median (5/5 valid)
- Performance: 97
- FCP: 745 ms
- LCP: 1160 ms
- TBT: 38 ms
- Speed Index: 756 ms
- TTI: 1160 ms
- CLS: 0

### Combined 10-Pass Median (Set 1 + Set 2)
- Performance: 95
- FCP: 2554 ms
- LCP: 3616 ms
- TBT: 47 ms
- Speed Index: 2692 ms
- TTI: 3616 ms
- CLS: 0

### Delta vs Outbox-Disabled Baseline
- Performance: +13
- FCP: -331 ms
- LCP: -117 ms
- TBT: +25 ms
- Speed Index: -193 ms
- TTI: -118 ms
- CLS: 0

## Regression Safety Checks
- `npx vitest run _tests_/mealPlanningContext.battleRhythm.catalog.contract.test.js` -> PASS (1/1)
- `npx vitest run _tests_/mealPlanner.controls.contract.test.jsx --reporter=verbose` -> PASS (1/1)
- `npx vitest run _tests_/mealPlanner.feedInteractions.ui.contract.test.jsx --reporter=verbose` -> PASS (3/3)

## Decision
- Ship decision: `GO`
- Rationale: median-of-two-sets materially exceeds prior baseline on key startup metrics and removes prior single-run volatility concern.
- Follow-up: continue monitoring real-user web vitals after deploy; no rollback action required for current meal planner deferral state.

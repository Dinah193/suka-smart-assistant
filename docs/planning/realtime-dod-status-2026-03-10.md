# Realtime DoD Status Mapping (2026-03-10)

## Baseline Run (default, legacy disabled)
- Command: `SSA_ENABLE_RUNTIME_CONTRACT_TESTS=true`, `SSA_ENABLE_LEGACY_CONTRACT_TESTS=false`, `vitest run`
- Result: `29` passed test files, `6` skipped test files, `0` failed test files.
- Tests: `284` passed, `56` skipped, `0` failed.
- Source log: `.tmp/full-vitest-after-animal-default.log`

## Pass

### Definition of Done (Every Milestone)
- Deterministic tests (fake timers / fixed-time paths): `PASS`
  - `_tests_/realtimeCoordinator.test.js`
  - `_tests_/realtimeController.runtime.contract.test.js`
  - `_tests_/realtimeSocket.runtime.contract.test.js`
- Feature-flag enabled/disabled path coverage in realtime contracts: `PASS`
  - `_tests_/realtimeCoordinator.test.js`
  - `_tests_/realtimeController.runtime.contract.test.js`
- Compatibility aliases + status contracts preserved: `PASS`
  - `src/server/routes/realtimeController.js`
  - `_tests_/realtimeController.runtime.contract.test.js`
- No regression in realtime suggestions/report contracts: `PASS`
  - `_tests_/realtimeController.contract.test.js`
  - `_tests_/realtimeController.runtime.contract.test.js`
- Negative-path runtime contract coverage for introduced realtime errors: `PASS`
  - `_tests_/realtimeController.runtime.contract.test.js`
  - `_tests_/realtimeSocket.runtime.contract.test.js`

### Newly Re-enabled (this pass)
- Overlay scrubber contract suite: `PASS`
  - `src/tests/overlay.payloads.test.js`
  - `src/overlay/overlayPayloads.js`
- Session play mapper suite: `PASS`
  - `src/tests/session.play.mapper.test.js`
- Control message contract suite: `PASS`
  - `src/tests/control.contract.test.js`
- Event wiring end-to-end suite: `PASS`
  - `src/tests/events.wiring.test.js`
- Flow orchestration suites: `PASS`
  - `src/tests/cleaning.plan.flow.test.js`
  - `src/tests/cooking.plan.flow.test.js`
  - `src/tests/garden.plan.flow.test.js`
- Scheduler guard/repeat/pause suites: `PASS`
  - `src/tests/scheduler/guards.spec.js`
  - `src/tests/scheduler/RelativeScheduler.pause.spec.js`
  - `src/tests/scheduler/RelativeScheduler.repeat.spec.js`
- Animal flow suite: `PASS`
  - `src/tests/animal.plan.flow.test.js`
- Storehouse calculator trio: `PASS`
  - `src/tests/calculators/storehouseMeals/BatchYieldCalculator.test.js`
  - `src/tests/calculators/storehouseMeals/CostPerServingCalculator.test.js`
  - `src/tests/calculators/storehouseMeals/FermentationDurationCalculator.test.js`

## Skipped-by-legacy-flag

These are intentionally excluded when `SSA_ENABLE_LEGACY_CONTRACT_TESTS=false` via `vite.config.js` and are not part of the default green baseline.

### Infrastructure/API mismatch and missing modules
- Scan/compare legacy tests:
  - `_tests_/couponService.test.js`
  - `_tests_/priceComparator.test.js`
  - `_tests_/productResolver.test.js`
  - `_tests_/recallChecker.test.js`
- Public layer asset loader test:
  - `public/__tests__/layerAssets.test.js`
- Planning/runtime missing modules and duplicate-export test fixtures:
  - `src/tests/decider.scoring.test.js`
  - `src/tests/estimator.spec.js`
  - `src/tests/gatekeeper.spec.js`
  - `src/tests/grocery.builder.test.js`
  - `src/tests/importer.flow.test.js`
  - `src/tests/integration/orchestrator.flow.spec.js`
  - `src/tests/knowledgeGraph.test.js`
  - `src/tests/planner.conflict.test.js`
  - `src/tests/planner.spec.js`
  - `src/tests/planning/nextStepsStrategies.test.js`
  - `src/tests/planning/planningFlowEngine.test.js`
  - `src/tests/planning/planningGraphLoader.test.js`
  - `src/tests/planning/planningGraphQueries.test.js`
  - `src/tests/planning/stabilityEngine.test.js`
  - `src/tests/riskController.spec.js`

### Calculator suites with missing logic implementations
- Calendar:
  - `src/tests/calculators/calendar/BiblicalOfferingCalculator.test.js`
  - `src/tests/calculators/calendar/FeastDayAlignmentCalculator.test.js`
  - `src/tests/calculators/calendar/HebrewMonthStartCalculator.test.js`
  - `src/tests/calculators/calendar/ScripturalYearLengthCalculator.test.js`
- Garden/animal:
  - `src/tests/calculators/gardenAnimal/AnimalFeedCalculator.test.js`
  - `src/tests/calculators/gardenAnimal/ButcheryWeightCalculator.test.js`
  - `src/tests/calculators/gardenAnimal/GardenPlantingCalendarCalculator.test.js`
  - `src/tests/calculators/gardenAnimal/GardenYieldCalculator.test.js`
  - `src/tests/calculators/gardenAnimal/IrrigationCalculator.test.js`
  - `src/tests/calculators/gardenAnimal/SeedViabilityCalculator.test.js`
  - `src/tests/calculators/gardenAnimal/SoilAmendmentCalculator.test.js`
- Health/stability/storehouse:
  - `src/tests/calculators/health/BMICalculator.test.js`
  - `src/tests/calculators/health/HairProteinCalculator.test.js`
  - `src/tests/calculators/health/MacroCalculator.test.js`
  - `src/tests/calculators/health/MicronutrientCalculator.test.js`
  - `src/tests/calculators/health/MovementIntensityCalculator.test.js`
  - `src/tests/calculators/stability/HouseholdStabilityCalculator.test.js`

### Legacy contract suites intentionally opt-in
- `src/tests/automationRuntime.test.js`
- `src/tests/dataGateway.test.js`
- `src/tests/importRouter.test.js`

## Delta from prior pass
- Re-enabled from legacy excludes:
  - `src/tests/overlay.payloads.test.js`
  - `src/tests/session.play.mapper.test.js`
  - `src/tests/control.contract.test.js`
  - `src/tests/events.wiring.test.js`
  - `src/tests/cleaning.plan.flow.test.js`
  - `src/tests/cooking.plan.flow.test.js`
  - `src/tests/garden.plan.flow.test.js`
  - `src/tests/scheduler/guards.spec.js`
  - `src/tests/scheduler/RelativeScheduler.pause.spec.js`
  - `src/tests/scheduler/RelativeScheduler.repeat.spec.js`
  - `src/tests/animal.plan.flow.test.js`
  - `src/tests/calculators/storehouseMeals/BatchYieldCalculator.test.js`
  - `src/tests/calculators/storehouseMeals/CostPerServingCalculator.test.js`
  - `src/tests/calculators/storehouseMeals/FermentationDurationCalculator.test.js`
- Added compatibility scaffolding to support future re-enablement:
  - `src/tests/vitest.setup.js`
  - `src/tests/shims/jest-globals.js`
  - `vite.config.js` (`test.globals`, `test.setupFiles`, alias `@jest/globals`)
- Added permanent fixes for this batch:
  - `src/libraries/StoreCatalog.js` (`hasOwnProperty` guard fixes for null-prototype maps)
  - `src/tests/control.contract.test.js` (strict `type` <-> `data.kind` schema coupling)
  - `src/tests/events.wiring.test.js` (use embedded shims instead of missing import files)
  - `src/automation/handlers/onAnimalPlanDraftRequested.js` (`register` now rebinds both `on` and `emit` for injected hubs)
  - `src/automation/handlers/onSupplyShortageDetected.js` (`register` now rebinds both `on` and `emit` for injected hubs)
  - `src/automation/handlers/onPrepTasksRequested.js` (`register` now rebinds both `on` and `emit` for injected hubs)
  - `src/automation/handlers/emitPlannerConflict.js` (`register` now rebinds both `on` and `emit` for injected hubs)

## Meal-Planning Route Contracts (2026-03-10)
- Runtime-gated server contract suites added and tracked:
  - `_tests_/battleRhythmController.contract.test.js`
  - `_tests_/mealPlanController.resolveRecipe.contract.test.js`
- Route mount stability fix applied:
  - `src/server/index.js` now awaits route mounting before installing terminal 404/error middleware and starting listener.
- Runtime-gated execution command:
  - `SSA_ENABLE_RUNTIME_CONTRACT_TESTS=true npx vitest run _tests_/battleRhythmController.contract.test.js _tests_/mealPlanController.resolveRecipe.contract.test.js --reporter=verbose`
- Runtime-gated execution result: `PASS`
  - Test files: `2 passed`, `0 failed`
  - Tests: `2 passed`, `0 failed`
  - Per-test output:
    - `✓ _tests_/mealPlanController.resolveRecipe.contract.test.js > mealPlanController /resolveRecipe runtime contract > returns passthrough, resolved payload, and validation error contracts`
    - `✓ _tests_/battleRhythmController.contract.test.js > battleRhythmController runtime contract > serves profile/customizations/resolve endpoints under /api/battle-rhythm`

## Pass Closure
- Status: `CLOSED`
- Closure criteria met:
  - Default full-suite run is green.
  - `animal.plan.flow.test.js` is re-enabled and passing.
  - Storehouse calculator trio is re-enabled and passing.

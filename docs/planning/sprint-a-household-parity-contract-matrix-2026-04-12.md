# Sprint A Household Parity Contract Matrix - 2026-04-12

Status: Closure Gate Complete (Local: isolated + grouped)
Matrix ID: SPRINT-A-HOUSEHOLD-PARITY-2026-04-12

## Objective
Standardize recurrence, dependency, and Today/Upcoming behavior across all household planning modules.

## Contract Dimensions
1. Create/Assign/Update/Complete lifecycle parity
2. Recurrence parity (daily/weekly/custom cadence)
3. Dependency parity (blocked-by / unblocked transitions)
4. Conflict detection parity (time/resource overlaps)
5. Today/Upcoming inclusion and ordering parity

## Module Matrix

| Module | Lifecycle Parity | Recurrence Parity | Dependency Parity | Conflict Parity | Today/Upcoming Parity | Contract Test Status |
|---|---|---|---|---|---|---|
| Meal Planner | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) |
| Cleaning | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) |
| Storehouse | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) |
| Homestead | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) | Closure Gate Complete (isolated) |

## Acceptance Criteria
1. Every module passes identical lifecycle contract expectations.
2. Recurrence behavior is deterministic and equivalent across modules.
3. Dependency state transitions are equivalent across modules.
4. Conflict detection rules are equivalent and test-covered.
5. Today/Upcoming outputs are equivalent for same fixture inputs.

## First Implementation Slices
1. Define shared fixture schema for recurrence/dependency scenarios. `Done` (shared fixture module: `_tests_/fixtures/householdParityFixtures.js`).
2. Add module-by-module contract tests using shared fixtures. `Done` (cross-module parity contracts and closure slices present in `_tests_/plannerUnifiedFeed.contract.test.js`).
3. Add parity comparator tests for Today/Upcoming outputs. `Done` (module-filter permutation comparator contract added in `_tests_/plannerUnifiedFeed.contract.test.js`).
4. Wire failing cases to module services until matrix reaches complete. `Done` (no parity drift observed in local closure-gate runs).

## Execution Update - 2026-04-12
- Added shared household parity fixture builder for meal, cleaning, storehouse, and homestead recurrence/dependency scenarios.
- Added unified feed contract coverage to assert dependency-block behavior parity and recurrence spawn behavior across all household modules.
- Added dedicated Today/Upcoming parity comparator assertions per module-specific filter permutations (module, person, priority, status, dueAt sort parity) across meal, cleaning, storehouse, and homestead.
- Added explicit recurrence-cadence parity contracts for `weekly` and `custom` (`intervalDays=3`) spawn behavior across meal, cleaning, storehouse, and homestead modules.
- Added dependency edge-state parity contract for `blocked -> active` transitions to ensure equivalent unblocked behavior across meal, cleaning, storehouse, and homestead modules.
- Added dependency-unblock parity contract validating state-machine equivalence (`blocked -> completed` returns `invalid_task_transition`, then `active -> completed` returns `task_dependency_incomplete` until dependency completion) across meal, cleaning, storehouse, and homestead modules.
- Added conflict-detection parity contract validating owner/time-overlap equivalence (conflict linkage and `hasConflict` agenda flag behavior) across meal, cleaning, storehouse, and homestead modules.
- Verified parity closure gate in isolated runs for five focused contracts: blocked->active transition parity, dependency-unblock parity, weekly recurrence parity, custom recurrence parity, and owner-overlap conflict detection parity (all passing).
- Added lifecycle-closure parity contract validating equivalent state progression (`create -> blocked -> active -> completed -> archived`) including allowed-next-state shape and completion/archive timestamps across meal, cleaning, storehouse, and homestead modules (isolated run passing).
- Verified grouped parity closure gate run via `cmd /c npx vitest run _tests_/plannerUnifiedFeed.contract.test.js -t "keeps .* parity"` with passing grouped evidence for targeted recurrence/dependency/conflict/today-upcoming parity dimensions.

## Exit Gate
Local matrix closure gate is complete; CI suite green remains the final merge gate.
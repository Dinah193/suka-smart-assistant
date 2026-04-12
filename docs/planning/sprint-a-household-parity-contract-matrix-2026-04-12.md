# Sprint A Household Parity Contract Matrix - 2026-04-12

Status: In Progress
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
| Meal Planner | Baseline present | Partial | Partial | Partial | Partial | In progress |
| Cleaning | Baseline present | Partial | Partial | Partial | Partial | In progress |
| Storehouse | Baseline present | Partial | Partial | Partial | Partial | In progress |
| Homestead | Baseline present | Partial | Partial | Partial | Partial | In progress |

## Acceptance Criteria
1. Every module passes identical lifecycle contract expectations.
2. Recurrence behavior is deterministic and equivalent across modules.
3. Dependency state transitions are equivalent across modules.
4. Conflict detection rules are equivalent and test-covered.
5. Today/Upcoming outputs are equivalent for same fixture inputs.

## First Implementation Slices
1. Define shared fixture schema for recurrence/dependency scenarios.
2. Add module-by-module contract tests using shared fixtures.
3. Add parity comparator tests for Today/Upcoming outputs.
4. Wire failing cases to module services until matrix reaches complete.

## Exit Gate
Matrix rows all show Complete and contract suite is green in CI.
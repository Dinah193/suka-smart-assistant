# MongoDB Phase 2 Integration Checklist

This checklist is the concrete Phase 2 gate plan for production-hardening MongoDB integration in SSA.

## Scope
- Applies after Phase 1 completion (adapter + focused contract + CI lane).
- Goal: move from "working integration" to "operationally safe integration".

## Preflight Requirements
- `DATABASE_URL` set and reachable.
- `MONGODB_URI` (or `MONGO_URI`/`MONGO_URL`) set and reachable.
- Branch up to date with required CI workflow checks.

## Gate 1: DB Baseline and Connectivity
- Objective: verify Postgres + Mongo baseline is healthy before feature validation.
- Command:
```powershell
npm run db:preflight
```
- Pass criteria:
  - Command exits `0`.
  - Output JSON has `"ok": true`.
  - `checks.mongo.connected` is `true`.
  - `checks.postgresMigrate.ok` and `checks.postgresBootstrap.ok` are both `true`.
- Fail criteria:
  - Non-zero exit code OR any required field above is false/missing.

## Gate 2: Schema + Query Policy Verification
- Objective: ensure DB migrations and explain-policy checks remain valid.
- Command:
```powershell
npm run db:verify
```
- Pass criteria:
  - Command exits `0`.
  - Output JSON has `"ok": true`.
  - No policy violations in `policy.items`.
- Fail criteria:
  - Non-zero exit code OR policy violations reported.

## Gate 3: Nutrition Adapter Contract (Focused)
- Objective: validate Mongo adapter behavior (negative + round-trip path).
- Command:
```powershell
$env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'; npx vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose
```
- Pass criteria:
  - Command exits `0`.
  - 2 tests pass:
    - `returns normalizedName_required for empty upsert payload`
    - `passes adapter round-trip contract against configured Mongo`
- Fail criteria:
  - Non-zero exit code OR either assertion fails/skips unexpectedly.

## Gate 4: Runtime DB Contract Lane Parity
- Objective: mirror required CI DB lane locally before merge/release.
- Command:
```powershell
$env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'; $env:PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED='true'; npm run db:preflight; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npx vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose
```
- Pass criteria:
  - Combined command exits `0`.
  - Preflight successful and focused runtime contract passes.
- Fail criteria:
  - Any step returns non-zero.

## Gate 5: Service Health and Startup Contract
- Objective: verify startup path and service health contract under DB mode.
- Command:
```powershell
npm run smoke:e2e
```
- Pass criteria:
  - Command exits `0`.
  - Startup/runtime smoke contract tests pass.
- Fail criteria:
  - Non-zero exit code or startup DB-mode contract failure.

## Gate 6: CI Governance Enforcement
- Objective: ensure branch protections and required checks enforce DB runtime quality.
- Commands:
```powershell
npm run lint:ci
npm run typecheck:ci
```
- Manual verification:
  - Confirm required GitHub check list includes `db-runtime-contracts`.
- Pass criteria:
  - Both commands exit `0`.
  - Branch protection requires `db-runtime-contracts`.
- Fail criteria:
  - Any command fails or required check not enforced.

## Gate 7: Data Lifecycle and Retention Controls (Operational)
- Objective: prevent unbounded Mongo growth and enforce lifecycle policy.
- Required action:
  - Define retention policy for raw collections (`nutrition_data`, `raw_recipes`, and snapshots).
  - Implement TTL indexes or archival job strategy.
- Verification command (after TTL/index implementation):
```powershell
# Example placeholder: replace with your TTL/index verification script when added
npm run test:ci
```
- Pass criteria:
  - Lifecycle policy documented and implemented.
  - Verification evidence attached to PR/release notes.
- Fail criteria:
  - No retention mechanism or no verifiable evidence.

## Gate 8: Rollback Readiness
- Objective: make Mongo integration reversable without production outage.
- Required action:
  - Document and test fallback behavior when Mongo is unavailable.
  - Confirm service behavior matches contract:
    - read miss: `{ ok: true, data: null }`
    - write fail: `{ ok: false, error: "mongo_unavailable" }`
- Verification command:
```powershell
$env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'; npx vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose
```
- Pass criteria:
  - Fallback contract validated in test + documented in planning docs.
- Fail criteria:
  - Undocumented or untested fallback behavior.

## PR Evidence Checklist (copy/paste)
- [ ] Gate 1 `db:preflight` passed (attach output snippet).
- [ ] Gate 2 `db:verify` passed.
- [ ] Gate 3 focused nutrition contract passed (2 tests).
- [ ] Gate 4 local CI parity command passed.
- [ ] Gate 5 smoke DB startup tests passed.
- [ ] Gate 6 governance checks passed and `db-runtime-contracts` is required.
- [ ] Gate 7 lifecycle/retention policy implemented and evidenced.
- [ ] Gate 8 rollback/fallback contract validated.

## Release Go/No-Go Rule
- `GO` only if all gates above pass.
- Any single gate failure is `NO-GO` until remediated and re-validated.

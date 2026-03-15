# MongoDB Phase 3 Checklist (Production Rollout and Scale Validation)

This checklist defines Phase 3 gates for production rollout, enforceability, resilience, and operational scale.

## Scope
- Applies after Phase 2 gates are complete.
- Goal: make Mongo-backed behavior production-safe, observable, and release-enforced.

## Preconditions
- Phase 2 evidence completed and attached in PR/release notes.
- `db-runtime-contracts` CI lane exists and is green.
- Staging environment mirrors production DB topology (Postgres + Mongo + service runtime).

## Gate 1: Governance Enforcement (Real, Not Scaffold)
- Objective: convert CI governance checks from scaffold mode to blocking quality gates.
- Required action:
  - Install/configure ESLint and TypeScript project config (`tsconfig.json`) so `lint:ci` and `typecheck:ci` perform real checks.
- Commands:
```powershell
npm run lint:ci
npm run typecheck:ci
```
- Pass criteria:
  - Both commands exit `0`.
  - Output does not report scaffold-skip messages.
  - Branch protection includes required check `db-runtime-contracts` in GitHub settings.
- Fail criteria:
  - Any command fails or reports skip scaffold mode.
  - Required status check not enforced in repository branch protection.

## Gate 2: Full CI Equivalence Dry Run
- Objective: verify local execution path matches merge-time CI behavior.
- Command:
```powershell
npm run db:preflight; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run db:verify; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'; npx vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; npm run smoke:e2e
```
- Pass criteria:
  - Combined command exits `0`.
  - Every sub-step exits `0` with no failed tests.
- Fail criteria:
  - Any sub-step fails or exits non-zero.

## Gate 3: Staging Fault Injection (Mongo Unavailable)
- Objective: validate rollback readiness under realistic staging runtime conditions.
- Runbook: `docs/planning/mongo-phase3-gate3-staging-runbook.md`
- Evidence: `docs/qa/gate3-mongo-unavailable-20260314-183847/evidence.md`
- Status: Complete (2026-03-14)
- Required action:
  - Execute a controlled test window where Mongo URI is intentionally unreachable.
  - Capture service behavior and error/fallback metrics.
- Verification command (contract-level baseline):
```powershell
$env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'; npx vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose
```
- Pass criteria:
  - Fallback contract remains stable:
    - reads: `{ ok: true, data: null }`
    - writes: `{ ok: false, error: "mongo_unavailable" }`
  - No service crash during injected failure window.
- Fail criteria:
  - Any contract regression or service instability observed under injection.

## Gate 4: Staging Fault Injection (Mongo Degraded Latency)
- Objective: ensure service remains healthy when Mongo is slow but not fully down.
- Runbook: `docs/planning/mongo-phase3-gate4-staging-runbook.md`
- Evidence: `docs/qa/gate4-mongo-degraded-latency-20260314-184117/evidence.md`
- Status: Fail (2026-03-14; injection method unsupported in current environment)
- Required action:
  - Run controlled latency injection (network shaping/proxy delay) in staging.
- Suggested command baseline:
```powershell
npm run smoke:e2e
```
- Pass criteria:
  - Smoke contracts pass during degraded-latency window.
  - No startup/readiness contract regressions.
  - Incident alert thresholds not exceeded for sustained periods.
- Fail criteria:
  - Startup/readiness regressions, repeated timeouts, or alert saturation.

## Gate 5: Retention Behavior Validation at Scale
- Objective: prove TTL/retention controls work with realistic data volume.
- Evidence: `docs/qa/gate5-retention-20260314-185715/evidence.md`
- Status: Complete (2026-03-14)
- Commands:
```powershell
npm run verify:mongo:retention
```
- Required action:
  - Validate that TTL indexes are present in staging/prod-like environment.
  - Verify aged documents are being cleaned according to retention policy.
- Pass criteria:
  - Verification command exits `0` and reports `"ok": true`.
  - Sampling evidence confirms expected document expiry behavior.
- Fail criteria:
  - Missing TTL indexes, command failure, or retention drift.

## Gate 6: Observability and Alerting Readiness
- Objective: ensure Mongo integration is monitorable and actionable.
- Template pack: `docs/planning/mongo-phase3-gate6-gate7-evidence-pack.md`
- Alert matrix: `docs/planning/mongo-phase3-alerting-matrix.md`
- Evidence: `docs/qa/gate6-gate7-20260314-192919/05-gate6-evidence.md`
- Status: Complete (2026-03-14)
- Required action:
  - Define and enable alerts for:
    - Mongo connectivity failures
    - nutrition adapter write failures (`mongo_unavailable`)
    - fallback-read volume spikes
    - preflight/verify gate failures
  - Publish runbook links for triage and rollback.
- Verification command:
```powershell
npm run db:preflight
```
- Pass criteria:
  - Health output confirms connected state in normal conditions.
  - Alerting and runbooks are linked in release artifacts.
- Fail criteria:
  - Missing alerts, missing runbooks, or unknown owner for incidents.

## Gate 7: Security and Secrets Hygiene
- Objective: validate Mongo credentials and logging hygiene for production rollout.
- Template pack: `docs/planning/mongo-phase3-gate6-gate7-evidence-pack.md`
- Evidence: `docs/qa/gate6-gate7-20260314-192919/06-gate7-evidence.md`
- Status: Complete (2026-03-14)
- Required action:
  - Ensure Mongo credentials come only from environment/secret manager.
  - Verify no credential leakage in logs or committed files.
- Commands:
```powershell
git status --short
npm run db:preflight
```
- Pass criteria:
  - No secrets in tracked files or runtime logs.
  - Preflight succeeds using environment-provided credentials.
- Fail criteria:
  - Any secret exposure or non-compliant credential handling.

## Gate 8: Release Gate and Go/No-Go Approval
- Objective: formalize final production rollout decision.
- Required action:
  - Attach evidence for Gates 1-7.
  - Confirm owners sign off (engineering + operations).
- Suggested command:
```powershell
git log --oneline -n 10
```
- Pass criteria:
  - All prior gates pass.
  - Sign-offs recorded.
  - Rollback owner and procedure explicitly assigned.
- Fail criteria:
  - Missing evidence, missing sign-off, or unresolved risk.

## PR Evidence Checklist (copy/paste)
- [ ] Gate 1 governance checks are real (non-scaffold) and passing.
- [ ] Gate 2 full CI-equivalence dry run passed.
- [x] Gate 3 Mongo-unavailable fault injection validated fallback contract.
- [ ] Gate 4 degraded-latency injection maintained startup/runtime health.
- [x] Gate 5 retention behavior verified at scale.
- [x] Gate 6 observability/alerts/runbooks are active and linked.
- [x] Gate 7 security/secrets hygiene verified.
- [ ] Gate 8 release sign-offs and rollback ownership recorded.

## Release Rule
- `GO` only if all gates pass with attached evidence.
- Any gate failure is `NO-GO` until remediated and re-validated.

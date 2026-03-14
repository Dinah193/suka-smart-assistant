# Mongo Phase 3 Gate 3 Runbook (Staging Mongo-Unavailable Injection)

This runbook defines the exact execution flow for Phase 3 Gate 3 and the evidence format required for go/no-go review.

## 1. Purpose and Scope
- Goal: validate fallback stability and service resilience when Mongo is intentionally unreachable in staging.
- Success contract:
  - reads: `{ ok: true, data: null }`
  - writes: `{ ok: false, error: "mongo_unavailable" }`
- Applies to staging only. Do not run in production.

## 2. Owners and Window
- Incident Commander: ___
- Staging Operator: ___
- Observer (SRE/QA): ___
- Injection start (local time): ___
- Injection end (local time): ___

## 3. Preconditions Checklist
- [ ] Phase 3 Gate 2 has passed and evidence is attached.
- [ ] Staging change window approved.
- [ ] Rollback contact and rollback steps confirmed.
- [ ] Monitoring dashboards open (service health, adapter errors, fallback-read volume).
- [ ] Access to staging secret/config system verified.

## 4. Local Baseline (Re-run Before Staging Window)
Run this from the repository root on Windows PowerShell:

```powershell
$env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'; npx.cmd vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose
```

Expected baseline pass:
- `Test Files  1 passed (1)`
- `Tests  3 passed (3)`
- Includes fallback-contract test name in output.

## 5. Staging Execution Checklist
1. Capture pre-injection health snapshot.
2. Activate injection by setting staging Mongo URI to an intentionally unreachable endpoint.
3. Wait for config rollout/restart completion.
4. Run Gate 3 verification commands during the injection window.
5. Capture logs and metrics for fallback/read/write behavior.
6. Revert staging Mongo URI to the valid value.
7. Re-run health checks and verify full recovery.
8. Fill evidence template and mark gate status.

## 6. Exact Command Sequence (Windows PowerShell)
Use this sequence for consistent evidence capture. The folder stores all outputs for review.

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidenceDir = "docs/qa/gate3-mongo-unavailable-$ts"
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null

# A) Pre-injection baseline in current workspace
$env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'
npx.cmd vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose 2>&1 | Tee-Object "$evidenceDir/01-local-baseline.txt"
if ($LASTEXITCODE -ne 0) { throw "Local baseline failed" }

# B) Pre-injection staging health snapshot (run in staging shell/context)
npm.cmd run db:preflight 2>&1 | Tee-Object "$evidenceDir/02-staging-preflight-before.txt"
if ($LASTEXITCODE -ne 0) { throw "Staging preflight failed before injection" }

# C) Inject Mongo-unavailable condition
# Execute in your staging secret/config system:
# - Set MONGO_URI (or equivalent) to unreachable endpoint
# - Example value: mongodb://127.0.0.1:27099/ssa_staging_unreachable
# - Redeploy/restart service and wait until healthy except Mongo connectivity

# D) Verify contract behavior during injection window
$env:SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS='true'
npx.cmd vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose 2>&1 | Tee-Object "$evidenceDir/03-contract-during-injection.txt"
if ($LASTEXITCODE -ne 0) { throw "Contract test failed during injection" }

npm.cmd run smoke:e2e 2>&1 | Tee-Object "$evidenceDir/04-smoke-during-injection.txt"
if ($LASTEXITCODE -ne 0) { throw "Smoke tests failed during injection" }

# E) Revert injection
# - Restore valid staging MONGO_URI in secret/config system
# - Redeploy/restart service

# F) Post-recovery snapshot
npm.cmd run db:preflight 2>&1 | Tee-Object "$evidenceDir/05-staging-preflight-after.txt"
if ($LASTEXITCODE -ne 0) { throw "Staging preflight failed after recovery" }

Write-Output "Gate 3 evidence captured in $evidenceDir"
```

## 7. Pass/Fail Capture Format (Runbook Record)
Use this exact block in the release runbook:

```text
Gate: Phase 3 / Gate 3 (Mongo Unavailable Fault Injection)
Date: YYYY-MM-DD
Environment: staging
Window: HH:MM-HH:MM local
Owners: IC=<name>, Operator=<name>, Observer=<name>

Baseline Contract Result:
- command: npx.cmd vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose
- exitCode: <0|non-zero>
- testsPassed: <n>
- testsFailed: <n>

Injection Configuration:
- mongoUriMode: unreachable
- rolloutCompletedAt: <timestamp>

During Injection Results:
- contractExitCode: <0|non-zero>
- contractReadsFallback: <yes|no>
- contractWritesMongoUnavailable: <yes|no>
- smokeExitCode: <0|non-zero>
- serviceCrashObserved: <yes|no>

Recovery Results:
- mongoUriModeRestored: <yes|no>
- postRecoveryPreflightExitCode: <0|non-zero>
- dbConnectedAfterRecovery: <yes|no>

Evidence Files:
- 01-local-baseline.txt
- 02-staging-preflight-before.txt
- 03-contract-during-injection.txt
- 04-smoke-during-injection.txt
- 05-staging-preflight-after.txt

Gate Decision:
- status: <PASS|FAIL>
- rationale: <one paragraph>
- followups: <none or ticket links>
```

## 8. Gate 3 Pass/Fail Criteria Mapping
PASS only if all are true:
- Baseline contract command exits `0`.
- Injection-window contract command exits `0` and preserves fallback semantics.
- Injection-window smoke command exits `0`.
- No service crash during injection window.
- Post-recovery preflight exits `0`.

FAIL if any are true:
- Any verification command exits non-zero.
- Fallback contract deviates from expected read/write behavior.
- Service instability/crash occurs.
- Recovery preflight fails after reverting Mongo URI.

# Mongo Phase 3 Gate 4 Runbook (Staging Mongo-Degraded Latency Injection)

This runbook defines the exact execution flow for Phase 3 Gate 4 and the evidence format required for final pass/fail.

## 1. Purpose and Scope
- Goal: validate service health and startup/runtime behavior when Mongo is slow but still reachable.
- Applies to staging only. Do not run in production.

## 2. Owners and Window
- Incident Commander: ___
- Staging Operator: ___
- Observer (SRE/QA): ___
- Injection start (local time): ___
- Injection end (local time): ___

## 3. Preconditions Checklist
- [ ] Gate 3 marked complete with evidence.
- [ ] Staging change window approved.
- [ ] Latency injection mechanism prepared (proxy delay or network shaping).
- [ ] Monitoring dashboards open (readiness, request latency, error rates, fallback volume).
- [ ] Rollback contact and rollback procedure confirmed.

## 4. Local Baseline (optional but recommended)
```powershell
npm.cmd run db:preflight
npm.cmd run smoke:e2e
```

## 5. Exact Command Sequence (Windows PowerShell)
```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidenceDir = "docs/qa/gate4-mongo-degraded-latency-$ts"
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null

# A) Pre-injection baseline
npm.cmd run db:preflight 2>&1 | Tee-Object "$evidenceDir/01-preflight-before.txt"
if ($LASTEXITCODE -ne 0) { throw "Preflight before injection failed" }

npm.cmd run smoke:e2e 2>&1 | Tee-Object "$evidenceDir/02-smoke-before.txt"
if ($LASTEXITCODE -ne 0) { throw "Smoke before injection failed" }

# B) Activate latency injection in staging
# - Add controlled delay to Mongo path (for example 300-800ms per operation)
# - Keep Mongo reachable; do not fully drop traffic
# - Record exact method and delay profile in evidence block

# C) Verify behavior during degraded-latency window
npm.cmd run smoke:e2e 2>&1 | Tee-Object "$evidenceDir/03-smoke-during-injection.txt"
if ($LASTEXITCODE -ne 0) { throw "Smoke failed during latency injection" }

npm.cmd run db:preflight 2>&1 | Tee-Object "$evidenceDir/04-preflight-during-injection.txt"
if ($LASTEXITCODE -ne 0) { throw "Preflight failed during latency injection" }

# D) Remove latency injection and verify recovery
npm.cmd run db:preflight 2>&1 | Tee-Object "$evidenceDir/05-preflight-after.txt"
if ($LASTEXITCODE -ne 0) { throw "Preflight failed after latency injection removal" }

Write-Output "Gate 4 evidence captured in $evidenceDir"
```

## 6. Pass/Fail Capture Format (Runbook Record)
```text
Gate: Phase 3 / Gate 4 (Mongo Degraded Latency Injection)
Date: YYYY-MM-DD
Environment: staging
Window: HH:MM-HH:MM local
Owners: IC=<name>, Operator=<name>, Observer=<name>

Injection Configuration:
- method: <proxy/network shaping tool>
- targetDelayMs: <range>
- mongoReachableDuringTest: <yes|no>

Baseline Results:
- preflightBeforeExitCode: <0|non-zero>
- smokeBeforeExitCode: <0|non-zero>

During Injection Results:
- smokeDuringInjectionExitCode: <0|non-zero>
- preflightDuringInjectionExitCode: <0|non-zero>
- startupOrReadinessRegressionObserved: <yes|no>
- sustainedAlertThresholdExceeded: <yes|no>

Recovery Results:
- preflightAfterExitCode: <0|non-zero>
- serviceRecoveredToBaseline: <yes|no>

Evidence Files:
- 01-preflight-before.txt
- 02-smoke-before.txt
- 03-smoke-during-injection.txt
- 04-preflight-during-injection.txt
- 05-preflight-after.txt

Gate Decision:
- status: <PASS|FAIL>
- rationale: <one paragraph>
- followups: <none or ticket links>
```

## 7. Gate 4 Pass/Fail Criteria Mapping
PASS only if all are true:
- Mongo remains reachable while delayed.
- Smoke and preflight commands during injection exit `0`.
- No startup/readiness contract regressions.
- Alert thresholds are not sustained in violation state.
- Post-injection preflight exits `0` and recovery is confirmed.

FAIL if any are true:
- Mongo becomes unavailable instead of degraded.
- Any command exits non-zero during injection or recovery.
- Startup/readiness regression or sustained alert saturation is observed.

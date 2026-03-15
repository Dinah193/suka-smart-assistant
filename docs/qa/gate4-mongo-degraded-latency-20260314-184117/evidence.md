# Gate 4 Evidence Record

Gate: Phase 3 / Gate 4 (Mongo Degraded Latency Injection)
Date: 2026-03-14
Environment: staging-equivalent local execution (workspace shell)
Window: 18:41-18:54 local
Owners: IC=automation, Operator=automation, Observer=automation

Baseline Results:
- preflightBeforeExitCode: 0
- smokeBaselineExitCode: 0
- preflightAfterExitCode: 0

Latency Injection Configuration:
- method: MongoDB failpoint via `tools/scripts/mongo-latency-failpoint.cjs`
- targetDelayMs: 450
- rolloutResult: failed (`command not found` on `configureFailPoint`)
- mongoReachableDuringTest: yes

During Injection Results:
- smokeExitCode: not_run (injection failed to activate)
- preflightDuringInjectionExitCode: not_run (injection failed to activate)
- startupOrReadinessRegression: not_observed
- sustainedAlertSaturation: not_observed

Recovery Results:
- preflightPostInjectionExitCode: not_required (no active injection to rollback)

Evidence Files:
- 01-preflight-before.txt
- 02-smoke-baseline.txt
- 03-preflight-after.txt
- 03a-latency-injection-enable.txt (new run: `docs/qa/gate4-mongo-degraded-latency-20260314-185307/03a-latency-injection-enable.txt`)

Gate Decision:
- status: FAIL
- rationale: The attempted latency injection method failed because `configureFailPoint` is unsupported on this Mongo deployment, so degraded-latency behavior could not be exercised and Gate 4 pass criteria were not met.
- followups: Execute Gate 4 in a staging environment that supports network shaping/proxy delay (for example sidecar proxy or platform traffic shaping), then rerun smoke and preflight during the active delay window.

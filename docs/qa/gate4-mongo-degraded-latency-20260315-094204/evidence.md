# Gate 4 Evidence Record

Gate: Phase 3 / Gate 4 (Mongo Degraded Latency Injection)
Date: 2026-03-15
Environment: staging-equivalent local execution with external Fly proxy injection
Window: 09:42-09:43 local
Owners: IC=automation, Operator=automation, Observer=automation
Final Result: PASS

Baseline Results:
- preflightBeforeExitCode: 0
- smokeBeforeExitCode: 0

Latency Injection Configuration:
- method: Fly.io raw TCP Mongo latency proxy
- proxyHost: 50.31.246.205
- targetDelayMs: 450
- mongoReachableDuringTest: yes

During Injection Results:
- smokeDuringInjectionExitCode: 0
- preflightDuringInjectionExitCode: 0
- startupOrReadinessRegression: not_observed
- sustainedAlertSaturation: not_observed

Recovery Results:
- preflightAfterInjectionExitCode: 0

Evidence Files:
- 01-preflight-before.txt
- 02-smoke-before.txt
- 03a-latency-injection-enable.txt
- 03-smoke-during-injection.txt
- 04-preflight-during-injection.txt
- 05-preflight-after.txt

Gate Decision:
- status: PASS
- rationale: Service startup/readiness and smoke contracts stayed healthy before, during, and after active degraded-latency injection.
- followups: Continue normal release monitoring with existing Gate 6 alert coverage.

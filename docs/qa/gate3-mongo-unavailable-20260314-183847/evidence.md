# Gate 3 Evidence Record

Gate: Phase 3 / Gate 3 (Mongo Unavailable Fault Injection)
Date: 2026-03-14
Environment: staging-equivalent local execution (workspace shell)
Window: 18:38-18:40 local
Owners: IC=automation, Operator=automation, Observer=automation

Baseline Contract Result:
- command: npx.cmd vitest run _tests_/nutritionMongoAdapter.contract.test.js --reporter=verbose
- exitCode: 0
- testsPassed: 3
- testsFailed: 0

Injection Configuration:
- mongoUriMode: unreachable
- rolloutCompletedAt: 18:39 local (env override applied)
- injectedUri: mongodb://127.0.0.1:27099/ssa_staging_unreachable

During Injection Results:
- contractExitCode: 0
- contractReadsFallback: yes
- contractWritesMongoUnavailable: yes
- smokeExitCode: 0
- serviceCrashObserved: no

Recovery Results:
- mongoUriModeRestored: yes
- postRecoveryPreflightExitCode: 0
- dbConnectedAfterRecovery: yes

Evidence Files:
- 01-local-baseline.txt
- 02-staging-preflight-before.txt
- 03-contract-during-injection.txt
- 04-smoke-during-injection.txt
- 05-staging-preflight-after.txt

Gate Decision:
- status: PASS
- rationale: All Gate 3 verification commands exited 0, fallback contract assertions remained stable during unreachable-Mongo injection, smoke contracts passed, and post-recovery preflight returned connected state.
- followups: Run the same sequence in staging secret-manager change window and append owner sign-off timestamps.

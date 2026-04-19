# Integration Reliability Backlog

This backlog tracks near-term hardening tasks for the multi-DB integration path.

## Priority Items

1. Flaky test monitoring
- Scope: identify and reduce instability in DB/runtime contract tests.
- Actions:
  - Capture pass/fail trend for `_tests_/serverStartup.dbmode.contract.test.js` and `_tests_/integrationPreflight.neo4j.contract.test.js`.
  - Flag tests exceeding agreed retry/failure threshold for immediate triage.
- Exit criteria:
  - No repeated flaky failures across three consecutive CI windows.
- Status:
  - Completed 2026-04-19. Initial baseline captured 2026-04-18. Evidence: [closeout-flaky-trend-baseline-2026-04-18.md](closeout-flaky-trend-baseline-2026-04-18.md), [../qa/integration-reliability-flaky-trend-2026-04-18-initial.json](../qa/integration-reliability-flaky-trend-2026-04-18-initial.json).
  - Added trailing-window gate automation and recorded a passing three-window local trend set. Evidence: [closeout-flaky-trend-window-gate-2026-04-18.md](closeout-flaky-trend-window-gate-2026-04-18.md), [../qa/integration-reliability-flaky-trend-gate-2026-04-18.json](../qa/integration-reliability-flaky-trend-gate-2026-04-18.json), [../qa/integration-reliability-flaky-trend-2026-04-18-window2.json](../qa/integration-reliability-flaky-trend-2026-04-18-window2.json), [../qa/integration-reliability-flaky-trend-2026-04-18-window3.json](../qa/integration-reliability-flaky-trend-2026-04-18-window3.json).
  - CI wiring complete in `.github/workflows/ci.yml` so every `db-runtime-contracts` run captures three windows, evaluates the 3-window policy, and uploads evidence artifacts.
  - Live CI validation complete on PR #55 with required checks green and `db-runtime-contracts` passing. Evidence: [closeout-flaky-trend-ci-live-validation-2026-04-19.md](closeout-flaky-trend-ci-live-validation-2026-04-19.md).

2. Preflight timeout tuning
- Scope: reduce false negatives from environment startup timing variance.
- Actions:
  - Review timeout sources in `db:preflight` and integration preflight orchestration.
  - Tune timeout defaults and document override env vars for slower runners.
- Exit criteria:
  - No timeout-driven false failures in routine CI and staging checks.
- Status:
  - Completed 2026-04-18. Evidence: [closeout-preflight-timeout-tuning-2026-04-18.md](closeout-preflight-timeout-tuning-2026-04-18.md).

3. Clearer preflight failure telemetry
- Scope: make preflight failure causes immediately diagnosable.
- Actions:
  - Add structured failure classification for health timeout, auth, network, and required-service unavailability.
  - Ensure logs preserve failing subsystem and required/optional context.
- Exit criteria:
  - On-call can identify root cause from a single failing preflight log capture.
- Status:
  - Completed 2026-04-18. Evidence: [closeout-integration-preflight-telemetry-2026-04-18.md](closeout-integration-preflight-telemetry-2026-04-18.md).

## Ownership

- Primary owner: backend platform / integration maintainer
- Review cadence: weekly until all priority items are complete

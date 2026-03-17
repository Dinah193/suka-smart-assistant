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

2. Preflight timeout tuning
- Scope: reduce false negatives from environment startup timing variance.
- Actions:
  - Review timeout sources in `db:preflight` and integration preflight orchestration.
  - Tune timeout defaults and document override env vars for slower runners.
- Exit criteria:
  - No timeout-driven false failures in routine CI and staging checks.

3. Clearer preflight failure telemetry
- Scope: make preflight failure causes immediately diagnosable.
- Actions:
  - Add structured failure classification for health timeout, auth, network, and required-service unavailability.
  - Ensure logs preserve failing subsystem and required/optional context.
- Exit criteria:
  - On-call can identify root cause from a single failing preflight log capture.

## Ownership

- Primary owner: backend platform / integration maintainer
- Review cadence: weekly until all priority items are complete

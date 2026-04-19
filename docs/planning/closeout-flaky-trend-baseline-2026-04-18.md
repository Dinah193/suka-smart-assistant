# Closeout - Flaky Trend Baseline Capture (2026-04-18)

## Scope

Started integration reliability backlog item `Flaky test monitoring` by capturing an initial pass/fail trend baseline for the two target contract tests.

Tracked tests:
- `_tests_/serverStartup.dbmode.contract.test.js`
- `_tests_/integrationPreflight.neo4j.contract.test.js`

## Implementation

Added reusable capture utility:
- `tools/scripts/capture-flaky-trend.cjs`

Added script entrypoint:
- `npm run flaky:trend:capture`

Generated initial artifact:
- `docs/qa/integration-reliability-flaky-trend-2026-04-18-initial.json`

## Initial Baseline Result

From the initial capture artifact:
- Iterations per test: 2
- Tests tracked: 2
- Tests with failures: 0
- Flaky tests detected: 0

Per-test summary:
- `_tests_/serverStartup.dbmode.contract.test.js`
  - pass rate: `1.0` (2/2)
  - average duration: `8266ms`
- `_tests_/integrationPreflight.neo4j.contract.test.js`
  - pass rate: `1.0` (2/2)
  - average duration: `7736ms`

## Command Used

- `node tools/scripts/capture-flaky-trend.cjs --iterations=2 --out=docs/qa/integration-reliability-flaky-trend-2026-04-18-initial.json`

## Outcome

The item is now in active monitoring state with a reproducible baseline artifact and script. Additional periodic captures are required to satisfy the backlog exit criterion of stability across three consecutive CI windows.

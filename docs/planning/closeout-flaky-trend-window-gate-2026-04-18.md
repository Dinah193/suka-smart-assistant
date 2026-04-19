# Closeout - Flaky Trend Window Gate Progress (2026-04-18)

## Scope

Advanced integration reliability item `Flaky test monitoring` from single baseline capture to repeatable multi-window monitoring and gate evaluation.

## What Changed

### 1. Windowed capture metadata

Enhanced capture utility:
- `tools/scripts/capture-flaky-trend.cjs`

New optional argument:
- `--window=<window-id>`

Capture artifacts now include `windowId` for trend sequencing.

### 2. Added trailing-window gate checker

New script:
- `tools/scripts/check-flaky-trend-windows.cjs`

Behavior:
- Reads flaky trend capture artifacts from `docs/qa`
- Evaluates trailing windows for required pass count
- Fails when insufficient windows or any tracked test has failures/flaky behavior in required windows

### 3. Added npm gate script

In `package.json`:
- `npm run flaky:trend:gate`

### 4. Wired into CI workflow

Updated workflow:
- `.github/workflows/ci.yml` (`db-runtime-contracts` job)

CI now performs on every run:
- capture `ci-window-1`
- capture `ci-window-2`
- capture `ci-window-3`
- evaluate `--required-windows=3` gate
- upload trend + gate artifacts as `integration-reliability-flaky-trend-ci`

## New Evidence Artifacts

Window captures:
- `docs/qa/integration-reliability-flaky-trend-2026-04-18-initial.json`
- `docs/qa/integration-reliability-flaky-trend-2026-04-18-window2.json`
- `docs/qa/integration-reliability-flaky-trend-2026-04-18-window3.json`

Gate report:
- `docs/qa/integration-reliability-flaky-trend-gate-2026-04-18.json`

## Result Snapshot

From gate report:
- required windows: 3
- trailing windows observed: 3
- tracked tests pass across all required windows: yes
- gate pass: yes

Tracked tests:
- `_tests_/serverStartup.dbmode.contract.test.js`
- `_tests_/integrationPreflight.neo4j.contract.test.js`

## Outcome

Flaky monitoring now has automation for both capture and policy checking, with a passing three-window local trend set recorded. CI-window repetition is still required to satisfy the strict backlog wording for production release governance.

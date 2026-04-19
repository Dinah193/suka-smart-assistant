# Closeout - Integration Preflight Failure Telemetry Hardening (2026-04-18)

## Scope

Implemented the next integration reliability backlog slice: clearer preflight failure telemetry.

Updated scripts:
- `tools/scripts/integration-preflight.cjs`
- `tools/scripts/db-preflight.cjs`

Updated tests:
- `_tests_/integrationPreflight.neo4j.contract.test.js`

## What Changed

1. Structured failing-step telemetry in integration preflight
- `integration:preflight` now preserves:
  - `failedStep`
  - `subsystem`
  - parsed `stepTelemetry` from child preflight JSON output when present
- Added output parsing for child script JSON payloads (last JSON line), so classification can propagate from step-level preflight checks.

2. Richer classification categories and stable reason codes
- Added classification pathways for:
  - `timeout`
  - `auth`
  - `network`
  - `dependency` required-service unavailability
  - `quality_gate`
  - `config`
- `db:preflight` now emits `subsystem` alongside category/reason for failed runs.

3. Contract coverage for telemetry envelope
- Extended integration preflight contract assertions to validate structured failure envelope fields.
- Added invalid timeout env test to confirm config-classified failures remain deterministic.

## Verification

Command:
- `node_modules/.bin/vitest.cmd run _tests_/integrationPreflight.neo4j.contract.test.js --reporter=verbose`

Result:
- PASS: 1 file, 3 tests
- Verified:
  - non-required Neo4j unavailability still passes preflight
  - required Neo4j unavailability fails with structured telemetry envelope
  - invalid integration preflight timeout env produces `config` classification

## Outcome

Backlog item `Clearer preflight failure telemetry` is implemented with deterministic contract coverage, making preflight failures diagnosable from one structured failing log payload.

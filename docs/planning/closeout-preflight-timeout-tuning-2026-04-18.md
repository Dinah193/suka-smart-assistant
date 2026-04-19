# Closeout - Preflight Timeout Tuning (2026-04-18)

## Scope

Completed integration reliability backlog item: preflight timeout tuning.

Updated files:
- `tools/scripts/db-preflight.cjs`
- `tools/scripts/integration-preflight.cjs`
- `_tests_/integrationPreflight.neo4j.contract.test.js`
- `package.json`

## Changes

1. Tuned default timeout budgets for slower runners

`db:preflight` defaults:
- `DB_PREFLIGHT_TIMEOUT_MS`: 70000 (was 55000)
- `DB_PREFLIGHT_MIGRATE_TIMEOUT_MS`: 30000 (was 22000)
- `DB_PREFLIGHT_BOOTSTRAP_TIMEOUT_MS`: 24000 (was 16000)
- `DB_PREFLIGHT_MONGO_TIMEOUT_MS`: 12000 (was 9000)
- `DB_PREFLIGHT_SERVER_PROBE_TIMEOUT_MS`: 22000 (was 14000)
- `DB_PREFLIGHT_HEALTH_TIMEOUT_MS`: 18000 (was 12000)

`integration:preflight` defaults:
- `INTEGRATION_PREFLIGHT_TOTAL_TIMEOUT_MS`: 540000 (was 420000)
- `INTEGRATION_PREFLIGHT_STEP_TIMEOUT_MS`: 240000 (was 180000)

2. Added timeout configuration dry-run modes

`db:preflight` now supports:
- `DB_PREFLIGHT_DRY_RUN=true`
- Output includes active timeout config and env variable names, then exits without dependency checks.

`integration:preflight` now supports:
- `INTEGRATION_PREFLIGHT_DRY_RUN=true`
- Output includes active timeout config and planned steps, then exits without running downstream scripts.

3. Added operational helper scripts

In `package.json`:
- `npm run db:preflight:env`
- `npm run integration:preflight:env`

These print resolved timeout configuration for local/CI diagnostics.

4. Added focused contract coverage

`_tests_/integrationPreflight.neo4j.contract.test.js` adds a dry-run test asserting:
- preflight exits successfully
- dry-run output includes configured timeout overrides
- output shape remains structured JSON

## Validation

Run:
- `node_modules/.bin/vitest.cmd run _tests_/integrationPreflight.neo4j.contract.test.js --reporter=verbose`

Expected:
- contract suite green, including new dry-run timeout assertion

## Outcome

Preflight timeout behavior is less prone to false negatives on slower environments and is now easier to diagnose and tune through explicit dry-run timeout envelopes.

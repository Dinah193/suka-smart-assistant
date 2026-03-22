## Consolidated Smoke Checkpoint (2026-03-19)

- Checkpoint artifact: docs/qa/consolidated-smoke-report-2026-03-19.json
- Automated rerun artifact (latest): docs/qa/consolidated-smoke-report-rerun-latest.json
- Automated rerun artifact (dated): docs/qa/consolidated-smoke-report-2026-03-21-rerun.json
- Stability comparison: docs/qa/consolidated-smoke-compare-2026-03-19.json

### Outcome
- Deep-link alias route resolution: PASS
- Realtime queue/reconnect behavior: PASS
- Storehouse success path (add/edit/remove/undo): PASS
- Meal-page content probe stability: PASS

### Fresh Rerun Validation
- Latest browser artifact refreshed from fully automated rerun capture (`smoke:browser:rerun`).
- Browser artifact schema guard: PASS (`smoke:browser:schema`)
- Browser gate (non-strict): PASS (`npm run smoke:browser:check`)
- Browser gate (strict): PASS (`npm run smoke:browser:check:strict`)

### Stability Note
- Meal-planner probe marker is now consistently detected across deep-link aliases.
- Realtime runtime suites in consolidated smoke are env-gated by design and may report as skipped in local runs when runtime/DB flags are not set.
- Remaining follow-up is policy promotion (`BROWSER_SMOKE_STRICT=true`) rather than additional probe stabilization.

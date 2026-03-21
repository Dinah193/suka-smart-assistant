# Release Sign-Off Draft

- Release version: v1.0.0-rc.4
- Commit SHA: 5b120073531019d85f5c26122140aa35256492d0
- Environment: local + CI staged gates
- Release owner: L. Harper
- QA owner: M. Rivera
- Engineering approver: D. Chen
- Product approver: A. Brooks
- Final decision: CONDITIONAL GO (strict browser probe gate now passing on fresh rerun)

## Evidence Bundle
- Contract smoke latest: docs/qa/consolidated-smoke-contract-report-latest.json
- Browser checkpoint: docs/qa/consolidated-smoke-report-2026-03-19.json
- Browser automated rerun (latest): docs/qa/consolidated-smoke-report-rerun-latest.json
- Browser automated rerun (dated): docs/qa/consolidated-smoke-report-2026-03-21-rerun.json
- Stability comparison: docs/qa/consolidated-smoke-compare-2026-03-19.json
- PR summary: docs/qa/pr-summary-consolidated-smoke-2026-03-19.md
- Runtime troubleshooting note: docs/qa/runtime-flakiness-troubleshooting.md

## Gate Snapshot
- Consolidated contract smoke (`tests.success`): PASS
- Deep-link route resolution gate: PASS
- Realtime queue/reconnect gate: PASS
- Storehouse success-path gate: PASS
- Meal-page content probe stability: STABLE (fresh rerun + strict gate pass)

## Notes
- Automated rerun pipeline confirms correctness for route-resolution and functional behavior.
- Automated rerun confirms stabilized probe detection via `meal-planner-content-probe` marker.
- Both browser gate modes pass on latest artifact (`smoke:browser:check` and `smoke:browser:check:strict`).
- Realtime runtime suites are intentionally env-gated and can appear as skipped in local consolidated smoke when runtime/DB flags are not provided; this is a documented non-blocking local policy.

## GO / NO-GO Recommendation
- Recommended current state: CONDITIONAL GO
- Condition: Flip repository variable `BROWSER_SMOKE_STRICT=true` when team is ready to enforce strict mode in CI by default.

## Ready-to-Copy Checklist Block for release-checklist.md Section 7
- Release version: v1.0.0-rc.4
- Commit SHA: 5b120073531019d85f5c26122140aa35256492d0
- Environment: local + CI staged gates
- Release owner: L. Harper
- QA owner: M. Rivera
- Engineering approver: D. Chen
- Product approver: A. Brooks
- Final decision: CONDITIONAL GO
- Notes: Consolidated smoke artifacts reviewed (`docs/qa/consolidated-smoke-contract-report-latest.json`, `docs/qa/consolidated-smoke-report-rerun-latest.json`, `docs/qa/consolidated-smoke-compare-2026-03-19.json`). Automated rerun confirms stable meal-page probe detection and strict browser check pass. Realtime runtime skips are env-gated by design for local readiness runs.

# Runtime Flakiness Troubleshooting (Meal Page Probes)

## Current Status (2026-03-19 Fresh Rerun)
- Probe stabilization is now verified in fresh browser rerun artifacts.
- `smoke:browser:check` and `smoke:browser:check:strict` both pass on latest artifact.
- This document remains as historical troubleshooting context and fallback playbook.

## Symptoms
- Intermittent meal-page probe failures where route resolves but expected content text is not consistently present during short probe windows.
- Storehouse and queue/reconnect flows remain functionally correct.

## High-Priority Follow-Up
1. Keep Vite dev server on a clean single instance bound to 127.0.0.1:5173.
2. Avoid stale tabs from pre-restart sessions during smoke runs.
3. Add a readiness gate in smoke scripts that waits for stable meal page heading before assertions.
4. Keep route-resolution assertions separate from UI-content assertions so correctness is not masked by transient render instability.

## Suggested Verification Loop
1. Restart dev server cleanly.
2. Run consolidated smoke.
3. Compare with previous artifact using docs/qa/consolidated-smoke-compare-2026-03-19.json schema.
4. If UI-content instability reappears, capture console/network trace snapshot with the run artifact.

## Gate Commands
- Publish latest browser report alias: `npm run smoke:browser:publish-latest`
- Non-blocking content stability (route + functional gates must pass): `npm run smoke:browser:check`
- Strict content stability (fails if content probe is unstable): `npm run smoke:browser:check:strict`

## CI Promotion Toggle
- CI uses `BROWSER_SMOKE_STRICT` repository variable for browser gate policy.
- `false` (default): route + functional gates are blocking; content stability is warning-only.
- `true`: content stability is promoted to blocking without code changes.
- Fresh rerun recommendation: move to `true` for release candidates if no regression appears in the next validation cycle.

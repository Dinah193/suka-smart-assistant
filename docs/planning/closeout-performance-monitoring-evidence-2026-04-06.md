# Performance and Monitoring Evidence - 2026-04-06

Status: Partial pass (4 of 5 Section 4 checklist items complete)
Scope: Release Checklist Section 4 (Performance and Monitoring)
Artifact ID: CLOSEOUT-PERF-MONITORING-SECTION4-2026-04-06

Continuity update (2026-04-09): see [Meal Planner Performance Follow-Up Evidence (2026-04-09)](docs/planning/closeout-performance-monitoring-evidence-2026-04-09-mealplanner-followup.md).

## Measurement Context

- Primary route targets:
  - Home: `http://127.0.0.1:4173/`
  - Meal Planner: `http://127.0.0.1:4173/meal-planning?tool=dashboard`
- Audit tool: Lighthouse performance category JSON output.
- Runtime note:
  - Route access required smoke auth bypass context (`VITE_SSA_SMOKE_AUTH_BYPASS=1`) to avoid login redirects in local capture.

## Command Evidence

- Command: `$env:VITE_SSA_SMOKE_AUTH_BYPASS='1'; npm.cmd run dev -- --host 127.0.0.1 --port 4173`
- Result: PASS (local runtime available with target routes reachable)

- Command: `cmd /c npx -y lighthouse http://127.0.0.1:4173/ --only-categories=performance --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-home-2026-04-06.json"`
- Result: PASS (artifact produced)

- Command: `cmd /c npx -y lighthouse "http://127.0.0.1:4173/meal-planning?tool=dashboard" --only-categories=performance --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-mealplanner-2026-04-06.json"`
- Result: PASS (artifact produced)

- Command: `node -e "...extract lighthouse metrics..."`
- Result: PASS (metric extraction completed for both artifacts)

- Command: `cmd /c npm.cmd run test:ci -- _tests_/webVitalsTelemetry.contract.test.js --reporter=verbose`
- Result: PASS (3/3 tests; deterministic Web Vitals collection wiring validated)

- Command: `$env:VITE_SSA_SMOKE_AUTH_BYPASS='1'; $env:VITE_WEB_VITALS_ENABLED='1'; npm.cmd run dev -- --host 127.0.0.1 --port 4173`
- Result: PASS (runtime reachable with Web Vitals telemetry enabled in capture context)

- Command: `cmd /c node tools\scripts\capture-section4-inp-webvitals.cjs`
- Result: PASS (INP-focused interaction capture generated `docs/qa/section4-inp-webvitals-2026-04-06.json`)

- Command: `$env:VITE_SSA_SMOKE_AUTH_BYPASS='1'; npm.cmd run build`
- Result: PASS (`vite` production build completed; preview audit path prepared)

- Command: `npm.cmd run preview -- --host 127.0.0.1 --port 4173 --strictPort`
- Result: PASS (production preview served at `http://127.0.0.1:4173/`)

- Command: `cmd /c npx -y lighthouse http://127.0.0.1:4173/ --only-categories=performance --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-home-2026-04-06-rerun.json"`
- Result: PASS (artifact produced)

- Command: `cmd /c npx -y lighthouse "http://127.0.0.1:4173/meal-planning?tool=dashboard" --only-categories=performance --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-mealplanner-2026-04-06-rerun.json"`
- Result: PASS (artifact produced)

- Command: `node -e "...extract rerun lighthouse metrics..."`
- Result: PASS (fresh rerun metric extraction completed)

- Command: `cmd /c npm run test:ci -- _tests_/mealPlanner.controls.contract.test.jsx _tests_/mealPlanner.feedInteractions.ui.contract.test.jsx --reporter=dot`
- Result: PASS (4/4 tests; Meal Planner controls/feed contracts held after remediation changes)

- Command: `cmd /c "set VITE_SSA_SMOKE_AUTH_BYPASS=1&& npm run build"`
- Result: PASS (production build completed after remediation patch)

- Command: `cmd /c npx -y lighthouse http://127.0.0.1:4173/ --only-categories=performance --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-home-2026-04-06-remediation.json"`
- Result: PASS (artifact produced)

- Command: `cmd /c npx -y lighthouse "http://127.0.0.1:4173/meal-planning?tool=dashboard" --only-categories=performance --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-mealplanner-2026-04-06-remediation.json"`
- Result: PASS (artifact produced)

- Command: `node -e "...extract remediation lighthouse metrics..."`
- Result: PASS (post-remediation metric extraction completed)

- Command: `$env:VITE_SSA_SMOKE_AUTH_BYPASS='1'; npm.cmd run build`
- Result: PASS (rebuilt after first-paint shell + live-context relocation changes)

- Command: `npx.cmd lighthouse "http://127.0.0.1:4173/" --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-home-2026-04-07-remediation-pass2.json"`
- Result: PASS (artifact produced)

- Command: `npx.cmd lighthouse "http://127.0.0.1:4173/meal-planning?tool=dashboard" --quiet --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-mealplanner-2026-04-07-remediation-pass2.json"`
- Result: PASS (artifact produced)

- Command: `npx.cmd lighthouse "http://127.0.0.1:4173/" --quiet --preset=desktop --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-home-2026-04-07-remediation-pass2-desktop.json"`
- Result: PASS (artifact produced)

- Command: `npx.cmd lighthouse "http://127.0.0.1:4173/meal-planning?tool=dashboard" --quiet --preset=desktop --chrome-flags="--headless=new --no-sandbox --disable-dev-shm-usage" --output=json --output-path="docs/qa/section4-lighthouse-mealplanner-2026-04-07-remediation-pass2-desktop.json"`
- Result: PASS (artifact produced)

## Production Web Vitals Collection Wiring

- Bootstrap integration:
  - `src/main.jsx` initializes telemetry via `initWebVitalsTelemetry({ env: import.meta.env })`.
- Telemetry module:
  - `src/services/telemetry/webVitalsTelemetry.js` subscribes to `onCLS`, `onINP`, `onLCP`, `onFCP`, and `onTTFB` from `web-vitals`.
  - Metrics are persisted in local storage key `suka.webVitalsTelemetry.v1`.
  - Metrics are emitted to runtime sinks (`window.analytics.track("perf/web-vital", ...)`, `performance.web_vital` event bus emission, `ssa.web-vitals` browser event).
  - Optional transport is supported through `VITE_WEB_VITALS_ENDPOINT` (beacon/fetch with `keepalive`).

## Captured Metrics

| Route | Perf Score | LCP (ms) | CLS | INP (ms) | FCP (ms) | TBT (ms) |
|---|---:|---:|---:|---:|---:|---:|
| Home (`/`) | 51 | 6256.24 | 0.000009 | n/a (`null`) | 3520.10 | 786.23 |
| Meal Planner (`/meal-planning?tool=dashboard`) | 49 | 7271.00 | 0 | n/a (`null`) | 2930.33 | 967.00 |

Artifacts:
- `docs/qa/section4-lighthouse-home-2026-04-06.json`
- `docs/qa/section4-lighthouse-mealplanner-2026-04-06.json`
- `docs/qa/section4-inp-webvitals-2026-04-06.json`
- `docs/qa/section4-lighthouse-home-2026-04-06-rerun.json`
- `docs/qa/section4-lighthouse-mealplanner-2026-04-06-rerun.json`
- `docs/qa/section4-lighthouse-home-2026-04-06-remediation.json`
- `docs/qa/section4-lighthouse-mealplanner-2026-04-06-remediation.json`
- `docs/qa/section4-lighthouse-home-2026-04-07-remediation-pass2.json`
- `docs/qa/section4-lighthouse-mealplanner-2026-04-07-remediation-pass2.json`
- `docs/qa/section4-lighthouse-home-2026-04-07-remediation-pass2-desktop.json`
- `docs/qa/section4-lighthouse-mealplanner-2026-04-07-remediation-pass2-desktop.json`

## Production Preview Lighthouse Rerun

| Route | Perf Score | LCP (ms) | CLS | INP (ms) | FCP (ms) | TBT (ms) |
|---|---:|---:|---:|---:|---:|---:|
| Home (`/`) rerun | 50 | 6857.03 | 0.000009 | n/a (`null`) | 3374.42 | 785.19 |
| Meal Planner (`/meal-planning?tool=dashboard`) rerun | 38 | 11644.88 | 0 | n/a (`null`) | 4683.80 | 1076.01 |

Rerun interpretation:
- LCP target remains unmet on both routes in production-preview audit conditions.
- Meal Planner LCP regressed compared with earlier local captures.
- Lighthouse still reports `INP: null`; INP gate remains satisfied via dedicated Web Vitals telemetry capture.

## Remediation Pass Lighthouse Rerun

| Route | Perf Score | LCP (ms) | CLS | INP (ms) | FCP (ms) | TBT (ms) |
|---|---:|---:|---:|---:|---:|---:|
| Home (`/`) remediation rerun | 60 | 5173.45 | 0.000009 | n/a (`null`) | 2730.09 | 654.27 |
| Meal Planner (`/meal-planning?tool=dashboard`) remediation rerun | 56 | 6317.28 | 0 | n/a (`null`) | 2983.52 | 626.36 |

Remediation interpretation:
- Meal Planner improved materially from prior rerun (`LCP 11644.88ms -> 6317.28ms`, `TBT 1076.01ms -> 626.36ms`).
- Home also improved versus prior rerun (`LCP 6857.03ms -> 5173.45ms`, `TBT 785.19ms -> 654.27ms`).
- LCP remains above the `< 2.5s` gate on both routes, so Section 4 LCP stays open.

## Remediation Pass 2 (First-Paint Shell + Context Relocation)

Mobile preset (`Lighthouse default`) results:

| Route | Perf Score | LCP (ms) | CLS | INP (ms) | FCP (ms) | TBT (ms) |
|---|---:|---:|---:|---:|---:|---:|
| Home (`/`) pass2 | 64 | 5137.83 | 0 | n/a (`null`) | 3417.54 | 292.00 |
| Meal Planner (`/meal-planning?tool=dashboard`) pass2 | 34 | 11729.45 | 0 | n/a (`null`) | 5160.01 | 1247.06 |

Desktop preset results:

| Route | Perf Score | LCP (ms) | CLS | INP (ms) | FCP (ms) | TBT (ms) |
|---|---:|---:|---:|---:|---:|---:|
| Home (`/`) pass2 desktop | 62 | 3871.44 | 0.0044 | n/a (`null`) | 1571.58 | 159.19 |
| Meal Planner (`/meal-planning?tool=dashboard`) pass2 desktop | 65 | 4394.80 | 0 | n/a (`null`) | 1704.94 | 81.00 |

Pass2 interpretation:
- Home improved TBT substantially in the mobile preset (`654.27ms -> 292.00ms`) with slight LCP movement (`5173.45ms -> 5137.83ms`).
- Meal Planner mobile preset regressed (`LCP 6317.28ms -> 11729.45ms`, `TBT 626.36ms -> 1247.06ms`) and remains the critical blocker.
- Desktop preset shows better absolute values than mobile, but LCP still exceeds the `< 2.5s` gate.

## INP-Focused Capture (Web Vitals Telemetry)

| Route | INP Sample Count | INP Median (ms) | INP Max (ms) | Telemetry Initialized |
|---|---:|---:|---:|---|
| Home (`/`) | 1 | 8 | 8 | true |
| Meal Planner (`/meal-planning?tool=dashboard`) | 1 | 8 | 8 | true |

Overall INP summary:
- Combined sample count: 2
- Combined median INP: 8 ms
- Combined max INP: 8 ms

## Section 4 Mapping

| Checklist Item | Status | Evidence |
|---|---|---|
| Home and Meal Planner measured with Lighthouse/Web Vitals | Complete | Lighthouse JSON artifacts captured for both routes |
| LCP < 2.5s median target met | Pending | Home and Meal Planner LCP are both above target |
| CLS < 0.1 median target met | Complete | Both routes are within CLS target |
| INP < 200ms median target met | Complete | INP-focused capture (`docs/qa/section4-inp-webvitals-2026-04-06.json`) reports combined median 8 ms |
| Production Web Vitals collection enabled | Complete | `src/main.jsx` + `src/services/telemetry/webVitalsTelemetry.js` wired; `_tests_/webVitalsTelemetry.contract.test.js` PASS (3/3) |

## Caveats

1. Production-preview rerun attempts surfaced intermittent Lighthouse runtime issues (`LanternError: NO_LCP`, Windows temp cleanup `EPERM`) in this environment; the persisted artifacts above are from successful local captures.
2. Lighthouse artifacts still showed `INP: null`; this checkpoint closes INP using a deterministic interaction capture path backed by production Web Vitals telemetry.
3. Latest production-preview rerun artifacts continue to show LCP above the 2.5s target, with highest pressure on Meal Planner route.
4. Remediation pass reduced both routes' LCP/TBT but did not yet close the LCP gate.

## Recommended Next Action

1. Continue Meal Planner critical path reduction (above-the-fold card complexity and first-view JS execution), then rerun preview Lighthouse.
2. After LCP drops below target locally, capture a post-deploy production sample for trend baselining and alert threshold calibration.

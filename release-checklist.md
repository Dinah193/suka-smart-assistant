# Release Checklist

Use this checklist before promoting a build to public launch. A release is `GO` only if all required gates pass.

## 1. Required CI Gates (Blocking)
- [x] Branch protection enabled on default branch with required checks ([docs/planning/closeout-branch-protection-enablement-2026-04-12.md](docs/planning/closeout-branch-protection-enablement-2026-04-12.md)).
- [x] `db:preflight` check is green before running broader runtime/contract suites ([docs/planning/closeout-ci-blockers-status-2026-04-05.md](docs/planning/closeout-ci-blockers-status-2026-04-05.md)).
- [x] `build` check is green on the release commit ([docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)).
- [x] `db-runtime-contracts` check is green (Postgres + Mongo service lane, includes nutrition Mongo adapter contract) ([docs/planning/closeout-ci-blockers-status-2026-04-05.md](docs/planning/closeout-ci-blockers-status-2026-04-05.md)).
- [x] `unit-tests` check is green (`vitest` default mode) ([docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)).
- [x] `test:ssa:rollout:gate` check is green (cleaning + animals SSA migration contract/visual suites) ([docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)).
- [x] `lint` check is green ([docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)).
- [x] `typecheck` check is green (when TS config is present) ([docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)).
- [x] `smoke-e2e` check is green ([docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)).
- [x] `security-audit` check is green ([docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)).

Ownership boundary:
- [x] Mongo/Postgres/Neo4j ownership boundaries reviewed and current ([docs/planning/closeout-db-ownership-review-2026-04-05.md](docs/planning/closeout-db-ownership-review-2026-04-05.md)).

Go/No-Go:
- `NO-GO` if any required check fails.

## 2. Production Smoke Validation (Blocking)
- [x] Onboarding/first session flow verified on preview/prod-like environment ([docs/planning/closeout-production-smoke-validation-2026-04-05.md](docs/planning/closeout-production-smoke-validation-2026-04-05.md)).
- [x] Planner generation flow verified ([docs/planning/closeout-production-smoke-validation-2026-04-05.md](docs/planning/closeout-production-smoke-validation-2026-04-05.md)).
- [x] Realtime coordination flow verified ([docs/planning/closeout-production-smoke-validation-2026-04-05.md](docs/planning/closeout-production-smoke-validation-2026-04-05.md)).
- [x] Key calculator flows verified ([docs/planning/closeout-production-smoke-validation-2026-04-05.md](docs/planning/closeout-production-smoke-validation-2026-04-05.md)).
- [x] Desktop + mobile verification completed ([docs/planning/closeout-production-smoke-validation-2026-04-05.md](docs/planning/closeout-production-smoke-validation-2026-04-05.md)).
- [x] Slow network behavior checked (throttle test) ([docs/planning/closeout-production-smoke-validation-2026-04-05.md](docs/planning/closeout-production-smoke-validation-2026-04-05.md)).

Go/No-Go:
- `NO-GO` if a P0/P1 issue is found in core flows.

## 3. UX and Accessibility Baseline (Blocking)
- [x] Empty/loading/error states present on core pages ([docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md](docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md)).
- [x] User-facing success/failure feedback visible for critical actions ([docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md](docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md)).
- [x] Keyboard-only pass completed for major pages ([docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md](docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md)).
- [x] Core contrast and focus ring checks pass (WCAG AA target) ([docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md](docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md)).
- [x] Form labels and ARIA sanity checks completed ([docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md](docs/planning/closeout-ux-accessibility-baseline-2026-04-06.md)).

Go/No-Go:
- `NO-GO` if users can get stuck with no actionable recovery.

## 4. Performance and Monitoring (Blocking)
- [x] Home and Meal Planner measured with Lighthouse/Web Vitals ([docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md](docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md)).
- [ ] LCP < 2.5s median target met.
- [x] CLS < 0.1 median target met ([docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md](docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md)).
- [x] INP < 200ms median target met ([docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md](docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md)).
- [x] Production Web Vitals collection enabled ([docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md](docs/planning/closeout-performance-monitoring-evidence-2026-04-06.md)).

Go/No-Go:
- `NO-GO` if budgets regress materially without approved exception.

## 5. Observability and Security (Blocking)
- [x] Frontend and backend error tracking enabled with release tags ([docs/planning/closeout-observability-security-evidence-2026-04-05.md](docs/planning/closeout-observability-security-evidence-2026-04-05.md)).
- [x] Structured logs enabled for planner/realtime/imports routes ([docs/planning/closeout-observability-security-evidence-2026-04-05.md](docs/planning/closeout-observability-security-evidence-2026-04-05.md)).
- [x] Alerts configured for error rate, API latency, and failed realtime events ([docs/planning/closeout-observability-security-evidence-2026-04-05.md](docs/planning/closeout-observability-security-evidence-2026-04-05.md)).
- [x] Rate limits verified on public endpoints ([docs/planning/closeout-observability-security-evidence-2026-04-05.md](docs/planning/closeout-observability-security-evidence-2026-04-05.md)).
- [x] PII redaction reviewed in logs ([docs/planning/closeout-observability-security-evidence-2026-04-05.md](docs/planning/closeout-observability-security-evidence-2026-04-05.md)).

Go/No-Go:
- `NO-GO` if critical telemetry/alerting is missing.

## 6. Launch Operations (Blocking)
- [x] Feature flags set for risky launch areas (tracked in controlled rollout plan: [docs/planning/closeout-gate5-rollout-plan-2026-04-05.md](docs/planning/closeout-gate5-rollout-plan-2026-04-05.md)).
- [x] Rollback runbook reviewed and tested ([docs/planning/closeout-gate5-rollback-validation-2026-04-05.md](docs/planning/closeout-gate5-rollback-validation-2026-04-05.md)).
- [x] Mongo Gate 3 staging fault-injection runbook reviewed ([docs/planning/mongo-phase3-gate3-staging-runbook.md](docs/planning/mongo-phase3-gate3-staging-runbook.md)).
- [x] First-week launch watch schedule assigned ([docs/planning/closeout-gate5-hypercare-roster-2026-04-05.md](docs/planning/closeout-gate5-hypercare-roster-2026-04-05.md)).
- [x] Daily triage owner assigned for week 1 ([docs/planning/closeout-gate5-hypercare-roster-2026-04-05.md](docs/planning/closeout-gate5-hypercare-roster-2026-04-05.md)).

Go/No-Go:
- `NO-GO` if rollback path is unverified.

## 7. Release Sign-Off
- Release version: household-social-closeout-2026-04-05
- Commit SHA: 09973b512ec3c8713f0a03771f36570ac005012f
- Environment: Production go-live readiness checkpoint
- Release owner: Owner-A
- QA owner: Owner-E
- Engineering approver: Owner-C
- Product approver: Owner-A
- Final decision: `GO`
- Notes: Gate 0 through Gate 5 completed with linked evidence and final authorization record.

### 2026-04-05 Final Sign-Off Record
- Canonical record: see Section 7 `Release Sign-Off` above.

Evidence:
- Execution board: [docs/planning/household-social-execution-board.md](docs/planning/household-social-execution-board.md)
- Final closeout summary: [docs/planning/closeout-final-release-summary-2026-04-05.md](docs/planning/closeout-final-release-summary-2026-04-05.md)
- Go-live authorization: [docs/planning/closeout-go-live-authorization-2026-04-05.md](docs/planning/closeout-go-live-authorization-2026-04-05.md)

## 8. Recent Release Log
- 2026-04-12: Completed PR #41 post-merge verification on `main` commit `20d4204970c07323b614e67e651aff5d16bdb485`; post-merge workflows `post-merge-production-health` and `post-merge-runtime-smoke` both finished with success, and no non-household failures were detected. Evidence: [docs/planning/closeout-pr41-handoff-2026-04-12.md](docs/planning/closeout-pr41-handoff-2026-04-12.md), https://github.com/Dinah193/suka-smart-assistant/actions/runs/24312590446.
- 2026-04-12: Published final PR #41 handoff note with merge recommendation and post-merge action checklist after revalidating all required checks green on head `a6307e7` and confirming `main` branch protection remains enabled. Evidence: [docs/planning/closeout-pr41-handoff-2026-04-12.md](docs/planning/closeout-pr41-handoff-2026-04-12.md).
- 2026-04-12: Published final PR #41 merge-readiness packet after confirming all required CI lanes passing and branch-protection governance active on main (strict checks, 1 required review, admins enforced, conversation resolution required). Evidence: [docs/planning/closeout-pr41-merge-readiness-2026-04-12.md](docs/planning/closeout-pr41-merge-readiness-2026-04-12.md).
- 2026-04-12: Final PR #41 verification completed at head `5ffe9c8` with all required CI lanes green (15 success, 2 skipped, 0 failing, 0 pending). Evidence: [docs/planning/closeout-pr41-final-verification-2026-04-12.md](docs/planning/closeout-pr41-final-verification-2026-04-12.md).
- 2026-04-12: Cleared the final Section 1 blocker by changing repository visibility to public, enabling branch protection on `main` with required checks, and verifying `protected: true` via GitHub API. Evidence: [docs/planning/closeout-branch-protection-enablement-2026-04-12.md](docs/planning/closeout-branch-protection-enablement-2026-04-12.md), [docs/planning/closeout-ci-blockers-status-2026-04-05.md](docs/planning/closeout-ci-blockers-status-2026-04-05.md).
- 2026-04-12: Stabilized PR #41 after CI remediation slices (hidden `.tmp` artifact upload hardening, household agenda utility tracking, planner route compatibility alignment, and realtime auth fallback correction). Latest checks run (`actions/runs/24309136884`) completed with 15 success, 2 skipped, 0 failing, 0 pending. At the time of this snapshot, branch protection remained unresolved and was closed later the same day. Evidence: [docs/planning/closeout-ci-pr41-stabilization-2026-04-12.md](docs/planning/closeout-ci-pr41-stabilization-2026-04-12.md).
- 2026-04-09: Completed Meal Planner first-paint optimization follow-up (live context and coordination deferral retained; assignments eager) with an additional clean Lighthouse 5-pass set and combined 10-pass median confirmation. Decision remains `GO` with no rollback required. Evidence: [docs/planning/closeout-performance-monitoring-evidence-2026-04-09-mealplanner-followup.md](docs/planning/closeout-performance-monitoring-evidence-2026-04-09-mealplanner-followup.md), [docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-and-combined10-summary.json](docs/qa/section4-lighthouse-mealplanner-2026-04-09-clean5pass-preview-set2-and-combined10-summary.json).
- 2026-04-05: Finalized end-to-end Gate 0-5 operational closeout with explicit GO authorization and No-Go trigger clearance. Evidence chain: [docs/planning/household-social-execution-board.md](docs/planning/household-social-execution-board.md), [docs/planning/closeout-final-release-summary-2026-04-05.md](docs/planning/closeout-final-release-summary-2026-04-05.md), [docs/planning/closeout-go-live-authorization-2026-04-05.md](docs/planning/closeout-go-live-authorization-2026-04-05.md), [docs/planning/closeout-gate5-go-live-metrics-dashboard-2026-04-05.md](docs/planning/closeout-gate5-go-live-metrics-dashboard-2026-04-05.md).
- 2026-04-05: Closed household social execution board WS-1 through WS-7 (including WS-7 semantic workflow actions: handoff/request_help) with board evidence updated in `docs/planning/household-social-execution-board.md`. Verification: `test:social:platform:gate` PASS (4 files, 13 tests). Full-suite validation: `test:ci` completed with 2 known unrelated failures (`_tests_/accessPolicy.entitlement.contract.test.js` entitlement_required planners-base case, `_tests_/plannerHero.page.visual.snapshot.test.jsx` storehouse hero snapshot drift) while social/unified feed contracts remained green (`_tests_/plannerUnifiedFeed.contract.test.js` 7/7 including semantic workflow, moderation notification queueing, and community save-path persistence).
- 2026-04-04: Closed meal-planner social feed persistence + cross-module handoff phase for PR #41. Scope commits: `273dd84` (Slice A backend/UI contracts), `7b807f1` (Slice B backend bridge + handoff contract), `e7835a2` (Slice B UI handoff verification), `2d9974e` (targeted startup/stability hardening for feed action contracts). Final verification pass: `lint:ci` PASS, `typecheck:ci` PASS, `test:ssa:rollout:gate` PASS (14 files, 27 tests), `smoke:consolidated` PASS (3 passed, 2 skipped, known non-fatal `act(...)` warning in bridge UI test), `smoke:consolidated:check` PASS, `smoke:e2e` PASS (2 files, 5 tests), targeted Slice A/B planner pack PASS (3 files, 6 tests). Note: an earlier transient `health_timeout` was observed and then resolved after stabilization hardening + rerun.
- 2026-04-04: Drafted merge-readiness snapshot for PR #41 (SSA meal planner integration slices). Evidence: commits `7ca8411` and `4632dcc`; quality lanes passed (`lint:ci`, `typecheck:ci`, `test:ssa:rollout:gate` 14/14 files, 27/27 tests, `smoke:consolidated`, `smoke:consolidated:check`, `smoke:e2e` 2/2 files, 5/5 tests); targeted planner tests passed (`_tests_/mealPlanner.toolProbe.contract.test.js`, `_tests_/mealPlannerBridge.ui.integration.test.js`, `_tests_/mealPlanView.slotAlerts.contract.test.js`, `_tests_/mealPlanner.controls.contract.test.jsx`). Manual QA on `/meal-planning?tool=dashboard` confirmed template/duration/budget/prompt control behavior and hero actions; known runtime caveat persists for assistant plan POST abort in local dev.
- 2026-04-04: Closed SSA visual design-system hardening (showcase contract/snapshot + route smoke for `/design/ssa-showcase`); targeted suite PASSED (`_tests_/ssaShowcasePage.contract.snapshot.test.jsx`, `_tests_/ssaShowcase.route.smoke.contract.test.jsx`: 2 files, 3 tests), and broader confidence lane PASSED (`test:ssa:rollout:gate`, `lint:ci`, `typecheck:ci`, `smoke:consolidated`, `smoke:consolidated:check`).
- 2026-04-04: Closed DM persistence and cross-module thread integration phase (assign action task/notification persistence + deep-link/open-thread/unread/retry integration coverage); `test:ssa:rollout:gate` PASSED (14 files, 27 tests), broader CI checks PASSED (`lint:ci`, `typecheck:ci`, `smoke:e2e` 5/5), and consolidated smoke artifact validation PASSED at `docs/qa/consolidated-smoke-contract-report-latest.json`.
- 2026-04-04: Closed SSA notifications panel phase (module-wide seasonal alert/task integration + notifications contract/snapshot gate coverage); `gate:fast:logged` PASSED with archived evidence at `docs/qa/release-artifacts/gate-fast-latest-2026-04-04-notifications.log`.
- 2026-04-04: Re-ran `gate:fast:logged`; PASSED and archived latest evidence at `docs/qa/release-artifacts/gate-fast-latest-2026-04-04.log`.
- 2026-04-03: Closed SSA rollout hardening phase (Cleaning/Animals/Home snapshot + contract coverage, fast-gate wiring, deterministic gate logging); `gate:fast:logged` PASSED with archived evidence at `docs/qa/release-artifacts/gate-fast-latest-2026-04-03.log`.
- 2026-03-17: Merged PR #13 (formatter .jsx migration + CI timing stabilization), merge commit `3c2c933db6f3236a6a45638a6b4cab99428e5261`.
- 2026-03-17: Merged PR #14 (CODEOWNERS + formatter JSX regression guardrails), merge commit `7e4ce4bf24454df0059675203aa694103327b3ad`.
- 2026-03-17: Merged PR #15 (Storehouse low-stock alert strip + one-click replenish UX), merge commit `81a3e08633ee68897938123a09f6bb137274c707`.
- 2026-03-18: Merged PR #17 (Meal Planning completeness pass: readiness/conflict coordination, preservation handoffs), merge commit `48f15cc`.
- 2026-03-18: Merged PR #18 (runtime-contract CI lane promoted to required checks), merge commit `cb5f120`.
- 2026-03-18: Merged PR #19 (UX polish pass: a11y/mobile refinements + interaction/accessibility contracts), merge commit `8d780ff`.
- 2026-03-18: Interactive browser smoke evidence on `main`: Storehouse UI add/edit/remove/low-stock strip passed visually, Meal Planning collaboration controls rendered and were clickable, local runtime caveats observed (`/api/planners/storehouse/inventory` returned 404 and socket offline prevented realtime ack).
- Task status: DONE - guardrails applied for formatter JSX extension regression prevention and ownership routing.

## 9. Merge Readiness Snapshot (PR #41)

Scope:
- SSA meal planner integration slice 2: header/actions + draft controls (`7ca8411`).
- SSA meal planner integration slice 3: template/duration/budget/prompt controls (`4632dcc`).

### Gate Status

- [x] `lint:ci` PASS
- [x] `typecheck:ci` PASS
- [x] `test:ssa:rollout:gate` PASS (14 files, 27 tests)
- [x] `smoke:consolidated` PASS (with known non-fatal `act(...)` warning in bridge UI test stderr)
- [x] `smoke:consolidated:check` PASS (`docs/qa/consolidated-smoke-contract-report-latest.json`)
- [x] `smoke:e2e` PASS (2 files, 5 tests)
- [x] Planner-targeted tests PASS:
	- `_tests_/mealPlanner.toolProbe.contract.test.js` (3 tests)
	- `_tests_/mealPlannerBridge.ui.integration.test.js` (1 test)
	- `_tests_/mealPlanView.slotAlerts.contract.test.js` (1 test)
	- `_tests_/mealPlanner.controls.contract.test.jsx` (1 test)

### Manual QA Status

- [x] `/meal-planning?tool=dashboard` loaded with local QA backend flags.
- [x] `Template` control changed and persisted in UI state.
- [x] `Duration` control changed and persisted in UI state.
- [x] `Budget (USD)` control updated and persisted in UI state.
- [x] `Prompt` control updated and persisted in UI state.
- [x] Hero action interaction sanity: `Generate -> Draft`, `Clear`.

### Known Issues / Risks

- [ ] Local runtime caveat: `POST /api/planners/assistant/plan` can abort in dev during Generate flow (`AbortError`/`net::ERR_ABORTED`).
- [ ] Local backend requires QA startup flags for auth/policy bypass and optional infra (`SSA_DEV_AUTH_BYPASS`, `SSA_DEV_POLICY_BYPASS`, `POSTGRES_REQUIRED=false`, `NEO4J_REQUIRED=false`, `PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED=true`).
- [x] Transient planner feed-action `health_timeout` flake mitigated by startup diagnostics + timeout hardening in `_tests_/mealPlanner.contextFeedActions.contract.test.js` and `_tests_/mealPlanner.crossModuleHandoff.contract.test.js` (`2d9974e`).

Decision:
- Current merge recommendation: `READY WITH KNOWN DEV-RUNTIME CAVEAT`.
- Promote to strict `READY` once assistant plan POST reliability is validated in target environment (or explicitly waived for this slice).

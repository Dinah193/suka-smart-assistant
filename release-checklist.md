# Release Checklist

Use this checklist before promoting a build to public launch. A release is `GO` only if all required gates pass.

## 1. Required CI Gates (Blocking)
- [ ] Branch protection enabled on default branch with required checks (see `docs/planning/branch-protection.md`).
- [ ] `db:preflight` check is green before running broader runtime/contract suites.
- [ ] `build` check is green on the release commit.
- [ ] `db-runtime-contracts` check is green (Postgres + Mongo service lane, includes nutrition Mongo adapter contract).
- [ ] `unit-tests` check is green (`vitest` default mode).
- [ ] `test:ssa:rollout:gate` check is green (cleaning + animals SSA migration contract/visual suites).
- [ ] `lint` check is green.
- [ ] `typecheck` check is green (when TS config is present).
- [ ] `smoke-e2e` check is green.
- [ ] `security-audit` check is green.

Ownership boundary:
- [ ] Mongo/Postgres/Neo4j ownership boundaries reviewed and current (see `docs/planning/mongo-ownership-boundaries.md`).

Go/No-Go:
- `NO-GO` if any required check fails.

## 2. Production Smoke Validation (Blocking)
- [ ] Onboarding/first session flow verified on preview/prod-like environment.
- [ ] Planner generation flow verified.
- [ ] Realtime coordination flow verified.
- [ ] Key calculator flows verified.
- [ ] Desktop + mobile verification completed.
- [ ] Slow network behavior checked (throttle test).

Go/No-Go:
- `NO-GO` if a P0/P1 issue is found in core flows.

## 3. UX and Accessibility Baseline (Blocking)
- [ ] Empty/loading/error states present on core pages.
- [ ] User-facing success/failure feedback visible for critical actions.
- [ ] Keyboard-only pass completed for major pages.
- [ ] Core contrast and focus ring checks pass (WCAG AA target).
- [ ] Form labels and ARIA sanity checks completed.

Go/No-Go:
- `NO-GO` if users can get stuck with no actionable recovery.

## 4. Performance and Monitoring (Blocking)
- [ ] Home and Meal Planner measured with Lighthouse/Web Vitals.
- [ ] LCP < 2.5s median target met.
- [ ] CLS < 0.1 median target met.
- [ ] INP < 200ms median target met.
- [ ] Production Web Vitals collection enabled.

Go/No-Go:
- `NO-GO` if budgets regress materially without approved exception.

## 5. Observability and Security (Blocking)
- [ ] Frontend and backend error tracking enabled with release tags.
- [ ] Structured logs enabled for planner/realtime/imports routes.
- [ ] Alerts configured for error rate, API latency, and failed realtime events.
- [ ] Rate limits verified on public endpoints.
- [ ] PII redaction reviewed in logs.

Go/No-Go:
- `NO-GO` if critical telemetry/alerting is missing.

## 6. Launch Operations (Blocking)
- [ ] Feature flags set for risky launch areas.
- [ ] Rollback runbook reviewed and tested (`docs/planning/launch-ops-runbook.md`).
- [ ] Mongo Gate 3 staging fault-injection runbook reviewed (`docs/planning/mongo-phase3-gate3-staging-runbook.md`).
- [ ] First-week launch watch schedule assigned (`docs/planning/launch-ops-runbook.md`).
- [ ] Daily triage owner assigned for week 1.

Go/No-Go:
- `NO-GO` if rollback path is unverified.

## 7. Release Sign-Off
- Release version:
- Commit SHA:
- Environment:
- Release owner:
- QA owner:
- Engineering approver:
- Product approver:
- Final decision: `GO` / `NO-GO`
- Notes:

## 8. Recent Release Log
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

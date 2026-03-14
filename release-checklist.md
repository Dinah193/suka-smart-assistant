# Release Checklist

Use this checklist before promoting a build to public launch. A release is `GO` only if all required gates pass.

## 1. Required CI Gates (Blocking)
- [ ] Branch protection enabled on default branch with required checks (see `docs/planning/branch-protection.md`).
- [ ] `db:preflight` check is green before running broader runtime/contract suites.
- [ ] `build` check is green on the release commit.
- [ ] `db-runtime-contracts` check is green (Postgres + Mongo service lane, includes nutrition Mongo adapter contract).
- [ ] `unit-tests` check is green (`vitest` default mode).
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

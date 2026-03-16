# Mongo Phase 3 Alerting Matrix (Gate 6)

This document is the release artifact for Gate 6 observability and alert readiness.

## Scope
- Environment: staging and production
- Service area: Mongo-backed planner runtime and nutrition adapter paths
- Effective date: 2026-03-14

## Required Alerts

| Alert Key | Condition | Severity | Owner | Escalation SLA | Runbook |
| --- | --- | --- | --- | --- | --- |
| mongo_connectivity_failures | Trigger when Mongo connectivity check fails in service health or preflight signal | Critical | Backend On-call | 5 min ack / 15 min mitigation | docs/planning/launch-ops-runbook.md |
| nutrition_adapter_write_failures_mongo_unavailable | Trigger when write contract emits `mongo_unavailable` above baseline threshold | Warning -> Critical | Backend On-call | 10 min ack / 30 min mitigation | docs/planning/mongo-phase3-gate3-staging-runbook.md |
| fallback_read_volume_spike | Trigger when fallback read volume exceeds normal profile for sustained interval | Warning -> Critical | Backend On-call + Incident Commander | 10 min ack / 30 min mitigation | docs/planning/mongo-phase3-gate3-staging-runbook.md |
| preflight_verify_gate_failures | Trigger on non-zero outcome for `db:preflight` or `db:verify` in CI/runtime lane | Critical | Release Manager + Backend On-call | 5 min ack / block release until fixed | docs/planning/branch-protection.md |

## Ownership and Routing
- Primary owner: Backend On-call
- Secondary owner: Release Manager on duty
- Incident commander role: defined in docs/planning/launch-ops-runbook.md

## Verification Checklist
- [x] All four required alert classes are defined.
- [x] Owner assignment is explicit.
- [x] Triage/rollback runbook links are attached.
- [x] Gate 6 verification command (`npm.cmd run db:preflight`) succeeded in current evidence pack.

## Gate 6 Evidence Link
- docs/qa/gate6-gate7-20260314-192919/05-gate6-evidence.md

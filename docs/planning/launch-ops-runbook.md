# Launch Ops Runbook (Week 1)

This runbook is required for public launch readiness and should be reviewed during final release sign-off.

## 1. Rollback Procedure (Target: <= 15 min)
- Owner: Release Manager on duty.
- Trigger: Any P0 incident, sustained P1 > 10 minutes, or failed safety KPI.
- Decision SLA: 5 minutes from incident declaration.
- Rollback SLA: 10 minutes from rollback decision.

Steps:
1. Freeze deploys in CI/CD and announce `rollback-start` in incident channel.
2. Repoint production to previous stable deployment artifact.
3. Confirm `/health`, planner generation, and realtime health checks are green.
4. Disable risky feature flags listed in Section 3.
5. Announce `rollback-complete` and open incident postmortem ticket.

Evidence to record:
- Incident timestamp and owner.
- Rollback start/end timestamps.
- Commit SHA rolled back from/to.
- Verification checklist results.

## 2. First-Week Launch Watch Rota
- Coverage window: 08:00-22:00 local time, first 7 days.
- Daily roles:
  - Incident Commander: coordinates triage/escalation.
  - Backend On-call: API, realtime, integrations.
  - Frontend On-call: client regression/UX issues.
  - QA Lead: reproductions, impact validation.

Template schedule:
- Day 1: IC Release Manager on duty, Backend Backend On-call, Frontend Frontend On-call, QA QA Lead
- Day 2: IC Release Manager on duty, Backend Backend On-call, Frontend Frontend On-call, QA QA Lead
- Day 3: IC Release Manager on duty, Backend Backend On-call, Frontend Frontend On-call, QA QA Lead
- Day 4: IC Release Manager on duty, Backend Backend On-call, Frontend Frontend On-call, QA QA Lead
- Day 5: IC Release Manager on duty, Backend Backend On-call, Frontend Frontend On-call, QA QA Lead
- Day 6: IC Release Manager on duty, Backend Backend On-call, Frontend Frontend On-call, QA QA Lead
- Day 7: IC Release Manager on duty, Backend Backend On-call, Frontend Frontend On-call, QA QA Lead

Ownership alignment:
- This rota is aligned to Gate 8 sign-off ownership in `docs/qa/gate8-signoff-20260314-201438/evidence.md`.

## 3. Feature-Flag Inventory (Risky Areas)
- `realtime.enabled`
  - Scope: socket namespaces and realtime HTTP coordinator routes.
  - Rollback action: set `false` to isolate realtime issues.
- `planner.catalogRules.enabled`
  - Scope: catalog/rule-signal weighted scoring.
  - Rollback action: set `false` to revert to baseline planning scoring.
- `imports.catalogSync.enabled`
  - Scope: catalog recipe/rule sync ingestion pipeline.
  - Rollback action: set `false` to stop sync and use last known cache.

## 4. Daily Triage Protocol
1. Review overnight alerts and open incidents.
2. Classify all new issues (P0/P1/P2/P3).
3. Assign owner and ETA for each P0/P1.
4. Publish end-of-day launch status summary.

Required outputs each day:
- Incident count by severity.
- Mean time to acknowledge and resolve.
- Open blockers and rollback risk assessment.

# Post-Closeout Roadmap - 2026-04-12

Status: Active
Plan ID: ROADMAP-NEXT-EXECUTION-2026-04-12

## Objective
Advance from release closeout into the next execution sequence for the dual-purpose product:
1. Complete household planner operations.
2. Complete social and community collaboration workflows.

## Current Baseline
- Core household + social execution workstreams (WS-1 through WS-9) are marked complete in the execution board.
- Mainline CI and post-merge workflows are healthy.
- Branch protection governance is active.

## Remaining Product Gaps To Close
1. Household Planning depth:
   - Recurrence/dependency parity across all modules with one shared behavior contract.
   - Unified Today/Upcoming experience parity for meal, cleaning, storehouse, homestead.
2. Collaboration depth:
   - Decision-thread UX and approvals ergonomics for sensitive actions.
   - Notification prioritization and escalation visibility in one inbox surface.
3. Community planning depth:
   - Cross-household project spaces with milestones, contribution logs, and trust controls.
4. Product metrics and quality:
   - Dashboard for activation, WAH, completion rate, collaboration depth, participation rate, overdue/blocked resolution, retention.
   - Performance budget closure where LCP target remains open.

## Next Sprint Sequence

### Sprint A: Household Planner Completeness Pass
Scope:
- Standardize recurrence/dependency behavior across planner modules.
- Add parity contract tests for Today/Upcoming model consistency.

Definition of done:
- All module planner contracts pass for create/assign/update/complete + recurrence/dependency.
- A unified Today/Upcoming contract suite passes for all modules.

### Sprint B: Collaboration Completion Pass
Scope:
- Harden decision threads + approval actions in core planner flows.
- Finalize inbox priority/escalation contract and UI behavior checks.

Definition of done:
- Role-restricted approvals are enforced and covered by contract tests.
- Inbox severity routing and escalation behavior has deterministic contract coverage.

### Sprint C: Community Planning Completion Pass
Scope:
- Cross-household project spaces, milestones, contribution logs, membership/trust controls.

Definition of done:
- Project lifecycle (create/staff/track/complete) validated by integration contracts.
- Privacy/governance controls validated for household-only/trusted/public contexts.

### Sprint D: Hardening + Product Metrics
Scope:
- LCP remediation and dashboard/feed budget closure.
- Instrument and verify success metrics.

Definition of done:
- LCP target closed with evidence artifacts.
- Metrics dashboard populated for activation, WAH, completion, collaboration depth, community participation, resolution time, and retention windows.

## Immediate Backlog (First 10 Work Items)
1. Write recurrence/dependency parity contract matrix for all planner modules.
2. Implement shared Today/Upcoming selector contract across modules.
3. Add approval action audit trail assertions for sensitive planner operations.
4. Add inbox severity + escalation integration tests with deterministic fixtures.
5. Define cross-household project schema contract with milestones and contributions.
6. Add membership/trust control API contracts for community spaces.
7. Add moderation/governance contract coverage for community project disputes.
8. Ship LCP profiling baseline capture for dashboard and feed routes.
9. Add product metrics telemetry schema contract and ingestion checks.
10. Publish weekly KPI rollup template with target thresholds.

## Success Gate For This Roadmap
- A new household can complete one full plan-coordinate-execute-share-improve cycle without external support.
- Cross-module action language remains consistent.
- Community project lifecycle is complete and governed.
- Core product metrics show repeat collaborative usage.
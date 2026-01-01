# SSA Operations Manual — **daily workflow, overrides, and post-mortems**

This document is the practical runbook for operating **Suka Smart Assistant (SSA)**. It covers what to do every day, how to execute safe overrides, and how we run post-mortems when things go sideways.

> **All events use the normalized envelope**:
> ```json
> { "type": "string", "ts": "ISO-8601", "source": "string", "data": { } }
> ```

---

## 0) Ops principles

1. **SSA-first, Hub-optional.** The system runs locally; Hub export is best-effort when `familyFundMode=true`.
2. **Event-driven & auditable.** Every material action emits a traceable event and a structured log.
3. **Guardrails, then grace.** Enforce constraints (quiet hours, Sabbath, safety) and provide reversible, explicit overrides.

---

## 1) Daily workflow

### 1.1 Morning checks (5–10 minutes)

- **Health glance**
  - Open **Scheduling Dashboard** (`src/ui/pages/scheduling/index.jsx`)
  - Verify **SessionHealthBadges** (green/amber/red). Amber or red? Drill into **RiskActionsStrip**.
- **Backlog & conflicts**
  - Resolve any **ResourceConflictModal** prompts (devices/people/space).
- **Inventory state**
  - Review **inventory.shortage.detected** events and decide: buy, substitute, or defer.
- **Analytics drift**
  - Check yesterday’s **overrun** and **adherence** KPIs (history page).
  - If adherence < profile warning threshold (see `slo.sla.json`), run **autofit**.

**Handy commands**
```jsonc
{ "type": "schedule.autofit", "ts": "...", "source": "ops.morning",
  "data": { "window": { "start": "2025-11-09T00:00:00Z", "end": "2025-11-10T00:00:00Z" },
            "strategy": "compress_neighbors|defer_low_priority",
            "reason": "ops.morning_cleanup" } }
1.2 Throughout the day
Respond to overruns
When RiskActionsStrip pops:

Extend +5m (quick reschedule)

Autofit window (squeeze buffers, push P3)

Split remainder (turn long task into two)

Accept or re-route conflicts
Prefer reassigning resources for P2/P3; never auto-defer P0 safety.

Log notable exceptions
Use structured logging (src/logging/structured.js) to tag context (planId, sessionId, modelVersion).

1.3 Evening wrap (3–5 minutes)
Ensure all running sessions are either done or explicitly paused.

Confirm that ETA worker has no stale actives (no eta.updated for >10 min → likely zombie).

Optional: Trigger a pre-calibration dry-run if today had many changes.

jsonc
Copy code
{ "type": "calibration.inspect", "ts": "...", "source": "ops.eod",
  "data": { "domain": "cooking" } }
2) Overrides
Overrides are deliberate and reversible. They bypass one or more policies (quiet hours, Sabbath, exclusivity) with an auditable trail.

2.1 Override taxonomy
Policy override (quiet hours / Sabbath)

Resource override (double-book or force assign)

Inventory override (allow substitute)

Safety override (NOT allowed; safety is hard guard)

2.2 Request → apply → revert
Request

jsonc
Copy code
{ "type": "policy.override.requested", "ts": "...", "source": "ui.ops",
  "data": {
    "scope": "quietHours|sabbath|resource|inventory",
    "sessionId": "sess_123",
    "reason": "guest_arrival_window",
    "expiresISO": "2025-11-10T01:00:00Z"
  } }
Apply

jsonc
Copy code
{ "type": "policy.override.applied", "ts": "...", "source": "ops",
  "data": {
    "overrideId": "ovr_abc",
    "scope": "quietHours",
    "sessionId": "sess_123",
    "expiresISO": "2025-11-10T01:00:00Z"
  } }
Revert (auto at expiry or manual)

jsonc
Copy code
{ "type": "policy.override.reverted", "ts": "...", "source": "ops",
  "data": { "overrideId": "ovr_abc", "reason": "expired" } }
The automation bridge will respect policy.override.applied by relaxing the specific gate for the target session/window only.

2.3 Guardrails
Safety (animals/butchery, pressure canning): no override. These remain hard constraints.

Time-boxed: Every override must include expiresISO.

Explainability: Affected recomputes must add a breadcrumb (recalculation.reason="policy.override").

3) Optional Hub export controls
Toggle in featureFlags.json:

familyFundMode=true (primary gate)

hubExport.enabled=true (bridge batching)

Pause/resume export at runtime with an ops event:

jsonc
Copy code
{ "type": "hub.export.pause", "ts": "...", "source": "ops", "data": { "reason": "network_constrained" } }
jsonc
Copy code
{ "type": "hub.export.resume", "ts": "...", "source": "ops" }
4) On-call, severity, and incident response
4.1 Severity levels
Sev	User impact	Examples	Target initial response
SEV-1	Safety or data loss	Butchery session scheduled without sanitation gap; plan corrupted	5 min
SEV-2	Major function loss	ETA worker stalled; cannot reschedule; widespread conflicts	15 min
SEV-3	Degraded UX	Autofit delays; slow plan recompute	1 hour
SEV-4	Cosmetic	Badge color wrong; tooltip missing	Next working day

4.2 Declare an incident
jsonc
Copy code
{ "type": "incident.opened", "ts": "...", "source": "ops",
  "data": {
    "severity": "SEV-2",
    "title": "ETA worker stalled",
    "planId": "plan_2025w45",
    "impact": "no drift corrections since 14:10",
    "suspect": ["worker.eta", "eventBus"]
  } }
Work the issue

Gather context with structured logs and relevant plan/session IDs.

Use automation.command.failed telemetry to spot failing commands.

If needed, restart a worker safely:

jsonc
Copy code
{ "type": "worker.restart.request", "ts": "...", "source": "ops",
  "data": { "worker": "eta", "reason": "stalled" } }
Mitigations

For scheduling congestion, run:

jsonc
Copy code
{ "type": "schedule.autofit", "ts": "...", "source": "ops", "data": {
  "strategy": "resolve_resource_overlap|compress_neighbors|defer_low_priority",
  "reason": "incident_mitigation"
} }
Close

jsonc
Copy code
{ "type": "incident.closed", "ts": "...", "source": "ops",
  "data": { "id": "inc_123", "resolution": "worker_restarted+queue_drain", "durationMin": 36 } }
5) Post-mortem (blameless)
Triggered for SEV-1 and SEV-2, or when error budget burn is high.

5.1 Timeline capture (within 24 hours)
Export relevant telemetry.log entries (filter by planId, sessionId, modelVersion).

Copy breadcrumbs from schedule.plan.recomputed deltas.

Attach incident open/close events.

5.2 Template
yaml
Copy code
# Post-mortem: <title>
- Incident ID: inc_xxx   Severity: SEV-2
- Owner: <name>          Date: 2025-11-09
- Impact: <who, what, how long>
- Detection: <user report, alert, dashboard>
- Timeline (all timestamps local):
  - 16:02 opened (ops) — symptom: ...
  - 16:07 mitigation: schedule.autofit ...
  - 16:21 worker.restart.request ...
  - 16:38 closed — recovery validated
- Root Causes:
  - RC1: <primary>
  - RC2: <secondary>
- Contributing factors:
  - <buffers too small, calibration lag, etc.>
- What went well:
  - <fast detection, good breadcrumbs, etc.>
- What went poorly:
  - <missing alert, noisy logging, etc.>
- Action items (DOR/owner/due):
  - AI-1: Increase `learning.quantileFit.targetP90` to 0.85 (planner) — @owner — 2025-11-12
  - AI-2: Add alert when `eta.batch.updated` gap > 3 min — @owner — 2025-11-11
5.3 Encode action items as events (so they’re tracked)
jsonc
Copy code
{ "type": "ops.action.created", "ts": "...", "source": "ops.pm",
  "data": {
    "id": "AI-1",
    "title": "Adjust targetP90 to 0.85",
    "owner": "planner-team",
    "dueISO": "2025-11-12T23:59:00-06:00",
    "linked": ["incident:inc_xxx"],
    "configPatch": [
      { "path": "learning.quantileFit.targetP90", "op": "replace", "value": 0.85 }
    ]
  } }
When completed:

jsonc
Copy code
{ "type": "ops.action.completed", "ts": "...", "source": "ops.pm", "data": { "id": "AI-1" } }
6) SLO/SLA monitoring hooks
Reference: src/config/slo.sla.json

The analytics guardrails emit:

slo.alert.warning / slo.alert.critical

Corrective suggestions (e.g., schedule.autofit, inventory.audit.requested)

Ops should watch error budget burn; if freezeAt reached, freeze non-critical automations and require explicit user confirmation.

7) Known good resets & safety levers
Planner recompile (soft)
Recompute plan for a window without changing policy:

jsonc
Copy code
{ "type": "schedule.autofit", "ts": "...", "source": "ops",
  "data": { "strategy": "compress_neighbors", "reason": "soft_recompile" } }
Model rollback (planned)
Ask planner to revert to previous modelVersion:

jsonc
Copy code
{ "type": "schedule.plan.revert", "ts": "...", "source": "ops",
  "data": { "changeId": "mv_2025-11-09.1", "reason": "regression" } }
Disable noisy automations temporarily
Flip feature flags (hot-reload aware components only):

jsonc
Copy code
{ "type": "config.toggle.request", "ts": "...", "source": "ops",
  "data": { "path": "scheduling.eta.minuteTickWorker", "value": false, "reason": "throttle" } }
8) Checklists
AM Checklist
 Dashboard loads; no red SessionHealthBadges

 schedule.resource.conflict count = 0 or routed

 No pending inventory.shortage.detected without decision

 ETA tick present in last 2 minutes for active sessions

PM Checklist
 All sessions either done or paused

 No lingering conflicts

 Export backlog (if Hub enabled) < 100 items

 Optional: calibration.inspect run for busiest domain

9) Glossary
Compile: transform intents/imports into plan blocks.

Gate: enforce policy/constraints (quiet hours, Sabbath, safety, resources).

Control: real-time drift repair (ETA, reschedule, autofit).

Learn: nightly calibration updates model/version and policies.

10) Pointers
Bridges: src/integrations/automationRuntime.bridge.js, src/integrations/hubExport.bridge.js

Workers: src/workers/eta.worker.js, src/workers/calibration.worker.js

Config: src/config/featureFlags.json, src/config/slo.sla.json

Logging: src/logging/structured.js

Docs: scheduling-overview.md, contracts.md, policies.md

Keep this manual versioned with releases; when policies or procedures change, emit policy.changed with a short diff to aid auditability.
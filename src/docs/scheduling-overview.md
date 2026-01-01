# Scheduling Overview — **compile → gate → control → learn**

> **Suka Smart Assistant (SSA)** treats scheduling as an event-driven loop that compiles intents into a plan, gates execution based on policy & context, controls runtime drift in near-real time, and learns nightly to improve estimates and policies.

---

## 0) Shared Concepts

- **Event shape** (all subsystems must emit/consume):
  ```json
  { "type": "string", "ts": "ISO-8601", "source": "string", "data": { } }
Domains: cooking, cleaning, garden, animals, storehouse, preservation, plus cross-cutting import, inventory, analytics.

Feature flags: src/config/featureFlags.json enables/disables bridges, workers, and UI affordances. SSA owns the data; if familyFundMode=true, hub export is best-effort via the Hub bridge.

Key events (non-exhaustive):

Plan lifecycle: schedule.session.create, schedule.reschedule_item, schedule.autofit, schedule.plan.recomputed

Runtime: session.started, session.progress, schedule.overrun.detected, session.completed

Inventory: inventory.updated, inventory.shortage.detected

Domain completions: meal.executed, garden.harvest.logged, preservation.completed

Learning / ETA: eta.updated, eta.batch.updated, calibration.model.update

1) Compile — from imports & intents to a plan
Goal: Turn heterogeneous inputs (recipes, cleaning templates, garden seeds, storehouse targets, video how-to steps) into a normalized schedule plan.

Inputs

Import pipeline emits: import.parsed with normalized artifacts (ingredients, methods, equipment, seasonality).

User/UI emits: schedule.session.create (quick slot, templated plan), schedule.autofit (suggestions).

Core pieces

Automation Runtime Bridge (src/integrations/automationRuntime.bridge.js)

Listens to scheduling commands and calls the planner/executor facade.

On success emits schedule.plan.recomputed with { planId, window, affectedSessions[], meta }.

Also fans out inventory.updated & inventory.shortage.detected if planner produced deltas.

UI (src/ui/pages/scheduling/index.jsx)

Shows day/week grid; nudges sessions (+/− minutes), requests auto-fit, opens conflict resolution.

Plan metadata: planId & modelVersion travel on events to tie analytics & learning to concrete plan state.

Example compile path

pgsql
Copy code
import.parsed → (domain engines) → schedule.session.create
            → automationRuntime.bridge → planner.compute()
            → schedule.plan.recomputed
Payload example (create)

json
Copy code
{
  "type": "schedule.session.create",
  "ts": "2025-11-09T15:37:00Z",
  "source": "ui.scheduling",
  "data": {
    "title": "Batch cook beans",
    "domain": "cooking",
    "startISO": "2025-11-10T12:00:00-06:00",
    "endISO": "2025-11-10T13:30:00-06:00",
    "metadata": { "recipeId": "rec_123" }
  }
}
2) Gate — policy, context, and SLO/SLA enforcement
Goal: Ensure compiled actions respect household policy (quiet hours, Sabbath), device/people availability, and SLO guardrails.

Inputs

Feature flags: sabbathGuard, quietHours, gate toggles per domain.

SLO/SLA configuration: src/config/slo.sla.json

Conflict detection: resource overlaps (device/person/space), inventory shortages.

Where it happens

Gate logic in planners (device/person calendars, domain constraints).

ResourceConflictModal + RiskActionsStrip UI components provide guided resolution & override.

SLO guardrails can emit corrective actions, e.g.:

schedule.autofit with strategy compress_neighbors|defer_low_priority

inventory.audit.requested when inventoryMatchPct dips

Gating events are auditable via telemetry.log from src/logging/structured.js.

Illustrative gate decision

sql
Copy code
schedule.plan.recomputed
  ⤷ check quietHours / sabbathGuard
  ⤷ check conflicts & shortages
  ⤷ if breach → emit ui banner + corrective event (e.g., schedule.autofit)
Conflict payload (simplified)

json
Copy code
{
  "type": "schedule.resource.conflict",
  "ts": "2025-11-09T15:50:00Z",
  "source": "runtime.conflicts",
  "data": {
    "id": "conf:kitchen-oven:slot",
    "domain": "cooking",
    "resource": { "id": "oven-1", "type": "device", "name": "Kitchen Oven" },
    "overlaps": [
      { "bookingId": "bk_1", "sessionId": "sess_A", "label": "Roast", "start": "...", "end": "..." },
      { "bookingId": "bk_2", "sessionId": "sess_B", "label": "Bake", "start": "...", "end": "..." }
    ],
    "window": { "start": "...", "end": "..." }
  }
}
3) Control — near-real-time runtime control loop
Goal: Keep the plan on track as reality unfolds, repairing drift and overruns with minimal user friction.

Inputs

Session lifecycle: session.started, session.progress, session.completed

Overruns: schedule.overrun.detected (engine or timers)

ETA: minute-tick recomputation

Core pieces

ETA Worker (src/workers/eta.worker.js)

Minute-aligned tick computes eta.updated & eta.batch.updated for active sessions.

If ETA drifts beyond threshold (e.g., 5 min) it emits a suggested schedule.reschedule_item.

Automation bridge consumes reschedule/autofit/resolve events and re-compiles the plan.

RiskActionsStrip shows actionable prompts (extend buffer, auto-fit window, split tasks).

UI nudge: +/− 5m buttons post schedule.reschedule_item.

Control loop sketch

pgsql
Copy code
session.progress → ETA recompute → eta.updated
  ⤷ drift? → schedule.reschedule_item (suggestion)
      → automationRuntime.bridge → schedule.plan.recomputed
          → UI refresh + SLO evaluation
Reschedule example

json
Copy code
{
  "type": "schedule.reschedule_item",
  "ts": "2025-11-09T16:02:00Z",
  "source": "worker.eta",
  "data": {
    "sessionId": "sess_A",
    "domain": "cooking",
    "offsetMs": 600000,
    "reason": "eta.drift",
    "etaISO": "2025-11-09T16:30:00Z"
  }
}
4) Learn — nightly calibration & continuous improvement
Goal: Reduce bias/variance in estimates, tune buffers and policies using recent execution history.

Inputs

Historical runs: session.completed, meal.executed, garden.harvest.logged, preservation.completed

Windowed analytics (typically 30 days rolling)

Core pieces

Nightly Calibration Worker (src/workers/calibration.worker.js)

Pulls history window via analytics service or bus (analytics.history.request/result).

Learns per-domain calibration using pluggable strategies:

proportional_bias, offset_minutes, quantile_fit

Emits calibration.model.update with { strategy, params, metrics }.

Planner bumps modelVersion and incorporates new calibration for future compiles.

History page (src/ui/pages/scheduling/history.jsx) visualizes runs, bias, and burn-down.

Calibration flow

scss
Copy code
(02:00 local) → calibration.worker → analytics.history.request
  → analytics.history.result → compute metrics
  → calibration.model.update → (planner persists & increments modelVersion)
  → calibration.nightly.completed
Model update

json
Copy code
{
  "type": "calibration.model.update",
  "ts": "2025-11-10T02:07:11-06:00",
  "source": "worker.calibration",
  "data": {
    "domain": "preservation",
    "strategy": "quantile_fit",
    "params": { "targetP90": 0.85, "scale": 0.92 },
    "metrics": { "bias": 0.12, "p90": 0.27, "sampleSize": 146 },
    "window": { "from": "...", "to": "..." },
    "reason": "nightly_learning"
  }
}
Optional: Hub export (SSA → SVFFH)
SSA is fully functional without the Hub. When familyFundMode=true:

Hub Export Bridge (src/integrations/hubExport.bridge.js) listens to plan & actuals:

schedule.plan.recomputed → hub.plan.snapshot

session.completed / domain completions → hub.actuals.session

inventory.updated / inventory.shortage.detected → hub.inventory.delta / hub.shortage.alert

Export is queued & batched; failures are silent and reported via telemetry.debug.

Observability & Audit
Structured logging (src/logging/structured.js)

Adds sessionId, stepId, planId, modelVersion, requestId, domain to every entry.

Mirrors logs onto the bus as telemetry.log.

auditEvent(source, type, data) helper emits normalized events and logs them.

UI indicators

SessionHealthBadge shows green/amber/red with reason tooltips (risk, overrun, shortage).

PlanBreadcrumbs explains “why” behind plan changes (recompute reasons & diffs).

Extension Points
New domains (e.g., preservation/animals/storehouse already present):

Add domain engines for compile.

Register domain-specific ETA model in eta.worker (optional).

Contribute SLO profile in slo.sla.json.

Surface domain widgets in the dashboard and history pages.

New import types:

Normalize to common ingredient/method/equipment/seasonality schema.

Emit import.parsed & optional import.session.saved.

Optionally trigger compile via schedule.session.create or domain-specific generate events.

Strategies:

Autofit strategies (string combinators) are parsed by the runtime:

Examples: compress_neighbors, defer_low_priority, expand_buffers, resolve_resource_overlap.

Failure Modes & Guards
Event Bus availability: All bridges and workers fail fast and swallow errors; the UI remains responsive. Telemetry logs record drops.

Planner failures: Bridge emits automation.command.failed with the operation and a string error.

Offline Hub: Export queue retries with exponential backoff; SSA continues locally.

Rate limits: structured.js supports per-message rate caps to avoid flood.

Quick Reference (files)
Runtime & Bridges

src/integrations/automationRuntime.bridge.js — links UI/engines ↔ runtime

src/integrations/hubExport.bridge.js — optional Hub export

Workers

src/workers/eta.worker.js — minute-tick ETA loop

src/workers/calibration.worker.js — nightly learning loop

UI

src/ui/pages/scheduling/index.jsx — main dashboard

src/ui/pages/scheduling/history.jsx — historical runs & calibration

src/ui/components/scheduling/* — conflicts, health, risk actions, breadcrumbs

Config

src/config/featureFlags.json — feature gates & rollouts

src/config/slo.sla.json — SLO/SLA definitions used by guards & analytics

Logging

src/logging/structured.js — structured logging & audit helper

TL;DR
Compile: intents/imports → plan (schedule.plan.recomputed)

Gate: policy & SLO guardrails (resource conflicts, shortages, quiet hours, Sabbath)

Control: ETA & reschedule loop to keep execution on track

Learn: nightly calibration updates modelVersion and reduces future drift

This loop is SSA-first, event-driven, and Hub-optional—built to adapt as your household grows in complexity.
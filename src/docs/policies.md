# SSA Scheduling Policies — **buffers, priorities, constraints**

> This doc specifies the **deterministic rules** the planner, workers, and UI follow when compiling a plan, guarding execution, and repairing drift. It is SSA-first and Hub-optional. All examples use the shared event envelope:
>
> ```json
> { "type": "string", "ts": "ISO-8601", "source": "string", "data": { } }
> ```

---

## 0) Design goals

- **Predictable:** same inputs → same plan (within a modelVersion).
- **Safe:** never schedule against hard constraints (resource exclusivity, quiet hours, Sabbath).
- **Readable:** every schedule change emits *why* breadcrumbs.
- **Adaptive:** buffers scale with uncertainty; priorities reflect urgency & perishability.

---

## 1) Buffers

### 1.1 Terminology

- **Estimate**: domain engine’s planned duration.
- **Soft buffer**: elastic time added to absorb typical variance. Can be squeezed by `autofit` strategies.
- **Hard buffer**: mandatory padding (safety/cooling, sanitation). **Never** squeezed.
- **ETA drift**: `eta.end - planned.end`.

### 1.2 Buffer formula (per session)

plannedDuration = estimate
softBuffer = max(minSoft(domain, band), round(estimate * bFactor(domain, band)))
hardBuffer = Σ mandatory(domain, method, equipment)
scheduledBlock = plannedDuration + softBuffer + hardBuffer

pgsql
Copy code

- `band ∈ {P0,P1,P2,P3}` (priority band; see §2).
- Default `bFactor` and `minSoft` are domain- and band-specific.

### 1.3 Default soft buffer policy

| Domain         | P0 (critical) | P1 (high) | P2 (normal) | P3 (low) |
|---|---:|---:|---:|---:|
| **Cooking**        | max(5m, 10%)  | max(7m, 12%) | max(10m, 15%) | max(12m, 18%) |
| **Cleaning**       | max(3m, 8%)   | max(5m, 10%) | max(7m, 12%)  | max(10m, 15%) |
| **Garden**         | max(5m, 10%)  | max(7m, 12%) | max(10m, 15%) | max(12m, 18%) |
| **Animals**        | max(8m, 12%)  | max(10m, 15%)| max(12m, 18%) | max(15m, 20%) |
| **Storehouse**     | max(2m, 5%)   | max(3m, 7%)  | max(5m, 10%)  | max(7m, 12%)  |
| **Preservation**   | max(10m, 15%) | max(12m, 18%)| max(15m, 20%) | max(20m, 25%) |

> The **ETA worker** may dynamically inflate soft buffers if repeated overruns are observed (see §4 Control).

### 1.4 Default hard buffer policy (non-negotiable)

- **Cooking**: 5m sanitation between distinct meat/non-meat sessions; 10m when switching raw poultry → any other.
- **Animals/Butchery**: 15m sanitation, 10m safety briefing at start, 15m cleanup at end.
- **Preservation**: method-specific passive stages (cooling, resting) added as hard buffer blocks.
- **Garden**: 5m tool clean-down when switching zones (indoor ↔ outdoor).
- **Storehouse**: none by default.

> Hard buffers are modeled as **child tasks** with `status="locked"` and appear in the plan timeline.

---

## 2) Priority

### 2.1 Bands

- **P0 Critical** — safety or immediate spoilage risk (e.g., pressure canner in process). Never deferred; can *preempt* P2–P3.
- **P1 High** — same-day perishables, time-sensitive visitors, booked equipment windows.
- **P2 Normal** — routine sessions.
- **P3 Low** — nice-to-have, long horizon.

### 2.2 Default band mapping

| Trigger / attribute | Band | Notes |
|---|---|---|
| Active safety device (pressure canner, meat processing underway) | **P0** | Locks resource; emits `resource.locked` |
| Item expiring ≤ 24h / thawed perishables | **P1** | Elevates cooking/preservation |
| Conflicts with external booking (community kitchen slot) | **P1** | Window is fixed |
| Routine cleaning/garden care | **P2** | Deferrable within week window |
| Batch stock rotation / wishlist tasks | **P3** | Deferable |

### 2.3 Priority change events

- Raise band: `priority.raised` with `{ from, to, reason }`.
- Lower band: `priority.lowered` (only via user or after SLA recovery).
- Reschedule suggestion uses stronger bands first (P0>P1>P2>P3).

---

## 3) Constraints

### 3.1 Hard constraints (never violated)

- **Quiet hours** (from feature flags): no noisy devices; sessions auto-deferred unless P0 safety.
- **Sabbath guard**: blocks non-safety labor between configured `startHint`/`endHint`.
- **Exclusive resources**: device/person/space cannot double-book.
- **Inventory availability**: cannot execute if required items are short; auto-emit `inventory.shortage.detected`.

### 3.2 Soft constraints (negotiable with UI consent)

- **Preferred person/device** unavailable → propose reassign.
- **Adjacency**: try to cluster by location to reduce context switch penalty; may be relaxed by `autofit`.

### 3.3 Constraint declaration shape

```json
{
  "type": "schedule.constraint.declared",
  "ts": "...",
  "source": "planner",
  "data": {
    "sessionId": "sess_1",
    "kind": "quietHours|sabbath|exclusive|inventory|adjacency",
    "hard": true,
    "details": { "fromISO": "...", "toISO": "...", "resourceId": "oven-1" }
  }
}
4) Control (drift, overruns, autofit)
4.1 ETA & drift thresholds
Minute tick recomputes ETA; if |drift| ≥ 5m → emit suggested schedule.reschedule_item with reason eta.drift.

Soft buffer can expand up to +50% of its original value automatically when:

2 consecutive ticks show growing drift and

Session remains within SLO (no hard breach).

4.2 Overrun detection
overrun when elapsed > estimate + softBuffer.

At first overrun:

Mark flags.risk="amber", show RiskActionsStrip with:

Extend +5m, Autofit window, Split remainder, Pause after task.

Emit schedule.overrun.detected.

At second consecutive overrun tick:

For P2/P3 → auto-emit schedule.autofit (defer_low_priority).

For P0/P1 → ask user; never auto-defer.

4.3 Autofit strategy precedence
resolve_resource_overlap

compress_neighbors (squeeze soft buffers only)

defer_low_priority (push P3 → next free window within horizon)

expand_buffers (for preservation methods when p90>target)

Strategies combine with | in the command string and are applied in the above order.

5) Gate policies (quiet hours, Sabbath, conflicts)
5.1 Quiet hours
Default from feature flags quietHours: [22,7] (local).

Allowed during quiet hours:

P0 safety sessions.

Silent tasks (planning, storehouse bookkeeping).

Violations produce schedule.policy.blocked with mitigation options:

move_to_morning, split, reassign_device.

5.2 Sabbath guard
Blocks any non-safety domain work within hint window.

Allowed: cooling, passive preservation, animal emergency care (tagged safety=true).

UI provides override modal; override emits policy.override.requested and, if approved, policy.override.applied.

5.3 Resource conflicts
Detection window (look-ahead) defaults to 10 minutes; conflicts emit schedule.resource.conflict.

Resolution order:

Reassign P2/P3 to free equivalent resource.

Nudge later/earlier by available soft buffer slack.

If still blocked, raise conflict to UI with ResourceConflictModal.

6) Inventory & perishability policies
Must-have ingredients missing → block execution; emit inventory.shortage.detected.

Substitutable ingredients (declared by intelligence) → allow with flags.substituted=true.

Perishability raises priority:

expires ≤ 24h → promote session to P1.

thawed and not cooked within 24h → issue reminder + P1 escalation.

7) Domain-specific notes
Cooking
Hard: sanitation gaps as per §1.4.

Soft: can be compressed by max 50% under compress_neighbors.

Split allowed at task boundaries (prep/cook/plate).

Preservation
Hard passive stages (cooling, resting) are separate locked child tasks.

expand_buffers preferred over defer_low_priority once heating has begun.

Animals
Minimum 2 persons for butchery if carcass weight ≥ threshold; otherwise block.

Safety briefings are hard buffers and set risk="red" if skipped.

Garden
Weather/Daylight constraints optional (future), modeled as hard window bounds when enabled.

Storehouse
Noisy operations (bulk sealing) abide by quiet hours unless P1 spoilage.

8) Priority & buffer changes — event contracts
json
Copy code
{
  "type": "priority.raised",
  "ts": "...",
  "source": "runtime.guard",
  "data": { "sessionId": "sess_1", "from": "P2", "to": "P1", "reason": "perishability.24h" }
}
json
Copy code
{
  "type": "buffer.adjusted",
  "ts": "...",
  "source": "worker.eta",
  "data": { "sessionId": "sess_1", "softBufferDeltaMs": 300000, "reason": "eta.volatility" }
}
9) Planner acceptance rules
When a command targets the plan, the automation bridge accepts it iff:

Event envelope is valid.

Hard constraints remain satisfied after applying the change.

Priority preemption matrix allows the move:

From\To	P0	P1	P2	P3
P0	✓	✓	✓	✓
P1	✕	✓	✓	✓
P2	✕	✕	✓	✓
P3	✕	✕	✕	✓

✕ means target cannot displace a higher band unless user explicitly confirms.

10) Breadcrumbs (explainability)
Every recompute must include a recalculation.reason and list deltas:

json
Copy code
{
  "type": "schedule.plan.recomputed",
  "ts": "...",
  "source": "bridge.automationRuntime",
  "data": {
    "recalculation": {
      "reason": "schedule.autofit",
      "meta": { "strategies": "compress_neighbors|defer_low_priority", "modelVersion": "mv_2025-11-09.1" },
      "deltas": [
        { "sessionId": "sess_A", "movedByMs": 600000, "why": "eta.drift" },
        { "sessionId": "sess_B", "device": "oven-1→oven-2", "why": "resolve_resource_overlap" }
      ]
    }
  }
}
UI surfaces this via PlanBreadcrumbs.

11) Learning hooks
Nightly calibration may adjust:

bFactor(domain, band) soft buffer multipliers.

Default band mapping thresholds (e.g., perishability cutoff).

Changes propagate by calibration.model.update and bump modelVersion.

12) Policy evaluation order (compile → gate → control → learn)
Compile: estimate + default buffers + base band → draft blocks.

Gate: enforce hard constraints; apply soft prefs; detect conflicts/shortages.

Control: minute-tick ETA; suggest reschedules; apply autofit if authorized.

Learn: nightly metrics update multipliers and thresholds.

13) Quick reference (config touchpoints)
src/config/featureFlags.json — quiet hours, Sabbath, worker toggles.

src/config/slo.sla.json — adherence & overrun objectives; corrective actions.

src/workers/eta.worker.js — drift thresholds & buffer.adjusted.

src/integrations/automationRuntime.bridge.js — accepts/rejects plan changes.

src/ui/components/scheduling/* — risk/health/conflict UX components.

14) Defaults you can tune safely
Soft buffer min minutes per domain/band.

ETA drift threshold (default 5 minutes).

Autofit precedence (order of strategies).

Quiet hours window; Sabbath hints.

Priority promotion rules for perishability and external bookings.

Changes are additive and should be versioned. Emit policy.changed with a diff when adjusting live systems.
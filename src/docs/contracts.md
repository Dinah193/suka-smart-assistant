# SSA Contracts — Schemas & Field Meanings

This document describes the **wire contracts** used inside Suka Smart Assistant (SSA). All modules (imports → intelligence → automation → (optional) hub export) exchange **normalized events** and **domain records** defined below.

> **Golden rule:** every event is `{ type, ts, source, data }` with an ISO timestamp, and must be safe to persist or replay.

---

## 0) Global Conventions

### 0.1 Event Envelope (required everywhere)

```jsonc
{
  "type": "string",        // machine-readable topic, e.g. "schedule.plan.recomputed"
  "ts": "ISO-8601",        // RFC 3339 timestamp, e.g. "2025-11-09T16:02:00-06:00"
  "source": "string",      // producer id, e.g. "ui.scheduling", "worker.eta"
  "data": {}               // schema-specific payload (see below)
}
Idempotency: Emitters should include a deterministic id inside data when possible (sessionId, conflictId, changeId).

Domains (enum): "cooking" | "cleaning" | "garden" | "animals" | "storehouse" | "preservation" | "general".

0.2 Identifiers & Time
sessionId, taskId, planId, conflictId, changeId: stable strings (UUID/ksuid/ulid allowed).

All absolute times use ISO-8601; avoid epoch numbers in payloads (use only internally).

Durations use *Ms (milliseconds) or *Min (minutes) as numbers.

0.3 Status Enums
Session.status: "planned" | "running" | "paused" | "done" | "skipped" | "failed".

Risk flag: "green" | "amber" | "red" (UI health badges, risk strip).

1) Scheduling & Plan
1.1 schedule.session.create (command)
jsonc
Copy code
{
  "type": "schedule.session.create",
  "ts": "...",
  "source": "ui.scheduling",
  "data": {
    "title": "Batch cook beans",
    "domain": "cooking",
    "startISO": "2025-11-10T12:00:00-06:00",
    "endISO": "2025-11-10T13:30:00-06:00",
    "resource": { "id": "oven-1", "type": "device", "name": "Kitchen Oven" }, // optional
    "people": ["Maya", "CJ"],          // optional
    "metadata": { "recipeId": "rec_123" } // free-form, small
  }
}
Notes: creating a session changes household plan. Bridges must emit schedule.plan.recomputed and may export to Hub (if enabled).

1.2 schedule.reschedule_item (command)
jsonc
Copy code
{
  "type": "schedule.reschedule_item",
  "ts": "...",
  "source": "worker.eta",
  "data": {
    "sessionId": "sess_abc",
    "domain": "cooking",
    "offsetMs": 600000,           // ± offset; alternative to absolute placement
    "absolute": {                 // optional alternative form
      "startISO": "2025-11-09T16:10:00Z",
      "endISO":   "2025-11-09T16:40:00Z"
    },
    "reason": "eta.drift",
    "etaISO": "2025-11-09T16:30:00Z" // hint for planner; optional
  }
}
1.3 schedule.autofit (command)
jsonc
Copy code
{
  "type": "schedule.autofit",
  "ts": "...",
  "source": "ui.scheduling",
  "data": {
    "window": { "start": "2025-11-09T00:00:00Z", "end": "2025-11-10T00:00:00Z" },
    "domain": "cooking", // or omit for all
    "strategy": "compress_neighbors|defer_low_priority|resolve_resource_overlap",
    "reason": "user.dashboard_autofit"
  }
}
Strategy string is a ‘|’-separated set of helpers understood by the runtime.

1.4 schedule.plan.recomputed (result)
jsonc
Copy code
{
  "type": "schedule.plan.recomputed",
  "ts": "...",
  "source": "bridge.automationRuntime",
  "data": {
    "planId": "plan_2025w45",
    "window": { "start": "2025-11-09T00:00:00Z", "end": "2025-11-16T00:00:00Z" },
    "affectedSessions": [
      {
        "id": "sess_abc",            // alias of sessionId for UI
        "sessionId": "sess_abc",
        "title": "Batch cook beans",
        "domain": "cooking",
        "startISO": "2025-11-09T16:10:00Z",
        "endISO": "2025-11-09T16:40:00Z",
        "status": "planned",
        "resource": { "id": "oven-1", "type": "device", "name": "Kitchen Oven" },
        "people": ["Maya"]
      }
    ],
    "recalculation": {
      "reason": "schedule.reschedule_item",
      "meta": { "modelVersion": "mv_2025-11-09.1" }
    },
    "meta": {
      "modelVersion": "mv_2025-11-09.1",
      "inventoryDeltas": [ /* see 3.1 */ ],
      "shortages": [ /* see 3.2 */ ]
    }
  }
}
2) Runtime & ETA
2.1 session.started / session.progress / session.completed
jsonc
Copy code
{
  "type": "session.progress",
  "ts": "...",
  "source": "runtime.executor",
  "data": {
    "sessionId": "sess_abc",
    "domain": "cooking",
    "totalElapsedMs": 1800000,
    "overrunMs": 300000,        // optional; >0 when late
    "bufferMs": 300000,         // optional soft buffer
    "tasks": [
      { "id": "t1", "label": "Soak", "estimateMin": 15, "elapsedMs": 900000, "status": "done" },
      { "id": "t2", "label": "Boil", "estimateMin": 30, "elapsedMs": 600000, "status": "running" }
    ]
  }
}
jsonc
Copy code
{
  "type": "session.completed",
  "ts": "...",
  "source": "runtime.executor",
  "data": {
    "sessionId": "sess_abc",
    "domain": "cooking",
    "startedAt": "2025-11-09T16:00:00Z",
    "completedAt": "2025-11-09T17:10:00Z",
    "estimateMin": 60,
    "actualMin": 70,
    "taskCount": 4
  }
}
2.2 eta.updated / eta.batch.updated (from minute-tick)
jsonc
Copy code
{
  "type": "eta.updated",
  "ts": "...",
  "source": "worker.eta",
  "data": {
    "sessionId": "sess_abc",
    "domain": "cooking",
    "remainingMs": 1800000,
    "etaISO": "2025-11-09T16:30:00Z",
    "confidence": 0.82,
    "cause": "minute_tick"
  }
}
Drift beyond policy may trigger a suggested schedule.reschedule_item.

3) Inventory & Shortages
3.1 inventory.updated (delta fan-out)
jsonc
Copy code
{
  "type": "inventory.updated",
  "ts": "...",
  "source": "bridge.automationRuntime",
  "data": {
    "deltas": [
      { "itemId": "sku_beans_pinto", "name": "Pinto Beans", "qty": -1, "unit": "can", "location": "pantry", "reason": "consumed" },
      { "itemId": "jar_tomatoes", "name": "Tomatoes, canned", "qty": -1, "unit": "jar", "location": "pantry", "reason": "consumed" }
    ]
  }
}
3.2 inventory.shortage.detected (planning signal)
jsonc
Copy code
{
  "type": "inventory.shortage.detected",
  "ts": "...",
  "source": "planner.stock",
  "data": {
    "items": [
      { "itemId": "sku_beans_pinto", "name": "Pinto Beans", "neededQty": 6, "unit": "can" }
    ]
  }
}
4) Imports → Intelligence
4.1 import.parsed (normalized import payload)
jsonc
Copy code
{
  "type": "import.parsed",
  "ts": "...",
  "source": "import.bookmarklet",
  "data": {
    "importId": "imp_abc",
    "domain": "meals",
    "title": "Hearty Pinto Beans",
    "ingredients": [
      { "name": "pinto beans", "qty": 1, "unit": "lb" },
      { "name": "onion", "qty": 1, "unit": "pc" }
    ],
    "methods": ["soak", "boil", "simmer"],
    "equipment": ["pot", "stovetop"],
    "seasonality": ["winter", "fall"],
    "links": [{ "rel": "source", "href": "https://example.com/beans" }],
    "intelligence": {
      "ingredientPatterns": ["legume", "base_aromatic"],
      "nutrition": { "protein_g": 20 },   // optional
      "timeEstimateMin": 60
    }
  }
}
Import processors should produce consistent field names so domain engines can map to sessions without per-site code.

5) Conflicts & Resolution
5.1 schedule.resource.conflict
jsonc
Copy code
{
  "type": "schedule.resource.conflict",
  "ts": "...",
  "source": "runtime.conflicts",
  "data": {
    "id": "conf:oven-1:2025-11-09T16",
    "domain": "cooking",
    "resource": { "id": "oven-1", "type": "device", "name": "Kitchen Oven" },
    "overlaps": [
      { "bookingId": "bk_1", "sessionId": "sess_A", "label": "Roast", "start": "2025-11-09T16:00:00Z", "end": "2025-11-09T17:00:00Z" },
      { "bookingId": "bk_2", "sessionId": "sess_B", "label": "Bake",  "start": "2025-11-09T16:30:00Z", "end": "2025-11-09T17:15:00Z" }
    ],
    "window": { "start": "2025-11-09T16:00:00Z", "end": "2025-11-09T17:30:00Z" }
  }
}
5.2 schedule.resource.resolution (command)
jsonc
Copy code
{
  "type": "schedule.resource.resolution",
  "ts": "...",
  "source": "ui.conflictResolver",
  "data": {
    "conflictId": "conf:oven-1:2025-11-09T16",
    "domain": "cooking",
    "resource": { "id": "oven-1" },
    "resolution": {
      "strategy": "move_later",      // "move_earlier" | "split" | "reassign_resource"
      "sessionId": "sess_B",
      "offsetMs": 1800000            // e.g. push 30m
    }
  }
}
The automation bridge applies the resolution via the planner and re-emits schedule.plan.recomputed.

6) Learning & Calibration
6.1 analytics.history.request/result
jsonc
Copy code
{
  "type": "analytics.history.result",
  "ts": "...",
  "source": "analytics.service",
  "data": {
    "runs": [
      { "domain": "cooking", "sessionId": "sess_1", "estimateMin": 60, "actualMin": 70, "completedAt": "..." }
    ]
  }
}
6.2 calibration.model.update
jsonc
Copy code
{
  "type": "calibration.model.update",
  "ts": "...",
  "source": "worker.calibration",
  "data": {
    "domain": "cooking",
    "strategy": "proportional_bias", // or "offset_minutes" | "quantile_fit"
    "params": { "factor": 0.12 },
    "metrics": { "bias": 0.12, "p90": 0.28, "sampleSize": 146 },
    "window": { "from": "2025-10-10T00:00:00Z", "to": "2025-11-09T00:00:00Z" },
    "reason": "nightly_learning"
  }
}
7) Optional Hub Export Envelopes
SSA owns data; only mirrored to Hub when familyFundMode=true.

7.1 hub.plan.snapshot
jsonc
Copy code
{
  "type": "hub.plan.snapshot",
  "ts": "...",
  "source": "bridge.hubExport",
  "data": {
    "planId": "plan_2025w45",
    "window": { "start": "...", "end": "..." },
    "modelVersion": "mv_2025-11-09.1",
    "reason": "plan_recomputed",
    "sessions": [
      { "sessionId": "sess_abc", "title": "Batch cook beans", "domain": "cooking", "startISO": "...", "endISO": "...", "status": "planned" }
    ]
  }
}
7.2 hub.actuals.session
jsonc
Copy code
{
  "type": "hub.actuals.session",
  "ts": "...",
  "source": "bridge.hubExport",
  "data": {
    "runId": "sess_abc:2025-11-09T17:10:00Z",
    "sessionId": "sess_abc",
    "domain": "cooking",
    "startedAt": "2025-11-09T16:00:00Z",
    "completedAt": "2025-11-09T17:10:00Z",
    "estimateMin": 60,
    "actualMin": 70,
    "taskCount": 4,
    "tasks": [ { "taskId": "t1", "label": "Soak", "estimateMin": 15, "actualMin": 15, "status": "done" } ]
  }
}
7.3 hub.inventory.delta / hub.shortage.alert
jsonc
Copy code
{
  "type": "hub.inventory.delta",
  "ts": "...",
  "source": "bridge.hubExport",
  "data": {
    "deltas": [ { "itemId": "sku_beans_pinto", "name": "Pinto Beans", "qty": -1, "unit": "can", "location": "pantry", "reason": "consumed" } ]
  }
}
8) UI-Facing Contract Snippets
8.1 Session (UI record)
jsonc
Copy code
{
  "id": "sess_abc",               // stable id for React keying
  "sessionId": "sess_abc",        // alias for bridges/runtimes
  "title": "Batch cook beans",
  "domain": "cooking",
  "startISO": "2025-11-09T16:10:00Z",
  "endISO": "2025-11-09T16:40:00Z",
  "resource": { "id": "oven-1", "type": "device", "name": "Kitchen Oven" },
  "people": ["Maya"],
  "status": "planned",
  "flags": { "risk": "amber", "overrunMs": 300000 } // optional
}
8.2 Conflict (UI record)
jsonc
Copy code
{
  "id": "conf:oven-1:slot",
  "domain": "cooking",
  "resource": { "id": "oven-1", "type": "device", "name": "Kitchen Oven" },
  "overlaps": [
    { "bookingId": "bk_1", "sessionId": "sess_A", "label": "Roast", "start": "...", "end": "..." },
    { "bookingId": "bk_2", "sessionId": "sess_B", "label": "Bake",  "start": "...", "end": "..." }
  ],
  "window": { "start": "...", "end": "..." }
}
9) Config Contracts (read-only at runtime)
9.1 featureFlags.json (selected keys)
jsonc
Copy code
{
  "familyFundMode": false,
  "telemetry": { "emitDebug": true },
  "scheduling": {
    "eta": { "minuteTickWorker": true, "rescheduleDriftMin": 5 }
  },
  "learning": { "nightlyCalibrationWorker": true, "nightlyHourLocal": 2 }
}
9.2 slo.sla.json (profile example)
jsonc
Copy code
{
  "key": "meals.cooking.session",
  "sla": { "p50StartToCompleteMinutes": 45, "p90StartToCompleteMinutes": 75 },
  "slo": { "scheduleAdherencePct": 0.92, "overrunRatePct": 0.18, "completionSuccessPct": 0.985 },
  "alertThresholds": { "overrunRatePct": { "warning": 0.22, "critical": 0.30 } }
}
10) Error & Telemetry
10.1 automation.command.failed
jsonc
Copy code
{
  "type": "automation.command.failed",
  "ts": "...",
  "source": "bridge.automationRuntime",
  "data": {
    "op": "schedule.reschedule_item",
    "error": "sessionId required",
    "sessionId": "sess_abc"
  }
}
10.2 telemetry.log
Produced by src/logging/structured.js. Fields:

jsonc
Copy code
{
  "ts": "...",
  "level": "info|warn|error|debug",
  "message": "string",
  "source": "string",
  "sessionId": "string?",
  "stepId": "string?",
  "planId": "string?",
  "modelVersion": "string?",
  "requestId": "string?",
  "domain": "string?",
  "tags": { },
  "data": { }          // redacted payload snapshot
}
11) Validation Hints
Required: Event envelope keys (type, ts, source, data).

Time: validate ts and any *ISO with RFC 3339 parser.

Enum checks: domain, status, strategy tokens.

Numeric sanity: negative durations only where explicitly allowed (offsetMs may be negative).

Size limits: metadata, tags should be small (<2 KB).

12) Backwards Compatibility
Additive changes only: append fields, avoid renames.

If a field’s meaning changes, introduce a new field (e.g., plannedEndISO) and deprecate the old one behind a flag.

Use meta.modelVersion on schedule.plan.recomputed to correlate with calibration.

Appendix A — Minimal JSON Schemas (abridged)
Not full JSON Schema Draft, but close enough for validators.

json
Copy code
{
  "$id": "ssa.event",
  "type": "object",
  "required": ["type", "ts", "source", "data"],
  "properties": {
    "type": { "type": "string", "minLength": 1 },
    "ts":   { "type": "string", "format": "date-time" },
    "source": { "type": "string", "minLength": 1 },
    "data": { "type": "object" }
  },
  "additionalProperties": false
}
json
Copy code
{
  "$id": "ssa.session",
  "type": "object",
  "required": ["sessionId", "title", "domain", "startISO", "endISO"],
  "properties": {
    "sessionId": { "type": "string" },
    "title": { "type": "string" },
    "domain": { "enum": ["cooking","cleaning","garden","animals","storehouse","preservation","general"] },
    "startISO": { "type": "string", "format": "date-time" },
    "endISO": { "type": "string", "format": "date-time" },
    "status": { "enum": ["planned","running","paused","done","skipped","failed"] }
  }
}
Contact points in code:

Bridges: src/integrations/automationRuntime.bridge.js, src/integrations/hubExport.bridge.js

Workers: src/workers/eta.worker.js, src/workers/calibration.worker.js

UI: src/ui/pages/scheduling/index.jsx, src/ui/pages/scheduling/history.jsx, src/ui/components/scheduling/*

Config: src/config/featureFlags.json, src/config/slo.sla.json

Logging: src/logging/structured.js

This contract is stable for W45 2025 builds. New fields will be additive and guarded by feature flags when appropriate.
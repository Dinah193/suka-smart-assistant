# `src/services/session/` — Usage Notes & Examples

Lightweight, event-driven session utilities for Suka Smart Assistant. These helpers power **start / resume / pause / end** flows, pause-aware timers, scheduler ticks aligned to **session start (not wall clock)**, and developer-friendly debug surfacing.

> Key ideas  
> • Session time is **effective time** = `now - startedAt - sum(pauses)`  
> • Reminders & timers **attach to a running session** (marinate / proof / rest)  
> • Signals flow over a small **eventBus** with domain-aware payloads

---

## Folder Map

- `utils/timeMath.js` — ms helpers, humanize, pause-aware progress, ETA, tick alignment
- `utils/scheduleDebug.js` — URL/LS toggles, levels, ring buffer, event auto-logging
- `utils/offsetParser.js` — parses `+20m` / `PT1H` / `90m` (optional, defensive import)
- `policies/pausePolicies.js` — withhold / safety / Sabbath-aware checks
- `guards/inventoryGuard.js` — ensure items on hand (domain-aware)
- `PrepSessionOrchestrator.js` — glue: start/resume/pause/end, step stream, ticks

> All imports are **defensive**; missing modules degrade gracefully.

---

## Quickstart

### Start a session

```js
import { remainingProgress } from "@/services/session/utils/timeMath";
import { withDomain } from "@/services/session/utils/scheduleDebug";
let eventBus = require("@/services/events/eventBus")?.eventBus || { emit() {} };

const dbg = withDomain("sessions");

export function startCookingSession({ id, target = "45m" }) {
  const startedAt = Date.now();
  const snap = remainingProgress({ startTs: startedAt, durationMs: target });
  const session = { id, startedAt, targetMs: snap.durationMs, pauses: [] };

  eventBus.emit("session.started", {
    id,
    domain: "meals",
    startedAt,
    targetMs: session.targetMs,
  });
  dbg.info("started", session);
  return session;
}
```

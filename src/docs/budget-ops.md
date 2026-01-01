# SSA Budget & Telemetry Guide  
_File: `src/docs/budget-ops.md`_

This document explains how to **tune SSA’s AI + automation budgets** and how to
**interpret telemetry** so Suka Smart Assistant stays fast, affordable, and
predictable even while running long-lived Sessions and Reasoner shims.

It assumes the new stack:

- **Shim Modules** instead of monolithic agents,
- **Orchestrator Modes** (`orchestrator.modes.json`),
- **Reasoner Policy** (`reasoner.policy.json`),
- **SessionRunner** + Dexie sessions store,
- Event bus envelopes `{ type, ts, source, data }`.

---

## 1. What “Budget” Means in SSA

When we say “budget” in SSA, we’re talking about a few different but related
things:

1. **AI / Reasoner cost**
   - Model choice (cheap vs powerful),
   - Max prompt tokens + max completion tokens,
   - Number of follow-ups or multi-step calls.

2. **Runtime / Session cost**
   - How long Sessions run (timers, Web Workers),
   - Frequency of checkpoints in Dexie,
   - How often we call external services (weather, coupons, etc.).

3. **Data freshness cost**
   - How aggressively we re-fetch:
     - weather, circulars, price data, coupons, store layouts, inventory syncs,
   - Controlled by TTLs in `freshness.policy.json`.

4. **User experience cost**
   - How “chatty” the system is (toasts, notifications, voice),
   - How much work is pre-computed vs on-demand.

The goal is to **balance**:

- _Accuracy_ (good suggestions / plans),
- _Responsiveness_ (fast enough for the user),
- _Cost_ (API usage + resource usage),
- _Resilience_ (still works when offline or constrained).

---

## 2. Where Budgets Are Controlled

There are three main config surfaces:

1. `src/config/reasoner.policy.json`  
   → **Model, tokens, follow-ups** per mode.

2. `src/config/orchestrator.modes.json`  
   → **Which pipelines run** for each mode + high-level behavior.

3. `src/config/freshness.policy.json`  
   → **TTL policy** for data feeds (weather, coupons, prices, etc.).

Together, they define a **budget envelope** for:

- Each Reasoner mode (e.g. `cooking.composeSession`),
- Each external dataset (e.g. `weather.hourly`),
- The automation runtimes (how often certain events fire / recompute).

---

## 3. Reasoner Budget Tuning

### 3.1 `reasoner.policy.json` — the Main Knobs

The reasoner policy defines:

- Default model and token bounds,
- Per-mode overrides,
- Follow-up limits.

Example (simplified):

```jsonc
{
  "defaults": {
    "model": "gpt-4.1-mini",
    "maxPromptTokens": 3200,
    "maxCompletionTokens": 1200,
    "maxFollowUps": 0
  },
  "modes": {
    "cooking.composeSession": {
      "model": "gpt-4.1",
      "maxPromptTokens": 6000,
      "maxCompletionTokens": 2000,
      "maxFollowUps": 1
    },
    "shopping.consolidateList": {
      "model": "gpt-4.1-mini",
      "maxPromptTokens": 3000,
      "maxCompletionTokens": 900,
      "maxFollowUps": 0
    }
  }
}
Adjusting cost:

To save money, move a mode from a larger model to a smaller one, or
reduce maxCompletionTokens.

To improve quality, consider:

Upgrading the model for that mode only,

Allowing maxFollowUps: 1 so the orchestrator can “self-correct.”

Tip: Keep maxPromptTokens realistic. Huge prompt limits encourage poor
discipline upstream—better to trim inputs / context before the Reasoner.

3.2 Per-Mode Strategy Examples
High-value planning (cooking, storehouse, butchery)

Use a more capable model (gpt-4-class tier),

Allow 1 follow-up if schemas are complex,

Longer completions for rich step metadata.

Routine clean-up & consolidation (shopping lists, minor suggestions)

Use cheaper models,

Smaller completions,

No follow-ups.

Background / cron-like tasks

Consider shorter completions + heavily constrained schemas
to avoid chatty outputs.

4. Orchestrator Modes & Pipelines
4.1 orchestrator.modes.json — Budget via Behavior
The orchestrator config defines:

Which skill is used,

Which schemas apply (input/output),

How many steps and follow-ups are allowed,

Which guard pipelines run before or after the Reasoner.

Example:

jsonc
Copy code
{
  "modes": {
    "cooking.composeSession": {
      "description": "Compose a structured Session for cooking from a recipe.",
      "inputSchema": "schemas/skills/cooking.composeSession.input.json",
      "outputSchema": "schemas/skills/cooking.composeSession.output.json",
      "maxSteps": 1,
      "allowFollowUps": true,
      "guardPipelines": ["sabbath", "quietHours", "inventory"]
    },
    "shopping.consolidateList": {
      "description": "Merge multiple input lists into a store-aware shopping list.",
      "inputSchema": "schemas/skills/shopping.consolidateList.input.json",
      "outputSchema": "schemas/skills/shopping.consolidateList.output.json",
      "maxSteps": 1,
      "allowFollowUps": false,
      "guardPipelines": ["inventory"]
    }
  }
}
Budget implications:

maxSteps: How many internal “agent steps” the orchestrator will run.

More steps = more tokens & latency.

allowFollowUps: Enables the Reasoner to call itself again (chain-of-thought style).

Great for quality in complex tasks – but use sparingly.

guardPipelines: Each guard may perform checks (weather, inventory, calendar).

Keep the list tight to avoid unnecessary data fetches.

5. Data Freshness Budget
5.1 freshness.policy.json — TTLs for External Data
This file defines how long SSA treats data as “fresh” before reloading:

Weather data,

Store circulars / coupons,

Pricebook / cost-per-unit data,

Inventory snapshots from external sources.

Example:

jsonc
Copy code
{
  "$schema": "./schemas/config/freshness.policy.schema.json",
  "version": 1,
  "defaults": {
    "ttlMs": 3600000
  },
  "datasets": {
    "weather.current": {
      "ttlMs": 300000,
      "maxStaleMs": 900000
    },
    "weather.hourly": {
      "ttlMs": 1800000,
      "maxStaleMs": 3600000
    },
    "circulars.weekly": {
      "ttlMs": 86400000,
      "maxStaleMs": 172800000
    },
    "pricebook.grocery": {
      "ttlMs": 604800000,
      "maxStaleMs": 1209600000
    },
    "coupons.manufacturer": {
      "ttlMs": 259200000,
      "maxStaleMs": 604800000
    }
  }
}
Definitions:

ttlMs — Time-to-live: within this window, data is considered fresh and
re-used without re-fetching.

maxStaleMs — Soft deadline: beyond this window, consumers should either:

Force a refresh, or

Display a “stale data” warning in UI.

Budget tradeoffs:

Shorter TTL → fresher data but more network/API usage.

Longer TTL → lower cost but risk of stale insights.

Guideline: Make TTLs align with real-world data patterns.

Weather: minutes to 1 hour.

Circulars: 1–7 days.

Coupons: a few days.

Stable reference data (store aisles, layout): weeks or longer.

6. SessionRunner & Runtime Budget
The SessionRunner itself imposes a runtime budget:

Checkpoints written:

After every step change (session.step.changed),

Every ~10s while running (session.checkpoint.written).

Timers run in a Web Worker so they survive:

Tab switches,

Light navigation,

Minor CPU contention.

Things you can tune (in code or config):

Checkpoint frequency

10s is a reasonable default: responsive resume, minimal overhead.

For ultra-light sessions (short cleaning bursts), you might relax to 20–30s.

Voice guidance & TTS usage

Controlled by session.prefs.voiceGuidance.

Frequent TTS calls can be noisy—good UX but “expensive” in attention.

Toast verbosity

ToastBus currently fires on:

session.started, session.step.changed, session.paused,
session.resumed, session.completed, session.aborted,
session.exported.

If Sessions feel “too chatty,” consider reducing toast triggers.

Notification usage

Background notifications are budgeted by:

Frequency of step changes,

Whether you send intermediate notifications for each small step.

7. Telemetry: What to Watch
SSA is event-driven, so most telemetry will be:

Events on eventBus,

Dexie analytics in the sessions store,

Optional Hub export for family-level insights.

7.1 Core Event Streams
Key event types to watch:

Reasoner

reasoner.invoked

reasoner.completed

reasoner.error

Session lifecycle

session.started

session.step.changed

session.paused

session.resumed

session.completed

session.aborted

session.checkpoint.written

session.warning

session.error

session.exported

Import & inventory

import.parsed

inventory.updated

inventory.shortage.detected

These can be:

Logged in the console during development,

Stored in Dexie for local inspection,

Exported to the Hub when familyFundMode === true.

7.2 Reading Session Analytics
Each Session object has:

js
Copy code
analytics: {
  skippedSteps: string[],
  adjustments: any[]
}
You can interpret these as:

User behavior:

Lots of skipped steps → Routine may be too detailed / unrealistic.

Plan quality:

Many manual adjustments → Reasoner outputs or domain defaults may need tuning.

Timing accuracy:

Compare progress.elapsedSec vs sum of steps[].durationSec to see how
realistic time estimates are.

When a Session completes or aborts:

The runner should persist an analytics record,

Emit session.completed or session.aborted,

Optionally call exportToHubIfEnabled().

8. Common Budget Symptoms & Fixes
8.1 “The app feels slow when planning meals / shopping / butchery.”
Likely causes:

Big models with large maxPromptTokens and maxCompletionTokens,

Multi-step orchestrator modes with follow-ups,

Overly broad input (too many recipes or items in one call).

Adjustments:

For heavy modes (like cooking.composeSession):

Trim input context,

Enforce smaller completion size and offload details to a second mode if needed.

Split tasks:

E.g., first a “rough plan” (cheap mode), then a “detail refinement” only if the user clicks an “Enhance” button.

8.2 “We’re hitting budget limits for AI usage.”
Likely causes:

Frequent automatic Reasoner calls on every page load,

Aggressive TTLs causing repeated fetch + re-planning.

Adjustments:

Increase TTLs in freshness.policy.json for non-critical data.

Move some Reasoner calls behind explicit user actions (“Plan Now”).

Ensure modes that run in the background use:

Cheaper models,

Small completion size,

No follow-ups.

8.3 “Session toasts & notifications are overwhelming.”
Likely causes:

ToastBus maps many lifecycle events directly to user-facing toasts.

Notification layer mirrors the same events.

Adjustments:

Update the toast mapping function so:

Only session.started, session.paused, session.completed,
and major step changes produce toasts.

Consider grouping micro-steps into “phases” and only toast on phase change.

9. Planned: Budget & Runtime Swap Modal (Dev Tool)
As the shim architecture stabilizes, SSA can add a Swap Runtime / “Budget
Tuner” modal at the app root (similar to the SessionRunner mount):

Use a root-level portal to show:

Current reasoner mode → model mapping,

Current budget envelope (token / follow-up limits),

Live event counts (how many reasoner.invoked, session.started, etc.).

Emit events like:

reasoner.swap.request — user/dev asks to switch a mode’s model or caps.

reasoner.swap.applied — system confirms swap and logs changes.

Although this modal is not required for production users, it’s useful for:

Local development,

Performance testing,

A/B-style tuning for budgets without editing JSON manually.

Because shims funnel all Reasoner calls through the orchestrator, it’s easy to
build a “switch” UI that overrides the config in-memory while leaving files
alone.

10. Operational Checklist
When you notice performance, cost, or UX issues:

Check telemetry first

Are there spikes in reasoner.invoked events?

Are Sessions taking far longer than expected?

Are guards being hit repeatedly (e.g., sabbath or inventory)?

Inspect configs

reasoner.policy.json: Are models / tokens too generous?

orchestrator.modes.json: Are modes doing multi-step heavy work by default?

freshness.policy.json: Are TTLs much shorter than needed?

Adjust, then re-observe

Make small, per-mode changes, deploy, and watch telemetry.

Prefer mode-specific overrides over editing defaults first.

Refine session design

If Sessions are bloated:

Shrink tasks into smaller routines,

Allow the user to pick detail levels.

Document decisions

Update this file or a local “Ops Log” noting:

What changed,

Why,

What you observed after the change.

11. Summary
Budgets in SSA are controlled by:

reasoner.policy.json (model & tokens),

orchestrator.modes.json (session/skill behavior),

freshness.policy.json (data TTLs).

Telemetry is driven by canonical events and Dexie analytics:

reasoner.*, session.*, inventory.*, etc.

Tuning is iterative:

Adjust per-mode policies,

Adjust TTLs,

Simplify sessions or guard pipelines when needed.

The architecture is designed so you can:

Keep Sessions resilient and background-friendly,

Stay within resource budgets,

Still deliver rich, guided automation for cooking, cleaning, garden,
animals, preservation, and storehouse domains.

Use this doc as your reference when tweaking cost, performance, and noise
levels across Suka Smart Assistant.
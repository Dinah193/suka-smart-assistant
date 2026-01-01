# SSA Agents – Modes Output Schemas

This document defines **request/response schemas** for each `modes` intent used by
the Suka Smart Assistant (SSA) Reasoner / Orchestrator.

It’s meant to be the **single source of truth** for:
- What each intent expects as input.
- What each intent returns as output.
- How Session-related modes interact with guards, context, and the SessionRunner UI
  (including the “swap / pick a session” modal for the “Now” button UX).

> **Note:** All timestamps are ISO 8601 strings in UTC unless noted otherwise.
> All examples use `jsonc` (JSON-with-comments) for readability.

---

## 1. Common Types

These core shapes are reused across multiple modes.

### 1.1 `Session`

This is the **canonical session object contract** used by the SessionRunner and all session-related modes.

```jsonc
{
  "id": "string",                            // stable session id (uuid or similar)
  "domain": "cooking | cleaning | garden | animals | preservation | storehouse",
  "title": "string",

  "source": {
    "type": "recipe | cleaningPlan | gardenPlan | animalTask | import | manual",
    "refId": "string | null"                 // foreign key into recipes/plans/etc.
  },

  "steps": [
    {
      "id": "string",
      "title": "string",
      "desc": "string",
      "durationSec": 0,                      // integer seconds, 0 = unknown / open-ended
      "blockers": [
        "inventory",
        "weather",
        "quietHours",
        "sabbath",
        "equipment"
      ],
      "metadata": {
        "tempTargetF": 0,                    // 0 when not applicable
        "donenessCue": "color | texture | probeTemp | timer | smell | null",
        "cueNotes": "string"
      }
    }
  ],

  "prefs": {
    "voiceGuidance": true,
    "haptic": true,
    "autoAdvance": false
  },

  "status": "pending | running | paused | completed | aborted",

  "progress": {
    "currentStepIndex": 0,                  // integer; -1 allowed when no steps
    "elapsedSec": 0,
    "startedAt": "ISO-8601 | null",
    "pausedAt": "ISO-8601 | null"
  },

  "analytics": {
    "skippedSteps": [ "stepId-1", "stepId-2" ],
    "adjustments": [
      {
        "stepId": "string",
        "type": "time|temp|substitution|note",
        "from": "any",
        "to": "any",
        "reason": "string | null",
        "at": "ISO-8601"
      }
    ]
  },

  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
1.2 GuardResult
Result from a single guard (Sabbath, quiet hours, weather, inventory, battery).

jsonc
Copy code
{
  "guardId": "string",                       // e.g. "sabbath", "quietHours"
  "ok": true,                                // overall result
  "severity": "info | warning | hard-block",
  "reasonCode": "string",                    // e.g. "within-sabbath-window"
  "message": "string",                       // human-readable summary
  "details": {                               // guard-specific payload
    "start": "ISO-8601 | null",
    "end": "ISO-8601 | null",
    "metadata": {}
  },
  "suggestedAction": "proceed | reschedule | require-user-confirmation",
  "checkedAt": "ISO-8601"
}
1.3 GuardSummary (aggregate)
Returned by session.guards.evaluate and reused by some other modes.

jsonc
Copy code
{
  "okToStart": true,                         // true only if all blocking guards passed
  "hasWarnings": false,                      // true if there are soft warnings
  "blockingGuards": [ "sabbath", "inventory" ],
  "warningGuards": [ "battery" ],
  "results": GuardResult[],                  // one per guard
  "checkedAt": "ISO-8601"
}
1.4 SwapModalDescriptor (Session “Now” selector)
Used by session.now.resolve to drive the UI for the “swap / choose session” modal
that can stay active while navigation occurs.

jsonc
Copy code
{
  "title": "string",                         // e.g. "Pick a session to run now"
  "subtitle": "string | null",              // e.g. "Based on your current guard checks"
  "mode": "single | multi",                 // "single" = only one candidate; "multi" = show list
  "domain": "cooking | cleaning | garden | animals | preservation | storehouse",

  "candidates": [
    {
      "sessionId": "string",
      "title": "string",
      "domain": "cooking | cleaning | ...",
      "estimatedDurationSec": 0,
      "nextStepTitle": "string | null",
      "guardStatus": {
        "okToStart": true,
        "hasWarnings": false,
        "blockingGuards": [ "string" ],
        "warningGuards": [ "string" ]
      },
      "badges": [
        "guarded",
        "inventory-ok",
        "indoor",
        "weather-safe",
        "low-noise"
      ],
      "hint": "string | null"               // e.g. "Best fit for current weather and time"
    }
  ],

  "uiHints": {
    "primaryActionLabel": "string",         // e.g. "Start Session"
    "secondaryActionLabel": "string",       // e.g. "View Details"
    "allowBackgroundRun": true,             // indicates SessionRunner supports background
    "allowMiniWindow": true                 // indicates Doc Picture-in-Picture is allowed
  }
}
The UI can:

Use mode: "single" to show a confirmation panel before starting,

Use mode: "multi" to show a list with radio buttons/cards where
the user can pick one before launching the SessionRunner.

2. session.compose.* Modes
All domain-specific session composition modes share the same input/output shape.
The id (intent) is what distinguishes which domain rules to apply.

2.1 Common request/response shape
Intent IDs:

session.compose.cooking

session.compose.cleaning

session.compose.garden

session.compose.animals

session.compose.preservation

session.compose.storehouse

Request schema
jsonc
Copy code
{
  "intent": "session.compose.cooking",       // or any of the other compose intents
  "domain": "cooking",                       // must match the intent
  "source": {
    "type": "recipe | cleaningPlan | gardenPlan | animalTask | import | manual",
    "refId": "string | null"                // id used to fetch from Dexie/remote
  },

  "seed": {                                  // domain-specific raw input
    "title": "string",
    "description": "string",
    "steps": any[],                          // domain-specific raw steps
    "metadata": {}                           // domain-specific metadata
  },

  "prefs": {
    "voiceGuidance": true,                   // optional overrides, will be merged w/ defaults
    "haptic": true,
    "autoAdvance": false
  },

  "guardsContext": {                         // optional; can be empty
    "householdTimeZone": "string | null",
    "location": {
      "lat": 0,
      "lng": 0
    },
    "inventorySnapshotId": "string | null",
    "weatherSnapshotId": "string | null"
  },

  "requestId": "string | null",              // for telemetry / idempotency
  "requestedAt": "ISO-8601"
}
Response schema
jsonc
Copy code
{
  "ok": true,                                // false if composition failed entirely
  "intent": "session.compose.cooking",
  "domain": "cooking",

  "session": Session,                        // fully composed session object

  "guardHints": {                            // lightweight hints, BEFORE full guard pass
    "possibleBlockers": [ "inventory", "weather" ],
    "notes": "string | null"
  },

  "warnings": [                              // non-fatal issues
    {
      "code": "missing-duration",
      "message": "Some steps have unknown duration."
    }
  ],

  "debug": {                                 // optional, safe to ignore
    "version": "string",
    "compositionGraph": any
  }
}
If ok === false, session MAY be null, and warnings / additional error
fields may be provided by the implementation.

3. session.guards.evaluate
Aggregate guard evaluation for a candidate session.

Request schema
jsonc
Copy code
{
  "intent": "session.guards.evaluate",
  "session": Session,
  "context": {
    "now": "ISO-8601",
    "householdTimeZone": "string | null",
    "location": {
      "lat": 0,
      "lng": 0
    },
    "inventorySnapshotId": "string | null",
    "weatherSnapshotId": "string | null",
    "device": {
      "batteryLevel": 0.72,                 // 0–1
      "charging": true,
      "platform": "web | android | ios | desktop"
    }
  },
  "requestId": "string | null"
}
Response schema
jsonc
Copy code
{
  "ok": true,                                // okToStart? (alias for summary.okToStart)
  "intent": "session.guards.evaluate",
  "sessionId": "string",
  "summary": GuardSummary,                   // aggregate view
  "guards": GuardResult[],                   // one per guard (sabbath, weather, etc.)

  "recommendedAction": "proceed | reschedule | require-user-confirmation",

  "debug": {
    "checkedAt": "ISO-8601",
    "contextUsed": {
      "inventorySnapshotId": "string | null",
      "weatherSnapshotId": "string | null"
    }
  }
}
4. Individual Guard Modes
These can be called directly when you just need one guard.
They’re also orchestrated by session.guards.evaluate.

4.1 guards.sabbath.check
Request
jsonc
Copy code
{
  "intent": "guards.sabbath.check",
  "session": Session,
  "context": {
    "now": "ISO-8601",
    "householdTimeZone": "string | null",
    "sunsetTimes": {
      "prev": "ISO-8601 | null",
      "next": "ISO-8601 | null"
    },
    "hebrewCalendar": {
      "isSabbath": true,
      "sabbathStart": "ISO-8601",
      "sabbathEnd": "ISO-8601"
    }
  }
}
Response
jsonc
Copy code
{
  "ok": false,
  "guard": GuardResult                       // guardId MUST be "sabbath"
}
4.2 guards.quietHours.check
Request
jsonc
Copy code
{
  "intent": "guards.quietHours.check",
  "session": Session,
  "context": {
    "now": "ISO-8601",
    "householdTimeZone": "string | null",
    "quietHours": {
      "enabled": true,
      "start": "HH:mm",                      // local time
      "end": "HH:mm",
      "exceptions": [ "date-string", "ISO-8601" ]
    }
  }
}
Response
js
Copy code
{
  "ok": true,
  "guard": GuardResult                       // guardId MUST be "quietHours"
}
4.3 guards.weather.check
Request
jsonc
Copy code
{
  "intent": "guards.weather.check",
  "session": Session,
  "context": {
    "now": "ISO-8601",
    "location": {
      "lat": 0,
      "lng": 0
    },
    "weatherSnapshot": {                     // domain-specific from your weather service
      "tempF": 75,
      "feelsLikeF": 78,
      "precipChance": 0.2,
      "windMph": 5,
      "alerts": [ "thunderstorm" ],
      "indoorSafe": true
    }
  }
}
Response
jsonc
Copy code
{
  "ok": true,
  "guard": GuardResult                       // guardId MUST be "weather"
}
4.4 guards.inventory.check
Request
jsonc
Copy code
{
  "intent": "guards.inventory.check",
  "session": Session,
  "context": {
    "inventorySnapshotId": "string | null",
    "equipmentSnapshotId": "string | null",
    "location": "string | null"              // e.g. "main-kitchen" / "shed"
  }
}
Response
jsonc
Copy code
{
  "ok": true,
  "guard": GuardResult,                      // guardId MUST be "inventory"
  "missingItems": [
    {
      "itemId": "string",
      "name": "string",
      "category": "ingredient | equipment",
      "requiredQty": 2,
      "availableQty": 0,
      "unit": "string"
    }
  ]
}
4.5 guards.battery.check
Request
js
Copy code
{
  "intent": "guards.battery.check",
  "session": Session,
  "context": {
    "device": {
      "batteryLevel": 0.32,                  // 0–1
      "charging": false,
      "supportsBatteryApi": true
    },
    "policy": {
      "minLevelToStart": 0.3,               // 30%
      "minLevelToContinue": 0.15
    }
  }
}
Response
jsonc
Copy code
{
  "ok": false,
  "guard": GuardResult,                      // guardId MUST be "battery"
  "policyApplied": {
    "minLevelToStart": 0.3,
    "minLevelToContinue": 0.15
  }
}
5. session.now.resolve (Next runnable session for “Now” CTA)
This mode powers the “Now” button on domain pages:

It figures out the next runnable session for the current domain.

If multiple candidates are viable, it builds a swap / pick session modal
descriptor so the UI can show a friendly selector.

It can pre-run guard evaluation to flag blocking / warning sessions.

Request schema
jsonc
Copy code
{
  "intent": "session.now.resolve",
  "domain": "cooking | cleaning | garden | animals | preservation | storehouse",
  "filters": {
    "status": [ "pending", "paused" ],       // optional; default: ["pending", "paused"]
    "maxCandidates": 5,                      // optional; default: 5
    "excludeSessionIds": [ "string" ]        // optional
  },
  "context": {
    "now": "ISO-8601",
    "householdTimeZone": "string | null",
    "location": {
      "lat": 0,
      "lng": 0
    },
    "device": {
      "batteryLevel": 0.75,
      "charging": true,
      "platform": "web | android | ios | desktop"
    }
  },
  "requestId": "string | null"
}
Response schema
jsonc
Copy code
{
  "ok": true,
  "intent": "session.now.resolve",
  "domain": "cooking",

  "mode": "none | single | multi",
  // - "none": no viable sessions found
  // - "single": one best candidate; UI may show a simple confirmation
  // - "multi": several candidates; UI should open the swap modal

  "selectedSession": {
    "session": Session | null,              // non-null if mode is "single"
    "guardSummary": GuardSummary | null
  },

  "candidates": [
    {
      "session": Session,
      "guardSummary": GuardSummary | null,
      "score": 0.87,                        // higher = better fit; optional
      "reason": "string"                    // e.g. "Best match for current time and weather."
    }
  ],

  "swapModal": SwapModalDescriptor | null,  // used by the SessionRunner launcher UI

  "debug": {
    "reasoning": "string | null",
    "candidateCount": 2
  }
}
If ok === false, mode should be "none" and swapModal SHOULD be null.

6. Notes & Extension Points
Adding a new mode / intent:

Add a new entry to src/agents/modes/map.js.

Add its request/response schema here in schemas.md.

Wire up the handler implementation in agents/skills/... or agents/context/....

Swap modal behavior:

swapModal.uiHints.allowBackgroundRun and swapModal.uiHints.allowMiniWindow
are hints for the SessionRunner container, which will:

Keep the session HUD alive across route changes.

Attempt Document Picture-in-Picture if supported.

Keep timers running via Worker and Wake Lock when allowed.

Guards & policies:

Guard modes can be extended with additional fields in GuardResult.details.

Budget, confidence, and gating are defined separately in:

agents/policies/budget.json

agents/policies/confidence.js

agents/policies/gating.js
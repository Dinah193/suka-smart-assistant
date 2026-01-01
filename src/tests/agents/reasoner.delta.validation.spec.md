# Reasoner Delta Validation — Expected Behavior Spec  
_File: `src/tests/agents/reasoner.delta.validation.spec.md`_

These notes describe how **reasoner shims** and the **Orchestrator** must validate
AI-produced “deltas” (patches) before they touch:

- Dexie `sessions` store,
- long-running `SessionRunner`,
- inventory / storehouse,
- or Hub export paths.

They are **behavioral expectations** to guide:

- schema design (`*.schema.json` for reasoner outputs),
- shim implementation,
- and future automated tests.

The focus is **delta-style outputs** — where the AI proposes *changes*, not
arbitrary free-form text.

---

## 1. Concepts & Terms

### 1.1 Reasoner Delta

A **reasoner delta** is a *structured* suggestion from an AI shim that:

- targets a specific domain entity (e.g., a `Session`, `Recipe`, `Plan`),
- describes a set of mutations that SHOULD be applied (if valid),
- is designed to be validated against schemas before persistence.

Typical shape (conceptually):

```jsonc
{
  "version": "1.0.0",
  "mode": "SSA_LOCAL | SSA_HUB | DEMO | OFFLINE_FALLBACK",
  "target": {
    "entityType": "session",
    "entityId": "sess_123",
    "domain": "cooking"
  },
  "meta": {
    "reasonerId": "cooking.shim.gpt",
    "requestId": "uuid",
    "timestamp": "ISO"
  },
  "ops": [
    {
      "op": "replace",
      "path": "/steps/2/durationSec",
      "value": 900,
      "why": "Boiling takes at least 15 minutes"
    }
  ],
  "warnings": [],
  "constraints": {
    "maxSteps": 64,
    "maxDurationSec": 14400
  }
}
NOTE: The exact schema may differ in your implementation.
This spec assumes you have or will create a reasoner.delta.schema.json
and related domain-specific schemas.

2. Global Validation Expectations
2.1 Always Validate Before Apply
GIVEN a reasoner shim returns a delta
THEN the Orchestrator MUST:

Validate the top-level delta envelope against:

reasoner.delta.schema.json (global),

reasoner.policy.json (e.g., model limits, allowed domains, etc.), and

possibly orchestrator.modes.json (mode-specific allowances).

If validation fails:

MUST NOT mutate sessions / inventory / Hub state,

SHOULD log or emit a reasoner.delta.rejected diagnostic event,

MAY prompt the shim to re-attempt with stricter constraints.

2.2 Mode-Aware Validation
GIVEN a delta is produced under a specific mode (e.g., SSA_HUB)
THEN:

The delta MUST include a mode field, or the orchestrator MUST infer it.

If mode is incompatible with the current mode, the delta MUST be:

rejected OR

downgraded gracefully (e.g., treat Hub export fields as no-ops).

2.3 Entity Identity & Domain
GIVEN a delta targets a Session entity
THEN the following MUST hold:

target.entityType === 'session'.

target.entityId is a non-empty string.

target.domain is one of:

cooking | cleaning | garden | animals | preservation | storehouse.

GIVEN target.entityType is missing or unknown
THEN the delta MUST be rejected with a clear validation error.

3. ops[] Validation
3.1 Allowed Operations
At minimum, the following operation types SHOULD be supported and validated:

add — add new property / array item.

replace — replace existing property / array item.

remove — remove property / array item.

merge — shallow or deep merge of an object.

These may be implemented as JSON-Patch-like semantics; the spec enforces
that whatever is allowed MUST be clearly encoded in a schema.

Expected behavior:

GIVEN an op value not in the allowed set
THEN validation MUST fail and the delta MUST be rejected.

3.2 Path Format
path values MUST:

be non-empty strings,

represent JSON Pointer style paths, e.g.:

/title,

/steps/0/durationSec,

/prefs/voiceGuidance.

GIVEN a path that points outside the allowed schema (e.g., /internalDebug)
THEN validation MUST fail for that op and the entire delta MUST be considered invalid,
unless a “partial application” mode is explicitly defined.

3.3 Value Type Safety
For each op, the schema MUST define:

Types and constraints for the value field (if required).

Examples:

/steps/*/durationSec MUST be:

a finite number,

between 0 and some maxDurationSec from constraints.

/prefs/voiceGuidance MUST be boolean.

Given / When / Then:

GIVEN an op replace /steps/2/durationSec with value: "ten minutes"
THEN validation MUST fail as value is not a number.

GIVEN an op replace /status with value: "flying"
THEN validation MUST fail because status is restricted to:

pending | running | paused | completed | aborted.

3.4 Temporal Constraints
If the path affects temporal fields:

/progress/elapsedSec MUST be >= 0.

/progress/currentStepIndex MUST be an integer within steps.length.

/createdAt and /updatedAt MUST be valid ISO timestamps.

GIVEN a delta sets elapsedSec to a negative number or moves it backwards in time
THEN validation MUST fail (unless explicitly allowed by a “correction” flag).

4. Domain-Specific Schema Checks
4.1 Session Object Contract
Any delta that could result in a full Session object MUST ensure that the
final shape still conforms to the Session contract:

ts
Copy code
{
  id: string;
  domain: 'cooking'|'cleaning'|'garden'|'animals'|'preservation'|'storehouse';
  title: string;
  source: { type: 'recipe'|'cleaningPlan'|'gardenPlan'|'animalTask'|'import'|'manual', refId: string|null };
  steps: SessionStep[];
  prefs: { voiceGuidance: boolean; haptic: boolean; autoAdvance: boolean };
  status: 'pending'|'running'|'paused'|'completed'|'aborted';
  progress: { currentStepIndex: number; elapsedSec: number; startedAt: string|null; pausedAt: string|null };
  analytics: { skippedSteps: string[]; adjustments: any[] };
  createdAt: string;
  updatedAt: string;
}
Behavior:

GIVEN a delta would remove critical fields (id, domain, steps)
THEN validation MUST fail before application.

GIVEN a delta adds new steps
THEN each new step MUST be validated against SessionStep schema:

id: string,

title: string,

durationSec: number,

blockers: valid blocker enums,

metadata fields within their allowed ranges / enums.

4.2 Guard Blockers
If a delta modifies blockers on steps:

all entries MUST be within the allowed set:

['inventory','weather','quietHours','sabbath','equipment'].

GIVEN a blocker "volcano" appears in blockers
THEN validation MUST fail, or the blocker MUST be dropped with a warning,
according to reasoner.policy.json.

5. Policy-Aware Checks (reasoner.policy.json)
5.1 Token & Size Limits (Contextual)
While token usage is handled by the AI infra, the size and complexity of
the delta can still be validated:

Max number of ops per delta.

Max steps per session.

Max total durationSec across all steps.

Example expectations:

GIVEN reasoner.policy.json says maxOps: 64
WHEN the shim returns a delta with 80 ops
THEN validation MUST fail (or must be truncated) according to policy.

5.2 Domain / Mode Constraints
allowedDomains per reasonerId MUST be enforced:

If a cooking-specific shim proposes changes to animals domain,

the delta MUST be rejected.

allowedOps per mode:

Example: in DEMO mode, only add or replace inside a sandbox object may be allowed.

6. Error Reporting & Diagnostics
6.1 Validation Error Envelope
On validation failure, the system SHOULD produce a structured error object:

jsonc
Copy code
{
  "ok": false,
  "errors": [
    {
      "code": "schema.invalid.type",
      "path": "/ops/0/value",
      "message": "Expected number, got string",
      "context": { "op": "replace" }
    }
  ]
}
These errors SHOULD be logged and optionally:

surfaced in dev UIs,

sent to telemetry in production.

6.2 Events
The Orchestrator MAY emit diagnostics via eventBus:

reasoner.delta.received

reasoner.delta.valid

reasoner.delta.invalid

reasoner.delta.applied

Each SHOULD include:

reasonerId,

requestId,

mode,

entityType,

entityId,

and summary stats (e.g., opCount, errorCount).

7. Test Scenario Ideas (Behavioral)
These are suggested scenarios for future automated tests.

7.1 Happy Path — Simple Replace
GIVEN an existing Session with 3 steps.

WHEN a delta proposes:

replace /steps/1/durationSec from 300 to 600.

THEN:

delta validates successfully,

durationSec is updated,

updatedAt is refreshed.

7.2 Invalid Type
GIVEN the same Session.

WHEN a delta proposes:

replace /steps/1/durationSec with "ten".

THEN:

validation fails,

no mutation occurs,

reasoner.delta.invalid is emitted with an appropriate error code.

7.3 Status Tampering
GIVEN a session in completed status.

WHEN a delta tries to set status back to running.

THEN:

validation MUST fail by default,

policy MAY allow special “admin correction” modes, but not general AI shims.

7.4 Out-of-Bounds Step Index
GIVEN a Session with 4 steps.

WHEN a delta includes path: "/steps/10/title" with op: "replace".

THEN:

validation MUST fail due to index out-of-range.

7.5 Guard Blocker Validation
GIVEN a Session step with blockers ["inventory"].

WHEN a delta adds ["inventory", "sabbath", "volcano"].

THEN:

volcano MUST cause either:

full validation failure, OR

partial acceptance with a warning (policy-driven),

in both cases, the system MUST NOT silently accept unknown blockers.

8. Notes
This spec assumes schema files live under src/data/schemas/ or similar
and are wired to the shim via a shared validation utility (e.g., Ajv).

Reasoner shims should never bypass validation; they produce deltas,
and the Orchestrator enforces contracts.

As new domains are added (e.g., foraging, exercise), extend:

the delta schemas,

and this spec with domain-specific rules.
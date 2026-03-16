# Realtime Milestone 1 Contracts

This note defines the Milestone 1 canonical signal envelope and explicit error mapping table.

## Canonical Signal Envelope (M1)

Required fields (strict mode):

| Field | Type | Required | Notes |
|---|---|---|---|
| `eventId` | string | yes | Primary idempotency key. |
| `correlationId` | string | yes | Workflow chain id. |
| `type` or `event` | string | yes | At least one must be present. |
| `sourceModule`/`source` | string | yes | Originating module or route. |
| `version` | string | yes | Contract version, default `v1` when non-strict. |
| `actorId` | string | yes | User or system actor. |
| `ts` | ISO string | no | If present, must be parseable ISO timestamp. |
| `scope` | `household`/`family` | no | Defaults to `household`. |
| `scopeId` | string | no | Derived from context/user/payload, fallback `default`. |
| `causationId` | string | no | Optional event lineage id. |
| `privacyScope` | string | no | Defaults to `household`. |
| `payload` | object | no | Raw signal payload. |

Strict mode flag:

- `SSA_REALTIME_STRICT_ENVELOPE=true` enables required-field enforcement for canonical envelope fields.
- Without strict mode, baseline validation still applies:
  - signal must be an object
  - signal must include `type` or `event`
  - `ts` must be valid if provided

## Idempotency Key Policy

Order of precedence:

1. `eventId`
2. Fallback key: `correlationId + type/event + scope + scopeId`

Deduplication window:

- `SSA_SIGNAL_EVENT_DEDUPE_WINDOW_MS` (default 10 minutes).

## Error Mapping Table

| Error code | HTTP status | Socket ack | Where emitted | Meaning |
|---|---|---|---|---|
| `invalid_event` | `400` | `{ ok:false, error:"invalid_event", reason }` | coordinator/controller/socket | Signal failed validation. |
| `duplicate_event` | `409` | `{ ok:false, error:"duplicate_event", reason }` | coordinator/controller/socket | Event already ingested in dedupe window. |
| `forbidden_scope` | `403` | `{ ok:false, error:"forbidden_scope" }` | controller/scope guards | Caller attempted cross-scope access without elevated role. |
| `family_scope_forbidden` | `403` | `{ ok:false, error:"family_scope_forbidden" }` | controller/socket scope resolution | Family scope requested but family scope id unavailable. |
| `household_scope_missing` | `403` | `{ ok:false, error:"household_scope_missing" }` | controller/socket scope resolution | Household scope requested but home/household id unavailable. |
| `unauthorized` | `401` equivalent handshake failure | `connect_error("unauthorized")` | socket auth middleware | Socket auth token failed verification. |

Notes:

- Response compatibility aliases are preserved for UI hooks:
  - list endpoint keeps `items` and `suggestions`
  - mutation endpoints keep `item` and `suggestion`

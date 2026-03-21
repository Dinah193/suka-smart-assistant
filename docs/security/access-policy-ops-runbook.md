# Access Policy Ops Runbook

This runbook covers day-to-day operations for collaboration and entitlement policy management.

## Preconditions

- API route: `/api/access-policies`
- Required auth: valid user session (Bearer token or session cookie)
- Required ops guard: request header `x-ops-token` matching `ACCESS_POLICY_ADMIN_TOKEN`

## 1) Read Current Policy State

Request:

```bash
curl -sS \
  -H "authorization: Bearer <ACCESS_TOKEN>" \
  -H "x-ops-token: <ACCESS_POLICY_ADMIN_TOKEN>" \
  http://127.0.0.1:4000/api/access-policies
```

Response shape:

- `policy.collaborationGrants[]`
- `policy.entitlementGrantsByUserId`
- `policy.householdRolesByHouseholdId`

## 2) Grant or Update Collaboration Access

Request:

```bash
curl -sS -X POST \
  -H "authorization: Bearer <ACCESS_TOKEN>" \
  -H "x-ops-token: <ACCESS_POLICY_ADMIN_TOKEN>" \
  -H "content-type: application/json" \
  -d '{
    "userId": "user_123",
    "householdId": "house_abc",
    "moduleKey": "realtime",
    "actions": ["read"],
    "startsAt": "2026-03-21T00:00:00.000Z",
    "expiresAt": "2026-03-28T00:00:00.000Z"
  }' \
  http://127.0.0.1:4000/api/access-policies/collaboration-grants/upsert
```

Notes:

- Supported action values: `read`, `create`, `update`, `delete`, `*`
- Upsert key is `(userId, householdId, moduleKey)`

## 3) Revoke Collaboration Access

Request:

```bash
curl -sS -X DELETE \
  -H "authorization: Bearer <ACCESS_TOKEN>" \
  -H "x-ops-token: <ACCESS_POLICY_ADMIN_TOKEN>" \
  -H "content-type: application/json" \
  -d '{
    "userId": "user_123",
    "householdId": "house_abc",
    "moduleKey": "realtime"
  }' \
  http://127.0.0.1:4000/api/access-policies/collaboration-grants
```

Expected response includes `removed: true|false`.

## 4) Grant or Revoke Entitlements

Request:

```bash
curl -sS -X PUT \
  -H "authorization: Bearer <ACCESS_TOKEN>" \
  -H "x-ops-token: <ACCESS_POLICY_ADMIN_TOKEN>" \
  -H "content-type: application/json" \
  -d '{ "entitlements": ["planner.base", "planner.advanced"] }' \
  http://127.0.0.1:4000/api/access-policies/entitlements/user_123
```

To revoke all explicit entitlements, set an empty array:

```json
{ "entitlements": [] }
```

## 5) Access Token Key Rotation

Auth signing secrets are controlled by:

- `AUTH_ACCESS_TOKEN_SECRETS` (comma-separated; first key is active signer)
- fallback: `AUTH_ACCESS_TOKEN_SECRET`

Rotation process:

1. Add new key at the front of `AUTH_ACCESS_TOKEN_SECRETS` and keep prior key(s).
2. Deploy and monitor auth failures.
3. Wait at least one access-token TTL window plus safety margin.
4. Remove retired key(s).

Reference: `docs/security/auth-session-hardening.md`

## 6) CI and Contract Verification Checklist

Before/after policy changes, run:

```bash
npx vitest run _tests_/accessPolicy.routeGroups.contract.test.js --reporter=verbose
npx vitest run _tests_/accessPolicy.entitlement.contract.test.js --reporter=verbose
npx vitest run _tests_/accessPolicyAdmin.contract.test.js --reporter=verbose
node tools/scripts/check-auth-env-readiness.cjs
```

CI jobs to watch:

- `runtime-contracts-strict-entitlement`
- `auth-env-readiness`
- `auth-contracts-windows`

## 7) Audit Trail

Access-policy admin endpoints emit sanitized audit events to server logs with:

- action type
- actor user id
- request id
- timestamp
- sanitized request details

Log prefix:

- `[audit:access-policy]`

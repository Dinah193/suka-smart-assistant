# Auth Session Hardening Guide

This project now supports production-safe cookie session controls and token key rotation.

## Session TTLs

- `AUTH_ACCESS_TTL_SEC`:
  - Access token lifetime (default: `900` seconds).
  - Keep short; target 10-20 minutes.
- `AUTH_REFRESH_TTL_MS`:
  - Non-remember-me refresh session lifetime (default: `7 days`).
- `AUTH_REFRESH_REMEMBER_TTL_MS`:
  - Remember-me refresh session lifetime (default: `30 days`).

Recommended production posture:

- Access TTL: 10-15 minutes
- Refresh TTL: 7-14 days
- Remember-me refresh TTL: 30-45 days

## Cookie Controls

- `AUTH_SESSION_COOKIE_NAME` (default: `ssa_session`)
- `AUTH_COOKIE_SECURE` (default: `true` in production, `false` in development)
- `AUTH_COOKIE_SAME_SITE` (`lax`, `strict`, or `none`; default: `lax`)
- `AUTH_COOKIE_DOMAIN` (optional)
- `AUTH_COOKIE_PATH` (default: `/`)

Notes:

- `SameSite=None` requires `Secure=true`.
- Avoid broad cookie domain scope unless required for subdomain SSO.

## Access Token Signing Key Rotation

Use one of:

- `AUTH_ACCESS_TOKEN_SECRET` for single-key setups
- `AUTH_ACCESS_TOKEN_SECRETS` for rotation-ready setups (comma-separated)

Rotation behavior:

- The first key in `AUTH_ACCESS_TOKEN_SECRETS` is used for signing new access tokens.
- Verification accepts any configured key in the set.

Example:

- `AUTH_ACCESS_TOKEN_SECRETS=2026-03-key-b,2026-01-key-a`

Rotation runbook:

1. Add new key to the front of `AUTH_ACCESS_TOKEN_SECRETS` while retaining old keys.
2. Deploy and monitor session verification/error rates.
3. Wait at least one full access token TTL window (plus safety margin).
4. Remove retired key(s) from the list.

## Production Validation

Startup validation now flags:

- Missing auth signing secret(s) in production.
- Development fallback secret in production.
- `AUTH_COOKIE_SECURE=false` in production.
- Invalid `SameSite=None` with insecure cookies.
- Rotation warning when `AUTH_ACCESS_TOKEN_SECRETS` has only one key.

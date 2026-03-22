# Auth Implementation Phases

## Goal
- Implement authentication safely after decision lock, without breaking existing planner and realtime flows.

## Phase 1: Contracts and Policy
- Define SSA native auth contract (credential model, verification, recovery, lifecycle).
- Define Hub optional auth contract (token/assertion shape, validation endpoint, error model).
- Define single-household membership contract.
- Define module collaboration grant contract.
- Define entitlement matrix for visitor, SSA free, SSA paid, and SSA + linked Hub.
- Produce API access matrix by route group.

## Phase 2: Server Auth Core
- Add/implement server auth service used by realtime and API middleware.
- Add SSA account auth endpoints and session issuance.
- Add optional Hub credential validation and account-linking endpoints.
- Replace production reliance on insecure header fallback.
- Enforce household ownership checks for household-only routes.
- Add collaboration checks for collaboration-enabled module routes.
- Add entitlement checks for Hub-only feature surfaces.

## Phase 3: Session and Identity Mapping
- Implement session lifecycle (issue, refresh, revoke).
- Add identity-to-household mapping at sign-in.
- Add missing household bootstrap safeguards (no multi-household membership).

## Phase 4: UI Auth Surfaces
- Add SSA sign-up/sign-in pages and session recovery UX.
- Add "Sign in with Hub" button on both sign-in and create-account pages.
- Add account-linking UX for users who start with SSA credentials.
- Add protected-route shell behavior.
- Add first-run onboarding to confirm household and collaboration defaults.

## Phase 5: Collaboration UX
- Add module-level collaboration invite/manage screens.
- Add per-module permissions UX.
- Add revocation and activity history.

## Phase 6: Test and Hardening
- Add auth journey tests: SSA sign-up, SSA sign-in, Hub sign-in, linking/unlinking, session expiry, unauthorized access.
- Add collaboration access tests per module boundary.
- Add entitlement tests for free/paid/Hub-gated feature visibility.
- Add rate limiting and abuse controls for auth endpoints.

## Suggested Commit Chunks
1. docs/contracts
2. server auth service + middleware policy
3. household mapping + session lifecycle
4. ui sign-in + protected routes
5. module collaboration management
6. tests and hardening

## Exit Criteria
- Public visitors can open the app but cannot access protected module actions without sign-in.
- Users can create SSA accounts directly (free/paid).
- Users can optionally sign in with Hub credentials and link Hub identity.
- Signed-in users map to exactly one household.
- Cross-household access occurs only through explicit module collaboration grants.
- Hub-gated features are visible/available only when Hub entitlement is present.
- Auth and collaboration behavior is covered by automated tests.

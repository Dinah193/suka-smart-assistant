# Auth Readiness Checklist

## Goal
- Finalize identity, access, and onboarding decisions before building login/signup UI.

## Locked Decisions

### Identity and Household Membership
- One person belongs to exactly one household.
- Cross-household work is collaboration-based, not membership-based.
- Collaboration can include individuals from another household within each module.
- Collaboration controls are user-decided per module.

### Join and Access Model
- App is publicly accessible.
- Suka Smart Assistant has its own account system that anyone can create.
- SSA accounts support free and paid levels.
- Suka Village Family Fund Hub credentials are also accepted as an optional sign-in path.
- Hub credential issuance is invite-only.
- Some SSA features are only visible/available to users with linked Hub accounts.
- Login and create-account pages must include a "Sign in with Hub" button option, similar to common social login buttons.

## Decision Clarifications
- "Code-based join" means joining a household via a share code/link, without a direct invite from an admin.
- Current direction implies no household multi-membership and no generic public household self-join unless explicitly added later.

## Remaining Decisions

### Auth Architecture
- Confirm whether SSA native credentials are implemented with:
  - email + password
  - passwordless email link
  - social sign-in providers
- Confirm whether Hub credentials are validated through:
  - OAuth/OIDC provider flow
  - API token exchange endpoint
  - Server-side session assertion from Hub
- Confirm session model:
  - HttpOnly cookie session (recommended)
  - Bearer token in browser storage
- Confirm account-linking model between SSA and Hub identities:
  - optional user-initiated account linking
  - auto-link by verified email
  - explicit unlink/relink support

### Entitlements and Plan Gating
- Define feature visibility matrix by account level:
  - public visitor (not signed in)
  - SSA free
  - SSA paid
  - SSA + linked Hub
- Confirm whether Hub-linked users can also hold SSA paid plans and how precedence works.

### Collaboration Permissions
- Define module-level collaboration roles:
  - viewer
  - contributor
  - operator
  - admin
- Define who can invite external collaborators for each module.
- Define whether collaboration expires automatically.

### API Authorization Policy
- Define endpoint classes:
  - public
  - authenticated household-only
  - collaboration-accessible
  - admin-only
- Remove insecure dev fallback behavior from production auth paths once provider wiring is complete.

### Onboarding
- Define first-run sequence after successful sign-in:
  - map SSA identity to one household
  - optionally link Hub identity
  - initialize profile and preferences
  - confirm module collaboration defaults

## Pre-UI Build Exit Criteria
- Identity model approved (single-household + collaboration).
- SSA native auth contract approved.
- Hub optional auth integration contract approved.
- Entitlement matrix approved (free/paid/Hub-linked).
- Access matrix approved for server routes.
- Collaboration role model approved.
- Onboarding sequence approved.

## Notes for Implementation
- Keep membership and collaboration separate in data model and policy checks.
- Household ownership checks should not be bypassed by collaboration scope.
- Collaboration grants should be explicit, auditable, and revocable per module.

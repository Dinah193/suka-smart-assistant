# Branch Protection Enablement Runbook - 2026-04-12

Status: Action required outside current repo plan/permissions context
Scope: Clear the final Section 1 blocker in release checklist by enabling required checks on `main`
Artifact ID: CLOSEOUT-BRANCH-PROTECTION-ENABLEMENT-2026-04-12

## Current Verification
- Default branch: `main`
- Current protection status: `protected: false`
- Revalidation command:
  - `gh api repos/Dinah193/suka-smart-assistant/branches/main --jq '{name:.name,protected:.protected}'`

## Latest Enablement Attempt (2026-04-12)
Command executed:
- `gh api -X PUT repos/Dinah193/suka-smart-assistant/branches/main/protection ...`

Observed API result:
- HTTP `403`
- Message: `Upgrade to GitHub Pro or make this repository public to enable this feature.`

Interpretation:
- Branch protection cannot be enabled from CLI in the current repository plan/visibility context.
- Final blocker remains external to application code changes.

## Required Outcome
Enable branch protection for `main` with required status checks aligned to PR lanes.

Required checks set:
- `auth-contracts-windows`
- `auth-env-readiness`
- `build`
- `db-runtime-contracts`
- `household-agenda-gate`
- `lint`
- `npm-audit`
- `policy-audit-contracts`
- `runtime-contracts`
- `runtime-contracts-strict-entitlement`
- `smoke-e2e`
- `typecheck`
- `unit-tests`

## Preferred Enablement Path (GitHub UI)
1. Open repository settings for `Dinah193/suka-smart-assistant`.
2. Go to Branches -> Branch protection rules.
3. Create/update rule for branch pattern `main`.
4. Turn on:
   - Require a pull request before merging
   - Require status checks to pass before merging
   - Require branches to be up to date before merging
5. Add all required checks listed above.
6. Save the rule.

## Post-Enablement Verification
Run:
- `gh api repos/Dinah193/suka-smart-assistant/branches/main --jq '{name:.name,protected:.protected}'`

Expected:
- `{ "name": "main", "protected": true }`

Optional detail check:
- `gh api repos/Dinah193/suka-smart-assistant/branches/main/protection`

## Evidence Capture
After enablement, attach one of:
- Screenshot of branch rule showing required checks, or
- Successful protection API response JSON.

Then update:
- `release-checklist.md` Section 1 first checkbox to complete.
# Branch Protection Setup

Use this guide to enforce required checks on the default branch.

## Required Checks
- `build`
- `unit-tests`
- `lint`
- `typecheck`
- `smoke-e2e`
- `npm-audit`

## Automated Setup
Prerequisites:
- GitHub CLI (`gh`) installed and authenticated.
- Admin permission on the repository.

Command:
```bash
npm run ops:branch-protection -- main
```

Optional overrides:
- `GH_REPO=owner/repo` to explicitly select repository.
- `BRANCH_NAME=main` to set target branch.

## Manual Verification
1. Open repository `Settings` -> `Branches` -> branch ruleset/protection.
2. Confirm all required checks above are listed.
3. Confirm force-push and deletion are disabled.
4. Confirm stale reviews are dismissed and at least one approval is required.

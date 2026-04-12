# CI Blockers Status - 2026-04-05

Status: Closed - Section 1 checks complete
Scope: Release Checklist Section 1 final verification
Artifact ID: CLOSEOUT-CI-BLOCKERS-2026-04-05

## Runner Context
- Public runner IP: `174.229.20.153`
- Atlas allowlist automation capability from this workspace: unavailable (Atlas CLI package installed via winget but `atlas` executable is not resolvable on PATH, and no Atlas Admin API keys are configured).

## Verification Snapshot
- Command: `npm run db:preflight`
- Observed output: `{ "ok": false, "reason": "mongo_connect_failed" }` with Atlas IP whitelist guidance.
- Command: `npm run test:nutrition:mongo-contract`
- Observed output: `Mongo not connected` with Atlas IP whitelist guidance.
- Branch protection: API verification attempted; blocked by HTTP `403` on protection endpoint for current repo plan/settings.

## Revalidation Run (latest session)
- Command: `npm run db:preflight`
- Result: Still failing with `mongo_connect_failed` and Atlas IP whitelist guidance.
- Command: `npm run test:nutrition:mongo-contract`
- Result: Still failing with `Mongo not connected` and Atlas IP whitelist guidance.

## Post-Allowlist Validation (latest session)
- Command: `npm run db:preflight`
- Result: Passed (`[db] MongoDB connected`).
- Command: `npm run test:nutrition:mongo-contract`
- Result: Passed (`[db] MongoDB connected`, `{"ok":true,...}`).

## Atlas Allowlist Provision Attempt
- Command: `winget install --id MongoDB.MongoDBAtlasCLI -e --silent --accept-package-agreements --accept-source-agreements`
- Result: Installer reported success, but `atlas` command remains unavailable on this runner (`where atlas` and direct invocation failed).
- Additional capability check: no Atlas Admin API env vars/keys detected for direct API allowlist mutation.
- Outcome: IP allowlist change could not be executed from this workspace; manual Atlas UI/API-key-backed update required.

## Branch Protection Verification
- Command: `gh api repos/Dinah193/suka-smart-assistant --jq '.default_branch'`
- Result: `main`
- Command: `gh api repos/Dinah193/suka-smart-assistant/branches/main --jq '{name:.name,protected:.protected}'`
- Result: `{ "name": "main", "protected": false }`
- Command: `gh api repos/Dinah193/suka-smart-assistant/branches/main/protection`
- Result: HTTP `403` with message `Upgrade to GitHub Pro or make this repository public to enable this feature.`
- Command: `gh api -X PUT repos/Dinah193/suka-smart-assistant/branches/main/protection ...`
- Result: HTTP `403` with message `Upgrade to GitHub Pro or make this repository public to enable this feature.`
- Command: `npm run ops:branch-protection`
- Result: Failed with HTTP `403` on branch-protection update endpoint (`update-branch-protection`) and repo remained `protected: false`.
- Interim interpretation: Branch protection could not be enabled while repo visibility remained private under current plan constraints.

### Final Revalidation (2026-04-12)
- Command: `gh api -X PATCH repos/Dinah193/suka-smart-assistant -f private=false`
- Result: Repository visibility updated to `public`.
- Command: `gh api -X PUT repos/Dinah193/suka-smart-assistant/branches/main/protection ...`
- Result: Success; required checks and pull-request review requirements applied.
- Command: `gh api repos/Dinah193/suka-smart-assistant/branches/main --jq '{name:.name,protected:.protected}'`
- Result: `{ "name": "main", "protected": true }`.
- Final interpretation: Branch protection is now enabled on `main`; Section 1 blocker resolved.

## Section 1 Items
| Item | Current Status | Blocker / Gap | Recommended Next Action |
|---|---|---|---|
| Branch protection enabled on default branch | Complete | None | None |
| `db:preflight` check green | Complete | Passed in post-allowlist validation (`[db] MongoDB connected`) | None |
| `db-runtime-contracts` check green | Complete | Passed in post-allowlist validation (`{"ok":true,...}` from nutrition Mongo contract) | None |

## Evidence Linkback
- Release checklist: [release-checklist.md](release-checklist.md)
- CI gate evidence map: [docs/planning/closeout-ci-gates-evidence-2026-04-05.md](docs/planning/closeout-ci-gates-evidence-2026-04-05.md)

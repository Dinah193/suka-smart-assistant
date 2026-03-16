# Mongo Phase 3 Gates 6-7 Evidence Template Pack

This pack lets you run Gate 6 and Gate 7 evidence capture in one pass, then fill final PASS/FAIL decisions.

## 1. One-Pass Capture Commands (Windows PowerShell)
Run from repository root:

```powershell
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$evidenceDir = "docs/qa/gate6-gate7-$ts"
New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null

# Gate 6: observability readiness verification command
npm.cmd run db:preflight 2>&1 | Tee-Object "$evidenceDir/01-gate6-db-preflight.txt"
"EXITCODE=$LASTEXITCODE" | Tee-Object -Append "$evidenceDir/01-gate6-db-preflight.txt"

# Gate 7: hygiene commands
git status --short 2>&1 | Tee-Object "$evidenceDir/02-gate7-git-status.txt"
"EXITCODE=$LASTEXITCODE" | Tee-Object -Append "$evidenceDir/02-gate7-git-status.txt"

npm.cmd run db:preflight 2>&1 | Tee-Object "$evidenceDir/03-gate7-db-preflight.txt"
"EXITCODE=$LASTEXITCODE" | Tee-Object -Append "$evidenceDir/03-gate7-db-preflight.txt"

# Optional: tracked-file secret-pattern scan snapshot (manual review still required)
$secretPattern = 'mongodb(\+srv)?://[^\s"'"'']+:[^\s"'"'']+@|MONGODB_URI\s*=\s*['"'"']?mongodb|MONGO_URI\s*=\s*['"'"']?mongodb|AWS_SECRET_ACCESS_KEY|-----BEGIN (RSA|EC|OPENSSH|DSA) PRIVATE KEY-----|x-api-key\s*[:=]'
git grep -n -I -E $secretPattern -- . ':!docs/qa/**' 2>&1 | Tee-Object "$evidenceDir/04-gate7-secret-scan.txt"
"EXITCODE=$LASTEXITCODE" | Tee-Object -Append "$evidenceDir/04-gate7-secret-scan.txt"

# Create editable evidence templates
@'
# Gate 6 Evidence Record

Gate: Phase 3 / Gate 6 (Observability and Alerting Readiness)
Date: YYYY-MM-DD
Environment: staging
Window: HH:MM-HH:MM local
Owners: IC=<name>, Operator=<name>, Observer=<name>

Verification Command Result:
- command: npm.cmd run db:preflight
- exitCode: <0|non-zero>
- healthConnected: <yes|no>

Alert Coverage:
- mongoConnectivityFailures: <enabled|missing>
- nutritionAdapterWriteFailuresMongoUnavailable: <enabled|missing>
- fallbackReadVolumeSpikes: <enabled|missing>
- preflightOrVerifyFailures: <enabled|missing>

Runbook Links:
- triageRunbook: <url-or-doc-path>
- rollbackRunbook: <url-or-doc-path>

Evidence Files:
- 01-gate6-db-preflight.txt

Gate Decision:
- status: <PASS|FAIL>
- rationale: <one paragraph>
- followups: <none or ticket links>
'@ | Set-Content "$evidenceDir/05-gate6-evidence.md"

@'
# Gate 7 Evidence Record

Gate: Phase 3 / Gate 7 (Security and Secrets Hygiene)
Date: YYYY-MM-DD
Environment: staging
Window: HH:MM-HH:MM local
Owners: IC=<name>, Operator=<name>, Observer=<name>

Verification Command Results:
- command1: git status --short
- command1ExitCode: <0|non-zero>
- command2: npm.cmd run db:preflight
- command2ExitCode: <0|non-zero>

Secrets and Credential Handling Review:
- credentialsSource: <env/secret-manager confirmed yes|no>
- trackedSecretsDetected: <yes|no>
- runtimeLogLeakDetected: <yes|no>
- secretScanSnapshotReviewed: <yes|no>

Evidence Files:
- 02-gate7-git-status.txt
- 03-gate7-db-preflight.txt
- 04-gate7-secret-scan.txt

Gate Decision:
- status: <PASS|FAIL>
- rationale: <one paragraph>
- followups: <none or ticket links>
'@ | Set-Content "$evidenceDir/06-gate7-evidence.md"

Write-Output "EVIDENCE_DIR=$evidenceDir"
```

## 2. Finalization Steps
1. Open `05-gate6-evidence.md` and `06-gate7-evidence.md` in the generated folder.
2. Fill owners, timestamps, alert status, and final PASS/FAIL decisions.
3. Reference the generated folder in Phase 3 checklist Gate 6 and Gate 7 evidence lines.
4. Check Gate 6 and Gate 7 boxes in the PR evidence checklist only if both are PASS.

## 3. Pass/Fail Quick Rules
- Gate 6 PASS:
  - `db:preflight` exit code is 0 and health is connected.
  - All four required alerts are enabled.
  - Triage and rollback runbook links are provided.
- Gate 7 PASS:
  - `git status --short` and `db:preflight` complete successfully.
  - Credentials are confirmed from env/secret manager.
  - No secrets appear in tracked files or runtime logs.

If either gate fails, record FAIL with remediation tickets and do not mark GO.

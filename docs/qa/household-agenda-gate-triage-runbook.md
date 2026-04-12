# Household Agenda Gate Triage Runbook

## Purpose
Use this runbook to triage failures from `CI/household-agenda-gate` quickly in pull requests.

## Where To Look First
1. Open the PR checks and select `CI/household-agenda-gate`.
2. Review step outcomes in this order:
   - `Household agenda gate (logged + checked)`
   - `Publish household agenda gate summary`
   - `Upload household agenda gate artifacts`
3. Open the job summary panel for the markdown summary output.

## Expected Artifacts
When upload succeeds, the artifact `household-agenda-gate-latest` should contain:
- `.tmp/household-agenda-suites-latest.log`
- `.tmp/household-agenda-suites-latest.json`
- `.tmp/household-agenda-suites-latest.md`
- timestamped `.tmp/household-agenda-suites-*.{log,json,md}` files

## Fast Local Repro
Run the same gate locally:

```bash
npm run test:household:agenda:gate:ci
```

If needed, run only the logged runner first:

```bash
npm run test:household:agenda:gate:logged
npm run test:household:agenda:gate:logged:check
npm run test:household:agenda:gate:summary
```

## Failure Interpretation
- Gate step fails:
  - Use `.tmp/household-agenda-suites-latest.log` to identify the first failed suite.
  - Use `.tmp/household-agenda-suites-latest.json` for structured step durations and exit codes.
- Summary step fails:
  - Re-run summary locally and verify latest JSON exists.
- Artifact upload fails:
  - Verify the expected files exist before upload.
  - If logs mention hidden files under `.tmp`, check upload action settings for hidden-file handling.

## Common First Actions
1. Re-run the single failed suite directly with `npm run test:ci -- <suite-path>`.
2. Confirm the suite also fails locally.
3. If local pass but CI fail, compare environment-sensitive paths, timing, and file generation in `.tmp`.
4. Post PR comment with:
   - failing suite name
   - first failing assertion/error line
   - link to job run
   - whether local repro succeeded

## Ownership
- Primary owner: Planner reliability lane.
- Escalate when:
  - two consecutive PR runs fail on different suites without code changes, or
  - artifact/summary publishing fails repeatedly and blocks diagnosis.

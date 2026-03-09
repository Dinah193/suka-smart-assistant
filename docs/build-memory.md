# Deterministic Build Memory Verification

Use these commands on Windows to run a memory-capped production build with deterministic pass/fail markers.

## Commands

- `npm.cmd run build:mem`
  - Runs Vite build with `--max-old-space-size=6144`.

- `npm.cmd run build:mem:verify`
  - Runs memory-capped build.
  - Streams output to terminal.
  - Writes a timestamped log file under `.tmp/`:
    - `.tmp/build.mem.YYYYMMDD-HHMMSS.log`
  - Appends `BUILD_EXIT:<code>` at the end of the log.
  - Parses the marker and exits with the parsed code.

- `npm.cmd run build:mem:parse-latest`
  - Reads the latest `.tmp/build.mem.*.log` file.
  - Parses `BUILD_EXIT:<code>`.
  - Returns that code as the command exit status.

## Why this is deterministic

Terminal output can be truncated in long builds. The timestamped log + explicit `BUILD_EXIT:<code>` marker gives a stable source of truth for build status.

## Typical flow

1. Run `npm.cmd run build:mem:verify`.
2. If needed, confirm later with `npm.cmd run build:mem:parse-latest`.

## Runtime Realtime Contract Test (Optional)

Use this when you want to run the runtime API contract path for realtime controller compatibility.

PowerShell command:

```powershell
$env:SSA_ENABLE_RUNTIME_CONTRACT_TESTS='1'; npm.cmd exec --yes vitest run _tests_/realtimeController.runtime.contract.test.js
```

Notes:

- The test is gated and will skip unless `SSA_ENABLE_RUNTIME_CONTRACT_TESTS` is enabled.
- The test also requires backend runtime dependencies to be installed in this workspace:
  - `express`
  - `socket.io`
- If those packages are missing, keep this test in skipped mode or install them before running the command.

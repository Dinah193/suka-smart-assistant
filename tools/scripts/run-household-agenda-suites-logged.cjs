const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..", "..");
const tmpDir = path.join(repoRoot, ".tmp");
fs.mkdirSync(tmpDir, { recursive: true });

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const logFile = path.join(tmpDir, `household-agenda-suites-${ts}.log`);
const latestLog = path.join(tmpDir, "household-agenda-suites-latest.log");
const summaryFile = path.join(tmpDir, `household-agenda-suites-${ts}.json`);
const latestSummary = path.join(tmpDir, "household-agenda-suites-latest.json");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

const suites = [
  "_tests_/householdAgendaControls.unit.test.js",
  "_tests_/householdAgendaQueryParams.unit.test.js",
  "_tests_/householdAgendaSurfaceParity.unit.test.js",
  "_tests_/mealPlanner.controls.contract.test.jsx",
  "_tests_/storehousePage.householdAgenda.contract.test.jsx",
  "_tests_/homesteadPage.householdAgenda.contract.test.jsx",
  "_tests_/cleaningPage.ssa.contract.test.jsx",
];

const steps = suites.map((suite) => ({
  label: `suite:${suite}`,
  cmd: npmCmd,
  args: ["run", "test:ci", "--", suite],
}));

const runSummary = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  logFile: path.relative(repoRoot, logFile).replace(/\\/g, "/"),
  steps: [],
};

function writeLog(line = "") {
  fs.appendFileSync(logFile, `${line}\n`, "utf8");
}

function writeSummary() {
  fs.writeFileSync(summaryFile, `${JSON.stringify(runSummary, null, 2)}\n`, "utf8");
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9_./:-]+$/.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

function runStep(step) {
  const started = Date.now();
  writeLog(`\n=== STEP: ${step.label} ===`);
  writeLog(`$ ${step.cmd} ${step.args.join(" ")}`);
  console.log(`[household-agenda:logged] running ${step.label}`);

  const commandLine = `${step.cmd} ${step.args.map(quoteArg).join(" ")}`;
  const res =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/d", "/s", "/c", commandLine], {
          cwd: repoRoot,
          encoding: "utf8",
          shell: false,
          maxBuffer: 50 * 1024 * 1024,
        })
      : spawnSync("sh", ["-lc", commandLine], {
          cwd: repoRoot,
          encoding: "utf8",
          shell: false,
          maxBuffer: 50 * 1024 * 1024,
        });

  if (res.stdout) writeLog(res.stdout.trimEnd());
  if (res.stderr) writeLog(res.stderr.trimEnd());
  if (res.error) writeLog(`[step-error] ${String(res.error.message || res.error)}`);

  const elapsedMs = Date.now() - started;
  const status = typeof res.status === "number" ? res.status : 1;
  writeLog(`[step-result] ${step.label} exit=${status} durationMs=${elapsedMs}`);

  runSummary.steps.push({
    label: step.label,
    command: `${step.cmd} ${step.args.join(" ")}`,
    exitCode: status,
    durationMs: elapsedMs,
  });
  writeSummary();

  if (status !== 0) {
    console.error(`[household-agenda:logged] failed at ${step.label} (exit ${status})`);
    return { ok: false, status };
  }

  console.log(`[household-agenda:logged] passed ${step.label}`);
  return { ok: true, status: 0 };
}

function finalize(status) {
  runSummary.finishedAt = new Date().toISOString();
  runSummary.status = status;
  writeSummary();
  fs.copyFileSync(logFile, latestLog);
  fs.copyFileSync(summaryFile, latestSummary);
}

function main() {
  writeLog("# household-agenda:logged");
  writeLog(`# started ${runSummary.startedAt}`);
  writeSummary();

  for (const step of steps) {
    const result = runStep(step);
    if (!result.ok) {
      finalize("failed");
      writeLog(`# finished ${new Date().toISOString()} (FAILED)`);
      console.error(`[household-agenda:logged] log: ${logFile}`);
      console.error(`[household-agenda:logged] summary: ${summaryFile}`);
      process.exit(result.status || 1);
    }
  }

  writeLog(`# finished ${new Date().toISOString()} (PASSED)`);
  finalize("passed");
  console.log("[household-agenda:logged] all steps passed");
  console.log(`[household-agenda:logged] log: ${logFile}`);
  console.log(`[household-agenda:logged] summary: ${summaryFile}`);
}

main();

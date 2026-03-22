#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function run() {
  const repoRoot = process.cwd();
  const qaDir = path.join(repoRoot, "docs", "qa");
  fs.mkdirSync(qaDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:]/g, "-");

  const testFiles = [
    "_tests_/realtimeCoordinationPanel.readiness.contract.test.jsx",
    "_tests_/realtimeController.runtime.contract.test.js",
    "_tests_/realtimeSocket.runtime.contract.test.js",
    "_tests_/mealPlannerBridge.ui.integration.test.js",
    "_tests_/storehousePlanner.quickAddLowStockFlow.contract.test.jsx",
  ];

  const npmArgs = ["run", "test:ci", "--", ...testFiles];
  const isWindows = process.platform === "win32";
  const npmCommand = isWindows ? "npm.cmd" : "npm";
  const cmdLine = `${npmCommand} ${npmArgs.join(" ")}`;

  console.log("[consolidated-smoke] Running targeted contracts...");
  const res = isWindows
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", cmdLine], {
        cwd: repoRoot,
        stdio: "inherit",
        shell: false,
        env: process.env,
      })
    : spawnSync(npmCommand, npmArgs, {
        cwd: repoRoot,
        stdio: "inherit",
        shell: false,
        env: process.env,
      });

  const success = res.status === 0;

  const report = {
    reportName: "consolidated-smoke-contracts",
    generatedAt: new Date().toISOString(),
    command: cmdLine,
    tests: {
      files: testFiles,
      success,
    },
    references: {
      browserCheckpointArtifact: "docs/qa/consolidated-smoke-report-2026-03-19.json",
      browserRerunArtifact: "docs/qa/consolidated-smoke-report-2026-03-19-rerun.json",
      browserComparisonArtifact: "docs/qa/consolidated-smoke-compare-2026-03-19.json",
    },
  };

  const outPath = path.join(qaDir, `consolidated-smoke-contract-report-${stamp}.json`);
  const latestPath = path.join(qaDir, "consolidated-smoke-contract-report-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(report, null, 2));
  console.log(`[consolidated-smoke] Wrote ${path.relative(repoRoot, outPath)}`);
  console.log(`[consolidated-smoke] Updated ${path.relative(repoRoot, latestPath)}`);

  if (!success) {
    process.exit(res.status || 1);
  }
}

run();

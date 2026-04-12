#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const EXPECTED_LABELS = [
  "suite:_tests_/householdAgendaControls.unit.test.js",
  "suite:_tests_/householdAgendaQueryParams.unit.test.js",
  "suite:_tests_/householdAgendaSurfaceParity.unit.test.js",
  "suite:_tests_/mealPlanner.controls.contract.test.jsx",
  "suite:_tests_/storehousePage.householdAgenda.contract.test.jsx",
  "suite:_tests_/homesteadPage.householdAgenda.contract.test.jsx",
  "suite:_tests_/cleaningPage.ssa.contract.test.jsx",
];

function fail(message) {
  console.error(`[household-agenda:check] ${message}`);
  process.exit(1);
}

function isIsoString(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function run() {
  const repoRoot = process.cwd();
  const summaryPath = path.join(repoRoot, ".tmp", "household-agenda-suites-latest.json");

  if (!fs.existsSync(summaryPath)) {
    fail(`Missing artifact: ${path.relative(repoRoot, summaryPath)}`);
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  } catch (error) {
    fail(`Invalid JSON in latest artifact: ${error?.message || error}`);
  }

  if (!isIsoString(summary?.startedAt)) {
    fail("startedAt missing or invalid ISO timestamp");
  }

  if (!isIsoString(summary?.finishedAt)) {
    fail("finishedAt missing or invalid ISO timestamp");
  }

  if (summary?.status !== "passed") {
    fail(`status must be passed, received: ${String(summary?.status || "")}`);
  }

  if (!Array.isArray(summary?.steps) || summary.steps.length !== EXPECTED_LABELS.length) {
    fail(`steps must contain exactly ${EXPECTED_LABELS.length} entries`);
  }

  for (const expectedLabel of EXPECTED_LABELS) {
    if (!summary.steps.some((step) => step?.label === expectedLabel)) {
      fail(`missing expected step label: ${expectedLabel}`);
    }
  }

  for (const step of summary.steps) {
    if (typeof step?.label !== "string" || !step.label) {
      fail("step.label missing or invalid");
    }
    if (typeof step?.command !== "string" || !step.command) {
      fail(`step.command missing for ${step?.label || "unknown step"}`);
    }
    if (step?.exitCode !== 0) {
      fail(`step ${step.label} exitCode expected 0 but received ${String(step?.exitCode)}`);
    }
    if (!Number.isFinite(step?.durationMs) || step.durationMs < 0) {
      fail(`step ${step.label} has invalid durationMs`);
    }
  }

  const logRel = String(summary?.logFile || "");
  if (!logRel) {
    fail("logFile missing");
  }
  const logPath = path.join(repoRoot, logRel);
  if (!fs.existsSync(logPath)) {
    fail(`Referenced log file does not exist: ${logRel}`);
  }

  console.log(
    `[household-agenda:check] PASS ${path.relative(repoRoot, summaryPath)} (${summary.steps.length} steps)`
  );
}

run();

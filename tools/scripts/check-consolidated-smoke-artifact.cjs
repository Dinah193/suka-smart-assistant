#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error(`[consolidated-smoke:check] ${msg}`);
  process.exit(1);
}

function run() {
  const repoRoot = process.cwd();
  const reportPath = path.join(
    repoRoot,
    "docs",
    "qa",
    "consolidated-smoke-contract-report-latest.json"
  );

  if (!fs.existsSync(reportPath)) {
    fail(`Missing artifact: ${path.relative(repoRoot, reportPath)}`);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    fail(`Invalid JSON in latest artifact: ${err?.message || err}`);
  }

  if (report?.reportName !== "consolidated-smoke-contracts") {
    fail(`Unexpected reportName: ${String(report?.reportName || "")}`);
  }

  if (!Array.isArray(report?.tests?.files) || !report.tests.files.length) {
    fail("tests.files missing or empty in latest artifact");
  }

  if (report?.tests?.success !== true) {
    fail("tests.success is not true in latest artifact");
  }

  console.log(
    `[consolidated-smoke:check] PASS ${path.relative(repoRoot, reportPath)}`
  );
}

run();

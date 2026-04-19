#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const TARGET_TEST_FILES = Object.freeze([
  "_tests_/serverStartup.dbmode.contract.test.js",
  "_tests_/integrationPreflight.neo4j.contract.test.js",
]);

function parseArgs(argv) {
  const out = {
    inputDir: "docs/qa",
    prefix: "integration-reliability-flaky-trend-",
    requiredWindows: 3,
    outPath: "",
  };

  for (const raw of argv.slice(2)) {
    const arg = String(raw || "").trim();
    if (!arg) continue;

    if (arg.startsWith("--dir=")) {
      out.inputDir = arg.slice("--dir=".length).trim();
      continue;
    }

    if (arg.startsWith("--prefix=")) {
      out.prefix = arg.slice("--prefix=".length).trim();
      continue;
    }

    if (arg.startsWith("--required-windows=")) {
      const n = Number(arg.slice("--required-windows=".length));
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("invalid_required_windows: must be a number >= 1");
      }
      out.requiredWindows = Math.floor(n);
      continue;
    }

    if (arg.startsWith("--out=")) {
      out.outPath = arg.slice("--out=".length).trim();
      continue;
    }

    throw new Error(`unknown_arg:${arg}`);
  }

  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listCaptureFiles(dirPath, prefix) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .map((name) => path.resolve(dirPath, name))
    .filter((filePath) => {
      try {
        const data = readJson(filePath);
        return data && data.reportType === "integration_reliability_flaky_trend_capture";
      } catch {
        return false;
      }
    })
    .sort((a, b) => {
      const sa = fs.statSync(a);
      const sb = fs.statSync(b);
      return sa.mtimeMs - sb.mtimeMs;
    });
}

function summarizeWindow(data, filePath) {
  const details = Array.isArray(data?.details) ? data.details : [];
  const byTest = Object.fromEntries(
    details
      .map((entry) => entry?.summary)
      .filter(Boolean)
      .map((summary) => [String(summary.testFile || ""), summary])
  );

  const failingTests = TARGET_TEST_FILES.filter((testFile) => {
    const summary = byTest[testFile];
    return summary && (Number(summary.failedRuns || 0) > 0 || Boolean(summary.flaky));
  });

  return {
    file: filePath,
    generatedAt: String(data?.generatedAt || ""),
    windowId: data?.windowId || null,
    testsTracked: Number(data?.summary?.testsTracked || 0),
    failingTests,
    pass: failingTests.length === 0,
  };
}

function main() {
  const options = parseArgs(process.argv);
  const cwd = process.cwd();
  const inputDir = path.resolve(cwd, options.inputDir);

  const files = listCaptureFiles(inputDir, options.prefix);
  const windows = files.map((filePath) => summarizeWindow(readJson(filePath), path.relative(cwd, filePath)));
  const trailingWindows = windows.slice(-options.requiredWindows);

  const perTestTrailing = Object.fromEntries(
    TARGET_TEST_FILES.map((testFile) => {
      const passes = trailingWindows.map((window) => !window.failingTests.includes(testFile));
      return [
        testFile,
        {
          windowsObserved: trailingWindows.length,
          consecutivePasses: passes.filter(Boolean).length,
          passAllObserved: trailingWindows.length > 0 && passes.every(Boolean),
        },
      ];
    })
  );

  const hasEnoughWindows = trailingWindows.length >= options.requiredWindows;
  const allPassAcrossRequired = TARGET_TEST_FILES.every((testFile) => perTestTrailing[testFile].passAllObserved);
  const gatePass = hasEnoughWindows && allPassAcrossRequired;

  const report = {
    ok: true,
    reportType: "integration_reliability_flaky_window_gate",
    generatedAt: new Date().toISOString(),
    requiredWindows: options.requiredWindows,
    capturePrefix: options.prefix,
    inputDir: options.inputDir,
    totalCaptureFiles: windows.length,
    trailingWindows,
    perTestTrailing,
    gate: {
      pass: gatePass,
      hasEnoughWindows,
      allPassAcrossRequired,
      reason: gatePass
        ? "trailing_windows_stable"
        : hasEnoughWindows
          ? "one_or_more_tests_failed_in_required_windows"
          : "insufficient_windows",
    },
  };

  if (options.outPath) {
    const absoluteOutPath = path.resolve(cwd, options.outPath);
    fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
    fs.writeFileSync(absoluteOutPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.writtenTo = options.outPath;
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(gatePass ? 0 : 1);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      script: "check-flaky-trend-windows",
      error: String(error?.message || error || "unknown_error"),
      failedAt: new Date().toISOString(),
    })}\n`
  );
  process.exit(1);
}

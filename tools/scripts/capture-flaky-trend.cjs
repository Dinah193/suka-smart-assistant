#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const TARGET_TEST_FILES = Object.freeze([
  "_tests_/serverStartup.dbmode.contract.test.js",
  "_tests_/integrationPreflight.neo4j.contract.test.js",
]);

function parseArgs(argv) {
  const out = {
    iterations: 5,
    outPath: "",
    includeOutput: false,
    windowId: "",
  };

  for (const raw of argv.slice(2)) {
    const arg = String(raw || "").trim();
    if (!arg) continue;

    if (arg === "--include-output") {
      out.includeOutput = true;
      continue;
    }

    if (arg.startsWith("--iterations=")) {
      const n = Number(arg.slice("--iterations=".length));
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("invalid_iterations: must be a number >= 1");
      }
      out.iterations = Math.floor(n);
      continue;
    }

    if (arg.startsWith("--out=")) {
      out.outPath = arg.slice("--out=".length).trim();
      continue;
    }

    if (arg.startsWith("--window=")) {
      out.windowId = arg.slice("--window=".length).trim();
      continue;
    }

    throw new Error(`unknown_arg:${arg}`);
  }

  return out;
}

function runVitestForFile(cwd, testFile) {
  return new Promise((resolve) => {
    const vitestEntry = path.resolve(cwd, "node_modules", "vitest", "vitest.mjs");
    const command = process.execPath;
    const args = [vitestEntry, "run", testFile, "--reporter=dot"];

    const startedAt = Date.now();
    const startedIso = new Date(startedAt).toISOString();

    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("error", (error) => {
      const endedAt = Date.now();
      resolve({
        ok: false,
        startedAt: startedIso,
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        exitCode: null,
        signal: null,
        error: String(error?.message || error || "spawn_error"),
        stdout,
        stderr,
      });
    });

    child.on("exit", (code, signal) => {
      const endedAt = Date.now();
      resolve({
        ok: code === 0,
        startedAt: startedIso,
        endedAt: new Date(endedAt).toISOString(),
        durationMs: endedAt - startedAt,
        exitCode: code,
        signal: signal || null,
        error: code === 0 ? null : "test_run_failed",
        stdout,
        stderr,
      });
    });
  });
}

function summarizeRuns(testFile, runs) {
  const totalRuns = runs.length;
  const passedRuns = runs.filter((run) => run.ok).length;
  const failedRuns = totalRuns - passedRuns;
  const flaky = passedRuns > 0 && failedRuns > 0;
  const averageDurationMs = totalRuns
    ? Math.round(runs.reduce((sum, run) => sum + Number(run.durationMs || 0), 0) / totalRuns)
    : 0;

  return {
    testFile,
    totalRuns,
    passedRuns,
    failedRuns,
    passRate: totalRuns ? Number((passedRuns / totalRuns).toFixed(4)) : 0,
    failureRate: totalRuns ? Number((failedRuns / totalRuns).toFixed(4)) : 0,
    flaky,
    averageDurationMs,
  };
}

async function main() {
  const options = parseArgs(process.argv);
  const cwd = process.cwd();

  const perTestRuns = [];
  for (const testFile of TARGET_TEST_FILES) {
    const runs = [];
    for (let i = 0; i < options.iterations; i += 1) {
      const run = await runVitestForFile(cwd, testFile);
      runs.push({
        iteration: i + 1,
        ok: run.ok,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: run.durationMs,
        exitCode: run.exitCode,
        signal: run.signal,
        error: run.error,
        stdout: options.includeOutput ? run.stdout : undefined,
        stderr: options.includeOutput ? run.stderr : undefined,
      });
    }

    perTestRuns.push({
      summary: summarizeRuns(testFile, runs),
      runs,
    });
  }

  const summaries = perTestRuns.map((entry) => entry.summary);
  const flakyTests = summaries.filter((entry) => entry.flaky).map((entry) => entry.testFile);
  const failedTests = summaries.filter((entry) => entry.failedRuns > 0).map((entry) => entry.testFile);

  const report = {
    ok: true,
    reportType: "integration_reliability_flaky_trend_capture",
    generatedAt: new Date().toISOString(),
    windowId: options.windowId || null,
    iterationsPerTest: options.iterations,
    tests: TARGET_TEST_FILES,
    summary: {
      testsTracked: summaries.length,
      testsWithFailures: failedTests.length,
      flakyTestsCount: flakyTests.length,
      flakyTests,
      failedTests,
    },
    details: perTestRuns,
  };

  if (options.outPath) {
    const absoluteOutPath = path.resolve(cwd, options.outPath);
    fs.mkdirSync(path.dirname(absoluteOutPath), { recursive: true });
    fs.writeFileSync(absoluteOutPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.writtenTo = options.outPath;
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      script: "capture-flaky-trend",
      error: String(error?.message || error || "unknown_error"),
      failedAt: new Date().toISOString(),
    })}\n`
  );
  process.exit(1);
});

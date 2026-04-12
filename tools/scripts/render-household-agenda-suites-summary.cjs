#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function fail(message) {
  console.error(`[household-agenda:summary] ${message}`);
  process.exit(1);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  return `${(ms / 1000).toFixed(2)}s`;
}

function buildMarkdown(summary, summaryRelPath) {
  const lines = [];
  lines.push("## Household Agenda Gate Summary");
  lines.push("");
  lines.push(`- Status: **${String(summary.status || "unknown").toUpperCase()}**`);
  lines.push(`- Started: ${String(summary.startedAt || "")}`);
  lines.push(`- Finished: ${String(summary.finishedAt || "")}`);
  lines.push(`- Summary JSON: ${summaryRelPath}`);
  lines.push(`- Log: ${String(summary.logFile || "")}`);
  lines.push("");
  lines.push("| Suite | Exit | Duration |");
  lines.push("|---|---:|---:|");
  for (const step of Array.isArray(summary.steps) ? summary.steps : []) {
    lines.push(
      `| ${String(step?.label || "") } | ${String(step?.exitCode ?? "") } | ${formatDuration(Number(step?.durationMs))} |`
    );
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function run() {
  const repoRoot = process.cwd();
  const latestSummaryPath = path.join(repoRoot, ".tmp", "household-agenda-suites-latest.json");

  if (!fs.existsSync(latestSummaryPath)) {
    fail(`Missing artifact: ${path.relative(repoRoot, latestSummaryPath)}`);
  }

  let summary;
  try {
    summary = JSON.parse(fs.readFileSync(latestSummaryPath, "utf8"));
  } catch (error) {
    fail(`Invalid JSON in latest artifact: ${error?.message || error}`);
  }

  const markdown = buildMarkdown(
    summary,
    path.relative(repoRoot, latestSummaryPath).replace(/\\/g, "/")
  );

  const latestMarkdownPath = path.join(repoRoot, ".tmp", "household-agenda-suites-latest.md");
  fs.writeFileSync(latestMarkdownPath, markdown, "utf8");

  const timestampSuffix = String(summary?.startedAt || new Date().toISOString()).replace(/[.:]/g, "-");
  const stampedMarkdownPath = path.join(
    repoRoot,
    ".tmp",
    `household-agenda-suites-${timestampSuffix}.md`
  );
  fs.writeFileSync(stampedMarkdownPath, markdown, "utf8");

  const stepSummaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummaryFile) {
    fs.appendFileSync(stepSummaryFile, markdown, "utf8");
    console.log(`[household-agenda:summary] wrote GitHub step summary: ${stepSummaryFile}`);
  }

  console.log(
    `[household-agenda:summary] generated ${path.relative(repoRoot, latestMarkdownPath)} and ${path.relative(repoRoot, stampedMarkdownPath)}`
  );
}

run();

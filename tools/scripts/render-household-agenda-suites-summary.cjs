#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function fail(message) {
  console.error(`[household-agenda:summary] ${message}`);
  process.exit(1);
}

function hasArg(flag) {
  return process.argv.includes(flag);
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "n/a";
  return `${(ms / 1000).toFixed(2)}s`;
}

function buildMarkdown(summary, summaryRelPath) {
  const steps = Array.isArray(summary.steps) ? summary.steps : [];
  const totalDurationMs = steps.reduce(
    (acc, step) => acc + (Number.isFinite(Number(step?.durationMs)) ? Number(step.durationMs) : 0),
    0
  );
  const passedCount = steps.filter((step) => Number(step?.exitCode) === 0).length;
  const failedSteps = steps.filter((step) => Number(step?.exitCode) !== 0);
  const slowestSteps = [...steps]
    .sort((a, b) => Number(b?.durationMs || 0) - Number(a?.durationMs || 0))
    .slice(0, 3);

  const lines = [];
  lines.push("## Household Agenda Gate Summary");
  lines.push("");
  lines.push(`- Status: **${String(summary.status || "unknown").toUpperCase()}**`);
  lines.push(`- Started: ${String(summary.startedAt || "")}`);
  lines.push(`- Finished: ${String(summary.finishedAt || "")}`);
  lines.push(`- Summary JSON: ${summaryRelPath}`);
  lines.push(`- Log: ${String(summary.logFile || "")}`);
  lines.push(`- Suites: ${passedCount}/${steps.length} passed`);
  lines.push(`- Total Runtime: ${formatDuration(totalDurationMs)}`);
  if (failedSteps.length) {
    lines.push(`- Failed Suites: ${failedSteps.length}`);
  }
  if (slowestSteps.length) {
    lines.push(
      `- Slowest Suites: ${slowestSteps
        .map((step) => `${String(step?.label || "") } (${formatDuration(Number(step?.durationMs))})`)
        .join(", ")}`
    );
  }
  lines.push("");
  lines.push("| Suite | Exit | Duration |");
  lines.push("|---|---:|---:|");
  for (const step of steps) {
    lines.push(
      `| ${String(step?.label || "") } | ${String(step?.exitCode ?? "") } | ${formatDuration(Number(step?.durationMs))} |`
    );
  }
  if (failedSteps.length) {
    lines.push("");
    lines.push("### Failed Suites");
    lines.push("");
    for (const step of failedSteps) {
      lines.push(
        `- ${String(step?.label || "") } (exit ${String(step?.exitCode ?? "") }, ${formatDuration(Number(step?.durationMs))})`
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function run() {
  const repoRoot = process.cwd();
  const latestSummaryPath = path.join(repoRoot, ".tmp", "household-agenda-suites-latest.json");
  const allowMissing = hasArg("--allow-missing");

  const stepSummaryFile = process.env.GITHUB_STEP_SUMMARY;

  if (!fs.existsSync(latestSummaryPath)) {
    if (!allowMissing) {
      fail(`Missing artifact: ${path.relative(repoRoot, latestSummaryPath)}`);
    }

    const markdown = [
      "## Household Agenda Gate Summary",
      "",
      "- Status: **UNAVAILABLE**",
      `- Summary JSON: ${path.relative(repoRoot, latestSummaryPath).replace(/\\/g, "/")}`,
      "- Note: summary artifact was not found for this run.",
      "",
    ].join("\n");

    const latestMarkdownPath = path.join(repoRoot, ".tmp", "household-agenda-suites-latest.md");
    fs.writeFileSync(latestMarkdownPath, `${markdown}\n`, "utf8");

    const timestampSuffix = new Date().toISOString().replace(/[.:]/g, "-");
    const stampedMarkdownPath = path.join(
      repoRoot,
      ".tmp",
      `household-agenda-suites-${timestampSuffix}.md`
    );
    fs.writeFileSync(stampedMarkdownPath, `${markdown}\n`, "utf8");

    if (stepSummaryFile) {
      fs.appendFileSync(stepSummaryFile, `${markdown}\n`, "utf8");
      console.log(`[household-agenda:summary] wrote GitHub step summary: ${stepSummaryFile}`);
    }

    console.log(
      `[household-agenda:summary] missing summary artifact; generated fallback markdown ${path.relative(repoRoot, latestMarkdownPath)}`
    );
    return;
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

  if (stepSummaryFile) {
    fs.appendFileSync(stepSummaryFile, markdown, "utf8");
    console.log(`[household-agenda:summary] wrote GitHub step summary: ${stepSummaryFile}`);
  }

  console.log(
    `[household-agenda:summary] generated ${path.relative(repoRoot, latestMarkdownPath)} and ${path.relative(repoRoot, stampedMarkdownPath)}`
  );
}

run();

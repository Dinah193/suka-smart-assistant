#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function fail(msg) {
  console.error(`[browser-smoke:publish-latest] ${msg}`);
  process.exit(1);
}

function run() {
  const repoRoot = process.cwd();
  const sourceRel =
    process.argv.find((x) => x.startsWith("--source="))?.slice("--source=".length) ||
    "docs/qa/consolidated-smoke-report-2026-03-19-rerun.json";
  const targetRel =
    process.argv.find((x) => x.startsWith("--target="))?.slice("--target=".length) ||
    "docs/qa/consolidated-smoke-browser-report-latest.json";

  const sourcePath = path.join(repoRoot, sourceRel);
  const targetPath = path.join(repoRoot, targetRel);

  if (!fs.existsSync(sourcePath)) {
    fail(`Missing source report: ${sourceRel}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  } catch (err) {
    fail(`Invalid JSON in source report: ${err?.message || err}`);
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(parsed, null, 2));

  console.log(
    `[browser-smoke:publish-latest] Updated ${path.relative(repoRoot, targetPath)} from ${path.relative(repoRoot, sourcePath)}`
  );
}

run();

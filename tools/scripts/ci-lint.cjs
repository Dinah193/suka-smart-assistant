#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const cwd = process.cwd();
const eslintBin = resolve(cwd, "node_modules", "eslint", "bin", "eslint.js");
const configCandidates = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  "eslint.config.js",
  "eslint.config.cjs",
  "eslint.config.mjs",
].map((f) => resolve(cwd, f));

const hasConfig = configCandidates.some((f) => existsSync(f));
if (!existsSync(eslintBin)) {
  console.error("[lint:ci] eslint is required but not installed.");
  process.exit(1);
}

if (!hasConfig) {
  console.error("[lint:ci] eslint config is required but not found.");
  process.exit(1);
}

const lintTargets = [
  "tools/scripts/**/*.cjs",
  "src/server/db/adapters/**/*.js",
  "src/services/mongodb/**/*.js",
  "_tests_/nutritionMongoAdapter.contract.test.js",
];

const result = spawnSync(
  process.execPath,
  [eslintBin, ...lintTargets, "--max-warnings=0", "--no-error-on-unmatched-pattern"],
  {
  cwd,
  stdio: "inherit",
  }
);

process.exit(typeof result.status === "number" ? result.status : 1);

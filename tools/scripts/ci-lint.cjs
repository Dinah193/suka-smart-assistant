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
  console.log("[lint:ci] eslint not installed yet; skipping lint gate scaffold.");
  process.exit(0);
}

if (!hasConfig) {
  console.log("[lint:ci] eslint config not found; skipping lint gate scaffold.");
  process.exit(0);
}

const result = spawnSync(process.execPath, [eslintBin, ".", "--max-warnings=0"], {
  cwd,
  stdio: "inherit",
});

process.exit(typeof result.status === "number" ? result.status : 1);

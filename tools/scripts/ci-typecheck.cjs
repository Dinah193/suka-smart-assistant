#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const cwd = process.cwd();
const tsconfig = resolve(cwd, "tsconfig.json");
const tscBin = resolve(cwd, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsconfig)) {
  console.error("[typecheck:ci] tsconfig.json is required but was not found.");
  process.exit(1);
}

if (!existsSync(tscBin)) {
  console.error("[typecheck:ci] typescript is required but not installed.");
  process.exit(1);
}

const result = spawnSync(process.execPath, [tscBin, "--noEmit", "--pretty", "false"], {
  cwd,
  stdio: "inherit",
});

process.exit(typeof result.status === "number" ? result.status : 1);

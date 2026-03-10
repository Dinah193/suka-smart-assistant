#!/usr/bin/env node

const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

const cwd = process.cwd();
const tsconfig = resolve(cwd, "tsconfig.json");
const tscBin = resolve(cwd, "node_modules", "typescript", "bin", "tsc");

if (!existsSync(tsconfig)) {
  console.log("[typecheck:ci] tsconfig.json not found; skipping typecheck gate scaffold.");
  process.exit(0);
}

if (!existsSync(tscBin)) {
  console.log("[typecheck:ci] typescript not installed yet; skipping typecheck gate scaffold.");
  process.exit(0);
}

const result = spawnSync(process.execPath, [tscBin, "--noEmit"], {
  cwd,
  stdio: "inherit",
});

process.exit(typeof result.status === "number" ? result.status : 1);

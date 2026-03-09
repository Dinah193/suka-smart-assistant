#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = process.cwd();
const TMP_DIR = path.join(ROOT, ".tmp");
const EXIT_MARKER_RE = /BUILD_EXIT:(\d+)/g;

function pad(n) {
  return String(n).padStart(2, "0");
}

function timestampForFile(d = new Date()) {
  const yyyy = d.getFullYear();
  const mm = pad(d.getMonth() + 1);
  const dd = pad(d.getDate());
  const hh = pad(d.getHours());
  const mi = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function ensureTmpDir() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

function resolveViteBin() {
  const direct = path.join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (fs.existsSync(direct)) return direct;

  // Fallback for alternate layouts.
  const vitePkg = require.resolve("vite/package.json", { paths: [ROOT] });
  const viaPkgDir = path.join(path.dirname(vitePkg), "bin", "vite.js");
  if (fs.existsSync(viaPkgDir)) return viaPkgDir;

  throw new Error("Unable to resolve vite binary path");
}

function latestBuildLog() {
  if (!fs.existsSync(TMP_DIR)) return null;
  const files = fs
    .readdirSync(TMP_DIR)
    .filter((name) => /^build\.mem\.[0-9]{8}-[0-9]{6}\.log$/.test(name))
    .map((name) => ({
      name,
      abs: path.join(TMP_DIR, name),
      mtime: fs.statSync(path.join(TMP_DIR, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].abs : null;
}

function parseExitMarker(logPath) {
  const text = fs.readFileSync(logPath, "utf8");
  const matches = [...text.matchAll(EXIT_MARKER_RE)];
  if (!matches.length) {
    return { ok: false, code: null, reason: "No BUILD_EXIT marker found" };
  }
  const last = matches[matches.length - 1];
  const code = Number(last[1]);
  if (!Number.isInteger(code) || code < 0) {
    return { ok: false, code: null, reason: "Invalid BUILD_EXIT marker value" };
  }
  return { ok: true, code };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage:",
      "  node tools/scripts/build-mem-verify.cjs",
      "  node tools/scripts/build-mem-verify.cjs --parse-latest",
      "",
      "Behavior:",
      "  - Runs Vite build with --max-old-space-size=6144",
      "  - Streams output to terminal and timestamped .tmp log",
      "  - Appends BUILD_EXIT:<code>",
      "  - Parses marker and exits with parsed code",
    ].join("\n") + "\n"
  );
}

async function runBuildAndVerify() {
  ensureTmpDir();
  const logPath = path.join(TMP_DIR, `build.mem.${timestampForFile()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const viteBin = resolveViteBin();
  const args = ["--max-old-space-size=6144", viteBin, "build"];

  process.stdout.write(`[build:mem:verify] log: ${logPath}\n`);
  process.stdout.write(`[build:mem:verify] cmd: node ${args.join(" ")}\n`);

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", (buf) => {
    logStream.write(buf);
    process.stdout.write(buf);
  });

  child.stderr.on("data", (buf) => {
    logStream.write(buf);
    process.stderr.write(buf);
  });

  const code = await new Promise((resolve) => {
    child.on("close", (exitCode) => resolve(Number(exitCode ?? 1)));
    child.on("error", () => resolve(1));
  });

  logStream.write(`\nBUILD_EXIT:${code}\n`);
  logStream.end();

  const parsed = parseExitMarker(logPath);
  if (!parsed.ok) {
    process.stderr.write(
      `[build:mem:verify] parse failed for ${logPath}: ${parsed.reason}\n`
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write(
    `[build:mem:verify] parsed marker BUILD_EXIT:${parsed.code} (${logPath})\n`
  );
  process.exitCode = parsed.code;
}

function parseLatestOnly() {
  const latest = latestBuildLog();
  if (!latest) {
    process.stderr.write("[build:mem:verify] no build.mem.*.log files found under .tmp\n");
    process.exitCode = 1;
    return;
  }

  const parsed = parseExitMarker(latest);
  if (!parsed.ok) {
    process.stderr.write(`[build:mem:verify] ${latest}: ${parsed.reason}\n`);
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`[build:mem:verify] latest ${path.basename(latest)} => BUILD_EXIT:${parsed.code}\n`);
  process.exitCode = parsed.code;
}

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  printUsage();
} else if (args.has("--parse-latest")) {
  parseLatestOnly();
} else {
  runBuildAndVerify().catch((err) => {
    process.stderr.write(`[build:mem:verify] fatal: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
}

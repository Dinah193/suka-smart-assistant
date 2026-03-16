"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function run() {
  const repoRoot = process.cwd();
  const tmpDir = path.resolve(repoRoot, ".tmp");
  ensureDir(tmpDir);

  const logPath = path.resolve(tmpDir, `ui-build-${timestamp()}.log`);
  const stream = fs.createWriteStream(logPath, { flags: "w" });

  stream.write(`[verify-ui-build] started at ${new Date().toISOString()}\n`);
  stream.write(`[verify-ui-build] cwd: ${repoRoot}\n`);
  stream.write("[verify-ui-build] command: npm.cmd run build\n\n");

  const child = spawn("npm.cmd", ["run", "build"], {
    cwd: repoRoot,
    env: process.env,
    shell: false,
    windowsHide: true,
  });

  child.stdout.on("data", (chunk) => stream.write(chunk));
  child.stderr.on("data", (chunk) => stream.write(chunk));

  const result = await new Promise((resolve) => {
    child.on("error", (error) => {
      resolve({ code: 1, signal: null, error });
    });
    child.on("close", (code, signal) => {
      resolve({ code: Number(code || 0), signal, error: null });
    });
  });

  stream.write("\n");
  stream.write(`[verify-ui-build] finished at ${new Date().toISOString()}\n`);
  stream.write(`[verify-ui-build] exitCode: ${result.code}\n`);
  if (result.signal) stream.write(`[verify-ui-build] signal: ${result.signal}\n`);
  if (result.error) stream.write(`[verify-ui-build] error: ${String(result.error.message || result.error)}\n`);
  stream.end();

  // Print a concise machine-readable summary to terminal.
  process.stdout.write(
    `${JSON.stringify({ ok: result.code === 0, exitCode: result.code, logPath })}\n`
  );

  process.exit(result.code === 0 ? 0 : result.code || 1);
}

run().catch((error) => {
  process.stderr.write(`[verify-ui-build] fatal: ${String(error.message || error)}\n`);
  process.exit(1);
});

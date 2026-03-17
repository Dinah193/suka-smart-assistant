"use strict";

const { spawn } = require("node:child_process");

function shouldSkip(name) {
  return String(process.env[name] || "false").toLowerCase() === "true";
}

function runNpmScript(name) {
  return new Promise((resolve, reject) => {
    const child = spawn(`npm run ${name}`, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: true,
    });

    child.on("error", (error) => reject(error));
    child.on("exit", (code, signal) => {
      if (code === 0) return resolve();
      return reject(new Error(`script_failed:${name}:exit=${code}:signal=${signal || "none"}`));
    });
  });
}

async function main() {
  const steps = [
    { name: "db:preflight", skipEnv: "SSA_PREFLIGHT_SKIP_DB" },
    { name: "neo4j:preflight", skipEnv: "SSA_PREFLIGHT_SKIP_NEO4J" },
    { name: "gate:fast", skipEnv: "SSA_PREFLIGHT_SKIP_FAST" },
  ];

  for (const step of steps) {
    if (shouldSkip(step.skipEnv)) continue;
    await runNpmScript(step.name);
  }

  process.stdout.write(`${JSON.stringify({ ok: true, ranAt: new Date().toISOString() })}\n`);
}

main().catch((error) => {
  process.stderr.write(`[integration:preflight] Failed: ${String(error?.message || error)}\n`);
  process.exit(1);
});

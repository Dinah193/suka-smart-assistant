"use strict";

const { spawn } = require("node:child_process");

function shouldSkip(name) {
  return String(process.env[name] || "false").toLowerCase() === "true";
}

function parseMsEnv(name, fallback, min = 1000) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`invalid_${name}: must be a number >= ${min}`);
  }
  return Math.floor(value);
}

function classifyIntegrationPreflightError(error) {
  const message = String(error?.message || error || "unknown_error");

  if (message.startsWith("invalid_")) return { category: "config", reason: message };
  if (message.startsWith("step_timeout:")) return { category: "timeout", reason: "step_timeout" };
  if (message.startsWith("total_timeout:")) return { category: "timeout", reason: "total_timeout" };
  if (message.includes("db:preflight")) return { category: "dependency", reason: "db_preflight_failed" };
  if (message.includes("neo4j:preflight")) return { category: "dependency", reason: "neo4j_preflight_failed" };
  if (message.includes("gate:fast")) return { category: "quality_gate", reason: "fast_gate_failed" };

  return { category: "unknown", reason: "unclassified" };
}

function runNpmScript(name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(`npm run ${name}`, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      shell: true,
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // no-op
      }
      reject(new Error(`step_timeout:${name}:${timeoutMs}ms`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      return reject(new Error(`script_failed:${name}:exit=${code}:signal=${signal || "none"}`));
    });
  });
}

async function main() {
  const startedAt = Date.now();
  const totalTimeoutMs = parseMsEnv("INTEGRATION_PREFLIGHT_TOTAL_TIMEOUT_MS", 420000, 10000);
  const stepTimeoutMs = parseMsEnv("INTEGRATION_PREFLIGHT_STEP_TIMEOUT_MS", 180000, 10000);

  const steps = [
    { name: "db:preflight", skipEnv: "SSA_PREFLIGHT_SKIP_DB" },
    { name: "neo4j:preflight", skipEnv: "SSA_PREFLIGHT_SKIP_NEO4J" },
    { name: "gate:fast", skipEnv: "SSA_PREFLIGHT_SKIP_FAST" },
  ];

  const ran = [];
  for (const step of steps) {
    if (shouldSkip(step.skipEnv)) continue;
    const elapsed = Date.now() - startedAt;
    if (elapsed >= totalTimeoutMs) {
      throw new Error(`total_timeout:${elapsed}ms >= ${totalTimeoutMs}ms`);
    }

    const remaining = totalTimeoutMs - elapsed;
    await runNpmScript(step.name, Math.min(stepTimeoutMs, remaining));
    ran.push(step.name);
  }

  process.stdout.write(
    `${JSON.stringify({ ok: true, ranAt: new Date().toISOString(), totalTimeoutMs, stepTimeoutMs, ran })}\n`
  );
}

main().catch((error) => {
  const message = String(error?.message || error || "unknown_error");
  const classification = classifyIntegrationPreflightError(error);
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      script: "integration:preflight",
      category: classification.category,
      reason: classification.reason,
      error: message,
      failedAt: new Date().toISOString(),
    })}\n`
  );
  process.exit(1);
});

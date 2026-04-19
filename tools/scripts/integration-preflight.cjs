"use strict";

const { spawn } = require("node:child_process");

function shouldSkip(name) {
  return String(process.env[name] || "false").toLowerCase() === "true";
}

function shouldDryRun() {
  return String(process.env.INTEGRATION_PREFLIGHT_DRY_RUN || "false").toLowerCase() === "true";
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

function classifyByMessage(message) {
  const text = String(message || "").toLowerCase();
  if (!text) {
    return { category: "unknown", reason: "unclassified", subsystem: "unknown" };
  }

  if (
    text.includes("invalid credential")
    || text.includes("authentication")
    || text.includes("auth")
    || text.includes("password")
    || text.includes("unauthorized")
  ) {
    return { category: "auth", reason: "authentication_failed", subsystem: "credential" };
  }

  if (
    text.includes("econnrefused")
    || text.includes("enotfound")
    || text.includes("eai_again")
    || text.includes("econnreset")
    || text.includes("etimedout")
    || text.includes("network")
    || text.includes("connect")
  ) {
    return { category: "network", reason: "service_connectivity_failure", subsystem: "transport" };
  }

  if (text.includes("required") || text.includes("missing") || text.includes("not configured")) {
    return { category: "dependency", reason: "required_service_unavailable", subsystem: "required_service" };
  }

  return { category: "unknown", reason: "unclassified", subsystem: "unknown" };
}

function parseLastJsonLine(rawOutput) {
  const text = String(rawOutput || "").trim();
  if (!text) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!(line.startsWith("{") && line.endsWith("}"))) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning earlier lines.
    }
  }

  return null;
}

function classifyIntegrationPreflightError(error) {
  const message = String(error?.message || error || "unknown_error");

  const stepName = String(error?.stepName || "");
  const stepTelemetry = error?.stepTelemetry && typeof error.stepTelemetry === "object"
    ? error.stepTelemetry
    : null;
  const stepErrorMessage = String(stepTelemetry?.error || "");

  if (stepTelemetry?.category && stepTelemetry?.reason) {
    return {
      category: String(stepTelemetry.category),
      reason: String(stepTelemetry.reason),
      subsystem: String(stepTelemetry.subsystem || stepName || "unknown"),
      failedStep: stepName || null,
    };
  }

  if (message.startsWith("invalid_")) return { category: "config", reason: message };
  if (message.startsWith("step_timeout:")) {
    return {
      category: "timeout",
      reason: "step_timeout",
      subsystem: stepName || "integration_preflight",
      failedStep: stepName || null,
    };
  }
  if (message.startsWith("total_timeout:")) {
    return {
      category: "timeout",
      reason: "total_timeout",
      subsystem: "integration_preflight",
      failedStep: null,
    };
  }

  if (stepName === "db:preflight") {
    const inferred = classifyByMessage(stepErrorMessage || message);
    return {
      category: inferred.category,
      reason: inferred.reason === "unclassified" ? "db_preflight_failed" : inferred.reason,
      subsystem: inferred.subsystem === "unknown" ? "db:preflight" : inferred.subsystem,
      failedStep: stepName,
    };
  }
  if (stepName === "neo4j:preflight") {
    const inferred = classifyByMessage(stepErrorMessage || message);
    return {
      category: inferred.category,
      reason: inferred.reason === "unclassified" ? "neo4j_preflight_failed" : inferred.reason,
      subsystem: inferred.subsystem === "unknown" ? "neo4j" : inferred.subsystem,
      failedStep: stepName,
    };
  }
  if (stepName === "gate:fast") {
    return {
      category: "quality_gate",
      reason: "fast_gate_failed",
      subsystem: "gate:fast",
      failedStep: stepName,
    };
  }

  if (message.includes("db:preflight")) {
    return { category: "dependency", reason: "db_preflight_failed", subsystem: "db:preflight", failedStep: "db:preflight" };
  }
  if (message.includes("neo4j:preflight")) {
    return { category: "dependency", reason: "neo4j_preflight_failed", subsystem: "neo4j", failedStep: "neo4j:preflight" };
  }
  if (message.includes("gate:fast")) {
    return { category: "quality_gate", reason: "fast_gate_failed", subsystem: "gate:fast", failedStep: "gate:fast" };
  }

  return { category: "unknown", reason: "unclassified", subsystem: "integration_preflight", failedStep: stepName || null };
}

function runNpmScript(name, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(`npm run ${name}`, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk || "");
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk || "");
      stderr += text;
      process.stderr.write(text);
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

      const err = new Error(`script_failed:${name}:exit=${code}:signal=${signal || "none"}`);
      err.stepName = name;
      err.stepOutput = `${stdout}\n${stderr}`.trim();
      err.stepTelemetry = parseLastJsonLine(err.stepOutput);
      return reject(err);
    });
  });
}

async function main() {
  const startedAt = Date.now();
  const totalTimeoutMs = parseMsEnv("INTEGRATION_PREFLIGHT_TOTAL_TIMEOUT_MS", 540000, 10000);
  const stepTimeoutMs = parseMsEnv("INTEGRATION_PREFLIGHT_STEP_TIMEOUT_MS", 240000, 10000);

  const steps = [
    { name: "db:preflight", skipEnv: "SSA_PREFLIGHT_SKIP_DB" },
    { name: "neo4j:preflight", skipEnv: "SSA_PREFLIGHT_SKIP_NEO4J" },
    { name: "gate:fast", skipEnv: "SSA_PREFLIGHT_SKIP_FAST" },
  ];

  if (shouldDryRun()) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        dryRun: true,
        ranAt: new Date().toISOString(),
        totalTimeoutMs,
        stepTimeoutMs,
        steps: steps.map((step) => ({ name: step.name, skipEnv: step.skipEnv })),
        timeoutEnv: {
          total: "INTEGRATION_PREFLIGHT_TOTAL_TIMEOUT_MS",
          step: "INTEGRATION_PREFLIGHT_STEP_TIMEOUT_MS",
        },
      })}\n`
    );
    return;
  }

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
  const failedStep = String(error?.stepName || classification.failedStep || "") || null;

  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      script: "integration:preflight",
      category: classification.category,
      reason: classification.reason,
      subsystem: classification.subsystem || "integration_preflight",
      failedStep,
      stepTelemetry: error?.stepTelemetry && typeof error.stepTelemetry === "object"
        ? error.stepTelemetry
        : null,
      error: message,
      failedAt: new Date().toISOString(),
    })}\n`
  );
  process.exit(1);
});

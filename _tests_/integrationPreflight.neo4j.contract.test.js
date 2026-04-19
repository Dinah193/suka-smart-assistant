import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

function runIntegrationPreflight(envOverrides = {}) {
  return new Promise((resolve) => {
    const scriptPath = path.resolve(process.cwd(), "tools", "scripts", "integration-preflight.cjs");
    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...envOverrides,
      },
      shell: false,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk || "");
    });

    child.stderr.on("data", (chunk) => {
      stderr += String(chunk || "");
    });

    child.on("exit", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function parseLastJson(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => String(line || "").trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!(line.startsWith("{") && line.endsWith("}"))) continue;
    try {
      return JSON.parse(line);
    } catch {
      // Keep scanning prior lines for JSON payloads.
    }
  }

  return null;
}

describe("integration:preflight neo4j contract", () => {
  it("prints timeout config in dry-run mode", async () => {
    const out = await runIntegrationPreflight({
      INTEGRATION_PREFLIGHT_DRY_RUN: "true",
      INTEGRATION_PREFLIGHT_TOTAL_TIMEOUT_MS: "650000",
      INTEGRATION_PREFLIGHT_STEP_TIMEOUT_MS: "210000",
    });

    expect(out.code).toBe(0);
    const payload = parseLastJson(out.stdout);
    expect(payload).toBeTruthy();
    expect(payload?.dryRun).toBe(true);
    expect(payload?.totalTimeoutMs).toBe(650000);
    expect(payload?.stepTimeoutMs).toBe(210000);
    expect(Array.isArray(payload?.steps)).toBe(true);
  });

  it("passes when Neo4j is unavailable but not required", async () => {
    const out = await runIntegrationPreflight({
      SSA_PREFLIGHT_SKIP_DB: "true",
      SSA_PREFLIGHT_SKIP_FAST: "true",
      SSA_PREFLIGHT_SKIP_NEO4J: "false",
      NEO4J_ENABLED: "true",
      NEO4J_REQUIRED: "false",
      NEO4J_URI: "bolt://127.0.0.1:9",
      NEO4J_USER: "neo4j",
      NEO4J_PASSWORD: "neo4j",
    });

    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/"ok":\s*true/);
  });

  it("fails when Neo4j is unavailable and required", async () => {
    const out = await runIntegrationPreflight({
      SSA_PREFLIGHT_SKIP_DB: "true",
      SSA_PREFLIGHT_SKIP_FAST: "true",
      SSA_PREFLIGHT_SKIP_NEO4J: "false",
      NEO4J_ENABLED: "true",
      NEO4J_REQUIRED: "true",
      NEO4J_URI: "bolt://127.0.0.1:9",
      NEO4J_USER: "neo4j",
      NEO4J_PASSWORD: "neo4j",
    });

    expect(out.code).toBe(1);
    const telemetry = parseLastJson(out.stderr);
    expect(telemetry).toBeTruthy();
    expect(telemetry?.script).toBe("integration:preflight");
    expect(telemetry?.failedStep).toBe("neo4j:preflight");
    expect(typeof telemetry?.category).toBe("string");
    expect(typeof telemetry?.reason).toBe("string");
  });

  it("returns config classification for invalid timeout env", async () => {
    const out = await runIntegrationPreflight({
      INTEGRATION_PREFLIGHT_STEP_TIMEOUT_MS: "bad",
      SSA_PREFLIGHT_SKIP_DB: "true",
      SSA_PREFLIGHT_SKIP_FAST: "true",
      SSA_PREFLIGHT_SKIP_NEO4J: "true",
    });

    expect(out.code).toBe(1);
    const telemetry = parseLastJson(out.stderr);
    expect(telemetry).toBeTruthy();
    expect(telemetry?.script).toBe("integration:preflight");
    expect(telemetry?.category).toBe("config");
    expect(String(telemetry?.reason || "")).toMatch(/^invalid_INTEGRATION_PREFLIGHT_STEP_TIMEOUT_MS/);
  });
});

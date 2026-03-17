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

describe("integration:preflight neo4j contract", () => {
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
    expect(`${out.stdout}\n${out.stderr}`).toMatch(/neo4j|Failed|script_failed/i);
  });
});

"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadWorkspaceEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;

    const key = trimmed.slice(0, idx).trim();
    if (!key || process.env[key] != null) continue;

    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

async function main() {
  loadWorkspaceEnv();

  const required = String(process.env.NEO4J_REQUIRED || "false").toLowerCase() === "true";
  const plannerIntegration = require("../../src/server/services/planners/PlannerIntegrationService.js");

  if (typeof plannerIntegration.verifyNeo4jIntegration !== "function") {
    throw new Error("verifyNeo4jIntegration export missing from PlannerIntegrationService");
  }

  const status = await plannerIntegration.verifyNeo4jIntegration({ required });
  const out = {
    ok: !!status?.ok,
    required,
    checkedAt: new Date().toISOString(),
    status,
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(out.ok ? 0 : 1);
}

main().catch((error) => {
  const out = {
    ok: false,
    checkedAt: new Date().toISOString(),
    error: String(error?.message || error || "neo4j_preflight_failed"),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(1);
});

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

function parseMsEnv(name, fallback, min = 1000) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`invalid_${name}: must be a number >= ${min}`);
  }
  return Math.floor(value);
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new Error(`contract_violation:${field}_must_be_boolean`);
  }
}

function validateHealthPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("contract_violation:health_payload_not_object");
  }

  if (payload.ok !== true) {
    throw new Error("contract_violation:health_ok_not_true");
  }

  if (!payload.db || typeof payload.db !== "object") {
    throw new Error("contract_violation:db_block_missing");
  }
  assertBoolean(payload.db.connected, "db.connected");
  assertBoolean(payload.db.fallbackFileMode, "db.fallbackFileMode");
  assertBoolean(payload.db.uriConfigured, "db.uriConfigured");

  for (const block of ["mongo", "postgres", "neo4j"]) {
    if (!payload[block] || typeof payload[block] !== "object") {
      throw new Error(`contract_violation:${block}_block_missing`);
    }
    assertBoolean(payload[block].ok, `${block}.ok`);
    assertBoolean(payload[block].required, `${block}.required`);
    assertBoolean(payload[block].connected, `${block}.connected`);
  }
}

function classifyError(error) {
  const message = String(error?.message || error || "unknown_error");
  if (message.startsWith("invalid_")) return { category: "config", reason: message };
  if (message.includes("missing_PRODUCTION_HEALTH_URL")) return { category: "config", reason: "missing_health_url" };
  if (message.includes("missing_VERCEL_PROTECTION_BYPASS")) return { category: "config", reason: "missing_bypass_secret" };
  if (message.startsWith("http_401")) return { category: "auth", reason: "unauthorized" };
  if (message.startsWith("http_")) return { category: "http", reason: "unexpected_status" };
  if (message.startsWith("contract_violation:")) return { category: "contract", reason: "health_contract_violation" };
  if (message.startsWith("invalid_json:")) return { category: "contract", reason: "invalid_json" };
  if (message.startsWith("network_error:")) return { category: "network", reason: "network_error" };
  if (message.startsWith("max_wait_exceeded:")) return { category: "timeout", reason: "max_wait_exceeded" };
  return { category: "unknown", reason: "unclassified" };
}

async function checkOnce(url, headers) {
  let response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    throw new Error(`network_error:${String(error?.message || error)}`);
  }

  const body = await response.text();
  if (response.status === 401) {
    throw new Error("http_401:unauthorized");
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`http_${response.status}:${body.slice(0, 200)}`);
  }

  let payload;
  try {
    payload = body ? JSON.parse(body) : null;
  } catch (error) {
    throw new Error(`invalid_json:${String(error?.message || error)}`);
  }

  validateHealthPayload(payload);
  return payload;
}

async function main() {
  loadWorkspaceEnv();

  const url = String(process.env.PRODUCTION_HEALTH_URL || "").trim();
  if (!url) throw new Error("missing_PRODUCTION_HEALTH_URL");

  const requireBypass = String(process.env.REQUIRE_VERCEL_PROTECTION_BYPASS || "true").toLowerCase() !== "false";
  const bypassSecret = String(process.env.VERCEL_PROTECTION_BYPASS || "").trim();
  if (requireBypass && !bypassSecret) {
    throw new Error("missing_VERCEL_PROTECTION_BYPASS");
  }

  const maxWaitMs = parseMsEnv("PRODUCTION_HEALTH_MAX_WAIT_MS", 180000, 5000);
  const intervalMs = parseMsEnv("PRODUCTION_HEALTH_RETRY_INTERVAL_MS", 5000, 1000);

  const headers = {};
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
    headers["x-vercel-set-bypass-cookie"] = "true";
  }

  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < maxWaitMs) {
    try {
      const payload = await checkOnce(url, headers);
      process.stdout.write(
        `${JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), url, maxWaitMs, intervalMs, payload })}\n`
      );
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  throw new Error(`max_wait_exceeded:${maxWaitMs}:${String(lastError?.message || lastError || "unknown")}`);
}

main().catch((error) => {
  const message = String(error?.message || error || "unknown_error");
  const classification = classifyError(error);
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      script: "prod:health:verify",
      category: classification.category,
      reason: classification.reason,
      error: message,
      failedAt: new Date().toISOString(),
    })}\n`
  );
  process.exit(1);
});

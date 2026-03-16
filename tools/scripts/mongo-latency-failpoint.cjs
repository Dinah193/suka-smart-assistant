"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");

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

function resolveMongoUri() {
  return (
    process.env.MONGODB_URI ||
    process.env.MONGO_URI ||
    process.env.MONGO_URL ||
    ""
  ).trim();
}

function parseArg(name, fallback) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const value = process.argv[idx + 1];
  if (typeof value !== "string" || value.startsWith("--")) return fallback;
  return value;
}

async function main() {
  loadWorkspaceEnv();

  const action = (process.argv[2] || "").trim().toLowerCase();
  if (action !== "enable" && action !== "disable") {
    console.error('Usage: node tools/scripts/mongo-latency-failpoint.cjs <enable|disable> [--delay-ms 450] [--times 500]');
    process.exit(2);
    return;
  }

  const uri = resolveMongoUri();
  if (!uri) {
    console.error("Mongo URI is not configured (MONGODB_URI/MONGO_URI/MONGO_URL)");
    process.exit(2);
    return;
  }

  const delayMs = Number(parseArg("--delay-ms", "450"));
  const times = Number(parseArg("--times", "500"));

  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
  });

  try {
    await client.connect();
    const admin = client.db("admin");

    if (action === "enable") {
      const command = {
        configureFailPoint: "failCommand",
        mode: { times },
        data: {
          failCommands: ["find", "aggregate", "count", "insert", "update", "findAndModify"],
          blockConnection: true,
          blockTimeMS: delayMs,
        },
      };
      const result = await admin.command(command);
      console.log(JSON.stringify({ ok: true, action, delayMs, times, result }));
    } else {
      const result = await admin.command({ configureFailPoint: "failCommand", mode: "off" });
      console.log(JSON.stringify({ ok: true, action, result }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        action,
        error: String(error?.message || error || "failpoint_error"),
      })
    );
    process.exit(1);
  } finally {
    try {
      await client.close();
    } catch {
      // no-op
    }
  }
}

main();

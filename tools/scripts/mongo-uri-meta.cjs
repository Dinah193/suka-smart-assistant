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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadWorkspaceEnv();
const uri = String(process.env.MONGODB_URI || process.env.MONGO_URI || process.env.MONGO_URL || "").trim();
if (!uri) {
  console.log(JSON.stringify({ ok: false, reason: "missing_uri" }));
  process.exit(1);
}

if (uri.startsWith("mongodb+srv://")) {
  const host = uri.slice("mongodb+srv://".length).split("/")[0].split("@").pop();
  console.log(JSON.stringify({ ok: true, protocol: "mongodb+srv", hostMasked: host ? `***@${host}` : "unknown" }));
  process.exit(0);
}

if (uri.startsWith("mongodb://")) {
  const hostPart = uri.slice("mongodb://".length).split("/")[0].split("@").pop();
  const hostCount = hostPart ? hostPart.split(",").length : 0;
  console.log(JSON.stringify({ ok: true, protocol: "mongodb", hostCount }));
  process.exit(0);
}

console.log(JSON.stringify({ ok: true, protocol: "unknown" }));

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");

function readMongoUri() {
  const envPath = path.resolve(process.cwd(), ".env");
  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("MONGODB_URI="));
  if (!line) throw new Error("MONGODB_URI not found in .env");
  return line.slice("MONGODB_URI=".length).trim().replace(/^['\"]|['\"]$/g, "");
}

function buildUri(rawMongoUri, host, port) {
  const u = new URL(rawMongoUri);
  const dbPath = u.pathname && u.pathname !== "/" ? u.pathname : "/suka";
  const auth = [u.username, u.password]
    .filter(Boolean)
    .map((part) => encodeURIComponent(decodeURIComponent(part)))
    .join(":");
  const authPart = auth ? `${auth}@` : "";
  const params = new URLSearchParams(u.search || "");
  if (!params.has("authSource")) params.set("authSource", "admin");
  if (!params.has("replicaSet")) {
    params.set("replicaSet", process.env.MONGO_REPLICA_SET || "atlas-uic0ty-shard-0");
  }
  params.set("directConnection", "true");
  params.set("tls", "true");
  params.set("tlsAllowInvalidHostnames", "true");
  const query = params.toString();
  return `mongodb://${authPart}${host}:${port}${dbPath}${query ? `?${query}` : ""}`;
}

(async () => {
  const host = process.env.TARGET_HOST;
  const port = Number(process.env.TARGET_PORT || 27017);
  if (!host) throw new Error("TARGET_HOST required");

  const uri = buildUri(readMongoUri(), host, port);
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000 });

  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log(JSON.stringify({ ok: true, host, port }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, host, port, error: String(error?.message || error || "connect_failed") }));
    process.exit(1);
  } finally {
    try { await client.close(); } catch {}
  }
})();

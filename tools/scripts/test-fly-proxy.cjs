"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { MongoClient } = require("mongodb");

function readMongoUri() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env not found");
  }

  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("MONGODB_URI="));

  if (!line) throw new Error("MONGODB_URI not found in .env");

  return line
    .slice("MONGODB_URI=".length)
    .trim()
    .replace(/^['\"]|['\"]$/g, "");
}

function buildProxyUri(rawMongoUri, proxyHost) {
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
  params.set("tls", "false");
  params.delete("tlsAllowInvalidHostnames");
  const query = params.toString();

  return `mongodb://${authPart}${proxyHost}:27017${dbPath}${query ? `?${query}` : ""}`;
}

(async () => {
  const proxyHost = process.env.FLY_PROXY_HOST || "suka-mongo-latency-03150646.fly.dev";
  const rawMongoUri = readMongoUri();
  const proxyUri = buildProxyUri(rawMongoUri, proxyHost);

  const client = new MongoClient(proxyUri, {
    serverSelectionTimeoutMS: 12000,
  });

  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log(JSON.stringify({ ok: true, proxyHost }));
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        proxyHost,
        error: String(error?.message || error || "proxy_ping_failed"),
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
})();

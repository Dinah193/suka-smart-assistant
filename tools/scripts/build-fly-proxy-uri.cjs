"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readMongoUri() {
  const envPath = path.resolve(process.cwd(), ".env");
  const line = fs
    .readFileSync(envPath, "utf8")
    .split(/\r?\n/)
    .find((l) => l.startsWith("MONGODB_URI="));
  if (!line) throw new Error("MONGODB_URI not found in .env");
  return line.slice("MONGODB_URI=".length).trim().replace(/^['\"]|['\"]$/g, "");
}

function buildProxyUri(rawMongoUri, proxyHost, proxyPort) {
  const u = new URL(rawMongoUri);
  const dbPath = u.pathname && u.pathname !== "/" ? u.pathname : "/suka";

  const auth = [u.username, u.password]
    .filter(Boolean)
    .map((part) => encodeURIComponent(decodeURIComponent(part)))
    .join(":");
  const authPart = auth ? `${auth}@` : "";

  const params = new URLSearchParams(u.search || "");
  if (!params.has("authSource")) params.set("authSource", "admin");
  if (!params.has("replicaSet")) params.set("replicaSet", process.env.MONGO_REPLICA_SET || "atlas-uic0ty-shard-0");
  params.set("directConnection", "true");
  params.set("tls", "false");
  params.delete("tlsAllowInvalidHostnames");

  return `mongodb://${authPart}${proxyHost}:${proxyPort}${dbPath}?${params.toString()}`;
}

const proxyHost = process.env.FLY_PROXY_HOST || "50.31.246.205";
const proxyPort = Number(process.env.FLY_PROXY_PORT || 27017);
const rawMongoUri = readMongoUri();
const proxyUri = buildProxyUri(rawMongoUri, proxyHost, proxyPort);
console.log(proxyUri);

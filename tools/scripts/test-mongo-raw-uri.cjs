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
  if (!line) throw new Error("MONGODB_URI not found");
  return line.slice("MONGODB_URI=".length).trim().replace(/^['\"]|['\"]$/g, "");
}

(async () => {
  const uri = readMongoUri();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 12000 });
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }));
    process.exit(1);
  } finally {
    try { await client.close(); } catch {}
  }
})();

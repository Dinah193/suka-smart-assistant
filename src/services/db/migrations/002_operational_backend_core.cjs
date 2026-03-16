"use strict";

const fs = require("node:fs");
const path = require("node:path");

function readSqlFile(fileName) {
  const filePath = path.resolve(__dirname, "..", fileName);
  return {
    fileName,
    filePath,
    sql: fs.readFileSync(filePath, "utf8"),
  };
}

module.exports = {
  id: "002_operational_backend_core",
  description: "Apply operational backend schema with audit/outbox/readiness support",
  async up(client) {
    const { sql } = readSqlFile("operational.schema.sql");
    await client.query(sql);
  },
};

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
  id: "004_operational_outbox_observability_config",
  description: "Create outbox observability config table for durable threshold overrides",
  async up(client) {
    const { sql } = readSqlFile("operational.outbox.hardening.sql");
    await client.query(sql);
  },
};

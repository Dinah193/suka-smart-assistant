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
  id: "003_operational_outbox_hardening",
  description: "Add outbox lease, heartbeat, dead-letter fields and constraints",
  async up(client) {
    const { sql } = readSqlFile("operational.outbox.hardening.sql");
    await client.query(sql);
  },
};
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_FILES = [
  "mealplanner.schema.sql",
  "storehouse.schema.sql",
  "preservation.schema.sql",
  "homestead.schema.sql",
];

function readSqlFile(fileName) {
  const filePath = path.resolve(__dirname, "..", fileName);
  return {
    fileName,
    filePath,
    sql: fs.readFileSync(filePath, "utf8"),
  };
}

module.exports = {
  id: "001_planner_core_baseline",
  description: "Apply core planner PostgreSQL schema files",
  async up(client) {
    for (const fileName of SCHEMA_FILES) {
      const { sql } = readSqlFile(fileName);
      await client.query(sql);
    }
  },
};

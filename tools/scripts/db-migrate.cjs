"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

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

function resolveConnectionString() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;

  const host = process.env.PGHOST;
  const port = process.env.PGPORT || "5432";
  const user = process.env.PGUSER;
  const pass = process.env.PGPASSWORD;
  const db = process.env.PGDATABASE;

  if (host && user && pass && db) {
    return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}/${db}`;
  }

  return "";
}

function getMigrationsDir() {
  return path.resolve(process.cwd(), "src", "services", "db", "migrations");
}

function hashFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function loadMigrations() {
  const dir = getMigrationsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(".cjs"))
    .sort((a, b) => a.localeCompare(b));

  return files.map((name) => {
    const filePath = path.join(dir, name);
    const mod = require(filePath);
    const id = String(mod?.id || name.replace(/\.cjs$/i, "")).trim();
    if (!id) throw new Error(`Invalid migration id in ${name}`);
    if (typeof mod?.up !== "function") {
      throw new Error(`Migration ${id} is missing an up(client) function`);
    }

    return {
      id,
      description: mod?.description ? String(mod.description) : null,
      up: mod.up,
      checksum: hashFile(filePath),
      filePath,
    };
  });
}

async function ensureSchemaMigrationsTable(client) {
  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      checksum text not null,
      description text,
      applied_at timestamptz not null default now()
    )
  `);
}

async function loadAppliedMigrations(client) {
  const { rows } = await client.query(
    "select id, checksum, description, applied_at from schema_migrations"
  );

  const map = new Map();
  for (const row of rows) {
    map.set(String(row.id), row);
  }
  return map;
}

async function applyMigration(client, migration) {
  await client.query("begin");
  try {
    await migration.up(client);
    await client.query(
      `
      insert into schema_migrations (id, checksum, description)
      values ($1, $2, $3)
      `,
      [migration.id, migration.checksum, migration.description]
    );
    await client.query("commit");
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      // keep original error
    }
    throw error;
  }
}

async function main() {
  loadWorkspaceEnv();
  const connectionString = resolveConnectionString();

  if (!connectionString) {
    console.error(
      "[db:migrate] Missing DB connection. Set DATABASE_URL or PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE, or add them to .env"
    );
    process.exit(1);
  }

  const migrations = loadMigrations();
  const client = new Client({ connectionString });
  await client.connect();

  try {
    await ensureSchemaMigrationsTable(client);
    const applied = await loadAppliedMigrations(client);

    const appliedIds = [];
    const skippedIds = [];

    for (const migration of migrations) {
      const prior = applied.get(migration.id);
      if (prior) {
        if (String(prior.checksum || "") !== migration.checksum) {
          throw new Error(
            `Checksum mismatch for already-applied migration ${migration.id}. Expected ${prior.checksum}, got ${migration.checksum}`
          );
        }
        skippedIds.push(migration.id);
        continue;
      }

      await applyMigration(client, migration);
      appliedIds.push(migration.id);
    }

    const result = {
      ok: true,
      migrations: {
        total: migrations.length,
        applied: appliedIds,
        skipped: skippedIds,
      },
    };

    console.log(JSON.stringify(result));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error("[db:migrate] Failed:", String(error?.message || error));
  process.exit(1);
});

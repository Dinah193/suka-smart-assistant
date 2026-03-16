"use strict";

const path = require("node:path");

function injectDbConnectionStub() {
  const dbConnPath = path.resolve(
    process.cwd(),
    "src",
    "server",
    "services",
    "dbConnection.js"
  );

  require.cache[dbConnPath] = {
    id: dbConnPath,
    filename: dbConnPath,
    loaded: true,
    exports: {
      async init() {
        return {
          driver: "mongoose",
          connected: false,
          readyState: 0,
          uriConfigured: false,
          fallbackFileMode: true,
          lastError: "simulated_unavailable",
        };
      },
      getStatus() {
        return {
          driver: "mongoose",
          connected: false,
          readyState: 0,
          uriConfigured: false,
          fallbackFileMode: true,
          lastError: "simulated_unavailable",
        };
      },
    },
  };
}

async function main() {
  injectDbConnectionStub();

  const adapterPath = path.resolve(
    process.cwd(),
    "src",
    "server",
    "db",
    "adapters",
    "nutrition.mongo.js"
  );

  delete require.cache[adapterPath];
  const adapter = require(adapterPath);

  const byId = await adapter.getById("food:rollback-test");
  const byName = await adapter.getByName("rollback-test");
  const write = await adapter.upsert({
    id: "food:rollback-test",
    normalizedName: "rollback test",
    displayName: "Rollback Test",
  });

  const out = {
    ok:
      byId?.ok === true &&
      byId?.data === null &&
      byName?.ok === true &&
      byName?.data === null &&
      write?.ok === false &&
      write?.error === "mongo_unavailable",
    checks: {
      byId,
      byName,
      write,
    },
  };

  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(out.ok ? 0 : 1);
}

main().catch((error) => {
  console.error("[nutrition-mongo-fallback-contract] Failed:", String(error?.message || error));
  process.exit(1);
});

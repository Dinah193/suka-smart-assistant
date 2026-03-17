import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(port, timeoutMs = 20000) {
  const started = Date.now();
  let lastErr = null;

  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return await res.json();
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }

  throw new Error(`health_timeout:${String(lastErr?.message || lastErr || "unknown")}`);
}

function startServerWithEnv(extraEnv = {}) {
  const port = randomPort();
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    STRICT_STARTUP_ENV: "false",
    NEO4J_REQUIRED: "false",
    MONGO_SERVER_SELECTION_TIMEOUT_MS: "100",
    ...extraEnv,
  };

  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let logs = "";
  child.stdout?.on("data", (buf) => {
    logs += String(buf || "");
  });
  child.stderr?.on("data", (buf) => {
    logs += String(buf || "");
  });

  return { child, port, getLogs: () => logs };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // no-op
      }
      resolve();
    }, 2000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    try {
      child.kill("SIGTERM");
    } catch {
      clearTimeout(timer);
      resolve();
    }
  });
}

describe("backend startup + db mode contract", () => {
  it(
    "reports file fallback mode when Mongo URI is not configured",
    async () => {
      const { child, port, getLogs } = startServerWithEnv({
        MONGODB_URI: "",
        MONGO_URI: "",
        MONGO_URL: "",
      });

      try {
        const health = await waitForHealth(port);
        expect(health.ok).toBe(true);
        expect(health.db?.driver).toBe("mongoose");
        expect(health.db?.uriConfigured).toBe(false);
        expect(health.db?.connected).toBe(false);
        expect(health.db?.fallbackFileMode).toBe(true);
        expect(typeof health.mongo?.ok).toBe("boolean");
        expect(typeof health.mongo?.required).toBe("boolean");
        expect(typeof health.mongo?.connected).toBe("boolean");
        expect(typeof health.postgres?.ok).toBe("boolean");
        expect(typeof health.postgres?.required).toBe("boolean");
        expect(typeof health.postgres?.connected).toBe("boolean");
        expect(typeof health.neo4j?.ok).toBe("boolean");
        expect(typeof health.neo4j?.required).toBe("boolean");
        expect(typeof health.neo4j?.connected).toBe("boolean");
      } finally {
        await stopServer(child);
      }

      const logs = getLogs();
      expect(logs.includes("file-fallback")).toBe(true);
    },
    20000,
  );

  it(
    "reports uriConfigured=true and fallback mode when Mongo URI is set but unreachable",
    async () => {
      const { child, port } = startServerWithEnv({
        MONGODB_URI: "mongodb://127.0.0.1:27099/suka_test?directConnection=true",
      });

      try {
        const health = await waitForHealth(port);
        expect(health.ok).toBe(true);
        expect(health.db?.driver).toBe("mongoose");
        expect(health.db?.uriConfigured).toBe(true);
        expect(health.db?.connected).toBe(false);
        expect(health.db?.fallbackFileMode).toBe(true);
        expect(typeof health.mongo?.ok).toBe("boolean");
        expect(typeof health.mongo?.required).toBe("boolean");
        expect(typeof health.mongo?.connected).toBe("boolean");
        expect(typeof health.postgres?.ok).toBe("boolean");
        expect(typeof health.postgres?.required).toBe("boolean");
        expect(typeof health.postgres?.connected).toBe("boolean");
        expect(typeof health.neo4j?.ok).toBe("boolean");
        expect(typeof health.neo4j?.required).toBe("boolean");
        expect(typeof health.neo4j?.connected).toBe("boolean");
      } finally {
        await stopServer(child);
      }
    },
    20000,
  );
});

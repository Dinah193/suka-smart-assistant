import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const serverEntry = path.resolve(repoRoot, "src/server/index.js");

const FEED_P95_MAX_MS = 1500;
const FEED_AVG_MAX_MS = 900;
const DASHBOARD_P95_MAX_MS = 1800;
const DASHBOARD_AVG_MAX_MS = 1100;
const SEARCH_P95_MAX_MS = 1600;
const SEARCH_AVG_MAX_MS = 1000;
const REQUEST_HARD_MAX_MS = 2500;

function randomPort() {
  return 41000 + Math.floor(Math.random() * 10000);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function createOutputCapture(child) {
  const stdout = [];
  const stderr = [];

  child.stdout?.on("data", (chunk) => {
    stdout.push(String(chunk));
    if (stdout.length > 60) stdout.shift();
  });

  child.stderr?.on("data", (chunk) => {
    stderr.push(String(chunk));
    if (stderr.length > 60) stderr.shift();
  });

  return {
    tail() {
      return {
        stdout: stdout.join("").slice(-3000),
        stderr: stderr.join("").slice(-3000),
      };
    },
  };
}

async function waitForHealth(port, child, outputCapture, timeoutMs = 30000) {
  const started = Date.now();
  const onExit = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ exited: true, code, signal });
    });
  });

  while (Date.now() - started < timeoutMs) {
    const exited = await Promise.race([onExit, sleep(0).then(() => null)]);
    if (exited?.exited) {
      const logs = outputCapture.tail();
      throw new Error(
        `server_exited_before_health code=${exited.code} signal=${exited.signal} stderr=${logs.stderr || "<empty>"} stdout=${logs.stdout || "<empty>"}`
      );
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // retry
    }

    await sleep(150);
  }

  const logs = outputCapture.tail();
  throw new Error(
    `health_timeout port=${port} timeoutMs=${timeoutMs} stderr=${logs.stderr || "<empty>"} stdout=${logs.stdout || "<empty>"}`
  );
}

function startServer() {
  const port = randomPort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      STRICT_STARTUP_ENV: "false",
      NEO4J_REQUIRED: "false",
      POSTGRES_REQUIRED: "false",
      MONGODB_REQUIRED: "false",
      SSA_DEV_AUTH_BYPASS: "true",
      SSA_DEV_POLICY_BYPASS: "true",
      PLANNER_OPERATIONAL_OUTBOX_WORKER_DISABLED: "true",
      MONGO_SERVER_SELECTION_TIMEOUT_MS: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const outputCapture = createOutputCapture(child);
  return { child, port, outputCapture };
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
      resolve();
    }, 2500);

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

function summarizeDurations(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const avg = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg,
    p95: sorted[p95Index],
  };
}

async function runLatencyProbe({
  url,
  warmupCount = 2,
  sampleCount = 8,
}) {
  const durations = [];

  for (let index = 0; index < warmupCount + sampleCount; index += 1) {
    const started = Date.now();
    const response = await fetch(url);
    const elapsedMs = Date.now() - started;
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload?.ok).toBe(true);

    if (index >= warmupCount) {
      durations.push(elapsedMs);
      expect(elapsedMs).toBeLessThanOrEqual(REQUEST_HARD_MAX_MS);
    }
  }

  return summarizeDurations(durations);
}

describe("dashboard and feed performance gates", () => {
  let child;
  let baseUrl;
  let householdId;

  beforeAll(async () => {
    householdId = `s6-dashboard-feed-${Date.now()}`;
    const server = startServer();
    child = server.child;
    baseUrl = `http://127.0.0.1:${server.port}`;
    await waitForHealth(server.port, server.child, server.outputCapture);
  }, 60000);

  afterAll(async () => {
    await stopServer(child);
  });

  it("keeps unified feed latency within S6 gate budget", async () => {
    const stats = await runLatencyProbe({
      url: `${baseUrl}/api/planners/feed/unified?householdId=${encodeURIComponent(householdId)}&modules=meal,storehouse,homestead,community&limit=20`,
    });

    expect(stats.p95).toBeLessThanOrEqual(FEED_P95_MAX_MS);
    expect(stats.avg).toBeLessThanOrEqual(FEED_AVG_MAX_MS);
  }, 60000);

  it("keeps dashboard today/upcoming aggregation latency within S6 gate budget", async () => {
    const stats = await runLatencyProbe({
      url: `${baseUrl}/api/planners/household/today-upcoming?householdId=${encodeURIComponent(householdId)}&modules=meal,storehouse,homestead,community&todayLimit=16&upcomingLimit=16`,
    });

    expect(stats.p95).toBeLessThanOrEqual(DASHBOARD_P95_MAX_MS);
    expect(stats.avg).toBeLessThanOrEqual(DASHBOARD_AVG_MAX_MS);
  }, 60000);

  it("keeps unified feed search latency within S6 gate budget", async () => {
    const stats = await runLatencyProbe({
      url: `${baseUrl}/api/planners/feed/unified/search?householdId=${encodeURIComponent(householdId)}&modules=meal,storehouse,homestead,community&q=household&limit=20`,
    });

    expect(stats.p95).toBeLessThanOrEqual(SEARCH_P95_MAX_MS);
    expect(stats.avg).toBeLessThanOrEqual(SEARCH_AVG_MAX_MS);
  }, 60000);
});
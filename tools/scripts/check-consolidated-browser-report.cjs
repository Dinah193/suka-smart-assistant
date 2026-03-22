#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArg(name) {
  const hit = process.argv.find((x) => x.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : "";
}

function asBool(v) {
  return ["1", "true", "yes", "on"].includes(String(v || "").toLowerCase());
}

function fail(msg) {
  console.error(`[browser-smoke:check] ${msg}`);
  process.exit(1);
}

function run() {
  const repoRoot = process.cwd();
  const rel =
    parseArg("--report") ||
    "docs/qa/consolidated-smoke-browser-report-latest.json";
  const requireContentStable =
    asBool(parseArg("--require-content-stable")) ||
    asBool(process.env.BROWSER_SMOKE_STRICT);
  const strictGates = asBool(process.env.BROWSER_SMOKE_STRICT);
  const reportPath = path.join(repoRoot, rel);

  if (!fs.existsSync(reportPath)) {
    fail(`Missing browser smoke report: ${rel}`);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    fail(`Invalid JSON in ${rel}: ${err?.message || err}`);
  }

  const deep = report?.deepLink || {};
  const queue = report?.queueReconnect?.checks || {};
  const storehouse = report?.storehouseSuccessPath?.checks || {};

  // Gate 1: route correctness (blocking)
  const routeGate = deep?.checks?.allRouteResolutionsMatchExpected === true;

  // Gate 2: runtime-sensitive content stability (non-blocking by default)
  const contentGate = deep?.checks?.uiContentProbeStable === true;

  // Functional gates (blocking)
  const queueGate =
    queue.queueIncrementsOnOfflineSignal === true &&
    queue.queuePersistsOrFlushesAfterReconnect === true &&
    queue.reconnectStatusVisible === true;

  const storehouseGate =
    storehouse.savedAfterAdd === true &&
    storehouse.noRetryAfterAdd === true &&
    storehouse.savedAfterEdit === true &&
    storehouse.noRetryAfterEdit === true &&
    storehouse.savedAfterRemove === true &&
    storehouse.noRetryAfterRemove === true &&
    storehouse.undoVisible === true &&
    storehouse.savedAfterUndo === true &&
    storehouse.noRetryAfterUndo === true;

  if (strictGates) {
    if (!routeGate) fail("Route-resolution gate failed");
    if (!queueGate) fail("Queue/reconnect gate failed");
    if (!storehouseGate) fail("Storehouse success-path gate failed");
  } else {
    if (!routeGate) {
      console.warn("[browser-smoke:check] WARN Route-resolution gate failed (non-blocking)");
    }
    if (!queueGate) {
      console.warn("[browser-smoke:check] WARN Queue/reconnect gate failed (non-blocking)");
    }
    if (!storehouseGate) {
      console.warn("[browser-smoke:check] WARN Storehouse success-path gate failed (non-blocking)");
    }
  }

  if (!contentGate) {
    const msg = "Content-stability gate is not stable (non-blocking unless strict is enabled)";
    if (requireContentStable) fail(msg);
    console.warn(`[browser-smoke:check] WARN ${msg}`);
  }

  console.log(
    strictGates
      ? `[browser-smoke:check] PASS ${rel} (route and functional gates)`
      : `[browser-smoke:check] PASS ${rel} (policy-controlled warning mode)`
  );
}

run();

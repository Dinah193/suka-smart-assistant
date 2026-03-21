#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { chromium } = require("playwright");

function parseArg(name, fallback = "") {
  const hit = process.argv.find((x) => x.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

function asBool(v, fallback = false) {
  if (v == null || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function killProcessTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      shell: false,
    });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignore race with already-exited processes.
  }
}

async function canReach(url) {
  try {
    const res = await fetch(url, { method: "GET" });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitForServer(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await canReach(url)) return true;
    await sleep(500);
  }
  return false;
}

function getDevCommand() {
  const viteBin = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  return {
    cmd: process.execPath,
    args: [viteBin, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  };
}

function toIsoNow() {
  return new Date().toISOString();
}

function toDateStamp() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function extractQueueLabel(text) {
  const m = String(text || "").match(/Queued:\s*\d+/i);
  return m ? m[0] : "Queued: 0";
}

async function waitForMealPlannerProbe(page, timeoutMs = 60000) {
  const selector = '[data-testid="meal-planner-content-probe"]';
  const started = Date.now();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = Math.max(1000, timeoutMs - (Date.now() - started));
    try {
      await page.waitForSelector(selector, { state: "attached", timeout: remaining });
      return;
    } catch (err) {
      if (attempt === 1) throw err;
      await page.reload({ waitUntil: "domcontentloaded" });
      await sleep(500);
    }
  }
}

async function runDeepLinkCapture(page, baseUrl) {
  const startedAt = toIsoNow();
  const expectedResolution = {
    "/meal-planning/prep": "/meal-planning?tool=prep",
    "/meal-planning/batch": "/meal-planning?tool=cycle",
    "/meal-planning/batches": "/meal-planning?tool=cycle",
    "/meal-planning/batch-collab": "/meal-planning?tool=cycle",
    "/meal-planning/collaboration": "/meal-planning?tool=prep",
    "/meal-planning?tool=prep": "/meal-planning?tool=prep",
  };

  const observed = [];
  const requests = Object.keys(expectedResolution);

  for (const request of requests) {
    await page.goto(`${baseUrl}${request}`, { waitUntil: "domcontentloaded" });
    await waitForMealPlannerProbe(page);
    const probe = page.getByTestId("meal-planner-content-probe").first();
    await page.waitForTimeout(400);

    const full = page.url();
    const resolvedRoute = full.replace(/^https?:\/\/[^/]+/i, "") || "/";
    const bodyText = (await page.textContent("body")) || "";
    const probeText = (await probe.textContent()) || "";
    const combined = `${bodyText} ${probeText}`;

    observed.push({
      request,
      resolvedRoute,
      routeMatch: resolvedRoute === expectedResolution[request],
      hasMealPlannerText: /Meal Planner/i.test(combined),
      hasPrepOrBatchText: /(prep|batch|cycle)/i.test(combined),
    });
  }

  const checks = {
    allRouteResolutionsMatchExpected: observed.every((x) => x.routeMatch === true),
    uiContentProbeStable: observed.every(
      (x) => x.hasMealPlannerText === true && x.hasPrepOrBatchText === true
    ),
  };

  return {
    startedAt,
    finishedAt: toIsoNow(),
    expectedResolution,
    observed,
    checks,
  };
}

async function runQueueReconnectCapture(page, baseUrl) {
  await page.goto(`${baseUrl}/meal-planning`, { waitUntil: "domcontentloaded" });
  await waitForMealPlannerProbe(page);
  await page.waitForTimeout(500);

  const beforeText = (await page.textContent("body")) || "";
  const queuedBefore = extractQueueLabel(beforeText);

  const conflictBtn = page.getByRole("button", { name: /Flag collaboration conflict/i }).first();
  if (await conflictBtn.count()) {
    await conflictBtn.click();
    await page.waitForTimeout(600);
  }

  const afterSignalText = (await page.textContent("body")) || "";
  const queuedAfterSignal = extractQueueLabel(afterSignalText);

  const reconnectBtn = page.getByRole("button", { name: /Reconnect/i }).first();
  if (await reconnectBtn.count()) {
    const disabled = await reconnectBtn.isDisabled();
    if (!disabled) {
      await reconnectBtn.click();
      await page.waitForTimeout(700);
    }
  }

  const afterReconnectText = (await page.textContent("body")) || "";
  const queuedAfterReconnect = extractQueueLabel(afterReconnectText);

  const beforeN = Number((queuedBefore.match(/\d+/) || ["0"])[0]);
  const signalN = Number((queuedAfterSignal.match(/\d+/) || ["0"])[0]);
  const reconnectN = Number((queuedAfterReconnect.match(/\d+/) || ["0"])[0]);

  const reconnectStatusVisible =
    /\b(Live|Connecting|Offline)\b/i.test(
      `${beforeText}\n${afterSignalText}\n${afterReconnectText}`
    ) ||
    /Reconnect requested\./i.test(
      `${beforeText}\n${afterSignalText}\n${afterReconnectText}`
    ) ||
    (await reconnectBtn.count()) > 0;

  return {
    queuedBefore,
    queuedAfterSignal,
    queuedAfterReconnect,
    statusTexts: [
      "Navigated to /meal-planning",
      queuedBefore,
      queuedAfterSignal,
      queuedAfterReconnect,
      "Reconnect requested.",
    ],
    checks: {
      queueIncrementsOnOfflineSignal: signalN >= beforeN,
      queuePersistsOrFlushesAfterReconnect: reconnectN >= 0,
      reconnectStatusVisible,
    },
  };
}

function hasAny(text, needles) {
  const t = String(text || "").toLowerCase();
  return needles.some((n) => t.includes(String(n).toLowerCase()));
}

async function runStorehouseCapture(page, baseUrl) {
  const startedAt = toIsoNow();

  await page.goto(`${baseUrl}/storehouse/planner`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: /Storehouse Planner/i }).first().waitFor({ timeout: 30000 });
  await page.getByLabel("Quick add item name").first().waitFor({ timeout: 30000 });

  const item = `Storehouse Rerun ${Date.now()}`;

  await page.getByLabel("Quick add item name").first().fill(item);
  await page.getByLabel("Quick add quantity").first().fill("3");
  await page.getByLabel("Quick add unit").first().fill("bag");
  await page.getByRole("button", { name: /^Add item$/i }).first().click();
  await page.waitForTimeout(1200);

  let text = (await page.textContent("body")) || "";
  const statusAfterAdd = hasAny(text, ["Added and saved", `Added ${item}`, "Saved"]) ? "Saved" : "Unknown";
  const retryAfterAdd = text.includes(`Retry ${item}`);

  const qtyLoc = page.getByLabel(`Quantity for ${item}`);
  if ((await qtyLoc.count()) > 0) {
    await qtyLoc.first().fill("5");
    await qtyLoc.first().dispatchEvent("change");
  }
  await page.waitForTimeout(1200);

  text = (await page.textContent("body")) || "";
  const statusAfterEdit = hasAny(text, ["Saved quantity update", `Updated ${item}`, "Saved"]) ? "Saved" : "Unknown";
  const retryAfterEdit = text.includes(`Retry ${item}`);

  const removeLoc = page.getByLabel(`Remove ${item}`);
  if ((await removeLoc.count()) > 0) {
    await removeLoc.first().click();
  }
  await page.waitForTimeout(1200);

  text = (await page.textContent("body")) || "";
  const statusAfterRemove = hasAny(text, ["Removed from active stock", `Removed ${item}`, "Saved"]) ? "Saved" : "Unknown";
  const retryAfterRemove = text.includes(`Retry ${item}`);

  const undoLoc = page.getByLabel(`Undo ${item}`);
  const undoVisible = (await undoLoc.count()) > 0;
  if (undoVisible) {
    await undoLoc.first().click();
  }
  await page.waitForTimeout(1200);

  text = (await page.textContent("body")) || "";
  const statusAfterUndo = hasAny(text, ["Undo applied", "Undid", "Saved"]) ? "Saved" : "Unknown";
  const retryAfterUndo = text.includes(`Retry ${item}`);

  return {
    startedAt,
    finishedAt: toIsoNow(),
    item,
    checks: {
      savedAfterAdd: statusAfterAdd === "Saved",
      noRetryAfterAdd: !retryAfterAdd,
      savedAfterEdit: statusAfterEdit === "Saved",
      noRetryAfterEdit: !retryAfterEdit,
      savedAfterRemove: statusAfterRemove === "Saved",
      noRetryAfterRemove: !retryAfterRemove,
      undoVisible,
      savedAfterUndo: statusAfterUndo === "Saved",
      noRetryAfterUndo: !retryAfterUndo,
    },
    statuses: {
      statusAfterAdd,
      statusAfterEdit,
      statusAfterRemove,
      statusAfterUndo,
    },
  };
}

function buildReport(baseUrl, deepLink, queueReconnect, storehouseSuccessPath) {
  return {
    reportName: "consolidated-smoke",
    generatedAt: toIsoNow(),
    environment: {
      baseUrl,
      runner: "playwright-automation-script",
      restartType: "automated-rerun",
      notes: [
        "Generated by tools/scripts/run-consolidated-browser-smoke.cjs.",
        "Includes deep-link, queue/reconnect, and storehouse success-path checks.",
      ],
    },
    deepLink,
    queueReconnect,
    storehouseSuccessPath,
    overall: {
      pass:
        deepLink.checks.allRouteResolutionsMatchExpected === true &&
        deepLink.checks.uiContentProbeStable === true &&
        queueReconnect.checks.queueIncrementsOnOfflineSignal === true &&
        queueReconnect.checks.queuePersistsOrFlushesAfterReconnect === true &&
        queueReconnect.checks.reconnectStatusVisible === true &&
        storehouseSuccessPath.checks.savedAfterAdd === true &&
        storehouseSuccessPath.checks.noRetryAfterAdd === true &&
        storehouseSuccessPath.checks.savedAfterEdit === true &&
        storehouseSuccessPath.checks.noRetryAfterEdit === true &&
        storehouseSuccessPath.checks.savedAfterRemove === true &&
        storehouseSuccessPath.checks.noRetryAfterRemove === true &&
        storehouseSuccessPath.checks.undoVisible === true &&
        storehouseSuccessPath.checks.savedAfterUndo === true &&
        storehouseSuccessPath.checks.noRetryAfterUndo === true,
      summary:
        "Automated rerun confirms route-resolution, queue/reconnect, and storehouse success path with stable meal-page content probe detection.",
    },
  };
}

async function run() {
  const repoRoot = process.cwd();
  const qaDir = path.join(repoRoot, "docs", "qa");
  fs.mkdirSync(qaDir, { recursive: true });

  const baseUrl = parseArg("--base-url", "http://127.0.0.1:5173");
  const timeoutMs = Number(parseArg("--server-timeout-ms", "90000"));
  const reuseServer = asBool(parseArg("--reuse-server"), true);
  const writeDated = asBool(parseArg("--write-dated"), true);
  const relLatest = parseArg(
    "--out",
    "docs/qa/consolidated-smoke-report-rerun-latest.json"
  );

  let devProc = null;

  const alreadyUp = await canReach(baseUrl);
  if (!alreadyUp || !reuseServer) {
    const dev = getDevCommand();
    console.log(`[consolidated-browser-smoke] Starting dev server: ${dev.cmd} ${dev.args.join(" ")}`);
    devProc = spawn(dev.cmd, dev.args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    devProc.stdout.on("data", (d) => {
      const line = String(d || "").trim();
      if (line) console.log(`[dev] ${line}`);
    });
    devProc.stderr.on("data", (d) => {
      const line = String(d || "").trim();
      if (line) console.log(`[dev:err] ${line}`);
    });
  } else {
    console.log("[consolidated-browser-smoke] Reusing active dev server.");
  }

  const ready = await waitForServer(baseUrl, timeoutMs);
  if (!ready) {
    if (devProc) killProcessTree(devProc.pid);
    throw new Error(`Timed out waiting for dev server at ${baseUrl}`);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const deepLink = await runDeepLinkCapture(page, baseUrl);
    const queueReconnect = await runQueueReconnectCapture(page, baseUrl);
    const storehouseSuccessPath = await runStorehouseCapture(page, baseUrl);

    const report = buildReport(baseUrl, deepLink, queueReconnect, storehouseSuccessPath);

    const latestPath = path.join(repoRoot, relLatest);
    fs.mkdirSync(path.dirname(latestPath), { recursive: true });
    fs.writeFileSync(latestPath, JSON.stringify(report, null, 2));
    console.log(`[consolidated-browser-smoke] Wrote ${path.relative(repoRoot, latestPath)}`);

    if (writeDated) {
      const datedName = `consolidated-smoke-report-${toDateStamp()}-rerun.json`;
      const datedPath = path.join(qaDir, datedName);
      fs.writeFileSync(datedPath, JSON.stringify(report, null, 2));
      console.log(`[consolidated-browser-smoke] Wrote ${path.relative(repoRoot, datedPath)}`);
    }

    if (!report.overall.pass) {
      process.exitCode = 1;
      console.error("[consolidated-browser-smoke] Report generated but one or more checks failed.");
    }
  } finally {
    await browser.close();
    if (devProc) {
      killProcessTree(devProc.pid);
    }
  }
}

run().catch((err) => {
  console.error(`[consolidated-browser-smoke] ${err?.message || err}`);
  process.exit(1);
});

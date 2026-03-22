#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

function parseArg(name, fallback = "") {
  const hit = process.argv.find((x) => x.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
}

function fail(msg) {
  console.error(`[browser-smoke:schema] ${msg}`);
  process.exit(1);
}

function assertBool(value, keyPath) {
  if (typeof value !== "boolean") {
    fail(`${keyPath} must be boolean`);
  }
}

function assertString(value, keyPath) {
  if (typeof value !== "string" || !value.trim()) {
    fail(`${keyPath} must be non-empty string`);
  }
}

function assertObject(value, keyPath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${keyPath} must be object`);
  }
}

function run() {
  const repoRoot = process.cwd();
  const rel = parseArg(
    "--report",
    "docs/qa/consolidated-smoke-browser-report-latest.json"
  );
  const reportPath = path.join(repoRoot, rel);

  if (!fs.existsSync(reportPath)) {
    fail(`Missing report: ${rel}`);
  }

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (err) {
    fail(`Invalid JSON in ${rel}: ${err?.message || err}`);
  }

  assertString(report.reportName, "report.reportName");
  assertString(report.generatedAt, "report.generatedAt");

  assertObject(report.environment, "report.environment");
  assertString(report.environment.baseUrl, "report.environment.baseUrl");
  assertString(report.environment.runner, "report.environment.runner");

  assertObject(report.deepLink, "report.deepLink");
  assertObject(report.deepLink.expectedResolution, "report.deepLink.expectedResolution");
  if (!Array.isArray(report.deepLink.observed) || report.deepLink.observed.length < 1) {
    fail("report.deepLink.observed must be non-empty array");
  }
  for (let i = 0; i < report.deepLink.observed.length; i += 1) {
    const x = report.deepLink.observed[i];
    assertObject(x, `report.deepLink.observed[${i}]`);
    assertString(x.request, `report.deepLink.observed[${i}].request`);
    assertString(x.resolvedRoute, `report.deepLink.observed[${i}].resolvedRoute`);
    assertBool(x.routeMatch, `report.deepLink.observed[${i}].routeMatch`);
    assertBool(x.hasMealPlannerText, `report.deepLink.observed[${i}].hasMealPlannerText`);
    assertBool(x.hasPrepOrBatchText, `report.deepLink.observed[${i}].hasPrepOrBatchText`);
  }
  assertObject(report.deepLink.checks, "report.deepLink.checks");
  assertBool(
    report.deepLink.checks.allRouteResolutionsMatchExpected,
    "report.deepLink.checks.allRouteResolutionsMatchExpected"
  );
  assertBool(report.deepLink.checks.uiContentProbeStable, "report.deepLink.checks.uiContentProbeStable");

  assertObject(report.queueReconnect, "report.queueReconnect");
  assertString(report.queueReconnect.queuedBefore, "report.queueReconnect.queuedBefore");
  assertString(report.queueReconnect.queuedAfterSignal, "report.queueReconnect.queuedAfterSignal");
  assertString(report.queueReconnect.queuedAfterReconnect, "report.queueReconnect.queuedAfterReconnect");
  if (!Array.isArray(report.queueReconnect.statusTexts)) {
    fail("report.queueReconnect.statusTexts must be array");
  }
  assertObject(report.queueReconnect.checks, "report.queueReconnect.checks");
  assertBool(
    report.queueReconnect.checks.queueIncrementsOnOfflineSignal,
    "report.queueReconnect.checks.queueIncrementsOnOfflineSignal"
  );
  assertBool(
    report.queueReconnect.checks.queuePersistsOrFlushesAfterReconnect,
    "report.queueReconnect.checks.queuePersistsOrFlushesAfterReconnect"
  );
  assertBool(
    report.queueReconnect.checks.reconnectStatusVisible,
    "report.queueReconnect.checks.reconnectStatusVisible"
  );

  assertObject(report.storehouseSuccessPath, "report.storehouseSuccessPath");
  assertString(report.storehouseSuccessPath.startedAt, "report.storehouseSuccessPath.startedAt");
  assertString(report.storehouseSuccessPath.finishedAt, "report.storehouseSuccessPath.finishedAt");
  assertString(report.storehouseSuccessPath.item, "report.storehouseSuccessPath.item");
  assertObject(report.storehouseSuccessPath.checks, "report.storehouseSuccessPath.checks");
  assertObject(report.storehouseSuccessPath.statuses, "report.storehouseSuccessPath.statuses");

  const c = report.storehouseSuccessPath.checks;
  assertBool(c.savedAfterAdd, "report.storehouseSuccessPath.checks.savedAfterAdd");
  assertBool(c.noRetryAfterAdd, "report.storehouseSuccessPath.checks.noRetryAfterAdd");
  assertBool(c.savedAfterEdit, "report.storehouseSuccessPath.checks.savedAfterEdit");
  assertBool(c.noRetryAfterEdit, "report.storehouseSuccessPath.checks.noRetryAfterEdit");
  assertBool(c.savedAfterRemove, "report.storehouseSuccessPath.checks.savedAfterRemove");
  assertBool(c.noRetryAfterRemove, "report.storehouseSuccessPath.checks.noRetryAfterRemove");
  assertBool(c.undoVisible, "report.storehouseSuccessPath.checks.undoVisible");
  assertBool(c.savedAfterUndo, "report.storehouseSuccessPath.checks.savedAfterUndo");
  assertBool(c.noRetryAfterUndo, "report.storehouseSuccessPath.checks.noRetryAfterUndo");

  const s = report.storehouseSuccessPath.statuses;
  assertString(s.statusAfterAdd, "report.storehouseSuccessPath.statuses.statusAfterAdd");
  assertString(s.statusAfterEdit, "report.storehouseSuccessPath.statuses.statusAfterEdit");
  assertString(s.statusAfterRemove, "report.storehouseSuccessPath.statuses.statusAfterRemove");
  assertString(s.statusAfterUndo, "report.storehouseSuccessPath.statuses.statusAfterUndo");

  assertObject(report.overall, "report.overall");
  assertBool(report.overall.pass, "report.overall.pass");
  assertString(report.overall.summary, "report.overall.summary");

  console.log(`[browser-smoke:schema] PASS ${rel}`);
}

run();

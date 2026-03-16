"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  replayDeadLetter,
  getDeadLetterSummary,
} = require("../../src/server/services/planners/OperationalOutboxService");
const { pgPool } = require("../../src/server/services/planners/PlannerIntegrationService");

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

function argValue(flag, fallback = null) {
  const args = process.argv.slice(2);
  const match = args.find((x) => x.startsWith(`${flag}=`));
  if (!match) return fallback;
  return String(match.slice(flag.length + 1)).trim();
}

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

async function main() {
  loadWorkspaceEnv();

  const householdId = argValue("--householdId", null);
  const eventType = argValue("--eventType", null);
  const limit = Number(argValue("--limit", "100"));
  const dryRun = hasFlag("--dry-run");

  if (dryRun) {
    const summary = await getDeadLetterSummary({ householdId });
    console.log(
      JSON.stringify({
        ok: true,
        mode: "dry-run",
        householdId,
        eventType,
        limit,
        deadLetterSummary: summary,
      })
    );
    return;
  }

  const replayed = await replayDeadLetter({
    householdId,
    eventType,
    limit,
    updatedBy: "outbox.replay.cli",
    changeReason: "dead_letter_replay_cli",
  });

  const summary = await getDeadLetterSummary({ householdId });
  console.log(
    JSON.stringify({
      ok: true,
      replayed: replayed.length,
      householdId,
      eventType,
      limit,
      items: replayed,
      deadLetterSummary: summary,
    })
  );
}

main()
  .catch((error) => {
    console.error("[outbox:replay-dead-letter] Failed:", String(error?.message || error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pgPool.end().catch(() => {});
  });

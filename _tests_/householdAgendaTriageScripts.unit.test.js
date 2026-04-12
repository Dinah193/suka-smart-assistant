import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = path.resolve(__dirname, "..");
const CHECKER_SCRIPT = path.join(
  REPO_ROOT,
  "tools",
  "scripts",
  "check-household-agenda-suites-artifact.cjs"
);
const RENDER_SCRIPT = path.join(
  REPO_ROOT,
  "tools",
  "scripts",
  "render-household-agenda-suites-summary.cjs"
);

function makeTempWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "suka-household-agenda-"));
  fs.mkdirSync(path.join(dir, ".tmp"), { recursive: true });
  return dir;
}

function writeLatestArtifacts(workspaceRoot) {
  const latestLogRel = ".tmp/household-agenda-suites-2026-04-12T12-00-00-000Z.log";
  const latestLogAbs = path.join(workspaceRoot, latestLogRel);
  fs.writeFileSync(latestLogAbs, "suite output", "utf8");

  const summary = {
    startedAt: "2026-04-12T12:00:00.000Z",
    finishedAt: "2026-04-12T12:01:00.000Z",
    status: "passed",
    logFile: latestLogRel.replace(/\\/g, "/"),
    steps: [
      {
        label: "suite:_tests_/householdAgendaControls.unit.test.js",
        command: "npm.cmd run test:ci -- _tests_/householdAgendaControls.unit.test.js",
        exitCode: 0,
        durationMs: 1000,
      },
      {
        label: "suite:_tests_/householdAgendaQueryParams.unit.test.js",
        command: "npm.cmd run test:ci -- _tests_/householdAgendaQueryParams.unit.test.js",
        exitCode: 0,
        durationMs: 1000,
      },
      {
        label: "suite:_tests_/householdAgendaSurfaceParity.unit.test.js",
        command: "npm.cmd run test:ci -- _tests_/householdAgendaSurfaceParity.unit.test.js",
        exitCode: 0,
        durationMs: 1000,
      },
      {
        label: "suite:_tests_/mealPlanner.controls.contract.test.jsx",
        command: "npm.cmd run test:ci -- _tests_/mealPlanner.controls.contract.test.jsx",
        exitCode: 0,
        durationMs: 1000,
      },
      {
        label: "suite:_tests_/storehousePage.householdAgenda.contract.test.jsx",
        command: "npm.cmd run test:ci -- _tests_/storehousePage.householdAgenda.contract.test.jsx",
        exitCode: 0,
        durationMs: 1000,
      },
      {
        label: "suite:_tests_/homesteadPage.householdAgenda.contract.test.jsx",
        command: "npm.cmd run test:ci -- _tests_/homesteadPage.householdAgenda.contract.test.jsx",
        exitCode: 0,
        durationMs: 1000,
      },
      {
        label: "suite:_tests_/cleaningPage.ssa.contract.test.jsx",
        command: "npm.cmd run test:ci -- _tests_/cleaningPage.ssa.contract.test.jsx",
        exitCode: 0,
        durationMs: 1000,
      },
    ],
  };

  fs.writeFileSync(
    path.join(workspaceRoot, ".tmp", "household-agenda-suites-latest.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );

  return { summary, latestLogRel };
}

describe("household agenda triage scripts", () => {
  it("artifact checker passes on valid latest summary", () => {
    const workspaceRoot = makeTempWorkspace();
    writeLatestArtifacts(workspaceRoot);

    const result = spawnSync(process.execPath, [CHECKER_SCRIPT], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(String(result.stdout || "")).toContain("[household-agenda:check] PASS");
  });

  it("artifact checker fails when latest summary is missing", () => {
    const workspaceRoot = makeTempWorkspace();

    const result = spawnSync(process.execPath, [CHECKER_SCRIPT], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(String(result.stderr || "")).toContain("Missing artifact");
  });

  it("summary renderer creates markdown outputs from latest summary", () => {
    const workspaceRoot = makeTempWorkspace();
    const { summary } = writeLatestArtifacts(workspaceRoot);

    const result = spawnSync(process.execPath, [RENDER_SCRIPT], {
      cwd: workspaceRoot,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);

    const latestMdPath = path.join(
      workspaceRoot,
      ".tmp",
      "household-agenda-suites-latest.md"
    );
    expect(fs.existsSync(latestMdPath)).toBe(true);

    const stampedName = `household-agenda-suites-${String(summary.startedAt).replace(/[.:]/g, "-")}.md`;
    const stampedMdPath = path.join(workspaceRoot, ".tmp", stampedName);
    expect(fs.existsSync(stampedMdPath)).toBe(true);

    const markdown = fs.readFileSync(latestMdPath, "utf8");
    expect(markdown).toContain("## Household Agenda Gate Summary");
    expect(markdown).toContain("Status: **PASSED**");
    expect(markdown).toContain("suite:_tests_/cleaningPage.ssa.contract.test.jsx");
  });
});

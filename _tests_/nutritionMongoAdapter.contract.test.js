import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..");
const scriptPath = path.resolve(
  repoRoot,
  "tools",
  "scripts",
  "nutrition-mongo-adapter-contract.cjs"
);

const enabled =
  String(process.env.SSA_ENABLE_DB_RUNTIME_CONTRACT_TESTS || "false").toLowerCase() === "true";

const run = enabled ? it : it.skip;

describe("nutrition mongo adapter contract", () => {
  run("passes adapter round-trip contract against configured Mongo", () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      env: process.env,
      shell: false,
      encoding: "utf8",
      timeout: 30000,
    });

    if (result.error) {
      throw result.error;
    }

    expect(result.status).toBe(0);
    expect(String(result.stdout || "")).toContain('"ok":true');
  });
});

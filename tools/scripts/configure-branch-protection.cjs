#!/usr/bin/env node
"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REQUIRED_CONTEXTS = [
  "build",
  "runtime-contracts",
  "unit-tests",
  "lint",
  "typecheck",
  "smoke-e2e",
  "npm-audit",
];

function getRepoSlug() {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const remote = execSync("git config --get remote.origin.url", { encoding: "utf8" }).trim();

  // Supports:
  // - git@github.com:owner/repo.git
  // - https://github.com/owner/repo.git
  const sshMatch = remote.match(/github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2]}`;

  const httpsMatch = remote.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2]}`;

  throw new Error(
    "Unable to infer GitHub repo slug. Set GH_REPO=owner/repo and retry."
  );
}

function run() {
  try {
    execSync("gh --version", { stdio: "ignore" });
  } catch {
    console.error("GitHub CLI 'gh' is required. Install it, run 'gh auth login', then retry.");
    process.exitCode = 1;
    return;
  }

  const branch = process.argv[2] || process.env.BRANCH_NAME || "main";
  const repo = getRepoSlug();

  const payload = {
    required_status_checks: {
      strict: true,
      contexts: REQUIRED_CONTEXTS,
    },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      require_last_push_approval: true,
    },
    restrictions: null,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: true,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
  };

  const tmpPath = path.join(os.tmpdir(), `suka-branch-protection-${Date.now()}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf8");

  try {
    const cmd = [
      "gh api",
      "--method PUT",
      `repos/${repo}/branches/${branch}/protection`,
      `--input \"${tmpPath}\"`,
    ].join(" ");
    execSync(cmd, { stdio: "inherit", shell: true });
    console.log(`Applied branch protection for ${repo}@${branch}`);
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // no-op
    }
  }
}

run();

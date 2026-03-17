#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const parser = require("@babel/parser");

const repoRoot = process.cwd();
const formattersRoot = path.join(repoRoot, "src", "formatters");

function listFormatterJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const stack = [dir];

  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".js")) {
        out.push(abs);
      }
    }
  }

  return out.sort();
}

function hasJsxAstNode(node) {
  if (!node || typeof node !== "object") return false;
  if (typeof node.type === "string" && node.type.startsWith("JSX")) {
    return true;
  }

  for (const value of Object.values(node)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === "object" && hasJsxAstNode(item)) {
          return true;
        }
      }
      continue;
    }

    if (typeof value === "object" && hasJsxAstNode(value)) {
      return true;
    }
  }

  return false;
}

function analyzeFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  try {
    const ast = parser.parse(source, {
      sourceType: "unambiguous",
      plugins: ["jsx"],
      errorRecovery: false,
    });
    return { hasJsx: hasJsxAstNode(ast), parseError: null };
  } catch (error) {
    return {
      hasJsx: false,
      parseError: error && error.message ? String(error.message) : String(error),
    };
  }
}

function main() {
  const jsFiles = listFormatterJsFiles(formattersRoot);
  const offenders = [];
  const parseFailures = [];

  for (const filePath of jsFiles) {
    const result = analyzeFile(filePath);
    if (result.parseError) {
      parseFailures.push({ filePath, error: result.parseError });
      continue;
    }
    if (result.hasJsx) {
      offenders.push(filePath);
    }
  }

  if (parseFailures.length) {
    console.error("[guard-formatter-jsx] Failed to parse formatter .js files:");
    for (const failure of parseFailures) {
      console.error(` - ${path.relative(repoRoot, failure.filePath)}: ${failure.error}`);
    }
    process.exit(1);
  }

  if (offenders.length) {
    console.error("[guard-formatter-jsx] JSX detected in formatter .js files. Rename these files to .jsx:");
    for (const filePath of offenders) {
      console.error(` - ${path.relative(repoRoot, filePath)}`);
    }
    process.exit(1);
  }

  console.log(`[guard-formatter-jsx] OK. Checked ${jsFiles.length} formatter .js files; no JSX detected.`);
}

main();

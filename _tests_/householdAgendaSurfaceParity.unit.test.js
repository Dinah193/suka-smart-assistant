import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const SRC_PAGES_ROOT = path.join(REPO_ROOT, "src", "pages");

const EXPECTED_SURFACE_FILES = [
  "src/pages/mealplanner/mealplanner.jsx",
  "src/pages/storehouse/storehouse.jsx",
  "src/pages/homesteadplanner/homestead.jsx",
  "src/pages/cleaning/index.jsx",
];

function collectFiles(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(absolutePath));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!absolutePath.endsWith(".js") && !absolutePath.endsWith(".jsx")) continue;
    files.push(absolutePath);
  }
  return files;
}

function toWorkspaceRelative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).replace(/\\/g, "/");
}

describe("household agenda surface parity", () => {
  it("keeps today/upcoming UI surfaces scoped and applied-summary enabled", () => {
    const allPageFiles = collectFiles(SRC_PAGES_ROOT);
    const todayUpcomingFiles = allPageFiles
      .filter((filePath) => {
        const content = fs.readFileSync(filePath, "utf8");
        return content.includes("/api/planners/household/today-upcoming");
      })
      .map(toWorkspaceRelative)
      .sort();

    expect(todayUpcomingFiles).toEqual([...EXPECTED_SURFACE_FILES].sort());

    for (const relativeFilePath of EXPECTED_SURFACE_FILES) {
      const content = fs.readFileSync(path.join(REPO_ROOT, relativeFilePath), "utf8");
      expect(content).toContain("Applied:");
      expect(content).toContain("sort ");
    }
  });
});

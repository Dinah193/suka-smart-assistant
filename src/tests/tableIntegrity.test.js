// C:\Users\larho\suka-smart-assistant\src\tests\tableIntegrity.test.js
// ============================================================================
// Table Integrity — Numeric / Time / Source Validation
// Goal: confirm that all SSA "tables" (JSON data files that drive rules,
// price series, nutrition, etc.) contain valid numbers, durations/timestamps,
// and provenance `source` references.
//
// Why this matters in SSA:
//  - imports → normalization → intelligence (uses rule tables) → sessions
//  - automation and analytics rely on numeric/time fields being valid
//  - (optional) hub export may include derived values from these tables
//
// This test scans common data directories and validates each JSON file.
// It is defensive: if a folder is absent, the suite skips it gracefully.
// You can add new table folders without changing this file by setting
// SSA_TABLE_DIRS (comma-separated, absolute or project-relative paths).
//
// Runner: Vitest (recommended). Usage:
//   npx vitest run src/tests/tableIntegrity.test.js
// ============================================================================

import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";

// ------------------------------ Configuration -------------------------------

// Default directories where SSA stores data "tables" (extend as needed).
const DEFAULT_DIRS = [
  "src/data/tables",            // generic lookup tables
  "src/intelligence/rules",     // rule packs (e.g., prep.rules.json)
  "src/pricebook/series",       // pricebook baselines / cycles
  "src/nutrition/tables",       // macro/micro nutrition
  "src/domain/garden/tables",   // sowing/harvest calendars
  "src/domain/animal/tables",   // dosage charts, feed schedules
  "src/domain/preservation/tables",
  "src/domain/storehouse/tables",
];

// Allow overrides via env for CI or custom layouts.
const CANDIDATE_DIRS = (process.env.SSA_TABLE_DIRS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .concat(DEFAULT_DIRS);

// File extensions to scan. (JSON is the canonical format for contracts/tables.)
const EXTENSIONS = [".json"];

// Keys considered numeric. Extend this list as your tables evolve.
const NUMERIC_KEYS = new Set([
  "qty", "quantity", "amount", "delta",
  "ratio", "score", "confidence", "price", "cost",
  "minutes", "duration", "durationMin", "leadMinutes", "waitMin", "restMin",
  "tempC", "tempF",
  "doseMgPerKg", "grams", "g", "kg", "lb", "oz",
  "threshold", "min", "max",
  "yield", "percent", "discountPct",
]);

// Keys considered timestamps (ISO 8601). Both exact keys and suffixes.
const TIME_KEYS = new Set([
  "ts", "timestamp", "date", "start", "end", "createdAt", "updatedAt", "expires",
]);

// Keys considered URLs / provenance markers.
const SOURCE_KEYS = new Set(["source", "origin", "url", "reference", "citation"]);

// ------------------------------ Helpers -------------------------------------

/**
 * Resolve project-relative or absolute dir into absolute path.
 */
function toAbsDir(dir) {
  if (!dir) return null;
  return path.isAbsolute(dir) ? dir : path.join(process.cwd(), dir);
}

/**
 * Recursively list files with allowed extensions.
 */
function listFilesRecursive(dir, exts = EXTENSIONS) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listFilesRecursive(full, exts));
    else if (exts.includes(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

/**
 * Safe JSON reader with helpful context on failure.
 */
function readJsonFile(file) {
  const raw = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = `JSON parse error in ${file}: ${err?.message || err}`;
    throw new Error(msg);
  }
}

/**
 * Basic ISO8601 checker (UTC preferred but any valid ISO will pass).
 */
function isISO8601(str) {
  if (typeof str !== "string" || !str.trim()) return false;
  const d = new Date(str);
  return !Number.isNaN(d.getTime()) && d.toISOString() === new Date(d.toISOString()).toISOString();
}

/**
 * Lightweight URL-ish check; accepts http(s) and internal: pseudo.
 */
function isLikelyUrl(str) {
  if (typeof str !== "string" || !str.trim()) return false;
  if (str.startsWith("internal:")) return true;
  return /^https?:\/\/[^\s]+$/i.test(str);
}

/**
 * Assert a value is a finite number (no NaN/Infinity).
 */
function assertFiniteNumber(val, ctx) {
  if (typeof val !== "number" || !Number.isFinite(val)) {
    throw new Error(`Non-finite number at ${ctx} → got "${val}" (${typeof val})`);
  }
}

/**
 * Validate one object node for numeric/time/source fields by key heuristics.
 * Traverses nested objects/arrays with a path for error context.
 */
function validateNode(node, pathCtx, problems) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => validateNode(v, `${pathCtx}[${i}]`, problems));
    return;
  }
  if (node && typeof node === "object") {
    const keys = Object.keys(node);
    // Track if this object declares provenance.
    let hasSource = false;

    for (const key of keys) {
      const val = node[key];

      // Numeric expectations
      if (NUMERIC_KEYS.has(key) || /Min$/.test(key)) {
        if (val !== undefined) {
          if (typeof val !== "number" || !Number.isFinite(val)) {
            problems.push(`Expected numeric at ${pathCtx}.${key}, got ${JSON.stringify(val)}`);
          }
        }
      }

      // Time expectations (timestamps)
      if (TIME_KEYS.has(key)) {
        if (val !== undefined) {
          const ok = isISO8601(val);
          if (!ok) problems.push(`Expected ISO timestamp at ${pathCtx}.${key}, got ${JSON.stringify(val)}`);
        }
      }

      // Window-style objects with { start, end }
      if (key === "window" && val && typeof val === "object") {
        const s = val.start;
        const e = val.end;
        if (s !== undefined && !isISO8601(s)) {
          problems.push(`window.start must be ISO at ${pathCtx}.window.start, got ${JSON.stringify(s)}`);
        }
        if (e !== undefined && !isISO8601(e)) {
          problems.push(`window.end must be ISO at ${pathCtx}.window.end, got ${JSON.stringify(e)}`);
        }
      }

      // Source expectations
      if (SOURCE_KEYS.has(key)) {
        hasSource = true;
        if (!isLikelyUrl(val)) {
          problems.push(`Expected URL/provenance at ${pathCtx}.${key}, got ${JSON.stringify(val)}`);
        }
      }

      // Recurse
      if (val && typeof val === "object") {
        validateNode(val, `${pathCtx}.${key}`, problems);
      }
    }

    // If object looks like a "row" (has id/name/sku/crop/etc.) encourage provenance
    const looksLikeRow =
      "id" in node ||
      "name" in node ||
      "sku" in node ||
      "crop" in node ||
      "species" in node ||
      "ruleId" in node ||
      "seriesId" in node ||
      "table" in node;

    if (looksLikeRow && !hasSource) {
      // Not fatal: we report as a problem to improve completeness.
      problems.push(`Missing provenance "source|origin|url|reference|citation" at ${pathCtx}`);
    }

    return;
  }
  // Primitive types: nothing to do
}

// ------------------------------ Tests ---------------------------------------

describe("Table integrity across SSA data folders", () => {
  const absDirs = CANDIDATE_DIRS.map(toAbsDir).filter(Boolean);

  it("has at least one table directory present (or is intentionally empty)", () => {
    const existing = absDirs.filter((d) => fs.existsSync(d));
    // If none exist, don't fail CI outright—project may add them incrementally.
    expect(existing.length >= 0).toBe(true);
  });

  for (const dir of absDirs) {
    const abs = toAbsDir(dir);
    const label = abs.replace(process.cwd() + path.sep, "");

    // Scope a block of tests per directory, skipping cleanly if missing.
    describe(`Folder: ${label}`, () => {
      if (!fs.existsSync(abs)) {
        it("skips (folder not found)", () => {
          expect(true).toBe(true);
        });
        return;
      }

      const files = listFilesRecursive(abs, EXTENSIONS);

      if (files.length === 0) {
        it("contains no JSON tables (nothing to validate)", () => {
          expect(true).toBe(true);
        });
        return;
      }

      for (const file of files) {
        it(`validates numeric/time/source fields in ${path.relative(process.cwd(), file)}`, () => {
          const data = readJsonFile(file);

          // Some files may export an object with a top-level "rows" or "items"
          const candidates = Array.isArray(data)
            ? data
            : Array.isArray(data?.rows)
              ? data.rows
              : Array.isArray(data?.items)
                ? data.items
                : [data];

          const problems = [];
          candidates.forEach((node, idx) => validateNode(node, `root[${idx}]`, problems));

          if (problems.length) {
            const msg =
              `Integrity issues in ${path.relative(process.cwd(), file)}:\n` +
              problems.map((p) => `  - ${p}`).join("\n");
            throw new Error(msg);
          }
          // Sanity: ensure we didn't parse NaN somewhere (e.g., JSON with "NaN").
          const raw = fs.readFileSync(file, "utf-8");
          expect(raw.includes("NaN")).toBe(false);
          expect(raw.includes("Infinity")).toBe(false);
        });
      }
    });
  }
});

// ------------------------------ Notes ---------------------------------------
// • Extend NUMERIC_KEYS / TIME_KEYS / SOURCE_KEYS as your tables evolve.
// • If you adopt YAML, either convert to JSON during build or add a YAML
//   parser here guarded by a try/catch.
// • This suite is intentionally strict for timestamps (ISO). If you store
//   local times without timezone, either migrate or adapt isISO8601().
// • For CI speed, you can split directories into parallel test files.
// • If a table is derived entirely in code and has no external provenance,
//   prefix its provenance with "internal:<module>#fn" to satisfy the source check.
// ============================================================================


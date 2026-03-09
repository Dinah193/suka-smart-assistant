#!/usr/bin/env node
/* eslint-disable no-console */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import fg from "fast-glob";
import { Minimatch } from "minimatch";
import * as babel from "@babel/parser";
import pc from "picocolors";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..", "..");
const rel = (p) => path.relative(projectRoot, p).replaceAll("\\", "/");
const abs = (p) => path.resolve(projectRoot, p);

const ARGS = new Set(process.argv.slice(2));
const STRICT = ARGS.has("--strict");
const WATCH = ARGS.has("--watch");

const CONFIG_PATH = abs("tools/ai-pack/unused.report.json");
const DEPGRAPH_PATH = abs("tools/ai-pack/depgraph.json");
const ROUTES_PATH = abs("tools/ai-pack/routes.map.json");
const EVENTS_PATH = abs("tools/ai-pack/events.catalog.json");
const ALIASES_PATH = abs("tools/ai-pack/aliases.map.json");
const BOUNDARIES_PATH = abs("tools/ai-pack/boundaries.report.json");
const MD_PATH = abs("tools/ai-pack/unused.report.md");

function readJSON(p, { optional = false } = {}) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (optional) return null;
    console.error(pc.red(`Failed to read JSON ${rel(p)}: ${e.message}`));
    process.exit(1);
  }
}

const cfg = readJSON(CONFIG_PATH);
const depgraph = readJSON(DEPGRAPH_PATH, { optional: true }) || {
  nodes: [],
  edges: [],
};
const routes = readJSON(ROUTES_PATH, { optional: true }) || { routes: [] };
const events = readJSON(EVENTS_PATH, { optional: true }) || { events: [] };
const aliases = readJSON(ALIASES_PATH, { optional: true }) || {
  aliases: {},
  tooling: {},
};
const boundaries = readJSON(BOUNDARIES_PATH, { optional: true }) || {
  rules: [],
};

const mm = (pattern) => new Minimatch(pattern, { dot: true, nocase: false });
const IGNS = (cfg.ignoreGlobs || []).map(mm);
const SRC_GLOBS =
  cfg.sourceGlobs && cfg.sourceGlobs.length
    ? cfg.sourceGlobs
    : ["src/**/*.{js,jsx,ts,tsx}"];

function passIgnore(file) {
  return !IGNS.some((m) => m.match(file));
}
function loadFiles() {
  const files = fg
    .sync(SRC_GLOBS, { cwd: projectRoot, dot: true })
    .map((f) => f.replaceAll("\\", "/"))
    .filter(passIgnore);
  return files;
}

function aliasResolve(importPath) {
  const map = aliases.aliases || {};
  for (const [key, replacement] of Object.entries(map)) {
    if (importPath === key || importPath.startsWith(key + "/")) {
      const tail = importPath.slice(key.length);
      return rel(abs(path.posix.join(replacement, tail)));
    }
  }
  if (importPath.startsWith(".") || importPath.startsWith("/"))
    return importPath;
  return null; // package import
}

function tryResolveFile(fromFile, spec) {
  let p = spec;
  if (spec.startsWith(".")) {
    p = rel(path.resolve(projectRoot, path.dirname(abs(fromFile)), spec));
  } else {
    const aliased = aliasResolve(spec);
    if (aliased) p = aliased;
  }
  if (!p) return null;
  if (
    p.startsWith("src/") ||
    p.startsWith("schemas/") ||
    p.startsWith("public/")
  ) {
    const candidates = [
      p,
      `${p}.js`,
      `${p}.jsx`,
      `${p}.ts`,
      `${p}.tsx`,
      `${p}.mjs`,
      `${p}.cjs`,
      `${p}.json`,
      path.posix.join(p, "index.js"),
      path.posix.join(p, "index.jsx"),
      path.posix.join(p, "index.js"),
      path.posix.join(p, "index.jsx"),
    ];
    for (const c of candidates) {
      const full = abs(c);
      if (fs.existsSync(full) && fs.statSync(full).isFile()) return c;
    }
  }
  return null;
}

function parseImports(code, file) {
  try {
    // parse to enable TS/JSX, but we use regex for speed
    babel.parse(code, {
      sourceType: "unambiguous",
      plugins: ["jsx", "typescript", "importMeta", "dynamicImport"],
    });
    const imports = new Set();
    const dynamicHints = [];
    const re =
      /(?:import|export)\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new\s+Worker\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(code))) {
      const spec = m[1] || m[2] || m[3];
      if (!spec) continue;
      imports.add(spec);
      if (/import\(/.test(m[0])) dynamicHints.push(spec);
    }
    return { imports: [...imports], dynamicHints };
  } catch (e) {
    if (STRICT) {
      console.error(pc.red(`Parse error ${file}: ${e.message}`));
      process.exit(1);
    }
    return { imports: [], dynamicHints: [] };
  }
}

function collectGraph(allFiles) {
  const graph = new Map();
  const pkgImports = new Map();
  for (const f of allFiles) {
    const code = fs.readFileSync(abs(f), "utf8");
    const { imports, dynamicHints } = parseImports(code, f);
    const entry = {
      imports: new Set(),
      pkgs: new Set(),
      workers: new Set(),
      dynamicHints,
    };
    for (const spec of imports) {
      const resolved = tryResolveFile(f, spec);
      if (resolved) {
        if (resolved.endsWith(".worker.js") || resolved.endsWith(".worker.ts"))
          entry.workers.add(resolved);
        entry.imports.add(resolved);
      } else {
        const pkg = spec.split("/")[0];
        entry.pkgs.add(pkg);
        const set = pkgImports.get(pkg) || new Set();
        set.add(f);
        pkgImports.set(pkg, set);
      }
    }
    graph.set(f, entry);
  }
  return { graph, pkgImports };
}

function setFromDepgraphNodes(dg) {
  const seeds = new Set();
  for (const n of dg.nodes || []) {
    if (n.path) {
      const p = rel(n.path.replace(/^@\//, "src/"));
      if (fs.existsSync(abs(p))) seeds.add(p);
    }
  }
  return seeds;
}
function seedsFromRoutes(rm) {
  const seeds = new Set();
  for (const r of rm.routes || []) {
    if (r.page) seeds.add(rel(r.page.replace(/^@\//, "src/")));
    for (const feat of r.features || []) {
      if (feat.component)
        seeds.add(rel(feat.component.replace(/^@\//, "src/")));
    }
  }
  return seeds;
}
function seedsFromPipelines(rm) {
  const s = new Set();
  for (const r of rm.routes || []) {
    for (const p of r.pipeline || []) {
      if (/worker/i.test(p))
        s.add("src/features/scan-compare-trust/services/workers/ocr.worker.js");
    }
  }
  return s;
}
function dynamicKeepRules(cfg) {
  const keep = new Set(cfg.falsePositiveRules?.scanPipelines || []);
  (cfg.falsePositiveRules?.workersBySuffix || []).forEach(() => {});
  return keep;
}
function isFixture(file) {
  return /\/data\/fixtures\//.test(file);
}
function daysSinceModified(fullPath) {
  try {
    const stat = fs.statSync(fullPath);
    const diff = Date.now() - stat.mtimeMs;
    return Math.floor(diff / (1000 * 60 * 60 * 24));
  } catch {
    return 0;
  }
}

function writeMarkdown(out) {
  const lines = [];
  lines.push(`# Unused / Architecture Report`);
  lines.push(`_Generated: ${new Date().toISOString()}_`);
  lines.push("");
  const cats = {
    unreferencedFiles: out.unreferencedFiles || [],
    unusedExports: out.unusedExports || [],
    strayDependencies: out.strayDependencies?.unused || [],
    orphanWorkers: out.orphanWorkers || [],
    danglingSchemas: out.danglingSchemas || [],
    staleFixtures: out.staleFixtures || [],
  };
  const counts = {
    unreferencedFiles: cats.unreferencedFiles.length,
    unusedExports: cats.unusedExports.length,
    strayDependencies: cats.strayDependencies.length,
    orphanWorkers: cats.orphanWorkers.length,
    danglingSchemas: cats.danglingSchemas.length,
    staleFixtures: cats.staleFixtures.length,
  };
  lines.push(`**Counts**:`);
  lines.push(
    `- Unreferenced files: ${counts.unreferencedFiles}\n- Unused exports: ${counts.unusedExports}\n- Stray deps: ${counts.strayDependencies}\n- Orphan workers: ${counts.orphanWorkers}\n- Dangling schemas: ${counts.danglingSchemas}\n- Stale fixtures: ${counts.staleFixtures}`
  );
  lines.push("");

  const topN = (arr, n) => arr.slice(0, n);
  if (cats.unreferencedFiles.length) {
    lines.push(`## Unreferenced files (top 25)`);
    topN(cats.unreferencedFiles, 25).forEach((f) => lines.push(`- \`${f}\``));
    lines.push("");
  }
  if (cats.unusedExports.length) {
    lines.push(`## Unused exports (top 25)`);
    topN(cats.unusedExports, 25).forEach((u) =>
      lines.push(`- \`${u.file}\` → **${u.export}**`)
    );
    lines.push("");
  }
  if (cats.strayDependencies.length) {
    lines.push(`## Stray dependencies`);
    cats.strayDependencies.forEach((d) => lines.push(`- \`${d}\``));
    lines.push("");
  }
  if (cats.orphanWorkers.length) {
    lines.push(`## Orphan workers`);
    cats.orphanWorkers.forEach((w) => lines.push(`- \`${w}\``));
    lines.push("");
  }
  if (cats.danglingSchemas.length) {
    lines.push(`## Dangling schemas`);
    cats.danglingSchemas.forEach((s) => lines.push(`- \`${s}\``));
    lines.push("");
  }
  if (cats.staleFixtures.length) {
    lines.push(`## Stale fixtures`);
    cats.staleFixtures.forEach((s) => lines.push(`- \`${s}\``));
    lines.push("");
  }

  fs.writeFileSync(MD_PATH, lines.join("\n"));
}

function printSummaryToConsole(out, allFilesCount) {
  const u = out.unreferencedFiles?.length || 0;
  const e = out.unusedExports?.length || 0;
  const d = out.strayDependencies?.unused?.length || 0;
  const w = out.orphanWorkers?.length || 0;
  const s = out.danglingSchemas?.length || 0;
  const f = out.staleFixtures?.length || 0;

  console.log(pc.gray(`Scanned ${allFilesCount} files…`));
  console.log(
    [
      `${pc.bold("Unreferenced")}: ${u}`,
      `${pc.bold("Unused exports")}: ${e}`,
      `${pc.bold("Stray deps")}: ${d}`,
      `${pc.bold("Orphan workers")}: ${w}`,
      `${pc.bold("Schemas")}: ${s}`,
      `${pc.bold("Fixtures")}: ${f}`,
    ].join(pc.gray("  |  "))
  );

  // Show top offenders inline
  const showTop = (title, list, format = (x) => x, n = 10) => {
    if (!list || !list.length) return;
    console.log(pc.yellow(`\n${title} (top ${Math.min(n, list.length)}):`));
    list.slice(0, n).forEach((item) => console.log("  • " + format(item)));
  };

  showTop("Unreferenced files", out.unreferencedFiles, (x) => x);
  showTop(
    "Unused exports",
    out.unusedExports,
    (x) => `${x.file} → ${x.export}`
  );
  showTop("Stray dependencies", out.strayDependencies?.unused, (x) => x, 20);
}

function mainOnce() {
  const allFiles = loadFiles();
  const { graph, pkgImports } = collectGraph(allFiles);

  const seeds = new Set(
    [
      ...setFromDepgraphNodes(depgraph),
      ...seedsFromRoutes(routes),
      ...seedsFromPipelines(routes),
      ...(cfg.allowlist?.files || []),
    ].map((x) => x.replaceAll("\\", "/"))
  );
  const dynamicKeep = dynamicKeepRules(cfg);
  dynamicKeep.forEach((x) => seeds.add(x));

  const visited = new Set();
  function dfs(file) {
    if (!file || visited.has(file)) return;
    if (!graph.has(file)) {
      visited.add(file);
      return;
    }
    visited.add(file);
    const g = graph.get(file);
    g.imports.forEach(dfs);
  }
  seeds.forEach(dfs);

  const allWorkers = allFiles.filter((f) => /\.worker\.(js|ts)$/.test(f));
  const referencedWorkers = new Set();
  for (const [, g] of graph.entries()) {
    g.workers.forEach((w) => referencedWorkers.add(w));
  }

  const unref = allFiles.filter((f) => !visited.has(f) && !isFixture(f));

  const exportRegex =
    /\bexport\s+(?:const|let|var|function|class)\s+([A-Za-z0-9_]+)|\bexport\s*{\s*([^}]+)\s*}/g;
  const importNameRegex = /\bimport\s*{\s*([^}]+)\s*}\s*from\s*['"][^'"]+['"]/g;
  const symbolDefs = new Map();
  const symbolUses = new Map();

  for (const f of allFiles) {
    const code = fs.readFileSync(abs(f), "utf8");
    let m;
    while ((m = exportRegex.exec(code))) {
      if (m[1]) {
        const name = m[1].trim();
        const set = symbolDefs.get(name) || new Set();
        set.add(f);
        symbolDefs.set(name, set);
      } else if (m[2]) {
        m[2]
          .split(",")
          .map(
            (s) =>
              s.trim().split(/\s+as\s+/)[1] || s.trim().split(/\s+as\s+/)[0]
          )
          .forEach((name) => {
            const set = symbolDefs.get(name) || new Set();
            set.add(f);
            symbolDefs.set(name, set);
          });
      }
    }
    while ((m = importNameRegex.exec(code))) {
      m[1]
        .split(",")
        .map((s) => s.trim().split(/\s+as\s+/)[0])
        .forEach((name) => {
          symbolUses.set(name, (symbolUses.get(name) || 0) + 1);
        });
    }
  }

  const unusedExports = [];
  for (const [name, files] of symbolDefs.entries()) {
    const used = symbolUses.get(name) || 0;
    if (used === 0) {
      files.forEach((f) => unusedExports.push({ file: f, export: name }));
    }
  }

  const pkgJson = JSON.parse(fs.readFileSync(abs("package.json"), "utf8"));
  const declared = new Set([
    ...Object.keys(pkgJson.dependencies || {}),
    ...Object.keys(pkgJson.devDependencies || {}),
  ]);
  const usedPkgs = new Set([...pkgImports.keys()]);
  const strayDeps = [...declared].filter(
    (d) => !usedPkgs.has(d) && !d.startsWith("@types/")
  );

  const schemaFiles = fg
    .sync(["schemas/**/*.json"], { cwd: projectRoot, dot: true })
    .map((f) => f.replaceAll("\\", "/"));
  const boundarySchemaRefs = new Set();
  (boundaries.rules || []).forEach((r) => {
    if (typeof r.validateWithSchema === "string")
      boundarySchemaRefs.add(rel(r.validateWithSchema));
  });
  if (cfg.crossChecks?.schemaSchedule)
    boundarySchemaRefs.add(
      cfg.crossChecks.schemaSchedule.replaceAll("\\", "/")
    );
  const danglingSchemas = schemaFiles.filter((f) => !boundarySchemaRefs.has(f));

  const staleFixtures = fg
    .sync(["src/**/data/fixtures/**"], { cwd: projectRoot, dot: true })
    .map((f) => f.replaceAll("\\", "/"))
    .filter(passIgnore)
    .filter(
      (f) =>
        daysSinceModified(abs(f)) >
        (cfg.thresholds?.maxDaysSinceModifiedForFixture || 365)
    );

  const orphanWorkers = allWorkers.filter((f) => !referencedWorkers.has(f));

  const out = { ...cfg };
  out.candidates = [
    ...unref.map((f) => ({ type: "unreferencedFile", file: f })),
    ...unusedExports.map((u) => ({
      type: "unusedExport",
      file: u.file,
      export: u.export,
    })),
    ...strayDeps.map((d) => ({ type: "strayDependency", dependency: d })),
    ...danglingSchemas.map((s) => ({ type: "danglingSchema", file: s })),
    ...staleFixtures.map((s) => ({ type: "staleFixture", file: s })),
    ...orphanWorkers.map((w) => ({ type: "orphanWorker", file: w })),
  ];
  out.unreferencedFiles = unref;
  out.unusedExports = unusedExports;
  out.strayDependencies = {
    packageJson: "package.json",
    unused: strayDeps,
    maybeUnused: [],
    devOnlyButImportedInSrc: [],
  };
  out.danglingSchemas = danglingSchemas;
  out.staleFixtures = staleFixtures;
  out.orphanWorkers = orphanWorkers;

  const errs = [];
  const cap = out.ciPolicy || {};
  const pushIf = (cond, msg) => {
    if (cond) errs.push(msg);
  };

  pushIf(
    (cap.maxUnreferencedFiles ?? 0) < unref.length,
    `Unreferenced files ${unref.length} > cap`
  );
  pushIf(
    (cap.maxUnusedExports ?? 0) < unusedExports.length,
    `Unused exports ${unusedExports.length} > cap`
  );
  pushIf(
    (cap.maxStrayDependencies ?? 0) < strayDeps.length,
    `Stray deps ${strayDeps.length} > cap`
  );
  pushIf(
    (cap.maxOrphanWorkers ?? 0) < orphanWorkers.length,
    `Orphan workers ${orphanWorkers.length} > cap`
  );
  pushIf(
    (cap.maxDanglingSchemas ?? 0) < danglingSchemas.length,
    `Dangling schemas ${danglingSchemas.length} > cap`
  );
  pushIf(
    (cap.maxStaleFixtures ?? 0) < staleFixtures.length,
    `Stale fixtures ${staleFixtures.length} > cap`
  );

  // Write JSON + Markdown, and print console summary
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2));
  writeMarkdown(out);
  printSummaryToConsole(out, allFiles.length);

  const ok = errs.length === 0;
  const kind = ok ? pc.green("OK") : pc.red("FAIL");
  console.log(
    `${kind} • Wrote findings to ${rel(CONFIG_PATH)} and ${rel(MD_PATH)}`
  );
  if (!ok && (cap.onError || out.enforcement?.onError) !== "log")
    process.exit(1);
}

if (WATCH) {
  console.log(pc.cyan("Watching for changes… Ctrl+C to stop."));
  mainOnce();
  fs.watch(abs("src"), { recursive: true }, () => mainOnce());
} else {
  mainOnce();
}

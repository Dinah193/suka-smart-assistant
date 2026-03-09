// C:\Users\larho\suka-smart-assistant\src\services\automation\autoRegisterTemplates.js
//
// Browser-safe + Node-capable template auto-register.
// - In the browser: uses import.meta.glob() only (no Node builtins imported).
// - In Node: lazily imports node:path, node:fs/promises, node:url *inside* Node-only functions.
//

import { automation } from "@/services/automation/runtime";

/* ------------------------------- env helpers ------------------------------- */
const IS_BROWSER = typeof window !== "undefined";
const getEnv = (k) =>
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env[k]) ??
  (typeof process !== "undefined" && process.env && process.env[k]) ??
  undefined;

const DEV = !!(
  (typeof import.meta !== "undefined" && import.meta.env?.DEV) ||
  (typeof process !== "undefined" && process.env?.NODE_ENV === "development")
);

const DEFAULT_DIRS = ["src/services/templates"];
const EXCLUDE_DEFAULT = ["**/triggers/**", "**/__fixtures__/**", "**/*.d.ts"];

const DIRS = (getEnv("VITE_SUKA_TEMPLATES_DIRS") || getEnv("SUKA_TEMPLATES_DIRS") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const EXCLUDES = (getEnv("VITE_SUKA_TEMPLATES_EXCLUDE") || getEnv("SUKA_TEMPLATES_EXCLUDE") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const EXT_GLOBS = ["js", "mjs", "cjs", "ts"];

/* --------------------------------- logger --------------------------------- */
function log(level, ...args) {
  if (level === "debug" && !DEV) return;
  (console[level] || console.log)(...args);
}

/* --------------------------- normalization helpers ------------------------- */
function toRuntimeTemplateShape(input) {
  if (!input) return null;
  let tpl = input;

  if (typeof tpl?.then === "function") return null;
  if (typeof tpl === "function" && !tpl.prototype) {
    try {
      const out = tpl();
      if (out) tpl = out;
    } catch {}
  }

  if (tpl && typeof tpl === "object" && tpl.default && typeof tpl.default === "object") {
    tpl = tpl.default;
  }
  if (!tpl || typeof tpl !== "object") return null;

  const runLike = tpl.run || tpl.execute || tpl.handler || tpl.runStep || tpl.perform;

  if (tpl.meta?.id && typeof (tpl.run || tpl.execute) === "function") {
    return {
      id: String(tpl.meta.id),
      title: String(tpl.meta.title || tpl.meta.name || tpl.meta.id || ""),
      description: String(tpl.meta.description || tpl.meta.purpose || ""),
      guard: tpl.guard || tpl.shouldRun,
      onRegister: tpl.onRegister || tpl.registerWith,
      run: tpl.run || tpl.execute,
    };
  }

  if ((tpl.id || tpl.name) && typeof runLike === "function") {
    return {
      id: String(tpl.id || tpl.name),
      title: String(tpl.title || tpl.name || tpl.id || ""),
      description: String(tpl.description || tpl.purpose || ""),
      guard: tpl.guard || tpl.shouldRun,
      onRegister: tpl.onRegister || tpl.registerWith,
      run: runLike,
    };
  }

  return null;
}

function pickNormalizedFromModule(mod) {
  const candidates = [
    mod?.default,
    mod?.template,
    typeof mod?.getTemplate === "function" ? mod.getTemplate() : null,
    mod,
  ].filter(Boolean);

  for (const c of candidates) {
    const normalized = toRuntimeTemplateShape(c);
    if (normalized) return normalized;
  }
  return null;
}

function registerOne(normalized, sourcePath) {
  if (!normalized?.id || typeof normalized.run !== "function") return false;

  const existing = automation.getTemplates?.().find((t) => t.id === normalized.id);
  if (existing && !DEV) {
    log("debug", `[automation] skip duplicate template id="${normalized.id}" from ${sourcePath}`);
    return false;
  }
  const ok = automation.registerTemplate(normalized);
  if (ok && DEV) log("debug", `[automation] registered template: ${normalized.id} (${sourcePath})`);
  try {
    normalized.onRegister?.(automation);
  } catch (e) {
    log("warn", `[automation] onRegister failed for ${normalized.id}:`, e?.message || e);
  }
  return ok;
}

/* ------------------------------- vite (browser) ---------------------------- */
function viteGlobAvailable() {
  return typeof import.meta?.glob === "function";
}

/**
 * Static, browser-safe globs. No absolute `/node:` imports here.
 * Keep patterns static literals for Vite.
 */
function makeViteModuleMap() {
  const m1 = import.meta.glob("../templates/**/*.template.{js,mjs,cjs,ts}", { eager: false });
  const m2 = import.meta.glob("../../automations/templates/**/*.template.{js,mjs,cjs,ts}", { eager: false });
  const m3 = import.meta.glob("../templates/**/*.{js,mjs,cjs,ts}", { eager: false });
  const m4 = import.meta.glob("../../automations/templates/**/*.{js,mjs,cjs,ts}", { eager: false });
  return { ...m1, ...m2, ...m3, ...m4 };
}

function isExcluded(p) {
  const list = (EXCLUDES.length ? EXCLUDES : EXCLUDE_DEFAULT).concat(EXCLUDE_DEFAULT);
  const tests = list.map((s) => s.replace(/\*\*/g, "").replace(/\*/g, ""));
  return tests.some((seg) => seg && p.includes(seg));
}

/* ---------------------------- node-only utilities -------------------------- */
/**
 * Lazily import Node builtins **inside** Node-only paths.
 * This prevents Vite’s browser build from choking on `node:*` imports.
 */
async function getNodeDeps() {
  // Indirect dynamic import keeps browser bundlers from trying to resolve node:*.
  const dynamicImport = new Function("s", "return import(s)");
  const pathMod = await dynamicImport("node:path");
  const fsMod = await dynamicImport("node:fs/promises");
  const urlMod = await dynamicImport("node:url");
  // Some environments default-export, some don’t
  const path = pathMod.default ?? pathMod;
  const fs = fsMod.default ?? fsMod;
  const { pathToFileURL } = urlMod;
  return { path, fs, pathToFileURL };
}

async function walkDir(root) {
  const { fs, path } = await getNodeDeps();
  const out = [];
  async function walk(current) {
    const ents = await fs.readdir(current, { withFileTypes: true });
    for (const ent of ents) {
      const p = path.join(current, ent.name);
      if (ent.isDirectory()) {
        if (isExcluded(p)) continue;
        await walk(p);
      } else {
        if (isExcluded(p)) continue;
        if (EXT_GLOBS.some((ext) => p.endsWith("." + ext))) out.push(p);
      }
    }
  }
  await walk(root);
  return out;
}

async function nodeDiscoverFiles() {
  const { path, fs } = await getNodeDeps();
  const dirs = DIRS.length ? DIRS : DEFAULT_DIRS;
  const files = [];
  for (const dir of dirs) {
    const abs = path.resolve(process.cwd(), dir);
    try {
      const exists = await fs.stat(abs).then((s) => s.isDirectory()).catch(() => false);
      if (!exists) continue;
      const found = await walkDir(abs);
      files.push(...found);
    } catch {
      // ignore
    }
  }
  return files;
}

async function nodeImportModule(absPath) {
  const { pathToFileURL } = await getNodeDeps();
  const url = pathToFileURL(absPath).href;
  try {
    const mod = await (/* @vite-ignore */ import(url));
    return mod;
  } catch (e) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(absPath);
      return mod?.__esModule ? (mod.default || mod) : mod;
    } catch {
      throw e;
    }
  }
}

/* ----------------------------------- main ---------------------------------- */
export async function autoRegisterTemplates() {
  const registeredIds = new Set();

  if (viteGlobAvailable()) {
    const modules = makeViteModuleMap();
    for (const p in modules) {
      if (isExcluded(p)) continue;
      try {
        const mod = await modules[p]();
        let normalized = pickNormalizedFromModule(mod);
        if (!normalized && typeof mod?.default === "function") {
          try {
            const maybe = await Promise.resolve(mod.default());
            normalized = toRuntimeTemplateShape(maybe);
          } catch {}
        }
        if (normalized && !registeredIds.has(normalized.id)) {
          if (registerOne(normalized, p)) registeredIds.add(normalized.id);
        } else if (DEV) {
          log("debug", `[automation] skipped non-template module: ${p}`);
        }
      } catch (e) {
        log("warn", `[automation] failed to register template at ${p}:`, e?.message || e);
      }
    }
  } else {
    // Node fallback (only in non-browser contexts)
    const files = await nodeDiscoverFiles();
    for (const abs of files) {
      try {
        const mod = await nodeImportModule(abs);
        let normalized = pickNormalizedFromModule(mod);
        if (!normalized && typeof mod === "function") {
          try {
            const maybe = await Promise.resolve(mod());
            normalized = toRuntimeTemplateShape(maybe);
          } catch {}
        }
        if (normalized && !registeredIds.has(normalized.id)) {
          if (registerOne(normalized, abs)) registeredIds.add(normalized.id);
        } else if (DEV) {
          log("debug", `[automation] skipped non-template module: ${abs}`);
        }
      } catch (e) {
        log("warn", `[automation] failed to register template at ${abs}:`, e?.message || e);
      }
    }
  }

  // Safety shims for referenced-but-missing templates
  const ensure = (id) => {
    if (!automation.getTemplates().some((t) => t.id === id)) {
      automation.registerTemplate({
        id,
        title: id,
        description: "Auto shim — returns empty result.",
        run: async () => ({ ok: true, shim: true }),
      });
      if (DEV) log("debug", `[automation] shimmed missing template: ${id}`);
    }
  };
  ensure("garden.queue.refresh");
  ensure("garden.queue.sync");
  ensure("animal.stocking.estimate");

  if (DEV) {
    const ids = automation.getTemplates().map((t) => t.id);
    log("debug", "[automation] templates registered:", ids);
  }
}

export const registerTemplates = autoRegisterTemplates;
export const register = autoRegisterTemplates;
export default autoRegisterTemplates;

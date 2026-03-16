/**
 * @file C:\Users\larho\suka-smart-assistant\src\engines\synthesis\RuleInterpreter.js
 *
 * RuleInterpreter — loads, parses, validates, and normalizes *domain rules*
 * used by the SynthesisEngine. Supports functional and declarative rule styles,
 * optional hot-reload, and multi-source discovery.
 *
 * PIPELINE FIT
 * imports → normalize → intelligence → **rules (this file)** → synthesis(SynthesisEngine)
 * → validator → automation/runtime → (optional) hub export elsewhere
 *
 * WHAT THIS MODULE DOES
 * - Discovers rules from multiple sources/paths (index aggregator, per-domain files).
 * - Validates and normalizes rules to a canonical shape usable by SynthesisEngine.
 * - Emits automation events for observability (no household data mutation here).
 * - Caches results with a simple version/etag; supports reload() to refresh.
 *
 * EVENT ENVELOPE SHAPE: { type, ts, source, data }
 *   rules.load.started | rules.load.completed | rules.load.error
 *   rules.rule.registered | rules.rule.invalid
 *
 * RULE SHAPES SUPPORTED
 *  1) Functional:
 *     export default async function ({ item, ctx, options }) { return { steps?, sessions?, diag? } }
 *
 *  2) Declarative:
 *     export default {
 *       id: 'preheat-oven',
 *       domain: 'recipe',
 *       priority: 10,
 *       when: ({ item, ctx }) => boolean,   // optional; default true
 *       produce: ({ item, ctx, options }) => ({ steps?, sessions?, diag? })
 *     }
 *
 *  3) Array of either:
 *     export default [ /* rules * / ]
 *
 * FORWARD-LOOKING
 * - Supports new domains (animal, preservation, storehouse) by simply adding files.
 * - Supports optional YAML rule packs (if a yaml loader is provided upstream that compiles to JS).
 */

import { emit as emitEventBus } from "@/services/events/eventBus";

const SOURCE = "RuleInterpreter";

// ───────────────────────────────────────────────────────────────────────────────
// Public API

/**
 * Load all rules from known sources. Results are cached; pass { force:true }
 * to invalidate the cache. You may provide `domains` to limit loading.
 *
 * @param {{ force?: boolean, domains?: string[] }} [options]
 * @returns {Promise<{ ok: boolean, registry: Map<string, RuleSpec[]>, version: string, sources: string[] }>}
 */
export async function loadAllRules(options = {}) {
  const force = !!options.force;
  const domainsFilter = Array.isArray(options.domains)
    ? options.domains.map(nl)
    : null;

  if (
    !force &&
    CACHE.registry &&
    (!domainsFilter || equalSets(new Set(domainsFilter), CACHE.domainSet))
  ) {
    return {
      ok: true,
      registry: CACHE.registry,
      version: CACHE.version,
      sources: CACHE.sources.slice(),
    };
  }

  emit("rules.load.started", { force, domainsFilter: domainsFilter || "all" });

  const discovered = await discoverRuleModules(domainsFilter);
  const { registry, sources, invalid } = await normalizeAndRegister(
    discovered.modules
  );

  const version = stampVersion(registry);

  CACHE.registry = registry;
  CACHE.version = version;
  CACHE.sources = sources;
  CACHE.domainSet = new Set(registry.keys());

  emit("rules.load.completed", {
    version,
    domains: Array.from(registry.keys()),
    ruleCount: countRules(registry),
    invalidCount: invalid.length,
  });

  // Report invalid rules once (non-fatal)
  for (const inv of invalid) {
    emit("rules.rule.invalid", inv);
  }

  return { ok: true, registry, version, sources };
}

/**
 * Return rules for a domain. Will lazy-load on first call.
 * @param {string} domain
 * @returns {Promise<RuleSpec[]>}
 */
export async function getRules(domain) {
  const d = nl(domain);
  if (!d) return [];
  if (!CACHE.registry) await loadAllRules();
  return CACHE.registry.get(d) || [];
}

/**
 * Register a rule at runtime (e.g., for tests or feature flags).
 * @param {string} domain
 * @param {RuleSpec|RuleFn} rule
 */
export function registerRule(domain, rule) {
  const d = nl(domain);
  if (!d || !rule) return;

  const normalized = toRuleSpec(rule, { fallbackDomain: d });
  if (!normalized.ok) {
    emit("rules.rule.invalid", {
      reason: normalized.error || "normalize failed",
      domain: d,
    });
    return;
  }

  if (!CACHE.registry) {
    CACHE.registry = new Map();
    CACHE.sources = ["runtime"];
  }
  if (!CACHE.registry.has(d)) CACHE.registry.set(d, []);
  CACHE.registry.get(d).push(normalized.rule);
  CACHE.version = stampVersion(CACHE.registry);
  emit("rules.rule.registered", {
    domain: d,
    id: normalized.rule.id || "<fn>",
  });
}

/**
 * Force a reload (invalidates cache).
 * @param {{ domains?: string[] }} [options]
 */
export async function reload(options = {}) {
  return loadAllRules({ force: true, domains: options.domains });
}

/** List domains that currently have rules loaded. */
export function listDomains() {
  if (!CACHE.registry) return [];
  return Array.from(CACHE.registry.keys());
}

/** Get current version/etag of registry (changes when rules change). */
export function getVersion() {
  return CACHE.version || "0";
}

// ───────────────────────────────────────────────────────────────────────────────
// Discovery

/**
 * Discover rule modules from multiple sources to be resilient across build targets.
 * Strategy priority:
 *  1) Aggregator module: src/engines/synthesis/rules/index.js
 *  2) Per-domain modules:
 *     - src/engines/synthesis/rules/{domain}.js
 *     - src/engines/synthesis/rules/{domain}/index.js
 *  3) Generic fallback globs (if bundler supports import.meta.glob eager)
 */
async function discoverRuleModules(domainsFilter) {
  const sources = [];
  const modules = [];

  // 1) Aggregator
  const agg = await softImport("src/engines/synthesis/rules/index.js");
  if (agg) {
    const pack = agg.default || agg;
    const entries = Object.entries(pack).filter(([k]) =>
      includeDomain(domainsFilter, k)
    );
    for (const [k, val] of entries) {
      const domain = nl(k);
      const list = Array.isArray(val) ? val : [val];
      modules.push({ domain, mods: list });
    }
    sources.push("rules/index.js");
  }

  // Known domains (expandable)
  const domainCandidates = [
    "recipe",
    "cleaning",
    "garden",
    "animal",
    "preservation",
    "storehouse",
  ];

  // 2) Per-domain modules
  for (const dom of domainCandidates) {
    if (!includeDomain(domainsFilter, dom)) continue;
    const pathA = `src/engines/synthesis/rules/${dom}.js`;
    const pathB = `src/engines/synthesis/rules/${dom}/index.js`;

    const modA = await softImport(pathA);
    const modB = modA ? null : await softImport(pathB);

    const mod = modA || modB;
    if (mod) {
      const val = mod.default || mod;
      const list = Array.isArray(val) ? val : [val];
      modules.push({ domain: nl(dom), mods: list });
      sources.push(modA ? `${dom}.js` : `${dom}/index.js`);
    }
  }

  // 3) Optional glob (Vite/RS build-time). We gate this to avoid runtime errors in Node.
  const globbed = await eagerGlobIfAvailable(domainsFilter);
  if (globbed.modules.length) {
    modules.push(...globbed.modules);
    sources.push(...globbed.sources);
  }

  return { modules, sources };
}

async function eagerGlobIfAvailable(domainsFilter) {
  try {
    // @ts-ignore — Some bundlers provide import.meta.glob
    if (typeof import.meta?.glob !== "function")
      return { modules: [], sources: [] };

    // Search under the rules folder
    const files = import.meta.glob("/src/engines/synthesis/rules/**/*.js", {
      eager: true,
    });
    const buckets = new Map(); // domain -> list
    const sources = [];

    for (const [path, mod] of Object.entries(files)) {
      const domain = inferDomainFromPath(path);
      if (!domain || !includeDomain(domainsFilter, domain)) continue;
      const val = mod?.default || mod;
      const list = Array.isArray(val) ? val : [val];

      if (!buckets.has(domain)) buckets.set(domain, []);
      buckets.get(domain).push(...list);
      sources.push(path.replace(/^\/?src\//, "src/"));
    }

    const modules = Array.from(buckets.entries()).map(([domain, mods]) => ({
      domain: nl(domain),
      mods,
    }));
    return { modules, sources };
  } catch {
    return { modules: [], sources: [] };
  }
}

function inferDomainFromPath(p) {
  const m =
    String(p).match(/rules\/([^\/]+)\/?(index)?\.js$/i) ||
    String(p).match(/rules\/([^\/]+)\.js$/i);
  return m ? nl(m[1]) : null;
}

// ───────────────────────────────────────────────────────────────────────────────
// Normalize & Register

async function normalizeAndRegister(discovered) {
  const registry = new Map();
  const sources = [];
  const invalid = [];

  for (const entry of discovered) {
    const d = nl(entry.domain);
    if (!registry.has(d)) registry.set(d, []);
    for (const raw of entry.mods) {
      const norm = toRuleSpec(raw, { fallbackDomain: d });
      if (norm.ok) {
        registry.get(d).push(norm.rule);
      } else {
        invalid.push({
          domain: d,
          reason: norm.error || "invalid",
          sample: summarizeRule(raw),
        });
      }
    }
    sources.push(d);
  }

  // order by priority (desc), then id for stability
  for (const [dom, list] of registry) {
    list.sort(
      (a, b) =>
        (b.priority || 0) - (a.priority || 0) ||
        String(a.id || "").localeCompare(String(b.id || ""))
    );
  }

  return { registry, sources: Array.from(new Set(sources)), invalid };
}

function toRuleSpec(raw, { fallbackDomain }) {
  try {
    // Functional
    if (typeof raw === "function") {
      const id = raw.name || undefined;
      return {
        ok: true,
        rule: {
          id,
          domain: fallbackDomain,
          priority: 0,
          when: () => true,
          produce: async (...args) => raw(...args), // maintain signature
          __kind: "fn",
        },
      };
    }

    // Declarative object
    if (raw && typeof raw === "object") {
      // If it's nested { default: {...} }
      const obj =
        raw.default && typeof raw.default === "object" ? raw.default : raw;

      // Array pack inside single file
      if (Array.isArray(obj)) {
        // handled by caller — should not reach here
        return { ok: false, error: "Array should be unpacked earlier" };
      }

      const id = obj.id || null;
      const domain = nl(obj.domain) || nl(fallbackDomain);
      const when = typeof obj.when === "function" ? obj.when : () => true;
      const produce = typeof obj.produce === "function" ? obj.produce : null;

      if (!produce) {
        return { ok: false, error: "Missing produce()" };
      }

      const rule = {
        id,
        domain,
        priority: toInt(obj.priority, 0),
        when,
        produce,
        __kind: "decl",
      };
      return { ok: true, rule };
    }

    return { ok: false, error: "Unsupported rule shape" };
  } catch (err) {
    return { ok: false, error: err?.message || "normalize failed" };
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Cache

const CACHE = {
  registry: /** @type {Map<string, RuleSpec[]>|null} */ (null),
  version: /** @type {string|null} */ (null),
  sources: /** @type {string[]} */ ([]),
  domainSet: /** @type {Set<string>|null} */ (null),
};

function stampVersion(registry) {
  const acc = [];
  for (const [dom, list] of registry.entries()) {
    acc.push(dom);
    for (const r of list) {
      acc.push(String(r.id || "<fn>"));
      acc.push(String(r.priority || 0));
    }
  }
  return hash(acc.join("|"));
}

function countRules(registry) {
  let n = 0;
  for (const arr of registry.values()) n += arr.length;
  return n;
}

// ───────────────────────────────────────────────────────────────────────────────
// Small utils

function emit(type, data) {
  try {
    eventBus.emit("automation.event", {
      type,
      ts: new Date().toISOString(),
      source: SOURCE,
      data,
    });
  } catch {
    /* never throw */
  }
}

async function softImport(path) {
  try {
    const mod = await import(/* @vite-ignore */ path);
    return mod?.default ? mod : mod; // return module; caller handles .default
  } catch {
    return null;
  }
}

function summarizeRule(raw) {
  if (typeof raw === "function") return `<fn:${raw.name || "anonymous"}>`;
  if (Array.isArray(raw)) return `<array:${raw.length}>`;
  if (raw && typeof raw === "object")
    return `<obj:${Object.keys(raw).slice(0, 3).join(",")}>`;
  return String(raw);
}

function nl(s) {
  return s ? String(s).toLowerCase().trim() : "";
}

function toInt(n, fallback) {
  const x = Number.parseInt(n, 10);
  return Number.isFinite(x) ? x : fallback;
}

function equalSets(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function hash(str) {
  let h = 2166136261 >>> 0; // FNV-1a
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16);
}

// ───────────────────────────────────────────────────────────────────────────────
// Type hints (JSDoc)

/**
 * @typedef {Object} RuleSpec
 * @property {string|null} [id]
 * @property {string} domain
 * @property {number} [priority]
 * @property {(args:{item:any,ctx:any,options?:any})=>boolean} [when]
 * @property {(args:{item:any,ctx:any,options?:any})=>Promise<{steps?:any[],sessions?:any[],diag?:any[]}>} produce
 * @property {'fn'|'decl'} [__kind]
 */

/**
 * @typedef {(args:{item:any,ctx:any,options?:any})=>Promise<{steps?:any[],sessions?:any[],diag?:any[]}>} RuleFn
 */

// ───────────────────────────────────────────────────────────────────────────────

export default {
  loadAllRules,
  getRules,
  registerRule,
  listDomains,
  reload,
  getVersion,
};

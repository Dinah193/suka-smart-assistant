// File: C:\Users\larho\suka-smart-assistant\src\reasoner\modes\registry.js
/**
 * Reasoner Mode Registry (SSA)
 * -----------------------------------------------------------------------------
 * Fix: Vite import-glob requires a *literal* pattern. The previous version allowed
 * a variable pattern and caused:
 *   [vite:import-glob] Invalid glob import syntax: Could only use literals
 *
 * This version keeps everything else production-ready while making the glob
 * literal and still allowing you to "discover" modes.
 *
 * Mode contract (recommended)
 *  A mode is an object with:
 *    {
 *      id: string,
 *      title?: string,
 *      description?: string,
 *      version?: string,
 *      tags?: string[],
 *      priority?: number,            // higher wins when resolving
 *      isAvailable?: (ctx)=>boolean, // optional gate (feature flags, env)
 *      run: async (input, ctx)=>any, // required
 *      explain?: (input, ctx)=>any,  // optional metadata
 *    }
 *
 * Auto-discovery
 *  - Looks for "./*.mode.js" and "./*.mode.jsx" in this folder.
 *  - Registers them lazily to avoid bundling everything upfront.
 */

const SOURCE = "reasoner.modes.registry";

/* -----------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

const isObj = (x) => x && typeof x === "object" && !Array.isArray(x);
const safeObj = (x) => (isObj(x) ? x : {});
const safeArr = (x) => (Array.isArray(x) ? x : []);
const keyOf = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");

function ensureId(id) {
  const k = keyOf(id);
  if (!k) throw new Error(`[${SOURCE}] Mode id is required`);
  return k;
}

function normalizeMode(mode) {
  const m = safeObj(mode);
  const id = ensureId(m.id);

  if (typeof m.run !== "function") {
    throw new Error(
      `[${SOURCE}] Mode "${id}" must define async run(input, ctx)`
    );
  }

  return {
    id,
    title: m.title ? String(m.title) : id,
    description: m.description ? String(m.description) : "",
    version: m.version ? String(m.version) : "1.0.0",
    tags: safeArr(m.tags).map(String),
    priority: Number.isFinite(m.priority) ? Number(m.priority) : 0,
    isAvailable: typeof m.isAvailable === "function" ? m.isAvailable : null,
    run: m.run,
    explain: typeof m.explain === "function" ? m.explain : null,
    meta: safeObj(m.meta),
    source: m.source || SOURCE,
  };
}

function isModeAvailable(mode, ctx) {
  try {
    if (!mode) return false;
    if (typeof mode.isAvailable !== "function") return true;
    return !!mode.isAvailable(ctx);
  } catch {
    return false;
  }
}

/* -----------------------------------------------------------------------------
 * IMPORTANT: Vite glob must be literal
 * -------------------------------------------------------------------------- */

// NOTE: This MUST be a literal string for Vite.
const DISCOVERED_MODE_MODULES = import.meta.glob("./*.mode.{js,jsx}"); // literal pattern

/* -----------------------------------------------------------------------------
 * Registry implementation
 * -------------------------------------------------------------------------- */

function createModeRegistry() {
  /** @type {Map<string, any>} */
  const modes = new Map(); // id -> normalized mode

  /** @type {Map<string, Function>} */
  const lazyLoaders = new Map(); // id -> async loader()

  /** @type {Set<string>} */
  const loading = new Set(); // ids currently loading to prevent cycles

  /** Auto-discovery (optional) */
  let discovered = false;
  let discoverPromise = null;

  function register(mode) {
    const normalized = normalizeMode(mode);
    modes.set(normalized.id, normalized);
    if (lazyLoaders.has(normalized.id)) lazyLoaders.delete(normalized.id);
    return normalized;
  }

  function registerMany(list) {
    return safeArr(list).map((m) => register(m));
  }

  function registerLazy(id, loader) {
    const mid = ensureId(id);
    if (typeof loader !== "function") {
      throw new Error(
        `[${SOURCE}] registerLazy("${mid}") requires a loader function`
      );
    }
    if (!modes.has(mid)) lazyLoaders.set(mid, loader);
    return mid;
  }

  function has(id) {
    const mid = ensureId(id);
    return modes.has(mid) || lazyLoaders.has(mid);
  }

  function get(id) {
    const mid = ensureId(id);
    return modes.get(mid) || null;
  }

  async function getAsync(id) {
    const mid = ensureId(id);

    const existing = modes.get(mid);
    if (existing) return existing;

    const loader = lazyLoaders.get(mid);
    if (!loader) return null;

    if (loading.has(mid)) {
      await Promise.resolve();
      return modes.get(mid) || null;
    }

    loading.add(mid);
    try {
      const loaded = await loader();
      const m = loaded?.default || loaded?.mode || loaded;
      if (!m) return null;
      if (!m.id) m.id = mid;
      return register(m);
    } finally {
      loading.delete(mid);
    }
  }

  function list() {
    const out = [];

    for (const m of modes.values()) out.push(m);

    for (const [id] of lazyLoaders.entries()) {
      if (modes.has(id)) continue;
      out.push({
        id,
        title: id,
        description: "(lazy)",
        version: "0.0.0",
        tags: ["lazy"],
        priority: -999,
        isAvailable: null,
        run: async () => {
          throw new Error(
            `[${SOURCE}] Lazy mode "${id}" is not loaded. Call getAsync("${id}") or run("${id}") which auto-loads.`
          );
        },
        explain: null,
        meta: { lazy: true },
        source: SOURCE,
      });
    }

    out.sort((a, b) => {
      const pa = Number(a.priority || 0);
      const pb = Number(b.priority || 0);
      if (pb !== pa) return pb - pa;
      return String(a.id).localeCompare(String(b.id));
    });

    return out;
  }

  function listAvailable(ctx) {
    return list().filter((m) => isModeAvailable(m, ctx));
  }

  function resolve(preferred, ctx) {
    const prefList = Array.isArray(preferred)
      ? preferred.map(ensureId)
      : preferred
      ? [ensureId(preferred)]
      : [];

    for (const id of prefList) {
      const m = modes.get(id);
      if (m && isModeAvailable(m, ctx)) return id;
      if (!m && lazyLoaders.has(id)) return id; // will be loaded at run-time
    }

    const candidates = Array.from(modes.values()).filter((m) =>
      isModeAvailable(m, ctx)
    );
    candidates.sort((a, b) => {
      const pa = Number(a.priority || 0);
      const pb = Number(b.priority || 0);
      if (pb !== pa) return pb - pa;
      return String(a.id).localeCompare(String(b.id));
    });

    return candidates[0]?.id || null;
  }

  async function run(id, input, ctx) {
    const mid = ensureId(id);
    const mode = (await getAsync(mid)) || modes.get(mid);

    if (!mode) throw new Error(`[${SOURCE}] Unknown mode "${mid}"`);
    if (!isModeAvailable(mode, ctx)) {
      throw new Error(
        `[${SOURCE}] Mode "${mid}" is not available for this context`
      );
    }

    return await mode.run(input, ctx);
  }

  /**
   * Auto-discover modes using the literal glob above.
   * - Registers each discovered file as a *lazy* mode.
   * - Derived id uses filename: "./cleaning.mode.js" => "cleaning"
   */
  async function discover() {
    if (discovered) return;
    if (discoverPromise) return discoverPromise;

    discoverPromise = (async () => {
      try {
        const entries = Object.entries(DISCOVERED_MODE_MODULES || {});
        for (const [path, loader] of entries) {
          if (typeof loader !== "function") continue;

          const file = String(path).split("/").pop() || String(path);
          const derivedId = ensureId(file.replace(/\.mode\.(js|jsx)$/i, ""));

          registerLazy(derivedId, async () => {
            const mod = await loader();
            const m = mod?.default || mod?.mode || mod;
            if (!m)
              throw new Error(
                `[${SOURCE}] Discovered module "${path}" did not export a mode`
              );
            if (!m.id) m.id = derivedId;
            return m;
          });
        }
      } finally {
        discovered = true;
      }
    })();

    return discoverPromise;
  }

  function _resetForTests() {
    modes.clear();
    lazyLoaders.clear();
    loading.clear();
    discovered = false;
    discoverPromise = null;
  }

  return {
    register,
    registerMany,
    registerLazy,
    has,
    get,
    getAsync,
    list,
    listAvailable,
    resolve,
    run,
    discover,
    _resetForTests,
  };
}

/* -----------------------------------------------------------------------------
 * Singleton export
 * -------------------------------------------------------------------------- */

const registry = createModeRegistry();

// Safe fallback mode (ensures resolve() can always find something if desired)
registry.register({
  id: "noop",
  title: "No-op",
  description: "Safe fallback mode that returns the input unchanged.",
  priority: -10000,
  tags: ["fallback"],
  isAvailable: () => true,
  run: async (input) => ({
    ok: true,
    mode: "noop",
    output: input,
    meta: { note: "noop mode (fallback)" },
  }),
});

/**
 * Back-compat export expected by prompt builder:
 *   import { getModeConfig } from "@/reasoner/modes/registry";
 *
 * Returns a *sync* snapshot of mode metadata if available.
 * - If the mode is already loaded: returns the normalized mode object.
 * - If the mode is known but lazy (not loaded yet): returns a lightweight placeholder.
 * - If unknown: returns null.
 */
export function getModeConfig(id) {
  try {
    const mid = String(id || "").trim();
    if (!mid) return null;
    const normalizedId = mid
      .toLowerCase()
      .replace(/[^\w]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!normalizedId) return null;

    const loaded = registry.get(normalizedId);
    if (loaded) return loaded;

    if (registry.has(normalizedId)) {
      // Known but lazy/not yet loaded
      return {
        id: normalizedId,
        title: normalizedId,
        description: "(lazy)",
        version: "0.0.0",
        tags: ["lazy"],
        priority: -999,
        isAvailable: null,
        explain: null,
        meta: { lazy: true },
        source: SOURCE,
      };
    }

    return null;
  } catch {
    return null;
  }
}

export default registry;
export { registry };

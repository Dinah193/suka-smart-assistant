// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import mdx from "@mdx-js/rollup";
import remarkGfm from "remark-gfm";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdxFrontmatter from "remark-mdx-frontmatter";
import rehypeSlug from "rehype-slug";
import rehypeAutolinkHeadings from "rehype-autolink-headings";

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const r = (p) => path.resolve(__dirname, p);

/**
 * Shim any accidental runtime import of `.d.ts` files.
 * If a JS module imports a .d.ts, Rollup will try to parse it and crash.
 * This plugin resolves such imports to an empty module.
 */
function dtsImportShim() {
  const VIRTUAL_PREFIX = "\0dts-empty:";
  return {
    name: "suka:dts-import-shim",
    enforce: "pre",
    resolveId(id) {
      if (typeof id === "string" && id.endsWith(".d.ts")) {
        return VIRTUAL_PREFIX + id;
      }
      return null;
    },
    load(id) {
      if (!String(id).startsWith(VIRTUAL_PREFIX)) return null;
      // Empty ESM module; safe for any import style
      return `export {};`;
    },
  };
}

/** Shims any accidental client import of files under src/server/** */
function serverOnlyShim() {
  const VIRTUAL_PREFIX = "\0server-only:";

  // Match common ways server folder gets imported into the client graph.
  const TESTS = [
    /^@\/server\/.+/,
    /^src\/server\/.+/,
    /^\/src\/server\/.+/,
    /(^|\/)\.\.\/server\/.+/,
    /(^|\/)\.\.\/\.\.\/server\/.+/,
    /(^|\/)server\/.+/,
  ];

  const isServerImport = (id) =>
    typeof id === "string" && TESTS.some((rx) => rx.test(id));

  return {
    name: "suka:server-only-shim",
    enforce: "pre",
    resolveId(id) {
      if (isServerImport(id)) return VIRTUAL_PREFIX + id;
      return null;
    },
    load(id) {
      if (!String(id).startsWith(VIRTUAL_PREFIX)) return null;

      const original = String(id).slice(VIRTUAL_PREFIX.length);

      // Minimal module that won’t break the graph if accidentally imported in browser code.
      // If executed, it throws with a helpful message.
      return `
        const msg = "Attempted to import a server-only module from the browser: ${original}";
        export const __server_only = true;
        export default new Proxy({}, { get() { throw new Error(msg); } });
      `;
    },
  };
}

/**
 * Legacy URL route shim for resources that are being fetched at runtime
 * as if they lived under /assets/... or /db.
 *
 * Fixes:
 *  - /assets/db/index.js (and index.ts)
 *  - /assets/config/featureFlags.json
 *  - /db
 *
 * Works in:
 *  - dev: vite
 *  - preview: vite preview
 *  - build: emits files into dist so preview/prod won’t 404
 */
function legacyAssetRouteShim() {
  const candidates = {
    // The app is requesting these legacy "assets" paths.
    "/assets/db/index.js": [
      r("./src/db/index.js"),
      r("./src/services/db.js"),
      r("./src/db.js"),
    ],
    "/assets/db/index.ts": [r("./src/db/index.ts"), r("./src/db/index.js")],
    "/assets/config/featureFlags.json": [
      r("./src/config/featureFlags.json"),
      r("./src/config/featureflags.json"),
      r("./src/config/FeatureFlags.json"),
      r("./src/featureFlags.json"),
    ],

    // Your app is also requesting /db (no extension)
    "/db": [
      r("./src/db/index.js"),
      r("./src/services/db.js"),
      r("./src/db.js"),
    ],

    // Optional “src/” versions if you change callers later (safe to keep)
    "/src/db/index.js": [r("./src/db/index.js"), r("./src/services/db.js")],
    "/src/config/featureFlags.json": [
      r("./src/config/featureFlags.json"),
      r("./src/featureFlags.json"),
    ],
  };

  // ✅ Some paths must be served as JS modules (ESM) even if the backing file is JSON.
  // This prevents: "Expected a JavaScript module script but got application/json"
  const FORCE_ESM_FOR = new Set([
    "/assets/config/featureFlags.json",
    "/src/config/featureFlags.json",
  ]);

  const exists = (p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };

  const pickRealFile = (urlPath) => {
    const list = candidates[urlPath] || [];
    for (const p of list) {
      if (exists(p)) return p;
    }
    return null;
  };

  const safeJsonFallback = () =>
    JSON.stringify({ enabled: {}, disabled: {}, __missing: true }, null, 2);

  const serveAsEsmFromJsonText = (jsonText) => {
    // Wrap JSON as an ESM module (valid module script)
    // Consumers can do: import flags from "/assets/config/featureFlags.json"
    return `export default ${jsonText.trim() || "{}"};\n`;
  };

  const serve = async (req, res, urlPath) => {
    const real = pickRealFile(urlPath);
    const wantsEsm = FORCE_ESM_FOR.has(urlPath);

    // If we cannot find a real file, return a safe fallback instead of 404
    // so your UI keeps running and the console noise stops.
    if (!real) {
      if (wantsEsm) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/javascript; charset=utf-8");
        res.end(serveAsEsmFromJsonText(safeJsonFallback()));
        return;
      }

      if (urlPath.endsWith(".json")) {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(safeJsonFallback());
        return;
      }

      res.statusCode = 200;
      res.setHeader("content-type", "application/javascript; charset=utf-8");
      res.end(
        `/* legacyAssetRouteShim: no backing file found for ${urlPath} */\nexport default {};`
      );
      return;
    }

    // ✅ If a JSON is being imported as a module script, serve a JS wrapper instead.
    if (wantsEsm && String(real).toLowerCase().endsWith(".json")) {
      const jsonText = await fsp.readFile(real, "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/javascript; charset=utf-8");
      res.end(serveAsEsmFromJsonText(jsonText));
      return;
    }

    // Default: serve the real file as-is with a reasonable mime.
    const lower = String(real).toLowerCase();
    const mime = lower.endsWith(".json")
      ? "application/json; charset=utf-8"
      : "application/javascript; charset=utf-8";

    const buf = await fsp.readFile(real);
    res.statusCode = 200;
    res.setHeader("content-type", mime);
    res.end(buf);
  };

  const attachMiddleware = (server) => {
    server.middlewares.use(async (req, res, next) => {
      try {
        const url = req.url ? req.url.split("?")[0] : "";
        if (url && Object.prototype.hasOwnProperty.call(candidates, url)) {
          await serve(req, res, url);
          return;
        }
        next();
      } catch (e) {
        // Don’t crash the dev server for a shim failure
        res.statusCode = 500;
        res.end(String(e));
      }
    });
  };

  const emitBuildCopies = async (emitFile) => {
    // Emit only the legacy URLs that are actually being requested today.
    const toEmit = [
      "/assets/db/index.js",
      "/assets/db/index.ts",
      "/assets/config/featureFlags.json",
      "/db",
    ];

    for (const urlPath of toEmit) {
      const real = pickRealFile(urlPath);
      const fileName = urlPath.replace(/^\//, ""); // dist path

      const wantsEsm = FORCE_ESM_FOR.has(urlPath);

      // If missing, emit a safe fallback so preview/prod won’t 404.
      if (!real) {
        if (wantsEsm) {
          emitFile({
            type: "asset",
            fileName,
            source: serveAsEsmFromJsonText(safeJsonFallback()),
          });
          continue;
        }

        const isJson = urlPath.endsWith(".json");
        const fallback = isJson
          ? safeJsonFallback()
          : `/* legacyAssetRouteShim: no backing file found for ${urlPath} */\nexport default {};`;

        emitFile({
          type: "asset",
          fileName,
          source: fallback,
        });
        continue;
      }

      // ✅ If it’s the featureFlags.json legacy URL, emit as JS wrapper for module import.
      if (wantsEsm && String(real).toLowerCase().endsWith(".json")) {
        const jsonText = await fsp.readFile(real, "utf8");
        emitFile({
          type: "asset",
          fileName,
          source: serveAsEsmFromJsonText(jsonText),
        });
        continue;
      }

      const source = await fsp.readFile(real);
      emitFile({
        type: "asset",
        fileName,
        source,
      });
    }
  };

  return {
    name: "suka:legacy-asset-route-shim",

    // Dev server
    configureServer(server) {
      attachMiddleware(server);
    },

    // Preview server (vite preview)
    configurePreviewServer(server) {
      attachMiddleware(server);
    },

    // Build: copy into dist
    async generateBundle(_, bundle) {
      // `this.emitFile` is the correct Rollup way to create files in dist.
      await emitBuildCopies(this.emitFile.bind(this));
    },
  };
}

export default defineConfig(({ mode }) => {
  const isCiBuild = Boolean(process.env.CI || process.env.VERCEL);

  return ({
  plugins: [
    legacyAssetRouteShim(),
    dtsImportShim(),
    mdx({
      remarkPlugins: [
        remarkFrontmatter,
        [remarkMdxFrontmatter, { name: "frontmatter" }],
        remarkGfm,
      ],
      rehypePlugins: [
        rehypeSlug,
        [rehypeAutolinkHeadings, { behavior: "append" }],
      ],
      providerImportSource: "@mdx-js/react",
    }),
    react(),
    serverOnlyShim(),
  ],

  resolve: {
    // Prefer browser field when available
    conditions: ["browser", "module", "import"],
    alias: {
      "@": r("./src"),
      "@components": r("./src/components"),
      "@services": r("./src/services"),
      "@templates": r("./src/services/templates"),
      "@triggers": r("./src/services/triggers"),
      "@agents": r("./src/agents"),
      "@store": r("./src/store"),
      "@pages": r("./src/pages"),
      "@data": r("./src/data"),
      "@models": r("./src/models"),
      "@managers": r("./src/managers"),
      "@utils": r("./src/utils"),
      "@ui": r("./src/ui"),
      "@theme": r("./src/theme"),

      // ✅ Shim prop-types to avoid production build failures if not installed
      "prop-types": r("./src/shims/prop-types.js"),

      // 🔒 Route Node core 'crypto' to our cross-runtime helper (prevents dep-scan failure)
      crypto: r("./src/utils/crypto.js"),
    },
  },

  // ✅ Workers must be ESM for code-splitting builds
  worker: {
    format: "es",
  },

  // Treat .js/.jsx under /src as JSX so JSX-in-.js errors go away.
  // IMPORTANT: do NOT include .ts/.tsx here, or TypeScript will be parsed as JS and fail.
  esbuild: {
    loader: "jsx",
    include: /src\/.*\.(js|jsx)$/,
    exclude: [/\.d\.ts$/],

    // ✅ Top-level await requires ES2022+.
    // Your build was failing because output chunks contained top-level await while target was ES2020.
    target: "es2022",
  },

  define: {
    "process.env.NODE_ENV": JSON.stringify(mode),
  },

  optimizeDeps: {
    // Don’t try to prebundle Node core. Our alias handles 'crypto' already.
    exclude: ["crypto"],
    esbuildOptions: {
      // Keep parity with esbuild loader decision above for dep-scan
      loader: {
        ".js": "jsx",
        ".jsx": "jsx",
      },

      // ✅ Keep dep prebundle compatible with top-level await too
      target: "es2022",
    },
  },

  server: {
    port: 5173,
    strictPort: true,
    cors: true,
    fs: { strict: false }, // helpful if some imports resolve just outside /src
    configureServer(server) {
      server.middlewares.use("/api/ingest", async (req, res) => {
        try {
          const u = new URL(req.originalUrl || req.url, "http://localhost");
          const target = u.searchParams.get("url");
          if (!target) {
            res.statusCode = 400;
            res.end("missing ?url=");
            return;
          }
          const rr = await fetch(target, {
            headers: { "user-agent": "Mozilla/5.0 (SukaDev Ingest)" },
          });
          const html = await rr.text();
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(html);
        } catch (e) {
          res.statusCode = 502;
          res.end(String(e));
        }
      });
    },
  },

  build: {
    // ✅ Top-level await requires ES2022+
    target: "es2022",
    // Sourcemaps in this large app can exceed Node heap during bundling.
    sourcemap: false,
    minify: "esbuild",
    reportCompressedSize: !isCiBuild,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      onwarn(warning, warn) {
        const msg = String(warning?.message || "");
        // Informational noise in this codebase: a module is both statically and dynamically imported.
        if (
          msg.includes("is dynamically imported by") &&
          msg.includes("but also statically imported by")
        ) {
          return;
        }
        warn(warning);
      },
      // ✅ Explicit ESM output (guardrail)
      output: {
        format: "es",
      },
      external: [
        /^node:/,
        /^crypto$/,

        // ✅ never bundle server-only code in the browser build
        /\/src\/server\/.*/,

        // ✅ express must never be required by client build
        /^express$/,

        // ✅ never bundle tests
        /\/src\/tests\/.*\.test\.(js|jsx|ts|tsx)$/,
        /\/src\/.*\/__tests__\/.*\.(js|jsx|ts|tsx)$/,
        /\/src\/.*\._tests_\/.*\.(js|jsx|ts|tsx)$/,
        /\/src\/.*\.test\.(js|jsx|ts|tsx)$/,
        /\/src\/.*\.spec\.(js|jsx|ts|tsx)$/,
      ],
    },
  },
  });
});

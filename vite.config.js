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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const r = (p) => path.resolve(__dirname, p);

/** Shims any accidental client import of files under src/server/** */
function serverOnlyShim() {
  const VIRTUAL_PREFIX = "\0server-only:";
  const TEST = /^@\/server\/(.+)/;
  return {
    name: "suka:server-only-shim",
    resolveId(id) {
      if (TEST.test(id)) return VIRTUAL_PREFIX + id;
      return null;
    },
    load(id) {
      if (!id.startsWith(VIRTUAL_PREFIX)) return null;
      // Minimal module that won’t break the graph if accidentally imported in browser code.
      // If executed, it throws with a helpful message.
      return `
        const msg = "Attempted to import a server-only module from the browser: ${id.replace("${VIRTUAL_PREFIX}", "")}";
        export const __server_only = true;
        export default new Proxy({}, { get() { throw new Error(msg); } });
      `;
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
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

      // 🔒 Route Node core 'crypto' to our cross-runtime helper (prevents dep-scan failure)
      crypto: r("./src/utils/crypto.js"),
    },
  },

  // Treat .js under /src as JSX so the JSX-in-.js errors go away.
  esbuild: {
    loader: "jsx",
    include: /src\/.*\.(js|jsx|ts|tsx)$/,
    exclude: [],
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
      },
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
          if (!target) { res.statusCode = 400; res.end("missing ?url="); return; }
          const r = await fetch(target, { headers: { "user-agent": "Mozilla/5.0 (SukaDev Ingest)" } });
          const html = await r.text();
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.end(html);
        } catch (e) { res.statusCode = 502; res.end(String(e)); }
      });
    },
  },

  build: {
    target: "es2020",
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      // In case anything slips through on production builds, never bundle Node core.
      external: [/^node:/, /^crypto$/],
    },
  },
}));

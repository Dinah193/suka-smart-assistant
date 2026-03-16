/**
 * @file C:\Users\larho\suka-smart-assistant\src\services\scraper\ScraperEngine.js
 *
 * ScraperEngine (Browser-Safe)
 * -----------------------------------------------------------------------------
 * Purpose:
 *  - Parse HTML and extract structured content using CSS selectors.
 *  - Browser-first implementation (Vite client build compatible).
 *
 * Why this exists:
 *  - Your build failed because jsdom was imported in a client bundle.
 *  - jsdom is Node-only; Vite/Rollup will not resolve it for browser builds.
 *
 * Design:
 *  - Uses DOMParser when available.
 *  - If DOMParser is unavailable (rare in client builds), returns a safe failure.
 *  - Emits telemetry events if SSA eventBus is present, but never throws.
 *
 * Notes:
 *  - If you truly need Node-side scraping with jsdom, create a separate file:
 *      ScraperEngine.node.js
 *    and ONLY import it from Node contexts (scripts, server, CLI), not from UI.
 */

const SOURCE = "ScraperEngine";

/* ──────────────────────────────────────────────────────────────────────────────
 * Telemetry (safe)
 */

async function emit(type, data) {
  try {
    const mod = await import("@/services/events/eventBus");
    const bus = mod?.default || mod?.eventBus || mod;
    if (!bus || typeof bus.emit !== "function") return;

    const payload = {
      type,
      ts: new Date().toISOString(),
      source: SOURCE,
      data: safeSerializable(data),
    };

    // Try emitting on the named type; fallback to a shared channel if used
    try {
      bus.emit(type, payload);
    } catch {
      try {
        bus.emit("automation.event", payload);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Public API
 */

/**
 * Parse an HTML string into a Document (browser-safe).
 * Adds/updates a <base> tag to make relative URL resolution consistent.
 *
 * @param {string} html
 * @param {object} [options]
 * @param {string} [options.baseUrl] - used for <base href="...">
 * @returns {{ ok:boolean, doc: Document|null, error?:string }}
 */
export function parseHTML(html, options = {}) {
  try {
    if (typeof html !== "string") {
      return {
        ok: false,
        doc: null,
        error: "parseHTML: html must be a string.",
      };
    }

    // DOMParser is available in browsers
    if (typeof DOMParser === "undefined") {
      return {
        ok: false,
        doc: null,
        error: "parseHTML: DOMParser not available in this runtime.",
      };
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Optional base URL support for resolving links
    const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : "";
    if (baseUrl) ensureBaseHref(doc, baseUrl);

    return { ok: true, doc };
  } catch (e) {
    return { ok: false, doc: null, error: e?.message || String(e) };
  }
}

/**
 * Extract structured data from HTML using a "recipe" object.
 *
 * Example recipe:
 * {
 *   baseUrl: "https://example.com/page",
 *   fields: {
 *     title: { selector: "h1", attr: "text" },
 *     price: { selector: ".price", attr: "text", transform: "number" },
 *     image: { selector: "img.hero", attr: "src", resolveUrl: true },
 *   },
 *   lists: {
 *     bullets: { selector: "ul li", attr: "text" }
 *   },
 *   tables: {
 *     nutrition: { selector: "table.nutrition" }
 *   }
 * }
 *
 * @param {object} args
 * @param {string} args.html
 * @param {string} [args.url] - base URL fallback
 * @param {object} args.recipe
 * @returns {Promise<{ ok:boolean, output:any, meta:any, error?:string }>}
 */
export async function scrape({ html, url, recipe } = {}) {
  const tsStart = new Date().toISOString();
  await emit("scraper.started", {
    hasHtml: typeof html === "string" && html.length > 0,
    url: url || recipe?.baseUrl || null,
  });

  try {
    const baseUrl = (recipe && recipe.baseUrl) || url || "";
    const parsed = parseHTML(html, { baseUrl });

    if (!parsed.ok || !parsed.doc) {
      const err = parsed.error || "Failed to parse HTML.";
      await emit("scraper.error", {
        stage: "parse",
        url: baseUrl || null,
        message: err,
      });
      return {
        ok: false,
        output: null,
        meta: { tsStart, tsEnd: new Date().toISOString() },
        error: err,
      };
    }

    const doc = parsed.doc;

    const output = {
      fields: {},
      lists: {},
      tables: {},
      links: [],
      meta: {},
    };

    // Fields (single values)
    const fields =
      recipe?.fields && typeof recipe.fields === "object" ? recipe.fields : {};
    for (const [key, spec] of Object.entries(fields)) {
      output.fields[key] = extractField(doc, spec, baseUrl);
    }

    // Lists (arrays)
    const lists =
      recipe?.lists && typeof recipe.lists === "object" ? recipe.lists : {};
    for (const [key, spec] of Object.entries(lists)) {
      output.lists[key] = extractList(doc, spec, baseUrl);
    }

    // Tables
    const tables =
      recipe?.tables && typeof recipe.tables === "object" ? recipe.tables : {};
    for (const [key, spec] of Object.entries(tables)) {
      output.tables[key] = extractTable(doc, spec, baseUrl);
    }

    // Optional: collect links
    if (recipe?.collectLinks) {
      output.links = collectLinks(doc, {
        baseUrl,
        filter: recipe.collectLinks,
      });
    }

    // Page meta (title, description, canonical, etc.)
    output.meta = extractPageMeta(doc, baseUrl);

    const tsEnd = new Date().toISOString();
    await emit("scraper.completed", {
      url: baseUrl || null,
      fieldCount: Object.keys(output.fields || {}).length,
      listCount: Object.keys(output.lists || {}).length,
      tableCount: Object.keys(output.tables || {}).length,
      tsStart,
      tsEnd,
    });

    return {
      ok: true,
      output,
      meta: {
        source: SOURCE,
        url: baseUrl || null,
        tsStart,
        tsEnd,
      },
    };
  } catch (e) {
    const msg = e?.message || String(e);
    await emit("scraper.error", {
      stage: "scrape",
      url: url || recipe?.baseUrl || null,
      message: msg,
    });
    return {
      ok: false,
      output: null,
      meta: { tsStart, tsEnd: new Date().toISOString() },
      error: msg,
    };
  }
}

/**
 * Convenience: extract by selectors without full recipe object.
 * @param {object} args
 * @param {string} args.html
 * @param {string} [args.baseUrl]
 * @param {object} args.selectors - { key: "css", ... }
 * @returns {{ ok:boolean, fields:any, error?:string }}
 */
export function extractBySelectors({
  html,
  baseUrl = "",
  selectors = {},
} = {}) {
  const parsed = parseHTML(html, { baseUrl });
  if (!parsed.ok || !parsed.doc)
    return { ok: false, fields: null, error: parsed.error || "parse failed" };

  const out = {};
  for (const [k, sel] of Object.entries(selectors || {})) {
    out[k] = textOf(parsed.doc.querySelector(sel));
  }
  return { ok: true, fields: out };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Extraction helpers
 */

function extractField(doc, spec, baseUrl) {
  const s = spec && typeof spec === "object" ? spec : {};
  const selector = String(s.selector || "").trim();
  if (!selector) return null;

  const el = doc.querySelector(selector);
  if (!el) return null;

  const attr = String(s.attr || "text").toLowerCase();
  let val;

  if (attr === "text") val = textOf(el);
  else if (attr === "html") val = (el && el.innerHTML) || "";
  else if (attr === "value") val = el.value != null ? String(el.value) : null;
  else val = el.getAttribute(attr);

  if (val == null) return null;

  // Optional URL resolution
  if (s.resolveUrl) {
    val = resolveUrl(val, baseUrl);
  }

  // Optional transforms
  val = applyTransform(val, s.transform);

  // Optional post-processing
  if (typeof s.post === "function") {
    try {
      val = s.post(val);
    } catch {
      // ignore
    }
  }

  return val;
}

function extractList(doc, spec, baseUrl) {
  const s = spec && typeof spec === "object" ? spec : {};
  const selector = String(s.selector || "").trim();
  if (!selector) return [];

  const nodes = Array.from(doc.querySelectorAll(selector));
  if (!nodes.length) return [];

  const attr = String(s.attr || "text").toLowerCase();

  const out = [];
  for (const el of nodes) {
    let val;
    if (attr === "text") val = textOf(el);
    else if (attr === "html") val = (el && el.innerHTML) || "";
    else if (attr === "value") val = el.value != null ? String(el.value) : null;
    else val = el.getAttribute(attr);

    if (val == null) continue;

    if (s.resolveUrl) val = resolveUrl(val, baseUrl);
    val = applyTransform(val, s.transform);

    if (val == null) continue;
    if (typeof val === "string" && !val.trim() && !s.keepEmpty) continue;

    out.push(val);
  }

  return out;
}

function extractTable(doc, spec, baseUrl) {
  const s = spec && typeof spec === "object" ? spec : {};
  const selector = String(s.selector || "").trim();
  if (!selector) return null;

  const table = doc.querySelector(selector);
  if (!table) return null;

  const rows = Array.from(table.querySelectorAll("tr"));

  const matrix = rows.map((tr) =>
    Array.from(tr.querySelectorAll("th,td")).map((cell) =>
      normalizeSpace(textOf(cell))
    )
  );

  // Optional: interpret first row as header
  const hasHeader =
    s.hasHeader !== false &&
    matrix.length > 0 &&
    rows[0].querySelectorAll("th").length > 0;

  if (hasHeader) {
    const header = matrix[0].map((h) => slugify(h) || h);
    const body = matrix.slice(1);
    const objects = body.map((r) => {
      const obj = {};
      for (let i = 0; i < header.length; i++) {
        const key = header[i] || `col_${i + 1}`;
        obj[key] = r[i] != null ? r[i] : "";
      }
      return obj;
    });
    return { header, rows: objects, matrix };
  }

  return { matrix };
}

function extractPageMeta(doc, baseUrl) {
  const title = textOf(doc.querySelector("title")) || null;

  const description =
    doc.querySelector('meta[name="description"]')?.getAttribute("content") ||
    doc
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content") ||
    null;

  const canonical =
    doc.querySelector('link[rel="canonical"]')?.getAttribute("href") || null;

  const ogImage =
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
    null;

  return {
    title: title ? normalizeSpace(title) : null,
    description: description ? normalizeSpace(description) : null,
    canonical: canonical ? resolveUrl(canonical, baseUrl) : null,
    ogImage: ogImage ? resolveUrl(ogImage, baseUrl) : null,
  };
}

function collectLinks(doc, { baseUrl = "", filter } = {}) {
  const links = Array.from(doc.querySelectorAll("a[href]"))
    .map((a) => a.getAttribute("href"))
    .filter(Boolean)
    .map((href) => resolveUrl(href, baseUrl))
    .filter(Boolean);

  if (typeof filter === "function") {
    try {
      return links.filter((x) => filter(x));
    } catch {
      return links;
    }
  }

  if (filter && typeof filter === "object") {
    const { include, exclude } = filter;
    return links.filter((x) => {
      if (Array.isArray(exclude) && exclude.some((re) => safeTest(re, x)))
        return false;
      if (Array.isArray(include)) return include.some((re) => safeTest(re, x));
      return true;
    });
  }

  return links;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * DOM + string utilities
 */

function ensureBaseHref(doc, baseUrl) {
  try {
    const head = doc.head || doc.querySelector("head");
    if (!head) return;

    let base = head.querySelector("base");
    if (!base) {
      base = doc.createElement("base");
      head.prepend(base);
    }
    base.setAttribute("href", baseUrl);
  } catch {
    // ignore
  }
}

function resolveUrl(href, baseUrl) {
  const h = String(href || "").trim();
  if (!h) return null;
  if (/^(data:|mailto:|tel:|javascript:)/i.test(h)) return h;

  try {
    // If already absolute, URL() will keep it
    const u = baseUrl ? new URL(h, baseUrl) : new URL(h);
    return u.toString();
  } catch {
    // If URL constructor fails, return original
    return h;
  }
}

function textOf(el) {
  if (!el) return "";
  // Prefer textContent
  const t = el.textContent != null ? String(el.textContent) : "";
  return normalizeSpace(t);
}

function normalizeSpace(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(s) {
  const t = normalizeSpace(s).toLowerCase();
  if (!t) return "";
  return t
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function applyTransform(val, transform) {
  if (!transform) return val;

  const t = typeof transform === "string" ? transform : null;

  if (t === "number") {
    const n = Number(String(val).replace(/[^0-9.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  if (t === "int") {
    const n = Number.parseInt(String(val).replace(/[^0-9\-]/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  if (t === "lower") return String(val).toLowerCase();
  if (t === "upper") return String(val).toUpperCase();
  if (t === "trim") return String(val).trim();

  if (typeof transform === "function") {
    try {
      return transform(val);
    } catch {
      return val;
    }
  }

  return val;
}

function safeTest(reLike, text) {
  try {
    if (reLike instanceof RegExp) return reLike.test(text);
    if (typeof reLike === "string") return new RegExp(reLike).test(text);
  } catch {
    // ignore
  }
  return false;
}

function safeSerializable(x) {
  try {
    return JSON.parse(JSON.stringify(x));
  } catch {
    if (x == null) return null;
    if (
      typeof x === "string" ||
      typeof x === "number" ||
      typeof x === "boolean"
    )
      return x;
    if (Array.isArray(x)) return x.map((v) => safeSerializable(v));
    if (typeof x === "object") {
      const out = {};
      for (const k of Object.keys(x)) {
        const v = x[k];
        if (typeof v === "function") continue;
        out[k] = safeSerializable(v);
      }
      return out;
    }
    return String(x);
  }
}

/* ──────────────────────────────────────────────────────────────────────────────
 * Default export
 */

export default {
  parseHTML,
  scrape,
  extractBySelectors,
};

/**
 * Named export expected by:
 *   import { ScraperEngine } from "@/services/scraper/ScraperEngine";
 *
 * Keep it as a simple object wrapper over the same functions.
 */
export const ScraperEngine = {
  parseHTML,
  scrape,
  extractBySelectors,
};

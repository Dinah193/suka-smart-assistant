/* pinterestResolver.js
   Expand Pinterest pin/board/short URLs into canonical destination (e.g., recipe) URLs.

   Why this exists:
   - Users often paste Pinterest links, but your pipeline needs the actual recipe page.
   - Pinterest renders a big JSON blob in <script id="__PWS_DATA__">. That blob usually
     contains outbound/destination URLs for pins, and enough info on boards to crawl
     a handful of recent pins without API keys.

   What this module does:
   - resolve(url, opts): autodetects pin vs board vs shortlink and returns destination URLs.
   - resolvePin(url, opts): expand a single pin to 0..N off-Pinterest URLs (usually 1).
   - resolveBoard(url, opts): collect recent pins from a board and expand each (configurable limit).
   - Smart normalization (filters out pinterest.* domains, dedupes, validates).
   - Optional cheerio for minor fallbacks; graceful if not installed.
   - Uses global fetch (Node 18+) or falls back to node-fetch if available.

   Typical usage:
     const { resolve, resolvePin, resolveBoard } = require("./pinterestResolver");
     const out = await resolve("https://www.pinterest.com/pin/123456789/", { limit: 12 });
     // out.urls -> ["https://real-site.com/actual-recipe.html", ...]
*/

let cheerio = null;
try { cheerio = require("cheerio"); } catch (_) {}

let _fetch = (typeof fetch !== "undefined" ? fetch : null);
if (!_fetch) {
  try { _fetch = require("node-fetch"); } catch (_) {}
}

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* -------------------------------- Utilities -------------------------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toArray = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const uniq = (xs) => Array.from(new Set(xs));
const isHttp = (u) => /^https?:\/\//i.test(String(u || ""));
const isPinterest = (u) => {
  try {
    const host = new URL(u).hostname.replace(/^www\./, "");
    return host.endsWith("pinterest.com") || host.endsWith("pinimg.com") || host === "pin.it";
  } catch { return false; }
};
const looksLikeRecipe = (u) => /recipe|receta|ricetta|rezept|receita/i.test(String(u));

function validUrl(u) {
  if (!isHttp(u)) return false;
  try { new URL(u); return true; } catch { return false; }
}

/** Deep scan object for URL-ish strings; exclude Pinterest/self refs */
function deepCollectUrls(obj, acc = new Set()) {
  if (!obj) return acc;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (isHttp(s) && !isPinterest(s)) acc.add(s);
    return acc;
  }
  if (Array.isArray(obj)) { obj.forEach((x) => deepCollectUrls(x, acc)); return acc; }
  if (typeof obj === "object") {
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      // Common Pinterest fields to prioritize
      if (["link", "linkUrl", "destination", "rich_metadata", "domain_url", "final_link", "tracked_link"].includes(k)) {
        deepCollectUrls(v, acc);
      } else {
        deepCollectUrls(v, acc);
      }
    }
  }
  return acc;
}

/** Fetch with redirects, timeouts, and friendly headers */
async function httpGet(url, { signal, headers = {}, timeoutMs = 15000 } = {}) {
  if (!_fetch) throw new Error("No fetch implementation available.");
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs).unref?.();
  try {
    const res = await _fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: signal || ctrl.signal,
      headers: {
        "User-Agent": DEFAULT_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        ...headers,
      },
    });
    const text = await res.text();
    return { status: res.status, url: res.url, headers: res.headers, text };
  } finally {
    clearTimeout(to);
  }
}

/** HEAD to expand shorteners like pin.it quickly */
async function httpHead(url, { signal, timeoutMs = 10000 } = {}) {
  if (!_fetch) throw new Error("No fetch implementation available.");
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs).unref?.();
  try {
    const res = await _fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: signal || ctrl.signal,
      headers: { "User-Agent": DEFAULT_UA },
    });
    // node-fetch returns final URL in res.url
    return { status: res.status, url: res.url, headers: res.headers };
  } finally {
    clearTimeout(to);
  }
}

function normalizePinterestUrl(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    // Force desktop hostname for consistent HTML shape
    if (u.hostname === "pin.it") return u.toString();
    if (/^([a-z]+\.)?pinterest\.com$/i.test(u.hostname)) {
      u.hostname = "www.pinterest.com";
    }
    // Strip any tracking params; keep id paths
    ["utm_source","utm_medium","utm_campaign","utm_term","utm_content"].forEach((p) => u.searchParams.delete(p));
    return u.toString();
  } catch { return url; }
}

function classify(url) {
  try {
    const u = new URL(url);
    if (u.hostname === "pin.it") return { kind: "short" };
    if (/^www\.pinterest\.com$/i.test(u.hostname) || /^pinterest\.com$/i.test(u.hostname)) {
      const parts = u.pathname.replace(/\/+$/,"").split("/").filter(Boolean);
      if (parts[0] === "pin" && parts[1]) return { kind: "pin", id: parts[1] };
      if (parts[0] && parts[1] === "boards") return { kind: "board" }; // legacy
      if (parts.length >= 2 && parts[1] !== "pins") return { kind: "board" }; // /{user}/{board}/
      if (parts.length === 1 && parts[0] !== "pin") return { kind: "user" };
    }
    return { kind: "other" };
  } catch {
    return { kind: "other" };
  }
}

/* ------------------------- Core: parse __PWS_DATA__ ------------------------- */
function parsePwsData(html) {
  if (typeof html !== "string") return null;
  // Primary: __PWS_DATA__ blob
  const m = html.match(/<script[^>]*id=["']__PWS_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (m && m[1]) {
    try {
      return JSON.parse(m[1]);
    } catch {
      // Try to fix common trailing commas
      try {
        const fixed = m[1].replace(/,\s*([}\]])/g, "$1");
        return JSON.parse(fixed);
      } catch {
        /* ignore */
      }
    }
  }
  // Fallback: og:url / og:see_also for single link hints
  if (cheerio) {
    try {
      const $ = cheerio.load(html);
      const ogSeeAlso = $('meta[property="og:see_also"]').attr("content");
      const ogUrl = $('meta[property="og:url"]').attr("content");
      return { _fallbackMeta: { ogSeeAlso, ogUrl } };
    } catch { /* noop */ }
  }
  return null;
}

/** Extract outbound URLs from PWS data structure */
function extractOutboundFromPws(pws) {
  if (!pws || typeof pws !== "object") return [];
  // Known nesting: pws.props.initialReduxState.resources, ...response.data likely contains pins
  const urls = new Set();

  // 1) Deep scan everything
  deepCollectUrls(pws, urls);

  // 2) Meta fallbacks
  if (pws._fallbackMeta) {
    const { ogSeeAlso, ogUrl } = pws._fallbackMeta;
    if (ogSeeAlso && !isPinterest(ogSeeAlso)) urls.add(ogSeeAlso);
    if (ogUrl && !isPinterest(ogUrl)) urls.add(ogUrl);
  }

  // Clean
  const cleaned = [...urls].filter(validUrl);
  // Heuristic: prefer recipe-like URLs first
  cleaned.sort((a, b) => {
    const ar = looksLikeRecipe(a) ? 1 : 0;
    const br = looksLikeRecipe(b) ? 1 : 0;
    if (ar !== br) return br - ar;
    // Shorter is often the canonical, push shorter first
    return a.length - b.length;
  });

  return uniq(cleaned);
}

/* ------------------------------- Public API -------------------------------- */
async function resolvePin(pinUrl, opts = {}) {
  const warnings = [];
  const out = { type: "pin", source: normalizePinterestUrl(pinUrl), urls: [], warnings };

  // Expand shortlinks first
  const kind = classify(out.source);
  if (kind.kind === "short") {
    try {
      const head = await httpHead(out.source, opts);
      if (head?.url && head.url !== out.source) {
        out.source = head.url;
      }
    } catch (e) {
      warnings.push(`HEAD expand failed: ${e.message || e}`);
    }
  }

  // Fetch the pin HTML
  let res;
  try {
    res = await httpGet(out.source, opts);
  } catch (e) {
    warnings.push(`GET failed: ${e.message || e}`);
    return out;
  }

  // Parse PWS data
  const pws = parsePwsData(res.text || "");
  if (!pws) {
    warnings.push("No __PWS_DATA__ found");
  } else {
    const urls = extractOutboundFromPws(pws);
    out.urls = uniq(urls);
  }

  // Strong fallback: scan anchors for obvious external links (spammy but helps edge cases)
  if (!out.urls.length && cheerio) {
    try {
      const $ = cheerio.load(res.text || "");
      $('a[href]').each((_, el) => {
        const href = $(el).attr("href");
        if (validUrl(href) && !isPinterest(href)) out.urls.push(href);
      });
      out.urls = uniq(out.urls);
    } catch { /* ignore */ }
  }

  return out;
}

/**
 * Resolve a board URL: returns a list of destination URLs by
 * pulling a handful of recent pins from the board page and expanding them.
 */
async function resolveBoard(boardUrl, opts = {}) {
  const warnings = [];
  const out = { type: "board", source: normalizePinterestUrl(boardUrl), urls: [], pins: [], warnings };
  const limit = Math.max(1, Math.min(100, opts.limit || 24));
  const delayMs = Math.max(0, opts.perPinDelayMs || 150); // be polite

  // Fetch board HTML
  let res;
  try {
    res = await httpGet(out.source, opts);
  } catch (e) {
    warnings.push(`GET failed: ${e.message || e}`);
    return out;
  }

  // Parse PWS and extract pin URLs
  const pws = parsePwsData(res.text || "");
  let pinLinks = [];
  if (pws) {
    // Gather Pinterest pin URLs only; we’ll expand later
    const all = [...deepCollectUrls(pws)].filter((u) => isPinterest(u));
    pinLinks = all.filter((u) => /\/pin\/\d+/i.test(u));
  }
  // Fallback: scrape anchors (if cheerio available)
  if (cheerio && !pinLinks.length) {
    try {
      const $ = cheerio.load(res.text || "");
      $('a[href*="/pin/"]').each((_, el) => {
        const href = $(el).attr("href");
        if (href) {
          try {
            const abs = new URL(href, out.source).toString();
            if (/\/pin\/\d+/i.test(abs)) pinLinks.push(abs);
          } catch { /* ignore */ }
        }
      });
    } catch { /* ignore */ }
  }

  pinLinks = uniq(pinLinks).slice(0, limit);

  // Expand each pin (sequential to avoid hammering; small delay)
  for (const pin of pinLinks) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await resolvePin(pin, opts);
      out.pins.push({ pin, urls: r.urls });
      out.urls.push(...r.urls);
    } catch (e) {
      warnings.push(`Pin expand failed (${pin}): ${e.message || e}`);
    }
    // eslint-disable-next-line no-await-in-loop
    if (delayMs) await sleep(delayMs);
  }

  out.urls = uniq(out.urls);
  return out;
}

/** Autodetect and resolve */
async function resolve(url, opts = {}) {
  const src = normalizePinterestUrl(url);
  const kind = classify(src);
  if (kind.kind === "pin" || kind.kind === "short") return resolvePin(src, opts);
  if (kind.kind === "board") return resolveBoard(src, opts);
  if (kind.kind === "user") {
    // Try to treat as a board listing; return empty with a hint
    return {
      type: "user",
      source: src,
      urls: [],
      warnings: ["User profiles require selecting a board; pass a board URL."],
    };
  }
  // Not Pinterest; just echo back if it looks like a recipe URL
  return {
    type: "other",
    source: src,
    urls: validUrl(src) && !isPinterest(src) ? [src] : [],
    warnings: validUrl(src) ? [] : ["Not a valid URL"],
  };
}

/* ------------------------------- Exports ------------------------------------ */
module.exports = {
  resolve,
  resolvePin,
  resolveBoard,
  // useful internals for testing
  _internals: {
    normalizePinterestUrl,
    classify,
    parsePwsData,
    extractOutboundFromPws,
    deepCollectUrls,
  },
};

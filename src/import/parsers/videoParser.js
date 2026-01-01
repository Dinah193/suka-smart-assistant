// C:\Users\larho\suka-smart-assistant\src\import\parsers\videoParser.js
// Parses how-to / recipe / cleaning / garden / animal / preservation *videos*
// into a canonical SSA "videoImport" shape, normalizeMany-friendly.
// -----------------------------------------------------------------------------
// PIPELINE (intended)
// ImportService.importPayload(...) → ImportRouter.routeImport(...) →
//   **videoParser.parse(...)** or videoParser.parseMany(...) →
//   ImportNormalizer.normalizeImport("howto", ...) → automation.runtime
//   → (optional) Hub export (AFTER normalization, not here).
//
// WHAT THIS PARSER HANDLES
//  - URL string to a video (YouTube, TikTok, Facebook, etc.)
//  - HTML string of a video page (with og:meta tags, JSON-LD, etc.)
//  - JSON object from bookmarklet/share with video metadata:
//      { url, title, platform, videoId, durationSec, steps: [...], ... }
//  - Raw transcript / notes text → coarse "steps"
//
// CANONICAL OUTPUT (single record)
//  {
//    type: "videoImport",
//    domain: "howto",            // for normalizer; domain-specific comes later
//    title: "How to break down a lamb",
//    sourceUrl: "https://youtube.com/...",
//    platform: "youtube|tiktok|facebook|other",
//    channel: "Farm Life With Savvy",
//    videoId: "abc123",
//    durationSec: 1234,
//    tags: ["butchery", "lamb"],
//    thumbnails: ["https://..."],
//    steps: [
//      {
//        index: 0,
//        text: "Gather knives and sanitize workspace.",
//        tsStartSec: 0,
//        tsEndSec: 60
//      },
//      ...
//    ],
//    transcriptPreview: "In this video we will...",
//    targetDomainHint: "cooking|cleaning|garden|animals|preservation|storehouse|null"
//  }
//
// SHIM / BACKGROUND FRIENDLY
//  - No direct DOM access; operates on strings/JSON.
//  - Safe to run inside Web Workers / background runtimes.
//  - Emits "import.parsed.raw" through eventBus when available.
//  - parseMany wraps parse for normalizeMany.js.
//
// IMPORTANT
//  - This parser ONLY shapes data. It does NOT:
//      • update inventory/storehouse
//      • emit Hub exports
//    Those are handled AFTER normalization in domain engines.
// -----------------------------------------------------------------------------

import eventBus from "../../services/eventBus";
import scraperService from "../../services/scraperService.js";

/**
 * Emit a structured diagnostic event to SSA's shared event bus.
 * Matches runtimeHints.payloadShape: { type, ts, source, data }.
 *
 * @param {boolean} success
 * @param {object} detail
 */
function emitParserEvent(success, detail = {}) {
  try {
    if (!eventBus || typeof eventBus.emit !== "function") return;
    const type = "import.parsed.raw";
    eventBus.emit(type, {
      type,
      ts: new Date().toISOString(),
      source: "import.parser.video",
      data: {
        success,
        ...detail,
      },
    });
  } catch (err) {
    // Never crash the import pipeline due to logging
    // eslint-disable-next-line no-console
    console.warn("[videoParser] emitParserEvent failed:", err?.message || err);
  }
}

// -----------------------------------------------------------------------------
// 1. HTML + URL helpers
// -----------------------------------------------------------------------------

/**
 * Resolve raw into an HTML string, if possible.
 * Supports:
 *  - raw as HTML string
 *  - raw as URL string (fetch via scraperService)
 *  - raw as { html: "<html>..." }
 *
 * @param {any} raw
 * @returns {Promise<string|null>}
 */
async function getHtmlFromRaw(raw) {
  // clearly HTML string
  if (typeof raw === "string" && /<\/html>|<body|<article|<section|<head/i.test(raw)) {
    return raw;
  }

  // URL → fetch
  if (typeof raw === "string" && /^https?:\/\//i.test(raw)) {
    try {
      const html = await scraperService.fetchHtml(raw);
      return html;
    } catch (err) {
      console.warn("[videoParser] fetchHtml failed:", err?.message || err);
      return null;
    }
  }

  // object with .html field
  if (raw && typeof raw === "object" && typeof raw.html === "string") {
    return raw.html;
  }

  return null;
}

/**
 * Infer a platform identifier from a URL.
 *
 * @param {string|null} url
 * @returns {"youtube"|"tiktok"|"facebook"|"instagram"|"other"|null}
 */
function inferPlatformFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("tiktok.com")) return "tiktok";
  if (u.includes("facebook.com") || u.includes("fb.watch")) return "facebook";
  if (u.includes("instagram.com") || u.includes("instagr.am")) return "instagram";
  return "other";
}

/**
 * Extract a "videoId-ish" token from common URL formats.
 *
 * @param {string|null} url
 * @returns {string|null}
 */
function inferVideoIdFromUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) {
      return u.searchParams.get("v") || null;
    }
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace(/^\//, "") || null;
    }
    if (u.hostname.includes("tiktok.com")) {
      // /@user/video/1234567890
      const parts = u.pathname.split("/").filter(Boolean);
      const idx = parts.indexOf("video");
      if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
    }
    // others: leave null; Hub / server can refine
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to derive a "targetDomainHint" from title/description text.
 * Helps SSA route the video into cooking/cleaning/garden/animals/preservation/storehouse.
 *
 * @param {string} text
 * @returns {string|null}
 */
function sniffTargetDomain(text) {
  if (!text) return null;
  const lower = text.toLowerCase();

  if (/\brecipe\b|\bhow to cook\b|\bbake\b|\broast\b|\bstew\b/.test(lower)) {
    return "cooking";
  }
  if (/\bclean\b|\bdeclutter\b|\bdeep clean\b|\bchore\b|\breset\b/.test(lower)) {
    return "cleaning";
  }
  if (/\bgarden\b|\bseed\b|\bplant\b|\bsow\b|\bbed\b|\braised bed\b/.test(lower)) {
    return "garden";
  }
  if (/\bgoat\b|\bsheep\b|\bchicken\b|\bduck\b|\bcattle\b|\bbutcher\b|\bcarcass\b/.test(lower)) {
    return "animals";
  }
  if (/\bcan\b|\bpressure can\b|\bferment\b|\bdehydrate\b|\bfreeze dry\b|\bsmoke\b/.test(lower)) {
    return "preservation";
  }
  if (/\bpantry\b|\broot cellar\b|\bstorehouse\b|\bfood storage\b/.test(lower)) {
    return "storehouse";
  }

  return null;
}

// -----------------------------------------------------------------------------
// 2. HTML meta + lightweight JSON-LD extraction
// -----------------------------------------------------------------------------

/**
 * Extract key meta tags / lightweight JSON-LD from HTML.
 *
 * @param {string} html
 * @returns {{
 *   title?: string,
 *   description?: string,
 *   thumbnails?: string[],
 *   durationSec?: number|null,
 *   channel?: string|null
 * }}
 */
function extractVideoMetaFromHtml(html) {
  const result = {
    title: undefined,
    description: undefined,
    thumbnails: [],
    durationSec: null,
    channel: null,
  };
  if (!html) return result;

  // title: prefer og:title
  const ogTitleMatch = html.match(
    /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i
  );
  if (ogTitleMatch) {
    result.title = ogTitleMatch[1].trim();
  } else {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) result.title = titleMatch[1].trim();
  }

  // description: og:description
  const ogDescMatch = html.match(
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i
  );
  if (ogDescMatch) {
    result.description = ogDescMatch[1].trim();
  }

  // thumbnails: og:image
  const thumbRe = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi;
  let tm;
  while ((tm = thumbRe.exec(html)) !== null) {
    const url = tm[1].trim();
    if (url && !result.thumbnails.includes(url)) {
      result.thumbnails.push(url);
    }
  }

  // duration: schema.org VideoObject or meta itemprop
  const durationRe = /"duration"\s*:\s*"([^"]+)"/i;
  const durMatch = html.match(durationRe);
  if (durMatch) {
    const iso = durMatch[1].trim();
    const sec = iso8601DurationToSeconds(iso);
    if (sec != null) result.durationSec = sec;
  } else {
    // fallback: <meta itemprop="duration" content="PT10M30S">
    const mp = html.match(
      /<meta[^>]+itemprop=["']duration["'][^>]+content=["']([^"']+)["']/i
    );
    if (mp) {
      const sec = iso8601DurationToSeconds(mp[1].trim());
      if (sec != null) result.durationSec = sec;
    }
  }

  // channel/author heuristics
  const channelMatch = html.match(
    /"author"\s*:\s*{[^}]*"name"\s*:\s*"([^"]+)"/i
  );
  if (channelMatch) {
    result.channel = channelMatch[1].trim();
  }

  return result;
}

/**
 * Very small ISO 8601 duration (PnDTnHnMnS) → seconds helper.
 * Not full spec, but good enough for common PT#H#M#S formats.
 *
 * @param {string} iso
 * @returns {number|null}
 */
function iso8601DurationToSeconds(iso) {
  if (!iso || typeof iso !== "string") return null;
  const m = iso.match(
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
  );
  if (!m) return null;
  const days = parseInt(m[1] || "0", 10);
  const hours = parseInt(m[2] || "0", 10);
  const mins = parseInt(m[3] || "0", 10);
  const secs = parseFloat(m[4] || "0");
  return days * 86400 + hours * 3600 + mins * 60 + secs;
}

// -----------------------------------------------------------------------------
// 3. Structured object detection (SSA-style / bookmarklet JSON)
// -----------------------------------------------------------------------------

/**
 * Detect if raw is already a SSA-style structured video object.
 *
 * @param {any} raw
 * @returns {boolean}
 */
function isStructuredVideoObject(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (typeof raw.url === "string") return true;
  if (typeof raw.sourceUrl === "string") return true;
  if (typeof raw.platform === "string") return true;
  if (Array.isArray(raw.steps)) return true;
  return false;
}

/**
 * Normalize a structured SSA-style video object into canonical videoImport.
 *
 * @param {object} raw
 * @param {object} meta
 * @returns {object}
 */
function normalizeStructuredVideoObject(raw, meta = {}) {
  const sourceUrl = raw.sourceUrl || raw.url || meta.url || null;
  const platform =
    raw.platform || inferPlatformFromUrl(sourceUrl) || meta.platform || null;
  const videoId =
    raw.videoId || raw.id || inferVideoIdFromUrl(sourceUrl) || null;

  const title =
    raw.title ||
    raw.name ||
    meta.title ||
    (sourceUrl ? `Imported video: ${sourceUrl}` : "Imported video");

  const description = raw.description || meta.description || null;

  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((s, index) => ({
        index: typeof s.index === "number" ? s.index : index,
        text: s.text || s.title || "",
        tsStartSec: typeof s.tsStartSec === "number" ? s.tsStartSec : null,
        tsEndSec: typeof s.tsEndSec === "number" ? s.tsEndSec : null,
      }))
    : [];

  const durationSec =
    typeof raw.durationSec === "number"
      ? raw.durationSec
      : typeof raw.duration === "string"
      ? iso8601DurationToSeconds(raw.duration)
      : null;

  const tags = Array.isArray(raw.tags)
    ? raw.tags
    : typeof raw.tags === "string"
    ? raw.tags
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const thumbnails = Array.isArray(raw.thumbnails)
    ? raw.thumbnails
    : raw.thumbnail
    ? [raw.thumbnail]
    : [];

  const transcriptPreview =
    raw.transcriptPreview ||
    (typeof raw.transcript === "string"
      ? raw.transcript.slice(0, 200)
      : null);

  const targetDomainHint =
    raw.targetDomainHint ||
    sniffTargetDomain(
      [title, description, transcriptPreview].filter(Boolean).join(" ")
    ) ||
    null;

  return {
    type: "videoImport",
    domain: "howto",
    title,
    sourceUrl,
    platform,
    channel: raw.channel || raw.author || raw.uploader || null,
    videoId,
    durationSec,
    tags,
    thumbnails,
    steps,
    transcriptPreview,
    targetDomainHint,
  };
}

// -----------------------------------------------------------------------------
// 4. Text → coarse steps (for raw transcript / notes)
// -----------------------------------------------------------------------------

/**
 * Turn a plain text blob (transcript or notes) into a minimal videoImport.
 *
 * @param {string} text
 * @param {object} meta
 * @returns {object}
 */
function textToVideoImport(text, meta = {}) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const steps = lines.map((line, index) => ({
    index,
    text: line,
    tsStartSec: null,
    tsEndSec: null,
  }));

  const title = meta.title || "Imported how-to video notes";
  const sourceUrl = meta.url || meta.sourceUrl || null;
  const platform = inferPlatformFromUrl(sourceUrl) || null;

  const joined = lines.join(" ");
  const targetDomainHint = sniffTargetDomain(joined);

  return {
    type: "videoImport",
    domain: "howto",
    title,
    sourceUrl,
    platform,
    channel: null,
    videoId: null,
    durationSec: null,
    tags: [],
    thumbnails: [],
    steps,
    transcriptPreview: joined.slice(0, 200),
    targetDomainHint,
  };
}

// -----------------------------------------------------------------------------
// 5. MAIN PARSE FUNCTION (single record)
// -----------------------------------------------------------------------------

/**
 * Parse a single video/HowTo import into canonical videoImport structure.
 *
 * normalizeMany-compatible:
 *  - videoParser.parse(raw, meta)    → one { type: "videoImport", ... }
 *  - videoParser.parseMany(raw,meta) → [videoImport, ...]
 *
 * @param {any} raw
 * @param {object} [meta]
 * @returns {Promise<object>} videoImport
 */
async function parse(raw, meta = {}) {
  const sourceUrl =
    (typeof raw === "string" && /^https?:\/\//i.test(raw) && raw) ||
    meta.url ||
    meta.sourceUrl ||
    null;

  // CASE 1: structured object from SSA / bookmarklet / app share
  if (isStructuredVideoObject(raw)) {
    const normalized = normalizeStructuredVideoObject(raw, meta);
    emitParserEvent(true, {
      domain: "howto",
      via: "structured-object",
      title: normalized.title,
      platform: normalized.platform,
      sourceUrl: normalized.sourceUrl,
    });
    return normalized;
  }

  // CASE 2: try to fetch/parse HTML from URL or raw HTML
  const html = await getHtmlFromRaw(raw);
  if (html) {
    const metaFromHtml = extractVideoMetaFromHtml(html);
    const platform = inferPlatformFromUrl(sourceUrl);
    const videoId = inferVideoIdFromUrl(sourceUrl);

    const title =
      meta.title ||
      metaFromHtml.title ||
      (sourceUrl ? `Imported video: ${sourceUrl}` : "Imported video");

    const description =
      meta.description || metaFromHtml.description || undefined;

    const targetDomainHint =
      meta.targetDomainHint ||
      sniffTargetDomain(
        [title, description].filter(Boolean).join(" ")
      ) ||
      null;

    const shaped = {
      type: "videoImport",
      domain: "howto",
      title,
      sourceUrl,
      platform: platform || null,
      channel: metaFromHtml.channel || null,
      videoId,
      durationSec:
        typeof meta.durationSec === "number"
          ? meta.durationSec
          : metaFromHtml.durationSec,
      tags: [],
      thumbnails: metaFromHtml.thumbnails || [],
      steps: [], // Session engines can derive steps via separate chapter/transcript parsers
      transcriptPreview: null,
      targetDomainHint,
    };

    emitParserEvent(true, {
      domain: "howto",
      via: "html-meta",
      title: shaped.title,
      platform: shaped.platform,
      sourceUrl: shaped.sourceUrl,
    });

    return shaped;
  }

  // CASE 3: raw text (transcript / copy-pasted notes)
  if (typeof raw === "string") {
    const fromText = textToVideoImport(raw, { ...meta, url: sourceUrl });
    emitParserEvent(true, {
      domain: "howto",
      via: "text-lines",
      title: fromText.title,
      lineCount: fromText.steps.length,
    });
    return fromText;
  }

  // CASE 4: unknown → safe fallback
  emitParserEvent(false, {
    domain: "howto",
    via: "unknown",
    error: "Could not parse video/how-to data.",
    preview: typeof raw === "string" ? raw.slice(0, 160) : "[non-string]",
  });

  return {
    type: "videoImport",
    domain: "howto",
    title: meta.title || "Unknown video import",
    sourceUrl,
    platform: inferPlatformFromUrl(sourceUrl),
    channel: null,
    videoId: inferVideoIdFromUrl(sourceUrl),
    durationSec: null,
    tags: [],
    thumbnails: [],
    steps: [],
    transcriptPreview: null,
    targetDomainHint:
      sniffTargetDomain(meta.title || "") || null,
    warning:
      "Parser could not identify video structure — returned minimal structure.",
  };
}

// -----------------------------------------------------------------------------
// 6. parseMany — helper for normalizeMany.js
// -----------------------------------------------------------------------------

/**
 * Normalize a single raw or an array of raws into an array of videoImport records.
 *
 * @param {any|any[]} raw
 * @param {object} [meta]
 * @returns {Promise<object[]>}
 */
async function parseMany(raw, meta = {}) {
  // If caller passes an array of raws, parse each independently.
  if (Array.isArray(raw)) {
    const results = [];
    for (let i = 0; i < raw.length; i += 1) {
      // Allow per-item meta override via meta.items[i], but fall back to shared meta
      const itemMeta =
        meta && Array.isArray(meta.items) && meta.items[i]
          ? { ...meta, ...meta.items[i] }
          : meta;
      // eslint-disable-next-line no-await-in-loop
      const parsed = await parse(raw[i], itemMeta);
      if (Array.isArray(parsed)) {
        results.push(...parsed);
      } else if (parsed) {
        results.push(parsed);
      }
    }
    return results;
  }

  // scalar raw → single parse wrapped in an array
  const result = await parse(raw, meta);
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

// -----------------------------------------------------------------------------
// EXPORT
// -----------------------------------------------------------------------------
const videoParser = {
  parse,
  parseMany,
  // exposed for tests / debugging
  __inferPlatformFromUrl: inferPlatformFromUrl,
  __inferVideoIdFromUrl: inferVideoIdFromUrl,
  __extractVideoMetaFromHtml: extractVideoMetaFromHtml,
  __iso8601DurationToSeconds: iso8601DurationToSeconds,
  __sniffTargetDomain: sniffTargetDomain,
};

export default videoParser;

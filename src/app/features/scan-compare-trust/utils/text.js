/* eslint-disable no-console */
// utils/text.js — OCR text cleaners & structured extractors (Scan • Compare • Trust)
// Style: small, dependency-light, defensive. JSDoc for DX.
// Integrations: units.js (parsePackageSize), pricebook schema (observation helpers),
// CouponService (terms), CycleAnalyzer (promo depth), SourceAttribution (provenance).

import {
  normalizeUnit,
  parsePackageSize,
  parsePricePerTag,
} from './units';

/* ----------------------------- Core normalizers ----------------------------- */

/** Remove diacritics, normalize Unicode. */
export function toASCII(s = '') {
  return String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\S\r\n]+/g, ' ');
}

/** Normalize whitespace (collapse spaces, trim lines, keep \n). */
export function normalizeWhitespace(s = '') {
  return String(s)
    .replace(/\r\n/g, '\n')
    .replace(/\u00A0/g, ' ')        // nbsp
    .replace(/[ \t]+/g, ' ')
    .replace(/[ ]*\n[ ]*/g, '\n')
    .trim();
}

/** Fix common OCR glyph confusions w/ context-aware rules. */
export function fixCommonOCR(s = '') {
  let out = s;

  // Replace fancy quotes/dashes
  out = out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—−]/g, '-');

  // Currency artifacts
  out = out.replace(/[\$Ｓ]/g, '$'); // fullwidth S → $
  out = out.replace(/(\$)\s+(\d)/g, '$1$2');

  // O↔0, I/l↔1 heuristics in numeric islands
  out = out.replace(/\bO(?=\d)|(?<=\d)O\b/g, '0');
  out = out.replace(/\b0(?=[A-Za-z]{2,})/g, 'O');

  // 1 vs l vs I: only inside price-like tokens 1.99, l.99
  out = out.replace(/(?<=^|[\s(])l(?=\d)/g, '1').replace(/(?<=^|[\s(])I(?=\d)/g, '1');

  // Fraction slash variants
  out = out.replace(/ ?[⁄∕] ?/g, '/');

  // Remove stray bullets/dots commonly from PDFs
  out = out.replace(/[•·∙◦]/g, ' ');

  // Fix misread "fl oz" variants (fl.oz, f1 oz)
  out = out.replace(/\bf1[ .]?oz\b/ig, 'fl oz').replace(/\bfl[ .]?oz\b/ig, 'fl oz');

  return out;
}

/** Undo hard hyphenation at line ends: "multi-\npack" -> "multi pack". */
export function unbreakHyphenation(text = '') {
  // Hyphenation when the hyphen is at end-of-line with no space before newline.
  return text.replace(/([A-Za-z])-\n([A-Za-z])/g, '$1$2');
}

/** Merge wrapped lines if they look like a single sentence/title. */
export function joinWrappedLines(text = '') {
  // If a line ends without punctuation and next line starts lowercase, join.
  return text.replace(/([^\.\!\?:])\n([a-z])/g, '$1 $2');
}

/** High-level cleaner pipeline for a block of OCR text. */
export function cleanTextBlock(raw = '') {
  let t = toASCII(raw);
  t = fixCommonOCR(t);
  t = unbreakHyphenation(t);
  t = joinWrappedLines(t);
  t = normalizeWhitespace(t);
  return t;
}

/** Clean a single line (applies lighter touch than block cleaner). */
export function cleanLine(raw = '') {
  return normalizeWhitespace(fixCommonOCR(toASCII(raw)));
}

/* -------------------------------- Tokenizers -------------------------------- */

/** Split into non-empty lines after cleaning. */
export function toLines(block = '') {
  return cleanTextBlock(block)
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/** Basic tokenization (keeps numbers/letters and “/ . - % $”). */
export function tokenize(line = '') {
  const s = cleanLine(line);
  return s.split(/[^A-Za-z0-9/$%.:\-+]+/).filter(Boolean);
}

/** Remove common retail stopwords to highlight candidate product names. */
export function stripStopwords(tokens = []) {
  const stop = new Set([
    'with','and','or','the','a','of','per','off','for','size','only','selected',
    'varieties','assorted','each','ct','pk','pack','save','club','price','member',
    'lb','oz','fl','fl','oz','gal','pt','qt','ml','l','ea',
  ]);
  return tokens.filter(t => !stop.has(t.toLowerCase()));
}

/* --------------------------- Primitive numeric parsers ---------------------- */

export function safeNumber(s) {
  const m = String(s).replace(/[^0-9.\-]/g, '');
  if (!m || m === '.' || m === '-' || m === '-.' || m === '.-') return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

export function parseCurrency(line = '') {
  // Support $1,299.50, $1.99 lb, 2/$5 → per-item $2.50 (returned as meta)
  const out = [];

  // Standard prices
  const priceRegex = /(?:\$+\s*|)\b(\d{1,4}(?:[,.]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})?)\b/g;
  let m;
  while ((m = priceRegex.exec(line)) !== null) {
    const raw = m[0];
    const v = safeNumber(m[1].replace(',', ''));
    if (v != null) out.push({ value: v, raw, idx: m.index });
  }

  // Multi-buy 2/$5, 3 for $10
  const multibuy = /(\d+)\s*(?:\/|for)\s*\$?\s*(\d+(?:\.\d{2})?)/ig;
  while ((m = multibuy.exec(line)) !== null) {
    const qty = Number(m[1]);
    const total = Number(m[2]);
    if (qty > 0 && Number.isFinite(total)) {
      out.push({
        value: total / qty,
        raw: m[0],
        idx: m.index,
        meta: { multibuyQty: qty, multibuyTotal: total },
      });
    }
  }

  // “$1.99 / lb” style
  const perTag = parsePricePerTag(line);
  if (perTag && Number.isFinite(perTag.price)) {
    out.push({ value: perTag.price / (perTag.per || 1), raw: perTag, idx: line.indexOf(perTag.price) });
  }

  return dedupeNearby(out);
}

/** Find possible percentages (e.g., 30% OFF). */
export function parsePercent(line = '') {
  const out = [];
  const rx = /\b(\d{1,3})\s?%/g;
  let m;
  while ((m = rx.exec(line)) !== null) {
    const v = Number(m[1]);
    if (Number.isFinite(v)) out.push({ value: v, raw: m[0], idx: m.index });
  }
  return out;
}

/* --------------------------- Retail-specific extractors --------------------- */

export function extractUPC(line = '') {
  // UPC-A (12) or EAN-13 (13). We allow spaces/dashes.
  const rx = /\b(\d[\d -]{10,16}\d)\b/g;
  let m;
  const hits = [];
  while ((m = rx.exec(line)) !== null) {
    const digits = m[1].replace(/[ -]/g, '');
    if (digits.length === 12 || digits.length === 13) {
      hits.push({ upc: digits, raw: m[1], idx: m.index });
    }
  }
  return hits;
}

export function extractSKU(line = '') {
  // Common patterns: “SKU 12345”, “Item #123456”, “Model 5678”
  const hits = [];
  const rx = /\b(?:SKU|Sku|sku|Item|Model|#)\s*[:#]?\s*([A-Z0-9\-]{4,})\b/g;
  let m;
  while ((m = rx.exec(line)) !== null) hits.push({ sku: m[1], raw: m[0], idx: m.index });
  return hits;
}

export function extractPackage(line = '') {
  // Try “2 x 16 oz”, “4-pack (12 fl oz)”, “12 ct”, “16 oz”
  const parsed = parsePackageSize(line);
  return parsed ? [{ ...parsed, raw: line }] : [];
}

/** Try to identify “Manager’s Special” / “Weekly Ad” hints. */
export function detectPromoFlags(line = '') {
  const s = line.toLowerCase();
  return {
    isManagerSpecial: /\b(manager|mgr)[’']?s?\s+special\b/.test(s),
    isWeeklyAd: /\bweekly\s+ad\b/.test(s),
    isClearance: /\bclearance\b/.test(s),
    isBOGO: /\bbogo\b|\bbuy\s*one\s*get\s*one\b/.test(s),
  };
}

/** Attempt to detect coupon terms snippets (“Limit 1”, “Digital coupon”). */
export function detectCouponTerms(line = '') {
  const s = line.toLowerCase();
  return {
    limitOne: /\blimit\s*1\b/.test(s),
    digital: /\bdigital\s+coupon\b/.test(s),
    memberOnly: /\bmember\s+price|membership\s+required\b/.test(s),
    inStoreOnly: /\bin[-\s]?store\s+only\b/.test(s),
    onlineOnly: /\bonline\s+only\b/.test(s),
    pickupOnly: /\bpick(?:up)?\s+only\b/.test(s),
  };
}

/* ----------------------------- Name candidates ------------------------------ */

/**
 * Extract a human-ish product name candidate from nearby lines.
 * Keep letters/numbers, drop obvious units/prices/stopwords.
 */
export function bestNameCandidate(lines = [], pivotIdx = 0) {
  const window = lines.slice(Math.max(0, pivotIdx - 2), Math.min(lines.length, pivotIdx + 3));
  const scored = [];

  for (const line of window) {
    const tokens = tokenize(line);
    const kept = stripStopwords(tokens)
      .filter(t => !normalizeUnit(t) && !/^\$?\d/.test(t)); // drop unit tokens & numeric-first
    if (!kept.length) continue;
    const label = kept.join(' ').replace(/\s{2,}/g, ' ').trim();
    if (!label) continue;

    // Simple score: length + alphabetic share
    const alphaShare = kept.join('').replace(/[^A-Za-z]/g, '').length / kept.join('').length || 0;
    const score = Math.min(label.length, 60) * (0.6 + 0.4 * alphaShare);
    scored.push({ label, score, line });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.label || null;
}

/* ------------------------------- Line joining ------------------------------- */

/**
 * Recombine split price blocks:
 * - Lines like "Boneless Skinless Chicken" / "Breasts" / "$1.99 / lb"
 * - Returns compact records you can feed into ProductResolver.
 */
export function parsePriceBlocks(block = '') {
  const lines = toLines(block);
  const results = [];

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];

    // Find price(s) on this line
    const prices = parseCurrency(L);
    if (!prices.length) continue;

    // Try to find a package descriptor / per-unit tag nearby
    const nearby = [L, lines[i + 1] || '', lines[i - 1] || ''].join(' ');
    const pkg = parsePackageSize(nearby) || parsePackageSize(L);

    // Name candidate around this pivot
    const name = bestNameCandidate(lines, i);

    // Percent OFF (compute pseudo “depth”)
    const off = parsePercent(nearby)[0]?.value ?? null;

    // Pick the best price token (prefer with multibuy meta)
    prices.sort((a, b) => (b.meta?.multibuyQty ? 1 : 0) - (a.meta?.multibuyQty ? 1 : 0));
    const p = prices[0];

    results.push({
      name: name || null,
      price: p.value,
      rawPrice: p.raw,
      multibuy: p.meta || null,
      package: pkg || null,
      upc: extractUPC(nearby)[0]?.upc || null,
      sku: extractSKU(nearby)[0]?.sku || null,
      flags: detectPromoFlags(nearby),
      terms: detectCouponTerms(nearby),
      lineIndex: i,
      context: [lines[i - 1] || null, L, lines[i + 1] || null].filter(Boolean),
      perTag: parsePricePerTag(nearby) || null,
      percentOff: off,
    });
  }

  // Deduplicate by (name, price, package totalQty if present)
  return dedupePriceBlocks(results);
}

/* -------------------------------- Utilities -------------------------------- */

function dedupeNearby(arr = [], gap = 3) {
  // Remove near-duplicates by index proximity and same value
  const out = [];
  for (const item of arr) {
    if (out.some(x => Math.abs((x.idx ?? 0) - (item.idx ?? 0)) <= gap && x.value === item.value)) continue;
    out.push(item);
  }
  return out;
}

function dedupePriceBlocks(rows = []) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const qtyKey = r.package?.totalQty ? String(r.package.totalQty) + (r.package.totalUnit || '') : '';
    const key = `${(r.name || '').toLowerCase()}|${r.price}|${qtyKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/* ---------------------------- High-level pipeline --------------------------- */

/**
 * Clean + parse an OCR page or region into structured hits.
 * @param {Object} params
 * @param {string} params.text - raw OCR text block
 * @param {string} [params.lang] - language hint (default en)
 * @param {string} [params.source] - provider or file hint (e.g., 'sams.pdf')
 * @param {Object} [params.meta] - { storeId, chain, page, bbox, assetId, ocrId }
 */
export function analyzeOCR({ text, lang = 'en', source = 'unknown', meta = {} } = {}) {
  const cleaned = cleanTextBlock(text || '');
  const lines = toLines(text || '');
  const priceBlocks = parsePriceBlocks(cleaned);

  // Fast “page features” for downstream ranking
  const features = {
    hasBOGO: priceBlocks.some(r => r.flags.isBOGO),
    hasManagerSpecial: priceBlocks.some(r => r.flags.isManagerSpecial),
    hasWeeklyAd: priceBlocks.some(r => r.flags.isWeeklyAd),
    priceCount: priceBlocks.length,
  };

  return {
    cleaned,
    lines,
    priceBlocks,
    features,
    meta: { ...meta, lang, source },
  };
}

/* ------------------------------ Light helpers ------------------------------- */

/** Turn a candidate name into a nicer title (no shouty case). */
export function titleCaseSmart(s = '') {
  const lower = String(s).toLowerCase();
  return lower.replace(/\b([a-z])/g, (_, c) => c.toUpperCase())
              .replace(/\b(And|Or|Of|The|With|Per)\b/g, (m) => m.toLowerCase());
}

/** Quick brand-ish normalizer (drop ™/® and case). */
export function normalizeBrand(s = '') {
  return toASCII(s).replace(/[®™]/g, '').trim();
}

/* --------------------------------- Exports ---------------------------------- */

export default {
  toASCII,
  normalizeWhitespace,
  fixCommonOCR,
  unbreakHyphenation,
  joinWrappedLines,
  cleanTextBlock,
  cleanLine,
  toLines,
  tokenize,
  stripStopwords,
  safeNumber,
  parseCurrency,
  parsePercent,
  extractUPC,
  extractSKU,
  extractPackage,
  detectPromoFlags,
  detectCouponTerms,
  bestNameCandidate,
  parsePriceBlocks,
  analyzeOCR,
  titleCaseSmart,
  normalizeBrand,
};

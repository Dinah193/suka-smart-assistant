/* recipeDeduper.js
   Canonical URL + fuzzy title dedupe for recipe objects.
   - Collapses obvious URL dupes (utm/gclid/amp/mobile domains, index.html, etc.)
   - Optionally merges near-duplicate titles across different URLs
   - Picks a single "primary" per cluster with quality-aware scoring
   - Never hard-crashes. Optional cheerio for <link rel="canonical"> parsing.
   - Includes helper utilities to drive a VersionPicker UI.

   Input recipe shape (flexible; fields optional):
   {
     id, title, url, canonicalUrl?, images?, image?, ingredients?, instructions?,
     rating?, ratingCount?, macros?, updatedAt?, createdAt?, source?, sourceType?,
     // optional user hints:
     keepSeparate?, favoriteStrict?, userPinnedVariant?
   }

   Exports:
     - dedupe(recipes, opts) => { unique, clusters, map, stats }
     - normalizeUrl(url, opts)
     - titleFingerprint(title)
     - similarity(a, b)       // Jaro–Winkler-like + token overlap
     - indexClusters(clusters)
     - getClusterByRecipeId(clusters, recipeId)
     - getVersionsForRecipe(clusters, recipeId)
*/

let cheerio = null;
try { cheerio = require("cheerio"); } catch { /* optional */ }

/* --------------------------------- helpers --------------------------------- */
const toArr = (x) => (Array.isArray(x) ? x : x != null ? [x] : []);
const uniq = (xs) => Array.from(new Set(xs));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
const safe = (s) => (s == null ? "" : String(s));

/* ------------------------------- URL cleanup ------------------------------- */
const TRACK_PARAMS = new Set([
  "utm_source","utm_medium","utm_campaign","utm_term","utm_content",
  "gclid","fbclid","igsh","mc_cid","mc_eid","mkt_tok","yclid","_hsenc","_hsmi"
]);

const HOST_ALIASES = [
  [/^m\./i, ""],
  [/^mobile\./i, ""],
  [/^amp\./i, ""],
];

const PATH_STRIPPERS = [
  [/\/amp(\/)?$/i, ""],
  [/\/amp\/$/i, "/"],
  [/\/index.(html|htm|php)$/i, "/"],
  [/\/{2,}/g, "/"],
];

const BAD_HOSTS = new Set([
  "pinterest.com", "www.pinterest.com", "pin.it", "pinimg.com",
  "facebook.com","www.facebook.com","m.facebook.com",
  "tiktok.com","www.tiktok.com","m.tiktok.com",
  "instagram.com","www.instagram.com","l.instagram.com",
]);

function normalizeUrl(url, { keepHash = false } = {}) {
  if (!url) return undefined;
  try {
    const u = new URL(url, undefined);
    let host = u.hostname.toLowerCase().replace(/^www\./, "");
    for (const [re, rep] of HOST_ALIASES) {
      if (re.test(host)) { host = host.replace(re, rep); break; }
    }

    let path = u.pathname || "/";
    for (const [re, rep] of PATH_STRIPPERS) path = path.replace(re, rep);
    if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

    const qp = new URLSearchParams(u.search);
    for (const k of Array.from(qp.keys())) {
      if (TRACK_PARAMS.has(k.toLowerCase())) qp.delete(k);
    }
    const qs = qp.toString();
    const scheme = (u.protocol || "https:").toLowerCase().startsWith("http") ? "https:" : u.protocol;

    const final = scheme + "//" + host + path + (qs ? "?" + qs : "") + (keepHash ? u.hash : "");
    return final;
  } catch {
    return url; // best-effort
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./,""); } catch { return undefined; }
}

/* ------------------------------- Canonical tag ------------------------------ */
function canonicalFromHtml(html, baseUrl) {
  if (!cheerio || typeof html !== "string") return undefined;
  try {
    const $ = cheerio.load(html);
    const c =
      $('link[rel="canonical"]').attr("href") ||
      $('meta[property="og:url"]').attr("content") ||
      $('meta[name="twitter:url"]').attr("content");
    if (!c) return undefined;
    return normalizeUrl(new URL(c, baseUrl).toString());
  } catch { return undefined; }
}

/* ------------------------------ Title cleanup ------------------------------- */
const SEP_RE = /\s+[-–—:•]\s+/; // split on common title separators
const STOP_WORDS = new Set([
  "recipe","best","easy","the","a","an","and","with","of","for","to","how","make","from","quick",
  "simple","ultimate","classic","perfect","homemade","copycat","one","pot","pan","air","fryer",
  "instant","pot","slow","cooker","crockpot","keto","low","carb","vegan","gluten","free"
]);

function deburr(s) {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function tokenizeTitle(title) {
  const base = safe(title).trim();
  if (!base) return [];
  const left = base.split(SEP_RE)[0];
  const clean = deburr(left)
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  const tokens = clean.split(/\s+/).filter(Boolean);
  return tokens.filter((t) => !STOP_WORDS.has(t));
}

function titleFingerprint(title) {
  const tokens = tokenizeTitle(title);
  const norm = tokens.map((t) => t.replace(/(oes|ies|s)$/i, (m) => (m === "ies" ? "y" : m === "s" ? "" : "o")));
  const uniqSorted = uniq(norm).sort();
  const key = uniqSorted.join("-");
  return { key, tokens: uniqSorted };
}

/* ------------------------------ Fuzzy similarity ---------------------------- */
function _jaro(a, b) {
  const s1 = a, s2 = b;
  const mDist = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  let matches = 0, t = 0;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - mDist);
    const end = Math.min(i + mDist + 1, s2.length);
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue;
      if (s1[i] !== s2[j]) continue;
      s1Matches[i] = true; s2Matches[j] = true; matches++; break;
    }
  }
  if (!matches) return 0;

  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;

  const j = (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;

  // Winkler prefix boost
  let l = 0;
  while (l < 4 && s1[l] === s2[l]) l++;
  return j + l * 0.1 * (1 - j);
}

function similarity(a, b) {
  const s1 = tokenizeTitle(a).join(" ");
  const s2 = tokenizeTitle(b).join(" ");
  const jw = _jaro(s1, s2);

  // token Jaccard
  const t1 = new Set(tokenizeTitle(a));
  const t2 = new Set(tokenizeTitle(b));
  const inter = [...t1].filter((x) => t2.has(x)).length;
  const union = new Set([...t1, ...t2]).size || 1;
  const jacc = inter / union;

  return clamp(0.7 * jw + 0.3 * jacc, 0, 1);
}

/* ------------------------------ Quality scoring ----------------------------- */
function scoreRecipeQuality(r) {
  const ingredients = toArr(r.ingredients).length;
  const steps = toArr(r.instructions).length;
  const images = toArr(r.images || (r.image ? [r.image] : [])).length;
  const macros = r.macros ? ["kcal","protein","carbs","fat"].filter((k) => r.macros[k] != null).length : 0;
  const ratingScore = (Number(r.rating || 0) * Math.log10((Number(r.ratingCount) || 0) + 1)) || 0;

  const host = hostOf(r.canonicalUrl || r.url || "");
  const hostPenalty = BAD_HOSTS.has(host || "") ? -5 : 0;

  const ts = Date.parse(r.updatedAt || r.createdAt || 0) || 0;
  const freshBonus = ts ? Math.min(2, (Date.now() - ts) / (1000 * 60 * 60 * 24 * 365) < 2 ? 1.5 : 0) : 0;

  return (
    ingredients * 0.9 +
    steps * 0.6 +
    images * 0.4 +
    macros * 0.5 +
    ratingScore * 0.8 +
    freshBonus +
    hostPenalty
  );
}

function pickPrimary(members) {
  if (!members.length) return null;
  const ranked = [...members].sort((a, b) => {
    const aHost = hostOf(a.canonicalUrl || a.url || "");
    const bHost = hostOf(b.canonicalUrl || b.url || "");
    const aBad = BAD_HOSTS.has(aHost || "");
    const bBad = BAD_HOSTS.has(bHost || "");
    if (aBad !== bBad) return aBad ? 1 : -1;

    const aCanon = a.canonicalUrl ? 1 : 0;
    const bCanon = b.canonicalUrl ? 1 : 0;
    if (aCanon !== bCanon) return bCanon - aCanon;

    const qa = scoreRecipeQuality(a);
    const qb = scoreRecipeQuality(b);
    if (qa !== qb) return qb - qa;

    const aText = JSON.stringify(a).length;
    const bText = JSON.stringify(b).length;
    return bText - aText;
  });
  return ranked[0];
}

/* ----------------------------- Ingredient overlap --------------------------- */
function ingredientJaccard(a, b) {
  const A = new Set((a?.ingredients || []).map((s) => String(s).toLowerCase()));
  const B = new Set((b?.ingredients || []).map((s) => String(s).toLowerCase()));
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size || 1;
  return inter / union;
}

/* ---------------------------------- Config ---------------------------------- */
const DEFAULTS = {
  titleSimThreshold: 0.86,    // similarity required to merge by title
  crossHostTitleDedupe: true, // allow merging across hosts
  minIngredientOverlap: 0,    // 0 disables ingredient guard; set ~0.30–0.45 to keep variants apart
  shouldMerge: null,          // custom (r, candidatePrimary, ctx) => boolean
};

/* ---------------------------------- Dedupe ---------------------------------- */
function dedupe(inputRecipes = [], opts = {}) {
  const {
    htmlByUrl = {},  // optional: { normalizedUrl: htmlString } for rel="canonical" detection
  } = opts;
  const cfg = { ...DEFAULTS, ...opts };

  const items = inputRecipes
    .map((r) => ({ ...r })) // shallow copy
    .filter((r) => r && (r.title || r.url));

  // 1) Canonicalize URLs
  for (const r of items) {
    const rawUrl = r.url || r.canonicalUrl;
    const norm = normalizeUrl(rawUrl);
    const html = htmlByUrl[norm];
    const canonFromHtml = html ? canonicalFromHtml(html, norm) : undefined;
    r.normalizedUrl = norm || rawUrl;
    r.canonicalUrl = normalizeUrl(r.canonicalUrl || canonFromHtml || norm);
    r._host = hostOf(r.canonicalUrl || r.normalizedUrl);
    r._titleKey = titleFingerprint(r.title || "").key;
  }

  // 2) URL-based grouping (canonical exact)
  const byUrl = new Map();
  for (const r of items) {
    const key = r.canonicalUrl || r.normalizedUrl || r.url || r.id || Math.random().toString(36).slice(2, 8);
    if (!byUrl.has(key)) byUrl.set(key, []);
    byUrl.get(key).push(r);
  }

  const clusters = [];
  for (const [key, group] of byUrl.entries()) {
    clusters.push({ keyType: "url", key, members: group });
  }

  // 3) Title-based merge across different URLs (merge singles into best cluster)
  const singles = clusters.filter((c) => c.members.length === 1);
  const multis  = clusters.filter((c) => c.members.length > 1);

  // index by fingerprint
  const titleIndex = new Map();
  for (const c of clusters) {
    const names = c.members.map((m) => m.title).filter(Boolean);
    const fp = titleFingerprint(names[0] || "").key;
    if (!titleIndex.has(fp)) titleIndex.set(fp, []);
    titleIndex.get(fp).push(c);
  }

  for (const c of singles) {
    const r = c.members[0];
    const fp = r._titleKey;
    const candidates = uniq([
      ...(titleIndex.get(fp) || []),
      ...multis,
    ]);

    let bestCluster = null;
    let bestScore = 0;

    for (const cand of candidates) {
      if (cand === c) continue;
      const candidateTitles = cand.members.map((m) => m.title || "");
      const s = Math.max(...candidateTitles.map((t) => similarity(r.title || "", t)));
      if (s > bestScore) {
        bestCluster = cand; bestScore = s;
      }
    }

    if (!bestCluster) continue;
    const sameHost = bestCluster.members.some((m) => m._host && m._host === r._host);

    if (bestScore >= cfg.titleSimThreshold) {
      if (!cfg.crossHostTitleDedupe && !sameHost) continue;

      const ingredientOK = cfg.minIngredientOverlap
        ? ingredientJaccard(r, bestCluster.members[0]) >= cfg.minIngredientOverlap
        : true;

      const userBlock = [r, ...bestCluster.members].some(x =>
        x.keepSeparate || x.favoriteStrict || x.userPinnedVariant
      );

      const customOK = typeof cfg.shouldMerge === "function"
        ? !!cfg.shouldMerge(r, bestCluster.members[0], { score: bestScore, sameHost })
        : true;

      if (!userBlock && ingredientOK && customOK) {
        bestCluster.members.push(r);
        c._mergedInto = bestCluster;
      }
    }
  }

  const finalClusters = clusters.filter((c) => !c._mergedInto);

  // 4) Pick primary and build map
  const map = {};
  const uniques = [];
  const detailedClusters = [];

  for (const c of finalClusters) {
    const primary = pickPrimary(c.members);
    if (!primary) continue;
    const clusterMembers = c.members.sort((a,b) => (a === primary ? -1 : b === primary ? 1 : 0));
    const reason = c.keyType === "url" ? "canonical-url" : "fuzzy-title";
    uniques.push(primary);
    detailedClusters.push({ reason, primary, members: clusterMembers });
    for (const m of c.members) {
      const id = m.id || (m.canonicalUrl || m.normalizedUrl || m.url);
      if (id) map[id] = primary.id || (primary.canonicalUrl || primary.normalizedUrl || primary.url);
    }
  }

  const stats = {
    inputCount: items.length,
    uniqueCount: uniques.length,
    mergedCount: Math.max(0, items.length - uniques.length),
  };

  return { unique: uniques, clusters: detailedClusters, map, stats };
}

/* ------------------------------ Version helpers ----------------------------- */
/** Build a quick index so we can grab a cluster by any member recipe id */
function indexClusters(clusters = []) {
  const byRecipeId = new Map();
  const byPrimaryId = new Map();

  for (const c of clusters) {
    const primaryId = c.primary?.id ?? c.primary?.canonicalUrl ?? c.primary?.url;
    if (primaryId) byPrimaryId.set(primaryId, c);
    for (const m of c.members || []) {
      const id = m.id ?? m.canonicalUrl ?? m.url;
      if (id) byRecipeId.set(id, c);
    }
  }
  return { byRecipeId, byPrimaryId };
}

/** Convenience: fetch the cluster that contains a given recipe id */
function getClusterByRecipeId(clusters = [], recipeId) {
  const { byRecipeId } = indexClusters(clusters);
  return byRecipeId.get(recipeId) || null;
}

/** Convenience: return versions array with primary first (for VersionPicker) */
function getVersionsForRecipe(clusters = [], recipeId) {
  const cluster = getClusterByRecipeId(clusters, recipeId);
  if (!cluster) return [];
  const members = [...(cluster.members || [])];
  members.sort((a, b) => (a?.id === cluster.primary?.id ? -1 : b?.id === cluster.primary?.id ? 1 : 0));
  return members;
}

/* ---------------------------------- exports --------------------------------- */
module.exports = {
  dedupe,
  normalizeUrl,
  titleFingerprint,
  similarity,
  // helpers for VersionPicker / wiring
  indexClusters,
  getClusterByRecipeId,
  getVersionsForRecipe,
  // internal (not required, but handy if you unit test)
  _internals: {
    ingredientJaccard,
  },
};

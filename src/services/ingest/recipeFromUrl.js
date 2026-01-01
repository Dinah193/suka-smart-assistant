// C:\Users\larho\suka-smart-assistant\src\services\ingest\recipeFromUrl.js
// Server/Browser recipe extractor: JSON-LD first, Microdata fallback (optional cheerio)
// The return shape is friendly to your cards but includes extra fields when found.

const IS_BROWSER = typeof window !== "undefined" && typeof document !== "undefined";

// Use Vite env in browser, Node env on server (fallbacks included)
const getEnv = (k, v) =>
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env[k]) ??
  (typeof process !== "undefined" && process.env && process.env[k]) ??
  v;

const DEFAULT_UA = "SukaBot/1.1 (+https://suka.local; respectful fetcher)";
const FETCH_TIMEOUT_MS = Number(
  getEnv("VITE_RECIPE_FETCH_TIMEOUT_MS", getEnv("RECIPE_FETCH_TIMEOUT_MS", 12000))
);

// If the browser calls this file, use the dev proxy (or your API) to bypass CORS.
const BROWSER_INGEST_ENDPOINT = getEnv("VITE_INGEST_API_URL", "/api/ingest");

// ───────────────────────────────── helpers ─────────────────────────────────
function withTimeout(promise, ms) {
  let to;
  return Promise.race([
    promise.finally(() => clearTimeout(to)),
    new Promise((_, rej) => (to = setTimeout(() => rej(new Error("fetch_timeout")), ms))),
  ]);
}

function first(v) {
  return Array.isArray(v) ? v[0] : v;
}
function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}
function safeText(x) {
  if (x == null) return "";
  if (typeof x === "string") return x.trim();
  if (typeof x === "number") return String(x);
  if (typeof x === "object" && "text" in x) return safeText(x.text);
  return String(x).trim();
}

function parseISO8601DurationToMinutes(dur) {
  // Very light parser for PT#H#M#S (ignore days/years)
  if (!dur || typeof dur !== "string") return null;
  const m = dur.match(/P(T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/i);
  if (!m) return null;
  const h = Number(m[2] || 0);
  const min = Number(m[3] || 0);
  const s = Number(m[4] || 0);
  return h * 60 + min + Math.round(s / 60);
}

const UNIT_WORDS = [
  "tsp","teaspoon","teaspoons",
  "tbsp","tablespoon","tablespoons",
  "cup","cups",
  "ml","l","litre","liter","liters","litres",
  "g","kg","gram","grams","kilogram","kilograms",
  "oz","ounce","ounces","lb","pound","pounds",
  "pinch","clove","cloves","slice","slices","can","cans","package","packages"
];

const UNIT_RE = new RegExp(
  `^\\s*(\\d+[\\d\\/.]*\\s*(?:[–-]\\s*\\d+[\\d\\/.]*)?)?\\s*(${UNIT_WORDS.join("|")})?\\s*(.*)$`,
  "i"
);

// Basic fraction & range support (e.g., "1 1/2", "½", "1-2")
function parseQuantity(str) {
  if (!str) return null;
  str = str.replace(/[‐-–—−]/g, "-"); // normalize dashes
  const fracMap = { "½": "1/2", "⅓": "1/3", "¼": "1/4", "¾": "3/4", "⅔": "2/3" };
  str = str.replace(/[½⅓¼¾⅔]/g, (m) => fracMap[m] || m);

  const mix = str.match(/^\s*(\d+)\s+(\d+)\/(\d+)/);
  if (mix) return Number(mix[1]) + Number(mix[2]) / Number(mix[3]);

  const frac = str.match(/^\s*(\d+)\/(\d+)/);
  if (frac) return Number(frac[1]) / Number(frac[2]);

  const range = str.match(/^\s*(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?/);
  if (range) return Number(range[1]);
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

function splitIngredient(raw) {
  const line = safeText(raw);
  if (!line) return { raw: "", name: "", qty: null, unit: null, note: "" };
  const m = line.match(UNIT_RE);
  if (!m) return { raw: line, name: line, qty: null, unit: null, note: "" };

  const qtyStr = (m[1] || "").trim();
  const unit = (m[2] || "").trim() || null;
  const rest = (m[3] || "").trim();

  const qty = parseQuantity(qtyStr);
  let name = rest;
  let note = "";
  const paren = rest.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (paren) {
    name = paren[1].trim();
    note = paren[2].trim();
  } else {
    const parts = rest.split(/,\s+/);
    if (parts.length > 1) {
      name = parts[0].trim();
      note = parts.slice(1).join(", ");
    }
  }
  return { raw: line, name, qty, unit, note };
}

function normalizeInstructions(recipe) {
  const steps = [];
  const src = recipe.recipeInstructions || recipe.instructions || [];
  const arr = asArray(src);
  for (const it of arr) {
    if (typeof it === "string") {
      const lines = it.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length === 1) steps.push({ text: lines[0] });
      else lines.forEach((ln) => steps.push({ text: ln }));
      continue;
    }
    if (it?.itemListElement) {
      for (const step of asArray(it.itemListElement)) {
        const text = safeText(step);
        if (text) steps.push({ text });
      }
      continue;
    }
    const text = safeText(it);
    if (text) steps.push({ text });
  }
  const seen = new Set();
  return steps.filter((s) => {
    const t = s.text.trim();
    if (!t || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
}

function pickBestRecipe(candidates = []) {
  let best = null;
  let max = -1;
  for (const r of candidates) {
    const n = asArray(r.recipeIngredient || r.ingredients).length;
    if (n > max) { max = n; best = r; }
  }
  return best || candidates[0] || null;
}

function extractJsonLdRecipes(allJsonLd) {
  const out = [];
  for (const node of allJsonLd) {
    const main = node["@graph"] ? asArray(node["@graph"]) : asArray(node);
    for (const entry of main) {
      const t = asArray(entry["@type"]).map(String);
      if (t.includes("Recipe")) out.push(entry);
      if (entry?.mainEntity) {
        const me = first(entry.mainEntity);
        const mt = asArray(me?.["@type"]).map(String);
        if (mt.includes("Recipe")) out.push(me);
      }
    }
  }
  return out;
}

function* iterJsonLdBlocks(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1]?.trim();
    if (!raw) continue;
    try {
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch {
        const items = [];
        let depth = 0, buf = "", inStr = false, esc = false;
        for (const ch of raw) {
          if (inStr) {
            buf += ch;
            if (esc) { esc = false; continue; }
            if (ch === "\\") { esc = true; continue; }
            if (ch === "\"") inStr = false;
            continue;
          }
          if (ch === "\"") { inStr = true; buf += ch; continue; }
          if (ch === "{") depth++, buf += ch;
          else if (ch === "}") { depth--, buf += ch; if (depth === 0) { items.push(buf); buf = ""; } }
          else buf += ch;
        }
        parsed = items.length ? items.map((s) => JSON.parse(s)).filter(Boolean) : null;
      }
      if (parsed) yield parsed;
    } catch {
      // ignore malformed script
    }
  }
}

function hostTag(url) {
  try { return new URL(url).hostname.replace(/^www\./i, ""); } catch { return "import"; }
}

function normalizeFromRecipeJson(url, rj) {
  const ingredientsRaw = asArray(rj.recipeIngredient || rj.ingredients).map(safeText).filter(Boolean);
  const ingredients = ingredientsRaw.map((raw, i) => ({ id: `i${i}`, ...splitIngredient(raw) }));

  const steps = normalizeInstructions(rj);
  const totalTimeMin =
    parseISO8601DurationToMinutes(rj.totalTime) ??
    parseISO8601DurationToMinutes(rj.cookTime) ??
    parseISO8601DurationToMinutes(rj.prepTime) ?? null;

  const yields = safeText(rj.recipeYield || rj.yield);
  const image = first(asArray(rj.image)).url || first(asArray(rj.image)) || null;
  const author = safeText(first(asArray(rj.author)));
  const cuisine = asArray(rj.recipeCuisine).map(safeText).filter(Boolean);
  const category = asArray(rj.recipeCategory).map(safeText).filter(Boolean);

  return {
    id: `url_${Date.now()}`,
    name: safeText(rj.name) || (url.split("/").pop() || url).replace(/[-_]/g, " "),
    url,
    ingredients,
    instructions: steps.map((s) => s.text).join("\n"),
    steps, // keep array for richer UIs
    yields,
    totalTimeMin,
    image,
    author: author || undefined,
    cuisine,
    categories: category,
    tags: ["imported", hostTag(url)],
    sourceName: safeText(rj.publisher?.name || rj.publisher) || undefined,
  };
}

// ─────────────────────────── Microdata fallback (optional) ───────────────────
async function tryMicrodataWithCheerio(html, url) {
  // Optional dependency: cheerio (will fail in browser; that's okay → null)
  let cheerio;
  try { cheerio = (await import("cheerio")).default; } catch { return null; }
  try {
    const $ = cheerio.load(html);
    const node = $('[itemscope][itemtype*="Recipe"]').first();
    if (!node || !node.length) return null;

    const get = (prop) => node.find(`[itemprop="${prop}"]`).map((_, el) => $(el).text().trim()).get();
    const name = node.find('[itemprop="name"]').first().text().trim();
    const ingredientLines = get("recipeIngredient").length ? get("recipeIngredient") : get("ingredients");
    const instructionNodes = node.find('[itemprop="recipeInstructions"], [itemprop="instructions"]');

    const steps = [];
    instructionNodes.each((_, el) => {
      const txt = $(el).text().trim();
      if (txt) {
        txt.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean).forEach((t) => steps.push({ text: t }));
      }
    });

    const ingredients = ingredientLines.map((raw, i) => ({ id: `i${i}`, ...splitIngredient(raw) }));

    return {
      id: `url_${Date.now()}`,
      name: name || (url.split("/").pop() || url).replace(/[-_]/g, " "),
      url,
      ingredients,
      instructions: steps.map((s) => s.text).join("\n"),
      steps,
      tags: ["imported", hostTag(url)],
    };
  } catch {
    return null;
  }
}

// ────────────────────────────── OpenGraph fallback ───────────────────────────
function tryOpenGraph(html) {
  const getMeta = (prop) => {
    const re = new RegExp(`<meta[^>]+property=["']${prop}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
    const m = html.match(re);
    return m ? m[1] : null;
  };
  return {
    title: getMeta("og:title"),
    image: getMeta("og:image"),
    site: getMeta("og:site_name"),
  };
}

// ─────────────────────── HTML fetcher by environment ────────────────────────
async function fetchHtmlByEnv(targetUrl) {
  if (IS_BROWSER) {
    // Use dev proxy (vite.config.js -> /api/ingest) or your API gateway
    const u = new URL(BROWSER_INGEST_ENDPOINT, window.location.origin);
    u.searchParams.set("url", targetUrl);
    const res = await withTimeout(fetch(u.toString(), { redirect: "follow" }), FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`ingest_fetch_failed ${res.status}`);
    return await res.text();
  } else {
    // Server-side: fetch target directly with UA
    const headers = { "User-Agent": DEFAULT_UA, Accept: "text/html,application/xhtml+xml" };
    const res = await withTimeout(fetch(targetUrl, { headers, redirect: "follow" }), FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`direct_fetch_failed ${res.status}`);
    return await res.text();
  }
}

// ───────────────────────────────── main ──────────────────────────────────────
export async function recipeFromUrl(url) {
  const html = await fetchHtmlByEnv(url);

  // 1) JSON-LD (handles multiple <script> blocks, arrays, @graph)
  const jsonLdBlocks = [];
  for (const parsed of iterJsonLdBlocks(html)) jsonLdBlocks.push(parsed);
  const recipes = extractJsonLdRecipes(jsonLdBlocks);
  if (recipes.length) {
    const best = pickBestRecipe(recipes);
    try {
      return normalizeFromRecipeJson(url, best);
    } catch {
      // fall through to other strategies
    }
  }

  // 2) Microdata fallback (optional cheerio if present)
  const micro = await tryMicrodataWithCheerio(html, url);
  if (micro) return micro;

  // 3) OG/title fallback shell
  const og = tryOpenGraph(html);
  const name =
    og.title ||
    (url.split("/").pop() || url).replace(/[-_]/g, " ");
  return {
    id: `url_${Date.now()}`,
    name,
    url,
    ingredients: [],
    instructions: "",
    steps: [],
    image: og.image || undefined,
    sourceName: og.site || undefined,
    tags: ["imported", hostTag(url)],
  };
}

export default recipeFromUrl;

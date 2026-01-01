/* eslint-disable no-console */
// utils/evergreenArticleTemplate.js
// Evergreen article factory for Suka Smart Assistant
// - Module-aware (meals, cleaning, garden, animals)
// - Generates frontmatter, Markdown body, JSON-LD (Article/HowTo/Recipe/FAQ)
// - Internal linking "web of meaning" via related links (tags/domains)
// - CTAs emit plan.fromArticle.requested and support "Save as Favorite Plan"
// - Export helpers: toMarkdown(), toHTMLBlocks(), toStaticJSON()
// - Defensive deps: eventBus, PlanStorageRouter, useFavoritePlans

const isBrowser = typeof window !== "undefined";
const now = () => Date.now();
const toISO = (ts) => new Date(ts || Date.now()).toISOString();
const slugify = (s) =>
  String(s || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const safeJSON = {
  parse: (s, f = null) => { try { return JSON.parse(s); } catch { return f; } },
  stringify: (o) => { try { return JSON.stringify(o); } catch { return "{}"; } },
};

/* --------------------------- defensive dependencies ------------------------ */
let eventBus = { on(){}, off(){}, emit(){} };
try {
  const eb = require("@/services/eventBus");
  eventBus = (eb && (eb.default || eb.eventBus || eb)) || eventBus;
} catch (_e) {}

let PlanStorageRouter = null; // cloud/drive/local bridge
try { PlanStorageRouter = require("@/services/plans/PlanStorageRouter").default; } catch (_e) {}

let useFavoritePlans = null; // Zustand hook (optional)
try { useFavoritePlans = require("@/hooks/useFavoritePlans").default; } catch (_e) {}

let date = null; // nice date helpers (optional)
try { date = require("@/utils/date").default || require("@/utils/date"); } catch (_e) {}

/* ------------------------------ tiny utilities ----------------------------- */
function pad2(n){ return (n<10?"0":"") + n; }
function dateStamp(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
}
function canonical(base, slug){ return (base || "https://example.com") + "/" + slug; }

/* ------------------------------- schema builders --------------------------- */
function buildCommonSchema({ title, description, author, url, image, publishedISO, modifiedISO, tags }) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description,
    url,
    image: image ? [image] : undefined,
    datePublished: publishedISO,
    dateModified: modifiedISO || publishedISO,
    author: author ? { "@type": "Person", name: author } : undefined,
    keywords: (tags || []).join(", "),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  };
}

function buildFAQSchema(faq = []) {
  if (!faq?.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map(q => ({
      "@type": "Question",
      name: q.q,
      acceptedAnswer: { "@type": "Answer", text: q.a },
    })),
  };
}

function buildHowToSchema({ title, description, url, image, steps = [], supplies = [], tools = [], durationISO }) {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: title,
    description,
    image,
    totalTime: durationISO || undefined,
    step: steps.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      name: s.title || `Step ${i + 1}`,
      text: s.text || s,
    })),
    supply: supplies.map(x => ({ "@type": "HowToSupply", name: x })),
    tool: tools.map(x => ({ "@type": "HowToTool", name: x })),
    url,
  };
}

function buildRecipeSchema({
  title, description, url, image, author, cuisine, keywords,
  prepTimeISO, cookTimeISO, totalTimeISO, recipeYield,
  ingredients = [], instructions = [], nutrition = {}
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: title,
    description,
    image: image ? [image] : undefined,
    author: author ? [{ "@type": "Person", name: author }] : undefined,
    recipeCuisine: cuisine || undefined,
    keywords: (keywords || []).join(", "),
    prepTime: prepTimeISO || undefined,
    cookTime: cookTimeISO || undefined,
    totalTime: totalTimeISO || undefined,
    recipeYield: recipeYield || undefined,
    recipeIngredient: ingredients,
    recipeInstructions: instructions.map((s, i) => ({
      "@type": "HowToStep",
      position: i + 1,
      text: typeof s === "string" ? s : (s.text || s.title || `Step ${i + 1}`),
      name: s.title || undefined,
    })),
    nutrition: Object.keys(nutrition || {}).length ? { "@type": "NutritionInformation", ...nutrition } : undefined,
    url,
  };
}

/* ------------------------------- CTA bridges ------------------------------- */
async function saveFavoritePlan(meta, target = "local") {
  try {
    if (PlanStorageRouter?.savePlanFavorite) {
      return await PlanStorageRouter.savePlanFavorite({
        planId: meta.planId || `article-plan:${meta.articleId}`,
        domain: meta.domain,
        source: "EvergreenArticle",
        target,
        meta,
      });
    }
  } catch (_e) {}
  try {
    if (typeof useFavoritePlans === "function") {
      const st = useFavoritePlans.getState?.();
      st?.addFavorite?.({
        id: meta.planId || `article-plan:${meta.articleId}`,
        domain: meta.domain,
        title: meta.title,
        meta,
      });
      return { ok: true, via: "useFavoritePlans" };
    }
  } catch (_e) {}
  try {
    if (isBrowser) {
      const key = "suka:favorites:plans";
      const prev = safeJSON.parse(localStorage.getItem(key), []);
      prev.push({
        id: meta.planId || `article-plan:${meta.articleId}`,
        domain: meta.domain,
        title: meta.title,
        meta,
      });
      localStorage.setItem(key, safeJSON.stringify(prev));
      return { ok: true, via: "localStorage" };
    }
  } catch (_e) {}
  return { ok: false };
}

/* ------------------------------- link webbing ------------------------------ */
// Build internal "web of meaning" links using tags + domains.
// Callers can override with getRelated({tags, domain}) to fetch from registry.
async function defaultGetRelated({ tags = [], domain = "meals" } = {}) {
  // Emit a request so a data service can respond with curated related nodes.
  const req = { domain, tags, tsISO: toISO() };
  eventBus.emit?.("content.related.requested", req);
  // Fallback: simple tag->topic route patterns
  const base = "/topics";
  const links = (tags || []).slice(0, 6).map(t => ({
    title: `Explore ${t}`,
    href: `${base}?tag=${encodeURIComponent(t)}&domain=${encodeURIComponent(domain)}`,
  }));
  // Add module hubs
  links.push({ title: "Meals Hub", href: "/meals" });
  links.push({ title: "Cleaning Hub", href: "/cleaning" });
  links.push({ title: "Garden Hub", href: "/garden" });
  links.push({ title: "Animals Hub", href: "/animals" });
  return links;
}

/* ----------------------------- template factory ---------------------------- */
/**
 * createEvergreenArticle(options)
 * @param {{
 *  module: "meals"|"cleaning"|"garden"|"animals",
 *  title: string,
 *  description?: string,
 *  author?: string,
 *  heroImage?: string,
 *  tags?: string[],
 *  baseUrl?: string,
 *  // MEALS
 *  recipe?: {
 *    cuisine?: string, yield?: string,
 *    prepTimeISO?: string, cookTimeISO?: string, totalTimeISO?: string,
 *    ingredients?: string[], instructions?: Array<{title?:string,text?:string}|string>,
 *    nutrition?: object
 *  },
 *  // HOW-TO (cleaning/garden/animals)
 *  howto?: {
 *    steps?: Array<{title?:string,text?:string}|string>,
 *    supplies?: string[], tools?: string[], durationISO?: string
 *  },
 *  faq?: Array<{q:string, a:string}>,
 *  getRelated?: ({tags:string[],domain:string})=>Promise<Array<{title:string,href:string}>>,
 * }} options
 */
function createEvergreenArticle(options) {
  const moduleDomain = options.module || "meals";
  const title = options.title || "Untitled";
  const desc = options.description || "";
  const author = options.author || "Suka Smart Assistant";
  const hero = options.heroImage || null;
  const tags = Array.isArray(options.tags) ? options.tags : [];
  const articleId = `${moduleDomain}:${slugify(title)}:${now()}`;
  const slug = `${moduleDomain}/${slugify(title)}`;
  const url = canonical(options.baseUrl || "", slug);
  const publishedISO = toISO();
  const modifiedISO = publishedISO;

  // JSON-LD
  const schema = [];
  const baseSchema = buildCommonSchema({
    title, description: desc, author, url, image: hero, publishedISO, modifiedISO, tags,
  });
  if (baseSchema) schema.push(baseSchema);

  if (moduleDomain === "meals" && options.recipe) {
    schema.push(
      buildRecipeSchema({
        title, description: desc, url, image: hero, author,
        cuisine: options.recipe.cuisine,
        keywords: tags,
        prepTimeISO: options.recipe.prepTimeISO,
        cookTimeISO: options.recipe.cookTimeISO,
        totalTimeISO: options.recipe.totalTimeISO,
        recipeYield: options.recipe.yield,
        ingredients: options.recipe.ingredients || [],
        instructions: options.recipe.instructions || [],
        nutrition: options.recipe.nutrition || {},
      })
    );
  } else if (options.howto) {
    schema.push(
      buildHowToSchema({
        title, description: desc, url, image: hero,
        steps: options.howto.steps || [],
        supplies: options.howto.supplies || [],
        tools: options.howto.tools || [],
        durationISO: options.howto.durationISO,
      })
    );
  }

  const faqSchema = buildFAQSchema(options.faq || []);
  if (faqSchema) schema.push(faqSchema);

  // Frontmatter
  const frontmatter = {
    id: articleId,
    module: moduleDomain,
    title,
    description: desc,
    author,
    slug,
    url,
    heroImage: hero,
    tags,
    date: dateStamp(),
    canonical: url,
    schemaOrg: schema,
  };

  // Body blocks (Markdown)
  const blocks = [];

  // Hero
  blocks.push(`# ${title}`);
  if (desc) blocks.push(`> ${desc}`);
  if (hero) blocks.push(`![${title}](${hero})`);

  // Intro CTA
  blocks.push(renderCTAIntro({ title, module: moduleDomain, articleId }));

  // Module sections
  if (moduleDomain === "meals" && options.recipe) {
    blocks.push(renderMealsRecipe(options.recipe));
  } else if (moduleDomain === "cleaning" && options.howto) {
    blocks.push(renderHowTo("Cleaning Routine", options.howto));
  } else if (moduleDomain === "garden" && options.howto) {
    blocks.push(renderHowTo("Garden Guide", options.howto));
  } else if (moduleDomain === "animals" && options.howto) {
    blocks.push(renderHowTo("Animal Care Guide", options.howto));
  }

  // Tips
  blocks.push(renderProTips(moduleDomain));

  // FAQ
  if (options.faq?.length) {
    blocks.push("## FAQ");
    options.faq.forEach(({ q, a }) => {
      blocks.push(`**${q}**`); 
      blocks.push(`${a}`);
    });
  }

  // Related links (web of meaning)
  const getRelated = options.getRelated || defaultGetRelated;

  async function assemble() {
    const related = await getRelated({ tags, domain: moduleDomain });
    const linkLines = (related || []).map(link => `- [${link.title}](${link.href})`);
    const relatedMD = linkLines.length
      ? `\n## Explore next\n${linkLines.join("\n")}\n`
      : "";

    const body = blocks.concat([relatedMD, renderCTAOutro({ title, module: moduleDomain, articleId })])
      .filter(Boolean)
      .join("\n\n");

    const json = {
      frontmatter,
      bodyMarkdown: body,
      htmlBlocks: toHTMLBlocks(frontmatter, body, schema),
    };

    // Announce to the system that content is ready (pipelines may save/index)
    eventBus.emit?.("content.article.generated", {
      module: moduleDomain,
      id: articleId,
      slug,
      url,
      createdISO: publishedISO,
      tags,
      hasRecipe: !!options.recipe,
      hasHowTo: !!options.howto,
    });

    return json;
  }

  return {
    id: articleId,
    slug,
    url,
    frontmatter,
    schema,
    assemble,                 // async -> { frontmatter, bodyMarkdown, htmlBlocks }
    toMarkdown: async () => {
      const a = await assemble();
      return `---\n${yaml(frontmatter)}\n---\n\n${a.bodyMarkdown}\n`;
    },
    toStaticJSON: async () => {
      const a = await assemble();
      return {
        frontmatter,
        bodyMarkdown: a.bodyMarkdown,
        htmlBlocks: a.htmlBlocks,
      };
    },
  };
}

/* ------------------------------ Render helpers ----------------------------- */
function renderCTAIntro({ title, module, articleId }) {
  const planTitle = `Plan: ${title}`;
  // Buttons are rendered by your site; here we include event guide in comments
  return [
    `> **Quick start:** Create a plan from this guide or save it as a Favorite to reuse.`,
    ``,
    `<!-- CTA:create-plan data-article="${articleId}" data-module="${module}" data-plan-title="${escapeHTML(planTitle)}" -->`,
    `<!-- CTA:save-favorite data-article="${articleId}" data-module="${module}" data-plan-title="${escapeHTML(planTitle)}" -->`,
  ].join("\n");
}

function renderCTAOutro({ title, module, articleId }) {
  const planTitle = `Plan: ${title}`;
  return [
    `---`,
    `**Loved this?**`,
    `- Create a plan: _Build steps & schedule from this guide._`,
    `- Save as Favorite: _Keep your best version ready to run again._`,
    ``,
    `<!-- CTA:create-plan data-article="${articleId}" data-module="${module}" data-plan-title="${escapeHTML(planTitle)}" -->`,
    `<!-- CTA:save-favorite data-article="${articleId}" data-module="${module}" data-plan-title="${escapeHTML(planTitle)}" -->`,
  ].join("\n");
}

function renderMealsRecipe(recipe = {}) {
  const lines = [];
  lines.push("## Ingredients");
  (recipe.ingredients || []).forEach(i => lines.push(`- ${i}`));
  lines.push("");
  lines.push("## Instructions");
  (recipe.instructions || []).forEach((s, idx) => {
    const text = typeof s === "string" ? s : (s.text || s.title || `Step ${idx + 1}`);
    lines.push(`${idx + 1}. ${text}`);
  });
  if (recipe.yield) lines.push(`\n**Yield:** ${recipe.yield}`);
  if (recipe.prepTimeISO || recipe.cookTimeISO || recipe.totalTimeISO) {
    lines.push("\n**Time:**");
    if (recipe.prepTimeISO) lines.push(`- Prep: ${isoToHuman(recipe.prepTimeISO)}`);
    if (recipe.cookTimeISO) lines.push(`- Cook: ${isoToHuman(recipe.cookTimeISO)}`);
    if (recipe.totalTimeISO) lines.push(`- Total: ${isoToHuman(recipe.totalTimeISO)}`);
  }
  lines.push("\n> _Tip: Use fresh-ground whole-grain flour for maximal nutrition and flavor._");
  return lines.join("\n");
}

function renderHowTo(title, howto = {}) {
  const lines = [];
  if (howto.supplies?.length) {
    lines.push("## Supplies");
    howto.supplies.forEach(i => lines.push(`- ${i}`));
    lines.push("");
  }
  if (howto.tools?.length) {
    lines.push("## Tools");
    howto.tools.forEach(i => lines.push(`- ${i}`));
    lines.push("");
  }
  lines.push(`## ${title} Steps`);
  (howto.steps || []).forEach((s, idx) => {
    const name = typeof s === "string" ? null : (s.title || null);
    const text = typeof s === "string" ? s : (s.text || "");
    lines.push(`**Step ${idx + 1}${name ? ` — ${name}` : ""}**`);
    lines.push(text);
    lines.push("");
  });
  if (howto.durationISO) {
    lines.push(`**Estimated time:** ${isoToHuman(howto.durationISO)}`);
  }
  return lines.join("\n");
}

function renderProTips(moduleDomain) {
  const tips = {
    meals: [
      "Batch similar tasks to boost throughput.",
      "Label and date all freezer items.",
      "Keep a running pantry inventory to auto-suggest swaps.",
    ],
    cleaning: [
      "Use 15-minute sprints to maintain streaks.",
      "Stage caddies on each floor for faster resets.",
      "Mix homemade cleaners fresh and note dilutions.",
    ],
    garden: [
      "Log harvests → auto-sync to inventory for preserve planning.",
      "Use mulch to retain moisture and suppress weeds.",
      "Plan succession sowings on your calendar.",
    ],
    animals: [
      "Standardize morning/evening checks to reduce misses.",
      "Rotate pasture to protect forage and break parasite cycles.",
      "Schedule processor drop-offs well in advance.",
    ],
  }[moduleDomain] || [];
  return tips.length
    ? `## Pro Tips\n` + tips.map(t => `- ${t}`).join("\n")
    : "";
}

/* ----------------------------- HTML block maker ---------------------------- */
function toHTMLBlocks(frontmatter, markdownBody, schemaArray) {
  // This returns chunks your renderer can drop into the page template.
  // Keep raw to avoid coupling to any MD engine here.
  const ld = (schemaArray || []).filter(Boolean);
  return {
    head: [
      `<link rel="canonical" href="${escapeAttr(frontmatter.canonical)}"/>`,
      `<meta property="og:title" content="${escapeAttr(frontmatter.title)}"/>`,
      `<meta property="og:description" content="${escapeAttr(frontmatter.description || "")}"/>`,
      frontmatter.heroImage ? `<meta property="og:image" content="${escapeAttr(frontmatter.heroImage)}"/>` : "",
      `<meta name="article:published_time" content="${escapeAttr(frontmatter.date)}"/>`,
      `<script type="application/ld+json">${escapeHTML(JSON.stringify(ld))}</script>`,
    ].filter(Boolean).join("\n"),
    bodyMarkdown: markdownBody,
  };
}

/* ------------------------------- helpers ----------------------------------- */
function isoToHuman(iso = "") {
  // quick ISO 8601 duration converter like PT1H30M -> "1h 30m"
  const m = String(iso).match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i) ||
            String(iso).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!m) return iso;
  const d = parseInt(m[1] || "0", 10);
  const h = parseInt(m[2] || "0", 10);
  const min = parseInt(m[3] || "0", 10);
  const s = parseInt(m[4] || "0", 10);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (min) parts.push(`${min}m`);
  if (s && !h && !d) parts.push(`${s}s`);
  return parts.join(" ") || iso;
}

function yaml(obj) {
  // very small YAML frontmatter serializer
  const lines = [];
  const write = (k, v, depth = 0) => {
    const pad = "  ".repeat(depth);
    if (v == null) return;
    if (Array.isArray(v)) {
      lines.push(`${pad}${k}:`);
      v.forEach(x => {
        if (typeof x === "object" && x) {
          lines.push(`${pad}-`);
          Object.keys(x).forEach(sub => write(sub, x[sub], depth + 1));
        } else {
          lines.push(`${pad}- ${String(x)}`);
        }
      });
    } else if (typeof v === "object") {
      lines.push(`${pad}${k}:`);
      Object.keys(v).forEach(sub => write(sub, v[sub], depth + 1));
    } else {
      const needsQuote = /[:#>-]|^\s|\s$/.test(String(v));
      lines.push(`${pad}${k}: ${needsQuote ? JSON.stringify(String(v)) : v}`);
    }
  };
  Object.keys(obj).forEach(k => write(k, obj[k], 0));
  return lines.join("\n");
}

function escapeHTML(s){ return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function escapeAttr(s){ return escapeHTML(s).replace(/"/g, "&quot;"); }

/* --------------------------- public CTA utilities -------------------------- */
// Call from your page/template when a CTA button is clicked
function emitCreatePlanFromArticle({ articleId, module, planTitle, tags = [] }) {
  eventBus.emit?.("plan.fromArticle.requested", {
    domain: module || "meals",
    articleId,
    title: planTitle,
    createdISO: toISO(),
    params: { tags },
  });
}

async function saveFavoriteFromArticle({ articleId, module, planTitle, tags = [], target = "local" }) {
  const res = await saveFavoritePlan({
    articleId,
    title: planTitle,
    domain: module || "meals",
    createdISO: toISO(),
    tags,
  }, target);
  if (res?.ok) {
    eventBus.emit?.("toast", { kind: "success", message: "Saved as Favorite Plan", tsISO: toISO() });
  } else {
    eventBus.emit?.("toast", { kind: "error", message: "Could not save favorite", tsISO: toISO() });
  }
  return res;
}

/* --------------------------------- export ---------------------------------- */
const api = {
  createEvergreenArticle,
  emitCreatePlanFromArticle,
  saveFavoriteFromArticle,
};

export default api;

// CJS compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = api;
}

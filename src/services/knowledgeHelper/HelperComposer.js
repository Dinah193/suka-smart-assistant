/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\services\knowledgeHelper\HelperComposer.js
/**
 * SSA • Knowledge Helper • HelperComposer
 * -----------------------------------------------------------------------------
 * Browser-safe orchestrator that:
 *  - Takes a user "context request" (question/goal/error/task)
 *  - Runs ContextMatcher across one or more knowledge pools
 *  - Produces UI-ready "Helper Cards" with next steps, checklists, pitfalls,
 *    tools/materials, links, and explanation of why items were selected.
 *
 * Design goals:
 *  - Deterministic + explainable (no network required)
 *  - Modular pools (skills, methods, components, SOPs, docs, KB notes, etc.)
 *  - Works with SSA’s layered catalogs and Dexie-backed records
 *  - Stable, production-ready data contracts
 *
 * This file does NOT import Dexie or eventBus to keep it portable.
 * Callers can persist outputs + emit events as needed.
 *
 * Dependencies:
 *  - ContextMatcher.js (same folder)
 */

import ContextMatcher, {
  ContextMatcher as ContextMatcherClass,
} from "./ContextMatcher";

/* -----------------------------------------------------------------------------
 * Defaults + Contracts
 * -------------------------------------------------------------------------- */

const DEFAULTS = Object.freeze({
  // matching
  limitPerPool: 8,
  overallLimit: 12,
  minScore: 0.18,

  // composition
  includeDebug: false,
  includeHighlights: true,
  includeWhyThis: true,
  includeActions: true,
  includeChecklists: true,
  includePitfalls: true,
  includeTools: true,
  includeLinks: true,

  // tuning
  poolWeights: {
    skills: 1.15,
    methods: 1.05,
    components: 1.0,
    sops: 1.1,
    docs: 0.9,
    kb: 0.95,
    recipes: 0.85,
    other: 0.9,
  },

  // action generation
  maxActionsPerCard: 8,
  maxChecklistItems: 12,
  maxPitfalls: 10,
  maxTools: 10,
  maxLinks: 8,

  // text extraction safeguards
  maxTextChars: 8000,

  // scoring / rerank
  rerank: {
    diversityPenalty: 0.07, // penalize repeated near-duplicates
    sameTitlePenalty: 0.1,
    sameTypePenalty: 0.03,
    sameDomainPenalty: 0.02,
  },

  // heuristics for intent classification
  intentRules: {
    errorWords: [
      "error",
      "failed",
      "exception",
      "uncaught",
      "build",
      "vite",
      "rollup",
      "ts",
      "typescript",
      "undefined",
      "not defined",
    ],
    howToWords: [
      "how",
      "make",
      "cook",
      "fix",
      "build",
      "create",
      "setup",
      "install",
      "implement",
      "plan",
    ],
    goalWords: ["goal", "want", "need", "plan", "trying", "aim", "target"],
    compareWords: ["vs", "versus", "compare", "difference", "better", "best"],
  },
});

/**
 * Helper Request (input)
 * {
 *   query: string,
 *   domain?: string,
 *   tags?: string[],
 *   type?: string|string[],
 *   filters?: object,
 *   context?: {
 *     pageKey?: string,
 *     route?: string,
 *     householdId?: string,
 *     sessionDomain?: string,
 *     artifacts?: object,     // any structured data you want to attach
 *   },
 *   pools?: KnowledgePool[] | Record<string, KnowledgePool>,
 *   options?: object
 * }
 *
 * KnowledgePool shape (flexible):
 * {
 *   key: "skills"|"methods"|...,
 *   label?: string,
 *   items: any[],
 *   matcher?: ContextMatcher instance OR matcher options
 *   weight?: number
 * }
 *
 * Helper Response (output)
 * {
 *   ok: true,
 *   query: string,
 *   intent: { kind: "error"|"howto"|"goal"|"compare"|"general", confidence: 0..1, signals: string[] },
 *   fingerprint: string,
 *   results: HelperCard[],
 *   suggestions: { followUps: string[], refinements: string[] },
 *   debug?: object
 * }
 *
 * HelperCard:
 * {
 *   id: string,
 *   title: string,
 *   domain?: string,
 *   type?: string,
 *   score: number,
 *   poolKey: string,
 *   poolLabel?: string,
 *   summary?: string,
 *   tags?: string[],
 *   whyThis?: string[],
 *   actions?: ActionItem[],
 *   checklist?: ChecklistItem[],
 *   pitfalls?: string[],
 *   tools?: string[],
 *   links?: LinkItem[],
 *   meta?: object,
 *   debug?: object
 * }
 */

/* -----------------------------------------------------------------------------
 * Small utilities
 * -------------------------------------------------------------------------- */

function nowMs() {
  return Date.now();
}

function clampString(s, maxChars) {
  if (!s) return "";
  const str = String(s);
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars);
}

function toLowerSafe(s) {
  return (s == null ? "" : String(s)).toLowerCase();
}

function normalizeSpace(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function asArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function uniq(arr) {
  const set = new Set();
  const out = [];
  for (let i = 0; i < (arr || []).length; i++) {
    const v = arr[i];
    if (!set.has(v)) {
      set.add(v);
      out.push(v);
    }
  }
  return out;
}

function stableHash32(str) {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  return h >>> 0;
}

function fingerprintOf(obj) {
  try {
    const s = JSON.stringify(obj);
    return String(stableHash32(s));
  } catch {
    return String(stableHash32(String(obj)));
  }
}

function safePickText(item, fields, maxChars) {
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const v = item?.[f];
    if (v == null) continue;
    if (Array.isArray(v)) {
      const joined = v.join("\n");
      if (joined.trim()) return clampString(joined, maxChars);
    } else if (String(v).trim()) {
      return clampString(String(v), maxChars);
    }
  }
  return "";
}

function titleOf(item) {
  return (
    item?.title ||
    item?.name ||
    item?.label ||
    (item?.id ? `Item ${String(item.id).slice(0, 8)}` : "(untitled)")
  );
}

function domainOf(item) {
  return item?.domain || item?.meta?.domain || null;
}

function typeOf(item) {
  return item?.type || item?.meta?.type || null;
}

function tagsOf(item) {
  const t = item?.tags || item?.keywords || item?.meta?.tags || [];
  return Array.isArray(t) ? t.filter(Boolean).map(String) : [String(t)];
}

function linksOf(item) {
  const out = [];
  if (item?.url) out.push({ label: "Open", url: String(item.url) });
  if (item?.sourceUrl)
    out.push({ label: "Source", url: String(item.sourceUrl) });
  if (Array.isArray(item?.links)) {
    for (let i = 0; i < item.links.length; i++) {
      const l = item.links[i];
      if (!l) continue;
      if (typeof l === "string") out.push({ label: "Link", url: l });
      else if (l.url) out.push({ label: l.label || "Link", url: l.url });
    }
  }
  return out;
}

/* -----------------------------------------------------------------------------
 * Intent detection (deterministic heuristics)
 * -------------------------------------------------------------------------- */

function detectIntent(query, rules = DEFAULTS.intentRules) {
  const q = toLowerSafe(query);
  const signals = [];
  let kind = "general";
  let score = 0.25;

  const hitAny = (words) => {
    for (let i = 0; i < words.length; i++) {
      if (q.includes(words[i])) return true;
    }
    return false;
  };

  const isError =
    hitAny(rules.errorWords) ||
    /uncaught|referenceerror|typeerror|syntaxerror/i.test(query);
  const isCompare = hitAny(rules.compareWords);
  const isGoal = hitAny(rules.goalWords);
  const isHow = hitAny(rules.howToWords) || q.startsWith("how ");

  if (isError) {
    kind = "error";
    score = 0.85;
    signals.push("error_keywords");
  } else if (isCompare) {
    kind = "compare";
    score = 0.75;
    signals.push("compare_keywords");
  } else if (isHow) {
    kind = "howto";
    score = 0.68;
    signals.push("howto_keywords");
  } else if (isGoal) {
    kind = "goal";
    score = 0.62;
    signals.push("goal_keywords");
  }

  // more confidence if query contains code-ish patterns
  if (
    kind === "error" &&
    /src\/|\.jsx|\.js|:\d+:\d+|import\s+|export\s+|vite|rollup/i.test(query)
  ) {
    score = Math.min(0.98, score + 0.08);
    signals.push("code_signals");
  }

  return { kind, confidence: Number(score.toFixed(2)), signals };
}

/* -----------------------------------------------------------------------------
 * HelperComposer
 * -------------------------------------------------------------------------- */

export class HelperComposer {
  constructor(options = {}) {
    this.cfg = {
      ...DEFAULTS,
      ...options,
      poolWeights: { ...DEFAULTS.poolWeights, ...(options.poolWeights || {}) },
      rerank: { ...DEFAULTS.rerank, ...(options.rerank || {}) },
      intentRules: { ...DEFAULTS.intentRules, ...(options.intentRules || {}) },
    };

    // caches matchers per poolKey + fingerprint of items length + item ids
    this._matcherCache = new Map();
  }

  /**
   * Compose helper cards.
   * @param {object} req HelperRequest
   * @returns {object} HelperResponse
   */
  compose(req = {}) {
    const query = String(req.query || "").trim();
    const options = { ...(req.options || {}) };

    const cfg = {
      ...this.cfg,
      ...options,
      poolWeights: { ...this.cfg.poolWeights, ...(options.poolWeights || {}) },
      rerank: { ...this.cfg.rerank, ...(options.rerank || {}) },
    };

    if (!query) {
      return {
        ok: true,
        query: "",
        intent: detectIntent("", cfg.intentRules),
        fingerprint: fingerprintOf({ t: "empty", at: nowMs() }),
        results: [],
        suggestions: this._suggestionsForEmpty(),
        debug: cfg.includeDebug ? { reason: "empty_query" } : undefined,
      };
    }

    const intent = detectIntent(query, cfg.intentRules);

    const pools = this._normalizePools(req.pools);
    const poolList = pools.length ? pools : this._defaultPoolsFallback(req);

    const perPoolLimit = Math.max(1, cfg.limitPerPool | 0);
    const overallLimit = Math.max(1, cfg.overallLimit | 0);
    const minScore =
      typeof cfg.minScore === "number" ? cfg.minScore : DEFAULTS.minScore;

    const prefDomain = req.domain || req.context?.sessionDomain || null;
    const prefTags = Array.isArray(req.tags) ? req.tags : [];
    const prefTypes = asArray(req.type);

    const filters = req.filters || {};

    // Gather matches across pools
    const poolMatches = [];
    const debugPools = [];

    for (let i = 0; i < poolList.length; i++) {
      const pool = poolList[i];
      const items = Array.isArray(pool.items) ? pool.items : [];
      if (!items.length) continue;

      const matcher = this._getMatcherForPool(pool, items, cfg);
      const matchRes = matcher.match({
        query,
        domain: prefDomain || undefined,
        tags: prefTags,
        type: prefTypes,
        filters,
        options: {
          limit: perPoolLimit,
          minScore,
          includeHighlights: cfg.includeHighlights,
          includeDebug: cfg.includeDebug,
        },
      });

      const weight =
        typeof pool.weight === "number"
          ? pool.weight
          : cfg.poolWeights[pool.key] || cfg.poolWeights.other || 1;

      const mapped = (matchRes.results || []).map((r) => ({
        poolKey: pool.key,
        poolLabel: pool.label || pool.key,
        weight,
        // reweight score but keep original for debug
        score: Math.max(0, Math.min(1, r.score * weight)),
        baseScore: r.score,
        matchMeta: r.matchMeta,
        highlights: r.highlights,
        item: this._findItemById(items, r.id),
        raw: r,
      }));

      if (cfg.includeDebug) {
        debugPools.push({
          key: pool.key,
          label: pool.label || pool.key,
          itemCount: items.length,
          matched: mapped.length,
          matcherFingerprint: matcher.fingerprint,
          weight,
        });
      }

      for (let j = 0; j < mapped.length; j++) {
        if (mapped[j].item) poolMatches.push(mapped[j]);
      }
    }

    // Rerank across pools with diversity penalties
    const reranked = this._rerank(poolMatches, cfg);

    // Compose cards
    const cards = [];
    const seenIds = new Set();

    for (let i = 0; i < reranked.length; i++) {
      const hit = reranked[i];
      if (!hit || !hit.item || !hit.item.id) continue;
      if (seenIds.has(hit.item.id)) continue;
      if (hit.score < minScore) continue;

      const card = this._composeCard(hit, query, intent, cfg);
      cards.push(card);
      seenIds.add(hit.item.id);

      if (cards.length >= overallLimit) break;
    }

    const response = {
      ok: true,
      query,
      intent,
      fingerprint: fingerprintOf({
        q: query,
        intent: intent.kind,
        pools: debugPools.length
          ? debugPools
          : poolList.map((p) => ({ k: p.key, n: (p.items || []).length })),
        cfg: { limitPerPool: perPoolLimit, overallLimit, minScore },
      }),
      results: cards,
      suggestions: this._suggestions(query, intent, cards, cfg),
      debug: cfg.includeDebug
        ? {
            pools: debugPools,
            matchedTotal: poolMatches.length,
            rerankedTotal: reranked.length,
          }
        : undefined,
    };

    return response;
  }

  /* -------------------------------------------------------------------------
   * Pools + matcher management
   * ---------------------------------------------------------------------- */

  _normalizePools(pools) {
    if (!pools) return [];
    if (Array.isArray(pools)) {
      return pools.filter(Boolean).map((p) => ({
        key: p.key || "other",
        label: p.label,
        items: Array.isArray(p.items) ? p.items : [],
        matcher: p.matcher,
        weight: p.weight,
      }));
    }
    if (typeof pools === "object") {
      const out = [];
      Object.keys(pools).forEach((k) => {
        const p = pools[k];
        if (!p) return;
        out.push({
          key: p.key || k,
          label: p.label || k,
          items: Array.isArray(p.items) ? p.items : Array.isArray(p) ? p : [],
          matcher: p.matcher,
          weight: p.weight,
        });
      });
      return out;
    }
    return [];
  }

  _defaultPoolsFallback(req) {
    // If caller forgot to pass pools, try a few conventional fields on req.context
    const ctx = req.context || {};
    const out = [];
    if (Array.isArray(ctx.skills))
      out.push({ key: "skills", items: ctx.skills });
    if (Array.isArray(ctx.methods))
      out.push({ key: "methods", items: ctx.methods });
    if (Array.isArray(ctx.components))
      out.push({ key: "components", items: ctx.components });
    if (Array.isArray(ctx.kb)) out.push({ key: "kb", items: ctx.kb });
    return out;
  }

  _getMatcherForPool(pool, items, cfg) {
    // If pool.matcher is an instance, use it as-is.
    if (pool.matcher && pool.matcher instanceof ContextMatcherClass) {
      return pool.matcher;
    }

    // Pool matcher options override
    const matcherOptions =
      typeof pool.matcher === "object" && pool.matcher ? pool.matcher : {};

    // Cache key based on pool key + item ids + updatedAt + size
    const signature = this._poolSignature(items);
    const key = `${pool.key}::${signature}::${fingerprintOf(
      matcherOptions
    )}::${String(cfg.includeDebug)}::${String(cfg.includeHighlights)}`;

    const cached = this._matcherCache.get(key);
    if (cached) return cached;

    const matcher = new ContextMatcher({
      minScore: cfg.minScore,
      includeDebug: cfg.includeDebug,
      includeHighlights: cfg.includeHighlights,
      ...matcherOptions,
    });

    matcher.setItems(items);

    // keep cache bounded
    this._matcherCache.set(key, matcher);
    if (this._matcherCache.size > 24) {
      // delete oldest inserted
      const firstKey = this._matcherCache.keys().next().value;
      this._matcherCache.delete(firstKey);
    }
    return matcher;
  }

  _poolSignature(items) {
    const n = items.length;
    let h = 2166136261;
    // sample a few items deterministically to avoid O(n) hashing for huge arrays
    const stride = Math.max(1, Math.floor(n / 25));
    for (let i = 0; i < n; i += stride) {
      const it = items[i];
      if (!it || !it.id) continue;
      const id = String(it.id);
      const u = it.updatedAt ? String(it.updatedAt) : "";
      h = (h ^ stableHash32(id + "|" + u)) >>> 0;
      h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
    }
    h = (h ^ (n >>> 0)) >>> 0;
    return String(h >>> 0);
  }

  _findItemById(items, id) {
    if (!id) return null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && String(it.id) === String(id)) return it;
    }
    return null;
  }

  /* -------------------------------------------------------------------------
   * Reranking (diversity + penalties)
   * ---------------------------------------------------------------------- */

  _rerank(hits, cfg) {
    const list = Array.isArray(hits) ? hits.slice() : [];
    list.sort((a, b) => b.score - a.score);

    const out = [];
    const seenTitles = new Map(); // title -> count
    const seenTypes = new Map(); // type -> count
    const seenDomains = new Map(); // domain -> count

    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const item = h.item;
      if (!item) continue;

      const title = normalizeSpace(toLowerSafe(titleOf(item)));
      const typ = toLowerSafe(typeOf(item) || "");
      const dom = toLowerSafe(domainOf(item) || "");

      let s = h.score;

      const titleCount = seenTitles.get(title) || 0;
      const typeCount = seenTypes.get(typ) || 0;
      const domainCount = seenDomains.get(dom) || 0;

      if (title && titleCount > 0)
        s *= Math.max(0.2, 1 - cfg.rerank.sameTitlePenalty * titleCount);
      if (typ && typeCount > 0)
        s *= Math.max(0.35, 1 - cfg.rerank.sameTypePenalty * typeCount);
      if (dom && domainCount > 0)
        s *= Math.max(0.45, 1 - cfg.rerank.sameDomainPenalty * domainCount);

      // mild penalty if pool duplicates (e.g., same item mirrored)
      const dupPenalty = this._duplicatePenalty(out, item, cfg);
      if (dupPenalty > 0) s *= Math.max(0.25, 1 - dupPenalty);

      out.push({ ...h, score: s });

      if (title) seenTitles.set(title, titleCount + 1);
      if (typ) seenTypes.set(typ, typeCount + 1);
      if (dom) seenDomains.set(dom, domainCount + 1);
    }

    out.sort((a, b) => b.score - a.score);
    return out;
  }

  _duplicatePenalty(selected, item, cfg) {
    // very cheap near-duplicate check: same title prefix or same source/url
    const t = normalizeSpace(toLowerSafe(titleOf(item)));
    const url = item?.url ? String(item.url) : "";
    const src = item?.source ? String(item.source) : "";

    let penalty = 0;

    for (let i = 0; i < selected.length; i++) {
      const sIt = selected[i]?.item;
      if (!sIt) continue;

      const st = normalizeSpace(toLowerSafe(titleOf(sIt)));
      if (t && st && (t.startsWith(st) || st.startsWith(t)))
        penalty = Math.max(penalty, cfg.rerank.diversityPenalty);

      const surl = sIt?.url ? String(sIt.url) : "";
      if (url && surl && url === surl)
        penalty = Math.max(penalty, cfg.rerank.diversityPenalty + 0.04);

      const ssrc = sIt?.source ? String(sIt.source) : "";
      if (src && ssrc && src === ssrc)
        penalty = Math.max(penalty, cfg.rerank.diversityPenalty * 0.6);
    }

    return penalty;
  }

  /* -------------------------------------------------------------------------
   * Card composition
   * ---------------------------------------------------------------------- */

  _composeCard(hit, query, intent, cfg) {
    const item = hit.item;
    const title = titleOf(item);
    const domain = domainOf(item);
    const type = typeOf(item);
    const tags = tagsOf(item);

    const summary =
      item?.summary ||
      safePickText(item, ["description", "desc", "notes"], cfg.maxTextChars) ||
      "";

    const body = safePickText(
      item,
      ["body", "content", "details"],
      cfg.maxTextChars
    );
    const stepsText = safePickText(
      item,
      ["steps", "procedure", "instructions"],
      cfg.maxTextChars
    );

    const extracted = this._extractKnowledgeBits(
      item,
      { body, stepsText, summary },
      cfg
    );

    const whyThis = cfg.includeWhyThis
      ? this._whyThis(hit, query, intent, cfg)
      : undefined;

    const actions = cfg.includeActions
      ? this._actionsFor(item, extracted, intent, cfg)
      : undefined;
    const checklist = cfg.includeChecklists
      ? this._checklistFor(item, extracted, intent, cfg)
      : undefined;
    const pitfalls = cfg.includePitfalls
      ? this._pitfallsFor(item, extracted, intent, cfg)
      : undefined;
    const tools = cfg.includeTools
      ? this._toolsFor(item, extracted, intent, cfg)
      : undefined;

    const links = cfg.includeLinks
      ? this._linksFor(item, extracted, cfg)
      : undefined;

    const card = {
      id: String(item.id),
      title,
      domain: domain || null,
      type: type || null,
      score: Number(hit.score.toFixed(4)),
      poolKey: hit.poolKey,
      poolLabel: hit.poolLabel,
      summary: summary ? clampString(summary, 800) : null,
      tags,
      whyThis,
      actions,
      checklist,
      pitfalls,
      tools,
      links,
      meta: item?.meta || undefined,
      debug: cfg.includeDebug
        ? {
            baseScore: hit.baseScore,
            weightedScore: hit.score,
            matchMeta: hit.matchMeta,
            highlights: hit.highlights,
            poolKey: hit.poolKey,
          }
        : undefined,
    };

    // Trim empty arrays for cleanliness
    if (Array.isArray(card.actions) && card.actions.length === 0)
      delete card.actions;
    if (Array.isArray(card.checklist) && card.checklist.length === 0)
      delete card.checklist;
    if (Array.isArray(card.pitfalls) && card.pitfalls.length === 0)
      delete card.pitfalls;
    if (Array.isArray(card.tools) && card.tools.length === 0) delete card.tools;
    if (Array.isArray(card.links) && card.links.length === 0) delete card.links;
    if (Array.isArray(card.whyThis) && card.whyThis.length === 0)
      delete card.whyThis;

    return card;
  }

  _extractKnowledgeBits(item, texts, cfg) {
    // This tries to pull structured hints if present, otherwise heuristics.
    const out = {
      tools: [],
      pitfalls: [],
      checklist: [],
      actions: [],
      links: [],
    };

    // Direct structured fields (preferred)
    const directTools = asArray(
      item?.tools || item?.materials || item?.equipment || item?.meta?.tools
    );
    const directPitfalls = asArray(
      item?.pitfalls || item?.warnings || item?.meta?.pitfalls
    );
    const directChecklist = asArray(
      item?.checklist || item?.checks || item?.meta?.checklist
    );
    const directActions = asArray(
      item?.actions || item?.nextSteps || item?.meta?.actions
    );

    out.tools = directTools.map(String).filter(Boolean);
    out.pitfalls = directPitfalls.map(String).filter(Boolean);
    out.checklist = directChecklist
      .map((x) => (typeof x === "string" ? { text: x } : x))
      .filter(Boolean);
    out.actions = directActions
      .map((x) => (typeof x === "string" ? { label: x, kind: "step" } : x))
      .filter(Boolean);

    // Parse markdown-ish bullets from body/steps when structured not present
    const merged = [texts.summary, texts.stepsText, texts.body]
      .filter(Boolean)
      .join("\n");
    const bulletLines = this._extractBulletLines(merged, 140);

    // Heuristic sections by keywords
    const { tools, pitfalls, checklist, actions } =
      this._classifyBullets(bulletLines);

    if (!out.tools.length) out.tools = tools;
    if (!out.pitfalls.length) out.pitfalls = pitfalls;
    if (!out.checklist.length)
      out.checklist = checklist.map((t) => ({ text: t }));
    if (!out.actions.length)
      out.actions = actions.map((t) => ({ label: t, kind: "step" }));

    // Limit sizes
    out.tools = out.tools.slice(0, cfg.maxTools);
    out.pitfalls = out.pitfalls.slice(0, cfg.maxPitfalls);
    out.checklist = out.checklist.slice(0, cfg.maxChecklistItems);
    out.actions = out.actions.slice(0, cfg.maxActionsPerCard);

    // Links
    out.links = linksOf(item).slice(0, cfg.maxLinks);

    return out;
  }

  _extractBulletLines(text, maxLines) {
    const lines = String(text || "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    const out = [];
    for (let i = 0; i < lines.length && out.length < maxLines; i++) {
      const l = lines[i];
      // bullet patterns
      if (/^[-*•]\s+/.test(l)) out.push(l.replace(/^[-*•]\s+/, ""));
      else if (/^\d+[.)]\s+/.test(l)) out.push(l.replace(/^\d+[.)]\s+/, ""));
      else if (/^\[\s*\]\s+/.test(l)) out.push(l.replace(/^\[\s*\]\s+/, ""));
    }
    return out;
  }

  _classifyBullets(bullets) {
    const tools = [];
    const pitfalls = [];
    const checklist = [];
    const actions = [];

    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      const low = toLowerSafe(b);

      if (/(tool|tools|need|materials|equipment|supplies):/.test(low)) {
        // "Tools: X, Y"
        const after = b.split(":").slice(1).join(":").trim();
        after
          .split(/,|;|\/|\|/)
          .map((x) => x.trim())
          .filter(Boolean)
          .forEach((x) => tools.push(x));
        continue;
      }

      if (/(avoid|warning|caution|pitfall|don['’]?t|do not)/.test(low)) {
        pitfalls.push(b);
        continue;
      }

      if (/(check|verify|make sure|ensure)/.test(low)) {
        checklist.push(b);
        continue;
      }

      // default treat as action-ish if it starts with a verb
      if (
        /^(add|mix|stir|cook|heat|preheat|chop|slice|set|open|close|run|save|update|delete|import|export|fix|replace|install|create|build|test|deploy)\b/i.test(
          b
        )
      ) {
        actions.push(b);
        continue;
      }

      // if short and imperative, count as action
      if (
        b.length <= 80 &&
        /^[a-z]/i.test(b) &&
        /\b(to|and)\b/i.test(b) === false
      )
        actions.push(b);
    }

    return {
      tools: uniq(tools),
      pitfalls: uniq(pitfalls),
      checklist: uniq(checklist),
      actions: uniq(actions),
    };
  }

  _whyThis(hit, query, intent, cfg) {
    const reasons = [];

    const mm = hit.matchMeta || {};
    if (mm.phraseHit) reasons.push("Exact phrase match found.");
    if (mm.orderedHit) reasons.push("Your keywords appear in the right order.");
    if (typeof mm.overlap === "number")
      reasons.push(`Keyword overlap: ${mm.overlap} terms.`);
    if (mm.tagBoost && mm.tagBoost > 0)
      reasons.push("Matches your preferred tags.");
    if (mm.domainBoost && mm.domainBoost > 0)
      reasons.push("Matches your current domain.");
    if (mm.typeBoost && mm.typeBoost > 0)
      reasons.push("Matches your selected type.");

    // also use highlights
    if (
      cfg.includeHighlights &&
      Array.isArray(hit.highlights) &&
      hit.highlights.length
    ) {
      const top = hit.highlights
        .slice(0, 2)
        .map((h) => `${h.field} (${h.hitCount})`);
      reasons.push(`Strong hits in: ${top.join(", ")}.`);
    }

    // intent-aware explanation
    if (intent.kind === "error")
      reasons.push("Looks relevant to troubleshooting/build errors.");
    if (intent.kind === "howto")
      reasons.push("Looks like a how-to / procedure match.");
    if (intent.kind === "goal")
      reasons.push("Supports your goal with steps and planning guidance.");

    return reasons.slice(0, 6);
  }

  _actionsFor(item, extracted, intent, cfg) {
    const out = [];

    // Prefer explicit actions
    if (Array.isArray(extracted.actions) && extracted.actions.length) {
      for (
        let i = 0;
        i < extracted.actions.length && out.length < cfg.maxActionsPerCard;
        i++
      ) {
        const a = extracted.actions[i];
        if (!a) continue;
        if (typeof a === "string") out.push({ kind: "step", label: a });
        else if (a.label)
          out.push({
            kind: a.kind || "step",
            label: String(a.label),
            data: a.data || undefined,
          });
      }
    }

    // If no actions, derive from steps
    if (!out.length) {
      const steps = asArray(item?.steps);
      for (
        let i = 0;
        i < steps.length && out.length < cfg.maxActionsPerCard;
        i++
      ) {
        const s = String(steps[i] || "").trim();
        if (s) out.push({ kind: "step", label: s });
      }
    }

    // Intent-specific add-ons
    if (intent.kind === "error") {
      out.unshift({
        kind: "diagnose",
        label: "Capture the exact error message + file path + line number.",
      });
      if (out.length > cfg.maxActionsPerCard)
        out.length = cfg.maxActionsPerCard;
    }

    return out;
  }

  _checklistFor(item, extracted, intent, cfg) {
    const out = [];

    if (Array.isArray(extracted.checklist) && extracted.checklist.length) {
      for (
        let i = 0;
        i < extracted.checklist.length && out.length < cfg.maxChecklistItems;
        i++
      ) {
        const c = extracted.checklist[i];
        if (!c) continue;
        if (typeof c === "string") out.push({ text: c, checked: false });
        else if (c.text)
          out.push({ text: String(c.text), checked: !!c.checked });
      }
    }

    // fallback for skills/methods: simple sanity checks
    if (!out.length) {
      const t = toLowerSafe(typeOf(item) || "");
      if (t.includes("skill") || t.includes("method") || t.includes("sop")) {
        out.push(
          {
            text: "Confirm prerequisites/resources are available.",
            checked: false,
          },
          {
            text: "Read through the full procedure once before starting.",
            checked: false,
          },
          {
            text: "Prepare tools/materials and set up your workspace.",
            checked: false,
          }
        );
      }
    }

    if (intent.kind === "error") {
      out.unshift({
        text: "Reproduce the issue once and note exact steps.",
        checked: false,
      });
      if (out.length > cfg.maxChecklistItems)
        out.length = cfg.maxChecklistItems;
    }

    return out;
  }

  _pitfallsFor(item, extracted, intent, cfg) {
    const out = [];

    if (Array.isArray(extracted.pitfalls) && extracted.pitfalls.length) {
      for (
        let i = 0;
        i < extracted.pitfalls.length && out.length < cfg.maxPitfalls;
        i++
      ) {
        const p = String(extracted.pitfalls[i] || "").trim();
        if (p) out.push(p);
      }
    }

    if (!out.length && intent.kind === "error") {
      out.push(
        "Don’t change multiple files at once—fix the first failing import/export, rebuild, then continue.",
        "Watch for browser-incompatible Node imports in Vite builds (node:* modules).",
        "Ensure the symbol name exists AND is exported from the referenced module."
      );
    }

    return out;
  }

  _toolsFor(item, extracted, intent, cfg) {
    const out = [];

    if (Array.isArray(extracted.tools) && extracted.tools.length) {
      for (
        let i = 0;
        i < extracted.tools.length && out.length < cfg.maxTools;
        i++
      ) {
        const t = String(extracted.tools[i] || "").trim();
        if (t) out.push(t);
      }
    }

    if (!out.length) {
      // For code-related items
      const dom = toLowerSafe(domainOf(item) || "");
      const typ = toLowerSafe(typeOf(item) || "");
      if (
        intent.kind === "error" ||
        dom.includes("dev") ||
        typ.includes("doc")
      ) {
        out.push(
          "Vite build output",
          "Browser console",
          "Project search (Find in files)"
        );
      }
    }

    return uniq(out).slice(0, cfg.maxTools);
  }

  _linksFor(item, extracted, cfg) {
    const links = Array.isArray(extracted.links) ? extracted.links : [];
    const out = [];

    for (let i = 0; i < links.length && out.length < cfg.maxLinks; i++) {
      const l = links[i];
      if (!l || !l.url) continue;
      out.push({ label: l.label || "Link", url: String(l.url) });
    }

    return out;
  }

  /* -------------------------------------------------------------------------
   * Suggestions (follow-ups + refinements)
   * ---------------------------------------------------------------------- */

  _suggestionsForEmpty() {
    return {
      followUps: [
        "What are you trying to do?",
        "Where are you in the app (page/module)?",
        "Any error message or example?",
      ],
      refinements: [
        "Add a domain (cooking/cleaning/garden/etc.)",
        "Add tags (e.g., 'inventory', 'Dexie', 'meal planning')",
      ],
    };
  }

  _suggestions(query, intent, cards, cfg) {
    const followUps = [];
    const refinements = [];

    if (!cards.length) {
      followUps.push(
        "Share a bit more detail (what you expect to happen vs what happens).",
        "If this is an error, paste the full error + stack trace.",
        "If this is a task, what’s the desired outcome and constraints?"
      );
      refinements.push(
        "Try adding a domain (e.g., cooking, cleaning, dev)",
        "Add a couple of keywords you expect to appear"
      );
      return { followUps, refinements };
    }

    // Intent-aware suggestions
    if (intent.kind === "error") {
      followUps.push(
        "Which file path and line number is the error pointing to?",
        "What changed right before the error started happening?",
        "Is this failing in dev only, or also in `npm run build`?"
      );
      refinements.push(
        "Add the module name you’re importing from",
        "Include the exact import line"
      );
    } else if (intent.kind === "compare") {
      followUps.push(
        "What are the two things you want to compare?",
        "What matters most: speed, cost, simplicity, quality?"
      );
      refinements.push(
        "Add criteria keywords (e.g., 'offline', 'Dexie', 'Vite')",
        "Specify the domain (meal planning vs knowledge)"
      );
    } else if (intent.kind === "goal") {
      followUps.push(
        "What’s your timeframe and what does ‘done’ look like?",
        "Any constraints (budget, equipment, dietary, etc.)?"
      );
      refinements.push("Add constraints keywords", "Add preferred tags");
    } else if (intent.kind === "howto") {
      followUps.push(
        "What step are you stuck on?",
        "What tools/materials do you already have?"
      );
      refinements.push(
        "Add your current step",
        "Add your environment (browser, device, module)"
      );
    } else {
      followUps.push(
        "What’s the context (page/module) for this question?",
        "Do you want a quick answer or step-by-step guidance?"
      );
      refinements.push(
        "Add a domain",
        "Add 1–2 example phrases you’d search for"
      );
    }

    // If many results are same pool, suggest expanding
    const poolCounts = new Map();
    for (let i = 0; i < cards.length; i++) {
      const k = cards[i].poolKey || "other";
      poolCounts.set(k, (poolCounts.get(k) || 0) + 1);
    }
    const maxPool = Array.from(poolCounts.entries()).sort(
      (a, b) => b[1] - a[1]
    )[0];
    if (maxPool && maxPool[1] >= Math.max(4, Math.floor(cards.length * 0.7))) {
      refinements.push(
        "Try enabling additional pools (docs, SOPs, KB notes) for broader coverage."
      );
    }

    // If query is long, suggest focusing
    if (query.length >= 160)
      refinements.push("Try a shorter query with only the key nouns/verbs.");

    return {
      followUps: uniq(followUps).slice(0, 6),
      refinements: uniq(refinements).slice(0, 6),
    };
  }
}

/* -----------------------------------------------------------------------------
 * Convenience factory
 * -------------------------------------------------------------------------- */

export function createHelperComposer(options = {}) {
  return new HelperComposer(options);
}

export default HelperComposer;

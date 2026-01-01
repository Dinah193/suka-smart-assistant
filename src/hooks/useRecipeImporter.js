// useRecipeImporter.js
// [NEW] Orchestrates URL → extract → normalize → stage (and optionally save)
// ES2015-safe, dependency-light, defensive DI

import { useRef, useState, useCallback, useMemo } from "react";

/**
 * createRecipeImporter
 * Factory enabling optional dependency injection. All deps are optional and safely no-op.
 *
 * @param {Object} deps
 *  - fetcher: { get(url, {signal}): Promise<string|Response> }
 *  - extractors: {
 *      fromJsonLd?(html:string, url:string): object|null,
 *      fromMicrodata?(html:string, url:string): object|null,
 *      fromOpengraph?(html:string, url:string): object|null,
 *      fromReadable?(html:string, url:string): object|null,     // cheerio/readability style
 *      fallback?(html:string, url:string): object|null          // last resort
 *    }
 *  - normalizer: {
 *      normalize(recipeRaw, opts?): {
 *        title, source, url, author, yield, time:{prep, cook, total},
 *        ingredients:[{name, qty, unit, note?}],
 *        steps:[{label, minutes?, type?}],
 *        images?:string[], cuisine?, course?, appliances?, primaryProtein?,
 *        leftoverPolicy?, safeTempF?, totalTimeMinutes?
 *      }
 *    }
 *  - autoClassifier: { inferTags?(normalized): { cuisine, course, effort, appliances, flags?:string[] } }
 *  - deduper: { fingerprint?(normalized): string, findMatch?(fp:string): {id, similarity} | null }
 *  - versionPicker: { open?(duplicateInfo): Promise<"keep_both"|"replace"|"skip"> }
 *  - libraryStore: {
 *      stageDraft?(draft): { id:string },
 *      saveRecipe?(draft): { id:string },
 *      autosaveDraft?(partialDraft): void,
 *      existsByUrl?(url:string): string|null, // returns recipeId
 *    }
 *  - collections: { addToCollections?(recipeId:string, collectionIds:string[]):void }
 *  - media: { downloadImages?(urls:string[], originUrl:string): Promise<string[]> } // returns stored URLs
 *  - scheduleHelpers: {
 *      needsDefrost?(recipe): boolean,
 *      needsMarinade?(recipe): boolean,
 *      preheatSpec?(appliance, recipe): { temp:number, minutes:number } | null
 *    }
 *  - estimateEngine: { cost?(recipe): { total:number, currency:string, perServing:number } }
 *  - analytics: { track(evt, payload):void }
 *  - eventBus: { emit(evt, payload):void }
 *
 * Notes:
 * - You can pass nothing; everything gracefully degrades.
 */
export function createRecipeImporter(deps = {}) {
  const fetcher = deps.fetcher || {
    get: function (url, { signal } = {}) {
      return fetch(url, { signal }).then((r) => r.text());
    },
  };

  const extractors = deps.extractors || {};
  const normalizer = deps.normalizer || {
    normalize: function (raw) {
      // Minimal pass-through fallback normalizer
      const title = (raw && (raw.title || raw.name)) || "Imported Recipe";
      const ingredients =
        (raw && raw.ingredients) ||
        (raw && raw.recipeIngredient) ||
        [];
      const steps = (raw && raw.instructions) || (raw && raw.recipeInstructions) || [];
      return {
        title,
        source: (raw && raw.source) || "",
        url: (raw && raw.url) || "",
        author: (raw && raw.author) || "",
        yield: (raw && (raw.yield || raw.recipeYield)) || "",
        time: {
          prep: Number(raw && raw.prepTimeMinutes) || 0,
          cook: Number(raw && raw.cookTimeMinutes) || 0,
          total: Number(raw && raw.totalTimeMinutes) || 0,
        },
        ingredients: (ingredients || []).map((x) => ({
          name: String(x).toLowerCase(),
          qty: 1,
          unit: "",
        })),
        steps: (Array.isArray(steps) ? steps : [{ label: String(steps) }]).map((s) =>
          typeof s === "string" ? { label: s } : s
        ),
        images: raw && raw.images ? raw.images : [],
        totalTimeMinutes:
          Number(raw && raw.totalTimeMinutes) ||
          Number(raw && raw.cookTimeMinutes) ||
          0,
      };
    },
  };

  const autoClassifier = deps.autoClassifier || { inferTags: function () { return {}; } };
  const deduper = deps.deduper || {
    fingerprint: function (n) {
      try {
        const base = (n.title || "") + "|" + (n.yield || "") + "|" + (n.ingredients || []).map((i) => i.name).join(",");
        let hash = 0;
        for (var i = 0; i < base.length; i++) {
          hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
        }
        return "fp_" + hash.toString(16);
      } catch (_e) { return "fp_" + Math.random().toString(36).slice(2); }
    },
    findMatch: function () { return null; },
  };

  const versionPicker = deps.versionPicker || { open: function () { return Promise.resolve("keep_both"); } };

  const libraryStore = deps.libraryStore || {
    stageDraft: function (draft) { return { id: "draft_" + Math.random().toString(36).slice(2) }; },
    saveRecipe: function (draft) { return { id: "r_" + Math.random().toString(36).slice(2) }; },
    autosaveDraft: function () {},
    existsByUrl: function () { return null; },
  };

  const collections = deps.collections || { addToCollections: function () {} };
  const media = deps.media || { downloadImages: function (urls) { return Promise.resolve(urls || []); } };
  const scheduleHelpers = deps.scheduleHelpers || {
    needsDefrost: function () { return false; },
    needsMarinade: function () { return false; },
    preheatSpec: function () { return null; },
  };
  const estimateEngine = deps.estimateEngine || { cost: function () { return null; } };
  const analytics = deps.analytics || { track: function () {} };
  const eventBus = deps.eventBus || { emit: function () {} };

  // ——— Extraction pipeline helpers ———————————————————————————————————————————

  function parseJsonLd(html) {
    try {
      if (!extractors.fromJsonLd) return null;
      return extractors.fromJsonLd(html);
    } catch (_e) { return null; }
  }

  function parseMicrodata(html) {
    try {
      if (!extractors.fromMicrodata) return null;
      return extractors.fromMicrodata(html);
    } catch (_e) { return null; }
  }

  function parseOpenGraph(html, url) {
    try {
      if (!extractors.fromOpengraph) return null;
      return extractors.fromOpengraph(html, url);
    } catch (_e) { return null; }
  }

  function parseReadable(html, url) {
    try {
      if (!extractors.fromReadable) return null;
      return extractors.fromReadable(html, url);
    } catch (_e) { return null; }
  }

  function parseFallback(html, url) {
    try {
      if (!extractors.fallback) return null;
      return extractors.fallback(html, url);
    } catch (_e) { return null; }
  }

  function chooseFirstNonNull() {
    for (var i = 0; i < arguments.length; i++) {
      if (arguments[i]) return arguments[i];
    }
    return null;
  }

  // ——— Public orchestrator (non-hook) for testing/SSR ————————————————

  async function importOne(url, opts = {}) {
    const abort = new AbortController();
    const signal = abort.signal;
    const state = { status: "queued", url, error: null, result: null, draftId: null, recipeId: null, duplicateOf: null };
    const startedAt = Date.now();

    eventBus.emit("recipe:import:started", { url });

    // Short circuit if known by URL
    try {
      const existingId = libraryStore.existsByUrl(url);
      if (existingId) {
        state.status = "duplicate";
        state.duplicateOf = existingId;
        eventBus.emit("recipe:import:duplicate", { url, existingId, by: "url" });
        analytics.track("recipe/import/duplicate", { url, existingId, by: "url" });
        return state;
      }
    } catch (_e) {}

    // 1) FETCH
    state.status = "fetching";
    let html = "";
    try {
      const resp = await fetcher.get(url, { signal });
      html = typeof resp === "string" ? resp : await resp.text();
    } catch (e) {
      state.status = "error";
      state.error = "FETCH_ERROR";
      eventBus.emit("recipe:import:error", { url, kind: "fetch", message: String(e && e.message || e) });
      return state;
    }

    // 2) EXTRACT (multiple strategies; prefer JSON-LD)
    state.status = "extracting";
    let raw = null;
    try {
      raw = chooseFirstNonNull(
        parseJsonLd(html, url),
        parseMicrodata(html, url),
        parseOpenGraph(html, url),
        parseReadable(html, url),
        parseFallback(html, url)
      );
      if (!raw) throw new Error("No extractor succeeded");
    } catch (_e) {
      state.status = "error";
      state.error = "EXTRACTION_FAILED";
      eventBus.emit("recipe:import:error", { url, kind: "extract", message: "No extractor succeeded" });
      return state;
    }
    eventBus.emit("recipe:import:extracted", { url });

    // 3) NORMALIZE
    state.status = "normalizing";
    let normalized = null;
    try {
      normalized = normalizer.normalize(raw, { originUrl: url });
      if (!normalized || !normalized.title || !Array.isArray(normalized.ingredients)) {
        throw new Error("Normalization incomplete");
      }
      // basic source/url fill
      if (!normalized.url) normalized.url = url;
      if (!normalized.source) normalized.source = new URL(url).hostname.replace(/^www\./, "");
    } catch (_e) {
      state.status = "error";
      state.error = "NORMALIZE_FAILED";
      eventBus.emit("recipe:import:error", { url, kind: "normalize", message: "Normalization failed" });
      return state;
    }

    // 4) CLASSIFY (cuisine/course/effort/appliance/flags)
    let tags = {};
    try {
      tags = autoClassifier.inferTags(normalized) || {};
      normalized = Object.assign({}, normalized, tags);
    } catch (_e) {}

    // 5) IMAGE DOWNLOAD (optional)
    try {
      if (normalized.images && normalized.images.length) {
        const stored = await media.downloadImages(normalized.images, url);
        if (stored && stored.length) normalized.images = stored;
      }
    } catch (_e) { /* ignore */ }

    // 6) DEDUPE (content-based)
    let fp = "";
    try { fp = deduper.fingerprint(normalized); } catch (_e) { fp = ""; }
    let match = null;
    try { match = fp ? deduper.findMatch(fp) : null; } catch (_e) { match = null; }

    if (match && match.id) {
      // Resolve via Version Picker
      eventBus.emit("recipe:import:duplicate", { url, existingId: match.id, by: "fingerprint", similarity: match.similarity });
      analytics.track("recipe/import/duplicate", { url, by: "fingerprint", similarity: match.similarity });
      const decision = await versionPicker.open({
        url,
        incoming: normalized,
        existingId: match.id,
        similarity: match.similarity,
      });
      if (decision === "skip") {
        state.status = "duplicate";
        state.duplicateOf = match.id;
        return state;
      }
      // For "replace" or "keep_both", proceed to stage/save; store decision in meta:
      normalized.meta = Object.assign({}, normalized.meta || {}, { duplicateResolution: decision, duplicateOf: match.id });
    }

    // 7) HINTS (defrost/marinade/preheat) + COST
    try {
      normalized.hints = {
        needsDefrost: !!scheduleHelpers.needsDefrost(normalized),
        needsMarinade: !!scheduleHelpers.needsMarinade(normalized),
        preheat: (normalized.appliances && normalized.appliances.length)
          ? (scheduleHelpers.preheatSpec(normalized.appliances[0], normalized) || null)
          : null,
      };
    } catch (_e) {}
    try {
      const cost = estimateEngine.cost(normalized);
      if (cost) normalized.cost = cost;
    } catch (_e) {}

    // 8) STAGE (draft) — autosave in real-time (per your Recipe Scanner behavior)
    state.status = "staging";
    let draftId = null;
    try {
      // Autosave draft shell for immediate UI availability
      libraryStore.autosaveDraft({
        title: normalized.title,
        url: normalized.url,
        source: normalized.source,
        images: normalized.images || [],
        tags,
        // minimal ingredients/steps to render fast in UI while we save
        ingredients: normalized.ingredients,
        steps: normalized.steps,
        hints: normalized.hints || {},
        cost: normalized.cost || null,
      });
      const draftRes = libraryStore.stageDraft(Object.assign({}, normalized, { fingerprint: fp, stagedAt: new Date().toISOString() }));
      draftId = draftRes && draftRes.id;
      state.draftId = draftId || null;
    } catch (_e) {
      // staging is non-fatal; continue to save if possible
    }
    eventBus.emit("recipe:import:staged", { url, draftId });

    // 9) SAVE (optional immediate save)
    if (opts.autoSave !== false) {
      state.status = "saving";
      try {
        const saveRes = libraryStore.saveRecipe(Object.assign({}, normalized, { draftId }));
        state.recipeId = saveRes && saveRes.id;
        state.status = "saved";
        eventBus.emit("recipe:import:finalized", { url, recipeId: state.recipeId });
      } catch (_e) {
        // If save fails, keep staged draft
        state.status = "staged";
      }
    } else {
      state.status = "staged";
    }

    state.result = normalized;

    // 10) Collections (optional)
    try {
      if (opts.collectionIds && state.recipeId) {
        collections.addToCollections(state.recipeId, opts.collectionIds);
      }
    } catch (_e) {}

    analytics.track("recipe/import/done", {
      url,
      status: state.status,
      ms: Date.now() - startedAt,
      saved: !!state.recipeId,
      duplicateOf: state.duplicateOf || null,
      source: normalized.source,
    });

    return state;
  }

  return { importOne };
}

// ——— React hook wrapper ————————————————————————————————————————————————

/**
 * useRecipeImporter
 * Hook that wraps createRecipeImporter for UI usage:
 * - Handles batch imports
 * - Tracks per-item progress & global progress
 * - Exposes cancel & retry
 * - Emits NBA prep candidates where possible
 */
export default function useRecipeImporter(deps = {}) {
  const importerRef = useRef(null);
  if (!importerRef.current) importerRef.current = createRecipeImporter(deps);

  const [queue, setQueue] = useState([]); // [{url, status, error, draftId, recipeId, duplicateOf, result}]
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ total: 0, done: 0 });
  const [lastError, setLastError] = useState(null);

  const reset = useCallback(() => {
    setQueue([]);
    setRunning(false);
    setProgress({ total: 0, done: 0 });
    setLastError(null);
  }, []);

  const importFromUrl = useCallback(async (url, opts = {}) => {
    setRunning(true);
    setQueue((prev) => prev.concat([{ url, status: "queued", error: null, draftId: null, recipeId: null, duplicateOf: null, result: null }]));
    setProgress((p) => ({ total: p.total + 1, done: p.done }));

    try {
      const res = await importerRef.current.importOne(url, opts);
      setQueue((prev) =>
        prev.map((it) => (it.url === url ? Object.assign({}, it, res) : it))
      );
      setProgress((p) => ({ total: p.total, done: p.done + 1 }));
      setRunning(false);
      return res;
    } catch (e) {
      const err = String(e && e.message) || "IMPORT_FAILED";
      setLastError(err);
      setQueue((prev) =>
        prev.map((it) => (it.url === url ? Object.assign({}, it, { status: "error", error: err }) : it))
      );
      setProgress((p) => ({ total: p.total, done: p.done + 1 }));
      setRunning(false);
      return { status: "error", error: err, url };
    }
  }, []);

  const importMany = useCallback(async (urls, opts = {}) => {
    if (!urls || !urls.length) return [];
    setRunning(true);
    setQueue((prev) =>
      prev.concat(
        urls.map((u) => ({ url: u, status: "queued", error: null, draftId: null, recipeId: null, duplicateOf: null, result: null }))
      )
    );
    setProgress((p) => ({ total: p.total + urls.length, done: p.done }));

    const results = [];
    for (let i = 0; i < urls.length; i++) {
      // Sequential on purpose to avoid CORS/anti-bot triggers; could batch with small concurrency if needed
      // Consider exponential backoff on 429 later.
      /* eslint-disable no-await-in-loop */
      const r = await importerRef.current.importOne(urls[i], opts);
      /* eslint-enable no-await-in-loop */
      results.push(r);
      setQueue((prev) =>
        prev.map((it) => (it.url === urls[i] ? Object.assign({}, it, r) : it))
      );
      setProgress((p) => ({ total: p.total, done: p.done + 1 }));
    }
    setRunning(false);
    return results;
  }, []);

  const retry = useCallback(async (url, opts = {}) => {
    setQueue((prev) =>
      prev.map((it) => (it.url === url ? Object.assign({}, it, { status: "queued", error: null }) : it))
    );
    return importFromUrl(url, opts);
  }, [importFromUrl]);

  const removeFromQueue = useCallback((url) => {
    setQueue((prev) => prev.filter((it) => it.url !== url));
  }, []);

  const summary = useMemo(() => {
    const total = queue.length;
    const done = queue.filter((q) => ["saved", "staged", "duplicate", "error"].indexOf(q.status) >= 0).length;
    const errors = queue.filter((q) => q.status === "error").length;
    const duplicates = queue.filter((q) => q.status === "duplicate").length;
    return { total, done, errors, duplicates, running };
  }, [queue, running]);

  return {
    // Actions
    importFromUrl,
    importMany,
    retry,
    removeFromQueue,
    reset,
    // State
    queue,
    running,
    progress,
    summary,
    lastError,
  };
}

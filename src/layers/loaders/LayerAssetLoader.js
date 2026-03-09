// src/layers/loaders/LayerAssetLoader.js
// SSA LayerAssetLoader (Foundations)
// Loads catalogs + lexicons, validates them, caches them, and exposes query helpers.
//
// Goals:
// - Vite-friendly loading (import.meta.glob / dynamic import) and an optional fetch mode.
// - Validation aligned to your lexicon action constraints:
//     boostMethodKey | downrankMethodKey | blockMethodKey | addNote | addWarning | emitHintTag
// - Structured errors with JSON-pointer-like paths for fast debugging.
// - In-memory indexes: patterns by id/domain/intentTag/culture/season + lexicon phrase index.
// - Optional dev refresh().
//
// IMPORTANT:
// - This loader is pure in-memory. Persistence to Dexie is handled elsewhere in the fixed-layer spine.
// - Avoid heavy deps. If you later want full JSON-Schema validation, add Ajv behind a try/catch.

import {
  LEXICON_FILES,
  CATALOG_FILES,
  CATALOG_DISCOVERY,
  REGISTRY_META,
} from "../registry/index.js";

const ACTION_TYPES = new Set([
  "boostMethodKey",
  "downrankMethodKey",
  "blockMethodKey",
  "addNote",
  "addWarning",
  "emitHintTag",
]);

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .trim();
}

function jsonPtr(pathParts) {
  return (
    "/" +
    pathParts
      .map((p) => String(p).replace(/~/g, "~0").replace(/\//g, "~1"))
      .join("/")
  );
}

function err(file, ptr, code, message, extra = {}) {
  return {
    file,
    path: ptr,
    code,
    message,
    ...extra,
  };
}

// -----------------------------
// Validation (lightweight, SSA-aligned)
// -----------------------------

function validateLexicon(obj, file) {
  const errors = [];

  if (!isObj(obj))
    return [
      err(file, "", "LEXICON_NOT_OBJECT", "Lexicon must be a JSON object."),
    ];

  // Enforce allowed top-level keys
  const allowedTop = new Set([
    "meta",
    "methods",
    "synonyms",
    "phrases",
    "rules",
    "actions",
    "signals",
  ]);
  Object.keys(obj).forEach((k) => {
    if (!allowedTop.has(k)) {
      errors.push(
        err(
          file,
          jsonPtr([k]),
          "LEXICON_TOPLEVEL_KEY",
          `Top-level key "${k}" is not allowed.`
        )
      );
    }
  });

  // meta
  if (!isObj(obj.meta))
    errors.push(err(file, "/meta", "LEXICON_META", "meta must be an object."));
  else {
    if (!obj.meta.id)
      errors.push(
        err(file, "/meta/id", "LEXICON_META_ID", "meta.id is required.")
      );
    if (!obj.meta.domain)
      errors.push(
        err(
          file,
          "/meta/domain",
          "LEXICON_META_DOMAIN",
          "meta.domain is required."
        )
      );
    if (!obj.meta.version)
      errors.push(
        err(
          file,
          "/meta/version",
          "LEXICON_META_VERSION",
          "meta.version is required."
        )
      );
  }

  // methods
  if (!isObj(obj.methods))
    errors.push(
      err(file, "/methods", "LEXICON_METHODS", "methods must be an object.")
    );
  else {
    for (const [methodKey, def] of Object.entries(obj.methods)) {
      if (!isObj(def)) {
        errors.push(
          err(
            file,
            jsonPtr(["methods", methodKey]),
            "LEXICON_METHOD_DEF",
            "Method definition must be an object."
          )
        );
        continue;
      }
      if (!def.label)
        errors.push(
          err(
            file,
            jsonPtr(["methods", methodKey, "label"]),
            "LEXICON_METHOD_LABEL",
            "Method label is required."
          )
        );
    }
  }

  // synonyms
  if (obj.synonyms !== undefined) {
    if (!isObj(obj.synonyms))
      errors.push(
        err(
          file,
          "/synonyms",
          "LEXICON_SYNONYMS",
          "synonyms must be an object."
        )
      );
    else {
      for (const [phrase, v] of Object.entries(obj.synonyms)) {
        if (!isObj(v)) {
          errors.push(
            err(
              file,
              jsonPtr(["synonyms", phrase]),
              "LEXICON_SYNONYM_DEF",
              "Synonym entry must be an object."
            )
          );
          continue;
        }
        if (!Array.isArray(v.methodIds) || v.methodIds.length === 0) {
          errors.push(
            err(
              file,
              jsonPtr(["synonyms", phrase, "methodIds"]),
              "LEXICON_SYNONYM_METHODIDS",
              "methodIds must be a non-empty array."
            )
          );
        } else {
          v.methodIds.forEach((id, idx) => {
            if (typeof id !== "string" || !id.trim()) {
              errors.push(
                err(
                  file,
                  jsonPtr(["synonyms", phrase, "methodIds", idx]),
                  "LEXICON_METHODID",
                  "methodIds entries must be non-empty strings."
                )
              );
            }
          });
        }
      }
    }
  }

  // phrases
  if (obj.phrases !== undefined) {
    if (!Array.isArray(obj.phrases))
      errors.push(
        err(file, "/phrases", "LEXICON_PHRASES", "phrases must be an array.")
      );
    else {
      obj.phrases.forEach((p, idx) => {
        if (!isObj(p)) {
          errors.push(
            err(
              file,
              jsonPtr(["phrases", idx]),
              "LEXICON_PHRASE",
              "Phrase entry must be an object."
            )
          );
          return;
        }
        if (!p.text)
          errors.push(
            err(
              file,
              jsonPtr(["phrases", idx, "text"]),
              "LEXICON_PHRASE_TEXT",
              "text is required."
            )
          );
        if (!Array.isArray(p.methodIds) || p.methodIds.length === 0) {
          errors.push(
            err(
              file,
              jsonPtr(["phrases", idx, "methodIds"]),
              "LEXICON_PHRASE_METHODIDS",
              "methodIds must be a non-empty array."
            )
          );
        } else {
          p.methodIds.forEach((id, j) => {
            if (typeof id !== "string" || !id.trim()) {
              errors.push(
                err(
                  file,
                  jsonPtr(["phrases", idx, "methodIds", j]),
                  "LEXICON_METHODID",
                  "methodIds entries must be non-empty strings."
                )
              );
            }
          });
        }
      });
    }
  }

  // rules / actions (SSA lexicon action constraints)
  const checkAction = (a, ptrBase) => {
    if (!isObj(a)) {
      errors.push(
        err(file, ptrBase, "LEXICON_ACTION", "Action must be an object.")
      );
      return;
    }
    if (!ACTION_TYPES.has(a.type)) {
      errors.push(
        err(
          file,
          ptrBase + "/type",
          "LEXICON_ACTION_TYPE",
          `Invalid action type: ${String(a.type)}.`
        )
      );
    }
  };

  if (obj.rules !== undefined) {
    if (!Array.isArray(obj.rules))
      errors.push(
        err(file, "/rules", "LEXICON_RULES", "rules must be an array.")
      );
    else {
      obj.rules.forEach((r, idx) => {
        if (!isObj(r)) {
          errors.push(
            err(
              file,
              jsonPtr(["rules", idx]),
              "LEXICON_RULE",
              "Rule must be an object."
            )
          );
          return;
        }
        if (!r.id)
          errors.push(
            err(
              file,
              jsonPtr(["rules", idx, "id"]),
              "LEXICON_RULE_ID",
              "Rule id is required."
            )
          );
        if (!isObj(r.when))
          errors.push(
            err(
              file,
              jsonPtr(["rules", idx, "when"]),
              "LEXICON_RULE_WHEN",
              "when must be an object."
            )
          );
        if (!Array.isArray(r.then))
          errors.push(
            err(
              file,
              jsonPtr(["rules", idx, "then"]),
              "LEXICON_RULE_THEN",
              "then must be an array of actions."
            )
          );
        else {
          r.then.forEach((a, j) =>
            checkAction(a, jsonPtr(["rules", idx, "then", j]))
          );
        }
      });
    }
  }

  if (obj.actions !== undefined) {
    if (!Array.isArray(obj.actions))
      errors.push(
        err(file, "/actions", "LEXICON_ACTIONS", "actions must be an array.")
      );
    else obj.actions.forEach((a, i) => checkAction(a, jsonPtr(["actions", i])));
  }

  // signals
  if (obj.signals !== undefined) {
    if (!Array.isArray(obj.signals))
      errors.push(
        err(file, "/signals", "LEXICON_SIGNALS", "signals must be an array.")
      );
    else {
      obj.signals.forEach((s, idx) => {
        if (!isObj(s)) {
          errors.push(
            err(
              file,
              jsonPtr(["signals", idx]),
              "LEXICON_SIGNAL",
              "Signal must be an object."
            )
          );
          return;
        }
        if (!s.id)
          errors.push(
            err(
              file,
              jsonPtr(["signals", idx, "id"]),
              "LEXICON_SIGNAL_ID",
              "Signal id is required."
            )
          );
        if (!s.type)
          errors.push(
            err(
              file,
              jsonPtr(["signals", idx, "type"]),
              "LEXICON_SIGNAL_TYPE",
              "Signal type is required."
            )
          );
        if (!s.pattern)
          errors.push(
            err(
              file,
              jsonPtr(["signals", idx, "pattern"]),
              "LEXICON_SIGNAL_PATTERN",
              "Signal pattern is required."
            )
          );
      });
    }
  }

  return errors;
}

function validateCatalogPattern(obj, file) {
  const errors = [];
  if (!isObj(obj))
    return [
      err(file, "", "CATALOG_NOT_OBJECT", "Catalog must be a JSON object."),
    ];

  // Allow index.json lists (catalog index files)
  const isIndex =
    file.endsWith("/index.json") && isObj(obj) && Array.isArray(obj.patterns);
  if (isIndex) return errors;

  const required = [
    "id",
    "domain",
    "kind",
    "title",
    "intentTags",
    "inputs",
    "outputs",
    "constraints",
    "steps",
    "kpis",
  ];
  required.forEach((k) => {
    if (obj[k] === undefined)
      errors.push(
        err(
          file,
          jsonPtr([k]),
          "CATALOG_REQUIRED",
          `Missing required field: ${k}`
        )
      );
  });

  if (obj.intentTags !== undefined && !Array.isArray(obj.intentTags))
    errors.push(
      err(
        file,
        "/intentTags",
        "CATALOG_INTENTTAGS",
        "intentTags must be an array."
      )
    );
  if (obj.steps !== undefined && !Array.isArray(obj.steps))
    errors.push(
      err(file, "/steps", "CATALOG_STEPS", "steps must be an array.")
    );
  if (obj.kpis !== undefined && !Array.isArray(obj.kpis))
    errors.push(err(file, "/kpis", "CATALOG_KPIS", "kpis must be an array."));

  // Variants
  if (obj.variants !== undefined) {
    if (!Array.isArray(obj.variants))
      errors.push(
        err(file, "/variants", "CATALOG_VARIANTS", "variants must be an array.")
      );
    else {
      obj.variants.forEach((v, idx) => {
        if (!isObj(v))
          return errors.push(
            err(
              file,
              jsonPtr(["variants", idx]),
              "CATALOG_VARIANT",
              "variant must be an object."
            )
          );
        if (!v.id)
          errors.push(
            err(
              file,
              jsonPtr(["variants", idx, "id"]),
              "CATALOG_VARIANT_ID",
              "variant.id is required."
            )
          );
        if (!isObj(v.when))
          errors.push(
            err(
              file,
              jsonPtr(["variants", idx, "when"]),
              "CATALOG_VARIANT_WHEN",
              "variant.when must be an object."
            )
          );
        if (!isObj(v.overrides))
          errors.push(
            err(
              file,
              jsonPtr(["variants", idx, "overrides"]),
              "CATALOG_VARIANT_OVERRIDES",
              "variant.overrides must be an object."
            )
          );
      });
    }
  }

  // Lean block
  if (obj.lean !== undefined && !isObj(obj.lean))
    errors.push(err(file, "/lean", "CATALOG_LEAN", "lean must be an object."));
  // UI hints
  if (obj.ui !== undefined && !isObj(obj.ui))
    errors.push(err(file, "/ui", "CATALOG_UI", "ui must be an object."));

  return errors;
}

// -----------------------------
// Index building
// -----------------------------

function buildLexiconIndex(lexicon) {
  // phrase -> match entries (from synonyms + phrases)
  const phraseIndex = new Map(); // phraseNorm -> {methodIds, boost, source}
  const add = (phrase, entry, source) => {
    const key = norm(phrase);
    if (!key) return;
    const cur = phraseIndex.get(key) || [];
    cur.push({ phrase: phrase, ...entry, source });
    phraseIndex.set(key, cur);
  };

  if (isObj(lexicon.synonyms)) {
    for (const [phrase, entry] of Object.entries(lexicon.synonyms))
      add(phrase, entry, "synonyms");
  }
  if (Array.isArray(lexicon.phrases)) {
    lexicon.phrases.forEach((p) => add(p.text, p, "phrases"));
  }

  return phraseIndex;
}

function classifyVariant(whenObj) {
  // Convention: variants.when may include tags/anyTags/cultureTags/seasonTags/householdMode
  const when = whenObj || {};
  const culture = [];
  const season = [];
  const mode = [];

  const pushTags = (arr, v) => {
    if (Array.isArray(v)) v.forEach((t) => arr.push(String(t)));
    else if (typeof v === "string") arr.push(v);
  };

  pushTags(culture, when.cultureTags);
  pushTags(season, when.seasonTags);
  pushTags(mode, when.householdMode);

  // Also parse generic tag lists
  if (Array.isArray(when.anyTags)) {
    when.anyTags.forEach((t) => {
      const s = String(t);
      if (s.startsWith("culture:")) culture.push(s);
      if (s.startsWith("season:")) season.push(s);
      if (s.startsWith("mode:")) mode.push(s);
    });
  }

  return {
    cultureTags: Array.from(new Set(culture)),
    seasonTags: Array.from(new Set(season)),
    modeTags: Array.from(new Set(mode)),
  };
}

// -----------------------------
// Loader
// -----------------------------

export class LayerAssetLoader {
  constructor(opts = {}) {
    this.opts = {
      strict: true,
      mode: "import", // "import" | "fetch"
      baseUrl: "/", // used for fetch mode
      devHotReload: false,
      ...opts,
    };

    this._loaded = false;
    this._lastLoadedAt = null;

    this.lexicons = [];
    this.catalogs = [];
    this.errors = [];

    this.index = {
      lexiconById: new Map(),
      lexiconByDomain: new Map(),
      lexiconPhraseIndexById: new Map(),

      patternById: new Map(),
      patternsByDomain: new Map(),
      patternsByIntentTag: new Map(),
      patternsByCultureTag: new Map(),
      patternsBySeasonTag: new Map(),
    };
  }

  get meta() {
    return REGISTRY_META;
  }

  async loadAll({ force = false } = {}) {
    if (this._loaded && !force) return this.snapshot();

    this.errors = [];
    this.lexicons = [];
    this.catalogs = [];
    this.index = {
      lexiconById: new Map(),
      lexiconByDomain: new Map(),
      lexiconPhraseIndexById: new Map(),
      patternById: new Map(),
      patternsByDomain: new Map(),
      patternsByIntentTag: new Map(),
      patternsByCultureTag: new Map(),
      patternsBySeasonTag: new Map(),
    };

    const lexiconObjs = await this._loadJsonList(LEXICON_FILES);
    const catalogObjs = await this._loadJsonList(
      await this._expandCatalogFiles()
    );

    // Validate + index lexicons
    for (const item of lexiconObjs) {
      const errs = validateLexicon(item.data, item.file);
      if (errs.length) this.errors.push(...errs);

      if (!errs.length || !this.opts.strict) {
        const lex = item.data;
        this.lexicons.push(lex);

        const id = lex?.meta?.id || item.file;
        const domain = lex?.meta?.domain || "unknown";
        this.index.lexiconById.set(id, lex);
        this.index.lexiconByDomain.set(domain, lex);

        const phraseIndex = buildLexiconIndex(lex);
        this.index.lexiconPhraseIndexById.set(id, phraseIndex);
      }
    }

    // Validate + index catalogs (index.json allowed)
    for (const item of catalogObjs) {
      const errs = validateCatalogPattern(item.data, item.file);
      if (errs.length) this.errors.push(...errs);

      if (!errs.length || !this.opts.strict) {
        const obj = item.data;
        const isIndex =
          item.file.endsWith("/index.json") &&
          isObj(obj) &&
          Array.isArray(obj.patterns);
        if (isIndex) {
          this.catalogs.push({ __type: "index", __file: item.file, ...obj });
          continue;
        }

        this.catalogs.push(obj);
        this._indexPattern(obj, item.file);
      }
    }

    this._loaded = true;
    this._lastLoadedAt = new Date().toISOString();

    return this.snapshot();
  }

  snapshot() {
    return {
      ok: this.errors.length === 0,
      loaded: this._loaded,
      loadedAt: this._lastLoadedAt,
      meta: this.meta,
      counts: {
        lexicons: this.lexicons.length,
        catalogs: this.catalogs.length,
        patterns: this.index.patternById.size,
      },
      errors: this.errors.slice(),
    };
  }

  // --- Query helpers ---
  getLexicon(nameOrDomain) {
    if (!this._loaded)
      throw new Error("LayerAssetLoader not loaded. Call loadAll() first.");
    return (
      this.index.lexiconById.get(nameOrDomain) ||
      this.index.lexiconByDomain.get(nameOrDomain) ||
      null
    );
  }

  getLexiconPhraseIndex(lexiconIdOrDomain) {
    const lex = this.getLexicon(lexiconIdOrDomain);
    if (!lex) return null;
    const id = lex?.meta?.id || lexiconIdOrDomain;
    return this.index.lexiconPhraseIndexById.get(id) || null;
  }

  getPattern(id) {
    if (!this._loaded)
      throw new Error("LayerAssetLoader not loaded. Call loadAll() first.");
    return this.index.patternById.get(id) || null;
  }

  searchCatalog({ domain, tags = [], constraints = [], text = "" } = {}) {
    if (!this._loaded)
      throw new Error("LayerAssetLoader not loaded. Call loadAll() first.");

    const pool = domain
      ? this.index.patternsByDomain.get(domain) || []
      : Array.from(this.index.patternById.values());
    const tagSet = new Set((tags || []).map(String));
    const constraintSet = new Set((constraints || []).map(String));
    const q = norm(text);

    const scoreText = (p) => {
      if (!q) return 0;
      const hay = norm(
        [p.title, p.description, ...(p.intentTags || [])].join(" ")
      );
      if (!hay) return 0;
      // token overlap score
      const qTok = new Set(q.split(/\s+/).filter(Boolean));
      const hTok = new Set(hay.split(/\s+/).filter(Boolean));
      let hit = 0;
      qTok.forEach((t) => {
        if (hTok.has(t)) hit += 1;
      });
      return qTok.size ? hit / qTok.size : 0;
    };

    return pool
      .filter((p) => {
        if (tagSet.size) {
          const its = new Set((p.intentTags || []).map(String));
          for (const t of tagSet) if (!its.has(t)) return false;
        }
        if (constraintSet.size) {
          const cs = new Set((p.constraints || []).map(String));
          for (const c of constraintSet) if (!cs.has(c)) return false;
        }
        return true;
      })
      .map((p) => ({ pattern: p, score: scoreText(p) }))
      .sort((a, b) => b.score - a.score);
  }

  // Optional dev refresh
  async refresh() {
    return this.loadAll({ force: true });
  }

  // --- Internal indexing ---
  _indexPattern(p, file) {
    if (!p?.id) return;

    this.index.patternById.set(p.id, p);

    const domain = p.domain || "unknown";
    if (!this.index.patternsByDomain.has(domain))
      this.index.patternsByDomain.set(domain, []);
    this.index.patternsByDomain.get(domain).push(p);

    (p.intentTags || []).forEach((t) => {
      const key = String(t);
      if (!this.index.patternsByIntentTag.has(key))
        this.index.patternsByIntentTag.set(key, []);
      this.index.patternsByIntentTag.get(key).push(p);
    });

    // Variants indexing by culture/season
    (p.variants || []).forEach((v) => {
      const cls = classifyVariant(v.when);
      cls.cultureTags.forEach((ct) => {
        if (!this.index.patternsByCultureTag.has(ct))
          this.index.patternsByCultureTag.set(ct, []);
        this.index.patternsByCultureTag
          .get(ct)
          .push({ patternId: p.id, variantId: v.id });
      });
      cls.seasonTags.forEach((st) => {
        if (!this.index.patternsBySeasonTag.has(st))
          this.index.patternsBySeasonTag.set(st, []);
        this.index.patternsBySeasonTag
          .get(st)
          .push({ patternId: p.id, variantId: v.id });
      });
    });
  }

  // --- File expansion ---
  async _expandCatalogFiles() {
    // IMPORTANT (Vite build constraint):
    // import.meta.glob() only allows *literal* glob strings at build time.
    // Building globs dynamically (from runtime variables) will fail with:
    //   [vite:import-glob] Invalid glob import syntax: Could only use literals
    //
    // Therefore, we keep catalog discovery deterministic by relying on:
    // 1) CATALOG_FILES (explicit registry list), and
    // 2) (optional) any pre-expanded lists your registry chooses to provide.
    //
    // If you later want automated discovery, add a build-time generated registry
    // file that contains a literal list of catalog JSON paths.

    const out = new Set(CATALOG_FILES);

    // Best-effort: allow registry to provide a pre-expanded list without using import.meta.glob here.
    try {
      const extra = CATALOG_DISCOVERY?.expandedFiles;
      if (Array.isArray(extra)) {
        extra.forEach((p) => out.add(String(p)));
      }
    } catch {
      // ignore
    }

    return Array.from(out);
  }

  // --- Loading ---
  async _loadJsonList(files) {
    const items = [];
    for (const file of files) {
      const loaded = await this._loadJson(file);
      if (loaded) items.push(loaded);
    }
    return items;
  }

  async _loadJson(file) {
    try {
      if (this.opts.mode === "fetch") {
        const url = new URL(
          file.replace(/^\//, ""),
          this.opts.baseUrl || window.location.origin
        ).toString();
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          this.errors.push(
            err(
              file,
              "",
              "LOAD_FAILED",
              `Fetch failed (${res.status}) for ${url}`
            )
          );
          return null;
        }
        const data = await res.json();
        return { file, data };
      }

      // Import mode (Vite). Use absolute from project root.
      const mod = await import(/* @vite-ignore */ `/${file}`);
      const data = mod?.default ?? mod;
      return { file, data };
    } catch (e) {
      this.errors.push(
        err(
          file,
          "",
          "LOAD_FAILED",
          `Failed to load JSON asset: ${String(e?.message || e)}`
        )
      );
      return null;
    }
  }
}

// ✅ Add a default export so `import LayerAssetLoader from ...` works.
export default LayerAssetLoader;

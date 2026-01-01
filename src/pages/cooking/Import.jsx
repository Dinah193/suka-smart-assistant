/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\cooking\Import.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * SSA Import Wizard — Cooking domain
 * ---------------------------------------------------------------------------
 * Purpose:
 *   URL/Text/File → Parse → Preview/Edit → Normalize → Link/Map → Save (Dexie)
 *   → Generate Session Draft (engine-safe fallback).
 *
 * Must not crash if optional modules are missing.
 */

/* -------------------------------------------------------------------------- */
/* Domain constant                                                            */
/* -------------------------------------------------------------------------- */

const DOMAIN = "cooking";

/* -------------------------------------------------------------------------- */
/* Data contracts (in-file schemas)                                           */
/* -------------------------------------------------------------------------- */

/**
 * ImportRaw (persisted to db.importRaw)
 * {
 *   id: string,
 *   domain: "cooking",
 *   createdAtISO: ISO,
 *   updatedAtISO: ISO,
 *   source: {
 *     kind: "url"|"text"|"file",
 *     url?: string,
 *     text?: string,        // may be truncated in UI, store full if desired
 *     filename?: string,
 *     mime?: string,
 *     size?: number
 *   },
 *   rawContent?: string,     // optional convenience copy of source text
 *   meta: { fingerprint?: string, notes?: string }
 * }
 *
 * ImportNormalized (persisted to db.importNormalized)
 * {
 *   id: string,
 *   rawId: string,
 *   domain: "cooking",
 *   createdAtISO: ISO,
 *   updatedAtISO: ISO,
 *   confidence: { overall:number, fields: Record<string, number> },
 *   extracted: { ...domainExtractedFields },     // parser output (post-edits applied)
 *   normalized: {
 *     kind: "recipe_import",
 *     title: string,
 *     summary?: string,
 *     servings?: number|null,
 *     time?: { prepMin?:number|null, cookMin?:number|null, totalMin?:number|null },
 *     ingredients: Array<{ name:string, qty?:number|null, unit?:string, note?:string }>,
 *     steps: Array<{ text:string, timerSec?:number|null, equipment?:string[] }>,
 *     equipment: string[],
 *     tags: string[],
 *     source?: { url?: string, author?: string }
 *   },
 *   edits: { patches: Array<{ ts: ISO, path: string, value: any }> },
 *   logs: Array<{ ts:ISO, level:"info"|"warn"|"error", msg:string, data?:any }>
 * }
 *
 * LinkMap (persisted to db.importLinkMaps)
 * {
 *   id: string,
 *   rawId: string,
 *   normId: string,
 *   domain: "cooking",
 *   createdAtISO: ISO,
 *   updatedAtISO: ISO,
 *   links: {
 *     inventory: Array<{ from:string, toId?:string|null, toName?:string, qty?:number|null, unit?:string, note?:string }>,
 *     equipment: Array<{ from:string, toId?:string|null, toName?:string, note?:string }>,
 *     tags: Array<{ from:string, to:string }>
 *   },
 *   meta: { notes?: string }
 * }
 */

/* -------------------------------------------------------------------------- */
/* Soft/defensive imports                                                     */
/* -------------------------------------------------------------------------- */

async function safeImport(path) {
  try {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const m = await import(/* @vite-ignore */ path);
    return m?.default ?? m;
  } catch (e) {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Optional modules (soft-import)                                             */
/* -------------------------------------------------------------------------- */

let featureFlags = {};
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  featureFlags =
    require("@/config/featureFlags.json")?.default ??
    require("@/config/featureFlags.json") ??
    {};
} catch {
  try {
    // eslint-disable-next-line global-require
    featureFlags = require("../../config/featureFlags.json")?.default ?? {};
  } catch {
    featureFlags = {};
  }
}

let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const eb1 = require("@/services/events/eventBus.js");
  eventBus = eb1?.default || eb1?.eventBus || eb1 || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("../../services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {
    eventBus = eventBus;
  }
}

let db = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const m = require("@/services/db.js");
  db = m?.db || m?.default || m;
} catch {
  try {
    // eslint-disable-next-line global-require
    const m2 = require("../../services/db");
    db = m2?.db || m2?.default || m2;
  } catch {
    db = null;
  }
}

/**
 * Parser (domain-specific): recipeParser.js
 * Expected: parse({url?, text?, file?}) => { extracted, confidence, logs }
 */
let recipeParser = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const p = require("@/import/parsers/recipeParser.js");
  recipeParser = p?.default || p;
} catch {
  recipeParser = null;
}

/**
 * Optional ImportNormalizer (if you have it)
 * Expected shape options:
 *  - normalizeCooking(extracted, ctx)
 *  - normalize({domain, extracted, ctx})
 */
let ImportNormalizer = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const n = require("@/import/normalizers/ImportNormalizer.js");
  ImportNormalizer = n?.default || n;
} catch {
  ImportNormalizer = null;
}

/**
 * Optional CookingSessionEngine
 * Expected:
 *  - createDraftFromImport({domain, normalized, links, ctx})
 *  - or createDraft(normalized, linkMap, ctx)
 */
let CookingSessionEngine = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const e = require("@/engines/cooking/CookingSessionEngine.js");
  CookingSessionEngine = e?.default || e;
} catch {
  CookingSessionEngine = null;
}

/* -------------------------------------------------------------------------- */
/* Domain-specific fallback parse + normalize                                 */
/* -------------------------------------------------------------------------- */

function sanitizeLine(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function splitLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Cooking fallback parse heuristics
 * - Tries to find:
 *   title (first non-empty line)
 *   ingredients section (lines after "Ingredients")
 *   steps section (lines after "Instructions"/"Directions"/"Steps")
 *   servings (simple "serves" / "yield" / "servings" patterns)
 *   equipment (rough extraction from common keywords)
 */
function fallbackParseCooking({ url, text, fileMeta }) {
  try {
    const inputText = String(text || "");
    const lines = splitLines(inputText);
    const title = sanitizeLine(
      lines[0] || (url ? `Recipe from ${url}` : "Imported Recipe")
    );

    let servings = null;
    const servingsMatch = inputText.match(
      /(servings|serves|yield)\s*[:\-]?\s*(\d{1,3})/i
    );
    if (servingsMatch) servings = Number(servingsMatch[2]);

    const idxIngredients = lines.findIndex((l) =>
      /^(ingredients?)\b[:\-]?$/i.test(l)
    );
    const idxSteps = lines.findIndex((l) =>
      /^(instructions|directions|steps|method)\b[:\-]?$/i.test(l)
    );

    const ingredientsLines =
      idxIngredients >= 0
        ? lines.slice(idxIngredients + 1, idxSteps >= 0 ? idxSteps : undefined)
        : [];

    const stepsLines = idxSteps >= 0 ? lines.slice(idxSteps + 1) : [];

    const ingredients = ingredientsLines
      .map((l) => sanitizeLine(l.replace(/^[•\-\*]\s*/, "")))
      .filter(Boolean)
      .slice(0, 200);

    const steps = stepsLines
      .map((l) => sanitizeLine(l.replace(/^\d+[\)\.]\s*/, "")))
      .filter(Boolean)
      .slice(0, 300);

    // crude equipment inference
    const eqSet = new Set();
    const eqHints = [
      "skillet",
      "pan",
      "pot",
      "oven",
      "baking sheet",
      "sheet pan",
      "slow cooker",
      "instant pot",
      "pressure cooker",
      "air fryer",
      "mixer",
      "whisk",
      "blender",
      "food processor",
      "knife",
      "cutting board",
      "thermometer",
      "grill",
    ];
    const hay = `${ingredients.join(" ")} ${steps.join(" ")}`.toLowerCase();
    eqHints.forEach((k) => {
      if (hay.includes(k)) eqSet.add(k);
    });

    const extracted = {
      title,
      summary: "",
      servings: Number.isFinite(servings) ? servings : null,
      ingredients,
      steps,
      equipment: Array.from(eqSet),
      url: url || "",
      sourceFile: fileMeta?.filename || "",
      notes: "",
    };

    const confidence = {
      overall: Math.max(
        0.35,
        Math.min(
          0.85,
          0.25 +
            (ingredients.length ? 0.25 : 0) +
            (steps.length ? 0.25 : 0) +
            (servings ? 0.05 : 0) +
            (extracted.equipment.length ? 0.05 : 0)
        )
      ),
      fields: {
        title: title ? 0.8 : 0.4,
        ingredients: ingredients.length ? 0.75 : 0.35,
        steps: steps.length ? 0.75 : 0.35,
        servings: servings ? 0.6 : 0.3,
        equipment: extracted.equipment.length ? 0.6 : 0.35,
      },
    };

    const logs = [
      {
        ts: nowIso(),
        level: "warn",
        msg: "Used fallback cooking parser (recipeParser unavailable or failed).",
        data: { url: url || null, file: fileMeta?.filename || null },
      },
    ];

    return { extracted, confidence, logs };
  } catch (e) {
    return {
      extracted: {
        title: url ? `Recipe from ${url}` : "Imported Recipe",
        summary: "",
        servings: null,
        ingredients: [],
        steps: [],
        equipment: [],
        url: url || "",
        sourceFile: fileMeta?.filename || "",
        notes: "",
      },
      confidence: { overall: 0.25, fields: {} },
      logs: [
        {
          ts: nowIso(),
          level: "error",
          msg: "Fallback parser failed but recovered with minimal output.",
          data: { error: String(e?.message || e) },
        },
      ],
    };
  }
}

function fallbackNormalizeCooking(extracted, patches = []) {
  const title = sanitizeLine(extracted?.title || "Imported Recipe");
  const ingredients = Array.isArray(extracted?.ingredients)
    ? extracted.ingredients
        .map((s) => sanitizeLine(s))
        .filter(Boolean)
        .slice(0, 300)
        .map((line) => {
          // very simple ingredient parse (keep original line as name)
          return { name: line, qty: null, unit: "", note: "" };
        })
    : [];

  const steps = Array.isArray(extracted?.steps)
    ? extracted.steps
        .map((s) => sanitizeLine(s))
        .filter(Boolean)
        .slice(0, 500)
        .map((text) => {
          // timer heuristic: look for "10 min", "1 hour"
          const m = text.match(
            /(\d+)\s*(sec|secs|second|seconds|min|mins|minute|minutes|hr|hrs|hour|hours)\b/i
          );
          let timerSec = null;
          if (m) {
            const n = Number(m[1]);
            const unit = (m[2] || "").toLowerCase();
            if (Number.isFinite(n)) {
              if (unit.startsWith("sec")) timerSec = n;
              else if (unit.startsWith("min")) timerSec = n * 60;
              else if (unit.startsWith("hr") || unit.startsWith("hour"))
                timerSec = n * 3600;
            }
          }
          return { text, timerSec, equipment: [] };
        })
    : [];

  const equipment = Array.isArray(extracted?.equipment)
    ? extracted.equipment.map((s) => sanitizeLine(s)).filter(Boolean)
    : [];

  const tags = [];
  if (equipment.some((e) => e.includes("oven"))) tags.push("baked");
  if (equipment.some((e) => e.includes("grill"))) tags.push("grilled");

  const servings =
    extracted?.servings == null ? null : Number(extracted.servings);

  return {
    kind: "recipe_import",
    title,
    summary: sanitizeLine(extracted?.summary || ""),
    servings: Number.isFinite(servings) ? servings : null,
    time: { prepMin: null, cookMin: null, totalMin: null },
    ingredients,
    steps,
    equipment,
    tags,
    source: { url: sanitizeLine(extracted?.url || "") },
    _patchesApplied: Array.isArray(patches) ? patches.length : 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Dexie helpers                                                              */
/* -------------------------------------------------------------------------- */

function hasImportTables(dbInstance) {
  try {
    return Boolean(
      dbInstance &&
        dbInstance.importRaw &&
        dbInstance.importNormalized &&
        dbInstance.importLinkMaps &&
        dbInstance.importLogs
    );
  } catch {
    return false;
  }
}

async function dexiePut(table, obj) {
  if (!table || typeof table.put !== "function") {
    throw new Error("Dexie table is not available (missing schema?)");
  }
  return table.put(obj);
}

/* -------------------------------------------------------------------------- */
/* Event helper                                                               */
/* -------------------------------------------------------------------------- */

function emit(type, payload) {
  try {
    if (eventBus && typeof eventBus.emit === "function") {
      eventBus.emit({ type, ...payload });
    }
  } catch (e) {
    if (import.meta?.env?.DEV) {
      console.warn("[Import] event emit failed", type, e);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* UI component                                                               */
/* -------------------------------------------------------------------------- */

const STEP_KEYS = [
  { key: "source", label: "1) Source" },
  { key: "parse", label: "2) Parse Preview" },
  { key: "edit", label: "3) Edit" },
  { key: "normalize", label: "4) Normalize" },
  { key: "link", label: "5) Link/Map" },
  { key: "save", label: "6) Save" },
];

export default function Import() {
  const [stepIndex, setStepIndex] = useState(0);

  // Source inputs
  const [sourceKind, setSourceKind] = useState("url"); // "url"|"text"|"file"
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceFile, setSourceFile] = useState(null);
  const [sourceFileText, setSourceFileText] = useState("");
  const [busy, setBusy] = useState(false);

  // Pipeline objects
  const [raw, setRaw] = useState(null); // ImportRaw
  const [parsed, setParsed] = useState(null); // { extracted, confidence, logs }
  const [extractedEdits, setExtractedEdits] = useState(null); // edited extracted object
  const [patches, setPatches] = useState([]); // [{ts,path,value}]
  const [normalized, setNormalized] = useState(null); // ImportNormalized (object)
  const [linkMap, setLinkMap] = useState(null); // LinkMap

  // Save state
  const [dirty, setDirty] = useState(false);
  const [lastSavedISO, setLastSavedISO] = useState(null);
  const [saveState, setSaveState] = useState({
    status: "idle", // "idle"|"saving"|"saved"|"error"
    error: "",
  });

  // Draft
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");

  // Logs (UI + persist)
  const [uiLogs, setUiLogs] = useState([]);

  const fileReaderAbortRef = useRef({ aborted: false });

  const canUseDb = useMemo(() => hasImportTables(db), [db]);
  const familyFundMode = Boolean(featureFlags?.familyFundMode === true);

  // Emit opened
  useEffect(() => {
    emit("import.page.opened", { domain: DOMAIN, ts: nowIso() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step = STEP_KEYS[stepIndex]?.key || "source";

  function pushLog(level, msg, data) {
    const entry = { ts: nowIso(), level, msg, data };
    setUiLogs((prev) => [entry, ...prev].slice(0, 200));
  }

  /* ------------------------------ Validation ------------------------------ */

  const stepValid = useMemo(() => {
    if (step === "source") {
      if (sourceKind === "url") return sanitizeLine(sourceUrl).length > 5;
      if (sourceKind === "text") return sanitizeLine(sourceText).length > 0;
      if (sourceKind === "file")
        return Boolean(sourceFile) && sanitizeLine(sourceFileText).length > 0;
      return false;
    }
    if (step === "parse") return Boolean(parsed?.extracted);
    if (step === "edit") return Boolean(extractedEdits);
    if (step === "normalize") return Boolean(normalized?.normalized);
    if (step === "link") return Boolean(linkMap?.links);
    if (step === "save")
      return (
        Boolean(raw?.id) && Boolean(normalized?.id) && Boolean(linkMap?.id)
      );
    return true;
  }, [
    step,
    sourceKind,
    sourceUrl,
    sourceText,
    sourceFile,
    sourceFileText,
    parsed,
    extractedEdits,
    normalized,
    linkMap,
    raw,
  ]);

  const nextDisabled = useMemo(() => busy || !stepValid, [busy, stepValid]);
  const prevDisabled = useMemo(
    () => busy || stepIndex === 0,
    [busy, stepIndex]
  );

  const goNext = useCallback(() => {
    setStepIndex((i) => Math.min(i + 1, STEP_KEYS.length - 1));
  }, []);

  const goPrev = useCallback(() => {
    setStepIndex((i) => Math.max(i - 1, 0));
  }, []);

  /* ------------------------------ Source build ---------------------------- */

  const receiveImport = useCallback(() => {
    const id = makeId("importRaw");
    const ts = nowIso();

    const source =
      sourceKind === "url"
        ? { kind: "url", url: sanitizeLine(sourceUrl) }
        : sourceKind === "text"
        ? { kind: "text", text: sourceText }
        : {
            kind: "file",
            filename: sourceFile?.name || "",
            mime: sourceFile?.type || "",
            size: sourceFile?.size || 0,
          };

    const rawContent =
      sourceKind === "url"
        ? "" // (URL content not fetched; parse heuristics may rely on pasted text; parser may fetch in future, but not here)
        : sourceKind === "text"
        ? String(sourceText || "")
        : String(sourceFileText || "");

    const obj = {
      id,
      domain: DOMAIN,
      createdAtISO: ts,
      updatedAtISO: ts,
      source,
      rawContent,
      meta: {},
    };

    setRaw(obj);
    setParsed(null);
    setExtractedEdits(null);
    setNormalized(null);
    setLinkMap(null);
    setDraft(null);
    setDraftError("");
    setPatches([]);
    setDirty(true);
    setLastSavedISO(null);
    setSaveState({ status: "idle", error: "" });
    setUiLogs([]);

    emit("import.received", {
      domain: DOMAIN,
      rawId: id,
      source:
        sourceKind === "url"
          ? { kind: "url", url: sanitizeLine(sourceUrl) }
          : { kind: sourceKind },
      ts,
    });

    pushLog("info", "Import received (raw created in memory).", {
      rawId: id,
      sourceKind,
    });
    return obj;
  }, [sourceKind, sourceUrl, sourceText, sourceFile, sourceFileText]);

  /* ------------------------------ Parse ----------------------------------- */

  const runParse = useCallback(async () => {
    setBusy(true);
    setDraft(null);
    setDraftError("");

    const currentRaw = raw || receiveImport();
    const ts = nowIso();

    const url =
      currentRaw?.source?.kind === "url"
        ? currentRaw?.source?.url
        : sanitizeLine(sourceUrl);
    const text =
      currentRaw?.source?.kind === "text"
        ? currentRaw?.source?.text || currentRaw?.rawContent
        : currentRaw?.source?.kind === "file"
        ? currentRaw?.rawContent
        : sourceKind === "text"
        ? sourceText
        : sourceKind === "file"
        ? sourceFileText
        : "";

    const fileMeta =
      currentRaw?.source?.kind === "file"
        ? {
            filename: currentRaw?.source?.filename || sourceFile?.name || "",
            mime: currentRaw?.source?.mime || sourceFile?.type || "",
            size: currentRaw?.source?.size || sourceFile?.size || 0,
          }
        : null;

    let out = null;

    try {
      if (recipeParser && typeof recipeParser.parse === "function") {
        out = await recipeParser.parse({
          domain: DOMAIN,
          url,
          text,
          file: fileMeta,
        });
      } else if (typeof recipeParser === "function") {
        out = await recipeParser({ domain: DOMAIN, url, text, file: fileMeta });
      }
    } catch (e) {
      out = null;
      pushLog("warn", "recipeParser failed; falling back.", {
        error: String(e?.message || e),
      });
    }

    if (!out || !out.extracted) {
      out = fallbackParseCooking({ url, text, fileMeta });
    } else {
      // normalize output shape
      out = {
        extracted: out.extracted || out.data || {},
        confidence: out.confidence || { overall: 0.6, fields: {} },
        logs: Array.isArray(out.logs) ? out.logs : [],
      };
    }

    const extracted = out.extracted || {};
    setParsed(out);
    setExtractedEdits(extracted);
    setDirty(true);

    emit("import.parsed", {
      domain: DOMAIN,
      rawId: currentRaw?.id,
      extracted,
      confidence: out.confidence,
      ts,
    });

    pushLog("info", "Parse completed.", {
      rawId: currentRaw?.id,
      confidence: out.confidence,
    });
    if (Array.isArray(out.logs) && out.logs.length) {
      out.logs.forEach((l) =>
        pushLog(l.level || "info", l.msg || "parser.log", l.data)
      );
    }

    setBusy(false);
  }, [
    raw,
    receiveImport,
    sourceUrl,
    sourceText,
    sourceFileText,
    sourceKind,
    sourceFile,
  ]);

  /* ------------------------------ Edit tracking --------------------------- */

  function applyEdit(path, value) {
    setExtractedEdits((prev) => {
      const base = prev && typeof prev === "object" ? { ...prev } : {};
      // shallow path setter (supports "a.b.c" and array index like steps[0])
      const setByPath = (obj, p, v) => {
        const parts = String(p)
          .replace(/\[(\d+)\]/g, ".$1")
          .split(".")
          .filter(Boolean);

        let cur = obj;
        for (let i = 0; i < parts.length - 1; i += 1) {
          const k = parts[i];
          const nextK = parts[i + 1];
          const shouldBeArray = /^\d+$/.test(nextK);
          if (cur[k] == null || typeof cur[k] !== "object") {
            cur[k] = shouldBeArray ? [] : {};
          }
          cur = cur[k];
        }
        cur[parts[parts.length - 1]] = v;
      };

      setByPath(base, path, value);
      return base;
    });

    const patch = { ts: nowIso(), path, value };
    setPatches((prev) => [...prev, patch]);
    setDirty(true);
  }

  /* ------------------------------ Normalize ------------------------------- */

  const runNormalize = useCallback(async () => {
    setBusy(true);
    const ts = nowIso();

    const currentRaw = raw || receiveImport();
    const extracted = extractedEdits || parsed?.extracted || {};

    let normalizedOut = null;
    let logs = [];

    try {
      if (ImportNormalizer) {
        if (typeof ImportNormalizer.normalizeCooking === "function") {
          normalizedOut = await ImportNormalizer.normalizeCooking(extracted, {
            domain: DOMAIN,
          });
        } else if (typeof ImportNormalizer.normalize === "function") {
          normalizedOut = await ImportNormalizer.normalize({
            domain: DOMAIN,
            extracted,
            ctx: {},
          });
        }
      }
    } catch (e) {
      normalizedOut = null;
      logs.push({
        ts: nowIso(),
        level: "warn",
        msg: "ImportNormalizer failed; using fallbackNormalizeCooking.",
        data: { error: String(e?.message || e) },
      });
    }

    if (!normalizedOut || typeof normalizedOut !== "object") {
      normalizedOut = fallbackNormalizeCooking(extracted, patches);
      logs.push({
        ts: nowIso(),
        level: "warn",
        msg: "Used fallback normalization (ImportNormalizer unavailable).",
      });
    }

    const normId = makeId("importNorm");
    const confidence = parsed?.confidence || { overall: 0.55, fields: {} };

    const normObj = {
      id: normId,
      rawId: currentRaw?.id,
      domain: DOMAIN,
      createdAtISO: ts,
      updatedAtISO: ts,
      confidence,
      extracted,
      normalized: normalizedOut,
      edits: { patches: Array.isArray(patches) ? patches : [] },
      logs: logs,
    };

    setNormalized(normObj);
    setDirty(true);

    // Initialize linkMap if missing
    setLinkMap((prev) => {
      if (prev && prev.links) return prev;

      const lmId = makeId("linkMap");
      const equipmentFrom = Array.isArray(normalizedOut?.equipment)
        ? normalizedOut.equipment
        : [];
      const tagFrom = Array.isArray(normalizedOut?.tags)
        ? normalizedOut.tags
        : [];
      const invFrom = Array.isArray(normalizedOut?.ingredients)
        ? normalizedOut.ingredients
        : [];

      return {
        id: lmId,
        rawId: currentRaw?.id,
        normId: normId,
        domain: DOMAIN,
        createdAtISO: ts,
        updatedAtISO: ts,
        links: {
          inventory: invFrom.map((it) => ({
            from: it?.name || "",
            toId: null,
            toName: "",
            qty: it?.qty ?? null,
            unit: it?.unit || "",
            note: it?.note || "",
          })),
          equipment: equipmentFrom.map((e) => ({
            from: String(e || ""),
            toId: null,
            toName: "",
            note: "",
          })),
          tags: tagFrom.map((t) => ({
            from: String(t || ""),
            to: String(t || ""),
          })),
        },
        meta: { notes: "" },
      };
    });

    emit("import.normalized", {
      domain: DOMAIN,
      rawId: currentRaw?.id,
      normId,
      confidence,
      normalized: normalizedOut,
      ts,
    });

    pushLog("info", "Normalization completed.", {
      rawId: currentRaw?.id,
      normId,
    });
    logs.forEach((l) =>
      pushLog(l.level || "info", l.msg || "normalize.log", l.data)
    );

    setBusy(false);
  }, [raw, receiveImport, extractedEdits, parsed, patches]);

  /* ------------------------------ Link mapping ---------------------------- */

  function updateLinkRow(kind, idx, patchObj) {
    setLinkMap((prev) => {
      const base = prev && typeof prev === "object" ? { ...prev } : null;
      if (!base || !base.links) return prev;

      const next = {
        ...base,
        updatedAtISO: nowIso(),
        links: { ...base.links },
      };

      const arr = Array.isArray(next.links[kind]) ? [...next.links[kind]] : [];
      const row = arr[idx] ? { ...arr[idx] } : {};
      arr[idx] = { ...row, ...patchObj };
      next.links[kind] = arr;
      return next;
    });
    setDirty(true);
  }

  function addLinkRow(kind) {
    setLinkMap((prev) => {
      const base = prev && typeof prev === "object" ? { ...prev } : null;
      if (!base) return prev;
      const links = base.links
        ? { ...base.links }
        : { inventory: [], equipment: [], tags: [] };
      const arr = Array.isArray(links[kind]) ? [...links[kind]] : [];
      if (kind === "inventory")
        arr.push({
          from: "",
          toId: null,
          toName: "",
          qty: null,
          unit: "",
          note: "",
        });
      if (kind === "equipment")
        arr.push({ from: "", toId: null, toName: "", note: "" });
      if (kind === "tags") arr.push({ from: "", to: "" });
      return { ...base, links, updatedAtISO: nowIso() };
    });
    setDirty(true);
  }

  function removeLinkRow(kind, idx) {
    setLinkMap((prev) => {
      const base = prev && typeof prev === "object" ? { ...prev } : null;
      if (!base || !base.links) return prev;
      const links = { ...base.links };
      const arr = Array.isArray(links[kind]) ? [...links[kind]] : [];
      arr.splice(idx, 1);
      links[kind] = arr;
      return { ...base, links, updatedAtISO: nowIso() };
    });
    setDirty(true);
  }

  const finalizeLinks = useCallback(() => {
    const ts = nowIso();
    if (!raw?.id || !normalized?.id || !linkMap?.id) return;

    emit("import.linked", {
      domain: DOMAIN,
      rawId: raw.id,
      normId: normalized.id,
      linkMapId: linkMap.id,
      links: linkMap.links,
      ts,
    });

    pushLog("info", "Links confirmed (in-memory).", { linkMapId: linkMap.id });
  }, [raw, normalized, linkMap]);

  /* ------------------------------ Save to Dexie --------------------------- */

  const saveAll = useCallback(async () => {
    setBusy(true);
    setSaveState({ status: "saving", error: "" });
    setDraftError("");

    const ts = nowIso();

    try {
      if (!db) {
        throw new Error(
          "Dexie db module not available. Ensure src/services/db.js exports default db or named export { db }."
        );
      }
      if (!canUseDb) {
        throw new Error(
          "Missing Import Pipeline tables. Add importRaw/importNormalized/importLinkMaps/importLogs to Dexie schema (db.version bump required)."
        );
      }
      if (!raw?.id) throw new Error("Nothing to save: raw is missing.");
      if (!normalized?.id)
        throw new Error("Nothing to save: normalized is missing.");
      if (!linkMap?.id) throw new Error("Nothing to save: linkMap is missing.");

      // Ensure ids are consistent
      const rawToSave = { ...raw, updatedAtISO: ts };
      const normToSave = { ...normalized, updatedAtISO: ts };
      const linkToSave = { ...linkMap, updatedAtISO: ts };

      // Persist logs as separate rows (importLogs)
      const pipelineLogRows = uiLogs.slice(0, 50).map((l) => ({
        id: makeId("importLog"),
        domain: DOMAIN,
        rawId: raw.id,
        normId: normalized.id,
        linkMapId: linkMap.id,
        ts: l.ts || ts,
        level: l.level || "info",
        msg: l.msg || "",
        data: l.data ?? null,
      }));

      // Dexie writes
      await dexiePut(db.importRaw, rawToSave);
      await dexiePut(db.importNormalized, normToSave);
      await dexiePut(db.importLinkMaps, linkToSave);

      for (const row of pipelineLogRows) {
        // eslint-disable-next-line no-await-in-loop
        await dexiePut(db.importLogs, row);
      }

      // Heuristic: shortage detection (based on inventory mappings missing toId/toName)
      const invLinks = Array.isArray(linkToSave?.links?.inventory)
        ? linkToSave.links.inventory
        : [];
      const shortages = invLinks
        .filter(
          (x) =>
            sanitizeLine(x?.from).length > 0 &&
            !sanitizeLine(x?.toId || x?.toName).length
        )
        .slice(0, 25)
        .map((x) => ({
          item: x.from,
          neededQty: x.qty ?? null,
          unit: x.unit || "",
        }));

      if (shortages.length) {
        emit("inventory.shortage.detected", {
          domain: DOMAIN,
          rawId: raw.id,
          normId: normalized.id,
          shortages,
          ts,
        });
        pushLog("warn", "Inventory shortage detected (unlinked ingredients).", {
          shortagesCount: shortages.length,
        });
      }

      setSaveState({ status: "saved", error: "" });
      setLastSavedISO(ts);
      setDirty(false);

      pushLog("info", "Saved all import artifacts to Dexie.", {
        rawId: raw.id,
        normId: normalized.id,
        linkMapId: linkMap.id,
        logsSaved: pipelineLogRows.length,
      });

      // TODO: Hub export stub (local-first)
      if (familyFundMode) {
        pushLog(
          "info",
          "familyFundMode=true → TODO: export to Hub (stub only)."
        );
        // TODO: if (featureFlags.familyFundMode) export normalized artifacts to Hub
      }
    } catch (e) {
      const msg = String(e?.message || e);
      setSaveState({ status: "error", error: msg });
      pushLog("error", "Save failed.", { error: msg });
    } finally {
      setBusy(false);
    }
  }, [canUseDb, raw, normalized, linkMap, uiLogs, familyFundMode]);

  /* ------------------------------ Draft generation ------------------------- */

  function buildFallbackDraft() {
    const ts = nowIso();
    const draftId = makeId("cookingDraft");

    const title =
      normalized?.normalized?.title ||
      extractedEdits?.title ||
      parsed?.extracted?.title ||
      "Cooking Session Draft";

    const ingredients = Array.isArray(normalized?.normalized?.ingredients)
      ? normalized.normalized.ingredients
      : [];
    const steps = Array.isArray(normalized?.normalized?.steps)
      ? normalized.normalized.steps
      : [];

    const tasks = steps.map((s, i) => ({
      id: makeId("task"),
      order: i + 1,
      text: String(s?.text || "").trim(),
      timerSec: s?.timerSec ?? null,
      tags: ["cooking.step"],
    }));

    const invAlerts = [];
    const invLinks = Array.isArray(linkMap?.links?.inventory)
      ? linkMap.links.inventory
      : [];
    invLinks.forEach((x) => {
      if (
        sanitizeLine(x?.from).length &&
        !sanitizeLine(x?.toId || x?.toName).length
      ) {
        invAlerts.push({
          kind: "missing.inventory.link",
          item: x.from,
          neededQty: x.qty ?? null,
          unit: x.unit || "",
          note: "Ingredient not linked to inventory item.",
        });
      }
    });

    return {
      id: draftId,
      domain: DOMAIN,
      title: sanitizeLine(title),
      summary:
        sanitizeLine(normalized?.normalized?.summary) ||
        "Draft generated from imported recipe. Review timers/equipment and confirm ingredient links.",
      assumptions: [
        "Timers were inferred from step text when possible.",
        "Ingredient quantities were not parsed (kept as raw lines) unless provided by parser.",
      ],
      sections: [
        {
          id: makeId("section"),
          title: "Ingredients",
          items: ingredients.map((it) => ({
            name: it?.name || "",
            qty: it?.qty ?? null,
            unit: it?.unit || "",
            note: it?.note || "",
          })),
        },
        {
          id: makeId("section"),
          title: "Steps",
          items: tasks.map((t) => ({
            order: t.order,
            text: t.text,
            timerSec: t.timerSec,
          })),
        },
      ],
      tasks,
      inventoryAlerts: invAlerts,
      healthReminders: [],
      meta: {
        createdAt: ts,
        rawId: raw?.id || null,
        normId: normalized?.id || null,
        linkMapId: linkMap?.id || null,
        sourceUrl:
          raw?.source?.url || normalized?.normalized?.source?.url || "",
        engineUsed: false,
      },
    };
  }

  const generateDraft = useCallback(async () => {
    setBusy(true);
    setDraftError("");

    const ts = nowIso();
    try {
      if (!raw?.id || !normalized?.id || !linkMap?.id) {
        throw new Error(
          "Draft requires raw + normalized + linkMap. Complete steps and save first."
        );
      }

      let draftObj = null;

      // Optional engine integration
      try {
        if (CookingSessionEngine) {
          if (
            typeof CookingSessionEngine.createDraftFromImport === "function"
          ) {
            draftObj = await CookingSessionEngine.createDraftFromImport({
              domain: DOMAIN,
              normalized: normalized.normalized,
              links: linkMap.links,
              ctx: {
                rawId: raw.id,
                normId: normalized.id,
                linkMapId: linkMap.id,
              },
            });
          } else if (typeof CookingSessionEngine.createDraft === "function") {
            draftObj = await CookingSessionEngine.createDraft(
              normalized.normalized,
              linkMap,
              { rawId: raw.id, normId: normalized.id, linkMapId: linkMap.id }
            );
          }
        }
      } catch (e) {
        draftObj = null;
        pushLog(
          "warn",
          "CookingSessionEngine draft failed; using fallback draft.",
          {
            error: String(e?.message || e),
          }
        );
      }

      // Fallback must always produce a RESOLVED draft
      if (!draftObj || typeof draftObj !== "object") {
        draftObj = buildFallbackDraft();
      } else {
        // Ensure required fields exist (resolved)
        draftObj = {
          id: draftObj.id || makeId("cookingDraft"),
          domain: DOMAIN,
          title: draftObj.title || "Cooking Session Draft",
          summary: draftObj.summary || "",
          assumptions: Array.isArray(draftObj.assumptions)
            ? draftObj.assumptions
            : [],
          sections: Array.isArray(draftObj.sections) ? draftObj.sections : [],
          tasks: Array.isArray(draftObj.tasks) ? draftObj.tasks : [],
          inventoryAlerts: Array.isArray(draftObj.inventoryAlerts)
            ? draftObj.inventoryAlerts
            : [],
          healthReminders: Array.isArray(draftObj.healthReminders)
            ? draftObj.healthReminders
            : [],
          meta: {
            ...(draftObj.meta || {}),
            createdAt: draftObj.meta?.createdAt || ts,
          },
        };
      }

      setDraft(draftObj);

      emit("session.draft.created", {
        domain: DOMAIN,
        rawId: raw.id,
        normId: normalized.id,
        linkMapId: linkMap.id,
        draftId: draftObj.id,
        ts,
      });

      pushLog("info", "Session draft created.", {
        draftId: draftObj.id,
        engine: Boolean(draftObj?.meta?.engineUsed),
      });
    } catch (e) {
      const msg = String(e?.message || e);
      setDraftError(msg);
      pushLog("error", "Draft creation failed.", { error: msg });
    } finally {
      setBusy(false);
    }
  }, [raw, normalized, linkMap]);

  /* ------------------------------ File handling --------------------------- */

  const onPickFile = useCallback(async (file) => {
    setSourceFile(file || null);
    setSourceFileText("");
    fileReaderAbortRef.current.aborted = false;

    if (!file) return;

    try {
      const isText =
        (file.type && file.type.includes("text")) ||
        /\.(txt|md|json|csv|html?)$/i.test(file.name || "");

      if (!isText) {
        pushLog(
          "warn",
          "File is not a recognized text type. Trying to read anyway.",
          {
            name: file.name,
            type: file.type,
          }
        );
      }

      const text = await file.text();
      if (fileReaderAbortRef.current.aborted) return;
      setSourceFileText(text || "");
      pushLog("info", "File loaded into import source.", {
        name: file.name,
        bytes: file.size,
      });
    } catch (e) {
      pushLog("error", "Failed to read file.", {
        error: String(e?.message || e),
      });
      setSourceFileText("");
    }
  }, []);

  /* -------------------------------------------------------------------------- */
  /* Render helpers                                                             */
  /* -------------------------------------------------------------------------- */

  const title = "Cooking Import";

  return (
    <div className="ssaImport">
      <style>{`
        .ssaImport { padding: 16px; max-width: 1100px; margin: 0 auto; }
        .hdr { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
        .hdr h1 { margin: 0; font-size: 22px; }
        .sub { color:#555; font-size: 13px; margin-top: 4px; }
        .pill { font-size: 12px; padding: 4px 8px; border:1px solid #ddd; border-radius: 999px; background:#fafafa; }
        .grid { display:grid; grid-template-columns: 1.1fr 0.9fr; gap: 12px; margin-top: 12px; }
        .card { border:1px solid #e6e6e6; border-radius: 12px; padding: 12px; background:#fff; }
        .steps { display:flex; flex-wrap:wrap; gap:8px; margin-top: 10px; }
        .stepBtn { border:1px solid #ddd; border-radius: 10px; padding: 8px 10px; background:#fff; cursor:pointer; font-size: 13px; }
        .stepBtn.active { border-color:#111; }
        .row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
        .row > * { flex: 0 0 auto; }
        label { font-size: 12px; color:#333; display:block; margin-bottom: 4px; }
        input[type="text"], input[type="number"], textarea, select {
          width: 100%;
          border:1px solid #ddd; border-radius: 10px;
          padding: 8px 10px; font-size: 14px; background:#fff;
        }
        textarea { min-height: 120px; resize: vertical; }
        .btn { border:1px solid #111; background:#111; color:#fff; border-radius: 10px; padding: 9px 12px; cursor:pointer; font-size: 14px; }
        .btn.secondary { background:#fff; color:#111; }
        .btn:disabled { opacity:0.5; cursor:not-allowed; }
        .muted { color:#666; font-size: 13px; }
        .kvs { display:grid; grid-template-columns: 180px 1fr; gap: 8px; align-items:center; }
        .k { font-size: 12px; color:#444; }
        .v { font-size: 13px; color:#111; }
        .mini { font-size: 12px; color:#444; }
        .hr { height:1px; background:#eee; margin: 10px 0; }
        .table { width:100%; border-collapse: collapse; }
        .table th, .table td { border-top:1px solid #eee; padding: 8px 6px; text-align:left; font-size: 13px; vertical-align: top; }
        .table th { font-size: 12px; color:#444; }
        .danger { color:#b00020; }
        .ok { color:#0b7a0b; }
        .log { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
               font-size: 12px; white-space: pre-wrap; }
      `}</style>

      <div className="hdr">
        <div>
          <h1>{title}</h1>
          <div className="sub">
            Import recipes from URL/text/file → parse → edit → normalize → link
            → save → draft.
          </div>
          <div className="steps">
            {STEP_KEYS.map((s, idx) => (
              <button
                key={s.key}
                className={`stepBtn ${idx === stepIndex ? "active" : ""}`}
                onClick={() => setStepIndex(idx)}
                disabled={busy}
                type="button"
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <span className="pill">domain: {DOMAIN}</span>
          <span className="pill">
            Dexie:{" "}
            {db ? (
              canUseDb ? (
                <span className="ok">ready</span>
              ) : (
                <span className="danger">schema missing</span>
              )
            ) : (
              <span className="danger">missing</span>
            )}
          </span>
          <span className="pill">dirty: {dirty ? "yes" : "no"}</span>
          {lastSavedISO ? (
            <span className="pill">saved: {lastSavedISO}</span>
          ) : null}
        </div>
      </div>

      <div className="grid">
        {/* Left: Wizard step content */}
        <div className="card">
          {/* Step content */}
          {step === "source" && (
            <div>
              <h3 style={{ marginTop: 0 }}>Source</h3>

              <div className="row" style={{ marginBottom: 10 }}>
                <label style={{ margin: 0 }}>
                  <span className="mini">Source type</span>
                </label>
                <select
                  value={sourceKind}
                  onChange={(e) => setSourceKind(e.target.value)}
                  disabled={busy}
                  style={{ width: 220 }}
                >
                  <option value="url">URL (no network fetch)</option>
                  <option value="text">Paste Text</option>
                  <option value="file">Upload File</option>
                </select>
              </div>

              {sourceKind === "url" && (
                <div>
                  <label>Recipe URL</label>
                  <input
                    type="text"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="https://example.com/recipe"
                    disabled={busy}
                  />
                  <div className="muted" style={{ marginTop: 6 }}>
                    This page does not fetch the URL. Paste the recipe text in
                    “Paste Text” if needed.
                  </div>
                </div>
              )}

              {sourceKind === "text" && (
                <div>
                  <label>Paste Recipe Text</label>
                  <textarea
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                    placeholder={`Paste recipe here...\n\nIngredients:\n- ...\n\nInstructions:\n1) ...`}
                    disabled={busy}
                  />
                </div>
              )}

              {sourceKind === "file" && (
                <div>
                  <label>Upload a text-based recipe file</label>
                  <input
                    type="file"
                    accept=".txt,.md,.json,.csv,.html,.htm"
                    disabled={busy}
                    onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                  />
                  <div style={{ marginTop: 8 }}>
                    <label>File preview (editable)</label>
                    <textarea
                      value={sourceFileText}
                      onChange={(e) => setSourceFileText(e.target.value)}
                      placeholder="File text will appear here..."
                      disabled={busy}
                    />
                  </div>
                </div>
              )}

              <div className="hr" />

              <div className="row">
                <button
                  className="btn"
                  type="button"
                  disabled={busy || !stepValid}
                  onClick={() => {
                    receiveImport();
                    runParse();
                    setStepIndex(1);
                  }}
                >
                  Parse & Preview →
                </button>
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setRaw(null);
                    setParsed(null);
                    setExtractedEdits(null);
                    setNormalized(null);
                    setLinkMap(null);
                    setDraft(null);
                    setPatches([]);
                    setDirty(false);
                    setLastSavedISO(null);
                    setSaveState({ status: "idle", error: "" });
                    setUiLogs([]);
                  }}
                >
                  Reset
                </button>
              </div>
            </div>
          )}

          {step === "parse" && (
            <div>
              <h3 style={{ marginTop: 0 }}>Parse Preview</h3>

              {!raw?.id ? (
                <div className="muted">
                  No import source yet. Go back to Source.
                </div>
              ) : (
                <>
                  <div className="kvs">
                    <div className="k">rawId</div>
                    <div className="v">{raw.id}</div>
                    <div className="k">source</div>
                    <div className="v">{raw?.source?.kind || "?"}</div>
                    <div className="k">url</div>
                    <div className="v">{raw?.source?.url || ""}</div>
                    <div className="k">created</div>
                    <div className="v">{raw?.createdAtISO}</div>
                  </div>

                  <div className="hr" />

                  <div
                    className="row"
                    style={{ justifyContent: "space-between" }}
                  >
                    <div className="muted">
                      Parser:{" "}
                      {recipeParser ? (
                        <span className="ok">recipeParser.js</span>
                      ) : (
                        <span className="danger">fallback</span>
                      )}
                    </div>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={runParse}
                    >
                      Re-parse
                    </button>
                  </div>

                  <div className="hr" />

                  {!parsed?.extracted ? (
                    <div className="muted">
                      Nothing parsed yet. Click Re-parse.
                    </div>
                  ) : (
                    <div>
                      <div className="row" style={{ gap: 10 }}>
                        <span className="pill">
                          confidence:{" "}
                          {Number(parsed?.confidence?.overall ?? 0).toFixed(2)}
                        </span>
                        <span className="pill">
                          ingredients:{" "}
                          {Array.isArray(parsed?.extracted?.ingredients)
                            ? parsed.extracted.ingredients.length
                            : 0}
                        </span>
                        <span className="pill">
                          steps:{" "}
                          {Array.isArray(parsed?.extracted?.steps)
                            ? parsed.extracted.steps.length
                            : 0}
                        </span>
                      </div>

                      <div className="hr" />

                      <div className="kvs">
                        <div className="k">title</div>
                        <div className="v">
                          {parsed?.extracted?.title || ""}
                        </div>
                        <div className="k">servings</div>
                        <div className="v">
                          {parsed?.extracted?.servings ?? ""}
                        </div>
                        <div className="k">equipment</div>
                        <div className="v">
                          {Array.isArray(parsed?.extracted?.equipment)
                            ? parsed.extracted.equipment.join(", ")
                            : ""}
                        </div>
                      </div>

                      <div className="hr" />

                      <div
                        className="row"
                        style={{ justifyContent: "flex-end" }}
                      >
                        <button
                          className="btn"
                          type="button"
                          disabled={busy || !parsed?.extracted}
                          onClick={() => {
                            setExtractedEdits(parsed.extracted);
                            setStepIndex(2);
                          }}
                        >
                          Edit Extracted Fields →
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {step === "edit" && (
            <div>
              <h3 style={{ marginTop: 0 }}>Edit Extracted Fields</h3>

              {!parsed?.extracted ? (
                <div className="muted">
                  No parsed data yet. Go back and parse first.
                </div>
              ) : (
                <>
                  <div className="muted">
                    Changes are tracked as patches. Keep edits
                    lightweight—normalization will map into SSA contract.
                  </div>

                  <div className="hr" />

                  <label>Title</label>
                  <input
                    type="text"
                    value={extractedEdits?.title || ""}
                    onChange={(e) => applyEdit("title", e.target.value)}
                    disabled={busy}
                  />

                  <div style={{ marginTop: 10 }} className="row">
                    <div style={{ flex: "1 1 220px" }}>
                      <label>Servings</label>
                      <input
                        type="number"
                        value={extractedEdits?.servings ?? ""}
                        onChange={(e) =>
                          applyEdit(
                            "servings",
                            e.target.value === ""
                              ? null
                              : Number(e.target.value)
                          )
                        }
                        disabled={busy}
                      />
                    </div>
                    <div style={{ flex: "2 1 360px" }}>
                      <label>Equipment (comma-separated)</label>
                      <input
                        type="text"
                        value={
                          Array.isArray(extractedEdits?.equipment)
                            ? extractedEdits.equipment.join(", ")
                            : ""
                        }
                        onChange={(e) =>
                          applyEdit(
                            "equipment",
                            e.target.value
                              .split(",")
                              .map((x) => sanitizeLine(x))
                              .filter(Boolean)
                          )
                        }
                        disabled={busy}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <label>Ingredients (one per line)</label>
                    <textarea
                      value={
                        Array.isArray(extractedEdits?.ingredients)
                          ? extractedEdits.ingredients.join("\n")
                          : ""
                      }
                      onChange={(e) =>
                        applyEdit(
                          "ingredients",
                          splitLines(e.target.value).slice(0, 400)
                        )
                      }
                      disabled={busy}
                    />
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <label>Steps / Instructions (one per line)</label>
                    <textarea
                      value={
                        Array.isArray(extractedEdits?.steps)
                          ? extractedEdits.steps.join("\n")
                          : ""
                      }
                      onChange={(e) =>
                        applyEdit(
                          "steps",
                          splitLines(e.target.value).slice(0, 600)
                        )
                      }
                      disabled={busy}
                    />
                  </div>

                  <div className="hr" />

                  <div
                    className="row"
                    style={{ justifyContent: "space-between" }}
                  >
                    <div className="muted">
                      patches: {patches.length}{" "}
                      {patches.length ? "(dirty)" : ""}
                    </div>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        runNormalize();
                        setStepIndex(3);
                      }}
                    >
                      Normalize →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === "normalize" && (
            <div>
              <h3 style={{ marginTop: 0 }}>Normalize (SSA contract)</h3>

              {!extractedEdits ? (
                <div className="muted">
                  No extracted fields to normalize. Go back to Edit.
                </div>
              ) : (
                <>
                  <div
                    className="row"
                    style={{ justifyContent: "space-between" }}
                  >
                    <div className="muted">
                      Normalizer:{" "}
                      {ImportNormalizer ? (
                        <span className="ok">available</span>
                      ) : (
                        <span className="danger">fallback</span>
                      )}
                    </div>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={runNormalize}
                    >
                      Re-normalize
                    </button>
                  </div>

                  <div className="hr" />

                  {!normalized?.normalized ? (
                    <div className="muted">
                      Not normalized yet. Click Re-normalize.
                    </div>
                  ) : (
                    <>
                      <div className="kvs">
                        <div className="k">normId</div>
                        <div className="v">{normalized.id}</div>
                        <div className="k">kind</div>
                        <div className="v">{normalized.normalized.kind}</div>
                        <div className="k">title</div>
                        <div className="v">{normalized.normalized.title}</div>
                        <div className="k">ingredients</div>
                        <div className="v">
                          {normalized.normalized.ingredients.length}
                        </div>
                        <div className="k">steps</div>
                        <div className="v">
                          {normalized.normalized.steps.length}
                        </div>
                      </div>

                      <div className="hr" />

                      <div
                        className="row"
                        style={{ justifyContent: "flex-end" }}
                      >
                        <button
                          className="btn"
                          type="button"
                          disabled={busy}
                          onClick={() => setStepIndex(4)}
                        >
                          Link/Map →
                        </button>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {step === "link" && (
            <div>
              <h3 style={{ marginTop: 0 }}>Link / Map to SSA Entities</h3>

              {!linkMap?.links ? (
                <div className="muted">No link map yet. Normalize first.</div>
              ) : (
                <>
                  <div className="muted">
                    Map imported ingredients/equipment/tags to SSA
                    inventory/equipment catalogs. (This UI supports CRUD rows;
                    actual lookups can be wired later.)
                  </div>

                  <div className="hr" />

                  <h4 style={{ marginBottom: 6 }}>
                    Inventory Links (Ingredients)
                  </h4>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: "30%" }}>From (ingredient)</th>
                        <th style={{ width: "30%" }}>To (inventory id/name)</th>
                        <th style={{ width: "10%" }}>Qty</th>
                        <th style={{ width: "10%" }}>Unit</th>
                        <th>Note</th>
                        <th style={{ width: 60 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {(linkMap.links.inventory || []).map((r, idx) => (
                        <tr key={`inv_${idx}`}>
                          <td>
                            <input
                              type="text"
                              value={r.from || ""}
                              onChange={(e) =>
                                updateLinkRow("inventory", idx, {
                                  from: e.target.value,
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={r.toId || r.toName || ""}
                              onChange={(e) =>
                                updateLinkRow("inventory", idx, {
                                  toId: e.target.value,
                                  toName: e.target.value,
                                })
                              }
                              placeholder="e.g., inv_123 or 'Tomatoes'"
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              value={r.qty ?? ""}
                              onChange={(e) =>
                                updateLinkRow("inventory", idx, {
                                  qty:
                                    e.target.value === ""
                                      ? null
                                      : Number(e.target.value),
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={r.unit || ""}
                              onChange={(e) =>
                                updateLinkRow("inventory", idx, {
                                  unit: e.target.value,
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={r.note || ""}
                              onChange={(e) =>
                                updateLinkRow("inventory", idx, {
                                  note: e.target.value,
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              onClick={() => removeLinkRow("inventory", idx)}
                            >
                              X
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!linkMap.links.inventory?.length ? (
                        <tr>
                          <td colSpan={6} className="muted">
                            No inventory links yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => addLinkRow("inventory")}
                    >
                      + Add ingredient link
                    </button>
                  </div>

                  <div className="hr" />

                  <h4 style={{ marginBottom: 6 }}>Equipment Links</h4>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: "40%" }}>From (equipment)</th>
                        <th style={{ width: "40%" }}>To (equipment id/name)</th>
                        <th>Note</th>
                        <th style={{ width: 60 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {(linkMap.links.equipment || []).map((r, idx) => (
                        <tr key={`eq_${idx}`}>
                          <td>
                            <input
                              type="text"
                              value={r.from || ""}
                              onChange={(e) =>
                                updateLinkRow("equipment", idx, {
                                  from: e.target.value,
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={r.toId || r.toName || ""}
                              onChange={(e) =>
                                updateLinkRow("equipment", idx, {
                                  toId: e.target.value,
                                  toName: e.target.value,
                                })
                              }
                              placeholder="e.g., eq_oven or 'Oven'"
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={r.note || ""}
                              onChange={(e) =>
                                updateLinkRow("equipment", idx, {
                                  note: e.target.value,
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              onClick={() => removeLinkRow("equipment", idx)}
                            >
                              X
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!linkMap.links.equipment?.length ? (
                        <tr>
                          <td colSpan={4} className="muted">
                            No equipment links yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => addLinkRow("equipment")}
                    >
                      + Add equipment link
                    </button>
                  </div>

                  <div className="hr" />

                  <h4 style={{ marginBottom: 6 }}>Tags</h4>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: "45%" }}>From</th>
                        <th style={{ width: "45%" }}>To</th>
                        <th style={{ width: 60 }} />
                      </tr>
                    </thead>
                    <tbody>
                      {(linkMap.links.tags || []).map((r, idx) => (
                        <tr key={`tag_${idx}`}>
                          <td>
                            <input
                              type="text"
                              value={r.from || ""}
                              onChange={(e) =>
                                updateLinkRow("tags", idx, {
                                  from: e.target.value,
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              value={r.to || ""}
                              onChange={(e) =>
                                updateLinkRow("tags", idx, {
                                  to: e.target.value,
                                })
                              }
                              disabled={busy}
                            />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn secondary"
                              disabled={busy}
                              onClick={() => removeLinkRow("tags", idx)}
                            >
                              X
                            </button>
                          </td>
                        </tr>
                      ))}
                      {!linkMap.links.tags?.length ? (
                        <tr>
                          <td colSpan={3} className="muted">
                            No tags yet.
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                  <div className="row" style={{ marginTop: 8 }}>
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => addLinkRow("tags")}
                    >
                      + Add tag
                    </button>
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        finalizeLinks();
                        setStepIndex(5);
                      }}
                    >
                      Confirm Links →
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === "save" && (
            <div>
              <h3 style={{ marginTop: 0 }}>Save + Draft</h3>

              {!db ? (
                <div className="danger">
                  Dexie db import missing. Ensure{" "}
                  <code>src/services/db.js</code> exports default db or named{" "}
                  <code>{`{ db }`}</code>.
                </div>
              ) : !canUseDb ? (
                <div className="danger">
                  Import pipeline tables missing. Add schema for:{" "}
                  <code>importRaw</code>, <code>importNormalized</code>,{" "}
                  <code>importLinkMaps</code>, <code>importLogs</code>.
                </div>
              ) : (
                <>
                  <div className="kvs">
                    <div className="k">rawId</div>
                    <div className="v">{raw?.id || "(missing)"}</div>
                    <div className="k">normId</div>
                    <div className="v">{normalized?.id || "(missing)"}</div>
                    <div className="k">linkMapId</div>
                    <div className="v">{linkMap?.id || "(missing)"}</div>
                    <div className="k">save status</div>
                    <div className="v">
                      {saveState.status === "saved" ? (
                        <span className="ok">saved</span>
                      ) : saveState.status === "saving" ? (
                        "saving..."
                      ) : saveState.status === "error" ? (
                        <span className="danger">error: {saveState.error}</span>
                      ) : (
                        "idle"
                      )}
                    </div>
                  </div>

                  <div className="hr" />

                  <div className="row">
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={saveAll}
                    >
                      Save to Dexie
                    </button>
                    {saveState.status === "error" ? (
                      <button
                        className="btn secondary"
                        type="button"
                        disabled={busy}
                        onClick={saveAll}
                      >
                        Retry Save
                      </button>
                    ) : null}
                    <button
                      className="btn secondary"
                      type="button"
                      disabled={
                        busy || !raw?.id || !normalized?.id || !linkMap?.id
                      }
                      onClick={generateDraft}
                    >
                      Generate Session Draft
                    </button>
                  </div>

                  {draftError ? (
                    <div className="danger" style={{ marginTop: 10 }}>
                      Draft error: {draftError}
                    </div>
                  ) : null}

                  {draft ? (
                    <div style={{ marginTop: 12 }}>
                      <h4 style={{ margin: "6px 0" }}>Draft Preview</h4>
                      <div className="kvs">
                        <div className="k">draftId</div>
                        <div className="v">{draft.id}</div>
                        <div className="k">title</div>
                        <div className="v">{draft.title}</div>
                        <div className="k">tasks</div>
                        <div className="v">
                          {Array.isArray(draft.tasks) ? draft.tasks.length : 0}
                        </div>
                        <div className="k">inventoryAlerts</div>
                        <div className="v">
                          {Array.isArray(draft.inventoryAlerts)
                            ? draft.inventoryAlerts.length
                            : 0}
                        </div>
                      </div>

                      <div className="hr" />

                      <div className="muted">
                        This draft is “resolved” and safe to hand to your
                        SessionRunner. Wire-up is intentionally TODO here.
                      </div>

                      {familyFundMode ? (
                        <div className="muted" style={{ marginTop: 6 }}>
                          familyFundMode=true → TODO: export draft to Hub (stub
                          only).
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="muted" style={{ marginTop: 10 }}>
                      No draft generated yet.
                    </div>
                  )}
                </>
              )}

              <div className="hr" />

              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="muted">
                  Need to adjust earlier steps? Use the wizard tabs above.
                </div>
                <div className="row">
                  <button
                    className="btn secondary"
                    type="button"
                    disabled={prevDisabled}
                    onClick={goPrev}
                  >
                    ← Back
                  </button>
                  <button className="btn" type="button" disabled={true}>
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Nav footer (only show when not on save) */}
          {step !== "save" && <div className="hr" />}
          {step !== "save" && (
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button
                className="btn secondary"
                type="button"
                disabled={prevDisabled}
                onClick={goPrev}
              >
                ← Back
              </button>

              <div className="row">
                <button
                  className="btn secondary"
                  type="button"
                  disabled={busy}
                  onClick={() => pushLog("info", "Checkpoint", { step })}
                >
                  Log checkpoint
                </button>
                <button
                  className="btn"
                  type="button"
                  disabled={nextDisabled}
                  onClick={goNext}
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right: Preview / logs */}
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Preview + Logs</h3>

          <div className="muted">
            This panel is defensive: it will render even when objects are null.
          </div>

          <div className="hr" />

          <h4 style={{ margin: "6px 0" }}>Current Objects</h4>
          <div className="kvs">
            <div className="k">raw</div>
            <div className="v">{raw?.id ? "✅" : "—"}</div>
            <div className="k">parsed</div>
            <div className="v">{parsed?.extracted ? "✅" : "—"}</div>
            <div className="k">normalized</div>
            <div className="v">{normalized?.normalized ? "✅" : "—"}</div>
            <div className="k">linkMap</div>
            <div className="v">{linkMap?.links ? "✅" : "—"}</div>
          </div>

          <div className="hr" />

          <h4 style={{ margin: "6px 0" }}>Quick Preview</h4>
          <div className="muted">
            <div>
              <b>Title:</b>{" "}
              {normalized?.normalized?.title ||
                extractedEdits?.title ||
                parsed?.extracted?.title ||
                "—"}
            </div>
            <div>
              <b>Ingredients:</b>{" "}
              {Array.isArray(extractedEdits?.ingredients)
                ? extractedEdits.ingredients.length
                : Array.isArray(parsed?.extracted?.ingredients)
                ? parsed.extracted.ingredients.length
                : 0}
            </div>
            <div>
              <b>Steps:</b>{" "}
              {Array.isArray(extractedEdits?.steps)
                ? extractedEdits.steps.length
                : Array.isArray(parsed?.extracted?.steps)
                ? parsed.extracted.steps.length
                : 0}
            </div>
          </div>

          <div className="hr" />

          <h4 style={{ margin: "6px 0" }}>Logs</h4>
          {uiLogs.length ? (
            <div className="log">
              {uiLogs
                .slice(0, 25)
                .map(
                  (l) =>
                    `${l.ts} [${l.level}] ${l.msg}${
                      l.data ? ` ${JSON.stringify(l.data)}` : ""
                    }`
                )
                .join("\n")}
            </div>
          ) : (
            <div className="muted">No logs yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dexie schema additions required                                             */
/* -------------------------------------------------------------------------- */
/**
 * File path:
 *   C:\Users\larho\suka-smart-assistant\src\services\db.js
 *
 * Action:
 *   - Bump db.version by +1 (your db.js already has v5, so v6 next if needed).
 *   - Add/ensure these 4 tables exist in the newest db.version(...).stores({ ... }):
 *
 * // --- Import pipeline tables (raw + normalized + link maps + logs) ---
 * importRaw: "id, domain, createdAtISO, updatedAtISO, source.kind, source.url",
 * importNormalized:
 *   "id, rawId, domain, createdAtISO, updatedAtISO, confidence.overall",
 * importLinkMaps: "id, rawId, normId, domain, createdAtISO, updatedAtISO",
 * importLogs: "id, domain, rawId, normId, linkMapId, ts, level",
 */

/* -------------------------------------------------------------------------- */
/* Events emitted: names + payload examples + where they fire                  */
/* -------------------------------------------------------------------------- */
/**
 * 1) import.page.opened
 * Fires in: useEffect() on mount
 * Payload example:
 * {
 *   domain: "cooking",
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 2) import.received
 * Fires in: receiveImport() right after building ImportRaw
 * Payload example:
 * {
 *   domain: "cooking",
 *   rawId: "importRaw_...",
 *   source: { kind: "url", url: "https://..." },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 3) import.parsed
 * Fires in: runParse() after parser output is merged and state is set
 * Payload example:
 * {
 *   domain: "cooking",
 *   rawId: "importRaw_...",
 *   extracted: { title, ingredients, steps, servings, equipment, ... },
 *   confidence: { overall: 0.62, fields: { ... } },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 4) import.normalized
 * Fires in: runNormalize() after ImportNormalized is created
 * Payload example:
 * {
 *   domain: "cooking",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   confidence: { overall: 0.62, fields: { ... } },
 *   normalized: { kind: "recipe_import", title:"...", ingredients:[...], steps:[...], equipment:[...], tags:[...] },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 5) import.linked
 * Fires in: finalizeLinks() when user confirms mappings
 * Payload example:
 * {
 *   domain: "cooking",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   linkMapId: "linkMap_...",
 *   links: { inventory:[...], equipment:[...], tags:[...] },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 6) inventory.shortage.detected
 * Fires in: saveAll() after successful save (heuristic based on unlinked inventory rows)
 * Payload example:
 * {
 *   domain: "cooking",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   shortages: [{ item: "Tomatoes", neededQty: null, unit: "" }],
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 7) session.draft.created
 * Fires in: generateDraft() after draft is created (engine or fallback)
 * Payload example:
 * {
 *   domain: "cooking",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   linkMapId: "linkMap_...",
 *   draftId: "cookingDraft_...",
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 */

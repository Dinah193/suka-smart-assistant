/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\garden\Import.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * SSA Import Wizard — Garden domain
 * ---------------------------------------------------------------------------
 * Purpose:
 *   URL/Text/File → Parse → Preview/Edit → Normalize → Link/Map → Save (Dexie)
 *   → Generate Session Draft (engine-safe fallback).
 *
 * Important constraints:
 * - No network writes.
 * - No Hub export (TODO stub only, behind familyFundMode).
 * - Must not crash if parsers/normalizers/engines/db/eventBus are missing.
 */

/* -------------------------------------------------------------------------- */
/* Domain constant                                                            */
/* -------------------------------------------------------------------------- */

const DOMAIN = "garden";

/* -------------------------------------------------------------------------- */
/* Data contracts (in-file schemas)                                           */
/* -------------------------------------------------------------------------- */

/**
 * ImportRaw (persisted to db.importRaw)
 * {
 *   id: string,
 *   domain: "garden",
 *   createdAtISO: ISO,
 *   updatedAtISO: ISO,
 *   source: {
 *     kind: "url"|"text"|"file",
 *     url?: string,
 *     text?: string,
 *     filename?: string,
 *     mime?: string,
 *     size?: number
 *   },
 *   rawContent?: string,
 *   meta: { fingerprint?: string, notes?: string }
 * }
 *
 * ImportNormalized (persisted to db.importNormalized)
 * {
 *   id: string,
 *   rawId: string,
 *   domain: "garden",
 *   createdAtISO: ISO,
 *   updatedAtISO: ISO,
 *   confidence: { overall:number, fields: Record<string, number> },
 *   extracted: { ...domainExtractedFields },     // parser output (post-edits applied)
 *   normalized: {
 *     kind: "garden_import",
 *     title: string,
 *     summary?: string,
 *     crop?: string,
 *     variety?: string,
 *     bedOrPlot?: string,
 *     season?: string,          // e.g., "spring", "fall", "winter", "summer"
 *     dates?: { startISO?: string|null, transplantISO?: string|null, harvestISO?: string|null },
 *     tasks: Array<{ text:string, when?:string, timerSec?:number|null, supplies?:string[], equipment?:string[] }>,
 *     supplies: string[],
 *     equipment: string[],
 *     tags: string[],
 *     source?: { url?: string }
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
 *   domain: "garden",
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

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

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

/* -------------------------------------------------------------------------- */
/* Optional modules (soft-imports)                                            */
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
 * Parser (domain-specific): gardenParser.js
 * Expected: parse({domain,url?,text?,file?}) => { extracted, confidence, logs }
 */
let gardenParser = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const p = require("@/import/parsers/gardenParser.js");
  gardenParser = p?.default || p;
} catch {
  gardenParser = null;
}

/**
 * Optional ImportNormalizer
 * Expected:
 *  - normalizeGarden(extracted, ctx)
 *  - or normalize({domain, extracted, ctx})
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
 * Optional GardenSessionEngine
 * Expected:
 *  - createDraftFromImport({domain, normalized, links, ctx})
 *  - or createDraft(normalized, linkMap, ctx)
 */
let GardenSessionEngine = null;
try {
  // eslint-disable-next-line global-require, import/no-unresolved
  const e = require("@/engines/garden/GardenSessionEngine.js");
  GardenSessionEngine = e?.default || e;
} catch {
  GardenSessionEngine = null;
}

/* -------------------------------------------------------------------------- */
/* Fallback parse heuristics (garden)                                          */
/* -------------------------------------------------------------------------- */

/**
 * Garden fallback parse attempts to infer:
 * - title (first line or "Garden Import")
 * - crop/variety (lines containing "Crop:" / "Variety:" / seed packet style)
 * - bed/plot (Bed/Plot/Raised bed/Container)
 * - season (spring/summer/fall/winter)
 * - tasks (lines after "Tasks"/"Care"/"Steps"/"Instructions")
 * - supplies (lines after "Supplies")
 */
function fallbackParseGarden({ url, text, fileMeta }) {
  try {
    const inputText = String(text || "");
    const lines = splitLines(inputText);

    const title =
      sanitizeLine(lines[0]) ||
      (url ? `Garden plan from ${url}` : "Garden Import");

    const findValue = (labelRe) => {
      const line = lines.find((l) => labelRe.test(l));
      if (!line) return "";
      const parts = line.split(":");
      return sanitizeLine(parts.slice(1).join(":"));
    };

    const crop =
      findValue(/^crop\b\s*:/i) ||
      findValue(/^plant\b\s*:/i) ||
      findValue(/^seed\b\s*:/i) ||
      "";

    const variety =
      findValue(/^variety\b\s*:/i) || findValue(/^cultivar\b\s*:/i) || "";

    const bedOrPlot =
      findValue(/^(bed|plot|raised bed|container|location)\b\s*:/i) || "";

    let season = "";
    const hay = inputText.toLowerCase();
    if (/\bspring\b/.test(hay)) season = "spring";
    else if (/\bsummer\b/.test(hay)) season = "summer";
    else if (/\bfall\b|\bautumn\b/.test(hay)) season = "fall";
    else if (/\bwinter\b/.test(hay)) season = "winter";

    const idxTasks = lines.findIndex((l) =>
      /^(tasks|care|steps|instructions|directions|to do)\b[:\-]?$/i.test(l)
    );
    const idxSupplies = lines.findIndex((l) =>
      /^(supplies|materials|inputs)\b[:\-]?$/i.test(l)
    );

    const tasksLines =
      idxTasks >= 0
        ? lines.slice(idxTasks + 1, idxSupplies >= 0 ? idxSupplies : undefined)
        : [];

    const suppliesLines = idxSupplies >= 0 ? lines.slice(idxSupplies + 1) : [];

    const tasks = tasksLines
      .map((l) => sanitizeLine(l.replace(/^[•\-\*]\s*/, "")))
      .filter(Boolean)
      .slice(0, 250);

    const supplies = suppliesLines
      .map((l) => sanitizeLine(l.replace(/^[•\-\*]\s*/, "")))
      .filter(Boolean)
      .slice(0, 200);

    // Equipment inference from common gardening words
    const eqHints = [
      "trowel",
      "shovel",
      "hoe",
      "rake",
      "gloves",
      "pruners",
      "shears",
      "watering can",
      "hose",
      "sprayer",
      "seed tray",
      "pots",
      "grow light",
      "trellis",
      "stakes",
      "mulch",
    ];
    const eqSet = new Set();
    const hay2 = `${tasks.join(" ")} ${supplies.join(" ")}`.toLowerCase();
    eqHints.forEach((k) => {
      if (hay2.includes(k)) eqSet.add(k);
    });

    const extracted = {
      title,
      summary: "",
      crop,
      variety,
      bedOrPlot,
      season,
      tasks,
      supplies,
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
            (sanitizeLine(crop).length ? 0.12 : 0) +
            (sanitizeLine(bedOrPlot).length ? 0.08 : 0) +
            (tasks.length ? 0.22 : 0) +
            (supplies.length ? 0.12 : 0) +
            (season ? 0.06 : 0) +
            (extracted.equipment.length ? 0.05 : 0)
        )
      ),
      fields: {
        title: title ? 0.8 : 0.4,
        crop: crop ? 0.65 : 0.35,
        bedOrPlot: bedOrPlot ? 0.6 : 0.35,
        season: season ? 0.55 : 0.35,
        tasks: tasks.length ? 0.7 : 0.35,
        supplies: supplies.length ? 0.65 : 0.35,
        equipment: extracted.equipment.length ? 0.6 : 0.35,
      },
    };

    const logs = [
      {
        ts: nowIso(),
        level: "warn",
        msg: "Used fallback garden parser (gardenParser unavailable or failed).",
        data: { url: url || null, file: fileMeta?.filename || null },
      },
    ];

    return { extracted, confidence, logs };
  } catch (e) {
    return {
      extracted: {
        title: url ? `Garden plan from ${url}` : "Garden Import",
        summary: "",
        crop: "",
        variety: "",
        bedOrPlot: "",
        season: "",
        tasks: [],
        supplies: [],
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
          msg: "Fallback garden parser failed but recovered with minimal output.",
          data: { error: String(e?.message || e) },
        },
      ],
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Fallback normalization (garden)                                            */
/* -------------------------------------------------------------------------- */

function fallbackNormalizeGarden(extracted, patches = []) {
  const title = sanitizeLine(extracted?.title || "Garden Import");
  const crop = sanitizeLine(extracted?.crop || "");
  const variety = sanitizeLine(extracted?.variety || "");
  const bedOrPlot = sanitizeLine(extracted?.bedOrPlot || "");
  const season = sanitizeLine(extracted?.season || "");

  const supplies = Array.isArray(extracted?.supplies)
    ? extracted.supplies.map(sanitizeLine).filter(Boolean).slice(0, 300)
    : [];

  const equipment = Array.isArray(extracted?.equipment)
    ? extracted.equipment.map(sanitizeLine).filter(Boolean).slice(0, 200)
    : [];

  const tasksRaw = Array.isArray(extracted?.tasks)
    ? extracted.tasks.map(sanitizeLine).filter(Boolean).slice(0, 500)
    : [];

  const tasks = tasksRaw.map((text) => {
    // timer heuristic: "15 min", "2 hours"
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

    // "when" heuristic: words like "weekly", "daily", "after transplant", etc.
    const when = /\bdaily\b/i.test(text)
      ? "daily"
      : /\bweekly\b/i.test(text)
      ? "weekly"
      : /\bmonthly\b/i.test(text)
      ? "monthly"
      : /\bafter transplant\b/i.test(text)
      ? "after_transplant"
      : /\bbefore planting\b/i.test(text)
      ? "before_planting"
      : "";

    return { text, when, timerSec, supplies: [], equipment: [] };
  });

  const tags = [];
  if (season) tags.push(season);
  if (crop) tags.push("crop");
  if (/mulch/i.test(`${supplies.join(" ")} ${tasksRaw.join(" ")}`))
    tags.push("mulch");
  if (/fertiliz|compost/i.test(`${supplies.join(" ")} ${tasksRaw.join(" ")}`))
    tags.push("fertility");

  return {
    kind: "garden_import",
    title,
    summary: sanitizeLine(extracted?.summary || ""),
    crop,
    variety,
    bedOrPlot,
    season,
    dates: { startISO: null, transplantISO: null, harvestISO: null },
    tasks,
    supplies,
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
      console.warn("[Garden Import] event emit failed", type, e);
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
  const [normalized, setNormalized] = useState(null); // ImportNormalized
  const [linkMap, setLinkMap] = useState(null); // LinkMap

  // Save state
  const [dirty, setDirty] = useState(false);
  const [lastSavedISO, setLastSavedISO] = useState(null);
  const [saveState, setSaveState] = useState({
    status: "idle", // "idle"|"saving"|"saved"|"error"
    error: "",
  });

  // Draft state
  const [draft, setDraft] = useState(null);
  const [draftError, setDraftError] = useState("");

  // Logs
  const [uiLogs, setUiLogs] = useState([]);

  const fileReaderAbortRef = useRef({ aborted: false });

  const canUseDb = useMemo(() => hasImportTables(db), [db]);
  const familyFundMode = Boolean(featureFlags?.familyFundMode === true);

  const step = STEP_KEYS[stepIndex]?.key || "source";

  // Emit opened
  useEffect(() => {
    emit("import.page.opened", { domain: DOMAIN, ts: nowIso() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        ? ""
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
      if (gardenParser && typeof gardenParser.parse === "function") {
        out = await gardenParser.parse({
          domain: DOMAIN,
          url,
          text,
          file: fileMeta,
        });
      } else if (typeof gardenParser === "function") {
        out = await gardenParser({ domain: DOMAIN, url, text, file: fileMeta });
      }
    } catch (e) {
      out = null;
      pushLog("warn", "gardenParser failed; falling back.", {
        error: String(e?.message || e),
      });
    }

    if (!out || !out.extracted) {
      out = fallbackParseGarden({ url, text, fileMeta });
    } else {
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
      const parts = String(path)
        .replace(/\[(\d+)\]/g, ".$1")
        .split(".")
        .filter(Boolean);

      let cur = base;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const k = parts[i];
        const nextK = parts[i + 1];
        const shouldBeArray = /^\d+$/.test(nextK);
        if (cur[k] == null || typeof cur[k] !== "object") {
          cur[k] = shouldBeArray ? [] : {};
        }
        cur = cur[k];
      }
      cur[parts[parts.length - 1]] = value;
      return base;
    });

    setPatches((prev) => [...prev, { ts: nowIso(), path, value }]);
    setDirty(true);
  }

  /* ------------------------------ Normalize ------------------------------- */

  const runNormalize = useCallback(async () => {
    setBusy(true);
    const ts = nowIso();

    const currentRaw = raw || receiveImport();
    const extracted = extractedEdits || parsed?.extracted || {};

    let normalizedOut = null;
    const logs = [];

    try {
      if (ImportNormalizer) {
        if (typeof ImportNormalizer.normalizeGarden === "function") {
          normalizedOut = await ImportNormalizer.normalizeGarden(extracted, {
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
        msg: "ImportNormalizer failed; using fallbackNormalizeGarden.",
        data: { error: String(e?.message || e) },
      });
    }

    if (!normalizedOut || typeof normalizedOut !== "object") {
      normalizedOut = fallbackNormalizeGarden(extracted, patches);
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
      logs,
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
      const invFrom = Array.isArray(normalizedOut?.supplies)
        ? normalizedOut.supplies
        : [];

      return {
        id: lmId,
        rawId: currentRaw?.id,
        normId: normId,
        domain: DOMAIN,
        createdAtISO: ts,
        updatedAtISO: ts,
        links: {
          // Garden mapping: "supplies" treated as inventory items to link
          inventory: invFrom.map((name) => ({
            from: String(name || ""),
            toId: null,
            toName: "",
            qty: null,
            unit: "",
            note: "",
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
      links[kind] = arr;
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

      const rawToSave = { ...raw, updatedAtISO: ts };
      const normToSave = { ...normalized, updatedAtISO: ts };
      const linkToSave = { ...linkMap, updatedAtISO: ts };

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

      await dexiePut(db.importRaw, rawToSave);
      await dexiePut(db.importNormalized, normToSave);
      await dexiePut(db.importLinkMaps, linkToSave);

      for (const row of pipelineLogRows) {
        // eslint-disable-next-line no-await-in-loop
        await dexiePut(db.importLogs, row);
      }

      // shortage heuristic: unlinked inventory rows (garden supplies)
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
        pushLog("warn", "Inventory shortage detected (unlinked supplies).", {
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
    const draftId = makeId("gardenDraft");

    const n = normalized?.normalized || {};
    const title =
      n?.title ||
      extractedEdits?.title ||
      parsed?.extracted?.title ||
      "Garden Session Draft";

    const tasks = Array.isArray(n?.tasks)
      ? n.tasks.map((t, i) => ({
          id: makeId("task"),
          order: i + 1,
          text: sanitizeLine(t?.text || ""),
          when: sanitizeLine(t?.when || ""),
          timerSec: t?.timerSec ?? null,
          tags: ["garden.task"],
        }))
      : [];

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
          note: "Supply not linked to inventory item.",
        });
      }
    });

    const equipmentNeeded = Array.isArray(n?.equipment) ? n.equipment : [];
    const suppliesNeeded = Array.isArray(n?.supplies) ? n.supplies : [];

    return {
      id: draftId,
      domain: DOMAIN,
      title: sanitizeLine(title),
      summary:
        sanitizeLine(n?.summary) ||
        "Draft generated from imported garden plan. Review tasks timing and link supplies/equipment.",
      assumptions: [
        "Task timing was inferred (daily/weekly/after transplant) when present in text.",
        "Supply quantities may be unknown unless specified; verify before executing.",
      ],
      sections: [
        {
          id: makeId("section"),
          title: "Plan Details",
          items: [
            { k: "crop", v: n?.crop || "" },
            { k: "variety", v: n?.variety || "" },
            { k: "bedOrPlot", v: n?.bedOrPlot || "" },
            { k: "season", v: n?.season || "" },
          ],
        },
        {
          id: makeId("section"),
          title: "Supplies",
          items: suppliesNeeded.map((s) => ({ name: s })),
        },
        {
          id: makeId("section"),
          title: "Equipment",
          items: equipmentNeeded.map((e) => ({ name: e })),
        },
        {
          id: makeId("section"),
          title: "Tasks",
          items: tasks.map((t) => ({
            order: t.order,
            text: t.text,
            when: t.when,
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
        sourceUrl: raw?.source?.url || n?.source?.url || "",
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
        if (GardenSessionEngine) {
          if (typeof GardenSessionEngine.createDraftFromImport === "function") {
            draftObj = await GardenSessionEngine.createDraftFromImport({
              domain: DOMAIN,
              normalized: normalized.normalized,
              links: linkMap.links,
              ctx: {
                rawId: raw.id,
                normId: normalized.id,
                linkMapId: linkMap.id,
              },
            });
          } else if (typeof GardenSessionEngine.createDraft === "function") {
            draftObj = await GardenSessionEngine.createDraft(
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
          "GardenSessionEngine draft failed; using fallback draft.",
          {
            error: String(e?.message || e),
          }
        );
      }

      // Fallback must always produce a RESOLVED draft
      if (!draftObj || typeof draftObj !== "object") {
        draftObj = buildFallbackDraft();
      } else {
        draftObj = {
          id: draftObj.id || makeId("gardenDraft"),
          domain: DOMAIN,
          title: draftObj.title || "Garden Session Draft",
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

  const title = "Garden Import";

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
            Import garden plans (seed packets, guides, notes) → parse → edit →
            normalize → link → save → draft.
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
          {step === "source" && (
            <div>
              <h3 style={{ marginTop: 0 }}>Source</h3>

              <div className="row" style={{ marginBottom: 10 }}>
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
                <span className="muted">
                  Tip: Paste seed packet text or a “care guide” section for best
                  results.
                </span>
              </div>

              {sourceKind === "url" && (
                <div>
                  <label>Garden URL</label>
                  <input
                    type="text"
                    value={sourceUrl}
                    onChange={(e) => setSourceUrl(e.target.value)}
                    placeholder="https://example.com/garden-guide"
                    disabled={busy}
                  />
                  <div className="muted" style={{ marginTop: 6 }}>
                    This page does not fetch the URL. Paste the relevant text in
                    “Paste Text” if needed.
                  </div>
                </div>
              )}

              {sourceKind === "text" && (
                <div>
                  <label>Paste Garden Plan / Care Notes</label>
                  <textarea
                    value={sourceText}
                    onChange={(e) => setSourceText(e.target.value)}
                    placeholder={`Example:\nCrop: Tomato\nVariety: Roma\nBed: Raised Bed 2\nSeason: Spring\n\nTasks:\n- Start seeds indoors 6 weeks before last frost\n- Transplant after danger of frost\n- Water weekly 1 inch\n\nSupplies:\n- Compost\n- Mulch\n- Tomato cage`}
                    disabled={busy}
                  />
                </div>
              )}

              {sourceKind === "file" && (
                <div>
                  <label>Upload a text-based garden file</label>
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
                      {gardenParser ? (
                        <span className="ok">gardenParser.js</span>
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
                    <>
                      <div className="row" style={{ gap: 10 }}>
                        <span className="pill">
                          confidence:{" "}
                          {Number(parsed?.confidence?.overall ?? 0).toFixed(2)}
                        </span>
                        <span className="pill">
                          tasks:{" "}
                          {Array.isArray(parsed?.extracted?.tasks)
                            ? parsed.extracted.tasks.length
                            : 0}
                        </span>
                        <span className="pill">
                          supplies:{" "}
                          {Array.isArray(parsed?.extracted?.supplies)
                            ? parsed.extracted.supplies.length
                            : 0}
                        </span>
                      </div>

                      <div className="hr" />

                      <div className="kvs">
                        <div className="k">title</div>
                        <div className="v">
                          {parsed?.extracted?.title || ""}
                        </div>
                        <div className="k">crop</div>
                        <div className="v">{parsed?.extracted?.crop || ""}</div>
                        <div className="k">variety</div>
                        <div className="v">
                          {parsed?.extracted?.variety || ""}
                        </div>
                        <div className="k">bed/plot</div>
                        <div className="v">
                          {parsed?.extracted?.bedOrPlot || ""}
                        </div>
                        <div className="k">season</div>
                        <div className="v">
                          {parsed?.extracted?.season || ""}
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
                    </>
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
                    Changes are tracked as patches. Normalization will map into
                    SSA-owned garden contract.
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
                      <label>Crop</label>
                      <input
                        type="text"
                        value={extractedEdits?.crop || ""}
                        onChange={(e) => applyEdit("crop", e.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <div style={{ flex: "1 1 220px" }}>
                      <label>Variety</label>
                      <input
                        type="text"
                        value={extractedEdits?.variety || ""}
                        onChange={(e) => applyEdit("variety", e.target.value)}
                        disabled={busy}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }} className="row">
                    <div style={{ flex: "1 1 240px" }}>
                      <label>Bed / Plot / Location</label>
                      <input
                        type="text"
                        value={extractedEdits?.bedOrPlot || ""}
                        onChange={(e) => applyEdit("bedOrPlot", e.target.value)}
                        disabled={busy}
                      />
                    </div>
                    <div style={{ flex: "1 1 240px" }}>
                      <label>Season</label>
                      <input
                        type="text"
                        value={extractedEdits?.season || ""}
                        onChange={(e) => applyEdit("season", e.target.value)}
                        placeholder="spring | summer | fall | winter"
                        disabled={busy}
                      />
                    </div>
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <label>Tasks (one per line)</label>
                    <textarea
                      value={
                        Array.isArray(extractedEdits?.tasks)
                          ? extractedEdits.tasks.join("\n")
                          : ""
                      }
                      onChange={(e) =>
                        applyEdit(
                          "tasks",
                          splitLines(e.target.value).slice(0, 600)
                        )
                      }
                      disabled={busy}
                    />
                  </div>

                  <div style={{ marginTop: 10 }}>
                    <label>Supplies (one per line)</label>
                    <textarea
                      value={
                        Array.isArray(extractedEdits?.supplies)
                          ? extractedEdits.supplies.join("\n")
                          : ""
                      }
                      onChange={(e) =>
                        applyEdit(
                          "supplies",
                          splitLines(e.target.value).slice(0, 400)
                        )
                      }
                      disabled={busy}
                    />
                  </div>

                  <div style={{ marginTop: 10 }}>
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
                        <div className="k">crop</div>
                        <div className="v">
                          {normalized.normalized.crop || ""}
                        </div>
                        <div className="k">bed/plot</div>
                        <div className="v">
                          {normalized.normalized.bedOrPlot || ""}
                        </div>
                        <div className="k">tasks</div>
                        <div className="v">
                          {normalized.normalized.tasks.length}
                        </div>
                        <div className="k">supplies</div>
                        <div className="v">
                          {normalized.normalized.supplies.length}
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
                    Garden mapping: Supplies → Inventory links. Equipment →
                    Equipment links. Tags → Tag links.
                  </div>

                  <div className="hr" />

                  <h4 style={{ marginBottom: 6 }}>
                    Inventory Links (Supplies)
                  </h4>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: "30%" }}>From (supply)</th>
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
                              placeholder="e.g., inv_123 or 'Compost'"
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
                      + Add supply link
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
                              placeholder="e.g., eq_trowel or 'Trowel'"
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
            Defensive rendering: safe even when objects are null.
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
              <b>Crop:</b>{" "}
              {normalized?.normalized?.crop ||
                extractedEdits?.crop ||
                parsed?.extracted?.crop ||
                "—"}
            </div>
            <div>
              <b>Bed/Plot:</b>{" "}
              {normalized?.normalized?.bedOrPlot ||
                extractedEdits?.bedOrPlot ||
                parsed?.extracted?.bedOrPlot ||
                "—"}
            </div>
            <div>
              <b>Tasks:</b>{" "}
              {Array.isArray(normalized?.normalized?.tasks)
                ? normalized.normalized.tasks.length
                : Array.isArray(extractedEdits?.tasks)
                ? extractedEdits.tasks.length
                : 0}
            </div>
            <div>
              <b>Supplies:</b>{" "}
              {Array.isArray(normalized?.normalized?.supplies)
                ? normalized.normalized.supplies.length
                : Array.isArray(extractedEdits?.supplies)
                ? extractedEdits.supplies.length
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
 *   - Bump db.version by +1
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
 *   domain: "garden",
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 2) import.received
 * Fires in: receiveImport() right after building ImportRaw
 * Payload example:
 * {
 *   domain: "garden",
 *   rawId: "importRaw_...",
 *   source: { kind: "url", url: "https://..." },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 3) import.parsed
 * Fires in: runParse() after parser output is merged and state is set
 * Payload example:
 * {
 *   domain: "garden",
 *   rawId: "importRaw_...",
 *   extracted: { title, crop, variety, bedOrPlot, season, tasks, supplies, equipment, ... },
 *   confidence: { overall: 0.58, fields: { ... } },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 4) import.normalized
 * Fires in: runNormalize() after ImportNormalized is created
 * Payload example:
 * {
 *   domain: "garden",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   confidence: { overall: 0.58, fields: { ... } },
 *   normalized: { kind: "garden_import", crop:"Tomato", bedOrPlot:"Raised Bed 2", tasks:[...], supplies:[...], equipment:[...] },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 5) import.linked
 * Fires in: finalizeLinks() when user confirms mappings
 * Payload example:
 * {
 *   domain: "garden",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   linkMapId: "linkMap_...",
 *   links: { inventory:[...], equipment:[...], tags:[...] },
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 6) inventory.shortage.detected
 * Fires in: saveAll() after successful save (heuristic based on unlinked supply rows)
 * Payload example:
 * {
 *   domain: "garden",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   shortages: [{ item: "Compost", neededQty: null, unit: "" }],
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 *
 * 7) session.draft.created
 * Fires in: generateDraft() after draft is created (engine or fallback)
 * Payload example:
 * {
 *   domain: "garden",
 *   rawId: "importRaw_...",
 *   normId: "importNorm_...",
 *   linkMapId: "linkMap_...",
 *   draftId: "gardenDraft_...",
 *   ts: "2025-12-20T12:34:56.000Z"
 * }
 */

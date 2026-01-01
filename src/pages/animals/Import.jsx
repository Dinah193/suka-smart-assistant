/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\animals\Import.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * SSA Animals Import Pipeline (Interactive Wizard)
 * -----------------------------------------------------------------------------
 * Flow:
 *  1) Paste URL / Text / File
 *  2) Parse Preview (and edit extracted fields)
 *  3) Normalize (SSA contract) + confidence + logs
 *  4) Link/Map to SSA data (inventory/equipment/tags)
 *  5) Save (Dexie: raw + normalized + links + logs)
 *  6) Generate Session Draft (optional, engine-safe)
 *
 * Rules:
 *  - No TypeScript
 *  - Defensive imports (db, eventBus, engines, parsers)
 *  - Must run even if parsing worker/engine not available (fallback stubs)
 *  - SSA owns data first; Hub export only if familyFundMode=true (TODO stub)
 *
 * -----------------------------------------------------------------------------
 * ✅ Event names + payload examples + where they fire (minimum + 1 bonus)
 *
 * 1) import.page.opened  (BONUS) — fires on mount
 *    Where: useEffect(() => {...}, [])
 *    Payload:
 *      { domain:"animals", ts:"2025-12-20T..." }
 *
 * 2) import.received — fires in receiveImport() right after building ImportRaw
 *    Payload:
 *      { domain:"animals", rawId:"importRaw_...", source:{kind:"url", url:"https://..."}, ts:"..." }
 *
 * 3) import.parsed — fires in runParse() after parser output is merged
 *    Payload:
 *      { domain:"animals", rawId:"importRaw_...", extracted:{...}, confidence:{...}, ts:"..." }
 *
 * 4) import.normalized — fires in runNormalize() after ImportNormalized is created
 *    Payload:
 *      { domain:"animals", rawId:"importRaw_...", normId:"importNorm_...", confidence:{...}, normalized:{...}, ts:"..." }
 *
 * 5) import.linked — fires in finalizeLinks() when user confirms mappings
 *    Payload:
 *      { domain:"animals", rawId:"importRaw_...", normId:"importNorm_...", linkMapId:"linkMap_...", links:{...}, ts:"..." }
 *
 * 6) inventory.shortage.detected — fires in saveAll() after save (heuristic)
 *    Payload:
 *      { domain:"animals", rawId:"importRaw_...", normId:"importNorm_...", shortages:[{item,neededQty,unit}], ts:"..." }
 *
 * 7) session.draft.created — fires in generateDraft() after draft is created
 *    Payload:
 *      { domain:"animals", rawId:"importRaw_...", normId:"importNorm_...", linkMapId:"linkMap_...", draftId:"animalDraft_...", ts:"..." }
 */

/* ---------------------------- Soft imports --------------------------------- */
let eventBus = { emit: () => {}, on: () => () => {} };
try {
  // eslint-disable-next-line global-require
  const eb = require("@/services/events/eventBus.js");
  eventBus = eb?.default || eb?.eventBus || eb || eventBus;
} catch {
  try {
    // eslint-disable-next-line global-require
    const eb2 = require("../../services/events/eventBus");
    eventBus = eb2?.default || eb2?.eventBus || eb2 || eventBus;
  } catch {}
}

let featureFlags = {};
try {
  // eslint-disable-next-line global-require
  featureFlags = require("@/config/featureFlags.json");
  featureFlags = featureFlags?.default || featureFlags || {};
} catch {
  try {
    // eslint-disable-next-line global-require
    featureFlags = require("../../config/featureFlags.json");
    featureFlags = featureFlags?.default || featureFlags || {};
  } catch {
    featureFlags = {};
  }
}

// NOTE: Your repo has had path variance for db; we soft-import.
// If db is not found, page still works (but persistence disabled).
async function getDbSafe() {
  const tries = [
    () => require("@/db"),
    () => require("@/db/index"),
    () => require("../../db"),
    () => require("../../db/index"),
    // common alternate (your current repo uses src/services/db.js)
    () => require("@/services/db.js"),
    () => require("../../services/db.js"),
  ];
  for (const t of tries) {
    try {
      // eslint-disable-next-line global-require
      const m = t();
      const db = m?.default || m?.db || m;
      if (db) return db;
    } catch {}
  }
  return null;
}

// Parsers / normalizer (optional)
let animalParser = null;
try {
  // eslint-disable-next-line global-require
  animalParser = require("@/import/parsers/animalParser.js");
  animalParser = animalParser?.default || animalParser;
} catch {
  try {
    // eslint-disable-next-line global-require
    animalParser = require("../../import/parsers/animalParser.js");
    animalParser = animalParser?.default || animalParser;
  } catch {}
}

let ImportNormalizer = null;
try {
  // eslint-disable-next-line global-require
  ImportNormalizer = require("@/import/ImportNormalizer.js");
  ImportNormalizer = ImportNormalizer?.default || ImportNormalizer;
} catch {
  try {
    // eslint-disable-next-line global-require
    ImportNormalizer = require("../../import/ImportNormalizer.js");
    ImportNormalizer = ImportNormalizer?.default || ImportNormalizer;
  } catch {}
}

// Optional engines for draft generation
let AnimalSessionEngine = null;
try {
  // eslint-disable-next-line global-require
  AnimalSessionEngine = require("@/engines/animals/AnimalSessionEngine.js");
  AnimalSessionEngine = AnimalSessionEngine?.default || AnimalSessionEngine;
} catch {
  try {
    // eslint-disable-next-line global-require
    AnimalSessionEngine = require("../../engines/animals/AnimalSessionEngine.js");
    AnimalSessionEngine = AnimalSessionEngine?.default || AnimalSessionEngine;
  } catch {}
}

let AnimalStockingTemplate = null;
try {
  // eslint-disable-next-line global-require
  AnimalStockingTemplate = require("@/engines/animals/AnimalStockingTemplate.js");
  AnimalStockingTemplate =
    AnimalStockingTemplate?.default || AnimalStockingTemplate;
} catch {
  try {
    // eslint-disable-next-line global-require
    AnimalStockingTemplate = require("../../engines/animals/AnimalStockingTemplate.js");
    AnimalStockingTemplate =
      AnimalStockingTemplate?.default || AnimalStockingTemplate;
  } catch {}
}

/* -------------------------- Events (All-Domain Ready) ----------------------- */
const IMPORT_EVENTS = Object.freeze({
  PAGE_OPENED: "import.page.opened",
  RECEIVED: "import.received",
  PARSED: "import.parsed",
  NORMALIZED: "import.normalized",
  LINKED: "import.linked",
  INVENTORY_SHORTAGE: "inventory.shortage.detected",
  SESSION_DRAFT_CREATED: "session.draft.created",
});

function isoNow() {
  return new Date().toISOString();
}

/**
 * Safe event emitter:
 * Supports both patterns used across SSA:
 *  - eventBus.emit("name", payload)
 *  - eventBus.emit({ type:"name", ts, source, data })
 */
function emitImportEvent(type, payload) {
  const ts = payload?.ts || isoNow();
  const safePayload = { ...(payload || {}), ts };

  try {
    // Try (name, payload) style first
    if (eventBus && typeof eventBus.emit === "function") {
      try {
        eventBus.emit(type, safePayload);
        return;
      } catch {
        // fall through to object style
      }
      try {
        eventBus.emit({
          type,
          ts,
          source: "import.pipeline",
          data: safePayload,
        });
      } catch {
        // swallow
      }
    }
  } catch {
    // swallow
  }
}

/**
 * Event catalog with payload examples + where they fire.
 * (Shown in UI when "Contracts" is toggled on)
 */
function buildEventCatalog(domain = "animals") {
  return [
    {
      name: IMPORT_EVENTS.PAGE_OPENED,
      where: "fires on mount (useEffect)",
      example: { domain, ts: "2025-12-20T..." },
    },
    {
      name: IMPORT_EVENTS.RECEIVED,
      where: "fires in receiveImport() right after building ImportRaw",
      example: {
        domain,
        rawId: "importRaw_...",
        source: { kind: "url", url: "https://..." },
        ts: "2025-12-20T...",
      },
    },
    {
      name: IMPORT_EVENTS.PARSED,
      where: "fires in runParse() after parser output is merged",
      example: {
        domain,
        rawId: "importRaw_...",
        extracted: {
          title: "...",
          animalType: "goat",
          count: 12,
          notes: "...",
        },
        confidence: {
          overall: 0.55,
          fields: { animalType: 0.45, count: 0.55 },
        },
        ts: "2025-12-20T...",
      },
    },
    {
      name: IMPORT_EVENTS.NORMALIZED,
      where: "fires in runNormalize() after ImportNormalized is created",
      example: {
        domain,
        rawId: "importRaw_...",
        normId: "importNorm_...",
        confidence: {
          overall: 0.55,
          fields: { animalType: 0.45, count: 0.55 },
        },
        normalized: { kind: "animal_import", animalType: "goat", count: 12 },
        ts: "2025-12-20T...",
      },
    },
    {
      name: IMPORT_EVENTS.LINKED,
      where: "fires in finalizeLinks() when user confirms mappings",
      example: {
        domain,
        rawId: "importRaw_...",
        normId: "importNorm_...",
        linkMapId: "linkMap_...",
        links: { inventory: ["..."], equipment: ["..."], tags: ["..."] },
        ts: "2025-12-20T...",
      },
    },
    {
      name: IMPORT_EVENTS.INVENTORY_SHORTAGE,
      where: "fires in saveAll() after save; currently heuristic",
      example: {
        domain,
        rawId: "importRaw_...",
        normId: "importNorm_...",
        shortages: [{ item: "Hay Bale", neededQty: 5, unit: "bales" }],
        ts: "2025-12-20T...",
      },
    },
    {
      name: IMPORT_EVENTS.SESSION_DRAFT_CREATED,
      where: "fires in generateDraft() after draft is created",
      example: {
        domain,
        rawId: "importRaw_...",
        normId: "importNorm_...",
        linkMapId: "linkMap_...",
        draftId: "animalDraft_...",
        ts: "2025-12-20T...",
      },
    },
  ];
}

/* -------------------------- Contracts / Schemas ----------------------------- */
/**
 * ImportRaw
 *  - the "as received" payload from URL/text/file
 */
const ImportRawSchema = {
  id: "string (importRawId)",
  domain: "animals",
  createdAtISO: "string",
  updatedAtISO: "string",
  source: {
    kind: "url|text|file",
    url: "string?",
    filename: "string?",
    mime: "string?",
  },
  raw: {
    text: "string?",
    fileText: "string?",
    fileMeta: "object?",
  },
  parser: {
    name: "string",
    version: "string?",
  },
  parsingLog: [
    {
      ts: "string",
      level: "info|warn|error",
      msg: "string",
      data: "any?",
    },
  ],
};

/**
 * ImportNormalized
 *  - SSA-owned normalized record derived from raw
 */
const ImportNormalizedSchema = {
  id: "string (importNormId)",
  rawId: "string (fk->ImportRaw.id)",
  domain: "animals",
  createdAtISO: "string",
  updatedAtISO: "string",
  source: {
    kind: "url|text|file",
    url: "string?",
    filename: "string?",
  },
  confidence: {
    overall: "number 0..1",
    fields: "object (field->0..1)",
  },
  extracted: {
    title: "string",
    summary: "string",
    animalType: "string (e.g., chicken/goat/sheep/cattle)",
    count: "number?",
    units: "string? (head/birds)",
    notes: "string?",
    tasks: "array?",
    equipment: "array?",
    supplies: "array?",
    tags: "array?",
  },
  normalized: {
    kind: "animal_import",
    animalType: "string",
    count: "number?",
    tasks: "array",
    supplies: "array",
    equipment: "array",
    tags: "array",
  },
  edits: {
    patches: [{ ts: "string", path: "string", value: "any" }],
  },
};

/**
 * LinkMap
 *  - mapping between normalized import fields and SSA entities (inventory/equipment/tags)
 */
const LinkMapSchema = {
  id: "string (linkMapId)",
  rawId: "string",
  normId: "string",
  domain: "animals",
  createdAtISO: "string",
  updatedAtISO: "string",
  links: {
    inventory: [
      {
        from: "string (e.g. supplies[0])",
        to: "string (inventoryItemId OR name)",
        qty: "number?",
        unit: "string?",
        confidence: "number 0..1",
      },
    ],
    equipment: [
      {
        from: "string",
        to: "string (equipmentId OR name)",
        confidence: "number 0..1",
      },
    ],
    tags: [
      {
        from: "string",
        to: "string (tagId OR tagName)",
        confidence: "number 0..1",
      },
    ],
  },
};

/* ------------------------------ Utilities ---------------------------------- */
function uid(prefix = "id") {
  return `${prefix}_${Math.random()
    .toString(16)
    .slice(2)}_${Date.now().toString(16)}`;
}
function deepClone(x) {
  try {
    return structuredClone(x);
  } catch {
    return JSON.parse(JSON.stringify(x ?? null));
  }
}
function set(obj, path, value) {
  const next = deepClone(obj || {});
  const parts = String(path || "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cur = next;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const k = parts[i];
    if (cur[k] == null) {
      const nk = parts[i + 1];
      cur[k] = String(Number(nk)) === nk ? [] : {};
    }
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
  return next;
}
function normalizeFlags(flags) {
  const f = flags || {};
  return {
    importsEnabled: f?.importsEnabled ?? true,
    animalsImportEnabled: f?.animalsImportEnabled ?? true,
    allowDraftGen: f?.importsAllowDraftGen ?? true,
    allowLinking: f?.importsAllowLinking ?? true,
    familyFundMode: f?.familyFundMode ?? false,
  };
}

/* --------------------------- Fallback parser -------------------------------- */
function fallbackAnimalParse({ text = "", url = "", filename = "" }) {
  const log = [];
  const lc = String(text || "").toLowerCase();
  const guessType =
    (lc.includes("chicken") && "chicken") ||
    (lc.includes("goat") && "goat") ||
    (lc.includes("sheep") && "sheep") ||
    (lc.includes("cattle") && "cattle") ||
    (lc.includes("cow") && "cattle") ||
    "animal";

  const m = lc.match(/\b(\d{1,4})\b/);
  const count = m ? Number(m[1]) : null;

  log.push({
    ts: isoNow(),
    level: "info",
    msg: "fallback parser used",
    data: { guessType, count },
  });

  return {
    extracted: {
      title: filename
        ? `Imported: ${filename}`
        : url
        ? `Imported: ${url}`
        : "Imported Animal Notes",
      summary: text ? String(text).slice(0, 200) : "",
      animalType: guessType,
      count,
      units: guessType === "chicken" ? "birds" : "head",
      notes: text || "",
      tasks: [],
      equipment: [],
      supplies: [],
      tags: [],
    },
    confidence: {
      overall: count != null ? 0.55 : 0.35,
      fields: {
        animalType: 0.45,
        count: count != null ? 0.55 : 0.2,
      },
    },
    parsingLog: log,
  };
}

/* ------------------------ Fallback normalizer -------------------------------- */
function fallbackNormalize(extracted) {
  const e = extracted || {};
  const tasks = Array.isArray(e.tasks) ? e.tasks : [];
  const supplies = Array.isArray(e.supplies) ? e.supplies : [];
  const equipment = Array.isArray(e.equipment) ? e.equipment : [];
  const tags = Array.isArray(e.tags) ? e.tags : [];
  return {
    kind: "animal_import",
    animalType: e.animalType || "animal",
    count: Number.isFinite(Number(e.count)) ? Number(e.count) : null,
    tasks,
    supplies,
    equipment,
    tags,
  };
}

/* ------------------------------ UI atoms ----------------------------------- */
function Btn({ children, onClick, disabled, kind = "default", title }) {
  const cls =
    "ssa-btn " +
    (kind === "primary" ? "ssa-btn-primary " : "") +
    (kind === "danger" ? "ssa-btn-danger " : "") +
    (disabled ? "ssa-btn-disabled " : "");
  return (
    <button
      type="button"
      className={cls.trim()}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}
function Field({ label, children }) {
  return (
    <div className="ssa-field">
      <div className="ssa-label">{label}</div>
      <div className="ssa-control">{children}</div>
    </div>
  );
}
function TextInput({ value, onChange, placeholder = "" }) {
  return (
    <input
      className="ssa-input"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}
function TextArea({ value, onChange, placeholder = "", rows = 4 }) {
  return (
    <textarea
      className="ssa-textarea"
      value={value ?? ""}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}
function NumInput({ value, onChange, placeholder = "" }) {
  const v = value === null || value === undefined ? "" : String(value);
  return (
    <input
      className="ssa-input"
      type="number"
      value={v}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange?.(null);
        return onChange?.(Number(raw));
      }}
    />
  );
}
function Select({ value, onChange, options }) {
  return (
    <select
      className="ssa-select"
      value={value ?? ""}
      onChange={(e) => onChange?.(e.target.value)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
function Divider() {
  return <div className="ssa-divider" />;
}
function Pill({ children }) {
  return <span className="ssa-pill">{children}</span>;
}

/* --------------------------- Main Page ------------------------------------- */
export default function AnimalImportPage() {
  const flags = useMemo(() => normalizeFlags(featureFlags), []);
  const DOMAIN = "animals";

  const [db, setDb] = useState(null);
  const [dbStatus, setDbStatus] = useState({ ok: false, msg: "DB not loaded" });

  // Wizard state
  const steps = useMemo(
    () => [
      { key: "source", title: "1) Source" },
      { key: "preview", title: "2) Parse Preview" },
      { key: "normalize", title: "3) Normalize" },
      { key: "link", title: "4) Link/Map" },
      { key: "save", title: "5) Save" },
      { key: "draft", title: "6) Generate Draft" },
    ],
    []
  );
  const [stepIdx, setStepIdx] = useState(0);

  // Source input
  const [sourceKind, setSourceKind] = useState("url"); // url|text|file
  const [url, setUrl] = useState("");
  const [text, setText] = useState("");
  const [fileObj, setFileObj] = useState(null);
  const [fileText, setFileText] = useState("");
  const [sourceError, setSourceError] = useState("");

  // Pipeline artifacts
  const [rawRecord, setRawRecord] = useState(null); // ImportRaw
  const [parsed, setParsed] = useState(null); // { extracted, confidence, parsingLog }
  const [normalized, setNormalized] = useState(null); // ImportNormalized
  const [linkMap, setLinkMap] = useState(null); // LinkMap

  // Validation + dirty tracking + patches
  const [patches, setPatches] = useState([]); // {ts,path,value}
  const [dirty, setDirty] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [saveState, setSaveState] = useState({ status: "idle", err: null }); // idle|saving|saved|error
  const [logs, setLogs] = useState([]);

  // Retry / optimistic state
  const inflightRef = useRef({ saving: false });

  // Draft output
  const [draftState, setDraftState] = useState({
    status: "idle",
    err: null,
    draft: null,
  });

  // Debug panels
  const [showContracts, setShowContracts] = useState(false);
  const [showDebug, setShowDebug] = useState(false);

  const eventCatalog = useMemo(() => buildEventCatalog(DOMAIN), [DOMAIN]);

  // Load DB
  useEffect(() => {
    let mounted = true;
    (async () => {
      const d = await getDbSafe();
      if (!mounted) return;
      if (!d) {
        setDb(null);
        setDbStatus({
          ok: false,
          msg: "Dexie DB not found (persistence disabled).",
        });
        return;
      }
      setDb(d);
      setDbStatus({ ok: true, msg: "Dexie DB loaded." });
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // ✅ BONUS: import.page.opened (fires on mount)
  useEffect(() => {
    emitImportEvent(IMPORT_EVENTS.PAGE_OPENED, { domain: DOMAIN });
  }, [DOMAIN]);

  // Helper: add log
  function addLog(level, msg, data) {
    const entry = { ts: isoNow(), level, msg, data };
    setLogs((prev) => [...prev, entry]);
  }

  // Helper: validation
  function validateStep(idx) {
    const key = steps[idx]?.key;
    if (key === "source") {
      if (sourceKind === "url" && !url.trim())
        return { ok: false, msg: "Please paste a URL." };
      if (sourceKind === "text" && !text.trim())
        return { ok: false, msg: "Please paste text." };
      if (sourceKind === "file" && !fileObj)
        return { ok: false, msg: "Please choose a file." };
      return { ok: true, msg: "" };
    }
    if (key === "preview") {
      if (!parsed?.extracted)
        return { ok: false, msg: "Parse preview not available yet." };
      return { ok: true, msg: "" };
    }
    if (key === "normalize") {
      if (!normalized?.normalized)
        return { ok: false, msg: "Normalization not available yet." };
      return { ok: true, msg: "" };
    }
    if (key === "link") {
      if (!flags.allowLinking) return { ok: true, msg: "" };
      if (!linkMap?.links) return { ok: false, msg: "Link map not set." };
      return { ok: true, msg: "" };
    }
    if (key === "save") {
      if (!rawRecord || !normalized)
        return { ok: false, msg: "Nothing to save yet." };
      return { ok: true, msg: "" };
    }
    return { ok: true, msg: "" };
  }

  // Step navigation
  function goNext() {
    const v = validateStep(stepIdx);
    if (!v.ok) {
      setSourceError(v.msg);
      return;
    }
    setSourceError("");
    setStepIdx((i) => Math.min(i + 1, steps.length - 1));
  }
  function goBack() {
    setSourceError("");
    setStepIdx((i) => Math.max(i - 1, 0));
  }

  // Read file content
  async function handleFile(file) {
    setFileObj(file || null);
    setFileText("");
    if (!file) return;

    try {
      const txt = await file.text();
      setFileText(txt);
      addLog("info", "File loaded", {
        name: file.name,
        size: file.size,
        type: file.type,
      });
    } catch (e) {
      console.warn(e);
      addLog("error", "Failed reading file", { err: String(e) });
    }
  }

  // CREATE ImportRaw
  function buildRawRecord() {
    const rawId = rawRecord?.id || uid("importRaw");
    const createdAtISO = rawRecord?.createdAtISO || isoNow();
    const updatedAtISO = isoNow();

    const src =
      sourceKind === "url"
        ? { kind: "url", url: url.trim() }
        : sourceKind === "text"
        ? { kind: "text" }
        : {
            kind: "file",
            filename: fileObj?.name || "",
            mime: fileObj?.type || "",
          };

    const rr = {
      id: rawId,
      domain: DOMAIN,
      createdAtISO,
      updatedAtISO,
      source: src,
      raw: {
        text: sourceKind === "text" ? text : "",
        fileText: sourceKind === "file" ? fileText : "",
        fileMeta:
          sourceKind === "file"
            ? { name: fileObj?.name, size: fileObj?.size, type: fileObj?.type }
            : null,
      },
      parser: { name: "animalParser", version: "1" },
      parsingLog: [],
    };

    return rr;
  }

  // 1) Receive source → ✅ emit import.received
  function receiveImport() {
    const rr = buildRawRecord();
    setRawRecord(rr);
    setParsed(null);
    setNormalized(null);
    setLinkMap(null);
    setPatches([]);
    setDirty(false);
    setSaveState({ status: "idle", err: null });
    setDraftState({ status: "idle", err: null, draft: null });
    setLastSaved(null);
    setLogs([]);

    // ✅ import.received (fires here)
    emitImportEvent(IMPORT_EVENTS.RECEIVED, {
      domain: DOMAIN,
      rawId: rr.id,
      source: rr.source,
    });

    addLog("info", "Import received", { rawId: rr.id, source: rr.source });
    setStepIdx(1); // move to preview
  }

  // 2) Parse preview (URL/text/fileText) → ✅ emit import.parsed
  async function runParse() {
    const rr = rawRecord || buildRawRecord();
    setRawRecord(rr);

    const inputText =
      rr.source?.kind === "text"
        ? rr.raw?.text || ""
        : rr.source?.kind === "file"
        ? rr.raw?.fileText || ""
        : "";

    const ctx = {
      domain: DOMAIN,
      url: rr.source?.kind === "url" ? rr.source?.url || "" : url.trim(),
      text: inputText || text,
      filename:
        rr.source?.kind === "file"
          ? rr.source?.filename || fileObj?.name || ""
          : "",
    };

    addLog("info", "Parsing started", { ctx });

    let out;
    try {
      if (animalParser && typeof animalParser.parse === "function") {
        out = await animalParser.parse(ctx);
      } else if (typeof animalParser === "function") {
        out = await animalParser(ctx);
      } else {
        out = fallbackAnimalParse(ctx);
      }
    } catch (e) {
      console.warn(e);
      addLog("error", "Parser crashed, using fallback parser", {
        err: String(e),
      });
      out = fallbackAnimalParse(ctx);
    }

    const merged = {
      extracted: out?.extracted || {},
      confidence: out?.confidence || { overall: 0.3, fields: {} },
      parsingLog: Array.isArray(out?.parsingLog) ? out.parsingLog : [],
    };

    // attach parsing log to raw record
    const rr2 = deepClone(rr);
    rr2.updatedAtISO = isoNow();
    rr2.parsingLog = [...(rr2.parsingLog || []), ...merged.parsingLog];

    setRawRecord(rr2);
    setParsed(merged);

    // ✅ import.parsed (fires here)
    emitImportEvent(IMPORT_EVENTS.PARSED, {
      domain: DOMAIN,
      rawId: rr2.id,
      extracted: merged.extracted,
      confidence: merged.confidence,
    });

    addLog("info", "Parsing complete", {
      extractedKeys: Object.keys(merged.extracted || {}),
      confidence: merged.confidence,
    });
  }

  // Update extracted fields + patch tracking
  function updateExtracted(path, value) {
    setParsed((prev) => {
      const next = deepClone(prev || {});
      next.extracted = set(next.extracted || {}, path, value);
      return next;
    });

    setPatches((prev) => [
      ...prev,
      { ts: isoNow(), path: `extracted.${path}`, value },
    ]);
    setDirty(true);
  }

  // 3) Normalize → ✅ emit import.normalized
  async function runNormalize() {
    const rr = rawRecord || buildRawRecord();
    const p =
      parsed ||
      fallbackAnimalParse({
        text: text || fileText || "",
        url: url.trim(),
        filename: fileObj?.name || "",
      });

    const baseNormId = normalized?.id || uid("importNorm");
    const createdAtISO = normalized?.createdAtISO || isoNow();
    const updatedAtISO = isoNow();

    let normCore;
    try {
      if (
        ImportNormalizer &&
        typeof ImportNormalizer.normalizeAnimals === "function"
      ) {
        normCore = await ImportNormalizer.normalizeAnimals(p.extracted, {
          domain: DOMAIN,
        });
      } else if (
        ImportNormalizer &&
        typeof ImportNormalizer.normalize === "function"
      ) {
        normCore = await ImportNormalizer.normalize(p.extracted, {
          domain: DOMAIN,
        });
      } else {
        normCore = fallbackNormalize(p.extracted);
      }
    } catch (e) {
      console.warn(e);
      addLog("warn", "Normalizer failed, using fallback", { err: String(e) });
      normCore = fallbackNormalize(p.extracted);
    }

    const norm = {
      id: baseNormId,
      rawId: rr.id,
      domain: DOMAIN,
      createdAtISO,
      updatedAtISO,
      source: {
        kind: rr.source?.kind,
        url: rr.source?.url,
        filename: rr.source?.filename,
      },
      confidence: p.confidence || { overall: 0.3, fields: {} },
      extracted: p.extracted || {},
      normalized: normCore,
      edits: { patches: deepClone(patches || []) },
    };

    setNormalized(norm);

    // ✅ import.normalized (fires here)
    emitImportEvent(IMPORT_EVENTS.NORMALIZED, {
      domain: DOMAIN,
      rawId: rr.id,
      normId: norm.id,
      confidence: norm.confidence,
      normalized: norm.normalized,
    });

    addLog("info", "Normalization complete", {
      normId: norm.id,
      animalType: norm.normalized?.animalType,
    });

    // pre-create empty link map if needed
    if (flags.allowLinking) {
      setLinkMap((prev) => {
        if (prev?.id) return prev;
        return {
          id: uid("linkMap"),
          rawId: rr.id,
          normId: norm.id,
          domain: DOMAIN,
          createdAtISO: isoNow(),
          updatedAtISO: isoNow(),
          links: { inventory: [], equipment: [], tags: [] },
        };
      });
    }
  }

  // 4) Link/Map handlers
  function ensureLinkMap() {
    setLinkMap((prev) => {
      if (prev?.links) return prev;
      const rr = rawRecord || buildRawRecord();
      const nid = normalized?.id || uid("importNorm");
      return {
        id: uid("linkMap"),
        rawId: rr.id,
        normId: nid,
        domain: DOMAIN,
        createdAtISO: isoNow(),
        updatedAtISO: isoNow(),
        links: { inventory: [], equipment: [], tags: [] },
      };
    });
  }

  function addInventoryLink() {
    ensureLinkMap();
    setLinkMap((prev) => {
      const next = deepClone(prev);
      next.updatedAtISO = isoNow();
      next.links.inventory = next.links.inventory || [];
      next.links.inventory.push({
        from: "supplies[]",
        to: "",
        qty: null,
        unit: "",
        confidence: 0.5,
      });
      return next;
    });
    setDirty(true);
  }
  function addEquipmentLink() {
    ensureLinkMap();
    setLinkMap((prev) => {
      const next = deepClone(prev);
      next.updatedAtISO = isoNow();
      next.links.equipment = next.links.equipment || [];
      next.links.equipment.push({
        from: "equipment[]",
        to: "",
        confidence: 0.5,
      });
      return next;
    });
    setDirty(true);
  }
  function addTagLink() {
    ensureLinkMap();
    setLinkMap((prev) => {
      const next = deepClone(prev);
      next.updatedAtISO = isoNow();
      next.links.tags = next.links.tags || [];
      next.links.tags.push({ from: "tags[]", to: "", confidence: 0.5 });
      return next;
    });
    setDirty(true);
  }

  function updateLink(kind, idx, field, value) {
    setLinkMap((prev) => {
      const next = deepClone(prev || {});
      next.links = next.links || { inventory: [], equipment: [], tags: [] };
      const arr = next.links[kind] || [];
      if (!arr[idx]) return prev;
      arr[idx] = { ...arr[idx], [field]: value };
      next.links[kind] = arr;
      next.updatedAtISO = isoNow();
      return next;
    });
    setDirty(true);
  }

  function removeLink(kind, idx) {
    // eslint-disable-next-line no-alert
    if (!window.confirm("Delete this link?")) return;
    setLinkMap((prev) => {
      const next = deepClone(prev || {});
      const arr = next?.links?.[kind];
      if (!Array.isArray(arr)) return prev;
      arr.splice(idx, 1);
      next.updatedAtISO = isoNow();
      return next;
    });
    setDirty(true);
  }

  // ✅ import.linked — fires here
  function finalizeLinks() {
    if (!flags.allowLinking) return;
    const lm = linkMap;
    const rr = rawRecord;
    if (!lm || !rr) return;

    emitImportEvent(IMPORT_EVENTS.LINKED, {
      domain: DOMAIN,
      rawId: rr.id,
      normId: lm.normId,
      linkMapId: lm.id,
      links: lm.links,
    });

    addLog("info", "Linking finalized", { linkMapId: lm.id });
    setStepIdx(4); // to save
  }

  // 5) Save (Dexie raw + normalized + linkMap + logs) with retry state
  async function saveAll() {
    if (inflightRef.current.saving) return;
    inflightRef.current.saving = true;
    setSaveState({ status: "saving", err: null });

    const rr = rawRecord || buildRawRecord();
    const p = parsed;
    const norm = normalized;
    const lm = linkMap;

    // optimistic: mark lastSaved locally before DB writes succeed
    const optimistic = isoNow();
    setLastSaved(optimistic);

    try {
      // Store logs into rr.parsingLog as well (non-destructive)
      const rr2 = deepClone(rr);
      rr2.updatedAtISO = isoNow();
      rr2.parsingLog = [...(rr2.parsingLog || []), ...(logs || [])];

      setRawRecord(rr2);

      if (!db) {
        setSaveState({
          status: "error",
          err: "Dexie DB not available. (Persistence disabled.)",
        });
        inflightRef.current.saving = false;
        return;
      }

      const canRaw = !!db.importRaw;
      const canNorm = !!db.importNormalized;
      const canLinks = !!db.importLinkMaps;
      const canLogs = !!db.importLogs;

      if (!canRaw || !canNorm || !canLinks || !canLogs) {
        setSaveState({
          status: "error",
          err: "DB tables not found. Add schema snippet (importRaw/importNormalized/importLinkMaps/importLogs) and restart dev server.",
        });
        inflightRef.current.saving = false;
        return;
      }

      await db.importRaw.put(rr2);

      if (norm) {
        const n2 = deepClone(norm);
        n2.updatedAtISO = isoNow();
        n2.edits = { patches: deepClone(patches || []) };
        await db.importNormalized.put(n2);
      } else if (p) {
        const fallbackNorm = {
          id: uid("importNorm"),
          rawId: rr2.id,
          domain: DOMAIN,
          createdAtISO: isoNow(),
          updatedAtISO: isoNow(),
          source: rr2.source,
          confidence: p.confidence || { overall: 0.3, fields: {} },
          extracted: p.extracted || {},
          normalized: fallbackNormalize(p.extracted || {}),
          edits: { patches: deepClone(patches || []) },
        };
        setNormalized(fallbackNorm);
        await db.importNormalized.put(fallbackNorm);
      }

      const nId = normalized?.id || lm?.normId || null;
      const l2 =
        lm && lm.links
          ? {
              ...deepClone(lm),
              updatedAtISO: isoNow(),
              normId: nId || lm.normId,
            }
          : {
              id: uid("linkMap"),
              rawId: rr2.id,
              normId: nId || uid("importNorm"),
              domain: DOMAIN,
              createdAtISO: isoNow(),
              updatedAtISO: isoNow(),
              links: { inventory: [], equipment: [], tags: [] },
            };
      setLinkMap(l2);
      await db.importLinkMaps.put(l2);

      const logRows = (logs || []).map((l) => ({
        id: uid("importLog"),
        domain: DOMAIN,
        rawId: rr2.id,
        normId: nId || null,
        linkMapId: l2.id,
        ts: l.ts || isoNow(),
        level: l.level || "info",
        msg: l.msg || "",
        data: l.data ?? null,
      }));
      for (const row of logRows) {
        // eslint-disable-next-line no-await-in-loop
        await db.importLogs.put(row);
      }

      setSaveState({ status: "saved", err: null });
      setDirty(false);

      addLog("info", "Saved to Dexie", {
        rawId: rr2.id,
        normId: nId,
        linkMapId: l2.id,
        at: optimistic,
      });

      // ✅ inventory.shortage.detected — fires here (heuristic)
      const shortages = [];
      const invLinks = l2?.links?.inventory || [];
      invLinks.forEach((x) => {
        if (x && x.to && x.qty != null && Number(x.qty) > 0) {
          shortages.push({ item: x.to, neededQty: x.qty, unit: x.unit || "" });
        }
      });
      if (shortages.length) {
        emitImportEvent(IMPORT_EVENTS.INVENTORY_SHORTAGE, {
          domain: DOMAIN,
          rawId: rr2.id,
          normId: nId,
          shortages,
        });
      }
    } catch (e) {
      console.warn(e);
      setSaveState({ status: "error", err: String(e) });
    } finally {
      inflightRef.current.saving = false;
    }
  }

  async function retrySave() {
    await saveAll();
  }

  // 6) Generate session draft → ✅ session.draft.created
  async function generateDraft() {
    if (!flags.allowDraftGen) {
      setDraftState({
        status: "error",
        err: "Draft generation disabled by featureFlags.",
        draft: null,
      });
      return;
    }

    const rr = rawRecord;
    const norm = normalized;
    const lm = linkMap;

    if (!rr || !norm) {
      setDraftState({
        status: "error",
        err: "Missing raw/normalized records. Run Parse + Normalize first.",
        draft: null,
      });
      return;
    }

    setDraftState({ status: "generating", err: null, draft: null });
    addLog("info", "Draft generation started", { normId: norm.id });

    try {
      let draft = null;

      if (
        AnimalSessionEngine &&
        typeof AnimalSessionEngine.createDraftFromImport === "function"
      ) {
        draft = await AnimalSessionEngine.createDraftFromImport({
          raw: rr,
          normalized: norm,
          links: lm,
        });
      } else if (
        AnimalStockingTemplate &&
        typeof AnimalStockingTemplate.resolve === "function"
      ) {
        draft = await AnimalStockingTemplate.resolve({
          raw: rr,
          normalized: norm,
          links: lm,
        });
      } else {
        const e = norm.extracted || {};
        const n = norm.normalized || {};
        const invLinks = lm?.links?.inventory || [];
        const eqLinks = lm?.links?.equipment || [];
        const tagLinks = lm?.links?.tags || [];

        draft = {
          id: uid("animalDraft"),
          domain: DOMAIN,
          title: e.title || `Animal Plan: ${n.animalType || "animals"}`,
          summary:
            e.summary ||
            `Imported animal notes normalized for ${n.animalType || "animals"}${
              n.count ? ` (${n.count})` : ""
            }.`,
          assumptions: [
            "Counts and supplies may require confirmation.",
            "Link mappings are user-provided and may need refinement.",
          ],
          sections: [
            {
              id: uid("sec"),
              title: "Overview",
              bullets: [
                `Animal type: ${n.animalType || "animal"}`,
                `Count: ${n.count != null ? n.count : "unknown"} ${
                  e.units || ""
                }`.trim(),
                e.notes
                  ? `Notes: ${String(e.notes).slice(0, 160)}`
                  : "Notes: (none)",
              ],
            },
            {
              id: uid("sec"),
              title: "Supplies & Storehouse Links",
              bullets: invLinks.length
                ? invLinks.map((x) =>
                    `• ${x.to || "(unmapped)"} — needed ${x.qty ?? "?"} ${
                      x.unit || ""
                    }`.trim()
                  )
                : [
                    "No inventory links yet. Add supplies mappings in Link/Map step.",
                  ],
            },
            {
              id: uid("sec"),
              title: "Equipment Links",
              bullets: eqLinks.length
                ? eqLinks.map(
                    (x) =>
                      `• ${x.to || "(unmapped)"} (from ${
                        x.from || "equipment"
                      })`
                  )
                : [
                    "No equipment links yet. Add equipment mappings in Link/Map step.",
                  ],
            },
            {
              id: uid("sec"),
              title: "Tags",
              bullets: tagLinks.length
                ? tagLinks.map((x) => `#${x.to || "(unmapped)"}`)
                : ["No tags linked yet."],
            },
          ],
          tasks: (Array.isArray(n.tasks) ? n.tasks : []).map((t, i) => ({
            id: uid(`task_${i}`),
            label: typeof t === "string" ? t : t?.label || `Task ${i + 1}`,
            priority: t?.priority || "med",
            durationMin: t?.durationMin || 20,
            dueISO: t?.dueISO || "",
          })),
          inventoryAlerts: invLinks
            .filter((x) => x?.qty != null && Number(x.qty) > 0)
            .map((x, i) => ({
              id: uid(`alert_${i}`),
              item: x.to || "Unknown item",
              neededQty: x.qty,
              unit: x.unit || "",
              severity: Number(x.qty) >= 5 ? "high" : "med",
              suggestion:
                "Confirm on-hand quantity and restock if below minimum.",
            })),
          healthReminders: [
            {
              id: uid("rem"),
              label: `Check ${n.animalType || "animals"} health routine`,
              cadence: "weekly",
              nextDueISO: "",
            },
          ],
          meta: {
            rawId: rr.id,
            normId: norm.id,
            linkMapId: lm?.id || null,
            createdAtISO: isoNow(),
            via: "fallbackDraftBuilder",
          },
        };
      }

      setDraftState({ status: "ready", err: null, draft });

      // ✅ session.draft.created — fires here
      emitImportEvent(IMPORT_EVENTS.SESSION_DRAFT_CREATED, {
        domain: DOMAIN,
        rawId: rr.id,
        normId: norm.id,
        linkMapId: lm?.id || null,
        draftId: draft?.id || null,
      });

      addLog("info", "Draft created", {
        draftId: draft?.id,
        via: draft?.meta?.via || "engine",
      });

      if (flags.familyFundMode) {
        // TODO: Hub export integration (do not implement here)
        addLog(
          "info",
          "familyFundMode enabled: draft ready for optional Hub export (TODO)",
          {}
        );
      }
    } catch (e) {
      console.warn(e);
      setDraftState({ status: "error", err: String(e), draft: null });
      addLog("error", "Draft generation failed", { err: String(e) });
    }
  }

  /* ---------------------------- Render Panels ------------------------------ */
  const activeKey = steps[stepIdx]?.key;

  function renderStepHeader() {
    return (
      <div className="ssa-topbar">
        <div className="ssa-topbar-left">
          <div className="ssa-h1">Animals Import</div>
          <div className="ssa-sub">
            <Pill>DB: {dbStatus.ok ? "OK" : "OFF"}</Pill>
            <Pill>Linking: {flags.allowLinking ? "ON" : "OFF"}</Pill>
            <Pill>Draft: {flags.allowDraftGen ? "ON" : "OFF"}</Pill>
          </div>
        </div>
        <div className="ssa-topbar-right">
          <Btn onClick={() => setShowContracts((v) => !v)}>
            {showContracts ? "Hide" : "Show"} Contracts
          </Btn>
          <Btn onClick={() => setShowDebug((v) => !v)}>
            {showDebug ? "Hide" : "Show"} Debug
          </Btn>
        </div>
      </div>
    );
  }

  function renderWizardNav() {
    return (
      <div className="ssa-wiznav">
        {steps.map((s, i) => {
          const isActive = i === stepIdx;
          const isDone = i < stepIdx;
          return (
            <button
              key={s.key}
              type="button"
              className={`ssa-wizstep ${isActive ? "active" : ""} ${
                isDone ? "done" : ""
              }`.trim()}
              onClick={() => setStepIdx(i)}
              title={s.title}
            >
              {s.title}
            </button>
          );
        })}
      </div>
    );
  }

  function renderControls() {
    const v = validateStep(stepIdx);
    return (
      <div className="ssa-controls">
        <div className="ssa-left">
          <Btn onClick={goBack} disabled={stepIdx === 0}>
            Back
          </Btn>
          <Btn onClick={goNext} disabled={stepIdx === steps.length - 1}>
            Next
          </Btn>
          {!v.ok ? <span className="ssa-warn">{v.msg}</span> : null}
        </div>

        <div className="ssa-right">
          {dirty ? (
            <span className="ssa-dirty">Unsaved changes</span>
          ) : (
            <span className="ssa-muted">No pending changes</span>
          )}
          {lastSaved ? (
            <span className="ssa-muted">Last saved: {lastSaved}</span>
          ) : null}
        </div>
      </div>
    );
  }

  function renderSourceStep() {
    return (
      <div className="ssa-card">
        <div className="ssa-card-title">Source</div>

        <Field label="Import type">
          <Select
            value={sourceKind}
            onChange={(v) => setSourceKind(v)}
            options={[
              { value: "url", label: "URL" },
              { value: "text", label: "Text" },
              { value: "file", label: "File" },
            ]}
          />
        </Field>

        {sourceKind === "url" ? (
          <Field label="Paste URL">
            <TextInput
              value={url}
              onChange={setUrl}
              placeholder="https://example.com/animal-notes"
            />
          </Field>
        ) : null}

        {sourceKind === "text" ? (
          <Field label="Paste text">
            <TextArea
              value={text}
              onChange={setText}
              placeholder="Paste animal notes, tasks, feed schedule, etc."
              rows={8}
            />
          </Field>
        ) : null}

        {sourceKind === "file" ? (
          <Field label="Choose file">
            <input
              type="file"
              onChange={(e) => handleFile(e.target.files?.[0] || null)}
              style={{ display: "block" }}
            />
            {fileObj ? (
              <div className="ssa-muted" style={{ marginTop: 6 }}>
                Loaded: <b>{fileObj.name}</b> ({fileObj.type || "unknown"},{" "}
                {fileObj.size} bytes)
              </div>
            ) : null}
            {fileText ? (
              <div className="ssa-muted" style={{ marginTop: 6 }}>
                Preview: {String(fileText).slice(0, 200)}…
              </div>
            ) : null}
          </Field>
        ) : null}

        {sourceError ? <div className="ssa-error">{sourceError}</div> : null}

        <div className="ssa-row">
          <Btn kind="primary" onClick={receiveImport}>
            Receive Import
          </Btn>
        </div>

        <div className="ssa-muted" style={{ marginTop: 8 }}>
          After receiving, SSA emits <code>{IMPORT_EVENTS.RECEIVED}</code> and
          moves to parse preview.
        </div>
      </div>
    );
  }

  function renderPreviewStep() {
    const e = parsed?.extracted || {};
    const c = parsed?.confidence || {};
    return (
      <div className="ssa-grid">
        <div className="ssa-card">
          <div className="ssa-card-title">Parse Preview</div>

          <div className="ssa-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Btn kind="primary" onClick={runParse}>
              Run Parser
            </Btn>
            <Btn
              onClick={() => {
                if (parsed?.extracted) setStepIdx(2);
              }}
              disabled={!parsed?.extracted}
            >
              Continue to Normalize
            </Btn>
          </div>

          <Divider />

          <Field label="Title">
            <TextInput
              value={e.title || ""}
              onChange={(v) => updateExtracted("title", v)}
              placeholder="Imported title"
            />
          </Field>

          <Field label="Summary">
            <TextArea
              value={e.summary || ""}
              onChange={(v) => updateExtracted("summary", v)}
              rows={3}
            />
          </Field>

          <Field label="Animal Type">
            <Select
              value={e.animalType || "animal"}
              onChange={(v) => updateExtracted("animalType", v)}
              options={[
                { value: "animal", label: "animal" },
                { value: "chicken", label: "chicken" },
                { value: "goat", label: "goat" },
                { value: "sheep", label: "sheep" },
                { value: "cattle", label: "cattle" },
                { value: "rabbit", label: "rabbit" },
                { value: "turkey", label: "turkey" },
              ]}
            />
          </Field>

          <Field label="Count">
            <NumInput
              value={e.count ?? null}
              onChange={(v) => updateExtracted("count", v)}
              placeholder="e.g. 12"
            />
          </Field>

          <Field label="Units">
            <TextInput
              value={e.units || ""}
              onChange={(v) => updateExtracted("units", v)}
              placeholder="head / birds"
            />
          </Field>

          <Field label="Notes">
            <TextArea
              value={e.notes || ""}
              onChange={(v) => updateExtracted("notes", v)}
              rows={6}
            />
          </Field>

          <Divider />

          <div className="ssa-muted">
            Confidence: <b>{Number(c.overall ?? 0).toFixed(2)}</b>
            <div className="ssa-muted" style={{ marginTop: 6 }}>
              Emits <code>{IMPORT_EVENTS.PARSED}</code> when parsing completes.
            </div>
          </div>
        </div>

        <div className="ssa-card">
          <div className="ssa-card-title">Raw + Parsing Output</div>
          <div className="ssa-muted">
            Raw ID: <b>{rawRecord?.id || "(none)"}</b>
          </div>
          <pre className="ssa-pre">
            {JSON.stringify({ rawRecord, parsed }, null, 2)}
          </pre>
        </div>
      </div>
    );
  }

  function renderNormalizeStep() {
    const n = normalized;
    return (
      <div className="ssa-grid">
        <div className="ssa-card">
          <div className="ssa-card-title">Normalize (SSA-Owned)</div>

          <div className="ssa-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Btn
              kind="primary"
              onClick={runNormalize}
              disabled={!parsed?.extracted}
            >
              Normalize
            </Btn>
            <Btn
              onClick={() => setStepIdx(flags.allowLinking ? 3 : 4)}
              disabled={!normalized?.normalized}
            >
              Continue
            </Btn>
          </div>

          <Divider />

          {!n ? (
            <div className="ssa-muted">
              Run Normalize to create the SSA-owned normalized record.
            </div>
          ) : (
            <>
              <div className="ssa-muted">
                Norm ID: <b>{n.id}</b> (rawId: {n.rawId})
              </div>
              <div className="ssa-muted">
                Animal: <b>{n.normalized?.animalType}</b> • Count:{" "}
                <b>{n.normalized?.count ?? "?"}</b>
              </div>
              <div className="ssa-muted" style={{ marginTop: 6 }}>
                Emits <code>{IMPORT_EVENTS.NORMALIZED}</code> after
                normalization.
              </div>
              <Divider />
              <pre className="ssa-pre">{JSON.stringify(n, null, 2)}</pre>
            </>
          )}
        </div>

        <div className="ssa-card">
          <div className="ssa-card-title">Changes / Patches</div>
          <div className="ssa-muted">
            {patches.length} patch(es) • Dirty: <b>{dirty ? "YES" : "NO"}</b>
          </div>
          <pre className="ssa-pre">{JSON.stringify(patches, null, 2)}</pre>
        </div>
      </div>
    );
  }

  function renderLinkStep() {
    if (!flags.allowLinking) {
      return (
        <div className="ssa-card">
          <div className="ssa-card-title">Linking Disabled</div>
          <div className="ssa-muted">
            featureFlags.importsAllowLinking is off.
          </div>
          <Btn kind="primary" onClick={() => setStepIdx(4)}>
            Continue to Save
          </Btn>
        </div>
      );
    }

    const lm = linkMap || { links: { inventory: [], equipment: [], tags: [] } };
    const inv = lm.links?.inventory || [];
    const eq = lm.links?.equipment || [];
    const tags = lm.links?.tags || [];

    return (
      <div className="ssa-card">
        <div className="ssa-card-title">Link / Map to SSA Data</div>
        <div className="ssa-muted">
          Map supplies/equipment/tags to SSA entities. (This is editable and
          saved to Dexie.)
        </div>

        <Divider />

        <div className="ssa-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Btn onClick={addInventoryLink}>+ Inventory Link</Btn>
          <Btn onClick={addEquipmentLink}>+ Equipment Link</Btn>
          <Btn onClick={addTagLink}>+ Tag Link</Btn>
          <Btn kind="primary" onClick={finalizeLinks}>
            Finalize Links
          </Btn>
        </div>

        <div className="ssa-muted" style={{ marginTop: 8 }}>
          Emits <code>{IMPORT_EVENTS.LINKED}</code> when you finalize mappings.
        </div>

        <Divider />

        <div className="ssa-subtitle">Inventory Links</div>
        {inv.length === 0 ? (
          <div className="ssa-muted">No inventory links yet.</div>
        ) : null}
        {inv.map((x, i) => (
          <div
            key={`inv_${i}`}
            className="ssa-row"
            style={{ gap: 8, flexWrap: "wrap" }}
          >
            <TextInput
              value={x.from || ""}
              onChange={(v) => updateLink("inventory", i, "from", v)}
              placeholder="from (e.g. supplies[0])"
            />
            <TextInput
              value={x.to || ""}
              onChange={(v) => updateLink("inventory", i, "to", v)}
              placeholder="to (inventory id or name)"
            />
            <NumInput
              value={x.qty ?? null}
              onChange={(v) => updateLink("inventory", i, "qty", v)}
              placeholder="qty"
            />
            <TextInput
              value={x.unit || ""}
              onChange={(v) => updateLink("inventory", i, "unit", v)}
              placeholder="unit"
            />
            <NumInput
              value={x.confidence ?? 0.5}
              onChange={(v) => updateLink("inventory", i, "confidence", v)}
              placeholder="confidence"
            />
            <Btn kind="danger" onClick={() => removeLink("inventory", i)}>
              Delete
            </Btn>
          </div>
        ))}

        <Divider />

        <div className="ssa-subtitle">Equipment Links</div>
        {eq.length === 0 ? (
          <div className="ssa-muted">No equipment links yet.</div>
        ) : null}
        {eq.map((x, i) => (
          <div
            key={`eq_${i}`}
            className="ssa-row"
            style={{ gap: 8, flexWrap: "wrap" }}
          >
            <TextInput
              value={x.from || ""}
              onChange={(v) => updateLink("equipment", i, "from", v)}
              placeholder="from (e.g. equipment[0])"
            />
            <TextInput
              value={x.to || ""}
              onChange={(v) => updateLink("equipment", i, "to", v)}
              placeholder="to (equipment id or name)"
            />
            <NumInput
              value={x.confidence ?? 0.5}
              onChange={(v) => updateLink("equipment", i, "confidence", v)}
              placeholder="confidence"
            />
            <Btn kind="danger" onClick={() => removeLink("equipment", i)}>
              Delete
            </Btn>
          </div>
        ))}

        <Divider />

        <div className="ssa-subtitle">Tag Links</div>
        {tags.length === 0 ? (
          <div className="ssa-muted">No tag links yet.</div>
        ) : null}
        {tags.map((x, i) => (
          <div
            key={`tag_${i}`}
            className="ssa-row"
            style={{ gap: 8, flexWrap: "wrap" }}
          >
            <TextInput
              value={x.from || ""}
              onChange={(v) => updateLink("tags", i, "from", v)}
              placeholder="from (e.g. tags[0])"
            />
            <TextInput
              value={x.to || ""}
              onChange={(v) => updateLink("tags", i, "to", v)}
              placeholder="to (tag id or name)"
            />
            <NumInput
              value={x.confidence ?? 0.5}
              onChange={(v) => updateLink("tags", i, "confidence", v)}
              placeholder="confidence"
            />
            <Btn kind="danger" onClick={() => removeLink("tags", i)}>
              Delete
            </Btn>
          </div>
        ))}

        <Divider />
        <pre className="ssa-pre">{JSON.stringify(linkMap, null, 2)}</pre>
      </div>
    );
  }

  function renderSaveStep() {
    return (
      <div className="ssa-grid">
        <div className="ssa-card">
          <div className="ssa-card-title">Save to SSA (Dexie)</div>

          <div className="ssa-muted">
            Saves:
            <ul>
              <li>ImportRaw (source + raw payload + parsingLog)</li>
              <li>ImportNormalized (SSA-owned normalized record)</li>
              <li>LinkMap (mappings to inventory/equipment/tags)</li>
              <li>ImportLogs (pipeline logs)</li>
            </ul>
            Emits <code>{IMPORT_EVENTS.INVENTORY_SHORTAGE}</code> after save
            when heuristic triggers.
          </div>

          <div className="ssa-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Btn
              kind="primary"
              onClick={saveAll}
              disabled={saveState.status === "saving"}
            >
              {saveState.status === "saving" ? "Saving..." : "Save"}
            </Btn>
            {saveState.status === "error" ? (
              <Btn onClick={retrySave}>Retry</Btn>
            ) : null}
            <Btn
              onClick={() => setStepIdx(5)}
              disabled={saveState.status !== "saved" && !dbStatus.ok}
            >
              Continue to Draft
            </Btn>
          </div>

          {saveState.status === "saved" ? (
            <div className="ssa-ok">Saved ✅</div>
          ) : null}
          {saveState.status === "error" ? (
            <div className="ssa-error">Save error: {saveState.err}</div>
          ) : null}
        </div>

        <div className="ssa-card">
          <div className="ssa-card-title">What will be saved</div>
          <pre className="ssa-pre">
            {JSON.stringify(
              { rawRecord, normalized, linkMap, logsCount: logs.length },
              null,
              2
            )}
          </pre>
        </div>
      </div>
    );
  }

  function renderDraftStep() {
    return (
      <div className="ssa-grid">
        <div className="ssa-card">
          <div className="ssa-card-title">Generate Session Draft</div>
          <div className="ssa-muted">
            This produces a <b>resolved human draft object</b> (not metadata).
            If an engine exists it will be used; otherwise a fallback draft
            builder will create a usable draft.
          </div>

          <div className="ssa-row" style={{ gap: 8, flexWrap: "wrap" }}>
            <Btn
              kind="primary"
              onClick={generateDraft}
              disabled={draftState.status === "generating"}
            >
              {draftState.status === "generating"
                ? "Generating..."
                : "Generate Session Draft"}
            </Btn>
          </div>

          <div className="ssa-muted" style={{ marginTop: 8 }}>
            Emits <code>{IMPORT_EVENTS.SESSION_DRAFT_CREATED}</code> after a
            draft is created.
          </div>

          {draftState.status === "error" ? (
            <div className="ssa-error">{draftState.err}</div>
          ) : null}
          {draftState.status === "ready" ? (
            <div className="ssa-ok">Draft created ✅</div>
          ) : null}

          <Divider />

          <div className="ssa-muted">
            This fixes “draft isn’t generating / not human formatting” by
            ensuring the fallback returns a<b> real draft object</b>{" "}
            (title/summary/sections/tasks/alerts/reminders) — not{" "}
            <code>{`{ via:"template", res:null }`}</code>.
          </div>
        </div>

        <div className="ssa-card">
          <div className="ssa-card-title">Draft Output</div>
          <pre className="ssa-pre">
            {JSON.stringify(draftState.draft, null, 2)}
          </pre>
        </div>
      </div>
    );
  }

  function renderContracts() {
    if (!showContracts) return null;
    return (
      <div className="ssa-card">
        <div className="ssa-card-title">Contracts + Events</div>

        <div className="ssa-subtitle">Schemas</div>
        <pre className="ssa-pre">
          {JSON.stringify(
            {
              ImportRaw: ImportRawSchema,
              ImportNormalized: ImportNormalizedSchema,
              LinkMap: LinkMapSchema,
            },
            null,
            2
          )}
        </pre>

        <Divider />

        <div className="ssa-subtitle">
          Events (names + where they fire + payload examples)
        </div>
        <pre className="ssa-pre">{JSON.stringify(eventCatalog, null, 2)}</pre>
      </div>
    );
  }

  function renderDebugPanel() {
    if (!showDebug) return null;
    return (
      <div className="ssa-card">
        <div className="ssa-card-title">Debug</div>
        <div className="ssa-muted">
          Active step: <b>{activeKey}</b> • DB:{" "}
          <b>{dbStatus.ok ? "OK" : "OFF"}</b>
        </div>
        <pre className="ssa-pre">
          {JSON.stringify(
            {
              flags,
              stepIdx,
              sourceKind,
              url,
              file: fileObj?.name,
              dirty,
              saveState,
              draftState,
            },
            null,
            2
          )}
        </pre>
      </div>
    );
  }

  function renderLogs() {
    return (
      <div className="ssa-card">
        <div className="ssa-card-title">Pipeline Logs</div>
        {logs.length === 0 ? (
          <div className="ssa-muted">No logs yet.</div>
        ) : null}
        <div className="ssa-loglist">
          {logs.slice(-50).map((l, i) => (
            <div
              key={`log_${i}`}
              className={`ssa-log ssa-${l.level || "info"}`.trim()}
            >
              <div className="ssa-log-head">
                <span className="ssa-log-level">
                  {String(l.level || "info").toUpperCase()}
                </span>
                <span className="ssa-log-ts">{l.ts}</span>
              </div>
              <div className="ssa-log-msg">{l.msg}</div>
              {l.data != null ? (
                <pre className="ssa-pre-mini">
                  {JSON.stringify(l.data, null, 2)}
                </pre>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    );
  }

  function renderActive() {
    if (!flags.importsEnabled || !flags.animalsImportEnabled) {
      return (
        <div className="ssa-card">
          <div className="ssa-card-title">Imports Disabled</div>
          <div className="ssa-muted">
            Enable <code>importsEnabled</code> and{" "}
            <code>animalsImportEnabled</code> in featureFlags.json.
          </div>
        </div>
      );
    }

    if (activeKey === "source") return renderSourceStep();
    if (activeKey === "preview") return renderPreviewStep();
    if (activeKey === "normalize") return renderNormalizeStep();
    if (activeKey === "link") return renderLinkStep();
    if (activeKey === "save") return renderSaveStep();
    if (activeKey === "draft") return renderDraftStep();
    return <div className="ssa-card">Unknown step</div>;
  }

  return (
    <div className="ssa-root">
      <style>{`
        .ssa-root{padding:14px; max-width:1200px; margin:0 auto; font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;}
        .ssa-topbar{display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px}
        .ssa-h1{font-size:22px; font-weight:900}
        .ssa-sub{display:flex; gap:8px; flex-wrap:wrap; margin-top:6px}
        .ssa-topbar-right{display:flex; gap:8px; flex-wrap:wrap}
        .ssa-pill{border:1px solid #ddd; border-radius:999px; padding:2px 8px; font-size:12px; background:#fafafa}
        .ssa-wiznav{display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px}
        .ssa-wizstep{border:1px solid #ddd; border-radius:10px; padding:8px 10px; background:#fff; cursor:pointer; font-size:12px}
        .ssa-wizstep.active{border-color:#2a6; box-shadow:0 0 0 2px rgba(34,170,102,.15)}
        .ssa-wizstep.done{opacity:.75}
        .ssa-controls{display:flex; justify-content:space-between; gap:10px; margin:10px 0 14px 0; align-items:center; flex-wrap:wrap}
        .ssa-left,.ssa-right{display:flex; gap:10px; align-items:center; flex-wrap:wrap}
        .ssa-dirty{color:#b50; font-weight:800}
        .ssa-muted{color:#666; font-size:13px}
        .ssa-warn{color:#b50; font-weight:700}
        .ssa-ok{color:#1a7; font-weight:800; margin-top:10px}
        .ssa-error{color:#c33; font-weight:800; margin-top:10px}
        .ssa-card{border:1px solid #ddd; border-radius:14px; padding:12px; background:#fff; margin-bottom:12px}
        .ssa-card-title{font-weight:900; margin-bottom:10px}
        .ssa-grid{display:grid; grid-template-columns:1fr 1fr; gap:12px}
        .ssa-field{display:grid; grid-template-columns:140px 1fr; gap:10px; margin:10px 0}
        .ssa-label{font-size:12px; color:#444; padding-top:8px}
        .ssa-input,.ssa-textarea,.ssa-select{width:100%; box-sizing:border-box; border:1px solid #ccc; border-radius:12px; padding:8px 10px; font-size:14px}
        .ssa-textarea{resize:vertical}
        .ssa-btn{border:1px solid #bbb; background:#fff; border-radius:12px; padding:8px 10px; cursor:pointer; font-size:13px}
        .ssa-btn-primary{border-color:#2a6; background:#2a6; color:#fff}
        .ssa-btn-danger{border-color:#c33; background:#c33; color:#fff}
        .ssa-btn-disabled{opacity:.6; cursor:not-allowed}
        .ssa-row{display:flex; align-items:center; gap:10px; margin-top:10px}
        .ssa-divider{height:1px; background:#eee; margin:12px 0}
        .ssa-pre{border:1px solid #eee; border-radius:12px; padding:10px; overflow:auto; background:#0b0b0b; color:#f2f2f2; font-size:12px; max-height:520px}
        .ssa-pre-mini{border:1px solid #222; border-radius:10px; padding:8px; overflow:auto; background:#111; color:#eee; font-size:11px; margin-top:6px}
        .ssa-subtitle{font-weight:900; margin:10px 0 6px 0}
        .ssa-loglist{display:flex; flex-direction:column; gap:10px}
        .ssa-log{border:1px solid #eee; border-radius:12px; padding:10px; background:#fafafa}
        .ssa-log-head{display:flex; justify-content:space-between; gap:10px; align-items:center}
        .ssa-log-level{font-weight:900; font-size:12px}
        .ssa-log-ts{font-size:12px; color:#666}
        .ssa-log-msg{margin-top:6px; font-weight:700}
        .ssa-info{border-left:4px solid #2a6}
        .ssa-warn{border-left:4px solid #b50}
        .ssa-error{border-left:4px solid #c33}
        @media (max-width: 900px){
          .ssa-grid{grid-template-columns:1fr}
          .ssa-field{grid-template-columns:1fr}
          .ssa-label{padding-top:0}
        }
      `}</style>

      {renderStepHeader()}
      {renderWizardNav()}
      {renderControls()}
      {renderContracts()}
      {renderDebugPanel()}
      {renderActive()}
      {renderLogs()}
    </div>
  );
}

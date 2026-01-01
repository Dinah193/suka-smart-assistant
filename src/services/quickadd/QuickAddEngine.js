/* eslint-disable no-console */
// src/services/quickadd/QuickAddEngine.js

import { QUICKADD_EVENTS, genId, nowIso, clamp01 } from "./quickAddContracts";

/* --------------------------- soft imports helpers -------------------------- */
async function safeImport(path) {
  try {
    const mod = await import(path);
    return mod?.default ?? mod;
  } catch {
    return null;
  }
}

// soft-import eventBus (repo has had multiple paths)
let EVENTBUS = { emit: () => {}, on: () => () => {} };
let _eventBusReady = false;
async function getEventBus() {
  if (_eventBusReady) return EVENTBUS;
  const candidates = [
    "@/services/events/eventBus",
    "@/services/events/eventBus.js",
    "@/services/eventBus",
    "@/services/eventBus.js",
  ];
  for (const p of candidates) {
    const mod = await safeImport(p);
    const eb = mod?.default || mod?.eventBus || mod;
    if (eb?.emit) {
      EVENTBUS = eb;
      break;
    }
  }
  _eventBusReady = true;
  return EVENTBUS;
}

async function emitBus(type, data) {
  try {
    const eb = await getEventBus();
    // Some buses: emit(type, payload); others: emit({type,data})
    try {
      eb.emit(type, data);
    } catch {
      eb.emit({ type, ts: nowIso(), source: "QuickAddEngine", data });
    }
  } catch (e) {
    if (import.meta?.env?.DEV)
      console.warn("[QuickAddEngine] eventBus emit failed", type, e);
  }
}

function emitWindow(type, detail) {
  try {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(type, { detail }));
      const bus = window.__suka?.eventBus;
      if (bus?.emit) bus.emit(type, detail);
    }
  } catch {}
}

async function emitAll(type, payload) {
  await emitBus(type, payload);
  emitWindow(type, payload);
}

/* ------------------------------- heuristics -------------------------------- */
const RX = {
  // nutrition
  nutrition:
    /(kcal|calories|protein|carbs|fat|fiber|sodium|mg|g\b|macro|micros?)/i,
  // inventory / barcode / qty
  barcode: /\b(\d{12,14})\b/,
  qty: /\b(\d+(\.\d+)?)\s?(lb|lbs|oz|g|kg|ml|l|cup|cups|tbsp|tsp|pcs|pc)\b/i,
  // cooking-ish
  cooking:
    /(recipe|cook|bake|roast|saute|fry|simmer|boil|marinate|preheat|oven|instant pot|pressure)/i,
  // cleaning-ish
  cleaning:
    /(clean|mop|vacuum|dust|sanitize|bleach|scrub|laundry|wash dishes|declutter)/i,
  // garden-ish
  garden:
    /(seed|plant|transplant|harvest|compost|mulch|water|irrigat|fertiliz|bed|soil)/i,
  // animals-ish
  animals:
    /(feed|hay|grain|coop|pen|pasture|vaccin|deworm|hoof|milk|butcher|brood|laying|calf|kid|goat|sheep|chicken|turkey)/i,
};

function uniq(arr) {
  return Array.from(new Set((arr || []).filter(Boolean)));
}

function scoreDomain(text) {
  const t = String(text || "").trim();
  if (!t) return { domain: "unknown", confidence: 0 };

  const scores = {
    nutrition: 0,
    inventory: 0,
    cooking: 0,
    cleaning: 0,
    garden: 0,
    animals: 0,
  };

  if (RX.nutrition.test(t)) scores.nutrition += 0.65;
  if (RX.barcode.test(t)) scores.inventory += 0.7;
  if (RX.qty.test(t)) scores.inventory += 0.25;
  if (RX.cooking.test(t)) scores.cooking += 0.55;
  if (RX.cleaning.test(t)) scores.cleaning += 0.6;
  if (RX.garden.test(t)) scores.garden += 0.6;
  if (RX.animals.test(t)) scores.animals += 0.6;

  // cooking often overlaps inventory; prefer inventory if barcode/qty present
  if (scores.inventory > 0.6 && scores.cooking > 0.4) scores.inventory += 0.1;

  // pick max
  let best = "unknown";
  let bestScore = 0.2; // baseline threshold
  for (const [k, v] of Object.entries(scores)) {
    if (v > bestScore) {
      best = k;
      bestScore = v;
    }
  }

  return { domain: best, confidence: clamp01(bestScore) };
}

function parseQty(text) {
  const m = String(text || "").match(RX.qty);
  if (!m) return null;
  return { amount: Number(m[1]), unit: String(m[3]).toLowerCase() };
}

function extractBarcode(text) {
  const m = String(text || "").match(RX.barcode);
  return m ? String(m[1]) : null;
}

function titleFromText(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  // keep first phrase
  const short = t.split(/[\n,;]/)[0].trim();
  return short.length > 80 ? `${short.slice(0, 77)}...` : short;
}

function buildSuggestion(rawText, detectedDomain, confidence) {
  const t = String(rawText || "").trim();
  const baseWarnings = [];
  const baseErrors = [];
  if (!t) baseErrors.push("Nothing to add yet.");

  const qty = parseQty(t);
  const barcode = extractBarcode(t);
  const title = titleFromText(t);

  let suggestion = {
    domain: detectedDomain,
    confidence,
    label: "Quick Add",
    chips: [],
    fields: {},
    warnings: baseWarnings,
    errors: baseErrors,
  };

  if (detectedDomain === "inventory") {
    suggestion.label = "Inventory item";
    suggestion.fields = {
      name: title || "New item",
      qty: qty?.amount ?? 1,
      unit: qty?.unit ?? "ea",
      barcode: barcode || undefined,
      category: "pantry",
      storage: "pantry",
      // SSA-friendly defaults
      reorderMin: 0,
      tags: [],
    };
    suggestion.chips = uniq([
      suggestion.fields.category,
      suggestion.fields.storage,
      qty ? `${qty.amount} ${qty.unit}` : "1 ea",
      barcode ? "barcode" : null,
    ]).filter(Boolean);
  } else if (detectedDomain === "cooking") {
    suggestion.label = "Cooking note / ingredient";
    suggestion.fields = {
      text: t,
      // best guess “intent”
      intent: RX.qty.test(t) ? "ingredient" : "note",
      recipeHint: RX.cooking.test(t) ? "recipe" : "meal",
    };
    suggestion.chips = uniq([
      suggestion.fields.intent,
      suggestion.fields.recipeHint,
      qty ? `${qty.amount} ${qty.unit}` : null,
    ]).filter(Boolean);
  } else if (detectedDomain === "cleaning") {
    suggestion.label = "Cleaning task";
    suggestion.fields = {
      title: title || "Cleaning task",
      zone: "kitchen",
      priority: "normal",
      estMinutes: 10,
    };
    suggestion.chips = ["kitchen", "normal", "10m"];
  } else if (detectedDomain === "garden") {
    suggestion.label = "Garden task";
    suggestion.fields = {
      title: title || "Garden task",
      bed: "Bed 1",
      action: /harvest/i.test(t)
        ? "harvest"
        : /seed|plant/i.test(t)
        ? "plant"
        : "care",
      estMinutes: 15,
    };
    suggestion.chips = [suggestion.fields.bed, suggestion.fields.action, "15m"];
  } else if (detectedDomain === "animals") {
    suggestion.label = "Animal care task";
    suggestion.fields = {
      title: title || "Animal task",
      animalGroup: /goat/i.test(t)
        ? "goats"
        : /chicken/i.test(t)
        ? "chickens"
        : "livestock",
      action: /feed/i.test(t)
        ? "feed"
        : /vaccin|deworm/i.test(t)
        ? "health"
        : "care",
      estMinutes: 10,
    };
    suggestion.chips = [
      suggestion.fields.animalGroup,
      suggestion.fields.action,
      "10m",
    ];
  } else if (detectedDomain === "nutrition") {
    suggestion.label = "Nutrition target";
    suggestion.fields = {
      text: t,
      // light parsing hint
      targetType: /protein|carbs|fat|fiber|sodium/i.test(t)
        ? "macro/micro"
        : "calories",
      applyToMealPlan: true,
    };
    suggestion.chips = ["apply", suggestion.fields.targetType];
  } else {
    suggestion.label = "Unsorted note";
    suggestion.fields = { text: t };
    suggestion.chips = ["note"];
    suggestion.warnings = [
      ...(suggestion.warnings || []),
      "Couldn’t confidently detect domain.",
    ];
  }

  return suggestion;
}

/* -------------------------- persistence (Dexie) ---------------------------- */
async function getDb() {
  // preferred: services/db spine
  const servicesDb = await safeImport("@/services/db");
  const d =
    servicesDb?.db ||
    servicesDb?.default?.db ||
    servicesDb?.default ||
    servicesDb;
  if (d?.quickAddDrafts?.put) return d;

  // fallback: "@/db"
  const legacy = await safeImport("@/db");
  const db2 = legacy?.default || legacy;
  if (db2?.quickAddDrafts?.put) return db2;

  return null;
}

function localFallbackKey(k) {
  return `ssa.quickadd.${k}`;
}

function persistLocalDraft(draft) {
  try {
    const key = localFallbackKey("drafts");
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.unshift(draft);
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 50)));
  } catch {}
}

function persistLocalHistory(row) {
  try {
    const key = localFallbackKey("history");
    const arr = JSON.parse(localStorage.getItem(key) || "[]");
    arr.unshift(row);
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 200)));
  } catch {}
}

async function upsertDraft(draft) {
  const db = await getDb();
  if (db?.quickAddDrafts?.put) {
    await db.quickAddDrafts.put(draft);
    return;
  }
  persistLocalDraft(draft);
}

async function writeHistory(entry) {
  const db = await getDb();
  if (db?.quickAddHistory?.put) {
    await db.quickAddHistory.put(entry);
    return;
  }
  persistLocalHistory(entry);
}

/* ------------------------------ shopping mode ------------------------------ */
function isShoppingMode(ctx = {}) {
  // Explicit ctx override first
  if (ctx?.mode === "shopping" || ctx?.shoppingMode === true) return true;

  // Global toggles (pick one you like; all supported)
  if (typeof window !== "undefined") {
    if (window.__SSA_SHOPPING_MODE__ === true) return true;
    if (window.sukaShoppingMode === true) return true;
    try {
      const v = localStorage.getItem("suka::shopping::mode");
      if (v === "1" || v === "true") return true;
    } catch {}
  }
  return false;
}

async function createShoppingCandidateFromInventorySuggestion(
  suggestion,
  ctx = {}
) {
  const db = await getDb();
  const at = nowIso();
  const f = suggestion.fields || {};
  const candidate = {
    id: genId("shopcand"),
    createdAt: at,
    updatedAt: at,
    householdId: ctx.householdId || null,
    userId: ctx.userId || null,
    storeId: ctx.storeId || ctx.store || null,
    source: "quickadd",
    status: "pending_receipt",
    // what user thought they were adding
    name: f.name || "Shopping item",
    qty: Number(f.qty ?? 1),
    unit: f.unit || "ea",
    upc: f.barcode || null,
    brand: f.brand || null,
    category: f.category || "pantry",
    notes: ctx.rawText || "",
    // optional scan estimates (may be null)
    estUnitPrice: f.unitPrice ?? null,
    estTotalPrice: f.price ?? null,
    tags: Array.isArray(f.tags) ? f.tags : [],
    meta: { shopping: true, ...ctx.meta },
  };

  try {
    if (db?.shopping_candidates?.put)
      await db.shopping_candidates.put(candidate);
    else {
      // fallback localStorage if table missing
      const key = "suka::shopping::candidates";
      const arr = JSON.parse(localStorage.getItem(key) || "[]");
      arr.unshift(candidate);
      localStorage.setItem(key, JSON.stringify(arr.slice(0, 500)));
    }
  } catch {
    // ignore
  }

  await emitAll("shopping.candidate.added", { candidate, at });
  return candidate;
}

/* ------------------------------ domain commit ------------------------------ */
function validateSuggestion(s) {
  const errs = [];
  const dom = s?.domain || "unknown";
  const f = s?.fields || {};
  if (!s) errs.push("No suggestion.");
  if (dom === "inventory") {
    if (!String(f.name || "").trim()) errs.push("Item name required.");
    if (!Number.isFinite(Number(f.qty))) errs.push("Qty must be a number.");
  }
  if (dom === "cleaning" || dom === "garden" || dom === "animals") {
    if (!String(f.title || "").trim()) errs.push("Title required.");
  }
  if (dom === "nutrition") {
    if (!String(f.text || "").trim()) errs.push("Target text required.");
  }
  if (dom === "unknown") {
    if (!String(f.text || "").trim()) errs.push("Text required.");
  }
  return errs;
}

async function commitDomainEntity(suggestion, ctx = {}) {
  const dom = suggestion.domain;
  const f = suggestion.fields || {};
  const at = nowIso();

  // ✅ SSA SPECIAL RULE: inventory during Shopping -> shopping_candidate (NOT inventory)
  if (dom === "inventory" && isShoppingMode(ctx)) {
    return createShoppingCandidateFromInventorySuggestion(suggestion, ctx);
  }

  if (dom === "inventory") {
    const item = {
      id: genId("inv"),
      createdAt: at,
      updatedAt: at,
      householdId: ctx.householdId,
      name: f.name,
      qty: Number(f.qty ?? 1),
      unit: f.unit || "ea",
      category: f.category || "pantry",
      storage: f.storage || "pantry",
      barcode: f.barcode,
      reorderMin: Number(f.reorderMin ?? 0),
      tags: Array.isArray(f.tags) ? f.tags : [],
      source: "quickadd",
      rawText: ctx.rawText,
    };

    // Optional: persist to inventoryItems if present
    const db = await getDb();
    if (db?.inventoryItems?.put) {
      try {
        await db.inventoryItems.put(item);
      } catch (e) {
        console.warn(
          "[QuickAddEngine] inventoryItems.put failed (non-fatal)",
          e
        );
      }
    }

    await emitAll("inventory.item.created", { item });
    return item;
  }

  if (dom === "cleaning") {
    const task = {
      id: genId("cln"),
      createdAt: at,
      updatedAt: at,
      householdId: ctx.householdId,
      title: f.title,
      zone: f.zone || "kitchen",
      priority: f.priority || "normal",
      estMinutes: Number(f.estMinutes ?? 10),
      source: "quickadd",
      rawText: ctx.rawText,
    };
    await emitAll("cleaning.task.created", { task });
    return task;
  }

  if (dom === "garden") {
    const task = {
      id: genId("grd"),
      createdAt: at,
      updatedAt: at,
      householdId: ctx.householdId,
      title: f.title,
      bed: f.bed || "Bed 1",
      action: f.action || "care",
      estMinutes: Number(f.estMinutes ?? 15),
      source: "quickadd",
      rawText: ctx.rawText,
    };
    await emitAll("garden.task.created", { task });
    return task;
  }

  if (dom === "animals") {
    const task = {
      id: genId("ani"),
      createdAt: at,
      updatedAt: at,
      householdId: ctx.householdId,
      title: f.title,
      animalGroup: f.animalGroup || "livestock",
      action: f.action || "care",
      estMinutes: Number(f.estMinutes ?? 10),
      source: "quickadd",
      rawText: ctx.rawText,
    };
    await emitAll("animals.task.created", { task });
    return task;
  }

  if (dom === "nutrition") {
    const targets = {
      id: genId("nt"),
      createdAt: at,
      appliedAt: at,
      householdId: ctx.householdId,
      personId: ctx.personId,
      source: "quickadd",
      rawText: ctx.rawText,
      text: String(f.text || ""),
    };
    await emitAll("nutrition.targets.applied", { targets });
    return targets;
  }

  // unknown -> note
  const note = {
    id: genId("note"),
    createdAt: at,
    updatedAt: at,
    householdId: ctx.householdId,
    text: String(f.text || ctx.rawText || ""),
    source: "quickadd",
  };
  await emitAll("quickadd.note.created", { note });
  return note;
}

/* ------------------------- unified ingest: artifact ------------------------- */
async function createL0ArtifactFromQuickAdd({
  draft,
  domainHint,
  householdId,
  userId,
  meta = {},
} = {}) {
  const UploadIngestService =
    (await safeImport("@/services/ingest/UploadIngestService")) ||
    (await safeImport("@/services/import/UploadIngestService")) ||
    (await safeImport("@/services/uploads/UploadIngestService"));

  if (!UploadIngestService?.createArtifact) return null;

  const raw = String(draft?.rawText || "").trim();
  const created = await UploadIngestService.createArtifact({
    text: raw ? raw : null,
    json: null,
    domainHint: domainHint || "unknown",
    source: "quickadd",
    householdId: householdId || null,
    userId: userId || null,
    meta: { quickadd: true, draftId: draft?.id || null, ...meta },
  });

  return created?.artifactId || created?.id || null;
}

/* --------------------------------- API ------------------------------------ */
export default class QuickAddEngine {
  async detect(rawText) {
    const { domain, confidence } = scoreDomain(rawText);
    const suggestion = buildSuggestion(rawText, domain, confidence);
    return { domain, confidence, suggestion };
  }

  /**
   * Create/update draft, emit quickadd.detected, and persist (offline-first)
   */
  async upsertDraft({
    rawText,
    source,
    householdId,
    personId,
    existingId,
    userId,
    storeId,
    mode,
    meta,
  } = {}) {
    const id = existingId || genId("qad");
    const createdAt = nowIso();
    const updatedAt = nowIso();

    const detected = await this.detect(rawText);
    const draft = {
      id,
      createdAt,
      updatedAt,
      householdId,
      userId: userId || null,
      personId,
      storeId: storeId || null,
      mode: mode || null,
      rawText: String(rawText || ""),
      detectedDomain: detected.domain,
      confidence: detected.confidence,
      suggestion: detected.suggestion,
      confirmedFields: {},
      status: "draft",
      source: source || "unknown",
      meta: meta || {},
    };

    await upsertDraft(draft);

    await emitAll(QUICKADD_EVENTS.DETECTED, {
      at: nowIso(),
      domain: detected.domain,
      confidence: detected.confidence,
      suggestion: detected.suggestion,
      draft,
    });

    return draft;
  }

  /**
   * Commit (validates, persists history, emits quickadd.committed + domain event)
   * Returns created entity
   */
  async commitDraft(draft, confirmedFields = {}, ctx = {}) {
    const at = nowIso();
    const mergedSuggestion = {
      ...(draft?.suggestion || {}),
      fields: {
        ...(draft?.suggestion?.fields || {}),
        ...(confirmedFields || {}),
      },
    };

    const errs = validateSuggestion(mergedSuggestion);
    if (errs.length) {
      const updated = {
        ...(draft || {}),
        updatedAt: at,
        status: "error",
        error: errs.join(" "),
        suggestion: {
          ...mergedSuggestion,
          errors: uniq([...(mergedSuggestion.errors || []), ...errs]),
        },
      };
      await upsertDraft(updated);
      throw new Error(updated.error);
    }

    // Persist history first (offline-first)
    const historyRow = {
      id: genId("qah"),
      createdAt: at,
      updatedAt: at,
      householdId: draft.householdId,
      userId: draft.userId || null,
      personId: draft.personId,
      rawText: draft.rawText,
      domain: mergedSuggestion.domain,
      confidence: draft.confidence,
      fields: mergedSuggestion.fields,
      source: draft.source,
    };
    await writeHistory(historyRow);

    // Commit entity (domain event + optional domain table write)
    const entity = await commitDomainEntity(mergedSuggestion, {
      householdId: draft.householdId,
      userId: draft.userId || ctx.userId || null,
      personId: draft.personId,
      storeId: draft.storeId || ctx.storeId || ctx.store || null,
      mode: draft.mode || ctx.mode || null,
      shoppingMode: draft.mode === "shopping" || ctx.shoppingMode === true,
      rawText: draft.rawText,
      meta: draft.meta || {},
    });

    // Mark draft committed
    const committedDraft = {
      ...(draft || {}),
      updatedAt: at,
      status: "committed",
      confirmedFields: mergedSuggestion.fields,
      suggestion: mergedSuggestion,
    };
    await upsertDraft(committedDraft);

    // -----------------------------------------------------------------
    // Unified ingest: create an L0 artifact so automation can parse→session
    // -----------------------------------------------------------------
    let artifactId = null;
    try {
      artifactId = await createL0ArtifactFromQuickAdd({
        draft: committedDraft,
        domainHint:
          mergedSuggestion.domain === "inventory" &&
          isShoppingMode({ ...ctx, ...draft })
            ? "shopping"
            : mergedSuggestion.domain,
        householdId: draft?.householdId || null,
        userId: draft?.userId || null,
        meta: {
          shopping: isShoppingMode({ ...ctx, ...draft }),
          storeId: draft?.storeId || ctx?.storeId || null,
        },
      });
    } catch {
      artifactId = null;
    }

    await emitAll(QUICKADD_EVENTS.COMMITTED, {
      at,
      domain: mergedSuggestion.domain,
      draft: committedDraft,
      entity,
      artifactId,
    });

    return { entity, draft: committedDraft, historyRow, artifactId };
  }

  open({ source, initialText, householdId, personId } = {}) {
    emitAll(QUICKADD_EVENTS.OPEN, {
      at: nowIso(),
      source: source || "unknown",
      initialText: initialText || "",
      householdId,
      personId,
    });
  }
}

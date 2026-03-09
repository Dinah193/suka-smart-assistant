/* eslint-disable no-console */
// src/components/cleaning/collector/UrlImportPanel.jsx

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Link as LinkIcon,
  Upload,
  ListChecks,
  Sparkles,
  Tag as TagIcon,
  Check,
  X,
  HelpCircle,
  Clock4,
  CalendarClock,
  Trash2,
  Undo2,
  Save,
  Wand2,
  ExternalLink,
  ShieldAlert,
} from "lucide-react";

/* ------------------------- Defensive service imports ------------------------- */
let CleaningPlanManager = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  CleaningPlanManager =
    require("../../../managers/CleaningPlanManager").default ||
    require("../../../managers/CleaningPlanManager");
} catch (e) {
  console.warn(
    "[UrlImportPanel] CleaningPlanManager not available, using stub."
  );
  CleaningPlanManager = {
    addFromSource: async () => ({ id: `stub:${Date.now()}` }),
    upsertManyFromSource: async () => ({ ids: [], duplicates: [] }),
    getByFingerprint: () => null,
  };
}

let automation = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch (e) {
  console.warn("[UrlImportPanel] automation runtime not available.");
}

let eventBus = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  eventBus = require("@/services/events/eventBus").eventBus || null;
} catch (e) {
  console.warn("[UrlImportPanel] eventBus not available.");
}

let useSettingsContext = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore
  useSettingsContext =
    require("@/components/context/SettingsContext.jsx").useSettingsContext ||
    null;
} catch (e) {
  // Allow null; we’ll guard for Sabbath
}

let InlineToastAnchor = null;
try {
  // meals/common path exists in your repo; safe to reuse for unified UX
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  InlineToastAnchor =
    require("@/components/meals/common/InlineToastAnchor.jsx").default || null;
} catch (e) {
  // noop
}

let NBAInvokeButton = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  NBAInvokeButton =
    require("@/components/meals/common/NBAInvokeButton.jsx").default || null;
} catch (e) {
  // noop
}

/* ------------------------------ Local utilities ------------------------------ */

function toLines(value = "") {
  return value
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function onlyUnique(arr) {
  return Array.from(new Set(arr));
}

function hashFingerprint(str) {
  // Lightweight, order-stable fingerprint for dedupe/versioning
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return ("00000000" + (h >>> 0).toString(16)).slice(-8);
}

function guessAreaFromText(text) {
  const t = text.toLowerCase();
  if (/(bath|toilet|shower|tub|sink)/.test(t)) return "Bathroom";
  if (/(kitchen|stove|oven|fridge|pantry|dish)/.test(t)) return "Kitchen";
  if (/(bedroom|closet|linen)/.test(t)) return "Bedroom";
  if (/(living|family|den)/.test(t)) return "Living Room";
  if (/(laundry|washer|dryer)/.test(t)) return "Laundry";
  if (/(entry|mudroom|hall)/.test(t)) return "Entry/Hall";
  return "General";
}

function guessFrequencyFromText(text) {
  const t = text.toLowerCase();
  if (/daily|every day|each day/.test(t)) return "Daily";
  if (/weekly|every week|once a week/.test(t)) return "Weekly";
  if (/bi-?weekly|fortnight/.test(t)) return "Biweekly";
  if (/monthly|once a month/.test(t)) return "Monthly";
  if (/quarter|season/.test(t)) return "Quarterly";
  if (/annual|yearly|once a year/.test(t)) return "Annual";
  if (/deep clean/.test(t)) return "Deep (Set Cadence)";
  return "Suggested";
}

function estimateMinutes(text) {
  const t = text.toLowerCase();
  // crude estimate based on keywords
  let base = 10;
  if (/scrub|degrease|descale|grout|mold/.test(t)) base += 15;
  if (/vacuum|mop|sweep/.test(t)) base += 5;
  if (/organize|declutter/.test(t)) base += 20;
  if (/window|blinds/.test(t)) base += 8;
  if (/fridge|oven/.test(t)) base += 15;
  return Math.min(base, 60);
}

function extractTasksFromHtml(html) {
  // Try to pull bullet/numbered list items; fallback to sentences with verbs
  // Note: This runs on client HTML text (if fetched) or pasted HTML fragments.
  const items = [];

  // 1) list markers
  const bulletRegex = /<li[^>]*>(.*?)<\/li>/gis;
  let m;
  while ((m = bulletRegex.exec(html)) !== null) {
    const text = m[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) items.push(text);
  }

  // 2) paragraph fallback for common verbs
  if (items.length === 0) {
    const pRegex = /<p[^>]*>(.*?)<\/p>/gis;
    while ((m = pRegex.exec(html)) !== null) {
      const text = m[1]
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (
        /\b(wipe|scrub|vacuum|mop|sweep|dust|wash|degrease|rinse|soak|sanitize|disinfect|polish|declutter)\b/i.test(
          text
        )
      ) {
        items.push(text);
      }
    }
  }

  // Normalize/unique
  const normalized = onlyUnique(
    items.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean)
  );

  // Map to structured tasks
  return normalized.map((t) => ({
    title: t.charAt(0).toUpperCase() + t.slice(1),
    area: guessAreaFromText(t),
    frequency: guessFrequencyFromText(t),
    estMinutes: estimateMinutes(t),
    tags: pickTags(t),
  }));
}

function pickTags(text) {
  const t = text.toLowerCase();
  const tags = [];
  if (/vacuum/.test(t)) tags.push("vacuum");
  if (/mop|sweep/.test(t)) tags.push("floors");
  if (/scrub|grout|tile/.test(t)) tags.push("scrub");
  if (/degrease|grease/.test(t)) tags.push("degrease");
  if (/descale|scale|mineral/.test(t)) tags.push("descale");
  if (/disinfect|sanitize/.test(t)) tags.push("sanitize");
  if (/window|glass|mirror/.test(t)) tags.push("glass");
  if (/fridge|freezer|pantry|oven|stove/.test(t)) tags.push("appliance");
  if (/laundry|washer|dryer|lint/.test(t)) tags.push("laundry");
  if (/dust/.test(t)) tags.push("dust");
  if (/declutter|organize/.test(t)) tags.push("organize");
  return tags.length ? onlyUnique(tags) : ["general"];
}

async function safeFetch(url) {
  // If you have a server proxy/reader, call it here; otherwise do best-effort fetch.
  // NOTE: Cross-origin HTML fetch may be blocked. We handle fallback path (user paste).
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return { ok: true, html };
  } catch (e) {
    console.warn("[UrlImportPanel] fetch failed:", e.message);
    return { ok: false, error: e.message };
  }
}

function makeSourceRecord({ url, tasks, title }) {
  const key = `${url}|${tasks.map((t) => t.title).join("|")}|${
    title || ""
  }`.toLowerCase();
  return {
    id: `source:${Date.now()}`,
    url,
    title: title || url,
    tasks,
    fingerprint: hashFingerprint(key),
    importedAt: new Date().toISOString(),
    version: 1,
    meta: {},
  };
}

/* -------------------------------- Tag Chips UI ------------------------------- */

const TagChips = ({ value = [], onChange }) => {
  const [input, setInput] = useState("");
  const handleAdd = () => {
    const v = input.trim().toLowerCase();
    if (!v) return;
    const next = onlyUnique([...(value || []), v]);
    onChange?.(next);
    setInput("");
  };
  const remove = (t) => onChange?.((value || []).filter((x) => x !== t));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2 items-center">
        <TagIcon size={16} />
        <input
          className="flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
          placeholder="Add tag (e.g., sanitize, floors, appliance)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button
          onClick={handleAdd}
          className="px-2 py-1 text-sm rounded bg-gray-100 hover:bg-gray-200 border"
        >
          Add
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        {(value || []).map((t) => (
          <span
            key={t}
            className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full bg-gray-100 border"
          >
            {t}
            <button onClick={() => remove(t)} className="hover:text-red-600">
              <X size={14} />
            </button>
          </span>
        ))}
      </div>
    </div>
  );
};

/* ------------------------------ Main component ------------------------------- */

const DEFAULT_FREQ = [
  "Suggested",
  "Daily",
  "Weekly",
  "Biweekly",
  "Monthly",
  "Quarterly",
  "Annual",
  "Deep (Set Cadence)",
];

export default function UrlImportPanel() {
  const urlRef = useRef(null);
  const bulkRef = useRef(null);

  const { sabbathGuardEnabled } = useSettingsFallback();

  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [bulk, setBulk] = useState("");
  const [imports, setImports] = useState([]); // [{ url, html?, tasks:[], title, fingerprint, version }]
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [lastSaved, setLastSaved] = useState(null);
  const [undoStack, setUndoStack] = useState([]);

  // Sponsor slot toggle (optional small contextual ad in-panel)
  const [showSponsor, setShowSponsor] = useState(false);

  const toggleSelect = (fid) => {
    const next = new Set(selectedIds);
    if (next.has(fid)) next.delete(fid);
    else next.add(fid);
    setSelectedIds(next);
  };

  const allSelected = useMemo(() => {
    const fids = imports.map((i) => i.fingerprint);
    return fids.length > 0 && fids.every((f) => selectedIds.has(f));
  }, [imports, selectedIds]);

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(imports.map((i) => i.fingerprint)));
    }
  };

  const removeImport = (fid) => {
    setImports((prev) => prev.filter((i) => i.fingerprint !== fid));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(fid);
      return next;
    });
  };

  const parseOne = useCallback(async (singleUrl) => {
    const trimmed = (singleUrl || "").trim();
    if (!trimmed) return null;

    const fetched = await safeFetch(trimmed);
    if (!fetched.ok) {
      // If fetch blocked, allow manual paste path: user can paste HTML into bulk field later.
      return {
        url: trimmed,
        title: null,
        html: null,
        tasks: [
          {
            title:
              "Open the article and paste the bullet list here (fetch blocked by CORS).",
            area: "General",
            frequency: "Suggested",
            estMinutes: 1,
            tags: ["todo"],
            requiresManual: true,
          },
        ],
        fingerprint: hashFingerprint(`${trimmed}|blocked`),
        version: 1,
      };
    }

    const html = fetched.html || "";
    // Try to extract <title>
    let pageTitle = null;
    const mt = html.match(/<title[^>]*>(.*?)<\/title>/is);
    if (mt && mt[1]) pageTitle = mt[1].replace(/\s+/g, " ").trim();

    const tasks = extractTasksFromHtml(html);
    const rec = makeSourceRecord({
      url: trimmed,
      tasks,
      title: pageTitle,
    });
    return rec;
  }, []);

  const handleParseUrl = useCallback(async () => {
    if (sabbathGuardEnabled && isSabbathNow()) {
      alert("Sabbath guard is on. Collectors are paused.");
      return;
    }
    const u = url.trim();
    if (!u) return;
    setBusy(true);
    try {
      const rec = await parseOne(u);
      if (rec) {
        setImports((prev) => upsertRec(prev, rec));
        if (eventBus?.emit)
          eventBus.emit("collector:cleaning:urlImported", {
            url: u,
            fingerprint: rec.fingerprint,
          });
      }
    } finally {
      setBusy(false);
      setUrl("");
      urlRef.current?.focus();
    }
  }, [url, parseOne, sabbathGuardEnabled]);

  const handleParseBulk = useCallback(async () => {
    if (sabbathGuardEnabled && isSabbathNow()) {
      alert("Sabbath guard is on. Collectors are paused.");
      return;
    }
    const lines = onlyUnique(toLines(bulk));
    if (!lines.length) return;
    setBusy(true);
    try {
      const results = await Promise.all(lines.map(parseOne));
      const next = results.filter(Boolean);
      setImports((prev) => {
        let agg = prev.slice();
        next.forEach((rec) => (agg = upsertRec(agg, rec)));
        return agg;
      });
      if (eventBus?.emit)
        eventBus.emit("collector:cleaning:bulkImported", {
          count: next.length,
        });
    } finally {
      setBusy(false);
      setBulk("");
    }
  }, [bulk, parseOne, sabbathGuardEnabled]);

  const selectedImports = useMemo(() => {
    const map = new Map(imports.map((i) => [i.fingerprint, i]));
    return Array.from(selectedIds)
      .map((fid) => map.get(fid))
      .filter(Boolean);
  }, [imports, selectedIds]);

  const handleSaveSelected = useCallback(async () => {
    if (!selectedImports.length) return;
    if (sabbathGuardEnabled && isSabbathNow()) {
      alert("Sabbath guard is on. Saving is paused.");
      return;
    }
    setBusy(true);
    try {
      // Prepare payload to manager
      const payload = selectedImports.map((rec) => ({
        sourceUrl: rec.url,
        title: rec.title || rec.url,
        fingerprint: rec.fingerprint,
        version: rec.version || 1,
        tasks: rec.tasks.map((t) => ({
          title: t.title,
          area: t.area,
          frequency: t.frequency,
          estMinutes: t.estMinutes,
          tags: t.tags || [],
          // dwell timers for chemicals (auto reminder capability)
          dwell: inferDwell(t),
        })),
        meta: { collectedFrom: "UrlImportPanel" },
      }));

      const result = await (CleaningPlanManager.upsertManyFromSource
        ? CleaningPlanManager.upsertManyFromSource(payload)
        : Promise.resolve({
            ids: payload.map(() => `stub:${Date.now()}`),
            duplicates: [],
          }));

      setLastSaved({ at: Date.now(), count: payload.length });
      setUndoStack((prev) => [
        ...prev,
        {
          kind: "save",
          when: Date.now(),
          payload,
          result,
        },
      ]);

      if (
        automation?.templates?.scheduleDwellTimers &&
        automation.runTemplate
      ) {
        // Optional: schedule dwell timers for any parsed tasks that include dwell
        payload.forEach((p) => {
          p.tasks.forEach((t) => {
            if (t.dwell && t.dwell.minutes) {
              automation.runTemplate("scheduleDwellTimers", {
                source: "cleaning:urlImport",
                taskTitle: t.title,
                dwellMinutes: t.dwell.minutes,
                area: t.area,
              });
            }
          });
        });
      }

      if (eventBus?.emit) {
        eventBus.emit("collector:cleaning:saved", {
          count: payload.length,
          ids: result?.ids || [],
        });
      }
    } catch (e) {
      console.error("[UrlImportPanel] save error", e);
      alert("Could not save imported tasks.");
    } finally {
      setBusy(false);
    }
  }, [selectedImports, sabbathGuardEnabled]);

  const handleUndoLast = useCallback(async () => {
    const last = undoStack[undoStack.length - 1];
    if (!last) return;
    // We don’t know if your manager has deleteByFingerprint — attempt best effort.
    try {
      if (last.kind === "save") {
        const fps = last.payload.map((p) => p.fingerprint);
        if (CleaningPlanManager.deleteByFingerprints) {
          await CleaningPlanManager.deleteByFingerprints(fps);
        }
        if (eventBus?.emit)
          eventBus.emit("collector:cleaning:undo", { count: fps.length });
      }
    } catch (e) {
      console.warn("[UrlImportPanel] undo failed or unsupported:", e.message);
    } finally {
      setUndoStack((prev) => prev.slice(0, -1));
    }
  }, [undoStack]);

  const handleCreateSession = useCallback(() => {
    if (!selectedImports.length) return;
    // Emits a hint for your Session Builder to pick up:
    if (eventBus?.emit) {
      eventBus.emit("session:cleaning:seedFromImports", {
        imports: selectedImports,
        source: "UrlImportPanel",
      });
    }
    alert(
      "Session seeded from selected imports. Open the Cleaning Session Planner to review."
    );
  }, [selectedImports]);

  const handleSchedule = useCallback(() => {
    if (!selectedImports.length) return;
    if (!automation?.runTemplate) {
      alert("Scheduling runtime not available.");
      return;
    }
    selectedImports.forEach((rec) => {
      rec.tasks.forEach((t) => {
        // Default: propose weekly unless specified differently
        const freq = normFreq(t.frequency);
        automation.runTemplate("cleaning.reminder.schedule", {
          title: t.title,
          area: t.area,
          cadence: freq, // "Daily"/"Weekly"/"Monthly"/"Quarterly"/"Annual"/"Suggested"
          estMinutes: t.estMinutes,
          tags: t.tags || [],
          source: "UrlImportPanel",
        });
      });
    });
    alert("Proposed reminders have been scheduled (where supported).");
  }, [selectedImports]);

  // Small contextual sponsor slot toggle (optional)
  useEffect(() => {
    // Tiny heuristic: if user pastes > 3 URLs, show sponsor slot once.
    if (!showSponsor && toLines(bulk).length >= 3) setShowSponsor(true);
  }, [bulk, showSponsor]);

  /* --------------------------------- Render --------------------------------- */

  return (
    <div className="rounded-2xl border p-4 md:p-6 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ListChecks />
          <div>
            <h2 className="text-lg font-semibold">
              Import cleaning checklists from the web
            </h2>
            <p className="text-sm text-gray-500">
              Paste a link (or many) and I’ll extract actionable tasks with
              areas, cadence, estimates & tags.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {sabbathGuardEnabled ? (
            <span className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded bg-amber-50 text-amber-700 border border-amber-200">
              <ShieldAlert size={14} />
              Sabbath guard
            </span>
          ) : null}
          {InlineToastAnchor ? (
            <InlineToastAnchor id="cleaning-url-import" />
          ) : null}
        </div>
      </div>

      {/* Single URL */}
      <div className="mt-4 grid md:grid-cols-12 gap-3">
        <div className="md:col-span-9 flex items-center gap-2">
          <div className="flex items-center gap-2 w-full">
            <LinkIcon className="text-gray-500" size={18} />
            <input
              ref={urlRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full rounded-lg border px-3 py-2 text-sm"
              placeholder="https://example.com/awesome-cleaning-checklist"
            />
          </div>
        </div>
        <div className="md:col-span-3 flex gap-2">
          <button
            disabled={busy || !url.trim()}
            onClick={handleParseUrl}
            className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
          >
            <Upload size={16} />
            Parse link
          </button>

          {NBAInvokeButton ? (
            <NBAInvokeButton
              kind="collect"
              size="sm"
              label="Suggest"
              payload={{ domain: "cleaning", source: "UrlImportPanel" }}
            />
          ) : (
            <button
              onClick={() => alert("NBA not available.")}
              className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm bg-white hover:bg-gray-50"
              title="Suggest next best action"
            >
              <Sparkles size={16} />
            </button>
          )}
        </div>
      </div>

      {/* Bulk URLs */}
      <div className="mt-4">
        <div className="flex items-center justify-between">
          <label className="text-sm font-medium">
            Bulk paste (one URL per line)
          </label>
          <button
            onClick={() =>
              setBulk((prev) => (prev ? prev : "https://\nhttps://\nhttps://"))
            }
            className="text-xs text-gray-600 hover:text-gray-900 inline-flex items-center gap-1"
          >
            <HelpCircle size={14} /> Example
          </button>
        </div>
        <textarea
          ref={bulkRef}
          value={bulk}
          onChange={(e) => setBulk(e.target.value)}
          className="mt-1 w-full min-h-[90px] rounded-lg border px-3 py-2 text-sm"
          placeholder="https://site1.com/checklist
https://site2.com/spring-cleaning
https://blog.com/weekly-routines"
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            disabled={busy || !toLines(bulk).length}
            onClick={handleParseBulk}
            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
          >
            <Upload size={16} />
            Parse all
          </button>
          <BookmarkletHint />
        </div>
      </div>

      {/* Sponsor slot (optional) */}
      {showSponsor ? (
        <div className="mt-4 rounded-lg border bg-gray-50 p-3 text-xs text-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ExternalLink size={14} />
            <span>
              Tip: Steamers cut degreasing time by ~30%. Consider a compact
              steam cleaner.
            </span>
          </div>
          <a
            href="https://example.com/steam-cleaner"
            target="_blank"
            rel="noreferrer"
            className="underline hover:no-underline"
          >
            Learn more
          </a>
        </div>
      ) : null}

      {/* Imported results */}
      <div className="mt-6">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Parsed sources</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSelectAll}
              disabled={!imports.length}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border bg-white hover:bg-gray-50 disabled:opacity-50"
            >
              {allSelected ? <X size={14} /> : <Check size={14} />}
              {allSelected ? "Clear all" : "Select all"}
            </button>
            <button
              onClick={handleUndoLast}
              disabled={!undoStack.length}
              className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border bg-white hover:bg-gray-50 disabled:opacity-50"
              title="Undo last save (best effort)"
            >
              <Undo2 size={14} />
              Undo
            </button>
          </div>
        </div>

        {!imports.length ? (
          <div className="mt-3 text-sm text-gray-500">
            No imports yet. Paste a link to get started.
          </div>
        ) : (
          <div className="mt-3 space-y-4">
            {imports.map((rec) => (
              <ImportCard
                key={rec.fingerprint}
                rec={rec}
                selected={selectedIds.has(rec.fingerprint)}
                onToggle={() => toggleSelect(rec.fingerprint)}
                onRemove={() => removeImport(rec.fingerprint)}
                onChange={(updated) => {
                  setImports((prev) =>
                    prev.map((x) =>
                      x.fingerprint === rec.fingerprint
                        ? { ...x, ...updated }
                        : x
                    )
                  );
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          onClick={handleSaveSelected}
          disabled={busy || selectedImports.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm bg-black text-white hover:opacity-90 disabled:opacity-50"
        >
          <Save size={16} />
          Save selected to Library
        </button>
        <button
          onClick={handleCreateSession}
          disabled={busy || selectedImports.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <Wand2 size={16} />
          Create Session from selected
        </button>
        <button
          onClick={handleSchedule}
          disabled={busy || selectedImports.length === 0}
          className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <CalendarClock size={16} />
          Schedule reminders
        </button>
        {lastSaved ? (
          <span className="text-xs text-gray-500 ml-auto">
            Last saved {new Date(lastSaved.at).toLocaleTimeString()} •{" "}
            {lastSaved.count} record(s)
          </span>
        ) : null}
      </div>
    </div>
  );
}

/* -------------------------------- Subcomponents ------------------------------- */

function ImportCard({ rec, selected, onToggle, onRemove, onChange }) {
  const [open, setOpen] = useState(true);

  return (
    <div className="rounded-xl border bg-white">
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="flex items-center gap-2">
          <input type="checkbox" checked={selected} onChange={onToggle} />
          <span className="text-sm font-medium">{rec.title || rec.url}</span>
          <a
            href={rec.url}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-blue-600 hover:underline inline-flex items-center gap-1"
          >
            <ExternalLink size={14} /> Visit
          </a>
          <span className="text-[10px] text-gray-500 px-2 py-0.5 border rounded-full">
            v{rec.version || 1} • {rec.fingerprint}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-xs px-2 py-1 rounded border bg-white hover:bg-gray-50"
          >
            {open ? "Collapse" : "Expand"}
          </button>
          <button
            onClick={onRemove}
            className="text-xs inline-flex items-center gap-1 px-2 py-1 rounded border bg-white hover:bg-red-50"
          >
            <Trash2 size={14} />
            Remove
          </button>
        </div>
      </div>

      {open ? (
        <div className="p-3 md:p-4">
          {rec.tasks?.length ? (
            <div className="space-y-3">
              {rec.tasks.map((t, idx) => (
                <TaskRow
                  key={idx}
                  value={t}
                  onChange={(val) => {
                    const next = rec.tasks.slice();
                    next[idx] = val;
                    onChange?.({ tasks: next });
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="text-sm text-gray-500">
              No tasks were detected. Paste the checklist bullets into Bulk and
              parse again.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function TaskRow({ value, onChange }) {
  const [title, setTitle] = useState(value.title || "");
  const [area, setArea] = useState(value.area || "General");
  const [frequency, setFrequency] = useState(value.frequency || "Suggested");
  const [estMinutes, setEstMinutes] = useState(value.estMinutes || 10);
  const [tags, setTags] = useState(value.tags || []);

  useEffect(() => {
    onChange?.({
      ...value,
      title: title.trim(),
      area,
      frequency,
      estMinutes: Number(estMinutes) || 5,
      tags,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, area, frequency, estMinutes, tags]);

  return (
    <div className="rounded-lg border p-3">
      <div className="grid md:grid-cols-12 gap-2 items-center">
        <div className="md:col-span-6">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border px-3 py-2 text-sm"
            placeholder="Task title (e.g., Degrease stovetop and hood)"
          />
        </div>
        <div className="md:col-span-2">
          <select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="w-full rounded border px-2 py-2 text-sm"
          >
            {[
              "General",
              "Kitchen",
              "Bathroom",
              "Bedroom",
              "Living Room",
              "Laundry",
              "Entry/Hall",
            ].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <select
            value={frequency}
            onChange={(e) => setFrequency(e.target.value)}
            className="w-full rounded border px-2 py-2 text-sm"
          >
            {DEFAULT_FREQ.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2 flex items-center gap-2">
          <Clock4 size={16} className="text-gray-500" />
          <input
            type="number"
            value={estMinutes}
            min={1}
            max={180}
            onChange={(e) => setEstMinutes(e.target.value)}
            className="w-20 rounded border px-2 py-2 text-sm"
          />
          <span className="text-xs text-gray-500">min</span>
        </div>
      </div>

      <div className="mt-3">
        <TagChips value={tags} onChange={setTags} />
      </div>
    </div>
  );
}

function BookmarkletHint() {
  const code =
    "javascript:(()=>{const u=location.href;navigator.clipboard.writeText(u).then(()=>alert('Copied URL to clipboard. Open Suka → Paste into bulk.'))})();";
  return (
    <details className="text-xs ml-auto">
      <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
        Optional: bookmarklet
      </summary>
      <div className="mt-2 rounded border bg-gray-50 p-2">
        Drag this to your bookmarks bar:{" "}
        <a href={code} className="underline">
          Suka: copy URL
        </a>
        <div className="mt-1 text-[11px] text-gray-500">
          Click it while viewing a checklist article → then paste in the bulk
          box here.
        </div>
      </div>
    </details>
  );
}

/* --------------------------------- Helpers ---------------------------------- */

function upsertRec(list, rec) {
  // version bump if same fingerprint exists; otherwise append
  const i = list.findIndex((x) => x.fingerprint === rec.fingerprint);
  if (i >= 0) {
    const prev = list[i];
    const next = { ...rec, version: (prev.version || 1) + 1 };
    const arr = list.slice();
    arr[i] = next;
    return arr;
  }
  return [...list, rec];
}

function normFreq(freq) {
  if (!freq) return "Suggested";
  const f = ("" + freq).toLowerCase();
  if (/daily/.test(f)) return "Daily";
  if (/bi-?weekly/.test(f)) return "Biweekly";
  if (/weekly/.test(f)) return "Weekly";
  if (/monthly/.test(f)) return "Monthly";
  if (/quarter/.test(f)) return "Quarterly";
  if (/annual|year/.test(f)) return "Annual";
  if (/deep/.test(f)) return "Deep (Set Cadence)";
  return "Suggested";
}

function inferDwell(task) {
  // Tiny heuristic: if task mentions disinfect/sanitize/soak, add dwell timer
  const t = (task.title || "").toLowerCase();
  if (/soak/.test(t)) return { minutes: 15, reason: "soak" };
  if (/disinfect|sanitize/.test(t)) return { minutes: 10, reason: "disinfect" };
  if (/descale/.test(t)) return { minutes: 20, reason: "descale" };
  if (/degrease/.test(t)) return { minutes: 5, reason: "degrease" };
  return null;
}

function isSabbathNow() {
  // Simple guard: Friday sunset → Saturday sunset would need geo/time. We just expose a switch in Settings.
  // If you later add geo-aware sabbath window, swap this with your calendar utility.
  return false;
}

function useSettingsFallback() {
  // Read sabbath guard if SettingsContext exists; else default false
  const ctx = useSettingsContext ? useSettingsContext() : null;
  return {
    sabbathGuardEnabled: !!ctx?.sabbathGuardEnabled,
  };
}

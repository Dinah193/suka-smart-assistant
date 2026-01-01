/* eslint-disable no-console */
// src/components/animals/collector/LogImportPanel.jsx
// Animals Collector → Log Import Panel
//
// Goals (aligned with Suka Smart Assistant):
// - Paste/enter multiple log lines → preview normalized "animal task log" items
// - Infer {date/time, kind, action, qty/unit, tags} from each line
// - Show quick tags; user-editable inline; compact & keyboard-friendly
// - Detect duplicates (via props.dedupe or safe local) & support "Use existing / Add as new version"
// - Batch actions: Save to Log, Queue for processing, Schedule reminders
// - Defensive: works even if analytics/reminders/NBA/eventBus/inventory are absent
// - Clear empty/skeleton/error states, optimistic UI
//
// Props:
//   onImport?: (items) => void                            // normalized selected items
//   onQueue?: (items) => void
//   onSchedule?: (items) => void
//   normalizer?: (raw:PreviewItem) => NormalizedItem      // map preview -> saved shape
//   dedupe?: (itemsOrKeys:string[]|item[]) => Promise<Map<string, {matchId:string, versionable?:boolean}>>
//   defaultKind?: string                                  // e.g., "Sheep"
//   className?: string
//
// Shapes:
//
// PreviewItem {
//   key,                                                  // stable key for dedupe (e.g., hash of line)
//   rawLine,                                              // original typed line
//   occurredAt?: string (ISO),                            // parsed or defaulted timestamp
//   title,                                                // human label
//   kind?: "Poultry"|"Sheep"|"Goat"|"Beef"|"Rabbit"|"Fish",
//   action?: "Feed"|"Water"|"Deworm"|"Vaccinate"|"Clean"|"Inspect"|"Butcher"|"Package",
//   qty?: number, unit?: string,                          // optional quantity + unit
//   tags?: string[],
//   notes?: string,
// }
//
// NormalizedItem (suggested):
// {
//   id?: string,
//   occurredAt: string,                                   // ISO
//   title, kind, action, qty, unit, tags, notes,
//   source: { type: "manual-log", line: string },
//   createdAt: number
// }

import React, { useCallback, useEffect, useMemo, useState } from "react";

/* -------------------------------- utils -------------------------------- */
function cx(...a) { return a.filter(Boolean).join(" "); }
const KIND_OPTS = ["Poultry", "Sheep", "Goat", "Beef", "Rabbit", "Fish"];
const ACTION_OPTS = ["Feed", "Water", "Deworm", "Vaccinate", "Clean", "Inspect", "Butcher", "Package"];

function unique(arr = []) {
  return Array.from(new Set(arr.filter(Boolean).map((s) => String(s).trim())));
}
function slugify(s = "") {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function simpleHash(s = "") {
  // Non-crypto, stable hash for dedupe keys
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h << 5) - h + s.charCodeAt(i);
  return "h" + (h >>> 0).toString(16);
}

function inferActionFromText(t = "") {
  const s = t.toLowerCase();
  if (/butcher|cut.?sheet|quarter|dispatch|harvest|skin|eviscerate/.test(s)) return "Butcher";
  if (/package|vac.?seal|wrap|label/.test(s)) return "Package";
  if (/deworm|wormer|parasite/.test(s)) return "Deworm";
  if (/vaccin|immuniz|cd&t|shots?/.test(s)) return "Vaccinate";
  if (/(feed|ration|grain|hay|pellet|scratch)\b/.test(s)) return "Feed";
  if (/(water|hydration|drink|trough|bucket)\b/.test(s)) return "Water";
  if (/clean|sanitize|disinfect|bedding|stall|coop|pen/.test(s)) return "Clean";
  if (/inspect|health check|weigh|hoof|hoof.?trim|check(?!list)/.test(s)) return "Inspect";
  return "";
}
function inferKindFromText(t = "", fallback = "") {
  const s = t.toLowerCase();
  if (/poultry|chicken|duck|turkey|quail|hen|broiler|layer|roosters?/.test(s)) return "Poultry";
  if (/sheep|lamb|ram|ewe|mutton/.test(s)) return "Sheep";
  if (/goat|kid|doe|buck/.test(s)) return "Goat";
  if (/beef|cattle|cow|steer|heifer|bull/.test(s)) return "Beef";
  if (/rabbit|hare/.test(s)) return "Rabbit";
  if (/fish|tilapia|catfish|trout/.test(s)) return "Fish";
  return fallback || "";
}

function parseQtyUnit(t = "") {
  // captures "2 scoops", "5 gal", "1.5 lb", "3 lbs", "10 liters"
  const m = t.match(/(\d+(?:\.\d+)?)\s*(scoops?|cups?|gal(?:lons?)?|liters?|ltrs?|l|qt|pt|lb?s?|kg|g|ounces?|oz)\b/i);
  if (!m) return { qty: undefined, unit: undefined };
  const qty = parseFloat(m[1]);
  const unit = m[2];
  return { qty: isNaN(qty) ? undefined : qty, unit };
}

function parseWhen(t = "", defaultDate = new Date()) {
  // accepts: 2025-10-23, 10/23/2025, 10/23, 9:30, 9am, today, yesterday, "today 9am"
  const s = t.trim().toLowerCase();

  const now = new Date(defaultDate);
  const isoLike = s.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoLike) {
    const d = new Date(Number(isoLike[1]), Number(isoLike[2]) - 1, Number(isoLike[3]));
    return d;
  }

  const mdyyyy = s.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/);
  if (mdyyyy) {
    const d = new Date(Number(mdyyyy[3]), Number(mdyyyy[1]) - 1, Number(mdyyyy[2]));
    return d;
  }

  const md = s.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (md) {
    const d = new Date(now.getFullYear(), Number(md[1]) - 1, Number(md[2]));
    return d;
  }

  const today = /\btoday\b/i.test(t) ? new Date(now) : null;
  const yesterday = /\byesterday\b/i.test(t) ? new Date(now.setDate(now.getDate() - 1)) : null;

  // time: 9am, 9:30, 21:10
  const time = s.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (time) {
    const base = today || yesterday || new Date(defaultDate);
    const hRaw = Number(time[1]);
    const m = time[2] ? Number(time[2]) : 0;
    let h = hRaw;
    const ap = time[3];
    if (ap === "am") {
      h = hRaw % 12;
    } else if (ap === "pm") {
      h = (hRaw % 12) + 12;
    }
    base.setHours(h, m, 0, 0);
    return base;
  }

  if (today) return today;
  if (yesterday) return yesterday;

  // Fallback: defaultDate at 09:00
  const d = new Date(defaultDate);
  d.setHours(9, 0, 0, 0);
  return d;
}

function minutesGuessFromAction(action = "") {
  if (["Butcher", "Package", "Vaccinate", "Deworm"].includes(action)) return 45;
  if (["Clean", "Inspect"].includes(action)) return 20;
  return 10;
}

function normalizeDefault(p) {
  return {
    occurredAt: p.occurredAt || new Date().toISOString(),
    title: p.title || "Animal Task",
    kind: p.kind || "",
    action: p.action || "Inspect",
    qty: typeof p.qty === "number" ? p.qty : undefined,
    unit: p.unit || undefined,
    tags: unique(p.tags || []),
    notes: p.notes || "",
    source: { type: "manual-log", line: p.rawLine || "" },
    createdAt: Date.now(),
  };
}

/* ---------------------------- small widgets --------------------------- */
function Chip({ children }) {
  return <span className="inline-block rounded-full border px-2 py-0.5 text-[11px]">{children}</span>;
}
function Input({ value, onChange, placeholder }) {
  return (
    <input
      type="text"
      className="w-full rounded-lg border px-3 py-2 text-sm"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}
function Select({ value, options = [], onChange, placeholder = "Select…" }) {
  return (
    <select className="w-full rounded-lg border px-3 py-2 text-sm" value={value || ""} onChange={(e) => onChange?.(e.target.value)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  );
}
function TextArea({ value, onChange, rows = 6, placeholder }) {
  return (
    <textarea
      className="w-full rounded-lg border px-3 py-2 text-sm"
      rows={rows}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}
function SkeletonCard() {
  return (
    <div className="rounded-2xl border p-4 shadow-sm animate-pulse">
      <div className="h-4 w-1/2 rounded bg-gray-200" />
      <div className="mt-2 h-3 w-1/3 rounded bg-gray-200" />
      <div className="mt-3 h-16 w-full rounded bg-gray-200" />
    </div>
  );
}

/* ---------------------------- preview card ---------------------------- */
function PreviewCard({ item, selected, onToggle, onEdit, onUseExisting, duplicateInfo, compact }) {
  const dup = duplicateInfo?.get(item.key);
  const hasDup = !!dup;
  return (
    <div className={cx("group relative rounded-2xl border p-4 shadow-sm", selected && "ring-2 ring-black")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold" title={item.title}>{item.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-gray-600">
            {item.kind ? <Chip>{item.kind}</Chip> : null}
            {item.action ? <Chip>{item.action}</Chip> : null}
            {item.occurredAt ? <Chip>{new Date(item.occurredAt).toLocaleString()}</Chip> : null}
            {typeof item.qty === "number" && item.unit ? <Chip>{item.qty} {item.unit}</Chip> : null}
            {hasDup && <Chip>Duplicate</Chip>}
          </div>
        </div>
        <label className="inline-flex items-center gap-2">
          <input
            type="checkbox"
            className="h-4 w-4 accent-black"
            checked={!!selected}
            onChange={(e) => onToggle?.(e.target.checked)}
            aria-label={`Select ${item.title}`}
          />
        </label>
      </div>

      {!compact && (
        <>
          <div className="mt-2 text-xs text-gray-700 line-clamp-3">{item.notes || item.rawLine || "—"}</div>
          {!!(item.tags?.length) && (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.map((t) => <Chip key={t}>#{t}</Chip>)}
            </div>
          )}
        </>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={() => onEdit?.()}>
          Edit
        </button>
        {hasDup && (
          <button
            className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
            title="Use the existing log entry instead of creating a new one"
            onClick={() => onUseExisting?.(dup)}
          >
            Use Existing
          </button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- parsing core --------------------------- */
function buildTitle({ action, kind, qty, unit }) {
  let t = [action, kind].filter(Boolean).join(" • ");
  if (typeof qty === "number" && unit) t += ` (${qty} ${unit})`;
  return t || "Animal Task";
}

function parseLineToPreview(rawLine, defaults) {
  const line = (rawLine || "").trim();
  if (!line) return null;

  // Parse fields
  const occurredDate = parseWhen(line, new Date());
  const action = inferActionFromText(line) || defaults.action || "";
  const kind = inferKindFromText(line, defaults.kind || "");
  const { qty, unit } = parseQtyUnit(line);

  // Tags: pick hashtags and simple keywords
  const hashTags = (line.match(/#([a-z0-9\-\_]+)/gi) || []).map((s) => s.replace(/^#/, ""));
  const quickTags = unique([
    ...hashTags,
    action && slugify(action),
    kind && slugify(kind),
  ]);

  // Notes: content after a ' - ' or everything if no structured bits
  const noteMatch = line.match(/\s-\s(.+)$/);
  const notes = noteMatch ? noteMatch[1] : line;

  const item = {
    key: simpleHash(`${occurredDate.toISOString()}|${line}`),
    rawLine: line,
    occurredAt: occurredDate.toISOString(),
    action,
    kind,
    qty,
    unit,
    tags: quickTags,
    notes,
  };
  item.title = buildTitle(item);
  return item;
}

/* ----------------------------- main panel ----------------------------- */
export default function LogImportPanel({
  onImport,
  onQueue,
  onSchedule,
  normalizer = normalizeDefault,
  dedupe,
  defaultKind,
  className,
}) {
  const [bulk, setBulk] = useState("");
  const [kind, setKind] = useState(defaultKind || "");
  const [action, setAction] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [previews, setPreviews] = useState([]);     // array of normalized preview items
  const [selected, setSelected] = useState(() => new Set());
  const [dupMap, setDupMap] = useState(() => new Map()); // key -> {matchId, versionable?}
  const [compact, setCompact] = useState(false);

  const lines = useMemo(() => {
    // accept lines separated by newline; ignore empties
    return bulk.split(/\n+/g).map((s) => s.trim()).filter(Boolean);
  }, [bulk]);

  const Services = {
    bus: () => window?.eventBus || window?.ssa?.eventBus || null,
    analytics: () => window?.ssa?.analytics || null,
    nba: () => window?.ssa?.services?.nba || window?.NBAOrchestrator || null,
    reminders: () => window?.ssa?.services?.reminders || window?.ReminderManager || null,
    toast(msg) { try { window?.ssa?.ui?.toast?.(msg); } catch { console.log("[toast]", msg); } },
  };

  const doPreview = useCallback(async () => {
    setError("");
    setBusy(true);
    setPreviews([]);
    setSelected(new Set());
    setDupMap(new Map());

    try {
      const defaults = { kind, action };
      const raw = lines.map((ln) => parseLineToPreview(ln, defaults)).filter(Boolean);

      // Normalize for saving
      const normed = raw.map((r) => normalizer(r));
      setPreviews(normed);

      // De-duplication pass
      if (dedupe) {
        try {
          const map = await dedupe(normed.map((r) => r.source?.line ? simpleHash(r.source.line) : r.key || ""));
          if (map && typeof map.forEach === "function") setDupMap(map);
        } catch (e) {
          console.warn("dedupe failed", e);
        }
      } else {
        // lightweight local: mark same key within batch
        const local = new Map();
        const seen = new Set();
        normed.forEach((r) => {
          const key = r.source?.line ? simpleHash(r.source.line) : r.title + "|" + r.occurredAt;
          if (seen.has(key)) local.set(r.key || key, { matchId: key, versionable: true });
          else seen.add(key);
        });
        setDupMap(local);
      }

      Services.analytics()?.track?.("animals:loginport:preview", { count: normed.length });
    } catch (e) {
      console.error(e);
      setError("Failed to parse your logs. Check your lines and try again.");
    } finally {
      setBusy(false);
    }
  }, [lines, normalizer, kind, action]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleSelect(key, checked) {
    setSelected((s) => {
      const next = new Set(s);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  function editItem(key, updater) {
    setPreviews((prev) => prev.map((p) => ((p.key || p.source?.line) === key ? updater({ ...p }) : p)));
  }

  function useExisting(dupInfo) {
    Services.toast("Linked to existing log");
    Services.bus()?.emit?.("animals:collector:use-existing-log", dupInfo);
  }

  function applyTagsToAll(tagsText) {
    const tags = unique(tagsText.split(/[,#\s]+/g));
    setPreviews((prev) => prev.map((p) => ({ ...p, tags: unique([...(p.tags || []), ...tags]) })));
  }

  const selectedItems = useMemo(
    () => previews.filter((p) => selected.has(p.key || (p.source?.line && simpleHash(p.source.line)))),
    [previews, selected]
  );

  async function handleImport() {
    const items = selectedItems;
    if (!items.length) return Services.toast("Select at least one item");
    onImport?.(items);
    Services.bus()?.emit?.("animals:logs:import", { count: items.length });
    Services.analytics()?.track?.("animals:logs:import", { count: items.length });
    Services.toast("Saved to Log");
  }

  async function handleQueue() {
    const items = selectedItems;
    if (!items.length) return Services.toast("Select at least one item");
    onQueue?.(items);
    Services.bus()?.emit?.("animals:logs:queue", { count: items.length });
    Services.analytics()?.track?.("animals:logs:queue", { count: items.length });
    Services.toast("Queued for processing");
  }

  async function handleSchedule() {
    const items = selectedItems;
    if (!items.length) return Services.toast("Select at least one item");
    onSchedule?.(items);
    try {
      // Optional reminders glue — schedule a follow-up at +1 day 9am (simple heuristic)
      const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0);
      items.forEach((it) => {
        const title = `Animals: ${it.action || "Task"} ${it.kind || ""}`.trim();
        window?.ssa?.services?.reminders?.schedule?.({
          title,
          notes: it.title,
          when: d.toISOString(),
          metadata: { kind: it.kind, action: it.action, key: it.key },
        });
      });
    } catch {}
    Services.bus()?.emit?.("animals:logs:schedule", { count: items.length });
    Services.analytics()?.track?.("animals:logs:schedule", { count: items.length });
    Services.toast("Scheduled with reminders");
  }

  // keyboard: Ctrl/Cmd+Enter to Preview
  useEffect(() => {
    const onKey = (e) => {
      const isMac = /Mac|iPhone|iPod|iPad/.test(navigator.platform);
      if ((isMac ? e.metaKey : e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (!busy) doPreview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, doPreview]);

  return (
    <div className={cx("rounded-2xl border bg-white p-4 shadow-sm", className)}>
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Import from Logs</h2>
          <div className="text-xs text-gray-500">
            Paste lines like: <em>“10/23 7am — chickens feed 2 scoops #layer”</em> or <em>“yesterday 6pm goats water 5 gal - trough scrubbed”</em>. Press Ctrl/Cmd+Enter to Preview.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">View</label>
          <select
            className="rounded-lg border px-2 py-1 text-xs"
            value={compact ? "compact" : "comfortable"}
            onChange={(e) => setCompact(e.target.value === "compact")}
          >
            <option value="comfortable">Comfortable</option>
            <option value="compact">Compact</option>
          </select>
        </div>
      </div>

      {/* Input row */}
      <div className="grid gap-3 md:grid-cols-2">
        <TextArea
          value={bulk}
          onChange={setBulk}
          placeholder={`One log per line, e.g.:
10/23 7am chickens feed 2 scoops #layer
10/23 6pm goats water 5 gal - trough scrubbed
today rabbit clean - hutch bedding replaced`}
        />
        <div className="grid gap-2">
          <Select value={kind} options={KIND_OPTS} onChange={setKind} placeholder="Default kind (optional)" />
          <Select value={action} options={ACTION_OPTS} onChange={setAction} placeholder="Default action (optional)" />
          <div className="flex items-center gap-2">
            <Input value={tagInput} onChange={setTagInput} placeholder="Add tags to all (comma or space separated)" />
            <button
              type="button"
              className="shrink-0 rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
              onClick={() => applyTagsToAll(tagInput)}
            >
              Apply
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg bg-black px-3 py-2 text-xs text-white hover:opacity-90"
              onClick={doPreview}
              disabled={!lines.length || busy}
              title="Build previews"
            >
              {busy ? "Building…" : `Preview (${lines.length || 0})`}
            </button>
            <button
              type="button"
              className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50"
              onClick={() => { setBulk(""); setPreviews([]); setSelected(new Set()); setDupMap(new Map()); }}
            >
              Clear
            </button>
          </div>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Results */}
      <div className="mt-4">
        {!busy && !previews.length ? (
          <div className="rounded-2xl border p-6 text-center text-sm text-gray-600">
            No previews yet. Paste log lines and click <em>Preview</em>.
          </div>
        ) : null}

        {busy && !previews.length ? (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        ) : null}

        {!!previews.length && (
          <>
            {/* Bulk actions */}
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-gray-600">
                {selected.size} selected / {previews.length} previews
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="rounded-lg bg-black px-3 py-2 text-xs text-white hover:opacity-90" onClick={handleImport}>
                  Save Selected to Log
                </button>
                <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={handleQueue}>
                  Queue Selected
                </button>
                <button className="rounded-lg border px-3 py-2 text-xs hover:bg-gray-50" onClick={handleSchedule}>
                  Schedule Follow-up
                </button>
              </div>
            </div>

            <div className={cx("grid gap-3", compact ? "md:grid-cols-2" : "md:grid-cols-2 lg:grid-cols-3")}>
              {previews.map((p) => {
                const key = p.key || (p.source?.line && simpleHash(p.source.line)) || p.title + "|" + p.occurredAt;
                return (
                  <PreviewCard
                    key={key}
                    item={{ ...p, key }}
                    selected={selected.has(key)}
                    duplicateInfo={dupMap}
                    compact={compact}
                    onToggle={(checked) => toggleSelect(key, checked)}
                    onUseExisting={(info) => useExisting(info)}
                    onEdit={() => {
                      // lightweight inline editor prompt; parent apps can replace with a modal editor
                      const newTitle = prompt("Edit title:", p.title || "") ?? p.title;
                      const newKind = prompt("Kind (Poultry/Sheep/Goat/Beef/Rabbit/Fish):", p.kind || "") ?? p.kind;
                      const newAction = prompt("Action (Feed/Water/Deworm/Vaccinate/Clean/Inspect/Butcher/Package):", p.action || "") ?? p.action;
                      const newQty = prompt("Quantity (number):", typeof p.qty === "number" ? String(p.qty) : "") ?? (typeof p.qty === "number" ? String(p.qty) : "");
                      const newUnit = prompt("Unit (e.g., scoops, gal, lb):", p.unit || "") ?? p.unit;
                      const newTags = prompt("Tags (comma separated):", (p.tags || []).join(", ")) ?? (p.tags || []).join(", ");
                      const newNotes = prompt("Notes:", p.notes || "") ?? p.notes;
                      editItem(key, (draft) => {
                        draft.title = newTitle;
                        draft.kind = newKind;
                        draft.action = newAction;
                        draft.qty = newQty === "" ? undefined : Number(newQty);
                        draft.unit = newUnit || undefined;
                        draft.tags = unique(newTags.split(/[,\s]+/g));
                        draft.notes = newNotes || "";
                        return draft;
                      });
                    }}
                  />
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

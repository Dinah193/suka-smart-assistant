// src/components/garden/decider/DeciderResultsList.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";

/* --------------------------------- Defensive imports --------------------------------- */
let automation = null;
try {
  // @ts-ignore
  automation = require("@/services/automation/runtime").automation || null;
} catch (_) {}

let GardenQueueManager = null;
try {
  // @ts-ignore
  GardenQueueManager = require("@/managers/GardenQueueManager").default || null;
} catch (_) {}

let ReminderManager = null;
try {
  // @ts-ignore
  ReminderManager = require("@/managers/ReminderManager").default || null;
} catch (_) {}

let estimateEngine = null;
try {
  // @ts-ignore
  estimateEngine = require("@/engines/estimateEngine").default || null;
} catch (_) {}

let scheduleHelpers = null;
try {
  // @ts-ignore
  scheduleHelpers = require("@/engines/scheduleHelpers").default || require("@/engines/scheduleHelpers") || null;
} catch (_) {}

let useGardenStore = null;
try {
  // @ts-ignore
  useGardenStore = require("@/stores/gardenStore").useGardenStore || null;
} catch (_) {}

let NBAInvokeButton = null;
try {
  // Try any existing NBA button locations
  NBAInvokeButton =
    (require("@/components/animals/common/NBAInvokeButton.jsx").default) ||
    (require("@/components/cleaning/common/NBAInvokeButton.jsx").default) ||
    (require("@/components/meals/common/NBAInvokeButton.jsx").default) ||
    null;
} catch (_) {}

/* --------------------------------- Utilities --------------------------------- */
const uid = () => Math.random().toString(36).slice(2, 10);

const fmtDate = (d) => {
  if (!d) return "—";
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(+x)) return "—";
  return x.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
};

const ymd = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (isNaN(+x)) return "0000-00-00";
  const m = `${x.getMonth() + 1}`.padStart(2, "0");
  const day = `${x.getDate()}`.padStart(2, "0");
  return `${x.getFullYear()}-${m}-${day}`;
};

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

const b64 = {
  enc: (o) => {
    try { return btoa(unescape(encodeURIComponent(JSON.stringify(o)))); } catch { return ""; }
  },
  dec: (s) => {
    try { return JSON.parse(decodeURIComponent(escape(atob(s)))); } catch { return null; }
  },
};

const emit = (type, detail) => {
  if (automation?.emit) automation.emit(type, detail);
  window.dispatchEvent(new CustomEvent(type, { detail }));
};

const csvEscape = (v) => {
  const s = (v ?? "").toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCSV = (rows) => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const head = headers.map(csvEscape).join(",");
  const body = rows.map((r) => headers.map((h) => csvEscape(r[h])).join(",")).join("\n");
  return `${head}\n${body}`;
};

/* ------------------------------- Result Accessors ------------------------------- */
/** We accept flexible item shapes:
 * {
 *   id, cropId, cropName, bedId, bedName, targetDate, score, effort, durationMin, priority,
 *   frostSafe, requiresPrep, conflicts:[{withId, note}], tags:[], notes
 * }
 * Fallback keys supported.
 */
function access(item) {
  const crop = item.cropName || item.crop || item.variety || item.name || "Unknown Crop";
  const bed = item.bedName || item.plotName || item.bed || item.plot || "Unassigned";
  const date = item.targetDate || item.date || item.when || null;
  const score = Number.isFinite(item.score) ? item.score : (Number(item.rank) || 0);
  const effort = Number.isFinite(item.effort) ? item.effort : null; // 1..5 (lower = easier)
  const duration = Number.isFinite(item.durationMin) ? item.durationMin : (Number(item.minutes) || null);
  const priority = Number.isFinite(item.priority) ? item.priority : (item.importance ?? 0);
  const frostSafe = !!(item.frostSafe ?? item.isFrostTolerant ?? false);
  const requiresPrep = !!(item.requiresPrep ?? item.needsPreStep ?? false);
  const conflicts = Array.isArray(item.conflicts) ? item.conflicts : [];
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const notes = item.notes || item.note || "";
  const id = item.id || `${crop}:${bed}:${date || "tbd"}`;
  return { id, crop, bed, date, score, effort, duration, priority, frostSafe, requiresPrep, conflicts, tags, notes };
}

/* --------------------------------- Components --------------------------------- */
function Toolbar({
  count,
  selectedCount,
  groupBy, setGroupBy,
  sortBy, setSortBy,
  sortDir, setSortDir,
  onSelectAll,
  onClearSel,
  onBulkAddToPlan,
  onBulkRemind,
  onExportCSV,
  onCopy,
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 justify-between mb-3">
      <div>
        <div className="text-base md:text-lg font-semibold text-gray-800">Results</div>
        <div className="text-xs text-gray-500">{count} suggestion{count===1?"":"s"} • {selectedCount} selected</div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Group</label>
          <select
            className="rounded-lg border px-2 py-1.5 text-sm"
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
          >
            <option value="date">by Date</option>
            <option value="bed">by Bed</option>
            <option value="none">No grouping</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500">Sort</label>
          <select
            className="rounded-lg border px-2 py-1.5 text-sm"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
          >
            <option value="score">Score</option>
            <option value="date">Date</option>
            <option value="effort">Effort</option>
            <option value="duration">Duration</option>
            <option value="priority">Priority</option>
          </select>
          <button
            className="rounded-lg border px-2 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => setSortDir((d) => (d === "desc" ? "asc" : "desc"))}
            title="Toggle sort direction"
          >
            {sortDir === "desc" ? "↓" : "↑"}
          </button>
        </div>

        <div className="hidden md:flex items-center gap-2">
          <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={onSelectAll}>
            Select all
          </button>
          <button className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50" onClick={onClearSel}>
            Clear
          </button>
        </div>

        {NBAInvokeButton ? (
          <NBAInvokeButton scope="garden" intent="decider.results" label="NBA" className="!px-3 !py-1.5" />
        ) : (
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={() => emit("nba.requested", { scope: "garden", from: "DeciderResultsList" })}
          >
            Request NBA
          </button>
        )}

        <div className="flex items-center gap-2">
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
            onClick={onBulkAddToPlan}
          >
            Add to Plan
          </button>
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onBulkRemind}
          >
            Remind
          </button>
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onExportCSV}
          >
            Export CSV
          </button>
          <button
            className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
            onClick={onCopy}
          >
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}

function Badge({ children, kind = "default", title }) {
  const styles = {
    default: "border-gray-300 text-gray-700",
    good: "border-green-300 text-green-700 bg-green-50",
    warn: "border-amber-300 text-amber-700 bg-amber-50",
    danger: "border-red-300 text-red-700 bg-red-50",
    info: "border-blue-300 text-blue-700 bg-blue-50",
  }[kind] || "border-gray-300 text-gray-700";
  return (
    <span title={title} className={`inline-block text-[10px] border px-2 py-0.5 rounded-full ${styles}`}>
      {children}
    </span>
  );
}

function ResultCard({ item, checked, onToggle, onAdd, onRemind, onDetails }) {
  const a = access(item);
  const dur = a.duration ?? estimateEngine?.duration?.(item) ?? null;
  const eff = clamp(a.effort ?? 3, 1, 5);
  const conflictsCount = a.conflicts?.length || 0;

  return (
    <label className={`relative block rounded-2xl border p-3 bg-white hover:shadow-sm transition`}>
      <div className="absolute top-2 right-2">
        <input
          type="checkbox"
          className="h-4 w-4"
          checked={!!checked}
          onChange={(e) => onToggle(e.target.checked)}
          aria-label={`Select ${a.crop} in ${a.bed}`}
        />
      </div>

      <div className="flex items-center gap-2 mb-1">
        <div className="text-sm font-semibold text-gray-800">{a.crop}</div>
        <div className="text-xs text-gray-500">→ {a.bed}</div>
      </div>

      <div className="text-xs text-gray-500 mb-2">
        {fmtDate(a.date)} • Score {Math.round(a.score)} • Effort {eff}/5{dur ? ` • ~${dur}m` : ""}
      </div>

      <div className="flex flex-wrap gap-1 mb-2">
        {a.frostSafe && <Badge kind="good" title="Catalog: frost tolerant">frost-safe</Badge>}
        {a.requiresPrep && <Badge kind="info" title="Requires pre-steps (soak, tray, pre-mix, etc.)">prep</Badge>}
        {!!conflictsCount && <Badge kind="danger" title={`${conflictsCount} potential conflicts`}>conflict</Badge>}
        {a.priority > 0 && <Badge kind="warn" title="Priority boost in decider">priority +{a.priority}</Badge>}
        {(a.tags || []).slice(0, 4).map((t) => <Badge key={t}>{t}</Badge>)}
      </div>

      {a.notes ? <div className="text-[11px] text-gray-600 line-clamp-3 mb-2">{a.notes}</div> : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={onAdd}
          title="Add this suggestion to the planner"
        >
          Add
        </button>
        <button
          type="button"
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={onRemind}
          title="Schedule reminder for this item"
        >
          Remind
        </button>
        <button
          type="button"
          className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
          onClick={onDetails}
          title="Open details / conflict resolver"
        >
          Details
        </button>
      </div>
    </label>
  );
}

/* --------------------------------- Main List --------------------------------- */
export default function DeciderResultsList({
  /** If you pass items, we render those; otherwise read from store: garden.decider.results */
  items,
  /** Optional: filters used (for analytics payloads, scoring context) */
  filters,
  /** Optional: customize initial grouping/sort */
  defaultGroupBy = "date", // "date" | "bed" | "none"
  defaultSortBy = "score", // "score" | "date" | "effort" | "duration" | "priority"
  defaultSortDir = "desc", // "asc" | "desc"
}) {
  const garden = useGardenStore ? useGardenStore() : null;
  const storeItems = garden?.decider?.results || garden?.planner?.candidates || [];
  const results = Array.isArray(items) ? items : storeItems;

  /* ---------- State (persisted to URL + localStorage) ---------- */
  const [groupBy, setGroupBy] = useState(() => {
    const usp = new URLSearchParams(window.location.search);
    return usp.get("dr.groupBy") || localStorage.getItem("suka.decider.groupBy") || defaultGroupBy;
  });
  const [sortBy, setSortBy] = useState(() => {
    const usp = new URLSearchParams(window.location.search);
    return usp.get("dr.sortBy") || localStorage.getItem("suka.decider.sortBy") || defaultSortBy;
  });
  const [sortDir, setSortDir] = useState(() => {
    const usp = new URLSearchParams(window.location.search);
    return usp.get("dr.sortDir") || localStorage.getItem("suka.decider.sortDir") || defaultSortDir;
  });

  useEffect(() => {
    // Persist state
    try {
      const usp = new URLSearchParams(window.location.search);
      usp.set("dr.groupBy", groupBy);
      usp.set("dr.sortBy", sortBy);
      usp.set("dr.sortDir", sortDir);
      const newUrl = `${window.location.pathname}?${usp.toString()}${window.location.hash || ""}`;
      window.history.replaceState({}, "", newUrl);
    } catch {}
    localStorage.setItem("suka.decider.groupBy", groupBy);
    localStorage.setItem("suka.decider.sortBy", sortBy);
    localStorage.setItem("suka.decider.sortDir", sortDir);
  }, [groupBy, sortBy, sortDir]);

  /* ---------- Selection ---------- */
  const [selected, setSelected] = useState({});
  const selectedIds = useMemo(() => Object.keys(selected).filter((k) => selected[k]), [selected]);
  const selectedItems = useMemo(
    () => results.filter((r) => selectedIds.includes(access(r).id)),
    [results, selectedIds]
  );

  const onSelectAll = () => setSelected(Object.fromEntries(results.map((r) => [access(r).id, true])));
  const onClearSel = () => setSelected({});

  /* ---------- Sort & Group ---------- */
  const sorted = useMemo(() => {
    const arr = [...results];
    const getVal = (r) => {
      const a = access(r);
      switch (sortBy) {
        case "date": return a.date ? new Date(a.date).getTime() : 0;
        case "effort": return a.effort ?? 999;
        case "duration": return a.duration ?? estimateEngine?.duration?.(r) ?? 9999;
        case "priority": return a.priority ?? 0;
        case "score":
        default: return a.score ?? 0;
      }
    };
    arr.sort((x, y) => {
      const ax = getVal(x);
      const ay = getVal(y);
      return sortDir === "asc" ? ax - ay : ay - ax;
    });
    return arr;
  }, [results, sortBy, sortDir]);

  const grouped = useMemo(() => {
    if (groupBy === "none") return { All: sorted };
    const map = {};
    for (const r of sorted) {
      const a = access(r);
      const key = groupBy === "bed" ? (a.bed || "Unassigned") : ymd(a.date || "tbd");
      (map[key] = map[key] || []).push(r);
    }
    return map;
  }, [sorted, groupBy]);

  /* ---------- Bulk actions ---------- */
  const addToPlan = (itemsToAdd) => {
    if (GardenQueueManager?.queue) {
      GardenQueueManager.queue({ type: "planner.add.tasks", payload: itemsToAdd });
    }
    emit("garden.planner.add", { count: itemsToAdd.length, filters });
  };

  const bulkAddToPlan = () => {
    if (!selectedItems.length) return;
    addToPlan(selectedItems);
  };

  const scheduleReminders = (itemsToRemind) => {
    if (!itemsToRemind.length) return;
    if (!ReminderManager?.schedule) {
      emit("garden.reminder.simulated", { count: itemsToRemind.length });
      return;
    }
    itemsToRemind.forEach((item) => {
      const a = access(item);
      const when = a.date ? new Date(a.date) : new Date(Date.now() + 1000 * 60 * 60 * 24);
      const title = `Garden task: ${a.crop} → ${a.bed}`;
      const note = a.notes || "Scheduled by Decider";
      ReminderManager.schedule({ title, notes: note, date: when, tags: ["garden", "decider"] });
    });
    emit("garden.reminders.scheduled", { count: itemsToRemind.length });
  };

  const bulkRemind = () => scheduleReminders(selectedItems);

  const exportCSV = () => {
    const rows = sorted.map((r) => {
      const a = access(r);
      return {
        id: a.id,
        crop: a.crop,
        bed: a.bed,
        date: a.date ? new Date(a.date).toISOString().slice(0, 10) : "",
        score: a.score,
        effort: a.effort,
        durationMin: a.duration ?? "",
        priority: a.priority ?? "",
        frostSafe: a.frostSafe ? "yes" : "no",
        requiresPrep: a.requiresPrep ? "yes" : "no",
        tags: (a.tags || []).join("|"),
        notes: a.notes || "",
      };
    });
    const csv = toCSV(rows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const aEl = document.createElement("a");
    aEl.href = url;
    aEl.download = "garden-decider-results.csv";
    aEl.click();
    URL.revokeObjectURL(url);
    emit("garden.decider.export.csv", { count: rows.length });
  };

  const copySummary = async () => {
    const lines = sorted.map((r) => {
      const a = access(r);
      return `• ${fmtDate(a.date)} — ${a.crop} → ${a.bed} (score ${Math.round(a.score)}${a.duration ? `, ~${a.duration}m` : ""})`;
    });
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      emit("ui.toast", { kind: "success", message: "Copied summary to clipboard." });
    } catch {
      emit("ui.toast", { kind: "error", message: "Copy failed." });
    }
  };

  /* ---------- Render ---------- */
  if (!sorted.length) {
    return (
      <div className="rounded-2xl border bg-white p-6 text-center">
        <div className="text-gray-800 font-semibold">No candidates yet</div>
        <div className="text-sm text-gray-500">Adjust filters or run the Decider to generate suggestions.</div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border bg-white p-4 md:p-5 shadow-sm">
      <Toolbar
        count={sorted.length}
        selectedCount={selectedIds.length}
        groupBy={groupBy} setGroupBy={setGroupBy}
        sortBy={sortBy} setSortBy={setSortBy}
        sortDir={sortDir} setSortDir={setSortDir}
        onSelectAll={onSelectAll}
        onClearSel={onClearSel}
        onBulkAddToPlan={bulkAddToPlan}
        onBulkRemind={bulkRemind}
        onExportCSV={exportCSV}
        onCopy={copySummary}
      />

      {/* Groups */}
      <div className="space-y-6">
        {Object.entries(grouped).map(([key, group]) => {
          const label =
            groupBy === "date"
              ? (key === "0000-00-00" ? "No date" : fmtDate(new Date(key)))
              : key;

          return (
            <section key={key}>
              {groupBy !== "none" && (
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium text-gray-700">{label}</div>
                  <div className="text-xs text-gray-500">{group.length} item{group.length===1?"":"s"}</div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                {group.map((r) => {
                  const a = access(r);
                  const isChecked = !!selected[a.id];
                  return (
                    <ResultCard
                      key={a.id}
                      item={r}
                      checked={isChecked}
                      onToggle={(val) => setSelected((s) => ({ ...s, [a.id]: val }))}
                      onAdd={() => addToPlan([r])}
                      onRemind={() => scheduleReminders([r])}
                      onDetails={() => {
                        emit("garden.decider.item.open", { id: a.id, item: r });
                        if ((a.conflicts?.length || 0) > 0) {
                          emit("garden.decider.conflict.request", { id: a.id, item: r });
                        }
                      }}
                    />
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="mt-4 text-[11px] text-gray-500">
        Tip: “Add to Plan” will enqueue tasks via <code>GardenQueueManager</code> (if available). Use “Details” to open a
        conflict resolver when overlaps are detected.
      </div>
    </div>
  );
}

/* eslint-disable no-console */
// src/pages/animals/CollectOrganize.jsx
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * CollectOrganize — Animals (Care + Butchery)
 * ---------------------------------------------------------
 * Goals aligned with Suka Smart Assistant:
 * - "Collector" surface for animals: bulk paste/import + quick add.
 * - Tag/Normalize pass: species, breed, sex, age class, purpose, status.
 * - Source attribution: breeder/farm, purchase, birth details, docs.
 * - Health schedule scaffold: vaccines, deworming, reminders.
 * - Butchery planning: target weight/date, cut sheet intent, chill-chain flags.
 * - Runbook preview: care or butchery steps (hooks into animalExecutor if present).
 * - Send/Sync actions: Inventory, Task Board, Calendar, Storehouse.
 * - NBA (Next Best Action) invoke (non-crashing if NBA not wired).
 * - Undo toasts, empty states, autosave, defensive against missing services.
 *
 * Design cues: Notion (clean cards), Linear (snappy toasts), Stripe Dashboard (empty states),
 * good affordances: inline chips, keyboard-first, small confirmations.
 */

// ----------------------------
// Optional external services (safe shims)
// ----------------------------
const useSafeEventBus = () => {
  const [bus, setBus] = useState(null);
  useEffect(() => {
    let mounted = true;
    // Try to dynamically import a shared eventBus if it exists in this project
    (async () => {
      try {
        // Adjust the path if your event bus lives elsewhere; this is try/catch guarded
        const mod = await import(/* webpackIgnore: true */ "../../services/eventBus.js").catch(() => null);
        if (mounted && mod?.eventBus) setBus(mod.eventBus);
      } catch (e) {
        // Fall through to local shim
      } finally {
        if (mounted && !bus) setBus(createLocalBus());
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);
  return bus ?? createLocalBus();
};

function createLocalBus() {
  // tiny emitter
  const listeners = {};
  return {
    on(evt, cb) {
      listeners[evt] = listeners[evt] || [];
      listeners[evt].push(cb);
      return () => (listeners[evt] = (listeners[evt] || []).filter((f) => f !== cb));
    },
    emit(evt, payload) {
      (listeners[evt] || []).forEach((cb) => {
        try {
          cb(payload);
        } catch (e) {
          console.warn(`eventBus listener error for ${evt}`, e);
        }
      });
    },
  };
}

const useSafeNBA = () => {
  const [invoke, setInvoke] = useState(() => () => {});
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const mod = await import(/* webpackIgnore: true */ "../../services/nbaOrchestrator.js").catch(() => null);
        if (mounted && mod?.invokeNBA) setInvoke(() => mod.invokeNBA);
      } catch (e) {
        // leave as no-op
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);
  return invoke;
};

// ----------------------------
// Local utils
// ----------------------------
const LS_KEY = "animals.collect.draft.v1";

const SPECIES_PRESETS = [
  { key: "sheep", tags: ["ruminant", "wool", "meat"], vaccines: ["CD/T"], deworm: "quarterly" },
  { key: "goat", tags: ["ruminant", "milk"], vaccines: ["CD/T"], deworm: "quarterly" },
  { key: "chicken", tags: ["poultry", "eggs", "meat"], vaccines: ["Marek’s?"], deworm: "semiannual" },
  { key: "cow", tags: ["ruminant", "milk", "beef"], vaccines: ["7-way? region"], deworm: "quarterly" },
];

const PURPOSE_OPTIONS = ["breeding", "milk", "eggs", "meat", "fiber", "guardian", "pet"];
const STATUS_OPTIONS = ["active", "quarantine", "sold", "butcher-queued", "deceased"];

function uid(prefix = "a") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function parseBulk(text) {
  // Accept CSV-ish lines: name,species,breed,sex,ageMonths,purpose,tags (space or comma separated)
  // Also accept simple lines: "5 | lambs | sheep meat"
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const csv = line.split(",").map((s) => s.trim());
      if (csv.length >= 3) {
        const [name, species, breed, sex, ageMonths, purpose, rawTags] = csv;
        return {
          id: uid("animal"),
          name,
          species: species?.toLowerCase(),
          breed: breed || "",
          sex: sex || "",
          ageMonths: ageMonths ? Number(ageMonths) || undefined : undefined,
          purpose: purpose?.toLowerCase(),
          tags: splitTags(rawTags),
          status: "active",
          records: {},
          health: scaffoldHealth(species),
          butchery: {},
        };
      }
      // simple line fallback
      const parts = line.split("|").map((s) => s.trim());
      const [nameGuess, speciesGuess, purposeGuess] = parts;
      return {
        id: uid("animal"),
        name: nameGuess || "",
        species: speciesGuess?.toLowerCase() || "",
        breed: "",
        sex: "",
        ageMonths: undefined,
        purpose: purposeGuess?.toLowerCase(),
        tags: [],
        status: "active",
        records: {},
        health: scaffoldHealth(speciesGuess),
        butchery: {},
      };
    });
}

function splitTags(raw) {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

function scaffoldHealth(species) {
  const preset = SPECIES_PRESETS.find((p) => p.key === (species || "").toLowerCase());
  return {
    vaccinePlan: preset?.vaccines || [],
    dewormPlan: preset?.deworm || "semiannual",
    nextDue: null,
    notes: "",
  };
}

function inferTagsFromSpecies(animal) {
  const preset = SPECIES_PRESETS.find((p) => p.key === (animal.species || "").toLowerCase());
  const merged = new Set([...(animal.tags || []), ...(preset?.tags || [])]);
  if (animal.purpose) merged.add(animal.purpose);
  return Array.from(merged);
}

function buildRunbook(task) {
  // Portable runbook structure; compatible with `animalExecutor.toRunbook` if present
  const base = {
    id: uid("runbook"),
    title: task.title || "Animal Task",
    kind: task.kind || "care", // "care" | "butchery"
    estMinutes: task.estMinutes || 15,
    flags: task.flags || [],
    ppe: task.ppe || ["gloves"],
    sanitize: true,
  };
  if (base.kind === "butchery") {
    base.chillChain = { maxMinutesOut: 20, ...(task.chillChain || {}) };
  }
  if (base.kind === "care") {
    base.feed = task.feed || { items: [], waterCheck: true };
  }
  return base;
}

// Attempt to use animalExecutor if present for richer steps
async function safeAnimalExecutor(task) {
  try {
    const mod = await import(/* webpackIgnore: true */ "../../adapters/execution/animalExecutor.js").catch(() => null);
    if (mod && typeof mod.toRunbook === "function") {
      return mod.toRunbook(task);
    }
  } catch (e) {
    // ignore
  }
  return buildRunbook(task);
}

// ----------------------------
// Tiny UI atoms
// ----------------------------
function Chip({ children, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      {children}
      {onRemove ? (
        <button
          type="button"
          aria-label="remove"
          onClick={onRemove}
          className="opacity-70 hover:opacity-100 focus:outline-none"
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

function Field({ label, children, hint, required }) {
  return (
    <label className="block mb-3">
      <div className="text-xs uppercase tracking-wide mb-1 flex items-center gap-2">
        <span>{label}</span>
        {required ? <span className="text-red-500">*</span> : null}
        {hint ? <span className="text-[10px] text-gray-500">• {hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function SectionCard({ title, actions, children }) {
  return (
    <div className="rounded-2xl border bg-white shadow-sm p-4 md:p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold">{title}</h3>
        <div className="flex gap-2">{actions}</div>
      </div>
      {children}
    </div>
  );
}

function EmptyState({ title, subtitle, action }) {
  return (
    <div className="border-2 border-dashed rounded-2xl p-8 text-center">
      <h4 className="font-semibold mb-1">{title}</h4>
      <p className="text-sm text-gray-600 mb-4">{subtitle}</p>
      {action}
    </div>
  );
}

function Toast({ toast, onUndo, onClose }) {
  if (!toast) return null;
  return (
    <div className="fixed bottom-4 right-4 max-w-sm rounded-xl bg-black text-white p-4 shadow-lg flex items-start gap-3">
      <div className="text-sm flex-1">
        <strong className="block">{toast.title}</strong>
        <span className="opacity-90">{toast.message}</span>
      </div>
      {toast.canUndo ? (
        <button
          className="underline text-sm mr-2"
          onClick={() => {
            onUndo?.(toast);
          }}
        >
          Undo
        </button>
      ) : null}
      <button className="opacity-80 hover:opacity-100" aria-label="close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

// ----------------------------
// Main component
// ----------------------------
export default function CollectOrganize() {
  const eventBus = useSafeEventBus();
  const invokeNBA = useSafeNBA();

  // Draft animals table
  const [rows, setRows] = useState(() => {
    try {
      const cached = localStorage.getItem(LS_KEY);
      return cached ? JSON.parse(cached) : [];
    } catch {
      return [];
    }
  });

  // UI State
  const [tab, setTab] = useState("collect"); // collect | organize | health | butchery | preview
  const [bulkText, setBulkText] = useState("");
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState(null);
  const lastRemovedRef = useRef(null);

  // Autosave
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(rows));
    } catch {}
  }, [rows]);

  // Derived
  const filteredRows = useMemo(() => {
    if (!filter) return rows;
    const f = filter.toLowerCase();
    return rows.filter(
      (r) =>
        r.name?.toLowerCase().includes(f) ||
        r.species?.toLowerCase().includes(f) ||
        (r.tags || []).some((t) => t.includes(f)) ||
        r.purpose?.includes(f) ||
        r.status?.includes(f)
    );
  }, [filter, rows]);

  // Actions
  const addQuick = useCallback(() => {
    const draft = {
      id: uid("animal"),
      name: "",
      species: "",
      breed: "",
      sex: "",
      ageMonths: undefined,
      purpose: "",
      tags: [],
      status: "active",
      records: { source: {}, docs: [] },
      health: scaffoldHealth(""),
      butchery: { targetWeight: "", targetDate: "", chillChain: true, cutsIntent: [] },
    };
    setRows((s) => [draft, ...s]);
  }, []);

  const addBulk = useCallback(() => {
    if (!bulkText.trim()) return;
    const parsed = parseBulk(bulkText);
    // auto-infer tags/species presets
    const enriched = parsed.map((a) => ({ ...a, tags: inferTagsFromSpecies(a) }));
    setRows((s) => [...enriched, ...s]);
    setBulkText("");
    raiseToast("Bulk import complete", `${enriched.length} records added. You can now organize & tag.`, false);
  }, [bulkText]);

  const removeRow = useCallback((id) => {
    setRows((s) => {
      const idx = s.findIndex((r) => r.id === id);
      if (idx === -1) return s;
      const copy = [...s];
      const [removed] = copy.splice(idx, 1);
      lastRemovedRef.current = removed;
      return copy;
    });
    raiseToast("Removed", "Animal removed from draft.", true);
  }, []);

  const undoRemove = useCallback(() => {
    if (!lastRemovedRef.current) return;
    setRows((s) => [lastRemovedRef.current, ...s]);
    lastRemovedRef.current = null;
    dismissToast();
  }, []);

  const normalizeAll = useCallback(() => {
    setRows((s) =>
      s.map((r) => ({
        ...r,
        tags: inferTagsFromSpecies(r),
        health: r.health?.vaccinePlan ? r.health : scaffoldHealth(r.species),
      }))
    );
    raiseToast("Normalized", "Tags & health scaffold refreshed for all.", false);
  }, []);

  const sendTo = useCallback(
    async (target) => {
      // Emit events and play nice with optional services.
      const payload = { target, items: rows, at: Date.now(), kind: "animals" };
      eventBus.emit("export.requested", payload);

      // optimistic "success"
      raiseToast("Sent", `Exported ${rows.length} animals to ${target}.`, true);

      // Optional: integrate with NBA
      try {
        invokeNBA?.({
          reason: "animals_export",
          context: { target, count: rows.length },
        });
      } catch (e) {
        // no-op
      }
    },
    [rows, eventBus, invokeNBA]
  );

  const clearAll = useCallback(() => {
    if (!confirm("Clear all draft animals? This cannot be undone.")) return;
    setRows([]);
    raiseToast("Cleared", "All draft animals removed.", false);
  }, []);

  const raiseToast = (title, message, canUndo) => setToast({ id: uid("t"), title, message, canUndo });
  const dismissToast = () => setToast(null);

  // Runbook preview (batched)
  const [runbooks, setRunbooks] = useState([]);
  const generateRunbooks = useCallback(async () => {
    const tasks = await Promise.all(
      rows.map((r) =>
        safeAnimalExecutor({
          title: r.status === "butcher-queued" ? `Butchery: ${r.name || r.species || r.id}` : `Care: ${r.name || r.species || r.id}`,
          kind: r.status === "butcher-queued" ? "butchery" : "care",
          estMinutes: r.status === "butcher-queued" ? 120 : 10,
          flags: r.status === "butcher-queued" ? ["raw-meat", "biohazard"] : [],
          chillChain: r.status === "butcher-queued" ? { maxMinutesOut: 20 } : undefined,
          feed:
            r.status !== "butcher-queued"
              ? { items: [{ name: "feed", amount: "per ration" }], waterCheck: true }
              : undefined,
          ppe: r.status === "butcher-queued" ? ["gloves", "apron", "face shield"] : ["gloves"],
        })
      )
    );
    setRunbooks(tasks);
    setTab("preview");
  }, [rows]);

  // Inline helpers to update row fields
  const updateRow = (id, patch) => {
    setRows((s) => s.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const appendTag = (id, tag) => {
    setRows((s) =>
      s.map((r) => {
        if (r.id !== id) return r;
        const next = new Set([...(r.tags || []), tag.toLowerCase()]);
        return { ...r, tags: Array.from(next) };
      })
    );
  };

  const removeTag = (id, tag) => {
    setRows((s) =>
      s.map((r) => {
        if (r.id !== id) return r;
        return { ...r, tags: (r.tags || []).filter((t) => t !== tag) };
      })
    );
  };

  // ----------------------------
  // Render
  // ----------------------------
  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <header className="mb-4 md:mb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl md:text-2xl font-semibold">Animals — Collect & Organize</h1>
          <div className="flex gap-2">
            <button
              onClick={normalizeAll}
              className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
              title="Infer tags & health"
            >
              Normalize
            </button>
            <button
              onClick={() => sendTo("Inventory")}
              className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
              title="Sync to Inventory as live assets or carcass yields"
            >
              Send → Inventory
            </button>
            <button
              onClick={() => sendTo("Task Board")}
              className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
              title="Create tasks from care/butchery runbooks"
            >
              Send → Task Board
            </button>
            <button
              onClick={() => sendTo("Calendar")}
              className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"
              title="Schedule health & butchery events"
            >
              Send → Calendar
            </button>
            <button onClick={clearAll} className="rounded-lg border px-3 py-2 text-sm hover:bg-red-50 text-red-600">
              Clear
            </button>
          </div>
        </div>

        <nav className="mt-4 flex gap-2">
          {[
            { k: "collect", t: "Collect" },
            { k: "organize", t: "Organize" },
            { k: "health", t: "Health" },
            { k: "butchery", t: "Butchery" },
            { k: "preview", t: "Runbook Preview" },
          ].map((x) => (
            <button
              key={x.k}
              onClick={() => setTab(x.k)}
              className={`px-3 py-1.5 rounded-lg text-sm border ${
                tab === x.k ? "bg-black text-white border-black" : "hover:bg-gray-50"
              }`}
            >
              {x.t}
            </button>
          ))}
          <div className="ml-auto">
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter…"
              className="px-3 py-1.5 text-sm rounded-lg border w-48"
            />
          </div>
        </nav>
      </header>

      {tab === "collect" && (
        <div className="grid md:grid-cols-2 gap-4">
          <SectionCard
            title="Quick Add"
            actions={
              <button onClick={addQuick} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50">
                + Row
              </button>
            }
          >
            {rows.length === 0 ? (
              <EmptyState
                title="No animals in draft yet"
                subtitle="Start with a quick row or paste a list on the right."
                action={
                  <button onClick={addQuick} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
                    Add a blank row
                  </button>
                }
              />
            ) : (
              <AnimalsTable rows={filteredRows} updateRow={updateRow} removeRow={removeRow} appendTag={appendTag} removeTag={removeTag} />
            )}
          </SectionCard>

          <SectionCard
            title="Bulk Paste / Import"
            actions={
              <>
                <button onClick={addBulk} className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50">
                  Parse & Add
                </button>
              </>
            }
          >
            <Field
              label="Paste CSV or simple lines"
              hint='CSV: name,species,breed,sex,ageMonths,purpose,tags  •  Simple: "5 | lambs | sheep meat"'
            >
              <textarea
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder={`e.g.\nDaisy,sheep,Katahdin,f,18,meat,docile calm\n5 | lambs | sheep meat`}
                rows={10}
                className="w-full rounded-xl border p-2 text-sm"
              />
            </Field>
            <p className="text-xs text-gray-600">
              Tip: Species presets auto-infer tags & health plan. You can refine in the Organize tab.
            </p>
          </SectionCard>
        </div>
      )}

      {tab === "organize" && (
        <SectionCard
          title="Organize, Tag & Attribute"
          actions={
            <button
              onClick={() => setTab("health")}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              title="Next: Health schedules"
            >
              Next → Health
            </button>
          }
        >
          {rows.length === 0 ? (
            <EmptyState
              title="Nothing to organize"
              subtitle="Add animals in the Collect tab. Bulk paste works great."
              action={
                <button onClick={() => setTab("collect")} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
                  Go to Collect
                </button>
              }
            />
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {filteredRows.map((r) => (
                <div key={r.id} className="rounded-xl border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <input
                      value={r.name || ""}
                      onChange={(e) => updateRow(r.id, { name: e.target.value })}
                      placeholder="Name / Tag"
                      className="font-semibold w-48 border rounded-md px-2 py-1"
                    />
                    <button
                      onClick={() => removeRow(r.id)}
                      className="text-red-600 text-sm rounded-lg border px-2 py-1 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Species" required>
                      <select
                        value={r.species || ""}
                        onChange={(e) => updateRow(r.id, { species: e.target.value })}
                        className="w-full border rounded-md px-2 py-1"
                      >
                        <option value="">—</option>
                        {SPECIES_PRESETS.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.key}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Breed">
                      <input
                        value={r.breed || ""}
                        onChange={(e) => updateRow(r.id, { breed: e.target.value })}
                        className="w-full border rounded-md px-2 py-1"
                        placeholder="e.g., Katahdin"
                      />
                    </Field>
                    <Field label="Sex">
                      <select
                        value={r.sex || ""}
                        onChange={(e) => updateRow(r.id, { sex: e.target.value })}
                        className="w-full border rounded-md px-2 py-1"
                      >
                        <option value="">—</option>
                        <option value="m">Male</option>
                        <option value="f">Female</option>
                      </select>
                    </Field>
                    <Field label="Age (months)">
                      <input
                        type="number"
                        min="0"
                        value={r.ageMonths ?? ""}
                        onChange={(e) => updateRow(r.id, { ageMonths: e.target.value ? Number(e.target.value) : undefined })}
                        className="w-full border rounded-md px-2 py-1"
                        placeholder="e.g., 18"
                      />
                    </Field>
                    <Field label="Purpose">
                      <select
                        value={r.purpose || ""}
                        onChange={(e) => updateRow(r.id, { purpose: e.target.value })}
                        className="w-full border rounded-md px-2 py-1"
                      >
                        <option value="">—</option>
                        {PURPOSE_OPTIONS.map((p) => (
                          <option key={p} value={p}>
                            {p}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Status">
                      <select
                        value={r.status || "active"}
                        onChange={(e) => updateRow(r.id, { status: e.target.value })}
                        className="w-full border rounded-md px-2 py-1"
                      >
                        {STATUS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                    </Field>
                  </div>

                  <Field label="Tags" hint="Enter and press Enter">
                    <TagInput
                      value={r.tags || []}
                      onAdd={(t) => appendTag(r.id, t)}
                      onRemove={(t) => removeTag(r.id, t)}
                    />
                  </Field>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Source / Breeder">
                      <input
                        value={r?.records?.source?.breeder || ""}
                        onChange={(e) =>
                          updateRow(r.id, { records: { ...r.records, source: { ...(r.records?.source || {}), breeder: e.target.value } } })
                        }
                        className="w-full border rounded-md px-2 py-1"
                        placeholder="Farm or contact"
                      />
                    </Field>
                    <Field label="Source Type">
                      <select
                        value={r?.records?.source?.type || ""}
                        onChange={(e) =>
                          updateRow(r.id, { records: { ...r.records, source: { ...(r.records?.source || {}), type: e.target.value } } })
                        }
                        className="w-full border rounded-md px-2 py-1"
                      >
                        <option value="">—</option>
                        <option value="born">Born on farm</option>
                        <option value="purchased">Purchased</option>
                        <option value="adopted">Adopted</option>
                      </select>
                    </Field>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {tab === "health" && (
        <SectionCard
          title="Health Schedules"
          actions={
            <button
              onClick={() => setTab("butchery")}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              title="Next: Butchery"
            >
              Next → Butchery
            </button>
          }
        >
          {rows.length === 0 ? (
            <EmptyState
              title="No animals"
              subtitle="Collect & organize first."
              action={
                <button onClick={() => setTab("collect")} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
                  Go to Collect
                </button>
              }
            />
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {filteredRows.map((r) => (
                <div key={r.id} className="rounded-xl border p-4">
                  <div className="font-semibold mb-2">{r.name || r.species || r.id}</div>
                  <Field label="Vaccine Plan">
                    <input
                      value={(r.health?.vaccinePlan || []).join(", ")}
                      onChange={(e) =>
                        updateRow(r.id, { health: { ...(r.health || {}), vaccinePlan: splitTags(e.target.value) } })
                      }
                      className="w-full border rounded-md px-2 py-1"
                      placeholder="Comma separated"
                    />
                  </Field>
                  <Field label="Deworm Plan">
                    <select
                      value={r.health?.dewormPlan || "semiannual"}
                      onChange={(e) => updateRow(r.id, { health: { ...(r.health || {}), dewormPlan: e.target.value } })}
                      className="w-full border rounded-md px-2 py-1"
                    >
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="semiannual">Semi-Annual</option>
                      <option value="annual">Annual</option>
                    </select>
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Next Due (YYYY-MM-DD)">
                      <input
                        value={r.health?.nextDue || ""}
                        onChange={(e) => updateRow(r.id, { health: { ...(r.health || {}), nextDue: e.target.value } })}
                        className="w-full border rounded-md px-2 py-1"
                        placeholder="2025-11-10"
                      />
                    </Field>
                    <Field label="Notes">
                      <input
                        value={r.health?.notes || ""}
                        onChange={(e) => updateRow(r.id, { health: { ...(r.health || {}), notes: e.target.value } })}
                        className="w-full border rounded-md px-2 py-1"
                        placeholder="Observations, reactions, etc."
                      />
                    </Field>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {tab === "butchery" && (
        <SectionCard
          title="Butchery Planning"
          actions={
            <button
              onClick={generateRunbooks}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              title="Build care/butchery runbooks"
            >
              Generate Runbooks
            </button>
          }
        >
          {rows.length === 0 ? (
            <EmptyState
              title="No animals"
              subtitle="Collect & organize first."
              action={
                <button onClick={() => setTab("collect")} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
                  Go to Collect
                </button>
              }
            />
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {filteredRows.map((r) => (
                <div key={r.id} className="rounded-xl border p-4">
                  <div className="flex items-center justify-between mb-2">
                    <div className="font-semibold">{r.name || r.species || r.id}</div>
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!r?.butchery?.chillChain}
                        onChange={(e) =>
                          updateRow(r.id, { butchery: { ...(r.butchery || {}), chillChain: e.target.checked } })
                        }
                      />
                      Chill chain
                    </label>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Target Weight (lbs)">
                      <input
                        type="number"
                        min="0"
                        value={r?.butchery?.targetWeight ?? ""}
                        onChange={(e) =>
                          updateRow(r.id, {
                            butchery: { ...(r.butchery || {}), targetWeight: e.target.value ? Number(e.target.value) : "" },
                          })
                        }
                        className="w-full border rounded-md px-2 py-1"
                        placeholder="e.g., 110"
                      />
                    </Field>
                    <Field label="Target Date">
                      <input
                        value={r?.butchery?.targetDate || ""}
                        onChange={(e) => updateRow(r.id, { butchery: { ...(r.butchery || {}), targetDate: e.target.value } })}
                        className="w-full border rounded-md px-2 py-1"
                        placeholder="YYYY-MM-DD"
                      />
                    </Field>
                  </div>

                  <Field label="Cuts Intent" hint="Comma separated (e.g., chops, roasts, grind, organs)">
                    <input
                      value={(r?.butchery?.cutsIntent || []).join(", ")}
                      onChange={(e) =>
                        updateRow(r.id, { butchery: { ...(r.butchery || {}), cutsIntent: splitTags(e.target.value) } })
                      }
                      className="w-full border rounded-md px-2 py-1"
                      placeholder="chops, roasts, grind, organs"
                    />
                  </Field>

                  <div className="flex items-center justify-between">
                    <label className="inline-flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={r.status === "butcher-queued"}
                        onChange={(e) => updateRow(r.id, { status: e.target.checked ? "butcher-queued" : "active" })}
                      />
                      Queue for butchery
                    </label>
                    <button
                      onClick={() =>
                        invokeNBA?.({
                          reason: "animal_butchery_queue",
                          context: { id: r.id, species: r.species, targetDate: r?.butchery?.targetDate },
                        })
                      }
                      className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
                      title="Suggest Next Best Action"
                    >
                      Suggest NBA
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {tab === "preview" && (
        <SectionCard
          title="Runbook Preview"
          actions={
            <button
              onClick={() => sendTo("Task Board")}
              className="rounded-lg border px-3 py-1.5 text-sm hover:bg-gray-50"
              title="Send runbooks to Task Board"
            >
              Send Runbooks → Task Board
            </button>
          }
        >
          {runbooks.length === 0 ? (
            <EmptyState
              title="No runbooks yet"
              subtitle="Generate from the Butchery tab (also builds Care runbooks for non-queued)."
              action={
                <button onClick={() => setTab("butchery")} className="rounded-lg border px-3 py-2 text-sm hover:bg-gray-50">
                  Go to Butchery
                </button>
              }
            />
          ) : (
            <div className="grid md:grid-cols-2 gap-4">
              {runbooks.map((rb) => (
                <div key={rb.id} className="rounded-xl border p-4">
                  <div className="text-sm uppercase tracking-wide text-gray-600 mb-1">{rb.kind}</div>
                  <div className="font-semibold mb-2">{rb.title}</div>
                  <div className="text-sm mb-2">Est. {rb.estMinutes} min</div>
                  {rb.flags?.length ? (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {rb.flags.map((f) => (
                        <Chip key={f}>{f}</Chip>
                      ))}
                    </div>
                  ) : null}
                  {rb.ppe?.length ? (
                    <div className="text-xs text-gray-700 mb-2">PPE: {rb.ppe.join(", ")}</div>
                  ) : null}
                  {rb.feed ? (
                    <div className="text-xs text-gray-700">Feed: water check {rb.feed.waterCheck ? "✓" : "—"}</div>
                  ) : null}
                  {rb.chillChain ? (
                    <div className="text-xs text-gray-700">Chill-chain: max {rb.chillChain.maxMinutesOut} min out</div>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      <Toast toast={toast} onUndo={undoRemove} onClose={dismissToast} />
    </div>
  );
}

// ----------------------------
// Subcomponents
// ----------------------------
function AnimalsTable({ rows, updateRow, removeRow, appendTag, removeTag }) {
  if (!rows.length) return null;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left border-b">
            {["Name", "Species", "Breed", "Sex", "Age (m)", "Purpose", "Status", "Tags", ""].map((h) => (
              <th key={h} className="py-2 pr-3 font-semibold">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b">
              <td className="py-2 pr-3">
                <input
                  value={r.name || ""}
                  onChange={(e) => updateRow(r.id, { name: e.target.value })}
                  placeholder="Name / Tag"
                  className="w-36 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <input
                  value={r.species || ""}
                  onChange={(e) => updateRow(r.id, { species: e.target.value })}
                  placeholder="sheep"
                  className="w-28 border rounded-md px-2 py-1"
                  list="species-list"
                />
                <datalist id="species-list">
                  {SPECIES_PRESETS.map((s) => (
                    <option key={s.key} value={s.key} />
                  ))}
                </datalist>
              </td>
              <td className="py-2 pr-3">
                <input
                  value={r.breed || ""}
                  onChange={(e) => updateRow(r.id, { breed: e.target.value })}
                  placeholder="breed"
                  className="w-36 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <select
                  value={r.sex || ""}
                  onChange={(e) => updateRow(r.id, { sex: e.target.value })}
                  className="w-24 border rounded-md px-2 py-1"
                >
                  <option value="">—</option>
                  <option value="m">M</option>
                  <option value="f">F</option>
                </select>
              </td>
              <td className="py-2 pr-3">
                <input
                  type="number"
                  min="0"
                  value={r.ageMonths ?? ""}
                  onChange={(e) => updateRow(r.id, { ageMonths: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="18"
                  className="w-20 border rounded-md px-2 py-1"
                />
              </td>
              <td className="py-2 pr-3">
                <select
                  value={r.purpose || ""}
                  onChange={(e) => updateRow(r.id, { purpose: e.target.value })}
                  className="w-32 border rounded-md px-2 py-1"
                >
                  <option value="">—</option>
                  {PURPOSE_OPTIONS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-3">
                <select
                  value={r.status || "active"}
                  onChange={(e) => updateRow(r.id, { status: e.target.value })}
                  className="w-40 border rounded-md px-2 py-1"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </td>
              <td className="py-2 pr-3">
                <TagInput value={r.tags || []} onAdd={(t) => appendTag(r.id, t)} onRemove={(t) => removeTag(r.id, t)} />
              </td>
              <td className="py-2 pr-3 text-right">
                <button onClick={() => removeRow(r.id)} className="text-red-600 text-xs rounded-lg border px-2 py-1 hover:bg-red-50">
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TagInput({ value, onAdd, onRemove }) {
  const [draft, setDraft] = useState("");
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {value.map((t) => (
        <Chip key={t} onRemove={() => onRemove?.(t)}>
          {t}
        </Chip>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim()) {
            onAdd?.(draft.trim());
            setDraft("");
          }
        }}
        placeholder="add tag"
        className="border rounded-md px-2 py-1 text-sm w-28"
      />
    </div>
  );
}

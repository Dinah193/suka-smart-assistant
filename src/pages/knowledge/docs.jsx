/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\knowledge\docs.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
} from "react";

/**
 * knowledge/docs.jsx — Knowledge Docs Hub
 * -----------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * Imports → Intelligence → Automation → (optional) Hub Export
 *
 * - Central place to curate operational knowledge: SOPs, how-tos, session playbooks,
 *   domain notes (meals, cleaning, garden, animal, preservation, storehouse).
 * - Docs are first-class *intelligence*. Engines may reference them to size sessions,
 *   map equipment/methods, or gate tasks via rules. Because some docs affect downstream
 *   scheduling (e.g., “Pressure-canning safety SOP”), we emit events on CRUD and,
 *   when a doc is flagged as operational/affecting domains, we optionally export to Hub.
 *
 * FORWARD-THINKING
 * - Category/domain/tag-agnostic. New domains appear via data (no code changes).
 * - Soft imports for services/db/markdown renderer.
 * - Defensively validates, bounds in-memory lists, and early-returns on bad input.
 *
 * EMITTED EVENTS (canonical payload: { type, ts, source, data })
 *   docs.created
 *   docs.updated
 *   docs.deleted
 *   docs.viewed
 *   docs.index.rebuilt         // downstream search/indexers can refresh
 */

// ----------------------------- Soft Imports ---------------------------------
let eventBus = null;
try {
  eventBus =
    require("@/services/events/eventBus").default ??
    require("@/services/events/eventBus");
} catch {}

let Config = { get: (k, fallback) => fallback };
try {
  Config = require("@/config").default ?? require("@/config");
} catch {}

let HubPacketFormatter = null;
try {
  HubPacketFormatter = require("@/services/hub/HubPacketFormatter").default;
} catch {}

let FamilyFundConnector = null;
try {
  FamilyFundConnector = require("@/services/hub/FamilyFundConnector").default;
} catch {}

let db = null; // Dexie instance (optional)
try {
  db = require("@/db").default ?? require("@/db");
} catch {}

let DocsService = null; // Optional domain service abstraction
try {
  DocsService = require("@/services/knowledge/DocsService").default;
} catch {}

let Markdown = null; // Optional pretty renderer
try {
  Markdown = require("@/components/Markdown").default;
} catch {}

// ------------------------------ Utilities -----------------------------------
const NOW_ISO = () => new Date().toISOString();

function isISO(s) {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !Number.isNaN(d.valueOf());
}
function ensureISO(ts) {
  return isISO(ts) ? ts : NOW_ISO();
}
function nanoid(len = 12) {
  const a = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < len; i++) out += a[(Math.random() * a.length) | 0];
  return out;
}

function validateDoc(obj) {
  if (!obj || typeof obj !== "object")
    return { ok: false, reason: "not-an-object" };
  if (!obj.id || typeof obj.id !== "string")
    return { ok: false, reason: "missing-id" };
  if (!obj.title || typeof obj.title !== "string")
    return { ok: false, reason: "missing-title" };
  if (!obj.category || typeof obj.category !== "string")
    return { ok: false, reason: "missing-category" };
  // content can be markdown string or blocks[]; we store as string
  if (obj.content != null && typeof obj.content !== "string")
    return { ok: false, reason: "content-must-be-string" };
  // optional: domains[], tags[], affects[], meta{}
  return { ok: true };
}

function normalizeDoc(obj) {
  return {
    id: String(obj.id),
    title: String(obj.title),
    category: String(obj.category), // e.g., "SOP", "Guide", "Reference", "Checklist"
    content: typeof obj.content === "string" ? obj.content : "",
    domains: Array.isArray(obj.domains) ? obj.domains.map(String) : [], // meals, cleaning, garden, animal, preservation, storehouse
    tags: Array.isArray(obj.tags) ? obj.tags.map(String) : [],
    affects: Array.isArray(obj.affects) ? obj.affects.map(String) : [], // signals operational impact
    meta: typeof obj.meta === "object" && obj.meta ? obj.meta : {},
    updatedAt: NOW_ISO(),
    createdAt:
      obj.createdAt && isISO(obj.createdAt) ? obj.createdAt : NOW_ISO(),
  };
}

function isOperationalImpact(doc) {
  // If the doc claims it affects operational domains or declares operational=true in meta
  if (!doc) return false;
  if (Array.isArray(doc.affects) && doc.affects.some(Boolean)) return true;
  if (doc.meta?.operational === true) return true;
  return false;
}

// Silent best-effort export to Hub for operationally significant knowledge
async function exportToHubIfEnabled(eventPayload) {
  try {
    const flags = Config.get?.("featureFlags", {}) ?? {};
    if (!flags.familyFundMode) return;
    if (!HubPacketFormatter || !FamilyFundConnector) return;
    const packet = HubPacketFormatter.format?.(eventPayload);
    if (!packet) return;
    await FamilyFundConnector.send?.(packet);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[knowledge/docs] Hub export failed (ignored):", err);
    }
  }
}

function emitEvent(type, source, data, maybeExport) {
  const payload = { type, ts: NOW_ISO(), source, data };
  try {
    eventBus?.emit?.(payload);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[knowledge/docs] bus.emit failed:", e);
    }
  }
  if (maybeExport) exportToHubIfEnabled(payload);
  return payload;
}

// --------------------------- Data Access (soft) ------------------------------
async function listDocs() {
  if (DocsService?.list) return (await DocsService.list()) ?? [];
  if (db?.docs?.toArray) return (await db.docs.toArray()) ?? [];
  return [];
}
async function upsertDoc(doc) {
  if (!doc?.id) throw new Error("doc.id required");
  if (DocsService?.upsert) return DocsService.upsert(doc);
  if (db?.docs?.put) return db.docs.put(doc);
  return null;
}
async function deleteDoc(id) {
  if (!id) return;
  if (DocsService?.remove) return DocsService.remove(id);
  if (db?.docs?.delete) return db.docs.delete(id);
  return null;
}

// ------------------------------- Component -----------------------------------
export default function KnowledgeDocsPage() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [domain, setDomain] = useState("all");
  const [status, setStatus] = useState({ kind: "idle", message: "" });
  const [active, setActive] = useState(null); // doc id for preview/edit
  const fileRef = useRef(null);

  // Initial load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const all = await listDocs();
        if (!alive) return;
        setItems(Array.isArray(all) ? all : []);
      } catch {
        setStatus({
          kind: "warn",
          message: "Could not load knowledge docs (degraded mode).",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Facets
  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.category).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [items]);

  const domains = useMemo(() => {
    const set = new Set(
      items
        .flatMap((i) => (Array.isArray(i.domains) ? i.domains : []))
        .filter(Boolean)
    );
    return ["all", ...Array.from(set).sort()];
  }, [items]);

  // Filtered
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((d) => {
      if (category !== "all" && d.category !== category) return false;
      if (
        domain !== "all" &&
        !(Array.isArray(d.domains) && d.domains.includes(domain))
      )
        return false;
      if (!needle) return true;
      const hay = `${d.id} ${d.title} ${d.category} ${d.tags?.join(
        " "
      )} ${d.domains?.join(" ")} ${d.content}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [items, q, category, domain]);

  // KPIs
  const kpis = useMemo(() => {
    const total = items.length;
    const operational = items.filter(isOperationalImpact).length;
    const byCategory = items.reduce((acc, d) => {
      acc[d.category] = (acc[d.category] ?? 0) + 1;
      return acc;
    }, {});
    const topCat = Object.entries(byCategory).sort((a, b) => b[1] - a[1])[0];
    return { total, operational, topCat };
  }, [items]);

  // ------------------------------- Actions ----------------------------------
  const onNew = useCallback(async () => {
    const draft = normalizeDoc({
      id: `doc-${nanoid(6)}`,
      title: "Untitled",
      category: "Guide",
      content: "",
      domains: [],
      tags: [],
      affects: [],
    });
    try {
      await upsertDoc(draft);
      setItems((prev) => [draft, ...prev]);
      setActive(draft.id);
      emitEvent(
        "docs.created",
        "KnowledgeDocs",
        { id: draft.id, category: draft.category },
        false
      );
    } catch {
      setStatus({ kind: "error", message: "Create failed." });
    }
  }, []);

  const onDelete = useCallback(
    async (id) => {
      if (!id) return;
      if (!confirm("Delete this document?")) return;
      try {
        await deleteDoc(id);
        setItems((prev) => prev.filter((x) => x.id !== id));
        if (active === id) setActive(null);
        emitEvent("docs.deleted", "KnowledgeDocs", { id }, false);
      } catch {
        setStatus({ kind: "error", message: "Delete failed." });
      }
    },
    [active]
  );

  const onSave = useCallback(
    async (id, patch) => {
      const src = items.find((x) => x.id === id);
      if (!src) return;
      const candidate = normalizeDoc({
        ...src,
        ...patch,
        updatedAt: NOW_ISO(),
      });
      const check = validateDoc(candidate);
      if (!check.ok) {
        setStatus({
          kind: "error",
          message: `Validation failed: ${check.reason}`,
        });
        return;
      }
      try {
        await upsertDoc(candidate);
        setItems((prev) => prev.map((x) => (x.id === id ? candidate : x)));
        const op = isOperationalImpact(candidate);
        emitEvent(
          "docs.updated",
          "KnowledgeDocs",
          {
            id,
            category: candidate.category,
            affects: candidate.affects,
            domains: candidate.domains,
          },
          op // only export if operational
        );
      } catch {
        setStatus({ kind: "error", message: "Save failed." });
      }
    },
    [items]
  );

  const onOpen = useCallback((doc) => {
    setActive(doc.id);
    emitEvent(
      "docs.viewed",
      "KnowledgeDocs",
      { id: doc.id, category: doc.category },
      false
    );
  }, []);

  const onExportAll = useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(items, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ssa-knowledge-docs-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setStatus({ kind: "error", message: "Export failed." });
    }
  }, [items]);

  const onImportClick = useCallback(() => fileRef.current?.click(), []);
  const onImportFile = useCallback(
    async (e) => {
      try {
        const file = e.target.files?.[0];
        if (!file) return;
        const text = await file.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          setStatus({ kind: "error", message: "Invalid JSON." });
          return;
        }
        const incoming = Array.isArray(json) ? json : [json];
        let created = 0;
        let updated = 0;

        for (const raw of incoming) {
          const check = validateDoc(raw);
          if (!check.ok) {
            console.warn("Skipped invalid doc:", check.reason, raw);
            continue;
          }
          const norm = normalizeDoc(raw);
          const exists = items.find((d) => d.id === norm.id);
          await upsertDoc(norm);
          const op = isOperationalImpact(norm);
          if (exists) {
            emitEvent("docs.updated", "KnowledgeDocs", { id: norm.id }, op);
            updated++;
          } else {
            emitEvent("docs.created", "KnowledgeDocs", { id: norm.id }, op);
            created++;
          }
        }

        const fresh = await listDocs();
        setItems(Array.isArray(fresh) ? fresh : []);
        setStatus({
          kind: "ok",
          message: `Imported ${
            created + updated
          } doc(s) (${created} created, ${updated} updated).`,
        });
        e.target.value = "";
      } catch {
        setStatus({ kind: "error", message: "Import failed." });
      }
    },
    [items]
  );

  const onRebuildIndex = useCallback(() => {
    emitEvent(
      "docs.index.rebuilt",
      "KnowledgeDocs",
      { count: items.length },
      false
    );
    setStatus({ kind: "ok", message: "Index rebuild signal emitted." });
  }, [items.length]);

  const activeDoc = useMemo(
    () => items.find((x) => x.id === active) || null,
    [items, active]
  );

  // ------------------------------- Render -----------------------------------
  return (
    <div className="p-4 md:p-6">
      <header className="mb-5 md:mb-7">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold">
              Knowledge Docs
            </h1>
            <p className="text-sm text-neutral-600">
              SOPs, guides, and references that power SSA intelligence. CRUD
              emits bus events; operational docs may export to the Hub when
              enabled.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={onNew}
            >
              New doc
            </button>
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={onRebuildIndex}
            >
              Rebuild index
            </button>
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={onExportAll}
            >
              Export JSON
            </button>
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={onImportClick}
            >
              Import JSON
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json"
              className="hidden"
              onChange={onImportFile}
            />
          </div>
        </div>

        {status.kind !== "idle" && (
          <div
            className={
              "mt-2 text-xs rounded-lg p-2 border " +
              (status.kind === "ok"
                ? "border-green-300 bg-green-50 text-green-800"
                : status.kind === "warn"
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : status.kind === "error"
                ? "border-rose-300 bg-rose-50 text-rose-800"
                : "border-neutral-200")
            }
          >
            {status.message}
          </div>
        )}
      </header>

      {/* KPI Strip */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-6">
        <KpiCard label="Total docs" value={kpis.total} />
        <KpiCard label="Operational docs" value={kpis.operational} />
        <KpiCard
          label="Top category"
          value={kpis.topCat ? `${kpis.topCat[0]} ×${kpis.topCat[1]}` : "—"}
        />
      </section>

      {/* Filters */}
      <section className="rounded-2xl border p-3 md:p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3 md:gap-4">
          <div className="md:col-span-5">
            <label className="block text-xs text-neutral-600 mb-1">
              Search
            </label>
            <input
              className="w-full rounded-xl border px-3 py-2 text-sm"
              placeholder="Find by title, tags, content…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="md:col-span-3">
            <label className="block text-xs text-neutral-600 mb-1">
              Category
            </label>
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm bg-white"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="block text-xs text-neutral-600 mb-1">
              Domain
            </label>
            <select
              className="w-full rounded-xl border px-3 py-2 text-sm bg-white"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
            >
              {domains.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      {/* Grid + Preview */}
      <section className="grid grid-cols-1 xl:grid-cols-3 gap-3 md:gap-4">
        <div className="xl:col-span-1">
          {filtered.length === 0 ? (
            <div className="text-sm text-neutral-600 border rounded-2xl p-6 text-center">
              No docs found. Create one or import JSON.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3">
              {filtered.map((d) => (
                <DocListItem
                  key={d.id}
                  doc={d}
                  isActive={active === d.id}
                  onOpen={onOpen}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )}
        </div>

        <div className="xl:col-span-2">
          <div className="rounded-2xl border p-3 md:p-4 min-h-[300px]">
            {!activeDoc ? (
              <div className="text-sm text-neutral-600">
                Select a document to preview/edit.
              </div>
            ) : (
              <DocEditor doc={activeDoc} onSave={onSave} />
            )}
          </div>
        </div>
      </section>

      {/* Help */}
      <section className="mt-8">
        <details className="rounded-2xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            How docs drive SSA
          </summary>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
            <li>
              <strong>Imports →</strong> Video/how-to/recipe/seed pages become
              docs; normalizers extract equipment, methods, and seasonality as
              tags/domains.
            </li>
            <li>
              <strong>Intelligence →</strong> Engines consult SOPs/Guides to
              size sessions (e.g., dehydrator tray counts, canner batch sizes).
            </li>
            <li>
              <strong>Automation →</strong> Rules reference doc tags (e.g.,{" "}
              <em>quiet-hours</em> +<em>noisy equipment</em>) to defer or
              convert tasks to notifications.
            </li>
            <li>
              <strong>Hub export (optional) →</strong> Operational docs
              (affects[]) can be shared to SVFFH so community services align
              training/quality standards.
            </li>
          </ul>
        </details>
      </section>
    </div>
  );
}

// ------------------------------- UI Bits ------------------------------------
function KpiCard({ label, value }) {
  return (
    <div className="rounded-2xl border p-3 md:p-4">
      <div className="text-xs text-neutral-600 mb-1">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{value ?? 0}</div>
    </div>
  );
}

function DocListItem({ doc, isActive, onOpen, onDelete }) {
  const op = isOperationalImpact(doc);
  return (
    <div
      className={
        "rounded-2xl border p-3 md:p-4 shadow-sm transition-shadow cursor-pointer " +
        (isActive ? "ring-2 ring-blue-300" : "hover:shadow-md")
      }
      onClick={() => onOpen?.(doc)}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium">{doc.title}</div>
          <div className="text-xs text-neutral-600">
            <span className="px-2 py-0.5 border rounded-full">
              {doc.category}
            </span>
            {doc.domains?.length ? (
              <span className="ml-2 text-neutral-500">
                • {doc.domains.join(", ")}
              </span>
            ) : null}
            {op ? (
              <span className="ml-2 text-emerald-600">• operational</span>
            ) : null}
          </div>
        </div>
        <div
          className="flex items-center gap-1"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="text-xs rounded-lg border px-2 py-1 hover:shadow text-rose-700"
            onClick={() => onDelete?.(doc.id)}
            title="Delete"
          >
            Delete
          </button>
        </div>
      </div>
      {doc.tags?.length ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {doc.tags.slice(0, 8).map((t) => (
            <span
              key={t}
              className="text-[11px] px-2 py-0.5 border rounded-full"
            >
              #{t}
            </span>
          ))}
          {doc.tags.length > 8 ? (
            <span className="text-[11px] text-neutral-500">
              +{doc.tags.length - 8}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DocEditor({ doc, onSave }) {
  const [local, setLocal] = useState(doc);

  useEffect(() => setLocal(doc), [doc]);

  const save = useCallback(() => {
    const patch = {};
    for (const k of ["title", "category", "content"]) {
      if (local[k] !== doc[k]) patch[k] = local[k];
    }
    if (JSON.stringify(local.domains) !== JSON.stringify(doc.domains))
      patch.domains = local.domains;
    if (JSON.stringify(local.tags) !== JSON.stringify(doc.tags))
      patch.tags = local.tags;
    if (JSON.stringify(local.affects) !== JSON.stringify(doc.affects))
      patch.affects = local.affects;
    if (JSON.stringify(local.meta) !== JSON.stringify(doc.meta))
      patch.meta = local.meta;
    if (Object.keys(patch).length === 0) return;
    onSave?.(doc.id, patch);
  }, [doc, local, onSave]);

  return (
    <div className="grid grid-cols-1 gap-3">
      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
        <LabeledInput
          className="md:col-span-6"
          label="Title"
          value={local.title}
          onChange={(v) => setLocal((s) => ({ ...s, title: v }))}
        />
        <LabeledInput
          className="md:col-span-3"
          label="Category"
          value={local.category}
          onChange={(v) => setLocal((s) => ({ ...s, category: v }))}
        />
        <LabeledInput
          className="md:col-span-3"
          label="Domains (comma-sep)"
          value={(local.domains || []).join(", ")}
          onChange={(v) =>
            setLocal((s) => ({
              ...s,
              domains: v
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            }))
          }
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
        <LabeledInput
          className="md:col-span-6"
          label="Tags (comma-sep)"
          value={(local.tags || []).join(", ")}
          onChange={(v) =>
            setLocal((s) => ({
              ...s,
              tags: v
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            }))
          }
        />
        <LabeledInput
          className="md:col-span-6"
          label="Affects (comma-sep) — mark as operational (e.g., inventory, storehouse, sessions)"
          value={(local.affects || []).join(", ")}
          onChange={(v) =>
            setLocal((s) => ({
              ...s,
              affects: v
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean),
            }))
          }
        />
      </div>

      <div>
        <div className="block text-xs text-neutral-600 mb-1">
          Content (Markdown supported)
        </div>
        <textarea
          className="w-full rounded-xl border px-3 py-2 text-sm font-mono min-h-48"
          spellCheck={false}
          value={local.content}
          onChange={(e) => setLocal((s) => ({ ...s, content: e.target.value }))}
          placeholder="# Title\n\nWrite your SOP/guide here…"
        />
      </div>

      {/* Preview */}
      <div className="rounded-xl border bg-neutral-50 dark:bg-neutral-900 p-3">
        <div className="text-xs text-neutral-600 mb-2">Preview</div>
        <div className="prose prose-sm max-w-none">
          {Markdown ? (
            <Suspense
              fallback={
                <div className="text-xs text-neutral-600">Rendering…</div>
              }
            >
              <Markdown>{local.content || "_(empty)_"}</Markdown>
            </Suspense>
          ) : (
            <pre className="text-xs whitespace-pre-wrap">
              {local.content || "(empty)"}
            </pre>
          )}
        </div>
      </div>

      {/* Meta JSON */}
      <LabeledJSON
        label="Meta (JSON)"
        value={local.meta}
        onChange={(obj) => setLocal((s) => ({ ...s, meta: obj }))}
      />

      <div className="flex items-center gap-2">
        <button
          className="text-xs rounded-lg border px-3 py-2 hover:shadow"
          onClick={save}
        >
          Save changes
        </button>
        <span className="text-[11px] text-neutral-500">
          Updated{" "}
          {doc.updatedAt ? new Date(doc.updatedAt).toLocaleString() : "—"}
        </span>
      </div>
    </div>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  className = "",
}) {
  return (
    <div className={className}>
      <label className="block text-xs text-neutral-600 mb-1">{label}</label>
      <input
        type={type}
        className="w-full rounded-xl border px-3 py-2 text-sm"
        value={value ?? ""}
        onChange={(e) => onChange?.(e.target.value)}
      />
    </div>
  );
}

function LabeledJSON({ label, value, onChange }) {
  const [text, setText] = useState(stableStringify(value));
  useEffect(() => setText(stableStringify(value)), [value]);

  const onBlur = () => {
    try {
      const parsed = text.trim() ? JSON.parse(text) : {};
      onChange?.(parsed);
    } catch {
      // keep text; user can fix
    }
  };

  return (
    <div>
      <div className="block text-xs text-neutral-600 mb-1">{label}</div>
      <textarea
        className="w-full rounded-xl border px-3 py-2 text-xs font-mono min-h-28"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={onBlur}
        placeholder='e.g. {"operational": true, "reviewedBy": "QA"}'
      />
    </div>
  );
}

function stableStringify(obj) {
  try {
    const keys = Object.keys(obj ?? {}).sort();
    return JSON.stringify(obj ?? {}, keys, 2);
  } catch {
    return "{}";
  }
}

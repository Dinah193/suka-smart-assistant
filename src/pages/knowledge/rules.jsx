/* eslint-disable no-console */
// C:\Users\larho\suka-smart-assistant\src\pages\knowledge\rules.jsx
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * knowledge/rules.jsx — Rules & Guards Knowledge Page
 * -----------------------------------------------------------------------------
 * ROLE IN PIPELINE
 * Imports → Intelligence → Automation → (optional) Hub Export
 *
 * - Central place to view and manage household rules & guards:
 *   • sabbathGuard, quietHoursGuard, weatherGuard
 *   • inventoryGuard, storehouse policies, engine toggles
 *   • custom rules that schedule/suppress sessions (cooking, cleaning, garden, animal, preservation)
 *
 * - Editing rules changes household *intelligence* that feeds the automation runtime.
 *   This page emits bus events in the canonical shape: { type, ts, source, data }.
 *   If featureFlags.familyFundMode is ON, we opportunistically export to Hub.
 *
 * FORWARD-THINKING
 * - Category-agnostic: supports new domains (“preservation”, “animal”, “storehouse”) with no code changes.
 * - Soft-imports for db/services so the page renders even in degraded mode.
 * - Defensive validation of rule objects + bounded state.
 *
 * EMITTED EVENTS
 *   rules.created
 *   rules.updated
 *   rules.deleted
 *   rules.recompiled            // signal for automation runtime to reload/compile rules
 *   rules.test.probe            // non-mutating probe for a given rule against a sample payload
 */

// ----------------------------- Soft Imports ---------------------------------
let eventBus = null;
try {
  eventBus =
    require("@/services/events/eventBus").default ??
    require("@/services/events/eventBus");
} catch {}

let Config = { get: (_k, fallback) => fallback };
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

let db = null; // Dexie (optional)
try {
  db = require("@/db").default ?? require("@/db");
} catch {}

let RulesService = null; // Optional domain service abstraction
try {
  RulesService = require("@/services/rules/RulesService").default;
} catch {}

let AutomationRuntime = null; // Optional: nudge runtime to reload rules
try {
  AutomationRuntime = require("@/services/automation/runtime").default;
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

// Minimal, extensible rule validator
// Rule shape (suggested):
// {
//   id: "quiet-hours",
//   name: "Quiet Hours",
//   category: "guard" | "policy" | "engine" | "custom",
//   domain: "global" | "meals" | "cleaning" | "garden" | "animal" | "preservation" | "storehouse",
//   enabled: true,
//   priority: 50,     // lower runs first
//   when: {...},      // predicate config (time windows, weather, inventory thresholds, etc.)
//   then: {...},      // action config (suppress, schedule, delay, convert to notification, etc.)
//   notes: "…",
//   updatedAt, createdAt
// }
function validateRule(obj) {
  if (!obj || typeof obj !== "object")
    return { ok: false, reason: "not-an-object" };
  if (!obj.id || typeof obj.id !== "string")
    return { ok: false, reason: "missing-id" };
  if (!obj.name || typeof obj.name !== "string")
    return { ok: false, reason: "missing-name" };
  if (!obj.category || typeof obj.category !== "string")
    return { ok: false, reason: "missing-category" };
  if (!obj.domain || typeof obj.domain !== "string")
    return { ok: false, reason: "missing-domain" };
  if (typeof obj.enabled !== "boolean")
    return { ok: false, reason: "missing-enabled" };
  return { ok: true };
}

function normalizeRule(obj) {
  return {
    id: String(obj.id),
    name: String(obj.name),
    category: String(obj.category),
    domain: String(obj.domain),
    enabled: !!obj.enabled,
    priority: Number.isFinite(obj.priority) ? obj.priority : 50,
    when: typeof obj.when === "object" && obj.when ? obj.when : {},
    then: typeof obj.then === "object" && obj.then ? obj.then : {},
    notes: obj.notes ?? "",
    updatedAt: NOW_ISO(),
    createdAt:
      obj.createdAt && isISO(obj.createdAt) ? obj.createdAt : NOW_ISO(),
    meta: typeof obj.meta === "object" && obj.meta ? obj.meta : {},
  };
}

// Hub export (silent, non-blocking)
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
      console.debug("[rules] Hub export failed (ignored):", err);
    }
  }
}

// Safe emit helper
function emitEvent(type, source, data) {
  const payload = { type, ts: NOW_ISO(), source, data };
  try {
    eventBus?.emit?.(payload);
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.debug("[rules] bus.emit failed:", e);
    }
  }
  // Rules impact automation; mirror to Hub if enabled.
  if (type.startsWith("rules.")) exportToHubIfEnabled(payload);
  return payload;
}

// --------------------------- Data Access (soft) ------------------------------
async function listAllRules() {
  if (RulesService?.list) return (await RulesService.list()) ?? [];
  if (db?.rules?.toArray) return (await db.rules.toArray()) ?? [];
  return [];
}
async function upsertRule(rule) {
  if (!rule?.id) throw new Error("rule.id required");
  if (RulesService?.upsert) return RulesService.upsert(rule);
  if (db?.rules?.put) return db.rules.put(rule);
  return null;
}
async function removeRule(id) {
  if (!id) return;
  if (RulesService?.remove) return RulesService.remove(id);
  if (db?.rules?.delete) return db.rules.delete(id);
  return null;
}
async function recompileRuleset() {
  try {
    if (AutomationRuntime?.reloadRules) await AutomationRuntime.reloadRules();
  } catch {}
}

// ------------------------------- Component -----------------------------------
export default function KnowledgeRulesPage() {
  const [items, setItems] = useState([]);
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState("all");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState({ kind: "idle", message: "" });
  const fileRef = useRef(null);

  // Load
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const list = await listAllRules();
        if (!alive) return;
        setItems(Array.isArray(list) ? list : []);
      } catch {
        setStatus({
          kind: "warn",
          message: "Could not load rules (degraded mode).",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Facets
  const domains = useMemo(() => {
    const set = new Set(items.map((i) => i.domain).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [items]);
  const categories = useMemo(() => {
    const set = new Set(items.map((i) => i.category).filter(Boolean));
    return ["all", ...Array.from(set).sort()];
  }, [items]);

  // Filtered
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((r) => {
      if (domain !== "all" && r.domain !== domain) return false;
      if (category !== "all" && r.category !== category) return false;
      if (!needle) return true;
      const hay = `${r.id} ${r.name} ${r.domain} ${r.category} ${
        r.notes
      } ${JSON.stringify(r.when)} ${JSON.stringify(r.then)}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [items, q, domain, category]);

  // KPIs
  const kpis = useMemo(() => {
    const total = items.length;
    const enabled = items.filter((i) => i.enabled).length;
    const byDomain = items.reduce((acc, r) => {
      acc[r.domain] = (acc[r.domain] ?? 0) + 1;
      return acc;
    }, {});
    const topDomain = Object.entries(byDomain).sort((a, b) => b[1] - a[1])[0];
    return { total, enabled, topDomain };
  }, [items]);

  // Actions
  const emitRecompile = useCallback(async () => {
    emitEvent("rules.recompiled", "KnowledgeRules", { count: items.length });
    await recompileRuleset();
    setStatus({
      kind: "ok",
      message: "Rules recompiled and runtime notified.",
    });
  }, [items.length]);

  const onToggle = useCallback(
    async (id, nextEnabled) => {
      try {
        const target = items.find((x) => x.id === id);
        if (!target) return;
        const updated = normalizeRule({
          ...target,
          enabled: nextEnabled,
          updatedAt: NOW_ISO(),
        });
        await upsertRule(updated);
        setItems((prev) => prev.map((x) => (x.id === id ? updated : x)));
        emitEvent("rules.updated", "KnowledgeRules", {
          id,
          enabled: nextEnabled,
        });
      } catch {
        setStatus({ kind: "error", message: "Could not update rule." });
      }
    },
    [items]
  );

  const onDelete = useCallback(async (id) => {
    if (!id) return;
    if (!confirm("Delete this rule?")) return;
    try {
      await removeRule(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      emitEvent("rules.deleted", "KnowledgeRules", { id });
    } catch {
      setStatus({ kind: "error", message: "Delete failed." });
    }
  }, []);

  const onClone = useCallback(
    async (id) => {
      const src = items.find((x) => x.id === id);
      if (!src) return;
      const clone = normalizeRule({
        ...src,
        id: `${src.id}-copy-${nanoid(4)}`,
        name: `${src.name} (Copy)`,
        createdAt: NOW_ISO(),
      });
      try {
        await upsertRule(clone);
        setItems((prev) => [clone, ...prev]);
        emitEvent("rules.created", "KnowledgeRules", {
          id: clone.id,
          from: src.id,
        });
      } catch {
        setStatus({ kind: "error", message: "Clone failed." });
      }
    },
    [items]
  );

  const onEdit = useCallback(
    async (id, patch) => {
      const src = items.find((x) => x.id === id);
      if (!src) return;
      const candidate = normalizeRule({ ...src, ...patch });
      const check = validateRule(candidate);
      if (!check.ok) {
        setStatus({
          kind: "error",
          message: `Validation failed: ${check.reason}`,
        });
        return;
      }
      try {
        await upsertRule(candidate);
        setItems((prev) => prev.map((x) => (x.id === id ? candidate : x)));
        emitEvent("rules.updated", "KnowledgeRules", {
          id,
          fieldset: Object.keys(patch),
        });
      } catch {
        setStatus({ kind: "error", message: "Save failed." });
      }
    },
    [items]
  );

  const onNew = useCallback(async () => {
    const draft = normalizeRule({
      id: `rule-${nanoid(6)}`,
      name: "New Rule",
      category: "custom",
      domain: "global",
      enabled: true,
      priority: 50,
      when: {},
      then: {},
      notes: "",
    });
    try {
      await upsertRule(draft);
      setItems((prev) => [draft, ...prev]);
      emitEvent("rules.created", "KnowledgeRules", { id: draft.id });
    } catch {
      setStatus({ kind: "error", message: "Create failed." });
    }
  }, []);

  const onExport = useCallback(() => {
    try {
      const blob = new Blob([JSON.stringify(items, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ssa-rules-${new Date()
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
          const check = validateRule(raw);
          if (!check.ok) {
            console.warn("Skipped invalid rule:", check.reason, raw);
            continue;
          }
          const norm = normalizeRule(raw);
          const exists = items.find((r) => r.id === norm.id);
          await upsertRule(norm);
          if (exists) {
            emitEvent("rules.updated", "KnowledgeRules", { id: norm.id });
            updated++;
          } else {
            emitEvent("rules.created", "KnowledgeRules", { id: norm.id });
            created++;
          }
        }

        const fresh = await listAllRules();
        setItems(Array.isArray(fresh) ? fresh : []);
        setStatus({
          kind: "ok",
          message: `Imported ${
            created + updated
          } rule(s) (${created} created, ${updated} updated).`,
        });
        e.target.value = "";
      } catch {
        setStatus({ kind: "error", message: "Import failed." });
      }
    },
    [items]
  );

  const onProbe = useCallback((rule) => {
    // Non-mutating test: send a probe so engines/devtools can evaluate the predicate
    emitEvent("rules.test.probe", "KnowledgeRules", {
      id: rule.id,
      sample: {
        now: NOW_ISO(),
        weather: { tempF: 70, precipitation: 0 },
        inventory: { FLOUR_AP_5LB: 2 },
        session: { domain: "meals", kind: "batch-cook", servings: 6 },
      },
    });
    setStatus({ kind: "ok", message: `Probe emitted for ${rule.id}.` });
  }, []);

  // ------------------------------- Render -----------------------------------
  return (
    <div className="p-4 md:p-6">
      <header className="mb-5 md:mb-7">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold">
              Rules & Guards
            </h1>
            <p className="text-sm text-neutral-600">
              Configure guardrails and automation policies that govern sessions.
              Changes emit events and can optionally export to the Hub when
              familyFundMode is on.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={onNew}
            >
              New rule
            </button>
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={emitRecompile}
            >
              Recompile rules
            </button>
            <button
              className="rounded-xl border px-3 py-2 text-sm hover:shadow"
              onClick={onExport}
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
        <KpiCard label="Total rules" value={kpis.total} />
        <KpiCard label="Enabled" value={kpis.enabled} />
        <KpiCard
          label="Top domain"
          value={
            kpis.topDomain ? `${kpis.topDomain[0]} ×${kpis.topDomain[1]}` : "—"
          }
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
              placeholder="Find by name, id, notes, when/then JSON…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
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
        </div>
      </section>

      {/* Grid */}
      <section>
        {filtered.length === 0 ? (
          <div className="text-sm text-neutral-600 border rounded-2xl p-6 text-center">
            No rules found. Click “New rule” or import a JSON ruleset.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
            {filtered.map((r) => (
              <RuleCard
                key={r.id}
                rule={r}
                onToggle={onToggle}
                onDelete={onDelete}
                onClone={onClone}
                onEdit={onEdit}
                onProbe={onProbe}
              />
            ))}
          </div>
        )}
      </section>

      {/* Help */}
      <section className="mt-8">
        <details className="rounded-2xl border p-3">
          <summary className="cursor-pointer text-sm font-medium">
            How rules drive SSA
          </summary>
          <ul className="list-disc pl-5 text-sm mt-2 space-y-1">
            <li>
              <strong>Imports →</strong> Context intelligence identifies
              seasonality, equipment, and constraints that feed rule predicates
              (<code>when</code>).
            </li>
            <li>
              <strong>Intelligence →</strong> Rules determine guardrails and
              policies (e.g.,
              <em>quiet hours</em> convert sessions to notifications).
            </li>
            <li>
              <strong>Automation →</strong> The runtime consumes rules to
              schedule/suppress sessions and emits completion/update events
              accordingly.
            </li>
            <li>
              <strong>Hub export (optional) →</strong> Rules changes are
              formatted and sent to the Hub when enabled, so community services
              can align with household preferences.
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

function RuleCard({ rule, onToggle, onDelete, onClone, onEdit, onProbe }) {
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState(rule);

  useEffect(() => setLocal(rule), [rule]);

  const save = useCallback(() => {
    // Persist only changed fields
    const patch = {};
    for (const k of ["name", "domain", "category", "priority", "notes"]) {
      if (local[k] !== rule[k]) patch[k] = local[k];
    }
    if (JSON.stringify(local.when) !== JSON.stringify(rule.when))
      patch.when = local.when;
    if (JSON.stringify(local.then) !== JSON.stringify(rule.then))
      patch.then = local.then;
    if (Object.keys(patch).length === 0) return;
    onEdit?.(rule.id, patch);
  }, [local, onEdit, rule]);

  return (
    <div className="rounded-2xl border p-3 md:p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">{rule.name}</div>
          <div className="text-xs text-neutral-600">
            <span className="mr-2">#{rule.id}</span>
            <span className="px-2 py-0.5 border rounded-full">
              {rule.category}
            </span>
            <span className="ml-2 px-2 py-0.5 border rounded-full">
              {rule.domain}
            </span>
            <span className="ml-2 text-neutral-500">
              • priority {rule.priority}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            className={`text-xs rounded-lg border px-2 py-1 hover:shadow ${
              rule.enabled ? "bg-green-50 border-green-300" : ""
            }`}
            onClick={() => onToggle?.(rule.id, !rule.enabled)}
            title="Enable/disable"
          >
            {rule.enabled ? "Enabled" : "Disabled"}
          </button>
          <button
            className="text-xs rounded-lg border px-2 py-1 hover:shadow"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "Edit"}
          </button>
          <button
            className="text-xs rounded-lg border px-2 py-1 hover:shadow"
            onClick={() => onClone?.(rule.id)}
          >
            Clone
          </button>
          <button
            className="text-xs rounded-lg border px-2 py-1 hover:shadow"
            onClick={() => onProbe?.(rule)}
          >
            Probe
          </button>
          <button
            className="text-xs rounded-lg border px-2 py-1 hover:shadow text-rose-700"
            onClick={() => onDelete?.(rule.id)}
            title="Delete rule"
          >
            Delete
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <LabeledInput
              className="md:col-span-6"
              label="Name"
              value={local.name}
              onChange={(v) => setLocal((s) => ({ ...s, name: v }))}
            />
            <LabeledInput
              className="md:col-span-3"
              label="Domain"
              value={local.domain}
              onChange={(v) => setLocal((s) => ({ ...s, domain: v }))}
            />
            <LabeledInput
              className="md:col-span-3"
              label="Category"
              value={local.category}
              onChange={(v) => setLocal((s) => ({ ...s, category: v }))}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
            <LabeledInput
              className="md:col-span-3"
              label="Priority"
              type="number"
              value={local.priority}
              onChange={(v) =>
                setLocal((s) => ({
                  ...s,
                  priority: Number.isFinite(+v) ? +v : s.priority,
                }))
              }
            />
            <LabeledInput
              className="md:col-span-9"
              label="Notes"
              value={local.notes}
              onChange={(v) => setLocal((s) => ({ ...s, notes: v }))}
            />
          </div>

          <LabeledJSON
            label="When (predicate config)"
            value={local.when}
            onChange={(obj) => setLocal((s) => ({ ...s, when: obj }))}
          />
          <LabeledJSON
            label="Then (action config)"
            value={local.then}
            onChange={(obj) => setLocal((s) => ({ ...s, then: obj }))}
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
              {rule.updatedAt ? new Date(rule.updatedAt).toLocaleString() : "—"}
            </span>
          </div>
        </div>
      )}
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
        placeholder='e.g. {"time":{"dow":[6],"from":"18:00","to":"19:59"}}'
      />
    </div>
  );
}

function stableStringify(obj) {
  try {
    return JSON.stringify(obj ?? {}, Object.keys(obj ?? {}).sort(), 2);
  } catch {
    return "{}";
  }
}
